export const inject = ["agents", "host", "react"];
export function apply(ctx) {
const spec = {"provider": "claude", "title": "Claude Sub Plugin", "defaultModel": "opus"};
const {agents, host, react: R} = ctx, h = R.createElement, kit = agents.harness;
if (!kit || !host.spawn || !host.serveMcp) throw new Error('Update Buzz desktop to use subscription agents.');
const processes = new Set(), sessions = new Map(), queues = new Map(), listeners = new Set();
let disposed = false, checking = null, loginProcess = null;
let account = {state:'unchecked', message:'Check your subscription account on this computer.'};
let choices = spec.provider === 'claude' ? ['opus','sonnet','fable'].map(id=>({id,label:id,efforts:['low','medium','high','xhigh','max']})) : [];
const env = spec.provider === 'claude' ? {ANTHROPIC_API_KEY:null,ANTHROPIC_AUTH_TOKEN:null,ANTHROPIC_BASE_URL:null,CLAUDE_CODE_OAUTH_TOKEN:null,CLAUDE_CODE_USE_BEDROCK:null,CLAUDE_CODE_USE_VERTEX:null,CLAUDE_CODE_USE_FOUNDRY:null} : {XAI_API_KEY:null,GROK_API_KEY:null};
function publish(next) { if(disposed) return; account=next; for(const f of listeners) f(account); }
ctx.effect(()=>()=>{disposed=true; for(const p of processes) void p.kill(); listeners.clear();sessions.clear();});
async function spawn(args, options={}) {
 const p=await host.spawn(spec.provider,{env,args,...options});
 processes.add(p); p.exited.finally(()=>processes.delete(p)).catch(()=>{});
 if(disposed) {await p.kill();throw new Error('Plugin stopped');} return p;
}
async function command(args, timeout=30000) {
 let out=''; const p=await spawn(args,{onStdout:s=>{out+=s;if(out.length>1000000)void p.kill();}});
 const timer=setTimeout(()=>void p.kill(),timeout);
 try {await p.end();const code=await p.exited;if(code!==0)throw new Error('Account check failed. Sign in or retry.');return out;}finally{clearTimeout(timer);await p.kill();}
}
async function rpc(args=[], options={}) {
 let proc, buffer='', sequence=0, closed=false; const pending=new Map();
 function fail(error){for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(error);}pending.clear();}
 async function message(m){
  if(m.method && m.id!==undefined){
   let result;
   if(m.method==='session/request_permission' && options.allowTools){const option=m.params.options.find(o=>o.kind==='allow_once');result={outcome:option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'}};}
   if(result)await proc.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
   else await proc.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported client method'}})+'\n');
  }else if(m.method==='session/update'){options.onUpdate?.(m.params?.update);}
  else if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}
 }
 proc=await spawn([...args,'agent','stdio'],{cwd:options.cwd,onStdout:s=>{
  buffer+=s; if(buffer.length>8000000){fail(new Error('Grok output exceeded limit'));void proc?.kill();return;}
  let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())try{void message(JSON.parse(line)).catch(fail);}catch{fail(new Error('Invalid Grok protocol response'));}}
 }});
 proc.exited.then(()=>{closed=true;fail(new Error('Grok process ended'));},fail);
 return {process:proc, async request(method,params,timeout=30000){
  if(closed)throw new Error('Grok process ended');const id=++sequence;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},timeout);pending.set(id,{resolve,reject,timer});proc.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n').catch(error=>{clearTimeout(timer);pending.delete(id);reject(error);});});
 },async close(){closed=true;fail(new Error('Grok connection closed'));await proc.kill();}};
}
async function checkAccount(){
 if(checking)return checking;
 publish({state:'checking',message:'Checking your account…'});
 checking=(async()=>{try {
  if(spec.provider==='claude'){
   const result=JSON.parse(await command(['auth','status','--json']));
   if(!result.loggedIn || result.authMethod!=='claude.ai')throw new Error('Sign in with your Claude subscription.');
   publish({state:'ready',message:'Connected to your Claude subscription'+(result.email?' · '+result.email:'')});
  }else{
   const client=await rpc();try{
    const init=await client.request('initialize',{protocolVersion:1,clientCapabilities:{}});
    
    const result=await client.request('authenticate',{methodId:'cached_token',_meta:{headless:true}});
    if(result._meta?.auth_mode!=='Oidc')throw new Error('Sign in with your Grok subscription.');
    const probe=await client.request('session/new',{cwd:await host.resolveDirectory('~/.buzz/SUB_AGENTS/grok/setup'),mcpServers:[]});
    choices=(probe.models?.availableModels||init._meta?.modelState?.availableModels||[]).map(m=>({id:m.modelId,label:m.name,efforts:(m._meta?.reasoningEfforts||[]).map(e=>e.id)}));
    if(probe.sessionId)await client.request('session/close',{sessionId:probe.sessionId}).catch(()=>{});
    publish({state:'ready',message:'Connected to Grok'+(result._meta?.email?' · '+result._meta.email:'')+(result._meta?.subscription_tier?' · '+result._meta.subscription_tier.replaceAll('_',' '):'')});
   }finally{await client.close();}
  }
 }catch(error){publish({state:'required',message:String(error.message||error)});}finally{checking=null;}})();return checking;
}
async function login(){
 if(loginProcess||account.state==='signing-in')return;
 publish({state:'signing-in',message:'Finish signing in in your browser, then return here.'});
 let timer;
 try{
  loginProcess=await spawn(spec.provider==='claude'?['auth','login','--claudeai']:['login','--oauth']);
  timer=setTimeout(()=>void loginProcess?.kill(),300000);
  const code=await loginProcess.exited;
  if(code!==0)throw new Error('Sign-in was cancelled or did not finish. Try again.');
  sessions.clear();await checkAccount();
 }catch(error){publish({state:'required',message:String(error.message||error)});}finally{clearTimeout(timer);loginProcess=null;}
}
async function install(){
 if(['installing','checking','signing-in'].includes(account.state))return;
 publish({state:'installing',message:'Installing the official CLI…'});
 let p,timer;try{
  p=await host.spawn('install',{});processes.add(p);
  timer=setTimeout(()=>void p.kill(),180000);
  if(await p.exited!==0)throw new Error('Installation failed. Use the official setup guide below, then check connection.');
  await checkAccount();
 }catch(e){publish({state:'required',message:String(e.message||e)});}finally{clearTimeout(timer);if(p){processes.delete(p);await p.kill();}}
}
function Account({onReadyChange,disabled,config}){
 const [state,setState]=R.useState(account);
 R.useEffect(()=>{listeners.add(setState);void checkAccount();return()=>listeners.delete(setState);},[]);
 R.useEffect(()=>{onReadyChange?.(state.state==='ready'&&choices.some(m=>m.id===(config?.model||spec.defaultModel)&&(!config?.effort||m.efforts.includes(config.effort))));return()=>onReadyChange?.(false);},[state,onReadyChange,config?.model,config?.effort]);
 const busy=state.state==='checking'||state.state==='signing-in'||state.state==='installing';
 return h('div',{style:{display:'grid',gap:'var(--space-2)'}},
 h('p',{'aria-live':'polite'},state.message),
 h('p',null,'Use your own subscription on this computer. Your sign-in stays in the official '+spec.provider+' app; it is not shared with your community.'),
 h('div',null,h('button',{type:'button',disabled:disabled||busy,onClick:()=>void login()},state.state==='ready'?'Switch account':'Sign in with '+(spec.provider==='claude'?'Claude':'Grok')),
 h('button',{type:'button',disabled:disabled||busy,onClick:()=>void checkAccount()},'Check connection'),
 state.state==='signing-in'&&h('button',{type:'button',onClick:()=>void loginProcess?.kill()},'Cancel')),
 state.state==='required'&&h('button',{type:'button',disabled:disabled||busy,onClick:()=>void install()},'Install '+(spec.provider==='claude'?'Claude':'Grok')+' CLI'),
 state.state==='required'&&h('p',null,'Installation needs Node.js/npm on this computer. You can also use the ',h('a',{href:spec.provider==='claude'?'https://code.claude.com/docs/en/setup':'https://docs.x.ai/build/overview',target:'_blank',rel:'noreferrer'},'official setup guide'),', then check connection.'));
}
function Model({config,onChange,disabled}){return h('label',null,'Model ',h('select',{disabled,value:config?.model||choices[0]?.id||spec.defaultModel,onChange:e=>onChange({...config,model:e.target.value,effort:''})},...choices.map(m=>h('option',{key:m.id,value:m.id},m.label))));}
function Thinking({config,onChange,disabled}){const m=choices.find(m=>m.id===(config?.model||spec.defaultModel))||choices[0];return h('label',null,'Reasoning effort ',h('select',{disabled,value:config?.effort||'',onChange:e=>onChange({...config,effort:e.target.value})},h('option',{value:''},'Default'),...(m?.efforts||[]).map(e=>h('option',{key:e,value:e},e))));}
function Configuration(props){const [,refresh]=R.useState(0);R.useEffect(()=>{const f=()=>refresh(n=>n+1);listeners.add(f);return()=>listeners.delete(f);},[]);return h('div',null,props.harnessControl,h(Account,props),h(Model,props),props.showEffort!==false&&h(Thinking,props));}
function Create({config,onChange,disabled}){return h('label',null,'Instructions',h('textarea',{rows:5,value:config?.instructions||'',disabled,onChange:e=>onChange({...config,instructions:e.target.value})}));}
function Settings({agent,save,settingsContent}){
 const [draft,setDraft]=R.useState(agent.config||{}),[busy,setBusy]=R.useState(false),[error,setError]=R.useState('');
 const props={config:draft,onChange:setDraft,disabled:busy};
 return h('div',null,settingsContent,h(Configuration,props),h(Create,props),error&&h('p',{role:'alert'},error),h('button',{disabled:busy,onClick:async()=>{setBusy(true);try{await save({...agent.config,...draft});setError('');}catch(e){setError(String(e));}finally{setBusy(false);}}},busy?'Saving…':'Save'));
}
function register(run){agents.register({id:spec.provider,title:spec.title,description:'Personal subscription agent on this computer.',Create,CreateConfiguration:Configuration,CreateModel:Configuration,createModelReportsReadiness:true,CreateThinking:Thinking,
 tabs:[{id:'settings',title:'Settings',role:'settings',component:Settings}],
 defaults:()=>({config:{instructions:'',model:spec.defaultModel,effort:''}}),
 models:agent=>({current:agent.config?.model||spec.defaultModel,models:choices.map(m=>({id:m.id,label:m.label,efforts:m.efforts.map(id=>({id,label:id}))}))}),
 summary:agent=>[agent.config?.model||spec.defaultModel,agent.config?.effort].filter(Boolean).join(' · '),timeoutMs:600000,
 protectionUnavailable:'This plugin does not implement protected execution.',
 async run(delivery){const conversation=await kit.conversation(delivery,'thread');if(!conversation){delivery.ignored?.();return;}const key=delivery.agent.key+':'+conversation.key;const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(()=>run(delivery,conversation,key));queues.set(key,next);try{await next;}finally{if(queues.get(key)===next)queues.delete(key);}}
});}
async function context(delivery,conversation,key){
 const previous=sessions.get(key),cwd=await host.resolveDirectory('~/.buzz/SUB_AGENTS/'+spec.provider+'/'+delivery.agent.key);
 const prompt=await kit.turnPrompt(delivery,conversation,{cursor:previous?.cursor});
 try {
 const system=await kit.systemPrompt(delivery,{scope:'thread',cwd,tools:true,instructions:delivery.config?.instructions||''});
 let finalSent=false;const handler=kit.tools(delivery.agent,conversation,{read:path=>host.readFile(path,{cwd})});
 const server=await host.serveMcp(async message=>{const response=await handler(message);if(message?.method==='tools/call'&&['send','reply_in_subthread'].includes(message.params?.name)&&message.params?.arguments?.final===true&&response?.result&&!response.result.isError&&!response.error)finalSent=true;return response;});
 return {previous,cwd,prompt,system,server,finalSent:()=>finalSent};
 } catch(error) {prompt.restore();throw error;}
}

