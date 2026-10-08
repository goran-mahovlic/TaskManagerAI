/**
 * IzlazniPretinac — trajni izlazni pretinac za odgovore razgovora (TASK-5384, prijenos iz
 * Klaudija glavnog sustava; kanal-agnostičan: `chatId` je niz, slanje vraća boolean).
 *
 * Incident 08.10.2026. 16:48 UTC: sendMessage pao 3× zaredom („Network request
 * failed”), a log je ipak napisao „Response sent (1627 chars)” — odgovor je nestao.
 *
 * Odgovor koji se ne uspije poslati odmah ide u datoteku (jedna stavka = jedan
 * JSON u `dir`), pa ga petlja ponavlja s rastućim razmakom (10 s, 30 s, 2 min,
 * 10 min, dalje svakih 10 min) dok ne uspije ili prođe ROK_MS (1 h). Tada stavka
 * ide u `odustano/` i u chat ide JEDNA kratka dojava. Datoteka preživi restart.
 * Trajna greška (400/403 — npr. predugačka poruka, bot izbačen) se ne ponavlja.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export const RASPORED_MS = [10_000, 30_000, 120_000, 600_000]
export const ROK_MS = 3_600_000

export interface Stavka {
  id: string
  chatId: string
  tekst: string
  oznaka?: string
  nastala: number
  pokusaji: number
  sljedeciPokusaj: number
  zadnjaGreska?: string
}

/** `false` = kanal nije poslao (Kanal.posaljiTekst); bacanje = isto. */
export type Posalji = (chatId: string, tekst: string) => Promise<boolean | unknown>

/** Poruka koja je SAMO oznaka privitka iz pollera (slika/dokument bez opisa). */
export function jeSamoPrivitak(tekst: string): boolean {
  return /^\[PRIVITAK(?: nije spremljen)?:[^\]\n]*\]$/u.test(tekst.trim())
}

/** Mreža, 429 i 5xx su prolazni; ostali Telegramovi 4xx (400, 403…) su trajni. */
export function jeTrajnaGreska(err: any): boolean {
  const kod = Number(err?.error_code)
  if (!Number.isFinite(kod) || kod === 0) return false
  if (kod === 429 || kod >= 500) return false
  return kod >= 400
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' })
}

export class IzlazniPretinac {
  private dir: string
  private sad: () => number
  private uTijeku = new Set<string>()

  constructor(opt: { dir: string; sad?: () => number }) {
    this.dir = opt.dir
    this.sad = opt.sad || Date.now
    mkdirSync(this.dir, { recursive: true })
  }

  private put(id: string): string { return join(this.dir, `${id}.json`) }

  private zapisi(s: Stavka): void {
    const p = this.put(s.id)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
    renameSync(tmp, p) // atomično: čitatelj nikad ne vidi pola JSON-a
  }

  /** Preda neposlan odgovor pretincu. Vraća ID stavke. */
  predaj(u: { chatId: string; tekst: string; oznaka?: string; greska?: string }): string {
    const t = this.sad()
    const id = `${t}-${Math.random().toString(36).slice(2, 8)}`
    this.zapisi({
      id, chatId: u.chatId, tekst: u.tekst, oznaka: u.oznaka, nastala: t,
      pokusaji: 0, sljedeciPokusaj: t + RASPORED_MS[0], zadnjaGreska: u.greska,
    })
    return id
  }

  private stavke(): Stavka[] {
    let imena: string[] = []
    try { imena = readdirSync(this.dir).filter(f => f.endsWith('.json')) } catch { return [] }
    const out: Stavka[] = []
    for (const f of imena) {
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), 'utf8'))
        if (s && typeof s.id === 'string' && typeof s.tekst === 'string' && typeof s.chatId === 'string') out.push(s)
      } catch { /* pokvarena datoteka se preskače, ne ruši petlju */ }
    }
    return out.sort((a, b) => a.nastala - b.nastala)
  }

  naCekanju(): number { return this.stavke().length }

  private odustani(s: Stavka): void {
    const odDir = join(this.dir, 'odustano')
    mkdirSync(odDir, { recursive: true })
    try { renameSync(this.put(s.id), join(odDir, `${s.id}.json`)) } catch { try { unlinkSync(this.put(s.id)) } catch {} }
  }

  /**
   * Jedan prolaz: šalje dospjele stavke. `dojavi` se zove točno jednom po stavci
   * kojoj je istekao rok ili koja je trajno odbijena.
   */
  async obradi(
    posalji: Posalji,
    dojavi: Posalji,
    log: (p: string) => void = () => {},
  ): Promise<{ poslano: number; odustano: number; ceka: number }> {
    let poslano = 0, odustano = 0, ceka = 0
    for (const s of this.stavke()) {
      if (this.uTijeku.has(s.id)) { ceka++; continue }
      const t = this.sad()
      if (s.sljedeciPokusaj > t) { ceka++; continue }
      this.uTijeku.add(s.id)
      try {
        try {
          if ((await posalji(s.chatId, s.tekst)) === false) throw new Error('kanal nije poslao poruku')
          try { unlinkSync(this.put(s.id)) } catch {}
          poslano++
          log(`[PRETINAC] ${s.id} isporučen u pokušaju ${s.pokusaji + 1} (${s.tekst.length} zn., kasni ${Math.round((this.sad() - s.nastala) / 1000)} s)`)
          continue
        } catch (err: any) {
          s.pokusaji++
          s.zadnjaGreska = String(err?.message || err).slice(0, 300)
          const sada = this.sad()
          const trajna = jeTrajnaGreska(err)
          if (trajna || sada - s.nastala >= ROK_MS) {
            this.odustani(s)
            odustano++
            const zasto = trajna ? `kanal ga odbija (${s.zadnjaGreska.slice(0, 80)})` : `${s.pokusaji} pokušaja kroz 1 h`
            log(`[PRETINAC] ${s.id} ODUSTAJEM — ${zasto}; sačuvan u odustano/`)
            try {
              await dojavi(s.chatId,
                `⚠️ Odgovor od ${hhmm(s.nastala)} (${s.tekst.length} zn.) nije isporučen — ${zasto}. ` +
                `Sačuvan je u izlaznom pretincu (${s.id}); ponovi pitanje ako ti treba.`)
            } catch (e: any) {
              log(`[PRETINAC] ${s.id} ni dojava nije prošla: ${e?.message || e}`)
            }
          } else {
            const razmak = RASPORED_MS[Math.min(s.pokusaji, RASPORED_MS.length - 1)]
            s.sljedeciPokusaj = sada + razmak
            this.zapisi(s)
            ceka++
            log(`[PRETINAC] ${s.id} pokušaj ${s.pokusaji} pao (${s.zadnjaGreska}); sljedeći za ${razmak / 1000} s`)
          }
        }
      } finally {
        this.uTijeku.delete(s.id)
      }
    }
    return { poslano, odustano, ceka }
  }
}
