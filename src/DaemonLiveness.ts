/**
 * DaemonLiveness — je li REGOČ daemon stvarno živ (TASK-2989)
 *
 * Konzolna traka je do sada čitala `~/.tmp/regoc_status.json` doslovno i prikazivala
 * zatečeni sadržaj kao trenutno stanje. Kad daemon umre (ili ga netko ugasi), datoteka
 * ostaje zamrznuta i traka satima piše „Sending response" — 28.07.2026. je tako 59 minuta
 * stajalo „Šaljem odgovor selftest2559…", a zapis nije bio ni daemonov nego testni.
 *
 * Zato se stanje ovdje IZVODI iz tri neovisna signala, a ne iz jednog polja:
 *   1. živi li proces iz `daemon.pid` (tvrdi signal),
 *   2. je li to doista daemon (`/proc/<pid>/cmdline` sadrži RegocDaemon.ts) — PID se
 *      nakon pada reciklira, pa sam „proces postoji" nije dokaz,
 *   3. koliko je star zadnji upis (meki signal: živ proces koji je prestao pisati = visi).
 *
 * Starost se računa na POSLUŽITELJU. Preglednik ima svoj sat i svoju vremensku zonu;
 * računanje u pregledniku značilo bi da pomak sata izgleda kao mrtav daemon.
 *
 * Modul je namjerno bez I/O — sve čitanje ide kroz `LivenessDeps`, pa se svi rubni
 * slučajevi (mrtav PID, reciklirani PID, pokvaren JSON) mogu testirati bez pravog daemona.
 */

export type DaemonState = 'online' | 'stale' | 'offline'

/**
 * Daemon piše status svake sekunde iz glavne petlje, a od TASK-2990 i heartbeatom
 * svakih 10 s (i dok petlja čeka na spawn). Prag 30 s = tri propuštena otkucaja;
 * usklađen je s intervalom osvježavanja konzole (30 s), pa jedan spori tik ne pali alarm.
 */
export const STALE_AFTER_MS = 30_000

/** Očekivani potpis u cmdline procesa — brana od recikliranog PID-a. */
export const DAEMON_CMDLINE_MARKER = 'RegocDaemon.ts'

export interface DaemonStatusFile {
  status?: string
  currentTask?: string | null
  pendingMessages?: number
  processedToday?: number
  lastUpdate?: string
  uptime?: number
  pid?: number
  statusSince?: string | null
  [k: string]: unknown
}

export interface LivenessPayload {
  /** Izvedeno stanje — jedino što UI smije koristiti za bojanje trake. */
  state: DaemonState
  /** Proces iz daemon.pid postoji I izgleda kao daemon. */
  alive: boolean
  pid: number | null
  /** Starost zadnjeg upisa u sekundama; null ako nema upotrebljivog zapisa. */
  ageS: number | null
  /** Koliko traje TRENUTNO stanje (npr. „Delegiram 4 min") — razlikuje rad od visenja. */
  statusAgeS: number | null
  /** ISO vrijeme zadnjeg upisa. */
  lastSeen: string | null
  /** Zašto je stanje takvo kakvo jest — ide u tooltip, na hrvatskom. */
  reason: string
  /** Status koji se prikazuje: pravi status kad je živ, „OFFLINE" kad nije. */
  display: string
  /** Sadržaj status datoteke; kod offline stanja je to ZADNJE poznato, ne trenutno. */
  status: DaemonStatusFile
}

export interface LivenessDeps {
  /** Sadržaj status datoteke; baci grešku ako je nema. */
  readStatusFile: () => Promise<string>
  /** Vrijeme zadnje izmjene status datoteke (ms), ili null ako nedostupno. */
  statusFileMtimeMs: () => Promise<number | null>
  /** Sadržaj daemon.pid; baci grešku ako je nema. */
  readPidFile: () => Promise<string>
  /** Postoji li proces (kill -0). */
  processExists: (pid: number) => boolean
  /** cmdline procesa, radi provjere da je to doista daemon; null ako nedostupno. */
  processCmdline: (pid: number) => string | null
  now: () => number
}

function parseStatus(text: string): DaemonStatusFile | null {
  if (!text || !text.trim()) return null
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return raw as DaemonStatusFile
  } catch {
    return null
  }
}

