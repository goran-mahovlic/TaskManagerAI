// ─── Zadnji pošiljatelji u dopuštenim chatovima (TASK-5283) ──────────────────
// Ploča inače ne zna ID pošiljatelja (ingest bilježi samo ime), pa vlasnik nema odakle
// prepisati broj za `dopusteniKorisnici`. Poller ovdje bilježi ime, @korisničko ime i ID
// svakoga tko piše u dopuštenom chatu; kartica „Razgovor" to prikazuje uz gumb „dodaj".
//
// `<korijen>/posiljatelji.json`, jedan redak po ID-u, najnoviji prvi, najviše 30. Upis je
// atoman (tmp + rename) i nikad ne ruši poller.
//
// Autorica: Jelena (Engineer), TASK-5283.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { UlaznaPoruka } from './Kanal'

export interface Posiljatelj {
  id: string
  ime: string
  korisnickoIme?: string
  jeBot: boolean
  chatId: string
  zadnjiTs: string
}

const MAX = 30
/** Isti pošiljatelj s istim podatcima ne upisuje se češće od ovoga. */
const PRIGUSENJE_MS = 5 * 60_000

export function procitajPosiljatelje(put: string): Posiljatelj[] {
  try {
    const v = JSON.parse(readFileSync(put, 'utf-8'))
    return Array.isArray(v) ? v.filter(x => x && typeof x.id === 'string') : []
  } catch { return [] }
}

export function zabiljeziPosiljatelja(put: string, p: UlaznaPoruka, sada = Date.now()): void {
  if (!p.posiljateljId) return
  try {
    const popis = procitajPosiljatelje(put)
    const stari = popis.find(x => x.id === p.posiljateljId)
    const novi: Posiljatelj = {
      id: p.posiljateljId,
      ime: p.posiljateljIme.slice(0, 80),
      ...(p.posiljateljKorisnickoIme ? { korisnickoIme: p.posiljateljKorisnickoIme.slice(0, 64) } : {}),
      jeBot: p.posiljateljJeBot,
      chatId: p.chatId,
      zadnjiTs: new Date(sada).toISOString(),
    }
    if (stari && stari.ime === novi.ime && stari.korisnickoIme === novi.korisnickoIme &&
      stari.chatId === novi.chatId && popis[0]?.id === novi.id &&
      sada - Date.parse(stari.zadnjiTs) < PRIGUSENJE_MS) return
    const ostali = popis.filter(x => x.id !== novi.id)
    mkdirSync(dirname(put), { recursive: true })
    const tmp = `${put}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify([novi, ...ostali].slice(0, MAX), null, 2) + '\n', 'utf-8')
    renameSync(tmp, put)
  } catch { /* popis je pomoć vlasniku, ne razlog za kvar pollera */ }
}
