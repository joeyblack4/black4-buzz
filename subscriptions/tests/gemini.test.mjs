import test from 'node:test';import assert from 'node:assert/strict';import {apply} from '../../plugins/gemini-subscription/plugin.js';
// A fake `agy acp`: what Antigravity 1.5.18 answers (trimmed). `confirm` false: it does not confirm the pick.
const session={sessionId:'session',_meta:{antigravity:{tier:{name:'Google AI Ultra'}}},
 configOptions:[{id:'model',category:'model',currentValue:'gemini-4-neon',options:[{value:'gemini-4-neon',name:'Gemini 4 Neon'},{value:'gemini-4-carbon',name:'Gemini 4 Carbon'}]}],
 models:{availableModels:['gemini-4-neon-high','gemini-4-neon-xhigh','gemini-4-neon-low','gemini-4-carbon-medium','gemini-4-carbon-low'].map(modelId=>({modelId}))}};
// What a free or Plus account's session lists (no Carbon or Neon), and the model agy picks for it.
const plus={sessionId:'session',_meta:{antigravity:{tier:{name:'Google AI Plus'}}},
 configOptions:[{id:'model',category:'model',currentValue:'gemini-4-flash',options:[{value:'gemini-4-hydrogen',name:'Gemini 4 Hydrogen'},{value:'gemini-4-flash',name:'Gemini 4 Flash'}]}],
 models:{availableModels:['gemini-4-hydrogen-high','gemini-4-hydrogen-low','gemini-4-flash-low'].map(modelId=>({modelId}))}};
