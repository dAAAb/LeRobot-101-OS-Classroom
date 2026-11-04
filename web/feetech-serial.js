// Web Serial → Feetech STS3215 protocol 0. No EEPROM writes, calibration or port scans.
// Register definitions: Hugging Face LeRobot v0.4.4; protocol: ftservo/FTServo_Python.
import {StablePoseCapture,PoseTween} from './pose-handoff.js';
export const JOINTS=['shoulder_pan','shoulder_lift','elbow_flex','wrist_flex','wrist_roll','gripper'];
export const REG={model:3,min:9,max:11,homing:31,mode:33,torque:40,goal:42,present:56};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const u16=(a,i=0)=>a[i]+a[i+1]*256;
export const word=v=>[v&255,(v>>8)&255];
export const signed=(v,bit)=>v&(1<<bit)?-(v&~(1<<bit)):v;
export function packet(id,instruction,params=[]){
 const body=[id,params.length+2,instruction,...params];
 return Uint8Array.from([255,255,...body,(~body.reduce((a,b)=>a+b,0))&255]);
}
// Fragmented/coalesced USB reads and garbage bytes are expected. Checksum is mandatory.
export class PacketDecoder{
 constructor(){this.bytes=[];}
 feed(bytes){
  this.bytes.push(...bytes);const out=[];
  while(this.bytes.length>=4){
   if(this.bytes[0]!==255||this.bytes[1]!==255||this.bytes[2]>=254||this.bytes[3]<2||this.bytes[3]>64){this.bytes.shift();continue;}
   const n=this.bytes[3]+4;if(this.bytes.length<n)break;
   const frame=this.bytes.slice(0,n);
   if((frame.slice(2).reduce((a,b)=>a+b,0)&255)!==255){this.bytes.shift();continue;}
   this.bytes.splice(0,n);out.push({id:frame[2],error:frame[4],data:frame.slice(5,-1)});
  }
  if(this.bytes.length>1024)this.bytes=[];
  return out;
 }
}
export class SerialBus{
 constructor(port,{timeout=250}={}){this.port=port;this.timeout=timeout;this.decoder=new PacketDecoder();this.pending=null;this.fault=null;this.closed=false;}
 async open(){
  await this.port.open({baudRate:1_000_000,dataBits:8,stopBits:1,parity:'none',flowControl:'none',bufferSize:4096});
  this.writer=this.port.writable.getWriter();this.reader=this.port.readable.getReader();this.readTask=this.readLoop();
 }
 fail(error){this.fault=error;if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.reject(error);}}
 async readLoop(){
  try{while(!this.closed){const {value,done}=await this.reader.read();if(done)break;
   for(const f of this.decoder.feed(value??[])){
    const p=this.pending;if(!p||f.id!==p.id)continue;
    // A transaction timeout poisons the connection: late replies cannot answer a later read.
    if(f.error){this.fail(new Error(`馬達 ${f.id} 回報錯誤 0x${f.error.toString(16)}`));break;}
    if(f.data.length!==p.size)continue;
    this.pending=null;clearTimeout(p.timer);p.resolve(f.data);
   }
  }if(!this.closed)this.fail(new Error('USB 已斷線'));}
  catch(e){if(!this.closed)this.fail(e);}
 }
 async read(id,address,size){
  if(this.fault)throw this.fault;if(this.closed)throw new Error('USB 已關閉');if(this.pending)throw new Error('序列交易重疊');
  const reply=new Promise((resolve,reject)=>{this.pending={id,size,resolve,reject,timer:setTimeout(()=>this.fail(new Error(`馬達 ${id} 讀取逾時；請重新連線`)),this.timeout)};});
  // Attach rejection before writing, including synchronous mock/USB failures.
  const result=reply.then(data=>({data}),error=>({error}));
  try{await this.writer.write(packet(id,2,[address,size]));}catch(e){this.fail(e);}
  const r=await result;if(r.error)throw r.error;return r.data;
 }
 async syncWrite(address,size,values){
  if(this.fault)throw this.fault;if(this.closed)throw new Error('USB 已關閉');
  // Deliberately allow only runtime goal/speed and torque registers. Never EEPROM.
  if(!((address===REG.goal&&size===6)||(address===REG.torque&&size===1)))throw new Error('禁止寫入此暫存器');
  const params=[address,size];
  for(const [id,data]of values){if(!Number.isInteger(id)||id<1||id>6||data.length!==size||!data.every(v=>Number.isInteger(v)&&v>=0&&v<=255))throw new Error('無效寫入');params.push(id,...data);}
  await this.writer.write(packet(254,131,params));
 }
 async close(){
  this.closed=true;this.fail(new Error('USB 已關閉'));
  try{await this.reader?.cancel();await this.readTask;this.reader?.releaseLock();}catch{}
  try{this.writer?.releaseLock();await this.port.close();}catch{}
 }
}
export function calibrationIssues(records){
 const issues=[];
 JOINTS.forEach((name,i)=>{
  const c=records[name];
  if(!c||c.id!==i+1||c.model!==777||c.mode!==0){issues.push(`${name}：型號／ID／位置模式不符`);return;}
  if(![c.range_min,c.range_max,c.homing_offset].every(Number.isInteger)||c.range_min<0||c.range_max>4095||c.range_max-c.range_min<100||Math.abs(c.homing_offset)>2047){issues.push(`${name}：校正範圍無效`);return;}
  // wrist_roll normally has the entire encoder range; the other axes must have measured stops.
  if(name!=='wrist_roll'&&c.range_min===0&&c.range_max===4095)issues.push(`${name}：仍為出廠全行程`);
  if(c.range_min>2047||c.range_max<2047)issues.push(`${name}：既有校正不符合半圈歸中座標`);
 });
 return issues;
}
// This viewer uses the SO101 new-calibration URDF, with the calibrated half-turn at q=0.
// These are URDF degrees, NOT LeRobot's range-midpoint DEGREES or gripper percentages.
// Homing is already applied by firmware; subtracting it again would be wrong.
export function rawToJoint(raw,cal){return (raw-2047)*360/4096*(cal.drive_mode?-1:1);}
export function jointToRaw(deg,cal){
 if(!Number.isFinite(deg))throw new Error('非有限角度');
 return Math.round(clamp(2047+deg*(cal.drive_mode?-1:1)*4096/360,cal.range_min+12,cal.range_max-12));
}
export function mergeCalibration(device,file){
 const out={};
 for(const name of JOINTS){
  const c=device[name],f=file[name];
  if(!c||!f||!['id','homing_offset','range_min','range_max'].every(k=>Number.isInteger(f[k])&&f[k]===c[k])||![0,1].includes(f.drive_mode))throw new Error(`${name}：JSON 與這支手臂的 EEPROM 不符；不會覆寫硬體`);
  out[name]={...c,drive_mode:f.drive_mode};
 }
 return out;
}
export class HardwareFollower{
 constructor(bus,{clock=()=>performance.now(),onState=()=>{}}={}){
  this.bus=bus;this.clock=clock;this.onState=onState;this.armed=false;this.connected=false;this.epoch=0;this.queue=Promise.resolve();this.target=null;this.lastTarget=-Infinity;this.actual=null;this.raw=null;this.calibration={};this.issues=[];this.lastStep=null;
  this.commandRaw=null;this.feedback={};this.goal=null;this.limited=[];
  this.clearAlignment();
 }
 clearAlignment(){this.needsAlignment=false;this.poseCapture=null;this.alignmentGoal=null;this.alignment=null;this.alignmentStatus={phase:'off',progress:0};}
 exclusive(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
 async connect(){
  await this.bus.open();
  try{for(let i=0;i<6;i++){
   const id=i+1,model=u16(await this.bus.read(id,REG.model,2));
   if(model!==777)throw new Error(`ID ${id} 並非支援的 STS3215；保持唯讀`);
   const range=await this.bus.read(id,REG.min,4),homing=signed(u16(await this.bus.read(id,REG.homing,2)),11),mode=(await this.bus.read(id,REG.mode,1))[0];
   this.calibration[JOINTS[i]]={id,model,mode,drive_mode:0,range_min:u16(range),range_max:u16(range,2),homing_offset:homing};
  }
  this.issues=calibrationIssues(this.calibration);await this.readPositions();this.connected=true;this.onState('READ ONLY');return this.calibration;
  }catch(e){await this.bus.close();throw e;}
 }
 importCalibration(file){if(this.armed)throw new Error('請先停止實體控制');this.calibration=mergeCalibration(this.calibration,file);this.issues=calibrationIssues(this.calibration);}
 async readPositions(){
  const raw={},feedback={};for(const name of JOINTS){
   const bytes=await this.bus.read(this.calibration[name].id,REG.present,15);
   raw[name]=signed(u16(bytes),15);
   feedback[name]={velocity:signed(u16(bytes,2),15),loadPercent:signed(u16(bytes,4),10)/10,voltage:bytes[6]/10,temperature:bytes[7],status:bytes[9],moving:bytes[10],currentRaw:u16(bytes,13)};
  }
  this.feedback=feedback;
  this.raw=raw;this.actual=Object.fromEntries(JOINTS.map(n=>[n,rawToJoint(raw[n],this.calibration[n])]));return raw;
 }
 positionRows(raw,speed=250){return JOINTS.map(n=>[this.calibration[n].id,[...word(raw[n]),0,0,...word(speed)]]);}
 checkPositions(){for(const n of JOINTS){const c=this.calibration[n],p=this.raw[n];if(p<c.range_min||p>c.range_max)throw new Error(`${n}：目前位置超出 EEPROM 校正範圍`);}}
 arm(confirmedFollower,{alignOnStart=false}={}){
  if(!confirmedFollower)return Promise.reject(new Error('請確認所選 USB 是標準 SO-101 Follower，並核對模型姿勢'));
  const epoch=++this.epoch;
  return this.exclusive(async()=>{
   if(!this.connected||this.issues.length)throw new Error(this.issues.join('；')||'尚未連線');
   await this.readPositions();this.checkPositions();if(epoch!==this.epoch)return;
   // Seed current measured positions BEFORE torque enable, never the old screen target.
   this.hasControl=true;await this.bus.syncWrite(REG.goal,6,this.positionRows(this.raw));this.commandRaw={...this.raw};if(epoch!==this.epoch)return;
   await this.bus.syncWrite(REG.torque,1,JOINTS.map(n=>[this.calibration[n].id,[1]]));
   for(const n of JOINTS){if((await this.bus.read(this.calibration[n].id,REG.torque,1))[0]!==1)throw new Error(`${n}：未啟用扭力`);}
   if(epoch!==this.epoch)return;
   this.clearAlignment();this.needsAlignment=alignOnStart;
   if(alignOnStart){this.poseCapture=new StablePoseCapture();this.alignmentStatus={phase:'ready',progress:0};}
   this.armed=true;this.target=null;this.goal=null;this.limited=[];this.lastTarget=-Infinity;this.lastStep=this.clock();this.onState('ARMED');
  }).catch(e=>{this.armed=false;this.onState('FAULT: '+e.message);throw e;});
 }
 submit(target,active,{alignmentTarget=target}={}){
  if(!this.armed)return;
  if(!active||!target||!JOINTS.every(n=>Number.isFinite(target[n]))){this.stop();return;}
  this.target={...target};this.lastTarget=this.clock();
  if(this.needsAlignment&&!this.alignmentGoal){
   if(!alignmentTarget||!JOINTS.every(n=>Number.isFinite(alignmentTarget[n]))){this.stop('起始姿勢資料不完整');return;}
   const bounded=Object.fromEntries(JOINTS.map(n=>[n,rawToJoint(jointToRaw(alignmentTarget[n],this.calibration[n]),this.calibration[n])]));
   if(this.alignmentStatus.phase!=='waiting')this.onState('ALIGN WAIT — 請保持起始手勢約半秒，再平滑對齊');
   this.alignmentStatus={phase:'waiting',progress:0};
   this.alignmentGoal=this.poseCapture.update(bounded,this.lastTarget);
  }
 }
 step(){return this.exclusive(async()=>{
  if(!this.connected)return;
  const epoch=this.epoch;await this.readPositions();
  if(!this.armed||epoch!==this.epoch)return;
  this.checkPositions();const now=this.clock();
  if(!this.target){this.lastStep=now;return;}
  if(now-this.lastTarget>300){this.armed=false;this.target=null;this.clearAlignment();this.epoch++;await this.bus.syncWrite(REG.goal,6,this.positionRows(this.raw));this.commandRaw={...this.raw};this.onState('HOLD — 輸入逾時，需重新啟用');return;}
  const dt=clamp((now-this.lastStep)/1000,0,.15);this.lastStep=now;
  let goal=this.target;
  if(this.needsAlignment){
   if(!this.alignmentGoal)return; // No motion until one stable, bounded pose is captured.
   if(!this.alignment){this.alignment=new PoseTween(this.actual,{...this.alignmentGoal,gripper:this.actual.gripper},now);this.onState('ALIGNING — 已固定起始目標，平滑對齊中；夾爪保持原位');}
   const result=this.alignment.sample(now,this.actual);goal=result.pose;
   this.alignmentStatus={phase:result.phase,progress:result.progress,error:result.error,durationMs:result.durationMs};
   if(result.phase==='timeout'){const error=result.error.toFixed(1);this.armed=false;this.target=null;this.clearAlignment();this.epoch++;await this.bus.syncWrite(REG.goal,6,this.positionRows(this.raw));this.commandRaw={...this.raw};this.onState(`HOLD — 起始姿勢未能到位（最大誤差 ${error}°），已停止；請檢查手臂再重新啟用`);return;}
   if(result.phase==='complete'){this.needsAlignment=false;this.alignmentStatus.phase='following';this.onState('TRACKING — 起始姿勢已對齊，開始即時跟隨');}
  }
  // Ramp from the LAST SENT command, not from each new measured position. Resetting
  // to actual every frame erased the servo's position error before a loaded joint
  // could overcome its dead zone/gravity. Keep the same 4° measured-position bound.
  const ticks=Math.min(4,20*dt)*4096/360;
  const lead=Math.floor(4*4096/360);this.goal={...goal};this.limited=[];
  const next=Object.fromEntries(JOINTS.map(n=>{
   const c=this.calibration[n],desired=jointToRaw(goal[n],c),previous=this.commandRaw?.[n]??this.raw[n];
   if(Math.abs(rawToJoint(desired,c)-goal[n])>.2)this.limited.push(n);
   const ramped=previous+clamp(desired-previous,-ticks,ticks);
   return [n,Math.round(clamp(ramped,Math.max(c.range_min+12,this.raw[n]-lead),Math.min(c.range_max-12,this.raw[n]+lead)))];
  }));
  if(this.armed&&epoch===this.epoch){await this.bus.syncWrite(REG.goal,6,this.positionRows(next));this.commandRaw=next;}
 }).catch(e=>{this.armed=false;this.epoch++;this.connected=false;this.onState('FAULT: '+e.message);throw e;});}
 stop(reason='已停止追蹤'){
  this.armed=false;this.target=null;this.clearAlignment();this.epoch++;this.onState('HOLD — '+reason);
  return this.exclusive(async()=>{if(!this.connected||!this.hasControl)return;await this.readPositions();await this.bus.syncWrite(REG.goal,6,this.positionRows(this.raw));this.commandRaw={...this.raw};}).catch(e=>{this.connected=false;this.onState('FAULT: '+e.message);});
 }
 async disconnect(){await this.stop();this.connected=false;await this.bus.close();this.onState('DISCONNECTED');}
}
