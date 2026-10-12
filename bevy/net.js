// Multiplayer for the sandbox: the players' browsers connect to each other directly over WebRTC data channels. The
// server only passes the connection handshakes between them (the workspace gateway's /api/sim/signal, signal.mjs),
// so it works where nothing can hold a connection open, as on Vercel:
//   the host creates a session (POST /api/sim/signal) and polls for offers; a guest posts its offer with the
//   session's code and polls for the host's answer; then they talk directly.
// It is a star: each guest connects to the host only, and the host's browser relays each guest's messages to the
// others, so every player hears every other.
//
// Every player owns what they spawned: the app sends its vehicles' state (Earth-fixed coordinates, ~15 Hz), its
// aircraft updates and departures through `window.__netSend`; what arrives from others goes to the app as `{ type: "net" }`
// commands (window.__cmds). The host's weather is everyone's. An invite link is the page's address with
// `?join=<session>&code=<code>`.
(function () {
  if (new URLSearchParams(location.search).has("bench")) return;

  const load = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v && typeof v === "object" ? { ...d, ...v } : d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private window */
    }
  };
  const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  // A fresh id per tab (two tabs are two players); the name is remembered.
  const me = { id: rand(6), name: load("sandbox.player", { name: `Pilot ${rand(2).toUpperCase()}` }).name };
  // Public STUN servers find each browser's address from outside its network. (Networks that allow no direct
  // connection at all would need a TURN relay, which this doesn't have.)
  const ICE = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

  /**
   * The host keeps a connection per guest (`peers`); a guest has one, to the host.
   * @type {null | { id: string, code: string, role: "host" | "seat", open: boolean, error?: string, token?: string,
   *   peers?: Map<string, { pc: RTCPeerConnection, dc: RTCDataChannel | null }>, pc?: RTCPeerConnection, dc?: RTCDataChannel, poll?: number }}
   */
  let session = null;
  const players = new Map(); // id -> { name, what, last }
  const listeners = new Set();
  // The app learns who it is from a `me` message (who a hit or a kill on foot is for: sandbox/infantry/net.rs).
  const announce = () => pushCmd({ type: "net", from: me.id, name: me.name, msg: { k: "me" } });
  const changed = () => (announce(), listeners.forEach((f) => f()));
  const pushCmd = (cmd) => (window.__cmds = window.__cmds || []).push(JSON.stringify(cmd));

  /** To everyone this browser is connected to (the host: every guest but `except`; a guest: the host). */
  function broadcast(text, except) {
    if (session?.role === "host") {
      for (const [id, p] of session.peers) if (id !== except && p.dc?.readyState === "open") p.dc.send(text);
    } else if (session?.dc?.readyState === "open") {
      session.dc.send(text);
    }
  }

  window.__netActive = false;
  /** The app's messages: `json` is one message object. */
  window.__netSend = (json) => {
    if (!session?.open) return;
    broadcast(`{"t":"mp","from":${JSON.stringify(me.id)},"name":${JSON.stringify(me.name)},"msg":${json}}`);
  };
  const send = (msg) => window.__netSend(JSON.stringify(msg));

  // The page may be served under a base path (the deployment's /); the API is at the site's root.
  const api = async (path, init) => {
    const res = await fetch(`/api/sim/signal${path}`, init);
    return { res, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** The handshake goes in one piece: wait until the connection has found its addresses (at most 4 s). */
  const gathered = (pc) =>
    new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const done = () => pc.iceGatheringState === "complete" && resolve();
      pc.addEventListener("icegatheringstatechange", done);
      setTimeout(resolve, 4000);
    });

  /** The host: answer a guest's offer, and keep its channel. */
  async function accept(s, peer, sdp) {
    s.peers.get(peer)?.pc.close();
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const entry = { pc, dc: null };
    s.peers.set(peer, entry);
    const drop = () => s.peers.get(peer) === entry && s.peers.delete(peer);
    pc.ondatachannel = (e) => {
      entry.dc = e.channel;
      e.channel.onmessage = (m) => receive(String(m.data), peer);
      e.channel.onclose = drop;
    };
    pc.onconnectionstatechange = () => ["failed", "closed"].includes(pc.connectionState) && drop();
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await post(`/${s.id}/answer`, { token: s.token, peer, sdp: pc.localDescription.sdp });
  }

  function receive(text, fromPeer) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t !== "mp") return;
    // The host passes each guest's message on to the other guests.
    if (session?.role === "host" && fromPeer) broadcast(text, fromPeer);
    if (m.from === me.id) return;
    const known = players.get(m.from);
    players.set(m.from, { name: m.name, what: m.msg?.k === "state" ? m.msg.what : known?.what ?? "", last: performance.now() });
    if (!known) changed();
    const k = m.msg?.k;
    if (k === "hello") {
      if (session?.role === "host") send({ k: "weather", weather: window.__weatherState?.() ?? {} });
      return;
    }
    if (k === "weather") {
      if (session?.role !== "host") dispatchEvent(new CustomEvent("sim:set-weather", { detail: m.msg.weather }));
      return;
    }
    if (k === "leave") {
      players.delete(m.from);
      changed();
    }
    pushCmd({ type: "net", from: m.from, name: m.name, msg: m.msg });
  }

  function dropAll() {
    for (const id of players.keys()) pushCmd({ type: "net", from: id, msg: { k: "leave" } });
    players.clear();
  }

  // Players who went quiet (closed the tab, lost the connection) are dropped after 6 s.
  setInterval(() => {
    const now = performance.now();
    for (const [id, p] of players) {
      if (now - p.last > 6000) {
        players.delete(id);
        pushCmd({ type: "net", from: id, msg: { k: "leave" } });
        changed();
      }
    }
    if (players.size) changed();
  }, 2000);

  function leave(quiet) {
    if (!session) return;
    if (session.open) send({ k: "leave" });
    const s = session;
    session = null;
    window.__netActive = false;
    clearTimeout(s.poll);
    // The goodbye goes out first.
    setTimeout(() => {
      for (const p of s.peers?.values() ?? []) p.pc.close();
      s.pc?.close();
    }, 150);
    dropAll();
    if (!quiet) changed();
  }
  addEventListener("beforeunload", () => leave(true));

  // The host's weather changes go to everyone.
  addEventListener("sim:weather", (e) => {
    if (session?.open && session.role === "host") send({ k: "weather", weather: e.detail });
  });

  const invite = (base = location.origin) => (session ? `${base}${location.pathname}?join=${session.id}&code=${session.code}` : "");
  const localOnly = () => /^(localhost|127\.|\[::1\])/.test(location.hostname);

  window.__netApi = {
    me: () => me,
    session: () => session,
    players: () => [...players.entries()].map(([id, p]) => ({ id, ...p })),
    onChange: (f) => (listeners.add(f), () => listeners.delete(f)),
    setName(name) {
      me.name = String(name).trim().slice(0, 24) || me.name;
      save("sandbox.player", { name: me.name });
      announce();
    },
    async host() {
      leave(true);
      const r = await post("", {}).catch(() => null);
      if (!r?.res.ok || !r.body?.id) {
        session = { id: "", code: "", role: "host", open: false, error: r?.body?.error ?? (r ? `Sessions answered ${r.res.status}` : "Could not reach the server") };
        changed();
        return;
      }
      const s = (session = { id: r.body.id, code: r.body.code, role: "host", token: r.body.hostToken, open: true, peers: new Map() });
      window.__netActive = true;
      // Guests knock by leaving an offer; collect them while hosting.
      const poll = async () => {
        if (session !== s) return;
        const got = await api(`/${s.id}/offers?token=${s.token}`).catch(() => null);
        for (const o of got?.body?.offers ?? []) accept(s, o.peer, o.sdp).catch(() => {});
        if (session === s) s.poll = setTimeout(poll, 1500);
      };
      poll();
      changed();
    },
    async join(id, code) {
      leave(true);
      const pc = new RTCPeerConnection({ iceServers: ICE });
      const dc = pc.createDataChannel("sim");
      const s = (session = { id, code, role: "seat", open: false, pc, dc });
      changed();
      const fail = (error) => {
        if (session !== s) return;
        pc.close();
        session = { id, code, role: "seat", open: false, error };
        window.__netActive = false;
        dropAll();
        changed();
      };
      dc.onopen = () => {
        if (session !== s) return;
        s.open = true;
        window.__netActive = true;
        send({ k: "hello" });
        changed();
      };
      dc.onmessage = (e) => receive(String(e.data));
      dc.onclose = () => fail(s.open ? "Disconnected: the host left" : "Could not connect");
      pc.onconnectionstatechange = () => pc.connectionState === "failed" && fail(s.open ? "Disconnected" : "Could not connect: the networks don't allow a direct connection");
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        const { res, body } = await post(`/${id}/offer`, { code, peer: me.id, sdp: pc.localDescription.sdp });
        if (!res.ok) return fail(body?.error ?? `Could not join (${res.status})`);
        // The host collects offers every 1.5 s; its answer comes back the same way.
        for (let i = 0; i < 45 && session === s; i++) {
          await wait(700);
          const got = await api(`/${id}/answer?peer=${me.id}&code=${encodeURIComponent(code)}`);
          if (got.res.status === 200 && got.body?.sdp) return void (await pc.setRemoteDescription({ type: "answer", sdp: got.body.sdp }));
          if (!got.res.ok && got.res.status !== 204) return fail(got.body?.error ?? "Could not join");
        }
        fail("The host did not answer");
      } catch {
        fail("Could not join");
      }
    },
    leave: () => leave(false),
    invite,
    localOnly,
  };

  // Opened from an invite link: offer to join.
  const q = new URLSearchParams(location.search);
  if (q.get("join") && q.get("code")) {
    const offer = { id: q.get("join"), code: q.get("code") };
    window.__netInvite = offer;
    addEventListener("load", () => setTimeout(() => dispatchEvent(new CustomEvent("sim:invite", { detail: offer })), 400));
  }
})();
