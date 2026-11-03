// app.js — LeRobot 101 OS 前端主體
// 原則（契約 §0）：後端是狀態唯一權威，前端是 tick 訊息的純函數；
// 按鈕啟用與否完全由 state.phase 決定；event 訊息驅動音效/字幕/星星動畫。
// ?devmock=1 → 不開 WebSocket，改用 devmock.js 的純前端模擬器。

import { initAudio, chime, ding, success, error as errorSound, tickTock } from './sounds.js';
import { createViewer } from './viewer3d.js';
import { createMockSim } from './devmock.js';

/* ═══════════ 常數 ═══════════ */
const DEVMOCK = true; // Public classroom edition is simulation-only.
const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];
/* 手臂「車色」——記在手臂身分上，3D 預覽會套用（像 Tesla 車機設定車色）*/
const ARM_COLORS = [
  { name: 'LeRobot 橘', hex: '#ff7f2a' },
  { name: '白', hex: '#f2f0ea' },
  { name: '黑', hex: '#2b2b2e' },
  { name: '銀', hex: '#b9bdc4' },
  { name: '藍', hex: '#2b5fa8' },
  { name: '紅', hex: '#b3372e' },
  { name: '綠', hex: '#2e7d43' },
  { name: '紫', hex: '#7a5cc4' },
];
const JOINT_ZH = {
  shoulder_pan: '肩部旋轉', shoulder_lift: '肩部抬升', elbow_flex: '手肘',
  wrist_flex: '手腕俯仰', wrist_roll: '手腕旋轉', gripper: '夾爪',
};
// 英文名：學生常把 Shoulder / Wrist 搞混——3D 標註中英並列，編號 1–6 對齊 STS32XX 參考姿勢圖
const JOINT_EN = {
  shoulder_pan: 'Shoulder Pan', shoulder_lift: 'Shoulder Lift', elbow_flex: 'Elbow Flex',
  wrist_flex: 'Wrist Flex', wrist_roll: 'Wrist Roll', gripper: 'Gripper',
};
const jnum = (j) => `<span class="jnum">${JOINTS.indexOf(j) + 1}</span>`;
let calibHoverJoint = null; // 滑鼠停在哪張關節卡上 → 3D 那顆跟著亮
const GUIDE_ORDER = JOINTS.filter((j) => j !== 'wrist_roll');
const PANELS = ['connect', 'calib', 'teleop', 'record', 'replay', 'smart'];
const PHASE_INFO = {
  boot: ['🌙 待機 boot', ''],
  scan: ['🔍 掃描中 scan', 'amber'],
  idle: ['✅ 就緒 idle', 'green'],
  calibrating: ['🎯 校準中 calibrating', 'orange'],
  teleop: ['🕹 遙操作 teleop', 'blue'],
  recording: ['⏺ 錄製中 recording', 'red'],
  replaying: ['▶ 回放中 replaying', 'blue'],
  smart: ['🧠 智慧執行 smart', 'blue'],
};
const PHASE_STEP = { scan: 'connect', calibrating: 'calib', teleop: 'teleop', recording: 'record', replaying: 'replay', smart: 'smart' };
/* 訓練步數選項：秒級體驗到課堂等級 */
/* 訓練量與訓練位置是獨立的兩件事：任何步數都能丟本機或 Forge */
const TRAIN_STEPS_CHOICES = [
  { v: 2000, label: '快速體驗（2000 步）' },
  { v: 20000, label: '標準（20000 步）' },
  { v: 50000, label: '加強（50000 步）' },
  { v: 100000, label: '完整（100000 步）' },
];
/* 訓練位置（Forge 選項只在公司內網可達時出現） */
const TRAIN_WHERE_CHOICES = [
  { v: 'local', label: '這台電腦（本機）' },
  { v: 'forge-local', label: 'Forge 本地機房（RTX Pro 6000，免費）' },
  { v: 'forge-nebius', label: 'Forge 雲端（Nebius，付費）' },
];
const SMART_SECONDS_CHOICES = [
  { v: 30, label: '30 秒' },
  { v: 60, label: '60 秒' },
  { v: 120, label: '2 分鐘' },
  { v: 0, label: '直到我按停止' },
];
const CENTER = 2047;

/* ═══════════ 小工具 ═══════════ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const degOfRaw = (raw) => (raw - CENTER) * 360 / 4096;
const rawOfDeg = (deg) => Math.round(deg * 4096 / 360 + CENTER);

/* ═══════════ 全域狀態（僅 UI 端） ═══════════ */
let tickMsg = null;          // 最近一次 tick
let activePanel = 'connect';
let firstTickSeen = false;
let wsOk = false;
const sessionDone = { teleop: false, record: false, replay: false };
let lastCalibSaved = null;   // {arm, text, ranges, at} — calib_saved 後的成功卡
let datasets = [];
let datasetsAt = 0;
let datasetsBusy = false;
let models = [];
let modelsAt = 0;
let modelsBusy = false;
let forgeInfo = null;        // GET /api/forge/status（不在公司內網 = 整塊隱藏）
let forgeAt = 0;
let trainPreselect = '';     // 從回放頁「🎓 訓練」帶過來的資料集
let lastTrainActive = false; // 訓練剛結束 → 立刻重抓模型清單
let calibHoldUntil = 0;      // extreme_hit 後短暫凍結 gauge 重建，讓星星飛完
let sim = null;              // devmock 模擬器
let viewer = null;

/* ═══════════ REST（錯誤一律 toast；FlowError→409、ValueError→400） ═══════════ */
async function api(path, { body = undefined, method = undefined } = {}) {
  if (DEVMOCK) {
    const r = sim.handleApi('/api' + path, body);
    if (!r.ok) {
      toast(r.error || '未知錯誤', 'error');
      throw new Error(r.error);
    }
    return r.data;
  }
  const m = method || (body !== undefined ? 'POST' : (path === '/datasets' || path === '/status' ? 'GET' : 'POST'));
  let res;
  try {
    res = await fetch('/api' + path, {
      method: m,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    toast('連不上伺服器…', 'error');
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || `伺服器錯誤 ${res.status}`, 'error');
    throw new Error(data.error || String(res.status));
  }
  return data;
}

/* ═══════════ WebSocket（1.5s backoff 自動重連；每 10s ping） ═══════════ */
let ws = null;
let wsPing = null;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch (e) {
    setTimeout(connectWS, 1500);
    return;
  }
  ws.onopen = () => {
    wsOk = true;
    render();
    clearInterval(wsPing);
    wsPing = setInterval(() => { try { ws.send('ping'); } catch (e) { /* 忽略 */ } }, 10000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    wsOk = false;
    clearInterval(wsPing);
    render();
    setTimeout(connectWS, 1500);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* 忽略 */ } };
}

/* ═══════════ 訊息處理 ═══════════ */
function handleMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'tick') {
    tickMsg = msg;
    const phase = msg.state && msg.state.phase;
    if (phase === 'teleop') sessionDone.teleop = true;
    if (phase === 'recording') sessionDone.record = true;
    if (phase === 'replaying') sessionDone.replay = true;
    if (!firstTickSeen) {
      firstTickSeen = true;
      if (PHASE_STEP[phase] && phase !== 'scan') activePanel = PHASE_STEP[phase];
    }
    if (viewer && msg.joints) viewer.setJoints(msg.joints);
    if (viewer && msg.state && msg.state.arms) {   // 手臂「車色」
      viewer.setColors({
        leader: msg.state.arms.leader?.color || null,
        follower: msg.state.arms.follower?.color || null,
      });
    }
    render();
  } else if (msg.type === 'event') {
    onEvent(msg);
  }
}

function onEvent(e) {
  switch (e.kind) {
    case 'chime': chime(); break;
    case 'ding': ding(e.pitch_index || 0); break;
    case 'success': success(); break;
    case 'error':
      errorSound();
      if (e.text) toast(e.text, 'error');
      break;
    case 'speak': subtitle(e.text); break;
    case 'joint_centered':
      ding(e.pitch_index ?? 0);
      popCapsule(e.joint);
      break;
    case 'extreme_hit':
      ding(4);
      calibHoldUntil = Date.now() + 750;
      burstStars(e.side);
      break;
    case 'calib_saved': {
      success();
      confettiBurst();
      const c = tickMsg && tickMsg.state && tickMsg.state.calib;
      lastCalibSaved = {
        arm: e.arm || (c && c.active_arm) || 'follower',
        text: e.text || '',
        ranges: c ? JOINTS.map((j) => ({ j, min: c.joints[j]?.min, max: c.joints[j]?.max })) : null,
        at: Date.now(),
      };
      render();
      break;
    }
    default: break;
  }
}

/* ═══════════ 字幕膠囊（speak 事件；語音本體由後端 say 播） ═══════════ */
const subQ = [];
let subBusy = false;
function subtitle(text) {
  if (!text) return;
  subQ.push(text);
  if (!subBusy) nextSubtitle();
}
function nextSubtitle() {
  const t = subQ.shift();
  const el = $('#subtitlePill');
  if (t === undefined) { subBusy = false; return; }
  subBusy = true;
  el.textContent = '💬 ' + t;
  el.classList.add('show');
  const dur = clamp(1200 + t.length * 160, 2800, 9000); // 約 4 秒，隨長度伸縮
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(nextSubtitle, 380);
  }, dur);
}

/* ═══════════ toast ═══════════ */
function toast(text, type = 'info') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = (type === 'error' ? '⚠ ' : type === 'success' ? '✓ ' : '') + text;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 3500);
}

/* ═══════════ 確認對話框（危險操作兩段式） ═══════════ */
let confirmResolve = null;
function confirmDialog(text) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirmText').textContent = text;
    $('#confirmOverlay').hidden = false;
  });
}
function closeConfirm(ok) {
  $('#confirmOverlay').hidden = true;
  if (confirmResolve) confirmResolve(ok);
  confirmResolve = null;
}

/* ═══════════ 彩帶（輕量 canvas，~80 粒，2 秒） ═══════════ */
function confettiBurst() {
  const cv = $('#confettiCanvas');
  const ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) return;
  cv.width = innerWidth;
  cv.height = innerHeight;
  cv.style.display = 'block';
  const colors = ['#ff7f2a', '#ffb37a', '#2e7d43', '#2b5fa8', '#b07a1e', '#e85d75'];
  const parts = Array.from({ length: 80 }, (_, i) => ({
    x: Math.random() * cv.width,
    y: -20 - Math.random() * cv.height * 0.3,
    vx: (Math.random() - 0.5) * 2.6,
    vy: 2.2 + Math.random() * 3.4,
    w: 5 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[i % colors.length],
  }));
  const t0 = performance.now();
  (function frame(t) {
    const k = (t - t0) / 2000;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (k >= 1) { cv.style.display = 'none'; return; }
    ctx.globalAlpha = 1 - Math.max(0, k - 0.6) / 0.4;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.05;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  })(t0);
}

