/* Awakening Path service worker
   1) Offline cache for the app shell, icons and fonts
   2) Daily quest reminders (notification click + background check where supported)

   Reminder state is written by the app into STATE_CACHE (see stampRemState in index.html):
     enabled, slots (today's only: morning, plus evening on the final day), evening, eveningTime,
     today, pending, cycleIdx, cycleDay, cycleStart, cycleEnd (ms). Notification text below mirrors
     reminderText() in the app so closed-app notifications read exactly the same. */
const VERSION = 'v8';
const SHELL_CACHE = 'awakening-shell-' + VERSION;
const STATE_CACHE = 'awakening-state';
const STATE_URL = './__reminder-state.json';

// Max lateness (minutes) for a scheduled notification; same value as the app.
const REMINDER_GRACE_MIN = 10;
const QUEST_WINDOW_HOURS = 48; // keep in sync with the app

const FONT_FILES = [
  'orbitron-500','orbitron-700','orbitron-900',
  'rajdhani-500','rajdhani-600','rajdhani-700',
  'jetbrains-mono-400','jetbrains-mono-700',
  'chakra-petch-500','chakra-petch-600','chakra-petch-700',
  'space-mono-400','space-mono-700'
].map(f => './fonts/' + f + '.woff2');

const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', ...FONT_FILES];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('awakening-shell-') && k !== SHELL_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.endsWith('__reminder-state.json')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    const refresh = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await refresh) || Response.error();
  })());
});

/* ---------- Notification icons (drawn on OffscreenCanvas) ---------- */
let _iconUrl = null, _badgeUrl = null;

async function blobToDataUrl(blob){
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(bin);
}

async function renderIcon(size, draw){
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const c = new OffscreenCanvas(size, size);
    const x = c.getContext('2d');
    draw(x, size);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return await blobToDataUrl(blob);
  } catch (e){ return null; }
}

async function notifIconUrl(){
  if (_iconUrl) return _iconUrl;
  _iconUrl = await renderIcon(192, (x, s) => {
    const g = x.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, '#0a0a0f'); g.addColorStop(1, '#12121f');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    x.strokeStyle = '#00f0ff'; x.lineWidth = 9; x.lineCap = 'round';
    x.beginPath(); x.arc(s/2, s/2, 60, 0, Math.PI*2); x.stroke();
    x.beginPath(); x.arc(s/2, s/2, 34, 0, Math.PI*2); x.stroke();
    x.beginPath(); x.arc(s/2, s/2, 12, 0, Math.PI*2);
    x.fillStyle = '#ff2bd6'; x.fill();
    for (let i = 0; i < 4; i++){
      const a = i * Math.PI / 2;
      x.beginPath();
      x.moveTo(s/2 + Math.cos(a)*76, s/2 + Math.sin(a)*76);
      x.lineTo(s/2 + Math.cos(a)*90, s/2 + Math.sin(a)*90);
      x.stroke();
    }
  });
  if (!_iconUrl) _iconUrl = './icon-512.png';
  return _iconUrl;
}

async function notifBadgeUrl(){
  if (_badgeUrl) return _badgeUrl;
  _badgeUrl = await renderIcon(96, (x, s) => {
    x.clearRect(0, 0, s, s);
    x.strokeStyle = '#ffffff'; x.lineWidth = 8;
    x.beginPath(); x.arc(s/2, s/2, 32, 0, Math.PI*2); x.stroke();
    x.beginPath(); x.arc(s/2, s/2, 12, 0, Math.PI*2); x.stroke();
  });
  if (!_badgeUrl) _badgeUrl = './icon-192.png';
  return _badgeUrl;
}

/* ---------- Reminders ---------- */
function dayKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function toMins(t){ const [h,m] = String(t||'0:0').split(':').map(Number); return (h||0)*60 + (m||0); }

// Same wording as leftText()/reminderText() in the app.
function leftText(ms){ const h = Math.ceil(Math.max(0, ms) / 3600000); return h <= 1 ? 'under 1h' : 'about ' + h + 'h'; }

// Day of the cycle (1 = first day, 2 = final day), recomputed from the cycle start
// so it stays correct even if the app wasn't opened since the state was written.
function cycleDayNow(st, now){
  if (typeof st.cycleStart !== 'number') return Number(st.cycleDay) || 0;
  const s = new Date(st.cycleStart);
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(s.getFullYear(), s.getMonth(), s.getDate());
  return Math.round((a - b) / 86400000) + 1;
}

function reminderBody(id, st, now){
  const left = leftText(typeof st.cycleEnd === 'number' ? st.cycleEnd - now.getTime() : 0);
  if (id === 'evening') return 'Last call — ' + left + ' left before the penalty.';
  return cycleDayNow(st, now) <= 1
    ? 'A new cycle has begun — you have ' + QUEST_WINDOW_HOURS + 'h to complete it.'
    : 'Final day of the cycle — ' + left + ' left to complete it.';
}

async function swCheckReminders(){
  const cache = await caches.open(STATE_CACHE);
  const res = await cache.match(STATE_URL);
  if (!res) return;
  const st = await res.json();
  if (!st.enabled || !Array.isArray(st.slots)) return;

  const now = new Date(), today = dayKey(now), mins = now.getHours()*60 + now.getMinutes();
  if (st.sentDay !== today) { st.sent = {}; st.sentDay = today; }
  st.sent = st.sent || {};
  // Reminders only while the cycle is still open and the quest isn't done/frozen.
  const cycleOpen = typeof st.cycleEnd !== 'number' || now.getTime() < st.cycleEnd;
  const pending = cycleOpen && (st.today !== today || st.pending !== false);

  const icon = await notifIconUrl();
  const badge = await notifBadgeUrl();

  // The state may be older than today (app not opened): rebuild the last call from
  // the stored settings so it still fires on the final day.
  const slots = st.slots.slice();
  if (st.evening && st.eveningTime && !slots.some(x => x.id === 'evening') &&
      cycleDayNow(st, now) >= QUEST_WINDOW_HOURS / 24) {
    slots.push({ id: 'evening', time: st.eveningTime });
  }

  for (const slot of slots) {
    if (st.sent[slot.id]) continue;
    const late = mins - toMins(slot.time);
    if (late < 0 || late > REMINDER_GRACE_MIN) continue;
    st.sent[slot.id] = true;
    if (!pending) continue;
    // The last call belongs to the final day only; today's slots already reflect that.
    if (slot.id === 'evening' && cycleDayNow(st, now) < QUEST_WINDOW_HOURS / 24) continue;
    try {
      await self.registration.showNotification('Awakening Path', {
        body: reminderBody(slot.id, st, now), icon, badge, tag: 'daily-quest', renotify: true, data: { url: './' }
      });
    } catch (e) {}
  }
  await cache.put(STATE_URL, new Response(JSON.stringify(st), { headers: { 'Content-Type': 'application/json' } }));
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'daily-reminder') event.waitUntil(swCheckReminders());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow((event.notification.data && event.notification.data.url) || './');
  })());
});
