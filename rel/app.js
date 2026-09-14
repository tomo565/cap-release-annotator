'use strict';
/* リリース選択 → リリース-3〜+10 の14コマに蓋の中心を打つ。

   守っていること:
   ・自動推定のリリースも、既存のリリース値も、画面に一切出さない。
   ・表示範囲の中心はリリースからずらしてあり、真ん中＝リリースにならない。
   ・表示範囲は前後へ広げられる。24コマの中から必ず選ぶ作りにしない。
   ・保存形式はスマホとタブレットで同じ。途中で端末を変えても続けられる。 */

const $ = s => document.querySelector(s);
const APP_VER = '3';   // ?set= で入力セットを切り替える版
// 入力セットは URL で選ぶ。既定は relcheck（これまでの URL の挙動を変えない）。
const SET_PARAM = (new URLSearchParams(location.search).get('set') || 'relcheck');
const TASK_FILE = SET_PARAM === 'relcheck' ? 'data/tasks.json' : ('data/tasks_' + SET_PARAM + '.json');
const LS = {cfg: 'relui.cfg', who: 'relui.who', mode: 'relui.mode',
            rel: 'relui.rel', pos: 'relui.pos', q: 'relui.queue'};
const TEST_VIDS = ['184258', '184307', '184442', '184917', '184956', '185159', '185349', '185402',
                   '154622', '154629', '154640', '154649', '154711', '154804', '154815', '154849',
                   '160931', '161044', '161103'];
const VIS = ['見える', '一部隠れ', '完全に隠れ'];
const RULE_REL = 'リリース＝<b>手からキャップが離れた瞬間のコマ</b>を選ぶ';
const RULE_POS = '蓋の<b>中心</b>を打つ。ブラーで細長いときは<b>長軸も含めた幾何学的な中央</b>。'
               + '先端や後端は打たない。一部隠れは全体の中心が推定できるときだけ。完全に隠れは位置を打たない';

let D = null, vi = 0, fi = 0, phase = 'rel', page = 0, pick = null,
    cfg = null, who = '', mode = 'mobile', expanded = false, t0 = 0,
    REL = {}, POS = {}, imgs = new Map(), zoomDrag = null,
    relZoom = 1, relOnly = false;   // relZoom 1/2/4 倍、relOnly はスマホで1コマだけ大きく見る

const st = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const task = () => D.tasks[vi];
const SET = () => D.set;
const relOf = v => REL[v] ? REL[v].release_frame_human : null;
const win = () => {
  const r = relOf(task().video_id);
  return r === null ? [] : Array.from({length: D.pre + D.post + 1}, (_, i) => r - D.pre + i);
};
const posKey = (v, f) => v + '#' + f;

function api(path, opt) {
  return fetch(cfg.url.replace(/\/+$/, '') + '/rest/v1/' + path, Object.assign({}, opt, {
    headers: Object.assign({apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey,
                            'Content-Type': 'application/json'}, (opt || {}).headers || {})
  }));
}

