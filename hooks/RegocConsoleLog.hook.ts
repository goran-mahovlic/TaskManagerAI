#!/usr/bin/env bun
// RegocConsoleLog — rad agenata u konzoli ploče (izvor `regoc`, ADR-0004 §13.2.3).
//
// Claude Code hook za PostToolUse (matcher Bash|Edit|MultiEdit|Write|NotebookEdit|Task). Nakon
// svakog alata koji mijenja stanje dopiše JEDAN redak u $HOME/.tmp/regoc_logs/regoc.log, koji
// ploča prati (logSources u src/TaskWebUI.ts) i šalje u konzolu. Agent daemona dobiva u okolini
// REGOC_AGENT_ID i REGOC_TASK_ID (izvođač paketa daje TM_TASK_ID) — oni idu u redak, pa se
// vidi TKO radi i NA ČEMU; ručna sesija je „sesija". Registracija: modul `kuke` profila čvora.
//
// Načela: nikad ne ruši ni ne usporava rad (sve u try/catch, bez mreže); ne zapisuje sadržaj
// datoteka ni izlaz naredbi (tajne, šum) — samo ŠTO je pozvano; Read/Grep/Glob se preskaču.
import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const LOG = join(process.env.HOME || homedir(), '.tmp', 'regoc_logs', 'regoc.log')
const PRIKAZI = new Set(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Task'])

function kratko(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function opis(alat: string, ulaz: any): string {
  switch (alat) {
    case 'Bash': return kratko(ulaz?.description || ulaz?.command, 160)
    case 'Edit':
    case 'MultiEdit': return `uređujem ${kratko(ulaz?.file_path, 90)}`
    case 'Write': return `pišem ${kratko(ulaz?.file_path, 90)}`
    case 'NotebookEdit': return `bilježnica ${kratko(ulaz?.notebook_path, 90)}`
    case 'Task': return `podagent: ${kratko(ulaz?.description, 90)}`
    default: return ''
  }
}

try {
  const dog = JSON.parse((await Bun.stdin.text()) || '{}')
  const alat = String(dog?.tool_name || dog?.toolName || '')
  if (PRIKAZI.has(alat)) {
    const e = process.env
    const tko = kratko(e.REGOC_AGENT_ID || e.TM_AGENT || 'sesija', 40)
    const zadatak = e.REGOC_TASK_ID || e.TM_TASK_ID
    const redak = `[${new Date().toISOString()}] ⚙️ ${tko}${zadatak ? ` · ${kratko(zadatak, 30)}` : ''} · ${alat}: ${opis(alat, dog?.tool_input ?? dog?.toolInput)}\n`
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, redak)
  }
} catch { /* fail-open: kuka nikad ne prekida rad */ }
process.exit(0)
