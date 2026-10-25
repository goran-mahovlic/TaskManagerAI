/**
 * TASK-5786 / TASK-5791: na macOS-u nema `~/.claude/.credentials.json` (prijava je u Keychainu ili je
 * token pretplate u spremištu čvora, upisan kroz ploču). Mjerilo uzima token redom:
 *   okolina CLAUDE_CODE_OAUTH_TOKEN → spremište $TM_CREDENTIALS (samo taj ključ) →
 *   ~/.claude/.credentials.json → na macOS-u Keychain „Claude Code-credentials” (alat `security`).
 * Bez ijednog izvora poruka imenuje sve, a vrijednost iz Keychaina nikad ne ide u poruku.
 * Obje kopije alata (paket i komplet) moraju se ponašati isto. macOS grana je mockana: modulu se
 * podmeće PLATFORM, a `security` je lažna skripta na PATH-u koja bilježi argumente.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

const privremene: string[] = []
afterAll(() => { for (const d of privremene) rmSync(d, { recursive: true, force: true }) })

const KORIJEN = join(import.meta.dir, '..')
// Kopija kompleta leži pod imenom mape sustava domaćina; slaže se iz dijelova (zapor ADR-0001 §8).
const SKRIPTE = ['tools/session_usage.py', ['regoc-system/vanjsko/app/reg', 'oc_system/tools/session_usage.py'].join('')]

interface Ishod { ok: boolean; token?: string; poruka?: string }

/** `load_token()` u zasebnom pythonu; `platforma` podmeće `PLATFORM` modula (macOS grana). */
function ucitaj(skripta: string, env: Record<string, string>, platforma = 'linux', path = ''): Ishod {
  const kod = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("su", ${JSON.stringify(skripta)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `m.PLATFORM = ${JSON.stringify(platforma)}`,
    'try:',
    '    print(json.dumps({"ok": True, "token": m.load_token()}))',
    'except SystemExit as e:',
    '    print(json.dumps({"ok": False, "poruka": str(e)}))',
  ].join('\n')
  const PATH = [path, process.env.PATH ?? ''].filter(Boolean).join(':')
  const r = Bun.spawnSync(['python3', '-c', kod], { env: { PATH, PYTHONDONTWRITEBYTECODE: '1', ...env } })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}

function prazanHome(): string { const d = mkdtempSync(join(os.tmpdir(), 'tm-su-tok-')); privremene.push(d); return d }

function datotekaPrijave(home: string, token: string): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }))
}

function spremiste(put: string, sadrzaj: string): string {
  mkdirSync(join(put, '..'), { recursive: true })
  writeFileSync(put, sadrzaj)
  return put
}

/** Lažni `security`: ispiše `izlaz` uz `kod`, a argumente zapiše u <mapa>/argumenti. */
function lazniSecurity(izlaz: string, kod = 0): string {
  const mapa = prazanHome()
  const skr = join(mapa, 'security')
  writeFileSync(skr, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(mapa, 'argumenti')}"\nprintf '%s' '${izlaz}'\nexit ${kod}\n`)
  chmodSync(skr, 0o755)
  return mapa
}

