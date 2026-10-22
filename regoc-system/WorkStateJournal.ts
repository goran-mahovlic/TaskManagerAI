#!/usr/bin/env bun
/**
 * WorkStateJournal — zastoj postaje DOGAĐAJ S RAZLOGOM, ne otkucaj u logu.
 *
 * K4 / TASK-2970 (ADR-0001 §2, pitanje 3; PRJ-030 / D5).
 *
 * Zašto postoji: 27.07. je daemon 2 h 36 min svakih 30 s ispisivao
 * „Last completed task: TASK-F8-010" dok je red bio prazan — log je tvrdio da je
 * sve u redu, pa se analiza zastoja morala raditi RUČNO iz logova i baze.
 * Ovaj modul je JEDINI IZVOR ISTINE za odgovor „zašto stojim":
 *   - `computeWorkState()` — čista funkcija, evidencija → (stanje, razlog)
 *   - `WorkStateJournal`   — zapisuje PRIJELAZE (ne otkucaje) u `data/work_state.jsonl`
 *   - `reconstructDown()`  — pri startu izmišlja ono što mrtav proces nije mogao zapisati
 *
 * Načelo zapisa: jedan redak = jedna promjena stanja. `duration_s` je trajanje
 * stanja KOJE ZAVRŠAVA (`from`), a `since` je trenutak u kojem je ono počelo.
 * Tko traži „koliko je sustav stajao i zašto" dobiva odgovor jednim `grep`-om,
 * bez rekonstrukcije iz otkucaja.
 *
 * Autorica: Jelena (Engineer) · 2026-07-28
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { isEmptyOrFixtureTask } from './DispatchGuard'
import { hasUsageHistory } from './SpawnTelemetry'
import { AUTONOMY_DEFAULTS, validateThresholds, type AutonomyThresholds } from './AutonomyThresholdSetting'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
const DATA_DIR = join(HOME, '.claude', 'regoc', 'data')

/**
 * Mjerilo potrošnje sesije — JEDAN IZVOR ISTINE za putanju (TASK-4779).
 *
 * Stoji ovdje, uz vrata autonomije, jer o njegovu POSTOJANJU ovisi odluka: čvor koji
 * mjerilo nema nikad neće izmjeriti, pa se ne smije voditi kao „svjež sustav" (fail-open).
 * `RegocDaemon` uvozi isti simbol za probe — dvije kopije putanje bi značile da se jedna
 * strana može odseliti, a druga i dalje tvrditi da je sve u redu.
 */
export const SESSION_USAGE_TOOL = join(HOME, 'app', 'regoc_system', 'tools', 'session_usage.py')

/** Dnevnik prijelaza (append-only JSONL). */
export const WORK_STATE_LOG_PATH = join(DATA_DIR, 'work_state.jsonl')
/** Zadnje poznato stanje — mora preživjeti restart, inače svaki start izgleda kao prijelaz. */
export const WORK_STATE_CURRENT_PATH = join(DATA_DIR, 'work_state.current.json')
/** Otkucaj daemona: `updateStatus()` piše ovu datoteku ~1×/s dok je živ. */
export const DAEMON_STATUS_PATH = join(HOME, '.tmp', 'regoc_status.json')

// ============================================
// STANJA
// ============================================

export const WORK_STATES = [
  'working',
  'idle:empty-queue',
  'idle:all-blocked',
  'idle:quota-session',
  'idle:quota-weekly',
  'idle:waiting-human',
  'down',
] as const
export type WorkState = typeof WORK_STATES[number]

/**
 * Brojevi na temelju kojih je stanje izračunato. Idu u SVAKI zapis — bez njih se
 * „idle:all-blocked" ne može provjeriti, nego se mora vjerovati na riječ.
 */
export interface WorkEvidence {
  /** Ukupno `status=pending` zadataka (sirovo, prije ijednog filtra). */
  pending: number
  /** Podskup `pending` koji je uopće smije pokupiti auto-exec (autonomy-ok). */
  eligible: number
  /** `blocked` zadatci čiji razlog stroj može sam razriješiti (retry). */
  blocked_auto: number
  /** `blocked` zadatci koji čekaju čovjeka (uključujući one bez razloga). */
  blocked_human: number
  /** Koliko spawnova daemon trenutačno drži živima. */
  active_spawns: number
  session_percent: number | null
  weekly_percent: number | null
  session_reset_at: string | null
  weekly_reset_at: string | null
}

export const EMPTY_EVIDENCE: WorkEvidence = {
  pending: 0, eligible: 0, blocked_auto: 0, blocked_human: 0, active_spawns: 0,
  session_percent: null, weekly_percent: null, session_reset_at: null, weekly_reset_at: null,
}

export interface WorkStateInput extends WorkEvidence {
  /** Sada (ms). Ulazi u tempo tjedne kvote i u noćni SLACK. Zadano: `Date.now()`. */
  now?: number
  /**
   * Razmak bez otkucaja prethodne generacije (s). Prisutan i > 0 → stanje je `down`.
   * Nitko ga ne mjeri u hodu — rekonstruira se pri startu (`reconstructDown`).
   */
  downGapS?: number | null
  /**
   * Verdikt proračuna izvana (K2 / `AutonomyBudget.ts`, još nije izgrađen).
   * Kad K2 stigne, daemon ga proslijedi ovdje i `quotaVerdict()` niže se briše —
   * dva izvora istine za isti prag su gori od privremenog.
   */
  quota?: QuotaVerdict | null
}

