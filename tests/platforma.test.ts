/**
 * TASK-5654 (plan Mac v3, K1): platformni sloj — Linux grana na pravom procfs-u,
 * macOS grana s lažnim `darwin` (podmetnuti izvršitelj vraća izlaz BSD alata).
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import * as P from '../src/core/platforma'

const MAPE: string[] = []
function privremena(pref: string): string { const d = mkdtempSync(join(tmpdir(), pref)); MAPE.push(d); return d }
afterAll(() => { for (const d of MAPE) rmSync(d, { recursive: true, force: true }) })

type Poziv = { argv: string[]; env?: Record<string, string> }
function lazniDarwin(odgovori: Record<string, string | null>, naredbe: string[] = []) {
  const pozivi: Poziv[] = []
  const o: P.Okolina = {
    os: 'darwin',
    izvrsi: (argv, env) => { pozivi.push({ argv, env }); const k = argv.join(' '); return k in odgovori ? odgovori[k] : null },
    imaNaredbu: (ime) => naredbe.includes(ime),
    procRoot: '/nepostoji-procfs',
  }
  return { o, pozivi }
}

describe('platforma — Linux (pravi procfs)', () => {
  const lin: P.Okolina = { os: 'linux' }
  test('ziv: vlastiti PID živ, nepostojeći i nevaljan mrtav', () => {
    expect(P.ziv(process.pid)).toBe(true)
    expect(P.ziv(4194303)).toBe(false)
    expect(P.ziv(0)).toBe(false)
    expect(P.ziv(-5)).toBe(false)
  })
  test('cmdline vlastitog procesa sadrži bun', () => {
    expect(P.cmdline(process.pid, lin)).toMatch(/bun/)
    expect(P.cmdline(4194303, lin)).toBeNull()
  })
  test('cwd vlastitog procesa = process.cwd()', () => {
    expect(P.cwd(process.pid, lin)).toBe(process.cwd())
  })
  test('pidovi sadrži vlastiti PID', () => {
    expect(P.pidovi(lin)).toContain(process.pid)
  })
  test('oznakaStarta je niz otkucaja (isti oblik kao procfs polje 22), stabilan', () => {
    const a = P.oznakaStarta(process.pid, lin)
    expect(a).toMatch(/^\d+$/)
    expect(P.oznakaStarta(process.pid, lin)).toBe(a)
    expect(P.oznakaStarta(4194303, lin)).toBeNull()
  })
  test('startProcesaMs: u prošlosti, nakon boota', () => {
    const s = P.startProcesaMs(process.pid, lin)!
    expect(s).toBeLessThanOrEqual(Date.now() + 1000)
    expect(s).toBeGreaterThan(P.bootMs(lin) - 1000)
  })
  test('lažno procfs stablo: comm s razmakom i zagradom, zombi = null', () => {
    const root = privremena('procfs-')
    mkdirSync(join(root, '42'))
    const rep = (state: string) => `42 (bun (a b)) ${state} 1 ` + Array.from({ length: 17 }, (_, i) => String(i)).join(' ') + ' 777 0 0'
    writeFileSync(join(root, '42', 'stat'), rep('S'))
    writeFileSync(join(root, 'uptime'), '100.00 50.00')
    writeFileSync(join(root, '42', 'cmdline'), 'bun\0RegocDaemon.ts\0')
    symlinkSync('/tmp', join(root, '42', 'cwd'))
    const o: P.Okolina = { os: 'linux', procRoot: root }
    expect(P.oznakaStarta(42, o)).toBe('777')
    expect(P.cmdline(42, o)).toBe('bun RegocDaemon.ts')
    expect(P.cwd(42, o)).toBe('/tmp')
    const ms = P.startProcesaMs(42, { ...o, clockTicks: 100, bootMs: 1_000_000 })
    expect(ms).toBe(1_000_000 + 7770)
    expect(P.cpuVrijeme(42, o)).toBe(9 + 10 + 11 + 12)   // polja 14–17 = vrijednosti 9..12 u nizu
    writeFileSync(join(root, '42', 'stat'), rep('Z'))
    expect(P.oznakaStarta(42, o)).toBeNull()
  })
  test('libc i PTY na Linuxu ostaju kao prije', () => {
    expect(P.libc(lin)).toBe('libc.so.6')
    expect(P.ptyNaredba('claude setup-token', lin)).toEqual(['script', '-qfec', 'claude setup-token', '/dev/null'])
  })
  test('pidNaVratima: ss s filtrom vrata, PID iz users:(…pid=N…)', () => {
    const pozivi: string[][] = []
    const o: P.Okolina = {
      os: 'linux', imaNaredbu: (i) => i === 'ss',
      izvrsi: (argv) => { pozivi.push(argv); return 'LISTEN 0 512 0.0.0.0:17781 0.0.0.0:* users:(("bun",pid=4321,fd=12))\n' },
    }
    expect(P.pidNaVratima(17781, o)).toBe(4321)
    expect(pozivi[0]).toEqual(['ss', '-ltnpH', 'sport = :17781'])
  })
  test('pidNaVratima: Linux bez ss čita procfs net/tcp (stvarni slušač)', async () => {
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
    try {
      const o: P.Okolina = { os: 'linux', imaNaredbu: () => false }
      expect(P.pidNaVratima(srv.port, o)).toBe(process.pid)
    } finally { srv.stop(true) }
    expect(P.pidNaVratima(1, { os: 'linux', imaNaredbu: () => false })).toBeNull()
  })
  test('usluga: systemctl --user show ActiveState (izlaz 0 i za neaktivnu, za razliku od is-active)', () => {
    const odg: Record<string, string> = {
      'systemctl --user show -p ActiveState --value regoc-voice': 'active\n',
      'systemctl --user show -p ActiveState --value regoc-znanje.timer': 'inactive\n',
      'systemctl --user show -p ActiveState --value regoc-pao': 'failed\n',
    }
    const o: P.Okolina = { os: 'linux', izvrsi: (a) => odg[a.join(' ')] ?? null }
    expect(P.usluga('regoc-voice', o)).toBe('active')
    expect(P.usluga('regoc-znanje.timer', o)).toBe('inactive')
    expect(P.usluga('regoc-pao', o)).toBe('inactive')
    expect(P.usluga('drugo', o)).toBe('nepoznato')
    expect(P.capguardPodrzan(lin)).toBe(true)
    expect(P.capguardPoruka(lin)).toBeNull()
  })
})

describe('platforma — okolina procesa (Linux, pravi procfs)', () => {
  test('okolinaProcesa čita varijablu djeteta; nepostojeći PID → null', async () => {
    const p = Bun.spawn(['sleep', '5'], { env: { ...process.env, RKM_PROBA: '/neka/mapa' } })
    try {
      await Bun.sleep(50)
      expect(P.okolinaProcesa(p.pid, 'RKM_PROBA', { os: 'linux' })).toBe('/neka/mapa')
      expect(P.okolinaProcesa(p.pid, 'RKM_NEMA', { os: 'linux' })).toBeNull()
    } finally { p.kill() }
    expect(P.okolinaProcesa(999999999, 'PATH', { os: 'linux' })).toBeNull()
  })
})

describe('platforma — isti ishod na oba OS-a (StaleCodeCheck, plan K1)', () => {
  test('start procesa: darwin grana (ps -o lstart) = Linux grana (procfs) unutar rezolucije', () => {
    // darwin grana s PRAVIM `ps` (procps na Linuxu zna lstart) — isti izvor koji macOS koristi
    const mac = P.startProcesaMs(process.pid, { os: 'darwin' })
    const lin = P.startProcesaMs(process.pid, { os: 'linux' })!
    expect(mac).not.toBeNull()
    expect(Math.abs(mac! - lin)).toBeLessThanOrEqual(1000 + P.rezolucijaStartaMs({ os: 'darwin' }))
    // datoteka pisana 2 s nakon starta je „novija” u obje grane (isti zaključak StaleCodeCheck-a)
    const mtime = lin + 2000 + 5000
    expect(mtime > lin + 5000 + P.rezolucijaStartaMs({ os: 'linux' })).toBe(true)
    expect(mtime > mac! + 5000 + P.rezolucijaStartaMs({ os: 'darwin' })).toBe(true)
  })
})

describe('platforma — lažni darwin (BSD alati)', () => {
  test('nijedna macOS grana ne čita procfs', () => {
    const { o } = lazniDarwin({})
    expect(P.cmdline(42, o)).toBeNull()
    expect(P.pidovi(o)).toEqual([])
    expect(P.cwd(42, o)).toBeNull()
    expect(P.oznakaStarta(42, o)).toBeNull()
    expect(P.startProcesaMs(42, o)).toBeNull()
  })
  test('cmdline kroz ps -o command=', () => {
    const { o, pozivi } = lazniDarwin({ 'ps -o command= -p 42': '/Users/regoc/.bun/bin/bun RegocDaemon.ts\n' })
    expect(P.cmdline(42, o)).toBe('/Users/regoc/.bun/bin/bun RegocDaemon.ts')
    expect(pozivi[0].argv).toEqual(['ps', '-o', 'command=', '-p', '42'])
  })
  test('pidovi kroz ps -A -o pid=', () => {
    const { o } = lazniDarwin({ 'ps -A -o pid=': '    1\n  101\n 4242\n' })
    expect(P.pidovi(o)).toEqual([1, 101, 4242])
  })
  test('cwd kroz lsof -Fn', () => {
    const { o } = lazniDarwin({ 'lsof -a -p 42 -d cwd -Fn': 'p42\nfcwd\nn/Users/korisnik/projekt\n' })
    expect(P.cwd(42, o)).toBe('/Users/korisnik/projekt')
  })
  test('lstart (LC_ALL=C) → oznaka u sekundama epohe i start u ms', () => {
    const lstart = 'Mon Oct 20 19:40:36 2026'
    const { o, pozivi } = lazniDarwin({ 'ps -o lstart= -p 42': lstart + '\n' })
    const ms = Date.parse(lstart)
    expect(P.startProcesaMs(42, o)).toBe(ms)
    expect(P.oznakaStarta(42, o)).toBe(String(ms / 1000))
    expect(pozivi[0].env).toEqual({ LC_ALL: 'C' })
    expect(P.rezolucijaStartaMs(o)).toBe(1000)
    expect(P.rezolucijaStartaMs({ os: 'linux' })).toBe(0)
  })
  test('cpuVrijeme kroz ps -o time= (centisekunde), oblici mm:ss.cc i hh:mm:ss', () => {
    const { o } = lazniDarwin({ 'ps -o time= -p 42': '   1:02.50\n', 'ps -o time= -p 43': '2-01:00:03\n' })
    expect(P.cpuVrijeme(42, o)).toBe(6250)
    expect(P.cpuVrijeme(43, o)).toBe(((2 * 24 + 1) * 3600 + 3) * 100)
    expect(P.cpuVrijeme(44, o)).toBeNull()
  })
  test('bootMs iz sysctl kern.boottime', () => {
    const { o } = lazniDarwin({ 'sysctl -n kern.boottime': '{ sec = 1792000000, usec = 250000 } Mon Oct 20 08:00:00 2026\n' })
    expect(P.bootMs(o)).toBe(1792000000250)
  })
  test('pidNaVratima kroz lsof -sTCP:LISTEN -t (bez ss)', () => {
    const { o, pozivi } = lazniDarwin({ 'lsof -nP -iTCP:17781 -sTCP:LISTEN -t': '5555\n' }, ['ss'])
    expect(P.pidNaVratima(17781, o)).toBe(5555)
    expect(pozivi.every(p => p.argv[0] !== 'ss')).toBe(true)
    expect(P.pidNaVratima(17782, o)).toBeNull()
  })
  test('libc = libSystem (flock(2) postoji na darwinu)', () => {
    expect(P.libc({ os: 'darwin' })).toBe('/usr/lib/libSystem.B.dylib')
  })
  test('PTY: BSD script bez -f/-e/-c, naredba kao popis', () => {
    expect(P.ptyNaredba('claude setup-token', { os: 'darwin' })).toEqual(['script', '-q', '/dev/null', '/bin/sh', '-c', 'claude setup-token'])
  })
  test('usluga kroz launchctl print system/hr.regoc.<ime>', () => {
    const { o, pozivi } = lazniDarwin({ 'launchctl print system/hr.regoc.voice': 'hr.regoc.voice = {\n\tstate = running\n\tpid = 77\n}' })
    expect(P.usluga('regoc-voice', o)).toBe('active')
    expect(pozivi[0].argv).toEqual(['launchctl', 'print', 'system/hr.regoc.voice'])
    expect(P.usluga('regoc-taskmanager.service', o)).toBe('inactive')
    expect(P.launchdOznaka('regoc-znanje.timer')).toBe('hr.regoc.znanje')
  })
  test('timer na darwinu = LaunchDaemon sa StartInterval: učitan (print uspije) znači aktivan', () => {
    const { o } = lazniDarwin({ 'launchctl print system/hr.regoc.znanje': 'hr.regoc.znanje = {\n\tstate = not running\n\trun interval = 1800 seconds\n}' })
    expect(P.usluga('regoc-znanje.timer', o)).toBe('active')
    expect(P.usluga('regoc-znanje.service', o)).toBe('inactive')
    expect(P.usluga('regoc-nema.timer', o)).toBe('inactive')
  })
  test('restartUsluge: Linux systemctl --user restart, darwin sudo -n launchctl kickstart -k', () => {
    const lin: Poziv[] = []
    expect(P.restartUsluge('regoc-daemon', { os: 'linux', izvrsi: (a) => { lin.push({ argv: a }); return '' } })).toBe(true)
    expect(lin[0].argv).toEqual(['systemctl', '--user', 'restart', 'regoc-daemon'])
    const { o, pozivi } = lazniDarwin({ 'sudo -n launchctl kickstart -k system/hr.regoc.daemon': '' })
    expect(P.restartUsluge('regoc-daemon', o)).toBe(true)
    expect(pozivi[0].argv).toEqual(['sudo', '-n', 'launchctl', 'kickstart', '-k', 'system/hr.regoc.daemon'])
    expect(P.restartUsluge('regoc-nema', o)).toBe(false)
  })
  test('uslugeRegoc: Linux list-units, darwin launchctl print system (PID > 0 = active), bez tuđih oznaka', () => {
    const lin: P.Okolina = { os: 'linux', izvrsi: (a) => a.join(' ') === 'systemctl --user list-units regoc-* --type=service --all --no-legend --plain'
      ? 'regoc-daemon.service loaded active running REGOČ daemon\nregoc-voice.service loaded inactive dead Glas\n' : null }
    expect(P.uslugeRegoc(lin)).toEqual([
      { unit: 'regoc-daemon.service', aktivan: 'active', opis: 'REGOČ daemon' },
      { unit: 'regoc-voice.service', aktivan: 'inactive', opis: 'Glas' }])
    const ispis = ['system = {', '\tservices = {', '\t\t     412      -        hr.regoc.daemon', '\t\t       0     78        hr.regoc.znanje',
      '\t\t     101      -        com.apple.tuđe', '\t}', '}'].join('\n')
    const { o } = lazniDarwin({ 'launchctl print system': ispis })
    expect(P.uslugeRegoc(o)).toEqual([
      { unit: 'regoc-daemon', aktivan: 'active', opis: 'hr.regoc.daemon (pid 412)' },
      { unit: 'regoc-znanje', aktivan: 'inactive', opis: 'hr.regoc.znanje (zadnji izlaz 78)' }])
    expect(P.uslugeRegoc(lazniDarwin({}).o)).toEqual([])
  })
  test('launchdPlist: StartInterval (timer), korisnik, okolina, XML s escapeom; plutil-valjan oblik', () => {
    const x = P.launchdPlist({ ime: 'regoc-znanje', argv: ['/Users/r/.bun/bin/bun', '/p/a&b.ts', '--pisi'], cwd: '/p',
      okolina: { PATH: '/Users/r/.bun/bin:/usr/bin' }, intervalSek: 1800, korisnik: 'regoc', nice: 10 })
    expect(x).toStartWith('<?xml version="1.0" encoding="UTF-8"?>')
    expect(x).toContain('<key>Label</key>\n  <string>hr.regoc.znanje</string>')
    expect(x).toContain('<key>StartInterval</key>\n  <integer>1800</integer>')
    expect(x).toContain('<string>/p/a&amp;b.ts</string>')
    expect(x).toContain('<key>UserName</key>\n  <string>regoc</string>')
    expect(x).toContain('<key>Nice</key>\n  <integer>10</integer>')
    expect(x).not.toContain('KeepAlive')
    expect(P.launchdPlist({ ime: 'regoc-daemon', argv: ['bun'], stalno: true })).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(P.launchdPlistPut('regoc-znanje.timer')).toBe('/Library/LaunchDaemons/hr.regoc.znanje.plist')
  })
  test('naredbeUkljuciTimer: Linux daemon-reload + enable --now; darwin install + bootout (smije pasti) + bootstrap', () => {
    expect(P.naredbeUkljuciTimer('regoc-znanje', { os: 'linux' })).toEqual([
      { argv: ['systemctl', '--user', 'daemon-reload'], obavezno: true },
      { argv: ['systemctl', '--user', 'enable', '--now', 'regoc-znanje.timer'], obavezno: true }])
    expect(P.naredbeUkljuciTimer('regoc-znanje', { os: 'darwin' }, '/h/.config/regoc/launchd/hr.regoc.znanje.plist')).toEqual([
      { argv: ['sudo', '-n', 'install', '-m', '644', '/h/.config/regoc/launchd/hr.regoc.znanje.plist', '/Library/LaunchDaemons/hr.regoc.znanje.plist'], obavezno: true },
      { argv: ['sudo', '-n', 'launchctl', 'bootout', 'system/hr.regoc.znanje'], obavezno: false },
      { argv: ['sudo', '-n', 'launchctl', 'bootstrap', 'system', '/Library/LaunchDaemons/hr.regoc.znanje.plist'], obavezno: true }])
  })
  test('start/stop/postoji usluge: Linux systemctl --user, darwin launchctl bootstrap/bootout (sudo -n)', () => {
    const lin: string[] = []
    const lo: P.Okolina = { os: 'linux', izvrsi: (a) => { lin.push(a.join(' ')); return a.includes('LoadState') ? (a.at(-1) === 'regoc-daemon' ? 'loaded\n' : 'not-found\n') : '' } }
    expect(P.startUsluge('regoc-daemon', lo)).toBe(true)
    expect(P.stopUsluge('regoc-daemon', lo)).toBe(true)
    expect(P.uslugaPostoji('regoc-daemon', lo)).toBe(true)
    expect(P.uslugaPostoji('regoc-nema', lo)).toBe(false)
    expect(lin.slice(0, 2)).toEqual(['systemctl --user start regoc-daemon', 'systemctl --user stop regoc-daemon'])
    const { o, pozivi } = lazniDarwin({
      'sudo -n launchctl bootstrap system /Library/LaunchDaemons/hr.regoc.daemon.plist': '',
      'sudo -n launchctl bootout system/hr.regoc.daemon': '',
      'launchctl print system/hr.regoc.daemon': 'hr.regoc.daemon = {\n\tstate = running\n}' })
    expect(P.startUsluge('regoc-daemon', o)).toBe(true)
    expect(P.stopUsluge('regoc-daemon', o)).toBe(true)
    expect(P.uslugaPostoji('regoc-daemon', o)).toBe(true)
    expect(P.uslugaPostoji('regoc-nema', { ...o, postojiDatoteka: () => false })).toBe(false)
    expect(P.uslugaPostoji('regoc-nema', { ...o, postojiDatoteka: (p) => p === '/Library/LaunchDaemons/hr.regoc.nema.plist' })).toBe(true)
    expect(pozivi.every(p => p.argv[0] !== 'systemctl')).toBe(true)
  })
  test('start na darwinu: već učitana (bootstrap padne) → kickstart', () => {
    const { o, pozivi } = lazniDarwin({ 'sudo -n launchctl kickstart system/hr.regoc.daemon': '' })
    expect(P.startUsluge('regoc-daemon', o)).toBe(true)
    expect(pozivi.map(p => p.argv.slice(3, 4)[0])).toEqual(['bootstrap', 'kickstart'])
  })
  test('uputaRestarta ovisi o OS-u', () => {
    expect(P.uputaRestarta(['regoc-taskmanager', 'regoc-voice'], { os: 'linux' })).toBe('systemctl --user daemon-reload, pa restart regoc-taskmanager, regoc-voice')
    expect(P.uputaRestarta(['regoc-taskmanager'], { os: 'darwin' })).toBe('sudo -n launchctl kickstart -k system/hr.regoc.taskmanager')
  })
  test('okolinaProcesa: darwin kroz ps -E (zadnja pojava imena), bez procfs-a', () => {
    const { o, pozivi } = lazniDarwin({ 'ps -E -ww -o command= -p 42': 'bun RegocDaemon.ts TMPDIR=/lazni HOME=/Users/r TMPDIR=/Users/r/app/tmp/daemon PATH=/usr/bin\n' })
    expect(P.okolinaProcesa(42, 'TMPDIR', o)).toBe('/Users/r/app/tmp/daemon')
    expect(P.okolinaProcesa(42, 'NEMA', o)).toBeNull()
    expect(P.okolinaProcesa(43, 'TMPDIR', o)).toBeNull()
    expect(pozivi[0].argv).toEqual(['ps', '-E', '-ww', '-o', 'command=', '-p', '42'])
  })
  test('capguard nije podržan na darwinu, s porukom', () => {
    expect(P.capguardPodrzan({ os: 'darwin' })).toBe(false)
    expect(P.capguardPoruka({ os: 'darwin' })).toMatch(/nije podržano.*darwin/)
  })
})

describe('platforma — rok i odvajanje (stvarno izvođenje)', () => {
  test('rokNaredba: timeout ako postoji, inače gtimeout, inače perl', () => {
    expect(P.rokNaredba(5, ['sleep', '9'], { imaNaredbu: (i) => i === 'timeout' })[0]).toBe('timeout')
    expect(P.rokNaredba(5, ['sleep', '9'], { imaNaredbu: (i) => i === 'gtimeout' })[0]).toBe('gtimeout')
    expect(P.rokNaredba(5, ['sleep', '9'], { imaNaredbu: () => false })[0]).toBe('perl')
  })
  test('perl rezerva (macOS bez coreutils): istek → 124, uspjeh → izlaz naredbe', () => {
    const bez = { imaNaredbu: () => false }
    const t0 = Date.now()
    const r = Bun.spawnSync(P.rokNaredba(1, ['sleep', '5'], bez))
    expect(r.exitCode).toBe(124)
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(Bun.spawnSync(P.rokNaredba(5, ['sh', '-c', 'exit 3'], bez)).exitCode).toBe(3)
    expect(Bun.spawnSync(P.rokNaredba(5, ['true'], bez)).exitCode).toBe(0)
  })
  test('odvojeno: proces u novoj sesiji preživi i radi bez naredbe setsid', async () => {
    const dir = privremena('odv-')
    const oznaka = join(dir, 'gotovo')
    const pid = P.odvojeno(['sh', '-c', `echo $$ > "${oznaka}"; sleep 0.3`])!
    expect(pid).toBeGreaterThan(0)
    for (let i = 0; i < 40 && !existsSync(oznaka); i++) await Bun.sleep(50)
    expect(readFileSync(oznaka, 'utf-8').trim()).toBe(String(pid))
    // nova sesija: SID procesa = njegov PID (setsid(2))
    const sid = Bun.spawnSync(['ps', '-o', 'sid=', '-p', String(pid)]).stdout.toString().trim()
    if (sid) expect(sid).toBe(String(pid))
  })
})

describe('macOS omotači scripts/macos/bin (perl, postavlja ih install.sh kad naredba ne postoji)', () => {
  const BIN = join(import.meta.dir, '..', 'scripts', 'macos', 'bin')
  test('timeout: istek → 124, inače izlaz naredbe, decimalne sekunde', () => {
    const t0 = Date.now()
    expect(Bun.spawnSync([join(BIN, 'timeout'), '1', 'sleep', '5']).exitCode).toBe(124)
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(Bun.spawnSync([join(BIN, 'timeout'), '3', 'sh', '-c', 'exit 5']).exitCode).toBe(5)
    expect(Bun.spawnSync([join(BIN, 'timeout'), '0.3s', 'sleep', '2']).exitCode).toBe(124)
    expect(Bun.spawnSync([join(BIN, 'timeout'), 'x', 'true']).exitCode).not.toBe(0)
  })
  test('setsid: naredba se izvodi u novoj sesiji (SID = vlastiti PID)', async () => {
    const dir = privremena('setsid-')
    const f = join(dir, 'sid')
    expect(Bun.spawnSync([join(BIN, 'setsid'), 'sh', '-c', `ps -o sid=,pid= -p $$ > "${f}"`]).exitCode).toBe(0)
    for (let i = 0; i < 40 && !(existsSync(f) && readFileSync(f, 'utf-8').trim()); i++) await Bun.sleep(50)
    const [sid, pid] = readFileSync(f, 'utf-8').trim().split(/\s+/)
    expect(sid).toBe(pid)
    expect(sid).not.toBe(Bun.spawnSync(['ps', '-o', 'sid=', '-p', String(process.pid)]).stdout.toString().trim())
  })
})

describe('platforma — opis usluge i roditelj procesa (TASK-5657, bootcheck M1/M4)', () => {
  test('Linux: opisUsluge čita ActiveState, MainPID i WorkingDirectory iz systemctl show', () => {
    const o: P.Okolina = { os: 'linux', izvrsi: (argv) => argv.join(' ') ===
      'systemctl --user show -p ActiveState -p MainPID -p WorkingDirectory regoc-taskmanager'
      ? 'ActiveState=active\nMainPID=4242\nWorkingDirectory=/home/x/TaskManagerAI\n' : null }
    expect(P.opisUsluge('regoc-taskmanager', o)).toEqual({ stanje: 'active', pid: 4242, cwd: '/home/x/TaskManagerAI' })
  })
  test('Linux: neaktivna jedinica → MainPID=0 postaje null', () => {
    const o: P.Okolina = { os: 'linux', izvrsi: () => 'ActiveState=inactive\nMainPID=0\nWorkingDirectory=\n' }
    expect(P.opisUsluge('regoc-taskmanager', o)).toEqual({ stanje: 'inactive', pid: null, cwd: null })
  })
  test('Linux: systemctl ne odgovara → nepoznato', () => {
    expect(P.opisUsluge('regoc-taskmanager', { os: 'linux', izvrsi: () => null })).toEqual({ stanje: 'nepoznato', pid: null, cwd: null })
  })
  test('macOS: launchctl print → state/pid/working directory (ugniježđeni „state = active" se ne broji)', () => {
    const { o } = lazniDarwin({ 'launchctl print system/hr.regoc.taskmanager':
      'system/hr.regoc.taskmanager = {\n\tactive count = 1\n\tpath = /Library/LaunchDaemons/hr.regoc.taskmanager.plist\n'
      + '\tstate = running\n\tprogram = /Users/x/TaskManagerAI/scripts/s-okolinom.sh\n\tworking directory = /Users/x/TaskManagerAI\n'
      + '\tpid = 311\n\tendpoints = {\n\t\t"x" = {\n\t\t\tstate = active\n\t\t}\n\t}\n}\n' })
    expect(P.opisUsluge('regoc-taskmanager', o)).toEqual({ stanje: 'active', pid: 311, cwd: '/Users/x/TaskManagerAI' })
  })
  test('macOS: bez „working directory" u ispisu čita WorkingDirectory iz plista; nije učitana → inactive', () => {
    const { o } = lazniDarwin({
      'launchctl print system/hr.regoc.taskmanager': '\tstate = running\n\tpid = 9\n',
      'plutil -extract WorkingDirectory raw -o - /Library/LaunchDaemons/hr.regoc.taskmanager.plist': '/Users/x/TaskManagerAI\n' })
    expect(P.opisUsluge('regoc-taskmanager', o)).toEqual({ stanje: 'active', pid: 9, cwd: '/Users/x/TaskManagerAI' })
    const { o: o2 } = lazniDarwin({})
    expect(P.opisUsluge('regoc-taskmanager', o2)).toEqual({ stanje: 'inactive', pid: null, cwd: null })
  })
  test('macOS: učitana, ali ne radi (state = not running) → inactive, pid null', () => {
    const { o } = lazniDarwin({ 'launchctl print system/hr.regoc.taskmanager': '\tstate = not running\n\tlast exit code = 1\n' })
    expect(P.opisUsluge('regoc-taskmanager', o).stanje).toBe('inactive')
    expect(P.opisUsluge('regoc-taskmanager', o).pid).toBeNull()
  })
  test('ppid: Linux iz procfs-a (vlastiti proces = process.ppid), macOS iz ps -o ppid=', () => {
    expect(P.ppid(process.pid, { os: 'linux' })).toBe(process.ppid)
    expect(P.ppid(4194303, { os: 'linux' })).toBeNull()
    const { o } = lazniDarwin({ 'ps -o ppid= -p 311': '    1\n' })
    expect(P.ppid(311, o)).toBe(1)
    expect(P.ppid(312, o)).toBeNull()
  })
  test('procesi: Linux sadrži vlastiti proces s pravim roditeljem; macOS parsira ps -A jednim pozivom', () => {
    const ja = P.procesi({ os: 'linux' }).find(p => p.pid === process.pid)
    expect(ja?.ppid).toBe(process.ppid)
    expect(ja?.cmd).toMatch(/bun/)
    const { o, pozivi } = lazniDarwin({ 'ps -A -o pid=,ppid=,command=': '    1     0 /sbin/launchd\n  311     1 /Users/x/.bun/bin/bun src/TaskWebUI.ts\n' })
    expect(P.procesi(o)).toEqual([{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 311, ppid: 1, cmd: '/Users/x/.bun/bin/bun src/TaskWebUI.ts' }])
    expect(pozivi.length).toBe(1)
  })
})
