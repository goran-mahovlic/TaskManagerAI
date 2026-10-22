/**
 * Petlja orkestratora U PROCESU PLOČE — gumb Pokreni/Zaustavi na Config → Orkestrator.
 *
 * Po uzoru na Telegram poller „način A" (DIZAJN-telegram-poller §2): ploča sama vrti
 * `jedanProlaz()` jezgre na `pollIntervalMs`, pa korisnik bez terminala dobije ono što
 * inače daje `bun scripts/orchestrator.ts`. Jezgra se ne mijenja — ona ionako s pločom
 * razgovara preko HTTP-a, pa joj je svejedno u čijem procesu živi.
 *
 * Tri stvari koje moraju biti točne:
 *   1. JEDNA petlja nad jednom pločom. Brava s PID-om (`core/Brava.ts`) dijeli se sa
 *      `scripts/orchestrator.ts`: tko krene drugi, odbija i imenuje prvoga. Dvije petlje
 *      bi se natjecale za iste zadatke.
 *   2. Želja korisnika je TRAJNA (`data/orchestrator-petlja.json`): nakon restarta ploče
 *      petlja se sama digne. To je stanje koje je stroj zatekao, ne konfiguracija — zato
 *      živi uz podatke, ne u orchestrator.json.
 *   3. Stop znači „ne pokreći nove agente". Agent koji već radi radi do kraja i sam se
 *      javlja ploči; petlja ga ne ubija.
 *   4. Ručna kočnica vrijedi (TASK-5715, nalaz C1): pod kočnicom se petlja ne pokreće ni
 *      gumbom ni autostartom, a jezgra kočnicu i kvotu pita prije SVAKOG spawna (port `vrata`).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { osigurajMapu, stanjePutanja } from './core/paths'
import { uzmiBravu, vlasnikBrave, type Brava } from './core/Brava'
import { readPauseState } from './core/PauseControl'
import { orkestratorUkljucen, type OrchestratorPostavke } from './core/orchestrator/OrchestratorConfig'
import type { IshodProlaza } from './core/orchestrator/Orchestrator'
import { sastaviOrkestrator } from './core/orchestrator'

export const PETLJA_STANJE_PUTANJA = stanjePutanja('orchestrator-petlja.json')
export const PETLJA_BRAVA_PUTANJA = stanjePutanja('orchestrator.lock')

/** Ono što petlja treba od sastava — namjerno uže od `Sastav`, da test ne nosi jezgru. */
export interface PetljaSastav {
  orkestrator: { jedanProlaz(): Promise<IshodProlaza> } | null
  cfg: OrchestratorPostavke
  greske: string[]
}

export interface PetljaOpcije {
  stanjePath?: string
  bravaPath?: string
  sastavi?: () => PetljaSastav
  log?: (r: string) => void
  /** Ručna kočnica; zadano `pause.state.json` (isti zapis kao ploča i daemon). */
  pauza?: () => boolean
}

export interface PetljaStanje {
  /** Vrti li se petlja u OVOM procesu. */
  radi: boolean
  /** Što korisnik želi (trajno): preživi restart ploče. */
  zeljeno: boolean
  pokrenutaU: string | null
  prolaza: number
  /** Ukupno pokrenutih agenata od pokretanja petlje. */
  pokrenuto: number
  zadnjiProlaz: string | null
  /** PID drugog ŽIVOG procesa koji drži bravu (npr. `scripts/orchestrator.ts`); inače null. */
  drugiProces: number | null
  /** Zašto zadnji start nije uspio, ako nije. */
  razlog: string | null
}

export interface Ishod { ok: boolean; razlog?: string }

export class OrchestratorPetlja {
  private readonly stanjePath: string
  private readonly bravaPath: string
  private readonly sastavi: () => PetljaSastav
  private readonly log: (r: string) => void
  private readonly pauza: () => boolean

  private radi = false
  /** Generacija lanca prolaza (Ž3): Zaustavi→Pokreni usred prolaza ne smije ostaviti dva lanca. */
  private gen = 0
  private uLetu: Promise<unknown> | null = null
  private tajmer: ReturnType<typeof setTimeout> | null = null
  private brava: Brava | null = null
  private pokrenutaU: string | null = null
  private prolaza = 0
  private pokrenuto = 0
  private zadnjiProlaz: string | null = null
  private razlog: string | null = null

  constructor(opcije: PetljaOpcije = {}) {
    this.stanjePath = opcije.stanjePath || PETLJA_STANJE_PUTANJA
    this.bravaPath = opcije.bravaPath || PETLJA_BRAVA_PUTANJA
    this.sastavi = opcije.sastavi || (() => sastaviOrkestrator())
    this.log = opcije.log || ((r: string) => console.log(r))
    this.pauza = opcije.pauza || (() => readPauseState().paused)
  }

  // ─── Trajno stanje ─────────────────────────────────────────────────────────

  private zeljeno(): boolean {
    try {
      if (!existsSync(this.stanjePath)) return false
      return JSON.parse(readFileSync(this.stanjePath, 'utf-8'))?.ukljucen === true
    } catch {
      return false
    }
  }

