#!/usr/bin/env bun
/**
 * Profil čvora — izvezi / provjeri / primijeni (ADR-0004 §5).
 *
 *   bun scripts/profil-cvora.ts provjeri  [--profil upravitelj-cvora] [--instanca <env>] [--json]
 *   bun scripts/profil-cvora.ts primijeni [--profil …] [--instanca …] [--modul a,b] (--suho | --pisi)
 *   bun scripts/profil-cvora.ts izvezi    [--profil …] --instanca-van <env>
 *
 * Ostale zastavice: `--paket <mapa>` (paket na čvoru; zadano ovaj paket), `--ssh <korisnik@stroj>`
 * (tuđi čvor, SAMO čitanje: sakupljač ide preko SSH standardnog ulaza, na čvoru ne nastaje ništa),
 * `--ploca <url>` (API ploče za `--pisi`), `--bez-sustava` (bez systemd/vrata/verzija alata).
 *
 * Pravila 1–9 iz ADR-a ukratko: bijela lista; tajna samo postoji/nema; `provjeri` i `--suho` ne
 * mijenjaju ništa (baza `mode=ro`); bez `--pisi` nema pisanja; postavke ploče samo kroz API
 * (`changedBy=profil-cvora`); kopija prije pisanja datoteke; `ovlasti=puno` samo uz čovjekov
 * `TM_RAZGOVOR_PUNO=1`; capguard samo zahtjev `pending`; ploču i daemon alat ne restarta.
 *
 * Izlazni kodovi: 0 sve OK · 1 razlike koje alat zna primijeniti · 2 nedostaju tajne ili ljudske
 * stavke · 3 preduvjet pao (kod bez značajke, profil/instanca neispravni) · 4 alat odbio.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { z } from 'zod'
import { RAZGOVOR_KLJUCEVI, RAZGOVOR_ZADANO } from '../src/razgovor/RazgovorPostavke'
import { citajEnv, prikupiStanje, putanja, type SpecStanja, type StanjeCvora } from './profil-cvora-stanje'

export const KORIJEN = join(import.meta.dir, '..')
export const KOD = { OK: 0, RAZLIKA: 1, LJUDI: 2, PREDUVJET: 3, ODBIJENO: 4 } as const
export const AUTOR = 'profil-cvora'

// ─── Shema profila (J1) ──────────────────────────────────────────────────────

const Vrijednost: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Vrijednost), z.record(z.string(), Vrijednost)]))
const Postavke = z.record(z.string().regex(/^[a-zA-Z][\w.]*$/, 'ključ postavke'), Vrijednost)
const Imena = z.array(z.string().min(1))
const s = z.object({ vlasnik: z.string().min(1) }).passthrough()

export const Znacajka = z.object({
  on: z.boolean(),
  odluka: z.enum(['paket', 'uvjetno', 'van']),
  razlog: z.string().optional(),
  /** Prekidač koji ni glavni sustav nema u kodu (sjena bez potrošača) — ne traži se u kodu čvora. */
  bezKoda: z.boolean().optional(),
}).refine(x => x.odluka !== 'van' || !x.on, 'odluka „van" traži on=false')

const Kuka = z.object({
  paket: z.string().min(1),
  dogadjaj: z.string().min(1),
  ime: z.string().min(1),
  matcher: z.string().min(1).optional(),
  naredba: z.string().min(1),
  /** Datoteka koju naredba pokreće — bez nje se kuka ne spaja (NEDOSTAJE). */
  datoteka: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  razlog: z.string().optional(),
})

export const ProfilShema = z.object({
  profil: z.string().min(1),
  verzija: z.number().int().positive(),
  instanca: z.object({ obavezno: Imena, neobavezno: Imena }),
  moduli: z.object({
    paket: s.extend({
      paketSadrzi: z.array(z.object({
        znacajka: z.string().min(1),
        datoteka: z.string().min(1).optional(),
        grep: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
      }).refine(z0 => !!z0.datoteka !== !!z0.grep, 'treba točno jedno: datoteka ili grep')),
      alati: z.record(z.string(), z.string().regex(/^>=\d+(\.\d+)*$/)).optional(),
      unit: z.object({ ime: z.string().min(1), aktivan: z.boolean() }).passthrough().optional(),
      izvorniSustavSadrzi: z.object({
        mapa: z.string().min(1),
        datoteke: Imena,
        grep: z.array(z.object({ znacajka: z.string().min(1), datoteka: z.string().min(1), sadrzi: z.string().min(1) })).default([]),
      }).passthrough().optional(),
    }).optional(),
    okolina: s.extend({
      postavkeEnv: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()),
      nesmijeBiti: Imena.default([]),
      tajneImenom: Imena.default([]),
    }).optional(),
    telegram: s.extend({
      datoteka: z.string().min(1),
      json: z.record(z.string(), Vrijednost),
      nikadNeIzvozi: Imena.default([]),
      tajneImenom: Imena.default([]),
    }).optional(),
    // TASK-5358: provjera e-pošte s obaviješću u grupu čvora — samo prekidači, nikad tajne ni host.
    eposta: s.extend({
      datoteka: z.string().min(1),
      ruta: z.string().regex(/^\/api\//).default('/api/email/config'),
      json: z.record(z.string(), Vrijednost),
    }).optional(),
    razgovor: s.extend({ settings: Postavke }).optional(),
    glas: s.extend({
      settings: Postavke,
      servis: z.object({ unit: z.string().min(1), vrata: z.number().int() }).passthrough().optional(),
    }).optional(),
    memorija: s.extend({
      settings: Postavke,
      izolacija: z.object({ zabranjeniDokumenti: Imena }).passthrough().optional(),
    }).optional(),
    // TASK-5331 (ADR-0006 §9): mogućnosti čvora i znanje u banci; putanje su relativne na $TM_HOME, naredbe na paket.
    mogucnosti: s.extend({ datoteka: z.string().min(1), maxStarostSati: z.number().positive(), naredba: Imena }).optional(),
    znanje: s.extend({
      korpus: z.string().min(1), stanje: z.string().min(1), maxStarostSati: z.number().positive(), naredba: Imena,
      timer: z.object({ unit: z.string().regex(/^[\w-]+$/), minuta: z.number().int().positive() }),
    }).optional(),
    'tunel-memorije': s.extend({ provjeraNaCvoru: z.object({ vrata: z.number().int() }).passthrough() }).optional(),
    'bot-kanal': s.extend({
      settings: Postavke, nikadNeIzvozi: Imena.default([]), tajneImenom: Imena.default([]),
    }).optional(),
    capguard: s.extend({ zeljeno: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.boolean()) }).optional(),
    claude: s.extend({
      settingsJson: z.object({ datoteka: z.string().min(1), hooks: z.record(z.string(), z.array(Vrijednost)) }),
      kuke: z.array(z.object({ datoteka: z.string().min(1), sha256: z.string() }).passthrough()).default([]),
    }).optional(),
    upravitelj: s.extend({ predlozak: z.string().min(1), cilj: z.string().min(1), najvise: z.number().int().positive() }).optional(),
    home: s.extend({ grepNema: z.object({ uzorak: z.string(), u: Imena }) }).optional(),
    rag: s.extend({ ukljucen: z.boolean() }).optional(),
    znacajke: s.extend({
      datoteka: z.string().min(1),
      kodU: Imena,
      instanca: z.object({ ukljuci: z.string(), iskljuci: z.string() }).optional(),
      kljucevi: z.record(z.string().regex(/^[a-zA-Z]\w*$/, 'ime prekidača'), Znacajka),
    }).optional(),
    kuke: s.extend({
      datoteka: z.string().min(1),
      paketi: z.string(),
      zadaniPaketi: Imena,
      popis: z.array(Kuka),
      van: z.record(z.string(), z.string()).optional(),
    }).optional(),
    konzola: s.extend({
      maxSati: z.number().positive(),
      izvori: z.array(z.object({
        ime: z.string().min(1), datoteka: z.string().min(1), unit: z.string().min(1).optional(),
        preskoci: z.string().optional(), puni: z.string().optional(),
      })),
    }).optional(),
    oporavak: s.extend({
      ukljuceni: Imena, iskljuceni: Imena, dnevnik: z.string().min(1), dnevnikMaxMin: z.number().positive(),
      // TASK-5308: zona procesa izvornog sustava (drop-in Environment=TZ=…) — v. vrijemeDropIn.
      tz: z.object({ vrijednost: z.string().min(1), unitovi: z.array(z.string().min(1)).min(1) }).optional(),
      // TASK-5364: PATH usluga s ~/.local/bin (claude, glas) — v. putDropIn.
      put: z.object({ vrijednost: z.string().min(1), unitovi: z.array(z.string().min(1)).min(1) }).optional(),
    }).optional(),
  }).strict(),
}).passthrough()

export type Profil = z.infer<typeof ProfilShema>

export class GreskaPreduvjeta extends Error {}
export class Odbijeno extends Error {}

export function ucitajProfil(put: string): Profil {
  let sirovo: unknown
  try { sirovo = JSON.parse(readFileSync(put, 'utf-8')) } catch (e: any) {
    throw new GreskaPreduvjeta(`profil ${put}: nije čitljiv JSON (${e?.message || e})`)
  }
  const r = ProfilShema.safeParse(sirovo)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new GreskaPreduvjeta(`profil neispravan — polje ${i.path.join('.') || '(korijen)'}: ${i.message}`)
  }
  return r.data
}

// ─── Instanca i supstitucija (J2) ────────────────────────────────────────────

const VAR = /\$\{(\w+)(:json)?\}/g
/** Varijable koje daje sam čvor, ne instanca (`TM_PAKET` = mapa paketa na čvoru). */
const UGRADENE = ['HOME', 'TM_PAKET']

export function varijableProfila(v: unknown, skup = new Set<string>()): Set<string> {
  if (typeof v === 'string') for (const m of v.matchAll(VAR)) skup.add(m[1])
  else if (Array.isArray(v)) v.forEach(x => varijableProfila(x, skup))
  else if (v && typeof v === 'object') Object.values(v).forEach(x => varijableProfila(x, skup))
  return skup
}

/** Nepoznata varijabla u profilu i nedostajuća obavezna u instanci → izlaz 3. */
export function provjeriVarijable(p: Profil, inst: Record<string, string> | null): void {
  const poznate = new Set([...p.instanca.obavezno, ...p.instanca.neobavezno, ...UGRADENE])
  const nepoznate = [...varijableProfila(p.moduli)].filter(x => !poznate.has(x))
  if (nepoznate.length) throw new GreskaPreduvjeta(`nepoznata varijabla u profilu: ${nepoznate.map(x => '${' + x + '}').join(', ')}`)
  if (!inst) return
  const nema = p.instanca.obavezno.filter(k => !(inst[k] || '').trim())
  if (nema.length) throw new GreskaPreduvjeta(`instanci nedostaje obavezna varijabla: ${nema.join(', ')}`)
}

/** Oznaka da vrijednost ovisi o praznoj neobaveznoj varijabli unutar složenog niza. */
export const PRESKOCI = Symbol('preskoci')

