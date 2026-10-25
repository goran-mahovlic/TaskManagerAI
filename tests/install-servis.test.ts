/**
 * TASK-5655 (plan Mac v3 P2, P10 #1–#8): usluge čvora iz jednog opisa za systemd i launchd,
 * omotač okoline s-okolinom.sh i manifest instalacije.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { datotekeUsluge, primijeni, ucitajOpise, vrijednosti, zamijeni } from '../scripts/instalacija/servis'
import { spoji } from '../scripts/instalacija/manifest'

const KORIJEN = join(import.meta.dir, '..')
const radna = () => { const d = process.env.TMPDIR || tmpdir(); mkdirSync(d, { recursive: true }); return d }
const V = vrijednosti({ HOME: '/home/korisnik', TM_HOME: '/home/korisnik/.taskmanager', PAKET: '/home/korisnik/TaskManagerAI',
  BUN: '/home/korisnik/.bun/bin/bun', KOMPLET: '/home/korisnik/komplet', USER: 'korisnik', TM_PORT: '17781' })
const OPISI = ucitajOpise()
const opis = (ime: string) => OPISI.find(o => o.ime === ime)!

/** plist → objekt (Python plistlib je strog parser istog formata kao plutil). */
function plist(t: string): any {
  const r = Bun.spawnSync(['python3', '-c', 'import plistlib,sys,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { stdin: new TextEncoder().encode(t) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}

describe('opis usluga', () => {
  test('šest usluga s uvjetima; paketni orkestrator nije među njima (uz komplet vodi RegocDaemon, R15); voice (TASK-5795) samo uz glas', () => {
    expect(OPISI.map(o => `${o.ime}:${o.uvjet}`)).toEqual(['taskmanager:uvijek', 'daemon:komplet', 'znanje:komplet', 'voice:glas', 'pgvector:baze', 'hindsight:baze'])
  })
  test('nepoznata ili nezadana varijabla predloška ruši izradu (ne piše se prazna putanja)', () => {
    expect(() => zamijeni('{{NEMA}}', V)).toThrow(/nepoznata/)
    expect(() => zamijeni('{{KOMPLET}}/x', { ...V, KOMPLET: '' })).toThrow(/nije zadana/)
  })
})

describe('launchd (macOS)', () => {
  test('svaki plist je ispravan, radi kao korisnik instalacije, u pozadini, bez tajni', () => {
    for (const o of OPISI) {
      const [d] = datotekeUsluge(o, 'darwin', V)
      expect(d.put).toBe(`/Library/LaunchDaemons/hr.regoc.${o.ime}.plist`)
      const p = plist(d.sadrzaj)
      expect(p.Label).toBe(`hr.regoc.${o.ime}`)
      expect(p.UserName).toBe('korisnik')
      expect(p.ProcessType).toBe('Background')
      expect(p.LowPriorityIO).toBe(true)
      expect(p.EnvironmentVariables.TMPDIR).toBe('/home/korisnik/.taskmanager/tmp')
      expect(p.EnvironmentVariables.PATH).toContain('/home/korisnik/.local/bin')
      expect(p.StandardOutPath).toBe(`/home/korisnik/.taskmanager/log/${o.ime}.log`)
      expect(d.sadrzaj).not.toMatch(/_(KEY|TOKEN|PASSWORD|SECRET)\b/)
    }
  })
  test('ploča stalno, daemon nakon pada i čeka ploču, znanje svakih 1800 s, baze se ne pokreću same', () => {
    const p = (ime: string) => plist(datotekeUsluge(opis(ime), 'darwin', V)[0].sadrzaj)
    expect(p('taskmanager')).toMatchObject({ RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5 })
    expect(p('daemon')).toMatchObject({ RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, WorkingDirectory: '/home/korisnik/komplet' })
    expect(p('daemon').ProgramArguments).toEqual(['/home/korisnik/TaskManagerAI/scripts/s-okolinom.sh', '--tajne', '--cekaj',
      'http://127.0.0.1:17781/health', '--', '/home/korisnik/.bun/bin/bun', 'RegocDaemon.ts'])
    expect(p('znanje').StartInterval).toBe(1800)
    expect(p('znanje').KeepAlive).toBeUndefined()
    for (const b of ['pgvector', 'hindsight']) { expect(p(b).RunAtLoad).toBe(false); expect(p(b).KeepAlive).toBeUndefined() }
    expect(p('pgvector').ProgramArguments).toContain('listen_addresses=127.0.0.1')
    // postgres iz pg0 traži vlastite knjižnice (bez njih: libicuuc.so.70 not found, izmjereno)
    expect(p('pgvector').ProgramArguments.slice(0, 3)).toEqual(['/usr/bin/env',
      `LD_LIBRARY_PATH=${V.PG_BIN}/../lib`, `DYLD_LIBRARY_PATH=${V.PG_BIN}/../lib`])
  })
  test('primijeni: plutil -lint PRIJE upisa, sudo install 644 root:wheel, bootstrap; isto i učitano → ništa', () => {
    const tm = mkdtempSync(join(radna(), 'tm-servis-'))
    try {
      const v = { ...V, TM_HOME: tm }
      const pozivi: string[] = []
      const ex = (argv: string[]) => { pozivi.push(argv.join(' ')); return { kod: argv[0] === 'launchctl' ? 113 : 0, izlaz: '' } }
      const r = primijeni(opis('taskmanager'), 'darwin', v, { ex, vrijeme: 't' })
      expect(r.promijenjeno).toBe(true)
      const i = (s: string) => pozivi.findIndex(p => p.startsWith(s))
      expect(i('plutil -lint')).toBeGreaterThan(-1)
      expect(i('plutil -lint')).toBeLessThan(i('sudo -n install -m 644 -o root -g wheel'))
      expect(i('sudo -n install')).toBeLessThan(i('sudo -n launchctl bootstrap system /Library/LaunchDaemons/hr.regoc.taskmanager.plist'))
      // isti sadržaj na disku + učitana → ISTO, bez ijednog pisanja
      const sadrzaj = datotekeUsluge(opis('taskmanager'), 'darwin', v)[0].sadrzaj
      const pozivi2: string[] = []
      const r2 = primijeni(opis('taskmanager'), 'darwin', v, {
        ex: argv => { pozivi2.push(argv.join(' ')); return { kod: 0, izlaz: argv[1] === '-n' && argv[2] === 'cat' ? sadrzaj.trimEnd() : '' } },
      })
      // datoteka u /Library ne postoji na ovom stroju → procitaj vraća null → razlikuje se; zato ugovor ISTO provjeravamo na Linuxu niže
      expect(r2.poruke.join(' ')).toContain('hr.regoc.taskmanager.plist')
    } finally { rmSync(tm, { recursive: true, force: true }) }
  })
})

describe('systemd (Linux)', () => {
  test('jedinice: Restart po vrsti, After za daemon, timer za znanje, baze bez [Install]', () => {
    const j = (ime: string) => datotekeUsluge(opis(ime), 'linux', V)
    const tm = j('taskmanager')[0].sadrzaj
    expect(tm).toContain('Restart=always')
    expect(tm).toContain('WantedBy=default.target')
    expect(tm).toContain('Environment=TM_HOME=/home/korisnik/.taskmanager')
    expect(tm).toMatch(/^ExecStart=\/home\/korisnik\/TaskManagerAI\/scripts\/s-okolinom\.sh -- \/home\/korisnik\/\.bun\/bin\/bun src\/TaskWebUI\.ts$/m)
    const d = j('daemon')[0].sadrzaj
    expect(d).toContain('After=regoc-taskmanager.service')
    expect(d).toContain('Restart=on-failure')
    const z = j('znanje')
    expect(z.map(x => x.put.split('/').pop())).toEqual(['regoc-znanje.service', 'regoc-znanje.timer'])
    expect(z[1].sadrzaj).toContain('OnUnitActiveSec=1800')
    for (const b of ['pgvector', 'hindsight']) expect(j(b)[0].sadrzaj).not.toContain('[Install]')
  })
  test('primijeni: bez korisničke sesije systemd-a → greška (kod 7 u CLI-ju) i NIŠTA zapisano', () => {
    const home = mkdtempSync(join(radna(), 'tm-sd-'))
    try {
      const v = { ...V, HOME: home, TM_HOME: join(home, '.tm') }
      expect(() => primijeni(opis('taskmanager'), 'linux', v, { ex: a => ({ kod: a[2] === 'show-environment' ? 1 : 1, izlaz: 'Failed to connect to bus' }) }))
        .toThrow(/nema systemd korisničke sesije/)
      expect(Bun.spawnSync(['find', home, '-type', 'f']).stdout.toString()).toBe('')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  test('primijeni: prvi put piše i diže, drugi put (isti sadržaj, enabled) → ISTO bez ijednog poziva koji mijenja', () => {
    const home = mkdtempSync(join(radna(), 'tm-sd-'))
    try {
      const v = { ...V, HOME: home, TM_HOME: join(home, '.tm') }
      const pozivi: string[] = []
      let ukljucen = false
      const ex = (a: string[]) => {
        pozivi.push(a.join(' '))
        if (a[2] === 'enable') ukljucen = true
        return { kod: a[2] === 'is-enabled' ? (ukljucen ? 0 : 1) : 0, izlaz: '' }
      }
      expect(primijeni(opis('taskmanager'), 'linux', v, { ex }).promijenjeno).toBe(true)
      expect(pozivi).toContain('systemctl --user daemon-reload')
      expect(pozivi).toContain('systemctl --user enable regoc-taskmanager.service')
      expect(readFileSync(join(home, '.config/systemd/user/regoc-taskmanager.service'), 'utf-8')).toContain('Restart=always')
      pozivi.length = 0
      const r2 = primijeni(opis('taskmanager'), 'linux', v, { ex })
      expect(r2.promijenjeno).toBe(false)
      expect(pozivi).toEqual(['systemctl --user is-enabled regoc-taskmanager.service'])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('s-okolinom.sh', () => {
  test('instalacija.env, pa postavke.env (prednost), pa --datoteka, pa uz --tajne spremište; nepostojeće se preskače', () => {
    const tm = mkdtempSync(join(radna(), 'tm-env-'))
    try {
      mkdirSync(join(tm, 'config'))
      writeFileSync(join(tm, 'config/instalacija.env'), 'A=instalacija\nB=instalacija\n')
      writeFileSync(join(tm, 'config/postavke.env'), 'B=postavke\n')
      writeFileSync(join(tm, 'x.env'), 'C=datoteka\n')
      writeFileSync(join(tm, 'config/credentials.env'), 'D_TOKEN=tajna\n')
      const r = (argv: string[]) => Bun.spawnSync(['bash', 'scripts/s-okolinom.sh', ...argv, '--', 'bash', '-c', 'echo "$A $B ${C:-} ${D_TOKEN:-nema}"'],
        { cwd: KORIJEN, env: { PATH: process.env.PATH!, HOME: tm, TM_HOME: tm } }).stdout.toString().trim()
      expect(r(['--datoteka', join(tm, 'x.env'), '--datoteka', join(tm, 'nema.env')])).toBe('instalacija postavke datoteka nema')
      expect(r(['--tajne'])).toBe('instalacija postavke  tajna')
    } finally { rmSync(tm, { recursive: true, force: true }) }
  })
  test('bez naredbe iza -- → izlaz 2', () => {
    expect(Bun.spawnSync(['bash', 'scripts/s-okolinom.sh', '--tajne'], { cwd: KORIJEN }).exitCode).toBe(2)
  })
})

describe('manifest instalacije', () => {
  test('dodaje samo apsolutne i nove putove (drugo pokretanje → dodano 0)', () => {
    const m = { verzija: 1 as const, stvoreno: [] }
    expect(spoji(m, ['/a|mapa|K1', 'relativno|x|K', '/b|datoteka|K2', '/a|mapa|K3']).dodano).toBe(2)
    expect(spoji(m, ['/a|mapa|K1', '/b|datoteka|K2']).dodano).toBe(0)
    expect(m.stvoreno.map(s => s.put)).toEqual(['/a', '/b'])
  })
})
