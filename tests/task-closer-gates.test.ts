// tests/task-closer-gates.test.ts — ADR-0012 DODATAK (Jelena, TASK-4824).
//
// Inženjerski pregled dizajna opcije (B) prije implementacije. Svaki test ovdje
// zaključava JEDAN nalaz koji bi se pri implementaciji tiho izgubio:
//
//   G1  Pod (B) daemonov PUT prolazi kroz TRI vratara koji vraćaju HTTP 400
//       (CompletionGuard, ResearchRagGate live=true, GitCommitGate live=true).
//       400 se NE ponavlja i NE popravlja — zadatak ostaje `in_progress` zauvijek.
//       Danas tu rupu zatvara agentova vlastita petlja popravka (TASK-4595:
//       research-rag-gate REJECT → agent dopuni RAG ID → ACCEPT), koja pod (B) nestaje.
//   G2  `cancelled` je JEDNAKO terminalan kao `completed`, a `in_progress → cancelled`
//       je dopušten ⇒ guard koji čuva samo `completed` ostavlja druga vrata otvorena.
//   G3  Dijagnoza u dnevniku mora razlikovati 409 (zabranjen prijelaz) od 400 (vratar).
//   G5  Najam uzet ondje gdje `spawnInfo.pid === 0` (RegocDaemon.ts:3068) je INERTAN —
//       `najamAktivan` nikad ne vraća true. Najam se mora uzeti na :3165, gdje je
//       `spawnInfo.pid = proc.pid` već postavljen.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tc-gates-'))
  process.env.REGOC_SPAWN_LEASE_DIR = join(sandbox, 'leases')
  process.env.REGOC_CLOSE_FAIL_LOG = join(sandbox, 'close_failures.jsonl')
})
afterEach(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch {} })

async function ucitaj() {
  return await import(`../src/core/TaskCloser.ts?t=${Date.now()}${Math.random()}`)
}

function odgovor(status: number, tijelo = '') {
  return { ok: status >= 200 && status < 300, status, text: async () => tijelo } as unknown as Response
}

const TIJELO_VRATARA = JSON.stringify({
  error: 'Research not stored in RAG', code: 'missing_doc_id',
  details: 'result_summary nema ID dokumenta',
})

describe('G1/G3 — 400 od vratara NIJE isti kvar kao 409', () => {
  test('400 se NE ponavlja (ponavljanje ga ne može popraviti)', async () => {
    const { zatvoriZadatak } = await ucitaj()
    let pozivi = 0
    const r = await zatvoriZadatak('http://x/api/tasks', 'TASK-G1', { status: 'completed' }, {
      fetchFn: async () => { pozivi++; return odgovor(400, TIJELO_VRATARA) },
      sleepFn: async () => {},
    })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(400)
    expect(pozivi).toBe(1)
  })

  test('400 → dnevnik imenuje VRATARA i kaže da zadatak ostaje in_progress', async () => {
    const { zatvoriZadatak } = await ucitaj()
    const redci: string[] = []
    await zatvoriZadatak('http://x/api/tasks', 'TASK-G3a', { status: 'completed' }, {
      fetchFn: async () => odgovor(400, TIJELO_VRATARA),
      sleepFn: async () => {},
      log: (p: string) => redci.push(p),
    })
    const zadnji = redci.join('\n')
    expect(zadnji).toContain('vratar')
    expect(zadnji).toContain('in_progress')
    // Pogrešna dijagnoza bi čitatelja poslala tražiti tko je zatvorio zadatak —
    // a zadatak NIJE zatvoren.
    expect(zadnji).not.toContain('terminalnom stanju')
  })

  test('409 → dnevnik i dalje govori o zabranjenom prijelazu (rupa TASK-3069)', async () => {
    const { zatvoriZadatak } = await ucitaj()
    const redci: string[] = []
    await zatvoriZadatak('http://x/api/tasks', 'TASK-G3b', { status: 'blocked' }, {
      fetchFn: async () => odgovor(409, 'Forbidden status transition'),
      sleepFn: async () => {},
      log: (p: string) => redci.push(p),
    })
    expect(redci.join('\n')).toContain('terminalnom stanju')
  })

  test('5xx se i dalje ponavlja (mreža/poslužitelj su popravljivi)', async () => {
    const { zatvoriZadatak } = await ucitaj()
    let pozivi = 0
    const r = await zatvoriZadatak('http://x/api/tasks', 'TASK-G1b', { status: 'completed' }, {
      fetchFn: async () => { pozivi++; return pozivi === 1 ? odgovor(503) : odgovor(200) },
      sleepFn: async () => {},
    })
    expect(r.ok).toBe(true)
    expect(pozivi).toBe(2)
  })
})

