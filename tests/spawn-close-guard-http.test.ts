/**
 * J4 (GAP_20260924 F4) kraj-do-kraja: pravi poslužitelj ploče, prazna instalacija u
 * privremenom `TM_HOME`, prekidači u `$TM_HOME/config/features.json`.
 *
 *   • agentov PUT `completed` uz AKTIVAN najam spawna → 409 SPAWN_ACTIVE
 *   • isti PUT uz `X-REGOC-Force: 1` (čovjek s ploče) → prolazi
 *   • bez najma → dosadašnje ponašanje (200)
 *   • prekidači isključeni → guard ne postoji ni uz najam (zadano stanje paketa)
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

const SAZETAK = 'Izmijenjena datoteka src/x.ts, bun test: 3 pass, 0 fail.\nREGOC-STATUS: DONE — isporučeno'

import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

async function zadatakURadu(p: Posluzitelj): Promise<string> {
  const r = await fetch(`${p.url}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'guard e2e', description: 'x', assignee: 'user', priority: 3 }),
  })
  expect(r.status).toBeLessThan(300)
  const t = await r.json() as any
  const id = t.id || t.task?.id
  const u = await fetch(`${p.url}/api/tasks/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'in_progress' }),
  })
  expect(u.status).toBe(200)
  return id
}

function uzmiNajam(p: Posluzitelj, taskId: string) {
  mkdirSync(p.najmovi, { recursive: true })
  // pid ovog procesa: živ dok test traje — upravo ono što guard traži u /proc.
  writeFileSync(join(p.najmovi, `${taskId}.json`),
    JSON.stringify({ taskId, agent: 'agent', pid: process.pid, startedAt: new Date().toISOString() }))
}

const zatvori = (p: Posluzitelj, id: string, zaglavlja: Record<string, string> = {}) =>
  fetch(`${p.url}/api/tasks/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...zaglavlja },
    body: JSON.stringify({ status: 'completed', resultSummary: SAZETAK }),
  })

describe('spawnCloseGuard uživo (oba prekidača uključena)', () => {
  let p: Posluzitelj | null = null
  beforeAll(async () => { p = await podigni({ spawnCloseGuard: true, spawnCloseGuardLive: true }) }, 30_000)
  afterAll(() => spusti(p))

  test('aktivan najam → 409 SPAWN_ACTIVE, zadatak ostaje in_progress', async () => {
    const id = await zadatakURadu(p!)
    uzmiNajam(p!, id)
    const r = await zatvori(p!, id)
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).code).toBe('SPAWN_ACTIVE')
    const t = await (await fetch(`${p!.url}/api/tasks/${id}`)).json() as any
    expect((t.task || t).status).toBe('in_progress')
  })

  test('X-REGOC-Force: 1 (čovjek s ploče) prolazi i uz najam', async () => {
    const id = await zadatakURadu(p!)
    uzmiNajam(p!, id)
    const r = await zatvori(p!, id, { 'X-REGOC-Force': '1' })
    expect(r.status).toBe(200)
  })

  test('bez najma → dosadašnje ponašanje (200)', async () => {
    const id = await zadatakURadu(p!)
    const r = await zatvori(p!, id)
    expect(r.status).toBe(200)
  })

  test('najam s mrtvim pidom je fail-open (200)', async () => {
    const id = await zadatakURadu(p!)
    uzmiNajam(p!, id)
    unlinkSync(join(p!.najmovi, `${id}.json`))
    writeFileSync(join(p!.najmovi, `${id}.json`),
      JSON.stringify({ taskId: id, agent: 'agent', pid: 2 ** 22 + 7, startedAt: new Date().toISOString() }))
    expect((await zatvori(p!, id)).status).toBe(200)
  })
}, { timeout: 60_000 })

describe('zadano stanje paketa (prekidači isključeni)', () => {
  let p: Posluzitelj | null = null
  beforeAll(async () => { p = await podigni({}) }, 30_000)
  afterAll(() => spusti(p))

  test('ni uz aktivan najam guard ne odbija', async () => {
    const id = await zadatakURadu(p!)
    uzmiNajam(p!, id)
    expect((await zatvori(p!, id)).status).toBe(200)
  })
}, { timeout: 60_000 })
