/**
 * IngestGateKalibracija — ocjena v2 ulaznih vrata: NALOG × BROJ STRUKA (TASK-5161).
 *
 * Mjerenje: `~/app/regoc_system/docs/UMJERAVANJE-ulazna-vrata-20261003.md`.
 *
 * ZAŠTO v2. Ocjena v1 (`ModeClassifier` → `WeightScore`) na 210 ručno označenih naloga
 * (01.–03.10.2026.) pogađa razred u 46 % slučajeva, a lanac (više struka) u 2 od 13.
 * Tri uzroka nose većinu pogrešaka:
 *   1. E1 bez glagola s popisa — „treba mi…", „neka Jelena…", „trebali bi izradu…",
 *      „napravite…" nisu na popisu E2 glagola, a „ok/da" na početku odgovora gura u E1.
 *   2. Duljina ≠ težina — zalijepljen ispis terminala ili dnevnika (>500 znakova) dobiva
 *      E5 91; poruka od 200 znakova koja traži tri struke dobiva E1 8.
 *   3. Broj struka se uopće ne mjeri — a Goranovo pravilo 25 kaže da je upravo on kriterij.
 *
 * ŠTO v2 RADI (deterministički, bez modela — vrući put svake poruke):
 *   a) odreže zalijepljeni ispis (prompt `user@host:…$`, `[sudo]`, `INFO --`, `NOTICE:`, žig
 *      vremena dnevnika) i ocjenjuje samo ljudski dio poruke;
 *   b) NALOG = glagol naloga u imperativu/infinitivu (proširen popis, hrvatski oblici), ili
 *      modal/delegacija („treba", „neka", „ajmo", „daj Grgi") izvan pitanja;
 *   c) STRUKE = različita područja rada iz rječnika (istraživanje, analiza, dizajn,
 *      ilustracija, izrada, QA, sigurnost, dokumentacija, arhitektura) + imenovani agenti;
 *   d) NASTAVAK = kratka suglasnost („ok", „može", „ajmo"…) neposredno nakon naloga iste grupe;
 *   e) razred = bez naloga E1, nalog s ≤1 strukom E2, 2 struke E3, 3 struke E4, ≥4 E5.
 *      Broj 1–100 i dalje daje `scoreWeight` (sredina razreda + datoteke), pa pragovi A/B/C
 *      ostaju isti i ostaju čitljivi: A dijeli odgovor/nalog, B dijeli jednu struku od više,
 *      C dijeli „velik lanac" (≥4 struke) koji traži Goranovu potvrdu.
 *
 * POSTAVKE: `config/ingest-gate-kalibracija.json`, čitaju se pri svakoj poruci (bez keša,
 * kao i `ingest-gate.json`). Zasebna datoteka, a NE ključ u `ingest-gate.json`, jer
 * `saveIngestGateConfig` (ploča) piše samo poznata polja i tiho bi obrisao kalibraciju.
 * `inacica: 1` vraća staru ocjenu bez restarta. Nečitljiva datoteka = v1 (fail-safe: ništa
 * novo ne smije samo krenuti).
 *
 * Autorica: Dora (Analyst), TASK-5161.
 */

import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync } from 'fs'
import { join } from 'path'

import type { EffortTier } from './ModeClassifier'
import { homedir } from 'os'

export const KALIBRACIJA_PATH = join(
  process.env.HOME || homedir(), '.claude/regoc/config/ingest-gate-kalibracija.json')

export interface Kalibracija {
  /** 1 = stara ocjena (ModeClassifier), 2 = nalog × struke. */
  inacica: 1 | 2
  /** Razred po broju struka kad poruka JEST nalog; indeks = broj struka (0..4+). */
  razredPoStrukama: EffortTier[]
  /** Razred poruke koja nije nalog (pitanje, informacija, zalijepljen ispis). */
  razredBezNaloga: EffortTier
  /** Nastavak: kratka suglasnost unutar ovoliko minuta od naloga iste grupe postaje nalog. */
  nastavakMinuta: number
  /** Nastavak: najviše ovoliko znakova ljudskog dijela poruke. */
  nastavakDuljina: number
}

