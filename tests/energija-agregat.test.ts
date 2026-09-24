/**
 * K2/TASK-4820 — agregat energije po projektu nad PRAVIM SQL-om (ADR-0010 §11.3, §11.4).
 *
 * Testira se nad privremenom bazom (nikad nad živom — LiveDbGuard), ali ISTIM upitom koji
 * vrti ploča. Dvije zamke koje su ovdje uhvaćene mjerenjem, ne pretpostavkom:
 *  - `GROUP BY pid` bez modela primijeni k = 1 na sve retke → podcjena (opus je 80 % prometa),
 *  - grupiranje po `cost_log.project_id` umjesto JOIN-a na zadatak pošalje rad u „(bez projekta)".
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ENERGIJA_PO_PROJEKTU_SQL, sazmiEnergiju, procijeniEnergijuWh } from '../src/core/CostTracker'

let dir: string
let db: Database

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'energija-'))
  db = new Database(join(dir, 'test.db'))
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT)`)
  db.exec(`CREATE TABLE cost_log (id TEXT PRIMARY KEY, timestamp TEXT, agent_id TEXT, task_id TEXT,
             project_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
             cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL)`)
  db.exec(`INSERT INTO tasks (id, project_id) VALUES ('TASK-1','PRJ-A'), ('TASK-2','PRJ-A')`)
  const ins = db.prepare(`INSERT INTO cost_log VALUES (?, datetime('now'), 'jelena', ?, NULL, ?, ?, ?, ?, ?, ?)`)
  // `project_id` u cost_logu je NULL kad redak ima zadatak — projekt se čita JOIN-om (TASK-4263).
  ins.run('c1', 'TASK-1', 'claude-opus-5',   1_000_000, 1_000_000, 1_000_000, 1_000_000, 11.5)
  ins.run('c2', 'TASK-2', 'claude-sonnet-5', 1_000_000, 1_000_000, 1_000_000, 1_000_000, 22.07)
  ins.run('c3', 'TASK-1', 'claude-opus-5',         0,         0,         0,         0,  0)  // legacy redak
})

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('ENERGIJA_PO_PROJEKTU_SQL nad pravom bazom', () => {
  test('vraća redak po (projekt × model) i sve četiri vrste tokena', () => {
    const r = db.query(ENERGIJA_PO_PROJEKTU_SQL).all() as any[]
    expect(r.length).toBe(2)                       // PRJ-A × {opus, sonnet}
    expect(r.every(x => x.pid === 'PRJ-A')).toBe(true)
    const opus = r.find(x => x.model === 'claude-opus-5')
    expect(opus.zapisa).toBe(2)
    expect(opus.zapisa_s_tokenima).toBe(1)         // legacy redak se ne broji u nazivnik
    expect(opus.cache_read_tokens).toBe(1_000_000)
  })

  test('grupiranje po modelu daje VEĆU energiju od naivnog GROUP BY pid — ADR §11.3', () => {
    const r = db.query(ENERGIJA_PO_PROJEKTU_SQL).all() as any[]
    const tocno = sazmiEnergiju(r.map(x => ({
      model: x.model, inputTokens: x.input_tokens, outputTokens: x.output_tokens,
      cacheReadTokens: x.cache_read_tokens, cacheWriteTokens: x.cache_write_tokens,
      zapisaSTokenima: x.zapisa_s_tokenima,
    })))!
    const naivno = procijeniEnergijuWh({
      model: 'nepoznato',  // k = 1 na SVE retke — upravo ta podcjena
      inputTokens: 2_000_000, outputTokens: 2_000_000,
      cacheReadTokens: 2_000_000, cacheWriteTokens: 2_000_000,
    })!
    expect(tocno.wh).toBeGreaterThan(naivno.wh)
    expect(tocno.wh / naivno.wh).toBeCloseTo((1 + 5 / 3) / 2, 6)   // (opus + sonnet) / 2× k=1
  })

  test('nazivnik broji izvođenja s tokenima, ne retke agregata', () => {
    const r = db.query(ENERGIJA_PO_PROJEKTU_SQL).all() as any[]
    const s = sazmiEnergiju(r.map(x => ({
      model: x.model, inputTokens: x.input_tokens, outputTokens: x.output_tokens,
      cacheReadTokens: x.cache_read_tokens, cacheWriteTokens: x.cache_write_tokens,
      zapisaSTokenima: x.zapisa_s_tokenima,
    })))!
    expect(s.izTokena).toBe(2)
    expect(s.procjena).toBe(true)
  })

  test('projekt se čita JOIN-om: nijedan Wh ne pada u „(bez projekta)" — ADR §11.4', () => {
    const r = db.query(ENERGIJA_PO_PROJEKTU_SQL).all() as any[]
    expect(r.some(x => x.pid === '(bez projekta)')).toBe(false)
    const krivo = db.query(`SELECT COALESCE(project_id,'(bez projekta)') AS pid, COUNT(*) n
                              FROM cost_log GROUP BY pid`).all() as any[]
    expect(krivo[0].pid).toBe('(bez projekta)')   // tako je izgledala ploča prije TASK-4263
  })
})
