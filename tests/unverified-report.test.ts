/**
 * UnverifiedReport — testovi (T10 / TASK-3575)
 *
 * Regresija koju čuvaju: 01.09.2026. je u data/critic_gate.jsonl stajalo pass 49, fail 4,
 * unverifiable 53 — polovica prolaza kroz vrata nije provjerila NIŠTA, a nijedna dojava
 * nije poslana (`decideNextAction` je sve što nije `fail` vraćao kao običan `accept`).
 *
 * Testovi drže četiri stvari:
 *   1) `unverifiable`/`partial` i dalje NE BLOKIRAJU (rad prolazi), ali se PRIJAVLJUJU,
 *   2) dojava imenuje ŠTO je nedostajalo, nikad samo riječ „unverifiable",
 *   3) buka je ograničena: jedna dojava po zadatku dnevno + dnevni sažetak preko praga,
 *      a prag dolazi IZ KONFIGURACIJE (test to dokazuje podmetnutom datotekom),
 *   4) „danas" je lokalni dan, ne UTC dan (kontejner radi u UTC-u).
 *
 * Sve datoteke idu u ~/.tmp (/tmp je 100 MB tmpfs + noexec).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DEFAULT_UNVERIFIED_CONFIG,
  loadUnverifiedConfig,
  localDay,
  localHour,
  explainUnverified,
  emptyUnverifiedState,
  readUnverifiedState,
  writeUnverifiedState,
  unverifiedStatePath,
  stateWriteAllowed,
  unverifiedStatePath,
  reportableStatus,
  decideUnverifiedAlert,
  summaryDue,
  afterSummary,
  formatUnverifiedAlert,
  formatUnverifiedSummary,
  unverifiedBoardState,
  summaryRows,
  lastRoundPerTask,
  readLedgerAll,
  type UnverifiedConfig,
  type UnverifiedState,
} from '../src/core/UnverifiedReport'
import {
  DEFAULT_CRITIC_CONFIG,
  judge,
  critiqueSpawn,
  readLedger,
  type CriticConfig,
  type CheckResult,
  type ScanResult,
  type ChangedFile,
  type LedgerRound,
} from '../src/core/CriticGate'

let TMP = ''

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'unverified-test-'))
})
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }) } catch {} })

function ucfg(over: Partial<UnverifiedConfig> = {}): UnverifiedConfig {
  return { ...DEFAULT_UNVERIFIED_CONFIG, ...over }
}
function ccfg(over: Partial<CriticConfig> = {}): CriticConfig {
  return { ...DEFAULT_CRITIC_CONFIG, ...over }
}
function scan(over: Partial<ScanResult> = {}): ScanResult {
  return { files: [], truncated: 0, missingRoots: [], ...over }
}
function file(path: string): ChangedFile {
  return { path, mtimeMs: 1, sizeBytes: 1 }
}
function result(over: Partial<CheckResult> = {}): CheckResult {
  return {
    kind: 'parse', target: '/x/A.ts', cmd: ['bun', 'build', '/x/A.ts'], cwd: '/x',
    ok: true, exitCode: 0, ms: 5, timedOut: false, skipped: false, errorLine: '', ...over,
  }
}
/** Datoteka s eksplicitnim vremenom izmjene — mtime je ovdje ulaz, ne slučajnost. */
function writeAt(path: string, content: string, mtimeMs: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  const s = mtimeMs / 1000
  utimesSync(path, s, s)
  return path
}

// ─── Konfiguracija: prag je U DATOTECI, ne u kodu ────────────────────────────

