/**
 * TASK-5654 (plan Mac v3, K1, R16): izvan src/core/platforma.ts i orchestrator/Liveness.ts
 * nema Linux-only poziva — procfs, `ss`, naredba `setsid`, `script -qfec`, `libc.so.6`,
 * `sed -i`, `stat -c`, `date -d`, goli GNU `timeout`. Novi takav poziv tiho pada na macOS-u
 * (npr. „mrtav” živi proces pa čistač ubije zadatak), zato ga ova brana hvata pri commitu.
 * TASK-5668 (K1b): i `systemctl` (usluge idu kroz platforma.usluga/restartUsluge/…), naredba
 * `flock` (util-linux) i `apt-get` — svaki preostali pogodak je na popisu izuzeća s razlogom.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const MAPE = ['src', 'scripts', 'hooks', 'tools', 'agents', 'profili', 'templates']
const NASTAVCI = /\.(ts|js|sh|py)$|^[^.]+$/

/** Datoteke koje SMIJU znati za Linux. */
const DOPUSTENO = new Set([
  'src/core/platforma.ts', 'src/core/orchestrator/Liveness.ts',
  // macOS omotači koji DAJU naredbe `setsid`/`timeout` ljuskama (P10 #17, #18)
  'scripts/macos/bin/setsid', 'scripts/macos/bin/timeout',
  // TASK-5655 (K2): pisač usluga — JEDINO mjesto koje piše systemd jedinicu (Linux grana) ili
  // LaunchDaemon (macOS grana) iz templates/servis/usluge.json; isto što platforma.ts radi za
  // upravljanje, ali za instalaciju (tests/install-servis.test.ts provjerava obje grane).
  'scripts/instalacija/servis.ts',
  // TASK-5656 (K3): samostalne skripte čvora s izričitim granama OS-a (darwin: launchctl, lsof,
  // `ps eww`; linux: systemctl --user, /proc, ss). Ne smiju uvoziti platforma.ts: provjeri-cisto
  // radi bez repozitorija (curl | bash), nadogradi.sh stiže kroz `ssh … bash -s` na STARO stablo,
  // a deinstaliraj.sh briše i bun. Obje grane drže tests/deinstalacija-do-nule.test.ts (lažni
  // darwin) i tests/nadogradi.test.ts.
  'scripts/provjeri-cisto.sh', 'scripts/nadogradi.sh', 'scripts/deinstaliraj.sh',
])
/** Pojedinačne iznimke: redak u datoteci koji smije sadržavati uzorak, i ZAŠTO. */
const IZNIMKE: { datoteka: string; redak: RegExp; razlog: string }[] = [
  { datoteka: 'src/KonzolaVrata.ts', redak: /PUT_TAJNI|\/proc\/<pid>\/environ/,
    razlog: 'nije poziv nego sigurnosni uzorak koji ODBIJA naredbe konzole prema okolini procesa (na macOS-u bezopasan, i dalje odbija)' },
  { datoteka: 'src/core/CompletionGuard.ts', redak: /kind: 'command', re: \/\\b\(curl\|git/,
    razlog: 'nije poziv nego popis riječi po kojima se u odgovoru prepoznaje naredba kao dokaz' },
  { datoteka: 'scripts/profil-cvora-stanje.ts', redak: /nar\(\['systemctl', '--user', 'is-active', ime\]\)/,
    razlog: 'Linux grana ZRCALA platforma.usluga: sakupljač se izvodi preko SSH-a sa stdin-a i ne smije uvoziti paket (ugovor: tests/profil-cvora-stanje-usluga.test.ts)' },
  { datoteka: 'scripts/install.sh', redak: /sudo apt-get install -y \$\{apt/,
    razlog: 'nije poziv nego uputa čovjeku kad na Linuxu fali preduvjet (install.sh sam ne pokreće apt ni sudo, plan P3 korak 2)' },
  { datoteka: 'scripts/install.sh', redak: /for ime in setsid timeout; do|K2\.12-macos-omotaci "macOS: setsid i timeout/,
    razlog: 'korak koji na macOS-u POSTAVLJA omotače setsid/timeout iz scripts/macos/bin (P10 #17, #18); naredbe se ne zovu' },
  { datoteka: 'scripts/instaliraj-pdf.sh', redak: /apt-get/,
    razlog: 'Linux grana apt_paket (vrata [ "$OS" = Linux ], samo sudo -n); macOS ide preuzimanjem fonta u korisničku mapu (tests/instaliraj-pdf-mac.test.ts)' },
]

const UZORCI: [string, RegExp][] = [
  ['procfs', /\/proc\b/],
  ['ss', /(^|[\s'"`[(;|&])ss\s+-[a-zA-Z]|\[\s*['"]ss['"]/],
  ['setsid', /\bsetsid\b/],
  ['script -qfec', /script\s+-q?f?e?c|['"]-qfec['"]/],
  ['libc.so.6', /libc\.so\.6/],
  ['sed -i', /\bsed\s+-i\b/],
  ['stat -c', /\bstat\s+-c\b/],
  ['date -d', /\bdate\s+-d\b/],
  ['timeout', /(^|[\s;&|(])timeout\s+\d/],
  ['systemctl', /\bsystemctl\b/],
  ['flock', /(^|[\s;&|(`'"])flock\s+-|\[\s*['"]flock['"]/],
  ['apt-get', /\bapt-get\b/],
]

function datoteke(mapa: string): string[] {
  const out: string[] = []
  let imena: string[] = []
  try { imena = readdirSync(mapa) } catch { return out }
  for (const ime of imena) {
    if (ime === 'node_modules' || ime.startsWith('.')) continue
    const p = join(mapa, ime)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...datoteke(p))
    else if (NASTAVCI.test(ime) && st.size < 2_000_000) out.push(p)
  }
  return out
}

describe('brana prenosivosti (K1 grep = 0)', () => {
  test('nema Linux-only poziva izvan platformnog sloja', () => {
    const nalazi: string[] = []
    for (const m of MAPE) for (const p of datoteke(join(KORIJEN, m))) {
      const rel = relative(KORIJEN, p)
      if (DOPUSTENO.has(rel)) continue
      const redovi = readFileSync(p, 'utf-8').split('\n')
      redovi.forEach((red, i) => {
        if (IZNIMKE.some(z => z.datoteka === rel && z.redak.test(red))) return
        for (const [ime, re] of UZORCI) if (re.test(red)) nalazi.push(`${rel}:${i + 1} [${ime}] ${red.trim().slice(0, 120)}`)
      })
    }
    expect(nalazi).toEqual([])
  })

  test('svako izuzeće ima razlog i još pogađa svoj redak (nema zastarjelih izuzeća)', () => {
    for (const z of IZNIMKE) {
      expect(z.razlog.length).toBeGreaterThan(20)
      const redovi = readFileSync(join(KORIJEN, z.datoteka), 'utf-8').split('\n')
      expect(redovi.some(r => z.redak.test(r) && UZORCI.some(([, re]) => re.test(r)))).toBe(true)
    }
  })

  test('brana stvarno hvata (uzorci nad poznatim Linux pozivima)', () => {
    const lose = [
      "readFileSync(`/proc/${pid}/cmdline`)", "ss -ltnp 2>/dev/null", "Bun.spawn(['setsid', x])",
      "Bun.spawn(['script', '-qfec', c, '/dev/null'])", "dlopen('libc.so.6', {})", "sed -i 's/a/b/' f",
      "stat -c %Y f", "date -d '1 day ago'", "  timeout 25 bun add zod",
      "Bun.spawnSync(['systemctl', '--user', 'restart', u])", "if ! flock -w 5 8; then", "flock -n \"$LOCK\" true",
      "Bun.spawn(['flock', '-n', f])", "sudo -n apt-get install -y ffmpeg",
    ]
    for (const l of lose) expect(UZORCI.some(([, re]) => re.test(l))).toBe(true)
    for (const dobro of ['s_rokom 25 bun add zod', "AbortSignal.timeout(5000)", 'process.kill(pid, 0)', 'class Process',
      "perl -MFcntl=:flock -e 'flock($f, LOCK_EX)'", 'brava_fd 8 5'])
      expect(UZORCI.some(([, re]) => re.test(dobro))).toBe(false)
  })
})
