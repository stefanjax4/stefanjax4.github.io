// STEFANJAXONGAMES server - no npm install needed (Node 16+).  Run:  node server.js
// Env: PORT (default 3000), ADMIN_PASSWORD (CHANGE THIS!)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || 'stefanandjaxonknowthis';
const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: {}, msgs: [], nextId: 1 };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => { if (dirty) { fs.writeFileSync(DB_FILE, JSON.stringify(db)); dirty = false; } }, 2000);
process.on('SIGINT', () => { fs.writeFileSync(DB_FILE, JSON.stringify(db)); process.exit(); });

const sessions = {}; // token -> userKey
const key = n => String(n || '').trim().toLowerCase();
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const state = u => ({ name: u.name, coins: u.coins, unlocked: u.unlocked, friends: u.friends.map(k => db.users[k]?.name).filter(Boolean), requests: u.requests.map(k => db.users[k]?.name).filter(Boolean) });
const fail = (msg, code = 400) => ({ code, body: { error: msg } });

// light rate limit on login/register (per IP)
const tries = {};
const limited = ip => { const n = Date.now(), t = (tries[ip] = (tries[ip] || []).filter(x => n - x < 60000)); t.push(n); return t.length > 15; };

function handle(action, d, ip) {
  if (action === 'register' || action === 'login') {
    if (limited(ip)) return fail('Too many attempts, wait a minute.', 429);
    const k = key(d.username), pw = String(d.password || '');
    if (action === 'register') {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(String(d.username || ''))) return fail('Username must be 3-16 letters, numbers or _');
      if (pw.length < 6) return fail('Password must be at least 6 characters');
      if (db.users[k]) return fail('That username is taken');
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[k] = { name: d.username.trim(), salt, hash: hash(pw, salt), coins: 0, unlocked: [], friends: [], requests: [], banned: false, created: Date.now() };
      save();
    }
    const u = db.users[k];
    if (!u || hash(pw, u.salt) !== u.hash) return fail('Wrong username or password', 401);
    if (u.banned) return fail('This account is banned from the website.', 403);
    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = k;
    return { body: { token, state: state(u) } };
  }

  if (action === 'admin') {
    if (d.pass !== ADMIN) return fail('Wrong admin password', 401);
    const u = db.users[key(d.user)];
    if (d.op === 'list') return { body: { users: Object.values(db.users).map(x => ({ name: x.name, coins: x.coins, banned: x.banned, friends: x.friends.length })) } };
    if (!u) return fail('No such user');
    if (d.op === 'ban') u.banned = true; // sessions kept so the player sees the ban screen
    else if (d.op === 'unban') u.banned = false;
    else if (d.op === 'reset') { u.coins = 0; u.unlocked = []; }
    else if (d.op === 'give') { const a = Math.floor(+d.amount); if (!(a > 0 && a <= 1e9)) return fail('Bad amount'); u.coins += a; }
    else return fail('Unknown op');
    save();
    return { body: { ok: true } };
  }

  const k = sessions[d.token], me = k && db.users[k];
  if (!me) return fail('Please sign in again', 401);
  if (me.banned) return fail('banned', 403);

  switch (action) {
    case 'sync': {
      const delta = Math.max(-500, Math.min(200, Math.floor(+d.delta || 0)));
      me.coins = Math.max(0, me.coins + delta);
      if (Array.isArray(d.unlocked)) me.unlocked = d.unlocked.filter(x => ['pacman', 'flappy', 'clicker', 'memory', 'bricks'].includes(x));
      save();
      return { body: { state: state(me) } };
    }
    case 'add': {
      const t = db.users[key(d.name)];
      if (!t || t === me || t.banned) return fail('User not found');
      const tk = key(t.name), mk = key(me.name);
      if (me.friends.includes(tk)) return fail('Already friends');
      if (me.requests.includes(tk)) { // accepting
        me.requests = me.requests.filter(x => x !== tk);
        me.friends.push(tk); t.friends.push(mk);
      } else if (!t.requests.includes(mk)) t.requests.push(mk);
      save();
      return { body: { state: state(me) } };
    }
    case 'send': {
      const t = db.users[key(d.to)], a = Math.floor(+d.amount);
      if (!t || t === me || t.banned) return fail('User not found');
      if (!(a > 0) || a > me.coins) return fail('Not enough coins');
      me.coins -= a; t.coins += a; save();
      return { body: { state: state(me) } };
    }
    case 'chat': {
      const t = db.users[key(d.to)];
      const text = String(d.text || '').trim().slice(0, 500);
      if (!t || !me.friends.includes(key(t.name))) return fail('You can only chat with friends');
      if (!text) return fail('Empty message');
      db.msgs.push({ id: db.nextId++, from: me.name, to: t.name, text, t: Date.now() });
      if (db.msgs.length > 20000) db.msgs.splice(0, 5000);
      save();
      return { body: { ok: true } };
    }
    case 'poll': {
      const p = key(d.peer), since = +d.since || 0;
      const msgs = p && me.friends.includes(p) ? db.msgs.filter(m => m.id > since && ((key(m.from) === k && key(m.to) === p) || (key(m.from) === p && key(m.to) === k))).slice(-100) : [];
      return { body: { state: state(me), msgs } };
    }
  }
  return fail('Unknown action', 404);
}

const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = handle(req.url.slice(5).split('?')[0], JSON.parse(raw || '{}'), req.socket.remoteAddress); }
      catch (e) { out = fail('Bad request'); }
      res.writeHead(out.code || 200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
    return;
  }
  let f = decodeURIComponent(req.url.split('?')[0]);
  if (f === '/') f = '/index.html';
  const full = path.join(__dirname, path.normalize(f));
  const type = TYPES[path.extname(full).toLowerCase()];
  if (!full.startsWith(__dirname) || !type || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => console.log(`STEFANJAXONGAMES running on http://localhost:${PORT}`));