function fake({signedIn=true,confirm=true,answers=session}={}){
 const calls=[],launches=[];
 const spawn=async(id,o)=>{launches.push({id,...o});let resolve;const exited=new Promise(r=>resolve=r);
  return {exited,kill:async()=>resolve(0),end:async()=>resolve(0),write:async s=>{const m=JSON.parse(s);calls.push(m);let result={},error;
   if(m.method==='session/new'||m.method==='session/load'){if(signedIn)result=answers;else error={code:-32000,message:'Authentication required'};}
   if(m.method==='session/set_config_option')result={configOptions:[{id:m.params.configId,currentValue:confirm?m.params.value:'other'}]};
   if(m.method==='session/prompt'){o.onStdout(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'hello'}}}})+'\n');result={stopReason:'end_turn'};}
   o.onStdout(JSON.stringify(error?{jsonrpc:'2.0',id:m.id,error}:{jsonrpc:'2.0',id:m.id,result})+'\n');}};};
 return {calls,launches,spawn};
}
function load(f){
 let type,cleanup,closed=0,replies=[];
 const kit={conversation:async()=>({key:'thread'}),turnPrompt:async()=>({text:'hello',cursor:'cursor',restore(){}}),systemPrompt:async()=>'Buzz instructions',tools:()=>async()=>({result:{}}),reply:async(a,c,t)=>replies.push(t)};
 apply({react:{createElement(){}},effect:fn=>cleanup=fn(),agents:{harness:kit,register:t=>type=t},host:{resolveDirectory:async p=>p,serveMcp:async()=>({url:'http://127.0.0.1:1/mcp',headers:[],close:async()=>closed++}),spawn:f.spawn}});
 return {type,replies,closed:()=>closed,cleanup:()=>cleanup()};
}
const delivery=config=>({agent:{key:'agent'},config,signal:new AbortController().signal,current:()=>true});
test('Gemini runs agy acp with every tool allowed and no key in its environment, and confirms model and Thinking before the prompt',async()=>{
 const f=fake(),p=load(f);
 await p.type.run(delivery({model:'gemini-4-neon',effort:'xhigh'}));
 const run=f.launches.at(-1);
 assert.equal(run.id,'gemini');
 assert.deepEqual(run.args,['acp','--dangerously-skip-permissions','--disable-telemetry']);
 for(const name of ['GEMINI_API_KEY','GOOGLE_API_KEY','AGY_ADC_AUTH'])assert.equal(run.env[name],null,name);
 const methods=f.calls.map(m=>m.method);
 assert.deepEqual(methods,['initialize','session/new','session/set_config_option','session/set_config_option','session/prompt']);
 assert.deepEqual(f.calls.filter(m=>m.method==='session/set_config_option').map(m=>[m.params.configId,m.params.value]),[['model','gemini-4-neon'],['thought_level','xhigh']]);
 assert.deepEqual(f.calls[1].params.mcpServers,[{type:'http',name:'buzz',url:'http://127.0.0.1:1/mcp',headers:[]}]);
 assert(f.calls.at(-1).params.prompt[0].text.startsWith('Buzz instructions'));
 assert.deepEqual(p.replies,['hello']);assert.equal(p.closed(),1);
 await p.type.run(delivery({model:'gemini-4-neon'}));
 assert.equal(f.calls.filter(m=>m.method==='session/load').length,1,'the thread goes on in its session');
 p.cleanup();
});
test('Gemini sends no prompt when Antigravity does not confirm the pick, and asks for a sign-in when signed out',async()=>{
 const f=fake({confirm:false}),p=load(f);
 await assert.rejects(p.type.run(delivery({model:'gemini-4-carbon'})),/did not confirm the model gemini-4-carbon/);
 assert(!f.calls.some(m=>m.method==='session/prompt'));p.cleanup();
 const out=fake({signedIn:false}),q=load(out);
 await assert.rejects(q.type.run(delivery({model:'gemini-4-neon'})),/Sign in to Google/);
 assert(!out.calls.some(m=>m.method==='session/prompt'));q.cleanup();
});
test('Gemini lists what Antigravity offers the account, each model with its own Thinking levels',async()=>{
 const f=fake(),p=load(f);
 const models=()=>p.type.models({config:{}}).models.map(m=>[m.id,m.efforts.map(e=>e.id)]);
 assert.deepEqual(models(),[]);
 // The account check runs when a screen first asks for it; the listing comes from its session.
 const React=await import('react');const {create,act}=await import('react-test-renderer');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 p.cleanup();
 let type,cleanup;apply({react:React.default??React,effect:fn=>cleanup=fn(),agents:{harness:{},register:t=>type=t},host:{resolveDirectory:async x=>x,serveMcp(){},spawn:f.spawn}});
 let ui,ready=false;await act(async()=>{ui=create(React.createElement(type.CreateConfiguration,{config:{model:'gemini-4-carbon',effort:'medium'},onChange(){},onReadyChange:v=>ready=v}));});
 assert.deepEqual(type.models({config:{}}).models.map(m=>[m.id,m.efforts.map(e=>e.id)]),[['gemini-4-neon',['low','high','xhigh']],['gemini-4-carbon',['low','medium']]]);
 assert.equal(ready,true);
 assert.match(JSON.stringify(ui.toJSON()),/Google AI Ultra/);
 await act(async()=>ui.unmount());cleanup();
});
test('Gemini signs in with a Google link and the pasted code, which goes to agy once and is not kept',async()=>{
 const React=(await import('react')).default;const {create,act}=await import('react-test-renderer');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 let signedIn=false,written=[],type,cleanup;const base=fake();
 const spawn=async(id,o)=>{
  if(!o.args.includes('--login'))return fake({signedIn}).spawn(id,o);
  let resolve;const exited=new Promise(r=>resolve=r);
  queueMicrotask(()=>o.onStdout('Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=s\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n'));
  return {exited,kill:async()=>resolve(1),write:async s=>{written.push(s);if(s==='good-code\n'){signedIn=true;resolve(0);}else{o.onStdout('couldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\n');resolve(1);}}};
 };
 apply({react:React,effect:fn=>cleanup=fn(),agents:{harness:{},register:t=>type=t},host:{resolveDirectory:async x=>x,serveMcp(){},spawn}});
 const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
 let ui;await act(async()=>{ui=create(React.createElement(type.CreateConfiguration,{config:{},onChange(){},onReadyChange(){}}));});
 const signIn=async code=>{
  await act(async()=>{ui.root.findAllByType('button').find(b=>text(b)==='Sign in with Google').props.onClick();});
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});
  const open=ui.root.findAll(n=>n.type==='a'&&String(n.props.href||'').startsWith('https://accounts.google.com/o/oauth2/'));
  assert.equal(open.length,1,'the Google link is shown');
  const input=ui.root.findAllByType('input')[0];assert.equal(input.props.type,'password');
  await act(async()=>{input.props.onChange({target:{value:code}});});
  await act(async()=>{ui.root.findAllByType('button').find(b=>text(b)==='Finish').props.onClick();});
  await act(async()=>{await new Promise(r=>setTimeout(r,20));});
 };
 await signIn('bad-code');
 assert.match(text(ui.toJSON()),/That code was not accepted/);
 await signIn('good-code');
 assert.deepEqual(written,['bad-code\n','good-code\n']);
 assert.match(text(ui.toJSON()),/Connected to Antigravity · Google AI Ultra/);
 assert(!JSON.stringify(ui.toJSON()).includes('good-code'),'the code is not kept on screen');
 await act(async()=>ui.unmount());cleanup();void base;
});
test('a new Gemini agent names no model and runs the one Antigravity picks for its account; a Thinking level alone is still set',async()=>{
 const f=fake(),p=load(f);
 assert.equal(p.type.defaults().config.model,'','no model of its own: plans list different ones');
 await p.type.run(delivery({}));
 assert.deepEqual(f.calls.map(m=>m.method),['initialize','session/new','session/prompt'],'nothing set, nothing to confirm');
 assert.deepEqual(p.replies,['hello']);
 await p.type.run({...delivery({effort:'low'}),agent:{key:'other'}});
 assert.deepEqual(f.calls.filter(m=>m.method==='session/set_config_option').map(m=>[m.params.configId,m.params.value]),[['thought_level','low']]);
 p.cleanup();
});
test('Create is ready on a Plus account, on the model Antigravity picks for it, not a model the plan lacks',async()=>{
 const f=fake({answers:plus});
 const React=(await import('react')).default;const {create,act}=await import('react-test-renderer');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 let type,cleanup;apply({react:React,effect:fn=>cleanup=fn(),agents:{harness:{},register:t=>type=t},host:{resolveDirectory:async x=>x,serveMcp(){},spawn:f.spawn}});
 const config=type.defaults().config;
 assert.equal(type.summary({config}),'Default model','before the account is checked, no model is named');
 let ui,ready=false;await act(async()=>{ui=create(React.createElement(type.CreateConfiguration,{config,onChange(){},onReadyChange:v=>ready=v}));});
 assert.equal(ready,true,'Create is enabled on a plan without Neon');
 assert.equal(type.models({config}).current,'gemini-4-flash','the account’s own pick');
 assert.equal(type.summary({config}),'gemini-4-flash');
 const model=ui.root.findAll(x=>x.props.role==='combobox')[0];
 assert.match(JSON.stringify(ui.toJSON()),/Gemini 4 Flash/);
 assert.deepEqual(ui.root.findAll(x=>x.props.role==='option').map(x=>x.props['data-value']).slice(0,2),['gemini-4-hydrogen','gemini-4-flash']);
 void model;
 // A model the person names is kept as named, and Create waits for one the plan lists.
 assert.equal(type.models({config:{model:'gemini-4-neon'}}).current,'gemini-4-neon');
 let readyNeon=true;await act(async()=>ui.unmount());
 await act(async()=>{ui=create(React.createElement(type.CreateConfiguration,{config:{model:'gemini-4-neon'},onChange(){},onReadyChange:v=>readyNeon=v}));});
 assert.equal(readyNeon,false);
 await act(async()=>ui.unmount());cleanup();
});
test('a Google sign-in that fails says why, from what agy wrote on stderr',async()=>{
 const React=(await import('react')).default;const {create,act}=await import('react-test-renderer');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 let type,cleanup,said='';const base=fake({signedIn:false});
 const spawn=async(id,o)=>{
  if(!o.args.includes('--login'))return base.spawn(id,o);
  let resolve;const exited=new Promise(r=>resolve=r);
  queueMicrotask(()=>o.onStdout('Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=x&state=s\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n'));
  return {exited,kill:async()=>resolve(1),write:async s=>{o.onStderr?.(said+'\n');resolve(1);}};
 };
 apply({react:React,effect:fn=>cleanup=fn(),agents:{harness:{},register:t=>type=t},host:{resolveDirectory:async x=>x,serveMcp(){},spawn}});
 const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
 let ui;await act(async()=>{ui=create(React.createElement(type.CreateConfiguration,{config:{},onChange(){},onReadyChange(){}}));});
 const signIn=async code=>{
  await act(async()=>{ui.root.findAllByType('button').find(b=>text(b)==='Sign in with Google').props.onClick();});
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});
  const input=ui.root.findAllByType('input')[0];
  await act(async()=>{input.props.onChange({target:{value:code}});});
  await act(async()=>{ui.root.findAllByType('button').find(b=>text(b)==='Finish').props.onClick();});
  await act(async()=>{await new Promise(r=>setTimeout(r,20));});
 };
 said='error: couldn’t log in: token exchange failed: Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com: no such host';
 await signIn('some-code');
 assert.match(text(ui.toJSON()),/Sign-in did not finish: couldn.t log in: token exchange failed: Post "https:\/\/oauth2\.googleapis\.com\/token": dial tcp/);
 assert(!text(ui.toJSON()).includes('some-code'),'never the code');
 said='couldn’t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."';
 await signIn('bad-code');
 assert.match(text(ui.toJSON()),/That code was not accepted/,'a refused code on stderr is recognised too');
 await act(async()=>ui.unmount());cleanup();
});
test('every subscription manifest declares processes the way Buzz accepts them',async()=>{
 const {readFileSync}=await import('node:fs');
 for(const dir of ['claude-subscription','grok-subscription','gemini-subscription']){
  const m=JSON.parse(readFileSync(new URL(`../../plugins/${dir}/manifest.json`,import.meta.url)));
  // Buzz's plugin manager (crates/plugin-manager valid_program): a bare program name, at most 16 arguments.
  for(const p of m.host.processes){assert.match(p.program,/^[A-Za-z0-9._-]{1,80}$/,dir+' '+p.id);assert((p.args||[]).length<=16);}
  assert(m.description.length<=280);
 }
});
