'use strict';
/* リリース教示の画面。投球ごとに次の順で進む。

   ① 位置合わせ（stage = locate の投球だけ）
      動画全体を縮小した全画面で見て、リリース付近のコマと投げる手の位置を打つ。
      自動探索に頼らない。前後へ自由に動ける。
   ② リリースを選ぶ
      原寸の切り出しで「手からキャップが離れた瞬間のコマ」を選ぶ。前後へ自由に動ける。
   ③ 蓋の中心を打つ（リリース-3〜+10 の14コマ）

   どの段階でも「使用不可」にできる。理由を必ず残す。

   守っていること:
   ・自動推定のリリースも、既存のリリース値も、画面に一切出さない。
   ・リリースのコマは原寸の切り出しで選ぶ（relcheck と同じ条件）。縮小画像では選ばない。
   ・送る列は決め打ち。読み込んだ行の id などは送らない。
   ・保存形式はスマホとタブレットで同じ。途中で端末を変えても続けられる。 */

const $ = s => document.querySelector(s);
const APP_VER = '4.6';   // 4.6: サーバーで読み直して確かめてから同期済み。確定は明示操作でだけ外す。古い保存で上書きしない
// 入力セットは URL で選ぶ。既定は relcheck（これまでの URL の挙動を変えない）。
const SET_PARAM = (new URLSearchParams(location.search).get('set') || 'relcheck');
const TASK_FILE = SET_PARAM === 'relcheck' ? 'data/tasks.json' : ('data/tasks_' + SET_PARAM + '.json');
// 4.6: リリースと打点は set ごとに保存する（別 set を開いても消えない）。待ち行列は全 set 共通で、キーに set を含める。
// 旧版のキー（relui.rel / relui.pos / relui.queue）は読むだけで書き換えない（未送信の唯一の控えかもしれない）。
const LS = {cfg: 'relui.cfg', who: 'relui.who', mode: 'relui.mode',
            legacyRel: 'relui.rel', legacyPos: 'relui.pos', legacyQ: 'relui.queue',
            q: 'relui.queue2', migrated: 'relui.queue.migrated', owner: 'relui.owner', log: 'relui.overwritten',
            rel: set => 'relui.rel.' + set, pos: set => 'relui.pos.' + set};
const TEST_VIDS = ['184258', '184307', '184442', '184917', '184956', '185159', '185349', '185402',
                   '154622', '154629', '154640', '154649', '154711', '154804', '154815', '154849',
                   '160931', '161044', '161103'];
const VIS = ['見える', '一部隠れ', '完全に隠れ'];
const REASONS = [['release_not_visible', 'リリースの瞬間が映像内に見えない'],
                 ['video_cut_before_release', 'リリースより前で動画が切れている'],
                 ['severe_occlusion', '強い遮蔽で判断できない'],
                 ['other', 'その他']];
// 位置合わせ画面は縮小画像なので、リリースの瞬間も使用不可も決めない（2026-09-14 利用者の指示）。
const RULE_LOC = 'ここでは<b>リリースの瞬間を決めません</b>。<b>投げている手</b>と<b>投球時刻</b>を大まかに指定してください'
               + '（手をタップして確定）。最終的なリリース判定は次の原寸画面で行います。';
const RULE_REL = 'リリース＝<b>手からキャップが離れた瞬間のコマ</b>を選ぶ。'
               + '原寸でも手や体に隠れて、どこで離れたか数コマ以上判断できない投球は「使用不可」';
const RULE_POS = '蓋の<b>中心</b>を打つ。ブラーで細長いときは<b>長軸も含めた幾何学的な中央</b>。'
               + '先端や後端は打たない。一部隠れは全体の中心が推定できるときだけ。完全に隠れは位置を打たない';

let D = null, vi = 0, fi = 0, phase = 'rel', rci = 0, lfi = 0, locPt = null,
    cfg = null, who = '', mode = 'mobile', expanded = false, t0 = 0,
    REL = {}, POS = {}, imgs = new Map(), zoomDrag = null,
    relZoom = 1, relOnly = false;   // relZoom 1/2/4 倍、relOnly はスマホで1コマだけ大きく見る
// 同期の状態。CONFLICT = 送ろうとしたら別の画面・端末が先に変えていた行、MIS = 端末とサーバーが食い違っていて待ち行列に無い行
let storageErr = null, readOnly = false, lastErr = null, lastVerified = null, syncing = false,
    CONFLICT = {}, MIS = {}, SRVPOS = {}, SRVREL = {};
const INST = Math.random().toString(36).slice(2) + Date.now().toString(36);   // この画面の識別子

const st = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  // 4.6: 保存に失敗したら黙って捨てない（容量不足・プライベートブラウズなど）
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { storageErr = String((e && e.message) || e); showNet(); return false; }
  }
};
const task = () => D.tasks[vi];
const SET = () => D.set;
const stageOf = t => t.stage || 'select';
// 確認用セット（anchorcheck など）: release のコマだけ選ぶ。14コマの位置は打たない。
const RELONLY = () => !!D && D.mode === 'release_only';
function statusOf(v) {
  const r = REL[v];
  if (!r) return null;
  if (r.status) return r.status;
  return r.release_frame_human != null ? 'confirmed' : null;
}
const relOf = v => (REL[v] && statusOf(v) === 'confirmed') ? REL[v].release_frame_human : null;
const win = () => {
  const r = relOf(task().video_id);
  return r === null ? [] : Array.from({length: D.pre + D.post + 1}, (_, i) => r - D.pre + i);
};
const posKey = (v, f) => v + '#' + f;
const reasonLabel = code => (REASONS.find(x => x[0] === code) || [code, code || '-'])[1];
// 位置合わせをやり直した後、まだ原寸の画像が新しい位置で作られていない
function cropStale(t) {
  const r = REL[t.video_id] || {};
  if (t.source !== 'located' || !t.locate || statusOf(t.video_id) !== 'located') return false;
  return !(t.locate[0] === r.locate_frame && Math.abs(t.locate[1] - r.locate_x) < 0.06
           && Math.abs(t.locate[2] - r.locate_y) < 0.06);
}
// 取り消した位置合わせ（tasks.json の invalid_locate と同じ座標のまま）なら、打ち直しが必要
function locInvalid(t) {
  // 状態は問わない（取り消した座標のまま release まで確定されていた場合も打ち直しが必要）
  const r = REL[t.video_id] || {}, k = t.invalid_locate;
  if (!k || r.locate_frame == null) return false;
  return k[0] === r.locate_frame && Math.abs(k[1] - r.locate_x) < 0.06 && Math.abs(k[2] - r.locate_y) < 0.06;
}
const locDone = t => statusOf(t.video_id) === 'located' && !locInvalid(t);
function lfiNear(t, f) {
  let best = 0, bd = 1e9;
  (t.lframes || []).forEach((x, i) => { const d = Math.abs(x.f - f); if (d < bd) { bd = d; best = i; } });
  return best;
}

function api(path, opt) {
  return fetch(cfg.url.replace(/\/+$/, '') + '/rest/v1/' + path, Object.assign({}, opt, {
    headers: Object.assign({apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey,
                            'Content-Type': 'application/json'}, (opt || {}).headers || {})
  }));
}

// ---------- 保存 ----------
// 流れ: 端末に保存 → 待ち行列 → 1件ずつサーバーへ書く → サーバーから読み直して一致を確かめる → そこで初めて待ち行列から消す。
// 書くときは「最後に見たサーバーの更新時刻（srv_at）」のときだけ更新する。変わっていたら上書きせず競合として人に見せる。
const enc = encodeURIComponent;
const qKey = (kind, r) => kind === 'pos' ? ('pos|' + r.set_name + '|' + r.video_id + '|' + r.frame_index)
                                         : ('rel|' + r.set_name + '|' + r.video_id);
