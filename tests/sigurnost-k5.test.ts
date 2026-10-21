/**
 * TASK-5685 (K5 sigurnosni pregled TASK-5659, nalazi V1, V2, N1):
 *   V2 — install.sh i deinstaliraj.sh ne rade kao root (izlaz 2), servis.ts odbija KORISNIK = root ili prazan,
 *   V1 — neograničen sudo korisnika usluge (NOPASSWD: ALL) je UPOZORENJE u install.sh i bootchecku (M8),
 *        a templates/servis/sudoers.primjer nabraja TOČNE naredbe za svaku uslugu, bez zamjenskih znakova,
 *   N1 — poruka pada sudo install ne upućuje na nepostojeći `install.sh --sudoers`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { datotekeUsluge, primijeni, sudoersPrimjer, ucitajOpise, vrijednosti } from '../scripts/instalacija/servis'
import * as B from '../scripts/bootcheck'

const KORIJEN = join(import.meta.dir, '..')
const MAPE: string[] = []
const privremena = (pref: string) => {
  const r = process.env.TMPDIR || tmpdir(); mkdirSync(r, { recursive: true })
  const d = mkdtempSync(join(r, pref)); MAPE.push(d); return d
}
afterAll(() => { for (const d of MAPE) rmSync(d, { recursive: true, force: true }) })
const OPISI = ucitajOpise()
const BAZA = { HOME: '/Users/korisnik', TM_HOME: '/Users/korisnik/.taskmanager', PAKET: '/Users/korisnik/TaskManagerAI',
  BUN: '/Users/korisnik/.bun/bin/bun', KOMPLET: '/Users/korisnik/komplet', TM_PORT: '17781' }

/** Mapa s lažnim naredbama (ide ispred PATH-a). */
function lazne(naredbe: Record<string, string>): string {
  const d = privremena('tm-k5-bin-')
  for (const [ime, tijelo] of Object.entries(naredbe)) {
    writeFileSync(join(d, ime), `#!/bin/bash\n${tijelo}\n`); chmodSync(join(d, ime), 0o755)
  }
  return d
}
const KAO_ROOT = { id: '[ "$1" = "-u" ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"' }

function skripta(ime: string, argv: string[], predpath: string, env: Record<string, string> = {}) {
  const home = privremena('tm-k5-home-')
  const r = Bun.spawnSync(['bash', `scripts/${ime}`, ...argv], {
    cwd: KORIJEN, stdout: 'pipe', stderr: 'pipe',
    env: { HOME: home, PATH: `${predpath}:${process.env.PATH}`, USER: 'proba', LANG: 'C.UTF-8',
      TMPDIR: process.env.TMPDIR || tmpdir(), TM_BEZ_MREZE: '1', TM_PORT: '29781', ...env },
  })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString(), home }
}

