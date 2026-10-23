/**
 * platforma.ts — jedino mjesto koje zna razliku Linux ↔ macOS (TASK-5654, plan Mac v3 K1, P10).
 *
 * Paket i komplet (njegov `lib/platforma.ts` je poveznica na ovu datoteku) ne
 * čitaju procfs i ne zovu `ss`, `setsid`, `script -qfec` ni `libc.so.6` izravno, nego
 * kroz ove funkcije. Na Linuxu je ponašanje bajt-za-bajt isto kao prije (isti izvori,
 * isti oblik oznake starta procesa), a na macOS-u se koriste ugrađeni alati:
 *
 *   ziv(pid)            process.kill(pid, 0)                      (oba OS-a)
 *   cmdline(pid)        procfs cmdline        | ps -o command= -p
 *   oznakaStarta(pid)   procfs stat polje 22  | LC_ALL=C TZ=UTC0 ps -o lstart= -p  (epoha, s)
 *   startProcesaMs(pid) polje 22 + uptime     | lstart (sekundna rezolucija)
 *   bootMs()            procfs uptime         | sysctl -n kern.boottime
 *   cpuVrijeme(pid)     stat utime+stime+cutime+cstime | ps -o time= (centisekunde)
 *   cwd(pid)            readlink cwd          | lsof -a -p <pid> -d cwd -Fn
 *   ppid(pid)           procfs stat polje 4   | ps -o ppid= -p
 *   procesi()           procfs (pid, ppid, cmdline) | ps -A -o pid=,ppid=,command=  (jednim pozivom)
 *   pidovi()            readdir procfs        | ps -A -o pid=
 *   pidNaVratima(v)     ss -ltnp (lsof rezerva) | lsof -nP -iTCP:<v> -sTCP:LISTEN -t
 *   libc()              libc.so.6             | /usr/lib/libSystem.B.dylib
 *   ptyNaredba(cmd)     script -qfec cmd /dev/null | cat | script -q /dev/null /bin/sh -c cmd (stdin-cijev)
 *   odvojeno(argv)      spawn detached (setsid(2) na oba OS-a), bez naredbe `setsid`
 *   rokNaredba(s, argv) timeout | gtimeout | perl alarm (izlaz 124 kao GNU)
 *   usluga(ime)         systemctl --user show ActiveState | launchctl print system/hr.regoc.<ime>
 *   restartUsluge(ime)  systemctl --user restart | sudo -n launchctl kickstart -k system/hr.regoc.<ime>
 *   start/stopUsluge    systemctl --user start/stop | sudo -n launchctl bootstrap (kickstart)/bootout
 *   opisUsluge(ime)     show ActiveState/MainPID/WorkingDirectory | launchctl print state/pid/working directory
 *   uslugaPostoji(ime)  LoadState=loaded | launchctl print ili plist u /Library/LaunchDaemons
 *   uslugeRegoc()       systemctl --user list-units regoc-* | launchctl print system (hr.regoc.*)
 *   launchdPlist(…)     — | LaunchDaemon plist (timer = StartInterval, stalna = KeepAlive)
 *   naredbeUkljuciTimer daemon-reload + enable --now | install u /Library/LaunchDaemons + bootstrap
 *   okolinaProcesa(p,v) procfs environ | ps -E -ww -o command=
 *   capguardPodrzan()   samo Linux (nftables); macOS: „nije podržano"
 *
 * Svaka funkcija prima opcionalnu `Okolina` (OS, izvršitelj naredbi, korijen procfs-a),
 * pa se macOS grana testira na Linuxu s lažnim `darwin` (tests/platforma.test.ts).
 *
 * CLI (za ljuske, npr. scripts/start.sh):
 *   bun src/core/platforma.ts pid-na-vratima <vrata>
 *   bun src/core/platforma.ts ziv|cmdline|cwd|start-ms|oznaka-starta <pid>
 *   bun src/core/platforma.ts os|libc|usluga|restart-usluge|start-usluge|stop-usluge|usluga-postoji <ime>
 *   bun src/core/platforma.ts okolina <pid> <varijabla>
 */
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'fs'
import { join } from 'path'
import { spawn as nodeSpawn } from 'child_process'

export type Izvrsitelj = (argv: string[], env?: Record<string, string>) => string | null

export interface Okolina {
  /** `process.platform`; testovi podmeću 'darwin'. */
  os?: string
  /** Pokreće naredbu, vraća stdout ili null (nema naredbe / izlaz ≠ 0). */
  izvrsi?: Izvrsitelj
  /** Korijen procfs-a na Linuxu (testovi podmeću lažno stablo). */
  procRoot?: string
  /** Postoji li naredba u PATH-u (za rokNaredba/pidNaVratima). */
  imaNaredbu?: (ime: string) => boolean
  /** Postoji li datoteka (testovi podmeću plist u /Library/LaunchDaemons). */
  postojiDatoteka?: (put: string) => boolean
}