const numEq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-6);
function samePos(a, b) {   // 中身（打点・見え方・確定・コマ）が同じか。時刻や入力者は比べない
  return !!a && !!b && a.video_id === b.video_id && a.set_name === b.set_name && a.frame_index === b.frame_index
    && a.release_offset === b.release_offset && numEq(a.x, b.x) && numEq(a.y, b.y)
    && (a.visibility || '見える') === (b.visibility || '見える')
    && (a.confirmed_by_human === true) === (b.confirmed_by_human === true);
}
function sameRel(a, b) {
  const stt = r => r.status || (r.release_frame_human != null ? 'confirmed' : null);
  return !!a && !!b && a.video_id === b.video_id && a.set_name === b.set_name && stt(a) === stt(b)
    && numEq(a.release_frame_human, b.release_frame_human)
    && (a.release_confirmed_by_human === true) === (b.release_confirmed_by_human === true)
    && (a.exclusion_reason || null) === (b.exclusion_reason || null) && (a.exclusion_note || null) === (b.exclusion_note || null)
    && numEq(a.locate_frame, b.locate_frame) && numEq(a.locate_x, b.locate_x) && numEq(a.locate_y, b.locate_y);
}
const sameRow = (kind, local, srv) => kind === 'pos' ? samePos(posRow(local), srv) : sameRel(relRow(local), srv);

function queuePush(kind, row) {
  const k = qKey(kind, row), q = st.get(LS.q, []);
  const i = q.findIndex(x => x.key === k);
  const item = {kind, key: k, row, at: row.updated_at};
  if (i >= 0) q[i] = item; else q.push(item);
  if (!st.set(LS.q, q)) { alert('★端末に保存できませんでした。この入力は保存されていません（' + storageErr + '）'); return false; }
  delete MIS[k]; delete CONFLICT[k];
  flush();
  return true;
}

// ---- 別の画面との取り合い。後から開いた画面・別の画面が「続ける」を押したら、こちらは保存しない ----
let bc = null;
try { bc = new BroadcastChannel('relui'); bc.onmessage = ev => { if (ev.data && ev.data.t === 'claim' && ev.data.id !== INST) lockOut(); }; } catch (e) {}
function lockOut() { readOnly = true; const L = $('#lock'); if (L) L.hidden = false; showNet(); }
function claim() {
  st.set(LS.owner, {id: INST, ts: Date.now()});
  if (bc) { try { bc.postMessage({t: 'claim', id: INST}); } catch (e) {} }
  const wasRO = readOnly;
  readOnly = false;
  const L = $('#lock'); if (L) L.hidden = true;
  if (wasRO && D) { REL = st.get(LS.rel(SET()), {}); POS = st.get(LS.pos(SET()), {}); pull().then(() => { flush(); render(); }); }
  showNet();
}
function lockCheck() {   // 起動時。別の画面が数秒以内に動いていたら、こちらは保存不可から始める
  const o = st.get(LS.owner, null);
  if (o && o.id !== INST && Date.now() - o.ts < 8000) lockOut(); else claim();
}
function canWrite() {
  if (readOnly) return false;
  const o = st.get(LS.owner, null);
  if (o && o.id !== INST && Date.now() - o.ts < 8000) { lockOut(); return false; }
  return true;
}
// 画面を閉じる・再読み込みするときは、自分の「使用中」の印だけを外す（再読み込みで自分自身に締め出されないように）
addEventListener('pagehide', () => {
  const o = st.get(LS.owner, null);
  if (o && o.id === INST) { try { localStorage.removeItem(LS.owner); } catch (e) {} }
});
setInterval(() => {   // 画面が見えている間だけ「この画面が使用中」を書く
  if (readOnly || document.visibilityState !== 'visible') return;
  const o = st.get(LS.owner, null);
  if (o && o.id !== INST && Date.now() - o.ts < 8000) lockOut();
  else st.set(LS.owner, {id: INST, ts: Date.now()});
}, 2000);

async function fetchOne(tbl, filt) {
  const r = await api(tbl + '?select=*&' + filt);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' 読み直し: ' + (await r.text()).slice(0, 160));
  const rows = await r.json();
  return rows[0] || null;
}
function filterOf(kind, body) {
  return 'video_id=eq.' + enc(body.video_id) + '&set_name=eq.' + enc(body.set_name)
         + (kind === 'pos' ? '&frame_index=eq.' + body.frame_index : '');
}
async function writeOne(it) {
  const pos = it.kind === 'pos', tbl = pos ? 'cap_release_positions' : 'cap_release_marks';
  const body = pos ? posRow(it.row) : relRow(it.row), filt = filterOf(it.kind, body);
  const H = {Prefer: 'return=representation'}, lab = pos ? '位置' : 'リリース';
  if (it.row.srv_at) {
    // 最後に見たサーバーの行のままなら更新する。別の画面・端末が先に変えていたら 0 行になる
    const r = await api(tbl + '?' + filt + '&updated_at=eq.' + enc(it.row.srv_at),
                        {method: 'PATCH', headers: H, body: JSON.stringify(body)});
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + lab + ': ' + (await r.text()).slice(0, 160));
    const rows = await r.json();
    if (rows.length === 1) return {row: rows[0]};
  } else {
    const r = await api(tbl, {method: 'POST', headers: H, body: JSON.stringify(body)});
    if (r.ok) return {row: (await r.json())[0]};
    if (r.status !== 409) throw new Error('HTTP ' + r.status + ' ' + lab + ': ' + (await r.text()).slice(0, 160));
  }
  const cur = await fetchOne(tbl, filt);   // 上書きしないで、今のサーバーの行と比べる
  if (cur && (pos ? samePos(body, cur) : sameRel(body, cur))) return {row: cur};
  return {conflict: true, server: cur};
}
function storeOf(kind, set) { return set === (D && D.set) ? (kind === 'pos' ? POS : REL) : st.get(kind === 'pos' ? LS.pos(set) : LS.rel(set), {}); }
function saveStore(kind, set, obj) { st.set(kind === 'pos' ? LS.pos(set) : LS.rel(set), obj); }
function localKey(kind, r) { return kind === 'pos' ? posKey(r.video_id, r.frame_index) : r.video_id; }
function ack(it, srv) {
  // 送った内容がサーバーにあると確かめた。待ち行列から消す（送信中に同じ行をまた直していたら、新しい基準で送り直す）
  const q = st.get(LS.q, []), i = q.findIndex(x => x.key === it.key);
  if (i >= 0) {
    if (q[i].at === it.at) q.splice(i, 1);
    else if ((q[i].row.srv_at || null) === (it.row.srv_at || null)) q[i].row.srv_at = srv.updated_at;
  }
  st.set(LS.q, q);
  const set = it.row.set_name, store = storeOf(it.kind, set), lk = localKey(it.kind, it.row), l = store[lk];
  if (l && (l.updated_at === it.row.updated_at || (l.srv_at || null) === (it.row.srv_at || null))) {
    l.srv_at = srv.updated_at; saveStore(it.kind, set, store);
  }
  (it.kind === 'pos' ? SRVPOS : SRVREL)[it.key] = srv;
}
async function flush() {
  if (syncing || !cfg || !D || !canWrite()) { showNet(); return; }
  const q = st.get(LS.q, []).filter(x => !CONFLICT[x.key]);
  if (!q.length) { showNet(); return; }
  syncing = true; lastErr = null; showNet();
  const done = [];
  try {
    for (const it of q) {   // 1件ずつ。HTTP エラーはその行だけ残して次へ。通信不可なら残りは次回
      try {
        const r = await writeOne(it);
        if (r.conflict) { CONFLICT[it.key] = {kind: it.kind, local: it.row, server: r.server, queued: true}; continue; }
        done.push(it);
      } catch (e) {
        lastErr = String(e.message || e);
        if (!lastErr.startsWith('HTTP')) break;
      }
    }
    for (const it of done) {   // 読み直し。送った内容と同じ行がサーバーにあることを確かめる
      const body = it.kind === 'pos' ? posRow(it.row) : relRow(it.row);
      const srv = await fetchOne(it.kind === 'pos' ? 'cap_release_positions' : 'cap_release_marks', filterOf(it.kind, body));
      if (srv && (it.kind === 'pos' ? samePos(body, srv) : sameRel(body, srv))) ack(it, srv);
      else CONFLICT[it.key] = {kind: it.kind, local: it.row, server: srv, queued: true};
    }
    if (done.length && !lastErr) lastVerified = new Date();
  } catch (e) {
    lastErr = String(e.message || e);
  } finally { syncing = false; showNet(); render(); }
  const rest = st.get(LS.q, []).filter(x => !CONFLICT[x.key]);
  if (rest.length && !lastErr) setTimeout(flush, 300);   // 送信中に増えた分
}

