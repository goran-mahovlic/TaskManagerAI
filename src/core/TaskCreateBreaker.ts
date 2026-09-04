// ─── TaskCreateBreaker ───────────────────────────────────────────────────────
// M2 / TASK-4628 (PRJ REGOC_SYSTEM): OSIGURAČ NA VRATIMA STVARANJA ZADATAKA.
//
// NALAZ (docs/ISTRAZIVANJE-neuspjesi-i-greske.md §1 i §4 M2): pravi uzrok incidenta
// 02.09.2026. nije 683 spawna nego **686 ZADATAKA u dva sata**. `SpawnBreaker` (M1) stoji
// jedan korak PREKASNO: on vidi rafal tek kad je svaki od tih zadataka već u bazi i već
// zove `claude --print`. Echo-dispatch (izvještaj → novi zadatak → izvještaj) proizvodi
// zadatke brže nego što ih osigurač spawnova stigne odbiti, a svaki odbijeni spawn
// ostavlja zadatak koji netko kasnije mora ručno pospremiti.
//
// Mjereno nad živom `data/regoc.db` (2177 zadataka, 04.09.2026.):
//   • incident: ~7 zadataka/min kroz dva sata ≈ 420/h iz jednog izvora,
//   • normalan promet: medijan 2/h po izvoru, p99 24/h, najgori sat ikad 37/h,
//   • ukupno kroz sve izvore: najgori sat ikad 41/h.
// Otud pragovi: **30/h po izvoru** (13 od 2177 zadataka u cijeloj povijesti bi bilo
// odgođeno = 0,6 %) i **90/h globalno** (0 povijesnih pogodaka, a incident staje odmah).
//
// ŠTO RADI
//   1. Broji STVORENE zadatke po izvoru (`createdBy`) u POMIČNOM PROZORU od sat vremena.
//   2. Preko praga zadatak se NE odbacuje nego ide u RED ČEKANJA (`task_create_queue`) s
//      cijelim tijelom zahtjeva — ništa se ne gubi, sve se može pustiti ili odbaciti.
//   3. Uz to ide JEDNA dojava po epizodi (ne po zadatku — 686 poruka je isti kvar).
//   4. Red se prazni alatom `tools/task-create-queue.ts` (--list/--release/--drop).
//
// ZAŠTO POMIČNI PROZOR, A NE KANTA TOKENA: kriterij mjere je izrečen u zadatcima po satu i
// mora se moći provjeriti nad `tasks.created_at`. Kanta (SpawnBreaker) mjeri trenutačnu
// brzinu i ne zna reći „koliko ih je bilo u zadnjih sat vremena", pa se njezin prag ne bi
// mogao usporediti s poviješću.
//
// ODBIJEN ZAHTJEV NE TROŠI MJESTO: prozor broji samo ZAISTA STVORENE zadatke
// (`recordCreated`), pa provjera i knjiženje moraju biti dva poziva. Time rafal koji su
// odbila druga vrata (anti-echo, prazan opis) ne jede kvotu poštenom pošiljatelju.
//
// FAIL-OPEN NA VLASTITI KVAR: ako SQL sloj padne, vrata PROPUŠTAJU uz zapis (`sqlError`).
// Osigurač koji ruši dotok posla biva isključen, a isključen osigurač ne štiti nikoga.
// Suprotno je kod SpawnBreakera opravdano (tamo je dokaz „račun te ne pušta"); ovdje bi
// zatvaranje ingressa značilo da ploča prestaje primati posao.
//
// UVOĐENJE (features.json, hot-reload bez restarta) — isti obrazac kao SpawnBreaker:
//   taskCreateBreaker.enabled=false                 → OFF    (potpuni no-op)
//   taskCreateBreaker=true, taskCreateBreakerLive=false → SHADOW (mjeri, ništa ne odgađa)
//   taskCreateBreakerLive.enabled=true              → LIVE
//   taskCreateBreakerLive.sources=["regoc"]         → CANARY (provodi se samo za navedene)
//   taskCreateBreakerLive.exempt=["uvoz"]           → izuzeti izvori (masovni uvoz)
//
// Autorica: Kosjenka (Architect) · 2026-09-04 · TASK-4628

import { Database } from 'bun:sqlite'
import { isEnabled, getFlag } from './FeatureFlags'

// ─── Konfiguracija ───────────────────────────────────────────────────────────

