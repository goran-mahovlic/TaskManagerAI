#!/usr/bin/env bun
/**
 * Savjet glavnog sustava drugom botu → tematski paket znanja → banka čvora (TASK-5341).
 * Radi NA GLAVNOM STROJU (ondje su kod, karta, memorija i privatni popis); čvor ništa ne pokreće.
 *
 *   bun scripts/savjet-cvoru.ts sastavi --pitanje <dat> --odgovor <dat> --izlaz <paket.json> [--izvori a,b] [--model sonnet]
 *   bun scripts/savjet-cvoru.ts upisi   --paket <paket.json> --banka <id> --privatno <popis> [--url <memorija>]
 *                                       [--ploca <url čvora> --chat <id>] [--zapis <mapa>] [--suho]
 *   bun scripts/savjet-cvoru.ts auto    (sastavi + upisi; paket ide u --zapis)
 *
 * Zajedničko: `--cvor <ime>` i `--bot <ime>` (u tekstu dokumenta), `--tudi-home <put>` (naš HOME → `~`, zadano $HOME),
 * `--cvor-home <put>` (HOME čvora: njegove apsolutne putanje smiju u banku).
 * `--url` zadano `http://127.0.0.1:17795` = posrednik memorije (ADR-0006 §8 B): propušta samo banku
 * čvora, pa savjet ne može završiti u našoj banci ni greškom.
 *
 * Filtar je OBAVEZAN: bez `--privatno` (popis koji živi samo kod nas) upis se odbija.
 * Dokument: `savjet/<tema>` (zamjenjuje stariji savjet iste teme). Trag: bilješka u najnovijem
 * razgovornom zadatku tog chata na ploči čvora (TASK-5337); ako ga nema, otvara se zadatak traga.
 *
 * Izlazni kodovi: 0 OK · 1 kvar (model, banka) · 2 neispravan poziv · 3 vrata kvote (429) ·
 * 5 filtar je odbio paket (ništa nije upisano).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { ucitajPrivatno } from '../src/znanje/Korpus'
import {
  biljeskaTraga, brojCinjenica, dokumentSavjeta, idSavjeta, parsirajPaket, procistiSavjet, promptSastavljaca,
  slugTeme, zadatakZaTrag, type PaketZnanja, type Trag,
} from '../src/znanje/Savjet'

const KORIJEN = resolve(import.meta.dir, '..')
const HOME = process.env.HOME || homedir()

interface Argumenti {
  naredba: string
  pitanje?: string; odgovor?: string; izlaz?: string; paket?: string; izvori?: string; model?: string
  banka?: string; privatno?: string; url: string; ploca?: string; chat?: string; zapis?: string
  cvor: string; bot: string; tudiHome: string; cvorHome?: string; suho: boolean; rokS: number
}

function argumenti(argv: string[]): Argumenti {
  const [naredba, ...ost] = argv
  if (!['sastavi', 'upisi', 'auto'].includes(naredba || '')) throw new Error('naredba: sastavi | upisi | auto')
  const a: Argumenti = { naredba, url: 'http://127.0.0.1:17795', cvor: 'čvor', bot: 'bot čvora', tudiHome: HOME, suho: false, rokS: 420 }
  const kljucevi: Record<string, keyof Argumenti> = {
    '--pitanje': 'pitanje', '--odgovor': 'odgovor', '--izlaz': 'izlaz', '--paket': 'paket', '--izvori': 'izvori', '--model': 'model',
    '--banka': 'banka', '--privatno': 'privatno', '--url': 'url', '--ploca': 'ploca', '--chat': 'chat', '--zapis': 'zapis',
    '--cvor': 'cvor', '--bot': 'bot', '--tudi-home': 'tudiHome', '--cvor-home': 'cvorHome', '--rok-s': 'rokS',
  }
  for (let i = 0; i < ost.length; i++) {
    const x = ost[i]
    if (x === '--suho') { a.suho = true; continue }
    const k = kljucevi[x]
    if (!k) throw new Error(`nepoznata zastavica ${x}`)
    const v = ost[++i]
    if (v === undefined) throw new Error(`${x} traži vrijednost`)
    ;(a as any)[k] = k === 'rokS' ? Number(v) : v
  }
  if (a.naredba !== 'upisi' && (!a.pitanje || !a.odgovor)) throw new Error('obavezno: --pitanje i --odgovor (datoteke)')
  if (a.naredba === 'sastavi' && !a.izlaz) throw new Error('sastavi traži --izlaz')
  if (a.naredba === 'upisi' && !a.paket) throw new Error('upisi traži --paket')
  if (a.naredba !== 'sastavi') {
    if (!a.banka) throw new Error('obavezno: --banka')
    if (!a.privatno) throw new Error('obavezno: --privatno (filtar privatnog nije izboran)')
    if (!existsSync(a.privatno)) throw new Error(`nema privatnog popisa ${a.privatno} — bez filtra se ne upisuje`)
    if (a.chat && !/^-?\d+$/.test(a.chat)) throw new Error('--chat mora biti brojčani id')
  }
  if (a.naredba === 'auto' && !a.zapis) throw new Error('auto traži --zapis (mapa za paket i dokument)')
  return a
}

// ─── sastavi: model samo čita izvore ─────────────────────────────────────────

const DOPUSTENA_OKOLINA = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', 'SHELL',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']

export function argumentiModela(izvori: string[], model?: string): string[] {
  return [
    '-p', '--output-format', 'json',
    '--setting-sources', '', '--strict-mcp-config',
    '--permission-mode', 'default',
    '--tools', 'Read,Glob,Grep',
    '--allowedTools', ...izvori.flatMap(d => [`Read(/${d}/**)`, `Glob(/${d}/**)`, `Grep(/${d}/**)`]),
    ...izvori.flatMap(d => ['--add-dir', d]),
    ...(model ? ['--model', model] : []),
  ]
}

/**
 * Zadano samo paket: kod, docs i `znanje/sustav/` (karta sustava već provučena kroz tablicu opsega,
 * ADR-0006 §4.3). Sirova karta glavnog stroja nije zadani izvor — bijelu listu po odjeljku model ne
 * bi poštovao, a filtar savjeta je crna lista (druga linija). Dodaje se samo izričito `--izvori`.
 */