// 送る列を決め打ちにする。読み込んだ行の id や created_at を送ると、Supabase が送信全体を拒否する。
// 全行が同じ列を持たないと一括送信も拒否されるので、無い列には既定値を入れる。
// 状態ごとの約束（確定ならリリースのコマあり、除外なら理由あり・コマなし）は表の側でも拒否する。
const nz = v => (v === undefined ? null : v);
function relRow(r) {
  const status = r.status || 'confirmed';
  return {video_id: r.video_id, set_name: r.set_name,
          release_frame_human: status === 'confirmed' ? nz(r.release_frame_human) : null,
          release_confirmed_by_human: status === 'confirmed' && r.release_confirmed_by_human === true,
          expanded: r.expanded === true,
          seconds_spent: nz(r.seconds_spent),
          ui_mode: r.ui_mode || null, annotator: r.annotator || null,
          status: status,
          exclusion_reason: status === 'excluded' ? (r.exclusion_reason || 'other') : null,
          exclusion_note: status === 'excluded' ? (r.exclusion_note || null) : null,
          locate_frame: nz(r.locate_frame), locate_x: nz(r.locate_x), locate_y: nz(r.locate_y)};
}
function posRow(r) {
  const occ = r.visibility === '完全に隠れ';
  return {video_id: r.video_id, set_name: r.set_name, frame_index: r.frame_index,
          release_offset: r.release_offset,
          x: occ ? null : nz(r.x),
          y: occ ? null : nz(r.y),
          bbox_w: nz(r.bbox_w),
          bbox_h: nz(r.bbox_h),
          visibility: r.visibility || '見える',
          confirmed_by_human: r.confirmed_by_human === true,
          annotator: r.annotator || null};
}
function showNet() {
  const e = $('#net');
  if (!e) return;
  const nq = st.get(LS.q, []).length, nc = Object.keys(CONFLICT).length, nm = Object.keys(MIS).length;
  e.className = '';
  if (readOnly) { e.className = 'bad'; e.textContent = '★この画面では保存できません（別の画面で開いています）'; return; }
  if (storageErr) { e.className = 'bad'; e.textContent = '★端末に保存できません: ' + storageErr.slice(0, 60); return; }
  if (nc) { e.className = 'bad'; e.textContent = '★サーバーと競合 ' + nc + ' 件（☰ → サーバーとの差分）'; return; }
  if (nm) { e.className = 'bad'; e.textContent = '★サーバーと不一致 ' + nm + ' 件（☰ → サーバーとの差分）'; return; }
  if (syncing) { e.textContent = '送信中…（未送信 ' + nq + ' 件）'; return; }
  if (lastErr) {
    e.className = 'bad';
    e.textContent = (lastErr.startsWith('HTTP') ? '★保存エラー' : '通信不可') + ' 未送信 ' + nq + ' 件（端末に保存済み） ' + lastErr.slice(0, 80);
    return;
  }
  if (nq) { e.className = 'q'; e.textContent = '未送信 ' + nq + ' 件'; return; }
  if (!lastVerified) { e.className = 'q'; e.textContent = 'サーバー未確認'; return; }
  e.textContent = '同期済み（サーバー確認 ' + lastVerified.toTimeString().slice(0, 8) + '）';
}
function merge(kind, l, s, k, queued, log) {
  const srv = Object.assign({}, s, {srv_at: s.updated_at});
  if (!l) return srv;
  if (sameRow(kind, l, s)) return Object.assign({}, l, {srv_at: s.updated_at});
  if (queued.has(k)) return l;                          // 送る途中。送るときに基準の時刻で競合を判定する
  // 端末とサーバーが違い、送る予定にも入っていない。どちらが正しいかは人が決める（黙ってどちらにも合わせない。
  // 旧版の画面が古い値でサーバーを上書きした場合も、ここで止まる）
  MIS[k] = {kind, local: l, server: s,
            why: (!l.srv_at || l.srv_at === s.updated_at) ? '端末の変更が送られていない' : '別の画面・端末がサーバーを変えた'};
  return l;
}
async function pull() {   // サーバーを読み、端末と照合する。端末だけにある変更は消さずに「不一致」として出す
  if (!cfg || !D) return;
  try {
    const r1 = await api('cap_release_marks?select=*&set_name=eq.' + enc(SET()) + '&limit=2000');
    const r2 = await api('cap_release_positions?select=*&set_name=eq.' + enc(SET()) + '&limit=5000');
    if (!r1.ok || !r2.ok) throw new Error('HTTP ' + (r1.ok ? r2.status : r1.status) + ' 読み込み');
    const marks = await r1.json(), pos = await r2.json();
    const queued = new Set(st.get(LS.q, []).map(x => x.key)), log = st.get(LS.log, []), seen = new Set();
    MIS = {};
    for (const x of marks) { const k = qKey('rel', x); seen.add(k); SRVREL[k] = x; REL[x.video_id] = merge('rel', REL[x.video_id], x, k, queued, log); }
    for (const x of pos) {
      const k = qKey('pos', x), pk = posKey(x.video_id, x.frame_index);
      seen.add(k); SRVPOS[k] = x; POS[pk] = merge('pos', POS[pk], x, k, queued, log);
    }
    for (const l of Object.values(REL)) { const k = qKey('rel', l); if (!seen.has(k) && !queued.has(k)) MIS[k] = {kind: 'rel', local: l, server: null}; }
    for (const l of Object.values(POS)) { const k = qKey('pos', l); if (!seen.has(k) && !queued.has(k)) MIS[k] = {kind: 'pos', local: l, server: null}; }
    st.set(LS.rel(SET()), REL); st.set(LS.pos(SET()), POS); st.set(LS.log, log.slice(-500));
    lastErr = null; lastVerified = new Date();
  } catch (e) { lastErr = String(e.message || e); }
  showNet();
}
function migrateLegacy() {
  // 旧版（4.5 まで）の保存を set ごとの保存へ写す。旧版のキーは書き換えない。新しい方を採る
  const newer = (a, b) => !b || (a && a.updated_at && b.updated_at && new Date(a.updated_at) > new Date(b.updated_at));
  const lr = st.get(LS.legacyRel, {}), lp = st.get(LS.legacyPos, {});
  for (const [k, v] of Object.entries(lr)) if (v && v.set_name === D.set && newer(v, REL[k])) REL[k] = v;
  for (const [k, v] of Object.entries(lp)) if (v && v.set_name === D.set && newer(v, POS[k])) POS[k] = v;
  const old = st.get(LS.legacyQ, []), done = new Set(st.get(LS.migrated, [])), q = st.get(LS.q, []);
  for (const it of old) {
    if (!it || !it.row || !it.kind || !it.row.set_name) continue;
    const sig = it.kind + '|' + it.row.set_name + '|' + it.row.video_id + '|' + (it.row.frame_index == null ? '' : it.row.frame_index) + '|' + it.row.updated_at;
    if (done.has(sig)) continue;
    const row = Object.assign({}, it.row);
    delete row.srv_at;   // 旧版は基準の時刻を持たない → 送るときは上書きせず、サーバーの行と比べる（違えば競合）
    const k = qKey(it.kind, row), i = q.findIndex(x => x.key === k), item = {kind: it.kind, key: k, row, at: row.updated_at, legacy: true};
    if (i < 0) q.push(item); else if (newer(row, q[i].row)) q[i] = item;
    done.add(sig);
  }
  st.set(LS.q, q); st.set(LS.migrated, [...done]);
}
function describe(kind, r) {
  if (!r) return '（サーバーに行が無い）';
  if (kind === 'pos') return (r.confirmed_by_human ? '確定' : '未確認') + '・' + (r.visibility || '見える')
    + (r.x == null ? '' : '・(' + (+r.x).toFixed(1) + ', ' + (+r.y).toFixed(1) + ')');
  return (r.status || '') + (r.release_frame_human != null ? '・release ' + r.release_frame_human : '')
    + (r.exclusion_reason ? '・' + r.exclusion_reason : '') + (r.locate_frame != null ? '・位置合わせ ' + r.locate_frame : '');
}
function openDiff() {
  const box = $('#diffList'); box.innerHTML = '';
  const items = [...Object.entries(CONFLICT).map(([k, x]) => [k, x, '競合']), ...Object.entries(MIS).map(([k, x]) => [k, x, '不一致'])];
  if (!items.length) box.textContent = '食い違いはありません。';
  for (const [k, x, label] of items) {
    const r = x.local, d = document.createElement('div');
    d.style.cssText = 'border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0';
    const title = r.video_id + (x.kind === 'pos' ? '　コマ ' + r.frame_index + '（' + (r.release_offset >= 0 ? '+' : '') + r.release_offset + '）' : '　リリース') + '　' + r.set_name;
    d.innerHTML = '<b></b><div class="sub"></div><div class="sub"></div>';
    d.children[0].textContent = label + '：' + title + (x.why ? '（' + x.why + '）' : '');
    d.children[1].textContent = '端末　 ' + describe(x.kind, r);
    d.children[2].textContent = 'サーバー ' + describe(x.kind, x.server);
    const b1 = document.createElement('button'), b2 = document.createElement('button');
    b1.textContent = '端末の内容を送る'; b2.textContent = 'サーバーに合わせる';
    b1.onclick = () => resolveDiff(k, x, 'local'); b2.onclick = () => resolveDiff(k, x, 'server');
    d.append(b1, b2); box.append(d);
  }
  $('#diffDlg').showModal();
}
function resolveDiff(k, x, how) {
  if (!canWrite()) { alert('この画面では保存できません（別の画面で開いています）'); return; }
  const set = x.local.set_name, store = storeOf(x.kind, set), lk = localKey(x.kind, x.local);
  const q = st.get(LS.q, []), i = q.findIndex(y => y.key === k);
  if (how === 'local') {
    // 今のサーバーの行を基準にして、端末の内容で書く（その後、読み直して確かめる）
    const row = Object.assign({}, x.local, {srv_at: x.server ? x.server.updated_at : undefined, updated_at: new Date().toISOString()});
    if (!x.server) delete row.srv_at;
    store[lk] = row; saveStore(x.kind, set, store);
    delete CONFLICT[k]; delete MIS[k];
    if (i >= 0) q.splice(i, 1);
    st.set(LS.q, q);
    queuePush(x.kind, row);
  } else {
    const log = st.get(LS.log, []);
    log.push({at: new Date().toISOString(), key: k, local: x.local, server: x.server, why: '人が「サーバーに合わせる」を選んだ'});
    st.set(LS.log, log.slice(-500));
    if (x.server) store[lk] = Object.assign({}, x.server, {srv_at: x.server.updated_at}); else delete store[lk];
    saveStore(x.kind, set, store);
    if (i >= 0) q.splice(i, 1);
    st.set(LS.q, q);
    delete CONFLICT[k]; delete MIS[k];
  }
  $('#diffDlg').close(); showNet(); render();
  if (Object.keys(CONFLICT).length + Object.keys(MIS).length) openDiff();
}
function syncClass(v, f) {   // コマの一覧に、送信待ち・食い違いの印を付ける
  const k = qKey('pos', {set_name: SET(), video_id: v, frame_index: f});
  if (CONFLICT[k] || MIS[k]) return ' mis';
  return st.get(LS.q, []).some(x => x.key === k) ? ' pend' : '';
}

