// tests/task-closer.test.ts — ADR-0012 (opcija B): zatvaranje ide SAMO kroz daemon.
//
// Dva bloka:
//   1. TaskCloser — pouzdanost PUT-a (log + retry) i najam spawna.
//   2. SIMULACIJA TASK-3068 nad PRAVIM TaskManagerSQL-om (privremena baza):
//      stari redoslijed reproducira rupu, novi je zatvara.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let sandbox: string

// Najmovi i dnevnik neuspjeha idu u sandbox — modul ih čita iz env-a pri učitavanju,
// pa se env postavlja PRIJE dinamičkog importa.
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'task-closer-'))
  process.env.REGOC_SPAWN_LEASE_DIR = join(sandbox, 'leases')
  process.env.REGOC_CLOSE_FAIL_LOG = join(sandbox, 'close_failures.jsonl')
})
afterEach(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch {} })

async function ucitaj() {
  // `?t=` sprječava keš modula između testova s različitim env-om
  return await import(`../src/core/TaskCloser.ts?t=${Date.now()}${Math.random()}`)
}

function odgovor(status: number, tijelo = '') {
  return { ok: status >= 200 && status < 300, status, text: async () => tijelo } as unknown as Response
}

describe('TaskCloser.zatvoriZadatak — PUT koji se ne smije izgubiti', () => {
  test('uspjeh iz prvog pokušaja: jedan poziv, bez ponavljanja', async () => {
    const { zatvoriZadatak } = await ucitaj()
    let pozivi = 0
    const r = await zatvoriZadatak('http://x/api/tasks', 'TASK-1', { status: 'completed' }, {
      fetchFn: async () => { pozivi++; return odgovor(200) },
      sleepFn: async () => {},
    })
    expect(r.ok).toBe(true)
    expect(pozivi).toBe(1)
    expect(r.pokusaja).toBe(1)
  })

  test('pad mreže → PONOVI jednom i uspije (ovo je danas tiho nestajalo)', async () => {
    const { zatvoriZadatak } = await ucitaj()
    let pozivi = 0
    const r = await zatvoriZadatak('http://x/api/tasks', 'TASK-2', { status: 'blocked' }, {
      fetchFn: async () => {
        pozivi++
        if (pozivi === 1) throw new Error('ECONNREFUSED')
        return odgovor(200)
      },
      sleepFn: async () => {},
    })
    expect(r.ok).toBe(true)
    expect(pozivi).toBe(2)
  })

  test('5xx se ponavlja, 409 se NE ponavlja (ponavljanje ga ne može popraviti)', async () => {
    const { zatvoriZadatak } = await ucitaj()
    let p5 = 0, p409 = 0
    await zatvoriZadatak('http://x/api/tasks', 'TASK-3', { status: 'blocked' }, {
      fetchFn: async () => { p5++; return odgovor(503) }, sleepFn: async () => {},
    })
    await zatvoriZadatak('http://x/api/tasks', 'TASK-4', { status: 'blocked' }, {
      fetchFn: async () => { p409++; return odgovor(409, 'Forbidden status transition') }, sleepFn: async () => {},
    })
    expect(p5).toBe(2)
    expect(p409).toBe(1)
  })

  test('trajni neuspjeh: logira se I zapisuje u close_failures.jsonl (nema više catch {})', async () => {
    const { zatvoriZadatak, NEUSPJESI_LOG } = await ucitaj()
    const dnevnik: string[] = []
    const r = await zatvoriZadatak('http://x/api/tasks', 'TASK-3068', { status: 'blocked' }, {
      fetchFn: async () => odgovor(409, 'Forbidden status transition: completed -> blocked'),
      sleepFn: async () => {}, log: (m: string) => dnevnik.push(m),
    })
    expect(r.ok).toBe(false)
    expect(r.httpStatus).toBe(409)
    expect(dnevnik.join('\n')).toContain('TASK-3068')
    expect(dnevnik.join('\n')).toContain('zatvorio prije daemona')
    expect(existsSync(NEUSPJESI_LOG)).toBe(true)
    const zapis = JSON.parse(readFileSync(NEUSPJESI_LOG, 'utf-8').trim().split('\n').pop()!)
    expect(zapis.taskId).toBe('TASK-3068')
    expect(zapis.httpStatus).toBe(409)
  })
})

