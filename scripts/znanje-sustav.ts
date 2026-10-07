#!/usr/bin/env bun
/**
 * Generator općeg korpusa sustava (ADR-0006 §5.1) — radi na stroju koji ima IZVORNU kartu sustava
 * (privatnu), a u paket piše samo opći izlaz: `znanje/sustav/*.md` + `znanje/MANIFEST.sha256`.
 *
 *   bun scripts/znanje-sustav.ts gradi --karta <docs/system-map> --privatno <popis> [--opseg <tsv>]
 *                                      [--izlaz znanje/sustav] [--tudi-home <HOME izvora>] [--suho]
 *
 * Tablica opsega (`--opseg`, zadano `<karta>/opseg.tsv`) i privatni popis žive UZ izvor, nikad u
 * paketu: i naslovi privatnih odjeljaka i popis imena su naš podatak. Odjeljak bez retka u
 * tablici = privatno (bijela lista, §4.3/1).
 *
 * Izlazni kodovi: 0 napisano (ili suho) · 2 neispravan ulaz · 5 BRANA — pogodak u izlazu, ništa
 * nije napisano (isti obrazac kao brana tajni u gradnji kompleta).
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { BranaPrivatnog, gradiDokument, ucitajOpseg, ucitajPrivatno } from '../src/znanje/Korpus'

const KORIJEN = join(import.meta.dir, '..')

interface Opcije { karta: string; privatno: string; opseg?: string; izlaz: string; tudiHome?: string; suho: boolean }

function opcije(argv: string[]): Opcije {
  const [naredba, ...ost] = argv
  if (naredba !== 'gradi') throw new Error('naredba: gradi')
  const o: Partial<Opcije> = { izlaz: join(KORIJEN, 'znanje', 'sustav'), suho: false, tudiHome: process.env.HOME }
  for (let i = 0; i < ost.length; i++) {
    const a = ost[i]
    if (a === '--suho') o.suho = true
    else if (['--karta', '--privatno', '--opseg', '--izlaz', '--tudi-home'].includes(a)) {
      const v = ost[++i]
      if (!v) throw new Error(`${a} traži vrijednost`)
      const k = a.slice(2).replace('tudi-home', 'tudiHome') as keyof Opcije
      ;(o as any)[k] = v
    } else throw new Error(`nepoznata zastavica ${a}`)
  }
  if (!o.karta || !o.privatno) throw new Error('obavezno: --karta i --privatno')
  return o as Opcije
}

/** Ručni sloj + generirani `popis/` (relativna imena kao u tablici opsega). */
function izvori(karta: string): string[] {
  const rucni = readdirSync(karta).filter(f => f.endsWith('.md')).sort()
  const popis = existsSync(join(karta, 'popis')) ? readdirSync(join(karta, 'popis')).filter(f => f.endsWith('.md')).sort().map(f => `popis/${f}`) : []
  return [...rucni, ...popis]
}

/** Generirani sloj nosi retke o generatoru i otisku — u banci postaju meta-činjenice, pa van. */
function bezGeneratorskihRedaka(t: string): string {
  return t.split('\n').filter(r => !r.startsWith('> GENERIRANO') && !r.startsWith('**Izvor:**') && !r.startsWith('**Vidljivost:** tajni agent')).join('\n')
}

/**
 * Ručni sloj karte nosi i stanje NAŠEG pogona u trenutku pisanja — na čvoru je to krivo, pa van:
 *   - meta-redak `**Provjereno:** … **Izvor:** …` (redci koda glavnog stroja, datumi provjere);
 *   - rečenica „Dana <datum> …" (izmjereno stanje: PID, broj zadataka, položaj prekidača);
 *   - oznake naših zadataka `TASK-n` (ploča čvora ima svoje TASK-ove — isti sudar kao PRJ-, §1.4).
 */
