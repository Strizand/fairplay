// Сервис розыгрышей «подарок за репост» для ВКонтакте и Instagram.
// Запуск: node server.js  →  http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');

// Простейшая загрузка .env без зависимостей (до подключения модулей, которые читают настройки).
// Понимает: комментарии «# …» (отдельной строкой и после значения), кавычки, «export KEY=…», цифры в именах.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    const q = v.match(/^(["'])(.*?)\1/);
    if (q) v = q[2]; // в кавычках «#» — часть значения
    else v = v.replace(/\s+#.*$/, '').trim();
    process.env[m[1]] = v;
  }
}

const { fetchVk } = require('./lib/vk');
const { fetchInstagram } = require('./lib/instagram');
const { demoVk, demoInstagram } = require('./lib/demo');
const { runDraw } = require('./lib/engine');
const store = require('./lib/store');
const auth = require('./lib/auth');
const billing = require('./lib/billing');
const { db } = require('./lib/db');
const mailer = require('./lib/mailer');
const settings = require('./lib/settings');
const legal = require('./lib/legal');
const vkid = require('./lib/vkid');

const PORT = Number(process.env.PORT) || 3000;
// На сервере за Caddy/nginx — 127.0.0.1, чтобы порт не был доступен снаружи напрямую. Пусто — все адреса.
const HOST = process.env.HOST || undefined;
// Instagram временно скрыт: для работы с аккаунтами клиентов нужен вход через Instagram (OAuth).
// Код сохранён; включить обратно — INSTAGRAM_ENABLED=1 в файле .env и перезапуск.
const INSTAGRAM_ENABLED = process.env.INSTAGRAM_ENABLED === '1';
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

const jobs = new Map();

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

// Какую ошибку показать пользователю. Наши сообщения (обычный Error) — понятный текст, его отдаём как есть (400).
// Программные ошибки (TypeError, ReferenceError и т.п.) и ошибки базы — внутренние: подробности только в консоль, наружу — 500.
const INTERNAL_ERRORS = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError];
function publicError(e) {
  const internal = !(e instanceof Error) || INTERNAL_ERRORS.some((C) => e instanceof C) || String(e.code || '').startsWith('ERR_SQLITE');
  if (internal) {
    console.error('Внутренняя ошибка:', e && e.stack ? e.stack : e);
    return { status: 500, message: 'Внутренняя ошибка сервера. Попробуйте ещё раз или напишите в поддержку.' };
  }
  return { status: 400, message: e.message };
}

const MAX_BODY = 5e6;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        req.pause(); // дальше не читаем и не копим в памяти
        reject(new Error('Слишком большой запрос'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(new Error('Некорректный JSON в запросе'));
      }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

// Ограничение частоты по ключу: не больше max событий за windowMs. Старые записи периодически вычищаются.
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.length || now - list[list.length - 1] > 24 * 3600000) hits.delete(k);
}, 600000).unref();

// Сколько розыгрышей может выполняться одновременно (сбор данных и ожидание drand занимают время)
const MAX_RUNNING_JOBS = 20;
const MAX_RUNNING_PER_CLIENT = 2;

// IP посетителя. За прокси берём ПОСЛЕДНИЙ адрес из X-Forwarded-For — его дописал наш nginx/Caddy;
// первые значения клиент может подставить сам и так обойти ограничения по IP.
const clientIp = (req) => {
  if (settings.flag('TRUST_PROXY')) {
    const last = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress;
};

// Адрес сайта для ссылок в письмах и возврата после оплаты. Заголовку Host доверять нельзя:
// подставив чужой домен, злоумышленник получил бы ссылку восстановления пароля на свой сайт.
// Поэтому без настройки PUBLIC_URL допускаем только локальный адрес (запуск на своём компьютере).
function baseUrl(req) {
  const configured = settings.get('PUBLIC_URL');
  if (configured) return configured;
  const host = String(req.headers.host || '');
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(host)) return `http://${host}`;
  throw new Error('Не указан адрес сайта. Администратору: заполните «Адрес сайта» в настройках (/admin.html).');
}

