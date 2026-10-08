// TASK-5346: jedna skupina postavki = jedan „Spremi”.
//
// Config stranica je dosad imala „Spremi” (ili spremanje na promjenu) uz SVAKO polje: mail se
// podešavao u pet zapisa, a između njih je na disku stajala polovična postavka (novi poslužitelj,
// stara vrata). Ovdje je jedini put spremanja skupine:
//   • cijela skupina dolazi JEDNIM pozivom (`{ polja: {...}, by }`) i provjerava se CIJELA prije
//     prvog upisa — ako ijedno polje ne prođe, ne zapisuje se ništa, a pogreška ide uz polje;
//   • upis je jedan poziv `save` modula (atomičan upis datoteke u modulu);
//   • JEDAN redak u `settings_history` po spremanju: key `skupina.<ime>`, new_value = popis
//     PROMIJENJENIH ključeva — nikad vrijednosti (tajne iz TASK-5342/5343 ne smiju u audit);
//   • polje tajne poslano prazno znači „ne mijenjaj” i uklanja se prije provjere.
// Postojeći PUT-ovi po kartici ostaju radi kompatibilnosti; sučelje šalje skupinu ovuda.
import type { Database } from 'bun:sqlite'

export interface SkupinaZapis {
  /** Trenutačne postavke s diska (puna vrijednost, uključujući tajne — ne izlazi van). */
  load: () => any
  /** Provjera zakrpe; `trenutno` služi provjerama koje gledaju i ono što je na disku (pragovi A ≤ B ≤ C). */
  validate: (zakrpa: unknown, trenutno: any) => { ok: boolean; greske: string[]; zakrpa: any }
  /** Jedan upis cijele zakrpe; vraća nove postavke. */
  save: (zakrpa: any) => any
  /** Staze polja tajni: prazno = ne mijenjaj, vrijednost nikad u audit ni odgovor. */
  tajne?: string[]
  /** Prilagodba provjerene zakrpe prije upisa (npr. novi davatelj → zadani model). */
  pripremi?: (zakrpa: any, trenutno: any) => any
  /** Sigurni prikaz postavki za odgovor (bez vrijednosti tajni). Bez njega se vraćaju samo ključevi. */
  odgovor?: (postavke: any) => any
  /** Radnja nakon uspješnog upisa (npr. usklađivanje pollera); greška ovdje ne poništava upis. */
  poslije?: (postavke: any, prije: any) => void
}

export interface IshodSkupine {
  status: number
  tijelo: any
}

const jeObjekt = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Dio staze koji bi `postavi` odveo u prototip (JSON.parse daje vlastiti ključ `__proto__`). */
const ZABRANJENI_DIJELOVI = new Set(['__proto__', 'constructor', 'prototype'])
const zabranjenaStaza = (o: Record<string, any>): boolean =>
  Object.keys(o).some(k => ZABRANJENI_DIJELOVI.has(k) || (jeObjekt(o[k]) && zabranjenaStaza(o[k])))

/** Staze listova zakrpe (`smtp.port`); popis je list, kao i prazan objekt. */
export function listovi(o: Record<string, any>, prefiks = ''): string[] {
  const van: string[] = []
  for (const [k, v] of Object.entries(o)) {
    const staza = prefiks + k
    if (jeObjekt(v) && Object.keys(v).length) van.push(...listovi(v, staza + '.'))
    else van.push(staza)
  }
  return van
}

function dohvati(o: any, staza: string): any {
  let t = o
  for (const d of staza.split('.')) {
    if (!jeObjekt(t) || !Object.hasOwn(t, d)) return undefined
    t = t[d]
  }
  return t
}

function postavi(o: Record<string, any>, staza: string, v: unknown): void {
  const d = staza.split('.')
  let t = o
  for (const k of d.slice(0, -1)) { if (!Object.hasOwn(t, k) || !jeObjekt(t[k])) t[k] = {}; t = t[k] }
  t[d[d.length - 1]!] = v
}

function ukloni(o: Record<string, any>, staza: string): void {
  const d = staza.split('.')
  const roditelji: Array<Record<string, any>> = [o]
  let t: any = o
  for (const k of d.slice(0, -1)) { if (!jeObjekt(t[k])) return; t = t[k]; roditelji.push(t) }
  delete t[d[d.length - 1]!]
  // prazni roditelji (npr. `smtp: {}` nakon uklanjanja jedine tajne) ne smiju ostati u zakrpi
  for (let i = d.length - 2; i >= 0; i--) {
    const r = roditelji[i]!
    const k = d[i]!
    if (jeObjekt(r[k]) && !Object.keys(r[k]).length) delete r[k]
  }
}

