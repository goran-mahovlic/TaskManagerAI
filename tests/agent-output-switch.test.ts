/**
 * agent-output-switch.test.ts — DORADA TASK-4817 (Arhitektica, arhitektura).
 *
 * Pokriva ono što je TASK-4815 (Inženjerka) ostavio otvoreno:
 *   §A  `renderAgentOutput(p, { mode })` — JEDAN prekidač kanala (§4 dizajna
 *       TASK-4813). Dosad je svako zvalo `renderMinimal` izravno, pa je preslika
 *       pravila „koji kanal dobiva što" rasla po pozivateljima (ADR-0004).
 *   §B  `voice` — do sada MRTAV KOD: `renderVoice` nije zvao nitko osim testa,
 *       a glasovni kanal je govorio konzerviranu rečenicu bez sadržaja agenta.
 *   §C  Rod u GOVORENOM tekstu — „završio/završila", „mogao/mogla". Isti kvar
 *       koji je TASK-4815 popravio na Telegramu, a na glasu ostavio.
 *   §D  Fail-soft prekidača: nepoznat način i null ulaz NIKAD ne bacaju.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import {
  MAX_MSG_LEN,
  mogaoMogla,
  parseAgentOutput,
  renderAgentOutput,
  renderMinimal,
  zavrsioZavrsila,
  postaviZenskiRod,
} from '../src/core/AgentOutputParser'

const IZVJESTAJ = [
  '📋 REZULTAT: Parser je spojen na sva tri kanala.',
  '📊 STATUS: Uspješno',
  '🗣️ Arhitekt: Prekidač prikaza spojen, glasovni kanal više nije mrtav kod.',
  'REGOC-STATUS: DONE — prekidač spojen',
].join('\n')

describe('§A — renderAgentOutput je JEDAN prekidač kanala', () => {
  test('minimal daje ISTI tekst kao izravni renderMinimal (nema druge gramatike)', () => {
    const p = parseAgentOutput(IZVJESTAJ)
    const preko = renderAgentOutput(p, { mode: 'minimal', heading: 'X:', maxLen: MAX_MSG_LEN })
    const izravno = renderMinimal(p, { heading: 'X:', maxLen: MAX_MSG_LEN })
    expect(preko.mode).toBe('minimal')
    expect(preko.mode === 'minimal' && preko.text).toBe(izravno)
  })

  test('full vraća STRUKTURU za ploču, ne niz', () => {
    const r = renderAgentOutput(parseAgentOutput(IZVJESTAJ), { mode: 'full', boardStatus: 'completed' })
    expect(r.mode).toBe('full')
    if (r.mode !== 'full') throw new Error('nije full')
    expect(r.board.badge).toBe('DONE')
    expect(typeof r.board.summary).toBe('string')
  })

  test('ploča ostaje mjerodavna i kroz prekidač — tekst ne smije PODIĆI bedž', () => {
    const r = renderAgentOutput(parseAgentOutput(IZVJESTAJ), { mode: 'full', boardStatus: 'in_progress' })
    if (r.mode !== 'full') throw new Error('nije full')
    expect(r.board.badge).not.toBe('DONE')
    expect(r.board.mismatch).toBe(true)
  })
})

describe('§B — voice: sadržaj agenta, ne konzervirana rečenica', () => {
  test('govori agentov 🗣️ redak', () => {
    const r = renderAgentOutput(parseAgentOutput(IZVJESTAJ), { mode: 'voice' })
    if (r.mode !== 'voice') throw new Error('nije voice')
    expect(r.text).toContain('Prekidač prikaza spojen')
  })

  test('bez 🗣️ retka vraća PRAZNO — pozivatelj zadržava svoju rečenicu, ne čita sirovi L3', () => {
    const sirovo = 'Popravio sam /srv/projekt/src/Daemon.ts na liniji 3607 i pokrenuo bun test.'
    const r = renderAgentOutput(parseAgentOutput(sirovo), { mode: 'voice' })
    if (r.mode !== 'voice') throw new Error('nije voice')
    expect(r.text).toBe('')
  })

  test('izgovorivo: bez emojija, markdowna, URL-ova i putanja', () => {
    const s = [
      '🗣️ Arhitekt: Spojeno **jako** dobro, vidi https://x.test/a i /srv/projekt/a.ts ✅',
    ].join('\n')
    const r = renderAgentOutput(parseAgentOutput(s), { mode: 'voice' })
    if (r.mode !== 'voice') throw new Error('nije voice')
    expect(r.text).not.toMatch(/[*`|]/)
    expect(r.text).not.toMatch(/https?:\/\//)
    expect(r.text).not.toMatch(/\/home\//)
    expect(r.text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/u)
  })

  test('strop 16 riječi (glas se sluša, ne čita)', () => {
    const dug = '🗣️ Ana: ' + Array.from({ length: 60 }, (_, i) => `rijec${i}`).join(' ')
    const r = renderAgentOutput(parseAgentOutput(dug), { mode: 'voice' })
    if (r.mode !== 'voice') throw new Error('nije voice')
    expect(r.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(17) // 16 + „…"
  })
})

describe('§C — rod u govorenom tekstu', () => {
  // Rod dolazi iz registra (config/agents.json, `"rod": "ž"`); test ga zadaje izravno.
  beforeAll(() => postaviZenskiRod(['arhitektica', 'inzenjerka', 'istrazivacica', 'analiticarka', 'umjetnica']))
  afterAll(() => postaviZenskiRod(null))
  test('mogaoMogla prati iste agentice kao zavrsioZavrsila', () => {
    for (const a of ['arhitektica', 'inzenjerka', 'istrazivacica', 'analiticarka', 'umjetnica']) {
      expect(mogaoMogla(a)).toBe('mogla')
      expect(zavrsioZavrsila(a)).toBe('završila')
    }
    for (const a of ['qa', 'sigurnost', 'dizajner', 'glas', 'regoc']) {
      expect(mogaoMogla(a)).toBe('mogao')
      expect(zavrsioZavrsila(a)).toBe('završio')
    }
  })

  test('nepoznat/prazan agent ne baca i daje muški rod (zatečeno ponašanje)', () => {
    expect(mogaoMogla(null)).toBe('mogao')
    expect(mogaoMogla(undefined)).toBe('mogao')
    expect(mogaoMogla('')).toBe('mogao')
    expect(mogaoMogla('  ARHITEKTICA  ')).toBe('mogla')
  })
})

describe('§D — fail-soft prekidača (nikad ne baca)', () => {
  test('null/prazan ulaz kroz sva tri načina', () => {
    for (const mode of ['full', 'minimal', 'voice'] as const) {
      expect(() => renderAgentOutput(parseAgentOutput(null), { mode, boardStatus: null })).not.toThrow()
      expect(() => renderAgentOutput(parseAgentOutput(''), { mode, boardStatus: null })).not.toThrow()
    }
  })

  test('nepoznat način pada na minimal umjesto da baci', () => {
    const r = renderAgentOutput(parseAgentOutput(IZVJESTAJ), { mode: 'teletekst' as any })
    expect(r.mode).toBe('minimal')
    expect(r.mode === 'minimal' && r.text.length > 0).toBe(true)
  })

  test('vrlo dug ulaz ne ruši nijedan način i poštuje strop', () => {
    const dug = 'a '.repeat(20000)
    const r = renderAgentOutput(parseAgentOutput(dug), { mode: 'minimal', maxLen: MAX_MSG_LEN })
    if (r.mode !== 'minimal') throw new Error('nije minimal')
    expect(r.text.length).toBeLessThanOrEqual(MAX_MSG_LEN)
  })
})

describe('rod iz registra agenata (ne iz koda)', () => {
  test('agent s "rod": "ž" u config/agents.json dobiva ženski rod, ostali muški', () => {
    const { mkdtempSync, writeFileSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const { tmpdir } = require('os') as typeof import('os')
    const dir = mkdtempSync(join(tmpdir(), 'rod-'))
    const p = join(dir, 'agents.json')
    writeFileSync(p, JSON.stringify({ agents: [{ id: 'ana', rod: 'ž' }, { id: 'ivo', rod: 'm' }, { id: 'bez' }] }))
    const prije = process.env.TM_AGENTS_CONFIG
    process.env.TM_AGENTS_CONFIG = p
    postaviZenskiRod(null)
    try {
      expect(zavrsioZavrsila('ana')).toBe('završila')
      expect(mogaoMogla('ANA')).toBe('mogla')
      expect(zavrsioZavrsila('ivo')).toBe('završio')
      expect(zavrsioZavrsila('bez')).toBe('završio')
    } finally {
      if (prije === undefined) delete process.env.TM_AGENTS_CONFIG
      else process.env.TM_AGENTS_CONFIG = prije
      postaviZenskiRod(null)
    }
  })
})
