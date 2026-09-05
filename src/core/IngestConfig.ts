/**
 * IngestConfig — postavke generičkog ulaza `POST /api/ingest` (U6 / TASK-4266).
 *
 * Razrada: `docs/RAZRADA-3691_workflow_i_pragovi.md` §1 (položaji) i §2 (pragovi).
 *
 * ŠTO SE OVDJE PROMIJENILO U ODNOSU NA U1. Prvotna izvedba znala je samo za Telegram:
 * ključ postavke bio je `chatId`, a provjera je odbijala sve što nije niz od 5–20 znamenki.
 * Paket ne smije poznavati nijedan kanal, pa je ključ sada **izvor**: `email`,
 * `telegram:-5161938429`, `konzola`, ili `*` za sve. Stari zapis (`perGroup`,
 * `projectByGroup`) i dalje se čita — inače bi nadogradnja tiho vratila sve grupe na `off`.
 *
 * GDJE ŽIVI DATOTEKA (istim redom kojim se traži):
 *   1. `$TM_INGEST_GATE_CONFIG` — puna putanja, za instalaciju koja drži postavke drugdje;
 *   2. `$TM_HOME/config/ingest-gate.json` — uz bazu, ako je `TM_HOME` postavljen;
 *   3. `config/ingest-gate.json` uz sam paket — zadano, radi bez ijedne varijable okoline.
 * Nigdje se ne spominje `~/.claude/regoc`: paket mora raditi i na stroju na kojem REGOČ
 * uopće nije instaliran (prihvatni kriterij U6).
 *
 * ZAŠTO BEZ KEŠA: datoteku čita svaki poziv `/api/ingest`. Keš bi bio jedina stvar koja bi
 * tražila ponovno pokretanje poslužitelja nakon pomicanja praga na ploči.
 *
 * Autorica: Jelena (Engineer), TASK-4266.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// ─── Gdje je datoteka ────────────────────────────────────────────────────────

/** Korijen paketa (`src/core/..` → `src/..` → paket). */
const PAKET_DIR = join(import.meta.dir, '..', '..')

function zadanaPutanja(): string {
  if (process.env.TM_INGEST_GATE_CONFIG) return process.env.TM_INGEST_GATE_CONFIG
  if (process.env.TM_HOME) {
    const uzBazu = join(process.env.TM_HOME, 'config', 'ingest-gate.json')
    if (existsSync(uzBazu)) return uzBazu
  }
  return join(PAKET_DIR, 'config', 'ingest-gate.json')
}

export const INGEST_CONFIG_PATH: string = zadanaPutanja()

// ─── Oblik postavki ──────────────────────────────────────────────────────────

export type Nacin = 'off' | 'shadow' | 'on'
export const NACINI: readonly Nacin[] = ['off', 'shadow', 'on'] as const

export interface IngestPostavke {
  /** Globalna sklopka. `false` = svi izvori se ponašaju kao `off`. */
  enabled: boolean
  /** Položaj po izvoru: `"email"`, `"telegram:-123"`, `"*"`. */
  perSource: Record<string, Nacin>
  /** Zadani projekt po izvoru, istim ključevima kao `perSource`. */
  projectBySource: Record<string, string>
  /** Projekt kad nijedan ključ ne odgovara — pretinac, nikad `null`. */
  defaultProject: string
  /** Prag A — otvara li se zadatak (zadano: težina ≥ 16, tj. E2). */
  pragA: number
  /** Prag B — ide li se u puni lanac (zadano: ≥ 36, tj. E3). */
  pragB: number
  /** Prag C — traži li se ljudska potvrda plana (zadano: ≥ 81, tj. E5). */
  pragC: number
  /** ZRCALO starih naziva; ploča ih još čita. Izvedeno pri čitanju, ne sprema se. */
  perGroup: Record<string, Nacin>
  projectByGroup: Record<string, string>
}

/**
 * Zadano stanje: ulaz JEST upaljen, ali samo kao HTTP poziv koji netko mora napraviti.
 * (U živoj REGOČ instalaciji zadano je `off` jer ondje iza ulaza stoji automatsko
 * pokretanje agenata; u paketu iza njega ne stoji ništa osim zapisa na ploči.)
 */
