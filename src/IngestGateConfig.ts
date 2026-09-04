/**
 * IngestGateConfig — ulazna vrata za Telegram poruke (U1, TASK-4261).
 *
 * Razrada: `~/app/regoc_system/docs/RAZRADA-3691_workflow_i_pragovi.md` §1.
 * Goranova odluka 04.09.2026.: prekidač s TRI položaja po grupi, ne kvačica —
 * dvopoložajna kvačica ne pokriva uvođenje u sjeni.
 *
 *   off    — kao danas: poruka ide izravno u `claude -p`, ploča se ne dira
 *   shadow — poruka ide kao danas, ali se ZAPISUJE što bi se otvorilo (zadatak, projekt, težina)
 *   on     — poruka ide kroz ploču: zadatak → projekt → izvršitelj → trošak
 *
 * ZAŠTO BEZ RESTARTA: datoteku čitaju i `telegram_agent.ts` i TaskWebUI pri svakom prolazu.
 * Zato ovaj modul NE SMIJE uvesti keš — keš bi bio jedina stvar koja bi tražila restart
 * (ista pouka kao kod `DezurniConfig`).
 *
 * Autor: Jelena (Engineer), TASK-4261.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export const INGEST_GATE_CONFIG_PATH = join(
  process.env.HOME || '/home/klaudio', '.claude/regoc/config/ingest-gate.json')

export type Nacin = 'off' | 'shadow' | 'on'
export const NACINI: readonly Nacin[] = ['off', 'shadow', 'on'] as const

export interface IngestGatePostavke {
  /** Globalna sklopka. `false` = sve grupe se ponašaju kao `off`, bez obzira na perGroup. */
  enabled: boolean
  perGroup: Record<string, Nacin>
  projectByGroup: Record<string, string>
  /** Prag A — otvara li se zadatak (težina ≥ 16, tj. E2). */
  pragA: number
  /** Prag B — ide li se u puni lanac (težina ≥ 36, tj. E3). */
  pragB: number
  /** Prag C — traži li se Goranova potvrda plana (težina ≥ 81, tj. E5). */
  pragC: number
}

/** Poznate grupe — samo za prikaz na ploči; postavke rade i za chatId koji ovdje ne piše. */
export const POZNATE_GRUPE: Record<string, string> = {
  '-5161938429': 'REGOČ',
  '-5245252755': 'IntergalaktikSportAI',
}

/** Zadano stanje je NEUKLJUČENO: U1 uvodi prekidač, ne pali autonomiju (vidi §0.2, TASK-4267). */
export const ZADANE_POSTAVKE: IngestGatePostavke = {
  enabled: false,
  perGroup: { '-5161938429': 'off', '-5245252755': 'off' },
  projectByGroup: { '-5161938429': 'REGOC_SYSTEM', '-5245252755': 'PRJ-034' },
  pragA: 16,
  pragB: 36,
  pragC: 81,
}

export const GRANICE = {
  pragA: { min: 1, max: 100 },
  pragB: { min: 1, max: 100 },
  pragC: { min: 1, max: 100 },
} as const

const RE_CHAT_ID = /^-?\d{5,20}$/
const RE_PROJEKT = /^[A-Za-z0-9_\-]{2,40}$/

function ociscenaMapaNacina(sirovo: unknown): Record<string, Nacin> | null {
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return null
  const izlaz: Record<string, Nacin> = {}
  for (const [k, v] of Object.entries(sirovo as Record<string, unknown>)) {
    if (RE_CHAT_ID.test(k) && NACINI.includes(v as Nacin)) izlaz[k] = v as Nacin
  }
  return izlaz
}

function ociscenaMapaProjekata(sirovo: unknown): Record<string, string> | null {
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return null
  const izlaz: Record<string, string> = {}
  for (const [k, v] of Object.entries(sirovo as Record<string, unknown>)) {
    if (RE_CHAT_ID.test(k) && typeof v === 'string' && RE_PROJEKT.test(v.trim())) izlaz[k] = v.trim()
  }
  return izlaz
}

