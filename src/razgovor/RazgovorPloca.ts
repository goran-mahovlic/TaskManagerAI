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
import { ucitajAgente, ucitajUpute } from './Identitet'
import { procitajPosiljatelje, zabiljeziPosiljatelja, type Posiljatelj } from './Posiljatelji'
import type { RazgovorUlaza } from '../TelegramPoller'
import { MIN_TAJNA, cistaAdresa, stvoriBotKanal, type BotKanal, type Zahtjev } from './BotKanal'
import {
  botKanalPovijest, createBotKanalReader, getBotKanalPostavke, parseBotKanalPatch, setBotKanalPostavke, spremisteUBazi,
} from './BotKanalPostavke'
import { normaliziraj } from './Filtar'
import type { UlaznaPoruka } from './Kanal'

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

export interface SklapanjeOpcije extends Omit<RazgovorOvisnosti, 'postavke' | 'izvrsitelj' | 'korijen' | 'agenti' | 'upute'> {
  dbPath: string
  dataDir: string
  modelConfigPath: string
  /** Registar agenata (`TM_AGENTS_REGISTRY`) — čita se pri svakoj novoj sesiji (TASK-5293). */
  agentiPut?: string
}

/** Ime ovog kraja u ugovoru bot↔bot: ime razgovora bez dijakritike („Šaban" → `saban`). */
export function imeUKanalu(ime: string): string {
  return normaliziraj(ime).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'bot'
}

export interface RazgovorSloj { ulaz: RazgovorUlaza; jezgra: RazgovorJezgra; botKanal: BotKanal }

/** Jedan razgovorni sloj po procesu ploče; poller ga dobiva kroz `RazgovorUlaza`. */
export function sklopiRazgovor(o: SklapanjeOpcije): RazgovorSloj {
  const citac = createRazgovorReader({ dbPath: o.dbPath })
  const postavke = () => citac().postavke
  const bkPostavke = createBotKanalReader(o.dbPath)
  let ulaz: RazgovorUlaza
  let jezgra: RazgovorJezgra
  // ADR-0003: kanal bot↔bot — tajne (po jedna po smjeru, TASK-5299) samo iz okoline stroja, nikad iz postavki.
  const botKanal = stvoriBotKanal({
    ja: imeUKanalu(postavke().ime || 'bot'),
    postavke: bkPostavke,
    tajnaSlanja: () => o.env.TM_BOT_KANAL_TAJNA_SLANJE,
    tajnaPrimanja: () => o.env.TM_BOT_KANAL_TAJNA_PRIMANJE,
    spremiste: spremisteUBazi(o.dbPath),
    zadaniStopKorisnici: () => postavke().dopusteniKorisnici,
    javiUGrupu: (chatId, tekst) => ulaz.aktivniKanal?.posaljiTekst(chatId, tekst),
    naStop: chatId => { jezgra.prekiniBotPoteze('telegram', chatId) },
    log: o.log,
  })
  jezgra = stvoriRazgovor({
    ...o,
    postavke,
    izvrsitelj: izvrsiteljRazgovora(),
    korijen: join(o.dataDir, 'razgovor'),
    modelZadano: () => modelIzKonfiguracije(o.modelConfigPath),
    agenti: () => ucitajAgente(o.agentiPut),
    upute: () => ucitajUpute(o.uputePut),
    botKanal: () => ({ jeZaustavljen: c => botKanal.jeZaustavljen(c), prenesi: u => botKanal.prenesi(u), ovlasti: () => bkPostavke().ovlasti }),
  })
  const put = posiljateljiPut(o.dataDir)
  ulaz = { razgovor: jezgra, postavke, zabiljezi: p => zabiljeziPosiljatelja(put, p), konzola: o.konzola, botKanal }
  return { ulaz, jezgra, botKanal }
}

// ─── Kanal bot↔bot: rute (ADR-0003 §3) ───────────────────────────────────────

/**
 * `POST /api/razgovor/od-bota`: brave i potpis u `BotKanal.primi` (nad sirovim tijelom `z.tijelo`); uz 202 poruka ide u razgovor
 * kao `izvor:'bot'` — NIKAD u ingest (bot-poruka ne otvara zadatak, ADR-0003 §4.4).
 */
