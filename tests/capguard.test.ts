// TASK-5270 — kartica „Sigurnost" (capguard) kao UVJETNI dio paketa: stanje iz capabilities.state
// (samo čitanje), zahtjev = INSERT u capability_requests, Tier-2 čeka odobrenje izvan ploče.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  capguardPostavke, kratkoIme, punoIme, stanjeCapguarda, zatraziSposobnost, uputaOdobrenja,
} from '../src/Capguard'

let dir: string
let statePath: string
let db: Database

const STANJE = {
  updated_at: '2026-10-06T14:32:48Z',
  host: 'cvor-test',
  capabilities: {
    plan_mode: { on: true, tier: 1, action: 'flag' },
    allow_messaging: { on: false, tier: 1, action: 'flag' },
    allow_internet: { on: false, tier: 2, action: 'internet' },
  },
}

function shema(d: Database) {
  d.exec(`CREATE TABLE capability_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    desired INTEGER NOT NULL, requested_by TEXT, status TEXT NOT NULL DEFAULT 'pending', approved_by TEXT,
    note TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE capability_catalog (name TEXT PRIMARY KEY, tier INTEGER, requires_admin INTEGER,
    default_on INTEGER, action TEXT, description TEXT);
    INSERT INTO capability_catalog VALUES ('plan_mode',1,0,1,'flag','PLAN/WORK'),
      ('allow_messaging',1,0,0,'flag','Slanje poruka'), ('allow_internet',2,1,0,'internet','WAN egress');`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tmai-capguard-'))
  statePath = join(dir, 'capabilities.state')
  db = new Database(join(dir, 't.db'))
  shema(db)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('capguardPostavke — kartica postoji samo uz capguard', () => {
  test('bez datoteke stanja i bez TM_CAPGUARD → isključeno (zadani put paketa)', () => {
    const p = capguardPostavke({ TM_CAPGUARD_STATE: statePath })
    expect(p.aktivno).toBe(false)
  })
  test('datoteka stanja postoji → uključeno', () => {
    writeFileSync(statePath, JSON.stringify(STANJE))
    const p = capguardPostavke({ TM_CAPGUARD_STATE: statePath })
    expect(p.aktivno).toBe(true)
    expect(p.izvor).toBe('stanje')
  })
  test('TM_CAPGUARD=1 uključuje i bez datoteke; TM_CAPGUARD=0 gasi i uz datoteku', () => {
    expect(capguardPostavke({ TM_CAPGUARD_STATE: statePath, TM_CAPGUARD: '1' }).aktivno).toBe(true)
    writeFileSync(statePath, '{}')
    expect(capguardPostavke({ TM_CAPGUARD_STATE: statePath, TM_CAPGUARD: '0' }).aktivno).toBe(false)
  })
  test('zadana putanja stanja je capguardova /etc/regoc/capabilities.state', () => {
    expect(capguardPostavke({}).statePath).toBe('/etc/regoc/capabilities.state')
  })
})

describe('imena sposobnosti', () => {
  test('kratko ↔ puno', () => {
    expect(punoIme('internet')).toBe('allow_internet')
    expect(punoIme('allow_mesh')).toBe('allow_mesh')
    expect(punoIme('plan_mode')).toBe('plan_mode')
    expect(kratkoIme('allow_internet')).toBe('internet')
    expect(kratkoIme('plan_mode')).toBe('plan_mode')
  })
  test('uputa za Tier-2: admin naredba i host token', () => {
    const u = uputaOdobrenja('allow_internet', true, {})
    expect(u.admin).toBe('sudo /usr/local/sbin/regoc-capguard approve internet on')
    expect(u.hostToken).toBe('/media/sf_regoc_approvals/allow_internet.approve')
    expect(u.hostTokenSadrzaj).toMatch(/^on <epoch>$/)
    expect(uputaOdobrenja('allow_mesh', false, {}).admin).toBe('sudo /usr/local/sbin/regoc-capguard approve mesh off')
  })
})

describe('stanjeCapguarda — čita, ne piše', () => {
  test('stanje iz datoteke + katalog + pending iz baze', () => {
    writeFileSync(statePath, JSON.stringify(STANJE))
    db.exec("INSERT INTO capability_requests(name,desired,requested_by,status) VALUES('allow_internet',1,'webui','pending')")
    const s = stanjeCapguarda(db, { TM_CAPGUARD_STATE: statePath })
    expect(s.aktivno).toBe(true)
    expect(s.effective).toEqual({ plan_mode: true, allow_messaging: false, allow_internet: false })
    expect(s.host).toBe('cvor-test')
    expect(s.updated_at).toBe('2026-10-06T14:32:48Z')
    expect(s.catalog.map(c => c.name)).toEqual(['allow_messaging', 'plan_mode', 'allow_internet'])
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0].uputa?.admin).toContain('approve internet on')
  })
  test('neispravna datoteka stanja → greska, bez rušenja', () => {
    writeFileSync(statePath, '{nije json')
    const s = stanjeCapguarda(db, { TM_CAPGUARD_STATE: statePath })
    expect(s.greska).toBeTruthy()
    expect(s.effective).toEqual({})
  })
  test('baza bez tablica capguarda → katalog iz datoteke stanja', () => {
    writeFileSync(statePath, JSON.stringify(STANJE))
    const prazna = new Database(':memory:')
    const s = stanjeCapguarda(prazna, { TM_CAPGUARD_STATE: statePath })
    prazna.close()
    expect(s.catalog.map(c => c.name).sort()).toEqual(['allow_internet', 'allow_messaging', 'plan_mode'])
    expect(s.pending).toEqual([])
  })
})

