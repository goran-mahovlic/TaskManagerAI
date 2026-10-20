/**
 * TASK-5384 — dva kvara iz Klaudijeva pogona (08.10.2026.) preneseni na razgovor paketa:
 *  (1) neuspjelo slanje odgovora se tiho gubilo (`posaljiTekst` → false, rezultat zanemaren) —
 *      sada odgovor ide u trajni izlazni pretinac i ponavlja se do 1 h, pa jedna dojava;
 *  (2) slika bez opisa + tekst istog pošiljatelja unutar prozora = JEDNA poruka s putanjom,
 *      i u grupi gdje slika sama (bez prozivke) ne bi dobila odgovor.
 *
 * Autorica: Jelena (Engineer), TASK-5384.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { stvoriRazgovor, type RazgovorOvisnosti } from '../src/razgovor/Razgovor'
import { IzlazniPretinac, RASPORED_MS, ROK_MS, jeSamoPrivitak } from '../src/razgovor/IzlazniPretinac'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-razg-isp-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const cekaj = (ms: number) => new Promise(r => setTimeout(r, ms))

class KanalKojiPada implements Kanal {
  ime = 'telegram' as const
  maxDuljinaPoruke = 4096
  maxDokumentBajta = 1024
  pada = true
  tekstovi: string[] = []
  async posaljiTekst(_c: string, tekst: string) { if (this.pada) return false; this.tekstovi.push(tekst); return true }
  async posaljiDokument() { return true }
}

class Izv {
  ime = 'lazni'
  zahtjevi: ExecRequest[] = []
  async run(req: ExecRequest): Promise<ExecResult> {
    this.zahtjevi.push(req)
    return { exitCode: 0, resultText: 'odgovor od 1627 znakova', sessionId: 'S1', numTurns: 1 }
  }
}

function okolina(o: Partial<RazgovorPostavke> = {}, dodatno: Partial<RazgovorOvisnosti> = {}) {
  const postavke: RazgovorPostavke = { ...RAZGOVOR_ZADANO, dopusteniKorisnici: [], ukljucen: true, burstMs: 30, radniDir: join(mapa, 'radni'), ...o }
  const izv = new Izv()
  const kanal = new KanalKojiPada()
  const sada = Date.parse('2026-10-08T16:45:21Z')
  const r = stvoriRazgovor({
    postavke: () => postavke, izvrsitelj: izv, jePauza: () => false, kvotaPuna: async () => false,
    korijen: join(mapa, 'razgovor'), tmHome: join(mapa, 'tm'), home: join(mapa, 'home'), port: 17781,
    plocaUrl: 'http://127.0.0.1:17781', instalacija: 'proba',
    env: { PATH: '/bin', HOME: '/h' }, sat: () => sada, log: () => {},
    ...dodatno,
  })
  return { r, izv, kanal }
}

let n = 0
const por = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'telegram', chatId: '-51', porukaId: String(++n), posiljateljId: '1001', posiljateljIme: 'Korisnik A',
  posiljateljJeBot: false, tekst: 'pitanje', ts: '2026-10-08T16:45:21Z', privatno: false, obracanjeBotu: false,
  ...o,
})

const SLIKA = '[PRIVITAK: /tm/data/privitci/-51/photo_1791477921492.jpg]'

describe('(1) neuspjelo slanje → izlazni pretinac', () => {
  test('kanal odbije odgovor → stavka u pretincu, nije izgubljena', async () => {
    const pretinac = new IzlazniPretinac({ dir: join(mapa, 'pretinac') })
    const o = okolina({ odgovaraNa: 'sve' }, { pretinac })
    o.r.primi(por({ privatno: true }), o.kanal)
    await o.r.mirno()
    expect(o.kanal.tekstovi).toEqual([])
    expect(pretinac.naCekanju()).toBe(1)
  })

  test('uspješno slanje ne puni pretinac', async () => {
    const pretinac = new IzlazniPretinac({ dir: join(mapa, 'pretinac') })
    const o = okolina({ odgovaraNa: 'sve' }, { pretinac })
    o.kanal.pada = false
    o.r.primi(por({ privatno: true }), o.kanal)
    await o.r.mirno()
    expect(o.kanal.tekstovi.length).toBe(1)
    expect(pretinac.naCekanju()).toBe(0)
  })

  test('pretinac: rastući razmak, isporuka kad kanal proradi; 1 h → jedna dojava', async () => {
    let sat = 1_000_000
    const p = new IzlazniPretinac({ dir: join(mapa, 'p2'), sad: () => sat })
    expect(RASPORED_MS).toEqual([10_000, 30_000, 120_000, 600_000])
    p.predaj({ chatId: '-51', tekst: 'a' })
    const pada = async () => false
    sat += 10_000; await p.obradi(pada, pada)
    expect(p.naCekanju()).toBe(1)
    const poslano: string[] = []
    sat += 30_000; await p.obradi(async (_c, t) => { poslano.push(t); return true }, pada)
    expect(poslano).toEqual(['a'])
    expect(p.naCekanju()).toBe(0)

    p.predaj({ chatId: '-51', tekst: 'b' })
    const dojave: string[] = []
    for (let i = 0; i < 20; i++) { sat += ROK_MS / 10; await p.obradi(pada, async (_c, t) => { dojave.push(t); return true }) }
    expect(dojave.length).toBe(1)
    expect(dojave[0]).toContain('nije isporučen')
    expect(p.naCekanju()).toBe(0)
  })

  test('restart: nova instanca šalje ono što je stara ostavila', async () => {
    const dir = join(mapa, 'p3')
    let sat = 5_000_000
    new IzlazniPretinac({ dir, sad: () => sat }).predaj({ chatId: '-51', tekst: 'preživio' })
    sat += 10_000
    const poslano: string[] = []
    await new IzlazniPretinac({ dir, sad: () => sat }).obradi(async (_c, t) => { poslano.push(t); return true }, async () => true)
    expect(poslano).toEqual(['preživio'])
  })
})

describe('(2) slika bez opisa + tekst istog pošiljatelja = jedna poruka', () => {
  test('jeSamoPrivitak', () => {
    expect(jeSamoPrivitak(SLIKA)).toBe(true)
    expect(jeSamoPrivitak('[PRIVITAK nije spremljen: prevelik]')).toBe(true)
    expect(jeSamoPrivitak(`pogledaj\n${SLIKA}`)).toBe(false)
    expect(jeSamoPrivitak('[GLAS] bok\n[PRIVITAK: /x.ogg]')).toBe(false)
  })

  test('grupa „spomen”: slika sama se ne bi odgovorila, ali ide uz prozvani tekst (incident 16:45:21)', async () => {
    const o = okolina({ odgovaraNa: 'spomen' })
    o.kanal.pada = false
    o.r.primi(por({ tekst: SLIKA }), o.kanal)
    await cekaj(5)
    o.r.primi(por({ tekst: 'Šabane, može li ulaz 5V?', obracanjeBotu: true }), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(1)
    expect(o.izv.zahtjevi[0]!.prompt).toContain('photo_1791477921492.jpg')
    expect(o.izv.zahtjevi[0]!.prompt).toContain('može li ulaz 5V?')
  })

  test('tekst pa slika (obrnuto) unutar prozora → jedan poziv sa slikom', async () => {
    const o = okolina({ odgovaraNa: 'spomen', burstMs: 40 })
    o.kanal.pada = false
    o.r.primi(por({ tekst: 'Šabane, pogledaj', obracanjeBotu: true }), o.kanal)
    await cekaj(5)
    o.r.primi(por({ tekst: SLIKA }), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(1)
    expect(o.izv.zahtjevi[0]!.prompt).toContain('photo_1791477921492.jpg')
  })

  test('slika drugog pošiljatelja se NE lijepi', async () => {
    const o = okolina({ odgovaraNa: 'spomen' })
    o.kanal.pada = false
    o.r.primi(por({ tekst: SLIKA, posiljateljId: '7', posiljateljIme: 'Korisnik B' }), o.kanal)
    o.r.primi(por({ tekst: 'Šabane, pitanje', obracanjeBotu: true }), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(1)
    expect(o.izv.zahtjevi[0]!.prompt).not.toContain('photo_1791477921492.jpg')
  })
})
