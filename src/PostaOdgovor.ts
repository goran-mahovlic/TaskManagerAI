/**
 * PostaOdgovor — odgovor na DOLAZNI mail preko ploče, na nalog čovjeka (TASK-5509).
 *
 *   čovjek (dopušten) u chatu → potez razgovora na razini `puno` → ploča izda NALOG POTEZA
 *        (jednokratan, vezan uz chat i pošiljatelja, s rokom; model ga vidi kao $TM_NALOG_POTEZA)
 *   model → POST /api/email/posalji {odgovorNa, tekst, privitci} + zaglavlje X-Regoc-Nalog
 *   ploča → primatelj iz STVARNO primljene poruke (Reply-To, inače From), vlasnik u CC iz
 *           postavke, Re: predmet, In-Reply-To/References, privitci iz dopuštenih mapa → SMTP
 *
 * ZAŠTO NALOG: SMTP lozinku drži samo ploča (razina `puno` namjerno ne čita tajne), a slanje
 * pošte van je radnja koju vlasnik odobrava („mail samo kad ja tražim ili odobrim"). Bot-potez,
 * autonomija i agenti naloga nemaju — razgovor ga izdaje samo za potez u kojem su SVI pošiljatelji
 * dopušteni ljudi i razina je `puno`, a opoziva ga čim potez završi.
 *
 * ŠTO OVO NIJE: otvoreni relej. Adresa primatelja i CC se iz zahtjeva NE čitaju.
 *
 * PROBA (`X-Regoc-Proba` na dolaznom mailu): vanjskoj adresi ništa ne odlazi — vraća se priprema
 * (kome, CC, nit, privitci), da se cijeli put provjeri bez stvarnog maila. Proba čiji je pošiljatelj
 * interna adresa (vlasnik, popis primatelja, sam sandučić) šalje se stvarno — to je E2E bez stranaca.
 *
 * Autorica: Jelena (Engineer), TASK-5509.
 */

import { randomBytes } from 'crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'fs'
import { basename, sep } from 'path'
import { provjeriDokument } from './razgovor/SendDoc'
import { promijeni, type Spremiste, type ZapisMaila } from './PostaUlaz'

// ─── Nalog poteza ────────────────────────────────────────────────────────────

export interface Nalog {
  kanal: string
  chatId: string
  posiljateljId: string
  posiljateljIme: string
  /** Radna mapa chata — privitci smiju i odavde. */
  radniDir: string
}

interface StavkaNaloga { nalog: Nalog; istjece: number; zauzet: boolean }

/** Najviše živih naloga (svaki potez na `puno` izda jedan, a opoziva ga na kraju). */
const NAJVISE_NALOGA = 200

/**
 * Jednokratni nalozi u memoriji procesa ploče (razgovor i ploča su isti proces). Restart ploče
 * briše sve naloge — to je ispravno: potez koji ih je dobio prekinut je istim restartom.
 */
export class NaloziPoteza {
  private mapa = new Map<string, StavkaNaloga>()
  constructor(private sat: () => number = () => Date.now()) {}

  izdaj(o: Nalog & { rokMs: number }): string {
    this.pocisti()
    if (this.mapa.size >= NAJVISE_NALOGA) {
      const najstariji = [...this.mapa.entries()].sort((a, b) => a[1].istjece - b[1].istjece)[0]
      if (najstariji) this.mapa.delete(najstariji[0])
    }
    const token = randomBytes(24).toString('base64url')
    const { rokMs, ...nalog } = o
    this.mapa.set(token, { nalog, istjece: this.sat() + Math.max(1000, rokMs), zauzet: false })
    return token
  }

  /** Zauzmi nalog za jedno slanje; uspjeh ga troši (`potrosi`), neuspjeh vraća (`vrati`). */
  uzmi(token: string | null | undefined): { ok: true; nalog: Nalog } | { ok: false; razlog: string } {
    const t = String(token || '').trim()
    if (!t) return { ok: false, razlog: 'nema naloga čovjeka (token poteza) — slanje pošte van smije samo potez koji je pokrenuo dopušteni korisnik; bot-poruka, autonomija i agent ga nemaju' }
    const s = this.mapa.get(t)
    if (!s) return { ok: false, razlog: 'nalog poteza ne postoji ili je već iskorišten (jedan nalog = jedno slanje)' }
    if (this.sat() > s.istjece) { this.mapa.delete(t); return { ok: false, razlog: 'nalog poteza je istekao — neka vlasnik ponovi nalog u chatu' } }
    if (s.zauzet) return { ok: false, razlog: 'nalog poteza je upravo u uporabi (slanje u tijeku)' }
    s.zauzet = true
    return { ok: true, nalog: s.nalog }
  }

