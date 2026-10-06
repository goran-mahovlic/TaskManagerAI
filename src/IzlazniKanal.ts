// ─── Izlazni kanal paketa za orkestrator na istom stroju (TASK-5285) ─────────
// Daemon orkestratora na čvoru isporučivao je poruke korisniku u konzolu („Telegram kanal
// nije konfiguriran"), jer je token tražio u vlastitoj datoteci, a vlasnik ga je upisao u
// ploču (Config → Telegram, spremište tajni paketa). Ovaj modul daemon uvozi iz paketa i
// dobiva ISTI kanal kao obavijesti ploče — bez kopiranja tajne u drugu datoteku i bez ispisa.
//
// Putanje (ne tajne) se čitaju iz `config/postavke.env` paketa ako ih okolina pozivatelja
// nema — daemon ne dijeli `EnvironmentFile` s pločom.
//
// Autorica: Jelena (Engineer), TASK-5285.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { izlazniKanal } from './TelegramConfig'
import { primijeniStil, type KratkoOpcije, type Stil } from './Stil'

const PAKET_DIR = join(import.meta.dir, '..')
/** Samo putanje — vrijednosti tajni iz `postavke.env` se ovdje nikad ne prenose. */
const PUTANJE = ['TM_HOME', 'TM_CREDENTIALS', 'TM_TELEGRAM_CONFIG'] as const

export function putanjeIzPostavki(put: string = join(PAKET_DIR, 'config', 'postavke.env')): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (!existsSync(put)) return out
    for (const r of readFileSync(put, 'utf-8').split('\n')) {
      const t = r.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i <= 0) continue
      const k = t.slice(0, i).trim()
      if ((PUTANJE as readonly string[]).includes(k)) out[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* bez postavki = zadane putanje paketa */ }
  return out
}

export interface KanalZaDaemon {
  token: string
  chatId: string
  stil: Stil
  obavijestZavrseno: boolean
  /** Tekst u obliku `telegram.stil` (kratko: ishod + do 5 točaka). */
  oblikuj: (tekst: string, o?: KratkoOpcije) => string
}

/** `null` kad kanal na ploči nije spreman (isključen, bez tokena ili chata). */
export function kanalZaDaemon(o: { postavkePut?: string } = {}): KanalZaDaemon | null {
  for (const [k, v] of Object.entries(putanjeIzPostavki(o.postavkePut))) {
    if (!process.env[k]) process.env[k] = v
  }
  const k = izlazniKanal()
  if (!k) return null
  return { ...k, oblikuj: (t, op) => primijeniStil(t, k.stil, { maxTocaka: 5, ...op }) }
}
