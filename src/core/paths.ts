/**
 * Jedno mjesto na kojem se odlučuje gdje sustav drži svoje podatke.
 *
 * Zadano je `$HOME/.taskmanager`. Sve se može premjestiti jednom varijablom
 * okoline, što je korisno za servis koji radi pod vlastitim korisnikom ili za
 * više odvojenih instanci na istom stroju:
 *
 *   TM_HOME=/var/lib/taskmanager bun src/TaskWebUI.ts
 *
 * `TM_DB` postoji zasebno jer je ponekad zgodno bazu držati drugdje od
 * ostalih radnih datoteka (npr. na bržem disku).
 *
 * ADR-0001 O1.1: ovo je JEDINI izvor korijena. Nijedan modul ne smije imati
 * tuđi kućni direktorij kao rezervnu vrijednost — na drugom stroju ta mapa ne
 * postoji, pa se tiho stvara datoteka koju nitko ne čita.
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import os from 'os'

/** Korijenska mapa za bazu, dnevnike i stanje. */
export const TM_ROOT: string =
  process.env.TM_HOME || join(process.env.HOME || os.homedir(), '.taskmanager')

/** Puna putanja do SQLite baze. Stvara je `scripts/init-db.sh`. */
export const TM_DB: string = process.env.TM_DB || join(TM_ROOT, 'data', 'tasks.db')

/** Mapa za podatke uz bazu (izvoz, pričuve, predmemorija). */
export const TM_DATA: string = join(TM_ROOT, 'data')

/** Korijen samog paketa (`src/core/..` → `src/..` → paket). */
export const PAKET_DIR: string = join(import.meta.dir, '..', '..')

/**
 * Gdje živi konfiguracijska datoteka — obrazac iz `IngestConfig.zadanaPutanja()`,
 * podignut na zajedničko mjesto jer ga od ADR-0001 O1.4 koristi devet modula:
 *
 *   1. varijabla okoline — puna putanja, za instalaciju koja postavke drži drugdje;
 *   2. `$TM_HOME/config/<ime>` — uz bazu, ako ta datoteka ondje POSTOJI;
 *   3. `config/<ime>` uz sam paket — zadano, radi bez ijedne varijable okoline.
 *
 * Korak 2 traži postojanje datoteke namjerno: instalacija koja ima `TM_HOME`, ali
 * postavke drži uz paket, ne smije pri prvom čitanju odlutati na praznu putanju.
 */
export function konfigPutanja(ime: string, envVar?: string): string {
  if (envVar && process.env[envVar]) return process.env[envVar] as string
  if (process.env.TM_HOME) {
    const uzBazu = join(process.env.TM_HOME, 'config', ime)
    if (existsSync(uzBazu)) return uzBazu
  }
  return join(PAKET_DIR, 'config', ime)
}

/**
 * Gdje se PIŠE konfiguracija (ploča) — isti redoslijed, ali bez uvjeta da datoteka
 * već postoji: `$TM_HOME/config/<ime>` je ispravno odredište za prvi zapis.
 */
export function konfigPutanjaZaPisanje(ime: string, envVar?: string): string {
  if (envVar && process.env[envVar]) return process.env[envVar] as string
  if (process.env.TM_HOME) return join(process.env.TM_HOME, 'config', ime)
  return join(PAKET_DIR, 'config', ime)
}

/** Datoteka sa stanjem koje stroj sam zatekne (nikad ne miješati s konfiguracijom). */
export function stanjePutanja(ime: string): string {
  return join(TM_DATA, ime)
}

/** Stvori mapu iznad datoteke ako je nema. Vraća istu putanju radi ulančavanja. */
export function osigurajMapu(putanja: string): string {
  const dir = dirname(putanja)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return putanja
}
