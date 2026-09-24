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

import { MARKER_VOCAB, freeMarkerRe } from './AgentOutputParser'

/** REGOČ CORE response-format section markers (from skills/CORE/SKILL.md).
 * Covers both the full English format (SUMMARY/ANALYSIS/...) and the shorter
 * Croatian REZULTAT/STATUS/SLJEDEĆI KORACI variant used in agent task replies.
 *
 * TASK-4815: popis markera više ne živi ovdje nego u `AgentOutputParser.MARKER_VOCAB`.
 * Dijeli se RJEČNIK, a ne gotov uzorak (§F revizije TASK-4814): ovdašnji uzorci su
 * NAMJERNO NESIDRENI — posao im je naći format bilo gdje u tekstu (reciklirani
 * izvještaj), dok parser traži zaglavlje na početku retka (pravilo P1). Isti izraz
 * ne može služiti obojici; isti popis riječi može, i mora. */
const REPORT_MARKERS: RegExp[] = MARKER_VOCAB.map(freeMarkerRe)

/**
 * TASK-3589: markeri MINIMALNOG CORE formata.
 *
 * Dvije neovisne rupe propustile su 02.09.2026. kosjenkin odgovor
 * („📋 **SUMMARY:** Sesija je resumirana … 🗣️ **Kosjenka:** …") kroz ingress
 * TaskWebUI-a i otvorile TASK-3589 → 3590 → 3619 nad vlastitim izvještajem:
 *
 *  (1) EMPHASIS: `REPORT_MARKERS` su dopuštali samo razmak između emojija i
 *      ključne riječi (`📋\s*SUMMARY`), a agenti u praksi pišu podebljano
 *      (`📋 **SUMMARY:**`). Mjereno u daemon.log 02.09.2026.: 16 podebljanih
 *      naspram 5 običnih — promašivan je VEĆINSKI oblik. Zato `[\s*_]*` gore.
 *
 *  (2) PRAG: CORE „Minimal Format" (skills/CORE/SKILL.md) ima točno DVA retka —
 *      `📋 SUMMARY:` i `🗣️ <Ime>:`. Uz prag od 3 markera takav izvještaj NIKAD
 *      ne može biti prepoznat, koliko god markeri bili točni. Zato je par
 *      SUMMARY+govorna-linija odlučan sam za sebe.
 *
 * Govorna linija (`🗣️ Ime:`) je potpis AGENTOVOG odgovora, ne specifikacije.
 * Mjereno nad živom regoc.db (1349 zadataka): par se pojavljuje u 11 zapisa i
 * svih 11 su poznati echo-artefakti (629/631/637, 2422–2427, 3589/3590/3619) —
 * nula lažnih pozitiva; stari `isRecycledAgentReport` hvatao je samo 5 od 11.
 */
const CORE_SUMMARY_MARKER = /📋[\s*_]*(?:SUMMARY|REZULTAT)/u
const CORE_SPOKEN_LINE_MARKER = /🗣️?[\s*_]*[^\n*:]{1,40}\**\s*:/u

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
  // TASK-3610: RegocDaemonova VLASTITA odbijenica (RegocDaemon.ts:4097). Guard je
  // bio samohranjiv: regoc odbije poruku → pošalje ovu obavijest agentu → agentov
  // inbox je NE prepoznaje → spawn → hook blokira ulaz → '❌ Agent neuspješan'
  // natrag regoču → nova odbijenica. Mjereno 02.09.2026.: 683 spawna u 1 h 43 min
  // (svakih ~9 s). Sidro je na početak da spec koji odbijenicu citira prođe.
  /^\s*🛑\s*Poruka prepoznata kao završni izvještaj/u,
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
  return emptyOrFixtureReason(title, description) !== null
}

/**
 * TASK-3627: strojni RAZLOG zbog kojeg zadatak nema izvrsivog sadrzaja, ili `null`
 * kad ga ima. `isEmptyOrFixtureTask` je samo boolean projekcija ove funkcije —
 * jedan izvor istine za DVA potrosaca:
 *   - RegocDaemon (dispatch): zanima ga samo da/ne;
 *   - TaskWebUI ingress (POST /api/tasks): mora VRATITI razlog u 422 tijelu, jer
 *     onaj tko posalje prazan zadatak inace ne zna sto da popravi.
 *
 * Do 02.09.2026. vrata su stajala samo na dispatchu, pa je `POST /api/tasks` s
 * `description: ""` vracao 201 (probni TASK-3620/3621) — pravilo „task description
 * OBAVEZAN" (Goran, TASK-2406) nije bilo strojno provedeno na ULAZU, samo pri
 * pokretanju agenta. Rupa je ista kao TASK-2701: prazan zapis kasnije spawna
 * pravu Opus sesiju nad nicim.
 */
