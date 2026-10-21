#!/usr/bin/env bun
/**
 * Pošalji datoteku u Telegram chat tokenom bota OVE instalacije (TASK-5337).
 *
 *   bun scripts/posalji-dokument.ts --chat -1001234567890 --datoteka /aps/put/x.xlsx [--opis "…"]
 *   bun scripts/posalji-dokument.ts --chat … --datoteka … --suho     # samo provjere, bez slanja
 *
 * Token i dopušteni chatovi čitaju se iz konfiguracije čvora (`telegram.json` po obrascu
 * `TM_TELEGRAM_CONFIG` → `$TM_HOME/config/`, tajna iz `botTokenEnv` / datoteke vjerodajnica),
 * nikad iz `~/.claude/telegram.json` glavnog sustava — na čvoru te datoteke nema i ne smije biti.
 *
 * Šalje se samo u chat koji je u postavkama (`chatId` ili `ulaz.dopusteniChatovi`). Izlaz 0 znači
 * da je Bot API vratio `ok` (ispisuje se id poruke); inače izlaz 1 s razlogom bez tokena.
 */

import { existsSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import { loadTelegramConfig, telegramBotToken } from '../src/TelegramConfig'
import { telegramKanal } from '../src/TelegramPoller'
import { ZADANI_PRIVITCI } from '../src/TelegramPrivitci'

const args = process.argv.slice(2)
const vrijednost = (i: string) => {
  const k = args.indexOf(i)
  return k >= 0 && args[k + 1] ? args[k + 1]! : null
}
const greska = (t: string): never => { console.error(`✗ ${t}`); process.exit(1) }

const chat = vrijednost('--chat') || ''
const datoteka = vrijednost('--datoteka') || ''
const opis = vrijednost('--opis') || ''
if (!chat || !datoteka) greska('uporaba: --chat <id> --datoteka </apsolutna/putanja> [--opis "…"] [--suho]')
if (!isAbsolute(datoteka)) greska('putanja datoteke nije apsolutna')
if (!existsSync(datoteka) || !statSync(datoteka).isFile()) greska(`datoteka ne postoji: ${datoteka}`)
if (statSync(datoteka).size > 50 * 1024 * 1024) greska('datoteka je veća od 50 MB (granica Bot API-ja)')

const cfg = loadTelegramConfig()
const dopusteni = new Set([cfg.chatId, ...(cfg.ulaz?.dopusteniChatovi || [])].map(x => String(x || '').trim()).filter(Boolean))
if (!dopusteni.has(chat)) greska(`chat ${chat} nije u postavkama ove instalacije (chatId / ulaz.dopusteniChatovi)`)
const token = telegramBotToken(cfg)
if (!token) greska('nema bot tokena u konfiguraciji ovog čvora (telegram.botTokenEnv / vjerodajnice)')

if (args.includes('--suho')) {
  console.log(`✓ suho: token čvora postoji, chat ${chat} dopušten, datoteka ${statSync(datoteka).size} B`)
  process.exit(0)
}

const kanal = telegramKanal(token, () => ({ ...ZADANI_PRIVITCI, ...(cfg.privitci || {}) }))
const r = await kanal.posaljiDokumentIshod!(chat, datoteka, opis)
if (!r.ok) greska(r.razlog || 'slanje nije uspjelo')
console.log(`✓ poslano u ${chat}${r.poruka ? ` (poruka ${r.poruka})` : ''}: ${datoteka}`)
