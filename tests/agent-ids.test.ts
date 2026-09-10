/**
 * Brana: popis dopuštenih nositelja zadatka je PODATAK, ne kod (nalaz N1 iz
 * `docs/QA_E2E_SAMOSTALNOST_2026-09-10.md`).
 *
 * ŠTO SE OVDJE DOKAZUJE. Do 10.09.2026. je `AgentIdSchema` bio zatvoren `z.enum` s imenima
 * NAŠIH jedanaest agenata, pa je svježa instalacija odbijala svako tuđe ime
 * (`POST /api/tasks {"assignee":"ana"}` → 400 `invalid_enum_value`), iako INSTALL.md i
 * README obećavaju vlastiti tim. Testovi niže drže tri svojstva:
 *
 *   1. bez ijedne postavke ime tima NIJE ograničeno našim imenima (svježa instalacija radi);
 *   2. s registrom (`config/agents.json`) ili `TM_AGENTS` popis postaje ZATVOREN — tipfeler
 *      se hvata, jer tada izvor istine postoji;
 *   3. `user` i `scheduler` vrijede uvijek — njih piše sama jezgra, ne korisnik.
 *
 * Autorica: Kosjenka (Architect), TASK-4808.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  OBLIK_AGENT_ID,
  SUSTAVSKI_AGENTI,
  dopusteniAgenti,
  jeDopustenAgent,
  osvjeziDopusteneAgente,
} from '../src/core/AgentIds'
import { AgentIdSchema, CreateTaskInputSchema } from '../src/zod/schemas/task'

let radna: string
let staroOkruzje: Record<string, string | undefined>

/** Svaki test kreće od čistog okruženja — inače postavka jednog curi u drugi. */
beforeEach(() => {
  radna = mkdtempSync(join(tmpdir(), 'tm-agent-ids-'))
  staroOkruzje = {
    TM_AGENTS: process.env.TM_AGENTS,
    TM_AGENTS_CONFIG: process.env.TM_AGENTS_CONFIG,
    TM_HOME: process.env.TM_HOME,
  }
  delete process.env.TM_AGENTS
  // Registar paketa (`config/agents.json`) na razvojnom stroju MOŽE postojati; test mora
  // pokazivati na svoj, prazan, inače ishod ovisi o tome tko je što lokalno kopirao.
  process.env.TM_AGENTS_CONFIG = join(radna, 'agents.json')
  delete process.env.TM_HOME
  osvjeziDopusteneAgente()
})

