// Настройки сервиса, которые администратор меняет на странице /admin.html.
// Значение берётся из базы; если в базе его нет — из файла .env. Изменения действуют сразу, без перезапуска.

const { db, tx } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
`);

const DEFAULT_PLANS = [
  { id: 'day', title: '1 день', days: 1, price: '290.00', hint: 'Провести один-два розыгрыша' },
  { id: 'month', title: '30 дней', days: 30, price: '990.00', hint: 'Для регулярных розыгрышей', popular: true },
  { id: 'year', title: '365 дней', days: 365, price: '4990.00', hint: 'Выгоднее на 58%' },
];

// Описание всех настроек для страницы администратора
const FIELDS = [
  { group: 'site', key: 'PUBLIC_URL', label: 'Адрес сайта', hint: 'Например https://rozygrysh.ru. Нужен для ссылок в письмах и возврата после оплаты. Пусто — адрес из браузера.' },
  { group: 'site', key: 'ADMIN_EMAILS', label: 'E-mail администраторов', hint: 'Через запятую. Администраторы из файла .env остаются всегда — это страховка от потери доступа.' },
  { group: 'site', key: 'COOKIE_SECURE', label: 'Сайт работает по HTTPS', type: 'bool', hint: 'Включайте только когда сайт открывается по https:// — иначе вход перестанет работать.' },
  { group: 'site', key: 'TRUST_PROXY', label: 'Сервис стоит за nginx / Caddy', type: 'bool', hint: 'Брать IP посетителя из заголовка X-Forwarded-For.' },

  { group: 'legal', key: 'SELLER_NAME', label: 'Продавец (ИП, ООО или самозанятый)', hint: 'Как в документах: «ИП Иванов Иван Иванович», «ООО «Ромашка»» или «Иванов Иван Иванович (самозанятый)». Подставляется в оферту, политику и контакты.' },
  { group: 'legal', key: 'SELLER_INN', label: 'ИНН' },
  { group: 'legal', key: 'SELLER_OGRN', label: 'ОГРН / ОГРНИП', hint: 'Самозанятым оставить пустым.' },
  { group: 'legal', key: 'SELLER_ADDRESS', label: 'Адрес', hint: 'Юридический адрес или адрес регистрации ИП (для самозанятых можно указать город).' },
  { group: 'legal', key: 'SUPPORT_EMAIL', label: 'E-mail поддержки', hint: 'Сюда пишут клиенты, сюда же приходят запросы по персональным данным.' },
  { group: 'legal', key: 'SUPPORT_PHONE', label: 'Телефон (необязательно)' },

  { group: 'vk', key: 'VK_TOKEN', label: 'Сервисный ключ доступа VK', secret: true, hint: 'dev.vk.com → ваше приложение → Настройки → «Сервисный ключ доступа».' },

  { group: 'ig', key: 'IG_TOKEN', label: 'Access token Instagram Graph API', secret: true, hint: 'Долгосрочный токен с правами instagram_basic, instagram_manage_comments.' },
  { group: 'ig', key: 'IG_USER_ID', label: 'ID Instagram Business-аккаунта', hint: 'Число вида 17841400000000000.' },

  { group: 'pay', key: 'YOOKASSA_SHOP_ID', label: 'shopId магазина', hint: 'Личный кабинет ЮKassa → Интеграция → Ключи API.' },
  { group: 'pay', key: 'YOOKASSA_SECRET_KEY', label: 'Секретный ключ', secret: true },
  { group: 'pay', key: 'YOOKASSA_RECEIPT', label: 'Передавать чеки (54-ФЗ)', type: 'bool', hint: 'Включайте, если в ЮKassa подключена отправка чеков.' },
  { group: 'pay', key: 'YOOKASSA_VAT_CODE', label: 'Код НДС в чеке', type: 'select', options: [['1', 'Без НДС'], ['2', 'НДС 0%'], ['3', 'НДС 10%'], ['4', 'НДС 20%'], ['5', 'НДС 10/110'], ['6', 'НДС 20/120']] },

  { group: 'mail', key: 'SMTP_HOST', label: 'SMTP-сервер', hint: 'Яндекс: smtp.yandex.ru, Mail.ru: smtp.mail.ru.' },
  { group: 'mail', key: 'SMTP_PORT', label: 'Порт', type: 'select', options: [['465', '465 (SSL)'], ['587', '587 (STARTTLS)'], ['25', '25']] },
  { group: 'mail', key: 'SMTP_USER', label: 'Логин (адрес ящика)' },
  { group: 'mail', key: 'SMTP_PASS', label: 'Пароль приложения', secret: true, hint: 'Не обычный пароль от почты, а «пароль приложения» из настроек почты.' },
  { group: 'mail', key: 'SMTP_FROM', label: 'Отправитель', hint: 'Например: ЧестныйРозыгрыш <noreply@ваш-домен.ru>' },

  { group: 'plans', key: 'PLANS', type: 'plans' },
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

const cache = new Map();
function reload() {
  cache.clear();
  for (const r of db.prepare('SELECT key, value FROM settings').all()) cache.set(r.key, r.value);
}
reload();

function get(key) {
  if (cache.has(key)) return cache.get(key);
  return process.env[key] || '';
}
const flag = (key) => get(key) === '1';

function plans() {
  try {
    const p = JSON.parse(get('PLANS') || 'null');
    if (Array.isArray(p) && p.length) return p;
  } catch (_) { /* испорченное значение — берём тарифы по умолчанию */ }
  return DEFAULT_PLANS;
}

function admins() {
  const split = (s) => String(s || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  return new Set([...split(process.env.ADMIN_EMAILS), ...split(cache.get('ADMIN_EMAILS'))]);
}

function validatePlans(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Нужен хотя бы один тариф');
  if (list.length > 10) throw new Error('Не больше 10 тарифов');
  const ids = new Set();
  return list.map((p, i) => {
    const title = String(p.title || '').trim();
    const days = Math.trunc(Number(p.days));
    const price = Number(String(p.price).replace(',', '.'));
    if (!title) throw new Error(`Тариф ${i + 1}: укажите название`);
    if (!(days >= 1 && days <= 3660)) throw new Error(`Тариф «${title}»: срок от 1 до 3660 дней`);
    if (!(price >= 1 && price <= 1000000)) throw new Error(`Тариф «${title}»: цена от 1 до 1 000 000 ₽`);
    let id = String(p.id || '').trim().replace(/[^\w-]/g, '') || 'p' + days;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    return { id, title, days, price: price.toFixed(2), hint: String(p.hint || '').trim().slice(0, 120), popular: !!p.popular };
  });
}

// Сохранение из админки. values — новые значения; пустая строка = удалить из базы (вернуться к .env)
// Сначала проверяются ВСЕ значения, потом они записываются одной транзакцией:
// при ошибке в любом поле не сохраняется ничего, и база не расходится с тем, что видит сервис.
function save(values, adminEmail) {
  const now = new Date().toISOString();
  const upsert = db.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const prepared = [];
  for (const [key, raw] of Object.entries(values || {})) {
    const f = BY_KEY[key];
    if (!f) throw new Error('Неизвестная настройка: ' + key);
    let v = raw;
    if (f.type === 'plans') v = JSON.stringify(validatePlans(raw));
    else if (f.type === 'bool') v = raw ? '1' : '0';
    else v = String(raw ?? '').trim();
    if (key === 'PUBLIC_URL' && v && !/^https?:\/\/[^\s/]+$/.test(v.replace(/\/+$/, ''))) throw new Error('Адрес сайта — в виде https://ваш-сайт.ru, без пути');
    if (key === 'PUBLIC_URL') v = v.replace(/\/+$/, '');
    if (key === 'ADMIN_EMAILS' && v && v.split(/[\s,;]+/).some((e) => e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error('Проверьте адреса администраторов');
    if (f.options && v && !f.options.some((o) => o[0] === v)) throw new Error('Недопустимое значение: ' + f.label);
    if (f.group === 'legal' && v.length > 300) throw new Error(`${f.label}: не длиннее 300 символов`);
    if (key === 'SELLER_INN' && v && !/^\d{10}(\d{2})?$/.test(v)) throw new Error('ИНН — 10 цифр (организация) или 12 цифр (ИП, самозанятый)');
    if (key === 'SELLER_OGRN' && v && !/^\d{13}(\d{2})?$/.test(v)) throw new Error('ОГРН — 13 цифр, ОГРНИП — 15 цифр');
    if (key === 'SUPPORT_EMAIL' && v && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v)) throw new Error('Проверьте e-mail поддержки');
    prepared.push([key, v]);
  }
  try {
    tx(() => {
      for (const [key, v] of prepared) {
        if (v === '') del.run(key);
        else upsert.run(key, v, now, adminEmail);
      }
    });
  } finally {
    reload(); // кэш всегда соответствует базе
  }
  return prepared.map(([key]) => key);
}

// Для страницы администратора. Секреты наружу не отдаются — только признак «задан» и последние 4 символа.
function describe() {
  const meta = Object.fromEntries(db.prepare('SELECT key, updated_at, updated_by FROM settings').all().map((r) => [r.key, r]));
  return FIELDS.map((f) => {
    const inDb = cache.has(f.key);
    const value = get(f.key);
    const out = { ...f, source: inDb ? 'db' : process.env[f.key] ? 'env' : 'none', updatedAt: meta[f.key]?.updated_at, updatedBy: meta[f.key]?.updated_by };
    if (f.type === 'plans') out.value = plans();
    else if (f.secret) out.preview = value ? '••••' + value.slice(-4) : '';
    else out.value = value;
    if (f.key === 'ADMIN_EMAILS') out.envValue = process.env.ADMIN_EMAILS || '';
    return out;
  });
}

module.exports = { get, flag, plans, admins, save, describe };
