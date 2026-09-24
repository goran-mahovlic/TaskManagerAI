// tests/spawn-finalizer.test.ts — ADR-0012 implementacija (Inženjerka, TASK-4827).
//
// `SpawnFinalizer` je JEDINI put kojim spawn završava u terminalnom stanju:
//   sud CompletionGuarda → sud kritičara → PRED-PROVJERA VRATARA (§12) → zatvaranje.
// Testovi zaključavaju točno ona četiri mjesta na kojima bi doslovna izvedba ADR-a
// proizvela novi kvar (nalazi G1–G3 iz DODATKA I i M2 iz DODATKA II):
//
//   F1  pred-provjera vratara: ono što bi API odbio s 400 daemon SAM pretvara u
//       `blocked` — inače zadatak visi u `in_progress` zauvijek (nema petlje popravka).
//   F2  FAIL kritičara ⇒ `blocked`, NIKAD `completed` (simulacija TASK-3068).
//   F3  najam se pušta PRIJE zapisa — inače daemon blokira sam sebe vlastitim guardom.
//   F4  terminalan skup se ČITA iz tablice prijelaza ({completed, cancelled}), ne prepisuje.
//   F5  (paket) ponovno otvaranje ne smije isprazniti terminalan skup.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const REGOC = join(import.meta.dir, '..')
let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'sf-'))
  process.env.REGOC_SPAWN_LEASE_DIR = join(sandbox, 'leases')
  process.env.REGOC_CLOSE_FAIL_LOG = join(sandbox, 'close_failures.jsonl')
})
afterEach(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch {} })

async function ucitaj() {
  return await import(`../src/core/SpawnFinalizer.ts?t=${Date.now()}${Math.random()}`)
}
async function ucitajNajam() {
  return await import(`../src/core/TaskCloser.ts?t=${Date.now()}${Math.random()}`)
}
function odgovor(status: number, tijelo = '{}') {
  return { ok: status >= 200 && status < 300, status, text: async () => tijelo } as unknown as Response
}

// ── F1 ───────────────────────────────────────────────────────────────────────
describe('F1 — pred-provjera vratara (§12): ono što API odbija s 400, daemon sam pretvara u blocked', () => {
  test('istraživački zadatak BEZ RAG ID-a: vratar ne prolazi, razlog imenuje vratara', async () => {
    const { provjeriVratareZatvaranja } = await ucitaj()
    const s = provjeriVratareZatvaranja({
      taskId: 'TASK-F1', tags: ['istrazivanje'], projectId: 'REGOC_SYSTEM',
      resultText: 'Istraživanje gotovo, nalaz u izvještaju.',
    })
    expect(s.ok).toBe(false)
    expect(s.code).toBe('missing_doc_id')
    expect(s.razlog).toContain('BLOCKED:')
  })

  test('isti zadatak S RAG ID-em prolazi', async () => {
    const { provjeriVratareZatvaranja } = await ucitaj()
    const s = provjeriVratareZatvaranja({
      taskId: 'TASK-F1', tags: ['istrazivanje'], projectId: 'REGOC_SYSTEM',
      resultText: 'Spremljeno: doc_1788958329155_jydtuo',
    })
    expect(s.ok).toBe(true)
  })

  test('neoznačen zadatak ne dira nijednog vratara', async () => {
    const { provjeriVratareZatvaranja } = await ucitaj()
    expect(provjeriVratareZatvaranja({ taskId: 'TASK-F1', tags: [], projectId: null, resultText: 'bilo što' }).ok).toBe(true)
  })
})

