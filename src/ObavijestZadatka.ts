/**
 * ObavijestZadatka — tko smije dobiti obavijest o promjeni statusa zadatka (TASK-5378).
 *
 * KVAR KOJI OVO ZATVARA (node-A, 08.10.2026.): TASK-5371 je uz Telegram obavijest slao mail
 * na SVAKI PUT zadatka čim je e-pošta bila uključena i imala primatelja — in_progress,
 * blocked, completed, i to za QA probe (TASK-340…344, oznaka `qa`, autor QA agent). Vlasnik
 * je dobio poplavu mailova u privatni sandučić. Sada vrijede četiri brane, redom:
 *   1. `obavijestZadatak.ukljucena` — zasebna postavka, zadano ISKLJUČENA;
 *   2. samo PRIJELAZ u odabrani status (in_progress/pending se ne mogu ni odabrati);
 *   3. probni zadatak (`jeProbniZadatak`) nikad ne šalje — ni mail ni Telegram;
 *   4. strop `najviseNaSat` po primatelju; višak ide u JEDAN sažetak kad se prozor otvori.
 *
 * Primatelji su isključivo `primatelji` s kartice E-pošta (v. `posaljiEmail`) — ovaj put
 * nikad ne šalje na adresu koju nije upisao vlasnik.
 *
 * Autorica: Jelena (Engineer), TASK-5378.
 */

import { STATUSI_OBAVIJESTI, loadEmailConfig, posaljiEmail, type Ishod } from './EmailConfig'

// ─── Proba ───────────────────────────────────────────────────────────────────

/** Oznake po kojima je zadatak proba (točno ime ili prefiks `<ime>-`, npr. `qa-5312`). */
export const PROBNE_OZNAKE = ['qa', 'proba', 'fixture'] as const
/** Autori čiji su zadaci probe — QA agent paketa (`#qa` → potjeh u ModeClassifier). */
export const PROBNI_AUTORI = ['qa', 'potjeh'] as const

function oznake(tags: unknown): string[] {
  let t = tags
  if (typeof t === 'string') { try { t = JSON.parse(t) } catch { t = t.split(',') } }
  return Array.isArray(t) ? t.map(x => String(x).trim().toLowerCase()).filter(Boolean) : []
}

/**
 * Je li zadatak proba? `biljeg` je vrijednost zaglavlja `x-regoc-proba` zahtjeva koji je
 * promijenio status — isti biljeg kojim QA već traži „provjeru, ne posao" (POST /api/tasks).
 */
export function jeProbniZadatak(
  t: { tags?: unknown; createdBy?: unknown }, o: { biljeg?: string | null } = {},
): boolean {
  if (o.biljeg === '1') return true
  const autor = String(t.createdBy ?? '').trim().toLowerCase()
  if ((PROBNI_AUTORI as readonly string[]).includes(autor)) return true
  return oznake(t.tags).some(x => (PROBNE_OZNAKE as readonly string[]).some(p => x === p || x.startsWith(`${p}-`)))
}

// ─── E-pošta ─────────────────────────────────────────────────────────────────

const SAT_MS = 3600_000
/** Nikad mail, ma što pisalo u datoteci — korak rada nije ishod. */
const NIKAD = new Set(['in_progress', 'pending'])
const IKONA: Record<string, string> = { completed: '✅', failed: '❌', blocked: '⛔', cancelled: '🚫' }

export interface ZadatakZaObavijest {
  id: string
  title?: string
  status: string
  tags?: unknown
  createdBy?: unknown
}

export interface IshodObavijesti {
  poslano: string[]
  uSazetak: string[]
  /** Zašto nije poslano ništa (isključeno, nije prijelaz, proba…). */
  razlog?: string
}

export interface ObavjestavacOpcije {
  /** Putanja email.json (testovi); zadano = putanja paketa. */
  putanja?: string
  sada?: () => number
  posalji?: (naslov: string, tekst: string, prima: string[]) => Promise<Ishod>
  /** Odgođeno pražnjenje sažetaka; zadano `setTimeout` koji ne drži proces živim. */
  zakazi?: (fn: () => void, ms: number) => void
}

/**
 * Jedan po procesu ploče: pamti tko je koliko mailova dobio u zadnjih sat vremena i što
 * čeka sažetak. Stanje je u memoriji — restart ploče prazni strop, što je prihvatljivo
 * (restart nije čest, a najgori ishod je još najviše N mailova).
 */
export class Obavjestavac {
  private poslanoU = new Map<string, number[]>()
  private naCekanju = new Map<string, string[]>()
  private zakazano = false
  private o: Required<Omit<ObavjestavacOpcije, 'putanja'>> & { putanja?: string }

  constructor(o: ObavjestavacOpcije = {}) {
    this.o = {
      putanja: o.putanja,
      sada: o.sada ?? (() => Date.now()),
      posalji: o.posalji ?? ((n, t, p) => posaljiEmail(n, t, o.putanja, p)),
      zakazi: o.zakazi ?? ((fn, ms) => { const h = setTimeout(fn, ms); (h as any)?.unref?.() }),
    }
  }

