/**
 * SendDoc — deterministicko slanje dokumenata iz Telegram agent pipelinea.
 *
 * PROBLEM (NALAZ 2026-07-18, TASK-2628): izlazni tok `telegram_agent.ts` slao je
 * ISKLJUCIVO tekst (`ctx.reply`). `bot.sendDocument()` postoji u lib/TelegramBot.ts
 * ali nije bio spojen ni na jedan tok. Dokument je stizao samo kad bi model SAM
 * odlucio pokrenuti shell-poziv prema Bot API-ju — dakle lutrija.
 *
 * RJESENJE: marker-konvencija koju agent ispise u odgovoru (jedna linija po dokumentu):
 *
 *     [[SEND_DOC: /apsolutna/putanja/dokument.pdf | opcijski opis]]
 *
 * Pipeline marker detektira, posalje datoteku preko `bot.sendDocument()` i UKLONI
 * marker iz vidljivog teksta. Isti obrazac kao postojeci `detectDelegation()`.
 *
 * Logika je ovdje (a ne inline u telegram_agent.ts) da bi bila testabilna bez
 * pokretanja daemona — telegram_agent.ts se pri importu spaja na Telegram.
 * Bez novih ovisnosti (samo `fs`).
 */

import { existsSync, statSync } from 'fs'

export interface SendDocMarker {
  path: string
  caption?: string
}

export interface SendDocParse {
  /** Dokumenti za slanje, redom pojavljivanja, bez duplikata. */
  docs: SendDocMarker[]
  /** Tekst bez markera — ovo ide korisniku. */
  text: string
}

/** Gornja granica dokumenata po poruci — brana protiv poplave privitaka. */
export const MAX_DOCS_PER_MESSAGE = 10

/** Telegram Bot API odbija dokument veci od 50 MB. */
export const MAX_DOC_BYTES = 50 * 1024 * 1024

/**
 * Putanje koje se NIKAD ne salju, bez obzira sto model napise.
 * Marker je izveden iz teksta koji dolazi od korisnika (grupa je otvorena),
 * pa je "posalji mi <tajna>" realan vektor. Vrata su ovdje, ne u promptu.
 */
const ZABRANJENO: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(secret|password|passwd|credential|token|apikey|api_key)/i,
  /(^|\/)tele(gram)?\.json$/i,
  /(^|\/)\.claude\/(settings|config)[^/]*\.json$/i,
  /(^|\/)shadow$/,
]

/**
 * Svjeza instanca globalnog regexa po pozivu — globalni regex nosi `lastIndex`,
 * pa bi dijeljena konstanta preskakala markere pri drugom pozivu.
 */
export function markerRegex(): RegExp {
  return /\[\[SEND_DOC:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/g
}

/**
 * Marker koji sam zauzima cijeli redak — brise se s retkom, inace ostaje
 * prazan red usred odgovora (mjereno: "Salji ovo:\n\nHvala.").
 */
function markerLineRegex(): RegExp {
  return /^[ \t]*\[\[SEND_DOC:\s*[^|\]]+?\s*(?:\|\s*[^\]]*?)?\s*\]\][ \t]*\n?/gm
}

export function isForbiddenDocPath(put: string): boolean {
  return ZABRANJENO.some(re => re.test(put))
}

/**
 * Izvuce markere iz odgovora i vrati tekst bez njih.
 * Odbacuje relativne putanje (marker svejedno nestaje iz teksta — korisnik
 * ne smije vidjeti internu konvenciju ni kad je krivo napisana).
 */
export function parseSendDocMarkers(input: string): SendDocParse {
  if (!input || typeof input !== 'string') return { docs: [], text: '' }

  const docs: SendDocMarker[] = []
  const vidjeno = new Set<string>()

  for (const m of input.matchAll(markerRegex())) {
    const put = (m[1] || '').trim()
    const opis = (m[2] || '').trim()
    if (!put.startsWith('/')) continue           // samo apsolutne putanje
    if (vidjeno.has(put)) continue               // isti dokument ne salji dvaput
    if (docs.length >= MAX_DOCS_PER_MESSAGE) break
    vidjeno.add(put)
    docs.push({ path: put, caption: opis || undefined })
  }

  const text = input
    .replace(markerLineRegex(), '')                      // marker sam u retku -> ide i redak
    .replace(markerRegex(), '')                          // marker usred recenice
    .replace(/```[a-zA-Z0-9]*\s*```[ \t]*\n?/g, '')      // ostatak prazne ograde koda
    .split('\n')
    .map(r => r.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim()

  return { docs, text }
}

export interface DeliverDeps {
  /** Stvarno slanje — u pogonu `bot.sendDocument`, u testu spijun. */
  send: (path: string, caption?: string) => Promise<unknown>
  log?: (poruka: string) => void
  exists?: (path: string) => boolean
  size?: (path: string) => number
}

export interface DeliverResult {
  sent: string[]
  skipped: { path: string; razlog: string }[]
}

/**
 * Posalje dokumente redom. Nijedan pojedinacni kvar (nema datoteke, prevelika,
 * Telegram vratio gresku) ne smije srusiti dostavu teksta ni ostalih dokumenata.
 */
export async function deliverDocuments(
  docs: SendDocMarker[],
  deps: DeliverDeps
): Promise<DeliverResult> {
  const rezultat: DeliverResult = { sent: [], skipped: [] }
  if (!docs || docs.length === 0) return rezultat

  const postoji = deps.exists ?? existsSync
  const velicina = deps.size ?? ((p: string) => statSync(p).size)
  const log = deps.log ?? (() => {})

  for (const d of docs) {
    const preskoci = (razlog: string) => {
      rezultat.skipped.push({ path: d.path, razlog })
      log(`[SEND_DOC] Preskacem ${d.path}: ${razlog}`)
    }

    try {
      if (isForbiddenDocPath(d.path)) { preskoci('zabranjena putanja'); continue }
      if (!postoji(d.path)) { preskoci('ne postoji'); continue }
      if (velicina(d.path) > MAX_DOC_BYTES) { preskoci('prevelik'); continue }

      await deps.send(d.path, d.caption)
      rezultat.sent.push(d.path)
      log(`[SEND_DOC] Poslan dokument: ${d.path}`)
    } catch (err: any) {
      preskoci(err?.message || String(err))
    }
  }

  return rezultat
}
