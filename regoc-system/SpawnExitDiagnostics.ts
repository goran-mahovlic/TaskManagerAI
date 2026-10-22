/**
 * SpawnExitDiagnostics — forenzika izlaza `claude --print` spawnova (TASK-2955, D3)
 *
 * PROBLEM koji rješava:
 *   ~/.tmp/regoc_daemon.log je imao 11 zapisa oblika
 *     "❌ Agent regoc failed (exit 143): "
 *   i ništa više — bez signala, bez PID-a, bez trajanja, bez taskId-a, bez
 *   ijednog znaka stderr-a. 143 = 128+15 = SIGTERM, dakle netko je dijete ubio,
 *   ali iz loga se NIJE moglo vidjeti tko: daemon (killAgentSpawn), gašenje
 *   daemona (Bun ubija djecu pri process.exit) ili treći proces izvana.
 *
 * RJEŠENJE:
 *   Ovaj modul je čista (bez I/O) logika koja od činjenica o izlazu procesa radi
 *   presudu — TKO ga je ubio i broji li se to kao kvar agenta — te renderira
 *   log-liniju i puni dijagnostički izvještaj. RegocDaemon.ts radi samo I/O.
 *
 * Modul je namjerno odvojen (kao DeadAgentReaper.ts / StaleWatchdog.ts) jer se
 * RegocDaemon.ts ne može importati u testu — nema `import.meta.main` gate, pa bi
 * import pokrenuo cijeli daemon.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

/** Razlog koji dobiva svaki aktivan spawn kad se daemon gasi (D3, zahtjev 3). */
export const SHUTDOWN_KILL_REASON = 'daemon restart'

/** Signali koje šalje čovjek/supervizor/parent pri urednom gašenju. */
const ADMIN_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'])

/** exit = 128+n → ime signala. Pokriva ono što realno viđamo na Linuxu. */
export const SIGNAL_BY_NUMBER: Readonly<Record<number, string>> = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT',
  7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE',
  14: 'SIGALRM', 15: 'SIGTERM', 24: 'SIGXCPU', 25: 'SIGXFSZ',
}

/** Oznaka koju killAgentSpawn upiše PRIJE slanja SIGTERM-a — dokaz "mi smo ga ubili". */
export interface SpawnKillMark {
  /** Ljudski razlog, npr. "daemon restart" ili "bez heartbeata i CPU napretka 130 min". */
  reason: string
  /** Tko je naredio: 'watchdog' | 'shutdown' | 'hard-ceiling' | ... */
  by: string
  /** Epoch ms u trenutku slanja signala. */
  at: number
}

export type SpawnExitKind =
  | 'ok'                 // exit 0
  | 'killed-by-daemon'   // mi smo poslali signal (killAgentSpawn) — postoji SpawnKillMark
  | 'external-signal'    // umro od signala, a daemon ga NIJE slao → ubojica izvan daemona
  | 'self-failure'       // izašao sam, ne-nula kod, bez signala

/** Sve što znamo o jednom završenom spawnu. */
export interface SpawnExitFacts {
  agent: string
  agentName: string
  taskId: string | null
  /** PID djeteta (claude --print). */
  pid: number
  /** PID daemona = PPID djeteta. */
  ppid: number
  startTime: number
  endTime: number
  /** Bun `await proc.exited` — kod 128+n kad je proces ubijen signalom. */
  exitCode: number | null
  /** Bun `proc.signalCode` — npr. "SIGTERM", null ako je izašao sam. */
  signalCode: string | null
  stdout: string
  stderr: string
  /** Postavljen samo ako je daemon sam poslao signal. */
  killedBy?: SpawnKillMark
  /** Naredba (radi izvještaja); prompt se NE zapisuje. */
  cmd?: string[]
  /** Putanja dumpa stdout/stderr, ako je zapisan. */
  diagPath?: string | null
}

export interface SpawnExitVerdict {
  kind: SpawnExitKind
  /** Ime signala ako ga možemo utvrditi (iz signalCode ili iz 128+n). */
  signal: string | null
  durationMs: number
  /**
   * Smije li se ovo naplatiti agentu (exponential backoff + task→blocked).
   * NE smije kad smo ga mi ubili niti kad ga je administrativni signal
   * (SIGTERM/SIGINT/SIGHUP) pokosio izvana — inače restart daemona truje
   * backoff agenta koji nije ništa skrivio.
   */
  countsAsAgentFailure: boolean
  /** Kratki hrvatski opis uzroka za log i za poruku naručitelju. */
  cause: string
}

