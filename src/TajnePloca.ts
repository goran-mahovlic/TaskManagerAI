/**
 * TajnePloca — ožičenje `/api/tajne*` za ploču paketa (ADR-0007 §9): postavke, popis imena,
 * pošiljatelj koda u privatni Telegram vlasnika. Logika je u `TajneApi.ts`, pisač u
 * `LoginCreds.ts`, kod u `core/PotvrdaVlasnika.ts`.
 *
 * POSTAVKE (`config/tajne.json`, NIJE tajna, ploča ih NE mijenja, datoteka NIJE obavezna):
 *   { "potvrdaUid": ["<telegram uid>"], "dopustiLanHttp": true, "dodatnaImena": ["X_TOKEN"] }
 * Bez datoteke (TASK-5357): primatelj koda je vlasnik iz profila instance čvora
 * (`TajneVlasnik.primateljiKoda`), a privatni LAN HTTP je dopušten. Da ploča smije mijenjati
 * primatelja, uređaj iz LAN-a bi postavio SVOJ uid i zaobišao potvrdu (A1, §4.2).
 */
import { existsSync, readFileSync } from 'fs'
import { hostname, networkInterfaces } from 'os'
import { dopustenaImena, type DopustenoIme } from './LoginCreds'
import { PotvrdaVlasnika } from './core/PotvrdaVlasnika'
import { adresePloce, citajInstancu, prepoznajZahtjevTajne, primateljiKoda, uputaZaUpis } from './TajneVlasnik'
import type { UlaznaPoruka } from './razgovor/Kanal'
import { obradiTajne, type KontekstTajni, type OdgovorTajni, type PostavkeTajni } from './TajneApi'
import { datotekaTajniZaPisanje } from './core/ConfigModul'
import { konfigPutanja, stanjePutanja, TM_ROOT } from './core/paths'
import { join } from 'path'
import { loadEmailConfig } from './EmailConfig'
import { loadNextcloudConfig } from './NextcloudConfig'
import { loadGitHubConfig } from './GitHubConfig'
import { loadGitLabConfig } from './GitLabConfig'
import { loadTelegramConfig, telegramBotToken, telegramApiBaza } from './TelegramConfig'
import { ENV_LOZINKE } from './rag/rag-backend-config'

export const tajnePostavkePutanja = (): string => konfigPutanja('tajne.json', 'TM_TAJNE_POSTAVKE')

/** Profil instance čvora (ADR-0004) — odatle vlasnik kad `tajne.json` nema `potvrdaUid`. */
export const profilInstancePutanja = (): string =>
  process.env.TM_PROFIL_INSTANCA || join(TM_ROOT, 'config', 'profil.instanca.env')

export function ucitajPostavkeTajni(
  put: string = tajnePostavkePutanja(), instanca: string = profilInstancePutanja(),
): PostavkeTajni & { dodatnaImena: string[] } {
  let j: any = {}
  try { if (existsSync(put)) j = JSON.parse(readFileSync(put, 'utf-8')) } catch { /* pokvarena datoteka = zadano */ }
  const popis = (x: unknown): string[] => Array.isArray(x) ? x.map(v => String(v).trim()).filter(Boolean) : []
  const p = primateljiKoda(popis(j.potvrdaUid), citajInstancu(instanca))
  return {
    potvrdaUid: p.uid,
    potvrdaIzvor: p.izvor,
    // TASK-5357: privatni LAN je zadano dopušten; vlasnik ga gasi samo izričitim `false`.
    dopustiLanHttp: j.dopustiLanHttp !== false,
    dodatnaImena: popis(j.dodatnaImena),
  }
}

/** §6.1 — računa se uživo pri svakom zahtjevu (promjena modula odmah mijenja popis). */
export function imenaTajniPloce(davatelji: { id: string; envKey?: string }[]): DopustenoIme[] {
  const moduli: DopustenoIme[] = []
  const uzmi = (fn: () => { ime?: string; izvor: string }[]) => {
    try { for (const m of fn()) if (m.ime) moduli.push({ ime: m.ime, izvor: m.izvor }) } catch { /* modul bez konfiguracije */ }
  }
  uzmi(() => { const c = loadEmailConfig(); return [{ ime: c.smtp?.lozinkaEnv, izvor: 'email.smtp' }, { ime: c.imap?.lozinkaEnv, izvor: 'email.imap' }] })
  uzmi(() => [{ ime: loadNextcloudConfig().lozinkaEnv, izvor: 'nextcloud' }])
  uzmi(() => [{ ime: loadGitHubConfig().tokenEnv, izvor: 'github' }])
  uzmi(() => [{ ime: loadGitLabConfig().tokenEnv, izvor: 'gitlab' }])
  uzmi(() => [{ ime: loadTelegramConfig().botTokenEnv, izvor: 'telegram' }])
  uzmi(() => [{ ime: ENV_LOZINKE, izvor: 'rag.pgvector' }])
  return dopustenaImena({
    davatelji: davatelji.filter(d => d.envKey).map(d => ({ envKey: d.envKey, izvor: `davatelj.${d.id}` })),
    moduli,
    dodatna: ucitajPostavkeTajni().dodatnaImena,
  })
}

/**
 * Kod ide IZRAVNO iz ploče u privatni chat (ne kroz agenta ni red poruka, §4.2).
 * Neuspjeh nosi `description` iz Telegrama (uputa #198: 403 „bot can't initiate conversation"
 * znači da vlasnik botu još nije pisao /start) — bez toga je audit znao samo „nije poslano".
 */
