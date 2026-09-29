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
const PARTY_VISION = 2;
const SAFE_DISTANCE = 2;
const SEPARATION_GRACE_MS = 15000;
const MONSTER_MOVE_MS = 4500;
const MONSTER_DANGER_RADIUS = 3;
const PLAYER_STORAGE_KEY = "maze-of-many-player";
const ROOM_STORAGE_KEY = "maze-of-many-room";
const PLAYER_COLORS = ["#9bcbd0", "#d3b88d", "#b4a2d6", "#9ac49e", "#d0988a", "#98aed0", "#c7c08f", "#c08ea6"];
const DIRECTIONS = {
  up: { x: 0, y: -1, wall: "north", reverse: "down" },
  right: { x: 1, y: 0, wall: "east", reverse: "left" },
  down: { x: 0, y: 1, wall: "south", reverse: "up" },
  left: { x: -1, y: 0, wall: "west", reverse: "right" }
};
const appRoot = document.getElementById("app");
const state = {
  database: null,
  roomRef: null,
  presenceRef: null,
  player: null,
  connectionId: makeId(),
  roomCode: null,
  room: null,
  connected: false,
  localMode: false,
  roomLoaded: false,
  joined: false,
  countdownStarted: false,
  separationMonitor: null,
  monsterTimer: null,
  lastDirectionId: null,
  lastAnnouncedNavigator: null,
  lastGameId: null,
  notice: null,
  lastMessageAt: 0
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function sanitizeName(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
}

function safeColor(value) {
  return PLAYER_COLORS.includes(value) ? value : "#aeb9b4";
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadPlayer() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_STORAGE_KEY) || "null");
    if (saved && typeof saved.id === "string" && PLAYER_COLORS.includes(saved.color)) {
      const savedName = sanitizeName(saved.name);
      state.player = {
        id: saved.id,
        name: /^Player \d{2}$/.test(savedName) ? "" : savedName,
        color: saved.color
      };
    }
  } catch (error) {
    console.warn("Could not read the saved player profile.", error);
  }
  if (!state.player) {
    state.player = {
      id: makeId(),
      name: "",
      color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]
    };
  }
  persistPlayer();
  return state.player;
}

function persistPlayer() {
  if (state.player) localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(state.player));
}

