/**
 * TASK-5373 — node-A: filtar „za drugoga" uhvatio „Ivan" unutar URL-a (`?s=ivan`) u
 * vlasnikovoj poruci i Pomoćnik je šutio na nalog. Pravila:
 *  1. riječ s popisa `preskociAkoSadrzi` ne traži se unutar URL-ova, e-mail adresa ni `code`;
 *  2. vlasnikovo vlastito ime ne utišava vlasnikovu poruku (OD Ivana ≠ ZA Ivana);
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

// node-A 08.10.: Ivan (vlasnik, 1001) i Ana dopušteni; Robi i Klaudio su drugi.
const VLASNIK = '1001'
const NODEA: RazgovorPostavke = {
  ...RAZGOVOR_ZADANO, ukljucen: true, ime: 'Pomoćnik', odgovaraNa: 'dopusteni-sve',
  dopusteniKorisnici: [VLASNIK, '77'], preskociAkoSadrzi: ['Robi', 'Ivan', '@drugiAI_bot'],
  tisinaKadDrugom: false, vlasnici: [VLASNIK],
}

const por = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'telegram', chatId: '-100', porukaId: '1', posiljateljId: VLASNIK, posiljateljIme: 'Ivan',
  posiljateljKorisnickoIme: 'ivan_k', posiljateljJeBot: false, tekst: 'bok',
  ts: '2026-10-08T11:18:14Z', privatno: false, obracanjeBotu: false, ...o,
})
const ANA = { posiljateljId: '77', posiljateljIme: 'Ana', posiljateljKorisnickoIme: 'ana' }

const NALOG = 'Napravi mi najavu za radionicu Meshtastic, link https://primjer.org/?s=ivan'

describe('bezAdresaIKoda — URL, e-mail i code se ne pretražuju', () => {
  test.each([
    ['https://primjer.org/?s=ivan', ''],
    ['vidi www.ivan.hr sad', 'vidi   sad'],
    ['piši na ivan@primjer.org', 'piši na  '],
    ['naredba `grep ivan` radi', 'naredba   radi'],
    ['```\nivan\n```', ' '],
  ])('%s', (ulaz, izlaz) => {
    expect(bezAdresaIKoda(ulaz).replace(/\s+/g, ' ').trim()).toBe(izlaz.replace(/\s+/g, ' ').trim())
  })
})

describe('sadrziRijec ne gleda unutar URL-a, e-maila ni koda', () => {
  test.each([
    ['link https://x/?s=ivan', 'Ivan', false],
    ['http://ivan.example/put', 'Ivan', false],
    ['www.ivan.hr', 'Ivan', false],
    ['mail ivan@primjer.org', 'Ivan', false],
    ['mail ivan@ivan.hr', 'Ivan', false],
    ['`ivan`', 'Ivan', false],
    ['```ivan je tu```', 'Ivan', false],
    ['Ivan, vidi https://x/?s=bubi', 'Ivan', true],
    ['javi @drugiAI_bot', '@drugiAI_bot', true],
    ['https://t.me/drugiAI_bot', '@drugiAI_bot', false],
  ])('„%s" ⊃ %s → %s', (tekst, rijec, ok) => {
    expect(sadrziRijec(tekst, rijec)).toBe(ok)
  })
})

describe('TASK-5373 prihvatni slučajevi (Filtar)', () => {
  test('Ivan (vlasnik) s https://x/?s=ivan → odgovor', () => {
    expect(razlogZaDrugog(por({ tekst: 'pogledaj https://x/?s=ivan' }), NODEA)).toBeNull()
    expect(trebaOdgovoriti(por({ tekst: NALOG }), NODEA)).toBe(true)
  })
  test('vlasnikovo ime u vlasnikovoj poruci ne utišava (OD Ivana ≠ ZA Ivana)', () => {
    expect(trebaOdgovoriti(por({ tekst: 'Ivan ovdje — napravi najavu' }), NODEA)).toBe(true)
  })
  test('vlasnik i dalje šuti kad piše drugome s popisa (Robi)', () => {
    expect(razlogZaDrugog(por({ tekst: 'Robi, javi se' }), NODEA)).toBe('sadrži „Robi"')
    expect(trebaOdgovoriti(por({ tekst: 'Robi, javi se' }), NODEA)).toBe(false)
  })
  test('„Ivan, …" od Ane → šuti', () => {
    expect(razlogZaDrugog(por({ ...ANA, tekst: 'Ivan, jesi vidio?' }), NODEA)).toBe('sadrži „Ivan"')
    expect(trebaOdgovoriti(por({ ...ANA, tekst: 'Ivan, jesi vidio?' }), NODEA)).toBe(false)
  })
  test('poruka s @drugiAI_bot → šuti (i od vlasnika)', () => {
    expect(trebaOdgovoriti(por({ tekst: '@drugiAI_bot što ima?', spomeni: ['drugiai_bot'] }), NODEA)).toBe(false)
    expect(trebaOdgovoriti(por({ ...ANA, tekst: '@drugiAI_bot što ima?' }), NODEA)).toBe(false)
  })
  test('ime na popisu koje NIJE pošiljateljevo ne izuzima: Ana piše „Ivan ovdje"', () => {
    expect(trebaOdgovoriti(por({ ...ANA, tekst: 'Ivan ovdje' }), NODEA)).toBe(false)
  })
  test('vlasnik koji NIJE dopušteni korisnik nema iznimku (oba uvjeta)', () => {
    const s = { ...NODEA, dopusteniKorisnici: ['77'] }
    expect(razlogZaDrugog(por({ tekst: 'Ivan ovdje' }), s)).toBe('sadrži „Ivan"')
  })
  test('bez popisa vlasnika (nema tajne.json/VLASNIK_UID) staro ponašanje', () => {
    const s = { ...NODEA, vlasnici: [] }
    expect(razlogZaDrugog(por({ tekst: 'Ivan ovdje' }), s)).toBe('sadrži „Ivan"')
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

  test('Ivanov nalog s ?s=ivan ide modelu (prihvatni slučaj iz 11:18Z)', async () => {
    const { r, kanal, zahtjevi, poslano } = sklopi({ t: Date.parse('2026-10-08T11:18:14Z') })
    r.primi(por({ tekst: NALOG }), kanal)
    await r.mirno()
    expect(zahtjevi.length).toBe(1)
    expect(poslano.some(t => t.includes('evo najave'))).toBe(true)
  })

  test('utišan dopušteni → jedna kratka napomena po sesiji, nedopušteni bez napomene', async () => {
    const sat = { t: Date.parse('2026-10-08T11:00:00Z') }
    const { r, kanal, poslano, zahtjevi, konzola } = sklopi(sat)
    r.primi(por({ tekst: 'Robi, javi se' }), kanal)
    await r.mirno()
    r.primi(por({ ...ANA, tekst: 'Ivan, jesi vidio?' }), kanal)
    await r.mirno()
    expect(zahtjevi.length).toBe(0)
    expect(poslano.length).toBe(1)
    expect(poslano[0]).toContain('Robi')
    expect(poslano[0]).toContain('Pomoćnik')
    expect(konzola.some(k => k.includes('napomena'))).toBe(true)
    // Nedopušteni nikad ne dobiva napomenu.
    sat.t += 3 * 3600_000
    r.primi(por({ posiljateljId: '9', posiljateljIme: 'Neki', posiljateljKorisnickoIme: 'neki', tekst: 'Ivan, bok' }), kanal)
    await r.mirno()
    expect(poslano.length).toBe(1)
    // Nova sesija (iza neaktivnosti) → opet jedna napomena.
    r.primi(por({ tekst: 'Robi, a sad?' }), kanal)
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
    expect(sklopiRazgovor({ ...osnova, vlasnici: () => [VLASNIK] }).ulaz.postavke().vlasnici).toEqual([VLASNIK])
    expect(sklopiRazgovor({ ...osnova, vlasnici: () => { throw new Error('x') } }).ulaz.postavke().vlasnici).toEqual([])
    expect(sklopiRazgovor(osnova).ulaz.postavke().vlasnici).toEqual([])
  })
})
