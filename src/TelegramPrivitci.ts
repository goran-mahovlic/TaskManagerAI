/**
 * TelegramPrivitci — slika, dokument, glas, zvuk i video iz Telegrama spremaju se lokalno
 * (TASK-5282), a putanja ide dalje u tekstu poruke: `[PRIVITAK: /putanja]`.
 *
 * Do sada je poller poruku bez teksta i opisa preskakao, a privitke nije ni gledao — slika
 * poslana u grupu nestajala je bez traga. Ovo je OPCIJA paketa (`telegram.privitci`,
 * zadano isključena), ne zakrpa za jedan stroj.
 *
 * SIGURNOST (sve četiri su uvjet, ne dodatak):
 *   1. preuzima se samo od dopuštenih — chat mora proći `ulaz.dopusteniChatovi`, a pošiljatelj
 *      popis korisnika ulaza ili razgovora; bez ikakvog izričitog popisa NE preuzima se ništa;
 *   2. ime datoteke je SANITIZIRANO (samo osnovno ime, bez `..`, kose crte i vodeće točke),
 *      a odredište se još jednom provjeri da je unutar mape;
 *   3. strop veličine vrijedi dvaput: prema veličini iz poruke PRIJE preuzimanja i prema
 *      stvarno preuzetim bajtovima (veličina u poruci može lagati);
 *   4. datoteka se piše s pravima 0600 — nikad izvršna — i ništa je ne pokreće.
 *
 * Token ne smije ući u zapis: URL za preuzimanje sadrži token, pa svaki tekst greške prolazi
 * kroz `bezTajne` prije nego dođe do dnevnika ili poruke.
 */

import { appendFileSync, chmodSync, copyFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve, sep } from 'path'
import { TM_ROOT, osigurajMapu } from './core/paths'
import { jeDopusten } from './razgovor/Filtar'
import type { RazgovorPostavke } from './razgovor/RazgovorPostavke'

export type VrstaPrivitka = 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note'
export const VRSTE_PRIVITAKA: readonly VrstaPrivitka[] = ['photo', 'document', 'voice', 'audio', 'video', 'video_note']
/** Vrste koje nose govor — idu na STT kad je `razgovor.glasPrepoznavanje` uključen (TASK-5294). */
export const GOVORNE_VRSTE: readonly VrstaPrivitka[] = ['voice', 'audio', 'video_note']

export interface TelegramPrivitci {
  ukljucen: boolean
  /** Prazno = `$TM_HOME/privitci`. Ispod se uvijek slaže `<chatId>/`. */
  mapa: string
  /** Strop po datoteci; Bot API `getFile` ionako ne daje više od 20 MB. */
  maxMB: number
  vrste: VrstaPrivitka[]
}

export const ZADANI_PRIVITCI: TelegramPrivitci = {
  ukljucen: false,
  mapa: '',
  maxMB: 20,
  vrste: [...VRSTE_PRIVITAKA],
}

export const GRANICE_PRIVITAKA = { maxMB: { min: 1, max: 20 }, mapa: { maxDuljina: 300 } } as const

