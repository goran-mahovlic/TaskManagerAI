/**
 * ClaudePrijava — Claude pretplata kroz ploču (Config → Prijava → Claude), TASK-5754.
 *
 * ZAŠTO POSTOJI:
 * - Na macOS-u `claude auth login` sprema prijavu u Keychain, koji usluga pod launchd ne vidi
 *   (plan Mac v3 P12.2): ploča prijavu nikad ne vidi, a daemon nema token. Jedini put za uslugu je
 *   dugotrajni token iz `claude setup-token`, upisan u spremište kao CLAUDE_CODE_OAUTH_TOKEN
 *   (iznimka u `LoginCreds.IZNIMKE_ZABRANE`).
 * - setup-token token samo ISPIŠE u terminal. Ploča ga zato čita iz PTY-ja, sprema i odmah skriva:
 *   ni `buf` sesije ni `tail` u pregledniku ni dnevnik ne smiju nositi ni dio tokena.
 * - Ink lomi dugi redak na rubu terminala (bez veličine PTY-ja zadano 80 stupaca) — prelomljen
 *   token bio bi presječen, pa naredba prvo širi PTY.
 * Linux ostaje `claude auth login` (datoteka prijave u ~/.claude, koju usluga vidi).
 */
import { jeMac, type Okolina } from './platforma'

export const CLAUDE_TOKEN_IME = 'CLAUDE_CODE_OAUTH_TOKEN'
export const CLAUDE_NAREDBA_PRIJAVE = 'claude auth login --claudeai'
export const CLAUDE_NAREDBA_TOKENA = 'stty cols 500 rows 50 2>/dev/null; claude setup-token'

/** Naredba prijave i, na macOS-u, ime tajne u koju ide token iz izlaza. */
export function prijavaClaudea(o?: Okolina): { cmd: string; tokenKey?: string } {
  return jeMac(o) ? { cmd: CLAUDE_NAREDBA_TOKENA, tokenKey: CLAUDE_TOKEN_IME } : { cmd: CLAUDE_NAREDBA_PRIJAVE }
}

// Dovršen token = iza njega već stoji znak koji nije dio tokena (\r, \n, ESC…).
const RE_DOVRSEN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/
const RE_BILO_KOJI = /sk-ant-[A-Za-z0-9_-]*/g

/** Dovršen dugotrajni token iz sirovog izlaza setup-tokena, ili null. */
export function izvuciClaudeToken(sirovo: string): string | null {
  const m = String(sirovo ?? '').match(RE_DOVRSEN)
  return m ? m[0] : null
}

/** Svaki (i djelomičan) `sk-ant-…` niz zamijenjen oznakom. */
export function skrijClaudeToken(s: string): string {
  return String(s ?? '').replace(RE_BILO_KOJI, 'sk-ant-[spremljeno]')
}

/**
 * Čitač izlaza setup-tokena. Sirovi izlaz drži samo u sebi (privatno, ne ide u sesiju ni API);
 * `dodaj` vraća skriveni međuspremnik za `sess.buf`. Skriva se nad CIJELIM sirovim izlazom, pa
 * ni token razlomljen preko dva komada ne procuri drugom polovicom.
 */
export class CitacSetupTokena {
  #sirovo = ''
  spremljen = false
  greska: string | null = null

  constructor(private readonly spremi: (token: string) => { ok: boolean; greska?: string }) {}

  dodaj(komad: string): string {
    this.#sirovo = (this.#sirovo + komad).slice(-65536)
    if (!this.spremljen && !this.greska) {
      const token = izvuciClaudeToken(this.#sirovo)
      if (token) {
        const r = this.spremi(token)
        if (r.ok) this.spremljen = true
        else this.greska = `Token nije spremljen u spremište (${r.greska || 'nepoznato'})`
      }
    }
    return skrijClaudeToken(this.#sirovo)
  }
}
