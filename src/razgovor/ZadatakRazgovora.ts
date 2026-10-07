// ─── Zadatak razgovora — trag razgovora na ploči čvora (TASK-5337) ─────────────
//
// Razgovor (pa i razgovor bot↔bot) dosad nije ostavljao trag na ploči: vlasnik nije vidio je
// li poruka primljena ni radi li se išta (node-A, 07.10.2026.). Ovdje se za NIT razgovora u
// chatu otvara jedan zadatak i u njega upisuju bilješke: 📥 primljeno → ⚙️ radi → 💬 odgovor /
// 📤 upit drugom botu → ✅ gotovo.
//
// Kada se otvara: potez koji uključuje drugog bota (od njega ili prema njemu) odmah; ljudski
// potez tek kad traje dulje od praga (nalog, ne odgovor u jednoj rečenici). Dok je nit otvorena,
// i kratke poruke u chatu idu u nju.
//
// Zadatak NEMA nositelja i nosi `no-autonomy`: daemon ga ne smije uzeti kao posao za agenta, a
// oporavak siročadi/zombija preskače zadatke bez nositelja. Status prati prijelaze ploče
// (pending → in_progress → completed). Upit drugom botu drži zadatak u radu najviše
// `cekanjeBotaMs`; bez odgovora se zatvara s ⌛ — ne visi u radu i ne koči restart.
//
// Autorica: Jelena (Engineer), TASK-5337.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Što modul treba od ploče — TaskWebUI ga veže na `taskManager`, testovi na lažnu ploču. */
export interface PlocaRazgovora {
  stvori(o: { naslov: string; opis: string; oznake: string[]; autor: string }): string | null
  /** Trenutni status zadatka; `null` = ne postoji. */
  status(id: string): string | null
  postaviStatus(id: string, status: 'in_progress' | 'completed', rezultat?: string): boolean
  biljeska(id: string, autor: string, tekst: string): void
}

export interface ZadaciRazgovoraOpcije {
  ploca: PlocaRazgovora
  /** `$TM_HOME/data/razgovor` — stanje niti u `zadaci.json`. */
  korijen: string
  /** Ime bota (potpis bilješki i `createdBy`). */
  autor: () => string
  sat?: () => number
  /** Ljudski potez dulji od ovoga otvara zadatak. Zadano 20 s. */
  pragMs?: number
  /** Koliko nit čeka odgovor drugog bota prije nego se zatvori. Zadano 30 min. */
  cekanjeBotaMs?: number
  /** Nit bez ikakvog događaja dulje od ovoga više nije „ista" — nova poruka otvara novi zadatak. */
  prozorMs?: number
  log?: (r: string) => void
}

interface Nit { id: string; zadnjiMs: number; cekaOdMs?: number }

export interface ZadaciRazgovora {
  readonly pragMs: number
  /** ID otvorenog zadatka niti ili `null`. */
  aktivni(kljuc: string): string | null
  /** Vrati otvoreni zadatak niti ili otvori novi (s bilješkom `primljeno`). */
  otvori(kljuc: string, o: { naslov: string; opis: string; primljeno: string }): string | null
  biljeska(kljuc: string, tekst: string): void
  radi(kljuc: string, tekst?: string): void
  cekaBota(kljuc: string, tekst: string): void
  gotovo(kljuc: string, tekst: string): void
  /** Zatvori niti kojima je istekao rok čekanja drugog bota. */
  provjeriRokove(): void
}

const OTVORENI = new Set(['pending', 'in_progress', 'blocked'])
export const OZNAKE_ZADATKA_RAZGOVORA = ['razgovor', 'no-autonomy'] as const

