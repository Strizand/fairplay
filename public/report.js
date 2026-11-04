const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Ссылка в href: только http(s), иначе «#» (защита от javascript: и data: в данных отчёта)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '').trim()) ? esc(String(u).trim()) : '#');
const dt = (s) => (s ? new Date(s).toLocaleString('ru-RU') : '—');
const NOPHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#c5c9d6"/><circle cx="40" cy="32" r="14" fill="#fff"/><rect x="18" y="50" width="44" height="24" rx="12" fill="#fff"/></svg>');
const MECH = {
  random: 'Случайный выбор номера участника генератором случайных чисел',
  commentNumber: 'Победитель по номеру комментария',
  guessNumber: '«Угадай число»: побеждает ближайший к загаданному числу ответ',
  firstN: 'Первые участники, выполнившие все условия',
};
const VERDICT = { winner: '<span class="badge ok">🏆 победитель</span>', reserve: '<span class="badge ok">резерв</span>', fail: '<span class="badge bad">не выполнил</span>', duplicate: '<span class="badge bad">повтор</span>' };

const id = location.pathname.startsWith('/r/') ? location.pathname.slice(3) : new URLSearchParams(location.search).get('id');
let R;

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
}

// Сколько розыгрышей проводилось по этому посту. Защита от «перезапусков до удобного результата»:
// любой участник видит все попытки, включая сделанные после этого отчёта.
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
function historyCard(r) {
  const list = r.postHistory || [];
  if (!list.length) return '';
  const n = list.length;
  const pos = list.findIndex((x) => x.current) + 1;
  const what = (r.demo ? plural(n, 'демо-розыгрыш', 'демо-розыгрыша', 'демо-розыгрышей') + ' по этой ссылке' : plural(n, 'розыгрыш', 'розыгрыша', 'розыгрышей') + ' по этому посту');
  if (n === 1) {
    return `<div class="card trust ok-border">
      <h2>🔁 Розыгрыши по этому посту: 1</h2>
      <p><b class="ok">✓ Это единственный ${r.demo ? 'демо-розыгрыш по этой ссылке' : 'розыгрыш по этому посту'}, проведённый в сервисе.</b>
      Если организатор запустит розыгрыш по этому посту ещё раз, это сразу появится здесь — на этой же странице.</p>
    </div>`;
  }
  const rows = list.map((x, i) => `<tr class="${x.current ? 'current' : ''}">
      <td>${i + 1}</td>
      <td>${x.current ? '<b>этот отчёт</b>' : `<a href="/r/${esc(x.id)}">${esc(x.id)}</a>`}${x.demo ? ' <span class="badge demo">демо</span>' : ''}</td>
      <td>${dt(x.createdAt)}</td>
      <td class="small">${x.sameOrganizer === true ? 'тот же организатор' : x.sameOrganizer === false ? 'другой аккаунт' : '—'}</td>
      <td class="small">${esc(x.winners.join(', ') || '—')}</td>
    </tr>`).join('');
  return `<div class="card trust warn-border">
    <h2>🔁 Розыгрыши по этому посту: ${n}</h2>
    <p><b>В сервисе ${plural(n, 'проведён', 'проведено', 'проведено')} ${n} ${what}.</b> Этот отчёт — <b>№ ${pos}</b>${pos === 1 ? ' (первый)' : pos === n ? ' (последний)' : ''}.
    Если организатор провёл розыгрыш несколько раз, сравните результаты: честным обычно считается первый,
    а причина повторов должна быть объяснена участникам.</p>
    <div class="tablewrap"><table>
      <tr><th>#</th><th>Отчёт</th><th>Проведён</th><th>Кем</th><th>Победители</th></tr>
      ${rows}
    </table></div>
    <p class="small muted">Список формируется автоматически при каждом открытии страницы и включает все розыгрыши по этой публикации, в том числе проведённые позже. Удалить отчёт из списка нельзя.</p>
  </div>`;
}