export function zamijeni(v: unknown, inst: Record<string, string>): unknown {
  if (typeof v === 'string') {
    const cijela = v.match(/^\$\{(\w+):json\}$/)
    if (cijela) {
      const s0 = (inst[cijela[1]] ?? '').trim()
      if (!s0) return []
      try { return JSON.parse(s0) } catch {
        throw new GreskaPreduvjeta(`instanca: ${cijela[1]} mora biti JSON (npr. ["a","b"])`)
      }
    }
    if (/^\$\{\w+\}$/.test(v)) return inst[v.slice(2, -1)] ?? ''
    let prazno = false
    const out = v.replace(VAR, (_m, ime, json) => {
      if (json) throw new GreskaPreduvjeta(`\${${ime}:json} smije stajati samo kao cijela vrijednost`)
      const x = inst[ime] ?? ''
      if (!x) prazno = true
      return x
    })
    return prazno ? PRESKOCI : out
  }
  if (Array.isArray(v)) return v.map(x => zamijeni(x, inst))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, zamijeni(x, inst)]))
  return v
}

// ─── Stavke usporedbe ────────────────────────────────────────────────────────

export type Vrsta = 'OK' | 'RAZLIKA' | 'NEDOSTAJE' | 'TAJNA' | 'TAJNA-NEDOSTAJE' | 'ČOVJEK' | 'PRESKOČENO' | 'PREDUVJET' | 'UPOZORENJE'

export type Primjena =
  | { vrsta: 'env'; kljuc: string; vrijednost: string | null }
  | { vrsta: 'telegram'; put: string[]; vrijednost: unknown }
  | { vrsta: 'eposta'; put: string[]; vrijednost: unknown }
  | { vrsta: 'settings'; kljuc: string; vrijednost: unknown }
  | { vrsta: 'capguard'; ime: string; desired: boolean }
  | { vrsta: 'hooks'; dogadjaj: string; unos: unknown }
  | { vrsta: 'upravitelj'; cilj: string; sadrzaj: string }
  | { vrsta: 'znacajka'; kljuc: string; enabled: boolean; razlog: string }
  | { vrsta: 'konzola'; unit: string; datoteka: string; sadrzaj: string; log: string }
  | { vrsta: 'dropin'; unit: string; datoteka: string; sadrzaj: string }
  | { vrsta: 'naredba'; argv: string[] }
  | { vrsta: 'timer'; unit: string; service: string; timer: string }

export interface Stavka {
  modul: string
  vrsta: Vrsta
  kljuc: string
  profil?: unknown
  cvor?: unknown
  poruka?: string
  primjena?: Primjena
}

const jednako = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Ravna lista listova JSON-a (polja su listovi). */
function ravno(o: unknown, put: string[] = []): Array<[string[], unknown]> {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    return Object.entries(o).flatMap(([k, v]) => ravno(v, [...put, k]))
  }
  return [[put, o]]
}

function dohvati(o: unknown, put: string[]): unknown {
  let x: any = o
  for (const k of put) { if (!x || typeof x !== 'object' || !(k in x)) return undefined; x = x[k] }
  return x
}

/** Vrijednost iz `settings` (uvijek niz u bazi) dekodirana prema tipu koji profil očekuje. */
export function dekodiraj(sirovo: string | undefined, ocekivano: unknown): unknown {
  if (sirovo === undefined) return undefined
  if (typeof ocekivano === 'boolean') return sirovo === 'true' ? true : sirovo === 'false' ? false : sirovo
  if (typeof ocekivano === 'number') return sirovo.trim() !== '' && Number.isFinite(Number(sirovo)) ? Number(sirovo) : sirovo
  if (ocekivano && typeof ocekivano === 'object') { try { return JSON.parse(sirovo) } catch { return sirovo } }
  return sirovo
}

/** Ruta API-ja ploče za ključ postavke (iz koda ovog paketa). `null` = ploča nema API za ključ. */
export interface ApiKljuc { ruta: string; polje: string }
export async function kartaApija(): Promise<{ karta: Map<string, ApiKljuc>; zadano: Map<string, unknown> }> {
  const karta = new Map<string, ApiKljuc>()
  const zadano = new Map<string, unknown>()
  for (const [polje, kljuc] of Object.entries(RAZGOVOR_KLJUCEVI)) {
    karta.set(kljuc, { ruta: '/api/config/razgovor', polje })
    zadano.set(kljuc, (RAZGOVOR_ZADANO as any)[polje])
  }
  // Kanal bot↔bot (ADR-0003) postoji tek od isporuke TASK-5290 — bez nje ključevi nemaju API.
  const bk = './../src/razgovor/BotKanalPostavke.ts'
  if (existsSync(join(import.meta.dir, bk))) {
    const m: any = await import(bk)
    for (const [polje, kljuc] of Object.entries<string>(m.BOT_KANAL_KLJUCEVI || {})) {
      karta.set(kljuc, { ruta: '/api/config/razgovor/bot-kanal', polje })
    }
  }
  return { karta, zadano }
}

export interface Kontekst {
  profil: Profil
  inst: Record<string, string>
  stanje: StanjeCvora
  karta: Map<string, ApiKljuc>
  zadano: Map<string, unknown>
  korijen: string
  hostname: string
}

function aktivanBotKanal(inst: Record<string, string>): boolean {
  const a = (inst.BOTKANAL_ADRESE || '').trim()
  return !!a && a !== '[]'
}

function semver(a: string): number[] { return a.split('.').map(n => Number(n) || 0) }
function barem(imam: string, treba: string): boolean {
  const x = semver(imam), y = semver(treba.replace('>=', ''))
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return true
}