export const ZADANE_POSTAVKE: IngestPostavke = {
  enabled: true,
  perSource: { '*': 'on' },
  projectBySource: {},
  defaultProject: 'PRJ-033',
  pragA: 16,
  pragB: 36,
  pragC: 81,
  perGroup: { '*': 'on' },
  projectByGroup: {},
}

export const GRANICE = {
  pragA: { min: 1, max: 100 },
  pragB: { min: 1, max: 100 },
  pragC: { min: 1, max: 100 },
} as const

/** Ključ izvora: `email`, `telegram:-5161938429`, stari goli `chatId`, ili `*`. */
const RE_KLJUC = /^(\*|[A-Za-z0-9_.@+\-]{1,64}(:[A-Za-z0-9_.@+\-]{1,64})?)$/
const RE_PROJEKT = /^[A-Za-z0-9_\-]{2,40}$/

/**
 * Ključevi kojima se traži postavka, od najužeg prema najširem.
 * Goli `externalId` je ovdje zbog starog zapisa u kojem je ključ bio samo `chatId`.
 */
export function kljuceviIzvora(source: string, externalId?: string | number | null): string[] {
  const s = String(source || '').trim()
  const e = externalId == null ? '' : String(externalId).trim()
  const k: string[] = []
  if (s && e) k.push(`${s}:${e}`)
  if (e) k.push(e)
  if (s) k.push(s)
  k.push('*')
  return k
}

function prvaVrijednost<T>(mapa: Record<string, T>, kljucevi: string[]): T | null {
  for (const k of kljucevi) if (Object.prototype.hasOwnProperty.call(mapa, k)) return mapa[k]!
  return null
}

// ─── Čitanje ─────────────────────────────────────────────────────────────────

function ociscenaMapaNacina(sirovo: unknown): Record<string, Nacin> {
  const izlaz: Record<string, Nacin> = {}
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return izlaz
  for (const [k, v] of Object.entries(sirovo as Record<string, unknown>)) {
    if (RE_KLJUC.test(k) && NACINI.includes(v as Nacin)) izlaz[k] = v as Nacin
  }
  return izlaz
}

function ociscenaMapaProjekata(sirovo: unknown): Record<string, string> {
  const izlaz: Record<string, string> = {}
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return izlaz
  for (const [k, v] of Object.entries(sirovo as Record<string, unknown>)) {
    if (RE_KLJUC.test(k) && typeof v === 'string' && RE_PROJEKT.test(v.trim())) izlaz[k] = v.trim()
  }
  return izlaz
}

function cijeliBrojUGranici(v: unknown, g: { min: number; max: number }): number | null {
  const n = Number(v)
  if (!Number.isInteger(n) || n < g.min || n > g.max) return null
  return n
}

function zadano(): IngestPostavke {
  return {
    ...ZADANE_POSTAVKE,
    perSource: { ...ZADANE_POSTAVKE.perSource },
    projectBySource: { ...ZADANE_POSTAVKE.projectBySource },
    perGroup: { ...ZADANE_POSTAVKE.perSource },
    projectByGroup: { ...ZADANE_POSTAVKE.projectBySource },
  }
}

/**
 * Uvijek svjež pročitaj s diska. Pokvarena ili nepostojeća datoteka vraća zadane
 * postavke — ulaz koji baca iznimku zaustavio bi pozivatelja, a to je gore od zadanih
 * vrijednosti koje su ionako konzervativne.
 */
