/**
 * J5b (GAP_20260924 F5): prikaz agentova rezultata na ploči.
 *
 *   • GET /api/tasks/:id nosi `resultParsed` — sud se donosi na POSLUŽITELJU, istim
 *     parserom kao kanali; `resultSummary` ostaje netaknut („prikaži sirovo").
 *   • bedž slijedi status zadatka; tekst ga smije samo suziti, nikad podići.
 *   • sigurnosni ugovor: blok koji crta rezultat ne koristi innerHTML (agentov tekst
 *     je podatak, ne oznake) — ulaz `http://x"onmouseover="…` ne smije postati atribut.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

const IZVOR_PLOCE = readFileSync(join(import.meta.dir, '..', 'src', 'TaskWebUI.ts'), 'utf-8')

function blokPrikaza(): string {
  const od = IZVOR_PLOCE.indexOf('/* ─── TASK-4815: prikaz agentova rezultata')
  const doKraja = IZVOR_PLOCE.indexOf('TASK-3512: projekt zadatka — prikaz imena', od)
  expect(od).toBeGreaterThan(0)
  expect(doKraja).toBeGreaterThan(od)
  return IZVOR_PLOCE.slice(od, doKraja)
}

describe('sigurnosni ugovor prikaza (statički)', () => {
  test('blok prikaza nema nijedno dodjeljivanje innerHTML', () => {
    // Komentari smiju spominjati innerHTML (ugovor ga imenuje); kod ga ne smije koristiti.
    const kod = blokPrikaza().split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect(kod).not.toMatch(/\.innerHTML\s*=/)
    expect(kod).not.toMatch(/insertAdjacentHTML|outerHTML\s*=/)
  })

  test('kartica poziva renderResultSummary, a ne lijepi tekst u HTML', () => {
    expect(IZVOR_PLOCE).toContain('renderResultSummary(task);')
    expect(IZVOR_PLOCE).not.toContain("rsBox.innerHTML = out;")
  })
})

describe('GET /api/tasks/:id — resultParsed s poslužitelja', () => {
  let p: Posluzitelj | null = null
  beforeAll(async () => { p = await podigni() }, 30_000)
  afterAll(() => spusti(p))

  async function zadatak(tijelo: Record<string, unknown>): Promise<string> {
    const r = await fetch(`${p!.url}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'prikaz', description: 'x', assignee: 'user', priority: 3, ...tijelo }),
    })
    const t = await r.json() as any
    return t.id || t.task?.id
  }
  const dohvati = async (id: string) => {
    const t = await (await fetch(`${p!.url}/api/tasks/${id}`)).json() as any
    return t.task || t
  }

  test('zadatak bez rezultata → resultParsed je null', async () => {
    const t = await dohvati(await zadatak({}))
    expect(t.resultParsed).toBeNull()
  })

  test('rezultat s REGOC-STATUS → parsiran sud uz netaknut sirovi tekst', async () => {
    const id = await zadatak({})
    const sirovo = '📋 REZULTAT: popravljeno\n📊 STATUS: gotovo\n'
      + 'Link: http://x"onmouseover="alert(1)\nREGOC-STATUS: BLOCKED — nedostaje pristup'
    const u = await fetch(`${p!.url}/api/tasks/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultSummary: sirovo }),
    })
    expect(u.status).toBe(200)
    const t = await dohvati(id)
    expect(t.resultSummary).toBe(sirovo)
    expect(t.resultParsed).toBeTruthy()
    expect(typeof t.resultParsed.badge).toBe('string')
    // Zadatak je `pending`, a tekst tvrdi BLOCKED: tekst smije suziti, ploča ostaje mjerodavna.
    expect(JSON.stringify(t.resultParsed)).not.toContain('<a ')
  })
}, { timeout: 60_000 })
