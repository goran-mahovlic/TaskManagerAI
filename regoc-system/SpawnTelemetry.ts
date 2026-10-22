#!/usr/bin/env bun
/**
 * SpawnTelemetry — što je JEDAN spawn stvarno potrošio (K7 / TASK-2986).
 *
 * Problem (Goran, 28.07.): "svaki run ima log iz kojeg se moze izvuci koliko tokena je
 * potroseno za odredjeni zadatak". Do sada se to moglo saznati samo naknadnim kopanjem po
 * `~/.claude/projects/*.jsonl` transkriptima (K6 / tools/run_tokens.py), a `cost_log`
 * tablica je bila prazna jer je `CostTracker.logUsage` nitko nije zvao.
 *
 * Izvor istine je sam CLI: `claude --print --output-format json` uz rezultat vraća i
 * `usage` (input/output/cache_read/cache_creation), `total_cost_usd`, `session_id`,
 * `num_turns` i `duration_ms`. Ovaj modul:
 *
 *   1. `parseSpawnOutput()` — JSON omotnicu pretvara u strukturu, uz SIGURAN fallback na
 *      sirovi tekst (stari put) kad izlaz nije JSON (kimi/gemini/ollama CLI, poruka greške,
 *      hook-blokada). Bez fallbacka bi svaki ne-JSON spawn ispao neuspješan.
 *   2. `recordSpawn()` — jedan redak u `data/run_log.jsonl` + jedan redak u `cost_log`.
 *
 * NAPOMENA O CIJENI: `total_cost_usd` iz CLI-ja je MJERENJE i ima prednost. Tarifna tablica
 * (CostTracker) je samo procjena za slučaj kad CLI ne javi cijenu — mjereno 28.07. razlikuje
 * se jer se 1-satni cache upis naplaćuje 2× ulaz, a ne 1,25× (proba: haiku, 14471 cache-write
 * → CLI 0,0311 USD vs. tarifna procjena 0,0203 USD).
 *
 * Modul nema globalno stanje i sve nuspojave prima kroz `deps` → testira se bez daemona i
 * bez baze.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { estimateCostUsd } from './CostTracker'

const HOME = process.env.HOME || homedir()

/**
 * Jedan redak po spawnu. Isti direktorij koji čita `run_tokens.py --jsonl-out`.
 * `REGOC_RUN_LOG` preusmjerava dnevnik (testni harnessi koji uvoze daemon inače pišu
 * svoje lažne spawnove u živi dnevnik — isti razlog zbog kojeg su LOG_FILE i DB_PATH
 * već sandboxirani u tests/).
 */
export const RUN_LOG_FILE = process.env.REGOC_RUN_LOG || join(HOME, '.claude/regoc/data/run_log.jsonl')

/**
 * Isto, ali razrijeseno U TRENUTKU POZIVA (TASK-3597).
 *
 * `RUN_LOG_FILE` je konstanta koja se izracuna pri UVOZU modula, pa je preusmjerenje
 * radilo samo za PRVI test-harness u procesu: drugi bi postavio `REGOC_RUN_LOG` nakon
 * uvoza i tiho pisao u tudj (ili zivi) dnevnik. Otkriveno kad je uz
 * AgentDaemon.retry-model.test.ts dosao i AgentDaemon.spawn-breaker.test.ts.
 */
export function runLogFile(): string {
  return process.env.REGOC_RUN_LOG || join(HOME, '.claude/regoc/data/run_log.jsonl')
}

/** Keš potrošnje sesije koji pišu Stop/UserPromptSubmit hookovi (v. TaskManagerMD/src/SessionUsage.ts). */
export const SESSION_USAGE_CACHE_FILE = join(HOME, '.claude/regoc/data/session_usage.cache.json')

/** Stariji keš od ovoga ne opisuje ovaj spawn → radije `null` nego kriva brojka. */
export const SESSION_USAGE_MAX_AGE_MS = 30 * 60 * 1000

/** Povijest svih snimaka (`session_usage.py --append_log`) — jedan redak po probeu. */
export const SESSION_USAGE_LOG_FILE = join(HOME, '.claude/regoc/data/session_usage.jsonl')

// ============================================
// Parsiranje izlaza spawna
// ============================================

