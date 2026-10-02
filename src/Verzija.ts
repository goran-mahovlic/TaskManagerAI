/**
 * Verzija paketa — JEDAN izvor (TASK-5025).
 *
 * `/api/info` je prije tvrdo vraćao '5.0.0' (broj preuzet iz matičnog sustava), dok je
 * package.json govorio 1.3.0, a naslov kartice „Core Components (v4.4.0)". Sada ploča i
 * API čitaju verziju iz package.json — istog mjesta koje mijenja svako izdanje.
 *
 * `TM_VERSION_FILE` može upućivati na datoteku s brojem (npr. kad paket vozi veći sustav
 * sa svojom datotekom VERSION). Nema li ničega čitljivog, vraća se '?'.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export function procitajVerziju(
  datoteka: string | undefined = process.env.TM_VERSION_FILE,
  paket: string = join(import.meta.dir, '..', 'package.json'),
): string {
  if (datoteka) {
    try {
      const v = readFileSync(datoteka, 'utf-8').trim()
      if (SEMVER.test(v)) return v
    } catch { /* pada na package.json */ }
  }
  try {
    if (existsSync(paket)) {
      const v = String(JSON.parse(readFileSync(paket, 'utf-8')).version || '').trim()
      if (SEMVER.test(v)) return v
    }
  } catch { /* nečitljiv package.json */ }
  return '?'
}

let _kes: string | null = null

/** Verzija za ploču i API. Čita se jednom po procesu. */
export function paketVerzija(): string {
  if (_kes == null) _kes = procitajVerziju()
  return _kes
}
