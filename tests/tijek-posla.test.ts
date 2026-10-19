/**
 * TASK-5159 (T8) — odjeljak „🧭 Tijek posla” u dojavi o završetku (dizajn TASK-5158 §5).
 * Prijenos iz glavnog sustava (TASK-5625): isti slučajevi kao jezgrin TijekPosla.test.ts, bez
 * dijela o pogonskom mjerenju (paketov agent_telemetry.py još ne piše tijek_posla.jsonl, pa
 * koraci bez zapisa pošteno kažu „nije izmjereno”) + spoj u pometnju dojava.
 *
 *   bun test tests/tijek-posla.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sastaviTijek, ucitajZapise, TIJEK_MAX, IZMJENA_REDAK, TIJEK_POSLA_LOG } from '../src/core/TijekPosla'
import { buildReportBackMessage, runReportBackSweep, formatReportBackMarker, REPORT_BACK_TAG, type SweepDeps } from '../src/core/ReportBackTask'
import type { Katalog } from '../src/core/WorkflowGate'

const katalog: Katalog = { workflows: {
  'dorada-isporuke': { id: 'dorada-isporuke', naziv: 'Dorada već isporučenog', koraci: [
    { agent: 'izvorni', uloga: 'dorada' },
    { agent: 'potjeh', uloga: 'qa', vjestina: 'WebappTesting' },
    { agent: 'regoc', uloga: 'isporuka', mehanizam: 'report-back' },
  ] },
} }

const zap = (taskId: string, p: any = {}) => ({ taskId, obvezneVjestine: [], pozvaneVjestine: [], alati: [], izmjereno: true, ...p })

describe('lanac s tijekom', () => {
  const zadaci = [
    { id: 'TASK-5147', title: 'Jelena: DOCX', status: 'completed', assignee: 'jelena', tags: ['workflow:dorada-isporuke', 'korak:1/3', 'vjestina:Docx', 'nalog:NAL-0007'] },
    { id: 'TASK-5149', title: 'Potjeh: QA', status: 'completed', assignee: 'potjeh', tags: ['workflow:dorada-isporuke', 'korak:2/3', 'vjestina:WebappTesting', 'nalog:NAL-0007'] },
  ]
  const zapisi = new Map([
    ['TASK-5147', zap('TASK-5147', { obvezneVjestine: ['Docx'], pozvaneVjestine: ['Docx'], alati: ['md2pdf'] })],
    ['TASK-5149', zap('TASK-5149', { obvezneVjestine: ['WebappTesting'], pozvaneVjestine: [], alati: ['webapp-screenshot'] })],
  ])
  const t = sastaviTijek(zadaci, zapisi, katalog)
  test('pojedinačni korak (nije dojava niza): isporuka čeka', () => {
    const j = sastaviTijek([zadaci[0]], zapisi, katalog, { dojavaNiza: false })
    expect(j).toContain('⏳ (dojava niza kad lanac završi)')
  })

  test('zaglavlje: tijek, naziv i nalog', () => {
    expect(t.split('\n')[0]).toBe('🧭 Tijek posla: dorada-isporuke (Dorada već isporučenog) · nalog NAL-0007')
  })
  test('koraci redom, s agentom, ulogom, statusom, vještinama i alatima', () => {
    expect(t).toContain(' 1. jelena · dorada — ✅ TASK-5147 · vještine: Docx · alati: md2pdf')
    expect(t).toContain(' 2. potjeh · qa — ✅ TASK-5149 · vještine: — · alati: webapp-screenshot')
    expect(t).toContain(' 3. isporuka · report-back — ✅ (ova poruka)')
  })
  test('nepozvana obvezna vještina izrijekom; brojilo obveznih', () => {
    expect(t).toContain('⚠️ obvezna vještina WebappTesting nije pozvana (TASK-5149)')
    expect(t).toContain('obvezne vještine pozvane: 1/2')
  })
  test('redak o izmjeni tijeka i granica duljine', () => {
    expect(t).toContain(IZMJENA_REDAK('dorada-isporuke'))
    expect(t.length).toBeLessThanOrEqual(TIJEK_MAX)
  })
})

describe('bez tijeka i ad-hoc', () => {
  test('jedan zadatak bez tijeka', () => {
    const t = sastaviTijek([{ id: 'TASK-1', status: 'completed', assignee: 'jelena', tags: ['chat:-1'] }],
      new Map([['TASK-1', zap('TASK-1', { pozvaneVjestine: ['TDD'], alati: ['rag-query'] })]]), katalog)
    expect(t).toContain('🧭 Tijek posla: bez tijeka · 1 korak: jelena — vještine: TDD · alati: rag-query')
  })
  test('ručni lanac bez oznaka → ad-hoc', () => {
    const t = sastaviTijek([
      { id: 'TASK-1', status: 'completed', assignee: 'manda', tags: [] },
      { id: 'TASK-2', status: 'completed', assignee: 'jelena', tags: [] },
    ], new Map(), katalog)
    expect(t.split('\n')[0]).toContain('ad-hoc')
    expect(t).toContain('nije izmjereno')
  })
  test('bez zapisa telemetrije: „nije izmjereno”, nikad prazno ni nula', () => {
    const t = sastaviTijek([{ id: 'TASK-1', status: 'completed', assignee: 'jelena', tags: [] }], new Map(), katalog)
    expect(t).toContain('vještine/alati: nije izmjereno')
  })
  test('zapis bez transkripta (izmjereno:false) isto „nije izmjereno”', () => {
    const t = sastaviTijek([{ id: 'TASK-1', status: 'completed', assignee: 'jelena', tags: [] }],
      new Map([['TASK-1', zap('TASK-1', { izmjereno: false, pozvaneVjestine: null, alati: null })]]), katalog)
    expect(t).toContain('nije izmjereno')
  })
  test('oznake kao JSON niz u nizu znakova (red iz baze)', () => {
    const t = sastaviTijek([{ id: 'TASK-1', status: 'completed', assignee: 'jelena', tags: '["workflow:dorada-isporuke","korak:1/3"]' as any }], new Map(), katalog)
    expect(t).toContain('dorada-isporuke')
  })
  test('prazan popis → prazan niz', () => {
    expect(sastaviTijek([], new Map(), katalog)).toBe('')
  })
})

describe('dnevnik tijek_posla.jsonl', () => {
  test('zadnji zapis po zadatku pobjeđuje; pokvaren redak se preskače', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tijek-'))
    const put = join(dir, 'tp.jsonl')
    writeFileSync(put, [
      JSON.stringify(zap('TASK-1', { alati: ['a'] })), '{pokvaren', JSON.stringify(zap('TASK-1', { alati: ['b'] })),
    ].join('\n') + '\n')
    expect(ucitajZapise(put).get('TASK-1')?.alati).toEqual(['b'])
    expect(ucitajZapise(join(dir, 'nema.jsonl')).size).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('spoj u dojavu niza (ReportBackTask)', () => {
  test('odjeljak ide između stavki i podnožja i poruka ostaje u granici', () => {
    process.env.TM_BOARD_URL = 'http://ploca.primjer:17781'
    const tijek = '🧭 Tijek posla: bez tijeka · 1 korak: jelena — vještine: TDD · alati: —'
    const m = buildReportBackMessage({ subject: 'X', tasks: [{ id: 'TASK-1', title: 'a', status: 'completed', resultSummary: 'r'.repeat(5000) }], tijekPosla: tijek, maxLen: 1500 })
    expect(m).toContain(tijek)
    expect(m.indexOf(tijek)).toBeGreaterThan(m.indexOf('TASK-1'))
    expect(m.indexOf(tijek)).toBeLessThan(m.indexOf('Ploča:'))
    expect(m.length).toBeLessThanOrEqual(1500)
  })
  test('bez odjeljka poruka je kao prije', () => {
    const a = buildReportBackMessage({ subject: 'X', tasks: [{ id: 'TASK-1', title: 'a', status: 'completed' }] })
    expect(a).not.toContain('🧭')
  })
})

describe('zapis iz telemetrije', async () => {
  const { zapisIzTelemetrije } = await import('../src/core/TijekPosla')
  test('izmjereno', () => {
    const z = zapisIzTelemetrije('TASK-1', ['vjestina:Pdf', 'x'], { alati: { vjestine: ['Pdf'], katalog_alati: [{ id: 'md2pdf', poziva: 1 }] } })
    expect(z).toEqual({ taskId: 'TASK-1', obvezneVjestine: ['Pdf'], pozvaneVjestine: ['Pdf'], alati: ['md2pdf'], izmjereno: true })
  })
  test('bez mjere → nije izmjereno', () => {
    expect(zapisIzTelemetrije('TASK-1', [], null).izmjereno).toBe(false)
  })
})

// TASK-5200/N2 (QA TASK-5160): upozorenje i u jednorednom putu; usporedba vještina bez
// obzira na slova i s prefiksom plugina (`anthropic-skills:pdf` je Pdf).
describe('N2 — obvezne vještine', () => {
  const kat2: Katalog = { workflows: { 'izrada-dokumenta': { id: 'izrada-dokumenta', naziv: 'Izrada', koraci: [
    { agent: 'manda' }, { agent: 'grga' }, { agent: 'jelena', uloga: 'izrada' }, { agent: 'potjeh' }, { agent: 'regoc', mehanizam: 'report-back' },
  ] } } }
  const oz = (vj: string) => ['workflow:izrada-dokumenta', 'korak:3/5', `vjestina:${vj}`, 'nalog:NAL-0002']
  const z1 = (vj: string, pozv: string[]) => sastaviTijek(
    [{ id: 'TASK-X', assignee: 'jelena', status: 'completed', tags: oz(vj) }],
    new Map([['TASK-X', zap('TASK-X', { obvezneVjestine: [vj], pozvaneVjestine: pozv, alati: ['md2pdf'] })]]), kat2, { dojavaNiza: false })

  test('oznaka vjestina:pdf, pozvan Pdf → pozvano, bez lažnog ⚠️', () => {
    const t = z1('pdf', ['Pdf'])
    expect(t).toContain('obvezne vještine pozvane: 1/1')
    expect(t).not.toContain('⚠️')
  })
  test('pozvan anthropic-skills:pdf vrijedi za vjestina:Pdf', () => {
    const t = z1('Pdf', ['anthropic-skills:pdf'])
    expect(t).toContain('obvezne vještine pozvane: 1/1')
    expect(t).not.toContain('⚠️')
  })
  test('jednoredni put (bez tijeka, 1 zadatak): nepozvana obvezna vještina se javlja', () => {
    const t = sastaviTijek([{ id: 'TASK-Y', assignee: 'jelena', status: 'completed', tags: ['vjestina:Pdf'] }],
      new Map([['TASK-Y', zap('TASK-Y', { obvezneVjestine: ['Pdf'], pozvaneVjestine: [], alati: [] })]]), kat2)
    expect(t.split('\n')[0]).toContain('🧭 Tijek posla: bez tijeka')
    expect(t).toContain('⚠️ obvezna vještina Pdf nije pozvana (TASK-Y)')
  })
  test('jednoredni put, vještina pozvana → ostaje jedan redak', () => {
    const t = sastaviTijek([{ id: 'TASK-Y', assignee: 'jelena', status: 'completed', tags: ['vjestina:Pdf'] }],
      new Map([['TASK-Y', zap('TASK-Y', { obvezneVjestine: ['Pdf'], pozvaneVjestine: ['pdf'], alati: [] })]]), kat2)
    expect(t.split('\n').length).toBe(1)
  })
})

// Paket: dnevnik je u TM_DATA (TM_HOME/data), ne u ~/.claude/regoc.
describe('putanja dnevnika u paketu', () => {
  test('tijek_posla.jsonl je u podatkovnoj mapi paketa', () => {
    expect(TIJEK_POSLA_LOG.endsWith('/data/tijek_posla.jsonl')).toBe(true)
    expect(TIJEK_POSLA_LOG).not.toContain('.claude/regoc')
  })
})

describe('spoj u pometnju dojava (runReportBackSweep)', () => {
  const lanac: any[] = [
    { id: 'TASK-11', title: 'Izrada', status: 'completed', assignee: 'jelena', tags: ['workflow:dorada-isporuke', 'korak:1/3'], resultSummary: 'ok' },
  ]
  const rb: any = { id: 'TASK-12', title: '📣 Dojava: X', status: 'pending', tags: [REPORT_BACK_TAG],
    description: formatReportBackMarker({ chatId: -100123, taskIds: ['TASK-11'] }) }
  const deps = (o: Partial<SweepDeps> = {}) => {
    const poslano: string[] = []
    const d: SweepDeps = {
      listOpenReportBacks: () => [rb], getTask: (id) => lanac.find(t => t.id === id),
      send: (_c, t) => { poslano.push(t); return true }, close: () => {}, alreadySent: () => false, markSent: () => {},
      cfg: { enabled: true, live: true, maxLen: 3500, tijekPosla: true } as any, ...o,
    }
    return { d, poslano }
  }
  test('poslana dojava nosi odjeljak „🧭 Tijek posla” iz sastavljača', () => {
    const { d, poslano } = deps({ tijekPosla: (ts) => '🧭 Tijek posla: probni · ' + ts.map(t => t.id).join(',') } as any)
    runReportBackSweep(d)
    expect(poslano.length).toBe(1)
    expect(poslano[0]).toContain('🧭 Tijek posla: probni · TASK-11')
  })
  test('zadani sastavljač (bez podmetanja) čita oznake workflow:/korak: iz zadatka', () => {
    const { d, poslano } = deps()
    runReportBackSweep(d)
    expect(poslano[0]).toContain('🧭 Tijek posla:')
    expect(poslano[0]).toContain('TASK-11')
  })
  test('config tijekPosla=false → bez odjeljka', () => {
    const { d, poslano } = deps({ cfg: { enabled: true, live: true, maxLen: 3500, tijekPosla: false } as any, tijekPosla: () => '🧭 X' } as any)
    runReportBackSweep(d)
    expect(poslano[0]).not.toContain('🧭')
  })
})
