// ─── Postavke kanala bot↔bot (ADR-0003 §7) ───────────────────────────────────
// `razgovor.botKanal.*` u tablici `settings`, kao i ostale postavke razgovora: svaka promjena je
// redak u `settings_history`, nepoznata polja i vrijednosti izvan raspona se ODBIJAJU.
// Zastavica po chatu (`razgovor.botKanal.stanje`) upisuje sustav (stop-fraza, strop, gumb);
// brojilo stropa i vlastite poslane poruke žive u procesu (restart ih hvata `skok ≤ strop`).
//
// Tajne (`TM_BOT_KANAL_TAJNA_SLANJE` / `_PRIMANJE`, TASK-5299; `…_<IME>` po drugom botu, TASK-5728) NISU
// postavka — samo okolina stroja ili spremište tajni čvora (ADR-0003 §3).
//
// Autorica: Jelena (Engineer), TASK-5290.

import { Database } from 'bun:sqlite'
import { ensureSettingsSchema } from '../core/ConcurrencySetting'
import {
  BOT_KANAL_ZADANO, praznoStanje, smijeTajnuNa, type BotKanalPostavke, type BotKanalStanje, type DrugiBot, type Spremiste,
  type ZastavicaChata,
} from './BotKanal'

type Polje = keyof BotKanalPostavke

export const BOT_KANAL_KLJUCEVI: Readonly<Record<Polje, string>> = Object.freeze({
  ukljucen: 'razgovor.botKanal.ukljucen',
  drugi: 'razgovor.botKanal.drugi',
  chatovi: 'razgovor.botKanal.chatovi',
  adrese: 'razgovor.botKanal.adrese',
  ovlasti: 'razgovor.botKanal.ovlasti',
  stopKorisnici: 'razgovor.botKanal.stopKorisnici',
  strop: 'razgovor.botKanal.strop',
  prozorMin: 'razgovor.botKanal.prozorMin',
})
export const BOT_KANAL_STANJE_KLJUC = 'razgovor.botKanal.stanje'

const NIZOVI: readonly Polje[] = ['drugi', 'chatovi', 'adrese', 'stopKorisnici']
const RASPONI: Partial<Record<Polje, [number, number]>> = { strop: [1, 20], prozorMin: [1, 120] }

function provjeri(polje: Polje, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const raspon = RASPONI[polje]
  if (raspon) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    return typeof n === 'number' && Number.isInteger(n) && n >= raspon[0] && n <= raspon[1]
      ? { ok: true, value: n } : { ok: false, error: `botKanal.${polje} mora biti cijeli broj ${raspon[0]}–${raspon[1]}` }
  }
  switch (polje) {
    case 'ukljucen':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, error: 'botKanal.ukljucen mora biti true ili false' }
    case 'ovlasti':
      // `puno` nikad: bot-poruku je mogao oblikovati bilo koji član grupe (ADR-0003 §6).
      return v === 'citanje' || v === 'rad' ? { ok: true, value: v } : { ok: false, error: 'botKanal.ovlasti mora biti citanje ili rad' }
    case 'drugi': {
      if (!Array.isArray(v) || v.length > 5) return { ok: false, error: 'botKanal.drugi: popis od najviše 5 {ime, korisnickoIme, url}' }
      const out: DrugiBot[] = []
      for (const x of v) {
        const o = x as Record<string, unknown>
        const ime = String(o?.ime ?? '').trim()
        const ki = String(o?.korisnickoIme ?? '').trim().replace(/^@/, '')
        const url = String(o?.url ?? '').trim().replace(/\/+$/, '')
        if (!/^[\w.-]{1,40}$/.test(ime)) return { ok: false, error: 'botKanal.drugi.ime: slova, brojke, _ . -' }
        if (!/^\w{3,64}$/.test(ki)) return { ok: false, error: 'botKanal.drugi.korisnickoIme: Telegram korisničko ime' }
        try {
          const u = new URL(url)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
        } catch { return { ok: false, error: 'botKanal.drugi.url mora biti http(s) adresa ploče' } }
        // TASK-5728: chatovi u kojima je bot drugi kraj — s dva ili više botova obavezni (inače svaki
        // bot smije u svaku grupu i vidi tuđe zapise).
        if (o?.chatovi === undefined) { out.push({ ime, korisnickoIme: ki, url }); continue }
        const chatovi = Array.isArray(o.chatovi) ? o.chatovi.map(c => String(c).trim()).filter(Boolean) : null
        if (!chatovi || chatovi.length > 50 || chatovi.some(c => !/^-?\d{1,20}$/.test(c))) {
          return { ok: false, error: 'botKanal.drugi.chatovi: popis brojčanih id-eva chatova' }
        }
        out.push({ ime, korisnickoIme: ki, url, chatovi: [...new Set(chatovi)] })
      }
      if (out.length > 1 && out.some(x => !x.chatovi?.length)) {
        return { ok: false, error: 'botKanal.drugi: uz dva ili više botova svaki mora imati svoje chatovi' }
      }
      return { ok: true, value: out }
    }
    case 'chatovi':
    case 'stopKorisnici': {
      if (!Array.isArray(v) || v.length > 50) return { ok: false, error: `botKanal.${polje}: popis (najviše 50)` }
      const ids = v.map(x => String(x).trim()).filter(Boolean)
      const re = polje === 'chatovi' ? /^-?\d{1,20}$/ : /^\d{1,20}$/
      // Stop-korisnici samo po brojčanom id-u: korisničko ime se može preuzeti (ADR-0002 §7.3).
      if (ids.some(x => !re.test(x))) return { ok: false, error: `botKanal.${polje}: samo brojčani id-evi` }
      return { ok: true, value: [...new Set(ids)] }
    }
    case 'adrese': {
      if (!Array.isArray(v) || v.length > 20) return { ok: false, error: 'botKanal.adrese: popis (najviše 20)' }
      const a = v.map(x => String(x).trim()).filter(Boolean)
      if (a.some(x => !/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,39}$/i.test(x))) return { ok: false, error: 'botKanal.adrese: IP adrese' }
      return { ok: true, value: [...new Set(a)] }
    }
  }
  return { ok: false, error: `botKanal.${polje}: nepoznato` }
}