describe('loadUnverifiedConfig', () => {
  test('nepostojeća datoteka → defaulti', () => {
    expect(loadUnverifiedConfig(join(TMP, 'nema.json'), true)).toEqual(DEFAULT_UNVERIFIED_CONFIG)
  })

  test('neispravan JSON ne ruši poziv → defaulti', () => {
    const p = join(TMP, 'lose.json')
    writeFileSync(p, '{ ovo nije json')
    expect(loadUnverifiedConfig(p, true)).toEqual(DEFAULT_UNVERIFIED_CONFIG)
  })

  test('prag dolazi IZ KONFIGURACIJE (zahtjev: ne smije biti u kodu)', () => {
    const p = join(TMP, 'prag.json')
    writeFileSync(p, JSON.stringify({ dailyAlertThreshold: 11, summaryHour: 7, includePartial: false }))
    const c = loadUnverifiedConfig(p, true)
    expect(c.dailyAlertThreshold).toBe(11)
    expect(c.summaryHour).toBe(7)
    expect(c.includePartial).toBe(false)
    // Nedirnuta polja ostaju na defaultu.
    expect(c.timeZone).toBe(DEFAULT_UNVERIFIED_CONFIG.timeZone)
  })

  test('besmislene vrijednosti se ne primaju tiho', () => {
    const p = join(TMP, 'besmislen.json')
    writeFileSync(p, JSON.stringify({ dailyAlertThreshold: -5, summaryHour: 99, maxReasons: 0 }))
    const c = loadUnverifiedConfig(p, true)
    expect(c.dailyAlertThreshold).toBe(DEFAULT_UNVERIFIED_CONFIG.dailyAlertThreshold)
    expect(c.summaryHour).toBe(DEFAULT_UNVERIFIED_CONFIG.summaryHour)
    expect(c.maxReasons).toBe(DEFAULT_UNVERIFIED_CONFIG.maxReasons)
  })

  test('krivi tip se ignorira (string umjesto broja)', () => {
    const p = join(TMP, 'tip.json')
    writeFileSync(p, JSON.stringify({ dailyAlertThreshold: 'pet' }))
    expect(loadUnverifiedConfig(p, true).dailyAlertThreshold).toBe(DEFAULT_UNVERIFIED_CONFIG.dailyAlertThreshold)
  })
})

// ─── Vrijeme: „danas" je lokalni dan ─────────────────────────────────────────

describe('localDay / localHour', () => {
  test('23:30 UTC je u Zagrebu VEĆ sljedeći dan', () => {
    const ms = Date.parse('2026-09-01T23:30:00Z')
    expect(localDay(ms, 'Europe/Zagreb')).toBe('2026-09-02')
    expect(localDay(ms, 'UTC')).toBe('2026-09-01')
  })

  test('sat se čita u traženoj zoni', () => {
    const ms = Date.parse('2026-09-01T18:10:00Z')   // 20:10 po Zagrebu (ljetno vrijeme)
    expect(localHour(ms, 'Europe/Zagreb')).toBe(20)
    expect(localHour(ms, 'UTC')).toBe(18)
  })

  test('nepostojeća zona ne ruši poziv (pada na UTC)', () => {
    const ms = Date.parse('2026-09-01T23:30:00Z')
    expect(localDay(ms, 'Ovo/NijeZona')).toBe('2026-09-01')
  })
})

// ─── RAZLOG: nabroji ŠTO je nedostajalo ──────────────────────────────────────

