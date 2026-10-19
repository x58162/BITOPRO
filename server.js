require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.BITOPRO_API_KEY || '';
const API_SECRET = process.env.BITOPRO_API_SECRET || '';
const EMAIL = process.env.BITOPRO_EMAIL || '';
const LIVE_TRADING = String(process.env.LIVE_TRADING || 'false').toLowerCase() === 'true'; // 由 .env 控制自動策略是否送出實盤委託。
const FEE_RATE = Math.max(0, Number(process.env.FEE_RATE || 0.0001));
const DATA_DIR = path.join(__dirname, 'data');
const JOURNAL = path.join(DATA_DIR, 'journal.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily-stats.json');
const SPREADS_FILE = path.join(DATA_DIR, 'spreads.json');
const PAIRS_FILE = path.join(DATA_DIR, 'pairs.json');
const BITO_PRICE_HISTORY_FILE = path.join(DATA_DIR, 'bito_twd_price_history.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_SPREADS = {
  sol_twd: 100,
  usdt_twd: 0.020,
  btc_twd: 20000,
  eth_twd: 2000,
  ltc_twd: 100,
  bnb_twd: 2000,
  bito_twd: 0.1,
  btc_usdt: 600
};
const DEFAULT_PAIRS = Object.keys(DEFAULT_SPREADS);
function validPair(pair) { return /^[a-z0-9]{2,20}_[a-z0-9]{2,20}$/.test(String(pair || '')); }
function loadPairs() {
  try {
    const saved = JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf8'));
    if (Array.isArray(saved)) { const valid = [...new Set(saved.map(x => String(x).toLowerCase()).filter(validPair))]; if (valid.length) return valid; }
  } catch {}
  return [...DEFAULT_PAIRS];
}
let PAIRS = loadPairs();
function savePairs() { fs.writeFileSync(PAIRS_FILE, JSON.stringify(PAIRS, null, 2), 'utf8'); }
function loadSpreads() {
  try { const saved = JSON.parse(fs.readFileSync(SPREADS_FILE, 'utf8')); return Object.fromEntries(PAIRS.map(pair => [pair, Number.isFinite(Number(saved[pair])) && Number(saved[pair]) >= 0 ? Number(saved[pair]) : (DEFAULT_SPREADS[pair] ?? 0)])); }
  catch { return Object.fromEntries(PAIRS.map(pair => [pair, DEFAULT_SPREADS[pair] ?? 0])); }
}
let SPREADS = loadSpreads();
function saveSpreads() { fs.writeFileSync(SPREADS_FILE, JSON.stringify(SPREADS, null, 2), 'utf8'); }

let ws = null;
let reconnectTimer = null;
let running = false;
let firstLoad = true;
let status = { state: 'stopped', message: '尚未啟動', since: null, lastError: null };
let balances = [];
let assetValuation = { totalTwd: null, pricedCurrencies: [], unpricedCurrencies: [], updatedAt: null };
let clients = new Set();
function loadEvents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(item => item && item.time && Date.parse(item.time) >= Date.now() - EVENT_RETENTION_MS) : [];
  } catch { return []; }
}
let events = loadEvents();
function persistEvents() {
  const cutoff = Date.now() - EVENT_RETENTION_MS;
  events = events.filter(item => item && Date.parse(item.time) >= cutoff);
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2), 'utf8');
}
try { persistEvents(); } catch (err) { console.error('清理過期即時事件失敗：', err.message); }
let orderBusy = false;
let bitoTwdPrice = null;
let bitoTwdPriceAt = null;
let bitoPriceHistory = [];
try { bitoPriceHistory = JSON.parse(fs.readFileSync(BITO_PRICE_HISTORY_FILE, 'utf8')); if (!Array.isArray(bitoPriceHistory)) bitoPriceHistory = []; } catch { bitoPriceHistory = []; }

function loadJournal() {
  try {
    const parsed = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
let journal = loadJournal();
function persist() {
  fs.writeFileSync(JOURNAL, JSON.stringify(journal.slice(-10000), null, 2), 'utf8');
}
function emit(type, data = {}) {
  const item = { id: Date.now() + Math.random(), time: new Date().toISOString(), type, ...data };
  events.unshift(item);
  try { persistEvents(); } catch (err) { console.error('保存即時事件失敗：', err.message); }
  for (const client of clients) {
    if (client.readyState === 1) client.send(JSON.stringify({ kind: 'event', item }));
  }
}
function setStatus(state, message, error = null) {
  status = { ...status, state, message, lastError: error, since: state === 'connected' ? new Date().toISOString() : status.since };
  emit('status', { state, message, error });
}
function credentialsReady() { return !!(API_KEY && API_SECRET && EMAIL); }
function signedHeaders(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto.createHmac('sha384', API_SECRET).update(encoded).digest('hex');
  return {
    'X-BITOPRO-APIKEY': API_KEY,
    'X-BITOPRO-PAYLOAD': encoded,
    'X-BITOPRO-SIGNATURE': signature
  };
}
function authHeaders() {
  const payload = { identity: EMAIL, nonce: Date.now() };
  return signedHeaders(payload);
}
function signedOrderHeaders(payload, urlSafe = false) {
  const json = JSON.stringify(payload);
  const encoded = urlSafe
    ? Buffer.from(json).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    : Buffer.from(json).toString('base64');
  const signature = crypto.createHmac('sha384', API_SECRET).update(encoded).digest('hex');
  return {
    'X-BITOPRO-APIKEY': API_KEY,
    'X-BITOPRO-PAYLOAD': encoded,
    'X-BITOPRO-SIGNATURE': signature
  };
}
function requireCredentials(res) {
  if (!credentialsReady()) {
    res.status(503).json({ ok: false, error: '請先在 .env 設定 BITOPRO_API_KEY、BITOPRO_API_SECRET、BITOPRO_EMAIL，並重新啟動服務。' });
    return false;
  }
  return true;
}
function apiErrorMessage(err) {
  const data = err.response?.data;
  return typeof data === 'string' ? data : JSON.stringify(data || { message: err.message });
}
function addJournal(entry) {
  journal.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), ...entry });
  journal = journal.slice(0, 10000);
  persist();
  emit('journal', { entry: journal[0] });
}
function pairBase(pair) { return pair.split('_')[0].toUpperCase(); }

