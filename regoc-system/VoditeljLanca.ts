// ─── Voditelj lanca (ADR-0024, V1 · TASK-5676) ───────────────────────────────
// Jedan zadatak-voditelj po projektnom lancu. Ovaj modul je ČISTA LOGIKA + I/O stanja:
// otisak lanca, predprolaz (budi li se model), razvrstavanje pada, plan radnji s ograničenjima
// O4, proračun i ključ pitanja. NIŠTA ne uvozi iz RegocDaemona (kao TrajnaSesija.ts) — daemon
// (V2) ga zove, a ne obrnuto. Izvor istine su ploča i datoteka stanja, ne pamćenje modela.
//
// Stanje:   data/voditelji/<TASK>.json   (atomski zapis: tmp + rename)
// Dnevnik:  data/voditelji/<TASK>.jsonl
// Proračun: config/voditelj-lanca.json   (čita se uživo; nevaljano = zadane vrijednosti)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'

const HOME = process.env.HOME || ''
const KORIJEN = join(HOME, '.claude', 'regoc')

export type NacinVoditelja = 'off' | 'shadow' | 'on'
/** D1: tko spaja grane `completed` članova. Goran 21.10.2026. (uputa #422): A = 'sam' (lokalno, čist merge, zeleni testovi, nikad push). */
export type SpajanjeGrana = 'sam' | 'zadatak' | 'javi'

// ─── O3: proračun (config/voditelj-lanca.json) ──────────────────────────────

export interface PostavkeVoditelja {
  maxBudjenjaDan: number
  maxUsdDan: number
  maxTurns: number
  /** Rok jednog buđenja u minutama. */
  rokMin: number
  /** Najviše voditelja odjednom u cijelom sustavu (traka `voditeljSpawns`). */
  maxIstodobno: number
  /** Periodičko buđenje (samo ako ima posla). */
  intervalMin: number
  /** Odgoda nakon promjene otiska — otisak mora mirovati toliko prije buđenja. */
  odgodaMin: number
  /** ADR-0007: strop novih zadataka po buđenju. */
  maxNovihZadatakaBudjenje: number
  /** O4: reclaim po zadatku u 24 h. */
  maxReclaim24h: number
  spajanjeGrana: SpajanjeGrana
  /** D2: smije li voditelj pustiti `blok:kriticar` dok je criticRepairLoopLive=false. Goran 21.10. (#422): A = da, nakon dijagnoze. */
  pustiKriticar: boolean
}

export const ZADANE_POSTAVKE: PostavkeVoditelja = {
  maxBudjenjaDan: 24,
  maxUsdDan: 6,
  maxTurns: 40,
  rokMin: 15,
  maxIstodobno: 1,
  intervalMin: 20,
  odgodaMin: 2,
  maxNovihZadatakaBudjenje: 2,
  maxReclaim24h: 2,
  spajanjeGrana: 'sam',
  pustiKriticar: true,
}

export const putPostavki = () => join(KORIJEN, 'config', 'voditelj-lanca.json')

/** Uživo, bez keša. Svako polje se provjerava zasebno: kriva vrijednost = zadana, ne pad. */
export function citajPostavke(put: string = putPostavki()): PostavkeVoditelja {
  let sirovo: Record<string, unknown> = {}
  try { sirovo = JSON.parse(readFileSync(put, 'utf8')) || {} } catch { return { ...ZADANE_POSTAVKE } }
  const out: PostavkeVoditelja = { ...ZADANE_POSTAVKE }
  const brojevi: (keyof PostavkeVoditelja)[] = ['maxBudjenjaDan', 'maxUsdDan', 'maxTurns', 'rokMin', 'maxIstodobno',
    'intervalMin', 'odgodaMin', 'maxNovihZadatakaBudjenje', 'maxReclaim24h']
  for (const k of brojevi) {
    const v = sirovo[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (out as any)[k] = v
  }
  if (sirovo.spajanjeGrana === 'sam' || sirovo.spajanjeGrana === 'zadatak' || sirovo.spajanjeGrana === 'javi')
    out.spajanjeGrana = sirovo.spajanjeGrana
  if (typeof sirovo.pustiKriticar === 'boolean') out.pustiKriticar = sirovo.pustiKriticar
  return out
}

/** Prekidač iz features.json `voditeljLanca: {enabled, mode}`. Kvar/nepoznato = off; enabled bez moda = shadow. */
export function citajNacin(flag: { enabled?: unknown; mode?: unknown } | undefined | null): NacinVoditelja {
  if (!flag || flag.enabled !== true) return 'off'
  return flag.mode === 'on' ? 'on' : 'shadow'
}

/** Ograničenja jednog buđenja za spawn (V2). */
export function argumentiBudjenja(p: PostavkeVoditelja): { maxTurns: number; rokMs: number } {
  return { maxTurns: p.maxTurns, rokMs: p.rokMin * 60_000 }
}

// ─── Članovi lanca ──────────────────────────────────────────────────────────

export interface Clan {
  id: string
  title?: string
  status: string
  assignee?: string | null
  tags?: string[] | null
  blockedBy?: string[] | null
  blocks?: string[] | null
  blockedReason?: string | null
  description?: string | null
  projectId?: string | null
}

export const OZNAKA_VODITELJA = 'voditelj-lanca'
export const OZNAKA_BLOK_KRITICAR = 'blok:kriticar'
const ZAVRSENO = new Set(['completed', 'cancelled'])

const oznake = (c: Clan) => (c.tags || []).map(t => String(t))

/** Članovi = zadaci s oznakom `lanac:<x>` ili samom oznakom `<x>` (lanac-mac je tako označen); voditelj nije član. */
export function clanoviLanca(svi: Clan[], lanac: string): Clan[] {
  return svi
    .filter(c => oznake(c).some(t => t === lanac || t === `lanac:${lanac}`))
    .filter(c => !oznake(c).includes(OZNAKA_VODITELJA))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

/** „K7” iz naslova „Mac K7: …”; inače ID. */
export function kOznaka(c: Clan): string {
  const m = /\bK\d+[a-z]?(?:\+K\d+[a-z]?)*\b/.exec(c.title || '')
  return m ? m[0] : c.id
}

/**
 * O4: `no-watchdog` ili „radi isključivo Goran” — voditelj samo čita. Opis se gleda SAMO do zajedničkog
 * konteksta lanca (`=== …`): u lanac-mac SVAKI član ondje ima „GitHub push radi ISKLJUČIVO Goran”,
 * pa bi cijeli opis sve članove proglasio Goranovima i voditelj ne bi radio ništa.
 */
export function samoGoran(c: Clan): boolean {
  if (oznake(c).some(t => t.toLowerCase() === 'no-watchdog')) return true
  const vlastitiOpis = String(c.description || '').split(/^\s*===/m)[0]
  return /(radi\s+)?isklju[čc]ivo\s+goran|samo\s+goran\b|goran[- ]only/i.test(`${c.title || ''}\n${vlastitiOpis}`)
}

/** Svi prethodnici unutar `svi` su gotovi (prethodnik izvan popisa se ne zna → nije spreman). */
export function prethodniciGotovi(c: Clan, svi: Clan[]): boolean {
  const po = new Map(svi.map(x => [x.id, x]))
  return (c.blockedBy || []).every(id => { const p = po.get(id); return !!p && p.status === 'completed' })
}

// ─── Git: nespojene grane ───────────────────────────────────────────────────

export interface GranaInfo {
  taskId: string
  grana: string
  /** true = predak cilja; false = nespojena; null = git nije znao reći (ne tvrdimo ništa). */
  spojena: boolean | null
}

export type Pokreni = (args: string[], cwd: string) => { code: number; out: string }

export const gitPokreni: Pokreni = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
  return { code: typeof r.status === 'number' ? r.status : -1, out: String(r.stdout || '') }
}

/** Grane zadataka u stablu (`regoc/TASK-5655-jelena-…`, `zadatak/TASK-5656`) i jesu li predak cilja. */
export function graneLanca(stablo: string, taskIds: string[], cilj = 'main', run: Pokreni = gitPokreni): GranaInfo[] {
  const ref = run(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], stablo)
  if (ref.code !== 0) return []
  const out: GranaInfo[] = []
  for (const grana of ref.out.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (grana === cilj) continue
    const taskId = taskIds.find(id => new RegExp(`(^|[/_-])${id}($|[/_-])`).test(grana))
    if (!taskId) continue
    const r = run(['merge-base', '--is-ancestor', grana, cilj], stablo)
    out.push({ taskId, grana, spojena: r.code === 0 ? true : r.code === 1 ? false : null })
  }
  return out.sort((a, b) => a.grana.localeCompare(b.grana))
}

