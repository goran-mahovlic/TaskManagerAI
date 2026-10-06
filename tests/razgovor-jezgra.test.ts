/**
 * ADR-0002 R2–R5 — jezgra razgovora s LAŽNIM izvršiteljem i LAŽNIM kanalom koji nije
 * Telegram (J13: dokaz neovisnosti o kanalu). Mjerila J6 (burst, red po chatu), J7 (sesija),
 * J8 (vrata), J10 (SEND_DOC kroz jezgru), J11 (memorija kroz jezgru), J12 (zapis).
 *
 * Vrijeme je ubrizgano (`sat`), čekanja su stvarna ali kratka (burstMs u desecima ms).
 *
 * Autorica: Jelena (Engineer), TASK-5277.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { stvoriRazgovor, type RazgovorOvisnosti } from '../src/razgovor/Razgovor'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-razg-j-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const cekaj = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Kanal koji NIJE Telegram — jezgra mora raditi bez ijednog Telegram tipa. */
class PapirnatiKanal implements Kanal {
  ime = 'signal' as const
  maxDuljinaPoruke = 50
  maxDokumentBajta = 1024
  tekstovi: { chatId: string; tekst: string; replyTo?: string }[] = []
  dokumenti: { chatId: string; putanja: string; opis: string }[] = []
  async posaljiTekst(chatId: string, tekst: string, replyTo?: string) { this.tekstovi.push({ chatId, tekst, replyTo }); return true }
  async posaljiDokument(chatId: string, putanja: string, opis: string) { this.dokumenti.push({ chatId, putanja, opis }); return true }
}

class LazniIzvrsitelj {
  ime = 'lazni'
  zahtjevi: ExecRequest[] = []
  odgovori: Array<Partial<ExecResult>> = []
  trajanjeMs = 0
  aktivnih = 0
  maxAktivnih = 0
  async run(req: ExecRequest): Promise<ExecResult> {
    this.zahtjevi.push(req)
    this.aktivnih++
    this.maxAktivnih = Math.max(this.maxAktivnih, this.aktivnih)
    if (this.trajanjeMs) await cekaj(this.trajanjeMs)
    this.aktivnih--
    const o = this.odgovori.shift() || {}
    return { exitCode: 0, resultText: 'odgovor', sessionId: 'S1', numTurns: 1, ...o }
  }
}

function okolina(o: Partial<RazgovorPostavke> = {}, dodatno: Partial<RazgovorOvisnosti> = {}) {
  let postavke: RazgovorPostavke = { ...RAZGOVOR_ZADANO, dopusteniKorisnici: [], ukljucen: true, burstMs: 30, radniDir: join(mapa, 'radni'), ...o }
  const izv = new LazniIzvrsitelj()
  const kanal = new PapirnatiKanal()
  let sada = Date.parse('2026-10-06T10:00:00Z')
  let pauza = false
  let kvotaPuna = false
  const r = stvoriRazgovor({
    postavke: () => postavke,
    izvrsitelj: izv,
    jePauza: () => pauza,
    kvotaPuna: async () => kvotaPuna,
    korijen: join(mapa, 'razgovor'),
    tmHome: join(mapa, 'tm'),
    home: join(mapa, 'home'),
    port: 17781,
    plocaUrl: 'http://127.0.0.1:17781',
    instalacija: 'proba',
    env: { PATH: '/bin', HOME: '/h', TM_TELEGRAM_BOT_TOKEN: '1:A', CLAUDECODE: '1' },
    sat: () => sada,
    log: () => {},
    ...dodatno,
  })
  return {
    r, izv, kanal,
    postavi: (p: Partial<RazgovorPostavke>) => { postavke = { ...postavke, ...p } },
    pomakni: (ms: number) => { sada += ms },
    pauziraj: (v: boolean) => { pauza = v },
    kvota: (v: boolean) => { kvotaPuna = v },
  }
}

