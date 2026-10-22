/**
 * IzvrsiteljFit — agent-agnostičnost: uspoređivanje `treba` koraka sa sposobnostima
 * izvršitelja i odabir oblika izvedbe (W0c / TASK-4622).
 *
 * NALOG (Goran, 04.09.2026.): „imati na umu da radimo agent-agnostic sustav i da će neki
 * agenti biti lokalni i dosta ograničeni." Razrada: `~/app/regoc_system/docs/
 * PLAN-workflow-integracija.md` §6.3.
 *
 * PRAVILO KOJE OVAJ MODUL DRŽI — NIKAD TIHO PODBACIVANJE. Za svaki korak postoji točno
 * jedan od tri ishoda i svaki je zapisan:
 *
 *   `puni`       — izvršitelj ispunjava sve što korak traži; ide izvorni opis koraka.
 *   `zamjena`    — nešto ne ispunjava, ali korak nosi `zamjena` (jednostavniji oblik istog
 *                  posla); ide tekst zamjene, a u zapisu stoji ŠTO je nedostajalo.
 *   `eskalacija` — nešto ne ispunjava, a zamjene nema; korak ide jačem izvršitelju.
 *                  Ako jačeg nema, ishod je `eskalacija` bez izvršitelja — to je blokada,
 *                  a ne prolaz. Korak se NE smije poslati slabom izvršitelju „da proba".
 *
 * ZAŠTO JE NEPOZNAT ZAHTJEV JEDNAK NEISPUNJENOM: `treba: ['ocr']` (pojam koji rječnik ne
 * poznaje) ne može se dokazati kao ispunjen. Prolaz bi značio tiho podbacivanje — točno ono
 * što ovaj modul postoji da spriječi. Zato se nepoznat zahtjev broji u `nedostaje`.
 *
 * PROFIL SE MJERI, NE PRETPOSTAVLJA. Registar `config/izvrsitelji.json` puni
 * `tools/sposobnosti-probe.ts` stvarnim pokusom na čvoru. Ugrađeni zadani profili služe
 * samo kad registra nema, i nose `izvorProfila: 'zadano'` da se u izvještaju vidi da
 * odluka stoji na pretpostavci.
 *
 * MJERENJE KOJE JE ISPRAVILO PRETPOSTAVKU IZ PLANA (05.09.2026., GPU čvor s Ollamom):
 * plan §6.3 kaže da su „lokalni Ollama agenti jedan poziv bez petlje alata". Za DANAŠNJI
 * put spawna to više ne vrijedi — `RegocDaemon.ts` lokalne modele od TASK-2637 vodi kroz
 * `tools/ollama-agent.ts`, koji JEST petlja s alatima, a `qwen3:8b` alat poziva i
 * nenaručeno. Ograničenje nije model nego RUNNER: u `ollama-agent.ts` nema nijednog web
 * alata (0 pogodaka na `web_fetch|web_search|WebFetch`), pa je `web` strukturno nedostupan
 * svakom lokalnom izvršitelju. Zato profil mora doći iz mjerenja, a ne iz uvjerenja.
 *
 * ŠTO OVAJ MODUL NAMJERNO NE RADI: ne pokreće procese i ne zove mrežu. Odluka je
 * deterministička — bez modela, iz istog razloga kao `WorkflowGate` i `odaberi_workflow.py`.
 *
 * Autorica: Kosjenka (Architect), TASK-4622.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'

import type { Korak, Tijek } from './WorkflowGate'
import { homedir } from 'os'

/** Inačica zapisa o rasporedu — izvještaj mora znati po kojim je pravilima redak nastao. */
export const FIT_VERZIJA = 1

const HOME = process.env.HOME || homedir()

export const IZVRSITELJI_REGISTAR_PATH =
  process.env.REGOC_IZVRSITELJI_REGISTAR || join(HOME, '.claude/regoc/config/izvrsitelji.json')

export const FIT_LOG_PATH =
  process.env.REGOC_FIT_LOG || join(HOME, '.claude/regoc/data/tijek_izvedbe.jsonl')

// ─── Rječnik sposobnosti ─────────────────────────────────────────────────────

/** Rječnik iz plana §6.3, točka 2. Sve izvan ovoga je nepoznat zahtjev. */
export type Sposobnost = 'alate' | 'web' | 'rag' | 'pisanje' | 'dug-kontekst'

export const SPOSOBNOSTI: readonly Sposobnost[] = ['alate', 'web', 'rag', 'pisanje', 'dug-kontekst'] as const