function render(r) {
  document.title = `Отчёт: ${r.title}`;
  const s = r.stats;
  const net = r.network === 'vk' ? 'ВКонтакте' : 'Instagram';
  const pct = s.total ? Math.round((s.met / s.total) * 100) : 0;
  const rng = r.rng;
  const winnerCard = (w, reserve) => `<div class="winner ${reserve ? 'res' : ''}">
      <div class="place">${reserve ? 'Резерв ' + w.place : '🏆 Победитель ' + w.place}</div>
      <img src="${esc(w.photo || NOPHOTO)}" alt="">
      <div><b>${esc(w.name)}</b></div>
      <div class="small"><a href="${safeUrl(w.url)}" target="_blank" rel="noopener">${esc(w.url)}</a></div>
      ${w.ticket ? `<div class="small muted">${r.mechanic === 'random' ? 'Номер в списке' : 'Комментарий №'} ${w.ticket}</div>` : ''}
      ${w.guess !== undefined ? `<div class="small muted">Ответ: ${w.guess}</div>` : ''}
      ${w.comment ? `<div class="small muted">«${esc(w.comment.slice(0, 120))}»</div>` : ''}
    </div>`;

  $('#root').innerHTML = `
  <div class="card">
    <div class="small muted">Отчёт № ${esc(r.id)} · ${net} ${r.demo ? '<span class="badge demo">ДЕМО — данные сгенерированы</span>' : ''}</div>
    <h1 style="margin-top:6px">${esc(r.title)}</h1>
    ${r.prize ? `<p><b>Приз:</b> ${esc(r.prize)}</p>` : ''}
    <p class="small muted">Сбор данных начат: ${dt(r.startedAt)} · Список участников зафиксирован: ${dt(rng.committedAt)} · Отчёт сформирован: ${dt(r.createdAt)}</p>
    ${r.organizerNote ? `<p>${esc(r.organizerNote)}</p>` : ''}
  </div>

  ${historyCard(r)}

  <div class="card">
    <h2>Пост с розыгрышем</h2>
    <p><a href="${safeUrl(r.post.url)}" target="_blank" rel="noopener">${esc(r.post.url)}</a><br>
    <span class="small muted">Автор: <a href="${safeUrl(r.post.ownerUrl)}" target="_blank" rel="noopener">${esc(r.post.ownerName)}</a> · опубликован ${dt(r.post.date)}</span></p>
    ${r.post.text ? `<p class="small" style="white-space:pre-wrap">${esc(r.post.text)}</p>` : ''}
    <p class="small muted">Лайков: ${r.post.likes ?? '—'} · Репостов: ${r.post.reposts ?? '—'} · Комментариев: ${r.post.comments ?? '—'}${r.post.views ? ' · Просмотров: ' + r.post.views : ''}</p>
  </div>

  <div class="card">
    <h2>Условия и механика</h2>
    <p><b>Механика:</b> ${MECH[r.mechanic]}${r.mechanic === 'random' ? `. ${r.settings.checkMode === 'filterThenDraw' ? 'Сначала отсеяны невыполнившие условия, выбор — среди подходящих.' : 'Выбирается номер, затем проверяются условия; при невыполнении — перевыбор.'} ${r.settings.tickets === 'comment' ? 'Каждый подходящий комментарий — отдельный шанс.' : 'Один участник — один шанс.'}` : ''}${r.mechanic === 'commentNumber' ? ` (номера: ${esc(r.settings.commentNumbers)})` : ''}</p>
    <p><b>Победителей:</b> ${esc(r.settings.winners)} · <b>резервных:</b> ${esc(r.settings.reserves || 0)}</p>
    <ul>${r.conditions.map((c) => `<li>${esc(c)}</li>`).join('') || '<li>Без дополнительных условий</li>'}</ul>
    ${r.network === 'instagram' && (r.importedLists.likers || r.importedLists.followers) ? '<p class="note">Instagram API не предоставляет списки лайков и подписчиков. Проверка этих условий выполнена по спискам, загруженным организатором.</p>' : ''}
  </div>

  <div class="card">
    <h2>Итоги проверки участников</h2>
    <div class="stats">
      <div class="stat"><span class="muted small">Всего участников на момент начала</span><b>${s.total}</b></div>
      <div class="stat"><span class="muted small">Выполнили все условия</span><b class="ok">${s.met}</b></div>
      <div class="stat"><span class="muted small">Не выполнили условия</span><b class="bad">${s.notMet}</b></div>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <p class="small muted">${pct}% участников выполнили все условия. Участник — каждый, кто совершил хотя бы одно из требуемых действий.</p>
    <div class="tablewrap"><table>
      <tr><th>Условие</th><th>Выполнили</th><th>Не выполнили</th></tr>
      ${s.perCondition.map((c) => `<tr><td>${esc(c.label)}</td><td class="ok">${c.passed}</td><td class="bad">${c.failed}</td></tr>`).join('')}
    </table></div>
  </div>

  <div class="card">
    <h2>Победители</h2>
    ${r.winners.length ? `<div class="winners">${r.winners.map((w) => winnerCard(w, false)).join('')}</div>` : '<p class="bad">Не найдено участников, выполнивших все условия.</p>'}
    ${r.reserves.length ? `<h3>Резервные победители</h3><div class="winners">${r.reserves.map((w) => winnerCard(w, true)).join('')}</div>` : ''}
  </div>

  <div class="card">
    <h2>Генератор случайных чисел</h2>
    ${rng.source === 'none' ? '<p>Механика не использует случайные числа: победители определены по порядку комментариев. Список комментариев зафиксирован хешем ниже.</p>' : ''}
    ${rng.source === 'drand' ? `<p>Источник случайности — публичный маяк <a href="https://drand.love" target="_blank" rel="noopener">drand</a> (League of Entropy: Cloudflare, Protocol Labs, EPFL, университеты и др.). Сначала был зафиксирован список участников и его хеш, затем выбран <b>будущий</b> раунд маяка. Его значение на момент фиксации не мог знать никто — ни организатор, ни сервис.</p>
      <p class="note" style="border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)">Простыми словами: это как лотерейный барабан в прямом эфире, только в интернете и на глазах у всего мира. Сначала мы «запечатали в конверт» список участников, и только потом весь мир «бросил кубик». <a href="/drand.html" target="_blank">Подробнее, понятным языком →</a></p>` : ''}
    ${rng.source === 'local' ? `<p class="note">Маяк drand был недоступен (${esc(rng.fallbackReason)}); использован криптостойкий генератор сервера. Расчёт по нему воспроизводим, но независимо подтвердить непредсказуемость энтропии нельзя.</p>` : ''}
    <div class="tablewrap"><table>
      <tr><th style="width:240px">Хеш списка участников (SHA-256)</th><td class="mono">${rng.participantsHash}</td></tr>
      ${rng.verdictsHash ? `<tr><th>Хеш итогов проверки условий (SHA-256)</th><td class="mono">${esc(rng.verdictsHash)}</td></tr>` : ''}
      <tr><th>Размер списка для выбора</th><td>${r.pool.length} ${r.settings.tickets === 'comment' && r.mechanic === 'random' ? 'билетов' : r.mechanic === 'random' ? 'участников' : 'комментариев'}</td></tr>
      ${rng.drand ? `<tr><th>Раунд drand</th><td><a href="${safeUrl(rng.drand.verifyUrl)}" target="_blank" rel="noopener">${rng.drand.round}</a> (вышел ${dt(rng.drand.roundTime)})</td></tr>
      <tr><th>Случайное значение раунда</th><td class="mono">${rng.drand.randomness}</td></tr>
      <tr><th>Подпись раунда (BLS)</th><td class="mono">${rng.drand.signature}</td></tr>` : ''}
      ${rng.source === 'local' ? `<tr><th>Энтропия сервера</th><td class="mono">${rng.entropy}</td></tr>` : ''}
      ${rng.seed ? `<tr><th>Seed = SHA-256(энтропия + ":" + хеш списка${rng.verdictsHash ? ' + ":" + хеш итогов проверки' : ''})</th><td class="mono">${rng.seed}</td></tr>` : ''}
      ${rng.guess ? `<tr><th>Загаданное число</th><td><b style="font-size:20px">${rng.guess.target}</b> (диапазон ${rng.guess.min}–${rng.guess.max}; HMAC «${rng.guess.label}» = <span class="mono">${rng.guess.hmac.slice(0, 16)}…</span>)</td></tr>` : ''}
    </table></div>
    ${rng.seed ? `<p class="small muted">Алгоритм: k-е число = HMAC-SHA256(seed, "draw:k"); первые 48 бит → число от 1 до N без смещения (значения ≥ ⌊2⁴⁸/N⌋·N отбрасываются и берётся "draw:k:1" и т.д.). После каждого выбора участник (все его билеты) убирается из списка, номера оставшихся сдвигаются.</p>` : ''}
  </div>

  <div class="card">
    <h2>Ход розыгрыша</h2>
    <p class="small muted">Каждый шаг: какое случайное число получено, кому оно соответствует и результат проверки условий.</p>
    <div class="tablewrap"><table>
      <tr><th>Шаг</th>${r.mechanic === 'random' ? '<th>HMAC</th><th>Число</th>' : r.mechanic === 'guessNumber' ? '<th>Ответ</th><th>Отклонение</th>' : '<th>Комментарий №</th>'}<th>Участник</th><th>Проверка</th></tr>
      ${r.log.map((l) => `<tr>
        <td>${l.step}</td>
        ${r.mechanic === 'random' ? `<td class="mono" title="${l.hmac}">${l.hmac.slice(0, 12)}…${l.rejected ? ` <span class="small">(+${l.rejected} отбр.)</span>` : ''}</td><td><b>${l.number}</b> из ${l.range}<div class="small muted">№ ${l.poolIndex} в исходном списке</div></td>`
          : r.mechanic === 'guessNumber' ? `<td>${l.number}</td><td>${l.distance}</td>` : `<td>${l.number}</td>`}
        <td><a href="${safeUrl(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></td>
        <td>${VERDICT[l.verdict]}${l.failed.length ? `<div class="small bad">${esc(l.failed.join('; '))}</div>` : '<div class="small ok">все условия выполнены</div>'}</td>
      </tr>`).join('') || '<tr><td colspan="5">Нет шагов</td></tr>'}
    </table></div>
  </div>

  <div class="card noprint">
    <h2>Самопроверка расчёта</h2>
    <p class="small muted">Браузер заново вычислит хеш списка, seed и каждое случайное число по данным этого отчёта${rng.drand ? ' и сверит значение раунда напрямую с сервером drand' : ''}.</p>
    <button class="btn primary" id="verify" type="button">Проверить</button>
    <div id="verifyOut" class="small" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h2>Все участники (${s.total})</h2>
    <details><summary class="noprint" style="cursor:pointer">Показать список с результатами проверки</summary>
      <input type="text" id="filter" class="noprint" placeholder="Поиск по имени или ID" style="margin:12px 0">
      <div class="tablewrap"><table id="plist"></table></div>
    </details>
  </div>
  <p class="small muted" style="text-align:center">Отчёт неизменяем после формирования. Ссылка: ${esc(location.origin)}/r/${esc(r.id)}</p>`;

  const drawList = (q = '') => {
    q = q.toLowerCase();
    $('#plist').innerHTML = '<tr><th>#</th><th>Участник</th><th>Статус</th><th>Не выполнено</th></tr>' +
      r.participants.map((p, i) => [p, i]).filter(([p]) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q))
        .slice(0, 3000).map(([p, i]) => `<tr><td>${i + 1}</td><td><a href="${safeUrl(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a> <span class="small muted">${esc(p.id)}</span></td>
        <td>${p.ok ? '<span class="badge ok">выполнил</span>' : '<span class="badge bad">не выполнил</span>'}</td><td class="small">${esc(p.failed.join('; '))}</td></tr>`).join('');
  };
  drawList();
  $('#filter').oninput = (e) => drawList(e.target.value);
  $('#verify').onclick = verify;
}

