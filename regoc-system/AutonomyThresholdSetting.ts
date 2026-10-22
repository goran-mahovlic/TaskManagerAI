// ─── AutonomyThresholdSetting ────────────────────────────────────────────────
// TASK-5028 (Goran, 24.09.2026.). Pragovi vrata autonomije (sesija 70/85/95 %, tjedan 90 %)
// su POSTAVKA TaskManagera, ne konstante u kodu: mijenjaju se uživo s Config stranice
// (`PUT /api/config/autonomy`), preživljavaju restart i dolaze s paketom (TaskManagerAI).
// Isti obrazac kao strop usporednih agenata (ConcurrencySetting.ts, TASK-5015): tablica
// `settings` + audit u `settings_history`, čitač s kešom ≤5 s.
//
// ŠTO SE OVDJE MIJENJA, A ŠTO NE:
//   • mijenjaju se samo BROJEVI na kojima vrata mijenjaju razinu;
//   • semantika vrata ostaje u `WorkStateJournal.ts` i NE dira se: stara/nepostojeća snimka
//     i dalje zatvara vrata (fail-CLOSED), 429/`rejected` i dalje tvrdi stop, Goranov nalog
//     (`spawnOnRequest`) i dalje prolazi na tjednom stropu.
//
// VALIDACIJA: cijeli postoci 10–100, sesijski strogo rastući (autonomija < oprez < blokada);
// tjedni je neovisan. Skup se provjerava CIJELI — pojedinačno valjana vrijednost koja
// kvari redoslijed nije valjana.
//
// FAIL-SAFE: nevaljan ili nečitljiv zapis nikad ne znači „bez praga". Čitač vraća zadnji
// dobar skup, a ako ga nema — zadane 70/85/95/90 (ponašanje prije TASK-5028).
//
// Modul je bez putanja i bez okoline (sve se predaje), pa je isti u pogonu i u paketu.
// Autorica: Jelena (Engineer) · 2026-10-02 · TASK-5028

import { Database } from 'bun:sqlite'

export interface AutonomyThresholds {
  /** Iznad ovoga autonomija prestaje sama vući posao iz reda. */
  sessionAutonomy: number
  /** Iznad ovoga: bez multiagenata, uz potvrdu prije početka. */
  sessionCaution: number
  /** Iznad ovoga: samo odgovaranje, ništa se ne izvršava. */
  sessionBlock: number
  /** Tjedni strop: gasi SAMO autonomiju; Goranov nalog i dalje prolazi. */
  weeklyBlock: number
}

export type AutonomyField = keyof AutonomyThresholds

export const AUTONOMY_FIELDS: AutonomyField[] = ['sessionAutonomy', 'sessionCaution', 'sessionBlock', 'weeklyBlock']

export const AUTONOMY_KEYS: Record<AutonomyField, string> = {
  sessionAutonomy: 'autonomy.session_autonomy',
  sessionCaution: 'autonomy.session_caution',
  sessionBlock: 'autonomy.session_block',
  weeklyBlock: 'autonomy.weekly_block',
}

/** Zadano = vrijednosti koje su do TASK-5028 bile tvrdo upisane u WorkStateJournal.ts. */
export const AUTONOMY_DEFAULTS: Readonly<AutonomyThresholds> = Object.freeze({
  sessionAutonomy: 70,
  sessionCaution: 85,
  sessionBlock: 95,
  weeklyBlock: 90,
})

export const AUTONOMY_MIN = 10
export const AUTONOMY_MAX = 100
/** Najdulji dopušteni keš čitača (nalog: „keš ≤5 s"). */
export const AUTONOMY_CACHE_MS = 5000

/** Kratki nazivi za daemon.log („autonomija 70 → 80"). */
const LABEL: Record<AutonomyField, string> = {
  sessionAutonomy: 'autonomija',
  sessionCaution: 'oprez',
  sessionBlock: 'blokada',
  weeklyBlock: 'tjedan',
}

const META_FIELDS = new Set(['by', 'source'])

function isValidPercent(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= AUTONOMY_MIN && n <= AUTONOMY_MAX
}