export interface SpawnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface SpawnEnvelope {
  /** true samo kad je izlaz bio valjan JSON `--output-format json` omotač. */
  parsed: boolean
  /** Tekst rezultata — SVE daljnje parsiranje (guardovi, PAI markeri) ide na ovo polje. */
  resultText: string
  usage: SpawnUsage | null
  /** Cijena koju je javio CLI (mjerenje), ili null. */
  costUsd: number | null
  sessionId: string | null
  /** 0 = CLI nije napravio nijedan modelski korak (potpis hook-blokade, v. memoriju). */
  numTurns: number | null
  durationMs: number | null
  /** Kanonsko ime modela iz `modelUsage` (npr. claude-haiku-4-5-20251001). */
  model: string | null
  isError: boolean
  /** Kratko objašnjenje zašto se palo na fallback (za dnevnik), ili null. */
  parseNote: string | null
}

const ZERO_USAGE: SpawnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function optNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Pokušaj pročitati JSON čak i kad CLI ispred njega ispiše upozorenje
 * (npr. "warning: …\n{…}"). Sidrimo se na prvu `{` i zadnju `}`.
 */
function tryParseJson(raw: string): { ok: true; value: any } | { ok: false; note: string } {
  const s = (raw || '').trim()
  if (!s) return { ok: false, note: 'prazan izlaz' }
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch { /* pokušaj s odsječenim rubovima */ }

  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return { ok: true, value: JSON.parse(s.slice(start, end + 1)) }
    } catch { /* pada niže */ }
  }
  return { ok: false, note: 'izlaz nije JSON' }
}

/** Zbroji `modelUsage` kad `usage` nedostaje i vrati i dominantni model. */
function foldModelUsage(modelUsage: unknown): { usage: SpawnUsage | null; model: string | null } {
  if (!modelUsage || typeof modelUsage !== 'object') return { usage: null, model: null }
  const entries = Object.entries(modelUsage as Record<string, any>)
  if (entries.length === 0) return { usage: null, model: null }

  const total: SpawnUsage = { ...ZERO_USAGE }
  let best: { model: string; weight: number } | null = null

  for (const [model, d] of entries) {
    const inp = num(d?.inputTokens)
    const out = num(d?.outputTokens)
    const cr = num(d?.cacheReadInputTokens)
    const cw = num(d?.cacheCreationInputTokens)
    total.inputTokens += inp
    total.outputTokens += out
    total.cacheReadTokens += cr
    total.cacheWriteTokens += cw
    const weight = inp + out + cr + cw
    if (!best || weight > best.weight) best = { model, weight }
  }

  return { usage: total, model: best?.model ?? null }
}

/**
 * Izlaz `claude --print` → strukturirana omotnica.
 *
 * Kad izlaz NIJE JSON (drugi CLI, poruka greške, prazan izlaz), vraća se `parsed:false` i
 * `resultText` = sirovi izlaz — točno ponašanje koje je daemon imao prije K7.
 */
export function parseSpawnOutput(stdout: string): SpawnEnvelope {
  const raw = stdout || ''
  const fallback: SpawnEnvelope = {
    parsed: false,
    resultText: raw.trim(),
    usage: null,
    costUsd: null,
    sessionId: null,
    numTurns: null,
    durationMs: null,
    model: null,
    isError: false,
    parseNote: null,
  }

  const attempt = tryParseJson(raw)
  if (!attempt.ok) {
    fallback.parseNote = attempt.note
    return fallback
  }

  const j = attempt.value
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    fallback.parseNote = 'JSON nije objekt'
    return fallback
  }

  // Omotnica se prepoznaje po `result`/`type:result`; inače je to samo neki JSON
  // koji je agent ispisao kao svoj odgovor → tretiraj ga kao tekst.
  const hasResult = typeof j.result === 'string'
  const looksLikeEnvelope = hasResult || j.type === 'result' || j.usage != null || j.session_id != null
  if (!looksLikeEnvelope) {
    fallback.parseNote = 'JSON bez `result`/`usage` — nije omotnica CLI-ja'
    return fallback
  }

  const folded = foldModelUsage(j.modelUsage)
  const u = j.usage
  const usage: SpawnUsage | null = u && typeof u === 'object'
    ? {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
      }
    : folded.usage

  return {
    parsed: true,
    resultText: hasResult ? j.result : raw.trim(),
    usage,
    costUsd: optNum(j.total_cost_usd),
    sessionId: typeof j.session_id === 'string' ? j.session_id : null,
    numTurns: optNum(j.num_turns),
    durationMs: optNum(j.duration_ms),
    model: folded.model,
    isError: j.is_error === true,
    parseNote: null,
  }
}