async function getTickerPrice(pair) {
  try {
    const response = await axios.get(`https://api.bitopro.com/v3/tickers/${pair}`, { timeout: 8000 });
    const root = response.data?.data;
    const rows = Array.isArray(root) ? root : (root ? [root] : []);
    for (const row of rows) {
      const value = Number(row.lastPrice ?? row.last_price ?? row.price ?? row.close ?? row.last);
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch {}
  return null;
}

// Historical BITO/TWD minute-candle cache. BitoPro's public 1m OHLC endpoint
// is the historical source; unlike the live ticker, it is queried around each
// trade's own exchange timestamp. The candle close is a minute-level proxy,
// not an exact second-by-second execution quote.
const historicalBitoMinuteCache = new Map();
async function fetchHistoricalBitoPriceAt(timestamp) {
  const iso = toIsoTimestamp(timestamp);
  const targetMs = Date.parse(iso || '');
  if (!Number.isFinite(targetMs)) return null;
  const minuteKey = Math.floor(targetMs / 60000);
  if (historicalBitoMinuteCache.has(minuteKey)) return historicalBitoMinuteCache.get(minuteKey);
  const from = Math.floor((targetMs - 120000) / 1000);
  const to = Math.ceil((targetMs + 120000) / 1000);
  let result = null;
  try {
    const response = await axios.get('https://api.bitopro.com/v3/trading-history/bito_twd', {
      params: { resolution: '1m', from, to }, timeout: 12000
    });
    const root = response.data?.data ?? response.data;
    const rows = Array.isArray(root) ? root : (Array.isArray(root?.data) ? root.data : []);
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      const rawStamp = Number(row.timestamp);
      const candleMs = rawStamp < 1e12 ? rawStamp * 1000 : rawStamp;
      const close = Number(row.close);
      if (!Number.isFinite(candleMs) || !(close > 0)) continue;
      // Prefer the candle containing the fill timestamp; otherwise use the
      // closest candle start, only if it is within two minutes.
      const contains = targetMs >= candleMs && targetMs < candleMs + 60000;
      const distance = contains ? 0 : Math.abs(candleMs - targetMs);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { time: new Date(candleMs).toISOString(), price: close, source: 'bito_twd_1m_ohlc_close', candleTimestamp: candleMs };
      }
    }
    if (best && bestDistance <= 120000) result = best;
  } catch (err) {
    emit('warning', { message: `查詢成交時間附近 BITO/TWD 歷史行情失敗：${apiErrorMessage(err)}` });
  }
  historicalBitoMinuteCache.set(minuteKey, result);
  return result;
}
// BITO/TWD 價格只在即時成交事件發生時抓取；不再定時輪詢。
async function fetchBitoPriceForFill() {
  const price = await getTickerPrice('bito_twd');
  if (!(Number.isFinite(price) && price > 0)) return null;
  const sample = { time: new Date().toISOString(), price };
  bitoTwdPrice = price;
  bitoTwdPriceAt = sample.time;
  bitoPriceHistory.push(sample);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  bitoPriceHistory = bitoPriceHistory.filter(x => Date.parse(x.time) >= cutoff).slice(-600000);
  try { fs.writeFileSync(BITO_PRICE_HISTORY_FILE, JSON.stringify(bitoPriceHistory), 'utf8'); }
  catch (err) { emit('warning', { message: `儲存 BITO/TWD 歷史行情失敗：${err.message}` }); }
  return sample;
}
function getBitoPriceNear(timeIso) {
  const target = Date.parse(timeIso || new Date().toISOString());
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const sample of bitoPriceHistory) {
    const ts = Date.parse(sample.time);
    if (!Number.isFinite(ts)) continue;
    const diff = Math.abs(ts - target);
    if (diff < bestDiff) { best = sample; bestDiff = diff; }
  }
  // Only associate a sampled price with a fill if it is within 15 seconds.
  return best && bestDiff <= 15000 ? { ...best, differenceMs: bestDiff } : null;
}
function feeFields(item, receivedAt, priceSample = null) {
  const fee = Number(item.fee || 0);
  const feeCurrency = String(item.feeCurrency || item.fee_currency || item.feeSymbol || item.fee_symbol || item.feeCurrencyName || item.fee_currency_name || (fee > 0 ? 'BITO' : '')).toUpperCase();
  if (!(fee > 0) || feeCurrency !== 'BITO') return { fee, feeCurrency: feeCurrency || null, feeTwdCost: null, feeBitoTwdPrice: null, feePriceTime: null, feePriceStatus: fee > 0 ? 'unsupported_fee_currency' : 'no_fee_reported' };
  if (!priceSample) return { fee, feeCurrency, feeTwdCost: null, feeBitoTwdPrice: null, feePriceTime: null, feePriceStatus: 'historical_price_not_sampled' };
  return { fee, feeCurrency, feeTwdCost: fee * priceSample.price, feeBitoTwdPrice: priceSample.price, feePriceTime: priceSample.time, feePriceStatus: priceSample.source || 'fetched_on_fill' };
}

