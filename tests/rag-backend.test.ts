/**
 * RAG s dva pozadinska sustava (GAP F13 / J9) — bez mreže.
 *
 * Što se dokazuje:
 *   (a) prazna konfiguracija → `pgvector.configured: false`, ništa ne baca, nema mrežnog poziva;
 *   (b) lozinka se nikad ne vraća (status, config, JSON adaptera), ni iz okoline ni iz datoteke tajni;
 *   (c) modul se uvozi i radi kad `pg` nije razrješiv, a `bun build` prolazi bez `pg`;
 *   (d) zapis + čitanje konfiguracije preko `TM_RAG_BACKEND_CONFIG`;
 *   (e) obrane: neispravne vrijednosti, lozinka u zakrpi, spremljena tajna samo za spremljeni
 *       poslužitelj, prekinuta migracija.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { RAGBackendService, getRAGBackendService } from '../src/RAGBackendService'
import { PgVectorAdapter, pgInstaliran, postaviPgModulZaTest, PG_NIJE_INSTALIRAN } from '../src/rag/adapters/pgvector-adapter'
import { imenaKolekcija } from '../src/rag/adapters/chroma-adapter'
import { spremiRagBackendKonfig, ucitajRagBackendKonfig } from '../src/rag/rag-backend-config'
import { loadBackendConfig, getRagBackend, resetBackends } from '../src/rag/rag-backend-factory'
import { resetirajPrigusenje } from '../src/core/ProbeGuard'

const KORIJEN = join(import.meta.dir, '..')
const TAJNA = 'tajna-Xq7-nikad-u-odgovoru'
const DIRAMO = [
  'TM_RAG_BACKEND_CONFIG', 'TM_CREDENTIALS', 'TM_RAG_MIGRATION_STATUS', 'TM_RAG_BACKEND',
  'TM_CHROMA_HOST', 'TM_CHROMA_PORT', 'TM_PGVECTOR_HOST', 'TM_PGVECTOR_PORT',
  'TM_PGVECTOR_DATABASE', 'TM_PGVECTOR_USER', 'TM_PGVECTOR_PASSWORD',
]

let dom: string
let staro: Record<string, string | undefined> = {}
const svi: string[] = []

beforeEach(() => {
  dom = mkdtempSync(join(tmpdir(), 'tm-rag-backend-'))
  svi.push(dom)
  staro = {}
  for (const k of DIRAMO) { staro[k] = process.env[k]; delete process.env[k] }
  process.env.TM_RAG_BACKEND_CONFIG = join(dom, 'config', 'rag-backend.json')
  process.env.TM_CREDENTIALS = join(dom, 'config', 'credentials.env') // ne postoji → nema tajne
  process.env.TM_RAG_MIGRATION_STATUS = join(dom, 'data', 'rag-migration-status.json')
  postaviPgModulZaTest('pg')
  resetirajPrigusenje()
})

afterEach(async () => {
  await resetBackends()
  for (const k of DIRAMO) {
    if (staro[k] === undefined) delete process.env[k]
    else process.env[k] = staro[k]
  }
  postaviPgModulZaTest('pg')
})

afterAll(() => { for (const d of svi) rmSync(d, { recursive: true, force: true }) })

/** Podešen pgvector koji NE vodi nikamo: lokalni port 1 (odbijanje je trenutačno). */
function podesiPg(): void {
  const r = spremiRagBackendKonfig({ pgvector: { host: '127.0.0.1', port: 1, database: 'vektori', user: 'citac' } })
  expect(r.ok).toBe(true)
}

describe('(a) prazna konfiguracija', () => {
  test('getStatus ne baca; pgvector i chromadb nisu podešeni', async () => {
    const s = await getRAGBackendService().getStatus()
    expect(s.currentBackend).toBe('chromadb')
    expect(s.pgvector.configured).toBe(false)
    expect(s.pgvector.available).toBe(false)
    expect(s.pgvector.connected).toBe(false)
    expect(s.pgvector.host).toBe('')
    expect(s.pgvector.port).toBeNull()
    expect(s.pgvector.passwordSet).toBe(false)
    expect(s.chromadb.configured).toBe(false)
    expect(s.chromadb.connected).toBe(false)
    expect(s.chromadb.host).toBe('')
  })

  test('getConfig s praznom konfiguracijom', () => {
    const c = getRAGBackendService().getConfig()
    expect(c.backend).toBe('chromadb')
    expect(c.pgvector).toMatchObject({ configured: false, host: '', database: '', user: '', passwordSet: false })
  })

  test('singleton', () => {
    expect(getRAGBackendService()).toBe(getRAGBackendService())
  })

  test('tvornica bez podešenog backenda daje jasnu grešku, ne poziv na prazan domaćin', async () => {
    await expect(getRagBackend(true)).rejects.toThrow(/nije podešen/)
    process.env.TM_RAG_BACKEND = 'pgvector'
    await expect(getRagBackend(true)).rejects.toThrow(/nije podešen/)
  })
})