  potrosi(token: string): void { this.mapa.delete(token) }
  vrati(token: string): void { const s = this.mapa.get(token); if (s) s.zauzet = false }
  /** Kraj poteza: nalog više ne vrijedi, iskorišten ili ne. */
  opozovi(token: string | null | undefined): void { if (token) this.mapa.delete(token) }
  zivih(): number { this.pocisti(); return this.mapa.size }

  private pocisti(): void {
    const t = this.sat()
    for (const [k, s] of this.mapa) if (t > s.istjece) this.mapa.delete(k)
  }
}

/** Jedan skup naloga po procesu ploče — razgovor izdaje, ruta `/api/email/posalji` troši. */
export const naloziPoteza = new NaloziPoteza()

/** Ime varijable okoline poteza i zaglavlja zahtjeva. */
export const NALOG_ENV = 'TM_NALOG_POTEZA'
export const NALOG_ZAGLAVLJE = 'x-regoc-nalog'

// ─── Odgovor na mail ─────────────────────────────────────────────────────────

export const NAJVISE_PRIVITAKA = 10
/** Ukupni strop privitaka (SMTP poslužitelji obično primaju ~25 MB, a base64 dodaje trećinu). */
export const NAJVISE_BAJTA_PRIVITAKA = 15 * 1024 * 1024
export const NAJVISE_TEKSTA = 20_000

const RE_EPOSTA = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RE_MSGID = /^<[^<>\s]{1,250}>$/

export interface SlanjeOdgovora {
  prima: string
  cc: string[]
  predmet: string
  tekst: string
  uOdgovorNa?: string
  references?: string
  /**
   * Sadržaj je pročitan PRI PROVJERI (O_NOFOLLOW + isti dev/ino) — SMTP sloj više ne razrješava
   * putanju, pa zamjena datoteke ili mape između provjere i slanja ne mijenja što odlazi.
   */
  privitci: { putanja: string; ime: string; sadrzaj: Buffer }[]
}

export interface IshodSlanja { ok: boolean; greska?: string; detalj?: Record<string, unknown> }

export interface OvisnostiOdgovora {
  nalozi: NaloziPoteza
  spremiste: Spremiste
  /** Vlasnik čvora (CC) iz postavke; `null` = nije postavljen → nema slanja. */
  vlasnik: () => string | null
  /** Interne adrese (vlasnik, popis primatelja, sandučić) — samo njima proba stvarno ide. */
  interneAdrese: () => string[]
  /** Mape iz kojih smiju privitci: radna mapa chata iz naloga, privitci tog chata, privitci tog maila. */
  dopusteneMape: (n: Nalog, mail: ZapisMaila) => string[]
  home: string
  posalji: (x: SlanjeOdgovora) => Promise<IshodSlanja>
  maxBajta?: number
  konzola?: (redak: string, razina: 'info' | 'ok' | 'greska') => void
  /** Bilješka na zadatak otvoren iz tog maila (ako postoji). */
  dodajBiljesku?: (taskId: string, tekst: string) => Promise<void>
}

export interface ZahtjevOdgovora {
  odgovorNa: unknown
  tekst: unknown
  privitci?: unknown
  nalog: string | null
}

export interface OdgovorApi { status: number; tijelo: Record<string, unknown> }

const odbij = (status: number, greska: string): OdgovorApi => ({ status, tijelo: { ok: false, greska } })
const bezRetka = (t: string) => t.replace(/[\r\n]+/g, ' ')

