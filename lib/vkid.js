// Вход через VK ID (OAuth 2.1 с PKCE) и проверка, какие методы VK API доступны ключу.
//
// Сейчас используется только в админке: администратор входит своим аккаунтом ВКонтакте,
// и сервис проверяет, работают ли с ключом пользователя методы, нужные для розыгрыша.
// Ключ при этом нигде не сохраняется. Дальше на этом же коде будет строиться вход для всех пользователей.

const crypto = require('crypto');
const settings = require('./settings');
const { parsePostUrl } = require('./vk');

const AUTHORIZE = 'https://id.vk.com/authorize';
const TOKEN = 'https://id.vk.com/oauth2/auth';
const API = 'https://api.vk.com/method/';
const V = '5.199';
// Только базовое право: оно есть у любого приложения. «Стена» и «Сообщества» в VK ID — расширенные доступы,
// они открываются лишь после подтверждения профиля бизнеса. Для чтения открытых постов они не должны быть нужны;
// если окажется, что нужны, — проверка покажет ошибку доступа по конкретным методам.
const SCOPE = 'vkid.personal_info';
const TTL = 10 * 60000; // столько живёт незавершённый вход

const b64url = (buf) => buf.toString('base64url');
const pending = new Map(); // state → { verifier, userId, redirectUri, post, expires }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}, 60000).unref();

const appId = () => settings.get('VK_APP_ID');
// Возврат — на главную страницу сайта: этот адрес указывают в кабинете VK ID как «Доверенный Redirect URL»
// при создании приложения, и VK ID требует точного совпадения. Сервер узнаёт возврат по параметрам state и code.
const redirectUri = (base) => base;
// Похоже ли на возврат с VK ID (а не на обычное открытие главной)
const isReturn = (q) => q.has('state') && (q.has('code') || q.has('error') || q.has('payload'));

// Ссылка на страницу входа VK ID. post — необязательная ссылка на пост для проверки.
function start(userId, base, post) {
  const id = appId();
  if (!id) throw new Error('Укажите ID приложения VK ID в настройках (блок «ВКонтакте») и сохраните');
  if (post) parsePostUrl(post); // сразу сообщить о неверной ссылке, а не после входа
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const uri = redirectUri(base);
  pending.set(state, { verifier, userId, redirectUri: uri, post: post || '', expires: Date.now() + TTL });
  const u = new URL(AUTHORIZE);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: id, redirect_uri: uri, state, scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  return u.toString();
}

// Возврат с VK ID: проверяем state, меняем код на ключ (на сервере, с code_verifier).
async function finish(query, userId) {
  let q = Object.fromEntries(query);
  // В некоторых вариантах VK ID присылает параметры одной JSON-строкой payload
  if (q.payload) { try { q = { ...q, ...JSON.parse(q.payload) }; } catch (_) { /* оставляем как есть */ } }
  if (q.error) throw new Error(`VK ID вернул ошибку: ${q.error}${q.error_description ? ' — ' + q.error_description : ''}`);
  const p = pending.get(q.state || '');
  if (!p) throw new Error('Вход устарел или уже завершён. Запустите проверку из админки ещё раз.');
  pending.delete(q.state);
  if (p.userId !== userId) throw new Error('Вход начат из другого аккаунта сервиса');
  if (!q.code || !q.device_id) throw new Error('VK ID не передал код авторизации');
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code: q.code, code_verifier: p.verifier, client_id: appId(),
    device_id: q.device_id, redirect_uri: p.redirectUri, state: q.state,
  });
  const r = await fetch(TOKEN, { method: 'POST', body, signal: AbortSignal.timeout(15000) }).then((x) => x.json());
  if (r.error || !r.access_token) throw new Error(`Не удалось получить ключ VK ID: ${r.error || 'нет access_token'}${r.error_description ? ' — ' + r.error_description : ''}`);
  return { token: r.access_token, userId: r.user_id, scope: r.scope || '', expiresIn: r.expires_in, post: p.post };
}

async function call(token, method, params = {}) {
  try {
    const r = await fetch(API + method, { method: 'POST', body: new URLSearchParams({ ...params, access_token: token, v: V }), signal: AbortSignal.timeout(15000) }).then((x) => x.json());
    if (r.error) return { ok: false, code: r.error.error_code, error: r.error.error_msg };
    return { ok: true, response: r.response };
  } catch (e) {
    return { ok: false, error: 'нет ответа (' + (e.name === 'TimeoutError' ? 'таймаут' : e.message) + ')' };
  }
}

// Проверяет все методы, которые нужны розыгрышу. post — ссылка на пост; без неё берётся свежий пост сообщества VK API.
async function checkMethods(token, post) {
  let ownerId = -1;
  let postId;
  if (post) ({ ownerId, postId } = parsePostUrl(post));
  const rows = [];
  const add = (label, method, r) => rows.push({ label, method, ok: r.ok, error: r.ok ? '' : `${r.error}${r.code ? ' (код ' + r.code + ')' : ''}` });
  if (!postId) {
    const w = await call(token, 'wall.get', { owner_id: ownerId, count: 2 });
    add('Посты сообщества', 'wall.get', w);
    const items = (w.ok && w.response.items) || [];
    postId = (items.find((i) => !i.is_pinned) || items[0] || {}).id || 1;
  }
  const groupId = ownerId < 0 ? -ownerId : 1;
  add('Данные поста', 'wall.getById', await call(token, 'wall.getById', { posts: `${ownerId}_${postId}` }));
  add('Кто поставил лайк', 'likes.getList', await call(token, 'likes.getList', { type: 'post', owner_id: ownerId, item_id: postId, count: 1 }));
  add('Кто сделал репост', 'likes.getList (copies)', await call(token, 'likes.getList', { type: 'post', owner_id: ownerId, item_id: postId, filter: 'copies', count: 1 }));
  add('Комментарии', 'wall.getComments', await call(token, 'wall.getComments', { owner_id: ownerId, post_id: postId, count: 1 }));
  add('Профили участников', 'users.get', await call(token, 'users.get', { user_ids: '1', fields: 'photo_100' }));
  add('Данные сообщества', 'groups.getById', await call(token, 'groups.getById', { group_ids: String(groupId) }));
  add('Подписка на сообщество', 'groups.isMember', await call(token, 'groups.isMember', { group_id: groupId, user_ids: '1' }));
  return { post: `https://vk.com/wall${ownerId}_${postId}`, rows, allOk: rows.every((r) => r.ok) };
}

module.exports = { start, finish, checkMethods, redirectUri, isReturn, call, SCOPE };