// ---------- 画像 ----------
function img(name, dir) {
  const k = dir + name;
  if (imgs.has(k)) return imgs.get(k);
  const im = new Image(); im.src = dir + '/' + name; imgs.set(k, im);
  im.onload = () => draw();
  return im;
}
const frameRec = f => task().frames.find(x => x.f === f);
function fitCanvas(c, natW, natH) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
  const s = Math.min(c.width / natW, c.height / natH);
  return {s, ox: (c.width - natW * s) / 2, oy: (c.height - natH * s) / 2, dpr};
}
function draw() {
  if (phase === 'pos') drawMain();
  else if (phase === 'rel') drawRelBig();
  else if (phase === 'loc') drawLoc();
}

// ---------- ① 位置合わせ ----------
function drawLoc() {
  const t = task(), c = $('#main'), g = c.getContext('2d');
  // 画面の向きは群で違う（石黒群は横）。投球ごとの大きさを使う。
  const sc = D.loc_scale || 4, lw = (t.W || D.W) / sc, lh = (t.H || D.H) / sc;
  const v = fitCanvas(c, lw, lh);
  g.imageSmoothingEnabled = true;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  const lf = t.lframes[lfi];
  const im = img(lf.img, 'loc');
  if (im.complete && im.naturalWidth) g.drawImage(im, v.ox, v.oy, lw * v.s, lh * v.s);
  c._v = v; c._sc = sc;
  for (const d of [-2, -1, 1, 2]) {             // 前後を先に読んでおく
    const x = t.lframes[lfi + d]; if (x) img(x.img, 'loc');
  }
  if (locPt && locPt.f === lf.f) {
    const x = v.ox + (locPt.x / sc) * v.s, y = v.oy + (locPt.y / sc) * v.s, L = 22 * v.dpr, G = 6 * v.dpr;
    g.strokeStyle = '#34a853'; g.lineWidth = 3 * v.dpr;
    g.beginPath();
    g.moveTo(x - L, y); g.lineTo(x - G, y); g.moveTo(x + G, y); g.lineTo(x + L, y);
    g.moveTo(x, y - L); g.lineTo(x, y - G); g.moveTo(x, y + G); g.lineTo(x, y + L);
    g.stroke();
  }
  $('#maintag').textContent = 'コマ ' + lf.f + '（縮小表示・' + (D.loc_step || 4) + 'コマおき）';
}

