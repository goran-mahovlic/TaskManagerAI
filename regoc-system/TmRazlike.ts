/**
 * TmRazlike — dva stabla TaskManagera, jedan popis parova (ADR-0023 opcija C, korak B, TASK-5623).
 *
 * ZAŠTO POSTOJI: paket `~/app/TaskManager/TaskManagerAI` i glavni sustav (ploča
 * `~/.claude/regoc/TaskManagerMD` + jezgra `~/.claude/regoc/*.ts`) dijele module, a prijenos
 * među njima bio je ručan. Izmjereno (ADR-0023 §2–§4): TASK-5198 je nestao iz glavnog jer ga
 * je kasnija izmjena prepisala, TASK-5269 je kasnio 13 dana, a kritičar je gledao samo jedno
 * stablo (N4). Ovaj modul daje dvije stvari:
 *   1) popis parova datoteka + usporedbu po sadržaju (ISTO/RAZLIKA) — ulaz za alat
 *      `tools/taskmanager/tm_razlike.ts` i za dnevnu petlju,
 *   2) presudu „dirnuto samo jedno stablo” — ulaz za kuku u `CriticGate` (prekidači
 *      `tmDvaStabla` = sjena, `tmDvaStablaLive` = odbija DONE).
 *
 * USPOREDBA je ista kao u mjerenju (`docs/architecture/taskmanager_jedan_izvor_5617/`):
 * skup ZNAČAJNIH redaka (≥ 20 znakova, nije import/zagrada), bjeline stisnute, putanje uvoza
 * izjednačene (`./core/X`, `../X` ↔ `<HOME glavnog>/.claude/regoc/X`). `paths.ts` se ne
 * prevodi izraz po izraz: njegov uvoz je redak `import`, pa ne ulazi u usporedbu, a izraz
 * `konfigPutanja(...)` ↔ `join(HOME, ...)` ostaje stvarna razlika (paket i glavni rješavaju
 * korijen drukčije — takav par ide u izuzeća ili se prenosi ručno).
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { join, basename, resolve, dirname, relative } from 'path'
import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { okolina } from './lib/okolina-sustava' // TASK-5700 (K3a)

const HOME = process.env.HOME || homedir()

export interface Stabla {
  /** Paket TaskManagerAI (samostalna inačica, GitHub, čvorovi). */
  paket: string
  /** Glavna ploča 17781. */
  md: string
  /** Jezgra: moduli koje dijele ploča i daemon. */
  regoc: string
}

/** Putanje se smiju premjestiti okolinom SAMO za testove/alat; pogon ih ne postavlja. */
export function zadanaStabla(): Stabla {
  const regoc = process.env.TM_RAZLIKE_REGOC || join(HOME, '.claude', 'regoc')
  return {
    paket: process.env.TM_RAZLIKE_PAKET || join(HOME, 'app', 'TaskManager', 'TaskManagerAI'),
    md: process.env.TM_RAZLIKE_MD || join(regoc, 'TaskManagerMD'),
    regoc,
  }
}

export const TM_RAZLIKE_CONFIG = join(HOME, '.claude', 'regoc', 'config', 'tm-razlike.json')

// ─── Normalizacija (port `mjeri_razlike.py`) ─────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Uvozne putanje svedene na ime modula: apsolutne (glavni) i relativne (paket) postaju iste. */
export function normalizator(home = HOME): (l: string) => string {
  const put = new RegExp(
    `(['"])(?:${escapeRe(home)}/\\.claude/regoc/|${escapeRe(home)}/\\.claude/skills/CORE/Tools/lib/|(?:\\.\\./)+|\\./)(?:core/|security/|zod/schemas/?|rag/)?`,
    'g',
  )
  // Ista pravila i za doslovni HOME glavnog stroja (config/okolina.json `glavni_home`) — moduli
  // glavnog ga ponegdje imaju tvrdo upisanog (TASK-5700: vrijednost više nije u kodu).
  const glavni = okolina().glavniHome
  const putKlaudio = !glavni || home === glavni ? null : normalizator(glavni)
  return (l: string) => {
    let s = l.trim().replace(put, '$1')
    if (putKlaudio) s = putKlaudio(s)
    return s.replace(/\s+/g, ' ')
  }
}
export const norm = normalizator()

