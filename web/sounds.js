// sounds.js — Web Audio 全合成音效（無音檔）
// 規則：AudioContext 必須在使用者第一次手勢（開機按鈕）時由 initAudio() 建立。
// 所有函式在尚未 init 時安靜地不做事，絕不丟例外。

let ctx = null;     // AudioContext
let master = null;  // 主音量

/** 在第一次使用者手勢時呼叫：建立（或喚醒）AudioContext */
export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return;
  }
  const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return;
  try {
    ctx = new AC();
  } catch (e) {
    ctx = null;
    return;
  }
  // 輕壓縮避免多音疊加爆音
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 24;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(comp);
  comp.connect(ctx.destination);
}

function ready() {
  if (!ctx || !master) return false;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return true;
}

/**
 * 開機和弦：C 大調 add9（C3 + G3 + E4 + D5），暖鋸齒波 + 低通濾波，
 * 2.5 秒 swell-decay，每個音兩支微 detune 振盪器 →「Mac 開機」的溫暖感。
 */
export function chime() {
  if (!ready()) return;
  const t0 = ctx.currentTime + 0.02;
  const dur = 2.5;

  // 低通：先悶 → 打開 → 慢慢收回（swell 的「呼吸」）
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(300, t0);
  lp.frequency.linearRampToValueAtTime(2400, t0 + 0.55);
  lp.frequency.exponentialRampToValueAtTime(400, t0 + dur);

  // 總 envelope：0 → 峰值（0.42s）→ 指數衰減到結尾
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(0.32, t0 + 0.42);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  lp.connect(env);
  env.connect(master);

  const notes = [130.81, 196.00, 329.63, 587.33]; // C3 G3 E4 D5
  const gains = [0.32, 0.26, 0.20, 0.11];          // 低音厚、高音點綴
  notes.forEach((f, i) => {
    [-4, +3].forEach((cents, k) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = cents + (i - 1.5) * 0.7 + k; // 微散開，避免相位完全對齊
      const g = ctx.createGain();
      g.gain.value = gains[i] / 2;
      o.connect(g);
      g.connect(lp);
      o.start(t0);
      o.stop(t0 + dur + 0.1);
    });
  });
}

// 五聲音階 C5 D5 E5 G5 A5 C6 —— joint_centered 依 pitch_index 往上爬
const PENTA = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50];

/** 「噔」：正弦 + 2 次泛音，~350ms 指數衰減；i 取五聲音階第 i 音 */
export function ding(i = 0) {
  if (!ready()) return;
  const n = PENTA.length;
  const f = PENTA[((Math.round(i) % n) + n) % n];
  const t0 = ctx.currentTime + 0.01;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(0.5, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
  env.connect(master);

  const o1 = ctx.createOscillator();
  o1.type = 'sine';
  o1.frequency.value = f;
  const o2 = ctx.createOscillator(); // 2 倍頻泛音，亮一點
  o2.type = 'sine';
  o2.frequency.value = f * 2;
  const g2 = ctx.createGain();
  g2.gain.value = 0.3;
  o1.connect(env);
  o2.connect(g2);
  g2.connect(env);
  o1.start(t0); o2.start(t0);
  o1.stop(t0 + 0.4); o2.stop(t0 + 0.4);
}

/** 成功：上行琶音（C5 E5 G5 C6）三角波，輕快 */
export function success() {
  if (!ready()) return;
  const notes = [523.25, 659.25, 783.99, 1046.50];
  const base = ctx.currentTime + 0.01;
  notes.forEach((f, i) => {
    const t0 = base + i * 0.085;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.3, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    env.connect(master);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(env);
    o.start(t0);
    o.stop(t0 + 0.55);
  });
}

/** 錯誤：低頻柔和雙音（不刺耳、不嚇人） */
export function error() {
  if (!ready()) return;
  const blips = [[196.0, 0], [146.83, 0.17]]; // G3 → D3
  const base = ctx.currentTime + 0.01;
  blips.forEach(([f, dt]) => {
    const t0 = base + dt;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.24, t0 + 0.03); // 軟起音
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    env.connect(master);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 0.5;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    o.connect(env);
    o2.connect(g2);
    g2.connect(env);
    o.start(t0); o2.start(t0);
    o.stop(t0 + 0.26); o2.stop(t0 + 0.26);
  });
}

/** 倒數用極短 click（滴答） */
export function tickTock() {
  if (!ready()) return;
  const t0 = ctx.currentTime + 0.005;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 6;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(0.22, t0 + 0.003);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
  bp.connect(env);
  env.connect(master);
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = 1900;
  o.connect(bp);
  o.start(t0);
  o.stop(t0 + 0.06);
}