const PROC = '/proc'

export function izvrsiZadano(argv: string[], env?: Record<string, string>): string | null {
  try {
    const r = Bun.spawnSync(argv, {
      stdout: 'pipe', stderr: 'ignore',
      env: env ? { ...process.env, ...env } : process.env,
    })
    if (r.exitCode !== 0) return null
    return r.stdout.toString()
  } catch { return null }
}

function imaNaredbuZadano(ime: string): boolean {
  try { return Bun.which(ime) !== null } catch { return false }
}

function os(o?: Okolina): string { return o?.os ?? process.platform }
function izvrsi(o?: Okolina): Izvrsitelj { return o?.izvrsi ?? izvrsiZadano }
function procRoot(o?: Okolina): string { return o?.procRoot ?? PROC }
function imaNaredbu(o: Okolina | undefined, ime: string): boolean { return (o?.imaNaredbu ?? imaNaredbuZadano)(ime) }

export function jeLinux(o?: Okolina): boolean { return os(o) === 'linux' }
export function jeMac(o?: Okolina): boolean { return os(o) === 'darwin' }

function ispravanPid(pid: number): boolean { return Number.isInteger(pid) && pid > 0 }

// ─── živost i identitet procesa ──────────────────────────────────────────────

/** Živ proces? `kill(pid, 0)` radi na oba OS-a; EPERM = živ, ali tuđi. */
export function ziv(pid: number): boolean {
  if (!ispravanPid(pid)) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** Naredbeni redak procesa (argumenti spojeni razmakom) ili null ako proces ne postoji. */
export function cmdline(pid: number, o?: Okolina): string | null {
  if (!ispravanPid(pid)) return null
  if (jeLinux(o)) {
    try { return readFileSync(join(procRoot(o), String(pid), 'cmdline'), 'utf-8').replace(/\0/g, ' ').trim() } catch { return null }
  }
  const out = izvrsi(o)(['ps', '-o', 'command=', '-p', String(pid)])
  const t = out?.trim()
  return t ? t : null
}

/** Svi PID-ovi na stroju. */
export function pidovi(o?: Okolina): number[] {
  if (jeLinux(o)) {
    try { return readdirSync(procRoot(o)).filter(n => /^\d+$/.test(n)).map(Number) } catch { return [] }
  }
  const out = izvrsi(o)(['ps', '-A', '-o', 'pid='])
  if (!out) return []
  return out.split('\n').map(s => Number(s.trim())).filter(ispravanPid)
}

/** Radna mapa procesa ili null. */
export function cwd(pid: number, o?: Okolina): string | null {
  if (!ispravanPid(pid)) return null
  if (jeLinux(o)) {
    try { return readlinkSync(join(procRoot(o), String(pid), 'cwd')) } catch { return null }
  }
  const out = izvrsi(o)(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  const red = out?.split('\n').find(l => l.startsWith('n'))
  return red ? red.slice(1) : null
}

/**
 * Stvarna putanja otvorenog opisnika OVOG procesa ili null (Linux: procfs `self/fd/N`; macOS: nema
 * puta bez nativnog fcntl(F_GETPATH) → null, pozivatelj tada drži provjeru realpath + dev/ino).
 */
export function putanjaOpisnika(fd: number, o?: Okolina): string | null {
  if (!Number.isInteger(fd) || fd < 0 || !jeLinux(o)) return null
  try { return readlinkSync(join(procRoot(o), 'self', 'fd', String(fd))) } catch { return null }
}

/** Roditelj procesa ili null (Linux: polje 4 procfs stat-a; macOS: `ps -o ppid=`). */
export function ppid(pid: number, o?: Okolina): number | null {
  if (!ispravanPid(pid)) return null
  let t: string | undefined
  if (jeLinux(o)) t = statRep(pid, o)?.[1]
  else t = izvrsi(o)(['ps', '-o', 'ppid=', '-p', String(pid)])?.trim()
  const n = Number(t)
  return t && Number.isInteger(n) && n >= 0 ? n : null
}

export interface Proces { pid: number; ppid: number; cmd: string }

/** Tablica procesa (bootcheck M4): na macOS-u jednim pozivom `ps`, ne po jedan po PID-u. */
export function procesi(o?: Okolina): Proces[] {
  if (jeLinux(o)) {
    const r: Proces[] = []
    for (const pid of pidovi(o)) {
      const roditelj = Number(statRep(pid, o)?.[1])
      const cmd = cmdline(pid, o)
      if (cmd !== null && Number.isInteger(roditelj)) r.push({ pid, ppid: roditelj, cmd })
    }
    return r
  }
  const out = izvrsi(o)(['ps', '-A', '-o', 'pid=,ppid=,command=']) ?? ''
  return out.split('\n').map(red => red.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: Number(m![1]), ppid: Number(m![2]), cmd: m![3].trim() }))
}

