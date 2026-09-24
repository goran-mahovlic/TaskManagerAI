/**
 * TASK-5013 — dodatne upute agentu DOK RADI.
 *
 * Što se dokazuje:
 *  • uputa je zaseban zapis (tablica `task_instructions`), ne progressNote;
 *  • unos se validira (prazan tekst, predug tekst, nepostojeći autor → zadano);
 *  • preuzimanje je atomično: dva usporedna preuzimanja ne dostave istu uputu dvaput;
 *  • dostavljena uputa nosi `delivered_at` i sesiju, pa ploča zna „dostavljeno/nije";
 *  • tekst za agenta nosi broj upute i traži potvrdu „uputa #N primljena";
 *  • odgovor hooka je ispravan JSON za PostToolUse i SessionStart, a za ostalo šuti;
 *  • hook je FAIL-OPEN: nema zadatka / API ne odgovara / API vrati smeće → izlaz 0, bez ispisa.
 */
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  ensureInstructionsSchema,
  parseInstructionInput,
  addInstruction,
  listInstructions,
  claimUndelivered,
  instructionCounts,
  instructionSummary,
  formatForAgent,
  hookOutput,
  runInstructionHook,
  INSTRUCTION_MAX_CHARS,
} from '../src/core/TaskInstructions'

function freshDb(): Database {
  const db = new Database(':memory:')
  ensureInstructionsSchema(db)
  return db
}

describe('shema', () => {
  test('idempotentna — dvostruki poziv ne ruši', () => {
    const db = freshDb()
    ensureInstructionsSchema(db)
    const cols = (db.query(`PRAGMA table_info(task_instructions)`).all() as any[]).map(c => c.name)
    expect(cols).toEqual(['id', 'task_id', 'author', 'text', 'created_at', 'delivered_at', 'delivered_session'])
  })
})

describe('parseInstructionInput', () => {
  test('ispravan unos', () => {
    expect(parseInstructionInput({ text: '  koristi ILA  ', author: 'goran' }))
      .toEqual({ ok: true, text: 'koristi ILA', author: 'goran' })
  })
  test('prihvaća i polje `uputa` (hrvatski naziv)', () => {
    expect(parseInstructionInput({ uputa: 'x' })).toEqual({ ok: true, text: 'x', author: 'user' })
  })
  test('prazan tekst se odbija', () => {
    expect(parseInstructionInput({ text: '   ' }).ok).toBe(false)
    expect(parseInstructionInput({}).ok).toBe(false)
    expect(parseInstructionInput(null).ok).toBe(false)
  })
  test('predug tekst se odbija', () => {
    const r = parseInstructionInput({ text: 'a'.repeat(INSTRUCTION_MAX_CHARS + 1) })
    expect(r.ok).toBe(false)
  })
  test('autor se čisti i skraćuje', () => {
    const r = parseInstructionInput({ text: 'x', by: '  REGOČ  ' })
    expect(r).toEqual({ ok: true, text: 'x', author: 'REGOČ' })
  })
})

