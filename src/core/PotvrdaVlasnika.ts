/**
 * PotvrdaVlasnika — jednokratni kod za upis/brisanje tajne s ploče (ADR-0007 §4.2).
 *
 * Agent čvora čita sve datoteke korisnika i zove loopback, pa nijedna tajna na disku ne
 * razlikuje vlasnika od agenta. Vlasnikov PRIVATNI Telegram je jedini kanal koji agent ne
 * čita: kod od 8 znamenki ide samo na `tajne.potvrdaUid`, nikad u grupu.
 *
 * Čista logika: sat i pošiljatelj su umetnuti, pa se testira bez mreže. Pamti se samo
 * SHA-256 koda vezan uz zahtjev, ime i radnju — sam kod ne postoji nigdje osim u poruci.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'

export type RadnjaTajne = 'upis' | 'brisanje'

const VIJEK_MS = 5 * 60_000
const POKUSAJA = 5
const PROZOR_MS = 15 * 60_000
const PRAG_PROZORA = 10

interface Zahtjev { sazetak: Buffer; ime: string; radnja: RadnjaTajne; istjece: number; pokusaja: number }

export interface OpcijePotvrde {
  sat?: () => number
  /** Brojčani Telegram uid-ovi vlasnika (nisu tajna). Prazno = upis s ploče isključen. */
  primatelji: () => string[]
  /**
   * Šalje u privatni chat; vraća je li poslano. Može vratiti i `{ ok, opis }` — opis je razlog
   * iz Telegrama (npr. 403 „bot can't initiate conversation"), da ploča i audit kažu ZAŠTO.
   */
  posalji: (uid: string, tekst: string) => Promise<boolean | { ok: boolean; opis?: string }>
  cvor: string
}

export type IshodZahtjeva =
  | { ok: true; zahtjevId: string; istjece: string; poslanoNa: number }
  | { ok: false; greska: 'potvrda_nije_podesena' | 'zakljucano' }
  | { ok: false; greska: 'slanje_nije_uspjelo'; opis?: string }

export type IshodProvjere = { ok: true } | { ok: false; greska: 'kod_pogresan' | 'zahtjev_nevazeci' | 'zakljucano' }

const sazmi = (zahtjevId: string, ime: string, radnja: string, kod: string): Buffer =>
  createHash('sha256').update(`${zahtjevId}\n${ime}\n${radnja}\n${kod}`).digest()

export class PotvrdaVlasnika {
  private zahtjevi = new Map<string, Zahtjev>()
  private pogreske: number[] = []
  private zakljucanoDo = 0
  private sat: () => number

  constructor(private o: OpcijePotvrde) { this.sat = o.sat || Date.now }

  /** Je li ploča u 15-minutnoj blokadi nakon 10 pogrešnih kodova. */
  zakljucano(): boolean { return this.sat() < this.zakljucanoDo }

  private pocisti(): void {
    const sad = this.sat()
    for (const [id, z] of this.zahtjevi) if (z.istjece <= sad) this.zahtjevi.delete(id)
    this.pogreske = this.pogreske.filter(t => sad - t < PROZOR_MS)
  }

  async zatrazi(ime: string, radnja: RadnjaTajne): Promise<IshodZahtjeva> {
    this.pocisti()
    if (this.zakljucano()) return { ok: false, greska: 'zakljucano' }
    const uidovi = [...new Set(this.o.primatelji().map(u => String(u).trim()).filter(u => /^\d{1,20}$/.test(u)))]
    if (!uidovi.length) return { ok: false, greska: 'potvrda_nije_podesena' }
    const kod = String(randomInt(0, 100_000_000)).padStart(8, '0')
    const zahtjevId = randomBytes(16).toString('hex')
    const istjece = this.sat() + VIJEK_MS
    const tekst = `Kod za ${radnja === 'upis' ? 'upis' : 'brisanje'} tajne ${ime} na ${this.o.cvor}: ${kod} (5 min). Ako to nisi ti, ne upisuj ga.`
    let poslano = 0
    let opis: string | undefined
    for (const uid of uidovi) {
      try {
        const r = await this.o.posalji(uid, tekst)
        const ok = typeof r === 'boolean' ? r : !!r?.ok
        if (ok) poslano++
        else if (typeof r === 'object' && r?.opis) opis = r.opis
      } catch { /* sljedeći */ }
    }
    if (!poslano) return opis ? { ok: false, greska: 'slanje_nije_uspjelo', opis } : { ok: false, greska: 'slanje_nije_uspjelo' }
    this.zahtjevi.set(zahtjevId, { sazetak: sazmi(zahtjevId, ime, radnja, kod), ime, radnja, istjece, pokusaja: 0 })
    return { ok: true, zahtjevId, istjece: new Date(istjece).toISOString(), poslanoNa: poslano }
  }

  provjeri(zahtjevId: unknown, kod: unknown, ime: string, radnja: RadnjaTajne): IshodProvjere {
    this.pocisti()
    if (this.zakljucano()) return { ok: false, greska: 'zakljucano' }
    const z = typeof zahtjevId === 'string' ? this.zahtjevi.get(zahtjevId) : undefined
    if (!z) return { ok: false, greska: 'zahtjev_nevazeci' }
    const tocno = typeof kod === 'string' && z.ime === ime && z.radnja === radnja &&
      timingSafeEqual(sazmi(zahtjevId as string, ime, radnja, kod.trim()), z.sazetak)
    if (tocno) { this.zahtjevi.delete(zahtjevId as string); return { ok: true } }
    z.pokusaja++
    this.pogreske.push(this.sat())
    if (z.pokusaja >= POKUSAJA) this.zahtjevi.delete(zahtjevId as string)
    if (this.pogreske.length >= PRAG_PROZORA) { this.zakljucanoDo = this.sat() + PROZOR_MS; this.zahtjevi.clear() }
    return { ok: false, greska: 'kod_pogresan' }
  }
}
