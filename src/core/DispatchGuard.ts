/**
 * DispatchGuard — pre-delegation guard for the REGOČ dispatcher (RegocDaemon).
 *
 * Addresses the repeatedly-flagged concern (TASK-627→629→631→633→634→637→638 chain):
 *   (a) Empty "liveness" tasks — where a task's "specification" is itself a recycled
 *       REGOČ agent report (📋 SUMMARY / 🔍 ANALYSIS / ⚡ ACTIONS ...), not real work.
 *   (b) Double-dispatch — the same content delegated to two agents in a short window.
 *
 * Pure, side-effect-free logic so it is unit-testable in isolation from the daemon.
 * The daemon owns the single dispatch point, so an in-memory hash window is sufficient.
 */

/** REGOČ CORE response-format section markers (from skills/CORE/SKILL.md).
 * Covers both the full English format (SUMMARY/ANALYSIS/...) and the shorter
 * Croatian REZULTAT/STATUS/SLJEDEĆI KORACI variant used in agent task replies. */
const REPORT_MARKERS: RegExp[] = [
  /📋\s*SUMMARY/u,
  /🔍\s*ANALYSIS/u,
  /⚡\s*ACTIONS/u,
  /✅\s*RESULTS/u,
  /📊\s*STATUS/u,
  /📁\s*CAPTURE/u,
  /➡️?\s*NEXT/u,
  /📖\s*STORY\s*EXPLANATION/u,
  /⭐\s*RATE/u,
  /📋\s*REZULTAT/u,
  /➡️?\s*SLJEDE[ĆC]I\s*KORAC/u,
]

/**
 * Daemon lifecycle / system notices that are NEVER an actionable task spec.
 * These get routed into agent inboxes as ordinary 'text' messages and, without
 * this check, the consuming AgentDaemon would spawn a `claude --print` on them —
 * the echo loop (agent-started / agent-finished / dedup-block bouncing forever).
 * A single match is decisive (unlike report markers, which need a quorum).
 */
const LIFECYCLE_PATTERNS: RegExp[] = [
  /✅\s*\*{0,2}\s*Agent\b[^\n]*\bpokrenut/u,                 // "✅ **Agent X pokrenut**"
  /✅\s*\*{0,2}[^\n*]+\*{0,2}\s+zavr[šs](io|ila)\s+zadatak/u, // "✅ **X** završio/završila zadatak"
  /🛑\s*\*{0,2}\s*Delegacija\s+blokirana/u,                  // dedup-guard block notice echoed back
  // TASK-2583: daemonove VLASTITE statusne poruke. RegocDaemon ih prepoznaje na
  // svom putu (RegocDaemon.ts:2680) ali AgentDaemon nije — pa je potjeh
  // 2026-07-28 10:39:52 potrošio `claude --print` na "slotovi zauzeti" i
  // odgovorio "Nema aktivnog zadatka", što je prvi krug echo petlje.
  // Sidrene su na POČETAK poruke da spec koji te obavijesti samo OPISUJE prođe.
  /^\s*⏳\s*Svi agent slotovi zauzeti/u,                      // capacity notice bounced into an inbox
  /^\s*Greška pri obradi zahtjeva/u,                          // daemon's own error notice
  /^\s*❌\s*\*{0,2}\s*Agent\b[^\n]*neuspješan/u,              // agent-failed notice
  /^\s*🤖\s*\*{0,2}REGOČ Daemon Status/u,                     // daemon status dump (RegocDaemon.ts:1646)
  // TASK-2953: obavijest da je hook zaustavio spawn na ulazu. Sam tekst blokade
  // nosi razlog, ne specifikaciju — bez ovoga bi ga inbox potrošio kao "novi zadatak".
  /^\s*⛔\s*\*{0,2}[^\n*]+\*{0,2}\s*—\s*zadatak[^\n]*nije ni započet/u,
]

/**
 * TASK-2701: doslovni naslovi fixtura iz `regoc/tests/*.test.ts`. Kad test-suite
 * instancira TaskManager bez vlastite baze, ovi zapisi zavrse u zivoj regoc.db i
 * P1 auto-exec ih spawna kao prave zadatke (incident 2026-07-27 22:42: 70 fixtura
 * po test-runu → paralelne Opus sesije nad praznim "Full Task / Detailed description").
 * Namjerno je popis DOSLOVAN (cijeli naslov, ne podniz) da pravi task s rijeci
 * "test" u naslovu ne padne pod filter.
 */
const FIXTURE_TITLE =
  /^(task|test|test task|full task|blocker|blocked|blocked task|pending|in progress|updated title|start me|task to start|note me|find me|delete me|complete me|unblock me|block me|jelenas task|my task|new task|sample task|dummy)\s*\d*$/iu