/** Validacija grane `privitci` iz zakrpe ploče. Vraća očišćenu granu ili greške. */
export function validirajPrivitke(v: unknown): { greske: string[]; izlaz: Partial<TelegramPrivitci> } {
  const greske: string[] = []
  const izlaz: Partial<TelegramPrivitci> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { greske: ['privitci mora biti objekt'], izlaz }
  const p = v as Record<string, unknown>
  const dopustena = Object.keys(ZADANI_PRIVITCI)
  for (const k of Object.keys(p)) {
    if (!dopustena.includes(k)) greske.push(`Nepoznato polje: privitci.${k} (dopušteno: ${dopustena.join(', ')})`)
  }
  if ('ukljucen' in p) {
    if (typeof p.ukljucen !== 'boolean') greske.push('privitci.ukljucen mora biti true ili false')
    else izlaz.ukljucen = p.ukljucen
  }
  if ('maxMB' in p) {
    const n = Number(p.maxMB)
    const g = GRANICE_PRIVITAKA.maxMB
    if (!Number.isFinite(n) || n < g.min || n > g.max) greske.push(`privitci.maxMB mora biti broj između ${g.min} i ${g.max}`)
    else izlaz.maxMB = n
  }
  if ('mapa' in p) {
    const m = String(p.mapa ?? '').trim()
    if (m.length > GRANICE_PRIVITAKA.mapa.maxDuljina) greske.push(`privitci.mapa je predugačka (najviše ${GRANICE_PRIVITAKA.mapa.maxDuljina} znakova)`)
    else if (m && !m.startsWith('/')) greske.push('privitci.mapa mora biti apsolutna putanja (ili prazno za zadanu)')
    else if (m.split('/').includes('..')) greske.push('privitci.mapa ne smije sadržavati ..')
    else izlaz.mapa = m
  }
  if ('vrste' in p) {
    if (!Array.isArray(p.vrste)) greske.push('privitci.vrste mora biti popis')
    else {
      const krive = p.vrste.filter(x => !VRSTE_PRIVITAKA.includes(x as VrstaPrivitka))
      if (krive.length) greske.push(`privitci.vrste: nepoznato ${krive.join(', ')} (dopušteno: ${VRSTE_PRIVITAKA.join(', ')})`)
      else izlaz.vrste = [...new Set(p.vrste as VrstaPrivitka[])]
    }
  }
  return { greske, izlaz }
}

/** `<mapa ili $TM_HOME/privitci>/<chatId>` — chat id se čisti kao i ime datoteke. */
export function mapaPrivitaka(p: TelegramPrivitci, chatId: string, tmRoot: string = TM_ROOT): string {
  const korijen = p.mapa?.trim() || join(tmRoot, 'privitci')
  const chat = String(chatId).replace(/[^0-9A-Za-z_-]/g, '_') || 'chat'
  return join(korijen, chat)
}

// ─── Odabir ──────────────────────────────────────────────────────────────────

interface TgDatoteka { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string; mime_type?: string }
interface TgFoto extends TgDatoteka { width?: number; height?: number }

/** Polja poruke s privitkom (samo ono što koristimo). */
export interface PorukaSPrivitkom {
  message_id: number
  date?: number
  photo?: TgFoto[]
  document?: TgDatoteka
  voice?: TgDatoteka & { duration?: number }
  audio?: TgDatoteka & { duration?: number }
  video?: TgDatoteka & { duration?: number }
  /** Video-krug (okrugla video poruka). */
  video_note?: TgDatoteka & { duration?: number; length?: number }
}

export interface OdabraniPrivitak { vrsta: VrstaPrivitka; fileId: string; ime?: string; velicina?: number; mime?: string }

/** Prvi privitak dopuštene vrste; za fotografiju NAJVEĆA rezolucija (ne nužno zadnja u nizu). */
export function odaberiPrivitak(m: PorukaSPrivitkom, vrste: readonly VrstaPrivitka[]): OdabraniPrivitak | null {
  for (const vrsta of VRSTE_PRIVITAKA) {
    if (!vrste.includes(vrsta)) continue
    if (vrsta === 'photo') {
      if (!m.photo?.length) continue
      const naj = [...m.photo].sort((a, b) =>
        ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)) || (b.file_size || 0) - (a.file_size || 0))[0]!
      return { vrsta, fileId: naj.file_id, velicina: naj.file_size }
    }
    const d = m[vrsta]
    if (!d?.file_id) continue
    return {
      vrsta, fileId: d.file_id, ...(d.file_name ? { ime: d.file_name } : {}), velicina: d.file_size,
      ...(d.mime_type ? { mime: d.mime_type } : {}),
    }
  }
  return null
}

/** Ima li poruka ikakav privitak koji bi se mogao spremiti (bez obzira na dopuštenje). */
export function imaPrivitak(m: PorukaSPrivitkom, p: TelegramPrivitci): boolean {
  return p.ukljucen && odaberiPrivitak(m, p.vrste) !== null
}

