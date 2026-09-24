/**
 * Strop usporednih agenata kao POSTAVKA TaskManagera (tablica `settings`),
 * promjenjiva uživo s Config stranice, bez restarta daemona.
 *
 * Što se dokazuje:
 *  • nova instalacija dobiva 3 (seed), okolina je samo jednokratna početna vrijednost;
 *  • kad postavka postoji, okolina je NE nadjačava (i to se javlja kao zastarjelo);
 *  • PUT validira 1–10 i piše audit (tko, kada, staro → novo);
 *  • čitač orkestratora vidi promjenu unutar keša (≤5 s) i javlja „strop 1 → 3 (admin, config)";
 *  • pokvarena baza ne znači „neograničeno": zadnja dobra vrijednost, pa okolina, pa 3;
 *  • E2E minijatura: strop 1 → PUT 3 → drugi i treći spawn prolaze bez „restarta".
 */
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  CONCURRENCY_KEY,
  ensureSettingsSchema,
  seedConcurrency,
  getConcurrency,
  setConcurrency,
  parseConcurrencyInput,
  concurrencyHistory,
  createConcurrencyReader,
  formatConcurrencyChange,
} from '../src/core/ConcurrencySetting'
import { SpawnQueue } from '../src/core/orchestrator/SpawnQueue'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'

function freshDb(): Database {
  const db = new Database(':memory:')
  ensureSettingsSchema(db)
  return db
}

describe('seed — zadano 3 dolazi iz paketa, okolina je samo početna vrijednost', () => {
  test('nova instalacija bez okoline → 3', () => {
    const db = freshDb()
    const r = seedConcurrency(db, {})
    expect(r.seeded).toBe(true)
    expect(getConcurrency(db).value).toBe(3)
    expect(getConcurrency(db).updatedBy).toBe('seed:default')
  })

  test('nova instalacija s REGOC_MAX_AGENT_CONCURRENT=2 → 2 (jednokratno)', () => {
    const db = freshDb()
    seedConcurrency(db, { REGOC_MAX_AGENT_CONCURRENT: '2' })
    expect(getConcurrency(db).value).toBe(2)
    expect(getConcurrency(db).updatedBy).toBe('seed:env')
  })

  test('postavka postoji → okolina se ignorira i prijavljuje kao zastarjela', () => {
    const db = freshDb()
    seedConcurrency(db, {})
    setConcurrency(db, 3, 'admin', 'config')
    const r = seedConcurrency(db, { REGOC_MAX_AGENT_CONCURRENT: '1' })
    expect(r.seeded).toBe(false)
    expect(r.envIgnored).toBe(true)
    expect(getConcurrency(db).value).toBe(3)
  })

  test('smeće u okolini pri seedu → 3, ne NaN', () => {
    const db = freshDb()
    seedConcurrency(db, { REGOC_MAX_AGENT_CONCURRENT: 'abc' })
    expect(getConcurrency(db).value).toBe(3)
  })

  test('seed je idempotentan (drugi poziv ne dira vrijednost ni povijest)', () => {
    const db = freshDb()
    seedConcurrency(db, {})
    seedConcurrency(db, {})
    expect(concurrencyHistory(db).length).toBe(1)
  })
})

describe('PUT — validacija 1–10 i audit', () => {
  test('parseConcurrencyInput prihvaća samo cijeli broj 1–10', () => {
    expect(parseConcurrencyInput(3)).toEqual({ ok: true, value: 3 })
    expect(parseConcurrencyInput('4')).toEqual({ ok: true, value: 4 })
    for (const bad of [0, 11, -1, 2.5, 'abc', '', null, undefined, NaN, Infinity]) {
      expect(parseConcurrencyInput(bad as unknown).ok).toBe(false)
    }
  })

  test('setConcurrency piše vrijednost, tko i kada, te redak povijesti staro → novo', () => {
    const db = freshDb()
    seedConcurrency(db, { REGOC_MAX_AGENT_CONCURRENT: '1' })
    const r = setConcurrency(db, 3, 'admin', 'config')
    expect(r).toMatchObject({ oldValue: 1, newValue: 3, changed: true })
    const cur = getConcurrency(db)
    expect(cur.value).toBe(3)
    expect(cur.updatedBy).toBe('admin')
    expect(typeof cur.updatedAt).toBe('string')
    const h = concurrencyHistory(db)
    expect(h[0]).toMatchObject({ oldValue: 1, newValue: 3, changedBy: 'admin', source: 'config' })
  })

  test('setConcurrency odbija vrijednost izvan 1–10 (baca, ništa ne piše)', () => {
    const db = freshDb()
    seedConcurrency(db, {})
    expect(() => setConcurrency(db, 11, 'x', 'api')).toThrow()
    expect(() => setConcurrency(db, 0, 'x', 'api')).toThrow()
    expect(getConcurrency(db).value).toBe(3)
  })
})

