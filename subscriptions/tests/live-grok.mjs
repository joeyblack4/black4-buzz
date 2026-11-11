import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {apply} from '../../plugins/grok-subscription/plugin.js';
let type,cleanup,toolCalls=0,replies=[];
const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'buzz-grok-test-'));
const kit={conversation:async()=>({key:'test'}),systemPrompt:async()=> 'You are testing a Buzz plugin. Follow the user request. Use the buzz MCP echo tool once. Do not send messages to any real service.',turnPrompt:async()=>({text:'Call buzz echo with cobalt. Then write a file named proof.txt containing cobalt in the working directory. Read it back and answer with cobalt.',cursor:'one',restore(){}}),tools:()=>async m=>{
 if(m.method==='initialize')return {jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'buzz-test',version:'1'}}};
 if(m.method==='tools/list')return {jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',description:'Echo test text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}};
 if(m.method==='tools/call'){toolCalls++;return {jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:m.params.arguments.text}]}};}
 return {jsonrpc:'2.0',id:m.id,result:{}};
},reply:async(a,c,t)=>{replies.push(t);}};
apply({react:{createElement(){}},effect:f=>cleanup=f(),agents:{harness:kit,register:t=>type=t},host:{resolveDirectory:async()=>cwd,readFile:p=>fs.readFile(p),serveMcp:async handler=>{
 const server=createServer(async(req,res)=>{if(req.method!=='POST'){res.writeHead(405).end();return;}let raw='';for await(const b of req)raw+=b;const m=JSON.parse(raw);if(m.id===undefined){res.writeHead(202).end();return;}const r=await handler(m);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(r));});await new Promise(r=>server.listen(0,'127.0.0.1',r));return{url:`http://127.0.0.1:${server.address().port}/mcp`,headers:[],close:()=>new Promise(r=>server.close(r))};
},spawn:async(id,o)=>{const env={...process.env};for(const [k,v]of Object.entries(o.env||{})){if(v===null)delete env[k];else env[k]=v;}const p=spawn(id,o.args,{cwd:o.cwd||cwd,env});p.stdout.on('data',b=>{for(const l of b.toString().split('\n'))try{const m=JSON.parse(l);if(m.result?.sessionId||m.result?.configOptions)console.log('Confirmed session config:',JSON.stringify(m.result.configOptions?.map(o=>({id:o.id,value:o.currentValue}))||m.result.models?.currentModelId));}catch{}o.onStdout?.(b.toString());});p.stderr.on('data',()=>{});return{write:async s=>{p.stdin.write(s);},end:async s=>{p.stdin.end(s);},kill:async()=>{p.kill();},exited:new Promise((r,j)=>{p.on('exit',r);p.on('error',j);})};}}});
try{await type.run({agent:{key:'test'},config:{model:'grok-4.6',effort:'low'},signal:new AbortController().signal,current:()=>true});await type.run({agent:{key:'test'},config:{model:'grok-4.5',effort:'medium'},signal:new AbortController().signal,current:()=>true});assert(toolCalls>1);assert.equal((await fs.readFile(path.join(cwd,'proof.txt'),'utf8')).trim(),'cobalt');assert(replies.join('').includes('cobalt'));console.log('PASS live Grok: subscription inference, MCP call, file write/read, final reply');}finally{cleanup();}