// ─── Tko smije ───────────────────────────────────────────────────────────────

/**
 * Dopuštenje za preuzimanje. Chat je već prošao `ulaz.dopusteniChatovi` u polleru; ovdje se
 * gleda pošiljatelj: ako postoji ijedan popis korisnika (ulaz ili razgovor), mora biti na
 * nekom od njih (id ili korisničko ime). Bez popisa korisnika odlučuje IZRIČIT popis chatova;
 * bez ikakvog popisa — ne. Bot koji sprema sve što mu itko pošalje u bilo koji chat nije opcija.
 */
export function dopustenoPreuzeti(
  m: { chat: { id: number | string }; from?: { id: number | string; username?: string } },
  ulaz: { dopusteniChatovi: string[]; dopusteniKorisnici: string[] },
  rp: Pick<RazgovorPostavke, 'dopusteniKorisnici'> | null,
): boolean {
  if (ulaz.dopusteniChatovi.length && !ulaz.dopusteniChatovi.includes(String(m.chat.id))) return false
  const korisnici = [...ulaz.dopusteniKorisnici, ...(rp?.dopusteniKorisnici || [])]
  if (korisnici.length) {
    return jeDopusten({
      posiljateljId: String(m.from?.id ?? ''),
      ...(m.from?.username ? { posiljateljKorisnickoIme: m.from.username } : {}),
    }, korisnici)
  }
  return ulaz.dopusteniChatovi.length > 0
}

// ─── Ime i zapis ─────────────────────────────────────────────────────────────

const MAX_IME = 100

/** `<datum>_<message_id>_<izvorno ime>` — samo osnovno ime, bez `..`, kose crte i vodeće točke. */
export function imePrivitka(izvorno: string | undefined, messageId: number, dateSek?: number): string {
  const d = dateSek ? new Date(dateSek * 1000) : new Date()
  const datum = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let ime = basename(String(izvorno || '').replace(/\\/g, '/'))
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^[.]+/, '')
  if (!ime || /^[._-]*$/.test(ime)) ime = 'privitak'
  if (ime.length > MAX_IME) {
    const tocka = ime.lastIndexOf('.')
    const nastavak = tocka > 0 && ime.length - tocka <= 10 ? ime.slice(tocka) : ''
    ime = ime.slice(0, MAX_IME - nastavak.length) + nastavak
  }
  return `${datum}_${Math.trunc(Number(messageId)) || 0}_${ime}`
}

/** Makni token (i svaki oblik `bot<id>:<tajna>`) iz teksta prije dnevnika ili poruke. */
export function bezTajne(s: string, token: string): string {
  let t = String(s ?? '')
  if (token) t = t.split(token).join('***')
  return t.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')
}

/**
 * Tuđi tekst ne smije glumiti oznaku `[PRIVITAK: …]` (isti obrazac kao `razgovor/Ciscenje.ts`):
 * `[` → `(`, pa ulaz i model vide samo oznaku koju je složio poller.
 */
