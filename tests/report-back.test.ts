/**
 * ReportBackTask — jedinični testovi (U4 / TASK-4264).
 *
 * PRIHVATNI KRITERIJ (razrada §4, korak 9): niz od 3 zadatka daje TOČNO JEDNU poruku
 * korisniku na kraju, ne tri. Sve ostalo u ovoj datoteci brani taj jedan broj:
 *   – dok je i jedan zadatak otvoren, poruke NEMA,
 *   – kad se zatvori zadnji, poruka je JEDNA,
 *   – ponovljena pometnja NE šalje drugu (dnevnik, ne status).
 */
import { describe, test, expect } from 'bun:test'
import {
  CLOSED_STATUSES, MAX_MSG_LEN, NO_AUTONOMY_TAG, REPORT_BACK_TAG,
  addTasksToMarker, buildReportBackMessage, buildReportBackTaskBody, evaluateReportBack,
  formatReportBackMarker, isReportBackTask, parseReportBackMarker, runReportBackSweep,
  type ChainTaskView, type ReportBackTaskView, type SweepDeps,
} from '../src/core/ReportBackTask'

const CHAT = -1001234567890

// ─── Mala ploča u memoriji: pometnja se testira bez baze i bez mreže ──────────

function makeBoard(chainStatuses: string[], opts: { live?: boolean; sendOk?: boolean } = {}) {
  const chain: ChainTaskView[] = chainStatuses.map((st, i) => ({
    id: `TASK-${100 + i}`,
    title: `Korak ${i + 1}`,
    status: st,
    resultSummary: `napravljeno ${i + 1}, provjereno naredbom bun test`,
  }))
  const rb: ReportBackTaskView = {
    id: 'TASK-200',
    title: '📣 Dojava: Napravi X',
    status: 'blocked',
    tags: [REPORT_BACK_TAG, NO_AUTONOMY_TAG],
    projectId: 'PRJ-001',
    description: 'blabla\n' + formatReportBackMarker({ chatId: CHAT, taskIds: chain.map(c => c.id) }) + '\nblabla',
  }
  const sent: Array<{ chatId: number; text: string }> = []
  const sentLog = new Set<string>()
  const closed: string[] = []
  const logs: string[] = []
  const deps: SweepDeps = {
    listOpenReportBacks: () => (closed.includes(rb.id) ? [] : [rb]),
    getTask: id => chain.find(c => c.id === id) || null,
    send: (chatId, text) => { if (opts.sendOk === false) return false; sent.push({ chatId, text }); return true },
    close: id => { closed.push(id); rb.status = 'completed' },
    alreadySent: id => sentLog.has(id),
    markSent: id => { sentLog.add(id) },
    log: m => logs.push(m),
    cfg: { enabled: true, live: opts.live ?? true, maxLen: MAX_MSG_LEN },
  }
  return { chain, rb, sent, closed, logs, deps, sentLog }
}

// ─── Biljeg ──────────────────────────────────────────────────────────────────

describe('biljeg niza u opisu (preživljava brisanje blockedBy)', () => {
  test('zapis i čitanje', () => {
    const m = formatReportBackMarker({ chatId: CHAT, taskIds: ['TASK-1', 'task-2'] })
    expect(m).toBe('[report-back chatId=-1001234567890 tasks=TASK-1,TASK-2]')
    expect(parseReportBackMarker(`uvod\n${m}\nkraj`)).toEqual({ chatId: CHAT, taskIds: ['TASK-1', 'TASK-2'] })
  })
  test('bez biljega / smeće → null, ne iznimka', () => {
    expect(parseReportBackMarker('nema biljega')).toBeNull()
    expect(parseReportBackMarker(null)).toBeNull()
    expect(parseReportBackMarker('[report-back chatId=0 tasks=TASK-1]')).toBeNull()
  })
  test('duplikati i smeće u popisu se čiste', () => {
    const m = parseReportBackMarker('[report-back chatId=-1234567 tasks=TASK-1, TASK-1 ,nesto,TASK-2]')
    expect(m!.taskIds).toEqual(['TASK-1', 'TASK-2'])
  })
  test('naknadni podzadaci se dopisuju u biljeg', () => {
    const opis = 'x\n' + formatReportBackMarker({ chatId: CHAT, taskIds: ['TASK-1'] })
    const novi = addTasksToMarker(opis, ['TASK-2', 'TASK-1'])!
    expect(parseReportBackMarker(novi)!.taskIds).toEqual(['TASK-1', 'TASK-2'])
    expect(addTasksToMarker('bez biljega', ['TASK-2'])).toBeNull()
  })
})

