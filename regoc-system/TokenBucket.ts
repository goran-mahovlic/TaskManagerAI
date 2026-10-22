// ─── TokenBucket ─────────────────────────────────────────────────────
// P5b / TASK-2582 (PRJ-030). Globalni CROSS-PROCESS rate-limiter za spawnove
// (claude --print). Za razliku od današnjeg in-memory backoff Map-a (koji restart
// briše), ovo živi u SQLite (WAL) pa ga dijele SVI daemon/agent procesi.
// Štiti i DANAS: MAX_AGENT_CONCURRENT (zadano 3, podesivo preko REGOC_MAX_AGENT_CONCURRENT
// — AgentConcurrency.ts) + ovaj bucket = kraj rate-limit petlji (06-19).
//
// "Token" = jedan `claude --print` poziv. Bucket se puni refill_per_sec do capacity.
//
// Uporaba:
//   const tb = new TokenBucket()
//   tb.init('claude_spawn', 6, 0.1)          // 6 odjednom, +1 svakih 10 s
//   if (tb.tryConsume('claude_spawn')) spawn() // else čekaj/odgodi

import Database from 'bun:sqlite'
import { join } from 'path'

const HOME = process.env.HOME || ''
const DEFAULT_DB = join(HOME, '.claude', 'regoc', 'messages.db')

export class TokenBucket {
  private db: Database
  constructor(dbPath: string = DEFAULT_DB) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS token_bucket (
      name TEXT PRIMARY KEY, tokens REAL NOT NULL, capacity REAL NOT NULL,
      refill_per_sec REAL NOT NULL, last_refill INTEGER NOT NULL)`)
  }

  /** Kreiraj/resetiraj bucket. Ako postoji, ažurira parametre (ne dira tokens osim reset). */
  init(name: string, capacity: number, refillPerSec: number, reset = false): void {
    const now = Date.now()
    const existing = this.db.query('SELECT name FROM token_bucket WHERE name=?').get(name)
    if (existing && !reset) {
      this.db.run('UPDATE token_bucket SET capacity=?, refill_per_sec=? WHERE name=?', [capacity, refillPerSec, name])
    } else {
      this.db.run(`INSERT INTO token_bucket(name,tokens,capacity,refill_per_sec,last_refill)
        VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET tokens=excluded.tokens,
        capacity=excluded.capacity, refill_per_sec=excluded.refill_per_sec, last_refill=excluded.last_refill`,
        [name, capacity, capacity, refillPerSec, now])
    }
  }

  /** Atomarno: refill po proteklom vremenu, pa potroši n ako ima. True = dobio dopuštenje. */
  tryConsume(name: string, n = 1): boolean {
    const now = Date.now()
    let ok = false
    // BEGIN IMMEDIATE → write-lock odmah; busy_timeout serijalizira procese.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row: any = this.db.query('SELECT tokens,capacity,refill_per_sec,last_refill FROM token_bucket WHERE name=?').get(name)
      if (row) {
        const elapsed = Math.max(0, (now - row.last_refill) / 1000)
        const tokens = Math.min(row.capacity, row.tokens + elapsed * row.refill_per_sec)
        if (tokens >= n) {
          this.db.run('UPDATE token_bucket SET tokens=?, last_refill=? WHERE name=?', [tokens - n, now, name])
          ok = true
        } else {
          // spremi refill i kad ne trošimo (da se napredak ne gubi)
          this.db.run('UPDATE token_bucket SET tokens=?, last_refill=? WHERE name=?', [tokens, now, name])
        }
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return ok
  }

  peek(name: string): number {
    const row: any = this.db.query('SELECT tokens FROM token_bucket WHERE name=?').get(name)
    return row ? row.tokens : 0
  }

  close(): void { this.db.close() }
}