export function znacajan(n: string): boolean {
  if (n.length < 20) return false
  if (n.startsWith('import ') || n.startsWith('} from') || n.startsWith('export {')) return false
  if (/^[\s{}()[\];,]*$/.test(n)) return false
  return true
}

function znacajniRetci(put: string): Set<string> | null {
  let t: string
  try { t = readFileSync(put, 'utf-8') } catch { return null }
  const s = new Set<string>()
  for (const l of t.split('\n')) {
    const n = norm(l)
    if (znacajan(n)) s.add(n)
  }
  return s
}

// ─── Parovi ──────────────────────────────────────────────────────────────────

export interface Par {
  /** Put u paketu, relativno (`src/core/CriticGate.ts`) — ključ para i izuzeća. */
  kljuc: string
  paket: string
  glavni: string
  /** U kojem dijelu glavnog sustava živi pandan. */
  strana: 'MD' | 'jezgra'
}

export interface Popis {
  parovi: Par[]
  /**
   * Moduli na JEDNOM izvoru (ADR-0023 §5 C korak 2, TASK-5624): datoteka u glavnom je poveznica
   * na paketovu, pa par ne postoji — nema dviju kopija koje bi se mogle razići. Kuka ih ne gleda.
   */
  jedanIzvor: Par[]
  /** Datoteke paketa bez pandana (relativno na paket). */
  samoPaket: string[]
  /** Datoteke ploče MD bez pandana (relativno na MD). Jezgra bez pandana se ne broji: daemon je samo glavni. */
  samoGlavni: string[]
}

function ls(dir: string, nastavak: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(nastavak) && !f.includes('.bak') && !f.endsWith('.test.ts'))
      .filter((f) => { try { return statSync(join(dir, f)).isFile() } catch { return false } })
      .sort()
  } catch { return [] }
}

/**
 * Pravila sparivanja su ista kao u `usporedi_datoteke.py` (TASK-5617), da brojevi alata i
 * ADR-a budu usporedivi: `src/*.ts`, `src/core/*.ts`, `src/core/models/*.ts`, `locales/*.json`.
 * Kandidati u glavnom, redom: MD/<isti put>, MD/src/<ime>, MD/src/core/<ime>, jezgra/<ime>,
 * jezgra/models/<ime>, jezgra/security/<ime>.
 */
export function nadjiParove(s: Stabla = zadanaStabla()): Popis {
  const paketDat: string[] = [
    ...ls(join(s.paket, 'src'), '.ts').map((f) => `src/${f}`),
    ...ls(join(s.paket, 'src', 'core'), '.ts').map((f) => `src/core/${f}`),
    ...ls(join(s.paket, 'src', 'core', 'models'), '.ts').map((f) => `src/core/models/${f}`),
    ...ls(join(s.paket, 'locales'), '.json').map((f) => `locales/${f}`),
  ]
  const parovi: Par[] = []
  const jedanIzvor: Par[] = []
  const samoPaket: string[] = []
  const zauzeto = new Set<string>()
  for (const rel of paketDat) {
    const b = basename(rel)
    const kand: Array<[string, Par['strana']]> = [
      [join(s.md, rel), 'MD'], [join(s.md, 'src', b), 'MD'], [join(s.md, 'src', 'core', b), 'MD'],
      [join(s.regoc, b), 'jezgra'], [join(s.regoc, 'models', b), 'jezgra'], [join(s.regoc, 'security', b), 'jezgra'],
    ]
    const g = kand.find(([k]) => existsSync(k))
    if (!g) { samoPaket.push(rel); continue }
    const par: Par = { kljuc: rel, paket: join(s.paket, rel), glavni: g[0], strana: g[1] }
    ;(istaDatoteka(par.paket, par.glavni) ? jedanIzvor : parovi).push(par)
    zauzeto.add(resolve(g[0]))
  }
  const samoGlavni = [
    ...ls(join(s.md, 'src'), '.ts').map((f) => `src/${f}`),
    ...ls(join(s.md, 'src', 'core'), '.ts').map((f) => `src/core/${f}`),
    ...ls(join(s.md, 'locales'), '.json').map((f) => `locales/${f}`),
  ].filter((rel) => !zauzeto.has(resolve(join(s.md, rel))))
  return { parovi, jedanIzvor, samoPaket, samoGlavni }
}

