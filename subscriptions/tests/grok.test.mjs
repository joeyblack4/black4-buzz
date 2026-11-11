import test from 'node:test';import assert from 'node:assert/strict';import {apply} from '../../plugins/grok-subscription/plugin.js';
for(const rejectModel of [false,true])test('Grok confirms model and effort before inference; rejection='+rejectModel,async()=>{
 let type,cleanup,handler,calls=[],replies=[],closed=0;
 const kit={conversation:async()=>({key:'thread'}),turnPrompt:async()=>({text:'hello',cursor:'cursor',restore(){}}),systemPrompt:async()=> 'Buzz instructions',tools:()=>async()=>({result:{}}),reply:async(a,c,t)=>replies.push(t)};
 apply({react:{createElement(){}},effect:f=>cleanup=f(),agents:{harness:kit,register:t=>type=t},host:{resolveDirectory:async()=>'/tmp',serveMcp:async h=>(handler=h,{url:'http://127.0.0.1:1',headers:[],close:async()=>closed++}),spawn:async(id,o)=>{
 let resolve;const exited=new Promise(r=>resolve=r);return {exited,kill:async()=>resolve(0),write:async s=>{const m=JSON.parse(s);calls.push(m);let result={};
 if(m.method==='authenticate')result={_meta:{auth_mode:'Oidc'}};
 if(m.method==='session/new')result={sessionId:'session',models:{availableModels:[]}};
 if(m.method==='session/set_config_option')result={configOptions:[{id:m.params.configId,currentValue:rejectModel?'wrong':m.params.value}]};
 if(m.method==='session/prompt'){o.onStdout(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'hello'}}}})+'\n');result={stopReason:'end_turn'};}
 o.onStdout(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
 }};}}});
 const run=()=>type.run({agent:{key:'agent'},config:{model:'grok-4.6',effort:'low'},signal:new AbortController().signal,current:()=>true});
 if(rejectModel){await assert.rejects(run,/did not confirm/);assert(!calls.some(m=>m.method==='session/prompt'));}else{await run();assert.deepEqual(replies,['hello']);const configs=calls.filter(m=>m.method==='session/set_config_option');assert.deepEqual(configs.map(m=>m.params.value),['grok-4.6','low']);assert(calls.find(m=>m.method==='session/prompt').params.prompt[0].text.includes('Buzz instructions'));}
 assert.equal(closed,1);cleanup();
});
