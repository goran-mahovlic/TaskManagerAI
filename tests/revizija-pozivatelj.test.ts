/**
 * TASK-5618 (prijenos TASK-5210 glavnog, MD f254378 + TaskManagerSQL.updateTask(changedBy)):
 * revizija (`task_history.changed_by`) bilježi POZIVATELJA kad ga ploča zna — čovjeka koji
 * zatvara i svakoga tko ponovno otvara zadatak (completed/cancelled → pending). Ostali prijelazi
 * zadržavaju staro pravilo (izvršitelj). Bez toga se u reviziji ne vidi tko je zatvorio ili
 * ponovno otvorio zadatak.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { TaskManagerSQL } from '../src/core/TaskManagerSQL'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'
import { createEmptyTaskDb } from './helpers/db-fixture'

describe('TaskManagerSQL.updateTask — opts.changedBy', () => {
  let dir = ''
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  test('zadani pozivatelj ide u reviziju; bez njega izvršitelj; bilješku i dalje potpisuje izvršitelj', () => {
    dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-5210-'))
    createEmptyTaskDb(join(dir, 'tasks.db'))
    const tm = new TaskManagerSQL(join(dir, 'tasks.db'))
    const t = tm.createTask({ title: 'revizija pozivatelja', description: 'opis', priority: 3, assignee: 'inzenjer', createdBy: 'test' } as any)
    tm.updateTask(t.id, { status: 'in_progress' })
    tm.updateTask(t.id, { status: 'completed', progressNotes: ['zatvaram'] }, { changedBy: 'covjek' })
    const h = tm.getHistory(t.id).filter(x => x.field === 'status')
    const po = (nova: string) => h.find(x => x.new_value === nova)?.changed_by
    expect(po('in_progress')).toBe('inzenjer')
    expect(po('completed')).toBe('covjek')
    const biljeska = tm.getTask(t.id)!.progressNotes.find(n => n.note === 'zatvaram')
    expect(biljeska?.agent).toBe('inzenjer')
  })
})

describe('PUT /api/tasks/:id — pozivatelj u reviziji (prava ploča paketa)', () => {
  let p: Posluzitelj | null = null
  beforeAll(async () => { p = await podigni({}) }, 20_000)
  afterAll(() => spusti(p))

  const zovi = (put: string, method = 'GET', tijelo?: unknown, zaglavlja: Record<string, string> = {}) =>
    fetch(`${p!.url}${put}`, {
      method, headers: { 'Content-Type': 'application/json', ...zaglavlja },
      ...(tijelo === undefined ? {} : { body: JSON.stringify(tijelo) }),
    })
  const revizija = (id: string) => {
    const db = new Database(join(p!.dom, 'data', 'tasks.db'), { readonly: true })
    try {
      return db.query("SELECT new_value, changed_by FROM task_history WHERE task_id = ? AND field = 'status' ORDER BY id").all(id) as { new_value: string; changed_by: string }[]
    } finally { db.close() }
  }

  test('čovjek zatvara → covjek; ponovno otvaranje bez uloge → api-put, s ulogom orkestrator → orkestrator', async () => {
    const r = await zovi('/api/tasks', 'POST', { title: 'pozivatelj', description: 'opis zadatka za reviziju', priority: 3, assignee: 'inzenjer' })
    const { id } = await r.json() as { id: string }
    expect((await zovi(`/api/tasks/${id}`, 'PUT', { status: 'in_progress' })).status).toBe(200)
    expect((await zovi(`/api/tasks/${id}`, 'PUT',
      { status: 'completed', resultSummary: 'Izmijenjen src/x.ts; bun test → 3 pass, 0 fail.' },
      { 'X-REGOC-Zatvara': 'covjek' })).status).toBe(200)
    expect((await zovi(`/api/tasks/${id}`, 'PUT', { status: 'pending' })).status).toBe(200)
    expect((await zovi(`/api/tasks/${id}`, 'PUT', { status: 'in_progress' })).status).toBe(200)
    expect((await zovi(`/api/tasks/${id}`, 'PUT',
      { status: 'completed', resultSummary: 'Izmijenjen src/x.ts; bun test → 3 pass, 0 fail.' },
      { 'X-REGOC-Zatvara': 'covjek' })).status).toBe(200)
    expect((await zovi(`/api/tasks/${id}`, 'PUT', { status: 'pending' }, { 'X-REGOC-Zatvara': 'orkestrator' })).status).toBe(200)
    expect(revizija(id).map(x => `${x.new_value}:${x.changed_by}`)).toEqual([
      'in_progress:inzenjer', 'completed:covjek', 'pending:api-put',
      'in_progress:inzenjer', 'completed:covjek', 'pending:orkestrator',
    ])
  }, 20_000)

  test('dok spawn radi (živ najam), zaglavlje covjek NE upisuje čovjeka u reviziju (TASK-5334 N1)', async () => {
    const r = await zovi('/api/tasks', 'POST', { title: 'pozivatelj uz najam', description: 'opis zadatka za reviziju', priority: 3, assignee: 'inzenjer' })
    const { id } = await r.json() as { id: string }
    expect((await zovi(`/api/tasks/${id}`, 'PUT', { status: 'in_progress' })).status).toBe(200)
    mkdirSync(p!.najmovi, { recursive: true })
    writeFileSync(join(p!.najmovi, `${id}.json`),
      JSON.stringify({ taskId: id, agent: 'inzenjer', pid: process.pid, startedAt: new Date().toISOString() }))
    expect((await zovi(`/api/tasks/${id}`, 'PUT',
      { status: 'completed', resultSummary: 'Izmijenjen src/x.ts; bun test → 3 pass, 0 fail.' },
      { 'X-REGOC-Zatvara': 'covjek' })).status).toBe(200)
    expect(revizija(id).map(x => `${x.new_value}:${x.changed_by}`)).toEqual(['in_progress:inzenjer', 'completed:inzenjer'])
  }, 20_000)
})
