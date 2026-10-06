// ─── Filtar obraćanja (ADR-0002 §5) ──────────────────────────────────────────
// Treba li bot uopće odgovoriti. Primjenjuje se NAKON filtara ulaza (dopušteni chatovi) i
// nakon ingesta. Je li poruka upućena botu (spomen, ime, odgovor na bota) računa ADAPTER
// kanala — ovdje se samo čita `obracanjeBotu`.
//
// Autorica: Jelena (Engineer), TASK-5277.

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

export function trebaOdgovoriti(p: UlaznaPoruka, s: RazgovorPostavke): boolean {
  if (!s.ukljucen) return false
  // Dva bota u istoj grupi ne smiju se dopisivati.
  if (p.posiljateljJeBot) return false
  const obracanje = p.privatno || p.obracanjeBotu
  if (s.odgovaraNa === 'sve') return true
  if (!obracanje) return false
  if (s.odgovaraNa === 'dopusteni') return s.dopusteniKorisnici.includes(p.posiljateljId)
  return true
}