function cijeliBrojUGranici(v: unknown, g: { min: number; max: number }): number | null {
  const n = Number(v)
  if (!Number.isInteger(n) || n < g.min || n > g.max) return null
  return n
}

/**
 * Uvijek svjež pročitaj s diska. Pokvarena ili nepostojeća datoteka vraća zadane postavke —
 * ulazna vrata koja bacaju iznimku zaustavila bi Telegram most, a zadano je ionako `off`.
 */
export function loadIngestGateConfig(path: string = INGEST_GATE_CONFIG_PATH): IngestGatePostavke {
  let sirovo: any
  try {
    sirovo = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return { ...ZADANE_POSTAVKE, perGroup: { ...ZADANE_POSTAVKE.perGroup }, projectByGroup: { ...ZADANE_POSTAVKE.projectByGroup } }
  }
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) {
    return { ...ZADANE_POSTAVKE, perGroup: { ...ZADANE_POSTAVKE.perGroup }, projectByGroup: { ...ZADANE_POSTAVKE.projectByGroup } }
  }
  return {
    enabled: typeof sirovo.enabled === 'boolean' ? sirovo.enabled : ZADANE_POSTAVKE.enabled,
    perGroup: ociscenaMapaNacina(sirovo.perGroup) ?? { ...ZADANE_POSTAVKE.perGroup },
    projectByGroup: ociscenaMapaProjekata(sirovo.projectByGroup) ?? { ...ZADANE_POSTAVKE.projectByGroup },
    pragA: cijeliBrojUGranici(sirovo.pragA, GRANICE.pragA) ?? ZADANE_POSTAVKE.pragA,
    pragB: cijeliBrojUGranici(sirovo.pragB, GRANICE.pragB) ?? ZADANE_POSTAVKE.pragB,
    pragC: cijeliBrojUGranici(sirovo.pragC, GRANICE.pragC) ?? ZADANE_POSTAVKE.pragC,
  }
}

export interface Provjera {
  ok: boolean
  greske: string[]
  zakrpa: Partial<IngestGatePostavke>
}

/**
 * Provjeri zakrpu s ploče. Prihvaća SAMO poznata polja — tipfeler u imenu polja tiho bi
 * stvorio mrtvu postavku koju nitko ne čita (isti kvar koji je gutao `progress_notes`).
 *
 * Mape se šalju djelomično (ploča mijenja jednu grupu), pa se spajaju po ključu;
 * `null` kao vrijednost briše grupu iz mape.
 *
 * `trenutno` služi samo za provjeru poretka pragova — prag B poslan sam mora se moći
 * usporediti s pragom A koji već stoji na disku.
 */
