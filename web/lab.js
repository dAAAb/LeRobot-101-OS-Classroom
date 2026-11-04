import {Controller,REACHY_LIMITS,ARM_LIMITS,reachyMap,armMap,faceYaw,synthetic} from './control-core.js';
import {createVision} from './vision.js';
import {InputSession} from './input-session.js';
const $=id=>document.getElementById(id),kind=document.body.dataset.kind,limits=kind==='reachy'?REACHY_LIMITS:ARM_LIMITS;
const ctrl=new Controller(limits);let mode='manual',vision=null,stream=null,busy=false,loading=false,lastFrame=-1,lastDetect=0,lastInput=null,center=0,seq=0,logs=[],sim=false,lastPost=0;
let hardware=null,armBaseline=null,armAnchor=null,stableFrames=0,trackingHint='';
const input=new InputSession(ctrl,{hardware:()=>hardware,
 onMode(m){mode=m;stableFrames=0;if(m!=='camera')$('latency').textContent='—';$('mode').value=m;lastInput=null;status('已切換模式；USB 若已連線，請重新啟用實體控制，再按「接手／繼續」。');},
 onManual(pose){for(const k in pose){$('j-'+k).value=pose[k];$('o-'+k).textContent=Math.round(pose[k])+'°';}}
});
const manual=input.manual;
const names={yaw:'頭部轉向',left:'機器人左天線',right:'機器人右天線',shoulder_pan:'肩部左右',shoulder_lift:'肩部抬起',elbow_flex:'手肘彎曲',wrist_flex:'手腕彎曲',wrist_roll:'手腕旋轉',gripper:'夾爪開合'};
for(const [k,[min,max]]of Object.entries(limits)){const l=document.createElement('label');l.innerHTML=`<span>${names[k]}</span><output id="o-${k}">0°</output><input id="j-${k}" type="range" min="${min}" max="${max}" step="1" value="0">`;$('sliders').append(l);l.querySelector('input').oninput=e=>input.setManualJoint(k,Number(e.target.value));}
let viewer;
if(kind==='reachy'){
 viewer={set(){}};sim=true;$('mujoco').style.display='block';$('simToggle').hidden=true;
 $('viewNote').textContent='官方 Reachy Mini XML + MuJoCo + 解析式 IK。僅本機模擬，無實體連線。';
 const state=await(await fetch('/api/status')).json();
 if(!state.mujoco){sim=false;status('請先安裝 requirements-mujoco.txt，再重新啟動 server.py。這個版本只顯示官方物理模擬。');}
}
else{viewer=(await import('./viewer3d.js')).createViewer($('view'));viewer.setColors({leader:'#ffb37a',follower:'#71d8ff'});await viewer.ready;$('viewNote').textContent=viewer.usingFallback?'URDF 載入失敗：目前為 2D 備援示意。請檢查模型檔案。':$('viewNote').textContent;$('reachyOptions').hidden=true;$('calibrate').textContent='以目前手勢為基準';$('simToggle').hidden=true;}
function status(t){$('status').textContent=t;}
function setMode(m){input.selectMode(m);}
$('mode').onchange=e=>setMode(e.target.value);
$('resume').onclick=()=>{input.resume();status(hardware?.connected&&!hardware.armed?'USB 已連線但實體尚未啟用；目前只預覽。請到第 04 區啟用實體控制。':mode==='camera'?'追蹤控制中；請保持上半身與手腕在畫面內。':hardware?.armed?'實體滑桿控制中。':'模擬控制中。');};
function stop(reason){input.stop(typeof reason==='string'?reason:undefined);status('已停止。待送命令已清空；手動接手才會繼續。');}
$('stop').onclick=stop;
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target.tagName)){e.preventDefault();stop();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('分頁已切到背景，請回到此頁重新啟用實體控制');});
$('replay').onclick=()=>{setMode('replay');ctrl.resume();status(kind==='reachy'?'合成座標重播：右手週期抬高，頭左右轉動。非真人攝影機測試。':'合成座標重播：右手揮動、手掌捏合。非真人攝影機測試。');};
$('neutral').onclick=()=>{Object.keys(manual).forEach(k=>{manual[k]=0;$('j-'+k).value=0;$('o-'+k).textContent='0°';});setMode('manual');ctrl.resume();};
$('calibrate').onclick=()=>{
 if(kind==='reachy'&&lastInput&&Number.isFinite(lastInput.yaw)){center=lastInput.yaw;status('已將目前頭部方向設為 0°。');}
 else if(kind==='arm'&&lastInput){const raw=armMap(lastInput.pose,lastInput.hand,{...lastInput,previous:ctrl.value});if(raw){armBaseline=raw;armAnchor={...ctrl.value};status('已對齊操作者手勢；這不會更改馬達的硬體校正。');}else status('請讓雙肩、髖部、右手肘和手腕入鏡。');}
 else status('請先啟動攝影機追蹤或合成範例。');
};
$('cameraStart').onclick=async()=>{
 if(loading)return;loading=true;$('cameraStart').disabled=true;
 try{status('載入本機辨識模型…');vision??=await createVision(kind);stream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480,facingMode:'user'},audio:false});$('camera').srcObject=stream;await $('camera').play();lastFrame=-1;setMode('camera');status('鏡頭已開。請先確認標記在你的右手腕，再按「接手／繼續」。');}
 catch(e){status('無法啟動：'+e.message+'。請執行下載模型步驟，並允許 localhost 的攝影機權限。');stream?.getTracks().forEach(t=>t.stop());stream=null;}
 finally{loading=false;$('cameraStart').disabled=false;}
};
$('cameraStop').onclick=()=>{stop();stream?.getTracks().forEach(t=>t.stop());stream=null;$('camera').srcObject=null;lastInput=null;status('鏡頭已關閉。');};
$('export').onclick=()=>{const blob=new Blob([JSON.stringify({kind,units:'degrees',syntheticOrCamera:mode,records:logs},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='teleop-angles.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
$('simToggle').onclick=async()=>{try{const s=await(await fetch('/api/status')).json();if(!s.mujoco)throw new Error('請以 python server.py --mujoco 啟動');sim=!sim;$('mujoco').style.display=sim?'block':'none';$('viewNote').textContent=sim?'官方 Reachy Mini XML + MuJoCo + 解析式 IK。僅本機模擬，無實體連線。':'教學示意模型（非動力學）';}catch(e){status(e.message);}};
function overlay(input){const c=$('overlay');c.width=640;c.height=480;const ctx=c.getContext('2d');ctx.clearRect(0,0,640,480);if(!input?.pose)return;const p=input.pose;ctx.lineWidth=4;ctx.strokeStyle='#7bd6fa';for(const[a,b]of[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24]]){if(!p[a]||!p[b])continue;ctx.beginPath();ctx.moveTo((1-p[a].x)*640,p[a].y*480);ctx.lineTo((1-p[b].x)*640,p[b].y*480);ctx.stroke();}for(const i of[15,16]){ctx.fillStyle=i===16?'#ffbd81':'#8de4c0';ctx.beginPath();ctx.arc((1-p[i].x)*640,p[i].y*480,9,0,7);ctx.fill();ctx.font='18px sans-serif';ctx.fillText(i===16?'你的右手 R':'你的左手 L',(1-p[i].x)*640+12,p[i].y*480);}}
function frame(now){
 let target=null;
 if(mode==='manual')target={...manual};
 else if(mode==='replay'){lastInput=synthetic(now/1000);overlay(lastInput);}
 else if(mode==='camera'&&vision&&stream&&$('camera').readyState>=2&&$('camera').currentTime!==lastFrame&&now-lastDetect>65){
  lastFrame=$('camera').currentTime;lastDetect=now;const t=performance.now();try{const r=vision.detect($('camera'),now);lastInput={...r,yaw:faceYaw(r.matrix)};
 const observed=kind==='arm'?armMap(lastInput.pose,lastInput.hand,{...lastInput,previous:ctrl.value}):reachyMap({...lastInput,previous:ctrl.value});
 stableFrames=observed?Math.min(3,stableFrames+1):0;
 trackingHint=!observed?(kind==='arm'?'右手臂離開畫面或辨識不足：保持姿勢。請讓雙肩、髖部、右手肘與手腕回到框內。':'看不到頭與手：保持姿勢，請回到鏡頭前。'):stableFrames<3?'已重新看到你，正在確認連續三幀…':kind==='arm'&&!lastInput.hand?'手掌暫時看不到：肩肘繼續，手腕與夾爪保持。':'追蹤穩定。離開畫面會保持姿勢；回到框內後模擬器平順接續。';
 overlay(lastInput);$('latency').textContent=Math.round(performance.now()-t)+' ms';}catch(e){lastInput=null;status('辨識失敗：'+e.message);}
 }
 // Do not refresh camera commands from stale cached landmarks.
 const fresh=mode==='replay'||mode==='camera'&&now-lastDetect<100;
 if(fresh&&lastInput&&(mode!=='camera'||stableFrames>=3))target=kind==='reachy'?reachyMap({...lastInput,center,invert:$('invert').checked,mirror:$('mirror').checked,previous:ctrl.value}):armMap(lastInput.pose,lastInput.hand,{...lastInput,previous:ctrl.value,baseline:armBaseline,anchor:armAnchor});
 const jitter=Number($('jitter').value),delay=Number($('delay').value)+(Math.random()*2-1)*jitter;
 if(target)ctrl.submit(target,now,{delay,drop:Math.random()<Number($('drop').value),sequence:++seq});
 if(mode==='camera'&&!ctrl.stopped)status((hardware?.connected&&!hardware.armed?'實體未啟用，目前只預覽。':'')+(now-lastDetect>350?'攝影機影格中斷：保持姿勢。請檢查鏡頭連線。':trackingHint));
 const r=ctrl.tick(now);$('state').textContent=(hardware?.armed?'實體 · ':hardware?.connected?'預覽 · ':'模擬 · ')+r.state;$('state').style.color=r.state==='TRACK'?'#8de4c0':r.state==='STOP'?'#ff9eac':'#f4d29b';$('age').textContent=r.age==null?'—':Math.round(r.age)+' ms';$('values').textContent=JSON.stringify({target,applied:r.value,state:r.state},null,2);
 if(kind==='reachy')viewer.set(r.value);else viewer.setJoints({leader:target??r.value,follower:hardware?.actual??r.value});
 if(now-lastPost>100){lastPost=now;hardware?.tick(r.value,r.state==='TRACK');logs.push({t:Math.round(now),mode,state:r.state,angles:r.value,age:r.age});if(logs.length>6000)logs.shift();
  if(kind==='reachy'&&sim&&!busy){busy=true;fetch('/api/target',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({angles:r.value,active:r.state==='TRACK'})}).then(r=>{if(!r.ok)throw new Error('模擬器命令失敗');$('mujoco').src='/api/frame.jpg?t='+Math.round(now);}).catch(e=>status(e.message)).finally(()=>busy=false);}
 }
 requestAnimationFrame(frame);
}
const diagnostics=document.createElement('div');diagnostics.className='row';
for(const [name,angle]of Object.entries(kind==='reachy'?{yaw:25,left:70,right:70}:{shoulder_pan:25,shoulder_lift:-25,elbow_flex:-25,wrist_flex:-25,wrist_roll:25,gripper:50})){
 const button=document.createElement('button');button.textContent='單軸：'+names[name];
 button.onclick=()=>{setMode('manual');for(const key in manual){manual[key]=key===name?angle:0;$('j-'+key).value=manual[key];$('o-'+key).textContent=manual[key]+'°';}status('單軸目標已備妥；按「接手／繼續」觀察方向。');};diagnostics.append(button);
}
$('sliders').after(diagnostics);
if(kind==='arm'){
 const {mountHardware}=await import('./hardware-ui.js');
 hardware=mountHardware({stopSimulation:stop,setPose(pose){input.seedPose(pose);}});
}
requestAnimationFrame(frame);
