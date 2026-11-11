import test from 'node:test';import assert from 'node:assert/strict';
import {apply} from '../../plugins/claude-subscription/plugin.js';
test('Claude isolates sessions, forwards overrides, removes API auth and suppresses duplicate finals',async()=>{
 let type,cleanup,mcp,final=false,replies=[],launches=[],closed=0;
 const kit={conversation:async d=>({key:d.thread}),turnPrompt:async()=>({text:'test',cursor:'c1',restore(){}}),systemPrompt:async()=>'',tools:()=>async()=>({result:{ok:true}}),reply:async(a,c,t)=>replies.push(t)};
 apply({react:{createElement(){}},effect:f=>cleanup=f(),agents:{harness:kit,register:t=>type=t},host:{resolveDirectory:async()=>'/tmp',readFile:async()=>new Uint8Array(),serveMcp:async h=>(mcp=h,{url:'http://127.0.0.1:1/mcp',headers:[],close:async()=>closed++}),spawn:async(id,o)=>{launches.push(o);return{end:async()=>{if(final)await mcp({method:'tools/call',params:{name:'send',arguments:{final:true}}});o.onStdout(JSON.stringify({session_id:'s'+launches.length,result:'ok'}));},kill:async()=>{},exited:Promise.resolve(0)};}}});
 const d={thread:'one',agent:{key:'agent'},config:{},signal:new AbortController().signal,current:()=>true};
 await type.run(d);await type.run({...d,model:'sonnet',effort:'high'});await type.run({...d,thread:'two'});
 assert(launches[1].args.includes('--resume'));assert(!launches[2].args.includes('--resume'));assert(launches[1].args.includes('sonnet'));assert(launches[1].args.includes('high'));assert.equal(launches[0].env.ANTHROPIC_API_KEY,null);
 final=true;await type.run(d);assert.equal(replies.length,3);assert.equal(closed,4);
 cleanup();await type.run(d);assert.equal(launches.length,4);
});
