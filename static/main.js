let ws = null;
let currentPayload = null;
let myId = getOrCreatePlayerId();
let roomId = "";
let myName = "";
let markSessionId = null;
let previousMarkSnapshot = { phase: null, hadRole: false, score: "0:0" };
let autoEntering = false;
let dealOverlayShownForSession = null;
let dealOverlayTimer = null;
let dealOverlayStart = 0;
let lastRenderedPhaseKey = null;
let lastResultToastKey = null;
let phaseToastTimer = null;

function getOrCreatePlayerId() {
  try {
    const existing = localStorage.getItem("avalon_player_id");
    if (existing) return existing;
    let id = "";
    // crypto.randomUUID() is unavailable on some non-HTTPS/IP deployments.
    // Use it when possible, otherwise fall back to a timestamp + random string.
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      id = window.crypto.randomUUID().replaceAll("-", "");
    } else if (window.crypto && window.crypto.getRandomValues) {
      const arr = new Uint32Array(4);
      window.crypto.getRandomValues(arr);
      id = Array.from(arr).map(n => n.toString(16)).join("");
    } else {
      id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    }
    id = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    localStorage.setItem("avalon_player_id", id);
    return id;
  } catch (_) {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g, "");
  }
}

let localAudioTrack = null;
let livekitRoom = null;
let livekitSDK = null;
let livekitConnecting = false;

// voiceEnabled: 是否已经连接 LiveKit 语音房。
// micEnabled: 是否采集并发送自己的麦克风。
// speakerEnabled: 是否播放别人声音。
let voiceEnabled = false;
let micEnabled = false;
let speakerEnabled = false;
let listenOnly = false;

let remoteAudioEls = new Map();
let lastMicStatus = null;
let lastPersonalAudioAllowed = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let shouldReconnect = false;
let connectingWs = false;
let reconnecting = false;
let reconnectAttempt = 0;
let lastWsMessageAt = Date.now();
let appVisibilityHidden = false;      // true while tab/app is in background
const HEARTBEAT_MS = 8000;            // match server HEARTBEAT_INTERVAL
const WS_TIMEOUT_MS = 95000;          // slightly > server CLIENT_TIMEOUT (90s)
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 12000;       // max 12 s between retries
const RECONNECT_MAX_ATTEMPTS = 20;    // give up showing error after this many
let localAudioContext = null;
let localAnalyser = null;
let speakingWatchTimer = null;
let lastSpeakingState = false;
let speakingSilentSince = 0;
let audioUnlocked = false;

const SPEAKING_ON_RMS = 14;
const SPEAKING_OFF_RMS = 6;
const SPEAKING_OFF_DELAY_MS = 180;
const SPEAKING_CHECK_MS = 100;
const LIVEKIT_SDK_URLS = [
  "https://cdn.jsdelivr.net/npm/livekit-client@2.19.0/+esm",
  "https://esm.sh/livekit-client@2.19.0?bundle"
];

const $ = (id) => document.getElementById(id);

window.addEventListener("load", () => {
  $("joinView").classList.remove("hidden");
  $("gameView").classList.add("hidden");
  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get("room");
  const storedRoom = localStorage.getItem("avalon_last_room") || "";
  const storedName = localStorage.getItem("avalon_player_name") || "";

  // Pre-fill from URL param only
  if (roomFromUrl) $("roomInput").value = roomFromUrl.toUpperCase();
  $("nameInput").value = storedName;

  // Show "continue last room" card if has stored room (and no URL param filling the field)
  if (storedRoom && !roomFromUrl) {
    const card = $("lastRoomCard");
    if (card) {
      card.classList.remove("hidden");
      const nameEl = $("lastRoomName");
      if (nameEl) nameEl.textContent = "房间 #" + storedRoom;
      card.addEventListener("click", () => {
        $("roomInput").value = storedRoom;
        if (storedName) $("nameInput").value = storedName;
        $("nameInput").focus();
      });
    }
  }

  $("joinBtn").addEventListener("click", joinRoom);
  $("copyRoomBtn").addEventListener("click", copyInviteLink);
  $("resetBtn").addEventListener("click", () => {
    clearPrivateMarksForCurrentRoom();
    markSessionId = null;
    send({ type: "reset_room" });
  });
  $("backBtn")?.addEventListener("click", leaveRoomToLobby);
  $("dealConfirmRoleBtn")?.addEventListener("click", hideDealOverlay);
  $("dealCard")?.addEventListener("click", () => {
    setDealCardFlipped(!roleCardFlipped);
  });
  $("sendChatBtn").addEventListener("click", sendChat);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  ["roomInput", "nameInput"].forEach(id => {
    $(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinRoom();
    });
  });
  $("voiceBtn").addEventListener("click", toggleVoice);
  const listenBtn = $("listenBtn");
  if (listenBtn) listenBtn.addEventListener("click", toggleListenOnly);

  // Auto-enter ONLY when URL explicitly carries ?room=xxx
  if (roomFromUrl && storedName) {
    autoEntering = true;
    $("joinView").classList.add("hidden");
    $("gameView").classList.remove("hidden");
    showTopError("正在恢复房间连接……");
    roomId = normalizeRoom(roomFromUrl);
    myName = storedName.trim().slice(0, 24) || "玩家";
    shouldReconnect = true;
    connectWebSocket();
  }
});

function joinRoom() {
  roomId = normalizeRoom($("roomInput").value || "AVALON");
  myName = ($("nameInput").value || "玩家").trim().slice(0, 24) || "玩家";
  localStorage.setItem("avalon_player_name", myName);
  localStorage.setItem("avalon_last_room", roomId);
  shouldReconnect = true;
  connectWebSocket();
}

function leaveRoomToLobby() {
  shouldReconnect = false;
  reconnecting = false;
  connectingWs = false;
  clearTimeout(reconnectTimer);
  stopHeartbeat();
  hideDealOverlay();
  try { ws?.close(); } catch (_) {}
  ws = null;
  currentPayload = null;
  latestState = null;
  localStorage.removeItem("avalon_last_room");
  $("gameView").classList.add("hidden");
  $("joinView").classList.remove("hidden");
  history.replaceState({}, "", "/");
}

function connectWebSocket() {
  if (connectingWs || (ws && ws.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  connectingWs = true;
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    try { ws.close(); } catch (_) {}
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const nextWs = new WebSocket(`${protocol}://${location.host}/ws/${roomId}`);
  ws = nextWs;
  nextWs.onopen = () => {
    connectingWs = false;
    reconnecting = false;
    reconnectAttempt = 0;
    lastWsMessageAt = Date.now();
    localStorage.setItem("avalon_player_name", myName);
    localStorage.setItem("avalon_last_room", roomId);
    nextWs.send(JSON.stringify({ type: "join", player_id: myId, name: myName, resume: true }));
    history.replaceState({}, "", `/?room=${encodeURIComponent(roomId)}`);
    $("joinView").classList.add("hidden");
    $("gameView").classList.remove("hidden");
    $("errorBox").classList.add("hidden");
    autoEntering = false;
    startHeartbeat();
  };
  nextWs.onmessage = (event) => {
    lastWsMessageAt = Date.now();
    try { handleSocketMessage(JSON.parse(event.data)); }
    catch (err) { console.warn("bad ws message", err); }
  };
  nextWs.onclose = () => {
    if (ws === nextWs) ws = null;
    connectingWs = false;
    stopHeartbeat();
    if (shouldReconnect) scheduleReconnect("连接已断开，正在自动重连……");
  };
  nextWs.onerror = () => {
    // onerror 后通常会触发 onclose。只显示提示，不在这里重复调度重连，避免多 WebSocket 风暴。
    showTopError("WebSocket 连接异常，等待自动恢复……");
  };
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      scheduleReconnect("连接已断开，正在自动重连……");
      return;
    }
    // Skip timeout check while the app is backgrounded to avoid false disconnects
    if (!appVisibilityHidden && now - lastWsMessageAt > WS_TIMEOUT_MS) {
      try { ws.close(); } catch (_) {}
      scheduleReconnect("连接超时，正在自动重连……");
      return;
    }
    send({ type: "ping", client_time: now });
  }, HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleReconnect(message) {
  if (!shouldReconnect || reconnecting) return;
  reconnecting = true;
  // Jitter ±20% to avoid thundering-herd when multiple clients reconnect at once
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(1.7, reconnectAttempt), RECONNECT_MAX_MS);
  const jitter = base * (0.8 + Math.random() * 0.4);
  reconnectAttempt += 1;
  if (reconnectAttempt <= RECONNECT_MAX_ATTEMPTS) {
    showTopError(message || "连接正在恢复……");
  }
  stopHeartbeat();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnecting = false;
    connectWebSocket();
  }, jitter);
}

