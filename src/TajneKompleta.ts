/**
 * TajneKompleta — tajne kompleta izvornog sustava (regoc-system/) na ploči (TASK-5705, uputa #441).
 *
 * Komplet nosi `TAJNE.json`: IMENA tajni koje njegov kod čita (izvoz ih izvlači strojno iz koda,
 * `izvuci_tajne.py`), uz opis, obaveznost, komponente i „što ne radi bez nje" (HR/EN). Ploča ih
 * dodaje na popis dopuštenih imena (ADR-0007 §6.1), pa ih vlasnik čvora upisuje kroz Config → Tajne
 * u spremište paketa — komplet ga čita kroz poveznicu `credentials.env` u svojoj mapi (instalacija.sh kompleta).
 *
 * Komplet je instaliran ondje gdje pokazuje `TM_SUSTAV_DIR` (install.sh --komplet ga upisuje u
 * instalacija.env). Bez kompleta, ili s pokvarenom datotekom, popis je prazan — ploča radi dalje.
 * Datoteka nikad ne nosi vrijednost; ovdje se čitaju samo poznata polja.
 */
import { readFileSync } from 'fs'
import { sustavPutanja } from './core/paths'
import type { DopustenoIme } from './LoginCreds'

const tekst = (o: any): { hr: string; en: string } | undefined =>
  o && typeof o.hr === 'string' && typeof o.en === 'string' ? { hr: o.hr, en: o.en } : undefined

export function tajneKompleta(put: string | null = sustavPutanja('TAJNE.json')): DopustenoIme[] {
  if (!put) return []
  let j: any
  try { j = JSON.parse(readFileSync(put, 'utf-8')) } catch { return [] }
  if (!Array.isArray(j?.tajne)) return []
  return j.tajne
    .filter((t: any) => typeof t?.ime === 'string')
    .map((t: any) => ({
      ime: t.ime, izvor: 'komplet', obavezno: t.obavezno === true,
      komponente: Array.isArray(t.komponente) ? t.komponente.filter((k: unknown) => typeof k === 'string') : [],
      opis: tekst(t.opis), bezNje: tekst(t.bez_nje),
    }))
}
