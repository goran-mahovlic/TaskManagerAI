/**
 * ollama-gpu-lock — advisory lock za serijalizaciju pristupa lokalnom GPU-u
 * (Ollama na jednom GPU stroju). Potjeh/Gita (dugi chat) i RAG (kratki embedding)
 * dijele istu mašinu; ovaj lock osigurava da NE idu istovremeno — čekaju u redu
 * (nema gubitka, samo pričekaju izmjenu modela).
 *
 * SIGURNOST: lock je PID-vezan; ako držatelj umre, sljedeći tražitelj vidi mrtav
 * PID i preuzme (steal) — pa NEMA trajnog deadlocka ni ako proces crasha.
 */
import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
const LOCK = join(HOME, '.claude/regoc/.ollama-gpu.lock')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }

async function acquire(label: string, maxWaitMs: number): Promise<{ got: boolean; waitedMs: number }> {
  const start = Date.now(), deadline = start + maxWaitMs
  // jitter za smanjenje thundering-herd; index-slobodno (nema Math.random ovisnosti o determinizmu)
  let attempt = 0
  while (true) {
    try {
      const fd = openSync(LOCK, 'wx')  // O_EXCL — atomarno; baca ako postoji
      writeSync(fd, JSON.stringify({ pid: process.pid, label, ts: Date.now() }))
      closeSync(fd)
      return { got: true, waitedMs: Date.now() - start }
    } catch {
      // postoji — provjeri je li mrtav (steal) ili živ (čekaj)
      let steal = false
      try {
        const cur = JSON.parse(readFileSync(LOCK, 'utf-8'))
        if (!cur.pid || !pidAlive(cur.pid)) steal = true
      } catch { steal = true }  // korumpiran/prazan → preuzmi
      if (steal) { try { unlinkSync(LOCK) } catch {}; continue }
      if (Date.now() >= deadline) return { got: false, waitedMs: Date.now() - start }
      await sleep(250 + (attempt++ % 5) * 120)
    }
  }
}

function release(): void {
  try {
    const cur = JSON.parse(readFileSync(LOCK, 'utf-8'))
    if (cur.pid === process.pid) unlinkSync(LOCK)
  } catch {}
}

/**
 * Izvrši fn dok držiš GPU lock. opts.proceedOnTimeout=true → ako se lock ne dobije
 * u maxWaitMs, svejedno nastavi (bez locka) i javi got=false (za RAG: nikad ne pada).
 */
export async function withGpuLock<T>(
  label: string,
  opts: { maxWaitMs?: number; proceedOnTimeout?: boolean },
  fn: (info: { got: boolean; waitedMs: number }) => Promise<T>,
): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? 300000
  const info = await acquire(label, maxWaitMs)
  if (!info.got && !opts.proceedOnTimeout) {
    throw new Error(`GPU lock timeout nakon ${info.waitedMs}ms (label=${label})`)
  }
  const onExit = () => release()
  process.on('exit', onExit)
  try {
    return await fn(info)
  } finally {
    if (info.got) release()
    process.off('exit', onExit)
  }
}
