const firebaseConfig = {
  apiKey: "AIzaSyAq0qRhcCTKfjtSRmajM3yHN1PfSmRCQ4",
  authDomain: "testproject-7782e.firebaseapp.com",
  databaseURL: "https://testproject-7782e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "testproject-7782e",
  storageBucket: "testproject-7782e.firebasestorage.app",
  messagingSenderId: "280073184981",
  appId: "1:280073184981:web:6f7be46c629be1fd68e45c",
  measurementId: "G-21J0Q3EV40"
};

const PLAYER_LIMIT = 8;
const MAZE_SIZE = 15;
const PLAYER_STORAGE_KEY = "maze-of-many-player";
const ROOM_STORAGE_KEY = "maze-of-many-room";
const CELL_SIZE = 27;
const EXPLORER_VISION = 2;
const appRoot = document.getElementById("app");
const palette = ["#9bcbd0", "#d3b88d", "#b4a2d6", "#9ac49e", "#d0988a", "#98aed0", "#c7c08f", "#c08ea6"];
const state = {
  database: null,
  roomRef: null,
  presenceRef: null,
  player: null,
  roomId: null,
  roomLoaded: false,
  room: null,
  connected: false,
  localMode: false,
  lastDirectionId: null,
  lastStatusEvent: "",
  lastAnnouncedNavigator: null,
  joining: false,
  lastMessageAt: 0
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function safeColor(color) {
  return palette.includes(color) ? color : "#aeb9b4";
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadPlayer() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY) || "null");
    if (saved && typeof saved.id === "string" && typeof saved.name === "string" && palette.includes(saved.color)) {
      state.player = saved;
      return saved;
    }
  } catch (error) {
    console.warn("Could not read saved player identity.", error);
  }

  state.player = {
    id: makeId(),
    name: `Player ${String(Math.floor(Math.random() * 90) + 10).padStart(2, "0")}`,
    color: palette[Math.floor(Math.random() * palette.length)]
  };
  localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(state.player));
  return state.player;
}

function setNotice(message, kind = "info") {
  const region = document.getElementById("notice-region");
  if (!region) return;
  region.innerHTML = `<div class="notice notice-${kind}" role="status">${escapeHtml(message)}</div>`;
  window.clearTimeout(setNotice.timeout);
  setNotice.timeout = window.setTimeout(() => {
    if (region.isConnected) region.innerHTML = "";
  }, 4200);
}

function renderConnecting(message = "Connecting to the maze…") {
  appRoot.innerHTML = `<section class="screen"><div class="loading-card"><span class="eyebrow">Live connection</span><h1>${escapeHtml(message)}</h1><p>Establishing a shared space for your group.</p></div></section>`;
}

function renderError(message) {
  appRoot.innerHTML = `<section class="screen"><div class="loading-card error-card"><span class="eyebrow">Connection interrupted</span><h1>THE MAZE IS OUT OF REACH</h1><p>${escapeHtml(message)}</p><button class="primary-btn" id="retry-connection">Try again</button><button class="text-btn" id="play-solo">Play a local demo</button></div></section>`;
  document.getElementById("retry-connection")?.addEventListener("click", () => window.location.reload());
  document.getElementById("play-solo")?.addEventListener("click", startLocalDemo);
}

function connectedPlayers(players = {}) {
  return Object.values(players).filter((player) => player && player.connected === true && player.id);
}

function orderedPlayers(players = {}) {
  return connectedPlayers(players).sort((a, b) =>
    (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0) || String(a.id).localeCompare(String(b.id))
  );
}

function playerRecord(id, fallback = {}) {
  return state.room?.players?.[id] || fallback;
}

function isLocalHost() {
  return orderedPlayers(state.room?.players)[0]?.id === state.player?.id;
}

function listenToConnection() {
  state.database.ref(".info/connected").on("value", (snapshot) => {
    const wasConnected = state.connected;
    state.connected = snapshot.val() === true;
    if (!state.connected) {
      if (wasConnected) setNotice("Connection lost. Trying to reconnect…", "warning");
      return;
    }
    clearTimeout(state.connectionTimer);
    if (!wasConnected && state.roomRef) {
      setNotice("Connection restored.", "success");
      claimPresence();
    }
  }, (error) => {
    console.error("Firebase connection status listener failed.", error);
    renderError("We could not monitor the Firebase connection. Check the database URL and Firebase Realtime Database rules.");
  });
  state.connectionTimer = window.setTimeout(() => {
    if (!state.roomLoaded && !state.localMode) {
      renderError("The Realtime Database is not responding. Check that Firebase is enabled and that your network can reach the configured database URL.");
    }
  }, 12000);

  state.roomRef.child("presence").on("value", (snapshot) => {
    reconcilePresence({ ...state.room, presence: snapshot.val() || {} });
  }, (error) => {
    console.error("Firebase presence listener failed.", error);
    setNotice("Player presence could not be synchronized.", "error");
  });
}

