/**
 * TASK-5327 (prijenos s glavnog, TASK-5204): naknadna revizija blokiranih — čiste funkcije
 * klasifikacije, odluke i pregleda za ploču, te putanje (konfiguracija i dnevnik izvornog daemona).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  BLOK_KLASE, UVIJEK_COVJEKU, klasaIzOznaka, withBlokTag, klasificirajBlokadu, loadBlockedReviewConfig,
  nacinRevizije, decideBlockedTask, pregledBlokiranih, zadnjePresude, povijestPresuda, procitajBudzet,
  putanjaDnevnikaRevizije, putanjaKonfiguracijeRevizije, DEFAULT_BLOCKED_REVIEW_CONFIG, makeBlockedReviewLookup,
  type BlockedReviewInput, type BlockedTask,
} from '../src/core/RevizijaBlokiranih'
import { Database } from 'bun:sqlite'

const H = 3_600_000
const D = 24 * H
const sad = Date.parse('2026-10-07T12:00:00Z')
const cfg = { ...DEFAULT_BLOCKED_REVIEW_CONFIG, klaseUzivo: [...DEFAULT_BLOCKED_REVIEW_CONFIG.klaseUzivo] }

function ulaz(o: Partial<BlockedReviewInput> = {}): BlockedReviewInput {
  return {
    now: sad, config: cfg, ulazakMs: sad - 2 * D, redrive: 0, uzrokNestao: { ok: true, razlog: 'disk ok' },
    projektArhiviran: false, rjesenoDrugdje: null, procjenaUsd: 1, ukupnoUsd: 0, ...o,
  }
}

const mape: string[] = []
const novaMapa = () => { const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-rev-')); mape.push(d); return d }
afterEach(() => {
  for (const d of mape.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.TM_IZVORNI_PODACI
  delete process.env.TM_STALE_WATCHDOG_CONFIG
})

describe('oznake blok:*', () => {
  test('klasa iz oznake; nepoznata klasa se ignorira', () => {
    expect(klasaIzOznaka(['x', 'blok:lanac'])).toBe('lanac')
    expect(klasaIzOznaka(['blok:izmisljeno'])).toBeNull()
  })
  test('withBlokTag zamjenjuje staru klasu, ne gomila', () => {
    expect(withBlokTag(['a', 'blok:prolazno', 'a'], 'deploy')).toEqual(['a', 'blok:deploy'])
  })
  test('uvijek-čovjeku klase su podskup poznatih', () => {
    for (const k of UVIJEK_COVJEKU) expect(BLOK_KLASE).toContain(k)
  })
})

describe('klasificirajBlokadu', () => {
  test('strojni kod u razlogu', () => {
    expect(klasificirajBlokadu({ blockedReason: 'LANAC: čeka TASK-1' }).klasa).toBe('lanac')
    expect(klasificirajBlokadu({ blockedReason: 'COVJEK: treba mjerenje' }).klasa).toBe('covjek')
  })
  test('čeka restart <servis> → deploy; Spawn prekinut → prolazno; bez razloga → nepoznato', () => {
    expect(klasificirajBlokadu({ blockedReason: 'čeka restart regocdaemon' }).klasa).toBe('deploy')
    expect(klasificirajBlokadu({ blockedReason: 'Spawn prekinut (exit 1)' }).klasa).toBe('prolazno')
    expect(klasificirajBlokadu({}).klasa).toBe('nepoznato')
  })
  test('oznaka waiting-for-human preteže nad strojnim razlogom', () => {
    expect(klasificirajBlokadu({ tags: ['waiting-for-human'], blockedReason: 'Spawn prekinut' }).klasa).toBe('covjek')
  })
  test('rizik je brana (rizikPreteze=false): klasa ostaje, pogodak se vraća', () => {
    const k = klasificirajBlokadu({ title: 'plati račun', blockedReason: 'Spawn prekinut' }, { rizikPreteze: false })
    expect(k.klasa).toBe('prolazno')
    expect(k.rizik?.klasa).toBe('novac')
  })
  test('niječnica gasi pogodak rizika („nemoj brisati”)', () => {
    expect(klasificirajBlokadu({ title: 'nemoj brisati bazu', blockedReason: 'Spawn prekinut' }).rizik).toBeUndefined()
  })
})

describe('konfiguracija i prekidač', () => {
  test('nedostajuća datoteka → zadano; klaseUzivo fail-closed i bez klasa uvijek-čovjeku', () => {
    const d = novaMapa()
    expect(loadBlockedReviewConfig(join(d, 'nema.json')).klaseUzivo).toEqual(['lanac', 'deploy'])
    writeFileSync(join(d, 'a.json'), JSON.stringify({ blocked: { klaseUzivo: ['deploy', 'odluka'] } }))
    expect(loadBlockedReviewConfig(join(d, 'a.json')).klaseUzivo).toEqual(['deploy'])
    writeFileSync(join(d, 'b.json'), JSON.stringify({ blocked: { klaseUzivo: ['deploy', 'izmisljeno'] } }))
    expect(loadBlockedReviewConfig(join(d, 'b.json')).klaseUzivo).toEqual([])
    writeFileSync(join(d, 'c.json'), '{nije json')
    expect(loadBlockedReviewConfig(join(d, 'c.json')).klaseUzivo).toEqual([])
  })
  test('izuzeti nositelji dolaze iz excludeAssignees iste datoteke (izvorni daemon i ploča sude isto)', () => {
    const d = novaMapa()
    writeFileSync(join(d, 's.json'), JSON.stringify({ excludeAssignees: ['user', 'vlasnik'], blocked: { projektiUvijekGoranu: ['prj-9'] } }))
    const c = loadBlockedReviewConfig(join(d, 's.json'))
    expect(c.izuzetiNositelji).toEqual(['user', 'vlasnik'])
    expect(c.projektiUvijekCovjeku).toEqual(['prj-9'])
  })
  test('nacinRevizije: off / shadow / on', () => {
    expect(nacinRevizije(() => false)).toBe('off')
    expect(nacinRevizije(n => n === 'revizijaBlokiranih')).toBe('shadow')
    expect(nacinRevizije(() => true)).toBe('on')
  })
  test('putanje: TM_STALE_WATCHDOG_CONFIG i TM_IZVORNI_PODACI (komplet izvornog sustava na čvoru)', () => {
    process.env.TM_STALE_WATCHDOG_CONFIG = '/x/stale.json'
    process.env.TM_IZVORNI_PODACI = '/y/data'
    expect(putanjaKonfiguracijeRevizije()).toBe('/x/stale.json')
    expect(putanjaDnevnikaRevizije()).toBe('/y/data/revizija_blokiranih.jsonl')
  })
})

describe('decideBlockedTask', () => {
  const t = (o: Partial<BlockedTask>): BlockedTask => ({ id: 'TASK-10', title: 'zadatak', assignee: 'inzenjer', tags: [], ...o })

  test('klasa uvijek-čovjeku bez oznaka → covjeku (dodaje blok:* i waiting-for-human)', () => {
    const d = decideBlockedTask(t({ blockedReason: 'ODLUKA: A ili B' }), ulaz())
    expect(d.presuda).toBe('covjeku')
    expect(d.oznake).toEqual(['blok:odluka', 'waiting-for-human'])
  })
  test('prolazno, uzrok nestao, rok prošao → pusti s redrive:1', () => {
    const d = decideBlockedTask(t({ blockedReason: 'Spawn prekinut' }), ulaz({ ulazakMs: sad - 4 * D }))
    expect(d.presuda).toBe('pusti')
    expect(d.oznake).toContain('redrive:1')
  })
  test('prolazno s pogotkom rizika → covjeku, nikad pusti', () => {
    const d = decideBlockedTask(t({ title: 'deploy na produkciju', blockedReason: 'Spawn prekinut' }), ulaz({ ulazakMs: sad - 4 * D }))
    expect(d.presuda).toBe('covjeku')
  })
  test('lanac: svi roditelji completed → otpusti-lanac; roditelj bez blocks → popravi-lanac', () => {
    const z = t({ blockedReason: 'LANAC: čeka TASK-1' })
    expect(decideBlockedTask(z, ulaz({ lanac: [{ id: 'TASK-1', status: 'completed', imaBlocks: true }] })).presuda).toBe('otpusti-lanac')
    expect(decideBlockedTask(z, ulaz({ lanac: [{ id: 'TASK-1', status: 'in_progress', imaBlocks: false }] })).presuda).toBe('popravi-lanac')
  })
  test('deploy: StaleCodeCheck exit 0 → zatvori-deploy', () => {
    const d = decideBlockedTask(t({ blockedReason: 'čeka restart daemon' }), ulaz({ deploy: { servis: 'daemon', exit: 0, izlaz: 'OK' } }))
    expect(d.presuda).toBe('zatvori-deploy')
  })
  test('izuzet nositelj (konfiguracija) → izuzet', () => {
    const d = decideBlockedTask(t({ assignee: 'user', blockedReason: 'Spawn prekinut' }), ulaz())
    expect(d.presuda).toBe('izuzet')
  })
  test('strop puštanja → strop', () => {
    const d = decideBlockedTask(t({ tags: ['redrive:3'], blockedReason: 'Spawn prekinut' }), ulaz({ ulazakMs: sad - 4 * D }))
    expect(d.presuda).toBe('strop')
  })
})

describe('pregledBlokiranih (traka „Blokirano” na ploči)', () => {
  test('skupine iz presude: ponovno / covjeku / istroseno / ostalo; lanac sa zapetim roditeljem nije „ponovno”', () => {
    const tasks: BlockedTask[] = [
      { id: 'TASK-1', title: 'a', assignee: 'inzenjer', blockedReason: 'ODLUKA: koji', tags: [] },
      { id: 'TASK-2', title: 'b', assignee: 'inzenjer', blockedReason: 'Spawn prekinut', tags: [] },
      { id: 'TASK-3', title: 'c', assignee: 'inzenjer', blockedReason: 'Spawn prekinut', tags: ['redrive:3'] },
      { id: 'TASK-4', title: 'd', assignee: 'inzenjer', blockedReason: 'LANAC', blockedBy: ['TASK-1'], tags: [] },
    ]
    const p = pregledBlokiranih(tasks, {
      now: sad, config: cfg, nacin: 'shadow', ulazak: () => sad - D, zadnja: new Map(),
      budzet: { pustenoUsdDanas: 0, pustenoBrojDanas: 0, spawnova24h: 0 },
    })
    const po = Object.fromEntries(p.zadaci.map(z => [z.id, z.skupina]))
    expect(po).toEqual({ 'TASK-1': 'covjeku', 'TASK-2': 'ponovno', 'TASK-3': 'istroseno', 'TASK-4': 'ostalo' })
    expect(p.skupine).toEqual({ ponovno: 1, covjeku: 1, istroseno: 1, ostalo: 1 })
    expect(p.poKlasi.lanac).toBe(1)
    expect(p.zadaci.find(z => z.id === 'TASK-4')!.cekaNa).toContain('TASK-1')
  })
})

describe('dnevnik presuda (data/revizija_blokiranih.jsonl izvornog daemona)', () => {
  test('zadnja presuda po zadatku, povijest jednog zadatka, proračun samo iz izvedenih puštanja uživo', () => {
    const d = novaMapa()
    const log = join(d, 'revizija_blokiranih.jsonl')
    const ts = new Date(sad - H).toISOString()
    writeFileSync(log, [
      { ts, taskId: 'TASK-1', presuda: 'ceka', razlog: 'r1', nacin: 'shadow' },
      { ts, taskId: 'TASK-1', presuda: 'pusti', razlog: 'r2', nacin: 'live', izvedeno: true, usd_procjena: 2 },
      { ts, taskId: 'TASK-2', presuda: 'pusti', razlog: 'r3', nacin: 'shadow', izvedeno: false, usd_procjena: 9 },
    ].map(r => JSON.stringify(r)).join('\n') + '\npoluzapis{')
    expect(zadnjePresude(log).get('TASK-1').razlog).toBe('r2')
    expect(povijestPresuda('TASK-1', 30, log).map(r => r.razlog)).toEqual(['r1', 'r2'])
    const b = procitajBudzet(sad, log, join(d, 'nema_run_log.jsonl'))
    expect(b).toEqual({ pustenoUsdDanas: 2, pustenoBrojDanas: 1, spawnova24h: 0 })
  })
})

describe('makeBlockedReviewLookup nad bazom ploče', () => {
  test('ulazak iz task_history, roditelji lanca iz blocks, arhivirani projekt', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE tasks (id TEXT, status TEXT, blocks TEXT, project_id TEXT, description TEXT, result_summary TEXT, completed_at TEXT);
      CREATE TABLE task_history (task_id TEXT, field TEXT, new_value TEXT, changed_at TEXT);
      CREATE TABLE projects (id TEXT, status TEXT);`)
    db.exec(`INSERT INTO tasks VALUES ('TASK-1','completed','["TASK-2"]','PRJ-1',NULL,NULL,'2026-10-01'),
      ('TASK-2','blocked','[]','PRJ-2',NULL,NULL,NULL);
      INSERT INTO task_history VALUES ('TASK-2','status','blocked','2026-10-05 12:00:00');
      INSERT INTO projects VALUES ('PRJ-2','archived');`)
    const u = makeBlockedReviewLookup(db as any, { now: sad, config: cfg, uzrok: { ok: false, razlog: 'ploča' } })(
      { id: 'TASK-2', assignee: 'inzenjer', blockedBy: ['TASK-1'], tags: [] })
    expect(u.ulazakMs).toBe(Date.parse('2026-10-05T12:00:00Z'))
    expect(u.lanac).toEqual([{ id: 'TASK-1', status: 'completed', imaBlocks: true }])
    expect(u.projektArhiviran).toBe(true)
    expect(u.procjenaUsd).toBe(5)
  })
})
