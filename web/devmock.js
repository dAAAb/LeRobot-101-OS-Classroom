// devmock.js — 純前端模擬器（?devmock=1 時啟用）
// 不開 WebSocket：自己產生「契約正確」的 tick / event 訊息，並攔截 /api/* 呼叫。
// 讓整個 UI 只靠 `python3 -m http.server` 就能完整展示與測試。
// 劇本：boot → scan（2 秒後雙臂出現）→ 自動走完 follower 校準
//       （置中每 1.2s 一關節 → 倒數確認 → 極限逐關節掃出 extreme_hit → calib_saved 彩帶）
//       → idle → 自動示範；滑桿接手後使用真實輸入。錄製／回放保存本次記憶體中的關節。
// 核心是純資料引擎（advance(dt) 推進），瀏覽器用 setInterval 驅動；
// Node 測試可 import createMockSim 後手動 advance 驗證狀態轉換與 tick 形狀。

export const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];
export const CENTER = 2047;
export const degOfRaw = (raw) => (raw - CENTER) * 360 / 4096;

const GUIDE_ORDER = JOINTS.filter((j) => j !== 'wrist_roll'); // 極限引導順序（5 關節）
const JOINT_ZH = {
  shoulder_pan: '肩部旋轉', shoulder_lift: '肩部抬升', elbow_flex: '手肘',
  wrist_flex: '手腕俯仰', wrist_roll: '手腕旋轉', gripper: '夾爪',
};
// 置中開始時「鬆掉」的姿勢（故意偏離中心）
const SLOPPY_POSE = { shoulder_pan: 1420, shoulder_lift: 2610, elbow_flex: 1712, wrist_flex: 2350, wrist_roll: 2790, gripper: 1650 };
// 極限階段模擬人手的擺幅（ticks）
const RANGE_AMP = { shoulder_pan: 1500, shoulder_lift: 1100, elbow_flex: 1250, wrist_flex: 1050, gripper: 720 };
const CENTERED_LINES = [
  '第一個關節對準了！', '第二個也好了，繼續～', '第三個關節也對準了，你做得很好！',
  '第四個，穩穩的！', '只剩兩個了，加油！', '全部對準了！',
];

const TICK_MS = 83; // ≈12Hz