function claimPresence() {
  if (!state.connected || !state.roomRef || !state.player) return;
  state.presenceRef = state.roomRef.child("presence").child(state.player.id);
  // Presence is separate from game state so Firebase removes stale sessions after a disconnect.
  state.presenceRef.onDisconnect().remove()
    .then(() => state.presenceRef.set(true))
    .catch((error) => {
      console.error("Could not register Firebase disconnect presence.", error);
      setNotice("Could not register your live presence. Check Firebase database permissions.", "error");
    });
}

function normalizeMaze(maze) {
  if (!maze || !Number.isInteger(maze.width) || !Number.isInteger(maze.height) ||
      maze.width < 2 || maze.height < 2 || maze.width > 31 || maze.height > 31 ||
      !Array.isArray(maze.cells) || maze.cells.length !== maze.height ||
      !validPosition(maze.start, maze) || !validPosition(maze.exit, maze)) return null;
  if (!maze.cells.every((row) => Array.isArray(row) && row.length === maze.width)) return null;
  if (!maze.cells.flat().every((cell) =>
    cell && cell.walls && ["north", "east", "south", "west"].every((wall) => typeof cell.walls[wall] === "boolean")
  )) return null;
  return maze;
}

function makeMaze(size = MAZE_SIZE) {
  const cells = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => ({
      x, y, visited: false,
      walls: { north: true, east: true, south: true, west: true }
    }))
  );
  const directions = [
    { dx: 0, dy: -1, wall: "north", opposite: "south" },
    { dx: 1, dy: 0, wall: "east", opposite: "west" },
    { dx: 0, dy: 1, wall: "south", opposite: "north" },
    { dx: -1, dy: 0, wall: "west", opposite: "east" }
  ];
  const stack = [{ x: 0, y: 0 }];
  cells[0][0].visited = true;
  while (stack.length) {
    const current = stack[stack.length - 1];
    const options = directions.filter(({ dx, dy }) => {
      const x = current.x + dx;
      const y = current.y + dy;
      return x >= 0 && y >= 0 && x < size && y < size && !cells[y][x].visited;
    });
    if (!options.length) {
      stack.pop();
      continue;
    }
    const direction = options[Math.floor(Math.random() * options.length)];
    const x = current.x + direction.dx;
    const y = current.y + direction.dy;
    cells[current.y][current.x].walls[direction.wall] = false;
    cells[y][x].walls[direction.opposite] = false;
    cells[y][x].visited = true;
    stack.push({ x, y });
  }

  const distances = new Map([["0,0", 0]]);
  const queue = [{ x: 0, y: 0 }];
  let exit = { x: 0, y: 0 };
  while (queue.length) {
    const current = queue.shift();
    const distance = distances.get(`${current.x},${current.y}`) || 0;
    if (distance > (distances.get(`${exit.x},${exit.y}`) || 0)) exit = current;
    for (const direction of directions) {
      if (cells[current.y][current.x].walls[direction.wall]) continue;
      const x = current.x + direction.dx;
      const y = current.y + direction.dy;
      const key = `${x},${y}`;
      if (distances.has(key)) continue;
      distances.set(key, distance + 1);
      queue.push({ x, y });
    }
  }
  return { width: size, height: size, start: { x: 0, y: 0 }, exit, cells };
}

function validatePlayerCount(players) {
  return players.length >= 2 && players.length <= PLAYER_LIMIT;
}

function assignNavigator(room) {
  if (!state.roomRef || !room?.players) return;
  const live = orderedPlayers(room.players);
  if (!live.length) return;
  if (live.some((player) => player.id === room.navigatorId)) return;
  const nextId = live[0].id;
  state.roomRef.child("navigatorId").transaction((currentId) => {
    const currentIsLive = live.some((player) => player.id === currentId);
    return currentIsLive ? currentId : nextId;
  });
}

