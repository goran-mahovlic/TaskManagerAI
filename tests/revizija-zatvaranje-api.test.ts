/**
 * TASK-5327 (prijenos TASK-5204 i TASK-5164 B glavnog): e2e nad pravom pločom paketa.
 *
 *  - revizija blokiranih: klasa `blok:*` na PUT status=blocked (sjena / uživo), traka
 *    `GET /api/blokirani/revizija`, povijest `GET /api/tasks/:id/revizija`, prekidač
 *    `GET/PUT /api/config/revizija-blokiranih`, povrat `POST /reclaim {from:'blocked'}`;
 *  - zatvaranje kroz daemon: `completed` od bilo koga osim daemona (uloga + ključ) i čovjeka
 *    postaje zahtjev (202 + `ceka-kriticara`) uživo, a u sjeni se samo bilježi.
 *
 * Ključ zatvarača i dnevnici su u `TM_IZVORNI_PODACI` — ondje ih na čvoru drži daemon kompleta.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

const KLJUC = 'k'.repeat(16) + '0123456789abcdef0123456789abcdef'
let sjena: Posluzitelj | null = null
let uzivo: Posluzitelj | null = null
let podaciSjena = ''
let podaciUzivo = ''

beforeAll(async () => {
  podaciSjena = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-izv-s-'))
  podaciUzivo = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-izv-u-'))
  writeFileSync(join(podaciUzivo, 'zatvarac.token'), KLJUC + '\n', { mode: 0o600 })
  ;[sjena, uzivo] = await Promise.all([
    podigni({ revizijaBlokiranih: true, zatvaranjeKrozDaemon: true }, { TM_IZVORNI_PODACI: podaciSjena }),
    podigni({ revizijaBlokiranih: true, revizijaBlokiranihLive: true, zatvaranjeKrozDaemon: true, zatvaranjeKrozDaemonLive: true,
      povratKljucLive: true },
      { TM_IZVORNI_PODACI: podaciUzivo }),
  ])
}, 40_000)
afterAll(() => {
  spusti(sjena); spusti(uzivo)
  rmSync(podaciSjena, { recursive: true, force: true }); rmSync(podaciUzivo, { recursive: true, force: true })
})

const zovi = (p: Posluzitelj, put: string, method = 'GET', tijelo?: unknown, zaglavlja: Record<string, string> = {}) =>
  fetch(`${p.url}${put}`, {
    method, headers: { 'Content-Type': 'application/json', ...zaglavlja },
    ...(tijelo === undefined ? {} : { body: JSON.stringify(tijelo) }),
  })

async function novi(p: Posluzitelj, status: 'in_progress' | 'pending' = 'in_progress'): Promise<string> {
  const r = await zovi(p, '/api/tasks', 'POST', { title: 'isporuka', description: 'opis isporuke za reviziju', priority: 3, assignee: 'inzenjer' })
  const { id } = await r.json() as { id: string }
  if (status === 'in_progress') expect((await zovi(p, `/api/tasks/${id}`, 'PUT', { status: 'in_progress' })).status).toBe(200)
  return id
}
const dohvati = async (p: Posluzitelj, id: string) => await (await zovi(p, `/api/tasks/${id}`)).json() as any
const SAZETAK = 'Izmijenjen src/x.ts; bun test tests/x.test.ts → 3 pass, 0 fail.'

describe('revizija blokiranih — klasa na PUT status=blocked', () => {
  test('sjena: razlog sa strojnim kodom → blok:lanac; bez razloga prolazi s blok:nepoznato', async () => {
    const a = await novi(sjena!)
    expect((await zovi(sjena!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'LANAC: čeka TASK-1' })).status).toBe(200)
    expect((await dohvati(sjena!, a)).tags).toContain('blok:lanac')
    const b = await novi(sjena!)
    expect((await zovi(sjena!, `/api/tasks/${b}`, 'PUT', { status: 'blocked' })).status).toBe(200)
    expect((await dohvati(sjena!, b)).tags).toContain('blok:nepoznato')
  })

  test('uživo: bez razloga 400 s popisom klasa; COVJEK dobiva i waiting-for-human', async () => {
    const a = await novi(uzivo!)
    const r = await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'blocked' })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).klase).toContain('lanac')
    expect((await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'COVJEK: treba mjerenje' })).status).toBe(200)
    const t = await dohvati(uzivo!, a)
    expect(t.tags).toEqual(expect.arrayContaining(['blok:covjek', 'waiting-for-human']))
  })
})

describe('revizija blokiranih — rute ploče', () => {
  test('GET /api/blokirani/revizija: skupine iz presude, način i proračun', async () => {
    const a = await novi(sjena!)
    await zovi(sjena!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'ODLUKA: A ili B' })
    const d = await (await zovi(sjena!, '/api/blokirani/revizija')).json() as any
    expect(d.nacin).toBe('shadow')
    const z = d.zadaci.find((x: any) => x.id === a)
    expect(z).toMatchObject({ klasa: 'odluka', skupina: 'covjeku' })
    expect(Object.keys(d.skupine).sort()).toEqual(['covjeku', 'istroseno', 'ostalo', 'ponovno'])
    expect(d.proracun.maxRedrive).toBe(3)
  })

  test('GET /api/tasks/:id/revizija čita dnevnik izvornog daemona (TM_IZVORNI_PODACI)', async () => {
    writeFileSync(join(podaciSjena, 'revizija_blokiranih.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), taskId: 'TASK-77', presuda: 'ceka', razlog: 'čeka TASK-1', nacin: 'shadow' }) + '\n')
    const d = await (await zovi(sjena!, '/api/tasks/TASK-77/revizija')).json() as any
    expect(d.presude.map((p: any) => p.razlog)).toEqual(['čeka TASK-1'])
  })

  test('PUT /api/config/revizija-blokiranih: način i klase uživo s auditom; klasa uvijek-čovjeku 400', async () => {
    const r = await zovi(sjena!, '/api/config/revizija-blokiranih', 'PUT', { nacin: 'on', klaseUzivo: ['deploy'], by: 'vlasnik' })
    expect(r.status).toBe(200)
    const d = await r.json() as any
    expect(d.nacin).toBe('on')
    expect(d.klaseUzivo).toEqual(['deploy'])
    expect(d.povijest.map((h: any) => h.key)).toEqual(expect.arrayContaining(['revizija.nacin', 'revizija.klaseUzivo']))
    expect(JSON.parse(readFileSync(join(sjena!.dom, 'config', 'features.json'), 'utf-8')).revizijaBlokiranihLive.enabled).toBe(true)
    expect((await zovi(sjena!, '/api/config/revizija-blokiranih', 'PUT', { klaseUzivo: ['odluka'] })).status).toBe(400)
    // vrati sjenu za ostale testove ove ploče
    expect((await zovi(sjena!, '/api/config/revizija-blokiranih', 'PUT', { nacin: 'shadow', by: 'vlasnik' })).status).toBe(200)
    expect(((await (await zovi(sjena!, '/api/config/revizija-blokiranih')).json()) as any).nacin).toBe('shadow')
  })
})

describe('POST /api/tasks/:id/reclaim {from: blocked}', () => {
  test('čovjek s ploče pušta; oznake koje je dao sustav odlaze s blokadom', async () => {
    const a = await novi(uzivo!)
    await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'COVJEK: treba mjerenje' })
    const r = await zovi(uzivo!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'covjek', reason: 'Pusti sada (ploča)' })
    expect(r.status).toBe(200)
    const t = await r.json() as any
    expect(t.status).toBe('pending')
    expect(t.tags.filter((x: string) => x.startsWith('blok:') || x === 'waiting-for-human')).toEqual([])
  })

  test('agent ne smije sam sebe odblokirati (409); ručna ljudska oznaka drži blokadu (409 Human-gated)', async () => {
    const a = await novi(sjena!)
    await zovi(sjena!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'Spawn prekinut' })
    expect((await zovi(sjena!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'inzenjer', reason: 'sam' })).status).toBe(409)
    await zovi(sjena!, `/api/tasks/${a}`, 'PUT', { tags: [...(await dohvati(sjena!, a)).tags, 'waiting-for-human'] })
    const r = await zovi(sjena!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'revizija-blokiranih', reason: 'prolazno' })
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).error).toBe('Human-gated')
  })
})

describe('zatvaranje kroz daemon', () => {
  test('uživo: agentov completed → 202, ostaje in_progress s ceka-kriticara, zahtjev u dnevniku daemona', async () => {
    const a = await novi(uzivo!)
    const r = await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'completed', resultSummary: SAZETAK })
    expect(r.status).toBe(202)
    expect(((await r.json()) as any).stanje).toBe('ceka-kriticara')
    const t = await dohvati(uzivo!, a)
    expect(t.status).toBe('in_progress')
    expect(t.tags).toContain('ceka-kriticara')
    const redci = readFileSync(join(podaciUzivo, 'zatvaranje_zahtjevi.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(redci.find(x => x.taskId === a)).toMatchObject({ nacin: 'live' })
  })

  test('uživo: daemon s ispravnim ključem zatvara; krivi ključ = običan pozivatelj (202)', async () => {
    const a = await novi(uzivo!)
    const krivi = await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'completed', resultSummary: SAZETAK },
      { 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': 'x'.repeat(48) })
    expect(krivi.status).toBe(202)
    const ok = await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'completed', resultSummary: SAZETAK },
      { 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': KLJUC })
    expect(ok.status).toBe(200)
    expect((await dohvati(uzivo!, a)).status).toBe('completed')
  })

  test('uživo: čovjek s ploče zatvara izravno', async () => {
    const a = await novi(uzivo!)
    const r = await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'completed', resultSummary: SAZETAK }, { 'X-REGOC-Zatvara': 'covjek' })
    expect(r.status).toBe(200)
    expect((await dohvati(uzivo!, a)).status).toBe('completed')
  })

  test('sjena: PUT zatvara po starom, zahtjev se samo bilježi', async () => {
    const a = await novi(sjena!)
    expect((await zovi(sjena!, `/api/tasks/${a}`, 'PUT', { status: 'completed', resultSummary: SAZETAK })).status).toBe(200)
    expect((await dohvati(sjena!, a)).status).toBe('completed')
    const put = join(podaciSjena, 'zatvaranje_zahtjevi.jsonl')
    expect(existsSync(put)).toBe(true)
    expect(readFileSync(put, 'utf-8')).toContain(`"taskId":"${a}"`)
  })
})

// TASK-5334 (nalaz TASK-5329 N1/N3): uloge bez ključa — covjek za zatvaranje i `by` za povrat.
describe('uloge zatvaranja i povrata (TASK-5334)', () => {
  const redci = (put: string) => existsSync(put)
    ? readFileSync(put, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const uzmiNajam = (p: Posluzitelj, id: string) => {
    mkdirSync(p.najmovi, { recursive: true })
    writeFileSync(join(p.najmovi, `${id}.json`), JSON.stringify({ taskId: id, agent: 'inzenjer', pid: process.pid, startedAt: new Date().toISOString() }))
  }

  test('N1: covjek dok spawn radi (najam) → 202 zahtjev, ne zatvara', async () => {
    const a = await novi(uzivo!)
    uzmiNajam(uzivo!, a)
    const r = await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'completed', resultSummary: SAZETAK }, { 'X-REGOC-Zatvara': 'covjek' })
    expect(r.status).toBe(202)
    expect((await dohvati(uzivo!, a)).status).toBe('in_progress')
    expect(redci(join(podaciUzivo, 'zatvaranje_zahtjevi.jsonl')).find(x => x.taskId === a)).toMatchObject({ nacin: 'live', uloga: 'covjek' })
  })

  test('N1: covjek bez najma zatvara, ali se zatvaranje upisuje (nacin covjek)', async () => {
    const a = await novi(uzivo!)
    const r = await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'completed', resultSummary: SAZETAK }, { 'X-REGOC-Zatvara': 'covjek' })
    expect(r.status).toBe(200)
    expect(redci(join(podaciUzivo, 'zatvaranje_zahtjevi.jsonl')).find(x => x.taskId === a)).toMatchObject({ nacin: 'covjek' })
  })

  test('N3: povrat kao covjek s tuđe stranice (Origin) → 403, ostaje blocked', async () => {
    const a = await novi(uzivo!)
    await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'COVJEK: treba odluka vlasnika' })
    const r = await zovi(uzivo!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'covjek', reason: 'csrf' }, { Origin: 'https://zlo.example' })
    expect(r.status).toBe(403)
    const t = await dohvati(uzivo!, a)
    expect(t.status).toBe('blocked')
    expect(t.tags).toContain('waiting-for-human')
    // ista ploča (Origin = vlastiti host) i dalje pušta, i to se bilježi
    const ok = await zovi(uzivo!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'covjek', reason: 'Pusti sada (ploča)' }, { Origin: uzivo!.url })
    expect(ok.status).toBe(200)
    // strani Origin zaustavlja već opća CORS brana (TASK-5333, `[Security]` u konzoli) prije
    // rute, pa povrat_uloge vidi samo pušteni povrat — 'odbijeno' ostaje za zahtjev bez Origina
    expect(redci(join(podaciUzivo, 'povrat_uloge.jsonl')).filter(x => x.taskId === a).map(x => x.nacin)).toEqual(['covjek'])
  })

  test('N3 sjena: revizija-blokiranih bez ključa pušta, ali se bilježi', async () => {
    const a = await novi(sjena!)
    await zovi(sjena!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'LANAC: čeka TASK-1' })
    const r = await zovi(sjena!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'revizija-blokiranih', reason: 'prolazno' })
    expect(r.status).toBe(200)
    expect(redci(join(podaciSjena, 'povrat_uloge.jsonl')).find(x => x.taskId === a)).toMatchObject({ nacin: 'shadow', kljuc: false, by: 'revizija-blokiranih' })
  })

  test('N3 provedba: pozadina-gotova bez ključa → 403; s daemonovim ključem → 200', async () => {
    const a = await novi(uzivo!)
    await zovi(uzivo!, `/api/tasks/${a}`, 'PUT', { status: 'blocked', blockedReason: 'LANAC: čeka TASK-1' })
    const bez = await zovi(uzivo!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'pozadina-gotova', reason: 'x' })
    expect(bez.status).toBe(403)
    expect((await dohvati(uzivo!, a)).status).toBe('blocked')
    const s = await zovi(uzivo!, `/api/tasks/${a}/reclaim`, 'POST', { from: 'blocked', by: 'pozadina-gotova', reason: 'x' },
      { 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': KLJUC })
    expect(s.status).toBe(200)
    expect((await dohvati(uzivo!, a)).status).toBe('pending')
  })
})