describe('explainUnverified', () => {
  test('nema izmijenjenih datoteka → imenuje stabla i to da nema git polazišta', () => {
    const v = judge([], scan(), [])
    const r = explainUnverified(v, ccfg({ watchRoots: ['/nema/stabla'] }), { exists: () => false })
    expect(v.status).toBe('unverifiable')
    expect(r.join('\n')).toContain('/nema/stabla')
    expect(r.some((x) => x.includes('nije git repozitorij'))).toBe(true)
  })

  test('git repozitorij se NE prijavljuje kao razlog kad postoji', () => {
    const v = judge([], scan(), [])
    const r = explainUnverified(v, ccfg({ watchRoots: ['/ima/repo'] }), { exists: () => true })
    expect(r.some((x) => x.includes('nije git repozitorij'))).toBe(false)
  })

  test('ima izmjena, ali nijedna nije kod ni test', () => {
    const v = judge([], scan({ files: [file('/x/BILJESKA.md'), file('/x/slika.png')] }), [])
    const r = explainUnverified(v, ccfg(), { exists: () => true })
    expect(r.some((x) => x.includes('nije kod ni test'))).toBe(true)
    expect(r.some((x) => x.includes('2 izmijenjenih'))).toBe(true)
  })

  test('propisana provjera koja se nije mogla izvesti IMENUJE naredbu i razlog', () => {
    const v = judge([], scan(), [], [{ raw: 'bash -c ls', reason: 'izvršna datoteka nije na popisu dopuštenih' }])
    const r = explainUnverified(v, ccfg(), { exists: () => true })
    expect(r[0]).toContain('bash -c ls')
    expect(r[0]).toContain('nije na popisu dopuštenih')
  })

  test('bez ključa [PROVJERA] se to izričito kaže', () => {
    const v = judge([], scan(), [])
    const r = explainUnverified(v, ccfg(), { exists: () => true })
    expect(r.some((x) => x.includes('[PROVJERA] cmd:'))).toBe(true)
  })

  test('ima raščlambe, ali nema testa → to je zaseban razlog', () => {
    const v = judge([result({ kind: 'parse' })], scan({ files: [file('/x/A.ts')] }), [])
    const r = explainUnverified(v, ccfg(), { exists: () => true })
    expect(r.some((x) => x.includes('nema pripadnog testa'))).toBe(true)
  })

  test('partial: preskočene provjere se broje i imenuju rokom', () => {
    const v = judge([result({ skipped: true, ok: false }), result({ kind: 'test', ok: true })], scan({ files: [file('/x/A.ts')] }), [])
    expect(v.status).toBe('partial')
    const r = explainUnverified(v, ccfg({ totalBudgetMs: 90_000 }), { exists: () => true })
    expect(r.some((x) => x.includes('90000 ms'))).toBe(true)
  })

  test('strop datoteka i nepostojeći korijen se NIKAD ne prešućuju', () => {
    const v = judge([], scan({ truncated: 7, missingRoots: ['/nema'] }), [])
    const r = explainUnverified(v, ccfg({ maxFiles: 40 }), { exists: () => true })
    expect(r.some((x) => x.includes('7 izmijenjenih uopće nije ušlo'))).toBe(true)
    expect(r.some((x) => x.includes('/nema'))).toBe(true)
  })

  test('nikad ne vraća prazan popis (dojava bez razloga je šum)', () => {
    const v = judge([result({ kind: 'test' }), result({ kind: 'parse' })], scan({ files: [file('/x/A.ts')] }), [])
    expect(explainUnverified(v, ccfg(), { exists: () => true }).length).toBeGreaterThan(0)
  })

  test('ispitivanje putanje koje baca ne ruši dojavu', () => {
    const v = judge([], scan(), [])
    const r = explainUnverified(v, ccfg({ watchRoots: ['/x'] }), { exists: () => { throw new Error('EACCES') } })
    expect(r.length).toBeGreaterThan(0)
  })
})

// ─── Koji sud uopće ide u dojavu ─────────────────────────────────────────────

describe('reportableStatus', () => {
  test('pass i fail ne idu ovim putem (fail ima svoj, blokirajući)', () => {
    expect(reportableStatus('pass', ucfg())).toBe(false)
    expect(reportableStatus('fail', ucfg())).toBe(false)
  })
  test('unverifiable uvijek ide', () => {
    expect(reportableStatus('unverifiable', ucfg())).toBe(true)
  })
  test('partial ovisi o konfiguraciji', () => {
    expect(reportableStatus('partial', ucfg({ includePartial: true }))).toBe(true)
    expect(reportableStatus('partial', ucfg({ includePartial: false }))).toBe(false)
  })
})

// ─── Odluka o dojavi: prag, duplikat, prevrtanje dana ────────────────────────

