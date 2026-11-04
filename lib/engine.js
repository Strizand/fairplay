// Движок розыгрыша: формирует список участников, проверяет условия, выбирает победителей
// по выбранной механике и собирает данные для отчёта.

const { sha256, obtainEntropy, drawNumber } = require('./rng');
const { parseList } = require('./instagram');

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);

function ageFromBdate(bdate, now = new Date()) {
  const p = String(bdate || '').split('.');
  if (p.length !== 3) return null;
  const [d, m, y] = p.map(Number);
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

function normalizeId(s, network) {
  s = String(s).trim().toLowerCase();
  if (network === 'vk') {
    s = s.replace(/^https?:\/\/(m\.)?vk\.(com|ru)\//, '').replace(/[/?#].*$/, '');
    return s.replace(/^id(\d+)$/, '$1');
  }
  return s.replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/[/?#].*$/, '').replace(/^@/, '');
}

// Человекочитаемый список условий для отчёта
function describeConditions(s, data) {
  const c = s.cond || {};
  const out = [];
  if (c.subscribe) data.groups.forEach((g) => out.push(`Подписка на ${g.name}`));
  if (c.like) out.push(data.network === 'instagram' ? 'Лайк поста (по загруженному списку лайкнувших)' : 'Лайк поста');
  if (c.repost) out.push('Репост записи (репост должен существовать на момент розыгрыша)');
  if (c.comment) out.push('Комментарий под постом' + (c.countReplies === false ? ' (ответы в ветках не считаются)' : ''));
  if (c.keyword) out.push(`Комментарий содержит: «${c.keyword}»`);
  if (num(c.mentions)) out.push(`Отмечено друзей в комментарии: не менее ${num(c.mentions)}`);
  if (num(c.minLength)) out.push(`Длина комментария: не менее ${num(c.minLength)} символов`);
  if (num(c.minComments) > 1) out.push(`Количество подходящих комментариев: не менее ${num(c.minComments)}`);
  if (c.deadline) out.push(`Комментарии засчитываются до ${new Date(c.deadline).toLocaleString('ru-RU')}`);
  if (c.excludeDeactivated !== false && data.network === 'vk') out.push('Исключены удалённые и заблокированные страницы');
  if (c.excludeClosed) out.push('Исключены закрытые профили');
  if (c.excludeNoPhoto) out.push('Исключены профили без фото');
  if (c.sex) out.push('Пол: ' + (c.sex === 'f' ? 'женский' : 'мужской'));
  if (num(c.minAge)) out.push(`Возраст: от ${num(c.minAge)} лет (по дате рождения в профиле)`);
  if (c.city) out.push(`Город: ${c.city}`);
  if (c.excludeOrganizer !== false) out.push('Исключён организатор (автор поста / сообщество)');
  if (c.blacklist) out.push(`Чёрный список: ${parseList(c.blacklist).size} профилей`);
  if (num(c.excludePrevWinnersDays)) out.push(`Исключены победители розыгрышей сервиса за последние ${num(c.excludePrevWinnersDays)} дн.`);
  return out;
}

function evaluate(s, data, prevWinners) {
  const c = s.cond || {};
  const net = data.network;
  if (c.deadline && Number.isNaN(new Date(c.deadline).getTime())) throw new Error('Неверная дата дедлайна');
  const deadline = c.deadline ? new Date(c.deadline).toISOString() : null;
  const keywords = String(c.keyword || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const blacklist = new Set([...parseList(c.blacklist)].map((x) => normalizeId(x, net)));
  const likes = data.likes ? new Set(data.likes) : null;
  const reposts = data.reposts ? new Set(data.reposts) : null;
  const byUser = {};
  data.comments.forEach((cm) => (byUser[cm.userId] = byUser[cm.userId] || []).push(cm));

  // Кто считается участником: все, кто совершил хотя бы одно из требуемых действий
  const sources = [];
  if (c.like && data.likes) sources.push(data.likes);
  if (c.repost && data.reposts) sources.push(data.reposts);
  if (c.comment || c.keyword || num(c.mentions)) sources.push(data.comments.map((x) => x.userId));
  if (!sources.length) sources.push(data.likes || [], data.reposts || [], data.comments.map((x) => x.userId));
  const ids = [...new Set(sources.flat())].sort((a, b) => (/^-?\d+$/.test(a) && /^-?\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)));

  const ownerIds = new Set([String(data.post.ownerId), String(data.post.authorId), String(data.self || '')]);
  const participants = [];
  for (const id of ids) {
    const u = data.users[id] || { id, name: Number(id) < 0 ? 'Сообщество ' + id : id, url: Number(id) < 0 ? `https://vk.com/club${-Number(id)}` : null, photo: null, isGroup: Number(id) < 0 };
    const checks = [];
    const add = (key, label, ok, detail) => checks.push({ key, label, ok: !!ok, detail });

    if (net === 'vk') add('isUser', 'Участвует пользователь, а не сообщество', !u.isGroup && Number(id) > 0);
    if (net === 'vk' && c.excludeDeactivated !== false) add('active', 'Страница не удалена и не заблокирована', !u.deactivated);
    if (c.excludeOrganizer !== false) add('notOrganizer', 'Не организатор', !ownerIds.has(id));
    if (blacklist.size) add('notBlacklisted', 'Не в чёрном списке', !blacklist.has(id) && !blacklist.has(String(u.screenName || '').toLowerCase()));
    if (num(c.excludePrevWinnersDays)) add('notPrevWinner', 'Не побеждал в недавних розыгрышах', !prevWinners.has(`${net}:${id}`));
    if (c.like) add('like', 'Лайк', likes ? likes.has(id) : false, likes ? null : 'список лайков не загружен');
    if (c.repost) add('repost', 'Репост', reposts ? reposts.has(id) : false);

    // Комментарии проходят фильтры последовательно — так видно, на каком шаге участник отсеялся
    let list = (byUser[id] || []).filter((x) => c.countReplies !== false || !x.isReply);
    if (deadline) list = list.filter((x) => x.date <= deadline);
    const needComment = c.comment || keywords.length || num(c.mentions) || num(c.minLength);
    if (needComment) add('comment', deadline ? 'Комментарий до дедлайна' : 'Комментарий', list.length > 0, list.length ? null : (byUser[id] || []).length ? 'комментарий оставлен после дедлайна' : null);
    if (keywords.length) {
      list = list.filter((x) => keywords.some((k) => x.text.toLowerCase().includes(k)));
      add('keyword', 'Ключевое слово в комментарии', list.length > 0);
    }
    if (num(c.mentions)) {
      const selfKeys = new Set([String(id), 'id' + id, String(u.screenName || '').toLowerCase()]);
      list = list.filter((x) => x.mentions.filter((m) => !selfKeys.has(m)).length >= num(c.mentions));
      add('mentions', `Отмечено друзей ≥ ${num(c.mentions)}`, list.length > 0);
    }
    if (num(c.minLength)) {
      list = list.filter((x) => x.text.replace(/\[[^\]|]+\|([^\]]*)\]/g, '$1').trim().length >= num(c.minLength));
      add('minLength', `Длина комментария ≥ ${num(c.minLength)}`, list.length > 0);
    }
    if (num(c.minComments) > 1) add('minComments', `Подходящих комментариев ≥ ${num(c.minComments)}`, list.length >= num(c.minComments), `${list.length}`);
    if (c.subscribe) data.groups.forEach((g) => add('sub:' + g.id, 'Подписка на ' + g.name, data.membership[g.id] && data.membership[g.id].has(id)));
    if (c.excludeClosed) add('open', 'Открытый профиль', !u.closed);
    if (c.excludeNoPhoto) add('photo', 'Есть фото профиля', u.hasPhoto !== false && !!u.photo);
    if (c.sex) add('sex', 'Пол', u.sex === c.sex);
    if (num(c.minAge)) {
      const age = ageFromBdate(u.bdate);
      add('age', `Возраст от ${num(c.minAge)}`, age !== null && age >= num(c.minAge), age === null ? 'год рождения скрыт' : `${age} лет`);
    }
    if (c.city) add('city', 'Город', !!u.city && u.city.toLowerCase().includes(String(c.city).toLowerCase()), u.city || 'не указан');

    participants.push({
      id,
      name: u.name,
      screenName: u.screenName || null,
      url: u.url,
      photo: u.photo,
      ok: checks.every((x) => x.ok),
      checks,
      validComments: list.map((x) => x.id),
    });
  }
  return participants;
}

function stats(participants) {
  const per = {};
  participants.forEach((p) =>
    p.checks.forEach((ch) => {
      per[ch.key] = per[ch.key] || { label: ch.label, passed: 0, failed: 0 };
      per[ch.key][ch.ok ? 'passed' : 'failed']++;
    })
  );
  const met = participants.filter((p) => p.ok).length;
  return { total: participants.length, met, notMet: participants.length - met, perCondition: Object.values(per) };
}

async function runDraw(s, data, { prevWinners = new Set(), progress = () => {} } = {}) {
  s.cond = s.cond || {};
  if (s.mechanic && s.mechanic !== 'random') s.cond.comment = true; // эти механики работают по комментариям
  progress('Проверяю выполнение условий…');
  const participants = evaluate(s, data, prevWinners);
  const P = Object.fromEntries(participants.map((p) => [p.id, p]));
  const commentsById = Object.fromEntries(data.comments.map((c) => [c.id, c]));
  const winnersN = Math.max(1, num(s.winners, 1));
  const reservesN = Math.max(0, num(s.reserves, 0));
  const need = winnersN + reservesN;
  const mechanic = s.mechanic || 'random';
  const filterFirst = s.checkMode === 'filterThenDraw';
  const ticketsByComment = s.tickets === 'comment';

  // Пул для генератора. Каждая строка: номер | id участника | id комментария (если билет = комментарий)
  let pool = [];
  if (mechanic === 'random') {
    for (const p of participants) {
      if (filterFirst && !p.ok) continue;
      if (ticketsByComment && p.validComments.length) p.validComments.forEach((cid) => pool.push([p.id, cid]));
      else pool.push([p.id, '']);
    }
  } else if (mechanic === 'commentNumber' || mechanic === 'firstN' || mechanic === 'guessNumber') {
    pool = data.comments.filter((c) => s.cond.countReplies !== false || !c.isReply).map((c) => [c.userId, c.id]);
  }
  pool = pool.map((e, i) => [i + 1, ...e]);
  const poolText = pool.map((e) => e.join('|')).join('\n');
  const participantsHash = sha256(poolText);
  // Итоги проверки условий тоже фиксируются ДО получения случайного числа: «id|1» — выполнил все условия, «id|0» — нет,
  // в том же порядке, что и список участников в отчёте. Seed зависит от обоих хешей, поэтому поменять
  // вердикты после того, как стало известно случайное число, незаметно нельзя.
  const verdictsHash = sha256(participants.map((p) => `${p.id}|${p.ok ? 1 : 0}`).join('\n'));

  const usesRng = mechanic === 'random' || mechanic === 'guessNumber';
  let rng = { source: 'none', participantsHash, verdictsHash, committedAt: new Date().toISOString() };
  if (usesRng) {
    progress('Список участников зафиксирован. Жду будущий раунд публичного маяка случайности drand…');
    rng = { ...(await obtainEntropy(participantsHash + ':' + verdictsHash)), participantsHash, verdictsHash };
  }

  const log = [];
  const winners = [];
  const reserves = [];
  const taken = new Set();
  const accept = (p, extra) => {
    taken.add(p.id);
    const slot = winners.length < winnersN ? winners : reserves;
    slot.push({ ...pick(p), place: slot.length + 1, ...extra });
    return slot === winners ? 'winner' : 'reserve';
  };
  const failed = (p) => p.checks.filter((x) => !x.ok).map((x) => x.label + (x.detail ? ` (${x.detail})` : ''));
  // Для механик по комментариям выигрывает конкретный комментарий: он сам должен быть засчитан
  // (до дедлайна, с ключевым словом, с отметками и т.д.), а не просто какой-то другой комментарий того же участника.
  const validComment = new Set(participants.flatMap((p) => p.validComments));
  const entryCheck = (p, cid) => {
    if (!p.ok) return { ok: false, failed: failed(p) };
    if (cid && !validComment.has(cid)) return { ok: false, failed: ['этот комментарий не соответствует условиям (дедлайн, ключевое слово, отметки, длина или ответ в ветке)'] };
    return { ok: true, failed: [] };
  };

  if (mechanic === 'random') {
    let remaining = pool.slice();
    for (let k = 1; winners.length + reserves.length < need && remaining.length && k <= 20000; k++) {
      const d = drawNumber(rng.seed, k, remaining.length);
      const entry = remaining[d.number - 1];
      const p = P[entry[1]];
      remaining = remaining.filter((e) => e[1] !== p.id); // один приз в одни руки
      const verdict = p.ok ? accept(p, { ticket: entry[0], comment: entry[2] ? commentsById[entry[2]]?.text : undefined }) : 'fail';
      log.push({ step: k, hmac: d.hmac, label: d.label, rejected: d.rejected, number: d.number, range: d.range, poolIndex: entry[0], userId: p.id, name: p.name, url: p.url, verdict, failed: p.ok ? [] : failed(p) });
    }
  } else if (mechanic === 'commentNumber') {
    const targets = String(s.commentNumbers || '').split(/[\s,;]+/).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    if (!targets.length) throw new Error('Укажите номера комментариев, например: 50, 100');
    let pos = 0;
    for (const t of targets) {
      if (winners.length + reserves.length >= need) break;
      for (pos = Math.max(pos, t); pos <= pool.length; pos++) {
        const [n, uid, cid] = pool[pos - 1];
        const p = P[uid];
        if (!p) continue;
        if (taken.has(uid)) { log.push({ step: log.length + 1, number: n, userId: uid, name: p.name, url: p.url, verdict: 'duplicate', failed: ['уже среди победителей'] }); continue; }
        const ch = entryCheck(p, cid);
        const verdict = ch.ok ? accept(p, { ticket: n, comment: commentsById[cid]?.text }) : 'fail';
        log.push({ step: log.length + 1, number: n, target: t, userId: uid, name: p.name, url: p.url, verdict, failed: ch.failed });
        if (ch.ok) { pos++; break; }
      }
    }
    // резервные — следующие подходящие комментарии после последнего победителя
    for (; winners.length + reserves.length < need && pos <= pool.length; pos++) {
      const [n, uid, cid] = pool[pos - 1];
      const p = P[uid];
      if (!p || taken.has(uid)) continue;
      const ch = entryCheck(p, cid);
      const verdict = ch.ok ? accept(p, { ticket: n, comment: commentsById[cid]?.text }) : 'fail';
      log.push({ step: log.length + 1, number: n, userId: uid, name: p.name, url: p.url, verdict, failed: ch.failed });
    }
  } else if (mechanic === 'firstN') {
    for (const [n, uid, cid] of pool) {
      if (winners.length + reserves.length >= need) break;
      const p = P[uid];
      if (!p || taken.has(uid)) continue;
      const ch = entryCheck(p, cid);
      const verdict = ch.ok ? accept(p, { ticket: n, comment: commentsById[cid]?.text }) : 'fail';
      log.push({ step: log.length + 1, number: n, userId: uid, name: p.name, url: p.url, verdict, failed: ch.failed });
    }
  } else if (mechanic === 'guessNumber') {
    const min = num(s.guessMin, 1);
    const max = num(s.guessMax, 100);
    if (max <= min) throw new Error('Неверный диапазон для «Угадай число»');
    const d = drawNumber(rng.seed, 1, max - min + 1);
    const target = d.number + min - 1;
    rng.guess = { min, max, target, hmac: d.hmac, label: d.label, value48: d.value48, rejected: d.rejected };
    // Догадка участника — первое число в диапазоне из его первого засчитанного комментария
    const guesses = [];
    for (const p of participants) {
      const cid = p.validComments[0] || (data.comments.find((c) => c.userId === p.id) || {}).id;
      const cm = commentsById[cid];
      if (!cm) continue;
      const g = (cm.text.replace(/\[[^\]]*\]/g, '').match(/-?\d+/g) || []).map(Number).find((x) => x >= min && x <= max);
      if (g === undefined) continue;
      guesses.push({ p, g, date: cm.date, text: cm.text });
    }
    guesses.sort((a, b) => Math.abs(a.g - target) - Math.abs(b.g - target) || a.date.localeCompare(b.date));
    for (const x of guesses) {
      if (winners.length + reserves.length >= need) break;
      const verdict = x.p.ok ? accept(x.p, { guess: x.g, comment: x.text }) : 'fail';
      log.push({ step: log.length + 1, number: x.g, distance: Math.abs(x.g - target), userId: x.p.id, name: x.p.name, url: x.p.url, verdict, failed: x.p.ok ? [] : failed(x.p) });
    }
  }

  if (data.enrichWinner) for (const w of [...winners, ...reserves]) await data.enrichWinner(w);
  return { participants, stats: stats(participants), pool, rng, log, winners, reserves, mechanic, conditions: describeConditions(s, data) };
}

function pick(p) {
  return { id: p.id, name: p.name, screenName: p.screenName, url: p.url, photo: p.photo };
}

module.exports = { runDraw, evaluate, describeConditions, ageFromBdate };