// ─── vrijeme starta procesa ──────────────────────────────────────────────────

/** Polja iza „pid (comm)” iz procfs stat; comm smije sadržavati razmake i zagrade. */
function statRep(pid: number, o?: Okolina): string[] | null {
  try {
    const s = readFileSync(join(procRoot(o), String(pid), 'stat'), 'utf-8')
    const z = s.lastIndexOf(')')
    if (z < 0) return null
    return s.slice(z + 1).trim().split(/\s+/)
  } catch { return null }
}

/**
 * `ps -o lstart=` → epoha u ms (macOS; sekundna rezolucija). `ps` ispisuje lokalno vrijeme
 * bez zone, a JS ga čita u SVOJOJ zoni (`bun test` uvijek u UTC) — na stroju koji nije u UTC
 * to je pomak od nekoliko sati (QA K6 B6). Zato `ps` radi s TZ=UTC0 i ispis se čita kao UTC.
 */
function lstartMs(pid: number, o?: Okolina): number | null {
  const out = izvrsi(o)(['ps', '-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C', TZ: 'UTC0' })
  const t = out?.trim()
  if (!t) return null
  const ms = Date.parse(`${t} GMT`)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Nepromjenjiva oznaka starta procesa (zaštita od ponovne uporabe PID-a) ili null.
 * Linux: polje 22 procfs stat-a kao niz otkucaja — ISTI oblik kao prije platforme, pa
 * zapisi starih verzija i dalje vrijede. Zombi (Z/X) je završen proces → null.
 * macOS: sekunde epohe iz `ps -o lstart=`.
 */
export function oznakaStarta(pid: number, o?: Okolina): string | null {
  if (!ispravanPid(pid)) return null
  if (jeLinux(o)) {
    const rep = statRep(pid, o)
    if (!rep) return null
    const st = rep[19]              // rep[0] = polje 3 (state) → polje 22 = rep[19]
    if (!st || !/^\d+$/.test(st)) return null
    if (rep[0] === 'Z' || rep[0] === 'X') return null
    return st
  }
  const ms = lstartMs(pid, o)
  return ms === null ? null : String(Math.round(ms / 1000))
}

let otkucajiCache: number | undefined
/** Otkucaji u sekundi (USER_HZ) na Linuxu; 100 ako getconf ne odgovori. */
export function otkucajiUSekundi(o?: Okolina): number {
  if (o?.izvrsi === undefined && otkucajiCache !== undefined) return otkucajiCache
  const n = Number(izvrsi(o)(['getconf', 'CLK_TCK'])?.trim())
  const hz = Number.isFinite(n) && n > 0 ? n : 100
  if (o?.izvrsi === undefined) otkucajiCache = hz
  return hz
}

/** Epoha (ms) podizanja sustava. */
export function bootMs(o?: Okolina): number {
  if (jeLinux(o)) {
    const up = parseFloat(readFileSync(join(procRoot(o), 'uptime'), 'utf-8').split(/\s+/)[0])
    return Date.now() - up * 1000
  }
  // „{ sec = 1790000000, usec = 123456 } Mon Oct 20 …”
  const out = izvrsi(o)(['sysctl', '-n', 'kern.boottime']) ?? ''
  const m = out.match(/sec\s*=\s*(\d+)(?:,\s*usec\s*=\s*(\d+))?/)
  if (!m) throw new Error('kern.boottime nije čitljiv')
  return Number(m[1]) * 1000 + Math.round(Number(m[2] ?? 0) / 1000)
}

/**
 * Kumulativno CPU vrijeme procesa kao mjera „radi li” (raste li između dva čitanja).
 * Linux: utime+stime+cutime+cstime iz procfs stat-a (otkucaji); macOS: `ps -o time=`
 * (user+sys, u centisekundama). Jedinice se ne miješaju — uspoređuje se isti proces na
 * istom stroju. null = proces ne postoji.
 */
export function cpuVrijeme(pid: number, o?: Okolina): number | null {
  if (!ispravanPid(pid)) return null
  if (jeLinux(o)) {
    const f = statRep(pid, o)
    if (!f) return null
    // f[0] = polje 3 (state) → utime = polje 14 = f[11], stime f[12], cutime f[13], cstime f[14]
    return [11, 12, 13, 14].reduce((z, i) => z + (parseInt(f[i] || '0', 10) || 0), 0)
  }
  const t = izvrsi(o)(['ps', '-o', 'time=', '-p', String(pid)])?.trim()
  if (!t) return null
  // [[dd-]hh:]mm:ss[.cc]
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?$/)
  if (!m) return null
  const [, d, h, mi, se, cs] = m
  const sek = (Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(mi) * 60 + Number(se)
  return sek * 100 + Number((cs ?? '0').padEnd(2, '0').slice(0, 2))
}

export interface StartOpcije { clockTicks?: number; bootMs?: number }

/** Epoha (ms) starta procesa ili null ako proces ne postoji. */
export function startProcesaMs(pid: number, o?: Okolina & StartOpcije): number | null {
  if (!ispravanPid(pid)) return null
  if (jeLinux(o)) {
    if (!existsSync(join(procRoot(o), String(pid), 'stat'))) return null
    const rep = statRep(pid, o)
    if (!rep) return null
    const ticks = Number(rep[19])
    if (!Number.isFinite(ticks)) return null
    const hz = o?.clockTicks ?? otkucajiUSekundi(o)
    const boot = o?.bootMs ?? bootMs(o)
    return boot + (ticks / hz) * 1000
  }
  return lstartMs(pid, o)
}

/**
 * Koliko ms datoteka smije biti „novija” od starta procesa zbog rezolucije izvora:
 * Linux (otkucaji) ~0, macOS `lstart` ima sekunde → 1000 ms.
 */
export function rezolucijaStartaMs(o?: Okolina): number { return jeLinux(o) ? 0 : 1000 }

// ─── vrata ───────────────────────────────────────────────────────────────────

/** PID procesa koji sluša na TCP vratima ili null. */
export function pidNaVratima(vrata: number, o?: Okolina): number | null {
  if (!Number.isInteger(vrata) || vrata <= 0) return null
  const ex = izvrsi(o)
  if (jeLinux(o) && imaNaredbu(o, 'ss')) {
    const out = ex(['ss', '-ltnpH', `sport = :${vrata}`])
    const m = out?.match(/pid=(\d+)/)
    return m ? Number(m[1]) : null
  }
  if (jeLinux(o)) return pidNaVratimaProcfs(vrata, o)
  const out = ex(['lsof', '-nP', `-iTCP:${vrata}`, '-sTCP:LISTEN', '-t'])
  const n = Number(out?.split('\n')[0]?.trim())
  return ispravanPid(n) ? n : null
}

/**
 * Linux bez `ss` (iproute2 nije uvijek instaliran — glavni stroj ga nema): utičnica u
 * stanju LISTEN (0A) na vratima iz procfs net/tcp{,6}, pa proces koji drži njezin inode.
 * Vidi samo procese istog korisnika (kao `ss -p` bez roota).
 */
function pidNaVratimaProcfs(vrata: number, o?: Okolina): number | null {
  const root = procRoot(o)
  const hex = ':' + vrata.toString(16).toUpperCase().padStart(4, '0')
  const inodi = new Set<string>()
  for (const f of ['tcp', 'tcp6']) {
    let t = ''
    try { t = readFileSync(join(root, 'net', f), 'utf-8') } catch { continue }
    for (const red of t.split('\n').slice(1)) {
      const p = red.trim().split(/\s+/)
      if (p.length > 9 && p[1].endsWith(hex) && p[3] === '0A' && p[9] !== '0') inodi.add(p[9])
    }
  }
  if (!inodi.size) return null
  for (const pid of pidovi(o)) {
    let fdovi: string[] = []
    try { fdovi = readdirSync(join(root, String(pid), 'fd')) } catch { continue }
    for (const fd of fdovi) {
      try {
        const m = readlinkSync(join(root, String(pid), 'fd', fd)).match(/^socket:\[(\d+)\]$/)
        if (m && inodi.has(m[1])) return pid
      } catch { /* fd je nestao */ }
    }
  }
  return null
}

// ─── libc, PTY, odvajanje, rok ───────────────────────────────────────────────

/** Ime/putanja C knjižnice za `bun:ffi` dlopen (flock(2) i sl.). */
export function libc(o?: Okolina): string {
  return jeMac(o) ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
}

/** argv koji pokreće `cmd` (niz za ljusku) unutar PTY-ja, bez node-pty. */
export function ptyNaredba(cmd: string, o?: Okolina): string[] {
  if (jeLinux(o)) return ['script', '-qfec', cmd, '/dev/null']
  // BSD script: script [-q] [datoteka [naredba …]] — nema -f/-e/-c. Bun na macOS-u daje stdin
  // kao socket, a BSD script tada pada („tcgetattr/ioctl: Operation not supported on socket") prije
  // naredbe — `cat |` mu daje pravu cijev (TASK-5738). Nakon kraja naredbe `cat` se gasi, inače
  // ljuska čeka cijeli cjevovod dok se stdin ne zatvori. Naredba ide kao $0, bez novog navođenja.
  // Mjereno na macOS-u 23.10.2026.: unos stiže, izlaz 0, bez zaostalog `cat`.
  return ['/bin/sh', '-c', 'cat | { script -q /dev/null /bin/sh -c "$0"; r=$?; pkill -P $$ -x cat; exit $r; }', cmd]
}

export interface OdvojenoOpcije {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Datoteka (fd) za stdout/stderr; zadano: zanemari. */
  izlazFd?: number
}

/**
 * Pokreni proces odvojen od roditelja (nova sesija, setsid(2)) i ne čekaj ga.
 * Zamjena za `setsid <naredba>` — naredba `setsid` ne postoji na macOS-u, a
 * `detached: true` poziva setsid(2) na oba OS-a. Vraća PID ili null.
 */
export function odvojeno(argv: string[], opc: OdvojenoOpcije = {}): number | null {
  const izlaz = opc.izlazFd ?? 'ignore'
  const p = nodeSpawn(argv[0], argv.slice(1), {
    cwd: opc.cwd, env: (opc.env ?? process.env) as NodeJS.ProcessEnv,
    detached: true, stdio: ['ignore', izlaz, izlaz],
  })
  p.unref()
  return p.pid ?? null
}

/**
 * argv koji pokreće `argv` uz rok u sekundama (GNU `timeout` semantika: izlaz 124).
 * macOS nema `timeout`: `gtimeout` (coreutils) ako postoji, inače perl `alarm`.
 */
export function rokNaredba(sek: number, argv: string[], o?: Okolina): string[] {
  if (imaNaredbu(o, 'timeout')) return ['timeout', String(sek), ...argv]
  if (imaNaredbu(o, 'gtimeout')) return ['gtimeout', String(sek), ...argv]
  const perl = 'my $s=shift; my $p=fork; if(!$p){exec @ARGV or exit 127} '
    + '$SIG{ALRM}=sub{kill "TERM",$p; waitpid $p,0; exit 124}; alarm $s; waitpid $p,0; exit($?>>8)'
  return ['perl', '-e', perl, String(sek), ...argv]
}

// ─── usluge i sigurnost ──────────────────────────────────────────────────────

/** launchd oznaka za ime usluge (`regoc-voice` → `hr.regoc.voice`). */
export function launchdOznaka(ime: string): string {
  return 'hr.regoc.' + ime.replace(/\.(service|timer)$/, '').replace(/^regoc-/, '')
}

export type StanjeUsluge = 'active' | 'inactive' | 'nepoznato'

/** Je li ime periodička usluga (systemd timer; na macOS-u LaunchDaemon sa StartInterval). */
function jeTimer(ime: string): boolean { return ime.endsWith('.timer') }

/**
 * Stanje usluge: systemd korisnička jedinica na Linuxu, LaunchDaemon na macOS-u.
 * Linux: `show -p ActiveState` izlazi s 0 i za neaktivnu jedinicu (`is-active` izlazi s 3,
 * pa bi izvršitelj vratio null i neaktivna bi postala „nepoznato").
 * macOS: timer između dva pokretanja nije „running" — za njega je aktivno = učitan.
 */
export function usluga(ime: string, o?: Okolina): StanjeUsluge {
  const ex = izvrsi(o)
  if (jeLinux(o)) {
    const t = ex(['systemctl', '--user', 'show', '-p', 'ActiveState', '--value', ime])?.trim()
    if (t === 'active') return 'active'
    return t ? 'inactive' : 'nepoznato'
  }
  const out = ex(['launchctl', 'print', `system/${launchdOznaka(ime)}`])
  if (out === null) return 'inactive'
  if (jeTimer(ime)) return 'active'
  return /^\s*state\s*=\s*running/m.test(out) ? 'active' : 'inactive'
}

function argvRestarta(ime: string, o?: Okolina): string[] {
  return jeLinux(o)
    ? ['systemctl', '--user', 'restart', ime]
    : ['sudo', '-n', 'launchctl', 'kickstart', '-k', `system/${launchdOznaka(ime)}`]
}

/** Restart usluge: `systemctl --user restart` | `sudo -n launchctl kickstart -k system/<oznaka>`. */
export function restartUsluge(ime: string, o?: Okolina): boolean {
  return izvrsi(o)(argvRestarta(ime, o)) !== null
}

/** Naredba restarta kao tekst za čovjeka ili agenta (upute, znanje čvora). */
export function naredbaRestarta(ime: string, o?: Okolina): string { return argvRestarta(ime, o).join(' ') }

/** Start usluge: `systemctl --user start` | `launchctl bootstrap` (već učitana → `kickstart`). */
export function startUsluge(ime: string, o?: Okolina): boolean {
  const ex = izvrsi(o)
  if (jeLinux(o)) return ex(['systemctl', '--user', 'start', ime]) !== null
  return ex(['sudo', '-n', 'launchctl', 'bootstrap', 'system', launchdPlistPut(ime)]) !== null
    || ex(['sudo', '-n', 'launchctl', 'kickstart', `system/${launchdOznaka(ime)}`]) !== null
}

/** Namjerno gašenje: `systemctl --user stop` | `launchctl bootout` (inače bi je KeepAlive vratio). */
export function stopUsluge(ime: string, o?: Okolina): boolean {
  const argv = jeLinux(o)
    ? ['systemctl', '--user', 'stop', ime]
    : ['sudo', '-n', 'launchctl', 'bootout', `system/${launchdOznaka(ime)}`]
  return izvrsi(o)(argv) !== null
}

/** Naredba kojom opisUsluge čita stanje — za ispis čovjeku (bootcheck M1). */
export function naredbaOpisaUsluge(ime: string, o?: Okolina): string {
  return jeLinux(o) ? `systemctl --user show ${ime}` : `launchctl print system/${launchdOznaka(ime)}`
}

export interface OpisStanjaUsluge { stanje: StanjeUsluge; pid: number | null; cwd: string | null }

/**
 * Tko drži uslugu (bootcheck M1): stanje, glavni PID i radna mapa koju je upravitelj zadao.
 * Linux: `systemctl --user show` (MainPID=0 → null). macOS: `launchctl print system/<oznaka>`
 * (redak „working directory" postoji samo uz WorkingDirectory; inače se čita iz plista).
 */
export function opisUsluge(ime: string, o?: Okolina): OpisStanjaUsluge {
  const ex = izvrsi(o)
  if (jeLinux(o)) {
    const out = ex(['systemctl', '--user', 'show', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'WorkingDirectory', ime])
    if (out === null) return { stanje: 'nepoznato', pid: null, cwd: null }
    const polje = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1].trim() ?? ''
    const pid = Number(polje('MainPID'))
    return { stanje: polje('ActiveState') === 'active' ? 'active' : 'inactive',
      pid: ispravanPid(pid) ? pid : null, cwd: polje('WorkingDirectory') || null }
  }
  const out = ex(['launchctl', 'print', `system/${launchdOznaka(ime)}`])
  if (out === null) return { stanje: 'inactive', pid: null, cwd: null }
  // Gornja razina ispisa ima jedan tabulator; dublji retci (endpoints) imaju svoje „state".
  const gore = out.split('\n').filter(r => /^\t[^\t]/.test(r) || /^ {1,4}\S/.test(r)).join('\n')
  const radi = /^\s*state\s*=\s*running\s*$/m.test(gore)
  const pid = Number(gore.match(/^\s*pid\s*=\s*(\d+)/m)?.[1])
  const cwd = gore.match(/^\s*working directory\s*=\s*(.+)$/m)?.[1].trim()
    || ex(['plutil', '-extract', 'WorkingDirectory', 'raw', '-o', '-', launchdPlistPut(ime)])?.trim() || null
  return { stanje: radi ? 'active' : 'inactive', pid: radi && ispravanPid(pid) ? pid : null, cwd: radi ? cwd : null }
}