  private zapisiZelju(ukljucen: boolean, tko: string): void {
    try {
      osigurajMapu(this.stanjePath)
      writeFileSync(this.stanjePath, JSON.stringify({ ukljucen, tko, ts: new Date().toISOString() }, null, 2) + '\n', 'utf-8')
      this.log(`[orchestrator-petlja] želja: ${ukljucen ? 'uključena' : 'isključena'} (${tko})`)
    } catch (e: any) {
      this.log(`[orchestrator-petlja] stanje se ne može zapisati: ${e?.message || e}`)
    }
  }

  // ─── Stanje za ploču ───────────────────────────────────────────────────────

  stanje(): PetljaStanje {
    return {
      radi: this.radi,
      zeljeno: this.zeljeno(),
      pokrenutaU: this.pokrenutaU,
      prolaza: this.prolaza,
      pokrenuto: this.pokrenuto,
      zadnjiProlaz: this.zadnjiProlaz,
      drugiProces: this.radi ? null : vlasnikBrave(this.bravaPath),
      razlog: this.razlog,
    }
  }

  // ─── Životni ciklus ────────────────────────────────────────────────────────

  /** Pokreni petlju. Korisnikova želja se pamti SAMO kad je pokretanje uspjelo. */
  start(tko = 'ploca'): Ishod {
    if (this.radi) return { ok: true, razlog: 'petlja već radi' }
    let kocnica = false
    try { kocnica = this.pauza() } catch { kocnica = false }
    if (kocnica) return this.odbij('ručna kočnica je uključena — otpusti je (Nastavi) pa pokreni petlju')

    const sastav = this.sastavi()
    if (!orkestratorUkljucen(sastav.cfg)) {
      return this.odbij('orkestrator je isključen (enabled: false) — uključi ga na istoj kartici')
    }
    if (!sastav.orkestrator) {
      return this.odbij(`orkestrator nije složen: ${sastav.greske.join('; ') || 'nepoznat razlog'}`)
    }

    const brava = uzmiBravu(this.bravaPath, 'orkestrator')
    if (!brava.ok) return this.odbij(brava.razlog || 'brava se ne može uzeti')

    this.brava = brava
    this.radi = true
    this.razlog = null
    this.pokrenutaU = new Date().toISOString()
    this.prolaza = 0
    this.pokrenuto = 0
    this.zadnjiProlaz = null
    this.zapisiZelju(true, tko)
    for (const g of sastav.greske) this.log(`[orchestrator-petlja] napomena: ${g}`)
    this.log(`[orchestrator-petlja] pokrenuta u procesu ploče (svakih ${sastav.cfg.pollIntervalMs} ms)`)

    const orkestrator = sastav.orkestrator
    const interval = Math.max(1, sastav.cfg.pollIntervalMs)
    const gen = ++this.gen
    const ziv = () => this.radi && gen === this.gen
    const korak = async () => {
      if (!ziv()) return
      // Prolaz starog lanca (Zaustavi→Pokreni usred prolaza) mora završiti prije novog:
      // dva istodobna prolaza mogla bi istom zadatku dati dva agenta.
      if (this.uLetu) { try { await this.uLetu } catch { /* njegov pad nije naš */ } }
      if (!ziv()) return
      try {
        const let_ = orkestrator.jedanProlaz()
        this.uLetu = let_
        const ishod = await let_.finally(() => { if (this.uLetu === let_) this.uLetu = null })
        this.prolaza++
        this.pokrenuto += ishod?.spawn?.pokrenuto || 0
        this.zadnjiProlaz = new Date().toISOString()
      } catch (e: any) {
        this.log(`[orchestrator-petlja] prolaz je pao: ${e?.message || e}`)
      }
      if (!ziv()) return
      this.tajmer = setTimeout(korak, interval)
      if (typeof (this.tajmer as any)?.unref === 'function') (this.tajmer as any).unref()
    }
    void korak()
    return { ok: true }
  }

  /** Zaustavi petlju i zapamti da korisnik NE želi da se digne nakon restarta. */
  stop(tko = 'ploca'): void {
    const radila = this.radi
    this.radi = false
    this.gen++
    if (this.tajmer) { clearTimeout(this.tajmer); this.tajmer = null }
    if (this.brava?.osloboditi) this.brava.osloboditi()
    this.brava = null
    this.zapisiZelju(false, tko)
    if (radila) this.log('[orchestrator-petlja] zaustavljena — agenti koji već rade dovršavaju sami')
  }

  /** Pri pokretanju ploče: digni petlju ako ju je korisnik zadnji put ostavio uključenu. */
  autostart(): Ishod {
    if (!this.zeljeno()) return { ok: false, razlog: 'petlja nije bila uključena' }
    const r = this.start('autostart')
    if (!r.ok) this.log(`[orchestrator-petlja] autostart nije uspio: ${r.razlog}`)
    return r
  }

  private odbij(razlog: string): Ishod {
    this.razlog = razlog
    return { ok: false, razlog }
  }
}
