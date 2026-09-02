/**
 * SessionUsage — potrošnja tekuće Claude sesije za konzolu TaskWebUI-ja (TASK-2694)
 *
 * Izvor istine je `~/app/regoc_system/tools/session_usage.py` (probe na
 * api.anthropic.com → rate-limit headeri). Ovdje NE dupliciramo taj mehanizam:
 *   1. keš u memoriji procesa (najjeftinije),
 *   2. `session_usage.cache.json` koji pišu Stop/UserPromptSubmit hookovi,
 *   3. tek ako je oboje starije od praga → svjež probe (`--json --no-log`).
 *
 * Probe se ne logira u `session_usage.jsonl` (`--no-log`) da povijest potrošnje
 * ostane zapis stvarnih sesijskih koraka, a ne UI pollinga svake minute.
 */
import { join } from 'path'

const HOME = process.env.HOME || '/home/klaudio'

export const SESSION_USAGE_CACHE_FILE = join(HOME, '.claude/regoc/data/session_usage.cache.json')
export const SESSION_USAGE_SCRIPT = join(HOME, 'app/regoc_system/tools/session_usage.py')

/** Redovno osvježavanje: UI pita svakih 60 s, probe najviše jednom u minuti. */
export const SESSION_USAGE_TTL_MS = 60_000
/** Donji prag za `force` (I/O u konzoli) — brana od bujice probeova. */
export const SESSION_USAGE_MIN_PROBE_MS = 10_000
/** Probe ide preko mreže; radije stara vrijednost nego zaglavljen zahtjev. */
export const SESSION_USAGE_PROBE_TIMEOUT_MS = 20_000

const WARN_PERCENT = 70
const CRIT_PERCENT = 90

export interface UsageEntry {
  ts?: string
  session_percent: number | null
  weekly_percent: number | null
  session_reset_at?: string | null
  weekly_reset_at?: string | null
  status?: string | null
  overage_status?: string | null
  fallback_model?: string | null
  http_error?: string | null
}

export type UsageLevel = 'ok' | 'warn' | 'crit' | 'unknown'
export type UsageSource = 'memory' | 'cache' | 'probe' | 'none'

export interface UsagePayload {
  available: boolean
  sessionPercent: number | null
  weeklyPercent: number | null
  sessionResetAt: string | null
  weeklyResetAt: string | null
  status: string | null
  level: UsageLevel
  source: UsageSource
  ageMs: number
  stale: boolean
  measuredAt: string | null
  error: string | null
}

export interface UsageState {
  entry?: UsageEntry
  cachedAtMs?: number
  inflight?: Promise<UsageEntry> | null
}

export interface UsageDeps {
  readCache: () => Promise<string>
  runProbe: () => Promise<string>
  now: () => number
  state: UsageState
}

/** Keš koji pišu hookovi: `{cached_at: <epoch s>, entry: {...}}`. */
export function parseCacheFile(text: string): { entry: UsageEntry; cachedAtMs: number } | null {
  if (!text || !text.trim()) return null
  try {
    const raw = JSON.parse(text)
    const entry = raw?.entry
    const cachedAt = Number(raw?.cached_at)
    if (!entry || typeof entry !== 'object') return null
    if (!Number.isFinite(cachedAt)) return null
    if (!('session_percent' in entry)) return null
    return { entry: entry as UsageEntry, cachedAtMs: cachedAt * 1000 }
  } catch {
    return null
  }
}

/** stdout `session_usage.py --json`; podnosi vodeći šum (upozorenja i sl.). */
export function parseProbeOutput(stdout: string): UsageEntry | null {
  if (!stdout) return null
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const entry = JSON.parse(stdout.slice(start, end + 1))
    if (!entry || typeof entry !== 'object' || !('session_percent' in entry)) return null
    return entry as UsageEntry
  } catch {
    return null
  }
}

export function usageLevel(percent: number | null | undefined): UsageLevel {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'unknown'
  if (percent >= CRIT_PERCENT) return 'crit'
  if (percent >= WARN_PERCENT) return 'warn'
  return 'ok'
}