/* ═══════════ 校準小動畫 ═══════════ */
function popCapsule(joint) {
  const el = $(`.jcap[data-joint="${joint}"]`);
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth; // 重新觸發動畫
  el.classList.add('pop');
}
function burstStars(side) {
  const dot = $(`.gauge-dot[data-side="${side}"]`);
  if (!dot) return;
  const n = 4 + Math.floor(Math.random() * 3); // 4–6 顆小星星
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'star';
    s.textContent = i % 2 ? '✦' : '★';
    s.style.setProperty('--dx', `${Math.random() * 52 - 26}px`);
    s.style.setProperty('--dy', `${-8 - Math.random() * 40}px`);
    s.style.animationDelay = `${Math.random() * 90}ms`;
    dot.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}

/* ═══════════ 主 render（tick 的純函數） ═══════════ */
function render() {
  const st = tickMsg ? tickMsg.state : null;
  renderHeader(st);
  renderNav(st);
  renderLog(st);
  renderSimhand();
  for (const p of PANELS) $(`#panel-${p}`).hidden = (p !== activePanel);
  const camSwitching = !!st?.camera?.switching || !!camPendingName;
  const liveCamName = st?.camera?.name || '';
  if (liveCamName !== camLastStateName) {
    camLastStateName = liveCamName;
    camListAt = 0; // 實際來源變了，別再等五秒才改下拉選單
  }
  if (camPendingName && !st?.camera?.switching && liveCamName === camPendingName) {
    camPendingName = '';
    camPendingAt = 0;
    camListAt = 0;
  } else if (camPendingName && Date.now() - camPendingAt > 12000) {
    // 裝置被拔掉或開啟失敗，讓後端的實際狀態重新接管選單。
    camPendingName = '';
    camPendingAt = 0;
    camListAt = 0;
  }
  const camName = $('#camName');
  if (camName) { // 顯示實際辨識到的相機名稱（自動猜測 + 可手動下拉切換）
    camName.textContent = camSwitching
      ? `｜正在切換${camPendingName ? `到 ${camPendingName}` : ''}…`
      : (liveCamName ? `｜${liveCamName}` : '');
  }
  const camSelect = $('#camSelect');
  if (camSelect) {
    camSelect.disabled = camSwitching;
    camSelect.classList.toggle('switching', camSwitching);
  }
  for (const wrap of [$('#camConnectWrap'), $('#camTeleopWrap')]) {
    if (wrap) wrap.classList.toggle('cam-switching', camSwitching);
  }
  refreshCamSelect(st);
  const blackMsg = $('#camBlackMsg');
  if (blackMsg) blackMsg.hidden = !st?.camera?.black;
  if (activePanel === 'connect') renderConnect(st);
  else if (activePanel === 'calib') renderCalib(st);
  else if (activePanel === 'teleop') renderTeleop(st);
  else if (activePanel === 'record') renderRecord(st);
  else if (activePanel === 'replay') renderReplay(st);
  else if (activePanel === 'smart') renderSmart(st);
  updateViewerPlacement(st);
  updateViewerOverlays(st);
}

function bothConnected(st) { return !!(st && st.arms && st.arms.leader?.connected && st.arms.follower?.connected); }
function bothCalibrated(st) { return !!(st && st.arms && st.arms.leader?.calibrated && st.arms.follower?.calibrated); }

/* ── 頁首 ── */
function renderHeader(st) {
  const mode = tickMsg ? tickMsg.mode : null;
  const modeB = $('#modeBadge');
  modeB.textContent = mode === 'mock' ? '🧪 模擬 MOCK' : mode === 'real' ? '🦾 實機 REAL' : '⋯';
  modeB.className = 'badge ' + (mode === 'mock' ? 'orange' : mode === 'real' ? 'green' : '');

  const [label, color] = PHASE_INFO[st?.phase] || ['—', ''];
  const phaseB = $('#phaseBadge');
  phaseB.textContent = label;
  phaseB.className = 'badge ' + color;

  const wsB = $('#wsBadge');
  if (DEVMOCK) {
    wsB.textContent = '🧪 devmock';
    wsB.className = 'badge orange';
  } else {
    wsB.textContent = wsOk ? '🔌 已連線' : '⚠ 重新連線中…';
    wsB.className = 'badge ' + (wsOk ? 'green' : 'red');
  }
  const sv = tickMsg && tickMsg.server;
  $('#serverBadge').textContent = sv ? `${sv.user}@${sv.hostname} · ${sv.ip}` : '—';
}

/* ── 步驟導覽 ── */
function renderNav(st) {
  const doneMap = {
    connect: bothConnected(st),
    calib: bothCalibrated(st),
    teleop: sessionDone.teleop,
    record: sessionDone.record || datasets.length > 0,
    replay: sessionDone.replay,
    smart: models.length > 0,
  };
  const liveStep = st ? PHASE_STEP[st.phase] : null;
  for (const b of $$('#stepNav .step')) {
    const key = b.dataset.panel;
    b.classList.toggle('active', key === activePanel);
    b.classList.toggle('done', !!doneMap[key]);
    b.classList.toggle('live', liveStep === key && key !== activePanel);
  }
}

/* ── 下一步 banner ── */
function bannerFor(panel, st) {
  if (!st) return null;
  if (panel === 'connect' && bothConnected(st)) {
    return bothCalibrated(st)
      ? { to: 'teleop', label: '雙臂已就緒！下一步：③ 遙操作', btn: '③ 遙操作 →' }
      : { to: 'calib', label: '雙臂已連線！下一步：② 校準', btn: '② 校準 →' };
  }
  if (panel === 'calib' && bothCalibrated(st) && st.phase === 'idle') {
    return { to: 'teleop', label: '校準完成！下一步：③ 遙操作', btn: '③ 遙操作 →' };
  }
  if (panel === 'teleop' && sessionDone.teleop && st.phase === 'idle') {
    return { to: 'record', label: '玩得不錯！下一步：④ 錄製', btn: '④ 錄製 →' };
  }
  if (panel === 'record' && datasets.length > 0 && st.phase === 'idle') {
    return { to: 'replay', label: '已有資料集！下一步：⑤ 回放', btn: '⑤ 回放 →' };
  }
  return null;
}
/* 回放頁的「下一步」走 hint 之外的路：ds-card 上有「🎓 拿去訓練」按鈕直達 ⑥ */
function renderBanner(panel, st) {
  const el = $(`#banner-${panel}`);
  if (!el) return;
  const b = bannerFor(panel, st);
  if (!b) { el.hidden = true; return; }
  const html = `<span>✅ ${esc(b.label)}</span><button data-action="goto" data-panel="${b.to}">${esc(b.btn)}</button>`;
  if (el.innerHTML !== html) el.innerHTML = html;
  el.hidden = false;
}

/* ── ① 連線 ── */
let connectKey = '';
/* 相機下拉選單：自動判斷可能誤判（AVF 名稱順序 ≠ cv2 index），讓用戶手動選並記住 */
let camListAt = 0;
let camListBusy = false;
let camListHtml = '';
let camPendingName = '';
let camPendingAt = 0;
let camLastStateName = '';
async function refreshCamSelect(st) {
  const sel = $('#camSelect');
  if (!sel) return;
  if (!tickMsg || tickMsg.mode !== 'real' || activePanel !== 'connect') { sel.hidden = true; return; }
  sel.hidden = false;
  const switching = !!st?.camera?.switching || !!camPendingName;
  const refreshMs = switching ? 300 : 5000;
  if (camListBusy || Date.now() - camListAt < refreshMs) return;
  camListBusy = true;
  try {
    const r = await fetch('/api/camera/list');
    const data = await r.json();
    camListAt = Date.now();
    const stateName = st?.camera?.present ? (st.camera.name || '') : '';
    const selectedName = camPendingName || stateName || data.current_name || '';
    const waiting = !!data.switching || !!st?.camera?.switching;
    // 顯示真正的裝置名稱（不是「相機 0」），內建／手機相機標注出來好避開。
    // 重點：切換期間以使用者剛點的名稱為準，不讓過期 REST 回應選回舊相機。
    // 否則瀏覽器會退而顯示第一項，看起來就像「自己跳回內建相機」。
    const opts = data.indices.map((p) => {
      const selected = selectedName ? p.name === selectedName : p.current;
      return `<option value="${p.index}" data-name="${esc(p.name)}" ${selected ? 'selected' : ''}>` +
      `${esc(p.name)}${p.builtin ? '（內建／手機）' : ''}${p.virtual ? '（虛擬）' : ''}` +
      `${p.current ? ' ✓使用中' : ''}` +
      `${p.default_res ? ' · ' + p.default_res : ''}</option>`;
    });
    if (waiting && !selectedName) {
      opts.unshift('<option value="" selected>（正在切換相機…）</option>');
    } else if (!selectedName) {
      opts.unshift('<option value="" selected>（偵測中…）</option>');
    }
    const html = opts.join('');
    if (html !== camListHtml) {   // 沒變就不重建，避免使用者正在挑的時候被洗掉
      camListHtml = html;
      sel.innerHTML = html;
    }
    sel.title = data.current_name
      ? `目前使用：${data.current_name}（選錯的話換一個，你的選擇會被記住）`
      : '選錯的話換一個——你的選擇會被記住';
  } catch (e) { /* 伺服器忙碌時下次再試 */ }
  finally { camListBusy = false; }
}

