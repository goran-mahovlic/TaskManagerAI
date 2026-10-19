/**
 * TASK-5625 (prijenos TASK-5029 c441556 iz glavnog): kartica zadatka koji čeka slobodno mjesto
 * (strop usporednih agenata) nosi značku „ČEKA MJESTO”. Oznaku `ceka-mjesto` postavlja
 * orkestrator (SpawnQueue.oznakeNakonPokusaja, v. tests/orchestrator.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const ui = readFileSync(new URL('../src/TaskWebUI.ts', import.meta.url).pathname, 'utf-8')
const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url).pathname, 'utf-8'))
const hr = JSON.parse(readFileSync(new URL('../locales/hr.json', import.meta.url).pathname, 'utf-8'))

describe('značka ČEKA MJESTO na kartici', () => {
  test('pending + oznaka ceka-mjesto → značka', () => {
    expect(ui).toContain("task.status === 'pending' && (task.tags || []).includes('ceka-mjesto')")
    expect(ui).toContain('<span class="ceka-mjesto-badge"')
    expect(ui).toMatch(/\.ceka-mjesto-badge \{[^}]*background/)
  })
  test('tekst značke postoji u oba rječnika', () => {
    for (const k of ['tsk_ceka_mjesto', 'tsk_ceka_mjesto_naslov']) {
      expect(typeof en[k]).toBe('string')
      expect(typeof hr[k]).toBe('string')
    }
    expect(hr.tsk_ceka_mjesto).toBe('ČEKA MJESTO')
  })
})
