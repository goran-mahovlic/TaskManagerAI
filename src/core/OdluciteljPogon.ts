/**
 * OdluciteljPogon.ts — pogon za „neka model odluci umjesto mene".
 *
 * POVOD (Goran, 05.09.2026.): „prebacio sam odluku na model, ali ne vidim da se nesto desava."
 *
 * I nije se desavalo. Prekidac je od 04.09. samo UPISIVAO zeljeni nacin u
 * `config/odlucitelj.json`; jedini pozivatelj `tools/odlucitelj.py` bio je gumb „Odluci sada"
 * na ploci. Ukljucen prekidac bez pogona je obecanje koje nitko ne ispunjava — zadatci su
 * stajali dalje, a covjek je gledao zelenu oznaku „model odlucuje" i cekao.
 *
 * Ovaj modul je taj pogon: daemon ga zove iz glavne petlje (prigusen na ~5 min), on pokrene
 * alat i ZAPISE sto se dogodilo. Zapis je jednako vazan kao i sama odluka — bez njega
 * „ne vidim da se nesto desava" ostaje istina i kad se sve desava.
 *
 * PRAVILA:
 *   - Fail-safe: nema datoteke, neispravan JSON ili `ukljucen != true` → NE RADI NISTA.
 *     Model nikad ne pocne odlucivati zbog pogreske u citanju.
 *   - Rucna kocnica je kocnica i za ovo (provjerava pozivatelj, prije poziva).
 *   - Alat sam bira sto smije: deterministicki filtar rizika u `tools/odlucitelj.py` zadrzi
 *     novac/brisanje/vanjski ucinak za covjeka i prije nego model bilo sto vidi.
 *   - Rok od 3 min: mrezni model koji visi ne smije zaustaviti daemonovu petlju.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { dirname } from 'path'
// Isti popisi kojima se ravna red autonomije — da se „tko se smije spawnati" ne razidje
// na dva mjesta. Puštanje koje red ne bi podigao mora se ovdje prepoznati kao neizvedivo.
import { ORCHESTRATOR_ASSIGNEES, DEFAULT_HUMAN_ASSIGNEES } from './AutonomyQueue'

const HOME = process.env.HOME || homedir()
export const ODLUCITELJ_CONFIG = `${HOME}/.claude/regoc/config/odlucitelj.json`
export const ODLUCITELJ_ZAPIS = `${HOME}/.claude/regoc/data/odlucitelj_zadnji.json`
/** Odgodjeni zadatci: {TASK-ID: {do: iso, puta: n}} — pise ih `tools/odlucitelj.py`. */
export const ODLUCITELJ_ODGODE = `${HOME}/.claude/regoc/data/odlucitelj_odgode.json`

/** Razmak izmedju prolaza. Odluka nije hitna — ceka se covjek, a ne stroj. */
export const ODLUCITELJ_INTERVAL_MS = 5 * 60_000
/** Rok za jedan prolaz. Prekoracenje je sigurno: zapis ostane star, prolaz se ponovi. */
export const ODLUCITELJ_ROK_MS = 180_000

export interface OdluciteljIshod {
  id: string
  /** `kreni` | `odgodi` | `covjek` | `opcija` | null (model nije odgovorio) */
  rijec: string | null
  razlog?: string
  /** Slovo odabrane opcije kad je zadatak nosio strukturirano pitanje. */
  opcija?: string
  tekstOpcije?: string
  naslov?: string
  ishod?: string
  filtar?: string
  /** Koliko je puta ZAREDOM odgodjen i koliko sati traje ova odgoda. */
  odgodaPuta?: number
  odgodaSati?: number
  /** Rizik prepoznat u opisu, ali ga je model svjesno pustio. */
  rizikPusten?: boolean
  /** Toliko uzastopnih odgoda da o tome treba javiti — obavijest, ne blokada. */
  javiti?: boolean
  /** Najava: dokad covjek ima rok i sto tocno treba odluciti (ide u konzolu i na Telegram). */
  najavaDo?: string
  najavaTekst?: string
  najavaSati?: number
}

