// ─── ConcurrencySetting ──────────────────────────────────────────────────────
// Strop usporednih agenata je POSTAVKA TaskManagera, ne varijabla okoline: mijenja se uživo
// na Config stranici (`PUT /api/config/concurrency`), preživi restart i dolazi s paketom.
//
// ZAŠTO TABLICA U BAZI, A NE DATOTEKA POD TM_HOME:
//   • baza je jedino što ploča i orkestrator već dijele — nema nove putanje ni HTTP poziva;
//   • audit (tko, kada, staro → novo) je redak u `settings_history`, u istoj transakciji
//     kao i promjena — datoteka bi trebala zaseban dnevnik koji može zaostati;
//   • `db/schema.sql` + `scripts/init-db.ts` već postoje, pa seed 3 ide istim putem.
//
// REDOSLIJED: postavka u bazi > zadano 3. Okolina (`REGOC_MAX_AGENT_CONCURRENT`) je samo
// JEDNOKRATNA početna vrijednost dok postavka ne postoji; kad postoji, okolina se ignorira i
// javlja kao zastarjela. Iznimka: ispad baze prije prvog uspješnog čitanja — tada je okolina
// bolja od slijepog 3.
//
// FAIL-SAFE: nečitljiva baza nikad ne znači „neograničeno". Zadnja dobra vrijednost → okolina
// → 3, i sve stisnuto u [1, 10].
//
// Pravila autonomije (npr. „iznad 85 % kvote najviše jedan agent") domaćin provjerava PRIJE
// ovog stropa i ona ga nadjačavaju.

import { Database } from 'bun:sqlite'

export const CONCURRENCY_KEY = 'agents.max_concurrent'
export const CONCURRENCY_DEFAULT = 3
export const CONCURRENCY_MIN = 1
export const CONCURRENCY_MAX = 10
/** Najdulji dopušteni keš čitača (nalog: „ili s kratkim kešom ≤5 s"). */
export const CONCURRENCY_CACHE_MS = 5000
export const CONCURRENCY_ENV = 'REGOC_MAX_AGENT_CONCURRENT'

type Env = Record<string, string | undefined>

export const SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT 'system',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT NOT NULL,
  changed_by  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'api',
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_settings_history_key ON settings_history(key, id);
`

export function ensureSettingsSchema(db: Database): void {
  db.exec(SETTINGS_SCHEMA_SQL)
}

/** Stisni bilo što brojčano u [1, 10]; `null` ako to nije konačan broj. */
function clampOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.floor(n)))
}

/** Okolina kao broj u [1, 10] ili `null` ako nije postavljena / je smeće. */
export function envConcurrency(env: Env): number | null {
  return clampOrNull(env[CONCURRENCY_ENV])
}

/**
 * Stroga provjera ulaza s ploče/API-ja. Za razliku od čitača (koji stišće), ovdje se
 * vrijednost izvan raspona ODBIJA — korisnik mora vidjeti da „20" nije prihvaćeno.
 */
export function parseConcurrencyInput(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < CONCURRENCY_MIN || n > CONCURRENCY_MAX) {
    return { ok: false, error: `maxConcurrent mora biti cijeli broj ${CONCURRENCY_MIN}–${CONCURRENCY_MAX}` }
  }
  return { ok: true, value: n }
}

export interface ConcurrencyState {
  value: number
  updatedBy: string | null
  updatedAt: string | null
  /** 'settings' = iz tablice, 'default' = redak ne postoji. */
  source: 'settings' | 'default'
}

export function getConcurrency(db: Database): ConcurrencyState {
  const row = db.query(`SELECT value, updated_by, updated_at FROM settings WHERE key = ?`)
    .get(CONCURRENCY_KEY) as { value: string; updated_by: string; updated_at: string } | null
  if (!row) return { value: CONCURRENCY_DEFAULT, updatedBy: null, updatedAt: null, source: 'default' }
  return {
    value: clampOrNull(row.value) ?? CONCURRENCY_DEFAULT,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    source: 'settings',
  }
}

/**
 * Upiši početnu vrijednost ako je nema. Okolina se koristi TOČNO jednom — ovdje.
 * Vraća `envIgnored: true` kad okolina postoji a postavka već ima vrijednost, da pozivatelj
 * može upozoriti da je `REGOC_MAX_AGENT_CONCURRENT` zastarjela.
 */
export function seedConcurrency(db: Database, env: Env = {}): { seeded: boolean; value: number; envIgnored: boolean } {
  ensureSettingsSchema(db)
  const fromEnv = envConcurrency(env)
  const existing = getConcurrency(db)
  if (existing.source === 'settings') {
    return { seeded: false, value: existing.value, envIgnored: fromEnv !== null }
  }
  const value = fromEnv ?? CONCURRENCY_DEFAULT
  const by = fromEnv !== null ? 'seed:env' : 'seed:default'
  db.transaction(() => {
    const ins = db.query(`INSERT OR IGNORE INTO settings(key, value, updated_by) VALUES (?, ?, ?)`)
      .run(CONCURRENCY_KEY, String(value), by)
    if (ins.changes > 0) {
      db.query(`INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, NULL, ?, ?, 'seed')`)
        .run(CONCURRENCY_KEY, String(value), by)
    }
  })()
  return { seeded: true, value, envIgnored: false }
}

export interface ConcurrencyChange {
  oldValue: number | null
  newValue: number
  changedBy: string
  source: string
  changed: boolean
}

/** Promjena s ploče/API-ja. Baca na nevaljanu vrijednost — ništa se ne upisuje. */
export function setConcurrency(db: Database, value: number, by: string, source = 'api'): ConcurrencyChange {
  const p = parseConcurrencyInput(value)
  if (!p.ok) throw new Error(p.error)
  ensureSettingsSchema(db)
  const who = (by || 'unknown').slice(0, 64)
  let oldValue: number | null = null
  db.transaction(() => {
    const cur = getConcurrency(db)
    oldValue = cur.source === 'settings' ? cur.value : null
    db.query(
      `INSERT INTO settings(key, value, updated_by, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(CONCURRENCY_KEY, String(p.value), who)
    db.query(`INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, ?, ?, ?, ?)`)
      .run(CONCURRENCY_KEY, oldValue === null ? null : String(oldValue), String(p.value), who, source)
  })()
  return { oldValue, newValue: p.value, changedBy: who, source, changed: oldValue !== p.value }
}