describe('spremište i preuzimanje', () => {
  test('dodaj → nedostavljeno → preuzmi → dostavljeno sa sesijom', () => {
    const db = freshDb()
    const a = addInstruction(db, 'TASK-1', 'goran', 'prva')
    const b = addInstruction(db, 'TASK-1', 'regoc', 'druga')
    addInstruction(db, 'TASK-2', 'goran', 'tuđa')
    expect(a.id).toBeLessThan(b.id)
    expect(listInstructions(db, 'TASK-1', { undeliveredOnly: true }).map(r => r.text)).toEqual(['prva', 'druga'])

    const got = claimUndelivered(db, 'TASK-1', 'sess-abc')
    expect(got.map(r => r.text)).toEqual(['prva', 'druga'])
    expect(got.every(r => r.delivered_session === 'sess-abc' && !!r.delivered_at)).toBe(true)

    expect(listInstructions(db, 'TASK-1', { undeliveredOnly: true })).toEqual([])
    expect(listInstructions(db, 'TASK-1').length).toBe(2)
    // tuđi zadatak ostaje netaknut
    expect(listInstructions(db, 'TASK-2', { undeliveredOnly: true }).length).toBe(1)
  })

  test('drugo preuzimanje ne vraća ništa (nema dvostruke dostave)', () => {
    const db = freshDb()
    addInstruction(db, 'TASK-1', 'goran', 'jednom')
    expect(claimUndelivered(db, 'TASK-1', 's1').length).toBe(1)
    expect(claimUndelivered(db, 'TASK-1', 's2').length).toBe(0)
  })

  test('uputa dodana poslije preuzimanja stiže u sljedećem preuzimanju', () => {
    const db = freshDb()
    addInstruction(db, 'TASK-1', 'goran', 'a')
    claimUndelivered(db, 'TASK-1', 's1')
    addInstruction(db, 'TASK-1', 'goran', 'b')
    expect(claimUndelivered(db, 'TASK-1', 's1').map(r => r.text)).toEqual(['b'])
  })

  test('brojač za ploču', () => {
    const db = freshDb()
    addInstruction(db, 'TASK-1', 'goran', 'a')
    addInstruction(db, 'TASK-1', 'goran', 'b')
    claimUndelivered(db, 'TASK-1', 's1')
    addInstruction(db, 'TASK-1', 'goran', 'c')
    expect(instructionCounts(db, 'TASK-1')).toEqual({ total: 3, undelivered: 1 })
    expect(instructionCounts(db, 'TASK-9')).toEqual({ total: 0, undelivered: 0 })
  })

  test('sažetak za cijelu ploču — samo zadaci koji imaju upute', () => {
    const db = freshDb()
    addInstruction(db, 'TASK-1', 'goran', 'a')
    addInstruction(db, 'TASK-2', 'goran', 'b')
    claimUndelivered(db, 'TASK-2', 's')
    expect(instructionSummary(db)).toEqual({
      'TASK-1': { total: 1, undelivered: 1 },
      'TASK-2': { total: 1, undelivered: 0 },
    })
  })
})

describe('tekst za agenta', () => {
  test('nosi broj, autora i traži potvrdu', () => {
    const txt = formatForAgent('TASK-7', [
      { id: 12, task_id: 'TASK-7', author: 'goran', text: 'koristi ILA', created_at: '2026-09-24T11:40:00.000Z', delivered_at: null, delivered_session: null },
    ])
    expect(txt).toContain('TASK-7')
    expect(txt).toContain('#12')
    expect(txt).toContain('goran')
    expect(txt).toContain('koristi ILA')
    expect(txt).toContain('uputa #12 primljena')
    // lokalno vrijeme (CEST) — 11:40Z = 13:40
    expect(txt).toContain('13:40')
  })
  test('prazan popis → prazan tekst', () => {
    expect(formatForAgent('TASK-7', [])).toBe('')
  })
})

describe('hookOutput', () => {
  test('PostToolUse i SessionStart dobivaju additionalContext', () => {
    for (const ev of ['PostToolUse', 'SessionStart']) {
      const o = JSON.parse(hookOutput(ev, 'TEKST')!)
      expect(o.hookSpecificOutput).toEqual({ hookEventName: ev, additionalContext: 'TEKST' })
    }
  })
  test('nepodržan događaj ili prazan tekst → ništa', () => {
    expect(hookOutput('Stop', 'TEKST')).toBeNull()
    expect(hookOutput('PostToolUse', '')).toBeNull()
  })
})

