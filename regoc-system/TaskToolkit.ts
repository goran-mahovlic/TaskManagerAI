/**
 * Vještine i alati PO ZADATKU (ADR-0016, TASK-5107 — katalog alata 3/3).
 *
 * KVAR KOJI OVO ZATVARA: blok identiteta (`IdentityBlock.ts`) agentu daje statičan popis
 * vještina iz registra (po AGENTU, 0–5) i isti popis od ~17 alata za SVAKOGA (`TOOL_GROUPS`),
 * a harness uz to isporuči još ~60 vještina bez ikakve veze sa zadatkom. Izmjereno na 20
 * povijesnih zadataka (docs/katalog/ODABIR_MJERENJE_20261002.md): statični popis pogađa malo
 * od onoga što agent stvarno koristi, a nosi mnogo onoga što ne koristi.
 *
 * ŠTO RADI: iz naslova, opisa, oznaka i projekta zadatka + `catalog/katalog.json` bira
 * 1–4 vještine i 3–8 alata (BM25 nad `ime/svrha/oznake/domena` + osnovica uloge iz registra
 * + izričite oznake `skill:<Ime>` / `alat:<id>`). Rezultat ide u blok identiteta, dakle na
 * SISTEMSKI kanal (ADR-0004 — agenti ga prate 100 %, opis zadatka 38 %).
 *
 * PREKIDAČ `config/task-toolkit.json` (off | shadow | on, po agentu nadjačava globalni):
 *   off    → ništa se ne računa; blok bajt-identičan dosadašnjem.
 *   shadow → odabir se računa i zapisuje u `data/task_toolkit.jsonl`; blok se NE mijenja.
 *   on     → blok nosi „Vještine/Alati za ovaj zadatak” umjesto statičnih odsjeka.
 * Pokvarena ili nepostojeća datoteka = `off` (uključenje mora biti svjestan čin, nikad
 * posljedica kvara — isti obrazac kao `TelegramSessionIdentity.readSwitch`).
 *
 * ČISTA LOGIKA, BEZ MREŽE I BEZ BAZE: pozivatelj (daemon) dovodi podatke zadatka; modul
 * čita samo katalog i SKILL.md s diska. Odabir je determinističan (isti zadatak → isti blok,
 * keš prefiksa se dijeli među spawnovima istog zadatka).
 */

