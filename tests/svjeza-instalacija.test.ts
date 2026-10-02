// Svježa instalacija TOČNO po docs/INSTALL.md: samo `HOME`, bez `TM_HOME` i `TM_DB`.
//
// Povod (TASK-5011, QA svježeg klona 02.10.2026.): `bash scripts/install.sh` na praznom
// stroju završavao je s „NIJE SE PODIGLO — SQLITE_CANTOPEN". `init-db` je bazu stvarao
// gdje dokumentacija kaže (`$HOME/.taskmanager/data/tasks.db`), a ploča je bez `TM_HOME`
// otvarala naslijeđenu putanju izvornog sustava — mapu koje na tuđem stroju nema. Svi
// dotadašnji e2e testovi postavljali su `TM_HOME` (tests/helpers/posluzitelj.ts), pa je
// put koji prolazi novi korisnik bio jedini neispitan.
//
// Drugi nalaz istog QA-a: `bun run init` nad postojećom bazom padao je s „table cost_log
// already exists", iako INSTALL.md §4 i §10 („Nadogradnja") obećavaju da je bezopasan.
import { describe, expect, test, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const KORIJEN = join(import.meta.dir, '..')
const domovi: string[] = []
afterAll(() => { for (const d of domovi) rmSync(d, { recursive: true, force: true }) })

/** Okolina novog korisnika: prazan HOME, nijedna TM_* varijabla. */
function okolinaNovogKorisnika(): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), 'tm-svjeza-'))
  domovi.push(home)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('TM_')) env[k] = v
  }
  // Pod-procesi nisu test: ploča se mora ponašati kao u pogonu.
  Object.assign(env, { HOME: home, NODE_ENV: 'production', BUN_TEST: '' })
  return { home, env }
}

function ispisi(env: Record<string, string>, kod: string): string {
  const r = Bun.spawnSync(['bun', '-e', kod], { cwd: KORIJEN, env })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString().trim()
}