export interface QuotaVerdict {
  ok: boolean
  /** Koja je kvota odbila. `null` kad je `ok`. */
  scope: 'session' | 'weekly' | null
  reason: string
}

/**
 * Razina ponašanja izvedena iz potrošnje sesije. Imena su namjerno opisna:
 * `full` je jedina razina na kojoj sustav sam sebi dodjeljuje posao.
 */
export const AUTONOMY_TIERS = ['full', 'task-by-task', 'cautious', 'answer-only'] as const
export type AutonomyTier = typeof AUTONOMY_TIERS[number]

export interface TierDecision {
  tier: AutonomyTier
  /** Smije li autonomija sama vući posao iz reda (auto-exec). */
  autonomousQueue: boolean
  /** Smije li se pokrenuti VIŠE agenata istovremeno. */
  multiAgent: boolean
  /** Smije li se uopće pokrenuti agent na izričit Goranov nalog. */
  spawnOnRequest: boolean
  /** Treba li tražiti potvrdu prije početka i upozoriti na prag. */
  requiresConfirmation: boolean
  /**
   * Odgovaranje je dopušteno UVIJEK. Polje postoji da bi to bilo zapisano,
   * a ne pretpostavljeno — sustav se ne smije sam ušutkati.
   */
  canAnswer: true
  /** Je li potrošnja uopće izmjerena. `false` → fail-open, ne koči se. */
  measured: boolean
  reason: string
}

/**
 * Pretvori postotak potrošnje sesije u razinu ponašanja.
 *
 * FAIL-OPEN: bez mjerenja (`null`/`undefined`/nekonačno) vraća `full` uz
 * `measured:false`. Ista disciplina kao drugdje u sustavu — radije nastavi nego
 * se zaključaj na vlastitoj slijepoj točki. Pozivatelj koji želi biti stroži
 * neka provjeri `measured`.
 */
export function autonomyTier(
  sessionPercent: number | null | undefined,
  thresholds: AutonomyThresholds = currentAutonomyThresholds(),
): TierDecision {
  const sp = sessionPercent
  const { sessionAutonomy, sessionCaution, sessionBlock } = thresholds
  if (sp === null || sp === undefined || !Number.isFinite(sp)) {
    return {
      tier: 'full', autonomousQueue: true, multiAgent: true, spawnOnRequest: true,
      requiresConfirmation: false, canAnswer: true, measured: false,
      reason: 'potrošnja sesije nije izmjerena — fail-open, ne kočim',
    }
  }
  if (sp >= sessionBlock) {
    return {
      tier: 'answer-only', autonomousQueue: false, multiAgent: false, spawnOnRequest: false,
      requiresConfirmation: true, canAnswer: true, measured: true,
      reason: `sesija ${sp} % ≥ ${sessionBlock} % — odgovaram, ali ništa se ne izvršava do obnove kvote`,
    }
  }
  if (sp >= sessionCaution) {
    return {
      tier: 'cautious', autonomousQueue: false, multiAgent: false, spawnOnRequest: true,
      requiresConfirmation: true, canAnswer: true, measured: true,
      reason: `sesija ${sp} % ≥ ${sessionCaution} % — bez multiagenata, tražim potvrdu prije početka`,
    }
  }
  if (sp >= sessionAutonomy) {
    return {
      tier: 'task-by-task', autonomousQueue: false, multiAgent: true, spawnOnRequest: true,
      requiresConfirmation: false, canAnswer: true, measured: true,
      reason: `sesija ${sp} % ≥ ${sessionAutonomy} % — autonomija stoji, radim zadatak po zadatak na nalog`,
    }
  }
  return {
    tier: 'full', autonomousQueue: true, multiAgent: true, spawnOnRequest: true,
    requiresConfirmation: false, canAnswer: true, measured: true,
    reason: `sesija ${sp} % < ${sessionAutonomy} % — autonomija dopuštena`,
  }
}

/**
 * Razina ponašanja iz CIJELE snimke potrošnje, uključujući staru.
 *
 * TASK-3046. `autonomyTier()` gleda samo postotak i fail-open je kad ga nema. To je
 * ispravno za „nikad nismo mjerili", ali pogrešno za „mjerili smo prije 40 min i bilo
 * je 100 %": zaboravljanje loše vijesti nije isto što i neznanje. Pravila, redom:
 *
 *   1. Nema snimke (ili je bez
 *      postotka)                → ovisi o tome je li mjerenje IKAD radilo (TASK-3061):
 *                                 nikad → fail-open (`full`); jest → fail-CLOSED
 *                                 (`task-by-task`), jer to je ispad mjerila, ne neznanje.
 *   2. Snimka kaže `rejected` /
 *      `429`                    → tvrdi stop bez obzira na starost i postotak.
 *   3. Snimka je stara, ali je
 *      zadnje poznato ≥ praga   → drži razinu iz zadnjeg poznatog (fail-CLOSED).
 *   4. Snimka je stara, a zadnje
 *      poznato je ispod praga   → `task-by-task`: dopusti pokretanje na nalog, ali NE
 *                                 autonomno vučenje posla, dok se ne izmjeri iznova.
 *   5. Snimka je svježa         → obično stupnjevanje po postotku.
 *
 * Pravilo 4 je ono koje ubija rafale: prije njega je zastarjeli keš značio „puna
 * autonomija", pa se red praznio u naletima od `MAX_AGENT_CONCURRENT` spawnova točno u
 * trenutku kad se prestalo mjeriti.
 */