function savedRoomCode() {
  return (localStorage.getItem(ROOM_STORAGE_KEY) || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function setNotice(message, kind = "info") {
  const duration = kind === "direction" ? 6000 : 4200;
  state.notice = { message, kind, expiresAt: Date.now() + duration };
  const region = document.getElementById("notice-region");
  if (region) region.innerHTML = noticeMarkup();
  clearTimeout(setNotice.timeout);
  setNotice.timeout = setTimeout(() => {
    state.notice = null;
    if (region?.isConnected) region.innerHTML = "";
  }, duration);
}

function noticeMarkup() {
  if (!state.notice || state.notice.expiresAt <= Date.now()) return "";
  return `<div class="notice notice-${state.notice.kind}" role="status">${escapeHtml(state.notice.message)}</div>`;
}

function restoreNotice() {
  const region = document.getElementById("notice-region");
  if (region) region.innerHTML = noticeMarkup();
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

function livingPlayers(players = {}) {
  return connectedPlayers(players).filter((player) => player.alive !== false);
}

function orderedPlayers(players = {}) {
  return connectedPlayers(players).sort((a, b) =>
    (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0) || String(a.id).localeCompare(String(b.id))
  );
}

function hasPresence(value) {
  return value === true || Boolean(value && typeof value === "object" && Object.values(value).some((connected) => connected === true));
}

function isLocalHost() {
  return orderedPlayers(state.room?.players)[0]?.id === state.player?.id;
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

function validPosition(position, maze) {
  return Boolean(position && Number.isInteger(position.x) && Number.isInteger(position.y) &&
    position.x >= 0 && position.y >= 0 && position.x < maze.width && position.y < maze.height);
}

function normalizeMaze(maze) {
  if (!maze || !Number.isInteger(maze.width) || !Number.isInteger(maze.height) ||
      maze.width < 2 || maze.height < 2 || maze.width > 31 || maze.height > 31 ||
      !Array.isArray(maze.cells) || maze.cells.length !== maze.height ||
      !validPosition(maze.start, maze) || !validPosition(maze.exit, maze)) return null;
  if (!maze.cells.every((row) => Array.isArray(row) && row.length === maze.width)) return null;
  return maze.cells.every((row) => row.every((cell) =>
    cell?.walls && ["north", "east", "south", "west"].every((wall) => typeof cell.walls[wall] === "boolean")
  )) ? maze : null;
}

function getStep(position, direction, maze) {
  const step = DIRECTIONS[direction];
  if (!step || !validPosition(position, maze) || maze.cells[position.y][position.x].walls[step.wall]) return null;
  const next = { x: position.x + step.x, y: position.y + step.y };
  return validPosition(next, maze) ? next : null;
}

function graphDistances(maze, origin) {
  const distances = new Map([[`${origin.x},${origin.y}`, 0]]);
  const queue = [origin];
  while (queue.length) {
    const current = queue.shift();
    const distance = distances.get(`${current.x},${current.y}`);
    for (const [direction, step] of Object.entries(DIRECTIONS)) {
      if (maze.cells[current.y][current.x].walls[step.wall]) continue;
      const next = { x: current.x + step.x, y: current.y + step.y };
      const key = `${next.x},${next.y}`;
      if (distances.has(key)) continue;
      distances.set(key, distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function nextMonsterPosition(room) {
  const monster = room.monster;
  const maze = room.maze;
  if (!monster || !validPosition(monster.position, maze)) return { x: maze.width - 1, y: maze.height - 1 };
  const target = room.groupPosition;
  const distances = graphDistances(maze, monster.position);
  const candidates = Object.keys(DIRECTIONS)
    .map((direction) => ({ direction, position: getStep(monster.position, direction, maze) }))
    .filter((candidate) => candidate.position);
  if (!candidates.length) return monster.position;
  const groupDistance = distances.get(`${target.x},${target.y}`) ?? Number.MAX_SAFE_INTEGER;
  if (groupDistance <= 8) {
    const fromGroup = graphDistances(maze, target);
    candidates.sort((a, b) =>
      (fromGroup.get(`${a.position.x},${a.position.y}`) ?? Number.MAX_SAFE_INTEGER) -
      (fromGroup.get(`${b.position.x},${b.position.y}`) ?? Number.MAX_SAFE_INTEGER)
    );
    return candidates[0].position;
  }
  const index = (Number(monster.stepCount) || 0) % candidates.length;
  return candidates[index].position;
}

function initialMonsterPosition(maze) {
  const fromStart = graphDistances(maze, maze.start);
  const fromExit = graphDistances(maze, maze.exit);
  const candidates = maze.cells.flat().filter((cell) =>
    !samePosition(cell, maze.start) && !samePosition(cell, maze.exit) &&
    (fromExit.get(`${cell.x},${cell.y}`) ?? 0) > MONSTER_DANGER_RADIUS + 1
  );
  candidates.sort((a, b) =>
    (fromStart.get(`${b.x},${b.y}`) ?? 0) - (fromStart.get(`${a.x},${a.y}`) ?? 0)
  );
  return candidates[0] ? { x: candidates[0].x, y: candidates[0].y } : { ...maze.exit };
}

function roomRefFor(code) {
  return state.database.ref(`rooms/${code}`);
}

function attachRealtimeListeners() {
  state.roomRef.on("value", (snapshot) => {
    if (state.localMode) return;
    state.room = snapshot.val() || null;
    state.roomLoaded = true;
    if (!state.room) {
      renderLanding("That room no longer exists. Create a room or check the code.");
      return;
    }
    reconcilePresence(state.room);
    reconcileNavigator(state.room);
    if (state.room.phase === "lobby") renderLobby(state.room);
    else if (state.room.phase === "countdown") renderCountdown(state.room);
    else if (["playing", "gameover", "escaped"].includes(state.room.phase) && normalizeMaze(state.room.maze)) renderGame(state.room);
    else renderLobby({ ...state.room, phase: "lobby" });
    handleRoomEvents(state.room);
    if (state.room.gameId && state.room.gameId !== state.lastGameId) {
      state.lastGameId = state.room.gameId;
      state.watchingAfterDeath = false;
    }
    const localRecord = state.room.players?.[state.player.id];
    if (localRecord?.separatedAt && state.separationNoticeAt !== localRecord.separatedAt) {
      state.separationNoticeAt = localRecord.separatedAt;
      setNotice("YOU ARE TOO FAR FROM THE GROUP.", "warning");
    } else if (!localRecord?.separatedAt) {
      state.separationNoticeAt = null;
    }
    if (state.room.phase === "playing") {
      maybeCompleteRoom();
      updateDangerState();
      if (state.room.navigatorId === state.player.id && state.room.players?.[state.player.id]?.alive !== false) startMonsterMovement();
      else stopMonsterMovement();
      if (state.room.navigatorId === state.player.id) startSeparationMonitor();
      else stopSeparationMonitor();
    } else {
      stopMonsterMovement();
      stopSeparationMonitor();
      document.body.classList.remove("danger-near");
    }
  }, (error) => {
    console.error("Firebase room listener failed.", error);
    renderError("Firebase refused access to this room. Verify Realtime Database is enabled and its rules permit the demo.");
  });

  state.roomRef.child("messages").limitToLast(30).on("value", (snapshot) => updateChat(snapshot.val() || {}), (error) => {
    console.error("Firebase chat listener failed.", error);
    setNotice("Chat could not connect. Check database permissions.", "error");
  });

  state.roomRef.child("directions").limitToLast(1).on("child_added", (snapshot) => {
    const data = snapshot.val();
    if (!data || snapshot.key === state.lastDirectionId ||
        !Number.isFinite(data.timestamp) || Date.now() - data.timestamp > 12000 ||
        !["up", "down", "left", "right", "stop", "wait"].includes(data.direction)) return;
    state.lastDirectionId = snapshot.key;
    setNotice(`NAVIGATOR → ALL  ·  ${data.direction === "stop" || data.direction === "wait" ? data.direction.toUpperCase() : `GO ${data.direction.toUpperCase()}`}`, "direction");
  });
}

function reconcilePresence(room) {
  if (!state.roomRef || !room?.players) return;
  const presence = room.presence || {};
  const updates = {};
  for (const [id, player] of Object.entries(room.players)) {
    if (!player || typeof player !== "object") continue;
    const connected = hasPresence(presence[id]);
    if (player.connected !== connected) updates[`players/${id}/connected`] = connected;
  }
  if (Object.keys(updates).length) state.roomRef.update(updates).catch((error) => console.error("Could not update room presence.", error));
}

function reconcileNavigator(room) {
  if (!state.roomRef || room.phase !== "playing") return;
  const alive = livingPlayers(room.players);
  if (!alive.length || alive.some((player) => player.id === room.navigatorId)) return;
  state.roomRef.child("navigatorId").transaction((currentId) => {
    const stillAlive = livingPlayers(state.room?.players || {});
    if (stillAlive.some((player) => player.id === currentId)) return currentId;
    return stillAlive[0]?.id || null;
  });
}

function claimPresence() {
  if (!state.connected || !state.roomRef || !state.player) return;
  state.presenceRef = state.roomRef.child("presence").child(state.player.id).child(state.connectionId);
  state.presenceRef.onDisconnect().remove()
    .then(() => state.presenceRef.set(true))
    .catch((error) => {
      console.error("Could not register disconnect presence.", error);
      setNotice("Presence could not be registered. Check database permissions.", "error");
    });
}

function handleRoomEvents(room) {
  const alive = livingPlayers(room.players);
  const currentNavigator = alive.find((player) => player.id === room.navigatorId);
  if (room.phase === "playing" && room.navigatorId && room.navigatorId !== state.lastAnnouncedNavigator) {
    if (state.lastAnnouncedNavigator) setNotice(`${currentNavigator?.name || "A survivor"} is now the Navigator.`, "warning");
    state.lastAnnouncedNavigator = room.navigatorId;
  }
  const closeToMonster = room.phase === "playing" && room.monster && room.groupPosition &&
    (graphDistances(room.maze, room.monster.position).get(`${room.groupPosition.x},${room.groupPosition.y}`) ?? Infinity) <= MONSTER_DANGER_RADIUS;
  if (closeToMonster && !state.wasNearMonster) setNotice("Something is near.", "warning");
  state.wasNearMonster = closeToMonster;
}

function renderNameEntry() {
  appRoot.innerHTML = `
    <section class="screen lobby-screen">
      <div class="lobby-layout">
        <div class="lobby-copy-block"><div class="eyebrow"><span class="pulse-dot"></span> Cooperative survival experiment</div><h1>THE MAZE<br /><span>OF MANY</span></h1><p class="intro-copy">You are not alone.<br />You cannot see everything.<br />Stay together. Stay away from what hunts you. Find the exit.</p></div>
        <form class="lobby-card onboarding-card" id="name-form"><span class="eyebrow">First contact</span><h2>BEFORE YOU ENTER</h2><p class="lobby-status">Tell us who you are.</p><label class="select-label" for="player-name">YOUR NAME</label><input class="lobby-input" id="player-name" name="name" maxlength="20" autocomplete="nickname" placeholder="e.g. Vansh" required /><p class="lobby-footnote">Use up to 20 characters. No account or personal details needed.</p><button class="primary-btn" type="submit">Continue <span>↗</span></button></form>
      </div>
    </section>`;
  const input = document.getElementById("player-name");
  input.value = state.player?.name || "";
  document.getElementById("name-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = sanitizeName(input.value);
    if (!name) {
      input.setCustomValidity("Enter a name before continuing.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    state.player.name = name;
    persistPlayer();
    if (savedRoomCode() && state.database) joinRoom(savedRoomCode());
    else renderLanding();
  });
}

function renderLanding(errorMessage = "") {
  if (!state.player?.name) {
    renderNameEntry();
    return;
  }
  const room = savedRoomCode();
  appRoot.innerHTML = `
    <section class="screen lobby-screen"><div class="lobby-layout">
      <div class="lobby-copy-block"><div class="eyebrow"><span class="pulse-dot"></span> Cooperative survival experiment</div><h1>THE MAZE<br /><span>OF MANY</span></h1><p class="intro-line">STAY TOGETHER. STAY AWAY FROM THE MONSTER. FIND THE EXIT.</p><p class="intro-copy">You are not alone.<br />You cannot see everything.<br />Stay together. Survive.</p><div class="rule-line"><span>01</span><p>The group moves as one.</p></div><div class="rule-line"><span>02</span><p>One Navigator sees the whole maze.</p></div></div>
      <section class="lobby-card"><span class="eyebrow">Welcome, ${escapeHtml(state.player.name)}</span><h2>CHOOSE YOUR ROOM</h2>${errorMessage ? `<p class="form-error">${escapeHtml(errorMessage)}</p>` : ""}<button id="create-room" class="primary-btn">Create a room <span>↗</span></button><div class="form-divider">OR JOIN AN EXISTING ROOM</div><form id="join-room-form"><label class="select-label" for="room-code">ROOM CODE</label><input class="lobby-input room-code-input" id="room-code" maxlength="4" autocomplete="off" placeholder="7K4P" value="${escapeHtml(room)}" required/><button class="secondary-btn" type="submit">Join room <span>↗</span></button></form><button id="change-name" class="text-btn">Change name</button></section>
    </div></section>`;
  document.getElementById("create-room").addEventListener("click", createRoom);
  document.getElementById("join-room-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = document.getElementById("room-code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      renderLanding("Enter the four-character room code.");
      return;
    }
    joinRoom(code);
  });
  document.getElementById("change-name").addEventListener("click", () => renderNameEntry());
}

function generateRoomCode() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

async function createRoom() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRoomCode();
    const roomRef = roomRefFor(code);
    try {
      const result = await roomRef.transaction((current) => {
        if (current) return;
        return {
          code,
          phase: "lobby",
          createdAt: Date.now(),
          players: {},
          presence: {},
          messages: {},
          directions: {}
        };
      });
      if (result.committed) {
        await joinRoom(code);
        return;
      }
    } catch (error) {
      console.error("Could not create a room.", error);
      renderLanding("Could not create a room. Check Firebase database permissions.");
      return;
    }
  }
  renderLanding("Could not reserve a unique room code. Please try again.");
}

async function joinRoom(code) {
  if (!state.database || state.joined) return;
  state.joined = true;
  state.roomCode = code;
  state.roomRef = roomRefFor(code);
  localStorage.setItem(ROOM_STORAGE_KEY, code);
  renderConnecting(`Joining room ${code}…`);
  try {
    const snapshot = await state.roomRef.once("value");
    if (!snapshot.exists()) {
      state.joined = false;
      state.roomRef = null;
      renderLanding(`Room ${code} was not found. Check the code or create a room.`);
      return;
    }
    const room = snapshot.val();
    const online = snapshot.child("presence").val() || {};
    const occupied = Object.values(online).filter(hasPresence).length;
    if (occupied >= PLAYER_LIMIT && !hasPresence(online[state.player.id])) {
      state.joined = false;
      state.roomRef = null;
      renderLanding(`Room ${code} is full. The maximum is 8 connected players.`);
      return;
    }
    const color = PLAYER_COLORS.find((candidate) =>
      !Object.entries(room.players || {}).some(([id, player]) => id !== state.player.id && hasPresence(online[id]) && player?.color === candidate)
    ) || state.player.color;
    state.player.color = color;
    persistPlayer();
    const position = room.groupPosition || room.maze?.start || { x: 0, y: 0 };
    state.presenceRef = state.roomRef.child("presence").child(state.player.id).child(state.connectionId);
    await state.presenceRef.onDisconnect().remove();
    await state.presenceRef.set(true);
    const latestPresenceSnapshot = await state.roomRef.child("presence").once("value");
    const latestPresence = latestPresenceSnapshot.val() || {};
    const latestOccupiedCount = Object.values(latestPresence).filter(hasPresence).length;
    const playersRef = state.roomRef.child("players");
    const registration = await playersRef.transaction((currentPlayers) => {
      const records = currentPlayers || {};
      const currentPlayer = records[state.player.id];
      if (latestOccupiedCount > PLAYER_LIMIT) return;
      for (const [id, player] of Object.entries(records)) {
        if (player && typeof player === "object") player.connected = hasPresence(latestPresence[id]);
      }
      records[state.player.id] = {
        id: state.player.id,
        name: state.player.name,
        color: state.player.color,
        joinedAt: currentPlayer?.joinedAt || Date.now(),
        connected: true,
        alive: currentPlayer?.alive !== false,
        separatedAt: null,
        position: room.groupPosition || currentPlayer?.position || position,
        escaped: currentPlayer?.escaped === true
      };
      return records;
    });
    if (!registration.committed) {
      await state.presenceRef.remove();
      state.joined = false;
      state.roomRef = null;
      renderLanding(`Room ${code} is full. The maximum is 8 connected players.`);
      return;
    }
    attachRealtimeListeners();
  } catch (error) {
    console.error("Could not join the requested room.", error);
    state.joined = false;
    state.roomRef = null;
    renderLanding("Could not join that room. Check your connection and database permissions.");
  }
}

function renderLobby(room) {
  const players = orderedPlayers(room.players);
  const full = players.length >= PLAYER_LIMIT;
  const host = players[0]?.id === state.player.id;
  const canStart = players.length >= 2 && players.length <= PLAYER_LIMIT && host && state.connected;
  const rows = players.length
    ? players.map((player) => `<li class="player-row"><span class="player-dot" style="--player-color:${safeColor(player.color)}"></span><span>${escapeHtml(player.name)}</span><span class="player-role">${escapeHtml(player.id === room.navigatorId ? "Navigator" : "Survivor")}</span><span class="online-dot" aria-label="Online"></span></li>`).join("")
    : `<li class="empty-row">Waiting for survivors…</li>`;
  appRoot.innerHTML = `<section class="screen lobby-screen"><div class="lobby-layout"><div class="lobby-copy-block"><div class="eyebrow"><span class="pulse-dot"></span> Room ${escapeHtml(state.roomCode)}</div><h1>THE MAZE<br /><span>OF MANY</span></h1><p class="intro-line">STAY TOGETHER. STAY AWAY FROM THE MONSTER.</p><p class="intro-copy">The group moves as one.<br />Only the Navigator sees the way.</p></div><section class="lobby-card"><div class="lobby-card-header"><span class="eyebrow">Room code</span><button class="copy-code text-btn" id="copy-room-code">${escapeHtml(state.roomCode)} · COPY</button></div><div class="player-count"><strong>${players.length}</strong><span>/ ${PLAYER_LIMIT}<small>PLAYERS</small></span></div><ul class="player-list">${rows}</ul><p class="lobby-status">${full ? "Room full." : players.length < 2 ? "Waiting for at least one more player…" : host ? "The group is ready. Start the survival run." : "Waiting for the room host to begin."}</p><button id="start-game" class="primary-btn" ${canStart ? "" : "disabled"}>${full ? "Room full" : "Begin the survival run"} <span>↗</span></button><p class="lobby-footnote">${full ? "Maximum 8 players." : "Share the room code so your group can join."}</p><button id="leave-room" class="text-btn">Leave room</button></section></div><div id="notice-region" class="notice-region"></div></section>`;
  document.getElementById("start-game")?.addEventListener("click", startCountdown);
  document.getElementById("copy-room-code")?.addEventListener("click", copyRoomCode);
  document.getElementById("leave-room")?.addEventListener("click", leaveRoom);
  restoreNotice();
}

function copyRoomCode() {
  navigator.clipboard?.writeText(state.roomCode).then(
    () => setNotice(`Room code ${state.roomCode} copied.`, "success"),
    (error) => {
      console.error("Could not copy the room code.", error);
      setNotice(`Share room code ${state.roomCode} with your group.`, "info");
    }
  );
}

async function leaveRoom() {
  try {
    await state.presenceRef?.remove();
    const remainingPresence = await state.roomRef?.child("presence").child(state.player.id).once("value");
    if (!hasPresence(remainingPresence?.val())) {
      await state.roomRef?.child("players").child(state.player.id).remove();
    }
  } catch (error) {
    console.error("Could not leave the room cleanly.", error);
  }
  state.roomRef?.off();
  state.roomRef?.child("messages").off();
  state.roomRef?.child("directions").off();
  state.roomRef = null;
  state.presenceRef = null;
  state.room = null;
  state.roomCode = null;
  state.joined = false;
  localStorage.removeItem(ROOM_STORAGE_KEY);
  renderLanding();
}

function startCountdown() {
  if (!isLocalHost() || orderedPlayers(state.room?.players).length < 2) return;
  const maze = makeMaze();
  const now = Date.now();
  const monsterStart = initialMonsterPosition(maze);
  state.roomRef.transaction((room) => {
    if (!room || !["lobby", "gameover", "escaped"].includes(room.phase)) return;
    const currentPlayers = orderedPlayers(room.players || {});
    if (currentPlayers.length < 2 || currentPlayers.length > PLAYER_LIMIT) return;
    const navigatorPlayer = currentPlayers[Math.floor(Math.random() * currentPlayers.length)];
    const living = {};
    currentPlayers.forEach((player) => {
      living[player.id] = { ...player, alive: true, escaped: false, position: { ...maze.start }, separatedAt: null };
    });
    room.phase = "countdown";
    room.navigatorId = navigatorPlayer.id;
    room.maze = maze;
    room.groupPosition = { ...maze.start };
    room.monster = { position: monsterStart, stepCount: 0, lastMovedAt: now };
    room.players = { ...(room.players || {}), ...living };
    room.startedAt = now;
    room.countdownUntil = now + 3000;
    room.moveCount = 0;
    room.monsterPressure = 0;
    room.winner = null;
    room.finishedAt = null;
    room.messages = {};
    room.directions = {};
    return room;
  }).catch((error) => {
    console.error("Could not start the room game.", error);
    setNotice("Could not start the run. Check Firebase permissions.", "error");
  });
}

function beginAfterCountdown() {
  state.roomRef?.transaction((room) => {
    if (!room || room.phase !== "countdown" || room.countdownUntil > Date.now()) return;
    room.phase = "playing";
    return room;
  }).catch((error) => console.error("Could not complete the game countdown.", error));
}

function renderCountdown(room) {
  const seconds = Math.max(1, Math.ceil((room.countdownUntil - Date.now()) / 1000));
  appRoot.innerHTML = `<section class="countdown-screen"><div class="eyebrow">ROOM ${escapeHtml(state.roomCode)} · SURVIVE TOGETHER</div><div class="countdown-number">${seconds}</div><p>THE GROUP IS ENTERING THE MAZE</p></section>`;
  if (!state.countdownStarted) {
    state.countdownStarted = true;
    const countdownTimer = setInterval(() => {
      if (state.room?.phase !== "countdown") {
        clearInterval(countdownTimer);
        state.countdownStarted = false;
        return;
      }
      if (Date.now() >= state.room.countdownUntil) {
        clearInterval(countdownTimer);
        state.countdownStarted = false;
        beginAfterCountdown();
        return;
      }
      renderCountdown(state.room);
    }, 250);
  }
}

function renderFormation(players, groupPosition) {
  const survivors = livingPlayers(players);
  const offsets = {
    1: [[0, 0]],
    2: [[-7, 0], [7, 0]],
    3: [[0, -7], [-7, 7], [7, 7]],
    4: [[-7, -7], [7, -7], [-7, 7], [7, 7]],
    5: [[0, -9], [-9, 0], [9, 0], [-6, 9], [6, 9]],
    6: [[-8, -7], [0, -7], [8, -7], [-8, 7], [0, 7], [8, 7]],
    7: [[0, -10], [-8, -5], [8, -5], [-10, 5], [0, 5], [10, 5], [0, 12]],
    8: [[-8, -8], [0, -8], [8, -8], [-8, 0], [8, 0], [-8, 8], [0, 8], [8, 8]]
  }[Math.min(survivors.length, 8)] || [];
  return survivors.map((player, index) => {
    const [dx, dy] = offsets[index] || [0, 0];
    return `<span class="party-member ${player.id === state.player.id ? "party-self" : ""}" style="--player-color:${safeColor(player.color)};--party-x:${dx}px;--party-y:${dy}px" title="${escapeHtml(player.name)}">${escapeHtml(player.name.slice(0, 2).toUpperCase())}</span>`;
  }).join("");
}

function markerForCell(room, x, y, isNavigator) {
  const group = room.groupPosition;
  const players = livingPlayers(room.players || {});
  let marker = "";
  if (group?.x === x && group?.y === y) marker = `<span class="party-formation">${renderFormation(room.players, group)}</span>`;
  if (isNavigator && room.monster?.position?.x === x && room.monster?.position?.y === y) {
    marker += `<span class="monster-marker" title="The Monster"><i></i><i></i></span>`;
  }
  if (isNavigator && room.maze.exit.x === x && room.maze.exit.y === y) marker += `<span class="exit-marker">◇</span>`;
  return `${marker}<span class="cell-player-names">${players.filter((player) => group?.x === x && group?.y === y).map((player) => escapeHtml(player.name)).join(" · ")}</span>`;
}

function isCellVisible(room, x, y, isNavigator) {
  if (isNavigator) return true;
  const position = room.groupPosition;
  return Math.abs(position.x - x) <= PARTY_VISION && Math.abs(position.y - y) <= PARTY_VISION;
}

function renderMaze(room, isNavigator) {
  const maze = room.maze;
  const group = validPosition(room.groupPosition, maze) ? room.groupPosition : maze.start;
  const bounds = isNavigator
    ? { minX: 0, maxX: maze.width - 1, minY: 0, maxY: maze.height - 1 }
    : {
        minX: Math.max(0, group.x - PARTY_VISION - 1), maxX: Math.min(maze.width - 1, group.x + PARTY_VISION + 1),
        minY: Math.max(0, group.y - PARTY_VISION - 1), maxY: Math.min(maze.height - 1, group.y + PARTY_VISION + 1)
      };
  const cells = [];
  const dangerDistances = isNavigator && room.monster?.position
    ? graphDistances(maze, room.monster.position)
    : new Map();
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const cell = maze.cells[y][x];
      const visible = isCellVisible(room, x, y, isNavigator);
      const danger = isNavigator && (dangerDistances.get(`${x},${y}`) ?? Infinity) <= MONSTER_DANGER_RADIUS;
      const wallStyles = [
        ["north", "border-top"], ["east", "border-right"], ["south", "border-bottom"], ["west", "border-left"]
      ].map(([wall, property]) => `${property}:${cell.walls[wall] ? "2px solid var(--wall)" : "2px solid transparent"}`).join(";");
      cells.push(`<div class="maze-cell ${visible ? "revealed" : "fogged"} ${danger ? "danger-cell" : ""} ${room.groupPosition?.x === x && room.groupPosition?.y === y ? "party-cell" : ""} ${isNavigator && room.monster?.position?.x === x && room.monster?.position?.y === y ? "monster-cell" : ""}" style="${wallStyles}" aria-label="${visible ? `Cell ${x + 1}, ${y + 1}${danger ? ", monster danger zone" : ""}` : "Unexplored"}">${visible ? markerForCell(room, x, y, isNavigator) : ""}</div>`);
    }
  }
  return `<div class="maze-viewport" tabindex="0"><div class="maze-grid ${isNavigator ? "full-map" : "local-map"}" style="--columns:${bounds.maxX - bounds.minX + 1};--cell:27px">${cells.join("")}</div></div>`;
}

function renderPlayerPanel(room, isNavigator) {
  const players = orderedPlayers(room.players);
  const alive = players.filter((player) => player.alive !== false);
  const canControl = isNavigator && room.players?.[state.player.id]?.alive !== false;
  return `<section class="side-section"><div class="section-heading"><span>SURVIVORS</span><span>${alive.length} / ${players.length}</span></div><div class="live-player-list">${players.map((player) => `<div class="live-player ${player.alive === false ? "player-dead" : ""}"><span class="player-dot" style="--player-color:${safeColor(player.color)}"></span><span class="live-player-name">${escapeHtml(player.name)}${player.id === room.navigatorId ? " <i>NAVIGATOR</i>" : ""}</span><span class="player-state">${player.connected ? player.alive === false ? "LOST" : player.separatedAt ? "TOO FAR" : player.escaped ? "OUT" : "ALIVE" : "OFFLINE"}</span></div>`).join("")}</div><div class="escape-progress"><span>GROUP LOCATION</span><strong>${String((room.groupPosition?.x ?? 0) + 1).padStart(2, "0")} : ${String((room.groupPosition?.y ?? 0) + 1).padStart(2, "0")}</strong></div>${canControl ? `<div class="movement-controls"><span class="select-label">MOVE THE GROUP</span><div class="direction-grid"><button data-move="up" aria-label="Move up">↑</button><button data-move="left" aria-label="Move left">←</button><button data-move="down" aria-label="Move down">↓</button><button data-move="right" aria-label="Move right">→</button></div><div class="wait-controls"><button data-direction="wait">WAIT</button><button data-direction="stop">STOP</button></div></div>` : ""}</section>`;
}

function renderChat(room) {
  const messages = Object.entries(room.messages || {}).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0)).slice(-25);
  return `<section class="chat-section"><div class="section-heading"><span>FIELD NOTES</span><span class="live-label">LIVE</span></div><div class="chat-messages" id="chat-messages">${messages.map(([id, message]) => renderMessage(id, message)).join("")}<div id="chat-end"></div></div><form id="chat-form" class="chat-form"><input id="chat-input" maxlength="180" autocomplete="off" placeholder="Send a message…" aria-label="Chat message" /><button type="submit" aria-label="Send message">↗</button></form></section>`;
}

function renderMessage(id, message) {
  return `<div class="chat-message" data-message-id="${escapeHtml(id)}"><span class="chat-author" style="--player-color:${safeColor(message.color)}">${escapeHtml(message.playerName || "Player")}</span><span>${escapeHtml(message.text || "")}</span></div>`;
}

function renderGame(room) {
  const me = room.players?.[state.player.id];
  if (!me) {
    appRoot.innerHTML = `<section class="screen"><div class="loading-card"><h1>REJOINING THE MAZE</h1><p>Restoring your place in the group…</p></div></section>`;
    return;
  }
  const isNavigator = room.navigatorId === state.player.id;
  const alive = me.alive !== false;
  const survivorCount = livingPlayers(room.players).length;
  const explorers = orderedPlayers(room.players);
  const near = room.phase === "playing" && monsterDistance(room) <= MONSTER_DANGER_RADIUS;
  document.body.classList.toggle("danger-near", near);
  appRoot.innerHTML = `<section class="game-screen ${near ? "danger-near" : ""}">
    <header class="game-topbar"><div><span class="eyebrow"><span class="pulse-dot"></span> ${state.connected ? "SYNCHRONIZED" : "RECONNECTING"} · ROOM ${escapeHtml(state.roomCode)}</span><h1>THE MAZE <span>OF MANY</span></h1></div><div class="game-top-meta"><span>RUN <strong>${escapeHtml(String(room.gameId || "").slice(-5).toUpperCase())}</strong></span><button id="leave-room" class="text-btn">LEAVE</button></div></header>
    <div class="game-layout ${isNavigator ? "navigator-layout" : "explorer-layout"}"><main class="map-column"><div class="map-heading"><div><span class="eyebrow">${isNavigator ? "Navigator / tactical view" : "Explorer / field view"}</span><p>${isNavigator ? "You are part of the party. Guide everyone through the maze." : "Stay with the group. The Navigator sees beyond the fog."}</p></div><span class="map-coordinates">${String((room.groupPosition?.x ?? 0) + 1).padStart(2, "0")} / ${String((room.groupPosition?.y ?? 0) + 1).padStart(2, "0")}</span></div>${renderMaze(room, isNavigator)}<div class="map-legend"><span><i class="legend-you" style="--player-color:${safeColor(state.player.color)}"></i> PARTY (${livingPlayers(room.players).length})</span>${isNavigator ? `<span><i class="legend-monster"></i> MONSTER / ${MONSTER_DANGER_RADIUS} CELL THREAT</span><span><i class="legend-exit"></i> EXIT</span>` : `<span class="fog-legend">UNEXPLORED</span><span class="party-hint">THE WHOLE GROUP MOVES TOGETHER</span>`}</div>${isNavigator && alive ? `<div class="mobile-controls"><div class="direction-pad"><button data-move="up">↑</button><button data-move="left">←</button><button data-move="down">↓</button><button data-move="right">→</button></div><span class="control-hint">MOVE THE GROUP</span></div>` : ""}</main><aside class="control-column"><div class="role-card"><span class="eyebrow">Your role</span><strong>${isNavigator ? "THE NAVIGATOR" : "AN EXPLORER"}</strong><span>${escapeHtml(isNavigator ? "You are their eyes. The group moves when you move." : `Together with ${survivorCount} survivor${survivorCount === 1 ? "" : "s"}.`)}</span></div>${renderPlayerPanel(room, isNavigator)}${renderChat(room)}</aside></div>
    ${!alive && room.phase === "playing" && !state.watchingAfterDeath ? `<div class="completion-overlay"><div class="completion-card"><span class="eyebrow">Signal lost</span><h2>YOU WERE<br /><span>LOST.</span></h2><p>You can still watch the survivors find their way.</p><button id="watch-game" class="primary-btn">Watch the group <span>↗</span></button></div></div>` : ""}
    ${room.phase === "gameover" ? `<div class="completion-overlay"><div class="completion-card"><span class="eyebrow">No survivors remain</span><h2>THE MAZE<br /><span>HAS CLAIMED YOU.</span></h2><p>The group did not make it out.</p><button id="retry-game" class="primary-btn">${isLocalHost() ? "Try again" : "Waiting for the host"} <span>↗</span></button></div></div>` : ""}
    ${room.phase === "escaped" ? `<div class="completion-overlay"><div class="completion-card"><span class="eyebrow">Run ${formatDuration((room.finishedAt || Date.now()) - room.startedAt)}</span><h2>YOU<br /><span>ESCAPED.</span></h2><p>SURVIVORS: ${survivorCount} / ${explorers.length}</p><button id="retry-game" class="primary-btn" ${isLocalHost() ? "" : "disabled"}>${isLocalHost() ? "Enter another maze" : "Waiting for the host"} <span>↗</span></button></div></div>` : ""}
    <div id="notice-region" class="notice-region"></div>
  </section>`;
  document.getElementById("leave-room")?.addEventListener("click", leaveRoom);
  document.getElementById("chat-form")?.addEventListener("submit", sendChat);
  document.getElementById("retry-game")?.addEventListener("click", startCountdown);
  document.getElementById("watch-game")?.addEventListener("click", () => {
    state.watchingAfterDeath = true;
    document.querySelector(".completion-overlay")?.remove();
  });
  document.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => moveGroup(button.dataset.move)));
  document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => sendDirection(button.dataset.direction)));
  restoreNotice();
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function monsterDistance(room) {
  if (!room?.monster?.position || !room?.groupPosition || !normalizeMaze(room.maze)) return Infinity;
  return graphDistances(room.maze, room.monster.position).get(`${room.groupPosition.x},${room.groupPosition.y}`) ?? Infinity;
}

