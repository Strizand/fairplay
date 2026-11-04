// Проверяемый генератор случайных чисел.
//
// Схема (commit → reveal):
//   1. Формируется упорядоченный список участников и считается его SHA-256 (participantsHash).
//   2. Фиксируется номер БУДУЩЕГО раунда публичного маяка случайности drand (League of Entropy).
//      Значение этого раунда на момент фиксации списка не знает никто, включая сервис.
//   3. Когда раунд выходит, seed = SHA-256(drandRandomness + ":" + participantsHash + ":" + verdictsHash),
//      где verdictsHash — хеш итогов проверки условий (в старых отчётах его нет: seed = SHA-256(randomness + ":" + participantsHash)).
//   4. k-е случайное число: HMAC-SHA256(seed, "draw:" + k) → первые 6 байт (48 бит) →
//      равномерное число в [1..n] методом отбрасывания (rejection sampling), без смещения по модулю.
// Любой может повторить вычисления по данным отчёта (страница отчёта делает это прямо в браузере).

const crypto = require('crypto');

const DRAND_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'; // quicknet, раунд каждые 3 с
const DRAND_URLS = ['https://api.drand.sh', 'https://drand.cloudflare.com', 'https://api2.drand.sh'];
const DRAND_GENESIS = 1692803367;
const DRAND_PERIOD = 3;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function fetchJson(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function drandRound(round) {
  let lastErr;
  for (const base of DRAND_URLS) {
    try {
      return await fetchJson(`${base}/${DRAND_CHAIN}/public/${round}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Возвращает источник энтропии для розыгрыша. Раунд выбирается строго в будущем
// относительно момента фиксации списка участников. commitment — зафиксированные хеши через «:».
async function obtainEntropy(commitment) {
  const committedAt = new Date().toISOString();
  const nowRound = Math.floor((Date.now() / 1000 - DRAND_GENESIS) / DRAND_PERIOD) + 1;
  const targetRound = nowRound + 2; // ~6 секунд в будущее
  const waitMs = (DRAND_GENESIS + (targetRound - 1) * DRAND_PERIOD) * 1000 - Date.now() + 800;
  try {
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    let beacon;
    for (let i = 0; i < 5; i++) {
      try {
        beacon = await drandRound(targetRound);
        break;
      } catch (e) {
        if (i === 4) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return {
      source: 'drand',
      committedAt,
      drand: {
        chainHash: DRAND_CHAIN,
        round: targetRound,
        randomness: beacon.randomness,
        signature: beacon.signature,
        verifyUrl: `https://api.drand.sh/${DRAND_CHAIN}/public/${targetRound}`,
        roundTime: new Date((DRAND_GENESIS + (targetRound - 1) * DRAND_PERIOD) * 1000).toISOString(),
      },
      entropy: beacon.randomness,
      seed: sha256(beacon.randomness + ':' + commitment),
    };
  } catch (e) {
    // Резервный вариант: криптостойкий локальный генератор. Проверить заранее его нельзя,
    // поэтому в отчёте это явно указывается.
    const local = crypto.randomBytes(32).toString('hex');
    return {
      source: 'local',
      committedAt,
      fallbackReason: 'drand недоступен: ' + e.message,
      entropy: local,
      seed: sha256(local + ':' + commitment),
    };
  }
}

const MAX48 = 2n ** 48n;

// k-е случайное число в диапазоне [1..n]. Возвращает подробности для журнала.
function drawNumber(seed, k, n) {
  const N = BigInt(n);
  const limit = MAX48 - (MAX48 % N);
  for (let attempt = 0; ; attempt++) {
    const label = attempt === 0 ? `draw:${k}` : `draw:${k}:${attempt}`;
    const hmac = crypto.createHmac('sha256', Buffer.from(seed, 'hex')).update(label).digest('hex');
    const v = BigInt('0x' + hmac.slice(0, 12));
    if (v < limit) {
      return { k, label, hmac, value48: v.toString(), number: Number(v % N) + 1, range: n, rejected: attempt };
    }
  }
}

module.exports = { sha256, obtainEntropy, drawNumber };