export interface OdluciteljZapis {
  ts: string
  provider: string
  model: string
  pregledano: number
  /** Koliko je odluka doista upisano na zadatke. */
  upisano: number
  /** Koliko je ostavljeno covjeku (samo kad je prekidac iskljucen ili `smije_rizicno: false`). */
  ostavljeno: number
  /** Koliko ih je model sam odgodio i koliko pustio u rad. */
  odgodjeno: number
  pusteno: number
  ishodi: OdluciteljIshod[]
  greska?: string
}

export interface OdluciteljConfig {
  ukljucen: boolean
  provider: string
  model: string
  najvise_po_prolazu: number
  smije_kreni: boolean
}

const ZADANE: OdluciteljConfig = {
  ukljucen: false, provider: 'ollama', model: 'qwen3:8b',
  najvise_po_prolazu: 3, smije_kreni: true,
}

/** Fail-safe citanje: svaka nejasnoca znaci „iskljucen". */
export function ucitajConfig(putanja: string = ODLUCITELJ_CONFIG): OdluciteljConfig {
  try {
    const sirovo = JSON.parse(readFileSync(putanja, 'utf-8'))
    return { ...ZADANE, ...sirovo, ukljucen: sirovo?.ukljucen === true }
  } catch {
    return { ...ZADANE }
  }
}

/** Je li prosao razmak od zadnjeg prolaza? */
export function trebaProlaz(zadnjiMs: number, sadaMs: number,
                            interval: number = ODLUCITELJ_INTERVAL_MS): boolean {
  return sadaMs - zadnjiMs >= interval
}

/** Alat zivi na jednom od tri mjesta, ovisno o tome je li repozitorij spojen. */
export function nadjiAlat(): string | null {
  for (const put of [`${HOME}/app/regoc_system/tools/odlucitelj.py`,
                     `${HOME}/.claude/regoc/tools/odlucitelj.py`]) {
    if (existsSync(put)) return put
  }
  return null
}

/** Prebroji ishode. `upisano` je jedino sto je stvarno pomaknulo zadatak. */
export function sazmiIshode(ishodi: OdluciteljIshod[]): {
  pregledano: number; upisano: number; ostavljeno: number; odgodjeno: number; pusteno: number
} {
  const pregledano = ishodi.length
  const upisani = ishodi.filter(i => i.ishod === 'upisano')
  // Najava NIJE „ostavljeno tebi": rok teče i model odlučuje sam kad istekne. Brojati je kao
  // predaju čovjeku značilo bi tvrditi upravo ono što je Goran rekao da ne smije biti.
  const najave = ishodi.filter(i => i.rijec === 'najava').length
  return {
    pregledano,
    upisano: upisani.length,
    ostavljeno: pregledano - upisani.length - najave,
    odgodjeno: upisani.filter(i => i.rijec === 'odgodi').length,
    pusteno: upisani.filter(i => i.rijec === 'kreni' || i.rijec === 'opcija').length,
  }
}

/**
 * Jednoredni sazetak za dnevnik i za ploču.
 *
 * „Ostavio tebi" se ispisuje SAMO kad ih doista ima — dok je prekidac ukljucen taj broj mora
 * biti 0 (Goran, 05.09.2026.: „nista ne treba cekati mene ako sam odabrao da model odlucuje
 * za mene"), pa bi stalni „ostavio tebi 0" bio šum.
 */
export function opisiProlaz(z: OdluciteljZapis | null): string {
  if (!z) return 'odlučitelj još nije prošao'
  if (z.greska) return `odlučitelj je pao: ${z.greska}`
  if (!z.pregledano) return 'odlučitelj: nema zadataka koji čekaju odluku'
  const odgodjeno = z.odgodjeno ?? 0
  const pusteno = z.pusteno ?? z.upisano
  const razloziOdgode = z.ishodi.filter(i => i.rijec === 'odgodi')
    .map(i => i.filtar || 'prosudba modela')
  const repOdgode = odgodjeno ? ` (${[...new Set(razloziOdgode)].join(', ')})` : ''
  const tebi = z.ostavljeno
    ? ` · ostavio tebi ${z.ostavljeno} (${[...new Set(z.ishodi.filter(i => i.ishod !== 'upisano')
        .map(i => i.filtar || i.rijec || 'bez odgovora'))].join(', ')})`
    : ''
  const najave = z.ishodi.filter(i => i.rijec === 'najava').length
  const repNajava = najave ? ` · najavio ${najave} (čekaju tvoj rok)` : ''
  return `odlučitelj (${potpisModela(z.provider, z.model)}): pregledao ${z.pregledano} · pustio ${pusteno}`
    + ` · odgodio ${odgodjeno}${repOdgode}${repNajava}${tebi}`
}

