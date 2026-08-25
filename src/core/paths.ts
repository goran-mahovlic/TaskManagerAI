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
 */
import { join } from 'path'
import os from 'os'

/** Korijenska mapa za bazu, dnevnike i stanje. */
export const TM_ROOT: string =
  process.env.TM_HOME || join(process.env.HOME || os.homedir(), '.taskmanager')

/** Puna putanja do SQLite baze. Stvara je `scripts/init-db.sh`. */
export const TM_DB: string = process.env.TM_DB || join(TM_ROOT, 'data', 'tasks.db')

/** Mapa za podatke uz bazu (izvoz, pričuve, predmemorija). */
export const TM_DATA: string = join(TM_ROOT, 'data')