export function validateIngestGatePatch(
  tijelo: unknown,
  trenutno: IngestGatePostavke = ZADANE_POSTAVKE,
): Provjera {
  const greske: string[] = []
  const zakrpa: Record<string, unknown> = {}
  if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
    return { ok: false, greske: ['Očekivan je JSON objekt s postavkama'], zakrpa: {} }
  }
  const t = tijelo as Record<string, unknown>
  const dopustena = Object.keys(ZADANE_POSTAVKE)
  for (const kljuc of Object.keys(t)) {
    if (!dopustena.includes(kljuc)) {
      greske.push(`Nepoznato polje: ${kljuc} (dopušteno: ${dopustena.join(', ')})`)
    }
  }

  if ('enabled' in t) {
    if (typeof t.enabled !== 'boolean') greske.push('enabled mora biti true ili false')
    else zakrpa.enabled = t.enabled
  }

  if ('perGroup' in t) {
    const v = t.perGroup
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      greske.push('perGroup mora biti objekt {"<chatId>": "off"|"shadow"|"on"}')
    } else {
      const spojeno: Record<string, Nacin> = { ...trenutno.perGroup }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!RE_CHAT_ID.test(k)) { greske.push(`perGroup: neispravan chatId "${k}"`); continue }
        if (val === null) { delete spojeno[k]; continue }
        if (!NACINI.includes(val as Nacin)) {
          greske.push(`perGroup["${k}"] mora biti jedan od: ${NACINI.join(', ')}`); continue
        }
        spojeno[k] = val as Nacin
      }
      zakrpa.perGroup = spojeno
    }
  }

  if ('projectByGroup' in t) {
    const v = t.projectByGroup
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      greske.push('projectByGroup mora biti objekt {"<chatId>": "<PRJ-ID>"}')
    } else {
      const spojeno: Record<string, string> = { ...trenutno.projectByGroup }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!RE_CHAT_ID.test(k)) { greske.push(`projectByGroup: neispravan chatId "${k}"`); continue }
        if (val === null || val === '') { delete spojeno[k]; continue }
        const p = String(val).trim()
        if (!RE_PROJEKT.test(p)) {
          greske.push(`projectByGroup["${k}"]: projectId smije imati samo slova, brojke, - i _ (2-40 znakova)`)
          continue
        }
        spojeno[k] = p
      }
      zakrpa.projectByGroup = spojeno
    }
  }

  for (const kljuc of ['pragA', 'pragB', 'pragC'] as const) {
    if (kljuc in t) {
      const n = cijeliBrojUGranici(t[kljuc], GRANICE[kljuc])
      if (n === null) greske.push(`${kljuc} mora biti cijeli broj ${GRANICE[kljuc].min}-${GRANICE[kljuc].max}`)
      else zakrpa[kljuc] = n
    }
  }

  // Pragovi su ljestvica: A (otvori zadatak) ≤ B (puni lanac) ≤ C (potvrda plana).
  // Obrnut poredak nije samo ružan — prag B ispod praga A značio bi puni lanac za posao
  // za koji se zadatak uopće ne otvara.
  const a = (zakrpa.pragA as number) ?? trenutno.pragA
  const b = (zakrpa.pragB as number) ?? trenutno.pragB
  const c = (zakrpa.pragC as number) ?? trenutno.pragC
  if (!(a <= b && b <= c)) {
    greske.push(`Pragovi moraju rasti: pragA (${a}) <= pragB (${b}) <= pragC (${c})`)
  }

  if (!greske.length && !Object.keys(zakrpa).length) greske.push('Nijedna postavka nije poslana')
  return { ok: greske.length === 0, greske, zakrpa: zakrpa as Partial<IngestGatePostavke> }
}

/**
 * Spoji zakrpu s onim što je na disku i zapiši. Zapis ide preko privremene datoteke pa
 * `rename` — most čita datoteku pri svakoj poruci, a napola zapisan JSON značio bi da
 * upravo tada padne na zadane vrijednosti (dakle: tiho na `off`).
 */
export function saveIngestGateConfig(
  zakrpa: Partial<IngestGatePostavke>,
  path: string = INGEST_GATE_CONFIG_PATH,
): IngestGatePostavke {
  const novo: IngestGatePostavke = { ...loadIngestGateConfig(path), ...zakrpa }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  return novo
}

/**
 * Djelatni način za grupu — jedina funkcija koju pozivatelji (most, daemon) trebaju.
 * Globalna sklopka gasi sve; nepoznata grupa je `off` (nova grupa ne smije sama krenuti).
 */
export function nacinZaGrupu(cfg: IngestGatePostavke, chatId: string | number): Nacin {
  if (!cfg.enabled) return 'off'
  return cfg.perGroup[String(chatId)] ?? 'off'
}

/** Zadani projekt grupe; prazno ako grupa nije upisana (pozivatelj tada pada na PRJ-033). */
export function projektZaGrupu(cfg: IngestGatePostavke, chatId: string | number): string | null {
  return cfg.projectByGroup[String(chatId)] ?? null
}