/** `openrouter/auto` vec nosi davatelja u imenu — „openrouter/openrouter/auto" je sum. */
export function potpisModela(provider: string, model: string): string {
  return (!provider || String(model).startsWith(`${provider}/`)) ? model : `${provider}/${model}`
}

/** Odgode kakve ih vidi ploča. Neispravna datoteka = nema odgoda (nikad „sve odgođeno"). */
export function citajOdgode(putanja: string = ODLUCITELJ_ODGODE): Record<string, { do: string; puta: number }> {
  try {
    const d = JSON.parse(readFileSync(putanja, 'utf-8'))
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}
  } catch { return {} }
}

export function citajZadnjiProlaz(putanja: string = ODLUCITELJ_ZAPIS): OdluciteljZapis | null {
  try {
    const z = JSON.parse(readFileSync(putanja, 'utf-8'))
    return (z && typeof z.ts === 'string') ? z as OdluciteljZapis : null
  } catch { return null }
}

/** Atomican upis — poluzapisan JSON kod citatelja zavrsi kao „nikad nije proslo". */
export function zapisiProlaz(z: OdluciteljZapis, putanja: string = ODLUCITELJ_ZAPIS): void {
  try {
    mkdirSync(dirname(putanja), { recursive: true })
    const privremeno = `${putanja}.tmp`
    writeFileSync(privremeno, JSON.stringify(z, null, 1))
    renameSync(privremeno, putanja)
  } catch { /* zapis je uvid, ne uvjet rada */ }
}

/**
 * Jedan prolaz: pokreni alat, prebroji, zapisi. Vraca `null` kad je prekidac iskljucen ili
 * alata nema — to nije greska nego „nema se sto raditi".
 */
export async function pokreniProlaz(opts: {
  cfg?: OdluciteljConfig
  alat?: string | null
  rokMs?: number
  /** Kamo se pise zapis. Provjere MORAJU poslati vlastitu putanju — inace bi test
   *  prepisao pogonsko stanje i ploca bi prikazivala izmisljeni prolaz. */
  zapis?: string
  spawn?: (cmd: string[]) => Promise<{ izlaz: string; greske: string; kod: number }>
} = {}): Promise<OdluciteljZapis | null> {
  const cfg = opts.cfg ?? ucitajConfig()
  if (!cfg.ukljucen) return null
  const alat = opts.alat !== undefined ? opts.alat : nadjiAlat()
  if (!alat) {
    const z: OdluciteljZapis = {
      ts: new Date().toISOString(), provider: cfg.provider, model: cfg.model,
      pregledano: 0, upisano: 0, ostavljeno: 0, ishodi: [],
      greska: 'alat tools/odlucitelj.py nije pronađen na ovom stroju',
    }
    zapisiProlaz(z, opts.zapis ?? ODLUCITELJ_ZAPIS)
    return z
  }

  const pokreni = opts.spawn ?? zadaniSpawn(opts.rokMs ?? ODLUCITELJ_ROK_MS)
  let ishodi: OdluciteljIshod[] = []
  let greska: string | undefined
  try {
    const r = await pokreni(['python3', alat, '--izvrsi', '--json'])
    try {
      const p = JSON.parse((r.izlaz || '').trim() || '[]')
      if (Array.isArray(p)) ishodi = p
    } catch {
      // Alat je javio tekstom (npr. „odlucitelj je iskljucen u postavkama") — to je vijest,
      // ne rusenje.
      greska = (r.izlaz || r.greske || '').trim().slice(0, 200) || undefined
    }
    if (r.kod !== 0 && !greska) greska = (r.greske || `izlazni kod ${r.kod}`).trim().slice(0, 200)
  } catch (e: any) {
    greska = String(e?.message ?? e).slice(0, 200)
  }

  const z: OdluciteljZapis = {
    ts: new Date().toISOString(), provider: cfg.provider, model: cfg.model,
    ...sazmiIshode(ishodi), ishodi,
    ...(greska ? { greska } : {}),
  }
  zapisiProlaz(z, opts.zapis ?? ODLUCITELJ_ZAPIS)
  return z
}