export function loadIngestConfig(path: string = INGEST_CONFIG_PATH): IngestPostavke {
  let sirovo: any
  try {
    sirovo = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return zadano()
  }
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return zadano()

  // Stari nazivi se SPAJAJU, ne zamjenjuju: instalacija koja je nadograđena usred rada
  // ima u datoteci `perGroup`, a nove postavke dolaze kao `perSource`.
  const perSource = { ...ociscenaMapaNacina(sirovo.perGroup), ...ociscenaMapaNacina(sirovo.perSource) }
  const projectBySource = {
    ...ociscenaMapaProjekata(sirovo.projectByGroup),
    ...ociscenaMapaProjekata(sirovo.projectBySource),
  }
  const dp = typeof sirovo.defaultProject === 'string' && RE_PROJEKT.test(sirovo.defaultProject.trim())
    ? sirovo.defaultProject.trim() : ZADANE_POSTAVKE.defaultProject

  return {
    enabled: typeof sirovo.enabled === 'boolean' ? sirovo.enabled : ZADANE_POSTAVKE.enabled,
    perSource: Object.keys(perSource).length ? perSource : { ...ZADANE_POSTAVKE.perSource },
    projectBySource,
    defaultProject: dp,
    pragA: cijeliBrojUGranici(sirovo.pragA, GRANICE.pragA) ?? ZADANE_POSTAVKE.pragA,
    pragB: cijeliBrojUGranici(sirovo.pragB, GRANICE.pragB) ?? ZADANE_POSTAVKE.pragB,
    pragC: cijeliBrojUGranici(sirovo.pragC, GRANICE.pragC) ?? ZADANE_POSTAVKE.pragC,
    // Zrcalo za ploču — izvedeno, ne drugi izvor istine.
    perGroup: Object.keys(perSource).length ? perSource : { ...ZADANE_POSTAVKE.perSource },
    projectByGroup: projectBySource,
  }
}

// ─── Provjera zakrpe s ploče ─────────────────────────────────────────────────

export interface Provjera {
  ok: boolean
  greske: string[]
  zakrpa: Partial<IngestPostavke>
}

/** Polja koja se smiju slati. Zrcala (`perGroup`) se PRIMAJU, ali se spremaju kao `perSource`. */
const DOPUSTENA = ['enabled', 'perSource', 'projectBySource', 'defaultProject', 'pragA', 'pragB', 'pragC',
  'perGroup', 'projectByGroup'] as const

/**
 * Provjeri zakrpu. Prihvaća SAMO poznata polja — tipfeler u imenu tiho bi stvorio mrtvu
 * postavku koju nitko ne čita (isti kvar koji je gutao `progress_notes`).
 *
 * Mape se šalju djelomično (ploča mijenja jedan izvor), pa se spajaju po ključu;
 * `null` kao vrijednost briše ključ.
 */