/** Ista datoteka na disku (poveznica razriješena) — pandan glavnog je paketov modul, ne kopija. */
function istaDatoteka(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

export interface Usporedba {
  status: 'ISTO' | 'RAZLIKA'
  samoPaket: number
  samoGlavni: number
  zajedno: number
}

export function usporediPar(p: Pick<Par, 'paket' | 'glavni'>): Usporedba {
  const a = znacajniRetci(p.paket) ?? new Set<string>()
  const b = znacajniRetci(p.glavni) ?? new Set<string>()
  let sp = 0, zaj = 0
  for (const x of a) { if (b.has(x)) zaj++; else sp++ }
  const sg = b.size - zaj
  return { status: sp === 0 && sg === 0 ? 'ISTO' : 'RAZLIKA', samoPaket: sp, samoGlavni: sg, zajedno: zaj }
}

// ─── Izuzeća ─────────────────────────────────────────────────────────────────

export interface Izuzece {
  /** Relativni put: za `par`/`samo-paket` u paketu, za `samo-glavni` u MD-u. */
  put: string
  /**
   * `par` = pandan postoji, ali se stabla namjerno razilaze (smije se dirati jedno);
   * `samo-paket` / `samo-glavni` = datoteka namjenski postoji samo u jednom stablu.
   */
  vrsta: 'par' | 'samo-paket' | 'samo-glavni'
  razlog: string
}

/** Izuzeće bez razloga se ne prihvaća: „zašto smije” mora biti zapisano, inače je rupa. */
export function ucitajIzuzeca(path = TM_RAZLIKE_CONFIG): Izuzece[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const arr = Array.isArray(raw?.izuzeca) ? raw.izuzeca : []
    return arr.filter((x: any) =>
      x && typeof x.put === 'string' && x.put
      && ['par', 'samo-paket', 'samo-glavni'].includes(x.vrsta)
      && typeof x.razlog === 'string' && x.razlog.trim().length >= 3)
  } catch {
    return []
  }
}

// ─── Izvještaj alata ─────────────────────────────────────────────────────────

export interface RedIzvjestaja {
  put: string
  glavni: string | null
  status: 'ISTO' | 'RAZLIKA' | 'SAMO-PAKET' | 'SAMO-GLAVNI' | 'JEDAN-IZVOR'
  samoPaket: number | null
  samoGlavni: number | null
  zajedno: number | null
  /** Razlog izuzeća kad postoji; `null` za `SAMO-*` znači NEOBJAŠNJENO (kandidat za prazninu). */
  izuzece: string | null
}

export function izvjestaj(s: Stabla = zadanaStabla(), izuzeca: Izuzece[] = ucitajIzuzeca()): RedIzvjestaja[] {
  const pop = nadjiParove(s)
  const razlog = (vrsta: Izuzece['vrsta'], put: string) => izuzeca.find((i) => i.vrsta === vrsta && i.put === put)?.razlog ?? null
  const rel = (p: string) => p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p
  const out: RedIzvjestaja[] = pop.parovi.map((p) => {
    const u = usporediPar(p)
    return { put: p.kljuc, glavni: rel(p.glavni), status: u.status, samoPaket: u.samoPaket, samoGlavni: u.samoGlavni, zajedno: u.zajedno, izuzece: razlog('par', p.kljuc) }
  })
  for (const p of pop.jedanIzvor) out.push({ put: p.kljuc, glavni: rel(p.glavni), status: 'JEDAN-IZVOR', samoPaket: null, samoGlavni: null, zajedno: null, izuzece: null })
  for (const p of pop.samoPaket) out.push({ put: p, glavni: null, status: 'SAMO-PAKET', samoPaket: null, samoGlavni: null, zajedno: null, izuzece: razlog('samo-paket', p) })
  for (const p of pop.samoGlavni) out.push({ put: p, glavni: rel(join(s.md, p)), status: 'SAMO-GLAVNI', samoPaket: null, samoGlavni: null, zajedno: null, izuzece: razlog('samo-glavni', p) })
  return out
}

