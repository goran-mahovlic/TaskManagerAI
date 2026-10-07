/**
 * Nalaz TASK-5329 N4 (HIGH): /api/files/download je služio SVAKU običnu datoteku pod
 * $HOME (ključ zatvarača, ~/.claude/.credentials.json, ~/.ssh), a CORS je odražavao bilo
 * koji Origin uz Allow-Credentials — tuđa stranica u pregledniku vlasnika mogla je čitati
 * odgovore i slati PUT/POST.
 *
 * Ugovor popravka:
 *   1. preuzimanje samo iz popisa dopuštenih korijena (zadano `$HOME/app`, projekti i
 *      isporuke u `app/tmp`), nikad datoteka izravno u korijenu, nijedan dio puta koji
 *      počinje točkom, nijedno ime koje izgleda kao tajna; realpath PRIJE provjere
 *      prefiksa, pa simlink van korijena ne prolazi;
 *   2. CORS: Origin se vraća samo ako je vlastiti (= Host zahtjeva ili izričito s portom
 *      u ALLOWED_HOSTS); PUT/POST/DELETE sa stranim Originom odbija se s 403.
 *
 * Autorica: Jelena (Engineer), TASK-5333.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { korijeniPreuzimanja, rijesiPreuzimanje, corsOdluka } from '../src/core/PristupDatotekama'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tm-5333-'))
  const dat = (rel: string, s = 'x') => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), s) }
  dat('app/tmp/TASK-1/izvjestaj.md', 'isporuka')
  dat('app/projekt/docs/plan.pdf', 'plan')
  dat('app/projekt/.env', 'TAJNA=1')
  dat('app/projekt/.git/config', 'x')
  dat('app/.regoc-worktrees/w/a.txt', 'x')
  dat('app/server.key', 'kljuc')
  dat('app/kljucevi/id.txt', 'x')
  dat('app/projekt/certs/tls.pem', 'x')
  dat('app/projekt/zatvarac.token', 'x')
  dat('.claude/.credentials.json', '{"t":1}')
  dat('.ssh/id_ed25519', 'priv')
  dat('drugo/biljeska.txt', 'x')
  symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'app', 'projekt', 'docs', 'link.txt'))
  symlinkSync(join(home, '.claude'), join(home, 'app', 'projekt', 'cl'))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('korijeniPreuzimanja', () => {
  test('zadano je samo $HOME/app', () => {
    expect(korijeniPreuzimanja({ HOME: home })).toEqual([join(home, 'app')])
  })
  test('TM_DOWNLOAD_DIRS zamjenjuje zadano, ~ se širi, relativni unosi se bacaju', () => {
    expect(korijeniPreuzimanja({ HOME: home, TM_DOWNLOAD_DIRS: '~/drugo, relativno ,/srv/isporuke' }))
      .toEqual([join(home, 'drugo'), '/srv/isporuke'])
  })
})

describe('rijesiPreuzimanje — dopušteno', () => {
  const env = () => ({ HOME: home })
  test('isporuka u app/tmp prolazi (i kao ~/ i kao apsolutna)', () => {
    const r1 = rijesiPreuzimanje('~/app/tmp/TASK-1/izvjestaj.md', env())
    const r2 = rijesiPreuzimanje(join(home, 'app/projekt/docs/plan.pdf'), env())
    expect(r1).toEqual({ ok: true, putanja: join(home, 'app/tmp/TASK-1/izvjestaj.md'), ime: 'izvjestaj.md' })
    expect(r2.ok).toBe(true)
  })
})

describe('rijesiPreuzimanje — odbijeno (nalaz N4)', () => {
  const env = () => ({ HOME: home })
  const status = (p: string) => { const r = rijesiPreuzimanje(p, env()); return r.ok ? 200 : r.status }
  test.each([
    ['~/.claude/.credentials.json'],
    ['~/.ssh/id_ed25519'],
    ['~/drugo/biljeska.txt'],
    ['~/app/projekt/.env'],
    ['~/app/projekt/.git/config'],
    ['~/app/.regoc-worktrees/w/a.txt'],
    ['~/app/server.key'],
    ['~/app/kljucevi/id.txt'],
    ['~/app/projekt/certs/tls.pem'],
    ['~/app/projekt/zatvarac.token'],
    ['~/app/projekt/docs/link.txt'],
    ['~/app/projekt/cl/.credentials.json'],
    ['~/app/tmp/../../.ssh/id_ed25519'],
    ['/etc/passwd'],
    ['app/tmp/TASK-1/izvjestaj.md'],
  ])('%s → 403', (p) => { expect(status(p)).toBe(403) })
  test('nepostojeća datoteka u dopuštenom korijenu → 404, mapa → 404', () => {
    expect(status('~/app/tmp/nema.txt')).toBe(404)
    expect(status('~/app/projekt/docs')).toBe(404)
  })
  test('prazna putanja → 400', () => { expect(status('  ')).toBe(400) })
})

describe('corsOdluka', () => {
  const dopusteni = ['localhost', 'localhost:17781', 'dell:17781']
  test('bez Origina: nema CORS zaglavlja, mutacija dopuštena (curl/agenti)', () => {
    expect(corsOdluka({ origin: null, host: 'localhost:17781', metoda: 'POST', dopusteni }))
      .toEqual({ dopusti: true, zaglavlja: {} })
  })
  test('vlastiti Origin (= Host) se odražava uz credentials', () => {
    const o = corsOdluka({ origin: 'http://localhost:17781', host: 'localhost:17781', metoda: 'PUT', dopusteni })
    expect(o.dopusti).toBe(true)
    expect(o.zaglavlja['Access-Control-Allow-Origin']).toBe('http://localhost:17781')
    expect(o.zaglavlja['Vary']).toBe('Origin')
  })
  test('Origin iz ALLOWED_HOSTS s portom prolazi i kad Host nije isti', () => {
    expect(corsOdluka({ origin: 'http://dell:17781', host: 'localhost:17781', metoda: 'GET', dopusteni }).zaglavlja['Access-Control-Allow-Origin']).toBe('http://dell:17781')
  })
  test('strani Origin: GET bez ACAO, PUT/POST/DELETE → odbij', () => {
    const g = corsOdluka({ origin: 'https://zlo.example', host: 'localhost:17781', metoda: 'GET', dopusteni })
    expect(g.dopusti).toBe(true)
    expect(g.zaglavlja['Access-Control-Allow-Origin']).toBeUndefined()
    for (const metoda of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(corsOdluka({ origin: 'https://zlo.example', host: 'localhost:17781', metoda, dopusteni }).dopusti).toBe(false)
    }
  })
  test('drugi port na istom imenu nije vlastiti; Origin "null" nije vlastiti', () => {
    expect(corsOdluka({ origin: 'http://localhost:8080', host: 'localhost:17781', metoda: 'POST', dopusteni }).dopusti).toBe(false)
    expect(corsOdluka({ origin: 'null', host: 'localhost:17781', metoda: 'POST', dopusteni }).dopusti).toBe(false)
  })
})

// Ožičenje u pravom poslužitelju ploče (ne samo modul).
describe('HTTP — živa ploča', () => {
  let p: Posluzitelj | null = null
  beforeAll(async () => { p = await podigni({}, { HOME: home, TM_DOWNLOAD_DIRS: '' }) }, 20000)
  afterAll(() => spusti(p))
  const dl = (path: string) => fetch(`${p!.url}/api/files/download?path=${encodeURIComponent(path)}`)

  test('isporuka 200 sa sadržajem, vjerodajnice 403', async () => {
    const ok = await dl('~/app/tmp/TASK-1/izvjestaj.md')
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('isporuka')
    expect((await dl('~/.claude/.credentials.json')).status).toBe(403)
    expect((await dl('~/.ssh/id_ed25519')).status).toBe(403)
  })
  test('strani Origin: nema odraza, POST odbijen 403', async () => {
    const g = await fetch(`${p!.url}/api/tasks`, { method: 'OPTIONS', headers: { Origin: 'https://zlo.example' } })
    expect(g.headers.get('access-control-allow-origin')).toBeNull()
    expect(g.headers.get('access-control-allow-credentials')).toBeNull()
    const r = await fetch(`${p!.url}/api/tasks`, {
      method: 'POST', headers: { Origin: 'https://zlo.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', description: 'y' }),
    })
    expect(r.status).toBe(403)
  })
  test('vlastiti Origin se odražava', async () => {
    const g = await fetch(`${p!.url}/api/tasks`, { method: 'OPTIONS', headers: { Origin: p!.url } })
    expect(g.headers.get('access-control-allow-origin')).toBe(p!.url)
  })
})