/**
 * Pisci kataloga su ljudi, pa se isti pojam piše na više načina. Normalizacija je uska
 * namjerno: prima očite inačice, a sve ostalo pušta kao nepoznato (v. `nedostaje`).
 */
const SINONIMI: Record<string, Sposobnost> = {
  'alate': 'alate', 'alat': 'alate', 'alati': 'alate', 'tools': 'alate',
  'web': 'web', 'internet': 'web', 'mreza': 'web', 'mreža': 'web',
  'rag': 'rag', 'baza-znanja': 'rag',
  'pisanje': 'pisanje', 'pisanje-po-disku': 'pisanje', 'disk': 'pisanje',
  'dug-kontekst': 'dug-kontekst', 'dug kontekst': 'dug-kontekst',
  'dugi-kontekst': 'dug-kontekst', 'dugikontekst': 'dug-kontekst',
}

export function normalizirajSposobnost(s: string): Sposobnost | null {
  const k = String(s ?? '').trim().toLowerCase().replace(/_/g, '-')
  return SINONIMI[k] ?? null
}

/** Zahtjevi koraka, razdvojeni na prepoznate i nepoznate — oboje ide u izvještaj. */
export function razlozIZahtjeve(treba?: string[]): { poznati: Sposobnost[]; nepoznati: string[] } {
  const poznati: Sposobnost[] = []
  const nepoznati: string[] = []
  for (const t of treba ?? []) {
    const n = normalizirajSposobnost(t)
    if (n) { if (!poznati.includes(n)) poznati.push(n) }
    else { const s = String(t ?? '').trim(); if (s && !nepoznati.includes(s)) nepoznati.push(s) }
  }
  return { poznati, nepoznati }
}

// ─── Profil izvršitelja ──────────────────────────────────────────────────────

export interface ProfilIzvrsitelja {
  id: string
  opis?: string
  /** Što izvršitelj STVARNO može. Prazno polje je legitimno (najslabiji izvršitelj). */
  sposobnosti: Sposobnost[]
  /**
   * Redoslijed eskalacije, ne ocjena kvalitete. Eskalira se na NAJSLABIJEG koji zadovolji
   * zahtjev — jer je skupi izvršitelj zadnje sredstvo, a ne prvo.
   */
  snaga: number
  /**
   * Traži li pred-ubacivanje konteksta. Mjereno u našem radu: izvršitelj koji ne poseže za
   * alatima mora dobiti činjenice u promptu, inače korak izgleda kao da je prošao.
   */
  predUbacivanje?: boolean
  /** Kako je profil nastao — odluka koja stoji na pretpostavci mora se u izvještaju vidjeti. */
  izvorProfila?: 'mjereno' | 'zadano' | 'konfiguracija'
  /** Kad je mjeren (ISO) i čime — provenijencija, da se stari profil ne provlači kao svjež. */
  mjerenoU?: string
  mjerenoCime?: string
}

/**
 * Ugrađeni profili — vrijede SAMO dok registra nema. Namjerno oprezni: lokalnom izvršitelju
 * se ne pripisuje ništa što nije izmjereno, jer je precijenjen profil isto što i tiho
 * podbacivanje.
 */
export const ZADANI_PROFILI: ProfilIzvrsitelja[] = [
  {
    id: 'claude-opus',
    opis: 'claude --print --model opus (puna petlja alata, web, RAG, pisanje po disku)',
    sposobnosti: ['alate', 'web', 'rag', 'pisanje', 'dug-kontekst'],
    snaga: 100, izvorProfila: 'zadano',
  },
  {
    id: 'claude-sonnet',
    opis: 'claude --print --model sonnet',
    sposobnosti: ['alate', 'web', 'rag', 'pisanje', 'dug-kontekst'],
    snaga: 80, izvorProfila: 'zadano',
  },
  {
    id: 'ollama-tool-loop',
    opis: 'lokalni model kroz tools/ollama-agent.ts — petlja s alatima, bez web alata',
    sposobnosti: ['alate', 'rag', 'pisanje'],
    snaga: 40, izvorProfila: 'zadano',
  },
  {
    id: 'ollama-jedan-poziv',
    opis: 'lokalni model bez petlje alata (jedan chat poziv) — kontekst se mora pred-ubaciti',
    sposobnosti: [],
    snaga: 10, predUbacivanje: true, izvorProfila: 'zadano',
  },
]

export interface Registar { izvrsitelji: ProfilIzvrsitelja[]; izvor: string }

interface Otisak { mtimeMs: number; velicina: number }
interface KesUnos<T> { vrijednost: T; put: string; ucitanoU: number; otisak: Otisak }

const KES_TTL_MS = 30_000