// ============================================
// Potrošnja sesije (prije/poslije spawna)
// ============================================

/**
 * Postotak potrošnje tekuće sesije iz keša hookova, ili `null` ako keša nema / prestar je.
 * Namjerno NE radi mrežni probe — spawn handler ne smije čekati na mrežu.
 */
export function readSessionPercent(
  nowMs: number = Date.now(),
  cacheFile: string = SESSION_USAGE_CACHE_FILE,
): number | null {
  try {
    if (!existsSync(cacheFile)) return null
    const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    const cachedAtMs = Number(raw?.cached_at) * 1000
    if (!Number.isFinite(cachedAtMs)) return null
    if (nowMs - cachedAtMs > SESSION_USAGE_MAX_AGE_MS) return null
    const pct = raw?.entry?.session_percent
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : null
  } catch {
    return null
  }
}

/**
 * Cijela zadnja snimka potrošnje + koliko je stara — bez odbacivanja po starosti.
 *
 * TASK-3046: `readSessionPercent()` na prestarom kešu vraća `null`, a `autonomyTier(null)`
 * je fail-open. Dok je keš pisao samo hook agentske sesije, to je značilo: čim gate
 * zaustavi agente, nitko više ne mjeri → keš zastari → gate se sam otvori. Incident
 * 29.07.2026: rafali od 3 Opus spawna svakih ~30 min (07:24, 07:55, 08:25, 08:55) dok je
 * sesija stajala na 100 % i API vraćao 429. Odluka o zaustavljanju mora vidjeti i staru
 * snimku (i njezinu starost) da bi mogla biti fail-closed kad zadnje poznato stanje
 * govori „stani".
 */
export interface SessionUsageSnapshot {
  /** Postotak potrošnje 5h prozora, ili `null` ako ga snimka nema. */
  sessionPercent: number | null
  weeklyPercent: number | null
  /** `allowed` | `rejected` | … — izravno iz `anthropic-ratelimit-unified-status`. */
  status: string | null
  /** Npr. `429 Too Many Requests` kad je probe odbijen. */
  httpError: string | null
  sessionResetAt: string | null
  /** Starost snimke u ms. */
  ageMs: number
  /** `true` kad je snimka starija od `SESSION_USAGE_MAX_AGE_MS`. */
  stale: boolean
}

export function readSessionUsage(
  nowMs: number = Date.now(),
  cacheFile: string = SESSION_USAGE_CACHE_FILE,
): SessionUsageSnapshot | null {
  try {
    if (!existsSync(cacheFile)) return null
    const raw = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    const cachedAtMs = Number(raw?.cached_at) * 1000
    if (!Number.isFinite(cachedAtMs)) return null
    const e = raw?.entry
    if (!e || typeof e !== 'object') return null
    const ageMs = Math.max(0, nowMs - cachedAtMs)
    const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null)
    return {
      sessionPercent: numOrNull(e.session_percent),
      weeklyPercent: numOrNull(e.weekly_percent),
      status: strOrNull(e.status),
      httpError: strOrNull(e.http_error),
      sessionResetAt: strOrNull(e.session_reset_at),
      ageMs,
      stale: ageMs > SESSION_USAGE_MAX_AGE_MS,
    }
  } catch {
    return null
  }
}

/** Zapamćeno „ovdje je mjerenje jednom radilo" — po putanji, i samo kad je `true`. */
const usageHistoryMemo = new Map<string, true>()