function renderConnect(st) {
  renderBanner('connect', st);
  $('#btnScan').disabled = !(st && (st.phase === 'scan' || st.phase === 'idle'));
  const key = JSON.stringify([st && st.arms, st && st.phase]);
  if (key === connectKey) return;
  connectKey = key;
  for (const role of ['leader', 'follower']) {
    const card = $(`#armcard-${role}`);
    const a = st && st.arms && st.arms[role];
    const title = role === 'leader'
      ? '🕹 Leader（主控臂）<span class="en">leader</span>'
      : '🦾 Follower（跟隨臂）<span class="en">follower</span>';
    if (!a || !a.connected) {
      card.innerHTML = `<h3>${title}</h3>
        <div class="wait-ripple"><span class="ripple-dot"><i></i></span>等待插入 USB… <span class="en">waiting…</span></div>`;
      continue;
    }
    const motorsOk = !!a.motors_ok;
    const idle = st.phase === 'idle';
    let calChip;
    if (a.calibrated && a.calib_kind === 'partial') {
      // 出廠只設了中間點、沒掃過極限：角度準，但夾爪的 0–100% 映射會失真
      calChip = `<span class="chip warn">◐ 部分校準${a.calib_file_date ? ' · ' + esc(a.calib_file_date) : ''}</span>
         <div class="tip">角度是準的，但活動範圍沒掃過 → 夾爪開合會不準，建議校準一次。</div>
         <button class="recal adopt" data-action="calib-start" data-arm="${role}" ${idle ? '' : 'disabled'}>校準以補齊範圍 →</button>`;
    } else if (a.calibrated) {
      calChip = `<span class="chip ok">✓ 已校準${a.calib_file_date ? ' · ' + esc(a.calib_file_date) : ''}</span>
         <button class="recal" data-action="calib-start" data-arm="${role}" ${idle ? '' : 'disabled'}>重新校準</button>`;
    } else if (a.adoptable) {
      calChip = `<span class="chip warn">📂 發現既有校正檔${a.calib_file_date ? ' · ' + esc(a.calib_file_date) : ''}</span>
         <button class="recal adopt" data-action="arm-adopt" data-arm="${role}" ${idle ? '' : 'disabled'}>讀取校正檔與設定</button>
         <button class="recal" data-action="calib-start" data-arm="${role}" ${idle ? '' : 'disabled'}>重新校準</button>`;
    } else {
      calChip = `<span class="chip warn">未校準</span>
         <button class="recal" data-action="calib-start" data-arm="${role}" ${idle ? '' : 'disabled'}>立刻校準 →</button>
         <button class="recal" data-action="arm-reset" data-arm="${role}" ${idle ? '' : 'disabled'} title="讀值和實際姿勢對不上時：homing 歸零重來">重置馬達</button>`;
    }
    // 校準真相在手臂（b10）：手臂裡的 ≠ 本機檔 → 比一比；手臂被清空但有備份 → 寫回
    if (a.alt_calib) {
      calChip += `<span class="chip warn">⚖ 另一份校準 · ${esc(a.alt_calib.label || '')}${a.alt_calib.date ? ' ' + esc(a.alt_calib.date) : ''}</span>
         <button class="recal adopt" data-action="compare-goto" ${idle ? '' : 'disabled'}>比一比 →</button>`;
    }
    if (a.restorable) {
      calChip = `<span class="chip warn">手臂設定已清空</span>
         <button class="recal adopt" data-action="arm-restore" data-arm="${role}" ${idle ? '' : 'disabled'}>寫回上次校準（${esc(a.restorable.date || '')}）</button>` + calChip;
    }
    const swatches = ARM_COLORS.map((c) =>
      `<button class="swatch${(a.color || '') === c.hex ? ' on' : ''}" data-action="arm-color"
        data-arm="${role}" data-color="${c.hex}" title="${c.name}"
        style="background:${c.hex}"></button>`).join('') +
      `<button class="swatch reset${a.color ? '' : ' on'}" data-action="arm-color"
        data-arm="${role}" data-color="" title="預設橘">↺</button>`;
    card.innerHTML = `<h3>${title}</h3>
      <span class="chip ok">🔌 已連線</span>
      <span class="chip ${motorsOk ? 'ok' : 'warn'}">馬達 ${a.motors_found ?? '?'}/6</span>
      <div class="kv">埠　<b>${esc(a.port || '—')}</b></div>
      <div class="kv">身分　<b>${a.uid ? '…' + esc(String(a.uid).slice(-8)) : '—'}</b></div>
      <div class="kv">電壓　<b>${a.voltage != null ? a.voltage.toFixed(1) + ' V' : '—'}</b></div>
      <div class="kv swatches">顏色　${swatches}</div>
      <div>${calChip}</div>`;
  }
}

/* ── ② 校準 ── */
let calibKey = '';
function renderCalib(st) {
  renderBanner('calib', st);
  const body = $('#calibBody');
  const phase = st?.phase;
  const c = st?.calib;

  if (phase !== 'calibrating' || !c) {
    const cmpKey = st?.compare?.active ? 'cmp|' + st.compare.sets.map((s) => s.label).join('|') : 'nocmp';
    const key = 'choose|' + JSON.stringify([st?.arms, phase, lastCalibSaved?.at, cmpKey]);
    if (key !== calibKey) {
      calibKey = key;
      body.innerHTML = buildCalibChooser(st);
    }
    updateWristDelta();
    updateCompare(st);
    return;
  }

  if (c.stage === 'center') {
    const key = `center|${c.active_arm}`;
    if (key !== calibKey) {
      calibKey = key;
      body.innerHTML = buildCalibCenter(c);
    }
    updateCalibCenter(c);
  } else if (c.stage === 'range') {
    const key = `range|${c.active_arm}|${c.guided ? c.guided.joint + '#' + c.guided.index : 'free'}`;
    if (key !== calibKey) {
      if (Date.now() < calibHoldUntil && calibKey.startsWith('range|')) {
        // extreme_hit 星星還在飛：先不重建，僅動態更新
      } else {
        calibKey = key;
        body.innerHTML = buildCalibRange(c);
      }
    }
    updateCalibRange(c);
  } else { // saving
    const key = `saving|${c.active_arm}`;
    if (key !== calibKey) {
      calibKey = key;
      body.innerHTML = `<div class="card saving-box"><div class="spinner"></div>
        正在寫入校準（馬達暫存器 + JSON 檔）… <span class="en">saving…</span></div>`;
    }
  }
}

function buildCalibChooser(st) {
  const arm = (role, emoji, zh) => {
    const a = st?.arms?.[role];
    const enab = st?.phase === 'idle' && a?.connected;
    // 晶片只放狀態、日期另外一行 —— 混在一起長度不一會折行，
    // 兩張卡的按鈕就被推到不同高度，看起來歪歪的（Neo 2026-08-20 回報）
    const chip = !a?.connected ? '<span class="chip warn">未連線</span>'
      : a.calib_kind === 'partial' ? '<span class="chip warn">◐ 部分校準</span>'
        : a.calibrated ? '<span class="chip ok">✓ 已校準</span>'
          : '<span class="chip warn">未校準</span>';
    const when = a?.connected && a.calibrated && a.calib_file_date
      ? esc(a.calib_file_date) : '';
    return `<div class="card">
      <h3>${emoji} ${zh} <span class="en">${role}</span></h3>
      <div class="pick-status">${chip}</div>
      <div class="pick-date">${when}</div>
      <button class="big primary armpick" data-action="calib-start" data-arm="${role}" ${enab ? '' : 'disabled'}>
        🎯 校準 ${zh} <span class="en">Calibrate</span></button>
    </div>`;
  };
  const hint = st && st.phase !== 'idle'
    ? `<div class="hint-bar">⚠ 目前狀態（${esc(st.phase)}）不能開始校準，請先回到就緒狀態。</div>` : '';
  const savedCard = lastCalibSaved ? buildSuccessCard(lastCalibSaved) : '';
  // 手腕旋轉對齊：wrist_roll 校準時不掃範圍，兩臂零點全憑目測——
  // 差十幾度 teleop 就會一邊頂到回彈、一邊到不了底。這裡量差值修 leader。
  const wristCard = bothCalibrated(st) ? `
    <div class="card wrist-align-card">
      <h3>🔄 手腕旋轉對齊 <span class="en">Wrist align</span></h3>
      <p class="tip">遙操作時手腕旋轉「一邊卡住回彈、另一邊轉不到底」？把<b>兩隻手臂的手腕轉到同一個方向</b>（夾爪同向、黑點對齊），再按對齊——差值會修進 Leader，錄好的資料和模型不受影響。</p>
      <div class="kv">目前兩臂手腕差　<b id="wristDelta">—</b></div>
      <button class="big" data-action="wrist-align" ${st?.phase === 'idle' ? '' : 'disabled'}>🔄 對齊手腕 <span class="en">Align</span></button>
    </div>` : '';
  return `${savedCard}${hint}${buildCompareCard(st)}
    <p>校準分兩步：<b>1. 置中</b>（把每個關節扶到中間）→ <b>2. 掃極限</b>（把每個關節轉到兩邊盡頭）。馬達會放鬆，請扶好手臂。</p>
    <div class="calib-choose">
      ${arm('follower', '🦾', 'Follower（跟隨臂）')}
      ${arm('leader', '🕹', 'Leader（主控臂）')}
    </div>
    ${wristCard}`;
}

/* ⚖ 校準比一比：手臂裡的校準 ≠ 本機記錄時，同一個姿勢下量兩套的誤差，讓使用者選 */
function buildCompareCard(st) {
  const cmp = st?.compare;
  const anyAlt = ['leader', 'follower'].some((r) => st?.arms?.[r]?.alt_calib);
  if (!anyAlt && !cmp?.active) return '';
  if (!cmp?.active) {
    return `<div class="card compare-card">
      <h3>⚖ 校準比一比 <span class="en">Compare</span></h3>
      <p class="tip">這隻手臂身上帶的校準跟這台電腦記錄的不一樣。先把<b>兩隻手臂都擺到置中姿勢</b>（黑點對齊），再按開始——我會在同一個姿勢下量兩套校準的誤差，數字小的比較準。目前先用手臂裡的那套。</p>
      <button class="big primary" data-action="compare-start" ${st?.phase === 'idle' ? '' : 'disabled'}>⚖ 開始比對 <span class="en">Start</span></button>
    </div>`;
  }
  const cols = cmp.sets.map((s) => `<th id="cmp-${s.key}-head">${esc(s.label)}</th>`).join('');
  const row = (label, cellId) => `<tr><td>${label}</td>${cmp.sets.map((s) => `<td id="cmp-${s.key}-${cellId}">—</td>`).join('')}</tr>`;
  return `<div class="card compare-card">
    <h3>⚖ 校準比一比 <span class="en">Compare</span></h3>
    <p class="tip">把兩隻手臂擺到<b>置中姿勢</b>並保持不動，數字會即時更新。「置中誤差」＝這套的零點離你擺的姿勢多遠；「雙臂一致」＝同一姿勢下 leader 與 follower 差多少（遙操作歪不歪的直接原因）。都是越小越好。</p>
    <div class="table-wrap"><table class="compare-table">
      <thead><tr><th></th>${cols}</tr></thead>
      <tbody>
        ${row('置中誤差 · Follower', 'follower-center')}
        ${row('置中誤差 · Leader', 'leader-center')}
        ${cmp.pair ? row('雙臂一致（越小越好）', 'pair') : ''}
        ${row('各關節（Follower）', 'follower-joints')}
        ${row('各關節（Leader）', 'leader-joints')}
        <tr><td>建議</td>${cmp.sets.map((s) => `<td id="cmp-${s.key}-rec"></td>`).join('')}</tr>
      </tbody>
    </table></div>
    <div class="row">
      ${cmp.sets.map((s) => `<button class="big go" data-action="compare-apply" data-set="${s.key}">用「${esc(s.label)}」這套</button>`).join('')}
      <button class="big" data-action="compare-stop">先不比 <span class="en">Later</span></button>
    </div>
    <p class="tip">選了之後會寫進馬達、更新備份；另一套會存成快照，不會丟。</p>
  </div>`;
}

