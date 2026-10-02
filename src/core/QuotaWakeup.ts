/**
 * QuotaWakeup — okidač na obnovu kvote (A7 / TASK-3006, DIO 1).
 *
 * ZAŠTO POSTOJI: kad se 5-satni prozor obnovi, sustav to dosad nije primijetio kao
 * DOGAĐAJ. Provjereno 28.07.2026. na sva tri mjesta gdje bi okidač mogao biti:
 * `crontab -l` prazan, `systemctl --user list-timers` nijedan, harness `CronList` prazan.
 * Podatak je pritom postojao i bio točan — `/api/session-usage` vraća `session_reset_at`.
 * Imali smo što čitati; nitko nije čitao.
 *
 * GDJE ŽIVI: u glavnoj petlji `RegocDaemon`-a, ne u cronu ni u systemd timeru. Razlozi su
 * mjereni, ne stilski: (1) u kontejneru nema ni crona ni systemd-a (ADR-0001 §1.1),
 * (2) daemon već ima petlju od 15 s i preživljava restart, (3) drugi raspoređivač bio bi
 * drugi izvor istine za nešto što petlja ionako zna.
 *
 * ŠTO OKIDAČ ZAPRAVO RADI: ne „pokreće posao" — posao pokreće auto-exec čim vrata
 * autonomije propuste. Okidač radi jednu stvar: u trenutku `session_reset_at + ZAŠTITNI
 * RAZMAK` prisili SVJEŽE mjerenje potrošnje, pa se vrata otvore odmah umjesto da čekaju
 * redovni probe. Bez razmaka mjerenje zna vratiti staru brojku jer se kvota ne obnovi u
 * sekundi (vlasnikov prijedlog ~10 min).
 *
 * ČETIRI PRAVILA KOJA GA ČUVAJU OD SAMOG SEBE:
 *   1. NEMA BUĐENJA BEZ POSLA — prazan red čekanja (DIO 3) znači da se ne budi nitko;
 *      inače se kvota troši na prazan hod.
 *   2. VRIJEME SE ČITA IZNOVA — `session_reset_at` je klizni prozor koji se pomiče od
 *      prvog zahtjeva (mjereni lanac 18:40 → 23:50 → 04:50 → 17:10). Zato se sljedeći
 *      termin računa iz ZADNJE snimke pri svakom prolazu, nikad kao „prošli + 5 h".
 *   3. RAZMAK IZMEĐU POKUŠAJA RASTE — probudi se, kvote još nema, pokušaj opet: bez
 *      eksponencijalnog razmaka to je petlja koja troši upravo ono što čeka.
 *   4. ČOVJEK IMA PREDNOST — ako vlasnik upravo radi, buđenje se odgađa. Njegovih 30 pp
 *      prozora ne smije pojesti stroj koji se probudio u istoj minuti.
 *
 * VRIJEME: sva se aritmetika radi ISKLJUČIVO nad `session_reset_at` (ISO s oznakom zone).
 * Kontejner radi u UTC-u (`TZ` nije postavljen), pa je svako računanje nad „lokalnim"
 * prikazom računanje nad krivom brojkom — vidi `formatLocalTime()` niže.
 *
 * Autorica: Jelena (Engineer) · 2026-07-29 · TASK-3006 (A7)
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { TM_DATA } from './paths'

const HOME = process.env.HOME || homedir()
const DATA_DIR = TM_DATA

/** Stanje okidača — mora preživjeti restart, inače svaki start izgleda kao prvi pokušaj. */
export const QUOTA_WAKEUP_STATE_PATH =
  process.env.REGOC_QUOTA_WAKEUP_STATE || join(DATA_DIR, 'quota_wakeup.json')
/** Dnevnik buđenja (append-only JSONL) — jedan redak = jedan pokušaj ili nastavak rada. */
export const QUOTA_WAKEUP_LOG_PATH =
  process.env.REGOC_QUOTA_WAKEUP_LOG || join(DATA_DIR, 'quota_wakeup.jsonl')

// ============================================
// Postavke (brojke su odluke, pa stoje na jednom mjestu)
// ============================================

/**
 * Zaštitni razmak nakon `session_reset_at`. Vlasnikov prijedlog (29.07.2026): ~10 min.
 * Kvota se ne obnovi u sekundi — probe prerano vraća staru brojku, pa bi se okidač
 * ponašao kao da reset nije bio i potrošio pokušaj.
 */
export const WAKEUP_GRACE_MS = 10 * 60 * 1000

