/**
 * IngestGateShadow — ulazna vrata u položaju SJENA (U2, TASK-4262).
 *
 * Razrada: `~/app/regoc_system/docs/RAZRADA-3691_workflow_i_pragovi.md` §1 (položaji) i §2 (pragovi).
 *
 * ŠTO OVAJ MODUL RADI: za svaku telegramsku poruku iz full-access grupe izračuna što BI
 * ulazna vrata napravila (težina, projekt, odluka po pragovima A i B) i to ZAPIŠE u
 * `data/ingest_gate.jsonl`. Ništa više.
 *
 * ŠTO NAMJERNO NE RADI — i zašto je to cijela poanta U2:
 *   • ne otvara zadatak, ne dira ploču, ne mijenja put poruke (poruka i dalje ide u `claude -p`);
 *   • ne baca iznimke prema pozivatelju. Ovo stoji na vrućem putu SVAKE Goranove poruke;
 *     iznimka ovdje značila bi da most stane, a most je jedini ulaz. Zato je svaki javni
 *     ulaz omotan u `try/catch` koji na kvar vrati `null` i tiho ostavi zapis u stderr.
 *
 * ZAŠTO SJENA UOPĆE POSTOJI (nalog, doslovno): „prije nego što ulaz promijeni put
 * korisnikovih poruka, mora se izmjeriti koliko bi zadataka nastalo i koliko bi ih bilo
 * lažnih." Mjerilo koje se pali zajedno s mehanizmom koji mjeri ne može ga opovrgnuti —
 * ista pouka kao kod vrata autonomije koja mjere sama sebe.
 *
 * ZAŠTO SE NIŠTA NE KEŠIRA: config se čita pri svakoj poruci (kao u `IngestGateConfig`),
 * jer bi keš bio jedina stvar koja traži restart mosta nakon pomicanja praga na ploči.
 *
 * Autorica: Jelena (Engineer), TASK-4262.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

import { getModeClassifier, type EffortTier } from './ModeClassifier'
import { routeByWeight, scoreWeight, countFiles, type Postupak } from './WeightScore'
import { pogodiProjekt, type IzvorProjekta } from './ProjectGuess'
import {
  loadIngestGateConfig, nacinZaGrupu, projektZaGrupu,
  type IngestGatePostavke,
} from './TaskManagerMD/src/IngestGateConfig'
import {
  ucitajKalibraciju, izvuciZnacajke, razredIzZnacajki, opisZnacajki, zadnjiZapisiGrupe,
  type Kalibracija, type PrethodniZapis,
} from './IngestGateKalibracija'
import { homedir } from 'os'

/** Inačica zapisa — izvještaj mora znati po kojim je pravilima redak nastao. */
export const SHADOW_VERZIJA = 1

export const INGEST_SHADOW_LOG_PATH = join(
  process.env.HOME || homedir(), '.claude/regoc/data/ingest_gate.jsonl')

/** Koliko znakova poruke ide u zapis (nalog: „prvih 200 znakova"). */
export const ISJECAK_ZNAKOVA = 200

export interface SjenaUlaz {
  chatId: number | string
  /** Oznaka grupe s mosta: `REGOČ`, `Intergalaktik`, `IntergalaktikSportAI`. */
  grupa: string
  /** Pošiljatelj u obliku „Ime (uid:123)" — isto kao biljeg `[OD: …]`. */
  posiljatelj: string
  tekst: string
  /** Vrijeme poruke; zadano „sada". Postavlja se kod ponovnog prolaza kroz stari promet. */
  ts?: string
  /** `live` = pravi promet kroz most, `replay` = ponovni prolaz kroz stari promet. */
  izvor?: 'live' | 'replay'
}

