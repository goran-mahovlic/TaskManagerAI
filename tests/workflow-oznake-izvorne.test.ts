/**
 * TASK-5618 (prijenos TASK-5200 N1 iz glavnog WorkflowGate.ts, nalaz QA TASK-5160): upis oznake
 * tijeka NE smije mijenjati tuđe oznake. Vrata su upisivala `oznakeNorm(postojeće) + oznaka`, a
 * `oznakeNorm` spušta sve u mala slova: `vjestina:Pdf` → `vjestina:pdf` (spawn traži nepostojeći
 * Skill). Uspoređuje se bez obzira na slova, upisuje se ono što je na zadatku stvarno stajalo.
 * Korak lanca koji već nosi `workflow:<id>` ne dobiva i proturječnu `bez-workflowa`.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ODLUKE_VERZIJA,
  BEZ_WORKFLOWA_OZNAKA,
  OZNAKA_PREFIKS,
  oznakaZaOdluku,
  biljeskaZaOdluku,
  mozdaZapisiOdluku,
  type NalogOznake,
} from '../src/core/WorkflowGate'

let dir: string
let cfgPut: string
let katalogPut: string
let logPut: string

const KATALOG_FIXTURE = {
  _meta: { verzija: '1.1.0-test' },
  workflows: {
    'implement-feature': {
      id: 'implement-feature', naziv: 'Izrada značajke', najmanja_tezina: 36,
      okidaci: ['implementiraj', 'nova značajka'],
      koraci: [{ agent: 'arhitekt' }, { agent: 'inzenjer' }],
      enabled: true,
    },
    'bug-fix': {
      id: 'bug-fix', naziv: 'Popravak kvara', najmanja_tezina: 16,
      okidaci: ['ne radi', 'kvar'],
      koraci: [{ agent: 'inzenjer' }],
      enabled: true,
    },
  },
}

function pisiCfg(nacin: string): void {
  writeFileSync(cfgPut, JSON.stringify({ nacin }), 'utf-8')
}

function opcije(dodatno: Record<string, unknown> = {}) {
  return { configPath: cfgPut, katalogPath: katalogPut, logPath: logPut, ...dodatno }
}

function retci(): any[] {
  if (!existsSync(logPut)) return []
  return readFileSync(logPut, 'utf-8').split('\n').filter(Boolean).map(r => JSON.parse(r))
}

/** Hvatač naloga za upis oznake — glumi ploču, bilježi što bi upisala. */
function hvatac(uspjeh = true) {
  const pozivi: NalogOznake[] = []
  return {
    pozivi,
    primijeniOznaku: (n: NalogOznake) => { pozivi.push(n); return uspjeh },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-w1-'))
  cfgPut = join(dir, 'workflow-gate.json')
  katalogPut = join(dir, 'workflows.json')
  logPut = join(dir, 'data', 'workflow_odluke.jsonl')
  writeFileSync(katalogPut, JSON.stringify(KATALOG_FIXTURE), 'utf-8')
  pisiCfg('shadow')
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// ─── 1. Oznaka koja se predlaže ──────────────────────────────────────────────

// ─── TASK-5200 / N1 (QA TASK-5160): upis NE smije mijenjati tuđe oznake ──────
// Vrata su upisivala `noveOznake = oznakeNorm(postojeće) + oznaka`, a `oznakeNorm`
// spušta sve u mala slova: `vjestina:Pdf` → `vjestina:pdf` (spawn traži nepostojeći Skill
// `pdf`), `nalog:NAL-0002` → `nalog:nal-0002`. Uspoređuje se bez obzira na slova, a
// upisuje se ono što je na zadatku stvarno stajalo.

describe('N1 — izvorne oznake ostaju netaknute', () => {
  test('on: vjestina:Pdf i nalog:NAL-0002 zadržavaju velika slova', () => {
    pisiCfg('on')
    const h = hvatac()
    mozdaZapisiOdluku(
      { taskId: 'TASK-N1', naslov: 'Implementiraj izvoz', tezina: 80, oznake: ['vjestina:Pdf', 'nalog:NAL-0002'] },
      opcije({ primijeniOznaku: h.primijeniOznaku }),
    )
    expect(h.pozivi.length).toBe(1)
    expect(h.pozivi[0].noveOznake).toEqual(['vjestina:Pdf', 'nalog:NAL-0002', 'workflow:implement-feature'])
    expect(h.pozivi[0].postojeceOznake).toEqual(['vjestina:Pdf', 'nalog:NAL-0002'])
  })

  test('on: postojeća oznaka drugačijih slova (Workflow:Implement-Feature) se ne duplira', () => {
    pisiCfg('on')
    const h = hvatac()
    mozdaZapisiOdluku(
      { taskId: 'TASK-N1b', naslov: 'Implementiraj izvoz', tezina: 80, oznake: ['Bez-Workflowa'] },
      opcije({ primijeniOznaku: h.primijeniOznaku }),
    )
    expect(h.pozivi.length).toBe(0)
  })

  test('on: korak lanca (u-lancu) s workflow:<id> NE dobiva i bez-workflowa', () => {
    pisiCfg('on')
    const h = hvatac()
    const z = mozdaZapisiOdluku(
      { taskId: 'TASK-N1c', naslov: 'Inženjer: izrada ponude', tezina: 70, assignee: 'inzenjer', blockedBy: ['TASK-1'],
        oznake: ['workflow:implement-feature', 'korak:3/5', 'vjestina:Pdf'] },
      opcije({ primijeniOznaku: h.primijeniOznaku }),
    )
    expect(z?.kod).toBe('u-lancu')
    expect(h.pozivi.length).toBe(0)
    expect(z?.oznakaUpisana).toBe(false)
  })

  test('on: korak lanca BEZ workflow oznake i dalje dobiva bez-workflowa', () => {
    pisiCfg('on')
    const h = hvatac()
    mozdaZapisiOdluku(
      { taskId: 'TASK-N1d', naslov: 'QA: provjera', tezina: 70, assignee: 'qa', blockedBy: ['TASK-1'], oznake: ['QA'] },
      opcije({ primijeniOznaku: h.primijeniOznaku }),
    )
    expect(h.pozivi.length).toBe(1)
    expect(h.pozivi[0].noveOznake).toEqual(['QA', BEZ_WORKFLOWA_OZNAKA])
  })
})
