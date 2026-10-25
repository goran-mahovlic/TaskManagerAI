// TASK-5795: internet čvora bez capguarda — čitanje weba odvojeno od objave.
// Mac (Mac čvor) nema capguard, pa je korpus pisao „objava na internet nije dopuštena" i
// razgovor (razina puno, ima WebSearch/WebFetch) odbio je pregled sportskih događanja.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { internetCvora, uputaInterneta } from '../src/core/InternetCvora'
import { dokumentStanje } from '../src/znanje/Cvor'
import { CINJENICA_BEZ } from '../src/znanje/Korpus'
import { sastaviIdentitet } from '../src/razgovor/Identitet'
import { odjeljakInterneta } from '../scripts/profil-cvora'

const KORIJEN = join(import.meta.dir, '..')

describe('internetCvora: TM_INTERNET ima prednost pred capguardom', () => {
  test('citanje = čitanje da, objava ne (i kad capguard kaže ne)', () => {
    expect(internetCvora({ TM_INTERNET: 'citanje' }, false)).toEqual({ citanje: true, objava: false, izvor: 'TM_INTERNET' })
  })
  test('objava = oboje; off = ništa (i kad capguard kaže da)', () => {
    expect(internetCvora({ TM_INTERNET: 'objava' })).toEqual({ citanje: true, objava: true, izvor: 'TM_INTERNET' })
    expect(internetCvora({ TM_INTERNET: ' OFF ' }, true)).toEqual({ citanje: false, objava: false, izvor: 'TM_INTERNET' })
  })
  test('bez postavke vrijedi capguard kao prije (allow_internet = oboje)', () => {
    expect(internetCvora({}, true)).toEqual({ citanje: true, objava: true, izvor: 'capguard' })
    expect(internetCvora({}, false)).toEqual({ citanje: false, objava: false, izvor: 'capguard' })
  })
  test('bez postavke i bez capguarda (macOS) — zatvoreno; neispravna vrijednost se ne pogađa', () => {
    expect(internetCvora({})).toEqual({ citanje: false, objava: false, izvor: 'zadano' })
    expect(internetCvora({ TM_INTERNET: 'da' })).toEqual({ citanje: false, objava: false, izvor: 'zadano' })
  })
})

describe('korpus cvor/stanje: čitanje i objava su dvije rečenice', () => {
  test('čitanje uključeno, objava ne → model zna da smije pretraživati', () => {
    const d = dokumentStanje({ cvor: 'mac-cvor', mogucnosti: { web: true, internet: false }, banka: 'b' })
    expect(d).toContain('čitanje weba je dopušteno')
    expect(d).toContain('WebSearch')
    expect(d).not.toContain('objava na internet nije dopuštena.')
    expect(d).toMatch(/objava na internet .*traži odobrenje vlasnika.*ne na čitanje weba/)
  })
  test('čitanje isključeno → kaže i to', () => {
    const d = dokumentStanje({ cvor: 'c', mogucnosti: { web: false }, banka: 'b' })
    expect(d).toContain('čitanje weba nije uključeno')
  })
  test('činjenica bez mogućnosti internet govori samo o objavi', () => {
    expect(CINJENICA_BEZ.internet).toContain('ne na čitanje weba')
  })
})

describe('identitet razgovora (puno) kaže stanje interneta', () => {
  const osnova = { ime: 'Bot', instalacija: 'mac-cvor', plocaUrl: 'http://127.0.0.1:17781', port: 17781, dokumenti: false, radniDir: '/r' }
  test('puno + čitanje: WebSearch/WebFetch, objava uz odobrenje', () => {
    const t = sastaviIdentitet({ ...osnova, ovlasti: 'puno', internet: internetCvora({ TM_INTERNET: 'citanje' }) })
    expect(t).toContain('Čitanje weba je na ovom čvoru UKLJUČENO')
    expect(t).toContain('OBJAVA na internet')
    expect(t).not.toContain('izlaz na internet idu kroz sklopke vlasnika')
  })
  test('citanje/rad razina nema web alate pa ni rečenicu', () => {
    const t = sastaviIdentitet({ ...osnova, ovlasti: 'rad', internet: internetCvora({ TM_INTERNET: 'citanje' }) })
    expect(t).not.toContain('Čitanje weba')
  })
  test('bez opcije internet ostaje stari tekst (node-A s capguardom)', () => {
    const t = sastaviIdentitet({ ...osnova, ovlasti: 'puno' })
    expect(t).toContain('izlaz na internet idu kroz sklopke vlasnika')
  })
  test('uputa za isključen internet imenuje postavku', () => {
    expect(uputaInterneta(internetCvora({}))).toContain('TM_INTERNET=citanje')
  })
})

describe('mjerenje i predložak vodiča čvora', () => {
  test('znanje-cvora mjeri web i internet kroz internetCvora (ne samo capguard)', () => {
    const izvor = readFileSync(join(KORIJEN, 'scripts', 'znanje-cvora.ts'), 'utf-8')
    expect(izvor).toContain('internetCvora(')
    expect(izvor).toContain('m.web')
  })
  test('Razgovor.ts predaje internet identitetu iz okoline ploče', () => {
    const izvor = readFileSync(join(KORIJEN, 'src', 'razgovor', 'Razgovor.ts'), 'utf-8')
    expect(izvor).toMatch(/internetCvora\(d\.env\)\.izvor === 'TM_INTERNET' \? \{ internet: internetCvora\(d\.env\) \}/)
  })
  test('vodič čvora (CLAUDE.md predložak) više ne tvrdi capguard bez uvjeta: odjeljak ide kroz varijablu', () => {
    const p = readFileSync(join(KORIJEN, 'profili', 'upravitelj-cvora', 'CLAUDE.md.predlozak'), 'utf-8')
    expect(p).toContain('{{ODJELJAK_INTERNET}}')
    expect(p).not.toContain('## Sklopke (capguard)')
  })
  test('odjeljak: s capguardom sklopke, bez njega TM_INTERNET (čitanje ≠ objava)', () => {
    expect(odjeljakInterneta(true)).toContain('## Sklopke (capguard)')
    const mac = odjeljakInterneta(false)
    expect(mac).toContain('TM_INTERNET')
    expect(mac).toContain('WebSearch')
    expect(mac).not.toContain('capguard approve')
  })
})