// ---------- ② リリース選択 ----------
function relPageFrames() {
  const fs = task().frames, per = D.page || 24;
  const s0 = Math.max(0, Math.min(fs.length - per, rci - Math.floor(per / 2) + 1));
  return fs.slice(s0, s0 + per);
}
function drawRelBig() {
  // 見ているコマを大きく出す。答えの印は一切描かない。コマ番号だけ。
  const c = $('#main'), g = c.getContext('2d');
  const fs = task().frames, fr = fs[Math.max(0, Math.min(fs.length - 1, rci))];
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
  const cur = task().frames[rci];
  for (const fr of relPageFrames()) {
    const d = document.createElement('div');
    d.className = 'cell' + (cur && cur.f === fr.f ? ' sel' : '');
    const im = document.createElement('img');
    im.src = 'img/' + fr.img; im.loading = 'lazy';
    const s = document.createElement('span'); s.textContent = fr.f;   // コマ番号だけ
    d.append(im, s);
    d.onclick = () => { rci = task().frames.findIndex(x => x.f === fr.f); render(); };
    g.append(d);
  }
  drawRelBig();
}

// ---------- 前後移動（①②共通） ----------
function nav(delta) {            // delta は元動画のコマ数
  if (phase === 'loc') {
    const t = task(), step = D.loc_step || 4, n = t.lframes.length;
    const k = Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / step));
    lfi = Math.max(0, Math.min(n - 1, lfi + k));
  } else if (phase === 'rel') {
    const n = task().frames.length;
    rci = Math.max(0, Math.min(n - 1, rci + delta));
    expanded = true;
  }
  render();
}
function jumpTo(frame) {
  const list = phase === 'loc' ? task().lframes : (phase === 'rel' ? task().frames : null);
  if (!list) return;
  let best = 0, bd = 1e9;
  list.forEach((x, i) => { const d = Math.abs(x.f - frame); if (d < bd) { bd = d; best = i; } });
  if (phase === 'loc') lfi = best; else { rci = best; expanded = true; }
  render();
}
function setNav(idx, n, f, fmin, fmax, step) {
  const s = $('#slider');
  s.max = String(Math.max(0, n - 1)); s.value = String(idx);
  $('#curf').textContent = 'コマ ' + f + '（' + fmin + '〜' + fmax + '）';
  $('#fnum').min = String(fmin); $('#fnum').max = String(fmax);
  document.querySelectorAll('#navrow button[data-d]').forEach(b => {
    const d = +b.dataset.d, k = Math.abs(d) === 1 ? step : Math.abs(d);
    b.textContent = d < 0 ? ('◀ ' + k) : (k + ' ▶');
  });
}

// ---------- ③ 位置入力 ----------
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
function drawLeft() {
  const L = $('#left');
  if (mode !== 'tablet' || phase !== 'pos') { L.style.display = 'none'; return; }
  L.style.display = ''; L.innerHTML = '';
  win().forEach((f, i) => {
    const r = frameRec(f); if (!r) return;
    const p = POS[posKey(task().video_id, f)];
    const d = document.createElement('div');
    d.className = 'thumb' + (i === fi ? ' cur' : '') + (p ? (p.confirmed_by_human ? ' done' : ' draft') : '') + syncClass(task().video_id, f);
    const im = document.createElement('img'); im.src = 'img/' + r.img; im.loading = 'lazy';
    const s = document.createElement('span');
    const off = i - D.pre; s.textContent = (off >= 0 ? '+' : '') + off;
    d.append(im, s);
    d.onclick = () => { fi = i; render(); };
    L.append(d);
  });
}

// ---------- 保存の中身 ----------
function carryLocate(v) {
  const r = REL[v] || {};
  return {locate_frame: nz(r.locate_frame), locate_x: nz(r.locate_x), locate_y: nz(r.locate_y)};
}
function baseRel(v) {
  return {video_id: v, set_name: SET(), expanded: expanded,
          seconds_spent: Math.round((Date.now() - t0) / 1000), ui_mode: mode,
          annotator: who, updated_at: new Date().toISOString(), srv_at: (REL[v] || {}).srv_at};
}
function putRel(row) {
  if (!canWrite()) { alert('この画面では保存できません（別の画面で開いています）'); return false; }
  REL[row.video_id] = row;
  if (!st.set(LS.rel(SET()), REL)) { alert('★端末に保存できませんでした（' + storageErr + '）'); return false; }
  return queuePush('rel', row);
}
function saveRel(frame) {
  const v = task().video_id;
  putRel(Object.assign(baseRel(v), carryLocate(v),
    {release_frame_human: frame, release_confirmed_by_human: true, status: 'confirmed',
     exclusion_reason: null, exclusion_note: null}));
}
function saveLocate(p) {
  const v = task().video_id;
  putRel(Object.assign(baseRel(v),
    {release_frame_human: null, release_confirmed_by_human: false, status: 'located',
     exclusion_reason: null, exclusion_note: null,
     locate_frame: p.f, locate_x: +p.x.toFixed(1), locate_y: +p.y.toFixed(1)}));
}
function saveExclude(reason, note) {
  const v = task().video_id;
  putRel(Object.assign(baseRel(v), carryLocate(v),
    {release_frame_human: null, release_confirmed_by_human: false, status: 'excluded',
     exclusion_reason: reason, exclusion_note: note || null}));
}
function savePos(o) {
  if (!canWrite()) { alert('この画面では保存できません（別の画面で開いています）'); return; }
  const v = task().video_id, f = curFrame(), now = new Date().toISOString();
  if (f == null) return;
  const base = POS[posKey(v, f)] || {video_id: v, frame_index: f,
                                     release_offset: fi - D.pre, x: null, y: null,
                                     bbox_w: null, bbox_h: null, visibility: '見える',
                                     confirmed_by_human: false};
  const row = Object.assign({}, base, o, {release_offset: fi - D.pre, set_name: SET(),
                                          annotator: who, updated_at: now});
  delete row.__key;
  // 完全に隠れ は座標を無効化する。既存の truth_release と同じ意味にする。
  if (row.visibility === '完全に隠れ') { row.x = null; row.y = null; }
  if ('x' in o && o.x !== null && !isFinite(o.x)) return;
  // 4.6: 中身が変わらず、サーバーとも一致している操作は保存しない（触っただけで送り直さない）
  const k = qKey('pos', row);
  if (POS[posKey(v, f)] && samePos(posRow(POS[posKey(v, f)]), posRow(row)) && SRVPOS[k] && samePos(posRow(row), SRVPOS[k])
      && !MIS[k] && !CONFLICT[k]) { render(); return; }
  POS[posKey(v, f)] = row;
  if (!st.set(LS.pos(SET()), POS)) { alert('★端末に保存できませんでした（' + storageErr + '）'); return; }
  queuePush('pos', row);
  render();
}

// ---------- 表示 ----------
const PHASE_LABEL = {loc: '① 投球を探して手の位置を打つ', wait: '位置合わせ済み（原寸の画像を準備中）',
                     excl: '使用不可（除外済み）', rel: '② リリースのコマを選ぶ', pos: '③ 蓋の中心を打つ'};
