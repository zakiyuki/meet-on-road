// 合流ナビ（サーバー不要版）— 位置共有と合流地点探索
(() => {
  'use strict';
  const COLORS = ['#e63946', '#3a86ff', '#2bb673', '#ff9f1c', '#9b5de5', '#111111'];
  const OVERPASS = 'https://overpass-api.de/api/interpreter';
  const OSRM = 'https://router.project-osrm.org';
  const $ = id => document.getElementById(id);
  const ls = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } }
  };

  // ---------- 状態 ----------
  const me = {
    clientId: ls.get('mor.clientId', null) || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)),
    name: ls.get('mor.name', ''),
    color: ls.get('mor.color', COLORS[0]),
    lat: null, lng: null, heading: null, speed: null, etaSec: null
  };
  ls.set('mor.clientId', me.clientId);
  const members = new Map();   // clientId -> member
  let meet = null, room = '', map, follow = true;
  const markers = new Map(), candLayer = L.layerGroup();
  let meetMarker = null, lastSent = 0, lastSentPos = null, prevPos = null;

  // ---------- ユーティリティ ----------
  const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  function dist(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function project(p, brg, m) {
    const d = m / R, b = rad(brg), la = rad(p.lat), lo = rad(p.lng);
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return { lat: deg(la2), lng: deg(lo2) };
  }
  const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const km = m => m >= 10000 ? `${Math.round(m / 1000)}km` : `${(m / 1000).toFixed(1)}km`;
  const mins = s => s == null ? '—' : s < 60 ? '1分未満' : s < 3600 ? `${Math.round(s / 60)}分` : `${Math.floor(s / 3600)}時間${Math.round(s % 3600 / 60)}分`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasPos = m => m && m.lat != null && m.lng != null;
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3000); }
  const randRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

  // ---------- 参加画面 ----------
  $('name').value = me.name;
  $('room').value = new URLSearchParams(location.search).get('room') || ls.get('mor.room', '') || randRoom();
  $('newRoom').onclick = () => $('room').value = randRoom();
  $('colors').innerHTML = COLORS.map(c => `<button type="button" data-c="${c}" style="background:${c}" class="${c === me.color ? 'sel' : ''}" aria-label="色 ${c}"></button>`).join('');
  $('colors').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    me.color = b.dataset.c;
    for (const x of $('colors').children) x.classList.toggle('sel', x === b);
  };
  $('joinForm').onsubmit = e => {
    e.preventDefault();
    me.name = $('name').value.trim();
    room = $('room').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (room.length < 6) return toast('ルームコードは6文字以上にしてください');
    ls.set('mor.name', me.name); ls.set('mor.color', me.color); ls.set('mor.room', room);
    history.replaceState(null, '', `?room=${room}`);
    start();
  };

  // ---------- 開始 ----------
  async function start() {
    $('join').hidden = true; $('app').hidden = false;
    $('roomLabel').textContent = room;
    map = L.map('map', { zoomControl: false }).setView([35.45, 139.4], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    candLayer.addTo(map);
    map.on('dragstart', () => setFollow(false));
    members.set(me.clientId, me);
    startGeo();
    keepAwake();
    await connect();
    render();
  }

  function setFollow(v) { follow = v; $('follow').classList.toggle('on', v); if (v && hasPos(me)) map.panTo([me.lat, me.lng]); }
  $('follow').onclick = () => setFollow(!follow);

  $('share').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${room}`;
    try {
      if (navigator.share) await navigator.share({ title: '合流ナビ', text: `ルーム ${room} で現在地を共有しよう`, url });
      else { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
    } catch { /* キャンセル */ }
  };

  // ---------- 画面スリープ防止 ----------
  let wakeLock = null;
  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); sendUpdate(true); }
  });

  // ---------- 位置情報 ----------
  function startGeo() {
    if (!navigator.geolocation) return toast('この端末は位置情報に対応していません');
    navigator.geolocation.watchPosition(onPos, err => {
      toast(err.code === 1 ? '位置情報の許可が必要です（設定から許可してください）' : '現在地を取得できません');
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function onPos(p) {
    const cur = { lat: p.coords.latitude, lng: p.coords.longitude };
    let heading = p.coords.heading, speed = p.coords.speed;
    if (prevPos) {
      const d = dist(prevPos, cur), dt = (p.timestamp - prevPos.t) / 1000;
      if ((heading == null || Number.isNaN(heading)) && d > 15) heading = bearing(prevPos, cur);
      if (speed == null && dt > 0) speed = d / dt;
    }
    if (!prevPos || dist(prevPos, cur) > 15) prevPos = { ...cur, t: p.timestamp };
    Object.assign(me, cur, { heading: heading ?? me.heading, speed });
    if (follow) map.panTo([me.lat, me.lng], { animate: true });
    if (!render.didFit) { map.setView([me.lat, me.lng], 12); render.didFit = true; }
    sendUpdate();
    render();
  }
  function sendUpdate(force) {
    if (!hasPos(me) || conn?.state !== 'Connected') return;
    const now = Date.now();
    const moved = lastSentPos ? dist(lastSentPos, me) : Infinity;
    if (!force && now - lastSent < 3000 && moved < 50) return;
    lastSent = now; lastSentPos = { lat: me.lat, lng: me.lng };
    conn.invoke('Update', me.lat, me.lng, me.heading, me.speed, me.etaSec).catch(() => { });
  }

  // ---------- 中継（公開MQTTブローカー経由・ルームコードで暗号化） ----------
  const BROKER = 'wss://broker.emqx.io:8084/mqtt';
  const enc = new TextEncoder(), dec = new TextDecoder();
  let base = '', aesKey = null, client = null;
  const b64 = u8 => btoa(String.fromCharCode(...u8));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKeys() {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('meetonroad-topic:' + room)));
    base = 'meetonroad/v1/' + [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
    const raw = await crypto.subtle.importKey('raw', enc.encode(room), 'PBKDF2', false, ['deriveKey']);
    aesKey = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('meetonroad-salt-v1'), iterations: 150000, hash: 'SHA-256' },
      raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64(out);
  }
  async function unseal(str) {
    const u = unb64(str);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, aesKey, u.slice(12))));
  }
  const myTopic = () => `${base}/m/${me.clientId}`;
  const myPayload = online => ({ clientId: me.clientId, name: me.name, color: me.color, lat: me.lat, lng: me.lng,
    heading: me.heading, speed: me.speed, etaSec: me.etaSec, online, updatedAt: new Date().toISOString() });
  const conn = {
    get state() { return client?.connected ? 'Connected' : 'Disconnected'; },
    async invoke(kind, ...a) {
      if (!client?.connected) throw new Error('offline');
      if (kind === 'Update') client.publish(myTopic(), await seal(myPayload(true)), { retain: true, qos: 0 });
      if (kind === 'SetMeet') {
        const p = a[0];
        client.publish(`${base}/meet`, p ? await seal(p) : '', { retain: true, qos: 1 });
      }
    }
  };
  async function connect() {
    await deriveKeys();
    const will = await seal({ clientId: me.clientId, online: false, updatedAt: new Date().toISOString() });
    client = mqtt.connect(BROKER, {
      clientId: 'mor_' + me.clientId.slice(0, 18), clean: true, reconnectPeriod: 3000, keepalive: 30,
      will: { topic: myTopic(), payload: will, retain: true, qos: 0 }
    });
    client.on('connect', () => {
      setConn(true);
      client.subscribe(`${base}/#`, { qos: 1 });
      sendUpdate(true);
    });
    client.on('reconnect', () => setConn(false));
    client.on('offline', () => setConn(false));
    client.on('error', () => setConn(false));
    client.on('message', async (topic, payload, packet) => {
      const str = payload.toString();
      try {
        if (topic === `${base}/meet`) {
          setMeet(str ? await unseal(str) : null, !packet.retain);
        } else if (topic.startsWith(`${base}/m/`)) {
          const id = topic.slice(base.length + 3);
          if (id === me.clientId) return;
          if (!str) { members.delete(id); markers.get(id)?.remove(); markers.delete(id); render(); return; }
          const x = await unseal(str);
          members.set(id, { ...(members.get(id) || {}), ...Object.fromEntries(Object.entries(x).filter(([, v]) => v != null)) });
          render();
        }
      } catch { /* 復号できない＝別ルームの同一トピック等は無視 */ }
    });
    addEventListener('pagehide', async () => {
      try { client.publish(myTopic(), await seal(myPayload(false)), { retain: true }); } catch { }
    });
  }
  function setConn(ok) { $('conn').classList.toggle('off', !ok); }

  // ---------- 合流地点 ----------
  function setMeet(m, notify) {
    meet = m;
    if (meetMarker) { map.removeLayer(meetMarker); meetMarker = null; }
    if (meet) {
      meetMarker = L.marker([meet.lat, meet.lng], { icon: L.divIcon({ className: '', html: '<div class="star">★</div>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 })
        .addTo(map).bindTooltip(esc(meet.name));
      if (notify) toast(`${meet.setBy}さんが合流地点を「${meet.name}」に設定しました`);
      updateMyEta();
    } else {
      me.etaSec = null;
      if (notify) toast('合流地点が解除されました');
    }
    render();
  }
  $('clearMeet').onclick = () => conn.invoke('SetMeet', null);

  // 自分の到着予想時間（45秒ごと）
  let etaBusy = false;
  async function updateMyEta() {
    if (!meet || !hasPos(me) || etaBusy) return;
    etaBusy = true;
    try {
      const r = await fetch(`${OSRM}/route/v1/driving/${me.lng},${me.lat};${meet.lng},${meet.lat}?overview=false`);
      const j = await r.json();
      if (j.code === 'Ok') me.etaSec = j.routes[0].duration;
    } catch {
      me.etaSec = dist(me, meet) / (60 / 3.6); // 時速60km換算
    } finally { etaBusy = false; }
    sendUpdate(true); render();
  }
  setInterval(updateMyEta, 45000);

  // ---------- 合流候補の探索 ----------
  function kindOf(tags) {
    const n = (tags.name || '') + (tags['name:ja'] || '');
    if (tags.shop === 'convenience') return 'コンビニ';
    if (/道の駅/.test(n) || tags.roadside_station) return '道の駅';
    if (tags.highway === 'services' || /サービスエリア|ＳＡ|SA\b/.test(n)) return 'SA';
    if (tags.highway === 'rest_area') return 'PA';
    return null;
  }

  $('search').onclick = findMeetingPoints;
  async function findMeetingPoints() {
    const ppl = [...members.values()].filter(hasPos);
    if (!ppl.length) return toast('現在地がまだ取得できていません');
    const kinds = [...document.querySelectorAll('.filters input:checked')].map(i => i.value);
    if (!kinds.length) return toast('種類を1つ以上選んでください');
    const st = $('status'), btn = $('search');
    btn.disabled = true; st.textContent = '周辺のSA・PA・コンビニを検索中…';
    candLayer.clearLayers(); $('cands').innerHTML = '';

    try {
      // 10分後の予測位置（進行方向に最大20km）の重心を探索の中心にする
      const pred = ppl.map(p => (p.speed > 3 && p.heading != null) ? project(p, p.heading, Math.min(p.speed * 600, 20000)) : p);
      const center = { lat: pred.reduce((s, p) => s + p.lat, 0) / pred.length, lng: pred.reduce((s, p) => s + p.lng, 0) / pred.length };
      const spread = Math.max(...pred.map(p => dist(center, p)), ...ppl.map(p => dist(center, p)));
      const radius = Math.round(Math.min(Math.max(spread * 1.3, 8000), 45000));
      const cvsRadius = Math.round(Math.min(radius, 6000));

      const q = [];
      if (kinds.some(k => k !== 'コンビニ')) q.push(`nwr["highway"~"^(services|rest_area)$"](around:${radius},${center.lat},${center.lng});`);
      if (kinds.includes('コンビニ')) q.push(`nwr["shop"="convenience"](around:${cvsRadius},${center.lat},${center.lng});`);
      const body = `[out:json][timeout:25];(${q.join('')});out center tags 400;`;
      const r = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(body), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('overpass ' + r.status);
      const j = await r.json();

      // 候補の整形と重複除去
      const seen = new Set();
      let cands = j.elements.map(e => {
        const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon, t = e.tags || {};
        const kind = kindOf(t);
        return { name: t['name:ja'] || t.name || (t.brand ? t.brand : kind), brand: t.brand || '', kind, lat, lng };
      }).filter(c => c.lat != null && c.kind && kinds.includes(c.kind) && (c.kind === 'コンビニ' || c.name))
        .filter(c => { const k = c.name + Math.round(c.lat * 500) + Math.round(c.lng * 500); if (seen.has(k)) return false; seen.add(k); return true; });

      if (!cands.length) { st.textContent = '候補が見つかりませんでした。種類を増やすか、少し走ってから再検索してください'; return; }

      // 一次評価：直線距離（進行方向の後ろにある候補は不利に）
      for (const c of cands) {
        const ds = ppl.map(p => {
          let d = dist(p, c);
          if (p.speed > 3 && p.heading != null && d > 1500 && angDiff(p.heading, bearing(p, c)) > 100) d *= 1.8;
          return d;
        });
        c.rough = Math.max(...ds) + 0.3 * (Math.max(...ds) - Math.min(...ds));
      }
      cands.sort((a, b) => a.rough - b.rough);
      cands = cands.slice(0, 12);

      // 二次評価：OSRMで全員からの所要時間を取得
      st.textContent = '到着時間を計算中…';
      let routed = false;
      try {
        const coords = [...ppl, ...cands].map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
        const src = ppl.map((_, i) => i).join(';'), dst = cands.map((_, i) => i + ppl.length).join(';');
        const tr = await fetch(`${OSRM}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration,distance`);
        const tj = await tr.json();
        if (tj.code === 'Ok') {
          cands.forEach((c, ci) => {
            c.etas = ppl.map((_, pi) => tj.durations[pi][ci]);
            c.dists = ppl.map((_, pi) => tj.distances?.[pi]?.[ci]);
          });
          routed = true;
        }
      } catch { /* 直線距離で代用 */ }
      if (!routed) cands.forEach(c => { c.etas = ppl.map(p => dist(p, c) / (60 / 3.6)); c.dists = ppl.map(p => dist(p, c)); });

      cands = cands.filter(c => c.etas.every(v => v != null));
      for (const c of cands) {
        const mx = Math.max(...c.etas), mn = Math.min(...c.etas);
        c.score = mx + 0.4 * (mx - mn);  // 遅い方の到着＋待ち時間の差
        c.wait = mx - mn;
      }
      cands.sort((a, b) => a.score - b.score);
      cands = cands.slice(0, 6);
      renderCands(cands, ppl);
      st.textContent = routed ? '道路経由の所要時間で並べています（遅く着く人が早い順）' : '道路の所要時間を取得できず、直線距離から概算しています';
      const b = L.latLngBounds([...ppl, ...cands].map(p => [p.lat, p.lng]));
      setFollow(false); map.fitBounds(b, { padding: [40, 40] });
    } catch (e) {
      console.error(e);
      st.textContent = '検索に失敗しました。通信状況を確認してもう一度お試しください';
    } finally { btn.disabled = false; }
  }

  function renderCands(cands, ppl) {
    candLayer.clearLayers();
    $('cands').innerHTML = cands.map((c, i) => `
      <li>
        <div class="body">
          <div class="t"><span class="tag ${c.kind}">${c.kind}</span>${esc(c.name)}</div>
          <div class="s">${ppl.map((p, pi) => `${esc(p.name || 'ゲスト')} ${mins(c.etas[pi])}`).join(' ／ ')}${c.wait > 120 ? `・待ち約${mins(c.wait)}` : ''}</div>
        </div>
        <button class="sub" data-i="${i}">ここで合流</button>
      </li>`).join('');
    $('cands').onclick = e => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      const c = cands[+b.dataset.i];
      conn.invoke('SetMeet', { name: c.name, kind: c.kind, lat: c.lat, lng: c.lng, setBy: me.name || 'ゲスト' })
        .then(() => { $('cands').innerHTML = ''; candLayer.clearLayers(); $('status').textContent = ''; })
        .catch(() => toast('設定に失敗しました'));
    };
    cands.forEach((c, i) => L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: '', html: `<div class="cpin ${c.kind}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] })
    }).bindTooltip(`${i + 1}. ${esc(c.name)}`, { permanent: i < 3, direction: 'top' }).addTo(candLayer));
  }

  // ---------- 描画 ----------
  function render() {
    // マーカー
    for (const [id, m] of members) {
      if (!hasPos(m)) continue;
      const off = isOff(m, id);
      const arrow = m.heading != null && m.speed > 2 ? `<div class="a" style="color:${m.color};transform:rotate(${m.heading}deg)"></div>` : '';
      const html = `<div class="pin ${off ? 'off' : ''}">${arrow}<div class="c" style="background:${m.color}"></div><div class="l">${esc(m.name || 'ゲスト')}${id === me.clientId ? '（自分）' : ''}</div></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [22, 22], iconAnchor: [11, 11] });
      let mk = markers.get(id);
      if (!mk) { mk = L.marker([m.lat, m.lng], { icon }).addTo(map); markers.set(id, mk); }
      else { mk.setLatLng([m.lat, m.lng]); mk.setIcon(icon); }
    }
    // メンバー一覧
    const list = [...members.values()].sort((a, b) => (a.clientId === me.clientId ? -1 : b.clientId === me.clientId ? 1 : 0));
    $('members').innerHTML = list.map(m => {
      const self = m.clientId === me.clientId;
      const off = isOff(m, m.clientId);
      let inf = off ? `オフライン・${ago(m.updatedAt)}` : !hasPos(m) ? '位置取得待ち' : '';
      if (hasPos(m) && !off) {
        const sp = m.speed != null ? `${Math.round(m.speed * 3.6)}km/h` : '';
        inf = meet ? `${km(dist(m, meet))}・到着 ${mins(m.etaSec)}` : (self ? sp : `${km(dist(me.lat != null ? me : m, m))}先・${sp}`);
      }
      return `<li><span class="sw" style="background:${m.color}"></span><span class="nm">${esc(m.name || 'ゲスト')}${self ? '（自分）' : ''}</span><span class="inf">${inf}</span></li>`;
    }).join('');
    // 合流地点
    $('meetBox').hidden = !meet;
    if (meet) {
      $('meetKind').textContent = meet.kind; $('meetKind').className = `tag ${meet.kind}`;
      $('meetName').textContent = meet.name;
      $('navLink').href = `https://www.google.com/maps/dir/?api=1&destination=${meet.lat},${meet.lng}&travelmode=driving`;
      const etas = [...members.values()].filter(m => m.etaSec != null && !isOff(m, m.clientId)).map(m => `${m.name || 'ゲスト'} ${mins(m.etaSec)}`);
      $('meetEta').textContent = etas.length ? `到着予想: ${etas.join(' ／ ')}` : `${meet.setBy}さんが設定`;
    }
  }
  function isOff(m, id) {
    if (id === me.clientId) return false;
    return m.online === false || (m.updatedAt && Date.now() - new Date(m.updatedAt).getTime() > 180000);
  }
  function ago(t) {
    const s = (Date.now() - new Date(t).getTime()) / 1000;
    return s < 60 ? 'たった今' : s < 3600 ? `${Math.round(s / 60)}分前` : `${Math.round(s / 3600)}時間前`;
  }
  setInterval(() => { if (!$('app').hidden) render(); }, 15000);
})();
