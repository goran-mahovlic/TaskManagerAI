/**
 * UsageMeter — zdravlje MJERILA potrošnje (TASK-3461).
 *
 * ZAŠTO POSTOJI. Vrata autonomije su na staroj snimci fail-CLOSED i to je ispravno: bolje
 * stajati nego pustiti rafal na slijepo. Ono što nije bilo ispravno je TIŠINA oko toga.
 *
 * Izmjereno 26.08.2026. iz `data/session_usage.jsonl` (prozor od 13:30Z): 244 retka, od toga
 * 223 s `http_error: "401 Unauthorized"`. Zadnje uspješno mjerenje 14:36:05Z (87 %), prvo
 * sljedeće 16:57:08Z — rupa od 141 minute. Uzrok: `tools/session_usage.py` čita pristupni
 * token s diska i sam ga ne osvježava, pa je nakon isteka tokena svaki probe vraćao 401.
 * `write_cache()` je (ispravno) odbijao pisati prazno preko dobre snimke, snimka je ostarila,
 * `autonomyTierFromUsage()` je ostao na zadnjoj poznatoj razini — i autonomija je stala.
 * Jedini trag u dnevniku bila je zagrada „(mjereno prije 139 min)" u tuđoj poruci.
 *
 * Ovdje su ČISTE funkcije te dijagnoze: procjena je li mjerilo palo i odluka smije li se
 * o tome vikati. I/O (log, Telegram, zapis reda) radi `RegocDaemon`.
 *
 * NE MIJENJA NIJEDAN PRAG autonomije (70/85/95, tjedni 90) i ne dira fail-CLOSED pravilo —
 * ovo je isključivo dojava. Sustav se ponaša isto, samo se sada zna zašto stoji.
 *
 * Autorica: Jelena (Engineer) · 2026-08-27 · TASK-3461
 */

import { existsSync } from 'fs'
import { SESSION_USAGE_TOOL } from './WorkStateJournal'

/** Snimka starija od ovoga znači da mjerilo NE RADI (zahtjev: „starija od 15 min"). */
export const METER_STALE_MS = 15 * 60 * 1000

/** Alarm se ponavlja najviše jednom na sat dok kvar traje — inače bi noć bila niz poruka. */
export const METER_ALARM_REPEAT_MS = 60 * 60 * 1000

export interface MeterInput {
  now: number
  /** Starost zadnje snimke u ms; `null` = snimke uopće nema. */
  snapshotAgeMs: number | null
  /** Postotak iz zadnje snimke — ide u poruku o oporavku. */
  sessionPercent: number | null
  /** Zadnji poznati razlog neuspjeha (stderr probea ili `http_error` iz snimke). */
  lastError: string | null
  /**
   * Snimka je svježa, ali NE NOSI vijest (nema postotka i nije odbijenica kvote).
   *
   * Rupa nađena tijekom provjere u pogonu 27.08.2026: starost sama nije dovoljna. Kad keša
   * nema (obrisan, prvi start), `write_cache()` smije upisati i prazan rezultat jer nema što
   * izgubiti — pa niz od 223 probea koji svi vraćaju 401 proizvede snimku staru 30 sekundi
   * koja ne zna baš ništa. Po starosti bi to izgledalo zdravo, a mjerilo ne radi.
   */
  snapshotUninformative?: boolean
  /**
   * Je li mjerenje IKAD dalo upotrebljiv rezultat (`SpawnTelemetry.hasUsageHistory`).
   *
   * Na svježem sustavu snimke nema jer mjerilo nikad nije ni radilo — to nije kvar nego
   * neznanje, i alarm bi bio lažan. Kvar je kad je mjerilo radilo pa prestalo.
   */
  everMeasured: boolean
  /**
   * Postoji li mjerilo UOPĆE na ovom stroju (`SESSION_USAGE_TOOL`). Zadano se čita s diska
   * — SSOT je isti kojim se služe vrata autonomije (`WorkStateJournal.blindDecision`).
   *
   * Odvojeno od `everMeasured` jer „još nije izmjerio" i „nema čime izmjeriti" traže
   * suprotne odluke (TASK-4779/4780): prvo je mladost, drugo je trajno sljepilo.
   */
  meterInstalled?: boolean
}

