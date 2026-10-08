// ─── SEND_DOC iz rezultata zadatka (TASK-5363) ───────────────────────────────
// Nalog iz Telegram grupe → zadatak → agent → rezultat: tekst je stizao (user-flush daemona),
// a `[[SEND_DOC: …]]` iz `resultSummary` nije nitko čitao — oznaku je obrađivao samo put
// razgovora (Razgovor.ts). Ovdje se ista oznaka iz rezultata zadatka šalje u chat naloga
// (oznaka `chat:<id>`), ISTIM kanalom kao razgovor: iste provjere (`provjeriDokument` —
// dopuštene mape, lista zabrane, strop veličine), isto slanje (`posaljiDokumentIshod`, koji uz
// uključene privitke kopira datoteku i piše redak u `privitci/<chat>/evidencija.jsonl`) i isti
// razlog neuspjeha u chat umjesto tišine (TASK-5337).
//
// Autorica: Jelena (Engineer), TASK-5363.

import type { Kanal } from './Kanal'
import { izvuciDokumente, provjeriDokument } from './SendDoc'

export type KanalDokumenata = Pick<Kanal, 'maxDokumentBajta' | 'posaljiTekst'> &
  Required<Pick<Kanal, 'posaljiDokumentIshod'>>

/** Chat naloga iz oznake zadatka `chat:<id>` (ingest iz Telegrama, ulazna vrata daemona). */
export function chatZadatka(t: { tags?: unknown }): string | null {
  const oznake = Array.isArray(t.tags) ? t.tags : []
  for (const o of oznake) {
    const m = /^chat:(-?\d{1,20})$/.exec(String(o))
    if (m) return m[1]!
  }
  return null
}

export interface DokumentiZadatkaOpcije {
  /** Mape iz kojih rezultat zadatka smije slati, za dani chat i zadatak. */
  dopusteneMape: (chatId: string, taskId: string) => string[]
  /**
   * Oznaku `chat:<id>` može upisati svatko tko piše zadatke, pa se šalje samo u chat koji
   * ploča poznaje (kanal ili popis ulaza). Bez provjere = svaki chat.
   */
  chatDopusten?: (chatId: string) => boolean
  home?: string
  log?: (r: string) => void
}

export interface DokumentiZadatkaIshod {
  chatId: string
  poslano: string[]
  neposlano: { ime: string; razlog: string }[]
}

/** `null` = nema što slati (rezultat bez oznake ili zadatak bez chata). Ne baca. */
export async function posaljiDokumenteZadatka(
  t: { id: string; resultSummary?: unknown; tags?: unknown },
  k: KanalDokumenata,
  o: DokumentiZadatkaOpcije,
): Promise<DokumentiZadatkaIshod | null> {
  const { markeri } = izvuciDokumente(String(t.resultSummary || ''))
  if (!markeri.length) return null
  const chatId = chatZadatka(t)
  if (!chatId) return null
  if (o.chatDopusten && !o.chatDopusten(chatId)) {
    o.log?.(`[send-doc] ${t.id}: chat ${chatId} nije među chatovima ploče — dokumenti nisu poslani`)
    return null
  }

  const ishod: DokumentiZadatkaIshod = { chatId, poslano: [], neposlano: [] }
  const vidjeno = new Set<string>()
  const mape = o.dopusteneMape(chatId, t.id)
  for (const m of markeri) {
    const ime = m.putanja.split('/').pop() || 'dokument'
    const pr = provjeriDokument(m.putanja, { dopusteneMape: mape, maxBajta: k.maxDokumentBajta, home: o.home || '' })
    let r: { ok: boolean; razlog?: string }
    if (!pr.ok) r = pr
    else if (vidjeno.has(pr.putanja)) continue
    else {
      vidjeno.add(pr.putanja)
      try { r = await k.posaljiDokumentIshod(chatId, pr.putanja, m.opis) } catch (e: any) { r = { ok: false, razlog: String(e?.message || e) } }
    }
    if (r.ok) { ishod.poslano.push(ime); continue }
    const razlog = String(r.razlog || 'kanal je odbio slanje').slice(0, 300)
    ishod.neposlano.push({ ime, razlog })
    o.log?.(`[send-doc] ${t.id}: dokument ${ime} nije poslan — ${razlog}`)
    await k.posaljiTekst(chatId, `📎 ${t.id}: dokument ${ime} nije poslan: ${razlog}`).catch(() => false)
  }
  if (ishod.poslano.length) o.log?.(`[send-doc] ${t.id}: poslano ${ishod.poslano.length} → chat ${chatId} (${ishod.poslano.join(', ')})`)
  return ishod
}
