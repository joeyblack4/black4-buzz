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
  const ICON = { chevron: "M6 9l6 6l6 -6", check: "M5 12l5 5l10 -10", loader: "M12 3a9 9 0 1 0 9 9" };
  const h = React.createElement;
  const Fragment = React.Fragment;
  const icon = (path, size, props = {}) => h("svg", { xmlns: "http://www.w3.org/2000/svg", width: `${size / 16}rem`, height: `${size / 16}rem`,
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props },
    h("path", { d: path }));

  /** Header.tsx `InlineHeader`: a section's title above its card. */
  const SectionTitle = ({ title, subtitle, id }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": "" },
      h("div", { className: "buzz-content-header-copy" },
        h("h3", { id, className: "buzz-content-header-title" }, title),
        subtitle ? h("p", { className: "buzz-content-header-subtitle" }, subtitle) : null));

  /** SettingsGroup.tsx: the rounded card. Every direct child is a row. */
  const Group = ({ layout = "rows", children }) =>
    h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": layout }, children);

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
  const Button = ({ variant = "subtle", size = "md", shape = "capsule", type = "button", loading = false, disabled, onClick, href, children, ...props }) => {
    const shared = { ...props, "aria-busy": loading || props["aria-busy"],
      "data-buzz-ui": "", className: "buzz-button", "data-variant": variant, "data-size": size, "data-button-shape": shape,
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
  const Input = ({ controlSize = "md", width, ...props }) =>
    h("input", { type: "text", ...props, ...(width ? { style: { width } } : {}), "data-buzz-ui": "", "data-size": controlSize, className: "buzz-input" });

  /** Switch.tsx without its own label: the row names it. */
  const Switch = ({ id, checked, disabled, onCheckedChange, ...aria }) =>
    h("button", { type: "button", role: "switch", id, "aria-checked": checked, ...aria, disabled,
        "data-buzz-ui": "", className: "buzz-switch-control",
        "data-checked": checked ? "" : undefined, "data-disabled": disabled ? "" : undefined,
        onClick: () => { if (!disabled) onCheckedChange(!checked); } },
      h("span", { className: "buzz-switch-thumb", "data-checked": checked ? "" : undefined }));

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
    return h("div", { "data-buzz-ui": "", className: "buzz-field", "data-invalid": error ? "" : undefined },
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
  const GAPS = { 2: "grid gap-2", 4: "grid gap-4" };
  const each = (children) => (Array.isArray(children) ? children : [children]);
  /** A column of sections, cards or fields. `as: "form"` makes it the form
   * (with `onSubmit`); gap 4 between sections, 2 within a field. */
  const Stack = ({ as = "div", gap = 4, onSubmit, children }) =>
    h(as, { className: GAPS[gap] ?? GAPS[4], onSubmit }, ...each(children));
  /** A row of buttons that wraps. */
  const Actions = ({ children }) => h("div", { className: "flex flex-wrap items-center gap-3" }, ...each(children));

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

  return { SectionTitle, Group, Row, Button, Input, Switch, SwitchRow, Pill, Popup, Native, TextField, Stack, Actions, Note, ErrorLine, Spinner, Status, Value, Alert, Code };
}