/** `null` ako je skup valjan, inače opis prve greške. */
export function validateThresholds(t: AutonomyThresholds): string | null {
  for (const f of AUTONOMY_FIELDS) {
    if (!isValidPercent(t[f])) return `${f} mora biti cijeli postotak ${AUTONOMY_MIN}–${AUTONOMY_MAX}`
  }
  if (!(t.sessionAutonomy < t.sessionCaution && t.sessionCaution < t.sessionBlock)) {
    return `redoslijed mora biti sessionAutonomy < sessionCaution < sessionBlock `
      + `(sada ${t.sessionAutonomy} / ${t.sessionCaution} / ${t.sessionBlock})`
  }
  return null
}

/**
 * Stroga provjera ulaza s ploče/API-ja. Djelomičan unos se spaja s `current`, pa se
 * provjerava CIJELI skup. Polja `by`/`source` su metapodaci i ovdje se preskaču;
 * svako drugo nepoznato polje se odbija (tipfeler ne smije tiho proći kao „ništa").
 */
export function parseAutonomyInput(
  raw: unknown,
  current: AutonomyThresholds,
): { ok: true; values: AutonomyThresholds } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'tijelo mora biti JSON objekt' }
  const body = raw as Record<string, unknown>
  const unknown = Object.keys(body).filter(k => !META_FIELDS.has(k) && !(AUTONOMY_FIELDS as string[]).includes(k))
  if (unknown.length) return { ok: false, error: `nepoznato polje: ${unknown.join(', ')} (dopušteno: ${AUTONOMY_FIELDS.join(', ')})` }
  const next: AutonomyThresholds = { ...current }
  let any = false
  for (const f of AUTONOMY_FIELDS) {
    if (!(f in body)) continue
    const v = body[f]
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    if (!isValidPercent(n)) return { ok: false, error: `${f} mora biti cijeli postotak ${AUTONOMY_MIN}–${AUTONOMY_MAX}` }
    next[f] = n
    any = true
  }
  if (!any) return { ok: false, error: `nijedan prag nije zadan (${AUTONOMY_FIELDS.join(', ')})` }
  const err = validateThresholds(next)
  if (err) return { ok: false, error: err }
  return { ok: true, values: next }
}

export interface AutonomyState {
  values: AutonomyThresholds
  /** 'settings' = barem jedan prag iz tablice, 'default' = nijedan redak ne postoji. */
  source: 'settings' | 'default'
  updatedBy: string | null
  updatedAt: string | null
  /** Opis kvara ako je zapis u bazi nevaljan (tada `values` = zadano). */
  invalid: string | null
}

type Row = { key: string; value: string; updated_by: string; updated_at: string }

function rowsToState(rows: Row[]): AutonomyState {
  const byKey = new Map(rows.map(r => [r.key, r]))
  const values: AutonomyThresholds = { ...AUTONOMY_DEFAULTS }
  let latest: Row | null = null
  let bad: string | null = null
  for (const f of AUTONOMY_FIELDS) {
    const r = byKey.get(AUTONOMY_KEYS[f])
    if (!r) continue
    if (!latest || r.updated_at > latest.updated_at) latest = r
    const n = r.value.trim() === '' ? NaN : Number(r.value)
    if (!isValidPercent(n)) { bad = bad ?? `${AUTONOMY_KEYS[f]}='${r.value}' nije cijeli postotak ${AUTONOMY_MIN}–${AUTONOMY_MAX}`; continue }
    values[f] = n
  }
  const invalid = bad ?? validateThresholds(values)
  return {
    values: invalid ? { ...AUTONOMY_DEFAULTS } : values,
    source: latest ? 'settings' : 'default',
    updatedBy: latest?.updated_by ?? null,
    updatedAt: latest?.updated_at ?? null,
    invalid,
  }
}

function readRows(db: Database): Row[] {
  const keys = AUTONOMY_FIELDS.map(f => AUTONOMY_KEYS[f])
  return db.query(`SELECT key, value, updated_by, updated_at FROM settings WHERE key IN (?, ?, ?, ?)`)
    .all(...keys) as Row[]
}

export function getAutonomyThresholds(db: Database): AutonomyState {
  return rowsToState(readRows(db))
}

