import test from 'node:test';import assert from 'node:assert/strict';
import {armMap,reachyMap,synthetic} from '../web/control-core.js';
function person(){
 const a=synthetic(0);a.world=Array.from({length:33},()=>({x:0,y:0,z:0,visibility:1}));
 for(const [i,x,y,z] of [[11,.2,-.5,0],[12,-.2,-.5,0],[23,.15,0,0],[24,-.15,0,0],[14,-.2,-.2,0],[16,-.2,-.2,-.3]])a.world[i]={x,y,z,visibility:1};
 return a;
}
test('raising right forearm decreases SO101 elbow q (URDF positive q pitches down)',()=>{
 const a=person(),b=armMap(a.pose,null,a);assert.ok(Math.abs(b.elbow_flex)<1e-8);
 a.world[16]={x:-.2,y:-.5,z:0,visibility:1};const flex=armMap(a.pose,null,a);assert.equal(flex.elbow_flex,-90);
 a.world[16]={x:-.2,y:.1,z:0,visibility:1};assert.equal(armMap(a.pose,null,a).elbow_flex,90);
});
test('raising the upper arm decreases shoulder q and moving right increases pan',()=>{
 const a=person();a.world[14]={x:-.2,y:-.5,z:-.3,visibility:1};a.world[16]={x:-.2,y:-.5,z:-.6,visibility:1};assert.equal(armMap(a.pose,null,a).shoulder_lift,-45);
 a.world[14]={x:-.5,y:-.5,z:0,visibility:1};a.world[16]={x:-.8,y:-.5,z:0,visibility:1};assert.equal(armMap(a.pose,null,a).shoulder_pan,80);
});
test('body coordinates are invariant to translation, distance and torso roll',()=>{
 const a=person(),original=armMap(a.pose,null,a),angle=.4;
 a.world=a.world.map(p=>({...p,x:2*(p.x*Math.cos(angle)-p.y*Math.sin(angle))+3,y:2*(p.x*Math.sin(angle)+p.y*Math.cos(angle))+5,z:2*p.z+2}));
 const moved=armMap(a.pose,null,a);for(const name of ['shoulder_pan','shoulder_lift','elbow_flex'])assert.ok(Math.abs(moved[name]-original[name])<1e-6,name);
});
test('missing hand holds wrist and gripper; missing 3D pose does not use distorted image coordinates',()=>{
 const a=person(),out=armMap(a.pose,null,{...a,previous:{wrist_flex:12,wrist_roll:23,gripper:45}});assert.equal(out.gripper,45);assert.equal(out.wrist_roll,23);assert.equal(armMap(a.pose,a.hand),null);
});
test('mirror mode applies to head and both arms consistently',()=>{
 const a=synthetic(1);a.yaw=20;a.pose[16].y=.04;a.pose[15].y=.9;
 assert.deepEqual(reachyMap(a),{yaw:-20,left:70,right:0});assert.deepEqual(reachyMap({...a,mirror:false}),{yaw:20,left:0,right:70});
});

test('out-of-frame wrist is held even when model visibility remains high',()=>{const a=person();a.pose[16].x=1.1;assert.equal(armMap(a.pose,a.hand,a),null);a.yaw=10;const r=reachyMap({...a,previous:{yaw:0,left:31,right:12}});assert.equal(r.left,31);});