function zadaniIzvori(): string[] {
  return [KORIJEN]
}

async function sastavi(a: Argumenti, ispis: (r: string) => void): Promise<PaketZnanja | null> {
  const izvori = a.izvori ? a.izvori.split(',').map(s => resolve(s.trim())).filter(Boolean) : zadaniIzvori()
  const prompt = promptSastavljaca({
    pitanje: readFileSync(a.pitanje!, 'utf-8'), odgovor: readFileSync(a.odgovor!, 'utf-8'), cvor: a.cvor, bot: a.bot, cvorHome: a.cvorHome, izvori,
  })
  const env: Record<string, string> = {}
  for (const k of DOPUSTENA_OKOLINA) if (process.env[k] !== undefined) env[k] = process.env[k]!
  env.REGOC_SESIJA = 'savjet-cvoru'
  const t0 = performance.now()
  const proc = Bun.spawn(['claude', ...argumentiModela(izvori, a.model ?? 'sonnet')], {
    cwd: KORIJEN, stdin: new TextEncoder().encode(prompt), stdout: 'pipe', stderr: 'pipe', env,
  })
  const rok = setTimeout(() => { try { proc.kill() } catch { /* gotov */ } }, a.rokS * 1000)
  const [izlaz, greska] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(rok)
  const s = ((performance.now() - t0) / 1000).toFixed(0)
  if (proc.exitCode !== 0) { ispis(`ERR model exit ${proc.exitCode} (${s}s): ${greska.slice(0, 200)}`); return null }
  let tekst = izlaz
  try { const j = JSON.parse(izlaz); if (j.is_error) { ispis(`ERR model: ${String(j.result).slice(0, 200)}`); return null } tekst = String(j.result ?? '') } catch { /* gol tekst */ }
  const p = parsirajPaket(tekst)
  if (!p) {
    const sirovo = a.izlaz ? `${a.izlaz}.sirovo.txt` : a.zapis ? join(a.zapis, 'zadnji_neispravan_paket.txt') : null
    if (sirovo) { try { writeFileSync(sirovo, tekst, { mode: 0o600 }) } catch { /* samo dijagnostika */ } }
    ispis(`ERR model nije vratio paket (${s}s)${sirovo ? ` — izlaz u ${sirovo}` : ''}: ${tekst.slice(0, 200)}`)
    return null
  }
  ispis(`paket sastavljen (${s}s): „${p.tema}", ${brojCinjenica(p)} činjenica`)
  return p
}

