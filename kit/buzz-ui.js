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
    link: ["M9 15l6 -6", "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464", "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"],
    // chevron-up, chevron-down, currency-dollar, users, alert-triangle, minus
    up: "M6 15l6 -6l6 6", down: "M6 9l6 6l6 -6",
    money: ["M16.7 8a3 3 0 0 0 -2.7 -2h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-4a3 3 0 0 1 -2.7 -2", "M12 3v3m0 12v3"],
    people: ["M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2", "M16 3.13a4 4 0 0 1 0 7.75", "M21 21v-2a4 4 0 0 0 -3 -3.85"],
    alert: ["M12 9v4", "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z", "M12 16h.01"],
    minus: "M5 12l14 0" };
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
   * IconButton) first, the title, then `actions`. */
  const PanelHeader = ({ title, navigation, actions }) =>
    h("header", { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
      navigation ?? null,
      h("div", { className: "panel-header-title" }, h("h2", { className: "text-label text-primary" }, title)),
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

  // ---- Reviews: the work, the decision and the list ------------------------------

  /** ValueChip.tsx: a short read-only value (a stake, a fact). `glyph`: an
   * ICON name for its 12px mark; `emphasis`: the label in the standard weight
   * (the stake), else the chip's own. */
  const Chip = ({ label, glyph, title }) =>
    h("span", { "data-buzz-ui": "", className: "buzz-value-chip" },
      glyph && ICON[glyph] ? h("span", { className: "buzz-value-chip-icon", "aria-hidden": true }, icon(ICON[glyph], 12)) : null,
      h("span", { className: "buzz-value-chip-text", title: title ?? (typeof label === "string" ? label : undefined) }, label));
  /** One of the kit's icons on its own, as Buzz draws a 16px icon (a sidebar section's mark). */
  const Glyph = ({ name, size = 16 }) => icon(ICON[name] ?? ICON.check, size);
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
          : h(run.kind === "added" ? "ins" : "del", { key: index, style: { ...RUN[run.kind], color: "inherit" } },
            h("span", { className: "sr-only" }, run.kind === "added" ? "Added: " : "Removed: "), run.text))));

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
   * bottom): a `status` line, then the actions. `stacked`: a field above. */
  const DecisionBar = ({ status, stacked = false, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": "Decision", style: { flex: "0 0 auto", display: "flex", flexDirection: stacked ? "column" : "row", flexWrap: "wrap",
        alignItems: stacked ? "stretch" : "center", justifyContent: "space-between", gap: "var(--space-2) var(--space-3)",
        padding: "var(--space-3) var(--space-panel-inset)", borderTop: "1px solid var(--border-standard)", background: "var(--surface-panel)" } },
      status ? h("div", { "aria-live": "polite", style: { minWidth: 0, flex: stacked ? undefined : "1 1 12rem" } }, status) : null,
      ...(children == null ? [] : [h("div", { key: "actions", className: "flex flex-wrap items-center gap-2" }, ...each(children))]));

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
  const SelectRow = ({ title, subtitle, meta, selected = false, picked, onPick, pickLabel, onOpen, quiet = false }) =>
    h("li", { style: { minWidth: 0, listStyle: "none" } },
      h("div", { "data-buzz-ui": "", "data-navigation-card": "", "data-tone": "default", className: "navigation-card" },
        h("div", { className: "navigation-card-row" },
          h("button", { type: "button", "data-variant": "row", "data-multiline": "", "data-buzz-ui": "", className: "navigation-item",
              "data-selected": selected ? "" : undefined, "aria-current": selected ? "true" : undefined, onClick: onOpen },
            h("span", { className: "navigation-item-label" },
              h("span", { style: { display: "flex", flexDirection: "column", gap: "var(--space-1)", minWidth: 0, whiteSpace: "normal", paddingBlock: "var(--space-row-gap)" } },
                h("span", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-1) var(--space-control-inset)" } },
                  h("strong", { className: `text-label-sm ${quiet ? "text-subtle" : "text-standard"}`, style: { minWidth: 0, overflowWrap: "anywhere" } }, title),
                  meta ? h("span", { className: "text-caption text-subtle", style: { flex: "0 0 auto" } }, meta) : null),
                subtitle ? h("span", { className: "text-body-sm text-subtle", style: { maxInlineSize: "64ch", overflow: "hidden", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } }, subtitle) : null))),
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
  const Split = ({ label, list, detail, showing = false }) => {
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
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "var(--space-3) var(--space-row-gap) var(--space-panel-inset)" } }, list)),
      narrow && !showing ? null : h("div", { style: { ...pane, flex: 1 } }, detail));
  };

  /** The finished work as a page, in Diffs' card (`.preview`: a bounded,
   * scrolling frame) with an embedded view inside. */
  const Frame = ({ label, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": label, style: { ...card, display: "flex", height: "min(28rem, 60vh)", minHeight: "16rem" } }, ...each(children));
  /** A message's card (Diffs' DiffMessage card): a quiet frame around rows. */
  const MessageCard = ({ label, children }) =>
    h("div", { "data-buzz-ui": "", role: "group", "aria-label": label, style: { ...card, display: "grid" } }, ...each(children));
  /** One row in a message's card: the question, its live state, Open. */
  const MessageRow = ({ title, subtitle, loading = false, onOpen, openLabel = "Open" }) =>
    h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) var(--space-3)", minWidth: 0 } },
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
    Glyph, Frame, Chip, ChipRow, DiffText, ChangeTable, MediaPair, DecisionBar, Skeleton, Checkbox, SelectRow, ListGroup, Split, MessageCard, MessageRow,
    Title, Heading, Paragraph, Caption, Strong, Lines, Line, Pre, ICON };
}
