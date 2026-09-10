/**
 * ConfigModul — zajednička mehanika konfiguracijskog modula (DIZAJN-integracije §1).
 *
 * Četiri nove integracije imaju IDENTIČAN posao: pročitaj JSON, provjeri zakrpu, spremi
 * atomski, reci stanje bez otkrivanja tajne. Kad bi svaki modul to pisao sam, pravilo o
 * odbijanju nepoznatog polja živjelo bi u četiri preslike — a ovaj sustav već ima mjeren
 * kvar „pravila žive u devet preslika": ispravak jedne kopije nije ispravak propisa.
 *
 * Zato je ovdje mehanika, a u modulima ostaje samo ono što je za njih doista specifično:
 * shema polja i proba konekcije. Izvoze i dalje isti petorak (`load*`, `validate*Patch`,
 * `save*`, `probaj*`, `ZADANE_POSTAVKE`), pa je obrazac iz `TelegramConfig.ts` sačuvan.
 *
 * TAJNE: JSON nosi IME varijable okoline (`lozinkaEnv: "NEXTCLOUD_APP_PASSWORD"`), nikad
 * vrijednost. `stanjeTajne()` provjerava SAMO postojanje i vrijednost nikad ne vraća.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { konfigPutanja, konfigPutanjaZaPisanje, osigurajMapu } from './paths'

// ─── Shema ───────────────────────────────────────────────────────────────────

export type PoljeTip = 'bool' | 'tekst' | 'broj' | 'popis' | 'izbor' | 'objekt'

export interface Polje {
  tip: PoljeTip
  /** Za `tekst`. */
  maxDuljina?: number
  uzorak?: RegExp
  uzorakPoruka?: string
  /** Za `broj`. */
  min?: number
  max?: number
  /** Za `izbor`. */
  vrijednosti?: readonly string[]
  /** Za `objekt` — ugniježđena shema. */
  polja?: Shema
  /** Polje nosi IME varijable okoline s tajnom (nikad vrijednost). */
  tajnaEnv?: boolean
}

export type Shema = Record<string, Polje>

export interface Provjera<T> {
  ok: boolean
  greske: string[]
  zakrpa: Partial<T>
}

// ─── Čitanje i pisanje ───────────────────────────────────────────────────────

function spoji<T>(zadano: T, sirovo: unknown): T {
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return zadano
  const izlaz: Record<string, unknown> = { ...(zadano as Record<string, unknown>) }
  for (const [k, v] of Object.entries(sirovo as Record<string, unknown>)) {
    const z = (zadano as Record<string, unknown>)[k]
    izlaz[k] = z && typeof z === 'object' && !Array.isArray(z) && v && typeof v === 'object' && !Array.isArray(v)
      ? spoji(z, v)
      : v
  }
  return izlaz as T
}

/**
 * Jedan konfiguracijski modul: putanja, zadane vrijednosti, shema, i sve što iz toga slijedi.
 * Bez keša — datoteka se čita pri svakom pozivu, pa promjena s ploče vrijedi bez restarta
 * (keš bi bio jedina stvar koja bi tražila ponovno pokretanje).
 */
export class ConfigModul<T extends Record<string, any>> {
  readonly ime: string
  readonly datoteka: string
  readonly envVar: string
  readonly zadane: T
  readonly shema: Shema

  constructor(opcije: { ime: string; datoteka: string; envVar: string; zadane: T; shema: Shema }) {
    this.ime = opcije.ime
    this.datoteka = opcije.datoteka
    this.envVar = opcije.envVar
    this.zadane = opcije.zadane
    this.shema = opcije.shema
  }

  /**
   * Putanja se razrješava PRI SVAKOM POZIVU, ne pri učitavanju modula.
   *
   * Kvar koji je ovo zatvorio (uhvaćen živom provjerom 10.09.2026.): pri pokretanju
   * `$TM_HOME/config/<ime>.json` još ne postoji, pa čitanje padne na primjer uz paket. Prvi
   * zapis s ploče ode u `$TM_HOME/config/`, ali stara, zamrznuta putanja i dalje pokazuje
   * na primjer — ploča javi „spremljeno", a proba i dalje vidi prazne postavke.
   */
  get putanja(): string { return konfigPutanja(this.datoteka, this.envVar) }