export const ZADANA_KALIBRACIJA: Kalibracija = {
  inacica: 1,
  razredPoStrukama: ['E2', 'E2', 'E3', 'E4', 'E5'],
  razredBezNaloga: 'E1',
  nastavakMinuta: 30,
  nastavakDuljina: 120,
}

const RAZREDI = ['E1', 'E2', 'E3', 'E4', 'E5']

/** Čita postavke pri svakom pozivu. Kvar ili nepoznata vrijednost → zadano (v1). */
export function ucitajKalibraciju(path: string = KALIBRACIJA_PATH): Kalibracija {
  try {
    if (!existsSync(path)) return { ...ZADANA_KALIBRACIJA }
    const s = JSON.parse(readFileSync(path, 'utf-8'))
    const k: Kalibracija = { ...ZADANA_KALIBRACIJA }
    if (s.inacica === 1 || s.inacica === 2) k.inacica = s.inacica
    if (Array.isArray(s.razredPoStrukama) && s.razredPoStrukama.length === 5 &&
        s.razredPoStrukama.every((e: unknown) => RAZREDI.includes(String(e)))) {
      k.razredPoStrukama = s.razredPoStrukama
    }
    if (RAZREDI.includes(String(s.razredBezNaloga))) k.razredBezNaloga = s.razredBezNaloga
    if (Number.isInteger(s.nastavakMinuta) && s.nastavakMinuta >= 0 && s.nastavakMinuta <= 240) k.nastavakMinuta = s.nastavakMinuta
    if (Number.isInteger(s.nastavakDuljina) && s.nastavakDuljina >= 0 && s.nastavakDuljina <= 1000) k.nastavakDuljina = s.nastavakDuljina
    return k
  } catch {
    return { ...ZADANA_KALIBRACIJA }
  }
}

// ─── Rječnici ────────────────────────────────────────────────────────────────

const L = '\\p{L}\\p{N}_'

/**
 * Glagoli naloga, osnova = 2. lice jednine imperativa. Iz nje se izvode imperativ množine
 * (-te), 1. lice množine (-mo) i infinitiv (-ti / -j→-ti), jer Goran piše i „napravi" i
 * „napravite" i „možeš li napraviti". Particip („revidirani", „napravljeno") se NAMJERNO ne
 * hvata — on opisuje stanje, ne traži rad.
 */
const GLAGOLI_NALOGA = [
  'napravi', 'izradi', 'popravi', 'ispravi', 'doradi', 'dodaj', 'ubaci', 'stavi', 'upiši', 'upisi',
  'unesi', 'označi', 'oznaci', 'pošalji', 'posalji', 'provjeri', 'projeri', 'istraži', 'istrazi',
  'prouči', 'prouci', 'revidiraj', 'ažuriraj', 'azuriraj', 'osvježi', 'osvjezi', 'pokreni', 'pusti',
  'nastavi', 'kreni', 'testiraj', 'probaj', 'pokušaj', 'pokusaj', 'instaliraj', 'podesi', 'namjesti',
  'postavi', 'otvori', 'zatvori', 'izdvoji', 'obriši', 'obrisi', 'makni', 'ukloni', 'promijeni',
  'izmijeni', 'izmjeni', 'preimenuj', 'prebaci', 'sinkroniziraj', 'sinhroniziraj', 'generiraj',
  'kreiraj', 'implementiraj', 'napiši', 'napisi', 'pronađi', 'pronadji', 'potraži', 'potrazi',
  'pretraži', 'pretrazi', 'odradi', 'riješi', 'rijesi', 'pripremi', 'konvertiraj', 'pretvori',
  'spremi', 'podijeli', 'resetiraj', 'restartaj', 'uredi', 'složi', 'slozi', 'ugradi', 'zadaj',
  'dodijeli', 'pogledaj', 'analiziraj', 'integriraj', 'dokumentiraj', 'skeniraj', 'preuzmi',
  'podigni', 'migriraj', 'refaktoriraj', 'izvezi', 'uvezi', 'priloži', 'prilozi', 'odgovori',
  'ponovi', 'popuni', 'dovrši', 'dovrsi', 'zamijeni', 'prilagodi', 'snimi', 'objavi', 'pomakni',
  'izvuci', 'izvući', 'izdvoji', 'ispuni', 'počisti', 'pocisti', 'opiši', 'opisi', 'kloniraj',
  'umetni', 'izračunaj', 'izracunaj', 'pregledaj', 'skrati', 'prevedi',
]

