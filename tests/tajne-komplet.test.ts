/**
 * tajne-komplet.test.ts — TASK-5705 (uputa #441): tajne kompleta regoc-system/ upisuju se KROZ
 * PLOČU (Config → Tajne, ADR-0007). Popis imena dolazi iz `TAJNE.json` kompleta (izvoz ga izvlači
 * strojno iz koda), a komplet je instaliran tamo gdje pokazuje `TM_SUSTAV_DIR` (install.sh --komplet
 * ga upisuje u instalacija.env). Svježa instalacija bez tajni: sva imena na GET /api/tajne kao
 * neupisana, uz opis; nijedna vrijednost ni u odgovoru ni u repozitoriju.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { obradiTajne, type KontekstTajni } from '../src/TajneApi'
import { PotvrdaVlasnika } from '../src/core/PotvrdaVlasnika'
import { dopustenaImena, imeZabranjeno } from '../src/LoginCreds'
import { tajneKompleta } from '../src/TajneKompleta'
import { imenaTajniPloce } from '../src/TajnePloca'
import { DAVATELJI_AI } from '../src/core/davateljiAI'

const KORIJEN = join(import.meta.dir, '..')
const PRAVI = join(KORIJEN, 'regoc-system', 'TAJNE.json')
const PRAVE = JSON.parse(readFileSync(PRAVI, 'utf-8')).tajne as { ime: string; opis: { hr: string; en: string } }[]

let mapa = ''
const prije = process.env.TM_SUSTAV_DIR
beforeEach(() => { mapa = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tajne-komplet-')); chmodSync(mapa, 0o700) })
afterEach(() => {
  rmSync(mapa, { recursive: true, force: true })
  if (prije === undefined) delete process.env.TM_SUSTAV_DIR; else process.env.TM_SUSTAV_DIR = prije
})

function ctx(imena: KontekstTajni['imena']): KontekstTajni {
  return {
    spremiste: join(mapa, 'config', 'credentials.env'),
    auditPut: join(mapa, 'stanje', 'tajne_audit.jsonl'),
    dogadajiPut: join(mapa, 'stanje', 'tajne_dogadaji.jsonl'),
    potvrda: new PotvrdaVlasnika({ primatelji: () => ['424242'], cvor: 'node-T', posalji: async () => true }),
    postavke: () => ({ potvrdaUid: ['424242'], dopustiLanHttp: false }),
    imena, env: {}, log: () => {},
  }
}
const GET = { metoda: 'GET', put: '/api/tajne', ip: '127.0.0.1', tls: false, tijelo: '',
  zaglavlja: new Headers({ 'x-tm-tajne': '1', host: 'localhost:17781', 'content-type': 'application/json' }) }

describe('tajneKompleta()', () => {
  test('bez TM_SUSTAV_DIR (paket bez --komplet) → prazno', () => {
    delete process.env.TM_SUSTAV_DIR
    expect(tajneKompleta()).toEqual([])
  })

  test('TM_SUSTAV_DIR s TAJNE.json → ime, izvor komplet, opis i „bez nje" (HR/EN), obavezno, komponente', () => {
    process.env.TM_SUSTAV_DIR = mapa
    writeFileSync(join(mapa, 'TAJNE.json'), JSON.stringify({ tajne: [
      { ime: 'NEKI_API_KEY', obavezno: true, komponente: ['a.ts'], opis: { hr: 'opis', en: 'desc' }, bez_nje: { hr: 'ne radi', en: 'broken' } },
      { ime: 'PATH', obavezno: false, komponente: ['b.ts'], opis: { hr: 'x', en: 'x' }, bez_nje: { hr: 'x', en: 'x' } },
    ] }))
    const t = tajneKompleta()
    expect(t[0]).toEqual({ ime: 'NEKI_API_KEY', izvor: 'komplet', obavezno: true, komponente: ['a.ts'],
      opis: { hr: 'opis', en: 'desc' }, bezNje: { hr: 'ne radi', en: 'broken' } })
    // zabranjeno ime (§6.2) ne prolazi ni iz kompleta
    expect(dopustenaImena({ moduli: t }).map(d => d.ime)).toEqual(['NEKI_API_KEY'])
  })

  test('pokvaren TAJNE.json ne ruši ploču (prazan popis)', () => {
    process.env.TM_SUSTAV_DIR = mapa
    writeFileSync(join(mapa, 'TAJNE.json'), '{nije json')
    expect(tajneKompleta()).toEqual([])
  })
})

describe('pravi regoc-system/TAJNE.json', () => {
  test('nijedno ime nije zabranjeno (§6.2) — svako se može upisati na ploči', () => {
    expect(PRAVE.length).toBeGreaterThan(5)
    expect(PRAVE.filter(t => imeZabranjeno(t.ime)).map(t => t.ime)).toEqual([])
  })

  test('svježa instalacija bez tajni: GET /api/tajne pokazuje SVA imena kompleta kao neupisana, s opisom, bez vrijednosti', async () => {
    mkdirSync(join(mapa, 'sustav'))
    writeFileSync(join(mapa, 'sustav', 'TAJNE.json'), readFileSync(PRAVI))
    process.env.TM_SUSTAV_DIR = join(mapa, 'sustav')
    const r = await obradiTajne(GET, ctx(() => imenaTajniPloce([])))
    expect(r.status).toBe(200)
    const poImenu = new Map((r.tijelo.tajne as any[]).map(t => [t.ime, t]))
    for (const t of PRAVE) {
      const g = poImenu.get(t.ime)
      expect(g).toBeDefined()
      expect(g.postoji).toBe(false)
      expect(g.otisak).toBeNull()
      expect(g.opis).toEqual(t.opis)
    }
    expect(existsSync(join(mapa, 'config', 'credentials.env'))).toBe(false) // GET ništa ne stvara
  })

  test('ime koje dolazi i od davatelja paketa zadržava izvor davatelja, ali dobiva opis kompleta', () => {
    process.env.TM_SUSTAV_DIR = join(KORIJEN, 'regoc-system')
    const t = imenaTajniPloce([{ id: 'openrouter', envKey: 'OPENROUTER_API_KEY' }])
    const or = t.find(x => x.ime === 'OPENROUTER_API_KEY')!
    expect(or.izvor).toBe('davatelj.openrouter')
    expect(or.opis?.hr).toContain('OpenRouter')
  })

  test('odluka 6 (TASK-5663): svaka tajna iz kataloga AI servisa je na popisu ploče, i Claude pretplata', () => {
    delete process.env.TM_SUSTAV_DIR
    const t = new Map(imenaTajniPloce([]).map(x => [x.ime, x.izvor]))
    for (const d of DAVATELJI_AI) for (const ime of d.tajne) expect(t.has(ime)).toBe(true)
    expect(t.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('davatelj.claude')
    // davatelj iz model-configa i dalje ima prednost za izvor
    const s = imenaTajniPloce([{ id: 'moj', envKey: 'OPENROUTER_API_KEY' }])
    expect(s.find(x => x.ime === 'OPENROUTER_API_KEY')!.izvor).toBe('davatelj.moj')
  })

  test('TAJNE.json nosi samo imena i opise — nijedno polje vrijednosti', () => {
    const j = JSON.parse(readFileSync(PRAVI, 'utf-8'))
    for (const t of j.tajne) expect(Object.keys(t).sort()).toEqual(['bez_nje', 'ime', 'komponente', 'obavezno', 'opis'])
  })
})