const seenTrades = new Set(journal.map(x => x.tradeId || x.matchID || x.dedupeKey).filter(Boolean).map(String));
function normalizeTrade(raw, fallbackPair = '') {
  const item = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
  const base = String(item.base || '').toLowerCase();
  const quote = String(item.quote || '').toLowerCase();
  const pair = String(item.pair || fallbackPair || (base && quote ? `${base}_${quote}` : '')).toLowerCase();
  const side = String(item.side || item.action || '').toLowerCase();
  const action = ['ask', 'sell'].includes(side) ? 'SELL' : (['bid', 'buy'].includes(side) ? 'BUY' : String(item.action || '').toUpperCase());
  const tradeId = String(item.matchID || item.matchId || item.match_id || item.tradeID || item.tradeId || item.trade_id || item.id || '');
  const price = Number(item.price || item.matchPrice || item.match_price);
  const amount = Number(item.baseAmount ?? item.base_amount ?? item.volume ?? item.amount ?? item.executedAmount ?? item.executed_amount);
  if (!pair || !['BUY', 'SELL'].includes(action) || !(price > 0) || !(amount > 0)) return null;
  return { item, pair, action, price, amount, tradeId, orderId: item.orderID || item.orderId || item.order_id || null };
}
async function recordUserTrade(raw, fallbackPair = '', isHistorical = false, fallbackPriceSample = null) {
  const trade = normalizeTrade(raw, fallbackPair);
  if (!trade) return false;
  const item = trade.item;
  const dedupeKey = trade.tradeId || `${trade.pair}|${trade.orderId || ''}|${trade.action}|${trade.price}|${trade.amount}|${item.transactionTimestamp || item.timestamp || ''}`;
  if (seenTrades.has(dedupeKey)) return false;
  seenTrades.add(dedupeKey);
  if (seenTrades.size > 50000) {
    // Journal IDs remain persisted; this in-memory set is bounded to avoid unbounded growth.
    const recent = journal.slice(0, 20000).map(x => String(x.tradeId || x.dedupeKey || '')).filter(Boolean);
    seenTrades.clear(); recent.forEach(x => seenTrades.add(x));
  }
  const receivedAt = new Date().toISOString();
  // 每筆成交都以交易所回傳的實際成交時間查詢 BITO/TWD 歷史 1 分鐘 K 線；
  // 不再把「程式收到事件時的即時價格」當成成交當時價格，也不共用其他成交的價格。
  const exchangeTimestamp = item.transactionTimestamp || item.transaction_timestamp || item.timestamp || item.datetime || item.createdTimestamp || item.created_timestamp || null;
  let priceSample = null;
  try { priceSample = await fetchHistoricalBitoPriceAt(exchangeTimestamp); } catch {}
  if (!priceSample && isHistorical) priceSample = getBitoPriceNear(toIsoTimestamp(exchangeTimestamp)) || fallbackPriceSample;
  if (!priceSample && !isHistorical) {
    // Keep missing as pending instead of attaching a current price to an older fill.
    priceSample = null;
  }
  const feeItem = { ...item, fee: item.fee, feeCurrency: item.feeCurrency || item.feeSymbol };
  const feeInfo = feeFields(feeItem, receivedAt, priceSample);
  const entry = {
    category: 'filled_trade', time: receivedAt, exchangeTime: exchangeTimestamp, pair: trade.pair,
    action: trade.action, price: trade.price, amount: trade.amount, tradeId: trade.tradeId || dedupeKey,
    orderId: trade.orderId, matchID: trade.tradeId || null, isMaker: item.isMaker ?? null,
    orderType: item.orderType || item.type || 'LIMIT', historical: !!isHistorical,
    ...feeInfo, result: 'filled'
  };
  addJournal(entry);
  // 實際新成交後才更新一次帳戶餘額；歷史回補不觸發，避免連續呼叫 API。
  if (!isHistorical) {
    getAccountBalance().catch(err => emit('error', { message: `成交已記錄，但成交後更新帳戶資產失敗：${apiErrorMessage(err)}` }));
  }
  if (!isHistorical && feeInfo.feeCurrency === 'BITO' && feeInfo.feeTwdCost != null) {
    emit('info', { message: `成交手續費：${feeInfo.fee} BITO × NT$${feeInfo.feeBitoTwdPrice} = NT$${feeInfo.feeTwdCost.toFixed(6)}` });
  }
  emit('fill', { message: `${isHistorical ? '補登歷史成交' : '即時成交'}：${trade.pair.toUpperCase()} ${trade.action} ${trade.amount} @ ${trade.price}` });
  return true;
}
function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function taipeiDate(value) {
  const iso = toIsoTimestamp(value);
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
async function backfillTradeHistory() {
  if (!credentialsReady()) {
    emit('warning', { message: '歷史成交回補略過：尚未設定完整 BitoPro API 憑證' });
    return;
  }
  const todayTaipei = taipeiDate(new Date());
  // 只回補 2026-10-18（台灣時間）起的成交；更早的成交不再補查歷史 BITO/TWD 報價。
  const endOfDay = Date.now();
  const startOfDay = Date.parse('2026-10-17T16:00:00.000Z');
  const historicalTrades = [];

  // Use the official private trade-history endpoint, not order history. Trade history includes
  // tradeId, orderId, baseAmount, quoteAmount and the actual fee for each fill.
  for (const pair of PAIRS) {
    let cursor = null;
    const seenCursors = new Set();
    try {
      for (let page = 0; page < 10; page++) {
        const params = { startTimestamp: startOfDay, endTimestamp: endOfDay, limit: 1000 };
        if (cursor) params.tradeId = cursor;
        const response = await axios.get(`https://api.bitopro.com/v3/orders/trades/${pair}`, {
          headers: authHeaders(), params, timeout: 15000
        });
        const root = response.data?.data ?? response.data;
        const rows = Array.isArray(root) ? root : (Array.isArray(root?.trades) ? root.trades : []);
        if (!rows.length) break;
        for (const row of rows) {
          const stamp = row.transactionTimestamp || row.transaction_timestamp || row.timestamp || row.datetime || row.createdTimestamp || row.created_timestamp;
          const stampMs = Date.parse(toIsoTimestamp(stamp) || '');
          if (!Number.isFinite(stampMs) || stampMs < startOfDay || stampMs > endOfDay) continue;
          const normalized = normalizeTrade(row, pair);
          if (!normalized) continue;
          historicalTrades.push({ row, pair, stamp, normalized });
        }
        if (rows.length < 1000) break;
        const last = rows[rows.length - 1];
        const nextCursor = String(last.tradeId || last.tradeID || last.id || '');
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } catch (err) {
      emit('warning', { message: `回補 ${pair.toUpperCase()} 成交明細失敗：${apiErrorMessage(err)}` });
    }
  }

  // 僅使用成交時間附近的歷史 BITO/TWD 報價。不得拿目前價格補歷史成交，否則多筆成交會錯用同一價格。

  let count = 0;
  for (const { row, pair, stamp, normalized } of historicalTrades) {
    const tradeId = String(row.tradeId || row.tradeID || row.trade_id || row.matchID || row.matchId || row.id || '');
    const orderId = String(row.orderId || row.orderID || row.order_id || normalized.orderId || '');
    // 若 API 個別回傳未帶 tradeId，仍以交易所訂單、時間、方向、價格、數量組合識別，不直接丟棄。
    const stableTradeKey = tradeId || `${orderId}|${stamp}|${normalized.action}|${normalized.price}|${normalized.amount}`;
    const tradeStampMs = Date.parse(toIsoTimestamp(stamp) || '');
    const duplicateIndex = journal.findIndex(x => {
      if (x.category !== 'filled_trade' || String(x.pair || '').toLowerCase() !== pair.toLowerCase()) return false;
      const existingTradeId = String(x.tradeId || x.matchID || x.dedupeKey || '');
      const sameId = existingTradeId === stableTradeKey && String(x.orderId || '') === orderId;
      if (sameId) return true;

      // Live User Trade Stream and REST history can expose different ID fields for
      // the same execution. Match the full execution fingerprint before inserting,
      // so a history backfill enriches the live row instead of creating duplicates.
      const sameOrder = orderId
        ? String(x.orderId || '') === orderId
        : !x.orderId;
      const sameAction = String(x.action || '').toUpperCase() === normalized.action;
      const samePrice = Math.abs(Number(x.price) - normalized.price) < 1e-10;
      const sameAmount = Math.abs(Number(x.amount) - normalized.amount) < 1e-8;
      const existingStampMs = Date.parse(toIsoTimestamp(x.exchangeTime || '') || '');
      const sameTime = Number.isFinite(tradeStampMs) && Number.isFinite(existingStampMs)
        && Math.abs(existingStampMs - tradeStampMs) <= 120000;
      return sameOrder && sameAction && samePrice && sameAmount && sameTime;
    });
    const duplicate = duplicateIndex >= 0;

    const oldOrderIndex = journal.findIndex(x =>
      x.category === 'filled_order' &&
      String(x.orderId || '') === orderId &&
      String(x.pair || '').toLowerCase() === pair.toLowerCase()
    );

    const sample = await fetchHistoricalBitoPriceAt(stamp) || getBitoPriceNear(toIsoTimestamp(stamp));
    const fee = Number(row.fee || 0);
    const feeCurrency = String(row.feeSymbol || row.feeCurrency || row.fee_currency || '').toUpperCase();
    const feeInfo = feeFields({ fee, feeCurrency }, new Date().toISOString(), sample);
    const entry = {
      category: 'filled_trade',
      time: new Date().toISOString(),
      exchangeTime: stamp,
      pair: normalized.pair,
      action: normalized.action,
      price: normalized.price,
      amount: normalized.amount,
      tradeId: tradeId || stableTradeKey,
      orderId: orderId || null,
      matchID: tradeId || stableTradeKey,
      isMaker: row.isMaker ?? (row.isTaker == null ? null : !row.isTaker),
      orderType: row.orderType || row.type || 'LIMIT',
      historical: true,
      ...feeInfo,
      result: 'filled'
    };
    if (duplicate) {
      const existing = journal[duplicateIndex];
      let enriched = false;
      // Prefer verified historical candle data. Fill only missing values so existing
      // confirmed values are not overwritten by a later, less precise lookup.
      if ((existing.feeBitoTwdPrice == null || existing.feeTwdCost == null) && feeInfo.feeBitoTwdPrice != null) {
        existing.feeBitoTwdPrice = feeInfo.feeBitoTwdPrice;
        existing.feePriceTime = feeInfo.feePriceTime;
        existing.feeTwdCost = feeInfo.feeTwdCost;
        existing.feePriceStatus = feeInfo.feePriceStatus;
        enriched = true;
      }
      if (existing.fee == null || Number(existing.fee) === 0) {
        existing.fee = feeInfo.fee;
        enriched = true;
      }
      if (!existing.feeCurrency && feeInfo.feeCurrency) {
        existing.feeCurrency = feeInfo.feeCurrency;
        enriched = true;
      }
      if (!existing.orderId && orderId) {
        existing.orderId = orderId;
        enriched = true;
      }
      if (!existing.tradeId || String(existing.tradeId).includes('|')) {
        existing.tradeId = tradeId || stableTradeKey;
        existing.matchID = tradeId || stableTradeKey;
        enriched = true;
      }
      if (enriched) {
        persist();
        emit('journal', { entry: existing });
        count++;
      }
      continue;
    }

    if (oldOrderIndex >= 0) {
      // Replace the earlier order-level placeholder with the exchange's actual fill details.
      entry.id = journal[oldOrderIndex].id || crypto.randomUUID();
      // 同一訂單可能有多筆 match；移除該訂單所有 order-level 佔位列，再保留每筆實際成交明細。
      journal = journal.filter(x => !(x.category === 'filled_order' && String(x.orderId || '') === orderId && String(x.pair || '').toLowerCase() === pair.toLowerCase()));
      journal.unshift(entry);
      journal = journal.slice(0, 10000);
      persist();
      emit('journal', { entry });
    } else {
      addJournal(entry);
    }
    count++;
  }
  emit('info', { message: `已回補 2026/10/18 起（截至台灣時間 ${todayTaipei}）成交明細：更新／新增 ${count} 筆；10/18 以前不再補查歷史 BITO/TWD 報價。缺少成交時間附近的報價時，手續費台幣成本保留待補，不套用目前價格。` });
}

async function updateAssetValuation() {
  const usdtTwd = await getTickerPrice('usdt_twd');
  const results = await Promise.all(balances.map(async item => {
    const currency = item.currency.toLowerCase();
    const amount = Number(item.amount || 0);
    if (currency === 'twd') return { ...item, twdPrice: 1, twdValue: amount, availableTwdValue: Number(item.available || 0), lockedTwdValue: Math.max(0, amount - Number(item.available || 0)) };
    let price = await getTickerPrice(`${currency}_twd`);
    if (price == null && usdtTwd != null) {
      const usdtPrice = await getTickerPrice(`${currency}_usdt`);
      if (usdtPrice != null) price = usdtPrice * usdtTwd;
    }
    return { ...item, twdPrice: price, twdValue: price == null ? null : amount * price, availableTwdValue: price == null ? null : Number(item.available || 0) * price, lockedTwdValue: price == null ? null : Math.max(0, amount - Number(item.available || 0)) * price };
  }));
  const unpriced = results.filter(x => x.twdValue == null && Number(x.amount || 0) !== 0).map(x => x.currency);
  const allPriced = unpriced.length === 0;
  assetValuation = {
    totalTwd: allPriced ? results.reduce((sum, x) => sum + Number(x.twdValue || 0), 0) : null,
    pricedCurrencies: results.filter(x => x.twdValue != null).map(x => x.currency),
    unpricedCurrencies: unpriced,
    updatedAt: new Date().toISOString()
  };
  balances = results;
  emit('balances', { balances, assetValuation });
  return balances;
}
async function getAccountBalance() {
  if (!credentialsReady()) throw new Error('請先在 .env 設定 API 金鑰');
  const response = await axios.get('https://api.bitopro.com/v3/accounts/balance', { headers: authHeaders(), timeout: 15000 });
  balances = (response.data.data || []).map(x => ({
    currency: String(x.currency).toUpperCase(),
    amount: Number(x.amount || 0),
    available: Number(x.available || 0)
  }));
  await updateAssetValuation();
  return balances;
}
function calculateTarget(pair, sourcePrice, sourceAction) {
  const spread = SPREADS[pair];
  if (!Number.isFinite(spread)) return null;
  const price = Number(sourcePrice) + (sourceAction === 'BUY' ? spread : -spread);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { action: sourceAction === 'BUY' ? 'SELL' : 'BUY', price: String(price.toFixed(8)).replace(/0+$/, '').replace(/\.$/, '') };
}
async function placeCounterOrder(fill) {
  if (!PAIRS.includes(fill.pair)) return;
  const target = calculateTarget(fill.pair, fill.price, fill.action);
  if (!target) {
    emit('warning', { message: `無法計算反向掛單價格：${fill.pair}` });
    return;
  }
  const amount = Number(fill.originalAmount || fill.executedAmount || 0);
  if (!(amount > 0)) return;

  const estimatedGross = Math.abs(Number(target.price) - Number(fill.price)) * amount;
  const estimatedFee = (Math.abs(Number(fill.price) * amount) + Math.abs(Number(target.price) * amount)) * FEE_RATE;
  const entry = {
    category: 'counter_order_signal',
    pair: fill.pair,
    sourceAction: fill.action,
    sourcePrice: Number(fill.price),
    action: target.action,
    price: Number(target.price),
    amount,
    spread: SPREADS[fill.pair],
    estimatedGross,
    estimatedFee,
    estimatedNet: estimatedGross - estimatedFee,
    live: LIVE_TRADING,
    result: LIVE_TRADING ? 'pending' : 'dry_run'
  };

  const payload = {
    action: target.action,
    amount: String(amount),
    price: String(target.price),
    timestamp: Date.now(),
    type: 'LIMIT',
    timeInForce: 'POST_ONLY'
  };

  if (!LIVE_TRADING) {
    addJournal({
      ...entry,
      live: false,
      result: 'dry_run',
      requestPreview: {
        method: 'POST',
        path: `/v3/orders/${fill.pair}`,
        payload,
        note: 'LIVE_TRADING=false：只預覽，不會送出交易所委託'
      }
    });
    emit('dryrun', {
      message: `反向委託預覽（未送單）：${fill.pair} ${target.action} ${amount} @ ${target.price}`
    });
    return;
  }

  if (!credentialsReady()) {
    addJournal({ ...entry, live: false, result: 'error', error: '缺少 BitoPro API 憑證' });
    emit('error', { message: '自動反向委託未送出：請設定 BITOPRO_API_KEY、BITOPRO_API_SECRET、BITOPRO_EMAIL。' });
    return;
  }

  let lastError = null;
  // 最多嘗試兩次。若第一次沒有收到 HTTP 回應（例如逾時），結果可能不確定，
  // 不自動重送以免交易所其實已收單卻造成重複委託。
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const attemptPayload = { ...payload, timestamp: Date.now() };
      const response = await axios.post(
        `https://api.bitopro.com/v3/orders/${fill.pair}`,
        attemptPayload,
        { headers: signedOrderHeaders(attemptPayload, true), timeout: 15000 }
      );
      const result = response.data?.data ?? response.data;
      const orderId = result?.orderId || result?.id || result?.order_id || null;
      addJournal({ ...entry, live: true, result: 'exchange_accepted', orderId, retryCount: attempt - 1, exchangeResponse: result });
      emit('info', { message: `交易所已回應反向委託：${fill.pair} ${target.action} ${amount} @ ${target.price}${orderId ? `（訂單 ${orderId}）` : '（未取得訂單 ID，請核對交易所掛單）'}${attempt > 1 ? '（重試成功）' : ''}` });
      return;
    } catch (err) {
      lastError = err;
      if (!err.response) break; // 網路逾時／斷線：無法確認交易所是否已收單，不盲目重送
      if (attempt < 2) {
        emit('warning', { message: `反向委託第 1 次建立失敗，準備重試：${apiErrorMessage(err)}` });
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }
  const message = lastError ? apiErrorMessage(lastError) : '連線中斷或逾時，無法確認交易所是否已接受委託；請先刷新交易所掛單，避免重複下單。';
  addJournal({ ...entry, live: true, result: 'error', error: message, httpStatus: lastError?.response?.status || null, retryCount: 1 });
  emit('error', { message: `反向委託建立失敗：${message}` });
}
function processHistoryMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (firstLoad) { firstLoad = false; emit('info', { message: '已收到首次訂單歷史快照；成交紀錄由 User Trade Stream／歷史成交 API 寫入。' }); return; }
  const data = msg && msg.data;
  if (!data || typeof data !== 'object') return;
  for (const pair of PAIRS) {
    const orders = data[pair];
    if (!Array.isArray(orders)) continue;
    for (const item of orders) {
      if (Number(item.originalAmount) !== Number(item.executedAmount) || Number(item.status) !== 2) continue;
      const dedupeKey = `${pair}|${item.id || item.orderId || ''}|${item.action}|${item.price}|${item.executedAmount}`;
      if (seenFills.has(dedupeKey)) continue;
      seenFills.add(dedupeKey);
      if (seenFills.size > 20000) seenFills.clear();
      emit('fill', { message: `完整委託：${pair.toUpperCase()} ${item.action} ${item.executedAmount} @ ${item.price}` });
      // 維持原本策略訊號行為；最近成交表由實際 match/trade 紀錄提供，避免重複列出整張委託。
      placeCounterOrder({ pair, price: Number(item.price), action: item.action, originalAmount: item.executedAmount, executedAmount: item.executedAmount })
        .catch(err => emit('error', { message: err.message }));
    }
  }
}

const seenFills = new Set();

let tradeWs = null;
let tradeReconnectTimer = null;
function connectUserTradeSocket() {
  if (!running || !credentialsReady()) return;
  try {
    tradeWs = new WebSocket('wss://stream.bitopro.com:443/ws/v1/pub/auth/user-trades', { headers: authHeaders() });
    tradeWs.on('open', () => emit('info', { message: 'User Trade Stream 已連線；BITO/TWD 只會在新成交時抓取。' }));
    tradeWs.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.event !== 'USER_TRADE' || !msg.data) return;
      recordUserTrade({ ...msg.data, timestamp: msg.data.transactionTimestamp || msg.timestamp }, `${msg.data.base || ''}_${msg.data.quote || ''}`, false)
        .catch(err => emit('error', { message: `記錄即時成交失敗：${err.message}` }));
    });
    tradeWs.on('error', err => emit('warning', { message: `User Trade Stream 錯誤：${err.message}` }));
    tradeWs.on('close', () => {
      tradeWs = null;
      if (running) tradeReconnectTimer = setTimeout(connectUserTradeSocket, 5000);
    });
  } catch (err) {
    emit('warning', { message: `無法建立 User Trade Stream：${err.message}` });
    if (running) tradeReconnectTimer = setTimeout(connectUserTradeSocket, 5000);
  }
}

