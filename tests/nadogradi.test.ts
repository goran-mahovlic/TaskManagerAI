/**
 * TASK-5656 (plan Mac v3 K3): scripts/nadogradi.sh — nadogradnja na čvoru, bez mreže i bez systemd-a.
 *
 * Lažni `systemctl` (PATH) vodi „uslugu": mali bun poslužitelj koji otvori bazu iz TM_DB i
 * odgovara na /health. Test drži ugovor koji je dosad držao samo tm-cvor-azuriraj.sh:
 *   • bundle → checkout na traženi commit, MainPID se mijenja, HTTP 200, broj zadataka prije = poslije,
 *   • kopija baze i lokalnog stanja u $TM_HOME/backup/nadogradnja/<vrijeme>, git-ignorirane postavke ostaju,
 *   • novi proces na DRUGOJ bazi (ispad node-B 04.10.) → „CVOR PAD", izlaz 1,
 *   • --suho ne mijenja ništa; bundle bez traženog commita → izlaz 12,
 *   • skripta radi i kad se pošalje kroz stdin (`ssh čvor bash -s < nadogradi.sh`).
 */
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const KORIJEN = join(import.meta.dir, '..')
const BUN_DIR = dirname(process.execPath)
const radna = () => process.env.TMPDIR || tmpdir()
mkdirSync(radna(), { recursive: true })

const POSLUZITELJ = `
import { Database } from 'bun:sqlite'
const db = new Database(process.env.TM_DB)   // drži bazu otvorenom kao ploča (koristi je u svakom zahtjevu)
Bun.serve({ port: Number(process.env.VRATA), hostname: '127.0.0.1', fetch: () => new Response(String((db.query('select count(*) n from tasks').get() as any).n)) })
`

function okruzje(ime: string) {
  const k = mkdtempSync(join(radna(), `tm-nadog-${ime}-`))
  const home = join(k, 'home'), izvor = join(k, 'izvor'), cvor = join(home, 'TaskManagerAI'), lazni = join(k, 'lazni')
  for (const d of [home, izvor, lazni, join(k, 'tmp')]) mkdirSync(d, { recursive: true })
  const g = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=proba', '-c', 'user.email=proba@example.invalid', ...a], { cwd })
    return r.stdout.toString().trim()
  }
  writeFileSync(join(izvor, 'README.md'), 'v1\n'); writeFileSync(join(izvor, 'bun.lock'), '{}\n')
  writeFileSync(join(izvor, '.gitignore'), 'config/postavke.env\nnode_modules\n')
  g(izvor, 'init', '-q', '-b', 'main'); g(izvor, 'add', '-A'); g(izvor, 'commit', '-q', '-m', 'v1')
  const stari = g(izvor, 'rev-parse', 'HEAD')
  g(k, 'clone', '-q', izvor, cvor)
  mkdirSync(join(cvor, 'config')); writeFileSync(join(cvor, 'config', 'postavke.env'), 'TM_PORT=1\n')   // lokalno, ignorirano
  writeFileSync(join(izvor, 'README.md'), 'v2\n'); writeFileSync(join(izvor, 'novo.txt'), 'novo\n')
  g(izvor, 'add', '-A'); g(izvor, 'commit', '-q', '-m', 'v2')
  const novi = g(izvor, 'rev-parse', 'HEAD')
  const bundle = join(home, 'paket.bundle')
  g(izvor, 'bundle', 'create', '-q', bundle, 'main')
  // baza koju „usluga" drži (kao na node-A: TM_DB izvan $TM_HOME)
  const db = join(k, 'regoc', 'data', 'regoc.db'); mkdirSync(dirname(db), { recursive: true })
  const d = new Database(db); d.exec('create table tasks (id text); insert into tasks values (1),(2),(3)'); d.close()
  const vrata = 20000 + Math.floor(Math.random() * 20000)
  writeFileSync(join(k, 'posluzitelj.ts'), POSLUZITELJ)
  // lažni systemctl: show → PID iz datoteke; restart → ugasi stari, digni novi (TM_DB iz datoteke baza.txt)
  writeFileSync(join(k, 'baza.txt'), db)
  writeFileSync(join(lazni, 'systemctl'), `#!/bin/bash
P=${k}/pid
case "$*" in
  *show*MainPID*) cat "$P" 2>/dev/null || echo 0 ;;
  *restart*) [ -f "$P" ] && kill "$(cat "$P")" 2>/dev/null; sleep 0.3
    TM_DB="$(cat ${k}/baza.txt)" VRATA=${vrata} setsid ${process.execPath} ${k}/posluzitelj.ts >/dev/null 2>&1 < /dev/null & echo $! > "$P" ;;
esac
exit 0
`)
  chmodSync(join(lazni, 'systemctl'), 0o755)
  const start = Bun.spawnSync(['bash', join(lazni, 'systemctl'), '--user', 'restart', 'regoc-proba'])
  expect(start.exitCode).toBe(0)
  return { k, home, cvor, bundle, stari, novi, db, vrata, lazni, g }
}
type O = ReturnType<typeof okruzje>

