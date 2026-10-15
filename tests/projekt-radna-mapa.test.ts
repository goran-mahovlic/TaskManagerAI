/**
 * Radna mapa projekta (`projects.root_path`): mapa na disku u kojoj agent radi zadatke tog
 * projekta. Ploča provjerava da mapa POSTOJI pri spremanju (korisnik odmah vidi grešku),
 * orkestrator je prosljeđuje izvođaču kao `cwd` (v. tests/orchestrator.test.ts).
 *
 * Putanje u testovima su privremene mape iz tmpdir-a ili sastavljeni izmišljeni nizovi —
 * nikad stvarne putanje s nečijeg stroja (brana tests/bez-nasih-vrijednosti.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createEmptyTaskDb } from './helpers/db-fixture'
import { CreateProjectInputSchema, UpdateProjectInputSchema } from '../src/zod/schemas/project'
import { ProjectManager, radnaMapaGreska, osigurajKolonuRadneMape } from '../src/core/ProjectManager'

const SHEMA = new URL('../db/schema.sql', import.meta.url).pathname
const IZMISLJENA = ['', 'srv', 'projekti', 'alfa'].join('/')

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tm-radna-mapa-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* nema veze */ } })

describe('shema: root_path je neobavezna apsolutna putanja', () => {
  test('apsolutna putanja prolazi i ostaje netaknuta', () => {
    const r = CreateProjectInputSchema.safeParse({ name: 'A', root_path: IZMISLJENA })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.root_path).toBe(IZMISLJENA)
  })

  test('relativna putanja se odbija', () => {
    expect(CreateProjectInputSchema.safeParse({ name: 'A', root_path: 'projekti/alfa' }).success).toBe(false)
  })

  test('putanja s `..` se odbija', () => {
    expect(CreateProjectInputSchema.safeParse({ name: 'A', root_path: IZMISLJENA + '/../beta' }).success).toBe(false)
  })

  test('bez polja: root_path je undefined (ne dira se)', () => {
    const r = CreateProjectInputSchema.safeParse({ name: 'A' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.root_path).toBeUndefined()
  })

  test('prazan niz i null pri izmjeni znače „obriši mapu" (null)', () => {
    for (const v of ['', '   ', null]) {
      const r = UpdateProjectInputSchema.safeParse({ root_path: v })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.root_path).toBeNull()
    }
  })

  test('razmaci oko putanje se režu', () => {
    const r = CreateProjectInputSchema.safeParse({ name: 'A', root_path: `  ${IZMISLJENA}  ` })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.root_path).toBe(IZMISLJENA)
  })
})

describe('radnaMapaGreska: ploča odbija mapu koje nema', () => {
  test('postojeća mapa: nema greške', () => {
    expect(radnaMapaGreska(dir)).toBeNull()
  })

  test('nepostojeća mapa: poruka imenuje putanju', () => {
    const nema = join(dir, 'nema')
    const g = radnaMapaGreska(nema)
    expect(g).not.toBeNull()
    expect(g!).toContain(nema)
  })

  test('datoteka umjesto mape: greška', () => {
    const dat = join(dir, 'datoteka.txt')
    writeFileSync(dat, 'x')
    expect(radnaMapaGreska(dat)).not.toBeNull()
  })

  test('null/undefined (mapa se ne postavlja): nema greške', () => {
    expect(radnaMapaGreska(null)).toBeNull()
    expect(radnaMapaGreska(undefined)).toBeNull()
  })
})

describe('ProjectManager: root_path se sprema, čita i briše', () => {
  test('create → get → list nose root_path', () => {
    const pm = new ProjectManager(createEmptyTaskDb(join(dir, 't.db')))
    const p = pm.createProject({ name: 'Alfa', priority: 3, root_path: IZMISLJENA })
    expect(p.root_path).toBe(IZMISLJENA)
    expect(pm.getProject(p.id)!.root_path).toBe(IZMISLJENA)
    expect(pm.getProjects().find(x => x.id === p.id)!.root_path).toBe(IZMISLJENA)
  })

  test('projekt bez mape ima root_path null', () => {
    const pm = new ProjectManager(createEmptyTaskDb(join(dir, 't.db')))
    const p = pm.createProject({ name: 'Beta', priority: 3 })
    expect(pm.getProject(p.id)!.root_path).toBeNull()
  })

  test('update postavlja, update s null briše', () => {
    const pm = new ProjectManager(createEmptyTaskDb(join(dir, 't.db')))
    const p = pm.createProject({ name: 'Gama', priority: 3 })
    expect(pm.updateProject(p.id, { root_path: IZMISLJENA })!.root_path).toBe(IZMISLJENA)
    expect(pm.updateProject(p.id, { name: 'Gama 2' })!.root_path).toBe(IZMISLJENA) // ne dira se
    expect(pm.updateProject(p.id, { root_path: null })!.root_path).toBeNull()
  })
})

describe('migracija: starija baza bez stupca root_path', () => {
  function starijaBaza(putanja: string): string {
    // Ista shema, samo bez novog stupca i bez njega u pogledu — kakvu zatiče postojeća instalacija.
    const sql = readFileSync(SHEMA, 'utf-8')
      .replace(/,?\s*root_path TEXT/g, '')
      .replace(/\s*p\.root_path,/g, '')
    expect(sql).not.toContain('root_path')
    const db = new Database(putanja)
    db.exec(sql)
    db.close()
    return putanja
  }

  test('ProjectManager sam dodaje stupac i obnavlja pogled', () => {
    const pm = new ProjectManager(starijaBaza(join(dir, 'stara.db')))
    const p = pm.createProject({ name: 'Delta', priority: 3, root_path: IZMISLJENA })
    expect(pm.getProjects().find(x => x.id === p.id)!.root_path).toBe(IZMISLJENA)
  })

  test('osigurajKolonuRadneMape je idempotentna i ne ruši se na novoj bazi', () => {
    const db = new Database(createEmptyTaskDb(join(dir, 'nova.db')))
    expect(osigurajKolonuRadneMape(db)).toBe(false) // stupac već postoji
    db.close()
    const stara = new Database(starijaBaza(join(dir, 'stara.db')))
    expect(osigurajKolonuRadneMape(stara)).toBe(true)
    expect(osigurajKolonuRadneMape(stara)).toBe(false)
    const stupci = stara.query("SELECT name FROM pragma_table_info('projects')").all() as { name: string }[]
    expect(stupci.map(s => s.name)).toContain('root_path')
    stara.close()
  })

  test('init-db nad starijom bazom prolazi (ALTER prije ponovne sheme)', () => {
    const putanja = starijaBaza(join(dir, 'stara.db'))
    const r = Bun.spawnSync(['bun', 'scripts/init-db.ts'], {
      env: { ...process.env, TM_DB: putanja, TM_HOME: dir },
      cwd: new URL('..', import.meta.url).pathname,
    })
    expect(r.exitCode).toBe(0)
    const db = new Database(putanja)
    const red = db.query('SELECT sql FROM sqlite_master WHERE name = ?').get('v_projects_summary') as { sql: string }
    expect(red.sql).toContain('root_path')
    db.close()
  })
})
