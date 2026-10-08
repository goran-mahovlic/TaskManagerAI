// TASK-5357 (dorada TASK-5343, ADR-0007 §4.2a/§4.3) — upis tajni bez CLI-ja:
// privatni LAN HTTP zadano dopušten, primatelj koda = vlasnik iz profila čvora,
// „upiši lozinku za mail" s Telegrama → poveznica na obrazac ploče (bez modela).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { odlukaPrijenosa } from '../src/TajneApi'
import { ucitajPostavkeTajni } from '../src/TajnePloca'
import { prepoznajZahtjevTajne, primateljiKoda, uputaZaUpis, citajInstancu, adresePloce } from '../src/TajneVlasnik'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa = ''
beforeEach(() => { mapa = mkdtempSync(join(process.env.TM_TEST_TMP || tmpdir(), 'tajne-vlasnik-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

describe('prijenos — privatni LAN i Tailscale bez dodatne postavke', () => {
  test('zadane postavke (nema config/tajne.json) dopuštaju privatni LAN HTTP', () => {
    const p = ucitajPostavkeTajni(join(mapa, 'nema.json'))
    expect(p.dopustiLanHttp).toBe(true)
    for (const ip of ['192.168.1.50', '10.0.2.2', '172.20.1.5', '::ffff:192.168.1.7', 'fd12:3456::1', 'fe80::1']) {
      expect(odlukaPrijenosa(ip, false, p)).toMatchObject({ dopusten: true, vrsta: 'lan-http' })
    }
    expect(odlukaPrijenosa('100.101.1.2', false, p)).toMatchObject({ dopusten: true, vrsta: 'tailscale' })
  })
  test('vlasnik i dalje smije isključiti LAN HTTP izričitim "dopustiLanHttp": false', () => {
    const put = join(mapa, 'tajne.json')
    writeFileSync(put, JSON.stringify({ dopustiLanHttp: false }))
    const p = ucitajPostavkeTajni(put)
    expect(p.dopustiLanHttp).toBe(false)
    expect(odlukaPrijenosa('192.168.1.50', false, p)).toMatchObject({ dopusten: false, razlog: 'tajne_lan_http' })
  })
  test('javna adresa preko čistog HTTP-a se odbija i uz dopustiLanHttp', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.63.0.1', '2001:db8::1']) {
      expect(odlukaPrijenosa(ip, false, { dopustiLanHttp: true })).toMatchObject({ dopusten: false, razlog: 'tajne_javni_http' })
    }
    expect(odlukaPrijenosa('8.8.8.8', true, { dopustiLanHttp: true })).toMatchObject({ dopusten: true, vrsta: 'https' })
  })
  test('konzola (dopustiLanHttp:false) ostaje zatvorena za LAN', () => {
    expect(odlukaPrijenosa('192.168.1.50', false, { dopustiLanHttp: false }).dopusten).toBe(false)
  })
})

describe('primatelj koda — vlasnik čvora bez CLI-ja', () => {
  test('izričit potvrdaUid (tajne.json) ima prednost', () => {
    expect(primateljiKoda(['111'], { VLASNIK_UID: '222', TG_DOPUSTENI_CHATOVI: '["333"]' })).toEqual({ uid: ['111'], izvor: 'tajne.json' })
  })
  test('VLASNIK_UID iz profila instance', () => {
    expect(primateljiKoda([], { VLASNIK_UID: '100000001' })).toEqual({ uid: ['100000001'], izvor: 'profil.VLASNIK_UID' })
    expect(primateljiKoda([], { VLASNIK_UID: '["1","x","2"]' }).uid).toEqual(['1', '2'])
  })
  // Profil kao na prvom čvoru: jedan privatni chat (vlasnik), dva dopuštena sugovornika.
  const NODEA = { TG_DOPUSTENI_CHATOVI: '["100000001","-1000000000000"]', RAZGOVOR_DOPUSTENI_KORISNICI: '["100000001","100000002","korisnik_a","korisnik_b"]' }
  test('inače JEDINI privatni chat iz TG_DOPUSTENI_CHATOVI koji je i dopušteni sugovornik (profil kao na prvom čvoru → vlasnik)', () => {
    expect(primateljiKoda([], NODEA)).toEqual({ uid: ['100000001'], izvor: 'profil.TG_DOPUSTENI_CHATOVI' })
  })
  test('rezerva se ne koristi kad je dvosmislena ili nepotvrđena', () => {
    expect(primateljiKoda([], { ...NODEA, TG_DOPUSTENI_CHATOVI: '["100000001","100000002","-1"]' }).izvor).toBe('nema')
    expect(primateljiKoda([], { TG_DOPUSTENI_CHATOVI: '["100000001"]' }).izvor).toBe('nema')
    expect(primateljiKoda([], { TG_DOPUSTENI_CHATOVI: '["100000001"]', RAZGOVOR_DOPUSTENI_KORISNICI: '["100000002"]' }).izvor).toBe('nema')
  })
  test('ništa od toga → nema primatelja', () => {
    expect(primateljiKoda([], {})).toEqual({ uid: [], izvor: 'nema' })
    expect(primateljiKoda([], { TG_DOPUSTENI_CHATOVI: '["-100"]', VLASNIK_UID: 'korisnik' })).toEqual({ uid: [], izvor: 'nema' })
  })
  test('citajInstancu čita KLJUČ=vrijednost, preskače komentare, nepostojeća datoteka = {}', () => {
    const put = join(mapa, 'profil.instanca.env')
    writeFileSync(put, '# komentar\nCVOR_IME=node-A\nTG_DOPUSTENI_CHATOVI=["100000001","-1000000000000"]\nexport VLASNIK_UID="77"\n')
    expect(citajInstancu(put)).toMatchObject({ CVOR_IME: 'node-A', VLASNIK_UID: '77' })
    expect(primateljiKoda([], citajInstancu(put)).uid).toEqual(['77'])
    expect(citajInstancu(join(mapa, 'nema.env'))).toEqual({})
  })
})

describe('Telegram — „upiši lozinku za mail"', () => {
  test.each([
    ['upiši lozinku za mail', 'email'],
    ['@cvor_bot upisi lozinku za e-mail', 'email'],
    ['Upravitelju, trebam unijeti password za email', 'email'],
    ['promijeni lozinku za nextcloud', 'nextcloud'],
    ['upiši token za github', 'github'],
    ['želim upisati lozinku', ''],
  ])('%s → %s', (t, izvor) => { expect(prepoznajZahtjevTajne(t)).toEqual({ izvor }) })
  test.each(['koja je lozinka za mail?', 'pošalji mail Ivanu', 'upiši zadatak za mail kampanju', 'lozinka je abc123'])(
    'nije zahtjev: %s', t => { expect(prepoznajZahtjevTajne(t)).toBeNull() })

  const imena = [{ ime: 'SMTP_PASSWORD', izvor: 'email.smtp' }, { ime: 'IMAP_PASSWORD', izvor: 'email.imap' }, { ime: 'GITHUB_TOKEN', izvor: 'github' }]
  test('uputa: korak po korak, poveznica na obrazac s imenima, bez naredbe na stroju', () => {
    const u = uputaZaUpis({ izvor: 'email', imena, cvor: 'node-A', bot: 'cvor_bot',
      adrese: [{ url: 'http://192.168.1.20:17781', vrsta: 'lan' }, { url: 'http://100.90.1.2:17781', vrsta: 'tailscale' }] })
    expect(u).toContain('http://192.168.1.20:17781/#tajne&ime=SMTP_PASSWORD,IMAP_PASSWORD')
    expect(u).toContain('http://100.90.1.2:17781/#tajne&ime=SMTP_PASSWORD,IMAP_PASSWORD')
    expect(u).toContain('@cvor_bot')
    expect(u).toContain('/start')
    expect(u).toMatch(/1\.[\s\S]*2\.[\s\S]*3\.[\s\S]*4\./)
    expect(u).not.toMatch(/bun |scripts\/|tajna\.ts/)
    expect(u).toMatch(/ne šalji/i)
  })
  test('adresePloce: samo adrese ovog stroja koje ploča prihvaća, LAN i Tailscale', () => {
    const a = adresePloce({
      port: 17781, dopusten: h => ['192.168.1.20', '100.90.1.2'].includes(h),
      sucelja: { enp0s3: [{ family: 'IPv4', address: '192.168.1.20', internal: false }], tailscale0: [{ family: 'IPv4', address: '100.90.1.2', internal: false }],
        lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }] } as any,
    })
    expect(a).toEqual([{ url: 'http://192.168.1.20:17781', vrsta: 'lan' }, { url: 'http://100.90.1.2:17781', vrsta: 'tailscale' }])
    expect(adresePloce({ port: 1, dopusten: () => true, sucelja: {}, javniUrl: 'https://ploca.lan/' })).toEqual([{ url: 'https://ploca.lan', vrsta: 'javni' }])
  })
})

