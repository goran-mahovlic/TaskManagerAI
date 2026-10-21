#!/usr/bin/env bun
/**
 * servis — usluge čvora iz jednog opisa (`templates/servis/usluge.json`) za oba OS-a.
 *
 *   bun scripts/instalacija/servis.ts popis --uvjeti uvijek,komplet,baze
 *   bun scripts/instalacija/servis.ts prikazi --ime taskmanager [--os linux|darwin]
 *   bun scripts/instalacija/servis.ts primijeni --ime taskmanager [--suho]
 *   bun scripts/instalacija/servis.ts sudoers [--korisnik IME]   # suženi sudoers (macOS), vidi templates/servis/sudoers.primjer
 *
 * Linux: systemd korisnička jedinica u ~/.config/systemd/user (`regoc-<ime>.service`, za
 * periodične i `.timer`). macOS: LaunchDaemon `/Library/LaunchDaemons/hr.regoc.<ime>.plist`
 * s `UserName` instalatora (korisnik bez GUI sesije nema LaunchAgent, plan Mac v3 §2).
 * Korisnik usluge nikad nije root ni prazan (K5 V2): ploča nema autentikacije, pa bi usluga kao
 * root svakom tko dođe do ploče dala root.
 *
 * `primijeni` prvo mjeri pa tek onda piše: isti sadržaj na disku i usluga učitana → ispiše
 * `ISTO` i ništa ne dira (idempotentnost, P3). Inače stara datoteka ide u
 * $TM_HOME/backup/servis-<vrijeme>/, nova se zapiše i usluga se (ponovno) učita → `PROMIJENJENO`.
 * Izlaz: 0 uspjeh · 7 usluga se nije dala postaviti (kod iz P3.1) · 2 pogrešna uporaba (i korisnik root/prazan).
 *
 * Varijable predloška dolaze iz okoline: PAKET, TM_HOME, TM_PORT, BUN, KOMPLET, BAZE_VENV, PG_BIN.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir, userInfo } from 'os'
import { dirname, join } from 'path'
import { launchdOznaka, launchdPlist, launchdPlistPut } from '../../src/core/platforma'

export type Vrsta = 'stalna' | 'nakon-pada' | 'periodicna' | 'rucna'
export interface OpisUsluge {
  ime: string; opis: string; uvjet: string; vrsta: Vrsta; cwd: string; argv: string[]
  poslije?: string; intervalSek?: number
}
export interface Datoteka { put: string; sadrzaj: string }

const PAKET = join(import.meta.dir, '..', '..')
const OPIS = join(PAKET, 'templates', 'servis', 'usluge.json')

export function ucitajOpise(put = OPIS): OpisUsluge[] {
  return JSON.parse(readFileSync(put, 'utf-8')).usluge as OpisUsluge[]
}

export function vrijednosti(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const home = env.HOME || homedir()
  const tmHome = env.TM_HOME || join(home, '.taskmanager')
  return {
    PAKET: env.PAKET || PAKET,
    TM_HOME: tmHome,
    TM_PORT: env.TM_PORT || '17781',
    BUN: env.BUN || join(home, '.bun', 'bin', 'bun'),
    KOMPLET: env.KOMPLET || '',   // odredište kompleta zadaje install.sh (komplet.lock / TM_KOMPLET_DIR)
    BAZE_VENV: env.BAZE_VENV || join(tmHome, 'baze', 'venv'),
    PG_BIN: env.PG_BIN || join(tmHome, 'rag', 'pg0', 'bin'),
    HOME: home,
    KORISNIK: env.KORISNIK ?? (env.USER || userInfo().username),
  }
}

/** Korisnik usluge: ni root ni prazan (K5 V2) — inače se jedinica/plist ne radi. */
export function provjeriKorisnika(k: string | undefined): string {
  if (!k || !k.trim()) throw new Error('korisnik usluge je prazan — pokreni kao korisnik usluge, bez sudo')
  if (k === 'root' || k === '0') throw new Error('korisnik usluge je root — ploča bez autentikacije radila bi kao root; pokreni kao korisnik usluge, bez sudo')
  return k
}

export function zamijeni(t: string, v: Record<string, string>): string {
  return t.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in v)) throw new Error(`nepoznata varijabla predloška ${m}`)
    if (!v[k]) throw new Error(`varijabla predloška ${m} nije zadana`)
    return v[k]
  })
}

