#!/usr/bin/env bun
/**
 * EarlyWorkGuard — M6 „rana provjera: ima li uopće posla" (TASK-4626).
 *
 * PROBLEM (docs/ISTRAZIVANJE-neuspjesi-i-greske.md §3, §4 M6): medijan trajanja NEUSPJELOG
 * izvođenja je 402 s, najduži 2 588 s (43 min). U incidentu 02.09.2026. svih 683 spawnova
 * imalo je `num_turns = 0` — nijedan model nije napravio ni jedan korak. Cijelo to vrijeme
 * mjesto u redu je zauzeto, a znalo se već u prvoj minuti.
 *
 * ZAŠTO NIJE DOVOLJAN `num_turns`: `claude --print --output-format json` NE emitira ništa do
 * kraja runa, pa je `num_turns` obdukcija, ne nadzor. Živi signal ipak postoji — CLI piše
 * transkript sesije INKREMENTALNO. Mjereno probeom 04.09.2026. (haiku, „reci pozdrav"):
 *
 *     t=1 s  datoteke nema
 *     t=2 s  13 redaka, 0 assistant   ← naivno brojanje redaka bi ovdje lagalo „radi"
 *     t=6 s  21 redak,  1 assistant   ← PRVI modelski korak
 *
 * Putanja transkripta je poznata unaprijed ako spawnu zadamo `--session-id <uuid>`:
 * `~/.claude/projects/<slug cwd-a>/<session-id>.jsonl`. Broj redaka `type:"assistant"` je
 * živi ekvivalent `num_turns`.
 *
 * UGOVOR (pribijen u tests/early-work-guard.test.ts):
 *   1. prekida se SAMO kad je 0 koraka POZITIVNO izmjereno nakon roka počeka (30 s);
 *   2. nedostupan signal (nema transkripta, greška čitanja) NIKAD ne prekida — fail-open,
 *      jer prihvatni kriterij glasi „nijedan uspješan spawn nije prekinut";
 *   3. prvi korak zatvara promatranje zauvijek — kasnija tišina je posao liveness watchdoga,
 *      ne ovog modula.
 *
 * Modul nema globalno stanje; sve nuspojave (vrijeme, spavanje, čitanje, provjera procesa)
 * prima kroz `deps` → testira se bez daemona, bez diska i bez čekanja u stvarnom vremenu.
 */

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

/** Rok počeka iz M6: 30 s. Nakon njega 0 koraka znači „nema posla". */
export const EARLY_WORK_GRACE_MS = 30_000

/** Razmak između sondi. 5 s → prosječno otkrivanje ≈ 32,5 s, duboko ispod praga od 60 s. */
export const EARLY_WORK_POLL_MS = 5_000

/**
 * Koliko dugo se čeka na SIGNAL (transkript) prije nego se odustane od promatranja.
 * Odustajanje NIJE prekid — spawn nastavlja raditi po starom.
 */
export const EARLY_WORK_NO_SIGNAL_MS = 3 * EARLY_WORK_GRACE_MS

/** Dnevnik odluka — ulaz za mjerenje lažnih prekida kroz 7 dana (prihvatni kriterij). */
export function earlyWorkLogFile(): string {
  return process.env.REGOC_EARLY_WORK_LOG || join(HOME, '.claude/regoc/data/early_work.jsonl')
}

// ============================================
// Odluka (čista funkcija)
// ============================================

export interface EarlyWorkObservation {
  /** Vrijeme od pokretanja spawna. */
  elapsedMs: number
  /** Broj modelskih koraka; `null` = signal nedostupan (nema transkripta / greška čitanja). */
  modelSteps: number | null
  /** Vrti li se spawn još uvijek. */
  processAlive: boolean
}

export type EarlyWorkVerdict =
  /** Nastavi promatrati. */
  | { action: 'wait'; reason: string }
  /** Prestani promatrati — spawn radi (ili je već gotov). Nikad ne prekida. */
  | { action: 'ok'; reason: string }
  /** Prestani promatrati jer signala nema. NIKAD ne prekida (fail-open). */
  | { action: 'giveup'; reason: string }
  /** Prekini spawn — 0 koraka je izmjereno nakon roka počeka. */
  | { action: 'abort'; code: 'NO_WORK_30S'; reason: string }

export interface EarlyWorkOptions {
  graceMs?: number
  noSignalMs?: number
}

/**
 * Redoslijed provjera je namjeran i nije zamjenjiv:
 * mrtav proces → ima koraka → još je rano → nema signala → prekid.
 * Svaka grana ISPRED prekida je razlog da se NE prekine.
 */
export function judgeEarlyWork(obs: EarlyWorkObservation, opts: EarlyWorkOptions = {}): EarlyWorkVerdict {
  const graceMs = opts.graceMs ?? EARLY_WORK_GRACE_MS
  const noSignalMs = opts.noSignalMs ?? EARLY_WORK_NO_SIGNAL_MS

  if (!obs.processAlive) {
    return { action: 'ok', reason: 'spawn je već izašao — ishod klasificira redovni put' }
  }
  if (obs.modelSteps !== null && obs.modelSteps > 0) {
    return { action: 'ok', reason: `agent radi (${obs.modelSteps} korak/a)` }
  }
  if (obs.elapsedMs < graceMs) {
    return { action: 'wait', reason: `rok počeka još traje (${Math.round(obs.elapsedMs / 1000)}s < ${graceMs / 1000}s)` }
  }
  if (obs.modelSteps === null) {
    // Fail-open: bez transkripta nemamo dokaz da agent NE radi. Nikad ne ubijamo na nagađanje.
    return obs.elapsedMs >= noSignalMs
      ? { action: 'giveup', reason: `nema signala nakon ${Math.round(obs.elapsedMs / 1000)}s — promatranje se gasi, spawn ostaje` }
      : { action: 'wait', reason: 'transkript još nije vidljiv — čekam signal' }
  }
  return {
    action: 'abort',
    code: 'NO_WORK_30S',
    reason: `0 modelskih koraka nakon ${Math.round(obs.elapsedMs / 1000)}s (rok ${graceMs / 1000}s) — spawn nema posla`,
  }
}

