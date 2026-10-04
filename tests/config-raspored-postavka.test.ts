/**
 * TASK-5170: raspored Config stranice u bazi (dizajn TASK-5169 §5, §6).
 *  • ključ `config.raspored` u `settings`, audit u `settings_history` (source `config-raspored`) u ISTOJ transakciji;
 *  • `osnova` (updated_at viđen pri ulasku u uređivanje) → 409 ako je netko u međuvremenu spremio;
 *  • `{zadano:true}` briše ključ, povijest bilježi „zadano"; prazno spremanje ne piše ništa;
 *  • tijelo zahtjeva je strogo: polje vrijednosti postavke uz raspored → 400 i nula upisa;
 *  • klijentska logika (`klijentskaLogikaJS`) je ISTI kod kao poslužiteljska.
 */
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ensureSettingsSchema } from '../src/core/ConcurrencySetting'
import {
  RASPORED_KLJUC, RASPORED_IZVOR, getRaspored, setRaspored, pripremiRaspored, rasporedPovijest,
  parsirajZahtjev, klijentskaLogikaJS, validiraj, poredajSkupinu, spoji,
} from '../src/core/ConfigRaspored'

function svjeza(): Database {
  const db = new Database(':memory:')
  ensureSettingsSchema(db)
  return db
}
const R = (w = 1) => ({
  v: 1, redoslijed: ['info-autonomija-card', 'info-concurrency-card'],
  kartice: { 'info-autonomija-card': { w: 4, h: null }, 'info-concurrency-card': { w, h: 240 } },
})
const brojPovijesti = (db: Database) => (db.query('SELECT COUNT(*) n FROM settings_history').get() as any).n as number

describe('parsirajZahtjev — tijelo PUT-a', () => {
  test('valjan zahtjev s rasporedom', () => {
    const p = parsirajZahtjev({ raspored: R(), osnova: null, by: 'vlasnik', source: 'config-raspored' })
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.value).toMatchObject({ zadano: false, by: 'vlasnik', osnova: null, imaOsnovu: true })
  })
  test('polje vrijednosti postavke UZ raspored (maxConcurrent) → odbijeno cijelo', () => {
    const p = parsirajZahtjev({ raspored: R(), maxConcurrent: 9 })
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.error).toContain('maxConcurrent')
  })
  test('ni raspored ni zadano → odbijeno; oba istodobno → odbijeno', () => {
    expect(parsirajZahtjev({ by: 'x' }).ok).toBe(false)
    expect(parsirajZahtjev({ raspored: R(), zadano: true }).ok).toBe(false)
  })
  test('nevaljan raspored (w=9) i nevaljana osnova se odbijaju', () => {
    const r = R() as any; r.kartice['info-concurrency-card'].w = 9
    expect(parsirajZahtjev({ raspored: r }).ok).toBe(false)
    expect(parsirajZahtjev({ raspored: R(), osnova: 42 }).ok).toBe(false)
  })
})

