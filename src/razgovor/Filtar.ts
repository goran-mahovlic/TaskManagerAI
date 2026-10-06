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

/**
 * Je li poruka upućena NEKOM DRUGOM, a ne ovom botu (TASK-5283, ADR-0002 §15):
 *  - počinje imenom s popisa `preskociAkoSpominje`, sadrži njegov @spomen ili je odgovor na
 *    poruku tog bota (po korisničkom imenu ili imenu);
 *  - uz `tisinaKadDrugom`: bilo koji tuđi @spomen (bot ili čovjek) ili odgovor na tuđu poruku.
 * Obraćanje OVOM botu (spomen, ime, reply, privatni chat) uvijek pobjeđuje. Vrijedi i za ulaz:
 * poruka za drugoga ne otvara zadatak.
 */
export function jeZaDrugog(p: UlaznaPoruka, s: Pick<RazgovorPostavke, 'preskociAkoSpominje' | 'tisinaKadDrugom'>): boolean {
  if (p.privatno || p.obracanjeBotu) return false
  const spomeni = p.spomeni || []
  const o = p.odgovorNa && p.odgovorNa.id !== p.posiljateljId ? p.odgovorNa : undefined
  for (const unos of s.preskociAkoSpominje || []) {
    const e = bezEt(unos)
    if (!e) continue
    if (pocinjeImenom(p.tekst, e) || pocinjeImenom(p.tekst, `@${e}`)) return true
    if (spomeni.includes(e)) return true
    if (o && (o.korisnickoIme === e || (!!o.ime && normaliziraj(o.ime.trim()) === normaliziraj(e)))) return true
  }
  if (s.tisinaKadDrugom && (spomeni.length > 0 || !!o)) return true
  return false
}

export function trebaOdgovoriti(p: UlaznaPoruka, s: RazgovorPostavke): boolean {
  if (!s.ukljucen) return false
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
