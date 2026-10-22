/**
 * IngestGateLive — ulazna vrata u položaju UŽIVO (U3, TASK-4263).
 *
 * Razrada: `~/app/regoc_system/docs/RAZRADA-3691_workflow_i_pragovi.md` §1 (položaji) i §2 (pragovi).
 *
 * ŠTO RADI. Za poruku iz grupe koja je u položaju `on` i koja je IZNAD PRAGA A odluči da
 * poruka ne ide izravno u `claude -p`, nego u `messages.db` kao zahtjev REGOČ-u. Odatle je
 * preuzima postojeći `delegateToAgent`: otvara zadatak, dodjeljuje projekt, pokreće
 * izvršitelja i piše `cost_log`. Potvrda s brojem zadatka i kasniji rezultat vraćaju se u
 * ISTU grupu jer poruka nosi `chat_id` i metapodatke (`source=telegram`, `chatId`,
 * `senderId`) — RegocDaemon iz njih izvodi kanal za odgovor.
 *
 * ŠTO NAMJERNO NE RADI: ne otvara zadatak sam. Ploča ima JEDNA ulazna vrata
 * (`handleCreateTask`) i jedan put do izvršitelja (`delegateToAgent`); drugi stvaratelj
 * zadataka značio bi drugu granu koja zaobilazi vratare (anti-echo, prazan opis, strop
 * stvaranja) i dvije istine o tome tko je zadatak otvorio.
 *
 * ZAŠTO SVAKA DVOJBA ZAVRŠI KAO `proslijedi`. Ovo stoji na vrućem putu svake Goranove i
 * Martinine poruke, a most je jedini ulaz. Kriva postavka, pauza, mrtav daemon ili
 * iznimka moraju dati DANAŠNJE ponašanje (poruka ide u `claude -p`), nikad tišinu.
 * Vrata koja u dvojbi progutaju poruku gora su od vrata kojih nema.
 *
 * ZAŠTO SE MJERENJE NE GASI. I u položaju `on` se piše redak sjene u
 * `data/ingest_gate.jsonl`. Bez toga bi se točno u trenutku paljenja izgubila usporedba
 * „što bi vrata napravila" ↔ „što su napravila" — a upravo se ta usporedba traži za
 * odluku o sljedećoj grupi.
 *
 * Autorica: Jelena (Engineer), TASK-4263.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  procijeniUlaz, zapisiSjenu, INGEST_SHADOW_LOG_PATH,
  type SjenaUlaz, type SjenaZapis,
} from './IngestGateShadow'
import type { EffortTier } from './ModeClassifier'
import { mozdaZapisiOdluku, type VrataOpcije as WorkflowVrataOpcije } from './WorkflowGate'
import { zadnjiZapisiGrupe } from './IngestGateKalibracija'
import type { IzvorProjekta } from './ProjectGuess'
import {
  loadIngestGateConfig, nacinZaGrupu, type Nacin,
} from './TaskManagerMD/src/IngestGateConfig'
import { homedir } from 'os'

/** PID datoteka RegocDaemona — SSOT je `RegocDaemon.PID_FILE`. */
export const REGOC_DAEMON_PID_FILE = join(
  process.env.HOME || homedir(), '.claude/regoc/daemon.pid')

/** Stanje ručne kočnice (pravilo 17) — SSOT je `PauseControl.PAUSE_STATE_FILE`. */
export const REGOC_PAUSE_STATE_FILE = join(
  process.env.HOME || homedir(), '.claude/regoc/data/pause.state.json')

/** Razlozi odluke — stalni nizovi, jer ulaze u dnevnik mosta i u testove. */
export const RAZLOG = {
  UZIVO: 'uživo: iznad praga A → zadatak preko ploče',
  NIJE_UZIVO: 'grupa nije u položaju on',
  ISPOD_PRAGA: 'ispod praga A → odgovor, ploča se ne dira',
  PITANJE: 'obično pitanje → odgovor, ploča se ne dira',
  PAUZA: 'ručna kočnica je povučena',
  DAEMON_MRTAV: 'RegocDaemon ne radi — poruka bi ostala u bazi',
  NEMA_OCJENE: 'nema ocjene ulaza',
  KVAR: 'kvar u vratima — staro ponašanje',
} as const

