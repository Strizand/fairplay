// Демо-данные: правдоподобный пост с участниками, чтобы опробовать сервис без токенов API.
// Данные детерминированы ссылкой на пост — одна и та же ссылка даёт тех же «участников».

const { sha256 } = require('./rng');
const { parseList } = require('./instagram');

function prng(seedStr) {
  let s = parseInt(sha256(seedStr).slice(0, 8), 16) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const M = ['Александр', 'Дмитрий', 'Максим', 'Иван', 'Артём', 'Никита', 'Михаил', 'Егор', 'Андрей', 'Илья', 'Кирилл', 'Сергей', 'Павел', 'Роман'];
const F = ['Анна', 'Мария', 'Елена', 'Дарья', 'Алина', 'Ирина', 'Екатерина', 'Полина', 'Ольга', 'Виктория', 'Ксения', 'Наталья', 'Софья', 'Юлия'];
const L = ['Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Волков', 'Соколов', 'Морозов', 'Новиков', 'Лебедев', 'Козлов', 'Орлов', 'Павлов', 'Фёдоров', 'Белов'];
const CITIES = ['Москва', 'Санкт-Петербург', 'Казань', 'Екатеринбург', 'Новосибирск', 'Самара', 'Краснодар', 'Пермь'];
const PHRASES = ['Участвую!', 'Участвую 🙏', 'Хочу выиграть!', 'Очень хочу, участвую', 'Ура, участвую!', 'Классный приз', 'Мечтаю о таком', '+'];
const COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#7986cb', '#a1887f', '#90a4ae'];

function avatar(initials, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${color}"/><text x="100" y="125" font-family="Arial" font-size="80" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function demoVk(url, { groups = [] }) {
  const rnd = prng('vk:' + url);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const n = 180 + Math.floor(rnd() * 120);
  const users = {};
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = String(100000 + Math.floor(rnd() * 900000000));
    if (users[id]) continue;
    const female = rnd() < 0.55;
    const first = pick(female ? F : M);
    const last = pick(L) + (female ? 'а' : '');
    const hasPhoto = rnd() > 0.08;
    const year = 1965 + Math.floor(rnd() * 45);
    users[id] = {
      id, name: `${first} ${last}`, screenName: 'id' + id, url: 'https://vk.com/id' + id,
      photo: hasPhoto ? avatar(first[0] + last[0], pick(COLORS)) : null,
      hasPhoto, closed: rnd() < 0.12, deactivated: rnd() < 0.02 ? 'deleted' : null,
      sex: female ? 'f' : 'm',
      bdate: rnd() < 0.6 ? `${1 + Math.floor(rnd() * 28)}.${1 + Math.floor(rnd() * 12)}.${year}` : `${1 + Math.floor(rnd() * 28)}.${1 + Math.floor(rnd() * 12)}`,
      city: rnd() < 0.8 ? pick(CITIES) : null,
    };
    ids.push(id);
  }
  const likes = ids.filter(() => rnd() < 0.85);
  const reposts = ids.filter(() => rnd() < 0.7);
  reposts.push('-' + (1000 + Math.floor(rnd() * 99999))); // репост от сообщества — должен быть отсеян
  const start = Date.now() - 6 * 86400000;
  const comments = [];
  let t = start;
  ids.forEach((id) => {
    if (rnd() > 0.75) return;
    const cnt = rnd() < 0.15 ? 2 + Math.floor(rnd() * 3) : 1;
    for (let k = 0; k < cnt; k++) {
      t += Math.floor(rnd() * 40 * 60000);
      const nm = Math.floor(rnd() * 4);
      const mentions = [];
      let text = pick(PHRASES) + (rnd() < 0.5 ? ' ' + (1 + Math.floor(rnd() * 100)) : '');
      for (let j = 0; j < nm; j++) {
        const fid = pick(ids);
        mentions.push('id' + fid);
        text += ` [id${fid}|${users[fid].name.split(' ')[0]}]`;
      }
      comments.push({ id: String(comments.length + 1), userId: id, text, date: new Date(t).toISOString(), isReply: rnd() < 0.1, mentions: [...new Set(mentions)] });
    }
  });
  comments.sort((a, b) => a.date.localeCompare(b.date));
  const groupList = (groups.length ? groups : ['demo_shop']).map((g, i) => ({
    id: 'g' + i, name: i === 0 ? 'Демо-магазин «Подарки»' : 'Спонсор ' + i, url: /^https?:/.test(g) ? g : 'https://vk.com/' + g,
  }));
  const membership = {};
  groupList.forEach((g) => (membership[g.id] = new Set(ids.filter(() => rnd() < 0.82))));
  return {
    network: 'vk',
    demo: true,
    post: {
      url, id: 'demo', ownerId: '-1', authorId: '-1', ownerName: 'Демо-магазин «Подарки»', ownerUrl: 'https://vk.com/',
      text: '🎁 РОЗЫГРЫШ! Разыгрываем 3 подарочных сертификата. Условия: подпишись на группу, поставь лайк, сделай репост и напиши в комментариях «Участвую», отметив друга.',
      date: new Date(start).toISOString(), likes: likes.length, reposts: reposts.length, comments: comments.length, views: n * 14,
    },
    users, likes, reposts, comments, groups: groupList, membership,
  };
}