/** Upravlja li uslugom upravitelj sustava (jedinica učitana | LaunchDaemon učitan ili na disku)? */
export function uslugaPostoji(ime: string, o?: Okolina): boolean {
  const ex = izvrsi(o)
  if (jeLinux(o)) return ex(['systemctl', '--user', 'show', '-p', 'LoadState', '--value', ime])?.trim() === 'loaded'
  if (ex(['launchctl', 'print', `system/${launchdOznaka(ime)}`]) !== null) return true
  return (o?.postojiDatoteka ?? existsSync)(launchdPlistPut(ime))
}

export interface OpisUsluge { unit: string; aktivan: string; opis: string }

/** Sve usluge sustava (`regoc-*` na Linuxu, `hr.regoc.*` na macOS-u). */
export function uslugeRegoc(o?: Okolina): OpisUsluge[] {
  const ex = izvrsi(o)
  if (jeLinux(o)) {
    const out = ex(['systemctl', '--user', 'list-units', 'regoc-*', '--type=service', '--all', '--no-legend', '--plain']) ?? ''
    return out.split('\n').filter(Boolean).map(r => {
      const [unit, , aktivan, , ...opis] = r.trim().split(/\s+/)
      return { unit, aktivan, opis: opis.join(' ') }
    }).filter(u => u.unit)
  }
  // `launchctl print system` → redak usluge: „<pid|0|-> <zadnji izlaz|-> <oznaka>"
  const out = ex(['launchctl', 'print', 'system']) ?? ''
  const r: OpisUsluge[] = []
  for (const red of out.split('\n')) {
    const m = red.match(/^\s*(\d+|-)\s+(\S+)\s+hr\.regoc\.(\S+)\s*$/)
    if (!m) continue
    const pid = Number(m[1])
    r.push({ unit: `regoc-${m[3]}`, aktivan: pid > 0 ? 'active' : 'inactive',
      opis: `hr.regoc.${m[3]} (${pid > 0 ? `pid ${pid}` : `zadnji izlaz ${m[2]}`})` })
  }
  return r
}

