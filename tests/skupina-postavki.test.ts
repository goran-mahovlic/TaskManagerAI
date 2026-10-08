/**
 * TASK-5346: jedna skupina postavki = jedan „Spremi” (jezgra, bez poslužitelja).
 *  • cijela skupina u jednom pozivu, JEDAN redak u settings_history s popisom promijenjenih ključeva;
 *  • djelomično nevaljana skupina ne zapisuje NIŠTA, a pogreška stoji uz polje koje ju je izazvalo;
 *  • prazno polje tajne = ne mijenjaj postojeću vrijednost; vrijednost tajne nikad u audit ni odgovor.
 */
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spremiSkupinu, listovi, type SkupinaZapis } from '../src/core/SkupinaPostavki'
import { ensureSettingsSchema } from '../src/core/ConcurrencySetting'

/** Lažni modul postavki: provjera po polju (port 1–65535, host neprazan), upis broji pozive. */
function lazniModul(pocetno: any) {
  let stanje = structuredClone(pocetno)
  let upisa = 0
  const zapis: SkupinaZapis = {
    load: () => structuredClone(stanje),
    validate: (t: any) => {
      const greske: string[] = []
      const z = t && typeof t === 'object' ? t : {}
      if (z.smtp?.port !== undefined && !(Number.isInteger(z.smtp.port) && z.smtp.port >= 1 && z.smtp.port <= 65535)) greske.push('smtp.port mora biti 1–65535')
      if (z.smtp?.host !== undefined && !String(z.smtp.host).trim()) greske.push('smtp.host ne smije biti prazan')
      for (const k of Object.keys(z)) if (!['ukljucen', 'smtp', 'lozinka'].includes(k)) greske.push(`Nepoznato polje: ${k}`)
      return { ok: greske.length === 0, greske, zakrpa: z }
    },
    save: (z: any) => {
      upisa++
      stanje = { ...stanje, ...z, smtp: { ...stanje.smtp, ...(z.smtp || {}) } }
      return structuredClone(stanje)
    },
    tajne: ['lozinka'],
    odgovor: (p: any) => ({ ...p, lozinka: undefined, lozinkaPostavljena: !!p.lozinka }),
  }
  return { zapis, upisa: () => upisa, stanje: () => stanje }
}

function baza() {
  const db = new Database(':memory:')
  ensureSettingsSchema(db)
  return db
}
const redovi = (db: Database) => db.query('SELECT key, old_value, new_value, changed_by, source FROM settings_history ORDER BY id').all() as any[]

const POCETNO = { ukljucen: false, smtp: { host: 'mail.primjer.hr', port: 587, korisnik: 'ana' }, lozinka: 'STARA-TAJNA-123' }

describe('listovi — staze listova zakrpe', () => {
  test('ugniježđeni objekti postaju staze s točkom, popisi su list', () => {
    expect(listovi({ a: 1, b: { c: 2, d: [1, 2] }, e: [] }).sort()).toEqual(['a', 'b.c', 'b.d', 'e'])
  })
})