function handleSocketMessage(msg) {
  if (msg.type === "server_ping") { send({ type: "client_pong", client_time: Date.now() }); return; }
  if (msg.type === "pong") { lastWsMessageAt = Date.now(); return; }
  if (msg.type === "kicked") {
    shouldReconnect = false;
    showTopError(msg.message || "你已被移出圆桌。");
    try { ws?.close(); } catch (_) {}
    return;
  }
  if (msg.type === "state") {
    currentPayload = msg;
    render(msg);
    if (voiceEnabled) refreshLiveKitAudioPermission();
    return;
  }
  if (msg.type === "error") {
    showTopError(normalizeDisplayText(msg.message || "未知错误"));
    return;
  }
  // v8 使用 LiveKit 语音房，不再处理浏览器点对点 RTC 信令。
}


let privateInfoCache = {};
let revealRolesCache = [];
let latestState = null;
let selectedTeamDraft = new Set();
let activeModalId = null;
let roleModalAutoShownForSession = null;
let roleCardFlipped = false;
let gameOverRevealShownForSession = null;
// Diff-cache: track last rendered values to skip no-op DOM updates
let _lastChatKey = "";
let _lastPlayerKey = "";
let _lastActionKey = "";
let _lastAnnouncementKey = "";
const MARKS = ["好","坏","梅","派","莫","刺"];

window.addEventListener("load", () => {
  $("openTagsBtn")?.addEventListener("click", openTagsModal);
  $("openInfoBtn")?.addEventListener("click", openInfoModal);
  $("infoMiniBtn")?.addEventListener("click", openInfoModal);
  $("openHistoryBtn")?.addEventListener("click", openHistoryModal);
  $("modalBackdrop")?.addEventListener("click", () => closeModal({ force: false }));
  document.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal({ force: true })));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal({ force: false }); });

  // ── Page Visibility: pause WS timeout while app is backgrounded ──
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      appVisibilityHidden = true;
      // Freeze the "last seen" clock so we don't false-trigger timeout
      lastWsMessageAt = Date.now();
    } else {
      appVisibilityHidden = false;
      lastWsMessageAt = Date.now();
      // If WS dropped while hidden, reconnect immediately
      if (shouldReconnect && (!ws || ws.readyState !== WebSocket.OPEN)) {
        reconnecting = false;
        clearTimeout(reconnectTimer);
        connectWebSocket();
      }
    }
  });
});

function render(payload) {
  const state = payload.state;
  latestState = state;
  const signal = state.control_signal || {};
  const perms = state.permissions || {};
  syncMarkSession(state);

  $("roomCode").textContent = payload.room_id;
  $("phaseTitle").textContent = compactPhaseName(state.current_phase, signal.round);
  renderScore(signal.game_score || {good:0, evil:0});
  const annHtml = buildAnnouncementHTML(state);
  if (annHtml !== _lastAnnouncementKey) {
    _lastAnnouncementKey = annHtml;
    $("announcementText").innerHTML = annHtml;
  }
  applyPhaseMicroInteractions(state, signal);
  $("permissionText").textContent = permissionSummary(perms, state.current_phase);
  $("chatStatusText").textContent = perms.can_chat ? "可打字" : "暂不可打字";
  $("chatOpenText").textContent = perms.can_chat ? "可打字" : "暂不可打字";
  $("chatOpenText").classList.toggle("disabled", !perms.can_chat);
  $("actionPanel")?.classList.toggle("needs-action", hasPrimaryAction(perms));

  if (state.error_message) showTopError(normalizeDisplayText(state.error_message));
  else $("errorBox").classList.add("hidden");

  $("resetBtn").classList.toggle("hidden", !(payload.you?.is_host));
  renderPlayers(state.players || [], signal, payload.you || {});
  renderPrivateInfo(state.private_info || {}, state.reveal_roles || []);
  renderActions(payload);
  renderHistory(state);
  renderChat(payload.chat_history || [], perms.can_chat);
  if (activeModalId === "infoModal") renderInfoModal();
  if (activeModalId === "tagsModal") renderTagsModal();
  if (activeModalId === "historyModal") renderHistoryModal();
  if (activeModalId === "teamModal") renderTeamModal();
  maybeAutoOpenRoleModal(state);
  maybeAutoOpenRevealModal(state);

  if (voiceEnabled) refreshLiveKitAudioPermission();
  lastMicStatus = signal.mic_status;
  lastPersonalAudioAllowed = !!signal.personal_audio_allowed;
}

function buildAnnouncementHTML(state) {
  const count = (state.players || []).length;
  if (state.current_phase === "LOBBY") {
    const cls = count >= 5 ? "seat-ready" : "seat-wait";
    return `<span class="seat-light ${cls}"></span>当前 <span class="${cls}">${count}/10</span> 名玩家入座。`;
  }
  return formatAnnouncementHTML(state.public_announcement || "等待法官公告。");
}

function hasPrimaryAction(perms) {
  return !!(
    perms.can_start_game ||
    perms.can_finish_speaker ||
    perms.host_can_force_speaker ||
    perms.can_end_free_discussion ||
    perms.can_select_team ||
    perms.can_submit_team_vote ||
    perms.can_submit_mission_vote ||
    perms.can_continue_after_result ||
    perms.can_submit_assassin_target
  );
}

function renderScore(score) {
  const el = $("scoreText");
  const newHtml = `<span class="good-score">正义 ${score.good ?? 0}</span> : <span class="evil-score">邪恶 ${score.evil ?? 0}</span>`;
  if (el.innerHTML !== newHtml) {
    el.innerHTML = newHtml;
    el.classList.remove("score-flash");
    void el.offsetWidth;
    el.classList.add("score-flash");
  }
}

function renderPlayers(players, signal, you) {
  $("playerCountText").textContent = `${players.length}/10`;
  const oddWrap = $("oddPlayersList") || $("playersList");
  const evenWrap = $("evenPlayersList") || $("playersList");

  // Build fingerprint to skip full re-render when nothing changed
  const marks = getPrivateMarks();
  const active = signal.active_speaker_id;
  const teamIds = new Set(signal.current_team_ids || []);
  const onlyMicSeat = onlyMicSeatFromStatus(signal.mic_status, players);
  const bySeat = new Map(players.map(p => [Number(p.seat), p]));
  const canKick = currentPayload?.state?.permissions?.can_kick;

  const playerKey = players.map(p => {
    const isSpeaking = p.is_speaking || p.id === active || (onlyMicSeat && p.seat === onlyMicSeat);
    return `${p.id}:${p.name}:${p.connected}:${p.is_host}:${p.is_ready}:${p.id === signal.leader_id}:${isSpeaking}:${teamIds.has(p.id)}:${marks[p.id] || ""}`;
  }).join("|") + "|" + signal.leader_id + "|" + you.id + "|" + (latestState?.current_phase || "") + "|" + (canKick ? "k" : "");
  if (playerKey === _lastPlayerKey) return;
  _lastPlayerKey = playerKey;

  if (oddWrap) oddWrap.innerHTML = "";
  if (evenWrap && evenWrap !== oddWrap) evenWrap.innerHTML = "";
  for (let seat = 1; seat <= 10; seat++) {
    const p = bySeat.get(seat);
    const card = document.createElement("article");
    const target = seat % 2 === 1 ? oddWrap : evenWrap;
    if (!p) {
      card.className = "seat-card empty-seat";
      card.innerHTML = `<div class="seat-top"><div class="seat-num">${seat}</div></div><div class="seat-main"><div class="seat-name">${seat}号-等待加入</div><div class="seat-tags"><span class="tag offline">空位</span></div></div>`;
      target.appendChild(card);
      continue;
    }
    const isSelf = p.id === you.id;
    const isLeader = p.id === signal.leader_id && latestState?.current_phase !== "LOBBY";
    const isSpeaking = p.is_speaking || p.id === active || (onlyMicSeat && p.seat === onlyMicSeat);
    const classes = ["seat-card"];
    if (isSelf) classes.push("self");
    if (isLeader) classes.push("leader");
    if (isSpeaking) classes.push("speaking");
    if (!p.connected) classes.push("offline");
    card.className = classes.join(" ");
    card.dataset.playerId = p.id;
    if (isSelf) card.title = "点击查看身份牌";
    // Set marks as data-attribute for CSS ::before corner badge
    if (marks[p.id]) card.setAttribute("data-marks", marks[p.id]);
    else card.removeAttribute("data-marks");
    const tags = [];
    if (isSelf) tags.push(`<span class="tag self">自己</span>`);
    if (p.is_host) tags.push(`<span class="tag host">房主</span>`);
    if (latestState?.current_phase === "LOBBY" && !p.is_host) tags.push(`<span class="tag ${p.is_ready ? 'ready' : 'not-ready'}">${p.is_ready ? '已准备' : '未准备'}</span>`);
    if (isLeader) tags.push(`<span class="tag leader">队长</span>`);
    if (teamIds.has(p.id)) tags.push(`<span class="tag team">出征</span>`);
    if (p.id === active) tags.push(`<span class="tag self">发言中</span>`);
    if (!p.connected) tags.push(`<span class="tag offline">离线</span>`);
    const canKick = currentPayload?.state?.permissions?.can_kick && p.id !== you.id;
    card.innerHTML = `<div class="seat-top"><div class="seat-num">${seat}</div>${isSpeaking ? `<div class="mic-indicator">🎙</div>` : ""}</div><div class="seat-main"><div class="seat-name">${escapeHtml(p.name || "玩家")}</div><div class="seat-tags">${tags.join("")}${canKick ? `<button class="kick-btn" data-kick="${escapeHtml(p.id)}">踢</button>` : ""}</div></div>`;
    card.addEventListener("click", (e) => {
      if (e.target?.dataset?.kick) return;
      if (isSelf) openIdentityOverlay();
      else openTagsModal();
    });
    const kickBtn = card.querySelector("[data-kick]");
    if (kickBtn) kickBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`确认把 ${displayPlayer(p)} 移出房间？`)) send({ type: "kick_player", target: p.id });
    });
    target.appendChild(card);
  }
}

