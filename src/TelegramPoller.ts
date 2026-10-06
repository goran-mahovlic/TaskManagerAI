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
import {
  loadTelegramConfig, posaljiTelegramPoruku, telegramBotToken, type TelegramPostavke,
} from './TelegramConfig'
import type { Kanal, Razgovor, UlaznaPoruka } from './razgovor/Kanal'
import type { RazgovorPostavke } from './razgovor/RazgovorPostavke'
import { jeDopusten, jeZaDrugog, pocinjeImenom } from './razgovor/Filtar'
import {
  ZADANI_PRIVITCI, arhivirajPoslano, dopustenoPreuzeti, imaPrivitak, neutralizirajOznakuPrivitka, odaberiPrivitak, spremiPrivitak, telegramPreuzmi,
  type PorukaSPrivitkom, type Preuzeto, type TelegramPrivitci,
} from './TelegramPrivitci'

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

export interface Entitet { type: string; offset?: number; length?: number; user?: { id: number | string } }

export interface Update {
  update_id: number
  message?: {
    message_id: number
    date?: number
    text?: string
    caption?: string
    chat: { id: number | string; title?: string; username?: string; type?: string }
    from?: { id: number | string; first_name?: string; username?: string; is_bot?: boolean }
    entities?: Entitet[]
    caption_entities?: Entitet[]
    reply_to_message?: {
      message_id?: number
      from?: { id: number | string; is_bot?: boolean; username?: string; first_name?: string }
    }
    /** Forum (teme): svaka poruka teme ima `reply_to_message` = početna poruka teme. */
    is_topic_message?: boolean
    message_thread_id?: number
  } & Omit<PorukaSPrivitkom, 'message_id' | 'date'>
}

/** Ovaj bot (`getMe`) — za vlastiti spomen i odgovor na njegovu poruku (ADR-0002 §5). */
export interface JaBot { id: number | string; username?: string; firstName?: string }

/**
 * Razgovorni sloj koji poller hrani (ADR-0002 §10). Poller ne zna ništa o razgovoru osim
 * da mu preda poruku koja nije postala zadatak — o odgovoru odlučuje sloj, ne poller.
 */
