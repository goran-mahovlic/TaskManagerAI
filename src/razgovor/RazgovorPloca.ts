// ─── Razgovor na ploči: API i sklapanje (ADR-0002 §4, §12 R1/R6) ─────────────
// `GET/PUT /api/config/razgovor` i `GET /api/config/razgovor/povijest` kao čiste funkcije
// nad putanjom baze (testabilne bez poslužitelja), plus sklapanje razgovornog sloja za
// Telegram ulaz. TaskWebUI ovdje samo usmjerava zahtjeve.
//
// Autorica: Jelena (Engineer), TASK-5277.

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  RAZGOVOR_KLJUCEVI, RAZGOVOR_ZADANO, createRazgovorReader, getRazgovorPostavke, parseRazgovorPatch,
  puniDopusten, razgovorPovijest, setRazgovorPostavke,
} from './RazgovorPostavke'
import { stvoriRazgovor, type RazgovorJezgra, type RazgovorOvisnosti } from './Razgovor'
import { izvrsiteljRazgovora } from './Izvrsitelj'
import { procitajPosiljatelje, zabiljeziPosiljatelja, type Posiljatelj } from './Posiljatelji'
import type { RazgovorUlaza } from '../TelegramPoller'

export interface ApiOdgovor { status: number; tijelo: unknown }

function sDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath)
  try { return fn(db) } finally { try { db.close() } catch { /* ništa */ } }
}

export function razgovorGet(dbPath: string, dodatno: Record<string, unknown> = {}): ApiOdgovor {
  return sDb(dbPath, db => {
    const s = getRazgovorPostavke(db, { dopustiPuno: puniDopusten() })
    return {
      status: 200,
      tijelo: {
        ...s, zadano: RAZGOVOR_ZADANO, kljucevi: RAZGOVOR_KLJUCEVI,
        povijest: razgovorPovijest(db, 20), ...dodatno,
      },
    }
  })
}

export function razgovorPut(dbPath: string, tijelo: unknown): ApiOdgovor {
  if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
    return { status: 400, tijelo: { error: 'tijelo mora biti objekt' } }
  }
  const t = tijelo as Record<string, unknown>
  const by = typeof t.by === 'string' && t.by.trim() ? t.by.trim().slice(0, 64) : 'config'
  // `source` je samo oznaka za povijest — o pravima NE odlučuje (to može poslati bilo tko).
  const source = typeof t.source === 'string' && t.source.trim() ? t.source.trim().slice(0, 32) : 'api'
  const opcije = { dopustiPuno: puniDopusten() }
  return sDb(dbPath, db => {
    const p = parseRazgovorPatch(t, getRazgovorPostavke(db, opcije).postavke)
    if (!p.ok) return { status: 400, tijelo: { error: p.greske.join('; '), greske: p.greske, dopustena: p.dopustena } }
    try {
      const promjene = setRazgovorPostavke(db, p.value, by, source, opcije)
      return { status: 200, tijelo: { ok: true, promjene, ...getRazgovorPostavke(db, opcije) } }
    } catch (e: any) {
      return { status: 400, tijelo: { error: String(e?.message || e) } }
    }
  })
}

export function razgovorPovijestGet(dbPath: string, limit = 50): ApiOdgovor {
  return sDb(dbPath, db => ({ status: 200, tijelo: { povijest: razgovorPovijest(db, limit) } }))
}

/** `$TM_HOME/data/razgovor/posiljatelji.json` — zadnji pošiljatelji (TASK-5283). */
export function posiljateljiPut(dataDir: string): string {
  return join(dataDir, 'razgovor', 'posiljatelji.json')
}

export function zadnjiPosiljatelji(dataDir: string): Posiljatelj[] {
  return procitajPosiljatelje(posiljateljiPut(dataDir))
}

/** Model iz `model-config.json`: `agentOverrides.razgovor`, inače ništa (CLI bira sam). */
export function modelIzKonfiguracije(putanja: string): string | undefined {
  try {
    if (!existsSync(putanja)) return undefined
    const mc = JSON.parse(readFileSync(putanja, 'utf-8'))
    const v = mc?.agentOverrides?.razgovor
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  } catch { return undefined }
}

export interface SklapanjeOpcije extends Omit<RazgovorOvisnosti, 'postavke' | 'izvrsitelj' | 'korijen'> {
  dbPath: string
  dataDir: string
  modelConfigPath: string
}

/** Jedan razgovorni sloj po procesu ploče; poller ga dobiva kroz `RazgovorUlaza`. */
export function sklopiRazgovor(o: SklapanjeOpcije): { ulaz: RazgovorUlaza; jezgra: RazgovorJezgra } {
  const citac = createRazgovorReader({ dbPath: o.dbPath })
  const postavke = () => citac().postavke
  const jezgra = stvoriRazgovor({
    ...o,
    postavke,
    izvrsitelj: izvrsiteljRazgovora(),
    korijen: join(o.dataDir, 'razgovor'),
    modelZadano: () => modelIzKonfiguracije(o.modelConfigPath),
  })
  const put = posiljateljiPut(o.dataDir)
  return { ulaz: { razgovor: jezgra, postavke, zabiljezi: p => zabiljeziPosiljatelja(put, p) }, jezgra }
}
