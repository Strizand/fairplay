// Хранилище отчётов: сами отчёты — неизменяемые JSON-файлы в data/reports/,
// а краткая сводка с владельцем — в таблице draws (для истории, исключения прошлых победителей
// и подсчёта всех розыгрышей по одному посту).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');

const DIR = path.join(__dirname, '..', 'data', 'reports');
fs.mkdirSync(DIR, { recursive: true });

function newId() {
  const a = '23456789abcdefghjkmnpqrstuvwxyz';
  return Array.from(crypto.randomBytes(10), (b) => a[b % a.length]).join('');
}

// Ключ поста: по нему находятся все розыгрыши, проведённые по одной и той же публикации.
// Для реальных постов — идентификатор из API соцсети (одинаковый при любой форме ссылки),
// для демо — нормализованная ссылка (демо-данные сгенерированы, поэтому считаются отдельно от реальных).
function postKey(report) {
  const net = report.network;
  const post = report.post || {};
  if (!report.demo && post.id) return `${net}:${String(post.id).toLowerCase()}`;
  const url = String(post.url || '').trim().toLowerCase();
  const vk = url.match(/wall(-?\d+_\d+)/);
  const ig = url.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([a-z0-9_-]+)/);
  const id = vk ? vk[1] : ig ? ig[1] : url.replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `demo:${net}:${id}`;
}

// Миграция: колонка post_key и заполнение её для розыгрышей, проведённых до появления этой функции
if (!db.prepare('PRAGMA table_info(draws)').all().some((c) => c.name === 'post_key')) {
  db.exec('ALTER TABLE draws ADD COLUMN post_key TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS draws_post ON draws(post_key, created_at)');
for (const row of db.prepare('SELECT report_id FROM draws WHERE post_key IS NULL').all()) {
  try {
    const f = path.join(DIR, row.report_id + '.json');
    if (!fs.existsSync(f)) continue;
    db.prepare('UPDATE draws SET post_key = ? WHERE report_id = ?').run(postKey(JSON.parse(fs.readFileSync(f, 'utf8'))), row.report_id);
  } catch (e) {
    console.error('Не удалось определить пост для отчёта', row.report_id, e.message);
  }
}

function save(report, userId) {
  fs.writeFileSync(path.join(DIR, report.id + '.json'), JSON.stringify(report));
  db.prepare('INSERT INTO draws (report_id, user_id, created_at, network, title, demo, total, winners, post_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    report.id, userId || null, report.createdAt, report.network, report.title, report.demo ? 1 : 0, report.stats.total,
    JSON.stringify(report.winners.map((w) => ({ id: w.id, name: w.name }))), postKey(report)
  );
}

function load(id) {
  if (!/^[a-z0-9]{6,20}$/.test(id)) return null;
  const f = path.join(DIR, id + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

// Все розыгрыши по тому же посту, что и этот отчёт, — в порядке проведения.
// Считается в момент открытия отчёта, поэтому в старом отчёте видны и более поздние перезапуски.
// Кто их проводил, не раскрывается — только признак «тот же организатор» или «другой аккаунт».
function postHistory(report) {
  const me = db.prepare('SELECT user_id, post_key FROM draws WHERE report_id = ?').get(report.id);
  const key = (me && me.post_key) || postKey(report);
  const owner = me ? me.user_id : null;
  return db.prepare('SELECT report_id, user_id, created_at, title, demo, total, winners FROM draws WHERE post_key = ? ORDER BY created_at, report_id').all(key).map((r) => ({
    id: r.report_id,
    createdAt: r.created_at,
    title: r.title,
    demo: !!r.demo,
    total: r.total,
    winners: JSON.parse(r.winners).map((w) => w.name),
    current: r.report_id === report.id,
    // Анонимные демо без аккаунта нельзя связать с организатором — для них признак не определён (null)
    sameOrganizer: owner != null && r.user_id != null ? r.user_id === owner : null,
  }));
}

// Розыгрыши конкретного пользователя (чужие в истории не показываются)
function list(userId) {
  return db.prepare('SELECT * FROM draws WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId).map((r) => ({
    id: r.report_id, createdAt: r.created_at, network: r.network, title: r.title, demo: !!r.demo, total: r.total,
    winners: JSON.parse(r.winners).map((w) => w.name),
  }));
}

// Победители прошлых (не демо) розыгрышей этого пользователя за последние days дней
function recentWinners(userId, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const set = new Set();
  for (const r of db.prepare('SELECT network, winners FROM draws WHERE user_id = ? AND demo = 0 AND created_at >= ?').all(userId, since)) {
    JSON.parse(r.winners).forEach((w) => set.add(`${r.network}:${w.id}`));
  }
  return set;
}

module.exports = { newId, save, load, list, recentWinners, postHistory };