function updateCompare(st) {
  const cmp = st?.compare;
  if (!cmp?.active) return;
  const fmt = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}°`);
  for (const s of cmp.sets) {
    for (const role of ['follower', 'leader']) {
      const a = s.arms?.[role];
      const c = $(`#cmp-${s.key}-${role}-center`);
      if (c) c.textContent = fmt(a?.center_err);
      const j = $(`#cmp-${s.key}-${role}-joints`);
      if (j) {
        const txt = a?.joints ? JOINTS.map((k) => `${JOINT_ZH[k]} ${fmt(a.joints[k])}`).join('、') : '—';
        if (j.textContent !== txt) j.textContent = txt;
      }
    }
    const p = $(`#cmp-${s.key}-pair`);
    if (p) p.textContent = fmt(s.pair_err);
    const r = $(`#cmp-${s.key}-rec`);
    if (r) r.textContent = cmp.recommended === s.key ? '✅ 比較準' : (cmp.recommended ? '' : '（差不多）');
  }
}

function updateWristDelta() {
  const el = $('#wristDelta');
  if (!el || !tickMsg?.joints) return;
  const l = tickMsg.joints.leader?.wrist_roll;
  const f = tickMsg.joints.follower?.wrist_roll;
  if (l == null || f == null) { el.textContent = '—'; return; }
  let d = f - l;                       // wrap 到 ±180°
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  const txt = `${d > 0 ? '+' : ''}${d.toFixed(1)}°`;
  if (el.textContent !== txt) el.textContent = txt;
}

function buildSuccessCard(saved) {
  const rangeRows = saved.ranges
    ? `<p class="tip">${saved.ranges.map((r) => `${esc(JOINT_ZH[r.j] || r.j)} ${r.min ?? '—'}–${r.max ?? '—'}`).join(' · ')}</p>` : '';
  return `<div class="success-card">
    <h3>🎉 ${saved.arm === 'leader' ? 'Leader' : 'Follower'} 校準完成！</h3>
    <p>校準檔已寫入馬達與磁碟，之後開機會自動載入。</p>
    ${saved.text ? `<p class="path">${esc(saved.text)}</p>` : ''}
    ${rangeRows}
    <button class="big go" data-action="calib-dismiss">好耶！ <span class="en">Nice</span></button>
  </div>`;
}

function buildCalibCenter(c) {
  const caps = JOINTS.map((j) => `
    <div class="jcap" data-joint="${j}">
      <div class="jcap-check">✓</div>
      <div class="jcap-name">${jnum(j)}${JOINT_ZH[j]}<span class="en">${JOINT_EN[j]}</span></div>
      <div class="jcap-deg">—</div>
    </div>`).join('');
  const C = 2 * Math.PI * 56;
  return `
    <div class="calib-stage-head">
      <span class="stageno">步驟 1／2</span>
      <h3>把每個關節移到中間 <span class="en">center every joint</span></h3>
    </div>
    <div class="hint-bar">🖐 馬達已放鬆——請用手輕輕把 ${c.active_arm === 'leader' ? 'Leader' : 'Follower'} 的每個關節扶到「正中間」，半透明的白色姿勢就是目標。擺好後按「手動確認置中」，或直接開口說「我確認」🎤。</div>
    ${c.kept_old_cal ? `<div class="hint-bar recal">♻️ 這隻手臂之前校準過——預覽先沿用舊設定，所以現在畫面和實體是一致的；<b>按下確認的那一刻才會重新歸零</b>，只會小小修正一下。</div>` : ''}
    <div class="calib-viewer" id="calibViewerSlot"></div>
    <div class="jcaps">${caps}</div>
    <div class="countdown" id="calibCountdown" hidden>
      <svg viewBox="0 0 140 140">
        <circle class="ring-bg" cx="70" cy="70" r="56"></circle>
        <circle class="ring-fg" cx="70" cy="70" r="56" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="0"></circle>
        <circle cx="70" cy="70" r="34" fill="#22221e"></circle>
        <circle cx="59" cy="63" r="4.5" fill="#fff"></circle>
        <circle cx="81" cy="63" r="4.5" fill="#fff"></circle>
        <path d="M60 79 Q70 87 80 79" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"></path>
      </svg>
      <div class="cd-label">保持不動 <b id="cdSecs">2.0</b> s</div>
    </div>
    <div class="row">
      <button class="big" data-action="calib-confirm">✅ 手動確認置中 <span class="en">Confirm</span></button>
      <button class="big" data-action="calib-abort">✖ 放棄 <span class="en">Abort</span></button>
    </div>`;
}

let prevAutoConfirm = null;
function updateCalibCenter(c) {
  for (const j of JOINTS) {
    const jr = c.joints?.[j];
    const cap = $(`.jcap[data-joint="${j}"]`);
    if (!jr || !cap) continue;
    cap.classList.toggle('on', !!jr.centered);
    cap.classList.toggle('far', !!jr.out_of_band);  // 離舊中心很遠（角度顯示會誇張）
    const degEl = $('.jcap-deg', cap);
    const txt = `${jr.deg > 0 ? '+' : ''}${Number(jr.deg).toFixed(1)}°`;
    if (degEl.textContent !== txt) degEl.textContent = txt;
  }
  const cd = $('#calibCountdown');
  if (!cd) return;
  const auto = c.auto_confirm_in;
  cd.hidden = !(c.all_centered && auto != null);
  if (!cd.hidden) {
    const C = 2 * Math.PI * 56;
    $('.ring-fg', cd).style.strokeDashoffset = (C * clamp(auto / 2, 0, 1)).toFixed(1);
    $('#cdSecs').textContent = Number(auto).toFixed(1);
    if (prevAutoConfirm == null || Math.floor(prevAutoConfirm * 2) !== Math.floor(auto * 2)) tickTock();
    prevAutoConfirm = auto;
  } else {
    prevAutoConfirm = null;
  }
}

/* 弧形量表幾何：190° 扇形、48 刻度，中心 (160,180) */
const GAUGE = { cx: 160, cy: 180, rIn: 106, rOut: 128, rNeedle: 96, rDot: 142, span: 95, ticks: 48 };
function gaugePoint(aDeg, r) {
  const rad = aDeg * Math.PI / 180;
  return { x: GAUGE.cx + r * Math.sin(rad), y: GAUGE.cy - r * Math.cos(rad) };
}
function buildCalibRange(c) {
  const g = c.guided;
  const ticks = Array.from({ length: GAUGE.ticks }, (_, i) => {
    const a = -GAUGE.span + i * (2 * GAUGE.span) / (GAUGE.ticks - 1);
    const p1 = gaugePoint(a, GAUGE.rIn);
    const p2 = gaugePoint(a, GAUGE.rOut);
    return `<line class="gauge-tick" data-a="${a.toFixed(2)}" x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}"></line>`;
  }).join('');
  const dMin = gaugePoint(-GAUGE.span, GAUGE.rDot);
  const dMax = gaugePoint(GAUGE.span, GAUGE.rDot);
  const chips = JOINTS.map((j) => {
    if (j === 'wrist_roll') return `<span class="range-chip free" data-chip="${j}">${jnum(j)}${JOINT_ZH[j]} 免掃</span>`;
    return `<span class="range-chip" data-chip="${j}">${jnum(j)}<span class="ct">${JOINT_ZH[j]}</span></span>`;
  }).join('');
  const jointName = g ? JOINT_ZH[g.joint] : '';
  return `
    <div class="calib-stage-head">
      <span class="stageno">步驟 2／2</span>
      <h3>掃出每個關節的活動範圍 <span class="en">sweep the range</span></h3>
      ${g ? `<span class="en">關節 ${g.index + 1}／${g.total}</span>` : ''}
    </div>
    <div class="calib-viewer" id="calibViewerSlot"></div>
    <p class="guide-line">請把「<b>${g ? jnum(g.joint) : ''}${esc(jointName)}</b>」轉到<span class="side-hint" id="sideHint">其中一邊</span>的盡頭，停住一下下</p>
    <div class="gauge-wrap">
      <svg viewBox="0 0 320 210">
        ${ticks}
        <g id="gaugeNeedle" transform="rotate(0 ${GAUGE.cx} ${GAUGE.cy})">
          <line class="gauge-needle" x1="${GAUGE.cx}" y1="${GAUGE.cy - GAUGE.rNeedle}" x2="${GAUGE.cx}" y2="${GAUGE.cy - 26}"></line>
        </g>
        <circle class="gauge-hub" cx="${GAUGE.cx}" cy="${GAUGE.cy}" r="12"></circle>
        <circle class="gauge-face-eye" cx="${GAUGE.cx - 4}" cy="${GAUGE.cy - 2}" r="1.8"></circle>
        <circle class="gauge-face-eye" cx="${GAUGE.cx + 4}" cy="${GAUGE.cy - 2}" r="1.8"></circle>
      </svg>
      <div class="gauge-dot" data-side="min" style="left:${(dMin.x / 320 * 100).toFixed(1)}%;top:${(dMin.y / 210 * 100).toFixed(1)}%"></div>
      <div class="gauge-dot" data-side="max" style="left:${(dMax.x / 320 * 100).toFixed(1)}%;top:${(dMax.y / 210 * 100).toFixed(1)}%"></div>
      <div class="gauge-deg" id="gaugeDeg">0.0°</div>
    </div>
    <p class="span-line" id="spanLine"></p>
    <div class="range-chips">${chips}</div>
    <div class="row" style="justify-content:center">
      <button class="big" data-action="calib-skip">⏭ 跳過此關節 <span class="en">Skip</span></button>
      <button class="big go" data-action="calib-finish">🏁 完成校準 <span class="en">Finish</span></button>
      <button class="big" data-action="calib-abort">✖ 放棄 <span class="en">Abort</span></button>
    </div>`;
}