describe('Razgovor — vlasnikov zahtjev za upis lozinke ne ide modelu', () => {
  const post = (): RazgovorPostavke => ({ ...RAZGOVOR_ZADANO, ukljucen: true, odgovaraNa: 'dopusteni-sve', dopusteniKorisnici: ['100000001', '100000002'], preskociAkoSadrzi: [], burstMs: 0, radniDir: join(mapa, 'radni') })
  const por = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
    kanal: 'telegram', chatId: '-1000000000000', porukaId: '9', posiljateljId: '100000001', posiljateljIme: 'Korisnik',
    posiljateljJeBot: false, tekst: 'upiši lozinku za mail', ts: '2026-10-08T10:05:00Z', privatno: false, obracanjeBotu: true, ...o,
  })
  async function pokreni(p: UlaznaPoruka) {
    const zahtjevi: ExecRequest[] = []
    const poslano: string[] = []
    const kanal = { ime: 'telegram', maxDuljinaPoruke: 4096, maxDokumentBajta: 1024,
      async posaljiTekst(_c: string, t: string) { poslano.push(t); return true }, async posaljiDokument() { return true } } as Kanal
    const r = stvoriRazgovor({
      postavke: post,
      izvrsitelj: { ime: 'l', async run(q: ExecRequest): Promise<ExecResult> { zahtjevi.push(q); return { exitCode: 0, resultText: 'ok', sessionId: 'S', numTurns: 1 } } } as any,
      jePauza: () => false, kvotaPuna: () => false, korijen: join(mapa, 'razgovor'), tmHome: mapa, home: mapa, port: 1,
      plocaUrl: 'http://x', instalacija: 't', env: {}, log: () => {},
      tajneUputa: (x: UlaznaPoruka) => x.posiljateljId === '100000001' && prepoznajZahtjevTajne(x.tekst) ? 'UPUTA' : null,
    })
    r.primi(p, kanal)
    await r.mirno()
    return { zahtjevi, poslano }
  }
  test('vlasnik → stiže uputa, model se ne poziva', async () => {
    const { zahtjevi, poslano } = await pokreni(por())
    expect(poslano).toEqual(['UPUTA'])
    expect(zahtjevi.length).toBe(0)
  })
  test('drugi korisnik → normalan potez modela', async () => {
    const { zahtjevi, poslano } = await pokreni(por({ posiljateljId: '100000002' }))
    expect(poslano).not.toContain('UPUTA')
    expect(zahtjevi.length).toBe(1)
  })
})