describe('čitač orkestratora — uživo, keš ≤5 s, fail-safe', () => {
  function tmpDbFile(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'tm5015-'))
    return { path: join(dir, 'regoc.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('promjena u bazi vidljiva je nakon isteka keša, uz poruku o promjeni', () => {
    const f = tmpDbFile()
    const w = new Database(f.path)
    ensureSettingsSchema(w)
    seedConcurrency(w, { REGOC_MAX_AGENT_CONCURRENT: '1' })
    let now = 1_000_000
    const changes: string[] = []
    const read = createConcurrencyReader({
      dbPath: f.path, ttlMs: 5000, env: {}, now: () => now,
      onChange: (c) => changes.push(formatConcurrencyChange(c)),
    })
    expect(read()).toBe(1)
    setConcurrency(w, 3, 'admin', 'config')
    now += 4000
    expect(read()).toBe(1)          // još u kešu
    now += 1001
    expect(read()).toBe(3)          // keš istekao → nova vrijednost
    expect(changes.at(-1)).toBe('strop 1 → 3 (admin, config)')
    w.close(); f.cleanup()
  })

  test('baza nečitljiva i nikad pročitana → okolina, pa 3 (nikad neograničeno)', () => {
    const readEnv = createConcurrencyReader({ dbPath: '/nepostoji/x.db', env: { REGOC_MAX_AGENT_CONCURRENT: '2' } })
    expect(readEnv()).toBe(2)
    const readDef = createConcurrencyReader({ dbPath: '/nepostoji/x.db', env: {} })
    expect(readDef()).toBe(3)
  })

  test('baza pokvarena nakon dobrog čitanja → zadnja dobra vrijednost', () => {
    const f = tmpDbFile()
    const w = new Database(f.path)
    ensureSettingsSchema(w); seedConcurrency(w, {}); setConcurrency(w, 5, 'admin', 'config'); w.close()
    let now = 0
    const read = createConcurrencyReader({ dbPath: f.path, ttlMs: 5000, env: { REGOC_MAX_AGENT_CONCURRENT: '1' }, now: () => now })
    expect(read()).toBe(5)
    writeFileSync(f.path, 'ovo nije sqlite')
    now += 6000
    expect(read()).toBe(5)
    f.cleanup()
  })

  test('smeće u tablici (ručni upis) → stisnuto/odbačeno, ne NaN', () => {
    const f = tmpDbFile()
    const w = new Database(f.path)
    ensureSettingsSchema(w)
    w.query(`INSERT INTO settings(key, value, updated_by, updated_at) VALUES (?, 'abc', 'ruka', '')`).run(CONCURRENCY_KEY)
    const read = createConcurrencyReader({ dbPath: f.path, env: {} })
    expect(read()).toBe(3)
    w.query(`UPDATE settings SET value='99' WHERE key=?`).run(CONCURRENCY_KEY)
    const read2 = createConcurrencyReader({ dbPath: f.path, env: {} })
    expect(read2()).toBe(10)
    w.close(); f.cleanup()
  })
})

describe('E2E: SpawnQueue čita strop uživo — PUT 3 bez restarta orkestratora', () => {
  test('drugi posao čeka pri 1, a nakon PUT 3 drugi i treći prolaze; smanjenje ne gasi aktivne', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmcs-e2e-'))
    const path = join(dir, 'tasks.db')
    const w = new Database(path)
    ensureSettingsSchema(w); seedConcurrency(w, { REGOC_MAX_AGENT_CONCURRENT: '1' })
    let now = 0
    const logs: string[] = []
    const max = createConcurrencyReader({ dbPath: path, ttlMs: 5000, env: {}, now: () => now,
      onChange: (c) => logs.push(formatConcurrencyChange(c)) })
    const q = new SpawnQueue({ maxConcurrent: max, backoff: { baseMs: 1, maxMs: 1, jitter: false }, hardCeilingHours: 24, now: () => now })
    const start = (id: string) => { const ok = q.smije('a-' + id, id).ok; if (ok) q.zauzmi('a-' + id, id); return ok }

    expect(start('T1')).toBe(true)
    expect(start('T2')).toBe(false)
    expect(q.smije('a-T2', 'T2')).toMatchObject({ ok: false, razlog: 'strop' })
    setConcurrency(w, 3, 'admin', 'config')
    now += 5001
    expect(start('T2')).toBe(true)
    expect(start('T3')).toBe(true)
    expect(start('T4')).toBe(false)
    expect(q.stanje()).toMatchObject({ aktivnih: 3, strop: 3 })
    expect(logs).toContain('strop 1 → 3 (admin, config)')

    setConcurrency(w, 2, 'admin', 'config'); now += 5001
    expect(q.broj).toBe(3)
    expect(start('T5')).toBe(false)
    q.oslobodi('T1', true); q.oslobodi('T2', true)
    expect(start('T5')).toBe(true)
    w.close(); rmSync(dir, { recursive: true, force: true })
  })

  test('SpawnQueue s brojem radi kao prije (povratna kompatibilnost)', () => {
    const q = new SpawnQueue({ maxConcurrent: 2, backoff: { baseMs: 1, maxMs: 1, jitter: false }, hardCeilingHours: 24 })
    expect(q.strop).toBe(2)
  })
})

describe('init-db: nova instalacija odmah ima strop 3', () => {
  test('bun scripts/init-db.ts na praznom TM_HOME upisuje settings = 3', () => {
    const home = mkdtempSync(join(tmpdir(), 'tmcs-init-'))
    const env = { ...process.env, TM_HOME: home, TM_DB: '' } as Record<string, string>
    delete env.TM_DB; delete env.REGOC_MAX_AGENT_CONCURRENT
    const r = spawnSync('bun', ['scripts/init-db.ts'], { cwd: join(import.meta.dir, '..'), env, encoding: 'utf-8' })
    expect(r.status).toBe(0)
    const dbPath = join(home, 'data', 'tasks.db')
    expect(existsSync(dbPath)).toBe(true)
    const db = new Database(dbPath, { readonly: true })
    expect(getConcurrency(db)).toMatchObject({ value: 3, updatedBy: 'seed:default', source: 'settings' })
    db.close(); rmSync(home, { recursive: true, force: true })
  })
})