function updateDangerState() {
  if (!state.room || state.room.phase !== "playing") return;
  const close = monsterDistance(state.room) <= MONSTER_DANGER_RADIUS;
  document.body.classList.toggle("danger-near", close);
  if (close && !state.wasNearMonster) setNotice("SOMETHING IS NEAR.", "warning");
  state.wasNearMonster = close;
}

function moveGroup(direction) {
  if (!DIRECTIONS[direction] || !state.roomRef || state.localMode) {
    if (DIRECTIONS[direction] && state.localMode) moveLocalGroup(direction);
    return;
  }
  if (state.room?.phase !== "playing" || state.room.navigatorId !== state.player.id ||
      state.room.players?.[state.player.id]?.alive === false) return;
  state.roomRef.transaction((room) => {
    if (!room || room.phase !== "playing" || room.navigatorId !== state.player.id) return;
    const nextPosition = getStep(room.groupPosition, direction, room.maze);
    if (!nextPosition) return;
    room.groupPosition = nextPosition;
    room.moveCount = (Number(room.moveCount) || 0) + 1;
    for (const player of Object.values(room.players || {})) {
      if (player?.connected && player.alive !== false) player.position = nextPosition;
    }
    if (room.moveCount % 2 === 0) {
      room.monster = {
        ...room.monster,
        position: nextMonsterPosition(room),
        stepCount: (Number(room.monster?.stepCount) || 0) + 1,
        lastMovedAt: Date.now()
      };
    }
    const distance = graphDistances(room.maze, room.monster.position).get(`${nextPosition.x},${nextPosition.y}`) ?? Infinity;
    room.monsterPressure = distance <= 1 ? (Number(room.monsterPressure) || 0) + 1 : 0;
    if (room.monsterPressure >= 3) {
      const survivors = livingPlayers(room.players);
      const victim = survivors[Math.floor(Math.random() * survivors.length)];
      if (victim) {
        victim.alive = false;
        victim.lostAt = Date.now();
      }
      room.monsterPressure = 0;
      const remaining = livingPlayers(room.players);
      if (!remaining.length) {
        room.phase = "gameover";
        room.finishedAt = Date.now();
      } else if (!remaining.some((player) => player.id === room.navigatorId)) {
        room.navigatorId = remaining[0].id;
      }
    }
    if (samePosition(nextPosition, room.maze.exit)) {
      room.phase = "escaped";
      room.finishedAt = Date.now();
    }
    return room;
  }).then((result) => {
    if (!result.committed && state.room?.phase === "playing") setNotice("PATH BLOCKED", "warning");
  }).catch((error) => {
    console.error("Could not move the party.", error);
    setNotice("Movement did not sync. Check the connection.", "error");
  });
}

