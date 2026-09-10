/**
 * TelegramPoller — ulazni kanal: poruka → `POST /api/ingest` (DIZAJN-telegram-poller).
 *
 * KLJUČNA ODLUKA: poller NEMA nimalo pameti. Paket već ima kanal-agnostičan ulaz koji radi
 * ocjenu težine, pragove A/B/C, izbor projekta i položaj po izvoru — sve deterministički.
 * Poller je zato PREVODITELJ PROTOKOLA, ne vratar:
 *
 *   getUpdates → poller → POST /api/ingest → zadatak
 *                  ▲
 *                  └── ovdje nema klasifikacije, nema odluke, nema baze
 *
 * Ako pollleru ikad zatreba `if` o tome je li poruka vrijedna zadatka, ta odluka pripada
 * `IngestConfig`-u, ne ovdje.
 *
 * TRI STVARI KOJE MORAJU BITI TOČNE (§5 dizajna, sve tri poznate iz pogona):
 *   5.1 `offset` se pomiče PRIJE obrade — inače pad usred obrade otvara isti zadatak dvaput;
 *   5.2 jedna petlja, ne dvije — dva pollera s istim tokenom si međusobno kradu poruke,
 *       pa je datoteka-brava s PID-om uvjet, ne dodatak;
 *   5.3 `429` čeka točno `retry_after`, a `409` i `401` ZAUSTAVLJAJU petlju — trajno stanje
 *       se ne liječi ponavljanjem.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { osigurajMapu, stanjePutanja } from './core/paths'
import { loadTelegramConfig, posaljiTelegramPoruku, type TelegramPostavke } from './TelegramConfig'

export const STANJE_PUTANJA = stanjePutanja('telegram-poller.json')
export const BRAVA_PUTANJA = stanjePutanja('telegram-poller.lock')

// ─── Stanje (ono što stroj zatekne — NIKAD u konfiguraciju) ──────────────────

export interface StanjePollera {
  offset: number
  obradeno: number
  preskoceno: number
  zadnjaGreska: string | null
  zadnjaGreskaTs: string | null
  zaustavljen: boolean
  zaustavljenRazlog: string | null
  ts: string | null
  /** Ne prije ovog trenutka (`429 retry_after` ili backoff). */
  cekajDo: number
}

export const ZADANO_STANJE: StanjePollera = {
  offset: 0, obradeno: 0, preskoceno: 0,
  zadnjaGreska: null, zadnjaGreskaTs: null,
  zaustavljen: false, zaustavljenRazlog: null, ts: null, cekajDo: 0,
}

export function ucitajStanje(path: string = STANJE_PUTANJA): StanjePollera {
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8'))
    return { ...ZADANO_STANJE, ...(s && typeof s === 'object' ? s : {}) }
  } catch {
    return { ...ZADANO_STANJE }
  }
}

export function zapisiStanje(stanje: StanjePollera, path: string = STANJE_PUTANJA): void {
  try {
    osigurajMapu(path)
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify({ ...stanje, ts: new Date().toISOString() }, null, 2) + '\n', 'utf-8')
    renameSync(tmp, path)
  } catch { /* stanje nije vrijedno rušenja petlje */ }
}

// ─── Brava (§5.2) ────────────────────────────────────────────────────────────

export interface Brava { ok: boolean; razlog?: string; osloboditi?: () => void }

/**
 * Datoteka-brava s PID-om. Ako je vlasnik živ, drugi poller se NE pokreće i to jasno kaže —
 * inače način „u procesu ploče" i način „zaseban proces" krenu zajedno, a kvar je nevidljiv
 * (Telegram svaki update isporučuje samo jednom pozivatelju, pa se poruke tiho gube).
 */
export function uzmiBravu(path: string = BRAVA_PUTANJA): Brava {
  try {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf-8').trim())
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        let ziv = false
        try { process.kill(pid, 0); ziv = true } catch (e: any) { ziv = e?.code === 'EPERM' }
        if (ziv) {
          return { ok: false, razlog: `poller već radi u procesu ${pid} (${path})` }
        }
      }
    }
    osigurajMapu(path)
    writeFileSync(path, String(process.pid), 'utf-8')
    return {
      ok: true,
      osloboditi: () => { try { unlinkSync(path) } catch { /* već je maknuta */ } },
    }
  } catch (e: any) {
    return { ok: false, razlog: `brava se ne može uzeti: ${String(e?.message || e)}` }
  }
}

// ─── Telegram tipovi (samo ono što doista koristimo) ─────────────────────────

export interface Update {
  update_id: number
  message?: {
    message_id: number
    date?: number
    text?: string
    caption?: string
    chat: { id: number | string; title?: string; username?: string; type?: string }
    from?: { id: number | string; first_name?: string; username?: string; is_bot?: boolean }
    entities?: { type: string }[]
  }
}