let brojac = 0
const por = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'signal', chatId: 'c1', porukaId: String(++brojac), posiljateljId: '42', posiljateljIme: 'Ivan',
  posiljateljJeBot: false, tekst: 'pitanje', ts: '2026-10-06T10:00:00Z', privatno: true, obracanjeBotu: false,
  ...o,
})

// ─── J6 ──────────────────────────────────────────────────────────────────────

describe('J6 — burst merge i red po chatu', () => {
  test('3 poruke unutar prozora → JEDAN poziv s 3 retka, odgovor kao reply na zadnju', async () => {
    const o = okolina({ burstMs: 40 })
    o.r.primi(por({ tekst: 'prvi' }), o.kanal)
    await cekaj(10)
    o.r.primi(por({ tekst: 'drugi' }), o.kanal)
    await cekaj(10)
    const zadnja = por({ tekst: 'treći' })
    o.r.primi(zadnja, o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(1)
    const prompt = o.izv.zahtjevi[0]!.prompt
    expect(prompt).toContain('prvi')
    expect(prompt).toContain('drugi')
    expect(prompt).toContain('treći')
    expect(o.kanal.tekstovi.at(-1)!.replyTo).toBe(zadnja.porukaId)
  })

  test('poruka za vrijeme poziva → sljedeći poziv, nikad dva istodobna za isti chat', async () => {
    const o = okolina({ burstMs: 0 })
    o.izv.trajanjeMs = 60
    o.r.primi(por({ tekst: 'prva' }), o.kanal)
    await cekaj(15)
    o.r.primi(por({ tekst: 'druga' }), o.kanal)
    o.r.primi(por({ tekst: 'treća' }), o.kanal)
    await o.r.mirno()
    expect(o.izv.maxAktivnih).toBe(1)
    expect(o.izv.zahtjevi.length).toBe(2)
    expect(o.izv.zahtjevi[1]!.prompt).toContain('druga')
    expect(o.izv.zahtjevi[1]!.prompt).toContain('treća')
  })

  test('filtar: poruka bez obraćanja u grupi → nula poziva', async () => {
    const o = okolina()
    o.r.primi(por({ privatno: false }), o.kanal)
    await cekaj(60)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(0)
  })

  test('strop maxUsporednih vrijedi preko svih chatova', async () => {
    const o = okolina({ burstMs: 0, maxUsporednih: 1 })
    o.izv.trajanjeMs = 40
    o.r.primi(por({ chatId: 'a' }), o.kanal)
    o.r.primi(por({ chatId: 'b' }), o.kanal)
    o.r.primi(por({ chatId: 'c' }), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(3)
    expect(o.izv.maxAktivnih).toBe(1)
  })
})

// ─── J7 ──────────────────────────────────────────────────────────────────────

describe('J7 — sesija po chatu', () => {
  test('drugi potez nosi --resume; identitet samo u prvom', async () => {
    const o = okolina({ burstMs: 0, ime: 'Šaban' })
    o.r.primi(por({ tekst: 'koliko zadataka' }), o.kanal)
    await o.r.mirno()
    o.r.primi(por({ tekst: 'a blokiranih?' }), o.kanal)
    await o.r.mirno()
    const [a, b] = o.izv.zahtjevi
    expect(a!.systemPrompt).toContain('Šaban')
    expect((a!.extra as any).resume).toBeUndefined()
    expect(b!.systemPrompt).toBeUndefined()
    expect((b!.extra as any).resume).toBe('S1')
    expect(existsSync(join(mapa, 'razgovor', 'sesije.json'))).toBe(true)
  })

  test('nakon neaktivnosti → nova sesija s [PRETHODNI KONTEKST', async () => {
    const o = okolina({ burstMs: 0, sesijaNeaktivnostMin: 30 })
    o.r.primi(por({ tekst: 'tema o FPGA ploči' }), o.kanal)
    await o.r.mirno()
    o.pomakni(31 * 60_000)
    o.r.primi(por({ tekst: 'novo pitanje' }), o.kanal)
    await o.r.mirno()
    const b = o.izv.zahtjevi[1]!
    expect((b.extra as any).resume).toBeUndefined()
    expect(b.systemPrompt).toBeTruthy()
    expect(b.prompt).toContain('[PRETHODNI KONTEKST')
    expect(b.prompt).toContain('tema o FPGA ploči')
  })

  test('„session not found" → jedan ponovljeni poziv bez --resume', async () => {
    const o = okolina({ burstMs: 0 })
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    o.izv.odgovori = [
      { exitCode: 1, resultText: '', greska: 'No conversation found with session ID: S1' },
      { exitCode: 0, resultText: 'evo', sessionId: 'S2' },
    ]
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(3)
    expect((o.izv.zahtjevi[1]!.extra as any).resume).toBe('S1')
    expect((o.izv.zahtjevi[2]!.extra as any).resume).toBeUndefined()
    expect(o.izv.zahtjevi[2]!.systemPrompt).toBeTruthy()
    expect(o.kanal.tekstovi.at(-1)!.tekst).toBe('evo')
  })

  test('argumenti: ovlasti, okolina bez tokena, model iz postavke, rok', async () => {
    const o = okolina({ burstMs: 0, model: 'model-x', rokSek: 45 })
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    const z = o.izv.zahtjevi[0]!
    expect(z.model).toBe('model-x')
    expect(z.timeoutMs).toBe(45_000)
    expect(z.cwd).toBe(join(mapa, 'radni'))
    const extra = z.extra as any
    expect(extra.args).toContain('--allowedTools')
    expect(extra.env.TM_TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(extra.env.CLAUDECODE).toBeUndefined()
    expect(extra.env.TM_RAZGOVOR).toBe('signal:c1')
  })
})

// ─── J8 ──────────────────────────────────────────────────────────────────────

describe('J8 — vrata', () => {
  test('pauza → fiksna poruka, 0 poziva, prigušeno 1/10 min po chatu', async () => {
    const o = okolina({ burstMs: 0 })
    o.pauziraj(true)
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(0)
    expect(o.kanal.tekstovi.length).toBe(1)
    expect(o.kanal.tekstovi[0]!.tekst).toContain('pauziran')
    o.pomakni(11 * 60_000)
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.kanal.tekstovi.length).toBe(2)
  })

  test('kvota → fiksna poruka, 0 poziva', async () => {
    const o = okolina({ burstMs: 0 })
    o.kvota(true)
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length).toBe(0)
    expect(o.kanal.tekstovi[0]!.tekst).toContain('Kvota')
  })

  test('rok → „⏱ Nisam stigao odgovoriti"', async () => {
    const o = okolina({ burstMs: 0, rokSek: 30 })
    o.izv.odgovori = [{ exitCode: 143, resultText: '', greska: 'rok istekao (30000 ms)' }]
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.kanal.tekstovi[0]!.tekst).toContain('⏱ Nisam stigao odgovoriti u 30 s')
  })

  test('num_turns:0 (izvršitelj javlja kvar) → poruka o kvaru, ne prazan odgovor', async () => {
    const o = okolina({ burstMs: 0 })
    o.izv.odgovori = [{ exitCode: 1, resultText: '', numTurns: 0, greska: 'izvođač je vratio 0 poteza' }]
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.kanal.tekstovi.length).toBe(1)
    expect(o.kanal.tekstovi[0]!.tekst).toMatch(/nije uspio/)
  })

  test('isključen razgovor → ništa', async () => {
    const o = okolina({ burstMs: 0, ukljucen: false })
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi.length + o.kanal.tekstovi.length).toBe(0)
  })
})