// ─── upisi: filtar → banka → trag ────────────────────────────────────────────

async function trag(a: Argumenti, t: Trag, ispis: (r: string) => void): Promise<void> {
  if (!a.ploca || !a.chat) return
  const ploca = a.ploca.replace(/\/+$/, '')
  const biljeska = biljeskaTraga(t)
  try {
    const r = await fetch(`${ploca}/api/tasks`, { signal: AbortSignal.timeout(15_000) })
    const j: any = await r.json()
    const zadaci = Array.isArray(j) ? j : (j?.tasks ?? [])
    let id = zadatakZaTrag(zadaci, a.chat)
    if (!id) {
      const n = await fetch(`${ploca}/api/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          title: `🧠 Znanje od Klaudija · ${t.tema || 'savjet'}`.slice(0, 120),
          description: `Trag upisa znanja u banku čvora (TASK-5341): glavni sustav je odgovorio botu ${a.bot} i složio tematski paket znanja. `
            + 'Zadatak nema nositelja i nije posao za agenta (no-autonomy).',
          tags: ['razgovor', 'no-autonomy', `chat:telegram:${a.chat}`, 'znanje'], priority: '3',
        }),
      })
      id = ((await n.json()) as any)?.id ?? null
    }
    if (!id) { ispis('trag: ploča čvora nije dala zadatak'); return }
    const p = await fetch(`${ploca}/api/tasks/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ progressNotes: [biljeska] }),
    })
    ispis(`trag: ${id} ← bilješka (http ${p.status})`)
  } catch (e: any) { ispis(`trag: ploča čvora ne odgovara (${String(e?.message || e).slice(0, 100)})`) }
}

