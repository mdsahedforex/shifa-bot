// Shifa Bazar BD — WhatsApp bot for Replit (NO PC, NO Docker needed).
// Run: npm install && npm start
// Open the Replit webview: click "WhatsApp Connect Korun" -> QR appears ->
// scan from phone WhatsApp > Linked Devices -> bot stays connected while
// the Replit app is running, and auto-replies to incoming messages.
// NOTE: This uses WhatsApp Web protocol (unofficial). Low volume = low risk.
// Do NOT send bulk/spam messages.
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

let sock = null;
let latestQr = null;
let connected = false;
let connectedNumber = '';
// Dashboard log: ke message dilo, ki bollo, bot ki reply dilo, kokhon
let messageLog = [];
let orderLog = [];
let orderSeq = 0;
function logMsg(from, text, reply) {
  messageLog.unshift({ time: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }), from, text, reply });
  if (messageLog.length > 100) messageLog.pop();
  // Order hole order list e o rakho: order / kinte / chai + product thakle
  const t = (text || '').toLowerCase();
  if (t.includes('order') || t.includes('kinte') || t.includes('chai') || t.includes('অর্ডার') || t.includes('kinbo')) {
    orderSeq++;
    orderLog.unshift({ id: 'SB-' + String(orderSeq).padStart(4, '0'), time: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }), from, text, status: 'pending' });
    if (orderLog.length > 100) orderLog.pop();
  }
}
const PRODUCTS = ['Taja shobji o fol', 'Dudh-dim', 'Khanti ghi o bhojjo tel', 'Moshla', 'Khanti madhu', 'Khejur o badam', 'Chal-dal (daily essentials)', 'Ghore toiri achar-chatni'];
function customers() {
  const seen = new Map();
  for (const m of messageLog) if (!seen.has(m.from)) seen.set(m.from, m);
  return [...seen.values()];
}

// --- Same Shifa Bazar BD rules as the Vercel panel ---
const RULES = [
  { keys: ['delivery', 'home delivery', 'ডেলিভারি', 'charge'], reply: 'Ji, home delivery hoy — ar delivery charge sampurno FREE. Apnar puro thikana ta din, amra pouchiye dibo.' },
  { keys: ['time', 'khola', 'open', 'সময়', 'খোলা', 'kokhon', 'কখন'], reply: 'Amra 24/7 khola — din-raat jekono somoy order korte parben, ekhanei message din.' },
  { keys: ['uttara', 'location', 'kothay', 'ঠিকানা', 'elaka'], reply: 'Amra Dhaka-Uttara theke delivery dei, druto pouchay. Apnar puro thikana ta din, amra confirm korbo.' },
  { keys: ['order', 'kinte', 'chai', 'চাই', 'অর্ডার', 'kinbo'], reply: 'Order korte chaile ekhanei likhe din: 1) Ki ki product + poriman 2) Apnar naam 3) Mobile number 4) Puro thikana. Amra confirm kore delivery r bebostha korbo.' },
  { keys: ['payment', 'bkash', 'bikash', 'বিকাশ', 'pay', 'cod', 'cash'], reply: 'Payment 2 vabe korte parben: Cash on Delivery (product hate peye taka) othoba bKash. Jeta subidha setai korun.' },
  { keys: ['ki ki', 'product', 'ache', 'পণ্য', 'item', 'category'], reply: 'Amader kache ache: taja shobji o fol, dudh-dim, khanti ghi o bhojjo tel, moshla, khanti madhu, khejur o badam, chal-dal, ar ghore toiri achar-chatni. Sob dekhun: https://shifabazarbd.com/shop' },
  { keys: ['offer', 'discount', 'flash', 'অফার', 'ছাড়', 'deal'], reply: 'Website e Flash Sale / Hot Deal section e majhe majhei offer thake. Ajker offer dekhun: https://shifabazarbd.com' },
  { keys: ['dam', 'price', 'koto', 'দাম', 'price list'], reply: 'Kon product er dam jante chan? Naam ta bolun — dam janiye dicchi. Chaile sob product dekhte paren: https://shifabazarbd.com/shop' },
];
const WELCOME = 'Assalamu Alaikum! Shifa Bazar BD te jogajog korar jonno dhonnobad. Ekhane taja shobji-fol, dudh-dim, ghi, madhu, chal-dal, moshla, achar shoho nityo proyojonio sob paben. Amra 24/7 khola, delivery charge sampurno FREE, Cash on Delivery o bKash ache. Kivabe help korte pari? Likhte paren: dam / order / delivery / payment';
const FALLBACK = 'Dhonnobad! Apnar message ta pelam, note kore rakhlam. Amra khub taratari nije reply dibo. Urgent hole call korun: +8801951511237';
function pickReply(text) {
  const t = (text || '').toLowerCase().trim();
  if (t.includes('salam') || t.includes('hello') || t.includes('হাই') || t.includes('আসসালাম') || t === 'hi') return WELCOME;
  for (const r of RULES) if (r.keys.some(k => t.includes(k))) return r.reply;
  return FALLBACK;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { latestQr = qr; connected = false; }
    if (connection === 'open') { connected = true; latestQr = null; connectedNumber = sock.user ? sock.user.id.split(':')[0] : ''; console.log('WhatsApp connected:', connectedNumber); }
    if (connection === 'close') {
      connected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startBot, 3000); else console.log('Logged out — delete auth_info and scan QR again.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const jid = m.key.remoteJid || '';
      // WhatsApp ekhon onek somoy @lid dey, @s.whatsapp.net na — tai suffix diye filter korbo na
      if (!jid || jid === 'status@broadcast') continue;
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (!text) continue;
      const reply = pickReply(text);
      logMsg(jid, text, reply);
      await new Promise(r => setTimeout(r, 1200));
      await sock.sendMessage(jid, { text: reply });
    }
  });
}

