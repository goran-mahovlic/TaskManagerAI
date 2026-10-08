// TASK-5343 (ADR-0007 §4, §7) — /api/tajne: samo-za-pisanje, potvrda, prijenos, CSRF, audit.
// J3, J7, J8, J9, J10, J11, J12, J13, J15.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { obradiTajne, odlukaPrijenosa, type KontekstTajni, type ZahtjevTajni } from '../src/TajneApi'
import { PotvrdaVlasnika } from '../src/core/PotvrdaVlasnika'
import { procitajIzTeksta } from '../src/LoginCreds'

// Kanarinac: jedinstven niz koji se NIGDJE izvan spremišta ne smije pojaviti.
const KANARINAC = 'Kn4r1n4c-' + Math.random().toString(36).slice(2) + "-$(id)'x"
const podnizovi = (v: string) => { const s: string[] = []; for (let i = 0; i + 4 <= v.length; i += 3) s.push(v.slice(i, i + 4)); return s }
// 4-znakovni podnizovi koji su i inače česti u JSON-u nisu dokaz curenja.
const opasniPodnizovi = podnizovi(KANARINAC).filter(p => /[0-9]/.test(p) || /Kn4r|1n4c/.test(p))

let mapa = ''
let ctx: KontekstTajni
let poslano: { uid: string; tekst: string }[] = []
let log: string[] = []
let uid: string[] = ['424242']
let postavke: { dopustiLanHttp: boolean } = { dopustiLanHttp: false }

beforeEach(() => {
  mapa = mkdtempSync(join(process.env.TM_TEST_TMP || tmpdir(), 'tajne-api-'))
  chmodSync(mapa, 0o700)
  poslano = []; log = []; uid = ['424242']; postavke = { dopustiLanHttp: false }
  ctx = {
    spremiste: join(mapa, 'credentials.env'),
    auditPut: join(mapa, 'stanje', 'tajne_audit.jsonl'),
    dogadajiPut: join(mapa, 'stanje', 'tajne_dogadaji.jsonl'),
    potvrda: new PotvrdaVlasnika({
      primatelji: () => uid, cvor: 'node-T',
      posalji: async (u, t) => { poslano.push({ uid: u, tekst: t }); return true },
    }),
    postavke: () => ({ potvrdaUid: uid, ...postavke }),
    imena: () => [{ ime: 'SMTP_PASSWORD', izvor: 'email.smtp' }, { ime: 'OPENROUTER_API_KEY', izvor: 'davatelj.openrouter' }],
    env: {},
    log: s => log.push(s),
  }
})
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const ZAGLAVLJA = { 'content-type': 'application/json', 'x-tm-tajne': '1', host: 'localhost:17781' }
function z(metoda: string, put: string, tijelo?: unknown, o: Partial<ZahtjevTajni> & { zaglavlja?: Record<string, string> } = {}): ZahtjevTajni {
  return {
    metoda, put, ip: o.ip ?? '127.0.0.1', tls: o.tls ?? false,
    zaglavlja: new Headers({ ...ZAGLAVLJA, ...(o.zaglavlja || {}) }),
    tijelo: tijelo === undefined ? '' : typeof tijelo === 'string' ? tijelo : JSON.stringify(tijelo),
  }
}
const kodIzPoruke = () => /(\d{8})/.exec(poslano[poslano.length - 1]!.tekst)![1]!
const sviOdgovori: string[] = []
async function poziv(zz: ZahtjevTajni) {
  const r = await obradiTajne(zz, ctx)
  const sirovo = JSON.stringify(r.tijelo)
  sviOdgovori.push(sirovo)
  return { ...r, sirovo }
}
async function upisi(ime: string, vrijednost: string) {
  const k = await poziv(z('POST', '/api/tajne/kod', { ime, radnja: 'upis' }))
  expect(k.status).toBe(200)
  return poziv(z('PUT', `/api/tajne/${ime}`, { vrijednost, zahtjevId: k.tijelo.zahtjevId, kod: kodIzPoruke() }))
}
const sha = (p: string) => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'nema'