export function stvoriZadatkeRazgovora(o: ZadaciRazgovoraOpcije): ZadaciRazgovora {
  const sat = o.sat ?? Date.now
  const log = o.log ?? (() => {})
  const put = join(o.korijen, 'zadaci.json')
  const cekanjeBotaMs = o.cekanjeBotaMs ?? 30 * 60_000
  const prozorMs = o.prozorMs ?? 6 * 3600_000

  const ucitaj = (): Record<string, Nit> => {
    try {
      const s = JSON.parse(readFileSync(put, 'utf-8'))
      return s && typeof s === 'object' && !Array.isArray(s) ? s : {}
    } catch { return {} }
  }
  const spremi = (s: Record<string, Nit>) => {
    try {
      mkdirSync(o.korijen, { recursive: true })
      const tmp = `${put}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf-8')
      renameSync(tmp, put)
    } catch (e: any) { log(`[razgovor] zadaci.json: ${String(e?.message || e)}`) }
  }
  const sigurno = <T>(f: () => T, zadano: T): T => {
    try { return f() } catch (e: any) { log(`[razgovor] ploča: ${String(e?.message || e)}`); return zadano }
  }

  function aktivni(kljuc: string): string | null {
    const s = ucitaj()
    const n = s[kljuc]
    if (!n) return null
    const st = sigurno(() => o.ploca.status(n.id), null)
    if (!st || !OTVORENI.has(st) || sat() - n.zadnjiMs > prozorMs) {
      delete s[kljuc]
      spremi(s)
      return null
    }
    return n.id
  }

  function dodirni(kljuc: string, izmjena: (n: Nit) => void = () => {}): void {
    const s = ucitaj()
    const n = s[kljuc]
    if (!n) return
    n.zadnjiMs = sat()
    izmjena(n)
    spremi(s)
  }

  function biljeska(kljuc: string, tekst: string): void {
    const id = aktivni(kljuc)
    if (!id) return
    sigurno(() => o.ploca.biljeska(id, o.autor(), tekst), undefined)
    dodirni(kljuc)
  }

  function zatvori(kljuc: string, id: string, tekst: string): void {
    sigurno(() => o.ploca.biljeska(id, o.autor(), tekst), undefined)
    // completed je dopušten samo iz in_progress (tablica prijelaza ploče)
    if (sigurno(() => o.ploca.status(id), null) === 'pending') sigurno(() => o.ploca.postaviStatus(id, 'in_progress'), false)
    sigurno(() => o.ploca.postaviStatus(id, 'completed', tekst), false)
    const s = ucitaj()
    delete s[kljuc]
    spremi(s)
  }

  return {
    pragMs: o.pragMs ?? 20_000,
    aktivni,
    otvori(kljuc, z) {
      const postoji = aktivni(kljuc)
      if (postoji) {
        biljeska(kljuc, z.primljeno)
        return postoji
      }
      const id = sigurno(() => o.ploca.stvori({
        naslov: z.naslov, opis: z.opis, oznake: [...OZNAKE_ZADATKA_RAZGOVORA, `chat:${kljuc}`], autor: o.autor(),
      }), null)
      if (!id) return null
      const s = ucitaj()
      s[kljuc] = { id, zadnjiMs: sat() }
      spremi(s)
      sigurno(() => o.ploca.biljeska(id, o.autor(), z.primljeno), undefined)
      log(`[razgovor] ${kljuc}: otvoren zadatak razgovora ${id}`)
      return id
    },
    biljeska,
    radi(kljuc, tekst) {
      const id = aktivni(kljuc)
      if (!id) return
      if (tekst) sigurno(() => o.ploca.biljeska(id, o.autor(), tekst), undefined)
      sigurno(() => o.ploca.postaviStatus(id, 'in_progress'), false)
      dodirni(kljuc, n => { delete n.cekaOdMs })
    },
    cekaBota(kljuc, tekst) {
      const id = aktivni(kljuc)
      if (!id) return
      sigurno(() => o.ploca.biljeska(id, o.autor(), tekst), undefined)
      dodirni(kljuc, n => { n.cekaOdMs = sat() })
    },
    gotovo(kljuc, tekst) {
      const id = aktivni(kljuc)
      if (id) zatvori(kljuc, id, tekst)
    },
    provjeriRokove() {
      const s = ucitaj()
      for (const [kljuc, n] of Object.entries(s)) {
        if (n.cekaOdMs !== undefined && sat() - n.cekaOdMs > cekanjeBotaMs) {
          zatvori(kljuc, n.id, `⌛ drugi bot nije odgovorio u ${Math.round(cekanjeBotaMs / 60_000)} min — nit zatvorena`)
        }
      }
    },
  }
}
