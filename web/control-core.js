// All angles in URDF degrees until an adapter. Pure mapping, no I/O.
// MediaPipe uses unmirrored input. CSS mirroring is presentation only.
import {measureGrasp,handPointValid} from './gripper-gesture.js';
export const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const rad=180/Math.PI;
export const REACHY_LIMITS={yaw:[-35,35],left:[0,70],right:[0,70]};
export const ARM_LIMITS={shoulder_pan:[-80,80],shoulder_lift:[-80,80],elbow_flex:[-90,90],wrist_flex:[-80,80],wrist_roll:[-120,120],gripper:[0,80]};
const good=p=>p && Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z??0)&&(p.visibility??1)>.55;
const visible=p=>good(p)&&p.x>=.02&&p.x<=.98&&p.y>=.02&&p.y<=.98;
const sub=(a,b)=>[a.x-b.x,a.y-b.y,(a.z??0)-(b.z??0)];
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const norm=a=>Math.hypot(...a);
const angle=(a,b)=>Math.acos(clamp(dot(a,b)/(norm(a)*norm(b)||1),-1,1))*rad;
// MediaPipe transformation data is column-major. Positive rotation around Y.
export function faceYaw(matrix){if(!matrix||matrix.length!==16||!matrix.every(Number.isFinite))return null;return Math.atan2(matrix[8],matrix[10])*rad;}
export function reachyMap({yaw,pose,center=0,invert=false,mirror=true,previous={yaw:0,left:0,right:0}}){
 const headOk=Number.isFinite(yaw);
 const handOk=(s,w)=>pose&&visible(pose[s])&&visible(pose[w]);
 if(!headOk&&!handOk(12,16)&&!handOk(11,15))return null;
 const lift=(s,w,h)=>{
  const scale=good(pose[h])?Math.abs(pose[h].y-pose[s].y):.28;
  return clamp((pose[s].y-pose[w].y)/Math.max(.12,scale)+.15,0,1)*70;
 };
 const out={...previous};
 if(headOk)out.yaw=clamp((yaw-center)*(mirror?-1:1)*(invert?-1:1),-35,35);
 if(handOk(12,16))out[mirror?'left':'right']=lift(12,16,24);
 if(handOk(11,15))out[mirror?'right':'left']=lift(11,15,23);
 return out;
}
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>norm(a)>1e-6?a.map(v=>v/norm(a)):null;
const projected=(a,n)=>a.map((v,i)=>v-dot(a,n)*n[i]);
const signedAngle=(a,b,n)=>Math.atan2(dot(cross(a,b),n),dot(a,b))*rad;
export const hasTorsoReference=(pose,world)=>[23,24].every(i=>good(pose?.[i])&&good(world?.[i]));
export function armTrackingIssue(pose,world){
 if(!pose)return '沒有辨識到身體';
 const names={11:'左肩',12:'右肩',14:'右手肘',16:'右手腕',23:'左髖部參考',24:'右髖部參考'};
 const missing=[11,12,14,16].filter(i=>!visible(pose[i]));
 if(missing.length)return missing.map(i=>names[i]).join('、')+'不在畫面或信心不足';
 if(!world||![11,12,14,16].every(i=>good(world[i])))return '身體 3D 方向還不穩定';
 return null;
}
export function armMap(pose,hand,{world=null,handWorld=null,previous={},baseline=null,anchor=null}={}){
 // World landmarks are metres: unlike normalized x/y, their axes have the same scale.
 if(armTrackingIssue(pose,world))return null;
 const p=world;
 const right=unit(sub(p[12],p[11]));
 const shoulders={x:(p[11].x+p[12].x)/2,y:(p[11].y+p[12].y)/2,z:(p[11].z+p[12].z)/2};
 // A seated webcam often clips the hips while the shoulder/elbow/wrist are clear.
 // Use camera-up as an explicit fallback instead of rejecting a visible arm.
 let torsoUp=[0,-1,0];
 if(hasTorsoReference(pose,p)){
  const hips={x:(p[23].x+p[24].x)/2,y:(p[23].y+p[24].y)/2,z:(p[23].z+p[24].z)/2};
  torsoUp=sub(shoulders,hips);
 }
 if(!right)return null;const up=unit(projected(torsoUp,right));if(!up)return null;
 const forward=unit(cross(up,right)),upper=sub(p[14],p[12]),fore=sub(p[16],p[14]);
 if(!forward||norm(upper)<.04||norm(fore)<.04)return null;
 const horizontal=projected(upper,up),heading=norm(horizontal)>.08?horizontal:projected(fore,up);
 const out={shoulder_pan:norm(heading)>.04?Math.atan2(dot(heading,right),dot(heading,forward))*rad:(previous.shoulder_pan??0),
  shoulder_lift:-angle(upper,up.map(v=>-v))*.5,
  // SO101 URDF +elbow lowers the forearm. Human flexion must decrease that angle.
  elbow_flex:90-angle(upper,fore),wrist_flex:previous.wrist_flex??0,wrist_roll:previous.wrist_roll??0,gripper:previous.gripper??35};
 if(hand&&handWorld&&[0,4,5,8,9,17].every(i=>handPointValid(hand[i])&&handPointValid(handWorld[i]))){
  const palm=sub(handWorld[9],handWorld[0]),across=sub(handWorld[5],handWorld[17]),axis=unit(fore);
  const upright=unit(projected(up,axis));
  if(upright){const rightward=unit(cross(axis,upright));
   // +wrist flex in the URDF pitches down; palm raising therefore gives negative q.
   out.wrist_flex=signedAngle(fore,palm,rightward.map(v=>-v));
   const side=projected(across,axis);if(norm(side)>.015)out.wrist_roll=Math.atan2(dot(side,upright),dot(side,rightward))*rad;
  }
  const grasp=measureGrasp(hand,handWorld);if(grasp)out.gripper=grasp.openness*80;
 }
 // Optional operator pose alignment does not touch any robot motor calibration.
 if(baseline&&anchor)for(const n of Object.keys(out))if(n!=='gripper'&&Number.isFinite(baseline[n]))out[n]=out[n]-baseline[n]+anchor[n];
 return Object.fromEntries(Object.entries(ARM_LIMITS).map(([n,[lo,hi]])=>[n,clamp(out[n],lo,hi)]));
}
export function synthetic(t){
 const pose=Array.from({length:33},()=>({x:.5,y:.5,z:0,visibility:1}));
 for(const [i,x,y]of [[11,.62,.38],[12,.38,.38],[13,.70,.55],[14,.27,.50],[15,.74,.72],[16,.18,.50-.32*Math.sin(t)],[23,.58,.75],[24,.42,.75]])pose[i]={x,y,z:0,visibility:1};
 const handWorld=Array.from({length:21},()=>({x:0,y:0,z:0}));
 for(const [base,x,y]of[[5,-.025,-.045],[9,-.008,-.05],[13,.009,-.045],[17,.025,-.04]])for(let i=0;i<4;i++)handWorld[base+i]={x,y:y-i*.02,z:0};
 for(let i=1;i<=4;i++)handWorld[i]={x:-.013*i,y:-.013*i,z:0};
 handWorld[4]={...handWorld[8],x:handWorld[8].x-.05*(.05+1.15*(1+Math.sin(t*1.3))/2)};
 const hand=handWorld.map(p=>({x:pose[16].x+p.x,y:pose[16].y+p.y,z:p.z}));
 const world=pose.map(p=>({...p,x:(p.x-.5)*1.2,y:(p.y-.5)*1.2,z:p.z}));
 // A fixed torso and a right arm that bends in a sagittal plane.
 world[14]={x:world[12].x,y:world[12].y+.25,z:0,visibility:1};
 world[16]={x:world[14].x,y:world[14].y+.25*Math.cos(t),z:-.25*Math.sin(t),visibility:1};
 return {pose,hand,world,handWorld,yaw:28*Math.sin(t*.6)};
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