export type EmptyTaskReason =
  | 'empty_title'
  | 'empty_description'
  | 'placeholder_description'
  | 'fixture_title'
  | 'disposable_title'

export function emptyOrFixtureReason(
  title?: string | null,
  description?: string | null,
): EmptyTaskReason | null {
  const t = (title || '').trim()
  const d = (description || '').trim()
  if (!t) return 'empty_title'
  if (!d) return 'empty_description'
  if (PLACEHOLDER_DESCRIPTION.test(d)) return 'placeholder_description'
  if (FIXTURE_TITLE.test(t)) return 'fixture_title'
  if (DISPOSABLE_TITLE.test(t)) return 'disposable_title'
  return null
}

/** Ljudsko objasnjenje razloga — ide u 422 tijelo, da posiljatelj zna sto ispraviti. */
export const EMPTY_TASK_REASON_TEXT: Record<EmptyTaskReason, string> = {
  empty_title: 'Zadatak nema naslov.',
  empty_description:
    'Zadatak nema opis. Pravilo „task description OBAVEZAN": posalji ŠTO / ZAŠTO / KOJI fajlovi / KRITERIJ za done. Naslov sam nije specifikacija — agent bi dobio zadatak bez sadrzaja.',
  placeholder_description:
    'Opis je rezervirano mjesto ("description", "TBD", "test", "-"), ne specifikacija.',
  fixture_title: 'Naslov je doslovni test-fixture ("Task 1", "Critical Task", …), ne stvarni zadatak.',
  disposable_title: 'Naslov je oznacen kao privremen ([TEST-…], (obrisati)).',
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
  // Minimalni CORE format (📋 SUMMARY + 🗣️ Ime:) je odlučan par — vidi TASK-3589.
  if (CORE_SUMMARY_MARKER.test(content) && CORE_SPOKEN_LINE_MARKER.test(content)) return true
  let hits = 0
  for (const m of REPORT_MARKERS) {
    if (m.test(content)) hits++
    if (hits >= RECYCLED_REPORT_MARKER_THRESHOLD) return true
  }
  return false
}

/**
 * TASK-3605: markeri AGENTOVOG ZAVRŠNOG IZVJEŠTAJA koji NE koristi CORE format.
 *
 * `REPORT_MARKERS` gore hvata samo izvještaje pisane emoji-formatom
 * (📋 SUMMARY / 📊 STATUS / 📋 REZULTAT …). Živi kvar 02.09.2026. 11:30:15:
 * kosjenkin završni odgovor na TASK-3587 bio je OBIČAN engleski markdown
 * ("Done. Summary of TASK-3587 …", "**Completed:**", numerirana lista) —
 * nula emoji-markera → `isRecycledAgentReport` = false → RegocDaemon ga je
 * klasificirao kao E5 i otvorio TASK-3605 nad vlastitim izvještajem.
 * (daemon.log: "🎯 Delegating to kosjenka: Arhitektura: Done. Summary of TASK-3587…")
 *
 * Uzorci su SIDRENI (početak sadržaja ili početak retka) da specifikacija koja
 * izvještaj samo CITIRA ili opisuje protokol ne padne pod filter — isti oprez
 * kao kod LIFECYCLE_PATTERNS (usp. SPEC_QUOTING_STATUS u testovima).
 */
const COMPLETION_REPORT_MARKERS: RegExp[] = [
  // Otvaranje porukom o dovršenosti: "Done.", "Gotovo —", "✅ Završeno:"
  /^\s*(?:✅\s*)?\**(?:Done|Gotovo|Zavr[šs]eno|Completed)\**\s*[.!:—-]/u,
  // Strojna deklaracija ishoda koju agent MORA ispisati na kraju odgovora
  /^[ \t]*\**REGOC-STATUS:\**\s*(?:DONE|BLOCKED|NEEDS_CONTEXT)\b/mu,
  // Naslov popisa isporučenog ("**Completed:**", "**Napravljeno:**")
  /^[ \t]*\*{0,2}(?:Completed|Napravljeno|Isporu[čc]eno)\*{0,2}\s*:?\s*\*{0,2}[ \t]*$/miu,
  // Referenca na izvještaj o KONKRETNOM zadatku ("Summary of TASK-3587")
  /\b(?:Summary|Sa[žz]etak)\s+(?:of\s+)?TASK-\d+/iu,
]