/** Nespojene grane SAMO `completed` članova — grana zadatka u radu je normalna. */
export function nespojeneGrane(clanovi: Clan[], grane: GranaInfo[]): GranaInfo[] {
  const gotovi = new Set(clanovi.filter(c => c.status === 'completed').map(c => c.id))
  return grane.filter(g => g.spojena === false && gotovi.has(g.taskId))
}

// ─── O2: otisak lanca ───────────────────────────────────────────────────────

export interface Otisak {
  hash: string
  nespojene: GranaInfo[]
  /** in_progress bez živog najma. */
  zaglavljeni: string[]
}

export function izracunajOtisak(clanovi: Clan[], grane: GranaInfo[], zivNajam: (taskId: string) => boolean): Otisak {
  const nespojene = nespojeneGrane(clanovi, grane)
  const zaglavljeni = clanovi.filter(c => c.status === 'in_progress' && !zivNajam(c.id)).map(c => c.id)
  const redovi = [
    ...clanovi.map(c => `${c.id}:${c.status}:${String(c.blockedReason || '').slice(0, 80)}`).sort(),
    ...nespojene.map(g => `grana:${g.grana}`).sort(),
    ...zaglavljeni.map(id => `zaglavljen:${id}`).sort(),
  ]
  return { hash: createHash('sha256').update(redovi.join('\n')).digest('hex').slice(0, 16), nespojene, zaglavljeni }
}

// ─── O4: razvrstavanje pada ─────────────────────────────────────────────────

export type VrstaPada = 'lazni' | 'stvarni'
/**
 * Kome ide uputa (Goran, uputa #422): `izvodjac` = stvarni pad u kodu zadatka; `kriticar` = uzrok je u
 * samom kritičaru (krivo stablo, okolina, krivo propisana provjera) → uputa onome tko popravlja kritičara,
 * NE izvođaču; `infra` = prolazno (rok, prekinut spawn, 401) → ponovni krug uz uputu „nije tvoj kvar”.
 */
export type AdresatPada = 'izvodjac' | 'kriticar' | 'infra'
export interface Pad { vrsta: VrstaPada; potpis: string; uzrok: string; adresat: AdresatPada }

/** Lažni padovi (infrastruktura, ne kod zadatka). Redoslijed = prednost. */
export const POTPISI_LAZNIH: { potpis: string; re: RegExp; uzrok: string; adresat: Exclude<AdresatPada, 'izvodjac'> }[] = [
  { potpis: 'krivo-stablo:filters', re: /filters did not match any test files/i, adresat: 'kriticar',
    uzrok: 'kritičar je pokrenuo provjere u krivom stablu (filters did not match any test files)' },
  { potpis: 'krivo-stablo', re: /krivo(m)?\s+stabl|wrong\s+(work)?tree|not a git repository|main stablu umjesto/i, adresat: 'kriticar',
    uzrok: 'provjere pokrenute u krivom stablu' },
  { potpis: 'disk', re: /ENOSPC|no space left on device|disk\s*\d+([.,]\d+)?\s*%\s*<|disk\s+(je\s+)?pun|pun\s+disk/i, adresat: 'kriticar',
    uzrok: 'pun disk (ENOSPC) — okolina kritičara' },
  { potpis: 'krivo-propisana-provjera', re: /command not found|unknown (command|option)|nepoznat\w* (naredb|opcij)|Script not found|error: Script/i, adresat: 'kriticar',
    uzrok: 'krivo propisana provjera (naredba ne postoji u stablu)' },
  { potpis: 'mjerila-401', re: /(HTTP|status|code|kod)\s*:?\s*401\b|\b401\s+(Unauthorized|Neovla)|\bUnauthorized\b/i, adresat: 'infra',
    uzrok: '401 pri dohvatu mjerila' },
  { potpis: 'prekinut-spawn', re: /SIGTERM|SIGKILL|exit\s+(code\s+)?(137|143)\b|prekinut\w*\s+spawn|spawn\w*\s+(je\s+)?prekinut|killed by signal/i, adresat: 'infra',
    uzrok: 'spawn je prekinut' },
  { potpis: 'rok', re: /timed?\s?out|ETIMEDOUT|istek(ao|nuo)?\s+rok|rok\w*\s+(je\s+)?istek|prekora[čc]en\w*\s+rok/i, adresat: 'infra',
    uzrok: 'istek roka' },
]

function normaliziraj(s: string): string {
  return s.toLowerCase()
    .replace(/\(krug \d+\/\d+\)/g, '')
    .replace(/task-\d+/g, 'task')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Lažni samo ako SVAKI dio pada (kritičar ih spaja s „ | ”) ima infra potpis — inače stvarni,
 * jer bi reclaim zadatka sa stvarnim padom samo vrtio kritičara. Prazan razlog = nema pada (null).
 */
export function razvrstajPad(blockedReason: string | null | undefined): Pad | null {
  const r = String(blockedReason || '').trim()
  if (!r) return null
  const dijelovi = r.split(/\s\|\s/).map(s => s.trim()).filter(Boolean)
  const nadjeni = dijelovi.map(d => POTPISI_LAZNIH.find(p => p.re.test(d)) || null)
  if (nadjeni.every(Boolean)) {
    const prvi = nadjeni[0]!
    const svi = [...new Set(nadjeni.map(n => n!.potpis))]
    // Ako je bilo koji dio u kritičaru, popravlja se kritičar (ponovni krug bi samo opet pao).
    const adresat = nadjeni.some(n => n!.adresat === 'kriticar') ? 'kriticar' : 'infra'
    return { vrsta: 'lazni', potpis: svi.join('+'), uzrok: prvi.uzrok, adresat }
  }
  const prviStvarni = dijelovi[nadjeni.findIndex(n => !n)]
  const bez = prviStvarni.replace(/^BLOCKED:\s*/i, '').replace(/^CRITIC_FAILED:\s*/i, '')
  const potpis = 'stvarni:' + createHash('sha256').update(normaliziraj(bez)).digest('hex').slice(0, 10)
  return { vrsta: 'stvarni', potpis, uzrok: bez.slice(0, 160), adresat: 'izvodjac' }
}

// ─── #422: revizija onoga što je kritičar napisao ───────────────────────────

export interface ProvjeraKriticara { naredba: string; izlaz: string }
export interface RevizijaKriticara {
  /** Provjere koje je kritičar pokrenuo i njihov izlaz (iz razloga pada i, ako ga ima, izvještaja). */
  provjere: ProvjeraKriticara[]
  /** Radna mapa u kojoj je kritičar vrtio provjere, ako ju je naveo. */
  cwd: string | null
  /** Datoteke spomenute u izlazu/naredbama — „gdje je problem”. */
  datoteke: string[]
  /** Uvodna rečenica kritičara (npr. „3 je palo (od 3)”). */
  sazetak: string
}

/**
 * Kritičar spaja padove s „ | ”; svaki dio je `task|test|doc <naredba>: <izlaz>`. Izvještaj (resultParsed /
 * zadnja bilješka kritičara) može dati cwd i više izlaza — V2 ga prosljeđuje kao `izvjestaj`.
 */
export function revidirajKriticara(blockedReason: string | null | undefined, izvjestaj = ''): RevizijaKriticara {
  const r = String(blockedReason || '').replace(/^BLOCKED:\s*/i, '').replace(/^CRITIC_FAILED:\s*/i, '')
  const sve = `${r}\n${izvjestaj}`
  const provjere: ProvjeraKriticara[] = []
  let sazetak = ''
  for (const dio of r.split(/\s\|\s/)) {
    const m = /(?:^|\.\s+|\s)(?:task|test|doc|naredba|provjera)\s+(.+?):\s+([\s\S]*)$/i.exec(dio)
    if (!m) { if (!sazetak) sazetak = dio.trim().slice(0, 200); continue }
    if (!sazetak) sazetak = dio.slice(0, m.index + (m[0].startsWith('.') ? 1 : 0)).trim().slice(0, 200)
    provjere.push({ naredba: m[1].trim(), izlaz: m[2].replace(/\s*\(kvar je[\s\S]*$/i, '').trim().slice(0, 400) })
  }
  const cwd = (/\bcwd\s*[=:]\s*([^\s,;)]+)/i.exec(sve) || /\bu stablu\s+([~/][^\s,;)]+)/i.exec(sve) || [])[1] || null
  const datoteke = [...new Set([...sve.matchAll(/[\w./-]+\.(?:test\.)?(?:ts|tsx|js|py|sh|json)\b/g)].map(x => x[0]))].slice(0, 8)
  return { provjere, cwd, datoteke, sazetak }
}

