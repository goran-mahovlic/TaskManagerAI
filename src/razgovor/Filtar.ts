// ─── Filtar obraćanja (ADR-0002 §5) ──────────────────────────────────────────
// Treba li bot uopće odgovoriti. Primjenjuje se NAKON filtara ulaza (dopušteni chatovi) i
// nakon ingesta. Je li poruka upućena botu (spomen, ime, odgovor na bota) računa ADAPTER
// kanala — ovdje se samo čita `obracanjeBotu`.
//
// Autorica: Jelena (Engineer), TASK-5277; dopusteni-sve i tišina za drugoga TASK-5283.

import type { UlaznaPoruka } from './Kanal'
import type { RazgovorPostavke } from './RazgovorPostavke'

/** Mala slova bez dijakritike: „Šaban" → „saban", „Đuro" → „duro". */
export function normaliziraj(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
}

/** Počinje li poruka imenom bota kao zasebnom riječi (`^ime\b`, bez obzira na veličinu slova i dijakritiku). */
export function pocinjeImenom(tekst: string, ime: string): boolean {
  const i = normaliziraj(ime.trim())
  if (!i) return false
  const t = normaliziraj(tekst.trimStart())
  if (!t.startsWith(i)) return false
  const iza = t.charAt(i.length)
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
 * Sadrži li tekst riječ s popisa BILO GDJE (odluka vlasnika, 06.10. 18:39), bez obzira na velika
 * slova i dijakritiku:
 *  - `@korisnicko_ime` → točno taj spomen (iza ne smije biti slovo, broj ni `_`);
 *  - ime → riječ koja POČINJE tim korijenom uz najviše 3 slova nastavka (padeži), a ispred
 *    nema slova („Divan" ne pogađa „Ivan", „Ivanovićevi" ne pogađa — predug nastavak).
 */
export function sadrziRijec(tekst: string, rijec: string): boolean {
  const r = normaliziraj(rijec.trim())
  if (!r || r === '@') return false
  const t = normaliziraj(tekst)
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
export function jeZaDrugog(p: UlaznaPoruka, s: Pick<RazgovorPostavke, 'preskociAkoSadrzi' | 'tisinaKadDrugom'>): boolean {
  if (p.privatno || p.obracanjeBotu || p.izvor === 'bot') return false
  const spomeni = p.spomeni || []
  const o = p.odgovorNa && p.odgovorNa.id !== p.posiljateljId ? p.odgovorNa : undefined
  for (const unos of s.preskociAkoSadrzi || []) {
    const e = bezEt(unos)
    if (!e) continue
    if (sadrziRijec(p.tekst, unos)) return true
    if (unos.trim().startsWith('@') && spomeni.includes(e)) return true
    if (o && (o.korisnickoIme === e || (!!o.ime && normaliziraj(o.ime.trim()) === normaliziraj(e)))) return true
  }
  if (s.tisinaKadDrugom && (spomeni.length > 0 || !!o)) return true
  return false
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
