// Подставляет реквизиты продавца (из админки) в юридические страницы:
// элементы с data-l="seller.name", "seller.inn", "site", "version", "requisites", "plans".
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const missing = (what) => `<span class="missing" title="Заполните в админке: Настройки → Реквизиты продавца">[${what}]</span>`;
  const NAMES = { 'seller.name': 'наименование продавца', 'seller.inn': 'ИНН', 'seller.ogrn': 'ОГРН/ОГРНИП', 'seller.address': 'адрес', 'seller.email': 'e-mail поддержки', 'seller.phone': 'телефон' };

  fetch('/api/legal').then((r) => r.json()).then((L) => {
    const s = L.seller;
    const site = L.site || location.origin;
    const get = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), L);

    document.querySelectorAll('[data-l]').forEach((el) => {
      const k = el.dataset.l;
      if (k === 'site') { el.innerHTML = `<a href="${esc(site)}">${esc(site.replace(/^https?:\/\//, ''))}</a>`; return; }
      if (k === 'version') { el.textContent = new Date(L.version).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); return; }
      if (k === 'requisites') {
        el.innerHTML = `<b>${s.name ? esc(s.name) : missing(NAMES['seller.name'])}</b><br>
          ИНН: ${s.inn ? esc(s.inn) : missing('ИНН')}${s.ogrn ? `<br>ОГРН/ОГРНИП: ${esc(s.ogrn)}` : ''}<br>
          Адрес: ${s.address ? esc(s.address) : missing('адрес')}<br>
          E-mail: ${s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : missing('e-mail поддержки')}${s.phone ? `<br>Телефон: <a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${esc(s.phone)}</a>` : ''}`;
        return;
      }
      if (k === 'plans') {
        el.innerHTML = '<table><tr><th>Тариф</th><th>Срок доступа</th><th>Стоимость</th></tr>' +
          L.plans.map((p) => `<tr><td>${esc(p.title)}</td><td>${p.days} дн.</td><td>${Number(p.price).toLocaleString('ru-RU')} ₽</td></tr>`).join('') + '</table>';
        return;
      }
      if (k === 'seller.email') {
        el.innerHTML = s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : missing(NAMES[k]);
        return;
      }
      const v = get(k);
      el.innerHTML = v ? esc(v) : missing(NAMES[k] || k);
    });
  }).catch(() => {});
})();