export interface ConcurrencyHistoryRow {
  oldValue: number | null
  newValue: number
  changedBy: string
  source: string
  changedAt: string
}

/** Povijest promjena, najnovija prva. */
export function concurrencyHistory(db: Database, limit = 20): ConcurrencyHistoryRow[] {
  const rows = db.query(
    `SELECT old_value, new_value, changed_by, source, changed_at FROM settings_history
     WHERE key = ? ORDER BY id DESC LIMIT ?`,
  ).all(CONCURRENCY_KEY, limit) as Array<{ old_value: string | null; new_value: string; changed_by: string; source: string; changed_at: string }>
  return rows.map(r => ({
    oldValue: r.old_value === null ? null : Number(r.old_value),
    newValue: Number(r.new_value),
    changedBy: r.changed_by,
    source: r.source,
    changedAt: r.changed_at,
  }))
}

// ─── Čitač za daemon ─────────────────────────────────────────────────────────

export interface ReaderChange {
  oldValue: number | null
  newValue: number
  changedBy: string | null
  source: string | null
}

/** „strop 1 → 3 (admin, config)" — redak za dnevnik orkestratora. */
export function formatConcurrencyChange(c: ReaderChange): string {
  const who = [c.changedBy ?? '?', c.source ?? '?'].join(', ')
  return `strop ${c.oldValue ?? '—'} → ${c.newValue} (${who})`
}

/**
 * Vrati funkciju koja daje trenutačni strop. Baza se čita najviše jednom u `ttlMs` (≤5 s);
 * između toga vraća se keš. `onChange` se zove kad se vrijednost promijeni u odnosu na zadnju
 * viđenu (prvo čitanje se ne javlja kao promjena).
 */
export function createConcurrencyReader(opts: {
  dbPath: string
  ttlMs?: number
  env?: Env
  now?: () => number
  onChange?: (c: ReaderChange) => void
  onError?: (err: unknown) => void
}): () => number {
  const ttl = Math.min(opts.ttlMs ?? CONCURRENCY_CACHE_MS, CONCURRENCY_CACHE_MS)
  const now = opts.now ?? Date.now
  const env = opts.env ?? {}
  let cached: number | null = null
  let lastGood: number | null = null
  let readAt = -Infinity

  function readDb(): { value: number; by: string | null; source: string | null } | null {
    let db: Database | null = null
    try {
      db = new Database(opts.dbPath, { readonly: true })
      const row = db.query(`SELECT value, updated_by FROM settings WHERE key = ?`).get(CONCURRENCY_KEY) as
        { value: string; updated_by: string } | null
      if (!row) return null
      const v = clampOrNull(row.value)
      if (v === null) return null
      const src = db.query(`SELECT source FROM settings_history WHERE key = ? ORDER BY id DESC LIMIT 1`)
        .get(CONCURRENCY_KEY) as { source: string } | null
      return { value: v, by: row.updated_by, source: src?.source ?? null }
    } catch (err) {
      opts.onError?.(err)
      return null
    } finally {
      try { db?.close() } catch { /* ništa */ }
    }
  }

  return function currentMaxConcurrent(): number {
    const t = now()
    if (cached !== null && t - readAt < ttl) return cached
    readAt = t
    const r = readDb()
    let value: number
    if (r) {
      value = r.value
      if (lastGood !== null && lastGood !== value) {
        opts.onChange?.({ oldValue: lastGood, newValue: value, changedBy: r.by, source: r.source })
      }
      lastGood = value
    } else {
      value = lastGood ?? envConcurrency(env) ?? CONCURRENCY_DEFAULT
    }
    cached = value
    return value
  }
}
