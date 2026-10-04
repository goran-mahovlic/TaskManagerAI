/**
 * TASK-5230: /api/pregled/tjedni pod opterećenjem stroja vraćao je 202 „računa se" dulje od
 * 2 min (klijent odustaje nakon 12 × 1,5 s) iako je u kešu ležao malo stariji rezultat.
 * Stale-while-revalidate: istekao keš + spor alat → 200 star keš odmah, izračun teče dalje.
 */
import { describe, it, expect } from 'bun:test'
import { resolveTjedniPregled, createPregledState, PREGLED_TTL_MS, type PregledDeps } from '../src/TjedniPregled'

function sirovo() {
  return {
    zapisano_ts: '2026-10-04T12:00:00.000Z',
    razdoblje: { dana: 7, od: '2026-09-27T12:00:00.000Z', do: '2026-10-04T12:00:00.000Z' },
    ukupno: { zadataka: 3, trosak_usd: 1.5 },
    po_projektu: [], po_agentu: [], najskuplji: [],
    izvor: { run_log: 'run_log.jsonl', iz_kesa: 0, izracunato_sada: 3 },
  }
}

describe('resolveTjedniPregled — stale-while-revalidate (TASK-5230)', () => {
  it('istekao keš + spor alat → 200 star keš odmah, ne 202', async () => {
    const state = createPregledState()
    let sada = 1_000
    let spor = false
    const deps: PregledDeps = {
      state, now: () => sada,
      runTool: async () => {
        if (spor) await new Promise((r) => setTimeout(r, 200))
        return JSON.stringify(sirovo())
      },
    }
    const prvi = await resolveTjedniPregled({}, deps)
    expect(prvi.http).toBe(200)
    sada += PREGLED_TTL_MS + 1
    spor = true
    const r = await resolveTjedniPregled({ waitMs: 10 }, deps)
    expect(r.http).toBe(200)
    expect(r.izvor).toBe('kes')
    expect(r.staroMs).toBeGreaterThan(PREGLED_TTL_MS)
  })

  it('bez ikakvog keša spor alat i dalje daje 202 „racuna"', async () => {
    const state = createPregledState()
    const r = await resolveTjedniPregled({ waitMs: 10 }, {
      state, now: () => Date.now(),
      runTool: async () => { await new Promise((res) => setTimeout(res, 100)); return JSON.stringify(sirovo()) },
    })
    expect(r.http).toBe(202)
    expect(r.stanje).toBe('racuna')
  })
})