describe('tijek upisa i brisanja', () => {
  test('upis → postoji, otisak, zadnje; rotacija nosi otisakPrije; brisanje', async () => {
    const r = await upisi('SMTP_PASSWORD', KANARINAC)
    expect(r.status).toBe(200)
    expect(r.tijelo).toMatchObject({ ime: 'SMTP_PASSWORD', postoji: true, otisakPrije: null, zasjenjena: false })
    expect(r.tijelo.otisak).toMatch(/^[0-9a-f]{8}$/)
    expect(procitajIzTeksta(readFileSync(ctx.spremiste, 'utf-8'), 'SMTP_PASSWORD')).toBe(KANARINAC)
    expect(poslano[0]!.uid).toBe('424242')

    const g = await poziv(z('GET', '/api/tajne'))
    expect(g.status).toBe(200)
    const s = g.tijelo.tajne.find((t: any) => t.ime === 'SMTP_PASSWORD')
    expect(s).toMatchObject({ postoji: true, otisak: r.tijelo.otisak, izvor: 'email.smtp', oblik: 'novi', opasan: false })
    expect(s.zadnje).toMatchObject({ radnja: 'upis', ip: '127.0.0.1', prijenos: 'loopback' })
    expect(g.tijelo.tajne.find((t: any) => t.ime === 'OPENROUTER_API_KEY').postoji).toBe(false)

    const r2 = await upisi('SMTP_PASSWORD', KANARINAC + '2')
    expect(r2.tijelo.otisakPrije).toBe(r.tijelo.otisak)

    const k = await poziv(z('POST', '/api/tajne/kod', { ime: 'SMTP_PASSWORD', radnja: 'brisanje' }))
    const d = await poziv(z('DELETE', '/api/tajne/SMTP_PASSWORD', { zahtjevId: k.tijelo.zahtjevId, kod: kodIzPoruke() }))
    expect(d.status).toBe(200)
    expect(d.tijelo).toMatchObject({ ime: 'SMTP_PASSWORD', postoji: false, otisakPrije: r2.tijelo.otisak })
    expect(readFileSync(ctx.spremiste, 'utf-8')).not.toContain('SMTP_PASSWORD')
  })

  test('J7/J12/J13 — kanarinac ni u jednom odgovoru, auditu, događajima ni dnevniku', async () => {
    const konzola = [spyOn(console, 'log'), spyOn(console, 'error'), spyOn(console, 'warn')]
    try {
      await upisi('SMTP_PASSWORD', KANARINAC)
      await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', `{"vrijednost":"${KANARINAC}`)) // pokvaren JSON
      await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: KANARINAC, zahtjevId: 'x', kod: '1' }))
      await poziv(z('PUT', '/api/tajne/PATH', { vrijednost: KANARINAC }))
      await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: KANARINAC + '\n' }))
      await poziv(z('GET', '/api/tajne'))
      const svaKonzola = konzola.flatMap(s => s.mock.calls.map(c => c.map(String).join(' ')))
      const audit = readFileSync(ctx.auditPut, 'utf-8')
      const dogadaji = readFileSync(ctx.dogadajiPut, 'utf-8')
      for (const tekst of [...sviOdgovori, audit, dogadaji, ...log, ...svaKonzola]) {
        expect(tekst).not.toContain(KANARINAC)
        for (const p of opasniPodnizovi) expect(tekst).not.toContain(p)
      }
      // ni kod iz Telegram poruke
      for (const pp of poslano) {
        const kod = /(\d{8})/.exec(pp.tekst)![1]!
        expect(audit).not.toContain(kod)
        expect(sviOdgovori.join('')).not.toContain(kod)
      }
      expect(audit.trim().split('\n').length).toBeGreaterThanOrEqual(5)
      expect(log.every(l => /^\[TAJNE\] /.test(l))).toBe(true)
    } finally { konzola.forEach(s => s.mockRestore()) }
  })

  test('svaki odgovor ima Cache-Control: no-store', async () => {
    const r = await obradiTajne(z('GET', '/api/tajne'), ctx)
    expect(r.zaglavlja['Cache-Control']).toBe('no-store')
  })
})