describe('decideUnverifiedAlert', () => {
  const now = Date.parse('2026-09-01T10:00:00Z')      // 12:00 po Zagrebu
  const day = localDay(now, 'Europe/Zagreb')

  test('prve dojave do praga idu pojedinačno, prva preko praga ide u sažetak', () => {
    const cfg = ucfg({ dailyAlertThreshold: 2 })
    let st = emptyUnverifiedState(day)
    const d1 = decideUnverifiedAlert(st, { taskId: 'TASK-1', status: 'unverifiable', nowMs: now }, cfg)
    expect(d1.action).toBe('alert')
    const d2 = decideUnverifiedAlert(d1.state, { taskId: 'TASK-2', status: 'unverifiable', nowMs: now }, cfg)
    expect(d2.action).toBe('alert')
    const d3 = decideUnverifiedAlert(d2.state, { taskId: 'TASK-3', status: 'unverifiable', nowMs: now }, cfg)
    expect(d3.action).toBe('defer')
    expect(d3.state.deferred).toEqual(['TASK-3'])
    expect(d3.reason).toContain('2')
  })

  test('isti zadatak drugi put istog dana → tišina (dojava po zadatku, ne po krugu)', () => {
    const cfg = ucfg({ dailyAlertThreshold: 5 })
    const d1 = decideUnverifiedAlert(emptyUnverifiedState(day), { taskId: 'TASK-1', status: 'unverifiable', nowMs: now }, cfg)
    const d2 = decideUnverifiedAlert(d1.state, { taskId: 'TASK-1', status: 'unverifiable', nowMs: now }, cfg)
    expect(d2.action).toBe('skip-duplicate')
    expect(d2.state.alerted).toEqual(['TASK-1'])
  })

  test('odgođen zadatak se ne javlja ni pojedinačno (nema dvostruke prijave)', () => {
    const cfg = ucfg({ dailyAlertThreshold: 0 })
    const d1 = decideUnverifiedAlert(emptyUnverifiedState(day), { taskId: 'TASK-9', status: 'unverifiable', nowMs: now }, cfg)
    expect(d1.action).toBe('defer')
    const d2 = decideUnverifiedAlert(d1.state, { taskId: 'TASK-9', status: 'partial', nowMs: now }, cfg)
    expect(d2.action).toBe('skip-duplicate')
  })

  test('novi dan resetira brojač (jučerašnje dojave ne šute danas)', () => {
    const cfg = ucfg({ dailyAlertThreshold: 1 })
    const jucer: UnverifiedState = { day: '2026-08-31', alerted: ['TASK-1', 'TASK-2'], deferred: [], summarySentAt: null }
    const d = decideUnverifiedAlert(jucer, { taskId: 'TASK-3', status: 'unverifiable', nowMs: now }, cfg)
    expect(d.action).toBe('alert')
    expect(d.state.day).toBe(day)
    expect(d.state.alerted).toEqual(['TASK-3'])
  })

  test('pass i fail se ovdje ne diraju', () => {
    const cfg = ucfg()
    expect(decideUnverifiedAlert(emptyUnverifiedState(day), { taskId: 'T', status: 'pass', nowMs: now }, cfg).action).toBe('ignore')
    expect(decideUnverifiedAlert(emptyUnverifiedState(day), { taskId: 'T', status: 'fail', nowMs: now }, cfg).action).toBe('ignore')
  })

  test('partial isključen konfiguracijom → ignore', () => {
    const cfg = ucfg({ includePartial: false })
    expect(decideUnverifiedAlert(emptyUnverifiedState(day), { taskId: 'T', status: 'partial', nowMs: now }, cfg).action).toBe('ignore')
  })
})

// ─── Dnevni sažetak ──────────────────────────────────────────────────────────

