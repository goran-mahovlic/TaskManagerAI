// src/core/TaskCloser.ts
//
// JEDINA TOČKA ZATVARANJA ZADATKA (ADR-0012, opcija B).
//
// ZAŠTO POSTOJI
//   Do sada je zadatak zatvarao TKO STIGNE PRVI: agent iz svog prompta (`curl PUT
//   status=completed`) ili daemon nakon suda kritičara (RegocDaemon.ts:3579).
//   Agent uvijek stiže prvi — kritičar se pokreće TEK po izlasku spawna.
//
//   Izmjereno na regoc.db + data/critic_gate.jsonl (12.09.2026.):
//     6 od 6 zadataka kojima je kritičar presudio FAIL (enforced=true) stoji na
//     ploči kao `completed`; `completed_at` je 5,2–79,7 s PRIJE suda kritičara.
//     TASK-3068, 4311, 4722, 4771, 4789, 4807. Nijedan nije `blocked`.
//   `completed` je terminalno stanje (TaskManagerSQL.ValidStatusTransitions
//   ['completed'] = []), pa daemonov naknadni PUT vrati 409/null — a poziv je bio
//   omotan u `catch {}` BEZ ijednog loga. Kvar je time bio i nevidljiv.
//
// ŠTO OVAJ MODUL RADI
//   1. `zatvoriZadatak()` — PUT s logom, jednim ponavljanjem i tvrdim zapisom neuspjeha.
//      Kad je taj PUT jedina točka istine, njegov tihi pad znači zadatak koji visi
//      ni-tamo-ni-ovamo. Nijedan ishod ovdje ne nestaje bez traga.
//   2. NAJAM SPAWNA (`uzmiNajam`/`pustiNajam`/`najamAktivan`) — međuprocesni biljeg
//      „na ovom zadatku upravo radi spawn". TaskWebUI ga čita da bi odbio `completed`
//      koji stiže IZVAN daemona dok spawn traje (obrana u dubinu uz uklonjenu uputu).
//
// NAČELO: FAIL-OPEN. Nečitljiv, pokvaren ili ustajao najam NIKAD ne smije zaključati
// zadatak — guard koji blokira normalan rad biva isključen (v. memoriju o tri sloja
// obrane protiv tajni). Zaključava samo najam koji je DOKAZIVO živ (/proc/<pid>).

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isTestRuntime } from './LiveDbGuard'
import { stanjePutanja } from './paths'

/**
 * Mapa najmova. Isti obrazac kao data/file_scope_claims/ (A3/TASK-3002).
 *
 * Putanja se čita PRI SVAKOM POZIVU, ne pri učitavanju modula: `SpawnFinalizer` i
 * testovi uvoze ovaj modul preko različitih putanja (cache-busting), pa bi zamrznuta
 * vrijednost značila da jedan pozivatelj piše najam u jednu mapu, a drugi ga briše
 * iz druge — najam bi „preživio" vlastito puštanje. (Nalaz iz testa F3.)
 */
export function najmoviDir(): string {
  if (process.env.REGOC_SPAWN_LEASE_DIR) return process.env.REGOC_SPAWN_LEASE_DIR
  // Test-proces NE SMIJE pisati u živu mapu najmova: harnessi koji kopiraju izvor
  // RegocDaemona (npr. `_heartbeat_harness`) pokreću pravi kod, pa bi najam s tuđim
  // pidom ostao u pogonskoj mapi i — nakon paljenja `spawnCloseGuardLive` — zaključao
  // zadatak koji nitko ne radi. Ista pouka kao LiveDbGuard (fixture u živoj bazi).
  if (isTestRuntime()) return join(tmpdir(), 'spawn_leases_test')
  return stanjePutanja('spawn_leases')
}

/** Zatečena vrijednost pri učitavanju — za pozivatelje kojima treba konstanta. */
export const NAJMOVI_DIR = najmoviDir()

/** Dnevnik zatvaranja koja NISU uspjela — jedino mjesto gdje se takav ishod vidi. */
export function neuspjesiLog(): string {
  return process.env.REGOC_CLOSE_FAIL_LOG || stanjePutanja('close_failures.jsonl')
}

export const NEUSPJESI_LOG = neuspjesiLog()