/** Putanja LaunchDaemona za ime usluge (`regoc-znanje.timer` → `/Library/LaunchDaemons/hr.regoc.znanje.plist`). */
export function launchdPlistPut(ime: string): string {
  return `/Library/LaunchDaemons/${launchdOznaka(ime)}.plist`
}

export interface PlistOpcije {
  ime: string
  argv: string[]
  cwd?: string
  okolina?: Record<string, string>
  /** Periodička usluga (zamjena za systemd timer): pokretanje svakih N sekundi. */
  intervalSek?: number
  /** Stalna usluga (zamjena za Restart=always): launchd je diže kad padne. */
  stalno?: boolean
  /** Korisnik pod kojim radi (LaunchDaemon bez UserName radi kao root). */
  korisnik?: string
  nice?: number
  /** Datoteka za stdout i stderr. */
  log?: string
  /** Diže je launchd tek kad padne (izlaz ≠ 0), kao systemd Restart=on-failure. */
  nakonPada?: boolean
  /** Učitana, ali ne pokreće se sama (RunAtLoad=false): baze koje uključuje prekidač. */
  rucno?: boolean
  /** ProcessType=Background + LowPriorityIO: E-jezgre i prigušen I/O (prednost drugim programima). */
  pozadina?: boolean
  /** ThrottleInterval: najmanji razmak između dva pokretanja (systemd RestartSec). */
  razmakSek?: number
}

