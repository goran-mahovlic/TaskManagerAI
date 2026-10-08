/**
 * TajnePloca — ožičenje `/api/tajne*` za ploču paketa (ADR-0007 §9): postavke, popis imena,
 * pošiljatelj koda u privatni Telegram vlasnika. Logika je u `TajneApi.ts`, pisač u
 * `LoginCreds.ts`, kod u `core/PotvrdaVlasnika.ts`.
 *
 * POSTAVKE (`config/tajne.json`, NIJE tajna, ploča ih NE mijenja):
 *   { "potvrdaUid": ["<telegram uid>"], "dopustiLanHttp": false, "dodatnaImena": ["X_TOKEN"] }
 * Upisuju se CLI-jem na stroju (`bun scripts/tajna.ts podesi …`). Da ih ploča smije mijenjati,
 * uređaj iz LAN-a bi postavio SVOJ uid kao primatelja koda i zaobišao potvrdu (A1, §4.2).
 */
import { existsSync, readFileSync } from 'fs'
import { hostname } from 'os'
import { dopustenaImena, type DopustenoIme } from './LoginCreds'
import { PotvrdaVlasnika } from './core/PotvrdaVlasnika'
import { obradiTajne, type KontekstTajni, type OdgovorTajni, type PostavkeTajni } from './TajneApi'
import { datotekaTajniZaPisanje } from './core/ConfigModul'
import { konfigPutanja, stanjePutanja } from './core/paths'
import { loadEmailConfig } from './EmailConfig'
import { loadNextcloudConfig } from './NextcloudConfig'
import { loadGitHubConfig } from './GitHubConfig'
import { loadGitLabConfig } from './GitLabConfig'
import { loadTelegramConfig, telegramBotToken, telegramApiBaza } from './TelegramConfig'
import { ENV_LOZINKE } from './rag/rag-backend-config'

export const tajnePostavkePutanja = (): string => konfigPutanja('tajne.json', 'TM_TAJNE_POSTAVKE')

export function ucitajPostavkeTajni(put: string = tajnePostavkePutanja()): PostavkeTajni & { dodatnaImena: string[] } {
  let j: any = {}
  try { if (existsSync(put)) j = JSON.parse(readFileSync(put, 'utf-8')) } catch { /* pokvarena datoteka = zadano (isključeno) */ }
  const popis = (x: unknown): string[] => Array.isArray(x) ? x.map(v => String(v).trim()).filter(Boolean) : []
  return {
    potvrdaUid: popis(j.potvrdaUid).filter(u => /^\d{1,20}$/.test(u)),
    dopustiLanHttp: j.dopustiLanHttp === true,
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

/** Kod ide IZRAVNO iz ploče u privatni chat (ne kroz agenta ni red poruka, §4.2). */
async function posaljiPrivatno(uid: string, tekst: string): Promise<boolean> {
  const token = telegramBotToken(loadTelegramConfig())
  if (!token) return false
  try {
    const r = await fetch(`${telegramApiBaza()}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: uid, text: tekst, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    })
    const d = await r.json().catch(() => ({})) as any
    return r.ok && d?.ok !== false
  } catch { return false }
}

let kontekst: KontekstTajni | null = null

export function kontekstTajni(davatelji: { id: string; envKey?: string }[]): KontekstTajni {
  if (kontekst) return kontekst
  const cvor = (process.env.TM_CVOR || process.env.REGOC_NODE_NAME || hostname()).slice(0, 40)
  kontekst = {
    get spremiste() { return datotekaTajniZaPisanje() },
    auditPut: stanjePutanja('tajne_audit.jsonl'),
    dogadajiPut: stanjePutanja('tajne_dogadaji.jsonl'),
    potvrda: new PotvrdaVlasnika({ primatelji: () => ucitajPostavkeTajni().potvrdaUid, posalji: posaljiPrivatno, cvor }),
    postavke: () => ucitajPostavkeTajni(),
    imena: () => imenaTajniPloce(davatelji),
    log: s => console.log(s),
  }
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