// ─── Kuka kritičara: dirnuto samo jedno stablo ───────────────────────────────

export interface Oznake {
  /** `[prijenos: TASK-N]` — prijenos je otvoren/obavljen u tom zadatku. */
  prijenos: string[]
  /** `[samo-paket: razlog]` — izmjena je namjenski samo u paketu. */
  samoPaket: string[]
  /** `[samo-glavni: razlog]` — izmjena je namjenski samo u glavnom. */
  samoGlavni: string[]
}

const RE_PRIJENOS = /\[prijenos:\s*(TASK-\d+(?:\s*,\s*TASK-\d+)*)\s*\]/gi
const RE_SAMO = /\[samo-(paket|glavni):\s*([^\]\n]{3,})\]/gi

/** Oznake iz opisa zadatka, izvještaja i poruka commitova. `TASK-x` (bez broja) NIJE oznaka. */
export function citajOznake(tekstovi: Array<string | null | undefined>): Oznake {
  const o: Oznake = { prijenos: [], samoPaket: [], samoGlavni: [] }
  for (const t of tekstovi) {
    if (!t) continue
    for (const m of t.matchAll(RE_PRIJENOS)) for (const id of m[1].split(',')) o.prijenos.push(id.trim().toUpperCase())
    for (const m of t.matchAll(RE_SAMO)) (m[1].toLowerCase() === 'paket' ? o.samoPaket : o.samoGlavni).push(m[2].trim())
  }
  o.prijenos = [...new Set(o.prijenos)]
  return o
}

/**
 * Poruke commitova od `sinceMs` u repozitorijima oba stabla. Oznaka se po ADR-0023 §5 B2
 * piše u commit; zato se čitaju i oni. Rok 3 s po repou: git koji visi ne smije zaustaviti
 * kritičara (nedostupna poruka = nema oznake iz commita, ne „prolaz”).
 */
export function porukeCommitova(sinceMs: number, s: Stabla = zadanaStabla()): string[] {
  const out: string[] = []
  const since = `@${Math.floor(sinceMs / 1000)}`
  for (const repo of [s.paket, s.md, s.regoc]) {
    if (!existsSync(join(repo, '.git'))) continue
    const r = spawnSync('git', ['-C', repo, 'log', `--since=${since}`, '--format=%B%x00'], { encoding: 'utf-8', timeout: 3_000 })
    if (r.status === 0 && r.stdout) out.push(...r.stdout.split('\0').map((x) => x.trim()).filter(Boolean))
  }
  return out
}

/** Prag „preneseno” — isti kao u mjerenju ADR-0023 §2 (PRENESENO ≥ 80 %). */
export const PRAG_PRENESENO = 0.8

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 3_000 })
  return r.status === 0 ? r.stdout : null
}

/**
 * Značajni retci koje je datoteka DOBILA od `sinceMs`: razlika radnog stabla prema zadnjem
 * commitu prije te granice (uključuje i necommitan rad — ADR-0023 N1). Nova datoteka u repou →
 * svi njeni retci. `null` = izvan gita ili git nije odgovorio (ne zna se, dakle ne pokriva).
 */
