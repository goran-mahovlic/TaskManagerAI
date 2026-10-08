/**
 * TASK-5359 — Test dežurnog na ploči ide kroz most U PAKETU (`src/Dezurni.ts`), ne kroz
 * `~/.claude/tools/Telegram/dezurni.ts` glavnog sustava. HOME pokazuje na praznu mapu,
 * pa bi stari put javio „most dežurnog nije na ovom stroju".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

let p: Posluzitelj | null = null
let ollama: ReturnType<typeof Bun.serve> | null = null
let mapa = ''

beforeAll(async () => {
  ollama = Bun.serve({ port: 0, fetch: () => Response.json({ message: { content: 'radi' } }) })
  mapa = mkdtempSync(join(tmpdir(), 'tm-dez-ploca-'))
  writeFileSync(join(mapa, 'dezurni.json'), JSON.stringify({ provider: 'ollama', model: 'qwen3:8b', baseUrl: `http://127.0.0.1:${ollama.port}` }))
  writeFileSync(join(mapa, 'model-config.json'), JSON.stringify({ providers: {} }))
  p = await podigni({}, {
    HOME: mapa,
    TM_DEZURNI_CONFIG: join(mapa, 'dezurni.json'),
    TM_MODEL_CONFIG: join(mapa, 'model-config.json'),
  })
})

afterAll(() => {
  spusti(p)
  ollama?.stop(true)
  if (mapa) rmSync(mapa, { recursive: true, force: true })
})

describe('Test dežurnog na ploči', () => {
  test('POST /api/dezurni/proba → ok (rezervni model stvarno odgovori), bez mosta glavnog sustava', async () => {
    const d = await (await fetch(`${p!.url}/api/dezurni/proba`, { method: 'POST' })).json() as any
    expect(d.greska).toBeUndefined()
    expect(d.ok).toBe(true)
    expect(d.odgovor).toBe('radi')
    expect(d.provider).toBe('ollama')
  })

  test('proba ostavlja red u konzoli razgovora', async () => {
    const log = readFileSync(join(p!.dom, 'data', 'razgovor', 'konzola.log'), 'utf-8')
    expect(log).toMatch(/dežurni.*proba.*RADI/i)
  })

  test('POST /api/dezurni/simuliraj {minuta} → stanje.simulacijaDo; 0 gasi', async () => {
    const r = await fetch(`${p!.url}/api/dezurni/simuliraj`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minuta: 5 }),
    })
    expect(r.status).toBe(200)
    const d = await (await fetch(`${p!.url}/api/dezurni/config`)).json() as any
    expect(Date.parse(d.stanje.simulacijaDo)).toBeGreaterThan(Date.now())
    await fetch(`${p!.url}/api/dezurni/simuliraj`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minuta: 0 }),
    })
    const d2 = await (await fetch(`${p!.url}/api/dezurni/config`)).json() as any
    expect(d2.stanje.simulacijaDo).toBeUndefined()
  })

  test('simuliraj odbija neispravan unos', async () => {
    const r = await fetch(`${p!.url}/api/dezurni/simuliraj`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minuta: 'puno' }),
    })
    expect(r.status).toBe(400)
  })
})