async function registerPlayer() {
  const player = loadPlayer();
  const room = state.roomRef;
  const phaseSnapshot = await room.child("phase").once("value");
  const phase = phaseSnapshot.val();
  await room.child("gameId").once("value");
  state.roomId = "main";
  const presenceSnapshot = await room.child("presence").once("value");
  const online = presenceSnapshot.val() || {};
  const otherOnlineCount = Object.entries(online).filter(([id, value]) => id !== player.id && value === true).length;
  if (otherOnlineCount >= PLAYER_LIMIT && online[player.id] !== true) {
    appRoot.innerHTML = `<section class="screen"><div class="loading-card"><span class="eyebrow">Room ${escapeHtml(state.roomId)}</span><h1>THE MAZE IS FULL</h1><p>Eight players are already connected. Ask someone to leave, then reload this page to join.</p></div></section>`;
    return;
  }
  const activePlayersSnapshot = await room.child("players").once("value");
  const activePlayers = activePlayersSnapshot.val() || {};
  const usedColors = new Set(Object.entries(activePlayers)
    .filter(([id]) => id !== player.id && online[id] === true)
    .map(([, activePlayer]) => activePlayer?.color)
    .filter((color) => palette.includes(color)));
  if (usedColors.has(player.color)) {
    const availableColor = palette.find((color) => !usedColors.has(color));
    if (availableColor) {
      player.color = availableColor;
      localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(player));
    }
  }
  const playerRef = room.child("players").child(player.id);
  const oldPlayerSnapshot = await playerRef.once("value");
  const previous = oldPlayerSnapshot.val();
  const record = {
    id: player.id,
    name: player.name,
    color: player.color,
    joinedAt: previous?.joinedAt || Date.now(),
    connected: true,
    escaped: previous?.escaped === true,
    position: previous?.position || { x: 0, y: 0 }
  };
  if (phase === "playing" && state.room?.maze && !validPosition(record.position, state.room.maze)) {
    record.position = { ...state.room.maze.start };
  }
  await playerRef.set(record);
  claimPresence();
}

function validPosition(position, maze) {
  return Boolean(position && Number.isInteger(position.x) && Number.isInteger(position.y) &&
    position.x >= 0 && position.y >= 0 && position.x < maze.width && position.y < maze.height);
}

function attachRoomListeners() {
  state.roomRef.on("value", (snapshot) => {
    if (state.localMode) return;
    const room = snapshot.val() || {};
    state.room = room;
    state.roomLoaded = true;
    reconcilePresence(room);
    if (!room.phase || room.phase === "lobby") {
      renderLobby(room);
    } else if ((room.phase === "playing" || room.phase === "completed") && normalizeMaze(room.maze)) {
      renderGame(room);
    } else {
      renderLobby({ ...room, phase: "lobby" });
    }

    if (room.phase === "playing") assignNavigator(room);
    if (room.phase === "playing") checkForCompletion();
    if (room.phase === "playing" && room.navigatorId && state.lastAnnouncedNavigator !== room.navigatorId) {
      if (state.lastAnnouncedNavigator !== null) setNotice(`${playerRecord(room.navigatorId)?.name || "A player"} is the new Navigator.`, "success");
      state.lastAnnouncedNavigator = room.navigatorId;
    }
    announcePresenceChanges(room);
  }, (error) => {
    console.error("Firebase room listener failed.", error);
    renderError("Firebase refused access to the shared maze. Verify Realtime Database is enabled and its rules allow this classroom demo.");
  });

  state.roomRef.child("messages").limitToLast(35).on("value", (snapshot) => {
    if (state.localMode) return;
    const messages = snapshot.val() || {};
    updateChat(messages);
  }, (error) => {
    console.error("Firebase chat listener failed.", error);
    setNotice("Chat could not connect. Check Firebase database permissions.", "error");
  });

  state.roomRef.child("directions").limitToLast(1).on("child_added", (snapshot) => {
    if (state.localMode) return;
    const instruction = snapshot.val();
    if (!instruction || instruction.targetPlayerId !== state.player.id ||
        !["up", "down", "left", "right"].includes(instruction.direction) ||
        snapshot.key === state.lastDirectionId) return;
    state.lastDirectionId = snapshot.key;
    setNotice(`NAVIGATOR → YOU  ·  ${instruction.direction.toUpperCase()}`, "direction");
  });
}

function announcePresenceChanges(room) {
  const nowConnected = new Set(connectedPlayers(room.players).map((player) => player.id));
  const previous = state.previousConnected || nowConnected;
  for (const id of nowConnected) {
    if (!previous.has(id) && id !== state.player?.id) {
      setNotice(`${playerRecord(id)?.name || "A player"} entered the maze.`, "success");
    }
  }
  for (const id of previous) {
    if (!nowConnected.has(id) && id !== state.player?.id) {
      setNotice(`${playerRecord(id)?.name || "A player"} disconnected.`, "warning");
    }
  }
  state.previousConnected = nowConnected;
}

