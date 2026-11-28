register(async(delivery,conversation,key)=>{
 if(disposed||delivery.signal.aborted||!delivery.current())return;
 let c,client,consumed=false,stopped=false,text='';
 const stop=async()=>{stopped=true;await client?.close();};
 delivery.signal.addEventListener('abort',stop,{once:true});delivery.interruptible?.(stop);
 try{
  c=await context(delivery,conversation,key);
  // No model of its own: the agent runs the one Antigravity picks for this
  // account (plans list different models), so nothing is set or confirmed.
  const model=delivery.model||delivery.config?.model||'',effort=delivery.effort||delivery.config?.effort;
  client=await rpc([],{cwd:c.cwd,allowTools:true,onUpdate:u=>{if(u?.sessionUpdate==='agent_message_chunk'&&u.content?.text){text+=u.content.text;if(text.length>8000000)void stop();}}});
  if(stopped||disposed||delivery.signal.aborted){await stop();return;}
  await client.request('initialize',{protocolVersion:1,clientCapabilities:{}});
  const params={cwd:c.cwd,mcpServers:[{type:'http',name:'buzz',url:c.server.url,headers:c.server.headers}]};
  let session;
  try{session=c.previous?await client.request('session/load',{...params,sessionId:c.previous.id}):await client.request('session/new',params);}
  catch(error){if(/authentication required|not logged in/i.test(String(error.message||error)))throw new Error('Sign in to Google in this agent\u2019s Settings.');throw error;}
  const id=c.previous?.id||session?.sessionId;
  if(!id)throw new Error('Antigravity did not create a session.');
  // Antigravity confirms each choice in its answer; a model or Thinking level
  // it does not confirm stops the turn before anything is sent to a model.
  if(model){const selected=await client.request('session/set_config_option',{sessionId:id,configId:'model',value:model});
   if(!selected.configOptions?.some(o=>o.id==='model'&&o.currentValue===model))throw new Error('Antigravity did not confirm the model '+model+'.');}
  if(effort){const thought=await client.request('session/set_config_option',{sessionId:id,configId:'thought_level',value:effort});
   if(!thought.configOptions?.some(o=>o.id==='thought_level'&&o.currentValue===effort))throw new Error('Antigravity did not confirm the Thinking level '+effort+'.');}
  delivery.acknowledged?.();consumed=true;
  const result=await client.request('session/prompt',{sessionId:id,prompt:[{type:'text',text:c.system+'\n\n'+c.prompt.text}]},570000);
  if(stopped||delivery.signal.aborted||!delivery.current())return;
  if(result.stopReason!=='end_turn')throw new Error('Antigravity stopped: '+result.stopReason);
  sessions.set(key,{id,cursor:c.prompt.cursor});
  if(!c.finalSent()&&text.trim())await kit.reply(delivery.agent,conversation,text);
 }catch(error){sessions.delete(key);if(!stopped)throw error;}
 finally{delivery.signal.removeEventListener('abort',stop);if(stopped)sessions.delete(key);if(c&&!consumed)c.prompt.restore();await client?.close();await c?.server.close();}
});