/** Najstariji najam koji se još smatra živim (4 h = gornja granica spawna). */
export const NAJAM_MAX_MS = 4 * 60 * 60 * 1000

export interface Najam {
  taskId: string
  agent: string
  pid: number
  startedAt: string
}

export interface ZatvaranjeOpcije {
  /** Broj POKUŠAJA ukupno (1 = bez ponavljanja). Zadano 2 = jedan retry. */
  pokusaja?: number
  /** Pauza između pokušaja u ms. Zadano 1500. */
  pauzaMs?: number
  /** Zapisivač dnevnika (daemonov `log`). */
  log?: (poruka: string) => void
  /** Ubrizgavanje `fetch`-a radi testiranja. */
  fetchFn?: typeof fetch
  /** Ubrizgavanje spavanja radi testiranja. */
  sleepFn?: (ms: number) => Promise<void>
  /** Zapiši neuspjeh u NEUSPJESI_LOG. Zadano true. */
  zapisiNeuspjeh?: boolean
}

export interface ZatvaranjeIshod {
  ok: boolean
  /** HTTP status zadnjeg pokušaja, ili null ako fetch uopće nije došao do odgovora. */
  httpStatus: number | null
  pokusaja: number
  greska: string | null
}

/** Ponavlja se SAMO ono što ponavljanje može popraviti: mreža i 5xx. */
function vrijediPonoviti(httpStatus: number | null): boolean {
  if (httpStatus === null) return true          // mreža / TaskWebUI se restartao
  return httpStatus >= 500 && httpStatus <= 599 // privremeni kvar poslužitelja
}

