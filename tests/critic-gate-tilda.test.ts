/**
 * TASK-5259 — `~` u propisanoj provjeri (prijenos iz glavnog sustava, TASK-5618).
 *
 * Kritičar naredbu izvodi BEZ ljuske, pa `~/…` ostaje doslovan argument. `bun test ~/x.test.ts`
 * tada traži filtar „~/x.test.ts” u stablu spawna i pada s „did not match any test files”,
 * iako ista naredba u ljusci prolazi (TASK-5259, krug 1/2). Ljuska razvija samo `~` i `~/…`
 * na početku riječi — isto radi i parser; `~korisnik`, `a~b` i `~` usred argumenta ostaju.
 */
import { describe, test, expect } from 'bun:test'
import { homedir } from 'os'
import { parseDeclaredChecks } from '../src/core/CriticGate'

const HOME = process.env.HOME || homedir()

describe('parseDeclaredChecks — razvijanje ~', () => {
  test('~/… na početku argumenta postaje $HOME/…', () => {
    const d = parseDeclaredChecks('[PROVJERA] cmd: bun test ~/projekt/tests/neki.test.ts')
    expect(d.issues).toEqual([])
    expect(d.checks[0].cmd).toEqual(['bun', 'test', `${HOME}/projekt/tests/neki.test.ts`])
  })

  test('samostalni ~ postaje $HOME', () => {
    const d = parseDeclaredChecks('[PROVJERA] cmd: bun test ~')
    expect(d.checks[0].cmd).toEqual(['bun', 'test', HOME])
  })

  test('~korisnik, ~ usred argumenta i ~ u navodnicima ostaju doslovni', () => {
    const d = parseDeclaredChecks(`[PROVJERA] cmd: bun test ~korisnik/x.ts a~/b.ts '~/c.ts' "~/d.ts"`)
    expect(d.checks[0].cmd).toEqual(['bun', 'test', '~korisnik/x.ts', 'a~/b.ts', '~/c.ts', '~/d.ts'])
  })

  test('raw ostaje kako je napisan (potpis citira opis zadatka)', () => {
    const raw = 'bun test ~/projekt/tests/neki.test.ts'
    expect(parseDeclaredChecks(`[PROVJERA] cmd: ${raw}`).checks[0].raw).toBe(raw)
  })
})
