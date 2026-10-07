/**
 * Posrednik memorije (ADR-0006 §8, opcija B): pred Hindsightom koji nema zaštitu po banci stoji
 * mali HTTP posrednik koji čvoru propušta SAMO njegovu banku.
 *
 *   - `GET /health`                         → prosljeđuje (Memorija.ts provjerava živost)
 *   - `GET /v1/default/banks`               → popis, ali filtriran na dopuštene banke
 *   - `… /v1/default/banks/<dopuštena>/…`   → prosljeđuje (recall, reflect, memories, documents…)
 *   - `DELETE /v1/default/banks/<bilo koja>` → 403 (čvor ne briše banku, ni svoju)
 *   - sve ostalo                            → 403, bez ijednog poziva prema Hindsightu
 *
 * Retain (`POST …/memories`) troši LLM onoga tko drži Hindsight, pa prije njega idu VRATA
 * KVOTE (zatvorena → 429 s razlogom) i BRAVA (da uskladitelj ne restarta Hindsight usred
 * retaina). Obje su ubrizgane — paket ne zna čiji je Hindsight.
 */

export type Odluka =
  | { vrsta: 'propusti' }
  | { vrsta: 'popis' }
  | { vrsta: 'retain'; banka: string }
  | { vrsta: 'zabrani'; razlog: string }

const BANKE = '/v1/default/banks'

export function odluci(metoda: string, put: string, banke: readonly string[]): Odluka {
  if (put === '/health' && metoda === 'GET') return { vrsta: 'propusti' }
  if ((put === BANKE || put === BANKE + '/') && metoda === 'GET') return { vrsta: 'popis' }
  if (!put.startsWith(BANKE + '/')) return { vrsta: 'zabrani', razlog: 'put nije dopušten' }
  const ostatak = put.slice(BANKE.length + 1)
  const [sirovo, ...dalje] = ostatak.split('/')
  let banka: string
  try { banka = decodeURIComponent(sirovo) } catch { return { vrsta: 'zabrani', razlog: 'neispravno ime banke' } }
  if (!/^[\w.-]+$/.test(banka) || banka.includes('..')) return { vrsta: 'zabrani', razlog: 'neispravno ime banke' }
  if (!banke.includes(banka)) return { vrsta: 'zabrani', razlog: `banka ${banka} nije banka ovog čvora` }
  const rep = dalje.filter(Boolean)
  if (!rep.length && metoda === 'DELETE') return { vrsta: 'zabrani', razlog: 'brisanje banke nije dopušteno' }
  if (rep.length === 1 && rep[0] === 'memories' && metoda === 'POST') return { vrsta: 'retain', banka }
  return { vrsta: 'propusti' }
}

export interface Vrata { smije: boolean; razlog?: string }

export interface PosrednikOpcije {
  /** Hindsight, npr. `http://127.0.0.1:17792`. */
  cilj: string
  /** Banke koje ovaj posrednik propušta (banka čvora; za prijelaz i nova). */
  banke: readonly string[]
  fetchImpl?: typeof fetch
  vrata?: () => Promise<Vrata>
  brava?: { uzmi: () => void; pusti: () => void }
  /** Rok poziva prema Hindsightu (retain zna trajati minutama). */
  rokMs?: number
  zapis?: (red: Record<string, unknown>) => void
}

const odbij = (status: number, tijelo: Record<string, unknown>) => Response.json(tijelo, { status })

export function createPosrednik(o: PosrednikOpcije): (req: Request) => Promise<Response> {
  const f = o.fetchImpl ?? fetch
  const cilj = o.cilj.replace(/\/+$/, '')
  const rok = o.rokMs ?? 30 * 60_000

  const proslijedi = async (req: Request, url: URL): Promise<Response> => {
    const tijelo = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer()
    const zaglavlja = new Headers()
    const ct = req.headers.get('content-type')
    if (ct) zaglavlja.set('content-type', ct)
    const odg = await f(`${cilj}${url.pathname}${url.search}`, { method: req.method, headers: zaglavlja, body: tijelo, signal: AbortSignal.timeout(rok) })
    return new Response(odg.body, { status: odg.status, headers: { 'content-type': odg.headers.get('content-type') || 'application/json' } })
  }

  return async (req: Request) => {
    const url = new URL(req.url)
    const od = odluci(req.method, url.pathname, o.banke)
    o.zapis?.({ metoda: req.method, put: url.pathname, odluka: od.vrsta, ...(od.vrsta === 'zabrani' ? { razlog: od.razlog } : {}) })
    try {
      if (od.vrsta === 'zabrani') return odbij(403, { error: 'zabranjeno', razlog: od.razlog })
      if (od.vrsta === 'popis') {
        const odg = await f(`${cilj}${BANKE}`, { signal: AbortSignal.timeout(rok) })
        const j: any = await odg.json()
        const banks = Array.isArray(j?.banks) ? j.banks.filter((b: any) => o.banke.includes(b?.bank_id)) : []
        return Response.json({ ...j, banks }, { status: odg.status })
      }
      if (od.vrsta === 'retain') {
        const v = o.vrata ? await o.vrata() : { smije: true }
        if (!v.smije) return odbij(429, { error: 'vrata kvote zatvorena', razlog: v.razlog || 'nepoznato' })
        o.brava?.uzmi()
        try { return await proslijedi(req, url) } finally { o.brava?.pusti() }
      }
      return await proslijedi(req, url)
    } catch (e: any) {
      return odbij(502, { error: 'Hindsight nedostupan', razlog: String(e?.message || e).slice(0, 200) })
    }
  }
}
