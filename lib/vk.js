// Сбор данных о посте ВКонтакте через официальный VK API.
// Нужен сервисный ключ приложения или ключ пользователя/сообщества (см. README).

const API = 'https://api.vk.com/method/';
const V = '5.199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePostUrl(url) {
  const m = String(url).match(/wall(-?\d+)_(\d+)/);
  if (!m) throw new Error('Не удалось найти в ссылке идентификатор поста вида wall-123_456');
  return { ownerId: Number(m[1]), postId: Number(m[2]) };
}

function makeClient(token, progress) {
  let last = 0;
  return async function call(method, params = {}) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = last + 350 - Date.now(); // не больше ~3 запросов в секунду
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const body = new URLSearchParams({ ...params, access_token: token, v: V });
      let json;
      try {
        const res = await fetch(API + method, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
        json = await res.json();
      } catch (e) {
        // Сетевой сбой, таймаут или не-JSON ответ — пробуем ещё раз, на последней попытке сообщаем об ошибке
        if (attempt === 5) throw new Error(`VK API ${method}: нет ответа от сервера (${e.name === 'TimeoutError' ? 'таймаут' : e.message})`);
        await sleep(2000);
        continue;
      }
      if (json.error) {
        if (json.error.error_code === 6) { await sleep(1000); continue; } // слишком много запросов
        if (json.error.error_code === 10 || json.error.error_code === 1) { await sleep(1500); continue; }
        throw new Error(`VK API ${method}: ${json.error.error_msg} (код ${json.error.error_code})`);
      }
      return json.response;
    }
    throw new Error(`VK API ${method}: превышено число повторов`);
  };
}

async function listAll(call, method, params, progress, label) {
  const ids = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await call(method, { ...params, count: 1000, offset });
    ids.push(...r.items);
    progress && progress(`${label}: ${ids.length} из ${r.count}`);
    if (r.items.length === 0 || ids.length >= r.count) break;
  }
  return ids;
}

// Упоминания в тексте комментария: [id123|Имя], [club1|...], @id123, @screen_name
function extractMentions(text) {
  const set = new Set();
  for (const m of text.matchAll(/\[(id\d+|club\d+|public\d+|[a-z0-9_.]+)\|[^\]]*\]/gi)) set.add(m[1].toLowerCase());
  for (const m of text.matchAll(/(?:^|[\s,(])@([a-z0-9_.]{2,})/gi)) set.add(m[1].toLowerCase());
  return [...set];
}

function mapUser(u) {
  return {
    id: String(u.id),
    name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
    screenName: u.domain || u.screen_name || 'id' + u.id,
    url: `https://vk.com/${u.domain || 'id' + u.id}`,
    photo: u.photo_200 || u.photo_100 || null,
    hasPhoto: u.has_photo === 1,
    closed: !!u.is_closed && !u.can_access_closed,
    deactivated: u.deactivated || null,
    sex: u.sex === 1 ? 'f' : u.sex === 2 ? 'm' : null,
    bdate: u.bdate || null,
    city: u.city ? u.city.title : null,
  };
}