describe('summaryDue / afterSummary', () => {
  const cfg = ucfg({ summaryHour: 20, dailyAlertThreshold: 2 })
  const day = '2026-09-01'
  const podne = Date.parse('2026-09-01T10:00:00Z')     // 12:00 Zagreb
  const navecer = Date.parse('2026-09-01T18:10:00Z')   // 20:10 Zagreb
  const sutra = Date.parse('2026-09-02T08:00:00Z')

  test('bez odgođenih zadataka sažetak nije na redu', () => {
    expect(summaryDue({ day, alerted: ['A'], deferred: [], summarySentAt: null }, navecer, cfg).due).toBe(false)
  })

  test('prije dogovorenog sata se šuti', () => {
    expect(summaryDue({ day, alerted: [], deferred: ['A'], summarySentAt: null }, podne, cfg).due).toBe(false)
  })

  test('u dogovoreni sat sažetak ide', () => {
    const d = summaryDue({ day, alerted: [], deferred: ['A', 'B'], summarySentAt: null }, navecer, cfg)
    expect(d.due).toBe(true)
    expect(d.taskIds).toEqual(['A', 'B'])
    expect(d.day).toBe(day)
  })

  test('drugi sažetak istog dana NE ide', () => {
    const st: UnverifiedState = { day, alerted: [], deferred: ['A'], summarySentAt: '2026-09-01T18:11:00Z' }
    expect(summaryDue(st, navecer, cfg).due).toBe(false)
  })

  test('prevrtanje dana šalje sažetak za JUČER (odgođeni se ne gube)', () => {
    const d = summaryDue({ day, alerted: [], deferred: ['A'], summarySentAt: '2026-09-01T18:11:00Z' }, sutra, cfg)
    expect(d.due).toBe(true)
    expect(d.day).toBe(day)
    expect(d.reason).toContain('2026-09-02')
  })

  test('nakon sažetka odgođeni se brišu, a prevrtanje dana daje čisto stanje', () => {
    const isti = afterSummary({ day, alerted: ['A'], deferred: ['B'], summarySentAt: null }, navecer, cfg)
    expect(isti.deferred).toEqual([])
    expect(isti.alerted).toEqual(['A'])
    expect(isti.summarySentAt).not.toBeNull()

    const novi = afterSummary({ day, alerted: ['A'], deferred: ['B'], summarySentAt: null }, sutra, cfg)
    expect(novi).toEqual(emptyUnverifiedState('2026-09-02'))
  })

  test('nakon sažetka isti dan sljedeći odgođeni opet dolazi na red tek prevrtanjem dana', () => {
    const st = afterSummary({ day, alerted: [], deferred: ['B'], summarySentAt: null }, navecer, cfg)
    const d = decideUnverifiedAlert(st, { taskId: 'C', status: 'unverifiable', nowMs: navecer }, ucfg({ dailyAlertThreshold: 0 }))
    expect(d.action).toBe('defer')
    expect(summaryDue(d.state, navecer, cfg).due).toBe(false)
    expect(summaryDue(d.state, sutra, cfg).due).toBe(true)
  })
})

// ─── Stanje na disku (preživljava restart daemona) ───────────────────────────

describe('stanje dojava', () => {
  test('zapis i čitanje', () => {
    const p = join(TMP, 'stanje.json')
    const st: UnverifiedState = { day: '2026-09-01', alerted: ['A'], deferred: ['B'], summarySentAt: null }
    expect(writeUnverifiedState(st, p)).toBe(true)
    expect(readUnverifiedState(p)).toEqual(st)
  })

  test('pokvarena datoteka → čisto današnje stanje, bez iznimke', () => {
    const p = join(TMP, 'pokvareno.json')
    writeFileSync(p, 'nije json')
    const now = Date.parse('2026-09-01T10:00:00Z')
    expect(readUnverifiedState(p, now, 'Europe/Zagreb')).toEqual(emptyUnverifiedState('2026-09-01'))
  })

  test('nepostojeća datoteka → čisto stanje', () => {
    const now = Date.parse('2026-09-01T10:00:00Z')
    expect(readUnverifiedState(join(TMP, 'nema-me.json'), now, 'UTC').alerted).toEqual([])
  })

  test('test-proces NE SMIJE pisati u živo stanje dojava', () => {
    // Kvar koji je ovo zatvorio (01.09.2026.): kraj-do-kraja harness `mode-classify-e2e`
    // pokreće PRAVI `processMessage` i upisao je u živo stanje „javljeno: TASK-TEST-2559".
    // Prva bi prava dojava tog dana bila prešućena kao duplikat.
    const zivo = unverifiedStatePath()
    // Mjeri se DIRA LI test datoteku, ne postoji li ona. Daemon u pogonu ondje legitimno
    // piše (prva prava dojava dana), pa je `existsSync(zivo) === false` bio uvjet o
    // stroju, a ne o kodu: zelen na svježem stroju, crven čim je dojava ikad poslana.
    const prije = existsSync(zivo) ? readFileSync(zivo, 'utf-8') : null
    expect(stateWriteAllowed(zivo)).toBe(false)
    expect(writeUnverifiedState(emptyUnverifiedState('2026-09-01'), zivo)).toBe(false)
    const poslije = existsSync(zivo) ? readFileSync(zivo, 'utf-8') : null
    expect(poslije).toBe(prije)
  })

  test('izolirano stanje se smije pisati i pod testom', () => {
    const p = join(TMP, 'izolirano.json')
    expect(stateWriteAllowed(p)).toBe(true)
    expect(writeUnverifiedState(emptyUnverifiedState('2026-09-01'), p)).toBe(true)
  })

  test('REGOC_UNVERIFIED_STATE je izlaz za nuždu (alat/test ne diraju živo)', () => {
    const prev = process.env.REGOC_UNVERIFIED_STATE
    const p = join(TMP, 'override.json')
    process.env.REGOC_UNVERIFIED_STATE = p
    try { expect(unverifiedStatePath()).toBe(p) }
    finally {
      if (prev === undefined) delete process.env.REGOC_UNVERIFIED_STATE
      else process.env.REGOC_UNVERIFIED_STATE = prev
    }
  })

  test('smeće u poljima se ne propušta dalje', () => {
    const p = join(TMP, 'smece.json')
    writeFileSync(p, JSON.stringify({ day: '2026-09-01', alerted: ['A', 7, null], deferred: 'ne-polje', summarySentAt: 3 }))
    const st = readUnverifiedState(p)
    expect(st.alerted).toEqual(['A'])
    expect(st.deferred).toEqual([])
    expect(st.summarySentAt).toBeNull()
  })
})

