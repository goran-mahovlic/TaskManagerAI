/**
 * TASK-5311 (prijenos s glavnog, TASK-5164 D): rute ploče za bilješku, doradu i ponovno
 * otvaranje te JSON 404 s prijedlogom za nepoznatu podrutu zadatka — e2e nad pravom pločom.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

let p: Posluzitelj | null = null
beforeAll(async () => { p = await podigni() }, 30_000)
afterAll(() => spusti(p))

const post = (put: string, tijelo: unknown) => fetch(`${p!.url}${put}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo),
})
const put = (id: string, tijelo: unknown) => fetch(`${p!.url}/api/tasks/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo),
})

async function zatvoren(): Promise<string> {
  const r = await post('/api/tasks', { title: 'isporuka', description: 'opis isporuke', priority: 3, assignee: 'inzenjer' })
  const { id } = await r.json() as { id: string }
  await put(id, { status: 'in_progress' })
  const z = await put(id, { status: 'completed', resultSummary: 'gotovo' })
  expect(((await z.json()) as any).status).toBe('completed')
  return id
}

describe('POST /api/tasks/:id/biljeska (alias /notes)', () => {
  test('dodaje bilješku bez promjene statusa', async () => {
    const r = await post('/api/tasks', { title: 'b', description: 'b', priority: 3 })
    const { id, status } = await r.json() as { id: string; status: string }
    const b = await post(`/api/tasks/${id}/notes`, { text: 'prva bilješka', author: 'revizor' })
    expect(b.status).toBe(200)
    const t = await b.json() as any
    expect(t.status).toBe(status)
    expect(t.progressNotes.at(-1)).toMatchObject({ agent: 'revizor', note: 'prva bilješka' })
    expect((await post(`/api/tasks/${id}/biljeska`, {})).status).toBe(400)
    expect((await post('/api/tasks/TASK-99999/biljeska', { text: 'x' })).status).toBe(404)
  })
})

describe('POST /api/tasks/:id/dorada', () => {
  test('zatvoren zadatak → 201 novi zadatak, izvorni ostaje completed s oznakom ima-doradu', async () => {
    const id = await zatvoren()
    const r = await post(`/api/tasks/${id}/dorada`, { razlog: 'fali test', author: 'revizor' })
    expect(r.status).toBe(201)
    const d = await r.json() as any
    expect(d.id).not.toBe(id)
    const iz = await (await fetch(`${p!.url}/api/tasks/${id}`)).json() as any
    expect(iz.status).toBe('completed')
    expect(iz.tags).toContain('ima-doradu')
  })

  test('bez razloga/autora 400; zadatak koji nije zatvoren 409', async () => {
    const id = await zatvoren()
    expect((await post(`/api/tasks/${id}/dorada`, { razlog: 'x' })).status).toBe(400)
    const r = await post('/api/tasks', { title: 'otvoren', description: 'o', priority: 3 })
    const { id: otv } = await r.json() as { id: string }
    expect((await post(`/api/tasks/${otv}/dorada`, { razlog: 'x', author: 'y' })).status).toBe(409)
  })
})

describe('POST /api/tasks/:id/ponovno-otvori', () => {
  test('completed → pending; otvoren zadatak 409', async () => {
    const id = await zatvoren()
    const r = await post(`/api/tasks/${id}/ponovno-otvori`, { razlog: 'zatvoren greškom', by: 'vlasnik' })
    expect(r.status).toBe(200)
    expect((await r.json() as any).status).toBe('pending')
    expect((await post(`/api/tasks/${id}/ponovno-otvori`, { razlog: 'opet', by: 'vlasnik' })).status).toBe(409)
  })
})

describe('nepoznata podruta zadatka → JSON 404 s prijedlogom', () => {
  test('/comment → mislio_si /biljeska, popis dostupnih ruta s pravim ID-em', async () => {
    const r = await post('/api/tasks/TASK-7/comment', { text: 'x' })
    expect(r.status).toBe(404)
    const b = await r.json() as any
    expect(b.mislio_si).toBe('POST /api/tasks/TASK-7/biljeska')
    expect(b.dostupno).toContain('POST /api/tasks/TASK-7/dorada')
  })
})