/** Koliko sidrenih markera čini sadržaj završnim izvještajem (a ne specifikacijom). */
export const COMPLETION_REPORT_MARKER_THRESHOLD = 2

/**
 * True kad je `content` agentov ZAVRŠNI IZVJEŠTAJ (bez CORE emoji-formata) —
 * dakle zapis već obavljenog posla, ne specifikacija novog. Prag je 2 sidrena
 * markera: jedan sam po sebi (npr. spec koji spominje REGOC-STATUS) ne blokira.
 */
export function isCompletionReport(content: string): boolean {
  if (!content) return false
  let hits = 0
  for (const m of COMPLETION_REPORT_MARKERS) {
    if (m.test(content)) hits++
    if (hits >= COMPLETION_REPORT_MARKER_THRESHOLD) return true
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

/**
 * TASK-4753: SCHEDULER-DOJAVA O DOVRŠENOM ZADATKU I PRAZNOM REDU.
 *
 * Živi kvar 07.09.2026. 19:18: RegocScheduler je u 1,3 s stvorio TASK-4742…TASK-4751
 * iz replaya starih dojava iz veljače 2026. Sadržaj svakoga je doslovno
 *
 *     Task TASK-F8-00N COMPLETED: <naslov>
 *     No more unblocked tasks in queue.
 *
 * — dakle obavijest da je posao GOTOV i da reda više nema, ne specifikacija novog
 * posla. Mjereno na tom sadržaju: `isRecycledAgentReport` (nema emoji-markera),
 * `isCompletionReport` (sidra traže "Done."/REGOC-STATUS/"Summary of TASK-…"),
 * `isAgentLifecycleNotice` (sidra na ✅/🛑/⏳) i time `isNonActionableMessage` —
 * sva četiri false → `evaluateDispatch` pušta → auto-exec spawna prave Opus sesije
 * (manda ×7, jelena, grga) nad nepostojećim poslom. Isti obrazac je u veljači već
 * proizveo TASK-359/360/361 (svi cancelled) — 3. pojava klase (usp. TASK-2971, 3608).
 *
 * DISKRIMINATOR JE STRUKTURA, NE FRAZA. Puko traženje fraze bi oborilo i opis OVOG
 * zadatka, koji obje rečenice doslovno citira kao dokaz (isti oprez kao
 * SPEC_QUOTING_STATUS kod LIFECYCLE_PATTERNS). Zato: skini daemonov omot
 * ("## Originalni zahtjev od: …", "**Zašto:** …", vodoravne crte) pa zahtijevaj da
 * SVAKI preostali redak tijela bude redak dojave. Specifikacija koja dojavu citira
 * uvijek nosi i drugi sadržaj → prolazi.
 */
const SCHEDULER_COMPLETED_LINE = /^\**\s*Task\s+TASK-[A-Za-z0-9._-]+\s+COMPLETED\b/iu
const SCHEDULER_QUEUE_EMPTY_LINE =
  /^\**\s*(?:No more unblocked tasks in queue|Queue\s+(?:is\s+)?empty|Nema\s+(?:vi[šs]e\s+)?odblokiranih\s+zadataka)\b/iu

/** Tijelo poruke bez daemonovog omota: samo redci koji nose sadržaj. */
function schedulerNoticeBodyLines(content: string): string[] {
  return content
    .replace(/^[ \t]*##\s*Originalni zahtjev od:.*$/gimu, '')
    .replace(/\*\*Za[šs]to:?\*\*[\s\S]*$/iu, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-–—*_=]{3,}$/u.test(l))
}

/**
 * True kad je `content` U CIJELOSTI scheduler-dojava o dovršenom zadatku i/ili
 * praznom redu čekanja. Jedan jedini redak s drugim sadržajem poništava sud —
 * tako spec koji dojavu citira ili opisuje ostaje izvršiv.
 */
export function isSchedulerQueueNotice(content: string): boolean {
  if (!content) return false
  const lines = schedulerNoticeBodyLines(content)
  if (lines.length === 0) return false
  for (const line of lines) {
    if (!SCHEDULER_COMPLETED_LINE.test(line) && !SCHEDULER_QUEUE_EMPTY_LINE.test(line)) return false
  }
  return true
}

/**
 * metadata.type vrijednosti koje emitira ISKLJUČIVO TaskSchedulerIntegration
 * (`notifyTaskCompletion` → task_completion/task_notification, `notifyTaskAutoStart`
 * → task_assignment). Provjereno grepom nad cijelom živom instalacijom: nijedan drugi
 * pošiljatelj ne piše ključ `type` s tim vrijednostima (RegocClient koristi
 * `reportType`, drugi ključ).
 */
export const SCHEDULER_METADATA_TYPES = new Set([
  'task_completion',
  'task_notification',
  'task_assignment',
])

/** Minimalni oblik poruke iz messages.db koji sud treba — i RegocDaemon i AgentDaemon ga imaju. */
export interface InboundMessageShape {
  from_agent?: string | null
  metadata?: string | Record<string, unknown> | null
  content?: string | null
}

/** metadata je u bazi TEXT (JSON) — ali testovi i pozivatelji smiju dati i objekt. */
function parseMetadata(meta: InboundMessageShape['metadata']): Record<string, unknown> | null {
  if (!meta) return null
  if (typeof meta === 'object') return meta as Record<string, unknown>
  try {
    const parsed = JSON.parse(meta)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * STRUKTURNI sud (TASK-4752): je li poruka strojna dojava schedulera?
 *
 * ZAŠTO NE PO TEKSTU: `isSchedulerQueueNotice` (TASK-4753) sudi po frazama i nad
 * živim korpusom (messages.db, 303 poruke from_agent='scheduler') hvata 162, a
 * promašuje 141 — svaki `AUTO-START: TASK-… \nAssignee: …\nPriority: …` (33 puta
 * poslan u regoc red S METADATA=NULL) i svaku dojavu koja uz dovršenje nosi i redak
 * `Next unblocked: …`. Tekst dojave je varijabilan; PODRIJETLO nije.
 *
 * Dva neovisna sidra, oba strukturna:
 *   1. from_agent === 'scheduler' — 'scheduler' nije agent nego proces; u REGOČ-u
 *      jedini pošiljatelj pod tim imenom je TaskSchedulerIntegration. Podudaranje je
 *      CIJELO ime (ne prefiks), da 'scheduler-ui' ne bi dobio isti tretman.
 *   2. metadata.type ∈ SCHEDULER_METADATA_TYPES — hvata dojavu i ako je proslijeđena
 *      pod drugim imenom pošiljatelja.
 *
 * Namjerno NE gleda `content`: spec koja CITIRA dojavu (npr. opis ovog zadatka)
 * mora proći.
 */
export function isSchedulerNotification(msg: InboundMessageShape | null | undefined): boolean {
  if (!msg) return false
  if (typeof msg.from_agent === 'string' && msg.from_agent.trim().toLowerCase() === 'scheduler') {
    return true
  }
  const type = parseMetadata(msg.metadata)?.type
  return typeof type === 'string' && SCHEDULER_METADATA_TYPES.has(type)
}

/**
 * Either a recycled CORE-format report (≥3 emoji markers), a plain-text
 * completion report (≥2 anchored markers, TASK-3605), a lifecycle/system notice,
 * or a scheduler queue notice (TASK-4753).
 */
export function isNonActionableMessage(content: string): boolean {
  return (
    isRecycledAgentReport(content) ||
    isCompletionReport(content) ||
    isAgentLifecycleNotice(content) ||
    isSchedulerQueueNotice(content)
  )
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
  code: 'ok' | 'recycled_report' | 'scheduler_notice' | 'duplicate_dispatch'
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

  if (isCompletionReport(content)) {
    return {
      block: true,
      code: 'recycled_report',
      reason:
        'Sadržaj zadatka je agentov završni izvještaj (≥2 sidrena markera: "Done."/REGOC-STATUS/"**Completed:**"/"Summary of TASK-…"), ne specifikacija novog posla.',
    }
  }

  if (isSchedulerQueueNotice(content)) {
    return {
      block: true,
      code: 'scheduler_notice',
      reason:
        'Sadržaj je scheduler-dojava o dovršenom zadatku / praznom redu ("Task TASK-… COMPLETED", "No more unblocked tasks in queue"), ne specifikacija novog posla — TASK-4742…4751.',
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