function pokreni(o: O, argv: string[], kroz_stdin = false) {
  const env = { HOME: o.home, PATH: `${o.lazni}:${BUN_DIR}:/usr/bin:/bin`, TMPDIR: join(o.k, 'tmp'), LANG: 'C.UTF-8' }
  const osnovno = ['--paket', o.cvor, '--usluga', 'regoc-proba', '--vrata', String(o.vrata), ...argv]
  const r = kroz_stdin
    ? Bun.spawnSync(['bash', '-s', '--', ...osnovno], { stdin: Buffer.from(readFileSync(join(KORIJEN, 'scripts', 'nadogradi.sh'))), cwd: o.home, env, stdout: 'pipe', stderr: 'pipe' })
    : Bun.spawnSync(['bash', join(KORIJEN, 'scripts', 'nadogradi.sh'), ...osnovno], { cwd: o.home, env, stdout: 'pipe', stderr: 'pipe' })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
}
const ugasi = (o: O) => { try { process.kill(Number(readFileSync(join(o.k, 'pid'), 'utf-8')), 'SIGKILL') } catch {} }
const cekajHttp = async (o: O) => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${o.vrata}/health`)).ok) return } catch {} await Bun.sleep(100) }
}

describe('nadogradi.sh — bundle na čvoru', () => {
  test('kroz stdin: checkout, novi MainPID, ista baza, zadataka prije = poslije, kopija, lokalno ostaje', async () => {
    const o = okruzje('ok')
    try {
      await cekajHttp(o)
      const stariPid = readFileSync(join(o.k, 'pid'), 'utf-8').trim()
      const r = pokreni(o, ['--bundle', o.bundle, '--grana', 'main', '--sha', o.novi], true)
      expect(r.kod, r.izlaz).toBe(0)
      expect(r.izlaz).toContain('CVOR OK')
      expect(r.izlaz).toContain(`verzija: ${o.stari.slice(0, 7)} -> ${o.novi.slice(0, 7)}`)
      expect(r.izlaz).toContain('✓ zadataka: prije 3, poslije 3')
      expect(r.izlaz).toContain('✓ novi proces koristi istu bazu')
      expect(o.g(o.cvor, 'rev-parse', 'HEAD')).toBe(o.novi)
      expect(readFileSync(join(o.cvor, 'config', 'postavke.env'), 'utf-8')).toBe('TM_PORT=1\n')
      expect(existsSync(o.bundle)).toBe(false)                 // bundle se počisti
      const tm = join(o.home, '.taskmanager')
      const rez = JSON.parse(readFileSync(join(tm, 'log', 'nadogradnja', 'zadnji', 'nadogradnja-rezultat.json'), 'utf-8'))
      expect(rez.ishod).toBe('uspjeh')
      expect(rez.stari_pid).toBe(stariPid)
      expect(rez.novi_pid).not.toBe(stariPid)
      expect(rez.zadataka_prije).toBe('3'); expect(rez.zadataka_poslije).toBe('3')
      const koraci = readFileSync(join(tm, 'log', 'nadogradnja', 'zadnji', 'koraci.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
      expect(koraci.map(k => k.korak)).toEqual(['N1-izvor', 'N2-stanje', 'N3-kopija', 'N4-checkout', 'N5-ovisnosti', 'N6-brana', 'N7-restart', 'N8-provjere'])
      expect(koraci.every(k => k.izlaz === 0)).toBe(true)
      const kopije = readdirSync(join(tm, 'backup', 'nadogradnja'))
      expect(kopije.length).toBe(1)
      const kop = new Database(join(tm, 'backup', 'nadogradnja', kopije[0], 'regoc.db'), { readonly: true })
      expect((kop.query('select count(*) n from tasks').get() as any).n).toBe(3); kop.close()
    } finally { ugasi(o); rmSync(o.k, { recursive: true, force: true }) }
  }, 60_000)

  test('novi proces na drugoj bazi → CVOR PAD (izlaz 1) s razlogom', async () => {
    const o = okruzje('druga-baza')
    try {
      await cekajHttp(o)
      const druga = join(o.k, 'prazna.db'); const d = new Database(druga); d.exec('create table tasks (id text)'); d.close()
      writeFileSync(join(o.k, 'baza.txt'), druga)            // kod nove inačice otvara drugu bazu
      const r = pokreni(o, ['--bundle', o.bundle, '--grana', 'main'])
      expect(r.kod, r.izlaz).toBe(1)
      expect(r.izlaz).toContain('CVOR PAD')
      expect(r.izlaz).toContain(`koristi ${druga}`)
      const rez = JSON.parse(readFileSync(join(o.home, '.taskmanager', 'log', 'nadogradnja', 'zadnji', 'nadogradnja-rezultat.json'), 'utf-8'))
      expect(rez.ishod).toBe('pad')
    } finally { ugasi(o); rmSync(o.k, { recursive: true, force: true }) }
  }, 60_000)

  test('--suho ne mijenja ništa; bundle bez traženog commita → izlaz 12; bez izvora → izlaz 2', async () => {
    const o = okruzje('suho')
    try {
      await cekajHttp(o)
      const pid = readFileSync(join(o.k, 'pid'), 'utf-8')
      const s = pokreni(o, ['--bundle', o.bundle, '--suho'])
      expect(s.kod, s.izlaz).toBe(0)
      expect(s.izlaz).toContain('SUHO: ništa nije promijenjeno')
      expect(o.g(o.cvor, 'rev-parse', 'HEAD')).toBe(o.stari)
      expect(readFileSync(join(o.k, 'pid'), 'utf-8')).toBe(pid)
      expect(existsSync(join(o.home, '.taskmanager', 'log'))).toBe(false)
      o.g(join(o.k, 'izvor'), 'bundle', 'create', '-q', o.bundle, 'main')
      const k = pokreni(o, ['--bundle', o.bundle, '--sha', 'deadbeef'])
      expect(k.kod, k.izlaz).toBe(12)
      expect(pokreni(o, []).kod).toBe(2)
    } finally { ugasi(o); rmSync(o.k, { recursive: true, force: true }) }
  }, 60_000)
})
