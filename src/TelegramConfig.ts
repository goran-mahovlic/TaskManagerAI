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

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { existsSync } from 'fs'
import { konfigPutanja, konfigPutanjaZaPisanje, osigurajMapu } from './core/paths'
import { procitajTajnu, zapisiTajnu } from './core/ConfigModul'

/**
 * ADR-0001 O1.4: postavke se traže obrascem `TM_TELEGRAM_CONFIG` → `$TM_HOME/config/`
 * → `config/` uz paket. Prije je ovdje pisala mapa jednog konkretnog stroja, koja na
 * tuđoj instalaciji ne postoji. Nadogradnja postojeće instalacije: prekopiraj datoteku
 * na novo mjesto ili postavi `TM_TELEGRAM_CONFIG` na staru putanju.
 */
export function telegramConfigPath(): string {
  return konfigPutanja('telegram.json', 'TM_TELEGRAM_CONFIG')
}

/** Zamrznuto pri pokretanju — samo za prikaz. Za CITANJE koristi `telegramConfigPath()`. */
export const TELEGRAM_CONFIG_PATH = telegramConfigPath()

/** Kamo ide PRVI zapis: `$TM_HOME/config/`, a ne primjer uz paket (v. `core/paths.ts`). */
export function telegramConfigWritePath(): string {
  return konfigPutanjaZaPisanje('telegram.json', 'TM_TELEGRAM_CONFIG')
}
export const TELEGRAM_CONFIG_WRITE_PATH = telegramConfigWritePath()

export interface TelegramPostavke {
  /** Je li Telegram obavijesti uključen? */
  ukljucen: boolean
  /**
   * NASLIJEĐENO polje: bot token u čistom tekstu unutar JSON-a.
   *
   * Novi zapis ga NE koristi — `saveTelegramConfig` tajnu odmah preseli u datoteku s
   * vjerodajnicama (prava 0600) i ovdje ostavi prazan niz. Čita se i dalje, da nadogradnja
   * postojeće instalacije ne ugasi bota; prvo spremanje s ploče ga preseli.
   * Revizija TASK-4801, nalaz B2. Za rad koristi `telegramBotToken(cfg)`.
   */
  botToken: string
  /** IME varijable okoline / retka u datoteci s tajnama u kojoj token doista živi. */
  botTokenEnv: string
  /** Chat ID kojem se šalju obavijesti (npr. `-1001234567890` za grupu). */
  chatId: string
  /** Šalje li se obavijest kad zadatak prijeđe u completed? */
  obavijestZavrseno: boolean
  /** Šalje li se obavijest kad zadatak prijeđe u failed/error? */
  obavijestGreska: boolean
  /** Prefix poruke — npr. emoji ili oznaka sustava. */
  prefix: string
  /** ULAZNI smjer (poller). Zaseban prekidač — v. `ulaz.ukljucen`. */
  ulaz: TelegramUlaz
}

/**
 * Ulazni smjer živi kao POTPOLJE, a ne kao zasebna datoteka: isti bot token vrijedi za oba
 * smjera, a dvije datoteke značile bi dvije istine o istom tokenu.
 *
 * Instalacija koja upiše samo bot token dobiva IZLAZ; ulaz se pali izričito. Bot koji sam
 * otvara zadatke iz svake poruke koju vidi je iznenađenje, ne značajka.
 */
export interface TelegramUlaz {
  ukljucen: boolean
  /** Razmak između poziva `getUpdates` (1–60 s). */
  intervalSek: number
  /** Rok dugog čekanja; Telegram dopušta najviše 50. */
  timeoutSek: number
  /** Prazno = sve što bot vidi; inače popis dopuštenih chatova. */
  dopusteniChatovi: string[]
  /** Prazno = svi; inače popis `user_id`-eva. */
  dopusteniKorisnici: string[]
  /** Prazno = svaka poruka; npr. `/zadatak`. */
  okidac: string
  /** U grupi reagiraj samo kad je bot spomenut. */
  sameSpomeni: boolean
  /** Pošalji natrag broj otvorenog zadatka. */
  potvrdaUChat: boolean
  maxDuljina: number
}

export const ZADANI_ULAZ: TelegramUlaz = {
  ukljucen: false,
  intervalSek: 3,
  timeoutSek: 25,
  dopusteniChatovi: [],
  dopusteniKorisnici: [],
  okidac: '',
  sameSpomeni: false,
  potvrdaUChat: true,
  maxDuljina: 4000,
}

export const ZADANE_POSTAVKE: TelegramPostavke = {
  ukljucen: false,
  botToken: '',
  botTokenEnv: 'TELEGRAM_BOT_TOKEN',
  chatId: '',
  obavijestZavrseno: true,
  obavijestGreska: true,
  prefix: '📋',
  ulaz: ZADANI_ULAZ,
}