function showRow(id, on) { $(id).style.display = on ? '' : 'none'; }
function countDone(x) {
  const r = relOf(x.video_id);
  if (r === null) return 0;
  let n = 0;
  for (let i = -D.pre; i <= D.post; i++)
    if ((POS[posKey(x.video_id, r + i)] || {}).confirmed_by_human) n++;
  return n;
}
function render() {
  const t = task(), v = t.video_id;
  $('#vid').textContent = v;
  $('#phase').textContent = PHASE_LABEL[phase];
  $('#rule').innerHTML = phase === 'loc' ? RULE_LOC : (phase === 'rel' ? RULE_REL : (phase === 'pos' ? RULE_POS : ''));
  document.body.className = mode;

  showRow('#visrow', phase === 'pos'); showRow('#actrow', phase === 'pos');
  showRow('#locrow', phase === 'loc'); showRow('#relrow', phase === 'rel');
  showRow('#navrow', phase === 'loc' || phase === 'rel'); showRow('#jumprow', phase === 'loc' || phase === 'rel');
  showRow('#msgrow', phase === 'wait' || phase === 'excl');
  showRow('#msglinerow', phase === 'loc');

  if (phase === 'loc') {
    $('#grid').style.display = 'none'; $('#zoomwrap').style.display = 'none'; $('#left').style.display = 'none';
    $('#mainwrap').style.display = '';
    const lf = t.lframes[lfi];
    $('#info').textContent = 'コマ ' + lf.f + '（動画は全 ' + t.total + ' コマ）';
    setNav(lfi, t.lframes.length, lf.f, t.lframes[0].f, t.lframes[t.lframes.length - 1].f, D.loc_step || 4);
    showRow('#locback', stageOf(t) === 'select' && !cropStale(t));
    $('#locredo').disabled = !locPt;
    if (locInvalid(t)) $('#msgline').textContent = '前の位置合わせは取り消しました。投げている手を打ち直してください。';
    else $('#msgline').textContent = '';
    $('#locgo').disabled = !locPt;
    $('#locgo').textContent = locPt ? ('コマ ' + locPt.f + ' の手の位置で確定') : '手をタップしてから確定';
    drawLoc();
  } else if (phase === 'rel') {
    document.body.classList.add('relphase');
    drawRelGrid();
    const fs = t.frames, cur = fs[rci];
    $('#info').textContent = 'コマ ' + cur.f + '（用意したコマ ' + fs[0].f + '〜' + fs[fs.length - 1].f + '）';
    setNav(rci, fs.length, cur.f, fs[0].f, fs[fs.length - 1].f, 1);
    $('#relgo').textContent = 'コマ ' + cur.f + ' をリリースとして確定';
    showRow('#relocbtn', !!(t.lframes && t.lframes.length));
    showRow('#exbtn2', !RELONLY());
    if (RELONLY()) {
      showRow('#relocbtn', false);
      $('#rule').innerHTML = RULE_REL.split('。')[0] + '。<b>確認用：リリースのコマだけ選びます</b>（14コマの位置は打ちません）';
      if (relOf(t.video_id) !== null) $('#relgo').textContent = 'コマ ' + cur.f + ' で選び直す（この投球は選択済み）';
    }
  } else if (phase === 'pos') {
    $('#grid').style.display = 'none';
    $('#mainwrap').style.display = ''; $('#zoomwrap').style.display = '';
    const off = fi - D.pre;
    $('#info').textContent = 'コマ ' + curFrame() + '（リリース' + (off >= 0 ? '+' : '') + off + '）';
    $('#maintag').textContent = '原寸 / タップで蓋の中心';
    const p = curPos();
    $('#go').disabled = !(p && (p.x != null || p.visibility === '完全に隠れ'));
    $('#unconf').disabled = !(p && p.confirmed_by_human);
    document.querySelectorAll('#visrow button').forEach(b =>
      b.classList.toggle('on', !!p && p.visibility === b.dataset.v));
    drawLeft(); drawMain();
  } else {
    $('#grid').style.display = 'none'; $('#zoomwrap').style.display = 'none'; $('#left').style.display = 'none';
    $('#mainwrap').style.display = '';
    const c = $('#main'), g = c.getContext('2d');
    fitCanvas(c, 1, 1); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    $('#maintag').textContent = '';
    $('#info').textContent = '';
    const r = REL[v] || {};
    if (phase === 'wait') {
      $('#msg').textContent = 'コマ ' + r.locate_frame + ' の手の位置（' + Math.round(r.locate_x) + ', '
        + Math.round(r.locate_y) + '）を記録しました。この位置を中心に原寸の画像を用意してから、リリースのコマを選びます。';
    } else {
      $('#msg').textContent = 'この投球は使用不可として除外済みです。理由: ' + reasonLabel(r.exclusion_reason)
        + (r.exclusion_note ? '（' + r.exclusion_note + '）' : '');
    }
    showRow('#undoex', phase === 'excl');
    showRow('#relocate', phase === 'wait');
  }

  const w = win();
  const done = w.filter(f => (POS[posKey(v, f)] || {}).confirmed_by_human).length;
  const active = D.tasks.filter(x => statusOf(x.video_id) !== 'excluded');
  const full = D.pre + D.post + 1;
  const tot = active.length * full;
  const all = active.reduce((a, x) => a + countDone(x), 0);
  $('#total').textContent = w.length ? ('この投球 ' + done + '/' + w.length + '　全体 ' + all + '/' + tot)
                                     : ('全体 ' + all + '/' + tot);
  $('#bar').style.width = (tot ? all / tot * 100 : 0) + '%';
  $('#who2').textContent = who;
  if (RELONLY()) {
    const k = D.tasks.filter(x => relOf(x.video_id) !== null).length;
    $('#total').textContent = 'リリース選択 ' + k + '/' + D.tasks.length;
    $('#bar').style.width = (k / D.tasks.length * 100) + '%';
  }

  const fw = $('#films'); fw.innerHTML = '';
  if (phase === 'pos') w.forEach((f, i) => {
    const d = document.createElement('div');
    const p = POS[posKey(v, f)];
    d.className = 'fr' + (i === fi ? ' cur' : '') + (p ? (p.confirmed_by_human ? ' done' : ' draft') : '') + syncClass(v, f);
    const off = i - D.pre; d.textContent = (off >= 0 ? '+' : '') + off;
    d.onclick = () => { fi = i; render(); };
    fw.append(d);
  });
  const cur = fw.querySelector('.cur'); if (cur) cur.scrollIntoView({block: 'nearest', inline: 'center'});

  const vw = $('#vids'); vw.innerHTML = '';
  D.tasks.forEach((x, i) => {
    const s = statusOf(x.video_id), d = document.createElement('div');
    let label, cls;
    if (s === 'excluded') { label = ' 除外'; cls = ' excl'; }
    else if (stageOf(x) === 'locate') { label = locDone(x) ? ' 準備中' : ' 探す'; cls = locDone(x) ? ' wait' : ''; }
    else if (cropStale(x)) { label = ' 準備中'; cls = ' wait'; }
    else if (RELONLY()) { const ok = relOf(x.video_id) !== null; label = ok ? ' 選択済' : ' 未'; cls = ok ? ' done' : ''; }
    else {
      const n = countDone(x), r = relOf(x.video_id);
      label = r === null ? ' 未' : (' ' + n + '/' + full);
      cls = r !== null && n === full ? ' done' : ((r !== null || n) ? ' part' : '');
    }
    d.className = 'vd' + (i === vi ? ' cur' : '') + cls;
    d.textContent = x.vid + label;
    d.onclick = () => { vi = i; startVideo(); };
    vw.append(d);
  });
  const cv = vw.querySelector('.cur'); if (cv) cv.scrollIntoView({block: 'nearest', inline: 'center'});
}