export interface MeterHealth {
  /** `true` = mjerilo ne radi (snimka starija od praga ili je nema, a prije je radilo). */
  down: boolean
  /** Koliko dugo (minuta) mjerilo ne radi; `null` kad se ne zna (snimke nema). */
  downMin: number | null
  lastError: string | null
  sessionPercent: number | null
}

/** Procijeni radi li mjerilo. Bez I/O — pozivatelj dovozi činjenice. */
export function assessMeter(input: MeterInput, staleMs: number = METER_STALE_MS): MeterHealth {
  const lastError = input.lastError && input.lastError.trim() ? input.lastError.trim() : null
  // TASK-4780: mjerila NEMA na stroju → nikakva snimka i nikakva povijest to ne popravljaju.
  // Bez ove grane `everMeasured=false` prolazi kao „prvi start, nije kvar" i ploča piše
  // `meter_status=ok`, dok vrata autonomije za isti čvor od TASK-4779 kažu „autonomija stoji"
  // (izmjereno na node-B 09.09.2026.). Dva izvora istine koja si proturječe; ovo ih izjednačuje.
  // Trajanje se NE izmišlja: neinstalirano mjerilo ne zna otkad ne radi, pa je `downMin` null.
  if ((input.meterInstalled ?? existsSync(SESSION_USAGE_TOOL)) === false) {
    return {
      down: true,
      downMin: null,
      lastError: `mjerilo nije instalirano (${SESSION_USAGE_TOOL})`,
      sessionPercent: input.sessionPercent,
    }
  }
  if (input.snapshotAgeMs === null) {
    // Snimke nema. Ako mjerilo nikad nije radilo, ovo je prvi start, ne kvar.
    return {
      down: input.everMeasured,
      downMin: null,
      lastError,
      sessionPercent: null,
    }
  }
  const prestara = input.snapshotAgeMs > staleMs
  const prazna = input.snapshotUninformative === true
  return {
    down: prestara || prazna,
    // Trajanje se broji SAMO iz starosti snimke. Svježa prazna snimka ne zna otkad mjerilo
    // ne radi, pa je pošteni odgovor „ne zna se", a ne „0 min".
    downMin: prestara ? Math.round(input.snapshotAgeMs / 60000) : null,
    lastError,
    sessionPercent: input.sessionPercent,
  }
}

/** Stanje dojave — živi u daemonu između prolaza. */
export interface MeterAlarmState {
  /** Je li kvar trenutno prijavljen (da se oporavak javi samo onima koji su čuli alarm). */
  alarming: boolean
  /** Kad je zadnji put poslan alarm (ms) — brana protiv ponavljanja u petlji. */
  lastAlarmAt: number | null
}

export const EMPTY_METER_ALARM_STATE: MeterAlarmState = { alarming: false, lastAlarmAt: null }

export type MeterAlarmAction = 'none' | 'alarm' | 'recovered'

export interface MeterAlarmDecision {
  action: MeterAlarmAction
  /** Tekst za dnevnik i Telegram; `null` kad se ne javlja ništa. */
  message: string | null
  state: MeterAlarmState
}

/**
 * Smije li se sada javiti kvar (ili oporavak) mjerila.
 *
 * Pravilo iz zahtjeva: kvar se javi JEDNOM, pa tišina do idućeg sata dok traje; kad mjerilo
 * proradi, ide poruka o oporavku. Petlja daemona vrti se svakih par sekundi, pa je brana
 * ovdje jedina stvar koja stoji između korisne dojave i 900 poruka po noći.
 */