// ---------- 保存 ----------
function queuePush(kind, row) {
  const q = st.get(LS.q, []);
  const same = q.findIndex(x => x.kind === kind && x.key === row.__key);
  const item = {kind, key: row.__key, row};
  if (same >= 0) q[same] = item; else q.push(item);
  st.set(LS.q, q);
  flush();
}
let syncing = false, lastOk = false;
async function flush() {
  if (syncing || !cfg) return;
  const q = st.get(LS.q, []);
  if (!q.length) { net(lastOk ? 'ok' : 'offline', 0); return; }
  syncing = true; net('sending', q.length);
  try {
    const rel = q.filter(x => x.kind === 'rel').map(x => relRow(x.row));
    // 他 set の行は送らない（念のため）
    const pos = q.filter(x => x.kind === 'pos' && x.row.set_name === SET()).map(x => posRow(x.row));
    if (rel.length) {
      const r = await api('cap_release_marks?on_conflict=video_id,set_name',
        {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'},
         body: JSON.stringify(rel)});
      if (!r.ok) throw new Error('HTTP ' + r.status + ' リリース: ' + (await r.text()).slice(0, 160));
    }
    if (pos.length) {
      const r = await api('cap_release_positions?on_conflict=video_id,set_name,frame_index',
        {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'},
         body: JSON.stringify(pos)});
      if (!r.ok) throw new Error('HTTP ' + r.status + ' 位置: ' + (await r.text()).slice(0, 160));
    }
    const rest = st.get(LS.q, []).filter(x => !(x.kind === 'pos' && x.row.set_name !== SET()))
                                 .filter(x => !q.some(y => y.kind === x.kind && y.key === x.key
                                                     && y.row.updated_at === x.row.updated_at));
    st.set(LS.q, rest);
    lastOk = true; net(rest.length ? 'queued' : 'ok', rest.length);
  } catch (e) {
    lastOk = false;
    const m = String(e.message || e);
    net(m.startsWith('HTTP') ? 'error' : 'offline', q.length, m);
  } finally { syncing = false; render(); }
}
// 送る列を決め打ちにする。読み込んだ行の id や created_at を送ると、Supabase が送信全体を拒否する。
// 全行が同じ列を持たないと一括送信も拒否されるので、無い列には既定値を入れる。
function relRow(r) {
  return {video_id: r.video_id, set_name: r.set_name,
          release_frame_human: r.release_frame_human,
          release_confirmed_by_human: r.release_confirmed_by_human === true,
          expanded: r.expanded === true,
          seconds_spent: (r.seconds_spent === undefined ? null : r.seconds_spent),
          ui_mode: r.ui_mode || null, annotator: r.annotator || null};
}
function posRow(r) {
  const occ = r.visibility === '完全に隠れ';
  return {video_id: r.video_id, set_name: r.set_name, frame_index: r.frame_index,
          release_offset: r.release_offset,
          x: occ ? null : (r.x === undefined ? null : r.x),
          y: occ ? null : (r.y === undefined ? null : r.y),
          bbox_w: (r.bbox_w === undefined ? null : r.bbox_w),
          bbox_h: (r.bbox_h === undefined ? null : r.bbox_h),
          visibility: r.visibility || '見える',
          confirmed_by_human: r.confirmed_by_human === true,
          annotator: r.annotator || null};
}
function net(s, n, msg) {
  const e = $('#net'); e.className = '';
  if (s === 'ok') e.textContent = '同期済み';
  else if (s === 'sending') e.textContent = '送信中…';
  else if (s === 'queued') { e.className = 'q'; e.textContent = '未送信 ' + n + ' 件'; }
  else if (s === 'error') { e.className = 'bad';
    e.textContent = '★保存エラー 未送信 ' + n + ' 件（端末に保存済み） ' + (msg || '').slice(0, 90); }
  else { e.className = 'bad'; e.textContent = n ? ('通信不可 未送信 ' + n + ' 件（端末に保存済み）')
                                               : '通信不可（端末に保存済み）'; }
  if (msg) e.title = msg;
}
async function pull() {
  if (!cfg) return;
  try {
    net('sending');
    const r1 = await api('cap_release_marks?select=*&set_name=eq.' + encodeURIComponent(SET()) + '&limit=2000');
    if (r1.ok) for (const row of await r1.json()) {
      const l = REL[row.video_id];
      if (!l || !l.updated_at || (row.updated_at && row.updated_at >= l.updated_at)) REL[row.video_id] = row;
    }
    const r2 = await api('cap_release_positions?select=*&set_name=eq.' + encodeURIComponent(SET()) + '&limit=5000');
    if (r2.ok) for (const row of await r2.json()) {
      const k = posKey(row.video_id, row.frame_index), l = POS[k];
      if (!l || !l.updated_at || (row.updated_at && row.updated_at >= l.updated_at)) POS[k] = row;
    }
    st.set(LS.rel, REL); st.set(LS.pos, POS);
    lastOk = true; net(st.get(LS.q, []).length ? 'queued' : 'ok');
  } catch (e) { lastOk = false; net('offline', st.get(LS.q, []).length, String(e.message || e)); }
}

// ---------- 画像 ----------
function img(name, dir) {
  const k = dir + name;
  if (imgs.has(k)) return imgs.get(k);
  const im = new Image(); im.src = dir + '/' + name; imgs.set(k, im);
  im.onload = () => { if (phase === 'pos') draw(); };
  return im;
}
const frameRec = f => task().frames.find(x => x.f === f);

