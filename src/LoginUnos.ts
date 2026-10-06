/**
 * LoginUnos — čisti tekst koji ide u CLI za prijavu i iz njega natrag u preglednik
 * (Config → Login na ploči, TASK-5269).
 *
 * ZAŠTO POSTOJI:
 * - `claude auth login` je Ink u raw načinu kroz `script` PTY: unos potvrđuje '\r', a '\n'
 *   samo ostane u polju (kod se upiše kao zvjezdice i nikad ne pošalje).
 * - CLI ispisuje URL kao OSC-8 hipervezu (`ESC]8;;URL BEL URL ESC]8;; BEL`). Sirovi regex na
 *   takvom međuspremniku hvata BEL i dupli URL, pa link na ploči ne radi; korisnik onda
 *   kopira iz terminala i zalijepi kod zajedno s ANSI repom i URL-om.
 * - Izlaz CLI-ja ide pregledniku kao `tail` — sve što liči na tajnu mora biti maskirano.
 */

/** Potvrda unosa u Ink/PTY (Enter u raw načinu). */
export const LOGIN_POTVRDA = '\r'

// OSC (ESC ] … BEL | ESC \), CSI (ESC [ … završni), ostali dvoznakovni ESC nizovi.
const RE_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const RE_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const RE_ESC2 = /\x1b[@-Z\\-_]?/g
const RE_KONTROLNI = /[\x00-\x08\x0b-\x1f\x7f]/g

/** Ukloni ANSI/OSC sekvence i kontrolne znakove; zadrži samo '\n' i '\t'. */
export function ocistiTerminal(s: string): string {
  return String(s ?? '')
    .replace(RE_OSC, '')
    .replace(RE_CSI, '')
    .replace(RE_ESC2, '')
    .replace(/\r\n?/g, (m) => (m === '\r\n' ? '\n' : ''))
    .replace(RE_KONTROLNI, '')
}

const RE_OAUTH_KOD = /[A-Za-z0-9_-]+#[A-Za-z0-9_-]+/

/**
 * Iz zalijepljenog teksta uzmi samo kod: prvi `<znakovi>#<znakovi>` (Claude), inače prvu
 * riječ. Prazno, predugo ili URL umjesto koda → null (poslužitelj vraća 400).
 */
export function ocistiLoginKod(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const cist = ocistiTerminal(raw).replace(/\s+/g, ' ').trim()
  if (!cist) return null
  const sHashom = cist.match(RE_OAUTH_KOD)
  if (sHashom) return sHashom[0]
  const rijec = cist.split(' ')[0]
  if (!rijec || rijec.length > 4096 || /^https?:/i.test(rijec)) return null
  return rijec
}

/** Prvi URL iz izlaza CLI-ja, nakon čišćenja OSC-8 hiperveza. */
export function izvuciLoginUrl(buf: string): string {
  const m = ocistiTerminal(buf).match(/https?:\/\/[^\s"'<>]+/)
  return m ? m[0] : ''
}

/** Očišćen i maskiran rep izlaza CLI-ja za preglednik. */
export function maskirajLoginTail(buf: string, n = 400): string {
  return ocistiTerminal(buf)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[skriveno]')
    .replace(/[A-Za-z0-9_-]{8,}#[A-Za-z0-9_-]{8,}/g, '[skriveno]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[skriveno]')
    .slice(-n)
}

/** Jasna poruka ako je CLI javio OAuth grešku (neispravan/istekao/iskorišten kod), inače null. */
export function loginOauthGreska(buf: string): string | null {
  return /OAuth error/i.test(ocistiTerminal(buf))
    ? 'Prijava odbijena (OAuth error): kod je neispravan, istekao ili već iskorišten. Klikni „Počni ponovno” i zalijepi NOVI kod.'
    : null
}