export function decideMeterAlarm(
  prev: MeterAlarmState,
  health: MeterHealth,
  now: number,
  repeatMs: number = METER_ALARM_REPEAT_MS,
): MeterAlarmDecision {
  if (health.down) {
    const due = !prev.alarming || prev.lastAlarmAt === null || (now - prev.lastAlarmAt) >= repeatMs
    if (!due) return { action: 'none', message: null, state: { ...prev, alarming: true } }
    return {
      action: 'alarm',
      message: formatMeterDown(health),
      state: { alarming: true, lastAlarmAt: now },
    }
  }
  if (prev.alarming) {
    return {
      action: 'recovered',
      message: formatMeterRecovered(health),
      state: { alarming: false, lastAlarmAt: null },
    }
  }
  return { action: 'none', message: null, state: { alarming: false, lastAlarmAt: prev.lastAlarmAt } }
}

/**
 * Prekidač (features.json) za slanje dojave mjerila u Telegram — TASK-5512. Zadano true.
 * Na čvoru NodeA je false: Goran (14.10.2026.) tu dojavu u grupi čvora ne želi.
 */
export const METER_ALARM_FLAG = 'mjeriloDojava'

export type MeterAlarmDelivery = 'none' | 'queued' | 'queue_failed' | 'suppressed'

/**
 * Isporuči odluku `decideMeterAlarm`: dnevnik UVIJEK, Telegram samo uz `telegramEnabled`.
 * Prekidač gasi samo poruku — stanje alarma, zdravlje mjerila i vrata autonomije ga ne vide.
 */
export function deliverMeterAlarm(
  decision: MeterAlarmDecision,
  telegramEnabled: boolean,
  sink: { log: (msg: string) => void, queue: (msg: string) => boolean },
): MeterAlarmDelivery {
  if (decision.action === 'none' || !decision.message) return 'none'
  sink.log(decision.message)
  if (!telegramEnabled) {
    sink.log(`🔕 [mjerilo] dojava (${decision.action}) NIJE poslana u Telegram — ${METER_ALARM_FLAG}=false`)
    return 'suppressed'
  }
  return sink.queue(decision.message) ? 'queued' : 'queue_failed'
}

/** „mjerilo potrošnje ne radi N min, zadnji razlog: …; autonomija stoji" */
export function formatMeterDown(health: MeterHealth): string {
  const koliko = health.downMin === null ? 'ne zna se koliko dugo' : `${health.downMin} min`
  const razlog = health.lastError || 'nepoznat (probe ne vraća razlog)'
  return `⚠️ REGOČ: mjerilo potrošnje ne radi ${koliko}, zadnji razlog: ${razlog}; autonomija stoji.`
}

/** „mjerilo ponovno radi, sesija X %" */
export function formatMeterRecovered(health: MeterHealth): string {
  const pct = health.sessionPercent === null ? '?' : `${Math.round(health.sessionPercent)}`
  return `✅ REGOČ: mjerilo potrošnje ponovno radi, sesija ${pct} %.`
}

// ============================================
// Izlazni kodovi mjerila (SSOT s `tools/session_usage.py`)
// ============================================

/** `session_usage.py` izlazi ovime kad je HTTP greška bez ijedne vijesti (npr. 401). */
export const USAGE_EXIT_METER_REJECTED = 2

/** Naša oznaka za „probe nije odgovorio u roku" (proces ubijen, nije pravi izlazni kod). */
export const USAGE_EXIT_TIMEOUT = -1

export type ProbeOutcome = 'ok' | 'rejected' | 'timeout' | 'crashed'

export interface ProbeVerdict {
  outcome: ProbeOutcome
  /** Jedan redak za dnevnik. */
  logLine: string
  /** Razlog koji se pamti kao „zadnji poznati" za alarm; `null` kad je sve u redu. */
  reason: string | null
}

/**
 * Prevedi izlazni kod probea u presudu. Tri ishoda se NAMJERNO razlikuju jer traže različit
 * postupak: `crashed` je naš kvar (python, mreža), `rejected` je tuđi odgovor (token, ovlasti),
 * `timeout` je sporost. Do TASK-3461 su sva tri bila isti redak „(exit N)" — ili tišina.
 */