describe('otvaranje zadatka dojave', () => {
  const body = buildReportBackTaskBody({ chatId: CHAT, chainTaskIds: ['TASK-1', 'TASK-2', 'TASK-3'], subject: 'Napravi X', projectId: 'PRJ-001' })
  test('nosi chatId izvorne poruke i cijeli niz', () => {
    expect(parseReportBackMarker(body.description)).toEqual({ chatId: CHAT, taskIds: ['TASK-1', 'TASK-2', 'TASK-3'] })
  })
  test('blockedBy su svi zadaci niza, status blocked', () => {
    expect(body.blockedBy).toEqual(['TASK-1', 'TASK-2', 'TASK-3'])
    expect(body.status).toBe('blocked')
  })
  test('oznake: report-back + no-autonomy (bez spawna modela)', () => {
    expect(body.tags).toContain(REPORT_BACK_TAG)
    expect(body.tags).toContain(NO_AUTONOMY_TAG)
    expect(isReportBackTask(body.tags)).toBe(true)
  })
  test('naslov stane u granicu sheme (200)', () => {
    const dug = buildReportBackTaskBody({ chatId: CHAT, chainTaskIds: ['TASK-1'], subject: 'x'.repeat(400) })
    expect(dug.title.length).toBeLessThanOrEqual(200)
  })
})

describe('sud: je li niz gotov', () => {
  const lookup = (m: Record<string, string>) => (id: string) => (m[id] ? { id, status: m[id] } : null)
  test('otvoren zadatak drži dojavu', () => {
    const v = evaluateReportBack({ chatId: CHAT, taskIds: ['A', 'B'].map((_, i) => `TASK-${i}`) },
      lookup({ 'TASK-0': 'completed', 'TASK-1': 'in_progress' }))
    expect(v.ready).toBe(false)
    expect(v.code).toBe('waiting')
    expect(v.open).toEqual(['TASK-1'])
  })
  test('blocked zadatak je OTVOREN (dojava čeka)', () => {
    const v = evaluateReportBack({ chatId: CHAT, taskIds: ['TASK-0'] }, lookup({ 'TASK-0': 'blocked' }))
    expect(v.ready).toBe(false)
  })
  test('completed i cancelled su zatvoreni', () => {
    expect([...CLOSED_STATUSES].sort()).toEqual(['cancelled', 'completed'])
    const v = evaluateReportBack({ chatId: CHAT, taskIds: ['TASK-0', 'TASK-1'] },
      lookup({ 'TASK-0': 'completed', 'TASK-1': 'cancelled' }))
    expect(v.ready).toBe(true)
  })
  test('obrisan zadatak ne drži dojavu zauvijek, ali se navodi', () => {
    const v = evaluateReportBack({ chatId: CHAT, taskIds: ['TASK-0', 'TASK-9'] }, lookup({ 'TASK-0': 'completed' }))
    expect(v.ready).toBe(true)
    expect(v.code).toBe('missing_tasks')
    expect(v.missing).toEqual(['TASK-9'])
  })
  test('bez biljega / prazan niz nikad nije spreman', () => {
    expect(evaluateReportBack(null, () => null).code).toBe('no_marker')
    expect(evaluateReportBack({ chatId: CHAT, taskIds: [] }, () => null).code).toBe('empty_chain')
  })
})

