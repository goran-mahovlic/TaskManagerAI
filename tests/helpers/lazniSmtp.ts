// Najmanji SMTP poslužitelj za testove (TASK-5378; izvučeno u TASK-5509 za odgovor preko ploče).
// Bilježi primatelje (RCPT) i sirove podatke (DATA) svake poruke.

export interface LazniMail { rcpt: string[]; podaci: string }

/** Najmanji SMTP koji nodemailer prihvaća: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
export function lazniSmtp(mailovi: LazniMail[]) {
  return Bun.listen<{ buf: string; uPodacima: boolean; mail: LazniMail }>({
    hostname: '127.0.0.1', port: 0,
    socket: {
      open(s) { s.data = { buf: '', uPodacima: false, mail: { rcpt: [], podaci: '' } }; s.write('220 lazni ESMTP\r\n') },
      data(s, chunk) {
        const st = s.data
        st.buf += chunk.toString()
        while (true) {
          if (st.uPodacima) {
            const kraj = st.buf.indexOf('\r\n.\r\n')
            if (kraj < 0) return
            st.mail.podaci = st.buf.slice(0, kraj)
            st.buf = st.buf.slice(kraj + 5)
            st.uPodacima = false
            mailovi.push(st.mail)
            st.mail = { rcpt: [], podaci: '' }
            s.write('250 primljeno\r\n')
            continue
          }
          const i = st.buf.indexOf('\r\n')
          if (i < 0) return
          const red = st.buf.slice(0, i)
          st.buf = st.buf.slice(i + 2)
          const n = red.toUpperCase()
          if (n.startsWith('EHLO') || n.startsWith('HELO')) s.write('250-lazni\r\n250 AUTH PLAIN\r\n')
          else if (n.startsWith('AUTH PLAIN') && red.trim().split(' ').length > 2) s.write('235 ok\r\n')
          else if (n.startsWith('AUTH PLAIN')) s.write('334 \r\n')
          else if (n.startsWith('MAIL FROM')) s.write('250 ok\r\n')
          else if (n.startsWith('RCPT TO')) { st.mail.rcpt.push(red.replace(/^RCPT TO:\s*<?|>.*$/gi, '')); s.write('250 ok\r\n') }
          else if (n === 'DATA') { st.uPodacima = true; s.write('354 dalje\r\n') }
          else if (n === 'QUIT') { s.write('221 bok\r\n'); s.end() }
          else if (n === 'RSET' || n === 'NOOP') s.write('250 ok\r\n')
          else if (/^[A-Za-z0-9+/=]+$/.test(red)) s.write('235 ok\r\n') // odgovor na 334 (AUTH PLAIN bez početnog)
          else s.write('502 ne znam\r\n')
        }
      },
    },
  })
}
