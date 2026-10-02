/**
 * WeightScore — OCJENA TEŽINE 1–100 i odluka po pragovima A/B/C (U5 / TASK-4265).
 *
 * Razrada: `RAZRADA-3691_workflow_i_pragovi.md` (repozitorij sustava, nije u paketu) §2 (pragovi) i §3 (ocjena).
 *
 * ŠTO OVAJ MODUL JEST: čista, deterministička aritmetika nad već donesenom odlukom.
 * Razred težine (E1–E5) daje `ModeClassifier`; ovdje se iz njega izvodi JEDAN broj koji
 * se vidi na kartici i po kojem se ploča sortira.
 *
 * ŠTO OVAJ MODUL NIJE — i zašto je to važno:
 *   • NIJE nova klasifikacija. Broj se izvodi iz razreda, nikad obrnuto.
 *   • NIJE izbor modela. To i dalje radi `TaskTier` (samo nadolje).
 *   • NIJE odluka. Broj je PRIKAZ; postupak bira `routeByWeight` po pragovima iz
 *     `config/ingest-gate.json`, a ti su pragovi postavke koje mijenja čovjek.
 *
 * ZAŠTO SE BROJ REŽE NA GRANICE RAZREDA (razrada §3, doslovno: „broj nikada ne prelazi u
 * susjedni razred"). Da prikaz ne bi tiho mijenjao odluku. Zadatak koji je klasificiran kao
 * E3 s planom od 7 koraka dobio bi 48 + 21 = 69 — a 69 je E4 raspon, pa bi „prikaz" prešao
 * prag C i tražio vlasnikovu potvrdu za posao koji je klasifikator ocijenio kao jednodnevni.
 * Rezanje na 60 zadržava odluku ondje gdje ju je donio klasifikator.
 *
 * ZAŠTO BEZ MODELA. Ista pouka kao kod `ModeClassifier` E1-vrata (TASK-2559, mjereno:
 * 92 % prometa krivo skrenuto): sve što stoji na vrućem putu svake poruke mora biti
 * deterministično i besplatno. Ocjena se računa pri svakom prijemu — model si tu ne
 * možemo priuštiti ni po cijeni ni po pouzdanosti.
 *
 * Autorica: Kosjenka (Architect), TASK-4265.
 */

import type { EffortTier } from './ModeClassifier'

// ─── Razredi (razrada §3, tablica) ───────────────────────────────────────────

export interface Raspon { min: number; max: number }

/** E1–E5 → raspon na ljestvici 1–100. SSOT; sve ostalo se iz ovoga izvodi. */
export const RAZREDI: Record<EffortTier, Raspon> = {
  E1: { min: 1, max: 15 },    // pitanje, razgovor, razrada
  E2: { min: 16, max: 35 },   // jedan konkretan korak
  E3: { min: 36, max: 60 },   // pravi zadatak, jedan izvršitelj
  E4: { min: 61, max: 80 },   // više koraka, više datoteka
  E5: { min: 81, max: 100 },  // više agenata, više dana
}

export const RAZREDI_REDOM: readonly EffortTier[] = ['E1', 'E2', 'E3', 'E4', 'E5'] as const

/** Bodovi pomaka unutar razreda (razrada §3: „pomiče po tri mjerila"). */
export const BODOVI = {
  /** +3 po koraku u planu. */
  poKoraku: 3,
  /** +2 po različitoj datoteci ili sustavu koji posao dira. */
  poDatoteci: 2,
  /** +5 ako je posao već jednom pao ili se nastavlja. */
  ponovniPokusaj: 5,
} as const

/** Sredina razreda — osnovica prije pomaka. */
export function sredinaRazreda(effort: EffortTier): number {
  const r = RAZREDI[effort] ?? RAZREDI.E2
  return Math.round((r.min + r.max) / 2)
}

/** Razred kojem pripada gotov broj (obrat ocjene — za prikaz i provjeru). */
export function razredZaOcjenu(score: number): EffortTier {
  const s = Number.isFinite(score) ? Number(score) : 0
  for (const e of RAZREDI_REDOM) {
    const r = RAZREDI[e]
    if (s >= r.min && s <= r.max) return e
  }
  return s < RAZREDI.E1.min ? 'E1' : 'E5'
}

// ─── Ocjena ──────────────────────────────────────────────────────────────────

export interface WeightInput {
  /** Razred iz `ModeClassifier`. Jedini ulaz koji odlučuje raspon. */
  effort: EffortTier
  /** Broj koraka u planu razlaganja; 0 dok plana nema (ocjena se poslije osvježava). */
  planSteps?: number
  /** Broj RAZLIČITIH datoteka ili sustava koje posao dira. */
  files?: number
  /** Je li posao već jednom pao ili se nastavlja. */
  retried?: boolean
}

export interface WeightPart { label: string; points: number }

