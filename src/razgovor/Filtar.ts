// ─── Filtar obraćanja (ADR-0002 §5) ──────────────────────────────────────────
// Treba li bot uopće odgovoriti. Primjenjuje se NAKON filtara ulaza (dopušteni chatovi) i
// nakon ingesta. Je li poruka upućena botu (spomen, ime, odgovor na bota) računa ADAPTER
// kanala — ovdje se samo čita `obracanjeBotu`.
//
// Autorica: Jelena (Engineer), TASK-5277; dopusteni-sve i tišina za drugoga TASK-5283;
// URL/e-mail/kod i vlasnikovo ime TASK-5373.

import type { UlaznaPoruka } from './Kanal'
import type { RazgovorPostavke } from './RazgovorPostavke'

/** Mala slova bez dijakritike: „Šaban" → „saban", „Đuro" → „duro". */
export function normaliziraj(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
}

/**
 * Počinje li poruka imenom bota (bez obzira na veličinu slova i dijakritiku), i u padežu:
 * „Šabane, …" (vokativ) i „Šabanu …" su obraćanje kao i „Šaban, …" — najviše 3 slova
 * nastavka, kao kod `sadrziRijec`. Bez toga je „Šabane da li vidiš korisnika Bubi" prošla
 * kao poruka za drugoga (sadrži „Bubi") i bot je šutio (TASK-5285).
 */
export function pocinjeImenom(tekst: string, ime: string): boolean {
  const i = normaliziraj(ime.trim())
  if (!i) return false
  const t = normaliziraj(tekst.trimStart())
  if (!t.startsWith(i)) return false
  const nastavak = t.slice(i.length).match(/^\p{L}*/u)![0]
  if (nastavak.length > MAX_NASTAVAK) return false
  const iza = t.charAt(i.length + nastavak.length)
  return iza === '' || !/[\p{L}\p{N}_]/u.test(iza)
}

/**
 * Je li pošiljatelj na popisu dopuštenih: po id-u ili po korisničkom imenu (bez `@`, bez
 * obzira na veličinu slova). Ploča prima oboje, a vlasnik prirodno upiše ime, ne broj —
 * usporedba samo po id-u ostavljala je bota tihim bez ikakvog traga.
 */
export function jeDopusten(p: Pick<UlaznaPoruka, 'posiljateljId' | 'posiljateljKorisnickoIme'>, dopusteni: string[]): boolean {
  const ime = (p.posiljateljKorisnickoIme || '').replace(/^@/, '').toLowerCase()
  return dopusteni.some(d => {
    const x = d.trim()
    if (x === p.posiljateljId) return true
    return !!ime && x.replace(/^@/, '').toLowerCase() === ime
  })
}

const bezEt = (x: string) => x.trim().replace(/^@/, '').toLowerCase()
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Najviše toliko slova smije slijediti korijen imena (padeži: Ivane, Ivanu, Ivanom, Bubiju). */
const MAX_NASTAVAK = 3

/**
 * Tekst bez URL-ova, e-mail adresa i `code` odsječaka (TASK-5373): u njima riječ nije
 * obraćanje — `https://primjer.org/?s=ivan` u vlasnikovom nalogu utišao je bota („Ivan").
 * Svaki izrezani dio postaje razmak, pa susjedne riječi ostaju odvojene.
 */
export function bezAdresaIKoda(tekst: string): string {
  return tekst
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu, ' ')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, ' ')
}

/**
 * Sadrži li tekst riječ s popisa BILO GDJE (odluka vlasnika, 06.10. 18:39), bez obzira na velika
 * slova i dijakritiku:
 *  - `@korisnicko_ime` → točno taj spomen (iza ne smije biti slovo, broj ni `_`);
 *  - ime → riječ koja POČINJE tim korijenom uz najviše 3 slova nastavka (padeži), a ispred
 *    nema slova („Divan" ne pogađa „Ivan", „Ivanovićevi" ne pogađa — predug nastavak).
 * Ne gleda unutar URL-ova, e-mail adresa ni `code` odsječaka (`bezAdresaIKoda`, TASK-5373).
 */
