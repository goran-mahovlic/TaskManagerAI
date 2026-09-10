/**
 * IssueSync — jedan mehanizam za GitLab i GitHub (DIZAJN-integracije §5).
 *
 * ZAŠTO ZAJEDNO: „otvori issue, zatvori issue, komentiraj" je isti posao na oba mjesta;
 * razlikuju se samo naredba CLI-ja i oblik REST putanje. Dvije odvojene preslike te logike
 * bile bi četvrta i peta preslika istog pravila, a ovaj sustav već ima mjeren kvar
 * „pravila žive u devet preslika".
 *
 * ZAŠTO CLI PRIJE API-ja: `gh` i `glab` sami čuvaju korisnikovu prijavu (`gh auth login`,
 * `glab auth login`). Time je „donesi svoj nalog" riješeno bez ijednog tokena u našoj
 * konfiguraciji — a token koji ne postoji ne može ni procuriti. API način postoji za
 * instalacije koje CLI ne mogu instalirati.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { procitajTajnu } from './ConfigModul'
import { probaj as probajUrl } from './ProbeGuard'

export type Davatelj = 'gitlab' | 'github'
export type Nacin = 'cli' | 'api'

export interface IssueVeza {
  davatelj: Davatelj
  nacin: Nacin
  /** `grupa/repozitorij` (GitLab) ili `vlasnik/repozitorij` (GitHub). */
  projekt: string
  /** GitLab: `gitlab.com` ili vlastiti poslužitelj. GitHub: uvijek `github.com`. */
  host: string
  tokenEnv: string
}

export interface Ishod {
  ok: boolean
  greska?: string
  detalj?: Record<string, unknown>
}

const CLI_IME: Record<Davatelj, string> = { gitlab: 'glab', github: 'gh' }

const UPUTA: Record<Davatelj, string> = {
  gitlab: 'instaliraj `glab` (https://gitlab.com/gitlab-org/cli) i prijavi se: `glab auth login`',
  github: 'instaliraj `gh` (https://cli.github.com) i prijavi se: `gh auth login`',
}

/** Pokreni CLI kao POPIS argumenata (nikad kroz ljusku — nazivi repozitorija dolaze izvana). */
async function pokreni(argv: string[], env?: Record<string, string>): Promise<{
  exitCode: number; izlaz: string; greska: string
}> {
  try {
    const proc = Bun.spawn(argv, {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ...(env || {}) },
    })
    const [izlaz, greska, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, izlaz, greska }
  } catch (e: any) {
    return { exitCode: 127, izlaz: '', greska: String(e?.message || e) }
  }
}

/** Je li CLI uopće na PATH-u? Odgovor je uputa za instalaciju, ne greška (§4). */
export async function cliDostupan(davatelj: Davatelj): Promise<Ishod> {
  const r = await pokreni([CLI_IME[davatelj], '--version'])
  if (r.exitCode === 0) {
    return { ok: true, detalj: { verzija: r.izlaz.split('\n')[0]?.trim() } }
  }
  return { ok: false, greska: `naredba \`${CLI_IME[davatelj]}\` nije dostupna — ${UPUTA[davatelj]}` }
}

/** Je li korisnik prijavljen svojim nalogom? */
export async function cliPrijavljen(davatelj: Davatelj): Promise<Ishod> {
  const dostupan = await cliDostupan(davatelj)
  if (!dostupan.ok) return dostupan
  const r = await pokreni([CLI_IME[davatelj], 'auth', 'status'])
  if (r.exitCode === 0) {
    // `auth status` piše u stderr i kod uspjeha — uzimamo prvi neprazan redak kao sažetak.
    const sazetak = (r.izlaz + '\n' + r.greska).split('\n').map(s => s.trim()).find(Boolean)
    return { ok: true, detalj: { prijava: sazetak?.slice(0, 200) } }
  }
  return {
    ok: false,
    greska: `nisi prijavljen — pokreni \`${CLI_IME[davatelj]} auth login\` sa svojim nalogom`,
  }
}

// ─── API način ───────────────────────────────────────────────────────────────

function apiKorijen(veza: IssueVeza): string {
  if (veza.davatelj === 'github') return 'https://api.github.com'
  const host = veza.host || 'gitlab.com'
  return /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `https://${host}`
}

function apiPutProjekta(veza: IssueVeza): string {
  return veza.davatelj === 'github'
    ? `/repos/${veza.projekt}`
    : `/api/v4/projects/${encodeURIComponent(veza.projekt)}`
}

function apiZaglavlja(veza: IssueVeza): Record<string, string> | null {
  const token = procitajTajnu(veza.tokenEnv)
  if (!token) return null
  return veza.davatelj === 'github'
    ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
    : { 'PRIVATE-TOKEN': token }
}

// ─── Proba ───────────────────────────────────────────────────────────────────