export function dodaniRetci(put: string, sinceMs: number): string[] | null {
  const dir = dirname(put)
  const vrh = git(dir, ['rev-parse', '--show-toplevel'])?.trim()
  const svi = () => { try { return readFileSync(put, 'utf-8').split('\n').map(norm).filter(znacajan) } catch { return null } }
  // Izvan gita se ne zna što je dodano (cijela datoteka bi zajedničkim retcima lažno „prenijela”).
  if (!vrh) return null
  const rel = relative(vrh, put)
  const baza = git(vrh, ['rev-list', '-1', `--before=@${Math.floor(sinceMs / 1000)}`, 'HEAD'])?.trim()
  if (!baza) return svi()
  if (git(vrh, ['cat-file', '-e', `${baza}:${rel}`]) === null) return svi()
  const diff = git(vrh, ['diff', '-U0', '--no-color', baza, '--', rel])
  if (diff === null) return null
  return diff.split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => norm(l.slice(1)))
    .filter(znacajan)
}

/** Redak komentara (`//`, `/*`, ` * …`) — prijenos ga redovito prepiše („prijenos iz glavnog TASK-N”). */
export function jeKomentar(n: string): boolean {
  return /^(\/\/|\/\*|\*)/.test(n)
}

/**
 * Udio dodanih redaka KODA koji već postoje u pandanu; `null` = nema dodanog koda ili git ne zna.
 * Komentari se ne broje: izmjereno 20.10.2026. na prijenosima TASK-5618 (TaskCloser 1/4,
 * WorkflowGate 9/13 s komentarima) — razlika je bila u komentaru, ne u kodu.
 */
export function udioPrenesenog(put: string, pandan: string, sinceMs: number): { nadjeno: number; ukupno: number } | null {
  const dodano = dodaniRetci(put, sinceMs)?.filter((x) => !jeKomentar(x))
  if (!dodano || dodano.length === 0) return null
  const cilj = znacajniRetci(pandan) ?? new Set<string>()
  return { nadjeno: dodano.filter((x) => cilj.has(x)).length, ukupno: dodano.length }
}

export interface JednostranaIzmjena {
  kljuc: string
  /** Koje je stablo dirnuto. */
  dirnuto: 'paket' | 'glavni'
  /** Dirnuta datoteka (apsolutno). */
  put: string
  /** Pandan koji NIJE dirnut. */
  pandan: string
  samoPaket: number
  samoGlavni: number
}

export type TmNacin = 'off' | 'shadow' | 'on'

export interface TmSud {
  nacin: TmNacin
  /** true = DONE bi trebao pasti (u sjeni se samo bilježi). */
  odbij: boolean
  /** Parne datoteke koje je spawn dirao (apsolutno). */
  dirnute: string[]
  /** Jednostrane izmjene koje NISU pokrivene oznakom ni izuzećem — razlog odbijanja. */
  jednostrano: JednostranaIzmjena[]
  /** Jednostrane izmjene pokrivene izuzećem ili oznakom (vidljivo u tragu, ne obara). */
  pokriveno: Array<{ kljuc: string; cime: string }>
  oznake: Oznake
  /** `transkript(n)` ili `mtime` (bez transkripta — atribucija po vremenu izmjene). */
  atribucija: string
  razlog: string
}

export interface TmUlaz {
  /** Granica „što je ovaj spawn dirao”. */
  sinceMs: number
  /** Opis zadatka, izvještaj agenta, poruke commitova — mjesta gdje smije stajati oznaka. */
  tekstovi: Array<string | null | undefined>
  /**
   * Je li spawn dirao datoteku (transkript). `null` = atribucija nedostupna, vrijedi mtime.
   * Funkcija se podmeće da modul ne ovisi o `KriticarOpseg` (i obrnuto).
   */
  pripada?: ((put: string) => boolean) | null
  atribucija?: string
  stabla?: Stabla
  izuzeca?: Izuzece[]
  nacin?: TmNacin
  /** Tolerancija mtimea unatrag (kao `mtimeSkewMs` kritičara). */
  skewMs?: number
}

function mtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return -1 }
}

