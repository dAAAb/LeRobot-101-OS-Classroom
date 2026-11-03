import test from 'node:test';
import assert from 'node:assert/strict';
import {createMockSim} from '../web/devmock.js';
function ready(){const m=createMockSim();m.state.phase='idle';for(const a of Object.values(m.state.arms))a.calibrated=true;return m;}
function advance(m,n){for(let i=0;i<n;i++)m.advance(40);}
test('manual leader input remains in control and follower approaches it',()=>{
 const m=ready();m.handleApi('/teleop/start');m.handleApi('/mock/joints',{arm:'leader',joints:{elbow_flex:2600}});advance(m,40);
 assert.equal(m.state.raw.leader.elbow_flex,2600);assert.ok(Math.abs(m.state.raw.follower.elbow_flex-2600)<1);
});
test('recording replays the saved joint trajectory, including final pose',()=>{
 const m=ready();m.handleApi('/mock/joints',{arm:'leader',joints:{elbow_flex:2800}});m.handleApi('/record/start',{name:'test',fps:30});advance(m,30);
 const end=m.state.raw.follower.elbow_flex;assert.ok(end>2700);assert.ok(m.handleApi('/record/episode/stop_save').ok);assert.ok(m.handleApi('/record/finish').ok);
 m.state.raw.follower.elbow_flex=1800;m.handleApi('/replay/start',{repo_id:'neo/test',episode:0});advance(m,50);
 assert.equal(m.state.phase,'idle');assert.ok(Math.abs(m.state.raw.follower.elbow_flex-end)<1e-9);
});
test('finish requires a saved episode and discard does not publish a recording',()=>{
 const m=ready();m.handleApi('/record/start',{name:'discard'});advance(m,10);m.handleApi('/record/episode/stop_discard');assert.equal(m.handleApi('/record/finish').ok,false);assert.equal(m.state.datasets.length,0);
});
