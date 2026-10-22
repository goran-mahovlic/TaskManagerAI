/**
 * LogPaths — jedan izvor istine za putanje logova + rotacija (TASK-2987)
 *
 * ZAŠTO POSTOJI (mjereno 2026-07-28):
 *   1. TRI putanje za isti log: RegocDaemon.ts je pisao u ~/.tmp/regoc_daemon.log,
 *      manage.sh je čitao /tmp/regoc_daemon.log (ne postoji), a analiza incidenata
 *      gledala ~/.claude/regoc/daemon.log (mrtav od 27.07. 22:34).
 *   2. Log NIJE BIO KRONOLOŠKI. `awk` uzorak svakih 40 000 redaka je dao:
 *        redak 1 → 2026-07-28, 40001 → 2026-07-06, 80001 → 2026-04-19, …
 *      Uzrok: daemon je dobivao `stdout: Bun.file(LOG_FILE)` (offset 0, BEZ O_APPEND)
 *      dok je istovremeno `log()` appendao. Svaki restart je PREPISAO početak datoteke
 *      u mjestu i ostavio mozaik od četiri mjeseca. Svaka vremenski poredana analiza
 *      takvog loga je nevaljana — zato se zastoj tražio ručno.
 *   3. 392 968 / 421 635 redaka (93 %) bilo je „Last completed task: TASK-F8-010",
 *      otkucaj svakih 30 s bez ikakve promjene stanja.
 *
 * PRAVILA KOJA OVAJ MODUL NAMEĆE:
 *   • Jedna kanonska putanja; stare putanje postaju simlinkovi (postojeći grepovi rade).
 *   • Svi pisci otvaraju u O_APPEND — bez toga se datoteka prepisuje u mjestu.
 *   • Rotacija je copy-truncate: uz O_APPEND svaki write ide na kraj datoteke, pa
 *      otvoreni fd-ovi žive procesa NE stvaraju rijetku rupu nakon truncate-a.
 */

import {
  existsSync,
  statSync,
  lstatSync,
  mkdirSync,
  copyFileSync,
  truncateSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  readlinkSync,
  openSync,
  fstatSync,
  realpathSync,
} from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

/** SSOT: jedina putanja u koju REGOČ daemon smije pisati svoj log. */
export const REGOC_DAEMON_LOG = join(HOME, '.claude/regoc/daemon.log')

/**
 * Naslijeđene putanje → postaju simlinkovi na SSOT. Simlink pokazuje na PUTANJU,
 * pa preživi rotaciju (koja mijenja sadržaj, ne ime).
 */
export const LEGACY_DAEMON_LOGS = [join(HOME, '.tmp/regoc_daemon.log')]

/** Rotiraj kad datoteka pređe ovu veličinu. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024

/** Koliko rotiranih generacija čuvamo (daemon.log.1 … .5). */
export const KEEP_ROTATIONS = 5

export interface RotationResult {
  rotated: boolean
  /** Veličina prije zahvata (bajtovi). */
  sizeBefore: number
  /** Putanja u koju je sadržaj spremljen (kad je rotirano). */
  archivedTo?: string
  reason?: string
}

/**
 * Rotiraj log ako je prevelik. Copy-truncate: `.5` se briše, `.4→.5`, …, `.1→.2`,
 * sadržaj se kopira u `.1`, original se skrati na nulu. Živi procesi s O_APPEND
 * fd-om nastavljaju pisati u istu (sada praznu) datoteku — bez gubitka i bez rupe.
 */
