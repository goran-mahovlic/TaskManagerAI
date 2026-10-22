/**
 * ChatDojava — nalog iz razgovora uvijek dobiva pojedinačnu dojavu sa SEND_DOC (TASK-5548).
 *
 * ZATEČENO (daemon.log 16.10.2026.): treći „neprovjereni” zadatak dana prelazio je prag
 * pojedinačnih dojava, pa su i Goranovi nalozi s oznakom `chat:<id>` odlazili u dnevni
 * sažetak (samo popis). Dojava ✅ je išla, ali kroz daemonov user-flush, koji je
 * `[[SEND_DOC: …]]` slao kao goli tekst — dokument nije stigao nikad (TASK-5543 PDF i
 * .kicad_pcb). `renderMinimal` je markere k tome znao i izbaciti (TASK-5544 audio).
 *
 * PRAVILO: zadatak s `chat:` (izravan nalog iz razgovora) ne ulazi u prag ni u dnevni
 * sažetak; „neprovjereno” je samo oznaka u njegovoj dojavi, a markeri iz agentova
 * odgovora uvijek su u dojavi. Prag i sažetak ostaju za zadatke bez `chat:` (autonomija,
 * petlje). Prekidač: features.json `chatDojavaUvijek`. Čisto, bez I/O-a.
 */
import { chatIzOznaka } from './ZadatakKanal'
import { parseSendDocMarkers, type SendDocMarker } from '../tools/Telegram/lib/SendDoc'

export const NEPROVJERENO_OZNAKA = '🔎 neprovjereno — vratar nije mogao provjeriti rad'

/** Zadatak je nastao iz razgovora (oznaka `chat:<id>`). */
export function jeNalogIzRazgovora(tags: unknown): boolean {
  return chatIzOznaka(tags) !== null
}

/** „Neprovjereno” ide kao oznaka u pojedinačnu dojavu (a ne u prag i dnevni sažetak)? */
export function neprovjerenoIdeUDojavu(tags: unknown, prekidac: boolean): boolean {
  return prekidac && jeNalogIzRazgovora(tags)
}

function marker(d: SendDocMarker): string {
  return d.caption ? `[[SEND_DOC: ${d.path} | ${d.caption}]]` : `[[SEND_DOC: ${d.path}]]`
}

/**
 * Dojava ✅ + oznaka „neprovjereno” + svi SEND_DOC markeri iz agentova odgovora.
 * Markeri koje dojava već nosi se ne udvostručuju; bez ičega za dodati vraća se netaknuta.
 */
export function dopuniDojavu(
  dojava: string,
  odgovorAgenta: string,
  o: { neprovjereno: string | null },
): string {
  const uDojavi = parseSendDocMarkers(dojava)
  const izOdgovora = parseSendDocMarkers(odgovorAgenta || '')
  const putanje = new Set(uDojavi.docs.map(d => d.path))
  const nedostaju = izOdgovora.docs.filter(d => !putanje.has(d.path))
  if (nedostaju.length === 0 && !o.neprovjereno) return dojava

  const docs = [...uDojavi.docs, ...nedostaju]
  const dijelovi = [uDojavi.docs.length > 0 ? uDojavi.text : dojava.trimEnd()]
  if (o.neprovjereno) dijelovi.push(`${NEPROVJERENO_OZNAKA} (${o.neprovjereno})`)
  if (docs.length > 0) dijelovi.push(docs.map(marker).join('\n'))
  return dijelovi.join('\n\n')
}

/**
 * User-flush: dokumenti se šalju kao dokumenti, tekst ide bez markera. Izdvaja se PRIJE
 * rezanja na strop poruke — marker na kraju dugačke dojave inače bi bio odrezan.
 */
export function razdvojiZaFlush(content: string): { text: string; docs: SendDocMarker[] } {
  const r = parseSendDocMarkers(content)
  if (r.docs.length === 0) return { text: content, docs: [] }
  return r
}