/** Naslovi eksplicitno oznaceni kao privremeni/za brisanje. */
const DISPOSABLE_TITLE = /(\[TEST-|\(obrisati\)|\(delete\b)/iu

/** Opisi koji su placeholder, ne specifikacija. */
const PLACEHOLDER_DESCRIPTION =
  /^(detailed description|new description|description|opis|test|todo|tbd|n\/a|-{1,3}|\.+)$/iu

/**
 * True kad task nema izvrsivog sadrzaja: prazan/placeholder description, doslovni
 * naslov test-fixtura ili naslov oznacen kao privremen. Pravilo "task description
 * OBAVEZAN" ovime postaje strojno provedeno — takav task se NE dispatcha.
 */
export function isEmptyOrFixtureTask(title?: string | null, description?: string | null): boolean {
  const t = (title || '').trim()
  const d = (description || '').trim()
  if (!t) return true
  if (!d) return true
  if (PLACEHOLDER_DESCRIPTION.test(d)) return true
  if (FIXTURE_TITLE.test(t)) return true
  if (DISPOSABLE_TITLE.test(t)) return true
  return false
}

/** Number of distinct report markers above which content is treated as a recycled report. */
export const RECYCLED_REPORT_MARKER_THRESHOLD = 3

/** Dedup window for identical content delegated to (any) agent. */
export const DISPATCH_DEDUP_WINDOW_MS = 15 * 60 * 1000 // 15 min

/**
 * True when `content` is itself a formatted REGOČ agent report rather than an
 * actionable task specification (the "empty liveness link" pattern).
 */
export function isRecycledAgentReport(content: string): boolean {
  if (!content) return false
  let hits = 0
  for (const m of REPORT_MARKERS) {
    if (m.test(content)) hits++
    if (hits >= RECYCLED_REPORT_MARKER_THRESHOLD) return true
  }
  return false
}

/**
 * True when `content` is a daemon lifecycle/system notice (agent started,
 * agent finished, delegation blocked) rather than a task specification.
 * A single pattern match is decisive.
 */
export function isAgentLifecycleNotice(content: string): boolean {
  if (!content) return false
  return LIFECYCLE_PATTERNS.some((p) => p.test(content))
}

/** Either a recycled report (≥3 format markers) or a lifecycle/system notice. */
export function isNonActionableMessage(content: string): boolean {
  return isRecycledAgentReport(content) || isAgentLifecycleNotice(content)
}

/**
 * Normalize content for dedup: strip the daemon-added wrapper, collapse whitespace,
 * lowercase. Two delegations of the same payload hash identically even if the
 * "Originalni zahtjev od: X" header names a different source agent.
 */
export function normalizeForDedup(content: string): string {
  return content
    .replace(/##\s*Originalni zahtjev od:\s*\S+/giu, '')
    .replace(/\*\*Za[šs]to:?\*\*.*$/gisu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

/** Stable djb2 string hash (hex). Cheap, no crypto dependency. */
export function hashContent(content: string): string {
  const norm = normalizeForDedup(content)
  let h = 5381
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16)
}

export interface DispatchRecord {
  taskId: string | null
  agent: string
  ts: number
}

export interface GuardVerdict {
  block: boolean
  reason: string
  /** Machine code for logging/telemetry. */
  code: 'ok' | 'recycled_report' | 'duplicate_dispatch'
  /** For duplicates: the prior dispatch that matched. */
  prior?: DispatchRecord
}

/**
 * Decide whether a delegation should be blocked.
 *
 * @param content     the originalContent that would become the task description
 * @param seen        in-memory map of contentHash → most-recent dispatch
 * @param nowMs       current timestamp (injected for testability)
 * @param windowMs    dedup window
 */
export function evaluateDispatch(
  content: string,
  seen: Map<string, DispatchRecord>,
  nowMs: number,
  windowMs: number = DISPATCH_DEDUP_WINDOW_MS,
): GuardVerdict {
  if (isRecycledAgentReport(content)) {
    return {
      block: true,
      code: 'recycled_report',
      reason:
        'Sadržaj zadatka je recikliran REGOČ izvještaj (≥3 format-markera), ne specifikacija — prazan liveness-link.',
    }
  }

  const hash = hashContent(content)
  const prior = seen.get(hash)
  if (prior && nowMs - prior.ts < windowMs) {
    return {
      block: true,
      code: 'duplicate_dispatch',
      reason: `Identičan sadržaj već dispatchan agentu '${prior.agent}' (task ${prior.taskId ?? 'N/A'}) prije ${Math.round(
        (nowMs - prior.ts) / 1000,
      )}s.`,
      prior,
    }
  }

  return { block: false, code: 'ok', reason: 'ok' }
}

/** Record a successful dispatch so future identical content within the window is caught. */
export function recordDispatch(
  content: string,
  rec: DispatchRecord,
  seen: Map<string, DispatchRecord>,
): void {
  seen.set(hashContent(content), rec)
}
