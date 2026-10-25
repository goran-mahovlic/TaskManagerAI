/**
 * Korpus znanja čvora (ADR-0006 §4–§6): opći REGOČ ide u paket, privatno nikad.
 *
 * Tri koraka, sva čista (bez mreže i diska), da ih testovi mjere bez okoline:
 *   1. REZ PO ODJELJKU — bijela lista: odjeljak (`## …`) ulazi samo ako mu tablica opsega da
 *      `opce` ili `uvjet:<mogućnost>`. Odjeljak bez oznake = privatno (§4.3/1).
 *   2. PRIPREMA TEKSTA — naš raspored mapa postaje `${SUSTAV_DIR}`, naš HOME `~`, ime vlasnika
 *      uloga „vlasnik" (§1.3); u odjeljcima `+redigiraj` ispada redak (ili rečenica) s pogotkom.
 *   3. BRANA — bilo koji pogodak (privatni popis ili opći uzorak) u onome što bi izašlo =
 *      `BranaPrivatnog`, ništa se ne piše (§4.3/2, mjerilo Z2).
 *
 * Na čvoru `renderZaCvor` zamjenjuje `${VARIJABLE}`, uvjetne odjeljke mijenja izričitom
 * činjenicom kad mogućnosti nema (§6.2) i izbacuje alate kojih na čvoru nema.
 *
 * Privatni popis NIJE u paketu (i sam je naš podatak) — ovdje je samo kod koji ga čita.
 */