function startVideo() {
  const t = task(), v = t.video_id, s = statusOf(v);
  expanded = false; t0 = Date.now(); locPt = null; relZoom = 1;
  if (s === 'excluded') {
    phase = 'excl';
  } else if (stageOf(t) === 'locate') {
    phase = locDone(t) ? 'wait' : 'loc';
    const r = REL[v] || {};
    lfi = r.locate_frame != null ? lfiNear(t, r.locate_frame) : 0;   // 取り消した場合も時刻の近くから
  } else if (cropStale(t)) {
    phase = 'wait';
  } else if (relOf(v) === null || RELONLY()) {
    phase = 'rel';
    rci = 0;
    // 人が自分で位置合わせした投球は、その人の打ったコマから見せる（自動探索の値ではない）
    const r = REL[v] || {};
    if (t.source === 'located' && r.locate_frame != null) {
      const i = t.frames.findIndex(x => x.f === r.locate_frame);
      if (i >= 0) rci = i;
    }
    // 確認用セットは配布ファイルで決めた開始位置から。選び直すときも自分の前の選択には合わせない
    if (t.start_frame != null) {
      const i = t.frames.findIndex(x => x.f === t.start_frame);
      if (i >= 0) rci = i;
    }
  } else {
    phase = 'pos';
    const w = win();
    const k = w.findIndex(f => !(POS[posKey(v, f)] || {}).confirmed_by_human);
    fi = k < 0 ? 0 : k;
  }
  render();
}
function nextVideo() {
  if (vi + 1 < D.tasks.length) { vi++; startVideo(); }
  else render();
}

// ---------- 操作 ----------
document.querySelectorAll('#navrow button[data-d]').forEach(b => b.onclick = () => nav(+b.dataset.d));
$('#slider').addEventListener('input', e => {
  const i = +e.target.value;
  if (phase === 'loc') lfi = i;
  else if (phase === 'rel') { rci = i; expanded = true; }
  render();
});
$('#fgo').onclick = () => { const n = parseInt($('#fnum').value, 10); if (isFinite(n)) jumpTo(n); };
$('#fnum').addEventListener('keydown', e => { if (e.key === 'Enter') { $('#fgo').click(); e.preventDefault(); } });

$('#locgo').onclick = () => {
  if (!locPt) return;
  const rel = relOf(task().video_id);
  if (rel !== null && !confirm('この投球にはリリース確定（コマ ' + rel + '）があります。位置合わせをやり直すと、'
      + 'このリリース確定は取り消され、新しい原寸画像で選び直しになります。続けますか？')) return;
  saveLocate(locPt);
  phase = 'wait'; render();
};
$('#relgo').onclick = () => {
  const fs = task().frames, f = fs[rci].f;
  const have = new Set(fs.map(x => x.f));
  for (let i = -D.pre; i <= D.post; i++) {
    if (!have.has(f + i)) {
      alert('コマ ' + f + ' をリリースにすると、前後14コマ（' + (f - D.pre) + '〜' + (f + D.post)
            + '）の画像が足りません。用意したコマは ' + fs[0].f + '〜' + fs[fs.length - 1].f
            + ' です。「位置合わせをやり直す」で投球時刻を指定し直してください。');
      return;
    }
  }
  saveRel(f);
  if (RELONLY()) { nextVideo(); return; }
  phase = 'pos'; fi = 0; render();
};
function openExclude() {
  $('#exReason').value = 'release_not_visible'; $('#exNote').value = '';
  $('#exDlg').showModal();
}
// 使用不可はリリース選択画面（原寸）からだけ。位置合わせ画面には置かない。
$('#exbtn2').onclick = openExclude;
function toLocate() {
  const t = task(), r = REL[t.video_id] || {};
  const f = r.locate_frame != null ? r.locate_frame : (t.frames && t.frames[rci] ? t.frames[rci].f : 0);
  lfi = lfiNear(t, f); locPt = null; phase = 'loc'; render();
}
$('#relocbtn').onclick = toLocate;
// 位置合わせ画面の「やり直す」: 打った手の位置を消して打ち直す（まだ確定していないタップ）
$('#locredo').onclick = () => { locPt = null; render(); };
$('#locback').onclick = () => { locPt = null; phase = 'rel'; render(); };
$('#exOk').onclick = () => {
  const r = $('#exReason').value, n = $('#exNote').value.trim();
  if (r === 'other' && !n) { alert('「その他」のときは理由を書いてください'); return; }
  saveExclude(r, n);
  $('#exDlg').close();
  phase = 'excl'; render();
};
$('#exCancel').onclick = () => $('#exDlg').close();
$('#undoex').onclick = () => {
  const t = task();
  locPt = null; lfi = 0; rci = 0;
  phase = stageOf(t) === 'locate' ? 'loc' : 'rel';
  render();
};
$('#relocate').onclick = toLocate;

$('#maintag').onclick = () => {
  if (phase === 'rel') { relZoom = relZoom >= 4 ? 1 : relZoom * 2; render(); }
};
$('#mBig') && ($('#mBig').onclick = () => { relOnly = !relOnly; $('#menuDlg').close(); render(); });

$('#main').addEventListener('pointerdown', e => {
  const c = $('#main'), v = c._v;
  if (!v) return;
  const rect = c.getBoundingClientRect();
  const px = (e.clientX - rect.left) * v.dpr, py = (e.clientY - rect.top) * v.dpr;
  if (phase === 'loc') {
    const t = task(), sc = c._sc || 4, lw = (t.W || D.W) / sc, lh = (t.H || D.H) / sc;
    const ix = (px - v.ox) / v.s, iy = (py - v.oy) / v.s;
    if (!isFinite(ix) || !isFinite(iy) || ix < 0 || iy < 0 || ix > lw || iy > lh) return;
    locPt = {f: task().lframes[lfi].f, x: ix * sc, y: iy * sc};
    render();
    return;
  }
  if (phase !== 'pos') return;
  const ix = (px - v.ox) / v.s, iy = (py - v.oy) / v.s;
  if (!isFinite(ix) || !isFinite(iy) || ix < 0 || iy < 0 || ix > D.crop || iy > D.crop) return;
  const f = toFull({x: ix, y: iy});
  savePos({x: +f.x.toFixed(1), y: +f.y.toFixed(1)});   // 4.6: 打点を動かしても確定は外さない
});
$('#zoom').addEventListener('pointerdown', e => {
  const p = curPos(); if (!p || p.x == null) return;
  zoomDrag = {sx: e.clientX, sy: e.clientY, x: p.x, y: p.y};
  $('#zoom').setPointerCapture(e.pointerId);
});
$('#zoom').addEventListener('pointermove', e => {
  if (!zoomDrag) return;
  const c = $('#zoom'), dpr = Math.min(devicePixelRatio || 1, 2), k = c._Z / dpr;
  const nx = +(zoomDrag.x - (e.clientX - zoomDrag.sx) / k).toFixed(2), ny = +(zoomDrag.y - (e.clientY - zoomDrag.sy) / k).toFixed(2);
  const p = curPos();
  if (p && numEq(p.x, nx) && numEq(p.y, ny)) { e.preventDefault(); return; }   // 触っただけ（動いていない）は保存しない
  savePos({x: nx, y: ny});   // 4.6: 確定は外さない
  e.preventDefault();
});
addEventListener('pointerup', () => { zoomDrag = null; });
addEventListener('pointercancel', () => { zoomDrag = null; });
document.querySelectorAll('#nudge button[data-d]').forEach(b => b.onclick = () => {
  const p = curPos(); if (!p || p.x == null) return;
  const d = b.dataset.d.split(',').map(Number);
  savePos({x: +(p.x + d[0]).toFixed(2), y: +(p.y + d[1]).toFixed(2)});   // 4.6: 確定は外さない
});
document.querySelectorAll('#visrow button').forEach(b => b.onclick = () => setVis(b.dataset.v));
function setVis(v) {
  const p = curPos();
  // 4.6: 見え方を変えても確定は外さない（新しいコマは未確認から始まる）
  if (v === '完全に隠れ') savePos({visibility: v, x: null, y: null});
  else savePos({visibility: v});
}
$('#go').onclick = () => {
  savePos({confirmed_by_human: true});
  const w = win();
  if (fi + 1 < w.length) { fi++; render(); }
  else nextVideo();
};
$('#skip').onclick = () => { const w = win(); if (fi + 1 < w.length) { fi++; render(); } else nextVideo(); };
$('#prev').onclick = () => { if (fi > 0) { fi--; render(); } };
$('#undo').onclick = () => {   // 打点を消す。明示操作なので未確認に戻す
  savePos({x: null, y: null, visibility: '見える', confirmed_by_human: false});
};
$('#unconf').onclick = () => {   // 4.6: 確定を外すのはこのボタン（と取消）だけ
  const p = curPos();
  if (p && p.confirmed_by_human) savePos({confirmed_by_human: false});
};

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if ($('#exDlg').open || $('#menuDlg').open) return;
  const k = e.key;
  if (phase === 'pos') {
    if (k === 'ArrowRight') { $('#skip').click(); e.preventDefault(); }
    else if (k === 'ArrowLeft') { $('#prev').click(); e.preventDefault(); }
    else if (k === 'Enter') { if (!$('#go').disabled) $('#go').click(); }
    else if (k === 'v' || k === 'V') setVis('見える');
    else if (k === 'p' || k === 'P') setVis('一部隠れ');
    else if (k === 'o' || k === 'O') setVis('完全に隠れ');
    else if (k === 'z' || k === 'Z') $('#undo').click();
  } else if (phase === 'loc' || phase === 'rel') {
    if (k === 'ArrowRight') { nav(1); e.preventDefault(); }
    else if (k === 'ArrowLeft') { nav(-1); e.preventDefault(); }
    else if (k === 'ArrowUp') { nav(12); e.preventDefault(); }
    else if (k === 'ArrowDown') { nav(-12); e.preventDefault(); }
    else if (k === 'z' || k === 'Z') { if (phase === 'rel') { relZoom = relZoom >= 4 ? 1 : relZoom * 2; render(); } }
    else if (k === 'Enter') {
      if (phase === 'loc') { if (!$('#locgo').disabled) $('#locgo').click(); }
      else $('#relgo').click();
    }
  }
});
addEventListener('resize', () => { if (!st.get(LS.mode, null)) autoMode(); if (D) render(); });   // 4.6: 読み込み前の回転でエラーにしない
addEventListener('online', flush);
setInterval(flush, 20000);
// 4.6: 送る物が無いときも1分ごとにサーバーを読み直して照合する（別の画面・端末が変えていないか）
setInterval(() => { if (D && cfg && !syncing && !readOnly && document.visibilityState === 'visible' && !st.get(LS.q, []).length) pull().then(render); }, 60000);