export function ocistiIzvor(t: string): string {
  return t.split('\n')
    .filter(r => !/^\*\*Provjereno:\*\*/.test(r))
    .map(r => r
      .replace(/(^|(?<=[.!?:]\s))Dana \d{1,2}\.\s?\d{1,2}\.\s?\d{4}\.[^.!?]*(?:\.\d[^.!?]*)*[.!?](\s|$)/g, '$1')
      .replace(/\s*\((?:[^()]*?[,;]\s*)?TASK-\d{3,}(?:[^()]*)\)/g, '')
      .replace(/,?\s*\bTASK-\d{3,}\b/g, '')
      .replace(/[ \t]+$/, ''))
    .join('\n')
}

const izlaznoIme = (rel: string) => rel.replace(/^popis\//, 'popis-')

export function glavna(argv: string[], ispis: (r: string) => void = console.log): number {
  let o: Opcije
  try { o = opcije(argv) } catch (e: any) { ispis(`ODBIJENO: ${e.message}`); return 2 }
  const opsegPut = o.opseg || join(o.karta, 'opseg.tsv')
  if (!existsSync(opsegPut) || !existsSync(o.privatno)) { ispis(`ODBIJENO: nema ${existsSync(opsegPut) ? o.privatno : opsegPut}`); return 2 }
  const opsegZa = ucitajOpseg(readFileSync(opsegPut, 'utf-8'))
  const privatno = ucitajPrivatno(readFileSync(o.privatno, 'utf-8'))

  const izlaz: Array<[string, string]> = []
  const brane: BranaPrivatnog[] = []
  let odjUkupno = 0, odjUkljuceno = 0, redigirano = 0
  for (const rel of izvori(o.karta)) {
    let t = readFileSync(join(o.karta, rel), 'utf-8')
    t = ocistiIzvor(rel.startsWith('popis/') ? bezGeneratorskihRedaka(t) : t)
    try {
      const r = gradiDokument(rel, t, opsegZa, privatno, { tudiHome: o.tudiHome })
      odjUkupno += r.ukljuceno.length + r.izbaceno.length
      odjUkljuceno += r.ukljuceno.length
      redigirano += r.redigirano
      if (r.sadrzaj) izlaz.push([izlaznoIme(rel), r.sadrzaj])
    } catch (e) {
      if (!(e instanceof BranaPrivatnog)) throw e
      brane.push(e) // skupi sve pogotke pa javi odjednom — popravak ide jednim prolazom
    }
  }
  if (brane.length) {
    for (const e of brane) ispis(`BRANA: ${e.datoteka} § „${e.odjeljak}" — ${e.pogoci.map(p => p.kat).join(', ')}`)
    ispis(`ništa nije napisano (${brane.length} odjeljaka) → odjeljak razdvoji na izvoru, označi ga \`+redigiraj\` ili \`privatno\` u tablici opsega`)
    return 5
  }

  const manifest = izlaz.map(([ime, s]) => `${createHash('sha256').update(s).digest('hex')}  sustav/${ime}`).join('\n') + '\n'
  ispis(`korpus: ${izlaz.length} dokumenata, odjeljaka ${odjUkljuceno}/${odjUkupno}, redigirano jedinica ${redigirano}, `
    + `${izlaz.reduce((n, [, s]) => n + Buffer.byteLength(s), 0)} B`)
  if (o.suho) { ispis('SUHO: ništa nije napisano'); return 0 }

  const izl = resolve(o.izlaz)
  rmSync(izl, { recursive: true, force: true })
  mkdirSync(izl, { recursive: true })
  for (const [ime, s] of izlaz) writeFileSync(join(izl, ime), s)
  writeFileSync(join(izl, '..', 'MANIFEST.sha256'), manifest)
  ispis(`napisano u ${relative(process.cwd(), izl) || izl} + MANIFEST.sha256`)
  return 0
}

if (import.meta.main) process.exit(glavna(process.argv.slice(2)))