export interface AutonomyFieldChange {
  field: AutonomyField
  key: string
  oldValue: number
  newValue: number
}

export interface AutonomyChange {
  values: AutonomyThresholds
  changes: AutonomyFieldChange[]
  changedBy: string
  source: string
}

/**
 * Promjena s ploče/API-ja. Baca na nevaljan unos — tada se ništa ne upisuje. Upisuju se
 * samo promijenjeni pragovi (jedan redak povijesti po ključu), sve u jednoj transakciji.
 * Polazište je trenutačni VALJANI skup (nevaljan zapis u bazi računa se kao zadano).
 */
export function setAutonomyThresholds(
  db: Database,
  input: Partial<AutonomyThresholds>,
  by: string,
  source = 'api',
): AutonomyChange {
  const who = (by || 'unknown').slice(0, 64)
  let result: AutonomyChange | null = null
  db.transaction(() => {
    const st = getAutonomyThresholds(db)
    const cur = st.values
    const p = parseAutonomyInput(input, cur)
    if (!p.ok) throw new Error(p.error)
    const changes: AutonomyFieldChange[] = []
    for (const f of AUTONOMY_FIELDS) {
      // Nevaljan zapis u bazi (vrata ga čitaju kao zadano) se prepisuje CIJELI — inače PUT
      // jednak zadanome ne bi popravio pokvaren redak i on bi i dalje kvario skup.
      if (p.values[f] === cur[f] && !st.invalid) continue
      db.query(
        `INSERT INTO settings(key, value, updated_by, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      ).run(AUTONOMY_KEYS[f], String(p.values[f]), who)
      if (p.values[f] === cur[f]) continue
      db.query(`INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, ?, ?, ?, ?)`)
        .run(AUTONOMY_KEYS[f], String(cur[f]), String(p.values[f]), who, source)
      changes.push({ field: f, key: AUTONOMY_KEYS[f], oldValue: cur[f], newValue: p.values[f] })
    }
    result = { values: p.values, changes, changedBy: who, source }
  })()
  return result!
}

export interface AutonomyHistoryRow {
  key: string
  field: AutonomyField | null
  oldValue: number | null
  newValue: number
  changedBy: string
  source: string
  changedAt: string
}

/** Povijest promjena svih četiriju pragova, najnovija prva. */
export function autonomyThresholdsHistory(db: Database, limit = 20): AutonomyHistoryRow[] {
  const keys = AUTONOMY_FIELDS.map(f => AUTONOMY_KEYS[f])
  const rows = db.query(
    `SELECT key, old_value, new_value, changed_by, source, changed_at FROM settings_history
     WHERE key IN (?, ?, ?, ?) ORDER BY id DESC LIMIT ?`,
  ).all(...keys, limit) as Array<{ key: string; old_value: string | null; new_value: string; changed_by: string; source: string; changed_at: string }>
  return rows.map(r => ({
    key: r.key,
    field: (AUTONOMY_FIELDS.find(f => AUTONOMY_KEYS[f] === r.key) ?? null),
    oldValue: r.old_value === null ? null : Number(r.old_value),
    newValue: Number(r.new_value),
    changedBy: r.changed_by,
    source: r.source,
    changedAt: r.changed_at,
  }))
}

/** „autonomija 70 → 80, tjedan 90 → 85 (goran, config)" — redak za daemon.log. */
export function formatAutonomyChanges(changes: Array<Pick<AutonomyFieldChange, 'field' | 'oldValue' | 'newValue'>>, by: string | null, source: string | null): string {
  const parts = changes.map(c => `${LABEL[c.field]} ${c.oldValue} → ${c.newValue}`)
  return `${parts.join(', ')} (${by ?? '?'}, ${source ?? '?'})`
}

// ─── Čitač za daemon ─────────────────────────────────────────────────────────

export interface AutonomyReaderChange {
  changes: AutonomyFieldChange[]
  changedBy: string | null
  source: string | null
}

/**
 * Vrati funkciju koja daje trenutačne pragove. Baza se čita najviše jednom u `ttlMs` (≤5 s);
 * između toga vraća se keš. `onChange` se zove kad se skup promijeni u odnosu na zadnji
 * viđeni (prvo čitanje se ne javlja). Nečitljiva baza ili nevaljan zapis → zadnji dobar
 * skup, a bez njega zadano.
 */
export function createAutonomyThresholdsReader(opts: {
  dbPath: string
  ttlMs?: number
  now?: () => number
  onChange?: (c: AutonomyReaderChange) => void
  onError?: (err: unknown) => void
  onInvalid?: (reason: string) => void
}): () => AutonomyThresholds {
  const ttl = Math.min(opts.ttlMs ?? AUTONOMY_CACHE_MS, AUTONOMY_CACHE_MS)
  const now = opts.now ?? Date.now
  let cached: AutonomyThresholds | null = null
  let lastGood: AutonomyThresholds | null = null
  let lastInvalid: string | null = null
  let readAt = -Infinity

  function readDb(): { values: AutonomyThresholds; by: string | null; source: string | null } | null {
    let db: Database | null = null
    try {
      db = new Database(opts.dbPath, { readonly: true })
      const st = rowsToState(readRows(db))
      if (st.invalid) {
        if (st.invalid !== lastInvalid) opts.onInvalid?.(st.invalid)
        lastInvalid = st.invalid
        return null
      }
      lastInvalid = null
      const keys = AUTONOMY_FIELDS.map(f => AUTONOMY_KEYS[f])
      const src = db.query(`SELECT source FROM settings_history WHERE key IN (?, ?, ?, ?) ORDER BY id DESC LIMIT 1`)
        .get(...keys) as { source: string } | null
      return { values: st.values, by: st.updatedBy, source: src?.source ?? null }
    } catch (err) {
      // Tablica `settings` još ne postoji = nitko ništa nije postavio → zadano, bez buke.
      if (!/no such table/i.test(String(err))) opts.onError?.(err)
      else return { values: { ...AUTONOMY_DEFAULTS }, by: null, source: null }
      return null
    } finally {
      try { db?.close() } catch { /* ništa */ }
    }
  }

  return function currentAutonomyThresholds(): AutonomyThresholds {
    const t = now()
    if (cached !== null && t - readAt < ttl) return cached
    readAt = t
    const r = readDb()
    let value: AutonomyThresholds
    if (r) {
      value = r.values
      if (lastGood !== null) {
        const changes: AutonomyFieldChange[] = AUTONOMY_FIELDS
          .filter(f => lastGood![f] !== value[f])
          .map(f => ({ field: f, key: AUTONOMY_KEYS[f], oldValue: lastGood![f], newValue: value[f] }))
        if (changes.length) opts.onChange?.({ changes, changedBy: r.by, source: r.source })
      }
      lastGood = value
    } else {
      value = lastGood ?? { ...AUTONOMY_DEFAULTS }
    }
    cached = value
    return { ...value }
  }
}

// ─── Zona potrošnje za prikaz (klizači) ──────────────────────────────────────

export type UsageZone = 'full' | 'task-by-task' | 'cautious' | 'answer-only' | 'unknown'

/**
 * U kojoj je zoni izmjerena potrošnja s ovim pragovima — SAMO za prikaz na klizaču.
 * Odluku vrata donosi `autonomyTierFromUsage()` (WorkStateJournal), koja uz brojeve gleda i
 * starost snimke, 429 i ispad mjerila; ovo je namjerno samo usporedba brojeva.
 */
export function usageZone(
  sessionPercent: number | null | undefined,
  weeklyPercent: number | null | undefined,
  t: AutonomyThresholds,
): { session: UsageZone; weeklyBlocked: boolean | null } {
  const sp = typeof sessionPercent === 'number' && Number.isFinite(sessionPercent) ? sessionPercent : null
  const wp = typeof weeklyPercent === 'number' && Number.isFinite(weeklyPercent) ? weeklyPercent : null
  const session: UsageZone = sp === null ? 'unknown'
    : sp >= t.sessionBlock ? 'answer-only'
    : sp >= t.sessionCaution ? 'cautious'
    : sp >= t.sessionAutonomy ? 'task-by-task'
    : 'full'
  return { session, weeklyBlocked: wp === null ? null : wp >= t.weeklyBlock }
}
