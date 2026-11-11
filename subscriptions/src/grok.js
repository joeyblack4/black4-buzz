register(async(delivery,conversation,key)=>{
 if(disposed||delivery.signal.aborted||!delivery.current())return;
 let c,client,consumed=false,stopped=false,text='';
 const stop=async()=>{stopped=true;await client?.close();};
 delivery.signal.addEventListener('abort',stop,{once:true});delivery.interruptible?.(stop);
 try{
  c=await context(delivery,conversation,key);
  const model=delivery.model||delivery.config?.model||spec.defaultModel,effort=delivery.effort||delivery.config?.effort;
  const args=['--no-subagents','--rules',c.system,'--model',model];if(effort)args.push('--effort',effort);
  client=await rpc(args,{cwd:c.cwd,allowTools:true,onUpdate:u=>{if(u?.sessionUpdate==='agent_message_chunk'&&u.content?.text){text+=u.content.text;if(text.length>8000000)void stop();}}});
  if(stopped||disposed||delivery.signal.aborted){await stop();return;}
  await client.request('initialize',{protocolVersion:1,clientCapabilities:{}});
  const auth=await client.request('authenticate',{methodId:'cached_token',_meta:{headless:true}});
  if(auth._meta?.auth_mode!=='Oidc')throw new Error('Sign in to your Grok subscription in this agent’s Settings.');
  const params={cwd:c.cwd,mcpServers:[{type:'http',name:'buzz',url:c.server.url,headers:c.server.headers}]};
  const session=c.previous?await client.request('session/load',{...params,sessionId:c.previous.id}):await client.request('session/new',params);
  const id=c.previous?.id||session.sessionId;
  if(!id)throw new Error('Grok did not create a session.');
  const selected=await client.request('session/set_config_option',{sessionId:id,configId:'model',value:model});
  if(!selected.configOptions?.some(o=>o.id==='model'&&o.currentValue===model))throw new Error('Grok did not confirm the selected model.');
  const effectiveEffort=effort||(session.models?.availableModels||[]).find(m=>m.modelId===model)?._meta?.reasoningEfforts?.find(e=>e.default)?.id;
  if(effectiveEffort){const selectedEffort=await client.request('session/set_config_option',{sessionId:id,configId:'reasoning_effort',value:effectiveEffort});if(!selectedEffort.configOptions?.some(o=>o.id==='reasoning_effort'&&o.currentValue===effectiveEffort))throw new Error('Grok did not confirm the selected effort.');}
  delivery.acknowledged?.();consumed=true;
  const result=await client.request('session/prompt',{sessionId:id,prompt:[{type:'text',text:c.system+'\n\n'+c.prompt.text}]},570000);
  if(stopped||delivery.signal.aborted||!delivery.current())return;
  if(result.stopReason!=='end_turn')throw new Error('Grok stopped: '+result.stopReason);
  sessions.set(key,{id,cursor:c.prompt.cursor});
  if(!c.finalSent()&&text.trim())await kit.reply(delivery.agent,conversation,text);
 }catch(error){sessions.delete(key);if(!stopped)throw error;}
 finally{delivery.signal.removeEventListener('abort',stop);if(stopped)sessions.delete(key);if(c&&!consumed)c.prompt.restore();await client?.close();await c?.server.close();}
});