/** Okolina usluge — ista na oba OS-a; tajne NIKAD (dolaze kroz s-okolinom.sh --tajne). */
export function okolinaUsluge(v: Record<string, string>): Record<string, string> {
  return {
    PATH: `${v.HOME}/.bun/bin:${v.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: v.HOME,
    TM_HOME: v.TM_HOME,
    TMPDIR: `${v.TM_HOME}/tmp`,
  }
}

function citiraj(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`
}

/** systemd korisničke jedinice: `.service` (+ `.timer` za periodične). */
export function systemdJedinice(u: OpisUsluge, v: Record<string, string>): Datoteka[] {
  provjeriKorisnika(v.KORISNIK)
  const dir = join(v.HOME, '.config', 'systemd', 'user')
  const ime = `regoc-${u.ime}`
  const argv = u.argv.map(a => zamijeni(a, v))
  const env = okolinaUsluge(v)
  const s: string[] = ['[Unit]', `Description=${u.opis}`]
  if (u.poslije) s.push(`After=regoc-${u.poslije}.service`, `Wants=regoc-${u.poslije}.service`)
  s.push('', '[Service]', `Type=${u.vrsta === 'periodicna' ? 'oneshot' : 'simple'}`,
    `WorkingDirectory=${zamijeni(u.cwd, v)}`, `ExecStart=${argv.map(citiraj).join(' ')}`)
  for (const [k, val] of Object.entries(env)) s.push(`Environment=${citiraj(`${k}=${val}`)}`)
  if (u.vrsta === 'stalna') s.push('Restart=always', 'RestartSec=5')
  if (u.vrsta === 'nakon-pada') s.push('Restart=on-failure', 'RestartSec=5')
  s.push('Nice=10')
  if (u.vrsta === 'stalna' || u.vrsta === 'nakon-pada') s.push('', '[Install]', 'WantedBy=default.target')
  const van: Datoteka[] = [{ put: join(dir, `${ime}.service`), sadrzaj: s.join('\n') + '\n' }]
  if (u.vrsta === 'periodicna') {
    van.push({ put: join(dir, `${ime}.timer`), sadrzaj: ['[Unit]', `Description=${u.opis} (raspored)`, '', '[Timer]',
      'OnBootSec=5min', `OnUnitActiveSec=${u.intervalSek ?? 1800}`, '', '[Install]', 'WantedBy=timers.target', ''].join('\n') })
  }
  return van
}

/** LaunchDaemon (macOS) iz istog opisa. */
export function launchdDatoteka(u: OpisUsluge, v: Record<string, string>): Datoteka {
  const korisnik = provjeriKorisnika(v.KORISNIK)
  return {
    put: launchdPlistPut(`regoc-${u.ime}`),
    sadrzaj: launchdPlist({
      ime: `regoc-${u.ime}`,
      argv: u.argv.map(a => zamijeni(a, v)),
      cwd: zamijeni(u.cwd, v),
      korisnik,
      okolina: okolinaUsluge(v),
      stalno: u.vrsta === 'stalna',
      nakonPada: u.vrsta === 'nakon-pada',
      rucno: u.vrsta === 'rucna',
      intervalSek: u.vrsta === 'periodicna' ? (u.intervalSek ?? 1800) : undefined,
      razmakSek: 5,
      pozadina: true,
      nice: 10,
      log: join(v.TM_HOME, 'log', `${u.ime}.log`),
    }),
  }
}

export function datotekeUsluge(u: OpisUsluge, os: string, v: Record<string, string>): Datoteka[] {
  return os === 'darwin' ? [launchdDatoteka(u, v)] : systemdJedinice(u, v)
}

// ─── suženi sudoers (K5 V1) ──────────────────────────────────────────────────

/**
 * Suženi sudoers za korisnika usluge na macOS-u: samo (re)pokretanje, učitavanje i gašenje
 * VLASTITIH LaunchDaemona, svaka oznaka i putanja plista nabrojana točno. Zamjenski znak u
 * putanji (`hr.regoc.*.plist`) ne smije: sudoers ga širi i preko `/`, pa propušta i
 * `hr.regoc.x/../../tmp/zlo.plist`. `templates/servis/sudoers.primjer` je izlaz ove funkcije.
 */
export function sudoersPrimjer(opisi: OpisUsluge[], korisnik = 'KORISNIK_USLUGE'): string {
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(korisnik) || korisnik === 'ALL') throw new Error(`neispravno ime korisnika za sudoers: ${korisnik}`)
  provjeriKorisnika(korisnik)
  const naredbe: string[] = []
  for (const o of opisi) {
    const oznaka = launchdOznaka(`regoc-${o.ime}`)
    if (!/^hr\.regoc\.[a-z0-9-]+$/.test(oznaka)) throw new Error(`neispravna oznaka usluge: ${oznaka}`)
    naredbe.push(`/bin/launchctl kickstart -k system/${oznaka}`, `/bin/launchctl kickstart system/${oznaka}`,
      `/bin/launchctl bootout system/${oznaka}`, `/bin/launchctl bootstrap system ${launchdPlistPut(`regoc-${o.ime}`)}`)
  }
  return [
    '# Suženi sudoers za korisnika usluge TaskManagerAI na macOS-u (K5 V1, TASK-5685).',
    '# Generira ga: bun scripts/instalacija/servis.ts sudoers [--korisnik IME]',
    '# iz templates/servis/usluge.json; test drži ovu datoteku jednakom izlazu generatora.',
    '#',
    '# Zamjenjuje puni "IME ALL=(ALL) NOPASSWD: ALL". Ploča nema autentikacije, a agenti rade bez',
    '# pitanja za dopuštenje, pa bi puni sudo svakome tko dođe do ploče dao root. Ovdje usluga smije',
    '# samo pokrenuti, ponovno pokrenuti, učitati i zaustaviti VLASTITE LaunchDaemone. Svaka oznaka i',
    '# putanja plista je nabrojana točno, bez zamjenskih znakova: uzorak u putanji plista širi se i',
    '# preko kose crte, pa bi propustio i plist izvan /Library/LaunchDaemons.',
    '# Upis plista (install.sh, nova usluga) i dalje traži administratora: sudo -v pa ponovi.',
    '#',
    '# Postavljanje (kao administrator, nakon instalacije; IME = korisnik usluge):',
    '#   bun scripts/instalacija/servis.ts sudoers --korisnik IME > regoc.sudoers',
    '#   sudo visudo -c -f regoc.sudoers',
    '#   sudo install -m 440 -o root -g wheel regoc.sudoers /etc/sudoers.d/regoc',
    '#   sudo -l -U IME          (mora pokazati samo ove naredbe, bez NOPASSWD: ALL)',
    '',
    `Cmnd_Alias REGOC_USLUGE = \\`,
    ...naredbe.map((n, i) => `    ${n}${i < naredbe.length - 1 ? ', \\' : ''}`),
    '',
    `${korisnik} ALL=(root) NOPASSWD: REGOC_USLUGE`,
    '',
  ].join('\n')
}