  private cfg() { return loadEmailConfig(this.o.putanja) }

  /** Vremena slanja unutar zadnjeg sata (starija se brišu). */
  private prozor(prima: string): number[] {
    const granica = this.o.sada() - SAT_MS
    const t = (this.poslanoU.get(prima) || []).filter(x => x > granica)
    this.poslanoU.set(prima, t)
    return t
  }

  /** Neuspjelo slanje ne troši mjesto u stropu. */
  private otpusti(prima: string, ts: number) {
    const t = this.poslanoU.get(prima) || []
    const i = t.indexOf(ts)
    if (i >= 0) t.splice(i, 1)
  }

  async obavijesti(
    z: ZadatakZaObavijest, statusPrije: string | null | undefined, o: { biljeg?: string | null } = {},
  ): Promise<IshodObavijesti> {
    const nista = (razlog: string): IshodObavijesti => ({ poslano: [], uSazetak: [], razlog })
    const cfg = this.cfg()
    const ob = cfg.obavijestZadatak
    if (!cfg.ukljucen || cfg.smjer === 'ulaz') return nista('e-pošta (izlaz) je isključena')
    if (!ob?.ukljucena) return nista('obavijest o zadatku je isključena (kartica E-pošta)')
    if (statusPrije === z.status) return nista('nije promjena statusa')
    const dopusteni = (ob.statusi || []).filter(s => (STATUSI_OBAVIJESTI as readonly string[]).includes(s))
    if (NIKAD.has(z.status) || !dopusteni.includes(z.status)) return nista(`status ${z.status} nije odabran`)
    if (jeProbniZadatak(z, o)) return nista('probni zadatak — bez obavijesti')
    if (!cfg.primatelji.length) return nista('nijedan primatelj nije upisan')

    const max = Math.max(1, Number(ob.najviseNaSat) || 10)
    const ikona = IKONA[z.status] || '📋'
    const naslov = `${ikona} ${z.id} — ${z.status}`
    const tekst = `${String(z.title || '')}\n\nZadatak: ${z.id}\nStatus: ${z.status}\n`
    const izlaz: IshodObavijesti = { poslano: [], uSazetak: [] }
    for (const prima of cfg.primatelji) {
      if (this.prozor(prima).length >= max) {
        const red = this.naCekanju.get(prima) || []
        red.push(`${ikona} ${z.id} — ${z.status}: ${String(z.title || '').slice(0, 120)}`)
        this.naCekanju.set(prima, red)
        izlaz.uSazetak.push(prima)
        continue
      }
      // Mjesto se rezervira PRIJE slanja: dva istodobna PUT-a inače oba vide slobodan prozor.
      const ts = this.o.sada()
      this.prozor(prima).push(ts)
      const r = await this.o.posalji(naslov, tekst, [prima])
      if (r.ok) izlaz.poslano.push(prima)
      else { this.otpusti(prima, ts); izlaz.razlog = r.greska }
    }
    if (izlaz.uSazetak.length) this.zakaziPraznjenje()
    return izlaz
  }

  /** Jedan mjerač za sve primatelje — budi se kad najranije mjesto u nekom prozoru oslobodi. */
  private zakaziPraznjenje() {
    if (this.zakazano) return
    const sada = this.o.sada()
    let ms = SAT_MS
    for (const prima of this.naCekanju.keys()) {
      const t = this.prozor(prima)
      if (t.length) ms = Math.min(ms, t[0] + SAT_MS - sada)
    }
    this.zakazano = true
    this.o.zakazi(() => {
      this.zakazano = false
      void this.isprazniSazetke().catch(() => { /* sljedeći prijelaz zakazuje ponovno */ })
    }, Math.max(1000, ms + 1000))
  }

  /** Pošalji sažetak svakom primatelju kojem se prozor otvorio. Vraća broj poslanih sažetaka. */
  async isprazniSazetke(): Promise<number> {
    const max = Math.max(1, Number(this.cfg().obavijestZadatak?.najviseNaSat) || 10)
    let broj = 0
    for (const [prima, red] of [...this.naCekanju.entries()]) {
      if (!red.length) { this.naCekanju.delete(prima); continue }
      if (this.prozor(prima).length >= max) continue
      const r = await this.o.posalji(
        `📋 Sažetak: ${red.length} promjena zadataka (strop ${max} mailova na sat)`,
        `Strop obavijesti je dosegnut, pa ove promjene stižu zajedno:\n\n${red.join('\n')}\n`,
        [prima],
      )
      if (r.ok) { this.prozor(prima).push(this.o.sada()); this.naCekanju.delete(prima); broj++ }
      // neuspjeh: red ostaje i ide u sljedeće pražnjenje
    }
    if ([...this.naCekanju.values()].some(r => r.length)) this.zakaziPraznjenje()
    return broj
  }
}