/** Ime signala iz Bun signalCode-a, ili rekonstruirano iz 128+n exit koda. */
export function signalFromExit(exitCode: number | null, signalCode: string | null): string | null {
  if (signalCode) return signalCode
  if (typeof exitCode === 'number' && exitCode > 128 && exitCode < 160) {
    return SIGNAL_BY_NUMBER[exitCode - 128] || `SIG${exitCode - 128}`
  }
  return null
}

/** Presuda: tko je ubio spawn i broji li se to agentu. */
export function classifySpawnExit(facts: SpawnExitFacts): SpawnExitVerdict {
  const signal = signalFromExit(facts.exitCode, facts.signalCode)
  const durationMs = Math.max(0, facts.endTime - facts.startTime)

  if (facts.exitCode === 0 && !facts.killedBy) {
    return { kind: 'ok', signal, durationMs, countsAsAgentFailure: false, cause: 'uredan završetak' }
  }

  if (facts.killedBy) {
    return {
      kind: 'killed-by-daemon',
      signal,
      durationMs,
      countsAsAgentFailure: false,
      cause: `ubijen od daemona (${facts.killedBy.by}): ${facts.killedBy.reason}`,
    }
  }

  if (signal) {
    const admin = ADMIN_SIGNALS.has(signal)
    return {
      kind: 'external-signal',
      signal,
      durationMs,
      // Resursna smrt (SIGKILL/OOM, SIGSEGV, SIGXCPU) JEST kvar — inače bi se
      // OOM-anje agenta vrtjelo u petlji bez backoffa.
      countsAsAgentFailure: !admin,
      cause: admin
        ? `ubijen IZVANA signalom ${signal} — daemon NIJE slao signal (traži vanjski proces: manage.sh restart, pkill, supervizor, roditelj harnessa)`
        : `nasilno prekinut signalom ${signal} (resursni limit / OOM / pad procesa)`,
    }
  }

  return {
    kind: 'self-failure',
    signal: null,
    durationMs,
    countsAsAgentFailure: true,
    cause: `proces je sam izašao s kodom ${facts.exitCode}`,
  }
}

/** Jednoredni prikaz izlaznog toka: "<prazan>" ili skraćeni citat. */
export function snip(text: string, max = 300): string {
  const t = (text || '').trim()
  if (!t) return '<prazan>'
  const oneLine = t.replace(/\s*\n+\s*/g, ' ⏎ ')
  return oneLine.length <= max
    ? `"${oneLine}"`
    : `"${oneLine.slice(0, max)}…" (+${oneLine.length - max} zn.)`
}

function secs(ms: number): string {
  return ms >= 60000 ? `${(ms / 60000).toFixed(1)}min` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * Log-linija za završen spawn. Zadržava podniz "failed (exit N" kod svih
 * neuspjeha radi kompatibilnosti s postojećim grepovima nad regoc_daemon.log.
 */
export function renderSpawnExitLog(facts: SpawnExitFacts, verdict: SpawnExitVerdict): string {
  const id = `${facts.agent}${facts.agentName && facts.agentName !== facts.agent ? ` (${facts.agentName})` : ''}`
  const sig = verdict.signal ? `signal ${verdict.signal}` : 'bez signala'
  const who =
    verdict.kind === 'killed-by-daemon' ? 'UBIJEN ZBOG NAŠE ODLUKE'
    : verdict.kind === 'external-signal' ? 'UBIJEN IZVANA'
    : 'UMRO SAM OD SEBE'

  const head = verdict.kind === 'killed-by-daemon'
    ? `🛑 Agent ${id} prekinut (exit ${facts.exitCode}, ${sig})`
    : `❌ Agent ${id} failed (exit ${facts.exitCode}, ${sig})`

  const parts = [
    `${head} — ${who}: ${verdict.cause}`,
    `task=${facts.taskId || 'N/A'}`,
    `pid=${facts.pid || '?'}`,
    `ppid=${facts.ppid}`,
    `trajanje=${secs(verdict.durationMs)}`,
    `backoff=${verdict.countsAsAgentFailure ? 'DA' : 'NE'}`,
    `stderr=${snip(facts.stderr, 200)}`,
    `stdout=${snip(facts.stdout, 200)}`,
  ]
  if (facts.diagPath) parts.push(`diag=${facts.diagPath}`)
  return parts.join(' · ')
}

/** Naziv datoteke dumpa — sortabilan po vremenu, bez znakova problematičnih za FS. */
export function spawnDiagFileName(facts: SpawnExitFacts): string {
  const stamp = new Date(facts.startTime).toISOString().replace(/[:.]/g, '-')
  return `${stamp}_${facts.agent}_${facts.taskId || 'noTask'}_pid${facts.pid || 0}.log`
}

/** Puni izvještaj koji ide u dijagnostičku datoteku (stdout+stderr u cijelosti). */
/**
 * Naredba za dump: svaki argument koji NOSI TEKST zamijenjen je oznakom, ostalo ostaje.
 *
 * I9/TASK-3658: dosad je bio pokriven samo `-p`. Otkad identitet ide kroz
 * `--append-system-prompt` (I2/TASK-3651), i taj argument nosi 2000+ znakova sadržaja,
 * pa bi bez ovoga cijeli blok završio u `~/.tmp/regoc_spawn_diag` (mapa 775) —
 * točno ono što `-p` redakcija sprječava. Popis je zato ZAJEDNIČKI, da sljedeći
 * tekstualni argument ne ponovi istu rupu.
 */
export const ARGUMENTI_S_TEKSTOM = new Set(['-p', '--prompt', '--append-system-prompt', '--system-prompt'])

export function redactSpawnCmd(cmdArgs: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < cmdArgs.length; i++) {
    out.push(cmdArgs[i])
    if (ARGUMENTI_S_TEKSTOM.has(cmdArgs[i]) && i + 1 < cmdArgs.length) {
      out.push(`<${cmdArgs[i]} ${cmdArgs[i + 1].length} zn. izostavljen>`)
      i++
    }
  }
  return out
}

