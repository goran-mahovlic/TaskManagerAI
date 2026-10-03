/**
 * PlocaPromet — koliko ploča vuče preko mreže (TASK-5184).
 *
 * Kvar (vlasnik, 03.10.2026., mobitel preko Tailscalea): ploča stoji na „Connecting…", TOTAL je „-".
 * Izmjereno: GET /api/tasks = 9,4 MB (2676 zadataka sa SVIM poljima — resultSummary 3,8 MB,
 * description 3,4 MB, progressNotes 1,4 MB), bez kompresije, a ploča ga je zvala pri učitavanju
 * tri puta, svakih 30 s i na SVAKI WS događaj. Na Slow 3G (Playwright, 150 s) nijedan odgovor
 * nije stigao do kraja; na Fast 3G prvi prikaz tek nakon 106 s uz 28 MB.
 *
 * Kartica ne crta opis, rezultat ni bilješke — detalj ih dohvaća sam (/api/tasks/:id). Zato:
 *   • `view=board`  → samo polja kartice (POLJA_PLOCE), svi otvoreni + zadnjih N zatvorenih,
 *                     brojači nad SVIM zadacima (TOTAL/COMPLETED ostaju točni), straničenje;
 *   • `since=`      → samo zadaci promijenjeni od zadnjeg odgovora (inkrementalno osvježavanje);
 *   • kompresija    → br/gzip za JSON/HTML kad ih klijent nudi (curl/urllib bez Accept-Encoding
 *                     dobivaju isti odgovor kao prije).
 * Bez `view=board` /api/tasks vraća isti puni niz kao prije — skripte i agenti se ne mijenjaju.
 */
import { brotliCompressSync, constants as zlibConst } from 'zlib'

/** Polja koja kartica, brojači, filtar agenata, lanac i izbornik „blokira" čitaju. */
export const POLJA_PLOCE = [
  'id', 'title', 'status', 'priority', 'assignee', 'projectId', 'paused', 'tags',
  'blockedBy', 'blocks', 'progressPercent', 'estimatedMinutes', 'actualMinutes',
  'startedAt', 'createdAt', 'updatedAt', 'completedAt',
] as const

/** Zadano zatvorenih (completed/cancelled) na ploči — stupac „Completed" ne treba 2264 kartice. */
export const ZADANO_ZATVORENIH = 150
const NAJVISE_ZATVORENIH = 2000
/** Baza dio vremena piše do sekunde ('… 11:07:02'), pa since mora preklapati par sekundi. */
const PREKLOP_MS = 5000

export function zaPlocu(t: any): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of POLJA_PLOCE) if (t?.[k] !== undefined) o[k] = t[k]
  return o
}

/** '2026-10-03 11:07:02' i '2026-10-03T11:07:02.561Z' → UTC ms; neispravno → 0. */
export function vrijemeMs(s: unknown): number {
  if (s == null || s === '') return 0
  let v = String(s).trim()
  if (/^\d{4}-\d{2}-\d{2} \d/.test(v)) v = v.replace(' ', 'T')
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v += 'Z'   // SQLite datetime('now') je UTC bez oznake
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : 0
}

export function zatvoren(status: unknown): boolean {
  return status === 'completed' || status === 'cancelled'
}

/** Zadnja aktivnost: najkasnije od promjene, dovršenja i nastanka. */
export function aktivnostMs(t: any): number {
  return Math.max(vrijemeMs(t?.updatedAt), vrijemeMs(t?.completedAt), vrijemeMs(t?.createdAt))
}

export interface OpcijePloce {
  zatvorenih?: number
  since?: string
  offset?: number
  limit?: number
  /** samo za testove — trenutak upita */
  sada?: number
}

export interface IzborPloce {
  tasks: Record<string, any>[]
  counts: Record<string, number>
  ukupno: number
  serverTime: string
  inkrementalno: boolean
  offset: number
  imaJos: boolean
}