/** Zakrpa samo s jednim listom — za pripisivanje pogreške polju. */
function samoList(zakrpa: Record<string, any>, staza: string): Record<string, any> {
  const o: Record<string, any> = {}
  postavi(o, staza, dohvati(zakrpa, staza))
  return o
}

export function upisiAuditSkupine(db: Database, ime: string, kljucevi: string[], by: string): void {
  db.query('INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, NULL, ?, ?, ?)')
    .run(`skupina.${ime}`, JSON.stringify({ kljucevi }), by, 'config-skupina')
}

/**
 * Spremi skupinu: provjeri sve → (ako je sve valjano) jedan upis → jedan audit redak.
 * `db` je baza ploče sa `settings_history`; audit ide tek NAKON uspješnog upisa.
 */
export function spremiSkupinu(ime: string, zapis: SkupinaZapis, tijelo: unknown, db: Database): IshodSkupine {
  if (!jeObjekt(tijelo) || !jeObjekt(tijelo.polja)) {
    return { status: 400, tijelo: { ok: false, error: 'tijelo mora biti {"polja": {...}}', greske: ['tijelo mora biti {"polja": {...}}'], greskePoPolju: {} } }
  }
  if (zabranjenaStaza(tijelo.polja)) {
    return { status: 400, tijelo: { ok: false, error: 'nedopušteno ime polja', greske: ['nedopušteno ime polja'], greskePoPolju: {} } }
  }
  const by = typeof tijelo.by === 'string' && tijelo.by.trim() ? tijelo.by.trim().slice(0, 64) : 'config'
  const zakrpa = structuredClone(tijelo.polja) as Record<string, any>
  for (const t of zapis.tajne || []) {
    const v = dohvati(zakrpa, t)
    if (v === '' || v === null) ukloni(zakrpa, t)
  }
  const prije = zapis.load()
  const sigurno = (p: any) => (zapis.odgovor ? zapis.odgovor(p) : undefined)
  if (!Object.keys(zakrpa).length) {
    return { status: 200, tijelo: { ok: true, promijenjeno: [], postavke: sigurno(prije) } }
  }

  const provjera = zapis.validate(zakrpa, prije)
  if (!provjera.ok) {
    const greskePoPolju: Record<string, string[]> = {}
    const pripisane = new Set<string>()
    for (const staza of listovi(zakrpa)) {
      const p = zapis.validate(samoList(zakrpa, staza), prije)
      const svoje = p.ok ? [] : p.greske.filter(g => g !== 'Nijedna postavka nije poslana')
      // i pogreška cijele skupine koja počinje stazom polja pripada tom polju
      for (const g of provjera.greske) if (g.startsWith(staza) && !svoje.includes(g)) svoje.push(g)
      if (svoje.length) { greskePoPolju[staza] = svoje; svoje.forEach(g => pripisane.add(g)) }
    }
    const opce = provjera.greske.filter(g => !pripisane.has(g))
    return {
      status: 400,
      tijelo: { ok: false, error: provjera.greske.join('; '), greske: provjera.greske, greskePoPolju, opce },
    }
  }

  let poslije: any
  try {
    const z = zapis.pripremi ? zapis.pripremi(provjera.zakrpa, prije) : provjera.zakrpa
    poslije = zapis.save(z)
  } catch (e) {
    return { status: 500, tijelo: { ok: false, error: `spremanje nije uspjelo: ${String((e as Error)?.message || e)}` } }
  }
  if (poslije === undefined) poslije = zapis.load()

  // Tajna poslana s vrijednošću je promjena po definiciji: modul ju često seli iz postavki u
  // spremište vjerodajnica (Telegram token), pa usporedba prije/poslije ne bi ništa vidjela.
  const tajne = new Set(zapis.tajne || [])
  const promijenjeno = listovi(provjera.zakrpa)
    .filter(s => tajne.has(s) || JSON.stringify(dohvati(prije, s)) !== JSON.stringify(dohvati(poslije, s)))
    .sort()
  if (promijenjeno.length) upisiAuditSkupine(db, ime, promijenjeno, by)
  try { zapis.poslije?.(poslije, prije) } catch { /* upis je prošao; popratna radnja ga ne poništava */ }
  return { status: 200, tijelo: { ok: true, promijenjeno, postavke: sigurno(poslije) } }
}
