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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const KORIJEN = join(import.meta.dir, '..')
const SAZETAK = 'Izmijenjena datoteka src/x.ts, bun test: 3 pass, 0 fail.\nREGOC-STATUS: DONE — isporučeno'

interface Posluzitelj { url: string; proc: ReturnType<typeof Bun.spawn>; dom: string; najmovi: string }

async function podigni(zastavice: Record<string, boolean>): Promise<Posluzitelj> {
  const dom = mkdtempSync(join(tmpdir(), 'tm-scg-'))
  const najmovi = join(dom, 'najmovi')
  mkdirSync(join(dom, 'config'), { recursive: true })
  const features: Record<string, { enabled: boolean }> = {}
  for (const [k, v] of Object.entries(zastavice)) features[k] = { enabled: v }
  writeFileSync(join(dom, 'config', 'features.json'), JSON.stringify(features))
  const env = {
    ...process.env, TM_HOME: dom, REGOC_SPAWN_LEASE_DIR: najmovi,
    NODE_ENV: 'production', BUN_TEST: '',
  }
  const init = Bun.spawnSync(['bun', 'scripts/init-db.ts'], { cwd: KORIJEN, env })
  if (init.exitCode !== 0) throw new Error(`init-db: ${init.stderr.toString()}`)
  const port = 20000 + Math.floor(Math.random() * 20000)
  const proc = Bun.spawn(['bun', 'src/TaskWebUI.ts'], {
    cwd: KORIJEN, env: { ...env, TM_PORT: String(port), REGOC_TASKWEBUI_PORT: String(port) },
    stdout: 'ignore', stderr: 'ignore',
  })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/api/tasks`)).ok) return { url, proc, dom, najmovi } } catch { /* još se diže */ }
    await Bun.sleep(100)
  }
  proc.kill()
  throw new Error('ploča se nije podigla u 10 s')
}

function spusti(p: Posluzitelj | null) {
  if (!p) return
  p.proc.kill()
  rmSync(p.dom, { recursive: true, force: true })
}

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
