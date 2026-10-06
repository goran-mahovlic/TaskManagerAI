/**
 * TASK-5287 kraj-do-kraja: obavijest „completed" ide na Telegram JEDNOM.
 *
 * Nalaz QA TASK-5278 (node-A): agent je zatvorio zadatak (PUT status=completed), pa
 * 20 s kasnije poslao isti status uz resultSummary — grupa je dobila dvije iste poruke.
 * Ovdje: pravi poslužitelj ploče, lažni Bot API (`TM_TELEGRAM_API`) koji broji sendMessage.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

const SAZETAK = 'Izmijenjena datoteka src/x.ts, bun test: 3 pass, 0 fail.\nREGOC-STATUS: DONE — isporučeno'

let poslano: string[] = []
let botApi: ReturnType<typeof Bun.serve> | null = null
let p: Posluzitelj | null = null
let cfgDom = ''

const put = (id: string, tijelo: object) => fetch(`${p!.url}/api/tasks/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo),
})

async function noviZadatak(): Promise<string> {
  const r = await fetch(`${p!.url}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'obavijest jednom', description: 'x', assignee: 'user', priority: 3 }),
  })
  const t = await r.json() as any
  const id = t.id || t.task?.id
  expect((await put(id, { status: 'in_progress' })).status).toBe(200)
  return id
}

/** PUT čeka slanje obavijesti; kratka stanka samo kao rezerva da kasni poziv ne promakne. */
const pricekaj = () => Bun.sleep(200)

describe('Telegram obavijest samo na PROMJENU statusa', () => {
  beforeAll(async () => {
    botApi = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url)
        if (u.pathname.endsWith('/sendMessage')) poslano.push(String(((await req.json()) as any).text || ''))
        return Response.json({ ok: true, result: {} })
      },
    })
    // Putanja postavki se čita pri pokretanju ploče — datoteka mora postojati PRIJE podizanja.
    cfgDom = mkdtempSync(join(tmpdir(), 'tm-tg-'))
    const cfg = join(cfgDom, 'telegram.json')
    writeFileSync(cfg, JSON.stringify({ ukljucen: true, chatId: '-100123', obavijestZavrseno: true, obavijestGreska: true }))
    p = await podigni({}, {
      TM_TELEGRAM_API: `http://127.0.0.1:${botApi.port}`,
      TELEGRAM_BOT_TOKEN: 'test-token',
      TM_TELEGRAM_CONFIG: cfg,
    })
  }, 30_000)
  afterAll(() => {
    spusti(p)
    botApi?.stop(true)
    if (cfgDom) rmSync(cfgDom, { recursive: true, force: true })
  })

  test('dva uzastopna PUT completed → točno 1 sendMessage', async () => {
    const id = await noviZadatak()
    poslano = []
    expect((await put(id, { status: 'completed', resultSummary: SAZETAK })).status).toBe(200)
    expect((await put(id, { status: 'completed', resultSummary: SAZETAK + '\nkonačni izvještaj' })).status).toBe(200)
    await pricekaj()
    expect(poslano.length).toBe(1)
    expect(poslano[0]).toContain(id)
  })

  test('PUT bez promjene statusa (samo resultSummary na zatvorenom) ne šalje ništa', async () => {
    const id = await noviZadatak()
    expect((await put(id, { status: 'completed', resultSummary: SAZETAK })).status).toBe(200)
    await pricekaj()
    poslano = []
    expect((await put(id, { resultSummary: SAZETAK + '\ndopuna' })).status).toBe(200)
    await pricekaj()
    expect(poslano.length).toBe(0)
  })
})
