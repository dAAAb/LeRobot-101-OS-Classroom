import {Controller,REACHY_LIMITS,ARM_LIMITS,reachyMap,armMap,faceYaw,synthetic} from './control-core.js';
import {createVision} from './vision.js';
const $=id=>document.getElementById(id),kind=document.body.dataset.kind,limits=kind==='reachy'?REACHY_LIMITS:ARM_LIMITS;
const ctrl=new Controller(limits);let mode='manual',vision=null,stream=null,busy=false,loading=false,lastFrame=-1,lastDetect=0,lastInput=null,center=0,seq=0,logs=[],sim=false,lastPost=0;
const manual=Object.fromEntries(Object.keys(limits).map(k=>[k,0]));
const names={yaw:'頭部轉向',left:'機器人左天線',right:'機器人右天線',shoulder_pan:'肩部左右',shoulder_lift:'肩部抬起',elbow_flex:'手肘彎曲',wrist_flex:'手腕彎曲',wrist_roll:'手腕旋轉',gripper:'夾爪開合'};
for(const [k,[min,max]]of Object.entries(limits)){const l=document.createElement('label');l.innerHTML=`<span>${names[k]}</span><output id="o-${k}">0°</output><input id="j-${k}" type="range" min="${min}" max="${max}" step="1" value="0">`;$('sliders').append(l);l.querySelector('input').oninput=e=>{manual[k]=Number(e.target.value);$('o-'+k).textContent=manual[k]+'°';setMode('manual');};}
let viewer;
if(kind==='reachy'){viewer=await(await import('./reachy-view.js')).createReachy($('view'));}
else{viewer=(await import('./viewer3d.js')).createViewer($('view'));viewer.setColors({leader:'#ffb37a',follower:'#71d8ff'});await viewer.ready;$('viewNote').textContent=viewer.usingFallback?'URDF 載入失敗：目前為 2D 備援示意。請檢查模型檔案。':$('viewNote').textContent;$('reachyOptions').hidden=true;$('calibrate').hidden=true;$('simToggle').hidden=true;}
function status(t){$('status').textContent=t;}
function setMode(m){mode=m;if(m!=='camera')$('latency').textContent='—';$('mode').value=m;ctrl.stop();lastInput=null;status('已切換模式；按「接手／繼續」開始。');}
$('mode').onchange=e=>setMode(e.target.value);
$('resume').onclick=()=>{ctrl.resume();status(mode==='camera'?'追蹤控制中；請保持上半身與手腕在畫面內。':'模擬控制中。');};
function stop(){ctrl.stop();status('已停止。待送命令已清空；手動接手才會繼續。');}
$('stop').onclick=stop;
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target.tagName)){e.preventDefault();stop();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
$('replay').onclick=()=>{setMode('replay');ctrl.resume();status(kind==='reachy'?'合成座標重播：右手週期抬高，頭左右轉動。非真人攝影機測試。':'合成座標重播：右手揮動、手掌捏合。非真人攝影機測試。');};
$('neutral').onclick=()=>{Object.keys(manual).forEach(k=>{manual[k]=0;$('j-'+k).value=0;$('o-'+k).textContent='0°';});setMode('manual');ctrl.resume();};
$('calibrate').onclick=()=>{if(lastInput&&Number.isFinite(lastInput.yaw)){center=lastInput.yaw;status('已將目前頭部方向設為 0°。');}else status('請先啟動攝影機追蹤或合成範例。');};
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
  lastFrame=$('camera').currentTime;lastDetect=now;const t=performance.now();try{const r=vision.detect($('camera'),now);lastInput={...r,yaw:faceYaw(r.matrix)};overlay(lastInput);$('latency').textContent=Math.round(performance.now()-t)+' ms';}catch(e){lastInput=null;status('辨識失敗：'+e.message);}
 }
 // Do not refresh camera commands from stale cached landmarks.
 const fresh=mode==='replay'||mode==='camera'&&now-lastDetect<100;
 if(fresh&&lastInput)target=kind==='reachy'?reachyMap({...lastInput,center,invert:$('invert').checked,mirror:$('mirror').checked,previous:ctrl.value}):armMap(lastInput.pose,lastInput.hand);
 const jitter=Number($('jitter').value),delay=Number($('delay').value)+(Math.random()*2-1)*jitter;
 if(target)ctrl.submit(target,now,{delay,drop:Math.random()<Number($('drop').value),sequence:++seq});
 const r=ctrl.tick(now);$('state').textContent=r.state;$('state').style.color=r.state==='TRACK'?'#8de4c0':r.state==='STOP'?'#ff9eac':'#f4d29b';$('age').textContent=r.age==null?'—':Math.round(r.age)+' ms';$('values').textContent=JSON.stringify({target,applied:r.value,state:r.state},null,2);
 if(kind==='reachy')viewer.set(r.value);else viewer.setJoints({leader:target??r.value,follower:r.value});
 if(now-lastPost>100){lastPost=now;logs.push({t:Math.round(now),mode,state:r.state,angles:r.value,age:r.age});if(logs.length>6000)logs.shift();
  if(kind==='reachy'&&sim&&!busy){busy=true;fetch('/api/target',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({angles:r.value,active:r.state==='TRACK'})}).then(r=>{if(!r.ok)throw new Error('模擬器命令失敗');$('mujoco').src='/api/frame.jpg?t='+Math.round(now);}).catch(e=>status(e.message)).finally(()=>busy=false);}
 }
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
