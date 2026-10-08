(() => {
  const root = document.querySelector("#app"),
    base = document.querySelector("body").dataset.session,
    session = base ? JSON.parse(base) : null;
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        })[c],
    );
  let stream = null,
    peers = {},
    seq = 0,
    speaking = false,
    pollTimer = null,
    audioCtx,
    analyser;
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event;
    showInstallButton();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    document
      .querySelectorAll(".install-app")
      .forEach((button) => button.remove());
  });
  function showInstallButton() {
    document
      .querySelectorAll(".install-app")
      .forEach((button) => (button.hidden = false));
  }
  function apiUrl(endpoint) {
    const url = new URL("index.php", document.baseURI);
    url.searchParams.set("route", `/api/${endpoint}`);
    return url.href;
  }
  async function installApp() {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      return;
    }
    document.querySelector("#install-help")?.removeAttribute("hidden");
  }
  function installMarkup() {
    return '<button class="install-app secondary" type="button">DOWNLOAD / INSTALL APP</button><p id="install-help" class="install-help" hidden>On iPhone/iPad, tap Share, then choose “Add to Home Screen”. On Android or desktop, use the browser menu and choose “Install Walkie Talkie”.</p>';
  }
  function qrMarkup() {
    return '<div class="qr-card"><h3>OPEN ON YOUR PHONE</h3><div id="qr-code" class="qr-code" aria-label="QR code for the public application URL"></div><p class="muted">Scan to open this app, then install it on your phone.</p><button id="copy-url" class="secondary copy-url" type="button">COPY APP LINK</button><p id="copy-message" class="install-help" hidden></p></div>';
  }
  function renderQr() {
    const target = `${location.origin}${location.pathname}`;
    const qr = document.querySelector("#qr-code");
    if (!qr) return;
    if (window.QRCode) {
      new QRCode(qr, {
        text: target,
        width: 180,
        height: 180,
        colorDark: "#09111f",
        colorLight: "#ffffff",
      });
    } else {
      qr.innerHTML = `<a href="${esc(target)}">${esc(target)}</a>`;
    }
    document.querySelector("#copy-url")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(target);
        document.querySelector("#copy-message").textContent =
          "App link copied.";
      } catch (e) {
        document.querySelector("#copy-message").textContent = target;
      }
      document.querySelector("#copy-message").hidden = false;
    });
  }
  function join() {
    root.innerHTML = `<section class="join-layout"><div class="card qr-panel">${qrMarkup()}<div class="download-box">${installMarkup()}</div></div><div class="card join-form"><div class="logo">◉ WALKIE TALKIE</div><h1>Push to Talk</h1><p class="muted">Instant voice communication for small teams.</p><form id="join"><label class="field">Nickname<input name="nickname" maxlength="24" required placeholder="Your nickname"></label><label class="field">Channel<input name="channel" maxlength="64" required placeholder="security-team"></label><button type="submit" class="primary">JOIN CHANNEL</button><p class="notice" id="msg"></p></form></div></section>`;
    document.querySelector("#join").onsubmit = async (e) => {
      e.preventDefault();
      const message = document.querySelector("#msg");
      const button = e.target.querySelector("button[type=submit]");
      if (button) button.disabled = true;
      message.textContent = "Joining channel...";
      try {
        const r = await fetch(apiUrl("join"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
          }),
          d = await r.json().catch(() => ({}));
        if (!r.ok) throw Error(d.error || `Unable to join (${r.status})`);
        location.reload();
      } catch (error) {
        message.textContent =
          error instanceof Error
            ? error.message
            : "Unable to connect to the server.";
        if (button) button.disabled = false;
      }
    };
    bindInstallButton();
    renderQr();
  }
  function bindInstallButton() {
    const button = document.querySelector(".install-app");
    if (!button) return;
    button.addEventListener("click", installApp);
    if (deferredInstall) button.hidden = false;
  }
  function channel() {
    const channelName = session.channel || session.room || "unknown";
    root.innerHTML = `<section><div class="top"><div><div class="logo">◉ WALKIE TALKIE</div><h2># ${esc(channelName)}</h2></div><span id="status" class="status">CONNECTING</span></div><div class="grid"><div class="card"><p id="speaker" class="muted">Waiting for a speaker</p><button id="ptt" class="ptt" aria-pressed="false">HOLD TO TALK</button><p id="notice" class="notice">Microphone permission is required to talk.</p><div class="meter"><i id="meter"></i></div><div class="actions"><button id="leave" class="danger">LEAVE CHANNEL</button><div class="download-box">${installMarkup()}</div></div></div><div class="card"><h3>ON THIS CHANNEL <small id="count"></small></h3><ul id="users" class="participants"></ul></div></div></section>`;
    document.querySelector("#ptt").onpointerdown = transmit;
    document.querySelector("#ptt").onpointerup = release;
    document.querySelector("#ptt").onpointercancel = release;
    document.querySelector("#ptt").onpointerleave = (e) => {
      if (e.buttons) release();
    };
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        transmit();
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        release();
      }
    });
    document.querySelector("#leave").onclick = leave;
    bindInstallButton();
    poll();
    navigator.serviceWorker?.register("index.php?asset=sw.js").catch(() => {});
  }
  async function poll() {
    try {
      const r = await fetch(apiUrl("poll"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signal-Token": session.token,
        },
        body: JSON.stringify({ after: seq }),
      });
      if (r.status === 410) {
        clearTimeout(pollTimer);
        Object.values(peers).forEach((peer) => peer.close());
        peers = {};
        location.replace(new URL("index.php", document.baseURI).href);
        return;
      }
      if (!r.ok) throw Error(`poll ${r.status}`);
      const d = await r.json().catch(() => ({}));
      seq = d.sequence;
      document.querySelector("#status").textContent = "CONNECTED";
      render(d);
      for (const e of d.events) {
        if (e.type === "signal" && e.data.to === session.peer)
          handleSignal(e.data);
        if (e.type === "user_joined" && e.data.user.peer !== session.peer)
          initiatePeer(e.data.user.peer);
        if (e.type === "user_left" && peers[e.data.peer]) {
          peers[e.data.peer].close();
          delete peers[e.data.peer];
        }
      }
    } catch (e) {
      document.querySelector("#status").textContent = "RECONNECTING";
      const notice = document.querySelector("#notice");
      if (notice && !speaking)
        notice.textContent = "Signaling connection is unavailable. Retrying...";
    }
    pollTimer = setTimeout(poll, 1000);
  }
  function render(d) {
    document.querySelector("#count").textContent = `${d.users.length} USERS`;
    document.querySelector("#users").innerHTML = d.users
      .map(
        (u) =>
          `<li><span>● ${esc(u.nickname)}</span><small>${u.speaking ? "SPEAKING" : "LISTENING"}</small></li>`,
      )
      .join("");
    document.querySelector("#speaker").textContent = d.speaker
      ? d.speaker === session.peer
        ? "You are transmitting"
        : `${esc(d.users.find((u) => u.peer === d.speaker)?.nickname || "Someone")} is talking`
      : "Waiting for a speaker";
  }
  async function transmit() {
    if (speaking) return;
    const r = await fetch(apiUrl("ptt"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signal-Token": session.token,
        },
        body: JSON.stringify({ action: "request" }),
      }),
      d = await r.json();
    if (!d.granted) {
      document.querySelector("#notice").textContent = "CHANNEL BUSY";
      setTimeout(
        () => (document.querySelector("#notice").textContent = ""),
        1800,
      );
      return;
    }
    speaking = true;
    document.querySelector("#ptt").classList.add("transmitting");
    document.querySelector("#ptt").textContent = "TRANSMITTING";
    document.querySelector("#ptt").setAttribute("aria-pressed", "true");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      stream
        .getTracks()
        .forEach((t) =>
          Object.values(peers).forEach((p) => p.addTrack(t, stream)),
        );
      monitor(stream);
    } catch (e) {
      document.querySelector("#notice").textContent =
        "Microphone permission was denied.";
      release();
    }
  }
  async function release() {
    if (!speaking) return;
    speaking = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    document.querySelector("#ptt")?.classList.remove("transmitting");
    document.querySelector("#ptt").textContent = "HOLD TO TALK";
    document.querySelector("#ptt").setAttribute("aria-pressed", "false");
    await fetch(apiUrl("ptt"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signal-Token": session.token,
      },
      body: JSON.stringify({ action: "release" }),
    });
  }
  async function leave() {
    const button = document.querySelector("#leave");
    if (button) {
      button.disabled = true;
      button.textContent = "LEAVING...";
    }
    clearTimeout(pollTimer);
    Object.values(peers).forEach((peer) => peer.close());
    peers = {};
    await release();
    try {
      await fetch(apiUrl("leave"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signal-Token": session.token,
        },
        body: JSON.stringify({}),
      });
    } finally {
      location.replace(new URL("index.php", document.baseURI).href);
    }
  }
  function monitor(s) {
    audioCtx ??= new AudioContext();
    analyser ??= audioCtx.createAnalyser();
    analyser.fftSize = 64;
    audioCtx.createMediaStreamSource(s).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!speaking) return;
      analyser.getByteFrequencyData(data);
      document.querySelector("#meter").style.width =
        `${Math.min(100, (data.reduce((a, b) => a + b, 0) / data.length / 255) * 160)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  }
  function createPeer(peer) {
    if (peers[peer]) return peers[peer];
    const p = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peers[peer] = p;
    p.onicecandidate = (e) =>
      e.candidate && sendSignal(peer, { candidate: e.candidate });
    p.ontrack = (e) => {
      const a = new Audio();
      a.autoplay = true;
      a.srcObject = e.streams[0];
      document.body.append(a);
    };
    if (stream) stream.getTracks().forEach((t) => p.addTrack(t, stream));
    return p;
  }
  async function initiatePeer(peer) {
    if (session.peer > peer) return;
    const p = createPeer(peer);
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    sendSignal(peer, { description: p.localDescription });
  }
  async function handleSignal(x) {
    const p = createPeer(x.from);
    if (x.signal.description) {
      await p.setRemoteDescription(x.signal.description);
      if (x.signal.description.type === "offer") {
        const answer = await p.createAnswer();
        await p.setLocalDescription(answer);
        sendSignal(x.from, { description: p.localDescription });
      }
    }
    if (x.signal.candidate) await p.addIceCandidate(x.signal.candidate);
  }
  function sendSignal(to, signal) {
    fetch(apiUrl("signal"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signal-Token": session.token,
      },
      body: JSON.stringify({ to, signal }),
    });
  }
  if (session) channel();
  else join();
  window.addEventListener("beforeunload", () => {
    if (session)
      navigator.sendBeacon?.(
        apiUrl("leave"),
        new Blob([JSON.stringify({})], { type: "application/json" }),
      );
  });
})();