function renderPrivateInfo(info, revealRoles) {
  privateInfoCache = info || {};
  revealRolesCache = revealRoles || [];
  $("identityHint").textContent = privateInfoCache?.role ? "ⓘ 点击自己的席位可直接查看身份" : "ⓘ 游戏开始后可点击自己的席位查看身份牌";
  renderRoleModal();
}

function renderActions(payload) {
  const state = payload.state;
  const perms = state.permissions || {};
  const signal = state.control_signal || {};
  const area = $("actionArea");
  // Lightweight key: if permissions + phase haven't changed, skip re-render
  const actionKey = state.current_phase + "|" + JSON.stringify(perms) + "|" + (signal.leader_id || "") + "|" + (signal.required_team_size || "") + "|" + (signal.current_team_ids || []).join(",");
  if (actionKey === _lastActionKey && !area.__forceRefresh) return;
  _lastActionKey = actionKey;
  area.__forceRefresh = false;
  area.innerHTML = "";

  if (state.current_phase === "LOBBY") {
    const readyCount = perms.ready_count ?? signal.ready_count ?? 0;
    const readyRequired = perms.ready_required ?? signal.ready_required ?? Math.max(0, (state.players || []).length - 1);
    if (perms.can_start_game) {
      area.innerHTML = `<p>全员已准备，可以开始本局。</p>`;
      area.appendChild(button("全员已准备，开始游戏", "btn btn-gold", () => {
        clearPrivateMarksForCurrentRoom();
        send({ type: "start_game" });
      }));
    } else if (perms.is_host) {
      const count = (state.players || []).length;
      const reason = count < 5 ? `人数不足，当前 ${count}/10。` : `等待其他玩家准备 (${readyCount}/${readyRequired})。`;
      area.innerHTML = `<p>${escapeHtml(reason)}</p>`;
      const b = button(count < 5 ? "等待更多玩家" : `等待其他玩家准备 (${readyCount}/${readyRequired})`, "btn btn-secondary", () => {});
      b.disabled = true;
      area.appendChild(b);
    } else if (perms.can_toggle_ready) {
      const isReady = !!perms.is_ready;
      area.innerHTML = `<p>${isReady ? "你已准备，等待房主开始。" : "准备好后点击按钮，房主才能开局。"}</p>`;
      area.appendChild(button(isReady ? "取消准备" : "我已准备", isReady ? "btn btn-secondary" : "btn btn-primary", () => send({ type: "toggle_ready" })));
    } else {
      area.innerHTML = `<p>等待房主与其他玩家准备。</p>`;
    }
    return;
  }

  if (perms.can_finish_speaker || perms.host_can_force_speaker) {
    const row = document.createElement("div");
    row.className = "button-row";
    if (perms.can_finish_speaker) row.appendChild(button("我的发言完毕", "btn btn-primary", () => send({ type: "speaker_finished" })));
    if (perms.host_can_force_speaker) row.appendChild(button("强制切换发言", "btn btn-secondary", () => send({ type: "speaker_finished", force: true })));
    area.appendChild(row);
    return;
  }

  if (state.current_phase?.includes("PRE_TEAM_DISCUSSION_ORDERED") || state.current_phase?.includes("DISCUSSION_ORDERED")) {
    area.innerHTML = `<p>当前发言人：<span class="kv">${escapeHtml(labelToDisplay(signal.active_speaker_id, signal.active_speaker) || "-")}</span>。其他玩家可在文字公屏打字。</p>`;
    return;
  }

  if (perms.can_end_free_discussion) {
    area.innerHTML = `<p>公共麦克风讨论中。你是队长，可以结束讨论后进入选人。</p>`;
    area.appendChild(button("结束讨论并选人", "btn btn-primary", () => send({ type: "finish_free_discussion" })));
    return;
  }

  if (state.current_phase?.includes("PRE_TEAM_DISCUSSION_FREE") || state.current_phase?.includes("DISCUSSION_FREE")) {
    area.innerHTML = `<p>自由讨论中。所有玩家可以开麦与打字，等待队长结束后选人。</p>`;
    return;
  }

  if (perms.can_select_team) {
    area.innerHTML = `<p>队长请选择要上车的玩家（需要 ${signal.required_team_size} 人）。</p>`;
    area.appendChild(button("选择出征队伍", "btn btn-primary", openTeamModal));
    return;
  }

  if (state.current_phase?.includes("TEAM_PROPOSAL")) {
    area.innerHTML = `<p>等待队长 <span class="kv">${escapeHtml(labelToDisplay(signal.leader_id, signal.leader) || "-")}</span> 选择队伍。此阶段麦克风开放。</p>`;
    return;
  }

  if (perms.can_submit_team_vote) {
    area.appendChild(teamSummaryBlock(signal, "本次投票队伍"));
    const row = document.createElement("div");
    row.className = "button-row";
    row.appendChild(button("👍 赞成", "btn btn-good", () => send({ type: "team_vote", vote: "Approve" })));
    row.appendChild(button("👎 反对", "btn btn-bad", () => send({ type: "team_vote", vote: "Reject" })));
    area.appendChild(row);
    return;
  }

  if (state.current_phase?.includes("TEAM_VOTE")) {
    area.appendChild(teamSummaryBlock(signal, "本次投票队伍"));
    area.insertAdjacentHTML("beforeend", `<p>全员投票中。投票阶段禁麦，但文字公屏开放。</p>`);
    return;
  }

  if (perms.can_submit_mission_vote) {
    area.appendChild(teamSummaryBlock(signal, "本次任务队伍"));
    const row = document.createElement("div");
    row.className = "button-row";
    row.appendChild(button("任务成功", "btn btn-good", () => send({ type: "mission_vote", vote: "Success" })));
    row.appendChild(button("任务失败", "btn btn-bad", () => send({ type: "mission_vote", vote: "Fail" })));
    area.appendChild(row);
    return;
  }

  if (state.current_phase?.includes("MISSION_VOTE")) {
    area.appendChild(teamSummaryBlock(signal, "本次任务队伍"));
    area.insertAdjacentHTML("beforeend", `<p>等待出征队员提交秘密任务票。此阶段可打字。</p>`);
    return;
  }

  if (perms.can_continue_after_result) {
    area.innerHTML = `<p>任务结果复盘中。队长可以结束复盘并进入下一轮。</p>`;
    area.appendChild(button("进入下一轮", "btn btn-primary", () => send({ type: "continue_after_result" })));
    return;
  }

  if (state.current_phase?.includes("MISSION_RESULT_DISCUSSION")) {
    area.innerHTML = `<p>任务结果复盘中。所有玩家可以开麦与打字。</p>`;
    return;
  }

  if (perms.can_submit_assassin_target) {
    area.innerHTML = `<p>你是刺客。请选择一名玩家进行终局刺杀。</p>`;
    area.appendChild(button("选择刺杀目标", "btn btn-danger", openAssassinModal));
    return;
  }

  if (state.current_phase === "GAME_OVER") {
    renderGameOverAction(area, state);
    return;
  }

  area.innerHTML = `<p>等待当前阶段完成。</p>`;
}

function renderGameOverAction(area, state) {
  const winner = state.winner === "good" ? "正义阵营获胜" : state.winner === "evil" ? "邪恶阵营获胜" : "游戏结束";
  area.innerHTML = `<div class="result-screen compact-result"><div class="result-banner"><h2>${winner}</h2><p>身份已公开。可以继续开麦复盘，或由房主重置房间。</p></div></div>`;
}

function renderHistory(state) {
  renderHistoryModal();
}

function renderChat(messages, canChat) {
  const preview = $("chatMessages");
  const visibleMessages = messages.slice(-80);
  // Build a lightweight fingerprint; only re-render DOM when content changed
  const chatKey = (visibleMessages.length ? visibleMessages[visibleMessages.length - 1]?.time : "") + "|" + visibleMessages.length + "|" + canChat;
  const inputEl = $("chatInput");
  const sendEl = $("sendChatBtn");
  inputEl.disabled = !canChat;
  sendEl.disabled = !canChat;
  inputEl.placeholder = canChat ? "输入消息…" : "暂不可打字";
  if (chatKey === _lastChatKey) return;  // no change, skip re-render
  _lastChatKey = chatKey;
  preview.innerHTML = "";
  if (!visibleMessages.length) {
    preview.innerHTML = `<div class="line muted">暂无文字消息。</div>`;
  } else {
    const frag = document.createDocumentFragment();
    for (const m of visibleMessages) {
      const div = document.createElement("div");
      div.className = "line";
      if (m.type === "system") div.innerHTML = `<span class="chat-system-preview">系统：</span>${escapeHtml(m.text)}`;
      else div.innerHTML = `<span class="chat-name ${m.seat===2?'hostline':''}">${escapeHtml(`${m.seat}号-${m.name}`)}：</span>${escapeHtml(m.text)}`;
      frag.appendChild(div);
    }
    preview.appendChild(frag);
  }
  preview.scrollTop = preview.scrollHeight;
}