/** Nepravilni infinitivi koje pravilo „-i → -iti" ne izvodi („probaš pronaći", „možeš li poslati"). */
const NEPRAVILNI_INFINITIVI = ['pronaći', 'pronaci', 'naći', 'naci', 'poslati', 'pomaknuti', 'izvući', 'izvuci', 'otići']

function obliciGlagola(osnova: string): string[] {
  const o = [osnova, osnova + 'te', osnova + 'mo']
  o.push(osnova.endsWith('j') ? osnova.slice(0, -1) + 'ti' : osnova + 'ti')
  return o
}

const RE_GLAGOL = new RegExp(
  `(?<![${L}])(?:${[...new Set([...GLAGOLI_NALOGA.flatMap(obliciGlagola), ...NEPRAVILNI_INFINITIVI])].join('|')})(?![${L}])`, 'u')

/**
 * Samo imperativ (2. lice jednine i množine). U PITANJU je to jedini oblik koji traži rad:
 * „kako da otvorim… trebamo otvoriti?" i „da napravimo…?" su razgovor o poslu, „provjeri…?"
 * i „možeš li provjeriti…?" su nalog (v. RE_MOZES_LI).
 */
const RE_IMPERATIV = new RegExp(
  `(?<![${L}])(?:${[...new Set(GLAGOLI_NALOGA.flatMap(g => [g, g + 'te']))].join('|')})(?![${L}])`, 'u')
const RE_MOZES_LI = /(?:možeš|mozes|možete|mozete|probaš|probas|mogu|možemo|mozemo)\s+li|(?:možeš|mozes|možete|mozete)\s+(?:mi|nam)\s|molim te|molim vas/u

/**
 * Prijava kvara bez glagola („na pdf-u imam crveni overlay", „i dalje je problem reporting",
 * „žig je problematičan") — Goran očekuje popravak, ne objašnjenje.
 */
const RE_PROBLEM = new RegExp(
  `(?<![${L}])(?:problem|problema|problematičan|problematican|problematičn|ne radi|ne rade|ne valja|ne prolazi|ne odradi|ne desi|greška|greska|grešku|gresku|pokvar|zapelo|zapeo|zaglavljuje|ne smije|nije u redu|nije dobro|nisi dobro|nije ispravan|nije ispravno|krivo)`, 'u')

const RE_ENGLESKI_NALOG = new RegExp(
  `(?<![${L}])(?:implement|fix|create|build|research|investigate|check|test|add|update|deploy|please)(?![${L}])`, 'u')

/** Modal, delegacija, poticaj — nalog SAMO izvan pitanja („da li treba…?" nije nalog). */
const RE_MODAL = new RegExp(
  `(?<![${L}])(?<!ne )(?:treba|trebam|trebamo|trebaju|trebalo|trebali|trebao|trebat|moraš|moras|morate|moramo|neka|ajmo|hajde|idemo|htio bih|htio bi|želim|zelim|molim)(?![${L}])`, 'u')

const AGENTI: Array<[RegExp, string]> = [
  [/(?<![\p{L}])jelen[aeiu](?![\p{L}])/u, 'izrada'],
  [/(?<![\p{L}])kosjenk[aeiu]|kosijenk/u, 'arhitektura'],
  [/(?<![\p{L}])grg[aeiu](?![\p{L}])/u, 'dizajn'],
  [/(?<![\p{L}])git[aeiu](?![\p{L}])/u, 'ilustracija'],
  [/(?<![\p{L}])mand[aeiu](?![\p{L}])|mandin/u, 'istrazivanje'],
  [/(?<![\p{L}])malik/u, 'sigurnost'],
  [/(?<![\p{L}])potjeh/u, 'qa'],
  [/(?<![\p{L}])dor[aeiu](?![\p{L}])/u, 'analiza'],
]

