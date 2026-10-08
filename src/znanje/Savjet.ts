/**
 * Savjet glavnog sustava drugom botu → banka čvora (TASK-5341, nastavak ADR-0006 §7).
 *
 * Kad Klaudio odgovori Šabanu, u Šabanovu banku ne ide samo poslani tekst nego TEMATSKI PAKET
 * ZNANJA: pitanje, odgovor i cjelina oko teme (kako radi, zašto, preduvjeti, ograničenja, česte
 * greške, povezani alati, provjera). Paket slaže model na glavnom stroju (ondje su kod, karta i
 * memorija), a ovdje je ono što je čisto: filtar, dokument za banku i trag na ploči čvora.
 *
 * FILTAR je isti kao korpus čvora (Korpus.ts): `pripremi` (naš HOME → `~`, vlasnik → uloga),
 * brana privatnog popisa i općih uzoraka (chat id, PRJ-…, IP, e-pošta, tuđi HOME …) i brana tajni.
 * Jedinica je činjenica: činjenica s pogotkom ne ulazi (ne može se razvrstati → ne ulazi). Pitanje i
 * odgovor režu se po rečenici. Tema s pogotkom ili oblik tajne bilo gdje = cijeli paket ne ulazi.
 *
 * Autorica: Jelena (Engineer), TASK-5341.
 */
import { branaKorpusa, pripremi, redigiraj, type PrivatniIzraz } from './Korpus'
import { imaTajnu } from './Cvor'

export const DIJELOVI = ['kako-radi', 'zasto', 'preduvjeti', 'ogranicenja', 'ceste-greske', 'povezano', 'provjera'] as const
export type Dio = typeof DIJELOVI[number]

export const NASLOVI: Readonly<Record<Dio, string>> = {
  'kako-radi': 'Kako radi',
  'zasto': 'Zašto je tako',
  'preduvjeti': 'Preduvjeti',
  'ogranicenja': 'Ograničenja',
  'ceste-greske': 'Česte greške i kako ih prepoznati',
  'povezano': 'Povezani alati i tokovi',
  'provjera': 'Kako provjeriti da je uspjelo',
}

export interface PaketZnanja {
  tema: string
  /** Stabilan ključ teme (ime alata ili oznake: `send-doc`, `tts`) — id dokumenta; bez njega slug teme. */
  kljuc?: string
  pitanje: string
  odgovor: string
  cinjenice: Partial<Record<Dio, string[]>>
}

const DIJAKRITIKA: Record<string, string> = { č: 'c', ć: 'c', đ: 'd', š: 's', ž: 'z' }