/** Sve stavke profila prema stanju čvora — bez ikakvog pisanja. */
export function usporedi(k: Kontekst): Stavka[] {
  const { profil, stanje } = k
  const inst = { ...k.inst, HOME: stanje.home, TM_PAKET: stanje.paket }
  const M = profil.moduli
  const out: Stavka[] = []
  const dodaj = (s0: Stavka) => out.push(s0)
  const botKanal = aktivanBotKanal(inst)
  const neaktivneTajne = new Set(botKanal ? [] : (M['bot-kanal']?.tajneImenom || []))

  // paket — preduvjet (P1): značajke koje profil koristi moraju biti u kodu čvora.
  if (M.paket) {
    for (const z0 of M.paket.paketSadrzi) {
      const ima = stanje.znacajke[z0.znacajka]
      dodaj({ modul: 'paket', kljuc: z0.znacajka, vrsta: ima ? 'OK' : 'PREDUVJET',
        poruka: ima ? undefined : `kod čvora (${stanje.git || '?'}) nema značajku — ažuriraj kod (tm-cvor-azuriraj.sh) na commit koji je sadrži` })
    }
    const izv = M.paket.izvorniSustavSadrzi
    if (izv) {
      if (zamijeni(izv.mapa, inst) === PRESKOCI || !(zamijeni(izv.mapa, inst) as string)) {
        dodaj({ modul: 'paket', kljuc: 'izvorniSustavSadrzi', vrsta: 'PRESKOČENO', poruka: 'SUSTAV_DIR nije zadan' })
      } else {
        // NEDOSTAJE, ne PREDUVJET: PREDUVJET bi zaustavio i --pisi ostalih modula. Kod koji uključena
        // značajka treba javlja modul `znacajke` kao PREDUVJET (J14).
        for (const f of izv.datoteke) {
          const ima = stanje.izvorni[f]
          dodaj({ modul: 'paket', kljuc: `izvorni.${f}`, vrsta: ima ? 'OK' : 'NEDOSTAJE',
            poruka: ima ? undefined : 'nema u kodu izvornog sustava — P5: tm-cvor-azuriraj.sh <čvor> --s-kompletom' })
        }
        for (const g of izv.grep) {
          const ima = stanje.izvorni[`${g.datoteka}:${g.sadrzi}`]
          dodaj({ modul: 'paket', kljuc: g.znacajka, vrsta: ima ? 'OK' : 'NEDOSTAJE',
            poruka: ima ? undefined : `${g.datoteka} nema „${g.sadrzi}" — P5` })
        }
      }
    }
    if (!stanje.baza.postoji || stanje.baza.greska) {
      dodaj({ modul: 'paket', kljuc: 'baza', vrsta: 'PREDUVJET', poruka: `${stanje.baza.putanja}: ${stanje.baza.greska || 'ne postoji'} (scripts/init-db.ts)` })
    }
    if (!stanje.sustav) dodaj({ modul: 'paket', kljuc: 'alati/unit', vrsta: 'PRESKOČENO', poruka: 'provjera sustava isključena' })
    else {
      for (const [alat, treba] of Object.entries(M.paket.alati || {})) {
        const imam = stanje.sustav.alati[alat]
        dodaj({ modul: 'paket', kljuc: `alat.${alat}`, profil: treba, cvor: imam,
          vrsta: imam && barem(imam, treba) ? 'OK' : 'NEDOSTAJE', poruka: imam ? undefined : 'alat nije instaliran' })
      }
      if (M.paket.unit) {
        const st = stanje.sustav.unitovi[M.paket.unit.ime]
        dodaj({ modul: 'paket', kljuc: `unit.${M.paket.unit.ime}`, profil: 'active', cvor: st,
          vrsta: (st === 'active') === M.paket.unit.aktivan ? 'OK' : 'NEDOSTAJE' })
      }
    }
  }

  // okolina — netajni retci postavke.env (bijela lista); tajni retci samo postoji/nema.
  if (M.okolina) {
    for (const [kljuc, tpl] of Object.entries(M.okolina.postavkeEnv)) {
      const ocek = zamijeni(tpl, inst)
      if (ocek === PRESKOCI) { dodaj({ modul: 'okolina', kljuc, vrsta: 'PRESKOČENO', poruka: 'ovisi o praznoj varijabli instance' }); continue }
      const cvor = stanje.env[kljuc]
      dodaj(jednako(ocek, cvor)
        ? { modul: 'okolina', kljuc, vrsta: 'OK' }
        : { modul: 'okolina', kljuc, vrsta: 'RAZLIKA', profil: ocek, cvor: cvor ?? null, primjena: { vrsta: 'env', kljuc, vrijednost: ocek as string } })
    }
    for (const kljuc of M.okolina.nesmijeBiti) {
      dodaj(stanje.envNesmije[kljuc]
        ? { modul: 'okolina', kljuc, vrsta: 'RAZLIKA', profil: '(nema)', cvor: '(postoji)', primjena: { vrsta: 'env', kljuc, vrijednost: null } }
        : { modul: 'okolina', kljuc: `nema.${kljuc}`, vrsta: 'OK' })
    }
    for (const kljuc of M.okolina.tajneImenom) {
      if (neaktivneTajne.has(kljuc)) continue
      dodaj({ modul: 'okolina', kljuc, vrsta: stanje.envTajne[kljuc] ? 'TAJNA' : 'TAJNA-NEDOSTAJE', poruka: stanje.envTajne[kljuc] ? 'postoji' : 'nema' })
    }
    if (M.razgovor && (M.razgovor.settings as any)['razgovor.ovlasti'] === 'puno') {
      dodaj({ modul: 'okolina', kljuc: 'TM_RAZGOVOR_PUNO', vrsta: stanje.punoDopusteno ? 'OK' : 'ČOVJEK',
        poruka: stanje.punoDopusteno ? 'postavio čovjek' : 'ovlasti=puno traže TM_RAZGOVOR_PUNO=1 — upisuje ga SAMO vlasnik (PROFIL_CVORA_TAJNE.md #5); dotad citanje' })
    }
  }

  // eposta (TASK-5358) — prekidači u email.json; prazna varijabla instance = modul se ne dira.
  if (M.eposta) {
    const ocek = zamijeni(M.eposta.json, inst)
    for (const [put, v] of ravno(ocek)) {
      const kljuc = put.join('.')
      if (v === PRESKOCI || v === '' || (Array.isArray(v) && !v.length)) {
        dodaj({ modul: 'eposta', kljuc, vrsta: 'PRESKOČENO', poruka: 'ovisi o praznoj varijabli instance' }); continue
      }
      const cvor = stanje.eposta ? dohvati(stanje.eposta, put) : undefined
      dodaj(jednako(v, cvor)
        ? { modul: 'eposta', kljuc, vrsta: 'OK' }
        : { modul: 'eposta', kljuc, vrsta: 'RAZLIKA', profil: v, cvor: cvor ?? null, primjena: { vrsta: 'eposta', put, vrijednost: v } })
    }
  }

  // telegram — polja JSON-a; botToken se nikad ne piše.
  if (M.telegram) {
    const ocek = zamijeni(M.telegram.json, inst)
    const nikad = M.telegram.nikadNeIzvozi
    for (const [put, v] of ravno(ocek)) {
      if (put.some(p => nikad.includes(p))) continue
      const kljuc = put.join('.')
      const cvor = stanje.telegram ? dohvati(stanje.telegram, put) : undefined
      dodaj(jednako(v, cvor)
        ? { modul: 'telegram', kljuc, vrsta: 'OK' }
        : { modul: 'telegram', kljuc, vrsta: 'RAZLIKA', profil: v, cvor: cvor ?? null, primjena: { vrsta: 'telegram', put, vrijednost: v } })
    }
    for (const t of M.telegram.tajneImenom) {
      const ima = stanje.telegramTajne[t]
      dodaj({ modul: 'telegram', kljuc: t, vrsta: ima ? 'TAJNA' : 'TAJNA-NEDOSTAJE', poruka: ima ? 'postoji' : 'nema' })
    }
  }

  // settings ploče — kroz API, s ograničenjem ovlasti.
  for (const ime of ['razgovor', 'glas', 'memorija', 'bot-kanal'] as const) {
    const mod = M[ime]
    if (!mod) continue
    if (ime === 'bot-kanal' && !botKanal) {
      dodaj({ modul: ime, kljuc: '(modul)', vrsta: 'PRESKOČENO', poruka: 'BOTKANAL_ADRESE nije zadan u instanci' })
      continue
    }
    const nikad: string[] = (mod as any).nikadNeIzvozi || []
    for (const [kljuc, tpl] of Object.entries(mod.settings)) {
      if (nikad.includes(kljuc)) continue
      let ocek = zamijeni(tpl, inst)
      if (ocek === PRESKOCI) { dodaj({ modul: ime, kljuc, vrsta: 'PRESKOČENO', poruka: 'ovisi o praznoj varijabli instance' }); continue }
      if (kljuc === 'razgovor.ovlasti' && ocek === 'puno' && !stanje.punoDopusteno) {
        ocek = 'citanje'
        dodaj({ modul: ime, kljuc, vrsta: 'UPOZORENJE', poruka: 'profil traži puno; bez TM_RAZGOVOR_PUNO=1 upisuje se citanje' })
      }
      const sirovo = stanje.settings[kljuc]
      const cvor = sirovo === undefined ? k.zadano.get(kljuc) : dekodiraj(sirovo, ocek)
      if (jednako(ocek, cvor)) { dodaj({ modul: ime, kljuc, vrsta: 'OK' }); continue }
      // API se gleda u kodu ČVORA (sakupljač), ne u kodu ovog alata — tuđi čvor može biti druge verzije.
      const api = stanje.apiKljucevi.includes(kljuc)
      dodaj(api
        ? { modul: ime, kljuc, vrsta: 'RAZLIKA', profil: ocek, cvor: cvor ?? null, primjena: { vrsta: 'settings', kljuc, vrijednost: ocek } }
        : { modul: ime, kljuc, vrsta: 'NEDOSTAJE', profil: ocek, cvor: cvor ?? null,
            poruka: 'ploča ovog čvora nema API za ključ (kod bez značajke ili postavka izvornog sustava)' })
    }
    for (const t of ((mod as any).tajneImenom || []) as string[]) {
      if (M.okolina?.tajneImenom.includes(t)) continue
      dodaj({ modul: ime, kljuc: t, vrsta: stanje.envTajne[t] ? 'TAJNA' : 'TAJNA-NEDOSTAJE' })
    }
  }
  if (M.glas?.servis) {
    const sv = M.glas.servis
    if (!stanje.sustav) dodaj({ modul: 'glas', kljuc: 'servis', vrsta: 'PRESKOČENO', poruka: 'provjera sustava isključena' })
    else {
      const akt = stanje.sustav.unitovi[sv.unit] === 'active' && stanje.sustav.vrata[String(sv.vrata)]
      dodaj({ modul: 'glas', kljuc: `servis.${sv.unit}`, vrsta: akt ? 'OK' : 'NEDOSTAJE',
        poruka: akt ? undefined : `servis glasa nije aktivan na 127.0.0.1:${sv.vrata} — donosi ga komplet izvornog sustava` })
    }
  }

  if (M['tunel-memorije']) {
    const vr = M['tunel-memorije'].provjeraNaCvoru.vrata
    if (!stanje.sustav) dodaj({ modul: 'tunel-memorije', kljuc: String(vr), vrsta: 'PRESKOČENO', poruka: 'provjera sustava isključena' })
    else dodaj({ modul: 'tunel-memorije', kljuc: `127.0.0.1:${vr}`, vrsta: stanje.sustav.vrata[String(vr)] ? 'OK' : 'NEDOSTAJE',
      poruka: stanje.sustav.vrata[String(vr)] ? undefined : 'tunel ne sluša — postupak je na glavnom stroju (PROFIL_CVORA_TAJNE.md #8)' })
  }

  // capguard — samo namjera (pending), nikad odobrenje.
  if (M.capguard) {
    if (!stanje.capguard.postoji) {
      dodaj({ modul: 'capguard', kljuc: '(stanje)', vrsta: 'NEDOSTAJE', poruka: 'capguard nije instaliran na stroju (vlasnik stroj-root)' })
    } else {
      for (const [ime, zelj] of Object.entries(M.capguard.zeljeno)) {
        const cvor = stanje.capguard.zastavice[ime] ?? false
        if (cvor === zelj) { dodaj({ modul: 'capguard', kljuc: ime, vrsta: 'OK' }); continue }
        if (stanje.capguard.pending.includes(ime)) {
          dodaj({ modul: 'capguard', kljuc: ime, vrsta: 'ČOVJEK', profil: zelj, cvor, poruka: 'zahtjev čeka odobrenje (PROFIL_CVORA_TAJNE.md #7)' })
        } else {
          dodaj({ modul: 'capguard', kljuc: ime, vrsta: 'RAZLIKA', profil: zelj, cvor, primjena: { vrsta: 'capguard', ime, desired: zelj } })
        }
      }
    }
  }

  // claude — hooks u settings.json (spoj, ne zamjena), kuka, prijava.
  if (M.claude) {
    const hooks = zamijeni(M.claude.settingsJson.hooks, inst) as Record<string, unknown[]>
    const cvorHooks = (stanje.settingsJson.hooks || {}) as Record<string, unknown[]>
    for (const [dog, unosi] of Object.entries(hooks)) {
      for (const [i, unos] of unosi.entries()) {
        const ima = (cvorHooks[dog] || []).some(x => jednako(x, unos))
        dodaj(ima
          ? { modul: 'claude', kljuc: `hooks.${dog}[${i}]`, vrsta: 'OK' }
          : { modul: 'claude', kljuc: `hooks.${dog}[${i}]`, vrsta: 'RAZLIKA', profil: unos, cvor: stanje.settingsJson.postoji ? (cvorHooks[dog] ?? null) : '(nema settings.json)',
              primjena: { vrsta: 'hooks', dogadjaj: dog, unos } })
      }
    }
    for (const kuka of M.claude.kuke) {
      const sha = stanje.kuke[kuka.datoteka]
      const ocek = zamijeni(kuka.sha256, inst) as string
      if (!sha) dodaj({ modul: 'claude', kljuc: `kuka ${basename(kuka.datoteka)}`, vrsta: 'NEDOSTAJE', poruka: 'nema datoteke — donosi je komplet izvornog sustava' })
      else if (ocek && ocek !== PRESKOCI as any && sha !== ocek) dodaj({ modul: 'claude', kljuc: `kuka ${basename(kuka.datoteka)}.sha256`, vrsta: 'NEDOSTAJE', profil: ocek, cvor: sha, poruka: 'sha256 se ne slaže s instancom (izvorni sustav)' })
      else dodaj({ modul: 'claude', kljuc: `kuka ${basename(kuka.datoteka)}`, vrsta: 'OK' })
    }
    dodaj({ modul: 'claude', kljuc: 'claude-prijava', vrsta: stanje.claudePrijava ? 'TAJNA' : 'ČOVJEK',
      poruka: stanje.claudePrijava ? 'postoji' : 'nema — `claude auth login` (PROFIL_CVORA_TAJNE.md #4)' })
  }

  // upravitelj — ~/CLAUDE.md iz predloška; postojeću datoteku alat ne prepisuje.
  if (M.upravitelj) {
    const cilj = zamijeni(M.upravitelj.cilj, inst) as string
    if (stanje.upravitelj.postoji) {
      dodaj(stanje.upravitelj.bajtova > M.upravitelj.najvise
        ? { modul: 'upravitelj', kljuc: cilj, vrsta: 'UPOZORENJE', poruka: `${stanje.upravitelj.bajtova} B > ${M.upravitelj.najvise}` }
        : { modul: 'upravitelj', kljuc: cilj, vrsta: 'OK' })
    } else {
      const pred = isAbsolute(M.upravitelj.predlozak) ? M.upravitelj.predlozak : join(k.korijen, M.upravitelj.predlozak)
      const sadrzaj = popuniPredlozak(pred, k, M.upravitelj.najvise)
      dodaj({ modul: 'upravitelj', kljuc: cilj, vrsta: 'RAZLIKA', profil: `(predložak, ${Buffer.byteLength(sadrzaj)} B)`, cvor: '(nema)',
        primjena: { vrsta: 'upravitelj', cilj, sadrzaj } })
    }
  }

  if (M.home) {
    const uz = zamijeni(M.home.grepNema.uzorak, inst)
    if (!uz || uz === PRESKOCI) dodaj({ modul: 'home', kljuc: '(grep)', vrsta: 'PRESKOČENO', poruka: 'TUDI_HOME nije zadan' })
    else for (const f of M.home.grepNema.u) {
      const n = stanje.grepNema[f]
      dodaj(n === null || n === undefined
        ? { modul: 'home', kljuc: f, vrsta: 'PRESKOČENO', poruka: 'datoteka ne postoji' }
        : { modul: 'home', kljuc: f, vrsta: n === 0 ? 'OK' : 'NEDOSTAJE', cvor: n, poruka: n ? 'tuđi HOME u datoteci — komplet isporuka_home izvornog sustava' : undefined })
    }
  }

  if (M.rag && !M.rag.ukljucen) {
    const ima = Object.values(stanje.envNesmije).some(Boolean)
    dodaj({ modul: 'rag', kljuc: 'isključen', vrsta: ima ? 'UPOZORENJE' : 'OK', poruka: ima ? 'TM_CHROMA_* postoji — v. modul okolina' : undefined })
  }

  usporediZnanje(k, dodaj)
  usporediZnacajke(k, inst, dodaj)
  usporediKuke(k, inst, dodaj)
  usporediKonzolu(k, inst, dodaj)
  usporediOporavak(k, inst, dodaj)
  return out
}

