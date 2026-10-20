/**
 * TASK-5631 (prijenos iz glavnog, ADR-0023) — tekstni dežurni u paketu:
 *   1. OpenRouter bez razmišljanja (`reasoning`, zadano off): Mistral Large 4 inače potroši sav
 *      max_tokens na razmišljanje i vrati prazan odgovor (izmjereno u glavnom, TASK-5627);
 *   2. `banke_dodatne` (dezurni.json): puni kontekst dobiva recall i iz dodatnih banaka Hindsighta
 *      (glavni: regoc_tehnika). Zadano PRAZNO — paket ne nosi naše vrijednosti.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { pitajModel, reasoningTijelo, dezurniRazgovora } from '../src/Dezurni'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa: string
let srv: ReturnType<typeof Bun.serve>
let zahtjevi: any[] = []

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const put = new URL(req.url).pathname
      const tijelo = await req.json().catch(() => ({}))
      zahtjevi.push({ put, tijelo })
      const banka = put.match(/banks\/([^/]+)\/memories\/recall/)?.[1]
      if (banka) {
        const t = banka === 'tehnika_x' ? 'SER-SI-06: stack JLC06081H-7628.' : 'Ploča radi na 17781.'
        return Response.json({ results: [{ id: banka, text: t }] })
      }
      return Response.json({ choices: [{ message: { content: 'radi (rezervni)' } }] })
    },
  })
})
afterAll(() => srv.stop(true))
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-dez5631-')); zahtjevi = [] })
afterEach(() => rmSync(mapa, { recursive: true, force: true }))

function okruzje(postavke: Record<string, unknown>) {
  const dezPut = join(mapa, 'dezurni.json')
  const mcPut = join(mapa, 'model-config.json')
  writeFileSync(dezPut, JSON.stringify(postavke))
  writeFileSync(mcPut, JSON.stringify({ providers: { openrouter: { enabled: true, apiKey: 'env:OPENROUTER_API_KEY' }, openai: { enabled: true } } }))
  return {
    dezPut, mcPut, stanjePut: join(mapa, 'dezurni.stanje.json'),
    citajTajnu: (ime: string) => (/API_KEY/.test(ime) ? 'sk-test' : null),
    openaiUrl: `http://127.0.0.1:${srv.port}/v1/chat/completions`,
  }
}

describe('reasoning (OpenRouter)', () => {
  test('pravilo isto kao glavni: zadano off, low/medium/high = effort, model = ništa', () => {
    expect(reasoningTijelo(undefined)).toEqual({ enabled: false })
    expect(reasoningTijelo('low')).toEqual({ effort: 'low' })
    expect(reasoningTijelo('model')).toBeUndefined()
  })
  test('OpenRouter zahtjev nosi reasoning {enabled:false}; postavka low → effort', async () => {
    await pitajModel('s', 'q', 100, okruzje({ provider: 'openrouter', model: 'mistralai/mistral-large-4-0' }))
    expect(zahtjevi[0].tijelo.reasoning).toEqual({ enabled: false })
    zahtjevi = []
    await pitajModel('s', 'q', 100, okruzje({ provider: 'openrouter', model: 'm', reasoning: 'low' }))
    expect(zahtjevi[0].tijelo.reasoning).toEqual({ effort: 'low' })
  })
  test('OpenAI izravno ne dobiva OpenRouterovo polje', async () => {
    await pitajModel('s', 'q', 100, okruzje({ provider: 'openai', model: 'gpt-x' }))
    expect(zahtjevi[0].tijelo.reasoning).toBeUndefined()
  })
})

class Kanalic implements Kanal {
  ime = 'telegram' as const
  maxDuljinaPoruke = 4000
  maxDokumentBajta = 1024
  tekstovi: string[] = []
  async posaljiTekst(_c: string, t: string) { this.tekstovi.push(t); return true }
  async posaljiDokument() { return true }
}
class Izv {
  ime = 'lazni'
  zahtjevi: ExecRequest[] = []
  async run(req: ExecRequest): Promise<ExecResult> {
    this.zahtjevi.push(req)
    return { exitCode: 1, resultText: '', greska: 'API Error: 429 rate_limit_error', numTurns: 0 }
  }
}

async function razgovorSDezurnim(dez: Record<string, unknown>) {
  const o = okruzje(dez)
  const kanal = new Kanalic()
  const postavke: RazgovorPostavke = {
    ...RAZGOVOR_ZADANO, ime: 'Asistent', dopusteniKorisnici: ['1'], ukljucen: true, burstMs: 10, radniDir: join(mapa, 'radni'),
    memorijaRazgovor: 'on', memorijaBanka: 'glavna', memorijaUrl: `http://127.0.0.1:${srv.port}`, memorijaRokMs: 2000,
  }
  const j = stvoriRazgovor({
    postavke: () => postavke, izvrsitelj: new Izv(), jePauza: () => false, kvotaPuna: () => false,
    korijen: join(mapa, 'razg'), tmHome: mapa, home: mapa, port: 1, plocaUrl: 'http://x', instalacija: 'node-A',
    env: { PATH: '/usr/bin' }, konzola: () => {}, log: () => {}, dezurni: dezurniRazgovora({ ...o }),
  })
  const poruka: UlaznaPoruka = {
    kanal: 'telegram', chatId: '-5', porukaId: '1', posiljateljId: '1', posiljateljIme: 'Korisnik',
    posiljateljJeBot: false, tekst: 'Koji je stackup ploče ULX5M-M2?', ts: new Date().toISOString(), privatno: true, obracanjeBotu: true,
  }
  j.primi(poruka, kanal)
  await j.mirno()
  return kanal
}

describe('banke_dodatne u tekstnom putu dežurnog (puni kontekst)', () => {
  // `openai` nema CLI put → primarni padne (429) pa odgovara tekstni dežurni.
  test('dodatna banka se pita i njezina činjenica ide modelu', async () => {
    const kanal = await razgovorSDezurnim({ provider: 'openai', model: 'gpt-5', kontekst: 'puni', banke_dodatne: ['tehnika_x'] })
    const banke = zahtjevi.map(z => z.put.match(/banks\/([^/]+)\//)?.[1]).filter(Boolean)
    expect(banke).toContain('glavna')
    expect(banke).toContain('tehnika_x')
    const model = zahtjevi.find(z => z.put.endsWith('/chat/completions'))!
    const korisnik = model.tijelo.messages.find((m: any) => m.role === 'user').content
    expect(korisnik).toContain('JLC06081H-7628')
    expect(kanal.tekstovi.join('\n')).toContain('radi (rezervni)')
  })
  test('zadano (bez banke_dodatne): samo glavna banka', async () => {
    await razgovorSDezurnim({ provider: 'openai', model: 'gpt-5', kontekst: 'puni' })
    const banke = zahtjevi.map(z => z.put.match(/banks\/([^/]+)\//)?.[1]).filter(Boolean)
    expect(banke).toEqual(['glavna'])
  })
})