function updateCalibRange(c) {
  const g = c.guided;
  const j = g ? g.joint : null;
  if (!j || !c.joints?.[j]) return;
  const jr = c.joints[j];
  const needle = $('#gaugeNeedle');
  if (!needle) return;
  const aCur = clamp(Number(jr.deg) || 0, -GAUGE.span, GAUGE.span);
  needle.setAttribute('transform', `rotate(${aCur.toFixed(1)} ${GAUGE.cx} ${GAUGE.cy})`);
  const aMin = clamp(degOfRaw(jr.min ?? CENTER), -GAUGE.span, GAUGE.span);
  const aMax = clamp(degOfRaw(jr.max ?? CENTER), -GAUGE.span, GAUGE.span);
  for (const t of $$('.gauge-tick')) {
    const a = Number(t.dataset.a);
    t.classList.toggle('lit', a >= aMin - 2.1 && a <= aMax + 2.1);
  }
  const degEl = $('#gaugeDeg');
  const txt = `${jr.deg > 0 ? '+' : ''}${Number(jr.deg).toFixed(1)}°`;
  if (degEl.textContent !== txt) degEl.textContent = txt;
  const minDot = $('.gauge-dot[data-side="min"]');
  const maxDot = $('.gauge-dot[data-side="max"]');
  if (minDot) {
    minDot.classList.toggle('done', !!jr.done_min);
    minDot.classList.toggle('hint', !jr.done_min && g.side === 'min');
  }
  if (maxDot) {
    maxDot.classList.toggle('done', !!jr.done_max);
    maxDot.classList.toggle('hint', !jr.done_max && g.side === 'max');
  }
  const sideHint = $('#sideHint');
  if (sideHint) {
    const want = jr.done_min && !jr.done_max ? '另一邊（+）' : jr.done_max && !jr.done_min ? '另一邊（−）' : '其中一邊';
    if (sideHint.textContent !== want) sideHint.textContent = want;
  }
  const span = (jr.max ?? 0) - (jr.min ?? 0);
  const spanEl = $('#spanLine');
  if (spanEl) {
    spanEl.innerHTML = `已掃範圍 <b>${span}</b> ticks（需 ≥ 400）${jr.span_ok ? ' <b>✓</b>' : ''}`;
  }
  for (const chip of $$('.range-chip')) {
    const cj = chip.dataset.chip;
    if (cj === 'wrist_roll') continue;
    const cjr = c.joints[cj];
    const done = cjr && cjr.done_min && cjr.done_max;
    chip.classList.toggle('done', !!done);
    chip.classList.toggle('now', cj === j && !done);
    const base = JOINT_ZH[cj];
    const want = done ? `✓ ${base}` : base;
    const ct = $('.ct', chip);
    if (ct && ct.textContent !== want) ct.textContent = want;
  }
}

/* ── ③ 遙操作 ── */
function renderTeleop(st) {
  renderBanner('teleop', st);
  const hint = $('#hint-teleop');
  const cal = bothCalibrated(st);
  hint.hidden = cal;
  if (!cal) hint.textContent = '⚠ 請先完成 ② 校準（雙臂都要）';
  $('#btnTeleopStart').disabled = !(st && st.phase === 'idle' && cal);
  $('#btnTeleopStop').disabled = !(st && st.phase === 'teleop');
  const hz = st?.teleop?.hz;
  const stat = $('#hzStat');
  stat.hidden = !(st && st.phase === 'teleop');
  if (!stat.hidden) $('b', stat).textContent = hz != null ? Number(hz).toFixed(1) : '—';
}

/* ── ④ 錄製 ── */
let recordKey = '';
function renderRecord(st) {
  renderBanner('record', st);
  const recording = st?.phase === 'recording' && st.record;
  const hint = $('#hint-record');
  const cal = bothCalibrated(st);
  hint.hidden = recording || cal;
  if (!hint.hidden) hint.textContent = '⚠ 請先完成 ② 校準（雙臂都要）';
  $('#recordForm').hidden = !!recording;
  $('#btnRecordStart').disabled = !(st && st.phase === 'idle' && cal);
  const live = $('#recordLive');
  live.hidden = !recording;
  if (!recording) { recordKey = ''; return; }
  const r = st.record;
  const saved = r.saved_episodes ?? r.episodes ?? 0;
  const key = `rec|${r.repo_id}|${saved}`;
  if (key !== recordKey) {
    recordKey = key;
    live.innerHTML = `
      <div class="rec-bar"><span class="dot"></span> 錄製中：第 ${saved + 1} 集
        <span class="meta" id="recMeta"></span></div>
      <div class="card">
        <div class="kv">資料集　<b>${esc(r.repo_id || '')}</b>　已存 <b id="recSaved">${saved}</b> 集</div>
        <div class="row">
          <button class="big go" data-action="ep-save">💾 存這集 <span class="en">Save</span></button>
          <button class="big danger" data-action="ep-discard">🗑 棄這集 <span class="en">Discard</span></button>
          <button class="big" data-action="record-finish">📦 完成收檔 <span class="en">Finish</span></button>
        </div>
        <p class="tip">💡 用 Leader 帶著 Follower 做一次任務，做完按「存這集」。</p>
      </div>`;
  }
  const meta = $('#recMeta');
  if (meta) {
    const el = r.elapsed != null ? `${Number(r.elapsed).toFixed(1)}s` : '';
    const fr = r.frames != null ? ` · ${r.frames} 格` : '';
    meta.textContent = `${el}${fr} · ${r.fps ?? 30} fps`;
  }
  if (datasets.length === 0) datasetsAt = 0; // 收檔後會重抓
}

async function startRecordFromForm() {
  const name = $('#recName').value.trim();
  const task = $('#recTask').value.trim();
  const fps = Number($('#recFps').value) || 30;
  if (!name) { toast('請先取一個資料集名稱', 'error'); return; }
  await api('/record/start', { body: { name, task, fps } }).catch(() => {});
}

/* ── ⑤ 回放 ── */
let replayKey = '';
function renderReplay(st) {
  const body = $('#replayBody');
  const hint = $('#hint-replay');
  const replaying = st?.phase === 'replaying' && st.replay;
  const followerCal = !!st?.arms?.follower?.calibrated;
  hint.hidden = replaying || followerCal;
  if (!hint.hidden) hint.textContent = '⚠ Follower 要先完成 ② 校準才能回放';

  if (!replaying && st?.phase === 'idle' && Date.now() - datasetsAt > 5000) refreshDatasets();

  if (replaying) {
    const r = st.replay;
    const key = `play|${r.repo_id}|${r.episode}`;
    if (key !== replayKey) {
      replayKey = key;
      body.innerHTML = `<div class="card">
        <h3>▶ 正在回放 <b class="mono">${esc(r.repo_id)}</b> · 第 ${Number(r.episode) + 1} 集</h3>
        <div class="progress-outer"><div class="progress-inner" id="replayProg"></div></div>
        <button class="big danger" data-action="replay-stop">⏹ 停止回放 <span class="en">Stop</span></button>
      </div>`;
    }
    const prog = $('#replayProg');
    if (prog) prog.style.width = `${clamp((r.progress ?? 0) * 100, 0, 100).toFixed(1)}%`;
    return;
  }

  const canPlay = st?.phase === 'idle' && followerCal;
  const key = `list|${JSON.stringify(datasets)}|${canPlay}`;
  if (key === replayKey) return;
  replayKey = key;
  if (!datasets.length) {
    body.innerHTML = `<div class="card"><p>還沒有資料集。先到 ④ 錄製收集幾集吧！ <span class="en">No datasets yet</span></p></div>`;
    return;
  }
  body.innerHTML = `
    <p class="replay-warn">⚠ 回放時 Follower 會實際移動，請先清空手臂周圍的桌面。</p>
    ${datasets.map((d) => `
      <div class="card ds-card">
        <div>
          <div class="ds-name">📼 ${esc(d.repo_id)}</div>
          <div class="ds-meta">${d.episodes ?? '?'} 集 · ${d.fps ?? '?'} fps · ${esc(d.created || '')}</div>
        </div>
        <div class="ep-pick">
          <label>集數 <input type="number" min="0" max="${Math.max(0, (d.episodes ?? 1) - 1)}" value="0"></label>
          <button class="big primary" data-action="replay-start" data-repo="${esc(d.repo_id)}" ${canPlay ? '' : 'disabled'}>▶ 播放</button>
          <button class="big" data-action="train-goto" data-repo="${esc(d.repo_id)}" title="把這一整包資料集（全部集數）送到 ⑥ 智慧做本機訓練">🎓 拿去訓練</button>
        </div>
      </div>`).join('')}`;
}

async function refreshDatasets() {
  if (datasetsBusy) return;
  datasetsBusy = true;
  datasetsAt = Date.now();
  try {
    const list = await api('/datasets', { method: 'GET' });
    if (Array.isArray(list)) datasets = list;
  } catch (e) { /* toast 已顯示 */ } finally {
    datasetsBusy = false;
  }
}

/* ── ⑥ 智慧 ── */
let smartKey = '';
async function refreshModels() {
  if (modelsBusy) return;
  modelsBusy = true;
  modelsAt = Date.now();
  try {
    const list = await api('/models', { method: 'GET' });
    if (Array.isArray(list)) models = list;
  } catch (e) { /* toast 已顯示 */ } finally {
    modelsBusy = false;
  }
}

async function refreshForge() {
  if (DEVMOCK || Date.now() - forgeAt < 60000) return;
  forgeAt = Date.now();
  try {
    const r = await fetch('/api/forge/status');
    const info = await r.json();
    const was = !!forgeInfo?.reachable;
    forgeInfo = info;
    if (was !== !!info.reachable) { smartKey = ''; render(); } // 可達性變了才重畫
  } catch (e) { /* 下次再試 */ }
}

function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 私密視窗等 */ } }