/** Ime varijable okoline, ne sama tajna — isti uzorak kao u ostale četiri integracije. */
const RE_ENV = /^[A-Z][A-Z0-9_]{1,63}$/

export const GRANICE = {
  prefix: { maxDuljina: 20 },
  botToken: { maxDuljina: 200 },
  chatId: { maxDuljina: 50 },
  intervalSek: { min: 1, max: 60 },
  timeoutSek: { min: 0, max: 50 },
  okidac: { maxDuljina: 40 },
  maxDuljina: { min: 100, max: 20000 },
  popis: { maxStavki: 50 },
} as const

/** Uvijek svjež pročitaj s diska. Nepoznata polja se ČUVAJU. */
export function loadTelegramConfig(
  path: string = telegramConfigPath(),
): TelegramPostavke & Record<string, unknown> {
  try {
    const sirovo = JSON.parse(readFileSync(path, 'utf-8'))
    if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo))
      return { ...ZADANE_POSTAVKE }
    // `ulaz` se spaja po DUBINI: plitki spoj bi datoteci koja ima samo `ulaz.ukljucen`
    // pobrisao sva ostala polja ulaza i vratio ih na nedefinirano.
    return {
      ...ZADANE_POSTAVKE,
      ...sirovo,
      ulaz: { ...ZADANI_ULAZ, ...(sirovo.ulaz && typeof sirovo.ulaz === 'object' ? sirovo.ulaz : {}) },
    }
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
    } else if (v) {
      zakrpa.botToken = v
    }
    // PRAZNO polje NE briše token. Kartica ga od nalaza B2 više ne prikazuje, pa je prazno
    // polje normalno stanje svakog spremanja — kad bi ono brisalo tajnu, prva promjena bilo
    // koje druge postavke ugasila bi bota. Token se miče brisanjem retka iz datoteke s
    // tajnama, dakle svjesnom radnjom na stroju, a ne praznim poljem u pregledniku.
  }

  if ('botTokenEnv' in t) {
    const v = String(t.botTokenEnv ?? '').trim()
    if (!RE_ENV.test(v)) {
      greske.push('botTokenEnv mora biti IME varijable okoline VELIKIM SLOVIMA (npr. TELEGRAM_BOT_TOKEN)')
    } else {
      zakrpa.botTokenEnv = v
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

  // ULAZ — ugniježđeni objekt. Do TASK-4800 je `dopustena` pokrivala samo prvu razinu, pa
  // bi tipfeler u `ulaz` tiho stvorio mrtvu postavku; sada se odbija imenom, kao i gore.
  if ('ulaz' in t) {
    if (!t.ulaz || typeof t.ulaz !== 'object' || Array.isArray(t.ulaz)) {
      greske.push('ulaz mora biti objekt')
    } else {
      const u = t.ulaz as Record<string, unknown>
      const dopusteniUlaz = Object.keys(ZADANI_ULAZ)
      const izlaz: Record<string, unknown> = {}
      for (const k of Object.keys(u)) {
        if (!dopusteniUlaz.includes(k)) {
          greske.push(`Nepoznato polje: ulaz.${k} (dopušteno: ${dopusteniUlaz.join(', ')})`)
        }
      }
      for (const k of ['ukljucen', 'sameSpomeni', 'potvrdaUChat'] as const) {
        if (!(k in u)) continue
        if (typeof u[k] !== 'boolean') greske.push(`ulaz.${k} mora biti true ili false`)
        else izlaz[k] = u[k]
      }
      const brojevi: [string, { min: number; max: number }][] = [
        ['intervalSek', GRANICE.intervalSek],
        ['timeoutSek', GRANICE.timeoutSek],
        ['maxDuljina', GRANICE.maxDuljina],
      ]
      for (const [k, g] of brojevi) {
        if (!(k in u)) continue
        const n = Number(u[k])
        if (!Number.isFinite(n) || n < g.min || n > g.max) {
          greske.push(`ulaz.${k} mora biti broj između ${g.min} i ${g.max}`)
        } else izlaz[k] = n
      }
      if ('okidac' in u) {
        const v = String(u.okidac ?? '').trim()
        if (v.length > GRANICE.okidac.maxDuljina) {
          greske.push(`ulaz.okidac je predugačak (najviše ${GRANICE.okidac.maxDuljina} znakova)`)
        } else izlaz.okidac = v
      }
      for (const k of ['dopusteniChatovi', 'dopusteniKorisnici'] as const) {
        if (!(k in u)) continue
        if (!Array.isArray(u[k])) { greske.push(`ulaz.${k} mora biti popis`); continue }
        const popis = (u[k] as unknown[]).map(x => String(x).trim()).filter(Boolean)
        if (popis.length > GRANICE.popis.maxStavki) {
          greske.push(`ulaz.${k}: najviše ${GRANICE.popis.maxStavki} stavki`)
        } else izlaz[k] = popis
      }
      if (Object.keys(izlaz).length) zakrpa.ulaz = izlaz
    }
  }

  if (!greske.length && !Object.keys(zakrpa).length) {
    greske.push('Nijedna postavka nije poslana')
  }
  return { ok: greske.length === 0, greske, zakrpa: zakrpa as Partial<TelegramPostavke> }
}

/**
 * Vrijednost bot tokena ZA POZIV (nikad za prikaz).
 *
 * Redoslijed: varijabla okoline / datoteka s tajnama (`botTokenEnv`), pa naslijeđeno polje
 * `botToken` iz JSON-a. Drugi korak postoji samo zbog nadogradnje postojeće instalacije —
 * bez njega bi popravak B2 ugasio bota svakome tko još nije spremio postavke s ploče.
 */
export function telegramBotToken(cfg: TelegramPostavke): string {
  return procitajTajnu(cfg.botTokenEnv || ZADANE_POSTAVKE.botTokenEnv) || cfg.botToken || ''
}

/**
 * Spoji zakrpu s onim što je na disku i zapiši (atomski preko tmp + rename).
 *
 * DVIJE OBRANE IZ REVIZIJE TASK-4801 (nalaz B2):
 *   1. tajna ne ostaje u JSON-u — token iz zakrpe seli u datoteku s vjerodajnicama
 *      (`zapisiTajnu`, prava 0600), a u JSON-u ostaje prazan niz;
 *   2. sam JSON se piše s `mode: 0o600`, a postojećoj datoteci se prava POPRAVLJAJU
 *      (`chmodSync`) — bez toga bi `umask 0002` ostavio 0664, dakle grupno čitljivo.
 *      `mode` kod `writeFileSync` vrijedi samo za NOVU datoteku, pa oboje treba.
 *
 * Ako zapis tajne ne uspije (read-only mapa, nema prava), token OSTAJE u JSON-u i to se
 * kaže u dnevniku: tiho odbacivanje tajne značilo bi da korisnik misli da ju je spremio.
 */
export function saveTelegramConfig(
  zakrpa: Partial<TelegramPostavke>,
  path: string = telegramConfigWritePath(),
): TelegramPostavke & Record<string, unknown> {
  const trenutno = loadTelegramConfig(existsSync(path) ? path : telegramConfigPath())
  // Spoj po dubini za `ulaz` — zakrpa s jednim poljem ne smije pregaziti cijelu granu.
  const novo = {
    ...trenutno, ...zakrpa,
    ulaz: { ...trenutno.ulaz, ...(zakrpa.ulaz || {}) },
  }

  const token = String(novo.botToken || '').trim()
  if (token) {
    const ime = String(novo.botTokenEnv || ZADANE_POSTAVKE.botTokenEnv).trim()
    const r = zapisiTajnu(ime, token)
    if (r.ok) novo.botTokenEnv = ime, novo.botToken = ''
    else console.warn(`[TELEGRAM] tajna ostaje u JSON-u — ${ime} se nije dala zapisati: ${r.greska}`)
  }

  osigurajMapu(path)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch { /* tuđa datoteka ili FS bez prava — bolje spremiti nego pasti */ }
  return novo
}

/**
 * Tijelo odgovora `GET /api/telegram/config`.
 *
 * KVAR KOJI OVO ZATVARA (revizija TASK-4801, nalaz B2): ploča je vraćala CIJELE postavke,
 * dakle i bot token, dva retka ispod komentara koji tvrdi da vrijednost ne otkriva. Ploča
 * sluša na `0.0.0.0` bez prijave, pa je to bio token za svakoga tko dosegne vrata.
 *
 * Ovdje se tajna ne skriva maskiranjem nego IZOSTAVLJANJEM polja: maska je i dalje niz koji
 * netko negdje zaboravi skratiti. Kartici je dovoljno `stanje.tokenPostavljen`.
 */
export function odgovorTelegramPloci(cfg: TelegramPostavke, putanja: string) {
  const { botToken, ...bezTajne } = cfg as TelegramPostavke & Record<string, unknown>
  const tokenPostavljen = !!telegramBotToken(cfg)
  return {
    postavke: bezTajne,
    stanje: {
      tokenPostavljen,
      chatIdPostavljen: !!cfg.chatId,
      spreman: cfg.ukljucen && tokenPostavljen && !!cfg.chatId,
    },
    putanja,
    granice: GRANICE,
  }
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
  const token = telegramBotToken(cfg)
  if (!token) {
    return { ok: false, greska: `bot token nije postavljen (varijabla ${cfg.botTokenEnv || ZADANE_POSTAVKE.botTokenEnv})` }
  }
  if (!cfg.chatId) {
    return { ok: false, greska: 'chatId nije postavljen' }
  }

  const prefix = cfg.prefix ? `${cfg.prefix} ` : ''
  const poruka = `${prefix}${tekst}`

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`
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