/** Prvi razmak između neuspjelih pokušaja; dalje se udvostručuje do `WAKEUP_RETRY_MAX_MS`. */
export const WAKEUP_RETRY_BASE_MS = 5 * 60 * 1000
export const WAKEUP_RETRY_MAX_MS = 30 * 60 * 1000

/**
 * Kad `session_reset_at` nije poznat (nikad izmjereno, pokvaren keš), okidač ne smije ni
 * šutjeti zauvijek ni tući svakih 15 s. Slijep pokušaj svakih 15 min je kompromis:
 * jedan probe ≈ 1 token.
 */
export const WAKEUP_BLIND_RETRY_MS = 15 * 60 * 1000

/**
 * Reset stariji od ovoga znači da je snimka iz prošlog života (daemon je bio ugašen preko
 * reseta, prozor je u međuvremenu istekao). Tada se ne čeka termin koji je davno prošao,
 * nego se mjeri odmah — to je ujedno odgovor na „što ako je daemon bio ugašen".
 */
export const WAKEUP_RESET_STALE_MS = 6 * 60 * 60 * 1000

/** Čovjek je „aktivan" ako se javio unutar ovoga. */
export const HUMAN_ACTIVE_MS = 10 * 60 * 1000
/** Koliko se čeka prije ponovne provjere kad je čovjek aktivan. */
export const HUMAN_DEFER_MS = 5 * 60 * 1000

/** Prikaz vremena čovjeku. Kontejner je UTC, pa se zona MORA navesti izrijekom. */
export const DISPLAY_TIME_ZONE = process.env.TIME_ZONE || 'Europe/Zagreb'

// ============================================
// Odluka
// ============================================

export type WakeupAction =
  /** Sada: prisili mjerenje potrošnje i pusti vrata autonomije da odluče. */
  | 'wake'
  /** Vrata su otvorena — okidač nema što raditi, rad teče sam. */
  | 'ready'
  /** Red je prazan — namjerno se ne budi nitko. */
  | 'idle-no-work'
  /** Termin još nije došao (ili traje razmak između pokušaja). */
  | 'hold'
  /** Termin je došao, ali čovjek radi — ustupa mu se prednost. */
  | 'defer-human'
  /** Ručna kočnica je povučena — okidač ne dira ništa. */
  | 'paused'

export interface WakeupDecision {
  action: WakeupAction
  reason: string
  /** Kada je sljedeći pokušaj na redu (ISO), ili `null` kad ga nema. */
  dueAt: string | null
  /** Koliko još ms do termina (0 kad je došao). */
  waitMs: number
  /** Koliki je pokušaj po redu (0 dok se ne probudi prvi put). */
  attempt: number
}

export interface WakeupInput {
  now: number
  /** Propuštaju li vrata autonomije posao upravo sada (`tier.autonomousQueue`). */
  gateOpen: boolean
  /** Koliko zadataka čeka u redu (DIO 3). 0 → nema koga buditi. */
  queueDepth: number
  /** ISO iz zadnje snimke potrošnje. Čita se IZNOVA svaki prolaz — prozor je klizni. */
  sessionResetAt: string | null
  /** Kada je okidač zadnji put prisilio mjerenje (ms), iz stanja na disku. */
  lastWakeAt: number | null
  /** Koliko je uzastopnih buđenja završilo bez otvaranja vrata. */
  attempts: number
  /** Koliko je prošlo od zadnjeg čovjekovog traga (ms); `null` = nepoznato. */
  humanIdleMs: number | null
  /** Globalna ručna kočnica (TASK-3047). */
  paused?: boolean
}

/** Razmak do sljedećeg pokušaja nakon `attempts` neuspjeha (eksponencijalno, s krovom). */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts))
  if (n <= 0) return WAKEUP_RETRY_BASE_MS
  return Math.min(WAKEUP_RETRY_MAX_MS, WAKEUP_RETRY_BASE_MS * Math.pow(2, n - 1))
}

function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * Kada je sljedeće buđenje na redu — iz reseta, iz razmaka između pokušaja, ili odmah.
 *
 * `null` znači „nemam pojma kad, mjeri odmah" (nepoznat ili davno prošao reset).
 */