/** `uid:N`, `kljuc:K`, golo `N` (UID, ili ključ obavijesti ako takvog UID-a nema). */
function nadjiMail(poruke: Record<string, ZapisMaila>, odgovorNa: unknown, chatId: string): { kljuc: string } | { greska: string; status: number } {
  const s = String(odgovorNa ?? '').trim()
  if (!s) return { status: 400, greska: 'odgovorNa je obavezan (IMAP UID iz „[mail N]" ili ključ iz posta.json)' }
  const poUid = (uid: number) => {
    const k = Object.keys(poruke).filter(x => poruke[x]!.uid === uid)
    // Isti UID u više zapisa (nova UIDVALIDITY, drugi chat): prvo chat naloga, pa najnoviji.
    k.sort((a, b) => Number(poruke[b]!.chatId === chatId) - Number(poruke[a]!.chatId === chatId)
      || String(poruke[b]!.poslano).localeCompare(String(poruke[a]!.poslano)))
    return k[0] || null
  }
  const m = /^(uid|kljuc|ključ):\s*(\S+)$/i.exec(s)
  if (m) {
    const k = m[1]!.toLowerCase() === 'uid' ? (/^\d+$/.test(m[2]!) ? poUid(Number(m[2])) : null) : (poruke[m[2]!] ? m[2]! : null)
    return k ? { kljuc: k } : { status: 404, greska: `mail „${s.slice(0, 40)}" nije u evidenciji pošte (posta.json)` }
  }
  const kUid = /^\d+$/.test(s) ? poUid(Number(s)) : null
  const kKljuc = poruke[s] ? s : null
  if (kUid && kKljuc && kUid !== kKljuc) return { status: 409, greska: `„${s}" je i UID i ključ obavijesti — napiši uid:${s} ili kljuc:${s}` }
  const k = kUid || kKljuc
  return k ? { kljuc: k } : { status: 404, greska: `mail „${s.slice(0, 40)}" nije u evidenciji pošte (posta.json)` }
}

const unutar = (put: string, mape: string[]) => mape.some(m => put === m || put.startsWith(m.endsWith(sep) ? m : m + sep))

/**
 * Pročitaj provjerenu datoteku bez ponovnog razrješavanja: O_NOFOLLOW na realpath, isti dev/ino
 * kao pri provjeri, obična datoteka, i stvarna putanja nakon otvaranja (isti inode kao opisnik)
 * i dalje u dopuštenoj mapi — zamjena međumape simboličkom poveznicom nakon provjere tako pada.
 */
export function procitajProvjereno(put: string, mape: string[], max: number): { ok: true; sadrzaj: Buffer } | { ok: false; razlog: string } {
  let fd = -1
  try {
    const prije = statSync(put)
    fd = openSync(put, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile() || st.dev !== prije.dev || st.ino !== prije.ino) return { ok: false, razlog: 'datoteka se promijenila tijekom provjere' }
    if (st.size > max) return { ok: false, razlog: `prevelika datoteka (${st.size} B > ${max} B)` }
    // Stvarna putanja NAKON otvaranja, prenosivo (Linux i macOS, bez procfs-a): realpath mora biti u
    // dopuštenoj mapi i voditi na ISTI inode kao otvoreni opisnik. Zamjena međumape poveznicom
    // prije otvaranja daje realpath izvan mape; vraćanje poveznice poslije daje drugi inode.
    let stvarna: string
    try { stvarna = realpathSync(put) } catch { return { ok: false, razlog: 'datoteka se promijenila tijekom provjere' } }
    const sad = statSync(stvarna)
    if (sad.dev !== st.dev || sad.ino !== st.ino) return { ok: false, razlog: 'datoteka se promijenila tijekom provjere' }
    const realMape = mape.flatMap(m => { try { return [realpathSync(m)] } catch { return [] } })
    if (!unutar(stvarna, realMape)) return { ok: false, razlog: 'izvan dopuštene mape' }
    const buf = Buffer.alloc(st.size)
    let procitano = 0
    while (procitano < st.size) {
      const n = readSync(fd, buf, procitano, st.size - procitano, procitano)
      if (n <= 0) break
      procitano += n
    }
    return { ok: true, sadrzaj: buf.subarray(0, procitano) }
  } catch (e: any) {
    return { ok: false, razlog: e?.code === 'ELOOP' ? 'simbolička poveznica nije dopuštena' : 'datoteka nije čitljiva' }
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch { /* zatvoreno */ }
  }
}

