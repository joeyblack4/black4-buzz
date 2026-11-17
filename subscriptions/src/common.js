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
    link: ["M9 15l6 -6", "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464", "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"] };
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
  const TextField = ({ label, description, error, optional = false, value, onChange, rows = 8, maxLength, placeholder, disabled }) => {
    const id = React.useId();
    return h("div", { "data-buzz-ui": "", className: "buzz-field" },
      h("label", { className: "buzz-field-label", htmlFor: id }, label,
        optional ? h(Fragment, null, " ", h("span", { className: "buzz-field-optional" }, "Optional")) : null),
      h("textarea", { id, rows, maxLength, placeholder, value, disabled,
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
    h(as, { className: GAPS[one(VARIANTS.Stack.gap, gap)], onSubmit }, ...each(children));
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
   * IconButton) first, the title, then `actions`. */
  const PanelHeader = ({ title, navigation, actions }) =>
    h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
      navigation ?? null,
      h("div", { className: "panel-header-title" }, h("h2", { className: "text-label text-primary" }, title)),
      actions ? h("div", { className: "panel-header-actions" }, ...each(actions)) : null);

  /** A dock page's surface (Panel.tsx, laid out as Shared notes' page):
   * `header` (a PanelHeader) above a scrolling body. `fill`: the body has no
   * inset (an embedded browser fills it). */
  const Page = ({ label, header, fill = false, children }) =>
    h("section", { className: "panel", "data-buzz-surface": "", "data-shape": "panel", "aria-label": label },
      h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, containerType: "inline-size" } },
        header ?? null,
        h("div", { style: fill ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }
            : { overflow: "auto", padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-4)", minHeight: 0, flex: 1 } },
          ...each(children))));

  /** A drill-in inside a panel (PanelSubview): its bar stays put while the body scrolls. */
  const Subview = ({ header, children }) =>
    h("div", { "data-buzz-ui": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, header, ...each(children));
  /** A side panel's body: Buzz leaves the inset to the panel (as GitHub's). */
  const PanelBody = ({ children }) =>
    h("div", { "data-buzz-ui": "", style: { padding: "var(--space-panel-inset)", overflowY: "auto", minHeight: 0, flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-4)", color: "var(--text-standard)" } },
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
  const Tabs = ({ label, value, items, onChange }) => {
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
    return h("div", { "data-buzz-ui": "", className: "buzz-tabs", "data-variant": "panel", "data-size": "sm", "data-orientation": "horizontal" },
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
    Header, IconButton, PanelHeader, Page, Subview, PanelBody, Fill, Toolbar, EmptyState, NavItem, Tabs, Disclosure, CountBadge, Dot, LinkChip, OneTimeCode, CodeColumn, Failure, Notice,
    Title, Heading, Paragraph, Caption, Strong, Lines, Line, Pre, ICON };
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
