import test from 'node:test';import assert from 'node:assert/strict';
import {packet,PacketDecoder,SerialBus,HardwareFollower,JOINTS,REG,word,rawToJoint,jointToRaw,calibrationIssues,mergeCalibration} from '../web/feetech-serial.js';
import {Controller,ARM_LIMITS} from '../web/control-core.js';
import {InputSession} from '../web/input-session.js';
import {applyGripperTarget} from '../web/gripper-gesture.js';
const records=()=>Object.fromEntries(JOINTS.map((n,i)=>[n,{id:i+1,model:777,mode:0,homing_offset:i-2,drive_mode:0,range_min:n==='wrist_roll'?0:800,range_max:n==='wrist_roll'?4095:3300}]));
class MockBus{
 constructor(){this.cal=records();this.raw=Object.fromEntries(JOINTS.map(n=>[n,2047]));this.writes=[];this.torque=0;}
 async open(){}async close(){this.closed=true;}
 async read(id,addr,size){const n=JOINTS[id-1],c=this.cal[n];if(addr===REG.model)return word(c.model);if(addr===REG.min)return [...word(c.range_min),...word(c.range_max)];if(addr===REG.homing)return word(c.homing_offset<0?(-c.homing_offset)|2048:c.homing_offset);if(addr===REG.mode)return[c.mode];if(addr===REG.present)return word(this.raw[n]);if(addr===REG.torque)return[this.torque];throw new Error('unmocked read');}
 async syncWrite(addr,size,rows){this.writes.push({addr,size,rows});if(addr===REG.torque)this.torque=rows[0][1][0];}
}
test('Feetech read packet has expected bytes and checksum',()=>{assert.deepEqual([...packet(1,2,[56,2])],[255,255,1,4,2,56,2,190]);});
test('decoder accepts fragmented frames, rejects bad checksum and noise',()=>{const d=new PacketDecoder();const a=packet(1,0,[1,8]);assert.deepEqual(d.feed([6,255]),[]);assert.deepEqual(d.feed(a.slice(0,3)),[]);assert.equal(d.feed(a.slice(3))[0].data[1],8);const b=[...a];b[5]=4;assert.equal(d.feed([...b,...a]).length,1);});
test('URDF encoder conversion does not subtract hardware homing twice',()=>{const c=records().shoulder_pan;assert.equal(rawToJoint(2047,c),0);assert.equal(rawToJoint(3071,c),90);assert.equal(jointToRaw(90,c),3071);assert.equal(jointToRaw(999,c),c.range_max-12);});
test('factory limits cannot be treated as an existing arm calibration',()=>{const c=records();assert.equal(calibrationIssues(c).length,0);c.elbow_flex.range_min=0;c.elbow_flex.range_max=4095;assert.match(calibrationIssues(c).join(),/出廠/);});
test('existing JSON only merges matching hardware; never overrides mismatched EEPROM',()=>{const c=records(),f=structuredClone(c);f.wrist_roll.drive_mode=1;assert.equal(mergeCalibration(c,f).wrist_roll.drive_mode,1);f.elbow_flex.homing_offset++;assert.throws(()=>mergeCalibration(c,f),/不符/);});
test('connect/disconnect are strictly read-only; no torque or calibration writes',async()=>{const b=new MockBus(),h=new HardwareFollower(b);await h.connect();await h.disconnect();assert.equal(b.writes.length,0);});
test('unknown model fails handshake before any write',async()=>{const b=new MockBus();b.cal.elbow_flex.model=11272;const h=new HardwareFollower(b);await assert.rejects(h.connect(),/STS3215/);assert.equal(b.writes.length,0);assert.ok(b.closed);});
test('arming requires confirmation, seeds actual positions, then enables torque',async()=>{const b=new MockBus(),h=new HardwareFollower(b);b.raw.elbow_flex=2300;await h.connect();await assert.rejects(h.arm(false));assert.equal(b.writes.length,0);await h.arm(true);assert.equal(b.writes[0].addr,42);assert.deepEqual(b.writes[0].rows[2][1].slice(0,2),word(2300));assert.equal(b.writes[1].addr,40);assert.equal(h.target,null);});
test('target is limited relative to measured pose; stale command latches HOLD',async()=>{let now=0;const b=new MockBus(),h=new HardwareFollower(b,{clock:()=>now});await h.connect();await h.arm(true);h.submit(Object.fromEntries(JOINTS.map(n=>[n,70])),true);now=100;await h.step();const row=b.writes.at(-1).rows[0][1];assert.ok(row[0]+row[1]*256-2047<=23);now=500;await h.step();assert.equal(h.armed,false);assert.deepEqual(b.writes.at(-1).rows[0][1].slice(0,2),word(2047));});
test('stop during an outstanding read prevents subsequent motion target',async()=>{const b=new MockBus(),h=new HardwareFollower(b);await h.connect();await h.arm(true);h.submit(Object.fromEntries(JOINTS.map(n=>[n,70])),true);let release;const original=b.read.bind(b);let once=true;b.read=async(...args)=>{if(once&&args[1]===56){once=false;await new Promise(r=>release=r);}return original(...args);};const step=h.step();await new Promise(r=>setImmediate(r));const stopped=h.stop();release();await step;await stopped;assert.equal(h.armed,false);assert.deepEqual(b.writes.at(-1).rows[0][1].slice(0,2),word(2047));});
test('SerialBus rejects EEPROM writes and poisons timed-out connection',async()=>{const port={async open(){},async close(){},writable:new WritableStream({write(){}}),readable:new ReadableStream({start(){},cancel(){}})};const b=new SerialBus(port,{timeout:10});await b.open();await assert.rejects(b.syncWrite(31,2,[[1,[0,0]]]),/禁止/);await assert.rejects(b.read(1,56,2),/逾時/);await assert.rejects(b.read(2,56,2),/逾時/);await b.close();});