export interface SjenaZapis {
  ts: string
  chatId: number | string
  grupa: string
  posiljatelj: string
  /** Prvih 200 znakova očišćene poruke, u jednom retku. */
  poruka: string
  /** Duljina CIJELE očišćene poruke — isječak sam po sebi ne bi razlikovao kratko od dugog. */
  duljina: number
  effort: EffortTier
  tezina: number
  tezinaRazlog: string
  projekt: string
  projektIzvor: IzvorProjekta
  /** Prag A — bi li se uopće otvorio zadatak. */
  biOtvorioZadatak: boolean
  /** Prag B — bi li išao u puni lanac. */
  biIsaoULanac: boolean
  postupak: Postupak
  trebaPotvrdu: boolean
  razlog: string
  pragovi: { A: number; B: number; C: number }
  izvor: 'live' | 'replay'
  verzija: number
  /** Kojom je ocjenom redak nastao (TASK-5161). Bez polja = v1. */
  ocjena?: 'v1' | 'v2'
  /** Značajke ocjene v2 (nalog, struke, odrezan ispis) — samo kad je ocjena v2. */
  znacajke?: string
  brojStruka?: number
  /** Što bi rekla stara ocjena — uz v2 se čuva radi usporedbe u istom retku. */
  v1?: { effort: EffortTier; tezina: number; postupak: Postupak }
}

export interface ProcjenaOpcije {
  /** Postavke kalibracije; zadano se čitaju s diska pri svakom pozivu. */
  kalibracija?: Kalibracija
  /** Zadnji zapisi iste grupe (kontekst za „nastavak posla"). */
  prethodni?: PrethodniZapis[]
}

const RE_BILJEG_OD = /\[OD:\s*[^\]]*\]\s*/g
const RE_PRETHODNI_KONTEKST = /\[PRETHODNI KONTEKST[\s\S]*?\]\s*/g

/**
 * Očisti biljege koje je dodao most prije nego što tekst ode u ocjenu.
 * Bez ovoga bi svaka poruka nosila `[OD: …]` i `[PRETHODNI KONTEKST …]` — biljeg s
 * kontekstom zna biti dulji od same poruke, pa bi klasifikator mjerio TUĐI tekst
 * (ista zamka kao pri gradnji korpusa transkripata).
 */
