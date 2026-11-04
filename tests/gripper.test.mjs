import test from 'node:test';
import assert from 'node:assert/strict';
import {measureGrasp,GripperGesture,selectRightHand,applyGripperTarget} from '../web/gripper-gesture.js';
import {Controller,ARM_LIMITS} from '../web/control-core.js';

function handFixture(gesture='open'){
 const world=Array.from({length:21},()=>({x:0,y:0,z:0}));
 for(const [base,x,y] of [[5,-.03,.06],[9,-.01,.07],[13,.01,.065],[17,.03,.055]]){
  for(let i=0;i<4;i++)world[base+i]={x,y:y+i*.025,z:0};
  if(gesture==='fist')world[base+3]={x,y:y*.85,z:.01};
 }
 for(let i=1;i<=4;i++)world[i]={x:-.02*i,y:.02*i,z:0};
 if(gesture==='pinch')world[4]={...world[8],x:world[8].x-.004};
 const hand=world.map(p=>({x:.5+p.x*3,y:.7-p.y*3,z:p.z}));
 return {hand,world};
}
const neutral=()=>({shoulder_pan:11,shoulder_lift:-25,elbow_flex:30,wrist_flex:8,wrist_roll:15,gripper:40});

test('open palm, thumb/index pinch and whole fist map to the correct jaw direction',()=>{
 for(const [gesture,openness]of[['open',1],['pinch',0],['fist',0]]){
  const {hand,world}=handFixture(gesture),result=measureGrasp(hand,world);
  assert.equal(result.openness,openness,gesture);assert.equal(result.gesture,gesture);
 }
});
test('partial pinch produces an intermediate analog angle, independent of hand size, rotation and display mirroring',()=>{
 const {hand,world}=handFixture();world[4]={...world[8],x:world[8].x-.033};
 const before=measureGrasp(hand,world);assert.ok(before.openness>.2&&before.openness<.8);
 const transformed=world.map(p=>({x:2*p.z+.3,y:2*p.x-.6,z:2*p.y+.8}));
 const mirrored=hand.map(p=>({...p,x:1-p.x}));
 assert.ok(Math.abs(measureGrasp(mirrored,transformed).openness-before.openness)<1e-9);
 const gripper=new GripperGesture();gripper.update(before,0,0);const result=gripper.update(before,150,0);
 assert.equal(result.ready,true);assert.ok(result.angle>0&&result.angle<80);
});
test('a pointing hand is not treated as a fist',()=>{
 const {hand,world}=handFixture('fist');world[8]={x:-.03,y:.15,z:0};
 assert.equal(measureGrasp(hand,world).openness,1);
});
test('clipped, tiny, missing and malformed hands produce no grasp command',()=>{
 const {hand,world}=handFixture('pinch');assert.equal(measureGrasp(null,world),null);
 const clipped=structuredClone(hand);clipped[8].x=1.1;assert.equal(measureGrasp(clipped,world),null);
 const broken=structuredClone(world);broken[8].z=NaN;assert.equal(measureGrasp(hand,broken),null);
 assert.equal(measureGrasp(hand,world.map(p=>({...p,x:p.x*.1,y:p.y*.1}))),null);
});
test('binary close/open requires a stable gesture; the middle band keeps its previous state',()=>{
 const gripper=new GripperGesture({mode:'binary'}),sample=openness=>({openness,gesture:'pinch'});
 assert.equal(gripper.update(sample(1),0,45).ready,false);
 assert.equal(gripper.update(sample(1),150,45).angle,80);
 assert.equal(gripper.update(sample(.2),220,80).angle,80);
 assert.equal(gripper.update(sample(.5),300,80).angle,80); // Noise cancels close.
 assert.equal(gripper.update(sample(.2),370,80).angle,80);
 assert.equal(gripper.update(sample(.2),520,80).angle,0);
 assert.equal(gripper.update(sample(.5),590,0).angle,0);
 assert.equal(gripper.update(sample(.8),650,0).angle,0);
 assert.equal(gripper.update(sample(.8),800,0).angle,80);
});
test('hand loss freezes the measured control angle, clears pending close, and requires reacquisition',()=>{
 const gripper=new GripperGesture({mode:'binary'}),closed={openness:0,gesture:'fist'};
 gripper.update(closed,0,60);const loss=gripper.update(null,100,50);
 assert.equal(loss.angle,50);assert.equal(loss.ready,false);
 assert.equal(gripper.update(closed,200,50).ready,false);
 assert.equal(gripper.update(closed,300,50).angle,50);
 assert.equal(gripper.update(closed,350,50).angle,0);
 assert.equal(gripper.update(closed,700,50).ready,false); // Delayed frames are not fresh observations.
});
test('gripper-only mode leaves all five arm joints unchanged and does not require torso landmarks',()=>{
 const previous=neutral(),target=applyGripperTarget(null,{ready:true,angle:0},previous,{onlyGripper:true});
 assert.deepEqual(target,{...previous,gripper:0});assert.deepEqual(previous,neutral());
 assert.equal(applyGripperTarget(null,{ready:false,angle:0},previous,{onlyGripper:true}),null);
 assert.equal(applyGripperTarget(null,{ready:true,angle:0},previous),null);
 const body={...previous,elbow_flex:12,gripper:0};
 assert.equal(applyGripperTarget(body,{ready:false,angle:0},previous).gripper,40);
});
test('gripper targets still pass through smoothing, speed limit and tracking-loss hold',()=>{
 const ctrl=new Controller(ARM_LIMITS);Object.assign(ctrl.value,neutral());ctrl.resume();ctrl.tick(0);
 const target=applyGripperTarget(null,{ready:true,angle:0},ctrl.value,{onlyGripper:true});
 ctrl.submit(target,1);const first=ctrl.tick(100);assert.ok(first.value.gripper>=28&&first.value.gripper<40);
 for(const key of Object.keys(neutral()).filter(k=>k!=='gripper'))assert.equal(first.value[key],neutral()[key]);
 const held=ctrl.tick(500);assert.equal(held.state,'HOLD');assert.equal(held.value.gripper,first.value.gripper);
});
test('hand-only selection requires one confidently identified right hand; never picks left or ambiguous hands',()=>{
 const {hand,world}=handFixture();
 const result={landmarks:[hand],worldLandmarks:[world],handedness:[[{categoryName:'Right',score:.95}]]};
 assert.equal(selectRightHand(null,result).hand,hand);
 result.handedness[0][0].categoryName='Left';assert.equal(selectRightHand(null,result).hand,null);
 result.handedness[0][0]={categoryName:'Right',score:.6};assert.equal(selectRightHand(null,result).hand,null);
 result.handedness[0][0].score=.95;result.landmarks.push(hand);result.handedness.push(result.handedness[0]);
 assert.equal(selectRightHand(null,result).hand,null);
});
test('body right-wrist association takes precedence and rejects two overlapping hands',()=>{
 const {hand,world}=handFixture();const pose=[];pose[16]={...hand[0],visibility:1};
 const other=hand.map(p=>({...p,x:p.x+.3}));
 const result={landmarks:[other,hand],worldLandmarks:[world,world]};
 assert.equal(selectRightHand(pose,result).hand,hand);
 result.landmarks[0]=hand.map(p=>({...p,x:p.x+.01}));assert.equal(selectRightHand(pose,result).hand,null);
});
