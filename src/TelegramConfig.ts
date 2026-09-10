/**
 * TelegramConfig — postavke Telegram integracije unutar TaskManagerAI paketa.
 *
 * Zašto ovo postoji: Telegram je dosad živio POTPUNO IZVAN paketa
 * (`~/.claude/tools/Telegram/` — vezano za Klaudio agenta na glavnom stroju).
 * node-B nije imao nikakvu Telegram sposobnost. Ovaj modul donosi MINIMALNU,
 * SAMOSTANU Telegram sposobnost u sam paket — bot token + chat id kao config
 * polja (isti obrazac kao Dezurni/OpenRouter/Gemini kartice) i osnovnu funkciju
 * slanja obavijesti o završenom zadatku.
 *
 * NE koristi vanjske knjižnice — zove `https://api.telegram.org/bot<token>/sendMessage`
 * izravno preko `fetch()`.
 *
 * Bez restarta: datoteka se čita pri svakom pozivu, kao i `dezurni.json`.
 *
 * Autor: Kosjenka (Architect), 09.09.2026.
 */

import { readFileSync, renameSync, writeFileSync } from 'fs'
import { konfigPutanja, osigurajMapu } from './core/paths'

/**
 * ADR-0001 O1.4: postavke se traže obrascem `TM_TELEGRAM_CONFIG` → `$TM_HOME/config/`
 * → `config/` uz paket. Prije je ovdje pisala mapa jednog konkretnog stroja, koja na
 * tuđoj instalaciji ne postoji. Nadogradnja postojeće instalacije: prekopiraj datoteku
 * na novo mjesto ili postavi `TM_TELEGRAM_CONFIG` na staru putanju.
 */
export const TELEGRAM_CONFIG_PATH = konfigPutanja('telegram.json', 'TM_TELEGRAM_CONFIG')

export interface TelegramPostavke {
  /** Je li Telegram obavijesti uključen? */
  ukljucen: boolean
  /** Bot token od @BotFather (npr. `123456:ABC-DEF...`). */
  botToken: string
  /** Chat ID kojem se šalju obavijesti (npr. `-1001234567890` za grupu). */
  chatId: string
  /** Šalje li se obavijest kad zadatak prijeđe u completed? */
  obavijestZavrseno: boolean
  /** Šalje li se obavijest kad zadatak prijeđe u failed/error? */
  obavijestGreska: boolean
  /** Prefix poruke — npr. emoji ili oznaka sustava. */
  prefix: string
}

export const ZADANE_POSTAVKE: TelegramPostavke = {
  ukljucen: false,
  botToken: '',
  chatId: '',
  obavijestZavrseno: true,
  obavijestGreska: true,
  prefix: '📋',
}

export const GRANICE = {
  prefix: { maxDuljina: 20 },
  botToken: { maxDuljina: 200 },
  chatId: { maxDuljina: 50 },
} as const

/** Uvijek svjež pročitaj s diska. Nepoznata polja se ČUVAJU. */
export function loadTelegramConfig(
  path: string = TELEGRAM_CONFIG_PATH,
): TelegramPostavke & Record<string, unknown> {
  try {
    const sirovo = JSON.parse(readFileSync(path, 'utf-8'))
    if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo))
      return { ...ZADANE_POSTAVKE }
    return { ...ZADANE_POSTAVKE, ...sirovo }
  } catch {
    return { ...ZADANE_POSTAVKE }
  }
}

export interface Provjera {
  ok: boolean
  greske: string[]
  zakrpa: Partial<TelegramPostavke>
}