// ─── Znanje čvora (ADR-0006 §9, TASK-5331) ────────────────────────────────────

/** Jedinice timera dotoka znanja: `osvjezi --pisi` iz paketa svakih N minuta (bez tajni u jedinici). */
export function jediniceZnanja(m: { naredba: string[]; timer: { unit: string; minuta: number } }, paket: string, bun: string): { service: string; timer: string } {
  const [skripta, ...arg] = m.naredba
  return {
    service: ['[Unit]', 'Description=REGOČ znanje čvora — korpus i ploča/Telegram čvora u banku memorije (ADR-0006)', '',
      '[Service]', 'Type=oneshot', `WorkingDirectory=${paket}`, `ExecStart=${bun} ${join(paket, skripta)} ${arg.join(' ')}`,
      // systemd korisnička okolina nema ~/.bun/bin u PATH-u (alati paketa zovu bun/git/systemctl)
      `Environment=PATH=${dirname(bun)}:/usr/local/bin:/usr/bin:/bin`, 'Nice=10', ''].join('\n'),
    timer: ['[Unit]', `Description=REGOČ znanje čvora svakih ${m.timer.minuta} min`, '', '[Timer]', 'OnBootSec=10min',
      `OnUnitActiveSec=${m.timer.minuta}min`, 'Persistent=true', '', '[Install]', 'WantedBy=timers.target', ''].join('\n'),
  }
}

function usporediZnanje(k: Kontekst, dodaj: Dodaj): void {
  const M = k.profil.moduli
  const zn = k.stanje.znanje
  const inst = { ...k.inst, HOME: k.stanje.home }
  if (!M.mogucnosti && !M.znanje && !M.memorija?.izolacija) return
  if (!zn) {
    for (const m of ['mogucnosti', 'znanje'] as const) if (M[m]) dodaj({ modul: m, kljuc: '(stanje)', vrsta: 'PRESKOČENO', poruka: 'provjera sustava isključena ili sakupljač bez znanja' })
    return
  }
  if (M.mogucnosti) {
    const st = zn.mogucnosti
    const svjeze = st.postoji && st.starostSati !== null && st.starostSati <= M.mogucnosti.maxStarostSati
    dodaj(svjeze
      ? { modul: 'mogucnosti', kljuc: M.mogucnosti.datoteka, vrsta: 'OK' }
      : { modul: 'mogucnosti', kljuc: M.mogucnosti.datoteka, vrsta: 'RAZLIKA', profil: `izmjereno ≤ ${M.mogucnosti.maxStarostSati} h`,
          cvor: st.postoji ? `${st.starostSati} h` : '(nema)', primjena: { vrsta: 'naredba', argv: M.mogucnosti.naredba } })
  }
  if (M.znanje) {
    const u = zn.upis
    const banka = inst.MEMORIJA_BANKA
    const razlog = !u.postoji ? 'nema upisa' : u.banka !== banka ? `upis je za banku ${u.banka}` : u.sustav < zn.korpusPaketa ? `u banci ${u.sustav}/${zn.korpusPaketa} sustav/*`
      : (u.starostSati === null || u.starostSati > M.znanje.maxStarostSati) ? `zadnji upis prije ${u.starostSati ?? '?'} h` : ''
    dodaj(!razlog
      ? { modul: 'znanje', kljuc: 'banka', vrsta: 'OK' }
      : { modul: 'znanje', kljuc: 'banka', vrsta: 'RAZLIKA', profil: `${banka}: ${zn.korpusPaketa} sustav/*, upis ≤ ${M.znanje.maxStarostSati} h`, cvor: razlog,
          primjena: { vrsta: 'naredba', argv: M.znanje.naredba } })
    const t = zn.timer
    if (t.datoteka && t.aktivan === 'active') dodaj({ modul: 'znanje', kljuc: 'timer', vrsta: 'OK' })
    else {
      const j = jediniceZnanja(M.znanje, k.stanje.paket, join(k.stanje.home, '.bun', 'bin', 'bun'))
      dodaj({ modul: 'znanje', kljuc: 'timer', vrsta: 'RAZLIKA', profil: `${M.znanje.timer.unit}.timer aktivan`, cvor: t.datoteka ? t.aktivan : '(nema jedinice)',
        primjena: { vrsta: 'timer', unit: M.znanje.timer.unit, service: j.service, timer: j.timer } })
    }
  }
  if (M.memorija?.izolacija) {
    const banka = inst.MEMORIJA_BANKA
    if (zn.banke === null) dodaj({ modul: 'memorija', kljuc: 'izolacija', vrsta: 'PRESKOČENO', poruka: 'memorija ne odgovara' })
    else dodaj(zn.banke.length === 1 && zn.banke[0] === banka
      ? { modul: 'memorija', kljuc: 'izolacija', vrsta: 'OK' }
      : { modul: 'memorija', kljuc: 'izolacija', vrsta: 'NEDOSTAJE', profil: [banka], cvor: zn.banke,
          poruka: 'čvor vidi i tuđe banke — tunel mora pokazivati na posrednika memorije (glavni stroj, ADR-0006 §8 B) ili na lokalni Hindsight' })
    if (zn.tudjiDokumenti === null) dodaj({ modul: 'memorija', kljuc: 'nikadNeNosi', vrsta: 'PRESKOČENO', poruka: 'banka nečitljiva' })
    else dodaj(zn.tudjiDokumenti === 0
      ? { modul: 'memorija', kljuc: 'nikadNeNosi', vrsta: 'OK' }
      : { modul: 'memorija', kljuc: 'nikadNeNosi', vrsta: 'NEDOSTAJE', cvor: zn.tudjiDokumenti,
          poruka: `u banci ${banka} ima dokumenata s glavnog stroja (${M.memorija.izolacija.zabranjeniDokumenti.join(', ')}) — nova banka iz čistog korpusa (ADR-0006 §5.3)` })
  }
}

// ─── Paritet s glavnim sustavom: značajke, kuke, konzola, oporavak (ADR-0004 §13) ──

type Dodaj = (s0: Stavka) => void

/** Popis iz instance (`${IME:json}`); prazno ili neispravno → []. */
function popisInstance(tpl: string | undefined, inst: Record<string, string>): string[] {
  if (!tpl) return []
  const v = zamijeni(tpl, inst)
  return Array.isArray(v) ? v.map(String) : []
}

/**
 * Vrijednost svakog prekidača nakon instance: ZNACAJKE_ISKLJUCI smije sve (oprezniji čvor),
 * ZNACAJKE_UKLJUCI samo `uvjetno` (`van` je odluka paketa, ne čvora). Isključenje pobjeđuje.
 */
export function ucinakZnacajki(p: Profil, inst: Record<string, string>): { ucinak: Record<string, boolean>; upozorenja: string[] } {
  const mod = p.moduli.znacajke
  const ucinak: Record<string, boolean> = {}
  const upozorenja: string[] = []
  if (!mod) return { ucinak, upozorenja }
  for (const [k0, z0] of Object.entries(mod.kljucevi)) ucinak[k0] = z0.on
  for (const k0 of popisInstance(mod.instanca?.ukljuci, inst)) {
    const z0 = mod.kljucevi[k0]
    if (!z0) upozorenja.push(`ZNACAJKE_UKLJUCI: nepoznat prekidač ${k0}`)
    else if (z0.odluka === 'van') upozorenja.push(`ZNACAJKE_UKLJUCI: ${k0} je „van" (${z0.razlog || 'odluka paketa'}) — instanca ga ne uključuje`)
    else ucinak[k0] = true
  }
  for (const k0 of popisInstance(mod.instanca?.iskljuci, inst)) {
    if (!(k0 in mod.kljucevi)) upozorenja.push(`ZNACAJKE_ISKLJUCI: nepoznat prekidač ${k0}`)
    else ucinak[k0] = false
  }
  return { ucinak, upozorenja }
}

function usporediZnacajke(k: Kontekst, inst: Record<string, string>, dodaj: Dodaj): void {
  const mod = k.profil.moduli.znacajke
  if (!mod) return
  const cv = k.stanje.znacajkeCvor
  if (zamijeni(mod.datoteka, inst) === PRESKOCI || !cv) {
    dodaj({ modul: 'znacajke', kljuc: '(modul)', vrsta: 'PRESKOČENO', poruka: 'SUSTAV_DIR nije zadan' })
    return
  }
  const { ucinak, upozorenja } = ucinakZnacajki(k.profil, inst)
  upozorenja.forEach(u => dodaj({ modul: 'znacajke', kljuc: '(instanca)', vrsta: 'UPOZORENJE', poruka: u }))
  for (const [kljuc, z0] of Object.entries(mod.kljucevi)) {
    const zelim = ucinak[kljuc]
    const sirovo = cv.vrijednosti[kljuc] ?? null
    const imam = sirovo === true
    if (zelim && !z0.bezKoda && !cv.kodZna[kljuc]) {
      dodaj({ modul: 'znacajke', kljuc, vrsta: 'PREDUVJET', profil: true, cvor: sirovo,
        poruka: `kod čvora ne zna prekidač „${kljuc}" — uključen ne bi radio ništa. P5 (tm-cvor-azuriraj.sh --s-kompletom) ili ga instanca odgodi (ZNACAJKE_ISKLJUCI)` })
      continue
    }
    if (zelim === imam) { dodaj({ modul: 'znacajke', kljuc, vrsta: 'OK' }); continue }
    dodaj({ modul: 'znacajke', kljuc, vrsta: 'RAZLIKA', profil: zelim, cvor: sirovo === null ? '(nema)' : sirovo,
      poruka: z0.razlog, primjena: { vrsta: 'znacajka', kljuc, enabled: zelim, razlog: z0.razlog || `odluka ${z0.odluka}` } })
  }
}

/** Paketi kuka koje instanca uključuje; `jezgra` uvijek. */
export function paketiKuka(p: Profil, inst: Record<string, string>): string[] {
  const mod = p.moduli.kuke
  if (!mod) return []
  const v = zamijeni(mod.paketi, inst)
  const iz = typeof v === 'string' && v.trim() ? v.split(',').map(x => x.trim()).filter(Boolean) : mod.zadaniPaketi
  return [...new Set(['jezgra', ...iz])]
}

