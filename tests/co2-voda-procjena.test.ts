/**
 * ADR-0011/TASK-4822 — procjena CO₂ i vode iz VEĆ procijenjene energije.
 *
 * Testovi brane pet stvari koje su se pri istrazi pokazale lomljivima:
 *  1. obje su brojke JEDAN množitelj nad `wh` — nema druge formule iz tokena,
 *  2. brojka iz ADR-0010 M16 („122 kg CO₂e") mora ostati reproducibilna iz konstanti,
 *  3. nemjereno je `null`, nikad 0 (isto pravilo kao energija, ADR-0010 §8.2/5),
 *  4. pojas vode je ŠIRI I NESIMETRIČAN u odnosu na struju i CO₂ (ADR-0011 §3.4),
 *  5. `procjena`/`grubaProcjena` su ugovor prema sučelju, ne komentar.
 */
import { describe, expect, test } from 'bun:test'
import {
  ENERGY_BAND, CO2_BAND, CO2_FACTOR_KG_PER_KWH, CO2_METHOD,
  VODA_BAND_DOLJE, VODA_BAND_GORE, VODA_WUE_L_PER_KWH, VODA_METHOD,
  procijeniCo2Kg, procijeniVoduL, sazmiCo2, sazmiVodu, sazmiEnergiju,
} from '../src/core/CostTracker'

const REDAK = {
  model: 'claude-sonnet-5',
  inputTokens: 1_000_000, outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
}

describe('CO₂ — množitelj nad energijom, ne nova formula', () => {
  test('kg = kWh × faktor, linearno', () => {
    expect(procijeniCo2Kg(1000)).toBeCloseTo(CO2_FACTOR_KG_PER_KWH, 9)
    expect(procijeniCo2Kg(2000)).toBeCloseTo(2 * CO2_FACTOR_KG_PER_KWH, 9)
  })

  test('reproducira ADR-0010 M16: 579,1 kWh → 122 kg CO₂e', () => {
    expect(Math.round(procijeniCo2Kg(579_100))).toBe(122)
  })

  test('faktor je 0,21 kg/kWh (EEA EU-27) i nosi ime metode', () => {
    expect(CO2_FACTOR_KG_PER_KWH).toBe(0.21)
    expect(CO2_METHOD).toContain('EEA')
  })

  test('pojas ÷4…×4 — širi od struje, jer CO₂ ima jednu nesigurnost više', () => {
    const c = sazmiCo2(579_100)!
    expect(CO2_BAND).toBeGreaterThan(ENERGY_BAND)
    // precizija 3, a ne 6: sažetak se namjerno zaokružuje na 0,1 g / 0,1 mL — JSON se
    // ne puni znamenkama koje procjena s pojasom ÷4…×4 nema (isto pravilo kao kod energije)
    expect(c.donja).toBeCloseTo(c.kg / CO2_BAND, 3)
    expect(c.gornja).toBeCloseTo(c.kg * CO2_BAND, 3)
  })

  test('prikazani pojas obuhvaća SVE kandidate za faktor mreže (0,12 – 0,445)', () => {
    // ADR-0011 §2.2/3: izbor mreže ne smije ispasti iz pojasa, inače je izbor bio kriv
    const c = sazmiCo2(1_000_000)      // 1000 kWh
    for (const f of [0.12, 0.19, 0.287, 0.37, 0.445]) {
      expect(1000 * f).toBeGreaterThanOrEqual(c!.donja)
      expect(1000 * f).toBeLessThanOrEqual(c!.gornja)
    }
  })

  test('nemjereno je null, ne 0 kg', () => {
    expect(sazmiCo2(0)).toBeNull()
    expect(sazmiCo2(null as any)).toBeNull()
  })

  test('procjena: true je obvezno polje', () => {
    expect(sazmiCo2(1000)!.procjena).toBe(true)
  })
})

describe('Voda — najnesigurnija od tri procjene (ADR-0011 §3)', () => {
  test('L = kWh × WUE, anker Googleovo produkcijsko mjerenje 1,08 → 1,1', () => {
    expect(VODA_WUE_L_PER_KWH).toBe(1.1)
    expect(procijeniVoduL(1000)).toBeCloseTo(1.1, 9)
    expect(VODA_METHOD).toContain('onsite')
  })

  test('pojas je NESIMETRIČAN: ÷10 dolje, ×6 gore', () => {
    const v = sazmiVodu(579_100)!
    expect(v.donja).toBeCloseTo(v.l / VODA_BAND_DOLJE, 3)
    expect(v.gornja).toBeCloseTo(v.l * VODA_BAND_GORE, 3)
    expect(VODA_BAND_DOLJE).not.toBe(VODA_BAND_GORE)
  })

  test('pojas vode je širi od pojasa CO₂ NA OBJE strane — §3.4', () => {
    expect(VODA_BAND_DOLJE).toBeGreaterThan(CO2_BAND)
    expect(VODA_BAND_GORE).toBeGreaterThan(CO2_BAND)
  })

  test('gornji rub pokriva granicu obračuna „lice mjesta + proizvodnja struje" (do 5,3 L/kWh)', () => {
    const v = sazmiVodu(1_000_000)!         // 1000 kWh
    expect(1000 * 5.3).toBeLessThanOrEqual(v.gornja)
    expect(1000 * 0.12).toBeGreaterThanOrEqual(v.donja)   // donji rub: AWS zatvoreni krug
  })

  test('grubaProcjena: true obvezuje sučelje na jače označavanje', () => {
    const v = sazmiVodu(1000)!
    expect(v.procjena).toBe(true)
    expect(v.grubaProcjena).toBe(true)
  })

  test('nemjereno je null, ne 0 L', () => {
    expect(sazmiVodu(0)).toBeNull()
  })
})

describe('sazmiEnergiju nosi otisak sa sobom — jedan izvor istine', () => {
  const s = sazmiEnergiju([REDAK])!

  test('CO₂ i voda izvedeni su iz ISTOG wh, ne iz tokena iznova', () => {
    expect(s.co2!.kg).toBeCloseTo(procijeniCo2Kg(s.wh), 3)
    expect(s.voda!.l).toBeCloseTo(procijeniVoduL(s.wh), 3)
  })

  test('omjeri su konstantni — CO₂/voda ne nose NIJEDAN bit preko energije (§1)', () => {
    const dvostruko = sazmiEnergiju([REDAK, { ...REDAK }])!
    expect(dvostruko.co2!.kg / s.co2!.kg).toBeCloseTo(2, 6)
    expect(dvostruko.voda!.l / s.voda!.l).toBeCloseTo(2, 6)
  })

  test('klijent dobiva faktor i WUE s poslužitelja (nema druge kopije konstanti)', () => {
    expect(s.co2!.faktor).toBe(CO2_FACTOR_KG_PER_KWH)
    expect(s.voda!.wue).toBe(VODA_WUE_L_PER_KWH)
  })

  test('nijedan redak s tokenima → cijeli sažetak null, pa ni otiska nema', () => {
    expect(sazmiEnergiju([{ model: 'opus', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }])).toBeNull()
  })
})
