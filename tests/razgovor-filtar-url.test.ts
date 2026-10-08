/**
 * TASK-5373 — node-A: filtar „za drugoga" uhvatio „Goran" unutar URL-a (`?s=goran`) u
 * vlasnikovoj poruci i Šaban je šutio na nalog. Pravila:
 *  1. riječ s popisa `preskociAkoSadrzi` ne traži se unutar URL-ova, e-mail adresa ni `code`;
 *  2. vlasnikovo vlastito ime ne utišava vlasnikovu poruku (OD Gorana ≠ ZA Gorana);
 *  3. utišana poruka dopuštenog korisnika dobije kratku napomenu u chatu — jednom po sesiji.
 *
 * Autorica: Jelena (Engineer), TASK-5373.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { bezAdresaIKoda, razlogZaDrugog, sadrziRijec, trebaOdgovoriti } from '../src/razgovor/Filtar'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-r5373-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

// node-A 08.10.: Goran (vlasnik, 5284452279) i Tomislava dopušteni; Bubi i Klaudio su drugi.
const GORAN = '5284452279'
const NODEA: RazgovorPostavke = {
  ...RAZGOVOR_ZADANO, ukljucen: true, ime: 'Šaban', odgovaraNa: 'dopusteni-sve',
  dopusteniKorisnici: [GORAN, '77'], preskociAkoSadrzi: ['Bubi', 'Goran', '@klaudioAI_bot'],
  tisinaKadDrugom: false, vlasnici: [GORAN],
}

const por = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'telegram', chatId: '-5112799687', porukaId: '1', posiljateljId: GORAN, posiljateljIme: 'Goran',
  posiljateljKorisnickoIme: 'goranmahovlic', posiljateljJeBot: false, tekst: 'bok',
  ts: '2026-10-08T11:18:14Z', privatno: false, obracanjeBotu: false, ...o,
})
const TOMISLAVA = { posiljateljId: '77', posiljateljIme: 'Tomislava', posiljateljKorisnickoIme: 'tomislava' }

const NALOG = 'Napravi mi najavu za radionicu Meshtastic, link https://radiona.org/?s=goran'

describe('bezAdresaIKoda — URL, e-mail i code se ne pretražuju', () => {
  test.each([
    ['https://radiona.org/?s=goran', ''],
    ['vidi www.goran.hr sad', 'vidi   sad'],
    ['piši na goran@radiona.org', 'piši na  '],
    ['naredba `grep goran` radi', 'naredba   radi'],
    ['```\ngoran\n```', ' '],
  ])('%s', (ulaz, izlaz) => {
    expect(bezAdresaIKoda(ulaz).replace(/\s+/g, ' ').trim()).toBe(izlaz.replace(/\s+/g, ' ').trim())
  })
})

describe('sadrziRijec ne gleda unutar URL-a, e-maila ni koda', () => {
  test.each([
    ['link https://x/?s=goran', 'Goran', false],
    ['http://goran.example/put', 'Goran', false],
    ['www.goran.hr', 'Goran', false],
    ['mail goran@radiona.org', 'Goran', false],
    ['mail ivan@goran.hr', 'Goran', false],
    ['`goran`', 'Goran', false],
    ['```goran je tu```', 'Goran', false],
    ['Goran, vidi https://x/?s=bubi', 'Goran', true],
    ['javi @klaudioAI_bot', '@klaudioAI_bot', true],
    ['https://t.me/klaudioAI_bot', '@klaudioAI_bot', false],
  ])('„%s" ⊃ %s → %s', (tekst, rijec, ok) => {
    expect(sadrziRijec(tekst, rijec)).toBe(ok)
  })
})

describe('TASK-5373 prihvatni slučajevi (Filtar)', () => {
  test('Goran (vlasnik) s https://x/?s=goran → odgovor', () => {
    expect(razlogZaDrugog(por({ tekst: 'pogledaj https://x/?s=goran' }), NODEA)).toBeNull()
    expect(trebaOdgovoriti(por({ tekst: NALOG }), NODEA)).toBe(true)
  })
  test('vlasnikovo ime u vlasnikovoj poruci ne utišava (OD Gorana ≠ ZA Gorana)', () => {
    expect(trebaOdgovoriti(por({ tekst: 'Goran ovdje — napravi najavu' }), NODEA)).toBe(true)
  })
  test('vlasnik i dalje šuti kad piše drugome s popisa (Bubi)', () => {
    expect(razlogZaDrugog(por({ tekst: 'Bubi, javi se' }), NODEA)).toBe('sadrži „Bubi"')
    expect(trebaOdgovoriti(por({ tekst: 'Bubi, javi se' }), NODEA)).toBe(false)
  })
  test('„Goran, …" od Tomislave → šuti', () => {
    expect(razlogZaDrugog(por({ ...TOMISLAVA, tekst: 'Goran, jesi vidio?' }), NODEA)).toBe('sadrži „Goran"')
    expect(trebaOdgovoriti(por({ ...TOMISLAVA, tekst: 'Goran, jesi vidio?' }), NODEA)).toBe(false)
  })
  test('poruka s @klaudioAI_bot → šuti (i od vlasnika)', () => {
    expect(trebaOdgovoriti(por({ tekst: '@klaudioAI_bot što ima?', spomeni: ['klaudioai_bot'] }), NODEA)).toBe(false)
    expect(trebaOdgovoriti(por({ ...TOMISLAVA, tekst: '@klaudioAI_bot što ima?' }), NODEA)).toBe(false)
  })
  test('ime na popisu koje NIJE pošiljateljevo ne izuzima: Tomislava piše „Goran ovdje"', () => {
    expect(trebaOdgovoriti(por({ ...TOMISLAVA, tekst: 'Goran ovdje' }), NODEA)).toBe(false)
  })
  test('vlasnik koji NIJE dopušteni korisnik nema iznimku (oba uvjeta)', () => {
    const s = { ...NODEA, dopusteniKorisnici: ['77'] }
    expect(razlogZaDrugog(por({ tekst: 'Goran ovdje' }), s)).toBe('sadrži „Goran"')
  })
  test('bez popisa vlasnika (nema tajne.json/VLASNIK_UID) staro ponašanje', () => {
    const s = { ...NODEA, vlasnici: [] }
    expect(razlogZaDrugog(por({ tekst: 'Goran ovdje' }), s)).toBe('sadrži „Goran"')
    expect(razlogZaDrugog(por({ tekst: NALOG }), s)).toBeNull()
  })
})

describe('Jezgra — napomena kad je dopušteni utišan (jednom po sesiji)', () => {
  function sklopi(sat: { t: number }) {
    const poslano: string[] = []
    const konzola: string[] = []
    const zahtjevi: ExecRequest[] = []
    const kanal = { ime: 'telegram', maxDuljinaPoruke: 4096, maxDokumentBajta: 1024,
      async posaljiTekst(_c: string, t: string) { poslano.push(t); return true }, async posaljiDokument() { return true } } as unknown as Kanal
    const r = stvoriRazgovor({
      postavke: () => ({ ...NODEA, burstMs: 0, radniDir: join(mapa, 'radni') }),
      izvrsitelj: { ime: 'l', async run(q: ExecRequest): Promise<ExecResult> { zahtjevi.push(q); return { exitCode: 0, resultText: 'evo najave', sessionId: 'S', numTurns: 1 } } } as any,
      jePauza: () => false, kvotaPuna: () => false, korijen: join(mapa, 'razgovor'), tmHome: mapa, home: mapa, port: 1,
      plocaUrl: 'http://x', instalacija: 't', env: {}, log: () => {}, sat: () => sat.t,
      konzola: r => konzola.push(r),
    })
    return { r, kanal, poslano, konzola, zahtjevi }
  }

  test('Goranov nalog s ?s=goran ide modelu (prihvatni slučaj iz 11:18Z)', async () => {
    const { r, kanal, zahtjevi, poslano } = sklopi({ t: Date.parse('2026-10-08T11:18:14Z') })
    r.primi(por({ tekst: NALOG }), kanal)
    await r.mirno()
    expect(zahtjevi.length).toBe(1)
    expect(poslano.some(t => t.includes('evo najave'))).toBe(true)
  })

  test('utišan dopušteni → jedna kratka napomena po sesiji, nedopušteni bez napomene', async () => {
    const sat = { t: Date.parse('2026-10-08T11:00:00Z') }
    const { r, kanal, poslano, zahtjevi, konzola } = sklopi(sat)
    r.primi(por({ tekst: 'Bubi, javi se' }), kanal)
    await r.mirno()
    r.primi(por({ ...TOMISLAVA, tekst: 'Goran, jesi vidio?' }), kanal)
    await r.mirno()
    expect(zahtjevi.length).toBe(0)
    expect(poslano.length).toBe(1)
    expect(poslano[0]).toContain('Bubi')
    expect(poslano[0]).toContain('Šaban')
    expect(konzola.some(k => k.includes('napomena'))).toBe(true)
    // Nedopušteni nikad ne dobiva napomenu.
    sat.t += 3 * 3600_000
    r.primi(por({ posiljateljId: '9', posiljateljIme: 'Neki', posiljateljKorisnickoIme: 'neki', tekst: 'Goran, bok' }), kanal)
    await r.mirno()
    expect(poslano.length).toBe(1)
    // Nova sesija (iza neaktivnosti) → opet jedna napomena.
    r.primi(por({ tekst: 'Bubi, a sad?' }), kanal)
    await r.mirno()
    expect(poslano.length).toBe(2)
  })
})

describe('sklopiRazgovor — vlasnik iz primatelja koda ide u postavke filtra', () => {
  test('postavke() nose `vlasnici`; kvar čitanja = prazno', async () => {
    const { sklopiRazgovor } = await import('../src/razgovor/RazgovorPloca')
    const osnova = {
      dbPath: join(mapa, 'tm.db'), dataDir: mapa, modelConfigPath: join(mapa, 'mc.json'),
      jePauza: () => false, kvotaPuna: () => false, tmHome: mapa, home: mapa, port: 1,
      plocaUrl: 'http://x', instalacija: 't', env: {}, log: () => {},
    }
    expect(sklopiRazgovor({ ...osnova, vlasnici: () => [GORAN] }).ulaz.postavke().vlasnici).toEqual([GORAN])
    expect(sklopiRazgovor({ ...osnova, vlasnici: () => { throw new Error('x') } }).ulaz.postavke().vlasnici).toEqual([])
    expect(sklopiRazgovor(osnova).ulaz.postavke().vlasnici).toEqual([])
  })
})