function teamSummaryBlock(signal, title) {
  const div = document.createElement("div");
  div.className = "team-summary";
  const names = (signal.current_team_ids || []).map(id => labelToDisplay(id, id));
  div.innerHTML = `<span class="kv">${escapeHtml(title)}：</span>${names.length ? names.map(n => `<span class="team-chip">${escapeHtml(n)}</span>`).join("") : "-"}`;
  return div;
}

function openModal(id) {
  // Close any existing sheet without animation (switching modals)
  document.querySelectorAll(".modal-sheet:not(.hidden)").forEach(m => {
    m.classList.add("hidden");
    m.classList.remove("modal-exiting");
  });
  activeModalId = id;
  $("modalBackdrop").classList.remove("hidden");
  const el = $(id);
  if (!el) return;
  el.classList.remove("hidden", "modal-exiting");
  // Force reflow so the CSS transition triggers from the hidden state
  void el.offsetWidth;
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.remove("active"));
  if (id === "tagsModal")   $("openTagsBtn")?.classList.add("active");
  if (id === "infoModal")   $("openInfoBtn")?.classList.add("active");
  if (id === "historyModal") $("openHistoryBtn")?.classList.add("active");
}

function closeModal(opts = {}) {
  // GAME_OVER reveal: only allow explicit close, block backdrop / ESC
  const isReveal = activeModalId === "roleModal" && latestState?.current_phase === "GAME_OVER";
  if (isReveal && !opts.force) return;

  const closingId = activeModalId;
  activeModalId = null;

  // Animate backdrop out
  const backdrop = $("modalBackdrop");
  backdrop.classList.add("hidden");

  // Animate sheet out (exit class), then truly hide
  document.querySelectorAll(".modal-sheet:not(.hidden)").forEach(m => {
    m.classList.add("modal-exiting");
    const done = () => {
      m.classList.add("hidden");
      m.classList.remove("modal-exiting");
    };
    // Fallback: always hide after 300ms even if transitionend misfires
    const timer = setTimeout(done, 280);
    m.addEventListener("transitionend", () => { clearTimeout(timer); done(); }, { once: true });
  });

  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.remove("active"));

  if (!isReveal && latestState?.current_phase === "GAME_OVER") {
    maybeAutoOpenRevealModal(latestState);
  } else if (!isReveal) {
    maybeAutoOpenRoleModal(latestState || {});
  }
}
function openRoleModal(options = {}) {
  roleCardFlipped = !!options.showBack;
  renderRoleModal();
  openModal("roleModal");
}
function openInfoModal(){ renderInfoModal(); openModal("infoModal"); }
function openTagsModal(){ renderTagsModal(); openModal("tagsModal"); }
function openHistoryModal(){ renderHistoryModal(); openModal("historyModal"); }
function openTeamModal(){ selectedTeamDraft = new Set(latestState?.control_signal?.current_team_ids || []); renderTeamModal(); openModal("teamModal"); }
function openAssassinModal(){ renderAssassinModal(); openModal("assassinModal"); }

function renderRoleModal() {
  const body = $("roleModalBody");
  if (!body) return;
  const info = privateInfoCache || {};
  const reveals = revealRolesCache || [];
  if (reveals.length) {
    body.innerHTML = `<h2 class="modal-title">终局身份公开</h2><div class="reveal-grid">${reveals.map(r => `<div class="reveal-card ${r.side === 'good' ? 'good' : 'evil'}"><strong>${escapeHtml(displayPlayer(r))}</strong><br><span class="${r.side === 'good' ? 'info-good' : 'info-evil'}">${escapeHtml(r.role)} · ${r.side === 'good' ? '正义阵营' : '邪恶阵营'}</span></div>`).join("")}</div>`;
    return;
  }
  if (!info.role) {
    body.innerHTML = `<div class="role-card-front"><div><div class="role-mask">◩</div><div class="role-front-title">身份牌</div><div class="role-front-hint">游戏开始后可以查看身份牌。</div></div></div>`;
    return;
  }
  body.innerHTML = `
    <div id="roleFront" class="role-card-front ${roleCardFlipped ? 'hidden' : ''}" role="button" tabindex="0">
      <div><div class="role-mask">◩</div><div class="role-front-title">身份牌</div><div class="role-front-hint">点击卡牌查看你的身份</div></div>
    </div>
    <div id="roleBack" class="role-back-content ${roleCardFlipped ? '' : 'hidden'}">
      <div class="role-revealed-head">
        <div class="role-emblem">${info.side === 'good' ? '🛡️' : '🗡️'}</div>
        <div class="role-name ${info.side === 'good' ? 'info-good' : 'info-evil'}">${escapeHtml(info.role)}</div>
        <span class="role-side">${info.side === 'good' ? '正义阵营' : '邪恶阵营'}</span>
      </div>
      <div class="role-details">
        <div class="role-detail-row"><span class="label">角色</span><span>${escapeHtml(roleIntro(info.role))}</span></div>
        <div class="role-detail-row"><span class="label">说明</span><span>${escapeHtml(info.role_message || '')}</span></div>
        <div class="role-detail-row"><span class="label">夜晚视野</span><span>${escapeHtml(info.visibility_note || '无额外夜晚视野。')}</span></div>
        <div class="role-detail-row"><span class="label">已知信息</span><span>${(info.visible_players || []).length ? (info.visible_players || []).map(p => escapeHtml(p.display || displayPlayer(p))).join('、') : '暂无额外可见玩家。'}</span></div>
        <button id="coverRoleBtn" class="cover-role-btn" type="button">重新盖上身份牌</button>
      </div>
    </div>`;
  const front = $("roleFront");
  const back = $("roleBack");
  front?.addEventListener("click", () => {
    roleCardFlipped = true;
    front.classList.add("flip-out");
    setTimeout(() => {
      front.classList.add("hidden");
      back?.classList.remove("hidden");
      back?.classList.add("flip-in");
    }, 180);
  });
  $("coverRoleBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    roleCardFlipped = false;
    back?.classList.add("hidden");
    front?.classList.remove("hidden", "flip-out");
    back?.classList.remove("flip-in");
  });
  // GAME_OVER reveal: change close button to explicit "我看清楚了" label
  if (latestState?.current_phase === "GAME_OVER" && (revealRolesCache || []).length) {
    const closeBtn = $("roleModal")?.querySelector(".modal-close");
    if (closeBtn) {
      closeBtn.textContent = "我看清楚了 ✓";
      closeBtn.style.cssText = "width:auto;padding:0 14px;font-size:13px;font-weight:900;color:#b2f0c8;border-color:rgba(82,200,122,.35);background:rgba(82,200,122,.1);";
    }
  }
}

function maybeAutoOpenRoleModal(state) {
  if (!privateInfoCache?.role || !markSessionId) return;
  if (roleModalAutoShownForSession === markSessionId) return;
  if (activeModalId) return;
  roleModalAutoShownForSession = markSessionId;
  roleCardFlipped = false;
  showDealOverlay({ auto: true, flipped: false });
}

function openIdentityOverlay() {
  if (!privateInfoCache?.role) {
    showTopError("游戏开始后可以查看身份牌。");
    showDealOverlay({ manual: true, flipped: false });
    return;
  }
  roleCardFlipped = false;
  showDealOverlay({ manual: true, flipped: false });
}

function maybeAutoOpenRevealModal(state) {
  const reveals = state.reveal_roles || [];
  if (state.current_phase !== "GAME_OVER" || !reveals.length || !markSessionId) return;
  if (gameOverRevealShownForSession === markSessionId) return;
  if (activeModalId && activeModalId !== "roleModal") return;
  gameOverRevealShownForSession = markSessionId;
  roleCardFlipped = true;
  openRoleModal({ showBack: true });
}

function roleIntro(role) {
  if (!role) return "你的私密角色。";
  const map = {"忠臣":"忠诚的臣子，与正义阵营共同找出邪恶势力。","梅林":"掌握部分邪恶信息，但必须隐藏自己。","派西维尔":"可以看见梅林与莫甘娜，但无法分辨。","莫甘娜":"伪装成梅林，迷惑派西维尔。","刺客":"终局可刺杀梅林，帮助邪恶翻盘。","莫德雷德":"邪恶核心，梅林无法看见你。","奥伯伦":"邪恶阵营，但其他坏人也不知道你。"};
  return map[role] || "根据身份目标推动阵营获胜。";
}