  /**
   * Kamo se PIŠE. Razlikuje se od `putanja` samo dok datoteke još nema: prvi zapis mora ići
   * u `$TM_HOME/config/`, inače bi dvije instance s različitim `TM_HOME` pisale u istu
   * datoteku uz paket.
   */
  get putanjaPisanja(): string { return konfigPutanjaZaPisanje(this.datoteka, this.envVar) }

  /** Uvijek svjež pročitaj s diska. Nepoznata polja iz datoteke se ČUVAJU. */
  load(path: string = this.putanja): T & Record<string, unknown> {
    try {
      const sirovo = JSON.parse(readFileSync(path, 'utf-8'))
      if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return { ...this.zadane }
      return spoji(this.zadane, sirovo) as T & Record<string, unknown>
    } catch {
      return { ...this.zadane }
    }
  }

  /** Provjeri zakrpu s ploče. Nepoznato polje se odbija IMENOM, na svakoj razini. */
  validate(tijelo: unknown): Provjera<T> {
    const greske: string[] = []
    const zakrpa: Record<string, unknown> = {}
    if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
      return { ok: false, greske: ['Očekivan je JSON objekt s postavkama'], zakrpa: {} }
    }
    this.provjeriRazinu(tijelo as Record<string, unknown>, this.shema, '', zakrpa, greske)
    if (!greske.length && !Object.keys(zakrpa).length) greske.push('Nijedna postavka nije poslana')
    return { ok: greske.length === 0, greske, zakrpa: zakrpa as Partial<T> }
  }

  private provjeriRazinu(
    t: Record<string, unknown>, shema: Shema, prefiks: string,
    izlaz: Record<string, unknown>, greske: string[],
  ): void {
    const dopustena = Object.keys(shema)
    for (const k of Object.keys(t)) {
      if (!dopustena.includes(k)) {
        greske.push(`Nepoznato polje: ${prefiks}${k} (dopušteno: ${dopustena.join(', ')})`)
      }
    }
    for (const [k, polje] of Object.entries(shema)) {
      if (!(k in t)) continue
      const puno = `${prefiks}${k}`
      const v = t[k]
      switch (polje.tip) {
        case 'bool':
          if (typeof v !== 'boolean') greske.push(`${puno} mora biti true ili false`)
          else izlaz[k] = v
          break
        case 'broj': {
          const n = Number(v)
          if (!Number.isFinite(n)) { greske.push(`${puno} mora biti broj`); break }
          if (polje.min !== undefined && n < polje.min) { greske.push(`${puno} ne smije biti manji od ${polje.min}`); break }
          if (polje.max !== undefined && n > polje.max) { greske.push(`${puno} ne smije biti veći od ${polje.max}`); break }
          izlaz[k] = n
          break
        }
        case 'izbor':
          if (!polje.vrijednosti?.includes(String(v))) {
            greske.push(`${puno} mora biti jedno od: ${(polje.vrijednosti || []).join(', ')}`)
          } else izlaz[k] = String(v)
          break
        case 'popis':
          if (!Array.isArray(v)) { greske.push(`${puno} mora biti popis`); break }
          if (v.some(x => typeof x === 'object')) { greske.push(`${puno} smije sadržavati samo tekst i brojeve`); break }
          izlaz[k] = v.map(x => String(x).trim()).filter(Boolean)
          break
        case 'objekt': {
          if (!v || typeof v !== 'object' || Array.isArray(v)) { greske.push(`${puno} mora biti objekt`); break }
          const pod: Record<string, unknown> = {}
          this.provjeriRazinu(v as Record<string, unknown>, polje.polja || {}, `${puno}.`, pod, greske)
          if (Object.keys(pod).length) izlaz[k] = pod
          break
        }
        default: {
          const s = String(v ?? '').trim()
          if (polje.maxDuljina !== undefined && s.length > polje.maxDuljina) {
            greske.push(`${puno} je predugačak (najviše ${polje.maxDuljina} znakova)`)
            break
          }
          if (s && polje.uzorak && !polje.uzorak.test(s)) {
            greske.push(polje.uzorakPoruka ? `${puno}: ${polje.uzorakPoruka}` : `${puno} nije ispravnog oblika`)
            break
          }
          izlaz[k] = s
        }
      }
    }
  }

  /** Spoji zakrpu s onim što je na disku i zapiši (atomski tmp + rename). */
  save(zakrpa: Partial<T>, path: string = this.putanjaPisanja): T & Record<string, unknown> {
    const trenutno = this.load(existsSync(path) ? path : this.putanja)
    const novo = spoji(trenutno, zakrpa)
    osigurajMapu(path)
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n', 'utf-8')
    renameSync(tmp, path)
    return novo as T & Record<string, unknown>
  }
}

