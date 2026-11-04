const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const NOPHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#c5c9d6"/><circle cx="40" cy="32" r="14" fill="#fff"/><rect x="18" y="50" width="44" height="24" rx="12" fill="#fff"/></svg>');

let network = null;
let serverStatus = { vk: false, instagram: false };

// ── Шаблоны популярных механик ──────────────────────────────────────────
const PRESETS = {
  vk: [
    ['Классика: подписка + лайк + репост', { 'cond.subscribe': true, 'cond.like': true, 'cond.repost': true, 'cond.excludeClosed': true }],
    ['+ комментарий «участвую»', { 'cond.subscribe': true, 'cond.like': true, 'cond.repost': true, 'cond.comment': true, 'cond.keyword': 'участвую' }],
    ['Отметь друга в комментарии', { 'cond.subscribe': true, 'cond.comment': true, 'cond.mentions': 1 }],
    ['Репост + подписка на спонсоров', { 'cond.subscribe': true, 'cond.repost': true, 'cond.excludeClosed': true, 'cond.excludeNoPhoto': true }],
    ['Больше комментариев — больше шансов', { 'cond.subscribe': true, 'cond.comment': true, tickets: 'comment' }],
  ],
  instagram: [
    ['Подписка + лайк + отметь 2 друзей', { 'cond.subscribe': true, 'cond.like': true, 'cond.comment': true, 'cond.mentions': 2 }],
    ['Комментарий = шанс', { 'cond.comment': true, 'cond.mentions': 1, tickets: 'comment' }],
    ['Кодовое слово в комментарии', { 'cond.comment': true, 'cond.keyword': 'хочу' }],
    ['Только комментарий', { 'cond.comment': true }],
  ],
};