function spavaj(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Zatvori (ili blokiraj) zadatak preko TaskManager API-ja — pouzdano i glasno.
 *
 * Nikad ne baca. Ishod se UVIJEK vidi: uspjeh u dnevniku daemona, neuspjeh i u
 * dnevniku i u `close_failures.jsonl`.
 */
export async function zatvoriZadatak(
  apiBase: string,
  taskId: string,
  body: Record<string, unknown>,
  opts: ZatvaranjeOpcije = {},
): Promise<ZatvaranjeIshod> {
  const pokusaja = Math.max(1, opts.pokusaja ?? 2)
  const pauzaMs = opts.pauzaMs ?? 1500
  const log = opts.log ?? (() => {})
  const f = opts.fetchFn ?? fetch
  const sleep = opts.sleepFn ?? spavaj
  const zeljeniStatus = String(body.status ?? '?')

  let httpStatus: number | null = null
  let greska: string | null = null

  for (let i = 1; i <= pokusaja; i++) {
    httpStatus = null
    greska = null
    try {
      const res = await f(`${apiBase}/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      httpStatus = res.status
      if (res.ok) {
        if (i > 1) log(`✅ [zatvaranje] ${taskId} → ${zeljeniStatus} (uspjelo iz ${i}. pokušaja)`)
        return { ok: true, httpStatus, pokusaja: i, greska: null }
      }
      let tijelo = ''
      try { tijelo = (await res.text()).slice(0, 300) } catch { /* tijelo nije obavezno */ }
      greska = `HTTP ${res.status} ${tijelo}`.trim()
    } catch (e) {
      greska = `fetch: ${e instanceof Error ? e.message : String(e)}`
    }

    const zadnji = i === pokusaja
    if (!zadnji && vrijediPonoviti(httpStatus)) {
      log(`⚠️ [zatvaranje] ${taskId} → ${zeljeniStatus} nije prošlo (${greska}) — ponavljam za ${pauzaMs} ms`)
      await sleep(pauzaMs)
      continue
    }
    break
  }

  // 409 i 400 NISU isti kvar i pod opcijom (B) ne smiju dijeliti rečenicu (dorada
  // Jelena, TASK-4824):
  //   409 = zabranjen prijelaz ⇒ netko je zadatak već zatvorio (rupa iz TASK-3069).
  //   400 = VRATAR ga je odbio (CompletionGuard / ResearchRagGate / GitCommitGate,
  //         TaskWebUI.ts:10221/10258/10294). Zadatak NIJE u terminalnom stanju — stoji
  //         u `in_progress` i ondje će ostati zauvijek ako se ništa ne poduzme, jer
  //         daemon je pod (B) jedini pozivatelj i nema petlju popravka kakvu je agent
  //         imao (izmjereno: TASK-4595 research-rag-gate REJECT → agent dopunio → ACCEPT).
  //   Pogrešna dijagnoza ovdje šalje čitatelja dnevnika u krivom smjeru točno u slučaju
  //   koji pod (B) postaje najčešći.
  const dijagnoza = httpStatus === 409
    ? 'zabranjen prijelaz — zadatak je vjerojatno već u terminalnom stanju (netko ga je zatvorio prije daemona)'
    : httpStatus === 400
      ? 'vratar je odbio zapis (CompletionGuard/ResearchRagGate/GitCommitGate) — zadatak OSTAJE u in_progress; zatvori ga kao blocked s razlogom iz odgovora'
      : 'TaskManager nije prihvatio zapis'
  log(`⛔ [zatvaranje] ${taskId} → ${zeljeniStatus} NIJE zapisano: ${greska} — ${dijagnoza}`)

  if (opts.zapisiNeuspjeh !== false) {
    try {
      appendFileSync(neuspjesiLog(), JSON.stringify({
        ts: new Date().toISOString(), taskId, zeljeniStatus, httpStatus, greska,
      }) + '\n')
    } catch { /* dnevnik neuspjeha ne smije oboriti daemon */ }
  }

  return { ok: false, httpStatus, pokusaja, greska }
}

// ─── NAJAM SPAWNA ────────────────────────────────────────────────────────────

function putanjaNajma(taskId: string): string {
  return join(najmoviDir(), `${String(taskId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)
}

/** Zabilježi da na zadatku radi spawn. Nikad ne baca. */
export function uzmiNajam(najam: Najam): boolean {
  try {
    mkdirSync(najmoviDir(), { recursive: true })
    writeFileSync(putanjaNajma(najam.taskId), JSON.stringify(najam))
    return true
  } catch { return false }
}

/** Otpusti najam. MORA se pozvati PRIJE daemonovog zatvaranja zadatka. */
export function pustiNajam(taskId: string): boolean {
  try {
    const p = putanjaNajma(taskId)
    if (existsSync(p)) unlinkSync(p)
    return true
  } catch { return false }
}

export function citajNajam(taskId: string): Najam | null {
  try {
    const p = putanjaNajma(taskId)
    if (!existsSync(p)) return null
    const n = JSON.parse(readFileSync(p, 'utf-8')) as Najam
    if (!n || typeof n.pid !== 'number' || !n.startedAt) return null
    return n
  } catch { return null }
}

/** Živ proces? Jedini dokaz koji /proc daje bez roota. */
function pidZiv(pid: number): boolean {
  try { return pid > 0 && existsSync(`/proc/${pid}`) } catch { return false }
}

/**
 * Je li na zadatku DOKAZIVO aktivan spawn?
 *
 * `true` samo kad je najam čitljiv, mlađi od NAJAM_MAX_MS i njegov pid je živ.
 * Sve ostalo (nema najma, pokvaren JSON, mrtav pid, ustajao zapis) → `false`,
 * jer guard koji zaključa zadatak na temelju smeća je gori od rupe koju zatvara.
 */
export function najamAktivan(taskId: string, sad: number = Date.now()): boolean {
  const n = citajNajam(taskId)
  if (!n) return false
  const t = Date.parse(n.startedAt)
  if (!Number.isFinite(t)) return false
  if (sad - t > NAJAM_MAX_MS) return false
  return pidZiv(n.pid)
}

/** Počisti najmove čiji je proces mrtav ili koji su prestari (za daemonov prolaz). */
export function pocistiNajmove(sad: number = Date.now()): string[] {
  const ocisceni: string[] = []
  try {
    const dir = najmoviDir()
    if (!existsSync(dir)) return ocisceni
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const n = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Najam
        const t = Date.parse(n.startedAt)
        if (pidZiv(n.pid) && Number.isFinite(t) && sad - t <= NAJAM_MAX_MS) continue
        unlinkSync(join(dir, f))
        ocisceni.push(n.taskId || f)
      } catch {
        try { unlinkSync(join(dir, f)) ; ocisceni.push(f) } catch { /* preskoči */ }
      }
    }
  } catch { /* čišćenje nikad ne ruši pozivatelja */ }
  return ocisceni
}
