/**
 * TASK-5184: ploča na mobitelu — /api/tasks je slao 9,4 MB svakih 30 s.
 * Ugovor modula PlocaPromet: projekcija za kartice, samo zadnjih N zatvorenih,
 * inkrementalno (since), straničenje, brojači nad SVIM zadacima i kompresija.
 */
import { describe, test, expect } from 'bun:test'
import { gunzipSync } from 'zlib'
import {
  POLJA_PLOCE, zaPlocu, vrijemeMs, izborZaPlocu, parsirajOpcijePloce,
  komprimirajOdgovor, saziProjekteDashboarda,
} from '../src/PlocaPromet'

function zad(id: number, status: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id: `TASK-${id}`, title: `Naslov ${id}`, status, priority: 2, assignee: 'jelena',
    projectId: 'PRJ-048', tags: [], blockedBy: [], blocks: [], createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt, completedAt: status === 'completed' ? updatedAt : undefined,
    description: 'x'.repeat(5000), resultSummary: 'y'.repeat(5000), progressNotes: ['z'.repeat(500)],
    blockedReason: 'razlog', ...extra,
  }
}

describe('zaPlocu — projekcija za kartice', () => {
  test('izbacuje teška polja koja kartica ne crta (opis, rezultat, bilješke)', () => {
    const p = zaPlocu(zad(1, 'pending', '2026-10-03T10:00:00.000Z'))
    expect(p.description).toBeUndefined()
    expect(p.resultSummary).toBeUndefined()
    expect(p.progressNotes).toBeUndefined()
    expect(p.blockedReason).toBeUndefined()
  })
  test('zadržava sve što renderTasks/updateStats/lanacInfo čitaju', () => {
    for (const k of ['id', 'title', 'status', 'priority', 'assignee', 'projectId', 'paused', 'tags', 'blockedBy', 'blocks', 'progressPercent', 'startedAt', 'updatedAt', 'completedAt']) {
      expect(POLJA_PLOCE).toContain(k)
    }
    const p = zaPlocu(zad(2, 'blocked', '2026-10-03T10:00:00.000Z', { paused: true, progressPercent: 40 }))
    expect(p).toMatchObject({ id: 'TASK-2', status: 'blocked', paused: true, progressPercent: 40, priority: 2 })
  })
})

describe('vrijemeMs — baza piše dva oblika istog trenutka', () => {
  test("'…T11:07:02.561Z' i '… 11:07:02' su isti UTC trenutak (do sekunde)", () => {
    expect(vrijemeMs('2026-10-03 11:07:02')).toBe(Date.parse('2026-10-03T11:07:02Z'))
    expect(vrijemeMs('2026-10-03T11:07:02.561Z')).toBe(Date.parse('2026-10-03T11:07:02.561Z'))
  })
  test('prazno/neispravno = 0, ne NaN', () => {
    expect(vrijemeMs(undefined)).toBe(0)
    expect(vrijemeMs('nije datum')).toBe(0)
  })
})

describe('izborZaPlocu', () => {
  const svi = [
    zad(1, 'completed', '2026-09-01T10:00:00.000Z'),
    zad(2, 'completed', '2026-10-03T09:00:00.000Z'),
    zad(3, 'cancelled', '2026-10-02T09:00:00.000Z'),
    zad(4, 'pending', '2026-08-01T09:00:00.000Z'),
    zad(5, 'in_progress', '2026-10-03 10:00:00'),
    zad(6, 'blocked', '2026-07-01T09:00:00.000Z'),
  ]
  const sada = Date.parse('2026-10-03T12:00:00Z')

  test('svi otvoreni uvijek, zatvoreni samo zadnjih N po aktivnosti', () => {
    const r = izborZaPlocu(svi, { zatvorenih: 1, sada })
    expect(r.tasks.map(t => t.id).sort()).toEqual(['TASK-2', 'TASK-4', 'TASK-5', 'TASK-6'])
  })
  test('brojači i ukupno broje SVE zadatke, ne samo poslane', () => {
    const r = izborZaPlocu(svi, { zatvorenih: 0, sada })
    expect(r.ukupno).toBe(6)
    expect(r.counts).toEqual({ completed: 2, cancelled: 1, pending: 1, in_progress: 1, blocked: 1 })
  })
  test('since vraća samo promijenjene (uz preklop od par sekundi zbog sekundne točnosti baze)', () => {
    const r = izborZaPlocu(svi, { zatvorenih: 100, since: '2026-10-03T10:00:03.500Z', sada })
    // TASK-5: '2026-10-03 10:00:00' (bez milisekundi) pada u preklop; TASK-2 u 09:00 ne.
    expect(r.tasks.map(t => t.id)).toEqual(['TASK-5'])
    expect(r.inkrementalno).toBe(true)
  })
  test('serverTime je trenutak upita, klijent ga vraća kao sljedeći since', () => {
    const r = izborZaPlocu(svi, { sada })
    expect(r.serverTime).toBe('2026-10-03T12:00:00.000Z')
  })
  test('straničenje: offset/limit nad poretkom najnovije prvo + imaJos', () => {
    const p1 = izborZaPlocu(svi, { zatvorenih: 100, limit: 2, sada })
    expect(p1.tasks.map(t => t.id)).toEqual(['TASK-5', 'TASK-2'])
    expect(p1.imaJos).toBe(true)
    const p3 = izborZaPlocu(svi, { zatvorenih: 100, limit: 2, offset: 4, sada })
    expect(p3.tasks.map(t => t.id)).toEqual(['TASK-4', 'TASK-6'])
    expect(p3.imaJos).toBe(false)
  })
  test('poslani zadaci su projicirani (nema opisa ni rezultata)', () => {
    const r = izborZaPlocu(svi, { sada })
    expect(r.tasks.every(t => t.description === undefined && t.resultSummary === undefined)).toBe(true)
  })
})

