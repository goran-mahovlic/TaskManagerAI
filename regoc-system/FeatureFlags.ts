// ─── Feature Flags (runtime, hot-reload) ─────────────────────────────
// NT-A / TASK-2574 (PRJ-030). Runtime prekidači za sigurno uvođenje
// (flag OFF → shadow → canary → live). Rollback = flag na false BEZ restarta.
//
// Datoteka: ~/.claude/regoc/features.json
// Format:  { "<ime>": { "enabled": bool, "since": ISO, "note": "..." }, ... }
//
// Korištenje:
//   import { isEnabled } from './FeatureFlags'
//   if (isEnabled('userFlush')) { ... }   // default false ako flag ne postoji
//
// Keš se osvježava svakih FLAG_TTL_MS (30 s) — izmjena features.json je
// vidljiva bez restarta daemona.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || process.env.USERPROFILE || ''
const DEFAULT_FEATURES_FILE = join(HOME, '.claude', 'regoc', 'features.json')

// REGOC_FEATURES_FILE: override putanje (SAMO za testove/alat — produkcija ga ne postavlja,
// pa je ponašanje nepromijenjeno). Čita se pri svakom load-u, ne pri importu modula, da
// redoslijed test-fajlova ne može zaključati krivu putanju u dijeljenoj instanci. (TASK-2559)
function featuresFile(): string {
  return process.env.REGOC_FEATURES_FILE || DEFAULT_FEATURES_FILE
}
const FLAG_TTL_MS = 30_000

export interface FeatureFlag {
  enabled: boolean
  since?: string | null
  note?: string
}

type FlagMap = Record<string, FeatureFlag>

let _cache: FlagMap = {}
let _loadedAt = 0
let _cachedFrom = ''

function loadFlags(): FlagMap {
  const file = featuresFile()
  const now = Date.now()
  // Promjena putanje (test fixture) poništava keš odmah, bez čekanja TTL-a.
  if (file === _cachedFrom && now - _loadedAt < FLAG_TTL_MS) return _cache
  _cachedFrom = file
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'))
      _cache = (parsed && typeof parsed === 'object') ? parsed as FlagMap : {}
    } else {
      _cache = {}
    }
  } catch {
    // Zadrži zadnji dobar keš na grešci parsiranja — nikad ne rušimo poziv.
  }
  _loadedAt = now
  return _cache
}

/** True samo ako flag postoji i .enabled === true. Sigurno-po-defaultu. */
export function isEnabled(name: string, defaultValue = false): boolean {
  const flags = loadFlags()
  const f = flags[name]
  if (!f || typeof f.enabled !== 'boolean') return defaultValue
  return f.enabled
}

/** Cijeli zapis flaga (za dijagnostiku/alarm „flag >30 dana u shadow"). */
export function getFlag(name: string): FeatureFlag | undefined {
  return loadFlags()[name]
}

/** Svi flagovi (kopija). */
export function getAllFlags(): FlagMap {
  return { ...loadFlags() }
}

/** Prisili ponovno čitanje (za testove/alat). */
export function reloadFlags(): FlagMap {
  _loadedAt = 0
  return loadFlags()
}