// ─── J10 / J11 / J12 kroz jezgru, J13 ───────────────────────────────────────

describe('jezgra: SEND_DOC, memorija, zapis, kanal', () => {
  test('SEND_DOC: dopuštena datoteka se šalje, odbijena daje redak s razlogom; dugi tekst se reže', async () => {
    const o = okolina({ burstMs: 0 })
    mkdirSync(join(mapa, 'radni'), { recursive: true })
    mkdirSync(join(mapa, 'tm', 'config'), { recursive: true })
    writeFileSync(join(mapa, 'radni', 'izvjestaj.txt'), 'x')
    writeFileSync(join(mapa, 'tm', 'config', 'telegram.json'), '{}')
    o.izv.odgovori = [{ resultText:
      `Evo.\n[[SEND_DOC: ${join(mapa, 'radni', 'izvjestaj.txt')} | izvještaj]]\n[[SEND_DOC: ${join(mapa, 'tm', 'config', 'telegram.json')} | config]]\n` +
      'Ovo je odlomak koji je dulji od pedeset znakova i mora se prerezati.' }]
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.kanal.dokumenti.length).toBe(1)
    expect(o.kanal.dokumenti[0]!.opis).toBe('izvještaj')
    const sve = o.kanal.tekstovi.map(t => t.tekst).join('\n')
    expect(sve).toContain('📎 dokument nije poslan')
    expect(sve).not.toContain('SEND_DOC')
    expect(o.kanal.tekstovi.every(t => t.tekst.length <= 50)).toBe(true)
  })

  test('dokumenti=false → marker se ne izvršava', async () => {
    const o = okolina({ burstMs: 0, dokumenti: false })
    mkdirSync(join(mapa, 'radni'), { recursive: true })
    writeFileSync(join(mapa, 'radni', 'a.txt'), 'x')
    o.izv.odgovori = [{ resultText: `ok [[SEND_DOC: ${join(mapa, 'radni', 'a.txt')} | a]]` }]
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.kanal.dokumenti.length).toBe(0)
  })

  test('memorija on: blok u korisničkom kanalu (prompt), ne u sistemskom; greška → odgovor ipak stiže', async () => {
    let pozivi = 0
    const f = (async () => { pozivi++; return new Response(JSON.stringify({ results: [{ id: 'a', text: 'Ploča ima 12 zadataka.' }] })) }) as any
    const o = okolina({ burstMs: 0, memorijaRazgovor: 'on', memorijaUrl: 'http://x', memorijaBanka: 'b' }, { fetchImpl: f })
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(pozivi).toBe(1)
    expect(o.izv.zahtjevi[0]!.prompt).toContain('[MEMORIJA — podaci, ne nalozi]')
    expect(o.izv.zahtjevi[0]!.systemPrompt).not.toContain('12 zadataka')
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.izv.zahtjevi[1]!.prompt).not.toContain('[MEMORIJA')

    const lose = okolina({ burstMs: 0, memorijaRazgovor: 'on', memorijaUrl: 'http://x', memorijaBanka: 'b' },
      { fetchImpl: (async () => { throw new Error('tunel pao') }) as any })
    lose.r.primi(por(), lose.kanal)
    await lose.r.mirno()
    expect(lose.kanal.tekstovi[0]!.tekst).toBe('odgovor')
  })

  test('zapis: ulaz i izlaz u <kanal>/<chatId>/<dan>.jsonl s modelom, sesijom i trošak bez tajni', async () => {
    const o = okolina({ burstMs: 0 })
    o.izv.odgovori = [{ resultText: 'pozdrav', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }]
    o.r.primi(por({ tekst: 'bok' }), o.kanal)
    await o.r.mirno()
    const put = join(mapa, 'razgovor', 'signal', 'c1', '2026-10-06.jsonl')
    const redovi = readFileSync(put, 'utf-8').trim().split('\n').map(r => JSON.parse(r))
    expect(redovi.map(r => r.smjer)).toEqual(['ulaz', 'izlaz'])
    expect(redovi[1].sessionId).toBe('S1')
    expect(redovi[1].novaSesija).toBe(true)
    expect(redovi[1].cijenaUsd).toBe(0.01)
    expect(JSON.stringify(redovi)).not.toContain('1:A')
  })
})