describe('zatraziSposobnost — jedino što ploča smije: upis namjere', () => {
  const env = () => ({ TM_CAPGUARD_STATE: statePath })
  beforeEach(() => writeFileSync(statePath, JSON.stringify(STANJE)))

  test('Tier-1 → pending upis, napomena da capguard primjenjuje sam', () => {
    const r = zatraziSposobnost(db, { name: 'allow_messaging', desired: 'on' }, env())
    expect(r.status).toBe(200)
    expect(r.body.tier).toBe(1)
    expect(r.body.uputa).toBeUndefined()
    const red = db.query('SELECT name,desired,requested_by,status FROM capability_requests').get() as any
    expect(red).toEqual({ name: 'allow_messaging', desired: 1, requested_by: 'webui', status: 'pending' })
  })
  test('Tier-2 kratkim imenom → pending + uputa za odobrenje', () => {
    const r = zatraziSposobnost(db, { name: 'internet', desired: true }, env())
    expect(r.status).toBe(200)
    expect(r.body.name).toBe('allow_internet')
    expect(r.body.tier).toBe(2)
    expect(r.body.uputa.admin).toBe('sudo /usr/local/sbin/regoc-capguard approve internet on')
    expect(r.body.uputa.hostToken).toBe('/media/sf_regoc_approvals/allow_internet.approve')
    const red = db.query('SELECT status FROM capability_requests').get() as any
    expect(red.status).toBe('pending')
  })
  test('ploča NIKAD ne upisuje applied/approved_by (ne zaobilazi capguard)', () => {
    zatraziSposobnost(db, { name: 'allow_internet', desired: 'on', status: 'applied', approved_by: 'admin' } as any, env())
    const red = db.query('SELECT status,approved_by FROM capability_requests').get() as any
    expect(red).toEqual({ status: 'pending', approved_by: null })
  })
  test('kratko ime s podvlakom (fs_write) razrješava se preko kataloga', () => {
    db.exec("INSERT INTO capability_catalog VALUES ('allow_fs_write',1,0,0,'flag','Pisanje')")
    const r = zatraziSposobnost(db, { name: 'fs_write', desired: 'on' }, env())
    expect(r.status).toBe(200)
    expect(r.body.name).toBe('allow_fs_write')
  })
  test('dupli pending → 409', () => {
    zatraziSposobnost(db, { name: 'allow_internet', desired: 'on' }, env())
    expect(zatraziSposobnost(db, { name: 'allow_internet', desired: 'off' }, env()).status).toBe(409)
  })
  test('nepoznato ime, prazno ime, neispravan desired → 400 bez upisa', () => {
    expect(zatraziSposobnost(db, { name: 'allow_sve', desired: 'on' }, env()).status).toBe(400)
    expect(zatraziSposobnost(db, { name: '', desired: 'on' }, env()).status).toBe(400)
    expect(zatraziSposobnost(db, { name: 'allow_internet', desired: 'možda' }, env()).status).toBe(400)
    expect((db.query('SELECT COUNT(*) n FROM capability_requests').get() as any).n).toBe(0)
  })
  test('capguard nije prisutan → 404, ništa se ne upisuje', () => {
    rmSync(statePath)
    expect(zatraziSposobnost(db, { name: 'allow_internet', desired: 'on' }, env()).status).toBe(404)
    expect((db.query('SELECT COUNT(*) n FROM capability_requests').get() as any).n).toBe(0)
  })
})