/**
 * Presuda kuke. Pravilo (ADR-0023 §5 B2): ako je spawn dirao datoteku s popisa parova
 * u SAMO JEDNOM stablu, a stabla su sada RAZLIČITA, DONE pada — osim kad postoji
 * `[prijenos: TASK-N]`, `[samo-paket|samo-glavni: razlog]` za tu stranu, ili izuzeće para.
 * Par koji je nakon izmjene ISTO ne obara (npr. sama formatacija ili prijenos u oba smjera).
 */
export function sudDvaStabla(u: TmUlaz): TmSud {
  const s = u.stabla ?? zadanaStabla()
  const izuzeca = u.izuzeca ?? ucitajIzuzeca()
  const nacin = u.nacin ?? 'shadow'
  const granica = u.sinceMs - (u.skewMs ?? 2_000)
  const oznake = citajOznake(u.tekstovi)
  const dirao = (p: string) => mtime(p) >= granica && (u.pripada ? u.pripada(p) : true)

  const dirnute: string[] = []
  const jednostrano: JednostranaIzmjena[] = []
  const pokriveno: TmSud['pokriveno'] = []
  for (const par of nadjiParove(s).parovi) {
    const dp = dirao(par.paket)
    const dg = dirao(par.glavni)
    if (dp) dirnute.push(par.paket)
    if (dg) dirnute.push(par.glavni)
    if (dp === dg) continue
    const usp = usporediPar(par)
    if (usp.status === 'ISTO') continue
    const strana: 'paket' | 'glavni' = dp ? 'paket' : 'glavni'
    const izu = izuzeca.find((i) => i.vrsta === 'par' && i.put === par.kljuc)
    let cime: string | null = null
    if (izu) cime = `izuzeće: ${izu.razlog}`
    else if (oznake.prijenos.length) cime = `[prijenos: ${oznake.prijenos.join(', ')}]`
    else if (strana === 'paket' && oznake.samoPaket.length) cime = `[samo-paket: ${oznake.samoPaket[0]}]`
    else if (strana === 'glavni' && oznake.samoGlavni.length) cime = `[samo-glavni: ${oznake.samoGlavni[0]}]`
    if (!cime) {
      // Prijenos u istom spawnu, ali par ostaje RAZLIČIT zbog starih razlika (npr. ručni
      // prijenos jedne značajke): presuđuje sadržaj, ne oznaka — kao u mjerenju ADR-0023 §2.
      const pren = udioPrenesenog(dp ? par.paket : par.glavni, dp ? par.glavni : par.paket, u.sinceMs)
      if (pren && pren.nadjeno / pren.ukupno >= PRAG_PRENESENO) cime = `preneseno po sadržaju (${pren.nadjeno}/${pren.ukupno})`
    }
    if (cime) { pokriveno.push({ kljuc: par.kljuc, cime }); continue }
    jednostrano.push({
      kljuc: par.kljuc, dirnuto: strana,
      put: dp ? par.paket : par.glavni, pandan: dp ? par.glavni : par.paket,
      samoPaket: usp.samoPaket, samoGlavni: usp.samoGlavni,
    })
  }
  const odbij = jednostrano.length > 0
  const razlog = odbij
    ? `dirnuto samo jedno stablo TaskManagera (ADR-0023 §5 B2) u ${jednostrano.length} par(a): `
      + jednostrano.slice(0, 5).map((j) => `${j.kljuc} [${j.dirnuto}; razlika paket ${j.samoPaket} / glavni ${j.samoGlavni}]`).join(', ')
      + ' — prenesi u drugo stablo ili označi [prijenos: TASK-N] / [samo-paket|samo-glavni: razlog]'
    : dirnute.length ? `parne datoteke dirnute u oba stabla ili pokrivene (${pokriveno.length})` : 'nije dirnuta nijedna parna datoteka'
  return {
    nacin, odbij, dirnute, jednostrano, pokriveno, oznake,
    atribucija: u.atribucija ?? (u.pripada ? 'transkript' : 'mtime'),
    razlog,
  }
}