afterEach(() => {
  for (const [k, v] of Object.entries(staroOkruzje)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  osvjeziDopusteneAgente()
  rmSync(radna, { recursive: true, force: true })
})

function upisiRegistar(ids: string[]) {
  writeFileSync(
    join(radna, 'agents.json'),
    JSON.stringify({ agents: ids.map(id => ({ id, keywords: [] })) }),
  )
  osvjeziDopusteneAgente()
}

describe('svježa instalacija (nema registra, nema TM_AGENTS)', () => {
  test('popis NIJE zatvoren — nema izvora istine, pa se provjerava samo oblik imena', () => {
    const r = dopusteniAgenti()
    expect(r.strogo).toBe(false)
    expect(r.izvori).toEqual([])
  })

  test('proizvoljno tuđe ime prolazi', () => {
    expect(jeDopustenAgent('ana')).toBe(true)
    expect(jeDopustenAgent('ivan')).toBe(true)
    expect(AgentIdSchema.safeParse('marko').success).toBe(true)
  })

  test('naša imena nemaju povlasticu (nisu ugrađena kao zadani popis)', () => {
    const r = dopusteniAgenti()
    expect(r.popis).not.toContain('kosjenka')
    expect(r.popis).not.toContain('regoc')
  })

  test('neispravan OBLIK i dalje pada (prazno, razmaci, put, predugo)', () => {
    for (const lose of ['', '   ', 'ana ivan', '../etc/passwd', 'a'.repeat(64), '1ana', 'ANA!']) {
      expect(AgentIdSchema.safeParse(lose).success).toBe(false)
    }
  })
})

describe('registar `config/agents.json` (TM_AGENTS_CONFIG) zatvara popis', () => {
  test('id-evi iz registra prolaze, ostalo pada', () => {
    upisiRegistar(['ana', 'ivan'])
    const r = dopusteniAgenti()
    expect(r.strogo).toBe(true)
    expect(r.izvori).toContain('registar')
    expect(jeDopustenAgent('ana')).toBe(true)
    expect(jeDopustenAgent('marko')).toBe(false)
  })

  test('tipfeler u nositelju se hvata i poruka nabraja dopuštena imena', () => {
    upisiRegistar(['ana', 'ivan'])
    const r = CreateTaskInputSchema.safeParse({ title: 'proba', assignee: 'anna' })
    expect(r.success).toBe(false)
    const poruka = r.success ? '' : r.error.issues.map(i => i.message).join(' ')
    expect(poruka).toContain('anna')
    expect(poruka).toContain('ana')
    expect(poruka).toContain('ivan')
  })

  test('naša imena NE prolaze u tuđoj instalaciji', () => {
    upisiRegistar(['ana'])
    expect(jeDopustenAgent('kosjenka')).toBe(false)
  })

  test('registar nastao POSLIJE pokretanja ploče vrijedi (bez restarta)', () => {
    expect(jeDopustenAgent('ana')).toBe(true)   // svježe stanje: sve prolazi
    upisiRegistar(['ivan'])
    expect(jeDopustenAgent('ana')).toBe(false)  // registar sada postoji i zatvara popis
    expect(jeDopustenAgent('ivan')).toBe(true)
  })

  test('neispravan JSON = kao da registra nema (ploča ne smije stati)', () => {
    writeFileSync(join(radna, 'agents.json'), '{ ovo nije json')
    osvjeziDopusteneAgente()
    expect(dopusteniAgenti().strogo).toBe(false)
    expect(jeDopustenAgent('ana')).toBe(true)
  })
})

describe('TM_AGENTS (popis odvojen zarezom) iz INSTALL.md §5.1', () => {
  test('radi točno kako dokumentacija obećava', () => {
    process.env.TM_AGENTS = 'ana,ivan,marko'
    osvjeziDopusteneAgente()
    const r = dopusteniAgenti()
    expect(r.strogo).toBe(true)
    expect(r.izvori).toContain('TM_AGENTS')
    expect(r.popis).toEqual(['ana', 'ivan', 'marko', 'scheduler', 'user'])
    expect(jeDopustenAgent('ana')).toBe(true)
    expect(jeDopustenAgent('kosjenka')).toBe(false)
  })

  test('razmaci, prazne stavke i velika slova se podnose', () => {
    process.env.TM_AGENTS = ' Ana , ,IVAN, '
    osvjeziDopusteneAgente()
    expect(jeDopustenAgent('ana')).toBe(true)
    expect(jeDopustenAgent('Ivan')).toBe(true)
    expect(dopusteniAgenti().popis).not.toContain('')
  })

  test('UNIJA s registrom — orkestratorov agent ne smije ispasti iz popisa (dvije istine)', () => {
    upisiRegistar(['assistant'])
    process.env.TM_AGENTS = 'ana'
    osvjeziDopusteneAgente()
    expect(jeDopustenAgent('assistant')).toBe(true)
    expect(jeDopustenAgent('ana')).toBe(true)
    expect(dopusteniAgenti().izvori.sort()).toEqual(['TM_AGENTS', 'registar'])
  })
})

describe('sustavski nositelji', () => {
  test('`user` i `scheduler` vrijede i kad ih nitko ne navede', () => {
    process.env.TM_AGENTS = 'ana'
    osvjeziDopusteneAgente()
    for (const id of SUSTAVSKI_AGENTI) expect(jeDopustenAgent(id)).toBe(true)
  })
})

describe('oblik imena', () => {
  test('OBLIK_AGENT_ID prima uobičajena imena, odbija putanje i razmake', () => {
    expect(OBLIK_AGENT_ID.test('ana')).toBe(true)
    expect(OBLIK_AGENT_ID.test('ana_2')).toBe(true)
    expect(OBLIK_AGENT_ID.test('tim-a')).toBe(true)
    expect(OBLIK_AGENT_ID.test('a/b')).toBe(false)
    expect(OBLIK_AGENT_ID.test('a b')).toBe(false)
  })
})
