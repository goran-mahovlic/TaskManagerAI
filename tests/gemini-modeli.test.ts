/**
 * TASK-5733 (C) — izbornik Model sustava uz `geminicli:*` nudi i `google:<model>` (izravni API)
 * kad postoji GEMINI_API_KEY; odabir `google:*` uključuje isključenog davatelja `google`.
 *
 * Autorica: Jelena (Engineer), TASK-5733.
 */
import { describe, expect, test } from 'bun:test'
import { modeliGeminija, ukljuciGoogleZaCilj } from '../src/core/models/GeminiModeli'

describe('modeliGeminija', () => {
  test('bez ključa i bez OAuth prijave → ništa', () => {
    expect(modeliGeminija({ kljuc: false, oauth: false })).toEqual([])
  })
  test('ključ → geminicli i google, gemini-3.8-flash prvi; google ide u izbornik sustava', () => {
    const m = modeliGeminija({ kljuc: true, oauth: false })
    expect(m.filter(x => x.provider === 'geminicli')[0]!.spec).toBe('geminicli:gemini-3.8-flash')
    const g = m.filter(x => x.provider === 'google')
    expect(g.map(x => x.spec)).toContain('google:gemini-3.8-flash')
    // Agent preko izravnog API-ja nema alate (nije spawnable), ali je izbor za cijeli sustav.
    expect(g.every(x => x.spawnable === false && x.sustav === true)).toBe(true)
  })
  test('samo OAuth (bez ključa) → samo geminicli; izravni API traži ključ', () => {
    const m = modeliGeminija({ kljuc: false, oauth: true })
    expect(m.length).toBeGreaterThan(0)
    expect(m.some(x => x.provider === 'google')).toBe(false)
  })
})

describe('ukljuciGoogleZaCilj', () => {
  test('google:* uz ključ → davatelj google uključen', () => {
    const mc: any = { providers: { google: { enabled: false, apiKey: 'env:GEMINI_API_KEY' } } }
    expect(ukljuciGoogleZaCilj(mc, 'google:gemini-3.8-flash', true)).toBe(true)
    expect(mc.providers.google.enabled).toBe(true)
  })
  test('bez ključa ili drugi provider → ništa se ne mijenja', () => {
    const mc: any = { providers: { google: { enabled: false } } }
    expect(ukljuciGoogleZaCilj(mc, 'google:gemini-3.8-flash', false)).toBe(false)
    expect(ukljuciGoogleZaCilj(mc, 'geminicli:gemini-3.8-flash', true)).toBe(false)
    expect(mc.providers.google.enabled).toBe(false)
  })
})
