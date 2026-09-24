/**
 * tests/completion-guard-schema.test.ts — W3/TASK-4615.
 *
 * Vratar mora suditi po POLJIMA, a ne po prozi. Tri stvari koje se ovdje drže:
 *   1. valjan `REGOC-IZLAZ` zatvara zadatak s `confidence: 'schema'` — i onda kad bi
 *      prozni sloj isti tekst odbio (npr. jer spominje ograničenje);
 *   2. u načinu `shadow` nevaljana shema NE mijenja ishod — samo se zakači na sud;
 *   3. agentova vlastita izjava `REGOC-STATUS: BLOCKED` je IZNAD besprijekorne sheme.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { evaluateCompletion, shouldEnforce, type GateConfig } from '../src/core/CompletionGuard'
import { OZNAKA_BEZ_BLOKA, SHEMA_MARKER, loadStepSchemaConfig } from '../src/core/StepSchema'

const dir = mkdtempSync(join(tmpdir(), '.tmp-cg-schema-'))
const cfgPut = join(dir, 'step-schema.json')
const staro = process.env.REGOC_STEP_SCHEMA_CONFIG

function nacin(n: 'off' | 'shadow' | 'on', provodiNedostajuci = false) {
  writeFileSync(cfgPut, JSON.stringify({ nacin: n, provodiNedostajuci }))
  process.env.REGOC_STEP_SCHEMA_CONFIG = cfgPut
  loadStepSchemaConfig(true)
}

afterAll(() => {
  if (staro === undefined) delete process.env.REGOC_STEP_SCHEMA_CONFIG
  else process.env.REGOC_STEP_SCHEMA_CONFIG = staro
  loadStepSchemaConfig(true)
  rmSync(dir, { recursive: true, force: true })
})

/** Prozni sloj u sjeni (ovako je danas u pogonu: config/completion-gate.json). */
const SJENA: GateConfig = { enabled: true, live: false, deterministicLive: true }