describe('(b) lozinka nikad u odgovoru', () => {
  test('iz okoline: status, config i tvornička konfiguracija je ne sadrže', async () => {
    podesiPg()
    process.env.TM_PGVECTOR_PASSWORD = TAJNA
    const svc = new RAGBackendService()
    const s = await svc.getStatus()
    const c = svc.getConfig()
    expect(s.pgvector.configured).toBe(true)
    expect(s.pgvector.passwordSet).toBe(true)
    expect(c.pgvector.passwordSet).toBe(true)
    expect(JSON.stringify(s)).not.toContain(TAJNA)
    expect(JSON.stringify(c)).not.toContain(TAJNA)
    expect(JSON.stringify(ucitajRagBackendKonfig())).not.toContain(TAJNA)
    expect(JSON.stringify(loadBackendConfig())).not.toContain(TAJNA)
    expect(readFileSync(process.env.TM_RAG_BACKEND_CONFIG!, 'utf-8')).not.toContain(TAJNA)
  })

  test('iz datoteke tajni (credentials.env)', async () => {
    podesiPg()
    writeFileSync(process.env.TM_CREDENTIALS!, `# tajne\nTM_PGVECTOR_PASSWORD=${TAJNA}\n`, { mode: 0o600 })
    const svc = new RAGBackendService()
    const s = await svc.getStatus()
    expect(s.pgvector.passwordSet).toBe(true)
    expect(JSON.stringify(s)).not.toContain(TAJNA)
    expect(JSON.stringify(svc.getConfig())).not.toContain(TAJNA)
  })

  test('JSON.stringify adaptera ne otkriva lozinku', () => {
    const a = new PgVectorAdapter({ host: '127.0.0.1', port: 1, database: 'v', user: 'u', password: TAJNA })
    const j = JSON.stringify(a)
    expect(j).not.toContain(TAJNA)
    expect(j).toContain('"database":"v"')
  })

  test('lozinka u zakrpi konfiguracije se odbija', () => {
    const r = spremiRagBackendKonfig({ pgvector: { host: 'db', port: 5432, database: 'v', user: 'u', password: TAJNA } as any })
    expect(r.ok).toBe(false)
    expect(existsSync(process.env.TM_RAG_BACKEND_CONFIG!)).toBe(false)
  })
})

describe('(c) bez paketa pg', () => {
  test('modul radi kad pg nije razrješiv', async () => {
    postaviPgModulZaTest('pg-ovaj-paket-ne-postoji-' + Date.now())
    expect(await pgInstaliran()).toBe(false)

    podesiPg()
    process.env.TM_PGVECTOR_PASSWORD = TAJNA
    const svc = new RAGBackendService()
    const s = await svc.getStatus()
    expect(s.pgvector.driverInstalled).toBe(false)
    expect(s.pgvector.available).toBe(false)
    expect(s.pgvector.error).toBe(PG_NIJE_INSTALIRAN)

    const t = await svc.testPgVectorConnection({ host: '127.0.0.1', port: 1, database: 'vektori', user: 'citac', password: 'x' })
    expect(t.connected).toBe(false)
    expect(t.error).toBe(PG_NIJE_INSTALIRAN)

    const a = new PgVectorAdapter({ host: '127.0.0.1', port: 1, database: 'v', user: 'u', password: 'x' })
    const h = await a.healthCheck()
    expect(h.connected).toBe(false)
    expect(h.error).toBe(PG_NIJE_INSTALIRAN)
    await a.close()
  })

  test('bun build servisa prolazi i ne traži pg', () => {
    const izlaz = join(dom, 'build')
    const r = Bun.spawnSync(['bun', 'build', 'src/RAGBackendService.ts', '--target=bun', `--outdir=${izlaz}`], { cwd: KORIJEN })
    expect(r.exitCode).toBe(0)
    expect(r.stderr.toString()).not.toContain('Could not resolve')
  })
})

describe('(d) zapis i čitanje konfiguracije', () => {
  test('savePgVectorConfig → getConfig (preko TM_RAG_BACKEND_CONFIG)', async () => {
    const svc = new RAGBackendService()
    const r = await svc.savePgVectorConfig({ host: 'baza.example', port: 5433, database: 'vektori', user: 'citac' })
    expect(r).toEqual({ success: true })
    const c = svc.getConfig()
    expect(c.pgvector).toMatchObject({ configured: true, host: 'baza.example', port: 5433, database: 'vektori', user: 'citac' })

    const naDisku = JSON.parse(readFileSync(process.env.TM_RAG_BACKEND_CONFIG!, 'utf-8'))
    expect(naDisku.pgvector).toMatchObject({ host: 'baza.example', port: 5433, database: 'vektori', user: 'citac' })
    expect(JSON.stringify(naDisku)).not.toContain('password')

    // setBackend('chromadb') ne traži pgvector i čuva pgvector postavke
    expect(await svc.setBackend('chromadb')).toEqual({ success: true })
    expect(svc.getConfig().pgvector.host).toBe('baza.example')
  })

  test('okolina ima prednost pred datotekom', () => {
    podesiPg()
    process.env.TM_PGVECTOR_HOST = 'drugi.example'
    process.env.TM_CHROMA_HOST = 'http://chroma.example:9000'
    process.env.TM_CHROMA_PORT = '9000'
    const p = ucitajRagBackendKonfig()
    expect(p.pgvector.host).toBe('drugi.example')
    expect(p.chroma).toEqual({ configured: true, host: 'chroma.example', port: 9000 })
  })

  test('neispravan JSON → kao da datoteke nema', async () => {
    const put = process.env.TM_RAG_BACKEND_CONFIG!
    spremiRagBackendKonfig({ backend: 'chromadb' })
    writeFileSync(put, '{ ovo nije json')
    const s = await new RAGBackendService().getStatus()
    expect(s.pgvector.configured).toBe(false)
  })
})