function usporediKuke(k: Kontekst, inst: Record<string, string>, dodaj: Dodaj): void {
  const mod = k.profil.moduli.kuke
  if (!mod) return
  const paketi = paketiKuka(k.profil, inst)
  const poznati = new Set(mod.popis.map(x => x.paket))
  for (const p0 of paketi) if (!poznati.has(p0)) dodaj({ modul: 'kuke', kljuc: `paket ${p0}`, vrsta: 'UPOZORENJE', poruka: 'KUKE_PAKETI: nepoznat paket kuka' })
  const cvorHooks = (k.stanje.settingsJson.hooks || {}) as Record<string, any[]>
  for (const kuka of mod.popis) {
    if (!paketi.includes(kuka.paket)) continue
    const naredba = zamijeni(kuka.naredba, inst) as string
    const kljuc = `${kuka.dogadjaj}${kuka.matcher ? `[${kuka.matcher}]` : ''} ${kuka.ime}`
    if (!k.stanje.kuke[kuka.datoteka]) {
      dodaj({ modul: 'kuke', kljuc, vrsta: 'NEDOSTAJE', poruka: `nema datoteke ${zamijeni(kuka.datoteka, inst)} — kuka se ne spaja (${kuka.paket === 'jezgra' && kuka.datoteka.includes('${TM_PAKET}') ? 'ažuriraj paket' : 'komplet izvornog sustava'})` })
      continue
    }
    const spojena = (cvorHooks[kuka.dogadjaj] || []).some(e =>
      (e?.matcher || undefined) === kuka.matcher && Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === naredba))
    if (spojena) { dodaj({ modul: 'kuke', kljuc, vrsta: 'OK' }); continue }
    const hook: Record<string, unknown> = { type: 'command', command: naredba }
    if (kuka.timeout) hook.timeout = kuka.timeout
    const unos: Record<string, unknown> = kuka.matcher ? { matcher: kuka.matcher, hooks: [hook] } : { hooks: [hook] }
    dodaj({ modul: 'kuke', kljuc, vrsta: 'RAZLIKA', profil: naredba, cvor: '(nije spojena)', poruka: kuka.razlog,
      primjena: { vrsta: 'hooks', dogadjaj: kuka.dogadjaj, unos } })
  }
}

/** Drop-in user-unita: izlaz servisa u datoteku koju čita konzola ploče (ne u journal). */
export function konzolaDropIn(log: string): string {
  return [
    `# ${AUTOR} (ADR-0004 §13.2.3): izlaz servisa u datoteku koju prati konzola ploče.`,
    '[Service]', `StandardOutput=append:${log}`, `StandardError=append:${log}`, '',
  ].join('\n')
}

export const dropInPut = (unit: string) => `\${HOME}/.config/systemd/user/${unit}.service.d/konzola.conf`

/**
 * Drop-in zone procesa (TASK-5308). Ploča vraća vrijeme bez zone („2026-10-07 09:07:56", UTC iz
 * SQLite `datetime('now')`), a `Date.parse` takav zapis čita kao LOKALNO vrijeme. Na čvoru izvan
 * UTC-a (node-A: EDT) zadatak je tada „u budućnosti" i siroče/zombie ne vide odsutnost. Glavni
 * sustav radi u UTC-u, pa je TZ=UTC i paritet i ispravak.
 */
export function vrijemeDropIn(tz: string): string {
  return [
    `# ${AUTOR} (ADR-0004 §13.8): naivna vremena ploče su UTC — proces ih mora čitati u istoj zoni.`,
    '[Service]', `Environment=TZ=${tz}`, '',
  ].join('\n')
}

export const vrijemeDropInPut = (unit: string) => `\${HOME}/.config/systemd/user/${unit}.service.d/vrijeme.conf`

/**
 * Drop-in PATH-a usluge (TASK-5364). Unit daemona i ploče na node-A imao je PATH bez `~/.local/bin`,
 * a ondje žive `claude` i `glas`: ploča je javljala „no Claude CLI", agenti nisu našli `glas` po imenu.
 * `%h` razrješava systemd (HOME korisnika), pa ista vrijednost vrijedi na svakom čvoru.
 */
export function putDropIn(put: string): string {
  return [
    `# ${AUTOR} (TASK-5364): alati korisnika (~/.local/bin: claude, glas) moraju biti na PATH-u usluge.`,
    '[Service]', `Environment=PATH=${put}`, '',
  ].join('\n')
}

export const putDropInPut = (unit: string) => `\${HOME}/.config/systemd/user/${unit}.service.d/put.conf`

function usporediKonzolu(k: Kontekst, inst: Record<string, string>, dodaj: Dodaj): void {
  const mod = k.profil.moduli.konzola
  if (!mod) return
  const { stanje } = k
  for (const iz of mod.izvori) {
    if (iz.preskoci) { dodaj({ modul: 'konzola', kljuc: iz.ime, vrsta: 'PRESKOČENO', poruka: iz.preskoci }); continue }
    const log = zamijeni(iz.datoteka, inst) as string
    if (iz.unit) {
      const tpl = dropInPut(iz.unit)
      const sadrzaj = konzolaDropIn(log)
      dodaj(stanje.konzola.dropIni[tpl] === sadrzaj
        ? { modul: 'konzola', kljuc: `${iz.ime}.drop-in`, vrsta: 'OK' }
        : { modul: 'konzola', kljuc: `${iz.ime}.drop-in`, vrsta: 'RAZLIKA', profil: `StandardOutput=append:${log}`,
            cvor: stanje.konzola.dropIni[tpl] === null || stanje.konzola.dropIni[tpl] === undefined ? '(journal)' : '(drugačiji drop-in)',
            primjena: { vrsta: 'konzola', unit: iz.unit, datoteka: zamijeni(tpl, inst) as string, sadrzaj, log } })
    }
    const min = stanje.konzola.starostMin[iz.datoteka]
    if (min !== null && min !== undefined && min <= mod.maxSati * 60) { dodaj({ modul: 'konzola', kljuc: iz.ime, vrsta: 'OK' }); continue }
    const unitStanje = iz.unit && stanje.sustav ? stanje.sustav.unitovi[iz.unit] : undefined
    if (unitStanje !== undefined && unitStanje !== 'active') {
      dodaj({ modul: 'konzola', kljuc: iz.ime, vrsta: 'PRESKOČENO', poruka: `servis ${iz.unit} ne radi (${unitStanje})` })
      continue
    }
    dodaj({ modul: 'konzola', kljuc: iz.ime, vrsta: 'NEDOSTAJE', cvor: min === null || min === undefined ? '(nema datoteke)' : `${min} min`,
      poruka: `izvor konzole nije svjež (> ${mod.maxSati} h) — puni ga ${iz.puni || iz.unit || '?'}${iz.unit ? '; drop-in vrijedi tek nakon daemon-reload + restart servisa' : ''}` })
  }
}

function usporediOporavak(k: Kontekst, inst: Record<string, string>, dodaj: Dodaj): void {
  const mod = k.profil.moduli.oporavak
  const cv = k.stanje.znacajkeCvor
  if (!mod) return
  // PATH ne ovisi o izvornom sustavu — vrijedi i na čvoru bez njega (node-B), zato prije ranog izlaza.
  for (const unit of mod.put?.unitovi || []) {
    const tpl = putDropInPut(unit)
    const sadrzaj = putDropIn(mod.put!.vrijednost)
    const cvor = k.stanje.konzola.dropIni[tpl]
    dodaj(cvor === sadrzaj
      ? { modul: 'oporavak', kljuc: `${unit}.PATH`, vrsta: 'OK' }
      : { modul: 'oporavak', kljuc: `${unit}.PATH`, vrsta: 'RAZLIKA', profil: `PATH=${mod.put!.vrijednost}`,
          cvor: cvor === null || cvor === undefined ? '(PATH unita)' : '(drugačiji drop-in)',
          poruka: 'bez ~/.local/bin usluga ne nalazi `claude` ni `glas` po imenu (Standby: „no Claude CLI")',
          primjena: { vrsta: 'dropin', unit, datoteka: zamijeni(tpl, inst) as string, sadrzaj } })
  }
  if (!cv || !k.profil.moduli.znacajke || zamijeni(k.profil.moduli.znacajke.datoteka, inst) === PRESKOCI) {
    dodaj({ modul: 'oporavak', kljuc: '(modul)', vrsta: 'PRESKOČENO', poruka: 'nema modula znacajke / SUSTAV_DIR' })
    return
  }
  for (const kljuc of mod.ukljuceni) {
    const on = cv.vrijednosti[kljuc] === true
    const kod = cv.kodZna[kljuc] === true
    dodaj(on && kod
      ? { modul: 'oporavak', kljuc, vrsta: 'OK' }
      : { modul: 'oporavak', kljuc, vrsta: 'NEDOSTAJE', poruka: `${on ? '' : 'isključen na čvoru'}${!on && !kod ? '; ' : ''}${kod ? '' : 'kod čvora ga ne zna (P5)'} — siroče se ne vraća samo` })
  }
  for (const kljuc of mod.iskljuceni) {
    dodaj(cv.vrijednosti[kljuc] === true
      ? { modul: 'oporavak', kljuc, vrsta: 'NEDOSTAJE', poruka: 'mora biti isključen (v. modul znacajke)' }
      : { modul: 'oporavak', kljuc: `${kljuc}=off`, vrsta: 'OK' })
  }
  for (const unit of mod.tz?.unitovi || []) {
    const tpl = vrijemeDropInPut(unit)
    const sadrzaj = vrijemeDropIn(mod.tz!.vrijednost)
    const cvor = k.stanje.konzola.dropIni[tpl]
    dodaj(cvor === sadrzaj
      ? { modul: 'oporavak', kljuc: `${unit}.TZ`, vrsta: 'OK' }
      : { modul: 'oporavak', kljuc: `${unit}.TZ`, vrsta: 'RAZLIKA', profil: `TZ=${mod.tz!.vrijednost}`,
          cvor: cvor === null || cvor === undefined ? '(zona stroja)' : '(drugačiji drop-in)',
          poruka: 'bez toga se vrijeme ploče (UTC bez zone) čita kao lokalno — siroče i zombie kasne za pomak zone',
          primjena: { vrsta: 'dropin', unit, datoteka: zamijeni(tpl, inst) as string, sadrzaj } })
  }
  const min = k.stanje.konzola.starostMin[mod.dnevnik]
  dodaj(min !== null && min !== undefined && min <= mod.dnevnikMaxMin
    ? { modul: 'oporavak', kljuc: 'daemon.log', vrsta: 'OK' }
    : { modul: 'oporavak', kljuc: 'daemon.log', vrsta: 'NEDOSTAJE', cvor: min ?? '(nema)', poruka: `daemon ne piše zadnjih ${mod.dnevnikMaxMin} min` })
}

// ─── Predložak upravitelja (J11) ─────────────────────────────────────────────

/** Vrijednost retka postavke.env kakva će biti nakon primjene profila (inače ona na čvoru). */
function envPoProfilu(k: Kontekst, kljuc: string): string | undefined {
  const tpl = k.profil.moduli.okolina?.postavkeEnv[kljuc]
  const v = tpl === undefined ? undefined : zamijeni(tpl, { ...k.inst, HOME: k.stanje.home })
  return typeof v === 'string' && v ? v : k.stanje.env[kljuc]
}

