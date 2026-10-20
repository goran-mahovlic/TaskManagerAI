/**
 * Adrese na koje se ploča veže (`TM_BIND`, plan Mac v3 P2/P3, rizik R3).
 *
 * Bez postavke ploča sluša na svim sučeljima (`0.0.0.0`), kao i prije — postojeće instalacije
 * ne mijenjaju ponašanje. Čvor na tuđoj mreži (npr. Wi-Fi kod korisnika) dobiva od
 * `scripts/install.sh --cvor` popis `127.0.0.1` + adresa tailneta, pa ploča nije vidljiva
 * ostatku lokalne mreže.
 *
 * Neispravan unos se ne pretvara u `0.0.0.0`: ako nijedna adresa nije ispravna, ploča sluša
 * samo na `127.0.0.1` (zatvoreno, a ne otvoreno).
 */
import { isIP } from 'net'

export const SVA_SUCELJA = '0.0.0.0'
export const PETLJA = '127.0.0.1'

export interface Vezanje { adrese: string[]; odbaceno: string[] }

export function adreseVezanja(vrijednost: string | undefined): Vezanje {
  if (vrijednost === undefined || vrijednost.trim() === '') return { adrese: [SVA_SUCELJA], odbaceno: [] }
  const adrese: string[] = []
  const odbaceno: string[] = []
  for (const dio of vrijednost.split(',')) {
    const a = dio.trim().replace(/^\[(.*)\]$/, '$1')
    if (!a) continue
    if (a === 'localhost') { if (!adrese.includes(PETLJA)) adrese.push(PETLJA); continue }
    if (isIP(a) === 0) { odbaceno.push(a); continue }
    if (!adrese.includes(a)) adrese.push(a)
  }
  // 0.0.0.0 uz druge adrese bi se sudario s njima (EADDRINUSE) i ionako ih pokriva.
  if (adrese.includes(SVA_SUCELJA)) return { adrese: [SVA_SUCELJA], odbaceno }
  return { adrese: adrese.length ? adrese : [PETLJA], odbaceno }
}
