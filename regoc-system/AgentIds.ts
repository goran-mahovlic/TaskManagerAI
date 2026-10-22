/**
 * AgentIds — tko smije biti nositelj zadatka. Popis je PODATAK (REGOC_AGENTS.json), ne kod.
 *
 * KVAR KOJI OVO ZATVARA (TASK-5547, Goran 16.10.2026.): `zod/schemas/task.ts` je imao
 * tvrdo upisan `z.enum` s 14 imena, pa je `POST /api/tasks {"assignee":"emard"}` vraćao
 * `400 invalid_value` iako je emard u registru od v1.2.0. Isti obrazac kao TaskManagerAI
 * paket (`src/core/AgentIds.ts`, TASK-4808), uz dvije razlike za naš pogon:
 *
 *   1. izvor je `~/.claude/regoc/REGOC_AGENTS.json` (SSOT, CLAUDE.md), uz ne-agente
 *      `pai`, `user` i `scheduler` koje upisuje sam sustav;
 *   2. FAIL-SAFE, ne fail-open: nevaljan/nedostupan registar → ZADNJI POZNATI popis
 *      (`data/agenti_zadnji_poznati.json`, piše se pri svakom dobrom čitanju), a bez
 *      njega ugrađeni popis niže. Popis nikad nije prazan i nikad „sve prolazi".
 *
 * Registar se čita ponovo nakon kratkog roka (5 s) — novi agent u registru vrijedi bez
 * restarta ploče, a datoteka se ne čita po svakom polju sheme.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

/** Nositelji koje upisuje sam sustav — vrijede neovisno o registru. */
export const NE_AGENTI = ['pai', 'user', 'scheduler'] as const

/** Kanali i sustavski agenti — nisu radnici (isti skup kao AgentSelection/AgentRouting). */
export const KANAL_I_SUSTAV = new Set(['klaudio', 'stribor', 'regoc', 'kriticar'])

/** Zadnja rezerva kad nema ni registra ni zapisa: stanje registra v1.8.0 (16.10.2026.). */
export const UGRADJENI_AGENTI: readonly string[] = [
  'regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena', 'malik', 'manda',
  'dora', 'gita', 'grga', 'potjeh', 'emard', 'kriticar',
]

/** Higijena imena: završava u putanjama, SQL-u i porukama. */
export const OBLIK_AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/

export type IzvorPopisa = 'registar' | 'zadnji-poznati' | 'ugradjeni'

export interface RazrijeseniAgenti {
  /** Agenti iz izvora, redoslijedom registra (bez ne-agenata). */
  agenti: string[]
  /** Radnici: `agenti` bez kanala/sustava i bez `enabled: false`. */
  radnici: string[]
  /** Dopuštena imena nositelja: `agenti` + ne-agenti. */
  popis: string[]
  izvor: IzvorPopisa
}

const ROK_MS = 5000
let predmemorija: { u: number; r: RazrijeseniAgenti } | null = null

export function registarPutanja(): string {
  return process.env.REGOC_AGENTS_PATH || join(process.env.HOME || homedir(), '.claude/regoc/REGOC_AGENTS.json')
}

export function zadnjiPoznatiPutanja(): string {
  return process.env.REGOC_AGENTI_ZADNJI || join(process.env.HOME || homedir(), '.claude/regoc/data/agenti_zadnji_poznati.json')
}

/** Zaboravi predmemoriju (test, ili svjesno ponovno čitanje). */
export function osvjeziAgente(): void {
  predmemorija = null
}

type Zapis = { agenti: string[]; radnici: string[] }

function citajRegistar(): Zapis | null {
  try {
    const reg = JSON.parse(readFileSync(registarPutanja(), 'utf-8'))
    const a = reg?.agents
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null
    const agenti: string[] = []
    const radnici: string[] = []
    for (const [kljuc, v] of Object.entries(a as Record<string, any>)) {
      const id = String(v?.id ?? kljuc).trim().toLowerCase()
      if (!OBLIK_AGENT_ID.test(id) || agenti.includes(id)) continue
      agenti.push(id)
      if (!KANAL_I_SUSTAV.has(id) && v?.enabled !== false) radnici.push(id)
    }
    return agenti.length ? { agenti, radnici } : null
  } catch {
    return null
  }
}

function citajZadnji(): Zapis | null {
  try {
    const z = JSON.parse(readFileSync(zadnjiPoznatiPutanja(), 'utf-8'))
    const agenti = Array.isArray(z?.agenti) ? z.agenti.map(String).filter((s: string) => OBLIK_AGENT_ID.test(s)) : []
    const radnici = Array.isArray(z?.radnici) ? z.radnici.map(String).filter((s: string) => agenti.includes(s)) : []
    return agenti.length ? { agenti, radnici } : null
  } catch {
    return null
  }
}

/** Atomičan zapis, samo kad se nešto promijenilo; neuspjeh zapisa ne ruši provjeru. */
function zapisiZadnji(z: Zapis): void {
  const put = zadnjiPoznatiPutanja()
  try {
    const stari = existsSync(put) ? citajZadnji() : null
    if (stari && JSON.stringify(stari) === JSON.stringify(z)) return
    mkdirSync(dirname(put), { recursive: true })
    const tmp = `${put}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...z, izvor: registarPutanja(), zapisano: new Date().toISOString() }, null, 2))
    renameSync(tmp, put)
  } catch { /* fail-safe: popis u memoriji vrijedi i bez zapisa */ }
}

/** Razriješi popis: registar → zadnji poznati → ugrađeni. */
export function dopusteniAgenti(): RazrijeseniAgenti {
  const sada = Date.now()
  if (predmemorija && sada - predmemorija.u < ROK_MS) return predmemorija.r

  let izvor: IzvorPopisa = 'registar'
  let z = citajRegistar()
  if (z) zapisiZadnji(z)
  else {
    z = citajZadnji()
    izvor = 'zadnji-poznati'
    if (!z) {
      izvor = 'ugradjeni'
      const agenti = [...UGRADJENI_AGENTI]
      z = { agenti, radnici: agenti.filter(a => !KANAL_I_SUSTAV.has(a)) }
    }
  }

  const r: RazrijeseniAgenti = {
    agenti: z.agenti,
    radnici: z.radnici,
    popis: [...new Set([...z.agenti, ...NE_AGENTI])],
    izvor,
  }
  predmemorija = { u: sada, r }
  return r
}

/** Smije li `id` biti nositelj zadatka/poruke? Ne razlikuje velika i mala slova. */
export function jeDopustenAgent(id: string): boolean {
  const ime = String(id ?? '').trim().toLowerCase()
  return OBLIK_AGENT_ID.test(ime) && dopusteniAgenti().popis.includes(ime)
}

/** Radnici za raspoređivač (bez kanala/sustava i onemogućenih), redoslijedom registra. */
export function radniAgenti(): string[] {
  return [...dopusteniAgenti().radnici]
}

/** Poruka za 400: što je krivo i gdje se popis mijenja. */
export function objasnjenjeOdbijenogAgenta(id: string): string {
  const ime = String(id ?? '').trim()
  const r = dopusteniAgenti()
  return `nositelj „${ime}" nije na popisu agenata [${r.popis.join(', ')}]; `
    + `popis dolazi iz REGOC_AGENTS.json (izvor: ${r.izvor}) — dopiši agenta ondje ili ispravi ime`
}