// ─── Tajne ───────────────────────────────────────────────────────────────────

/** Datoteka s tajnama uz konfiguraciju (`IME=vrijednost`), prava 0600. */
export const CREDENTIALS_FILE = konfigPutanja('credentials.env', 'TM_CREDENTIALS')

/**
 * Je li tajna postavljena? Gleda okolinu, pa datoteku. NIKAD ne vraća vrijednost —
 * pozivatelj dobiva samo `true`/`false`, pa se ne može dogoditi da tajna procuri u
 * odgovor API-ja ili u dnevnik.
 */
export function tajnaPostavljena(imeVarijable: string, credPath: string = CREDENTIALS_FILE): boolean {
  const ime = String(imeVarijable || '').trim()
  if (!ime) return false
  if (process.env[ime]) return true
  try {
    if (!existsSync(credPath)) return false
    const redci = readFileSync(credPath, 'utf-8').split('\n')
    return redci.some(r => {
      const t = r.trim()
      if (!t || t.startsWith('#')) return false
      const [k, ...ost] = t.split('=')
      return k?.trim() === ime && ost.join('=').trim().length > 0
    })
  } catch {
    return false
  }
}

/** Vrijednost tajne za POZIV (ne za prikaz). Vraća `null` ako je nema. */
export function procitajTajnu(imeVarijable: string, credPath: string = CREDENTIALS_FILE): string | null {
  const ime = String(imeVarijable || '').trim()
  if (!ime) return null
  if (process.env[ime]) return process.env[ime] as string
  try {
    if (!existsSync(credPath)) return null
    for (const r of readFileSync(credPath, 'utf-8').split('\n')) {
      const t = r.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i > 0 && t.slice(0, i).trim() === ime) return t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* nema datoteke ili nije čitljiva */ }
  return null
}

/** Zapiši tajnu u `credentials.env` s pravima 0600. JSON i dalje nosi samo IME varijable. */
export function zapisiTajnu(
  imeVarijable: string, vrijednost: string, credPath: string = CREDENTIALS_FILE,
): { ok: boolean; greska?: string } {
  const ime = String(imeVarijable || '').trim()
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(ime)) {
    return { ok: false, greska: 'ime varijable mora biti VELIKIM_SLOVIMA (A-Z, 0-9, _)' }
  }
  if (/[\r\n]/.test(vrijednost)) return { ok: false, greska: 'tajna ne smije sadržavati prijelaz retka' }
  try {
    osigurajMapu(credPath)
    const postojeci = existsSync(credPath) ? readFileSync(credPath, 'utf-8').split('\n') : []
    const ostali = postojeci.filter(r => {
      const t = r.trim()
      if (!t || t.startsWith('#')) return true
      return t.split('=')[0]?.trim() !== ime
    })
    ostali.push(`${ime}=${vrijednost}`)
    const tekst = ostali.filter((r, i, a) => !(r === '' && a[i - 1] === '')).join('\n').replace(/\n*$/, '\n')
    const tmp = `${credPath}.tmp-${process.pid}`
    writeFileSync(tmp, tekst, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, credPath)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, greska: String(e?.message || e) }
  }
}

/** Zajedničko stanje za ploču: što je podešeno, bez ijedne vrijednosti. */
export interface StanjeIntegracije {
  ukljucen: boolean
  tajnaPostavljena: boolean
  spreman: boolean
  zastoKey: string
  zastoVars?: Record<string, string>
}