export function buildPayload(
  entry: UsageEntry,
  cachedAtMs: number,
  source: UsageSource,
  nowMs: number,
  extra: { stale?: boolean; error?: string | null } = {}
): UsagePayload {
  const sp = entry.session_percent ?? null
  return {
    available: sp !== null && !entry.http_error,
    sessionPercent: sp,
    weeklyPercent: entry.weekly_percent ?? null,
    sessionResetAt: entry.session_reset_at ?? null,
    weeklyResetAt: entry.weekly_reset_at ?? null,
    status: entry.status ?? null,
    level: usageLevel(sp),
    source,
    ageMs: Math.max(0, nowMs - cachedAtMs),
    stale: extra.stale ?? false,
    measuredAt: entry.ts ?? null,
    error: extra.error ?? entry.http_error ?? null,
  }
}

function emptyPayload(nowMs: number, error: string | null): UsagePayload {
  return {
    available: false,
    sessionPercent: null,
    weeklyPercent: null,
    sessionResetAt: null,
    weeklyResetAt: null,
    status: null,
    level: 'unknown',
    source: 'none',
    ageMs: 0,
    stale: true,
    measuredAt: null,
    error,
  }
}

/**
 * Vrati stanje potrošnje uz najmanji mogući trošak.
 * `force` (I/O u konzoli) samo skraćuje prag svježine na MIN_PROBE_MS —
 * nikad ne zaobilazi zaštitu, jer svaki probe je HTTP poziv na Anthropic.
 */
export async function resolveSessionUsage(
  opts: { force?: boolean },
  deps: UsageDeps
): Promise<UsagePayload> {
  const now = deps.now()
  const threshold = opts.force ? SESSION_USAGE_MIN_PROBE_MS : SESSION_USAGE_TTL_MS
  const state = deps.state

  // 1) memorija
  let best: { entry: UsageEntry; cachedAtMs: number; source: UsageSource } | null =
    state.entry && Number.isFinite(state.cachedAtMs)
      ? { entry: state.entry, cachedAtMs: state.cachedAtMs!, source: 'memory' }
      : null

  // 2) datotečni keš (hookovi ga osvježavaju nakon svake poruke)
  try {
    const fromFile = parseCacheFile(await deps.readCache())
    if (fromFile && (!best || fromFile.cachedAtMs > best.cachedAtMs)) {
      best = { ...fromFile, source: 'cache' }
    }
  } catch {
    // keš nije obavezan
  }

  if (best && now - best.cachedAtMs < threshold) {
    return buildPayload(best.entry, best.cachedAtMs, best.source, now)
  }

  // 3) svjež probe — istovremeni pozivi dijele isti proces
  try {
    if (!state.inflight) {
      state.inflight = (async () => {
        const stdout = await deps.runProbe()
        const entry = parseProbeOutput(stdout)
        if (!entry) throw new Error('session_usage.py nije vratio ispravan JSON')
        return entry
      })().finally(() => { state.inflight = null })
    }
    const entry = await state.inflight
    const probedAt = deps.now()
    state.entry = entry
    state.cachedAtMs = probedAt
    return buildPayload(entry, probedAt, 'probe', probedAt)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (best) return buildPayload(best.entry, best.cachedAtMs, best.source, deps.now(), { stale: true, error: msg })
    return emptyPayload(deps.now(), msg)
  }
}

/** Produkcijske ovisnosti: datotečni keš + `session_usage.py --json --no-log`. */
export function createDefaultDeps(state: UsageState): UsageDeps {
  return {
    readCache: () => Bun.file(SESSION_USAGE_CACHE_FILE).text(),
    runProbe: async () => {
      const proc = Bun.spawn(['python3', SESSION_USAGE_SCRIPT, '--json', '--no-log'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          HOME,
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
        },
      })
      const timer = setTimeout(() => { try { proc.kill() } catch {} }, SESSION_USAGE_PROBE_TIMEOUT_MS)
      try {
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ])
        if (exitCode !== 0) {
          const stderr = (await new Response(proc.stderr).text()).trim()
          throw new Error(`session_usage.py exit ${exitCode}${stderr ? ': ' + stderr.slice(0, 200) : ''}`)
        }
        return stdout
      } finally {
        clearTimeout(timer)
      }
    },
    now: () => Date.now(),
    state,
  }
}
