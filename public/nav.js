// Общий блок аккаунта в шапке всех страниц. window.ME — промис с данными о пользователе и доступе.
window.ME = fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ user: null }));

window.api = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Ошибка ' + r.status), { code: j.code, status: r.status });
  return j;
};

window.fmtDate = (s) => (s ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

ME.then((me) => {
  const el = document.getElementById('nav');
  if (!el) return;
  const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  if (!me.user) {
    const next = encodeURIComponent(location.pathname + location.search);
    el.innerHTML = `<a class="btn" href="/login.html?next=${next}">Войти</a><a class="btn primary" href="/login.html?mode=register&amp;next=${next}">Регистрация</a>`;
    return;
  }
  const a = me.access;
  const badge = a.active
    ? `<span class="badge ok" title="Оплачено до ${fmtDate(a.paidUntil)}">доступ: ${a.daysLeft} дн.</span>`
    : '<span class="badge bad">не оплачено</span>';
  el.innerHTML = `${me.user.isAdmin ? '<a class="btn" href="/admin.html">Админ</a>' : ''}<a class="btn" href="/account.html">👤 ${e(me.user.email)} ${badge}</a>`;
});