export function createMockSim(opts = {}) {
  const onMessage = opts.onMessage || (() => {});

  // ---------- 狀態 ----------
  const S = {
    t: 0,                 // 模擬時間 ms
    phase: 'boot',
    arms: {
      leader: mkArm('leader'),
      follower: mkArm('follower'),
    },
    raw: { leader: mkRaw(), follower: mkRaw() },
    calib: null,
    teleop: { running: false, hz: null },
    record: null,
    replay: null,
    log: [],
    datasets: [],
    autoHand: true,       // 「模擬人手」自動演示；使用者一動滑桿就交還控制權
  };
  // 校準 runtime（不進 snapshot）
  const rt = { hold: {}, extremeHold: 0, lastRaw: {}, guidedKey: null, prevAuto: null, noise: { leader: false, follower: false } };

  // Session-only motion samples: not a LeRobotDataset or a simulated camera recording.
  const recorded = new Map();
  let episodeFrames = [], savedFrames = [];
  let timers = [];  // {at, fn}
  let tweens = [];  // {arm, joint, from, to, t0, dur}
  let tickAcc = 0;
  let interval = null;
  let lastWall = 0;

  function mkArm(role) {
    return { role, port: null, connected: false, voltage: null, calibrated: false, calib_file_date: null, motors_ok: 0 };
  }
  function mkRaw() {
    const r = {};
    for (const j of JOINTS) r[j] = CENTER;
    return r;
  }
  function clock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function log(line) {
    S.log.push(`[${clock()}] ${line}`);
    if (S.log.length > 400) S.log.splice(0, S.log.length - 400);
  }
  function emit(kind, extra = {}) {
    onMessage({ type: 'event', kind, ...extra });
  }
  function speak(text) {
    emit('speak', { text });
    log(`🗣 ${text}`);
  }
  function setPhase(p) {
    if (S.phase !== p) {
      S.phase = p;
      log(`phase → ${p}`);
    }
  }
  function schedule(delayMs, fn) {
    timers.push({ at: S.t + delayMs, fn });
  }
  function tween(arm, joint, to, dur) {
    tweens = tweens.filter((a) => !(a.arm === arm && a.joint === joint));
    tweens.push({ arm, joint, from: S.raw[arm][joint], to, t0: S.t, dur: Math.max(1, dur) });
  }
  const clampRaw = (v) => Math.max(0, Math.min(4095, v));
  const r1 = (v) => Math.round(v * 10) / 10;

  // ---------- 劇本 ----------
  function doBoot() {
    if (S.phase !== 'boot') return { ok: false, status: 409, error: '已經開機了' };
    setPhase('scan');
    speak('你好，我是 LeRobot 101！讓我來協助你啟用手臂。');
    schedule(2000, armsAppear);
    return { ok: true, data: { ok: true } };
  }

  function armsAppear() {
    if (S.arms.follower.connected) return;
    Object.assign(S.arms.leader, { connected: true, port: '/dev/tty.usbmodemCLASSROOM_DEMO', voltage: 7.4, motors_ok: 6 });
    Object.assign(S.arms.follower, { connected: true, port: '/dev/tty.usbmodemCLASSROOM_DEMO', voltage: 12.1, motors_ok: 6 });
    log('掃描到 2 個序列埠：leader(7.4V) / follower(12.1V)');
    emit('success');
    speak('兩隻手臂都找到了！');
    setPhase('idle');
    schedule(1500, () => {
      if (S.phase === 'idle' && !S.arms.follower.calibrated) startCalib('follower');
    });
  }

  // ---------- 校準引擎 ----------
  function startCalib(arm) {
    if (S.phase !== 'idle') return { ok: false, status: 409, error: `現在的狀態（${S.phase}）不能開始校準` };
    if (!S.arms[arm] || !S.arms[arm].connected) return { ok: false, status: 409, error: `${arm} 尚未連線，無法校準` };
    setPhase('calibrating');
    const joints = {};
    // torque off：手臂「鬆掉」到偏離中心的姿勢
    for (const j of JOINTS) {
      S.raw[arm][j] = SLOPPY_POSE[j] + Math.round((Math.random() - 0.5) * 40);
      joints[j] = {
        raw: Math.round(S.raw[arm][j]), deg: r1(degOfRaw(S.raw[arm][j])),
        centered: false, min: Math.round(S.raw[arm][j]), max: Math.round(S.raw[arm][j]),
        span_ok: false, done_min: false, done_max: false,
      };
      rt.hold[j] = 0;
      rt.lastRaw[j] = S.raw[arm][j];
    }
    rt.extremeHold = 0;
    rt.guidedKey = null;
    rt.prevAuto = null;
    S.calib = { active_arm: arm, stage: 'center', joints, all_centered: false, auto_confirm_in: null, guided: null };
    log(`開始校準 ${arm}（torque off + reset_calibration）`);
    speak('馬達已放鬆，請扶好手臂，把每個關節輕輕移到中間喔。');
    if (S.autoHand) {
      // 模擬人手：每 1.2 秒把一個關節扶到中間
      JOINTS.forEach((j, k) => schedule(600 + k * 1200, () => {
        if (S.calib && S.calib.stage === 'center' && S.autoHand) tween(arm, j, CENTER + Math.round((Math.random() - 0.5) * 20), 500);
      }));
    }
    return { ok: true, data: { ok: true } };
  }

  function confirmCenter() {
    const c = S.calib;
    if (!c || c.stage !== 'center') return { ok: false, status: 409, error: '不在置中階段' };
    const arm = c.active_arm;
    // wrist_roll 守衛：離中心超過 1/4 圈就擋下
    if (Math.abs(S.raw[arm].wrist_roll - CENTER) > 1024) {
      emit('error', { text: 'wrist_roll 偏太多了' });
      speak(arm === 'leader' ? '手腕旋轉還差很多，請把兩個黑點對齊喔。' : '手腕旋轉離中間太遠了，請再轉回來一點。');
      return { ok: false, status: 409, error: 'wrist_roll 離中心太遠，請先轉回中間' };
    }
    // set_half_turn_homings：置中點變成新的 2047
    c.stage = 'range';
    c.auto_confirm_in = null;
    for (const j of JOINTS) {
      S.raw[arm][j] = CENTER; // homing 之後 raw 讀值回到中心
      const jr = c.joints[j];
      jr.raw = CENTER; jr.deg = 0;
      if (j === 'wrist_roll') {
        jr.min = 0; jr.max = 4095; jr.done_min = true; jr.done_max = true; jr.span_ok = true;
      } else {
        jr.min = CENTER; jr.max = CENTER; jr.done_min = false; jr.done_max = false; jr.span_ok = false;
      }
      rt.lastRaw[j] = CENTER;
    }
    c.guided = { joint: GUIDE_ORDER[0], side: 'min', index: 0, total: GUIDE_ORDER.length };
    rt.extremeHold = 0;
    emit('success');
    log('置中確認完成（set_half_turn_homings）');
    speak(`太好了，置中完成！接下來請把「${JOINT_ZH[GUIDE_ORDER[0]]}」轉到其中一邊的盡頭。手腕旋轉不用轉喔。`);
    return { ok: true, data: { ok: true } };
  }

  function nextGuided(skip) {
    const c = S.calib;
    if (!c || c.stage !== 'range' || !c.guided) return { ok: false, status: 409, error: '不在極限階段' };
    const i = c.guided.index + 1;
    if (i >= GUIDE_ORDER.length) {
      c.guided = null;
      beginSaving();
    } else {
      c.guided = { joint: GUIDE_ORDER[i], side: 'min', index: i, total: GUIDE_ORDER.length };
      rt.extremeHold = 0;
      if (skip) speak(`好，先跳過。換「${JOINT_ZH[GUIDE_ORDER[i]]}」，請轉到其中一邊的盡頭。`);
      else speak(`請把「${JOINT_ZH[GUIDE_ORDER[i]]}」轉到其中一邊的盡頭。`);
    }
    return { ok: true, data: { ok: true } };
  }

  function finishCalib() {
    const c = S.calib;
    if (!c || c.stage !== 'range') return { ok: false, status: 409, error: '不在極限階段' };
    const bad = GUIDE_ORDER.filter((j) => (c.joints[j].max - c.joints[j].min) < 400);
    if (bad.length) {
      return { ok: false, status: 409, error: `以下關節活動範圍不足：${bad.map((j) => JOINT_ZH[j]).join('、')}，請再多掃一點` };
    }
    c.guided = null;
    beginSaving();
    return { ok: true, data: { ok: true } };
  }

  function beginSaving() {
    const c = S.calib;
    c.stage = 'saving';
    log('寫入校準（write_calibration + JSON）…');
    schedule(900, () => {
      if (!S.calib) return;
      const arm = S.calib.active_arm;
      const kind = arm === 'follower' ? 'robots/so_follower/lerobot101_follower.json' : 'teleoperators/so_leader/lerobot101_leader.json';
      S.arms[arm].calibrated = true;
      S.arms[arm].calib_file_date = new Date().toISOString().slice(0, 16).replace('T', ' ');
      emit('calib_saved', { arm, text: `校準檔已儲存：/tmp/lerobotos_mock_calibration/${kind}` });
      speak('校準完成！你太棒了！');
      log(`✅ ${arm} 校準完成，檔案已寫入`);
      S.calib = null;
      setPhase('idle');
      // 劇本續集：leader 直接「載入既有校準」→ 假遙操作
      if (arm === 'follower' && !S.arms.leader.calibrated) {
        schedule(2000, () => {
          if (S.phase !== 'idle') return;
          S.arms.leader.calibrated = true;
          S.arms.leader.calib_file_date = new Date().toISOString().slice(0, 16).replace('T', ' ');
          log('（demo）leader 載入既有校準檔');
          speak('Leader 手臂也準備好了，我們來試試遙操作！');
          schedule(1200, () => { if (S.phase === 'idle') startTeleop(); });
        });
      }
    });
  }

  function abortCalib() {
    if (S.phase !== 'calibrating') return { ok: false, status: 409, error: '沒有進行中的校準' };
    S.calib = null;
    tweens = [];
    setPhase('idle');
    speak('好，先不校準，需要的時候再叫我。');
    return { ok: true, data: { ok: true } };
  }

  function calibEngine(dt) {
    const c = S.calib;
    if (!c) return;
    const arm = c.active_arm;

    if (c.stage === 'center') {
      for (const j of JOINTS) {
        const raw = S.raw[arm][j];
        const jr = c.joints[j];
        jr.raw = Math.round(raw);
        jr.deg = r1(degOfRaw(raw));
        const off = Math.abs(raw - CENTER);
        if (!jr.centered) {
          if (off <= 68) {
            rt.hold[j] += dt;
            if (rt.hold[j] >= 600) {
              jr.centered = true;
              const idx = JOINTS.filter((k) => c.joints[k].centered).length - 1;
              emit('joint_centered', { arm, joint: j, pitch_index: idx });
              log(`✓ ${j} 已置中`);
              if (CENTERED_LINES[idx]) speak(CENTERED_LINES[idx]);
            }
          } else {
            rt.hold[j] = 0;
          }
        } else if (off > 120) {
          jr.centered = false;
          rt.hold[j] = 0;
          if (c.auto_confirm_in != null) speak('哎呀，跑掉了，再扶回中間一下下。');
        }
      }
      c.all_centered = JOINTS.every((j) => c.joints[j].centered);
      if (c.all_centered) {
        if (c.auto_confirm_in == null) {
          c.auto_confirm_in = 2.0;
          speak('保持不動，我來記住這個姿勢～');
        } else {
          c.auto_confirm_in = Math.max(0, c.auto_confirm_in - dt / 1000);
          if (c.auto_confirm_in === 0) confirmCenter();
        }
      } else {
        c.auto_confirm_in = null;
      }
    } else if (c.stage === 'range') {
      // 全域累積 min/max（wrist_roll 除外）
      for (const j of JOINTS) {
        const raw = S.raw[arm][j];
        const jr = c.joints[j];
        jr.raw = Math.round(raw);
        jr.deg = r1(degOfRaw(raw));
        if (j !== 'wrist_roll') {
          jr.min = Math.min(jr.min, jr.raw);
          jr.max = Math.max(jr.max, jr.raw);
          jr.span_ok = (jr.max - jr.min) >= 400;
        }
      }
      const g = c.guided;
      if (g) {
        // 模擬人手跟著引導游標掃
        const key = `${g.joint}:${g.side}`;
        if (rt.guidedKey !== key) {
          rt.guidedKey = key;
          rt.extremeHold = 0;
          if (S.autoHand) {
            const amp = RANGE_AMP[g.joint] || 1000;
            const target = g.side === 'min' ? CENTER - amp : CENTER + amp;
            schedule(250, () => {
              const cc = S.calib;
              if (cc && cc.stage === 'range' && cc.guided && `${cc.guided.joint}:${cc.guided.side}` === key && S.autoHand) {
                tween(arm, g.joint, target, 900);
              }
            });
          }
        }
        // 「到頂」偵測：貼著目前極值、慢速、離中心夠遠，穩定 700ms
        const j = g.joint;
        const raw = S.raw[arm][j];
        const jr = c.joints[j];
        const velPerFrame = Math.abs(raw - (rt.lastRaw[j] != null ? rt.lastRaw[j] : raw)) / Math.max(dt / 33.3, 1e-6);
        const side = raw < CENTER ? 'min' : 'max';
        const extreme = side === 'min' ? jr.min : jr.max;
        const doneKey = side === 'min' ? 'done_min' : 'done_max';
        if (!jr[doneKey] && Math.abs(raw - extreme) <= 25 && velPerFrame < 8 && Math.abs(raw - CENTER) >= 250) {
          rt.extremeHold += dt;
          if (rt.extremeHold >= 700) {
            jr[doneKey] = true;
            rt.extremeHold = 0;
            emit('extreme_hit', { arm, joint: j, side });
            log(`⤷ ${j} ${side} 到頂（${jr.raw}）`);
            if (jr.done_min && jr.done_max) {
              emit('success');
              speak(`「${JOINT_ZH[j]}」完成！`);
              nextGuided(false);
            } else {
              g.side = side === 'min' ? 'max' : 'min';
              speak('換另外一邊～');
            }
          }
        } else {
          rt.extremeHold = 0;
        }
      }
      for (const j of JOINTS) rt.lastRaw[j] = S.raw[arm][j];
    }
    // stage 'saving'：等 schedule 的完成 callback
  }

  // ---------- 遙操作 / 錄製 / 回放 ----------
  function startTeleop() {
    if (S.phase !== 'idle') return { ok: false, status: 409, error: `現在的狀態（${S.phase}）不能開始遙操作` };
    if (!(S.arms.leader.calibrated && S.arms.follower.calibrated)) {
      return { ok: false, status: 409, error: '雙臂都要完成校準才能遙操作' };
    }
    setPhase('teleop');
    S.teleop.running = true;
    S.teleop.t0 = S.t;
    log('遙操作開始（模擬關節迴圈）');
    speak('遙操作開始！動動 Leader，Follower 會跟著你。');
    return { ok: true, data: { ok: true } };
  }
  function stopTeleop() {
    if (S.phase !== 'teleop') return { ok: false, status: 409, error: '沒有進行中的遙操作' };
    S.teleop.running = false;
    S.teleop.hz = null;
    setPhase('idle');
    log('遙操作停止');
    return { ok: true, data: { ok: true } };
  }

  function sinPose(tMs, amps, freqScale = 1) {
    const out = {};
    const freqs = { shoulder_pan: 0.11, shoulder_lift: 0.17, elbow_flex: 0.13, wrist_flex: 0.23, wrist_roll: 0.07, gripper: 0.31 };
    JOINTS.forEach((j, i) => {
      out[j] = CENTER + (amps[j] || 0) * Math.sin(2 * Math.PI * freqs[j] * freqScale * (tMs / 1000) + i * 1.1);
    });
    return out;
  }

  function motionEngine(dt) {
    const TELEOP_AMP = { shoulder_pan: 700, shoulder_lift: 480, elbow_flex: 580, wrist_flex: 430, wrist_roll: 880, gripper: 320 };
    if (S.phase === 'teleop' || (S.phase === 'recording' && S.record)) {
      if (S.autoHand) S.raw.leader = sinPose(S.t - (S.teleop.t0 || 0), TELEOP_AMP);
      // A visible 120 ms response time; never overwrite a user's leader command.
      const before = { ...S.raw.follower };
      const alpha = 1 - Math.exp(-dt / 120);
      for (const j of JOINTS) S.raw.follower[j] += alpha * (S.raw.leader[j] - S.raw.follower[j]);
      if (S.phase === 'teleop') S.teleop.hz = r1(1000 / Math.max(1, dt));
      else {
        S.record.elapsed += dt / 1000;
        const end = S.record.elapsed * 1000;
        const step = 1000 / S.record.fps;
        while (episodeFrames.length * step <= end) {
          const t = episodeFrames.length * step;
          const a = Math.max(0, Math.min(1, (t - (end - dt)) / Math.max(1, dt)));
          const joints = {};
          for (const j of JOINTS) joints[j] = before[j] + a * (S.raw.follower[j] - before[j]);
          episodeFrames.push({ t, joints });
        }
        S.record.frames = episodeFrames.length;
        // Keep this browser-only teaching recorder bounded to two minutes per episode.
        if (S.record.elapsed >= 120) { stopEpisode(true); finishRecord(); }
      }
    } else if (S.phase === 'replaying' && S.replay) {
      const samples = recorded.get(S.replay.repo_id)[S.replay.episode];
      const elapsed = S.t - S.replay._t0;
      const duration = samples[samples.length - 1].t;
      if (elapsed < 500) {
        const a = elapsed / 500;
        for (const j of JOINTS) S.raw.follower[j] = S.replay._from[j] + a * (samples[0].joints[j] - S.replay._from[j]);
      } else {
        const t = elapsed - 500;
        let i = S.replay._index;
        while (i + 1 < samples.length && samples[i + 1].t <= t) i++;
        S.replay._index = i;
        const lo = samples[i], hi = samples[Math.min(i + 1, samples.length - 1)];
        const a = hi.t === lo.t ? 0 : Math.max(0, Math.min(1, (t - lo.t) / (hi.t - lo.t)));
        for (const j of JOINTS) S.raw.follower[j] = lo.joints[j] + a * (hi.joints[j] - lo.joints[j]);
        S.replay.progress = Math.min(1, t / Math.max(1, duration));
        if (t >= duration) { setPhase('idle'); S.replay = null; emit('success'); speak('回放完成！'); }
      }
    }
  }

  function startRecord(body) {
    if (S.phase !== 'idle') return { ok: false, status: 409, error: `現在的狀態（${S.phase}）不能錄製` };
    if (!(S.arms.leader.calibrated && S.arms.follower.calibrated)) {
      return { ok: false, status: 409, error: '雙臂都要完成校準才能錄製' };
    }
    const name = String((body && body.name) || '').trim();
    if (!name) return { ok: false, status: 400, error: '請先取一個資料集名稱' };
    episodeFrames = [{ t: 0, joints: { ...S.raw.follower } }];
    savedFrames = [];
    setPhase('recording');
    S.record = {
      repo_id: `neo/${name.replace(/\s+/g, '_')}`,
      task: (body && body.task) || '',
      fps: Math.max(1, Math.min(60, Number(body && body.fps) || 30)),
      episode_index: 0, saved_episodes: 0, frames: 0, elapsed: 0,
    };
    log(`開始錄製 ${S.record.repo_id}（fps ${S.record.fps}）`);
    speak('開始錄製！我會把每一集都記下來。');
    return { ok: true, data: { ok: true } };
  }
  function stopEpisode(save) {
    if (S.phase !== 'recording' || !S.record) return { ok: false, status: 409, error: '沒有進行中的錄製' };
    if (save && episodeFrames.length < 2) return { ok: false, status: 400, error: '請先錄製一小段動作' };
    if (save) {
      savedFrames.push(episodeFrames);
      S.record.saved_episodes += 1;
      S.record.episode_index += 1;
      emit('success');
      speak(`第 ${S.record.saved_episodes} 集存好了！`);
      log(`💾 episode 已儲存（共 ${S.record.saved_episodes} 集）`);
    } else {
      log('🗑 episode 已棄置');
      speak('好，這集不算，我們再來一次。');
    }
    episodeFrames = [{ t: 0, joints: { ...S.raw.follower } }];
    S.record.frames = 0;
    S.record.elapsed = 0;
    return { ok: true, data: { ok: true } };
  }
  function finishRecord() {
    if (S.phase !== 'recording' || !S.record) return { ok: false, status: 409, error: '沒有進行中的錄製' };
    if (!savedFrames.length) return { ok: false, status: 400, error: '請先按「存這集」，再完成收檔' };
    recorded.set(S.record.repo_id, savedFrames);
    S.datasets = S.datasets.filter(d => d.repo_id !== S.record.repo_id);
    S.datasets.unshift({
      repo_id: S.record.repo_id,
      episodes: S.record.saved_episodes,
      fps: S.record.fps,
      created: new Date().toISOString().slice(0, 16).replace('T', ' '),
    });
    log(`📦 資料集 ${S.record.repo_id} 已收檔（${S.record.saved_episodes} 集）`);
    emit('success');
    speak('資料集收檔完成！');
    S.record = null;
    setPhase('idle');
    return { ok: true, data: { ok: true } };
  }
  function startReplay(body) {
    if (S.phase !== 'idle') return { ok: false, status: 409, error: `現在的狀態（${S.phase}）不能回放` };
    if (!S.arms.follower.calibrated) return { ok: false, status: 409, error: 'Follower 要先完成校準才能回放' };
    const repo = body && body.repo_id;
    const ds = S.datasets.find((d) => d.repo_id === repo);
    if (!ds) return { ok: false, status: 400, error: `找不到資料集 ${repo}` };
    const ep = Number((body && body.episode) || 0);
    if (!(ep >= 0 && ep < ds.episodes)) return { ok: false, status: 400, error: `episode ${ep} 不存在（共 ${ds.episodes} 集）` };
    setPhase('replaying');
    S.replay = { repo_id: repo, episode: ep, progress: 0, _t0: S.t, _index: 0, _from: { ...S.raw.follower } };
    log(`▶ 回放 ${repo} #${ep}（先 ramp 到第一格）`);
    speak('開始回放，請注意手臂會動喔！');
    return { ok: true, data: { ok: true } };
  }
  function stopReplay() {
    if (S.phase !== 'replaying') return { ok: false, status: 409, error: '沒有進行中的回放' };
    S.replay = null;
    setPhase('idle');
    log('回放停止（保持目前姿勢）');
    return { ok: true, data: { ok: true } };
  }

  // ---------- REST 模擬 ----------
  function handleApi(path, body) {
    const p = path.replace(/^\/api/, '');
    switch (p) {
      case '/status': return { ok: true, data: snapshotState() };
      case '/boot': return doBoot();
      case '/scan': {
        if (!S.arms.follower.connected) { armsAppear(); } else { log('已重新掃描：兩隻手臂都在線'); }
        return { ok: true, data: { ok: true } };
      }
      case '/calib/start': return startCalib(body && body.arm);
      case '/calib/confirm_center': return confirmCenter();
      case '/calib/next_joint': return nextGuided(true);
      case '/calib/finish': return finishCalib();
      case '/calib/abort': return abortCalib();
      case '/teleop/start': return startTeleop();
      case '/teleop/stop': return stopTeleop();
      case '/record/start': return startRecord(body);
      case '/record/episode/stop_save': return stopEpisode(true);
      case '/record/episode/stop_discard': return stopEpisode(false);
      case '/record/finish': return finishRecord();
      case '/datasets': return { ok: true, data: S.datasets.map((d) => ({ ...d })) };
      case '/replay/start': return startReplay(body);
      case '/replay/stop': return stopReplay();
      case '/say': {
        speak((body && body.text) || '');
        return { ok: true, data: { ok: true } };
      }
      case '/mock/joints': {
        const arm = body && body.arm;
        if (!S.raw[arm]) return { ok: false, status: 400, error: `未知的手臂 ${arm}` };
        if (S.autoHand) {
          S.autoHand = false; // 使用者接手：關掉自動人手
          tweens = [];
          log('🧪 使用者接手模擬人手（自動演示暫停）');
        }
        for (const [j, v] of Object.entries((body && body.joints) || {})) {
          if (j in S.raw[arm] && Number.isFinite(Number(v))) S.raw[arm][j] = clampRaw(Number(v));
        }
        return { ok: true, data: { ok: true } };
      }
      case '/mock/grab': {
        const arm = body && body.arm;
        if (!(arm in rt.noise)) return { ok: false, status: 400, error: `未知的手臂 ${arm}` };
        rt.noise[arm] = !!(body && body.moving);
        return { ok: true, data: { ok: true } };
      }
      case '/calib/compare/start':
      case '/calib/compare/stop':
      case '/calib/compare/apply':
      case '/arm/restore':
        return { ok: false, status: 400, error: 'devmock 不支援校準比一比——請用 ./start.sh mock 跑後端模擬' };
      case '/wrist/align':
        return { ok: false, status: 400, error: 'devmock 不支援手腕對齊——請用 ./start.sh mock 跑後端模擬' };
      case '/models':
        return { ok: true, data: [] };  // devmock 不做訓練；用 ./start.sh mock 跑後端 mock 才有完整智慧流程
      case '/train/start':
      case '/train/stop':
      case '/smart/start':
      case '/smart/stop':
        return { ok: false, status: 400, error: 'devmock 不支援訓練／智慧執行——請用 ./start.sh mock 跑後端模擬' };
      default:
        return { ok: false, status: 404, error: `未知的 API：${path}` };
    }
  }

  // ---------- tick 組裝（契約 §3） ----------
  function calibView() {
    const c = S.calib;
    if (!c) return null;
    const joints = {};
    for (const j of JOINTS) joints[j] = { ...c.joints[j] };
    return {
      active_arm: c.active_arm,
      stage: c.stage,
      joints,
      all_centered: !!c.all_centered,
      auto_confirm_in: c.auto_confirm_in == null ? null : r1(c.auto_confirm_in),
      guided: c.guided ? { ...c.guided } : null,
    };
  }
  function snapshotState() {
    return {
      phase: S.phase,
      arms: {
        leader: { ...S.arms.leader },
        follower: { ...S.arms.follower },
      },
      calib: calibView(),
      teleop: { running: S.teleop.running, hz: S.teleop.hz },
      record: S.record ? { ...S.record, elapsed: r1(S.record.elapsed) } : null,
      replay: S.replay ? { repo_id: S.replay.repo_id, episode: S.replay.episode, progress: r1(S.replay.progress * 100) / 100 } : null,
      log: S.log.slice(-100),
    };
  }
  function jointsDeg() {
    const out = {};
    for (const arm of ['leader', 'follower']) {
      out[arm] = {};
      for (const j of JOINTS) out[arm][j] = r1(degOfRaw(S.raw[arm][j]));
    }
    return out;
  }
  function emitTick() {
    onMessage({
      type: 'tick',
      state: snapshotState(),
      joints: jointsDeg(),
      mode: 'mock',
      server: { user: 'demo', hostname: 'devmock', ip: '127.0.0.1' },
    });
  }

  // ---------- 主推進 ----------
  function advance(dtMs) {
    const dt = Math.max(0, Math.min(500, dtMs)); // 防守：分頁休眠後大 dt
    S.t += dt;
    // 到期 timers
    const due = timers.filter((x) => x.at <= S.t);
    timers = timers.filter((x) => x.at > S.t);
    for (const x of due) x.fn();
    // tweens
    const live = [];
    for (const a of tweens) {
      const k = Math.min(1, (S.t - a.t0) / a.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOut
      S.raw[a.arm][a.joint] = clampRaw(a.from + (a.to - a.from) * e);
      if (k < 1) live.push(a);
    }
    tweens = live;
    // 「人手正在動」雜訊
    for (const arm of ['leader', 'follower']) {
      if (rt.noise[arm]) {
        for (const j of JOINTS) S.raw[arm][j] = clampRaw(S.raw[arm][j] + (Math.random() - 0.5) * 12);
      }
    }
    motionEngine(dt);
    if (S.calib) calibEngine(dt);
    tickAcc += dt;
    while (tickAcc >= TICK_MS) {
      tickAcc -= TICK_MS;
      emitTick();
    }
  }

  // ---------- 模擬相機（合成畫面） ----------
  let camCv = null, camCtx = null;
  function cameraFrame() {
    if (typeof document === 'undefined') return null;
    if (!camCv) {
      camCv = document.createElement('canvas');
      camCv.width = 320; camCv.height = 240;
      camCtx = camCv.getContext && camCv.getContext('2d');
    }
    if (!camCtx) return null;
    const c = camCtx, W = 320, H = 240, t = S.t / 1000;
    c.fillStyle = '#1d2129';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let x = 0; x < W; x += 20) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y < H; y += 20) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    // 桌上的小罐子
    c.fillStyle = '#b07a1e';
    c.fillRect(150 + Math.sin(t * 0.4) * 30, 150, 34, 50);
    c.fillStyle = '#e3dfd5';
    c.fillRect(150 + Math.sin(t * 0.4) * 30, 143, 34, 8);
    // 橘色掃描線
    c.strokeStyle = '#ff7f2a';
    c.lineWidth = 2;
    c.beginPath();
    for (let x = 0; x <= W; x += 4) {
      const y = H * 0.42 + Math.sin(x / 26 + t * 2.2) * 12;
      if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    if (S.phase === 'recording') {
      c.fillStyle = Math.floor(t * 2) % 2 ? '#b3372e' : '#7a2620';
      c.beginPath(); c.arc(W - 18, 18, 7, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = 'rgba(255,255,255,0.75)';
    c.font = '12px ui-monospace, monospace';
    c.fillText('🧪 模擬相機 · gripper', 10, 20);
    c.fillText(clock(), 10, H - 12);
    return camCv.toDataURL('image/jpeg', 0.72);
  }

  // ---------- 瀏覽器計時器 ----------
  function start() {
    if (interval) return;
    lastWall = Date.now();
    interval = setInterval(() => {
      const now = Date.now();
      advance(now - lastWall);
      lastWall = now;
    }, 40);
  }
  function stop() {
    if (interval) clearInterval(interval);
    interval = null;
  }

  log('devmock 模擬器已就緒（?devmock=1）');

  return {
    start, stop, advance, handleApi, cameraFrame,
    snapshotState, emitTick,
    get state() { return S; },
    JOINTS,
  };
}