function agentiIzRegistra(k: Kontekst): string {
  const reg = envPoProfilu(k, 'TM_AGENTS_REGISTRY') || ''
  try {
    const a = JSON.parse(readFileSync(reg, 'utf-8')).agents
    const ids = Array.isArray(a) ? a.map((x: any) => x.id) : Object.keys(a || {})
    if (ids.length) return ids.join(', ')
  } catch { /* registra nema */ }
  return '(v. registar agenata, `TM_AGENTS_REGISTRY`)'
}

export function popuniPredlozak(put: string, k: Kontekst, najvise: number): string {
  let tekst: string
  try { tekst = readFileSync(put, 'utf-8') } catch { throw new GreskaPreduvjeta(`predložak ${put} ne postoji`) }
  const v: Record<string, string> = {
    ...k.inst, HOME: k.stanje.home, KORISNIK: basename(k.stanje.home), HOST: k.hostname,
    TM_PORT: envPoProfilu(k, 'TM_PORT') || '17781', AGENTI: agentiIzRegistra(k),
  }
  const nepoznata: string[] = []
  const out = tekst.replace(/\{\{(\w+)\}\}/g, (_m, ime) => {
    if (!(ime in v)) { nepoznata.push(ime); return '' }
    return v[ime] || '—'
  })
  if (nepoznata.length) throw new GreskaPreduvjeta(`predložak: nepoznato mjesto {{${nepoznata[0]}}}`)
  if (out.length > najvise) throw new GreskaPreduvjeta(`predložak nakon popune ima ${out.length} znakova > ${najvise}`)
  return out
}

// ─── Izvoz (J3, J10) ─────────────────────────────────────────────────────────

function izvediVarijable(tpl: unknown, stvarno: unknown, home: string, inst: Record<string, string>, sukobi: string[]): void {
  if (stvarno === undefined || stvarno === null) return
  if (typeof tpl === 'string') {
    const json = tpl.match(/^\$\{(\w+):json\}$/)
    const upisi = (ime: string, vr: string) => {
      if (ime in inst && inst[ime] !== vr) sukobi.push(`${ime}: „${inst[ime]}" ≠ „${vr}"`)
      else inst[ime] = vr
    }
    if (json) { upisi(json[1], JSON.stringify(stvarno)); return }
    if (!tpl.includes('${') || typeof stvarno !== 'string') return
    const imena: string[] = []
    const re = tpl.split(/(\$\{\w+\})/).map(dio => {
      const m = dio.match(/^\$\{(\w+)\}$/)
      if (!m) return dio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (m[1] === 'HOME') return home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      imena.push(m[1]); return '(.*)'
    }).join('')
    const pogodak = stvarno.match(new RegExp(`^${re}$`))
    if (pogodak) imena.forEach((ime, i) => upisi(ime, pogodak[i + 1]))
    return
  }
  if (tpl && typeof tpl === 'object' && !Array.isArray(tpl) && stvarno && typeof stvarno === 'object') {
    for (const [k0, v] of Object.entries(tpl)) izvediVarijable(v, (stvarno as any)[k0], home, inst, sukobi)
  }
}

export function izvediInstancu(p: Profil, st: StanjeCvora): { inst: Record<string, string>; sukobi: string[] } {
  const inst: Record<string, string> = {}
  const sukobi: string[] = []
  const M = p.moduli
  if (M.okolina) for (const [k, t] of Object.entries(M.okolina.postavkeEnv)) izvediVarijable(t, st.env[k], st.home, inst, sukobi)
  if (M.telegram && st.telegram) izvediVarijable(M.telegram.json, st.telegram, st.home, inst, sukobi)
  if (M.eposta && st.eposta) izvediVarijable(M.eposta.json, st.eposta, st.home, inst, sukobi)
  for (const ime of ['razgovor', 'glas', 'memorija', 'bot-kanal'] as const) {
    const mod = M[ime]
    if (!mod) continue
    for (const [k, t] of Object.entries(mod.settings)) {
      const sirovo = st.settings[k]
      if (sirovo === undefined) continue
      const json = typeof t === 'string' && /^\$\{\w+:json\}$/.test(t)
      izvediVarijable(t, json ? dekodiraj(sirovo, []) : sirovo, st.home, inst, sukobi)
    }
  }
  if (M.claude) for (const kk of M.claude.kuke) izvediVarijable(kk.sha256, st.kuke[kk.datoteka] ?? undefined, st.home, inst, sukobi)
  return { inst, sukobi }
}

export function instancaUTekst(p: Profil, inst: Record<string, string>, izvedeno: Set<string>, izvor: string): string {
  const red = (k: string) => (izvedeno.has(k) ? '' : '# nije izvedivo sa čvora — upiši ručno ako treba\n') + `${k}=${inst[k] ?? ''}`
  return [
    `# Instanca profila „${p.profil}" — izvezeno alatom profil-cvora.ts (${izvor}).`,
    '# Nije tajna, ali nije dio paketa (ADR-0004 §3). Tajne ovdje NE idu — v. docs/PROFIL_CVORA_TAJNE.md.',
    '', '# ── Obavezno', ...p.instanca.obavezno.map(red),
    '', '# ── Neobavezno', ...p.instanca.neobavezno.map(red), '',
  ].join('\n')
}

// ─── Primjena ────────────────────────────────────────────────────────────────

export interface Ploca {
  put(ruta: string, tijelo: Record<string, unknown>): Promise<{ status: number; tijelo: any }>
  post(ruta: string, tijelo: Record<string, unknown>): Promise<{ status: number; tijelo: any }>
}

export function plocaHttp(baza: string): Ploca {
  const zovi = (metoda: string) => async (ruta: string, tijelo: Record<string, unknown>) => {
    const r = await fetch(baza + ruta, { method: metoda, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo), signal: AbortSignal.timeout(10_000) })
    return { status: r.status, tijelo: await r.json().catch(() => ({})) }
  }
  return { put: zovi('PUT'), post: zovi('POST') }
}

function kopija(datoteka: string, mapaKopija: string, kopirano: Set<string>, ime = basename(datoteka)): void {
  if (kopirano.has(datoteka) || !existsSync(datoteka)) return
  mkdirSync(mapaKopija, { recursive: true, mode: 0o700 })
  const cilj = join(mapaKopija, ime)
  copyFileSync(datoteka, cilj)
  chmodSync(cilj, statSync(datoteka).mode & 0o777)
  kopirano.add(datoteka)
}

/** Piše preko privremene datoteke, prava ostaju (nova datoteka 0600). */
function upisi(datoteka: string, sadrzaj: string): void {
  const prava = existsSync(datoteka) ? statSync(datoteka).mode & 0o777 : 0o600
  mkdirSync(dirname(datoteka), { recursive: true })
  writeFileSync(datoteka, sadrzaj, { mode: prava })
  chmodSync(datoteka, prava)
}

export interface IshodPrimjene {
  promjena: number; greske: string[]; restart: boolean; kopije: string | null
  /** User-unitovi kojima je promijenjen drop-in: daemon-reload + restart (alat ga ne radi). */
  unitovi: string[]
}