describe('parsirajOpcijePloce', () => {
  test('bez view=board nema promjene (stari klijenti dobiju puni niz)', () => {
    expect(parsirajOpcijePloce(new URL('http://x/api/tasks'))).toBeNull()
  })
  test('čita zatvorenih/since/offset/limit i ograničava ih', () => {
    const o = parsirajOpcijePloce(new URL('http://x/api/tasks?view=board&zatvorenih=99999&limit=-3&offset=5&since=2026-10-03T10:00:00Z'))
    expect(o).toEqual({ zatvorenih: 2000, limit: undefined, offset: 5, since: '2026-10-03T10:00:00Z' })
  })
  test('zadano 150 zatvorenih', () => {
    expect(parsirajOpcijePloce(new URL('http://x/api/tasks?view=board'))?.zatvorenih).toBe(150)
  })
})

describe('komprimirajOdgovor', () => {
  const velik = JSON.stringify({ a: 'ploca '.repeat(2000) })
  const req = (ae?: string) => new Request('http://x/api/tasks', { headers: ae ? { 'Accept-Encoding': ae } : {} })

  test('gzip kad ga klijent prihvaća; tijelo se raspakira u isti JSON', async () => {
    const r = await komprimirajOdgovor(req('gzip, deflate'), new Response(velik, { headers: { 'Content-Type': 'application/json' } }))
    expect(r.headers.get('Content-Encoding')).toBe('gzip')
    expect(r.headers.get('Vary')).toContain('Accept-Encoding')
    const buf = new Uint8Array(await r.arrayBuffer())
    expect(buf.length).toBeLessThan(velik.length / 10)
    expect(gunzipSync(buf).toString()).toBe(velik)
  })
  test('br ima prednost kad je ponuđen (HTTPS preglednici)', async () => {
    const r = await komprimirajOdgovor(req('gzip, br'), new Response(velik, { headers: { 'Content-Type': 'application/json' } }))
    expect(r.headers.get('Content-Encoding')).toBe('br')
  })
  test('bez Accept-Encoding (curl, urllib) odgovor ostaje netaknut', async () => {
    const r = await komprimirajOdgovor(req(), new Response(velik, { headers: { 'Content-Type': 'application/json' } }))
    expect(r.headers.get('Content-Encoding')).toBeNull()
    expect(await r.text()).toBe(velik)
  })
  test('mali odgovor, SSE i već kodiran odgovor se ne diraju', async () => {
    const mali = await komprimirajOdgovor(req('gzip'), new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }))
    expect(mali.headers.get('Content-Encoding')).toBeNull()
    const sse = await komprimirajOdgovor(req('gzip'), new Response(velik, { headers: { 'Content-Type': 'text/event-stream' } }))
    expect(sse.headers.get('Content-Encoding')).toBeNull()
    const vec = await komprimirajOdgovor(req('gzip'), new Response(velik, { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' } }))
    expect(vec.headers.get('Content-Encoding')).toBe('identity')
  })
  test('HTML ploče se komprimira, status i ostala zaglavlja ostaju', async () => {
    const r = await komprimirajOdgovor(req('gzip'), new Response('<html>' + 'x'.repeat(5000), { status: 201, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Ostalo': '1' } }))
    expect(r.status).toBe(201)
    expect(r.headers.get('X-Ostalo')).toBe('1')
    expect(r.headers.get('Content-Encoding')).toBe('gzip')
  })
  test('undefined (WS upgrade) prolazi kao undefined', async () => {
    expect(await komprimirajOdgovor(req('gzip'), undefined)).toBeUndefined()
  })
})

describe('saziProjekteDashboarda', () => {
  test('izbacuje specifikaciju i opis, ostavlja id/name/postotak', () => {
    const r = saziProjekteDashboarda([{ id: 'PRJ-1', name: 'A', calculated_progress: 40, status: 'active', specification: 's'.repeat(9000), description: 'd'.repeat(900) }])
    expect(r[0]).toEqual({ id: 'PRJ-1', name: 'A', calculated_progress: 40, status: 'active' })
  })
})
