#!/usr/bin/env bun
/**
 * TASK-5331 — curi li banka čvora naše privatne podatke (ADR-0006 §9.2, mjerilo P1 u malom).
 *
 *   bun docs/qa/TASK-5331/mjeri_curenje.ts --url http://127.0.0.1:17792 --privatno <popis> \
 *       --banka <banka> [--banka <druga>] [--iskljuci PRJ-001,PRJ-002] [--detalj <datoteka>]
 *
 * Za svaki izraz s privatnog popisa (osim kategorije `vlasnik` i izraza iz --iskljuci, npr. ID-eva
 * projekata koje čvor ima i SAM na svojoj ploči) radi recall i broji rezultate čiji tekst sadrži
 * taj izraz. Ispis su samo BROJEVI po kategoriji — izrazi su naš podatak; `--detalj` piše izraze
 * u datoteku izvan paketa (0600). Samo čitanje (recall ne troši LLM).
 */
import { chmodSync, readFileSync, writeFileSync } from 'fs'

const a = process.argv.slice(2)
const vr = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined }
const url = (vr('--url') || 'http://127.0.0.1:17792').replace(/\/+$/, '')
const banke = a.flatMap((x, i) => (x === '--banka' ? [a[i + 1]] : []))
const iskljuci = new Set((vr('--iskljuci') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
const izrazi = readFileSync(vr('--privatno')!, 'utf-8').split('\n')
  .filter(r => r.includes('\t') && !r.startsWith('#'))
  .map(r => { const [kat, izraz] = r.split('\t'); return { kat: kat.trim(), izraz: izraz.trim() } })
  .filter(x => x.kat !== 'vlasnik' && x.izraz && !iskljuci.has(x.izraz.toLowerCase()) && !['nextcloud', 'docuseal'].includes(x.izraz.toLowerCase()))

const detalj: string[] = []
for (const banka of banke) {
  const poKat: Record<string, { upita: number; sPogotkom: number; rezultata: number }> = {}
  for (const { kat, izraz } of izrazi) {
    const r = await fetch(`${url}/v1/default/banks/${encodeURIComponent(banka)}/memories/recall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: izraz, budget: 'low', max_tokens: 2048 }), signal: AbortSignal.timeout(60_000),
    })
    const j: any = r.ok ? await r.json() : { results: [] }
    const tekstovi: string[] = (j.results || []).map((x: any) => String(x.text || x.content || ''))
    const pog = tekstovi.filter(t => t.toLowerCase().includes(izraz.toLowerCase())).length
    poKat[kat] ||= { upita: 0, sPogotkom: 0, rezultata: 0 }
    poKat[kat].upita++
    poKat[kat].rezultata += pog
    if (pog) { poKat[kat].sPogotkom++; detalj.push(`${banka}\t${kat}\t${izraz}\t${pog}`) }
  }
  const uk = Object.values(poKat).reduce((s, x) => ({ upita: s.upita + x.upita, sPogotkom: s.sPogotkom + x.sPogotkom, rezultata: s.rezultata + x.rezultata }), { upita: 0, sPogotkom: 0, rezultata: 0 })
  console.log(`${banka}: upita ${uk.upita}, izraza s privatnom činjenicom ${uk.sPogotkom}, rezultata s izrazom ${uk.rezultata}`
    + ` — ${Object.entries(poKat).map(([k, x]) => `${k} ${x.sPogotkom}/${x.upita}`).join(', ')}`)
}
const d = vr('--detalj')
if (d) { writeFileSync(d, detalj.join('\n') + '\n'); chmodSync(d, 0o600) }
