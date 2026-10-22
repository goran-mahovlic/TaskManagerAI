// ─── SpawnBreaker ────────────────────────────────────────────────────────────
// DUR-5 / TASK-3597 (PRJ-030), dio 2/2: OSIGURAČ NA VRATIMA SPAWNOVA.
//
// NALAZ (Jelena, §4 TASK-2538): `SendBreaker` (R5/TASK-2565) brani SLANJE PORUKA —
// pazi da agent ne pošalje 1894 identične poruke u 3 h. To je stvaran kvar, ali NIJE
// onaj koji troši kvotu. Rate-limit se događa na `claude --print`, a na tim vratima
// nema ničega osim:
//   • stropa istovremenosti (`MAX_AGENT_CONCURRENT`, DUR-4) — koliko ih smije U ISTO VRIJEME,
//   • per-agent backoffa u memoriji RegocDaemona — koji restart procesa briše.
// Dakle: osigurač je stajao na krivim vratima. Ovaj modul ga stavlja na prava.
//
// ŠTO RADI
//   1. Broji UZASTOPNE odbijenice spawna po agentu i globalno (jedan račun = jedan limit).
//   2. Nakon N uzastopnih odbijenica otvara osigurač na T minuta i ODBIJA nove spawnove
//      s jasnim razlogom u dnevniku (`🛑 SPAWN-BREAKER …`).
//   3. Nakon T minuta osigurač se sam gasi — prvi propušteni spawn je „probni" (half-open):
//      uspije li, brojač se resetira; padne li opet, osigurač se odmah vraća.
//   4. Uz osigurač stoji i `TokenBucket` (postojeći modul, SQLite/WAL) kao STROP BRZINE:
//      i bez ijednog kvara nitko ne smije ispaliti rafal spawnova.
//
// STANJE JE CROSS-PROCESS (SQLite/WAL u messages.db) — isto kao kod SendBreakera i iz
// istog razloga: RegocDaemon i svaki AgentDaemon su ODVOJENI procesi, a rate-limit je
// zajednički. Brojač u memoriji jednog procesa ne vidi da su druga dva već odbijena.
//
// FAIL-CLOSED / FAIL-OPEN (izričit zahtjev)
//   • ODBIJENICA (429, rate/usage limit, preopterećenje, hook-blokada ulaza) → BROJI SE.
//     To je dokazano „račun te ne pušta"; ustrajanje samo produljuje kaznu. Fail-CLOSED.
//   • NEPOZNATA GREŠKA (exit 1 bez potpisa, SIGTERM, pad alata) → NE broji se.
//     Ne znamo je li kriv račun ili zadatak; zatvaranje vrata na nagađanje zaustavilo bi
//     legitiman rad. Fail-OPEN (postojeći per-agent backoff i dalje vrijedi).
//   • Kvar U SAMOM OSIGURAČU (SQL pao) → propušta se, uz zapis. Osigurač koji ruši rad
//     biva isključen, a isključen osigurač ne štiti nikoga.
//
// UVOĐENJE (features.json, hot-reload bez restarta) — isti obrazac kao SendBreaker:
//   spawnBreaker.enabled=false                → OFF    (potpuni no-op, ni jedan SQL upit)
//   spawnBreaker=true, spawnBreakerLive=false → SHADOW (mjeri i logira, NIŠTA ne odbija)
//   spawnBreakerLive.enabled=true             → LIVE   (stvarno odbija spawnove)
//   spawnBreakerLive.agents=["kosjenka"]      → CANARY (provodi se samo za navedene)
//
// NE DIRA VRATA AUTONOMIJE (`WorkStateJournal`, `autonomyTierFromUsage`). Ovo je sloj
// ISPOD njih: vrata autonomije odlučuju SMIJE LI se uopće raditi, osigurač samo sprječava
// da se već odbijeni pokušaj ponavlja u petlji.
//
// Autorica: Jelena (Engineer) · 2026-09-02 · TASK-3597