function resetEmail(to, link, minutes) {
  const text = [
    'Здравствуйте!',
    '',
    'Кто-то (возможно, вы) запросил восстановление пароля в сервисе ЧестныйРозыгрыш.',
    `Чтобы задать новый пароль, откройте ссылку (она действует ${minutes} минут и срабатывает один раз):`,
    '',
    link,
    '',
    'Если вы не запрашивали восстановление — просто проигнорируйте это письмо, ваш пароль не изменится.',
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2130;max-width:520px">
    <p>Здравствуйте!</p>
    <p>Кто-то (возможно, вы) запросил восстановление пароля в сервисе <b>ЧестныйРозыгрыш</b>.</p>
    <p><a href="${link}" style="display:inline-block;background:#5b4bff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold">Задать новый пароль</a></p>
    <p style="color:#6b7185;font-size:13px">Ссылка действует ${minutes} минут и срабатывает один раз. Если кнопка не нажимается, скопируйте адрес в браузер:<br>${link}</p>
    <p style="color:#6b7185;font-size:13px">Если вы не запрашивали восстановление — просто проигнорируйте это письмо, ваш пароль не изменится.</p></div>`;
  return { to, subject: 'Восстановление пароля — ЧестныйРозыгрыш', text, html };
}

// Кнопки «Проверить» в настройках админки: проверяем подключение с текущими сохранёнными значениями
async function testConnection(what, user) {
  const ms = 10000;
  if (what === 'vk') {
    const token = settings.get('VK_TOKEN');
    if (!token) throw new Error('Ключ VK не задан');
    // Проверяем все методы, нужные розыгрышу: ключ может работать для users.get, но не для лайков и комментариев
    const r = await vkid.checkMethods(token);
    if (r.allOk) return 'VK: ключ работает, все нужные методы доступны';
    const bad = r.rows.filter((x) => !x.ok);
    if (bad.length === r.rows.length) throw new Error('VK отклонил ключ: ' + bad[0].error);
    throw new Error('Ключ принят, но недоступны: ' + bad.map((x) => `${x.label} — ${x.method}: ${x.error}`).join('; '));
  }
  if (what === 'ig') {
    const token = settings.get('IG_TOKEN');
    const id = settings.get('IG_USER_ID');
    if (!token || !id) throw new Error('Укажите и токен, и ID аккаунта');
    const u = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(id)}`);
    u.searchParams.set('fields', 'username');
    u.searchParams.set('access_token', token);
    const r = await fetch(u, { signal: AbortSignal.timeout(ms) }).then((x) => x.json());
    if (r.error) throw new Error('Instagram: ' + r.error.message);
    return `Instagram: подключён аккаунт @${r.username}`;
  }
  if (what === 'yookassa') {
    if (!billing.yookassaEnabled()) throw new Error('Укажите shopId и секретный ключ');
    const r = await billing.yk('GET', 'me');
    return `ЮKassa: магазин ${r.account_id}${r.test ? ' (тестовый магазин)' : ''} подключён`;
  }
  if (what === 'mail') {
    if (!mailer.mailEnabled()) throw new Error('Укажите SMTP-сервер');
    await mailer.sendMail({
      to: user.email,
      subject: 'Проверка почты — ЧестныйРозыгрыш',
      text: 'Это тестовое письмо из админки. Если вы его читаете — отправка почты настроена правильно.',
      html: '<p>Это тестовое письмо из админки.</p><p>Если вы его читаете — отправка почты настроена правильно.</p>',
    });
    return `Тестовое письмо отправлено на ${user.email}. Проверьте ящик (и папку «Спам»).`;
  }
  throw new Error('Неизвестная проверка');
}

function me(user) {
  if (!user) return { user: null };
  return { user: { email: user.email, createdAt: user.createdAt, isAdmin: user.isAdmin }, access: billing.accessStatus(user) };
}