export interface UsageSnapshotLike {
  sessionPercent: number | null
  weeklyPercent?: number | null
  status?: string | null
  httpError?: string | null
  stale: boolean
  ageMs: number
}

export interface TierOptions {
  /**
   * Je li mjerenje potrošnje IKAD dalo rezultat. Zadano se čita iz povijesti
   * (`hasUsageHistory()` nad `data/session_usage.jsonl`); testovi ga zadaju izravno.
   */
  measurementEverWorked?: boolean
  /**
   * Postoji li mjerilo UOPĆE na ovom stroju (`SESSION_USAGE_TOOL`). Zadano se čita s diska;
   * testovi ga zadaju izravno. Odvojeno od `measurementEverWorked` jer „još nije izmjerio"
   * i „nema čime izmjeriti" traže suprotne odluke (TASK-4779).
   */
  measurementInstalled?: boolean
  /**
   * Pragovi za ovu odluku (TASK-5028). Zadano: `currentAutonomyThresholds()` — postavka
   * TaskManagera uživo ako je daemon instalirao čitač, inače zadane 70/85/95/90.
   */
  thresholds?: AutonomyThresholds
}

/**
 * Odluka kad postotka NEMA (nema snimke, ili snimka bez ijednog broja) — TASK-3061.
 *
 * Ovo je jedina grana u kojoj se „ne znam" mora podijeliti na dvoje:
 *
 *   • mjerila NEMA na stroju (`SESSION_USAGE_TOOL` ne postoji) → fail-CLOSED. To nije mladost
 *     nego trajno sljepilo: probe tiho izlazi, dnevnik nikad ne nastane, pa bi „nikad izmjereno"
 *     zauvijek značilo punu autonomiju (izmjereno na node-B 09.09.2026., TASK-4779).
 *   • mjerenje nikad nije radilo, ali mjerilo POSTOJI → fail-OPEN (`full`). Svjež sustav se ne
 *     smije zaključati prije nego je ijednom izmjerio; obrana je uzvodno, u `write_cache`.
 *   • mjerenje je prije radilo, a sada snimke nema ili je nečitljiva → fail-CLOSED
 *     (`task-by-task`): to nije neznanje nego ISPAD MJERILA. Prije ovoga je ispad davao
 *     puni tier → do `MAX_AGENT_CONCURRENT` Opus spawnova iz reda, i to baš u trenutku kad
 *     se ne zna koliko je potrošeno (incident 29.07.2026, rafali po 3 Opusa svakih ~30 min).
 *
 * `spawnOnRequest` ostaje `true` u oba slučaja — Goranov nalog s Telegrama/konzole ne ide
 * kroz vrata autonomije i ne smije ga zaustaviti kvar mjerila.
 */
function blindDecision(opts: TierOptions, detail = ''): TierDecision {
  const installed = opts.measurementInstalled ?? existsSync(SESSION_USAGE_TOOL)
  const everWorked = opts.measurementEverWorked ?? hasUsageHistory()
  // TASK-4779: mjerila NEMA na stroju → nema ni izgleda da se izmjeri. Fail-open je
  // posudba povjerenja svježem sustavu koji mjerilo IMA pa ga još nije pokrenuo; sustavu
  // koji ga nema posudba nikad ne dospijeva na naplatu. Izmjereno na node-B (09.09.2026.):
  // vrata su bila LIVE, a puštala su punu autonomiju bez gornje granice od 30.07.2026.
  if (!installed) {
    return {
      tier: 'task-by-task', autonomousQueue: false, multiAgent: true, spawnOnRequest: true,
      requiresConfirmation: false, canAnswer: true, measured: false,
      reason: `mjerilo potrošnje nije instalirano (${SESSION_USAGE_TOOL}) — potrošnja se ne može `
        + 'izmjeriti, autonomija stoji; nalog s Telegrama/konzole i dalje radi',
    }
  }
  if (!everWorked) {
    return {
      tier: 'full', autonomousQueue: true, multiAgent: true, spawnOnRequest: true,
      requiresConfirmation: false, canAnswer: true, measured: false,
      reason: 'potrošnja sesije nije izmjerena, a mjerenje nikad nije ni dalo rezultat — fail-open, ne kočim',
    }
  }
  return {
    tier: 'task-by-task', autonomousQueue: false, multiAgent: true, spawnOnRequest: true,
    requiresConfirmation: false, canAnswer: true, measured: false,
    reason: `potrošnja sesije nije izmjerena, a mjerenje je prije radilo${detail} — ispad mjerila, `
      + 'autonomija stoji dok se ne izmjeri iznova; nalog s Telegrama/konzole i dalje radi',
  }
}