export interface WeightResult {
  /** Konačna ocjena 1–100, zajamčeno unutar razreda. */
  score: number
  effort: EffortTier
  /** Sredina razreda (osnovica). */
  base: number
  /** Zbroj prije rezanja — čuva se da se vidi KOLIKO je rezanje odnijelo. */
  raw: number
  /** Je li rezanje na granicu razreda stvarno okinulo. */
  clamped: boolean
  parts: WeightPart[]
  /** Čitljivo obrazloženje, ide u zapis na zadatku. */
  reason: string
}

/**
 * Ocjena = sredina razreda + pomaci, odrezano na granice razreda.
 * Čista funkcija: isti ulaz uvijek daje isti broj (nema vremena, nema I/O).
 */
export function scoreWeight(input: WeightInput): WeightResult {
  const effort = (RAZREDI_REDOM as readonly string[]).includes(input.effort) ? input.effort : ('E2' as EffortTier)
  const raspon = RAZREDI[effort]
  const base = sredinaRazreda(effort)

  const koraka = Math.max(0, Math.trunc(Number(input.planSteps) || 0))
  const datoteka = Math.max(0, Math.trunc(Number(input.files) || 0))

  const parts: WeightPart[] = [{ label: `sredina razreda ${effort}`, points: base }]
  if (koraka > 0) parts.push({ label: `${koraka} koraka u planu`, points: koraka * BODOVI.poKoraku })
  if (datoteka > 0) parts.push({ label: `${datoteka} datoteka/sustava`, points: datoteka * BODOVI.poDatoteci })
  if (input.retried) parts.push({ label: 'ponovni pokušaj / nastavak', points: BODOVI.ponovniPokusaj })

  const raw = parts.reduce((s, p) => s + p.points, 0)
  const score = Math.min(raspon.max, Math.max(raspon.min, raw))
  const clamped = score !== raw

  const pomaci = parts.slice(1).map(p => `+${p.points} (${p.label})`).join(' ')
  const reason = `${score}/100 — ${effort} ${raspon.min}–${raspon.max}, osnovica ${base}` +
    (pomaci ? ` ${pomaci}` : ' bez pomaka') +
    (clamped ? ` → zbroj ${raw} odrezan na granicu razreda ${raw > raspon.max ? raspon.max : raspon.min}` : '')

  return { score, effort, base, raw, clamped, parts, reason }
}

// ─── Izvlačenje mjerila iz zadatka (deterministički, bez modela) ─────────────

/**
 * Datoteke/sustavi koje posao dira — broje se RAZLIČITI nazivi s nastavkom
 * (`RegocDaemon.ts`, `config/ingest-gate.json`) i API-putanje (`/api/tasks`).
 *
 * Namjerno usko: „sustav" spomenut samo riječju („Telegram", „ploča") se NE broji, jer
 * bi svaka rečenica dizala ocjenu. Bolje podcijeniti nego dati broju da raste od proze —
 * ocjena je prikaz, a napuhan prikaz je gori od skromnog.
 */
const RE_DATOTEKA = /(?:[\w~./-]+\/)?[\w.-]+\.(?:ts|tsx|js|mjs|py|md|json|jsonl|sql|sh|ya?ml|html|css|csv|txt|toml|ini|env|db)\b/gi
const RE_API_PUTANJA = /\/api\/[a-z0-9_\-/:]+/gi

export function countFiles(text?: string | null): number {
  const t = String(text || '')
  if (!t) return 0
  const seen = new Set<string>()
  for (const re of [RE_DATOTEKA, RE_API_PUTANJA]) {
    re.lastIndex = 0
    for (const m of t.matchAll(re)) {
      const norm = m[0].toLowerCase().replace(/^[~./]+/, '').replace(/[.,;:)]+$/, '')
      if (norm.length > 2) seen.add(norm)
    }
  }
  // Strop 12: opis koji nabraja 40 datoteka nije 40× teži od opisa s tri.
  return Math.min(12, seen.size)
}

/** Oznake koje znače „ovo je nastavak ili ponovni pokušaj". */
const OZNAKE_PONOVNO = new Set(['retry', 'ponovno', 'nastavak', 'resume', 'reclaim', 'zombie-recovery'])

export interface RetrySignals {
  tags?: string[] | null
  blockedReason?: string | null
  progressNotes?: unknown[] | null
  description?: string | null
}

/**
 * „Posao je već jednom pao ili se nastavlja" — samo TVRDI biljezi, ne nagađanje iz proze.
 * Zašto tvrdi: heuristika nad opisom („popravi… pao je") dizala bi ocjenu svakom zadatku
 * koji opisuje TUĐI kvar, a to je kod nas većina zadataka.
 */