function renderInfoModal() {
  const body = $("infoModalBody");
  if (!body || !latestState) return;
  const s = latestState;
  const signal = s.control_signal || {};
  const n = (s.players || []).length;
  const cfg = gameConfig(n);
  const leader = labelToDisplay(signal.leader_id, signal.leader) || "-";
  const team = (signal.current_team_ids || []).map(id => labelToDisplay(id, id)).join("、") || "尚未选择";
  body.innerHTML = `<div class="info-table">
    <div class="info-row"><span class="info-label">本局人数</span><span class="info-value">${n || '-'} 人</span></div>
    <div class="info-row"><span class="info-label">好人阵营</span><span class="info-value info-good">${escapeHtml((cfg.goodRoles || []).join(' · ') || '未开局')}</span></div>
    <div class="info-row"><span class="info-label">坏人阵营</span><span class="info-value info-evil">${escapeHtml((cfg.evilRoles || []).join(' · ') || '未开局')}</span></div>
    <div class="info-row"><span class="info-label">角色构成</span><span class="info-value"><span class="info-good">好人 ${cfg.goodCount ?? '-'}</span>　<span class="info-evil">坏人 ${cfg.evilCount ?? '-'}</span></span></div>
    <div class="info-row"><span class="info-label">任务配置</span><span class="info-value">${(cfg.missions || []).join(' - ') || '-'}</span></div>
    <div class="info-row"><span class="info-label">特殊规则</span><span class="info-value">${n >= 7 ? '第4轮双失败规则' : '无双失败轮'}</span></div>
    <div class="info-row"><span class="info-label">当前轮次</span><span class="info-value info-good">${signal.round ? `第 ${signal.round} 轮` : '大厅'}</span></div>
    <div class="info-row"><span class="info-label">当前队长</span><span class="info-value" style="color:var(--gold)">${escapeHtml(leader)}</span></div>
    <div class="info-row"><span class="info-label">当前队伍</span><span class="info-value">${escapeHtml(team)}</span></div>
    <div class="info-row"><span class="info-label">失败提案次数</span><span class="info-value info-evil">${signal.failed_proposals || 0} 次</span></div>
  </div><p class="modal-subtitle" style="margin-top:14px">所有玩家身份仍然隐藏，只展示本局配置。</p>`;
}

function gameConfig(n) {
  const map = {
    5:{goodCount:3, evilCount:2, goodRoles:['梅林','派西维尔','忠臣'], evilRoles:['莫甘娜','刺客'], missions:[2,3,2,3,3]},
    6:{goodCount:4, evilCount:2, goodRoles:['梅林','派西维尔','忠臣×2'], evilRoles:['莫甘娜','刺客'], missions:[2,3,4,3,4]},
    7:{goodCount:4, evilCount:3, goodRoles:['梅林','派西维尔','忠臣×2'], evilRoles:['莫甘娜','刺客','奥伯伦'], missions:[2,3,3,4,4]},
    8:{goodCount:5, evilCount:3, goodRoles:['梅林','派西维尔','忠臣×3'], evilRoles:['莫甘娜','刺客','莫德雷德'], missions:[3,4,4,5,5]},
    9:{goodCount:6, evilCount:3, goodRoles:['梅林','派西维尔','忠臣×4'], evilRoles:['莫甘娜','刺客','莫德雷德'], missions:[3,4,4,5,5]},
    10:{goodCount:6, evilCount:4, goodRoles:['梅林','派西维尔','忠臣×4'], evilRoles:['莫甘娜','刺客','莫德雷德','奥伯伦'], missions:[3,4,4,5,5]},
  };
  return map[n] || {goodRoles:[],evilRoles:[],missions:[]};
}

function getPrivateMarks() {
  try { return JSON.parse(localStorage.getItem(markStorageKey()) || "{}"); } catch (_) { return {}; }
}
function setPrivateMark(pid, value) {
  const marks = getPrivateMarks();
  if (!value) delete marks[pid]; else marks[pid] = value;
  localStorage.setItem(markStorageKey(), JSON.stringify(marks));
  renderTagsModal();
  if (currentPayload) renderPlayers(currentPayload.state.players || [], currentPayload.state.control_signal || {}, currentPayload.you || {});
}
function markStorageKey(){
  const active = latestState?.current_phase && latestState.current_phase !== "LOBBY";
  const score = latestState?.control_signal?.game_score || {};
  const roleState = privateInfoCache?.role ? "role" : "norole";
  const fallback = `${active ? "active" : "lobby"}_${latestState?.control_signal?.round || 0}_${score.good || 0}-${score.evil || 0}_${roleState}`;
  return `avalon_v12_private_marks_${roomId || "local"}_${myId}_${markSessionId || fallback}`;
}

