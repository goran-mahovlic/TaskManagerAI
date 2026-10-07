// TASK-5308: PASIVNO slušaj WebSocket ploče — redak konzole iz STVARNOG rada agenta (ne sintetski poziv kuke).
const [url, trazi, sek] = [process.argv[2], process.argv[3] || 'TASK-', Number(process.argv[4] || 600)]
const ws = new WebSocket(url)
const izvori = new Map<string, number>()
const rok = setTimeout(() => { console.log('ISTEKLO; izvori:', JSON.stringify([...izvori])); process.exit(1) }, sek * 1000)
ws.onmessage = (e) => {
  try {
    const m = JSON.parse(String(e.data))
    if (m.type !== 'console_output') return
    izvori.set(m.source, (izvori.get(m.source) || 0) + 1)
    if (m.source === 'regoc' && String(m.text).includes(trazi)) {
      console.log('PRIMLJENO', JSON.stringify(m).slice(0, 300), 'izvori:', JSON.stringify([...izvori]))
      clearTimeout(rok); process.exit(0)
    }
  } catch {}
}