register(async(delivery,conversation,key)=>{
 if(disposed||delivery.signal.aborted||!delivery.current())return;
 let c,process,consumed=false,stopped=false;
 const stop=async()=>{stopped=true;await process?.kill();};
 delivery.signal.addEventListener('abort',stop,{once:true});delivery.interruptible?.(stop);
 try{
  c=await context(delivery,conversation,key);
  const model=delivery.model||delivery.config?.model||spec.defaultModel,effort=delivery.effort||delivery.config?.effort;
  const args=['-p','--output-format','json','--permission-mode','dontAsk','--tools','default','--allowedTools','Read,Glob,Grep,Bash,Edit,Write,WebFetch,WebSearch,mcp__buzz','--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{buzz:{type:'http',url:c.server.url,headers:Object.fromEntries(c.server.headers.map(h=>[h.name,h.value]))}}}),'--system-prompt',c.system,'--model',model];
  if(effort)args.push('--effort',effort);if(c.previous)args.push('--resume',c.previous.id);
  let stdout='';process=await spawn(args,{cwd:c.cwd,onStdout:s=>{stdout+=s;if(stdout.length>8000000)void stop();}});
  if(stopped||disposed||delivery.signal.aborted){await stop();return;}
  delivery.acknowledged?.();await process.end(c.prompt.text);consumed=true;
  const code=await process.exited;if(stopped)return;if(code!==0)throw new Error('Claude could not finish. Check your subscription connection in Settings.');
  const result=JSON.parse(stdout);if(result.is_error||!result.session_id)throw new Error('Claude did not complete successfully.');
  sessions.set(key,{id:result.session_id,cursor:c.prompt.cursor});
  if(!c.finalSent()&&delivery.current()&&!delivery.signal.aborted&&result.result?.trim())await kit.reply(delivery.agent,conversation,result.result);
 }catch(error){sessions.delete(key);if(!stopped)throw error;}
 finally{delivery.signal.removeEventListener('abort',stop);if(stopped)sessions.delete(key);if(c&&!consumed)c.prompt.restore();await process?.kill();await c?.server.close();}
});

}
