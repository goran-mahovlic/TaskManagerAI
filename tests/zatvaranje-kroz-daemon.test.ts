/**
 * TASK-5164 / DIZAJN-nesukladnosti-BCD §2 (B) — zatvaranje je ZAHTJEV, provodi ga daemon.
 *
 * Jedinični dio: matrica pozivatelja (§2.2 B2), token zatvarača (B1) i daemonova petlja
 * zahtjeva (B3) s ubrizganim kritičarem. E2E nad pločom paketa je u `revizija-zatvaranje-api.test.ts`.
 * Prijenos s glavnog u paket: TASK-5327 (+ putanja ključa iz `TM_IZVORNI_PODACI`).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  osigurajToken, procitajToken, pozivateljZatvaranja, odlukaZatvaranja, tijelo202,
  obradiZahtjeveZatvaranja, obradiSjenuZatvaranja, zaglavljaZatvaraca, OZNAKA_CEKA,
  presudaZahtjeva, type ZahtjevZadatak,
  putTokena, putZahtjeva, zapisiZahtjev,
} from '../src/core/ZatvaranjeKrozDaemon'

const TMP = process.env.TMPDIR || tmpdir()
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(TMP, 'zkd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const zag = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? h[k.toLowerCase()] ?? null })

describe('B1 — token zatvarača', () => {
  test('nastaje jednom, perms 600, drugi poziv vraća isti', () => {
    const p = join(dir, 'zatvarac.token')
    const a = osigurajToken(p)
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(osigurajToken(p)).toBe(a)
    expect(procitajToken(p)).toBe(a)
  })
  test('nema datoteke → procitajToken null (ne stvara je)', () => {
    expect(procitajToken(join(dir, 'nema'))).toBeNull()
  })
  test('zaglavlja zatvarača nose ulogu i token', () => {
    const p = join(dir, 't')
    const h = zaglavljaZatvaraca(p)
    expect(h['X-REGOC-Zatvara']).toBe('daemon')
    expect(h['X-REGOC-Zatvarac']).toBe(procitajToken(p)!)
  })
})

describe('B2 — tko zove', () => {
  test('daemon s ispravnim tokenom', () => {
    expect(pozivateljZatvaranja(zag({ 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': 'abc' }), 'abc')).toBe('daemon')
  })
  test('daemon s krivim tokenom ili bez tokena na disku = ostali', () => {
    expect(pozivateljZatvaranja(zag({ 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': 'x' }), 'abc')).toBe('ostali')
    expect(pozivateljZatvaranja(zag({ 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': 'x' }), null)).toBe('ostali')
  })
  test('čovjek s ploče', () => {
    expect(pozivateljZatvaranja(zag({ 'X-REGOC-Zatvara': 'covjek' }), 'abc')).toBe('covjek')
  })
  test('bez zaglavlja i orkestrator = ostali', () => {
    expect(pozivateljZatvaranja(zag({}), 'abc')).toBe('ostali')
    expect(pozivateljZatvaranja(zag({ 'X-REGOC-Zatvara': 'orkestrator' }), 'abc')).toBe('ostali')
  })
})

describe('B2 — odluka', () => {
  const baza = { status: 'completed', trenutni: 'in_progress', ukljuceno: true, live: true }
  test('ostali + completed + live → zahtjev, provodi se', () => {
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'ostali' })).toEqual({ zahtjev: true, provedi: true })
  })
  test('sjena: zahtjev se bilježi, ne provodi', () => {
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'ostali', live: false })).toEqual({ zahtjev: true, provedi: false })
  })
  test('daemon i čovjek prolaze', () => {
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'daemon' }).zahtjev).toBe(false)
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'covjek' }).zahtjev).toBe(false)
  })
  test('blocked i cancelled se ne diraju (blokiranje sebe nije lažni ✅)', () => {
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'ostali', status: 'blocked' }).zahtjev).toBe(false)
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'ostali', status: 'cancelled' }).zahtjev).toBe(false)
  })
  test('zadatak koji nije in_progress ide starim putem (409 ostaje 409)', () => {
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'ostali', trenutni: 'pending' }).zahtjev).toBe(false)
  })
  test('isključeno → ništa', () => {
    expect(odlukaZatvaranja({ ...baza, pozivatelj: 'ostali', ukljuceno: false })).toEqual({ zahtjev: false, provedi: false })
  })
  test('tijelo 202 kaže što slijedi i da se PUT ne ponavlja', () => {
    const b = tijelo202('TASK-9')
    expect(b.stanje).toBe('ceka-kriticara')
    expect(b.poruka).toContain('Ne šalji PUT ponovo')
    expect(b.pratiti).toBe('GET /api/tasks/TASK-9')
  })
})

function zadatak(over: Partial<ZahtjevZadatak> = {}): ZahtjevZadatak {
  return {
    id: 'TASK-1', status: 'in_progress', assignee: 'inzenjer', description: 'opis', resultSummary: 'gotovo, commit abc',
    tags: ['chat:1', OZNAKA_CEKA], startedAt: new Date(Date.now() - 60_000).toISOString(), ...over,
  }
}

describe('B3 — daemonova petlja zahtjeva', () => {
  test('kritičar pass → completed, oznaka ceka-kriticara uklonjena', async () => {
    const zatvoreno: any[] = []
    const r = await obradiZahtjeveZatvaranja({
      zahtjevi: async () => [zadatak()],
      kriticar: async () => ({ status: 'pass', razlog: 'sve prošlo', provjera: 2 }),
      zatvori: async (id, body) => { zatvoreno.push({ id, body }); return true },
      log: () => {},
    })
    expect(r).toEqual([{ taskId: 'TASK-1', ishod: 'completed', kriticar: 'pass' }])
    expect(zatvoreno[0].body.status).toBe('completed')
    expect(zatvoreno[0].body.tags).toEqual(['chat:1'])
  })
  test('kritičar fail → blocked s CRITIC_FAILED', async () => {
    const zatvoreno: any[] = []
    const r = await obradiZahtjeveZatvaranja({
      zahtjevi: async () => [zadatak()],
      kriticar: async () => ({ status: 'fail', razlog: 'bun test pao (exit 1)', provjera: 1 }),
      zatvori: async (id, body) => { zatvoreno.push(body); return true },
      log: () => {},
    })
    expect(r[0].ishod).toBe('blocked')
    expect(zatvoreno[0].status).toBe('blocked')
    expect(zatvoreno[0].blockedReason).toContain('CRITIC_FAILED')
    expect(zatvoreno[0].blockedReason).toContain('bun test pao')
  })
  test('unverifiable → completed, ali s bilješkom „neprovjereno” (kao spawn put)', async () => {
    const zatvoreno: any[] = []
    await obradiZahtjeveZatvaranja({
      zahtjevi: async () => [zadatak()],
      kriticar: async () => ({ status: 'unverifiable', razlog: 'nema izvršnog artefakta', provjera: 0 }),
      zatvori: async (_id, body) => { zatvoreno.push(body); return true },
      log: () => {},
    })
    expect(zatvoreno[0].status).toBe('completed')
    expect(zatvoreno[0].progressNotes[0]).toContain('neprovjereno')
  })
  test('vratar teksta odbije (deterministički) → blocked', async () => {
    const zatvoreno: any[] = []
    await obradiZahtjeveZatvaranja({
      zahtjevi: async () => [zadatak({ resultSummary: '' })],
      kriticar: async () => ({ status: 'pass', razlog: '', provjera: 1 }),
      vratarTeksta: (t) => t ? null : 'EMPTY_RESULT: prazan sažetak',
      zatvori: async (_id, body) => { zatvoreno.push(body); return true },
      log: () => {},
    })
    expect(zatvoreno[0].status).toBe('blocked')
    expect(zatvoreno[0].blockedReason).toContain('EMPTY_RESULT')
  })
  test('kritičar pukne → zadatak ostaje čekati (ne zatvara se naslijepo)', async () => {
    let zvan = false
    const r = await obradiZahtjeveZatvaranja({
      zahtjevi: async () => [zadatak()],
      kriticar: async () => { throw new Error('boom') },
      zatvori: async () => { zvan = true; return true },
      log: () => {},
    })
    expect(zvan).toBe(false)
    expect(r[0].ishod).toBe('greska')
  })
  test('zadatak bez oznake ili koji nije in_progress se preskače', async () => {
    const r = await obradiZahtjeveZatvaranja({
      zahtjevi: async () => [zadatak({ tags: [] }), zadatak({ id: 'TASK-2', status: 'completed' })],
      kriticar: async () => ({ status: 'pass', razlog: '', provjera: 1 }),
      zatvori: async () => true,
      log: () => {},
    })
    expect(r).toEqual([])
  })
})

// QA-5165 N2, odluka B (TASK-5210, 04.10.2026.): put zahtjeva NE zatvara bez dokaza.
// Neizvediva propisana [PROVJERA] → blocked; vratar teksta se provodi; unverifiable bez
// propisane provjere uz sadržajan sažetak → completed kao na spawn putu.
describe('N2 (odluka B) — put zahtjeva ne zatvara bez dokaza', () => {
  const trivijalno = (t: string) => /^(gotovo|napravio sam izmjenu), sve radi\.?$/i.test(t.trim()) ? 'trivial_result: trivijalan sažetak' : null
  const prolaz = (z: ZahtjevZadatak, sud: any, vratarTeksta = trivijalno) => {
    const zatvoreno: any[] = []
    return obradiZahtjeveZatvaranja({
      zahtjevi: async () => [z], kriticar: async () => sud, vratarTeksta,
      zatvori: async (_id, body) => { zatvoreno.push(body); return true }, log: () => {},
    }).then((r) => ({ r, body: zatvoreno[0] }))
  }
  test('TASK-5206: propisana [PROVJERA] s nedopuštenim izvršiteljem `test` → blocked (NEIZVEDIVA_PROVJERA)', async () => {
    const { r, body } = await prolaz(
      zadatak({ resultSummary: 'Napravio sam izmjenu, sve radi.', description: '[PROVJERA] cmd: test -f /x' }),
      { status: 'unverifiable', razlog: 'propisana provjera se NE MOŽE izvesti', provjera: 0, neizvedivo: 1 },
      () => null) // i bez vratara teksta — neizvediva propisana provjera je dovoljna
    expect(r[0].ishod).toBe('blocked')
    expect(body.blockedReason).toContain('NEIZVEDIVA_PROVJERA')
    expect(body.blockedReason).toContain('[PROVJERA]')
    expect(body.tags).not.toContain(OZNAKA_CEKA)
  })
  test('TASK-5208: „Gotovo, sve radi.” bez provjere → blocked (vratar teksta provodi trivial_result)', async () => {
    const { r, body } = await prolaz(zadatak({ resultSummary: 'Gotovo, sve radi.' }),
      { status: 'unverifiable', razlog: 'nema izvršnog artefakta', provjera: 0, neizvedivo: 0 })
    expect(r[0].ishod).toBe('blocked')
    expect(body.blockedReason).toContain('trivial_result')
  })
  test('partial s neizvedivom propisanom provjerom → blocked', async () => {
    const { r } = await prolaz(zadatak({ resultSummary: 'Dodan modul X i 12 ispita, bun test 12 pass.' }),
      { status: 'partial', razlog: 'dio provjera prošao', provjera: 1, neizvedivo: 1 })
    expect(r[0].ishod).toBe('blocked')
  })
  test('dokumentacijski zadatak: unverifiable, bez propisane provjere, sadržajan sažetak → completed (kao spawn)', async () => {
    const { r, body } = await prolaz(
      zadatak({ resultSummary: 'Napisan docs/ADR-0020.md (180 redaka): tri opcije, preporuka B, tablica rizika.' }),
      { status: 'unverifiable', razlog: 'nema izvršnog artefakta', provjera: 0, neizvedivo: 0 })
    expect(r[0].ishod).toBe('completed')
    expect(body.progressNotes[0]).toContain('neprovjereno')
  })
  test('stari kritičar bez polja `neizvedivo` → ponaša se kao 0 (unatrag sukladno)', () => {
    expect(presudaZahtjeva({ status: 'unverifiable', razlog: '', provjera: 0 }, null).status).toBe('completed')
  })
  test('presuda je ista funkcija za provedbu i sjenu: fail > neizvedivo > tekst > completed', () => {
    expect(presudaZahtjeva({ status: 'fail', razlog: 'x', provjera: 1, neizvedivo: 1 }, 'trivial_result').blockedReason).toContain('CRITIC_FAILED')
    expect(presudaZahtjeva({ status: 'unverifiable', razlog: 'x', provjera: 0, neizvedivo: 2 }, 'trivial_result').blockedReason).toContain('NEIZVEDIVA_PROVJERA')
    expect(presudaZahtjeva({ status: 'pass', razlog: 'x', provjera: 1 }, 'trivial_result: t').blockedReason).toContain('trivial_result')
    expect(presudaZahtjeva({ status: 'pass', razlog: 'x', provjera: 1 }, null).status).toBe('completed')
  })
  test('sjena dobiva istu logiku: bihZatvorio=blocked za 5206 i 5208, completed za dokument', async () => {
    const zahtjevi = join(dir, 'zahtjevi.jsonl')
    const sudovi = join(dir, 'sudovi.jsonl')
    writeFileSync(zahtjevi, ['TASK-5206', 'TASK-5208', 'TASK-DOK'].map((id, i) =>
      JSON.stringify({ ts: `2026-10-04T00:00:0${i}Z`, taskId: id, nacin: 'shadow' })).join('\n') + '\n')
    const sazetak: Record<string, string> = {
      'TASK-5206': 'Napravio sam izmjenu, sve radi.', 'TASK-5208': 'Gotovo, sve radi.',
      'TASK-DOK': 'Napisan docs/ADR-0020.md (180 redaka): tri opcije, preporuka B, tablica rizika.',
    }
    await obradiSjenuZatvaranja({
      zahtjeviPut: zahtjevi, sudoviPut: sudovi, najvise: 10,
      zadatak: async (id) => zadatak({ id, status: 'completed', tags: [], resultSummary: sazetak[id] }),
      kriticar: async (z) => ({ status: 'unverifiable', razlog: 'n', provjera: 0, neizvedivo: z.id === 'TASK-5206' ? 1 : 0 }),
      vratarTeksta: (t) => trivijalno(t),
      log: () => {},
    })
    const redovi = readFileSync(sudovi, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(redovi.map((x) => [x.taskId, x.bihZatvorio])).toEqual([
      ['TASK-5206', 'blocked'], ['TASK-5208', 'blocked'], ['TASK-DOK', 'completed']])
    expect(redovi[0].bihRazlog).toContain('NEIZVEDIVA_PROVJERA')
    expect(redovi[1].bihRazlog).toContain('trivial_result')
  })
})

describe('B3 sjena — daemon sudi, ploču ne dira', () => {
  test('svaki zahtjev iz dnevnika dobije točno jedan sud', async () => {
    const zahtjevi = join(dir, 'zahtjevi.jsonl')
    const sudovi = join(dir, 'sudovi.jsonl')
    writeFileSync(zahtjevi, [
      JSON.stringify({ ts: '2026-10-04T00:00:00Z', taskId: 'TASK-1', nacin: 'shadow', startedAt: '2026-10-04T00:00:00Z' }),
      JSON.stringify({ ts: '2026-10-04T00:00:01Z', taskId: 'TASK-2', nacin: 'shadow', startedAt: null }),
    ].join('\n') + '\n')
    const deps = {
      zahtjeviPut: zahtjevi, sudoviPut: sudovi,
      zadatak: async (id: string) => zadatak({ id, status: 'completed', tags: [] }),
      kriticar: async () => ({ status: 'pass' as const, razlog: 'ok', provjera: 1 }),
      log: () => {},
    }
    const r1 = await obradiSjenuZatvaranja(deps)
    expect(r1).toBe(2)
    const r2 = await obradiSjenuZatvaranja(deps)
    expect(r2).toBe(0)
    const redovi = readFileSync(sudovi, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(redovi.map((x) => x.taskId)).toEqual(['TASK-1', 'TASK-2'])
    expect(redovi[0].bihZatvorio).toBe('completed')
  })
  test('nema dnevnika zahtjeva → 0, bez greške', async () => {
    expect(await obradiSjenuZatvaranja({
      zahtjeviPut: join(dir, 'nema'), sudoviPut: join(dir, 's'),
      zadatak: async () => null, kriticar: async () => ({ status: 'pass', razlog: '', provjera: 0 }), log: () => {},
    })).toBe(0)
    expect(existsSync(join(dir, 's'))).toBe(false)
  })
})

describe('putanje (TASK-5327): ploča paketa i daemon domaćina dijele ključ i dnevnik', () => {
  test('TM_IZVORNI_PODACI određuje mapu ključa i dnevnika zahtjeva', () => {
    process.env.TM_IZVORNI_PODACI = dir
    try {
      expect(putTokena()).toBe(join(dir, 'zatvarac.token'))
      expect(putZahtjeva()).toBe(join(dir, 'zatvaranje_zahtjevi.jsonl'))
      zapisiZahtjev({ taskId: 'TASK-9', nacin: 'shadow' })
      const red = JSON.parse(readFileSync(join(dir, 'zatvaranje_zahtjevi.jsonl'), 'utf-8').trim())
      expect(red).toMatchObject({ taskId: 'TASK-9', nacin: 'shadow' })
    } finally { delete process.env.TM_IZVORNI_PODACI }
  })
  test('usporedba ključa je stalnog trajanja (timingSafeEqual) — različita duljina ne baca', () => {
    expect(pozivateljZatvaranja(zag({ 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': 'kratko' }), 'a'.repeat(48))).toBe('ostali')
  })
})