function xml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** LaunchDaemon plist (macOS) — isti sadržaj koji systemd dobiva iz .service/.timer. */
export function launchdPlist(p: PlistOpcije): string {
  const r: string[] = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>']
  const k = (kljuc: string, vrijednost: string) => r.push(`  <key>${kljuc}</key>`, `  ${vrijednost}`)
  k('Label', `<string>${xml(launchdOznaka(p.ime))}</string>`)
  r.push('  <key>ProgramArguments</key>', '  <array>', ...p.argv.map(a => `    <string>${xml(a)}</string>`), '  </array>')
  if (p.cwd) k('WorkingDirectory', `<string>${xml(p.cwd)}</string>`)
  if (p.korisnik) k('UserName', `<string>${xml(p.korisnik)}</string>`)
  if (p.okolina && Object.keys(p.okolina).length) {
    r.push('  <key>EnvironmentVariables</key>', '  <dict>')
    for (const [ime, v] of Object.entries(p.okolina)) r.push(`    <key>${xml(ime)}</key>`, `    <string>${xml(v)}</string>`)
    r.push('  </dict>')
  }
  if (p.intervalSek) k('StartInterval', `<integer>${Math.round(p.intervalSek)}</integer>`)
  if (p.stalno) { k('RunAtLoad', '<true/>'); k('KeepAlive', '<true/>') }
  else if (p.nakonPada) {
    k('RunAtLoad', '<true/>')
    r.push('  <key>KeepAlive</key>', '  <dict>', '    <key>SuccessfulExit</key>', '    <false/>', '  </dict>')
  } else if (p.rucno) k('RunAtLoad', '<false/>')
  if (p.razmakSek) k('ThrottleInterval', `<integer>${Math.round(p.razmakSek)}</integer>`)
  if (p.pozadina) { k('ProcessType', '<string>Background</string>'); k('LowPriorityIO', '<true/>') }
  if (p.nice !== undefined) k('Nice', `<integer>${p.nice}</integer>`)
  if (p.log) { k('StandardOutPath', `<string>${xml(p.log)}</string>`); k('StandardErrorPath', `<string>${xml(p.log)}</string>`) }
  r.push('</dict>', '</plist>', '')
  return r.join('\n')
}

