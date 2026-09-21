// Gold semi-auto trader for Capital.com. Node 18+, no dependencies.
const http = require('http'), fs = require('fs'), path = require('path');
const { CAPITAL_API_KEY, CAPITAL_EMAIL, CAPITAL_PASSWORD, APP_PIN, MODE = 'demo', PORT = 3000 } = process.env;
const BASE = MODE === 'live' ? 'https://api-capital.backend-capital.com' : 'https://demo-api-capital.backend-capital.com';
const EPIC = 'GOLD', SL = 20, TP = 40, MAX_TRADES = 5, MAX_SPREAD = 1.5;
const SESSION_UTC = [13, 20]; // New York hours only (UTC) - best in backtest

let sess = null;
let state = { day: '', qty: null, trades: 0, log: [], signal: null, lastCandle: '' };
const today = () => new Date().toISOString().slice(0, 10);
const log = m => { state.log.unshift(new Date().toISOString().slice(11, 19) + ' ' + m); state.log = state.log.slice(0, 30); };
function rollDay() { if (state.day !== today()) state = { day: today(), qty: null, trades: 0, log: state.log, signal: null, lastCandle: '' }; }

let loginBlockedUntil = 0, loginInFlight = null, scanning = false;
async function login() {
  if (Date.now() < loginBlockedUntil) throw new Error('Login cooling down, retry in ' + Math.ceil((loginBlockedUntil - Date.now()) / 1000) + 's');
  if (loginInFlight) return loginInFlight;
  loginInFlight = doLogin().catch(e => { loginBlockedUntil = Date.now() + (/429/.test(e.message) ? 10 : 3) * 60 * 1000; throw e; }).finally(() => { loginInFlight = null; });
  return loginInFlight;
}
async function doLogin() {
  const r = await fetch(BASE + '/api/v1/session', { method: 'POST',
    headers: { 'X-CAP-API-KEY': CAPITAL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: CAPITAL_EMAIL, password: CAPITAL_PASSWORD, encryptedPassword: false }) });
  if (!r.ok) throw new Error('Login failed ' + r.status);
  sess = { cst: r.headers.get('CST'), tok: r.headers.get('X-SECURITY-TOKEN') };
}
async function api(method, url, body, retry = true) {
  if (!sess) await login();
  const r = await fetch(BASE + url, { method, headers: { CST: sess.cst, 'X-SECURITY-TOKEN': sess.tok, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  if (r.status === 401 && retry) { sess = null; return api(method, url, body, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(url + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
const ema = (v, n) => { const k = 2 / (n + 1); let e = v[0]; return v.map(x => (e = x * k + e * (1 - k))); };
const mid = p => (p.closePrice.bid + p.closePrice.ask) / 2;

async function scan() {
  rollDay();
  if (scanning) return;
  scanning = true;
  try {
    const h = new Date().getUTCHours();
    if (h < SESSION_UTC[0] || h >= SESSION_UTC[1]) { state.signal = null; return; }
    if (state.qty == null || state.trades >= MAX_TRADES) return;
    const [h1, m15] = await Promise.all([
      api('GET', `/api/v1/prices/${EPIC}?resolution=HOUR&max=260`),
      api('GET', `/api/v1/prices/${EPIC}?resolution=MINUTE_15&max=60`)]);
    const hc = h1.prices.slice(0, -1).map(mid), e50 = ema(hc, 50).at(-1), e200 = ema(hc, 200).at(-1);
    const c = m15.prices.slice(0, -1); // closed candles only
    const closes = c.map(mid), e20 = ema(closes, 20);
    const last = c.at(-1), i = c.length - 1;
    if (last.snapshotTimeUTC === state.lastCandle) return;
    state.lastCandle = last.snapshotTimeUTC;
    const lo = last.lowPrice.bid, hi = last.highPrice.bid, cl = closes[i], op = (last.openPrice.bid + last.openPrice.ask) / 2;
    const spread = last.closePrice.ask - last.closePrice.bid;
    if (spread > MAX_SPREAD) { state.signal = null; return; }
    let dir = null;
    if (e50 > e200 && lo <= e20[i] && cl > e20[i] && cl > op) dir = 'BUY';
    if (e50 < e200 && hi >= e20[i] && cl < e20[i] && cl < op) dir = 'SELL';
    state.signal = dir ? { dir, price: cl, time: last.snapshotTimeUTC, expires: Date.now() + 10 * 60 * 1000 } : null;
    if (dir) log(`Signal ${dir} @ ${cl.toFixed(2)}`);
  } catch (e) { log('Scan error: ' + e.message); }
  finally { scanning = false; }
}
setInterval(scan, 60 * 1000);

// ---- Account view (shows manual + app trades) ----
let acct = { t: 0, positions: [], closed: [], err: null };
async function refreshAcct() {
  if (Date.now() - acct.t < 10000) return;
  acct.t = Date.now();
  try {
    const r = await api('GET', '/api/v1/positions');
    acct.positions = (r.positions || []).map(x => {
      const p = x.position, m = x.market, buy = p.direction === 'BUY';
      const px = buy ? m.bid : m.offer;
      const pts = buy ? px - p.level : p.level - px;
      return { name: m.instrumentName || m.epic, epic: m.epic, dir: p.direction, size: p.size, open: p.level,
        stop: p.stopLevel ?? null, limit: p.profitLevel ?? null, pts, pnl: pts * p.size, cur: p.currency || '', time: p.createdDateUTC || p.createdDate || '' };
    });
    acct.err = null;
  } catch (e) { acct.err = e.message; }
  try {
    const d = today(), r = await api('GET', `/api/v1/history/transactions?type=TRADE&from=${d}T00:00:00&to=${d}T23:59:59`);
    acct.closed = (r.transactions || []).map(t => ({ name: t.instrumentName, size: t.size, open: t.openLevel, close: t.closeLevel,
      pnl: t.profitAndLoss, time: (t.dateUtc || t.date || '').slice(11, 19) }));
  } catch (e) { /* history is optional */ }
}

async function execute() {
  rollDay();
  if (state.qty == null) throw new Error('Set today\'s quantity first');
  if (state.trades >= MAX_TRADES) throw new Error('Max trades reached for today');
  if (!state.signal || Date.now() > state.signal.expires) throw new Error('No live signal');
  const open = await api('GET', '/api/v1/positions');
  if (open.positions.some(p => p.market.epic === EPIC)) throw new Error('A gold position is already open');
  const r = await api('POST', '/api/v1/positions', { epic: EPIC, direction: state.signal.dir, size: state.qty,
    guaranteedStop: false, stopDistance: SL, profitDistance: TP });
  state.trades++; log(`Opened ${state.signal.dir} ${state.qty} ref ${r.dealReference}`); state.signal = null;
  return r;
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      if (req.headers['x-pin'] !== APP_PIN) return send(res, 401, { error: 'Wrong PIN' });
      rollDay();
      if (req.url === '/api/state') { await refreshAcct(); return send(res, 200, { ...state, mode: MODE, SL, TP, MAX_TRADES, positions: acct.positions, closedToday: acct.closed, acctErr: acct.err }); }
      let body = ''; for await (const ch of req) body += ch; body = body ? JSON.parse(body) : {};
      if (req.url === '/api/qty') {
        const q = Number(body.qty); if (!(q > 0)) return send(res, 400, { error: 'Bad qty' });
        if (state.qty != null && state.trades > 0) return send(res, 400, { error: 'Qty is locked for today' });
        state.qty = q; log('Today qty set to ' + q); return send(res, 200, state);
      }
      if (req.url === '/api/execute') { await execute(); return send(res, 200, state); }
      if (req.url === '/api/scan') { state.lastCandle = ''; await scan(); return send(res, 200, state); }
      return send(res, 404, {});
    }
    const f = req.url === '/manifest.json' ? 'manifest.json' : 'index.html';
    res.writeHead(200, { 'Content-Type': f.endsWith('json') ? 'application/json' : 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', f)));
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log('Running on ' + PORT + ' mode=' + MODE));