export function autonomyTierFromUsage(
  snap: UsageSnapshotLike | null | undefined,
  opts: TierOptions = {},
): TierDecision {
  if (!snap) return blindDecision(opts, ' (snimke nema ili je nečitljiva)')
  // Jedno očitanje pragova za cijelu odluku — tjedni i sesijski moraju biti iz istog skupa.
  const th = opts.thresholds ?? currentAutonomyThresholds()

  const minutes = Math.round(snap.ageMs / 60000)
  const rejected = snap.status === 'rejected' || /\b429\b/.test(snap.httpError || '')
  if (rejected) {
    return {
      tier: 'answer-only', autonomousQueue: false, multiAgent: false, spawnOnRequest: false,
      requiresConfirmation: true, canAnswer: true, measured: true,
      reason: `kvota je odbila zahtjev (${snap.httpError || snap.status}) prije ${minutes} min — ništa se ne pokreće do obnove`,
    }
  }

  // Tjedni strop 90 % (Goran, 29.07.2026): gasi AUTONOMIJU, ne sustav. `spawnOnRequest`
  // ostaje `true` jer Goranov zadatak s Telegrama/konzole mora proći i na 99 % tjedna.
  // Provjerava se PRIJE sesijskog stupnjevanja — tjedna kvota se obnavlja tek za dane, pa
  // je stroža vijest; sesijski prag bi je inače mogao prikazati blažom nego što jest.
  const wp = snap.weeklyPercent
  if (typeof wp === 'number' && Number.isFinite(wp) && wp >= th.weeklyBlock) {
    return {
      tier: 'task-by-task', autonomousQueue: false, multiAgent: true, spawnOnRequest: true,
      requiresConfirmation: false, canAnswer: true, measured: true,
      reason: `tjedan ${wp} % ≥ ${th.weeklyBlock} % — autonomija stoji do obnove tjedne kvote; nalog s Telegrama/konzole i dalje radi`,
    }
  }

  const base = autonomyTier(snap.sessionPercent, th)
  // Snimka BEZ postotka je slijepa isto kao da je nema — bez obzira je li svježa. Provjerava
  // se PRIJE `stale`, inače bi svježa prazna snimka prošla kao „puna autonomija" (TASK-3061).
  if (!base.measured) return blindDecision(opts, ' (snimka je bez postotka)')
  if (!snap.stale) return base

  if (base.tier !== 'full') {
    return { ...base, reason: `${base.reason} (mjereno prije ${minutes} min — držim razinu dok se ne izmjeri iznova)` }
  }
  return {
    tier: 'task-by-task', autonomousQueue: false, multiAgent: true, spawnOnRequest: true,
    requiresConfirmation: false, canAnswer: true, measured: true,
    reason: `mjerenje je staro ${minutes} min (zadnje poznato ${snap.sessionPercent} %) — autonomija stoji dok se ne izmjeri iznova`,
  }
}

export interface WorkStateDecision {
  state: WorkState
  reason: string
}

// ============================================
// PRORAČUN KVOTE (privremeno — do K2/AutonomyBudget.ts)
// ============================================

// ─── Pragovi sesije (Goranova odluka 2026-07-28, zamjenjuje jedan prag iz ADR-0001) ───
//
// Tri praga, ne jedan. Razlika je u tome TKO je pokrenuo posao:
//   • do 70 %  autonomija sama vuče posao iz reda (TaskManager);
//   • 70–85 %  autonomije više nema — radi se zadatak po zadatak, na Goranov nalog;
//   • 85–95 %  oprez: bez multiagenata, uz upozorenje i traženje potvrde;
//   • ≥ 95 %   ništa složeno; sustav i dalje ODGOVARA, samo ne izvršava.
//
// Zadnji prag je namjerno „ne izvršavaj", a ne „ne odgovaraj" — Goranov izričit
// zahtjev je da se sustav ne zaključa sam. Odgovaranje, čitanje i javljanje na
// Telegram ostaju dopušteni na svakoj razini.

//
// TASK-5028 (Goran, 24.09.2026.): brojevi niže su ZADANE vrijednosti. Izvor istine je
// postavka TaskManagera (`settings`: autonomy.session_autonomy / session_caution /
// session_block / weekly_block — Config stranica ili `PUT /api/config/autonomy`). Vrata ih
// čitaju preko `currentAutonomyThresholds()`; daemon pri pokretanju instalira čitač baze
// (`setAutonomyThresholdsProvider`, keš ≤5 s), pa promjena vrijedi bez restarta.

/** Zadano: iznad ovoga autonomija prestaje sama vući posao iz reda. */
export const SESSION_AUTONOMY_PERCENT = AUTONOMY_DEFAULTS.sessionAutonomy
/** Zadano: iznad ovoga bez multiagenata, uz upozorenje i potvrdu prije početka. */
export const SESSION_CAUTION_PERCENT = AUTONOMY_DEFAULTS.sessionCaution
/** Zadano: iznad ovoga samo odgovaranje; ništa se ne izvršava do obnove kvote. */
export const SESSION_BLOCK_PERCENT = AUTONOMY_DEFAULTS.sessionBlock

let autonomyThresholdsProvider: (() => AutonomyThresholds) | null = null