describe('TaskCloser — najam spawna (obrana u dubinu, fail-open)', () => {
  test('bez najma → nije aktivan (nitko se ne zaključava bez razloga)', async () => {
    const { najamAktivan } = await ucitaj()
    expect(najamAktivan('TASK-X')).toBe(false)
  })

  test('najam ŽIVOG procesa → aktivan; nakon pustiNajam → neaktivan', async () => {
    const { uzmiNajam, pustiNajam, najamAktivan } = await ucitaj()
    uzmiNajam({ taskId: 'TASK-Y', agent: 'jelena', pid: process.pid, startedAt: new Date().toISOString() })
    expect(najamAktivan('TASK-Y')).toBe(true)
    pustiNajam('TASK-Y')
    expect(najamAktivan('TASK-Y')).toBe(false)
  })

  test('mrtav pid → NIJE aktivan (fail-open: daemon ubijen kill -9 ne zaključava ploču)', async () => {
    const { uzmiNajam, najamAktivan } = await ucitaj()
    uzmiNajam({ taskId: 'TASK-Z', agent: 'jelena', pid: 2147483646, startedAt: new Date().toISOString() })
    expect(najamAktivan('TASK-Z')).toBe(false)
  })

  test('ustajao najam (> 4 h) → NIJE aktivan', async () => {
    const { uzmiNajam, najamAktivan, NAJAM_MAX_MS } = await ucitaj()
    const star = new Date(Date.now() - NAJAM_MAX_MS - 1000).toISOString()
    uzmiNajam({ taskId: 'TASK-S', agent: 'jelena', pid: process.pid, startedAt: star })
    expect(najamAktivan('TASK-S')).toBe(false)
  })

  test('pokvaren JSON → NIJE aktivan (fail-open), i čišćenje ga ukloni', async () => {
    const { najamAktivan, pocistiNajmove, NAJMOVI_DIR } = await ucitaj()
    mkdirSync(NAJMOVI_DIR, { recursive: true })
    writeFileSync(join(NAJMOVI_DIR, 'TASK-Q.json'), '{ ovo nije json')
    expect(najamAktivan('TASK-Q')).toBe(false)
    expect(pocistiNajmove().length).toBe(1)
  })
})

describe('SIMULACIJA TASK-3068 nad pravim TaskManagerSQL-om', () => {
  const { TaskManagerSQL } = require('../src/core/TaskManagerSQL.ts')
  const { createEmptyTaskDb } = require('./helpers/db-fixture')

  function svjezaBaza() {
    const p = join(sandbox, `sim-${Math.random().toString(36).slice(2)}.db`)
    createEmptyTaskDb(p)
    return new TaskManagerSQL(p)
  }

  test('STARI redoslijed (agent sam zatvara) → kritičarev `blocked` PROPADA, ploča laže ✅', () => {
    const tm = svjezaBaza()
    const t = tm.createTask({ title: 'sim 3068', description: 'x', assignee: 'jelena' })
    tm.updateTask(t.id, { status: 'in_progress' })

    // 1. agent sam PUT-a completed (danas: uputa iz prompta, RegocDaemon.ts:2366)
    expect(tm.updateTask(t.id, { status: 'completed' })?.status).toBe('completed')

    // 2. spawn izlazi, kritičar presudi FAIL, daemon PUT-a blocked (RegocDaemon.ts:3579)
    const daemonov = tm.updateTask(t.id, { status: 'blocked', blockedReason: 'BLOCKED: CRITIC_FAILED' })

    // → `completed` je terminalno stanje: daemonov zapis je odbijen...
    expect(daemonov).toBeNull()
    // ...a ploča i dalje pokazuje ✅ iako je provjera pala. TO JE RUPA.
    expect(tm.getTask(t.id)?.status).toBe('completed')
    expect(tm.getTask(t.id)?.blockedReason ?? '').not.toContain('CRITIC_FAILED')
  })

  test('NOVI redoslijed (agent NE zatvara) → kritičarev FAIL STVARNO završi kao `blocked`', () => {
    const tm = svjezaBaza()
    const t = tm.createTask({ title: 'sim 3068 B', description: 'x', assignee: 'jelena' })
    tm.updateTask(t.id, { status: 'in_progress' })   // daemon na startu spawna

    // agent radi i SAMO tekstualno deklarira ishod — nijedan PUT statusa
    const odgovorAgenta = 'REGOC-STATUS: DONE — implementirano i provjereno'
    expect(odgovorAgenta).toContain('REGOC-STATUS')
    expect(tm.getTask(t.id)?.status).toBe('in_progress')

    // spawn izlazi → kritičar FAIL → daemon zatvara po presudi
    const daemonov = tm.updateTask(t.id, { status: 'blocked', blockedReason: 'BLOCKED: CRITIC_FAILED' })
    expect(daemonov).not.toBeNull()
    expect(tm.getTask(t.id)?.status).toBe('blocked')
    expect(tm.getTask(t.id)?.blockedReason).toContain('CRITIC_FAILED')
  })

  test('NOVI redoslijed, kritičar PASS → daemon uredno zatvara kao completed', () => {
    const tm = svjezaBaza()
    const t = tm.createTask({ title: 'sim pass', description: 'x', assignee: 'jelena' })
    tm.updateTask(t.id, { status: 'in_progress' })
    const r = tm.updateTask(t.id, { status: 'completed', resultSummary: 'bun test: 24 pass, 0 fail' })
    expect(r?.status).toBe('completed')
    expect(tm.getTask(t.id)?.completedAt).toBeDefined()
  })

  test('drugi smjer iste rupe: agent sam `blocked` → daemonov `completed` je ZABRANJEN prijelaz', () => {
    const tm = svjezaBaza()
    const t = tm.createTask({ title: 'sim blocked', description: 'x', assignee: 'jelena' })
    tm.updateTask(t.id, { status: 'in_progress' })
    tm.updateTask(t.id, { status: 'blocked', blockedReason: 'BLOCKED: nemam pristup' })
    // blocked -> completed NIJE u ValidStatusTransitions
    expect(tm.updateTask(t.id, { status: 'completed', resultSummary: 'ipak sam uspjela' })).toBeNull()
    expect(tm.getTask(t.id)?.status).toBe('blocked')
  })
})
