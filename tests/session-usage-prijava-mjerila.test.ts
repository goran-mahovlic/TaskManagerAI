/**
 * TASK-5786: na macOS-u nema `~/.claude/.credentials.json` (prijava je u Keychainu, usluga ga ne
 * vidi) — token pretplate je u spremištu čvora i daemon ga dobiva u okolini (`s-okolinom.sh --tajne`).
 * Mjerilo ga mora uzeti odande, a bez ijednog izvora reći što fali (ne samo putanju datoteke).
 * Obje kopije alata (paket i komplet) moraju se ponašati isto.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

const privremene: string[] = []
afterAll(() => { for (const d of privremene) rmSync(d, { recursive: true, force: true }) })

const KORIJEN = join(import.meta.dir, '..')
const SKRIPTE = ['tools/session_usage.py', 'regoc-system/vanjsko/app/regoc_system/tools/session_usage.py']

/** `load_token()` u zasebnom pythonu: { ok, token } ili { ok:false, poruka }. */
function ucitaj(skripta: string, env: Record<string, string>): { ok: boolean; token?: string; poruka?: string } {
  const kod = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("su", ${JSON.stringify(skripta)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'try:',
    '    print(json.dumps({"ok": True, "token": m.load_token()}))',
    'except SystemExit as e:',
    '    print(json.dumps({"ok": False, "poruka": str(e)}))',
  ].join('\n')
  const r = Bun.spawnSync(['python3', '-c', kod], { env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1', ...env } })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}

function prazanHome(): string { const d = mkdtempSync(join(os.tmpdir(), 'tm-su-tok-')); privremene.push(d); return d }

describe.each(SKRIPTE.map(s => [s]))('%s — token mjerila', (rel) => {
  const skripta = join(KORIJEN, rel)

  test('nema datoteke prijave, token pretplate u okolini → koristi njega', () => {
    const r = ucitaj(skripta, { HOME: prazanHome(), CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-okolina' })
    expect(r).toEqual({ ok: true, token: 'sk-ant-oat01-okolina' })
  })

  test('datoteka prijave postoji → ona ima prednost (Linux: CLI je osvježava)', () => {
    const home = prazanHome()
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'iz-datoteke' } }))
    expect(ucitaj(skripta, { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-okolina' }).token).toBe('iz-datoteke')
  })

  test('ni datoteke ni tokena → poruka imenuje oba izvora', () => {
    const r = ucitaj(skripta, { HOME: prazanHome() })
    expect(r.ok).toBe(false)
    expect(r.poruka).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(r.poruka).toContain('.credentials.json')
  })
})