/**
 * Instaliraj izvor pragova (daemon: `createAutonomyThresholdsReader` nad regoc.db).
 * `null` vraća zadane vrijednosti — testovi to zovu u `afterEach`.
 */
export function setAutonomyThresholdsProvider(fn: (() => AutonomyThresholds) | null): void {
  autonomyThresholdsProvider = fn
}

/**
 * Trenutačni pragovi vrata. Provider koji baci ili vrati nevaljan skup NE znači „bez
 * praga" — vraća se zadano (70/85/95/90), isto ponašanje kao prije TASK-5028.
 */
export function currentAutonomyThresholds(): AutonomyThresholds {
  if (!autonomyThresholdsProvider) return { ...AUTONOMY_DEFAULTS }
  try {
    const t = autonomyThresholdsProvider()
    if (t && validateThresholds(t) === null) return t
  } catch { /* pada na zadano niže */ }
  return { ...AUTONOMY_DEFAULTS }
}

/**
 * @deprecated Ostavljeno da stariji pozivi ne puknu. Novi kod neka koristi
 * `autonomyTier()` — jedan prag ne može opisati četiri razine ponašanja.
 */
export const SESSION_STOP_PERCENT = SESSION_AUTONOMY_PERCENT

// ─── Tjedni strop (Goranova odluka 2026-07-29) ───────────────────────────────
//
// „Tjedni strop, jedino pravilo je da se autonomni rad gasi na 90 % tjednog stropa,
//  ali da ja uredno mogu dati zadatak preko Telegrama ili konzole."
//
// Dakle JEDAN broj i JEDNA posljedica: ≥ 90 % → autonomija više ne vuče posao iz reda.
// Goranov nalog (poruka s Telegrama, konzola) ide drugim putem i NIJE pogođen — taj put
// ionako ne prolazi kroz vrata autonomije, nego kroz `spawnAgentOnDemand`.
//
// Zamjenjuje raniji privremeni model (strop 60 % + linearni tempo + noćni slack): tempo se
// i dalje MJERI i zapisuje, ali se po njemu ne odbija. Dva pravila za istu stvar su gora od
// jednog jasnog — a Goran je sada odlučio koje vrijedi.
/**
 * Zadano: iznad ovoga autonomija prestaje sama vući posao; Goranov nalog i dalje prolazi.
 * Uživo vrijedi `currentAutonomyThresholds().weeklyBlock` (TASK-5028).
 */
export const WEEKLY_BLOCK_PERCENT = AUTONOMY_DEFAULTS.weeklyBlock
/** @deprecated Naziv iz privremenog modela — sada je isto što i `WEEKLY_BLOCK_PERCENT`. */
export const WEEKLY_HARD_CAP_PERCENT = WEEKLY_BLOCK_PERCENT
/**
 * @deprecated Tempo se mjeri radi uvida (`weeklyPace`), ali VIŠE NE ODBIJA — Goranova
 * odluka 29.07.2026. je jedan prag (90 %) bez korekcije po tempu.
 */
export const WEEKLY_SLACK_DAY_PP = 10
export const WEEKLY_SLACK_NIGHT_PP = 15
/** Noć = 23:00–07:00 po lokalnom satu (kapacitet ionako stoji neiskorišten). */
export const NIGHT_START_HOUR = 23
export const NIGHT_END_HOUR = 7
const WEEK_MS = 168 * 3600 * 1000

function isNight(now: number): boolean {
  const h = new Date(now).getHours()
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR
}

/**
 * Linearni tempo trošenja tjedne kvote u trenutku `now`, iz `weekly_reset_at`.
 * Vraća `null` ako reset nije poznat — tada se koristi samo tvrdi strop.
 */
export function weeklyPace(weeklyResetAt: string | null, now: number): number | null {
  if (!weeklyResetAt) return null
  const reset = Date.parse(weeklyResetAt)
  if (!Number.isFinite(reset)) return null
  const elapsed = WEEK_MS - (reset - now)
  if (!Number.isFinite(elapsed)) return null
  const clamped = Math.min(WEEK_MS, Math.max(0, elapsed))
  return (clamped / WEEK_MS) * 100
}

/**
 * Smije li autonomija trošiti? FAIL-OPEN: ako mjerenja nema (`null`), NE koči —
 * ista disciplina kao `session_usage.py` (radije nastavi nego se zaključaj na
 * vlastitoj slijepoj točki).
 */
export function quotaVerdict(input: WorkStateInput, now: number): QuotaVerdict {
  // Ovaj verdikt odgovara SAMO na pitanje „smije li autonomija sama vući posao",
  // pa je mjerodavan prag 70 %, a ne 85 %. Više razine (oprez, blokada) odnose se
  // na posao koji je Goran naručio i rješava ih `autonomyTier()`.
  const th = currentAutonomyThresholds()
  const tier = autonomyTier(input.session_percent, th)
  if (!tier.autonomousQueue) {
    return { ok: false, scope: 'session', reason: `${tier.reason} (reset ${input.session_reset_at || '?'})` }
  }
  // Tjedno: JEDAN prag, bez korekcije po tempu (Goran, 29.07.2026). Tempo se i dalje
  // računa jer stoji u zapisu i koristan je za uvid, ali ne sudjeluje u odluci.
  const wp = input.weekly_percent
  if (wp !== null && wp !== undefined && wp >= th.weeklyBlock) {
    const pace = weeklyPace(input.weekly_reset_at ?? null, now)
    const paceTxt = pace === null ? 'tempo nepoznat' : `tempo ${pace.toFixed(1)}%`
    return {
      ok: false, scope: 'weekly',
      reason: `tjedan ${wp}% ≥ ${th.weeklyBlock}% — autonomija stoji, Goranov nalog i dalje prolazi (${paceTxt}, reset ${input.weekly_reset_at || '?'})`,
    }
  }
  return { ok: true, scope: null, reason: 'proračun prolazi' }
}