export function odBotaPost(sloj: RazgovorSloj, z: Zahtjev): ApiOdgovor {
  const r = sloj.botKanal.primi(z)
  if (r.status !== 202 || !r.poruka) return { status: r.status, tijelo: r.tijelo }
  const kanal = sloj.ulaz.aktivniKanal
  if (!kanal || !sloj.ulaz.postavke().ukljucen) {
    return { status: 503, tijelo: { error: 'razgovor ili Telegram petlja na ovom stroju ne radi' } }
  }
  const m = r.poruka
  const drugi = m.izvor.charAt(0).toUpperCase() + m.izvor.slice(1)
  const p: UlaznaPoruka = {
    kanal: 'telegram', chatId: m.chatId, porukaId: m.telegramPorukaId || '',
    posiljateljId: `bot:${m.izvor}`, posiljateljIme: `${drugi} (bot)`, posiljateljJeBot: true,
    tekst: m.tekst, ts: m.ts || new Date().toISOString(), privatno: false, obracanjeBotu: true,
    izvor: 'bot', lanac: { izvor: m.izvor, lanacId: m.lanacId, skok: m.skok, izvornik: m.izvornik },
  }
  sloj.jezgra.primi(p, kanal)
  return { status: 202, tijelo: r.tijelo }
}

const stanjeTajne = (t: string | undefined) => !t ? 'nedostaje' : t.length < MIN_TAJNA ? 'prekratka' : 'postavljena'

/** Kartica Config → Razgovor → Bot↔bot: postavke, zastavice, jesu li tajne postavljene (ne i one). */
export function botKanalGet(dbPath: string, sloj: RazgovorSloj | null, env: Record<string, string | undefined>): ApiOdgovor {
  return sDb(dbPath, db => {
    const { postavke, upozorenja } = getBotKanalPostavke(db)
    return {
      status: 200,
      tijelo: {
        postavke, upozorenja, tajna: { slanje: stanjeTajne(env.TM_BOT_KANAL_TAJNA_SLANJE), primanje: stanjeTajne(env.TM_BOT_KANAL_TAJNA_PRIMANJE) },
        ja: sloj ? imeUKanalu(sloj.ulaz.postavke().ime || 'bot') : null,
        zastavice: sloj ? sloj.botKanal.stanje().zastavice : {},
        povijest: botKanalPovijest(db, 20),
      },
    }
  })
}

/**
 * Zahtjev s adrese DRUGOG bota (popis `adrese`) ne smije mijenjati postavke kanala ni nastaviti
 * razmjenu (TASK-5291, N1b): ondje radi model s ljuskom i tajnom, pa bi „Prekini komunikaciju"
 * poništio jednim curl-om. API ploče nema prijavu — ovo zatvara samo put s drugog bota.
 */
function sDrugogKraja(dbPath: string, ip: string | null | undefined): boolean {
  const a = cistaAdresa(ip)
  if (!a) return false
  try { return sDb(dbPath, db => getBotKanalPostavke(db).postavke.adrese.includes(a)) } catch { return false }
}

export function botKanalPut(dbPath: string, tijelo: unknown, ip?: string | null): ApiOdgovor {
  if (sDrugogKraja(dbPath, ip)) return { status: 403, tijelo: { error: 'postavke kanala bot↔bot ne mijenja drugi kraj' } }
  const p = parseBotKanalPatch(tijelo)
  if (!p.ok) return { status: 400, tijelo: { error: p.greske.join('; '), greske: p.greske, dopustena: p.dopustena } }
  const t = (tijelo || {}) as Record<string, unknown>
  const by = typeof t.by === 'string' && t.by.trim() ? t.by.trim().slice(0, 64) : 'config'
  return sDb(dbPath, db => {
    try {
      const promjene = setBotKanalPostavke(db, p.value, by, 'api')
      return { status: 200, tijelo: { ok: true, promjene, ...getBotKanalPostavke(db) } }
    } catch (e: any) { return { status: 400, tijelo: { error: String(e?.message || e) } } }
  })
}

/** Gumb na kartici: „Nastavi bot↔bot" / „Zaustavi" — šalje se i drugom kraju. */
export async function botKanalRucno(sloj: RazgovorSloj, raw: unknown, ip?: string | null, dbPath?: string): Promise<ApiOdgovor> {
  const t = (raw || {}) as Record<string, unknown>
  const chatId = typeof t.chatId === 'number' ? String(t.chatId) : t.chatId
  if (typeof chatId !== 'string' || !/^-?\d{1,20}$/.test(chatId)) return { status: 400, tijelo: { error: 'chatId je obavezan' } }
  const by = typeof t.by === 'string' && t.by.trim() ? t.by.trim().slice(0, 64) : 'config'
  if (t.radnja === 'nastavi' && dbPath && sDrugogKraja(dbPath, ip)) return { status: 403, tijelo: { error: 'nastavak bot↔bot ne smije doći s drugog kraja' } }
  if (t.radnja === 'nastavi') await sloj.botKanal.nastavi(chatId, by)
  else if (t.radnja === 'zaustavi') await sloj.botKanal.zaustavi(chatId, by, 'rucno')
  else return { status: 400, tijelo: { error: 'radnja: nastavi ili zaustavi' } }
  return { status: 200, tijelo: { ok: true, zastavice: sloj.botKanal.stanje().zastavice } }
}
