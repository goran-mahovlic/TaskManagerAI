/**
 * J8 (GAP_20260924 F14): model-config.json se mijenja atomno i uz revizijski trag.
 * Kvar koji zatvara: gol writeFileSync preko žive datoteke — prekid usred upisa ostavi
 * krnji JSON, a čitatelj ga tiho proguta i vrati SVE agente na zadani model.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { saveModelConfig, AUDIT_FILE_NAME } from '../src/core/models/ModelConfigWriter'

let dir = ''
let path = ''
const POCETNO = { defaults: { model: 'anthropic:sonnet' }, agentOverrides: { a: 'anthropic:opus' } }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcw-'))
  path = join(dir, 'model-config.json')
  writeFileSync(path, JSON.stringify(POCETNO, null, 2) + '\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('saveModelConfig', () => {
  test('promjena se upisuje, a trag bilježi tko/prije/poslije', () => {
    const p = saveModelConfig(path, (mc) => { mc.agentOverrides.a = 'anthropic:claude-opus-4-6[1m]' }, 'ploca')
    expect(p).toEqual([{ kljuc: 'agentOverrides.a', prije: 'anthropic:opus', poslije: 'anthropic:claude-opus-4-6[1m]' }])
    expect(JSON.parse(readFileSync(path, 'utf-8')).agentOverrides.a).toBe('anthropic:claude-opus-4-6[1m]')
    const trag = readFileSync(join(dir, AUDIT_FILE_NAME), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(trag.length).toBe(1)
    expect(trag[0].tko).toBe('ploca')
  })

  test('prekid usred izmjene (mutiraj baci) → datoteka bajt-identična, nema traga ni tmp datoteke', () => {
    const prije = readFileSync(path, 'utf-8')
    expect(() => saveModelConfig(path, (mc) => { mc.agentOverrides.a = 'x'; throw new Error('pad') }, 'ploca')).toThrow('pad')
    expect(readFileSync(path, 'utf-8')).toBe(prije)
    expect(existsSync(join(dir, AUDIT_FILE_NAME))).toBe(false)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  test('neuspio upis privremene datoteke → živa datoteka ostaje cijela i čitljiva', () => {
    // Mapa bez prava pisanja: writeFileSync(tmp) pada PRIJE rename — stara datoteka ostaje.
    const zak = join(dir, 'zakljucano')
    mkdirSync(zak)
    const p2 = join(zak, 'model-config.json')
    writeFileSync(p2, JSON.stringify(POCETNO))
    chmodSync(zak, 0o500)
    try {
      if (process.getuid && process.getuid() === 0) return // root piše svugdje — test nema smisla
      expect(() => saveModelConfig(p2, (mc) => { mc.defaults.model = 'y' }, 'ploca')).toThrow()
      expect(JSON.parse(readFileSync(p2, 'utf-8'))).toEqual(POCETNO)
    } finally {
      chmodSync(zak, 0o700)
    }
  })

  test('bez stvarne promjene nema retka u tragu', () => {
    const p = saveModelConfig(path, (mc) => { mc.defaults.model = 'anthropic:sonnet' }, 'ploca')
    expect(p).toEqual([])
    expect(existsSync(join(dir, AUDIT_FILE_NAME))).toBe(false)
  })

  test('ploča nudi [1m] oznake i više nema golog writeFileSync nad model-config.json', () => {
    const ploca = readFileSync(join(import.meta.dir, '..', 'src', 'TaskWebUI.ts'), 'utf-8')
    expect(ploca).toContain("spec: 'anthropic:claude-opus-4-6[1m]'")
    expect(ploca).not.toMatch(/writeFileSync\(mcPath/)
    expect(ploca).not.toMatch(/_wfs\(mcPath/)
  })
})