// ── Проверка расчёта в браузере (WebCrypto) ─────────────────────────────
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmacKey(seedHex) {
  const bytes = new Uint8Array(seedHex.match(/../g).map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function drawNumber(key, k, n) {
  const MAX = 2n ** 48n, N = BigInt(n), limit = MAX - (MAX % N);
  for (let a = 0; ; a++) {
    const label = a ? `draw:${k}:${a}` : `draw:${k}`;
    const h = hex(await crypto.subtle.sign('HMAC', key, enc.encode(label)));
    const v = BigInt('0x' + h.slice(0, 12));
    if (v < limit) return { hmac: h, number: Number(v % N) + 1 };
  }
}

async function verify() {
  const out = $('#verifyOut');
  const lines = [];
  const say = (ok, text) => { lines.push(`<div class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${text}</div>`); out.innerHTML = lines.join(''); };
  const r = R;
  let allOk = true;
  const check = (ok, text) => { allOk = allOk && ok; say(ok, text); };

  const h = await sha256(r.pool.map((e) => e.join('|')).join('\n'));
  check(h === r.rng.participantsHash, `Хеш списка участников совпадает (${h.slice(0, 16)}…)`);
  if (r.rng.verdictsHash) {
    const vh = await sha256(r.participants.map((p) => `${p.id}|${p.ok ? 1 : 0}`).join('\n'));
    check(vh === r.rng.verdictsHash, `Итоги проверки условий не менялись после фиксации (${vh.slice(0, 16)}…)`);
  }

  if (r.rng.drand) {
    try {
      const b = await fetch(r.rng.drand.verifyUrl).then((x) => x.json());
      check(b.randomness === r.rng.drand.randomness, `Значение раунда ${r.rng.drand.round} подтверждено сервером drand`);
    } catch (e) {
      say(false, 'Не удалось связаться с drand для сверки: ' + e.message);
    }
  }
  if (r.rng.seed) {
    const commitment = r.rng.participantsHash + (r.rng.verdictsHash ? ':' + r.rng.verdictsHash : ''); // старые отчёты — без хеша итогов
    const seed = await sha256(r.rng.entropy + ':' + commitment);
    check(seed === r.rng.seed, 'Seed вычислен верно');
    const key = await hmacKey(r.rng.seed);
    if (r.mechanic === 'random') {
      let remaining = r.pool.slice();
      let bad = 0;
      for (const l of r.log) {
        const d = await drawNumber(key, l.step, remaining.length);
        const e = remaining[d.number - 1];
        if (d.number !== l.number || d.hmac !== l.hmac || e[0] !== l.poolIndex || e[1] !== l.userId) bad++;
        remaining = remaining.filter((x) => x[1] !== e[1]);
      }
      check(!bad, `Все ${r.log.length} случайных чисел пересчитаны и указывают на тех же участников${bad ? ` (расхождений: ${bad})` : ''}`);
    }
    if (r.rng.guess) {
      const g = r.rng.guess;
      const d = await drawNumber(key, 1, g.max - g.min + 1);
      check(d.number + g.min - 1 === g.target, `Загаданное число ${g.target} подтверждено`);
    }
  }
  const okIds = new Set(r.participants.filter((p) => p.ok).map((p) => p.id));
  check([...r.winners, ...r.reserves].every((w) => okIds.has(w.id)), 'Все победители выполнили все условия');
  check(r.stats.met + r.stats.notMet === r.stats.total && r.participants.length === r.stats.total, 'Итоговые цифры сходятся со списком участников');
  lines.push(`<p><b class="${allOk ? 'ok' : 'bad'}">${allOk ? 'Отчёт прошёл проверку.' : 'Обнаружены расхождения.'}</b></p>`);
  out.innerHTML = lines.join('');
}

// ── Экспорт ─────────────────────────────────────────────────────────────
$('#copy').onclick = async () => {
  const url = `${location.origin}/r/${id}`;
  try { await navigator.clipboard.writeText(url); $('#copy').textContent = '✓ Скопировано'; } catch { prompt('Ссылка на отчёт', url); }
};
$('#json').onclick = () => {
  const { postHistory, ...report } = R; // выгружаем сам неизменяемый отчёт, без «живого» списка
  download(`report-${id}.json`, JSON.stringify(report, null, 2), 'application/json');
};
$('#csv').onclick = () => {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const winners = new Map([...R.winners.map((w) => [w.id, 'победитель ' + w.place]), ...R.reserves.map((w) => [w.id, 'резерв ' + w.place])]);
  const rows = [['#', 'ID', 'Имя', 'Профиль', 'Выполнил условия', 'Не выполнено', 'Итог'].map(q).join(';')];
  R.participants.forEach((p, i) => rows.push([i + 1, p.id, p.name, p.url, p.ok ? 'да' : 'нет', p.failed.join('; '), winners.get(p.id) || ''].map(q).join(';')));
  download(`participants-${id}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
};

fetch('/api/reports/' + id)
  .then((r) => r.json())
  .then((r) => {
    if (r.error) throw new Error(r.error);
    R = r;
    render(r);
  })
  .catch((e) => ($('#root').innerHTML = `<div class="card bad">${esc(e.message)}</div>`));