function renderSmart(st) {
  const body = $('#smartBody');
  const hint = $('#hint-smart');
  const smartRunning = st?.phase === 'smart' && st.smart;
  const train = st?.train;
  const training = !!train?.active;
  const followerCal = !!st?.arms?.follower?.calibrated;

  // 訓練剛結束 → 立刻重抓模型清單，新的智慧動作馬上出現
  if (lastTrainActive && !training) { modelsAt = 0; }
  lastTrainActive = training;

  hint.hidden = smartRunning || followerCal;
  if (!hint.hidden) hint.textContent = '⚠ Follower 要先完成 ② 校準才能執行智慧動作（訓練不受影響）';

  if (!smartRunning && Date.now() - modelsAt > 5000) refreshModels();
  if (!smartRunning && st?.phase === 'idle' && Date.now() - datasetsAt > 5000) refreshDatasets();
  refreshForge();

  /* 執行中：只顯示執行卡 */
  if (smartRunning) {
    const s = st.smart;
    const key = `run|${s.model}|${s.status}`;
    if (key !== smartKey) {
      smartKey = key;
      body.innerHTML = s.status === 'loading'
        ? `<div class="card saving-box"><div class="spinner"></div>
            正在載入模型「${esc(s.model)}」… <span class="en">loading…</span></div>`
        : `<div class="card">
            <h3>🧠 智慧動作執行中 <b class="mono">${esc(s.model)}</b></h3>
            <div class="kv" id="smartMeta">—</div>
            <button class="big danger" data-action="smart-stop">⏹ 停止 <span class="en">Stop</span></button>
            <p class="tip">💡 手臂正在自己動。有狀況就按停止，或直接關掉它的電源。</p>
          </div>`;
    }
    const meta = $('#smartMeta');
    if (meta && s.status === 'running') {
      meta.textContent = `已跑 ${Number(s.elapsed ?? 0).toFixed(1)}s · ${s.frame ?? 0} 格 · ${s.hz ?? 0} Hz`;
    }
    return;
  }

  /* 非執行中：訓練卡（若在訓練）＋ 智慧動作清單 ＋ 訓練新動作表單 */
  const canRun = st?.phase === 'idle' && followerCal && !training;
  const key = [
    'list', JSON.stringify(models), JSON.stringify(datasets.map((d) => d.repo_id)),
    training && `${train.model}|${train.status}`, canRun, trainPreselect,
    train?.status === 'failed' && train.model,
    forgeInfo && `${forgeInfo.reachable}|${forgeInfo.mode}|${forgeInfo.connected}|${forgeInfo.email}`,
  ].join('|');
  if (key === smartKey) {
    updateTrainProgress(train);
    return;
  }
  smartKey = key;

  const isForge = train?.where === 'forge';
  const trainCard = training ? `
    <div class="card train-card">
      <h3>${isForge ? '☁️ Forge 訓練中' : '🎓 訓練中'}：<b class="mono">${esc(train.model)}</b></h3>
      <div class="kv">資料集　<b class="mono">${esc(train.dataset || '')}</b>（${train.episodes ?? '?'} 集）· ${esc(train.device || '')}</div>
      <div class="progress-outer"><div class="progress-inner" id="trainProg"></div></div>
      <div class="kv" id="trainMeta">準備中…</div>
      <div class="row">
        <button class="big danger" data-action="train-stop">⏹ 中止訓練 <span class="en">Abort</span></button>
        ${isForge && train.forge_url ? `<a class="big" href="${esc(train.forge_url)}" target="_blank" rel="noopener">🔗 在 Forge 網頁看詳情</a>` : ''}
      </div>
      <p class="tip">💡 ${isForge ? '訓練在公司內網的 GPU 上跑，這台電腦完全不佔資源。關掉 App 訓練照跑，重開 App 會自動接手；完成後模型自動收回本機、出現在「你的智慧動作」。' : '訓練在背景進行，這段時間照樣可以遙操作、錄新資料。完成會有語音通知。'}</p>
    </div>` : '';

  const failCard = (!training && train?.status === 'failed') ? `
    <div class="hint-bar">⚠ 上次訓練「${esc(train.model || '')}」失敗了——看右邊操作日誌，或叫老師來救。</div>` : '';

  const modelCards = models.length ? models.map((m) => `
    <div class="card ds-card">
      <div>
        <div class="ds-name">🧠 ${esc(m.name)}</div>
        <div class="ds-meta">${m.dataset ? `來自 ${esc(m.dataset)}` : '來源不明（外部模型）'}${m.steps ? ` · ${m.steps} 步` : ''}${m.fps ? ` · ${m.fps} Hz` : ''}${m.size_mb != null ? ` · ${m.size_mb}MB` : ''} · ${esc(m.created || '')}</div>
        ${m.task ? `<div class="ds-meta">任務：${esc(m.task)}</div>` : ''}
      </div>
      <div class="ep-pick">
        <label>時長 <select data-smart-secs>${SMART_SECONDS_CHOICES.map((c) => `<option value="${c.v}"${c.v === 60 ? ' selected' : ''}>${c.label}</option>`).join('')}</select></label>
        <button class="big primary" data-action="smart-start" data-model="${esc(m.name)}" ${canRun ? '' : 'disabled'}>▶ 執行</button>
      </div>
    </div>`).join('')
    : `<div class="card"><p>還沒有訓練好的智慧動作。用下面的表單挑一包資料集開始訓練吧！ <span class="en">No models yet</span></p></div>`;

  const dsOptions = datasets.map((d) =>
    `<option value="${esc(d.repo_id)}"${d.repo_id === trainPreselect ? ' selected' : ''}>${esc(d.repo_id)}（${d.episodes ?? '?'} 集）</option>`).join('');
  const forgeOk = !!forgeInfo?.reachable;
  const forgeFront = forgeInfo?.mode === 'front';
  const forgeReady = forgeOk && (!forgeFront || forgeInfo?.connected); // 可以真的丟單
  const whereOptions = TRAIN_WHERE_CHOICES
    .filter((c) => c.v === 'local' || forgeReady)
    .map((c) => `<option value="${c.v}">${c.label}</option>`).join('');
  let forgeBlock = '';
  if (forgeReady) {
    forgeBlock = `
      <label>訓練位置 <span class="en">Where</span>
        <select id="trainWhere">${whereOptions}</select>
      </label>
      ${forgeFront
    ? `<p class="tip">🧪 Forge 已連結公司帳號：<b>${esc(forgeInfo.email || '')}</b>
         <button class="linklike" data-action="forge-disconnect">中斷連結</button></p>`
    : `<label class="forge-email-label">你的公司 email（Forge 記錄開單人；只在選 Forge 時需要）
        <input id="forgeEmail" type="email" placeholder="student@example.invalid" autocomplete="off" value="${esc(lsGet('forgeEmail'))}">
      </label>`}`;
  } else if (forgeOk && forgeFront) {
    // 偵測到 Forge（443 正門），但還沒連結公司 Google —— 🧪 實驗功能
    forgeBlock = `
      <div class="forge-connect">
        <p class="tip">🧪 <b>實驗</b>：偵測到公司的 Forge 訓練平臺。連結你的公司 Google 帳號
        （example.invalid）後，就能把訓練丟到機房 GPU／雲端。</p>
        <div class="row">
          <button class="big" data-action="forge-connect">🔐 連結公司 Google <span class="en">Connect</span></button>
        </div>
        ${forgeInfo.dns_ok === false ? `<p class="tip">⚠ 這台電腦解不到 <code>*.example.invalid</code>——
          第一次使用前請先加一行 hosts（終端機執行一次）：<br>
          <code>echo "127.0.0.1 compute.example.invalid compute-api.example.invalid" | sudo tee -a /etc/hosts</code></p>` : ''}
        <details class="forge-manual"><summary>用瀏覽器跑 OS？改用手動貼上 session</summary>
          <p class="tip">1. 開 <a href="${esc(forgeInfo.web || '#')}" target="_blank" rel="noopener">Forge 網頁</a>完成 Google 登入
          → 2. 開發者工具 → Application → Cookies → 複製 <code>_oauth2_proxy</code> 的值
          → 3. 貼進來（格式 <code>_oauth2_proxy=…</code>）：</p>
          <input id="forgeCookie" type="text" placeholder="_oauth2_proxy=…" autocomplete="off">
          <button class="big" data-action="forge-paste-session">儲存 session</button>
        </details>
      </div>`;
  }
  const trainForm = `
    <div class="card" id="trainForm">
      <h3>🎓 訓練新的智慧動作 <span class="en">Train</span></h3>
      ${datasets.length ? `
      <label>用哪包資料集（一整包、所有集數都會用上）
        <select id="trainDataset">${dsOptions}</select>
      </label>
      <label>幫這個智慧動作取名字 <span class="en">Model name</span>
        <input id="trainName" type="text" placeholder="例如 pick_jar_act" autocomplete="off">
      </label>
      <label>訓練量
        <select id="trainSteps">${TRAIN_STEPS_CHOICES.map((c, i) => `<option value="${c.v}"${i === 1 ? ' selected' : ''}>${c.label}</option>`).join('')}</select>
      </label>
      ${forgeBlock}
      <button class="big primary" data-action="train-start" ${training ? 'disabled' : ''}>🎓 開始訓練 <span class="en">Start training</span></button>
      <p class="tip">💡 資料越多學得越好：同一個動作至少錄 20–30 集再訓練，成功率會高很多。</p>
      <p class="tip">⏱ 速度參考：本機 M 系列約 5 步/秒（2 萬步 ≈ 1 小時）；Forge 機房 GPU 快數倍，適合 10 萬步的完整訓練。</p>
      ` : '<p>還沒有資料集可以訓練。先到 ④ 錄製收集幾集吧！</p>'}
    </div>`;

  body.innerHTML = `${trainCard}${failCard}
    <h3 class="smart-section">你的智慧動作 <span class="en">Your smart moves</span></h3>
    ${modelCards}
    ${trainForm}`;
  updateTrainProgress(train);
}

function updateTrainProgress(train) {
  if (!train?.active) return;
  const prog = $('#trainProg');
  if (prog) prog.style.width = `${clamp((train.progress ?? 0) * 100, 0, 100).toFixed(1)}%`;
  const meta = $('#trainMeta');
  if (meta) {
    const parts = [];
    if (train.where === 'forge' && train.forge_status) parts.push(train.forge_status);
    if (train.step > 0 && train.total) parts.push(`${train.step} / ${train.total} 步`);
    if (train.loss != null) parts.push(`loss ${train.loss}`);
    if (train.rate) {
      parts.push(`${train.rate} 步/秒`);
      const remain = Math.max(0, (train.total - train.step) / train.rate);
      parts.push(`剩約 ${remain > 90 ? Math.round(remain / 60) + ' 分鐘' : Math.round(remain) + ' 秒'}`);
    }
    meta.textContent = parts.length ? parts.join(' · ') : '準備中（第一次要先載入資料）…';
  }
}

