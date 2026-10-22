/**
 * pogon.test.ts — what the daemon needs at RUNTIME, beyond the module graph (TASK-5662, Mac round 3).
 *
 * On the Mac the daemon came up (`state = running`) but its main loop failed every second with
 * `no such table: messages`: `schema.sql`, which MessageQueue runs against messages.db, was not in
 * the komplet (the export only followed `.ts` imports), and `initSchema()` skips a missing file
 * silently. The settings reader also could not open `data/regoc.db`: with the TaskManagerAI package
 * the board database is `$TM_HOME/data/tasks.db`.
 *
 * Everything runs in a temporary HOME; nothing outside it is read or written.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, symlinkSync, existsSync, mkdirSync, readlinkSync, lstatSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { Database } from 'bun:sqlite'

const KORIJEN = join(import.meta.dir, '..')
// The template (deploy/…/predlozak) is not a komplet: no sources, schema.sql, MANIFEST or generated
// lists until gradi_komplet.sh builds one. There the tests skip instead of failing (TASK-5662).
const PREDLOZAK = basename(KORIJEN) === 'predlozak' && !existsSync(join(KORIJEN, 'MANIFEST.sha256'))
let dom: string, k: string, tm: string

beforeAll(() => {
  if (PREDLOZAK) return
  dom = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'komplet-pogon-'))
  k = join(dom, '.claude', 'regoc')
  tm = join(dom, '.taskmanager')
  mkdirSync(join(dom, '.claude'), { recursive: true })
  mkdirSync(join(tm, 'data'), { recursive: true })
  writeFileSync(join(tm, 'data', 'tasks.db'), '')
  cpSync(KORIJEN, k, {
    recursive: true, verbatimSymlinks: true,
    filter: (s) => !/^\/(\.git|node_modules|data|config|tmp)(\/|$)/.test(s.slice(KORIJEN.length)),
  })
  if (existsSync(join(KORIJEN, 'node_modules'))) symlinkSync(join(KORIJEN, 'node_modules'), join(k, 'node_modules'))
})
afterAll(() => { if (dom) rmSync(dom, { recursive: true, force: true }) })

const okolina = () => ({ ...process.env, HOME: dom, TM_KOMPLET_STVORENO: join(dom, 'stvoreno.txt') })

describe.skipIf(PREDLOZAK)('messages.db', () => {
  test('schema.sql is part of the komplet', () => {
    expect(existsSync(join(KORIJEN, 'schema.sql'))).toBe(true)
  })

  test('MessageQueue on a fresh HOME creates the messages table', () => {
    const r = spawnSync(process.execPath, ['-e', `
      const { getMessageQueue } = await import(${JSON.stringify(join(k, 'MessageQueue.ts'))})
      getMessageQueue()
      const { Database } = await import('bun:sqlite')
      const db = new Database(${JSON.stringify(join(k, 'messages.db'))}, { readonly: true })
      console.log(db.query("select count(*) n from sqlite_master where type='table' and name='messages'").get().n)
    `], { env: okolina(), encoding: 'utf-8', cwd: k })
    if (r.status !== 0) console.error(r.stderr)
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n').at(-1)).toBe('1')
  }, 60_000)
})

describe.skipIf(PREDLOZAK)('instalacija.sh: messages.db for the daemon', () => {
  // RegocDaemon opens messages.db directly (getDb) and never runs schema.sql — on a fresh node
  // the main loop then fails every second. instalacija.sh creates the tables once.
  test('after instalacija.sh messages.db has the messages table; second run: ISTO', () => {
    const d3 = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'komplet-pogon3-'))
    try {
      const k3 = join(d3, '.claude', 'regoc')
      mkdirSync(k3, { recursive: true })
      for (const f of ['instalacija.sh', 'schema.sql']) cpSync(join(KORIJEN, f), join(k3, f))
      const env = { ...process.env, HOME: d3 }
      const r1 = spawnSync('bash', [join(k3, 'instalacija.sh')], { env, encoding: 'utf-8' })
      if (r1.status !== 0) console.error(r1.stderr)
      expect(r1.status).toBe(0)
      const db = new Database(join(k3, 'messages.db'), { readonly: true })
      const n = (db.query("select count(*) n from sqlite_master where type='table' and name='messages'").get() as any).n
      db.close()
      expect(n).toBe(1)
      const r2 = spawnSync('bash', [join(k3, 'instalacija.sh')], { env, encoding: 'utf-8' })
      expect(r2.stdout.trim().split('\n').at(-1)).toBe('ISTO')
    } finally { rmSync(d3, { recursive: true, force: true }) }
  })
})

describe.skipIf(PREDLOZAK)('instalacija.sh --tm-home', () => {
  test('data/regoc.db points to the package board database; second run: ISTO', () => {
    const a = ['instalacija.sh', '--tm-home', tm]
    const r1 = spawnSync('bash', [join(k, a[0]!), ...a.slice(1)], { env: okolina(), encoding: 'utf-8' })
    expect(r1.status).toBe(0)
    const veza = join(k, 'data', 'regoc.db')
    expect(lstatSync(veza).isSymbolicLink()).toBe(true)
    expect(readlinkSync(veza)).toBe(join(tm, 'data', 'tasks.db'))
    const r2 = spawnSync('bash', [join(k, a[0]!), ...a.slice(1)], { env: okolina(), encoding: 'utf-8' })
    expect(r2.status).toBe(0)
    expect(r2.stdout.trim().split('\n').at(-1)).toBe('ISTO')
  })

  test('an existing data/regoc.db of the komplet is left alone', () => {
    const d2 = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'komplet-pogon2-'))
    try {
      const k2 = join(d2, '.claude', 'regoc')
      mkdirSync(join(k2, 'data'), { recursive: true })
      cpSync(join(KORIJEN, 'instalacija.sh'), join(k2, 'instalacija.sh'))
      new Database(join(k2, 'data', 'regoc.db')).close()
      const r = spawnSync('bash', [join(k2, 'instalacija.sh'), '--tm-home', tm], { env: { ...process.env, HOME: d2 }, encoding: 'utf-8' })
      expect(r.status).toBe(0)
      expect(lstatSync(join(k2, 'data', 'regoc.db')).isSymbolicLink()).toBe(false)
      expect(r.stdout).toContain('ostavljam data/regoc.db')
    } finally { rmSync(d2, { recursive: true, force: true }) }
  })
})