export function parseBotKanalPatch(raw: unknown): { ok: true; value: Partial<BotKanalPostavke> } | { ok: false; greske: string[]; dopustena: string[] } {
  const dopustena = Object.keys(BOT_KANAL_KLJUCEVI)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, greske: ['tijelo mora biti objekt'], dopustena }
  const greske: string[] = []
  const value: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'by' || k === 'source') continue
    if (!dopustena.includes(k)) { greske.push(`Nepoznato polje: ${k}`); continue }
    const p = provjeri(k as Polje, v)
    if (!p.ok) greske.push(p.error)
    else value[k] = p.value
  }
  return greske.length ? { ok: false, greske, dopustena } : { ok: true, value: value as Partial<BotKanalPostavke> }
}

export function getBotKanalPostavke(db: Database): { postavke: BotKanalPostavke; upozorenja: string[] } {
  const postavke: Record<string, unknown> = { ...BOT_KANAL_ZADANO, drugi: [], chatovi: [], adrese: [], stopKorisnici: [] }
  const upozorenja: string[] = []
  let redovi: Array<{ key: string; value: string }> = []
  const kljucevi = Object.values(BOT_KANAL_KLJUCEVI)
  try {
    redovi = db.query(`SELECT key, value FROM settings WHERE key IN (${kljucevi.map(() => '?').join(',')})`).all(...kljucevi) as any
  } catch { /* nema tablice = zadano */ }
  const poKljucu = new Map(redovi.map(r => [r.key, r.value]))
  for (const [polje, kljuc] of Object.entries(BOT_KANAL_KLJUCEVI) as [Polje, string][]) {
    const s = poKljucu.get(kljuc)
    if (s === undefined) continue
    let v: unknown = s
    try {
      if (NIZOVI.includes(polje)) v = JSON.parse(s)
      else if (polje === 'ukljucen') v = s === 'true' ? true : s === 'false' ? false : s
    } catch { /* ostaje tekst → provjera ga odbije */ }
    const p = provjeri(polje, v)
    if (p.ok) postavke[polje] = p.value
    else upozorenja.push(`${kljuc}: nečitljiva vrijednost u bazi — vrijedi zadano`)
  }
  for (const x of postavke.drugi as DrugiBot[]) {
    if (!smijeTajnuNa(x.url, postavke.adrese as string[])) {
      upozorenja.push(`${x.ime}: host adrese ploče (${x.url}) nije u popisu adresa — tajna mu ne ide, prijenos ne radi`)
    }
  }
  return { postavke: postavke as unknown as BotKanalPostavke, upozorenja }
}

