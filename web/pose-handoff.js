// Capture one stable operator pose, then move from measured hardware position to it.
export const ARM_AXES=['shoulder_pan','shoulder_lift','elbow_flex','wrist_flex','wrist_roll'];
const finitePose=(pose,keys)=>pose&&keys.every(key=>Number.isFinite(pose[key]));
const maxError=(a,b,keys)=>Math.max(...keys.map(key=>Math.abs(a[key]-b[key])));

export class StablePoseCapture {
 constructor({holdMs=400,maxDrift=4,minSamples=3,keys=ARM_AXES}={}){this.holdMs=holdMs;this.maxDrift=maxDrift;this.minSamples=minSamples;this.keys=keys;this.reset();}
 reset(){this.anchor=null;this.mean=null;this.since=null;this.lastSeen=null;this.count=0;}
 update(pose,now){
  if(!finitePose(pose,this.keys)||!Number.isFinite(now)){this.reset();return null;}
  if(!this.anchor||now<this.lastSeen||now-this.lastSeen>250||maxError(pose,this.anchor,this.keys)>this.maxDrift){
   this.anchor={...pose};this.mean={...pose};this.since=now;this.count=0;
  }
  this.lastSeen=now;this.count++;
  for(const key of this.keys)this.mean[key]+=(pose[key]-this.mean[key])/this.count;
  return now-this.since>=this.holdMs&&this.count>=this.minSamples?{...this.mean}:null;
 }
}

export class PoseTween {
 constructor(start,goal,now,{speed=20,minDurationMs=1200,tolerance=3,settleMs=250,timeoutMs=6000,keys=ARM_AXES}={}){
  if(!finitePose(start,keys)||!finitePose(goal,keys)||!Number.isFinite(now)||speed<=0)throw new Error('無效起始對齊姿勢');
  this.start={...start};this.goal={...goal};this.startTime=now;this.keys=keys;
  // The maximum derivative of 6t^5 − 15t^4 + 10t^3 is 1.875.
  this.durationMs=Math.max(minDurationMs,1.875*maxError(start,goal,keys)/speed*1000);
  // A powered gravity-loaded STS3215 can settle ~2.5° short with its existing
  // controller settings. Allow 3° for arrival only; the 4° command envelope stays.
  this.tolerance=tolerance;this.settleMs=settleMs;this.timeoutMs=timeoutMs;this.settledSince=null;
 }
 sample(now,actual){
  if(!finitePose(actual,this.keys))throw new Error('缺少馬達量測位置');
  const elapsed=Math.max(0,now-this.startTime),t=Math.min(1,elapsed/this.durationMs),s=t*t*t*(10+t*(-15+6*t));
  const pose={...this.start};for(const key of this.keys)pose[key]=this.start[key]+(this.goal[key]-this.start[key])*s;
  const error=maxError(actual,this.goal,this.keys);
  if(t>=1&&error<=this.tolerance)this.settledSince??=now;else this.settledSince=null;
  const complete=this.settledSince!==null&&now-this.settledSince>=this.settleMs;
  const timedOut=!complete&&elapsed>this.durationMs+this.timeoutMs;
  return {pose,phase:timedOut?'timeout':complete?'complete':t>=1?'settling':'aligning',progress:t,error,durationMs:this.durationMs};
 }
}
