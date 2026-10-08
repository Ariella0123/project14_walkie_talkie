(() => {
  const root = document.querySelector("#app"),
    base = document.querySelector("body").dataset.session;
  let session = base ? JSON.parse(base) : null;
  if (!session) {
    try {
      session = JSON.parse(sessionStorage.getItem("walkieSession") || "null");
    } catch {
      sessionStorage.removeItem("walkieSession");
    }
  }
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
    pendingCandidates = {},
    remoteAudio = {},
    seq = 0,
    speaking = false,
    talkPressActive = false,
    talkRequestId = 0,
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
      e.stopPropagation();
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
        session = d;
        sessionStorage.setItem("walkieSession", JSON.stringify(session));
        channel();
      } catch (error) {
        message.textContent =
          error instanceof Error
            ? error.message
            : "Unable to connect to the server.";
        if (button) button.disabled = false;
      }
      return false;
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
    const ptt = document.querySelector("#ptt");
    ptt.onpointerdown = (e) => {
      e.preventDefault();
      ptt.setPointerCapture?.(e.pointerId);
      audioCtx?.resume?.();
      Object.values(remoteAudio).forEach((audio) => audio.play().catch(() => {}));
      talkPressActive = true;
      transmit();
    };
    ptt.onpointerup = (e) => {
      e.preventDefault();
      talkPressActive = false;
      release();
    };
    ptt.onpointercancel = () => {
      talkPressActive = false;
      release();
    };
    ptt.onlostpointercapture = () => {
      talkPressActive = false;
      release();
    };
    ptt.onclick = (e) => e.preventDefault();
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        talkPressActive = true;
        transmit();
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        talkPressActive = false;
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
        Object.values(remoteAudio).forEach((audio) => {
          audio.pause();
          audio.srcObject = null;
        });
        remoteAudio = {};
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        sessionStorage.removeItem("walkieSession");
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
          `<li><span>● ${esc(u.nickname)}</span><small>${u.peer === session.peer && speaking ? "SPEAKING" : "ONLINE"}</small></li>`,
      )
      .join("");
    document.querySelector("#speaker").textContent = speaking
      ? "You are transmitting. Others can talk at the same time."
      : "Hold to talk. Everyone can talk at the same time.";
  }
  async function transmit() {
    if (!talkPressActive || speaking) return;
    const requestId = ++talkRequestId;
    try {
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw Error("No microphone track available");
      audioTrack.enabled = false;
      if (!talkPressActive || requestId !== talkRequestId) return;
      audioTrack.enabled = true;
      speaking = true;
      document.querySelector("#ptt").classList.add("transmitting");
      document.querySelector("#ptt").textContent = "TRANSMITTING";
      document.querySelector("#ptt").setAttribute("aria-pressed", "true");
      document.querySelector("#speaker").textContent =
        "You are transmitting. Others can talk at the same time.";
      await Promise.all(
        Object.entries(peers).map(async ([peer, connection]) => {
          const sender = audioSender(connection);
          if (!sender) throw Error(`Audio sender unavailable for ${peer}`);
          await sender.replaceTrack(audioTrack);
        }),
      );
      monitor(stream);
    } catch (e) {
      if (talkPressActive) {
        const denied = e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError";
        document.querySelector("#notice").textContent = denied
          ? "Microphone permission was denied."
          : `Talk failed: ${e?.message || "connection error"}`;
      }
      release();
    }
  }
  async function release() {
    talkRequestId++;
    speaking = false;
    stream?.getAudioTracks().forEach((track) => (track.enabled = false));
    resetPtt();
    const speaker = document.querySelector("#speaker");
    if (speaker)
      speaker.textContent = "Hold to talk. Everyone can talk at the same time.";
  }
  function resetPtt() {
    document.querySelector("#ptt")?.classList.remove("transmitting");
    document.querySelector("#ptt")?.setAttribute("aria-pressed", "false");
    const button = document.querySelector("#ptt");
    if (button) button.textContent = "HOLD TO TALK";
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
      sessionStorage.removeItem("walkieSession");
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
      const a = remoteAudio[peer] || new Audio();
      a.autoplay = true;
      a.playsInline = true;
      a.srcObject = e.streams[0] || new MediaStream([e.track]);
      remoteAudio[peer] = a;
      document.body.append(a);
      a.play().catch(() => {
        const notice = document.querySelector("#notice");
        if (notice) notice.textContent = "Tap the page to enable incoming audio.";
      });
    };
    const transceiver = p.addTransceiver("audio", { direction: "sendrecv" });
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) transceiver.sender.replaceTrack(audioTrack);
    }
    return p;
  }
  function audioSender(connection) {
    return (
      connection.getSenders().find((item) => item.track?.kind === "audio") ||
      connection
        .getTransceivers()
        .find((item) => item.receiver.track?.kind === "audio")?.sender ||
      connection.getTransceivers()[0]?.sender
    );
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
      const candidates = pendingCandidates[x.from] || [];
      delete pendingCandidates[x.from];
      for (const candidate of candidates) await p.addIceCandidate(candidate);
      if (x.signal.description.type === "offer") {
        const answer = await p.createAnswer();
        await p.setLocalDescription(answer);
        sendSignal(x.from, { description: p.localDescription });
      }
    }
    if (x.signal.candidate) {
      if (p.remoteDescription) {
        await p.addIceCandidate(x.signal.candidate);
      } else {
        (pendingCandidates[x.from] ||= []).push(x.signal.candidate);
      }
    }
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