// ── F2 ───────────────────────────────────────────────────────────────────────
describe('F2 — simulacija TASK-3068: FAIL kritičara završava u blocked, nikad u completed', () => {
  const REZULTAT = [
    '📋 REZULTAT: implementirano',
    '=== VERIFIKACIJA ===',
    'naredba: bun test tests/x.test.ts',
    'izlaz: 24 pass, 0 fail',
    '=== KRAJ VERIFIKACIJE ===',
    'REGOC-STATUS: DONE — isporučeno',
  ].join('\n')

  test('kritičar FAIL ⇒ PUT status=blocked s razlogom CRITIC', async () => {
    const { finalizirajSpawn } = await ucitaj()
    const zapisi: any[] = []
    const r = await finalizirajSpawn({
      apiBase: 'http://x/api/tasks', taskId: 'TASK-3068', agentId: 'inzenjerka',
      resultText: REZULTAT, sinceMs: Date.now() - 1000,
      kritikaFn: async () => ({ enforce: true, blockedReason: 'BLOCKED: CRITIC_FAILED — bun test pada', brief: '✗ bun test' }),
      fetchFn: async (_u: any, init: any) => { zapisi.push(JSON.parse(init.body)); return odgovor(200) },
      dohvatiZadatakFn: async () => ({ tags: [], projectId: null }),
    })
    expect(r.status).toBe('blocked')
    expect(zapisi).toHaveLength(1)
    expect(zapisi[0].status).toBe('blocked')
    expect(zapisi[0].blocked_reason).toContain('CRITIC')
    // Ključna invarijanta cijelog ADR-a: riječ `completed` ne smije nikad otići na API.
    expect(JSON.stringify(zapisi)).not.toContain('"completed"')
  })

  test('čist prolaz ⇒ completed s rezultatom', async () => {
    const { finalizirajSpawn } = await ucitaj()
    const zapisi: any[] = []
    const r = await finalizirajSpawn({
      apiBase: 'http://x/api/tasks', taskId: 'TASK-OK', agentId: 'inzenjerka',
      resultText: REZULTAT, sinceMs: Date.now() - 1000,
      kritikaFn: async () => ({ enforce: false, blockedReason: '', brief: '' }),
      fetchFn: async (_u: any, init: any) => { zapisi.push(JSON.parse(init.body)); return odgovor(200) },
      dohvatiZadatakFn: async () => ({ tags: [], projectId: null }),
    })
    expect(r.status).toBe('completed')
    expect(zapisi[0].status).toBe('completed')
    expect(zapisi[0].result_summary).toContain('VERIFIKACIJA')
  })

  test('G1: vratar bi odbio ⇒ daemon zatvara kao blocked, NE ostavlja zombija', async () => {
    const { finalizirajSpawn } = await ucitaj()
    const zapisi: any[] = []
    const r = await finalizirajSpawn({
      apiBase: 'http://x/api/tasks', taskId: 'TASK-G1', agentId: 'istrazivacica',
      resultText: REZULTAT, sinceMs: Date.now() - 1000,
      kritikaFn: async () => ({ enforce: false, blockedReason: '', brief: '' }),
      fetchFn: async (_u: any, init: any) => { zapisi.push(JSON.parse(init.body)); return odgovor(200) },
      dohvatiZadatakFn: async () => ({ tags: ['istrazivanje'], projectId: 'REGOC_SYSTEM' }),
    })
    expect(r.status).toBe('blocked')
    expect(zapisi[0].status).toBe('blocked')
    expect(zapisi[0].blocked_reason).toContain('vratar')
  })

  test('agentova vlastita BLOCKED deklaracija se poštuje (tekst je jedini kanal)', async () => {
    const { finalizirajSpawn } = await ucitaj()
    const zapisi: any[] = []
    const r = await finalizirajSpawn({
      apiBase: 'http://x/api/tasks', taskId: 'TASK-NC', agentId: 'inzenjerka',
      resultText: 'Nemam pristup čvoru.\nREGOC-STATUS: BLOCKED — nedostaje SSH pristup',
      sinceMs: Date.now() - 1000,
      kritikaFn: async () => ({ enforce: false, blockedReason: '', brief: '' }),
      fetchFn: async (_u: any, init: any) => { zapisi.push(JSON.parse(init.body)); return odgovor(200) },
      dohvatiZadatakFn: async () => ({ tags: [], projectId: null }),
    })
    expect(r.status).toBe('blocked')
    expect(zapisi[0].status).toBe('blocked')
  })
})

// ── F3 ───────────────────────────────────────────────────────────────────────
describe('F3 — najam se pušta PRIJE zapisa (inače daemon blokira sam sebe)', () => {
  test('u trenutku PUT-a najam više nije aktivan', async () => {
    const { finalizirajSpawn } = await ucitaj()
    const { uzmiNajam, najamAktivan } = await ucitajNajam()
    uzmiNajam({ taskId: 'TASK-LEASE', agent: 'inzenjerka', pid: process.pid, startedAt: new Date().toISOString() })
    expect(najamAktivan('TASK-LEASE')).toBe(true)
    let aktivanZaVrijemePUT: boolean | null = null
    await finalizirajSpawn({
      apiBase: 'http://x/api/tasks', taskId: 'TASK-LEASE', agentId: 'inzenjerka',
      resultText: 'REGOC-STATUS: BLOCKED — test',
      sinceMs: Date.now() - 1000,
      kritikaFn: async () => ({ enforce: false, blockedReason: '', brief: '' }),
      fetchFn: async () => { aktivanZaVrijemePUT = najamAktivan('TASK-LEASE'); return odgovor(200) },
      dohvatiZadatakFn: async () => ({ tags: [], projectId: null }),
    })
    expect(aktivanZaVrijemePUT).toBe(false)
    expect(najamAktivan('TASK-LEASE')).toBe(false)
  })
})