function connectHistorySocket() {
  if (!running) return;
  if (!credentialsReady()) {
    setStatus('needs_config', '請先設定 .env 的 API 認證資料');
    return;
  }
  firstLoad = true;
  try {
    ws = new WebSocket('wss://stream.bitopro.com:443/ws/v1/pub/auth/orders/histories', { headers: authHeaders() });
    ws.on('open', () => {
      setStatus('connected', 'Histories WebSocket 已連線');
      getAccountBalance().catch(err => {
        setStatus('error', '取得餘額失敗', err.response?.data || err.message);
      });
    });
    ws.on('message', processHistoryMessage);
    ws.on('error', err => {
      setStatus('error', 'WebSocket 錯誤', err.message);
    });
    ws.on('close', () => {
      ws = null;
      if (!running) return;
      setStatus('reconnecting', '連線已關閉，5 秒後重試');
      reconnectTimer = setTimeout(connectHistorySocket, 5000);
    });
  } catch (err) {
    setStatus('error', '無法建立 WebSocket', err.message);
  }
}
function startBot() {
  if (running) return { ok: true, message: '程式已在執行' };
  running = true;
  setStatus('starting', LIVE_TRADING ? '啟動中：實盤模式' : '啟動中：模擬模式');
  emit('info', { message: `Bot 啟動，模式=${LIVE_TRADING ? 'LIVE' : 'DRY RUN'}` });
  backfillTradeHistory().catch(err => emit('warning', { message: `歷史成交補登失敗：${err.message}` }));
  connectUserTradeSocket();
  connectHistorySocket();
  return { ok: true, message: LIVE_TRADING ? '已要求啟動實盤模式' : '已要求啟動模擬模式' };
}
function stopBot() {
  running = false;
  if (tradeReconnectTimer) clearTimeout(tradeReconnectTimer);
  tradeReconnectTimer = null;
  if (tradeWs) { try { tradeWs.close(); } catch {} tradeWs = null; }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  setStatus('stopped', '已停止');
  emit('info', { message: 'Bot 已停止；停止後不會自動撤銷交易所已有掛單' });
  return { ok: true, message: '已停止監聽。注意：交易所已存在的掛單仍需另行管理。' };
}