/** Pomični prozor u kojem se broje stvoreni zadatci. */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000
/** Koliko novih zadataka smije JEDAN izvor (`createdBy`) u prozoru. */
export const DEFAULT_LIMIT_PER_SOURCE = 30
/** Koliko ih smije cijela ploča u prozoru — hvata rafal razmazan po više izvora. */
export const DEFAULT_GLOBAL_LIMIT = 90
/** Ime globalnog opsega (izvor se nikad ne smije tako zvati). */
export const GLOBAL_SCOPE = '__global__'
/** Koliko dugo se čuva dnevnik događaja (prozor + forenzika). */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Rezanje dnevnika najviše jednom u 10 min — vremenski, ne po brojaču poziva.
 *  (SpawnBreaker reže svakih 200 provjera; pri 3,3 spawna/h to je ~60 h — praktički nikad.) */
const PRUNE_EVERY_MS = 10 * 60 * 1000

export type TaskCreateMode = 'off' | 'shadow' | 'enforce'
export type QueueStatus = 'queued' | 'released' | 'dropped'

export interface TaskCreateVerdict {
  /** Smije li zadatak stvarno nastati. U shadow modu UVIJEK true. */
  allowed: boolean
  /** Bi li osigurač odgodio da je u enforce modu (shadow usporedba). */
  wouldQueue: boolean
  mode: TaskCreateMode
  /** Opseg koji je odlučio: `source:<izvor>`, `__global__` ili prazno. */
  scope: string
  /** Koliko je zadataka tog opsega u prozoru. */
  count: number
  /** Prag koji vrijedi za taj opseg. */
  limit: number
  windowMs: number
  /** Za koliko ms se oslobađa prvo mjesto (0 kad je slobodno). */
  retryAfterMs: number
  /** Treba li poslati dojavu — true točno jednom po epizodi i modu. */
  alarm: boolean
  /** Koliko je zadataka do sada odgođeno u ovoj epizodi. */
  queuedCount: number
  reason: string
  /** Je li SQL sloj otkazao (verdikt je fail-open). */
  sqlError?: string
}

export interface QueuedTask {
  id: number
  source: string
  title: string
  payload: string
  reason: string | null
  mode: string
  status: QueueStatus
  queuedMs: number
  resolvedMs: number | null
  resolvedNote: string | null
  taskId: string | null
}

export interface TaskCreateBreakerOptions {
  /** Prag po izvoru. */
  limitPerSource?: number
  /** Globalni prag. */
  globalLimit?: number
  /** Širina pomičnog prozora. */
  windowMs?: number
  /** Izvori koji se ne ograničavaju (npr. masovni uvoz). */
  exemptSources?: string[]
  /** Injektabilni sat — testovi vrte sat bez sleepa. */
  now?: () => number
  /** Preskoči FeatureFlags i prisili mod (testovi / alat). */
  modeOverride?: TaskCreateMode
  logger?: (msg: string) => void
}

// ─── Mod iz feature flagova ──────────────────────────────────────────────────

function liveFlagField<T>(field: string): T | null {
  const live = getFlag('taskCreateBreakerLive') as Record<string, unknown> | undefined
  const v = live ? (live as any)[field] : undefined
  return Array.isArray(v) ? (v as unknown as T) : null
}

/** Izuzeti izvori iz features.json (`taskCreateBreakerLive.exempt`). */
export function exemptFromFlags(): string[] {
  return liveFlagField<string[]>('exempt') ?? []
}

export function resolveTaskCreateMode(source: string): TaskCreateMode {
  if (!isEnabled('taskCreateBreaker')) return 'off'
  if (!isEnabled('taskCreateBreakerLive')) return 'shadow'
  const sources = liveFlagField<string[]>('sources')
  if (sources && sources.length > 0 && !sources.includes(source)) return 'shadow'
  return 'enforce'
}

// ─── Shema (ADITIVNA — samo CREATE IF NOT EXISTS) ────────────────────────────