test('camera input survives USB connect and arm; measured-pose seeding never starts tracking',async()=>{
 let now=0;const bus=new MockBus(),hw=new HardwareFollower(bus,{clock:()=>now}),ctrl=new Controller(ARM_LIMITS),input=new InputSession(ctrl,{hardware:()=>hw});
 input.selectMode('camera');await hw.connect();input.seedPose(hw.actual);
 assert.equal(input.mode,'camera');assert.equal(bus.writes.length,0);
 input.stop();await hw.arm(true);input.seedPose(hw.actual);
 assert.equal(input.mode,'camera');assert.equal(hw.armed,true);assert.equal(ctrl.stopped,true);
 const writes=bus.writes.length;now=100;await hw.step();assert.equal(bus.writes.length,writes);
 input.resume();ctrl.submit({...hw.actual,elbow_flex:20},now);ctrl.tick(now);now=200;
 const result=ctrl.tick(now);hw.submit(result.value,result.state==='TRACK');await hw.step();
 assert.equal(hw.armed,true);assert.equal(bus.writes.at(-1).addr,REG.goal);
 const elbow=bus.writes.at(-1).rows[2][1];assert.ok(elbow[0]+256*elbow[1]>2047);
});

test('moving a slider in manual mode keeps hardware enabled and sends the new goal',async()=>{
 let now=0;const bus=new MockBus(),hw=new HardwareFollower(bus,{clock:()=>now}),ctrl=new Controller(ARM_LIMITS),input=new InputSession(ctrl,{hardware:()=>hw});
 await hw.connect();await hw.arm(true);input.seedPose(hw.actual);input.resume();ctrl.tick(0);
 input.setManualJoint('elbow_flex',20);input.setManualJoint('elbow_flex',25);
 assert.equal(hw.armed,true);assert.equal(ctrl.stopped,false);
 ctrl.submit(input.manual,1);now=100;const result=ctrl.tick(now);hw.submit(result.value,true);await hw.step();
 const elbow=bus.writes.at(-1).rows[2][1];assert.ok(elbow[0]+256*elbow[1]>2047);
 assert.equal(bus.writes.filter(w=>w.addr===REG.torque).length,1);
});

test('changing input or leaving the page still latches hardware HOLD; resume alone cannot rearm',async()=>{
 const bus=new MockBus(),hw=new HardwareFollower(bus),ctrl=new Controller(ARM_LIMITS),input=new InputSession(ctrl,{hardware:()=>hw});
 await hw.connect();await hw.arm(true);input.seedPose(hw.actual);input.resume();
 input.selectMode('camera');await hw.queue;assert.equal(hw.armed,false);assert.equal(ctrl.stopped,true);
 input.resume();assert.equal(hw.armed,false);
 await hw.arm(true);input.seedPose(hw.actual);await input.stop('分頁已切到背景');
 input.resume();assert.equal(hw.armed,false);assert.equal(hw.target,null);
});

test('invalid manual or measured inputs cannot mutate a valid target',()=>{
 const ctrl=new Controller(ARM_LIMITS),input=new InputSession(ctrl);const before={...input.manual};
 assert.throws(()=>input.setManualJoint('elbow_flex',NaN));assert.throws(()=>input.setManualJoint('unknown',1));assert.throws(()=>input.seedPose({elbow_flex:2}));
 assert.deepEqual(input.manual,before);assert.deepEqual(ctrl.value,before);
});