// ─── Tekstovi ────────────────────────────────────────────────────────────────

describe('formatUnverifiedAlert', () => {
  const base = {
    taskId: 'TASK-3571', agentId: 'malik', status: 'unverifiable' as const,
    costUsd: 6.57, durationS: 1328,
    reasons: ['nijedna izmijenjena datoteka nije nađena', 'nema ključa [PROVJERA]'],
  }

  test('nosi zadatak, agenta, trošak, trajanje i razloge', () => {
    const t = formatUnverifiedAlert(base, ucfg())
    expect(t).toContain('TASK-3571')
    expect(t).toContain('malik')
    expect(t).toContain('6,57 USD')
    expect(t).toContain('1328 s')
    expect(t).toContain('nema ključa [PROVJERA]')
  })

  test('izričito kaže da rad NIJE zaustavljen (nije blokada)', () => {
    expect(formatUnverifiedAlert(base, ucfg())).toContain('Rad NIJE zaustavljen')
  })

  test('nepoznat trošak se ne izmišlja', () => {
    const t = formatUnverifiedAlert({ ...base, costUsd: null, durationS: null }, ucfg())
    expect(t).toContain('trošak nepoznat')
    expect(t).toContain('trajanje nepoznato')
  })

  test('višak razloga se PREBROJI, ne prešuti', () => {
    const t = formatUnverifiedAlert({ ...base, reasons: ['a', 'b', 'c', 'd'] }, ucfg({ maxReasons: 2 }))
    expect(t).toContain('+ još 2 razloga')
  })

  test('partial ima drugu glavu od unverifiable', () => {
    expect(formatUnverifiedAlert({ ...base, status: 'partial' }, ucfg())).toContain('NIJE stigao provjeriti sve')
  })
})

describe('formatUnverifiedSummary', () => {
  const rows = [
    { taskId: 'TASK-1', agentId: 'malik', status: 'unverifiable' as const, reasons: ['nema testova'] },
    { taskId: 'TASK-2', agentId: 'jelena', status: 'partial' as const, reasons: [] },
  ]

  test('nabraja zadatke i broji ih', () => {
    const t = formatUnverifiedSummary('2026-09-01', rows, ucfg())
    expect(t).toContain('2026-09-01')
    expect(t).toContain('2 zadataka')
    expect(t).toContain('TASK-1')
    expect(t).toContain('nema testova')
  })

  test('zadatak bez zapisanog razloga se ne prešućuje', () => {
    expect(formatUnverifiedSummary('2026-09-01', rows, ucfg())).toContain('razlog nije zapisan')
  })

  test('višak zadataka se prebroji', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...rows[0], taskId: `TASK-${i}` }))
    expect(formatUnverifiedSummary('2026-09-01', many, ucfg({ maxSummaryTasks: 2 }))).toContain('+ još 3 zadataka')
  })
})

