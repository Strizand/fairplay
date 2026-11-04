// Юридические документы сайта: реквизиты продавца (задаются в админке) и редакция документов.
// Тексты оферты, политики и согласия — в public/offer.html, privacy.html, consent.html.
//
// LEGAL_VERSION — дата текущей редакции документов. Меняйте её при каждом изменении текстов:
// при регистрации у пользователя сохраняется, с какой редакцией он согласился.

const settings = require('./settings');

const LEGAL_VERSION = '2026-11-04';

function info(publicUrl) {
  const g = (k) => settings.get(k);
  return {
    version: LEGAL_VERSION,
    site: publicUrl || g('PUBLIC_URL') || '',
    seller: {
      name: g('SELLER_NAME'),
      inn: g('SELLER_INN'),
      ogrn: g('SELLER_OGRN'),
      address: g('SELLER_ADDRESS'),
      email: g('SUPPORT_EMAIL'),
      phone: g('SUPPORT_PHONE'),
    },
    plans: settings.plans().map((p) => ({ title: p.title, days: p.days, price: p.price })),
  };
}

module.exports = { LEGAL_VERSION, info };
