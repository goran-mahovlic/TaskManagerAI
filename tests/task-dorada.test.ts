/**
 * TASK-5164 / DIZAJN-nesukladnosti-BCD §4 (D) — čista logika dorade, bilješki i poruka o pogrešci.
 *
 * Ploča (TaskWebUI) samo spaja ove funkcije s bazom; e2e dokaz je u `task-dorada-e2e.test.ts`.
 */
import { describe, test, expect } from 'bun:test'
import {
  predloziRutu, odgovor404Rute, hintPrijelaza, normalizirajBiljeske, tekstBiljeske,
  naslovDorade, opisDorade, oznakeDorade, izvuciProvjere, RUTE_ZADATKA,
} from '../src/core/TaskDorada'

describe('predloziRutu — „mislio si” za nepoznatu podrutu', () => {
  test('/notes i /note → /biljeska (engleski alias koji agenti stvarno zovu, M12)', () => {
    expect(predloziRutu('note')).toBe('POST /api/tasks/<ID>/biljeska')
    expect(predloziRutu('comment')).toBe('POST /api/tasks/<ID>/biljeska')
  })
  test('reopen → /ponovno-otvori, rework → /dorada', () => {
    expect(predloziRutu('reopen')).toBe('POST /api/tasks/<ID>/ponovno-otvori')
    expect(predloziRutu('rework')).toBe('POST /api/tasks/<ID>/dorada')
  })
  test('tipfeler se ispravlja po udaljenosti uređivanja', () => {
    expect(predloziRutu('uputaa')).toBe('POST /api/tasks/<ID>/uputa')
    expect(predloziRutu('pitnje')).toBe('POST /api/tasks/<ID>/pitanje')
  })
  test('posve nepoznato → null (bolje ništa nego kriv savjet)', () => {
    expect(predloziRutu('xyzzyqwerty')).toBeNull()
  })
})

describe('odgovor404Rute', () => {
  test('nosi popis dostupnih ruta s pravim ID-em i prijedlog', () => {
    const b = odgovor404Rute('TASK-7', 'notex', 'POST')
    expect(b.error).toBe('Unknown route')
    expect(b.dostupno).toContain('POST /api/tasks/TASK-7/biljeska')
    expect(b.dostupno).toContain('POST /api/tasks/TASK-7/dorada')
    expect(b.mislio_si).toBe('POST /api/tasks/TASK-7/biljeska')
  })
  test('popis ruta pokriva sve ulaze iz dizajna', () => {
    for (const r of ['biljeska', 'uputa', 'dorada', 'ponovno-otvori', 'pitanje', 'pause', 'resume']) {
      expect(RUTE_ZADATKA.some((x) => x.endsWith('/' + r))).toBe(true)
    }
  })
})

describe('hintPrijelaza — 409 kaže što učiniti', () => {
  test('iz completed → /dorada ili /ponovno-otvori', () => {
    const h = hintPrijelaza('completed', 'in_progress', 'TASK-1')
    expect(h).toContain('/api/tasks/TASK-1/dorada')
    expect(h).toContain('/ponovno-otvori')
  })
  test('in_progress → pending upućuje na /pause (i /reclaim samo za nadzornika)', () => {
    const h = hintPrijelaza('in_progress', 'pending', 'TASK-1')
    expect(h).toContain('/pause')
    expect(h).toContain('/reclaim')
  })
  test('blocked → completed: najprije in_progress', () => {
    expect(hintPrijelaza('blocked', 'completed', 'TASK-1')).toContain('in_progress')
  })
  test('pending → completed: dva PUT-a (pravilo 12)', () => {
    expect(hintPrijelaza('pending', 'completed', 'TASK-1')).toContain('in_progress')
  })
})

describe('normalizirajBiljeske — progressNotes kao tekst (M13)', () => {
  test('string → [string]', () => {
    expect(normalizirajBiljeske('x')).toEqual({ vrijednost: ['x'], alias: true })
  })
  test('niz ostaje niz', () => {
    expect(normalizirajBiljeske(['a', 'b'])).toEqual({ vrijednost: ['a', 'b'], alias: false })
  })
  test('prazan string → prazan niz (ništa se ne dodaje)', () => {
    expect(normalizirajBiljeske('   ')).toEqual({ vrijednost: [], alias: true })
  })
  test('ostalo se ne dira (Zod će ga odbiti)', () => {
    expect(normalizirajBiljeske(5)).toEqual({ vrijednost: 5, alias: false })
  })
})

describe('tekstBiljeske', () => {
  test('prihvaća text, note i biljeska', () => {
    expect(tekstBiljeske({ text: ' a ' })).toBe('a')
    expect(tekstBiljeske({ note: 'b' })).toBe('b')
    expect(tekstBiljeske({ biljeska: 'c' })).toBe('c')
    expect(tekstBiljeske({})).toBe('')
    expect(tekstBiljeske(null)).toBe('')
  })
})

describe('dorada — naslov, opis, oznake', () => {
  const izvorni = {
    id: 'TASK-5142', title: 'PDF izvještaja', status: 'completed',
    description: 'Napravi PDF.\n[PROVJERA] cmd: bun test tests/pdf.test.ts\nostalo',
    resultSummary: 'PDF je u docs/x.pdf', tags: ['chat:-1001234567890', 'lanac', 'dizajn'],
    projectId: 'PRJ-PRIMJER', assignee: 'grga', priority: 2,
  }
  test('naslov nosi izvorni naslov, bez dvostrukog prefiksa', () => {
    expect(naslovDorade('PDF')).toBe('Dorada: PDF')
    expect(naslovDorade('Dorada: PDF')).toBe('Dorada: PDF')
  })
  test('provjere se prenose doslovno', () => {
    expect(izvuciProvjere(izvorni.description)).toEqual(['[PROVJERA] cmd: bun test tests/pdf.test.ts'])
  })
  test('opis: razlog, izvorni opis, izvorni rezultat i provjere', () => {
    const o = opisDorade({ izvorni, razlog: 'krivi nadnevak na str. 2', author: 'goran' })
    expect(o).toContain('krivi nadnevak na str. 2')
    expect(o).toContain('TASK-5142')
    expect(o).toContain('PDF je u docs/x.pdf')
    expect(o).toContain('[PROVJERA] cmd: bun test tests/pdf.test.ts')
    expect(o).toContain('goran')
  })
  test('oznake: nasljeđuje se samo chat:, dodaju se dorada i dorada-od', () => {
    expect(oznakeDorade(izvorni.tags, 'TASK-5142')).toEqual(['chat:-1001234567890', 'dorada', 'dorada-od:TASK-5142'])
  })
  test('dodatne oznake (npr. sesija) se pridodaju bez duplikata', () => {
    expect(oznakeDorade(['chat:1'], 'TASK-1', ['no-watchdog', 'dorada'])).toEqual(['chat:1', 'dorada', 'dorada-od:TASK-1', 'no-watchdog'])
  })
})