// ─── Ploča 17781: izvor je POSTOJEĆI critic_gate.jsonl ───────────────────────

describe('unverifiedBoardState', () => {
  function ledger(rows: Partial<LedgerRound>[]): string {
    const p = join(TMP, `ledger-${Math.round(rows.length + Math.abs(rows.length * 7))}-${rows.map((r) => r.taskId).join('_')}.jsonl`)
    writeFileSync(p, rows.map((r) => JSON.stringify({
      ts: '2026-09-01T10:00:00.000Z', taskId: 'TASK-X', agentId: 'malik', round: 1,
      status: 'unverifiable', signatures: [], enforced: false, ...r,
    })).join('\n') + '\n')
    return p
  }
  const now = Date.parse('2026-09-01T12:00:00Z')

  test('neprovjeren zadatak dobiva zapis, provjeren ne', () => {
    const p = ledger([
      { taskId: 'TASK-A', status: 'unverifiable', reasons: ['nema testova'] },
      { taskId: 'TASK-B', status: 'pass' },
      { taskId: 'TASK-C', status: 'fail' },
    ])
    const st = unverifiedBoardState(p, now, ucfg())
    expect(Object.keys(st.tasks)).toEqual(['TASK-A'])
    expect(st.tasks['TASK-A'].reasons).toEqual(['nema testova'])
    expect(st.todayCount).toBe(1)
  })

  test('ZADNJI krug pobjeđuje — popravljen zadatak gubi oznaku', () => {
    const p = ledger([
      { taskId: 'TASK-A', status: 'unverifiable', round: 1 },
      { taskId: 'TASK-A', status: 'pass', round: 2 },
    ])
    expect(unverifiedBoardState(p, now, ucfg()).tasks['TASK-A']).toBeUndefined()
  })

  test('jučerašnji neprovjeren zadatak nosi oznaku, ali se ne broji u „danas"', () => {
    const p = ledger([
      { taskId: 'TASK-A', status: 'unverifiable', ts: '2026-08-30T10:00:00.000Z' },
      { taskId: 'TASK-B', status: 'unverifiable', ts: '2026-09-01T09:00:00.000Z' },
    ])
    const st = unverifiedBoardState(p, now, ucfg())
    expect(Object.keys(st.tasks).sort()).toEqual(['TASK-A', 'TASK-B'])
    expect(st.todayCount).toBe(1)
  })

  test('spawn bez zadatka se ne prikazuje (nema kartice na koju bi oznaka išla)', () => {
    const p = ledger([{ taskId: 'bez-zadatka', status: 'unverifiable' }])
    const st = unverifiedBoardState(p, now, ucfg())
    expect(Object.keys(st.tasks)).toEqual([])
    expect(st.todayCount).toBe(0)
  })

  test('pokvaren redak ne ruši čitanje, ostatak se i dalje vidi', () => {
    const p = join(TMP, 'ledger-pokvaren.jsonl')
    writeFileSync(p, '{nije json\n' + JSON.stringify({
      ts: '2026-09-01T10:00:00.000Z', taskId: 'TASK-Z', agentId: 'malik', round: 1,
      status: 'unverifiable', signatures: [], enforced: false,
    }) + '\n')
    expect(unverifiedBoardState(p, now, ucfg()).todayCount).toBe(1)
  })

  test('nepostojeći trag → prazno stanje, bez iznimke', () => {
    const st = unverifiedBoardState(join(TMP, 'nema-traga.jsonl'), now, ucfg())
    expect(st.todayCount).toBe(0)
    expect(st.tasks).toEqual({})
  })

  test('partial isključen konfiguracijom ne pali oznaku', () => {
    const p = ledger([{ taskId: 'TASK-P', status: 'partial' }])
    expect(Object.keys(unverifiedBoardState(p, now, ucfg({ includePartial: false })).tasks)).toEqual([])
    expect(Object.keys(unverifiedBoardState(p, now, ucfg({ includePartial: true })).tasks)).toEqual(['TASK-P'])
  })

  test('redci za sažetak čitaju razloge iz istog traga', () => {
    const p = ledger([{ taskId: 'TASK-S', status: 'unverifiable', reasons: ['nema ključa [PROVJERA]'] }])
    expect(summaryRows(['TASK-S'], p)[0].reasons).toEqual(['nema ključa [PROVJERA]'])
    // Zadatak kojeg u tragu nema ne izmišlja razlog.
    expect(summaryRows(['TASK-NEMA'], p)[0].reasons).toEqual([])
  })

  test('lastRoundPerTask / readLedgerAll rade nad cijelim tragom, ne po zadatku', () => {
    const p = ledger([{ taskId: 'TASK-A' }, { taskId: 'TASK-B' }, { taskId: 'TASK-A', round: 2 }])
    expect(readLedgerAll(p).length).toBe(3)
    expect(lastRoundPerTask(readLedgerAll(p)).get('TASK-A')!.round).toBe(2)
  })
})