/**
 * Delegacija agentu: „daj Grgi", „pošalji Jeleni", „dati Maliku", „neka Kosjenka", „Kosjenka neka".
 * SAMO delegirani agent je struka. Spomen agenta kao predmeta („što je Jelena zaključila",
 * „pusti Jelenu da dovrši") je upravljanje poslom koji već teče — mjereno: s brojanjem
 * svakog spomena je 29 % lažnih lanaca u uzorku bilo upravo to.
 */
const AGENT_KORIJEN = '(?:jelen|kosjenk|kosijenk|grg|git|mand|malik|potjeh|dor)'
const RE_DELEGACIJA = new RegExp(
  `(?<![${L}])(?:daj|dajte|dati|pošalji|posalji|proslijedi|reci|javi|neka|nek|nake|zadaj)\\s+(?:\\p{L}+\\s+)?${AGENT_KORIJEN}` +
  `|${AGENT_KORIJEN}\\p{L}*\\s+(?:neka|nek|treba|mora|napravi|istraži|istrazi|provjeri|testira|dizajnira|pregleda)`, 'u')
const RE_DELEGACIJA_G = new RegExp(RE_DELEGACIJA.source, 'gu')

/**
 * Uputa zadatku koji već radi („upiši joj u zadatak", „dodaj mu još", „na task koji je Grga
 * dovršio dodaj"). Po pravilu 22 to je `POST /api/tasks/<ID>/uputa`, ne novi lanac — razred
 * se zato reže na jednog izvršitelja.
 */
const RE_UPUTA = /(?<![\p{L}])(?:upiši|upisi|dodaj|reci|javi|napiši|napisi)\s+(?:joj|mu|im|njoj|njemu|njima)(?![\p{L}])|(?:u|na)\s+(?:njen|njezin|njegov|taj|isti)\s+(?:zadatak|task)|na task koji/u

/** Struka → rječnik. Broje se RAZLIČITE struke, ne pogoci. */
const STRUKE: Record<string, RegExp> = {
  istrazivanje: /istraž|istraz|research|reasearch|prouč|prouc/u,
  analiza: /analiz|usporedb|izvješt|izvjest|(?<![\p{L}])report/u,
  dizajn: /dizajn|design|izgled(?:(?![\p{L}])|u|om|aju)|poravn|align|aligement|layout|templat|predlož|predloz|vizual|slide|prezentac|estet|artist|sučelj|sucelj|(?<![\p{L}])ui(?![\p{L}])|(?<![\p{L}])ux(?![\p{L}])|drag and drop|retro|futuris|landscape|grafičk|grafick/u,
  ilustracija: /ilustr|ilistr|(?<![\p{L}])ikon|excalidr|excelidr|crtež|crtez/u,
  // Opći glagoli („napravi", „popravi", „izradi") NAMJERNO nisu ovdje: gotovo svaki nalog ih
  // ima, pa bi izrada bila struka svake poruke i svaki nalog s jednom drugom riječju postao
  // bi lanac (mjereno: 162 od 195 lažnih lanaca u prvom prolazu). Izrada se broji samo po
  // TEHNIČKOM PREDMETU rada. Gola riječ „kod" se ne broji — u hrvatskom je češće prijedlog
  // („kod Patricka", „kod reseta") nego programski kod.
  izrada: /implement|skript|(?<![\p{L}])(?:koda|kodu|izvorni kod|source)(?![\p{L}])|(?<![\p{L}])build|integrac|integrir|docx|konvert|generir|automatiz|uređivač|uredjivac|razvij|deploy|instalir|(?<![\p{L}])fix|(?<![\p{L}])code/u,
  qa: /testir|(?<![\p{L}])test|(?<![\p{L}])qa(?![\p{L}])|revidir|reviz|verific|verifik|identič|identic|regresij/u,
  sigurnost: /sigurn|osigura|ranjiv|security|(?<![\p{L}])napad|ovlast|pentest/u,
  dokumentacija: /dokumentac|dokuentac|readme|(?<![\p{L}])uput[aeiu](?![\p{L}])/u,
  arhitektura: /arhitekt|workflow|(?<![\p{L}])tijek|(?<![\p{L}])tjek|struktur|koncept/u,
}

