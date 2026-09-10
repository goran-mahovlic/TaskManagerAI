/**
 * Testovi popravaka iz sigurnosne revizije TASK-4801 (nalazi B1–B4).
 *
 * Svaki `describe` odgovara jednom nalazu i tvrdi ono što je revizija izmjerila kao kvar:
 *   B3 — poruka dojave ne smije nositi tuđu adresu ploče;
 *   B2 — bot token ne izlazi kroz API i ne leži kao 0664;
 *   B1 — „Probaj" za e-poštu nije skener unutarnje mreže;
 *   B4 — živa konfiguracija ulaza nije u paketu.
 *
 * Uzorci naših vrijednosti se NIKAD ne pišu doslovno — brana
 * `tests/bez-nasih-vrijednosti.test.ts` ne razlikuje curenje od tvrdnje o curenju.
 *
 * Autorica: Jelena (Engineer), TASK-4807.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { boardUrl, buildReportBackMessage } from '../src/core/ReportBackTask'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-4801-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })
const put = (ime: string) => join(mapa, ime)

const ZADACI = [{ id: 'TASK-1', title: 'Prvi', status: 'completed', resultSummary: 'gotovo' }] as any

// ─── B3 — adresa ploče ───────────────────────────────────────────────────────

describe('B3 — adresa ploče dolazi iz okoline, bez zadane vrijednosti', () => {
  const staro = process.env.TM_BOARD_URL
  afterEach(() => {
    if (staro === undefined) delete process.env.TM_BOARD_URL
    else process.env.TM_BOARD_URL = staro
  })

  test('bez TM_BOARD_URL nema adrese ni retka „Ploča:"', () => {
    delete process.env.TM_BOARD_URL
    expect(boardUrl()).toBeNull()
    const poruka = buildReportBackMessage({ subject: 'niz', tasks: ZADACI, reportBackId: 'TASK-9' })
    expect(poruka).not.toContain('Ploča:')
    expect(poruka).not.toContain('http')
    // Oznaka dojave ostaje — po njoj se zadatak nalazi i bez poveznice.
    expect(poruka).toContain('TASK-9')
  })

  test('s TM_BOARD_URL poruka nosi TU adresu i nijednu drugu', () => {
    process.env.TM_BOARD_URL = 'http://ploca.primjer:1234'
    const poruka = buildReportBackMessage({ subject: 'niz', tasks: ZADACI, reportBackId: 'TASK-9' })
    expect(poruka).toContain('Ploča: http://ploca.primjer:1234')
    expect((poruka.match(/http/g) || []).length).toBe(1)
  })

  test('prazna vrijednost se ponaša kao nepostavljena (ne šalje se „Ploča: ")', () => {
    process.env.TM_BOARD_URL = '   '
    expect(boardUrl()).toBeNull()
    expect(buildReportBackMessage({ subject: 'x', tasks: ZADACI })).not.toContain('Ploča:')
  })
})
