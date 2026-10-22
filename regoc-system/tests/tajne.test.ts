/**
 * tajne.test.ts — secrets of the kit (TASK-5705): TAJNE.json lists every secret NAME the kit's
 * code reads (extracted by the export, never by hand) with a description in Croatian and English,
 * and instalacija.sh --tm-home links credentials.env to the package's secret store, where the
 * node owner enters values on the board (Config → Secrets). No value is ever part of the kit.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, readlinkSync, lstatSync, mkdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const KORIJEN = join(import.meta.dir, '..')
// The template (deploy/…/predlozak) is not a komplet: no sources, schema.sql, MANIFEST or generated
// lists until gradi_komplet.sh builds one. There the tests skip instead of failing (TASK-5662).
const PREDLOZAK = basename(KORIJEN) === 'predlozak' && !existsSync(join(KORIJEN, 'MANIFEST.sha256'))
const T = PREDLOZAK ? { tajne: [] } : JSON.parse(readFileSync(join(KORIJEN, 'TAJNE.json'), 'utf-8'))
const dom = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'komplet-tajne-'))
afterAll(() => rmSync(dom, { recursive: true, force: true }))

describe.skipIf(PREDLOZAK)('TAJNE.json', () => {
  test('names only: each entry has name, components, required flag and HR/EN text — no value field', () => {
    expect(T.tajne.length).toBeGreaterThan(0)
    for (const t of T.tajne) {
      expect(t.ime).toMatch(/^[A-Z][A-Z0-9_]{1,63}_(API_KEY|KEY|TOKEN|PASSWORD|PASS|SECRET)$/)
      expect(Object.keys(t).sort()).toEqual(['bez_nje', 'ime', 'komponente', 'obavezno', 'opis'])
      expect(t.komponente.length).toBeGreaterThan(0)
      for (const k of t.komponente) expect(existsSync(join(KORIJEN, k))).toBe(true)
      for (const j of ['hr', 'en']) { expect(t.opis[j].length).toBeGreaterThan(10); expect(t.bez_nje[j].length).toBeGreaterThan(10) }
    }
  })

  test('every name is listed in the README section on secrets (HR and EN)', () => {
    for (const f of ['README.md', 'README.hr.md']) {
      const r = readFileSync(join(KORIJEN, f), 'utf-8')
      for (const t of T.tajne) expect(r).toContain(t.ime)
    }
  })
})

describe.skipIf(PREDLOZAK)('instalacija.sh --tm-home', () => {
  test('credentials.env → $TM_HOME/config/credentials.env (dangling until the first entry); second run ISTO', () => {
    const k = join(dom, '.claude', 'regoc'); mkdirSync(join(dom, '.claude'), { recursive: true })
    cpSync(KORIJEN, k, { recursive: true, verbatimSymlinks: true,
      filter: (s) => !/^\/(\.git|node_modules|data|config|tmp)(\/|$)/.test(s.slice(KORIJEN.length)) })
    const tm = join(dom, '.taskmanager')
    const env = { ...process.env, HOME: dom }
    const r1 = spawnSync('bash', [join(k, 'instalacija.sh'), '--tm-home', tm], { env, encoding: 'utf-8' })
    expect(r1.status).toBe(0)
    expect(lstatSync(join(k, 'credentials.env')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(k, 'credentials.env'))).toBe(join(tm, 'config', 'credentials.env'))
    expect(existsSync(join(tm, 'config', 'credentials.env'))).toBe(false) // the board's writer creates it
    const r2 = spawnSync('bash', [join(k, 'instalacija.sh'), '--tm-home', tm], { env, encoding: 'utf-8' })
    expect(r2.status).toBe(0)
    expect(r2.stdout.trim().split('\n').at(-1)).toBe('ISTO')
  })
})
