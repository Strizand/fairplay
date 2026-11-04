// Тарифы, оплата через ЮKassa и учёт оплаченного периода.
//
// Оплаченный период хранится в users.paid_until. Каждый успешный платёж продлевает его на срок тарифа:
// от текущей даты окончания, если доступ ещё действует, или от момента оплаты, если уже истёк.
// Платёж засчитывается ровно один раз (статус меняется в транзакции).
// Тарифы и ключи ЮKassa задаются в админке (lib/settings.js).

const crypto = require('crypto');
const { db, tx } = require('./db');
const settings = require('./settings');

const YK = 'https://api.yookassa.ru/v3/';
const yookassaEnabled = () => !!(settings.get('YOOKASSA_SHOP_ID') && settings.get('YOOKASSA_SECRET_KEY'));
// Тестовая «оплата» без денег — только для разработки, когда ЮKassa не подключена
const testModeEnabled = () => !yookassaEnabled() && process.env.NODE_ENV !== 'production';

async function yk(method, pathname, body, idempotenceKey) {
  const headers = { Authorization: 'Basic ' + Buffer.from(`${settings.get('YOOKASSA_SHOP_ID')}:${settings.get('YOOKASSA_SECRET_KEY')}`).toString('base64'), 'Content-Type': 'application/json' };
  if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;
  let r, j;
  try {
    r = await fetch(YK + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    j = await r.json();
  } catch (e) {
    throw new Error('ЮKassa: нет ответа от сервера (' + (e.name === 'TimeoutError' ? 'таймаут' : e.message) + ')');
  }
  if (!r.ok) throw new Error('ЮKassa: ' + (j.description || j.code || r.status));
  return j;
}

function accessStatus(user) {
  if (!user) return { active: false, paidUntil: null, daysLeft: 0 };
  const until = user.paidUntil || user.paid_until;
  const active = !!until && until > new Date().toISOString();
  return { active, paidUntil: until || null, daysLeft: active ? Math.ceil((new Date(until) - Date.now()) / 86400000) : 0 };
}

async function createPayment(user, planId, baseUrl) {
  const plan = settings.plans().find((p) => p.id === planId);
  if (!plan) throw new Error('Неизвестный тариф');
  if (!yookassaEnabled() && !testModeEnabled()) throw new Error('Оплата временно недоступна: платёжная система не настроена');
  const id = crypto.randomUUID();
  const provider = yookassaEnabled() ? 'yookassa' : 'test';
  db.prepare('INSERT INTO payments (id, user_id, plan_id, days, amount, provider, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, plan.id, plan.days, plan.price, provider, 'pending', new Date().toISOString());

  if (provider === 'test') return { id, confirmationUrl: `/pay-test.html?id=${id}` };

  const description = `Доступ к сервису розыгрышей: ${plan.title}`;
  const body = {
    amount: { value: plan.price, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: `${baseUrl}/account.html?payment=${id}` },
    description,
    metadata: { paymentId: id, userId: String(user.id), planId: plan.id },
  };
  // Чек по 54-ФЗ, если в ЮKassa подключена отправка чеков
  if (settings.flag('YOOKASSA_RECEIPT')) {
    body.receipt = {
      customer: { email: user.email },
      items: [{ description: description.slice(0, 128), quantity: '1.00', amount: body.amount, vat_code: Number(settings.get('YOOKASSA_VAT_CODE') || 1), payment_mode: 'full_payment', payment_subject: 'service' }],
    };
  }
  try {
    const p = await yk('POST', 'payments', body, id);
    db.prepare('UPDATE payments SET provider_id = ? WHERE id = ?').run(p.id, id);
    return { id, confirmationUrl: p.confirmation.confirmation_url };
  } catch (e) {
    db.prepare("UPDATE payments SET status = 'canceled', note = ? WHERE id = ?").run(e.message, id);
    throw e;
  }
}

// Засчитать платёж и продлить доступ. Повторный вызов ничего не меняет.
function applySuccess(paymentId, note) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p || p.status !== 'pending') return false;
    const u = db.prepare('SELECT paid_until FROM users WHERE id = ?').get(p.user_id);
    const now = new Date();
    const from = u.paid_until && new Date(u.paid_until) > now ? new Date(u.paid_until) : now;
    const to = new Date(from.getTime() + p.days * 86400000);
    db.prepare("UPDATE payments SET status = 'succeeded', paid_at = ?, period_from = ?, period_to = ?, note = COALESCE(?, note) WHERE id = ?")
      .run(now.toISOString(), from.toISOString(), to.toISOString(), note || null, p.id);
    db.prepare('UPDATE users SET paid_until = ? WHERE id = ?').run(to.toISOString(), p.user_id);
    return true;
  });
}

