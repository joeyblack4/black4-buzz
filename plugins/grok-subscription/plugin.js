export const inject = ["agents", "host", "react"];
export function apply(ctx) {
const spec = {"provider": "grok", "title": "Grok Sub Plugin", "defaultModel": "grok-4.6"};
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
// ---- buzz-ui kit: stamped from kit/buzz-ui.js by `npm run kit`; edit it there ----
// Black 4's Buzz UI kit: Buzz's own design-system primitives (Buzz 1.0.4,
// block/buzz-app `src/shared/design-system/ui`) drawn as plain elements with
// Buzz's classes, data attributes and structure, so Buzz's stylesheet paints
// them and a plugin screen looks like Buzz's own.
//
// The one place a Black 4 plugin draws a control. `npm run kit` stamps this
// file, unchanged, into every plugin that carries the kit markers (Buzz runs
// no build, so each plugin.js holds its own copy); `npm run check` refuses a
// stale copy. What it uses of Buzz is listed in kit/uses.json, which the Buzz
// canary checks every day. Rules: kit/README.md.
//
// It must run at a module's top level and inside a plugin's apply(), so it
// declares one function and nothing else.

/** Each part takes what Buzz's component takes, in Buzz's names.
 * `nativeSelect`: draw dropdowns as the pill over a native <select> (the OS
 * menu opens) instead of Buzz's popup. */
function buzzUi(React, { nativeSelect = false } = {}) {
  // Tabler icons 3.46 (chevron-down, check, loader-2): Buzz's CaretDownIcon, CheckIcon and CircleNotchIcon.
  // Tabler icons 3.46 (Buzz draws the same shapes with its own icon set).
  const ICON = { chevron: "M6 9l6 6l6 -6", check: "M5 12l5 5l10 -10", loader: "M12 3a9 9 0 1 0 9 9",
    back: ["M5 12l14 0", "M5 12l6 6", "M5 12l6 -6"],
    refresh: ["M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4", "M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"],
    decisions: ["M3.5 5.5l1.5 1.5l2.5 -2.5", "M3.5 11.5l1.5 1.5l2.5 -2.5", "M3.5 17.5l1.5 1.5l2.5 -2.5", "M11 6l9 0", "M11 12l9 0", "M11 18l9 0"],
    inbox: ["M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z", "M4 13h3l3 3h4l3 -3h3"],
    dots: ["M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"],
    x: ["M18 6l-12 12", "M6 6l12 12"],
    robot: ["M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4", "M12 2v2", "M9 12v9", "M15 12v9", "M5 16l4 -2", "M15 14l4 2", "M9 18h6", "M10 8v.01", "M14 8v.01"],
    link: ["M9 15l6 -6", "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464", "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"],
    // chevron-up, chevron-down, currency-dollar, users, alert-triangle, minus
    up: "M6 15l6 -6l6 6", down: "M6 9l6 6l6 -6",
    money: ["M16.7 8a3 3 0 0 0 -2.7 -2h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-4a3 3 0 0 1 -2.7 -2", "M12 3v3m0 12v3"],
    people: ["M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2", "M16 3.13a4 4 0 0 1 0 7.75", "M21 21v-2a4 4 0 0 0 -3 -3.85"],
    alert: ["M12 9v4", "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z", "M12 16h.01"],
    minus: "M5 12l14 0",
    // clock (a scheduled job), message (asked in a conversation), sparkles (on its own)
    clock: ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 7v5l3 3"],
    message: ["M8 9h8", "M8 13h6", "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"],
    sparkles: ["M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"] };
  const h = React.createElement;
  const Fragment = React.Fragment;
  /** The variants each part takes, all ones Buzz styles (kit/uses.json
   * lists the same; the canary checks them). Anything else draws the first. */
  const VARIANTS = {
    Group: { layout: ["rows"] },
    Button: { variant: ["subtle", "prominent", "outline", "destructive", "ghost", "link"], size: ["md", "sm", "text"], shape: ["capsule", "control"] },
    Header: { level: [2, 3, 4] },
    Input: { controlSize: ["md", "sm"] },
    Stack: { gap: [4, 2, "section"] },
    Column: { gap: [4, 2] },
    Tabs: { variant: ["panel", "segmented"] },
    Avatar: { size: ["small", "compact", "tiny"] },
  };
  const one = (list, value) => (list.includes(value) ? value : list[0]);
  const icon = (path, size, props = {}) => h("svg", { xmlns: "http://www.w3.org/2000/svg", width: `${size / 16}rem`, height: `${size / 16}rem`,
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props },
    ...(Array.isArray(path) ? path : [path]).map((d) => h("path", { key: d, d })));

  /** Header.tsx `InlineHeader`: a section's title above its card. */
  const SectionTitle = ({ title, subtitle, id }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": "" },
      h("div", { className: "buzz-content-header-copy" },
        h("h3", { id, className: "buzz-content-header-title" }, title),
        subtitle ? h("p", { className: "buzz-content-header-subtitle" }, subtitle) : null));

  /** SettingsGroup.tsx: the rounded card. Every direct child is a row. */
  const Group = ({ layout, children }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": one(VARIANTS.Group.layout, layout) }, children);

  /** PreferenceRow.tsx: title and muted description left, `trailing` right
   * (an element, or a function of the aria props that name the control).
   * `controlId` makes the title a <label>, as SwitchPreferenceRow does. */
  const Row = ({ id, title, description, trailing, controlId, accessibleTitle, disabled = false, icon: leading }) => {
    const base = React.useId();
    const titleId = `${base}-title`;
    const descriptionId = description ? `${base}-description` : undefined;
    const Title = controlId ? "label" : "div";
    return h("div", { id, "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default",
        "data-disabled": disabled || undefined, "data-has-icon": leading ? "" : undefined },
      leading ? h("span", { className: "buzz-preference-row-icon", "aria-hidden": true }, leading) : null,
      h("div", { className: "buzz-preference-row-content" },
        h(Title, { id: titleId, className: "buzz-preference-row-label", htmlFor: controlId, "aria-label": accessibleTitle }, title),
        description ? h("span", { id: descriptionId, className: "buzz-preference-row-description" }, description) : null),
      trailing == null ? null : h("div", { className: "buzz-preference-row-trailing" },
        typeof trailing === "function" ? trailing({ "aria-labelledby": titleId, "aria-describedby": descriptionId }) : trailing));
  };

  /** Button.tsx: variant prominent | subtle | outline | destructive; size sm | md;
   * shape capsule | control. `loading` hides the label under Buzz's spinner.
   * With `href` it is a link that looks the same (Buzz renders links through Button too). */
  const Button = ({ variant, size, shape, type = "button", loading = false, disabled, onClick, href, children, ...props }) => {
    const shared = { ...props, "aria-busy": loading || props["aria-busy"],
      "data-buzz-ui": "", className: "buzz-button", "data-variant": one(VARIANTS.Button.variant, variant),
      "data-size": one(VARIANTS.Button.size, size), "data-button-shape": one(VARIANTS.Button.shape, shape),
      "data-disabled": disabled || loading ? "" : undefined, "data-loading": loading || undefined };
    const body = [
      h("span", { key: "label", className: "buzz-button-label" }, children),
      loading ? icon(ICON.loader, 18, { key: "spinner", className: "buzz-button-spinner" }) : null,
    ];
    if (href) return h("a", { ...shared, href, target: "_blank", rel: "noopener noreferrer", onClick }, ...body);
    return h("button", { ...shared, type, disabled: disabled || loading,
      onClick: (event) => { if (loading || disabled) { event.preventDefault(); return; } onClick?.(event); } }, ...body);
  };

  /** Input.tsx: one line of text. `width` fixes its width (a CSS length). */
  const Input = ({ controlSize, width, ...props }) =>
    h("input", { type: "text", ...props, ...(width ? { style: { width } } : {}), "data-buzz-ui": "", "data-size": one(VARIANTS.Input.controlSize, controlSize), className: "buzz-input" });

  /** Switch.tsx without its own label: the row names it. */
  const Switch = ({ id, checked, disabled, onCheckedChange, ...aria }) =>
    h("button", { type: "button", role: "switch", id, "aria-checked": checked, ...aria, disabled,
        "data-buzz-ui": "", className: "buzz-switch-control",
        "data-checked": checked ? "" : undefined, "data-disabled": disabled ? "" : undefined,
        onClick: () => { if (!disabled) onCheckedChange(!checked); } },
      h("span", { className: "buzz-switch-thumb" }));

  /** SwitchPreferenceRow.tsx. */
  const SwitchRow = ({ id, label, description, checked, disabled, onCheckedChange }) => {
    const generated = React.useId();
    const controlId = id ?? generated;
    return h(Row, { title: label, description, controlId, disabled,
      trailing: (aria) => h(Switch, { ...aria, id: controlId, "aria-label": label, checked, disabled, onCheckedChange }) });
  };

  const chevron = () => h("span", { "aria-hidden": true }, icon(ICON.chevron, 14, { className: "buzz-dropdown-chevron" }));
  const shown = (current, placeholder) => h("span", { className: "buzz-select-value-content" },
    h("span", { className: "buzz-select-value-text" },
      h("span", { className: "buzz-select-value", title: current?.label, "data-placeholder": current ? undefined : "" }, current?.label ?? placeholder)));

  /** Select.tsx variant "compact" (shape "control": variant "preference"):
   * the closed pill is Buzz's outline sm Button inside `.buzz-select`; the open
   * menu is a listbox in Buzz's popup classes, shown through the native
   * popover attribute (the top layer, so no scroller clips it), placed under
   * the pill. Arrow keys move, Enter picks, Escape and a click outside close.
   * Options: { id, label, detail?, unavailable? } (unavailable: shown, not
   * pickable, unless it is the current one). */
  const Popup = ({ label, value, options, onChange, disabled, shape = "capsule", title, placeholder = "Choose", describedBy }) => {
    const id = React.useId();
    const [open, setOpen] = React.useState(false);
    const trigger = React.useRef(null);
    const popup = React.useRef(null);
    const current = options.find((option) => option.id === value);
    React.useLayoutEffect(() => {
      const list = popup.current;
      const at = trigger.current;
      if (!list || !at || typeof document === "undefined") return undefined;
      if (!open) { try { list.hidePopover?.(); } catch {} return undefined; }
      const gap = 4;
      list.setAttribute("data-starting-style", "");
      Object.assign(list.style, { position: "fixed", margin: "0", inset: "auto", top: "0px", left: "0px" });
      try { list.showPopover?.(); } catch {}
      // Under the pill (above it when there is more room there), within the window.
      const place = () => {
        const box = at.getBoundingClientRect();
        list.style.setProperty("--anchor-width", `${box.width}px`);
        list.style.setProperty("--available-width", `${window.innerWidth - 16}px`);
        const below = window.innerHeight - box.bottom - gap - 8;
        const above = box.top - gap - 8;
        const side = list.offsetHeight > below && above > below ? "top" : "bottom";
        list.setAttribute("data-side", side);
        list.style.setProperty("--available-height", `${Math.max(120, side === "top" ? above : below)}px`);
        list.style.setProperty("--transform-origin", side === "top" ? "bottom left" : "top left");
        const left = Math.max(8, Math.min(box.left, window.innerWidth - 8 - list.offsetWidth));
        const top = side === "top" ? Math.max(8, box.top - gap - list.offsetHeight) : box.bottom + gap;
        Object.assign(list.style, { top: `${top}px`, left: `${left}px` });
      };
      place();
      const frame = requestAnimationFrame(() => list.removeAttribute("data-starting-style"));
      (list.querySelector('[role="option"][aria-selected="true"]') ?? list.querySelector('[role="option"]:not([data-disabled])'))?.focus({ preventScroll: true });
      const away = (event) => { if (!list.contains(event.target) && !at.contains(event.target)) setOpen(false); };
      const keys = (event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); at.focus(); } };
      document.addEventListener("pointerdown", away, true);
      document.addEventListener("keydown", keys, true);
      window.addEventListener("resize", place);
      document.addEventListener("scroll", place, true);
      return () => {
        cancelAnimationFrame(frame);
        document.removeEventListener("pointerdown", away, true);
        document.removeEventListener("keydown", keys, true);
        window.removeEventListener("resize", place);
        document.removeEventListener("scroll", place, true);
      };
    }, [open]);
    const pick = (option) => {
      if (!option || (option.unavailable && option.id !== value)) return;
      setOpen(false);
      trigger.current?.focus?.();
      if (option.id !== value) onChange(option.id);
    };
    return h("div", { "data-buzz-ui": "", className: "buzz-select text-body", "data-variant": "compact", "data-appearance": "outlined" },
      h("span", { id: `${id}-label`, className: "sr-only" }, label),
      h(Button, { ref: trigger, variant: "outline", size: "sm", shape, disabled, title,
          role: "combobox", "aria-haspopup": "listbox", "aria-expanded": open, "aria-controls": `${id}-list`, "aria-label": label,
          "aria-describedby": describedBy, "data-popup-open": open ? "" : undefined,
          onClick: () => setOpen((value) => !value),
          onKeyDown: (event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } } },
        shown(current, placeholder), chevron()),
      h("div", { ref: popup, id: `${id}-list`, role: "listbox", popover: "manual", "aria-labelledby": `${id}-label`,
          "data-buzz-ui": "", className: "buzz-select-popup text-body", "data-variant": "compact",
          onKeyDown: (event) => {
            const items = [...event.currentTarget.querySelectorAll('[role="option"]:not([data-disabled])')];
            const index = items.indexOf(document.activeElement);
            if (event.key === "ArrowDown") { event.preventDefault(); items[Math.min(index + 1, items.length - 1)]?.focus(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); items[Math.max(index - 1, 0)]?.focus(); }
            else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
            else if (event.key === "End") { event.preventDefault(); items[items.length - 1]?.focus(); }
            else if ((event.key === "Enter" || event.key === " ") && index >= 0) { event.preventDefault(); pick(options.find((option) => option.id === items[index].dataset.value)); }
            else if (event.key === "Tab") setOpen(false);
          } },
        ...options.map((option) => {
          const selected = option.id === value;
          const unavailable = !!option.unavailable && !selected;
          return h("div", { key: option.id, role: "option", tabIndex: -1, "data-value": option.id,
              "aria-selected": selected, "aria-disabled": unavailable || undefined, "data-disabled": unavailable ? "" : undefined,
              className: "buzz-select-option", "data-selected": selected ? "" : undefined,
              onPointerMove: (event) => { if (!unavailable && document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); },
              onFocus: (event) => event.currentTarget.setAttribute("data-highlighted", ""),
              onBlur: (event) => event.currentTarget.removeAttribute("data-highlighted"),
              onClick: () => pick(option) },
            h("span", { className: "buzz-select-option-main" },
              h("span", { className: "buzz-select-option-content" }, option.label,
                option.detail ? h("span", { className: "buzz-select-option-description text-body-sm text-subtle" }, option.detail) : null)),
            h("span", { className: "buzz-select-indicator", "data-selected": selected ? "" : undefined },
              icon(ICON.check, 14)));
        })));
  };

  /** The same closed pill over a transparent native <select>: the OS menu
   * opens. The pill shows no hover or open state (the select takes the pointer). */
  const Native = ({ label, value, options, onChange, disabled, shape = "capsule", title, placeholder = "Choose", describedBy }) => {
    const current = options.find((option) => option.id === value);
    return h("div", { "data-buzz-ui": "", className: "buzz-select text-body", "data-variant": "compact", "data-appearance": "outlined", style: { position: "relative" } },
      h(Button, { variant: "outline", size: "sm", shape, disabled, title, tabIndex: -1, "aria-hidden": true }, shown(current, placeholder), chevron()),
      h("select", { "aria-label": label, "aria-describedby": describedBy, value, disabled, onChange: (event) => onChange(event.target.value),
          style: { position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: disabled ? "not-allowed" : "pointer", font: "inherit" } },
        ...options.map((option) => h("option", { key: option.id, value: option.id, disabled: !!option.unavailable && option.id !== value }, option.label))));
  };
  const Pill = nativeSelect ? Native : Popup;

  /** Field.tsx around Textarea.tsx (AgentInstructions): label, the text, a
   * muted description or the error. */
  const TextField = ({ label, description, error, optional = false, value, onChange, rows = 8, maxLength, placeholder, disabled, autoFocus, onKeyDown }) => {
    const id = React.useId();
    return h("div", { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { className: "buzz-field-label", htmlFor: id }, label,
        optional ? h(Fragment, null, " ", h("span", { className: "buzz-field-optional" }, "Optional")) : null),
      h("textarea", { id, rows, maxLength, placeholder, value, disabled, autoFocus, onKeyDown,
        "data-buzz-ui": "", className: "buzz-textarea", "data-variant": "text", "data-surface": "inset", "data-appearance": "outlined",
        "data-invalid": error ? "" : undefined, "aria-invalid": error ? "true" : undefined,
        onChange: (event) => onChange(event.target.value) }),
      description && !error ? h("p", { className: "buzz-field-description" }, description) : null,
      error ? h("div", { className: "buzz-field-error-track" }, h("div", { role: "alert", className: "buzz-field-error" }, error)) : null);
  };

  // Layout, in the spacing Buzz's Settings screens use (Tailwind utilities
  // Buzz itself uses, so its stylesheet has them).
  const GAPS = { 2: "grid gap-2", 4: "grid gap-4", section: "grid gap-section-gap" };
  const each = (children) => (Array.isArray(children) ? children : [children]);
  /** A column of sections, cards or fields. `as: "form"` makes it the form
   * (with `onSubmit`); gap 4 between sections, 2 within a field. */
  const Stack = ({ as = "div", gap, onSubmit, children }) =>
    h(as, { className: GAPS[one(VARIANTS.Stack.gap, gap)], onSubmit, style: { gridTemplateColumns: "minmax(0, 1fr)" } }, ...each(children));
  /** Builderlab's sign-in column: lines and a button, left-aligned. */
  const Column = ({ gap, children }) =>
    h("div", { "data-buzz-ui": "", className: one(VARIANTS.Column.gap, gap) === 2 ? "flex flex-col items-start gap-2" : "flex flex-col items-start gap-4" }, ...each(children));
  /** A row of buttons that wraps. */
  const Actions = ({ children }) => h("div", { className: "flex flex-wrap items-center gap-3" }, ...each(children));

  // ---- Cards, pages and panels ------------------------------------------------

  /** Header.tsx (not inline): a settings card's or page's title, with an
   * optional eyebrow, subtitle and actions. In Settings it reads as Buzz's own
   * card titles (GitHub, Claude). */
  const Header = ({ title, subtitle, eyebrow, actions, id, level }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-content-header" },
      h("div", { className: "buzz-content-header-copy" },
        eyebrow ? h("p", { className: "buzz-content-header-eyebrow" }, eyebrow) : null,
        h(`h${one(VARIANTS.Header.level, level)}`, { id, className: "buzz-content-header-title" }, title),
        subtitle ? h("p", { className: "buzz-content-header-subtitle" }, subtitle) : null),
      actions ? h("div", { className: "buzz-content-header-actions" }, ...each(actions)) : null);

  /** IconButton.tsx: a ghost icon button. `glyph` is an ICON name; `large`
   * draws the 18px artwork Buzz uses in a panel header (16px elsewhere).
   * Name it with `label`. */
  const IconButton = ({ label, glyph, large = false, disabled, onClick, ...props }) =>
    h("button", { type: "button", ...props, "aria-label": label, title: props.title ?? label, disabled,
        "data-buzz-ui": "", className: "buzz-button", "data-variant": "ghost", "data-size": "sm", "data-button-shape": "capsule",
        "data-icon-variant": "ghost", "data-icon-size": "sm", "data-icon-shape": "control", "data-disabled": disabled ? "" : undefined,
        onClick: (event) => { if (!disabled) onClick?.(event); } },
      h("span", { className: "buzz-button-label" }, icon(ICON[glyph] ?? ICON.check, large ? 18 : 16)));

  /** PanelHeader.tsx: a page's or drill-in's bar: `navigation` (a back
   * IconButton) first, the title, then `actions`. `glyph`: a dock page's own
   * title, drawn as Buzz's pages draw theirs (PanelHeaderLabel: inset, with
   * its icon), so it doesn't sit in the panel's corner. */
  const PanelHeader = ({ title, navigation, actions, glyph }) =>
    h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
      navigation ?? null,
      h("div", { className: "panel-header-title" }, glyph
        ? h("div", { className: "panel-header-label" },
            ICON[glyph] ? h("span", { className: "panel-header-label-icon", "aria-hidden": true }, icon(ICON[glyph], 16)) : null,
            h("h2", null, title))
        : h("h2", { className: "text-label text-primary" }, title)),
      actions ? h("div", { className: "panel-header-actions" }, ...each(actions)) : null);

  /** A dock page's surface (Panel.tsx, laid out as Shared notes' page):
   * `header` (a PanelHeader) above a scrolling body. `fill`: the body has no
   * inset (an embedded browser fills it). */
  const Page = ({ label, header, fill = false, onFocus, onBlur, children }) =>
    h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": label, onFocus, onBlur },
      h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, containerType: "inline-size" } },
        header ?? null,
        h("div", { style: fill ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }
            : { overflow: "auto", padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-4)", minHeight: 0, flex: 1 } },
          ...each(children))));

  /** A drill-in inside a panel (PanelSubview): its bar stays put while the body scrolls. */
  const Subview = ({ header, footer, children }) =>
    h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, header, ...each(children), footer ?? null);
  /** A panel's whole surface (a Subview's frame), which knows when it has focus. */
  const Surface = ({ label, onFocus, onBlur, children }) =>
    h("div", { "data-buzz-ui": "", role: "region", "aria-label": label, onFocus, onBlur, style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, ...each(children));
  /** A side panel's body: Buzz leaves the inset to the panel (as GitHub's). */
  const PanelBody = ({ fit = false, children }) =>
    h("div", { "data-buzz-ui": "", style: { padding: "var(--space-panel-inset)", overflowY: fit ? "hidden" : "auto", minHeight: 0, flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-4)", color: "var(--text-standard)" } },
      ...each(children));

  /** A child that fills the rest of a `fill` page (an embedded browser). */
  const Fill = ({ children }) => h("div", { style: { flex: 1, minHeight: 0, display: "flex" } }, ...each(children));
  /** A bar above a page's body (Activity's toolbar). */
  const Toolbar = ({ children }) =>
    h("div", { "data-buzz-ui": "", style: { display: "flex", flex: "0 0 auto", minHeight: "var(--size-panel-header)", flexWrap: "wrap", alignItems: "center",
      gap: "var(--space-2)", padding: "var(--space-2) calc(var(--space-1) + var(--space-2))", borderBottom: "1px solid var(--border-standard)" } }, ...each(children));

  /** EmptyState.tsx. `frame` "none" drops the card border. */
  const EmptyState = ({ glyph, title, description, action, frame }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-empty-state", "data-frame": frame === "none" ? "none" : undefined },
      h("div", { className: "buzz-empty-state-content" },
        glyph ? h("span", { className: "buzz-empty-state-icon", "aria-hidden": true }, icon(ICON[glyph], 32)) : null,
        h("div", { className: "buzz-empty-state-copy" },
          h("h3", { className: "buzz-empty-state-title" }, title),
          description ? h("p", { className: "buzz-empty-state-description" }, description) : null),
        action ? h("div", { className: "buzz-empty-state-action" }, action) : null));

  /** NavigationItem.tsx (variant row): a list row that opens something.
   * `multiline` lets the label wrap. */
  const NavItem = ({ label, trailing, selected = false, multiline = false, onClick, ...props }) =>
    h("button", { type: "button", ...props, "data-buzz-ui": "", className: "navigation-item", "data-variant": "row",
        "data-selected": selected ? "" : undefined, "aria-current": selected ? "page" : undefined, "data-multiline": multiline ? "" : undefined, onClick },
      h("span", { className: "navigation-item-label" }, label),
      trailing == null ? null : h("span", { className: "navigation-item-trailing" }, trailing));

  /** Tabs.tsx, variant "panel" size "sm": pick one of a few items. The
   * indicator is measured from the selected tab, as Base UI does. */
  const Tabs = ({ label, value, items, onChange, variant = "panel" }) => {
    const list = React.useRef(null);
    const bar = React.useRef(null);
    React.useLayoutEffect(() => {
      const place = () => {
        const tab = list.current?.querySelector?.('[role="tab"][aria-selected="true"]');
        if (!tab || !bar.current) return;
        bar.current.style.setProperty("--active-tab-left", `${tab.offsetLeft}px`);
        bar.current.style.setProperty("--active-tab-width", `${tab.offsetWidth}px`);
        bar.current.hidden = false;
      };
      place();
      const watch = typeof ResizeObserver === "function" && list.current ? new ResizeObserver(place) : null;
      watch?.observe(list.current);
      return () => watch?.disconnect();
    }, [value, items.length]);
    const keys = (event) => {
      const at = items.findIndex((item) => item.value === value);
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step || at < 0) return;
      event.preventDefault();
      const next = items[(at + step + items.length) % items.length];
      onChange(next.value);
      requestAnimationFrame?.(() => list.current?.querySelector?.('[role="tab"][aria-selected="true"]')?.focus());
    };
    return h("div", { "data-buzz-ui": "", className: "buzz-tabs", "data-variant": one(VARIANTS.Tabs.variant, variant), "data-size": "sm", "data-orientation": "horizontal" },
      h("div", { ref: list, role: "tablist", "aria-label": label, "aria-orientation": "horizontal", className: "buzz-tabs-list", "data-orientation": "horizontal", onKeyDown: keys },
        h("span", { ref: bar, className: "buzz-tabs-indicator", hidden: true }),
        ...items.map((item) => {
          const selected = item.value === value;
          return h("span", { key: item.value, className: "buzz-tabs-item" },
            h("button", { type: "button", role: "tab", className: "buzz-tabs-tab", title: item.label, "aria-selected": selected, tabIndex: selected ? 0 : -1,
                "data-selected": selected ? "" : undefined, "data-orientation": "horizontal", "data-tab-value": item.value, onClick: () => onChange(item.value) },
              h("span", null, item.label)));
        })));
  };

  /** Accordion.tsx, variant "form", one item: a section that opens. */
  const Disclosure = ({ title, children, defaultOpen = false }) => {
    const id = React.useId();
    const [open, setOpen] = React.useState(defaultOpen);
    return h("div", { "data-buzz-ui": "", className: "buzz-accordion", "data-variant": "form" },
      h("div", { className: "buzz-accordion-item" },
        h("h3", { className: "buzz-accordion-heading" },
          h("button", { type: "button", id: `${id}-trigger`, className: "buzz-accordion-trigger text-body", "aria-expanded": open, "aria-controls": `${id}-panel`,
              onClick: () => setOpen(!open) },
            h("span", null, title), icon(ICON.chevron, 14))),
        h("div", { id: `${id}-panel`, role: "region", "aria-labelledby": `${id}-trigger`, className: "buzz-accordion-panel", hidden: !open },
          open ? children : null)));
  };

  /** CountBadge.tsx: a count (99+ above 99); nothing at 0. `label` says it in words. */
  const CountBadge = ({ count, label }) => count > 0
    ? h("span", { "data-buzz-ui": "", className: "buzz-count-badge", role: "img", "aria-label": label }, count > 99 ? "99+" : String(count))
    : null;
  /** The unread dot Buzz's rows use: something waits on you, without a count. */
  const Dot = ({ label }) =>
    h("span", { role: "img", "aria-label": label, title: label, style: { display: "grid", placeItems: "center", width: "var(--space-2)", height: "var(--space-2)" } },
      h("span", { style: { width: "var(--space-2)", height: "var(--space-2)", borderRadius: "var(--radius-pill)", background: "var(--text-navigation-unread)" } }));

  /** InlineChip.tsx, an inert link chip (what a link renderer shows in a message). */
  const LinkChip = ({ label }) =>
    h("span", { "data-buzz-ui": "", className: "inline-chip", "data-kind": "link", "data-state": "resolved", role: "img", "aria-label": `Link ${label}` },
      icon(ICON.link, 16, { className: "inline-chip-icon" }),
      h("span", { className: "inline-chip-label" }, label));

  /** A one-time code to confirm elsewhere, as Pairing shows its code. */
  const OneTimeCode = ({ code, label = "Code" }) =>
    h("fieldset", { className: "m-0 w-full whitespace-nowrap rounded-xl border border-shell-edge bg-surface px-4 py-4" },
      h("legend", { className: "sr-only" }, label),
      h("span", { className: "sr-only" }, String(code).split("").join(" ")),
      h("span", { "aria-hidden": true, className: "font-mono text-title font-semibold tracking-widest" }, code));
  /** Pairing's code column: the code above its buttons. */
  const CodeColumn = ({ children }) => h("div", { className: "flex w-64 max-w-full shrink-0 flex-col gap-3" }, ...each(children));

  /** A failure with its retry (relay-staff's Failure). */
  const Failure = ({ message, retry, retryLabel = "Retry" }) =>
    h("div", { className: "flex flex-wrap items-center gap-2" },
      h("p", { role: "alert", className: "text-body-sm text-danger" }, message),
      retry ? h(Button, { size: "sm", onClick: retry }, retryLabel) : null);
  /** `.notice`: something that needs a person, not broken (a warning). */
  const Notice = ({ title, children }) =>
    h("div", { role: "status", className: "notice" }, title ? h("h3", null, title) : null, ...each(children));

  // ---- Reviews: the work, the decision and the list ------------------------------

  /** ValueChip.tsx: a short read-only value (a stake, a fact). `glyph`: an
   * ICON name for its 12px mark; `emphasis`: the label in the standard weight
   * (the stake), else the chip's own. */
  const Chip = ({ label, glyph, picture, title }) =>
    h("span", { "data-buzz-ui": "", className: "buzz-value-chip" },
      // `picture`: a product's own mark (a data URL) in place of a glyph.
      picture ? h("span", { className: "buzz-value-chip-icon", "aria-hidden": true },
        h("img", { src: picture, alt: "", width: 14, height: 14, style: { display: "block", width: "14px", height: "14px", objectFit: "contain" } }))
        : glyph && ICON[glyph] ? h("span", { className: "buzz-value-chip-icon", "aria-hidden": true }, icon(ICON[glyph], 12)) : null,
      h("span", { className: "buzz-value-chip-text", title: title ?? (typeof label === "string" ? label : undefined) }, label));
  /** Chips in a row that wraps. */
  const ChipRow = ({ children }) => h("div", { className: "flex flex-wrap items-center gap-2", style: { minWidth: 0 } }, ...each(children));

  /** Diffs' card (bundled/diffs, Diffs.module.css `.card`/`.fileHeader`):
   * the frame around a change. */
  const card = { minWidth: 0, overflow: "hidden", border: "1px solid var(--border-standard)", borderRadius: "var(--radius-control)", background: "var(--surface-panel)", color: "var(--text-standard)" };
  const cardHeader = { display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)", background: "var(--surface-inset)" };
  /** Diffs' insert and delete fills (`--diff-code-insert/delete-background-color`):
   * a tint on the words, never red text (red means broken). */
  const RUN = { added: { background: "var(--affordance-success)", borderRadius: "var(--space-half)", textDecoration: "none" },
    removed: { background: "var(--affordance-danger)", borderRadius: "var(--space-half)", textDecoration: "line-through" } };
  /** A word diff as Diffs draws inserted and deleted code: `runs` of
   * { kind: same | added | removed, text }, under its `label`. */
  const DiffText = ({ label, runs }) =>
    h("figure", { style: { ...card, margin: 0 } },
      label ? h("figcaption", { className: "text-caption text-subtle", style: cardHeader }, label) : null,
      h("p", { className: "m-0 text-body", style: { padding: "var(--space-3)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } },
        ...runs.map((run, index) => run.kind === "same" ? h(Fragment, { key: index }, run.text)
          : h(Fragment, { key: index },
              h(run.kind === "added" ? "ins" : "del", { style: { ...RUN[run.kind], color: "inherit" } },
                h("span", { className: "sr-only" }, run.kind === "added" ? "Added: " : "Removed: "), run.text),
              // A removed word and its replacement read as two words.
              run.kind === "removed" && runs[index + 1]?.kind === "added" ? " " : null))));

  /** Settings before and after, in Diffs' card: each row its label, Now and
   * After; a changed row's new value carries the insert tint, an unchanged
   * row reads once, quietly. */
  const ChangeTable = ({ rows, now = "Now", after = "After" }) =>
    h("div", { "data-buzz-ui": "", role: "table", "aria-label": "Changes", style: card },
      ...rows.map((row, index) => h("div", { key: index, role: "row", style: { display: "grid", gap: "var(--space-1)", padding: "var(--space-3)", borderTop: index ? "1px solid var(--border-standard)" : undefined } },
        row.label ? h("span", { role: "rowheader", className: "text-caption text-subtle" }, row.label) : null,
        row.changed
          ? h(Fragment, null,
              h("span", { role: "cell", className: "text-body-sm text-subtle", style: { display: "grid", gridTemplateColumns: "3.5rem minmax(0, 1fr)", gap: "var(--space-2)" } },
                h("span", { className: "text-caption" }, now), h("span", { style: { overflowWrap: "anywhere" } }, row.before || "None")),
              h("span", { role: "cell", className: "text-body text-standard", style: { display: "grid", gridTemplateColumns: "3.5rem minmax(0, 1fr)", gap: "var(--space-2)" } },
                h("span", { className: "text-caption text-subtle" }, after), h("span", { style: { overflowWrap: "anywhere" } }, h("mark", { style: { ...RUN.added, color: "inherit" } }, row.after || "None"))))
          : h("span", { role: "cell", className: "text-body-sm text-subtle", style: { overflowWrap: "anywhere" } }, `Unchanged: ${row.after || row.before || "None"}`))));

  /** Before and after images, side by side in Diffs' card. `before`/`after`:
   * data URLs; `loading`: the image is still coming. */
  const MediaPair = ({ before, after, loading = false, label = "The work" }) => {
    const figure = (src, caption) => h("figure", { key: caption, style: { margin: 0, display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      src ? h("img", { src, alt: `${label}: ${caption}`, style: { display: "block", width: "100%", height: "auto", borderRadius: "var(--radius-control)", background: "var(--surface-inset)" } })
        : h("div", { role: "img", "aria-label": `${caption} loading`, style: { aspectRatio: "4 / 3", borderRadius: "var(--radius-control)", background: "var(--surface-inset)" } }),
      h("figcaption", { className: "text-caption text-subtle" }, caption));
    return h("div", { "data-buzz-ui": "", "aria-busy": loading || undefined, style: { ...card, display: "grid", gridTemplateColumns: before ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: "var(--space-3)", padding: "var(--space-3)" } },
      before ? figure(before, "Now") : null, figure(loading ? null : after, before ? "After" : "The new version"));
  };

  /** The bar fixed under a panel's body (Activity's toolbar border, at the
   * bottom): a `status` line, then the actions. `stacked`: a field above.
   * A long status wraps in full and scrolls past a third of the window, so
   * the actions stay on screen. */
  const DecisionBar = ({ status, stacked = false, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": "Decision", style: { flex: "0 0 auto", display: "flex", flexDirection: stacked ? "column" : "row", flexWrap: "wrap",
        alignItems: stacked ? "stretch" : "center", justifyContent: "space-between", gap: "var(--space-2) var(--space-3)",
        padding: "var(--space-3) var(--space-panel-inset)", borderTop: "1px solid var(--border-standard)", background: "var(--surface-panel)" } },
      status ? h("div", { "aria-live": "polite", style: { minWidth: 0, flex: stacked ? undefined : "1 1 12rem", maxBlockSize: "min(16rem, 34vh)", overflowY: "auto" } }, status) : null,
      ...(children == null ? [] : [stacked ? h("div", { key: "actions", className: "grid gap-2" }, ...each(children))
        : h("div", { key: "actions", className: "flex flex-wrap items-center gap-2" }, ...each(children))]));

  /** A placeholder in the real layout while it loads (Buzz has no skeleton:
   * inset bars in the place of the lines). `layout`: item | list. */
  const Skeleton = ({ layout = "item" }) => {
    const bar = (width, height = "var(--space-3)", key) => h("span", { key, style: { display: "block", width, height, borderRadius: "var(--space-1)", background: "var(--surface-inset)" } });
    const rows = layout === "list"
      ? [0, 1, 2, 3].map((n) => h("span", { key: n, style: { display: "grid", gap: "var(--space-2)", padding: "var(--space-2) var(--space-control-inset)" } }, bar("40%", "var(--space-3)", "a"), bar(n % 2 ? "70%" : "85%", "var(--space-4)", "b")))
      : [bar("30%", "var(--space-3)", "a"), bar("80%", "var(--space-6)", "b"), h("span", { key: "c", className: "flex flex-wrap items-center gap-2" }, bar("6rem", "var(--space-5)", "c1"), bar("4rem", "var(--space-5)", "c2"), bar("5rem", "var(--space-5)", "c3")), bar("100%", "8rem", "d")];
    return h("div", { "data-buzz-ui": "", "aria-busy": true, style: { display: "grid", gap: "var(--space-4)" } }, h("span", { className: "sr-only", role: "status" }, "Loading"), ...rows);
  };

  /** Checkbox.tsx (Base UI Checkbox.Root) without its label: the row names it. */
  const Checkbox = ({ checked, onCheckedChange, label, disabled, size = "md" }) =>
    h("button", { type: "button", role: "checkbox", "aria-checked": !!checked, "aria-label": label, disabled,
        "data-buzz-ui": "", className: "buzz-checkbox", "data-size": size === "sm" ? "sm" : "md",
        "data-checked": checked ? "" : undefined, "data-disabled": disabled ? "" : undefined,
        onClick: (event) => { event.stopPropagation(); if (!disabled) onCheckedChange(!checked); } },
      checked ? h("span", { "aria-hidden": true, style: { display: "flex" } }, icon(ICON.check, size === "sm" ? 12 : 14)) : null);

  /** Activity's row (MessageListRow, NavigationItem multiline) in a
   * NavigationCard, so a Checkbox can sit beside it without nesting controls:
   * `title` (the sender's place), `subtitle` (the preview's), `meta` (the
   * date's). `picked`/`onPick`: an explicit selection; `quiet`: muted. */
  const SelectRow = ({ title, subtitle, meta, avatar, thumbnail, selected = false, picked, onPick, pickLabel, onOpen, quiet = false }) =>
    h("li", { style: { minWidth: 0, listStyle: "none" } },
      h("div", { "data-buzz-ui": "", "data-navigation-card": "", "data-tone": "default", className: "navigation-card" },
        h("div", { className: "navigation-card-row" },
          h("button", { type: "button", "data-variant": "row", "data-multiline": "", "data-buzz-ui": "", className: "navigation-item",
              "data-selected": selected ? "" : undefined, "aria-current": selected ? "true" : undefined, onClick: onOpen },
            // MessageListRow's avatar slot (`.rowAvatar`): who made it.
            avatar ? h("span", { style: { display: "grid", flex: "none", width: "var(--space-8)", height: "var(--space-8)", placeItems: "center", alignSelf: "flex-start", marginBlockStart: "var(--space-row-gap)" } }, avatar) : null,
            h("span", { className: "navigation-item-label" },
              h("span", { style: { display: "flex", flexDirection: "column", gap: "var(--space-1)", minWidth: 0, whiteSpace: "normal", paddingBlock: "var(--space-row-gap)" } },
                h("span", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-1) var(--space-control-inset)" } },
                  h("strong", { className: `text-label-sm ${quiet ? "text-subtle" : "text-standard"}`, style: { minWidth: 0, overflowWrap: "anywhere" } }, title),
                  meta ? h("span", { className: "text-caption text-subtle", style: { flex: "0 0 auto" } }, meta) : null),
                subtitle ? h("span", { className: "text-body-sm text-subtle", style: { maxInlineSize: "64ch", overflow: "hidden", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } }, subtitle) : null,
                thumbnail ? h("img", { src: thumbnail, alt: "", style: { display: "block", width: "100%", maxHeight: "5rem", objectFit: "cover", objectPosition: "top", borderRadius: "var(--radius-control)", border: "1px solid var(--border-standard)" } }) : null))),
          onPick ? h("span", { style: { order: -1, flex: "none", display: "grid", placeItems: "center", paddingBlock: "calc(var(--space-row-gap) + var(--space-half))", paddingInlineStart: "var(--space-control-inset)" } },
            h(Checkbox, { checked: !!picked, onCheckedChange: onPick, label: pickLabel ?? (typeof title === "string" ? `Select ${title}` : "Select") })) : null)));

  /** A titled list of rows (Activity's list): `label` and a quiet `count`. */
  const ListGroup = ({ label, count, children }) =>
    h("section", { "data-buzz-ui": "", style: { display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      label ? h("h3", { className: "text-label-sm text-subtle", style: { margin: 0, padding: "0 var(--space-control-inset)", display: "flex", gap: "var(--space-2)" } },
        h("span", null, label), count ? h("span", { className: "tabular-nums" }, String(count)) : null) : null,
      h("ul", { role: "list", style: { margin: 0, padding: 0, display: "grid", gap: "1px" } }, ...each(children)));

  /** Activity's workspace: the list pane beside the preview (Inbox.module.css
   * `.workspace`, `.listPane`, `.scroll`). Too narrow for both, the preview
   * takes the space while it shows something. */
  const Split = ({ label, list, listHeader, detail, showing = false }) => {
    const box = React.useRef(null);
    const [narrow, setNarrow] = React.useState(false);
    React.useLayoutEffect(() => {
      const node = box.current;
      if (!node || typeof ResizeObserver !== "function") return undefined;
      const watch = new ResizeObserver(() => setNarrow(node.clientWidth < 720));
      watch.observe(node);
      return () => watch.disconnect();
    }, []);
    const pane = { display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 };
    return h("div", { ref: box, "data-buzz-ui": "", style: { display: "flex", flex: 1, minWidth: 0, minHeight: 0 } },
      narrow && showing ? null : h("div", { role: "region", "aria-label": label, style: { ...pane, flex: narrow ? 1 : "0 0 min(26rem, 42%)", borderRight: narrow ? undefined : "1px solid var(--border-standard)" } },
        // `listHeader` (the list's filters) stays put while the list scrolls under it.
        listHeader ? h("div", { style: { flex: "0 0 auto", padding: "var(--space-3) var(--space-row-gap) var(--space-2)", borderBottom: "1px solid var(--border-standard)" } }, listHeader) : null,
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "var(--space-3) var(--space-row-gap) var(--space-panel-inset)" } }, list)),
      narrow && !showing ? null : h("div", { style: { ...pane, flex: 1 } }, detail));
  };

  /** Avatar.tsx at a row's size: a picture, or its name's first letter.
   * `shape` squircle for an agent, circle for a person. */
  const Avatar = ({ name, picture, size = "small", shape = "circle", label }) => {
    const [failed, setFailed] = React.useState(false);
    const letter = (Array.from(String(name ?? "").trim())[0] ?? "?").toUpperCase();
    const dim = one(VARIANTS.Avatar.size, size);
    return h("span", { className: "buzz-avatar-status", "data-size": dim, "data-shape": shape === "squircle" ? "squircle" : "circle" },
      h("span", { "data-buzz-ui": "", className: "buzz-avatar", "data-size": dim, "data-avatar-shape": shape === "squircle" ? "squircle" : "circle", "data-fallback-surface": "subtle",
          role: label ? "img" : undefined, "aria-label": label, "aria-hidden": label ? undefined : true },
        picture && !failed
          ? h("img", { src: picture, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", "data-loaded": "true", onError: () => setFailed(true) })
          : h("span", { "data-avatar-fallback": "", "aria-hidden": true }, letter)));
  };
  /** Who made something and what set it off, as Buzz writes a message's
   * author line: the maker's Avatar and name (and the app they used), then
   * the origin with its mark. `onOrigin` makes the origin open its thread. */
  const Byline = ({ avatar, name, badge, detail, origin, originGlyph, onOrigin }) =>
    h("div", { "data-buzz-ui": "", style: { display: "grid", gap: "var(--space-1)", minWidth: 0 } },
      h("div", { className: "flex flex-wrap items-center gap-2", style: { minWidth: 0 } },
        avatar ?? null,
        h("span", { className: "text-label-sm text-standard", style: { minWidth: 0, overflowWrap: "anywhere" } }, name),
        // Badge.tsx (tone success): a fact Black 4 checked, not one the agent reported.
        badge ? h("span", { "data-buzz-ui": "", className: "buzz-badge", "data-size": "xs", "data-tone": "success" }, badge) : null,
        detail ? h("span", { className: "text-caption text-subtle", style: { minWidth: 0, overflowWrap: "anywhere" } }, detail) : null),
      origin ? (onOrigin
        ? h("span", null, h(Button, { variant: "link", size: "text", onClick: onOrigin }, h(Fragment, null, originGlyph && ICON[originGlyph] ? icon(ICON[originGlyph], 12, { style: { marginInlineEnd: "var(--space-1)", verticalAlign: "-1px" } }) : null, origin)))
        : h("span", { className: "flex items-center gap-1 text-caption text-subtle" }, originGlyph && ICON[originGlyph] ? icon(ICON[originGlyph], 12) : null, origin)) : null);
  /** The work, big: a frame that takes the panel's height (Diffs' card,
   * `.preview`), with its Now / After toggle at the top. The live work area is
   * sized by the article's grid. Buzz places the native browser using its
   * measured bounds, regardless of any DOM overflow clipping. */
  const Canvas = ({ label, toolbar, fit = false, children }) =>
    h("figure", { "aria-label": label, style: { ...card, margin: 0, position: "relative", display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: fit ? 0 : "min(34rem, 64vh)" } },
      toolbar ? h("div", { style: { ...cardHeader, justifyContent: "space-between" } }, ...each(toolbar)) : null,
      h("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", justifyContent: "center", overflow: "auto", background: "var(--surface-inset)" } }, ...each(children)));
  /** Layers in the canvas, each filling it, the last on top (a live page over its capture). */
  const Layers = ({ children }) =>
    h("div", { style: { position: "relative", flex: 1, display: "grid", minHeight: 0 } },
      ...each(children).filter(Boolean).map((child, index) => h("div", { key: index, style: { gridArea: "1 / 1", display: "flex", minHeight: 0, overflow: "hidden" } }, child)));
  /** A picture of the work filling the canvas (an image, or the platform's capture of a page). */
  const CanvasImage = ({ src, alt }) => src
    ? h("img", { src, alt, style: { display: "block", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", margin: "auto" } })
    : h("div", { role: "img", "aria-label": `${alt} loading`, "aria-busy": true, style: { flex: 1, background: "var(--surface-inset)" } });
  /** A quiet line of short values (the stake, the facts), wrapped in full:
   * the mark stays beside its first line. */
  const QuietLine = ({ glyph, children }) =>
    h("p", { className: "m-0 text-caption text-subtle", style: { display: "flex", gap: "var(--space-1)", alignItems: "baseline", minWidth: 0 } },
      glyph && ICON[glyph] ? icon(ICON[glyph], 12, { style: { flex: "none", alignSelf: "flex-start", marginBlockStart: "0.125rem" } }) : null,
      h("span", { style: { minWidth: 0, overflowWrap: "anywhere" } }, children));
  /** What approving permits, in full. */
  const Permits = (text) => h("p", { className: "m-0 text-body-sm text-standard", style: { overflowWrap: "anywhere" } }, text);
  /** The heading and details scroll within their rows when live work fills
   * the panel. The browser itself scrolls within the space between them. */
  const Article = ({ label, heading, details, fit = false, children }) =>
    h("article", { "aria-label": label, style: fit
        ? { display: "grid", gridTemplateRows: "fit-content(25%) minmax(0, 1fr) fit-content(25%)", gap: "var(--space-3)", flex: 1, minHeight: 0 }
        : { display: "flex", flexDirection: "column", gap: "var(--space-3)", flex: "1 0 auto", minHeight: "100%" } },
      fit ? h("div", { style: { overflow: "auto" } }, heading) : heading, ...each(children),
      fit ? h("div", { style: { overflow: "auto" } }, details) : details);
  /** The question, in full, the heading of the item. */
  const Question = (text) => h("h2", { className: "m-0 text-label", style: { overflowWrap: "anywhere" } }, text);

  /** The finished work as a page, in Diffs' card (`.preview`: a bounded,
   * scrolling frame) with an embedded view inside. */
  const Frame = ({ label, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": label, style: { ...card, display: "flex", height: "min(28rem, 60vh)", minHeight: "16rem" } }, ...each(children));
  /** A message's card (Diffs' DiffMessage card): a quiet frame around rows. */
  const MessageCard = ({ label, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": label, style: { ...card, display: "grid" } }, ...each(children));
  /** One row in a message's card: the question, its live state, Open. */
  const MessageRow = ({ title, subtitle, avatar, thumbnail, loading = false, onOpen, openLabel = "Open" }) =>
    h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) var(--space-3)", minWidth: 0 } },
      thumbnail ? h("img", { src: thumbnail, alt: "", style: { width: "4.5rem", height: "3.25rem", objectFit: "cover", objectPosition: "top", flex: "none", borderRadius: "var(--radius-control)", border: "1px solid var(--border-standard)" } })
        : avatar ? h("span", { style: { flex: "none", display: "grid" } }, avatar) : null,
      h("span", { style: { display: "grid", gap: "var(--space-1)", minWidth: 0, flex: 1 } },
        h("span", { className: "text-label-sm text-standard", style: { overflowWrap: "anywhere" } }, title),
        loading ? h("span", { style: { display: "block", width: "40%", height: "var(--space-3)", borderRadius: "var(--space-1)", background: "var(--surface-inset)" } })
          : subtitle ? h("span", { className: "text-caption text-subtle" }, subtitle) : null),
      onOpen ? h(Button, { size: "sm", variant: "outline", onClick: onOpen }, openLabel) : null);

  // Text, in the roles Buzz's pages write.
  const Title = (text, props = {}) => h("h2", { ...props, className: "text-heading" }, text);
  const Heading = (text) => h("h3", { className: "text-label" }, text);
  const Paragraph = (text) => h("p", { className: "m-0 text-body" }, text);
  const Caption = (text) => h("span", { className: "text-caption text-subtle" }, text);
  /** A row's emphasised line (Activity's sender). */
  const Strong = (text) => h("span", { className: "text-label-sm text-standard" }, text);
  /** Lines stacked inside a row's label. */
  const Lines = (...lines) => h("span", { className: "grid gap-1" }, ...lines);
  /** A status or alert line, as Builderlab's sign-in writes it. */
  const Line = (text, { role, id, danger = false } = {}) => h("p", { role, id, className: danger ? "m-0 text-body-sm text-danger" : "m-0 text-body-sm text-secondary" }, text);
  /** Pre-formatted text (the file viewer's). */
  const Pre = (text) => h("pre", { style: { margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)", lineHeight: "var(--text-mono--line-height)",
    whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "18rem", overflow: "auto" } }, text);

  // ---- Agents: Buzz's Agents page (src/bundled/agents), drawn with Buzz's own
  // rules copied under the kit's names (see kit/copy.mjs) ----
  // ---- copied from Buzz by kit/copy.mjs; the canary checks it; never edit it here ----
  const COPIED_FROM = "v1.0.5";
  const COPIED = [
   {
    "file": "src/bundled/agents/AgentCard.module.css",
    "prefix": "card",
    "rules": [
     ".grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));\n  gap: var(--space-2);\n  outline: none;\n  position: relative;\n}",
     ".slot {\n  display: grid;\n  min-width: 0;\n}",
     ".card {\n  position: relative;\n  isolation: isolate;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: var(--space-3);\n  min-width: 0;\n  min-height: 15.25rem;\n  padding: var(--space-8) var(--space-3) var(--space-4);\n  border: 1px solid transparent;\n  border-radius: var(--radius-container);\n  \n  background: var(--interaction-fill);\n  text-align: center;\n  user-select: none;\n}",
     ".agentCard {\n  --profile-backdrop-mask: linear-gradient(to bottom, black, 25%, transparent);\n  --profile-backdrop-filter: blur(40px) saturate(4);\n  --profile-backdrop-scale: 2;\n  --profile-backdrop-opacity: 0.64;\n  \n  --profile-backdrop-duration: 0s;\n  gap: var(--space-6);\n  border: 0;\n  justify-content: flex-end;\n  padding: calc(var(--space-8) * 2 + var(--space-2)) var(--space-6)\n    var(--space-6);\n}",
     ".identity {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: var(--space-2);\n  min-width: 0;\n  max-width: 100%;\n}",
     ".card:is([role=\"option\"], [role=\"gridcell\"]) {\n  cursor: pointer;\n}",
     ".card:is([aria-selected=\"true\"], [data-selected=\"true\"]) {\n  border-color: var(--border-prominent);\n  box-shadow: var(--shadow-sm);\n}",
     ".agentCard:is([aria-selected=\"true\"], [data-selected=\"true\"]) {\n  --profile-backdrop-opacity: 0.76;\n  box-shadow:\n    inset 0 0 0 1px var(--border-prominent),\n    var(--shadow-sm);\n}",
     "@media (forced-colors: active) {\n.agentCard:is([aria-selected=\"true\"], [data-selected=\"true\"]) {\n    outline: 2px solid Highlight;\n    outline-offset: -2px;\n  }\n}",
     "html[data-keyboard-navigation] .card:focus-visible {\n  outline: 2px solid var(--border-focus);\n  outline-offset: 2px;\n}",
     ".portrait {\n  display: grid;\n  place-items: center;\n  flex-shrink: 0;\n  width: clamp(4rem, 16cqw, 8rem);\n  height: clamp(4rem, 16cqw, 8rem);\n}",
     ".portrait > [class~=\"buzz-avatar-status\"] {\n  width: 75%;\n  height: 75%;\n}",
     ".card[data-unavailable] .portrait {\n  opacity: 0.5;\n}",
     ".portrait > :is(img, video) {\n  width: 100%;\n  height: 100%;\n  object-fit: contain;\n}",
     ".name {\n  \n  margin-block: calc(-1 * var(--space-2)) var(--space-2);\n  max-width: 100%;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}",
     ".identity .name {\n  margin-block: 0;\n}",
     ".agentCard .portrait:has(> [class~=\"buzz-avatar-status\"]) {\n  width: clamp(3rem, 12cqw, 6rem);\n  height: clamp(3rem, 12cqw, 6rem);\n}",
     ".agentCard .portrait > [class~=\"buzz-avatar-status\"] {\n  width: 100%;\n  height: 100%;\n}",
     ".detail {\n  display: flex;\n  align-items: center;\n  gap: var(--space-1);\n  max-width: 100%;\n  color: var(--text-secondary);\n  font-size: var(--text-body-sm-size, 0.8125rem);\n}",
     ".agentCard .detail {\n  min-height: var(--space-6);\n}",
     ".detailText {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}",
     ".actions {\n  --interaction-fill: var(--interaction-selected);\n  --interaction-hover: var(--interaction-pressed);\n  max-width: 100%;\n  display: flex;\n  flex-wrap: wrap;\n  justify-content: center;\n  gap: var(--space-2);\n}",
     "@media (max-width: 560px) {\n.grid {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }\n}",
     "@media (max-width: 360px) {\n.grid {\n    grid-template-columns: minmax(0, 1fr);\n  }\n}",
     ".menu {\n  position: absolute;\n  top: var(--space-2);\n  right: var(--space-2);\n}",
     ".bestie {\n  position: absolute;\n  top: var(--space-2);\n  left: var(--space-2);\n  pointer-events: none;\n}"
    ]
   },
   {
    "file": "src/bundled/agents/AgentsPage.module.css",
    "prefix": "page",
    "rules": [
     ".browse {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr);\n  height: 100%;\n  min-height: 0;\n}",
     ".browse[data-side] {\n  grid-template-columns: minmax(0, 1fr) minmax(\n      20rem,\n      var(--secondary-panel-width, 28rem)\n    );\n}",
     ".main {\n  container-type: inline-size;\n  min-width: 0;\n  min-height: 0;\n}",
     ".inventory {\n  height: 100%;\n  min-height: 0;\n  overflow: auto;\n}",
     ".side {\n  position: relative;\n  border-inline-start: 1px solid var(--border-standard);\n  min-height: 0;\n  min-width: 0;\n}",
     ".build {\n  position: relative;\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  min-height: 0;\n  min-width: 0;\n}",
     ".detailsScroll {\n  --profile-content-inset: var(--space-5);\n  --agent-footer-height: 0px;\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-4);\n  padding: var(--space-5) var(--profile-content-inset);\n  padding-block-end: calc(var(--space-5) + var(--agent-footer-height));\n  scroll-padding-block-end: calc(var(--space-5) + var(--agent-footer-height));\n}",
     "@media (max-width: 30rem) {\n.detailsScroll {\n    --profile-content-inset: var(--space-2);\n  }\n}",
     ".identityPortrait {\n  position: relative;\n  width: min(8rem, 100%);\n  aspect-ratio: 1;\n}",
     ".identityCard > :is([aria-hidden=\"true\"], .identityPortrait) {\n  filter: grayscale(var(--agent-artwork-grayscale, 0));\n}",
     ".identityCard > .identityPortrait {\n  filter: grayscale(var(--agent-artwork-grayscale, 0))\n    blur(var(--agent-artwork-blur, 0px));\n  \n  scale: var(--agent-artwork-scale, 1);\n  opacity: var(--agent-artwork-opacity, 1);\n}",
     ".work {\n  min-width: 0;\n}",
     "@media (max-width: 52rem) {\n.browse[data-side] {\n    grid-template-columns: minmax(0, 1fr);\n  }\n.side {\n    border-inline-start: 0;\n  }\n}",
     "@media (prefers-reduced-motion: reduce) {\n.side {\n    animation: none;\n  }\n}",
     ".content {\n  display: flex;\n  flex-direction: column;\n  gap: var(--space-6);\n  width: 100%;\n  max-width: 48rem;\n  margin-inline: auto;\n  padding: clamp(var(--space-4), 6vh, calc(var(--space-16) + var(--space-4)))\n    var(--space-6) var(--space-8);\n}",
     ".nameActions {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n  gap: var(--space-2);\n  width: 12rem;\n  max-width: 100%;\n}",
     ".identityName {\n  position: relative;\n  width: 100%;\n}",
     ".nameEditor {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  text-align: center;\n}"
    ]
   },
   {
    "file": "src/features/profiles/ProfileHero.module.css",
    "prefix": "hero",
    "rules": [
     ".hero {\n  --profile-backdrop-mask: linear-gradient(to bottom, black, 25%, transparent);\n  position: relative;\n  isolation: isolate;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: var(--space-4);\n  min-width: 0;\n  padding: calc(var(--space-8) + var(--space-4)) var(--space-4);\n  border-radius: var(--radius-container);\n  background: var(--surface-panel);\n}",
     ".actions {\n  --interaction-fill: var(--interaction-selected);\n  --interaction-hover: var(--interaction-pressed);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-wrap: wrap;\n  gap: var(--space-2);\n}",
     ".avatarBackdrop {\n  position: absolute;\n  inset: 0;\n  z-index: -1;\n  overflow: hidden;\n  border-radius: inherit;\n  pointer-events: none;\n  mask-image: var(--profile-backdrop-mask, none);\n}",
     ".avatarBackdropImage {\n  width: 100%;\n  height: 100%;\n  background-size: cover;\n  background-position: center;\n  filter: var(\n    --profile-backdrop-filter,\n    blur(var(--profile-backdrop-blur, 40px))\n      saturate(var(--profile-backdrop-saturation, 4))\n  );\n  transform: scale(var(--profile-backdrop-scale, 2));\n  opacity: var(--profile-backdrop-opacity, 0.64);\n  transition:\n    opacity var(--profile-backdrop-duration, 0s) var(--easing-state),\n    transform var(--profile-backdrop-duration, 0s) var(--easing-enter);\n}",
     "@media (prefers-reduced-transparency: reduce), (forced-colors: active) {\n.avatarBackdrop {\n    display: none;\n  }\n}",
     ".panelHero {\n  margin-inline: calc(\n    var(--space-1) -\n    var(--profile-content-inset, var(--space-5))\n  );\n}",
     ".panelHero:first-child {\n  margin-top: calc(var(--space-1) - var(--space-5));\n}",
     ".hero :is(h2, h3) {\n  text-wrap: balance;\n}"
    ]
   },
   {
    "file": "src/features/panels/Panels.module.css",
    "prefix": "panels",
    "rules": [
     ".workspace {\n  background: var(--surface-panel);\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n  height: 100%;\n}",
     ".workspace > header {\n  flex-wrap: nowrap;\n  flex-shrink: 0;\n}",
     ".workspaceBody {\n  display: grid;\n  flex: 1;\n  min-height: 0;\n  min-width: 0;\n}",
     ".workspacePane {\n  display: grid;\n  grid-area: 1 / 1;\n  min-height: 0;\n  min-width: 0;\n}",
     ".workspaceBody {\n  --workspace-push-duration: 300ms;\n  --workspace-push-easing: cubic-bezier(0.2, 0, 0, 1);\n}"
    ]
   }
  ];
  const AVATARS = [{"id":"buzzies-1","label":"Buzzies 1","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-1.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-1.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-1.mp4"},
    {"id":"buzzies-2","label":"Buzzies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-2.mp4"},
    {"id":"buzzies-3","label":"Buzzies 3","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-3.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-3.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-3.mp4"},
    {"id":"buzzies-4","label":"Buzzies 4","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-4.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-4.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-4.mp4"},
    {"id":"buzzies-5","label":"Buzzies 5","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-5.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-5.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-5.mp4"},
    {"id":"buzzies-6","label":"Buzzies 6","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-6.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-6.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-6.mp4"},
    {"id":"buzzies-7","label":"Buzzies 7","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-7.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-7.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-7.mp4"},
    {"id":"buzzies-8","label":"Buzzies 8","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-8.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-8.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-8.mp4"},
    {"id":"buzzies-9","label":"Buzzies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-9.mp4"},
    {"id":"buzzies-10","label":"Buzzies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-10.mp4"},
    {"id":"buzzies-11","label":"Buzzies 11","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-11.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-11.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-11.mp4"},
    {"id":"buzzies-12","label":"Buzzies 12","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-12.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-12.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-12.mp4"},
    {"id":"buzzies-13","label":"Buzzies 13","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-13.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-13.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-13.mp4"},
    {"id":"buzzies-14","label":"Buzzies 14","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-14.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-14.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-14.mp4"},
    {"id":"buzzies-15","label":"Buzzies 15","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-15.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-15.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-15.mp4"},
    {"id":"buzzies-16","label":"Buzzies 16","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-16.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-16.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-16.mp4"},
    {"id":"buzzies-17","label":"Buzzies 17","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-17.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-17.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-17.mp4"},
    {"id":"buzzies-18","label":"Buzzies 18","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-18.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-18.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-18.mp4"},
    {"id":"buzzies-19","label":"Buzzies 19","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-19.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-19.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-19.mp4"},
    {"id":"buzzies-20","label":"Buzzies 20","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-20.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-20.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-20.mp4"},
    {"id":"buzzies-21","label":"Buzzies 21","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-21.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-21.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-21.mp4"},
    {"id":"buzzies-22","label":"Buzzies 22","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-22.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-22.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-22.mp4"},
    {"id":"buzzies-23","label":"Buzzies 23","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-23.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-23.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-23.mp4"},
    {"id":"buzzies-24","label":"Buzzies 24","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-24.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-24.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-24.mp4"},
    {"id":"buzzies-25","label":"Buzzies 25","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-25.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-25.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-25.mp4"},
    {"id":"buzzies-26","label":"Buzzies 26","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-26.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-26.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-26.mp4"},
    {"id":"buzzies-27","label":"Buzzies 27","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-27.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-27.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-27.mp4"},
    {"id":"buzzies-28","label":"Buzzies 28","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-28.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-28.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-28.mp4"},
    {"id":"buzzies-32","label":"Buzzies 32","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-32.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-32.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-32.mp4"},
    {"id":"buzzies-33","label":"Buzzies 33","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/poster/buzzies/buzzies-33.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/webm/buzzies/buzzies-33.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20261030T174937230Z/hevc/buzzies/buzzies-33.mp4"},
    {"id":"fuzzies-1","label":"Fuzzies 1","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-1.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-1.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-1.mp4"},
    {"id":"fuzzies-2","label":"Fuzzies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-2.mp4"},
    {"id":"fuzzies-3","label":"Fuzzies 3","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-3.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-3.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-3.mp4"},
    {"id":"fuzzies-4","label":"Fuzzies 4","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-4.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-4.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-4.mp4"},
    {"id":"fuzzies-5","label":"Fuzzies 5","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-5.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-5.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-5.mp4"},
    {"id":"fuzzies-6","label":"Fuzzies 6","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-6.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-6.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-6.mp4"},
    {"id":"fuzzies-7","label":"Fuzzies 7","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-7.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-7.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-7.mp4"},
    {"id":"fuzzies-8","label":"Fuzzies 8","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-8.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-8.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-8.mp4"},
    {"id":"fuzzies-9","label":"Fuzzies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-9.mp4"},
    {"id":"fuzzies-10","label":"Fuzzies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-10.mp4"},
    {"id":"fuzzies-11","label":"Fuzzies 11","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-11.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-11.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-11.mp4"},
    {"id":"fuzzies-12","label":"Fuzzies 12","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-12.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-12.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-12.mp4"},
    {"id":"fuzzies-13","label":"Fuzzies 13","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-13.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-13.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-13.mp4"},
    {"id":"fuzzies-14","label":"Fuzzies 14","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-14.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-14.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-14.mp4"},
    {"id":"fuzzies-15","label":"Fuzzies 15","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-15.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-15.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-15.mp4"},
    {"id":"fuzzies-16","label":"Fuzzies 16","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-16.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-16.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-16.mp4"},
    {"id":"fuzzies-17","label":"Fuzzies 17","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-17.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-17.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-17.mp4"},
    {"id":"fuzzies-18","label":"Fuzzies 18","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-18.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-18.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-18.mp4"},
    {"id":"fuzzies-19","label":"Fuzzies 19","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/fuzzies/fuzzies-19.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/fuzzies/fuzzies-19.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/fuzzies/fuzzies-19.mp4"},
    {"id":"gloopies-1","label":"Gloopies 1","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-1.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-1.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-1.mp4"},
    {"id":"gloopies-2","label":"Gloopies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-2.mp4"},
    {"id":"gloopies-3","label":"Gloopies 3","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-3.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-3.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-3.mp4"},
    {"id":"gloopies-4","label":"Gloopies 4","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-4.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-4.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-4.mp4"},
    {"id":"gloopies-5","label":"Gloopies 5","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-5.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-5.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-5.mp4"},
    {"id":"gloopies-6","label":"Gloopies 6","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-6.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-6.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-6.mp4"},
    {"id":"gloopies-7","label":"Gloopies 7","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-7.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-7.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-7.mp4"},
    {"id":"gloopies-8","label":"Gloopies 8","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-8.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-8.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-8.mp4"},
    {"id":"gloopies-9","label":"Gloopies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-9.mp4"},
    {"id":"gloopies-10","label":"Gloopies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-10.mp4"},
    {"id":"gloopies-11","label":"Gloopies 11","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-11.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-11.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-11.mp4"},
    {"id":"gloopies-12","label":"Gloopies 12","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-12.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-12.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-12.mp4"},
    {"id":"gloopies-13","label":"Gloopies 13","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-13.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-13.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-13.mp4"},
    {"id":"gloopies-14","label":"Gloopies 14","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-14.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-14.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-14.mp4"},
    {"id":"gloopies-15","label":"Gloopies 15","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-15.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-15.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-15.mp4"},
    {"id":"gloopies-16","label":"Gloopies 16","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-16.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-16.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-16.mp4"},
    {"id":"gloopies-17","label":"Gloopies 17","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-17.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-17.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-17.mp4"},
    {"id":"gloopies-18","label":"Gloopies 18","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-18.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-18.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-18.mp4"},
    {"id":"gloopies-19","label":"Gloopies 19","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-19.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-19.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-19.mp4"},
    {"id":"gloopies-20","label":"Gloopies 20","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-20.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-20.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-20.mp4"},
    {"id":"gloopies-21","label":"Gloopies 21","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-21.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-21.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-21.mp4"},
    {"id":"gloopies-22","label":"Gloopies 22","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-22.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-22.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-22.mp4"},
    {"id":"gloopies-23","label":"Gloopies 23","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/gloopies/gloopies-23.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/gloopies/gloopies-23.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/gloopies/gloopies-23.mp4"},
    {"id":"pollies-2","label":"Figgies 2","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-2.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-2.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-2.mp4"},
    {"id":"pollies-9","label":"Figgies 9","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-9.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-9.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-9.mp4"},
    {"id":"pollies-10","label":"Figgies 10","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-10.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-10.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-10.mp4"},
    {"id":"pollies-21","label":"Figgies 21","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-21.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-21.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-21.mp4"},
    {"id":"pollies-23","label":"Figgies 23","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-23.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-23.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-23.mp4"},
    {"id":"pollies-24","label":"Figgies 24","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-24.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-24.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-24.mp4"},
    {"id":"pollies-25","label":"Figgies 25","url":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/poster/pollies/pollies-25.png","webm":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/webm/pollies/pollies-25.webm","hevc":"https://dwwgwmfqqjotj.cloudfront.net/avatars/20260925T154625166Z/hevc/pollies/pollies-25.mp4"}];
  // ---- end copied from Buzz ----
  /** The kit's name for a copied Buzz class: `copied("card", "agentCard")`. */
  const copied = (prefix, ...names) => names.map((name) => `b4copy-${prefix}-${name}`).join(" ");
  const renameSelectors = (prefix, selectors) => selectors.replace(/\.([a-zA-Z][\w-]*)/g, (match, name) => (name.startsWith("buzz") ? match : `.${copied(prefix, name)}`));
  const renameRule = (prefix, rule) => (rule.startsWith("@")
    ? rule.replace(/^([^{]*\{)([\s\S]*)\}$/, (match, head, body) => head + body.replace(/(^|\})([^{}]+)\{/g, (inner, end, selectors) => end + renameSelectors(prefix, selectors) + "{") + "}")
    : rule.replace(/^[^{]+/, (selectors) => renameSelectors(prefix, selectors)));
  const COPIED_CSS = COPIED.map((file) => file.rules.map((rule) => renameRule(file.prefix, rule)).join("\n")).join("\n");
  /** The copied rules, once per page that draws agent parts. */
  const CopiedStyles = () => h("style", null, COPIED_CSS);

  const appleWebKit = () => typeof navigator !== "undefined" && /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform ?? "")
    && /AppleWebKit/.test(navigator.userAgent ?? "") && !/Chrome|Chromium|Edg/.test(navigator.userAgent ?? "");
  const stillMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Buzz's avatar pack for a picture (its poster URL), if it is one. */
  const packOf = (picture) => AVATARS.find((avatar) => avatar.url === String(picture ?? "").split("#", 1)[0]);

  /** Avatar.tsx, size "fill", squircle: a picture, or its name's first letter. */
  const AvatarImage = ({ name, picture }) => {
    const [failed, setFailed] = React.useState(false);
    const letter = (Array.from(String(name ?? "").trim())[0] ?? "?").toUpperCase();
    return h("span", { className: "buzz-avatar-status", "data-size": "fill", "data-shape": "squircle" },
      h("span", { "data-buzz-ui": "", className: "buzz-avatar", "data-size": "fill", "data-avatar-shape": "squircle", "data-fallback-surface": "subtle", "aria-hidden": true },
        picture && !failed
          ? h("img", { src: picture, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", "data-loaded": "true", onError: () => setFailed(true) })
          : h("span", { "data-avatar-fallback": "", "aria-hidden": true }, letter)));
  };
  /** AgentPortrait: a pack avatar plays its animation (PackedAgentAvatar),
   * any other picture shows still. `cover` fills a backdrop. */
  const AgentPortrait = ({ name, picture, cover = false }) => {
    const pack = packOf(picture);
    if (!pack) return h(AvatarImage, { name, picture });
    const fit = { width: "100%", height: "100%", objectFit: cover ? "cover" : "contain" };
    if (!pack.webm || stillMotion()) return h("img", { src: pack.url, alt: cover ? "" : pack.label, style: fit });
    const sources = [h("source", { key: "webm", type: "video/webm", src: pack.webm })];
    if (pack.hevc) sources[appleWebKit() ? "unshift" : "push"](h("source", { key: "hevc", type: 'video/mp4; codecs="hvc1"', src: pack.hevc }));
    return h("video", { className: "agent-packed-video", loop: true, playsInline: true, autoPlay: true, preload: "auto", poster: pack.url,
      "aria-label": cover ? undefined : pack.label, style: fit,
      ref: (video) => { if (video) { video.muted = true; video.play?.()?.catch?.(() => {}); } } }, ...sources);
  };
  /** ProfileBackdrop: the picture, blurred, behind a card or the profile. */
  const Backdrop = ({ name, picture }) => {
    if (!picture) return null;
    const pack = packOf(picture);
    return h("div", { className: copied("hero", "avatarBackdrop"), "aria-hidden": true },
      pack && pack.webm && !stillMotion()
        ? h("div", { className: copied("hero", "avatarBackdropImage") }, h(AgentPortrait, { name, picture, cover: true }))
        : h("div", { className: copied("hero", "avatarBackdropImage"), style: { backgroundImage: `url("${pack ? pack.url : picture}")` } }));
  };

  /** A navigation tab in a panel header (Tabs variant "navigation"): the
   * page's own title (`main`), or a closable tab for what is open beside it. */
  const HeaderTab = ({ label, art, main = false, onClose }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-tabs", "data-variant": "navigation", "data-size": "md", "data-orientation": "horizontal" },
      h("div", { role: "tablist", "aria-label": main ? `${label} header` : "Panel tabs", className: "buzz-tabs-list", "data-orientation": "horizontal" },
        h("span", { className: "buzz-tabs-item", "data-closable": onClose ? "" : undefined },
          h("button", { type: "button", role: "tab", "aria-selected": true, "data-selected": main ? undefined : "", title: label,
              "data-buzz-ui": "", className: "navigation-item", "data-variant": "row" },
            art ? h("span", { className: "buzz-tabs-icon", "aria-hidden": true }, art) : null,
            h("span", { className: "navigation-item-label" }, label)),
          onClose ? h("button", { type: "button", "aria-label": `Close ${label} tab`, title: `Close ${label} tab`, onClick: onClose,
              "data-buzz-ui": "", className: "buzz-button", "data-variant": "ghost", "data-size": "sm", "data-button-shape": "capsule",
              "data-icon-variant": "ghost", "data-icon-size": "xs", "data-icon-shape": "control" },
            h("span", { className: "buzz-button-label" }, icon(ICON.x, 16))) : null)));

  /** The Agents page (AgentsPage.tsx): the page's header tab, a centred
   * column with `tabs` (and `action` beside them) over the content, and
   * `side` (an AgentPanel) beside it when something is open. */
  const AgentBrowse = ({ label, art, tabs, action, side, children }) =>
    h("div", { className: "h-full min-h-0" },
      h(CopiedStyles),
      h("div", { className: copied("page", "browse"), "data-side": side ? "" : undefined },
        h("div", { className: copied("page", "main") },
          h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": label },
            h("div", { className: "flex h-full min-h-0 flex-col" },
              h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
                h("div", { className: "panel-header-title" }, h(HeaderTab, { label, art, main: true }))),
              h("div", { className: "min-h-0 flex-1" },
                h("div", { className: copied("page", "inventory") },
                  h("div", { className: copied("page", "content") },
                    tabs || action ? h("div", { className: "flex flex-wrap items-center justify-between gap-3" }, tabs ?? null, action ?? null) : null,
                    ...each(children))))))),
        side ?? null));

  /** The card grid (role grid). */
  const AgentGrid = ({ label, busy = false, children }) =>
    h("div", { className: copied("card", "grid") },
      h("div", { role: "grid", "aria-label": label, "aria-busy": busy || undefined, className: "contents" }, ...each(children)));

  /** AgentCard.tsx: the portrait large, the name, one line about it
   * (`detail`, after `art`); `badge` top left (where Buzz marks a Bestie),
   * `menu` top right. */
  const AgentCard = ({ name, picture, detail, art, badge, menu, selected = false, unavailable = false, onSelect, onOpen }) =>
    h("div", { role: "row", className: copied("card", "slot") },
      h("div", { role: "gridcell", "aria-label": name, "aria-selected": selected, "data-selected": String(selected), tabIndex: 0,
          "data-unavailable": unavailable ? "" : undefined, className: copied("card", "card", "agentCard"),
          onClick: (event) => { if (!event.target.closest?.("[data-card-control], button, input")) onSelect?.(); },
          onDoubleClick: () => onOpen?.(),
          onKeyDown: (event) => { if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); (onOpen ?? onSelect)?.(); } } },
        h(Backdrop, { name, picture }),
        badge ? h("span", { className: copied("card", "bestie") }, badge) : null,
        menu ? h("div", { className: copied("card", "menu") }, menu) : null,
        h("span", { className: copied("card", "portrait"), "aria-hidden": true }, h(AgentPortrait, { name, picture })),
        h("span", { className: copied("card", "identity") },
          h("span", { className: `${copied("card", "name")} text-label` }, name),
          detail ? h("span", { className: copied("card", "detail") }, art ?? null, h("span", { className: copied("card", "detailText") }, detail)) : null)));

  /** A picture (a logo) at a glyph's size, for a tab icon or a card's mark. */
  const Picture = ({ src, size = 16 }) => h("img", { src, alt: "", width: size, height: size, style: { display: "block" } });
  /** One of the kit's ICONs at Buzz's glyph size. */
  const Glyph = ({ name, size = 16 }) => icon(ICON[name] ?? ICON.check, size);

  /** A mark on a card, drawn as Buzz draws its Bestie mark (a glass-clear
   * button shape): `art` (16px) and a word, in `color`. */
  const CardMark = ({ art, label, color }) =>
    h("span", { "data-buzz-ui": "", className: "buzz-button", "data-variant": "glass-clear", "data-size": "sm", "data-button-shape": "capsule", "aria-hidden": true },
      h("span", { className: "buzz-button-label", style: color ? { color } : undefined }, art ?? null, label));

  /** The open agent beside the grid: a Panel whose header is one closable
   * tab with the agent's portrait (PanelWorkspace). */
  const AgentPanel = ({ name, picture, onClose, children }) =>
    h("aside", { className: copied("page", "side"), onKeyDown: (event) => { if (event.key === "Escape" && !event.defaultPrevented) onClose?.(); } },
      h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": "Agent profile" },
        h("div", { className: copied("panels", "workspace") },
          h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
            h("div", { className: "panel-header-title" },
              h(HeaderTab, { label: name, onClose, art: h("span", { className: "block h-full w-full" }, h(AgentPortrait, { name, picture })) }))),
          h("div", { className: copied("panels", "workspaceBody") },
            h("div", { role: "tabpanel", className: copied("panels", "workspacePane") }, ...each(children))))));

  /** AgentDetails.tsx: the hero (backdrop, portrait, name, `under` it,
   * `actions`), then the agent's sections. `editing` replaces the name with
   * its editor. */
  const AgentProfile = ({ name, picture, under, actions, editing, children }) =>
    h("div", { className: copied("page", "build") },
      h("div", { className: copied("page", "detailsScroll") },
        h("aside", { "aria-label": `${name} identity`, className: `${copied("hero", "hero", "panelHero")} ${copied("page", "identityCard")}` },
          h(Backdrop, { name, picture }),
          h("div", { className: copied("page", "identityPortrait") }, h(AgentPortrait, { name, picture })),
          h("div", { className: copied("page", "identityName") },
            h("h2", { className: "m-0 text-body-lg text-center break-words", style: editing ? { visibility: "hidden" } : undefined }, name),
            editing ? h("div", { className: copied("page", "nameEditor") }, editing) : null),
          under ?? null,
          actions ? h("div", { className: copied("hero", "actions") }, ...each(actions)) : null),
        h("section", { "aria-label": `${name} settings`, className: copied("page", "work") }, ...each(children))));
  /** The name's editor in the hero (Input appearance "heading"). */
  const NameInput = ({ value, onChange, onSubmit, onCancel, label = "Agent name", placeholder = "Name your agent", invalid }) =>
    h("input", { "data-buzz-ui": "", className: "buzz-input", "data-appearance": "heading", "aria-label": label, placeholder, value, autoFocus: true,
      "aria-invalid": invalid || undefined, onChange: (event) => onChange(event.target.value),
      onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); onSubmit?.(); } else if (event.key === "Escape") { event.preventDefault(); onCancel?.(); } } });
  /** Cancel and Save under the name while it is edited. */
  const NameActions = ({ children }) => h("div", { className: copied("page", "nameActions") }, ...each(children));

  /** Menu.tsx: a "…" button (IconButton, `variant` glass-ghost on a card,
   * glass or subtle in a hero) that opens Buzz's menu of `items`
   * ({ label, onSelect, tone: "danger" }). */
  const Menu = ({ label, items, variant = "glass-ghost" }) => {
    const [open, setOpen] = React.useState(false);
    const trigger = React.useRef(null);
    const popup = React.useRef(null);
    const kind = one(["glass-ghost", "glass", "subtle", "ghost"], variant);
    React.useLayoutEffect(() => {
      const list = popup.current, at = trigger.current;
      if (!list || !at || typeof document === "undefined") return undefined;
      if (!open) { try { list.hidePopover?.(); } catch {} return undefined; }
      Object.assign(list.style, { position: "fixed", margin: "0", inset: "auto", top: "0px", left: "0px" });
      try { list.showPopover?.(); } catch {}
      const box = at.getBoundingClientRect();
      list.style.setProperty("--available-width", `${window.innerWidth - 16}px`);
      list.style.setProperty("--available-height", `${Math.max(120, window.innerHeight - box.bottom - 12)}px`);
      Object.assign(list.style, { top: `${box.bottom + 4}px`, left: `${Math.max(8, box.right - list.offsetWidth)}px` });
      list.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
      const away = (event) => { if (!list.contains(event.target) && !at.contains(event.target)) setOpen(false); };
      const keys = (event) => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setOpen(false); at.focus(); } };
      document.addEventListener("pointerdown", away, true);
      document.addEventListener("keydown", keys, true);
      return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", keys, true); };
    }, [open]);
    return h(Fragment, null,
      h("button", { ref: trigger, type: "button", "aria-label": label, title: label, "aria-haspopup": "menu", "aria-expanded": open,
          "data-buzz-ui": "", className: "buzz-button", "data-variant": kind, "data-size": "sm", "data-button-shape": "capsule",
          "data-icon-variant": kind, "data-icon-size": "sm", "data-icon-shape": "control", "data-popup-open": open ? "" : undefined,
          onClick: () => setOpen((value) => !value) },
        h("span", { className: "buzz-button-label" }, icon(ICON.dots, 16))),
      h("div", { ref: popup, popover: "manual", role: "menu", "aria-label": label, "data-buzz-ui": "", className: "buzz-menu-popup text-body-sm",
          onKeyDown: (event) => {
            const rows = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
            const at = rows.indexOf(document.activeElement);
            if (event.key === "ArrowDown") { event.preventDefault(); rows[Math.min(at + 1, rows.length - 1)]?.focus(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); rows[Math.max(at - 1, 0)]?.focus(); }
            else if (event.key === "Tab") setOpen(false);
          } },
        ...items.map((item) => h("div", { key: item.label, role: "menuitem", tabIndex: -1, className: "buzz-menu-item", "data-tone": item.tone === "danger" ? "danger" : "default",
          onPointerMove: (event) => { if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); },
          onFocus: (event) => event.currentTarget.setAttribute("data-highlighted", ""),
          onBlur: (event) => event.currentTarget.removeAttribute("data-highlighted"),
          onClick: () => { setOpen(false); trigger.current?.focus?.(); item.onSelect?.(); },
          onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(false); trigger.current?.focus?.(); item.onSelect?.(); } } },
          item.label))));
  };

  /** Buzz's avatar packs to pick from (the Change avatar dock's posters): `value` is the picture. */
  const AvatarChoices = ({ value, onChange, disabled }) =>
    h("fieldset", { "aria-label": "Agent avatars", disabled, className: "flex flex-wrap gap-2 p-0 m-0", style: { border: 0 } },
      ...AVATARS.map((avatar) => h("button", { key: avatar.id, type: "button", "aria-label": avatar.label, "aria-pressed": avatar.url === value,
          "data-buzz-ui": "", className: "buzz-surface-button", onClick: () => onChange(avatar.url),
          style: { width: "var(--size-control)", height: "var(--size-control)", padding: 0, border: 0, background: "transparent", cursor: "pointer",
            borderRadius: "var(--radius-control)", boxShadow: avatar.url === value ? "inset 0 0 0 2px var(--border-prominent)" : undefined } },
        h("img", { src: avatar.url, alt: "", loading: "lazy", draggable: false, style: { width: "100%", height: "100%", objectFit: "contain" } }))));

  // Lines Buzz writes around its cards.
  const Note = (text) => h("p", { className: "m-0 text-body-sm text-secondary" }, text);
  const ErrorLine = (text) => h("p", { role: "alert", className: "buzz-field-error" }, text);
  const Spinner = () => icon(ICON.loader, 16, { className: "motion-safe:animate-spin" });
  /** A line of progress: Buzz's spinner beside a few words. */
  const Status = (text) => h("span", { role: "status", className: "flex items-center gap-2 text-body-sm text-secondary" }, h(Spinner), text);
  /** A value a row shows but does not change. */
  const Value = (text) => h("span", { className: "text-body-sm" }, text);
  /** A line a row shows as broken (red only for broken). */
  const Alert = (text) => h("span", { role: "alert", className: "text-danger" }, text);
  const Code = (text) => h("code", { className: "text-body tabular-nums", style: { letterSpacing: "0.08em" } }, text);

  return { VARIANTS, SectionTitle, Group, Row, Button, Input, Switch, SwitchRow, Pill, Popup, Native, TextField, Stack, Column, Actions, Note, ErrorLine, Spinner, Status, Value, Alert, Code,
    Header, IconButton, PanelHeader, Page, Subview, Surface, PanelBody, Fill, Toolbar, EmptyState, NavItem, Tabs, Disclosure, CountBadge, Dot, LinkChip, OneTimeCode, CodeColumn, Failure, Notice,
    Frame, Avatar, Byline, Canvas, Layers, CanvasImage, QuietLine, Question, Permits, Article, Chip, ChipRow, DiffText, ChangeTable, MediaPair, DecisionBar, Skeleton, Checkbox, SelectRow, ListGroup, Split, MessageCard, MessageRow,
    Title, Heading, Paragraph, Caption, Strong, Lines, Line, Pre, ICON,
    AgentBrowse, AgentGrid, AgentCard, CardMark, AgentPortrait, AgentPanel, AgentProfile, NameInput, NameActions, Menu, AvatarChoices, HeaderTab, Picture, Glyph, COPIED, COPIED_FROM, AVATARS };
}
// ---- end buzz-ui kit ----
// The screens, drawn in Buzz's own primitives and laid out as Buzz's Claude
// Code agent: the host's Harness row, then Sign-in, Model and Thinking in one
// card, then Instructions.
const {Group,Row,Button,Pill,TextField,Stack,Actions,Note,ErrorLine,Status}=buzzUi(R);
const providerName=spec.provider==='claude'?'Claude':'Grok';
const setupGuide=spec.provider==='claude'?'https://code.claude.com/docs/en/setup':'https://docs.x.ai/build/overview';
function useAccount(){
 const [state,setState]=R.useState(account);
 R.useEffect(()=>{listeners.add(setState);setState(account);if(account.state==='unchecked')void checkAccount();return()=>listeners.delete(setState);},[]);
 return state;
}
const modelOf=config=>config?.model||choices[0]?.id||spec.defaultModel;
const readyFor=(state,config)=>state.state==='ready'&&choices.some(m=>m.id===modelOf(config)&&(!config?.effort||m.efforts.includes(config.effort)));
/** Sign-in, as a row: who is signed in (or why not) and the one next step. */
function SignInRow({disabled}){
 const state=useAccount();
 const busy=['checking','signing-in','installing'].includes(state.state);
 const ready=state.state==='ready';
 const actions=state.state==='signing-in'
  ? [h(Button,{key:'cancel',size:'sm',onClick:()=>void loginProcess?.kill()},'Cancel')]
  : [h(Button,{key:'check',size:'sm',disabled:disabled||busy,onClick:()=>void checkAccount()},'Check'),
     h(Button,{key:'sign',size:'sm',variant:ready?'subtle':'prominent',disabled:disabled||busy,onClick:()=>void login()},ready?'Switch account':'Sign in with '+providerName)];
 return h(R.Fragment,null,
  h(Row,{title:'Sign-in',description:busy?Status(state.message):state.state==='required'?h('span',{role:'alert'},state.message):state.message,trailing:h(Actions,null,...actions)}),
  state.state==='required'&&h(Row,{title:providerName+' CLI',description:'Installing needs Node.js and npm on this computer.',
   trailing:h(Actions,null,h(Button,{size:'sm',href:setupGuide},'Setup guide'),h(Button,{size:'sm',variant:'prominent',disabled:disabled||busy,onClick:()=>void install()},'Install'))}));
}
/** The Model control (Buzz puts it in its own Model row). Reports readiness. */
function Model({config,onChange,disabled,onReadyChange}){
 const state=useAccount();
 R.useEffect(()=>{onReadyChange?.(readyFor(state,config));},[state,onReadyChange,config?.model,config?.effort]);
 R.useEffect(()=>()=>onReadyChange?.(false),[onReadyChange]);
 return h(Pill,{label:'Model',value:modelOf(config),disabled:disabled||!choices.length,placeholder:'Sign in first',
  options:choices.map(m=>({id:m.id,label:m.label})),onChange:model=>onChange({...config,model,effort:''})});
}
/** The Thinking control (Buzz puts it in its own Thinking row). */
function Thinking({config,onChange,disabled}){
 const m=choices.find(m=>m.id===modelOf(config))||choices[0];
 return h(Pill,{label:'Thinking',value:config?.effort||'',disabled:disabled||!m,
  options:[{id:'',label:'Default'},...(m?.efforts||[]).map(e=>({id:e,label:e}))],onChange:effort=>onChange({...config,effort})});
}
/** Create: the card the dialog shows under the name, the host's Harness row first. */
function Configuration(props){
 const {harnessControl,showEffort}=props;
 return h(Stack,null,
  h(Group,null,harnessControl,h(SignInRow,props),
   h(Row,{title:'Model',trailing:h(Model,props)}),
   showEffort!==false&&h(Row,{title:'Thinking',trailing:h(Thinking,props)})),
  Note('Uses your own '+providerName+' subscription on this computer. Your sign-in stays in the official '+providerName+' app and is not shared with your community.'));
}
function Create({config,onChange,disabled}){
 return h(TextField,{label:'Instructions',optional:true,rows:4,maxLength:20000,value:config?.instructions||'',disabled,onChange:instructions=>onChange({...config,instructions})});
}
function Settings({agent,save,settingsContent,settingsHost,settingsSection}){
 // Buzz splits this tab: Identity (the card and Instructions) and Settings (its own rows).
 if(settingsSection==='runtime')return settingsContent??null;
 const [draft,setDraft]=R.useState(agent.config||{}),[busy,setBusy]=R.useState(false),[error,setError]=R.useState('');
 const props={config:draft,onChange:setDraft,disabled:busy};
 const dirty=JSON.stringify(draft)!==JSON.stringify(agent.config||{});
 return h(Stack,{as:'form',onSubmit:async event=>{event.preventDefault();setBusy(true);try{await save({...agent.config,...draft});setError('');}catch(e){setError(String(e?.message||e));}finally{setBusy(false);}}},
  error&&ErrorLine(error),
  h(Group,null,settingsHost?.typeControl?.(dirty),h(SignInRow,props),
   h(Row,{title:'Model',trailing:h(Model,props)}),
   h(Row,{title:'Thinking',trailing:h(Thinking,props)})),
  h(TextField,{label:'Instructions',rows:8,maxLength:20000,value:draft.instructions||'',disabled:busy,onChange:instructions=>setDraft({...draft,instructions})}),
  dirty&&h(Actions,null,
   h(Button,{disabled:busy,onClick:()=>setDraft(agent.config||{})},'Discard'),
   h(Button,{type:'submit',variant:'prominent',loading:busy},busy?'Saving…':'Save')),
  settingsSection!=='identity'&&settingsContent);
}
function register(run){agents.register({id:spec.provider,title:spec.title,description:'Personal subscription agent on this computer.',Create,CreateConfiguration:Configuration,CreateModel:Model,createModelReportsReadiness:true,CreateThinking:Thinking,
 tabs:[{id:'settings',title:'Settings',role:'settings',splitSettings:true,component:Settings}],
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

}