describe('G5 — najam s pid=0 je INERTAN (mjesto uzimanja najma je bitno)', () => {
  test('pid 0 (stanje na RegocDaemon.ts:3068) → guard nikad ne okine', async () => {
    const { uzmiNajam, najamAktivan } = await ucitaj()
    uzmiNajam({ taskId: 'TASK-P0', agent: 'jelena', pid: 0, startedAt: new Date().toISOString() })
    expect(najamAktivan('TASK-P0')).toBe(false)
  })

  test('pid stvarnog procesa (stanje na :3165) → guard okine', async () => {
    const { uzmiNajam, najamAktivan } = await ucitaj()
    uzmiNajam({ taskId: 'TASK-P1', agent: 'jelena', pid: process.pid, startedAt: new Date().toISOString() })
    expect(najamAktivan('TASK-P1')).toBe(true)
  })
})

describe('G2 — terminalna stanja: `cancelled` su druga vrata na isto mjesto', () => {
  const { TaskManagerSQL } = require('../src/core/TaskManagerSQL.ts')
  const { createEmptyTaskDb } = require('./helpers/db-fixture')

  function svjezaBaza() {
    const p = join(sandbox, `g2-${Math.random().toString(36).slice(2)}.db`)
    createEmptyTaskDb(p)
    return new TaskManagerSQL(p)
  }

  test('terminalan skup je {completed, cancelled}, ne samo {completed}', () => {
    const tm = svjezaBaza()
    // Ponovno otvaranje (F3) vraća zatvoren zadatak SAMO u red — to nije napredak rada.
    expect(tm.getAllowedTransitions('completed')).toEqual(['pending'])
    expect(tm.getAllowedTransitions('cancelled')).toEqual(['pending'])
    // `blocked` NIJE terminalan — zato ga guard 1. faze smije pustiti.
    expect(tm.getAllowedTransitions('blocked').length).toBeGreaterThan(0)
  })

  test('agent može iz in_progress u `cancelled` i time jednako zaključati ploču', () => {
    const tm = svjezaBaza()
    const t = tm.createTask({ title: 'g2', description: 'x', assignee: 'jelena' })
    expect(tm.updateTask(t.id, { status: 'in_progress' })).toBeTruthy()
    // agent (halucinacija / stari prompt) sam otkaže zadatak
    expect(tm.updateTask(t.id, { status: 'cancelled' })).toBeTruthy()
    // daemonov sud nakon kritičara više NEMA gdje sletjeti — isti kvar kao TASK-3068
    expect(tm.updateTask(t.id, { status: 'completed' })).toBeNull()
    expect(tm.updateTask(t.id, { status: 'blocked' })).toBeNull()
    expect(tm.getTask(t.id).status).toBe('cancelled')
  })
})

describe('G1 e2e — 400 vratara ostavlja ZOMBIJA, a propisani izlaz (blocked) prolazi', () => {
  const { TaskManagerSQL } = require('../src/core/TaskManagerSQL.ts')
  const { createEmptyTaskDb } = require('./helpers/db-fixture')

  function svjezaBaza() {
    const p = join(sandbox, `g1-${Math.random().toString(36).slice(2)}.db`)
    createEmptyTaskDb(p)
    return new TaskManagerSQL(p)
  }

  test('daemonov `completed` odbijen s 400 → zadatak ostaje in_progress (zombi)', async () => {
    const { zatvoriZadatak } = await ucitaj()
    const tm = svjezaBaza()
    const t = tm.createTask({ title: 'istrazivanje bez RAG ID-a', description: 'x', assignee: 'manda', tags: ['istrazivanje'] })
    tm.updateTask(t.id, { status: 'in_progress' })

    // TaskWebUI s live ResearchRagGate-om vraća 400 prije nego ijedan redak dođe do baze.
    const r = await zatvoriZadatak('http://x/api/tasks', t.id, { status: 'completed', result_summary: 'gotovo' }, {
      fetchFn: async () => odgovor(400, TIJELO_VRATARA),
      sleepFn: async () => {},
    })
    expect(r.ok).toBe(false)
    expect(tm.getTask(t.id).status).toBe('in_progress')   // ← zombi: ni ✅ ni blocked
  })

  test('propisani izlaz: daemon sud vratara pretvori u `blocked` — taj prijelaz PROLAZI', () => {
    const tm = svjezaBaza()
    const t = tm.createTask({ title: 'istrazivanje bez RAG ID-a', description: 'x', assignee: 'manda', tags: ['istrazivanje'] })
    tm.updateTask(t.id, { status: 'in_progress' })
    const ok = tm.updateTask(t.id, { status: 'blocked', blockedReason: 'BLOCKED: vratar (missing_doc_id) — nalaz nije spremljen u RAG' })
    expect(ok).toBeTruthy()
    expect(tm.getTask(t.id).status).toBe('blocked')
    expect(tm.getTask(t.id).blockedReason).toContain('missing_doc_id')
  })
})
