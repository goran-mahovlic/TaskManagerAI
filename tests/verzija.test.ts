/**
 * TASK-5025 — verzija paketa iz jednog izvora (package.json).
 * Prije: `/api/info` tvrdo '5.0.0', package.json 1.3.0, naslov kartice „(v4.4.0)".
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { paketVerzija, procitajVerziju } from '../src/Verzija'

const KORIJEN = join(import.meta.dir, '..')
const src = readFileSync(join(KORIJEN, 'src', 'TaskWebUI.ts'), 'utf-8')
const pkg = JSON.parse(readFileSync(join(KORIJEN, 'package.json'), 'utf-8'))

describe('Verzija paketa — jedan izvor', () => {
  test('ploča i API vraćaju verziju iz package.json', () => {
    expect(paketVerzija()).toBe(pkg.version)
    expect(src).not.toMatch(/version:\s*'\d+\.\d+\.\d+'/)
    expect(src).toMatch(/version:\s*paketVerzija\(\)/)
  })

  test('TM_VERSION_FILE ima prednost; neispravan sadržaj pada na package.json; bez ičega "?"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmai-verzija-'))
    try {
      const f = join(dir, 'VERSION'); writeFileSync(f, '2.0.1\n')
      const los = join(dir, 'LOS'); writeFileSync(los, 'nije broj')
      const paket = join(dir, 'package.json'); writeFileSync(paket, JSON.stringify({ version: '1.9.9' }))
      expect(procitajVerziju(f, paket)).toBe('2.0.1')
      expect(procitajVerziju(los, paket)).toBe('1.9.9')
      expect(procitajVerziju(undefined, join(dir, 'nema.json'))).toBe('?')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Config stranica ne nosi tvrdo upisanu verziju u naslovima kartica', () => {
    const a = src.indexOf('<div id="tab-info"')
    const b = src.indexOf('<!-- Add Task Button -->', a)
    expect(a).toBeGreaterThan(0)
    expect(src.slice(a, b)).not.toMatch(/v\d+\.\d+\.\d+/)
  })
})