function samePosition(a, b) {
  return a?.x === b?.x && a?.y === b?.y;
}

function moveLocalGroup(direction) {
  const room = state.room;
  if (!room || room.phase !== "playing") return;
  const next = getStep(room.groupPosition, direction, room.maze);
  if (!next) {
    setNotice("PATH BLOCKED", "warning");
    return;
  }
  room.groupPosition = next;
  room.moveCount += 1;
  for (const player of Object.values(room.players)) {
    if (player.alive !== false) player.position = next;
  }
  if (room.moveCount % 2 === 0) {
    room.monster.position = nextMonsterPosition(room);
    room.monster.stepCount += 1;
  }
  const distance = monsterDistance(room);
  room.monsterPressure = distance <= 1 ? room.monsterPressure + 1 : 0;
  if (room.monsterPressure >= 3) {
    const victim = livingPlayers(room.players).find((player) => player.id !== room.navigatorId) || livingPlayers(room.players)[0];
    if (victim) victim.alive = false;
    room.monsterPressure = 0;
  }
  if (!livingPlayers(room.players).length) room.phase = "gameover";
  else if (!livingPlayers(room.players).some((player) => player.id === room.navigatorId)) {
    room.navigatorId = livingPlayers(room.players)[0].id;
    setNotice(`${room.players[room.navigatorId].name} is now the Navigator.`, "warning");
  }
  else if (samePosition(next, room.maze.exit)) room.phase = "escaped";
  if (room.phase !== "playing") room.finishedAt = Date.now();
  renderGame(room);
  updateDangerState();
}

