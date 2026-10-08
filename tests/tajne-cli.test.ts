// TASK-5343 (ADR-0007 §8.4, §9) — CLI za stroj i bootstrap. J17: vrijednost nikad u argv.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { procitajIzTeksta } from '../src/LoginCreds'

const SKRIPTA = join(import.meta.dir, '..', 'scripts', 'tajna.ts')
let dom = ''
beforeEach(() => { dom = mkdtempSync(join(process.env.TM_TEST_TMP || tmpdir(), 'tajne-cli-')); mkdirSync(join(dom, 'config')); chmodSync(dom, 0o700) })
afterEach(() => { rmSync(dom, { recursive: true, force: true }) })

const pokreni = (argv: string[], stdin?: string) => {
  const env: Record<string, string | undefined> = { ...process.env, TM_HOME: dom }
  delete env.TM_CREDENTIALS; delete env.TM_TAJNE_POSTAVKE
  const r = Bun.spawnSync(['bun', SKRIPTA, ...argv], {
    env: env as Record<string, string>,
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
  })
  return { kod: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const spremiste = () => join(dom, 'config', 'credentials.env')

describe('scripts/tajna.ts', () => {
  test('vrijednost u argv → izlaz 2, ništa se ne piše', () => {
    const r = pokreni(['postavi', 'SMTP_PASSWORD', 'tajna-u-argv'])
    expect(r.kod).toBe(2)
    expect(r.out + r.err).not.toContain('tajna-u-argv')
    expect(existsSync(spremiste())).toBe(false)
  })
  test('postavi iz stdin cijevi (bez završnog \\n), popis bez vrijednosti, obriši', () => {
    const v = "x$(id)'y"
    const r = pokreni(['postavi', 'SMTP_PASSWORD'], v + '\n')
    expect(r.kod).toBe(0)
    expect(r.out + r.err).not.toContain(v)
    expect(procitajIzTeksta(readFileSync(spremiste(), 'utf-8'), 'SMTP_PASSWORD')).toBe(v)
    expect(statSync(spremiste()).mode & 0o777).toBe(0o600)
    const p = pokreni(['popis'])
    expect(p.kod).toBe(0)
    expect(p.out).toMatch(/SMTP_PASSWORD\s+postoji\s+[0-9a-f]{8}/)
    expect(p.out).not.toContain(v)
    expect(pokreni(['obrisi', 'SMTP_PASSWORD']).kod).toBe(0)
    expect(readFileSync(spremiste(), 'utf-8')).toBe('')
    expect(readFileSync(join(dom, 'data', 'tajne_audit.jsonl'), 'utf-8')).not.toContain(v)
  })
  test('zabranjeno ime i prazna vrijednost → izlaz 2', () => {
    expect(pokreni(['postavi', 'BASH_ENV'], 'x').kod).toBe(2)
    expect(pokreni(['postavi', 'SMTP_PASSWORD'], '').kod).toBe(2)
  })
  test('podesi --potvrda-uid piše config/tajne.json (bez tajne)', () => {
    expect(pokreni(['podesi', '--potvrda-uid', '123456']).kod).toBe(0)
    const j = JSON.parse(readFileSync(join(dom, 'config', 'tajne.json'), 'utf-8'))
    expect(j.potvrdaUid).toEqual(['123456'])
    expect(pokreni(['podesi', '--potvrda-uid', 'abc']).kod).toBe(2)
  })
})
