// Gamepad support for the sandbox, through the browser's Gamepad API.
//
// - The app polls `window.__padPoll()` once per frame (src/sandbox.rs, `read_pad`): it reads the pad there and then,
//   applies the mapping, deadzone and response curve, and returns JSON with the analogue actions, the held buttons and
//   the buttons pressed since the last poll. Polling inside the app's frame keeps presses and frames in step.
// - The mapping (which button or axis drives which action) and the settings are editable in the menu's Controller
//   tab (ui.js, through `window.__padApi`) and kept per browser.
// - With a menu open the pad drives the menu instead: D-pad or left stick moves the focus, A selects, B closes,
//   LB/RB switch tabs, left/right adjust a slider.
// - Rumble on firing and on crashes, when the pad and browser support it.
(function () {
  if (new URLSearchParams(location.search).has("bench")) return;

  /** Analogue actions (−1..1) and buttons. The app gives each a meaning per vehicle (see the Controls tab). */
  const ACTIONS = [
    { id: "stickX", label: "Stick left / right", hint: "roll · rudder", kind: "axis" },
    { id: "stickY", label: "Stick forward / back", hint: "pitch · move", kind: "axis" },
    { id: "lookX", label: "Look left / right", hint: "camera", kind: "axis" },
    { id: "lookY", label: "Look up / down", hint: "camera", kind: "axis" },
    { id: "trigger", label: "Throttle", hint: "throttle · camera up/down", kind: "axis" },
    { id: "bumper", label: "Rudder / pedals", hint: "yaw · free-camera speed", kind: "axis" },
    { id: "enter", label: "Get in / out", hint: "as F", kind: "button" },
    { id: "view", label: "Change view", hint: "as V", kind: "button" },
    { id: "action", label: "Action", hint: "landing gear", kind: "button" },
    { id: "zoomIn", label: "Zoom in", hint: "camera · chase distance", kind: "button" },
    { id: "zoomOut", label: "Zoom out", hint: "camera · chase distance", kind: "button" },
    { id: "boost", label: "Boost", hint: "free flight ×5", kind: "button" },
    { id: "brake", label: "Brakes", hint: "wheel brakes", kind: "button" },
    { id: "assets", label: "Aircraft menu", hint: "as Tab", kind: "button" },
    { id: "options", label: "Flight / options menu", hint: "flight menu · settings", kind: "button" },
  ];

  // Standard mapping (https://w3c.github.io/gamepad/#remapping): buttons 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT,
  // 8 View, 9 Menu, 10 LS, 11 RS, 12–15 D-pad up/down/left/right; axes 0/1 left stick, 2/3 right stick.
  const DEFAULTS = {
    stickX: { axis: 0 },
    stickY: { axis: 1, invert: true },
    lookX: { axis: 2 },
    lookY: { axis: 3, invert: true },
    trigger: { pos: 7, neg: 6 },
    bumper: { pos: 5, neg: 4 },
    enter: { button: 1 },
    view: { button: 3 },
    action: { button: 2 },
    zoomIn: { button: 12 },
    zoomOut: { button: 13 },
    boost: { button: 10 },
    brake: { button: 11 },
    assets: { button: 8 },
    options: { button: 9 },
  };
  const DEFAULT_SETTINGS = { deadzone: 0.14, lookSpeed: 1.0, curve: 0.45, invertLook: false, vibration: true, pad: 0 };

  const XBOX = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "LS", "RS", "D-pad ↑", "D-pad ↓", "D-pad ←", "D-pad →", "Home"];
  const PLAYSTATION = ["Cross", "Circle", "Square", "Triangle", "L1", "R1", "L2", "R2", "Create", "Options", "L3", "R3", "D-pad ↑", "D-pad ↓", "D-pad ←", "D-pad →", "PS"];
  const AXES = ["Left stick X", "Left stick Y", "Right stick X", "Right stick Y"];

  const load = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v && typeof v === "object" ? { ...d, ...v } : { ...d };
    } catch {
      return { ...d };
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private window */
    }
  };
  let mapping = load("sandbox.padMapping", DEFAULTS);
  let settings = load("sandbox.padSettings", DEFAULT_SETTINGS);

  const pads = () => [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
  const pad = () => {
    const all = pads();
    return all.find((p) => p.index === settings.pad) ?? all[0] ?? null;
  };
  // Sony's vendor id, or the names; Xbox pads also call themselves "Wireless Controller", so they are excluded first.
  const isPlayStation = (p) => !/xbox|045e/i.test(p?.id ?? "") && /054c|dualsense|dualshock|playstation/i.test(p?.id ?? "");
  const buttonName = (i, p = pad()) => (isPlayStation(p) ? PLAYSTATION : XBOX)[i] ?? `Button ${i}`;
  const axisName = (i) => AXES[i] ?? `Axis ${i}`;

  function bindingLabel(b, p = pad()) {
    if (!b) return "—";
    if (b.axis != null) return `${axisName(b.axis)}${b.invert ? " (inverted)" : ""}`;
    if (b.pos != null) return `${buttonName(b.neg, p)} / ${buttonName(b.pos, p)}`;
    if (b.button != null) return buttonName(b.button, p);
    return "—";
  }

  /** Deadzone, rescaled to use the full range beyond it, then the response curve (0 linear .. 1 cubic). */
  function shape(v) {
    const dz = settings.deadzone;
    const a = Math.abs(v);
    if (a < dz) return 0;
    const x = (a - dz) / (1 - dz);
    const curved = (1 - settings.curve) * x + settings.curve * x * x * x;
    return Math.sign(v) * Math.min(1, curved);
  }
  const btn = (p, i) => (i != null && p.buttons[i] ? p.buttons[i].value || (p.buttons[i].pressed ? 1 : 0) : 0);

  function read(p, b) {
    if (!p || !b) return 0;
    if (b.axis != null) return shape((p.axes[b.axis] ?? 0) * (b.invert ? -1 : 1));
    if (b.pos != null) return shape(btn(p, b.pos) - btn(p, b.neg));
    if (b.button != null) return btn(p, b.button);
    return 0;
  }

  /** Every action's value on this pad. */
  function sample(p) {
    const out = {};
    for (const a of ACTIONS) out[a.id] = read(p, mapping[a.id]);
    if (settings.invertLook) out.lookY = -out.lookY;
    out.lookX *= settings.lookSpeed;
    out.lookY *= settings.lookSpeed;
    return out;
  }

  // ---- the app's poll -----------------------------------------------------------------------------------------
  let prevGame = {};
  let capturing = null;
  window.__padPoll = () => {
    const p = pad();
    const menuOpen = !!document.querySelector("#sim-menu:not([hidden]), #sim-start:not([hidden]), #flight-pause");
    if (!p || menuOpen || capturing) {
      prevGame = {};
      return JSON.stringify({ connected: !!p });
    }
    const s = sample(p);
    const pressed = [];
    for (const a of ACTIONS) {
      if (a.kind !== "button") continue;
      const down = s[a.id] > 0.5;
      if (down && !prevGame[a.id]) pressed.push(a.id);
      prevGame[a.id] = down;
    }
    // Menus are the page's business.
    if (pressed.includes("assets")) openMenu("assets");
    if (pressed.includes("options")) { if(document.body.classList.contains("deck-active")) window.dispatchEvent(new Event("sim:flight-menu")); else openMenu("options"); }
    return JSON.stringify({
      connected: true,
      stick: [s.stickX, s.stickY],
      look: [s.lookX, s.lookY],
      trigger: s.trigger,
      bumper: s.bumper,
      held: { fire: s.fire > 0.5, boost: s.boost > 0.5, brake: s.brake > 0.5, zoomIn: s.zoomIn > 0.5, zoomOut: s.zoomOut > 0.5 },
      pressed,
    });
  };
  const openMenu = (tab) => window.dispatchEvent(new CustomEvent("sim:menu", { detail: tab }));

  // ---- menus with the pad -------------------------------------------------------------------------------------
  let prevMenu = null;
  let repeatAt = 0;
  function menuTick() {
    requestAnimationFrame(menuTick);
    const p = pad();
    const menu = document.querySelector("#sim-menu:not([hidden]), #sim-start:not([hidden]), #flight-pause");
    if (!p || !menu || capturing) {
      prevMenu = null;
      return;
    }
    if (!prevMenu) {
      // Just opened: whatever is held now (the button that opened it) is not a new press.
      prevMenu = { a: btn(p, 0) > 0.5, b: btn(p, 1) > 0.5, start: btn(p, 9) > 0.5, lb: btn(p, 4) > 0.5, rb: btn(p, 5) > 0.5 };
      return;
    }
    const now = performance.now();
    const edge = (key, down) => {
      const e = down && !prevMenu[key];
      prevMenu[key] = down;
      return e;
    };
    const lx = p.axes[0] ?? 0;
    const ly = p.axes[1] ?? 0;
    const dir = btn(p, 12) > 0.5 || ly < -0.6 ? "up" : btn(p, 13) > 0.5 || ly > 0.6 ? "down" : btn(p, 14) > 0.5 || lx < -0.6 ? "left" : btn(p, 15) > 0.5 || lx > 0.6 ? "right" : null;
    const fresh = edge("dir:" + dir, !!dir) || (dir && now > repeatAt);
    if (dir && fresh) {
      repeatAt = now + (prevMenu.held === dir ? 110 : 380);
      prevMenu.held = dir;
      move(menu, dir);
    }
    if (!dir) prevMenu.held = null;
    if (edge("a", btn(p, 0) > 0.5)) {
      const el = document.activeElement;
      if (el && menu.contains(el)) el.click();
    }
    if (edge("b", btn(p, 1) > 0.5) || edge("start", btn(p, 9) > 0.5)) window.dispatchEvent(new CustomEvent("sim:menu-close"));
    if (edge("lb", btn(p, 4) > 0.5)) window.dispatchEvent(new CustomEvent("sim:menu-tab", { detail: -1 }));
    if (edge("rb", btn(p, 5) > 0.5)) window.dispatchEvent(new CustomEvent("sim:menu-tab", { detail: 1 }));
  }
  requestAnimationFrame(menuTick);

  /** Spatial focus: the nearest focusable in that direction; left/right step a focused slider instead. */
  function move(menu, dir) {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.type === "range" && (dir === "left" || dir === "right")) {
      dir === "left" ? el.stepDown() : el.stepUp();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const items = [...menu.querySelectorAll("button, input, select, summary")].filter((x) => x.offsetParent !== null && !x.disabled);
    if (!items.length) return;
    if (!el || !menu.contains(el)) return items[0].focus();
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const it of items) {
      if (it === el) continue;
      const q = it.getBoundingClientRect();
      const dx = q.left + q.width / 2 - cx;
      const dy = q.top + q.height / 2 - cy;
      const along = dir === "up" ? -dy : dir === "down" ? dy : dir === "left" ? -dx : dx;
      const across = dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
      if (along <= 4) continue;
      const score = along + across * 2.2;
      if (score < bestScore) (bestScore = score), (best = it);
    }
    (best ?? el).focus();
    best?.scrollIntoView({ block: "nearest" });
  }

  // ---- rumble -------------------------------------------------------------------------------------------------
  let lastRumble = 0;
  function rumble(strong, weak, ms) {
    const p = pad();
    const now = performance.now();
    if (!settings.vibration || !p?.vibrationActuator || now - lastRumble < ms * 0.6) return;
    lastRumble = now;
    p.vibrationActuator.playEffect?.("dual-rumble", { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }
  // Follows the HUD state: the muzzle flash, and crashes and kills in its messages.
  let lastMessage = "";
  setInterval(() => {
    const s = window.__hudState;
    if (!s) return;
    if (s.muzzle) rumble(0.15, 0.5, 70);
    const m = s.base?.message ?? "";
    if (m !== lastMessage && /CRASHED|DESTROYED|DETONATED|IMPACT/.test(m)) rumble(1, 1, 450);
    lastMessage = m;
  }, 50);

  // ---- API for the Controller tab -----------------------------------------------------------------------------
  window.__padApi = {
    ACTIONS,
    pads,
    pad,
    buttonName,
    axisName,
    bindingLabel,
    sample: () => (pad() ? sample(pad()) : null),
    mapping: () => mapping,
    settings: () => settings,
    setSettings(patch) {
      settings = { ...settings, ...patch };
      save("sandbox.padSettings", settings);
    },
    reset() {
      mapping = { ...DEFAULTS };
      settings = { ...DEFAULT_SETTINGS };
      save("sandbox.padMapping", mapping);
      save("sandbox.padSettings", settings);
    },
    /**
     * Waits for the next input and binds it to the action: a button for a button action; for an analogue action
     * either an axis moved (in the direction that should count as positive) or a button, then its opposite.
     */
    capture(actionId, onStep) {
      const action = ACTIONS.find((a) => a.id === actionId);
      if (!action) return Promise.reject(new Error("unknown action"));
      return new Promise((resolve) => {
        const p0 = pad();
        if (!p0) return resolve(null);
        const restAxes = [...p0.axes];
        const released = (p) => p.buttons.every((b) => !b.pressed) && p.axes.every((a, i) => Math.abs(a - restAxes[i]) < 0.4);
        let stage = "wait-release";
        let first = null;
        const started = performance.now();
        capturing = actionId;
        const tick = () => {
          const p = pad();
          if (!p || performance.now() - started > 10000) {
            capturing = null;
            return resolve(null);
          }
          if (stage === "wait-release") {
            if (released(p)) stage = action.kind === "axis" ? "axis-or-button" : "button";
            return requestAnimationFrame(tick);
          }
          const button = p.buttons.findIndex((b) => b.pressed);
          if (stage === "button" && button >= 0) return finish({ button });
          if (stage === "axis-or-button") {
            const axis = p.axes.findIndex((a, i) => Math.abs(a - restAxes[i]) > 0.6);
            if (axis >= 0) return finish({ axis, invert: p.axes[axis] - restAxes[axis] < 0 });
            if (button >= 0) {
              first = button;
              stage = "wait-release-2";
              onStep?.("Now the opposite direction");
            }
          }
          if (stage === "wait-release-2" && p.buttons.every((b) => !b.pressed)) stage = "negative";
          if (stage === "negative" && button >= 0 && button !== first) return finish({ pos: first, neg: button });
          requestAnimationFrame(tick);
        };
        const finish = (binding) => {
          mapping = { ...mapping, [actionId]: binding };
          save("sandbox.padMapping", mapping);
          // Don't let the binding press fire the action.
          setTimeout(() => (capturing = null), 250);
          resolve(binding);
        };
        requestAnimationFrame(tick);
      });
    },
  };

  // The bar shows a controller when one is connected.
  const announce = () => window.dispatchEvent(new CustomEvent("sim:pads", { detail: pads().length }));
  addEventListener("gamepadconnected", announce);
  addEventListener("gamepaddisconnected", announce);
})();
