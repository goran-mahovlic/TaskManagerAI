/**
 * ADR-0002 R1 — postavke razgovornog načina (mjerila J2, J3).
 *
 * Autorica: Jelena (Engineer), TASK-5277.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  RAZGOVOR_ZADANO, RAZGOVOR_KLJUCEVI, createRazgovorReader, getRazgovorPostavke,
  parseRazgovorPatch, razgovorPovijest, setRazgovorPostavke,
} from '../src/razgovor/RazgovorPostavke'
import { ensureSettingsSchema } from '../src/core/ConcurrencySetting'

function baza(): Database {
  const db = new Database(':memory:')
  ensureSettingsSchema(db)
  return db
}

describe('zadano stanje', () => {
  test('bez ijednog retka u bazi: razgovor je isključen, zadane vrijednosti iz ADR §4', () => {
    const s = getRazgovorPostavke(baza())
    expect(s.postavke.ukljucen).toBe(false)
    expect(s.postavke.odgovaraNa).toBe('spomen')
    expect(s.postavke.ovlasti).toBe('citanje')
    expect(s.postavke.rokSek).toBe(300)
    expect(s.postavke.maxUsporednih).toBe(2)
    expect(s.postavke.sesijaNeaktivnostMin).toBe(30)
    expect(s.postavke.burstMs).toBe(3000)
    expect(s.postavke.memorijaRazgovor).toBe('off')
    expect(s.postavke).toEqual(RAZGOVOR_ZADANO)
  })

  test('memorija.banka koja već postoji kao običan niz (node-A) se čita doslovno', () => {
    const db = baza()
    db.query(`INSERT INTO settings(key, value) VALUES ('memorija.banka', 'banka_cvora')`).run()
    expect(getRazgovorPostavke(db).postavke.memorijaBanka).toBe('banka_cvora')
  })
})

describe('J2 — upis i audit', () => {
  test('promjena dvaju ključeva = točno dva retka u settings_history', () => {
    const db = baza()
    const p = parseRazgovorPatch({ ukljucen: true, ime: 'Šaban' })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const promjene = setRazgovorPostavke(db, p.value, 'vlasnik', 'ploca')
    expect(promjene.filter(c => c.changed).length).toBe(2)
    const povijest = razgovorPovijest(db)
    expect(povijest.length).toBe(2)
    expect(povijest.map(r => r.kljuc).sort()).toEqual(['razgovor.ime', 'razgovor.ukljucen'])
    expect(povijest[0]!.changedBy).toBe('vlasnik')
    expect(getRazgovorPostavke(db).postavke.ime).toBe('Šaban')
  })

  test('ista vrijednost ponovno = nula novih redaka', () => {
    const db = baza()
    setRazgovorPostavke(db, { ukljucen: true }, 'v', 'ploca')
    setRazgovorPostavke(db, { ukljucen: true }, 'v', 'ploca')
    expect(razgovorPovijest(db).length).toBe(1)
  })

  test('nepoznato polje → odbijeno s popisom dopuštenih', () => {
    const p = parseRazgovorPatch({ ukljucen: true, izmisljeno: 1 })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.greske.join(' ')).toContain('izmisljeno')
    expect(p.dopustena).toContain('ukljucen')
  })

  test.each([
    ['rokSek', 10], ['rokSek', 5000], ['maxUsporednih', 0], ['maxUsporednih', 6],
    ['sesijaNeaktivnostMin', 1], ['burstMs', 20000], ['zadrzavanjeDana', 0],
    ['memorijaRokMs', 100], ['odgovaraNa', 'svima'], ['ovlasti', 'admin'],
    ['memorijaRazgovor', 'da'], ['ukljucen', 'yes'], ['radniDir', 'relativna/putanja'],
    ['memorijaUrl', 'nije-url'], ['ime', 'x'.repeat(41)],
  ])('izvan raspona %s=%p → odbijeno, ne stisnuto', (polje, v) => {
    expect(parseRazgovorPatch({ [polje]: v }).ok).toBe(false)
  })

  test('čitač vidi promjenu nakon isteka keša (≤5 s), bez restarta', () => {
    const mapa = mkdtempSync(join(tmpdir(), 'tm-razg-'))
    try {
      const put = join(mapa, 'tasks.db')
      const db = new Database(put)
      ensureSettingsSchema(db)
      let sada = 1000
      const citaj = createRazgovorReader({ dbPath: put, ttlMs: 5000, now: () => sada })
      expect(citaj().postavke.ukljucen).toBe(false)
      setRazgovorPostavke(db, { ukljucen: true }, 'v', 'ploca')
      expect(citaj().postavke.ukljucen).toBe(false) // još keš
      sada += 5000
      expect(citaj().postavke.ukljucen).toBe(true)
      db.close()
    } finally { rmSync(mapa, { recursive: true, force: true }) }
  })

  test('svi ključevi su razgovor.* ili zajednički memorija.*', () => {
    for (const k of Object.values(RAZGOVOR_KLJUCEVI)) expect(k).toMatch(/^(razgovor|memorija)\./)
    expect(RAZGOVOR_KLJUCEVI.memorijaBanka).toBe('memorija.banka')
  })
})

describe('J3 — ovlasti iznad citanja traže uvjete', () => {
  test('rad uz prazne dopusteniKorisnici → odbijeno', () => {
    const p = parseRazgovorPatch({ ovlasti: 'rad' }, RAZGOVOR_ZADANO)
    expect(p.ok).toBe(false)
  })

  test('rad uz odgovaraNa=sve → odbijeno', () => {
    const p = parseRazgovorPatch({ ovlasti: 'rad', dopusteniKorisnici: ['42'], odgovaraNa: 'sve' }, RAZGOVOR_ZADANO)
    expect(p.ok).toBe(false)
  })

  test('rad uz dopuštene korisnike i spomen → prihvaćeno', () => {
    const p = parseRazgovorPatch({ ovlasti: 'rad', dopusteniKorisnici: ['42'] }, RAZGOVOR_ZADANO)
    expect(p.ok).toBe(true)
  })

  test('puno traži odobrenje vlasnika s ploče (source=ploca)', () => {
    const db = baza()
    expect(() => setRazgovorPostavke(db, { ovlasti: 'puno', dopusteniKorisnici: ['42'] }, 'jelena', 'api'))
      .toThrow()
    const ok = setRazgovorPostavke(db, { ovlasti: 'puno', dopusteniKorisnici: ['42'] }, 'vlasnik', 'ploca')
    expect(ok.some(c => c.kljuc === 'razgovor.ovlasti' && c.changed)).toBe(true)
  })

  test('ručno upisan puno bez uvjeta → čitač spušta na citanje i to javlja', () => {
    const db = baza()
    db.query(`INSERT INTO settings(key, value) VALUES ('razgovor.ovlasti', 'puno')`).run()
    const s = getRazgovorPostavke(db)
    expect(s.postavke.ovlasti).toBe('citanje')
    expect(s.upozorenja.join(' ')).toContain('citanje')
  })

  test('nečitljiva vrijednost u bazi → zadano + upozorenje (fail-safe)', () => {
    const db = baza()
    db.query(`INSERT INTO settings(key, value) VALUES ('razgovor.rokSek', 'smeće')`).run()
    const s = getRazgovorPostavke(db)
    expect(s.postavke.rokSek).toBe(300)
    expect(s.upozorenja.length).toBeGreaterThan(0)
  })
})

describe('J2 — API /api/config/razgovor (čiste funkcije nad bazom)', () => {
  const { razgovorGet, razgovorPut, razgovorPovijestGet } = require('../src/razgovor/RazgovorPloca')

  test('PUT upisuje, GET čita, povijest ima redak po ključu; nepoznato polje → 400 s popisom', () => {
    const mapa = mkdtempSync(join(tmpdir(), 'tm-razg-api-'))
    try {
      const put = join(mapa, 'tasks.db')
      const db = new Database(put); ensureSettingsSchema(db); db.close()
      const r = razgovorPut(put, { ukljucen: true, ime: 'Bot', by: 'vlasnik', source: 'ploca' })
      expect(r.status).toBe(200)
      expect(razgovorGet(put).tijelo.postavke.ukljucen).toBe(true)
      expect(razgovorPovijestGet(put).tijelo.povijest.length).toBe(2)
      const lose = razgovorPut(put, { nepostojece: 1 })
      expect(lose.status).toBe(400)
      expect(lose.tijelo.dopustena).toContain('ukljucen')
      expect(razgovorPut(put, { rokSek: 99999 }).status).toBe(400)
      expect(razgovorPut(put, { ovlasti: 'rad' }).status).toBe(400)
      expect(razgovorPut(put, { ovlasti: 'puno', dopusteniKorisnici: ['1'], source: 'api' }).status).toBe(400)
    } finally { rmSync(mapa, { recursive: true, force: true }) }
  })
})