// ---------- リリース選択 ----------
function relPageFrames() {
  const fs = task().frames;
  const per = D.page;
  const st0 = Math.max(0, Math.min(fs.length - per, page * 12));
  return fs.slice(st0, st0 + per);
}
function drawRelBig() {
  // 選んだコマを大きく出す。答えの印は一切描かない。コマ番号だけ。
  const c = $('#main'), g = c.getContext('2d');
  const fr = pick === null ? relPageFrames()[0] : frameRec(pick);
  const v = fitCanvas(c, D.crop / relZoom, D.crop / relZoom);
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  if (!fr) return;
  const im = img(fr.img, 'img');
  const k = D.crop / relZoom, o = (D.crop - k) / 2;
  if (im.complete && im.naturalWidth)
    g.drawImage(im, o, o, k, k, v.ox, v.oy, k * v.s, k * v.s);
  $('#maintag').textContent = 'コマ ' + fr.f + '　' + relZoom + '倍（押すと拡大）';
}

function drawRelGrid() {
  const g = $('#grid');
  g.style.display = (mode === 'mobile' && relOnly) ? 'none' : '';
  $('#mainwrap').style.display = '';
  $('#zoomwrap').style.display = 'none';
  $('#left').style.display = 'none';
  g.innerHTML = '';
  for (const fr of relPageFrames()) {
    const d = document.createElement('div');
    d.className = 'cell' + (pick === fr.f ? ' sel' : '');
    const im = document.createElement('img');
    im.src = 'img/' + fr.img; im.loading = 'lazy';
    const s = document.createElement('span'); s.textContent = fr.f;   // コマ番号だけ
    d.append(im, s);
    d.onclick = () => { pick = fr.f; render(); };
    g.append(d);
  }
  drawRelBig();
}

// ---------- 位置入力 ----------
function fitCanvas(c, natW, natH) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
  const s = Math.min(c.width / natW, c.height / natH);
  return {s, ox: (c.width - natW * s) / 2, oy: (c.height - natH * s) / 2, dpr};
}
const curFrame = () => win()[fi];
const curRec = () => frameRec(curFrame());
const curPos = () => POS[posKey(task().video_id, curFrame())] || null;
const toCrop = p => { const r = curRec(); return {x: p.x - r.ox, y: p.y - r.oy}; };
const toFull = p => { const r = curRec(); return {x: p.x + r.ox, y: p.y + r.oy}; };