describe('GET /api/tajne — ploča kaže kome ide kod (samo kraj uid-a) i ime bota', () => {
  test('primatelji maskirani, izvor i bot u odgovoru; LAN klijent smije upisati', async () => {
    const { obradiTajne } = await import('../src/TajneApi')
    const { PotvrdaVlasnika } = await import('../src/core/PotvrdaVlasnika')
    const r = await obradiTajne({
      metoda: 'GET', put: '/api/tajne', ip: '192.168.1.50', tls: false, tijelo: '',
      zaglavlja: new Headers({ 'x-tm-tajne': '1', host: '192.168.1.20:17781' }),
    }, {
      spremiste: join(mapa, 'c.env'), auditPut: join(mapa, 'a.jsonl'), dogadajiPut: join(mapa, 'd.jsonl'),
      potvrda: new PotvrdaVlasnika({ primatelji: () => ['100000001'], posalji: async () => true, cvor: 'node-A' }),
      postavke: () => ({ potvrdaUid: ['100000001'], potvrdaIzvor: 'profil.TG_DOPUSTENI_CHATOVI', dopustiLanHttp: true }),
      imena: () => [], env: {}, imeBota: () => 'cvor_bot',
    })
    expect(r.tijelo.potvrda).toEqual({ podesena: true, primatelja: 1, izvor: 'profil.TG_DOPUSTENI_CHATOVI', primatelji: ['…0001'], bot: 'cvor_bot' })
    expect(r.tijelo.prijenos).toMatchObject({ dopusten: true, vrsta: 'lan-http' })
    expect(JSON.stringify(r.tijelo)).not.toContain('100000001')
  })
})