describe('runInstructionHook — fail-open', () => {
  const row = { id: 3, task_id: 'TASK-1', author: 'goran', text: 'stani', created_at: '2026-09-24T10:00:00Z', delivered_at: 'x', delivered_session: 's' }

  test('bez REGOC_TASK_ID ne zove API i ne ispisuje ništa', async () => {
    let called = false
    const out = await runInstructionHook({
      env: {}, stdin: '{"hook_event_name":"PostToolUse"}',
      fetchFn: (async () => { called = true; return new Response('[]') }) as any,
    })
    expect(out).toBeNull()
    expect(called).toBe(false)
  })

  test('dostava: preuzme upute i vrati additionalContext, šalje sesiju', async () => {
    let seenUrl = '', seenBody: any = null
    const out = await runInstructionHook({
      env: { REGOC_TASK_ID: 'TASK-1' },
      stdin: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-9' }),
      fetchFn: (async (url: string, init: any) => {
        seenUrl = url; seenBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ instructions: [row] }), { status: 200 })
      }) as any,
      baseUrl: 'http://localhost:17781',
    })
    expect(seenUrl).toBe('http://localhost:17781/api/tasks/TASK-1/upute/preuzmi')
    expect(seenBody).toEqual({ session: 'sess-9' })
    const o = JSON.parse(out!)
    expect(o.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(o.hookSpecificOutput.additionalContext).toContain('#3')
  })

  test('API ugašen (fetch baca) → null', async () => {
    const out = await runInstructionHook({
      env: { REGOC_TASK_ID: 'TASK-1' }, stdin: '{"hook_event_name":"PostToolUse"}',
      fetchFn: (async () => { throw new Error('ECONNREFUSED') }) as any,
    })
    expect(out).toBeNull()
  })

  test('API spor → rok presiječe i vrati null', async () => {
    const t0 = Date.now()
    const out = await runInstructionHook({
      env: { REGOC_TASK_ID: 'TASK-1' }, stdin: '{"hook_event_name":"PostToolUse"}',
      timeoutMs: 50,
      fetchFn: ((_u: string, init: any) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('abort')))
      })) as any,
    })
    expect(out).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test('API vrati 500 ili smeće → null', async () => {
    for (const resp of [new Response('x', { status: 500 }), new Response('ne-json', { status: 200 })]) {
      const out = await runInstructionHook({
        env: { REGOC_TASK_ID: 'TASK-1' }, stdin: '{"hook_event_name":"PostToolUse"}',
        fetchFn: (async () => resp) as any,
      })
      expect(out).toBeNull()
    }
  })

  test('pokvaren stdin → i dalje radi (zadani događaj PostToolUse)', async () => {
    const out = await runInstructionHook({
      env: { REGOC_TASK_ID: 'TASK-1' }, stdin: 'nije json',
      fetchFn: (async () => new Response(JSON.stringify({ instructions: [row] }))) as any,
    })
    expect(JSON.parse(out!).hookSpecificOutput.hookEventName).toBe('PostToolUse')
  })

  test('paket: TM_TASK_ID + TM_PORT umjesto REGOČ-ove okoline', async () => {
    let seenUrl = ''
    await runInstructionHook({
      env: { TM_TASK_ID: 'TASK-8', TM_PORT: '18000' }, stdin: '{"hook_event_name":"PostToolUse"}',
      fetchFn: (async (url: string) => { seenUrl = url; return new Response('{"instructions":[]}') }) as any,
    })
    expect(seenUrl).toBe('http://localhost:18000/api/tasks/TASK-8/upute/preuzmi')
  })

  test('ID zadatka s nedopuštenim znakovima se ne šalje', async () => {
    let called = false
    const out = await runInstructionHook({
      env: { REGOC_TASK_ID: '../../etc' }, stdin: '{"hook_event_name":"PostToolUse"}',
      fetchFn: (async () => { called = true; return new Response('{}') }) as any,
    })
    expect(out).toBeNull()
    expect(called).toBe(false)
  })

  test('nepodržan događaj → ne preuzima (uputa ostaje za sljedeći put)', async () => {
    let called = false
    const out = await runInstructionHook({
      env: { REGOC_TASK_ID: 'TASK-1' }, stdin: '{"hook_event_name":"Stop"}',
      fetchFn: (async () => { called = true; return new Response('{}') }) as any,
    })
    expect(out).toBeNull()
    expect(called).toBe(false)
  })
})