function startMonsterMovement() {
  if (state.monsterTimer || state.localMode) return;
  state.monsterTimer = setInterval(() => {
    if (!state.roomRef || state.room?.phase !== "playing" || state.room.navigatorId !== state.player.id ||
        state.room.players?.[state.player.id]?.alive === false) {
      stopMonsterMovement();
      return;
    }
    state.roomRef.transaction((room) => {
      if (!room || room.phase !== "playing" || room.navigatorId !== state.player.id ||
          room.players?.[state.player.id]?.alive === false ||
          Date.now() - (Number(room.monster?.lastMovedAt) || 0) < MONSTER_MOVE_MS) return;
      room.monster = {
        ...room.monster,
        position: nextMonsterPosition(room),
        stepCount: (Number(room.monster?.stepCount) || 0) + 1,
        lastMovedAt: Date.now()
      };
      return room;
    }).catch((error) => console.error("Monster movement could not synchronize.", error));
  }, 1000);
}

function stopMonsterMovement() {
  if (state.monsterTimer) clearInterval(state.monsterTimer);
  state.monsterTimer = null;
}

function checkSeparation() {
  const room = state.room;
  if (!room || room.phase !== "playing" || !room.groupPosition) return;
  const now = Date.now();
  const updates = {};
  let markedDeath = false;
  for (const [id, player] of Object.entries(room.players || {})) {
    if (!player?.connected || player.alive === false) continue;
    const position = player.position;
    const distance = position ? Math.abs(position.x - room.groupPosition.x) + Math.abs(position.y - room.groupPosition.y) : 0;
    if (distance <= SAFE_DISTANCE) {
      if (player.separatedAt) updates[`players/${id}/separatedAt`] = null;
      continue;
    }
    if (!player.separatedAt) updates[`players/${id}/separatedAt`] = now;
    else if (now - player.separatedAt > SEPARATION_GRACE_MS) {
      updates[`players/${id}/alive`] = false;
      updates[`players/${id}/lostAt`] = now;
      markedDeath = true;
    }
  }
  if (Object.keys(updates).length && state.roomRef) {
    state.roomRef.update(updates).then(() => {
      if (markedDeath) {
        setNotice("A survivor lost connection to the group.", "warning");
        const alive = livingPlayers(state.room?.players || {});
        if (!alive.length) state.roomRef?.child("phase").set("gameover");
      }
    }).catch((error) => console.error("Could not update separated player state.", error));
  }
}