function provjeriPrivitke(
  ulaz: unknown, d: OvisnostiOdgovora, n: Nalog, mail: ZapisMaila,
): { ok: true; privitci: SlanjeOdgovora['privitci'] } | { ok: false; greska: string } {
  if (ulaz === undefined || ulaz === null) return { ok: true, privitci: [] }
  const lista = Array.isArray(ulaz) ? ulaz : [ulaz]
  if (lista.length > NAJVISE_PRIVITAKA) return { ok: false, greska: `najviše ${NAJVISE_PRIVITAKA} privitaka` }
  const max = d.maxBajta ?? NAJVISE_BAJTA_PRIVITAKA
  const mape = d.dopusteneMape(n, mail).filter(Boolean)
  const out: SlanjeOdgovora['privitci'] = []
  let ukupno = 0
  for (const x of lista) {
    const put = typeof x === 'string' ? x.trim() : ''
    if (!put) return { ok: false, greska: 'privitak mora biti apsolutna putanja (tekst)' }
    if (put.includes('\0') || put.split(/[\\/]+/).includes('..')) return { ok: false, greska: `privitak ${put.slice(0, 200)}: putanja s „.." nije dopuštena` }
    const pr = provjeriDokument(put, { dopusteneMape: mape, maxBajta: max, home: d.home })
    if (!pr.ok) return { ok: false, greska: `privitak ${put.slice(0, 200)}: ${pr.razlog} (dopuštene mape: ${mape.join(', ')})` }
    const rd = procitajProvjereno(pr.putanja, mape, max)
    if (!rd.ok) return { ok: false, greska: `privitak ${put.slice(0, 200)}: ${rd.razlog}` }
    ukupno += rd.sadrzaj.length
    if (ukupno > max) return { ok: false, greska: `privitci su zajedno preveliki (${ukupno} B > ${max} B)` }
    out.push({ putanja: pr.putanja, ime: basename(pr.putanja), sadrzaj: rd.sadrzaj })
  }
  return { ok: true, privitci: out }
}

/**
 * `POST /api/email/posalji` s `odgovorNa`. Čista funkcija nad ubrizganim ovisnostima — ruta ploče
 * samo prenosi tijelo i zaglavlje naloga.
 */
