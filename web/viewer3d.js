// viewer3d.js — three.js + urdf-loader 雙臂 3D 檢視器
// leader 在 x=-0.18m（幽靈橘 #ffb37a、透明度 .85）、follower 在 x=+0.18m（LeRobot 橘 #ff7f2a）。
// 提供：setJoints（度 → lerp 平滑）、setGhost（置中階段半透明目標姿勢）、
// setHighlight（極限階段引導關節 emissive 脈動）、moveTo（面板間搬移）。
// URDF 載入失敗 → 自動退回 2D canvas 火柴人手臂，絕不擋住流程。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import URDFLoader from './vendor/urdf-loader/URDFLoader.js';

export const JOINT_NAMES = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];
export const URDF_URL = './assets/so101/so101_new_calib.urdf';
const DEG = Math.PI / 180;
const LERP = 0.25;              // 每影格趨近係數
const LOAD_TIMEOUT_MS = 20000;  // 逾時 → fallback

const ARM_DEFS = {
  // yaw：真實桌面擺法＝兩臂並排、各自順時針轉 90°（俯視）正面朝前
  leader:   { x: -0.18, yaw: -Math.PI / 2, tint: '#ffb37a', opacity: 0.85, urdf: './assets/so101/so101_follower_cam.urdf' }, // 扳機手柄版（官方 STEP 自轉）
  follower: { x: +0.18, yaw: -Math.PI / 2, tint: '#ff7f2a', opacity: 1.0, urdf: './assets/so101/so101_follower_cam.urdf' }, // 含腕部相機
};

/**
 * 建立檢視器。同步回傳 API；3D 內容非同步載入。
 * @param {HTMLElement} container 初始掛載點
 */