function startSeparationMonitor() {
  if (state.separationMonitor) return;
  state.separationMonitor = setInterval(checkSeparation, 1000);
}

function stopSeparationMonitor() {
  if (state.separationMonitor) clearInterval(state.separationMonitor);
  state.separationMonitor = null;
}

function maybeCompleteRoom() {
  const room = state.room;
  if (!room || room.phase !== "playing") return;
  const survivors = livingPlayers(room.players);
  if (!survivors.length) {
    state.roomRef.child("phase").set("gameover");
    state.roomRef.child("finishedAt").set(Date.now());
    return;
  }
  if (samePosition(room.groupPosition, room.maze.exit)) {
    state.roomRef.transaction((current) => {
      if (!current || current.phase !== "playing" || !samePosition(current.groupPosition, current.maze.exit)) return;
      current.phase = "escaped";
      current.finishedAt = Date.now();
      return current;
    });
  }
}

async function sendDirection(direction) {
  if (!state.roomRef || state.room?.navigatorId !== state.player.id ||
      !["up", "down", "left", "right", "stop", "wait"].includes(direction)) return;
  try {
    await state.roomRef.child("directions").push({
      senderId: state.player.id,
      senderName: state.player.name,
      direction,
      timestamp: Date.now()
    });
    setNotice(direction === "stop" || direction === "wait" ? `GROUP: ${direction.toUpperCase()}` : `GROUP: GO ${direction.toUpperCase()}`, "success");
  } catch (error) {
    console.error("Could not send direction.", error);
    setNotice("Direction could not be delivered.", "error");
  }
}

