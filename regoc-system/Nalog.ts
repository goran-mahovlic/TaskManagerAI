/**
 * Nalog → tijek → koraci (TASK-5159, dizajn TASK-5158 §2).
 *
 * ZAŠTO: na razini pojedinog zadatka tijek se praktički nikad ne bira — svaki korak koji
 * REGOČ otvori s pravom je `u-lancu` (nalaz N2). Odluka se zato donosi tamo gdje nalog još
 * postoji kao cjelina: REGOČ predaje Goranov nalog (`POST /api/nalozi`), sustav bira tijek
 * istim `odaberiTijek()` (bez novog pravila) i vraća korake s gotovim oznakama i opisom
 * (predložak, `TaskBrief`). REGOČ ih otvara; ručno slaganje samo uz upisano `odstupanje`.
 *
 * Ovaj modul NE otvara zadatke (to je `materijalizacija`, zaseban prekidač koji ostaje
 * Goranov). Zapisuje samo nalog (`data/nalozi.jsonl`) i odluku (`workflow_odluke.jsonl`,
 * `izvor: "nalog"`), pa mjerilo `workflow-odluke-mjera.ts` prvi put mjeri pravu razinu.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { isTestRuntime, realHomedir } from './LiveDbGuard'
import { odaberiTijek, mozdaZapisiOdluku, procijeniTezinu, type Katalog, type Korak, type VrataOpcije } from './WorkflowGate'
import { gradiPredlozak, obvezneVjestine, type BriefToolkit } from './TaskBrief'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

export const NALOZI_LOG_PATH = process.env.REGOC_NALOZI_LOG || join(HOME, '.claude/regoc/data/nalozi.jsonl')
export const LIVE_NALOZI_LOG_PATH = join(realHomedir(), '.claude/regoc/data/nalozi.jsonl')
export const NALOG_TEKST_MAX = 4000
/**
 * TASK-5200/N3: najmanja težina NALOGA kad REGOČ ne pošalje `tezina`. Nalog je Goranova
 * cjelina („Napravi ponudu u PDF-u” = istraživanje + dizajn + izrada + QA), a `procijeniTezinu`
 * mjeri duljinu rečenice: kratki nalog dobije 10–15 i ispadne `prelagan` (bez tijeka, PDF
 * ponuda ode Mandi). 40 = razina E3, iznad praga 36 (izrada, značajka, istraživanje) i 16
 * (kvar); tijekovi s pragom 61 i dalje traže izričitu težinu. Izričita `tezina` pobjeđuje.
 * Odluka: docs/DIZAJN-kontekst-zadatka-i-tijek.md, „Odluka N3”.
 */
export const NALOG_ZADANA_TEZINA = 40

export interface NalogUlaz {
  tekst: string
  naslov?: string | null
  chatId?: string | number | null
  projectId?: string | null
  tezina?: number | null
  /** Čovjekova riječ: izričit tijek (≙ oznaka `workflow:<id>`). */
  workflow?: string | null
  /** Čovjekova riječ: bez tijeka (≙ oznaka `bez-workflowa`). */
  bezWorkflowa?: boolean
  /** Zadatak koji se dorađuje — izvor izvršitelja koraka `agent: "izvorni"`. */
  doradaOd?: string | null
  /** REGOČ odstupa od predloženih koraka — ručni ispravak koji mjerilo broji. */
  odstupanje?: string | null
  kriteriji?: string[] | null
  provjera?: string | null
  by?: string | null
}

export interface NalogKorak {
  n: number
  ukupno: number
  agent: string
  uloga: string
  vjestina: string | null
  mehanizam: string | null
  naslovPrijedlog: string
  oznake: string[]
  opis: string
  upozorenja: string[]
}

export interface NalogOdluka { workflow: string | null; kod: string; razlog: string; tezina: number }

export interface NalogOdgovor {
  nalogId: string
  odluka: NalogOdluka
  koraci: NalogKorak[]
  materijalizirano: false
  lanac: string[]
  upozorenja: string[]
}

export interface NalogDeps {
  katalog: Katalog
  /** Izvršitelj za jednostruki put (bez tijeka): `AgentSelection.odaberiAgenta()`. */
  odaberiIzvrsitelja?: (naslov: string, tekst: string) => { agent: string; razlog: string } | null
  /** Zadatak s ploče (za `doradaOd` → izvorni izvršitelj). */
  getTask?: (id: string) => { assignee?: string | null; title?: string | null } | null | undefined
  toolkitZa?: (agent: string, naslov: string, tekst: string) => BriefToolkit | null
  vjestinaPostoji?: (ime: string) => boolean
  logPath?: string
  /** Opcije vrata (dnevnik odluka, konfiguracija) — testovi preusmjeravaju. */
  vrata?: VrataOpcije
  sada?: () => Date
}

const veliko = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s

export function naslovIzTeksta(tekst: string, max = 120): string {
  const prvi = String(tekst || '').split('\n').map(x => x.trim()).find(Boolean) || '(nalog bez teksta)'
  return prvi.length > max ? prvi.slice(0, max - 1).trimEnd() + '…' : prvi
}