function drawMain() {
  const c = $('#main'), g = c.getContext('2d'), r = curRec();
  if (!r) return;
  const v = fitCanvas(c, D.crop, D.crop);
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  const im = img(r.img, 'img');
  if (im.complete && im.naturalWidth) g.drawImage(im, v.ox, v.oy, D.crop * v.s, D.crop * v.s);
  c._v = v;
  const p = curPos();
  if (p && p.x != null) {
    const q = toCrop(p), x = v.ox + q.x * v.s, y = v.oy + q.y * v.s, L = 16 * v.dpr, G = 5 * v.dpr;
    g.strokeStyle = p.confirmed_by_human ? '#34a853' : '#fbbc04'; g.lineWidth = 2 * v.dpr;
    g.beginPath();
    g.moveTo(x - L, y); g.lineTo(x - G, y); g.moveTo(x + G, y); g.lineTo(x + L, y);
    g.moveTo(x, y - L); g.lineTo(x, y - G); g.moveTo(x, y + G); g.lineTo(x, y + L);
    g.stroke();
  }
  drawZoom();
}
function drawZoom() {
  const c = $('#zoom'), g = c.getContext('2d'), Z = 8, r = curRec();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
  g.imageSmoothingEnabled = false; g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  if (!r) return;
  const p = curPos();
  const cp = (p && p.x != null) ? toCrop(p) : {x: D.crop / 2, y: D.crop / 2};
  const im = img(r.img, 'img');
  const sx = c.width / (Z * dpr), sy = c.height / (Z * dpr);
  if (im.complete && im.naturalWidth)
    g.drawImage(im, cp.x - sx / 2, cp.y - sy / 2, sx, sy, 0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(c.width / 2, 0); g.lineTo(c.width / 2, c.height);
  g.moveTo(0, c.height / 2); g.lineTo(c.width, c.height / 2); g.stroke();
  if (p && p.x != null) {
    g.strokeStyle = p.confirmed_by_human ? '#34a853' : '#fbbc04'; g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(c.width / 2, c.height / 2, 8 * dpr, 0, 7); g.stroke();
  }
  c._Z = Z * dpr;
}
function draw() { if (phase === 'pos') drawMain(); }

function drawLeft() {
  const L = $('#left');
  if (mode !== 'tablet' || phase !== 'pos') { L.style.display = 'none'; return; }
  L.style.display = ''; L.innerHTML = '';
  win().forEach((f, i) => {
    const r = frameRec(f); if (!r) return;
    const p = POS[posKey(task().video_id, f)];
    const d = document.createElement('div');
    d.className = 'thumb' + (i === fi ? ' cur' : '') + (p ? (p.confirmed_by_human ? ' done' : ' draft') : '');
    const im = document.createElement('img'); im.src = 'img/' + r.img; im.loading = 'lazy';
    const s = document.createElement('span');
    const off = i - D.pre; s.textContent = (off >= 0 ? '+' : '') + off;
    d.append(im, s);
    d.onclick = () => { fi = i; render(); };
    L.append(d);
  });
}

// ---------- 保存の中身 ----------
function saveRel(frame, confirmed) {
  const v = task().video_id, now = new Date().toISOString();
  const row = {video_id: v, set_name: SET(), release_frame_human: frame,
               release_confirmed_by_human: confirmed, expanded: expanded,
               seconds_spent: Math.round((Date.now() - t0) / 1000), ui_mode: mode,
               annotator: who, updated_at: now, __key: v + '|' + SET()};
  REL[v] = row; st.set(LS.rel, REL); queuePush('rel', row);
}
function savePos(o) {
  const v = task().video_id, f = curFrame(), now = new Date().toISOString();
  const base = POS[posKey(v, f)] || {video_id: v, frame_index: f,
                                     release_offset: fi - D.pre, x: null, y: null,
                                     bbox_w: null, bbox_h: null, visibility: '見える',
                                     confirmed_by_human: false};
  const row = Object.assign({}, base, o, {release_offset: fi - D.pre, set_name: SET(),
                                          annotator: who, updated_at: now,
                                          __key: v + '|' + f});
  // 完全に隠れ は座標を無効化する。既存の truth_release と同じ意味にする。
  if (row.visibility === '完全に隠れ') { row.x = null; row.y = null; }
  if ('x' in o && o.x !== null && !isFinite(o.x)) return;
  POS[posKey(v, f)] = row; st.set(LS.pos, POS); queuePush('pos', row);
  render();
}

// ---------- 表示 ----------
function render() {
  const t = task();
  $('#vid').textContent = t.video_id;
  $('#phase').textContent = phase === 'rel' ? '① リリースを選ぶ' : '② 蓋の中心を打つ';
  $('#rule').innerHTML = phase === 'rel' ? RULE_REL : RULE_POS;
  document.body.className = mode;

  $('#visrow').style.display = phase === 'pos' ? '' : 'none';
  $('#actrow').style.display = phase === 'pos' ? '' : 'none';
  $('#relrow').style.display = phase === 'rel' ? '' : 'none';

  if (phase === 'rel') {
    document.body.classList.add('relphase');
    drawRelGrid();
    const fs = task().frames;
    $('#info').textContent = 'コマ ' + relPageFrames()[0].f + '〜'
      + relPageFrames()[relPageFrames().length - 1].f + '（全 ' + fs.length + ' コマ）';
    $('#relgo').disabled = pick === null;
    $('#relgo').textContent = pick === null ? 'コマを選ぶ' : 'コマ ' + pick + ' で確定';
    $('#back12').disabled = page <= 0;
    $('#fwd12').disabled = (page + 1) * 12 + D.page > fs.length + 11;
  } else {
    document.body.classList.remove('relphase');
    $('#grid').style.display = 'none';
    $('#mainwrap').style.display = ''; $('#zoomwrap').style.display = '';
    const off = fi - D.pre;
    $('#info').textContent = 'コマ ' + curFrame() + '（リリース' + (off >= 0 ? '+' : '') + off + '）';
    $('#maintag').textContent = '原寸 / タップで蓋の中心';
    const p = curPos();
    $('#go').disabled = !(p && (p.x != null || p.visibility === '完全に隠れ'));
    document.querySelectorAll('#visrow button').forEach(b =>
      b.classList.toggle('on', !!p && p.visibility === b.dataset.v));
    drawLeft(); drawMain();
  }

  const w = win();
  const done = w.filter(f => (POS[posKey(t.video_id, f)] || {}).confirmed_by_human).length;
  const tot = D.tasks.length * (D.pre + D.post + 1);
  const all = D.tasks.reduce((a, x) => {
    const r = REL[x.video_id] ? REL[x.video_id].release_frame_human : null;
    if (r === null) return a;
    let n = 0;
    for (let i = -D.pre; i <= D.post; i++)
      if ((POS[posKey(x.video_id, r + i)] || {}).confirmed_by_human) n++;
    return a + n;
  }, 0);
  $('#total').textContent = w.length ? ('この投球 ' + done + '/' + w.length + '　全体 ' + all + '/' + tot)
                                     : ('全体 ' + all + '/' + tot);
  $('#bar').style.width = (all / tot * 100) + '%';
  $('#who2').textContent = who;

  const fw = $('#films'); fw.innerHTML = '';
  if (phase === 'pos') w.forEach((f, i) => {
    const d = document.createElement('div');
    const p = POS[posKey(t.video_id, f)];
    d.className = 'fr' + (i === fi ? ' cur' : '') + (p ? (p.confirmed_by_human ? ' done' : ' draft') : '');
    const off = i - D.pre; d.textContent = (off >= 0 ? '+' : '') + off;
    d.onclick = () => { fi = i; render(); };
    fw.append(d);
  });
  const cur = fw.querySelector('.cur'); if (cur) cur.scrollIntoView({block: 'nearest', inline: 'center'});

  const vw = $('#vids'); vw.innerHTML = '';
  D.tasks.forEach((x, i) => {
    const r = REL[x.video_id] ? REL[x.video_id].release_frame_human : null;
    let n = 0;
    if (r !== null) for (let k = -D.pre; k <= D.post; k++)
      if ((POS[posKey(x.video_id, r + k)] || {}).confirmed_by_human) n++;
    const d = document.createElement('div');
    const full = D.pre + D.post + 1;
    d.className = 'vd' + (i === vi ? ' cur' : '') + (r !== null && n === full ? ' done' : ((r !== null || n) ? ' part' : ''));
    d.textContent = x.vid + (r === null ? ' 未' : ' ' + n + '/' + full);
    d.onclick = () => { vi = i; startVideo(); };
    vw.append(d);
  });
  const cv = vw.querySelector('.cur'); if (cv) cv.scrollIntoView({block: 'nearest', inline: 'center'});
}

function startVideo() {
  const v = task().video_id;
  expanded = false; page = 0; pick = null; t0 = Date.now();
  task().frames.forEach(f => img(f.img, 'img'));
  if (relOf(v) === null) { phase = 'rel'; }
  else {
    phase = 'pos';
    const w = win();
    let k = w.findIndex(f => !(POS[posKey(v, f)] || {}).confirmed_by_human);
    fi = k < 0 ? 0 : k;
  }
  render();
}
function nextVideo() {
  if (vi + 1 < D.tasks.length) { vi++; startVideo(); }
  else render();
}

// ---------- 操作 ----------
$('#relgo').onclick = () => {
  if (pick === null) return;
  saveRel(pick, true);
  phase = 'pos'; fi = 0; render();
};
$('#maintag').onclick = () => {
  if (phase === 'rel') { relZoom = relZoom >= 4 ? 1 : relZoom * 2; render(); }
};
$('#mBig') && ($('#mBig').onclick = () => { relOnly = !relOnly; $('#menuDlg').close(); render(); });
$('#back12').onclick = () => { page = Math.max(0, page - 1); expanded = true; render(); };
$('#fwd12').onclick = () => { page = page + 1; expanded = true; render(); };

$('#main').addEventListener('pointerdown', e => {
  if (phase !== 'pos') return;
  const c = $('#main'), v = c._v, rect = c.getBoundingClientRect();
  const px = (e.clientX - rect.left) * v.dpr, py = (e.clientY - rect.top) * v.dpr;
  const ix = (px - v.ox) / v.s, iy = (py - v.oy) / v.s;
  if (!isFinite(ix) || !isFinite(iy) || ix < 0 || iy < 0 || ix > D.crop || iy > D.crop) return;
  const f = toFull({x: ix, y: iy});
  savePos({x: +f.x.toFixed(1), y: +f.y.toFixed(1), confirmed_by_human: false});
});
$('#zoom').addEventListener('pointerdown', e => {
  const p = curPos(); if (!p || p.x == null) return;
  zoomDrag = {sx: e.clientX, sy: e.clientY, x: p.x, y: p.y};
  $('#zoom').setPointerCapture(e.pointerId);
});
$('#zoom').addEventListener('pointermove', e => {
  if (!zoomDrag) return;
  const c = $('#zoom'), dpr = Math.min(devicePixelRatio || 1, 2), k = c._Z / dpr;
  savePos({x: +(zoomDrag.x - (e.clientX - zoomDrag.sx) / k).toFixed(2),
           y: +(zoomDrag.y - (e.clientY - zoomDrag.sy) / k).toFixed(2),
           confirmed_by_human: false});
  e.preventDefault();
});
addEventListener('pointerup', () => { zoomDrag = null; });
document.querySelectorAll('#nudge button[data-d]').forEach(b => b.onclick = () => {
  const p = curPos(); if (!p || p.x == null) return;
  const d = b.dataset.d.split(',').map(Number);
  savePos({x: +(p.x + d[0]).toFixed(2), y: +(p.y + d[1]).toFixed(2), confirmed_by_human: false});
});
document.querySelectorAll('#visrow button').forEach(b => b.onclick = () => setVis(b.dataset.v));
function setVis(v) {
  const p = curPos();
  if (v === '完全に隠れ') savePos({visibility: v, x: null, y: null, confirmed_by_human: false});
  else if (p) savePos({visibility: v});
  else savePos({visibility: v, confirmed_by_human: false});
}
$('#go').onclick = () => {
  savePos({confirmed_by_human: true});
  const w = win();
  if (fi + 1 < w.length) { fi++; render(); }
  else nextVideo();
};
$('#skip').onclick = () => { const w = win(); if (fi + 1 < w.length) { fi++; render(); } else nextVideo(); };
$('#prev').onclick = () => { if (fi > 0) { fi--; render(); } };
$('#undo').onclick = () => {
  savePos({x: null, y: null, visibility: '見える', confirmed_by_human: false});
};

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key;
  if (phase === 'pos') {
    if (k === 'ArrowRight') { $('#skip').click(); e.preventDefault(); }
    else if (k === 'ArrowLeft') { $('#prev').click(); e.preventDefault(); }
    else if (k === 'Enter') { if (!$('#go').disabled) $('#go').click(); }
    else if (k === 'v' || k === 'V') setVis('見える');
    else if (k === 'p' || k === 'P') setVis('一部隠れ');
    else if (k === 'o' || k === 'O') setVis('完全に隠れ');
    else if (k === 'z' || k === 'Z') $('#undo').click();
  } else {
    const fs = relPageFrames();
    if (k === 'ArrowRight') { const i = fs.findIndex(x => x.f === pick); pick = fs[Math.min(fs.length - 1, Math.max(0, i) + 1)].f; render(); e.preventDefault(); }
    else if (k === 'ArrowLeft') { const i = fs.findIndex(x => x.f === pick); pick = fs[Math.max(0, i - 1)].f; render(); e.preventDefault(); }
    else if (k === 'z' || k === 'Z') { relZoom = relZoom >= 4 ? 1 : relZoom * 2; render(); }
    else if (k === 'Enter') { if (!$('#relgo').disabled) $('#relgo').click(); }
  }
});
addEventListener('resize', () => { if (!st.get(LS.mode, null)) autoMode(); render(); });
addEventListener('online', flush);
setInterval(flush, 20000);

