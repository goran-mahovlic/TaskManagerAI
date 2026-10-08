// TASK-5352 (ADR-0007, nalaz QA TASK-5344) — kraj-do-kraja na pravom poslužitelju ploče.
// Napad iz nalaza: POST /api/konzola/exec s LAN-a bez prijave → `cat …/credentials.env`.
// Kanarinac iz spremišta ne smije izaći ni u jednom odgovoru, ni s LAN-a ni s localhosta.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { networkInterfaces } from 'os'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

const KANARINAC = 'KonzKan4r' + Math.random().toString(36).slice(2)
let p: Posluzitelj | null = null
const odgovori: string[] = []

/** Prva ne-loopback IPv4 adresa stroja — peer s nje ploči izgleda kao LAN. */
const lanIp = Object.values(networkInterfaces()).flat()
  .find(a => a && a.family === 'IPv4' && !a.internal && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))?.address

async function exec(baza: string, command: string, zag: Record<string, string> = { 'Content-Type': 'application/json', 'X-TM-Konzola': '1' }, put = '/api/konzola/exec') {
  const r = await fetch(baza + put, { method: 'POST', headers: zag, body: JSON.stringify(put.endsWith('mode') ? { mode: command } : { command }) })
  const t = await r.text()
  odgovori.push(t)
  let j: any = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, j }
}

beforeAll(async () => {
  p = await podigni({}, {}, {
    priprema: dom => {
      mkdirSync(join(dom, 'config'), { recursive: true })
      writeFileSync(join(dom, 'config', 'credentials.env'), `TELEGRAM_BOT_TOKEN='${KANARINAC}'\n`)
    },
  })
}, 30_000)

afterAll(() => spusti(p))

describe('E2E /api/konzola/exec — ADR-0007', () => {
  test('localhost + X-TM-Konzola: whoami radi (konzola nije pokvarena)', async () => {
    const r = await exec(p!.url, 'whoami')
    expect(r.status).toBe(200)
    expect(r.j.exitCode).toBe(0)
  })

  test('localhost bez X-TM-Konzola (stari klijent / CSRF) → 403', async () => {
    const r = await exec(p!.url, 'whoami', { 'Content-Type': 'application/json' })
    expect(r.status).toBe(403)
    expect(r.j.greska).toBe('konzola_csrf')
    const t = await exec(p!.url, 'whoami', { 'Content-Type': 'text/plain', 'X-TM-Konzola': '1' })
    expect(t.status).toBe(403)
  })

  test('LAN peer → 403 i za whoami i za mode (napad iz nalaza zatvoren)', async () => {
    expect(lanIp).toBeTruthy()
    const lan = p!.url.replace('127.0.0.1', lanIp!)
    const w = await exec(lan, 'whoami')
    expect(w.status).toBe(403)
    expect(w.j.greska).toBe('konzola_prijenos_lan-http')
    const c = await exec(lan, `cat ${join(p!.dom, 'config', 'credentials.env')}`)
    expect(c.status).toBe(403)
    const m = await exec(lan, 'work', undefined, '/api/konzola/mode')
    expect(m.status).toBe(403)
  })

  test('ni s localhosta: cat/grep/tail/head/find, ps e, wc nad spremištem, /proc/*/environ → 403', async () => {
    const sp = join(p!.dom, 'config', 'credentials.env')
    for (const c of [`cat ${sp}`, `grep TOKEN ${sp}`, `tail ${sp}`, `head ${sp}`, `find ${p!.dom} -name credentials.env`,
      'ps eww', `ls /proc/${p!.proc.pid}/environ`, `git diff --no-index /dev/null ${sp}`]) {
      const r = await exec(p!.url, c)
      expect([c, r.status]).toEqual([c, 403])
    }
    // work način ne otvara čitače
    expect((await exec(p!.url, 'work', undefined, '/api/konzola/mode')).status).toBe(200)
    expect((await exec(p!.url, `cat ${sp}`)).status).toBe(403)
    expect((await exec(p!.url, 'plan', undefined, '/api/konzola/mode')).status).toBe(200)
  })

  test('kanarinac nije ni u jednom odgovoru', () => {
    expect(odgovori.length).toBeGreaterThan(10)
    for (const t of odgovori) expect(t).not.toContain(KANARINAC)
  })
})