const SCHEMA = [
  // Dnevnik STVORENIH zadataka — jedini izvor brojanja u prozoru.
  `CREATE TABLE IF NOT EXISTS task_create_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source TEXT NOT NULL,
     task_id TEXT,
     mode TEXT,
     created_ms INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_task_create_log_time ON task_create_log(created_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_task_create_log_source ON task_create_log(source, created_ms)`,
  // Red čekanja — cijelo tijelo zahtjeva, da se ništa ne izgubi.
  `CREATE TABLE IF NOT EXISTS task_create_queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source TEXT NOT NULL,
     title TEXT,
     payload TEXT NOT NULL,
     reason TEXT,
     mode TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued',
     queued_ms INTEGER NOT NULL,
     resolved_ms INTEGER,
     resolved_note TEXT,
     task_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_task_create_queue_status ON task_create_queue(status, queued_ms)`,
  // Stanje epizode — nosi „jedan alarm po epizodi".
  `CREATE TABLE IF NOT EXISTS task_create_breaker_state (
     scope TEXT PRIMARY KEY,
     episodes INTEGER NOT NULL DEFAULT 0,
     first_over_ms INTEGER NOT NULL DEFAULT 0,
     last_over_ms INTEGER NOT NULL DEFAULT 0,
     queued_count INTEGER NOT NULL DEFAULT 0,
     alarm_mode TEXT,
     last_reason TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
]

interface ScopeState {
  scope: string
  episodes: number
  firstOverMs: number
  lastOverMs: number
  queuedCount: number
  alarmMode: string | null
  lastReason: string | null
}

function emptyState(scope: string): ScopeState {
  return { scope, episodes: 0, firstOverMs: 0, lastOverMs: 0, queuedCount: 0, alarmMode: null, lastReason: null }
}

function rowToState(row: any): ScopeState {
  return {
    scope: row.scope,
    episodes: row.episodes ?? 0,
    firstOverMs: row.first_over_ms ?? 0,
    lastOverMs: row.last_over_ms ?? 0,
    queuedCount: row.queued_count ?? 0,
    alarmMode: row.alarm_mode ?? null,
    lastReason: row.last_reason ?? null,
  }
}

// ─── Osigurač ────────────────────────────────────────────────────────────────

export class TaskCreateBreaker {
  private db: Database
  private limit: number
  private globalLimit: number
  private windowMs: number
  private exempt: Set<string>
  private now: () => number
  private modeOverride?: TaskCreateMode
  private log: (msg: string) => void

  private schemaReady = false
  private lastPruneMs = 0
  /** Memorijski sloj: osigurač preživi pad SQL-a barem unutar procesa. */
  private mem = new Map<string, ScopeState>()

  constructor(db: Database, opts: TaskCreateBreakerOptions = {}) {
    this.db = db
    this.limit = opts.limitPerSource ?? DEFAULT_LIMIT_PER_SOURCE
    this.globalLimit = opts.globalLimit ?? DEFAULT_GLOBAL_LIMIT
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.exempt = new Set(opts.exemptSources ?? [])
    this.now = opts.now ?? (() => Date.now())
    this.modeOverride = opts.modeOverride
    this.log = opts.logger ?? (() => {})
  }

  mode(source: string): TaskCreateMode {
    return this.modeOverride ?? resolveTaskCreateMode(source)
  }

  /** Izuzet izvor — iz konstruktora ILI iz živog flaga (hot-reload bez restarta). */
  private isExempt(source: string): boolean {
    if (this.exempt.has(source)) return true
    try { return exemptFromFlags().includes(source) } catch { return false }
  }

  private scopesFor(source: string): Array<{ scope: string; limit: number }> {
    return [
      { scope: `source:${source}`, limit: this.limit },
      { scope: GLOBAL_SCOPE, limit: this.globalLimit },
    ]
  }

  /**
   * Smije li zadatak nastati? Poziva se NA INGRESSU, prije `createTask`.
   * NE troši mjesto — mjesto se knjiži tek `recordCreated` kad zadatak stvarno nastane.
   */
  check(source: string): TaskCreateVerdict {
    const mode = this.mode(source)
    const now = this.now()
    const base = {
      mode, windowMs: this.windowMs, retryAfterMs: 0, alarm: false, queuedCount: 0,
    }
    if (mode === 'off') {
      return { ...base, allowed: true, wouldQueue: false, scope: '', count: 0, limit: this.limit, reason: 'osigurač isključen' }
    }
    if (this.isExempt(source)) {
      return { ...base, allowed: true, wouldQueue: false, scope: '', count: 0, limit: this.limit, reason: `izvor '${source}' je izuzet` }
    }

    let sqlError: string | undefined
    const onErr = (e: string) => { sqlError = sqlError ?? e }

    for (const { scope, limit } of this.scopesFor(source)) {
      const count = this.countInWindow(scope, now, onErr)
      if (count < limit) continue

      // ── Preko praga ──
      const st = this.readState(scope, onErr)
      const isNewEpisode = st.firstOverMs === 0 || now - st.lastOverMs > this.windowMs
      if (isNewEpisode) {
        st.episodes += 1
        st.firstOverMs = now
        st.queuedCount = 0
        st.alarmMode = null              // nova epizoda → nova dojava
      }
      st.lastOverMs = now
      const alarm = st.alarmMode !== mode
      st.alarmMode = mode
      if (mode === 'enforce') st.queuedCount += 1
      st.lastReason = `${count}/${limit} u ${Math.round(this.windowMs / 60000)} min`
      this.writeState(st, onErr)

      const retryAfterMs = this.retryAfterMs(scope, limit, count, now, onErr)
      const min = Math.max(1, Math.round(retryAfterMs / 60000))
      const reason = `strop stvaranja zadataka (${scope}): ${count}/${limit} u zadnjih `
        + `${Math.round(this.windowMs / 60000)} min — prvo mjesto se oslobađa za ~${min} min`

      if (mode === 'shadow') {
        this.log(`👁️ TASK-BREAKER SHADOW: '${source}' — BI odgodio zadatak (${reason})`)
        this.maybePrune(now)
        return {
          ...base, allowed: true, wouldQueue: true, scope, count, limit,
          retryAfterMs, alarm, queuedCount: st.queuedCount,
          reason: `shadow: ${reason} — zadatak NIJE odgođen`, sqlError,
        }
      }
      this.log(`🛑 TASK-BREAKER ODGAĐA zadatak izvora '${source}' — ${reason} (odgođeno u epizodi: ${st.queuedCount})`)
      this.maybePrune(now)
      return {
        ...base, allowed: false, wouldQueue: true, scope, count, limit,
        retryAfterMs, alarm, queuedCount: st.queuedCount, reason, sqlError,
      }
    }

    // ── Ispod praga: ako je epizoda bila otvorena, zatvori je ──
    this.closeEpisodes(source, now, onErr)
    this.maybePrune(now)
    return {
      ...base, allowed: true, wouldQueue: false, scope: '', limit: this.limit,
      count: this.countInWindow(`source:${source}`, now, onErr), reason: 'ok', sqlError,
    }
  }

  /** Zadatak je STVARNO nastao — tek to troši mjesto u prozoru. */
  recordCreated(source: string, taskId?: string | null): void {
    const mode = this.mode(source)
    if (mode === 'off') return
    try {
      this.ensureSchema()
      this.db.run(
        `INSERT INTO task_create_log (source, task_id, mode, created_ms) VALUES (?,?,?,?)`,
        [source, taskId ?? null, mode, this.now()]
      )
    } catch (e: any) {
      this.log(`⚠️ TaskCreateBreaker: upis događaja pao (${String(e?.message ?? e)}) — prozor je nepotpun`)
    }
  }

  /** Koliko je zadataka u prozoru za dani opseg (dijagnostika/test). */
  windowCount(scope: string): number {
    return this.countInWindow(scope, this.now())
  }

  /** Odgođeni zadatak ide u red S CIJELIM TIJELOM ZAHTJEVA — ništa se ne gubi. */
  enqueue(source: string, payload: unknown, reason: string): { id: number; position: number } {
    const now = this.now()
    const body = JSON.stringify(payload ?? {})
    const title = String((payload as any)?.title ?? '').slice(0, 200)
    try {
      this.ensureSchema()
      this.db.run(
        `INSERT INTO task_create_queue (source, title, payload, reason, mode, status, queued_ms)
         VALUES (?,?,?,?,?,'queued',?)`,
        [source, title, body, reason.slice(0, 400), this.mode(source), now]
      )
      const id = Number((this.db.query(`SELECT last_insert_rowid() AS id`).get() as any)?.id ?? 0)
      const position = Number((this.db.query(
        `SELECT COUNT(*) AS n FROM task_create_queue WHERE status='queued' AND source=?`
      ).get(source) as any)?.n ?? 0)
      return { id, position }
    } catch (e: any) {
      // Red je ovdje zadnja obrana od gubitka posla — ako i on padne, glasno u dnevnik.
      this.log(`⛔ TaskCreateBreaker: ZADATAK IZGUBLJEN, red čekanja nedostupan (${String(e?.message ?? e)}): ${title}`)
      return { id: 0, position: 0 }
    }
  }

  queuedList(opts: { status?: QueueStatus; source?: string; limit?: number } = {}): QueuedTask[] {
    const status = opts.status ?? 'queued'
    try {
      this.ensureSchema()
      const rows = opts.source
        ? this.db.query(`SELECT * FROM task_create_queue WHERE status=? AND source=? ORDER BY queued_ms ASC LIMIT ?`)
            .all(status, opts.source, opts.limit ?? 500) as any[]
        : this.db.query(`SELECT * FROM task_create_queue WHERE status=? ORDER BY queued_ms ASC LIMIT ?`)
            .all(status, opts.limit ?? 500) as any[]
      return rows.map(r => ({
        id: r.id, source: r.source, title: r.title ?? '', payload: r.payload,
        reason: r.reason ?? null, mode: r.mode, status: r.status as QueueStatus,
        queuedMs: r.queued_ms, resolvedMs: r.resolved_ms ?? null,
        resolvedNote: r.resolved_note ?? null, taskId: r.task_id ?? null,
      }))
    } catch { return [] }
  }

  markReleased(id: number, taskId: string): void {
    this.resolve(id, 'released', `pušten kao ${taskId}`, taskId)
  }

  markDropped(id: number, why: string): void {
    this.resolve(id, 'dropped', why, null)
  }

  private resolve(id: number, status: QueueStatus, note: string, taskId: string | null): void {
    try {
      this.ensureSchema()
      this.db.run(
        `UPDATE task_create_queue SET status=?, resolved_ms=?, resolved_note=?, task_id=? WHERE id=?`,
        [status, this.now(), note.slice(0, 400), taskId, id]
      )
    } catch (e: any) {
      this.log(`⚠️ TaskCreateBreaker: zatvaranje reda #${id} palo: ${String(e?.message ?? e)}`)
    }
  }

  /** Broj zadataka po opsegu u prozoru — za alat i ploču. */
  stats(): Array<{ scope: string; count: number; limit: number }> {
    const now = this.now()
    try {
      this.ensureSchema()
      const rows = this.db.query(
        `SELECT source, COUNT(*) n FROM task_create_log WHERE created_ms > ? GROUP BY source ORDER BY n DESC`
      ).all(now - this.windowMs) as any[]
      const out = rows.map(r => ({ scope: `source:${r.source}`, count: r.n, limit: this.limit }))
      out.push({ scope: GLOBAL_SCOPE, count: rows.reduce((s, r) => s + r.n, 0), limit: this.globalLimit })
      return out
    } catch { return [] }
  }

  /** Stanje epizode (dijagnostika / alat). */
  state(scope: string): ScopeState {
    return this.readState(scope)
  }

  /** Ručno brisanje prozora (operater) — vraća broj obrisanih događaja. */
  reset(source?: string): number {
    try {
      this.ensureSchema()
      const r = source
        ? this.db.run(`DELETE FROM task_create_log WHERE source=?`, [source])
        : this.db.run(`DELETE FROM task_create_log`)
      if (source) { this.db.run(`DELETE FROM task_create_breaker_state WHERE scope IN (?, ?)`, [`source:${source}`, GLOBAL_SCOPE]); this.mem.delete(`source:${source}`); this.mem.delete(GLOBAL_SCOPE) }
      else { this.db.run(`DELETE FROM task_create_breaker_state`); this.mem.clear() }
      return (r as any)?.changes ?? 0
    } catch { return 0 }
  }

  // ─── interno ───────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    if (this.schemaReady) return
    for (const stmt of SCHEMA) this.db.run(stmt)
    this.schemaReady = true
  }

  private countInWindow(scope: string, now: number, onErr?: (e: string) => void): number {
    try {
      this.ensureSchema()
      const since = now - this.windowMs
      const row = scope === GLOBAL_SCOPE
        ? this.db.query(`SELECT COUNT(*) n FROM task_create_log WHERE created_ms > ?`).get(since) as any
        : this.db.query(`SELECT COUNT(*) n FROM task_create_log WHERE source=? AND created_ms > ?`)
            .get(scope.slice('source:'.length), since) as any
      return Number(row?.n ?? 0)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      onErr?.(msg)
      this.log(`⚠️ TaskCreateBreaker: brojanje prozora palo (propuštam — fail-open): ${msg}`)
      return 0
    }
  }

  /**
   * Kad se oslobađa PRVO mjesto. Mora isteći (count − limit + 1)-vi najstariji događaj:
   * u enforce modu je count === limit pa je to najstariji (offset 0), ali u sjeni prozor
   * naraste preko praga, i tada bi „najstariji" dao lažno kratak rok.
   */
  private retryAfterMs(scope: string, limit: number, count: number, now: number, onErr?: (e: string) => void): number {
    try {
      this.ensureSchema()
      const since = now - this.windowMs
      const offset = Math.max(0, count - limit)
      const row = scope === GLOBAL_SCOPE
        ? this.db.query(`SELECT created_ms FROM task_create_log WHERE created_ms > ? ORDER BY created_ms ASC LIMIT 1 OFFSET ?`)
            .get(since, offset) as any
        : this.db.query(`SELECT created_ms FROM task_create_log WHERE source=? AND created_ms > ? ORDER BY created_ms ASC LIMIT 1 OFFSET ?`)
            .get(scope.slice('source:'.length), since, offset) as any
      if (!row) return 0
      return Math.max(0, row.created_ms + this.windowMs - now)
    } catch (e: any) {
      onErr?.(String(e?.message ?? e))
      return 0
    }
  }

  /** Ispod praga → epizoda je gotova; sljedeći prelazak praga daje NOVU dojavu. */
  private closeEpisodes(source: string, now: number, onErr?: (e: string) => void): void {
    for (const { scope } of this.scopesFor(source)) {
      const st = this.readState(scope, onErr)
      if (st.firstOverMs === 0 && st.alarmMode === null) continue
      st.firstOverMs = 0
      st.alarmMode = null
      this.writeState(st, onErr)
    }
  }

  private readState(scope: string, onErr?: (e: string) => void): ScopeState {
    const memSt = this.mem.get(scope)
    try {
      this.ensureSchema()
      const row = this.db.query(`SELECT * FROM task_create_breaker_state WHERE scope=?`).get(scope) as any
      if (row) return rowToState(row)
    } catch (e: any) {
      onErr?.(String(e?.message ?? e))
    }
    return memSt ? { ...memSt } : emptyState(scope)
  }

  private writeState(st: ScopeState, onErr?: (e: string) => void): void {
    this.mem.set(st.scope, { ...st })
    try {
      this.ensureSchema()
      this.db.run(
        `INSERT INTO task_create_breaker_state
           (scope, episodes, first_over_ms, last_over_ms, queued_count, alarm_mode, last_reason, updated_at)
         VALUES (?,?,?,?,?,?,?,datetime('now'))
         ON CONFLICT(scope) DO UPDATE SET
           episodes=excluded.episodes,
           first_over_ms=excluded.first_over_ms,
           last_over_ms=excluded.last_over_ms,
           queued_count=excluded.queued_count,
           alarm_mode=excluded.alarm_mode,
           last_reason=excluded.last_reason,
           updated_at=datetime('now')`,
        [st.scope, st.episodes, st.firstOverMs, st.lastOverMs, st.queuedCount, st.alarmMode, st.lastReason]
      )
    } catch (e: any) {
      onErr?.(String(e?.message ?? e))
    }
  }

  private maybePrune(now: number): void {
    if (now - this.lastPruneMs < PRUNE_EVERY_MS) return
    this.lastPruneMs = now
    try {
      this.db.run(`DELETE FROM task_create_log WHERE created_ms < ?`, [now - LOG_RETENTION_MS])
    } catch { /* forenzika nije kritični put */ }
  }
}

/** Tekst dojave — jedan po epizodi, kratak i akcijski (obrazac `formatSpawnAlarm`). */
export function formatTaskCreateAlarm(source: string, v: TaskCreateVerdict, queuedNow: number): string {
  const head = v.mode === 'enforce'
    ? '🛑 OSIGURAČ STVARANJA ZADATAKA — RAFAL ZAUSTAVLJEN'
    : '👁️ OSIGURAČ STVARANJA ZADATAKA (shadow, ne zaustavlja)'
  const min = Math.max(1, Math.round(v.retryAfterMs / 60000))
  return `${head}\n`
    + `Izvor: ${source} · opseg: ${v.scope || 'n/d'}\n`
    + `${v.count} novih zadataka u ${Math.round(v.windowMs / 60000)} min (prag ${v.limit}).\n`
    + `Novi zadatci ${v.mode === 'enforce' ? 'IDU U RED ČEKANJA' : 'i dalje prolaze (shadow)'}; u redu ih je ${queuedNow}.\n`
    + `Prvo mjesto slobodno za ~${min} min.\n`
    + `Pregled i pražnjenje: bun ~/.claude/regoc/tools/task-create-queue.ts --list`
}