function otisakOf(put: string): Otisak {
  try { const st = statSync(put); return { mtimeMs: st.mtimeMs, velicina: st.size } }
  catch { return { mtimeMs: -1, velicina: -1 } }
}

function svjez<T>(kes: KesUnos<T> | null, put: string): boolean {
  if (!kes || kes.put !== put) return false
  if (Date.now() - kes.ucitanoU >= KES_TTL_MS) return false
  const o = otisakOf(put)
  return o.mtimeMs === kes.otisak.mtimeMs && o.velicina === kes.otisak.velicina
}

let _registar: KesUnos<Registar> | null = null

function pocistiProfil(sirovo: any): ProfilIzvrsitelja | null {
  const id = String(sirovo?.id ?? '').trim()
  if (!id) return null
  const sposobnosti: Sposobnost[] = []
  for (const s of Array.isArray(sirovo?.sposobnosti) ? sirovo.sposobnosti : []) {
    const n = normalizirajSposobnost(s)
    if (n && !sposobnosti.includes(n)) sposobnosti.push(n)
  }
  const snaga = Number(sirovo?.snaga)
  return {
    id, sposobnosti,
    opis: sirovo?.opis ? String(sirovo.opis) : undefined,
    snaga: Number.isFinite(snaga) ? snaga : 0,
    predUbacivanje: !!sirovo?.predUbacivanje,
    izvorProfila: sirovo?.izvorProfila === 'mjereno' ? 'mjereno' : 'konfiguracija',
    mjerenoU: sirovo?.mjerenoU ? String(sirovo.mjerenoU) : undefined,
    mjerenoCime: sirovo?.mjerenoCime ? String(sirovo.mjerenoCime) : undefined,
  }
}

/** Registar s diska; nedostajuća/neispravna datoteka → ugrađeni zadani profili. */
export function loadRegistar(o: { registarPath?: string; force?: boolean } = {}): Registar {
  const put = o.registarPath || IZVRSITELJI_REGISTAR_PATH
  if (!o.force && svjez(_registar, put)) return _registar!.vrijednost

  let reg: Registar = { izvrsitelji: ZADANI_PROFILI.map(p => ({ ...p })), izvor: '(ugrađeno)' }
  try {
    if (existsSync(put)) {
      const sirovo = JSON.parse(readFileSync(put, 'utf-8'))
      const lista = Array.isArray(sirovo?.izvrsitelji) ? sirovo.izvrsitelji : []
      const ocisceni = lista.map(pocistiProfil).filter(Boolean) as ProfilIzvrsitelja[]
      if (ocisceni.length) reg = { izvrsitelji: ocisceni, izvor: put }
    }
  } catch { /* neispravan registar → zadani profili; raspoređivač ne ruši pozivatelja */ }

  _registar = { vrijednost: reg, put, ucitanoU: Date.now(), otisak: otisakOf(put) }
  return reg
}

export function nadiProfil(id: string, reg?: Registar): ProfilIzvrsitelja | null {
  const r = reg || loadRegistar()
  return r.izvrsitelji.find(p => p.id === id) ?? null
}

// ─── Procjena jednog koraka ──────────────────────────────────────────────────

export type Oblik = 'puni' | 'zamjena' | 'eskalacija'

export interface ProcjenaKoraka {
  indeks: number
  agent: string
  uloga?: string
  vjestina?: string
  /** Prepoznati zahtjevi koraka. */
  treba: Sposobnost[]
  /** Zahtjevi koje rječnik ne poznaje — broje se kao neispunjeni. */
  nepoznatiZahtjevi: string[]
  /** Što izvršitelju nedostaje (prepoznato + nepoznato). */
  nedostaje: string[]
  oblik: Oblik
  /** Tko korak stvarno izvodi; `null` znači da nema nikoga tko može — blokada. */
  izvrsitelj: string | null
  /** Izvršitelj kojemu je korak izvorno dodijeljen (prije eventualne eskalacije). */
  trazeniIzvrsitelj: string
  /** Tekst koji ide izvršitelju: izvorni opis ili tekst zamjene. */
  uputa: string
  /** Što se mora PRED-UBACITI u prompt jer izvršitelj sam neće posegnuti. */
  predUbaciti: Sposobnost[]
  razlog: string
}

export interface ProcjeniOpcije {
  registar?: Registar
  /** Dopusti eskalaciju na jačeg izvršitelja kad zamjene nema (zadano: da). */
  eskalacija?: boolean
}

