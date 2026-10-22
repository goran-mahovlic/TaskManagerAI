/**
 * gradnja.test.ts — the module graph of every entry point resolves on a clean machine
 * (plan Mac v3 P11, K3a: `bun build RegocDaemon.ts` on a fresh clone; TASK-5328: without
 * this proof the daemon ends up in a restart loop).
 *
 * The komplet lives in ~/.claude/regoc and imports a few modules from ../skills, ../VoiceServer,
 * ../tools — instalacija.sh creates those links. The test copies the komplet into a temporary
 * HOME, runs instalacija.sh there (twice: the second run must report ISTO) and builds every
 * entry from ULAZI.txt. Nothing outside the temporary HOME is read or written.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const KORIJEN = join(import.meta.dir, '..')
// The template (deploy/…/predlozak) is not a komplet: no sources, schema.sql, MANIFEST or generated
// lists until gradi_komplet.sh builds one. There the tests skip instead of failing (TASK-5662).
const PREDLOZAK = basename(KORIJEN) === 'predlozak' && !existsSync(join(KORIJEN, 'MANIFEST.sha256'))
const ULAZI = PREDLOZAK ? [] : readFileSync(join(KORIJEN, 'ULAZI.txt'), 'utf-8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
let dom: string, k: string

beforeAll(() => {
  if (PREDLOZAK) return
  dom = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'komplet-gradnja-'))
  k = join(dom, '.claude', 'regoc')
  mkdirSync(join(dom, '.claude'), { recursive: true })
  cpSync(KORIJEN, k, {
    recursive: true, verbatimSymlinks: true,
    filter: (s) => !/^\/(\.git|node_modules|data|config|tmp)(\/|$)/.test(s.slice(KORIJEN.length)),
  })
  if (existsSync(join(KORIJEN, 'node_modules'))) symlinkSync(join(KORIJEN, 'node_modules'), join(k, 'node_modules'))
})
afterAll(() => { if (dom) rmSync(dom, { recursive: true, force: true }) })

const STVORENO = () => join(dom, 'stvoreno.txt')
const okolina = () => ({ ...process.env, HOME: dom, TM_KOMPLET_STVORENO: STVORENO() })

describe.skipIf(PREDLOZAK)('instalacija.sh', () => {
  test('first run: PROMIJENJENO, second run: ISTO', () => {
    const r1 = spawnSync('bash', [join(k, 'instalacija.sh')], { env: okolina(), encoding: 'utf-8' })
    expect(r1.status).toBe(0)
    expect(r1.stdout.trim().split('\n').at(-1)).toBe('PROMIJENJENO')
    const r2 = spawnSync('bash', [join(k, 'instalacija.sh')], { env: okolina(), encoding: 'utf-8' })
    expect(r2.status).toBe(0)
    expect(r2.stdout.trim().split('\n').at(-1)).toBe('ISTO')
    expect(existsSync(join(dom, '.claude', 'settings.json'))).toBe(true)
    expect(readdirSync(join(k, 'config')).length).toBeGreaterThan(0)
    // what was created outside the komplet is reported (put|vrsta) so the package can remove it again
    const redovi = readFileSync(STVORENO(), 'utf-8').trim().split('\n')
    expect(redovi).toContain(`${join(dom, '.claude', 'settings.json')}|datoteka`)
    expect(redovi).toContain(`${join(dom, '.claude', 'hooks')}|mapa`)
    expect(redovi.filter(r => r.endsWith('|veza')).length).toBeGreaterThan(3)
    expect(redovi.length).toBe(new Set(redovi).size) // the second run reported nothing new
  })
})

describe.skipIf(PREDLOZAK)('bun build', () => {
  test('ULAZI.txt names the daemon', () => {
    expect(ULAZI).toContain('RegocDaemon.ts')
  })
  for (const u of ULAZI) {
    test(`${u} resolves`, () => {
      expect(existsSync(join(k, '..', 'settings.json'))).toBe(true) // instalacija.sh ran first
      const r = spawnSync(process.execPath, ['build', join(k, u), '--target=bun', `--outdir=${join(dom, 'out', u.replace(/\//g, '_'))}`],
        { env: okolina(), encoding: 'utf-8' })
      if (r.status !== 0) console.error(r.stderr || r.stdout)
      expect(r.status).toBe(0)
    }, 120_000)
  }
})
