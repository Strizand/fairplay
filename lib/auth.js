// Регистрация и вход по e-mail и паролю. Пароли хранятся как scrypt-хеш с солью,
// сессия — случайный токен в HttpOnly-cookie (в базе лежит только его SHA-256).

const crypto = require('crypto');
const { db } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'sid';
const settings = require('./settings');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Защита от перебора паролей за 15 минут:
//   • с одного IP — не больше 10 неудачных попыток;
//   • на один e-mail с одного IP — не больше 5;
//   • на один e-mail со всех IP вместе — не больше 50 (распределённый перебор).
// Порог на e-mail нарочно высокий: иначе любой мог бы заблокировать вход владельцу, введя 10 неверных паролей.
const attempts = new Map();
function limited(key, max = 10) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(key, list);
  return list.length >= max;
}
const fail = (key) => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
// Раз в 10 минут удаляем записи старше суток, чтобы таблица попыток не росла бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of attempts) if (!list.length || now - list[list.length - 1] > 24 * 3600000) attempts.delete(k);
}, 600000).unref();

function validate(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Error('Введите корректный e-mail');
  if (String(password || '').length < 8) throw new Error('Пароль должен быть не короче 8 символов');
  if (String(password).length > 200) throw new Error('Слишком длинный пароль');
  return email;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now.toISOString(), expires.toISOString());
  return { token, expires };
}

function cookieHeader(token, expires) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (settings.flag('COOKIE_SECURE')) parts.push('Secure'); // только при работе через HTTPS
  parts.push(expires ? `Expires=${expires.toUTCString()}` : 'Max-Age=0');
  return parts.join('; ');
}

function readCookie(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

// version — редакция оферты и согласия, которые пользователь принял при регистрации
function register(email, password, ip, version) {
  email = validate(email, password);
  if (limited('reg:' + ip)) throw new Error('Слишком много попыток. Попробуйте позже.');
  fail('reg:' + ip); // считаем и успешные регистрации, чтобы не плодили аккаунты
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('Пользователь с таким e-mail уже зарегистрирован');
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO users (email, password_hash, created_at, consent_at, consent_version, consent_ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, hashPassword(password), now, now, version || null, String(ip || ''));
  return createSession(Number(r.lastInsertRowid));
}

function login(email, password, ip) {
  email = String(email || '').trim().toLowerCase();
  if (limited('ip:' + ip, 10) || limited(`emip:${email}|${ip}`, 5) || limited('em:' + email, 50)) {
    throw new Error('Слишком много неудачных попыток. Подождите 15 минут или восстановите пароль.');
  }
  const u = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!u || !checkPassword(String(password || ''), u.password_hash)) {
    fail('ip:' + ip);
    fail(`emip:${email}|${ip}`);
    fail('em:' + email);
    throw new Error('Неверный e-mail или пароль');
  }
  return createSession(u.id);
}

function logout(req) {
  const t = readCookie(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
}

function changePassword(userId, oldPassword, newPassword) {
  const u = db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(userId);
  if (!checkPassword(String(oldPassword || ''), u.password_hash)) throw new Error('Текущий пароль указан неверно');
  validate(u.email, newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // выйти на всех устройствах
  return createSession(userId);
}

// ── Восстановление пароля ──
// Ссылка из письма действует 1 час и срабатывает один раз. Ответ на запрос одинаковый для существующих
// и несуществующих адресов, чтобы по нему нельзя было узнать, кто зарегистрирован.
const RESET_MINUTES = 60;

function requestReset(email, ip) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Введите корректный e-mail');
  // Не больше 5 запросов в час с одного IP и 3 писем в час на один адрес
  const hour = (key, max) => {
    const list = (attempts.get(key) || []).filter((t) => Date.now() - t < 3600000);
    attempts.set(key, list);
    return list.length >= max;
  };
  if (hour('rst-ip:' + ip, 5)) throw new Error('Слишком много запросов. Попробуйте через час.');
  fail('rst-ip:' + ip);
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!u || hour('rst-em:' + email, 3)) return null;
  fail('rst-em:' + email);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), u.id, now.toISOString(), new Date(now.getTime() + RESET_MINUTES * 60000).toISOString());
  return { email, token, minutes: RESET_MINUTES };
}

function resetInfo(token) {
  const r = db.prepare('SELECT r.expires_at, r.used_at, u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?').get(sha256(String(token || '')));
  if (!r || r.used_at || r.expires_at < new Date().toISOString()) throw new Error('Ссылка недействительна или устарела. Запросите восстановление пароля ещё раз.');
  return { email: r.email };
}

function resetPassword(token, newPassword) {
  const { email } = resetInfo(token);
  validate(email, newPassword);
  const r = db.prepare('SELECT user_id FROM password_resets WHERE token_hash = ?').get(sha256(token));
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), r.user_id);
  db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, r.user_id); // все прочие ссылки тоже гаснут
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id); // выход на всех устройствах
  return createSession(r.user_id);
}

// Текущий пользователь по cookie или null
function currentUser(req) {
  const t = readCookie(req);
  if (!t) return null;
  const row = db
    .prepare('SELECT u.id, u.email, u.created_at, u.paid_until, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(sha256(t));
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
    return null;
  }
  return { id: row.id, email: row.email, createdAt: row.created_at, paidUntil: row.paid_until, isAdmin: settings.admins().has(row.email) };
}

module.exports = { register, login, logout, changePassword, currentUser, cookieHeader, requestReset, resetInfo, resetPassword };
