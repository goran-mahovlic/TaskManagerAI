/**
 * TASK-5311 (prijenos s glavnog, TASK-5164 §4.2/§4.3): dorada i ponovno otvaranje u bazi.
 *  - `createDorada` — NOVI zadatak u jednoj transakciji; izvorni ostaje `completed`, dobiva
 *    bilješku s ID-em dorade i oznaku `ima-doradu`.
 *  - `reopenTask` — samo `completed`/`cancelled` → `pending`, briše `completed_at`, u reviziji je
 *    PRAVI pozivatelj.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskManagerSQL } from '../src/core/TaskManagerSQL'
import { createEmptyTaskDb } from './helpers/db-fixture'

let dir = ''
let tm: TaskManagerSQL
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tm-dorada-'))
  createEmptyTaskDb(join(dir, 'tasks.db'))
  tm = new TaskManagerSQL(join(dir, 'tasks.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const zatvoren = () => {
  const t = tm.createTask({ title: 'Isporuka', description: 'opis', createdBy: 'test', assignee: 'inzenjer' } as any)
  tm.updateTask(t.id, { status: 'in_progress' } as any)
  tm.updateTask(t.id, { status: 'completed', result: 'gotovo' } as any)
  expect(tm.getTask(t.id)!.status).toBe('completed')
  return tm.getTask(t.id)!
}

describe('createDorada', () => {
  test('novi zadatak + bilješka s ID-em dorade + ima-doradu; izvorni ostaje completed', () => {
    const iz = zatvoren()
    const d = tm.createDorada(iz.id, { title: 'Dorada: Isporuka', description: 'x', createdBy: 'revizor' } as any,
      '🔁 Dorada otvorena: <DORADA> — fali test', 'revizor')!
    expect(d.id).not.toBe(iz.id)
    expect(d.status).toBe('pending')
    const poslije = tm.getTask(iz.id)!
    expect(poslije.status).toBe('completed')
    expect(poslije.tags).toContain('ima-doradu')
    expect(poslije.progressNotes.at(-1)!.note).toBe(`🔁 Dorada otvorena: ${d.id} — fali test`)
    expect(tm.getHistory(iz.id).some(h => h.field === 'dorada' && h.new_value === d.id && h.changed_by === 'revizor')).toBe(true)
  })

  test('nepostojeći izvorni → null i ništa ne nastaje', () => {
    const prije = tm.getTasks().length
    expect(tm.createDorada('TASK-999', { title: 'x', createdBy: 'a' } as any, 'b', 'a')).toBeNull()
    expect(tm.getTasks().length).toBe(prije)
  })
})

describe('reopenTask', () => {
  test('completed → pending, completed_at obrisan, revizija nosi pozivatelja', () => {
    const iz = zatvoren()
    const t = tm.reopenTask(iz.id, 'zatvoren greškom', 'vlasnik')!
    expect(t.status).toBe('pending')
    expect(t.completedAt ?? null).toBeNull()
    const h = tm.getHistory(iz.id)
    expect(h.some(x => x.field === 'status' && x.new_value === 'pending' && x.changed_by === 'vlasnik')).toBe(true)
    expect(h.some(x => x.field === 'ponovno_otvoreno' && x.new_value === 'zatvoren greškom')).toBe(true)
  })

  test('zadatak koji nije zatvoren → null', () => {
    const t = tm.createTask({ title: 'u radu', createdBy: 'test' } as any)
    expect(tm.reopenTask(t.id, 'r', 'b')).toBeNull()
    expect(tm.reopenTask('TASK-999', 'r', 'b')).toBeNull()
  })
})
