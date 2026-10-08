/**
 * TASK-5378 (dorada TASK-5371): obavijest o zadatku e-poštom.
 *
 * Kvar s node-A (08.10.): svaki PUT zadatka (in_progress, blocked, completed — i QA probe)
 * slao je mail svim primateljima. Sada:
 *   • obavijest je ZASEBNA postavka `obavijestZadatak.ukljucena`, zadano isključena;
 *   • ide samo na PRIJELAZ u odabrani status, a in_progress/pending se ne mogu ni odabrati;
 *   • probni zadatak (biljeg `x-regoc-proba: 1`, oznake qa/proba, QA autor) ne šalje ništa;
 *   • strop N mailova na sat po primatelju, višak ide u JEDAN sažetak kad se prozor otvori.
 * Bez mreže: slanje je podmetnuto, sat je lažni.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ZADANE_POSTAVKE, validateEmailPatch } from '../src/EmailConfig'
import { Obavjestavac, jeProbniZadatak } from '../src/ObavijestZadatka'

let mapa: string, put: string
const SAT = 3600_000

function zapisi(obavijest: Record<string, unknown>, primatelji = ['vlasnik@primjer.test']) {
  writeFileSync(put, JSON.stringify({
    ...ZADANE_POSTAVKE, ukljucen: true, smjer: 'izlaz', primatelji,
    smtp: { ...ZADANE_POSTAVKE.smtp, host: 'smtp.primjer.test', korisnik: 'bot', posiljatelj: 'bot@primjer.test' },
    obavijestZadatak: obavijest,
  }))
}

function napravi(maxNaSat = 10) {
  let sada = 1_000_000
  const poslano: { naslov: string; tekst: string; prima: string[] }[] = []
  const zakazano: { ms: number; fn: () => void }[] = []
  const o = new Obavjestavac({
    putanja: put,
    sada: () => sada,
    posalji: async (naslov, tekst, prima) => { poslano.push({ naslov, tekst, prima }); return { ok: true } },
    zakazi: (fn, ms) => { zakazano.push({ fn, ms }) },
  })
  return { o, poslano, zakazano, pomakni: (ms: number) => { sada += ms }, maxNaSat }
}

const zad = (id: string, status: string, x: Partial<{ tags: unknown; createdBy: string }> = {}) =>
  ({ id, title: `naslov ${id}`, status, tags: x.tags ?? [], createdBy: x.createdBy ?? 'vlasnik' })

beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-obav-'))
  put = join(mapa, 'email.json')
})
afterEach(() => rmSync(mapa, { recursive: true, force: true }))

describe('postavka', () => {
  test('zadano je obavijest o zadatku ISKLJUČENA — ni completed ne šalje', async () => {
    writeFileSync(put, JSON.stringify({
      ...ZADANE_POSTAVKE, ukljucen: true, smjer: 'oba', primatelji: ['vlasnik@primjer.test'],
      smtp: { ...ZADANE_POSTAVKE.smtp, host: 'smtp.primjer.test' },
    }))
    expect(ZADANE_POSTAVKE.obavijestZadatak.ukljucena).toBe(false)
    const { o, poslano } = napravi()
    const r = await o.obavijesti(zad('TASK-1', 'completed'), 'in_progress')
    expect(r.poslano).toEqual([])
    expect(r.razlog).toContain('isključena')
    expect(poslano.length).toBe(0)
  })

  test('in_progress se ne može odabrati na kartici (400), completed/blocked mogu', () => {
    const los = validateEmailPatch({ obavijestZadatak: { statusi: ['completed', 'in_progress'] } })
    expect(los.ok).toBe(false)
    expect(los.greske.join(' ')).toContain('in_progress')
    const dobar = validateEmailPatch({ obavijestZadatak: { ukljucena: true, statusi: ['completed', 'blocked'], najviseNaSat: 5 } })
    expect(dobar.ok).toBe(true)
  })
})

describe('samo odabrani prijelaz', () => {
  test('uključeno samo za completed: completed = 1 mail, in_progress i blocked = 0', async () => {
    zapisi({ ukljucena: true, statusi: ['completed'], najviseNaSat: 10 })
    const { o, poslano } = napravi()
    expect((await o.obavijesti(zad('TASK-1', 'in_progress'), 'pending')).poslano).toEqual([])
    expect((await o.obavijesti(zad('TASK-1', 'blocked'), 'in_progress')).poslano).toEqual([])
    expect((await o.obavijesti(zad('TASK-1', 'completed'), 'blocked')).poslano).toEqual(['vlasnik@primjer.test'])
    expect(poslano.length).toBe(1)
    expect(poslano[0].naslov).toContain('TASK-1')
    expect(poslano[0].prima).toEqual(['vlasnik@primjer.test'])
  })

  test('isti status ponovno (PUT bilješke ili completed → completed) ne šalje', async () => {
    zapisi({ ukljucena: true, statusi: ['completed'], najviseNaSat: 10 })
    const { o, poslano } = napravi()
    await o.obavijesti(zad('TASK-1', 'completed'), 'completed')
    expect(poslano.length).toBe(0)
  })

  test('in_progress ručno upisan u datoteku i dalje ne šalje', async () => {
    zapisi({ ukljucena: true, statusi: ['in_progress', 'completed'], najviseNaSat: 10 })
    const { o, poslano } = napravi()
    await o.obavijesti(zad('TASK-1', 'in_progress'), 'pending')
    expect(poslano.length).toBe(0)
  })

  test('glavni prekidač e-pošte isključen ili smjer samo ulaz → ništa', async () => {
    writeFileSync(put, JSON.stringify({ ...ZADANE_POSTAVKE, ukljucen: false, primatelji: ['a@b.hr'], obavijestZadatak: { ukljucena: true, statusi: ['completed'], najviseNaSat: 10 } }))
    const { o, poslano } = napravi()
    await o.obavijesti(zad('TASK-1', 'completed'), 'in_progress')
    writeFileSync(put, JSON.stringify({ ...ZADANE_POSTAVKE, ukljucen: true, smjer: 'ulaz', primatelji: ['a@b.hr'], obavijestZadatak: { ukljucena: true, statusi: ['completed'], najviseNaSat: 10 } }))
    await o.obavijesti(zad('TASK-1', 'completed'), 'in_progress')
    expect(poslano.length).toBe(0)
  })
})

describe('probni zadatak ne šalje NIŠTA', () => {
  test('prepoznavanje probe: biljeg, oznake qa/proba/qa-*, QA autor', () => {
    expect(jeProbniZadatak({ tags: ['qa', 'qa-5312'] })).toBe(true)
    expect(jeProbniZadatak({ tags: '["proba"]' })).toBe(true)
    expect(jeProbniZadatak({ tags: ['QA-5312b'] })).toBe(true)
    expect(jeProbniZadatak({ tags: [], createdBy: 'potjeh' })).toBe(true)
    expect(jeProbniZadatak({ tags: [], createdBy: 'qa' })).toBe(true)
    expect(jeProbniZadatak({ tags: ['nalog'] }, { biljeg: '1' })).toBe(true)
    expect(jeProbniZadatak({ tags: ['nalog', 'kvaliteta'], createdBy: 'vlasnik' })).toBe(false)
    expect(jeProbniZadatak({ tags: ['nalog'] }, { biljeg: null })).toBe(false)
  })

  test('QA proba (oznake kao TASK-341 na node-A) uz uključenu obavijest → 0 mailova', async () => {
    zapisi({ ukljucena: true, statusi: ['completed', 'blocked'], najviseNaSat: 10 })
    const { o, poslano } = napravi()
    const r = await o.obavijesti(zad('TASK-341', 'completed', { tags: ['qa', 'qa-5312', 'nalog'], createdBy: 'potjeh' }), 'in_progress')
    expect(r.razlog).toContain('prob')
    await o.obavijesti(zad('TASK-340', 'blocked', { tags: ['qa'] }), 'in_progress')
    await o.obavijesti(zad('TASK-9', 'completed'), 'in_progress', { biljeg: '1' })
    expect(poslano.length).toBe(0)
  })
})

describe('strop po primatelju', () => {
  test('3 na sat: 5 prijelaza = 3 pojedinačna + jedan sažetak (2 stavke) kad se prozor otvori', async () => {
    zapisi({ ukljucena: true, statusi: ['completed'], najviseNaSat: 3 })
    const { o, poslano, zakazano, pomakni } = napravi()
    const ishodi = []
    for (let i = 1; i <= 5; i++) { ishodi.push(await o.obavijesti(zad(`TASK-${i}`, 'completed'), 'in_progress')); pomakni(1000) }
    expect(poslano.length).toBe(3)
    expect(ishodi[3].uSazetak).toEqual(['vlasnik@primjer.test'])
    expect(ishodi[4].uSazetak).toEqual(['vlasnik@primjer.test'])
    // sažetak je zakazan JEDNOM, za trenutak kad najstariji mail ispadne iz prozora od sat vremena
    expect(zakazano.length).toBe(1)
    expect(zakazano[0].ms).toBeGreaterThan(SAT - 10_000)
    expect(zakazano[0].ms).toBeLessThanOrEqual(SAT)

    // prije isteka prozora pražnjenje ne šalje ništa
    expect(await o.isprazniSazetke()).toBe(0)
    pomakni(SAT)
    expect(await o.isprazniSazetke()).toBe(1)
    expect(poslano.length).toBe(4)
    const s = poslano[3]
    expect(s.naslov).toContain('2')
    expect(s.tekst).toContain('TASK-4')
    expect(s.tekst).toContain('TASK-5')
    expect(s.prima).toEqual(['vlasnik@primjer.test'])
    // ponovno pražnjenje nema što poslati
    expect(await o.isprazniSazetke()).toBe(0)
  })

  test('strop se broji PO PRIMATELJU: punjenje jednoga ne zatvara drugoga', async () => {
    zapisi({ ukljucena: true, statusi: ['completed'], najviseNaSat: 2 }, ['a@primjer.test'])
    const { o, poslano } = napravi()
    await o.obavijesti(zad('TASK-1', 'completed'), 'in_progress')
    await o.obavijesti(zad('TASK-2', 'completed'), 'in_progress')
    await o.obavijesti(zad('TASK-3', 'completed'), 'in_progress') // a@ je pun
    zapisi({ ukljucena: true, statusi: ['completed'], najviseNaSat: 2 }, ['a@primjer.test', 'b@primjer.test'])
    const r = await o.obavijesti(zad('TASK-4', 'completed'), 'in_progress')
    expect(r.poslano).toEqual(['b@primjer.test'])
    expect(r.uSazetak).toEqual(['a@primjer.test'])
    expect(poslano.filter(p => p.prima[0] === 'a@primjer.test').length).toBe(2)
  })

  test('neuspjelo slanje ne troši mjesto u stropu', async () => {
    zapisi({ ukljucena: true, statusi: ['completed'], najviseNaSat: 1 })
    let pokusaja = 0
    const o = new Obavjestavac({
      putanja: put, sada: () => 0, zakazi: () => {},
      posalji: async () => { pokusaja++; return pokusaja === 1 ? { ok: false, greska: 'smtp pao' } : { ok: true } },
    })
    expect((await o.obavijesti(zad('TASK-1', 'completed'), 'in_progress')).poslano).toEqual([])
    expect((await o.obavijesti(zad('TASK-2', 'completed'), 'in_progress')).poslano).toEqual(['vlasnik@primjer.test'])
  })
})