// ============================================
// ČISTA FUNKCIJA: EVIDENCIJA → STANJE
// ============================================

/**
 * Izračunaj stanje rada iz evidencije. Redoslijed pitanja je namjeran i odgovara
 * pitanju „zašto NE radim":
 *   1. `down`            — daemon nije bio živ (rekonstruirano pri startu)
 *   2. `working`         — barem jedan spawn radi
 *   3. ima prihvatljivog posla → koči li kvota? (`idle:quota-*`)
 *      Ako ne koči, posao je primljen i spawn slijedi na idućem tiku → `working`.
 *   4. nema prihvatljivog posla → ima li blokiranog? (`idle:all-blocked` /
 *      `idle:waiting-human`), inače `idle:empty-queue`.
 *
 * Kvota se NE gleda kad nema prihvatljivog posla: „stojim jer je red prazan" je
 * istinitiji odgovor od „stojim zbog kvote" kad ionako nema što pokrenuti.
 */
export function computeWorkState(input: WorkStateInput): WorkStateDecision {
  const now = input.now ?? Date.now()

  if (input.downGapS !== null && input.downGapS !== undefined && input.downGapS > 0) {
    return { state: 'down', reason: `bez otkucaja ${Math.round(input.downGapS)} s — daemon nije radio` }
  }

  if (input.active_spawns > 0) {
    return { state: 'working', reason: `${input.active_spawns} aktivn(ih) spawn(ova)` }
  }

  if (input.eligible > 0) {
    const q = input.quota ?? quotaVerdict(input, now)
    if (!q.ok && q.scope === 'session') return { state: 'idle:quota-session', reason: q.reason }
    if (!q.ok && q.scope === 'weekly') return { state: 'idle:quota-weekly', reason: q.reason }
    // Posao je prihvatljiv i proračun prolazi: auto-exec ga podiže na idućem prolazu
    // (≤ 15 s). Zato `working`, ali evidencija (`active_spawns:0, eligible:N`) ostavlja
    // trag — ako se to stanje zadrži, znači da spawn ne kreće i to se vidi iz trajanja.
    return { state: 'working', reason: `${input.eligible} prihvatljiv(ih) zadataka primljeno, spawn slijedi` }
  }

  const blocked = input.blocked_auto + input.blocked_human
  if (blocked > 0) {
    if (input.blocked_auto === 0) {
      return { state: 'idle:waiting-human', reason: `blocked:human-gated — ${input.blocked_human} zadatak(a) čeka čovjeka` }
    }
    const kind = input.blocked_human > 0 ? 'blocked:mixed' : 'blocked:auto-retry'
    return { state: 'idle:all-blocked', reason: `${kind} — ${input.blocked_auto} auto-retry, ${input.blocked_human} human-gated, 0 prihvatljivih` }
  }

  return { state: 'idle:empty-queue', reason: `red prazan — ${input.pending} pending, 0 prihvatljivih, 0 blokiranih` }
}

// ============================================
// TRIJAŽA BLOKIRANIH (evidencija za idle:all-blocked)
// ============================================

/** Razlozi koje stroj sam može razriješiti (ADR-0001 K3). */
export const AUTO_RETRY_REASONS = ['daemon-restart', 'zombie', 'timeout', 'session-budget', 'restart', 'prekinut']
/** Oznake/razlozi koji izričito traže čovjeka. */
export const HUMAN_GATED_REASONS = ['needs-context', 'needs-decision', 'waiting-for-human', 'needs-hw-test']
export const HUMAN_GATED_TAGS = ['waiting-for-human', 'needs-decision', 'no-watchdog', 'interactive']

/**
 * Auto-retry ili human-gated? PRAZAN razlog → human-gated: 61 blokiranih zadataka
 * u bazi ima prazan `blocked_reason` (ADR §1.2), a tiho ih ponavljati bilo bi
 * skuplje od toga da čekaju čovjeka.
 */
export function classifyBlocked(blockedReason?: string | null, tags?: string[] | null): 'auto' | 'human' {
  const tagList = (tags || []).map(t => String(t).toLowerCase())
  if (tagList.some(t => HUMAN_GATED_TAGS.includes(t))) return 'human'
  const r = String(blockedReason || '').toLowerCase().trim()
  if (!r) return 'human'
  if (HUMAN_GATED_REASONS.some(k => r.includes(k))) return 'human'
  if (AUTO_RETRY_REASONS.some(k => r.includes(k))) return 'auto'
  return 'human'
}

/** Minimalan oblik zadatka koji ovaj modul treba (podskup TaskManager odgovora). */
export interface TaskLike {
  id?: string
  title?: string | null
  description?: string | null
  assignee?: string | null
  blocked_reason?: string | null
  blockedReason?: string | null
  tags?: string[] | null
}

