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
  <style>body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;text-align:center}button{background:#00a884;border:0;color:#fff;border-radius:10px;padding:14px 22px;font-size:17px;cursor:pointer}img{max-width:280px;width:100%}.note{color:#55665c;font-size:14px;line-height:1.6}</style></head><body>
  <h1>🛒 Shifa Bazar BD</h1><h2>📱 WhatsApp Connect Korun</h2>
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
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shifa Bazar — Dashboard</title>
  <style>body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:20px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px;text-align:left;font-size:14px}.ok{color:green}.no{color:red}.card{border:1px solid #ddd;border-radius:12px;padding:12px;margin:10px 0}button{background:#00a884;border:0;color:#fff;border-radius:8px;padding:10px 16px;cursor:pointer}input{padding:10px;border-radius:8px;border:1px solid #ccc;width:100%;box-sizing:border-box;margin:4px 0}</style></head><body>
  <h1>🛒 Shifa Bazar BD — Software</h1><p id="st"></p><p>24/7 khola • Delivery FREE • COD + bKash • Shop: shifabazarbd.com</p>
  <div class="card"><b>📊 Stats</b><p id="stats"></p></div>
  <div class="card"><b>📦 Products</b><ul id="prods"></ul><p style="font-size:13px;color:#55665c">Dam: product er naam bolle bot dam jiggesh kore, karon site e exact price list chilo na.</p></div>
  <div class="card"><b>📩 Customer ke message pathao</b><input id="sn" placeholder="Customer number, jemon 8801XXXXXXXXX"><input id="stext" placeholder="Message likho..."><button onclick="sendMsg()">Pathao</button><p id="sendOut"></p></div>
  <div class="card"><b>🧾 Orders</b><table><thead><tr><th>ID</th><th>Somoy</th><th>Ke</th><th>Order message</th><th>Status</th></tr></thead><tbody id="orows"></tbody></table></div>
  <div class="card"><b>👥 Customers</b><ul id="custs"></ul></div>
  <div class="card"><b>💬 Sob message</b><button onclick="load()">Refresh</button><table><thead><tr><th>Somoy</th><th>Ke (number)</th><th>Ki bollo</th><th>Bot ki reply dilo</th></tr></thead><tbody id="rows"></tbody></table></div>
  <p style="color:#55665c;font-size:13px">Note: Render free te service ghumale / restart hole purono log muche jete pare — eta live log, permanent database na.</p>
  <script>async function load(){const r=await fetch('/api/messages');const j=await r.json();document.getElementById('st').innerHTML=j.connected?'<b class="ok">✅ Connected: '+j.number+'</b>':'<b class="no">❌ Connected na — age link koro</b>';document.getElementById('stats').textContent='Message: '+j.messages.length+' • Order: '+j.orders.length+' • Customer: '+j.customers.length;document.getElementById('prods').innerHTML=j.products.map(p=>'<li>'+p+'</li>').join('');document.getElementById('custs').innerHTML=j.customers.length?j.customers.map(c=>'<li>'+c.from+' — sesh message: '+c.text+'</li>').join(''):'<li>Ekono keu message dey nai.</li>';document.getElementById('orows').innerHTML=j.orders.length?j.orders.map(o=>'<tr><td>'+o.id+'</td><td>'+o.time+'</td><td>'+o.from+'</td><td>'+o.text+'</td><td>'+o.status+'</td></tr>').join(''):'<tr><td colspan=5>Ekono kono order ashe nai.</td></tr>';document.getElementById('rows').innerHTML=j.messages.length?j.messages.map(m=>'<tr><td>'+m.time+'</td><td>'+m.from+'</td><td>'+m.text+'</td><td>'+m.reply+'</td></tr>').join(''):'<tr><td colspan=4>Ekono kono message ashe nai.</td></tr>';}
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
  try {
    const code = await sock.requestPairingCode(String(number).replace(/\D/g, ''));
    res.json({ ok: true, code, number: String(number) });
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
