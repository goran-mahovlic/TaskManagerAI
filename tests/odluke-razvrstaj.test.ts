/**
 * TASK-5173 — traka „Čeka odluku" proturječila je odlučitelju.
 *
 * Izmjereno 03.10.2026.: GET /api/odluke → ukupno 3, spremni 3, modelOdlucuje true, a
 * odlučitelj „nema zadataka koji čekaju odluku" (pregledano 0). Naslov je tvrdio „odlučuje
 * model, ne čekaju tebe" za tri zadatka koje model NIKAD ne gleda:
 *   TASK-4651 [needs-decision, okidac-strojni]  — čeka strojni okidač
 *   TASK-4619 [needs-decision, okidac-strojni]  — čeka nadnevak 05.10.2026.
 *   TASK-4717 [okidac-strojni, waiting-for-human] — čeka čovjeka (reboot traži sudo)
 *
 * Uzrok: ploča je brojila po jednom filtru, a odlučitelj (`tools/.../odlucitelj.py`,
 * `cekaju()`) po drugom. Sad postoji JEDAN filtar (`zaOdlucitelja`) — poslužitelj ga računa,
 * odlučitelj ga samo čita.
 */
import { describe, expect, test } from 'bun:test'
import {
  razvrstajOdluku, zaOdlucitelja, nadnevakIzTeksta, sazetakRazloga, zbrojiSkupine,
} from '../src/core/OdlukeRazvrstaj'

const SADA = Date.parse('2026-10-04T00:00:00Z')
const MODEL = { modelOdlucuje: true, pustaStrojni: false, sada: SADA }
const COVJEK = { modelOdlucuje: false, pustaStrojni: false, sada: SADA }

// Doslovni podatci triju zadataka s ploče (skraćeni opisi, oznake i blockedReason točni).
const T4651 = {
  id: 'TASK-4651', title: 'M1c: Prosiriti canary osiguraca spawnova na korak 4a — ceka dojavu PASS',
  tags: ['needs-decision', 'okidac-strojni'], cekaNa: [],
  blockedReason: 'BLOCKED: Agent je sam deklarirao BLOCKED: okidač (dojava PASS / EXIT=0) nije nastupio; '
    + '`spawn-breaker-status.ts --hours 72 --strict` daje NEDOVOLJNO_DOKAZA EXIT=4, prozor pokriven tek '
    + '07.09.2026. 17:44Z. Isporučeno sve neovisno o okidaču: prosudba, §4 M1 dokumentacija. '
    + 'Zatvaranje kao completed proturječi vlastitoj izjavi agenta.',
  description: 'OKIDAC (ne datum!): Telegram dojava "OSIGURAC SPAWNOVA — prozor od 72 h je POKRIVEN i PASS"',
}
const T4619 = {
  id: 'TASK-4619', title: 'W6: Mjerenje isplati li se tijek rada',
  tags: ['workflow', 'plan-W', 'needs-decision', 'okidac-strojni'], cekaNa: [],
  blockedReason: 'Vremenski uvjet: prvi izvještaj tek 30 dana nakon puštanja W2 (TASK-4616 dovršen '
    + '05.09.2026.) → najranije 05.10.2026. Do tada nema što mjeriti.',
  description: 'ŠTO: uz svaki zadatak bilježiti je li išao tijekom…',
}
const T4717 = {
  id: 'TASK-4717', title: 'Potvrditi prezivljavanje reboota na node-A i node-B',
  tags: ['okidac-strojni', 'waiting-for-human'], cekaNa: [],
  blockedReason: 'BLOCKED: Agent je sam deklarirao BLOCKED: nedostaje ovlast za reboot (korisnik usluge nema `sudo` '
    + 'bez lozinke, polkit `login1.reboot` traži interaktivnu autentikaciju); sva 4 mjerenja isporučena. '
    + 'Zatvaranje kao completed proturječi vlastitoj izjavi agenta.',
  description: 'POVOD: TASK-4712 / ADR-0010 …',
}