describe('V2: brana za root', () => {
  test('install.sh pokrenut kao root (id -u = 0) izlazi s 2 i ne piše ništa', () => {
    const r = skripta('install.sh', ['--suho', '--cvor', 'proba'], lazne(KAO_ROOT))
    expect(r.kod).toBe(2)
    expect(r.izlaz).toContain('pokreni kao korisnik usluge, bez sudo')
    expect(Bun.spawnSync(['find', r.home, '-mindepth', '1']).stdout.toString()).toBe('')
  })
  test('deinstaliraj.sh pokrenut kao root izlazi s 2', () => {
    const r = skripta('deinstaliraj.sh', ['--suho'], lazne(KAO_ROOT))
    expect(r.kod).toBe(2)
    expect(r.izlaz).toContain('pokreni kao korisnik usluge, bez sudo')
  })
  test('--help radi i kao root (samo ispis)', () => {
    expect(skripta('install.sh', ['--help'], lazne(KAO_ROOT)).kod).toBe(0)
  })
  test('servis.ts: USER=root → plist se ne radi (ni launchd ni systemd)', () => {
    const v = vrijednosti({ ...BAZA, USER: 'root' })
    for (const os of ['darwin', 'linux']) expect(() => datotekeUsluge(OPISI[0], os, v)).toThrow(/root/)
  })
  test('servis.ts: prazan KORISNIK se odbija', () => {
    const v = { ...vrijednosti({ ...BAZA, USER: 'korisnik' }), KORISNIK: '' }
    expect(() => datotekeUsluge(OPISI[0], 'darwin', v)).toThrow(/prazan/)
    expect(() => datotekeUsluge(OPISI[0], 'linux', v)).toThrow(/prazan/)
  })
  test('servis.ts CLI (reprodukcija iz pregleda): USER=root prikazi --os darwin → izlaz 2, nema UserName=root', () => {
    const r = Bun.spawnSync(['bun', 'scripts/instalacija/servis.ts', 'prikazi', '--ime', 'taskmanager', '--os', 'darwin'],
      { cwd: KORIJEN, env: { PATH: process.env.PATH!, USER: 'root', HOME: '/var/root' }, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode).toBe(2)
    expect(r.stdout.toString()).not.toContain('<string>root</string>')
    expect(r.stderr.toString()).toMatch(/root/)
  })
  test('obični korisnik i dalje dobiva svoj UserName', () => {
    const [d] = datotekeUsluge(OPISI[0], 'darwin', vrijednosti({ ...BAZA, USER: 'regoc' }))
    expect(d.sadrzaj).toContain('<key>UserName</key>')
    expect(d.sadrzaj).toContain('<string>regoc</string>')
  })
})

describe('N1: poruka pada sudo install', () => {
  test('ne upućuje na nepostojeći install.sh --sudoers, nego na sudo -v i sudoers.primjer', () => {
    const tm = privremena('tm-k5-tm-')
    const v = { ...vrijednosti({ ...BAZA, USER: 'regoc' }), TM_HOME: tm }
    const ex = (a: string[]) => ({ kod: a[0] === 'launchctl' || (a[0] === 'sudo' && a[2] === 'install') ? 1 : 0, izlaz: '' })
    let poruka = ''
    try { primijeni(OPISI[0], 'darwin', v, { ex, vrijeme: 't' }) } catch (e) { poruka = (e as Error).message }
    expect(poruka).toContain('sudo install')
    expect(poruka).not.toContain('--sudoers')
    expect(poruka).toContain('sudo -v')
    expect(readFileSync(join(KORIJEN, 'scripts/install.sh'), 'utf-8')).not.toMatch(/^\s+--sudoers\b/m)
  })
})

describe('V1b: templates/servis/sudoers.primjer', () => {
  const PRIMJER = readFileSync(join(KORIJEN, 'templates/servis/sudoers.primjer'), 'utf-8')
  test('datoteka je točno izlaz generatora iz usluge.json (ne razilazi se s uslugama)', () => {
    expect(PRIMJER).toBe(sudoersPrimjer(OPISI))
  })
  test('za SVAKU uslugu: kickstart -k, kickstart, bootout i bootstrap s točnom putanjom plista', () => {
    for (const o of OPISI) {
      const oz = `hr.regoc.${o.ime}`
      expect(PRIMJER).toContain(`/bin/launchctl kickstart -k system/${oz},`)
      expect(PRIMJER).toContain(`/bin/launchctl kickstart system/${oz},`)
      expect(PRIMJER).toContain(`/bin/launchctl bootout system/${oz},`)
      expect(PRIMJER).toMatch(new RegExp(`/bin/launchctl bootstrap system /Library/LaunchDaemons/${oz.replace(/\./g, '\\.')}\\.plist(,|$)`, 'm'))
    }
  })
  test('nema zamjenskog znaka * ni ? ni [ (hr.regoc.*.plist propušta i ../../tmp/zlo.plist), ni ALL kao naredbe', () => {
    expect(PRIMJER).not.toContain('*')
    const pravila = PRIMJER.split('\n').filter(r => !r.startsWith('#')).join('\n')
    expect(pravila).not.toMatch(/[?[\]]/)
    expect(pravila).not.toMatch(/NOPASSWD:\s*ALL/)
    expect(PRIMJER).toMatch(/^KORISNIK_USLUGE ALL=\(root\) NOPASSWD: REGOC_USLUGE$/m)
  })
  test('generator s --korisnik: root i nesigurno ime se odbijaju', () => {
    expect(sudoersPrimjer(OPISI, 'regoc')).toMatch(/^regoc ALL=\(root\) NOPASSWD: REGOC_USLUGE$/m)
    expect(() => sudoersPrimjer(OPISI, 'root')).toThrow(/root/)
    expect(() => sudoersPrimjer(OPISI, 'a b')).toThrow()
    expect(() => sudoersPrimjer(OPISI, 'ALL')).toThrow()
  })
  test('visudo -c prihvaća sintaksu (gdje visudo postoji)', () => {
    const visudo = ['/usr/sbin/visudo', '/usr/bin/visudo'].find(p => Bun.spawnSync(['test', '-x', p]).exitCode === 0)
    if (!visudo) return
    const f = join(privremena('tm-k5-sud-'), 'regoc')
    writeFileSync(f, sudoersPrimjer(OPISI, 'regoc'))
    const r = Bun.spawnSync([visudo, '-c', '-f', f], { stdout: 'pipe', stderr: 'pipe' })
    expect(`${r.exitCode} ${r.stdout}${r.stderr}`).toMatch(/^0 /)
  })
})

describe('V1a: neograničen sudo korisnika usluge', () => {
  const UZORCI_DA = ['User regoc may run the following commands on mac:\n    (ALL) NOPASSWD: ALL\n',
    'User x may run:\n    (ALL : ALL) NOPASSWD: ALL\n', '    (root) NOPASSWD: SETENV: ALL\n', '    (ALL) ALL\n    (ALL:ALL) NOPASSWD:ALL\n']
  const UZORCI_NE = ['', '    (ALL) ALL\n', '    (root) NOPASSWD: /bin/launchctl kickstart -k system/hr.regoc.taskmanager\n']
  test('prepoznavanje izlaza sudo -n -l', () => {
    for (const u of UZORCI_DA) expect(B.neogranicenSudo(u)).toBe(true)
    for (const u of UZORCI_NE) expect(B.neogranicenSudo(u)).toBe(false)
  })
  test('bootcheck M8: NOPASSWD: ALL → UPOZORENJE (ne pad) s uputom na sudoers.primjer', async () => {
    const k = B.napraviKontekst({ os: 'linux', okolina: { os: 'linux', izvrsi: a => a.join(' ') === 'sudo -n -l' ? UZORCI_DA[0] : null },
      home: '/home/x', env: {}, opisUsluge: () => ({ stanje: 'inactive', pid: null, cwd: null }) })
    const r = await B.m8(k)
    expect(r.id).toBe('M8')
    expect(r.sud).toBe('UPOZORENJE')
    expect(r.detalji.join(' ')).toContain('korisnik usluge ima neograničen sudo')
    expect(r.detalji.join(' ')).toContain('sudoers.primjer')
    expect(B.verdikt([r])).toBe('PASS')
  })
  test('bootcheck M8: sudo traži lozinku / suženi sudoers → PASS', async () => {
    for (const izl of [null, UZORCI_NE[2]]) {
      const k = B.napraviKontekst({ os: 'linux', okolina: { os: 'linux', izvrsi: () => izl }, home: '/home/x', env: {},
        opisUsluge: () => ({ stanje: 'inactive', pid: null, cwd: null }) })
      expect((await B.m8(k)).sud).toBe('PASS')
    }
  })
  test('install.sh: sudo -n -l s NOPASSWD: ALL → UPOZORENJE u koraku preduvjeta i u sažetku na kraju', () => {
    const sudo = lazne({ sudo: `[ "$1 $2" = "-n -l" ] && { printf 'User proba may run:\\n    (ALL : ALL) NOPASSWD: ALL\\n'; exit 0; }\nexit 1` })
    const r = skripta('install.sh', ['--suho', '--posudi', '--bez-servisa', '--preskoci', 'pdf'], sudo)
    expect(r.izlaz).toMatch(/UPOZORENJE: korisnik usluge \(\S+\) ima neograničen sudo/)
    expect(r.izlaz).toMatch(/upozorenje: K2\.3-preduvjeti: korisnik usluge ima neograničen sudo.*sudoers\.primjer/)
  }, 120_000)
  test('install.sh: bez neograničenog sudo-a nema tog upozorenja', () => {
    const r = skripta('install.sh', ['--suho', '--posudi', '--bez-servisa', '--preskoci', 'pdf'], lazne({ sudo: 'exit 1' }))
    expect(r.izlaz).not.toContain('neograničen sudo')
  }, 120_000)
})