export function classifyProbeExit(code: number, stderr: string, timeoutMs?: number): ProbeVerdict {
  const firstLine = (stderr || '').split('\n').map(l => l.trim()).find(l => l.length > 0) || ''
  if (code === 0) return { outcome: 'ok', logLine: '', reason: null }
  if (code === USAGE_EXIT_METER_REJECTED) {
    const razlog = firstLine || 'HTTP greška bez razloga na stderru'
    return {
      outcome: 'rejected',
      logLine: `⛔ [usage] mjerilo potrošnje je ODBIJENO: ${razlog.slice(0, 300)}`,
      reason: razlog.slice(0, 300),
    }
  }
  if (code === USAGE_EXIT_TIMEOUT) {
    const razlog = `probe nije odgovorio u ${timeoutMs ?? '?'} ms`
    return { outcome: 'timeout', logLine: `⚠️ [usage] ${razlog}`, reason: razlog }
  }
  const razlog = firstLine ? `exit ${code}: ${firstLine.slice(0, 200)}` : `exit ${code}`
  return { outcome: 'crashed', logLine: `⚠️ [usage] probe potrošnje nije uspio (${razlog})`, reason: razlog }
}

// ============================================
// Buđenje prijave na dugotrajni 401 (TASK-3556)
// ============================================
//
// ZAŠTO. Pristupni token živi ~8 h i osvježava ga ISKLJUČIVO Claude CLI kad radi;
// `session_usage.py` ga samo čita s diska (vlastito osvježavanje preko refresh-tokena
// namjerno je odbijeno — utrka pisanja u datoteku s tajnama). Iz toga nastaje petlja koja
// se sama zatvara:
//
//   tjedni strop (≥ 90 %) zaustavi autonomiju → nema spawnova → nitko ne zove CLI →
//   token istekne → svaki probe 401 → snimka ostari → fail-CLOSED → autonomija i dalje stoji
//
// Izmjereno 01.09.2026. iz `data/session_usage.jsonl`: 4718 uzastopnih 401 kroz 40,3 h
// (30.08. 14:17Z → 01.09. 06:37Z). Datoteka s prijavom prepisana je u 06:37:34Z — u sekundi
// u kojoj je Goran ručno pokrenuo CLI. Isti obrazac ima 30 razdoblja, najduže 296,9 h.
//
// LIJEK. Kad 401 traje dulje od `TOKEN_NUDGE_AFTER_MS`, daemon pokrene JEDAN minimalan
// `claude --print` na Haikuu. Taj poziv ne nosi posao — jedina mu je svrha da CLI usput
// obnovi prijavu. Zato NE krši tjedni strop iz pravila #20: strop gasi vučenje posla iz
// reda, a ovo je održavanje mjerila.
//
// Odluka je ovdje čista funkcija; spawn i dojavu radi `RegocDaemon`.

/** 401 mora trajati ovoliko prije nego dirnemo CLI — kratke rupe se srede same. */
export const TOKEN_NUDGE_AFTER_MS = 15 * 60 * 1000

/**
 * Razmak između dva buđenja. Trajni 401 (opozvana prijava) inače znači novi `claude` proces
 * svakih minutu — a to je upravo rafal od kojeg branimo sustav, samo pod drugim imenom.
 */
export const TOKEN_NUDGE_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Koliko buđenja po jednom nizu 401 prije nego odustanemo i tražimo ljudsku ruku.
 *
 * Brojač se NE resetira na uspješan `claude` poziv nego tek kad probe stvarno prođe. Poziv
 * koji vrati exit 0, a prijavu ne obnovi, inače bi vrtio buđenja u prazno dovijeka.
 */
export const TOKEN_NUDGE_MAX_TRIES = 3