function autoMode() { mode = innerWidth >= 700 ? 'tablet' : 'mobile'; }
$('#mMode').onclick = () => { mode = mode === 'tablet' ? 'mobile' : 'tablet'; st.set(LS.mode, mode); render(); };
$('#mSync').onclick = async () => { await flush(); await pull(); $('#mstat').textContent = stat(); render(); };
$('#mRedo').onclick = () => {
  const t = task();
  $('#menuDlg').close();
  if (stageOf(t) === 'locate') { phase = 'loc'; lfi = 0; locPt = null; }
  else {
    phase = 'rel'; rci = 0;
    const r = relOf(t.video_id);
    const tf = RELONLY() ? t.start_frame : r;
    if (tf != null) { const i = t.frames.findIndex(x => x.f === tf); if (i >= 0) rci = i; }
  }
  render();
};
$('#mReset').onclick = () => { localStorage.removeItem(LS.cfg); location.reload(); };
$('#mClose').onclick = () => $('#menuDlg').close();
$('#mJson').onclick = () => {
  const rel = Object.values(REL).filter(r => statusOf(r.video_id) === 'confirmed' && r.release_confirmed_by_human);
  const excl = Object.values(REL).filter(r => statusOf(r.video_id) === 'excluded');
  const keys = new Set();
  for (const r of rel) for (let i = -D.pre; i <= D.post; i++) keys.add(posKey(r.video_id, r.release_frame_human + i));
  const pos = Object.values(POS).filter(p => p.confirmed_by_human && keys.has(posKey(p.video_id, p.frame_index)));
  const b = new Blob([JSON.stringify({set: SET(), release: rel, excluded: excl, positions: pos}, null, 1)],
                     {type: 'application/json'});
  const u = URL.createObjectURL(b), a2 = document.createElement('a');
  a2.href = u; a2.download = 'relui_' + SET() + '.json'; document.body.append(a2); a2.click();
  setTimeout(() => { URL.revokeObjectURL(u); a2.remove(); }, 1000);
};
function stat() {
  const q = st.get(LS.q, []).length;
  const n = s => D.tasks.filter(t => statusOf(t.video_id) === s).length;
  return '版 ' + APP_VER + '　' + SET() + '　リリース確定 ' + n('confirmed') + '・位置合わせ済み ' + n('located')
         + '・除外 ' + n('excluded') + ' / ' + D.tasks.length + ' 本　未送信 ' + q + ' 件（競合 ' + Object.keys(CONFLICT).length
         + '・不一致 ' + Object.keys(MIS).length + '）　最終サーバー確認 '
         + (lastVerified ? lastVerified.toTimeString().slice(0, 8) : 'なし') + '　表示 ' + mode;
}
$('#menu').onclick = () => { $('#mstat').textContent = stat(); $('#menuDlg').showModal(); };
$('#mDiff').onclick = () => { $('#menuDlg').close(); openDiff(); };
$('#diffClose').onclick = () => $('#diffDlg').close();
$('#lockTake').onclick = () => claim();
$('#mDump').onclick = () => {   // 端末の保存を全部書き出す（接続設定は含めない）。何も消さない
  const out = {app: APP_VER, exported_at: new Date().toISOString(), instance: INST, set: D && D.set,
               conflicts: CONFLICT, mismatches: MIS, storage: {}};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('relui.') && k !== LS.cfg) out.storage[k] = localStorage.getItem(k);
  }
  const b = new Blob([JSON.stringify(out, null, 1)], {type: 'application/json'});
  const u = URL.createObjectURL(b), a2 = document.createElement('a');
  a2.href = u; a2.download = 'relui_device_dump_' + new Date().toISOString().replace(/[:.]/g, '') + '.json';
  document.body.append(a2); a2.click();
  setTimeout(() => { URL.revokeObjectURL(u); a2.remove(); }, 1000);
};

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
  const sel = $('#exReason');
  sel.innerHTML = '';
  for (const [code, label] of REASONS) {
    const o = document.createElement('option'); o.value = code; o.textContent = label + '（' + code + '）';
    sel.append(o);
  }
  // 4.6: set ごとの保存を読む。別 set の保存は消さない（旧版は起動時に消していた）
  REL = st.get(LS.rel(D.set), {}); POS = st.get(LS.pos(D.set), {});
  migrateLegacy();
  st.set(LS.pos(D.set), POS); st.set(LS.rel(D.set), REL);
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
  lockCheck();
  await pull();
  const k = D.tasks.findIndex(t => {
    const v = t.video_id, s = statusOf(v);
    if (s === 'excluded') return false;
    if (stageOf(t) === 'locate') return !locDone(t);
    if (cropStale(t)) return false;
    if (RELONLY()) return relOf(v) === null;
    const r = relOf(v);
    if (r === null) return true;
    for (let i = -D.pre; i <= D.post; i++)
      if (!(POS[posKey(v, r + i)] || {}).confirmed_by_human) return true;
    return false;
  });
  vi = k < 0 ? 0 : k;
  startVideo();
  flush();
}
boot();