export function validateTelegramPatch(tijelo: unknown): Provjera {
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

  for (const kljuc of ['ukljucen', 'obavijestZavrseno', 'obavijestGreska'] as const) {
    if (kljuc in t) {
      if (typeof t[kljuc] !== 'boolean') greske.push(`${kljuc} mora biti true ili false`)
      else zakrpa[kljuc] = t[kljuc]
    }
  }

  if ('botToken' in t) {
    const v = String(t.botToken ?? '').trim()
    if (v.length > GRANICE.botToken.maxDuljina) {
      greske.push(`botToken je predugačak (najviše ${GRANICE.botToken.maxDuljina} znakova)`)
    } else {
      zakrpa.botToken = v
    }
  }

  if ('chatId' in t) {
    const v = String(t.chatId ?? '').trim()
    if (v.length > GRANICE.chatId.maxDuljina) {
      greske.push(`chatId je predugačak (najviše ${GRANICE.chatId.maxDuljina} znakova)`)
    } else {
      zakrpa.chatId = v
    }
  }

  if ('prefix' in t) {
    const v = String(t.prefix ?? '').trim()
    if (v.length > GRANICE.prefix.maxDuljina) {
      greske.push(`prefix je predugačak (najviše ${GRANICE.prefix.maxDuljina} znakova)`)
    } else {
      zakrpa.prefix = v
    }
  }

  if (!greske.length && !Object.keys(zakrpa).length) {
    greske.push('Nijedna postavka nije poslana')
  }
  return { ok: greske.length === 0, greske, zakrpa: zakrpa as Partial<TelegramPostavke> }
}

/** Spoji zakrpu s onim što je na disku i zapiši (atomski preko tmp + rename). */
export function saveTelegramConfig(
  zakrpa: Partial<TelegramPostavke>,
  path: string = TELEGRAM_CONFIG_PATH,
): TelegramPostavke & Record<string, unknown> {
  const trenutno = loadTelegramConfig(path)
  const novo = { ...trenutno, ...zakrpa }
  osigurajMapu(path)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  return novo
}

/**
 * Pošalji tekstualnu poruku na Telegram koristeći Bot API.
 * NE koristi vanjske knjižnice — izravni `fetch` prema `api.telegram.org`.
 *
 * @returns `{ ok: true }` ako je poslano, `{ ok: false, greska: '...' }` ako nije.
 */
export async function posaljiTelegramPoruku(
  tekst: string,
  configPath: string = TELEGRAM_CONFIG_PATH,
): Promise<{ ok: boolean; greska?: string }> {
  const cfg = loadTelegramConfig(configPath)
  if (!cfg.ukljucen) {
    return { ok: false, greska: 'Telegram obavijesti su isključene' }
  }
  if (!cfg.botToken) {
    return { ok: false, greska: 'botToken nije postavljen' }
  }
  if (!cfg.chatId) {
    return { ok: false, greska: 'chatId nije postavljen' }
  }

  const prefix = cfg.prefix ? `${cfg.prefix} ` : ''
  const poruka = `${prefix}${tekst}`

  try {
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: poruka,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    if (!resp.ok) {
      const tijelo = await resp.text().catch(() => '')
      return { ok: false, greska: `Telegram API ${resp.status}: ${tijelo.slice(0, 200)}` }
    }
    const data = await resp.json().catch(() => ({}))
    if (data && data.ok === false) {
      return { ok: false, greska: `Telegram API: ${data.description || 'nepoznata greška'}` }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, greska: `mrežna greška: ${String(e && e.message ? e.message : e)}` }
  }
}

/**
 * Pošalji obavijest o završenom zadatku.
 * Formatira poruku s ID-em zadatka, naslovom i statusom.
 */
export async function obavijestiZadatak(
  taskId: string,
  naslov: string,
  status: string,
  configPath: string = TELEGRAM_CONFIG_PATH,
): Promise<{ ok: boolean; greska?: string }> {
  const cfg = loadTelegramConfig(configPath)
  // Poštuj pojedinačne prekidače
  if (status === 'completed' && !cfg.obavijestZavrseno) {
    return { ok: false, greska: 'obavijestZavrseno je isključeno' }
  }
  if (status === 'failed' && !cfg.obavijestGreska) {
    return { ok: false, greska: 'obavijestGreska je isključeno' }
  }

  const ikona = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '📋'
  const tekst = `${ikona} Zadatak <b>${_escHtml(taskId)}</b> — ${_escHtml(status)}\n${_escHtml(naslov)}`
  return posaljiTelegramPoruku(tekst, configPath)
}

/** HTML-escape za Telegram poruke (parse_mode: HTML). */
function _escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
