// All angles in degrees until the simulator adapter. No hardware transport here.
export const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const rad=180/Math.PI;
export const REACHY_LIMITS={yaw:[-35,35],left:[0,70],right:[0,70]};
export const ARM_LIMITS={shoulder_pan:[-80,80],shoulder_lift:[-80,80],elbow_flex:[-90,90],wrist_flex:[-80,80],wrist_roll:[-120,120],gripper:[0,80]};
const good=p=>p && Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z??0)&&(p.visibility??1)>.55;
const sub=(a,b)=>[a.x-b.x,a.y-b.y,(a.z??0)-(b.z??0)];
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const norm=a=>Math.hypot(...a);
const angle=(a,b)=>Math.acos(clamp(dot(a,b)/(norm(a)*norm(b)||1),-1,1))*rad;
// MediaPipe transformation data is column-major. Positive rotation around Y.
export function faceYaw(matrix){if(!matrix||matrix.length!==16||!matrix.every(Number.isFinite))return null;return Math.atan2(matrix[8],matrix[10])*rad;}
export function reachyMap({yaw,pose,center=0,invert=false,mirror=true,previous={yaw:0,left:0,right:0}}){
 const headOk=Number.isFinite(yaw);
 const handOk=(s,w)=>pose&&good(pose[s])&&good(pose[w]);
 if(!headOk&&!handOk(12,16)&&!handOk(11,15))return null;
 const lift=(s,w,h)=>{
  const scale=good(pose[h])?Math.abs(pose[h].y-pose[s].y):.28;
  return clamp((pose[s].y-pose[w].y)/Math.max(.12,scale)+.15,0,1)*70;
 };
 const out={...previous};
 if(headOk)out.yaw=clamp((yaw-center)*(invert?-1:1),-35,35);
 if(handOk(12,16))out[mirror?'left':'right']=lift(12,16,24);
 if(handOk(11,15))out[mirror?'right':'left']=lift(11,15,23);
 return out;
}
export function armMap(pose,hand){
 if(!pose||![12,14,16].every(i=>good(pose[i])))return null;
 const s=pose[12],e=pose[14],w=pose[16],h=pose[24],upper=sub(e,s),fore=sub(w,e);
 if(norm(upper)<.035||norm(fore)<.035)return null;
 // Camera coordinates x right, y down, z away; this is a teaching retarget, NOT IK.
 const out={shoulder_pan:clamp(Math.atan2(upper[0],Math.max(.06,Math.abs(upper[1])))*rad,-80,80),shoulder_lift:clamp(Math.atan2(-upper[1],Math.hypot(upper[0],upper[2]))*rad,-80,80),elbow_flex:clamp(90-angle(sub(s,e),fore),-90,90),wrist_flex:0,wrist_roll:0,gripper:40};
 if(hand&&[0,4,5,8,9,17].every(i=>good(hand[i]))){
  const palm=sub(hand[9],hand[0]),across=sub(hand[5],hand[17]);
  out.wrist_flex=clamp(Math.atan2(fore[0]*palm[1]-fore[1]*palm[0],fore[0]*palm[0]+fore[1]*palm[1])*rad,-80,80);
  out.wrist_roll=clamp(Math.atan2(across[1],Math.abs(across[0]))*rad,-120,120);
  out.gripper=clamp((norm(sub(hand[4],hand[8]))/Math.max(.02,norm(across))-.15)/1.1*80,0,80);
 }
 return out;
}
export function synthetic(t){
 const pose=Array.from({length:33},()=>({x:.5,y:.5,z:0,visibility:1}));
 for(const [i,x,y]of [[11,.62,.38],[12,.38,.38],[13,.70,.55],[14,.27,.50],[15,.74,.72],[16,.18,.50-.32*Math.sin(t)],[23,.58,.75],[24,.42,.75]])pose[i]={x,y,z:0,visibility:1};
 const hand=Array.from({length:21},(_,i)=>({x:pose[16].x+(i%4)*.015,y:pose[16].y-Math.floor(i/4)*.02,z:0}));
 hand[0]={...pose[16]};hand[5]={x:.16,y:pose[16].y-.05,z:0};hand[9]={x:.18,y:pose[16].y-.08,z:0};hand[17]={x:.22,y:pose[16].y-.05,z:0};hand[4]={x:.15,y:pose[16].y-.06,z:0};hand[8]={x:.15+.06*(1+Math.sin(t*1.3)),y:pose[16].y-.06,z:0};
 return {pose,hand,yaw:28*Math.sin(t*.6)};
}
export class Controller{
 constructor(limits,{staleMs=350,speed=120,tauMs=90}={}){this.limits=limits;this.staleMs=staleMs;this.speed=speed;this.tau=tauMs;this.value=Object.fromEntries(Object.keys(limits).map(k=>[k,0]));this.stop();this.lastTick=null;this.lastSequence=-1;}
 stop(){this.stopped=true;this.pending=[];this.target=null;this.lastReceived=-Infinity;}
 resume(){this.stop();this.stopped=false;this.lastSequence=-1;}
 submit(value,now,{delay=0,drop=false,sequence=now}={}){
  if(this.stopped||drop||!value||!Object.keys(this.limits).every(k=>Number.isFinite(value[k])))return false;
  if(sequence<=this.lastSequence)return false;
  const clean=Object.fromEntries(Object.entries(this.limits).map(([k,[a,b]])=>[k,clamp(value[k],a,b)]));
  // Latest-only at each delivery; timestamps preserve order if network packets reorder.
  this.pending.push({value:clean,sent:now,due:now+Math.max(0,delay),sequence});this.pending=this.pending.slice(-120);return true;
 }
 tick(now){
  const dt=this.lastTick===null?0:clamp(now-this.lastTick,0,100);this.lastTick=now;
  if(this.stopped)return {value:{...this.value},state:'STOP',age:null};
  const arrived=this.pending.filter(p=>p.due<=now).sort((a,b)=>a.sequence-b.sequence);this.pending=this.pending.filter(p=>p.due>now);
  for(const p of arrived){if(p.sequence>this.lastSequence){this.target=p.value;this.lastSequence=p.sequence;this.lastReceived=now;this.captureTime=p.sent;}}
  const age=now-this.lastReceived;
  // Hold last pose on loss. Returning to neutral without observation could itself collide.
  if(!this.target||age>this.staleMs)return {value:{...this.value},state:'HOLD',age:Number.isFinite(age)?age:null};
  const alpha=1-Math.exp(-dt/this.tau);
  for(const k in this.value){const delta=(this.target[k]-this.value[k])*alpha;this.value[k]+=clamp(delta,-this.speed*dt/1000,this.speed*dt/1000);}
  return {value:{...this.value},state:'TRACK',age:now-this.captureTime};
 }
}