// ─── primjena ────────────────────────────────────────────────────────────────

type Izvrsi = (argv: string[]) => { kod: number; izlaz: string }
const izvrsiZadano: Izvrsi = argv => {
  try {
    const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
    return { kod: r.exitCode ?? 1, izlaz: (r.stdout.toString() + r.stderr.toString()).trim() }
  } catch (e) { return { kod: 127, izlaz: `${argv[0]}: ${e instanceof Error ? e.message : String(e)}` } }
}

function procitaj(put: string, ex: Izvrsi, os: string): string | null {
  if (os === 'darwin') { if (!existsSync(put)) return null; try { return readFileSync(put, 'utf-8') } catch { const r = ex(['sudo', '-n', 'cat', put]); return r.kod === 0 ? r.izlaz + '\n' : null } }
  return existsSync(put) ? readFileSync(put, 'utf-8') : null
}

export interface Ishod { promijenjeno: boolean; poruke: string[] }

export function primijeni(u: OpisUsluge, os: string, v: Record<string, string>, opc: { suho?: boolean; ex?: Izvrsi; vrijeme?: string } = {}): Ishod {
  const ex = opc.ex ?? izvrsiZadano
  const datoteke = datotekeUsluge(u, os, v)
  const razlicite = datoteke.filter(d => procitaj(d.put, ex, os) !== d.sadrzaj)
  const poruke: string[] = []
  const jedinica = `regoc-${u.ime}`
  const oznaka = launchdOznaka(jedinica)
  const ucitana = os === 'darwin'
    ? ex(['launchctl', 'print', `system/${oznaka}`]).kod === 0
    : u.vrsta === 'rucna' || ex(['systemctl', '--user', 'is-enabled', u.vrsta === 'periodicna' ? `${jedinica}.timer` : `${jedinica}.service`]).kod === 0
  if (!razlicite.length && ucitana) return { promijenjeno: false, poruke: [`${jedinica}: isto, učitana`] }
  for (const d of razlicite) poruke.push(`${opc.suho ? 'zapisala bih' : 'zapisujem'} ${d.put}`)
  if (!ucitana) poruke.push(`${opc.suho ? 'učitala bih' : 'učitavam'} ${jedinica}`)
  if (opc.suho) return { promijenjeno: true, poruke }

  const backup = join(v.TM_HOME, 'backup', `servis-${opc.vrijeme ?? new Date().toISOString().replace(/[:.]/g, '-')}`)
  const pazi = (r: { kod: number; izlaz: string }, sto: string) => {
    if (r.kod !== 0) throw new Error(`${sto}: izlaz ${r.kod}${r.izlaz ? ` — ${r.izlaz.split('\n').slice(-3).join(' | ')}` : ''}`)
  }
  if (os === 'darwin') {
    const d = datoteke[0]
    const priprema = join(v.TM_HOME, 'servis', `${oznaka}.plist`)
    mkdirSync(dirname(priprema), { recursive: true })
    writeFileSync(priprema, d.sadrzaj)
    pazi(ex(['plutil', '-lint', priprema]), 'plutil -lint')
    mkdirSync(join(v.TM_HOME, 'log'), { recursive: true })
    mkdirSync(join(v.TM_HOME, 'tmp'), { recursive: true })
    if (razlicite.length) {
      if (existsSync(d.put)) { mkdirSync(backup, { recursive: true }); ex(['cp', d.put, join(backup, `${oznaka}.plist`)]) }
      pazi(ex(['sudo', '-n', 'install', '-m', '644', '-o', 'root', '-g', 'wheel', priprema, d.put]), `sudo install ${d.put} (treba administratorsko pravo: sudo -v pa ponovi; suženi sudoers iz templates/servis/sudoers.primjer ne dopušta upis plista)`)
      if (ucitana) ex(['sudo', '-n', 'launchctl', 'bootout', `system/${oznaka}`])
    }
    pazi(ex(['sudo', '-n', 'launchctl', 'bootstrap', 'system', d.put]), `launchctl bootstrap system ${d.put}`)
    return { promijenjeno: true, poruke }
  }
  // Linux: systemd korisnička sesija mora postojati (u kontejneru bez systemd-a je nema)
  pazi(ex(['systemctl', '--user', 'show-environment']), 'nema systemd korisničke sesije (pokreni s --bez-servisa ili uključi lingering)')
  for (const d of razlicite) {
    if (existsSync(d.put)) { mkdirSync(backup, { recursive: true }); copyFileSync(d.put, join(backup, d.put.split('/').pop()!)) }
    mkdirSync(dirname(d.put), { recursive: true })
    writeFileSync(d.put, d.sadrzaj)
  }
  mkdirSync(join(v.TM_HOME, 'tmp'), { recursive: true })
  pazi(ex(['systemctl', '--user', 'daemon-reload']), 'systemctl --user daemon-reload')
  if (u.vrsta === 'stalna' || u.vrsta === 'nakon-pada') {
    pazi(ex(['systemctl', '--user', 'enable', `${jedinica}.service`]), `enable ${jedinica}`)
    pazi(ex(['systemctl', '--user', razlicite.length ? 'restart' : 'start', `${jedinica}.service`]), `start ${jedinica}`)
  } else if (u.vrsta === 'periodicna') {
    pazi(ex(['systemctl', '--user', 'enable', '--now', `${jedinica}.timer`]), `enable ${jedinica}.timer`)
  }
  return { promijenjeno: true, poruke }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [nar, ...ost] = process.argv.slice(2)
  const arg = (k: string) => { const i = ost.indexOf(k); return i >= 0 ? ost[i + 1] : undefined }
  const os = (arg('--os') || process.env.TM_INSTALL_OS || process.platform).toLowerCase()
  const opisi = ucitajOpise()
  const v = vrijednosti()
  if (nar === 'sudoers') {
    try { process.stdout.write(sudoersPrimjer(opisi, arg('--korisnik'))) }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2) }
    process.exit(0)
  }
  // korisnik usluge nikad root ni prazan (K5 V2) — prije ikakve izrade jedinice
  if (nar === 'prikazi' || nar === 'primijeni') {
    try { provjeriKorisnika(v.KORISNIK) } catch (e) { console.error(`servis.ts: ${e instanceof Error ? e.message : String(e)}`); process.exit(2) }
  }
  const nadji = () => {
    const u = opisi.find(o => o.ime === arg('--ime'))
    if (!u) { console.error(`nepoznata usluga: ${arg('--ime')} (postoje: ${opisi.map(o => o.ime).join(', ')})`); process.exit(2) }
    return u
  }
  if (nar === 'popis') {
    const uvjeti = (arg('--uvjeti') || 'uvijek').split(',')
    for (const o of opisi.filter(o => uvjeti.includes(o.uvjet))) console.log(o.ime)
  } else if (nar === 'prikazi') {
    for (const d of datotekeUsluge(nadji(), os, v)) console.log(`# ${d.put}\n${d.sadrzaj}`)
  } else if (nar === 'primijeni') {
    try {
      const r = primijeni(nadji(), os, v, { suho: ost.includes('--suho') })
      for (const p of r.poruke) console.log(`  ${p}`)
      console.log(r.promijenjeno ? 'PROMIJENJENO' : 'ISTO')
    } catch (e) {
      console.error(`  usluga nije postavljena: ${e instanceof Error ? e.message : String(e)}`)
      process.exit(7)
    }
  } else {
    console.error('uporaba: servis.ts popis --uvjeti … | prikazi --ime IME [--os linux|darwin] | primijeni --ime IME [--suho] | sudoers [--korisnik IME]')
    process.exit(2)
  }
}
