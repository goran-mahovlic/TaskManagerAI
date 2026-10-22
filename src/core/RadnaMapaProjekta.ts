/**
 * Smije li agent raditi u ovoj mapi projekta (`projects.root_path`) — TASK-5715, nalaz C2
 * sigurnosnog pregleda TASK-5712.
 *
 * ZAŠTO: radna mapa nije neutralna. `claude` iz `cwd` učitava `.claude/settings.json`
 * (hookovi = izvršavanje naredbi, allow liste) i `CLAUDE.md`. Tko smije upisati root_path,
 * bira čije će postavke agent izvršiti; mapa poput `~/.claude` ili `$TM_HOME` agentu daje
 * postavke samog sustava. Zato vrijedi:
 *   1. Značajka je ISKLJUČENA dok vlasnik ne navede dopuštene korijene (`TM_PROJECTS_ROOTS`,
 *      popis odvojen s `:`). Prazno = nijedna radna mapa se ne prihvaća.
 *   2. Putanja se razrješava (`realpathSync`, simboličke veze) i rezultat mora biti u nekom
 *      korijenu. Veza unutar korijena koja vodi van se odbija.
 *   3. Neke mape se odbijaju i kad su u korijenu: `/`, `$HOME`, `~/.claude`, `~/.ssh`,
 *      `$TM_HOME`, sistemske mape.
 *   4. Putanja izvan korijena odbija se PRIJE ikakvog pristupa disku, pa odgovor ne otkriva
 *      postoji li ondje nešto (nalaz Ž7).
 *
 * Ista funkcija vrijedi na ploči (spremanje) i u orkestratoru prije svakog spawna: mapa se
 * nakon spremanja može zamijeniti simboličkom vezom.
 */

import { realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'

export interface OpcijeRadneMape {
  /** Dopušteni korijeni (apsolutni). Prazno = značajka isključena. */
  korijeni: string[]
  home: string
  tmHome: string
}

export type KodRadneMape =
  | 'root_path_disabled' | 'root_path_not_allowed' | 'root_path_forbidden'
  | 'root_path_missing' | 'root_path_not_dir'

export type IshodRadneMape =
  | { ok: true; put: string }
  | { ok: false; kod: KodRadneMape; poruka: string }

/** Mape koje se nikad ne prihvaćaju same za sebe (ali njihove podmape mogu, ako su u korijenu). */
const SAMO_TOCNO = ['/', '/usr', '/var', '/home', '/Users', '/private', '/opt', '/srv', '/mnt', '/media']

/** Sistemske mape: odbijaju se one i sve ispod njih. */
const SISTEMSKE = [
  '/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/bin', '/sbin', '/lib', '/lib64',
  '/usr/bin', '/usr/sbin', '/usr/lib', '/System', '/Library', '/private/etc', '/private/var/root',
]

/** Mape korisnika usluge koje nose postavke, ključeve ili samu instalaciju. */
const KORISNICKE = ['.claude', '.ssh', '.gnupg', '.config', '.aws', '.kube', '.docker', 'Library']

export function opcijeIzOkoline(env: Record<string, string | undefined> = process.env): OpcijeRadneMape {
  const home = env.HOME || homedir()
  return {
    korijeni: String(env.TM_PROJECTS_ROOTS || '').split(':').map(s => s.trim()).filter(Boolean),
    home,
    tmHome: env.TM_HOME || join(home, '.taskmanager'),
  }
}

function realIliResolve(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

function ispod(put: string, korijen: string): boolean {
  if (korijen === '/') return true
  return put === korijen || put.startsWith(korijen.endsWith(sep) ? korijen : korijen + sep)
}

export function provjeriRadnuMapu(putanja: string, o: OpcijeRadneMape = opcijeIzOkoline()): IshodRadneMape {
  const korijeni = o.korijeni.filter(k => isAbsolute(k)).map(realIliResolve)
  if (!korijeni.length) {
    return { ok: false, kod: 'root_path_disabled', poruka: 'Radne mape projekata nisu uključene: vlasnik mora navesti dopuštene korijene u TM_PROJECTS_ROOTS' }
  }
  if (!isAbsolute(putanja) || /[\x00-\x1f\x7f]/.test(putanja)) {
    return { ok: false, kod: 'root_path_not_allowed', poruka: 'Radna mapa mora biti apsolutna putanja bez kontrolnih znakova' }
  }
  const nijeDopustena: IshodRadneMape = { ok: false, kod: 'root_path_not_allowed', poruka: `Radna mapa nije ni u jednom dopuštenom korijenu (TM_PROJECTS_ROOTS): ${putanja}` }

  // Prvo po zapisu, bez diska: putanja izvan svih korijena ne otkriva ništa o disku.
  const leksicka = resolve(putanja)
  const izvorniKorijeni = o.korijeni.filter(k => isAbsolute(k)).map(k => resolve(k))
  if (!korijeni.some(k => ispod(leksicka, k)) && !izvorniKorijeni.some(k => ispod(leksicka, k))) return nijeDopustena

  let stvarna: string
  try { stvarna = realpathSync(leksicka) } catch { return { ok: false, kod: 'root_path_missing', poruka: `Radna mapa ne postoji: ${putanja}` } }
  if (!korijeni.some(k => ispod(stvarna, k))) return nijeDopustena

  const home = realIliResolve(o.home)
  const zabranjeneTocno = [...SAMO_TOCNO, home]
  const zabranjeneIspod = [
    ...SISTEMSKE,
    ...KORISNICKE.map(m => join(home, m)),
    realIliResolve(o.tmHome),
  ]
  if (zabranjeneTocno.includes(stvarna) || zabranjeneIspod.some(z => ispod(stvarna, z))) {
    return { ok: false, kod: 'root_path_forbidden', poruka: `Radna mapa je zaštićena mapa sustava ili korisnika i ne smije biti radna mapa agenta: ${putanja}` }
  }

  try {
    if (!statSync(stvarna).isDirectory()) return { ok: false, kod: 'root_path_not_dir', poruka: `Radna mapa nije mapa: ${putanja}` }
  } catch {
    return { ok: false, kod: 'root_path_missing', poruka: `Radna mapa ne postoji: ${putanja}` }
  }
  return { ok: true, put: stvarna }
}