async function sendChat(event) {
  event.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input?.value.trim().slice(0, 180);
  if (!text || (!state.roomRef && !state.localMode)) return;
  const now = Date.now();
  if (now - state.lastMessageAt < 700) {
    setNotice("Give the channel a moment before sending again.", "warning");
    return;
  }
  state.lastMessageAt = now;
  if (state.localMode) {
    state.room.messages = {
      ...(state.room.messages || {}),
      [makeId()]: { playerId: state.player.id, playerName: state.player.name, color: state.player.color, text, timestamp: now }
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
    console.error("Could not send chat.", error);
    setNotice("Message could not be sent.", "error");
  }
}

function updateChat(messages) {
  const list = document.getElementById("chat-messages");
  if (!list) return;
  const nearBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 80;
  const entries = Object.entries(messages || {}).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0)).slice(-25);
  list.innerHTML = `${entries.map(([id, message]) => renderMessage(id, message)).join("")}<div id="chat-end"></div>`;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function handleKeys(event) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  const keyToDirection = {
    ArrowUp: "up", w: "up", W: "up", ArrowRight: "right", d: "right", D: "right",
    ArrowDown: "down", s: "down", S: "down", ArrowLeft: "left", a: "left", A: "left"
  };
  const direction = keyToDirection[event.key];
  if (!direction || state.room?.navigatorId !== state.player?.id ||
      state.room.players?.[state.player.id]?.alive === false) return;
  event.preventDefault();
  moveGroup(direction);
}