describe('poruka', () => {
  test('jedna poruka nabraja sve zadatke niza', () => {
    const txt = buildReportBackMessage({
      subject: 'Napravi X',
      tasks: [
        { id: 'TASK-1', title: 'Prvi', status: 'completed', resultSummary: 'a' },
        { id: 'TASK-2', title: 'Drugi', status: 'completed', resultSummary: 'b' },
        { id: 'TASK-3', title: 'Treći', status: 'cancelled', resultSummary: 'c' },
      ],
      projectId: 'PRJ-001', reportBackId: 'TASK-4',
    })
    expect(txt).toContain('Niz od 3 zadataka: 2 završeno, 1 otkazano')
    for (const id of ['TASK-1', 'TASK-2', 'TASK-3']) expect(txt).toContain(id)
  })
  test('dugi rezultati se režu, poruka staje u Telegram granicu', () => {
    const txt = buildReportBackMessage({
      subject: 'S'.repeat(100),
      tasks: Array.from({ length: 12 }, (_, i) => ({
        id: `TASK-${i}`, title: `Naslov ${i}`, status: 'completed', resultSummary: 'x'.repeat(5000),
      })),
    })
    expect(txt.length).toBeLessThanOrEqual(MAX_MSG_LEN)
    expect(txt).toContain('TASK-11')
  })
})

// ─── PRIHVATNI KRITERIJ ──────────────────────────────────────────────────────

describe('KRITERIJ: niz od 3 zadatka → točno JEDNA poruka', () => {
  test('dok jedan traje — nula poruka', () => {
    const b = makeBoard(['completed', 'completed', 'in_progress'])
    const r = runReportBackSweep(b.deps)
    expect(b.sent.length).toBe(0)
    expect(r.fired.length).toBe(0)
    expect(r.held[0].code).toBe('waiting')
  })
  test('kad se zatvori zadnji — točno jedna poruka za sva tri', () => {
    const b = makeBoard(['completed', 'completed', 'completed'])
    const r = runReportBackSweep(b.deps)
    expect(b.sent.length).toBe(1)
    expect(r.fired.length).toBe(1)
    expect(b.sent[0].chatId).toBe(CHAT)
    for (const t of b.chain) expect(b.sent[0].text).toContain(t.id)
    expect(b.closed).toEqual(['TASK-200'])
  })
  test('ponovljena pometnja NE šalje drugu poruku', () => {
    const b = makeBoard(['completed', 'completed', 'completed'])
    runReportBackSweep(b.deps)
    runReportBackSweep(b.deps)
    runReportBackSweep(b.deps)
    expect(b.sent.length).toBe(1)
  })
  test('dnevnik, a ne status, brani od druge poruke (pad između slanja i zatvaranja)', () => {
    const b = makeBoard(['completed', 'completed', 'completed'])
    b.deps.close = () => { throw new Error('pad baze poslije slanja') }
    runReportBackSweep(b.deps)          // poslano, zatvaranje palo
    const drugi = runReportBackSweep(b.deps)  // zadatak je i dalje otvoren
    expect(b.sent.length).toBe(1)
    expect(drugi.held[0].code).toBe('duplicate')
  })
  test('SHADOW (live=false) ne šalje ništa, ali zapisuje', () => {
    const b = makeBoard(['completed', 'completed', 'completed'], { live: false })
    const r = runReportBackSweep(b.deps)
    expect(b.sent.length).toBe(0)
    expect(r.held[0].code).toBe('shadow')
    expect(b.logs.join('\n')).toContain('SHADOW')
  })
  test('neuspjelo slanje se ne knjiži kao poslano (pokušat će opet)', () => {
    const b = makeBoard(['completed', 'completed', 'completed'], { sendOk: false })
    const r = runReportBackSweep(b.deps)
    expect(r.held[0].code).toBe('send_failed')
    expect(b.sentLog.size).toBe(0)
    expect(b.closed.length).toBe(0)
  })
  test('isključena pometnja ne dira ništa', () => {
    const b = makeBoard(['completed', 'completed', 'completed'])
    b.deps.cfg = { enabled: false, live: true, maxLen: MAX_MSG_LEN }
    runReportBackSweep(b.deps)
    expect(b.sent.length).toBe(0)
  })
})

describe('čitljivi redak niza prati biljeg', () => {
  test('„Niz (N): …" se osvježava zajedno s biljegom', () => {
    const body = buildReportBackTaskBody({ chatId: CHAT, chainTaskIds: ['TASK-1'], subject: 'X' })
    expect(body.description).toContain('Niz (1): TASK-1')
    const novi = addTasksToMarker(body.description, ['TASK-2', 'TASK-3'])!
    expect(novi).toContain('Niz (3): TASK-1, TASK-2, TASK-3')
    expect(parseReportBackMarker(novi)!.taskIds).toEqual(['TASK-1', 'TASK-2', 'TASK-3'])
  })
})