describe('J8 — kod', () => {
  test('bez koda / krivi kod → 403, spremište nepromijenjeno', async () => {
    writeFileSync(ctx.spremiste, "SMTP_PASSWORD='staro'\n", { mode: 0o600 })
    const prije = sha(ctx.spremiste)
    expect((await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: 'novo' }))).status).toBe(403)
    const k = await poziv(z('POST', '/api/tajne/kod', { ime: 'SMTP_PASSWORD', radnja: 'upis' }))
    const krivi = kodIzPoruke() === '00000000' ? '11111111' : '00000000'
    const r = await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: 'novo', zahtjevId: k.tijelo.zahtjevId, kod: krivi }))
    expect(r.status).toBe(403); expect(r.tijelo.greska).toBe('kod_pogresan')
    const d = await poziv(z('DELETE', '/api/tajne/SMTP_PASSWORD', { zahtjevId: k.tijelo.zahtjevId, kod: kodIzPoruke() }))
    expect(d.status).toBe(403) // kod za upis ne vrijedi za brisanje
    expect(sha(ctx.spremiste)).toBe(prije)
  })
  test('nakon 10 pogrešnih → POST /kod 429', async () => {
    for (let n = 0; n < 2; n++) {
      const k = await poziv(z('POST', '/api/tajne/kod', { ime: 'SMTP_PASSWORD', radnja: 'upis' }))
      for (let i = 0; i < 5; i++) await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: 'v', zahtjevId: k.tijelo.zahtjevId, kod: 'x' }))
    }
    expect((await poziv(z('POST', '/api/tajne/kod', { ime: 'SMTP_PASSWORD', radnja: 'upis' }))).status).toBe(429)
    expect(readFileSync(ctx.auditPut, 'utf-8')).toContain('"radnja":"zakljucano"')
  })
})

describe('J9 — bez potvrdaUid upis je isključen', () => {
  test('409 potvrda_nije_podesena', async () => {
    uid = []
    const r = await poziv(z('POST', '/api/tajne/kod', { ime: 'SMTP_PASSWORD', radnja: 'upis' }))
    expect(r.status).toBe(409); expect(r.tijelo.greska).toBe('potvrda_nije_podesena')
    expect(poslano.length).toBe(0)
    expect((await poziv(z('GET', '/api/tajne'))).tijelo.potvrda).toEqual({ podesena: false, primatelja: 0 })
  })
})

describe('J3 — ime i vrijednost', () => {
  test('ime izvan popisa ili zabranjeno → 400 ime_nije_dopusteno', async () => {
    for (const ime of ['PATH', 'NEPOZNATO_TOKEN', 'ANTHROPIC_BASE_URL', 'mala']) {
      const r = await poziv(z('POST', '/api/tajne/kod', { ime, radnja: 'upis' }))
      expect(r.status).toBe(400); expect(r.tijelo.greska).toBe('ime_nije_dopusteno')
    }
    expect(poslano.length).toBe(0)
  })
  test('loša vrijednost → 400 i kod ostaje upotrebljiv', async () => {
    const k = await poziv(z('POST', '/api/tajne/kod', { ime: 'SMTP_PASSWORD', radnja: 'upis' }))
    for (const v of ['', 'a\nB=1', 'a\0', 'z'.repeat(4097)]) {
      const r = await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: v, zahtjevId: k.tijelo.zahtjevId, kod: kodIzPoruke() }))
      expect(r.status).toBe(400); expect(r.tijelo.greska).toMatch(/^vrijednost_/)
    }
    expect(existsSync(ctx.spremiste)).toBe(false)
    const ok = await poziv(z('PUT', '/api/tajne/SMTP_PASSWORD', { vrijednost: 'dobra', zahtjevId: k.tijelo.zahtjevId, kod: kodIzPoruke() }))
    expect(ok.status).toBe(200)
  })
})