function startLocalDemo() {
  const maze = makeMaze();
  state.localMode = true;
  state.roomCode = "DEMO";
  state.room = {
    phase: "playing",
    gameId: "local-demo",
    navigatorId: state.player.id,
    startedAt: Date.now(),
    groupPosition: { ...maze.start },
    moveCount: 0,
    monsterPressure: 0,
    monster: { position: initialMonsterPosition(maze), stepCount: 0, lastMovedAt: Date.now() },
    maze,
    players: {
      [state.player.id]: { ...state.player, connected: true, alive: true, escaped: false, position: { ...maze.start } },
      demo: { id: "demo", name: "Player Two", color: PLAYER_COLORS[1], connected: true, alive: true, escaped: false, position: { ...maze.start } }
    },
    messages: {}
  };
  renderGame(state.room);
}

function bootstrap() {
  loadPlayer();
  if (!window.firebase?.initializeApp || !window.firebase?.database) {
    renderError("Firebase could not load. Check your internet connection or Firebase CDN access.");
    return;
  }
  try {
    state.database = firebase.apps.length ? firebase.app().database() : firebase.initializeApp(firebaseConfig).database();
    state.database.ref(".info/connected").on("value", (snapshot) => {
      const wasConnected = state.connected;
      state.connected = snapshot.val() === true;
      if (!state.connected && wasConnected) setNotice("Connection lost. Trying to reconnect…", "warning");
      if (state.connected && !wasConnected) {
        if (state.roomRef && state.player?.id) claimPresence();
        if (state.roomRef && state.player?.id && state.room?.players?.[state.player.id]) {
          state.roomRef.child("players").child(state.player.id).update({ connected: true });
        }
        setNotice("Connection restored.", "success");
      }
    });
    const roomCode = savedRoomCode();
    if (!state.player.name) renderNameEntry();
    else if (roomCode) joinRoom(roomCode);
    else renderLanding();
  } catch (error) {
    console.error("Firebase setup failed.", error);
    renderError("Firebase could not be initialized. Check the project configuration.");
  }
}

document.addEventListener("keydown", handleKeys);
window.addEventListener("beforeunload", () => {
  stopMonsterMovement();
  stopSeparationMonitor();
  if (state.presenceRef) state.presenceRef.remove();
});

bootstrap();