// ── F4 ───────────────────────────────────────────────────────────────────────
describe('F4 — terminalan skup se čita iz tablice prijelaza, ne prepisuje (G2)', () => {
  test('{completed, cancelled} iz TaskManagerSQL.getAllowedTransitions', async () => {
    const { terminalniStatusi, jeTerminalan } = await ucitaj()
    const prijelazi = (s: string) => ({
      pending: ['in_progress', 'blocked', 'cancelled'],
      in_progress: ['completed', 'blocked', 'cancelled'],
      blocked: ['pending', 'in_progress', 'cancelled'],
      completed: [], cancelled: [],
    } as Record<string, string[]>)[s] ?? []
    const skup = terminalniStatusi(prijelazi)
    expect([...skup].sort()).toEqual(['cancelled', 'completed'])
    expect(jeTerminalan('cancelled', prijelazi)).toBe(true)
    expect(jeTerminalan('blocked', prijelazi)).toBe(false)
  })
})

// ── F5 (paket) ───────────────────────────────────────────────────────────────
// Izvorni F5 provjerava tekst promptova u demonima, kojih paket nema. Umjesto njega:
// regresija koju je donijelo ponovno otvaranje (F3). Stari sud „terminalan = nema
// prijelaza" nakon `completed → pending` daje PRAZAN skup, pa guard tiho utihne.
describe('F5 — ponovno otvaranje ne gasi guard (terminalan skup iz STVARNE tablice)', () => {
  test('uz pravu TaskManagerSQL tablicu skup ostaje {cancelled, completed}', async () => {
    const { terminalniStatusi, odlukaGuarda } = await ucitaj()
    const { TaskManagerSQL } = require('../src/core/TaskManagerSQL.ts')
    const { createEmptyTaskDb } = require('./helpers/db-fixture')
    const tm = new TaskManagerSQL(createEmptyTaskDb(join(sandbox, 'f5.db')))
    const prijelazi = (st: string) => tm.getAllowedTransitions(st)
    expect(prijelazi('completed')).toEqual(['pending'])
    expect([...terminalniStatusi(prijelazi)].sort()).toEqual(['cancelled', 'completed'])
    const o = odlukaGuarda({ status: 'completed', prijelazi, najamAktivan: true, force: false })
    expect(o.odbij).toBe(true)
    expect(o.code).toBe('SPAWN_ACTIVE')
  })
})

// ── F6 ───────────────────────────────────────────────────────────────────────
// `spawnCloseGuard` (§6.2 + G2/G4): dok na zadatku DOKAZIVO radi spawn, PUT u
// TERMINALNO stanje ne dolazi od daemona (on najam pušta prije zapisa) — dolazi od
// agenta. Guard čuva cijeli terminalni skup, fail-open je ugrađen, a poruka ne
// reklamira zaobilaznicu (G4: `CompletionGuard` doslovno piše kako ga pregaziti).
describe('F6 — odluka spawnCloseGuarda', () => {
  const prijelazi = (s: string) => ({
    pending: ['in_progress', 'blocked', 'cancelled'],
    in_progress: ['completed', 'blocked', 'cancelled'],
    blocked: ['pending', 'in_progress', 'cancelled'],
    completed: [], cancelled: [],
  } as Record<string, string[]>)[s] ?? []

  test('completed uz aktivan najam → odbij', async () => {
    const { odlukaGuarda } = await ucitaj()
    const o = odlukaGuarda({ status: 'completed', prijelazi, najamAktivan: true, force: false })
    expect(o.odbij).toBe(true)
    expect(o.code).toBe('SPAWN_ACTIVE')
  })

  test('G2: cancelled je jednako terminalan → odbij', async () => {
    const { odlukaGuarda } = await ucitaj()
    expect(odlukaGuarda({ status: 'cancelled', prijelazi, najamAktivan: true, force: false }).odbij).toBe(true)
  })

  test('blocked NIJE terminalan → prolazi (pošteno samoprijavljivanje se ne zaustavlja)', async () => {
    const { odlukaGuarda } = await ucitaj()
    expect(odlukaGuarda({ status: 'blocked', prijelazi, najamAktivan: true, force: false }).odbij).toBe(false)
  })

  test('bez najma prolazi (fail-open — čovjek s ploče, skripta, daemon)', async () => {
    const { odlukaGuarda } = await ucitaj()
    expect(odlukaGuarda({ status: 'completed', prijelazi, najamAktivan: false, force: false }).odbij).toBe(false)
  })

  test('X-REGOC-Force preskače guard (svjestan ljudski potez)', async () => {
    const { odlukaGuarda } = await ucitaj()
    expect(odlukaGuarda({ status: 'completed', prijelazi, najamAktivan: true, force: true }).odbij).toBe(false)
  })

  test('G4: poruka kaže ŠTO učiniti, ali NE spominje zaobilaznicu', async () => {
    const { odlukaGuarda } = await ucitaj()
    const o = odlukaGuarda({ status: 'completed', prijelazi, najamAktivan: true, force: false })
    expect(o.hint).toContain('REGOC-STATUS')
    expect(o.hint.toLowerCase()).not.toContain('force')
    expect(o.hint.toLowerCase()).not.toContain('x-regoc')
  })
})
