/**
 * Posrednik memorije (ADR-0006 §8, opcija B): pred Hindsightom koji nema zaštitu po banci stoji
 * mali HTTP posrednik koji čvoru propušta SAMO njegovu banku.
 *
 *   - `GET /health`                         → prosljeđuje (Memorija.ts provjerava živost)
 *   - `GET /v1/default/banks`               → popis, ali filtriran na dopuštene banke
 *   - `/v1/default/banks/<dopuštena>/<podput>` → samo parovi (metoda, podput) s bijele liste
 *     `DOPUSTENO`; put se dekodira po segmentu, opasni segment (`..`, `\`) odbija, a prema
 *     Hindsightu ide KANONSKI put sastavljen iz provjerenih segmenata (ne sirovi `pathname`)
 *   - sve ostalo (tuđa banka, brisanje banke, webhookovi, kloniranje, uvoz, postavke) → 403,
 *     bez ijednog poziva prema Hindsightu
 *
 * Retain i reflect troše LLM onoga tko drži Hindsight, pa prije njih idu VRATA KVOTE
 * (zatvorena → 429 s razlogom) i BRAVA (da uskladitelj ne restarta Hindsight usred retaina).
 * Obje su ubrizgane — paket ne zna čiji je Hindsight.
 */

export type Odluka =
  | { vrsta: 'propusti'; put: string }
  | { vrsta: 'popis' }
  | { vrsta: 'llm'; banka: string; put: string }
  | { vrsta: 'zabrani'; razlog: string }

const BANKE = '/v1/default/banks'

/**
 * Bijela lista (metoda, podput) iza `/v1/default/banks/<banka>`. `{id}` = jedan segment (id
 * dokumenta smije nositi kodiranu `/`). Sve ostalo — webhookovi, kloniranje, prijenos, uvoz,
 * postavke LLM-a, brisanje svih memorija — zabranjeno je čvoru. `llm` = troši LLM (vrata + brava).
 */
const DOPUSTENO: ReadonlyArray<[string, string, 'propusti' | 'llm']> = [
  ['PUT', '', 'propusti'],                 // stvori/uskladi banku (ime, misija) — bez postavki LLM-a
  ['GET', 'profile', 'propusti'],
  ['POST', 'memories', 'llm'],             // retain
  ['POST', 'memories/recall', 'propusti'],
  ['POST', 'reflect', 'llm'],
  ['GET', 'memories/list', 'propusti'],
  ['GET', 'documents', 'propusti'],
  ['GET', 'documents/{id}', 'propusti'],
  ['DELETE', 'documents/{id}', 'propusti'],
  ['GET', 'stats', 'propusti'],
  ['GET', 'entities', 'propusti'],
  ['GET', 'tags', 'propusti'],
  ['GET', 'operations', 'propusti'],
  ['GET', 'operations/{id}', 'propusti'],
]

/** Dekodiran segment ili null kad je opasan (prazan, `.`/`..`, `\`, nečitljiv). */
function segment(sirovo: string, smijeKosu: boolean): string | null {
  let d: string
  try { d = decodeURIComponent(sirovo) } catch { return null }
  if (!d || d.includes('\\') || d.includes('\0')) return null
  if (!smijeKosu && d.includes('/')) return null
  if (d.split('/').some(x => x === '.' || x === '..' || x === '')) return null
  return d
}

export function odluci(metoda: string, put: string, banke: readonly string[]): Odluka {
  if (put === '/health' && metoda === 'GET') return { vrsta: 'propusti', put }
  if ((put === BANKE || put === BANKE + '/') && metoda === 'GET') return { vrsta: 'popis' }
  if (!put.startsWith(BANKE + '/')) return { vrsta: 'zabrani', razlog: 'put nije dopušten' }
  const [sirovaBanka, ...sirovi] = put.slice(BANKE.length + 1).split('/')
  const banka = segment(sirovaBanka, false)
  if (!banka || !/^[\w.-]+$/.test(banka)) return { vrsta: 'zabrani', razlog: 'neispravno ime banke' }
  if (!banke.includes(banka)) return { vrsta: 'zabrani', razlog: `banka ${banka} nije banka ovog čvora` }
  if (sirovi.length && sirovi[sirovi.length - 1] === '') sirovi.pop()
  for (const [m, uzorak, vrsta] of DOPUSTENO) {
    if (m !== metoda) continue
    const u = uzorak ? uzorak.split('/') : []
    if (u.length !== sirovi.length) continue
    const dekodirano: string[] = []
    let ok = true
    for (const [i, dio] of u.entries()) {
      const d = segment(sirovi[i], dio === '{id}')
      if (d === null || (dio !== '{id}' && d !== dio)) { ok = false; break }
      dekodirano.push(d)
    }
    if (!ok) continue
    // Kanonski put prema Hindsightu: svaki segment ponovo kodiran — ono što je provjereno, to se i šalje.
    const kanon = [BANKE, encodeURIComponent(banka), ...dekodirano.map(encodeURIComponent)].join('/')
    return vrsta === 'llm' ? { vrsta: 'llm', banka, put: kanon } : { vrsta: 'propusti', put: kanon }
  }
  return { vrsta: 'zabrani', razlog: `${metoda} ${sirovi.join('/') || '(banka)'} nije dopušten čvoru` }
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

  const proslijedi = async (req: Request, url: URL, put: string): Promise<Response> => {
    const tijelo = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer()
    const zaglavlja = new Headers()
    const ct = req.headers.get('content-type')
    if (ct) zaglavlja.set('content-type', ct)
    const odg = await f(`${cilj}${put}${url.search}`, { method: req.method, headers: zaglavlja, body: tijelo, signal: AbortSignal.timeout(rok) })
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
      if (od.vrsta === 'llm') {
        const v = o.vrata ? await o.vrata() : { smije: true }
        if (!v.smije) return odbij(429, { error: 'vrata kvote zatvorena', razlog: v.razlog || 'nepoznato' })
        o.brava?.uzmi()
        try { return await proslijedi(req, url, od.put) } finally { o.brava?.pusti() }
      }
      return await proslijedi(req, url, od.put)
    } catch (e: any) {
      return odbij(502, { error: 'Hindsight nedostupan', razlog: String(e?.message || e).slice(0, 200) })
    }
  }
}