async function startTrainFromForm() {
  const repo = $('#trainDataset')?.value || '';
  let name = ($('#trainName')?.value || '').trim();
  const steps = Number($('#trainSteps')?.value) || 20000;
  const where = $('#trainWhere')?.value || 'local';
  if (!repo) { toast('請先選一包資料集', 'error'); return; }
  if (!name) {
    // 沒取名就從資料集名字生一個：neo/os_pick_jar → pick_jar_act
    name = repo.split('/').pop().replace(/^os_/, '') + '_act';
  }
  if (where === 'local') {
    const ok = await confirmDialog(`要用「${repo}」的全部集數訓練「${name}」嗎？\n訓練會讓電腦忙一陣子（風扇會轉），期間照樣能錄資料。`);
    if (!ok) return;
    await api('/train/start', { body: { repo_id: repo, model_name: name, steps } }).catch(() => {});
  } else {
    let email = '';
    if (forgeInfo?.mode !== 'front') {  // 後門模式才要手填；正門身分來自 Google session
      email = ($('#forgeEmail')?.value || '').trim();
      if (!email.includes('@')) { toast('選 Forge 訓練要先填公司 email', 'error'); return; }
      lsSet('forgeEmail', email);
    }
    const fleet = where === 'forge-nebius' ? 'nebius' : 'local';
    const label = fleet === 'nebius' ? 'Forge 雲端（Nebius，會產生費用）' : 'Forge 本地機房 GPU';
    const ok = await confirmDialog(`要把「${repo}」送到 ${label} 訓練「${name}」嗎？\n資料集會先複製到公司 NAS，完成後模型自動收回這台電腦。`);
    if (!ok) return;
    await api('/forge/train', { body: { repo_id: repo, model_name: name, steps, email, fleet } }).catch(() => {});
  }
  trainPreselect = '';
  smartKey = '';
  render();
}

async function smartStart(btn) {
  const model = btn.dataset.model;
  const secs = Number(btn.closest('.ep-pick')?.querySelector('[data-smart-secs]')?.value ?? 60);
  const ok = await confirmDialog(`手臂會自己動，請先清空手臂周圍的桌面！\n要執行智慧動作「${model}」嗎？${secs ? `（${secs} 秒後自動停）` : '（直到手動停止）'}`);
  if (!ok) return;
  api('/smart/start', { body: { model, seconds: secs } }).catch(() => {});
}

/* ── aside：日誌 ── */
let logCache = '';
function renderLog(st) {
  const lines = (st && st.log) || [];
  const text = lines.join('\n');
  if (text === logCache) return;
  const box = $('#logBox');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  logCache = text;
  box.textContent = text;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/* ── 3D 檢視器擺位與覆蓋 ── */
function updateViewerPlacement(st) {
  if (!viewer) return;
  let slot = $('#asideViewerSlot');
  if (activePanel === 'calib' && st?.phase === 'calibrating') {
    slot = $('#calibViewerSlot') || slot;
  } else if (activePanel === 'teleop') {
    slot = $('#teleopViewerSlot');
  }
  viewer.moveTo(slot);
  $('#asideViewerNote').hidden = (slot === $('#asideViewerSlot'));
}
let lastGhost = null;
let lastHl = '';
function updateViewerOverlays(st) {
  if (!viewer) return;
  const c = st?.calib;
  const calibrating = st?.phase === 'calibrating' && c;
  const ghost = (calibrating && c.stage === 'center') ? c.active_arm : null;
  if (ghost !== lastGhost) { lastGhost = ghost; viewer.setGhost(ghost); }
  const hl = (calibrating && c.stage === 'range' && c.guided) ? `${c.active_arm}|${c.guided.joint}` : '|';
  if (hl !== lastHl) {
    lastHl = hl;
    const [arm, joint] = hl.split('|');
    viewer.setHighlight(arm || null, joint || null);
  }
  // 關節標註＋鏡頭聚焦：只在校準置中／掃範圍時出現（存檔中、其他頁一律清掉）
  const showCo = calibrating && (c.stage === 'center' || c.stage === 'range') && activePanel === 'calib';
  viewer.focusArm(showCo ? c.active_arm : null);
  viewer.setCallouts(showCo ? buildCallouts(c) : null);
}

/** 校準狀態 → 3D 關節標註規格（見 viewer3d setCallouts） */
function buildCallouts(c) {
  const hov = calibHoverJoint;
  const items = JOINTS.map((j, i) => {
    const jr = c.joints?.[j] || {};
    const base = { joint: j, num: i + 1, name: JOINT_ZH[j], en: JOINT_EN[j] };
    if (c.stage === 'center') {
      // 置中：六個全標名字（學「哪個是哪個」的時刻）；還沒到中間的虛線橘圈、到了綠圈
      const state = j === hov ? 'active' : jr.centered ? 'ok' : 'todo';
      return { ...base, state, showName: true };
    }
    // 掃範圍：正在掃的那顆大圈脈動＋名字；其他只留編號當參考
    const g = c.guided?.joint;
    const done = jr.done_min && jr.done_max;
    const state = j === g ? 'active' : done ? 'ok' : 'dim';
    return { ...base, state, showName: j === g || j === hov };
  });
  return { arm: c.active_arm, items };
}

/* ═══════════ 相機 snapshot 輪詢（EMYOS 模式） ═══════════ */
let camTimer = null;
let camErrs = 0;
function currentCam() {
  if (activePanel === 'connect') return { img: $('#camConnect'), wrap: $('#camConnectWrap') };
  if (activePanel === 'teleop') return { img: $('#camTeleop'), wrap: $('#camTeleopWrap') };
  return null;
}
function scheduleCam(ms) {
  clearTimeout(camTimer);
  camTimer = setTimeout(camTick, ms);
}
function camTick() {
  const t = currentCam();
  if (!t || document.hidden) { scheduleCam(400); return; }
  if (DEVMOCK) {
    const u = sim && sim.cameraFrame();
    if (!u) { scheduleCam(400); return; }
    t.img.src = u; // data URL，onload 會接著排下一張
  } else {
    t.img.src = `/api/camera/frame?cam=gripper&_=${Date.now()}`;
  }
}
function wireCam(img, wrap) {
  img.addEventListener('load', () => {
    camErrs = 0;
    wrap.classList.remove('cam-dead');
    scheduleCam(120); // ~8fps，onload 自我節流
  });
  img.addEventListener('error', () => {
    camErrs += 1;
    if (camErrs >= 3) wrap.classList.add('cam-dead'); // 連錯 3 次隱藏
    scheduleCam(800); // 800ms 重試自動復活
  });
}

/* ═══════════ 模擬人手滑桿（mock 模式限定） ═══════════ */
let simArm = 'follower';
let simLastInput = 0;
let simPending = {};
let simDebounce = null;
function buildSimhand() {
  const box = $('#simhandSliders');
  box.innerHTML = JOINTS.map((j) => `
    <div class="simslider">
      <span>${JOINT_ZH[j]}</span>
      <input type="range" min="0" max="4095" step="1" value="2047" data-simjoint="${j}">
      <span class="val" data-simval="${j}">2047</span>
    </div>`).join('');
  box.addEventListener('input', (ev) => {
    const inp = ev.target.closest('[data-simjoint]');
    if (!inp) return;
    simLastInput = Date.now();
    const j = inp.dataset.simjoint;
    $(`[data-simval="${j}"]`).textContent = inp.value;
    simPending[j] = Number(inp.value);
    clearTimeout(simDebounce);
    simDebounce = setTimeout(flushSimhand, 80); // 80ms debounce
  });
  $('#simhandToggle').addEventListener('click', () => {
    const b = $('#simhandBody');
    b.hidden = !b.hidden;
  });
  for (const tab of $$('.simtab')) {
    tab.addEventListener('click', () => {
      simArm = tab.dataset.arm;
      for (const t of $$('.simtab')) t.classList.toggle('active', t === tab);
      simLastInput = 0; // 立刻從 tick 同步
      renderSimhand();
    });
  }
}
function flushSimhand() {
  const joints = simPending;
  simPending = {};
  if (Object.keys(joints).length === 0) return;
  api('/mock/joints', { body: { arm: simArm, joints } }).catch(() => {});
}
function renderSimhand() {
  const panel = $('#simhandPanel');
  const isMock = tickMsg && tickMsg.mode === 'mock';
  panel.hidden = !isMock;
  if (!isMock || $('#simhandBody').hidden) return;
  if (Date.now() - simLastInput < 800) return; // 使用者拖動中，不要打架
  const degs = tickMsg.joints && tickMsg.joints[simArm];
  if (!degs) return;
  for (const j of JOINTS) {
    if (degs[j] == null) continue;
    const raw = clamp(rawOfDeg(degs[j]), 0, 4095);
    const inp = $(`[data-simjoint="${j}"]`);
    const val = $(`[data-simval="${j}"]`);
    if (inp && document.activeElement !== inp) inp.value = raw;
    if (val) val.textContent = String(raw);
  }
}

/* ═══════════ 動作分派（event delegation，rebuild 不掉 handler） ═══════════ */
function handleAction(btn) {
  const a = btn.dataset.action;
  const fire = (p, body) => api(p, body !== undefined ? { body } : {}).catch(() => {});
  switch (a) {
    case 'scan': fire('/scan'); break;
    case 'goto': setPanel(btn.dataset.panel); break;
    case 'calib-start':
      fire('/calib/start', { arm: btn.dataset.arm });
      setPanel('calib');
      break;
    case 'arm-adopt': fire('/arm/adopt', { arm: btn.dataset.arm }); break;
    case 'arm-reset': fire('/arm/reset_motors', { arm: btn.dataset.arm }); break;
    case 'arm-color':
      fire('/arm/color', { arm: btn.dataset.arm, color: btn.dataset.color || null });
      connectKey = '';  // 逼手臂卡重畫，色票的選取狀態才會更新
      break;
    case 'calib-confirm': fire('/calib/confirm_center'); break;
    case 'wrist-align': wristAlign(); break;
    case 'compare-goto': setPanel('calib'); fire('/calib/compare/start'); break;
    case 'compare-start': fire('/calib/compare/start'); break;
    case 'compare-stop': fire('/calib/compare/stop'); break;
    case 'compare-apply': compareApply(btn.dataset.set); break;
    case 'arm-restore': armRestore(btn.dataset.arm); break;
    case 'calib-skip': fire('/calib/next_joint'); break;
    case 'calib-finish': fire('/calib/finish'); break;
    case 'calib-abort': fire('/calib/abort'); break;
    case 'calib-dismiss': lastCalibSaved = null; calibKey = ''; render(); break;
    case 'teleop-start': fire('/teleop/start'); break;
    case 'teleop-stop': fire('/teleop/stop'); break;
    case 'record-start': startRecordFromForm(); break;
    case 'ep-save': fire('/record/episode/stop_save'); break;
    case 'ep-discard': twoPhaseDiscard(btn); break;
    case 'record-finish': fire('/record/finish'); break;
    case 'replay-start': replayStart(btn); break;
    case 'replay-stop': fire('/replay/stop'); break;
    case 'forge-connect': forgeConnect(); break;
    case 'forge-paste-session': forgePasteSession(); break;
    case 'forge-disconnect':
      api('/forge/disconnect').catch(() => {});
      forgeInfo = null; forgeAt = 0; smartKey = '';
      setTimeout(render, 300);
      break;
    case 'train-goto':
      trainPreselect = btn.dataset.repo || '';
      smartKey = '';
      setPanel('smart');
      break;
    case 'train-start': startTrainFromForm(); break;
    case 'train-stop': twoPhaseTrainStop(btn); break;
    case 'smart-start': smartStart(btn); break;
    case 'smart-stop': fire('/smart/stop'); break;
    case 'mock-center': mockCenter(); break;
    default: break;
  }
}

/* 危險操作兩段式：棄這集 → 確認棄置？（4 秒回彈） */
function twoPhaseDiscard(btn) {
  if (btn.dataset.armed) {
    clearTimeout(btn._armT);
    api('/record/episode/stop_discard').catch(() => {});
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.innerHTML = '🗑 棄這集 <span class="en">Discard</span>';
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.innerHTML = '⚠ 確認棄置？ <span class="en">Sure?</span>';
  btn._armT = setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.innerHTML = '🗑 棄這集 <span class="en">Discard</span>';
  }, 4000);
}