import { existsSync, readFileSync, statSync, mkdirSync, readdirSync, symlinkSync, appendFileSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || ''

export const SWITCH_PATH = join(HOME, '.claude/regoc/config/task-toolkit.json')
export const CATALOG_PATH = join(HOME, '.claude/regoc/catalog/katalog.json')
export const SHADOW_LOG = join(HOME, '.claude/regoc/data/task_toolkit.jsonl')
/** Udio zadataka u kojima se pojam javlja (gradi ga `tools/katalog/odabir-pozadina.ts`). */
export const POZADINA_PATH = join(HOME, '.claude/regoc/catalog/odabir_pozadina.json')

export const SKILLS_HEADING = '### Vještine za ovaj zadatak'
export const TOOLS_HEADING = '### Alati za ovaj zadatak'

export type Mode = 'off' | 'shadow' | 'on'
const MODES: Mode[] = ['off', 'shadow', 'on']

export interface SwitchConfig {
  mode: Mode
  /** Prekidač po agentu nadjačava globalni (npr. probati samo na Jeleni). */
  agenti?: Record<string, Mode>
  /**
   * Faza 2 (ADR-0016 §5): spawn s privremenim CLAUDE_CONFIG_DIR u kojem su SAMO odabrane
   * vještine. Izmjereno 60 → 20 vještina u sesiji. Zasebna zastavica jer dira prijavu
   * (vidi rizik u ADR-u) — vrijedi samo uz mode `on`, zadano false.
   */
  sakrijOstaleVjestine?: boolean
}

export function readSwitch(path: string = SWITCH_PATH): SwitchConfig {
  try {
    if (!existsSync(path)) return { mode: 'off' }
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const mode: Mode = MODES.includes(raw?.mode) ? raw.mode : 'off'
    const agenti: Record<string, Mode> = {}
    for (const [k, v] of Object.entries(raw?.agenti ?? {})) if (MODES.includes(v as Mode)) agenti[k] = v as Mode
    return { mode, agenti, sakrijOstaleVjestine: raw?.sakrijOstaleVjestine === true }
  } catch {
    return { mode: 'off' }
  }
}

export function modeFor(agentId: string, cfg: SwitchConfig): Mode {
  return cfg.agenti?.[agentId] ?? cfg.mode
}

// ── Katalog ─────────────────────────────────────────────────────────────────

export interface CatalogItem {
  id: string
  ime: string
  vrsta: string
  svrha: string
  putanja: string
  poziv?: string
  domena: string
  oznake?: string[]
  status: string
  opseg?: string
  sesija_30d?: number
  aliasi?: string[]
}

/** Domene kataloga koje su moduli/servisi sustava, ne alati koje agent poziva. */
export const NE_ALATI_DOMENE = new Set(['daemon', 'agenti'])
/** Alati koje predložak prompta spawna ionako navodi svakome — ne troše mjesto u odabiru. */
export const ZADANI_ALATI = new Set(['rag-query', 'rag-store', 'consult-potjeh', 'stalecodecheck', 'regoc-services-tim', 'katalog'])
/** Vještina koju SessionStart kuka učita svakoj sesiji — nije predmet odabira. */
export const UVIJEK_UCITANE_VJESTINE = new Set(['core'])

let katalogKes: { put: string; mtime: number; stavke: CatalogItem[] } | null = null

export function loadCatalog(put: string = CATALOG_PATH): CatalogItem[] {
  try {
    const mtime = statSync(put).mtimeMs
    if (katalogKes && katalogKes.put === put && katalogKes.mtime === mtime) return katalogKes.stavke
    const stavke = JSON.parse(readFileSync(put, 'utf-8'))?.stavke
    if (!Array.isArray(stavke)) return []
    katalogKes = { put, mtime, stavke }
    return stavke
  } catch {
    return []
  }
}

// ── Tekst → pojmovi ─────────────────────────────────────────────────────────

const DIAKRITICI: Record<string, string> = { č: 'c', ć: 'c', š: 's', ž: 'z', đ: 'd' }
const STOP = new Set(('the and for with from that this use when user wants into your are not all any can ' +
  'ili ali kao koji koja koje sto što nije samo ovo ova ovaj biti bude treba mora prije nakon kada ' +
  'gdje jer pri iza bez sve svi za na od do se je su da ne te to u i a o s po iz kod već vec ima').split(' '))

/** Grubi korijen: mala slova, bez dijakritika, prvih 6 znakova (hrv. nastavci padaju). */
export function pojmovi(tekst: string): string[] {
  const t = tekst.toLowerCase().replace(/[čćšžđ]/g, c => DIAKRITICI[c] || c)
  const out: string[] = []
  for (const w of t.split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue
    out.push(w.slice(0, 6))
  }
  return out
}

/**
 * Proširenje upita: hrvatski opis ↔ engleski/kratki nazivi u katalogu. Mala ručna tablica
 * jer bez nje „izvještaj u PDF-u” ne nađe `md2pdf`, a „shema” ne nađe `kicad_*`.
 */
export const SINONIMI: Record<string, string[]> = {
  shema: ['kicad', 'netlis'], pcb: ['kicad'], plocic: ['kicad', 'pcb'], tiskan: ['kicad', 'pcb'],
  pdf: ['dokume', 'md2pdf'], izvjes: ['dokume', 'md2pdf'], dokume: ['pdf'],
  nextcl: ['nc'], oblak: ['nextcl', 'nc'], telegr: ['tg', 'poruka'], grupa: ['telegr'],
  potros: ['token', 'kvota', 'sesija', 'usage'], token: ['potros', 'telemetr'], trosak: ['token', 'potros'],
  transk: ['jsonl', 'sesija', 'transcr'], sesija: ['transk'], mjeren: ['mjera', 'mjeril', 'telemetr'],
  kpi: ['mjera', 'mjeril'], fpga: ['gatema', 'ulx5m', 'yosys'], gatema: ['fpga'], ulx5m: ['fpga'],
  serdes: ['fpga'], dijagr: ['excali', 'diagra'], crtez: ['excali'], slika: ['art', 'image'],
  prezen: ['pptx', 'slide'], tablic: ['xlsx'], excel: ['xlsx'], word: ['docx'], web: ['screen', 'preglednik'],
  stranic: ['web', 'screen'], ekran: ['screen'], greska: ['debug', 'diagno'], pogres: ['debug', 'diagno'],
  kvar: ['debug', 'diagno'], test: ['tdd', 'testir'], sigurn: ['securi', 'tajne'], tajne: ['secret', 'tajna'],
  tajna: ['secret'], mail: ['email', 'imap'], glas: ['tts', 'stt', 'voice'], govor: ['tts', 'stt'],
  rag: ['memori', 'kolekc'], pamcen: ['rag', 'memori'], arhite: ['grill', 'adr'], adr: ['grill', 'arhite'],
  dizajn: ['grill', 'design'], servis: ['restar', 'daemon'], restar: ['servis'], backup: ['arhiva'],
  katalo: ['alat', 'inventu'], alat: ['katalo'], hindsi: ['rag', 'memori'], karta: ['system'],
  petlja: ['cron', 'petlje'], cron: ['petlja'], node: ['regocm', 'vm'], istraz: ['resear'],
}
/** Ključevi i vrijednosti svedeni na isti korijen kao `pojmovi()` (6 znakova). */
const SIN: Record<string, string[]> = Object.fromEntries(
  Object.entries(SINONIMI).map(([k, v]) => [k.slice(0, 6), v.map(x => x.slice(0, 6))]))

export interface TaskInfo {
  id?: string | null
  title?: string | null
  description?: string | null
  tags?: string[] | null
  projectId?: string | null
  projectName?: string | null
}

/** Oznake koje nose sadržaj (ne `chat:-123`, ne `parent:TASK-1`, ne `tezina:100`). */
export function sadrzajneOznake(tags: string[] | null | undefined): string[] {
  return (tags || []).filter(t => !/^(chat|parent|tezina|scope|model|tier|izvor|origin):/i.test(t))
}

let pozadinaKes: { put: string; mtime: number; termini: Record<string, number> } | null = null

/** Pojam → udio zadataka u kojima se javlja. Nema datoteke → prazno (odabir i dalje radi). */
export function loadPozadina(put: string = POZADINA_PATH): Record<string, number> {
  try {
    const mtime = statSync(put).mtimeMs
    if (pozadinaKes && pozadinaKes.put === put && pozadinaKes.mtime === mtime) return pozadinaKes.termini
    const termini = JSON.parse(readFileSync(put, 'utf-8'))?.termini || {}
    pozadinaKes = { put, mtime, termini }
    return termini
  } catch {
    return {}
  }
}

/**
 * Težina pojma prema tome koliko je čest u ZADACIMA: do 5 % → 1; 10 % → ~0,6; ≥ 25 % → 0.
 * Bez ovoga „regoč”, „agent”, „sustav”, „doradi” (u katalogu rijetki, u zadacima svugdje)
 * vuku iste vještine u svaki zadatak.
 */
export function pozadinskaTezina(udio: number | undefined): number {
  if (!udio || udio <= 0.05) return 1
  return Math.max(0, 1 - (udio - 0.05) / 0.2)
}

/** Upit kao težinski vektor pojmova: naslov ×3, oznake ×3, projekt ×2, opis ×1 (prvih 3000 zn.). */
export function upit(task: TaskInfo, pozadina: Record<string, number> = {}): Map<string, number> {
  const q = new Map<string, number>()
  const dodaj = (tekst: string, w: number) => {
    for (const p of pojmovi(tekst)) {
      const wp = w * pozadinskaTezina(pozadina[p])
      if (wp <= 0) continue
      q.set(p, (q.get(p) || 0) + wp)
      for (const s of SIN[p] || []) q.set(s, (q.get(s) || 0) + wp * 0.5)
    }
  }
  dodaj(task.title || '', 3)
  dodaj(sadrzajneOznake(task.tags).join(' '), 3)
  dodaj(`${task.projectName || ''}`, 2)
  dodaj((task.description || '').slice(0, 3000), 1)
  return q
}

/** Redak tablice `tasks` → `TaskInfo` (oznake su JSON niz; pokvaren JSON = bez oznaka). */
export function taskInfoFromRow(row: { id?: string; title?: string | null; description?: string | null; tags?: string | null; project_id?: string | null } | null | undefined): TaskInfo | null {
  if (!row) return null
  let tags: string[] = []
  try { const t = JSON.parse(row.tags || '[]'); if (Array.isArray(t)) tags = t.map(String) } catch {}
  return { id: row.id ?? null, title: row.title ?? '', description: row.description ?? '', tags, projectId: row.project_id ?? null }
}

// ── Indeks i bodovanje ──────────────────────────────────────────────────────

export interface Doc<T = CatalogItem> { item: T; tf: Map<string, number>; len: number }

/**
 * Tekst vještine za indeks: ime + oznake iz kataloga + samo OKIDAČI iz SKILL.md (dio iza
 * „USE WHEN”). Uvodna rečenica („Complete visual content system”, „Multi-agent debate system”)
 * je marketinška i nosi opće riječi koje stoje u svakom zadatku — izmjereno: s njom je
 * `Art`/`Council`/`REGOC-Visualization` ulazila u zadatke o bazi podataka i FPGA-i.
 */
export function skillText(item: CatalogItem, home: string = HOME): string {
  const ime = skillName(item)
  const put = join(home, '.claude/skills', ime, 'SKILL.md')
  let opis = ''
  try { if (existsSync(put)) opis = /^description:\s*(.+?)\s*$/m.exec(readFileSync(put, 'utf-8').slice(0, 4000))?.[1] || '' } catch {}
  const okidaci = /USE WHEN(.*)$/i.exec(opis)?.[1] ?? opis
  const imeRijeci = ime.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
  return `${imeRijeci} ${imeRijeci} ${(item.oznake || []).join(' ')} ${okidaci}`
}

/** Opće engleske riječi iz okidača vještina koje ne razlikuju zadatke. */
const STOP_VJESTINE = new Set(['user', 'says', 'mention', 'system', 'agent', 'agents', 'create', 'file', 'files',
  'conten', 'work', 'multi', 'docs', 'docume', 'with', 'using', 'build', 'review', 'check', 'plan', 'analys',
  'format', 'tools', 'code', 'projec', 'task', 'tasks', 'test', 'data', 'new', 'make', 'write'].map(x => x.slice(0, 6)))

export function skillName(item: CatalogItem): string {
  // Katalog drži vještinu kao `ime` = ime mape (npr. „GrillWithDocs”); putanja je .../skills/<Ime>/SKILL.md
  const m = /skills\/([^/]+)\/SKILL\.md$/.exec(item.putanja)
  return m ? m[1] : item.ime
}

/** Indeks za BM25. Izvezen jer ga dijeli i `AgentSelection` (ADR-0018: „koga” i „s čime” iz jednog izvora). */
export function gradiIndeks<T = CatalogItem>(items: T[], tekst: (i: T) => string) {
  const docs: Doc<T>[] = items.map(item => {
    const tf = new Map<string, number>()
    const p = pojmovi(tekst(item))
    for (const t of p) tf.set(t, (tf.get(t) || 0) + 1)
    return { item, tf, len: p.length || 1 }
  })
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1)
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length)
  return { docs, df, avg, n: docs.length }
}