export interface TokenNudgeState {
  /** Početak tekućeg niza 401; `null` = niz ne traje. */
  unauthorizedSince: number | null
  /** Kad je zadnji put pokrenuto buđenje (ms); `null` = nijednom u ovom nizu. */
  lastNudgeAt: number | null
  /** Broj buđenja u tekućem nizu 401. */
  tries: number
  /** Je li već javljeno da treba ručna prijava (da se ne ponavlja svake minute). */
  reloginReported: boolean
}

export const EMPTY_TOKEN_NUDGE_STATE: TokenNudgeState = {
  unauthorizedSince: null, lastNudgeAt: null, tries: 0, reloginReported: false,
}

/** Je li razlog neuspjeha baš „istekla prijava" (401), a ne kvota, mreža ili pad alata. */
export function isUnauthorizedReason(reason: string | null | undefined): boolean {
  return !!reason && /\b401\b/.test(reason)
}

/**
 * Uklopi ishod jednog probea u stanje buđenja.
 *
 * Tri slučaja, i svaki je namjerno različit:
 *   • probe prošao (`reason === null`) → prijava radi, sve se briše;
 *   • 401 → niz teče (početak se pamti samo prvi put);
 *   • neka druga greška (mreža, timeout) → stanje se NE dira. Pad mreže ne dokazuje da je
 *     prijava dobra, pa bi brisanje niza bilo lažna dobra vijest.
 */
export function noteProbeForNudge(prev: TokenNudgeState, reason: string | null, now: number): TokenNudgeState {
  if (reason === null) {
    const cisto = prev.unauthorizedSince === null && prev.tries === 0 && !prev.reloginReported
    return cisto ? prev : { ...EMPTY_TOKEN_NUDGE_STATE }
  }
  if (!isUnauthorizedReason(reason)) return prev
  return prev.unauthorizedSince === null ? { ...prev, unauthorizedSince: now } : prev
}

export interface TokenNudgeOptions {
  afterMs?: number
  cooldownMs?: number
  maxTries?: number
}

/** Smije li se sada pokrenuti buđenje prijave. */
export function decideTokenNudge(
  state: TokenNudgeState,
  now: number,
  opts: TokenNudgeOptions = {},
): boolean {
  const afterMs = opts.afterMs ?? TOKEN_NUDGE_AFTER_MS
  const cooldownMs = opts.cooldownMs ?? TOKEN_NUDGE_COOLDOWN_MS
  const maxTries = opts.maxTries ?? TOKEN_NUDGE_MAX_TRIES
  if (state.unauthorizedSince === null) return false
  if (now - state.unauthorizedSince < afterMs) return false
  if (state.tries >= maxTries) return false
  if (state.lastNudgeAt !== null && now - state.lastNudgeAt < cooldownMs) return false
  return true
}

/** Zabilježi da je buđenje pokrenuto (broji se bez obzira na ishod — v. `TOKEN_NUDGE_MAX_TRIES`). */
export function noteNudgeStarted(state: TokenNudgeState, now: number): TokenNudgeState {
  return { ...state, lastNudgeAt: now, tries: state.tries + 1 }
}

/** Je li vrijeme da se čovjeku javi kako prijava traži ručnu obnovu (javlja se jednom po nizu). */
export function shouldReportRelogin(
  state: TokenNudgeState,
  maxTries: number = TOKEN_NUDGE_MAX_TRIES,
): boolean {
  return state.unauthorizedSince !== null && state.tries >= maxTries && !state.reloginReported
}

/** „prijava ne prolazi ni nakon N buđenja — treba `claude login`" */
export function formatReloginNeeded(state: TokenNudgeState, now: number): string {
  const min = state.unauthorizedSince === null
    ? '?'
    : String(Math.round((now - state.unauthorizedSince) / 60000))
  return `⛔ REGOČ: prijava na Anthropic ne prolazi ${min} min (401) ni nakon ${state.tries} `
    + 'automatska buđenja CLI-ja. Treba ručno: pokreni `claude` u terminalu (po potrebi `claude login`). '
    + 'Do tada mjerilo potrošnje stoji, a s njim i autonomija.'
}