describe('spremiSkupinu', () => {
  test('cijela skupina jednim pozivom → jedan upis, jedan audit redak s popisom ključeva', () => {
    const m = lazniModul(POCETNO); const db = baza()
    const r = spremiSkupinu('email', m.zapis, { polja: { ukljucen: true, smtp: { host: 'smtp.novi.hr', port: 465, korisnik: 'ana' } }, by: 'vlasnik' }, db)
    expect(r.status).toBe(200)
    expect(r.tijelo.ok).toBe(true)
    // korisnik je poslan, ali nije promijenjen → nije u popisu
    expect(r.tijelo.promijenjeno).toEqual(['smtp.host', 'smtp.port', 'ukljucen'])
    expect(m.upisa()).toBe(1)
    expect(m.stanje().smtp).toEqual({ host: 'smtp.novi.hr', port: 465, korisnik: 'ana' })
    const rr = redovi(db)
    expect(rr.length).toBe(1)
    expect(rr[0]).toMatchObject({ key: 'skupina.email', old_value: null, changed_by: 'vlasnik', source: 'config-skupina' })
    expect(JSON.parse(rr[0].new_value)).toEqual({ kljucevi: ['smtp.host', 'smtp.port', 'ukljucen'] })
  })

  test('djelomično nevaljana skupina ne zapisuje NIŠTA; pogreška stoji uz polje', () => {
    const m = lazniModul(POCETNO); const db = baza()
    const r = spremiSkupinu('email', m.zapis, { polja: { ukljucen: true, smtp: { host: 'smtp.novi.hr', port: 99999 } } }, db)
    expect(r.status).toBe(400)
    expect(r.tijelo.ok).toBe(false)
    expect(Object.keys(r.tijelo.greskePoPolju)).toEqual(['smtp.port'])
    expect(r.tijelo.greskePoPolju['smtp.port'][0]).toContain('65535')
    expect(m.upisa()).toBe(0)
    expect(m.stanje()).toEqual(POCETNO)
    expect(redovi(db).length).toBe(0)
  })

  test('pogreška koja ne pripada nijednom polju ide u opće, i dalje bez upisa', () => {
    const m = lazniModul(POCETNO); const db = baza()
    const r = spremiSkupinu('email', m.zapis, { polja: { nepostojece: 1 } }, db)
    expect(r.status).toBe(400)
    expect(r.tijelo.greske.join(' ')).toContain('Nepoznato polje')
    expect(m.upisa()).toBe(0)
  })

  test('prazna lozinka ne briše postojeću; audit ni odgovor ne nose vrijednost tajne', () => {
    const m = lazniModul(POCETNO); const db = baza()
    const r = spremiSkupinu('email', m.zapis, { polja: { lozinka: '', smtp: { host: 'drugi.hr' } } }, db)
    expect(r.status).toBe(200)
    expect(m.stanje().lozinka).toBe('STARA-TAJNA-123')
    expect(r.tijelo.promijenjeno).toEqual(['smtp.host'])
    const r2 = spremiSkupinu('email', m.zapis, { polja: { lozinka: 'NOVA-TAJNA-456' } }, db)
    expect(r2.status).toBe(200)
    expect(m.stanje().lozinka).toBe('NOVA-TAJNA-456')
    expect(r2.tijelo.promijenjeno).toEqual(['lozinka'])
    const sve = JSON.stringify(redovi(db)) + JSON.stringify(r.tijelo) + JSON.stringify(r2.tijelo)
    expect(sve).not.toContain('NOVA-TAJNA-456')
    expect(sve).not.toContain('STARA-TAJNA-123')
    expect(r2.tijelo.postavke.lozinkaPostavljena).toBe(true)
  })

  test('samo prazna tajna (nema izmjena) → 200 bez upisa i bez audita', () => {
    const m = lazniModul(POCETNO); const db = baza()
    const r = spremiSkupinu('email', m.zapis, { polja: { lozinka: '' } }, db)
    expect(r.status).toBe(200)
    expect(r.tijelo.promijenjeno).toEqual([])
    expect(m.upisa()).toBe(0)
    expect(redovi(db).length).toBe(0)
  })

  test('tijelo bez objekta polja → 400', () => {
    const m = lazniModul(POCETNO); const db = baza()
    expect(spremiSkupinu('email', m.zapis, { polja: [1] }, db).status).toBe(400)
    expect(spremiSkupinu('email', m.zapis, null, db).status).toBe(400)
    expect(m.upisa()).toBe(0)
  })

  test('__proto__ / constructor / prototype u stazi → 400, bez zagađenja prototipa i bez upisa', () => {
    const m = lazniModul(POCETNO); const db = baza()
    for (const sirovo of ['{"polja":{"__proto__":{"zagadjeno":1}}}', '{"polja":{"smtp":{"constructor":{"prototype":{"zagadjeno":1}}}}}']) {
      const r = spremiSkupinu('email', m.zapis, JSON.parse(sirovo), db)
      expect(r.status).toBe(400)
    }
    expect(({} as any).zagadjeno).toBeUndefined()
    expect(m.upisa()).toBe(0)
    expect(redovi(db).length).toBe(0)
  })

  test('greška upisa (500) ne ostavlja audit', () => {
    const m = lazniModul(POCETNO); const db = baza()
    m.zapis.save = () => { throw new Error('disk pun') }
    const r = spremiSkupinu('email', m.zapis, { polja: { ukljucen: true } }, db)
    expect(r.status).toBe(500)
    expect(redovi(db).length).toBe(0)
  })
})