async function compareApply(set) {
  const label = tickMsg?.state?.compare?.sets?.find((s) => s.key === set)?.label || set;
  const ok = await confirmDialog(`要把「${label}」這套校準寫進兩隻手臂嗎？\n另一套會存成快照，之後還能復原。`);
  if (!ok) return;
  api('/calib/compare/apply', { body: { set } }).catch(() => {});
}

async function armRestore(arm) {
  const a = tickMsg?.state?.arms?.[arm];
  const ok = await confirmDialog(`要把上次的校準（${a?.restorable?.date || ''}）寫回${arm === 'leader' ? 'Leader' : 'Follower'} 的馬達嗎？`);
  if (!ok) return;
  api('/arm/restore', { body: { arm } }).catch(() => {});
}

async function wristAlign() {
  const ok = await confirmDialog('兩隻手臂的手腕現在都轉到同一個方向了嗎？\n（夾爪同向、黑點對齊）確認後就以現在的姿勢對齊。');
  if (!ok) return;
  try {
    const r = await api('/wrist/align');
    toast(r.adjusted ? `對齊完成：修正了 ${r.delta_deg}°` : `本來就對齊（差 ${r.delta_deg}°）`, 'success');
  } catch (e) { /* toast 已顯示 */ }
}

/* 🧪 Forge 正門 connect：開登入視窗（App 內 Swift 會自動交接 cookie），輪詢直到連上 */
let forgePolling = null;
function forgeConnect() {
  // 同步 window.open（await 之後開會被 popup 政策擋）；URL 已在 status 裡帶來
  const url = forgeInfo?.connect_url;
  if (!url) { toast('還沒偵測到 Forge，稍等幾秒再試', 'error'); return; }
  window.open(url, '_blank');  // App 內＝彈出視窗（Swift 接手交接 cookie）；瀏覽器＝新分頁
  toast('請在開啟的視窗完成公司 Google 登入…');
  {
    clearInterval(forgePolling);
    let tries = 0;
    forgePolling = setInterval(async () => {
      tries += 1;
      if (tries > 40) { clearInterval(forgePolling); return; }  // 2 分鐘放棄輪詢
      try {
        const res = await fetch('/api/forge/status?fresh=1');
        const info = await res.json();
        if (info.connected) {
          clearInterval(forgePolling);
          forgeInfo = info; smartKey = '';
          toast(`已連結：${info.email}`, 'success');
          render();
        }
      } catch (e) { /* 下次再試 */ }
    }, 3000);
  }
}

async function forgePasteSession() {
  const cookie = ($('#forgeCookie')?.value || '').trim();
  if (!cookie) { toast('先貼上 _oauth2_proxy=… 的 cookie', 'error'); return; }
  try {
    const r = await api('/forge/session', { body: { cookie } });
    forgeInfo = null; forgeAt = 0; smartKey = '';
    toast(`已連結：${r.email}`, 'success');
    render();
  } catch (e) { /* toast 已顯示 */ }
}

/* 中止訓練也走兩段式（幾十分鐘的進度不能誤觸丟掉） */
function twoPhaseTrainStop(btn) {
  if (btn.dataset.armed) {
    clearTimeout(btn._armT);
    const where = tickMsg?.state?.train?.where;
    api(where === 'forge' ? '/forge/stop' : '/train/stop').catch(() => {});
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.innerHTML = '⏹ 中止訓練 <span class="en">Abort</span>';
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.innerHTML = '⚠ 進度會丟掉，確定？ <span class="en">Sure?</span>';
  btn._armT = setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.innerHTML = '⏹ 中止訓練 <span class="en">Abort</span>';
  }, 4000);
}

async function replayStart(btn) {
  const repo = btn.dataset.repo;
  const input = btn.closest('.ep-pick')?.querySelector('input');
  const ep = Number(input?.value ?? 0);
  const ok = await confirmDialog(`Follower 會實際移動，請先清空手臂周圍的桌面！\n確定要播放 ${repo} 的第 ${ep + 1} 集嗎？`);
  if (!ok) return;
  api('/replay/start', { body: { repo_id: repo, episode: ep } }).catch(() => {});
}

function mockCenter() {
  const joints = {};
  for (const j of JOINTS) joints[j] = 2047;
  api('/mock/joints', { body: { arm: simArm, joints } }).catch(() => {});
  simLastInput = 0;
}

function setPanel(key) {
  if (!PANELS.includes(key)) return;
  if (activePanel === 'calib' && key !== 'calib' && tickMsg?.state?.compare?.active) {
    api('/calib/compare/stop').catch(() => {});  // 離開校準頁就停止比對
  }
  activePanel = key;
  if (key === 'replay' || key === 'record') datasetsAt = 0; // 進面板就重抓資料集
  if (key === 'smart') { datasetsAt = 0; modelsAt = 0; }    // 智慧頁兩份清單都要新
  render();
  scheduleCam(30);
}

/* ═══════════ 開機畫面 ═══════════ */
async function typeText(el, text, speed = 55) {
  el.classList.add('typing');
  el.textContent = '';
  for (const ch of text) {
    el.textContent += ch;
    await sleep(speed);
  }
  el.classList.remove('typing');
}
function wireBoot() {
  const overlay = $('#bootOverlay');
  const btn = $('#btnBoot');
  btn.addEventListener('click', async () => {
    initAudio();       // 第一次手勢：解鎖 Web Audio
    chime();           // 開機和弦
    btn.disabled = true;
    const alreadyRunning = tickMsg && tickMsg.state && tickMsg.state.phase !== 'boot';
    if (!alreadyRunning) api('/boot').catch(() => {});
    await typeText($('#bootTyper'), 'Hello，你好，我是 LeRobot 101。接下來我來協助你啟用。');
    await sleep(800);
    overlay.classList.add('gone');
    setTimeout(() => { overlay.hidden = true; }, 750);
    scheduleCam(50);
  });
}

/* ═══════════ 啟動 ═══════════ */
function init() {
  viewer = createViewer($('#asideViewerSlot'));

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (btn && !btn.disabled) { handleAction(btn); return; }
    const step = ev.target.closest('#stepNav .step');
    if (step) setPanel(step.dataset.panel);
  });
  // 滑鼠停在關節卡／範圍晶片上 → 3D 圈出那一顆（卡片名字 ⇄ 實體位置對照）
  const calibBody = $('#calibBody');
  const setHover = (j) => {
    if (j === calibHoverJoint) return;
    calibHoverJoint = j;
    for (const el of $$('.jcap, .range-chip', calibBody)) {
      el.classList.toggle('hov', !!j && (el.dataset.joint || el.dataset.chip) === j);
    }
    updateViewerOverlays(tickMsg ? tickMsg.state : null);
  };
  calibBody.addEventListener('mouseover', (ev) => {
    const el = ev.target.closest('.jcap[data-joint], .range-chip[data-chip]');
    setHover(el ? (el.dataset.joint || el.dataset.chip) : null);
  });
  calibBody.addEventListener('mouseleave', () => setHover(null));
  $('#camSelect').addEventListener('change', async (ev) => {
    if (ev.target.value === '') return; // 「（偵測中…）」佔位選項
    const opt = ev.target.selectedOptions && ev.target.selectedOptions[0];
    const name = opt ? (opt.dataset.name || '') : '';
    camPendingName = name;
    camPendingAt = Date.now();
    ev.target.disabled = true;
    for (const wrap of [$('#camConnectWrap'), $('#camTeleopWrap')]) {
      if (wrap) wrap.classList.add('cam-switching');
    }
    // 名稱一起送：清單可能已過期（iPhone／虛擬相機出沒會讓 index 整批位移），
    // 後端以名稱為準才不會記到別台
    try {
      await api('/camera/select', { body: { index: +ev.target.value, name } });
      camListAt = 0; // 切換期間每 300ms 對齊一次實際來源
      toast(`正在切換到「${name}」…`);
    } catch (e) {
      camPendingName = '';
      camPendingAt = 0;
      ev.target.disabled = false;
      for (const wrap of [$('#camConnectWrap'), $('#camTeleopWrap')]) {
        if (wrap) wrap.classList.remove('cam-switching');
      }
      toast('相機切換失敗，請再試一次');
    }
  });
  $('#confirmYes').addEventListener('click', () => closeConfirm(true));
  $('#confirmNo').addEventListener('click', () => closeConfirm(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleCam(60); });

  wireCam($('#camConnect'), $('#camConnectWrap'));
  wireCam($('#camTeleop'), $('#camTeleopWrap'));
  buildSimhand();
  wireBoot();

  if (DEVMOCK) {
    sim = createMockSim({ onMessage: handleMessage });
    sim.start();
    console.info('[LeRobot101OS] devmock 模式：不連 WebSocket，由前端模擬器供應 tick/event');
  } else {
    connectWS();
  }
  render();
  scheduleCam(600);
}

init();