export function looksRetried(t: RetrySignals): boolean {
  const tags = (t.tags || []).map(x => String(x).trim().toLowerCase())
  if (tags.some(x => OZNAKE_PONOVNO.has(x))) return true
  if (String(t.blockedReason || '').trim().length > 0) return true
  if (/\[nastavak\b|ponovni pokušaj|ponovni pokusaj/i.test(String(t.description || ''))) return true
  return false
}

export interface TaskLike extends RetrySignals {
  id?: string
  title?: string | null
}

/** Ocjena izravno iz zadatka na ploči; `planSteps` dolazi izvana (plan nastaje poslije). */
export function scoreTask(task: TaskLike, effort: EffortTier, planSteps = 0): WeightResult {
  return scoreWeight({
    effort,
    planSteps,
    files: countFiles(`${task.title || ''}\n${task.description || ''}`),
    retried: looksRetried(task),
  })
}

// ─── Oznaka na zadatku (ocjena se UPISUJE, ne samo izračuna) ─────────────────

/**
 * Ocjena živi u oznaci `tezina:NN`, ne u novom stupcu baze.
 * Zašto: stupac traži migraciju sheme, izmjenu Zod sheme, TaskManagerSQL-a i ploče —
 * četiri mjesta za jedan prikazni broj. Oznake ploča već nosi, prikazuje i filtrira
 * (isti obrazac kao `tier:`, `parent:`, `step:`), a `tags` je polje koje PUT prima.
 */
export const WEIGHT_TAG_PREFIX = 'tezina:'

export function weightTag(score: number): string {
  const s = Math.min(100, Math.max(1, Math.round(Number(score) || 0)))
  return `${WEIGHT_TAG_PREFIX}${s}`
}

/** Ocjena s postojećeg zadatka; `null` ako je nema (nikad ne izmišlja broj). */
export function parseWeightTag(tags?: string[] | null): number | null {
  for (const t of tags || []) {
    const m = String(t).trim().toLowerCase().match(/^tezina:(\d{1,3})$/)
    if (!m) continue
    const n = Number(m[1])
    if (n >= 1 && n <= 100) return n
  }
  return null
}

/** Oznake sa svježom ocjenom — stara `tezina:` se ZAMJENJUJE, ne gomila. */
export function withWeightTag(tags: string[] | null | undefined, score: number): string[] {
  const bez = (tags || []).filter(t => !String(t).trim().toLowerCase().startsWith(WEIGHT_TAG_PREFIX))
  return [...bez, weightTag(score)]
}

// ─── Pragovi A/B/C (razrada §2) ──────────────────────────────────────────────

export type Postupak =
  | 'odgovor'            // ispod praga A — odgovori, ploča ostaje čista
  | 'jedan-izvrsitelj'   // A ≤ težina < B — kao danas
  | 'lanac'              // B ≤ težina < C — puni lanac, plan se izvodi sam
  | 'lanac-uz-potvrdu'   // ≥ C ili > 7 koraka — plan čeka vlasnikovu potvrdu

export interface RouteInput {
  score: number
  pragA: number
  pragB: number
  pragC: number
  /** Broj koraka koje je planer PREDLOŽIO (prije rezanja na 7) — razrada §2, prag C. */
  planSteps?: number
  /** Vlasnik je izričito rekao „idi do kraja" — puni lanac bez obzira na težinu. */
  explicitFullChain?: boolean
}

export interface RouteResult {
  postupak: Postupak
  /** Traži li se ljudska potvrda prije nego što se plan materijalizira. */
  trebaPotvrdu: boolean
  reason: string
}

/** Iznad ovoliko koraka plan ide na potvrdu i kad je težina ispod praga C (razrada §2). */
export const KORACI_ZA_POTVRDU = 7

/**
 * Odluka o postupku. Jedino mjesto na kojem se pragovi uspoređuju s ocjenom —
 * dvije usporedbe na dva mjesta znače dvije politike koje se s vremenom raziđu.
 */
export function routeByWeight(input: RouteInput): RouteResult {
  const s = Math.round(Number(input.score) || 0)
  const { pragA, pragB, pragC } = input
  const koraka = Math.max(0, Math.trunc(Number(input.planSteps) || 0))
  const previseKoraka = koraka > KORACI_ZA_POTVRDU

  if (!input.explicitFullChain && s < pragA) {
    return { postupak: 'odgovor', trebaPotvrdu: false, reason: `${s} < prag A (${pragA}) — odgovor, zadatak se ne otvara` }
  }
  if (!input.explicitFullChain && s < pragB) {
    return { postupak: 'jedan-izvrsitelj', trebaPotvrdu: false, reason: `prag A (${pragA}) ≤ ${s} < prag B (${pragB}) — jedan izvršitelj, bez razlaganja` }
  }
  if (s >= pragC || previseKoraka) {
    const zasto = s >= pragC ? `${s} ≥ prag C (${pragC})` : `plan ima ${koraka} koraka (> ${KORACI_ZA_POTVRDU})`
    return { postupak: 'lanac-uz-potvrdu', trebaPotvrdu: true, reason: `${zasto} — plan se zapisuje i šalje vlasniku, materijalizacije nema do potvrde` }
  }
  const zasto = input.explicitFullChain && s < pragB
    ? `izričit nalog „idi do kraja" (težina ${s} ispod praga B)`
    : `prag B (${pragB}) ≤ ${s} < prag C (${pragC})`
  return { postupak: 'lanac', trebaPotvrdu: false, reason: `${zasto} — puni lanac, plan se izvodi bez potvrde` }
}