function opisProvjera(rev: RevizijaKriticara): string {
  const p = rev.provjere.length
    ? rev.provjere.map(x => `  • \`${x.naredba}\`${rev.cwd ? ` (cwd ${rev.cwd})` : ''} → ${x.izlaz || '(bez izlaza)'}`).join('\n')
    : '  • (kritičar nije naveo naredbe — vidi izvještaj kritičara)'
  return `Provjere koje je kritičar pokrenuo:\n${p}`
}

/** Konkretna uputa izvođaču: što kritičar traži, gdje je problem, kako riješiti. Krug ulazi u tekst → svaka je nova. */
export function uputaIzvodjacu(c: Clan, pad: Pad, rev: RevizijaKriticara, krug: number): string {
  const k = kOznaka(c)
  const gdje = rev.datoteke.length ? rev.datoteke.join(', ') : (rev.provjere[0]?.naredba || 'vidi izlaz')
  if (pad.adresat === 'infra') {
    return [`Voditelj lanca — revizija pada kritičara za ${k} (${c.id}), krug ${krug}.`,
      `Presuda: NIJE kvar tvog koda — ${pad.uzrok} (potpis ${pad.potpis}).`,
      opisProvjera(rev),
      `Što kritičar traži: da iste provjere prođu; pad je bio prolazan.`,
      `Kako riješiti: ne mijenjaj kod zbog ovog pada. Ponovno pokreni navedene provjere u svom radnom stablu i zalijepi stvarni izlaz u VERIFIKACIJU.`].join('\n')
  }
  return [`Voditelj lanca — revizija pada kritičara za ${k} (${c.id}), krug ${krug}.`,
    `Presuda: stvarni pad u kodu zadatka (potpis ${pad.potpis}).`,
    opisProvjera(rev),
    `Što kritičar traži: da gornje provjere prođu u tvom radnom stablu (iste naredbe, isti cwd).`,
    `Gdje je problem: ${gdje}. Prva greška: ${pad.uzrok}`,
    `Kako riješiti: pokreni točno te naredbe, popravi uzrok iz izlaza (ne mijenjaj test da bi prošao), pa izlaz zalijepi u VERIFIKACIJU.${krug > 1 ? ` Prethodni krug s istim nalazom NIJE riješio problem — kreni od prve greške gore, ne od prošlog pristupa.` : ''}`].join('\n')
}

/** Uputa onome tko popravlja kritičara (uzrok u kritičaru) — izvođač ne dira ništa. */
export function uputaPopravljacu(c: Clan, pad: Pad, rev: RevizijaKriticara, krug: number): string {
  const k = kOznaka(c)
  return [`Voditelj lanca — kritičar je oborio ${k} (${c.id}) zbog uzroka u SAMOM kritičaru, krug ${krug}.`,
    `Uzrok: ${pad.uzrok} (potpis ${pad.potpis}).`,
    opisProvjera(rev),
    `Što treba: popraviti kritičara (stablo/cwd provjera, okolina, propisana naredba) tako da iste provjere za ${c.id} vrti u radnom stablu zadatka.`,
    `Izvođač ${c.assignee || '—'} ne mijenja ništa; kad popravak bude completed, voditelj vraća ${c.id} kroz kritičara.`].join('\n')
}

// ─── O5: ključ pitanja ──────────────────────────────────────────────────────

export const kljucPitanja = (taskId: string, potpis: string) => `${taskId}|${potpis}`

/** Isti ključ se ne pita dvaput: ni dok je otvoren, ni nakon odgovora (dok se uzrok ne promijeni → novi ključ). */
export function smijePitati(s: StanjeVoditelja, kljuc: string): boolean {
  return !s.otvorenaPitanja[kljuc] && !s.odgovorenaPitanja[kljuc]
}

export function zabiljeziPitanje(s: StanjeVoditelja, kljuc: string, taskId: string): StanjeVoditelja {
  return { ...s, otvorenaPitanja: { ...s.otvorenaPitanja, [kljuc]: taskId } }
}

export function zabiljeziOdgovor(s: StanjeVoditelja, kljuc: string, odgovor: string): StanjeVoditelja {
  const otvorena = { ...s.otvorenaPitanja }
  delete otvorena[kljuc]
  return { ...s, otvorenaPitanja: otvorena, odgovorenaPitanja: { ...s.odgovorenaPitanja, [kljuc]: odgovor } }
}

// ─── O1: stanje na disku ────────────────────────────────────────────────────

export interface ZapisRadnje { taskId: string; vrsta: string; potpis?: string; ts: string }

export interface StanjeVoditelja {
  voditeljId: string
  lanac: string
  stablo: string
  projectId: string
  otisak: string | null
  /** Novi otisak koji čeka odgodu (O2: promjena + 2 min mira). */
  otisakKandidat: { hash: string; od: string } | null
  zadnjeBudjenje: string | null
  sljedeceBudjenje: string | null
  /** ključ pitanja → ID zadatka na kojem je postavljeno */
  otvorenaPitanja: Record<string, string>
  odgovorenaPitanja: Record<string, string>
  /** Brojači radnji po zadatku (reclaim ≤ 2/24 h); stariji od 48 h se režu. */
  radnje: ZapisRadnje[]
  /** potpis uzroka → ID zadatka popravka infrastrukture (jedan po potpisu). */
  infraZadaci: Record<string, string>
  /** ID zadatka → potpis stvarnog pada za koji je otvorena dorada. */
  dorade: Record<string, string>
  /** Redni broj zadnje zabilježene radnje — redoslijed uputa i povrata unutar istog buđenja. */
  seq: number
  /** Zadnji povrat člana iz blocked (reclaim) — za pravilo „isti nalaz ne vraća se bez nove upute”. */
  povrati: Record<string, { potpis: string; seq: number; ts: string }>
  /** Zadnja uputa O nalazu člana (izvođaču ili popravljaču kritičara). */
  upute: Record<string, { potpis: string; seq: number; ts: string; adresat: string; hash: string }>
  /** potpis → seq kad je otvoren zadatak popravka (povrat nakon toga = „popravak isproban”). */
  infraSeq: Record<string, number>
  /** grana → kad je (i kako) obrađena po D1. */
  grane: Record<string, string>
  /** ključ obavijesti (samo-Goran zadatak spreman) → kad je poslana. */
  obavijesti: Record<string, string>
  potrosnja: { dan: string; budjenja: number; usd: number }
}

export function novoStanje(a: { voditeljId: string; lanac: string; stablo: string; projectId: string }): StanjeVoditelja {
  return {
    ...a, otisak: null, otisakKandidat: null, zadnjeBudjenje: null, sljedeceBudjenje: null,
    otvorenaPitanja: {}, odgovorenaPitanja: {}, radnje: [], infraZadaci: {}, dorade: {}, grane: {}, obavijesti: {},
    seq: 0, povrati: {}, upute: {}, infraSeq: {},
    potrosnja: { dan: '', budjenja: 0, usd: 0 },
  }
}