describe('svježa instalacija bez TM_HOME (INSTALL.md §4–5)', () => {
  test('ploča, projekti i red poruka koriste $HOME/.taskmanager/data — isto mjesto koje stvara init', () => {
    const { home, env } = okolinaNovogKorisnika()
    const ocekivano = join(home, '.taskmanager', 'data')
    expect(ispisi(env, "import {DB_PATH} from './src/core/TaskManagerSQL'; console.log(DB_PATH)"))
      .toBe(join(ocekivano, 'tasks.db'))
    expect(ispisi(env, "import {TM_DB} from './src/core/paths'; console.log(TM_DB)"))
      .toBe(join(ocekivano, 'tasks.db'))
    // Nijedan modul ne smije tiho stvoriti mapu izvornog sustava u tuđem HOME-u.
    ispisi(env, "import './src/core/MessageQueue'; import './src/core/ProjectManager'")
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  test('bun run init dvaput zaredom: oba puta izlaz 0, podatci ostaju, broj objekata isti', () => {
    const { home, env } = okolinaNovogKorisnika()
    const prvi = Bun.spawnSync(['bun', 'scripts/init-db.ts'], { cwd: KORIJEN, env })
    expect(prvi.exitCode).toBe(0)
    const baza = join(home, '.taskmanager', 'data', 'tasks.db')
    const brojObjekata = () => {
      const db = new Database(baza, { readonly: true })
      const n = (db.query("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { n: number }).n
      db.close()
      return n
    }
    const prije = brojObjekata()
    const db = new Database(baza)
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('PRJ-777', 'ostaje', datetime('now'), datetime('now'))")
    db.close()

    const drugi = Bun.spawnSync(['bun', 'scripts/init-db.ts'], { cwd: KORIJEN, env })
    expect(drugi.stderr.toString()).not.toContain('already exists')
    expect(drugi.exitCode).toBe(0)
    expect(brojObjekata()).toBe(prije)
    const d2 = new Database(baza, { readonly: true })
    expect((d2.query("SELECT name FROM projects WHERE id = 'PRJ-777'").get() as { name: string }).name).toBe('ostaje')
    // P1 okidač i dalje postoji (nije izgubljen DROP-om bez ponovnog stvaranja).
    expect(d2.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='auto_queue_p1_tasks'").get()).toBeTruthy()
    d2.close()
  })

  test('init → ploča → POST zadatka → zadatak je u bazi koju je stvorio init', async () => {
    const { home, env } = okolinaNovogKorisnika()
    expect(Bun.spawnSync(['bun', 'scripts/init-db.ts'], { cwd: KORIJEN, env }).exitCode).toBe(0)
    const port = 20000 + Math.floor(Math.random() * 20000)
    const proc = Bun.spawn(['bun', 'src/TaskWebUI.ts'], {
      cwd: KORIJEN, env: { ...env, TM_PORT: String(port) }, stdout: 'ignore', stderr: 'pipe',
    })
    const url = `http://127.0.0.1:${port}`
    try {
      let zdrav = 0
      for (let i = 0; i < 100 && zdrav !== 200; i++) {
        try { zdrav = (await fetch(`${url}/health`)).status } catch { await Bun.sleep(100) }
      }
      expect(zdrav).toBe(200)
      const r = await fetch(`${url}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'prvi zadatak', description: 'svjeza instalacija', priority: 1, assignee: 'ana' }),
      })
      expect(r.status).toBe(201)
      const { id } = await r.json() as { id: string }
      const db = new Database(join(home, '.taskmanager', 'data', 'tasks.db'), { readonly: true })
      expect(db.query('SELECT id FROM tasks WHERE id = ?').get(id)).toBeTruthy()
      // P1 okidač: zadatak prioriteta 1 ulazi u red izvršavanja.
      expect(db.query('SELECT task_id FROM execution_queue WHERE task_id = ?').get(id)).toBeTruthy()
      db.close()
    } finally {
      proc.kill()
    }
  }, 30_000)
})

describe('LiveDbGuard čuva i zadanu bazu paketa', () => {
  test('test-proces ne smije otvoriti $HOME/.taskmanager/data/tasks.db stvarnog korisnika', async () => {
    const { realHomedir, assertNotLiveDbInTest } = await import('../src/core/LiveDbGuard')
    const zadana = join(realHomedir(), '.taskmanager', 'data', 'tasks.db')
    expect(() => assertNotLiveDbInTest(zadana, 'TaskManagerSQL')).toThrow('LiveDbGuard')
    // privremena baza i dalje prolazi
    expect(() => assertNotLiveDbInTest(join(tmpdir(), 'x', 'tasks.db'), 'TaskManagerSQL')).not.toThrow()
  })

  // TASK-5108: baza orkestratora na istom stroju više nije tvrdi raspored mapa u kodu —
  // zaštićuje se izričito, varijablom `TM_LIVE_DB` (popis odvojen dvotočkom).
  test('TM_LIVE_DB dodaje zaštićene baze; bez nje se tuđi raspored ne podrazumijeva', async () => {
    const { assertNotLiveDbInTest } = await import('../src/core/LiveDbGuard')
    const orkestrator = join(tmpdir(), 'orkestrator', 'live.db')
    const prije = process.env.TM_LIVE_DB
    try {
      delete process.env.TM_LIVE_DB
      expect(() => assertNotLiveDbInTest(orkestrator, 'TaskManagerSQL')).not.toThrow()
      process.env.TM_LIVE_DB = `/nema/druga.db:${orkestrator}`
      expect(() => assertNotLiveDbInTest(orkestrator, 'TaskManagerSQL')).toThrow('LiveDbGuard')
    } finally {
      if (prije === undefined) delete process.env.TM_LIVE_DB
      else process.env.TM_LIVE_DB = prije
    }
  })
})