const izlaz = (o: unknown) => `${SHEMA_MARKER}\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``

const VALJAN = izlaz({
  napravljeno: 'Ukopčala StepSchema u CompletionGuard i pokrenula testove.',
  dokaz: [{ vrsta: 'test', naredba: 'bun test tests/step-schema.test.ts', izlaz: '26 pass, 0 fail' }],
  datoteke: ['/srv/tm/src/core/CompletionGuard.ts'],
  sljedeci_korak: null,
  nesigurnosti: ['mjerenje „poslije" traži živi promet'],
})

const NEVALJAN = izlaz({ napravljeno: 'gotovo', dokaz: [{ vrsta: 'mjerenje', izlaz: 'dobro' }] })

describe('shema zatvara zadatak nad poljima', () => {
  test('valjan izlaz → accept, confidence=schema', () => {
    nacin('shadow')
    const v = evaluateCompletion(`Radila sam na W3.\n\n${VALJAN}\n\nREGOC-STATUS: DONE — isporučeno`)
    expect(v.accept).toBe(true)
    expect(v.confidence).toBe('schema')
    expect(v.stepSchema?.strojnoProvjerljiv).toBe(true)
  })

  test('valjan izlaz nadjačava prozno „nisam mogao" u polju nesigurnosti', () => {
    nacin('shadow')
    // Bez sheme bi ovo palo na `incapacity_admission` (proza priznaje ograničenje).
    const tekst = `Nisam mogao pokrenuti mjerenje na živom prometu.\n\n${izlaz({
      napravljeno: 'Napisala modul i testove, mjerenje čeka promet.',
      dokaz: [{ vrsta: 'naredba', naredba: 'bun build StepSchema.ts', izlaz: 'exit 0' }],
      datoteke: ['StepSchema.ts'],
      sljedeci_korak: 'mjerenje nakon 24 h',
      nesigurnosti: ['nisam mogao izmjeriti „poslije" bez prometa'],
    })}`
    const v = evaluateCompletion(tekst)
    expect(v.accept).toBe(true)
    expect(v.confidence).toBe('schema')
  })
})

describe('shadow ne mijenja ishod', () => {
  test('nevaljana shema u shadowu → sud po starom (proznom) putu', () => {
    nacin('shadow')
    const v = evaluateCompletion(`Neki rad.\n\n${NEVALJAN}`)
    expect(v.confidence).not.toBe('schema')
    expect(v.code).not.toBe('schema_invalid')
    // Sud se ipak izračuna i zakači — inače se ne bi imalo što mjeriti.
    expect(v.stepSchema?.strojnoProvjerljiv).toBe(false)
    expect(v.stepSchema?.greske.length).toBeGreaterThan(0)
  })

  // TASK-4810: prije je ovaj slučaj NAMJERNO ostajao bez `stepSchema` — i time bez retka u
  // dnevniku. Mjereno 11.09.2026.: 15 od 18 zadataka bez bloka nije ostavilo nijedan trag,
  // pa je mjerilo vidjelo samo pokvarena polja. Ishod se i dalje ne mijenja (shadow), ali
  // se promašaj sada BROJI.
  test('bez sheme u shadowu: ishod nepromijenjen, ali sud JEST zakačen (nema_sheme se broji)', () => {
    nacin('shadow')
    const v = evaluateCompletion('Popravila sam /home/x/y.ts, bun test → 12 pass, 0 fail, commit 82575f0.')
    expect(v.confidence).not.toBe('schema')
    expect(v.code).not.toBe('schema_missing')
    expect(v.stepSchema?.kod).toBe('nema_sheme')
    expect(v.stepSchema?.strojnoProvjerljiv).toBe(false)
  })
})

describe('način on stvarno odbija', () => {
  test('nevaljana polja → schema_invalid + zamjerke su konkretne', () => {
    nacin('on')
    const v = evaluateCompletion(`Neki rad.\n\n${NEVALJAN}`)
    expect(v.accept).toBe(false)
    expect(v.code).toBe('schema_invalid')
    expect(v.confidence).toBe('schema')
    expect(v.reason).toContain('dokaz[0]')
    expect(v.reason).toContain('"napravljeno" je prekratko')
    expect(shouldEnforce(v, SJENA)).toBe(true)   // vlastiti prekidač, ne čeka prozni rollout
  })

  // W3b/TASK-4879: ova grana od 15.09.2026. traži VLASTITU zastavicu — `nacin: 'on'` sam
  // za sebe više ne odbija izostao blok (mjereno: 7/7 lažnih odbijanja, TASK-4874).
  test('nema bloka → schema_missing (uz provodiNedostajuci)', () => {
    nacin('on', true)
    const v = evaluateCompletion('Sve je napravljeno, testovi prolaze, bun test 12 pass u /home/x/y.ts.')
    expect(v.code).toBe('schema_missing')
    expect(v.suggestedStatus).toBe('blocked')
  })

  test('valjan blok prolazi i u načinu on', () => {
    nacin('on')
    expect(evaluateCompletion(VALJAN).accept).toBe(true)
  })
})

/**
 * W3b/TASK-4879 — GRANE SE PROVODE ODVOJENO.
 *
 * `nacin: 'on'` do danas znači „odbij i pokvaren i izostao blok". Mjerenje 15.09.2026.
 * (TASK-4874) pokazalo je da bi druga polovica bila 7/7 LAŽNIH odbijanja, a
 * `SpawnFinalizer` sud `confidence=schema` pretvara u status `blocked` — dakle ravno u
 * pogon, bez sjene. Zato:
 *   - `schema_invalid` ide s `nacin: 'on'` (tko je blok napisao, pravilo je VIDIO);
 *   - `schema_missing` traži JOŠ i `provodiNedostajuci: true`, pa i tada preskače
 *     zatvaranja koja blok nikad nisu nosila.
 */
describe('W3b · grana schema_invalid ide uživo, schema_missing ne', () => {
  test('nacin=on bez zastavice: nevaljan blok se i dalje odbija', () => {
    nacin('on')
    const v = evaluateCompletion(`Neki rad.\n\n${NEVALJAN}`)
    expect(v.code).toBe('schema_invalid')
    expect(shouldEnforce(v, SJENA)).toBe(true)
  })

  test('nacin=on bez zastavice: IZOSTAO blok NE odbija (sud se i dalje kači)', () => {
    nacin('on')
    const v = evaluateCompletion('Sve je napravljeno, testovi prolaze, bun test 12 pass u /home/x/y.ts.')
    expect(v.code).not.toBe('schema_missing')
    expect(v.confidence).not.toBe('schema')
    expect(v.stepSchema?.kod).toBe('nema_sheme')   // mjerilo i dalje vidi promašaj
  })

  test('nacin=on + provodiNedostajuci: izostao blok se odbija', () => {
    nacin('on', true)
    const v = evaluateCompletion('Sve je napravljeno, testovi prolaze, bun test 12 pass u /home/x/y.ts.')
    expect(v.code).toBe('schema_missing')
    expect(v.confidence).toBe('schema')
    expect(v.suggestedStatus).toBe('blocked')
  })

  test('valjan blok prolazi u obje postavke', () => {
    nacin('on', true)
    expect(evaluateCompletion(VALJAN).accept).toBe(true)
  })
})

/**
 * W3b · IZUZEĆE DOSEGA. Kontekst zatvaranja (tko zatvara, je li uopće bilo spawna) dolazi
 * od pozivatelja — `TaskWebUI` ga ima iz retka zadatka, `SpawnFinalizer` zna da je iza
 * teksta agentov spawn. Bez konteksta se ništa ne izuzima.
 */
describe('W3b · schema_missing preskače zatvaranja koja blok nisu nosila', () => {
  const BEZ_BLOKA = 'Restart izveden, RegocDaemon novi PID 1386990 u 15:31:40.'

  test('knjigovodstveno zatvaranje (start ≈ kraj) se ne odbija', () => {
    nacin('on', true)
    const v = evaluateCompletion(BEZ_BLOKA, {
      pocetoU: '2026-09-12T15:33:09.490Z', zavrsenoU: '2026-09-12T15:33:09.520Z',
    })
    expect(v.code).not.toBe('schema_missing')
    expect(v.izuzece?.izuzet).toBe(true)
    expect(v.izuzece?.kod).toBe('knjigovodstveno')
  })

  test('čovjekovo zatvaranje s ploče se ne odbija', () => {
    nacin('on', true)
    const v = evaluateCompletion(BEZ_BLOKA, { izvor: 'covjek' })
    expect(v.code).not.toBe('schema_missing')
    expect(v.izuzece?.kod).toBe('covjek')
  })

  test('sažetak koji piše orkestrator (oznaka bez-bloka) se ne odbija', () => {
    nacin('on', true)
    const v = evaluateCompletion(BEZ_BLOKA, { oznake: ['regocv51', OZNAKA_BEZ_BLOKA] })
    expect(v.code).not.toBe('schema_missing')
    expect(v.izuzece?.kod).toBe('oznaka')
  })

  test('pravi agentski spawn NIJE izuzet — njegov je prompt blok nosio', () => {
    nacin('on', true)
    const v = evaluateCompletion(BEZ_BLOKA, {
      izvor: 'agent',
      pocetoU: '2026-09-15T12:18:42.646Z', zavrsenoU: '2026-09-15T12:27:52.162Z',
    })
    expect(v.code).toBe('schema_missing')
    expect(v.izuzece?.izuzet).toBe(false)
  })

  test('izuzeće vrijedi SAMO za izostao blok — pokvaren blok se odbija i čovjeku', () => {
    nacin('on', true)
    const v = evaluateCompletion(`Neki rad.\n\n${NEVALJAN}`, { izvor: 'covjek' })
    expect(v.code).toBe('schema_invalid')
  })

  test('bez konteksta ostaje po starom: izostao blok se odbija kad je zastavica gore', () => {
    nacin('on', true)
    expect(evaluateCompletion(BEZ_BLOKA).code).toBe('schema_missing')
  })
})

describe('agentova izjava je iznad sheme', () => {
  test('REGOC-STATUS: BLOCKED + besprijekorna shema → i dalje blocked', () => {
    nacin('on')
    const v = evaluateCompletion(`${VALJAN}\n\nREGOC-STATUS: BLOCKED — čeka restart daemona`)
    expect(v.accept).toBe(false)
    expect(v.code).toBe('declared_not_done')
    expect(v.confidence).toBe('declared')
  })
})

describe('način off vraća stari put doslovno', () => {
  test('ni valjana shema ne mijenja pouzdanost kad je mehanizam ugašen', () => {
    nacin('off')
    const v = evaluateCompletion(`${VALJAN}\n\nREGOC-STATUS: DONE — isporučeno`)
    expect(v.confidence).toBe('declared')   // stari put: deklaracija + duljina
    expect(v.stepSchema).toBeUndefined()
  })
})
