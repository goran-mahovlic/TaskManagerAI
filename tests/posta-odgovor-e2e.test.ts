/**
 * TASK-5509 kraj-do-kraja: dolazna proba-poruka → nalog vlasnika u chatu → odgovor stiže pošiljatelju
 * s vlasnikom u CC-u, privitkom i niti (In-Reply-To/References); bot-poruka s istim nalogom je odbijena;
 * proba s vanjske adrese ne šalje ništa.
 *
 * Dio A (u procesu): prava razgovorna jezgra izdaje nalog, „model" (lažni izvršitelj) radi ono što
 * piše u uputi — POST na ploču s nalogom iz okoline — a ploča šalje PRAVIM SMTP razgovorom (nodemailer)
 * na lažni SMTP poslužitelj na 127.0.0.1. Dio B: prava ploča (TaskWebUI) — ruta bez naloga odbija.
 *
 * Treba `nodemailer` (neobavezna ovisnost) — bez njega se test preskače, ne laže.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ZADANE_POSTAVKE, imaNodemailer, posaljiOdgovorEmail, vlasnikEmail, loadEmailConfig } from '../src/EmailConfig'
import { NALOG_ENV, NaloziPoteza, odgovoriNaMail, type OdgovorApi } from '../src/PostaOdgovor'
import { datotecnoSpremiste, type ZapisMaila } from '../src/PostaUlaz'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'
import { lazniSmtp, type LazniMail } from './helpers/lazniSmtp'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

const CHAT = '-1001234567890'
const VLASNIK = 'vlasnik@primjer.test'
const PROBNI = 'proba.posiljatelj@primjer.test'

const mailovi: LazniMail[] = []
let smtp: ReturnType<typeof Bun.listen> | null = null
let dom = ''
let emailPut = ''
let privitci = ''

function zapis(uid: number, over: Partial<ZapisMaila> = {}): ZapisMaila {
  return {
    uid, chatId: CHAT, od: `Proba <${PROBNI}>`, odAdresa: PROBNI, predmet: 'Fasada', datum: '2026-10-14T08:00:00.000Z',
    privitci: [], sazetak: 'Pozdrav', tijelo: 'Pozdrav, molim tablicu.', messageId: `<fasada-${uid}@primjer.test>`,
    references: '<ranija@primjer.test>', proba: true, poslano: '2026-10-14T08:00:05.000Z', ...over,
  }
}

class Kanal0 implements Kanal {
  ime = 'telegram' as const
  maxDuljinaPoruke = 4000
  maxDokumentBajta = 1024
  tekstovi: string[] = []
  async posaljiTekst(_c: string, t: string) { this.tekstovi.push(t); return true }
  async posaljiDokument() { return true }
}

describe.skipIf(!imaNodemailer())('odgovor na mail preko ploče — kraj do kraja', () => {
  beforeAll(() => {
    smtp = lazniSmtp(mailovi)
    dom = mkdtempSync(join(tmpdir(), 'tm-odg-e2e-'))
    privitci = join(dom, 'privitci')
    mkdirSync(join(privitci, CHAT), { recursive: true })
    writeFileSync(join(privitci, CHAT, 'fasada.xlsx'), 'PK\u0003\u0004 lažna tablica')
    emailPut = join(dom, 'email.json')
    writeFileSync(emailPut, JSON.stringify({
      ...ZADANE_POSTAVKE, ukljucen: true, smjer: 'oba', primatelji: [VLASNIK, PROBNI], vlasnik: VLASNIK,
      smtp: { host: '127.0.0.1', port: smtp.port, tls: false, korisnik: 'saban', lozinkaEnv: 'TM_TEST_SMTP_5509', posiljatelj: 'sabanAI@primjer.test' },
    }))
    process.env.TM_TEST_SMTP_5509 = 'lozinka-za-test'
  })
  afterAll(() => {
    smtp?.stop(true)
    delete process.env.TM_TEST_SMTP_5509
    if (dom) rmSync(dom, { recursive: true, force: true })
  })

  test('vlasnikov nalog → stvarni SMTP: pošiljatelju + CC vlasnik, privitak, nit; bot-poruka odbijena; vanjska proba ne šalje', async () => {
    const postaPut = join(dom, 'posta.json')
    const sp = datotecnoSpremiste(postaPut)
    sp.zapisi({
      uidValidity: '1', zadnji: 9, greska: null, zadnjaProvjera: null, obavijesti: 2,
      poruke: { '9001': zapis(8), '9002': zapis(9, { od: 'Stranac <korisnica@vanjski.test>', odAdresa: 'korisnica@vanjski.test' }) },
    })
    const nalozi = new NaloziPoteza()
    const odgovori: Array<{ tko: string; r: OdgovorApi }> = []
    // „Model": što uputa kaže — POST s nalogom iz okoline poteza (bez naloga = kao bot/autonomija).
    const izv = {
      ime: 'model-po-uputi',
      async run(req: ExecRequest): Promise<ExecResult> {
        const env = (req.extra as any)?.env || {}
        const odgovorNa = /mail (\d+)/.exec(req.prompt)?.[1] || '8'
        const r = await odgovoriNaMail({
          odgovorNa, tekst: 'Poštovana, u privitku je tablica za fasadu.\nLp, Šaban',
          privitci: [join(privitci, CHAT, 'fasada.xlsx')], nalog: env[NALOG_ENV] ?? null,
        }, {
          nalozi, spremiste: sp, vlasnik: () => vlasnikEmail(loadEmailConfig(emailPut)),
          interneAdrese: () => loadEmailConfig(emailPut).primatelji,
          dopusteneMape: n => [n.radniDir, privitci], home: dom,
          posalji: x => posaljiOdgovorEmail(x, emailPut),
        })
        odgovori.push({ tko: String(env[NALOG_ENV] ? 'nalog' : 'bez'), r })
        return { exitCode: 0, resultText: r.status === 200 ? 'Poslano.' : `Ploča je odbila: ${(r.tijelo as any).greska}`, sessionId: 'S', numTurns: 1 }
      },
    }
    const postavke: RazgovorPostavke = {
      ...RAZGOVOR_ZADANO, ukljucen: true, burstMs: 0, ovlasti: 'puno', dopusteniKorisnici: ['1001'], radniDir: join(dom, 'radni'),
    }
    const r = stvoriRazgovor({
      postavke: () => postavke, izvrsitelj: izv, jePauza: () => false, kvotaPuna: async () => false,
      korijen: join(dom, 'razgovor'), tmHome: dom, home: dom, port: 17781, plocaUrl: 'http://127.0.0.1:17781',
      instalacija: 'node-A', env: { PATH: '/bin' }, log: () => {}, nalozi, odgovorPoste: () => true,
      botKanal: () => ({ jeZaustavljen: () => false, ovlasti: () => 'rad', prenesi: async () => 'poslano' as any }),
    })
    const k = new Kanal0()
    const covjek: UlaznaPoruka = {
      kanal: 'telegram', chatId: CHAT, porukaId: '1', posiljateljId: '1001', posiljateljIme: 'Vlasnik',
      posiljateljJeBot: false, tekst: '@saban odgovori na mail 8 s tablicom u privitku, mene u CC', ts: '2026-10-14T09:00:00Z',
      privatno: false, obracanjeBotu: true,
    }

    // 1) vlasnikov nalog → stvarni SMTP
    r.primi(covjek, k)
    await r.mirno()
    await Bun.sleep(300)
    expect(odgovori[0]!.r.status).toBe(200)
    expect(mailovi.length).toBe(1)
    const m = mailovi[0]!
    expect(m.rcpt.sort()).toEqual([PROBNI, VLASNIK].sort())
    expect(m.podaci).toMatch(/^To: proba\.posiljatelj@primjer\.test/m)
    expect(m.podaci).toMatch(/^Cc: vlasnik@primjer\.test/m)
    expect(m.podaci).toMatch(/^Subject: Re: Fasada/m)
    expect(m.podaci).toMatch(/^In-Reply-To: <fasada-8@primjer\.test>/m)
    expect(m.podaci).toMatch(/^References: <ranija@primjer\.test> <fasada-8@primjer\.test>/m)
    expect(m.podaci).toContain('filename=fasada.xlsx')
    const trag = sp.ucitaj().poruke['9001']!.odgovori!.at(-1)!
    expect(trag.tko).toContain('Vlasnik (uid:1001)')
    expect(trag.cc).toEqual([VLASNIK])
    expect(trag.privitci).toEqual(['fasada.xlsx'])
    expect(String(trag.messageId)).toMatch(/^<.+@.+>$/)

    // 2) Bot-poruka s istim nalogom → nema naloga → ploča odbija, SMTP ne vidi ništa
    r.primi({
      ...covjek, porukaId: '2', posiljateljId: 'bot:klaudio', posiljateljIme: 'Klaudio (bot)', posiljateljJeBot: true, izvor: 'bot',
      lanac: { izvor: 'klaudio', lanacId: 'L1', skok: 1, izvornik: { id: '1001', ime: 'Vlasnik' } } as any,
    }, k)
    await r.mirno()
    await Bun.sleep(200)
    expect(odgovori[1]!.tko).toBe('bez')
    expect(odgovori[1]!.r.status).toBe(403)
    expect(mailovi.length).toBe(1)

    // 3) Proba s VANJSKE adrese: vlasnikov nalog prolazi, ali ništa ne odlazi — vraća se priprema
    r.primi({ ...covjek, porukaId: '3', tekst: '@saban odgovori na mail 9' }, k)
    await r.mirno()
    await Bun.sleep(200)
    expect(odgovori[2]!.r.status).toBe(200)
    expect((odgovori[2]!.r.tijelo as any).proba).toBe(true)
    expect((odgovori[2]!.r.tijelo as any).priprema.prima).toBe('korisnica@vanjski.test')
    expect((odgovori[2]!.r.tijelo as any).priprema.cc).toEqual([VLASNIK])
    expect(mailovi.length).toBe(1)
  }, 30_000)
})

describe('ruta /api/email/posalji (prava ploča) — odgovorNa bez naloga čovjeka', () => {
  let p: Posluzitelj | null = null
  let d = ''
  beforeAll(async () => {
    d = mkdtempSync(join(tmpdir(), 'tm-odg-ruta-'))
    const email = join(d, 'email.json')
    writeFileSync(email, JSON.stringify({
      ...ZADANE_POSTAVKE, ukljucen: true, smjer: 'izlaz', primatelji: [VLASNIK],
      smtp: { host: '127.0.0.1', port: 2525, tls: false, korisnik: 'bot', lozinkaEnv: 'TM_TEST_SMTP_5509R', posiljatelj: 'bot@primjer.test' },
    }))
    p = await podigni({}, { TM_EMAIL_CONFIG: email, TM_TEST_SMTP_5509R: 'x' })
  }, 30_000)
  afterAll(() => { spusti(p); if (d) rmSync(d, { recursive: true, force: true }) })

  const posalji = (tijelo: object, z: Record<string, string> = {}) => fetch(`${p!.url}/api/email/posalji`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...z }, body: JSON.stringify(tijelo),
  })

  test('bez naloga → 403 s razlogom; izmišljen nalog → 403; ništa ne odlazi', async () => {
    const r1 = await posalji({ odgovorNa: '8', tekst: 'Poštovana…' })
    expect(r1.status).toBe(403)
    expect(String(((await r1.json()) as any).greska)).toContain('nalog')
    const r2 = await posalji({ odgovorNa: '8', tekst: 'Poštovana…' }, { 'X-Regoc-Nalog': 'izmisljeni-nalog-123' })
    expect(r2.status).toBe(403)
    expect(String(((await r2.json()) as any).greska)).toContain('ne postoji')
  })

  test('bez odgovorNa ruta radi po starom (samo popis primatelja)', async () => {
    const r = await posalji({ predmet: 'x', tekst: 'y', prima: ['stranac@zlo.test'] })
    expect(r.status).toBe(400)
    expect(String(((await r.json()) as any).greska)).toContain('nije na popisu primatelja')
  })
})