export function createViewer(container) {
  // ---- 共用關節狀態（3D 與 2D fallback 都吃它） ----
  const jstate = {};
  for (const arm of Object.keys(ARM_DEFS)) {
    jstate[arm] = {};
    for (const j of JOINT_NAMES) jstate[arm][j] = { cur: 0, target: 0 };
  }
  let ghostWanted = null;                    // 'leader' | 'follower' | null
  let hlWanted = { arm: null, joint: null }; // 引導關節 highlight
  let callouts = null;                       // 關節標註（見 setCallouts）
  let focusWanted = null;                    // 鏡頭聚焦哪一臂

  const host = document.createElement('div');
  host.className = 'v3d-host';
  container.appendChild(host);

  // 關節標註覆蓋層：HTML（字型/中文好看）＋ SVG（圈圈與引線），疊在 canvas 上、不吃滑鼠
  const ovl = document.createElement('div');
  ovl.className = 'v3d-callouts';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ovlSvg = document.createElementNS(SVGNS, 'svg');
  ovl.appendChild(ovlSvg);
  host.appendChild(ovl);
  const coEls = {};   // joint → {ring, line, tag, sx, sy, lx, ly}

  let usingFallback = false;
  let disposed = false;

  // ================= 3D =================
  let renderer = null, scene = null, camera = null, controls = null;
  const arms = { leader: null, follower: null }; // {robot, ghost}
  let hlMeshes = [];                             // 目前脈動中的 mesh
  let resizeObs = null;

  function init3D() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#1d2129'); // 深板岩
    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 12);
    camera.position.set(0.12, 0.42, 0.98); // 正面偏上：雙臂並排（各朝前 45°）都入鏡

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0.08, 0.10, 0.08);
    controls.minDistance = 0.15;
    controls.maxDistance = 3;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.addEventListener('start', () => { camTween = null; }); // 使用者接手鏡頭

    // 柔和燈光：主光 + 補光 + 半球
    const hemi = new THREE.HemisphereLight(0xfff2e0, 0x2c3440, 1.1);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.8, 1.6, 1.0);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.7);
    fill.position.set(-1.0, 0.8, -0.8);
    scene.add(fill);

    // 淡淡的網格地面
    const grid = new THREE.GridHelper(1.6, 32, 0x3c4454, 0x2a303c);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    scene.add(grid);

    host.insertBefore(renderer.domElement, ovl); // canvas 在下、標註在上
    renderer.domElement.style.display = 'block';

    resizeObs = new ResizeObserver(() => resizeNow());
    resizeObs.observe(host);
    resizeNow();

    renderer.setAnimationLoop(loop3D);
  }

  function resizeNow() {
    if (!renderer || usingFallback) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (w < 4 || h < 4) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function tintRobot(robot, def) {
    // 對尚未處理過的 mesh 上色；回傳目前 mesh 總數（供穩定判定）
    // material.name 在 clone 後仍保留，所以之後換顏色可以再靠它認出列印件
    let count = 0;
    const tint = def.userTint || def.tint;
    robot.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      count++;
      if (o.userData._tinted) return;
      o.material = o.material.clone(); // 各 mesh 獨立材質（tint / highlight 需要）
      if (o.material.name === '3d_printed') {
        o.material.color.set(tint);
        if (def.opacity < 1) {
          o.material.transparent = true;
          o.material.opacity = def.opacity;
        }
      }
      o.userData._tinted = true;
    });
    return count;
  }

  /** 換手臂顏色（使用者設定的「車色」）。color=null 回到角色預設。 */
  function setArmColor(name, color) {
    const def = ARM_DEFS[name];
    if (!def) return;
    const next = color || def.tint;
    if (def.userTint === next) return;
    def.userTint = next;
    const a = arms[name];
    if (!a || !a.robot) return;      // 還在載入 → tintRobot 之後會吃到新值
    a.robot.traverse((o) => {
      if (o.isMesh && o.material && o.material.name === '3d_printed') {
        o.material.color.set(next);
      }
    });
  }

  function loadArm(name) {
    return new Promise((resolve, reject) => {
      const def = ARM_DEFS[name];
      const manager = new THREE.LoadingManager();
      manager.onError = (url) => reject(new Error('資源載入失敗: ' + url));
      const loader = new URDFLoader(manager);
      loader.load(def.urdf || URDF_URL, (robot) => {
        // 網格由 STLLoader 非同步掛上，manager.onLoad 在瀏覽器快取命中時會提早開槍；
        // 改用「mesh 數量連續 4 次（~800ms）不變且 >0」的穩定判定，期間持續補 tint。
        robot.rotation.x = -Math.PI / 2; // URDF Z-up → three Y-up
        const group = new THREE.Group(); // 底座位置＋朝向由群組決定
        group.position.x = def.x;
        group.rotation.y = def.yaw || 0;
        group.add(robot);
        scene.add(group);
        arms[name] = { robot, ghost: null };
        let last = -1;
        let stable = 0;
        let waited = 0;
        const timer = setInterval(() => {
          const n = tintRobot(robot, def);
          waited += 200;
          stable = (n === last && n > 0) ? stable + 1 : 0;
          last = n;
          if (stable >= 4 || waited > 20000) {
            clearInterval(timer);
            if (n === 0) { reject(new Error('URDF 網格載入逾時')); return; }
            // 幽靈分身：全部關節 0、半透明；置中階段當「目標姿勢」
            const ghostMat = new THREE.MeshBasicMaterial({
              color: 0xffe3c4, transparent: true, opacity: 0.25, depthWrite: false,
            });
            const ghost = robot.clone(true);
            ghost.traverse((o) => { if (o.isMesh) o.material = ghostMat; });
            for (const j of JOINT_NAMES) ghost.setJointValue(j, 0);
            ghost.visible = false;
            group.add(ghost); // 幽靈跟著同一個群組轉向
            arms[name].ghost = ghost;
            applyGhost(); // 若載入期間就進入置中階段，補套目標姿勢
            resolve();
          }
        }, 200);
      }, undefined, (e) => reject(e));
    });
  }

  // 收集某關節「直屬」child link 的 mesh（碰到更深的 joint 就停，避免整條下游都亮）
  function jointMeshes(robot, jointName) {
    const joint = robot.joints && robot.joints[jointName];
    if (!joint) return [];
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.isURDFJoint) continue;
        if (c.isMesh) out.push(c);
        walk(c);
      }
    };
    walk(joint);
    return out;
  }

  function applyGhost() {
    if (usingFallback) return;
    for (const [name, a] of Object.entries(arms)) {
      if (a && a.ghost) a.ghost.visible = (ghostWanted === name);
    }
  }

  function applyHighlight() {
    if (usingFallback) return;
    for (const m of hlMeshes) {
      if (m.material && m.material.emissive) {
        m.material.emissive.set(0x000000);
        m.material.emissiveIntensity = 1;
      }
    }
    hlMeshes = [];
    const { arm, joint } = hlWanted;
    if (arm && joint && arms[arm] && arms[arm].robot) {
      hlMeshes = jointMeshes(arms[arm].robot, joint)
        .filter((m) => m.material && m.material.emissive);
    }
  }

  // ================= 鏡頭聚焦（校準時把正在校的那隻臂拉近、轉到側面） =================
  // 側面才看得出 2/3/4 號關節的位置（正面看三個關節前後疊在一起）。
  // 只在「聚焦對象改變」時補間一次；使用者自己拖鏡頭就立刻放手，不跟他搶。
  const VIEW_HOME = { pos: new THREE.Vector3(0.12, 0.42, 0.98), target: new THREE.Vector3(0.08, 0.10, 0.08) };
  function viewFor(arm) {
    const def = arm && ARM_DEFS[arm];
    const a = arm && arms[arm];
    if (!def || !a || !a.ghost) return VIEW_HOME;
    // 用零姿勢幽靈量「底座 → 夾爪」的水平方向 f，鏡頭擺在 f 的垂直方向（＝側面），
    // 跟 STS32XX 參考姿勢圖的 SIDE VIEW 同一個角度
    a.ghost.updateMatrixWorld(true);
    const base = new THREE.Vector3(), tip = new THREE.Vector3();
    a.ghost.joints.shoulder_pan.getWorldPosition(base);
    a.ghost.joints.gripper.getWorldPosition(tip);
    const f = new THREE.Vector3(tip.x - base.x, 0, tip.z - base.z);
    const reach = Math.max(0.15, f.length());
    f.normalize();
    const n = new THREE.Vector3(-f.z, 0, f.x);           // 水平面上垂直於手臂
    if (Math.abs(n.x) > 0.7 ? Math.sign(n.x) !== Math.sign(def.x || 1) : n.z < 0) n.negate(); // 外側／前方優先
    const target = base.clone().lerp(tip, 0.45);
    target.y = Math.max(0.10, (base.y + tip.y) / 2 + 0.02);
    const dist = 0.30 + reach * 1.15;
    const pos = target.clone().addScaledVector(n, dist).addScaledVector(f, reach * 0.25);
    pos.y = target.y + dist * 0.32;                       // 略微俯視，底座不會被擋
    return { target, pos };
  }
  let camTween = null; // {from:{pos,target}, to:{pos,target}, t0, dur}
  function startFocus() {
    if (!camera || !controls) return;
    camTween = {
      from: { pos: camera.position.clone(), target: controls.target.clone() },
      to: viewFor(focusWanted),
      t0: performance.now(),
      dur: 750,
    };
  }
  function stepFocus(now) {
    if (!camTween) return;
    const u = Math.min(1, (now - camTween.t0) / camTween.dur);
    const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // easeInOutQuad
    camera.position.lerpVectors(camTween.from.pos, camTween.to.pos, e);
    controls.target.lerpVectors(camTween.from.target, camTween.to.target, e);
    if (u >= 1) camTween = null;
  }

  // ================= 關節標註（圈起來＋編號＋名稱） =================
  const _wp = new THREE.Vector3();
  const _rp = new THREE.Vector3();
  const _right = new THREE.Vector3();

  function calloutEl(joint) {
    if (coEls[joint]) return coEls[joint];
    const ring = document.createElementNS(SVGNS, 'circle');
    const line = document.createElementNS(SVGNS, 'line');
    ovlSvg.appendChild(line);
    ovlSvg.appendChild(ring);
    const tag = document.createElement('div');
    tag.className = 'v3d-tag';
    ovl.appendChild(tag);
    coEls[joint] = { ring, line, tag, html: '', w: 0, h: 0, lx: null, ly: null };
    return coEls[joint];
  }

  function hideCallouts() {
    for (const el of Object.values(coEls)) {
      el.ring.style.display = 'none';
      el.line.style.display = 'none';
      el.tag.style.display = 'none';
      el.lx = el.ly = null;
    }
  }

  function updateCallouts3D(time) {
    const a = callouts && arms[callouts.arm];
    const W = host.clientWidth, H = host.clientHeight;
    if (!a || !a.robot || W < 4 || H < 4) { hideCallouts(); return; }
    ovlSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    _right.setFromMatrixColumn(camera.matrixWorld, 0);

    // 1) 關節原點投影到螢幕；圈圈半徑＝把 2–3cm 的世界尺寸投影過來（遠近自動縮放）
    const pts = [];
    const seen = new Set();
    for (const it of callouts.items) {
      const jn = a.robot.joints && a.robot.joints[it.joint];
      if (!jn) continue;
      jn.getWorldPosition(_wp);
      _rp.copy(_right).multiplyScalar(it.state === 'active' ? 0.026 : 0.016).add(_wp);
      _wp.project(camera);
      _rp.project(camera);
      if (_wp.z > 1 || _wp.z < -1) continue; // 在鏡頭後面
      const sx = (_wp.x + 1) / 2 * W, sy = (1 - _wp.y) / 2 * H;
      const rad = Math.max(it.state === 'active' ? 15 : 9, Math.hypot((_rp.x + 1) / 2 * W - sx, (1 - _rp.y) / 2 * H - sy));
      const el = calloutEl(it.joint);
      const html = it.showName
        ? `<span class="n">${it.num}</span><span class="t">${it.name}<em>${it.en}</em></span>`
        : `<span class="n">${it.num}</span>`;
      if (html !== el.html) { el.tag.innerHTML = html; el.html = html; el.w = 0; }
      el.tag.className = `v3d-tag s-${it.state}${it.showName ? ' named' : ''}`;
      el.tag.style.display = '';
      if (!el.w) { el.w = el.tag.offsetWidth; el.h = el.tag.offsetHeight; }
      pts.push({ it, el, sx, sy, rad });
      seen.add(it.joint);
    }
    for (const [j, el] of Object.entries(coEls)) {
      if (!seen.has(j)) { el.ring.style.display = 'none'; el.line.style.display = 'none'; el.tag.style.display = 'none'; el.lx = el.ly = null; }
    }
    if (!pts.length) return;

    // 2) 標籤往「遠離手臂重心」的方向推出去；再做幾輪互斥，避免手腕附近三個標籤疊在一起
    const cx = pts.reduce((s, p) => s + p.sx, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.sy, 0) / pts.length;
    for (const p of pts) {
      let dx = p.sx - cx, dy = p.sy - cy;
      const d = Math.hypot(dx, dy);
      if (d < 1) { dx = 0; dy = -1; } else { dx /= d; dy /= d; }
      // 偏水平擺：標籤是橫的，左右推比上下推更不會擋到手臂
      dx = dx * 1.6; const n = Math.hypot(dx, dy); dx /= n; dy /= n;
      const gap = p.rad + (p.it.state === 'active' ? 30 : 20);
      p.dx = dx; p.dy = dy;
      p.bx = p.sx + dx * (gap + p.el.w / 2);
      p.by = p.sy + dy * (gap + p.el.h / 2);
    }
    for (let iter = 0; iter < 24; iter++) {
      for (let i = 0; i < pts.length; i++) {
        for (let k = i + 1; k < pts.length; k++) {
          const A = pts[i], B = pts[k];
          const ox = (A.el.w + B.el.w) / 2 + 6 - Math.abs(A.bx - B.bx);
          const oy = (A.el.h + B.el.h) / 2 + 4 - Math.abs(A.by - B.by);
          if (ox > 0 && oy > 0) {
            // 沿重疊較少的軸推開（通常是上下）
            if (oy < ox) { const s = A.by <= B.by ? -1 : 1; A.by += s * oy / 2; B.by -= s * oy / 2; }
            else { const s = A.bx <= B.bx ? -1 : 1; A.bx += s * ox / 2; B.bx -= s * ox / 2; }
          }
        }
      }
      for (const p of pts) {
        p.bx = Math.min(W - 4 - p.el.w / 2, Math.max(4 + p.el.w / 2, p.bx));
        p.by = Math.min(H - 4 - p.el.h / 2, Math.max(4 + p.el.h / 2, p.by));
      }
    }

    // 3) 畫：圈圈＋引線＋標籤（位置做低通，避免手臂微動時標籤抖）
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);
    for (const p of pts) {
      const el = p.el;
      if (el.lx == null) { el.lx = p.bx; el.ly = p.by; }
      el.lx += (p.bx - el.lx) * 0.35;
      el.ly += (p.by - el.ly) * 0.35;
      const active = p.it.state === 'active';
      const r = active ? p.rad * (1 + 0.12 * pulse) : p.rad;
      el.ring.setAttribute('cx', p.sx.toFixed(1));
      el.ring.setAttribute('cy', p.sy.toFixed(1));
      el.ring.setAttribute('r', r.toFixed(1));
      el.ring.setAttribute('class', `ring s-${p.it.state}`);
      el.ring.style.display = '';
      // 引線：圈圈邊緣 → 標籤框最近點
      const qx = Math.min(el.lx + el.w / 2, Math.max(el.lx - el.w / 2, p.sx));
      const qy = Math.min(el.ly + el.h / 2, Math.max(el.ly - el.h / 2, p.sy));
      const vx = qx - p.sx, vy = qy - p.sy, vl = Math.hypot(vx, vy);
      if (vl > r + 2) {
        el.line.setAttribute('x1', (p.sx + vx / vl * r).toFixed(1));
        el.line.setAttribute('y1', (p.sy + vy / vl * r).toFixed(1));
        el.line.setAttribute('x2', qx.toFixed(1));
        el.line.setAttribute('y2', qy.toFixed(1));
        el.line.setAttribute('class', `lead s-${p.it.state}`);
        el.line.style.display = '';
      } else {
        el.line.style.display = 'none';
      }
      el.tag.style.transform = `translate(${(el.lx - el.w / 2).toFixed(1)}px, ${(el.ly - el.h / 2).toFixed(1)}px)`;
    }
  }

  function loop3D(time) {
    if (disposed || usingFallback) return;
    stepJoints();
    for (const [name, a] of Object.entries(arms)) {
      if (!a || !a.robot) continue;
      for (const j of JOINT_NAMES) a.robot.setJointValue(j, jstate[name][j].cur);
    }
    if (hlMeshes.length) {
      const k = 0.35 + 0.3 * Math.sin(time * 0.006); // emissive 脈動
      for (const m of hlMeshes) {
        m.material.emissive.set(0xff7f2a);
        m.material.emissiveIntensity = k;
      }
    }
    stepFocus(performance.now());
    controls.update();
    if (host.clientWidth > 4 && host.clientHeight > 4) {
      renderer.render(scene, camera);
      updateCallouts3D(time); // render 之後 matrixWorld 都是最新的
    }
  }

  function stepJoints() {
    for (const arm of Object.keys(jstate)) {
      for (const j of JOINT_NAMES) {
        const s = jstate[arm][j];
        s.cur += (s.target - s.cur) * LERP;
      }
    }
  }

  function destroy3D() {
    try {
      if (resizeObs) resizeObs.disconnect();
      if (renderer) {
        renderer.setAnimationLoop(null);
        renderer.dispose();
        if (renderer.domElement.parentElement) renderer.domElement.remove();
      }
    } catch (e) { /* 忽略 */ }
    renderer = null; scene = null; controls = null;
    arms.leader = null; arms.follower = null;
    hlMeshes = [];
  }

  // ================= 2D fallback =================
  let cv2d = null, ctx2d = null, raf2d = 0;

  function startFallback(reason) {
    if (usingFallback || disposed) return;
    usingFallback = true;
    console.warn('[viewer3d] 3D 不可用，退回 2D 檢視：', reason);
    destroy3D();
    ovl.remove(); // 2D 版直接畫在 canvas 上
    cv2d = document.createElement('canvas');
    cv2d.className = 'v3d-canvas2d';
    host.appendChild(cv2d);
    ctx2d = cv2d.getContext('2d');
    const tick = (t) => {
      if (disposed) return;
      stepJoints();
      draw2D(t || 0);
      raf2d = requestAnimationFrame(tick);
    };
    raf2d = requestAnimationFrame(tick);
  }

  function draw2D(time) {
    if (!ctx2d) return; // 極端環境連 2D canvas 都沒有：安靜跳過
    const W = host.clientWidth, H = host.clientHeight;
    if (W < 4 || H < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv2d.width !== W * dpr || cv2d.height !== H * dpr) {
      cv2d.width = W * dpr; cv2d.height = H * dpr;
      cv2d.style.width = W + 'px'; cv2d.style.height = H + 'px';
    }
    const c = ctx2d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#1d2129';
    c.fillRect(0, 0, W, H);
    // 淡網格
    c.strokeStyle = 'rgba(255,255,255,0.045)';
    c.lineWidth = 1;
    const step = 26;
    for (let x = (W / 2) % step; x < W; x += step) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = H % step; y < H; y += step) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

    drawArm2D(c, 'leader', W * 0.30, H, time);
    drawArm2D(c, 'follower', W * 0.70, H, time);

    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.font = '11px ui-monospace, monospace';
    c.textAlign = 'center';
    c.fillText('2D 簡易檢視（3D 模型未載入）', W / 2, H - 8);
    c.fillText('Leader', W * 0.30, 18);
    c.fillText('Follower', W * 0.70, 18);
  }

  function chainPoints(st, cx, baseY, scale) {
    // 側視鏈：shoulder_lift → elbow_flex → wrist_flex（角度累加，0 = 朝上）
    const L1 = 88 * scale, L2 = 74 * scale, L3 = 40 * scale;
    const p0 = { x: cx, y: baseY - 26 * scale };
    let a = st.shoulder_lift.cur;
    const p1 = { x: p0.x + Math.sin(a) * L1, y: p0.y - Math.cos(a) * L1 };
    a += st.elbow_flex.cur;
    const p2 = { x: p1.x + Math.sin(a) * L2, y: p1.y - Math.cos(a) * L2 };
    a += st.wrist_flex.cur;
    const p3 = { x: p2.x + Math.sin(a) * L3, y: p2.y - Math.cos(a) * L3 };
    return { p0, p1, p2, p3, aEnd: a };
  }

  function drawArm2D(c, armName, cx, H, time) {
    const st = jstate[armName];
    const def = ARM_DEFS[armName];
    const scale = Math.min(H / 300, 1.4);
    const baseY = H * 0.86;

    // 幽靈（置中目標）：零姿勢半透明
    if (ghostWanted === armName) {
      const zero = {};
      for (const j of JOINT_NAMES) zero[j] = { cur: 0 };
      c.save();
      c.globalAlpha = 0.25;
      strokeChain(c, chainPoints(zero, cx, baseY, scale), '#ffe3c4', 10 * scale);
      c.restore();
    }

    const pts = chainPoints(st, cx, baseY, scale);

    // 底座 + shoulder_pan 指示
    c.fillStyle = '#2b3140';
    roundRect(c, cx - 34 * scale, baseY - 10 * scale, 68 * scale, 16 * scale, 8 * scale);
    c.fill();
    c.save();
    c.translate(cx, baseY - 2 * scale);
    c.scale(1, 0.35);
    c.strokeStyle = def.tint;
    c.lineWidth = 3;
    c.beginPath();
    const pan = st.shoulder_pan.cur;
    c.moveTo(Math.sin(pan + Math.PI / 2) * -26 * scale, Math.cos(pan + Math.PI / 2) * 26 * scale);
    c.lineTo(Math.sin(pan + Math.PI / 2) * 26 * scale, Math.cos(pan + Math.PI / 2) * -26 * scale);
    c.stroke();
    c.restore();

    strokeChain(c, pts, def.tint, 10 * scale, def.opacity);

    // wrist_roll：腕部小圓 + 旋轉點
    const roll = st.wrist_roll.cur;
    c.strokeStyle = 'rgba(255,255,255,0.5)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(pts.p2.x, pts.p2.y, 9 * scale, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(pts.p2.x + Math.sin(roll) * 9 * scale, pts.p2.y - Math.cos(roll) * 9 * scale, 2.2 * scale, 0, Math.PI * 2);
    c.fill();

    // 夾爪：兩指開合
    const open = Math.max(0, Math.min(1.8, st.gripper.cur + 0.35));
    const jaw = 20 * scale;
    for (const s of [-1, 1]) {
      const a = pts.aEnd + s * open * 0.5;
      c.strokeStyle = def.tint;
      c.lineWidth = 5 * scale;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(pts.p3.x, pts.p3.y);
      c.lineTo(pts.p3.x + Math.sin(a) * jaw, pts.p3.y - Math.cos(a) * jaw);
      c.stroke();
    }

    // 關節點 + highlight 脈動
    const pivots = {
      shoulder_pan: { x: cx, y: baseY - 2 * scale },
      shoulder_lift: pts.p0, elbow_flex: pts.p1, wrist_flex: pts.p2,
      wrist_roll: pts.p2, gripper: pts.p3,
    };
    for (const [j, p] of Object.entries(pivots)) {
      if (j === 'wrist_roll' && hlWanted.joint !== 'wrist_roll') continue;
      c.fillStyle = '#22262f';
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(p.x, p.y, 5 * scale, 0, Math.PI * 2);
      c.fill(); c.stroke();
      if (hlWanted.arm === armName && hlWanted.joint === j) {
        const k = 0.5 + 0.5 * Math.sin(time * 0.006);
        c.strokeStyle = `rgba(255,127,42,${0.35 + 0.55 * k})`;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(p.x, p.y, (9 + 4 * k) * scale, 0, Math.PI * 2);
        c.stroke();
      }
    }

    // 關節標註（2D 版）：編號徽章，帶名字的再加一行字；wrist_roll 與 wrist_flex 同點 → 往下錯開
    if (callouts && callouts.arm === armName) {
      for (const it of callouts.items) {
        const p0 = pivots[it.joint];
        if (!p0) continue;
        const p = { x: p0.x - 22 * scale, y: p0.y - (it.joint === 'wrist_roll' ? -16 : 16) * scale };
        const col = it.state === 'active' ? '#ff7f2a' : it.state === 'ok' ? '#3fa35c' : it.state === 'todo' ? '#e0a040' : '#6b7280';
        c.fillStyle = col;
        c.beginPath();
        c.arc(p.x, p.y, 8, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#fff';
        c.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(it.num), p.x, p.y + 0.5);
        if (it.showName) {
          c.font = `${it.state === 'active' ? 'bold ' : ''}12px ui-sans-serif, system-ui, sans-serif`;
          c.textAlign = 'right';
          c.fillStyle = it.state === 'active' ? '#ffd2b0' : 'rgba(255,255,255,0.8)';
          c.fillText(it.name, p.x - 12, p.y + 0.5);
        }
      }
      c.textBaseline = 'alphabetic';
    }
  }

  function strokeChain(c, pts, color, w, alpha = 1) {
    c.save();
    c.globalAlpha *= alpha;
    c.strokeStyle = color;
    c.lineWidth = w;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(pts.p0.x, pts.p0.y);
    c.lineTo(pts.p1.x, pts.p1.y);
    c.lineTo(pts.p2.x, pts.p2.y);
    c.lineTo(pts.p3.x, pts.p3.y);
    c.stroke();
    c.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ================= 啟動 =================
  let ready;
  try {
    init3D();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('URDF 載入逾時')), LOAD_TIMEOUT_MS));
    ready = Promise.race([Promise.all([loadArm('leader'), loadArm('follower')]), timeout])
      .then(() => { applyGhost(); applyHighlight(); if (focusWanted) startFocus(); })
      .catch((e) => startFallback(e));
  } catch (e) {
    // WebGL 都開不了（極舊環境）→ 直接 2D
    ready = Promise.resolve();
    startFallback(e);
  }

  // ================= 對外 API =================
  return {
    host,
    ready,
    get usingFallback() { return usingFallback; },

    /** 設定手臂「車色」：{leader:'#..'|null, follower:'#..'|null} */
    setColors(byArm) {
      if (!byArm) return;
      for (const [arm, color] of Object.entries(byArm)) setArmColor(arm, color);
    },

    /** tick.joints 形狀：{leader:{joint:deg}, follower:{...}}，一律「度」 */
    setJoints(byArm) {
      if (!byArm) return;
      for (const [arm, joints] of Object.entries(byArm)) {
        if (!jstate[arm] || !joints) continue;
        for (const [j, deg] of Object.entries(joints)) {
          if (jstate[arm][j] && Number.isFinite(deg)) jstate[arm][j].target = deg * DEG;
        }
      }
    },

    /** 置中階段：顯示某臂的半透明零姿勢幽靈；null 關閉 */
    setGhost(armName) {
      ghostWanted = armName || null;
      applyGhost();
    },

    /** 極限階段：脈動某臂的某個關節；(null,null) 清除 */
    setHighlight(armName, jointName) {
      hlWanted = { arm: armName || null, joint: jointName || null };
      applyHighlight();
    },

    /**
     * 關節標註：把關節圈起來＋編號＋名稱（校準時讓使用者對上「哪個是哪個」）。
     * spec = { arm, items: [{ joint, num, name, en, state, showName }] }，null 清除。
     * state：'active'（正在處理，脈動）| 'todo'（還沒好）| 'ok'（好了）| 'dim'（背景參考）
     */
    setCallouts(spec) {
      callouts = (spec && spec.arm && Array.isArray(spec.items)) ? spec : null;
      if (!callouts && !usingFallback) hideCallouts();
    },

    /** 鏡頭聚焦某臂（側面近拍）；null 回到總覽。只在對象改變時補間一次。 */
    focusArm(armName) {
      const next = armName || null;
      if (next === focusWanted) return;
      focusWanted = next;
      if (!usingFallback) startFocus();
    },

    /** 把檢視器搬到另一個 slot（校準/遙操作面板 ⇄ 右側 aside） */
    moveTo(slotEl) {
      if (slotEl && host.parentElement !== slotEl) {
        slotEl.appendChild(host);
        resizeNow();
      }
    },

    dispose() {
      disposed = true;
      destroy3D();
      if (raf2d) cancelAnimationFrame(raf2d);
      host.remove();
    },
  };
}
