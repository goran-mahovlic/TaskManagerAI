/**
 * K1/TASK-4820 — procjena potrošnje struje iz tokena (ADR-0010 §4, §7, §11).
 *
 * Testovi brane četiri stvari koje su se pri istrazi pokazale lomljivima:
 *  1. formula ima ČETIRI člana (naivna `(ulaz+izlaz)×faktor` podcjenjuje 7,3× — ADR M9),
 *  2. nemjereno je `null`, nikad 0 (ADR §8.2/5),
 *  3. nepoznat razred modela nosi zastavicu, ne tihu jedinicu,
 *  4. agregat po projektu grupira i po MODELU (ADR §11.3: `GROUP BY pid` sam podcjenjuje 1,584×).
 */
import { describe, expect, test } from 'bun:test'
import {
  ENERGY_RATES, ENERGY_BAND, ENERGY_METHOD, ENERGIJA_PO_PROJEKTU_SQL,
  energijaKRazreda, procijeniEnergijuWh, sazmiEnergiju, estimateCostUsd,
} from '../src/core/CostTracker'

const REDAK = {
  model: 'claude-sonnet-5',
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
}

describe('procijeniEnergijuWh — četiri člana', () => {
  test('zbraja sva četiri razreda tokena, ne samo ulaz+izlaz', () => {
    const r = procijeniEnergijuWh(REDAK)!
    expect(r.wh).toBeCloseTo(390 + 1950 + 39 + 490, 6)
    expect(r.modelNepoznat).toBe(false)
  })

  test('naivna formula (ulaz+izlaz) vidi manje od pune — ADR M9', () => {
    const naivna = (REDAK.inputTokens + REDAK.outputTokens) / 1e6 * ENERGY_RATES.input
    const puna = procijeniEnergijuWh(REDAK)!.wh
    expect(naivna).toBeLessThan(puna)
  })

  test('keš-čitanje NIJE besplatno (koeficijent > 0)', () => {
    const bezKesa = procijeniEnergijuWh({ ...REDAK, cacheReadTokens: 0 })!.wh
    expect(procijeniEnergijuWh(REDAK)!.wh).toBeGreaterThan(bezKesa)
  })

  test('množitelj razreda: opus 5/3, fable 10/3, haiku 1/3 — preko normalizeModel', () => {
    expect(energijaKRazreda('claude-opus-5')).toBeCloseTo(5 / 3, 9)
    expect(energijaKRazreda('claude-fable-5-1')).toBeCloseTo(10 / 3, 9)
    expect(energijaKRazreda('claude-haiku-4-5-20251001')).toBeCloseTo(1 / 3, 9)
    expect(energijaKRazreda('claude-sonnet-5')).toBe(1)
  })

  test('opus troši 5/3 energije sonneta na istim tokenima', () => {
    const s = procijeniEnergijuWh(REDAK)!.wh
    const o = procijeniEnergijuWh({ ...REDAK, model: 'claude-opus-5' })!.wh
    expect(o / s).toBeCloseTo(5 / 3, 9)
  })

  test('nepoznat model → k = 1 I zastavica, ne tiha nula', () => {
    const r = procijeniEnergijuWh({ ...REDAK, model: 'qwen3:32b' })!
    expect(r.modelNepoznat).toBe(true)
    expect(r.wh).toBeCloseTo(procijeniEnergijuWh(REDAK)!.wh, 6)
  })

  test('svi tokeni 0 → null (nemjereno), NE 0 Wh', () => {
    expect(procijeniEnergijuWh({
      model: 'opus', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })).toBeNull()
  })

  test('ENERGY_RATES / COST_RATES = 130 u svakom članu — ADR §11.1 (identitet, ne korelacija)', () => {
    const usd = estimateCostUsd('claude-sonnet-5', 1e6, 0, 0, 0)
    expect(procijeniEnergijuWh({ ...REDAK, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })!.wh / usd)
      .toBeCloseTo(130, 6)
  })
})

describe('sazmiEnergiju — agregat s rasponom i nazivnikom', () => {
  const redci = [
    { ...REDAK },
    { ...REDAK, model: 'claude-opus-5' },
    { model: 'opus', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, // legacy
  ]

  test('zbraja samo mjerene retke i broji ih u izTokena', () => {
    const s = sazmiEnergiju(redci)!
    expect(s.izTokena).toBe(2)
    expect(s.wh).toBeCloseTo(2869 * (1 + 5 / 3), 3)
    expect(s.procjena).toBe(true)
    expect(s.metoda).toBe(ENERGY_METHOD)
  })

  test('raspon je ÷3…×3 oko središnje vrijednosti — ADR §4.5', () => {
    const s = sazmiEnergiju(redci)!
    // zaokruženje na 0,1 mWh je namjerno (JSON se ne puni znamenkama koje procjena nema)
    expect(s.donja).toBeCloseTo(s.wh / ENERGY_BAND, 3)
    expect(s.gornja).toBeCloseTo(s.wh * ENERGY_BAND, 3)
  })

  test('samo nemjereni redci → null, kartica pokazuje crticu a ne nulu', () => {
    expect(sazmiEnergiju([{ model: 'opus', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }])).toBeNull()
    expect(sazmiEnergiju([])).toBeNull()
  })

  test('broji retke nepoznatog razreda', () => {
    const s = sazmiEnergiju([...redci, { ...REDAK, model: 'qwen3:32b' }])!
    expect(s.modelNepoznat).toBe(1)
  })
})

describe('ENERGIJA_PO_PROJEKTU_SQL — zamke iz ADR §11.3 i §11.4', () => {
  test('grupira po projektu I modelu (inače k=1 svima → podcjena 1,584×)', () => {
    expect(ENERGIJA_PO_PROJEKTU_SQL.replace(/\s+/g, ' ')).toContain('GROUP BY pid, c.model')
  })

  test('projekt se čita JOIN-om na zadatak (TASK-4263), ne iz cost_log.project_id', () => {
    const jedan = ENERGIJA_PO_PROJEKTU_SQL.replace(/\s+/g, ' ')
    expect(jedan).toContain('LEFT JOIN tasks t ON t.id = c.task_id')
    expect(jedan).toContain('COALESCE(t.project_id, c.project_id')
  })

  test('nosi sva četiri stupca tokena', () => {
    for (const st of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
      expect(ENERGIJA_PO_PROJEKTU_SQL).toContain(st)
    }
  })
})

describe('sazmiEnergiju — nazivnik kad je redak već zbrojen po (projekt × model)', () => {
  test('izTokena broji IZVOĐENJA, ne redaka agregata', () => {
    const s = sazmiEnergiju([{ ...REDAK, zapisaSTokenima: 17 }, { ...REDAK, model: 'claude-opus-5', zapisaSTokenima: 3 }])!
    expect(s.izTokena).toBe(20)
  })

  test('nepoznat razred nosi svoj broj izvođenja u zastavicu', () => {
    const s = sazmiEnergiju([{ ...REDAK, model: 'qwen3:32b', zapisaSTokenima: 5 }])!
    expect(s.modelNepoznat).toBe(5)
  })
})