export function validateIngestPatch(
  tijelo: unknown,
  trenutno: IngestPostavke = ZADANE_POSTAVKE,
): Provjera {
  const greske: string[] = []
  const zakrpa: Record<string, unknown> = {}
  if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
    return { ok: false, greske: ['Očekivan je JSON objekt s postavkama'], zakrpa: {} }
  }
  const t = tijelo as Record<string, unknown>
  for (const kljuc of Object.keys(t)) {
    if (!(DOPUSTENA as readonly string[]).includes(kljuc)) {
      greske.push(`Nepoznato polje: ${kljuc} (dopušteno: ${DOPUSTENA.join(', ')})`)
    }
  }

  if ('enabled' in t) {
    if (typeof t.enabled !== 'boolean') greske.push('enabled mora biti true ili false')
    else zakrpa.enabled = t.enabled
  }

  for (const [polje, izvorno] of [['perSource', 'perGroup']] as const) {
    const v = ('perSource' in t) ? t.perSource : ('perGroup' in t ? t.perGroup : undefined)
    if (v === undefined) continue
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      greske.push(`${polje} mora biti objekt {"<izvor>": "off"|"shadow"|"on"}`)
      break
    }
    const spojeno: Record<string, Nacin> = { ...trenutno.perSource }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!RE_KLJUC.test(k)) { greske.push(`${polje}: neispravan ključ izvora "${k}"`); continue }
      if (val === null) { delete spojeno[k]; continue }
      if (!NACINI.includes(val as Nacin)) {
        greske.push(`${polje}["${k}"] mora biti jedan od: ${NACINI.join(', ')}`); continue
      }
      spojeno[k] = val as Nacin
    }
    zakrpa.perSource = spojeno
    void izvorno
  }

  {
    const v = ('projectBySource' in t) ? t.projectBySource
      : ('projectByGroup' in t ? t.projectByGroup : undefined)
    if (v !== undefined) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        greske.push('projectBySource mora biti objekt {"<izvor>": "<PRJ-ID>"}')
      } else {
        const spojeno: Record<string, string> = { ...trenutno.projectBySource }
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (!RE_KLJUC.test(k)) { greske.push(`projectBySource: neispravan ključ izvora "${k}"`); continue }
          if (val === null || val === '') { delete spojeno[k]; continue }
          const p = String(val).trim()
          if (!RE_PROJEKT.test(p)) {
            greske.push(`projectBySource["${k}"]: projectId smije imati samo slova, brojke, - i _ (2-40 znakova)`)
            continue
          }
          spojeno[k] = p
        }
        zakrpa.projectBySource = spojeno
      }
    }
  }

  if ('defaultProject' in t) {
    const p = String(t.defaultProject ?? '').trim()
    if (!RE_PROJEKT.test(p)) greske.push('defaultProject mora biti oznaka projekta (2-40 znakova)')
    else zakrpa.defaultProject = p
  }

  for (const kljuc of ['pragA', 'pragB', 'pragC'] as const) {
    if (kljuc in t) {
      const n = cijeliBrojUGranici(t[kljuc], GRANICE[kljuc])
      if (n === null) greske.push(`${kljuc} mora biti cijeli broj ${GRANICE[kljuc].min}-${GRANICE[kljuc].max}`)
      else zakrpa[kljuc] = n
    }
  }

  // Pragovi su ljestvica: A (otvori zadatak) ≤ B (puni lanac) ≤ C (potvrda plana).
  // Prag B ispod praga A značio bi puni lanac za posao za koji se zadatak ne otvara.
  const a = (zakrpa.pragA as number) ?? trenutno.pragA
  const b = (zakrpa.pragB as number) ?? trenutno.pragB
  const c = (zakrpa.pragC as number) ?? trenutno.pragC
  if (!(a <= b && b <= c)) {
    greske.push(`Pragovi moraju rasti: pragA (${a}) <= pragB (${b}) <= pragC (${c})`)
  }

  if (!greske.length && !Object.keys(zakrpa).length) greske.push('Nijedna postavka nije poslana')
  return { ok: greske.length === 0, greske, zakrpa: zakrpa as Partial<IngestPostavke> }
}

// ─── Spremanje ───────────────────────────────────────────────────────────────

/**
 * Spoji zakrpu s onim što je na disku i zapiši. Zapis ide preko privremene datoteke pa
 * `rename` — datoteka se čita pri svakom pozivu, a napola zapisan JSON značio bi da
 * upravo tada sve padne na zadane vrijednosti.
 */
export function saveIngestConfig(
  zakrpa: Partial<IngestPostavke>,
  path: string = INGEST_CONFIG_PATH,
): IngestPostavke {
  const spojeno: IngestPostavke = { ...loadIngestConfig(path), ...zakrpa }
  const naDisk = {
    enabled: spojeno.enabled,
    perSource: spojeno.perSource,
    projectBySource: spojeno.projectBySource,
    defaultProject: spojeno.defaultProject,
    pragA: spojeno.pragA,
    pragB: spojeno.pragB,
    pragC: spojeno.pragC,
  }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(naDisk, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  return { ...spojeno, perGroup: spojeno.perSource, projectByGroup: spojeno.projectBySource }
}

// ─── Upiti koje pozivatelji trebaju ──────────────────────────────────────────

/** Djelatni položaj za izvor. Globalna sklopka gasi sve; nepoznat izvor je `off`. */
export function nacinZaIzvor(
  cfg: IngestPostavke, source: string, externalId?: string | number | null,
): Nacin {
  if (!cfg.enabled) return 'off'
  return prvaVrijednost(cfg.perSource, kljuceviIzvora(source, externalId)) ?? 'off'
}

/** Zadani projekt izvora; `null` ako nijedan ključ ne odgovara (pozivatelj tada uzima pretinac). */
export function projektZaIzvor(
  cfg: IngestPostavke, source: string, externalId?: string | number | null,
): string | null {
  return prvaVrijednost(cfg.projectBySource, kljuceviIzvora(source, externalId))
}