/**
 * Je li pending zadatak uopće kandidat za autonomni spawn? Ista pravila kao
 * `processP1Tasks()` (assignee ≠ user, nije prazan/fixture) + oznake koje traže
 * čovjeka. Ako se pravila raziđu, dnevnik laže o veličini reda — zato ista lista.
 */
export function isAutonomyEligible(task: TaskLike): boolean {
  if (!task.assignee || task.assignee === 'user') return false
  if (isEmptyOrFixtureTask(task.title ?? undefined, task.description ?? undefined)) return false
  const tagList = (task.tags || []).map(t => String(t).toLowerCase())
  if (tagList.some(t => HUMAN_GATED_TAGS.includes(t))) return false
  return true
}

/** Prebroji `pending` i `blocked` liste u polja evidencije. */
export function countEvidence(pending: TaskLike[], blocked: TaskLike[]): Pick<WorkEvidence, 'pending' | 'eligible' | 'blocked_auto' | 'blocked_human'> {
  let eligible = 0
  for (const t of pending) if (isAutonomyEligible(t)) eligible++
  let auto = 0, human = 0
  for (const t of blocked) {
    const cls = classifyBlocked(t.blocked_reason ?? t.blockedReason ?? null, t.tags ?? null)
    if (cls === 'auto') auto++; else human++
  }
  return { pending: pending.length, eligible, blocked_auto: auto, blocked_human: human }
}

// ============================================
// DNEVNIK PRIJELAZA
// ============================================

export interface WorkStateEvent {
  ts: string
  from: WorkState | null
  to: WorkState
  reason: string
  /** Kad je stanje `from` počelo. */
  since: string | null
  /** Koliko je `from` trajalo (s). */
  duration_s: number | null
  evidence: WorkEvidence
}

interface CurrentState {
  state: WorkState
  since: string
  ts: string
  reason: string
}

export interface WorkStateJournalOptions {
  logPath?: string
  statePath?: string
  now?: () => number
}

export class WorkStateJournal {
  private logPath: string
  private statePath: string
  private now: () => number

  constructor(opts: WorkStateJournalOptions = {}) {
    this.logPath = opts.logPath || WORK_STATE_LOG_PATH
    this.statePath = opts.statePath || WORK_STATE_CURRENT_PATH
    this.now = opts.now || (() => Date.now())
  }

  /** Zadnje zapisano stanje (preživljava restart). `null` ako dnevnika još nema. */
  current(): CurrentState | null {
    try {
      if (!existsSync(this.statePath)) return null
      const raw = JSON.parse(readFileSync(this.statePath, 'utf-8'))
      if (!raw || !WORK_STATES.includes(raw.state)) return null
      return raw as CurrentState
    } catch { return null }
  }

  /**
   * Izračunaj stanje i zapiši GA SAMO AKO SE PROMIJENILO.
   * Vraća zapisani događaj ili `null` (nema prijelaza — dnevnik ostaje tanak).
   */
  record(input: WorkStateInput): WorkStateEvent | null {
    const decision = computeWorkState(input)
    return this.transition(decision, input, this.now())
  }

  /** Kao `record()`, ali s unaprijed izračunatom odlukom i vremenom (za `down`). */
  transition(decision: WorkStateDecision, evidence: WorkEvidence, atMs: number): WorkStateEvent | null {
    const prev = this.current()
    if (prev && prev.state === decision.state) {
      // Isto stanje — ne pišemo redak, ali osvježimo razlog/otkucaj u snimci stanja.
      this.writeCurrent({ ...prev, ts: new Date(atMs).toISOString(), reason: decision.reason })
      return null
    }
    const sinceMs = prev ? Date.parse(prev.since) : NaN
    const event: WorkStateEvent = {
      ts: new Date(atMs).toISOString(),
      from: prev ? prev.state : null,
      to: decision.state,
      reason: decision.reason,
      since: prev ? prev.since : null,
      duration_s: Number.isFinite(sinceMs) ? Math.max(0, Math.round((atMs - sinceMs) / 1000)) : null,
      evidence: {
        pending: evidence.pending,
        eligible: evidence.eligible,
        blocked_auto: evidence.blocked_auto,
        blocked_human: evidence.blocked_human,
        active_spawns: evidence.active_spawns,
        session_percent: evidence.session_percent ?? null,
        weekly_percent: evidence.weekly_percent ?? null,
        session_reset_at: evidence.session_reset_at ?? null,
        weekly_reset_at: evidence.weekly_reset_at ?? null,
      },
    }
    this.append(event)
    this.writeCurrent({
      state: decision.state,
      since: event.ts,
      ts: event.ts,
      reason: decision.reason,
    })
    return event
  }

  /** Pročitaj cijeli dnevnik (za izvještaje i testove). */
  readAll(): WorkStateEvent[] {
    try {
      if (!existsSync(this.logPath)) return []
      return readFileSync(this.logPath, 'utf-8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l) as WorkStateEvent } catch { return null } })
        .filter((e): e is WorkStateEvent => e !== null)
    } catch { return [] }
  }

  private append(event: WorkStateEvent): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf-8')
    } catch { /* dnevnik nikad ne smije srušiti daemon */ }
  }

  private writeCurrent(state: CurrentState): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      writeFileSync(this.statePath, JSON.stringify(state), 'utf-8')
    } catch { /* isto: zapisivanje je nuspojava, ne posao */ }
  }
}

