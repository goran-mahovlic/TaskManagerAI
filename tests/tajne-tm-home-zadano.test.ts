/**
 * TASK-5693 (QA K6 TASK-5660, B4): `bun scripts/tajna.ts postavi` (README §5) i prijava-ai
 * bez TM_HOME u okolini pisali su tajnu u <paket>/config/, a usluga (s-okolinom.sh,
 * TM_HOME=~/.taskmanager) čita ~/.taskmanager/config/ → tajnaPostavljena=false. Uz to je
 * config/tajne-otisak.kljuc nastajao u git stablu → `git status --porcelain` ≠ prazno.
 *
 * Sad: kad postoji instalacija čvora ($HOME/.taskmanager/config/instalacija.env, piše je
 * install.sh), CLI bez TM_HOME koristi isti zadani TM_HOME kao paths.ts i s-okolinom.sh.
 */
import { describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { osigurajOvisnosti } from './helpers/ovisnosti'

const KORIJEN = join(import.meta.dir, '..')
const NODE_MODULES = osigurajOvisnosti(KORIJEN)
const BUN_DIR = dirname(process.execPath)
const radna = () => process.env.TMPDIR || tmpdir()
mkdirSync(radna(), { recursive: true })

/** Kopija paketa kao čist git klon (bez docs/) i prazan HOME. */
function okruzje(ime: string) {
  const korijen = mkdtempSync(join(radna(), `tm-tajne-${ime}-`))
  const home = join(korijen, 'home'), paket = join(korijen, 'paket')
  mkdirSync(home, { recursive: true })
  const popis = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: KORIJEN }).stdout.toString().split('\0').filter(Boolean)
  for (const rel of popis) {
    const izvor = join(KORIJEN, rel)
    if (!existsSync(izvor) || rel.startsWith('docs/') || rel.startsWith('tests/')) continue
    mkdirSync(dirname(join(paket, rel)), { recursive: true })
    cpSync(izvor, join(paket, rel))
  }
  symlinkSync(NODE_MODULES, join(paket, 'node_modules'))
  const g = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=proba', '-c', 'user.email=proba@example.invalid', ...a], { cwd: paket })
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '--no-verify', '-m', 'proba')
  return { korijen, home, paket, tm: join(home, '.taskmanager') }
}
type O = ReturnType<typeof okruzje>
/** Okolina korisnika u terminalu: BEZ TM_HOME i TM_CREDENTIALS. */
const env = (o: O) => ({ HOME: o.home, PATH: `${BUN_DIR}:/usr/bin:/bin`, LANG: 'C.UTF-8', TMPDIR: o.korijen })
function tajna(o: O, argv: string[], stdin?: string) {
  const r = Bun.spawnSync(['bun', 'scripts/tajna.ts', ...argv], { cwd: o.paket, env: env(o), stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
}
/** Što vidi usluga: ista okolina kao systemd/launchd jedinica (s-okolinom.sh --tajne). */
function uslugaVidi(o: O, ime: string): string {
  const kod = `import { tajnaPostavljena } from './src/core/ConfigModul'; console.log(tajnaPostavljena(${JSON.stringify(ime)}))`
  const r = Bun.spawnSync(['bash', 'scripts/s-okolinom.sh', '--', 'bun', '-e', kod], { cwd: o.paket, env: env(o), stdout: 'pipe', stderr: 'pipe' })
  return r.stdout.toString().trim()
}
const gitStatus = (o: O) => Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: o.paket }).stdout.toString()

describe('B4: tajna.ts bez TM_HOME na instaliranom čvoru', () => {
  test('postavi → tajna u ~/.taskmanager/config, usluga je vidi, git status prazan', () => {
    const o = okruzje('cvor')
    try {
      // instalacija čvora: install.sh piše instalacija.env (s TM_HOME)
      mkdirSync(join(o.tm, 'config'), { recursive: true, mode: 0o700 })
      writeFileSync(join(o.tm, 'config', 'instalacija.env'), `TM_HOME=${o.tm}\nTM_CREDENTIALS=${o.tm}/config/credentials.env\n`, { mode: 0o600 })
      const r = tajna(o, ['postavi', 'SMTP_PASSWORD'], 'vrijednost-probe')
      expect(r.kod, r.izlaz).toBe(0)
      expect(readFileSync(join(o.tm, 'config', 'credentials.env'), 'utf-8')).toContain('SMTP_PASSWORD=')
      expect(existsSync(join(o.paket, 'config', 'credentials.env'))).toBe(false)
      expect(existsSync(join(o.paket, 'config', 'tajne-otisak.kljuc'))).toBe(false)
      expect(uslugaVidi(o, 'SMTP_PASSWORD')).toBe('true')
      expect(gitStatus(o)).toBe('')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)

  test('bez instalacije čvora (razvojno stablo): piše uz paket, ali git status ostaje prazan', () => {
    const o = okruzje('razvoj')
    try {
      const r = tajna(o, ['postavi', 'SMTP_PASSWORD'], 'vrijednost-probe')
      expect(r.kod, r.izlaz).toBe(0)
      expect(existsSync(join(o.paket, 'config', 'credentials.env'))).toBe(true)
      expect(gitStatus(o)).toBe('')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})
