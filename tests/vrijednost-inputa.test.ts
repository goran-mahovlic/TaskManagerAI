/**
 * TASK-5230: „Vrijednost korisničkih upita S1–S6" vječno na „Računam…".
 *
 * Uzrok (izmjereno 04.10.2026.): `vrijednost_inputa.py` traje 68 s (65 s CPU), a ruta ga je
 * zvala SINKRONO unutar zahtjeva; Bun `idleTimeout` (10 s) prekida vezu → preglednik dobije
 * ERR_EMPTY_RESPONSE, Chromium zahtjev sam ponovi (još jedan python) i tako svaki pokušaj
 * dodaje proces. Ovi testovi drže novi ugovor: odgovor nikad ne čeka python dulje od
 * `waitMs`, jedan posao u letu, star keš se vraća odmah, keš preživi restart.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  resolveVrijednost, createVrijednostState, VRIJEDNOST_TTL_MS, VRIJEDNOST_MIN_REFRESH_MS,
  type VrijednostDeps,
} from '../src/VrijednostInputa'

const PODATCI = { cjenik: { S1: 0.05 }, poKorisniku: { "Korisnik A": { eur: 1, upita: 2 } }, poProjektu: {}, upita: 2 }

function deps(opts: { trajanjeMs?: number; neuspjeh?: boolean; kesPath?: string; now?: () => number } = {}) {
  let pokretanja = 0
  let rijesi: ((s: string) => void) | null = null
  const d: VrijednostDeps & { pokretanja: () => number; zavrsi: () => void } = {
    now: opts.now || (() => Date.now()),
    kesPath: opts.kesPath || null,
    runTool: () => {
      pokretanja++
      if (opts.neuspjeh) return Promise.reject(new Error('python pao'))
      if (opts.trajanjeMs === undefined) return new Promise<string>((r) => { rijesi = r })
      return new Promise<string>((r) => setTimeout(() => r(JSON.stringify(PODATCI)), opts.trajanjeMs))
    },
    pokretanja: () => pokretanja,
    zavrsi: () => { if (rijesi) rijesi(JSON.stringify(PODATCI)) },
  }
  return d
}

describe('VrijednostInputa — izračun nikad ne drži zahtjev', () => {
  test('bez keša i spor izračun → 202 racuna unutar waitMs, ne visi', async () => {
    const d = deps()
    const st = createVrijednostState(d)
    const t0 = Date.now()
    const o = await resolveVrijednost({ waitMs: 50 }, st, d)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(o.http).toBe(202)
    expect(o.body.stanje).toBe('racuna')
  })

  test('jedan posao u letu: tri zahtjeva dok računa → jedan python', async () => {
    const d = deps()
    const st = createVrijednostState(d)
    await resolveVrijednost({ waitMs: 10 }, st, d)
    await resolveVrijednost({ waitMs: 10 }, st, d)
    await resolveVrijednost({ force: true, waitMs: 10 }, st, d)
    expect(d.pokretanja()).toBe(1)
  })

  test('brz izračun → 200 izracun u istom zahtjevu', async () => {
    const d = deps({ trajanjeMs: 5 })
    const st = createVrijednostState(d)
    const o = await resolveVrijednost({ waitMs: 1000 }, st, d)
    expect(o.http).toBe(200)
    expect(o.body.izvor).toBe('izracun')
    expect(o.body.poKorisniku["Korisnik A"].eur).toBe(1)
  })

  test('posao dovrši u pozadini → sljedeći zahtjev dobije keš', async () => {
    const d = deps()
    const st = createVrijednostState(d)
    await resolveVrijednost({ waitMs: 10 }, st, d)
    d.zavrsi()
    await new Promise((r) => setTimeout(r, 10))
    const o = await resolveVrijednost({ waitMs: 10 }, st, d)
    expect(o.http).toBe(200)
    expect(o.body.izvor).toBe('kes')
    expect(o.body.osvjezava).toBe(false)
  })
})

describe('VrijednostInputa — stale-while-revalidate', () => {
  test('istekao keš → 200 star keš ODMAH + osvjezava, python u pozadini', async () => {
    let sada = 1_000_000
    const d = deps({ now: () => sada })
    const st = createVrijednostState(d)
    st.kes = { u: sada, podatci: PODATCI }
    sada += VRIJEDNOST_TTL_MS + 1
    const o = await resolveVrijednost({ waitMs: 10 }, st, d)
    expect(o.http).toBe(200)
    expect(o.body.izvor).toBe('kes')
    expect(o.body.osvjezava).toBe(true)
    expect(d.pokretanja()).toBe(1)
  })

  test('Osvježi (force) sa svježim kešem → 200 keš + osvjezava (ne 000, ne prazno)', async () => {
    let sada = 1_000_000
    const d = deps({ now: () => sada })
    const st = createVrijednostState(d)
    st.kes = { u: sada, podatci: PODATCI }
    sada += VRIJEDNOST_MIN_REFRESH_MS + 1
    const o = await resolveVrijednost({ force: true, waitMs: 10 }, st, d)
    expect(o.http).toBe(200)
    expect(o.body.osvjezava).toBe(true)
    expect(d.pokretanja()).toBe(1)
  })

  test('force unutar donje brane → nema novog pythona', async () => {
    let sada = 1_000_000
    const d = deps({ now: () => sada })
    const st = createVrijednostState(d)
    st.kes = { u: sada, podatci: PODATCI }
    sada += 1000
    const o = await resolveVrijednost({ force: true, waitMs: 10 }, st, d)
    expect(o.http).toBe(200)
    expect(o.body.osvjezava).toBe(false)
    expect(d.pokretanja()).toBe(0)
  })

  test('neuspjeh bez keša → 503 s porukom; s kešem → 200 keš + greska', async () => {
    const d = deps({ neuspjeh: true })
    const st = createVrijednostState(d)
    const o = await resolveVrijednost({ waitMs: 100 }, st, d)
    expect(o.http).toBe(503)
    expect(String(o.body.error)).toContain('python pao')
    st.kes = { u: 0, podatci: PODATCI }
    const o2 = await resolveVrijednost({ waitMs: 100 }, st, d)
    expect(o2.http).toBe(200)
    expect(o2.body.izvor).toBe('kes')
  })
})

describe('VrijednostInputa — keš na disku (restart ploče)', () => {
  test('uspješan izračun se zapisuje; novo stanje ga učita i odmah služi', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'vr5230-'))
    const kesPath = join(dir, 'vrijednost_inputa_kes.json')
    const d = deps({ trajanjeMs: 1, kesPath })
    const st = createVrijednostState(d)
    await resolveVrijednost({ waitMs: 1000 }, st, d)
    expect(existsSync(kesPath)).toBe(true)
    expect(JSON.parse(readFileSync(kesPath, 'utf8')).podatci.upita).toBe(2)

    const d2 = deps({ kesPath })
    const st2 = createVrijednostState(d2)
    const o = await resolveVrijednost({ waitMs: 10 }, st2, d2)
    expect(o.http).toBe(200)
    expect(o.body.izvor).toBe('kes')
    expect(d2.pokretanja()).toBe(0)
  })

  test('pokvarena datoteka keša = nema keša (202), ne pad', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'vr5230-'))
    const kesPath = join(dir, 'k.json')
    writeFileSync(kesPath, '{pola')
    const d = deps({ kesPath })
    const st = createVrijednostState(d)
    const o = await resolveVrijednost({ waitMs: 10 }, st, d)
    expect(o.http).toBe(202)
  })
})
