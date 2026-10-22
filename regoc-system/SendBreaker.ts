/**
 * SendBreaker.ts — Self-circuit-breaker NA STRANI POŠILJATELJA (R5 / TASK-2565)
 *
 * Problem (incident 06-19): RegocDaemon ima breaker za DOLAZNE identične poruke
 * (RegocDaemon.ts r.2628, `circuitBreakerState` Map), ali agent koji ŠALJE može
 * i dalje bljuvati — kosjenka→regoc 1894 identične poruke u 3h + regoc→kosjenka
 * 1755 odgovora. Postojeći breaker je usto in-memory: restart procesa ga briše.
 *
 * Rješenje (dva sloja, oba obavezna):
 *   1. SQL sloj u messages.db (tablice `agent_send_log` + `agent_send_halt`) —
 *      PREŽIVLJAVA restart procesa i dijeli stanje između procesa (WAL).
 *   2. In-memory sloj — radi i kad SQL padne (fail-safe protiv fail-opena).
 *   Blokira ako BILO KOJI sloj kaže "prag prijeđen" (paranoidno OR, ne AND).
 *
 * Pravilo: > THRESHOLD (5) identičnih poruka istog agenta na istom kanalu u
 * 10 min → HALT slanja + TOČNO JEDAN alarm. HALT se produžuje dok god spam
 * traje, a sam se gasi nakon 10 min tišine (self-healing, bez ručne intervencije).
 *
 * SIGURNO UVOĐENJE (features.json, hot-reload bez restarta):
 *   sendBreaker.enabled=false                      → OFF   (potpuni no-op, ni jedan SQL upit)
 *   sendBreaker=true, sendBreakerLive=false        → SHADOW(samo mjeri i logira, NIŠTA ne blokira)
 *   sendBreakerLive.enabled=true                   → LIVE  (stvarno blokira)
 *   sendBreakerLive.agents=["kosjenka"]            → CANARY(enforce samo za navedene, ostali shadow)
 *
 * Fail-open po dizajnu: greška u breakeru NIKAD ne smije zaustaviti legitiman
 * rad — na SQL grešci propuštamo poruku, ali in-memory sloj i dalje čuva prag.
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { isEnabled, getFlag } from './FeatureFlags'

// ─── Konfiguracija ──────────────────────────────────────────────────

/** > 5 identičnih u prozoru → HALT (dakle 5 prolazi, 6. je blokiran). */
export const DEFAULT_THRESHOLD = 5
/** Prozor mjerenja: 10 minuta. */
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000
/** Retencija forenzičkog loga. */
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000
/** Svakih N provjera pokušaj čišćenja starih redaka. */
const PRUNE_EVERY = 200

export type BreakerMode = 'off' | 'shadow' | 'enforce'
export type SendChannel = 'message' | 'telegram' | string

export interface BreakerVerdict {
  /** Smije li se poruka stvarno poslati. U shadow modu UVIJEK true. */
  allowed: boolean
  /** Bi li breaker blokirao da je u enforce modu (za shadow usporedbu). */
  wouldBlock: boolean
  mode: BreakerMode
  hash: string
  /** Broj identičnih POSLANIH poruka u prozoru prije ove. */
  recentCount: number
  /** Je li halt aktivan (ovaj poziv ga je otvorio ili produžio). */
  halted: boolean
  /** Treba li pozivatelj poslati alarm — true točno jednom po haltu/modu. */
  alarm: boolean
  /** Koliko je poruka do sada blokirano pod ovim haltom. */
  blockedCount: number
  reason: string
  /** Je li SQL sloj otkazao (verdikt se oslonio samo na memoriju). */
  sqlError?: string
}

export interface SendBreakerOptions {
  threshold?: number
  windowMs?: number
  /** Injektabilni sat — testovi mogu vrtjeti vrijeme bez sleepa. */
  now?: () => number
  /** Preskoči FeatureFlags i prisili mod (testovi / alat). */
  modeOverride?: BreakerMode
  logger?: (msg: string) => void
}

// ─── Normalizacija + hash ───────────────────────────────────────────

/**
 * Normalizira sadržaj prije hashiranja: mikro-varijacije (timestampi, PID-ovi,
 * whitespace) ne smiju zaobići breaker — 06-19 poruke su nosile promjenjivi
 * timestamp u tijelu. Konzervativno: mičemo samo očite volatilne tokene.
 */
