/**
 * J12 (GAP_20260924 §5): prazna instalacija, kraj do kraja, bez ijedne postavke.
 *
 *   init (scripts/init-db.ts) → poslužitelj → ploča 200 → POST/GET zadatka → P1 okidač
 *
 * P1 okidač je `auto_queue_p1_tasks` u bazi: zadatak prioriteta 1 sam ulazi u
 * `execution_queue`, bez ijednog poziva osim otvaranja (docs/DATABASE.md, „Okidači").
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

describe('prazna instalacija', () => {
  let p: Posluzitelj | null = null
  beforeAll(async () => { p = await podigni() }, 30_000)
  afterAll(() => spusti(p))

  test('ploča (/) odgovara 200 i nosi HTML', async () => {
    const r = await fetch(`${p!.url}/`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('<html')
  })

  test('prazna baza: /api/tasks je prazan popis', async () => {
    const r = await fetch(`${p!.url}/api/tasks`)
    expect(r.status).toBe(200)
    const d = await r.json() as any
    expect(Array.isArray(d) ? d.length : (d.tasks || []).length).toBe(0)
  })

  test('POST pa GET zadatka; P1 okidač ga stavlja u execution_queue, P3 ne', async () => {
    const otvori = async (priority: number) => {
      const r = await fetch(`${p!.url}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `prioritet ${priority}`, description: 'J12', priority, assignee: 'user' }),
      })
      expect(r.status).toBeLessThan(300)
      const t = await r.json() as any
      return (t.id || t.task?.id) as string
    }
    const p1 = await otvori(1)
    const p3 = await otvori(3)

    const g = await fetch(`${p!.url}/api/tasks/${p1}`)
    expect(g.status).toBe(200)
    const t = await g.json() as any
    expect((t.task || t).title).toBe('prioritet 1')

    const db = new Database(join(p!.dom, 'data', 'tasks.db'), { readonly: true })
    try {
      const red = (db.query('SELECT task_id FROM execution_queue').all() as any[]).map((r) => r.task_id)
      expect(red).toContain(p1)
      expect(red).not.toContain(p3)
    } finally {
      db.close()
    }
  })
}, { timeout: 60_000 })