async function execute(job, s, user) {
  const progress = (msg) => (job.progress = msg);
  const demo = !!s.demo;
  const cond = s.cond || {};
  const groups = String(cond.groups || '').split(/[\s,;]+/).filter(Boolean);
  let data;
  if (s.network === 'vk') {
    // Ключи API — только из настроек администратора; ключи из запроса пользователя не принимаются
    data = demo ? demoVk(s.url, { groups }) : await fetchVk(s.url, { token: settings.get('VK_TOKEN'), groups, progress });
  } else if (s.network === 'instagram') {
    const opts = { likersList: s.likersList, followersList: s.followersList };
    data = demo
      ? demoInstagram(s.url, opts)
      : await fetchInstagram(s.url, { ...opts, token: settings.get('IG_TOKEN'), igUserId: settings.get('IG_USER_ID'), progress });
  } else throw new Error('Неизвестная соцсеть');

  const days = Number(cond.excludePrevWinnersDays);
  const prevWinners = days && user ? store.recentWinners(user.id, days) : new Set();
  const startedAt = new Date().toISOString();
  const r = await runDraw(s, data, { prevWinners, progress });

  // Параметры розыгрыша для отчёта (без токенов и загруженных списков).
  // Имя не «settings», чтобы не перекрыть модуль настроек, который используется выше.
  // Числовые поля приводим к числам: отчёт публичный, и в него не должно попасть произвольное содержимое запроса.
  const { tokens, likersList, followersList, ...drawSettings } = s;
  drawSettings.winners = Math.max(1, Math.trunc(Number(s.winners)) || 1);
  drawSettings.reserves = Math.max(0, Math.trunc(Number(s.reserves)) || 0);
  const report = {
    id: store.newId(),
    createdAt: new Date().toISOString(),
    startedAt,
    network: data.network,
    demo: !!data.demo,
    title: s.title || 'Розыгрыш',
    prize: s.prize || '',
    organizerNote: s.organizerNote || '',
    post: data.post,
    groups: data.groups,
    settings: drawSettings,
    importedLists: { likers: likersList ? 'загружен организатором' : null, followers: followersList ? 'загружен организатором' : null },
    conditions: r.conditions,
    mechanic: r.mechanic,
    stats: r.stats,
    rng: r.rng,
    pool: r.pool,
    log: r.log,
    winners: r.winners,
    reserves: r.reserves,
    participants: r.participants.map((p) => ({
      id: p.id, name: p.name, url: p.url, photo: p.photo, ok: p.ok,
      tickets: p.validComments.length,
      failed: p.checks.filter((c) => !c.ok).map((c) => c.label + (c.detail ? ` (${c.detail})` : '')),
    })),
  };
  store.save(report, user && user.id);
  return report.id;
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Страница результата входа через VK ID: какие методы VK API доступны ключу пользователя
async function vkidCallback(res, url, user) {
  let body;
  try {
    if (!user || !user.isAdmin) throw new Error('Войдите в сервис как администратор и запустите проверку из админки');
    const t = await vkid.finish(url.searchParams, user.id);
    const r = await vkid.checkMethods(t.token, t.post);
    const me = await vkid.call(t.token, 'users.get');
    const who = me.ok && me.response[0] ? `${me.response[0].first_name} ${me.response[0].last_name} (id${me.response[0].id})` : 'id' + t.userId;
    body = `<h2>${r.allOk ? '✅ Все нужные методы доступны' : '❌ Часть методов недоступна'}</h2>
      <p class="small muted">Аккаунт ВКонтакте: <b>${escHtml(who)}</b> · права ключа: <span class="mono">${escHtml(t.scope || '—')}</span><br>
      Проверочный пост: <a href="${escHtml(r.post)}" target="_blank" rel="noopener">${escHtml(r.post)}</a></p>
      <div class="tablewrap"><table><tr><th>Что нужно сервису</th><th>Метод</th><th>Результат</th></tr>
      ${r.rows.map((x) => `<tr><td>${escHtml(x.label)}</td><td class="mono">${escHtml(x.method)}</td><td>${x.ok ? '<span class="ok">✓ работает</span>' : `<span class="bad">✗ ${escHtml(x.error)}</span>`}</td></tr>`).join('')}
      </table></div>
      <p class="small">${r.allOk
        ? 'С ключом пользователя VK ID розыгрыши работают — можно делать вход через ВК для всех пользователей.'
        : 'Ключ пользователя VK ID тоже ограничен. Сохраните скриншот этой страницы — он пригодится для обращения в поддержку ВКонтакте.'}</p>
      <p class="small muted">Ключ использован только для этой проверки и не сохранён.</p>`;
  } catch (e) {
    body = `<h2>❌ Проверка не удалась</h2><p class="bad">${escHtml(publicError(e).message)}</p>`;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Проверка VK ID — ЧестныйРозыгрыш</title><link rel="stylesheet" href="/styles.css"></head>
    <body><div class="wrap" style="max-width:900px"><header class="top"><a class="logo" href="/">Честный<span>Розыгрыш</span></a></header>
    <div class="card">${body}<p><a class="btn" href="/admin.html">← Вернуться в админку</a></p></div></div></body></html>`);
}

async function api(req, res, url) {
  const p = url.pathname;
  const user = auth.currentUser(req);
  const method = req.method;

  // Защита от CSRF: все изменяющие запросы — только JSON (кроме уведомлений ЮKassa)
  if (method === 'POST' && p !== '/api/yookassa/webhook' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'Ожидается JSON' });
  }
  const needUser = () => {
    if (!user) send(res, 401, { error: 'Войдите в аккаунт' });
    return user;
  };

  // ── Аккаунт ──
  if (p === '/api/me') return send(res, 200, me(user));
  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    // Отдельные согласия: с офертой и на обработку персональных данных (152-ФЗ — согласие отдельным документом)
    if (b.acceptOffer !== true || b.consentPd !== true) throw new Error('Чтобы зарегистрироваться, примите оферту и дайте согласие на обработку персональных данных');
    const s = auth.register(b.email, b.password, clientIp(req), legal.LEGAL_VERSION);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(s.token, s.expires) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const s = auth.login(b.email, b.password, clientIp(req));
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(s.token, s.expires) });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    auth.logout(req);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader('', null) });
  }
  if (p === '/api/auth/forgot' && method === 'POST') {
    if (!mailer.mailEnabled() && process.env.NODE_ENV === 'production') throw new Error('Восстановление пароля временно недоступно. Напишите в поддержку.');
    const b = await readBody(req);
    const base = baseUrl(req); // до поиска аккаунта: ошибка не должна зависеть от того, есть ли такой e-mail
    const r = auth.requestReset(b.email, clientIp(req));
    if (r) {
      const link = `${base}/reset.html?token=${r.token}`;
      if (mailer.mailEnabled()) {
        // Отправляем в фоне: время ответа не должно выдавать, существует ли аккаунт
        mailer.sendMail(resetEmail(r.email, link, r.minutes)).catch((e) => console.error('Письмо не отправлено:', e.message));
      } else {
        console.log(`[SMTP не настроен] Ссылка для восстановления пароля ${r.email}: ${link}`);
      }
    }
    return send(res, 200, { ok: true, devMode: !mailer.mailEnabled() });
  }
  if (p === '/api/auth/reset' && method === 'GET') {
    return send(res, 200, auth.resetInfo(url.searchParams.get('token')));
  }
  if (p === '/api/auth/reset' && method === 'POST') {
    const b = await readBody(req);
    const s = auth.resetPassword(String(b.token || ''), b.password);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(s.token, s.expires) });
  }
  if (p === '/api/auth/password' && method === 'POST') {
    if (!needUser()) return;
    const b = await readBody(req);
    const s = auth.changePassword(user.id, b.oldPassword, b.newPassword);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(s.token, s.expires) });
  }

  // ── Оплата ──
  // Реквизиты продавца и редакция документов — для страниц оферты, политики и контактов
  if (p === '/api/legal') return send(res, 200, legal.info());
  if (p === '/api/plans') return send(res, 200, { plans: settings.plans(), yookassa: billing.yookassaEnabled(), testMode: billing.testModeEnabled() });
  if (p === '/api/payments' && method === 'GET') {
    if (!needUser()) return;
    return send(res, 200, billing.userPayments(user.id));
  }
  if (p === '/api/payments' && method === 'POST') {
    if (!needUser()) return;
    const b = await readBody(req);
    // Адрес возврата нужен только ЮKassa; тестовая оплата работает по относительной ссылке
    const base = billing.yookassaEnabled() ? baseUrl(req) : '';
    return send(res, 200, await billing.createPayment(user, b.planId, base));
  }
  let m;
  if ((m = p.match(/^\/api\/payments\/([\w-]+)$/)) && method === 'GET') {
    if (!needUser()) return;
    return send(res, 200, await billing.checkPayment(user, m[1]));
  }
  if ((m = p.match(/^\/api\/payments\/([\w-]+)\/test$/)) && method === 'POST') {
    if (!needUser()) return;
    const b = await readBody(req);
    billing.completeTestPayment(user, m[1], !!b.success);
    return send(res, 200, await billing.checkPayment(user, m[1]));
  }
  if (p === '/api/yookassa/webhook' && method === 'POST') {
    // Отвечаем 200 в любом случае; статус всё равно перепроверяется запросом к ЮKassa
    try { await billing.handleWebhook(await readBody(req)); } catch (e) { console.error('webhook:', e.message); }
    return send(res, 200, { ok: true });
  }

  // ── Администратор ──
  if (p.startsWith('/api/admin/')) {
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Нет доступа' });
    if (p === '/api/admin/users') {
      const rows = db.prepare(`
        SELECT u.id, u.email, u.created_at, u.paid_until,
          (SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) FROM payments WHERE user_id = u.id AND status = 'succeeded') AS paid_total,
          (SELECT COUNT(*) FROM draws WHERE user_id = u.id AND demo = 0) AS draws
        FROM users u ORDER BY u.created_at DESC LIMIT 1000`).all();
      return send(res, 200, rows);
    }
    if (p === '/api/admin/payments') {
      const rows = db.prepare('SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 500').all();
      return send(res, 200, rows.map((r) => ({ ...billing.publicPayment(r), email: r.email })));
    }
    if (p === '/api/admin/grant' && method === 'POST') {
      const b = await readBody(req);
      billing.grantDays(Number(b.userId), b.days, user.email, b.note);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/settings' && method === 'GET') {
      return send(res, 200, {
        fields: settings.describe(),
        status: { instagramEnabled: INSTAGRAM_ENABLED, yookassa: billing.yookassaEnabled(), testMode: billing.testModeEnabled(), mail: mailer.mailEnabled(), port: PORT, production: process.env.NODE_ENV === 'production' },
      });
    }
    if (p === '/api/admin/settings' && method === 'POST') {
      const b = await readBody(req);
      const values = b.values || {};
      // Нельзя случайно лишить себя доступа: свой адрес должен остаться в списке (или быть в .env)
      if ('ADMIN_EMAILS' in values) {
        const list = String(values.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/);
        const inEnv = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).includes(user.email);
        if (!inEnv && !list.includes(user.email)) throw new Error('Нельзя убрать свой адрес из администраторов — иначе вы потеряете доступ к этой странице');
      }
      settings.save(values, user.email);
      return send(res, 200, { ok: true });
    }
    // Вход через VK ID и проверка методов VK API на ключе пользователя (ключ не сохраняется)
    if (p === '/api/admin/vkid/start' && method === 'GET') {
      const to = vkid.start(user.id, baseUrl(req), String(url.searchParams.get('post') || '').trim());
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (p === '/api/admin/test' && method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, { message: await testConnection(b.what, user) });
    }
  }

  if (p === '/api/vkid/callback' && method === 'GET') {
    return vkidCallback(res, url, user);
  }

  // ── Розыгрыши ──
  if (p === '/api/status') {
    return send(res, 200, {
      vk: !!settings.get('VK_TOKEN'),
      instagram: INSTAGRAM_ENABLED && !!(settings.get('IG_TOKEN') && settings.get('IG_USER_ID')),
      instagramEnabled: INSTAGRAM_ENABLED,
    });
  }
  if (p === '/api/draw' && method === 'POST') {
    const s = await readBody(req);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return send(res, 400, { error: 'Некорректный запрос' });
    if (s.network === 'instagram' && !INSTAGRAM_ENABLED) return send(res, 400, { error: 'Розыгрыши в Instagram временно недоступны. Сейчас доступен ВКонтакте.' });
    s.url = String(s.url || '').trim();
    if (!s.url) return send(res, 400, { error: 'Укажите ссылку на пост' });
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s.url)) s.url = 'https://' + s.url.replace(/^\/+/, ''); // «vk.com/wall-1_2» без протокола
    // Ссылка попадает в публичный отчёт — допускаем только http(s), без javascript:, data: и т.п.
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(s.url) || s.url.length > 500) return send(res, 400, { error: 'Ссылка на пост должна начинаться с https://' });
    // Демо доступно всем; розыгрыш по реальным данным — только с оплаченным доступом
    if (!s.demo) {
      if (!user) return send(res, 401, { error: 'Чтобы провести розыгрыш по реальному посту, войдите в аккаунт', code: 'auth' });
      if (!billing.accessStatus(user).active) return send(res, 402, { error: 'Оплаченный период закончился или не оплачен. Продлите доступ в личном кабинете.', code: 'payment' });
    }
    // Защита от злоупотреблений: каждый розыгрыш пишет отчёт на диск и держит соединения с внешними API
    const client = user ? 'u:' + user.id : 'ip:' + clientIp(req);
    const running = [...jobs.values()].filter((j) => j.status === 'running');
    if (running.length >= MAX_RUNNING_JOBS) return send(res, 503, { error: 'Сервис сейчас загружен. Попробуйте через минуту.' });
    if (running.filter((j) => j.client === client).length >= MAX_RUNNING_PER_CLIENT) return send(res, 429, { error: 'Дождитесь окончания уже запущенного розыгрыша.' });
    const perHour = user ? (s.demo ? 30 : 60) : 10;
    if (rateLimited('draw:' + client, perHour, 3600000)) return send(res, 429, { error: user ? 'Слишком много розыгрышей за час. Попробуйте позже.' : 'Лимит демо-розыгрышей без входа исчерпан. Войдите в аккаунт или попробуйте через час.' });
    const id = store.newId();
    const job = { id, status: 'running', progress: 'Начинаю…' };
    Object.defineProperty(job, 'client', { value: client, enumerable: false }); // не отдаём наружу в /api/jobs
    jobs.set(id, job);
    setTimeout(() => jobs.delete(id), 3600000);
    execute(job, s, user)
      .then((reportId) => Object.assign(job, { status: 'done', reportId }))
      .catch((e) => Object.assign(job, { status: 'error', error: publicError(e).message }));
    return send(res, 200, { jobId: id });
  }
  if (p.startsWith('/api/jobs/')) {
    const job = jobs.get(p.slice(10));
    return job ? send(res, 200, job) : send(res, 404, { error: 'Задача не найдена' });
  }
  if (p === '/api/reports') return send(res, 200, user ? store.list(user.id) : []);
  if (p.startsWith('/api/reports/')) {
    const r = store.load(p.slice(13));
    if (!r) return send(res, 404, { error: 'Отчёт не найден' });
    // Сам отчёт неизменяем; список всех розыгрышей по этому посту добавляется «живым» при каждом открытии,
    // чтобы в отчёте были видны и перезапуски, сделанные позже
    return send(res, 200, { ...r, postHistory: store.postHistory(r) });
  }
  return send(res, 404, { error: 'Не найдено' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Некорректный адрес'); // иначе исключение вне try уронило бы процесс
  }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    // Возврат с VK ID приходит на главную страницу (см. lib/vkid.js)
    if (url.pathname === '/' && req.method === 'GET' && vkid.isReturn(url.searchParams)) {
      return await vkidCallback(res, url, auth.currentUser(req));
    }
    // Статика. /r/<id> — короткая публичная ссылка на отчёт
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (/^\/r\/[a-z0-9]+$/.test(file)) file = '/report.html';
    try { file = decodeURIComponent(file); } catch (_) { file = '/\0'; } // битая кодировка → 404
    const full = path.join(PUBLIC, path.normalize(file));
    // Сравниваем с разделителем в конце: иначе «public2/…» тоже прошёл бы проверку «startsWith(public)»
    if (file.includes('\0') || !full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    const { status, message } = publicError(e);
    if (res.headersSent) return res.destroy();
    send(res, status, { error: message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Сервис уже запущен в другом окне. Просто откройте в браузере http://localhost:${PORT}`);
    console.log('Если это не так — закройте другие окна сервиса или перезагрузите компьютер.');
    process.exit(1);
  }
  throw e;
});

// Уборка базы: просроченные сессии и ссылки восстановления, зависшие неоплаченные платежи.
// Запускается при старте и затем раз в час.
async function housekeeping() {
  try {
    const now = new Date().toISOString();
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(dayAgo);
    await billing.settleStale(dayAgo);
  } catch (e) {
    console.error('Уборка базы:', e.message);
  }
}
housekeeping();
setInterval(housekeeping, 3600000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Сервис розыгрышей запущен: http://localhost:${PORT}`);
  if (billing.yookassaEnabled()) console.log('Оплата: ЮKassa');
  else if (billing.testModeEnabled()) console.log('Оплата: ТЕСТОВЫЙ режим (ЮKassa не настроена, деньги не списываются)');
  else console.log('Оплата: не настроена — покупка доступа недоступна');
  console.log(mailer.mailEnabled() ? `Почта: ${settings.get('SMTP_HOST')}` : 'Почта: SMTP не настроен — ссылки восстановления пароля выводятся в эту консоль');
});