export interface Api {
  /** `getUpdates` — vraća sirovi odgovor Telegrama (ili grešku s HTTP kodom). */
  getUpdates(offset: number, timeoutSek: number): Promise<{
    ok: boolean; status?: number; result?: Update[]; description?: string; retryAfter?: number
  }>
  /** `POST /api/ingest` na ploču. */
  ingest(tijelo: Record<string, unknown>): Promise<{ status: number; tijelo: any }>
  /** Poruka natrag u chat (potvrda). */
  odgovori(chatId: string | number, tekst: string, replyTo?: number): Promise<boolean>
}

export interface Ishod {
  dohvaceno: number
  poslano: number
  preskoceno: number
  potvrde: number
  greske: string[]
  zaustavljen: boolean
  cekajMs: number
}

// ─── Jedan prolaz ────────────────────────────────────────────────────────────

/**
 * Čista funkcija nad ulaznim podatcima: mreža i ploča su UBRIZGANE (`api`), pa je cijeli
 * prolaz testabilan bez ijednog mrežnog poziva.
 */
export async function jedanProlaz(
  cfg: TelegramPostavke, stanje: StanjePollera, api: Api,
): Promise<Ishod> {
  const u = cfg.ulaz
  const ishod: Ishod = {
    dohvaceno: 0, poslano: 0, preskoceno: 0, potvrde: 0,
    greske: [], zaustavljen: stanje.zaustavljen, cekajMs: 0,
  }
  if (stanje.zaustavljen) {
    ishod.greske.push(stanje.zaustavljenRazlog || 'petlja je zaustavljena')
    return ishod
  }

  const odg = await api.getUpdates(stanje.offset, u.timeoutSek)

  if (!odg.ok) {
    if (odg.status === 429) {
      const cekaj = (odg.retryAfter ?? 5) * 1000
      stanje.cekajDo = Date.now() + cekaj
      ishod.cekajMs = cekaj
      ishod.greske.push(`Telegram traži čekanje ${Math.round(cekaj / 1000)} s (429)`)
      return ishod
    }
    if (odg.status === 409) {
      stanje.zaustavljen = true
      stanje.zaustavljenRazlog = 'za ovog bota postavljen je webhook — makni ga ili isključi poller'
      ishod.zaustavljen = true
      ishod.greske.push(stanje.zaustavljenRazlog)
      return ishod
    }
    if (odg.status === 401) {
      stanje.zaustavljen = true
      stanje.zaustavljenRazlog = 'bot token nije valjan'
      ishod.zaustavljen = true
      ishod.greske.push(stanje.zaustavljenRazlog)
      return ishod
    }
    stanje.zadnjaGreska = odg.description || `HTTP ${odg.status ?? '—'}`
    stanje.zadnjaGreskaTs = new Date().toISOString()
    ishod.greske.push(stanje.zadnjaGreska)
    return ishod
  }

  for (const up of odg.result || []) {
    ishod.dohvaceno++
    // 5.1 — offset PRVO. Izgubljena poruka u rijetkom padu manja je šteta od tihe
    // duplikacije zadataka.
    stanje.offset = up.update_id + 1

    const m = up.message
    if (!m) { ishod.preskoceno++; continue }

    const tekstSirovi = m.text ?? m.caption ?? ''
    if (!tekstSirovi.trim()) { ishod.preskoceno++; continue }

    if (!propusti(u, m, tekstSirovi)) { ishod.preskoceno++; stanje.preskoceno++; continue }

    const tekst = tekstSirovi.length > u.maxDuljina ? tekstSirovi.slice(0, u.maxDuljina) : tekstSirovi
    const tijelo = preslikaj(m, tekst)

    try {
      const { status, tijelo: odgovor } = await api.ingest(tijelo)
      if (status === 201 && odgovor?.taskId) {
        stanje.obradeno++
        ishod.poslano++
        if (u.potvrdaUChat) {
          const poslano = await api.odgovori(m.chat.id, `📋 Otvoren zadatak ${odgovor.taskId}`, m.message_id)
          if (poslano) ishod.potvrde++
        }
      } else if (status === 200) {
        // Ulaz je odlučio da ovo nije zadatak (sjena, ispod praga, isključeno) → TIŠINA.
        // Bot koji komentira svaku poruku brzo postane šum koji se isključi.
        stanje.obradeno++
        ishod.preskoceno++
      } else {
        const razlog = odgovor?.error || odgovor?.greske?.join?.('; ') || `HTTP ${status}`
        stanje.zadnjaGreska = razlog
        stanje.zadnjaGreskaTs = new Date().toISOString()
        ishod.greske.push(`ingest ${status}: ${razlog}`)
      }
    } catch (e: any) {
      ishod.greske.push(`ploča nije dostupna: ${String(e?.message || e)}`)
    }
  }
  return ishod
}