test('gripper-only pinch closes through bounded USB goals without changing the other five joints',async()=>{
 let now=0;const bus=new MockBus(),hw=new HardwareFollower(bus,{clock:()=>now});
 bus.raw.gripper=2800;await hw.connect();await hw.arm(true);
 const target=applyGripperTarget(null,{ready:true,angle:0},hw.actual,{onlyGripper:true});
 hw.submit(target,true);now=100;await hw.step();
 const write=bus.writes.at(-1);assert.equal(write.addr,REG.goal);
 for(const [id,bytes]of write.rows){const raw=bytes[0]+256*bytes[1];if(id===6){assert.ok(raw<2800&&raw>=2777);}else assert.equal(raw,2047);}
});

test('hardware captures the raw camera goal, aligns from actual pose, then follows live targets',async()=>{
 let now=0;const bus=new MockBus(),hw=new HardwareFollower(bus,{clock:()=>now});bus.raw.gripper=2300;
 await hw.connect();await hw.arm(true,{alignOnStart:true});
 const initial={...hw.actual},cameraGoal={...initial,shoulder_pan:30,gripper:0},filtered={...initial,shoulder_pan:1};
 const atArm=bus.writes.length;
 for(now=0;now<400;now+=100){hw.submit(filtered,true,{alignmentTarget:cameraGoal});await hw.step();}
 assert.equal(bus.writes.length,atArm);assert.equal(hw.alignmentStatus.phase,'waiting');
 hw.submit(filtered,true,{alignmentTarget:cameraGoal});await hw.step();
 assert.ok(Math.abs(hw.alignment.goal.shoulder_pan-30)<.1);assert.equal(hw.alignment.start.shoulder_pan,initial.shoulder_pan);
 const fixedGoal=hw.alignment.goal.shoulder_pan;let previous={...bus.raw};
 while(hw.needsAlignment&&now<15000){
  now+=100;const live={...initial,shoulder_pan:70,gripper:0};hw.submit(live,true,{alignmentTarget:live});await hw.step();
  assert.equal(hw.alignment.goal.shoulder_pan,fixedGoal);
  const write=bus.writes.at(-1);for(const [id,bytes]of write.rows){const name=JOINTS[id-1],raw=bytes[0]+bytes[1]*256;assert.ok(Math.abs(raw-previous[name])<=23);bus.raw[name]=raw;}
  assert.equal(bus.raw.gripper,2300);previous={...bus.raw};
 }
 assert.equal(hw.armed,true);assert.equal(hw.alignmentStatus.phase,'following');assert.ok(Math.abs(hw.actual.shoulder_pan-30)<2);
 const aligned=bus.raw.shoulder_pan;now+=100;hw.submit({...initial,shoulder_pan:70},true);await hw.step();
 const pan=bus.writes.at(-1).rows[0][1];assert.ok(pan[0]+256*pan[1]>aligned);
});

test('stop and missing camera input cancel an in-progress alignment without automatic restart',async()=>{
 let now=0;const bus=new MockBus(),hw=new HardwareFollower(bus,{clock:()=>now});await hw.connect();await hw.arm(true,{alignOnStart:true});
 const target={...hw.actual,shoulder_pan:45};
 for(now=0;now<=500;now+=100){hw.submit(target,true);await hw.step();}
 assert.equal(hw.alignmentStatus.phase,'aligning');now=1000;await hw.step();
 assert.equal(hw.armed,false);assert.equal(hw.needsAlignment,false);assert.equal(hw.alignment,null);
 hw.submit(target,true);await hw.step();assert.equal(hw.armed,false);
 await hw.arm(true,{alignOnStart:true});hw.submit(target,true);await hw.stop();
 assert.equal(hw.alignmentStatus.phase,'off');assert.equal(hw.target,null);
});

test('a motor that does not reach the alignment goal stays connected but stops instead of entering live follow',async()=>{
 let now=0;const states=[],bus=new MockBus(),hw=new HardwareFollower(bus,{clock:()=>now,onState:state=>states.push(state)});
 await hw.connect();await hw.arm(true,{alignOnStart:true});const target={...hw.actual,shoulder_pan:20};
 for(now=0;now<12000&&hw.armed;now+=100){hw.submit(target,true);await hw.step();}
 assert.equal(hw.armed,false);assert.equal(hw.connected,true);assert.match(states.at(-1),/起始姿勢未能到位/);
 assert.deepEqual(bus.writes.at(-1).rows[0][1].slice(0,2),word(bus.raw.shoulder_pan));
});