export async function odgovoriNaMail(z: ZahtjevOdgovora, d: OvisnostiOdgovora): Promise<OdgovorApi> {
  const log = d.konzola || (() => { /* bez konzole */ })
  const u = d.nalozi.uzmi(z.nalog)
  if (!u.ok) {
    log(`📧 ⛔ odgovor na mail odbijen — ${u.razlog}`, 'greska')
    return odbij(403, u.razlog)
  }
  const n = u.nalog
  const token = String(z.nalog)
  let potroseno = false
  try {
    const tekst = typeof z.tekst === 'string' ? z.tekst : ''
    if (!tekst.trim()) return odbij(400, 'tekst je obavezan')
    if (tekst.length > NAJVISE_TEKSTA) return odbij(400, `tekst je predug (najviše ${NAJVISE_TEKSTA} znakova)`)

    const s = d.spremiste.ucitaj()
    const nm = nadjiMail(s.poruke, z.odgovorNa, n.chatId)
    if ('greska' in nm) return odbij(nm.status, nm.greska)
    const kljuc = nm.kljuc
    const mail = s.poruke[kljuc]!
    // Nalog je vezan uz chat: odgovara se samo na mail čija je obavijest stigla u TAJ chat.
    if (String(mail.chatId) !== String(n.chatId)) {
      return odbij(403, `mail ${mail.uid} je obaviješten u drugom chatu — nalog za odgovor daje se u chatu u kojem je stigla obavijest o tom mailu`)
    }

    // Primatelj SAMO iz primljene poruke — model ne bira adresu.
    const prima = String(mail.replyTo || mail.odAdresa || '').trim()
    if (!RE_EPOSTA.test(prima) || /[\r\n]/.test(prima)) return odbij(409, `mail ${mail.uid} nema ispravnu adresu pošiljatelja — odgovor nije moguć`)
    const vlasnik = String(d.vlasnik() || '').trim()
    if (!RE_EPOSTA.test(vlasnik) || /[\r\n]/.test(vlasnik)) {
      return odbij(409, 'vlasnik za CC nije postavljen (kartica E-pošta → vlasnik) — bez vlasnika u CC-u odgovor ne ide; postavlja ga vlasnik, ne model')
    }
    const cc = prima.toLowerCase() === vlasnik.toLowerCase() ? [] : [vlasnik]

    const pr = provjeriPrivitke(z.privitci, d, n, mail)
    if (!pr.ok) return odbij(400, pr.greska)

    const izvorni = bezRetka(mail.predmet || '').trim()
    const predmet = (/^re\s*:/i.test(izvorni) ? izvorni : `Re: ${izvorni}`.trim()).slice(0, 300)
    const msgId = mail.messageId && RE_MSGID.test(mail.messageId) ? mail.messageId : undefined
    const lanac = String(mail.references || '').split(/\s+/).filter(x => RE_MSGID.test(x))
    const references = msgId ? [...lanac.filter(x => x !== msgId), msgId].slice(-20).join(' ') : (lanac.length ? lanac.join(' ') : undefined)
    const slanje: SlanjeOdgovora = {
      prima, cc, predmet, tekst,
      ...(msgId ? { uOdgovorNa: msgId } : {}), ...(references ? { references } : {}),
      privitci: pr.privitci,
    }
    const priprema = { prima, cc, predmet, inReplyTo: msgId || null, references: references || null, privitci: pr.privitci.map(p => p.ime) }
    const tko = `${n.posiljateljIme || '?'} (uid:${n.posiljateljId})`
    const ts = new Date().toISOString()
    const opis = `na ${prima}${cc.length ? `, CC ${cc.join(', ')}` : ''}${pr.privitci.length ? `, privitci: ${priprema.privitci.join(', ')}` : ''}`

    const interne = new Set(d.interneAdrese().map(a => a.toLowerCase()).concat(vlasnik.toLowerCase()))
    if (mail.proba && !interne.has(prima.toLowerCase())) {
      d.nalozi.potrosi(token); potroseno = true
      promijeni(d.spremiste, x => {
        const y = x.poruke[kljuc]
        if (y) y.odgovori = [...(y.odgovori || []), { tko, ts, tekst: tekst.slice(0, 2000), prima, cc, privitci: priprema.privitci, izvor: 'razgovor', proba: true }]
      })
      log(`📧 🧪 mail ${mail.uid} je proba — odgovor ${opis} pripremljen, NIJE poslan (vanjska adresa; nalog: ${tko})`, 'info')
      return { status: 200, tijelo: { ok: true, proba: true, poslano: null, priprema, napomena: 'proba (X-Regoc-Proba): vanjskoj adresi se ne šalje' } }
    }

    let ishod: IshodSlanja
    try { ishod = await d.posalji(slanje) } catch (e: any) { ishod = { ok: false, greska: String(e?.message || e) } }
    if (!ishod.ok) {
      log(`📧 ⚠ odgovor na mail ${mail.uid} ${opis} NIJE poslan — ${ishod.greska} (nalog: ${tko})`, 'greska')
      return odbij(502, `slanje nije uspjelo: ${String(ishod.greska || 'nepoznat razlog').slice(0, 300)}`)
    }
    d.nalozi.potrosi(token); potroseno = true
    const messageId = String(ishod.detalj?.messageId || '') || undefined
    promijeni(d.spremiste, x => {
      const y = x.poruke[kljuc]
      if (!y) return
      y.odgovori = [...(y.odgovori || []), {
        tko, ts, tekst: tekst.slice(0, 2000), prima, cc, privitci: priprema.privitci,
        ...(messageId ? { messageId } : {}), izvor: 'razgovor', ...(mail.proba ? { proba: true } : {}),
      }]
      y.odluka = { ...(y.odluka?.taskId ? { taskId: y.odluka.taskId } : {}), radnja: 'odgovori', tko, ts, tekst: tekst.slice(0, 500) }
    })
    log(`📧 ⇠ odgovor na mail ${mail.uid} („${izvorni}") poslan ${opis}${messageId ? ` · ${messageId}` : ''} (nalog: ${tko}, chat ${n.kanal}:${n.chatId})`, 'ok')
    if (mail.odluka?.taskId && d.dodajBiljesku) {
      try { await d.dodajBiljesku(mail.odluka.taskId, `📧 Odgovor poslan ${opis} (${predmet})${messageId ? `, ${messageId}` : ''}, nalog: ${tko}`) } catch { /* trag je i u Konzoli */ }
    }
    return { status: 200, tijelo: { ok: true, poslano: { ...priprema, messageId: messageId || null } } }
  } finally {
    if (!potroseno) d.nalozi.vrati(token)
  }
}