function renderLobby(room) {
  const players = orderedPlayers(room.players);
  const localPlayer = players.find((player) => player.id === state.player?.id);
  if (!localPlayer && state.connected && !state.joining) {
    state.joining = true;
    registerPlayer().catch((error) => {
      console.error("Could not join the maze lobby.", error);
      renderError("We could not add you to the lobby. Check Firebase Realtime Database permissions.");
    }).finally(() => { state.joining = false; });
  }
  const full = players.length >= PLAYER_LIMIT;
  const host = players[0]?.id === state.player?.id;
  const canStart = validatePlayerCount(players) && host && state.connected;
  const playerRows = players.length
    ? players.map((player) => `<li class="player-row"><span class="player-dot" style="--player-color:${safeColor(player.color)}"></span><span>${escapeHtml(player.name)}</span><span class="player-role">${player.id === room.navigatorId ? "Navigator" : "Explorer"}</span><span class="online-dot" aria-label="Online"></span></li>`).join("")
    : `<li class="empty-row">Waiting for explorers to arrive…</li>`;
  appRoot.innerHTML = `
    <section class="screen lobby-screen">
      <div class="lobby-layout">
        <div class="lobby-copy-block">
          <div class="eyebrow"><span class="pulse-dot"></span> Shared experiment · ${state.connected ? "Live" : "Reconnecting"}</div>
          <h1>THE MAZE<br /><span>OF MANY</span></h1>
          <p class="intro-line">ONE MAZE. MANY PEOPLE. DIFFERENT VIEWS.</p>
          <p class="intro-copy">One person can see the way.<br />Everyone else has to find it.</p>
          <div class="rule-line"><span>01</span><p>One Navigator. Everyone else explores.</p></div>
          <div class="rule-line"><span>02</span><p>Reach the exit together. Leave no one behind.</p></div>
        </div>
        <section class="lobby-card">
          <div class="lobby-card-header"><span class="eyebrow">The gathering point</span><span class="room-tag">ROOM ${escapeHtml(state.roomId || "MAIN")}</span></div>
          <div class="player-count"><strong>${players.length}</strong><span>/ ${PLAYER_LIMIT}<small>PLAYERS</small></span></div>
          <ul class="player-list">${playerRows}</ul>
          <p class="lobby-status">${full ? "The maze is full." : players.length < 2 ? "Waiting for another Explorer." : host ? "The group is ready. Begin when everyone is here." : "Waiting for the host to begin."}</p>
          <button id="enter-maze" class="primary-btn" ${canStart ? "" : "disabled"}>${room.phase === "playing" ? "Starting…" : "Enter the maze"} <span aria-hidden="true">↗</span></button>
          <p class="lobby-footnote">${full ? "Maximum 8 players." : "A new maze is generated when the host begins."}</p>
        </section>
      </div>
    </section>
    <div id="notice-region" class="notice-region"></div>`;
  document.getElementById("enter-maze")?.addEventListener("click", startGame);
}

function markerForCell(players, x, y) {
  return players.filter((player) => player.position?.x === x && player.position?.y === y)
    .map((player, index) => `<span class="player-marker ${player.id === state.player.id ? "is-me" : ""}" style="--player-color:${safeColor(player.color)};--marker-offset:${index * 3}px" title="${escapeHtml(player.name)}"></span>`).join("");
}

function cellVisible(x, y, position, isNavigator, marker) {
  return isNavigator || (Math.abs(position.x - x) <= EXPLORER_VISION &&
    Math.abs(position.y - y) <= EXPLORER_VISION) ||
    Boolean(marker && marker.x === x && marker.y === y);
}

function renderMaze(maze, players, localPlayer, navigator) {
  const isNavigator = navigator;
  const position = validPosition(localPlayer?.position, maze) ? localPlayer.position : maze.start;
  const bounds = isNavigator
    ? { minX: 0, maxX: maze.width - 1, minY: 0, maxY: maze.height - 1 }
    : {
        minX: Math.max(0, position.x - EXPLORER_VISION - 1),
        maxX: Math.min(maze.width - 1, position.x + EXPLORER_VISION + 1),
        minY: Math.max(0, position.y - EXPLORER_VISION - 1),
        maxY: Math.min(maze.height - 1, position.y + EXPLORER_VISION + 1)
      };
  const activeMarker = state.room?.marker && state.room.marker.expiresAt > Date.now() ? state.room.marker : null;
  const cells = [];
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const mazeCell = maze.cells[y][x];
      const isExit = maze.exit.x === x && maze.exit.y === y;
      const shown = cellVisible(x, y, position, isNavigator, activeMarker);
      const wallStyles = [
        ["north", "border-top"],
        ["east", "border-right"],
        ["south", "border-bottom"],
        ["west", "border-left"]
      ].map(([wall, property]) => `${property}:${mazeCell.walls[wall] ? "2px solid var(--wall)" : "2px solid transparent"}`).join(";");
      const markerHere = activeMarker?.x === x && activeMarker?.y === y;
      cells.push(`<button class="maze-cell ${shown ? "revealed" : "fogged"} ${isExit && isNavigator ? "exit-cell" : ""} ${markerHere ? "marked-cell" : ""}" style="${wallStyles}" data-x="${x}" data-y="${y}" aria-label="${shown ? `Cell ${x + 1}, ${y + 1}${isExit && isNavigator ? ", exit" : ""}` : "Unexplored"}">${shown ? markerForCell(players, x, y) : ""}${isExit && isNavigator ? `<span class="exit-marker">×</span>` : ""}${markerHere ? `<span class="map-marker">${escapeHtml(activeMarker.type)}</span>` : ""}</button>`);
    }
  }
  return `<div class="maze-viewport" tabindex="0"><div class="maze-grid ${isNavigator ? "full-map" : "local-map"}" style="--columns:${bounds.maxX - bounds.minX + 1};--cell:${CELL_SIZE}px">${cells.join("")}</div></div>`;
}