export interface KorakNaredbe { argv: string[]; obavezno: boolean }

/**
 * Naredbe koje uključuju periodičku uslugu `<unit>.timer` (jedinice su već na disku).
 * macOS: plist iz korisničke mape `izvor` → /Library/LaunchDaemons (root), pa ponovno
 * učitavanje (bootout smije pasti kad usluga još nije učitana).
 */
export function naredbeUkljuciTimer(unit: string, o?: Okolina, izvor?: string): KorakNaredbe[] {
  if (jeLinux(o)) return [
    { argv: ['systemctl', '--user', 'daemon-reload'], obavezno: true },
    { argv: ['systemctl', '--user', 'enable', '--now', `${unit}.timer`], obavezno: true }]
  const cilj = launchdPlistPut(unit)
  return [
    { argv: ['sudo', '-n', 'install', '-m', '644', izvor ?? cilj, cilj], obavezno: true },
    { argv: ['sudo', '-n', 'launchctl', 'bootout', `system/${launchdOznaka(unit)}`], obavezno: false },
    { argv: ['sudo', '-n', 'launchctl', 'bootstrap', 'system', cilj], obavezno: true }]
}

/** Uputa čovjeku kako restartati usluge nakon izmjene njihovih postavki. */
export function uputaRestarta(unitovi: string[], o?: Okolina): string {
  if (jeLinux(o)) return `systemctl --user daemon-reload, pa restart ${unitovi.join(', ')}`
  return unitovi.map(u => naredbaRestarta(u, o)).join('; ')
}