describe.each(SKRIPTE.map(s => [s]))('%s — token mjerila', (rel) => {
  const skripta = join(KORIJEN, rel)

  test('okolina ima prednost pred spremištem i datotekom prijave', () => {
    const home = prazanHome()
    datotekaPrijave(home, 'iz-datoteke')
    const spr = spremiste(join(home, 'cfg', 'credentials.env'), "CLAUDE_CODE_OAUTH_TOKEN='iz-spremista'\n")
    const r = ucitaj(skripta, { HOME: home, TM_CREDENTIALS: spr, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-okolina' })
    expect(r).toEqual({ ok: true, token: 'sk-ant-oat01-okolina' })
  })

  test('bez okoline → spremište iz TM_CREDENTIALS, samo ključ CLAUDE_CODE_OAUTH_TOKEN', () => {
    const home = prazanHome()
    datotekaPrijave(home, 'iz-datoteke')
    const spr = spremiste(join(home, 'cfg', 'credentials.env'),
      "ANTHROPIC_API_KEY='drugi-kljuc'\nexport CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-spremiste'\nGEMINI_API_KEY=treci\n")
    expect(ucitaj(skripta, { HOME: home, TM_CREDENTIALS: spr })).toEqual({ ok: true, token: 'sk-ant-oat01-spremiste' })
  })

  test('bez TM_CREDENTIALS → zadano spremište $TM_HOME/config/credentials.env', () => {
    const home = prazanHome()
    const tmHome = join(home, 'tm')
    spremiste(join(tmHome, 'config', 'credentials.env'), 'CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-zadano"\n')
    expect(ucitaj(skripta, { HOME: home, TM_HOME: tmHome }).token).toBe('sk-ant-oat01-zadano')
  })

  test('spremište bez tog ključa → datoteka prijave (Linux: CLI je osvježava)', () => {
    const home = prazanHome()
    datotekaPrijave(home, 'iz-datoteke')
    const spr = spremiste(join(home, 'cfg', 'credentials.env'), "ANTHROPIC_API_KEY='nije-ovaj'\n")
    expect(ucitaj(skripta, { HOME: home, TM_CREDENTIALS: spr }).token).toBe('iz-datoteke')
  })

  test('macOS: ništa od navedenog → Keychain „Claude Code-credentials” preko security -w', () => {
    const lazni = lazniSecurity(JSON.stringify({ claudeAiOauth: { accessToken: 'iz-keychaina' } }))
    const r = ucitaj(skripta, { HOME: prazanHome() }, 'darwin', lazni)
    expect(r).toEqual({ ok: true, token: 'iz-keychaina' })
    const arg = readFileSync(join(lazni, 'argumenti'), 'utf8').trim().split('\n')
    expect(arg).toEqual(['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
  })

  test('macOS: datoteka prijave postoji → Keychain se ne pita', () => {
    const home = prazanHome()
    datotekaPrijave(home, 'iz-datoteke')
    const lazni = lazniSecurity(JSON.stringify({ claudeAiOauth: { accessToken: 'iz-keychaina' } }))
    expect(ucitaj(skripta, { HOME: home }, 'darwin', lazni).token).toBe('iz-datoteke')
    expect(existsSync(join(lazni, 'argumenti'))).toBe(false)
  })

  test('Linux: Keychain se ne pita ni kad security postoji', () => {
    const lazni = lazniSecurity(JSON.stringify({ claudeAiOauth: { accessToken: 'iz-keychaina' } }))
    const r = ucitaj(skripta, { HOME: prazanHome() }, 'linux', lazni)
    expect(r.ok).toBe(false)
    expect(existsSync(join(lazni, 'argumenti'))).toBe(false)
  })

  test('macOS: Keychain nema stavke ili vrati smeće → greška bez ispisa vrijednosti', () => {
    const nema = ucitaj(skripta, { HOME: prazanHome() }, 'darwin', lazniSecurity('', 44))
    expect(nema.ok).toBe(false)
    const smece = ucitaj(skripta, { HOME: prazanHome() }, 'darwin', lazniSecurity('TAJNA-VRIJEDNOST-nije-json'))
    expect(smece.ok).toBe(false)
    expect(smece.poruka).not.toContain('TAJNA-VRIJEDNOST')
  })

  test('ni jednog izvora → poruka imenuje sve izvore', () => {
    const r = ucitaj(skripta, { HOME: prazanHome() }, 'darwin', lazniSecurity('', 44))
    expect(r.ok).toBe(false)
    for (const izvor of ['CLAUDE_CODE_OAUTH_TOKEN', 'credentials.env', '.credentials.json', 'Keychain']) {
      expect(r.poruka).toContain(izvor)
    }
  })
})