export function nextWakeupAt(input: Pick<WakeupInput, 'now' | 'sessionResetAt' | 'lastWakeAt' | 'attempts'>): number | null {
  const { now } = input
  const reset = parseIso(input.sessionResetAt)

  let due: number | null = null
  if (reset !== null) {
    if (now - reset > WAKEUP_RESET_STALE_MS) {
      // Snimka je iz prošlog prozora (npr. daemon je bio ugašen preko reseta) — ne čeka se
      // termin koji je davno prošao.
      due = null
    } else {
      due = reset + WAKEUP_GRACE_MS
    }
  }

  if (input.lastWakeAt !== null && input.attempts > 0) {
    // Već smo pokušali i vrata se nisu otvorila: sljedeći pokušaj ne smije biti prije
    // isteka razmaka, bez obzira što o terminu misli reset.
    const retryAt = input.lastWakeAt + retryDelayMs(input.attempts)
    due = due === null ? retryAt : Math.max(due, retryAt)
  } else if (due === null && input.lastWakeAt !== null) {
    due = input.lastWakeAt + WAKEUP_BLIND_RETRY_MS
  }

  return due
}

/**
 * Čista odluka: treba li se sada probuditi. Bez I/O — daemon dovodi brojke, ovo ih
 * pretvara u postupak (i u rečenicu koju čovjek može pročitati u logu).
 */
export function planWakeup(input: WakeupInput): WakeupDecision {
  const { now } = input
  const attempt = Math.max(0, Math.floor(input.attempts || 0))

  if (input.paused) {
    return { action: 'paused', reason: 'ručna kočnica je povučena — okidač miruje', dueAt: null, waitMs: 0, attempt }
  }

  if (input.gateOpen) {
    return {
      action: 'ready',
      reason: 'vrata autonomije su otvorena — rad teče sam, buđenje nije potrebno',
      dueAt: null, waitMs: 0, attempt: 0,
    }
  }

  if (input.queueDepth <= 0) {
    // Pravilo 1: buđenje bez posla je čista potrošnja. Red je prazan → šutimo.
    return {
      action: 'idle-no-work',
      reason: 'red čekanja je prazan — nema koga buditi',
      dueAt: null, waitMs: 0, attempt,
    }
  }

  const due = nextWakeupAt(input)
  const dueIso = due === null ? null : new Date(due).toISOString()

  if (due !== null && now < due) {
    const waitMs = due - now
    const local = formatLocalTime(dueIso)
    return {
      action: 'hold',
      reason: attempt > 0
        ? `pokušaj ${attempt} nije otvorio vrata — sljedeći u ${local} (za ${Math.round(waitMs / 60000)} min)`
        : `čekam obnovu kvote — buđenje u ${local} (reset ${formatLocalTime(input.sessionResetAt)} + ${Math.round(WAKEUP_GRACE_MS / 60000)} min razmaka)`,
      dueAt: dueIso, waitMs, attempt,
    }
  }

  if (input.humanIdleMs !== null && input.humanIdleMs < HUMAN_ACTIVE_MS) {
    // Pravilo 4: čovjek ima prednost. Buđenje bi mu u istoj minuti pojelo prozor.
    const deferIso = new Date(now + HUMAN_DEFER_MS).toISOString()
    return {
      action: 'defer-human',
      reason: `čovjek je radio prije ${Math.round(input.humanIdleMs / 60000)} min — ustupam prednost, provjera u ${formatLocalTime(deferIso)}`,
      dueAt: deferIso, waitMs: HUMAN_DEFER_MS, attempt,
    }
  }

  return {
    action: 'wake',
    reason: due === null
      ? `reset nije poznat — mjerim potrošnju naslijepo (${input.queueDepth} zadataka čeka)`
      : `termin ${formatLocalTime(dueIso)} je došao — mjerim potrošnju (${input.queueDepth} zadataka čeka)`,
    dueAt: dueIso, waitMs: 0, attempt: attempt + 1,
  }
}

// ============================================
// Prikaz vremena (ISPRAVAK: kontejner je UTC)
// ============================================

/**
 * ISO trenutak → „HH:MM" po ZAGREBAČKOM vremenu, bez obzira što proces radi u UTC-u.
 *
 * Zatečena greška (mjereno 28.07.2026.): kontejner nema `TZ`, a `TIME_ZONE=Europe/Zagreb`
 * ničemu ne služi jer ga runtime ne gleda. `toLocaleTimeString('hr-HR')` bez `timeZone`
 * uzima zonu procesa, pa je traka za reset u 02:40 UTC pisala „02:40" iako je stvarno
 * 04:40 po Zagrebu — dva sata razlike. Račun se zato radi nad `session_reset_at`, a OVO
 * je jedini put do prikaza (jedan izvor istine za formatiranje, DRY).
 */