/** Vrijednost varijable okoline živog procesa (procfs environ | `ps -E`, samo vlastiti procesi). */
export function okolinaProcesa(pid: number, ime: string, o?: Okolina): string | null {
  if (!ispravanPid(pid)) return null
  if (jeLinux(o)) {
    try {
      const pref = ime + '='
      const red = readFileSync(join(procRoot(o), String(pid), 'environ'), 'utf-8').split('\0').find(r => r.startsWith(pref))
      return red === undefined ? null : red.slice(pref.length)
    } catch { return null }
  }
  // BSD ps -E dopisuje okolinu iza naredbe; zadnja pojava je okolina (argv je ispred nje).
  const out = izvrsi(o)(['ps', '-E', '-ww', '-o', 'command=', '-p', String(pid)])
  if (!out) return null
  const svi = [...out.matchAll(new RegExp(`(?:^|\\s)${ime.replace(/[^\w]/g, '')}=(\\S*)`, 'g'))]
  return svi.length ? svi[svi.length - 1][1] : null
}

/** capguard (nftables + sudoers) postoji samo na Linuxu. */
export function capguardPodrzan(o?: Okolina): boolean { return jeLinux(o) }

export function capguardPoruka(o?: Okolina): string | null {
  return capguardPodrzan(o) ? null : `capguard: nije podržano na ovom OS-u (${os(o)})`
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [nar, arg, arg2] = process.argv.slice(2)
  const n = Number(arg)
  const ispis = (v: unknown) => { if (v === null || v === undefined || v === false) process.exit(1); console.log(v === true ? 'da' : v) }
  switch (nar) {
    case 'pid-na-vratima': ispis(pidNaVratima(n)); break
    case 'ziv': ispis(ziv(n)); break
    case 'cmdline': ispis(cmdline(n)); break
    case 'cwd': ispis(cwd(n)); break
    case 'start-ms': ispis(startProcesaMs(n)); break
    case 'oznaka-starta': ispis(oznakaStarta(n)); break
    case 'os': ispis(process.platform); break
    case 'libc': ispis(libc()); break
    case 'usluga': ispis(usluga(arg)); break
    case 'restart-usluge': ispis(restartUsluge(arg)); break
    case 'start-usluge': ispis(startUsluge(arg)); break
    case 'stop-usluge': ispis(stopUsluge(arg)); break
    case 'usluga-postoji': ispis(uslugaPostoji(arg)); break
    case 'okolina': ispis(okolinaProcesa(n, arg2)); break
    default:
      console.error('uporaba: bun src/core/platforma.ts pid-na-vratima <vrata> | ziv|cmdline|cwd|start-ms|oznaka-starta <pid> | os | libc | usluga|restart-usluge|start-usluge|stop-usluge|usluga-postoji <ime> | okolina <pid> <varijabla>')
      process.exit(2)
  }
}