/** BM25 (k1=1.2, b=0.75) × težina pojma iz upita. */
export function bm25<T>(q: Map<string, number>, idx: { df: Map<string, number>; avg: number; n: number }, d: Doc<T>): { bod: number; pogoci: string[] } {
  let bod = 0
  const pogoci: string[] = []
  for (const [t, w] of q) {
    const f = d.tf.get(t)
    if (!f) continue
    const df = idx.df.get(t) || 0
    const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5))
    bod += w * idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / idx.avg))
    pogoci.push(t)
  }
  return { bod, pogoci }
}

export interface Odabrano {
  id: string
  ime: string
  bod: number
  razlog: string
  putanja?: string
  poziv?: string
  svrha?: string
}

export interface ToolkitSelection {
  taskId: string | null
  agent: string
  vjestine: Odabrano[]
  alati: Odabrano[]
}

export interface RegistryAgentLike { skills?: string[]; tools?: string[] }

export interface SelectOptions {
  maxVjestina?: number   // 4
  minVjestina?: number   // 1
  maxAlata?: number      // 8
  minAlata?: number      // 3
  /** Prag relativno prema najboljem pogotku iste vrste (0–1). */
  relPrag?: number       // 0.35
  /** Najmanji apsolutni bod vještine izvan osnovice uloge (vještina mora biti JASNO za zadatak). */
  minBodVjestine?: number // 6
  /** Pojam → udio zadataka (`loadPozadina()`); zadano se čita s diska. */
  pozadina?: Record<string, number>
  home?: string
}