export const mapaVoditelja = () => join(KORIJEN, 'data', 'voditelji')
const sigurnoIme = (id: string) => String(id).replace(/[^A-Za-z0-9_.-]/g, '-')
export const putStanja = (voditeljId: string, dir = mapaVoditelja()) => join(dir, `${sigurnoIme(voditeljId)}.json`)
export const putDnevnika = (voditeljId: string, dir = mapaVoditelja()) => join(dir, `${sigurnoIme(voditeljId)}.jsonl`)

/** null = nema datoteke; 'pokvaren' = postoji, ali nije čitljiv (pozivatelj ne smije pregaziti bez zapisa). */
export function citajStanje(voditeljId: string, dir = mapaVoditelja()): StanjeVoditelja | null | 'pokvaren' {
  const p = putStanja(voditeljId, dir)
  if (!existsSync(p)) return null
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'))
    if (!s || typeof s !== 'object' || s.voditeljId !== voditeljId) return 'pokvaren'
    // Polja dodana kasnije dobivaju zadane vrijednosti — stara datoteka ostaje čitljiva.
    return { ...novoStanje({ voditeljId, lanac: s.lanac || '', stablo: s.stablo || '', projectId: s.projectId || '' }), ...s }
  } catch { return 'pokvaren' }
}

export function zapisiStanje(s: StanjeVoditelja, dir = mapaVoditelja()): void {
  mkdirSync(dir, { recursive: true })
  const p = putStanja(s.voditeljId, dir)
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 1))
  renameSync(tmp, p)
}

export function dopisiDnevnik(voditeljId: string, zapis: Record<string, unknown>, dir = mapaVoditelja()): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(putDnevnika(voditeljId, dir), JSON.stringify({ ts: new Date().toISOString(), ...zapis }) + '\n')
}

// ─── O3: potrošnja dana ─────────────────────────────────────────────────────

