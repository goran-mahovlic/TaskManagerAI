/**
 * Uređivač rasporeda Config stranice (TASK-5169, Grga): pravila koja dizajn propisuje
 * poslužitelju i pregledniku. Logika je iz prototipa (`docs/skice/config-raspored/raspored-logika.js`)
 * preseljena u `src/core/ConfigRaspored.ts` (TASK-5170) — promijenjen je samo import.
 * Dizajn: `docs/DIZAJN-config-uredivac-rasporeda.md`.
 */
import { describe, expect, test } from 'bun:test'
import * as L0 from '../src/core/ConfigRaspored'
const L = L0 as any

const valjan = () => ({
  v: 1,
  redoslijed: ['info-autonomija-card', 'info-concurrency-card'],
  kartice: { 'info-autonomija-card': { w: 4, h: null }, 'info-concurrency-card': { w: 1, h: 320 } },
})

describe('validiraj — raspored ne smije nositi vrijednosti postavki', () => {
  test('valjan raspored prolazi i vraća očišćenu kopiju', () => {
    const r = L.validiraj(valjan())
    expect(r.ok).toBe(true)
    expect(r.value).toEqual(valjan())
  })

  test('polje vrijednosti uz raspored (maxConcurrent) se odbija cijelo', () => {
    const r = L.validiraj({ ...valjan(), maxConcurrent: 9 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('maxConcurrent')
  })

  test('vrijednost podmetnuta u mjere kartice se odbija', () => {
    const t = valjan() as any
    t.kartice['info-concurrency-card'].vrijednost = 10
    expect(L.validiraj(t).ok).toBe(false)
  })

  test.each([
    [{ w: 0, h: null }], [{ w: 5, h: null }], [{ w: 2.5, h: null }],
    [{ w: 2, h: 100 }], [{ w: 2, h: 1240 }], [{ w: 2, h: 330 }], [{ w: 2, h: '320' }],
  ])('neispravne mjere %j se odbijaju', m => {
    const t = valjan() as any
    t.kartice['info-concurrency-card'] = m
    expect(L.validiraj(t).ok).toBe(false)
  })

  test('ID koji nije kartica Configa (npr. selektor ili HTML) se odbija', () => {
    for (const id of ['tab-info', 'info-card"><script>', '../settings', 'info--card']) {
      expect(L.validiraj({ ...valjan(), redoslijed: [id] }).ok).toBe(false)
    }
  })

  test('ponovljen ID u redoslijedu se odbija', () => {
    expect(L.validiraj({ ...valjan(), redoslijed: ['info-rag-card', 'info-rag-card'] }).ok).toBe(false)
  })

  test('kriva verzija i preveliko tijelo se odbijaju', () => {
    expect(L.validiraj({ ...valjan(), v: 2 }).ok).toBe(false)
    const golem = valjan() as any
    golem.redoslijed = Array.from({ length: 64 }, (_, i) => `info-${'x'.repeat(55)}${i}-card`)
    golem.kartice = Object.fromEntries(golem.redoslijed.map((id: string) => [id, { w: 2, h: null }]))
    expect(L.validiraj(golem).error).toContain('8192')
  })

  test('null, niz i string nisu raspored', () => {
    for (const x of [null, [], 'raspored', 42]) expect(L.validiraj(x).ok).toBe(false)
  })
})

describe('poredajSkupinu — nadogradnja ne smije razbiti spremljeni raspored', () => {
  const zadano = ['info-a-card', 'info-b-card', 'info-c-card']

  test('bez spremljenog rasporeda ostaje zadani redoslijed', () => {
    expect(L.poredajSkupinu(zadano, [])).toEqual(zadano)
  })

  test('spremljeni redoslijed se primjenjuje', () => {
    expect(L.poredajSkupinu(zadano, ['info-c-card', 'info-a-card', 'info-b-card'])).toEqual(['info-c-card', 'info-a-card', 'info-b-card'])
  })

  test('nova kartica (nepoznata rasporedu) ostaje na svom zadanom mjestu', () => {
    const sNovom = ['info-a-card', 'info-nova-card', 'info-b-card', 'info-c-card']
    expect(L.poredajSkupinu(sNovom, ['info-c-card', 'info-b-card', 'info-a-card']))
      .toEqual(['info-c-card', 'info-nova-card', 'info-b-card', 'info-a-card'])
  })

  test('spremljeni ID kojeg na stranici nema se preskače', () => {
    expect(L.poredajSkupinu(zadano, ['info-nestala-card', 'info-b-card', 'info-a-card', 'info-c-card']))
      .toEqual(['info-b-card', 'info-a-card', 'info-c-card'])
  })
})

describe('mjere, spoji, brojIzmjena, zaokruziVisinu', () => {
  test('zadane mjere: info-full 4 stupca, ostale 2, visina prirodna', () => {
    expect(L.mjere('info-x-card', null, true)).toEqual({ w: 4, h: null })
    expect(L.mjere('info-x-card', null, false)).toEqual({ w: 2, h: null })
    expect(L.mjere('info-concurrency-card', valjan(), false)).toEqual({ w: 1, h: 320 })
  })

  test('spoji čuva kartice koje ova stranica ne vidi (pogon i samostalni paket imaju različite kartice)', () => {
    const stari = { v: 1, redoslijed: ['info-orkestrator-card', 'info-rag-card'], kartice: { 'info-orkestrator-card': { w: 3, h: null } } }
    const novo = { v: 1, redoslijed: ['info-rag-card'], kartice: { 'info-rag-card': { w: 4, h: 480 } } }
    const s = L.spoji(stari, novo)
    expect(s.redoslijed).toEqual(['info-rag-card', 'info-orkestrator-card'])
    expect(s.kartice['info-orkestrator-card']).toEqual({ w: 3, h: null })
    expect(L.validiraj(s).ok).toBe(true)
  })

  test('brojIzmjena broji širinu, visinu i pomak', () => {
    const a = valjan()
    const b = JSON.parse(JSON.stringify(a))
    expect(L.brojIzmjena(a, b)).toBe(0)
    b.kartice['info-concurrency-card'].w = 2
    b.kartice['info-concurrency-card'].h = null
    b.redoslijed.reverse()
    expect(L.brojIzmjena(a, b)).toBe(4)
  })

  test('visina se zaokružuje na 40 px i stišće u 160–1200', () => {
    expect(L.zaokruziVisinu(333)).toBe(320)
    expect(L.zaokruziVisinu(20)).toBe(160)
    expect(L.zaokruziVisinu(5000)).toBe(1200)
    expect(L.validiraj({ v: 1, redoslijed: [], kartice: { 'info-x-card': { w: 2, h: L.zaokruziVisinu(777) } } }).ok).toBe(true)
  })
})
