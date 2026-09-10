/**
 * GitHubConfig — postavke veze prema GitHubu (DIZAJN-integracije §5).
 *
 * Nalaz iz `ROADMAP_SAMOSTALNOST` §2, potvrđen: GitHub ide kroz `gh` CLI koji SAM čuva
 * korisnikovu prijavu, pa je paket zapravo već spreman i treba mu dokumentacija, ne kod.
 * Zato je ovdje samo konfiguracija i proba; mehanizam issuea dijeli s GitLabom
 * (`src/core/IssueSync.ts`), a upute za prijavu su u `docs/INTEGRACIJE.md`.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { ConfigModul, tajnaPostavljena, type StanjeIntegracije } from './core/ConfigModul'
import { probajVezu, otvoriIssue, zatvoriIssue, type IssueVeza, type Ishod } from './core/IssueSync'

export interface GitHubPostavke {
  ukljucen: boolean
  nacin: 'cli' | 'api'
  /** `vlasnik/repozitorij`. */
  repo: string
  /** IME varijable okoline s tokenom — samo uz `nacin: 'api'`. */
  tokenEnv: string
  otvarajIssue: boolean
  zatvarajIssue: boolean
  oznakaSinkro: string
}

export const ZADANE_POSTAVKE: GitHubPostavke = {
  ukljucen: false,
  nacin: 'cli',
  repo: '',
  tokenEnv: 'GITHUB_TOKEN',
  otvarajIssue: false,
  zatvarajIssue: false,
  oznakaSinkro: 'github',
}

export const GRANICE = {
  repo: { maxDuljina: 200 },
  tokenEnv: { maxDuljina: 64 },
  oznakaSinkro: { maxDuljina: 40 },
} as const

const RE_REPO = /^[A-Za-z0-9._\-]+\/[A-Za-z0-9._\-]+$/

const modul = new ConfigModul<GitHubPostavke>({
  ime: 'github',
  datoteka: 'github.json',
  envVar: 'TM_GITHUB_CONFIG',
  zadane: ZADANE_POSTAVKE,
  shema: {
    ukljucen: { tip: 'bool' },
    nacin: { tip: 'izbor', vrijednosti: ['cli', 'api'] },
    repo: {
      tip: 'tekst', maxDuljina: GRANICE.repo.maxDuljina,
      uzorak: RE_REPO, uzorakPoruka: 'oblik je vlasnik/repozitorij',
    },
    tokenEnv: {
      tip: 'tekst', maxDuljina: GRANICE.tokenEnv.maxDuljina, tajnaEnv: true,
      uzorak: /^[A-Z][A-Z0-9_]*$/,
      uzorakPoruka: 'upiši IME varijable okoline (npr. GITHUB_TOKEN), ne sam token',
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
export function GITHUB_CONFIG_PATH(): string { return modul.putanja }

/** Sam modul — ploca ga treba za putanju i za stanje. */
export const githubKonfigModul = modul

export const loadGitHubConfig = (path?: string) => modul.load(path)
export const validateGitHubPatch = (tijelo: unknown) => modul.validate(tijelo)
export const saveGitHubConfig = (zakrpa: Partial<GitHubPostavke>, path?: string) => modul.save(zakrpa, path)

export function vezaGitHub(cfg: GitHubPostavke = loadGitHubConfig()): IssueVeza {
  return {
    davatelj: 'github', nacin: cfg.nacin, projekt: cfg.repo,
    host: 'github.com', tokenEnv: cfg.tokenEnv,
  }
}

export function stanjeGitHub(cfg: GitHubPostavke = loadGitHubConfig()): StanjeIntegracije {
  const tajna = cfg.nacin === 'api' ? tajnaPostavljena(cfg.tokenEnv) : true
  let zastoKey = 'int_zasto_spreman'
  let zastoVars: Record<string, string> | undefined
  let spreman = true
  if (!cfg.ukljucen) { spreman = false; zastoKey = 'int_zasto_iskljucen' }
  else if (!cfg.repo) { spreman = false; zastoKey = 'int_zasto_nema_repozitorija' }
  else if (!tajna) { spreman = false; zastoKey = 'int_zasto_treba_kljuc'; zastoVars = { env: cfg.tokenEnv } }
  else if (cfg.nacin === 'cli') { zastoKey = 'int_zasto_cli' }
  return {
    ukljucen: cfg.ukljucen,
    tajnaPostavljena: cfg.nacin === 'api' ? tajnaPostavljena(cfg.tokenEnv) : false,
    spreman, zastoKey, zastoVars,
  }
}

export async function probajGitHub(path?: string): Promise<Ishod> {
  return probajVezu(vezaGitHub(loadGitHubConfig(path)))
}

export async function githubOtvoriIssue(naslov: string, opis?: string, oznake?: string[], path?: string) {
  const cfg = loadGitHubConfig(path)
  if (!cfg.ukljucen || !cfg.otvarajIssue) return { ok: false, greska: 'otvaranje issuea je isključeno' }
  return otvoriIssue(vezaGitHub(cfg), { naslov, opis, oznake })
}

export async function githubZatvoriIssue(broj: number | string, path?: string) {
  const cfg = loadGitHubConfig(path)
  if (!cfg.ukljucen || !cfg.zatvarajIssue) return { ok: false, greska: 'zatvaranje issuea je isključeno' }
  return zatvoriIssue(vezaGitHub(cfg), broj)
}