export function sadrziRijec(tekst: string, rijec: string): boolean {
  const r = normaliziraj(rijec.trim())
  if (!r || r === '@') return false
  const t = normaliziraj(bezAdresaIKoda(tekst))
  if (r.startsWith('@')) {
    return new RegExp(`(^|[^\\p{L}\\p{N}_@])${escRe(r)}(?![\\p{L}\\p{N}_])`, 'u').test(t)
  }
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escRe(r)}\\p{L}{0,${MAX_NASTAVAK}}(?![\\p{L}\\p{N}_])`, 'u').test(t)
}

/**
 * Je li poruka upućena NEKOM DRUGOM, a ne ovom botu (TASK-5283, ADR-0002 §15):
 *  - sadrži BILO GDJE riječ s popisa `preskociAkoSadrzi` (po korijenu, v. `sadrziRijec`), ili
 *    je odgovor (reply) na poruku korisnika s tog popisa (po korisničkom imenu ili imenu);
 *  - uz `tisinaKadDrugom`: bilo koji tuđi @spomen (bot ili čovjek) ili odgovor na tuđu poruku.
 * Izravno obraćanje OVOM botu (spomen, ime na početku, reply, privatni chat) uvijek pobjeđuje.
 * Vrijedi i za ulaz: poruka za drugoga ne otvara zadatak.
 */
export function jeZaDrugog(p: UlaznaPoruka, s: PostavkeFiltra): boolean {
  return razlogZaDrugog(p, s) !== null
}

type PostavkeFiltra = Pick<RazgovorPostavke, 'preskociAkoSadrzi' | 'tisinaKadDrugom'> &
  Partial<Pick<RazgovorPostavke, 'dopusteniKorisnici' | 'vlasnici'>>

/**
 * Vlasnik čvora = dopušteni korisnik razgovora koji je ujedno primatelj koda za tajne
 * (`vlasnici`, TASK-5373). Samo on dobiva iznimku za vlastito ime s popisa.
 */
export function jeVlasnik(p: Pick<UlaznaPoruka, 'posiljateljId' | 'posiljateljKorisnickoIme'>, s: Partial<Pick<RazgovorPostavke, 'dopusteniKorisnici' | 'vlasnici'>>): boolean {
  const v = s.vlasnici || []
  return v.length > 0 && v.includes(String(p.posiljateljId)) && jeDopusten(p, s.dopusteniKorisnici || [])
}

/** Je li unos s popisa vlastito ime/korisničko ime pošiljatelja („Ivan" u poruci OD Ivana). */
function vlastitoIme(p: UlaznaPoruka, unos: string): boolean {
  const e = bezEt(unos)
  if (p.posiljateljKorisnickoIme && bezEt(p.posiljateljKorisnickoIme) === e) return true
  return !unos.trim().startsWith('@') && sadrziRijec(p.posiljateljIme || '', unos)
}

/** Zašto je poruka za drugoga (za zapis i Konzolu, TASK-5285) — `null` kad nije. */
export function razlogZaDrugog(p: UlaznaPoruka, s: PostavkeFiltra): string | null {
  if (p.privatno || p.obracanjeBotu || p.izvor === 'bot') return null
  const spomeni = p.spomeni || []
  const o = p.odgovorNa && p.odgovorNa.id !== p.posiljateljId ? p.odgovorNa : undefined
  const vlasnik = jeVlasnik(p, s)
  for (const unos of s.preskociAkoSadrzi || []) {
    const e = bezEt(unos)
    if (!e) continue
    // Poruka OD vlasnika koja sadrži njegovo ime nije poruka ZA njega (TASK-5373).
    if (vlasnik && vlastitoIme(p, unos)) continue
    if (sadrziRijec(p.tekst, unos)) return `sadrži „${unos.trim()}"`
    if (unos.trim().startsWith('@') && spomeni.includes(e)) return `spominje ${unos.trim()}`
    if (o && (o.korisnickoIme === e || (!!o.ime && normaliziraj(o.ime.trim()) === normaliziraj(e)))) return `odgovor na poruku „${unos.trim()}"`
  }
  if (s.tisinaKadDrugom && spomeni.length > 0) return `tuđi spomen @${spomeni[0]}`
  if (s.tisinaKadDrugom && o) return `odgovor na tuđu poruku (${o.korisnickoIme || o.ime || o.id})`
  return null
}

export function trebaOdgovoriti(p: UlaznaPoruka, s: RazgovorPostavke): boolean {
  if (!s.ukljucen) return false
  // Jedina iznimka od „bot → nikad": LAN kanal s tajnom (ADR-0003 §5.1). Brave protiv petlje
  // (zastavica, strop, skok, vlastita) su već prošle na ruti.
  if (p.izvor === 'bot') return true
  // Dva bota u istoj grupi ne smiju se dopisivati.
  if (p.posiljateljJeBot) return false
  if (jeZaDrugog(p, s)) return false
  const obracanje = p.privatno || p.obracanjeBotu
  switch (s.odgovaraNa) {
    case 'sve': return true
    case 'dopusteni-sve':
      // Dopušteni bez prozivke; ostali samo uz obraćanje (ili nikako — postavka).
      if (jeDopusten(p, s.dopusteniKorisnici)) return true
      return obracanje && s.ostaliUzObracanje
    case 'dopusteni': return obracanje && jeDopusten(p, s.dopusteniKorisnici)
    default: return obracanje
  }
}
