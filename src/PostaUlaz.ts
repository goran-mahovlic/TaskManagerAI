/**
 * PostaUlaz — provjera e-pošte s obaviješću u grupu i ODLUKOM ČOVJEKA (TASK-5358).
 *
 * Isti obrazac kao `mail_recap.py` izvornog sustava, ali u paketu, u procesu ploče:
 *
 *   IMAP (readonly, BODY.PEEK) → nova poruka → obavijest u Telegram grupu čvora (vlastiti bot)
 *                                                       │
 *   odgovor na obavijest: „zadatak" | „ignoriraj" | „odgovori: …"  ← čovjek odlučuje
 *                                                       │
 *                         ploča: zadatak s mailom / zapis / odgovor pošiljatelju + trag
 *
 * PRAVILA (zahtjev vlasnika, 08.10.2026.):
 *   1. prvi prolaz NE šalje staru poštu — samo zapamti UIDVALIDITY i zadnji UID;
 *   2. poruke ostaju nepročitane (mapa se otvara `readOnly`, tijelo se čita kao BODY.PEEK);
 *   3. NIKAD automatski odgovor pošiljatelju — pošta odlazi samo na izričit „odgovori: …"
 *      dopuštenog korisnika;
 *   4. neuspjela prijava / IMAP greška = JEDNA dojava; sljedeća tek kad proradi („ponovno radi");
 *   5. slanje u grupu koje padne ne pomiče stanje — isti mail ide u sljedećem prolazu.
 *
 * Stanje (`data/posta.json`) piše se KRATKIM čitaj-promijeni-zapiši odsječcima bez `await`-a
 * u sredini: petlja i odgovor iz grupe rade u istom procesu, pa bi duže držano stanje
 * pregazilo tuđu odluku.
 *
 * Autorica: Jelena (Engineer), TASK-5358.
 */

import { readFileSync, renameSync, writeFileSync } from 'fs'
import { osigurajMapu, stanjePutanja } from './core/paths'
import { loadEmailConfig, type EmailPostavke } from './EmailConfig'

export const POSTA_STANJE_PUTANJA = stanjePutanja('posta.json')
export const NAJVISE_U_PROLAZU = 10
export const NAJVISE_ZAPISA = 300
export const NAJVISE_TIJELA = 4000
/** Veće poruke se ne preuzimaju cijele — obavijest tada nosi samo zaglavlja i popis privitaka. */
export const NAJVISE_BAJTA_PORUKE = 15 * 1024 * 1024
export const ZADANA_ZONA = 'Europe/Zagreb'

// ─── Tipovi ──────────────────────────────────────────────────────────────────

export interface Mail {
  uid: number
  od: string
  odAdresa: string
  predmet: string
  /** ISO vrijeme iz zaglavlja `Date` (ili primitka); `null` ako ga nema. */
  datum: string | null
  privitci: string[]
  tijelo: string
  messageId?: string
}

export interface ImapSesija {
  uidValidity: string
  maxUid: number
  noviOd(zadnji: number, najvise: number): Promise<Mail[]>
  zatvori(): Promise<void>
}

export interface ImapKlijent { otvori(): Promise<ImapSesija> }

/** Slanje u grupu; vraća `message_id` poslane poruke (za prepoznavanje odgovora) ili `null`. */
export interface Obavjestac { posalji(chatId: string, tekst: string): Promise<string | null> }

export type Radnja = 'zadatak' | 'ignoriraj' | 'odgovori'

export interface Odluka {
  radnja: Radnja | 'u-tijeku'
  tko: string
  ts: string
  taskId?: string
  tekst?: string
}

export interface ZapisMaila {
  uid: number
  chatId: string
  od: string
  odAdresa: string
  predmet: string
  datum: string | null
  privitci: string[]
  sazetak: string
  tijelo: string
  messageId?: string
  poslano: string
  odluka?: Odluka
  /** Odgovori poslani pošiljatelju (može ih biti više). */
  odgovori?: { tko: string; ts: string; tekst: string }[]
}

export interface StanjePoste {
  uidValidity: string | null
  zadnji: number
  /** Trajna greška (prijava, IMAP, nema lozinke) — dojavljena JEDNOM. */
  greska: { poruka: string; od: string } | null
  zadnjaProvjera: string | null
  obavijesti: number
  /** Ključ = `message_id` obavijesti u grupi. */
  poruke: Record<string, ZapisMaila>
}

