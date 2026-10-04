/**
 * TASK-5173 — `tools/odlucitelj.py` (`cekaju()`) i GET /api/odluke dijele JEDAN filtar.
 *
 * Traka je brojila tri zadatka „u redu odlučitelja", a odlučitelj je u istom trenutku
 * pregledao nula — svatko je filtrirao po svome. Sad poslužitelj računa `zaOdlucitelja`
 * (src/core/OdlukeRazvrstaj.ts), a alat ga samo čita. Stari filtar ostaje samo za ploču
 * koja polje ne šalje.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ALATI = join(import.meta.dir, '..', 'tools')

/** `cekaju()` nad podmetnutim odgovorom ploče; vraća ID-ove koje bi odlučitelj uzeo. */
function cekaju(zadatci: unknown[], postavke: Record<string, unknown> = {}, odgodi: string[] = []): string[] {
  const dom = mkdtempSync(join(tmpdir(), 'odl-filtar-'))
  const kod = `import sys, json; sys.path.insert(0, ${JSON.stringify(ALATI)})
import odlucitelj as o
from pathlib import Path
o.ODGODE = Path(${JSON.stringify(join(dom, 'odgode.json'))})
o._json = lambda *a, **k: {"zadatci": json.loads(${JSON.stringify(JSON.stringify(zadatci))})}
for i in json.loads(${JSON.stringify(JSON.stringify(odgodi))}): o._odgodi(i, 4)
print(json.dumps([z["id"] for z in o.cekaju(json.loads(${JSON.stringify(JSON.stringify(postavke))}))]))`
  const r = Bun.spawnSync(['python3', '-c', kod], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dom, TM_HOME: dom },
  })
  const izlaz = r.stdout.toString().trim()
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(izlaz.split('\n').pop() || '[]')
}

describe('odlucitelj.py — isti filtar kao /api/odluke', () => {
  test('čita zaOdlucitelja: waiting-for-human zadatak bez okidača ostaje vani', () => {
    expect(cekaju([
      { id: 'T-COVJEK', cekaNa: [], okidacStrojni: false, zaOdlucitelja: false },
      { id: 'T-MODEL', cekaNa: [], okidacStrojni: false, zaOdlucitelja: true },
    ])).toEqual(['T-MODEL'])
  })

  test('kad ploča kaže da (pusta_strojni_okidac u istoj datoteci), alat je ne poništava', () => {
    expect(cekaju([{ id: 'T-S', cekaNa: [], okidacStrojni: true, zaOdlucitelja: true }],
      { pusta_strojni_okidac: false })).toEqual(['T-S'])
  })

  test('starija ploča bez polja: stari filtar (ovisnost i strojni okidač vani)', () => {
    expect(cekaju([
      { id: 'T-A', cekaNa: ['T-9'] }, { id: 'T-B', cekaNa: [], okidacStrojni: true }, { id: 'T-C', cekaNa: [] },
    ])).toEqual(['T-C'])
  })

  test('aktivna odgoda i dalje drži zadatak vani', () => {
    expect(cekaju([{ id: 'T-1', cekaNa: [], zaOdlucitelja: true }], {}, ['T-1'])).toEqual([])
  })
})
