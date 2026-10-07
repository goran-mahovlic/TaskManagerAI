#!/usr/bin/env bun
/**
 * Posrednik memorije (ADR-0006 §8, opcija B) — pokreće se na stroju koji drži Hindsight, a tunel
 * čvora pokazuje na njega umjesto na Hindsight. Čvor tada vidi samo svoju banku.
 *
 *   POSREDNIK_BANKE=banka_cvora bun scripts/memorija-posrednik.ts
 *
 * Okolina (sve osim BANKE ima zadano):
 *   POSREDNIK_BANKE         dopuštene banke, zarezom (obavezno; prazno = odbij pokretanje)
 *   POSREDNIK_HOST/PORT     gdje sluša (zadano 127.0.0.1:17795 — samo loopback, kao i tunel; 17793/17794 zauzima Hindsight)
 *   POSREDNIK_CILJ          Hindsight (zadano http://127.0.0.1:17792)
 *   POSREDNIK_VRATA         naredba koja ispiše JSON {smije, razlog} (vrata kvote prije retaina);
 *                           prazno = bez vrata. Rezultat se drži 60 s.
 *   POSREDNIK_BRAVA         datoteka brave retaina ({pid, banka}); prazno = bez brave
 *   POSREDNIK_ZAPIS         JSONL zapis odluka (bez tijela zahtjeva)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createPosrednik, type Vrata } from '../src/znanje/Posrednik'

const env = process.env
const banke = (env.POSREDNIK_BANKE || '').split(',').map(s => s.trim()).filter(Boolean)
if (!banke.length) {
  console.error('POSREDNIK_BANKE je prazan — posrednik bez dopuštene banke ne smije raditi')
  process.exit(3)
}
const host = env.POSREDNIK_HOST || '127.0.0.1'
const port = Number(env.POSREDNIK_PORT || 17795)
const cilj = env.POSREDNIK_CILJ || 'http://127.0.0.1:17792'

let vrataKes: { t: number; v: Vrata } | null = null
const vrata = env.POSREDNIK_VRATA
  ? async (): Promise<Vrata> => {
    if (vrataKes && Date.now() - vrataKes.t < 60_000) return vrataKes.v
    const p = Bun.spawn(['bash', '-c', env.POSREDNIK_VRATA!], { stdout: 'pipe', stderr: 'pipe' })
    const izlaz = await new Response(p.stdout).text()
    await p.exited
    let v: Vrata
    try { v = JSON.parse(izlaz.trim().split('\n').pop() || '{}') } catch { v = { smije: false, razlog: 'vrata nečitljiva' } }
    vrataKes = { t: Date.now(), v }
    return v
  }
  : undefined

// Brava: tuđu živu bravu (gradnja banke) ne diramo; svoju držimo dok traje bar jedan retain.
let drzim = 0
const zivi = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const brava = env.POSREDNIK_BRAVA
  ? {
    uzmi: () => {
      drzim++
      const put = env.POSREDNIK_BRAVA!
      try {
        if (existsSync(put)) {
          const l = JSON.parse(readFileSync(put, 'utf-8'))
          if (Number(l.pid) !== process.pid && zivi(Number(l.pid))) return
        }
      } catch { /* pokvarena = preuzmi */ }
      mkdirSync(dirname(put), { recursive: true })
      writeFileSync(put, JSON.stringify({ pid: process.pid, banka: banke.join(','), posrednik: true, od: new Date().toISOString() }))
    },
    pusti: () => {
      drzim = Math.max(0, drzim - 1)
      if (drzim) return
      const put = env.POSREDNIK_BRAVA!
      try { if (Number(JSON.parse(readFileSync(put, 'utf-8')).pid) === process.pid) unlinkSync(put) } catch { /* nema */ }
    },
  }
  : undefined

const zapis = env.POSREDNIK_ZAPIS
  ? (red: Record<string, unknown>) => {
    try {
      mkdirSync(dirname(env.POSREDNIK_ZAPIS!), { recursive: true })
      appendFileSync(env.POSREDNIK_ZAPIS!, JSON.stringify({ ts: new Date().toISOString(), ...red }) + '\n')
    } catch { /* zapis nikad ne ruši posrednika */ }
  }
  : undefined

const obradi = createPosrednik({ cilj, banke, vrata, brava, zapis })
Bun.serve({ hostname: host, port, idleTimeout: 0, fetch: obradi })
console.log(`posrednik memorije ${host}:${port} → ${cilj}; banke: ${banke.join(', ')}; vrata: ${vrata ? 'da' : 'ne'}; brava: ${brava ? 'da' : 'ne'}`)