function zadaniSpawn(rokMs: number) {
  return async (cmd: string[]) => {
    const pr = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const cekaj = (async () => {
      const izlaz = await new Response(pr.stdout).text()
      const greske = await new Response(pr.stderr).text()
      const kod = await pr.exited
      return { izlaz, greske, kod }
    })()
    const rok = new Promise<never>((_, odbij) =>
      setTimeout(() => { try { pr.kill() } catch { } ; odbij(new Error(`rok od ${Math.round(rokMs / 1000)} s je istekao`)) }, rokMs))
    return Promise.race([cekaj, rok])
  }
}

/** Redak zadatka koji je odlučitelj upravo pustio — onoliko koliko treba za sud o izvedivosti. */
export interface PustenZadatak {
  id: string
  assignee: string | null
  status: string
  paused?: boolean | number
}

export interface NeizvedivoPustanje {
  id: string
  razlog: string
}

/**
 * Puštanje koje stroj NE MOŽE podići (Goran, 05.09.2026.: „izgleda da se zadaci nisu
 * odključali").
 *
 * ODLUKA I POKRETANJE NISU ISTO. Odlučitelj napiše KRENI, ploča skine `needs-decision` i
 * doda `nalog` — i zadatak je uredno „otključan". Ali red autonomije zadatak s izvršiteljem
 * `regoc` NAMJERNO ne spawna (orkestrator radi u svojoj sjednici; incident 29.07.2026. kad
 * su dva Opusa ponovila gotov posao), pa TASK-4619 od 21:33 stoji u `pending` i nitko ga ne
 * dira. Izvana to izgleda točno kao pokvareno mjerenje vremena — a mjerenje je radilo.
 *
 * Zato svaki prolaz provjeri i ovo: je li pušteni zadatak doista pokretljiv. Ako nije, to je
 * vijest za čovjeka, ne tišina. NE mijenja se ništa na zadatku — izvršitelja bira čovjek,
 * jer su zadatci s `regoc` namjerno moji.
 */
export function neizvedivaPustanja(zadatci: PustenZadatak[]): NeizvedivoPustanje[] {
  const ljudi = new Set(DEFAULT_HUMAN_ASSIGNEES.map(a => a.toLowerCase()))
  const nalazi: NeizvedivoPustanje[] = []
  for (const z of zadatci) {
    const izvrsitelj = (z.assignee || '').trim()
    const kljuc = izvrsitelj.toLowerCase()
    if (z.paused === true || z.paused === 1) {
      nalazi.push({ id: z.id, razlog: 'zadatak je pauziran — kočnica je jača od odluke' })
    } else if (!izvrsitelj) {
      nalazi.push({ id: z.id, razlog: 'nema izvršitelja — red preskače zadatak bez `assignee`' })
    } else if (ORCHESTRATOR_ASSIGNEES.has(kljuc)) {
      nalazi.push({ id: z.id, razlog: `izvršitelj je ${izvrsitelj} (orkestrator) — red ga namjerno ne spawna, `
        + 'posao ide u mojoj sjednici; reci ako ga predam agentu' })
    } else if (ljudi.has(kljuc)) {
      nalazi.push({ id: z.id, razlog: `izvršitelj je ${izvrsitelj} (čovjek) — stroj ga ne pokreće` })
    } else if (z.status !== 'pending' && z.status !== 'in_progress') {
      nalazi.push({ id: z.id, razlog: `ostao je u statusu „${z.status}" — u red ulaze samo „pending" i „in_progress"` })
    }
  }
  return nalazi
}