/** Filtri: dopušteni chatovi, dopušteni korisnici, okidač, spomen bota. */
export function propusti(
  u: TelegramPostavke['ulaz'], m: NonNullable<Update['message']>, tekst: string,
): boolean {
  if (u.dopusteniChatovi.length && !u.dopusteniChatovi.includes(String(m.chat.id))) return false
  if (u.dopusteniKorisnici.length && !u.dopusteniKorisnici.includes(String(m.from?.id ?? ''))) return false
  if (u.okidac && !tekst.trim().startsWith(u.okidac)) return false
  if (u.sameSpomeni && !(m.entities || []).some(e => e.type === 'mention')) return false
  return true
}

/**
 * Telegram → `/api/ingest`. Namjerno se NE šalju `projectId`, `assignee` ni `tags`:
 * o projektu odlučuje `IngestConfig.projektZaIzvor()` po ključu izvora. Slanje projekta
 * odavde zaobišlo bi tu odluku i napravilo drugu istinu o tome čemu poruka pripada.
 */
export function preslikaj(m: NonNullable<Update['message']>, tekst: string): Record<string, unknown> {
  const ime = [m.from?.first_name, m.from?.username ? `(@${m.from.username})` : '']
    .filter(Boolean).join(' ').trim()
  return {
    source: 'telegram',
    externalId: `${m.chat.id}:${m.message_id}`,
    replyTo: String(m.chat.id),
    text: tekst,
    senderName: ime || undefined,
    receivedAt: m.date ? new Date(m.date * 1000).toISOString() : undefined,
  }
}

// ─── Stvarni API ─────────────────────────────────────────────────────────────

export function telegramApi(botToken: string, plocaBase: string): Api {
  const base = `https://api.telegram.org/bot${botToken}`
  const ploca = plocaBase.replace(/\/+$/, '')
  return {
    async getUpdates(offset, timeoutSek) {
      try {
        const url = `${base}/getUpdates?offset=${offset}&timeout=${timeoutSek}` +
          `&allowed_updates=${encodeURIComponent('["message"]')}`
        const r = await fetch(url)
        const j: any = await r.json().catch(() => ({}))
        if (!r.ok || j?.ok === false) {
          return {
            ok: false, status: r.status, description: j?.description,
            retryAfter: j?.parameters?.retry_after,
          }
        }
        return { ok: true, result: j.result || [] }
      } catch (e: any) {
        return { ok: false, description: String(e?.message || e) }
      }
    },
    async ingest(tijelo) {
      const r = await fetch(`${ploca}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tijelo),
      })
      const t = await r.text()
      let parsed: any = null
      try { parsed = t ? JSON.parse(t) : null } catch { parsed = { raw: t } }
      return { status: r.status, tijelo: parsed }
    },
    async odgovori(chatId, tekst, replyTo) {
      try {
        const r = await fetch(`${base}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId, text: tekst,
            ...(replyTo ? { reply_to_message_id: replyTo } : {}),
          }),
        })
        return r.ok
      } catch {
        return false
      }
    },
  }
}

// ─── Petlja ──────────────────────────────────────────────────────────────────

export interface PokretanjeOpcije {
  plocaBase?: string
  configPath?: string
  stanjePath?: string
  bravaPath?: string
  api?: Api
  log?: (r: string) => void
}

export interface Pokretanje {
  pokrenut: boolean
  razlog?: string
  stop?: () => void
}

/**
 * Pokreni ulaznu petlju. Bez bot tokena ili s isključenim ulazom NE pokreće se i to NIJE
 * greška — svježa instalacija je normalno stanje, pa u dnevniku nema alarma.
 */