function autoMode() { mode = innerWidth >= 700 ? 'tablet' : 'mobile'; }
$('#mMode').onclick = () => { mode = mode === 'tablet' ? 'mobile' : 'tablet'; st.set(LS.mode, mode); render(); };
$('#mSync').onclick = async () => { await flush(); await pull(); $('#mstat').textContent = stat(); render(); };
$('#mRedo').onclick = () => { phase = 'rel'; page = 0; pick = relOf(task().video_id); $('#menuDlg').close(); render(); };
$('#mReset').onclick = () => { localStorage.removeItem(LS.cfg); location.reload(); };
$('#mClose').onclick = () => $('#menuDlg').close();
$('#mJson').onclick = () => {
  const rel = Object.values(REL).filter(r => r.release_confirmed_by_human);
  const keys = new Set();
  for (const r of rel) for (let i = -D.pre; i <= D.post; i++) keys.add(posKey(r.video_id, r.release_frame_human + i));
  const pos = Object.values(POS).filter(p => p.confirmed_by_human && keys.has(posKey(p.video_id, p.frame_index)));
  const b = new Blob([JSON.stringify({set: SET(), release: rel, positions: pos}, null, 1)],
                     {type: 'application/json'});
  const u = URL.createObjectURL(b), a2 = document.createElement('a');
  a2.href = u; a2.download = 'relui_' + SET() + '.json'; document.body.append(a2); a2.click();
  setTimeout(() => { URL.revokeObjectURL(u); a2.remove(); }, 1000);
};
function stat() {
  const q = st.get(LS.q, []).length;
  const nr = Object.values(REL).filter(r => r.release_confirmed_by_human).length;
  return '版 ' + APP_VER + '　' + SET() + '　リリース確定 ' + nr + '/' + D.tasks.length
         + ' 本　未送信 ' + q + ' 件　表示 ' + mode;
}
$('#menu').onclick = () => { $('#mstat').textContent = stat(); $('#menuDlg').showModal(); };