function smijePisati(put: string): boolean {
  if (!isTestRuntime()) return true
  return resolve(put) !== resolve(LIVE_NALOZI_LOG_PATH)
}

export function citajNaloge(put: string = NALOZI_LOG_PATH): any[] {
  try {
    if (!existsSync(put)) return []
    return readFileSync(put, 'utf-8').split('\n').filter(Boolean).map(r => { try { return JSON.parse(r) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/** Sljedeći `NAL-NNNN`. Jedan pisac (ploča), pa je brojanje redaka dovoljno. */
export function sljedeciNalogId(put: string = NALOZI_LOG_PATH): string {
  let max = 0
  for (const r of citajNaloge(put)) {
    const m = String(r?.nalogId || '').match(/^NAL-(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `NAL-${String(max + 1).padStart(4, '0')}`
}

/** Zadnje stanje naloga (zapis + dopisana odstupanja). */
export function dohvatiNalog(id: string, put: string = NALOZI_LOG_PATH): any | null {
  let nalog: any = null
  const odstupanja: any[] = []
  for (const r of citajNaloge(put)) {
    if (r?.nalogId !== id) continue
    if (r.vrsta === 'odstupanje') odstupanja.push({ razlog: r.odstupanje, by: r.by ?? null, ts: r.ts })
    else nalog = r
  }
  if (!nalog) return null
  return { ...nalog, odstupanja: [...(nalog.odstupanje ? [{ razlog: nalog.odstupanje, by: nalog.by ?? null, ts: nalog.ts }] : []), ...odstupanja] }
}

function dopisi(zapis: unknown, put: string): void {
  if (!smijePisati(put)) throw new Error(`test-proces ne smije pisati u živi dnevnik naloga (${put})`)
  if (!existsSync(dirname(put))) mkdirSync(dirname(put), { recursive: true })
  appendFileSync(put, JSON.stringify(zapis) + '\n', 'utf-8')
}

export function zapisiOdstupanje(id: string, razlog: string, by: string | null, put: string = NALOZI_LOG_PATH): boolean {
  if (!dohvatiNalog(id, put)) return false
  dopisi({ ts: new Date().toISOString(), vrsta: 'odstupanje', nalogId: id, odstupanje: String(razlog).slice(0, 500), by }, put)
  return true
}

/**
 * Glavna funkcija ulaza. Validacija tijela je kod pozivatelja (ploče); ovdje se samo odlučuje,
 * slaže i zapisuje. Baca samo na nemogućem zapisu (pozivatelj vraća 500).
 */
export function obradiNalog(u: NalogUlaz, d: NalogDeps): NalogOdgovor {
  const tekst = String(u.tekst || '').slice(0, NALOG_TEKST_MAX)
  const naslov = String(u.naslov || '').trim() || naslovIzTeksta(tekst)
  const put = d.logPath || NALOZI_LOG_PATH
  const nalogId = sljedeciNalogId(put)
  const chat = u.chatId !== undefined && u.chatId !== null && String(u.chatId).trim() ? `chat:${String(u.chatId).trim()}` : null
  const oznakeNaloga = [
    ...(u.bezWorkflowa ? ['bez-workflowa'] : []),
    ...(u.workflow ? [`workflow:${String(u.workflow).trim()}`] : []),
    ...(chat ? [chat] : []),
  ]
  const upozorenja: string[] = []

  // Odluka: isto pravilo kao na ploči i kanalu. Zapis ide kroz vrata (poštuje `off`);
  // kad su vrata ugašena, odluka se ipak izračuna za odgovor, ali se ne bilježi.
  const izricita = typeof u.tezina === 'number' && Number.isFinite(u.tezina)
  let tezina: number | null = izricita ? (u.tezina as number) : null
  if (!izricita) {
    const procjena = procijeniTezinu(`${naslov}\n${tekst}`)
    tezina = Math.max(procjena, NALOG_ZADANA_TEZINA)
    upozorenja.push(`težina nije poslana — procjena ${procjena}, nalog dobiva najmanje ${NALOG_ZADANA_TEZINA} (NALOG_ZADANA_TEZINA); za prag 61 pošalji \`tezina\``)
  }
  const ulazOdluke = { naslov, opis: tekst, tezina, oznake: oznakeNaloga, projectId: u.projectId ?? null, izvor: 'nalog' as const }
  const zapisVrata = mozdaZapisiOdluku(ulazOdluke, d.vrata || {})
  const izracun = odaberiTijek(ulazOdluke, d.katalog)
  const odluka: NalogOdluka = zapisVrata
    ? { workflow: zapisVrata.workflow, kod: zapisVrata.kod, razlog: zapisVrata.razlog, tezina: zapisVrata.tezina }
    : { workflow: izracun.workflow, kod: izracun.kod, razlog: izracun.razlog, tezina: izracun.tezina }
  if (!zapisVrata) upozorenja.push('vrata tijekova su ugašena (nacin: off) — odluka nije zapisana u workflow_odluke.jsonl')

  const tijek = odluka.workflow ? d.katalog.workflows[odluka.workflow] : null
  const koraciDef: Korak[] = (tijek?.koraci || []).filter(k => k && String(k.agent || '').trim())
  const zajednicke = [`nalog:${nalogId}`, ...(chat ? [chat] : [])]
  const koraci: NalogKorak[] = []

  if (tijek && koraciDef.length) {
    const ukupno = koraciDef.length
    koraciDef.forEach((k, i) => {
      const n = i + 1
      const upoz: string[] = []
      let agent = String(k.agent).trim()
      if (agent === 'izvorni') {
        const izv = u.doradaOd && d.getTask ? d.getTask(String(u.doradaOd).toUpperCase()) : null
        if (izv?.assignee) agent = String(izv.assignee)
        else upoz.push('izvorni izvršitelj nepoznat — pošalji `doradaOd: <TASK-ID>` ili izaberi po zamjeni koraka')
      }
      const mehanizam = (k as any).mehanizam ? String((k as any).mehanizam) : null
      const obvezne = obvezneVjestine({ korakVjestina: k.vjestina, uloga: k.uloga, tekst: `${naslov}\n${tekst}`, vjestinaPostoji: d.vjestinaPostoji })
      const oznake = [
        `workflow:${odluka.workflow}`, `korak:${n}/${ukupno}`,
        ...obvezne.map(v => `vjestina:${v}`),
        ...(u.doradaOd ? [`dorada-od:${String(u.doradaOd).toUpperCase()}`] : []),
        ...(mehanizam === 'report-back' ? ['report-back', 'no-autonomy'] : []),
        ...zajednicke,
      ]
      const naslovPrijedlog = `${veliko(agent)}: ${naslov}`.slice(0, 200)
      const brief = gradiPredlozak({
        zadatak: { naslov: naslovPrijedlog, opis: '', assignee: agent, oznake, projectId: u.projectId ?? null, tezina: odluka.tezina },
        nalog: { id: nalogId, tekst },
        odluka: { workflow: odluka.workflow, kod: odluka.kod, razlog: odluka.razlog },
        katalog: d.katalog,
        toolkit: d.toolkitZa ? d.toolkitZa(agent, naslovPrijedlog, tekst) : null,
        kriteriji: u.kriteriji ?? null,
        provjera: mehanizam ? null : (u.provjera ?? null),
        vjestinaPostoji: d.vjestinaPostoji,
      })
      koraci.push({
        n, ukupno, agent, uloga: String(k.uloga || 'korak'), vjestina: obvezne[0] || null, mehanizam,
        naslovPrijedlog, oznake: [...new Set([...oznake, ...brief.oznake])], opis: brief.blok,
        upozorenja: [...upoz, ...(mehanizam === 'report-back' ? [] : brief.upozorenja)],
      })
    })
  } else {
    // Jednostruki put: tijek „postoji” i za posao jedne struke — izvršitelj + razlog.
    const izbor = d.odaberiIzvrsitelja ? d.odaberiIzvrsitelja(naslov, tekst) : null
    const agent = izbor?.agent || 'jelena'
    if (!izbor) upozorenja.push('odabir izvršitelja nedostupan — zadano jelena')
    const oznake = [...(u.bezWorkflowa ? ['bez-workflowa'] : []), ...zajednicke]
    const naslovPrijedlog = `${veliko(agent)}: ${naslov}`.slice(0, 200)
    const brief = gradiPredlozak({
      zadatak: { naslov: naslovPrijedlog, opis: '', assignee: agent, oznake, projectId: u.projectId ?? null, tezina: odluka.tezina },
      nalog: { id: nalogId, tekst },
      odluka: { workflow: null, kod: odluka.kod, razlog: odluka.razlog },
      katalog: d.katalog,
      toolkit: d.toolkitZa ? d.toolkitZa(agent, naslovPrijedlog, tekst) : null,
      kriteriji: u.kriteriji ?? null, provjera: u.provjera ?? null,
      vjestinaPostoji: d.vjestinaPostoji,
    })
    koraci.push({
      n: 1, ukupno: 1, agent, uloga: 'izvrsitelj', vjestina: null, mehanizam: null, naslovPrijedlog,
      oznake: [...new Set([...oznake, ...brief.oznake])], opis: brief.blok,
      upozorenja: [...(izbor?.razlog ? [`izvršitelj: ${izbor.razlog}`] : []), ...brief.upozorenja],
    })
  }

  dopisi({
    ts: (d.sada ? d.sada() : new Date()).toISOString(), vrsta: 'nalog', nalogId,
    naslov, tekst: tekst.slice(0, 1500), chatId: u.chatId ?? null, projectId: u.projectId ?? null,
    workflow: odluka.workflow, kod: odluka.kod, razlog: odluka.razlog, tezina: odluka.tezina,
    koraci: koraci.map(k => ({ n: k.n, agent: k.agent, uloga: k.uloga, vjestina: k.vjestina, mehanizam: k.mehanizam })),
    doradaOd: u.doradaOd ?? null, odstupanje: u.odstupanje ?? null, by: u.by ?? null,
  }, put)

  return { nalogId, odluka, koraci, materijalizirano: false, lanac: [], upozorenja }
}