export function izborZaPlocu(svi: any[], op: OpcijePloce = {}): IzborPloce {
  const sada = op.sada ?? Date.now()
  const counts: Record<string, number> = {}
  for (const t of svi) counts[t.status] = (counts[t.status] || 0) + 1

  const poAktivnosti = svi
    .map(t => ({ t, ms: aktivnostMs(t) }))
    .sort((a, b) => b.ms - a.ms)

  const N = op.zatvorenih ?? ZADANO_ZATVORENIH
  let zatvorenihUzeto = 0
  let odabrani = poAktivnosti.filter(({ t }) => {
    if (!zatvoren(t.status)) return true
    return zatvorenihUzeto++ < N
  })

  const inkrementalno = !!op.since
  if (inkrementalno) {
    const prag = vrijemeMs(op.since) - PREKLOP_MS
    odabrani = odabrani.filter(x => x.ms >= prag)
  }

  const offset = Math.max(0, op.offset ?? 0)
  const kraj = op.limit ? offset + op.limit : odabrani.length
  const stranica = odabrani.slice(offset, kraj)

  return {
    tasks: stranica.map(x => zaPlocu(x.t)),
    counts,
    ukupno: svi.length,
    serverTime: new Date(sada).toISOString(),
    inkrementalno,
    offset,
    imaJos: kraj < odabrani.length,
  }
}

function cijeli(v: string | null): number | undefined {
  if (v == null || v === '') return undefined
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? n : undefined
}

/** null = klijent nije tražio prikaz ploče (stari, puni odgovor). */
export function parsirajOpcijePloce(url: URL): OpcijePloce | null {
  if (url.searchParams.get('view') !== 'board') return null
  const z = cijeli(url.searchParams.get('zatvorenih'))
  const lim = cijeli(url.searchParams.get('limit'))
  const off = cijeli(url.searchParams.get('offset'))
  const since = url.searchParams.get('since') || undefined
  return {
    zatvorenih: z == null ? ZADANO_ZATVORENIH : Math.min(Math.max(z, 0), NAJVISE_ZATVORENIH),
    limit: lim != null && lim > 0 ? lim : undefined,
    offset: off != null && off > 0 ? off : undefined,
    since: since && vrijemeMs(since) > 0 ? since : undefined,
  }
}

/** Dashboard crta samo ime i postotak projekta — specifikacija (186 KB) i opis ne idu u odgovor. */
export function saziProjekteDashboarda(projekti: any[]): any[] {
  return (projekti || []).map(p => {
    const { specification, description, ...ostalo } = p || {}
    return ostalo
  })
}

const KOMPRIMIRAJ_TIP = /^(application\/(json|javascript)|text\/(html|css|plain|javascript))/i
const PRAG_BAJTOVA = 1024

/**
 * br (ako ga klijent nudi — preglednici samo na HTTPS-u) ili gzip (preglednici na HTTP-u).
 * Ne dira: WS upgrade (undefined), SSE, već kodirane, male i ne-tekstualne odgovore.
 */
export async function komprimirajOdgovor(req: Request, res: Response | undefined): Promise<Response | undefined> {
  if (!res) return res
  if (res.status === 101 || res.status === 204 || res.status === 304) return res
  if (req.method === 'HEAD') return res
  if (res.headers.get('Content-Encoding')) return res
  const tip = res.headers.get('Content-Type') || ''
  if (!KOMPRIMIRAJ_TIP.test(tip)) return res
  const ae = (req.headers.get('Accept-Encoding') || '').toLowerCase()
  const br = /\bbr\b/.test(ae)
  const gz = /\bgzip\b/.test(ae)
  if (!br && !gz) return res

  const tijelo = new Uint8Array(await res.arrayBuffer())
  const zaglavlja = new Headers(res.headers)
  const vary = zaglavlja.get('Vary')
  if (!vary || !/accept-encoding/i.test(vary)) zaglavlja.set('Vary', vary ? vary + ', Accept-Encoding' : 'Accept-Encoding')
  if (tijelo.length < PRAG_BAJTOVA) {
    return new Response(tijelo, { status: res.status, statusText: res.statusText, headers: zaglavlja })
  }
  const sazeto = br
    ? brotliCompressSync(tijelo, { params: { [zlibConst.BROTLI_PARAM_QUALITY]: 5, [zlibConst.BROTLI_PARAM_SIZE_HINT]: tijelo.length } })
    : Bun.gzipSync(tijelo, { level: 6 })
  zaglavlja.set('Content-Encoding', br ? 'br' : 'gzip')
  zaglavlja.delete('Content-Length')
  return new Response(sazeto, { status: res.status, statusText: res.statusText, headers: zaglavlja })
}
