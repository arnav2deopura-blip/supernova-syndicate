import test from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../js/player.js';

test('static comparison modes do not redraw on a playback timer',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const frames=[];const player=new Player(i=>frames.push(i));
 player.load(4,0,false);t.mock.timers.tick(2000);
 assert.deepEqual(frames,[0]);assert.equal(player.playing,true);
 player.load(4,0,true);t.mock.timers.tick(1000);
 assert.ok(frames.length>2);
});

test('hidden-page suspension preserves position and playback preference',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const frames=[];const player=new Player(i=>frames.push(i));player.load(4);
 player.setSuspended(true);t.mock.timers.tick(2000);assert.deepEqual(frames,[0]);
 player.setSuspended(false);t.mock.timers.tick(1000);assert.ok(frames.length>1);
});