/**
 * Je li mjerenje potrošnje IKAD dalo upotrebljiv rezultat (TASK-3061).
 *
 * Razlika koja odlučuje o fail-open vs. fail-CLOSED kad snimke nema:
 *
 *   • „nikad izmjereno" (svjež sustav, mjerilo nikad nije proradilo) → fail-OPEN, inače
 *     bi se sustav zaključao na prvom pokretanju i nikad ne bi ni pokušao raditi;
 *   • „mjerilo je radilo, a sad je snimka nestala/nečitljiva" → fail-CLOSED, jer to nije
 *     neznanje nego ISPAD, a ispad je točno stanje u kojem su rafali najvjerojatniji
 *     (incident 29.07.2026).
 *
 * Marker je `session_usage.jsonl` — postoji od prije i preživi brisanje keša. Broji se samo
 * INFORMATIVAN redak (postotak ili odbijenica kvote), istom definicijom kao `is_informative`
 * u `tools/session_usage.py`: dnevnik bilježi i neuspjele probe (sve `null`), pa bi puko
 * „datoteka nije prazna" značilo da niz neuspjeha izgleda kao dokaz da je mjerenje radilo.
 *
 * Rezultat `true` se pamti (povijest ne nestaje unatrag); `false` se NE pamti — prvo uspješno
 * mjerenje mora ga moći promijeniti bez restarta daemona.
 */
export function hasUsageHistory(historyFile: string = SESSION_USAGE_LOG_FILE): boolean {
  if (usageHistoryMemo.has(historyFile)) return true
  try {
    if (!existsSync(historyFile)) return false
    const raw = readFileSync(historyFile, 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let e: any
      try { e = JSON.parse(line) } catch { continue }   // poluzapisan redak nije dokaz
      const informative = (typeof e?.session_percent === 'number' && Number.isFinite(e.session_percent))
        || e?.status === 'rejected'
        || /\b429\b/.test(String(e?.http_error ?? ''))
      if (informative) {
        usageHistoryMemo.set(historyFile, true)
        return true
      }
    }
    return false
  } catch {
    // Dnevnik se ne može pročitati → ne tvrdimo da je mjerenje radilo. Fail-open ostaje
    // fail-open; ovo je pomoćni dokaz, a ne novi razlog za zaključavanje sustava.
    return false
  }
}

// ============================================
// Dnevnik spawnova (run_log.jsonl)
// ============================================

/**
 * Ishod jednog izvođenja. Taksonomija (uklj. `blocked_ok`) živi u `RunOutcome.ts` —
 * ovdje se samo ponovo izvozi da postojeći uvoznici (`import { RunOutcome } from
 * './SpawnTelemetry'`) ostanu netaknuti. M3/TASK-4625.
 */
export type { RunOutcome, OutcomeColumn } from './RunOutcome'
export { outcomeColumn, countColumns, RUN_OUTCOMES, OUTCOME_COLUMNS } from './RunOutcome'
import type { RunOutcome } from './RunOutcome'
import { homedir } from 'os'

export interface RunLogEntry {
  ts: string
  task_id: string | null
  agent: string
  model: string
  exit_code: number | null
  outcome: RunOutcome
  duration_s: number
  tokens: { in: number; out: number; cache_r: number; cache_w: number }
  cost_usd: number
  /** `cli` = mjerenje iz `total_cost_usd`; `rates` = procjena po tarifi; `none` = nepoznato. */
  cost_source: 'cli' | 'rates' | 'none'
  session_id: string | null
  session_percent_prije: number | null
  session_percent_poslije: number | null
  num_turns: number | null
  /** `json` = pročitana JSON omotnica; `fallback` = stari tekstualni put. */
  telemetry: 'json' | 'fallback'
  provider: string
  /** Marker izvora retka — `run_tokens.py --jsonl-out` piše u istu datoteku svoj oblik. */
  source: 'regoc-spawn'
  note?: string
}

export interface RecordSpawnInput {
  agentId: string
  taskId: string | null
  /** Model kako je zatražen (npr. 'opus'); kanonsko ime iz omotnice ima prednost. */
  requestedModel: string
  provider: string
  exitCode: number | null
  outcome: RunOutcome
  startedAtMs: number
  endedAtMs?: number
  envelope: SpawnEnvelope
  sessionPercentBefore: number | null
  sessionPercentAfter: number | null
  note?: string
}