/** Lokalni dan (ponoć po satu stroja — „do ponoći se radi samo predprolaz”). */
export function danKljuc(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function potrosnjaDanas(s: StanjeVoditelja, now: number) {
  return s.potrosnja.dan === danKljuc(now) ? s.potrosnja : { dan: danKljuc(now), budjenja: 0, usd: 0 }
}

/** null = ima proračuna; inače razlog. */
export function proracunIscrpljen(s: StanjeVoditelja, p: PostavkeVoditelja, now: number): string | null {
  const d = potrosnjaDanas(s, now)
  if (d.budjenja >= p.maxBudjenjaDan) return `${d.budjenja} buđenja danas ≥ ${p.maxBudjenjaDan}`
  if (d.usd >= p.maxUsdDan) return `$${d.usd.toFixed(2)} danas ≥ $${p.maxUsdDan}`
  return null
}

export function zabiljeziBudjenje(s: StanjeVoditelja, otisak: string, now: number, p: PostavkeVoditelja): StanjeVoditelja {
  const d = potrosnjaDanas(s, now)
  return {
    ...s, otisak, otisakKandidat: null,
    zadnjeBudjenje: new Date(now).toISOString(),
    sljedeceBudjenje: new Date(now + p.intervalMin * 60_000).toISOString(),
    potrosnja: { ...d, budjenja: d.budjenja + 1 },
  }
}

export function zabiljeziTrosak(s: StanjeVoditelja, usd: number, now: number): StanjeVoditelja {
  const d = potrosnjaDanas(s, now)
  return { ...s, potrosnja: { ...d, usd: d.usd + (Number.isFinite(usd) && usd > 0 ? usd : 0) } }
}

// ─── O2: procjena posla i predprolaz ────────────────────────────────────────

export interface Posao {
  /** Ima nešto za voditelja: blokiran ne-Goranov član s padom, nespojena grana, zaglavljen in_progress. */
  zaRad: { taskId: string; vrsta: 'pad' | 'grana' | 'zaglavljen' | 'bez-razloga'; opis: string }[]
  /** K-oznake članova koji čekaju samo Gorana (otvoreno pitanje, samo-Goran zadatak spreman). */
  cekaGorana: string[]
  /** K-oznake članova u radu (živi najam). */
  radi: string[]
  /** Čekaju prethodnika u lancu ili su u redu. */
  ceka: string[]
}

/**
 * N4 (TASK-5679): član čiji pad čeka zadatak popravka koji je voditelj SAM otvorio (još nije completed/cancelled),
 * a planer za njega nema što (lažni pad kritičara: uputa popravljaču već predana nakon zadnjeg povrata).
 * Vraća ID zadatka popravka ili null. Isti uvjet kao `planirajRadnje` — inače periodičko buđenje bez radnje.
 */
export function cekaPopravak(c: Clan, s: StanjeVoditelja, p: PostavkeVoditelja, now: number, statusZadatka?: (taskId: string) => string | undefined): string | null {
  const pad = razvrstajPad(c.blockedReason)
  const id = pad && pad.adresat !== 'izvodjac' && s.infraZadaci[pad.potpis]
  if (!pad || !id) return null
  const st = statusZadatka?.(id)
  if (st && ZAVRSENO.has(st)) return null
  if (pad.adresat === 'infra' && reclaimova24h(s, c.id, now, pad.potpis) < p.maxReclaim24h) return null
  if (pad.adresat === 'kriticar') {
    const u0 = s.upute[c.id]
    const zp = s.povrati[c.id]
    if (!(u0 && u0.adresat === id && u0.potpis === pad.potpis && (!zp || u0.seq > zp.seq))) return null
  }
  return id
}

export function procijeniPosao(clanovi: Clan[], otisak: Otisak, otvorenaPitanja: Record<string, string> = {}, popravak: (c: Clan) => string | null = () => null): Posao {
  const p: Posao = { zaRad: [], cekaGorana: [], radi: [], ceka: [] }
  const sPitanjem = new Set(Object.values(otvorenaPitanja))
  const zaglavljen = new Set(otisak.zaglavljeni)
  for (const c of clanovi) {
    const k = kOznaka(c)
    if (c.status === 'in_progress') {
      if (zaglavljen.has(c.id)) p.zaRad.push({ taskId: c.id, vrsta: 'zaglavljen', opis: `${k} in_progress bez živog najma` })
      else p.radi.push(k)
      continue
    }
    if (c.status !== 'blocked') { if (!ZAVRSENO.has(c.status)) p.ceka.push(k); continue }
    if (samoGoran(c)) { (prethodniciGotovi(c, clanovi) ? p.cekaGorana : p.ceka).push(k); continue }
    if (sPitanjem.has(c.id) || oznake(c).includes('needs-decision')) { p.cekaGorana.push(k); continue }
    const pop = popravak(c)
    if (pop) { p.ceka.push(`${k} (čeka popravak ${pop})`); continue }
    if (String(c.blockedReason || '').trim()) { p.zaRad.push({ taskId: c.id, vrsta: 'pad', opis: `${k} blokiran: ${String(c.blockedReason).slice(0, 80)}` }); continue }
    if (prethodniciGotovi(c, clanovi) && (c.blockedBy || []).length) {
      p.zaRad.push({ taskId: c.id, vrsta: 'bez-razloga', opis: `${k} blokiran bez razloga, prethodnici gotovi` }); continue
    }
    p.ceka.push(k)
  }
  for (const g of otisak.nespojene) p.zaRad.push({ taskId: g.taskId, vrsta: 'grana', opis: `grana ${g.grana} nije u main` })
  return p
}

export type KodPredprolaza =
  | 'iskljuceno' | 'kocnica'
  | 'otisak' | 'odgoda' | 'periodicki' | 'mirno-goran' | 'mirno' | 'rano'
  | 'proracun' | 'vrata' | 'istodobno'

export interface PredprolazUlaz {
  voditeljId: string
  nacin: NacinVoditelja
  kocnica: boolean
  /** Vrata autonomije puštaju nove spawnove (tjedni strop, razina). */
  vrataPustaju: boolean
  /** Koliko voditelja je sada budno (traka `voditeljSpawns`). */
  aktivnihVoditelja: number
  now: number
  postavke: PostavkeVoditelja
  stanje: StanjeVoditelja
  otisak: Otisak
  posao: Posao
}

export interface Predprolaz {
  budi: boolean
  kod: KodPredprolaza
  razlog: string
  /** Redak za dnevnik (💤 … kad se ne budi). */
  zapis: string
  /** U sjeni V2 samo bilježi odluku, ne budi model. */
  sjena: boolean
  /** Stanje nakon predprolaza (kandidat otiska). Buđenje se bilježi tek `zabiljeziBudjenje`. */
  stanje: StanjeVoditelja
}

/** O2 — deterministički, bez modela. Tablica: otisak (+odgoda) → da; periodički s poslom → da; čeka Gorana/radi → ne; kočnica/off → ne. */
export function predprolaz(u: PredprolazUlaz): Predprolaz {
  const { stanje: s, now, postavke: p, voditeljId: v } = u
  const sjena = u.nacin === 'shadow'
  const ne = (kod: KodPredprolaza, razlog: string, stanje = s, zapis = `💤 voditelj ${v}: ${razlog}`): Predprolaz =>
    ({ budi: false, kod, razlog, zapis, sjena, stanje })

  if (u.nacin === 'off') return ne('iskljuceno', 'voditeljLanca=off')
  if (u.kocnica) return ne('kocnica', 'ručna kočnica pritisnuta')

  let okidac: { kod: 'otisak' | 'periodicki'; razlog: string } | null = null
  let st = s
  const hash = u.otisak.hash
  if (hash !== s.otisak) {
    const kand = s.otisakKandidat
    if (kand && kand.hash === hash) {
      const proslo = now - Date.parse(kand.od)
      if (proslo >= p.odgodaMin * 60_000) okidac = { kod: 'otisak', razlog: `otisak promijenjen (${s.otisak || '—'} → ${hash})` }
    } else {
      st = { ...s, otisakKandidat: { hash, od: new Date(now).toISOString() } }
    }
    if (!okidac) {
      const od = Date.parse((st.otisakKandidat || { od: new Date(now).toISOString() }).od)
      const za = Math.max(0, Math.ceil((od + p.odgodaMin * 60_000 - now) / 1000))
      return ne('odgoda', `otisak promijenjen, čekam ${za} s mira`, st)
    }
  } else {
    const zadnje = s.zadnjeBudjenje ? Date.parse(s.zadnjeBudjenje) : 0
    if (now - zadnje < p.intervalMin * 60_000) return ne('rano', 'nema promjene, interval nije istekao')
    if (u.posao.zaRad.length) {
      okidac = { kod: 'periodicki', razlog: `periodički, ima posla: ${u.posao.zaRad.map(z => z.opis).join('; ')}` }
    } else if (u.posao.cekaGorana.length) {
      return ne('mirno-goran', `mirno (čeka Gorana: ${u.posao.cekaGorana.join(', ')})`)
    } else {
      const radi = u.posao.radi.length ? `radi: ${u.posao.radi.join(', ')}` : 'nema posla'
      return ne('mirno', `mirno (${radi})`)
    }
  }

  const proracun = proracunIscrpljen(st, p, now)
  if (proracun) return ne('proracun', `proračun dana iscrpljen (${proracun}) — do ponoći samo predprolaz`, st)
  if (!u.vrataPustaju) return ne('vrata', 'vrata autonomije ne puštaju nove spawnove', st)
  if (u.aktivnihVoditelja >= p.maxIstodobno) return ne('istodobno', `već budno ${u.aktivnihVoditelja} ≥ ${p.maxIstodobno} voditelja`, st)
  return { budi: true, kod: okidac.kod, razlog: okidac.razlog, zapis: `⏰ voditelj ${v}: ${okidac.razlog}`, sjena, stanje: st }
}

// ─── O4: plan radnji ────────────────────────────────────────────────────────

export type Radnja =
  | { vrsta: 'reclaim'; taskId: string; iz: 'blocked' | 'in_progress'; potpis: string; razlog: string }
  | { vrsta: 'zadatak-infra'; potpis: string; naslov: string; opis: string; assignee: 'jelena'; oZadatku?: string }
  | { vrsta: 'dorada'; taskId: string; potpis: string; assignee: string; razlog: string }
  | { vrsta: 'spoji-granu'; taskId: string; grana: string; nacin: SpajanjeGrana }
  | { vrsta: 'pitanje'; taskId: string; kljuc: string; ekspert: string; pitanje: string; opcije: string[]; preporuka: string }
  | { vrsta: 'obavijest-goran'; taskId: string; kljuc: string; tekst: string }
  | { vrsta: 'popravi-veze'; taskId: string; polje: 'blocks' | 'blockedBy'; nova: string[] }
  /** `taskId` = kome ide (član ili zadatak popravka kritičara); `oZadatku` = čiji je nalaz (član lanca). */
  | { vrsta: 'uputa'; taskId: string; tekst: string; oZadatku?: string; potpis?: string }

/** Jedine vrste radnji koje voditelj smije. Sve ostalo (PUT status, push, config, restart) se odbija. */
export const DOPUSTENE_RADNJE = ['reclaim', 'zadatak-infra', 'dorada', 'spoji-granu', 'pitanje', 'obavijest-goran', 'popravi-veze', 'uputa'] as const
const STVARAJU_ZADATAK = (r: Radnja) =>
  r.vrsta === 'zadatak-infra' || r.vrsta === 'dorada' || (r.vrsta === 'spoji-granu' && r.nacin === 'zadatak')

export interface PlanUlaz {
  voditeljId: string
  lanac: string
  projectId: string
  clanovi: Clan[]
  otisak: Otisak
  stanje: StanjeVoditelja
  postavke: PostavkeVoditelja
  now: number
  /** Status zadatka izvan lanca (zadatak popravka infrastrukture), npr. TASK-5674. */
  statusZadatka?: (taskId: string) => string | undefined
  /** Izvještaj kritičara po članu (resultParsed / zadnja bilješka) — za reviziju (#422). */
  izvjestajKriticara?: (taskId: string) => string | undefined
}

export interface Plan {
  radnje: Radnja[]
  preskoceno: { taskId?: string; razlog: string }[]
  noviZadataka: number
}

export function reclaimova24h(s: StanjeVoditelja, taskId: string, now: number, potpis?: string): number {
  return s.radnje.filter(r => r.vrsta === 'reclaim' && r.taskId === taskId && (!potpis || r.potpis === potpis)
    && now - Date.parse(r.ts) < 24 * 3600_000).length
}

const hashTeksta = (t: string) => createHash('sha256').update(t.trim()).digest('hex').slice(0, 16)

/** Provjera jedne radnje (O4 „ne smije”). Vraća razlog odbijanja ili null. */
export function provjeriRadnju(
  r: { vrsta: string; taskId?: string; potpis?: string } & Record<string, unknown>,
  clanovi: Clan[],
  stanje?: StanjeVoditelja,
): string | null {
  if (!(DOPUSTENE_RADNJE as readonly string[]).includes(r.vrsta)) return `radnja '${r.vrsta}' nije u ovlastima voditelja (O4)`
  if ('status' in r) return 'voditelj nikad ne postavlja status (ADR-0012: zatvara kritičar)'
  if (r.vrsta === 'zadatak-infra') return null
  // #422: uputa smije i zadatku popravka kritičara (izvan lanca), ali samo onom koji je voditelj sam otvorio.
  if (r.vrsta === 'uputa' && stanje && Object.values(stanje.infraZadaci).includes(String(r.taskId))) {
    return String(r.tekst || '').trim() ? null : 'uputa bez teksta'
  }
  const c = clanovi.find(x => x.id === r.taskId)
  if (!c) return `${r.taskId || '—'} nije član lanca — voditelj ne dira zadatke izvan lanca`
  if (samoGoran(c) && r.vrsta !== 'obavijest-goran') return `${c.id} radi isključivo Goran (no-watchdog) — samo čitanje`
  if (r.vrsta === 'popravi-veze') {
    // Radnju u V2 sastavlja model: polje je doslovni ključ PUT tijela, pa samo veze, nikad status/oznake.
    if (r.polje !== 'blocks' && r.polje !== 'blockedBy') return `popravi-veze: polje '${String(r.polje)}' nije blocks/blockedBy`
    if (!Array.isArray(r.nova) || !r.nova.every(x => typeof x === 'string')) return 'popravi-veze: nova mora biti popis ID-ova'
  }
  if (r.vrsta === 'uputa' && !String(r.tekst || '').trim()) return 'uputa bez teksta'
  if (r.vrsta === 'reclaim' && oznake(c).includes(OZNAKA_BLOK_KRITICAR) && !String(r.potpis || '').trim())
    return `${c.id} ima ${OZNAKA_BLOK_KRITICAR} — bez zapisane dijagnoze (potpis) nema puštanja`
  return null
}

function pitanjeKriticar(c: Clan, pad: Pad, kljuc: string): Radnja {
  return {
    vrsta: 'pitanje', taskId: c.id, kljuc,
    ekspert: 'operacije REGOČ-a (kritičar i infrastruktura provjera)',
    pitanje: `Objasni mi sa svog stručnog stajališta pad ${c.id} (${kOznaka(c)}) s potpisom „${pad.potpis}” (${pad.uzrok}) i pomozi mi da donesem odluku smije li voditelj lanca pustiti ${OZNAKA_BLOK_KRITICAR} dok je criticRepairLoopLive=false (ADR-0024 D2).`,
    opcije: [
      `A — reclaim nakon zapisane dijagnoze, ponovno kroz kritičara (najviše 2× u 24 h) — lanac nastavlja`,
      `B — ostaje blokiran do ručne odluke — lanac stoji iza ${kOznaka(c)}`,
    ],
    preporuka: 'A — pad je infrastrukturni, a reclaim ne zaobilazi kritičara (ADR-0012 vrijedi)',
  }
}

function pitanjeZapelo(c: Clan, pad: Pad, kljuc: string, n: number): Radnja {
  return {
    vrsta: 'pitanje', taskId: c.id, kljuc,
    ekspert: `inženjerstvo zadatka ${kOznaka(c)} (${c.assignee || '—'})`,
    pitanje: `Objasni mi sa svog stručnog stajališta zašto ${c.id} (${kOznaka(c)}) i nakon ${n} kruga s uputom pada na istom nalazu (${pad.uzrok}) i pomozi mi da donesem odluku kako dalje.`,
    opcije: [
      `A — dorada drugom izvršitelju s revizijom kritičara — svjež pogled, lanac nastavlja`,
      `B — ostaje blokiran dok ne pogledaš sam — lanac stoji iza ${kOznaka(c)}`,
    ],
    preporuka: 'A — isti izvršitelj je dvaput dobio konkretnu uputu i nije riješio isti nalaz',
  }
}

function pitanjePopravakKriticara(c: Clan, pad: Pad, kljuc: string, n: number, zadnjiPopravak?: string): Radnja {
  return {
    vrsta: 'pitanje', taskId: c.id, kljuc,
    ekspert: 'operacije REGOČ-a (kritičar i infrastruktura provjera)',
    pitanje: `Objasni mi sa svog stručnog stajališta zašto se lažni pad ${c.id} (${kOznaka(c)}) s potpisom „${pad.potpis}” (${pad.uzrok}) vraća i nakon ${n} povrata uz popravak kritičara${zadnjiPopravak ? ` (zadnji ${zadnjiPopravak})` : ''} u 24 h i pomozi mi da donesem odluku kako dalje (ADR-0024 D2).`,
    opcije: [
      `A — popravak kritičara preuzima čovjek; ${kOznaka(c)} ostaje blokiran dok to ne javiš — bez novih krugova`,
      `B — još jedan krug popravka i povrata nakon 24 h — lanac čeka, trošak još jednog kruga`,
    ],
    preporuka: `A — ${n} popravka istog potpisa nisu riješila pad; novi krug bi ponovio isto`,
  }
}

/** Uputa O nalazu člana izdana nakon njegova zadnjeg povrata (u stanju ili ranije u istom planu)? */
function imaNovuUputu(s: StanjeVoditelja, taskId: string, prije: Radnja[]): boolean {
  if (prije.some(r => r.vrsta === 'uputa' && (r.oZadatku || r.taskId) === taskId)) return true
  const u = s.upute[taskId]
  const p = s.povrati[taskId]
  return !!u && (!p || u.seq > p.seq)
}

/**
 * Provjera cijelog plana redom (i plana koji sastavi model u V2): svaka radnja kroz `provjeriRadnju`,
 * strop novih zadataka (ADR-0007) i #422 — povrat iz blocked samo uz NOVU uputu o tom nalazu, a ista
 * uputa (isti tekst) dvaput zaredom za isti nalaz ne vrijedi kao nova.
 */
export function provjeriPlan(kandidati: Radnja[], u: Pick<PlanUlaz, 'clanovi' | 'stanje' | 'postavke'>): Plan {
  const { clanovi, stanje: s, postavke: p } = u
  const radnje: Radnja[] = []
  const preskoceno: Plan['preskoceno'] = []
  let novi = 0
  for (const r of kandidati) {
    const taskId = (r as any).taskId as string | undefined
    const ne = provjeriRadnju(r as any, clanovi, s)
    if (ne) { preskoceno.push({ taskId, razlog: ne }); continue }
    if (r.vrsta === 'uputa') {
      const o = r.oZadatku || r.taskId
      const prosla = s.upute[o]
      if (prosla && prosla.hash === hashTeksta(r.tekst)) {
        preskoceno.push({ taskId: o, razlog: `ista uputa kao prošli put za ${o} — nije nova (#422)` }); continue
      }
    }
    if (r.vrsta === 'reclaim' && r.iz === 'blocked' && !imaNovuUputu(s, r.taskId, radnje)) {
      preskoceno.push({ taskId: r.taskId, razlog: `povrat ${r.taskId} bez nove upute o nalazu — odbijeno (#422)` }); continue
    }
    if (STVARAJU_ZADATAK(r)) {
      if (novi >= p.maxNovihZadatakaBudjenje) {
        preskoceno.push({ taskId, razlog: `strop ${p.maxNovihZadatakaBudjenje} nova zadatka po buđenju (ADR-0007) — ${r.vrsta} ide u sljedeće buđenje` })
        continue
      }
      novi++
    }
    radnje.push(r)
  }
  return { radnje, preskoceno, noviZadataka: novi }
}

// ─── D1-A: lokalno spajanje grane ───────────────────────────────────────────

export interface KorakSpajanja { opis: string; gdje: 'stablo' | 'proba'; naredba: string[] }

/**
 * D1-A: merge i testovi se rade u PRIVREMENOM worktreeju (`proba`); `main` u stablu pomiče se tek
 * `--ff-only` na provjereni commit. Neuspjeh bilo kojeg koraka = ukloni probu, `main` ostaje netaknut,
 * a grana ide kao D1-B (`nakonNeuspjehaSpajanja`). Nikad push, nikad prepisivanje povijesti.
 */
export function koraciSpajanja(grana: string, proba: string, cilj = 'main', testovi: string[] = ['bun', 'test']): KorakSpajanja[] {
  const pg = `voditelj/proba-${grana.replace(/[^A-Za-z0-9_.-]/g, '-')}`
  // N1 (TASK-5679): `merge --ff-only` pomiče granu na kojoj je stablo — smije samo kad je to cilj i stablo je čisto
  // (inače bi pomaknuo tuđu granu). Provjera i na početku (bez probe i testova uzalud) i neposredno prije pomaka.
  const naCiljuCisto: KorakSpajanja = { opis: `stablo je na ${cilj} i čisto (inače D1-B)`, gdje: 'stablo', naredba: ['sh', '-c',
    'test "$(git symbolic-ref -q HEAD)" = "refs/heads/$1" && test -z "$(git status --porcelain --untracked-files=no)"', 'sh', cilj] }
  return [
    naCiljuCisto,
    { opis: 'proba: privremeni worktree i grana na cilju', gdje: 'stablo', naredba: ['git', 'worktree', 'add', '-b', pg, proba, cilj] },
    { opis: 'čist merge (sukob = neuspjeh, bez auto-rješavanja)', gdje: 'proba', naredba: ['git', 'merge', '--no-ff', '--no-edit', grana] },
    { opis: 'zeleni testovi nakon spajanja', gdje: 'proba', naredba: testovi },
    naCiljuCisto,
    { opis: `${cilj} samo naprijed na provjereni commit`, gdje: 'stablo', naredba: ['git', 'merge', '--ff-only', pg] },
    { opis: 'potvrda: grana je predak cilja', gdje: 'stablo', naredba: ['git', 'merge-base', '--is-ancestor', grana, cilj] },
    { opis: 'ukloni probu', gdje: 'stablo', naredba: ['git', 'worktree', 'remove', '--force', proba] },
    { opis: 'ukloni granu probe (spojena)', gdje: 'stablo', naredba: ['git', 'branch', '-d', pg] },
  ]
}
/** Pri neuspjehu: ukloni probu i njezinu granu (nespojenu) — cilj nije ni dirnut. */
export function odustaniOdSpajanja(grana: string, proba: string): string[][] {
  const pg = `voditelj/proba-${grana.replace(/[^A-Za-z0-9_.-]/g, '-')}`
  return [['git', 'worktree', 'remove', '--force', proba], ['git', 'branch', '-D', pg]]
}

export function nakonNeuspjehaSpajanja(r: Extract<Radnja, { vrsta: 'spoji-granu' }>): Radnja {
  return { ...r, nacin: 'zadatak' }
}

/** O4 + #422 — što voditelj smije napraviti u ovom buđenju. Model (V2) bira među ovim radnjama; ništa izvan njih. */
export function planirajRadnje(u: PlanUlaz): Plan {
  const { clanovi, stanje: s, postavke: p, now } = u
  const kand: Radnja[] = []
  const preskoceno: Plan['preskoceno'] = []
  const infraOvoBudjenje = new Set<string>()
  const infraStatus = (potpis: string): { id: string; gotov: boolean } | null => {
    const id = s.infraZadaci[potpis]
    if (!id) return null
    const st = u.statusZadatka?.(id)
    return { id, gotov: !!st && ZAVRSENO.has(st) }
  }
  const noviInfra = (c: Clan, pad: Pad, naslov: string, opis: string): boolean => {
    if (infraOvoBudjenje.has(pad.potpis)) { preskoceno.push({ taskId: c.id, razlog: `zadatak popravka za ${pad.potpis} već u planu` }); return false }
    infraOvoBudjenje.add(pad.potpis)
    kand.push({ vrsta: 'zadatak-infra', potpis: pad.potpis, assignee: 'jelena', oZadatku: c.id, naslov, opis })
    return true
  }

  for (const c of clanovi) {
    const k = kOznaka(c)
    if (samoGoran(c)) {
      // O5 (V3/TASK-5678): spreman = prethodnici gotovi I sve grane lanca u main (K7 gura cijeli paket).
      if (!ZAVRSENO.has(c.status) && prethodniciGotovi(c, clanovi) && u.otisak.nespojene.length === 0) {
        const kljuc = `${c.id}|spreman`
        if (!s.obavijesti[kljuc]) kand.push({ vrsta: 'obavijest-goran', taskId: c.id, kljuc,
          tekst: `${k} (${c.id}) je spreman za tebe: prethodnici su gotovi. ${c.title || ''}`.trim() })
      }
      preskoceno.push({ taskId: c.id, razlog: `${k} radi isključivo Goran (no-watchdog) — samo čitanje` })
      continue
    }

    if (c.status === 'blocked') {
      const pad = razvrstajPad(c.blockedReason)
      if (!pad) continue // čeka prethodnika ili model dijagnosticira (procijeniPosao: bez-razloga)
      const rev = revidirajKriticara(c.blockedReason, u.izvjestajKriticara?.(c.id) || '')
      const zadnjiPovrat = s.povrati[c.id]
      const krug = reclaimova24h(s, c.id, now, pad.potpis) + 1

      if (pad.adresat === 'kriticar') {
        // Uzrok u kritičaru: uputa ide popravljaču kritičara, izvođač ne dobiva ništa (#422).
        const infra = infraStatus(pad.potpis)
        if (infra && !infra.gotov) {
          const u0 = s.upute[c.id]
          if (u0 && u0.adresat === infra.id && u0.potpis === pad.potpis && (!zadnjiPovrat || u0.seq > zadnjiPovrat.seq)) {
            preskoceno.push({ taskId: c.id, razlog: `lažni pad (${pad.potpis}) — čekam popravak kritičara ${infra.id}, uputa već predana` })
          } else {
            kand.push({ vrsta: 'uputa', taskId: infra.id, oZadatku: c.id, potpis: pad.potpis, tekst: uputaPopravljacu(c, pad, rev, krug) })
            preskoceno.push({ taskId: c.id, razlog: `lažni pad (${pad.potpis}) — čekam popravak kritičara ${infra.id}` })
          }
          continue
        }
        // N2 (TASK-5679): isti strop kao prolazni pad (D2: ≤ maxReclaim24h u 24 h) — nakon toliko popravaka
        // istog potpisa koji nisu riješili pad: pitanje Goranu (O5) umjesto novog popravka i povrata.
        if (reclaimova24h(s, c.id, now, pad.potpis) >= p.maxReclaim24h) {
          const kljuc = kljucPitanja(c.id, pad.potpis)
          if (smijePitati(s, kljuc)) kand.push(pitanjePopravakKriticara(c, pad, kljuc, p.maxReclaim24h, infra?.id))
          else preskoceno.push({ taskId: c.id, razlog: `pitanje ${kljuc} već postavljeno — ne ponavljam (O5)` })
          continue
        }
        const popravakIsproban = !!infra && !!zadnjiPovrat && zadnjiPovrat.seq > (s.infraSeq[pad.potpis] ?? -1)
        if (!infra || popravakIsproban) {
          noviInfra(c, pad, `Popravak kritičara: ${pad.potpis} (lanac ${u.lanac}, ${k})`,
            `${uputaPopravljacu(c, pad, rev, krug)}${popravakIsproban ? `\n\nPrethodni popravak ${infra!.id} je completed, a isti nalaz se ponovio nakon povrata.` : ''}\n\nRazlog pada (doslovno):\n${String(c.blockedReason).slice(0, 800)}`)
          continue
        }
        // Popravak je gotov, a član još nije vraćen nakon njega → povrat kroz kritičara (uputa je otišla popravljaču).
      } else if (reclaimova24h(s, c.id, now, pad.potpis) >= p.maxReclaim24h) {
        if (pad.adresat === 'infra') {
          const infra = infraStatus(pad.potpis)
          if (infra && !infra.gotov) { preskoceno.push({ taskId: c.id, razlog: `prolazni pad (${pad.potpis}) — čekam popravak ${infra.id}` }); continue }
          noviInfra(c, pad, `Popravak infrastrukture: ${pad.potpis} (lanac ${u.lanac})`,
            `Isti prolazni pad „${pad.potpis}” (${pad.uzrok}) ponovio se ${p.maxReclaim24h}× u 24 h na ${c.id} (${k}). Ne vraćam ga više kritičaru dok uzrok nije popravljen.\n\n${opisProvjera(rev)}\n\nZadnji razlog:\n${String(c.blockedReason).slice(0, 800)}`)
        } else {
          const kljuc = kljucPitanja(c.id, pad.potpis)
          if (smijePitati(s, kljuc)) kand.push(pitanjeZapelo(c, pad, kljuc, p.maxReclaim24h))
          else preskoceno.push({ taskId: c.id, razlog: `pitanje ${kljuc} već postavljeno — ne ponavljam (O5)` })
        }
        continue
      }

      if (oznake(c).includes(OZNAKA_BLOK_KRITICAR) && !p.pustiKriticar) {
        const kljuc = kljucPitanja(c.id, pad.potpis)
        if (smijePitati(s, kljuc)) kand.push(pitanjeKriticar(c, pad, kljuc))
        else preskoceno.push({ taskId: c.id, razlog: `pitanje ${kljuc} već postavljeno — ne ponavljam (O5)` })
        continue
      }
      // Izvođaču konkretna uputa PRIJE povrata (#422) — osim kad je uzrok bio u kritičaru (uputa je otišla popravljaču).
      if (pad.adresat !== 'kriticar') kand.push({ vrsta: 'uputa', taskId: c.id, oZadatku: c.id, potpis: pad.potpis, tekst: uputaIzvodjacu(c, pad, rev, krug) })
      kand.push({ vrsta: 'reclaim', taskId: c.id, iz: 'blocked', potpis: pad.potpis,
        razlog: `voditelj-lanca: ${pad.vrsta === 'stvarni' ? 'stvarni' : 'lažni'} pad ${k} (${pad.potpis}) — ${pad.uzrok}; revizija kritičara i uputa predani (krug ${krug})` })
      continue
    }

    if (c.status === 'in_progress' && u.otisak.zaglavljeni.includes(c.id)) {
      if (reclaimova24h(s, c.id, now) >= p.maxReclaim24h) { preskoceno.push({ taskId: c.id, razlog: `${p.maxReclaim24h} reclaima u 24 h — dalje model/čovjek` }); continue }
      kand.push({ vrsta: 'reclaim', taskId: c.id, iz: 'in_progress', potpis: 'zaglavljen', razlog: `voditelj-lanca: ${k} in_progress bez živog najma` })
    }
  }

  // D1: nespojene grane completed članova.
  for (const g of u.otisak.nespojene) {
    if (s.grane[g.grana]) { preskoceno.push({ taskId: g.taskId, razlog: `grana ${g.grana} već obrađena (${s.grane[g.grana]})` }); continue }
    kand.push({ vrsta: 'spoji-granu', taskId: g.taskId, grana: g.grana, nacin: p.spajanjeGrana })
  }

  // Reciprocitet blockedBy/blocks (samo gdje ovisni član još nije gotov).
  const po = new Map(clanovi.map(c => [c.id, c]))
  for (const c of clanovi) {
    if (ZAVRSENO.has(c.status)) continue
    for (const pid of c.blockedBy || []) {
      const pr = po.get(pid)
      if (pr && !(pr.blocks || []).includes(c.id)) kand.push({ vrsta: 'popravi-veze', taskId: pr.id, polje: 'blocks', nova: [...(pr.blocks || []), c.id] })
    }
    for (const pr of clanovi) {
      if (pr.id !== c.id && (pr.blocks || []).includes(c.id) && !(c.blockedBy || []).includes(pr.id))
        kand.push({ vrsta: 'popravi-veze', taskId: c.id, polje: 'blockedBy', nova: [...(c.blockedBy || []), pr.id] })
    }
  }

  const plan = provjeriPlan(kand, u)
  return { ...plan, preskoceno: [...preskoceno, ...plan.preskoceno] }
}

/** Upis izvedenih radnji u stanje (brojači 24 h, povrati/upute po seq, dorade, grane, pitanja, obavijesti). */
export function zabiljeziRadnje(s: StanjeVoditelja, radnje: Radnja[], now: number, noviId: Record<string, string> = {}): StanjeVoditelja {
  const ts = new Date(now).toISOString()
  const o: StanjeVoditelja = {
    ...s, radnje: s.radnje.filter(r => now - Date.parse(r.ts) < 48 * 3600_000),
    dorade: { ...s.dorade }, grane: { ...s.grane }, obavijesti: { ...s.obavijesti },
    infraZadaci: { ...s.infraZadaci }, otvorenaPitanja: { ...s.otvorenaPitanja },
    povrati: { ...s.povrati }, upute: { ...s.upute }, infraSeq: { ...s.infraSeq }, seq: s.seq || 0,
  }
  for (const r of radnje) {
    const seq = ++o.seq
    const taskId = 'taskId' in r ? r.taskId : ''
    o.radnje.push({ taskId, vrsta: r.vrsta, potpis: 'potpis' in r ? r.potpis : undefined, ts })
    if (r.vrsta === 'reclaim' && r.iz === 'blocked') o.povrati[r.taskId] = { potpis: r.potpis, seq, ts }
    if (r.vrsta === 'uputa') o.upute[r.oZadatku || r.taskId] = { potpis: r.potpis || '', seq, ts, adresat: r.taskId, hash: hashTeksta(r.tekst) }
    if (r.vrsta === 'dorada') o.dorade[r.taskId] = r.potpis
    if (r.vrsta === 'spoji-granu') o.grane[r.grana] = `${r.nacin} ${ts}`
    if (r.vrsta === 'obavijest-goran') o.obavijesti[r.kljuc] = ts
    if (r.vrsta === 'pitanje') o.otvorenaPitanja[r.kljuc] = r.taskId
    if (r.vrsta === 'zadatak-infra') {
      o.infraSeq[r.potpis] = seq
      const id = noviId[r.potpis]
      if (id) {
        o.infraZadaci[r.potpis] = id
        // Opis zadatka popravka JE uputa popravljaču o nalazu člana.
        if (r.oZadatku) o.upute[r.oZadatku] = { potpis: r.potpis, seq, ts, adresat: id, hash: hashTeksta(r.opis) }
      }
    }
  }
  return o
}

// ─── Radnja → poziv ploče (V2 izvodi; ovdje se jamči da nijedan poziv ne dira status) ─

export interface Zahtjev { metoda: 'POST' | 'PUT'; put: string; tijelo: Record<string, unknown> }

/** null = radnja nije poziv ploče (lokalni git po D1-A, Telegram obavijest). */
export function uZahtjev(r: Radnja, ctx: { voditeljId: string; lanac: string; projectId: string }): Zahtjev | null {
  const t = (id: string) => `/api/tasks/${encodeURIComponent(id)}`
  const oznakeNovog = [`lanac:${ctx.lanac}`, `voditelj:${ctx.voditeljId}`]
  switch (r.vrsta) {
    case 'reclaim':
      return { metoda: 'POST', put: `${t(r.taskId)}/reclaim`, tijelo: { from: r.iz, by: OZNAKA_VODITELJA, reason: r.razlog } }
    case 'zadatak-infra':
      return { metoda: 'POST', put: '/api/tasks', tijelo: { title: r.naslov, description: r.opis, assignee: r.assignee,
        projectId: ctx.projectId, tags: [...oznakeNovog, 'popravak-infra', `potpis:${r.potpis}`] } }
    case 'dorada':
      return { metoda: 'POST', put: `${t(r.taskId)}/dorada`, tijelo: { razlog: r.razlog, author: OZNAKA_VODITELJA, assignee: r.assignee, tags: oznakeNovog } }
    case 'spoji-granu':
      if (r.nacin !== 'zadatak') return null
      return { metoda: 'POST', put: '/api/tasks', tijelo: {
        title: `Spoji granu ${r.grana} u main (${r.taskId}, lanac ${ctx.lanac})`,
        description: `Član ${r.taskId} je completed, a grana ${r.grana} nije predak main (git merge-base --is-ancestor). Spoji čisto nakon zelenih testova u stablu; bez push-a (ADR-0024 D1-B).`,
        assignee: 'jelena', projectId: ctx.projectId, tags: [...oznakeNovog, 'spoji-granu'] } }
    case 'pitanje':
      return { metoda: 'POST', put: `${t(r.taskId)}/pitanje`, tijelo: { ekspert: r.ekspert, pitanje: r.pitanje, opcije: r.opcije, preporuka: r.preporuka } }
    case 'popravi-veze':
      if (r.polje === 'blocks') return { metoda: 'PUT', put: t(r.taskId), tijelo: { blocks: r.nova } }
      if (r.polje === 'blockedBy') return { metoda: 'PUT', put: t(r.taskId), tijelo: { blockedBy: r.nova } }
      throw new Error(`popravi-veze: nedopušteno polje '${String(r.polje)}'`)
    case 'uputa':
      return { metoda: 'POST', put: `${t(r.taskId)}/uputa`, tijelo: { text: r.tekst, author: OZNAKA_VODITELJA } }
    case 'obavijest-goran':
      return null
  }
}
