// TASK-5305 (uputa #189): „prebaci sve na model" samo PIŠE postojeća polja model-configa
// (defaults + agentOverrides + componentOverrides) — bez nove logike usmjeravanja.
import { describe, expect, test } from 'bun:test'
import {
  prebaciSve, vratiPrebacivanje, stanjePrebacivanja, rasclaniSpec, jeAnthropicProvider,
  ciljRazgovora, IZUZETE_KOMPONENTE,
} from '../src/core/models/PrebaciSve'

function mcPrimjer(): any {
  return {
    _comment: 'x',
    providers: {
      anthropic: { enabled: true },
      openrouter: { enabled: true, apiKey: 'env:OPENROUTER_API_KEY' },
      glm: { enabled: true, anthropicCompatible: true, baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'env:GLM_API_KEY' },
      ollama: { enabled: true, baseUrl: 'http://ollama.lokalno:11434' },
      google: { enabled: false },
    },
    defaults: { frontier: 'anthropic:opus', strong: 'anthropic:sonnet', good: 'anthropic:sonnet', basic: 'anthropic:haiku', classifier: 'anthropic:haiku', _pin: 'biljeska' },
    agentOverrides: { inzenjer: 'anthropic:opus', arhitekt: 'anthropic:opus', _primjer: 'ollama:qwen3:8b' },
    componentOverrides: { _comment: 'c', embeddings: 'ollama:qwen3-embedding:8b', classifier: 'ollama:qwen3:8b', hindsight: 'anthropic:opus' },
  }
}

describe('prebaciSve — piše postojeća polja', () => {
  test('agenti, razine i komponente idu na cilj; embeddings i classifier ostaju', () => {
    const { mc, promijenjeno } = prebaciSve(mcPrimjer(), 'openrouter:z-ai/glm-5.2', { tko: 'vlasnik', kada: '2026-10-07T10:00:00Z', agenti: ['inzenjer', 'arhitekt', 'revizor'] })
    expect(mc.agentOverrides.inzenjer).toBe('openrouter:z-ai/glm-5.2')
    expect(mc.agentOverrides.arhitekt).toBe('openrouter:z-ai/glm-5.2')
    expect(mc.agentOverrides.revizor).toBe('openrouter:z-ai/glm-5.2')       // iz registra, prije bez overridea
    expect(mc.agentOverrides.razgovor).toBe('openrouter:z-ai/glm-5.2')    // Šabanov razgovor
    expect(mc.agentOverrides._primjer).toBe('ollama:qwen3:8b')            // komentar/primjer netaknut
    expect(mc.defaults.frontier).toBe('openrouter:z-ai/glm-5.2')
    expect(mc.defaults.basic).toBe('openrouter:z-ai/glm-5.2')
    expect(mc.defaults.classifier).toBe('anthropic:haiku')                 // rutiranje se ne dira
    expect(mc.defaults._pin).toBe('biljeska')
    expect(mc.componentOverrides.hindsight).toBe('openrouter:z-ai/glm-5.2')
    expect(mc.componentOverrides.embeddings).toBe('ollama:qwen3-embedding:8b')
    expect(mc.componentOverrides.classifier).toBe('ollama:qwen3:8b')
    expect(IZUZETE_KOMPONENTE).toContain('embeddings')
    expect(promijenjeno).toContain('agentOverrides.inzenjer')
    expect(promijenjeno).not.toContain('componentOverrides.embeddings')
  })

  test('snimka prije se pamti jednom — drugi prekidač ne prepisuje izvornik', () => {
    const a = prebaciSve(mcPrimjer(), 'openrouter:z-ai/glm-5.2', { tko: 'vlasnik', kada: 't1' }).mc
    const b = prebaciSve(a, 'anthropic:sonnet', { tko: 'vlasnik', kada: 't2' }).mc
    expect(b._prebaciSvePrije.agentOverrides.inzenjer).toBe('anthropic:opus')
    expect(b._prebaciSvePrije.cilj).toBe('anthropic:sonnet')
    expect(stanjePrebacivanja(b)).toMatchObject({ aktivno: true, cilj: 'anthropic:sonnet', tko: 'vlasnik', kada: 't2' })
  })

  test('vrati — točno stanje prije prvog prebacivanja, bez snimke', () => {
    const izvor = mcPrimjer()
    const p = prebaciSve(mcPrimjer(), 'openrouter:z-ai/glm-5.2', { tko: 'vlasnik', kada: 't1', agenti: ['revizor'] }).mc
    const { mc, vraceno } = vratiPrebacivanje(p)
    expect(vraceno).toBe(true)
    expect(mc.agentOverrides).toEqual(izvor.agentOverrides)                // revizor i razgovor nestaju
    expect(mc.defaults).toEqual(izvor.defaults)
    expect(mc.componentOverrides).toEqual(izvor.componentOverrides)
    expect(mc._prebaciSvePrije).toBeUndefined()
    expect(stanjePrebacivanja(mc).aktivno).toBe(false)
    expect(vratiPrebacivanje(mc).vraceno).toBe(false)
  })

  test('neispravan spec se odbija (ništa se ne piše)', () => {
    expect(() => prebaciSve(mcPrimjer(), 'opus', { tko: 'g', kada: 't' })).toThrow()
    expect(() => prebaciSve(mcPrimjer(), 'nepoznat:x', { tko: 'g', kada: 't' })).toThrow(/nepoznat provider/)
    expect(() => prebaciSve(mcPrimjer(), 'google:gemini-2.5', { tko: 'g', kada: 't' })).toThrow(/isključen/)
  })
})

