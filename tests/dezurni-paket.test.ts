/**
 * TASK-5359 — dežurni (rezervni model) radi U PAKETU, bez mosta glavnog sustava.
 *
 * Kvar (node-A, 08.10.2026.): Test na ploči je tražio `~/.claude/tools/Telegram/dezurni.ts`,
 * kojeg na tuđoj instalaciji nema → „NOT WORKING". Ovdje se dokazuje:
 *   1. most `src/Dezurni.ts` zove davatelja iz `dezurni.json` paketa (lažni OpenAI/Ollama poslužitelj);
 *   2. prepoznavanje pada primarnog (429/401/limit/nedostupan) — ali ne roka ni prekida;
 *   3. razgovor: primarni padne → odgovor stiže preko dežurnog, s redom u konzoli;
 *   4. orkestrator: agent čiji spawn padne s 429 ponavlja se na dežurnom modelu (claude CLI
 *      preusmjeren preko ANTHROPIC_BASE_URL) — alati agenta ostaju;
 *   5. nijedna putanja glavnog sustava (alati i raspored mapa domaćina pod $HOME) u mostu.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  jePadPrimarnog, pitajModel, probaModela, zabiljeziGresku, zabiljeziUspjeh, citajStanje,
  simulirajPad, simulacijaPada, ciljDezurnog, dezurniRazgovora,
} from '../src/Dezurni'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import { Orchestrator } from '../src/core/orchestrator/Orchestrator'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa: string
let srv: ReturnType<typeof Bun.serve>
let zahtjevi: any[] = []
let odgovaraj = true

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const tijelo = await req.json().catch(() => ({}))
      zahtjevi.push({ put: new URL(req.url).pathname, auth: req.headers.get('authorization'), tijelo })
      if (!odgovaraj) return new Response('pao', { status: 503 })
      if (new URL(req.url).pathname === '/api/chat') {
        return Response.json({ message: { content: 'radi (ollama)' } })
      }
      return Response.json({ choices: [{ message: { content: 'radi (rezervni)' } }] })
    },
  })
})
afterAll(() => srv.stop(true))

beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-dez-'))
  zahtjevi = []
  odgovaraj = true
})
afterEach(() => rmSync(mapa, { recursive: true, force: true }))

function okruzje(postavke: Record<string, unknown>) {
  const dezPut = join(mapa, 'dezurni.json')
  const mcPut = join(mapa, 'model-config.json')
  writeFileSync(dezPut, JSON.stringify(postavke))
  writeFileSync(mcPut, JSON.stringify({
    providers: {
      openrouter: { enabled: true, apiKey: 'env:OPENROUTER_API_KEY' },
      lazni: { enabled: true, anthropicCompatible: true, baseUrl: `http://127.0.0.1:${srv.port}`, apiKey: 'env:LAZNI_KLJUC' },
    },
  }))
  return {
    dezPut, mcPut,
    stanjePut: join(mapa, 'dezurni.stanje.json'),
    citajTajnu: (ime: string) => (ime === 'OPENROUTER_API_KEY' || ime === 'LAZNI_KLJUC' ? 'sk-test' : null),
    openaiUrl: `http://127.0.0.1:${srv.port}/v1/chat/completions`,
  }
}

describe('jePadPrimarnog — što je pad primarnog modela', () => {
  test.each([
    ['API Error: 429 {"type":"rate_limit_error"}', 'limit'],
    ['Claude AI usage limit reached|1791460000', 'limit'],
    ["You've hit your limit · resets 3pm", 'limit'],
    ['API Error: 401 {"type":"authentication_error"}', 'prijava'],
    ['Invalid API key · Please run /login', 'prijava'],
    ['API Error: 529 Overloaded', 'nedostupan'],
    ['mrežna greška: fetch failed', 'nedostupan'],
    ['naredba se ne može pokrenuti: ENOENT claude', 'nedostupan'],
  ])('%s → %s', (tekst, vrsta) => {
    expect(jePadPrimarnog(tekst)?.vrsta).toBe(vrsta)
  })

  test.each([
    'rok istekao (120000 ms)',
    'prekinuto (signal domaćina)',
    'izvođač je vratio 0 poteza (spawn je blokiran prije rada) — ovo NIJE uspjeh',
    'exit 1',
    '',
  ])('NIJE pad primarnog: %s', tekst => {
    expect(jePadPrimarnog(tekst)).toBeNull()
  })
})

describe('most u paketu — poziv davatelja', () => {
  test('OpenAI oblik (openrouter): zove URL iz postavki s ključem iz spremišta paketa', async () => {
    const o = okruzje({ provider: 'openrouter', model: 'z-ai/glm-4.6' })
    const r = await probaModela({ ...o })
    expect(r.ok).toBe(true)
    expect(r.odgovor).toBe('radi (rezervni)')
    expect(zahtjevi[0].auth).toBe('Bearer sk-test')
    expect(zahtjevi[0].tijelo.model).toBe('z-ai/glm-4.6')
  })

  test('Ollama oblik: zove baseUrl/api/chat', async () => {
    const o = okruzje({ provider: 'ollama', model: 'qwen3:8b', baseUrl: `http://127.0.0.1:${srv.port}` })
    expect(await pitajModel('sustav', 'pitanje', 50, { ...o })).toBe('radi (ollama)')
    expect(zahtjevi[0].put).toBe('/api/chat')
  })

  test('davatelj ne odgovori → null, nikad izmišljen tekst; proba kaže zašto', async () => {
    const o = okruzje({ provider: 'openrouter', model: 'x/y' })
    odgovaraj = false
    expect(await pitajModel('s', 'p', 50, { ...o })).toBeNull()
    const r = await probaModela({ ...o })
    expect(r.ok).toBe(false)
    expect(r.greska).toContain('openrouter')
  })

  test('razgovor ne šalje „razmišljanje" modela: samoSadrzaj odbacuje odgovor koji je samo reasoning', async () => {
    const o = okruzje({ provider: 'openrouter', model: 'x/y' })
    const samoRazmisljanje: typeof fetch = (async () => Response.json({ choices: [{ message: { content: null, reasoning: 'The user wants…' } }] })) as any
    expect(await pitajModel('s', 'p', 50, { ...o, fetchImpl: samoRazmisljanje })).toBe('The user wants…')
    expect(await pitajModel('s', 'p', 50, { ...o, fetchImpl: samoRazmisljanje }, { samoSadrzaj: true })).toBeNull()
  })

  test('bez ključa → ne zove ništa', async () => {
    const o = okruzje({ provider: 'openrouter', model: 'x/y' })
    expect(await pitajModel('s', 'p', 50, { ...o, citajTajnu: () => null })).toBeNull()
    expect(zahtjevi.length).toBe(0)
  })

  test('most ne nosi nijednu putanju glavnog sustava', () => {
    const izvor = readFileSync(join(import.meta.dir, '..', 'src', 'Dezurni.ts'), 'utf-8')
    expect(izvor).not.toMatch(/\.claude\/tools|\.claude\/regoc/)
  })
})

describe('stanje dežurstva i simulacija pada', () => {
  test('prag uzastopnih grešaka pali dežurstvo, uspjeh ga gasi', () => {
    const o = okruzje({ okidac_uzastopnih_gresaka: 2 })
    expect(zabiljeziGresku({ ...o }).pocinje).toBe(false)
    expect(zabiljeziGresku({ ...o }).pocinje).toBe(true)
    expect(citajStanje({ ...o }).dezurstvo).toBe(true)
    expect(zabiljeziUspjeh({ ...o }).zavrsilo).toBe(true)
    expect(citajStanje({ ...o }).dezurstvo).toBe(false)
  })

  test('simulacija vrijedi do roka, pa sama prestaje', () => {
    const o = okruzje({})
    let sada = 1_000_000
    simulirajPad(2, { ...o, sat: () => sada })
    expect(simulacijaPada({ ...o, sat: () => sada })).toBe(true)
    sada += 3 * 60_000
    expect(simulacijaPada({ ...o, sat: () => sada })).toBe(false)
  })

  test('ciljDezurnog: anthropic-kompatibilan davatelj → --model + ANTHROPIC_BASE_URL', () => {
    const o = okruzje({ provider: 'lazni', model: 'glm-4.6' })
    const c = ciljDezurnog({ ...o })!
    expect(c.model).toBe('glm-4.6')
    expect(c.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${srv.port}`)
    expect(c.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test')
  })

  test('ciljDezurnog: Ollama nema Anthropic endpoint → null (ostaje obični poziv)', () => {
    const o = okruzje({ provider: 'ollama', model: 'qwen3:8b' })
    expect(ciljDezurnog({ ...o })).toBeNull()
  })
})

// ─── Razgovor: primarni padne → odgovara dežurni ─────────────────────────────

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
  odgovori: Array<Partial<ExecResult>> = []
  async run(req: ExecRequest): Promise<ExecResult> {
    this.zahtjevi.push(req)
    const o = this.odgovori.shift() || {}
    return { exitCode: 0, resultText: 'odgovor', sessionId: 'S1', numTurns: 1, ...o }
  }
}

function razgovor(dez: Record<string, unknown>) {
  const o = okruzje(dez)
  const izv = new Izv()
  const kanal = new Kanalic()
  const konzola: string[] = []
  const postavke: RazgovorPostavke = { ...RAZGOVOR_ZADANO, ime: 'Asistent', dopusteniKorisnici: ['1'], ukljucen: true, burstMs: 10, radniDir: join(mapa, 'radni') }
  const j = stvoriRazgovor({
    postavke: () => postavke, izvrsitelj: izv, jePauza: () => false, kvotaPuna: () => false,
    korijen: join(mapa, 'razg'), tmHome: mapa, home: mapa, port: 1, plocaUrl: 'http://x', instalacija: 'node-A',
    env: { PATH: '/usr/bin' }, konzola: r => konzola.push(r), log: () => {},
    dezurni: dezurniRazgovora({ ...o }),
  })
  const poruka = (tekst: string): UlaznaPoruka => ({
    kanal: 'telegram', chatId: '-5', porukaId: String(Math.random()), posiljateljId: '1', posiljateljIme: 'Korisnik',
    posiljateljJeBot: false, tekst, ts: new Date().toISOString(), privatno: true, obracanjeBotu: true,
  })
  return { j, izv, kanal, konzola, poruka, o }
}

describe('razgovor — dežurni preuzima kad primarni padne', () => {
  test('429 → CLI ponovljen na dežurnom (preusmjeren), odgovor 🔻 + red u konzoli', async () => {
    const r = razgovor({ provider: 'lazni', model: 'glm-4.6' })
    r.izv.odgovori.push({ exitCode: 1, resultText: '', greska: 'API Error: 429 rate_limit_error' })
    r.izv.odgovori.push({ exitCode: 0, resultText: 'ovdje dežurni', sessionId: 'D1' })
    r.j.primi(r.poruka('jesi tu?'), r.kanal)
    await r.j.mirno()
    expect(r.izv.zahtjevi.length).toBe(2)
    expect(r.izv.zahtjevi[1].model).toBe('glm-4.6')
    expect((r.izv.zahtjevi[1].extra as any).env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${srv.port}`)
    expect(r.kanal.tekstovi.join('\n')).toContain('🔻')
    expect(r.kanal.tekstovi.join('\n')).toContain('ovdje dežurni')
    expect(r.konzola.join('\n')).toMatch(/dežurni/i)
    expect(citajStanje({ ...r.o }).uzastopnihGresaka).toBe(1)
  })

  test('davatelj bez CLI puta (ollama) → obični poziv modela, odgovor stiže', async () => {
    const r = razgovor({ provider: 'ollama', model: 'qwen3:8b', baseUrl: `http://127.0.0.1:${srv.port}` })
    r.izv.odgovori.push({ exitCode: 1, resultText: '', greska: 'API Error: 401 authentication_error' })
    r.j.primi(r.poruka('jesi tu?'), r.kanal)
    await r.j.mirno()
    expect(r.izv.zahtjevi.length).toBe(1)
    expect(r.kanal.tekstovi.join('\n')).toContain('radi (ollama)')
  })

  test('simulirani pad: primarni se uopće ne zove, odgovara dežurni', async () => {
    const r = razgovor({ provider: 'openrouter', model: 'x/y' })
    // openrouter → CLI put preko OPENROUTER_ANTHROPIC_URL; lažni izvršitelj odgovori
    simulirajPad(5, { ...r.o })
    r.izv.odgovori.push({ exitCode: 0, resultText: 'rezervni ovdje' })
    r.j.primi(r.poruka('test'), r.kanal)
    await r.j.mirno()
    expect(r.izv.zahtjevi.length).toBe(1)
    expect(r.izv.zahtjevi[0].model).toBe('x/y')
    expect(r.kanal.tekstovi.join('\n')).toContain('rezervni ovdje')
    expect(r.konzola.join('\n')).toMatch(/simulira/i)
  })

  test('rok istekao NIJE pad primarnog — dežurni se ne pali', async () => {
    const r = razgovor({ provider: 'lazni', model: 'glm-4.6' })
    r.izv.odgovori.push({ exitCode: 124, resultText: '', greska: 'rok istekao (1000 ms)' })
    r.j.primi(r.poruka('x'), r.kanal)
    await r.j.mirno()
    expect(r.izv.zahtjevi.length).toBe(1)
    expect(r.kanal.tekstovi.join('\n')).not.toContain('🔻')
  })

  test('uspjeh primarnog gasi dežurstvo', async () => {
    const r = razgovor({ provider: 'lazni', model: 'glm-4.6', okidac_uzastopnih_gresaka: 1 })
    zabiljeziGresku({ ...r.o })
    expect(citajStanje({ ...r.o }).dezurstvo).toBe(true)
    r.j.primi(r.poruka('x'), r.kanal)
    await r.j.mirno()
    expect(citajStanje({ ...r.o }).dezurstvo).toBe(false)
  })
})

// ─── Orkestrator: agent u zadatku ────────────────────────────────────────────

describe('orkestrator — agent ponovljen na dežurnom kad primarni padne', () => {
  function orkestrator(izv: Izv, dez: Record<string, unknown>) {
    const o = okruzje(dez)
    const azuriranja: any[] = []
    const log: string[] = []
    const ports: any = {
      board: { update: async (id: string, p: any) => { azuriranja.push({ id, ...p }) }, list: async () => [] },
      bus: {}, executor: izv,
      agents: { list: () => [{ id: 'inzenjer' }], get: () => ({ id: 'inzenjer', model: 'opus' }), route: () => null },
      prompt: { build: () => 'PROMPT' },
      liveness: {}, notifier: { notify: async () => {} },
      clock: { now: () => Date.now() }, logger: { log: (r: string) => log.push(r) },
      dezurni: dezurniRazgovora({ ...o }),
    }
    const cfg: any = {
      enabled: true, pollIntervalMs: 1000, autoExecIntervalMs: 0,
      api: { baseUrl: 'http://x', promptBaseUrl: null },
      spawn: { maxConcurrent: 1, hardCeilingHours: 1, livenessWindowHours: 1, backoff: { baseMs: 1, maxMs: 1, jitter: false } },
      watchdog: { stale: {}, zombie: {}, deadAgent: {} }, prompt: { systemFacts: [] },
    }
    return { orc: new Orchestrator(ports, cfg), azuriranja, log }
  }

  test('429 → drugi run na dežurnom modelu s preusmjerenom okolinom; zadatak NIJE blocked', async () => {
    const izv = new Izv()
    izv.odgovori.push({ exitCode: 1, resultText: '', greska: 'API Error: 429 rate_limit_error' })
    izv.odgovori.push({ exitCode: 0, resultText: 'gotovo' })
    const { orc, azuriranja, log } = orkestrator(izv, { provider: 'lazni', model: 'glm-4.6' })
    const r = await orc.pokreniZadatak({ id: 'TASK-1', title: 't', status: 'pending' } as any, { id: 'inzenjer', model: 'opus' } as any)
    expect(r.exitCode).toBe(0)
    expect(izv.zahtjevi.length).toBe(2)
    expect(izv.zahtjevi[1].model).toBe('glm-4.6')
    const env = (izv.zahtjevi[1].extra as any).env
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${srv.port}`)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(azuriranja.some(a => a.status === 'blocked')).toBe(false)
    expect(azuriranja.some(a => (a.progressNotes || []).join(' ').match(/dežurn/i))).toBe(true)
    expect(log.join('\n')).toMatch(/dežurn/i)
  })

  test('greška koja nije pad primarnog → nema ponavljanja, blocked kao prije', async () => {
    const izv = new Izv()
    izv.odgovori.push({ exitCode: 1, resultText: '', greska: 'exit 1' })
    const { orc, azuriranja } = orkestrator(izv, { provider: 'lazni', model: 'glm-4.6' })
    await orc.pokreniZadatak({ id: 'TASK-2', title: 't', status: 'pending' } as any, { id: 'inzenjer', model: 'opus' } as any)
    expect(izv.zahtjevi.length).toBe(1)
    expect(azuriranja.some(a => a.status === 'blocked')).toBe(true)
  })
})
