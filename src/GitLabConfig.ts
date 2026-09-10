/**
 * GitLabConfig — postavke veze prema GitLabu (DIZAJN-integracije §4).
 *
 * OVO NIJE NOVI HTTP KLIJENT. GitLab ima službeni `glab` CLI koji sam čuva korisnikovu
 * prijavu, pa je „donesi svoj nalog" već riješeno — paketu treba samo zapamtiti KOJI
 * projekt i provjeriti da prijava postoji. Zajednički mehanizam issuea živi u
 * `src/core/IssueSync.ts`, ovdje su samo postavke i proba.
 *
 * Opseg: issue (otvori / zatvori). Git operacije NISU ovdje — za njih postoji
 * `src/core/GitCommitGate.ts` i korisnikov vlastiti `git`.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { ConfigModul, tajnaPostavljena, type StanjeIntegracije } from './core/ConfigModul'
import { probajVezu, otvoriIssue, zatvoriIssue, type IssueVeza, type Ishod } from './core/IssueSync'

export interface GitLabPostavke {
  ukljucen: boolean
  nacin: 'cli' | 'api'
  /** `gitlab.com` ili vlastiti poslužitelj. */
  host: string
  /** `grupa/repozitorij`. */
  projekt: string
  /** IME varijable okoline s tokenom — koristi se SAMO uz `nacin: 'api'`. */
  tokenEnv: string
  otvarajIssue: boolean
  zatvarajIssue: boolean
  oznakaSinkro: string
}

export const ZADANE_POSTAVKE: GitLabPostavke = {
  ukljucen: false,
  nacin: 'cli',
  host: '',
  projekt: '',
  tokenEnv: 'GITLAB_TOKEN',
  otvarajIssue: false,
  zatvarajIssue: false,
  oznakaSinkro: 'gitlab',
}

export const GRANICE = {
  host: { maxDuljina: 200 },
  projekt: { maxDuljina: 200 },
  tokenEnv: { maxDuljina: 64 },
  oznakaSinkro: { maxDuljina: 40 },
} as const

const RE_PROJEKT = /^[A-Za-z0-9._\-]+(\/[A-Za-z0-9._\-]+)+$/

const modul = new ConfigModul<GitLabPostavke>({
  ime: 'gitlab',
  datoteka: 'gitlab.json',
  envVar: 'TM_GITLAB_CONFIG',
  zadane: ZADANE_POSTAVKE,
  shema: {
    ukljucen: { tip: 'bool' },
    nacin: { tip: 'izbor', vrijednosti: ['cli', 'api'] },
    host: {
      tip: 'tekst', maxDuljina: GRANICE.host.maxDuljina,
      uzorak: /^(https?:\/\/)?[A-Za-z0-9.\-]+(:\d+)?$/,
      uzorakPoruka: 'npr. gitlab.com ili gitlab.tvrtka.hr',
    },
    projekt: {
      tip: 'tekst', maxDuljina: GRANICE.projekt.maxDuljina,
      uzorak: RE_PROJEKT, uzorakPoruka: 'oblik je grupa/repozitorij',
    },
    tokenEnv: {
      tip: 'tekst', maxDuljina: GRANICE.tokenEnv.maxDuljina, tajnaEnv: true,
      uzorak: /^[A-Z][A-Z0-9_]*$/,
      uzorakPoruka: 'upiši IME varijable okoline (npr. GITLAB_TOKEN), ne sam token',
    },
    otvarajIssue: { tip: 'bool' },
    zatvarajIssue: { tip: 'bool' },
    oznakaSinkro: { tip: 'tekst', maxDuljina: GRANICE.oznakaSinkro.maxDuljina },
  },
})

/**
 * Putanja se razrjesava PRI SVAKOM CITANJU (v. `ConfigModul.putanja`) — zamrznuta
 * vrijednost pokazivala bi na primjer uz paket i nakon prvog zapisa u `$TM_HOME/config/`.
 */
export function GITLAB_CONFIG_PATH(): string { return modul.putanja }

/** Sam modul — ploca ga treba za putanju i za stanje. */
export const gitlabKonfigModul = modul

export const loadGitLabConfig = (path?: string) => modul.load(path)
export const validateGitLabPatch = (tijelo: unknown) => modul.validate(tijelo)
export const saveGitLabConfig = (zakrpa: Partial<GitLabPostavke>, path?: string) => modul.save(zakrpa, path)

export function vezaGitLab(cfg: GitLabPostavke = loadGitLabConfig()): IssueVeza {
  return {
    davatelj: 'gitlab', nacin: cfg.nacin, projekt: cfg.projekt,
    host: cfg.host || 'gitlab.com', tokenEnv: cfg.tokenEnv,
  }
}

export function stanjeGitLab(cfg: GitLabPostavke = loadGitLabConfig()): StanjeIntegracije {
  const tajna = cfg.nacin === 'api' ? tajnaPostavljena(cfg.tokenEnv) : true
  let zastoKey = 'int_zasto_spreman'
  let zastoVars: Record<string, string> | undefined
  let spreman = true
  if (!cfg.ukljucen) { spreman = false; zastoKey = 'int_zasto_iskljucen' }
  else if (!cfg.projekt) { spreman = false; zastoKey = 'int_zasto_nema_repozitorija' }
  else if (!tajna) { spreman = false; zastoKey = 'int_zasto_treba_kljuc'; zastoVars = { env: cfg.tokenEnv } }
  else if (cfg.nacin === 'cli') { zastoKey = 'int_zasto_cli' }
  return {
    ukljucen: cfg.ukljucen,
    tajnaPostavljena: cfg.nacin === 'api' ? tajnaPostavljena(cfg.tokenEnv) : false,
    spreman, zastoKey, zastoVars,
  }
}

export async function probajGitLab(path?: string): Promise<Ishod> {
  return probajVezu(vezaGitLab(loadGitLabConfig(path)))
}

export async function gitlabOtvoriIssue(naslov: string, opis?: string, oznake?: string[], path?: string) {
  const cfg = loadGitLabConfig(path)
  if (!cfg.ukljucen || !cfg.otvarajIssue) return { ok: false, greska: 'otvaranje issuea je isključeno' }
  return otvoriIssue(vezaGitLab(cfg), { naslov, opis, oznake })
}

export async function gitlabZatvoriIssue(broj: number | string, path?: string) {
  const cfg = loadGitLabConfig(path)
  if (!cfg.ukljucen || !cfg.zatvarajIssue) return { ok: false, greska: 'zatvaranje issuea je isključeno' }
  return zatvoriIssue(vezaGitLab(cfg), broj)
}
