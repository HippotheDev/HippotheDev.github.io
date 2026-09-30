/* Awakening Path service worker
   1) Offline cache for the app shell, icons and fonts
   2) Daily quest reminders (notification click + background check where supported) */
const VERSION = 'v4';                       // bump this whenever you ship a new index.html
const SHELL_CACHE = 'awakening-shell-' + VERSION;
const STATE_CACHE = 'awakening-state';      // reminder state shared with the page (never deleted)
const STATE_URL = './__reminder-state.json';

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
    // add one by one so a missing file (e.g. fonts not added yet) doesn't abort the install
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

  // Page loads: network first (so updates arrive), cached copy when offline
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

  // Everything else (fonts, icons, manifest): cache first, refresh in the background
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    const refresh = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await refresh) || Response.error();
  })());
});

/* ---------- Reminders ---------- */
function dayKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function toMins(t){ const [h,m] = String(t||'0:0').split(':').map(Number); return (h||0)*60 + (m||0); }

async function swCheckReminders(){
  const cache = await caches.open(STATE_CACHE);
  const res = await cache.match(STATE_URL);
  if (!res) return;
  const st = await res.json();
  if (!st.enabled || !st.slots) return;

  const now = new Date(), today = dayKey(now), mins = now.getHours()*60 + now.getMinutes();
  if (st.sentDay !== today) { st.sent = {}; st.sentDay = today; }
  st.sent = st.sent || {};
  // if the page hasn't run today, it can't have been completed today
  const pending = st.today !== today || st.pending !== false;

  for (const slot of st.slots) {
    if (st.sent[slot.id]) continue;
    const late = mins - toMins(slot.time);
    if (late < 0 || late > 360) continue;          // only within 6h after the slot time
    st.sent[slot.id] = true;
    if (!pending) continue;
    const hoursLeft = Math.max(1, Math.ceil((24*60 - mins) / 60));
    const body = slot.id === 'evening'
      ? 'Daily quest still incomplete — about ' + hoursLeft + 'h left before the penalty.'
      : 'A new daily quest has been assigned. Failing to comply will result in a punishment.';
    try {
      await self.registration.showNotification('Awakening Path', {
        body, icon: 'icon-512.png', badge: 'icon-192.png', tag: 'daily-quest', data: { url: './' }
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
