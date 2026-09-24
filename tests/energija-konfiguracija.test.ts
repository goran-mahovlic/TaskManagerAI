/**
 * J7 (GAP_20260924 F10): koeficijenti procjene su KONFIGURACIJA, ne konstanta u kodu.
 * Modul ih čita jednom pri učitavanju, pa se svaka varijanta mjeri u zasebnom procesu.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const KORIJEN = join(import.meta.dir, '..')

function izmjeri(konfig: object | null): any {
  const dir = mkdtempSync(join(tmpdir(), 'energija-'))
  const env: Record<string, string> = { ...process.env as any }
  if (konfig) {
    const p = join(dir, 'energija.json')
    writeFileSync(p, JSON.stringify(konfig))
    env.TM_ENERGIJA_CONFIG = p
  } else {
    env.TM_ENERGIJA_CONFIG = join(dir, 'nema.json')
  }
  const kod = `const c = require('./src/core/CostTracker');
    const e = c.sazmiEnergiju([{ model: 'sonnet', inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, zapisaSTokenima: 1 }]);
    console.log(JSON.stringify({ wh: e.wh, co2: c.CO2_FACTOR_KG_PER_KWH, voda: c.VODA_WUE_L_PER_KWH, metoda: c.ENERGY_METHOD, pojas: c.ENERGY_BAND }))`
  const r = Bun.spawnSync(['bun', '-e', kod], { cwd: KORIJEN, env })
  expect(r.exitCode).toBe(0)
  return JSON.parse(r.stdout.toString().trim().split('\n').pop()!)
}

describe('koeficijenti energije iz config/energija.json', () => {
  test('bez datoteke → zadane vrijednosti s citiranim izvorom', () => {
    const o = izmjeri(null)
    expect(o.wh).toBeCloseTo(390, 5)
    expect(o.co2).toBe(0.21)
    expect(o.voda).toBe(1.1)
    expect(o.metoda).toBe('A-couch-epoch-2026')
  })

  test('datoteka nadjačava koeficijente i mijenja oznaku metode', () => {
    const o = izmjeri({ whPoMTok: { input: 100 }, co2KgPoKWh: 0.37, vodaLPoKWh: 3.1, energijaPojas: 4 })
    expect(o.wh).toBeCloseTo(100, 5)
    expect(o.co2).toBe(0.37)
    expect(o.voda).toBe(3.1)
    expect(o.pojas).toBe(4)
    expect(o.metoda).toBe('konfiguracija')
  })

  test('tipfeler (nula, tekst) ne daje nulu nego zadanu vrijednost', () => {
    const o = izmjeri({ co2KgPoKWh: 0, vodaLPoKWh: 'puno' })
    expect(o.co2).toBe(0.21)
    expect(o.voda).toBe(1.1)
  })
})
