// Отправка писем по SMTP без сторонних библиотек.
// Подходит для Яндекс 360, Mail.ru для бизнеса, Unisender Go, SendPulse и любого SMTP-сервера:
// порт 465 — сразу TLS, порт 587/25 — STARTTLS. Без TLS письмо отправляется только на localhost.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');
const settings = require('./settings');

const cfg = () => ({
  host: settings.get('SMTP_HOST'),
  port: Number(settings.get('SMTP_PORT')) || 465,
  user: settings.get('SMTP_USER'),
  pass: settings.get('SMTP_PASS'),
  from: settings.get('SMTP_FROM') || settings.get('SMTP_USER'),
});
const mailEnabled = () => !!cfg().host;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

// "Имя <адрес>" → заголовок с закодированным именем и голый адрес для MAIL FROM
function parseFrom(from) {
  const m = String(from).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { header: `${encWord(m[1].replace(/^"|"$/g, ''))} <${m[2]}>`, address: m[2] } : { header: from, address: from };
}

function buildMessage({ from, to, subject, text, html }) {
  const boundary = 'b' + crypto.randomBytes(12).toString('hex');
  const domain = from.address.split('@')[1] || 'localhost';
  return [
    `From: ${from.header}`,
    `To: <${to}>`,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// Минимальный SMTP-диалог: читаем ответы построчно (многострочные — "250-…", последняя — "250 …")
// Если соединение оборвалось или истёк таймаут, ожидающая команда завершается ошибкой, а не висит вечно.
function session(socket) {
  let buf = '';
  let waiting = null;
  let broken = null;
  const lines = [];
  const pump = () => {
    if (!waiting) return;
    const i = lines.findIndex((l) => /^\d{3} /.test(l));
    if (i === -1) return;
    const resp = lines.splice(0, i + 1);
    const w = waiting;
    waiting = null;
    w.resolve({ code: Number(resp[i].slice(0, 3)), text: resp.join('\n') });
  };
  const onBroken = (e) => {
    broken = broken || e || new Error('SMTP: сервер закрыл соединение');
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.reject(broken);
    }
  };
  const onClose = () => onBroken();
  const onData = (d) => {
    buf += d.toString('utf8');
    let k;
    while ((k = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, k).replace(/\r$/, ''));
      buf = buf.slice(k + 1);
    }
    pump();
  };
  socket.on('data', onData);
  socket.on('error', onBroken);
  socket.on('close', onClose);
  const read = () => new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    pump();
    if (waiting && broken) onBroken();
  });
  return {
    read,
    detach: () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onBroken);
      socket.removeListener('close', onClose);
    },
    async cmd(line, ok) {
      if (line !== null) socket.write(line + '\r\n');
      const r = await read();
      if (!ok.includes(r.code)) throw new Error(`SMTP: ${line ? line.split(' ')[0] : 'приветствие'} → ${r.text}`);
      return r;
    },
  };
}

function connect(c) {
  return new Promise((resolve, reject) => {
    const opts = { host: c.host, port: c.port, servername: c.host };
    const s = c.port === 465 ? tls.connect(opts, () => resolve(s)) : net.connect(opts, () => resolve(s));
    s.setTimeout(20000, () => s.destroy(new Error('SMTP: превышено время ожидания')));
    // Постоянный обработчик: ошибка после подключения не должна ронять процесс (её обработает session)
    s.on('error', reject);
  });
}

async function sendMail({ to, subject, text, html }) {
  const c = cfg();
  if (!c.host) throw new Error('SMTP не настроен');
  const from = parseFrom(c.from);
  const local = ['localhost', '127.0.0.1', '::1'].includes(c.host);
  let socket = await connect(c);
  try {
    let s = session(socket);
    await s.cmd(null, [220]);
    const name = os.hostname() || 'localhost';
    let ehlo = await s.cmd(`EHLO ${name}`, [250]);
    if (!(socket instanceof tls.TLSSocket)) {
      if (/STARTTLS/i.test(ehlo.text)) {
        await s.cmd('STARTTLS', [220]);
        s.detach();
        socket = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket, servername: c.host }, () => resolve(t));
          t.setTimeout(20000, () => t.destroy(new Error('SMTP: превышено время ожидания')));
          t.on('error', reject);
        });
        s = session(socket);
        ehlo = await s.cmd(`EHLO ${name}`, [250]);
      } else if (!local) {
        throw new Error('SMTP-сервер не поддерживает шифрование — отправка отменена');
      }
    }
    if (c.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) {
        await s.cmd('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64'), [235]);
      } else {
        await s.cmd('AUTH LOGIN', [334]);
        await s.cmd(b64(c.user), [334]);
        await s.cmd(b64(c.pass), [235]);
      }
    }
    await s.cmd(`MAIL FROM:<${from.address}>`, [250]);
    await s.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    const body = buildMessage({ from, to, subject, text, html }).replace(/^\./gm, '..');
    await s.cmd(body + '\r\n.', [250]);
    socket.write('QUIT\r\n');
  } finally {
    socket.end();
  }
}

module.exports = { sendMail, mailEnabled };