function cancel(paymentId, note) {
  db.prepare("UPDATE payments SET status = 'canceled', note = ? WHERE id = ? AND status = 'pending'").run(note || null, paymentId);
}

// Сверить статус платежа с ЮKassa. Данным из уведомлений не доверяем — всегда перезапрашиваем.
async function syncPayment(p) {
  if (p.provider !== 'yookassa' || p.status !== 'pending' || !p.provider_id) return p;
  const remote = await yk('GET', 'payments/' + p.provider_id);
  if (remote.status === 'succeeded' && remote.paid && remote.amount.value === p.amount && remote.amount.currency === 'RUB') applySuccess(p.id);
  else if (remote.status === 'canceled') cancel(p.id, remote.cancellation_details ? remote.cancellation_details.reason : 'отменён');
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
}

async function checkPayment(user, paymentId) {
  let p = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(paymentId, user.id);
  if (!p) throw new Error('Платёж не найден');
  p = await syncPayment(p);
  return publicPayment(p);
}

// Уведомление от ЮKassa (HTTP-уведомления в личном кабинете ЮKassa → URL /api/yookassa/webhook)
async function handleWebhook(body) {
  const remoteId = body && body.object && body.object.id;
  if (!remoteId) return;
  const p = db.prepare("SELECT * FROM payments WHERE provider = 'yookassa' AND provider_id = ?").get(String(remoteId));
  if (p) await syncPayment(p);
}

// Платежи, которые долго висят в статусе «ожидает»: тестовые отменяем, платежи ЮKassa сверяем
// с ЮKassa (неоплаченные она сама со временем отменяет — тогда отменятся и у нас).
async function settleStale(olderThan) {
  db.prepare("UPDATE payments SET status = 'canceled', note = 'не оплачен вовремя' WHERE provider = 'test' AND status = 'pending' AND created_at < ?").run(olderThan);
  if (!yookassaEnabled()) return;
  const rows = db.prepare("SELECT * FROM payments WHERE provider = 'yookassa' AND status = 'pending' AND created_at < ? LIMIT 50").all(olderThan);
  for (const p of rows) {
    if (!p.provider_id) { cancel(p.id, 'платёж не был создан в ЮKassa'); continue; }
    try { await syncPayment(p); } catch (e) { console.error('Сверка платежа', p.id, e.message); }
  }
}

// Тестовая оплата (только без ЮKassa и не в production)
function completeTestPayment(user, paymentId, success) {
  if (!testModeEnabled()) throw new Error('Тестовая оплата отключена');
  const p = db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ? AND provider = 'test'").get(paymentId, user.id);
  if (!p) throw new Error('Платёж не найден');
  if (success) applySuccess(p.id, 'тестовая оплата');
  else cancel(p.id, 'отменён пользователем');
}

// Ручное продление администратором (например, оплата по счёту или компенсация)
function grantDays(userId, days, adminEmail, note) {
  days = Math.trunc(Number(days));
  if (!days || Math.abs(days) > 3650) throw new Error('Укажите количество дней');
  return tx(() => {
    const u = db.prepare('SELECT paid_until FROM users WHERE id = ?').get(userId);
    if (!u) throw new Error('Пользователь не найден');
    const now = new Date();
    const from = u.paid_until && new Date(u.paid_until) > now ? new Date(u.paid_until) : now;
    const to = new Date(from.getTime() + days * 86400000);
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO payments (id, user_id, plan_id, days, amount, provider, status, created_at, paid_at, period_from, period_to, note) VALUES (?, ?, 'manual', ?, '0.00', 'manual', 'succeeded', ?, ?, ?, ?, ?)")
      .run(id, userId, days, now.toISOString(), now.toISOString(), from.toISOString(), to.toISOString(), `${adminEmail}: ${note || 'ручное изменение'}`);
    db.prepare('UPDATE users SET paid_until = ? WHERE id = ?').run(to.toISOString(), userId);
  });
}

function publicPayment(p) {
  const plan = p.provider !== 'manual' && settings.plans().find((x) => x.id === p.plan_id && x.days === p.days);
  return {
    id: p.id, plan: plan ? plan.title : `${p.days} дн.${p.provider === 'manual' ? ' (вручную)' : ''}`, days: p.days, amount: p.amount, provider: p.provider,
    status: p.status, createdAt: p.created_at, paidAt: p.paid_at, periodFrom: p.period_from, periodTo: p.period_to, note: p.note,
  };
}

function userPayments(userId) {
  return db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId).map(publicPayment);
}

module.exports = {
  yookassaEnabled, yk, testModeEnabled, accessStatus, createPayment, checkPayment, handleWebhook,
  completeTestPayment, grantDays, userPayments, publicPayment, settleStale,
};
