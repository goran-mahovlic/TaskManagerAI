/**
 * TASK-5233 (nalaz QA TASK-5219): GET /api/odlucitelj/config je na nodu bez izlaza prema
 * openrouter.ai vraćao PRAZAN odgovor — `openrouterModeli()` je čekao 15 s, a Bun.serve
 * ruši zahtjev nakon 10 s (`idleTimeout`). Rok vanjskog dohvata mora biti kraći od roka
 * poslužitelja, a nedostupan katalog se pamti (negativni keš) da svako otvaranje Configa
 * ne čeka iznova.
 *
 * Katalog glumi lokalni poslužitelj koji ne odgovara 15 s (`TM_OPENROUTER_KATALOG_URL`).
 */
import { describe, test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

let p: Posluzitelj | null = null
let spori: ReturnType<typeof Bun.serve> | null = null
let mapa = ''
let pozivaKataloga = 0

beforeAll(async () => {
  spori = Bun.serve({
    port: 0, idleTimeout: 30,
    async fetch() {
      pozivaKataloga++
      await Bun.sleep(15_000)
      return Response.json({ data: [{ id: 'kasno/model', pricing: { prompt: '0' } }] })
    },
  })
  mapa = mkdtempSync(join(tmpdir(), 'tm-katalog-'))
  const odl = join(mapa, 'odlucitelj.json')
  const dez = join(mapa, 'dezurni.json')
  writeFileSync(odl, JSON.stringify({ ukljucen: false, provider: 'openrouter', model: 'z-ai/glm-4.6' }))
  writeFileSync(dez, JSON.stringify({ provider: 'openrouter', model: 'z-ai/glm-4.6' }))
  p = await podigni({}, {
    TM_OPENROUTER_KATALOG_URL: `http://127.0.0.1:${spori.port}/api/v1/models`,
    TM_ODLUCITELJ_CONFIG: odl, TM_DEZURNI_CONFIG: dez,
  })
})

afterAll(() => {
  spusti(p)
  spori?.stop(true)
  if (mapa) rmSync(mapa, { recursive: true, force: true })
})

async function izmjeri(ruta: string) {
  const t0 = Date.now()
  const r = await fetch(`${p!.url}${ruta}`, { signal: AbortSignal.timeout(12_000) })
  const tijelo = await r.json() as any
  return { status: r.status, ms: Date.now() - t0, tijelo }
}

describe('vanjski katalog modela ima rok kraći od idleTimeouta ploče', () => {
  test('odlučitelj: spori katalog → 200 s dostupno=false prije 10 s', async () => {
    const { status, ms, tijelo } = await izmjeri('/api/odlucitelj/config')
    expect(status).toBe(200)
    expect(ms).toBeLessThan(5_000)
    expect(tijelo.dostupno).toBe(false)
    expect(String(tijelo.greska)).toContain('OpenRouter')
    // Odabrani model ostaje u popisu i kad katalog šuti.
    expect(tijelo.modeli).toContain('z-ai/glm-4.6')
  }, 15_000)

  test('negativni keš: drugi poziv ne čeka katalog iznova', async () => {
    const prije = pozivaKataloga
    const { status, ms, tijelo } = await izmjeri('/api/odlucitelj/config')
    expect(status).toBe(200)
    expect(ms).toBeLessThan(1_000)
    expect(tijelo.dostupno).toBe(false)
    expect(pozivaKataloga).toBe(prije)
  }, 15_000)

  test('dežurni s OpenRouterom: isti rok, odgovor 200', async () => {
    const { status, ms, tijelo } = await izmjeri('/api/dezurni/config')
    expect(status).toBe(200)
    expect(ms).toBeLessThan(5_000)
    expect(tijelo.dostupno).toBe(false)
  }, 15_000)
})