/** Stabilan ključ teme: isti savjet o istoj temi zamjenjuje stari dokument (ne gomila proturječja). */
export function slugTeme(tema: string): string {
  const s = tema.toLowerCase()
    .replace(/[čćđšž]/g, c => DIJAKRITIKA[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '')
  return s || 'bez-teme'
}

/** Treći prostor imena uz `sustav/` (paket) i `cvor/` (podaci čvora): `upisi` čvora ga ne dira. */
export const idSavjeta = (tema: string, kljuc?: string) => `savjet/${slugTeme(kljuc?.trim() ? kljuc : tema)}`

export interface IshodFiltra {
  /** `null` = paket ne ulazi u banku (razlog u `razlog`). */
  paket: PaketZnanja | null
  /** Činjenice izbačene filtrom (cijela jedinica). */
  izbaceno: number
  /** Rečenice izrezane iz pitanja i odgovora. */
  redigirano: number
  razlog?: string
}

/**
 * `cvorHome` = HOME čvora: njegove putanje su znanje čvora (SEND_DOC traži apsolutnu putanju), pa se
 * pri brani maskiraju; svaki drugi `/home/<x>` (naš stroj, treći) i dalje ruši činjenicu.
 */
export function procistiSavjet(p: PaketZnanja, privatno: PrivatniIzraz[], o: { tudiHome?: string; cvorHome?: string } = {}): IshodFiltra {
  const sve = [p.tema, p.pitanje, p.odgovor, ...Object.values(p.cinjenice ?? {}).flat()].join('\n')
  if (imaTajnu(sve)) return { paket: null, izbaceno: 0, redigirano: 0, razlog: 'oblik tajne u paketu' }
  const prip = (t: string) => pripremi(String(t ?? ''), privatno, o.tudiHome).replace(/\s+/g, ' ').trim()

  const tema = prip(p.tema)
  const pogTeme = branaKorpusa(tema, privatno)
  if (!tema || pogTeme.length) return { paket: null, izbaceno: 0, redigirano: 0, razlog: `tema se ne može razvrstati (${pogTeme.map(x => x.kat).join(', ') || 'prazna'})` }

  const maska = '\u0000CVOR_HOME\u0000'
  const sakrij = (t: string) => o.cvorHome ? t.split(o.cvorHome).join(maska) : t
  const vrati = (t: string) => o.cvorHome ? t.split(maska).join(o.cvorHome) : t
  const brana = (t: string) => branaKorpusa(sakrij(t), privatno)

  let redigirano = 0
  const rez = (t: string) => { const r = redigiraj(sakrij(prip(t)), privatno); redigirano += r.uklonjeno; return vrati(r.tekst) }
  const pitanje = rez(p.pitanje)
  const odgovor = rez(p.odgovor)

  let izbaceno = 0
  const cinjenice: Partial<Record<Dio, string[]>> = {}
  for (const dio of DIJELOVI) {
    const ostaje: string[] = []
    for (const c of p.cinjenice?.[dio] ?? []) {
      const t = prip(c)
      if (!t) continue
      if (brana(t).length) { izbaceno++; continue }
      ostaje.push(t)
    }
    if (ostaje.length) cinjenice[dio] = ostaje
  }
  if (!Object.keys(cinjenice).length) return { paket: null, izbaceno, redigirano, razlog: 'nakon filtra nije ostala nijedna činjenica' }

  const kljuc = p.kljuc && !brana(p.kljuc).length ? slugTeme(p.kljuc) : undefined
  const paket: PaketZnanja = { tema, ...(kljuc ? { kljuc } : {}), pitanje, odgovor, cinjenice }
  // Druga linija: ono što izlazi mora proći branu u cijelosti (kanarinac, kao gradiDokument).
  const ostatak = brana([tema, pitanje, odgovor, ...Object.values(cinjenice).flat()].join('\n'))
  if (ostatak.length) return { paket: null, izbaceno, redigirano, razlog: `brana nakon filtra: ${ostatak.map(x => x.kat).join(', ')}` }
  return { paket, izbaceno, redigirano }
}

export function dokumentSavjeta(p: PaketZnanja, o: { cvor: string; bot: string }): string {
  const r = [`# Znanje od glavnog sustava: ${p.tema}`, '',
    `Ovo je provjereno znanje o općem sustavu REGOČ koje je glavni sustav (Klaudio) dao botu ${o.bot} na čvoru ${o.cvor}, `
    + `prilagođeno ovom čvoru (njegove putanje, njegov bot, njegov token). Tema: „${p.tema}".`, '']
  if (p.pitanje) r.push(`## Pitanje koje je postavio ${o.bot}`, p.pitanje, '')
  if (p.odgovor) r.push('## Odgovor koji je dobio', p.odgovor, '')
  for (const dio of DIJELOVI) {
    const c = p.cinjenice[dio]
    if (c?.length) r.push(`## ${NASLOVI[dio]}`, ...c.map(x => `- ${x}`), '')
  }
  return r.join('\n').trimEnd() + '\n'
}

export const brojCinjenica = (p: PaketZnanja) => Object.values(p.cinjenice).reduce((n, c) => n + (c?.length ?? 0), 0)

/** JSON paketa iz izlaza modela (gola ili u ogradi ```json). Neispravno ili bez teme → null. */
export function parsirajPaket(izlaz: string): PaketZnanja | null {
  const ograda = izlaz.match(/```(?:json)?\s*([\s\S]*?)```/)
  // Model piše hrvatske navodnike „…" sa zatvarajućim ASCII `"` — to zatvara JSON niz; popravak u „…“.
  const popravi = (t: string) => t.replace(/„([^"„“”\n]*)"/g, '„$1“')
  const sirovi = [ograda?.[1], izlaz.slice(izlaz.indexOf('{'), izlaz.lastIndexOf('}') + 1)]
  const kandidati = [...sirovi, ...sirovi.map(k => (k ? popravi(k) : k))]
  for (const k of kandidati) {
    if (!k || !k.trim()) continue
    let j: any
    try { j = JSON.parse(k) } catch { continue }
    if (!j || typeof j !== 'object' || typeof j.tema !== 'string' || !j.tema.trim()) continue
    const cinjenice: Partial<Record<Dio, string[]>> = {}
    for (const dio of DIJELOVI) {
      const niz = Array.isArray(j.cinjenice?.[dio]) ? j.cinjenice[dio] : []
      const cist = niz.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()).map((x: string) => x.trim())
      if (cist.length) cinjenice[dio] = cist
    }
    const kljuc = typeof j.kljuc === 'string' && j.kljuc.trim() ? slugTeme(j.kljuc) : undefined
    return { tema: j.tema.trim(), ...(kljuc ? { kljuc } : {}), pitanje: String(j.pitanje ?? '').trim(), odgovor: String(j.odgovor ?? '').trim(), cinjenice }
  }
  return null
}

// ─── Trag na ploči čvora (TASK-5337: razgovor botova vidljiv na ploči) ─────────

export interface ZadatakPloce { id: string; tags?: unknown; updatedAt?: string; updated_at?: string }

function oznake(t: unknown): string[] {
  if (Array.isArray(t)) return t.map(String)
  if (typeof t !== 'string') return []
  try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map(String) } catch { /* oblik repr */ }
  return [...t.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1])
}