export function formatLocalTime(iso: string | null | undefined, timeZone: string = DISPLAY_TIME_ZONE): string {
  const t = parseIso(iso ?? null)
  if (t === null) return '?'
  try {
    return new Date(t).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', timeZone })
  } catch {
    // Nepoznata zona (pokvaren env) → radije UTC nego rušenje prikaza.
    return new Date(t).toISOString().slice(11, 16)
  }
}

// ============================================
// Stanje na disku (preživljava restart)
// ============================================

export interface WakeupState {
  /** Kada je okidač zadnji put prisilio mjerenje (ISO), ili `null`. */
  lastWakeAt: string | null
  /** Koliko uzastopnih buđenja nije otvorilo vrata. Resetira se kad rad krene. */
  attempts: number
  /** Za koji je termin zadnje buđenje bilo naručeno (dijagnostika). */
  plannedFor: string | null
}

const EMPTY_STATE: WakeupState = { lastWakeAt: null, attempts: 0, plannedFor: null }

export function readWakeupState(file: string = QUOTA_WAKEUP_STATE_PATH): WakeupState {
  try {
    if (!existsSync(file)) return { ...EMPTY_STATE }
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return {
      lastWakeAt: typeof raw?.lastWakeAt === 'string' ? raw.lastWakeAt : null,
      attempts: Number.isFinite(raw?.attempts) ? Math.max(0, Math.floor(raw.attempts)) : 0,
      plannedFor: typeof raw?.plannedFor === 'string' ? raw.plannedFor : null,
    }
  } catch {
    return { ...EMPTY_STATE }   // fail-open: pokvareno stanje znači „nikad se nismo budili"
  }
}

export function writeWakeupState(state: WakeupState, file: string = QUOTA_WAKEUP_STATE_PATH): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, file)   // atomicno: stanje čitaju i drugi procesi (alati, UI)
  } catch { /* dnevnik nije razlog za pad petlje */ }
}

export interface WakeupJournalEntry {
  ts: string
  event: 'wake' | 'resumed' | 'still-blocked' | 'deferred'
  reason: string
  attempt: number
  queue_depth: number
  session_percent: number | null
  session_reset_at: string | null
  session_reset_local: string | null
}

export function appendWakeupJournal(entry: WakeupJournalEntry, file: string = QUOTA_WAKEUP_LOG_PATH): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch { /* isto: zapis ne smije rušiti rad */ }
}

/** Zabilježi da je okidač opalio (pokušaj += 1) i vrati novo stanje. */
export function recordWake(now: number, plannedFor: string | null, prev: WakeupState): WakeupState {
  return {
    lastWakeAt: new Date(now).toISOString(),
    attempts: Math.max(0, Math.floor(prev.attempts || 0)) + 1,
    plannedFor,
  }
}

/** Rad je krenuo → brojač pokušaja se briše, inače bi razmak rastao kroz dane. */
export function clearAttempts(prev: WakeupState): WakeupState {
  return { ...prev, attempts: 0 }
}

// ============================================
// Trag čovjeka
// ============================================

/**
 * SQLite piše vremena u dva oblika: ISO s oznakom zone (noviji zapisi) i
 * `YYYY-MM-DD HH:MM:SS` bez zone (stariji, pisani UTC-om). `Date.parse` drugi oblik čita
 * kao LOKALNO vrijeme — u UTC kontejneru slučajno ispadne točno, ali bi na stroju s
 * postavljenom zonom pomaklo trag čovjeka za dva sata (i to u smjeru „radio je maloprije",
 * što bi autonomiju odgađalo bez razloga).
 */
export function parseDbTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(' ', 'T') + 'Z' : v
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * Koliko je prošlo otkad je čovjek zadnji put ostavio trag (ms), ili `null` ako traga nema.
 * Uzima se NAJSVJEŽIJI trag; neispravna vremena se tiho preskaču (fail-open: nepoznat trag
 * znači „ne znam", a ne „čovjek radi" — inače bi jedan pokvaren zapis zaustavio autonomiju).
 */
export function humanIdleMs(now: number, stamps: Array<unknown>): number | null {
  let newest: number | null = null
  for (const s of stamps) {
    const t = parseDbTime(s)
    if (t !== null && (newest === null || t > newest)) newest = t
  }
  if (newest === null) return null
  return Math.max(0, now - newest)
}