export const ZADANO_STANJE_POSTE: StanjePoste = {
  uidValidity: null, zadnji: 0, greska: null, zadnjaProvjera: null, obavijesti: 0, poruke: {},
}

// ─── Spremište stanja ────────────────────────────────────────────────────────

export interface Spremiste { ucitaj(): StanjePoste; zapisi(s: StanjePoste): void }

function normaliziraj(s: any): StanjePoste {
  const x = s && typeof s === 'object' ? s : {}
  return { ...ZADANO_STANJE_POSTE, ...x, poruke: x.poruke && typeof x.poruke === 'object' ? x.poruke : {} }
}

export function datotecnoSpremiste(put: string = POSTA_STANJE_PUTANJA): Spremiste {
  return {
    ucitaj() {
      try { return normaliziraj(JSON.parse(readFileSync(put, 'utf-8'))) } catch { return normaliziraj(null) }
    },
    zapisi(s) {
      try {
        osigurajMapu(put)
        const tmp = `${put}.tmp-${process.pid}`
        writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
        renameSync(tmp, put)
      } catch { /* stanje nije vrijedno rušenja petlje */ }
    },
  }
}

export function memorijskoSpremiste(pocetno?: StanjePoste): Spremiste {
  let s = JSON.stringify(normaliziraj(pocetno || null))
  return { ucitaj: () => normaliziraj(JSON.parse(s)), zapisi: (n) => { s = JSON.stringify(n) } }
}

/** Čitaj-promijeni-zapiši bez `await`-a u sredini (v. zaglavlje). */
function promijeni(sp: Spremiste, fn: (s: StanjePoste) => void): StanjePoste {
  const s = sp.ucitaj()
  fn(s)
  sp.zapisi(s)
  return s
}

function obreziZapise(s: StanjePoste): void {
  const kljucevi = Object.keys(s.poruke)
  if (kljucevi.length <= NAJVISE_ZAPISA) return
  kljucevi.sort((a, b) => String(s.poruke[a].poslano).localeCompare(String(s.poruke[b].poslano)))
  for (const k of kljucevi.slice(0, kljucevi.length - NAJVISE_ZAPISA)) delete s.poruke[k]
}

// ─── Tekst ───────────────────────────────────────────────────────────────────

const RE_CITAT = /^(>|On .{0,200}wrote:|Dana .{0,200}(je )?napisa|-----+ ?(Original Message|Forwarded message|Izvorna poruka)|From: |Od: .*<.*@)/i

/** „7.10.2026. u 12:42, Netko piše:" / „…, X wrote:" — redak koji uvodi citat. */
const RE_ZAGLAVLJE_CITATA = /(wrote|piše|napisao|napisala|je napisao|schrieb|a écrit)\s*:\s*$/i

/** 2–3 retka tijela: bez citata, bez potpisa, bez praznih redaka. */
export function sazetakTijela(tijelo: string, redaka = 3, znakova = 160): string {
  const out: string[] = []
  for (const r of String(tijelo || '').split(/\r?\n/)) {
    const s = r.trim()
    if (s === '--' || s === '-- ' || RE_CITAT.test(s) || RE_ZAGLAVLJE_CITATA.test(s)) break
    if (!s) continue
    out.push(s.length > znakova ? `${s.slice(0, znakova)}…` : s)
    if (out.length >= redaka) break
  }
  return out.join('\n')
}

