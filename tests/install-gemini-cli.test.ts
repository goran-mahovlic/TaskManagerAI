/**
 * TASK-5733 (A) — `install.sh --gemini-cli` i scripts/instalacija/gemini-cli.sh.
 *
 * Bez mreže: izdanje Node-a je LAŽNO (mapa s SHASUMS256.txt i tarballom, adresa file://),
 * `node` u tarballu prosljeđuje bunu, a `npm` „instalira" gemini u --prefix. Provjerava se:
 *   • prvi prolaz: Node u ~/.local/node (SHA256 provjeren), gemini, poveznice, settings.json,
 *   • drugi prolaz: bez promjene (idempotentno),
 *   • kriv SHA256 → izlaz 5 i ništa raspakirano,
 *   • --suho ne piše ništa i ispisuje korake; isto kroz install.sh --gemini-cli --suho.
 *
 * Autorica: Jelena (Engineer), TASK-5733.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const SKRIPTA = join(KORIJEN, 'scripts/instalacija/gemini-cli.sh')
const VERZIJA = 'v22.99.0'
const IME = `node-${VERZIJA}-linux-x64`

let mapa: string, home: string, dist: string
beforeEach(() => {
  mapa = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-gemcli-'))
  home = join(mapa, 'home')
  dist = join(mapa, 'dist')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(mapa, 'tmp'))
  // Lažno izdanje: bin/node (--version, ostalo bunu) i bin/npm (stvara <prefix>/bin/gemini).
  const bin = join(mapa, 'gradnja', IME, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'node'), `#!/bin/sh\n[ "$1" = --version ] && { echo ${VERZIJA}; exit 0; }\nexec '${process.execPath}' "$@"\n`)
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
p=""; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && p="$2"; last="$1"; shift; done
[ "$last" = "@google/gemini-cli" ] || exit 9
mkdir -p "$p/bin" && printf '#!/bin/sh\\necho gemini-lazni\\n' > "$p/bin/gemini" && chmod 755 "$p/bin/gemini"
echo "added 1 package"
`)
  chmodSync(join(bin, 'node'), 0o755)
  chmodSync(join(bin, 'npm'), 0o755)
  mkdirSync(dist)
  const tar = Bun.spawnSync(['tar', '-czf', join(dist, `${IME}.tar.gz`), '-C', join(mapa, 'gradnja'), IME])
  expect(tar.exitCode).toBe(0)
  const sha = new Bun.CryptoHasher('sha256').update(readFileSync(join(dist, `${IME}.tar.gz`))).digest('hex')
  writeFileSync(join(dist, 'SHASUMS256.txt'), `${'0'.repeat(64)}  node-${VERZIJA}-darwin-arm64.tar.gz\n${sha}  ${IME}.tar.gz\n${'1'.repeat(64)}  ${IME}.tar.xz\n`)
})
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

function pokreni(argv: string[] = [], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', SKRIPTA, ...argv], {
    env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(mapa, 'tmp'), TM_NODE_DIST: `file://${dist}`, TM_INSTALL_OS: 'Linux', TM_INSTALL_ARCH: 'x86_64', ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
}
const datoteke = (d: string): string[] => existsSync(d)
  ? readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? [e.name + '/', ...datoteke(join(d, e.name)).map(x => `${e.name}/${x}`)] : [e.name])
  : []

describe('gemini-cli.sh', () => {
  test('prvi prolaz instalira, drugi ne mijenja ništa', () => {
    mkdirSync(join(home, '.gemini'))
    writeFileSync(join(home, '.gemini/settings.json'), JSON.stringify({ theme: 'Default' }))
    const r = pokreni()
    expect(r.kod).toBe(0)
    expect(r.izlaz).toContain(`SHA256 ${IME}.tar.gz ✓`)
    expect(r.izlaz).toContain('PROMJENA')
    expect(r.izlaz).toContain(`MANIFEST ${home}/.local/node mapa`)
    expect(Bun.spawnSync([join(home, '.local/node/bin/node'), '--version']).stdout.toString().trim()).toBe(VERZIJA)
    expect(existsSync(join(home, '.local/node/bin/gemini'))).toBe(true)
    for (const b of ['node', 'gemini']) {
      expect(lstatSync(join(home, '.local/bin', b)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(home, '.local/bin', b))).toBe(join(home, '.local/node/bin', b))
    }
    // Postojeće postavke ostaju, dodaje se samo autentikacija ključem.
    expect(JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf-8'))).toEqual({ theme: 'Default', selectedAuthType: 'gemini-api-key' })

    const r2 = pokreni()
    expect(r2.kod).toBe(0)
    expect(r2.izlaz).not.toContain('PROMJENA')
    expect(r2.izlaz).toContain('već postoji')
    expect(r2.izlaz).toContain('(isto)')
  })

  test('kriv SHA256 → izlaz 5, ~/.local/node se ne stvara', () => {
    const p = join(dist, 'SHASUMS256.txt')
    writeFileSync(p, readFileSync(p, 'utf-8').replace(/^[0-9a-f]{64}(  node-v22\.99\.0-linux-x64\.tar\.gz)$/m, `${'f'.repeat(64)}$1`))
    const r = pokreni()
    expect(r.kod).toBe(5)
    expect(r.izlaz).toMatch(/SHA256 .* se ne slaže/)
    expect(existsSync(join(home, '.local/node'))).toBe(false)
  })

  test('tuđa ~/.local/bin/node se ne prepisuje (upozorenje)', () => {
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    writeFileSync(join(home, '.local/bin/node'), 'tuđe')
    const r = pokreni()
    expect(r.kod).toBe(0)
    expect(r.izlaz).toContain(`UPOZORENJE ${home}/.local/bin/node već postoji`)
    expect(readFileSync(join(home, '.local/bin/node'), 'utf-8')).toBe('tuđe')
  })

  test('--suho ispisuje korake i ne piše ništa', () => {
    const r = pokreni(['--suho'])
    expect(r.kod).toBe(0)
    expect(r.izlaz).toContain('(suho) preuzela bih')
    expect(r.izlaz).toContain('(suho) npm install -g --prefix')
    expect(r.izlaz).toContain('(suho) ln -s')
    expect(r.izlaz).toContain('selectedAuthType=gemini-api-key')
    expect(datoteke(home)).toEqual([])
  })

  test('nepodržana platforma → izlaz 3', () => {
    expect(pokreni([], { TM_INSTALL_ARCH: 'mips' }).kod).toBe(3)
  })
})

describe('install.sh --gemini-cli --suho', () => {
  test('korak K2.13b-gemini-cli ispisuje korake Geminija; bez --gemini-cli „nije traženo"', () => {
    const run = (argv: string[]) => {
      const r = Bun.spawnSync(['bash', 'scripts/install.sh', ...argv], {
        cwd: KORIJEN,
        env: {
          HOME: home, PATH: `${join(process.execPath, '..')}:/usr/bin:/bin`, USER: 'proba', LANG: 'C.UTF-8', TMPDIR: join(mapa, 'tmp'),
          TM_PORT: '29871', TM_BEZ_MREZE: '1', TM_INSTALL_SLOBODNO_MIB: '100000', TM_NODE_DIST: `file://${dist}`,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
    }
    const r = run(['--suho', '--bez-servisa', '--gemini-cli'])
    expect(r.kod).toBe(0)
    const dio = r.izlaz.slice(r.izlaz.indexOf('K2.13b-gemini-cli'))
    expect(dio).toContain('(suho) preuzela bih')
    expect(dio).toContain('(suho) npm install -g --prefix')
    expect(dio).toContain('GEMINI_API_KEY')
    expect(existsSync(join(home, '.local'))).toBe(false)
    const bez = run(['--suho', '--bez-servisa'])
    expect(bez.izlaz).toMatch(/K2\.13b-gemini-cli[\s\S]{0,200}nije traženo \(--gemini-cli\)/)
  }, 60_000)
})
