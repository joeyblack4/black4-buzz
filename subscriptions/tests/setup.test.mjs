import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {create,act} from 'react-test-renderer';
import {apply} from '../../plugins/claude-subscription/plugin.js';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
test('creation blocks signed-out users, signs in locally, becomes ready and saves choices',async()=>{
 let type,cleanup,signedIn=false,ready=false,config={model:'opus'},launches=[];
 apply({react:React,effect:f=>cleanup=f(),agents:{harness:{},register:t=>type=t},host:{serveMcp(){},spawn:async(id,o)=>{
 launches.push(o);let resolve;const exited=new Promise(r=>resolve=r);
 if(o.args.includes('login')){signedIn=true;queueMicrotask(()=>resolve(0));}
 return{end:async()=>{o.onStdout(JSON.stringify({loggedIn:signedIn,authMethod:'claude.ai',email:'person@example.test'}));resolve(0);},kill:async()=>resolve(1),exited};
 }}});
 let ui;const onReadyChange=v=>ready=v;const onChange=v=>config=v;
 await act(async()=>{ui=create(React.createElement(type.CreateConfiguration,{config,onChange,onReadyChange}));});
 assert.equal(ready,false);
 const button=ui.root.findAllByType('button').find(x=>x.children.join('')==='Sign in with Claude');
 await act(async()=>{button.props.onClick();});
 assert.equal(ready,true);assert(launches.find(x=>x.args.includes('--claudeai')));
 assert(launches.every(x=>x.env.ANTHROPIC_API_KEY===null));
 await act(async()=>{ui.root.findAllByType('select')[0].props.onChange({target:{value:'sonnet'}});});
 assert.equal(config.model,'sonnet');assert.equal(config.effort,'');
 await act(async()=>ui.unmount());assert.equal(ready,false);cleanup();
});