export async function probajVezu(veza: IssueVeza): Promise<Ishod> {
  if (!veza.projekt) return { ok: false, greska: 'naziv repozitorija nije upisan' }

  if (veza.nacin === 'cli') {
    const prijava = await cliPrijavljen(veza.davatelj)
    if (!prijava.ok) return prijava
    const argv = veza.davatelj === 'github'
      ? ['gh', 'repo', 'view', veza.projekt, '--json', 'name']
      : ['glab', 'api', `projects/${encodeURIComponent(veza.projekt)}`]
    const r = await pokreni(argv)
    return r.exitCode === 0
      ? { ok: true, detalj: { ...prijava.detalj, repozitorij: veza.projekt } }
      : { ok: false, greska: `repozitorij nije dostupan: ${(r.greska || r.izlaz).trim().slice(0, 200)}` }
  }

  const zaglavlja = apiZaglavlja(veza)
  if (!zaglavlja) return { ok: false, greska: `token nije postavljen (varijabla ${veza.tokenEnv})` }
  const url = apiKorijen(veza) + apiPutProjekta(veza)
  const ishod = await probajUrl(url, { headers: zaglavlja, dopustiPrivatneMreze: true })
  const status = ishod.detalj?.status
  if (status === 401 || status === 403) return { ok: false, greska: 'token nije valjan ili nema prava', detalj: ishod.detalj }
  if (status === 404) return { ok: false, greska: 'repozitorij ne postoji ili nije vidljiv ovom tokenu', detalj: ishod.detalj }
  return ishod.ok
    ? { ok: true, detalj: { ...ishod.detalj, repozitorij: veza.projekt } }
    : { ok: false, greska: ishod.greska, detalj: ishod.detalj }
}

// ─── Issue ───────────────────────────────────────────────────────────────────

export interface IssueZahtjev {
  naslov: string
  opis?: string
  oznake?: string[]
}

/** Otvori issue. Vraća broj/URL kad ga davatelj da. */
export async function otvoriIssue(veza: IssueVeza, z: IssueZahtjev): Promise<Ishod> {
  if (!z.naslov?.trim()) return { ok: false, greska: 'naslov je obavezan' }

  if (veza.nacin === 'cli') {
    const argv = veza.davatelj === 'github'
      ? ['gh', 'issue', 'create', '--repo', veza.projekt, '--title', z.naslov,
         '--body', z.opis || '', ...(z.oznake?.length ? ['--label', z.oznake.join(',')] : [])]
      : ['glab', 'issue', 'create', '--repo', veza.projekt, '--title', z.naslov,
         '--description', z.opis || '', ...(z.oznake?.length ? ['--label', z.oznake.join(',')] : [])]
    const r = await pokreni(argv)
    return r.exitCode === 0
      ? { ok: true, detalj: { url: r.izlaz.trim().split('\n').pop() } }
      : { ok: false, greska: (r.greska || r.izlaz).trim().slice(0, 300) }
  }

  const zaglavlja = apiZaglavlja(veza)
  if (!zaglavlja) return { ok: false, greska: `token nije postavljen (varijabla ${veza.tokenEnv})` }
  const url = apiKorijen(veza) + apiPutProjekta(veza) + (veza.davatelj === 'github' ? '/issues' : '/issues')
  const tijelo = veza.davatelj === 'github'
    ? { title: z.naslov, body: z.opis || '', labels: z.oznake || [] }
    : { title: z.naslov, description: z.opis || '', labels: (z.oznake || []).join(',') }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...zaglavlja, 'Content-Type': 'application/json' },
      body: JSON.stringify(tijelo),
      redirect: 'manual',
    })
    if (!resp.ok) return { ok: false, greska: `HTTP ${resp.status}` }
    const j: any = await resp.json().catch(() => ({}))
    return { ok: true, detalj: { broj: j.number ?? j.iid, url: j.html_url ?? j.web_url } }
  } catch (e: any) {
    return { ok: false, greska: String(e?.message || e) }
  }
}

/** Zatvori issue po broju. */
export async function zatvoriIssue(veza: IssueVeza, broj: number | string): Promise<Ishod> {
  const id = String(broj).replace(/^#/, '')
  if (!/^\d+$/.test(id)) return { ok: false, greska: 'broj issuea mora biti broj' }

  if (veza.nacin === 'cli') {
    const argv = veza.davatelj === 'github'
      ? ['gh', 'issue', 'close', id, '--repo', veza.projekt]
      : ['glab', 'issue', 'close', id, '--repo', veza.projekt]
    const r = await pokreni(argv)
    return r.exitCode === 0
      ? { ok: true }
      : { ok: false, greska: (r.greska || r.izlaz).trim().slice(0, 300) }
  }

  const zaglavlja = apiZaglavlja(veza)
  if (!zaglavlja) return { ok: false, greska: `token nije postavljen (varijabla ${veza.tokenEnv})` }
  const url = apiKorijen(veza) + apiPutProjekta(veza) + `/issues/${id}`
  try {
    const resp = await fetch(url, {
      method: veza.davatelj === 'github' ? 'PATCH' : 'PUT',
      headers: { ...zaglavlja, 'Content-Type': 'application/json' },
      body: JSON.stringify(veza.davatelj === 'github' ? { state: 'closed' } : { state_event: 'close' }),
      redirect: 'manual',
    })
    return resp.ok ? { ok: true } : { ok: false, greska: `HTTP ${resp.status}` }
  } catch (e: any) {
    return { ok: false, greska: String(e?.message || e) }
  }
}

export { CLI_IME, UPUTA }