import { Database } from 'bun:sqlite'
import { isEnabled, getFlag } from './FeatureFlags'

// ─── Konfiguracija ───────────────────────────────────────────────────────────

/** N uzastopnih odbijenica po agentu → osigurač. */
export const DEFAULT_FAIL_THRESHOLD = 3
/** N uzastopnih odbijenica ukupno (svi agenti) → globalni osigurač. Jedan račun, jedan limit. */
export const DEFAULT_GLOBAL_FAIL_THRESHOLD = 5
/** T — koliko osigurač ostaje otvoren. */
export const DEFAULT_OPEN_MS = 15 * 60 * 1000
/** Ime globalnog opsega u tablici (agent se nikad ne smije zvati ovako). */
export const GLOBAL_SCOPE = '__global__'
/** Ime kante u `token_bucket` — jedan `claude --print` = jedan token. */
export const SPAWN_BUCKET = 'claude_spawn'
/** Kapacitet kante: koliko spawnova smije proći „odjednom" nakon mirovanja. */
export const DEFAULT_BUCKET_CAPACITY = 6
/** Punjenje kante: +1 token svakih 10 s (vrijednost iz TokenBucket.ts zaglavlja). */
export const DEFAULT_BUCKET_REFILL_PER_SEC = 0.1

export type SpawnBreakerMode = 'off' | 'shadow' | 'enforce'
/** Zašto je spawn pao — odlučuje broji li se ili ne (fail-closed vs. fail-open). */
export type SpawnFailureKind = 'rejected' | 'unknown'

export interface SpawnGateVerdict {
  /** Smije li spawn stvarno krenuti. U shadow modu UVIJEK true. */
  allowed: boolean
  /** Bi li osigurač odbio da je u enforce modu (za shadow usporedbu). */
  wouldBlock: boolean
  mode: SpawnBreakerMode
  /** Opseg koji je odbio (`agent:<id>` ili `__global__`), prazno ako nitko. */
  scope: string
  /** Uzastopne odbijenice u opsegu koji je odlučio. */
  consecutiveFailures: number
  /** Do kada je osigurač otvoren (ms epoch), null kad nije. */
  openUntilMs: number | null
  /** Treba li poslati alarm — true točno jednom po epizodi i modu. */
  alarm: boolean
  /** Koliko je spawnova do sada odbijeno pod ovom epizodom. */
  blockedCount: number
  /** Stanje kante brzine: 'ok' propušten token, 'empty' nema tokena, 'off' kanta nije u igri. */
  bucket: 'ok' | 'empty' | 'off'
  reason: string
  /** Je li SQL sloj otkazao (verdikt se oslonio samo na memoriju). */
  sqlError?: string
}

/** Minimalno sučelje `TokenBucket`-a — da test ne mora otvarati pravu bazu. */
export interface TokenBucketLike {
  init(name: string, capacity: number, refillPerSec: number, reset?: boolean): void
  tryConsume(name: string, n?: number): boolean
  peek(name: string): number
}

export interface SpawnBreakerOptions {
  /** N uzastopnih odbijenica po agentu. */
  threshold?: number
  /** N uzastopnih odbijenica globalno. */
  globalThreshold?: number
  /** T — trajanje otvorenog osigurača. */
  openMs?: number
  /** Injektabilni sat — testovi vrte vrijeme bez sleepa. */
  now?: () => number
  /** Preskoči FeatureFlags i prisili mod (testovi / alat). */
  modeOverride?: SpawnBreakerMode
  /** Strop brzine. Bez njega osigurač radi samo na uzastopnim kvarovima. */
  bucket?: TokenBucketLike | null
  bucketCapacity?: number
  bucketRefillPerSec?: number
  logger?: (msg: string) => void
}

// ─── Klasifikacija kvara spawna ──────────────────────────────────────────────

/**
 * Potpisi „račun te je odbio". Namjerno UŽI od „nešto je puklo": svaki uzorak ovdje
 * znači da ponovni pokušaj ODMAH sigurno pada, pa je čekanje jedini ispravan potez.
 */
const REJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b429\b/, label: 'HTTP 429' },
  { re: /rate[ _-]?limit/i, label: 'rate limit' },
  { re: /too many requests/i, label: 'too many requests' },
  { re: /usage limit|limit reached|limit exceeded/i, label: 'usage limit' },
  { re: /session limit|session_limit/i, label: 'session limit' },
  { re: /quota (?:exceeded|exhausted)|insufficient[ _]quota/i, label: 'quota' },
  { re: /overloaded(?:_error)?/i, label: 'overloaded' },
  { re: /credit balance is too low/i, label: 'credit balance' },
  { re: /\b(?:503|529)\b/, label: 'HTTP 503/529' },
]

export interface SpawnFailureClass {
  kind: SpawnFailureKind
  reason: string
}

/**
 * Je li pad spawna ODBIJENICA (broji se) ili nepoznata greška (ne broji se)?
 *
 * `exitCode === 0` NIJE ulaz za ovu funkciju — uspjeh se prijavljuje `recordSuccess`.
 * Hook-blokadu ulaza (`classifySpawnOutcome → 'blocked'`) pozivatelj prijavljuje
 * izričito kao odbijenicu: budžet sesije je potrošen, a to je isti razred kvara.
 */
export function classifySpawnFailure(
  exitCode: number | null,
  ...texts: Array<string | null | undefined>
): SpawnFailureClass {
  const hay = texts.filter(Boolean).join('\n').slice(0, 20_000)
  for (const p of REJECTION_PATTERNS) {
    if (p.re.test(hay)) return { kind: 'rejected', reason: p.label }
  }
  return { kind: 'unknown', reason: `exit ${exitCode ?? 'null'} bez potpisa odbijenice` }
}

// ─── Mod iz feature flagova ──────────────────────────────────────────────────

export function resolveSpawnMode(agentId: string): SpawnBreakerMode {
  if (!isEnabled('spawnBreaker')) return 'off'
  if (!isEnabled('spawnBreakerLive')) return 'shadow'
  const live = getFlag('spawnBreakerLive') as (Record<string, unknown> | undefined)
  const agents = live && Array.isArray((live as any).agents) ? (live as any).agents as string[] : null
  if (agents && agents.length > 0 && !agents.includes(agentId)) return 'shadow'
  return 'enforce'
}

