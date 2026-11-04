// Local geometry only. MediaPipe world landmarks are metres, independent of mirroring.
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const finite=p=>p&&[p.x,p.y,p.z].every(Number.isFinite);
const visible=p=>finite(p)&&(p.visibility??1)>.55&&p.x>=.02&&p.x<=.98&&p.y>=.02&&p.y<=.98;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const fingerPairs=[[5,8],[9,12],[13,16],[17,20]];

export function measureGrasp(hand,world){
 // Reject clipped/fabricated fingers; never interpret a missing hand as a closed fist.
 if(!hand||!world||hand.length!==21||world.length!==21||!hand.every(visible)||!world.every(finite))return null;
 const width=distance(world[5],world[17]),length=distance(world[0],world[9]);
 if(width<.015||width>.18||length<.025||length>.20)return null;
 const pinchRatio=distance(world[4],world[8])/width;
 const pinchOpen=clamp((pinchRatio-.18)/.77,0,1);
 // A fist requires all four fingers to curl: a pointing finger alone is not a fist.
 const fingerOpen=fingerPairs.map(([base,tip])=>clamp((distance(world[tip],world[0])/Math.max(.015,distance(world[base],world[0]))-1.05)/.75,0,1));
 const fistOpen=Math.max(...fingerOpen);
 const openness=Math.min(pinchOpen,fistOpen);
 return {openness,pinchRatio,gesture:openness>.85?'open':pinchOpen<=fistOpen?'pinch':'fist'};
}

export class GripperGesture {
 constructor({mode='analog',stableMs=140,closeAt=.30,openAt=.65}={}){
  this.stableMs=stableMs;this.closeAt=closeAt;this.openAt=openAt;this.setMode(mode);
 }
 setMode(mode){if(!['analog','binary'].includes(mode))throw new Error('未知夾爪模式');this.mode=mode;this.reset();}
 reset(){this.since=null;this.lastSeen=null;this.pending=null;this.pendingSince=null;this.latched=null;}
 update(sample,now,previous=0){
  const held={ready:false,angle:previous,openness:null,gesture:null,state:'missing'};
  if(!sample||!Number.isFinite(sample.openness)||!Number.isFinite(now)){this.reset();return held;}
  if(this.lastSeen===null||now-this.lastSeen>250||now<this.lastSeen)this.reset();
  this.lastSeen=now;this.since??=now;
  const openness=clamp(sample.openness,0,1);
  const desired=openness<=this.closeAt?'closed':openness>=this.openAt?'open':null;
  if(desired!==this.pending){this.pending=desired;this.pendingSince=desired?now:null;}
  if(now-this.since<this.stableMs)return {...held,openness,gesture:sample.gesture,state:'acquiring'};
  if(this.mode==='analog')return {ready:true,angle:openness*80,openness,gesture:sample.gesture,state:'tracking'};
  // Separate close/open thresholds and dwell time stop noisy fingers toggling the jaw.
  if(desired&&now-this.pendingSince>=this.stableMs)this.latched=desired;
  return {ready:true,angle:this.latched===null?previous:this.latched==='closed'?0:80,openness,gesture:sample.gesture,state:this.latched??'holding'};
 }
}

export function selectRightHand(pose,result){
 const hands=result?.landmarks??[],worlds=result?.worldLandmarks??[];
 const wrist=pose?.[16];
 if(visible(wrist)){
  // Prefer the anatomical right wrist from the body, even when handedness flickers.
  const candidates=hands.map((hand,index)=>({index,d:hand?.[0]?Math.hypot((hand[0].x-wrist.x)*4/3,hand[0].y-wrist.y):Infinity}))
   .filter(candidate=>candidate.d<.16).sort((a,b)=>a.d-b.d);
  if(!candidates.length||candidates[1]&&candidates[1].d-candidates[0].d<.035)return {hand:null,handWorld:null};
  const index=candidates[0].index;return {hand:hands[index],handWorld:worlds[index]??null};
 }
 // Gripper-only use can work without the torso. Never fall back to an arbitrary hand.
 const candidates=hands.map((hand,index)=>({hand,index,side:result.handedness?.[index]?.[0]}))
  .filter(({side})=>side?.categoryName==='Right'&&side.score>=.8);
 if(candidates.length!==1)return {hand:null,handWorld:null};
 const {hand,index}=candidates[0];return {hand,handWorld:worlds[index]??null};
}

export function applyGripperTarget(bodyTarget,grip,previous,{onlyGripper=false}={}){
 if(onlyGripper){
  if(!grip?.ready||!previous||!['shoulder_pan','shoulder_lift','elbow_flex','wrist_flex','wrist_roll','gripper'].every(name=>Number.isFinite(previous[name])))return null;
  return {...previous,gripper:grip.angle};
 }
 if(!bodyTarget)return null;
 return {...bodyTarget,gripper:grip?.ready?grip.angle:previous.gripper};
}
