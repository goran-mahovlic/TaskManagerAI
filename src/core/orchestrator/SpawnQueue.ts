/**
 * SpawnQueue — strop usporednih spawnova, backoff nakon kvara, osigurač po agentu.
 *
 * Ovo je generički dio živog orkestratora (ADR-0001 §3.4): ne zna ni za jednog imenovanog
 * agenta ni za jedan CLI. Zna samo koliko poslova smije teći usporedno i koga trenutno
 * ne treba dizati jer je zadnjih nekoliko puta pao.
 *
 * ZAŠTO JITTER (mjereno u živom pogonu): bez njega dva procesa koja padnu u istoj sekundi
 * pokušavaju ponovno u istoj sekundi, pa udar u ograničenje dolazi u rafalu umjesto da se
 * raspline. Jitter je zato zadano uključen, a isključuje se samo u testu.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

export interface SpawnQueueOpcije {
  maxConcurrent: number
  backoff: { baseMs: number; maxMs: number; jitter: boolean }
  /** Nakon koliko sati se spawn smatra zaglavljenim bez obzira na sve ostalo. */
  hardCeilingHours: number
  now?: () => number
  /** Izvor slučajnosti — u testu se podmeće da jitter bude ponovljiv. */
  random?: () => number
}

export interface AktivniSpawn {
  agentId: string
  taskId: string
  pid?: number
  pocetak: number
}

export interface Odbijenica {
  ok: false
  razlog: 'strop' | 'backoff' | 'vec-radi'
  poruka: string
  /** Kod backoffa: kad se smije pokušati ponovno. */
  slobodanOd?: number
}

export type Dozvola = { ok: true } | Odbijenica

export class SpawnQueue {
  private opcije: Required<SpawnQueueOpcije>
  private aktivni = new Map<string, AktivniSpawn>()          // ključ: taskId
  private kvarovi = new Map<string, { broj: number; slobodanOd: number }>()

  constructor(opcije: SpawnQueueOpcije) {
    this.opcije = {
      now: () => Date.now(),
      random: () => Math.random(),
      ...opcije,
    } as Required<SpawnQueueOpcije>
  }

  /** Koliko poslova trenutno teče. */
  get broj(): number { return this.aktivni.size }

  aktivniPopis(): AktivniSpawn[] { return [...this.aktivni.values()] }

  aktivanZaZadatak(taskId: string): AktivniSpawn | null { return this.aktivni.get(taskId) || null }

  /** Smije li se agent sada dizati? Odbijenica UVIJEK nosi razlog — tiho preskakanje je kvar. */
  smije(agentId: string, taskId: string): Dozvola {
    if (this.aktivni.has(taskId)) {
      return { ok: false, razlog: 'vec-radi', poruka: `zadatak ${taskId} već ima živ spawn` }
    }
    if (this.aktivni.size >= this.opcije.maxConcurrent) {
      return {
        ok: false, razlog: 'strop',
        poruka: `strop usporednih spawnova (${this.opcije.maxConcurrent}) je dosegnut`,
      }
    }
    const k = this.kvarovi.get(agentId)
    const sada = this.opcije.now()
    if (k && k.slobodanOd > sada) {
      return {
        ok: false, razlog: 'backoff', slobodanOd: k.slobodanOd,
        poruka: `agent ${agentId} je u odgodi nakon ${k.broj} uzastopna kvara ` +
          `(još ${Math.ceil((k.slobodanOd - sada) / 1000)} s)`,
      }
    }
    return { ok: true }
  }

  zauzmi(agentId: string, taskId: string, pid?: number): AktivniSpawn {
    const zapis: AktivniSpawn = { agentId, taskId, pid, pocetak: this.opcije.now() }
    this.aktivni.set(taskId, zapis)
    return zapis
  }

  /** Kraj posla. `ok: false` pokreće odgodu za tog agenta, `ok: true` je briše. */
  oslobodi(taskId: string, ok: boolean): void {
    const zapis = this.aktivni.get(taskId)
    this.aktivni.delete(taskId)
    if (!zapis) return
    if (ok) { this.kvarovi.delete(zapis.agentId); return }
    const prije = this.kvarovi.get(zapis.agentId)?.broj || 0
    const broj = prije + 1
    this.kvarovi.set(zapis.agentId, { broj, slobodanOd: this.opcije.now() + this.odgoda(broj) })
  }

  /** Eksponencijalna odgoda s gornjom granicom i (zadano) jitterom. */
  odgoda(broj: number): number {
    const { baseMs, maxMs, jitter } = this.opcije.backoff
    const cista = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, broj - 1)))
    if (!jitter) return cista
    return Math.round(cista * (0.5 + this.opcije.random() * 0.5))
  }

  /** Spawnovi stariji od tvrdog stropa — ovi se gase bez obzira na dokaz života. */
  prekoStropa(): AktivniSpawn[] {
    const granica = this.opcije.now() - this.opcije.hardCeilingHours * 3600_000
    return this.aktivniPopis().filter(s => s.pocetak < granica)
  }

  stanje(): { aktivnih: number; strop: number; uOdgodi: { agentId: string; slobodanOd: number; broj: number }[] } {
    const sada = this.opcije.now()
    return {
      aktivnih: this.aktivni.size,
      strop: this.opcije.maxConcurrent,
      uOdgodi: [...this.kvarovi.entries()]
        .filter(([, v]) => v.slobodanOd > sada)
        .map(([agentId, v]) => ({ agentId, slobodanOd: v.slobodanOd, broj: v.broj })),
    }
  }
}
