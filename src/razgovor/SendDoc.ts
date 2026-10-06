// ─── SEND_DOC (ADR-0002 §9) ──────────────────────────────────────────────────
// Marker `[[SEND_DOC: /aps/putanja | opis]]` u odgovoru modela. Bez provjere je marker kanal
// za iznošenje BILO KOJE datoteke koju model može imenovati — zato se šalje samo ako je
// `realpath` (symlink razriješen) unutar dopuštenih mapa, nije na listi zabrane i nije
// veći od ograničenja kanala.
//
// Autorica: Jelena (Engineer), TASK-5277.

import { realpathSync, statSync } from 'fs'
import { basename, isAbsolute, sep } from 'path'

export interface Marker { putanja: string; opis: string }

const MARKER = /\[\[SEND_DOC:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/g

export function izvuciDokumente(tekst: string): { tekst: string; markeri: Marker[] } {
  const markeri: Marker[] = []
  const ocisceno = tekst.replace(MARKER, (_, p: string, o?: string) => {
    markeri.push({ putanja: p.trim(), opis: (o || '').trim() })
    return ''
  })
  return { tekst: ocisceno.replace(/[ \t]+\n/g, '\n').trim(), markeri }
}

export interface ProvjeraOpcije {
  dopusteneMape: string[]
  maxBajta: number
  home: string
}

const ZABRANJENA_IMENA = new Set(['credentials.env', 'telegram.json', 'signal.json', '.credentials.json'])

export function provjeriDokument(putanja: string, o: ProvjeraOpcije): { ok: true; putanja: string } | { ok: false; razlog: string } {
  if (!isAbsolute(putanja)) return { ok: false, razlog: 'putanja nije apsolutna' }
  let stvarna: string
  try { stvarna = realpathSync(putanja) } catch { return { ok: false, razlog: 'datoteka ne postoji' } }
  const mape = o.dopusteneMape.flatMap(m => { try { return [realpathSync(m)] } catch { return [] } })
  if (!mape.some(m => stvarna === m || stvarna.startsWith(m.endsWith(sep) ? m : m + sep))) {
    return { ok: false, razlog: 'izvan dopuštene mape' }
  }
  const ime = basename(stvarna)
  if (ZABRANJENA_IMENA.has(ime) || ime.endsWith('.env') || stvarna.split(sep).includes('.ssh')) {
    return { ok: false, razlog: 'datoteka je na listi zabrane' }
  }
  let st
  try { st = statSync(stvarna) } catch { return { ok: false, razlog: 'datoteka nije čitljiva' } }
  if (!st.isFile()) return { ok: false, razlog: 'nije datoteka' }
  if (st.size > o.maxBajta) return { ok: false, razlog: `prevelika datoteka (${st.size} B > ${o.maxBajta} B)` }
  return { ok: true, putanja: stvarna }
}
