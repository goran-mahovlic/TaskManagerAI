/**
 * TASK-5509: nalog poteza — jednokratni token za odgovor na mail preko ploče.
 *
 *   - ljudski potez dopuštenog korisnika na razini `puno` → okolina nosi TM_NALOG_POTEZA, prompt
 *     i identitet nose uputu (curl na /api/email/posalji), nalog je vezan uz chat i pošiljatelja;
 *   - bot-poruka (i na `rad` uz dopuštenog izvornika), nedopušten pošiljatelj, razina `rad` → NEMA naloga;
 *   - na kraju poteza nalog je opozvan (više ne vrijedi ni za slanje).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { stvoriRazgovor, type RazgovorOvisnosti } from '../src/razgovor/Razgovor'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'
import { NALOG_ENV, NaloziPoteza } from '../src/PostaOdgovor'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-nalog-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

class Kanal0 implements Kanal {
  ime = 'telegram' as const
  maxDuljinaPoruke = 4000
  maxDokumentBajta = 1024
  tekstovi: string[] = []
  async posaljiTekst(_c: string, t: string) { this.tekstovi.push(t); return true }
  async posaljiDokument() { return true }
}

/** Izvršitelj koji usred poteza provjeri je li nalog živ (kao da model zove ploču). */
class Izvrsitelj {
  ime = 'lazni'
  zahtjevi: ExecRequest[] = []
  zivUPotezu: boolean[] = []
  constructor(private nalozi: NaloziPoteza) {}
  async run(req: ExecRequest): Promise<ExecResult> {
    this.zahtjevi.push(req)
    const t = (req.extra as any)?.env?.[NALOG_ENV]
    if (t) {
      const u = this.nalozi.uzmi(t)
      this.zivUPotezu.push(u.ok)
      if (u.ok) this.nalozi.vrati(t)
    }
    return { exitCode: 0, resultText: 'u redu', sessionId: 'S1', numTurns: 1 }
  }
}

function okolina(o: Partial<RazgovorPostavke> = {}, dodatno: Partial<RazgovorOvisnosti> = {}) {
  const nalozi = new NaloziPoteza()
  const izv = new Izvrsitelj(nalozi)
  const kanal = new Kanal0()
  const postavke: RazgovorPostavke = {
    ...RAZGOVOR_ZADANO, ukljucen: true, burstMs: 0, ovlasti: 'puno', dopusteniKorisnici: ['1001'],
    radniDir: join(mapa, 'radni'), ...o,
  }
  const r = stvoriRazgovor({
    postavke: () => postavke, izvrsitelj: izv, jePauza: () => false, kvotaPuna: async () => false,
    korijen: join(mapa, 'razgovor'), tmHome: join(mapa, 'tm'), home: join(mapa, 'home'),
    port: 17781, plocaUrl: 'http://127.0.0.1:17781', instalacija: 'node-A',
    env: { PATH: '/bin', HOME: '/h' }, log: () => {},
    nalozi, odgovorPoste: () => true,
    botKanal: () => ({ jeZaustavljen: () => false, ovlasti: () => 'rad', prenesi: async () => 'poslano' as any }),
    ...dodatno,
  })
  return { r, izv, kanal, nalozi }
}

let n = 0
const covjek = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'telegram', chatId: '-1001234567890', porukaId: String(++n), posiljateljId: '1001', posiljateljIme: 'Vlasnik',
  posiljateljJeBot: false, tekst: '@saban odgovori Korisnici na mail 8 s tablicom, mene u CC', ts: '2026-10-14T08:00:00Z',
  privatno: false, obracanjeBotu: true, ...o,
})

test('ljudski potez na `puno`: nalog u okolini, živ za vrijeme poteza, uputa u promptu i identitetu', async () => {
  const o = okolina()
  o.r.primi(covjek(), o.kanal)
  await o.r.mirno()
  const req = o.izv.zahtjevi[0]!
  const env = (req.extra as any).env
  expect(typeof env[NALOG_ENV]).toBe('string')
  expect(env[NALOG_ENV].length).toBeGreaterThanOrEqual(30)
  expect(o.izv.zivUPotezu).toEqual([true])
  expect(req.prompt).toContain('/api/email/posalji')
  expect(req.prompt).toContain('X-Regoc-Nalog: $TM_NALOG_POTEZA')
  expect(req.systemPrompt).toContain('ISKLJUČIVO preko ploče')
  expect(req.systemPrompt).toContain('vlasnika u CC')
})

test('nalog je vezan uz chat i pošiljatelja, a na kraju poteza je opozvan', async () => {
  const o = okolina()
  o.r.primi(covjek(), o.kanal)
  await o.r.mirno()
  const t = (o.izv.zahtjevi[0]!.extra as any).env[NALOG_ENV]
  const u = o.nalozi.uzmi(t)
  expect(u.ok).toBe(false)
  expect(o.nalozi.zivih()).toBe(0)
})

test('nalog nosi chat, pošiljatelja i radnu mapu poteza', async () => {
  const nalozi = new NaloziPoteza()
  let izdan: any = null
  const o = okolina({}, { nalozi: { izdaj: (x: any) => { izdan = x; return nalozi.izdaj(x) }, opozovi: t => nalozi.opozovi(t) } })
  o.r.primi(covjek(), o.kanal)
  await o.r.mirno()
  expect(izdan.chatId).toBe('-1001234567890')
  expect(izdan.posiljateljId).toBe('1001')
  expect(izdan.posiljateljIme).toBe('Vlasnik')
  expect(izdan.radniDir).toBe(join(mapa, 'radni'))
  expect(izdan.rokMs).toBeGreaterThan(0)
})

test('bot-poruka s istim nalogom (i uz dopuštenog izvornika): NEMA naloga ni upute', async () => {
  const o = okolina()
  o.r.primi(covjek({
    izvor: 'bot', posiljateljId: 'bot:klaudio', posiljateljIme: 'Klaudio (bot)', posiljateljJeBot: true,
    lanac: { izvor: 'klaudio', lanacId: 'L1', skok: 1, izvornik: { id: '1001', ime: 'Vlasnik' } } as any,
  }), o.kanal)
  await o.r.mirno()
  const req = o.izv.zahtjevi[0]!
  expect((req.extra as any).env[NALOG_ENV]).toBeUndefined()
  expect(req.prompt).not.toContain('/api/email/posalji')
  expect(o.izv.zivUPotezu).toEqual([])
})

test('nedopušten pošiljatelj (potez pada na `citanje`): nema naloga', async () => {
  const o = okolina()
  o.r.primi(covjek({ posiljateljId: '999', posiljateljIme: 'Stranac' }), o.kanal)
  await o.r.mirno()
  expect((o.izv.zahtjevi[0]!.extra as any).env[NALOG_ENV]).toBeUndefined()
})

test('razina `rad`: nema naloga (pošta van traži `puno`)', async () => {
  const o = okolina({ ovlasti: 'rad' })
  o.r.primi(covjek(), o.kanal)
  await o.r.mirno()
  expect((o.izv.zahtjevi[0]!.extra as any).env[NALOG_ENV]).toBeUndefined()
})

test('ploča ne može slati mail (SMTP nije spreman): nalog postoji, ali nema upute u promptu', async () => {
  const o = okolina({}, { odgovorPoste: () => false })
  o.r.primi(covjek(), o.kanal)
  await o.r.mirno()
  expect(o.izv.zahtjevi[0]!.prompt).not.toContain('/api/email/posalji')
})