export function renderSpawnDiagnostics(facts: SpawnExitFacts, verdict: SpawnExitVerdict): string {
  const L: string[] = []
  L.push('═══ REGOČ spawn exit diagnostics (TASK-2955) ═══')
  L.push(`agent:        ${facts.agent} (${facts.agentName})`)
  L.push(`task:         ${facts.taskId || 'N/A'}`)
  L.push(`pid:          ${facts.pid}`)
  L.push(`ppid(daemon): ${facts.ppid}`)
  L.push(`start:        ${new Date(facts.startTime).toISOString()}`)
  L.push(`end:          ${new Date(facts.endTime).toISOString()}`)
  L.push(`trajanje:     ${secs(verdict.durationMs)} (${verdict.durationMs} ms)`)
  L.push(`exitCode:     ${facts.exitCode}`)
  L.push(`signalCode:   ${facts.signalCode ?? '(null)'}`)
  L.push(`signal:       ${verdict.signal ?? '(nema)'}`)
  L.push(`klasifikacija:${verdict.kind}`)
  L.push(`uzrok:        ${verdict.cause}`)
  L.push(`backoff:      ${verdict.countsAsAgentFailure ? 'primjenjuje se' : 'NE primjenjuje se'}`)
  if (facts.killedBy) {
    L.push(`killedBy:     ${facts.killedBy.by} @ ${new Date(facts.killedBy.at).toISOString()} — ${facts.killedBy.reason}`)
  } else {
    L.push('killedBy:     (daemon nije slao signal ovom procesu)')
  }
  if (facts.cmd) L.push(`cmd:          ${facts.cmd.join(' ')}`)
  L.push('')
  L.push(`─── STDERR (${facts.stderr.length} zn.) ───`)
  L.push(facts.stderr.length ? facts.stderr : '(prazno)')
  L.push('')
  L.push(`─── STDOUT (${facts.stdout.length} zn.) ───`)
  L.push(facts.stdout.length ? facts.stdout : '(prazno)')
  L.push('')
  return L.join('\n')
}

/**
 * Zapiši puni dump (stdout+stderr+identifikatori) u `dir` i vrati putanju.
 * Log-linija nosi samo sažetak — cijeli tekst mora ostati negdje, inače se opet
 * vraćamo na "failed (exit 143): " bez ijednog znaka dokaza.
 * Vraća null ako upis ne uspije (dijagnostika nikad ne smije srušiti daemon).
 */
export function writeSpawnDiagnostics(
  dir: string,
  facts: SpawnExitFacts,
  verdict: SpawnExitVerdict,
  keep = 200,
): string | null {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, spawnDiagFileName(facts))
    writeFileSync(path, renderSpawnDiagnostics(facts, verdict))
    pruneSpawnDiagnostics(dir, keep)
    return path
  } catch {
    return null
  }
}

/** Zadrži najnovijih `keep` dumpova (naziv počinje ISO vremenom → sort = kronologija). */
export function pruneSpawnDiagnostics(dir: string, keep = 200): number {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.log')).sort()
    const doomed = files.slice(0, Math.max(0, files.length - keep))
    for (const f of doomed) {
      try { unlinkSync(join(dir, f)) } catch {}
    }
    return doomed.length
  } catch {
    return 0
  }
}
