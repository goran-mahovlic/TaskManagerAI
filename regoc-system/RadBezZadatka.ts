/**
 * RadBezZadatka — „nema zadatka, nema pisanja” za Telegram sesiju (TASK-5164).
 *
 * Dizajn: `~/app/regoc_system/docs/DIZAJN-nesukladnosti-BCD.md` §3 (nesukladnost C).
 *
 * Izmjereno 26.09.–03.10.2026.: 61 od 75 poteza Telegram sesije koji mijenjaju datoteke nije imalo
 * otvoren zadatak (M9). Pravilo 25 i ulazna vrata govore KADA posao ide u TaskManager, ali ništa
 * to nije provodilo — proza u promptu nije dovoljna. Kuka je jedino mjesto koje vidi izmjenu
 * PRIJE nego što se dogodi.
 *
 * Djeluje SAMO kad je `REGOC_SESIJA=telegram` (Klaudio ga postavlja procesu sesije). Agentski
 * spawnovi (`REGOC_TASK_ID`) i interaktivne sesije se ne diraju. Fail-open: kvar, istek roka
 * (300 ms) ili nečitljiva konfiguracija = propusti uz zapis.
 *
 * Konfiguracija (čita se pri svakom pozivu): `config/rad-bez-zadatka.json`
 *   { nacin: off|shadow|on, lanacNacin: off|shadow|on, dopustenePutanje: [...] }
 * Dvije ručice jer imaju različit rizik: „nema zadatka” je determinističan, a „lanac” ovisi o
 * umjerenosti ulaznih vrata (TASK-5161/5162: preporuka QA-a „ostati shadow”).
 */