// ─── Kraj-do-kraja: kritičar upisuje razlog i NE blokira ─────────────────────

describe('kraj-do-kraja: sud bez ijedne provjere', () => {
  test('prazno stablo → unverifiable, accept, enforce=false, ALI s razlozima u tragu', () => {
    const root = join(TMP, 'e2e-prazno')
    mkdirSync(root, { recursive: true })
    const ledgerPath = join(TMP, 'e2e-ledger.jsonl')
    const prev = process.env.REGOC_CRITIC_LEDGER
    process.env.REGOC_CRITIC_LEDGER = ledgerPath
    try {
      const o = critiqueSpawn(
        { taskId: 'TASK-E2E', agentId: 'malik', sinceMs: Date.now() - 1000, live: true },
        ccfg({ watchRoots: [root] }),
        () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      )
      // 1. NE BLOKIRA — rad prolazi kao i dosad.
      expect(o.verdict.status).toBe('unverifiable')
      expect(o.verdict.blocking).toBe(false)
      expect(o.enforce).toBe(false)
      expect(o.loop.action).toBe('accept')
      expect(o.blockedReason).toBe('')
      // 2. ALI se zna ŠTO je nedostajalo.
      expect(o.reasons.length).toBeGreaterThan(0)
      expect(o.reasons.join('\n')).toContain(root)
      // 3. Razlog je u tragu, pa ga ploča i sažetak čitaju bez daemona.
      const rows = readLedger('TASK-E2E', ledgerPath)
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe('unverifiable')
      expect((rows[0].reasons || []).length).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env.REGOC_CRITIC_LEDGER
      else process.env.REGOC_CRITIC_LEDGER = prev
    }
  })

  test('prolaz NE upisuje razloge (šum bi zatrpao trag)', () => {
    const root = join(TMP, 'e2e-pass')
    mkdirSync(root, { recursive: true })
    writeAt(join(root, 'Modul.ts'), 'export const a = 1\n', Date.now())
    const ledgerPath = join(TMP, 'e2e-ledger-pass.jsonl')
    const prev = process.env.REGOC_CRITIC_LEDGER
    process.env.REGOC_CRITIC_LEDGER = ledgerPath
    try {
      const o = critiqueSpawn(
        { taskId: 'TASK-PASS', agentId: 'malik', sinceMs: Date.now() - 60_000, live: true },
        ccfg({ watchRoots: [root] }),
        () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      )
      expect(o.verdict.status).toBe('pass')
      expect(o.reasons).toEqual([])
      expect(readLedger('TASK-PASS', ledgerPath)[0].reasons).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.REGOC_CRITIC_LEDGER
      else process.env.REGOC_CRITIC_LEDGER = prev
    }
  })
})