app.get('/', (_req, res) => {
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shifa Bazar BD — WhatsApp Connect</title>
  <style>body{font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;text-align:center;background:#f0f4f1}button{background:linear-gradient(135deg,#00a884,#007a5e);border:0;color:#fff;border-radius:14px;padding:14px 22px;font-size:17px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,168,132,.3)}img{max-width:280px;width:100%}.note{color:#55665c;font-size:14px;line-height:1.6}.card{background:#fff;border-radius:20px;padding:20px;box-shadow:0 6px 20px rgba(0,0,0,.07)}</style></head><body>
  <div class="card"><h1>🛒 Shifa Bazar BD</h1><h2>📱 WhatsApp Connect Korun</h2>
  <p><a href="/dashboard">📊 Dashboard dekho — ke message dilo, bot ki reply dilo</a></p>
  <p class="note">Button chaple QR asbe. Phone er WhatsApp &gt; Linked Devices &gt; Link a Device diye scan koro. Connect hoye gele bot nije message handle korbe — 24/7, delivery FREE, COD + bKash.</p>
  <button onclick="loadQr()">📱 WhatsApp Connect Korun (QR)</button>
  <p class="note" style="margin-top:16px"><b>QR chara, number diye connect korte chaile:</b><br>Number dao, code nao, tarpor WhatsApp &gt; Linked Devices &gt; Link with phone number e code ta bosao.</p>
  <input id="pairNum" placeholder="8801XXXXXXXXX" style="padding:10px;border-radius:8px;border:1px solid #ccc;width:220px">
  <button onclick="pairCode()">Code Nao</button>
  <p id="pairOut" class="note"></p>
  <p id="status" class="note"></p><div id="qr"></div>
  <script>async function loadQr(){const s=document.getElementById('status'),q=document.getElementById('qr');s.textContent='QR anchi...';const r=await fetch('/qr');const j=await r.json();if(j.connected){s.textContent='✅ Connected! ('+j.number+')';q.innerHTML='';}else if(j.qr){s.textContent='QR ready — phone diye scan koro.';q.innerHTML='<img src="'+j.qr+'">';}else{s.textContent='QR ekhono ready na, 5 second por abar chap dao.';}}
  async function pairCode(){const n=document.getElementById('pairNum').value.trim(),o=document.getElementById('pairOut');if(!n){o.textContent='Age number dao.';return;}o.textContent='Code anchi...';const r=await fetch('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:n})});const j=await r.json();o.textContent=j.code?('Tomar code: '+j.code+' — WhatsApp > Linked Devices > Link with phone number e ei code bosao.'):(j.error||'Code pawa jay nai.');}</script>
  </body></html>`);
});
app.get('/status', (_req, res) => res.json({ connected, number: connectedNumber, hasQr: !!latestQr }));
app.get('/api/messages', (_req, res) => res.json({ connected, number: connectedNumber, messages: messageLog, orders: orderLog, customers: customers(), products: PRODUCTS }));
app.get('/api/orders', (_req, res) => res.json({ orders: orderLog }));
app.get('/dashboard', (_req, res) => {
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shifa Bazar BD — Premium Dashboard</title>
  <style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f0f4f1;color:#1a2e22}.top{background:linear-gradient(135deg,#00a884,#007a5e);color:#fff;padding:28px 20px 22px}.top h1{margin:0;font-size:30px}.top p{margin:6px 0 0;opacity:.9}.wrap{max-width:900px;margin:-14px auto 30px;padding:0 16px}.pill{display:inline-block;background:#fff;color:#007a5e;border-radius:999px;padding:6px 14px;font-weight:700;font-size:13px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}.stat{background:#fff;border-radius:18px;padding:16px;box-shadow:0 6px 20px rgba(0,0,0,.07)}.stat b{font-size:28px;display:block}.stat span{color:#667}.card{background:#fff;border-radius:20px;padding:18px;margin:14px 0;box-shadow:0 6px 20px rgba(0,0,0,.07)}h2{margin:0 0 10px;font-size:18px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #eee;padding:9px 6px;text-align:left;font-size:14px}button{background:linear-gradient(135deg,#00a884,#007a5e);border:0;color:#fff;border-radius:12px;padding:12px 18px;font-size:15px;font-weight:700;cursor:pointer}input{padding:12px;border-radius:12px;border:1px solid #d5ddd8;width:100%;margin:5px 0;font-size:15px}.tag{display:inline-block;background:#e6f7f1;color:#007a5e;border-radius:999px;padding:4px 10px;margin:3px;font-size:13px}.ok{color:#0a7a4b}.no{color:#c0392b}@media(max-width:600px){.grid{grid-template-columns:1fr 1fr}.top h1{font-size:24px}}</style></head><body>
  <div class="top"><h1>🛒 Shifa Bazar BD</h1><p>Premium WhatsApp Software • 24/7 • Delivery FREE • COD + bKash</p><br><span class="pill" id="st">Loading…</span> <a href="/" style="color:#fff;font-weight:700;margin-left:10px">📱 WhatsApp Connect Korun</a></div>
  <div class="wrap">
  <div class="grid"><div class="stat"><b id="sMsg">0</b><span>💬 Message</span></div><div class="stat"><b id="sOrd">0</b><span>🧾 Order</span></div><div class="stat"><b id="sCust">0</b><span>👥 Customer</span></div></div>
  <div class="card"><h2>📦 Products</h2><div id="prods"></div></div>
  <div class="card"><h2>📩 Customer ke message pathao</h2><input id="sn" placeholder="Customer number, jemon 8801XXXXXXXXX"><input id="stext" placeholder="Message likho..."><button onclick="sendMsg()">✈️ Pathao</button><p id="sendOut"></p></div>
  <div class="card"><h2>🧾 Orders</h2><table><thead><tr><th>ID</th><th>Somoy</th><th>Ke</th><th>Order</th><th>Status</th></tr></thead><tbody id="orows"></tbody></table></div>
  <div class="card"><h2>👥 Customers</h2><ul id="custs"></ul></div>
  <div class="card"><h2>💬 Sob message <button onclick="load()" style="float:right">Refresh</button></h2><table><thead><tr><th>Somoy</th><th>Ke</th><th>Ki bollo</th><th>Bot reply</th></tr></thead><tbody id="rows"></tbody></table></div>
  <p style="color:#667;font-size:13px;text-align:center">Render free te restart hole purono log muche jete pare — eta live log, permanent database na.</p>
  </div>
  <script>async function load(){const r=await fetch('/api/messages');const j=await r.json();document.getElementById('st').innerHTML=j.connected?'✅ Connected: '+j.number:'❌ Connected na — age link koro';document.getElementById('sMsg').textContent=j.messages.length;document.getElementById('sOrd').textContent=j.orders.length;document.getElementById('sCust').textContent=j.customers.length;document.getElementById('prods').innerHTML=j.products.map(p=>'<span class="tag">'+p+'</span>').join('');document.getElementById('custs').innerHTML=j.customers.length?j.customers.map(c=>'<li>'+c.from+' — '+c.text+'</li>').join(''):'<li>Ekono keu message dey nai.</li>';document.getElementById('orows').innerHTML=j.orders.length?j.orders.map(o=>'<tr><td>'+o.id+'</td><td>'+o.time+'</td><td>'+o.from+'</td><td>'+o.text+'</td><td>'+o.status+'</td></tr>').join(''):'<tr><td colspan=5>Ekono kono order ashe nai.</td></tr>';document.getElementById('rows').innerHTML=j.messages.length?j.messages.map(m=>'<tr><td>'+m.time+'</td><td>'+m.from+'</td><td>'+m.text+'</td><td>'+m.reply+'</td></tr>').join(''):'<tr><td colspan=4>Ekono kono message ashe nai.</td></tr>';}
  async function sendMsg(){const n=document.getElementById('sn').value.trim(),t=document.getElementById('stext').value.trim(),o=document.getElementById('sendOut');if(!n||!t){o.textContent='Number ar message 2 tai dao.';return;}const r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:n,text:t})});const j=await r.json();o.textContent=j.ok?'✅ Pathano hoyeche.':('❌ '+(j.error||'Hoy nai'));load();}
  load();setInterval(load,15000);</script>
  </body></html>`);
});
app.get('/qr', async (_req, res) => {
  if (connected) return res.json({ connected: true, number: connectedNumber });
  if (!latestQr) return res.json({ connected: false, qr: null });
  const img = await QRCode.toDataURL(latestQr);
  res.json({ connected: false, qr: img });
});
// Pairing-code connect (NO QR needed):
// POST /pair { number: "8801XXXXXXXXX" } -> { code: "ABCD-1234" }
// Then on the phone: WhatsApp > Linked Devices > Link with phone number
// instead of QR > enter that code. After that, sock becomes connected and
// this same number's messages are auto-handled by the bot.
app.post('/pair', async (req, res) => {
  if (connected) return res.json({ ok: true, connected: true, number: connectedNumber });
  if (!sock) return res.status(503).json({ ok: false, error: 'Bot ekhono start hoy nai' });
  const { number } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number required, jemon 8801XXXXXXXXX' });
  const clean = String(number).replace(/\D/g, '');
  try {
    const code = await sock.requestPairingCode(clean);
    res.json({ ok: true, code, number: clean });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
app.get('/pair-status', (_req, res) => res.json({ connected, number: connectedNumber }));

// Owner send (same idea as Vercel panel): POST { number, text }
app.post('/send', async (req, res) => {
  if (!connected || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp connected na' });
  const { number, text } = req.body || {};
  if (!number || !text) return res.status(400).json({ error: 'number and text required' });
  await sock.sendMessage(String(number).replace(/\D/g, '') + '@s.whatsapp.net', { text: String(text) });
  res.json({ ok: true });
});

app.listen(PORT, () => { console.log('listening on', PORT); startBot(); });