function demoInstagram(url, { likersList, followersList }) {
  const rnd = prng('ig:' + url);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const parts = ['anna', 'masha', 'kate', 'dima', 'alex', 'olga', 'nika', 'sasha', 'lena', 'max', 'yulia', 'polina', 'ivan', 'sonya'];
  const suf = ['_style', '.life', '_photo', '_mama', '.travel', '_88', '_official', '.blog', '_spb', '_msk', '2024', '_art'];
  const n = 150 + Math.floor(rnd() * 120);
  const users = {};
  const ids = [];
  for (let i = 0; i < n; i++) {
    const u = pick(parts) + pick(suf) + (rnd() < 0.4 ? Math.floor(rnd() * 99) : '');
    if (users[u]) continue;
    users[u] = { id: u, name: u, screenName: u, url: `https://www.instagram.com/${u}/`, photo: avatar(u.slice(0, 2).toUpperCase(), pick(COLORS)) };
    ids.push(u);
  }
  const start = Date.now() - 4 * 86400000;
  let t = start;
  const comments = [];
  ids.forEach((u) => {
    const cnt = rnd() < 0.2 ? 2 + Math.floor(rnd() * 4) : 1;
    for (let k = 0; k < cnt; k++) {
      t += Math.floor(rnd() * 30 * 60000);
      const nm = Math.floor(rnd() * 4);
      const ms = [];
      for (let j = 0; j < nm; j++) ms.push(pick(ids));
      const mentions = [...new Set(ms.filter((x) => x !== u))];
      const text = (ms.map((x) => '@' + x).join(' ') + ' ' + pick(PHRASES) + (rnd() < 0.5 ? ' ' + (1 + Math.floor(rnd() * 100)) : '')).trim();
      comments.push({ id: 'c' + comments.length, userId: u, text, date: new Date(t).toISOString(), isReply: false, mentions });
    }
  });
  const likers = likersList ? [...parseList(likersList)] : ids.filter(() => rnd() < 0.8);
  const followers = followersList ? parseList(followersList) : new Set(ids.filter(() => rnd() < 0.85));
  return {
    network: 'instagram',
    demo: true,
    self: 'demo_shop',
    post: {
      url, id: 'demo', ownerId: 'demo_shop', authorId: 'demo_shop', ownerName: '@demo_shop', ownerUrl: 'https://www.instagram.com/',
      text: 'GIVEAWAY 🎁 Условия: подписка на @demo_shop, лайк этому посту и комментарий с отметкой 2 друзей. Каждый комментарий — дополнительный шанс!',
      date: new Date(start).toISOString(), likes: likers.length, comments: comments.length, reposts: null, views: null,
    },
    users, likes: likers, reposts: null, comments,
    groups: [{ id: 'demo_shop', name: '@demo_shop (список подписчиков' + (followersList ? ', загружен' : ', демо') + ')', url: 'https://www.instagram.com/' }],
    membership: { demo_shop: followers },
  };
}

module.exports = { demoVk, demoInstagram, avatar };