describe('J10 — prijenos', () => {
  test('odlukaPrijenosa', () => {
    const p = { dopustiLanHttp: false }
    expect(odlukaPrijenosa('127.0.0.1', false, p)).toMatchObject({ dopusten: true, vrsta: 'loopback' })
    expect(odlukaPrijenosa('::1', false, p)).toMatchObject({ dopusten: true, vrsta: 'loopback' })
    expect(odlukaPrijenosa('::ffff:127.0.0.1', false, p)).toMatchObject({ dopusten: true, vrsta: 'loopback' })
    expect(odlukaPrijenosa('100.101.102.103', false, p)).toMatchObject({ dopusten: true, vrsta: 'tailscale' })
    expect(odlukaPrijenosa('100.63.0.1', false, p)).toMatchObject({ dopusten: false })
    expect(odlukaPrijenosa('fd7a:115c:a1e0::1', false, p)).toMatchObject({ dopusten: true, vrsta: 'tailscale' })
    expect(odlukaPrijenosa('192.168.1.5', false, p)).toMatchObject({ dopusten: false, razlog: 'tajne_lan_http' })
    expect(odlukaPrijenosa('192.168.1.5', true, p)).toMatchObject({ dopusten: true, vrsta: 'https' })
    expect(odlukaPrijenosa('192.168.1.5', false, { dopustiLanHttp: true })).toMatchObject({ dopusten: true, vrsta: 'lan-http' })
    expect(odlukaPrijenosa(null, false, p)).toMatchObject({ dopusten: false })
  })
  test('LAN HTTP → 403 tajne_lan_http; X-Forwarded-For ne mijenja odluku', async () => {
    const r = await poziv(z('POST', '/api/tajne/kod', { ime: 'SMTP_PASSWORD', radnja: 'upis' },
      { ip: '192.168.1.5', zaglavlja: { 'x-forwarded-for': '127.0.0.1' } }))
    expect(r.status).toBe(403); expect(r.tijelo.greska).toBe('tajne_lan_http')
    const g = await poziv(z('GET', '/api/tajne', undefined, { ip: '192.168.1.5' }))
    expect(g.status).toBe(200)
    expect(g.tijelo.prijenos).toMatchObject({ dopusten: false, razlog: 'tajne_lan_http' })
  })
})

