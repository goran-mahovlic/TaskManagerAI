/**
 * TASK-5663: čvor na kojem se ništa ne mijenja nije „zastario” — timer znanja svakih 30 min
 * usporedi korpus s bankom („isto 83”) i to bilježi kao `zadnjeUskladjeno`; starost upisa za
 * profil-cvora je mlađe od `zadnjiUpis` i `zadnjeUskladjeno`.
 */
import { describe, expect, test } from 'bun:test'
import { starostUpisaSati } from '../scripts/profil-cvora-stanje'

const SAD = Date.parse('2026-10-24T23:13:00Z')

describe('starost upisa znanja', () => {
  test('bez ijednog vremena → null', () => expect(starostUpisaSati({}, SAD)).toBeNull())
  test('samo zadnjiUpis (staro stanje) → kao prije', () =>
    expect(starostUpisaSati({ zadnjiUpis: '2026-10-24T21:04:46Z' }, SAD)).toBe(2.1))
  test('mirni čvor: stari upis, svježe usklađivanje → starost usklađivanja', () =>
    expect(starostUpisaSati({ zadnjiUpis: '2026-10-24T21:04:46Z', zadnjeUskladjeno: '2026-10-24T23:04:00Z' }, SAD)).toBe(0.2))
  test('neispravan zapis se ne računa', () =>
    expect(starostUpisaSati({ zadnjiUpis: 'smeće', zadnjeUskladjeno: '2026-10-24T22:13:00Z' }, SAD)).toBe(1))
})
