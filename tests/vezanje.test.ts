// TM_BIND (plan Mac v3 P2/P3, R3): ploča na tuđoj Wi-Fi mreži ne smije slušati na 0.0.0.0.
import { describe, expect, test } from 'bun:test'
import { adreseVezanja, zadanaAdresa } from '../src/core/vezanje'
import { podigni, spusti } from './helpers/posluzitelj'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('adreseVezanja', () => {
  test('bez postavke: sva sučelja (postojeće instalacije ne mijenjaju ponašanje)', () => {
    expect(adreseVezanja(undefined).adrese).toEqual(['0.0.0.0'])
    expect(adreseVezanja('  ').adrese).toEqual(['0.0.0.0'])
  })
  test('popis adresa, razmaci, duplikati, localhost i IPv6 u zagradama', () => {
    expect(adreseVezanja(' 127.0.0.1, 100.64.0.7 ,127.0.0.1,localhost,[::1]').adrese)
      .toEqual(['127.0.0.1', '100.64.0.7', '::1'])
  })
  test('neispravan unos se odbacuje, a bez ijedne ispravne ostaje samo petlja (zatvoreno)', () => {
    const v = adreseVezanja('ploca.lokalno,999.1.1.1')
    expect(v.adrese).toEqual(['127.0.0.1'])
    expect(v.odbaceno).toEqual(['ploca.lokalno', '999.1.1.1'])
  })
  test('0.0.0.0 uz druge adrese pokriva sve (inače EADDRINUSE)', () => {
    expect(adreseVezanja('127.0.0.1,0.0.0.0').adrese).toEqual(['0.0.0.0'])
  })
})

// TASK-5686 (S2, pregled K5 TASK-5659): ručni start.sh na Macu bez --cvor slušao je na 0.0.0.0,
// pa je ploča bila vidljiva cijeloj Wi-Fi mreži. Otvoreno smije biti samo izričitim TM_BIND=0.0.0.0.
describe('zadanaAdresa — kad TM_BIND nije postavljen', () => {
  const dom = () => mkdtempSync(join(tmpdir(), 'tm-zadano-'))
  test('macOS: samo petlja, i bez TM_HOME', () => {
    expect(zadanaAdresa('darwin', undefined)).toBe('127.0.0.1')
    expect(adreseVezanja(undefined, zadanaAdresa('darwin', undefined)).adrese).toEqual(['127.0.0.1'])
  })
  test('instalacija paketa ($TM_HOME/config/postavke.env bez TM_BIND): samo petlja i na Linuxu', () => {
    const d = dom()
    try {
      mkdirSync(join(d, 'config'), { recursive: true })
      writeFileSync(join(d, 'config', 'postavke.env'), 'TM_PORT=17790\n')
      expect(zadanaAdresa('linux', d)).toBe('127.0.0.1')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  test('Linux bez postavke.env (postojeći node-A): ponašanje kao prije', () => {
    const d = dom()
    try {
      expect(zadanaAdresa('linux', d)).toBe('0.0.0.0')
      expect(zadanaAdresa('linux', undefined)).toBe('0.0.0.0')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  test('izričit TM_BIND=0.0.0.0 i dalje otvara (node-A ga postavi u svojoj instanci)', () => {
    expect(adreseVezanja('0.0.0.0', zadanaAdresa('darwin', undefined)).adrese).toEqual(['0.0.0.0'])
  })
})

describe('ploča s TM_BIND', () => {
  test('sluša samo na zadanim adresama', async () => {
    // 127.0.0.2 je petlja na Linuxu; na macOS-u postoji samo 127.0.0.1, pa test ondje preskače
    if (process.platform !== 'linux') return
    let p: Awaited<ReturnType<typeof podigni>> | null = null
    try {
      // pomoćnik čeka 200 na 127.0.0.1, zato ga pustimo na obje pa provjerimo drugu ploču niže
      p = await podigni({}, { TM_BIND: '127.0.0.1,127.0.0.2' })
      const port = new URL(p.url).port
      expect((await fetch(`http://127.0.0.2:${port}/health`, { headers: { host: 'localhost' } })).status).toBe(200)
    } finally { spusti(p) }
    const dom = mkdtempSync(join(tmpdir(), 'tm-vezanje-'))
    const port = 20000 + Math.floor(Math.random() * 20000)
    const env = { ...process.env, TM_HOME: dom, TM_BIND: '127.0.0.2', TM_PORT: String(port), REGOC_TASKWEBUI_PORT: String(port), BUN_TEST: '', NODE_ENV: 'production' }
    const korijen = join(import.meta.dir, '..')
    expect(Bun.spawnSync(['bun', 'scripts/init-db.ts'], { cwd: korijen, env }).exitCode).toBe(0)
    const proc = Bun.spawn(['bun', 'src/TaskWebUI.ts'], { cwd: korijen, env, stdout: 'ignore', stderr: 'ignore' })
    try {
      let ok = false
      for (let i = 0; i < 150 && !ok; i++) {
        try { ok = (await fetch(`http://127.0.0.2:${port}/health`, { headers: { host: 'localhost' } })).status === 200 } catch { await Bun.sleep(100) }
      }
      expect(ok).toBe(true)
      let odbijeno = false
      try { await fetch(`http://127.0.0.1:${port}/health`) } catch { odbijeno = true }
      expect(odbijeno).toBe(true)
    } finally { proc.kill(); rmSync(dom, { recursive: true, force: true }) }
  }, 30_000)
})