async function upisi(a: Argumenti, sirovi: PaketZnanja, ispis: (r: string) => void): Promise<number> {
  const privatno = ucitajPrivatno(readFileSync(a.privatno!, 'utf-8'))
  const f = procistiSavjet(sirovi, privatno, { tudiHome: a.tudiHome, cvorHome: a.cvorHome })
  // Odbijen paket: ni tema ni ključ ne idu na ploču čvora (nisu prošli filtar).
  const id = f.paket ? idSavjeta(f.paket.tema, f.paket.kljuc) : 'savjet/(odbijeno)'
  const temaZaTrag = f.paket?.tema ?? ''
  if (!f.paket) {
    ispis(`FILTAR: paket ne ulazi — ${f.razlog}`)
    await trag(a, { banka: a.banka!, id, tema: temaZaTrag, cinjenica: 0, izbaceno: f.izbaceno, ishod: 'odbijeno', razlog: `filtar: ${f.razlog}` }, ispis)
    return 5
  }
  const doc = dokumentSavjeta(f.paket, { cvor: a.cvor, bot: a.bot })
  const n = brojCinjenica(f.paket)
  ispis(`filtar: ${n} činjenica ulazi, ${f.izbaceno} izbačeno, ${f.redigirano} rečenica izrezano iz pitanja/odgovora → ${id}`)
  if (a.zapis) {
    mkdirSync(a.zapis, { recursive: true, mode: 0o700 })
    writeFileSync(join(a.zapis, `${id.replace('/', '_')}.md`), doc, { mode: 0o600 })
  }
  if (a.suho) { ispis(`SUHO: ništa nije upisano\n${doc}`); return 0 }

  const api = `${a.url.replace(/\/+$/, '')}/v1/default/banks/${encodeURIComponent(a.banka!)}`
  const t0 = performance.now()
  // Brisanje pa upis = čisto ponovno izvlačenje činjenica (isti obrazac kao znanje-cvora upisi).
  await fetch(`${api}/documents/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(120_000) }).catch(() => null)
  let r: Response
  try {
    r = await fetch(`${api}/memories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30 * 60_000),
      body: JSON.stringify({
        async: false,
        items: [{
          content: doc, document_id: id, update_mode: 'replace', tags: ['savjet', 'glavni-sustav'],
          context: `Znanje o općem sustavu REGOČ koje je glavni sustav dao botu ${a.bot} (čvor ${a.cvor}); tema: ${f.paket.tema}`,
          metadata: { izvor: 'savjet', cvor: a.cvor },
        }],
      }),
    })
  } catch (e: any) {
    ispis(`ERR banka: ${String(e?.message || e).slice(0, 120)}`)
    await trag(a, { banka: a.banka!, id, tema: temaZaTrag, cinjenica: n, izbaceno: f.izbaceno, ishod: 'kvar', razlog: 'banka ne odgovara' }, ispis)
    return 1
  }
  const s = ((performance.now() - t0) / 1000).toFixed(1)
  if (r.status === 429) {
    ispis(`STOP: vrata kvote zatvorena — paket nije upisan (${s}s)`)
    await trag(a, { banka: a.banka!, id, tema: temaZaTrag, cinjenica: n, izbaceno: f.izbaceno, ishod: 'kvar', razlog: 'vrata kvote zatvorena (429)' }, ispis)
    return 3
  }
  if (!r.ok) {
    ispis(`ERR banka http=${r.status} (${s}s)`)
    await trag(a, { banka: a.banka!, id, tema: temaZaTrag, cinjenica: n, izbaceno: f.izbaceno, ishod: 'kvar', razlog: `banka http ${r.status}` }, ispis)
    return 1
  }
  ispis(`OK ${id} → ${a.banka} (${s}s)`)
  await trag(a, { banka: a.banka!, id, tema: f.paket.tema, cinjenica: n, izbaceno: f.izbaceno, ishod: 'upisano' }, ispis)
  return 0
}

export async function glavna(argv: string[], ispis: (r: string) => void = console.log): Promise<number> {
  let a: Argumenti
  try { a = argumenti(argv) } catch (e: any) { ispis(`ODBIJENO: ${e.message}`); return 2 }
  if (a.naredba === 'upisi') {
    const p = parsirajPaket(readFileSync(a.paket!, 'utf-8'))
    if (!p) { ispis(`ODBIJENO: ${a.paket} nije paket znanja`); return 2 }
    return upisi(a, p, ispis)
  }
  // Model ponekad vrati neispravan JSON (navodnici u tekstu) — jedan ponovni pokušaj.
  const p = await sastavi(a, ispis) ?? await sastavi(a, ispis)
  if (!p) return 1
  if (a.naredba === 'sastavi') {
    writeFileSync(a.izlaz!, JSON.stringify(p, null, 1) + '\n', { mode: 0o600 })
    ispis(`zapisano ${a.izlaz}`)
    return 0
  }
  mkdirSync(a.zapis!, { recursive: true, mode: 0o700 })
  writeFileSync(join(a.zapis!, `paket_${slugTeme(p.kljuc || p.tema)}.json`), JSON.stringify(p, null, 1) + '\n', { mode: 0o600 })
  return upisi(a, p, ispis)
}

if (import.meta.main) process.exit(await glavna(process.argv.slice(2)))