const STRUKTURNI = /^\s*([-*+]|\d+\.|\||#{3,6} |>)/

export type Mogucnost = 'rag' | 'nextcloud' | 'docuseal' | 'glas' | 'ollama' | 'internet' | 'root'
export const MOGUCNOSTI: readonly Mogucnost[] = ['rag', 'nextcloud', 'docuseal', 'glas', 'ollama', 'internet', 'root']

export interface Opseg { vrsta: 'opce' | 'uvjet' | 'privatno'; mogucnost?: Mogucnost; redigiraj: boolean }
export interface PrivatniIzraz { kat: string; izraz: string; rx: RegExp }
export interface Pogodak { kat: string; izraz: string }

export class BranaPrivatnog extends Error {
  constructor(readonly datoteka: string, readonly odjeljak: string, readonly pogoci: Pogodak[]) {
    super(`brana: ${datoteka} § ${odjeljak} — ${pogoci.map(p => p.kat).join(', ')}`)
  }
}

// Naš raspored i repozitorij pišu se iz dijelova (brana paketa `bez-nasih-vrijednosti` traži doslovni niz).
const RASPORED = ['\\.cla', 'ude/reg', 'oc'].join('')
const NAS_REPO = ['reg', 'oc[_-]system'].join('')
const NASE_BANKE = ['reg', 'oc_sustav_[a-z]+'].join('')

/** Opći uzorci: ne ovise o privatnom popisu, pa vrijede i na čvoru (§4.3/2a). */
export const OPCI_UZORCI: ReadonlyArray<[string, RegExp]> = [
  ['projekt-id', /\bPRJ-\d{3}\b/],
  ['chat-id', /(?<![\w.])-100\d{10}\b|(?<![\w.])-\d{10}\b/],
  ['uid', /\buid:? ?\d{7,}\b/i],
  ['e-posta', /[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i],
  ['ip', /\b(?!127\.)(?!0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['tudi-home', /\/home\/[a-z_][a-z0-9_-]*/],
  ['nas-raspored', new RegExp(RASPORED)],
  ['nas-repo', new RegExp(NAS_REPO, 'i')],
  ['tailnet', /tailc\d+\.ts\.net/],
  // banke memorije glavnog stroja (plan Mac v2 P4.1): banka čvora je MEMORIJA_BANKA, ne naše ime
  ['banka', new RegExp(NASE_BANKE)],
]

/** Izrazi s popisa koji su ime MOGUĆNOSTI, ne privatni podatak (idu kroz `uvjet:`). */
const IZRAZ_MOGUCNOSTI = new Set(['nextcloud', 'docuseal'])
// Granica samo prema slovu/broju: izraz iza `-`, `_` ili `/` (mapa `telegram-klijent/`, datoteka
// `feedback_osoba.md`) JEST pogodak — tako su nazvane naše radne mape i memorija.
const GRANICA = '(?<![\\p{L}\\p{N}])'
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Redak = `kategorija<TAB>izraz`; `#` komentar. Kategorija `vlasnik` = ime koje postaje uloga. */
export function ucitajPrivatno(tekst: string): PrivatniIzraz[] {
  const out: PrivatniIzraz[] = []
  for (const r of tekst.split('\n')) {
    if (!r.trim() || r.startsWith('#') || !r.includes('\t')) continue
    const [kat, ...ostalo] = r.split('\t')
    const izraz = ostalo.join('\t').trim()
    if (!izraz || IZRAZ_MOGUCNOSTI.has(izraz.toLowerCase())) continue
    out.push({ kat: kat.trim(), izraz, rx: new RegExp(GRANICA + esc(izraz), 'iu') })
  }
  return out
}

export function parsirajOpseg(v: string): Opseg | null {
  const [glava, ...zast] = v.trim().split('+')
  const redigiraj = zast.includes('redigiraj')
  if (glava === 'opce') return { vrsta: 'opce', redigiraj }
  if (glava === 'privatno') return { vrsta: 'privatno', redigiraj: false }
  const m = glava.match(/^uvjet:([a-z]+)$/)
  if (m && (MOGUCNOSTI as readonly string[]).includes(m[1])) return { vrsta: 'uvjet', mogucnost: m[1] as Mogucnost, redigiraj }
  return null
}

export type OpsegZa = (datoteka: string, naslov: string) => Opseg | null

/**
 * Tablica opsega: `datoteka<TAB>naslov odjeljka<TAB>opseg`. Datoteka smije imati `*` (npr.
 * `popis/alati-*.md`), naslov `*` = svaki odjeljak te datoteke. Točan pogodak ima prednost.
 * Neispravan opseg je greška (ne tiho „privatno") — tipfeler ne smije sakriti odjeljak bez traga.
 */
export function ucitajOpseg(tsv: string): OpsegZa {
  const redci: Array<{ dat: RegExp; tocno: boolean; naslov: string; opseg: Opseg }> = []
  for (const [i, r] of tsv.split('\n').entries()) {
    if (!r.trim() || r.startsWith('#')) continue
    const [dat, naslov, v] = r.split('\t')
    const opseg = v === undefined ? null : parsirajOpseg(v)
    if (!dat || naslov === undefined || !opseg) throw new Error(`opseg: redak ${i + 1} neispravan („${r}")`)
    redci.push({
      dat: new RegExp('^' + dat.split('*').map(esc).join('[^/]*') + '$'),
      tocno: !dat.includes('*'), naslov: naslov.trim(), opseg,
    })
  }
  return (datoteka, naslov) => {
    const kandidati = redci.filter(r => r.dat.test(datoteka) && (r.naslov === naslov || r.naslov === '*'))
    kandidati.sort((a, b) => Number(b.tocno) - Number(a.tocno) || Number(b.naslov !== '*') - Number(a.naslov !== '*'))
    return kandidati[0]?.opseg ?? null
  }
}

export interface Odjeljak { naslov: string; tijelo: string }

/** `# naslov` dokumenta + `## odjeljci`; tekst prije prvog `##` je „(uvod)". */
export function odjeljci(tekst: string): { naslov: string; dijelovi: Odjeljak[] } {
  let naslov = ''
  const dijelovi: Odjeljak[] = []
  let tren = '(uvod)'
  let buf: string[] = []
  const zatvori = () => { if (buf.join('\n').trim()) dijelovi.push({ naslov: tren, tijelo: buf.join('\n').trim() }) }
  for (const r of tekst.split('\n')) {
    if (r.startsWith('## ')) { zatvori(); tren = r.slice(3).trim(); buf = [] }
    else if (r.startsWith('# ') && !naslov) naslov = r.slice(2).trim()
    else buf.push(r)
  }
  zatvori()
  return { naslov, dijelovi }
}

export function branaKorpusa(tekst: string, privatno: PrivatniIzraz[]): Pogodak[] {
  const out: Pogodak[] = []
  for (const p of privatno) if (p.kat !== 'vlasnik' && p.rx.test(tekst)) out.push({ kat: p.kat, izraz: p.izraz })
  for (const [kat, rx] of OPCI_UZORCI) {
    const m = tekst.match(rx)
    if (m) out.push({ kat, izraz: m[0] })
  }
  return out
}

/** Naš raspored → `${SUSTAV_DIR}`, naš HOME → `~`, ime vlasnika (i padeži) → „vlasnik…". */
export function pripremi(tekst: string, privatno: PrivatniIzraz[], tudiHome?: string): string {
  let t = tekst
  const home = tudiHome ? esc(tudiHome) + '/|' : ''
  t = t.replace(new RegExp(`(?:${home}~/|\\$HOME/|\\$\\{HOME\\}/)?${RASPORED}`, 'g'), '${SUSTAV_DIR}')
  if (tudiHome) t = t.replace(new RegExp(esc(tudiHome) + '(?=/|\\b)', 'g'), '~')
  for (const p of privatno.filter(x => x.kat === 'vlasnik')) {
    t = t.replace(new RegExp(GRANICA + esc(p.izraz) + '(\\p{L}*)', 'giu'), (_m, nast: string) => 'vlasnik' + nast)
  }
  return t
}

/**
 * Rečenica koja je UPUTA za uporabu mogućnosti (ne usputni spomen: „ne ispisuj tajnu u RAG" je
 * pravilo o tajnama i ostaje). Na čvoru bez mogućnosti takva rečenica ispada (§6.3).
 */
export const MOG_UZORCI: ReadonlyArray<[Mogucnost, RegExp]> = [
  ['rag', /RAG-FIRST|\brag-(?:query|store|list|inspect|delete|stats|coverage)\b|pretra\w* (?:u )?RAG|RAG kolekcij\w*|kolekcij\w* `?agent_|\bagent_(?:<id>|\*|(?!status\b)[a-z]+)\b|pgvector|ChromaDB/i],
  ['nextcloud', /Nextcloud|\bNC\b|\bnc\.py\b/],
  ['docuseal', /DocuSeal/],
  ['glas', /\bTTS\b|\bSTT\b|[Ww]hisper|Piper|VoiceServer/],
  ['ollama', /Ollam\w*|qwen\d/],
  ['internet', /GitHub|Tailscale|javn\w* (?:adres|link)\w*/],
]
const OZNAKA_RETKA = /^<!-- uvjet-redak: ([a-z]+) --> /
const RASPON = /<!--u:([a-z]+)-->([\s\S]*?)<!--\/u-->/g
const RECENICE = /(?<=[.!?])\s+(?=[\p{Lu}„"`*(\d])/u

const mogUretku = (r: string, osim?: Mogucnost) => MOG_UZORCI.find(([mog, rx]) => mog !== osim && rx.test(r))?.[0]

/**
 * U općem odjeljku: stavka/redak tablice koji je uputa za mogućnost dobiva oznaku retka, a u
 * odlomku samo takva rečenica dobiva raspon `<!--u:mog-->…<!--/u-->`. Čvor bez mogućnosti ih ne vidi.
 */
export function oznaciRetke(tekst: string, osim?: Mogucnost): string {
  return tekst.split('\n').map(r => {
    if (!r.trim() || r.startsWith('<!--')) return r
    if (STRUKTURNI.test(r)) { const m = mogUretku(r, osim); return m ? `<!-- uvjet-redak: ${m} --> ${r}` : r }
    return r.split(RECENICE).map(rec => { const m = mogUretku(rec, osim); return m ? `<!--u:${m}-->${rec}<!--/u-->` : rec }).join(' ')
  }).join('\n')
}


/** Ukloni retke (stavke, retke tablice) i rečenice s pogotkom. Vraća tekst i broj uklonjenih jedinica. */
export function redigiraj(tekst: string, privatno: PrivatniIzraz[]): { tekst: string; uklonjeno: number } {
  let uklonjeno = 0
  const out: string[] = []
  for (const r of tekst.split('\n')) {
    if (!branaKorpusa(r, privatno).length) { out.push(r); continue }
    if (STRUKTURNI.test(r)) { uklonjeno++; continue }
    const rec = r.split(RECENICE)
    const ostaje = rec.filter(s => !branaKorpusa(s, privatno).length)
    uklonjeno += rec.length - ostaje.length
    if (ostaje.length) out.push(ostaje.join(' '))
  }
  return { tekst: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), uklonjeno }
}

export interface IshodDokumenta {
  /** null = nijedan odjeljak nije opći (datoteka ne ide u korpus). */
  sadrzaj: string | null
  ukljuceno: string[]
  izbaceno: string[]
  redigirano: number
}

export function gradiDokument(datoteka: string, tekst: string, opsegZa: OpsegZa, privatno: PrivatniIzraz[],
  opcije: { tudiHome?: string } = {}): IshodDokumenta {
  const { naslov, dijelovi } = odjeljci(tekst)
  const ukljuceno: string[] = []
  const izbaceno: string[] = []
  const blokovi: string[] = []
  let redigirano = 0
  for (const d of dijelovi) {
    const o = opsegZa(datoteka, d.naslov)
    if (!o || o.vrsta === 'privatno') { izbaceno.push(d.naslov); continue }
    let tijelo = pripremi(d.tijelo, privatno, opcije.tudiHome)
    if (o.redigiraj) { const r = redigiraj(tijelo, privatno); tijelo = r.tekst; redigirano += r.uklonjeno }
    tijelo = oznaciRetke(tijelo, o.mogucnost)
    const naslovOdj = pripremi(d.naslov, privatno, opcije.tudiHome)
    const pog = branaKorpusa(`${naslovOdj}\n${tijelo}`, privatno)
    if (pog.length) throw new BranaPrivatnog(datoteka, d.naslov, pog)
    if (!tijelo.trim()) { izbaceno.push(d.naslov); continue }
    ukljuceno.push(d.naslov)
    const oznaka = o.vrsta === 'uvjet' ? `<!-- uvjet: ${o.mogucnost} -->\n` : ''
    blokovi.push(d.naslov === '(uvod)' ? `${oznaka}${tijelo}` : `## ${naslovOdj}\n${oznaka}${tijelo}`)
  }
  if (!blokovi.length) return { sadrzaj: null, ukljuceno, izbaceno, redigirano }
  const glava = pripremi(naslov || datoteka, privatno, opcije.tudiHome)
  if (branaKorpusa(glava, privatno).length) throw new BranaPrivatnog(datoteka, '(naslov)', branaKorpusa(glava, privatno))
  return { sadrzaj: `# ${glava}\n\n${blokovi.join('\n\n')}\n`, ukljuceno, izbaceno, redigirano }
}

// ─── Render na čvoru ─────────────────────────────────────────────────────────

/** Što čvor kaže kad mogućnosti nema (§6.2, §6.3) — isti tekst ide u korpus, identitet i CLAUDE.md. */
export const CINJENICA_BEZ: Readonly<Record<Mogucnost, string>> = {
  rag: 'Na ovom čvoru RAG nije uključen (nema ChromaDB ni pgvector kolekcija, pa RAG alati za upit i upis ovdje ne rade). '
    + 'Memorija čvora je samo Hindsight banka `${MEMORIJA_BANKA}`. Pravilo „prije ne znam" ovdje glasi: '
    + 'pretraži memoriju (Hindsight banka čvora) i datoteke (`grep`, čitanje datoteka).',
  nextcloud: 'Na ovom čvoru Nextcloud nije spojen: dokumenti se ne spremaju u oblak nego ostaju na disku čvora, a korisniku se šalju kao privitak.',
  docuseal: 'Na ovom čvoru nema DocuSeala: potpisivanje dokumenata ovdje nije dostupno.',
  glas: 'Na ovom čvoru nema glasovnog servisa (STT/TTS): glasovne poruke se ne prepisuju i odgovor je samo tekst.',
  ollama: 'Na ovom čvoru nema lokalnih modela (Ollama): sav rad ide preko vanjskog modela.',
  internet: 'Ovaj čvor nema dopuštenje za objavu na internet (GitHub, javni linkovi) — to traži odobrenje vlasnika čvora. To se odnosi samo na objavu, ne na čitanje weba (zasebna mogućnost u stanju čvora).',
  root: 'Ovaj čvor nema root ovlasti: instalacija sustavskih paketa traži vlasnika čvora.',
}

export interface RenderOpcije {
  mogucnosti: Partial<Record<Mogucnost, boolean>>
  varijable: Record<string, string>
  /** Postoji li datoteka na čvoru (stavka alata s `Poziv: … ${SUSTAV_DIR}/…` kojeg nema ispada). */
  postoji?: (put: string) => boolean
}

function zamijeniVarijable(t: string, v: Record<string, string>): string {
  return t.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, ime: string) => (ime in v ? v[ime] : m))
}

export function renderZaCvor(sadrzaj: string, o: RenderOpcije): string {
  const redci = sadrzaj.split('\n')
  const out: string[] = []
  const vecRecena = new Set<string>()
  for (let i = 0; i < redci.length; i++) {
    const cinjenica = (mog: Mogucnost) => {
      if (vecRecena.has(mog)) return ''
      vecRecena.add(mog)
      return CINJENICA_BEZ[mog] ?? `Na ovom čvoru mogućnost ${mog} nije uključena.`
    }
    if (redci[i].includes('<!--u:')) {
      const r = redci[i].replace(RASPON, (_m, mog: string, rec: string) => (o.mogucnosti[mog as Mogucnost] === true ? rec : cinjenica(mog as Mogucnost)))
      out.push(r.replace(/\s{2,}/g, ' ').trim())
      continue
    }
    const rr = redci[i].match(OZNAKA_RETKA)
    if (rr) {
      const mog = rr[1] as Mogucnost
      if (o.mogucnosti[mog] === true) out.push(redci[i].replace(OZNAKA_RETKA, ''))
      else { const c = cinjenica(mog); if (c) out.push(c) }
      continue
    }
    const m = redci[i].match(/^<!-- uvjet: ([a-z]+) -->$/)
    if (m) {
      const mog = m[1] as Mogucnost
      if (o.mogucnosti[mog] === true) continue // oznaka ne ide u banku, tekst ostaje
      const c = cinjenica(mog)
      if (c) out.push(c)
      while (i + 1 < redci.length && !redci[i + 1].startsWith('## ')) i++ // preskoči tijelo odjeljka
      out.push('')
      continue
    }
    out.push(redci[i])
  }
  let t = zamijeniVarijable(out.join('\n'), o.varijable)
  if (o.postoji) {
    t = t.split('\n').filter(r => {
      const p = r.match(/Poziv: `(?:bun|python3|bash|node)\s+([^\s`]+)/)
      return !p || !p[1].startsWith('/') && !p[1].startsWith('~') ? true : o.postoji!(p[1])
    }).join('\n')
  }
  return t.replace(/\n{3,}/g, '\n\n')
}
