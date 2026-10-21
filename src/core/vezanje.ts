/**
 * Adrese na koje se ploča veže (`TM_BIND`, plan Mac v3 P2/P3, rizik R3).
 *
 * Bez postavke (TASK-5686, S2 iz pregleda K5): na macOS-u i u svakoj instalaciji paketa
 * (`$TM_HOME/config/postavke.env` postoji) ploča sluša samo na `127.0.0.1` — ručni `start.sh`
 * na Macu bez `--cvor` inače je bio vidljiv cijeloj Wi-Fi mreži. Samo Linux bez postavke.env
 * (postojeći node-A) zadržava `0.0.0.0`; otvoreno inače znači izričit `TM_BIND=0.0.0.0`.
 * Čvor na tuđoj mreži (npr. Wi-Fi kod korisnika) dobiva od
 * `scripts/install.sh --cvor` popis `127.0.0.1` + adresa tailneta, pa ploča nije vidljiva
 * ostatku lokalne mreže.
 *
 * Neispravan unos se ne pretvara u `0.0.0.0`: ako nijedna adresa nije ispravna, ploča sluša
 * samo na `127.0.0.1` (zatvoreno, a ne otvoreno).
 */
import { existsSync } from 'fs'
import { isIP } from 'net'
import { join } from 'path'

export const SVA_SUCELJA = '0.0.0.0'
export const PETLJA = '127.0.0.1'

export interface Vezanje { adrese: string[]; odbaceno: string[] }

/** Adresa kad `TM_BIND` nije postavljen (v. zaglavlje). */
export function zadanaAdresa(platforma: string, tmHome: string | undefined, postoji: (p: string) => boolean = existsSync): string {
  if (platforma === 'darwin') return PETLJA
  if (tmHome && postoji(join(tmHome, 'config', 'postavke.env'))) return PETLJA
  return SVA_SUCELJA
}

export function adreseVezanja(vrijednost: string | undefined, zadano: string = SVA_SUCELJA): Vezanje {
  if (vrijednost === undefined || vrijednost.trim() === '') return { adrese: [zadano], odbaceno: [] }
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
