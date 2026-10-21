/**
 * TASK-5693 (QA K6 TASK-5660, B1 i B2): scripts/start.sh.
 *
 *   B1 — start.sh je gasio BILO KOJI proces na vratima (kill pa kill -9). 21.10. probna
 *        instalacija u praznom HOME-u ugasila je živu ploču izvornog sustava na istom stroju.
 *        Sad gasi samo ploču IZ OVOG paketa (radna mapa procesa = paket), inače izlaz ≠ 0.
 *   B2 — start.sh je čitao <paket>/config/postavke.env, a install.sh i README pišu
 *        $TM_HOME/config/postavke.env. Sad postavke idu kroz s-okolinom.sh (isti red kao usluga).
 *
 * „Ploča" je ovdje mali HTTP poslužitelj (Bun.serve) — test ne diže pravu ploču.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const KORIJEN = join(import.meta.dir, '..')
const BUN_DIR = dirname(process.execPath)
const radna = () => process.env.TMPDIR || tmpdir()
mkdirSync(radna(), { recursive: true })

const slobodnaVrata = () => 30000 + Math.floor(Math.random() * 20000)

/** Proces koji sluša na vratima iz zadane radne mape; čeka dok vrata ne prime vezu. */
async function slusatelj(vrata: number, cwd: string) {
  const p = Bun.spawn([process.execPath, '-e', `Bun.serve({ port: ${vrata}, hostname: '127.0.0.1', fetch: () => new Response('tudji') }); setInterval(() => {}, 1e6)`], { cwd, stdout: 'ignore', stderr: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${vrata}/`); return p } catch { await Bun.sleep(100) }
  }
  p.kill(); throw new Error(`slušatelj na ${vrata} nije krenuo`)
}
const ziv = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

function okruzje() {
  const korijen = mkdtempSync(join(radna(), 'tm-start-'))
  const home = join(korijen, 'home'), tm = join(home, '.taskmanager'), tudja = join(korijen, 'tudja-ploca')
  mkdirSync(join(tm, 'config'), { recursive: true }); mkdirSync(tudja, { recursive: true })
  return { korijen, home, tm, tudja }
}
/**
 * TM_PORT u okolini je MAMAC (prazna slučajna vrata): skripta koja ne čita postavke čvora ne smije
 * pasti na zadana 17781 — RED prolaz ovog testa protiv starog start.sh-a 21.10. ugasio je pravu
 * ploču na 17781 (upravo kvar B1). Postavke čvora imaju prednost pred okolinom (kao u usluzi).
 */
function start(o: ReturnType<typeof okruzje>, argv: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', join(KORIJEN, 'scripts/start.sh'), ...argv], {
    cwd: o.korijen,
    env: { HOME: o.home, PATH: `${BUN_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'C.UTF-8', TMPDIR: join(o.korijen), TM_LOG: join(o.korijen, 'ploca.log'), TM_PORT: String(slobodnaVrata()), ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
}

describe('start.sh — B1: gasi samo ploču iz ovog paketa', () => {
  test('tuđi proces na vratima preživi start.sh (izlaz ≠ 0, poruka s PID-om)', async () => {
    const o = okruzje(), vrata = slobodnaVrata()
    const tudji = await slusatelj(vrata, o.tudja)
    try {
      const r = start(o, [String(vrata)])
      expect(r.kod, r.izlaz).not.toBe(0)
      expect(r.izlaz).toContain(`PID ${tudji.pid}`)
      expect(r.izlaz).toContain('ne diram')
      expect(ziv(tudji.pid)).toBe(true)
      expect(await (await fetch(`http://127.0.0.1:${vrata}/`)).text()).toBe('tudji')
    } finally { tudji.kill(); rmSync(o.korijen, { recursive: true, force: true }) }
  }, 30_000)

  test('--stani: tuđi proces ostaje, izlaz ≠ 0', async () => {
    const o = okruzje(), vrata = slobodnaVrata()
    const tudji = await slusatelj(vrata, o.tudja)
    try {
      const r = start(o, ['--stani', String(vrata)])
      expect(r.kod, r.izlaz).not.toBe(0)
      expect(ziv(tudji.pid)).toBe(true)
    } finally { tudji.kill(); rmSync(o.korijen, { recursive: true, force: true }) }
  }, 30_000)

  test('--stani: ploča iz OVOG paketa (cwd = paket) se zaustavlja', async () => {
    const o = okruzje(), vrata = slobodnaVrata()
    const nasa = await slusatelj(vrata, KORIJEN)
    try {
      const r = start(o, ['--stani', String(vrata)])
      expect(r.kod, r.izlaz).toBe(0)
      await nasa.exited
      expect(ziv(nasa.pid)).toBe(false)
    } finally { nasa.kill(); rmSync(o.korijen, { recursive: true, force: true }) }
  }, 30_000)
})

describe('start.sh — B2: postavke iz $TM_HOME/config/postavke.env (kao usluga)', () => {
  test('TM_PORT iz $TM_HOME/config/postavke.env poštovan (bez argumenta vrata)', async () => {
    const o = okruzje(), vrata = slobodnaVrata()
    writeFileSync(join(o.tm, 'config', 'postavke.env'), `TM_PORT=${vrata}\n`)
    const nasa = await slusatelj(vrata, KORIJEN)
    try {
      const r = start(o, ['--stani'])
      expect(r.kod, r.izlaz).toBe(0)
      expect(r.izlaz).toContain(`vratima ${vrata}`)
      await nasa.exited
      expect(ziv(nasa.pid)).toBe(false)
    } finally { nasa.kill(); rmSync(o.korijen, { recursive: true, force: true }) }
  }, 30_000)

  test('izričit TM_HOME: postavke.env iz njega, vrata bez ičega na njima → „nema ploče"', () => {
    const o = okruzje(), vrata = slobodnaVrata()
    const drugi = join(o.korijen, 'drugi-tm')
    mkdirSync(join(drugi, 'config'), { recursive: true })
    writeFileSync(join(drugi, 'config', 'postavke.env'), `TM_PORT=${vrata}\n`)
    try {
      const r = start(o, ['--stani'], { TM_HOME: drugi })
      expect(r.kod, r.izlaz).toBe(0)
      expect(r.izlaz).toContain(`vratima ${vrata}`)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 30_000)
})