/**
 * Jedan korak × jedan izvršitelj → oblik izvedbe.
 *
 * Redoslijed odluke je namjeran: PUNI → ZAMJENA → ESKALACIJA. Zamjena ide prije eskalacije
 * jer je jeftinija, a katalog je piše kao „jednostavniji oblik ISTOG posla" — dakle posao je
 * i dalje obavljen. Eskalacija je izlaz za korak koji se ne da pojednostaviti.
 */
export function procijeniKorak(
  korak: Korak,
  izvrsiteljId: string,
  indeks = 0,
  o: ProcjeniOpcije = {},
): ProcjenaKoraka {
  const reg = o.registar || loadRegistar()
  const profil = nadiProfil(izvrsiteljId, reg)
  const { poznati, nepoznati } = razlozIZahtjeve(korak.treba)

  const ima = profil?.sposobnosti ?? []
  const nedostajuPoznati = poznati.filter(s => !ima.includes(s))
  const nedostaje: string[] = [...nedostajuPoznati, ...nepoznati]

  const osnova: ProcjenaKoraka = {
    indeks,
    agent: String(korak.agent ?? ''),
    uloga: korak.uloga,
    vjestina: korak.vjestina,
    treba: poznati,
    nepoznatiZahtjevi: nepoznati,
    nedostaje,
    oblik: 'puni',
    izvrsitelj: izvrsiteljId,
    trazeniIzvrsitelj: izvrsiteljId,
    uputa: String(korak.opis ?? ''),
    predUbaciti: [],
    razlog: '',
  }

  if (!profil) {
    // Nepoznat izvršitelj se ne smije smatrati sposobnim. Traži se netko iz registra.
    const jaci = najslabijiKojiMoze(poznati, reg, -Infinity)
    return {
      ...osnova,
      nedostaje: nedostaje.length ? nedostaje : ['(nepoznat izvršitelj)'],
      oblik: 'eskalacija',
      izvrsitelj: jaci?.id ?? null,
      razlog: jaci
        ? `izvršitelj '${izvrsiteljId}' nije u registru → korak ide '${jaci.id}'`
        : `izvršitelj '${izvrsiteljId}' nije u registru i zamjene nema`,
    }
  }

  const predUbaciti = profil.predUbacivanje ? poznati.filter(s => ima.includes(s)) : []

  if (nedostaje.length === 0) {
    return {
      ...osnova,
      predUbaciti,
      razlog: poznati.length
        ? `'${profil.id}' ispunjava sve što korak traži (${poznati.join(', ')})`
        : `korak ne traži posebne sposobnosti`,
    }
  }

  const zamjena = String(korak.zamjena ?? '').trim()
  if (zamjena) {
    return {
      ...osnova,
      oblik: 'zamjena',
      uputa: zamjena,
      predUbaciti,
      razlog: `'${profil.id}' nema: ${nedostaje.join(', ')} → jednostavniji oblik istog koraka`,
    }
  }

  if (o.eskalacija === false) {
    return {
      ...osnova, oblik: 'eskalacija', izvrsitelj: null,
      razlog: `'${profil.id}' nema: ${nedostaje.join(', ')}, zamjene nema, eskalacija isključena`,
    }
  }

  // Nepoznat zahtjev ne može ispuniti NITKO — nema ga u rječniku sposobnosti.
  const jaci = nepoznati.length ? null : najslabijiKojiMoze(poznati, reg, profil.snaga)
  return {
    ...osnova,
    oblik: 'eskalacija',
    izvrsitelj: jaci?.id ?? null,
    razlog: jaci
      ? `'${profil.id}' nema: ${nedostaje.join(', ')}, zamjene nema → korak ide '${jaci.id}'`
      : nepoznati.length
        ? `zahtjev izvan rječnika (${nepoznati.join(', ')}) — nitko ga ne može dokazano ispuniti`
        : `'${profil.id}' nema: ${nedostaje.join(', ')}, zamjene nema, jačeg izvršitelja nema`,
  }
}

/** Najslabiji izvršitelj koji ispunjava sve zahtjeve i jači je od zadane snage. */
function najslabijiKojiMoze(treba: Sposobnost[], reg: Registar, iznadSnage: number): ProfilIzvrsitelja | null {
  const kandidati = reg.izvrsitelji
    .filter(p => p.snaga > iznadSnage && treba.every(s => p.sposobnosti.includes(s)))
    .sort((a, b) => a.snaga - b.snaga)
  return kandidati[0] ?? null
}

// ─── Raspored cijelog tijeka ─────────────────────────────────────────────────