// ============================================
// Signal: transkript sesije
// ============================================

/**
 * Broj redaka `type:"assistant"` = broj modelskih koraka.
 * NAMJERNO se ne broje svi redci: transkript prvo dobije `queue-operation`/`attachment`/
 * `user`/`last-prompt` retke (13 komada u 2 s), a nijedan od njih nije rad modela.
 */
export function countAssistantLines(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    // Brzi predfiltar: bez ovog niza redak sigurno nije assistant.
    if (!s.includes('"assistant"')) continue
    try {
      if (JSON.parse(s)?.type === 'assistant') n++
    } catch { /* nedovršen zadnji redak (pišemo usred upisa) — preskoči */ }
  }
  return n
}

/** `null` = signal nedostupan (nema datoteke ili je nečitljiva), NIKAD 0 — razlika je bitna. */
export function countModelSteps(path: string | null): number | null {
  if (!path) return null
  try {
    if (!existsSync(path)) return null
    return countAssistantLines(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** Claude CLI slugifikacija cwd-a: svaki ne-alfanumerički znak → `-` (`/home/korisnik` → `-home-korisnik`). */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Putanja transkripta za zadani `--session-id`. Primarno se računa iz slug-a cwd-a; ako te
 * datoteke nema, obiđe `~/.claude/projects/*` (79 direktorija — jeftino) jer je session-id
 * UUID pa je jedinstven. Obilazak pokriva slučaj kad spawn dobije vlastiti git worktree (A1).
 */
export function transcriptPathForSession(cwd: string, sessionId: string, home: string = HOME): string {
  const root = join(home, '.claude/projects')
  const direct = join(root, slugForCwd(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch { /* nema projects/ — vrati očekivanu putanju, čitanje će dati null */ }
  return direct
}

// ============================================
// Petlja promatranja
// ============================================

export interface EarlyWorkWatchDeps {
  now(): number
  sleep(ms: number): Promise<void>
  /** Broj modelskih koraka ili `null`. Smije bacati — iznimka se tretira kao `null`. */
  countSteps(): number | null
  /** Vrti li se spawn još. */
  isAlive(): boolean
  onVerdict?(verdict: EarlyWorkVerdict, obs: EarlyWorkObservation): void
}

export interface EarlyWorkWatchOptions extends EarlyWorkOptions {
  startedAtMs: number
  pollMs?: number
  /** Tvrda gornja granica broja krugova — brana od beskonačne petlje u testu i u pogonu. */
  maxIterations?: number
}

/**
 * Vrti sonde dok ne padne konačna odluka. Vraća SAMO završni ishod
 * (`ok` | `giveup` | `abort`) — `wait` nikad ne izlazi iz petlje.
 */
export async function watchEarlyWork(
  deps: EarlyWorkWatchDeps,
  opts: EarlyWorkWatchOptions,
): Promise<EarlyWorkVerdict> {
  const pollMs = opts.pollMs ?? EARLY_WORK_POLL_MS
  const maxIterations = opts.maxIterations ?? 1000
  let last: EarlyWorkVerdict = { action: 'wait', reason: 'početak' }

  for (let i = 0; i < maxIterations; i++) {
    let steps: number | null
    try {
      steps = deps.countSteps()
    } catch {
      steps = null   // greška sonde = nedostupan signal, nikad „nema posla"
    }
    const obs: EarlyWorkObservation = {
      elapsedMs: Math.max(0, deps.now() - opts.startedAtMs),
      modelSteps: steps,
      processAlive: (() => { try { return deps.isAlive() } catch { return true } })(),
    }
    const verdict = judgeEarlyWork(obs, opts)
    last = verdict
    deps.onVerdict?.(verdict, obs)
    if (verdict.action !== 'wait') return verdict
    await deps.sleep(pollMs)
  }
  return last.action === 'wait' ? { action: 'giveup', reason: 'iscrpljen broj krugova' } : last
}

// ============================================
// Zapis odluka (mjerenje lažnih prekida)
// ============================================

export interface EarlyWorkLogEntry {
  ts: string
  mode: 'live' | 'shadow'
  agent: string
  task_id: string | number | null
  session_id: string | null
  pid: number | null
  elapsed_s: number
  model_steps: number | null
  action: EarlyWorkVerdict['action']
  reason: string
  /** Popunjava se naknadno kad se zna ishod: je li shadow-prekid bio LAŽAN. */
  final_num_turns?: number | null
}

/** Jedan redak po konačnoj odluci. Nikad ne baca — mjerenje ne smije srušiti spawn. */
export function recordEarlyWork(entry: EarlyWorkLogEntry): void {
  try {
    const f = earlyWorkLogFile()
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, JSON.stringify(entry) + '\n')
  } catch { /* dnevnik je dijagnostika, ne kritični put */ }
}