export function vrijemeZaPrikaz(iso: string | null, zona: string = ZADANA_ZONA): string {
  if (!iso) return '(nepoznato)'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '(nepoznato)'
  try {
    const f = new Intl.DateTimeFormat('hr-HR', {
      timeZone: zona, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const g = (t: string) => f.find(x => x.type === t)?.value || ''
    return `${g('day')}.${g('month')}.${g('year')}. ${g('hour')}:${g('minute')}`
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  }
}

export const UPUTA_ODLUKE = [
  '➡️ Što dalje? Odgovori (reply) na OVU poruku:',
  '• zadatak — otvaram zadatak na ploči s ovim mailom',
  '• ignoriraj — samo bilježim, ništa ne radim',
  '• odgovori: <tekst> — šaljem taj tekst pošiljatelju',
  'Bez tvoje odluke ništa ne odgovaram.',
].join('\n')

export function tekstObavijesti(m: Mail, adresa: string, zona: string = ZADANA_ZONA): string {
  const sazetak = sazetakTijela(m.tijelo)
  return [
    `📧 Nova pošta${adresa ? ` (${adresa})` : ''}`,
    `Od: ${m.od || m.odAdresa || '(nepoznat)'}`,
    `Predmet: ${m.predmet || '(bez predmeta)'}`,
    `Vrijeme: ${vrijemeZaPrikaz(m.datum, zona)}`,
    `Privitci: ${m.privitci.length ? m.privitci.join(', ') : 'nema'}`,
    '',
    sazetak || '(prazno tijelo)',
    '',
    UPUTA_ODLUKE,
    `[mail ${m.uid}]`,
  ].join('\n')
}

function adresaSanducica(cfg: EmailPostavke): string {
  const k = cfg.imap.korisnik || ''
  if (k.includes('@')) return k
  const domena = (cfg.smtp.posiljatelj || '').split('@')[1]
  return domena && k ? `${k}@${domena}` : k
}

/** Greška IMAP-a → kratka rečenica bez tajni (lozinka ne ulazi ni u jednu poruku). */
export function opisGreske(e: any): string {
  if (e?.authenticationFailed) return 'prijava odbijena — provjeri korisnika i lozinku'
  const kod = String(e?.code || '')
  if (kod === 'ENOTFOUND' || kod === 'EAI_AGAIN') return 'poslužitelj nije pronađen (DNS)'
  if (kod === 'ECONNREFUSED') return 'poslužitelj odbija vezu'
  if (kod === 'ETIMEDOUT' || /timeout/i.test(String(e?.message))) return 'poslužitelj se nije javio na vrijeme'
  const tekst = String(e?.responseText || e?.message || e || 'nepoznata greška')
  return tekst.replace(/\s+/g, ' ').slice(0, 200)
}

// ─── Jedan prolaz ────────────────────────────────────────────────────────────

export interface ProlazOpcije {
  cfg: EmailPostavke
  chatId: string
  /** `null` = nema lozinke (v. `bezLozinke`). */
  imap: ImapKlijent | null
  tg: Obavjestac
  spremiste: Spremiste
  konzola?: (redak: string, razina: 'info' | 'ok' | 'greska') => void
  /** Ime varijable kad lozinka nije upisana — dojava kaže gdje je upisati. */
  bezLozinke?: string
  najviseUProlazu?: number
  zona?: string
}

export interface IshodPoste { init: boolean; poslano: number; greska?: string; dojava: boolean }

async function dojaviGresku(o: ProlazOpcije, poruka: string, ishod: IshodPoste): Promise<void> {
  ishod.greska = poruka
  const s = o.spremiste.ucitaj()
  if (s.greska) return                                   // već dojavljeno — tišina do oporavka
  const tekst = `⚠️ Provjera pošte (${adresaSanducica(o.cfg) || o.cfg.imap.host}) ne radi: ${poruka}\n` +
    'Javit ću jednom kad ponovno proradi; do tada ne ponavljam ovu poruku.'
  const id = await o.tg.posalji(o.chatId, tekst)
  // Ako ni dojava nije prošla, greška se NE pamti — pokušat će se u sljedećem prolazu.
  if (id === null) return
  ishod.dojava = true
  promijeni(o.spremiste, x => { x.greska = { poruka, od: new Date().toISOString() } })
  o.konzola?.(`📧 ⚠ pošta: ${poruka} (dojavljeno u grupu)`, 'greska')
}

export async function jedanProlazPoste(o: ProlazOpcije): Promise<IshodPoste> {
  const ishod: IshodPoste = { init: false, poslano: 0, dojava: false }
  if (!o.imap) {
    await dojaviGresku(o, `lozinka nije upisana (${o.bezLozinke || o.cfg.imap.lozinkaEnv}) — upiši je na ploči: Config → Tajne`, ishod)
    return ishod
  }

  let ses: ImapSesija
  try {
    ses = await o.imap.otvori()
  } catch (e) {
    await dojaviGresku(o, opisGreske(e), ishod)
    return ishod
  }

  try {
    const s0 = o.spremiste.ucitaj()
    if (s0.greska) {
      const id = await o.tg.posalji(o.chatId, `✅ Provjera pošte ponovno radi (${adresaSanducica(o.cfg) || o.cfg.imap.host}).`)
      if (id !== null) {
        promijeni(o.spremiste, x => { x.greska = null })
        o.konzola?.('📧 pošta: provjera ponovno radi', 'ok')
      }
    }

    if (s0.uidValidity === null || s0.uidValidity !== ses.uidValidity) {
      promijeni(o.spremiste, x => {
        x.uidValidity = ses.uidValidity
        x.zadnji = ses.maxUid
        x.zadnjaProvjera = new Date().toISOString()
      })
      ishod.init = true
      o.konzola?.(`📧 pošta: početno stanje zapamćeno (zadnji UID ${ses.maxUid}) — stara pošta se ne šalje`, 'info')
      return ishod
    }

    const novi = ses.maxUid > s0.zadnji
      ? await ses.noviOd(s0.zadnji, o.najviseUProlazu ?? NAJVISE_U_PROLAZU)
      : []
    const adresa = adresaSanducica(o.cfg)
    for (const m of [...novi].sort((a, b) => a.uid - b.uid)) {
      if (m.uid <= s0.zadnji) continue
      const id = await o.tg.posalji(o.chatId, tekstObavijesti(m, adresa, o.zona))
      if (id === null) {
        ishod.greska = `slanje obavijesti za mail ${m.uid} u grupu nije uspjelo`
        o.konzola?.(`📧 ⚠ ${ishod.greska} — pokušavam u sljedećem prolazu`, 'greska')
        break
      }
      promijeni(o.spremiste, x => {
        x.zadnji = m.uid
        x.obavijesti++
        x.poruke[id] = {
          uid: m.uid, chatId: o.chatId, od: m.od, odAdresa: m.odAdresa, predmet: m.predmet, datum: m.datum,
          privitci: m.privitci, sazetak: sazetakTijela(m.tijelo), tijelo: String(m.tijelo || '').slice(0, NAJVISE_TIJELA),
          ...(m.messageId ? { messageId: m.messageId } : {}),
          poslano: new Date().toISOString(),
        }
        obreziZapise(x)
      })
      ishod.poslano++
      o.konzola?.(`📧 ⇢ mail ${m.uid} od ${m.od || m.odAdresa}: „${m.predmet || '(bez predmeta)'}" → obavijest u grupu ${o.chatId}`, 'ok')
    }
    promijeni(o.spremiste, x => { x.zadnjaProvjera = new Date().toISOString() })
  } catch (e) {
    await dojaviGresku(o, opisGreske(e), ishod)
  } finally {
    try { await ses.zatvori() } catch { /* veza je ionako gotova */ }
  }
  return ishod
}

// ─── Odgovor u grupi (odluka čovjeka) ────────────────────────────────────────

export interface OdgovorUGrupi {
  chatId: string
  tekst: string
  /** `message_id` poruke na koju je odgovoreno (reply). */
  replyTo?: string
  tko: string
  dopusten: boolean
}

export interface OvisnostiOdluke {
  stvoriZadatak(t: { title: string; description: string; tags: string[]; assignee?: string }): Promise<{ taskId?: string; greska?: string }>
  posaljiOdgovor(x: { prima: string; predmet: string; tekst: string; uOdgovorNa?: string }): Promise<{ ok: boolean; greska?: string }>
  dodajBiljesku?(taskId: string, tekst: string): Promise<void>
  zadaniIzvrsitelj?: string
  konzola?: (redak: string, razina: 'info' | 'ok' | 'greska') => void
}

const RE_MAIL_UID = /^\s*mail\s+(\d+)\s*[:\-–—]?\s*/i

function prepoznajRadnju(t: string): { radnja: Radnja; tekst?: string } | null {
  const s = t.trim()
  if (/^\/?zadatak\b\.?$/i.test(s) || /^\/?zadatak\s*[:\-–—]/i.test(s)) return { radnja: 'zadatak' }
  if (/^\/?ignoriraj\b/i.test(s)) return { radnja: 'ignoriraj' }
  const o = /^\/?odgovori\s*:\s*([\s\S]+)$/i.exec(s)
  if (o && o[1].trim()) return { radnja: 'odgovori', tekst: o[1].trim() }
  return null
}

function naslovZadatka(z: ZapisMaila): string {
  return `📧 ${z.predmet || '(bez predmeta)'} — ${z.od || z.odAdresa}`.slice(0, 200)
}

function opisZadatka(z: ZapisMaila, tko: string): string {
  return [
    '## Mail (izvor: e-pošta, odluka čovjeka u grupi)',
    `Od: ${z.od}${z.odAdresa && !z.od.includes(z.odAdresa) ? ` <${z.odAdresa}>` : ''}`,
    `Predmet: ${z.predmet || '(bez predmeta)'}`,
    `Vrijeme: ${vrijemeZaPrikaz(z.datum)}`,
    `Privitci: ${z.privitci.length ? z.privitci.join(', ') : 'nema'}`,
    `IMAP UID: ${z.uid}${z.messageId ? ` · Message-ID: ${z.messageId}` : ''}`,
    `Odluku donio: ${tko} (chat ${z.chatId})`,
    '',
    '## Tijelo',
    z.tijelo || '(prazno tijelo)',
    '',
    '## Napomena',
    'Pošiljatelju se NE odgovara bez naloga — odgovor ide samo naredbom „odgovori: …" u grupi.',
  ].join('\n')
}

/**
 * Odgovor u grupi na obavijest o pošti. `null` = poruka nije za poštu (ide dalje svojim
 * putem, npr. ingest ili razgovor); inače tekst koji se vraća u grupu.
 */
export async function obradiOdgovorPoste(
  sp: Spremiste, p: OdgovorUGrupi, d: OvisnostiOdluke,
): Promise<string | null> {
  const s = sp.ucitaj()
  let kljuc: string | null = null
  let tekst = p.tekst
  if (p.replyTo && s.poruke[p.replyTo] && s.poruke[p.replyTo].chatId === p.chatId) kljuc = p.replyTo
  else {
    const m = RE_MAIL_UID.exec(p.tekst)
    if (m) {
      const uid = Number(m[1])
      kljuc = Object.keys(s.poruke).find(k => s.poruke[k].uid === uid && s.poruke[k].chatId === p.chatId) || null
      if (kljuc) tekst = p.tekst.slice(m[0].length)
    }
  }
  if (!kljuc) return null
  const z = s.poruke[kljuc]
  const r = prepoznajRadnju(tekst)
  if (!r) return `Za mail ${z.uid} odgovori s: zadatak · ignoriraj · odgovori: <tekst>`
  if (!p.dopusten) return `⛔ O pošti odlučuje samo dopušteni korisnik — „${r.radnja}" za mail ${z.uid} nije izvršen.`
  const ts = new Date().toISOString()
  const log = d.konzola || (() => { /* bez konzole */ })

  if (r.radnja === 'zadatak') {
    if (z.odluka?.taskId) return `📋 Za mail ${z.uid} već postoji zadatak ${z.odluka.taskId}.`
    if (z.odluka?.radnja === 'u-tijeku') return `⏳ Zadatak za mail ${z.uid} se upravo otvara.`
    promijeni(sp, x => { if (x.poruke[kljuc!]) x.poruke[kljuc!].odluka = { radnja: 'u-tijeku', tko: p.tko, ts } })
    let rez: { taskId?: string; greska?: string }
    try {
      rez = await d.stvoriZadatak({
        title: naslovZadatka(z), description: opisZadatka(z, p.tko), tags: ['email', 'nalog'],
        ...(d.zadaniIzvrsitelj ? { assignee: d.zadaniIzvrsitelj } : {}),
      })
    } catch (e: any) { rez = { greska: String(e?.message || e) } }
    if (!rez.taskId) {
      promijeni(sp, x => { if (x.poruke[kljuc!]) delete x.poruke[kljuc!].odluka })
      log(`📧 ⚠ mail ${z.uid}: zadatak nije otvoren — ${rez.greska || 'nepoznat razlog'}`, 'greska')
      return `⚠️ Zadatak za mail ${z.uid} nije otvoren: ${rez.greska || 'nepoznat razlog'}`
    }
    promijeni(sp, x => { if (x.poruke[kljuc!]) x.poruke[kljuc!].odluka = { radnja: 'zadatak', tko: p.tko, ts, taskId: rez.taskId } })
    log(`📧 ✓ mail ${z.uid} („${z.predmet}") → zadatak ${rez.taskId} (odluka: ${p.tko})`, 'ok')
    return `📋 Otvoren zadatak ${rez.taskId} — ${naslovZadatka(z)}`
  }

  if (r.radnja === 'ignoriraj') {
    promijeni(sp, x => { if (x.poruke[kljuc!]) x.poruke[kljuc!].odluka = { ...(x.poruke[kljuc!].odluka?.taskId ? { taskId: x.poruke[kljuc!].odluka!.taskId } : {}), radnja: 'ignoriraj', tko: p.tko, ts } })
    log(`📧 mail ${z.uid} („${z.predmet}") — ignoriran (odluka: ${p.tko})`, 'info')
    if (z.odluka?.taskId && d.dodajBiljesku) {
      try { await d.dodajBiljesku(z.odluka.taskId, `📧 Mail ${z.uid}: ${p.tko} je odlučio „ignoriraj".`) } catch { /* trag je i u Konzoli */ }
    }
    return `🗑️ Mail ${z.uid} („${z.predmet || '(bez predmeta)'}") označen kao ignoriran.`
  }

  // odgovori: <tekst> — jedini put kojim pošta odlazi pošiljatelju, i to samo na nalog.
  if (!z.odAdresa) return `⚠️ Mail ${z.uid} nema adresu pošiljatelja — odgovor nije poslan.`
  const predmet = /^re:/i.test(z.predmet) ? z.predmet : `Re: ${z.predmet || ''}`.trim()
  let ishod: { ok: boolean; greska?: string }
  try {
    ishod = await d.posaljiOdgovor({ prima: z.odAdresa, predmet, tekst: r.tekst!, ...(z.messageId ? { uOdgovorNa: z.messageId } : {}) })
  } catch (e: any) { ishod = { ok: false, greska: String(e?.message || e) } }
  if (!ishod.ok) {
    log(`📧 ⚠ mail ${z.uid}: odgovor pošiljatelju nije poslan — ${ishod.greska}`, 'greska')
    return `⚠️ Odgovor na mail ${z.uid} nije poslan: ${ishod.greska || 'nepoznat razlog'}`
  }
  promijeni(sp, x => {
    const y = x.poruke[kljuc!]
    if (!y) return
    y.odgovori = [...(y.odgovori || []), { tko: p.tko, ts, tekst: r.tekst!.slice(0, 2000) }]
    y.odluka = { ...(y.odluka?.taskId ? { taskId: y.odluka.taskId } : {}), radnja: 'odgovori', tko: p.tko, ts, tekst: r.tekst!.slice(0, 500) }
  })
  log(`📧 ⇠ odgovor na mail ${z.uid} poslan na ${z.odAdresa} (nalog: ${p.tko})`, 'ok')
  if (z.odluka?.taskId && d.dodajBiljesku) {
    try { await d.dodajBiljesku(z.odluka.taskId, `📧 Odgovor poslan na ${z.odAdresa} (${predmet}), nalog: ${p.tko}:\n${r.tekst}`) } catch { /* trag je i u Konzoli */ }
  }
  return `✉️ Odgovor poslan na ${z.odAdresa} („${predmet}").`
}

// ─── Stvarni IMAP (imapflow + mailparser, neobavezne ovisnosti) ──────────────

/** Imena privitaka iz `bodyStructure` — za poruke koje su prevelike za preuzimanje. */
function privitciIzStrukture(c: any, out: string[] = []): string[] {
  if (!c) return out
  const ime = c.dispositionParameters?.filename || c.parameters?.name
  if (ime && (c.disposition === 'attachment' || c.disposition === 'inline' || !String(c.type || '').startsWith('text/'))) out.push(String(ime))
  for (const d of c.childNodes || []) privitciIzStrukture(d, out)
  return out
}

export function imapKlijent(cfg: EmailPostavke, lozinka: string): ImapKlijent {
  return {
    async otvori() {
      let ImapFlow: any, simpleParser: any
      try {
        ImapFlow = (await import('imapflow')).ImapFlow
        simpleParser = (await import('mailparser')).simpleParser
      } catch {
        throw new Error('nedostaje IMAP knjižnica (imapflow, mailparser) — pokreni instalaciju paketa (bun install)')
      }
      const implicitni = cfg.imap.tls && cfg.imap.port === 993
      const c = new ImapFlow({
        host: cfg.imap.host, port: cfg.imap.port, secure: implicitni,
        ...(cfg.imap.tls && !implicitni ? { doSTARTTLS: true } : {}),
        auth: { user: cfg.imap.korisnik, pass: lozinka },
        logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 120_000,
      })
      c.on?.('error', () => { /* greška veze ide kroz obećanje naredbe */ })
      await c.connect()
      let mb: any
      try {
        mb = await c.mailboxOpen(cfg.imap.mapa || 'INBOX', { readOnly: true })
      } catch (e) {
        try { await c.logout() } catch { /* već prekinuto */ }
        throw e
      }
      let maxUid = Number(mb.uidNext) - 1
      if (!Number.isFinite(maxUid) || maxUid < 0) {
        const svi: number[] = (await c.search({ all: true }, { uid: true })) || []
        maxUid = svi.length ? Math.max(...svi) : 0
      }
      return {
        uidValidity: String(mb.uidValidity),
        maxUid,
        async noviOd(zadnji: number, najvise: number) {
          // Dva koraka: prvo veličina i struktura (malo), pa tijelo samo za razumne veličine.
          // Unutar `fetch` petlje imapflow ne smije slati druge naredbe — zato se skupi pa obradi.
          const zaglavlja: any[] = []
          for await (const m of c.fetch(`${zadnji + 1}:*`, { uid: true, size: true, envelope: true, bodyStructure: true }, { uid: true })) {
            if (m.uid > zadnji) zaglavlja.push(m)
          }
          zaglavlja.sort((a, b) => a.uid - b.uid)
          const out: Mail[] = []
          for (const z of zaglavlja.slice(0, najvise)) {
            const env = z.envelope || {}
            const od0 = env.from?.[0] || {}
            const odAdresa = String(od0.address || '')
            const osnova: Mail = {
              uid: z.uid,
              od: od0.name ? `${od0.name} <${odAdresa}>` : odAdresa,
              odAdresa,
              predmet: String(env.subject || ''),
              datum: env.date ? new Date(env.date).toISOString() : null,
              privitci: privitciIzStrukture(z.bodyStructure),
              tijelo: '',
              ...(env.messageId ? { messageId: String(env.messageId) } : {}),
            }
            if (Number(z.size) > NAJVISE_BAJTA_PORUKE) {
              osnova.tijelo = `(poruka je prevelika za sažetak — ${Math.round(Number(z.size) / 1048576)} MB)`
              out.push(osnova)
              continue
            }
            // `fetchOne` s `source` čita BODY.PEEK[] — poruka ostaje nepročitana.
            const puna: any = await c.fetchOne(String(z.uid), { uid: true, source: true }, { uid: true })
            if (puna?.source) {
              const p = await simpleParser(puna.source)
              osnova.tijelo = String(p.text || (p.html ? String(p.html).replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ') : '') || '')
              osnova.privitci = (p.attachments || []).map((a: any) => String(a.filename || a.contentType || 'privitak'))
              if (p.subject) osnova.predmet = String(p.subject)
              if (p.from?.text) osnova.od = String(p.from.text)
            }
            out.push(osnova)
          }
          return out
        },
        async zatvori() {
          try { await c.logout() } catch { try { c.close() } catch { /* zatvoreno */ } }
        },
      }
    },
  }
}

export function telegramObavjestac(token: string, baza: string): Obavjestac {
  return {
    async posalji(chatId, tekst) {
      try {
        const r = await fetch(`${baza}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: tekst.slice(0, 4096), disable_web_page_preview: true }),
        })
        const j: any = await r.json().catch(() => ({}))
        if (!r.ok || j?.ok === false || !j?.result?.message_id) return null
        return String(j.result.message_id)
      } catch { return null }
    },
  }
}

// ─── Petlja (u procesu ploče) ────────────────────────────────────────────────

/** Treba li petlja raditi s ovim postavkama? */
export function trebaProvjera(cfg: EmailPostavke): boolean {
  return !!(cfg.ukljucen && cfg.imap.obavijest && (cfg.smjer === 'ulaz' || cfg.smjer === 'oba') && cfg.imap.host && cfg.imap.korisnik)
}

export interface PetljaOpcije {
  /** Svjež izvor ovisnosti za svaki prolaz — postavke i tajne se mijenjaju s ploče bez restarta. */
  pripremi(): { cfg: EmailPostavke; chatId: string; imap: ImapKlijent | null; tg: Obavjestac | null; bezLozinke?: string } | null
  spremiste?: Spremiste
  konzola?: ProlazOpcije['konzola']
  log?: (r: string) => void
  configPath?: string
}

let aktivnaPetlja: { stop: () => void; ziv: () => boolean } | null = null
let zadnjiIshod: (IshodPoste & { ts: string }) | null = null

export function pokreniPostaPoller(o: PetljaOpcije): { pokrenut: boolean; razlog?: string } {
  const log = o.log || ((r: string) => console.log(r))
  if (aktivnaPetlja?.ziv()) return { pokrenut: false, razlog: 'provjera pošte već radi u ovom procesu' }
  if (!trebaProvjera(loadEmailConfig(o.configPath))) return { pokrenut: false, razlog: 'provjera pošte je isključena' }
  const sp = o.spremiste || datotecnoSpremiste()
  let radi = true
  let tajmer: ReturnType<typeof setTimeout> | null = null
  const zaustavi = () => {
    radi = false
    if (tajmer) { clearTimeout(tajmer); tajmer = null }
    if (aktivnaPetlja?.stop === zaustavi) aktivnaPetlja = null
  }
  const korak = async () => {
    if (!radi) return
    const cfg = loadEmailConfig(o.configPath)
    if (!trebaProvjera(cfg)) { log('[posta] provjera pošte isključena s ploče — zaustavljam petlju'); zaustavi(); return }
    let cekaj = Math.max(10, cfg.imap.intervalSek) * 1000
    try {
      const pr = o.pripremi()
      if (!pr || !pr.tg || !pr.chatId) {
        log('[posta] nema Telegram bota ili grupe za obavijesti — preskačem prolaz')
      } else {
        const r = await jedanProlazPoste({ cfg: pr.cfg, chatId: pr.chatId, imap: pr.imap, tg: pr.tg, spremiste: sp, konzola: o.konzola, bezLozinke: pr.bezLozinke })
        zadnjiIshod = { ...r, ts: new Date().toISOString() }
        if (r.greska) log(`[posta] ${r.greska}`)
        else if (r.poslano) log(`[posta] obavijesti u grupu: ${r.poslano}`)
        else if (r.init) log('[posta] početno stanje zapamćeno — stara pošta se ne šalje')
      }
    } catch (e) {
      log(`[posta] prolaz pao: ${String(e)}`)
      cekaj = Math.max(cekaj, 60_000)
    }
    if (!radi) return
    tajmer = setTimeout(korak, cekaj)
    if (typeof (tajmer as any)?.unref === 'function') (tajmer as any).unref()
  }
  aktivnaPetlja = { stop: zaustavi, ziv: () => radi }
  log(`[posta] provjera pošte pokrenuta (interval ${loadEmailConfig(o.configPath).imap.intervalSek} s)`)
  void korak()
  return { pokrenut: true }
}

export function zaustaviPostaPoller(): void { aktivnaPetlja?.stop() }

/** Nakon spremanja postavki e-pošte s ploče: pokreni ako treba (petlja se sama gasi kad ne treba). */
export function uskladiPostaPoller(o: PetljaOpcije): 'pokrenut' | 'vec_radi' | 'nista' {
  if (aktivnaPetlja?.ziv()) return 'vec_radi'
  return pokreniPostaPoller(o).pokrenut ? 'pokrenut' : 'nista'
}

/** Stanje za ploču (`GET /api/posta`) — bez tijela mailova. */
export function stanjePoste(sp: Spremiste = datotecnoSpremiste(), configPath?: string) {
  const s = sp.ucitaj()
  const cfg = loadEmailConfig(configPath)
  const zadnje = Object.entries(s.poruke)
    .sort((a, b) => String(b[1].poslano).localeCompare(String(a[1].poslano)))
    .slice(0, 20)
    .map(([poruka, z]) => ({ poruka, uid: z.uid, od: z.od, predmet: z.predmet, datum: z.datum, privitaka: z.privitci.length, odluka: z.odluka || null }))
  return {
    ukljucena: trebaProvjera(cfg),
    radi: !!aktivnaPetlja?.ziv(),
    uidValidity: s.uidValidity, zadnjiUid: s.zadnji, zadnjaProvjera: s.zadnjaProvjera,
    obavijesti: s.obavijesti, greska: s.greska, zadnjiIshod, zadnje,
  }
}