/** Najnoviji razgovorni zadatak tog chata — onaj koji je Klaudijev odgovor upravo otvorio ili nastavio. */
export function zadatakZaTrag(zadaci: ZadatakPloce[], chatId: string): string | null {
  const tag = `chat:telegram:${chatId}`
  const kad = (z: ZadatakPloce) => String(z.updatedAt ?? z.updated_at ?? '').replace('T', ' ')
  const k = zadaci.filter(z => { const o = oznake(z.tags); return o.includes('razgovor') && o.includes(tag) })
  k.sort((a, b) => kad(b).localeCompare(kad(a)))
  return k[0]?.id ?? null
}

export interface Trag {
  banka: string
  id: string
  tema: string
  cinjenica: number
  izbaceno: number
  ishod: 'upisano' | 'odbijeno' | 'kvar'
  razlog?: string
}

export function biljeskaTraga(t: Trag): string {
  if (t.ishod === 'upisano') {
    return `🧠 znanje od Klaudija upisano u banku ${t.banka}: „${t.tema}" (${t.id}, ${t.cinjenica} činjenica`
      + `${t.izbaceno ? `, ${t.izbaceno} izbačeno filtrom privatnog` : ''})`
  }
  return `🧠🚫 znanje od Klaudija NIJE upisano u banku ${t.banka}${t.tema ? `: „${t.tema}"` : ''} — ${t.ishod}: ${t.razlog || 'nepoznat razlog'}`
}

// ─── Sastavljač paketa (model na glavnom stroju, samo čitanje) ─────────────────

export interface UlazSastavljaca {
  pitanje: string
  odgovor: string
  cvor: string
  bot: string
  /** HOME čvora — apsolutne putanje čvora smiju se pisati doslovno (npr. za SEND_DOC). */
  cvorHome?: string
  /** Mape koje model smije čitati (kod paketa, opći korpus, karta) — samo za uputu, vrata drži CLI. */
  izvori: string[]
}