describe('(e) obrane', () => {
  test('neispravne vrijednosti se ne spremaju', async () => {
    const svc = new RAGBackendService()
    for (const host of ['http://db', 'a b', 'korisnik@db', 'db/putanja', '']) {
      const r = await svc.savePgVectorConfig({ host, port: 5432, database: 'v', user: 'u' })
      expect(r.success).toBe(false)
    }
    expect((await svc.savePgVectorConfig({ host: 'db', port: 70000, database: 'v', user: 'u' })).success).toBe(false)
    expect((await svc.savePgVectorConfig({ host: 'db', port: 5432, database: 'v"; drop', user: 'u' })).success).toBe(false)
    expect(existsSync(process.env.TM_RAG_BACKEND_CONFIG!)).toBe(false)
  })

  test('setBackend: nepoznat i nepodešen backend se odbija', async () => {
    const svc = new RAGBackendService()
    expect((await svc.setBackend('mongo' as any)).success).toBe(false)
    const r = await svc.setBackend('pgvector')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/nije podešen/)
    expect(svc.getConfig().backend).toBe('chromadb')
  })

  test('spremljena lozinka ide SAMO na spremljeni poslužitelj', async () => {
    podesiPg()
    process.env.TM_PGVECTOR_PASSWORD = TAJNA
    const svc = new RAGBackendService()
    const r = await svc.testPgVectorConnection({ host: 'napadac.example', port: 5432, database: 'vektori', user: 'citac' })
    expect(r.connected).toBe(false)
    expect(r.error).toMatch(/upiši lozinku/)
  })

  test('test konekcije: shema u domaćinu i prigušenje', async () => {
    const svc = new RAGBackendService()
    const a = await svc.testPgVectorConnection({ host: 'http://x', port: 5432, database: 'v', user: 'u', password: 'p' })
    expect(a.connected).toBe(false)
    postaviPgModulZaTest('pg-ovaj-paket-ne-postoji')
    await svc.testPgVectorConnection({ host: '127.0.0.1', port: 1, database: 'v', user: 'u', password: 'p' })
    const b = await svc.testPgVectorConnection({ host: '127.0.0.1', port: 1, database: 'v', user: 'u', password: 'p' })
    expect(b.error).toMatch(/pričekaj/)
  })

  test('privatne mreže se mogu zabraniti u konfiguraciji', async () => {
    spremiRagBackendKonfig({ backend: 'chromadb' })
    const put = process.env.TM_RAG_BACKEND_CONFIG!
    writeFileSync(put, JSON.stringify({ dopustiPrivatneMreze: false }))
    const r = await new RAGBackendService().testPgVectorConnection({ host: '10.0.0.5', port: 5432, database: 'v', user: 'u', password: 'p' })
    expect(r.connected).toBe(false)
    expect(r.error).toMatch(/privatnoj mreži/)
  })

  test('migracija: neispravno ime i nepodešen backend', async () => {
    const svc = new RAGBackendService()
    expect((await svc.startMigration('../etc')).started).toBe(false)
    const r = await svc.startMigration('zbirka_1')
    expect(r.started).toBe(false)
    expect(r.error).toMatch(/nije podešen/)
  })

  test('migracija: zapis „u tijeku" bez žive migracije = prekinuta', () => {
    const put = process.env.TM_RAG_MIGRATION_STATUS!
    mkdirSync(join(dom, 'data'), { recursive: true })
    writeFileSync(put, JSON.stringify({ inProgress: true, collection: 'z', completedCollections: [], totalMigrated: 3, totalFailed: 0 }))
    const s = new RAGBackendService().getMigrationStatus()
    expect(s.inProgress).toBe(false)
    expect(s.totalMigrated).toBe(3)
    expect(s.error).toMatch(/prekinuta/)
  })

  test('prazan status migracije', () => {
    expect(new RAGBackendService().getMigrationStatus()).toEqual({
      inProgress: false, completedCollections: [], totalMigrated: 0, totalFailed: 0,
    })
  })

  test('imena kolekcija neovisno o inačici chromadb klijenta', () => {
    expect(imenaKolekcija(['a', 'b'])).toEqual(['a', 'b'])
    expect(imenaKolekcija([{ name: 'a' }, { name: 'b' }, {}])).toEqual(['a', 'b'])
  })
})