export function pokreniTelegramPoller(opcije: PokretanjeOpcije = {}): Pokretanje {
  const log = opcije.log || ((r: string) => console.log(r))
  const cfg = loadTelegramConfig(opcije.configPath)

  if (!cfg.ulaz?.ukljucen) return { pokrenut: false, razlog: 'ulazni kanal je isključen' }
  if (!cfg.botToken) return { pokrenut: false, razlog: 'bot token nije postavljen' }

  const brava = uzmiBravu(opcije.bravaPath)
  if (!brava.ok) {
    log(`[telegram-poller] ne pokrećem se: ${brava.razlog}`)
    return { pokrenut: false, razlog: brava.razlog }
  }

  const stanjePath = opcije.stanjePath || STANJE_PUTANJA
  const ploca = opcije.plocaBase || process.env.TM_API_BASE || 'http://localhost:17781'
  const api = opcije.api || telegramApi(cfg.botToken, ploca)
  let radi = true
  let tajmer: ReturnType<typeof setTimeout> | null = null
  let uzastopnihKvarova = 0

  const korak = async () => {
    if (!radi) return
    const svjez = loadTelegramConfig(opcije.configPath)
    const stanje = ucitajStanje(stanjePath)
    let cekaj = Math.max(1, svjez.ulaz.intervalSek) * 1000

    if (!svjez.ulaz.ukljucen) {
      log('[telegram-poller] ulaz je isključen s ploče — zaustavljam petlju')
      zaustavi()
      return
    }
    if (stanje.cekajDo > Date.now()) {
      cekaj = stanje.cekajDo - Date.now()
    } else {
      const ishod = await jedanProlaz(svjez, stanje, api)
      zapisiStanje(stanje, stanjePath)
      if (ishod.zaustavljen) {
        log(`[telegram-poller] zaustavljen: ${stanje.zaustavljenRazlog}`)
        zaustavi()
        return
      }
      if (ishod.greske.length) {
        uzastopnihKvarova++
        // Eksponencijalni backoff s jitterom: bez jittera dvije instalacije iza istog
        // izlaza udare u ograničenje u istoj sekundi.
        const osnova = Math.min(300_000, 3000 * Math.pow(2, uzastopnihKvarova - 1))
        cekaj = Math.round(osnova * (0.5 + Math.random() * 0.5))
        log(`[telegram-poller] ${ishod.greske[0]} — sljedeći pokušaj za ${Math.round(cekaj / 1000)} s`)
      } else {
        uzastopnihKvarova = 0
        if (ishod.poslano) log(`[telegram-poller] otvoreno zadataka: ${ishod.poslano}`)
      }
      if (ishod.cekajMs) cekaj = ishod.cekajMs
    }

    if (!radi) return
    tajmer = setTimeout(korak, cekaj)
    if (typeof (tajmer as any)?.unref === 'function') (tajmer as any).unref()
  }

  const zaustavi = () => {
    radi = false
    if (tajmer) { clearTimeout(tajmer); tajmer = null }
    brava.osloboditi?.()
  }

  log(`[telegram-poller] pokrenut (interval ${cfg.ulaz.intervalSek} s, ploča ${ploca})`)
  void korak()
  return { pokrenut: true, stop: zaustavi }
}

// ─── Proba ulaza (ploča) ─────────────────────────────────────────────────────

/**
 * Jedan `getUpdates` s `timeout=0` — koliko poruka čeka i iz kojih chatova, BEZ otvaranja
 * ijednog zadatka. Bez ovoga korisnik ne može doznati `chat.id` svoje grupe, a to je prvi
 * podatak koji mu treba za `dopusteniChatovi`.
 */
export async function probajUlaz(configPath?: string, api?: Api): Promise<{
  ok: boolean
  greska?: string
  cekaPoruka?: number
  chatovi?: { id: string; naziv: string; zadnjaPoruka: string }[]
}> {
  const cfg = loadTelegramConfig(configPath)
  if (!cfg.botToken) return { ok: false, greska: 'bot token nije postavljen' }
  const stanje = ucitajStanje()
  const klijent = api || telegramApi(cfg.botToken, process.env.TM_API_BASE || 'http://localhost:17781')
  const odg = await klijent.getUpdates(stanje.offset, 0)
  if (!odg.ok) {
    if (odg.status === 409) return { ok: false, greska: 'za ovog bota postavljen je webhook — makni ga prije uporabe pollera' }
    if (odg.status === 401) return { ok: false, greska: 'bot token nije valjan' }
    return { ok: false, greska: odg.description || `HTTP ${odg.status ?? '—'}` }
  }
  const po = new Map<string, { id: string; naziv: string; zadnjaPoruka: string }>()
  for (const up of odg.result || []) {
    const m = up.message
    if (!m) continue
    po.set(String(m.chat.id), {
      id: String(m.chat.id),
      naziv: m.chat.title || m.chat.username || m.chat.type || '(privatni razgovor)',
      zadnjaPoruka: (m.text ?? m.caption ?? '').slice(0, 80),
    })
  }
  return { ok: true, cekaPoruka: (odg.result || []).length, chatovi: [...po.values()] }
}

/** Stanje ulazne petlje za ploču. */
export function stanjeUlaza(stanjePath?: string): StanjePollera & { radi: boolean } {
  const s = ucitajStanje(stanjePath)
  let radi = false
  try {
    if (existsSync(BRAVA_PUTANJA)) {
      const pid = Number(readFileSync(BRAVA_PUTANJA, 'utf-8').trim())
      try { process.kill(pid, 0); radi = true } catch (e: any) { radi = e?.code === 'EPERM' }
    }
  } catch { /* brave nema */ }
  return { ...s, radi: radi && !s.zaustavljen }
}
