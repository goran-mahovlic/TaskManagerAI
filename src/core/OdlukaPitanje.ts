/**
 * OdlukaPitanje.ts — strukturirano pitanje uz zadatak koji ceka ljudsku odluku.
 *
 * POVOD (vlasnik, 05.09.2026.): „Dio sa blokiranjem zadataka mi se ne svidja. (…) pitanje mora
 * biti postavljeno tako da ima opcije, jer samo u slucaju da model ima dilemu izmedju A i B ili
 * ABC ili ABCD treba to staviti u blokadu uz pitanje. To moze napraviti rijetko. Uz opcije mora
 * navesti koji strucnjak mu odgovara, tako da ako je ukljucen AI odgovor moze znati sto treba.
 * Znaci pitanje mora ukljucivati: Trebam eksperta za xxx, daj mi sa svog strucnog stajalista
 * objasni xxx i pomozi da donesem odluku o xxx."
 *
 * Do sada je zadatak s oznakom `needs-decision` nosio samo prozu iz opisa — covjek je morao
 * procitati 400 znakova specifikacije da bi pogodio sto se od njega trazi, a `odlucitelj`
 * (lokalni model umjesto covjeka) nije imao ni ulogu ni ponudjene ishode. Zato je pitanje
 * sada zaseban, strojno citljiv blok s tocno tri obavezna dijela: STRUKA, PITANJE, OPCIJE.
 *
 * Blok zivi u opisu zadatka (ili u zadnjoj biljesci) jer je opis jedino polje koje prezivi
 * svaki put — API, izvoz, RAG i transkript. Nema nove tablice ni nove sheme.
 *
 * OBLIK (tocno ovaj, jer ga citaju i covjek i stroj):
 *
 *   ❓ PITANJE ZA ODLUKU
 *   Trebam eksperta za: sigurnost mreznih usluga
 *   Objasni mi sa svog strucnog stajalista je li dovoljno vezati posluzitelj na 127.0.0.1 i
 *   pomozi mi da donesem odluku o nacinu izlaganja.
 *   A) Samo 127.0.0.1 — najsigurnije, ali node-B ne moze doci
 *   B) 0.0.0.0 uz ACL po IP-u — radi za node-B, treba odrzavati popis
 *   Preporuka: B — node-B je uvjet zadatka, ACL je mjerljiv
 *   ─── kraj pitanja ───
 */

export interface OdlukaOpcija {
  /** Slovo opcije, uvijek veliko: A, B, C, D… */
  oznaka: string
  tekst: string
}

export interface OdlukaPitanje {
  /** Struka koja odgovara na pitanje — ulazi u ulogu modela kad odgovara `odlucitelj`. */
  ekspert: string
  /** Sam upit, bez opcija. */
  pitanje: string
  opcije: OdlukaOpcija[]
  /** Neobavezno: sto agent preporuca i zasto. Ne zamjenjuje odluku. */
  preporuka?: string
  /** Izvorni blok kakav stoji u tekstu — za prikaz „kako je agent napisao". */
  sirovo: string
}

export const BILJEG_PITANJA = 'PITANJE ZA ODLUKU'
export const KRAJ_PITANJA = '─── kraj pitanja ───'

/** Najvise opcija koje ima smisla ponuditi; iznad toga to vise nije dilema nego istrazivanje. */
export const MAX_OPCIJA = 6