export interface RazgovorUlaza {
  razgovor: Razgovor
  postavke: () => RazgovorPostavke
  /** Ako nedostaje, petlja ga dohvati `getMe` pri pokretanju. */
  ja?: JaBot | null
  /** Ako nedostaje, petlja složi Telegram kanal iz bot tokena. */
  kanal?: Kanal
  /** Zadnji pošiljatelji u dopuštenim chatovima (ime, @username, ID) za Config (TASK-5283). */
  zabiljezi?: (p: UlaznaPoruka) => void
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
  /** `getMe` — tko je ovaj bot (za razgovor; nije obavezno). */
  getMe?(): Promise<JaBot | null>
  /** `getFile` + preuzimanje privitka (TASK-5282). Bez njega se privitci ne spremaju. */
  preuzmi?(fileId: string, maxBajta: number): Promise<Preuzeto>
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
  cfg: TelegramPostavke, stanje: StanjePollera, api: Api, razg?: RazgovorUlaza,
): Promise<Ishod> {
  const u = cfg.ulaz
  const rp = razg ? razg.postavke() : null
  const razgovorUkljucen = !!(razg && rp?.ukljucen && razg.kanal)
  const ja = razg?.ja || null
  const ulazna = (m: NonNullable<Update['message']>, tekst: string) =>
    ulaznaPorukaIzTelegrama(m, tekst, ja, rp?.ime || ja?.firstName || '')
  /** ADR-0002: poruka koja NIJE postala zadatak ide razgovornom sloju — bez `await`. */
  const uRazgovor = (m: NonNullable<Update['message']>, tekst: string, gotova?: UlaznaPoruka) => {
    if (!razgovorUkljucen) return
    try {
      const p = gotova || ulazna(m, tekst)
      // Bez popisa dopuštenih chatova bota može dohvatiti svatko (korisničko ime bota je javno,
      // privatni chat je uvijek „obraćanje") — razgovor tada sluša samo dopuštene korisnike (TASK-5279).
      if (!u.dopusteniChatovi.length && !jeDopusten(p, rp!.dopusteniKorisnici)) return
      razg!.razgovor.primi(p, razg!.kanal!)
    } catch (e: any) {
      ishod.greske.push(`razgovor: ${String(e?.message || e)}`)
    }
  }
  const ishod: Ishod = {
    dohvaceno: 0, poslano: 0, preskoceno: 0, potvrde: 0,
    greske: [], zaustavljen: stanje.zaustavljen, cekajMs: 0,
  }
  const priv = { ...ZADANI_PRIVITCI, ...(cfg.privitci || {}) }
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
    // TASK-5282: uz uključene privitke poruka SAMO sa slikom/dokumentom/glasom nije prazna.
    const sPrivitkom = imaPrivitak(m, priv)
    if (!tekstSirovi.trim() && !sPrivitkom) { ishod.preskoceno++; continue }

    let tekst = tekstSirovi.length > u.maxDuljina ? tekstSirovi.slice(0, u.maxDuljina) : tekstSirovi
    if (priv.ukljucen) tekst = neutralizirajOznakuPrivitka(tekst)

    // Dopušteni chatovi vrijede za OBA sloja; ostali filtri ulaza (okidač, spomen,
    // korisnici) odlučuju samo o ingestu — razgovor ima vlastiti filtar (ADR-0002 §5).
    if (u.dopusteniChatovi.length && !u.dopusteniChatovi.includes(String(m.chat.id))) {
      ishod.preskoceno++; stanje.preskoceno++; continue
    }
    // Privitak se sprema samo od dopuštenih (v. `dopustenoPreuzeti`); putanja (ili razlog
    // zašto nije spremljen) ide dalje u tekstu — ulaz i razgovor je vide jednako.
    if (sPrivitkom && api.preuzmi && dopustenoPreuzeti(m, u, rp)) {
      const r = await spremiPrivitak(m, odaberiPrivitak(m, priv.vrste)!, priv, api.preuzmi.bind(api), telegramBotToken(cfg))
      const oznaka = r.ok ? `[PRIVITAK: ${r.putanja}]` : `[PRIVITAK nije spremljen: ${r.razlog}]`
      tekst = tekst.trim() ? `${tekst}\n${oznaka}` : oznaka
    }
    if (!tekst.trim()) { ishod.preskoceno++; stanje.preskoceno++; continue }
    const ul = razg ? ulazna(m, tekst) : undefined
    if (ul && razg?.zabiljezi) { try { razg.zabiljezi(ul) } catch { /* samo pomoć vlasniku */ } }
    // TASK-5283: poruka upućena drugome (drugi bot s popisa ili, uz tisinaKadDrugom, čovjek)
    // ne otvara zadatak ni kad je ulaz uključen — razgovor je samo čita.
    if (ul && rp && jeZaDrugog(ul, rp)) {
      ishod.preskoceno++; stanje.preskoceno++
      uRazgovor(m, tekst, ul)
      continue
    }
    if (!u.ukljucen || !propusti(u, m, tekstSirovi, ja?.username)) {
      ishod.preskoceno++; stanje.preskoceno++
      uRazgovor(m, tekst, ul)
      continue
    }
    const tijelo = preslikaj(m, tekst)

    try {
      const { status, tijelo: odgovor } = await api.ingest(tijelo)
      if (status === 201 && odgovor?.taskId) {
        stanje.obradeno++
        ishod.poslano++
        if (u.potvrdaUChat) {
          const poslano = await api.odgovori(m.chat.id, `📋 Otvoren zadatak ${odgovor.taskId}${odgovor.assignee ? ` → ${odgovor.assignee}` : ''}`, m.message_id)
          if (poslano) ishod.potvrde++
        }
      } else if (status === 200) {
        // Ulaz je odlučio da ovo nije zadatak (sjena, ispod praga, isključeno) → TIŠINA,
        // osim ako je uključen razgovorni način (ADR-0002) — tada o odgovoru odlučuje on.
        stanje.obradeno++
        ishod.preskoceno++
        uRazgovor(m, tekst, ul)
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

/**
 * Filtri: dopušteni chatovi, dopušteni korisnici, okidač, spomen bota.
 *
 * `jaUsername` (ADR-0002 §5, nalaz): bez njega `sameSpomeni` prihvaća BILO KOJI spomen, pa
 * u grupi s dva bota poruka upućena drugome prolazi i ovaj filtar. Kad je korisničko ime
 * ovog bota poznato, broji se samo vlastiti spomen.
 */
export function propusti(
  u: TelegramPostavke['ulaz'], m: NonNullable<Update['message']>, tekst: string, jaUsername?: string,
): boolean {
  if (u.dopusteniChatovi.length && !u.dopusteniChatovi.includes(String(m.chat.id))) return false
  if (u.dopusteniKorisnici.length && !u.dopusteniKorisnici.includes(String(m.from?.id ?? ''))) return false
  if (u.okidac && !tekst.trim().startsWith(u.okidac)) return false
  if (u.sameSpomeni) {
    if (jaUsername) { if (!spominjeBota(m, tekst, jaUsername)) return false }
    else if (!(m.entities || []).some(e => e.type === 'mention')) return false
  }
  return true
}

/**
 * Tuđi spomeni u poruci (TASK-5283): `@ime` iz entiteta `mention` i iz samog teksta (malim
 * slovima, bez `@`), `text_mention` (korisnik bez imena) kao `id:<n>`. Vlastiti spomen se izostavlja.
 */
export function tudjiSpomeni(m: NonNullable<Update['message']>, tekst: string, ja: JaBot | null): string[] {
  const vlastiti = (ja?.username || '').toLowerCase()
  const out = new Set<string>()
  for (const e of [...(m.entities || []), ...(m.caption_entities || [])]) {
    if (e.type === 'text_mention' && e.user?.id !== undefined) {
      if (!ja || String(e.user.id) !== String(ja.id)) out.add(`id:${e.user.id}`)
    } else if (e.type === 'mention' && typeof e.offset === 'number' && typeof e.length === 'number') {
      out.add(tekst.slice(e.offset + 1, e.offset + e.length).toLowerCase())
    }
  }
  for (const x of tekst.matchAll(/(?:^|[^\w@])@(\w{3,64})/g)) out.add(x[1]!.toLowerCase())
  out.delete(vlastiti)
  out.delete('')
  return [...out]
}

/** Sadrži li poruka spomen `@jaUsername` (entitet `mention` ili, bez entiteta, sam tekst). */
export function spominjeBota(m: NonNullable<Update['message']>, tekst: string, jaUsername: string): boolean {
  const cilj = `@${jaUsername}`.toLowerCase()
  const ent = [...(m.entities || []), ...(m.caption_entities || [])].filter(e => e.type === 'mention')
  if (ent.some(e => typeof e.offset === 'number' && typeof e.length === 'number' &&
    tekst.slice(e.offset, e.offset + e.length).toLowerCase() === cilj)) return true
  return new RegExp(`(^|[^\\w@])${cilj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(tekst)
}

/**
 * Telegram → `UlaznaPoruka` (ADR-0002 §10). Ovdje i samo ovdje se odlučuje je li poruka
 * upućena OVOM botu: vlastiti @spomen, ime bota na početku ili odgovor na njegovu poruku.
 */
export function ulaznaPorukaIzTelegrama(
  m: NonNullable<Update['message']>, tekst: string, ja: JaBot | null, ime: string,
): UlaznaPoruka {
  const posiljateljIme = [m.from?.first_name, m.from?.username ? `(@${m.from.username})` : '']
    .filter(Boolean).join(' ').trim() || String(m.from?.id ?? '?')
  const odgovorNaBota = !!ja && m.reply_to_message?.from?.id !== undefined &&
    String(m.reply_to_message.from.id) === String(ja.id)
  const spomen = !!ja?.username && spominjeBota(m, tekst, ja.username)
  const spomeni = tudjiSpomeni(m, tekst, ja)
  const r = m.reply_to_message
  const pocetakTeme = m.is_topic_message === true && r?.message_id !== undefined && r.message_id === m.message_thread_id
  const odgovorNa = r?.from?.id !== undefined && !odgovorNaBota && !pocetakTeme
    ? {
      id: String(r.from.id),
      ...(r.from.username ? { korisnickoIme: r.from.username.toLowerCase() } : {}),
      ...(r.from.first_name ? { ime: r.from.first_name } : {}),
      jeBot: r.from.is_bot === true,
    }
    : undefined
  return {
    kanal: 'telegram',
    chatId: String(m.chat.id),
    porukaId: String(m.message_id),
    posiljateljId: String(m.from?.id ?? ''),
    posiljateljIme,
    ...(m.from?.username ? { posiljateljKorisnickoIme: m.from.username } : {}),
    posiljateljJeBot: m.from?.is_bot === true,
    tekst,
    ts: m.date ? new Date(m.date * 1000).toISOString() : new Date().toISOString(),
    privatno: m.chat.type === 'private',
    obracanjeBotu: spomen || odgovorNaBota || pocinjeImenom(tekst, ime),
    ...(spomeni.length ? { spomeni } : {}),
    ...(odgovorNa ? { odgovorNa } : {}),
  }
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
    preuzmi: telegramPreuzmi(botToken),
    async getMe() {
      try {
        const r = await fetch(`${base}/getMe`)
        const j: any = await r.json().catch(() => ({}))
        if (!r.ok || !j?.ok || !j.result) return null
        return { id: j.result.id, username: j.result.username, firstName: j.result.first_name }
      } catch {
        return null
      }
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

// ─── Kanal za razgovor (ADR-0002 §10) ────────────────────────────────────────

/**
 * Telegram kao `Kanal` razgovornog sloja. Token ostaje ovdje — razgovorna jezgra i model
 * ga nikad ne vide.
 *
 * `privitci` (TASK-5282, uputa #187): uz uključene privitke poslani dokument se kopira u mapu
 * chata i evidentira kao `poslano` — oba smjera na jednom mjestu.
 */
export function telegramKanal(
  botToken: string, privitci?: () => TelegramPrivitci, ja?: () => JaBot | null,
): Kanal {
  const base = `https://api.telegram.org/bot${botToken}`
  const posalji = async (metoda: string, tijelo: Record<string, unknown>) => {
    try {
      const r = await fetch(`${base}/${metoda}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo),
      })
      return r.ok
    } catch { return false }
  }
  return {
    ime: 'telegram',
    maxDuljinaPoruke: 4096,
    maxDokumentBajta: 50 * 1024 * 1024,
    async posaljiTekst(chatId, tekst, replyTo) {
      const ok = await posalji('sendMessage', {
        chat_id: chatId, text: tekst,
        ...(replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {}),
      })
      // Poruka na koju se odgovara mogla je nestati — tada bez reply-a, ne bez odgovora.
      return ok || (replyTo ? posalji('sendMessage', { chat_id: chatId, text: tekst }) : false)
    },
    async posaljiDokument(chatId, putanja, opis) {
      try {
        const fd = new FormData()
        fd.append('chat_id', chatId)
        if (opis) fd.append('caption', opis.slice(0, 1024))
        const f = Bun.file(putanja)
        fd.append('document', f, putanja.split('/').pop() || 'dokument')
        const r = await fetch(`${base}/sendDocument`, { method: 'POST', body: fd })
        if (r.ok && privitci) {
          try {
            const p = privitci()
            if (p.ukljucen) {
              const j: any = await r.json().catch(() => ({}))
              arhivirajPoslano(p, String(chatId), putanja, Number(j?.result?.message_id) || 0, ja?.() || null)
            }
          } catch { /* arhiv nije vrijedan neuspjeha slanja */ }
        }
        return r.ok
      } catch { return false }
    },
    async pise(chatId) {
      await posalji('sendChatAction', { chat_id: chatId, action: 'typing' })
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
  /** Razgovorni način (ADR-0002). Bez njega poller radi točno kao prije. */
  razgovor?: RazgovorUlaza
}

/** Petlja treba raditi ako je uključen ulaz ILI razgovor (ADR-0002 §3). */
function trebaPetlja(cfg: TelegramPostavke, razg?: RazgovorUlaza): boolean {
  if (cfg.ulaz?.ukljucen) return true
  try { return !!razg?.postavke().ukljucen } catch { return false }
}

export interface Pokretanje {
  pokrenut: boolean
  razlog?: string
  stop?: () => void
  /** Vrti li se petlja još (sama se gasi kad se ulaz isključi, na 401/409 i na `stop`). */
  ziv?: () => boolean
}

/**
 * Petlja ovog procesa (TASK-5274). Datoteka-brava prima vlastiti PID — tako ploča nakon
 * pada preuzme bravu — pa NE štiti od druge petlje u istom procesu. To čini ova varijabla.
 */
let aktivna: { ziv: () => boolean; stop: () => void; token: string } | null = null

/**
 * Pokreni ulaznu petlju. Bez bot tokena ili s isključenim ulazom NE pokreće se i to NIJE
 * greška — svježa instalacija je normalno stanje, pa u dnevniku nema alarma.
 */
export function pokreniTelegramPoller(opcije: PokretanjeOpcije = {}): Pokretanje {
  const log = opcije.log || ((r: string) => console.log(r))
  const cfg = loadTelegramConfig(opcije.configPath)

  if (!trebaPetlja(cfg, opcije.razgovor)) return { pokrenut: false, razlog: 'ulazni kanal je isključen' }
  // Token dolazi iz datoteke s tajnama (v. `telegramBotToken`), ne iz JSON-a — nalaz B2.
  const token = telegramBotToken(cfg)
  if (!token) return { pokrenut: false, razlog: 'bot token nije postavljen' }

  if (aktivna?.ziv()) return { pokrenut: false, razlog: 'poller već radi u ovom procesu' }

  const brava = uzmiBravu(opcije.bravaPath)
  if (!brava.ok) {
    log(`[telegram-poller] ne pokrećem se: ${brava.razlog}`)
    return { pokrenut: false, razlog: brava.razlog }
  }

  const stanjePath = opcije.stanjePath || STANJE_PUTANJA
  const ploca = opcije.plocaBase || process.env.TM_API_BASE || 'http://localhost:17781'
  const api = opcije.api || telegramApi(token, ploca)
  let radi = true
  let tajmer: ReturnType<typeof setTimeout> | null = null
  let uzastopnihKvarova = 0
  // Razgovor: tko je ovaj bot (`getMe`, jednom po petlji) i kanal za odgovore.
  const razg: RazgovorUlaza | undefined = opcije.razgovor
    ? {
      ...opcije.razgovor,
      kanal: opcije.razgovor.kanal || telegramKanal(token,
        () => ({ ...ZADANI_PRIVITCI, ...(loadTelegramConfig(opcije.configPath).privitci || {}) }),
        () => razg?.ja || null),
    }
    : undefined
  let jaDohvacen = !!razg?.ja

  const korak = async () => {
    if (!radi) return
    const svjez = loadTelegramConfig(opcije.configPath)
    const stanje = ucitajStanje(stanjePath)
    let cekaj = Math.max(1, svjez.ulaz.intervalSek) * 1000

    if (razg && !jaDohvacen && api.getMe) {
      const ja = await api.getMe().catch(() => null)
      if (ja) { razg.ja = ja; jaDohvacen = true }
    }

    if (!trebaPetlja(svjez, razg)) {
      log('[telegram-poller] ulaz je isključen s ploče — zaustavljam petlju')
      zaustavi()
      return
    }
    if (stanje.cekajDo > Date.now()) {
      cekaj = stanje.cekajDo - Date.now()
    } else {
      const ishod = await jedanProlaz(svjez, stanje, api, razg)
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
    if (!radi) return
    radi = false
    if (tajmer) { clearTimeout(tajmer); tajmer = null }
    brava.osloboditi?.()
    if (aktivna?.stop === zaustavi) aktivna = null
  }
  const ziv = () => radi
  aktivna = { ziv, stop: zaustavi, token }

  log(`[telegram-poller] pokrenut (interval ${cfg.ulaz.intervalSek} s, ploča ${ploca})`)
  void korak()
  return { pokrenut: true, stop: zaustavi, ziv }
}

/** Zaustavi petlju ovog procesa, ako je ima. */
export function zaustaviTelegramPoller(): void {
  aktivna?.stop()
}

export interface Uskladivanje {
  radnja: 'pokrenut' | 'ponovno' | 'vec_radi' | 'zaustavljen' | 'nista'
  razlog?: string
}

/**
 * Uskladi petlju sa svježim postavkama — zove se nakon svakog spremanja s ploče (TASK-5274).
 * Prije se poller pokretao SAMO pri startu ploče, pa uključivanje Ulaza nije činilo ništa
 * do restarta.
 *
 *  - ulaz uključen, petlja ne radi           → pokreni;
 *  - ulaz uključen, petlja radi, isti token  → ne diraj (jedan poller);
 *  - token promijenjen                       → stara petlja stane; stanje staroga bota
 *    (offset, „zaustavljen" nakon 401) se briše jer za novog bota ne znači ništa; nova
 *    petlja krene ako je ulaz uključen;
 *  - ulaz isključen                          → ništa: petlja to sama pročita i stane. Aktivno
 *    gašenje bi ostavilo `getUpdates` u letu, a brzo ponovno uključivanje bi tada pokrenulo
 *    drugi `getUpdates` s istim tokenom → 409 i trajno zaustavljena petlja.
 */
export function uskladiTelegramPoller(
  opcije: PokretanjeOpcije & { prijasnjiToken?: string } = {},
): Uskladivanje {
  const cfg = loadTelegramConfig(opcije.configPath)
  const token = telegramBotToken(cfg)
  const tokenPromijenjen =
    (opcije.prijasnjiToken !== undefined && opcije.prijasnjiToken !== token) ||
    (!!aktivna?.ziv() && aktivna.token !== token)

  let zaustavljena = false
  if (tokenPromijenjen) {
    if (aktivna?.ziv()) { aktivna.stop(); zaustavljena = true }
    const stanjePath = opcije.stanjePath || STANJE_PUTANJA
    const s = ucitajStanje(stanjePath)
    zapisiStanje({
      ...s, offset: 0, zaustavljen: false, zaustavljenRazlog: null, cekajDo: 0,
      zadnjaGreska: null, zadnjaGreskaTs: null,
    }, stanjePath)
  }

  if (aktivna?.ziv()) return { radnja: 'vec_radi' }
  if (!trebaPetlja(cfg, opcije.razgovor)) return { radnja: zaustavljena ? 'zaustavljen' : 'nista', razlog: 'ulazni kanal je isključen' }

  const p = pokreniTelegramPoller(opcije)
  if (!p.pokrenut) return { radnja: zaustavljena ? 'zaustavljen' : 'nista', razlog: p.razlog }
  return { radnja: zaustavljena ? 'ponovno' : 'pokrenut' }
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
  const token = telegramBotToken(cfg)
  if (!token) return { ok: false, greska: 'bot token nije postavljen' }
  const stanje = ucitajStanje()
  const klijent = api || telegramApi(token, process.env.TM_API_BASE || 'http://localhost:17781')
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
export function stanjeUlaza(
  stanjePath?: string, bravaPath: string = BRAVA_PUTANJA,
): StanjePollera & { radi: boolean } {
  const s = ucitajStanje(stanjePath)
  let radi = false
  try {
    if (existsSync(bravaPath)) {
      const pid = Number(readFileSync(bravaPath, 'utf-8').trim())
      try { process.kill(pid, 0); radi = true } catch (e: any) { radi = e?.code === 'EPERM' }
    }
  } catch { /* brave nema */ }
  return { ...s, radi: radi && !s.zaustavljen }
}
