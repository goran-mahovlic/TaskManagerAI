/**
 * TASK-5793 — daemon kompleta na rasporedu kao na macOS čvoru.
 *
 * Nalaz (macmini, daemon.log): „GEMINI.md not found at ~/app/regoc_system/GEMINI.md" pri svakom
 * startu, „odlučitelj je pao: alat tools/odlucitelj.py nije pronađen" svakih 5 min i
 * „[staleWatchdog] SQLiteError: no such table: agent_checkpoints". Putanje su bile raspored
 * glavnog čvora (`~/app/regoc_system`), a na čvoru paketa postoje samo komplet (TM_SUSTAV_DIR iz
 * instalacija.env) i paket (TM_PAKET_DIR, daje ga scripts/s-okolinom.sh).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { nadjiAlat } from '../regoc-system/OdluciteljPogon'
import { nadjiPravila } from '../regoc-system/PravilaSustava'
import { makeCheckpointLookup } from '../regoc-system/StaleWatchdog'

const PAKET = join(import.meta.dir, '..')
let dom: string

/** Raspored macOS čvora: HOME bez ~/app/regoc_system (osim jednog alata), komplet, paket. */
function mac() {
  const home = join(dom, 'Users', 'korisnik')
  const komplet = join(home, '.claude', 'regoc')
  const paket = join(home, 'TaskManagerAI')
  mkdirSync(join(home, 'app', 'regoc_system', 'tools'), { recursive: true })
  writeFileSync(join(home, 'app', 'regoc_system', 'tools', 'session_usage.py'), '')
  mkdirSync(join(komplet, 'tools', 'orkestracija'), { recursive: true })
  mkdirSync(join(paket, 'tools'), { recursive: true })
  writeFileSync(join(paket, 'tools', 'odlucitelj.py'), '')
  return { home, komplet, paket, env: { HOME: home, TM_SUSTAV_DIR: komplet, TM_PAKET_DIR: paket } }
}

beforeEach(() => { dom = mkdtempSync(join(tmpdir(), 'tm-5793-')) })
afterEach(() => rmSync(dom, { recursive: true, force: true }))

describe('odlučitelj — alat iz paketa kad glavnog rasporeda nema', () => {
  test('Mac: ~/app/regoc_system nema alat → tools/odlucitelj.py paketa (TM_PAKET_DIR)', () => {
    const m = mac()
    expect(nadjiAlat(m.env)).toBe(join(m.paket, 'tools', 'odlucitelj.py'))
  })

  test('glavni čvor: ~/app/regoc_system/tools/odlucitelj.py i dalje ima prednost', () => {
    const m = mac()
    writeFileSync(join(m.home, 'app', 'regoc_system', 'tools', 'odlucitelj.py'), '')
    expect(nadjiAlat(m.env)).toBe(join(m.home, 'app', 'regoc_system', 'tools', 'odlucitelj.py'))
  })

  test('komplet s alatom u tools/orkestracija (TM_SUSTAV_DIR) prije paketa', () => {
    const m = mac()
    writeFileSync(join(m.komplet, 'tools', 'orkestracija', 'odlucitelj.py'), '')
    expect(nadjiAlat(m.env)).toBe(join(m.komplet, 'tools', 'orkestracija', 'odlucitelj.py'))
  })

  test('bez ijednog alata → null (daemon javlja „nije pronađen")', () => {
    expect(nadjiAlat({ HOME: join(dom, 'prazno') })).toBeNull()
  })
})

describe('pravila (GEMINI.md) — komplet ih nosi', () => {
  test('Mac: nema ~/app/regoc_system/GEMINI.md → $TM_SUSTAV_DIR/GEMINI.md', () => {
    const m = mac()
    writeFileSync(join(m.komplet, 'GEMINI.md'), '# pravila')
    expect(nadjiPravila(m.env, join(dom, 'nigdje'))).toBe(join(m.komplet, 'GEMINI.md'))
  })

  test('glavni čvor: ~/app/regoc_system/GEMINI.md ima prednost; TM_PRAVILA nadjačava sve', () => {
    const m = mac()
    writeFileSync(join(m.komplet, 'GEMINI.md'), '# komplet')
    writeFileSync(join(m.home, 'app', 'regoc_system', 'GEMINI.md'), '# glavni')
    expect(nadjiPravila(m.env, join(dom, 'nigdje'))).toBe(join(m.home, 'app', 'regoc_system', 'GEMINI.md'))
    writeFileSync(join(dom, 'izricito.md'), '#')
    expect(nadjiPravila({ ...m.env, TM_PRAVILA: join(dom, 'izricito.md') }, join(dom, 'nigdje'))).toBe(join(dom, 'izricito.md'))
  })

  test('bez TM_SUSTAV_DIR → GEMINI.md uz sam modul kompleta', () => {
    const uz = join(dom, 'komplet')
    mkdirSync(uz)
    writeFileSync(join(uz, 'GEMINI.md'), '#')
    expect(nadjiPravila({ HOME: join(dom, 'h') }, uz)).toBe(join(uz, 'GEMINI.md'))
    expect(nadjiPravila({ HOME: join(dom, 'h') }, join(dom, 'nigdje'))).toBeNull()
  })

  test('komplet u paketu nosi GEMINI.md bez putanja i adresa glavnog stroja', () => {
    const t = readFileSync(join(PAKET, 'regoc-system', 'GEMINI.md'), 'utf-8')
    expect(t).toMatch(/PRAVILA/)
    expect(t).not.toMatch(/\/home\/(?!korisnik\b)[a-z]|\/Users\/(?!korisnik\b)[A-Za-z]|192\.168\.|\.ts\.net/)
  })
})

describe('staleWatchdog — baza bez agent_checkpoints', () => {
  test('nema tablice → lookup bez traga (null), ne iznimka koja ruši prolaz', () => {
    const db = new Database(':memory:')
    const lookup = makeCheckpointLookup(db)
    expect(lookup('TASK-1', 'jelena')).toBeNull()
  })

  test('tablica postoji → trag i dalje radi', () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE agent_checkpoints (agent_id TEXT, task_id TEXT, created_at TEXT)')
    db.run("INSERT INTO agent_checkpoints VALUES ('jelena', 'TASK-1', datetime('now'))")
    expect(makeCheckpointLookup(db)('TASK-1', 'jelena')?.source).toBe('task')
  })
})

describe('s-okolinom.sh — usluga zna gdje je paket', () => {
  test('TM_PAKET_DIR = korijen paketa; zadano iz okoline se poštuje', () => {
    const pokreni = (env: Record<string, string>) => Bun.spawnSync(
      ['bash', join(PAKET, 'scripts', 's-okolinom.sh'), '--', 'sh', '-c', 'printf %s "$TM_PAKET_DIR"'],
      { env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dom, TM_HOME: join(dom, 'tm'), ...env } },
    ).stdout.toString()
    expect(pokreni({})).toBe(PAKET)
    expect(pokreni({ TM_PAKET_DIR: '/drugdje' })).toBe('/drugdje')
  })
})