export function ocistiPoruku(tekst: string): string {
  return String(tekst || '')
    .replace(RE_PRETHODNI_KONTEKST, '')
    .replace(RE_BILJEG_OD, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Što BI ulazna vrata napravila s ovom porukom. Čista funkcija (osim vremenskog žiga):
 * bez mreže, bez modela, bez diska — ista poruka uvijek daje istu odluku.
 *
 * Težina: razred daje `ModeClassifier` (E1–E5), broj 1–100 daje `WeightScore` po
 * razradi §3. `planSteps` je 0 jer plana pri prijemu još nema — ocjena se poslije
 * osvježava kad razlaganje da broj koraka.
 */
export function procijeniUlaz(ulaz: SjenaUlaz, cfg: IngestGatePostavke, opcije: ProcjenaOpcije = {}): SjenaZapis {
  const cisto = ocistiPoruku(ulaz.tekst)
  const kal = opcije.kalibracija || ucitajKalibraciju()
  const ts = ulaz.ts || new Date().toISOString()

  const razredV1 = getModeClassifier().classifyMessage(cisto)
  const ocjenaV1 = scoreWeight({ effort: razredV1.effort, planSteps: 0, files: countFiles(cisto), retried: false })

  // v2 (TASK-5161): razred iz NALOGA i BROJA STRUKA nad ljudskim dijelom poruke.
  let ocjena = ocjenaV1
  let v2: { znacajke: string; brojStruka: number } | null = null
  if (kal.inacica === 2) {
    const z = izvuciZnacajke(cisto, kal, { ts, prethodni: opcije.prethodni })
    const effort = razredIzZnacajki(z, kal)
    ocjena = scoreWeight({ effort, planSteps: 0, files: countFiles(z.ljudskiDio), retried: z.nastavak })
    v2 = { znacajke: opisZnacajki(z), brojStruka: z.struke.length }
  }
  const put = routeByWeight({
    score: ocjena.score, pragA: cfg.pragA, pragB: cfg.pragB, pragC: cfg.pragC, planSteps: 0,
  })
  const { projekt, izvor: projektIzvor } = pogodiProjekt(
    cisto, ulaz.grupa, projektZaGrupu(cfg, ulaz.chatId))
  const putV1 = v2 ? routeByWeight({
    score: ocjenaV1.score, pragA: cfg.pragA, pragB: cfg.pragB, pragC: cfg.pragC, planSteps: 0,
  }) : put

  return {
    ts,
    chatId: ulaz.chatId,
    grupa: ulaz.grupa,
    posiljatelj: ulaz.posiljatelj,
    poruka: cisto.slice(0, ISJECAK_ZNAKOVA),
    duljina: cisto.length,
    effort: ocjena.effort,
    tezina: ocjena.score,
    tezinaRazlog: ocjena.reason,
    projekt,
    projektIzvor,
    biOtvorioZadatak: put.postupak !== 'odgovor',
    biIsaoULanac: put.postupak === 'lanac' || put.postupak === 'lanac-uz-potvrdu',
    postupak: put.postupak,
    trebaPotvrdu: put.trebaPotvrdu,
    razlog: put.reason,
    pragovi: { A: cfg.pragA, B: cfg.pragB, C: cfg.pragC },
    izvor: ulaz.izvor || 'live',
    verzija: SHADOW_VERZIJA,
    ...(v2 ? {
      ocjena: 'v2' as const,
      znacajke: v2.znacajke,
      brojStruka: v2.brojStruka,
      v1: { effort: ocjenaV1.effort, tezina: ocjenaV1.score, postupak: putV1.postupak },
    } : {}),
  }
}

/**
 * Dopiši redak. Namjerno `appendFileSync` bez brave: jedan redak JSON-a je znatno
 * ispod PIPE_BUF, a `O_APPEND` u jezgri jamči da se dva pisca ne izmiješaju usred retka
 * (ista odluka kao kod dnevnika daemona). Zaključavanje bi na vrući put poruke dodalo
 * kvar koji je gori od problema koji rješava.
 */
export function zapisiSjenu(zapis: SjenaZapis, logPath: string = INGEST_SHADOW_LOG_PATH): void {
  const dir = dirname(logPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(logPath, JSON.stringify(zapis) + '\n', 'utf-8')
}

export interface SjenaOpcije {
  configPath?: string
  logPath?: string
  /** Dnevnik kvarova; zadano `console.error`. Most ovamo šalje svoj `log()`. */
  log?: (poruka: string) => void
}

/**
 * JEDINA funkcija koju most zove. Vraća zapis ako je nastao, inače `null`.
 *
 * Nikad ne baca. Pozivatelj smije zanemariti povratnu vrijednost — i treba je zanemariti,
 * jer sjena po definiciji ne smije utjecati ni na jednu odluku u mostu.
 */
export function mozdaZapisiSjenu(ulaz: SjenaUlaz, opcije: SjenaOpcije = {}): SjenaZapis | null {
  try {
    if (!String(ulaz?.tekst || '').trim()) return null
    const cfg = opcije.configPath ? loadIngestGateConfig(opcije.configPath) : loadIngestGateConfig()
    if (nacinZaGrupu(cfg, ulaz.chatId) !== 'shadow') return null
    const logPath = opcije.logPath || INGEST_SHADOW_LOG_PATH
    const zapis = procijeniUlaz(ulaz, cfg, { prethodni: zadnjiZapisiGrupe(ulaz.chatId, logPath) })
    zapisiSjenu(zapis, logPath)
    return zapis
  } catch (e: any) {
    try {
      (opcije.log || console.error)(`[INGEST-SJENA] zapis preskočen: ${e?.message || e}`)
    } catch { /* ni dnevnik ne smije srušiti most */ }
    return null
  }
}
