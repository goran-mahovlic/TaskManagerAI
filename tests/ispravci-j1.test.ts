/**
 * J1 (GAP 24.09.2026. §5): tri ispravka prenesena iz žive instalacije.
 *
 *   F2  — ID projekta nikad ne zaostaje za tablicom (TASK-4740)
 *   F3  — ponovno otvaranje: completed/cancelled → pending (pending → completed ostaje zabranjen)
 *   F15 — konzolni unos u vlastitom <form> da ga upravitelj lozinkama ne čita (TASK-4722)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { ProjectManager } from '../src/core/ProjectManager'
import { TaskManagerSQL } from '../src/core/TaskManagerSQL'

const SHEMA = new URL('../db/schema.sql', import.meta.url).pathname

let dir = ''
let dbPath = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tm-j1-'))
  dbPath = join(dir, 't.db')
  const db = new Database(dbPath)
  db.exec(readFileSync(SHEMA, 'utf-8'))
  db.close()
})
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })

describe('F2 — ID projekta iza tablice (TASK-4740)', () => {
  test('sekvenca koja zaostaje ne daje zauzet ID', () => {
    const db = new Database(dbPath)
    // Projekt upisan MIMO generatora (uvoz/migracija), sekvenca ga ne vidi.
    db.exec(`INSERT INTO projects (id, name) VALUES ('PRJ-009', 'uvezen')`)
    db.close()
    const pm = new ProjectManager(dbPath)
    const p = pm.createProject({ name: 'novi' } as any)
    expect(p.id).toBe('PRJ-010')
    const q = pm.createProject({ name: 'jos jedan' } as any)
    expect(q.id).toBe('PRJ-011')
  })

  test('prazna baza i dalje počinje od PRJ-001', () => {
    const pm = new ProjectManager(dbPath)
    expect(pm.createProject({ name: 'prvi' } as any).id).toBe('PRJ-001')
  })
})

describe('F3 — ponovno otvaranje zadatka', () => {
  const zatvori = (tm: TaskManagerSQL, id: string, kraj: 'completed' | 'cancelled') => {
    if (kraj === 'completed') tm.updateTask(id, { status: 'in_progress' } as any)
    return tm.updateTask(id, { status: kraj } as any)
  }

  test('completed → pending je dopušten', () => {
    const tm = new TaskManagerSQL(dbPath)
    const t = tm.createTask({ title: 'a', description: 'b' } as any)
    expect(zatvori(tm, t.id, 'completed')?.status).toBe('completed')
    expect(tm.updateTask(t.id, { status: 'pending' } as any)?.status).toBe('pending')
  })

  test('cancelled → pending je dopušten', () => {
    const tm = new TaskManagerSQL(dbPath)
    const t = tm.createTask({ title: 'a', description: 'b' } as any)
    expect(zatvori(tm, t.id, 'cancelled')?.status).toBe('cancelled')
    expect(tm.updateTask(t.id, { status: 'pending' } as any)?.status).toBe('pending')
  })

  test('pending → completed ostaje zabranjen', () => {
    const tm = new TaskManagerSQL(dbPath)
    const t = tm.createTask({ title: 'a', description: 'b' } as any)
    expect(tm.updateTask(t.id, { status: 'completed' } as any)).toBeNull()
    expect(tm.getAllowedTransitions('pending')).not.toContain('completed')
  })

  test('completed ne smije ravno u in_progress (ponovno otvaranje ide kroz pending)', () => {
    const tm = new TaskManagerSQL(dbPath)
    expect(tm.getAllowedTransitions('completed')).toEqual(['pending'])
    expect(tm.getAllowedTransitions('cancelled')).toEqual(['pending'])
  })
})

describe('F15 — konzola ne nudi spremanje lozinke (TASK-4722)', () => {
  const izvor = readFileSync(new URL('../src/TaskWebUI.ts', import.meta.url).pathname, 'utf-8')

  test('konzolni unos ima vlastiti <form>, ne dijeli sintetski obrazac s poljima lozinke', () => {
    const i = izvor.indexOf('id="konzola-input"')
    expect(i).toBeGreaterThan(-1)
    const prije = izvor.slice(Math.max(0, i - 600), i)
    expect(prije).toMatch(/<form class="konzola-input-wrapper"[^>]*autocomplete="off"[^>]*onsubmit="return false;"/)
  })

  test('Enter u konzoli ne šalje obrazac', () => {
    const i = izvor.indexOf('function initKonzolaInput()')
    const tijelo = izvor.slice(i, i + 500)
    expect(tijelo).toContain('e.preventDefault()')
  })
})