import { readFileSync, appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

export type Nacin = 'off' | 'shadow' | 'on'

export interface KonfigRada {
  nacin: Nacin
  lanacNacin: Nacin
  dopustenePutanje: string[]
}

export const ZADANA_KONFIG: KonfigRada = {
  nacin: 'shadow',
  lanacNacin: 'shadow',
  dopustenePutanje: [
    '/tmp', '~/.tmp', '~/.claude/tmp', '~/.claude/tools/Telegram/conversations',
    '~/.claude/projects/-home-klaudio-app-regoc-system/memory',
  ],
}

const PISUCI_ALATI = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const POSTUPCI_LANCA = new Set(['lanac', 'lanac-uz-potvrdu'])

export const NAREDBA_ALATA = 'bun ~/.claude/regoc/tools/zadaci/sesija_zadatak.ts'

export function parsirajUlaz(v: string | undefined): { postupak: string; tezina: number } | null {
  const m = String(v || '').match(/^([a-z-]+):(\d+(?:\.\d+)?)$/)
  return m ? { postupak: m[1], tezina: Number(m[2]) } : null
}

export function dopustenaPutanja(putanja: string, cfg: KonfigRada, home: string): boolean {
  const p = String(putanja || '')
  if (!p) return false
  return cfg.dopustenePutanje.some((d) => {
    const korijen = d.startsWith('~/') ? join(home, d.slice(2)) : d
    const k = korijen.replace(/\/+$/, '')
    return p === k || p.startsWith(k + '/')
  })
}

export interface StanjeZadatka { taskId: string; status: string; assignee?: string | null }

export interface SudRada {
  sud: 'propusti' | 'odbij'
  /** Provodi li se odbijanje (uživo) ili samo bilježi (sjena). */
  provedi: boolean
  kod: 'nije-sesija' | 'agentski-spawn' | 'ne-pise' | 'iskljuceno' | 'dopustena-putanja' | 'ima-zadatak' | 'nema-zadatka' | 'lanac' | 'fail-open'
  poruka?: string
}

export function sudiRadu(a: {
  env: Record<string, string | undefined>
  alat: string
  putanja: string
  cfg: KonfigRada
  stanje: StanjeZadatka | null
}): SudRada {
  const { env, cfg } = a
  if (env.REGOC_SESIJA !== 'telegram') return { sud: 'propusti', provedi: false, kod: 'nije-sesija' }
  if (env.REGOC_TASK_ID) return { sud: 'propusti', provedi: false, kod: 'agentski-spawn' }
  if (!PISUCI_ALATI.has(a.alat)) return { sud: 'propusti', provedi: false, kod: 'ne-pise' }
  if (cfg.nacin === 'off' && cfg.lanacNacin === 'off') return { sud: 'propusti', provedi: false, kod: 'iskljuceno' }
  if (dopustenaPutanja(a.putanja, cfg, env.HOME || homedir())) return { sud: 'propusti', provedi: false, kod: 'dopustena-putanja' }

  const otvoren = a.stanje && a.stanje.status === 'in_progress'
  if (!otvoren) {
    if (cfg.nacin === 'off') return { sud: 'propusti', provedi: false, kod: 'iskljuceno' }
    return {
      sud: 'odbij', provedi: cfg.nacin === 'on', kod: 'nema-zadatka',
      poruka: `Ova izmjena (${a.putanja}) je isporuka, a sesija nema otvoren zadatak. Otvori ga jednom naredbom: ` +
        `\`${NAREDBA_ALATA} otvori "<naslov>"\` (dorada isporuke: \`--dorada-od TASK-X\`), pa ponovi izmjenu. ` +
        `Kad završiš: \`${NAREDBA_ALATA} zatvori "<sažetak s dokazom>"\`.`,
    }
  }
  const ulaz = parsirajUlaz(env.REGOC_ULAZ)
  if (ulaz && POSTUPCI_LANCA.has(ulaz.postupak) && (a.stanje!.assignee || 'regoc') === 'regoc' && cfg.lanacNacin !== 'off') {
    return {
      sud: 'odbij', provedi: cfg.lanacNacin === 'on', kod: 'lanac',
      poruka: `Ulazna vrata ocijenila su nalog kao višestručan (${ulaz.postupak}, težina ${ulaz.tezina}) — pravilo 25. ` +
        `Razloži ga u TaskManager po skillovima (assignee, projectId, chat:<id>, blockedBy), a ne radi sam na ${a.stanje!.taskId}.`,
    }
  }
  return { sud: 'propusti', provedi: false, kod: 'ima-zadatak' }
}

// ─── Kuka ────────────────────────────────────────────────────────────────────

export interface Putevi { stanjeDir: string; zapis: string; konfig: string }

export function zadaniPutevi(home: string = process.env.HOME || homedir()): Putevi {
  const r = join(home, '.claude', 'regoc')
  return {
    stanjeDir: join(r, 'data', 'sesija_zadatak'),
    zapis: join(r, 'data', 'rad_bez_zadatka.jsonl'),
    konfig: join(r, 'config', 'rad-bez-zadatka.json'),
  }
}

export function ucitajKonfig(put: string): KonfigRada {
  try {
    const j = JSON.parse(readFileSync(put, 'utf-8'))
    const n = (v: unknown, z: Nacin): Nacin => (v === 'off' || v === 'shadow' || v === 'on') ? v : z
    return {
      nacin: n(j.nacin, ZADANA_KONFIG.nacin),
      lanacNacin: n(j.lanacNacin, ZADANA_KONFIG.lanacNacin),
      dopustenePutanje: Array.isArray(j.dopustenePutanje) ? j.dopustenePutanje.filter((x: unknown) => typeof x === 'string') : ZADANA_KONFIG.dopustenePutanje,
    }
  } catch { return ZADANA_KONFIG }
}

export function putStanja(stanjeDir: string, chatId: string): string {
  return join(stanjeDir, `${String(chatId).replace(/[^0-9A-Za-z_-]/g, '_')}.json`)
}

export function procitajStanje(stanjeDir: string, chatId: string | undefined): { taskId: string } | null {
  if (!chatId) return null
  try {
    const j = JSON.parse(readFileSync(putStanja(stanjeDir, chatId), 'utf-8'))
    return typeof j?.taskId === 'string' ? j : null
  } catch { return null }
}

export type DohvatStatusa = (taskId: string) => Promise<{ status: string; assignee?: string | null } | null>

export const dohvatStatusaPloce: DohvatStatusa = async (taskId) => {
  const r = await fetch(`http://localhost:17781/api/tasks/${encodeURIComponent(taskId)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const t = await r.json() as any
  return { status: String(t.status), assignee: t.assignee ?? null }
}

class Istek extends Error {}

/**
 * Cijela kuka: stdin → sud → (ispis za deny | null). Nikad ne baca.
 * Vraća tekst za stdout samo kad se odbijanje PROVODI.
 */
export async function pokreniKuku(a: {
  env: Record<string, string | undefined>
  stdin: string
  putevi?: Putevi
  status?: DohvatStatusa
  rokMs?: number
}): Promise<string | null> {
  try {
    if (a.env.REGOC_SESIJA !== 'telegram' || a.env.REGOC_TASK_ID) return null
    const putevi = a.putevi ?? zadaniPutevi(a.env.HOME)
    let ulaz: any
    try { ulaz = JSON.parse(a.stdin) } catch { return null }
    const alat = String(ulaz?.tool_name || '')
    const putanja = String(ulaz?.tool_input?.file_path || ulaz?.tool_input?.notebook_path || '')
    if (!PISUCI_ALATI.has(alat)) return null
    const cfg = ucitajKonfig(putevi.konfig)

    const zapisi = (red: Record<string, unknown>) => {
      try {
        mkdirSync(dirname(putevi.zapis), { recursive: true })
        appendFileSync(putevi.zapis, JSON.stringify({ ts: new Date().toISOString(), chat: a.env.REGOC_CHAT_ID ?? null,
          ulaz: a.env.REGOC_ULAZ ?? null, alat, putanja, ...red }) + '\n')
      } catch { /* zapis nikad ne ruši alat */ }
    }

    let stanje: StanjeZadatka | null = null
    const s = procitajStanje(putevi.stanjeDir, a.env.REGOC_CHAT_ID)
    if (s && !dopustenaPutanja(putanja, cfg, a.env.HOME || homedir())) {
      try {
        const rok = a.rokMs ?? 300
        const st = await Promise.race([
          (a.status ?? dohvatStatusaPloce)(s.taskId),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Istek('rok')), rok)),
        ])
        stanje = st ? { taskId: s.taskId, status: st.status, assignee: st.assignee } : null
      } catch (e) {
        zapisi({ sud: 'propusti', kod: 'fail-open', razlog: e instanceof Istek ? `rok ${a.rokMs ?? 300} ms` : String(e).slice(0, 200), taskId: s.taskId })
        return null
      }
    }
    const sud = sudiRadu({ env: a.env, alat, putanja, cfg, stanje })
    if (sud.kod === 'nije-sesija' || sud.kod === 'agentski-spawn' || sud.kod === 'ne-pise') return null
    const nacin = sud.kod === 'lanac' ? cfg.lanacNacin : cfg.nacin
    zapisi({ sud: sud.sud, kod: sud.kod, provedeno: sud.sud === 'odbij' && sud.provedi, nacin, taskId: stanje?.taskId ?? null })
    if (sud.sud === 'odbij' && sud.provedi) {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: sud.poruka },
      })
    }
    return null
  } catch {
    return null
  }
}