// ============================================
// REKONSTRUKCIJA `down` PRI STARTU
// ============================================

/** Ispod ovoga razmak nije nedostupnost nego uredan restart (~sekunde). */
export const DOWN_MIN_GAP_S = 90

/** Otkucaj prethodne generacije: `lastUpdate` iz `regoc_status.json` (ms) ili `null`. */
export function readDaemonHeartbeat(statusPath: string = DAEMON_STATUS_PATH): number | null {
  try {
    if (!existsSync(statusPath)) return null
    const raw = JSON.parse(readFileSync(statusPath, 'utf-8'))
    const ms = Date.parse(raw?.lastUpdate)
    return Number.isFinite(ms) ? ms : null
  } catch { return null }
}

/**
 * Mrtav proces ne može zapisati vlastitu smrt — zato je pri startu rekonstruiramo
 * iz razmaka u otkucaju prethodne generacije. Zapisuju se DVA retka:
 *   1. `… → down`  s vremenom zadnjeg otkucaja (trenutak smrti, unatrag datiran)
 *   2. `down → X`  sada, gdje je `duration_s` upravo trajanje nedostupnosti
 * Bez para se ne bi vidjelo KOLIKO je sustav bio dolje, samo da je bio.
 *
 * Vraća zapisane događaje (prazno ako razmak nije dovoljno velik).
 */
export function reconstructDown(
  journal: WorkStateJournal,
  lastHeartbeatMs: number | null,
  input: WorkStateInput,
  opts: { now?: number, minGapS?: number } = {},
): WorkStateEvent[] {
  const now = opts.now ?? input.now ?? Date.now()
  const minGapS = opts.minGapS ?? DOWN_MIN_GAP_S
  if (lastHeartbeatMs === null || !Number.isFinite(lastHeartbeatMs)) return []
  const gapS = (now - lastHeartbeatMs) / 1000
  if (gapS < minGapS) return []

  const events: WorkStateEvent[] = []
  const enterDown = journal.transition(
    { state: 'down', reason: `zadnji otkucaj prije ${Math.round(gapS)} s — proces nije radio` },
    { ...EMPTY_EVIDENCE, active_spawns: 0 },
    lastHeartbeatMs,
  )
  if (enterDown) events.push(enterDown)

  const back = journal.transition(computeWorkState({ ...input, now, downGapS: null }), input, now)
  if (back) events.push(back)
  return events
}

// ============================================
// MJERENJE KVOTE (keš koji hookovi već održavaju)
// ============================================

export const SESSION_USAGE_CACHE_PATH = join(DATA_DIR, 'session_usage.cache.json')
/** Stariji keš od ovoga ne koristimo — bolje `null` (fail-open) nego lažna brojka. */
export const USAGE_MAX_AGE_MS = 30 * 60 * 1000

export interface UsageSnapshot {
  session_percent: number | null
  weekly_percent: number | null
  session_reset_at: string | null
  weekly_reset_at: string | null
}

export const EMPTY_USAGE: UsageSnapshot = {
  session_percent: null, weekly_percent: null, session_reset_at: null, weekly_reset_at: null,
}

/**
 * Pročitaj zadnju snimku potrošnje iz keša koji `session_usage.py` održava.
 * NE zove API — dnevnik stanja ne smije trošiti kvotu da bi izmjerio kvotu.
 */
export function readUsageSnapshot(
  cachePath: string = SESSION_USAGE_CACHE_PATH,
  maxAgeMs: number = USAGE_MAX_AGE_MS,
  now: number = Date.now(),
): UsageSnapshot {
  try {
    const payload = JSON.parse(readFileSync(cachePath, 'utf-8'))
    const cachedAt = Number(payload?.cached_at) * 1000
    if (!Number.isFinite(cachedAt) || now - cachedAt > maxAgeMs) return { ...EMPTY_USAGE }
    const e = payload.entry || {}
    return {
      session_percent: typeof e.session_percent === 'number' ? e.session_percent : null,
      weekly_percent: typeof e.weekly_percent === 'number' ? e.weekly_percent : null,
      session_reset_at: e.session_reset_at ?? null,
      weekly_reset_at: e.weekly_reset_at ?? null,
    }
  } catch { return { ...EMPTY_USAGE } }
}

/** Jednoredni sažetak za `daemon.log` (zamjenjuje „Last completed task: X"). */
export function formatWorkStateLine(decision: WorkStateDecision, ev: WorkEvidence): string {
  const q = ev.session_percent === null && ev.weekly_percent === null
    ? 'kvota ?'
    : `sesija ${ev.session_percent ?? '?'}% · tjedan ${ev.weekly_percent ?? '?'}%`
  return `[${decision.state}] ${decision.reason} · pending ${ev.pending}/prihvatljivo ${ev.eligible} · blocked ${ev.blocked_auto}auto+${ev.blocked_human}human · spawnovi ${ev.active_spawns} · ${q}`
}