export interface RasporedTijeka {
  verzija: number
  tijek: string
  izvrsitelj: string
  profilIzvor: string
  koraci: ProcjenaKoraka[]
  brojKoraka: number
  brojPuni: number
  brojZamjena: number
  brojEskalacija: number
  /** Nema izvršitelja ni nakon eskalacije — tijek se s ovim izvršiteljem ne može dovršiti. */
  brojBlokiranih: number
  udioZamjena: number
  /** §6.3: tijek koji na čvoru UVIJEK pada na zamjenu nije agent-agnostičan. */
  agentAgnostican: boolean
  /** Može li se tijek uopće dovršiti (nijedan korak nije bez izvršitelja). */
  dovrsiv: boolean
}

export function rasporediTijek(
  tijek: Tijek,
  izvrsiteljId: string,
  o: ProcjeniOpcije = {},
): RasporedTijeka {
  const reg = o.registar || loadRegistar()
  const koraci = (tijek.koraci ?? []).map((k, i) => procijeniKorak(k, izvrsiteljId, i, { ...o, registar: reg }))
  const brojPuni = koraci.filter(k => k.oblik === 'puni').length
  const brojZamjena = koraci.filter(k => k.oblik === 'zamjena').length
  const brojEskalacija = koraci.filter(k => k.oblik === 'eskalacija').length
  const brojBlokiranih = koraci.filter(k => k.izvrsitelj === null).length
  const n = koraci.length
  const profil = nadiProfil(izvrsiteljId, reg)
  return {
    verzija: FIT_VERZIJA,
    tijek: String(tijek.id ?? tijek.naziv ?? '(bez imena)'),
    izvrsitelj: izvrsiteljId,
    profilIzvor: profil?.izvorProfila ?? '(nepoznat izvršitelj)',
    koraci,
    brojKoraka: n,
    brojPuni, brojZamjena, brojEskalacija, brojBlokiranih,
    udioZamjena: n ? brojZamjena / n : 0,
    // Tijek bez koraka nije agent-agnostičan nego prazan — ne daje mu se prolazna ocjena.
    agentAgnostican: n > 0 && brojZamjena < n && brojBlokiranih === 0,
    dovrsiv: n > 0 && brojBlokiranih === 0,
  }
}

// ─── Zapis (nikad tiho) ──────────────────────────────────────────────────────

export interface ZapisIzvedbe extends Record<string, unknown> {
  ts: string
  verzija: number
  tijek: string
  izvrsitelj: string
  korak: number
  agent: string
  oblik: Oblik
  nedostaje: string[]
  razlog: string
}

/**
 * Jedan redak po KORAKU — mjerilo iz §6.3 („uz svaki korak bilježiti je li izvršen u punom
 * obliku ili preko zamjene") traži zrnatost koraka, ne tijeka.
 */
export function zapisiRaspored(
  r: RasporedTijeka,
  dodatno: Record<string, unknown> = {},
  logPath = FIT_LOG_PATH,
): number {
  let upisano = 0
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const ts = new Date().toISOString()
    const redci = r.koraci.map(k => JSON.stringify({
      ts, verzija: r.verzija, tijek: r.tijek, izvrsitelj: r.izvrsitelj,
      korak: k.indeks, agent: k.agent, uloga: k.uloga, vjestina: k.vjestina,
      oblik: k.oblik, izvrsiteljKoraka: k.izvrsitelj, treba: k.treba,
      nedostaje: k.nedostaje, predUbaciti: k.predUbaciti, razlog: k.razlog,
      ...dodatno,
    }))
    if (redci.length) { appendFileSync(logPath, redci.join('\n') + '\n'); upisano = redci.length }
  } catch { /* dnevnik ne smije oboriti izvedbu tijeka */ }
  return upisano
}

/** Sažetak za ljude — ide u `resultSummary` i u izvještaj. */
export function sazetak(r: RasporedTijeka): string {
  const redci = r.koraci.map(k => {
    const tko = k.izvrsitelj ?? 'NEMA IZVRŠITELJA'
    return `  ${k.indeks + 1}. ${k.agent}/${k.uloga ?? '-'} → ${k.oblik.toUpperCase()} (${tko})` +
      (k.nedostaje.length ? ` — nedostaje: ${k.nedostaje.join(', ')}` : '')
  })
  return [
    `tijek '${r.tijek}' × izvršitelj '${r.izvrsitelj}' (profil: ${r.profilIzvor})`,
    ...redci,
    `  = puni ${r.brojPuni}, zamjena ${r.brojZamjena}, eskalacija ${r.brojEskalacija}` +
    `, udio zamjena ${(r.udioZamjena * 100).toFixed(0)} %` +
    `, agent-agnostičan: ${r.agentAgnostican ? 'da' : 'NE'}`,
  ].join('\n')
}