// ---------- 起動 ----------
async function boot() {
  const resp = await fetch(TASK_FILE + '?v=' + APP_VER);
  if (!resp.ok) {
    document.body.innerHTML = '<p style="padding:20px;color:#e8735a">入力セット ' + SET_PARAM
      + ' の素材が見つからない（' + TASK_FILE + '）</p>';
    throw new Error('no task file');
  }
  D = await resp.json();
  if (D.set !== SET_PARAM) {
    document.body.innerHTML = '<p style="padding:20px;color:#e8735a">素材の set 名 ' + D.set
      + ' が URL の ' + SET_PARAM + ' と一致しない</p>';
    throw new Error('set mismatch');
  }
  const leak = D.tasks.map(t => t.vid).filter(v => TEST_VIDS.indexOf(v) >= 0);
  if (leak.length) {
    document.body.innerHTML = '<p style="padding:20px;color:#e8735a">消費済み test が混ざっている: '
      + leak.join(' ') + '</p>';
    throw new Error('test leak');
  }
  REL = st.get(LS.rel, {}); POS = st.get(LS.pos, {});
  // 旧版は cap_annotations を丸ごと読み込んでいたので、train/val や test の旧正解が端末に残っている。
  // 今の set 以外の位置は捨てる。残すと「入力済み」に見えて答えの誘導になる。
  for (const k of Object.keys(POS)) if (POS[k].set_name !== D.set) delete POS[k];
  for (const k of Object.keys(REL)) if (REL[k].set_name !== D.set) delete REL[k];
  st.set(LS.pos, POS); st.set(LS.rel, REL);
  mode = st.get(LS.mode, null) || (innerWidth >= 700 ? 'tablet' : 'mobile');
  cfg = st.get(LS.cfg, null);
  const c = window.RELUI_CONFIG || {};
  if (!cfg && c.url && c.anonKey) cfg = {url: c.url, anonKey: c.anonKey};
  who = st.get(LS.who, '') || '';
  if (!cfg || !cfg.url || !cfg.anonKey || !who) {
    $('#sUrl').value = (cfg && cfg.url) || c.url || '';
    $('#sKey').value = (cfg && cfg.anonKey) || c.anonKey || '';
    $('#sWho').value = who;
    $('#setup').showModal();
    $('#sOk').onclick = () => {
      const u = $('#sUrl').value.trim(), k = $('#sKey').value.trim(), w = $('#sWho').value.trim();
      if (!u || !k || !w) { alert('3つとも入れてください'); return; }
      cfg = {url: u, anonKey: k}; who = w;
      st.set(LS.cfg, cfg); st.set(LS.who, who);
      $('#setup').close(); start();
    };
    return;
  }
  start();
}
async function start() {
  await pull();
  const k = D.tasks.findIndex(t => {
    const r = relOf(t.video_id);
    if (r === null) return true;
    for (let i = -D.pre; i <= D.post; i++)
      if (!(POS[posKey(t.video_id, r + i)] || {}).confirmed_by_human) return true;
    return false;
  });
  vi = k < 0 ? 0 : k;
  startVideo();
  flush();
}
boot();
