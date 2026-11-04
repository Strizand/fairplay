// Сбор данных о посте Instagram через официальный Instagram Graph API.
//
// Ограничения официального API (их не обойти без нарушения правил Meta):
//   • доступны только посты СВОЕГО профессионального (Business/Creator) аккаунта;
//   • комментарии — доступны полностью (автор, текст, время, ответы);
//   • список лайкнувших и список подписчиков — НЕ доступны, только их количество.
// Поэтому лайки и подписку сервис проверяет по спискам, которые организатор загружает сам
// (экспорт из сторонних инструментов или ручная выгрузка) — это явно отражается в отчёте.

const GRAPH = 'https://graph.facebook.com/v21.0/';

function parseShortcode(url) {
  const m = String(url).match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('Не удалось распознать ссылку на пост Instagram (ожидается instagram.com/p/… или /reel/…)');
  return m[1];
}

async function g(path, params, token) {
  const u = new URL(path.startsWith('http') ? path : GRAPH + path);
  Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', token);
  let j;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    j = await r.json();
  } catch (e) {
    throw new Error('Instagram Graph API: нет ответа от сервера (' + (e.name === 'TimeoutError' ? 'таймаут' : e.message) + ')');
  }
  if (j.error) throw new Error('Instagram Graph API: ' + j.error.message);
  return j;
}

function extractMentions(text, self) {
  const set = new Set();
  for (const m of String(text).matchAll(/@([A-Za-z0-9_.]{1,30})/g)) {
    const u = m[1].replace(/\.+$/, '').toLowerCase();
    if (u && u !== self) set.add(u);
  }
  return [...set];
}

function parseList(text) {
  return new Set(
    String(text || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/[/?].*$/, '').replace(/^@/, '').toLowerCase())
      .filter(Boolean)
  );
}

async function fetchInstagram(url, { token, igUserId, likersList, followersList, progress }) {
  if (!token || !igUserId) throw new Error('Розыгрыши по реальным постам Instagram временно недоступны: сервис не подключён к Instagram API. Попробуйте демо-режим.');
  const code = parseShortcode(url);

  progress('Ищу пост среди публикаций аккаунта…');
  let media = null;
  let next = null;
  let account = null;
  for (let page = 0; page < 40 && !media; page++) {
    const r = next
      ? await g(next, {}, token)
      : await g(`${igUserId}/media`, { fields: 'id,permalink,shortcode,caption,timestamp,like_count,comments_count,username', limit: 50 }, token);
    for (const m of r.data) {
      account = account || m.username;
      if ((m.shortcode && m.shortcode === code) || (m.permalink && m.permalink.includes('/' + code))) media = m;
    }
    next = r.paging && r.paging.next;
    if (!next) break;
  }
  if (!media) throw new Error('Пост не найден среди публикаций подключённого аккаунта. Официальный API даёт доступ только к постам своего аккаунта.');
  const self = (media.username || account || '').toLowerCase();

  const comments = [];
  const push = (c, isReply) =>
    comments.push({
      id: c.id,
      userId: (c.username || (c.from && c.from.username) || '').toLowerCase(),
      text: c.text || '',
      date: c.timestamp,
      isReply,
      mentions: extractMentions(c.text, (c.username || '').toLowerCase()),
    });
  let r = await g(`${media.id}/comments`, { fields: 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}', limit: 50 }, token);
  for (;;) {
    for (const c of r.data) {
      push(c, false);
      ((c.replies && c.replies.data) || []).forEach((x) => push(x, true));
    }
    progress(`Комментарии: ${comments.length} из ~${media.comments_count}`);
    if (!r.paging || !r.paging.next) break;
    r = await g(r.paging.next, {}, token);
  }
  comments.sort((a, b) => a.date.localeCompare(b.date));

  const likers = likersList ? [...parseList(likersList)] : null;
  const followers = followersList ? parseList(followersList) : null;

  const users = {};
  const ensure = (u) => {
    if (!u || users[u]) return;
    users[u] = { id: u, name: u, screenName: u, url: `https://www.instagram.com/${u}/`, photo: null };
  };
  comments.forEach((c) => ensure(c.userId));
  (likers || []).forEach(ensure);

  return {
    network: 'instagram',
    self,
    post: {
      url: media.permalink,
      id: media.id,
      ownerId: self,
      authorId: self,
      ownerName: '@' + self,
      ownerUrl: `https://www.instagram.com/${self}/`,
      text: (media.caption || '').slice(0, 600),
      date: media.timestamp,
      likes: media.like_count,
      comments: media.comments_count,
      reposts: null,
      views: null,
    },
    users,
    likes: likers,
    reposts: null,
    comments,
    groups: followers ? [{ id: self, name: '@' + self + ' (по загруженному списку подписчиков)', url: `https://www.instagram.com/${self}/` }] : [],
    membership: followers ? { [self]: followers } : {},
    // Фото победителей подгружаются отдельно (только для Business/Creator-аккаунтов)
    async enrichWinner(user) {
      try {
        const j = await g(igUserId, { fields: `business_discovery.username(${user.id}){profile_picture_url,name}` }, token);
        if (j.business_discovery) {
          user.photo = j.business_discovery.profile_picture_url || null;
          if (j.business_discovery.name) user.name = `${j.business_discovery.name} (@${user.id})`;
        }
      } catch (_) {
        /* личные аккаунты через API не отдают фото — останется аватар-заглушка */
      }
    },
  };
}

module.exports = { fetchInstagram, parseShortcode, parseList };
