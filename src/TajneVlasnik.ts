/**
 * TajneVlasnik — upis tajni s ploče BEZ ijedne naredbe na stroju (TASK-5357, ADR-0007 §4.2a).
 *
 * 1. Primatelj koda: izričit `tajne.json → potvrdaUid` (CLI), inače VLASNIK iz profila instance
 *    čvora (`$TM_HOME/config/profil.instanca.env`): `VLASNIK_UID`, inače JEDINI privatni chat iz
 *    `TG_DOPUSTENI_CHATOVI` (pozitivan id je uid čovjeka) koji je i u `RAZGOVOR_DOPUSTENI_KORISNICI`. Profil instance piše instalater
 *    (ADR-0004), ploča ga NE mijenja — za razliku od `telegram.json`, koji ploča mijenja i koji
 *    bi uređaju iz LAN-a dao da sebe postavi za primatelja (A1).
 * 2. „upiši lozinku za mail" s Telegrama (samo vlasnik) → uputa korak po korak i poveznica na
 *    obrazac ploče; sam kod šalje ploča tek kad vlasnik klikne Spremi.
 */
import { existsSync, readFileSync } from 'fs'
import type { NetworkInterfaceInfo } from 'os'
import { normaliziraj } from './razgovor/Filtar'
import { privatnaAdresa } from './TajneApi'
import type { DopustenoIme } from './LoginCreds'

const UID_RE = /^\d{1,20}$/

/** `KLJUČ=vrijednost` (uz `export` i navodnike); komentari i prazni redovi se preskaču. */
export function citajInstancu(put: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (!existsSync(put)) return out
    for (const red of readFileSync(put, 'utf-8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(red)
      if (!m) continue
      let v = m[2]!.trim()
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
      out[m[1]!] = v
    }
  } catch { /* nečitljiv profil = nema vlasnika */ }
  return out
}

/** JSON popis (`["a","b"]`) ili zarezima odvojen niz. */
function popis(v: string | undefined): string[] {
  if (!v) return []
  try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map(x => String(x).trim()) } catch { /* nije JSON */ }
  return v.split(',').map(x => x.trim())
}

export type IzvorPrimatelja = 'tajne.json' | 'profil.VLASNIK_UID' | 'profil.TG_DOPUSTENI_CHATOVI' | 'nema'

export function primateljiKoda(izricito: string[], inst: Record<string, string>): { uid: string[]; izvor: IzvorPrimatelja } {
  const cisto = (x: string[]) => [...new Set(x.filter(u => UID_RE.test(u)))]
  if (cisto(izricito).length) return { uid: cisto(izricito), izvor: 'tajne.json' }
  const vlasnik = cisto(popis(inst.VLASNIK_UID))
  if (vlasnik.length) return { uid: vlasnik, izvor: 'profil.VLASNIK_UID' }
  // Rezerva samo kad je NEDVOSMISLENA: točno jedan privatni chat, i taj je čovjek ujedno
  // dopušteni sugovornik razgovora. Više kandidata = instalater neka upiše VLASNIK_UID.
  const privatni = cisto(popis(inst.TG_DOPUSTENI_CHATOVI))
  const sugovornici = popis(inst.RAZGOVOR_DOPUSTENI_KORISNICI)
  if (privatni.length === 1 && sugovornici.includes(privatni[0]!)) return { uid: privatni, izvor: 'profil.TG_DOPUSTENI_CHATOVI' }
  return { uid: [], izvor: 'nema' }
}

// ─── Zahtjev s Telegrama ─────────────────────────────────────────────────────

const GLAGOL = /\b(upis|unes|unij|postav|promijen|promjen|zamijen|rotir|azurir|dodaj|spremi|trebam|zelim|hocu)\w*/
const PREDMET = /\b(lozink|zaporka|password|passwd|token|tajn|kljuc|api key)\w*/
const KATEGORIJE: [RegExp, string][] = [
  [/\b(e ?-?mail|mail|posta|poste|postu|smtp|imap)\b/, 'email'],
  [/\bnextcloud/, 'nextcloud'],
  [/\bgithub/, 'github'],
  [/\bgitlab/, 'gitlab'],
  [/\btelegram|\bbot ?token/, 'telegram'],
  [/\bopenrouter/, 'davatelj.openrouter'],
  [/\bgemini/, 'davatelj.gemini'],
  [/\bpgvector|\bpostgres/, 'rag.pgvector'],
]