async function fetchVk(url, { token, groups = [], progress }) {
  if (!token) throw new Error('Розыгрыши по реальным постам ВКонтакте временно недоступны: сервис не подключён к VK API. Попробуйте демо-режим или напишите в поддержку.');
  const call = makeClient(token);
  const { ownerId, postId } = parsePostUrl(url);

  progress('Загружаю пост…');
  const pr = await call('wall.getById', { posts: `${ownerId}_${postId}`, extended: 1 });
  const items = pr.items || pr;
  const p = items[0];
  if (!p) throw new Error('Пост не найден или недоступен с этим токеном');
  const ownerGroup = (pr.groups || []).find((g) => -g.id === ownerId);
  const ownerProfile = (pr.profiles || []).find((u) => u.id === ownerId);

  const likes = await listAll(call, 'likes.getList', { type: 'post', owner_id: ownerId, item_id: postId, filter: 'likes' }, progress, 'Лайки');
  const reposts = await listAll(call, 'likes.getList', { type: 'post', owner_id: ownerId, item_id: postId, filter: 'copies' }, progress, 'Репосты');

  // Комментарии, включая ветки ответов
  const comments = [];
  const pushComment = (c, isReply) => {
    if (c.deleted || !c.from_id) return;
    comments.push({
      id: String(c.id),
      userId: String(c.from_id),
      text: c.text || '',
      date: new Date(c.date * 1000).toISOString(),
      isReply,
      mentions: extractMentions(c.text || ''),
    });
  };
  for (let offset = 0; ; offset += 100) {
    const r = await call('wall.getComments', { owner_id: ownerId, post_id: postId, count: 100, offset, sort: 'asc', thread_items_count: 10 });
    for (const c of r.items) {
      pushComment(c, false);
      const th = c.thread || { count: 0, items: [] };
      if (th.count > (th.items || []).length) {
        for (let o2 = 0; ; o2 += 100) {
          const rr = await call('wall.getComments', { owner_id: ownerId, post_id: postId, comment_id: c.id, count: 100, offset: o2, sort: 'asc' });
          rr.items.forEach((x) => pushComment(x, true));
          if (rr.items.length < 100) break;
        }
      } else (th.items || []).forEach((x) => pushComment(x, true));
    }
    progress(`Комментарии: ${comments.length}`);
    if (r.items.length < 100) break;
  }
  comments.sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));

  // Профили всех участников
  const allIds = [...new Set([...likes, ...reposts, ...comments.map((c) => Number(c.userId))].filter((id) => id > 0))];
  const users = {};
  for (let i = 0; i < allIds.length; i += 500) {
    const r = await call('users.get', {
      user_ids: allIds.slice(i, i + 500).join(','),
      fields: 'photo_200,photo_100,has_photo,sex,bdate,city,domain,is_closed,can_access_closed',
    });
    r.forEach((u) => (users[String(u.id)] = mapUser(u)));
    progress(`Профили: ${Object.keys(users).length} из ${allIds.length}`);
  }

  // Подписки на сообщества (организатор + спонсоры)
  const membership = {};
  const groupInfo = [];
  for (const raw of groups) {
    const key = String(raw).trim().replace(/^https?:\/\/(m\.)?vk\.(com|ru)\//, '').replace(/[/?#].*$/, '');
    if (!key) continue;
    const gr = await call('groups.getById', { group_ids: key.replace(/^(club|public)(\d+)$/, '$2') });
    const g = (gr.groups || gr)[0];
    if (!g) throw new Error('Сообщество не найдено: ' + raw);
    const members = new Set();
    for (let i = 0; i < allIds.length; i += 500) {
      const r = await call('groups.isMember', { group_id: g.id, user_ids: allIds.slice(i, i + 500).join(',') });
      r.forEach((x) => x.member && members.add(String(x.user_id)));
      progress(`Подписка на «${g.name}»: проверено ${Math.min(i + 500, allIds.length)} из ${allIds.length}`);
    }
    membership[String(g.id)] = members;
    groupInfo.push({ id: String(g.id), name: g.name, url: `https://vk.com/${g.screen_name || 'club' + g.id}` });
  }

  return {
    network: 'vk',
    post: {
      url: `https://vk.com/wall${ownerId}_${postId}`,
      id: `${ownerId}_${postId}`,
      ownerId: String(ownerId),
      authorId: String(p.signer_id || p.from_id || ownerId),
      ownerName: ownerGroup ? ownerGroup.name : ownerProfile ? `${ownerProfile.first_name} ${ownerProfile.last_name}` : String(ownerId),
      ownerUrl: ownerGroup ? `https://vk.com/${ownerGroup.screen_name}` : `https://vk.com/id${ownerId}`,
      text: (p.text || '').slice(0, 600),
      date: new Date(p.date * 1000).toISOString(),
      likes: p.likes ? p.likes.count : likes.length,
      reposts: p.reposts ? p.reposts.count : reposts.length,
      comments: p.comments ? p.comments.count : comments.length,
      views: p.views ? p.views.count : null,
    },
    users,
    likes: likes.map(String),
    reposts: reposts.map(String),
    comments,
    groups: groupInfo,
    membership,
  };
}

module.exports = { fetchVk, parsePostUrl, extractMentions };