export function normalizeContent(raw: string): string {
  return String(raw ?? '')
    // ISO-8601 timestamp (2026-06-19T17:25:11.123Z / +02:00)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    // goli sat [17:25:11] ili 17:25:11
    .replace(/\b\d{2}:\d{2}(?::\d{2})?\b/g, '<TS>')
    // epoch ms / PID-oliki dugi brojevi
    .replace(/\b\d{9,}\b/g, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function hashContent(raw: string): string {
  return createHash('sha256').update(normalizeContent(raw)).digest('hex').substring(0, 32)
}

// ─── Mod iz feature flagova ─────────────────────────────────────────

export function resolveMode(agentId: string): BreakerMode {
  if (!isEnabled('sendBreaker')) return 'off'
  if (!isEnabled('sendBreakerLive')) return 'shadow'
  // CANARY: ako flag nosi listu `agents`, enforce vrijedi samo za njih.
  const live = getFlag('sendBreakerLive') as (Record<string, unknown> | undefined)
  const agents = live && Array.isArray((live as any).agents) ? (live as any).agents as string[] : null
  if (agents && agents.length > 0 && !agents.includes(agentId)) return 'shadow'
  return 'enforce'
}

// ─── Shema (ADITIVNA — samo CREATE IF NOT EXISTS) ───────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_send_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     created_ms INTEGER NOT NULL,
     mode TEXT NOT NULL DEFAULT 'shadow',
     preview TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_send_log_window
     ON agent_send_log(agent_id, channel, content_hash, created_ms)`,
  `CREATE TABLE IF NOT EXISTS agent_send_halt (
     agent_id TEXT NOT NULL,
     channel TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     first_seen_ms INTEGER NOT NULL,
     tripped_ms INTEGER NOT NULL,
     mode TEXT NOT NULL DEFAULT 'shadow',
     alarm_sent INTEGER NOT NULL DEFAULT 0,
     alarm_mode TEXT,
     blocked_count INTEGER NOT NULL DEFAULT 0,
     preview TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (agent_id, channel, content_hash)
   )`,
]

// ─── Breaker ────────────────────────────────────────────────────────

export class SendBreaker {
  private db: Database
  private agentId: string
  private threshold: number
  private windowMs: number
  private now: () => number
  private modeOverride?: BreakerMode
  private log: (msg: string) => void

  private schemaReady = false
  private checkCount = 0
  /** In-memory sloj: key → timestampi POSLANIH poruka (fail-safe kad SQL padne). */
  private mem = new Map<string, number[]>()
  /** In-memory alarm-once (dodatni osigurač ako halt tablica nije dostupna). */
  private memAlarmed = new Set<string>()

  constructor(db: Database, agentId: string, opts: SendBreakerOptions = {}) {
    this.db = db
    this.agentId = agentId
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.now = opts.now ?? (() => Date.now())
    this.modeOverride = opts.modeOverride
    this.log = opts.logger ?? (() => {})
  }

  /**
   * Zamijeni handle baze — za procese koji otvaraju/zatvaraju DB po pozivu
   * (npr. AgentWorker), a žele zadržati in-memory sloj između poziva.
   */
  setDb(db: Database): void {
    if (db === this.db) return
    this.db = db
    this.schemaReady = false
  }

  get mode(): BreakerMode {
    return this.modeOverride ?? resolveMode(this.agentId)
  }

  /**
   * Provjeri smije li se poruka poslati. Poziva se PRIJE stvarnog slanja.
   * Ako vrati allowed=true, poziv se broji kao "poslana" (ne zovi dvaput).
   */
  check(channel: SendChannel, content: string): BreakerVerdict {
    const mode = this.mode
    const hash = hashContent(content)

    if (mode === 'off') {
      return {
        allowed: true, wouldBlock: false, mode, hash, recentCount: 0,
        halted: false, alarm: false, blockedCount: 0, reason: 'breaker off',
      }
    }

    const now = this.now()
    const cutoff = now - this.windowMs
    const key = `${channel}:${hash}`
    const preview = String(content ?? '').substring(0, 120)

    // ── Sloj 2: in-memory (uvijek se računa, i kad SQL radi) ──
    const memHits = (this.mem.get(key) ?? []).filter(t => t > cutoff)
    this.mem.set(key, memHits)
    if (this.mem.size > 500) this.pruneMem(cutoff)

    // ── Sloj 1: SQL (preživljava restart, dijeli se između procesa) ──
    let sqlCount = 0
    let sqlHalt: any = null
    let sqlError: string | undefined
    try {
      this.ensureSchema()
      sqlHalt = this.db.query(
        `SELECT * FROM agent_send_halt WHERE agent_id=? AND channel=? AND content_hash=?`
      ).get(this.agentId, channel, hash) as any
      // Halt stariji od prozora = tišina ≥ prozor → sam se gasi.
      if (sqlHalt && sqlHalt.tripped_ms <= cutoff) {
        this.db.run(
          `DELETE FROM agent_send_halt WHERE agent_id=? AND channel=? AND content_hash=?`,
          [this.agentId, channel, hash]
        )
        sqlHalt = null
        this.memAlarmed.delete(key)
      }
      sqlCount = (this.db.query(
        `SELECT COUNT(*) AS n FROM agent_send_log
          WHERE agent_id=? AND channel=? AND content_hash=? AND created_ms > ?`
      ).get(this.agentId, channel, hash, cutoff) as any)?.n ?? 0
    } catch (e: any) {
      sqlError = String(e?.message ?? e)
      this.log(`⚠️ SendBreaker SQL greška (fallback na memoriju): ${sqlError}`)
    }

    const recentCount = Math.max(sqlCount, memHits.length)
    const haltActive = !!sqlHalt || this.memAlarmed.has(key)
    const wouldBlock = haltActive || recentCount >= this.threshold

    if (!wouldBlock) {
      // Propušteno → zabilježi kao poslano (oba sloja).
      memHits.push(now)
      this.recordSend(channel, hash, now, mode, preview, sqlError)
      this.maybePrune(now)
      return {
        allowed: true, wouldBlock: false, mode, hash, recentCount,
        halted: false, alarm: false, blockedCount: 0,
        reason: `ok (${recentCount + 1}/${this.threshold} u ${Math.round(this.windowMs / 60000)} min)`,
        sqlError,
      }
    }

    // ── Prag prijeđen: otvori ili produži HALT, odluči o alarmu ──
    let alarm = false
    let blockedCount = (sqlHalt?.blocked_count ?? 0) + 1
    try {
      this.ensureSchema()
      if (!sqlHalt) {
        const firstSeen = (this.db.query(
          `SELECT MIN(created_ms) AS m FROM agent_send_log
            WHERE agent_id=? AND channel=? AND content_hash=? AND created_ms > ?`
        ).get(this.agentId, channel, hash, cutoff) as any)?.m ?? now
        this.db.run(
          `INSERT INTO agent_send_halt
             (agent_id, channel, content_hash, first_seen_ms, tripped_ms, mode, alarm_sent, alarm_mode, blocked_count, preview, updated_at)
           VALUES (?,?,?,?,?,?,1,?,?,?,datetime('now'))`,
          [this.agentId, channel, hash, firstSeen, now, mode, mode, mode === 'enforce' ? 1 : 0, preview]
        )
        alarm = true
        blockedCount = mode === 'enforce' ? 1 : 0
      } else {
        // Alarm točno jednom PO MODU: prelazak shadow→enforce zaslužuje novi alarm.
        alarm = !sqlHalt.alarm_sent || sqlHalt.alarm_mode !== mode
        this.db.run(
          `UPDATE agent_send_halt
              SET tripped_ms=?, mode=?, alarm_sent=1, alarm_mode=?,
                  blocked_count=blocked_count + ?, updated_at=datetime('now')
            WHERE agent_id=? AND channel=? AND content_hash=?`,
          [now, mode, mode, mode === 'enforce' ? 1 : 0, this.agentId, channel, hash]
        )
        blockedCount = (sqlHalt.blocked_count ?? 0) + (mode === 'enforce' ? 1 : 0)
      }
    } catch (e: any) {
      sqlError = String(e?.message ?? e)
      this.log(`⚠️ SendBreaker halt-upis pao (memorijski halt ostaje): ${sqlError}`)
      alarm = !this.memAlarmed.has(key)
    }
    this.memAlarmed.add(key)

    if (mode === 'shadow') {
      // SHADOW: poruka IDE van (stari put), ali se bilježi i mjeri.
      memHits.push(now)
      this.recordSend(channel, hash, now, mode, preview, sqlError)
      this.log(`👁️ SendBreaker SHADOW: "${preview.substring(0, 60)}" ${recentCount + 1}x/${Math.round(this.windowMs / 60000)}min — BI blokirao (prag ${this.threshold})`)
      this.maybePrune(now)
      return {
        allowed: true, wouldBlock: true, mode, hash, recentCount,
        halted: true, alarm, blockedCount,
        reason: `shadow: prag ${this.threshold} prijeđen (${recentCount}) — stvarno slanje NIJE zaustavljeno`,
        sqlError,
      }
    }

    this.log(`🛑 SendBreaker HALT: agent=${this.agentId} kanal=${channel} "${preview.substring(0, 60)}" — ${recentCount}x u ${Math.round(this.windowMs / 60000)} min, blokirano ukupno ${blockedCount}`)
    this.maybePrune(now)
    return {
      allowed: false, wouldBlock: true, mode, hash, recentCount,
      halted: true, alarm, blockedCount,
      reason: `HALT: >${this.threshold} identičnih u ${Math.round(this.windowMs / 60000)} min`,
      sqlError,
    }
  }

  /** Trenutno stanje (za dijagnostiku / alat). */
  stats(): { halts: number; logRows: number } {
    try {
      this.ensureSchema()
      const h = (this.db.query(`SELECT COUNT(*) AS n FROM agent_send_halt WHERE agent_id=?`).get(this.agentId) as any)?.n ?? 0
      const l = (this.db.query(`SELECT COUNT(*) AS n FROM agent_send_log WHERE agent_id=?`).get(this.agentId) as any)?.n ?? 0
      return { halts: h, logRows: l }
    } catch { return { halts: 0, logRows: 0 } }
  }

  /** Ručni reset (alat / operater). */
  reset(channel?: SendChannel): number {
    try {
      this.ensureSchema()
      // Briše i halt i brojač u prozoru — inače bi se halt odmah ponovno upalio.
      const q = channel
        ? this.db.run(`DELETE FROM agent_send_halt WHERE agent_id=? AND channel=?`, [this.agentId, channel])
        : this.db.run(`DELETE FROM agent_send_halt WHERE agent_id=?`, [this.agentId])
      if (channel) this.db.run(`DELETE FROM agent_send_log WHERE agent_id=? AND channel=?`, [this.agentId, channel])
      else this.db.run(`DELETE FROM agent_send_log WHERE agent_id=?`, [this.agentId])
      this.mem.clear(); this.memAlarmed.clear()
      return (q as any)?.changes ?? 0
    } catch { return 0 }
  }

  // ─── interno ──────────────────────────────────────────────────────

  private ensureSchema(): void {
    if (this.schemaReady) return
    for (const stmt of SCHEMA) this.db.run(stmt)
    this.schemaReady = true
  }

  private recordSend(channel: string, hash: string, now: number, mode: BreakerMode, preview: string, prevError?: string): void {
    if (prevError) return  // SQL je već pao — ne pokušavaj opet u istom ciklusu
    try {
      this.ensureSchema()
      this.db.run(
        `INSERT INTO agent_send_log (agent_id, channel, content_hash, created_ms, mode, preview)
         VALUES (?,?,?,?,?,?)`,
        [this.agentId, channel, hash, now, mode, preview]
      )
    } catch (e: any) {
      this.log(`⚠️ SendBreaker log-upis pao: ${e?.message ?? e}`)
    }
  }

  private pruneMem(cutoff: number): void {
    for (const [k, v] of this.mem) {
      const kept = v.filter(t => t > cutoff)
      if (kept.length === 0) this.mem.delete(k)
      else this.mem.set(k, kept)
    }
  }

  private maybePrune(now: number): void {
    if (++this.checkCount % PRUNE_EVERY !== 0) return
    try {
      this.db.run(`DELETE FROM agent_send_log WHERE created_ms < ?`, [now - LOG_RETENTION_MS])
      this.db.run(`DELETE FROM agent_send_halt WHERE tripped_ms < ?`, [now - LOG_RETENTION_MS])
    } catch {}
  }
}

/** Tekst alarma — jedan po incidentu, kratak i akcijski. */
export function formatAlarm(agentId: string, channel: string, v: BreakerVerdict, preview: string): string {
  const mins = Math.round(DEFAULT_WINDOW_MS / 60000)
  const head = v.mode === 'enforce' ? '🛑 SEND-BREAKER HALT' : '👁️ SEND-BREAKER (shadow, ne blokira)'
  return `${head}\nAgent: ${agentId} · kanal: ${channel}\n`
    + `${v.recentCount} identičnih poruka u ${mins} min (prag ${DEFAULT_THRESHOLD}).\n`
    + `Sadržaj: "${preview.substring(0, 100)}"\n`
    + `Daljnje identične poruke se ${v.mode === 'enforce' ? 'ODBACUJU' : 'i dalje šalju (shadow)'}. `
    + `Halt se gasi nakon ${mins} min tišine.`
}