export function setBotKanalPostavke(db: Database, zakrpa: unknown, by: string, source = 'api'): { kljuc: string; changed: boolean }[] {
  ensureSettingsSchema(db)
  const p = parseBotKanalPatch(zakrpa)
  if (!p.ok) throw new Error(p.greske.join('; '))
  const who = (by || 'unknown').slice(0, 64)
  const out: { kljuc: string; changed: boolean }[] = []
  db.transaction(() => {
    for (const [polje, v] of Object.entries(p.value) as [Polje, unknown][]) {
      const kljuc = BOT_KANAL_KLJUCEVI[polje]
      out.push({ kljuc, changed: upisi(db, kljuc, NIZOVI.includes(polje) ? JSON.stringify(v) : String(v), who, source) })
    }
  })()
  return out
}

function upisi(db: Database, kljuc: string, novo: string, who: string, source: string): boolean {
  const red = db.query(`SELECT value FROM settings WHERE key = ?`).get(kljuc) as { value: string } | null
  const staro = red ? red.value : null
  if (staro === novo) return false
  db.query(
    `INSERT INTO settings(key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(kljuc, novo, who)
  db.query(`INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, ?, ?, ?, ?)`)
    .run(kljuc, staro, novo, who, source)
  return true
}

export function citajZastavice(db: Database): Record<string, ZastavicaChata> {
  try {
    const r = db.query(`SELECT value FROM settings WHERE key = ?`).get(BOT_KANAL_STANJE_KLJUC) as { value: string } | null
    const z = r ? JSON.parse(r.value) : {}
    return z && typeof z === 'object' && !Array.isArray(z) ? z : {}
  } catch { return {} }
}

/**
 * Spremište za dugotrajni proces ploče: zastavice u `settings` (+ povijest), brojilo i vlastite
 * poruke u memoriji. Svaka operacija otvara i zatvara bazu (kao `RazgovorPloca`).
 */
export function spremisteUBazi(dbPath: string): Spremiste {
  let memorija: BotKanalStanje = praznoStanje()
  const sDb = <T>(fn: (db: Database) => T): T => {
    const db = new Database(dbPath)
    try { return fn(db) } finally { try { db.close() } catch { /* ništa */ } }
  }
  return {
    citaj() {
      let zastavice: Record<string, ZastavicaChata> = {}
      try { zastavice = sDb(citajZastavice) } catch { zastavice = memorija.zastavice }
      return { zastavice, brojilo: memorija.brojilo, poslano: memorija.poslano }
    },
    pisi(s, pz) {
      memorija = { zastavice: s.zastavice, brojilo: s.brojilo, poslano: s.poslano }
      if (!pz) return
      sDb(db => {
        ensureSettingsSchema(db)
        db.transaction(() => {
          const sve = citajZastavice(db)
          sve[pz.chatId] = pz.z
          upisi(db, BOT_KANAL_STANJE_KLJUC, JSON.stringify(sve), pz.z.by.slice(0, 64) || 'bot-kanal', `bot-kanal:${pz.z.razlog}`)
        })()
      })
    },
  }
}

export function botKanalPovijest(db: Database, limit = 20): { kljuc: string; novo: string; changedBy: string; source: string; changedAt: string }[] {
  const kljucevi = [...Object.values(BOT_KANAL_KLJUCEVI), BOT_KANAL_STANJE_KLJUC]
  try {
    return (db.query(
      `SELECT key, new_value, changed_by, source, changed_at FROM settings_history
       WHERE key IN (${kljucevi.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`,
    ).all(...kljucevi, limit) as any[]).map(r => ({ kljuc: r.key, novo: r.new_value, changedBy: r.changed_by, source: r.source, changedAt: r.changed_at }))
  } catch { return [] }
}

/** Čitač za dugotrajni proces: baza najviše jednom u 5 s; nečitljiva baza → zadnje dobro → zadano (isključeno). */
export function createBotKanalReader(dbPath: string, ttlMs = 5000, now: () => number = Date.now): () => BotKanalPostavke {
  let kes: BotKanalPostavke | null = null
  let procitano = -Infinity
  return () => {
    const t = now()
    if (kes && t - procitano < ttlMs) return kes
    procitano = t
    let db: Database | null = null
    try {
      db = new Database(dbPath, { readonly: true })
      kes = getBotKanalPostavke(db).postavke
    } catch {
      if (!kes) kes = { ...BOT_KANAL_ZADANO, drugi: [], chatovi: [], adrese: [], stopKorisnici: [] }
    } finally {
      try { db?.close() } catch { /* ništa */ }
    }
    return kes
  }
}
