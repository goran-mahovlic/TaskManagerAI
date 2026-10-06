/**
 * TASK-5292 — Telegram obavijest o zadatku nosi oznaku 🧠🚫 kad je agent radio BEZ memorije.
 * Oznaku upisuje daemon u prvi redak izvještaja (result_summary) ili bilješke; obavijest je
 * prenosi na početak poruke, inače bi rad bez memorije u grupi bio tih.
 *
 * Autorica: Jelena (Engineer), TASK-5292.
 */

import { describe, expect, test } from 'bun:test'
import { oznakaMemorijeIzZadatka, tekstObavijestiZadatka } from '../src/TelegramConfig'

describe('obavijest zadatka i oznaka memorije', () => {
  test('izvještaj koji počinje s 🧠🚫 → oznaka (samo prvi redak)', () => {
    const t = { resultSummary: '🧠🚫 bez memorije: rok 20 s istekao\n📋 REZULTAT: …' }
    expect(oznakaMemorijeIzZadatka(t)).toBe('🧠🚫 bez memorije: rok 20 s istekao')
  })

  test('bez izvještaja → zadnja bilješka s oznakom (blokiran put)', () => {
    const t = { resultSummary: '', progressNotes: ['prva', '🧠🚫 bez memorije: Hindsight nedostupan (HTTP 502)\nAuto: …'] }
    expect(oznakaMemorijeIzZadatka(t)).toBe('🧠🚫 bez memorije: Hindsight nedostupan (HTTP 502)')
  })

  test('bilješke kakve vraća ploča ({ note, agent, timestamp })', () => {
    const t = { progressNotes: [{ timestamp: 'x', agent: 'jelena', note: '🧠🚫 bez memorije: rok 20 s istekao — jelena radi BEZ memorije' }] }
    expect(oznakaMemorijeIzZadatka(t)).toBe('🧠🚫 bez memorije: rok 20 s istekao — jelena radi BEZ memorije')
  })

  test('izvještaj bez oznake ima prednost pred starom bilješkom 🧠🚫 (retry je dobio memoriju)', () => {
    const t = { resultSummary: '📋 REZULTAT: gotovo', progressNotes: [{ note: '🧠🚫 bez memorije: rok 20 s istekao' }] }
    expect(oznakaMemorijeIzZadatka(t)).toBe('')
  })

  test('uspjeh s memorijom → bez oznake', () => {
    expect(oznakaMemorijeIzZadatka({ resultSummary: '📋 REZULTAT: gotovo' })).toBe('')
    expect(oznakaMemorijeIzZadatka({})).toBe('')
    expect(oznakaMemorijeIzZadatka(null)).toBe('')
  })

  test('tekst obavijesti: oznaka na početku, ostalo kao prije; HTML se zaklanja', () => {
    expect(tekstObavijestiZadatka('TASK-1', 'Naslov <x>', 'completed', '🧠🚫 bez memorije: rok 20 s istekao'))
      .toBe('🧠🚫 bez memorije: rok 20 s istekao\n✅ Zadatak <b>TASK-1</b> — completed\nNaslov &lt;x&gt;')
    expect(tekstObavijestiZadatka('TASK-1', 'N', 'failed')).toBe('❌ Zadatak <b>TASK-1</b> — failed\nN')
  })
})