export function neutralizirajOznakuPrivitka(t: string): string {
  return t.replace(/\[(?=\s*(?:PRIVITAK|GLAS\b))/giu, '(')
}

export type IshodPrivitka = { ok: true; putanja: string } | { ok: false; razlog: string }

/** Zapiši bajtove u mapu chata; odredište MORA ostati unutar mape. Prava 0600, nikad izvršno. */
export function zapisiPrivitak(mapa: string, ime: string, bajtovi: Uint8Array): IshodPrivitka {
  const cilj = resolve(mapa, ime)
  if (!cilj.startsWith(resolve(mapa) + sep)) return { ok: false, razlog: 'ime izlazi iz mape privitaka' }
  osigurajMapu(cilj)
  const tmp = `${cilj}.tmp-${process.pid}`
  writeFileSync(tmp, bajtovi, { mode: 0o600 })
  renameSync(tmp, cilj)
  return { ok: true, putanja: cilj }
}

// ─── Evidencija (uputa #187: oba smjera, tko, kad, put) ──────────────────────

export interface ZapisEvidencije {
  smjer: 'primljeno' | 'poslano'
  kad: string
  chatId: string
  poruka: number
  vrsta: string
  tkoId: string
  tko: string
  putanja?: string
  /** Poslano: odakle je dokument kopiran. */
  izvor?: string
  greska?: string
}

/** Jedan redak JSON-a po privitku u `<mapa chata>/evidencija.jsonl` (0600). Ne ruši tok. */
export function zabiljeziEvidenciju(mapaChata: string, z: ZapisEvidencije): void {
  try {
    const put = osigurajMapu(join(mapaChata, 'evidencija.jsonl'))
    appendFileSync(put, JSON.stringify(z) + '\n', { encoding: 'utf-8', mode: 0o600 })
  } catch { /* evidencija nije vrijedna gubitka poruke */ }
}

function tkoJe(from?: { id: number | string; first_name?: string; username?: string }): string {
  return [from?.first_name, from?.username ? `(@${from.username})` : ''].filter(Boolean).join(' ').trim() ||
    String(from?.id ?? '?')
}

/**
 * Dokument koji bot pošalje u chat (SEND_DOC) — kopija u mapu tog chata i redak evidencije.
 * Izvor ostaje gdje je bio; kopija je 0600. Ništa se ne radi ako su privitci isključeni.
 */
export function arhivirajPoslano(
  p: TelegramPrivitci, chatId: string, izvor: string, porukaId: number,
  bot: { id?: number | string; username?: string } | null, tmRoot: string = TM_ROOT,
): IshodPrivitka | null {
  if (!p.ukljucen) return null
  const mapa = mapaPrivitaka(p, chatId, tmRoot)
  const z: ZapisEvidencije = {
    smjer: 'poslano', kad: new Date().toISOString(), chatId: String(chatId), poruka: porukaId,
    vrsta: 'document', tkoId: String(bot?.id ?? ''), tko: bot?.username ? `@${bot.username}` : 'bot', izvor,
  }
  try {
    if (statSync(izvor).size > 50 * 1024 * 1024) throw new Error('veći od 50 MB')
    const cilj = resolve(mapa, imePrivitka(basename(izvor), porukaId, Math.floor(Date.now() / 1000)))
    if (!cilj.startsWith(resolve(mapa) + sep)) throw new Error('ime izlazi iz mape privitaka')
    osigurajMapu(cilj)
    copyFileSync(izvor, cilj)
    chmodSync(cilj, 0o600)
    zabiljeziEvidenciju(mapa, { ...z, putanja: cilj })
    return { ok: true, putanja: cilj }
  } catch (e: any) {
    const razlog = String(e?.message || e).slice(0, 200)
    zabiljeziEvidenciju(mapa, { ...z, greska: razlog })
    return { ok: false, razlog }
  }
}

/** Odgovor ubrizganog `preuzmi` iz `Api` (pravi: `getFile` + preuzimanje). */
export type Preuzeto = { ok: true; bajtovi: Uint8Array; filePath?: string } | { ok: false; greska: string }

/**
 * Preuzmi i spremi jedan privitak. Sve greške su već bez tajni — smiju u tekst poruke.
 */
export async function spremiPrivitak(
  m: PorukaSPrivitkom & { chat: { id: number | string }; from?: { id: number | string; first_name?: string; username?: string } },
  odabran: OdabraniPrivitak,
  p: TelegramPrivitci,
  preuzmi: (fileId: string, maxBajta: number) => Promise<Preuzeto>,
  token: string,
  tmRoot: string = TM_ROOT,
): Promise<IshodPrivitka> {
  const r = await preuzmiISpremi(m, odabran, p, preuzmi, token, tmRoot)
  zabiljeziEvidenciju(mapaPrivitaka(p, String(m.chat.id), tmRoot), {
    smjer: 'primljeno', kad: new Date().toISOString(), chatId: String(m.chat.id), poruka: m.message_id,
    vrsta: odabran.vrsta, tkoId: String(m.from?.id ?? ''), tko: tkoJe(m.from),
    ...(r.ok ? { putanja: r.putanja } : { greska: r.razlog }),
  })
  return r
}

async function preuzmiISpremi(
  m: PorukaSPrivitkom & { chat: { id: number | string } },
  odabran: OdabraniPrivitak,
  p: TelegramPrivitci,
  preuzmi: (fileId: string, maxBajta: number) => Promise<Preuzeto>,
  token: string,
  tmRoot: string,
): Promise<IshodPrivitka> {
  const maxBajta = Math.round(p.maxMB * 1024 * 1024)
  if (odabran.velicina && odabran.velicina > maxBajta) {
    return { ok: false, razlog: `veći od ${p.maxMB} MB` }
  }
  try {
    const r = await preuzmi(odabran.fileId, maxBajta)
    if (!r.ok) return { ok: false, razlog: bezTajne(r.greska, token).slice(0, 200) }
    if (r.bajtovi.byteLength > maxBajta) return { ok: false, razlog: `veći od ${p.maxMB} MB` }
    const izvorno = odabran.ime || (r.filePath ? basename(r.filePath) : `${odabran.vrsta}`)
    const ime = imePrivitka(izvorno, m.message_id, m.date)
    return zapisiPrivitak(mapaPrivitaka(p, String(m.chat.id), tmRoot), ime, r.bajtovi)
  } catch (e: any) {
    return { ok: false, razlog: bezTajne(String(e?.message || e), token).slice(0, 200) }
  }
}

/**
 * Pravo preuzimanje: `getFile` → `/file/bot<token>/<file_path>`. Strop se provjerava prema
 * `file_size` iz `getFile`, prema `Content-Length` i prema stvarno pročitanim bajtovima
 * (čitanje se prekida čim prijeđe strop). URL se nigdje ne vraća ni ne zapisuje.
 */
export function telegramPreuzmi(botToken: string, rokMs = 60_000) {
  return async (fileId: string, maxBajta: number): Promise<Preuzeto> => {
    try {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
        { signal: AbortSignal.timeout(rokMs) })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok || !j?.ok || !j.result?.file_path) {
        return { ok: false, greska: `getFile ${r.status}: ${bezTajne(j?.description || 'nema file_path', botToken)}` }
      }
      if (j.result.file_size && j.result.file_size > maxBajta) return { ok: false, greska: `veći od ${Math.round(maxBajta / 1048576)} MB` }
      const filePath = String(j.result.file_path)
      const putDijelovi = filePath.split('/').map(encodeURIComponent).join('/')
      const d = await fetch(`https://api.telegram.org/file/bot${botToken}/${putDijelovi}`, { signal: AbortSignal.timeout(rokMs) })
      if (!d.ok || !d.body) return { ok: false, greska: `preuzimanje ${d.status}` }
      if (Number(d.headers.get('content-length') || 0) > maxBajta) return { ok: false, greska: `veći od ${Math.round(maxBajta / 1048576)} MB` }
      const dijelovi: Uint8Array[] = []
      let ukupno = 0
      const citac = d.body.getReader()
      for (;;) {
        const { done, value } = await citac.read()
        if (done) break
        ukupno += value.byteLength
        if (ukupno > maxBajta) { await citac.cancel().catch(() => {}); return { ok: false, greska: `veći od ${Math.round(maxBajta / 1048576)} MB` } }
        dijelovi.push(value)
      }
      const bajtovi = new Uint8Array(ukupno)
      let o = 0
      for (const x of dijelovi) { bajtovi.set(x, o); o += x.byteLength }
      return { ok: true, bajtovi, filePath }
    } catch (e: any) {
      return { ok: false, greska: bezTajne(String(e?.message || e), botToken) }
    }
  }
}