export type UlaznaAkcija = 'proslijedi' | 'zadatak'

/**
 * Metapodatci koji putuju uz poruku u `messages.metadata`.
 *
 * `projectId` je ovdje, a ne prepušten daemonovom `detectProjectId`, jer daemon ne zna
 * iz koje je grupe poruka došla — a upravo zadani projekt grupe (SportAI → PRJ-034)
 * razvrstava 58 % SportAI prometa (mjereno na sjeni, 100 poruka / 7 dana). Bez njega bi
 * ta većina pala u pretinac PRJ-033 i trošak grupe se NE bi pojavio na projektu.
 */
export interface IngestMetadata {
  source: 'telegram'
  chatId: number | string
  senderId: number | string
  grupa: string
  projectId: string
  projectSource: IzvorProjekta
  effort: EffortTier
  tezina: number
}

export interface UlaznaOdluka {
  akcija: UlaznaAkcija
  razlog: string
  /** Ocjena ulaza; `null` samo kad je poruka prazna ili je ocjena pukla. */
  zapis: SjenaZapis | null
  /** Postoji samo uz `akcija: 'zadatak'`. */
  metadata?: IngestMetadata
}

/**
 * Pročitaj metapodatke ulaznih vrata iz `messages.metadata`.
 *
 * DRUGA STRANA ISTOG ŠAVA: piše ih most (`metapodatciUlaza`), čita ih RegocDaemon. Zato
 * su čitanje i pisanje u istoj datoteci — dva popisa polja razišla bi se pri prvoj
 * izmjeni, a raskorak bi bio nevidljiv (daemon bi samo tiho pao na pretinac PRJ-033).
 *
 * Vraća `null` za sve što nije naš zapis: nevaljan JSON, tuđi `source`, ili nedostaje
 * `chatId`. Nikad ne baca — stoji na putu SVAKE poruke koju daemon obrađuje.
 */
export function procitajIngestMeta(metadata?: string | null): IngestMetadata | null {
  if (!metadata) return null
  try {
    const m = JSON.parse(metadata) as Record<string, unknown>
    if (m?.source !== 'telegram') return null
    const chatId = m.chatId
    if (typeof chatId !== 'number' && typeof chatId !== 'string') return null
    return {
      source: 'telegram',
      chatId,
      senderId: (typeof m.senderId === 'number' || typeof m.senderId === 'string') ? m.senderId : '',
      grupa: typeof m.grupa === 'string' ? m.grupa : '',
      projectId: typeof m.projectId === 'string' ? m.projectId : '',
      projectSource: (m.projectSource as IzvorProjekta) ?? 'pretinac',
      effort: (m.effort as EffortTier) ?? 'E1',
      tezina: typeof m.tezina === 'number' ? m.tezina : 0,
    }
  } catch {
    return null
  }
}

/** Poruka koju most predaje vratima — sjena + identitet pošiljatelja. */
export interface ZiviUlaz extends SjenaUlaz {
  /** Telegramov `from.id`; ide u metapodatke da se kasnije zna TKO je tražio. */
  senderId: number | string
}

export function metapodatciUlaza(zapis: SjenaZapis, senderId: number | string): IngestMetadata {
  return {
    source: 'telegram',
    chatId: zapis.chatId,
    senderId,
    grupa: zapis.grupa,
    projectId: zapis.projekt,
    projectSource: zapis.projektIzvor,
    effort: zapis.effort,
    tezina: zapis.tezina,
  }
}

