import test from 'node:test';import assert from 'node:assert/strict';
import {ARM_AXES,StablePoseCapture,PoseTween} from '../web/pose-handoff.js';
const pose=(angle=0)=>Object.fromEntries([...ARM_AXES,'gripper'].map(key=>[key,key==='gripper'?35:angle]));

test('handoff waits for a stable observed pose and averages sensor jitter',()=>{
 const capture=new StablePoseCapture();assert.equal(capture.update(pose(),0),null);
 assert.equal(capture.update(pose(2),200),null);assert.equal(capture.update(pose(10),300),null);
 assert.equal(capture.update(pose(12),500),null);const goal=capture.update(pose(10),700);
 assert.ok(goal.shoulder_pan>10&&goal.shoulder_pan<11);assert.equal(goal.gripper,35);
});
test('lost or invalid observations cannot complete pose capture',()=>{
 const capture=new StablePoseCapture();capture.update(pose(),0);
 assert.equal(capture.update(pose(),400),null); // Gap resets acquisition.
 assert.equal(capture.update({...pose(),elbow_flex:NaN},500),null);
 assert.equal(capture.update(pose(),600),null);
});
test('quintic tween starts at actual pose, finishes at the fixed goal and respects the speed ceiling',()=>{
 const start=pose(-20),goal=pose(40);goal.gripper=0;
 const tween=new PoseTween(start,goal,0),first=tween.sample(0,start);
 assert.deepEqual(first.pose,start);assert.equal(first.progress,0);
 let previous=first.pose;
 for(let now=20;now<=tween.durationMs+20;now+=20){const result=tween.sample(now,start);for(const key of ARM_AXES)assert.ok(Math.abs(result.pose[key]-previous[key])/0.02<=20.01);assert.equal(result.pose.gripper,35);previous=result.pose;}
 assert.ok(Math.abs(previous.shoulder_pan-40)<1e-9);
 assert.ok(tween.sample(100,start).pose.shoulder_pan-start.shoulder_pan<.1);
});
test('elapsed time is not enough: handoff requires actual motor arrival and settling, otherwise times out',()=>{
 const start=pose(),goal=pose(20),tween=new PoseTween(start,goal,0),end=tween.durationMs;
 assert.equal(tween.sample(end,start).phase,'settling');
 assert.equal(tween.sample(end+100,goal).phase,'settling');
 assert.equal(tween.sample(end+400,goal).phase,'complete');
 const stuck=new PoseTween(start,goal,0);assert.equal(stuck.sample(stuck.durationMs+6001,start).phase,'timeout');
});