describe('rasclaniSpec / jeAnthropicProvider', () => {
  test('dvotočka u modelu i @čvor', () => {
    expect(rasclaniSpec('ollama@node-a:qwen3:8b')).toEqual({ provider: 'ollama', node: 'node-a', model: 'qwen3:8b' })
    expect(rasclaniSpec('openrouter:z-ai/glm-5.2')).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.2' })
    expect(rasclaniSpec('opus')).toBeNull()
  })
  test('obitelj Anthropic kvote = samo anthropic/claude', () => {
    expect(jeAnthropicProvider('anthropic')).toBe(true)
    expect(jeAnthropicProvider('claude')).toBe(true)
    for (const p of ['openrouter', 'glm', 'kimi', 'ollama', 'google']) expect(jeAnthropicProvider(p)).toBe(false)
  })
})

describe('ciljRazgovora — claude -p uz ANTHROPIC_BASE_URL', () => {
  const tajne: Record<string, string> = { OPENROUTER_API_KEY: 'or-tajna', GLM_API_KEY: 'glm-tajna' }
  const citaj = (ime: string) => tajne[ime] ?? null
  const prov = mcPrimjer().providers

  test('anthropic:opus → --model opus, bez preusmjerenja', () => {
    expect(ciljRazgovora('anthropic:opus', prov, citaj)).toEqual({ model: 'opus', env: {}, anthropic: true })
  })
  test('goli alias ostaje kakav jest', () => {
    expect(ciljRazgovora('sonnet', prov, citaj)).toEqual({ model: 'sonnet', env: {}, anthropic: true })
    expect(ciljRazgovora(undefined, prov, citaj)).toEqual({ model: undefined, env: {}, anthropic: true })
  })
  test('openrouter → zadani Anthropic-kompatibilni endpoint OpenRoutera + ključ iz tajni', () => {
    const c = ciljRazgovora('openrouter:z-ai/glm-5.2', prov, citaj)
    expect(c.anthropic).toBe(false)
    expect(c.model).toBe('z-ai/glm-5.2')
    expect(c.env).toEqual({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'or-tajna', ANTHROPIC_API_KEY: '' })
  })
  test('anthropicCompatible provider → njegov baseUrl', () => {
    const c = ciljRazgovora('glm:glm-4.6', prov, citaj)
    expect(c.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(c.env.ANTHROPIC_AUTH_TOKEN).toBe('glm-tajna')
  })
  test('provider bez Anthropic-kompatibilnog puta → greška, ne tihi pad na Claude', () => {
    expect(ciljRazgovora('ollama:qwen3:8b', prov, citaj).greska).toMatch(/ollama/)
    expect(ciljRazgovora('openrouter:x', prov, () => null).greska).toMatch(/OPENROUTER_API_KEY/)
  })
})