async function posaljiPrivatno(uid: string, tekst: string): Promise<{ ok: boolean; opis?: string }> {
  const token = telegramBotToken(loadTelegramConfig())
  if (!token) return { ok: false, opis: 'Telegram bot token nije postavljen' }
  try {
    const r = await fetch(`${telegramApiBaza()}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: uid, text: tekst, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    })
    const d = await r.json().catch(() => ({})) as any
    if (r.ok && d?.ok !== false) return { ok: true }
    return { ok: false, opis: `HTTP ${r.status}${d?.description ? `: ${String(d.description)}` : ''}` }
  } catch (e: any) { return { ok: false, opis: String(e?.name || 'greška mreže') } }
}

/** Korisničko ime bota (getMe), pamti se po tokenu — kartica kaže kojem botu pisati /start. */
let botImeZapis: { token: string; ime: string | null; kada: number } | null = null
async function dohvatiImeBota(): Promise<string | null> {
  const token = telegramBotToken(loadTelegramConfig())
  if (!token) return null
  if (botImeZapis && botImeZapis.token === token && Date.now() - botImeZapis.kada < 10 * 60_000) return botImeZapis.ime
  let ime: string | null = null
  try {
    const r = await fetch(`${telegramApiBaza()}/bot${token}/getMe`, { signal: AbortSignal.timeout(5000) })
    const d = await r.json().catch(() => ({})) as any
    ime = d?.ok && typeof d.result?.username === 'string' ? d.result.username : null
  } catch { ime = null }
  botImeZapis = { token, ime, kada: Date.now() }
  return ime
}

let kontekst: KontekstTajni | null = null

const imeCvora = (): string => (process.env.TM_CVOR || process.env.REGOC_NODE_NAME || hostname()).slice(0, 40)

/** @korisničko ime bota čvora (`getMe`), jednom po procesu — za uputu „pokreni bota". */
let imeBota: string | null = null
export async function osvjeziImeBota(): Promise<string | null> {
  const token = telegramBotToken(loadTelegramConfig())
  if (!token) return null
  try {
    const r = await fetch(`${telegramApiBaza()}/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) })
    const d = await r.json().catch(() => ({})) as any
    if (typeof d?.result?.username === 'string') imeBota = d.result.username
  } catch { /* uputa tada kaže „ovog bota" */ }
  return imeBota
}

/**
 * TASK-5357: vlasnikova molba s Telegrama („upiši lozinku za mail") → uputa korak po korak s
 * poveznicom na obrazac. Samo pošiljatelj koji je primatelj koda; ostali idu na običan potez.
 */
export function uputaTajniZaPoruku(p: UlaznaPoruka, o: {
  port: number; dopusten: (host: string) => boolean; davatelji: { id: string; envKey?: string }[]
}): string | null {
  const z = prepoznajZahtjevTajne(p.tekst || '')
  if (!z) return null
  if (!ucitajPostavkeTajni().potvrdaUid.includes(String(p.posiljateljId))) return null
  return uputaZaUpis({
    izvor: z.izvor, imena: imenaTajniPloce(o.davatelji), cvor: imeCvora(), bot: imeBota,
    adrese: adresePloce({ port: o.port, dopusten: o.dopusten, sucelja: networkInterfaces(), javniUrl: process.env.TM_JAVNI_URL }),
  })
}

export function kontekstTajni(davatelji: { id: string; envKey?: string }[]): KontekstTajni {
  if (kontekst) return kontekst
  const cvor = imeCvora()
  kontekst = {
    get spremiste() { return datotekaTajniZaPisanje() },
    auditPut: stanjePutanja('tajne_audit.jsonl'),
    dogadajiPut: stanjePutanja('tajne_dogadaji.jsonl'),
    potvrda: new PotvrdaVlasnika({ primatelji: () => ucitajPostavkeTajni().potvrdaUid, posalji: posaljiPrivatno, cvor }),
    postavke: () => ucitajPostavkeTajni(),
    imena: () => imenaTajniPloce(davatelji),
    log: s => console.log(s),
    imeBota: () => imeBota,
    bot: dohvatiImeBota,
  }
  if (!imeBota) void osvjeziImeBota()
  return kontekst
}

/** Most iz Bun `Request` u čistu obradu. Tijelo se čita ovdje i nikad ne ide u dnevnik. */
export async function obradiTajneZahtjev(
  req: Request, put: string, ip: string | null, davatelji: { id: string; envKey?: string }[],
): Promise<Response> {
  let tijelo = ''
  if (req.method !== 'GET') { try { tijelo = await req.text() } catch { tijelo = '' } }
  let r: OdgovorTajni
  try {
    r = await obradiTajne({
      metoda: req.method, put, zaglavlja: req.headers, ip,
      tls: new URL(req.url).protocol === 'https:', tijelo,
    }, kontekstTajni(davatelji))
  } catch (e: any) {
    console.log(`[TAJNE] iznimka ${String(e?.name || 'Error')}`) // samo ime: poruka može citirati ulaz
    r = { status: 500, tijelo: { greska: 'interna_greska' }, zaglavlja: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  }
  tijelo = ''
  return new Response(JSON.stringify(r.tijelo), { status: r.status, headers: r.zaglavlja })
}