describe('J11 — CSRF', () => {
  test('strani Origin, cross-site, bez X-TM-Tajne, krivi Content-Type → 403', async () => {
    const tijelo = { ime: 'SMTP_PASSWORD', radnja: 'upis' }
    for (const zag of [
      { origin: 'http://zlo.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'x-tm-tajne': '' },
      { 'content-type': 'text/plain' },
    ]) {
      const r = await poziv(z('POST', '/api/tajne/kod', tijelo, { zaglavlja: zag }))
      expect(r.status).toBe(403)
    }
    expect((await poziv(z('GET', '/api/tajne', undefined, { zaglavlja: { 'x-tm-tajne': '' } }))).status).toBe(403)
    expect(poslano.length).toBe(0)
    const ok = await poziv(z('POST', '/api/tajne/kod', tijelo, { zaglavlja: { origin: 'http://localhost:17781', 'sec-fetch-site': 'same-origin' } }))
    expect(ok.status).toBe(200)
  })
})

describe('J15 — zasjenjena', () => {
  test('okolina ima ime → zasjenjena + upozorenje, upis se ne odbija', async () => {
    ctx.env = { SMTP_PASSWORD: 'iz-okoline' }
    const r = await upisi('SMTP_PASSWORD', 'nova')
    expect(r.status).toBe(200)
    expect(r.tijelo.zasjenjena).toBe(true)
    expect(r.tijelo.upozorenja.join(' ')).toMatch(/okolin/)
    expect(r.sirovo).not.toContain('iz-okoline')
    const g = await poziv(z('GET', '/api/tajne'))
    expect(g.tijelo.tajne.find((t: any) => t.ime === 'SMTP_PASSWORD').zasjenjena).toBe(true)
  })
})

describe('stari opasni redak', () => {
  test('GET javlja oblik stari + opasan, bez vrijednosti', async () => {
    writeFileSync(ctx.spremiste, 'SMTP_PASSWORD=a$(b)c\n', { mode: 0o600 })
    const g = await poziv(z('GET', '/api/tajne'))
    const s = g.tijelo.tajne.find((t: any) => t.ime === 'SMTP_PASSWORD')
    expect(s).toMatchObject({ postoji: true, oblik: 'stari', opasan: true })
    expect(g.sirovo).not.toContain('a$(b)c')
  })
})

describe('uputa #194 — jedan Spremi za skupinu: jedan kod za više imena', () => {
  test('POST /kod {imena} + PUT /api/tajne {vrijednosti} upisuje sve, kod jednokratan', async () => {
    const k = await poziv(z('POST', '/api/tajne/kod', { imena: ['SMTP_PASSWORD', 'OPENROUTER_API_KEY'], radnja: 'upis' }))
    expect(k.status).toBe(200)
    expect(poslano.length).toBe(1)
    expect(poslano[0]!.tekst).toContain('SMTP_PASSWORD')
    expect(poslano[0]!.tekst).toContain('OPENROUTER_API_KEY')
    const tijelo = { vrijednosti: { OPENROUTER_API_KEY: KANARINAC + 'b', SMTP_PASSWORD: KANARINAC }, zahtjevId: k.tijelo.zahtjevId, kod: kodIzPoruke() }
    const r = await poziv(z('PUT', '/api/tajne', tijelo))
    expect(r.status).toBe(200)
    expect(r.tijelo.tajne.map((t: any) => t.ime).sort()).toEqual(['OPENROUTER_API_KEY', 'SMTP_PASSWORD'])
    expect(r.sirovo).not.toContain(KANARINAC)
    const tekst = readFileSync(ctx.spremiste, 'utf-8')
    expect(procitajIzTeksta(tekst, 'SMTP_PASSWORD')).toBe(KANARINAC)
    expect(procitajIzTeksta(tekst, 'OPENROUTER_API_KEY')).toBe(KANARINAC + 'b')
    expect((await poziv(z('PUT', '/api/tajne', tijelo))).status).toBe(403)
  })
  test('kod za skup imena ne vrijedi za drugi skup; loša vrijednost ne troši kod i ništa ne upisuje', async () => {
    const k = await poziv(z('POST', '/api/tajne/kod', { imena: ['SMTP_PASSWORD', 'OPENROUTER_API_KEY'], radnja: 'upis' }))
    const kod = kodIzPoruke()
    const los = await poziv(z('PUT', '/api/tajne', { vrijednosti: { SMTP_PASSWORD: 'ok', OPENROUTER_API_KEY: 'a\nb' }, zahtjevId: k.tijelo.zahtjevId, kod }))
    expect(los.status).toBe(400); expect(los.tijelo).toEqual({ greska: 'vrijednost_nedopusten_znak', ime: 'OPENROUTER_API_KEY' })
    expect(existsSync(ctx.spremiste)).toBe(false)
    const drugi = await poziv(z('PUT', '/api/tajne', { vrijednosti: { SMTP_PASSWORD: 'ok' }, zahtjevId: k.tijelo.zahtjevId, kod }))
    expect(drugi.status).toBe(403)
    expect(existsSync(ctx.spremiste)).toBe(false)
  })
  test('zabranjeno ime u skupu → 400, ništa se ne šalje', async () => {
    const r = await poziv(z('POST', '/api/tajne/kod', { imena: ['SMTP_PASSWORD', 'BASH_ENV'], radnja: 'upis' }))
    expect(r.status).toBe(400); expect(poslano.length).toBe(0)
  })
})