export interface RecordSpawnDeps {
  appendLine?: (line: string) => void
  logUsage?: (entry: {
    agentId: string
    taskId: string | null
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    sessionId: string | null
    costUsd?: number
  }) => void
  now?: () => number
}

/** Dopiši redak u `run_log.jsonl`. Nikad ne baca — telemetrija ne smije srušiti spawn. */
export function appendRunLog(entry: RunLogEntry, file: string = runLogFile()): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')
    return true
  } catch {
    return false
  }
}

/** Sastavi redak dnevnika iz ishoda spawna (čisto, bez nuspojava — zato je testabilno). */
export function buildRunLogEntry(input: RecordSpawnInput, nowMs: number = Date.now()): RunLogEntry {
  const env = input.envelope
  const usage = env.usage || ZERO_USAGE
  const model = env.model || input.requestedModel || 'unknown'
  const endedAt = input.endedAtMs ?? nowMs

  // Trajanje: CLI-jevo `duration_ms` mjeri sam poziv; zidni sat mjeri cijeli spawn
  // (uklj. pokretanje procesa). Za "koliko je zadatak trajao" mjerodavan je zidni sat.
  const durationS = Math.max(0, Math.round((endedAt - input.startedAtMs) / 1000))

  let costUsd = env.costUsd
  let costSource: RunLogEntry['cost_source'] = 'cli'
  if (costUsd == null) {
    if (env.usage) {
      costUsd = estimateCostUsd(model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens)
      costSource = 'rates'
    } else {
      costUsd = 0
      costSource = 'none'
    }
  }

  return {
    ts: new Date(endedAt).toISOString(),
    task_id: input.taskId,
    agent: input.agentId,
    model,
    exit_code: input.exitCode,
    outcome: input.outcome,
    duration_s: durationS,
    tokens: {
      in: usage.inputTokens,
      out: usage.outputTokens,
      cache_r: usage.cacheReadTokens,
      cache_w: usage.cacheWriteTokens,
    },
    cost_usd: Math.round(costUsd * 1e6) / 1e6,
    cost_source: costSource,
    session_id: env.sessionId,
    session_percent_prije: input.sessionPercentBefore,
    session_percent_poslije: input.sessionPercentAfter,
    num_turns: env.numTurns,
    telemetry: env.parsed ? 'json' : 'fallback',
    provider: input.provider,
    source: 'regoc-spawn',
    ...(input.note || env.parseNote ? { note: input.note || env.parseNote! } : {}),
  }
}

/**
 * Zabilježi spawn na OBA mjesta: `data/run_log.jsonl` (redak po runu) i `cost_log`
 * (agregacija po agentu/zadatku/modelu). Nikad ne baca.
 *
 * U `cost_log` se piše samo kad postoji stvarno mjerenje potrošnje — inače bi tablica
 * bila puna nula i lagala jednako kao mrtvi `stats-cache.json`.
 */
export function recordSpawn(input: RecordSpawnInput, deps: RecordSpawnDeps = {}): RunLogEntry {
  const now = deps.now ? deps.now() : Date.now()
  const entry = buildRunLogEntry(input, now)

  if (deps.appendLine) {
    try { deps.appendLine(JSON.stringify(entry)) } catch { /* telemetrija ne ruši spawn */ }
  } else {
    appendRunLog(entry)
  }

  if (input.envelope.usage) {
    const logUsage = deps.logUsage ?? defaultLogUsage
    try {
      logUsage({
        agentId: input.agentId,
        taskId: input.taskId,
        model: entry.model,
        inputTokens: entry.tokens.in,
        outputTokens: entry.tokens.out,
        cacheReadTokens: entry.tokens.cache_r,
        cacheWriteTokens: entry.tokens.cache_w,
        sessionId: entry.session_id,
        costUsd: entry.cost_source === 'cli' ? entry.cost_usd : undefined,
      })
    } catch { /* baza smije biti zaključana; run_log je već zapisan */ }
  }

  return entry
}

/** Lijeni default — CostTracker otvara SQLite, pa se ne dira u testovima s injektiranim deps. */
function defaultLogUsage(entry: Parameters<NonNullable<RecordSpawnDeps['logUsage']>>[0]): void {
  const { getCostTracker } = require('./CostTracker')
  getCostTracker().logUsage(entry)
}
