#!/usr/bin/env bun
/**
 * Telegram poller kao ZASEBAN PROCES (DIZAJN-telegram-poller §2, način B).
 *
 *   bun scripts/telegram-poller.ts                        # petlja
 *   bun scripts/telegram-poller.ts --api http://…:17781   # druga adresa ploče
 *   bun scripts/telegram-poller.ts --proba                # koliko poruka čeka i iz kojih chatova
 *   bun scripts/telegram-poller.ts --stanje               # offset, brojači, zadnja greška
 *
 * Zašto zaseban način postoji: poller je jedini dio paketa koji SAM ide na internet, pa ga
 * netko hoće odvojiti od ploče iza obrnutog posrednika. Oba načina zovu isti
 * `POST /api/ingest`, dakle isti kod — i oba drži ista datoteka-brava, pa se ne mogu
 * pokrenuti zajedno i početi si krasti poruke.
 */

import { pokreniTelegramPoller, probajUlaz, stanjeUlaza } from '../src/TelegramPoller'
import { loadTelegramConfig } from '../src/TelegramConfig'

const args = process.argv.slice(2)
const ima = (i: string) => args.includes(i)
const vrijednost = (i: string) => {
  const k = args.indexOf(i)
  return k >= 0 && args[k + 1] ? args[k + 1]! : null
}

if (ima('--stanje')) {
  console.log(JSON.stringify(stanjeUlaza(), null, 2))
  process.exit(0)
}

if (ima('--proba')) {
  const r = await probajUlaz()
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 1)
}

const cfg = loadTelegramConfig()
if (!cfg.ulaz.ukljucen) {
  console.log('ℹ️  ulazni kanal je isključen (telegram.json → ulaz.ukljucen).')
  console.log('   Uključi ga na ploči: Config → Telegram → Ulaz.')
  process.exit(0)
}

const pokretanje = pokreniTelegramPoller({ plocaBase: vrijednost('--api') || undefined })
if (!pokretanje.pokrenut) {
  console.error(`✗ poller nije pokrenut: ${pokretanje.razlog}`)
  process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { pokretanje.stop?.(); process.exit(0) })
}

// Petlja se vrti na `setTimeout` s `unref()`, pa proces bez ovoga završi odmah.
setInterval(() => { /* drži proces živim */ }, 1 << 30)