function renderPlayersPanel(players, isNavigator, escapedCount) {
  const solo = players.length === 1;
  const explorers = solo ? players : players.filter((player) => player.id !== state.room.navigatorId);
  return `<section class="side-section"><div class="section-heading"><span>IN THE MAZE</span><span>${players.length}</span></div><div class="live-player-list">${players.map((player) => {
    const position = player.position;
    const escaped = player.escaped === true;
    return `<div class="live-player ${player.id === state.player.id ? "current-player" : ""}"><span class="player-dot" style="--player-color:${safeColor(player.color)}"></span><span class="live-player-name">${escapeHtml(player.name)}${player.id === state.player.id ? " <i>YOU</i>" : ""}</span><span class="player-state">${escaped ? "OUT" : player.id === state.room.navigatorId ? "GUIDE" : position ? `${String(position.x + 1).padStart(2, "0")}:${String(position.y + 1).padStart(2, "0")}` : "JOINING"}</span></div>`;
  }).join("")}</div><div class="escape-progress"><span>${solo ? "PLAYER OUT" : "EXPLORERS OUT"}</span><strong>${escapedCount}<small> / ${explorers.length}</small></strong></div>${isNavigator && players.some((player) => player.id !== state.player.id && !player.escaped) ? `<label class="select-label" for="target-player">GUIDE AN EXPLORER</label><select id="target-player">${players.filter((player) => player.id !== state.player.id && !player.escaped).map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`).join("")}</select><div class="direction-grid"><button data-direction="up" aria-label="Send up">↑</button><button data-direction="left" aria-label="Send left">←</button><button data-direction="down" aria-label="Send down">↓</button><button data-direction="right" aria-label="Send right">→</button></div>` : ""}</section>`;
}

function renderChat(room) {
  const messages = Object.entries(room.messages || {}).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0)).slice(-25);
  return `<section class="chat-section"><div class="section-heading"><span>FIELD NOTES</span><span class="live-label">LIVE</span></div><div class="chat-messages" id="chat-messages">${messages.map(([id, message]) => renderMessage(id, message)).join("")}<div id="chat-end"></div></div><form id="chat-form" class="chat-form"><input id="chat-input" maxlength="180" autocomplete="off" placeholder="Send a message…" aria-label="Chat message" /><button type="submit" aria-label="Send message">↗</button></form></section>`;
}

function renderMessage(id, message) {
  return `<div class="chat-message" data-message-id="${escapeHtml(id)}"><span class="chat-author" style="--player-color:${safeColor(message.color)}">${escapeHtml(message.playerName || "Player")}</span><span>${escapeHtml(message.text || "")}</span></div>`;
}

function renderGame(room) {
  const maze = normalizeMaze(room.maze);
  if (!maze) {
    renderError("The shared maze data is incomplete. Restart the game from the lobby.");
    return;
  }
  const players = orderedPlayers(room.players);
  const me = room.players?.[state.player.id];
  const isNavigator = room.navigatorId === state.player.id;
  const connectedCount = orderedPlayers(room.players).length;
  const canMove = !isNavigator || connectedCount === 1;
  if (!me) {
    appRoot.innerHTML = `<section class="screen"><div class="loading-card"><h1>REJOINING THE MAZE</h1><p>Restoring your player state…</p></div></section>`;
    if (state.connected && !state.joining) {
      state.joining = true;
      registerPlayer().catch((error) => console.error("Could not restore player state.", error)).finally(() => { state.joining = false; });
    }
    return;
  }
  const escapedCount = players.filter((player) => player.escaped === true &&
    (player.id !== room.navigatorId || connectedCount === 1)).length;
  const explorerCount = connectedCount === 1 ? players.length : players.filter((player) => player.id !== room.navigatorId).length;
  const finished = room.phase === "completed";
  const escaped = me.escaped === true;
  const roleLabel = isNavigator ? "NAVIGATOR / CONTROL" : "EXPLORER / FIELD";
  appRoot.innerHTML = `
    <section class="game-screen">
      <header class="game-topbar"><div><span class="eyebrow"><span class="pulse-dot"></span> ${state.roomId === "LOCAL" ? "LOCAL DEMO" : state.connected ? "SYNCHRONIZED" : "RECONNECTING"}</span><h1>THE MAZE <span>OF MANY</span></h1></div><div class="game-top-meta"><span>ROOM <strong>${escapeHtml(state.roomId || "MAIN")}</strong></span><span>RUN <strong>${escapeHtml(String(room.gameId || "").slice(-5).toUpperCase())}</strong></span></div></header>
      <div class="game-layout ${isNavigator ? "navigator-layout" : "explorer-layout"}">
        <main class="map-column"><div class="map-heading"><div><span class="eyebrow">Live field / ${escapeHtml(roleLabel)}</span><p>${isNavigator ? connectedCount === 1 ? "You are alone. Move through the maze to keep the run alive." : "You see the whole maze. They see only what is near." : escaped ? "You made it out. Stay with the group." : "Find a route. The Navigator can see the way."}</p></div><span class="map-coordinates">${String((me.position?.x || 0) + 1).padStart(2, "0")} / ${String((me.position?.y || 0) + 1).padStart(2, "0")}</span></div>${renderMaze(maze, players, me, isNavigator)}<div class="map-legend"><span><i class="legend-you" style="--player-color:${escapeHtml(state.player.color)}"></i> YOU</span><span><i class="legend-other"></i> EXPLORERS</span>${isNavigator ? `<span><i class="legend-exit"></i> EXIT</span>` : `<span class="fog-legend">UNEXPLORED TERRITORY</span><span>WASD / ARROWS</span>`}</div>${isNavigator && connectedCount > 1 ? `<div class="marker-actions"><span>PLACE FIELD MARKER</span><select id="marker-type"><option>GO HERE</option><option>DANGER</option><option>WAIT</option></select><span class="marker-help">Select a visible cell</span></div>` : canMove ? `<div class="mobile-controls"><div class="direction-pad"><button data-move="up" aria-label="Move up">↑</button><button data-move="left" aria-label="Move left">←</button><button data-move="down" aria-label="Move down">↓</button><button data-move="right" aria-label="Move right">→</button></div><span class="control-hint">ARROW KEYS / WASD</span></div>` : ""}</main>
        <aside class="control-column"><div class="role-card"><span class="eyebrow">Your role</span><strong>${isNavigator ? "THE NAVIGATOR" : "AN EXPLORER"}</strong><span>${isNavigator ? "You are their eyes." : `Guided by ${escapeHtml(playerRecord(room.navigatorId)?.name || "the Navigator")}.`}</span></div>${renderPlayersPanel(players, isNavigator, escapedCount)}${renderChat(room)}</aside>
      </div>
      <div id="notice-region" class="notice-region"></div>
      ${finished ? `<div class="completion-overlay"><div class="completion-card"><span class="eyebrow">All signals accounted for</span><h2>THE MAZE<br /><span>IS COMPLETE</span></h2><p>${Math.min(escapedCount, explorerCount)} ${connectedCount === 1 ? "player" : Math.min(escapedCount, explorerCount) === 1 ? "explorer" : "explorers"} escaped${room.completedAt && room.startedAt ? ` · ${formatDuration(room.completedAt - room.startedAt)}` : ""}.</p><button id="new-maze" class="primary-btn" ${isLocalHost() || state.roomId === "LOCAL" ? "" : "disabled"}>${isLocalHost() || state.roomId === "LOCAL" ? "Enter another maze" : "Waiting for the host"} <span>↗</span></button></div></div>` : ""}
    </section>`;
  bindGameControls(isNavigator, finished, escaped);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function bindGameControls(isNavigator, finished, escaped) {
  document.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => movePlayer(button.dataset.move)));
  document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => sendDirection(button.dataset.direction)));
  document.getElementById("chat-form")?.addEventListener("submit", sendChat);
  document.getElementById("new-maze")?.addEventListener("click", state.roomId === "LOCAL" ? startLocalDemo : startGame);
  if (isNavigator && !finished) {
    document.querySelectorAll(".maze-cell.revealed").forEach((cell) => cell.addEventListener("click", () => placeMarker(cell)));
  }
  if (!isNavigator && !finished && !escaped) {
    document.querySelector(".maze-viewport")?.addEventListener("click", () => document.querySelector(".direction-pad")?.classList.add("control-active"));
  }
}

function reconcilePresence(room) {
  if (!state.roomRef) return;
  const presence = room?.presence || {};
  const updates = {};
  for (const [id, player] of Object.entries(room?.players || {})) {
    if (!player || typeof player !== "object") continue;
    const online = presence[id] === true;
    if (player.connected !== online) updates[`players/${id}/connected`] = online;
  }
  if (Object.keys(updates).length) {
    state.roomRef.update(updates).catch((error) => {
      console.error("Could not synchronize player connection status.", error);
    });
  }
}

function getStep(position, direction, maze) {
  const steps = {
    up: { x: 0, y: -1, wall: "north" },
    right: { x: 1, y: 0, wall: "east" },
    down: { x: 0, y: 1, wall: "south" },
    left: { x: -1, y: 0, wall: "west" }
  };
  const step = steps[direction];
  if (!step || !validPosition(position, maze) || maze.cells[position.y][position.x].walls[step.wall]) return null;
  const next = { x: position.x + step.x, y: position.y + step.y };
  return validPosition(next, maze) ? next : null;
}

async function movePlayer(direction) {
  const room = state.room;
  const me = room?.players?.[state.player.id];
  if (!room || room.phase !== "playing" ||
      (room.navigatorId === state.player.id && orderedPlayers(room.players).length > 1) ||
      !me || me.escaped) return;
  const next = getStep(me.position, direction, room.maze);
  if (!next) {
    setNotice("A wall blocks that route.", "warning");
    return;
  }
  const isExit = next.x === room.maze.exit.x && next.y === room.maze.exit.y;
  if (state.roomId === "LOCAL") {
    me.position = next;
    if (isExit) me.escaped = true;
    const explorers = orderedPlayers(room.players).filter((player) => player.id !== room.navigatorId);
    if (explorers.length && explorers.every((player) => player.escaped)) {
      room.phase = "completed";
      room.completedAt = Date.now();
    }
    renderGame(room);
    if (isExit) setNotice("EXIT FOUND — stay with the group.", "success");
    return;
  }
  const update = { position: next };
  if (isExit) update.escaped = true;
  try {
    await state.roomRef.child("players").child(state.player.id).update(update);
    if (isExit) setNotice("EXIT FOUND — stay with the group.", "success");
    await checkForCompletion();
  } catch (error) {
    console.error("Could not synchronize movement.", error);
    setNotice("Movement did not sync. Check your connection.", "error");
  }
}

async function checkForCompletion() {
  const room = state.room;
  const livePlayers = orderedPlayers(room?.players);
  const liveExplorers = livePlayers.length === 1 ? livePlayers : livePlayers.filter((player) => player.id !== room.navigatorId);
  if (!room || room.phase !== "playing" || !liveExplorers.length || !liveExplorers.every((player) => player.escaped === true)) return;
  try {
    await state.roomRef.transaction((current) => {
      if (!current || current.phase !== "playing") return;
      const allLive = connectedPlayers(current.players || {});
      const stillPlaying = allLive.length === 1 ? allLive : allLive.filter((player) => player.id !== current.navigatorId);
      if (!stillPlaying.length || !stillPlaying.every((player) => player.escaped === true)) return;
      current.phase = "completed";
      current.completedAt = Date.now();
      return current;
    });
  } catch (error) {
    console.error("Could not record maze completion.", error);
    setNotice("The exit is reached, but completion could not be synchronized.", "error");
  }
}

async function startGame() {
  if (!isLocalHost() || !state.roomRef) return;
  const room = state.room;
  const players = orderedPlayers(room?.players);
  if (!validatePlayerCount(players)) {
    setNotice(players.length > PLAYER_LIMIT ? "The maze supports at most 8 players." : "At least 2 players are needed to begin.", "warning");
    return;
  }
  const now = Date.now();
  try {
    await state.roomRef.transaction((current) => {
      if (!current || current.phase === "playing") return;
      const live = orderedPlayers(current.players || {});
      if (!validatePlayerCount(live)) return;
      const selectedNavigator = live[Math.floor(Math.random() * live.length)];
      const sharedMaze = makeMaze();
      const resetPlayers = {};
      live.forEach((player) => {
        resetPlayers[player.id] = { ...player, escaped: false, position: { ...sharedMaze.start } };
      });
      current.phase = "playing";
      current.gameId = makeId();
      current.createdAt = now;
      current.navigatorId = selectedNavigator.id;
      current.maze = sharedMaze;
      current.players = resetPlayers;
      current.startedAt = now;
      current.completedAt = null;
      current.escapedCount = 0;
      current.messages = null;
      current.directions = null;
      current.marker = null;
      return current;
    });
  } catch (error) {
    console.error("Could not create the shared maze.", error);
    setNotice("Could not start the maze. Check Firebase database permissions.", "error");
  }
}

async function sendDirection(direction) {
  const targetId = document.getElementById("target-player")?.value;
  if (!targetId || !["up", "down", "left", "right"].includes(direction)) return;
  const target = playerRecord(targetId);
  if (!target || targetId === state.player.id) return;
  try {
    await state.roomRef.child("directions").push({
      targetPlayerId: targetId,
      senderId: state.player.id,
      senderName: state.player.name,
      direction,
      timestamp: Date.now()
    });
    setNotice(`Direction sent to ${target.name}.`, "success");
  } catch (error) {
    console.error("Could not send Navigator direction.", error);
    setNotice("Direction could not be delivered.", "error");
  }
}

async function sendChat(event) {
  event.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input?.value.trim().slice(0, 180);
  if (!text || (state.roomId !== "LOCAL" && !state.roomRef)) return;
  const now = Date.now();
  if (now - state.lastMessageAt < 700) {
    setNotice("Give the channel a moment before sending again.", "warning");
    return;
  }
  state.lastMessageAt = now;
  if (state.roomId === "LOCAL") {
    state.room.messages = {
      ...(state.room.messages || {}),
      [makeId()]: {
        playerId: state.player.id,
        playerName: state.player.name,
        color: state.player.color,
        text,
        timestamp: now
      }
    };
    renderGame(state.room);
    return;
  }
  try {
    await state.roomRef.child("messages").push({
      playerId: state.player.id,
      playerName: state.player.name,
      color: state.player.color,
      text,
      timestamp: now
    });
    input.value = "";
  } catch (error) {
    console.error("Could not send chat message.", error);
    setNotice("Message could not be sent.", "error");
  }
}

async function placeMarker(event) {
  const cell = event.currentTarget;
  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);
  const type = document.getElementById("marker-type")?.value || "GO HERE";
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  const marker = { x, y, type, senderId: state.player.id, expiresAt: Date.now() + 30000 };
  try {
    await state.roomRef.child("marker").set(marker);
    window.setTimeout(() => {
      state.roomRef?.child("marker").transaction((current) =>
        current?.expiresAt === marker.expiresAt ? null : current
      ).catch((error) => console.error("Could not expire map marker.", error));
    }, 30000);
    setNotice(`Marker placed: ${type}.`, "success");
  } catch (error) {
    console.error("Could not place map marker.", error);
    setNotice("Marker could not be shared.", "error");
  }
}

function updateChat(messages) {
  const list = document.getElementById("chat-messages");
  if (!list) return;
  const previousScroll = list.scrollTop;
  const nearBottom = list.scrollHeight - list.clientHeight - previousScroll < 80;
  const entries = Object.entries(messages || {}).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0)).slice(-25);
  list.innerHTML = `${entries.map(([id, message]) => renderMessage(id, message)).join("")}<div id="chat-end"></div>`;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function handleKeys(event) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  const directions = {
    ArrowUp: "up", w: "up", W: "up",
    ArrowRight: "right", d: "right", D: "right",
    ArrowDown: "down", s: "down", S: "down",
    ArrowLeft: "left", a: "left", A: "left"
  };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  movePlayer(direction);
}

function startLocalDemo() {
  state.localMode = true;
  const maze = makeMaze();
  const me = { ...state.player, connected: true, escaped: false, position: { ...maze.start } };
  state.roomId = "LOCAL";
  state.roomRef = null;
  state.connected = true;
  state.room = {
    phase: "playing", gameId: "local-demo", navigatorId: "local-guide", startedAt: Date.now(),
    maze, players: {
      "local-guide": { id: "local-guide", name: "Navigator 01", color: "#9bcbd0", connected: true, position: { ...maze.start } },
      [me.id]: me
    }, messages: {}
  };
  renderGame(state.room);
}

function bootstrapFirebase() {
  state.localMode = false;
  loadPlayer();
  renderConnecting();
  if (!window.firebase?.initializeApp || !window.firebase?.database) {
    renderError("Firebase could not load. Check your internet connection or the Firebase CDN.");
    return;
  }
  try {
    state.database = firebase.apps.length ? firebase.app().database() : firebase.initializeApp(firebaseConfig).database();
    state.roomRef = state.database.ref("mazeRoom");
    listenToConnection();
    state.roomRef.child("gameId").once("value").then(() => {
      if (state.localMode) return null;
      state.roomId = "main";
      return registerPlayer();
    }).then(() => {
      if (state.localMode) return;
      attachRoomListeners();
    }).catch((error) => {
      console.error("Firebase initialization or player join failed.", error);
      renderError("We could not reach the shared maze. Confirm that Realtime Database is enabled and its rules permit reads and writes.");
    });
  } catch (error) {
    console.error("Firebase setup failed.", error);
    renderError("Firebase could not be initialized. Check the project configuration.");
  }
}

document.addEventListener("keydown", handleKeys);
bootstrapFirebase();