/**
 * Prepoznaje molbu za UPIS (ne pitanje „koja je lozinka"): glagol upisa + riječ lozinka/token.
 * Vraća izvor tajne (`email`, `github`…; prazno = sve) ili `null`.
 */
export function prepoznajZahtjevTajne(tekst: string): { izvor: string } | null {
  const t = normaliziraj(tekst).replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
  if (!GLAGOL.test(t) || !PREDMET.test(t)) return null
  if (/\b(koja|koji|kakva|reci|posalji mi|procitaj|pokazi)\b/.test(t)) return null
  for (const [re, izvor] of KATEGORIJE) if (re.test(t)) return { izvor }
  return { izvor: '' }
}

// ─── Adrese ploče i uputa ────────────────────────────────────────────────────

export interface AdresaPloce { url: string; vrsta: 'lan' | 'tailscale' | 'javni' }

/**
 * Adrese OVOG stroja po kojima ga vlasnik doseže (LAN, Tailscale). Samo one koje ploča prihvaća
 * (`isHostAllowed`) — inače bi poveznica vodila na 403. `TM_JAVNI_URL` ima prednost.
 */
export function adresePloce(o: {
  port: number; dopusten: (host: string) => boolean
  sucelja: NodeJS.Dict<NetworkInterfaceInfo[]>; javniUrl?: string
}): AdresaPloce[] {
  if (o.javniUrl) return [{ url: o.javniUrl.replace(/\/+$/, ''), vrsta: 'javni' }]
  const lan: AdresaPloce[] = [], ts: AdresaPloce[] = []
  for (const popisS of Object.values(o.sucelja)) for (const s of popisS || []) {
    if (s.internal || (s.family as unknown) !== 'IPv4' && (s.family as unknown) !== 4) continue
    const [a, b] = s.address.split('.').map(Number)
    const tailscale = a === 100 && b! >= 64 && b! <= 127
    if (!tailscale && !privatnaAdresa(s.address)) continue
    if (!o.dopusten(s.address)) continue
    ;(tailscale ? ts : lan).push({ url: `http://${s.address}:${o.port}`, vrsta: tailscale ? 'tailscale' : 'lan' })
  }
  return [...lan, ...ts]
}

export function uputaZaUpis(o: {
  izvor: string; imena: DopustenoIme[]; cvor: string; bot?: string | null; adrese: AdresaPloce[]
}): string {
  const imena = o.imena.filter(d => !o.izvor || d.izvor === o.izvor || d.izvor.startsWith(o.izvor + '.')).map(d => d.ime)
  const sidro = `#tajne${imena.length ? `&ime=${imena.join(',')}` : ''}`
  const bot = o.bot ? `@${o.bot}` : 'ovog bota'
  const sto = o.izvor === 'email' ? 'lozinke za mail' : o.izvor ? `tajne (${o.izvor})` : 'lozinke ili tokena'
  const veze = o.adrese.length
    ? o.adrese.map(a => `   ${a.vrsta === 'tailscale' ? 'preko Tailscalea' : a.vrsta === 'lan' ? 'u lokalnoj mreži' : 'adresa ploče'}: ${a.url}/${sidro}`).join('\n')
    : `   ploča čvora ${o.cvor} (Config → Tajne)`
  return [
    `🔑 Upis ${sto} na ${o.cvor} — bez ijedne naredbe na stroju:`,
    `1. Otvori privatni chat s ${bot} i pošalji /start (samo prvi put — bez toga ti bot ne može poslati kod).`,
    `2. Otvori obrazac na ploči (mobitel ili preglednik):`,
    veze,
    `3. Upiši lozinku${imena.length ? ` u polje ${imena.join(' / ')}` : ''} i klikni „Spremi".`,
    `4. ${bot} ti u PRIVATNI chat pošalje kod od 8 znamenki (vrijedi 5 min) — upiši ga na ploči i klikni „Potvrdi".`,
    `Lozinku NE šalji ovdje u chat — ploča je ne prikazuje ni nakon upisa.`,
  ].join('\n')
}
