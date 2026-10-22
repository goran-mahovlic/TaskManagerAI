/**
 * core/Brava.ts — datoteka-brava s PID-om (TASK-5715, nalaz Ž4 pregleda TASK-5712):
 * isključivo stvaranje i oslobađanje samo vlastite brave.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { uzmiBravu } from '../src/core/Brava'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tm-brava-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* nema veze */ } })

describe('Brava', () => {
  test('uzima se s našim PID-om; mrtav vlasnik se preuzima', () => {
    const p = join(dir, 'x.lock')
    writeFileSync(p, '999999999')
    const b = uzmiBravu(p, 'test')
    expect(b.ok).toBe(true)
    expect(readFileSync(p, 'utf-8').trim()).toBe(String(process.pid))
    b.osloboditi!()
    expect(existsSync(p)).toBe(false)
  })

  test('živ vlasnik (roditeljski proces) → odbijeno s PID-om', () => {
    const p = join(dir, 'x.lock')
    writeFileSync(p, String(process.ppid))
    const b = uzmiBravu(p, 'test')
    expect(b.ok).toBe(false)
    expect(b.razlog).toContain(String(process.ppid))
  })

  test('osloboditi ne briše tuđu bravu (preuzeo ju je drugi proces)', () => {
    const p = join(dir, 'x.lock')
    const b = uzmiBravu(p, 'test')
    expect(b.ok).toBe(true)
    writeFileSync(p, String(process.ppid))
    b.osloboditi!()
    expect(readFileSync(p, 'utf-8').trim()).toBe(String(process.ppid))
  })
})