function applyPreset(values) {
  $$('#form [name^="cond."]').forEach((el) => {
    if (['cond.groups', 'cond.blacklist', 'cond.deadline'].includes(el.name)) return;
    if (el.type === 'checkbox') el.checked = ['cond.excludeDeactivated', 'cond.excludeOrganizer', 'cond.countReplies'].includes(el.name);
    else if (el.type === 'number') el.value = 0;
    else el.value = '';
  });
  $('[name=tickets]').value = 'user';
  Object.entries(values).forEach(([k, v]) => {
    const el = $(`#form [name="${k}"]`);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}

// ── Выбор соцсети ───────────────────────────────────────────────────────
function selectNetwork(net) {
  network = net;
  $$('.net').forEach((b) => b.classList.toggle('active', b.dataset.net === net));
  $('#form').classList.remove('hidden');
  $('#formTitle').textContent = net === 'vk' ? 'Розыгрыш во ВКонтакте' : 'Розыгрыш в Instagram';
  $('[name=url]').placeholder = net === 'vk' ? 'https://vk.com/wall-123456_789' : 'https://www.instagram.com/p/ABC123xyz/';
  $$('.only-vk').forEach((el) => el.classList.toggle('hidden', net !== 'vk'));
  $$('.only-ig').forEach((el) => el.classList.toggle('hidden', net !== 'instagram'));
  $('#presets').innerHTML = '<span class="small muted" style="align-self:center">Шаблоны:</span>' +
    PRESETS[net].map((p, i) => `<button type="button" class="chip" data-i="${i}">${esc(p[0])}</button>`).join('');
  $$('#presets .chip').forEach((b) => (b.onclick = () => applyPreset(PRESETS[net][b.dataset.i][1])));
  applyPreset(PRESETS[net][0][1]);
  updateTokenNote();
  $('#form').scrollIntoView({ behavior: 'smooth' });
}
$$('.net').forEach((b) => (b.onclick = () => selectNetwork(b.dataset.net)));
$('#back').onclick = () => { $('#form').classList.add('hidden'); scrollTo({ top: 0, behavior: 'smooth' }); };

// Ключи API задаёт только администратор (в админке), пользователи их не вводят
function hasToken() {
  return network === 'vk' ? !!serverStatus.vk : !!serverStatus.instagram;
}
function updateTokenNote() {
  const ok = hasToken();
  $('#noToken').classList.toggle('hidden', ok);
  if (!ok) $('[name=demo]').checked = true;
  updateAccessNote();
}

// Розыгрыш по реальному посту доступен только авторизованным пользователям с оплаченным периодом
let me = { user: null };
ME.then((m) => { me = m; if (network) updateAccessNote(); });
function accessProblem() {
  if ($('[name=demo]').checked) return null;
  const next = encodeURIComponent('/');
  if (!me.user) return `Розыгрыш по реальному посту доступен после входа и оплаты. <a href="/login.html?mode=register&next=${next}">Зарегистрируйтесь</a> или <a href="/login.html?next=${next}">войдите</a>. Демо-режим — бесплатно.`;
  if (!me.access.active) return `Оплаченный доступ ${me.access.paidUntil ? 'закончился ' + fmtDate(me.access.paidUntil) : 'не оформлен'}. <a href="/account.html">Оплатить или продлить →</a> Демо-режим — бесплатно.`;
  return null;
}
function updateAccessNote() {
  const p = accessProblem();
  $('#accessNote').classList.toggle('hidden', !p);
  $('#accessNote').innerHTML = p || '';
}
$('[name=demo]').addEventListener('change', updateAccessNote);

$$('[name=mechanic]').forEach((r) => (r.onchange = () => {
  const m = $('[name=mechanic]:checked').value;
  ['random', 'commentNumber', 'guessNumber'].forEach((k) => $$('.m-' + k).forEach((el) => el.classList.toggle('hidden', m !== k)));
  if (m !== 'random') $('[name="cond.comment"]').checked = true;
}));

$$('input[type=file][data-target]').forEach((inp) => (inp.onchange = async () => {
  const f = inp.files[0];
  if (f) $(`[name=${inp.dataset.target}]`).value = await f.text();
}));

// Раньше токены можно было сохранить в браузере — удаляем их, они больше не используются
try { localStorage.removeItem('tokens'); } catch {}

// ── Запуск розыгрыша ────────────────────────────────────────────────────
function collect() {
  const s = { network, cond: {} };
  $$('#form [name]').forEach((el) => {
    if (el.type === 'radio' && !el.checked) return;
    if (el.closest('.hidden') && !el.closest('.m-random')) return; // скрытые поля другой соцсети/механики
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    if (el.name.startsWith('cond.')) s.cond[el.name.slice(5)] = v;
    else s[el.name] = v;
  });
  if (s.cond.deadline) s.cond.deadline = new Date(s.cond.deadline).toISOString();
  return s;
}

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  if (accessProblem()) {
    updateAccessNote();
    $('#accessNote').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const s = collect();
  $('#form').classList.add('hidden');
  $('#home').classList.add('hidden');
  $('#history').classList.add('hidden');
  $('#drawStage').classList.remove('hidden');
  $('#stageTitle').textContent = s.title || 'Розыгрыш';
  scrollTo({ top: 0 });
  try {
    const { jobId, error } = await fetch('/api/draw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then((r) => r.json());
    if (error) throw new Error(error);
    let job;
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      job = await fetch('/api/jobs/' + jobId).then((r) => r.json());
      $('#progress').textContent = job.progress || '';
      if (job.status !== 'running') break;
    }
    if (job.status === 'error') throw new Error(job.error);
    const report = await fetch('/api/reports/' + job.reportId).then((r) => r.json());
    await animate(report);
  } catch (err) {
    $('#loading').classList.add('hidden');
    $('#stageError').classList.remove('hidden');
    $('#stageError').innerHTML = `<p>Ошибка: ${esc(err.message)}</p><button class="btn" onclick="location.reload()">Назад</button>`;
  }
};

// ── Анимация «барабана» по журналу розыгрыша ────────────────────────────
let skipping = false;
$('#skip').onclick = () => (skipping = true);
$('#fullscreen').onclick = () => $('#drawStage').classList.toggle('fullscreen');
const wait = (ms) => (skipping ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

function personHtml(p, extra = '') {
  return `<img src="${esc(p.photo || NOPHOTO)}" alt=""><div style="text-align:left">${esc(p.name)}<div class="num">${extra}</div></div>`;
}

async function spin(people, ms) {
  const end = Date.now() + ms;
  while (!skipping && Date.now() < end) {
    const p = people[Math.floor(Math.random() * people.length)];
    $('#drum').innerHTML = personHtml(p, '…');
    await new Promise((r) => setTimeout(r, 70));
  }
}

function addWinner(w, reserve) {
  $('#stageWinners').insertAdjacentHTML('beforeend', `<div class="winner ${reserve ? 'res' : ''}">
    <div class="place">${reserve ? 'Резерв ' + w.place : '🏆 Победитель ' + w.place}</div>
    <img src="${esc(w.photo || NOPHOTO)}" alt=""><div><b>${esc(w.name)}</b></div>
    <a href="${/^https?:\/\//i.test(String(w.url || '')) ? esc(w.url) : '#'}" target="_blank" rel="noopener">Профиль →</a></div>`);
}

async function animate(r) {
  $('#loading').classList.add('hidden');
  $('#anim').classList.remove('hidden');
  const people = r.participants.length ? r.participants : [{ name: '—' }];
  const byId = Object.fromEntries(r.participants.map((p) => [p.id, p]));
  if (r.mechanic === 'guessNumber' && r.rng.guess) {
    const g = r.rng.guess;
    const end = Date.now() + 1500;
    while (!skipping && Date.now() < end) {
      $('#drum').textContent = g.min + Math.floor(Math.random() * (g.max - g.min + 1));
      await new Promise((res) => setTimeout(res, 60));
    }
    $('#drum').innerHTML = `Загаданное число: <span style="color:var(--accent)">${g.target}</span>`;
    await wait(1500);
  }
  let wi = 0, ri = 0;
  for (const step of r.log) {
    const p = byId[step.userId] || { name: step.name };
    const how = r.mechanic === 'random' ? `Номер ${step.number} из ${step.range}` : r.mechanic === 'guessNumber' ? `Ответ ${step.number}, отклонение ${step.distance}` : `Комментарий №${step.number}`;
    if (r.mechanic === 'random') {
      $('#verdict').innerHTML = '<span class="muted">Генератор выбирает номер…</span>';
      await spin(people, r.log.length > 15 ? 500 : 1300);
    }
    $('#drum').innerHTML = personHtml(p, how);
    if (step.verdict === 'winner' || step.verdict === 'reserve') {
      $('#verdict').innerHTML = `<span class="ok">✓ Все условия выполнены — ${step.verdict === 'winner' ? 'победитель!' : 'резервный победитель'}</span>`;
      if (step.verdict === 'winner') addWinner(r.winners[wi++], false);
      else addWinner(r.reserves[ri++], true);
      await wait(1800);
    } else {
      $('#verdict').innerHTML = `<span class="bad">✗ Не выполнено: ${esc(step.failed.join(', '))} — перевыбор</span>`;
      await wait(r.log.length > 15 ? 600 : 1400);
    }
  }
  if (!r.winners.length) $('#verdict').innerHTML = '<span class="bad">Не найдено участников, выполнивших все условия</span>';
  else $('#verdict').innerHTML = '<span class="ok">Розыгрыш завершён</span>';
  $('#skip').classList.add('hidden');
  $('#reportLink').href = '/r/' + r.id;
  $('#stageDone').classList.remove('hidden');
}

// ── Старт ───────────────────────────────────────────────────────────────
fetch('/api/status').then((r) => r.json()).then((s) => {
  serverStatus = s;
  // Instagram временно скрыт (включается на сервере флагом INSTAGRAM_ENABLED)
  $$('.net.ig').forEach((b) => b.classList.toggle('hidden', !s.instagramEnabled));
  if (network) updateTokenNote(); // форму могли открыть раньше, чем пришёл статус
}).catch(() => {});
ME.then((m) => { if (!m.user) $('#history').classList.add('hidden'); });
fetch('/api/reports').then((r) => r.json()).then((list) => {
  if (!list.length) return;
  $('#historyList').classList.remove('muted');
  $('#historyList').innerHTML = list.slice(0, 15).map((x) => `<a href="/r/${x.id}"><span>${x.network === 'vk' ? 'VK' : 'IG'} · ${esc(x.title)} ${x.demo ? '<span class="badge demo">демо</span>' : ''}<br><span class="small muted">${new Date(x.createdAt).toLocaleString('ru-RU')} · участников: ${x.total}</span></span><span class="small">${esc(x.winners.join(', ') || '—')}</span></a>`).join('');
});