function dailySummary() {
  const map = {};
  const ensureDay = (day) => {
    if (!day) return null;
    if (!map[day]) map[day] = {
      date: day, fills: 0, signals: 0, submitted: 0, failed: 0,
      estimatedGross: 0, estimatedFees: 0, estimatedNet: 0,
      matchedAmount: 0, unmatchedBuyAmount: 0
    };
    return map[day];
  };
  const eventDay = (e) => taipeiDate(e.exchangeTime || e.time) || String(e.time || '').slice(0, 10);

  // Count strategy events separately. They never contribute to realized profit.
  for (const e of journal) {
    const day = eventDay(e);
    const d = ensureDay(day);
    if (!d) continue;
    if (e.category === 'counter_order_signal') {
      d.signals++;
      if (['submitted', 'exchange_accepted'].includes(e.result)) d.submitted++;
      if (e.result === 'failed') d.failed++;
    }
  }

  // Prefer actual trade fills over order-level fill summaries so the same execution
  // is not counted twice when both records exist.
  const allFillRows = journal.filter(e =>
    ['filled_trade', 'filled_order'].includes(e.category) &&
    ['BUY', 'SELL'].includes(String(e.action || '').toUpperCase()) &&
    Number(e.amount) > 0 && Number(e.price) > 0
  );
  const tradeOrderIds = new Set(allFillRows
    .filter(e => e.category === 'filled_trade' && e.orderId != null)
    .map(e => `${String(e.pair || '').toLowerCase()}|${String(e.orderId)}`));
  const fillRows = allFillRows.filter(e =>
    !(e.category === 'filled_order' &&
      tradeOrderIds.has(`${String(e.pair || '').toLowerCase()}|${String(e.orderId || '')}`))
  );

  // Count fills and fee costs on the actual fill date. Missing fee conversion remains
  // unknown (not silently treated as zero).
  for (const e of fillRows) {
    const day = eventDay(e);
    const d = ensureDay(day);
    if (!d) continue;
    d.fills++;
    const feeTwd = Number(e.feeTwdCost);
    if (Number.isFinite(feeTwd) && feeTwd >= 0) d.estimatedFees += feeTwd;
  }

  // FIFO inventory matching across dates. Profit is realized on the sell date.
  // A sell only realizes profit against previously recorded buy inventory.
  const chronological = [...fillRows].sort((a, b) =>
    (Date.parse(toIsoTimestamp(a.exchangeTime || a.time) || a.time) || 0) -
    (Date.parse(toIsoTimestamp(b.exchangeTime || b.time) || b.time) || 0)
  );
  const buyQueues = new Map();
  for (const e of chronological) {
    const pair = String(e.pair || '').toLowerCase();
    if (!pair) continue;
    const action = String(e.action || '').toUpperCase();
    const amount = Number(e.amount);
    const price = Number(e.price);
    const feeTwd = Number(e.feeTwdCost);
    const feeKnown = Number.isFinite(feeTwd) && feeTwd >= 0;
    const item = {
      remaining: amount, originalAmount: amount, price,
      feeRemaining: feeKnown ? feeTwd : null,
      feeKnown, day: eventDay(e)
    };
    if (action === 'BUY') {
      if (!buyQueues.has(pair)) buyQueues.set(pair, []);
      buyQueues.get(pair).push(item);
      continue;
    }
    if (action !== 'SELL') continue;
    let remainingSell = amount;
    const queue = buyQueues.get(pair) || [];
    const sellDay = eventDay(e);
    const sellFeeTotal = feeKnown ? feeTwd : null;
    let matchedTotal = 0;
    let grossTotal = 0;
    let buyFeeMatched = 0;
    let allMatchedFeesKnown = feeKnown;
    while (remainingSell > 1e-10 && queue.length) {
      const buy = queue[0];
      const matched = Math.min(remainingSell, buy.remaining);
      if (!(matched > 0)) { queue.shift(); continue; }
      const gross = (price - buy.price) * matched;
      grossTotal += gross;
      matchedTotal += matched;
      if (buy.feeKnown && buy.feeRemaining != null) {
        const feePart = buy.feeRemaining * (matched / buy.remaining);
        buyFeeMatched += feePart;
        buy.feeRemaining -= feePart;
      } else {
        allMatchedFeesKnown = false;
      }
      buy.remaining -= matched;
      remainingSell -= matched;
      if (buy.remaining <= 1e-10) queue.shift();
    }
    if (matchedTotal > 0) {
      const d = ensureDay(sellDay);
      d.estimatedGross += grossTotal;
      d.matchedAmount += matchedTotal;
      if (allMatchedFeesKnown && sellFeeTotal != null) {
        const matchedSellFee = sellFeeTotal * (matchedTotal / amount);
        d.estimatedNet += grossTotal - buyFeeMatched - matchedSellFee;
      }
    }
  }

  // Carry unmatched buy quantity into the latest date for visibility.
  const today = taipeiDate(new Date());
  const latestDay = Object.keys(map).sort().at(-1) || today;
  const latest = ensureDay(latestDay);
  if (latest) {
    for (const queue of buyQueues.values()) {
      for (const buy of queue) latest.unmatchedBuyAmount += Math.max(0, buy.remaining);
    }
  }

  const rows = Object.values(map).sort((a, b) => b.date.localeCompare(a.date));
  // Keep a standalone persisted snapshot, regenerated from journal source-of-truth.
  try {
    fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(rows, null, 2), 'utf8');
  } catch (err) {
    emit('warning', { message: `儲存每日統計 JSON 失敗：${err.message}` });
  }
  return rows;
}
app.get('/api/state', (req, res) => res.json({
  status, running, liveTrading: LIVE_TRADING, credentialsReady: credentialsReady(),
  balances, assetValuation, events: events.slice(0, 100), daily: dailySummary(),
  journal: journal.slice(0, 200), spreads: SPREADS, bitoTwdPrice, bitoTwdPriceAt
}));
app.get('/api/health', (req, res) => res.json({ ok: true, status: status.state }));