/**
 * Čista odluka — bez diska, bez mreže. Redoslijed grana JE pravilo:
 * prvo sve što vraća staro ponašanje, tek na kraju skretanje na ploču.
 */
export function odluciUlaz(args: {
  nacin: Nacin
  zapis: SjenaZapis | null
  senderId: number | string
  pauzirano: boolean
  daemonZiv: boolean
}): UlaznaOdluka {
  const { nacin, zapis, senderId, pauzirano, daemonZiv } = args
  if (!zapis) return { akcija: 'proslijedi', razlog: RAZLOG.NEMA_OCJENE, zapis: null }
  if (nacin !== 'on') return { akcija: 'proslijedi', razlog: RAZLOG.NIJE_UZIVO, zapis }
  if (pauzirano) return { akcija: 'proslijedi', razlog: RAZLOG.PAUZA, zapis }
  if (!daemonZiv) return { akcija: 'proslijedi', razlog: RAZLOG.DAEMON_MRTAV, zapis }
  if (!zapis.biOtvorioZadatak) return { akcija: 'proslijedi', razlog: RAZLOG.ISPOD_PRAGA, zapis }
  if (jeObicnoPitanje(zapis.poruka)) return { akcija: 'proslijedi', razlog: RAZLOG.PITANJE, zapis }
  return {
    akcija: 'zadatak',
    razlog: `${RAZLOG.UZIVO} (${zapis.effort}/${zapis.tezina}, projekt ${zapis.projekt})`,
    zapis,
    metadata: metapodatciUlaza(zapis, senderId),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Obično pitanje — druga polovica praga A
// ────────────────────────────────────────────────────────────────────────────
//
// ZAŠTO OVDJE, A NE U `ModeClassifier`. Razrada §2 prag A doslovno kaže: „Ispod praga
// (pozdrav, PITANJE, „koliko je sati", razrada ideje) odgovor ide odmah i ploča ostaje
// čista." Prag A živi u ovim vratima, pa ovdje pripada i pravilo koje ga dovršava.
// `ModeClassifier` se NE dira: njegova točnost ima svoju mjeru (zlatni skup) i svoj
// zadatak (TASK-4673), a mijenjati ga usput značilo bi mijenjati i izbor modela za
// cijeli sustav bez tog mjerenja.
//
// ZAŠTO JE UOPĆE POTREBNO — mjereno, ne pretpostavljeno. E2 je u `ModeClassifier` grana
// KOJA HVATA SVE ŠTO NIJE KRATKO I NIJE POZDRAV. Zato je „Zašto se mora ići u terensku
// provjeru?" ispalo E2/26, dakle iznad praga A — obično pitanje koje bi otvorilo zadatak
// i pokrenulo agenta. To je točno ono što prihvatni kriterij U3 zabranjuje.
//
// ZAŠTO OVAKO USKO. Ponovni prolaz kroz 682 stvarne poruke (7 dana, obje grupe): od 347
// koje su iznad praga A ovo pravilo vraća u „odgovor" TOČNO 2 retka — obje su ista ona
// rečenica. Nijedan pravi zahtjev nije pao. Uska vrata koja hvataju jedan dokazani slučaj
// vrijede više od širokog pravila koje bi usput progutalo posao.
//
// Tri uvjeta moraju vrijediti ZAJEDNO:
//   1. JEDNA rečenica koja završava upitnikom — višedijelna poruka („gdje smo stali -
//      provjeri i popravi - zašto…?") je nalog s pitanjem na kraju, ne pitanje;
//   2. počinje pravom upitnom riječi — `možeš li` / `bi li` NISU ovdje, to su uljudni
//      imperativi i moraju ostati zahtjevi;
//   3. nema glagola naloga. Provjera ide PO GRANICI RIJEČI (`\b…\w*`), pa „provjeru"
//      i „provjera" ne prolaze kao „provjeri" — upravo ta zamka podniza je razlog
//      zašto se popisu riječi u `ModeClassifier` danas ne može vjerovati.

const UPITNE_RIJECI = /^(zašto|zasto|kako|koliko|kolika|koliki|kada|kad|gdje|tko|što|sto|šta|sta|čime|cime|čemu|cemu|otkud|odakle|kamo|koji|koja|koje|kojim|kojih|kojeg)\b/i

const GLAGOLI_NALOGA = new RegExp(
  '\\b(napravi|napiši|napisi|popravi|dodaj|pronađi|pronadji|obriši|obrisi|promijeni|promjeni|' +
  'provjeri|pokreni|zaustavi|pošalji|posalji|sredi|razradi|istraži|istrazi|implementiraj|' +
  'kreiraj|refaktoriraj|analiziraj|pripremi|dovrši|dovrsi|ispravi|prilagodi|osiguraj|izradi|' +
  'dostavi|prebaci|ukloni|zamijeni|testiraj|dokumentiraj)\\w*\\b', 'i')

/**
 * Obično pitanje — ide na odgovor, ne otvara zadatak. Uvjeti u komentaru iznad.
 *
 * Zove se nad `zapis.poruka` (isječak od 200 znakova), pa pravilo po samoj svojoj
 * mehanici NE MOŽE uhvatiti poruku dulju od toga — odrezani tekst ne završava upitnikom.
 * To je namjerno zadržano: poruka od 200+ znakova nije „obično pitanje", pa je dodatna
 * gornja granica na strani opreza (radije otvori zadatak nego da progutaš posao).
 */
export function jeObicnoPitanje(tekst: string): boolean {
  const s = String(tekst || '').trim()
  if (!s.endsWith('?')) return false
  if ((s.match(/[?!.;\n]/g) || []).length !== 1) return false
  if (/\s[-–—]\s/.test(s)) return false
  if (!UPITNE_RIJECI.test(s)) return false
  return !GLAGOLI_NALOGA.test(s)
}

/** Je li proces sa zapisanim PID-om živ. Nečitljiv PID = nije živ (pa vrata propuštaju). */
export function daemonRadi(pidFile: string = REGOC_DAEMON_PID_FILE): boolean {
  try {
    if (!existsSync(pidFile)) return false
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    if (!Number.isInteger(pid) || pid <= 1) return false
    process.kill(pid, 0)   // signal 0 = samo provjera postojanja
    return true
  } catch {
    return false
  }
}

/** Ručna kočnica. Fail-open kao u `PauseControl`: nečitljivo stanje NIJE pauza. */
export function rucnaKocnicaPovucena(file: string = REGOC_PAUSE_STATE_FILE): boolean {
  try {
    if (!existsSync(file)) return false
    return JSON.parse(readFileSync(file, 'utf-8'))?.paused === true
  } catch {
    return false
  }
}

export interface ZivaOpcije {
  configPath?: string
  logPath?: string
  pidFile?: string
  pauseFile?: string
  /** Preklopivo zbog testova; produkcija koristi datoteke iznad. */
  pauzirano?: () => boolean
  daemonZiv?: () => boolean
  /** Dnevnik; zadano `console.error`. Most ovamo šalje svoj `log()`. */
  log?: (poruka: string) => void
  /** Putanje prekidača tijekova (W1); produkcija koristi zadane iz `WorkflowGate`. */
  workflowOpcije?: WorkflowVrataOpcije
}

/**
 * JEDINA funkcija koju most zove. Nikad ne baca — svaki kvar je `proslijedi`.
 *
 * Postavke i kočnica se čitaju pri SVAKOM prolazu (bez keša), pa povratak grupe u `off`
 * i povlačenje kočnice djeluju odmah, bez ponovnog pokretanja mosta.
 */
export function obradiUlaz(ulaz: ZiviUlaz, opcije: ZivaOpcije = {}): UlaznaOdluka {
  const dnevnik = opcije.log || console.error
  try {
    if (!String(ulaz?.tekst || '').trim()) {
      return { akcija: 'proslijedi', razlog: RAZLOG.NEMA_OCJENE, zapis: null }
    }
    const cfg = opcije.configPath ? loadIngestGateConfig(opcije.configPath) : loadIngestGateConfig()
    const nacin = nacinZaGrupu(cfg, ulaz.chatId)
    if (nacin === 'off') {
      return { akcija: 'proslijedi', razlog: RAZLOG.NIJE_UZIVO, zapis: null }
    }

    // Mjerenje teče i u položaju `on` — v. uvodni komentar.
    // TASK-5161: zadnji zapisi iste grupe su kontekst za „nastavak posla" (ocjena v2).
    const logPath = opcije.logPath || INGEST_SHADOW_LOG_PATH
    const zapis = procijeniUlaz(ulaz, cfg, { prethodni: zadnjiZapisiGrupe(ulaz.chatId, logPath) })
    zapisiSjenu(zapis, logPath)

    // ── W1/TASK-4614: DRUGI ULAZ ZA ODABIR TIJEKA ────────────────────────────
    // Nalog traži odabir tijeka na OBA ulaza: „POST /api/tasks I ulazni kanal". Ploču
    // pokriva `TaskWebUI.handleCreateTask` (W0); ovo je kanal.
    //
    // ZAŠTO JE OVAJ ULAZ VRJEDNIJI OD PLOČE ZA MJERENJE: ploča pri otvaranju zadatka nema
    // težinu pa je procjenjuje iz teksta, i kratka specifikacija ispadne iz tijeka prije
    // nego ju je itko odbio (nalaz iz plana §6.1). Kanal ima IZMJERENU težinu
    // (`ModeClassifier` + `WeightScore`), pa se ovdje prvi put vidi bi li odluka bila
    // druga da se težina ne pogađa. Zato ide `tezina: zapis.tezina`, a ne procjena.
    //
    // ZAŠTO SAMO IZNAD PRAGA A: ploča bilježi samo zadatke koji su STVARNO nastali, pa
    // kanal mora bilježiti samo poruke koje bi postale posao. Bilježiti „bok" kao
    // „bez tijeka" napuhalo bi nazivnik pozdravima i mjerilo bi ispalo bolje/gore od
    // istine ovisno o tome koliko je toga dana bilo ćaskanja.
    //
    // Ovo je JEDAN `stat` i JEDAN `append` na vrućem putu svake poruke; `mozdaZapisiOdluku`
    // nikad ne baca, a i da baci, obuhvaća ga `catch` ispod koji vraća `proslijedi`.
    if (zapis.biOtvorioZadatak) {
      mozdaZapisiOdluku({
        taskId: null,                 // zadatak još ne postoji — kanal odlučuje prije njega
        naslov: zapis.poruka,
        opis: '',
        tezina: zapis.tezina,         // izmjerena, ne procijenjena
        projectId: zapis.projekt,
        izvor: 'ulaz',
      }, { log: dnevnik, ...(opcije.workflowOpcije || {}) })
    }

    const odluka = odluciUlaz({
      nacin,
      zapis,
      senderId: ulaz.senderId,
      pauzirano: (opcije.pauzirano || (() => rucnaKocnicaPovucena(opcije.pauseFile)))(),
      daemonZiv: (opcije.daemonZiv || (() => daemonRadi(opcije.pidFile)))(),
    })
    if (odluka.akcija === 'zadatak') {
      dnevnik(`[INGEST-UŽIVO] ${ulaz.grupa}: ${odluka.razlog}`)
    }
    return odluka
  } catch (e: any) {
    try { dnevnik(`[INGEST-UŽIVO] vrata preskočena: ${e?.message || e}`) } catch { /* ni dnevnik ne ruši most */ }
    return { akcija: 'proslijedi', razlog: RAZLOG.KVAR, zapis: null }
  }
}
