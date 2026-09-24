#!/usr/bin/env bun
/**
 * ModelConfigWriter — JEDINI put kojim se `model-config.json` smije mijenjati (TASK-4894).
 *
 * KVAR KOJI ZATVARA (pad 16.09.2026., pitanje vlasnika „zašto se modeli resetiraju?"):
 * konfiguraciju su mijenjala TRI mjesta u `TaskWebUI.ts` (postavljanje davatelja,
 * postavljanje modela po agentu, uključivanje davatelja s ploče), svako svojim
 * `JSON.parse → mutiraj → writeFileSync`. Posljedice su bile mjerljive:
 *
 *   1. UPIS NIJE BIO ATOMAN. `writeFileSync` preko žive datoteke znači da pad ili dva
 *      istovremena spremanja ostave krnji JSON. `resolveAgentTarget` takav JSON hvata
 *      s `catch {}` i TIHO vraća registarski alias — svih 11 agenata odjednom padne na
 *      „newest" (Claude 5) i nitko ne vidi zašto. Točno simptom „modeli su se resetirali".
 *   2. NIJE BILO TRAGA. Datoteka nije u gitu (konfiguracija nije u repozitoriju), pa na pitanje
 *      „tko je ovo promijenio" nije postojao nijedan izvor osim posrednog dokaza iz
 *      `daemon.log` (`[MODEL-OVERRIDE] <agent> → anthropic:opus`). Sada svaki upis ostavlja
 *      redak u `model-config.audit.jsonl`: tko, kada, koji ključ, prije → poslije.
 *
 * Zapis se piše SAMO kad se vrijednost stvarno promijenila — trag koji bilježi i
 * ne-promjene prestaje se čitati.
 *
 * Izvorno: TASK-4894 (arhitektura) · 2026-09-16
 */
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'

/** Ime revizijskog traga; leži uz samu konfiguraciju. */
export const AUDIT_FILE_NAME = 'model-config.audit.jsonl'

/** Ključevi čije promjene pratimo — ono po čemu se agent stvarno rutira. */
const PRACENI_ODJELJCI = ['agentOverrides', 'componentOverrides', 'defaults'] as const

export interface PromjenaModela {
  kljuc: string
  prije: string | null
  poslije: string | null
}

export interface AuditZapis {
  ts: string
  tko: string
  promjene: PromjenaModela[]
}

/** Sve `odjeljak.kljuc → vrijednost` parove, preskačući `_`-komentare. */
function spljosti(mc: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const odjeljak of PRACENI_ODJELJCI) {
    const blok = mc?.[odjeljak]
    if (!blok || typeof blok !== 'object') continue
    for (const [k, v] of Object.entries(blok)) {
      if (k.startsWith('_')) continue        // komentari i primjeri iz datoteke
      if (typeof v !== 'string') continue
      out[`${odjeljak}.${k}`] = v
    }
  }
  return out
}

function razlika(prije: Record<string, string>, poslije: Record<string, string>): PromjenaModela[] {
  const kljucevi = new Set([...Object.keys(prije), ...Object.keys(poslije)])
  const promjene: PromjenaModela[] = []
  for (const k of [...kljucevi].sort()) {
    const a = prije[k] ?? null
    const b = poslije[k] ?? null
    if (a !== b) promjene.push({ kljuc: k, prije: a, poslije: b })
  }
  return promjene
}

/**
 * Pročitaj konfiguraciju, primijeni `mutiraj`, spremi ATOMNO i zabilježi promjenu.
 *
 * Atomnost: piše se u `<path>.tmp-<pid>-<ts>` pa `rename` — na istom datotečnom sustavu
 * `rename` je atoman, pa čitatelj vidi ili staru ili novu datoteku, nikad polovicu.
 * Ako `mutiraj` baci grešku, datoteka na disku ostaje netaknuta i trag se ne piše.
 *
 * @param path    putanja do model-config.json
 * @param mutiraj izmjena nad razparsiranim objektom (mijenja ga na mjestu)
 * @param tko     tko mijenja — npr. 'ploca:model-agenta', 'ploca:davatelj'
 * @returns       popis stvarnih promjena (prazan ako se ništa nije promijenilo)
 */
export function saveModelConfig(
  path: string,
  mutiraj: (mc: any) => void,
  tko: string,
): PromjenaModela[] {
  const mc = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}
  const prije = spljosti(mc)

  mutiraj(mc)   // greška ovdje = izlaz prije ijednog upisa na disk

  const poslije = spljosti(mc)
  const promjene = razlika(prije, poslije)

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, JSON.stringify(mc, null, 2) + '\n')
    renameSync(tmp, path)
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
    throw e
  }

  if (promjene.length > 0) {
    const zapis: AuditZapis = { ts: new Date().toISOString(), tko, promjene }
    try { appendFileSync(join(dirname(path), AUDIT_FILE_NAME), JSON.stringify(zapis) + '\n') } catch {}
  }
  return promjene
}