app.delete('/api/journal/:id', (req, res) => {
  const before = journal.length;
  journal = journal.filter(entry => String(entry.id || '') !== String(req.params.id));
  if (journal.length === before) return res.status(404).json({ ok: false, error: '找不到這筆紀錄' });
  persist();
  emit('journal', { journal: journal.slice(0, 200), deletedId: req.params.id });
  res.json({ ok: true, remaining: journal.length });
});
app.delete('/api/journal', (req, res) => {
  const deleted = journal.length;
  journal = [];
  persist();
  emit('journal', { journal: [], cleared: true });
  res.json({ ok: true, deleted });
});

app.post('/api/spreads', (req, res) => {
  const incoming = req.body || {};
  const next = {};
  for (const pair of PAIRS) {
    const value = Number(incoming[pair]);
    if (!Object.prototype.hasOwnProperty.call(incoming, pair) || !Number.isFinite(value) || value < 0 || value > 1e12) {
      return res.status(400).json({ ok: false, error: `價差設定無效：${pair.toUpperCase()} 必須是 0 到 1,000,000,000,000 之間的數字` });
    }
    next[pair] = value;
  }
  SPREADS = next;
  try { saveSpreads(); } catch (err) { return res.status(500).json({ ok: false, error: `無法儲存價差設定：${err.message}` }); }
  emit('info', { message: '策略價差設定已更新並儲存' });
  res.json({ ok: true, spreads: SPREADS, pairs: PAIRS, message: '價差設定已儲存；新訊號會使用新設定，交易所既有掛單不會自動修改。' });
});
app.post('/api/pairs', (req, res) => {
  const pair = String(req.body?.pair || '').trim().toLowerCase().replace('-', '_').replace('/', '_');
  const action = String(req.body?.action || 'add').toLowerCase();
  if (!validPair(pair)) return res.status(400).json({ ok: false, error: '交易對格式不正確，請輸入例如 ada_twd 或 btc_usdt（幣種_報價幣）' });
  if (action === 'add') {
    if (PAIRS.includes(pair)) return res.status(409).json({ ok: false, error: '這個交易對已經存在' });
    const spread = Number(req.body?.spread ?? 0);
    if (!Number.isFinite(spread) || spread < 0 || spread > 1e12) return res.status(400).json({ ok: false, error: '價差必須是 0 到 1,000,000,000,000 之間的數字' });
    PAIRS.push(pair); SPREADS[pair] = spread;
  } else if (action === 'remove') {
    if (!PAIRS.includes(pair)) return res.status(404).json({ ok: false, error: '找不到這個交易對' });
    if (PAIRS.length <= 1) return res.status(400).json({ ok: false, error: '至少要保留一個交易對' });
    PAIRS = PAIRS.filter(p => p !== pair); delete SPREADS[pair];
  } else return res.status(400).json({ ok: false, error: '不支援的操作' });
  try { savePairs(); saveSpreads(); } catch (err) { return res.status(500).json({ ok: false, error: `儲存交易對失敗：${err.message}` }); }
  emit('info', { message: action === 'add' ? `已新增交易對 ${pair.toUpperCase()}` : `已移除交易對 ${pair.toUpperCase()}` });
  res.json({ ok: true, pairs: PAIRS, spreads: SPREADS, message: action === 'add' ? '交易對已新增並儲存。請先確認 BitoPro 支援此交易對。' : '交易對已移除並儲存。既有掛單不會自動取消。' });
});
// 真實交易所掛單管理：列表、建立、取消；修改以「取消舊單後建立新單」實作，非交易所原子修改。
app.get('/api/orders/open', async (req, res) => {
  if (!requireCredentials(res)) return;
  const pair = String(req.query.pair || '').trim().toLowerCase();
  if (pair && !validPair(pair)) return res.status(400).json({ ok: false, error: '交易對格式不正確。' });
  const authPayload = { identity: EMAIL, nonce: Date.now() };
  try {
    const response = await axios.get('https://api.bitopro.com/v3/orders/open', {
      params: pair ? { pair } : {},
      headers: signedOrderHeaders(authPayload), timeout: 15000
    });
    const data = response.data?.data ?? response.data;
    res.json({ ok: true, orders: Array.isArray(data) ? data : [] });
  } catch (err) {
    res.status(err.response?.status || 502).json({ ok: false, error: apiErrorMessage(err) });
  }
});
app.post('/api/orders', async (req, res) => {
  if (!requireCredentials(res)) return;
  const pair = String(req.body?.pair || '').trim().toLowerCase();
  const action = String(req.body?.action || '').toUpperCase();
  const price = Number(req.body?.price);
  const amount = Number(req.body?.amount);
  const timeInForce = String(req.body?.timeInForce || 'POST_ONLY').toUpperCase();
  if (!validPair(pair)) return res.status(400).json({ ok: false, error: '交易對格式不正確。' });
  if (!['BUY', 'SELL'].includes(action)) return res.status(400).json({ ok: false, error: '方向必須是 BUY 或 SELL。' });
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ ok: false, error: '價格必須大於 0。' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: '數量必須大於 0。' });
  if (!['GTC', 'POST_ONLY'].includes(timeInForce)) return res.status(400).json({ ok: false, error: 'timeInForce 僅支援 GTC 或 POST_ONLY。' });
  const payload = { action, amount: String(amount), price: String(price), timestamp: Date.now(), type: 'LIMIT', timeInForce };
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptPayload = { ...payload, timestamp: Date.now() };
    try {
      const response = await axios.post(`https://api.bitopro.com/v3/orders/${pair}`, attemptPayload, {
        headers: signedOrderHeaders(attemptPayload, true), timeout: 15000
      });
      const result = response.data?.data ?? response.data;
      addJournal({ category: 'manual_exchange_order', pair, action, price, amount, orderId: result?.orderId || result?.id || null, result: 'exchange_accepted', retryCount: attempt - 1, live: true });
      emit('info', { message: `交易所已回應建立委託：${pair.toUpperCase()} ${action} ${amount} @ ${price}${attempt > 1 ? '（重試成功）' : ''}` });
      return res.json({ ok: true, order: result, message: '交易所已回應建立委託；請重新整理交易所掛單確認狀態。' });
    } catch (err) {
      lastError = err;
      if (!err.response || attempt >= 2) break;
      emit('warning', { message: `手動委託第 1 次建立失敗，準備重試：${apiErrorMessage(err)}` });
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  const message = lastError && !lastError.response
    ? '連線中斷或逾時，無法確認交易所是否已接受委託；請先刷新掛單，避免重複下單。'
    : apiErrorMessage(lastError || new Error('未知錯誤'));
  emit('error', { message: `建立委託失敗：${message}` });
  return res.status(lastError?.response?.status || 502).json({ ok: false, error: message });
});
app.delete('/api/orders/:pair/:id', async (req, res) => {
  if (!requireCredentials(res)) return;
  const pair = String(req.params.pair || '').toLowerCase();
  const id = String(req.params.id || '');
  if (!validPair(pair) || !id || id.length > 100) return res.status(400).json({ ok: false, error: '交易對或訂單 ID 不正確。' });
  try {
    const response = await axios.delete(`https://api.bitopro.com/v3/orders/${pair}/${encodeURIComponent(id)}`, {
      headers: signedOrderHeaders({ identity: EMAIL, nonce: Date.now() }), timeout: 15000
    });
    const result = response.data?.data ?? response.data;
    addJournal({ category: 'manual_exchange_cancel', pair, orderId: id, result: 'cancel_request_accepted', live: true });
    emit('info', { message: `已送出撤單請求：${pair.toUpperCase()} #${id}` });
    res.json({ ok: true, result, message: '交易所已回應撤單請求；掛單列表將自動同步更新。' });
  } catch (err) {
    emit('error', { message: `撤單失敗：${apiErrorMessage(err)}` });
    res.status(err.response?.status || 502).json({ ok: false, error: apiErrorMessage(err) });
  }
});
app.put('/api/orders/:pair/:id', async (req, res) => {
  if (!requireCredentials(res)) return;
  const pair = String(req.params.pair || '').toLowerCase();
  const newPair = String(req.body?.newPair || pair).toLowerCase().replace('-', '_').replace('/', '_');
  const id = String(req.params.id || '');
  const action = String(req.body?.action || '').toUpperCase();
  const price = Number(req.body?.price);
  const amount = Number(req.body?.amount);
  const timeInForce = String(req.body?.timeInForce || 'POST_ONLY').toUpperCase();
  if (!validPair(pair) || !validPair(newPair) || !id || id.length > 100) return res.status(400).json({ ok: false, error: '原交易對、新交易對或訂單 ID 不正確。' });
  if (!['BUY', 'SELL'].includes(action) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: '方向、價格或數量不正確。' });
  if (!['GTC', 'POST_ONLY'].includes(timeInForce)) return res.status(400).json({ ok: false, error: 'timeInForce 僅支援 GTC 或 POST_ONLY。' });
  try {
    await axios.delete(`https://api.bitopro.com/v3/orders/${pair}/${encodeURIComponent(id)}`, {
      headers: signedOrderHeaders({ identity: EMAIL, nonce: Date.now() }), timeout: 15000
    });
  } catch (err) {
    return res.status(err.response?.status || 502).json({ ok: false, error: `舊訂單撤銷失敗，未建立新單：${apiErrorMessage(err)}` });
  }
  const payload = { action, amount: String(amount), price: String(price), timestamp: Date.now(), type: 'LIMIT', timeInForce };
  try {
    const response = await axios.post(`https://api.bitopro.com/v3/orders/${newPair}`, payload, {
      headers: signedOrderHeaders(payload, true), timeout: 15000
    });
    const result = response.data?.data ?? response.data;
    addJournal({ category: 'manual_exchange_order_edit', pair: newPair, originalPair: pair, action, price, amount, replacedOrderId: id, orderId: result?.orderId || result?.id || null, result: 'cancelled_and_recreated', live: true });
    emit('info', { message: `訂單已撤銷並重新建立：${newPair.toUpperCase()} ${action} ${amount} @ ${price}` });
    res.json({ ok: true, order: result, message: `舊單已撤銷，新單已送至 ${newPair.toUpperCase()}。請重新整理確認新單狀態。` });
  } catch (err) {
    emit('error', { message: `舊單 ${pair.toUpperCase()} #${id} 已撤銷，但新交易對 ${newPair.toUpperCase()} 建立失敗：${apiErrorMessage(err)}` });
    res.status(err.response?.status || 502).json({ ok: false, error: `舊單 ${pair.toUpperCase()} #${id} 已撤銷，但新交易對 ${newPair.toUpperCase()} 建立失敗：${apiErrorMessage(err)}` });
  }
});
app.post('/api/start', (req, res) => res.json(startBot()));
app.post('/api/stop', (req, res) => res.json(stopBot()));
app.post('/api/balance', async (req, res) => {
  try { res.json({ ok: true, balances: await getAccountBalance() }); }
  catch (err) { res.status(400).json({ ok: false, error: err.response?.data || err.message }); }
});
app.get('/api/export.csv', (req, res) => {
  // CSV 僅匯出「每日統計」，不包含成交明細、掛單、餘額或即時事件。
  const headers = ['日期','完整成交','反向訊號','已送出','失敗','獲利（已配對毛利）','估算手續費','估算淨價差'];
  const fields = ['date','fills','signals','submitted','failed','estimatedGross','estimatedFees','estimatedNet'];
  const csvCell = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  const rows = [headers.map(csvCell).join(','), ...dailySummary().map(day => fields.map(k => csvCell(day[k])).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bito-daily-stats.csv"');
  res.send('\ufeff' + rows.join('\r\n'));
});
const server = app.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  // 成交紀錄與策略下單分離：服務啟動後自動補登歷史成交並連線成交事件，
  // 不再要求使用者按「啟動監控」，也不會因此自動啟動反向策略下單。
  running = true;
  setStatus('starting', '成交紀錄自動同步中');
  setTimeout(() => {
    backfillTradeHistory().catch(err =>
      emit('warning', { message: `服務啟動時歷史成交回補失敗：${apiErrorMessage(err)}` })
    );
    if (credentialsReady()) connectUserTradeSocket();
    else setStatus('needs_config', '請先設定 .env 的 API 認證資料');
  }, 1200);
});
const wss = new WebSocket.Server({ server, path: '/live' });
wss.on('connection', client => {
  clients.add(client);
  client.send(JSON.stringify({ kind: 'snapshot', state: {
    status, running, liveTrading: LIVE_TRADING, balances, events: events.slice(0, 100),
    daily: dailySummary(), journal: journal.slice(0, 200), spreads: SPREADS, credentialsReady: credentialsReady(), bitoTwdPrice, bitoTwdPriceAt
  }}));
  client.on('close', () => clients.delete(client));
});
process.on('SIGINT', () => { stopBot(); server.close(() => process.exit(0)); });