const PROSIRENJA = /\.(py|ts|sh|js|mjs)$/

/**
 * Odabir za jedan zadatak. Nikad ne baca; prazan katalog → prazan odabir (pozivatelj tada
 * zadržava statične odsjeke).
 */
export function selectToolkit(
  task: TaskInfo,
  agentId: string,
  agent: RegistryAgentLike | null | undefined,
  katalog: CatalogItem[],
  opts: SelectOptions = {},
): ToolkitSelection {
  const maxV = opts.maxVjestina ?? 4, minV = opts.minVjestina ?? 1
  const maxA = opts.maxAlata ?? 8, minA = opts.minAlata ?? 3
  const rel = opts.relPrag ?? 0.35
  const home = opts.home ?? HOME
  const minBodV = opts.minBodVjestine ?? 6
  const q = upit(task, opts.pozadina ?? loadPozadina())
  const oznake = (task.tags || []).map(t => t.trim())
  const izricitoV = new Set(oznake.filter(t => /^skill:/i.test(t)).map(t => t.slice(6).toLowerCase()))
  const izricitoA = new Set(oznake.filter(t => /^alat:/i.test(t)).map(t => t.slice(5).toLowerCase()))
  // Zadatak koji je došao s Telegrama (`chat:<id>`) najčešće završava porukom ili dokumentom
  // u istu grupu — `tg-send` je tada alat zadatka (izmjereno: 7 od 40 zadataka korpusa).
  if (oznake.some(t => /^chat:-?\d+$/.test(t))) izricitoA.add('tg-send')

  // ── Vještine
  const vjestineKat = katalog.filter(i => i.vrsta === 'skill' && (i.status === 'kanonski' || i.status === 'eksperiment')
    && !UVIJEK_UCITANE_VJESTINE.has(skillName(i).toLowerCase()))
  const idxV = gradiIndeks(vjestineKat, i => skillText(i, home))
  const qV = new Map([...q].filter(([t]) => !STOP_VJESTINE.has(t)))
  const osnovica = new Set((agent?.skills || []).map(s => s.toLowerCase()).filter(s => !UVIJEK_UCITANE_VJESTINE.has(s)))
  const bodV = idxV.docs.map(d => {
    const { bod, pogoci } = bm25(qV, idxV, d)
    const ime = skillName(d.item)
    const lc = ime.toLowerCase()
    // Jedan slab pojam („proces”, „app”) nije dokaz: treba pogodak u imenu vještine ili ≥ 2 pojma.
    const imePojmovi = new Set(pojmovi(ime.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')))
    const uvjerljivo = pogoci.length >= 2 || pogoci.some(t => imePojmovi.has(t))
    let b = uvjerljivo ? bod : 0, razlog = pogoci.length ? `pojmovi: ${pogoci.slice(0, 4).join(', ')}` : ''
    if (izricitoV.has(lc)) { b += 1000; razlog = 'oznaka skill:' }
    else if (osnovica.has(lc)) { b = b * 1.5 + 0.01; razlog = razlog ? `uloga + ${razlog}` : 'osnovica uloge' }
    return { id: d.item.id, ime, bod: b, razlog, putanja: d.item.putanja, svrha: d.item.svrha }
  }).sort((a, b) => b.bod - a.bod || a.ime.localeCompare(b.ime))
  // Prag se mjeri prema najboljem PRAVOM pogotku: ni osnovica uloge ni izričita oznaka (+1000)
  // ne smiju podići prag i istisnuti ostale (izmjereno: `chat:` → tg-send je brisao sve alate).
  const vrhV = bodV.find(x => !osnovica.has(x.ime.toLowerCase()) && x.bod < 1000)?.bod || 0
  const vjestine: Odabrano[] = []
  for (const x of bodV) {
    if (vjestine.length >= maxV) break
    const lc = x.ime.toLowerCase()
    const prolazi = izricitoV.has(lc) || (x.bod >= minBodV && x.bod >= rel * Math.max(vrhV, 1e-9))
    if (prolazi) vjestine.push(x)
  }
  // Najmanje jedna: najbolja vještina uloge (osnovica), inače najbolji pogodak.
  if (vjestine.length < minV) {
    const uloga = bodV.find(x => osnovica.has(x.ime.toLowerCase()))
    const pad = uloga || bodV.find(x => x.bod > 0)
    if (pad && !vjestine.includes(pad)) vjestine.push({ ...pad, razlog: pad.razlog || 'osnovica uloge' })
  }

  // ── Alati
  const alatiKat = katalog.filter(i => i.vrsta === 'cli' && (i.status === 'kanonski' || i.status === 'eksperiment')
    && (i.opseg ?? 'sustav') === 'sustav' && !NE_ALATI_DOMENE.has(i.domena) && !ZADANI_ALATI.has(i.id))
  const idxA = gradiIndeks(alatiKat, i => `${i.id.replace(/-/g, ' ')} ${i.ime.replace(PROSIRENJA, '').replace(/[_-]/g, ' ')} ${i.svrha} ${(i.oznake || []).join(' ')} ${i.domena} ${i.domena}`)
  const vlastiti = new Set((agent?.tools || []).map(t => t.split('/').pop()!.toLowerCase()))
  const bodA = idxA.docs.map(d => {
    const { bod, pogoci } = bm25(q, idxA, d)
    // Uporaba u 30 dana je samo prevaga među sličnima, nikad razlog sama po sebi.
    let b = bod > 0 ? bod * (1 + 0.08 * Math.log1p(d.item.sesija_30d || 0)) : 0
    let razlog = pogoci.length ? `pojmovi: ${pogoci.slice(0, 4).join(', ')}` : ''
    if (izricitoA.has(d.item.id)) { b += 1000; razlog = d.item.id === 'tg-send' && !oznake.includes('alat:tg-send') ? 'zadatak s Telegrama' : 'oznaka alat:' }
    else if (vlastiti.has(d.item.ime.toLowerCase()) && b > 0) { b *= 1.3; razlog = `tvoj alat + ${razlog}` }
    return { id: d.item.id, ime: d.item.ime, bod: b, razlog, putanja: d.item.putanja, poziv: d.item.poziv, svrha: d.item.svrha }
  }).sort((a, b) => b.bod - a.bod || a.id.localeCompare(b.id))
  const sesijaPoId = new Map(alatiKat.map(i => [i.id, i.sesija_30d || 0]))
  const sesija = (id: string) => sesijaPoId.get(id) || 0
  const vrhA = bodA.find(x => x.bod < 1000)?.bod || 0
  const alati: Odabrano[] = []
  for (const x of bodA) {
    if (alati.length >= maxA) break
    if (x.bod >= 1000 || (x.bod > 1 && x.bod >= rel * vrhA)) alati.push(x)
  }
  // Najmanje 3: dopuni sljedećima po bodu (i slabiji pogodak je bolji od praznog odsjeka),
  // zatim vlastitim alatima uloge, zatim najkorištenijima u 30 dana. Prazan katalog ostaje prazan.
  const dopuna = [
    ...bodA.filter(x => x.bod > 0),
    ...bodA.filter(x => vlastiti.has(x.ime.toLowerCase())).map(x => ({ ...x, razlog: 'dopuna: tvoj alat' })),
    ...[...bodA].sort((a, b) => (sesija(b.id) - sesija(a.id)) || a.id.localeCompare(b.id)).map(x => ({ ...x, razlog: 'dopuna: najčešće korišten' })),
  ]
  for (const x of dopuna) {
    if (alati.length >= minA) break
    if (!alati.some(a => a.id === x.id)) alati.push(x)
  }

  return { taskId: task.id ?? null, agent: agentId, vjestine, alati }
}

// ── Odsjek bloka identiteta ─────────────────────────────────────────────────

export function skillSummaryLine(opis: string | undefined, max = 110): string {
  const s = (opis || '').replace(/\s+/g, ' ').split(/(?<=\.)\s/)[0]
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

/** Redci koji u bloku identiteta zamjenjuju „Tvoji skillovi” i oba odsjeka alata. */
export function buildToolkitSection(sel: ToolkitSelection, izoliran = false): string[] {
  const r: string[] = []
  if (sel.vjestine.length) {
    r.push('', `${SKILLS_HEADING} (${sel.vjestine.length}) — odabrane iz kataloga prema zadatku`)
    r.push(izoliran ? 'Pokreni ih alatom `Skill` (ime je dovoljno).' : 'Pokreni ih alatom `Skill`, ili pročitaj `~/.claude/skills/<Ime>/SKILL.md`. Ostale vještine nisu za ovaj zadatak.')
    for (const v of sel.vjestine) r.push(`- **${v.ime}** — ${skillSummaryLine(v.svrha)}`)
  }
  if (!izoliran && sel.alati.length) {
    r.push('', `${TOOLS_HEADING} (${sel.alati.length}) — iz kataloga \`~/.claude/regoc/catalog/katalog.json\``)
    for (const a of sel.alati) r.push(`- \`${a.poziv || a.putanja}\` — ${skillSummaryLine(a.svrha, 90)}`)
    r.push('Treba ti nešto drugo? `katalog trazi "<svrha>"` — postojeći alat NADOGRADI, ne piši novi.')
  }
  return r
}

/** Zapis u sjeni: što bi agent dobio. Jedan JSON redak po spawnu; nikad ne baca. */
export function logShadow(sel: ToolkitSelection, extra: Record<string, unknown> = {}, put: string = SHADOW_LOG): void {
  try {
    appendFileSync(put, JSON.stringify({
      ts: new Date().toISOString(), task: sel.taskId, agent: sel.agent,
      vjestine: sel.vjestine.map(v => v.ime), alati: sel.alati.map(a => a.id), ...extra,
    }) + '\n')
  } catch {}
}

// ── Faza 2: konfiguracijska mapa samo s odabranim vještinama ───────────────

/**
 * Gradi `dir` kao zrcalo `~/.claude` (symlinkovi), osim `skills/` u kojoj su samo CORE +
 * odabrane vještine. Spawn s `CLAUDE_CONFIG_DIR=dir` tada vidi 2+N vještina umjesto 60
 * (izmjereno 02.10.2026.: 60 → 20, ostatak su ugrađene vještine CLI-ja).
 * NIJE UKLJUČENO u daemon (ADR-0016 §5, rizik prijave) — modul i test postoje radi mjerenja.
 */
export function pripremiKonfigDir(dir: string, vjestine: string[], home: string = HOME): string {
  const izvor = join(home, '.claude')
  mkdirSync(join(dir, 'skills'), { recursive: true })
  for (const ime of readdirSync(izvor)) {
    if (ime === 'skills') continue
    const cilj = join(dir, ime)
    if (!existsSync(cilj)) symlinkSync(join(izvor, ime), cilj)
  }
  const cj = join(home, '.claude.json')
  if (existsSync(cj) && !existsSync(join(dir, '.claude.json'))) symlinkSync(cj, join(dir, '.claude.json'))
  for (const v of new Set(['CORE', ...vjestine])) {
    const s = join(izvor, 'skills', v)
    if (existsSync(s) && !existsSync(join(dir, 'skills', v))) symlinkSync(s, join(dir, 'skills', v))
  }
  return dir
}