/**
 * Prompt modela koji slaže paket. Pitanje i odgovor su PODACI (omeđeni), ne nalozi. Pravila
 * privatnosti su tu samo da model ne troši rečenice na ono što filtar ionako reže — granicu drži
 * `procistiSavjet`, ne model.
 */
export function promptSastavljaca(u: UlazSastavljaca): string {
  const omedi = (t: string) => t.replace(/\[(?=\/?(?:PITANJE|ODGOVOR)\])/g, '(')
  return [
    `[ZADATAK] Glavni sustav REGOČ (Klaudio) upravo je odgovorio botu ${u.bot} na čvoru ${u.cvor}. ${u.bot} ne smije naučiti samo poslani tekst nego CJELINU teme. `
    + 'Složi tematski paket znanja: kako alat ili tok radi, zašto je tako, preduvjeti, ograničenja, česte greške i kako ih prepoznati (doslovan tekst poruke greške), '
    + 'povezani alati i tokovi, kako provjeriti da je uspjelo. Uvijek pokrij i: odakle dolaze ovlasti, token i postavke (koja datoteka ili postavka čvora); '
    + 'što se dogodi kad je oblik krivo napisan (prepozna li se uopće, javlja li greška); gdje na disku ili ploči čvora ostaje trag da je uspjelo.',
    `[IZVORI] Čitaj samo ove mape (alati Read, Glob, Grep): ${u.izvori.join(', ')}. Čvor vozi paket TaskManagerAI, pa je kod paketa (src/, scripts/, docs/, znanje/sustav/) mjerodavan za čvor. `
    + 'Piši SAMO činjenice koje si potvrdio u izvoru; što ne možeš potvrditi, izostavi.',
    '[PRILAGODBA ČVORU] Paket TaskManagerAI je na čvoru u ~/TaskManagerAI, podaci ploče u ~/.taskmanager (TM_HOME), ploča na 127.0.0.1:17781. '
    + `Bot čvora (${u.bot}) šalje svojim tokenom iz konfiguracije čvora, nikad tuđim. `
    + (u.cvorHome
      ? `HOME čvora je ${u.cvorHome}: kad treba apsolutna putanja, piši je od ${u.cvorHome}; nikad /home/<drugi korisnik>.`
      : 'Putanje piši s ~ ili ${TM_HOME}, nikad /home/<korisnik>.'),
    '[NIKAD U PAKETU] imena ljudi, klijenata i tvrtki; ID-evi projekata (PRJ-…) i zadataka (TASK-…); chat ID-evi i imena Telegram grupa; adrese (IP, domene, e-pošta); '
    + 'podaci o Nextcloudu, DocuSealu i uslugama glavnog stroja; tajne, tokeni i ključevi (ni dijelovi); stanje pogona glavnog stroja. Činjenicu s takvim podatkom ne piši — filtar je ionako izbacuje cijelu.',
    '[OBLIK] Navodnici u tekstu: hrvatski „…“ (zatvara U+201C) ili `…` — nikad ASCII " unutar JSON niza. Svaka činjenica je jedna samostalna rečenica (ili dvije), razumljiva bez ostatka paketa: imenuj alat, oznaku ili datoteku umjesto „to" ili „ovo". Najviše 8 činjenica po dijelu.',
    `[PITANJE]\n${omedi(u.pitanje).slice(0, 6000)}\n[/PITANJE]`,
    `[ODGOVOR]\n${omedi(u.odgovor).slice(0, 6000)}\n[/ODGOVOR]`,
    'Vrati SAMO JSON, bez ičega oko njega:\n'
    + '{"tema": "<kratak naziv teme>", "kljuc": "<ime alata ili oznake malim slovima, npr. send-doc, tts, bot-kanal — isti za istu temu>", "pitanje": "<sažeto pitanje>", "odgovor": "<sažet odgovor>", "cinjenice": {'
    + DIJELOVI.map(d => `"${d}": ["…"]`).join(', ') + '}}',
  ].join('\n\n')
}