/** Izričit zahtjev za više agenata/zadataka — najmanje dvije struke. */
const RE_LANAC_IZRICITO = /kroz task ?manager|agentima|set zadataka|po novim pravilima|svaki od \S+ agenta/u

/** Pitanje: upitna riječ na početku rečenice ili dijela iza crtice, ili upitnik bilo gdje. */
const RE_PITANJE = new RegExp(
  `^(?:da li|je li|jel|jesu li|jesmo li|ima li|imaš li|imas li|imamo li|kako|što|sto|gdje|zašto|zasto|koji|koja|koje|koliko|kada|kad|tko|čemu|cemu)(?![${L}])` +
  // Usred poruke (iza crtice/točke) samo JAKI upitni oblici: „koji", „što", „kad" iza zareza
  // su u hrvatskom najčešće odnosne zamjenice („dokument koji sam poslala"), ne pitanje.
  `|[-–—.;:!]\\s*(?:da li|je li|jel|jesu li|jesmo li|ima li|imaš li|imas li|imamo li)(?![${L}])|\\?`, 'u')

/** Kratka suglasnost na početku poruke — kandidat za nastavak posla. */
const RE_SUGLASNOST = new RegExp(
  `^(?:ok|okej|može|moze|da|slažem|slazem|ajmo|kreni|nastavi|pusti|super|odlično|odlicno|važi|vazi|u redu)(?![${L}])`, 'u')

/**
 * Početak zalijepljenog ispisa. Most poruku spaja u jedan redak, pa se ne može rezati
 * po recima — reže se od PRVOG biljega do kraja (ispis je u praksi uvijek na kraju).
 */