describe('razvrstajOdluku — tri skupine trake', () => {
  test('stvarni slučaj 03.10.: 0 odlučuje model, 2 strojni okidač, 1 čeka tebe', () => {
    const r = [T4651, T4619, T4717].map(t => razvrstajOdluku(t, MODEL))
    expect(r.map(x => x.skupina)).toEqual(['strojni', 'strojni', 'covjek'])
    expect(zbrojiSkupine(r)).toEqual({ model: 0, strojni: 2, covjek: 1 })
  })

  test('nijedan od tri NIJE u redu odlučitelja — kao i u odlučiteljevu prolazu (pregledano 0)', () => {
    for (const t of [T4651, T4619, T4717]) expect(zaOdlucitelja(t, MODEL)).toBe(false)
  })

  test('waiting-for-human pobjeđuje okidac-strojni: TASK-4717 čeka TEBE, ne stroj', () => {
    const r = razvrstajOdluku(T4717, MODEL)
    expect(r.skupina).toBe('covjek')
    expect(r.sto).toContain('nedostaje ovlast za reboot')
    expect(r.sto).not.toContain('Agent je sam deklarirao')
    expect(r.sto).not.toContain('Zatvaranje kao completed')
  })

  test('strojni okidač: ŠTO iz blockedReason, DO KADA iz prvog budućeg nadnevka', () => {
    const r = razvrstajOdluku(T4619, MODEL)
    expect(r.sto).toContain('Vremenski uvjet')
    expect(r.doKada).toEqual({ tekst: '05.10.2026.', iso: expect.stringMatching(/^2026-10-0[45]T/), prosao: false })
  })

  test('strojni okidač čiji je rok iz opisa davno prošao — to se kaže, ne prešućuje', () => {
    const r = razvrstajOdluku(T4651, MODEL)
    expect(r.sto).toContain('okidač (dojava PASS / EXIT=0) nije nastupio')
    expect(r.doKada?.prosao).toBe(true)
    expect(r.doKada?.tekst).toBe('07.09.2026. 17:44Z')
  })

  test('obični needs-decision uz uključen prekidač ide modelu i u red odlučitelja', () => {
    const t = { id: 'TASK-1', title: 'Odaberi A ili B', tags: ['needs-decision'], cekaNa: [] }
    expect(razvrstajOdluku(t, MODEL).skupina).toBe('model')
    expect(zaOdlucitelja(t, MODEL)).toBe(true)
  })

  test('isključen prekidač: needs-decision čeka tebe, a ŠTO je pitanje (ili naslov)', () => {
    const t = { id: 'TASK-1', title: 'Odaberi A ili B', tags: ['needs-decision'], cekaNa: [],
      pitanje: { pitanje: 'Koji broker koristiti?' } }
    const r = razvrstajOdluku(t, COVJEK)
    expect(r.skupina).toBe('covjek')
    expect(r.sto).toBe('Koji broker koristiti?')
    expect(razvrstajOdluku({ ...t, pitanje: null }, COVJEK).sto).toBe('Odaberi A ili B')
    // filtar odlučitelja NE ovisi o prekidaču — on ionako ne upisuje ništa dok je isključen
    expect(zaOdlucitelja(t, COVJEK)).toBe(true)
  })

  test('nedovršena ovisnost je strojni okidač: ŠTO = koji zadatak', () => {
    const t = { id: 'TASK-2', title: 'x', tags: ['needs-decision'], cekaNa: ['TASK-9', 'TASK-8'] }
    const r = razvrstajOdluku(t, MODEL)
    expect(r.skupina).toBe('strojni')
    expect(r.sto).toContain('TASK-9')
    expect(zaOdlucitelja(t, MODEL)).toBe(false)
  })

  test('no-autonomy i interactive su ljudski potez — model ih ne dira', () => {
    for (const g of ['no-autonomy', 'interactive', 'WAITING-FOR-HUMAN']) {
      const t = { id: 'TASK-3', title: 'x', tags: ['needs-decision', g], cekaNa: [] }
      expect(razvrstajOdluku(t, MODEL).skupina).toBe('covjek')
      expect(zaOdlucitelja(t, MODEL)).toBe(false)
    }
  })

  test('pusta_strojni_okidac: true vraća strojni zadatak u red odlučitelja (ista sklopka kao u alatu)', () => {
    const o = { ...MODEL, pustaStrojni: true }
    expect(zaOdlucitelja(T4619, o)).toBe(true)
    expect(razvrstajOdluku(T4619, o).skupina).toBe('model')
    expect(zaOdlucitelja(T4717, o)).toBe(false)   // čovjek ostaje čovjek
  })

  test('aktivna odgoda: skupina ostaje model, ali NIJE u ovom prolazu (kao _jos_odgodjen)', () => {
    const t = { id: 'TASK-1', title: 'x', tags: ['needs-decision'], cekaNa: [],
      odgoda: { do: '2026-10-04T03:00:00Z', puta: 1 } }
    expect(razvrstajOdluku(t, MODEL).skupina).toBe('model')
    expect(zaOdlucitelja(t, MODEL)).toBe(false)
    expect(zaOdlucitelja({ ...t, odgoda: { do: '2026-10-03T23:00:00Z', puta: 1 } }, MODEL)).toBe(true)
  })
})

describe('nadnevakIzTeksta', () => {
  test('bez nadnevka → null', () => {
    expect(nadnevakIzTeksta('nema roka', SADA)).toBeNull()
    expect(nadnevakIzTeksta('', SADA)).toBeNull()
  })
  test('ISO s vremenom', () => {
    expect(nadnevakIzTeksta('poslije:2026-10-07T17:44:00Z', SADA))
      .toEqual({ tekst: '2026-10-07T17:44:00Z', iso: '2026-10-07T17:44:00.000Z', prosao: false })
  })
  test('od više budućih bira NAJRANIJI, prošle zanemaruje', () => {
    expect(nadnevakIzTeksta('od 01.09.2026. do 12.10.2026. ili 06.10.2026.', SADA)?.tekst).toBe('06.10.2026.')
  })
  test('neispravan nadnevak (32.13.2026.) se ne prihvaća', () => {
    expect(nadnevakIzTeksta('32.13.2026.', SADA)).toBeNull()
  })
})

describe('sazetakRazloga', () => {
  test('skida dvostruki prefiks i rečenicu vratara, reže na granici riječi', () => {
    const s = sazetakRazloga('BLOCKED: Agent je sam deklarirao BLOCKED: ' + 'riječ '.repeat(80)
      + 'Zatvaranje kao completed proturječi vlastitoj izjavi agenta.', 120)
    expect(s.startsWith('riječ')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(121)
    expect(s.endsWith('…')).toBe(true)
  })
  test('prazno ostaje prazno', () => { expect(sazetakRazloga(null as any)).toBe('') })
})
