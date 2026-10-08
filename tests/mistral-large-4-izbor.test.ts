/**
 * TASK-5351: Mistral Large 4 (`mistralai/mistral-large-4-0`, OpenRouter) mora biti izbor
 * na SVAKOM mjestu gdje ploča nudi model — model po agentu i „prebaci sve" (/api/models/available),
 * dežurni i odlučitelj (živi katalog OpenRoutera) — ali NE kao zadani.
 *
 * Zamka koju test čuva: dežurni reže katalog na 60 najjeftinijih, a Mistral Large 4
 * (0,68 $/M) u katalogu od 400+ modela tamo ne stigne — bez isticanja ga ploča ne bi nudila.
 */
import { describe, test, expect, afterAll, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'
import { MISTRAL_LARGE_4, ISTAKNUTI_OPENROUTER, istaknutiNaVrh } from '../src/core/models/IstaknutiModeli'
import { POZNATI_MODELI_DEZURNI, zadaniModelZa } from '../src/DezurniConfig'

describe('istaknuti OpenRouter modeli (čiste funkcije)', () => {
  test('ID je Mistral Large 4, ne starija 2512/2407', () => {
    expect(MISTRAL_LARGE_4).toBe('mistralai/mistral-large-4-0')
    expect(ISTAKNUTI_OPENROUTER.map(m => m.model)).toContain(MISTRAL_LARGE_4)
  })

  test('istaknuti ide iza auto-rutera, bez duplikata', () => {
    const k = ['openrouter/auto', 'jeftin/a', MISTRAL_LARGE_4, 'skup/b']
    expect(istaknutiNaVrh(k)).toEqual(['openrouter/auto', MISTRAL_LARGE_4, 'jeftin/a', 'skup/b'])
  })

  test('nedostupan katalog (nod bez izlaza): istaknuti se i dalje nudi', () => {
    expect(istaknutiNaVrh([])).toEqual(ISTAKNUTI_OPENROUTER.map(m => m.model))
  })

  test('dežurni: poznat model, ali nije zadani', () => {
    expect(POZNATI_MODELI_DEZURNI.openrouter).toContain(MISTRAL_LARGE_4)
    expect(zadaniModelZa('openrouter')).not.toBe(MISTRAL_LARGE_4)
  })
})

let p: Posluzitelj | null = null
let katalog: ReturnType<typeof Bun.serve> | null = null
let mapa = ''

beforeAll(async () => {
  // 120 jeftinijih modela ispred Mistrala — dežurnikov rez na 60 ga bez isticanja izbaci.
  const data = Array.from({ length: 120 }, (_, i) => ({ id: `jeftin/m${i}`, pricing: { prompt: String(0.0000001 + i * 1e-9) } }))
  data.push({ id: MISTRAL_LARGE_4, pricing: { prompt: '0.00000068' } })
  katalog = Bun.serve({ port: 0, fetch: () => Response.json({ data }) })
  mapa = mkdtempSync(join(tmpdir(), 'tm-mistral-'))
  const mc = join(mapa, 'model-config.json')
  writeFileSync(mc, JSON.stringify({
    providers: { openrouter: { enabled: true, apiKey: 'env:OPENROUTER_API_KEY' } },
    defaults: { strong: 'anthropic:sonnet' }, agentOverrides: {},
  }))
  writeFileSync(join(mapa, 'odlucitelj.json'), JSON.stringify({ ukljucen: false, provider: 'openrouter', model: 'z-ai/glm-4.6' }))
  writeFileSync(join(mapa, 'dezurni.json'), JSON.stringify({ provider: 'openrouter', model: 'z-ai/glm-4.6' }))
  p = await podigni({}, {
    TM_OPENROUTER_KATALOG_URL: `http://127.0.0.1:${katalog.port}/api/v1/models`,
    TM_MODEL_CONFIG: mc,
    TM_ODLUCITELJ_CONFIG: join(mapa, 'odlucitelj.json'),
    TM_DEZURNI_CONFIG: join(mapa, 'dezurni.json'),
  })
})

afterAll(() => {
  spusti(p)
  katalog?.stop(true)
  if (mapa) rmSync(mapa, { recursive: true, force: true })
})

const dohvati = async (ruta: string) => (await fetch(`${p!.url}${ruta}`)).json() as Promise<any>

describe('Mistral Large 4 u svakom izborniku ploče', () => {
  const SPEC = `openrouter:${MISTRAL_LARGE_4}`

  test('model po agentu i „prebaci sve": /api/models/available', async () => {
    const d = await dohvati('/api/models/available')
    const m = d.models.find((x: any) => x.spec === SPEC)
    expect(m).toBeTruthy()
    expect(m.spawnable).toBe(true)       // „prebaci sve" nudi samo spawnable
    expect(m.label).toContain('Mistral Large 4')
  })

  test('dežurni: Mistral u popisu i kad je izvan 60 najjeftinijih', async () => {
    const d = await dohvati('/api/dezurni/config')
    expect(d.dostupno).toBe(true)
    expect(d.modeli).toContain(MISTRAL_LARGE_4)
    expect(d.postavke.model).toBe('z-ai/glm-4.6')   // nije postao zadani
  })

  test('odlučitelj: Mistral u popisu', async () => {
    const d = await dohvati('/api/odlucitelj/config')
    expect(d.modeli).toContain(MISTRAL_LARGE_4)
    expect(d.postavke.model).toBe('z-ai/glm-4.6')
  })

  test('odabir po agentu se sprema i čita natrag', async () => {
    const r = await fetch(`${p!.url}/api/agents/jelena/model`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: SPEC }),
    })
    expect(r.status).toBe(200)
    const mc = JSON.parse(readFileSync(join(mapa, 'model-config.json'), 'utf-8'))
    expect(mc.agentOverrides.jelena).toBe(SPEC)
  })
})