function syncMarkSession(state) {
  const signal = state.control_signal || {};
  const score = `${signal.game_score?.good ?? 0}:${signal.game_score?.evil ?? 0}`;
  const phase = state.current_phase || "LOBBY";
  const hasRole = !!state.private_info?.role;
  const returnedToLobby = phase === "LOBBY" && previousMarkSnapshot.phase && previousMarkSnapshot.phase !== "LOBBY";
  const roleCleared = previousMarkSnapshot.hadRole && !hasRole;
  const scoreReset = score === "0:0" && previousMarkSnapshot.score !== "0:0" && (phase === "LOBBY" || !hasRole);

  if (returnedToLobby || roleCleared || scoreReset) {
    clearPrivateMarksForCurrentRoom();
    markSessionId = null;
  }

  if (phase === "LOBBY") {
    clearLegacyPrivateMarks();
    markSessionId = null;
  } else if (!markSessionId) {
    const stored = localStorage.getItem(markSessionPointerKey());
    markSessionId = stored || `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(markSessionPointerKey(), markSessionId);
  }

  previousMarkSnapshot = { phase, hadRole: hasRole, score };
}

function markSessionPointerKey() {
  return `avalon_v12_mark_session_${roomId || "local"}_${myId}`;
}

function clearPrivateMarksForCurrentRoom() {
  const prefix = `avalon_v12_private_marks_${roomId || "local"}_${myId}_`;
  const legacyPrefix = `avalon_private_marks_${roomId || "local"}`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix) || key?.startsWith(legacyPrefix)) localStorage.removeItem(key);
  }
  localStorage.removeItem(markSessionPointerKey());
}

function clearLegacyPrivateMarks() {
  const legacyPrefix = `avalon_private_marks_${roomId || "local"}`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(legacyPrefix)) localStorage.removeItem(key);
  }
}

function renderTagsModal() {
  const body = $("tagsModalBody");
  if (!body || !latestState) return;
  const players = latestState.players || [];
  const marks = getPrivateMarks();
  body.innerHTML = `<div class="tags-legend"><span>● 好人倾向</span><span>● 坏人倾向</span><span>梅=梅林</span><span>派=派西维尔</span><span>莫=莫德雷德</span><span>刺=刺客</span></div><div class="tags-list"></div>`;
  const list = body.querySelector(".tags-list");
  for (const p of players) {
    const row = document.createElement("div");
    row.className = "tag-row";
    const selected = marks[p.id];
    row.innerHTML = `<div class="tag-player"><span class="seat-num">${p.seat}</span><strong>${escapeHtml(displayPlayer(p))}</strong></div><div class="tag-buttons"></div>`;
    const btns = row.querySelector(".tag-buttons");
    for (const m of MARKS) {
      const b = document.createElement("button");
      b.className = `mark-btn ${selected === m ? 'selected ' + (m==='好'?'good':m==='坏'?'bad':'role') : ''}`;
      b.textContent = m;
      b.addEventListener("click", () => setPrivateMark(p.id, m));
      btns.appendChild(b);
    }
    const clear = document.createElement("button");
    clear.className = "mark-btn";
    clear.textContent = "清空";
    clear.addEventListener("click", () => setPrivateMark(p.id, ""));
    btns.appendChild(clear);
    list.appendChild(row);
  }
  if (!players.length) body.innerHTML = `<p class="muted">暂无玩家。</p>`;
}

function renderTeamModal() {
  const body = $("teamModalBody");
  if (!body || !latestState) return;
  const players = latestState.players || [];
  const required = latestState.control_signal?.required_team_size || 0;
  body.innerHTML = `<p class="selection-progress">已选 ${selectedTeamDraft.size} / 需要 ${required}</p><div class="select-grid"></div><p class="modal-subtitle" style="margin-top:14px">必须选择 ${required} 人。</p>`;
  const grid = body.querySelector(".select-grid");
  for (const p of players) {
    const selected = selectedTeamDraft.has(p.id);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `select-card ${selected ? 'selected' : ''}`;
    card.innerHTML = `<span class="seat-num">${p.seat}</span><strong>${escapeHtml(displayPlayer(p))}</strong>${selected ? '<span class="check-mark">✓</span>' : ''}`;
    card.addEventListener("click", () => {
      if (selectedTeamDraft.has(p.id)) selectedTeamDraft.delete(p.id);
      else selectedTeamDraft.add(p.id);
      renderTeamModal();
    });
    grid.appendChild(card);
  }
  const submit = document.createElement("button");
  submit.className = "btn btn-primary btn-full";
  submit.textContent = "确认队伍";
  submit.disabled = selectedTeamDraft.size !== required;
  submit.addEventListener("click", () => { send({ type: "select_team", team: [...selectedTeamDraft] }); closeModal(); });
  body.appendChild(submit);
}

function renderAssassinModal() {
  const body = $("assassinModalBody");
  if (!body || !latestState) return;
  const players = latestState.players || [];
  body.innerHTML = `<div class="select-grid assassin-grid"></div>`;
  const grid = body.querySelector(".select-grid");
  for (const p of players) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "select-card danger-select";
    card.innerHTML = `<span class="seat-num">${p.seat}</span><strong>${escapeHtml(displayPlayer(p))}</strong>`;
    card.addEventListener("click", () => {
      send({ type: "assassin_target", target: p.id });
      closeModal();
    });
    grid.appendChild(card);
  }
}

function renderHistoryModal() {
  const area = $("historyArea");
  if (!area || !latestState) return;
  const missions = latestState.mission_result_history || [];
  const teams = latestState.team_vote_history || [];
  if (!missions.length && !teams.length) { area.innerHTML = `<p class="muted">暂无公开历史。</p>`; return; }
  const rounds = new Map();
  for (const t of teams) {
    const r = rounds.get(t.round) || { round: t.round, teams: [], missions: [] };
    r.teams.push(t);
    rounds.set(t.round, r);
  }
  for (const m of missions) {
    const r = rounds.get(m.round) || { round: m.round, teams: [], missions: [] };
    r.missions.push(m);
    rounds.set(m.round, r);
  }
  const rows = [...rounds.values()].sort((a, b) => a.round - b.round).map(r => {
    const teamLines = r.teams.map(t => `
      <div class="paper-line"><span class="paper-label">队伍</span>${escapeHtml((t.team || []).map(normalizeDisplayText).join("、") || "-")}</div>
      <div class="paper-line"><span class="paper-label">组队</span>${t.approved ? "通过" : "失败"}，赞成 ${t.approves} / 反对 ${t.rejects}</div>
    `).join("");
    const missionLines = r.missions.map(m => {
      const successCount = m.success_count ?? Math.max(0, (m.team || []).length - (m.fail_count || 0));
      return `
        <div class="paper-line"><span class="paper-label">任务</span>${m.result || ""}，赞成 ${successCount} / 反对 ${m.fail_count || 0}</div>
      `;
    }).join("");
    return `<article class="history-paper"><h3>Round ${r.round}</h3>${teamLines || '<div class="paper-line muted">暂无组队记录</div>'}${missionLines || ''}</article>`;
  });
  area.innerHTML = `<div class="history-paper-stack">${rows.join("")}</div>`;
}

function showDealOverlay(options = {}) {
  const overlay = $("dealOverlay");
  if (!overlay) return;
  dealOverlayShownForSession = markSessionId;
  roleCardFlipped = !!options.flipped;
  overlay.classList.remove("hidden");
  buildFlyingCards();
  renderDealIdentityCard();
  // v14.2: no countdown. The card stays covered until the player chooses to flip it.
  dealOverlayStart = Date.now();
  clearTimeout(dealOverlayTimer);
  dealOverlayTimer = null;
}

function hideDealOverlay() {
  const overlay = $("dealOverlay");
  if (!overlay) return;
  setDealCardFlipped(false);
  overlay.classList.add("hidden");
  clearTimeout(dealOverlayTimer);
  dealOverlayTimer = null;
}

function setDealCardFlipped(flipped) {
  const card = $("dealCard");
  const info = privateInfoCache || {};
  if (flipped && !info.role) {
    showTopError("游戏开始后可以查看身份牌。");
    return;
  }
  roleCardFlipped = !!flipped;
  renderDealIdentityCard();
  card?.classList.toggle("flipped", roleCardFlipped);
}

function renderDealIdentityCard() {
  const card = $("dealCard");
  const inner = $("dealCardInner");
  const back = $("dealCardBack");
  const confirmBtn = $("dealConfirmRoleBtn");
  if (!card || !inner || !back) return;
  const info = privateInfoCache || {};
  card.classList.toggle("flipped", roleCardFlipped);
  card.classList.toggle("has-role", !!info.role);
  if (confirmBtn) {
    confirmBtn.textContent = "我已确认";
    confirmBtn.disabled = !roleCardFlipped;
  }
  if (!info.role) {
    back.innerHTML = `<div class="deal-role-empty"><strong>身份尚未发放</strong><span>游戏开始后可以查看身份牌。</span></div>`;
    return;
  }
  const sideName = info.side === "good" ? "正义阵营" : "邪恶阵营";
  const known = (info.visible_players || []).length
    ? (info.visible_players || []).map(p => escapeHtml(p.display || displayPlayer(p))).join("、")
    : "暂无额外可见玩家。";
  back.innerHTML = `
    <div class="deal-role-card ${info.side === "good" ? "good" : "evil"}">
      <div class="deal-role-emblem">${info.side === "good" ? "🛡️" : "🗡️"}</div>
      <div class="deal-role-name ${info.side === "good" ? "info-good" : "info-evil"}">${escapeHtml(info.role)}</div>
      <div class="deal-role-side">${sideName}</div>
      <div class="deal-role-scroll">
        <div><b>角色</b><span>${escapeHtml(roleIntro(info.role))}</span></div>
        <div><b>说明</b><span>${escapeHtml(info.role_message || "")}</span></div>
        <div><b>夜晚视野</b><span>${escapeHtml(info.visibility_note || "无额外夜晚视野。")}</span></div>
        <div><b>已知信息</b><span>${known}</span></div>
      </div>
    </div>`;
}

function buildFlyingCards() {
  const wrap = $("flyingCards");
  if (!wrap) return;
  wrap.innerHTML = "";
  const seats = latestState?.players || [];
  for (let i = 0; i < Math.min(10, Math.max(5, seats.length || 5)); i++) {
    const card = document.createElement("span");
    card.className = "fly-card";
    const angle = -80 + i * (160 / Math.max(1, (Math.min(10, Math.max(5, seats.length || 5)) - 1)));
    const radius = 120 + (i % 2) * 18;
    card.style.setProperty("--tx", `${Math.cos(angle * Math.PI / 180) * radius}px`);
    card.style.setProperty("--ty", `${Math.sin(angle * Math.PI / 180) * radius * .72}px`);
    card.style.setProperty("--rot", `${angle * .35}deg`);
    card.style.animationDelay = `${i * 70}ms`;
    wrap.appendChild(card);
  }
}

function sendChat() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  input.value = "";
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    scheduleReconnect("连接暂时不可用，正在恢复……");
    return false;
  }
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    console.warn("send failed", err);
    scheduleReconnect("发送失败，正在恢复连接……");
    return false;
  }
}

function button(text, cls, fn) {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  b.addEventListener("click", fn);
  return b;
}

function showTopError(message) {
  const box = $("errorBox");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
}


function applyPhaseMicroInteractions(state, signal) {
  const phaseKey = `${state.current_phase || "LOBBY"}|${signal.round || 0}|${JSON.stringify(signal.game_score || {})}`;
  if (phaseKey === lastRenderedPhaseKey) return;
  lastRenderedPhaseKey = phaseKey;

  [$("phaseTitle"), document.querySelector(".judge-panel"), $("actionPanel")].forEach(el => {
    if (!el) return;
    el.classList.remove("phase-enter");
    void el.offsetWidth;
    el.classList.add("phase-enter");
  });

  const message = extractResultToastMessage(state);
  if (message && lastResultToastKey !== `${phaseKey}|${message.text}`) {
    lastResultToastKey = `${phaseKey}|${message.text}`;
    showPhaseToast(message.text, message.kind);
  }
}

function extractResultToastMessage(state) {
  const text = state.public_announcement || "";
  const phase = state.current_phase || "";
  if (!text && !phase) return null;
  if (/刺杀|GAME_OVER|游戏结束/.test(text) || phase === "GAME_OVER") return { text: "终局已揭晓", kind: "evil" };
  if (/任务失败|本次任务失败/.test(text)) return { text: "任务失败", kind: "evil" };
  if (/任务成功|本次任务成功/.test(text)) return { text: "任务成功", kind: "good" };
  if (/组队失败|队伍未通过|提案失败/.test(text)) return { text: "组队失败", kind: "evil" };
  if (/组队通过|队伍通过|提案通过/.test(text)) return { text: "组队通过", kind: "good" };
  if (phase.includes("MISSION_RESULT")) return { text: "任务结果已公布", kind: "neutral" };
  return null;
}

function showPhaseToast(text, kind = "neutral") {
  const toast = $("phaseToast");
  if (!toast) return;
  toast.textContent = text;
  toast.className = `phase-toast ${kind}`;
  clearTimeout(phaseToastTimer);
  phaseToastTimer = setTimeout(() => toast.classList.add("hidden"), 1300);
}

function compactPhaseName(phase, round) {
  if (!phase || phase === "LOBBY") return "大厅";
  const r = round ? `第${round}轮` : "";
  if (phase.includes("TEAM_PROPOSAL")) return `${r} · 队长选人`;
  if (phase.includes("TEAM_VOTE")) return `${r} · 组队投票`;
  if (phase.includes("MISSION_VOTE")) return `${r} · 任务投票`;
  if (phase.includes("MISSION_RESULT")) return `${r} · 结果复盘`;
  if (phase.includes("ORDERED")) return `${r} · 轮流发言`;
  if (phase.includes("FREE")) return `${r} · 组队讨论`;
  if (phase === "ASSASSINATION_DISCUSSION") return "终局刺杀";
  if (phase === "GAME_OVER") return "游戏结算";
  return phaseName(phase);
}

function phaseName(phase) {
  if (!phase) return "等待状态";
  if (phase === "LOBBY") return "圆桌大厅";
  if (phase.includes("PRE_TEAM_DISCUSSION_ORDERED")) return "组队前轮流发言";
  if (phase.includes("PRE_TEAM_DISCUSSION_FREE")) return "组队前公共麦克风";
  if (phase.includes("TEAM_PROPOSAL")) return "队长选人";
  if (phase.includes("TEAM_VOTE")) return "组队投票";
  if (phase.includes("MISSION_VOTE")) return "任务投票";
  if (phase.includes("MISSION_RESULT_DISCUSSION")) return "任务结果复盘";
  if (phase.includes("DISCUSSION_ORDERED")) return "轮流发言";
  if (phase.includes("DISCUSSION_FREE")) return "自由讨论";
  if (phase === "ASSASSINATION_DISCUSSION") return "终局刺杀";
  if (phase === "GAME_OVER") return "游戏结束";
  return phase;
}

function permissionSummary(perms, phase) {
  if (perms.can_start_game) return "全员已准备";
  if (perms.can_toggle_ready && !perms.is_ready) return "请准备";
  if (perms.is_host && latestState?.current_phase === "LOBBY") return `等待准备 ${perms.ready_count ?? 0}/${perms.ready_required ?? 0}`;
  if (perms.can_finish_speaker) return "轮到你发言";
  if (perms.can_end_free_discussion) return "队长可选人";
  if (perms.can_select_team) return "你是队长";
  if (perms.can_submit_team_vote) return "请投组队票";
  if (perms.can_submit_mission_vote) return "请投任务票";
  if (perms.can_continue_after_result) return "队长可下一轮";
  if (perms.can_submit_assassin_target) return "请选择刺杀目标";
  if (phase === "GAME_OVER") return "游戏结束";
  return "等待其他玩家操作";
}

function displayPlayer(p) {
  if (!p) return "-";
  const seat = p.seat || (p.label ? String(p.label).replace(/[^0-9]/g, "") : "");
  const name = p.name || p.label || "玩家";
  return seat ? `${seat}号-${name}` : name;
}

function normalizeDisplayText(text) { return String(text || "").replace(/Player_(\d+)\s*·\s*/g, "$1号-"); }
function formatMicStatus(status) {
  const s = String(status || "-");
  if (s === "MUTE_ALL") return "全员禁麦";
  if (s === "UNMUTE_ALL") return "公麦开放";
  const m = s.match(/^MUTE_ALL_EXCEPT_Player_(\d+)$/);
  if (m) return `仅${m[1]}号开麦`;
  return normalizeDisplayText(s);
}
function formatChatStatus(status) {
  const s = String(status || "-");
  if (s === "CLOSED") return "文字关闭";
  if (s === "OPEN_FOR_ALL") return "文字开放";
  return s;
}
function onlyMicSeatFromStatus(status, players) {
  const s = String(status || "");
  const m = s.match(/^MUTE_ALL_EXCEPT_Player_(\d+)$/);
  if (m) return Number(m[1]);
  const idMatch = s.match(/^MUTE_ALL_EXCEPT_(.+)$/);
  if (idMatch) return (players || []).find(x => x.id === idMatch[1])?.seat || null;
  return null;
}
function formatAnnouncementHTML(text) {
  let safe = escapeHtml(normalizeDisplayText(text || "等待法官公告。"));
  safe = safe.replace(/(第\s*\d+\s*轮)/g, '<span class="ann-accent">$1</span>');
  safe = safe.replace(/((?:\d+号-[^，。\s]+))/g, '<strong class="ann-player">$1</strong>');
  safe = safe.replace(/(队长|当前发言人|组队投票|任务成功|任务失败|轮流发言|公共麦克风|自由讨论|出征队伍|任务票|刺杀)/g, '<strong>$1</strong>');
  return safe;
}
function labelToDisplay(id, fallback) {
  const players = currentPayload?.state?.players || [];
  const p = players.find(x => x.id === id);
  if (p) return displayPlayer(p);
  return normalizeDisplayText(fallback);
}
function normalizeRoom(s) { return (s || "AVALON").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24) || "AVALON"; }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
function copyInviteLink() {
  const url = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  navigator.clipboard?.writeText(url);
  const label = $("copyRoomBtn")?.querySelector(".ctrl-label");
  if (label) {
    label.textContent = "已复制";
    setTimeout(() => { label.textContent = "邀请"; }, 1400);
  }
}

async function toggleVoice() {
  if (micEnabled) {
    await setMicEnabled(false);
  } else {
    await setMicEnabled(true);
  }
}

async function toggleListenOnly() {
  await setSpeakerEnabled(!speakerEnabled);
}

async function setMicEnabled(on) {
  if (on) {
    try {
      await unlockAudioPlayback();

      // 开语音时默认打开扬声器，和游戏语音房一致。
      speakerEnabled = true;
      listenOnly = false;

      await ensureLiveKitConnected();
      await ensureLocalAudioTrack();

      micEnabled = true;
      voiceEnabled = true;

      await refreshLiveKitAudioPermission();
      startSpeakingWatch();
      updateVoiceButtons();
    } catch (err) {
      console.warn("enable mic failed", err);
      showTopError(`无法启用语音：${friendlyAudioError(err)}`);
    }
    return;
  }

  // 关闭语音 = 只关闭自己的麦克风，不影响扬声器。
  micEnabled = false;
  listenOnly = speakerEnabled;
  stopSpeakingWatch();
  sendSpeakingState(false);

  if (localAudioTrack) {
    try { await localAudioTrack.mute(); } catch (_) {}
    try { await livekitRoom?.localParticipant?.unpublishTrack?.(localAudioTrack, true); } catch (_) {}
    try { localAudioTrack.stop?.(); } catch (_) {}
    localAudioTrack = null;
  }

  if (!speakerEnabled) await disconnectLiveKit();
  else await ensureLiveKitConnected();

  voiceEnabled = !!livekitRoom;
  updateVoiceButtons();
}

async function setSpeakerEnabled(on) {
  if (on) {
    try {
      await unlockAudioPlayback();
      speakerEnabled = true;
      listenOnly = !micEnabled;
      await ensureLiveKitConnected();
      applySpeakerState();
      updateVoiceButtons();
    } catch (err) {
      console.warn("enable speaker failed", err);
      showTopError(`无法打开扬声器：${friendlyAudioError(err)}`);
    }
    return;
  }

  // 关闭扬声器 = 只静音远端音频，不动自己的麦克风。
  speakerEnabled = false;
  listenOnly = false;
  applySpeakerState();

  if (!micEnabled) await disconnectLiveKit();
  updateVoiceButtons();
}

async function loadLiveKitSDK() {
  if (livekitSDK) return livekitSDK;
  let lastErr = null;
  for (const url of LIVEKIT_SDK_URLS) {
    try {
      livekitSDK = await import(url);
      return livekitSDK;
    } catch (err) {
      lastErr = err;
      console.warn("LiveKit SDK import failed", url, err);
    }
  }
  throw lastErr || new Error("LiveKit SDK 加载失败");
}

async function getLiveKitToken() {
  const url = `/api/livekit-token?room_id=${encodeURIComponent(roomId)}&player_id=${encodeURIComponent(myId)}`;
  const resp = await fetch(url, { cache: "no-store" });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.detail || "LiveKit token 获取失败");
  }
  return data;
}

async function ensureLiveKitConnected() {
  if (livekitRoom && livekitRoom.state === "connected") return livekitRoom;
  if (livekitConnecting) {
    // 等待并发点击中的连接完成。
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (livekitRoom && livekitRoom.state === "connected") return livekitRoom;
    }
  }

  livekitConnecting = true;
  updateVoiceButtons("连接中");

  try {
    const { url, token } = await getLiveKitToken();
    const sdk = await loadLiveKitSDK();

    if (livekitRoom) {
      try { livekitRoom.disconnect(); } catch (_) {}
    }

    livekitRoom = new sdk.Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    bindLiveKitEvents(livekitRoom, sdk);

    await livekitRoom.connect(url, token, { autoSubscribe: true });
    voiceEnabled = true;
    attachExistingRemoteTracks();
    applySpeakerState();
    updateVoiceButtons();
    return livekitRoom;
  } finally {
    livekitConnecting = false;
  }
}

function bindLiveKitEvents(room, sdk) {
  const RoomEvent = sdk.RoomEvent;
  room
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      attachRemoteAudioTrack(track, participant);
    })
    .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      detachRemoteAudioTrack(track, participant);
    })
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      detachParticipantAudio(participant.identity);
    })
    .on(RoomEvent.Disconnected, () => {
      remoteAudioEls.forEach((el) => el.remove());
      remoteAudioEls.clear();
      livekitRoom = null;
      voiceEnabled = false;
      if (micEnabled || speakerEnabled) {
        showTopError("语音房连接断开，请重新点击语音或扬声器。游戏文字连接不受影响。");
      }
      updateVoiceButtons();
    });
}

function attachExistingRemoteTracks() {
  if (!livekitRoom) return;
  livekitRoom.remoteParticipants?.forEach?.((participant) => {
    participant.trackPublications?.forEach?.((publication) => {
      const track = publication.track;
      if (track) attachRemoteAudioTrack(track, participant);
    });
  });
}

function attachRemoteAudioTrack(track, participant) {
  if (!track || !isAudioTrack(track)) return;
  const identity = participant?.identity || `remote-${Date.now()}`;
  detachParticipantAudio(identity);

  let el;
  try {
    el = track.attach();
  } catch (_) {
    el = document.createElement("audio");
    try { el.srcObject = new MediaStream([track.mediaStreamTrack]); } catch (_) {}
  }

  el.id = `livekit-audio-${identity}`;
  el.autoplay = true;
  el.playsInline = true;
  el.controls = false;
  document.body.appendChild(el);
  remoteAudioEls.set(identity, el);
  applySpeakerState();
}

function detachRemoteAudioTrack(track, participant) {
  try { track.detach?.().forEach(el => el.remove()); } catch (_) {}
  if (participant?.identity) detachParticipantAudio(participant.identity);
}

function detachParticipantAudio(identity) {
  const el = remoteAudioEls.get(identity);
  if (el) el.remove();
  remoteAudioEls.delete(identity);
}

function isAudioTrack(track) {
  return track.kind === "audio" || track.kind === "kind" || String(track.kind).toLowerCase().includes("audio");
}

async function ensureLocalAudioTrack() {
  if (localAudioTrack) return localAudioTrack;
  const sdk = await loadLiveKitSDK();
  localAudioTrack = await sdk.createLocalAudioTrack({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });

  if (!livekitRoom || livekitRoom.state !== "connected") {
    await ensureLiveKitConnected();
  }

  await livekitRoom.localParticipant.publishTrack(localAudioTrack, {
    source: sdk.Track?.Source?.Microphone || "microphone",
  });
  return localAudioTrack;
}

function applySpeakerState() {
  remoteAudioEls.forEach((audio) => {
    audio.muted = !speakerEnabled;
    audio.volume = speakerEnabled ? 1 : 0;
    if (speakerEnabled) {
      audio.play?.().catch(() => {
        showTopError("扬声器已打开，但浏览器要求再点一次“打开扬声器”或页面空白处才能播放声音。");
      });
    }
  });
}

async function refreshLiveKitAudioPermission() {
  const allowed = !!currentPayload?.state?.control_signal?.personal_audio_allowed;

  if (localAudioTrack && micEnabled) {
    try {
      if (allowed) await localAudioTrack.unmute();
      else await localAudioTrack.mute();
    } catch (err) {
      console.warn("LiveKit mute/unmute failed", err);
    }
  }

  if (!allowed) sendSpeakingState(false);
  updateVoiceButtons();
}

async function disconnectLiveKit() {
  stopSpeakingWatch();
  sendSpeakingState(false);

  if (localAudioTrack) {
    try { await localAudioTrack.mute(); } catch (_) {}
    try { await livekitRoom?.localParticipant?.unpublishTrack?.(localAudioTrack, true); } catch (_) {}
    try { localAudioTrack.stop?.(); } catch (_) {}
  }
  localAudioTrack = null;

  remoteAudioEls.forEach((el) => el.remove());
  remoteAudioEls.clear();

  if (livekitRoom) {
    try { livekitRoom.disconnect(); } catch (_) {}
  }
  livekitRoom = null;
  voiceEnabled = false;
}

function updateVoiceButtons(extraStatus="") {
  const voiceBtn = $("voiceBtn");
  const listenBtn = $("listenBtn");

  const voiceLabel = voiceBtn?.querySelector(".ctrl-label");
  const voiceIcon  = voiceBtn?.querySelector(".ctrl-icon");
  const listenLabel = listenBtn?.querySelector(".ctrl-label");

  if (micEnabled) {
    const canSpeak = !!currentPayload?.state?.control_signal?.personal_audio_allowed;
    if (voiceLabel) voiceLabel.textContent = extraStatus ? extraStatus : "关麦";
    if (voiceIcon)  voiceIcon.textContent  = canSpeak ? "🎙" : "🔇";
    voiceBtn.title = canSpeak ? "当前可说话（点击关闭）" : "当前禁麦（点击关闭）";
    voiceBtn.classList.add("voice-on");
  } else {
    if (voiceLabel) voiceLabel.textContent = extraStatus ? extraStatus : "语音";
    if (voiceIcon)  voiceIcon.textContent  = "🎙";
    voiceBtn.title = "点击启用麦克风";
    voiceBtn.classList.remove("voice-on");
  }

  if (listenBtn) {
    if (speakerEnabled) {
      if (listenLabel) listenLabel.textContent = extraStatus ? extraStatus : "静音";
      listenBtn.title = "点击关闭远端声音";
      listenBtn.classList.add("voice-on");
    } else {
      if (listenLabel) listenLabel.textContent = extraStatus ? extraStatus : "扬声器";
      listenBtn.title = "点击播放远端声音";
      listenBtn.classList.remove("voice-on");
    }
  }
}

async function unlockAudioPlayback() {
  if (audioUnlocked) return;
  audioUnlocked = true;

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      await ctx.resume?.();
      await ctx.close?.();
    }
  } catch (_) {}
}

function disableVoice(updateButtons=true) {
  micEnabled = false;
  speakerEnabled = false;
  listenOnly = false;
  disconnectLiveKit();
  if (updateButtons) updateVoiceButtons();
}

function friendlyAudioError(err) {
  const msg = String(err?.message || err || "");
  if (msg.includes("LiveKit 未配置") || msg.includes("LIVEKIT")) return "LiveKit 未配置,本地可先测试游戏流程。";
  if (msg.includes("Permission") || msg.includes("NotAllowed")) return "浏览器没有麦克风权限。";
  if (msg.includes("SDK") || msg.includes("import")) return "LiveKit 客户端加载失败，请检查网络或 CDN。";
  return msg || "请检查浏览器权限和 LiveKit 环境变量。";
}

function startSpeakingWatch() {
  stopSpeakingWatch(false);
  const mediaTrack = localAudioTrack?.mediaStreamTrack;
  if (!mediaTrack) return;

  try {
    localAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    localAudioContext.resume?.().catch(() => {});

    const source = localAudioContext.createMediaStreamSource(new MediaStream([mediaTrack]));
    localAnalyser = localAudioContext.createAnalyser();
    localAnalyser.fftSize = 1024;

    source.connect(localAnalyser);

    const data = new Uint8Array(localAnalyser.fftSize);
    speakingSilentSince = 0;

    speakingWatchTimer = setInterval(() => {
      if (!localAnalyser || !mediaTrack) return;

      const allowed = !!currentPayload?.state?.control_signal?.personal_audio_allowed;
      if (!allowed || !micEnabled) {
        speakingSilentSince = Date.now();
        sendSpeakingState(false);
        return;
      }

      localAnalyser.getByteTimeDomainData(data);

      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] - 128;
        sum += v * v;
      }

      const rms = Math.sqrt(sum / data.length);
      const now = Date.now();

      if (rms >= SPEAKING_ON_RMS) {
        speakingSilentSince = 0;
        sendSpeakingState(true);
        return;
      }

      if (lastSpeakingState && rms <= SPEAKING_OFF_RMS) {
        if (!speakingSilentSince) speakingSilentSince = now;

        if (now - speakingSilentSince >= SPEAKING_OFF_DELAY_MS) {
          sendSpeakingState(false);
          speakingSilentSince = 0;
        }
        return;
      }

      if (!lastSpeakingState) speakingSilentSince = now;
    }, SPEAKING_CHECK_MS);

  } catch (err) {
    console.warn("speaking watch unavailable", err);
  }
}

function stopSpeakingWatch(sendStop=true) {
  if (speakingWatchTimer) clearInterval(speakingWatchTimer);
  speakingWatchTimer = null;
  localAnalyser = null;
  speakingSilentSince = 0;

  if (localAudioContext) localAudioContext.close?.();
  localAudioContext = null;

  if (sendStop) sendSpeakingState(false);
}

function sendSpeakingState(speaking) {
  if (lastSpeakingState === speaking) return;
  lastSpeakingState = speaking;
  send({ type: "speaking_state", speaking });
}
