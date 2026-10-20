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
  test('usluga: systemctl --user is-active', () => {
    const o: P.Okolina = { os: 'linux', izvrsi: (a) => a.join(' ') === 'systemctl --user is-active regoc-voice' ? 'active\n' : null }
    expect(P.usluga('regoc-voice', o)).toBe('active')
    expect(P.usluga('drugo', o)).toBe('nepoznato')
    expect(P.capguardPodrzan(lin)).toBe(true)
    expect(P.capguardPoruka(lin)).toBeNull()
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