const RE_BILJEG = /^\s*(?:[#>*\-\s]*)(?:❓\s*)?PITANJE ZA ODLUKU\s*:?\s*$/i
const RE_EKSPERT = /^\s*(?:[-*]\s*)?Trebam\s+eksperta\s+za\s*:?\s*(.+?)\s*$/i
const RE_OPCIJA = /^\s*(?:[-*]\s*)?([A-Za-z])\s*[\)\.]\s+(.+?)\s*$/
const RE_PREPORUKA = /^\s*(?:[-*]\s*)?Preporuka\s*:?\s*(.+?)\s*$/i
const RE_KRAJ = /^\s*(?:───\s*kraj pitanja\s*───|---+|===+)\s*$/

/**
 * Sastavi blok iz dijelova. Koristi ga agent (preko `POST /api/tasks/:id/pitanje`) i svatko
 * tko pitanje pise rucno — da oblik ostane jedan jedini.
 */
export function sastaviPitanje(p: {
  ekspert: string
  pitanje: string
  opcije: Array<OdlukaOpcija | string>
  preporuka?: string
}): string {
  const opcije = normalizirajOpcije(p.opcije)
  const redci = [
    `❓ ${BILJEG_PITANJA}`,
    `Trebam eksperta za: ${jednaLinija(p.ekspert)}`,
    String(p.pitanje || '').trim(),
    ...opcije.map(o => `${o.oznaka}) ${o.tekst}`),
  ]
  if (p.preporuka && String(p.preporuka).trim()) {
    redci.push(`Preporuka: ${jednaLinija(p.preporuka)}`)
  }
  redci.push(KRAJ_PITANJA)
  return redci.join('\n')
}

/**
 * Izvuci blok iz proizvoljnog teksta (opis zadatka, biljeska, agentov odgovor).
 * Vraca `null` kad bloka nema — to NIJE greska, nego „pitanje jos nije postavljeno".
 * Kad blok postoji ali je manjkav, vraca ono sto je nasao; ispravnost provjerava
 * `provjeriPitanje()`, da se u sucelju vidi tocno sto fali.
 */
export function rasclaniPitanje(tekst: string | null | undefined): OdlukaPitanje | null {
  if (!tekst) return null
  const svi = String(tekst).split(/\r?\n/)
  // Zadnji blok pobjedjuje: ako je agent pitanje ispravio, ispravak je nize u tekstu.
  let pocetak = -1
  for (let i = svi.length - 1; i >= 0; i--) {
    if (RE_BILJEG.test(svi[i])) { pocetak = i; break }
  }
  if (pocetak < 0) return null

  const blok: string[] = []
  for (let i = pocetak + 1; i < svi.length; i++) {
    if (RE_KRAJ.test(svi[i])) break
    if (RE_BILJEG.test(svi[i])) break
    blok.push(svi[i])
  }

  let ekspert = ''
  let preporuka = ''
  const opcije: OdlukaOpcija[] = []
  const pitanje: string[] = []

  for (const red of blok) {
    const mE = red.match(RE_EKSPERT)
    if (mE && !ekspert) { ekspert = mE[1].trim(); continue }
    const mP = red.match(RE_PREPORUKA)
    if (mP && !preporuka) { preporuka = mP[1].trim(); continue }
    const mO = red.match(RE_OPCIJA)
    // Opcija je red koji POCINJE slovom i zagradom. Recenica koja slucajno pocinje s „A) "
    // ne postoji u praksi, a red poput „Ako…" nema zagradu pa ne prolazi.
    if (mO) { opcije.push({ oznaka: mO[1].toUpperCase(), tekst: mO[2].trim() }); continue }
    if (red.trim()) pitanje.push(red.trim())
  }

  return {
    ekspert,
    pitanje: pitanje.join('\n').trim(),
    opcije,
    ...(preporuka ? { preporuka } : {}),
    sirovo: [svi[pocetak].trim(), ...blok].join('\n').trim(),
  }
}

/**
 * Je li pitanje postavljeno po pravilu? Vraca popis nedostataka na hrvatskom, jer isti tekst
 * ide i agentu (HTTP 400) i covjeku (upozorenje na plocu).
 */
export function provjeriPitanje(p: Partial<OdlukaPitanje> | null): { ok: boolean; greske: string[] } {
  const greske: string[] = []
  if (!p) return { ok: false, greske: ['Pitanje nije postavljeno — nema bloka „PITANJE ZA ODLUKU".'] }
  if (!String(p.ekspert || '').trim()) {
    greske.push('Nedostaje redak „Trebam eksperta za: <struka>" — bez struke odgovarac ne zna u kojoj ulozi odgovara.')
  }
  if (!String(p.pitanje || '').trim()) {
    greske.push('Nedostaje sam upit — napisi sto treba objasniti i o cemu se odlucuje.')
  }
  const opcije = p.opcije || []
  if (opcije.length < 2) {
    greske.push('Treba najmanje DVIJE opcije (A, B…) — ako opcija nema, to nije dilema nego posao koji treba obaviti.')
  }
  if (opcije.length > MAX_OPCIJA) {
    greske.push(`Previse opcija (${opcije.length}) — najvise ${MAX_OPCIJA}; iznad toga to nije odluka nego istrazivanje.`)
  }
  const oznake = opcije.map(o => String(o.oznaka || '').toUpperCase())
  if (new Set(oznake).size !== oznake.length) {
    greske.push('Oznake opcija se ponavljaju — svaka mora imati svoje slovo.')
  }
  for (const o of opcije) {
    if (!String(o.tekst || '').trim()) {
      greske.push(`Opcija ${o.oznaka} nema tekst.`)
      break
    }
  }
  return { ok: greske.length === 0, greske }
}

/**
 * Vrati tekst BEZ blokova pitanja — za prikaz opisa ispod vec iscrtanog pitanja.
 * Bez ovoga se isto pitanje na ploci vidi dvaput (jednom kao gumbi, jednom kao proza).
 */
export function ukloniPitanje(tekst: string | null | undefined): string {
  if (!tekst) return ''
  const svi = String(tekst).split(/\r?\n/)
  const izlaz: string[] = []
  let uBloku = false
  for (const red of svi) {
    if (RE_BILJEG.test(red)) { uBloku = true; continue }
    if (uBloku) {
      // Blok zavrsava izricitom crtom ili prvim praznim redom nakon opcija — sto prije dodje.
      if (RE_KRAJ.test(red)) { uBloku = false; continue }
      if (!red.trim()) { uBloku = false }
      continue
    }
    izlaz.push(red)
  }
  return izlaz.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Odgovor covjeka na slovo opcije („B" ili „b) ACL po IP-u") razrijesi u punu recenicu, da u
 * `progress_notes` ne ostane samo slovo koje za pola godine nitko nece znati procitati.
 */
export function razrijesiOdgovor(odgovor: string, p: OdlukaPitanje | null): string {
  const cist = String(odgovor || '').trim()
  if (!p || !p.opcije.length) return cist
  const m = cist.match(/^([A-Za-z])\s*[\)\.\:]?\s*$/)
  if (!m) return cist
  const nadjena = p.opcije.find(o => o.oznaka === m[1].toUpperCase())
  return nadjena ? `${nadjena.oznaka}) ${nadjena.tekst}` : cist
}

/** Uloga za `odlucitelj` model — doslovno ono sto je vlasnik trazio da pitanje nosi sa sobom. */
export function ulogaZaModel(p: OdlukaPitanje | null): string | null {
  if (!p || !p.ekspert) return null
  return `Ti si ekspert za ${p.ekspert}. Sa svog strucnog stajalista objasni predmet pitanja i `
    + 'pomozi da se donese odluka — odgovori slovom jedne od ponudjenih opcija i kratkim obrazlozenjem.'
}

function normalizirajOpcije(ulaz: Array<OdlukaOpcija | string>): OdlukaOpcija[] {
  const abeceda = 'ABCDEFGHIJ'
  return (ulaz || []).slice(0, MAX_OPCIJA).map((o, i) => {
    if (typeof o === 'string') return { oznaka: abeceda[i], tekst: jednaLinija(o) }
    return {
      oznaka: String(o.oznaka || abeceda[i]).toUpperCase().slice(0, 1),
      tekst: jednaLinija(o.tekst),
    }
  })
}

/** Opcija mora stati u jedan red, inace je parser ne moze vratiti natrag. */
function jednaLinija(s: string): string {
  return String(s == null ? '' : s).replace(/\s*\r?\n\s*/g, ' ').trim()
}