function parsePid(text: string): number | null {
  const pid = parseInt(String(text ?? '').trim(), 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

function isoToMs(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** Sekunde, nikad negativne (sat posluzitelja se može pomaknuti unatrag). */
function ageSeconds(now: number, thenMs: number | null): number | null {
  if (thenMs === null) return null
  return Math.max(0, Math.round((now - thenMs) / 1000))
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'nepoznato'
  if (seconds < 60) return `${seconds} s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

/**
 * Živi li proces koji tvrdi da je daemon.
 *
 * `processExists` sam po sebi nije dovoljan: nakon pada daemona jezgra istu brojku
 * dodijeli bilo kojem novom procesu, pa bi mrtav daemon izgledao živ. Kad cmdline
 * nije dostupan (nema /proc), pouzdajemo se u postojanje procesa — bolje blaži
 * lažno „radi" nego lažni OFFLINE na sustavu bez /proc.
 */
export function verifyDaemonProcess(
  pid: number | null,
  deps: Pick<LivenessDeps, 'processExists' | 'processCmdline'>
): { alive: boolean; reason: string } {
  if (pid === null) return { alive: false, reason: 'daemon.pid ne postoji ili nije ispravan' }
  if (!deps.processExists(pid)) return { alive: false, reason: `proces ${pid} ne postoji` }
  const cmdline = deps.processCmdline(pid)
  if (cmdline === null) return { alive: true, reason: `proces ${pid} živ (cmdline nedostupan)` }
  if (!cmdline.includes(DAEMON_CMDLINE_MARKER)) {
    return { alive: false, reason: `PID ${pid} pripada drugom procesu (reciklirani PID)` }
  }
  return { alive: true, reason: `proces ${pid} živ` }
}

/**
 * Izvedi stanje daemona iz status datoteke i PID-a.
 * Nikad ne baca — pri svakoj grešci vraća `offline` s objašnjenjem, jer je „ne znam"
 * za nadzornu ploču isto što i „ne radi", a tiha greška je upravo ono što je zakazalo.
 */
export async function resolveDaemonLiveness(deps: LivenessDeps): Promise<LivenessPayload> {
  const now = deps.now()

  let statusText = ''
  try {
    statusText = await deps.readStatusFile()
  } catch {
    statusText = ''
  }
  const status = parseStatus(statusText)

  let mtimeMs: number | null = null
  try {
    mtimeMs = await deps.statusFileMtimeMs()
  } catch {
    mtimeMs = null
  }

  let pidText = ''
  try {
    pidText = await deps.readPidFile()
  } catch {
    pidText = ''
  }
  // PID iz same status datoteke ima prednost: veže stanje uz proces koji ga je zapisao.
  // daemon.pid je zamjena kad daemon još ne piše pid (starija verzija zapisa).
  const filePid = typeof status?.pid === 'number' && status.pid > 0 ? status.pid : null
  const pid = filePid ?? parsePid(pidText)

  const proc = verifyDaemonProcess(pid, deps)

  // Zadnji upis: novije od (lastUpdate iz sadržaja, mtime datoteke). mtime hvata i
  // slučaj kad je sadržaj neispravan, a datoteka se svejedno osvježava.
  const lastUpdateMs = isoToMs(status?.lastUpdate)
  const seenMs = lastUpdateMs !== null && mtimeMs !== null
    ? Math.max(lastUpdateMs, mtimeMs)
    : (lastUpdateMs ?? mtimeMs)
  const ageS = ageSeconds(now, seenMs)
  const statusAgeS = ageSeconds(now, isoToMs(status?.statusSince)) ?? ageS

  const lastSeen = seenMs !== null ? new Date(seenMs).toISOString() : null
  const lastStatus = typeof status?.status === 'string' ? status.status : null

  if (!status) {
    return {
      state: 'offline', alive: false, pid, ageS, statusAgeS: null, lastSeen,
      reason: statusText ? 'status datoteka nije ispravan JSON' : 'status datoteka ne postoji',
      display: 'OFFLINE',
      status: {},
    }
  }

  if (!proc.alive) {
    return {
      state: 'offline', alive: false, pid, ageS, statusAgeS, lastSeen,
      reason: `${proc.reason}; zadnji zapis prije ${formatAge(ageS)}`,
      display: 'OFFLINE',
      status,
    }
  }

  if (ageS === null || ageS * 1000 > STALE_AFTER_MS) {
    return {
      state: 'stale', alive: true, pid, ageS, statusAgeS, lastSeen,
      reason: ageS === null
        ? `proces ${pid} živ, ali zapis nema upotrebljivo vrijeme`
        : `proces ${pid} živ, ali ne piše status ${formatAge(ageS)} — moguće da visi`,
      display: lastStatus ?? 'Unknown',
      status,
    }
  }

  return {
    state: 'online', alive: true, pid, ageS, statusAgeS, lastSeen,
    reason: proc.reason,
    display: lastStatus ?? 'Unknown',
    status,
  }
}