// ─── Shema (ADITIVNA — samo CREATE IF NOT EXISTS) ────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spawn_breaker_state (
     scope TEXT PRIMARY KEY,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     last_fail_ms INTEGER NOT NULL DEFAULT 0,
     open_until_ms INTEGER NOT NULL DEFAULT 0,
     opened_ms INTEGER NOT NULL DEFAULT 0,
     episodes INTEGER NOT NULL DEFAULT 0,
     blocked_count INTEGER NOT NULL DEFAULT 0,
     alarm_mode TEXT,
     last_reason TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS spawn_breaker_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     scope TEXT NOT NULL,
     agent_id TEXT,
     event TEXT NOT NULL,
     kind TEXT,
     mode TEXT NOT NULL,
     detail TEXT,
     created_ms INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_spawn_breaker_log_time ON spawn_breaker_log(created_ms)`,
]

/**
 * Retencija forenzičkog dnevnika. 96 h, NE 24 h: prihvatni kriterij canaryja traži sud
 * nad prozorom od 72 h („3 dana bez lažnog zatvaranja", ADR-0006), a dnevnik koji pamti
 * 24 h taj dokaz ne može dati — prazna tablica i uredan rad izgledaju jednako
 * (nalaz TASK-4639). Podesivo bez restarta preko `spawnBreaker.logRetentionHours`.
 */
export const DEFAULT_LOG_RETENTION_HOURS = 96
const SAT_MS = 60 * 60 * 1000
/** Gornja granica (30 dana) — flag ne smije napuhati bazu bez kraja. */
const MAX_LOG_RETENTION_HOURS = 30 * 24
const PRUNE_EVERY = 200

/** Retencija u ms iz flaga `spawnBreaker.logRetentionHours`; besmislena vrijednost → default. */
export function resolveLogRetentionMs(): number {
  const flag = getFlag('spawnBreaker') as (Record<string, unknown> | undefined)
  const raw = flag ? (flag as any).logRetentionHours : undefined
  const hours = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(raw, MAX_LOG_RETENTION_HOURS)
    : DEFAULT_LOG_RETENTION_HOURS
  return hours * SAT_MS
}

interface ScopeState {
  scope: string
  consecutiveFailures: number
  lastFailMs: number
  openUntilMs: number
  openedMs: number
  episodes: number
  blockedCount: number
  alarmMode: string | null
  lastReason: string | null
}

function emptyState(scope: string): ScopeState {
  return {
    scope, consecutiveFailures: 0, lastFailMs: 0, openUntilMs: 0, openedMs: 0,
    episodes: 0, blockedCount: 0, alarmMode: null, lastReason: null,
  }
}

// ─── Osigurač ────────────────────────────────────────────────────────────────

export class SpawnBreaker {
  private db: Database
  private threshold: number
  private globalThreshold: number
  private openMs: number
  private now: () => number
  private modeOverride?: SpawnBreakerMode
  private log: (msg: string) => void
  private bucket: TokenBucketLike | null
  private bucketReady = false
  private bucketCapacity: number
  private bucketRefill: number

  private schemaReady = false
  private checkCount = 0
  /** In-memory sloj: radi i kad SQL padne (fail-safe protiv fail-opena). */
  private mem = new Map<string, ScopeState>()

  constructor(db: Database, opts: SpawnBreakerOptions = {}) {
    this.db = db
    this.threshold = opts.threshold ?? DEFAULT_FAIL_THRESHOLD
    this.globalThreshold = opts.globalThreshold ?? DEFAULT_GLOBAL_FAIL_THRESHOLD
    this.openMs = opts.openMs ?? DEFAULT_OPEN_MS
    this.now = opts.now ?? (() => Date.now())
    this.modeOverride = opts.modeOverride
    this.log = opts.logger ?? (() => {})
    this.bucket = opts.bucket ?? null
    this.bucketCapacity = opts.bucketCapacity ?? DEFAULT_BUCKET_CAPACITY
    this.bucketRefill = opts.bucketRefillPerSec ?? DEFAULT_BUCKET_REFILL_PER_SEC
  }

  /** Zamijeni handle baze — za procese koji otvaraju/zatvaraju DB po pozivu. */
  setDb(db: Database): void {
    if (db === this.db) return
    this.db = db
    this.schemaReady = false
  }

  mode(agentId: string): SpawnBreakerMode {
    return this.modeOverride ?? resolveSpawnMode(agentId)
  }

  /** Prag koji vrijedi za dani opseg. */
  private thresholdFor(scope: string): number {
    return scope === GLOBAL_SCOPE ? this.globalThreshold : this.threshold
  }

  private scopesFor(agentId: string): string[] {
    return [`agent:${agentId}`, GLOBAL_SCOPE]
  }

  /**
   * Smije li spawn krenuti? Poziva se NEPOSREDNO prije `Bun.spawn`.
   *
   * Kad vrati `allowed=true` u enforce modu, potrošen je jedan token iz kante — ne zovi
   * dvaput za isti spawn.
   */
  check(agentId: string): SpawnGateVerdict {
    const mode = this.mode(agentId)
    if (mode === 'off') {
      return {
        allowed: true, wouldBlock: false, mode, scope: '', consecutiveFailures: 0,
        openUntilMs: null, alarm: false, blockedCount: 0, bucket: 'off',
        reason: 'osigurač isključen',
      }
    }

    const now = this.now()
    let sqlError: string | undefined
    let open: ScopeState | null = null

    for (const scope of this.scopesFor(agentId)) {
      const st = this.readState(scope, (e) => { sqlError = sqlError ?? e })
      if (st.openUntilMs > now) { open = st; break }
      // Istekao osigurač → half-open: brišemo rok, ali brojač NE nuliramo. Sljedeći
      // spawn je probni; padne li opet kao odbijenica, prag je već dosegnut pa se
      // osigurač zatvara odmah (bez novog niza od N pokušaja u rate-limit).
      if (st.openUntilMs > 0 && st.openUntilMs <= now) {
        st.openUntilMs = 0
        this.writeState(st, (e) => { sqlError = sqlError ?? e })
        this.log(`🔓 SPAWN-BREAKER zatvoren (${scope}) — istekao rok, sljedeći spawn je probni (${st.consecutiveFailures} uzastopnih odbijenica u zapisu)`)
        this.appendLog(scope, agentId, 'half_open', null, mode, `probni spawn nakon ${Math.round(this.openMs / 60000)} min`, now)
      }
    }

    if (open) {
      const remainingMin = Math.max(1, Math.round((open.openUntilMs - now) / 60000))
      const alarm = open.alarmMode !== mode
      open.blockedCount += mode === 'enforce' ? 1 : 0
      open.alarmMode = mode
      this.writeState(open, (e) => { sqlError = sqlError ?? e })
      const reason = `osigurač otvoren (${open.scope}): ${open.consecutiveFailures} uzastopnih odbijenica`
        + ` [${open.lastReason || 'bez oznake'}], propuštam za ~${remainingMin} min`
      this.appendLog(open.scope, agentId, mode === 'enforce' ? 'refused' : 'would_refuse', null, mode, reason, now)
      if (mode === 'shadow') {
        this.log(`👁️ SPAWN-BREAKER SHADOW: ${agentId} — BI odbio spawn (${reason})`)
        this.maybePrune(now)
        return {
          allowed: true, wouldBlock: true, mode, scope: open.scope,
          consecutiveFailures: open.consecutiveFailures, openUntilMs: open.openUntilMs,
          alarm, blockedCount: open.blockedCount, bucket: 'off',
          reason: `shadow: ${reason} — spawn NIJE zaustavljen`, sqlError,
        }
      }
      this.log(`🛑 SPAWN-BREAKER ODBIJA spawn ${agentId} — ${reason} (odbijeno ukupno ${open.blockedCount})`)
      this.maybePrune(now)
      return {
        allowed: false, wouldBlock: true, mode, scope: open.scope,
        consecutiveFailures: open.consecutiveFailures, openUntilMs: open.openUntilMs,
        alarm, blockedCount: open.blockedCount, bucket: 'off',
        reason, sqlError,
      }
    }

    // ── Strop brzine: i bez ijednog kvara nitko ne smije ispaliti rafal ──
    let bucketState: 'ok' | 'empty' | 'off' = 'off'
    if (this.bucket) {
      try {
        if (!this.bucketReady) {
          this.bucket.init(SPAWN_BUCKET, this.bucketCapacity, this.bucketRefill)
          this.bucketReady = true
        }
        bucketState = this.bucket.tryConsume(SPAWN_BUCKET) ? 'ok' : 'empty'
      } catch (e: any) {
        // Kvar u kanti ne smije zaustaviti rad — fail-open uz zapis.
        this.log(`⚠️ SpawnBreaker kanta pala (propuštam): ${e?.message ?? e}`)
        bucketState = 'off'
      }
    }
    if (bucketState === 'empty') {
      const reason = `strop brzine: kanta '${SPAWN_BUCKET}' prazna (kapacitet ${this.bucketCapacity}, punjenje ${this.bucketRefill}/s)`
      this.appendLog('bucket', agentId, mode === 'enforce' ? 'refused' : 'would_refuse', null, mode, reason, now)
      if (mode === 'enforce') {
        this.log(`🛑 SPAWN-BREAKER ODBIJA spawn ${agentId} — ${reason}`)
        this.maybePrune(now)
        return {
          allowed: false, wouldBlock: true, mode, scope: 'bucket', consecutiveFailures: 0,
          openUntilMs: null, alarm: false, blockedCount: 0, bucket: 'empty', reason, sqlError,
        }
      }
      this.log(`👁️ SPAWN-BREAKER SHADOW: ${agentId} — BI odbio spawn (${reason})`)
      this.maybePrune(now)
      return {
        allowed: true, wouldBlock: true, mode, scope: 'bucket', consecutiveFailures: 0,
        openUntilMs: null, alarm: false, blockedCount: 0, bucket: 'empty',
        reason: `shadow: ${reason} — spawn NIJE zaustavljen`, sqlError,
      }
    }

    this.maybePrune(now)
    return {
      allowed: true, wouldBlock: false, mode, scope: '', consecutiveFailures: 0,
      openUntilMs: null, alarm: false, blockedCount: 0, bucket: bucketState,
      reason: 'ok', sqlError,
    }
  }

  /** Spawn je uspio → niz uzastopnih odbijenica je prekinut, osigurač se gasi. */
  recordSuccess(agentId: string): void {
    const mode = this.mode(agentId)
    if (mode === 'off') return
    const now = this.now()
    for (const scope of this.scopesFor(agentId)) {
      const st = this.readState(scope)
      if (st.consecutiveFailures === 0 && st.openUntilMs === 0) continue
      st.consecutiveFailures = 0
      st.openUntilMs = 0
      st.openedMs = 0
      st.alarmMode = null
      st.lastReason = null
      this.writeState(st)
      this.appendLog(scope, agentId, 'reset', null, mode, 'uspješan spawn', now)
    }
  }

  /**
   * Spawn je pao. `kind='rejected'` broji (fail-CLOSED), `kind='unknown'` NE broji
   * (fail-OPEN) — samo ostavlja trag.
   *
   * Vraća stanje agentova opsega nakon knjiženja (za dnevnik i alarm).
   */
  recordFailure(agentId: string, kind: SpawnFailureKind, reason: string): {
    counted: boolean
    opened: boolean
    consecutiveFailures: number
    openUntilMs: number | null
    scopes: string[]
  } {
    const mode = this.mode(agentId)
    const now = this.now()
    if (mode === 'off') {
      return { counted: false, opened: false, consecutiveFailures: 0, openUntilMs: null, scopes: [] }
    }
    if (kind !== 'rejected') {
      // FAIL-OPEN: ne znamo je li kriv račun ili zadatak → ne diramo osigurač.
      this.appendLog(`agent:${agentId}`, agentId, 'ignored', kind, mode, reason, now)
      this.log(`ℹ️ SpawnBreaker: pad ${agentId} nije odbijenica (${reason}) — osigurač netaknut (fail-open)`)
      return { counted: false, opened: false, consecutiveFailures: 0, openUntilMs: null, scopes: [] }
    }

    let opened = false
    let agentFailures = 0
    let agentOpenUntil: number | null = null
    const openedScopes: string[] = []

    for (const scope of this.scopesFor(agentId)) {
      const st = this.readState(scope)
      st.consecutiveFailures += 1
      st.lastFailMs = now
      st.lastReason = reason.slice(0, 200)
      const limit = this.thresholdFor(scope)
      if (st.consecutiveFailures >= limit && st.openUntilMs <= now) {
        st.openUntilMs = now + this.openMs
        st.openedMs = now
        st.episodes += 1
        st.alarmMode = null      // nova epizoda → novi alarm
        opened = true
        openedScopes.push(scope)
        this.log(`🛑 SPAWN-BREAKER OTVOREN (${scope}): ${st.consecutiveFailures}/${limit} uzastopnih odbijenica`
          + ` [${reason}] — spawnovi se odbijaju sljedećih ${Math.round(this.openMs / 60000)} min`)
        this.appendLog(scope, agentId, 'open', kind, mode, `${st.consecutiveFailures}/${limit}: ${reason}`, now)
      } else {
        this.appendLog(scope, agentId, 'fail', kind, mode, `${st.consecutiveFailures}/${limit}: ${reason}`, now)
      }
      this.writeState(st)
      if (scope !== GLOBAL_SCOPE) {
        agentFailures = st.consecutiveFailures
        agentOpenUntil = st.openUntilMs > 0 ? st.openUntilMs : null
      }
    }

    return { counted: true, opened, consecutiveFailures: agentFailures, openUntilMs: agentOpenUntil, scopes: openedScopes }
  }

  /** Stanje opsega (dijagnostika / alat). */
  state(scope: string): ScopeState {
    return this.readState(scope)
  }

  /** Svi otvoreni osigurači (alat `spawn-breaker-status.ts`). */
  openScopes(): ScopeState[] {
    const now = this.now()
    try {
      this.ensureSchema()
      const rows = this.db.query(`SELECT * FROM spawn_breaker_state WHERE open_until_ms > ?`).all(now) as any[]
      return rows.map(rowToState)
    } catch {
      return [...this.mem.values()].filter(s => s.openUntilMs > now)
    }
  }

  /** Ručni reset (operater). Vraća broj obrisanih opsega. */
  reset(agentId?: string): number {
    let n = 0
    try {
      this.ensureSchema()
      const r = agentId
        ? this.db.run(`DELETE FROM spawn_breaker_state WHERE scope IN (?, ?)`, [`agent:${agentId}`, GLOBAL_SCOPE])
        : this.db.run(`DELETE FROM spawn_breaker_state`)
      n = (r as any)?.changes ?? 0
    } catch { /* memorija se svejedno čisti */ }
    if (agentId) { this.mem.delete(`agent:${agentId}`); this.mem.delete(GLOBAL_SCOPE) }
    else this.mem.clear()
    // Ručni reset znači „propusti me sada": prazna kanta bi ga poništila već na sljedećem
    // pozivu, pa se i strop brzine vraća na pun kapacitet.
    try { this.bucket?.init(SPAWN_BUCKET, this.bucketCapacity, this.bucketRefill, true) } catch { /* kanta nije kritični put */ }
    this.bucketReady = true
    return n
  }

  // ─── interno ───────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    if (this.schemaReady) return
    for (const stmt of SCHEMA) this.db.run(stmt)
    this.schemaReady = true
  }

  /**
   * Stanje opsega: SQL je izvor istine, memorija je fallback. Kad oba postoje, uzima se
   * PARANOIDNI maksimum (kao SendBreaker: blokira ako BILO KOJI sloj kaže „prag prijeđen"),
   * jer je propuštanje skuplje od jednog nepotrebnog čekanja.
   */
  private readState(scope: string, onError?: (e: string) => void): ScopeState {
    const memSt = this.mem.get(scope)
    let sqlSt: ScopeState | null = null
    try {
      this.ensureSchema()
      const row = this.db.query(`SELECT * FROM spawn_breaker_state WHERE scope=?`).get(scope) as any
      if (row) sqlSt = rowToState(row)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      onError?.(msg)
      this.log(`⚠️ SpawnBreaker SQL čitanje palo (fallback na memoriju): ${msg}`)
    }
    if (!sqlSt && !memSt) return emptyState(scope)
    if (!sqlSt) return { ...memSt! }
    if (!memSt) return sqlSt
    return {
      scope,
      consecutiveFailures: Math.max(sqlSt.consecutiveFailures, memSt.consecutiveFailures),
      lastFailMs: Math.max(sqlSt.lastFailMs, memSt.lastFailMs),
      openUntilMs: Math.max(sqlSt.openUntilMs, memSt.openUntilMs),
      openedMs: Math.max(sqlSt.openedMs, memSt.openedMs),
      episodes: Math.max(sqlSt.episodes, memSt.episodes),
      blockedCount: Math.max(sqlSt.blockedCount, memSt.blockedCount),
      alarmMode: sqlSt.alarmMode ?? memSt.alarmMode,
      lastReason: sqlSt.lastReason ?? memSt.lastReason,
    }
  }

  private writeState(st: ScopeState, onError?: (e: string) => void): void {
    this.mem.set(st.scope, { ...st })
    try {
      this.ensureSchema()
      this.db.run(
        `INSERT INTO spawn_breaker_state
           (scope, consecutive_failures, last_fail_ms, open_until_ms, opened_ms, episodes, blocked_count, alarm_mode, last_reason, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
         ON CONFLICT(scope) DO UPDATE SET
           consecutive_failures=excluded.consecutive_failures,
           last_fail_ms=excluded.last_fail_ms,
           open_until_ms=excluded.open_until_ms,
           opened_ms=excluded.opened_ms,
           episodes=excluded.episodes,
           blocked_count=excluded.blocked_count,
           alarm_mode=excluded.alarm_mode,
           last_reason=excluded.last_reason,
           updated_at=datetime('now')`,
        [st.scope, st.consecutiveFailures, st.lastFailMs, st.openUntilMs, st.openedMs,
         st.episodes, st.blockedCount, st.alarmMode, st.lastReason]
      )
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      onError?.(msg)
      this.log(`⚠️ SpawnBreaker upis stanja pao (memorijski osigurač ostaje): ${msg}`)
    }
  }

  private appendLog(scope: string, agentId: string, event: string, kind: string | null, mode: SpawnBreakerMode, detail: string, now: number): void {
    try {
      this.ensureSchema()
      this.db.run(
        `INSERT INTO spawn_breaker_log (scope, agent_id, event, kind, mode, detail, created_ms)
         VALUES (?,?,?,?,?,?,?)`,
        [scope, agentId, event, kind, mode, detail.slice(0, 400), now]
      )
    } catch { /* forenzika nije kritični put */ }
  }

  private maybePrune(now: number): void {
    if (++this.checkCount % PRUNE_EVERY !== 0) return
    this.pruneLog(now)
  }

  /** Obreži dnevnik na retenciju (v. `resolveLogRetentionMs`). Vraća broj obrisanih redaka. */
  pruneLog(now: number = this.now()): number {
    try {
      const r = this.db.run(`DELETE FROM spawn_breaker_log WHERE created_ms < ?`, [now - resolveLogRetentionMs()])
      return (r as any)?.changes ?? 0
    } catch { return 0 /* forenzika nije kritični put */ }
  }
}

function rowToState(row: any): ScopeState {
  return {
    scope: row.scope,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastFailMs: row.last_fail_ms ?? 0,
    openUntilMs: row.open_until_ms ?? 0,
    openedMs: row.opened_ms ?? 0,
    episodes: row.episodes ?? 0,
    blockedCount: row.blocked_count ?? 0,
    alarmMode: row.alarm_mode ?? null,
    lastReason: row.last_reason ?? null,
  }
}

/** Tekst alarma — jedan po epizodi, kratak i akcijski (obrazac `SendBreaker.formatAlarm`). */
export function formatSpawnAlarm(agentId: string, v: SpawnGateVerdict): string {
  const head = v.mode === 'enforce' ? '🛑 SPAWN-BREAKER OTVOREN' : '👁️ SPAWN-BREAKER (shadow, ne odbija)'
  const until = v.openUntilMs ? new Date(v.openUntilMs).toLocaleTimeString('hr-HR') : 'n/d'
  return `${head}\nAgent: ${agentId} · opseg: ${v.scope || 'n/d'}\n`
    + `${v.consecutiveFailures} uzastopnih odbijenih spawnova (${v.reason}).\n`
    + `Novi spawnovi se ${v.mode === 'enforce' ? 'ODBIJAJU' : 'i dalje pokreću (shadow)'} do ${until}.\n`
    + `Ručni reset: bun ~/.claude/regoc/tools/spawn-breaker-status.ts --reset ${agentId}`
}
