/**
 * LoginCreds — jedan izvor istine za tajne davatelja u sigurnom spremištu
 * (`~/.claude/regoc/credentials.env`, redci oblika `IME=vrijednost`).
 *
 * ZAŠTO POSTOJI (TASK-4796): mjerilo „je li davatelj prijavljen" i radnja „odjavi ga"
 * bile su dva odvojena, ručno prepisana izraza u TaskWebUI.ts. Mjerilo je gledalo ključ u
 * spremištu, a odjava brisala samo OAuth datoteku — pa je „Odjava" za Gemini bila
 * kozmetička: gumb je zauvijek ostajao „prijavljen". Dok obje strane ne dijele isti kod,
 * takav razmak se vrati kod prve sljedeće izmjene.
 *
 * NAČELO: ono što odjava ukloni mora oboriti mjerilo prijavljenosti. Zato je uklanjanje
 * namjerno ŠIRE od mjerila (hvata i `export IME=`, i razmake, i praznu vrijednost) —
 * nikad ne smije ostati redak koji bi mjerilo moglo pročitati kao prijavu.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Mjerilo prijavljenosti: TOČNO ime ključa s NEPRAZNOM vrijednošću na početku retka. */
export function kljucPrisutan(tekst: string, envKey: string): boolean {
  if (!envKey) return false
  return new RegExp('^' + escapeRe(envKey) + '=.+', 'm').test(tekst)
}

export function kljucPrisutanUDatoteci(putanja: string, envKey: string): boolean {
  try {
    return existsSync(putanja) && kljucPrisutan(readFileSync(putanja, 'utf-8'), envKey)
  } catch { return false }
}

/** Je li redak zapis TOG ključa (šire od mjerila: `export`, razmaci, prazna vrijednost). */
export function redakJeKljuc(redak: string, envKey: string): boolean {
  return new RegExp('^\\s*(export\\s+)?' + escapeRe(envKey) + '\\s*=').test(redak)
}

/** Miče CIJELI redak ključa (ne prazni vrijednost — prazan `IME=` je i dalje trag tajne). */
export function ukloniKljuc(tekst: string, envKey: string): { tekst: string; uklonjen: boolean } {
  if (!envKey) return { tekst, uklonjen: false }
  const redovi = tekst.split('\n')
  const ostatak = redovi.filter(r => !redakJeKljuc(r, envKey))
  return { tekst: ostatak.join('\n'), uklonjen: ostatak.length !== redovi.length }
}

/** Odjava na disku. Vraća je li ključ doista bio ondje (dvostruki klik je bezopasan). */
export function ukloniKljucIzDatoteke(putanja: string, envKey: string): boolean {
  if (!envKey || !existsSync(putanja)) return false
  const { tekst, uklonjen } = ukloniKljuc(readFileSync(putanja, 'utf-8'), envKey)
  if (!uklonjen) return false
  writeFileSync(putanja, tekst, { mode: 0o600 })
  try { chmodSync(putanja, 0o600) } catch {} // `mode` vrijedi samo pri stvaranju datoteke
  return true
}