const RE_ISPIS = /[\w.-]+@[\w.-]+:[~/][^\s]*\$|\[sudo\]|INFO -- :|NOTICE:|\d{4}[/-]\d\d[/-]\d\d[ T]\d\d:\d\d:\d\d|\{"method"|Traceback \(most recent|(?<![\p{L}])[IWE], \[\d{4}-/u

export interface Znacajke {
  /** Ljudski dio poruke (bez zalijepljenog ispisa). */
  ljudskiDio: string
  /** Koliko je znakova odrezano kao ispis. */
  odrezanoIspisa: number
  pitanje: boolean
  nalog: boolean
  nalogIzvor: 'glagol' | 'modal' | 'delegacija' | 'problem' | 'nastavak' | null
  struke: string[]
  lanacIzricito: boolean
  nastavak: boolean
  /** Uputa zadatku u radu (pravilo 22) — najviše jedan izvršitelj. */
  uputa: boolean
}

export interface PrethodniZapis {
  ts: string
  tezina: number
  biOtvorioZadatak: boolean
}

export function izvuciZnacajke(cisto: string, kal: Kalibracija, kontekst: {
  ts?: string; prethodni?: PrethodniZapis[]
} = {}): Znacajke {
  const m = cisto.match(RE_ISPIS)
  const ljudskiDio = (m && m.index !== undefined ? cisto.slice(0, m.index) : cisto).trim()
  const t = ljudskiDio.toLowerCase()

  const pitanje = RE_PITANJE.test(t)
  let nalogIzvor: Znacajke['nalogIzvor'] = null
  const glagol = pitanje
    ? RE_IMPERATIV.test(t) || (RE_MOZES_LI.test(t) && RE_GLAGOL.test(t))
    : RE_GLAGOL.test(t) || RE_ENGLESKI_NALOG.test(t)
  if (glagol) nalogIzvor = 'glagol'
  else if (RE_DELEGACIJA.test(t)) nalogIzvor = 'delegacija'
  else if (!pitanje && RE_MODAL.test(t)) nalogIzvor = 'modal'
  else if (!pitanje && RE_PROBLEM.test(t)) nalogIzvor = 'problem'

  // Nastavak: „ok", „može", „ajmo" nakon naloga iste grupe — posao se nastavlja, nije razgovor.
  let nastavak = false
  if (!nalogIzvor && !pitanje && t.length <= kal.nastavakDuljina && RE_SUGLASNOST.test(t) &&
      kontekst.ts && kontekst.prethodni?.length) {
    const sad = Date.parse(kontekst.ts)
    nastavak = kontekst.prethodni.some(p => p.biOtvorioZadatak &&
      sad - Date.parse(p.ts) >= 0 && sad - Date.parse(p.ts) <= kal.nastavakMinuta * 60_000)
    if (nastavak) nalogIzvor = 'nastavak'
  }

  const struke = new Set<string>()
  const lanacIzricito = RE_LANAC_IZRICITO.test(t)
  if (nalogIzvor) {
    for (const [ime, re] of Object.entries(STRUKE)) if (re.test(t)) struke.add(ime)
    for (const m of t.matchAll(RE_DELEGACIJA_G)) {
      for (const [re, struka] of AGENTI) if (re.test(m[0])) struke.add(struka)
    }
  }
  const uputa = nalogIzvor !== null && RE_UPUTA.test(t)
  return {
    ljudskiDio, odrezanoIspisa: cisto.length - ljudskiDio.length, pitanje,
    nalog: nalogIzvor !== null, nalogIzvor, struke: [...struke].sort(), lanacIzricito, nastavak, uputa,
  }
}

/** Razred iz značajki — jedino mjesto gdje se struke pretvaraju u E1–E5. */
export function razredIzZnacajki(z: Znacajke, kal: Kalibracija): EffortTier {
  if (!z.nalog) return kal.razredBezNaloga
  if (z.uputa) return kal.razredPoStrukama[1]
  const n = Math.max(z.struke.length, z.lanacIzricito ? 2 : 0)
  return kal.razredPoStrukama[Math.min(4, n)]
}

export function opisZnacajki(z: Znacajke): string {
  const dijelovi = [z.nalog ? `nalog (${z.nalogIzvor})` : (z.pitanje ? 'pitanje' : 'bez naloga')]
  if (z.struke.length) dijelovi.push(`struke ${z.struke.length}: ${z.struke.join(', ')}`)
  if (z.lanacIzricito) dijelovi.push('izričit lanac')
  if (z.uputa) dijelovi.push('uputa zadatku u radu')
  if (z.odrezanoIspisa) dijelovi.push(`odrezan ispis ${z.odrezanoIspisa} zn.`)
  return dijelovi.join('; ')
}

/**
 * Zadnji zapisi sjene iste grupe — kontekst za „nastavak". Čita samo REP dnevnika
 * (zadnjih 64 KB), jer stoji na vrućem putu; kvar → prazan kontekst, nikad iznimka.
 */
export function zadnjiZapisiGrupe(chatId: string | number, logPath: string, najvise = 5): PrethodniZapis[] {
  try {
    if (!existsSync(logPath)) return []
    const fd = openSync(logPath, 'r')
    try {
      const vel = fstatSync(fd).size
      const duz = Math.min(vel, 65536)
      const buf = Buffer.alloc(duz)
      readSync(fd, buf, 0, duz, vel - duz)
      // Prvi redak je odrezan samo kad čitanje NE počinje od početka datoteke.
      const redci = buf.toString('utf-8').split('\n').slice(vel > duz ? 1 : 0).filter(Boolean)
      const izlaz: PrethodniZapis[] = []
      for (let i = redci.length - 1; i >= 0 && izlaz.length < najvise; i--) {
        try {
          const r = JSON.parse(redci[i])
          if (String(r.chatId) === String(chatId)) {
            izlaz.push({ ts: r.ts, tezina: r.tezina, biOtvorioZadatak: !!r.biOtvorioZadatak })
          }
        } catch { /* poluzapisan redak */ }
      }
      return izlaz
    } finally { closeSync(fd) }
  } catch {
    return []
  }
}