export function rotateIfNeeded(
  logPath: string,
  opts: { maxBytes?: number; keep?: number } = {}
): RotationResult {
  const maxBytes = opts.maxBytes ?? MAX_LOG_BYTES
  const keep = opts.keep ?? KEEP_ROTATIONS

  // Simlink (kompatibilnost) → rotiraj stvarnu datoteku, ne link.
  let target = logPath
  try {
    if (lstatSync(logPath).isSymbolicLink()) target = realpathSync(logPath)
  } catch {
    return { rotated: false, sizeBefore: 0, reason: 'ne postoji' }
  }

  let size = 0
  try {
    size = statSync(target).size
  } catch {
    return { rotated: false, sizeBefore: 0, reason: 'ne postoji' }
  }
  if (size < maxBytes) return { rotated: false, sizeBefore: size, reason: 'ispod praga' }

  for (let i = keep; i >= 1; i--) {
    const cur = `${target}.${i}`
    if (!existsSync(cur)) continue
    if (i === keep) unlinkSync(cur)
    else renameSync(cur, `${target}.${i + 1}`)
  }
  copyFileSync(target, `${target}.1`)
  truncateSync(target, 0)
  return { rotated: true, sizeBefore: size, archivedTo: `${target}.1` }
}

export type CompatResult = 'created' | 'already-linked' | 'archived-and-linked' | 'skipped'

/**
 * Naslijeđenu putanju pretvori u simlink na SSOT. Ako na njoj stoji PRAVA datoteka
 * s poviješću, prvo je odloži u `<legacy>.pre-ssot` — povijest se ne baca.
 */
export function ensureLegacyCompatLink(legacyPath: string, canonicalPath: string): CompatResult {
  if (legacyPath === canonicalPath) return 'skipped'
  mkdirSync(dirname(legacyPath), { recursive: true })

  let st: ReturnType<typeof lstatSync> | null = null
  try {
    st = lstatSync(legacyPath)
  } catch {
    st = null
  }

  if (st?.isSymbolicLink()) {
    try {
      if (readlinkSync(legacyPath) === canonicalPath) return 'already-linked'
    } catch {
      /* neispravan link — prepiši ga */
    }
    unlinkSync(legacyPath)
    symlinkSync(canonicalPath, legacyPath)
    return 'created'
  }

  if (st?.isFile()) {
    if (st.size > 0) {
      const archive = `${legacyPath}.pre-ssot`
      if (existsSync(archive)) unlinkSync(archive)
      renameSync(legacyPath, archive)
      symlinkSync(canonicalPath, legacyPath)
      return 'archived-and-linked'
    }
    unlinkSync(legacyPath)
  }

  symlinkSync(canonicalPath, legacyPath)
  return 'created'
}

/**
 * File descriptor otvoren u O_APPEND — jedini ispravan način da se log preda
 * djetetu kao stdout/stderr. `Bun.file(path)` piše od offseta 0 i prepisuje log.
 */
export function openAppendFd(logPath: string): number {
  mkdirSync(dirname(logPath), { recursive: true })
  return openSync(logPath, 'a')
}

/**
 * Je li stdout procesa VEĆ preusmjeren u baš ovu datoteku? Ako jest, dodatni
 * appendFileSync bi svaki redak zapisao DVA puta (mjereno 2026-07-28 nakon prelaska
 * na O_APPEND: cijeli startni blok daemona bio je udvostručen).
 *
 * Uspoređuje dev+ino, pa je otporno na simlinkove; rotacija je copy-truncate koja
 * čuva inode, pa vrijedi i nakon rotacije.
 */
export function stdoutIsSameFile(logPath: string, fd = 1): boolean {
  try {
    const a = fstatSync(fd)
    if (!a.isFile()) return false
    const b = statSync(logPath)
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

/** Jednokratna priprema pri startu daemona: mapa staro→novo + rotacija. */
export function initDaemonLog(canonical = REGOC_DAEMON_LOG): {
  canonical: string
  rotation: RotationResult
  compat: Record<string, CompatResult>
} {
  mkdirSync(dirname(canonical), { recursive: true })
  const rotation = rotateIfNeeded(canonical)
  const compat: Record<string, CompatResult> = {}
  for (const legacy of LEGACY_DAEMON_LOGS) {
    try {
      compat[legacy] = ensureLegacyCompatLink(legacy, canonical)
    } catch {
      compat[legacy] = 'skipped'
    }
  }
  return { canonical, rotation, compat }
}
