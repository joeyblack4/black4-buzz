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