describe('postavka u bazi', () => {
  test('prazno → raspored null, osnova null', () => {
    expect(getRaspored(svjeza())).toMatchObject({ raspored: null, osnova: null })
  })

  test('spremanje: ključ + JEDAN redak povijesti (source config-raspored), sve u istoj transakciji', () => {
    const db = svjeza()
    const z = parsirajZahtjev({ raspored: R(), osnova: null, by: 'vlasnik' })
    if (!z.ok) throw new Error(z.error)
    const r = setRaspored(db, z.value)
    expect(r.ok).toBe(true)
    const s = getRaspored(db)
    expect(s.raspored).toEqual(R())
    expect(s.osnova).toBeTruthy()
    expect(s.updatedBy).toBe('vlasnik')
    const h = rasporedPovijest(db)
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ key: RASPORED_KLJUC, source: RASPORED_IZVOR, changedBy: 'vlasnik', oldValue: null })
    expect(JSON.parse(h[0].newValue)).toEqual(R())
  })

  test('isti raspored drugi put → bez upisa i bez retka povijesti', () => {
    const db = svjeza()
    const z = parsirajZahtjev({ raspored: R(), osnova: null, by: 'vlasnik' }); if (!z.ok) throw 0
    setRaspored(db, z.value)
    const osnova = getRaspored(db).osnova
    const z2 = parsirajZahtjev({ raspored: R(), osnova, by: 'vlasnik' }); if (!z2.ok) throw 0
    const r = setRaspored(db, z2.value)
    expect(r.ok && r.promjena).toBe(false)
    expect(brojPovijesti(db)).toBe(1)
  })

  test('zastarjela osnova → 409, ništa se ne upisuje', async () => {
    const db = svjeza()
    const a = parsirajZahtjev({ raspored: R(1), osnova: null, by: 'mobitel' }); if (!a.ok) throw 0
    setRaspored(db, a.value)
    const b = parsirajZahtjev({ raspored: R(2), osnova: null, by: 'racunalo' }); if (!b.ok) throw 0
    const r = setRaspored(db, b.value)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
    expect(getRaspored(db).raspored).toEqual(R(1))
    expect(brojPovijesti(db)).toBe(1)
  })

  test('bez polja osnova (curl) nema provjere sukoba', () => {
    const db = svjeza()
    const a = parsirajZahtjev({ raspored: R(1), by: 'curl' }); if (!a.ok) throw 0
    setRaspored(db, a.value)
    const b = parsirajZahtjev({ raspored: R(2), by: 'curl' }); if (!b.ok) throw 0
    expect(setRaspored(db, b.value).ok).toBe(true)
    expect(getRaspored(db).raspored).toEqual(R(2))
  })

  test('spremanje čuva kartice koje ova stranica ne vidi (spoji)', () => {
    const db = svjeza()
    const tudji = { v: 1, redoslijed: ['info-orkestrator-card'], kartice: { 'info-orkestrator-card': { w: 3, h: null } } }
    const a = parsirajZahtjev({ raspored: tudji, by: 'paket' }); if (!a.ok) throw 0
    setRaspored(db, a.value)
    const b = parsirajZahtjev({ raspored: R(), by: 'pogon' }); if (!b.ok) throw 0
    setRaspored(db, b.value)
    const s = getRaspored(db).raspored!
    expect(s.redoslijed).toEqual(['info-autonomija-card', 'info-concurrency-card', 'info-orkestrator-card'])
    expect(s.kartice['info-orkestrator-card']).toEqual({ w: 3, h: null })
  })

  test('zadano: ključ obrisan, povijest „zadano"; zadano bez spremljenog = bez upisa', () => {
    const db = svjeza()
    const z0 = parsirajZahtjev({ zadano: true, by: 'vlasnik' }); if (!z0.ok) throw 0
    const r0 = setRaspored(db, z0.value)
    expect(r0.ok && r0.promjena).toBe(false)
    expect(brojPovijesti(db)).toBe(0)
    const a = parsirajZahtjev({ raspored: R(), by: 'vlasnik' }); if (!a.ok) throw 0
    setRaspored(db, a.value)
    const z = parsirajZahtjev({ zadano: true, osnova: getRaspored(db).osnova, by: 'vlasnik' }); if (!z.ok) throw 0
    const r = setRaspored(db, z.value)
    expect(r.ok && r.promjena).toBe(true)
    expect(getRaspored(db)).toMatchObject({ raspored: null, osnova: null })
    expect(rasporedPovijest(db)[0]).toMatchObject({ newValue: 'zadano', source: RASPORED_IZVOR })
  })

  test('pripremiRaspored (proba) ništa ne piše', () => {
    const db = svjeza()
    const a = parsirajZahtjev({ raspored: R(), by: 'test' }); if (!a.ok) throw 0
    const p = pripremiRaspored(db, a.value)
    expect(p.ok && p.promjena).toBe(true)
    expect(getRaspored(db).raspored).toBeNull()
    expect(brojPovijesti(db)).toBe(0)
  })

  test('ručno pokvaren JSON u bazi → raspored null + razlog (ploča crta zadano)', () => {
    const db = svjeza()
    db.run(`INSERT INTO settings(key,value,updated_by) VALUES (?, ?, 'ruka')`, [RASPORED_KLJUC, '{"v":1,"redoslijed":["x"],"kartice":{}}'])
    const s = getRaspored(db)
    expect(s.raspored).toBeNull()
    expect(s.invalid).toBeTruthy()
  })

  test('povijest drugih ključeva se ne miješa', () => {
    const db = svjeza()
    db.run(`INSERT INTO settings_history(key,old_value,new_value,changed_by,source) VALUES ('agents.max_concurrent','2','3','vlasnik','config')`)
    expect(rasporedPovijest(db)).toHaveLength(0)
  })
})

describe('klijentskaLogikaJS — preglednik dobiva ISTI kod kao poslužitelj', () => {
  const L = new Function('window', 'TextEncoder', klijentskaLogikaJS() + '\nreturn window.CfgRasporedLogika')({}, TextEncoder)

  test('validiraj daje iste odluke', () => {
    const r = R() as any
    expect(L.validiraj(r)).toEqual(validiraj(r))
    const los = { ...R(), maxConcurrent: 3 }
    expect(L.validiraj(los).ok).toBe(false)
    expect(L.validiraj(los)).toEqual(validiraj(los))
  })
  test('poredajSkupinu, spoji, mjere, brojIzmjena i konstante su prisutni', () => {
    const z = ['info-a-card', 'info-b-card']
    expect(L.poredajSkupinu(z, ['info-b-card', 'info-a-card'])).toEqual(poredajSkupinu(z, ['info-b-card', 'info-a-card']))
    expect(L.spoji(null, R())).toEqual(spoji(null, R()))
    expect(L.mjere('info-x-card', null, true)).toEqual({ w: 4, h: null })
    expect(L.brojIzmjena(R(1), R(2))).toBe(1)
    expect([L.STUPACA, L.VIS_MIN, L.VIS_MAX, L.VIS_KORAK, L.VERZIJA]).toEqual([4, 160, 1200, 40, 1])
    expect(L.zaokruziVisinu(333)).toBe(320)
  })
  test('nema backticka ni </script> (sigurno za umetanje)', () => {
    const js = klijentskaLogikaJS()
    expect(js.includes('</script')).toBe(false)
  })
})