export async function primijeni(stavke: Stavka[], k: Kontekst, ploca: Ploca, sat: Date): Promise<IshodPrimjene> {
  const ishod: IshodPrimjene = { promjena: 0, greske: [], restart: false, kopije: null, unitovi: [] }
  const inst = { ...k.inst, HOME: k.stanje.home, TM_PAKET: k.stanje.paket }
  const mapaKopija = join(k.stanje.tmHome, 'backup', `profil-${sat.toISOString().replace(/[:.]/g, '-')}`)
  const kopirano = new Set<string>()
  const po = (v: Primjena['vrsta']) => stavke.filter(s0 => s0.primjena?.vrsta === v).map(s0 => s0.primjena as any)

  const env = po('env') as Extract<Primjena, { vrsta: 'env' }>[]
  if (env.length) {
    const dat = join(k.stanje.paket, 'config', 'postavke.env')
    kopija(dat, mapaKopija, kopirano)
    const redovi = existsSync(dat) ? readFileSync(dat, 'utf-8').split('\n') : []
    for (const e of env) {
      const i = redovi.findIndex(r => r.replace(/^export\s+/, '').startsWith(e.kljuc + '='))
      if (e.vrijednost === null) { if (i >= 0) redovi[i] = `# ${AUTOR}: ${redovi[i]}` }
      else if (i >= 0) redovi[i] = `${e.kljuc}=${e.vrijednost}`
      else {
        if (redovi.length && redovi[redovi.length - 1] === '') redovi.pop()
        redovi.push(`${e.kljuc}=${e.vrijednost}`, '')
      }
      ishod.promjena++
    }
    upisi(dat, redovi.join('\n'))
    ishod.restart = true
  }

  const tg = po('telegram') as Extract<Primjena, { vrsta: 'telegram' }>[]
  if (tg.length && k.profil.moduli.telegram) {
    const dat = k.stanje.env.TM_TELEGRAM_CONFIG || join(k.stanje.paket, k.profil.moduli.telegram.datoteka)
    kopija(dat, mapaKopija, kopirano)
    let j: any = {}
    try { j = JSON.parse(readFileSync(dat, 'utf-8')) } catch { /* nova */ }
    for (const t of tg) {
      let x = j
      for (const p of t.put.slice(0, -1)) { if (!x[p] || typeof x[p] !== 'object') x[p] = {}; x = x[p] }
      x[t.put[t.put.length - 1]] = t.vrijednost
      ishod.promjena++
    }
    upisi(dat, JSON.stringify(j, null, 2) + '\n')
  }

  const st = po('settings') as Extract<Primjena, { vrsta: 'settings' }>[]
  const poRuti = new Map<string, Record<string, unknown>>()
  for (const x of st) {
    const api = k.karta.get(x.kljuc)
    if (!api) { ishod.greske.push(`${x.kljuc}: kod ovog alata ne zna rutu API-ja`); continue }
    if (!poRuti.has(api.ruta)) poRuti.set(api.ruta, { by: AUTOR, source: AUTOR })
    poRuti.get(api.ruta)![api.polje] = x.vrijednost
  }
  for (const [ruta, tijelo] of poRuti) {
    try {
      const r = await ploca.put(ruta, tijelo)
      if (r.status !== 200) ishod.greske.push(`PUT ${ruta} → ${r.status}: ${r.tijelo?.error || ''}`)
      else ishod.promjena += ((r.tijelo?.promjene || []) as any[]).filter(c => c.changed).length
    } catch (e: any) { ishod.greske.push(`PUT ${ruta}: ${e?.message || e}`) }
  }

  // eposta: kroz API ploče (ista validacija kao kartica; ploča odmah pokrene/zaustavi provjeru pošte).
  const ep = po('eposta') as Extract<Primjena, { vrsta: 'eposta' }>[]
  if (ep.length && k.profil.moduli.eposta) {
    const zakrpa: Record<string, any> = {}
    for (const e of ep) {
      let x = zakrpa
      for (const p0 of e.put.slice(0, -1)) { if (!x[p0] || typeof x[p0] !== 'object') x[p0] = {}; x = x[p0] }
      x[e.put[e.put.length - 1]] = e.vrijednost
    }
    const ruta = k.profil.moduli.eposta.ruta
    try {
      const r = await ploca.put(ruta, zakrpa)
      if (r.status !== 200) ishod.greske.push(`PUT ${ruta} → ${r.status}: ${r.tijelo?.error || ''}`)
      else ishod.promjena += ep.length
    } catch (e: any) { ishod.greske.push(`PUT ${ruta}: ${e?.message || e}`) }
  }

  for (const c of po('capguard') as Extract<Primjena, { vrsta: 'capguard' }>[]) {
    try {
      const r = await ploca.post('/api/capabilities/request', { name: c.ime, desired: c.desired ? 'on' : 'off' })
      if (r.status === 200) ishod.promjena++
      else if (r.status !== 409) ishod.greske.push(`capguard ${c.ime} → ${r.status}: ${r.tijelo?.error || ''}`)
    } catch (e: any) { ishod.greske.push(`capguard ${c.ime}: ${e?.message || e}`) }
  }

  const hk = po('hooks') as Extract<Primjena, { vrsta: 'hooks' }>[]
  const sjDat = k.profil.moduli.kuke?.datoteka || k.profil.moduli.claude?.settingsJson.datoteka
  if (hk.length && sjDat) {
    const dat = putanja(sjDat, { HOME: k.stanje.home })
    kopija(dat, mapaKopija, kopirano)
    let j: any = {}
    try { j = JSON.parse(readFileSync(dat, 'utf-8')) } catch { /* nova */ }
    j.hooks = j.hooks && typeof j.hooks === 'object' ? j.hooks : {}
    for (const h of hk) {
      j.hooks[h.dogadjaj] = Array.isArray(j.hooks[h.dogadjaj]) ? j.hooks[h.dogadjaj] : []
      if (!j.hooks[h.dogadjaj].some((x: unknown) => jednako(x, h.unos))) { j.hooks[h.dogadjaj].push(h.unos); ishod.promjena++ }
    }
    upisi(dat, JSON.stringify(j, null, 2) + '\n')
  }

  // Značajke: SAMO `enabled` imenovanih ključeva; note/since i tuđi ključevi ostaju (J13). Bez restarta.
  const zn = po('znacajka') as Extract<Primjena, { vrsta: 'znacajka' }>[]
  if (zn.length && k.profil.moduli.znacajke) {
    const dat = zamijeni(k.profil.moduli.znacajke.datoteka, inst) as string
    kopija(dat, mapaKopija, kopirano)
    let j: any = {}
    try { j = JSON.parse(readFileSync(dat, 'utf-8')) } catch (e: any) {
      if (existsSync(dat)) { ishod.greske.push(`${dat}: nije čitljiv JSON — ne prepisujem (${e?.message || e})`); j = null }
    }
    if (j) {
      for (const z0 of zn) {
        if (j[z0.kljuc] && typeof j[z0.kljuc] === 'object') j[z0.kljuc].enabled = z0.enabled
        else j[z0.kljuc] = { enabled: z0.enabled, since: sat.toISOString().slice(0, 10), note: `${AUTOR}: ${z0.razlog}` }
        ishod.promjena++
      }
      upisi(dat, JSON.stringify(j, null, 2) + '\n')
    }
  }

  for (const c of po('konzola') as Extract<Primjena, { vrsta: 'konzola' }>[]) {
    mkdirSync(dirname(c.log), { recursive: true })
    kopija(c.datoteka, mapaKopija, kopirano, `${c.unit}.konzola.conf`)
    upisi(c.datoteka, c.sadrzaj)
    ishod.unitovi.push(c.unit)
    ishod.promjena++
  }

  for (const c of po('dropin') as Extract<Primjena, { vrsta: 'dropin' }>[]) {
    kopija(c.datoteka, mapaKopija, kopirano, `${c.unit}.${basename(c.datoteka)}`)
    upisi(c.datoteka, c.sadrzaj)
    ishod.unitovi.push(c.unit)
    ishod.promjena++
  }

  // TASK-5331: naredbe paketa (mjerenje mogućnosti, upis znanja) i timer dotoka znanja.
  for (const n of po('naredba') as Extract<Primjena, { vrsta: 'naredba' }>[]) {
    const bun = join(k.stanje.home, '.bun', 'bin', 'bun')
    const r = Bun.spawnSync([existsSync(bun) ? bun : 'bun', join(k.stanje.paket, n.argv[0]), ...n.argv.slice(1)], { cwd: k.stanje.paket, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode === 0) ishod.promjena++
    else ishod.greske.push(`${n.argv.join(' ')} → izlaz ${r.exitCode}: ${(r.stdout.toString() + r.stderr.toString()).trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)
  }
  for (const t of po('timer') as Extract<Primjena, { vrsta: 'timer' }>[]) {
    const mapa = join(k.stanje.home, '.config', 'systemd', 'user')
    for (const [nast, sadrzaj] of [['service', t.service], ['timer', t.timer]] as const) {
      const dat = join(mapa, `${t.unit}.${nast}`)
      kopija(dat, mapaKopija, kopirano)
      upisi(dat, sadrzaj)
    }
    // Novi timer nije restart ploče ni daemona — smije se uključiti odmah.
    const r = Bun.spawnSync(['bash', '-c', `systemctl --user daemon-reload && systemctl --user enable --now ${t.unit}.timer`], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode === 0) ishod.promjena++
    else ishod.greske.push(`timer ${t.unit}: ${r.stderr.toString().trim().slice(0, 200)}`)
  }

  for (const u of po('upravitelj') as Extract<Primjena, { vrsta: 'upravitelj' }>[]) {
    kopija(u.cilj, mapaKopija, kopirano)
    upisi(u.cilj, u.sadrzaj)
    ishod.promjena++
  }
  if (kopirano.size) ishod.kopije = mapaKopija
  return ishod
}

// ─── Ispis i izlazni kod ─────────────────────────────────────────────────────

export function izlazniKod(stavke: Stavka[]): number {
  if (stavke.some(s0 => s0.vrsta === 'PREDUVJET')) return KOD.PREDUVJET
  if (stavke.some(s0 => s0.vrsta === 'RAZLIKA')) return KOD.RAZLIKA
  if (stavke.some(s0 => ['NEDOSTAJE', 'TAJNA-NEDOSTAJE', 'ČOVJEK'].includes(s0.vrsta))) return KOD.LJUDI
  return KOD.OK
}

const pr = (v: unknown) => JSON.stringify(v)

export function ispisStavki(stavke: Stavka[]): string[] {
  const out: string[] = []
  const moduli = [...new Set(stavke.map(s0 => s0.modul))]
  for (const m of moduli) {
    const ove = stavke.filter(s0 => s0.modul === m)
    const ok = ove.filter(s0 => s0.vrsta === 'OK' || s0.vrsta === 'TAJNA')
    out.push(`[${m}] ${ok.length}/${ove.length} OK`)
    for (const s0 of ove) {
      if (s0.vrsta === 'OK') continue
      if (s0.vrsta === 'RAZLIKA') out.push(`  RAZLIKA ${s0.kljuc}: profil=${pr(s0.profil)} čvor=${pr(s0.cvor)}`)
      else if (s0.vrsta === 'TAJNA') out.push(`  TAJNA postoji ${s0.kljuc}`)
      else if (s0.vrsta === 'TAJNA-NEDOSTAJE') out.push(`  TAJNA-NEDOSTAJE ${s0.kljuc}`)
      else out.push(`  ${s0.vrsta} ${s0.kljuc}${s0.poruka ? ` — ${s0.poruka}` : ''}${s0.profil !== undefined && s0.vrsta === 'NEDOSTAJE' ? ` (profil=${pr(s0.profil)} čvor=${pr(s0.cvor)})` : ''}`)
    }
  }
  const broj = (v: Vrsta) => stavke.filter(s0 => s0.vrsta === v).length
  out.push(`ZBROJ: OK ${broj('OK') + broj('TAJNA')} · RAZLIKA ${broj('RAZLIKA')} · NEDOSTAJE ${broj('NEDOSTAJE')} · TAJNA-NEDOSTAJE ${broj('TAJNA-NEDOSTAJE')} · ČOVJEK ${broj('ČOVJEK')} · PRESKOČENO ${broj('PRESKOČENO')} · PREDUVJET ${broj('PREDUVJET')}`)
  return out
}

// ─── Naredbeni redak ─────────────────────────────────────────────────────────

export interface Ovisnosti {
  home: string
  ispis: (redak: string) => void
  ploca?: Ploca
  sakupi?: (spec: SpecStanja) => Promise<StanjeCvora>
  sat: () => Date
  hostname: string
}

interface Opcije {
  naredba: string
  profil: string
  instanca?: string
  instancaVan?: string
  paket?: string
  ssh?: string
  ploca?: string
  moduli?: string[]
  suho: boolean
  pisi: boolean
  json: boolean
  bezSustava: boolean
}

function citajOpcije(argv: string[]): Opcije {
  const [naredba, ...ostalo] = argv
  if (!['provjeri', 'primijeni', 'izvezi'].includes(naredba || '')) throw new Odbijeno('naredba mora biti provjeri | primijeni | izvezi')
  const o: Opcije = { naredba, profil: 'upravitelj-cvora', suho: false, pisi: false, json: false, bezSustava: false }
  const S: Record<string, keyof Opcije> = { '--profil': 'profil', '--instanca': 'instanca', '--instanca-van': 'instancaVan', '--paket': 'paket', '--ssh': 'ssh', '--ploca': 'ploca' }
  for (let i = 0; i < ostalo.length; i++) {
    const a = ostalo[i]
    if (a in S) {
      const v = ostalo[++i]
      if (!v) throw new Odbijeno(`${a} traži vrijednost`)
      ;(o as any)[S[a]] = v
    } else if (a === '--modul') o.moduli = (ostalo[++i] || '').split(',').map(x => x.trim()).filter(Boolean)
    else if (a === '--suho') o.suho = true
    else if (a === '--pisi') o.pisi = true
    else if (a === '--json') o.json = true
    else if (a === '--bez-sustava') o.bezSustava = true
    else throw new Odbijeno(`nepoznata zastavica ${a}`)
  }
  if (o.suho && o.pisi) throw new Odbijeno('--suho i --pisi isključuju jedno drugo')
  if (o.pisi && o.naredba !== 'primijeni') throw new Odbijeno('--pisi vrijedi samo uz primijeni')
  if (o.pisi && o.ssh) throw new Odbijeno('--pisi preko --ssh je zabranjen: alat na tuđi čvor samo čita (ADR-0004 §5 pr. 4) — pokreni ga NA čvoru, uz odobrenje')
  if (o.naredba === 'izvezi' && !o.instancaVan) throw new Odbijeno('izvezi traži --instanca-van <env>')
  return o
}

function putProfila(ime: string): string {
  if (ime.endsWith('.json')) return isAbsolute(ime) ? ime : resolve(ime)
  return join(KORIJEN, 'profili', ime, 'profil.json')
}

/** Specifikacija sakupljaču: samo ono što profil imenuje (bijela lista). */
export function specZaProfil(p: Profil, inst: Record<string, string>, paket: string | undefined, sustav: boolean): SpecStanja {
  const M = p.moduli
  const kljucevi = ['razgovor', 'glas', 'memorija', 'bot-kanal'].flatMap(m => Object.keys((M as any)[m]?.settings || {}))
  const nikad = [...(M['bot-kanal']?.nikadNeIzvozi || []), ...(M.telegram?.nikadNeIzvozi || [])]
  const envKljucevi = [...Object.keys(M.okolina?.postavkeEnv || {})]
  if (M.telegram && !envKljucevi.includes('TM_TELEGRAM_CONFIG')) envKljucevi.push('TM_TELEGRAM_CONFIG')
  return {
    paket,
    varijable: inst,
    envKljucevi,
    envTajne: [...new Set([...(M.okolina?.tajneImenom || []), ...(M['bot-kanal']?.tajneImenom || [])])],
    envNesmije: M.okolina?.nesmijeBiti || [],
    telegramOblik: M.telegram?.json || {},
    epostaOblik: M.eposta?.json,
    telegramNikad: M.telegram?.nikadNeIzvozi || [],
    telegramTajne: M.telegram?.tajneImenom || [],
    settingsKljucevi: kljucevi,
    settingsNikad: nikad,
    capguardKljucevi: Object.keys(M.capguard?.zeljeno || {}),
    settingsJson: M.kuke?.datoteka || M.claude?.settingsJson.datoteka,
    kuke: [...new Set([...(M.claude?.kuke || []).map(k0 => k0.datoteka), ...(M.kuke?.popis || []).map(k0 => k0.datoteka)])],
    upravitelj: M.upravitelj?.cilj,
    grepNema: M.home ? { uzorak: putanja(M.home.grepNema.uzorak, inst), u: M.home.grepNema.u } : undefined,
    paketSadrzi: M.paket?.paketSadrzi || [],
    apiDatoteke: ['src/razgovor/RazgovorPostavke.ts', 'src/razgovor/BotKanalPostavke.ts'],
    znacajke: M.znacajke && zamijeni(M.znacajke.datoteka, inst) !== PRESKOCI
      ? { datoteka: M.znacajke.datoteka, kljucevi: Object.keys(M.znacajke.kljucevi), kodU: M.znacajke.kodU } : undefined,
    izvorni: M.paket?.izvorniSustavSadrzi && zamijeni(M.paket.izvorniSustavSadrzi.mapa, inst) !== PRESKOCI
      ? { mapa: M.paket.izvorniSustavSadrzi.mapa, datoteke: M.paket.izvorniSustavSadrzi.datoteke,
          grep: M.paket.izvorniSustavSadrzi.grep.map(g => ({ datoteka: g.datoteka, sadrzi: g.sadrzi })) } : undefined,
    znanje: sustav && (M.znanje || M.mogucnosti || M.memorija?.izolacija) ? {
      mogucnosti: M.mogucnosti?.datoteka, stanje: M.znanje?.stanje, korpus: M.znanje?.korpus, timer: M.znanje?.timer.unit,
      memorijaUrl: String(M.memorija?.settings['memorija.url'] || ''), banka: inst.MEMORIJA_BANKA || '',
      zabranjeniDokumenti: M.memorija?.izolacija?.zabranjeniDokumenti || [],
    } : undefined,
    konzola: {
      datoteke: [...(M.konzola?.izvori || []).filter(x => !x.preskoci).map(x => x.datoteka), ...(M.oporavak ? [M.oporavak.dnevnik] : [])],
      dropIni: [...(M.konzola?.izvori || []).filter(x => x.unit && !x.preskoci).map(x => dropInPut(x.unit!)),
        ...(M.oporavak?.tz?.unitovi || []).map(vrijemeDropInPut),
        ...(M.oporavak?.put?.unitovi || []).map(putDropInPut)],
    },
    sustav: sustav ? {
      unitovi: [...new Set([M.paket?.unit?.ime, M.glas?.servis?.unit, ...(M.konzola?.izvori || []).map(x => x.unit)].filter(Boolean))] as string[],
      vrata: [M.glas?.servis?.vrata, M['tunel-memorije']?.provjeraNaCvoru.vrata].filter(x => typeof x === 'number') as number[],
      alati: Object.keys(M.paket?.alati || {}),
    } : undefined,
  }
}

/** Sakupljač na tuđem čvoru: datoteka ide SSH standardnim ulazom, na čvoru se ništa ne piše. */
export function sakupiPrekoSsh(cilj: string): (spec: SpecStanja) => Promise<StanjeCvora> {
  return async spec => {
    const kod = readFileSync(join(import.meta.dir, 'profil-cvora-stanje.ts'))
    const arg = Buffer.from(JSON.stringify(spec)).toString('base64')
    const p = Bun.spawn(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', cilj,
      `PATH="$HOME/.bun/bin:$PATH" bun run - ${arg}`], { stdin: kod, stdout: 'pipe', stderr: 'pipe' })
    const [izlaz, greska, kraj] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (kraj !== 0) throw new GreskaPreduvjeta(`sakupljač na ${cilj} pao (${kraj}): ${greska.trim().slice(0, 300)}`)
    return JSON.parse(izlaz)
  }
}

export async function glavna(argv: string[], d: Partial<Ovisnosti> = {}): Promise<number> {
  const ovis: Ovisnosti = {
    home: process.env.HOME || '', ispis: r => console.log(r), sat: () => new Date(), hostname: hostname(), ...d,
  }
  const pisi = ovis.ispis
  let o: Opcije
  try { o = citajOpcije(argv) } catch (e: any) { pisi(`ODBIJENO: ${e.message}`); return KOD.ODBIJENO }

  try {
    const profil = ucitajProfil(putProfila(o.profil))
    const sakupi = d.sakupi || (o.ssh ? sakupiPrekoSsh(o.ssh) : (spec: SpecStanja) => prikupiStanje(spec, ovis.home))
    const paket = o.paket || (o.ssh ? undefined : KORIJEN)

    // Instanca: --instanca ili $TM_HOME/config/profil.instanca.env (TM_HOME iz postavke.env čvora).
    let instPut = o.instanca
    if (!instPut && !o.ssh) {
      const env = citajEnv(join(paket!, 'config', 'postavke.env'))
      instPut = join(env.TM_HOME || join(ovis.home, '.taskmanager'), 'config', 'profil.instanca.env')
    }
    let inst: Record<string, string> | null = null
    if (o.naredba !== 'izvezi') {
      if (!instPut || !existsSync(instPut)) throw new GreskaPreduvjeta(`nema instance ${instPut || '(--instanca)'} — kopiraj profili/${profil.profil}/instanca.primjer.env i upiši vrijednosti čvora`)
      inst = citajEnv(instPut)
    } else if (instPut && existsSync(instPut)) inst = citajEnv(instPut)
    provjeriVarijable(profil, o.naredba === 'izvezi' ? null : inst)

    let stanje = await sakupi(specZaProfil(profil, inst || {}, paket, !o.bezSustava))
    const { karta, zadano } = await kartaApija()
    const kontekst = (i: Record<string, string>): Kontekst =>
      ({ profil, inst: i, stanje, karta, zadano, korijen: KORIJEN, hostname: ovis.hostname })

    if (o.naredba === 'izvezi') {
      const { inst: izvedena, sukobi } = izvediInstancu(profil, stanje)
      const puna: Record<string, string> = {}
      for (const k0 of [...profil.instanca.obavezno, ...profil.instanca.neobavezno]) puna[k0] = izvedena[k0] ?? inst?.[k0] ?? ''
      upisi(o.instancaVan!, instancaUTekst(profil, puna, new Set(Object.keys(izvedena)), o.ssh || 'lokalni čvor'))
      const stavke = usporedi(kontekst(puna))
      const izvor = `izvezeno ${Object.keys(izvedena).length}/${Object.keys(puna).length} varijabli → ${o.instancaVan}`
      if (o.json) pisi(JSON.stringify({ naredba: 'izvezi', izvor, sukobi, stavke: stavke.map(bezPrimjene) }))
      else { pisi(izvor); sukobi.forEach(x => pisi(`SUKOB ${x}`)); ispisStavki(stavke).forEach(pisi) }
      return izlazniKod(stavke)
    }

    let stavke = usporedi(kontekst(inst!))
    if (o.moduli) stavke = stavke.filter(s0 => o.moduli!.includes(s0.modul))
    if (o.naredba === 'provjeri' || !o.pisi) {
      const kod = izlazniKod(stavke)
      if (o.json) pisi(JSON.stringify({ naredba: o.naredba, suho: o.naredba === 'primijeni', kod, stavke: stavke.map(bezPrimjene) }))
      else {
        ispisStavki(stavke).forEach(pisi)
        if (o.naredba === 'primijeni') pisi(`SUHO: primijenilo bi se ${stavke.filter(s0 => s0.primjena).length} stavki (ništa nije zapisano; za pisanje --pisi)`)
      }
      return kod
    }

    // --pisi: preduvjet mora biti ispunjen prije ijednog upisa.
    if (stavke.some(s0 => s0.vrsta === 'PREDUVJET')) {
      ispisStavki(stavke.filter(s0 => s0.vrsta === 'PREDUVJET')).forEach(pisi)
      pisi('ODBIJENO: preduvjet nije ispunjen — ništa nije zapisano')
      return KOD.PREDUVJET
    }
    const ploca = d.ploca || plocaHttp(o.ploca || `http://127.0.0.1:${stanje.env.TM_PORT || '17781'}`)
    const ishod = await primijeni(stavke, kontekst(inst!), ploca, ovis.sat())
    stanje = await sakupi(specZaProfil(profil, inst!, paket, !o.bezSustava))
    let poslije = usporedi(kontekst(inst!))
    if (o.moduli) poslije = poslije.filter(s0 => o.moduli!.includes(s0.modul))
    const kod = ishod.greske.length ? KOD.RAZLIKA : izlazniKod(poslije)
    if (o.json) pisi(JSON.stringify({ naredba: 'primijeni', ...ishod, kod, stavke: poslije.map(bezPrimjene) }))
    else {
      pisi(`PRIMIJENJENO: ${ishod.promjena} promjena${ishod.kopije ? ` · kopije u ${ishod.kopije}` : ''}`)
      ishod.greske.forEach(g => pisi(`GREŠKA ${g}`))
      pisi(`potreban restart regoc-taskmanager: ${ishod.restart ? 'da (alat ga ne radi — kad je 0 zadataka in_progress)' : 'ne'}`)
      if (ishod.unitovi.length) pisi(`drop-in (konzola, vrijeme, PATH): systemctl --user daemon-reload, pa restart ${ishod.unitovi.join(', ')} (alat ga ne radi — kad je 0 zadataka in_progress)`)
      ispisStavki(poslije).forEach(pisi)
    }
    return kod
  } catch (e: any) {
    if (e instanceof GreskaPreduvjeta) { pisi(`PREDUVJET: ${e.message}`); return KOD.PREDUVJET }
    if (e instanceof Odbijeno) { pisi(`ODBIJENO: ${e.message}`); return KOD.ODBIJENO }
    throw e
  }
}

function bezPrimjene(s0: Stavka): Omit<Stavka, 'primjena'> {
  const { primjena: _p, ...ostalo } = s0
  return ostalo
}

if (import.meta.main) {
  process.exit(await glavna(process.argv.slice(2)))
}
