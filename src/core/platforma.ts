/**
 * platforma.ts — jedino mjesto koje zna razliku Linux ↔ macOS (TASK-5654, plan Mac v3 K1, P10).
 *
 * Paket i komplet (`~/.claude/regoc/lib/platforma.ts` je poveznica na ovu datoteku) ne
 * čitaju procfs i ne zovu `ss`, `setsid`, `script -qfec` ni `libc.so.6` izravno, nego
 * kroz ove funkcije. Na Linuxu je ponašanje bajt-za-bajt isto kao prije (isti izvori,
 * isti oblik oznake starta procesa), a na macOS-u se koriste ugrađeni alati:
 *
 *   ziv(pid)            process.kill(pid, 0)                      (oba OS-a)
 *   cmdline(pid)        procfs cmdline        | ps -o command= -p
 *   oznakaStarta(pid)   procfs stat polje 22  | LC_ALL=C ps -o lstart= -p  (epoha, s)
 *   startProcesaMs(pid) polje 22 + uptime     | lstart (sekundna rezolucija)
 *   bootMs()            procfs uptime         | sysctl -n kern.boottime
 *   cwd(pid)            readlink cwd          | lsof -a -p <pid> -d cwd -Fn
 *   pidovi()            readdir procfs        | ps -A -o pid=
 *   pidNaVratima(v)     ss -ltnp (lsof rezerva) | lsof -nP -iTCP:<v> -sTCP:LISTEN -t
 *   libc()              libc.so.6             | /usr/lib/libSystem.B.dylib
 *   ptyNaredba(cmd)     script -qfec cmd /dev/null | script -q /dev/null /bin/sh -c cmd
 *   odvojeno(argv)      spawn detached (setsid(2) na oba OS-a), bez naredbe `setsid`
 *   rokNaredba(s, argv) timeout | gtimeout | perl alarm (izlaz 124 kao GNU)
 *   usluga(ime)         systemctl --user is-active | launchctl print system/hr.regoc.<ime>
 *   capguardPodrzan()   samo Linux (nftables); macOS: „nije podržano"
 *
 * Svaka funkcija prima opcionalnu `Okolina` (OS, izvršitelj naredbi, korijen procfs-a),
 * pa se macOS grana testira na Linuxu s lažnim `darwin` (tests/platforma.test.ts).
 *
 * CLI (za ljuske, npr. scripts/start.sh):
 *   bun src/core/platforma.ts pid-na-vratima <vrata>
 *   bun src/core/platforma.ts ziv|cmdline|cwd|start-ms|oznaka-starta <pid>
 *   bun src/core/platforma.ts os|libc|usluga <ime>
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

/** `ps -o lstart=` → epoha u ms (macOS; sekundna rezolucija). */
function lstartMs(pid: number, o?: Okolina): number | null {
  const out = izvrsi(o)(['ps', '-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C' })
  const t = out?.trim()
  if (!t) return null
  const ms = Date.parse(t)
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
  // BSD script: script [-q] [datoteka [naredba …]] — nema -f/-e/-c
  return ['script', '-q', '/dev/null', '/bin/sh', '-c', cmd]
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

/** Stanje usluge: systemd korisnička jedinica na Linuxu, LaunchDaemon na macOS-u. */
export function usluga(ime: string, o?: Okolina): StanjeUsluge {
  const ex = izvrsi(o)
  if (jeLinux(o)) {
    const t = ex(['systemctl', '--user', 'is-active', ime])?.trim()
    if (t === 'active') return 'active'
    return t ? 'inactive' : 'nepoznato'
  }
  const out = ex(['launchctl', 'print', `system/${launchdOznaka(ime)}`])
  if (out === null) return 'inactive'
  return /^\s*state\s*=\s*running/m.test(out) ? 'active' : 'inactive'
}

/** capguard (nftables + sudoers) postoji samo na Linuxu. */
export function capguardPodrzan(o?: Okolina): boolean { return jeLinux(o) }

export function capguardPoruka(o?: Okolina): string | null {
  return capguardPodrzan(o) ? null : `capguard: nije podržano na ovom OS-u (${os(o)})`
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [nar, arg] = process.argv.slice(2)
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
    default:
      console.error('uporaba: bun src/core/platforma.ts pid-na-vratima <vrata> | ziv|cmdline|cwd|start-ms|oznaka-starta <pid> | os | libc | usluga <ime>')
      process.exit(2)
  }
}
