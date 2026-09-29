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
const PARTY_VISION = 3;
const SAFE_DISTANCE = 5;
const SEPARATION_GRACE_MS = 25000;
const MONSTER_MOVE_MS = 6500;
const MONSTER_DANGER_RADIUS = 3;
const NAVIGATOR_SIGNAL_RANGE = 4;
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
  patrolInitializing: false,
  lastAnnouncedNavigator: null,
  lastGameId: null,
  lastObjectivePhase: null,
  navigatorSignal: false,
  wasInTerritory: false,
  monsterDangerStage: 0,
  notice: null,
  lastMessageAt: 0,
  lastMoveInputAt: 0
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

  const extraPassages = [];
  for (const cell of cells.flat()) {
    for (const direction of [
      { dx: 1, dy: 0, wall: "east", opposite: "west" },
      { dx: 0, dy: 1, wall: "south", opposite: "north" }
    ]) {
      const x = cell.x + direction.dx;
      const y = cell.y + direction.dy;
      if (x < size && y < size && cell.walls[direction.wall]) {
        extraPassages.push({ cell, x, y, ...direction });
      }
    }
  }
  for (let index = extraPassages.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [extraPassages[index], extraPassages[swap]] = [extraPassages[swap], extraPassages[index]];
  }
  for (const passage of extraPassages.slice(0, Math.round(size * size * 0.12))) {
    passage.cell.walls[passage.wall] = false;
    cells[passage.y][passage.x].walls[passage.opposite] = false;
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
  if (!validPosition(origin, maze)) return new Map();
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

function graphDistancesFromMany(maze, origins) {
  const distances = new Map();
  const queue = [];
  for (const origin of origins) {
    if (!validPosition(origin, maze)) continue;
    const key = positionKey(origin);
    if (distances.has(key)) continue;
    distances.set(key, 0);
    queue.push(origin);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const distance = distances.get(positionKey(current));
    for (const direction of Object.keys(DIRECTIONS)) {
      const next = getStep(current, direction, maze);
      if (!next || distances.has(positionKey(next))) continue;
      distances.set(positionKey(next), distance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function playerDistance(room, first, second) {
  if (!normalizeMaze(room?.maze) || !validPosition(first, room.maze) || !validPosition(second, room.maze)) return Infinity;
  return graphDistances(room.maze, first).get(`${second.x},${second.y}`) ?? Infinity;
}

function positionKey(position) {
  return position ? `${position.x},${position.y}` : "";
}

function mazePath(maze, start, goal, blocked = new Set()) {
  if (!validPosition(start, maze) || !validPosition(goal, maze) || blocked.has(positionKey(start)) ||
      blocked.has(positionKey(goal))) return null;
  const startKey = positionKey(start);
  const parents = new Map([[startKey, null]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const position = queue[index];
    const key = positionKey(position);
    if (samePosition(position, goal)) {
      const path = [];
      let currentKey = key;
      while (currentKey) {
        const [x, y] = currentKey.split(",").map(Number);
        path.push({ x, y });
        currentKey = parents.get(currentKey);
      }
      return path.reverse();
    }
    for (const direction of Object.keys(DIRECTIONS)) {
      const next = getStep(position, direction, maze);
      if (!next || blocked.has(positionKey(next)) || parents.has(positionKey(next))) continue;
      parents.set(positionKey(next), key);
      queue.push(next);
    }
  }
  return null;
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function connectedTerritory(maze, avoidPositions = []) {
  const fromStart = graphDistances(maze, maze.start);
  const fromExit = graphDistances(maze, maze.exit);
  const eligible = new Set(maze.cells.flat()
    .filter((cell) => (fromStart.get(positionKey(cell)) ?? 0) >= MONSTER_DANGER_RADIUS + 2 &&
      (fromExit.get(positionKey(cell)) ?? 0) >= MONSTER_DANGER_RADIUS + 2 &&
      !avoidPositions.some((position) => samePosition(cell, position)))
    .map(positionKey));
  const targetSize = Math.round(maze.width * maze.height * 0.23);
  const territoryDistance = (territory) => graphDistancesFromMany(maze, territory);
  const seeds = shuffled([...eligible]);

  for (const seed of seeds) {
    const territory = new Set([seed]);
    let frontier = [seed];
    while (territory.size < targetSize && frontier.length) {
      const currentKey = frontier[Math.floor(Math.random() * frontier.length)];
      frontier = frontier.filter((key) => key !== currentKey);
      const [x, y] = currentKey.split(",").map(Number);
      const neighbors = shuffled(Object.keys(DIRECTIONS)
        .map((direction) => getStep({ x, y }, direction, maze))
        .filter((position) => position && eligible.has(positionKey(position)) && !territory.has(positionKey(position)))
        .map(positionKey));
      for (const neighbor of neighbors) {
        if (territory.has(neighbor)) continue;
        territory.add(neighbor);
        frontier.push(neighbor);
        if (territory.size >= targetSize) break;
      }
    }
    if (territory.size < Math.floor(maze.width * maze.height * 0.2)) continue;
    if (!mazePath(maze, maze.start, maze.exit, territory)) continue;
    const cells = [...territory].map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    });
    const distanceFromTerritory = territoryDistance(cells);
    const avoidDistances = avoidPositions.length ? graphDistancesFromMany(maze, avoidPositions) : null;
    if (avoidDistances && cells.some((cell) =>
      (avoidDistances.get(positionKey(cell)) ?? Infinity) <= MONSTER_DANGER_RADIUS + 1
    )) continue;
    const navigatorOptions = maze.cells.flat().filter((cell) =>
      !territory.has(positionKey(cell)) && !samePosition(cell, maze.start) && !samePosition(cell, maze.exit) &&
      (fromStart.get(positionKey(cell)) ?? 0) >= 8 &&
      (distanceFromTerritory.get(positionKey(cell)) ?? Infinity) > MONSTER_DANGER_RADIUS + 1
    );
    if (navigatorOptions.length) return cells;
  }
  throw new Error("Could not generate a safe, connected Monster territory. Try starting a new maze.");
}

function buildMonsterRoute(maze, territory) {
  if (!Array.isArray(territory) || territory.length < 2) {
    throw new Error("The Monster needs a connected territory with at least two cells.");
  }
  const territoryKeys = new Set(territory.map(positionKey));
  const routeStart = territory[Math.floor(Math.random() * territory.length)];
  const route = [{ ...routeStart }];
  const visited = new Set([positionKey(routeStart)]);
  const walk = (position) => {
    const options = Object.keys(DIRECTIONS)
      .map((direction) => getStep(position, direction, maze))
      .filter((next) => next && territoryKeys.has(positionKey(next)) && !visited.has(positionKey(next)));
    for (let index = options.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [options[index], options[swap]] = [options[swap], options[index]];
    }
    for (const next of options) {
      const key = positionKey(next);
      if (visited.has(key)) continue;
      visited.add(key);
      route.push({ ...next });
      walk(next);
      route.push({ ...position });
    }
  };
  walk(routeStart);
  if (visited.size !== territoryKeys.size) {
    throw new Error("The generated Monster territory is not connected.");
  }
  return route;
}

function chooseNavigatorPosition(maze, territory, monsterPosition) {
  const fromStart = graphDistances(maze, maze.start);
  const fromMonster = graphDistances(maze, monsterPosition);
  const territoryDistances = graphDistancesFromMany(maze, territory);
  const candidates = shuffled(maze.cells.flat().filter((cell) =>
    !samePosition(cell, maze.start) && !samePosition(cell, maze.exit) &&
    (territoryDistances.get(positionKey(cell)) ?? Infinity) > MONSTER_DANGER_RADIUS + 1 &&
    (fromStart.get(positionKey(cell)) ?? 0) >= 8 &&
    (fromMonster.get(positionKey(cell)) ?? Infinity) > MONSTER_DANGER_RADIUS + 1
  ));
  if (!candidates.length) throw new Error("Could not find a safe Navigator spawn.");
  const farthest = Math.max(...candidates.map((cell) => fromStart.get(positionKey(cell)) || 0));
  const remote = candidates.filter((cell) => (fromStart.get(positionKey(cell)) || 0) >= farthest - 3);
  const position = remote[Math.floor(Math.random() * remote.length)];
  return { x: position.x, y: position.y };
}

function chooseMonsterRouteIndex(maze, route) {
  const fromStart = graphDistances(maze, maze.start);
  const candidates = route.map((position, routeIndex) => ({
    routeIndex,
    score: fromStart.get(positionKey(position)) ?? 0
  })).filter(({ routeIndex, score }) =>
    routeIndex < route.length - 1 && score > MONSTER_DANGER_RADIUS + 1
  );
  if (!candidates.length) throw new Error("Could not find a safe starting cell for the Monster.");
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const safest = candidates.filter((candidate) => candidate.score >= bestScore - 2);
  return safest[Math.floor(Math.random() * safest.length)].routeIndex;
}

function createMonsterSetup(maze, navigatorPosition = null) {
  const territory = connectedTerritory(maze, navigatorPosition ? [navigatorPosition] : []);
  const route = buildMonsterRoute(maze, territory);
  const routeIndex = chooseMonsterRouteIndex(maze, route);
  const monsterPosition = route[routeIndex];
  const navigator = navigatorPosition || chooseNavigatorPosition(maze, territory, monsterPosition);
  if (territory.some((cell) => samePosition(cell, navigator)) ||
      playerDistance({ maze }, navigator, monsterPosition) <= MONSTER_DANGER_RADIUS + 1) {
    throw new Error("The generated Navigator spawn is not safely separated from the Monster.");
  }
  return {
    territory,
    route,
    routeIndex,
    monsterPosition: { ...monsterPosition },
    navigatorPosition: { ...navigator }
  };
}

function advanceMonster(room, now = Date.now()) {
  const monster = room.monster;
  if (!Array.isArray(monster?.route) || monster.route.length < 3 ||
      !Array.isArray(monster.territory) || monster.territory.length < 2) return;
  const currentIndex = Number(monster.routeIndex) || 0;
  const nextIndex = currentIndex >= monster.route.length - 1 ? 1 : currentIndex + 1;
  const nextPosition = monster.route[nextIndex];
  const territory = new Set(monster.territory.map(positionKey));
  if (!validPosition(nextPosition, room.maze) || !territory.has(positionKey(nextPosition))) return;
  const currentPosition = monster.position;
  const connectedStep = Object.keys(DIRECTIONS).some((direction) =>
    samePosition(getStep(currentPosition, direction, room.maze), nextPosition)
  );
  if (!connectedStep) return;
  monster.routeIndex = nextIndex;
  monster.position = { ...nextPosition };
  monster.stepCount = (Number(monster.stepCount) || 0) + 1;
  monster.lastMovedAt = now;
}

function initializeMonsterPatrol() {
  const room = state.room;
  if (state.patrolInitializing || !state.roomRef || !normalizeMaze(room?.maze) || !room.monster) return;
  let setup;
  try {
    setup = createMonsterSetup(room.maze);
  } catch (error) {
    console.error("Could not prepare the Monster territory for this room.", error);
    setNotice(error.message || "The Monster territory could not be created.", "error");
    return;
  }
  state.patrolInitializing = true;
  state.roomRef.transaction((current) => {
    if (!current || current.phase !== "playing" ||
        (Array.isArray(current.monster?.territory) && current.monster.territory.length >= 2 &&
          Array.isArray(current.monster?.route) && current.monster.route.length >= 3)) return;
    const navigator = current.players?.[current.navigatorId];
    if (!navigator) return;
    navigator.position = { ...setup.navigatorPosition };
    current.monster = {
      ...current.monster,
      position: { ...setup.monsterPosition },
      territory: setup.territory,
      route: setup.route,
      routeIndex: setup.routeIndex,
      moveInterval: MONSTER_MOVE_MS,
      lastMovedAt: Date.now()
    };
    return current;
  }).catch((error) => {
    console.error("Could not initialize the Monster patrol.", error);
    setNotice("The Monster's patrol could not be synchronized.", "error");
  }).finally(() => {
    state.patrolInitializing = false;
  });
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
    maybeFindNavigator(state.room);
    if (state.room.gameId && state.room.gameId !== state.lastGameId) {
      state.lastGameId = state.room.gameId;
      state.watchingAfterDeath = false;
      state.lastObjectivePhase = null;
      state.navigatorSignal = false;
      state.wasInTerritory = false;
      state.monsterDangerStage = 0;
    }
    if (state.room.phase === "lobby") renderLobby(state.room);
    else if (state.room.phase === "countdown") renderCountdown(state.room);
    else if (["playing", "gameover", "escaped"].includes(state.room.phase) && normalizeMaze(state.room.maze)) renderGame(state.room);
    else renderLobby({ ...state.room, phase: "lobby" });
    handleRoomEvents(state.room);
    const localRecord = state.room.players?.[state.player.id];
    if (localRecord?.separatedAt && state.separationNoticeAt !== localRecord.separatedAt) {
      state.separationNoticeAt = localRecord.separatedAt;
      setNotice("YOU ARE SEPARATING FROM THE GROUP.", "warning");
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
  }).catch((error) => console.error("Could not reassign the Navigator.", error));
}

function maybeFindNavigator(room) {
  if (!state.roomRef || room.phase !== "playing" || room.objectivePhase !== 1) return;
  const navigator = room.players?.[room.navigatorId];
  if (!navigator?.connected || navigator.alive === false || !validPosition(navigator.position, room.maze)) return;
  const finder = livingPlayers(room.players).find((player) =>
    player.id !== room.navigatorId && samePosition(player.position, navigator.position)
  );
  if (!finder) return;
  state.roomRef.transaction((current) => {
    if (!current || current.phase !== "playing" || current.objectivePhase !== 1) return;
    const currentNavigator = current.players?.[current.navigatorId];
    const currentFinder = livingPlayers(current.players).find((player) =>
      player.id !== current.navigatorId && samePosition(player.position, currentNavigator?.position)
    );
    if (!currentFinder) return;
    current.objectivePhase = 2;
    current.navigatorFoundAt = Date.now();
    current.navigatorFoundBy = currentFinder.id;
    return current;
  }).catch((error) => console.error("Could not confirm that the Navigator was found.", error));
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
  if (room.phase === "playing" && room.objectivePhase === 2 && state.lastObjectivePhase === 1) {
    setNotice("NAVIGATOR FOUND · PHASE 02: FIND THE EXIT", "success");
  }
  if (room.phase === "playing" && room.objectivePhase) state.lastObjectivePhase = room.objectivePhase;
  const me = room.players?.[state.player.id];
  const navigator = room.players?.[room.navigatorId];
  const signalDetected = Boolean(room.phase === "playing" && room.objectivePhase === 1 && me &&
    me.id !== room.navigatorId && me.alive !== false && navigator?.position &&
    playerDistance(room, me.position, navigator.position) <= NAVIGATOR_SIGNAL_RANGE);
  if (signalDetected && !state.navigatorSignal) setNotice("SIGNAL DETECTED · THE NAVIGATOR IS CLOSE.", "success");
  state.navigatorSignal = signalDetected;
  const territoryKeys = new Set((room.monster?.territory || []).map(positionKey));
  const inTerritory = Boolean(room.phase === "playing" && me && me.id !== room.navigatorId &&
    me.alive !== false && territoryKeys.has(positionKey(me.position)));
  if (inTerritory && !state.wasInTerritory) setNotice("YOU HAVE ENTERED UNKNOWN TERRITORY.", "warning");
  state.wasInTerritory = inTerritory;
  document.body.classList.toggle("in-territory", inTerritory);
  updateDangerState();
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
      <div class="lobby-copy-block"><div class="eyebrow"><span class="pulse-dot"></span> Cooperative survival experiment</div><h1>THE MAZE<br /><span>OF MANY</span></h1><p class="intro-line">FIND THE NAVIGATOR. THEN FIND THE EXIT.</p><p class="intro-copy">Explorers move alone.<br />The Navigator sees everything.<br />No one can move you but you.</p><div class="rule-line"><span>01</span><p>Explore independently, but stay within reach.</p></div><div class="rule-line"><span>02</span><p>The Navigator is stationary and can see the whole maze.</p></div></div>
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
          messages: {}
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
    const position = room.players?.[state.player.id]?.position || room.maze?.start || { x: 0, y: 0 };
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
        position: currentPlayer?.position || position,
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
  appRoot.innerHTML = `<section class="screen lobby-screen"><div class="lobby-layout"><div class="lobby-copy-block"><div class="eyebrow"><span class="pulse-dot"></span> Room ${escapeHtml(state.roomCode)}</div><h1>THE MAZE<br /><span>OF MANY</span></h1><p class="intro-line">PHASE 01 · FIND THE NAVIGATOR · PHASE 02 · FIND THE EXIT</p><p class="intro-copy">Explorers move on their own.<br />The Navigator cannot move.<br />Stay close enough to survive.</p></div><section class="lobby-card"><div class="lobby-card-header"><span class="eyebrow">Room code</span><button class="copy-code text-btn" id="copy-room-code">${escapeHtml(state.roomCode)} · COPY</button></div><div class="player-count"><strong>${players.length}</strong><span>/ ${PLAYER_LIMIT}<small>PLAYERS</small></span></div><ul class="player-list">${rows}</ul><p class="lobby-status">${full ? "Room full." : players.length < 2 ? "Waiting for at least one more player…" : host ? "The group is ready. Start the survival run." : "Waiting for the room host to begin."}</p><button id="start-game" class="primary-btn" ${canStart ? "" : "disabled"}>${full ? "Room full" : "Begin the survival run"} <span>↗</span></button><p class="lobby-footnote">${full ? "Maximum 8 players." : "Share the room code so your group can join."}</p><button id="leave-room" class="text-btn">Leave room</button></section></div><div id="notice-region" class="notice-region"></div></section>`;
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
  stopMonsterMovement();
  stopSeparationMonitor();
  state.roomRef = null;
  state.presenceRef = null;
  state.room = null;
  state.roomCode = null;
  state.joined = false;
  state.localMode = false;
  localStorage.removeItem(ROOM_STORAGE_KEY);
  renderLanding();
}

function startCountdown() {
  if (state.localMode) {
    startLocalDemo();
    return;
  }
  if (!isLocalHost() || orderedPlayers(state.room?.players).length < 2) return;
  const maze = makeMaze();
  let setup;
  try {
    setup = createMonsterSetup(maze);
  } catch (error) {
    console.error("Could not prepare a safe maze and Monster territory.", error);
    setNotice(error.message || "Could not prepare a safe maze. Try again.", "error");
    return;
  }
  const now = Date.now();
  state.roomRef.transaction((room) => {
    if (!room || !["lobby", "gameover", "escaped"].includes(room.phase)) return;
    const currentPlayers = orderedPlayers(room.players || {});
    if (currentPlayers.length < 2 || currentPlayers.length > PLAYER_LIMIT) return;
    const navigatorPlayer = currentPlayers[Math.floor(Math.random() * currentPlayers.length)];
    const living = {};
    currentPlayers.forEach((player) => {
      const isNavigator = player.id === navigatorPlayer.id;
      living[player.id] = {
        ...player,
        alive: true,
        escaped: false,
        position: isNavigator ? { ...setup.navigatorPosition } : { ...maze.start },
        separatedAt: null,
        monsterDangerSince: null
      };
    });
    room.phase = "countdown";
    room.navigatorId = navigatorPlayer.id;
    room.maze = maze;
    room.objectivePhase = 1;
    room.navigatorFoundAt = null;
    room.navigatorFoundBy = null;
    room.monster = {
      position: { ...setup.monsterPosition },
      territory: setup.territory,
      route: setup.route,
      routeIndex: setup.routeIndex,
      stepCount: 0,
      moveInterval: MONSTER_MOVE_MS,
      lastMovedAt: now
    };
    room.players = { ...(room.players || {}), ...living };
    room.startedAt = now;
    room.countdownUntil = now + 3000;
    room.gameId = makeId();
    room.winner = null;
    room.finishedAt = null;
    room.messages = {};
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

function markerForCell(room, x, y, isNavigator, revealNavigator) {
  let marker = "";
  const playersAtCell = livingPlayers(room.players || {}).filter((player) => samePosition(player.position, { x, y }));
  const offsets = [[0, 0], [-7, -6], [7, -6], [-7, 6], [7, 6], [0, -8], [-8, 0], [8, 0]];
  for (const [index, player] of playersAtCell.entries()) {
    if (player.id === room.navigatorId && !revealNavigator) continue;
    const [offsetX, offsetY] = offsets[index] || [0, 0];
    const offsetStyle = `--marker-x:${offsetX}px;--marker-y:${offsetY}px;`;
    marker += `<span class="player-marker ${player.id === state.player.id ? "is-me" : ""} ${player.id === room.navigatorId ? "is-navigator" : ""}" style="--player-color:${safeColor(player.color)};${offsetStyle}" title="${escapeHtml(player.name)}">${player.id === room.navigatorId ? "<span>N</span>" : escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>`;
  }
  if (room.monster?.position && samePosition(room.monster.position, { x, y })) {
    marker += `<span class="monster-marker" title="The Monster"><i></i><i></i></span>`;
  }
  if ((isNavigator || room.objectivePhase === 2) && samePosition(room.maze.exit, { x, y })) marker += `<span class="exit-marker">◇</span>`;
  return marker;
}

function canSeeNavigator(room, isNavigator) {
  if (isNavigator || room.objectivePhase === 2) return true;
  const navigator = room.players?.[room.navigatorId];
  const me = room.players?.[state.player.id];
  return Boolean(navigator?.position && me?.position &&
    playerDistance(room, navigator.position, me.position) <= 2);
}

function isCellVisible(room, x, y, isNavigator) {
  if (isNavigator) return true;
  const position = room.players?.[state.player.id]?.position || room.maze.start;
  return Math.abs(position.x - x) <= PARTY_VISION && Math.abs(position.y - y) <= PARTY_VISION;
}

function renderMaze(room, isNavigator) {
  const maze = room.maze;
  const me = room.players?.[state.player.id];
  const position = validPosition(me?.position, maze) ? me.position : maze.start;
  const bounds = isNavigator
    ? { minX: 0, maxX: maze.width - 1, minY: 0, maxY: maze.height - 1 }
    : {
        minX: Math.max(0, position.x - PARTY_VISION - 1), maxX: Math.min(maze.width - 1, position.x + PARTY_VISION + 1),
        minY: Math.max(0, position.y - PARTY_VISION - 1), maxY: Math.min(maze.height - 1, position.y + PARTY_VISION + 1)
      };
  const cells = [];
  const dangerDistances = isNavigator && room.monster?.position
    ? graphDistances(maze, room.monster.position)
    : new Map();
  const patrolCells = new Set(isNavigator
    ? (room.monster?.route || []).map((cell) => `${cell.x},${cell.y}`)
    : []);
  const territoryCells = new Set((room.monster?.territory || []).map(positionKey));
  const monsterPosition = room.monster?.position;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const cell = maze.cells[y][x];
      const visible = isCellVisible(room, x, y, isNavigator);
      const danger = isNavigator && (dangerDistances.get(`${x},${y}`) ?? Infinity) <= MONSTER_DANGER_RADIUS;
      const atMonster = samePosition(monsterPosition, { x, y });
      const territoryVisible = territoryCells.has(`${x},${y}`) && (isNavigator || visible);
      const exitVisible = visible && (isNavigator || room.objectivePhase === 2) && samePosition(maze.exit, { x, y });
      const revealNavigator = canSeeNavigator(room, isNavigator);
      const hasPlayer = livingPlayers(room.players).some((player) =>
        (player.id !== room.navigatorId || revealNavigator) && samePosition(player.position, { x, y })
      );
      const wallStyles = [
        ["north", "border-top"], ["east", "border-right"], ["south", "border-bottom"], ["west", "border-left"]
      ].map(([wall, property]) => `${property}:${cell.walls[wall] ? "2px solid var(--wall)" : "2px solid transparent"}`).join(";");
      cells.push(`<div class="maze-cell ${visible ? "revealed" : "fogged"} ${danger ? "danger-cell" : ""} ${territoryVisible ? "territory-cell" : ""} ${isNavigator && patrolCells.has(`${x},${y}`) ? "patrol-cell" : ""} ${visible && hasPlayer ? "player-cell" : ""} ${atMonster && isNavigator ? "monster-cell" : ""} ${exitVisible ? "exit-cell" : ""}" style="${wallStyles}" aria-label="${visible ? `Cell ${x + 1}, ${y + 1}${territoryVisible ? ", Monster territory" : ""}${danger ? ", monster danger zone" : ""}` : "Unexplored"}">${visible ? markerForCell(room, x, y, isNavigator, revealNavigator) : ""}</div>`);
    }
  }
  return `<div class="maze-viewport" tabindex="0"><div class="maze-grid ${isNavigator ? "full-map" : "local-map"}" style="--columns:${bounds.maxX - bounds.minX + 1};--cell:27px">${cells.join("")}</div></div>`;
}

function renderPlayerPanel(room, isNavigator) {
  const players = orderedPlayers(room.players);
  const alive = players.filter((player) => player.alive !== false);
  const me = room.players?.[state.player.id];
  const position = me?.position || room.maze.start;
  const separationAge = me?.separatedAt ? Date.now() - me.separatedAt : 0;
  const separationText = separationAge > 16000 ? "RETURN TO THE GROUP." : "YOU ARE SEPARATING FROM THE GROUP.";
  return `<section class="side-section"><div class="section-heading"><span>SURVIVORS</span><span>${alive.length} / ${players.length}</span></div><div class="live-player-list">${players.map((player) => `<div class="live-player ${player.alive === false ? "player-dead" : ""}"><span class="player-dot" style="--player-color:${safeColor(player.color)}"></span><span class="live-player-name">${escapeHtml(player.name)}${player.id === room.navigatorId ? " <i>NAVIGATOR</i>" : ""}</span><span class="player-state">${player.connected ? player.alive === false ? "LOST" : player.separatedAt ? "TOO FAR" : player.escaped ? "AT EXIT" : "ALIVE" : "OFFLINE"}</span></div>`).join("")}</div><div class="escape-progress"><span>YOUR LOCATION</span><strong>${String(position.x + 1).padStart(2, "0")} : ${String(position.y + 1).padStart(2, "0")}</strong></div>${me?.separatedAt ? `<p class="separation-status">${separationText}</p>` : `<p class="separation-status stable-status">${me?.escaped ? "YOU MADE IT · WAIT FOR THE EXPLORERS" : `CONNECTION STABLE · KEEP WITHIN ${SAFE_DISTANCE} CORRIDORS`}</p>`}${!isNavigator && me?.alive !== false && me?.escaped !== true ? `<div class="movement-controls"><span class="select-label">MOVE YOUR EXPLORER · WASD / ARROWS</span><div class="direction-grid"><button data-move="up" aria-label="Move up">↑</button><button data-move="left" aria-label="Move left">←</button><button data-move="down" aria-label="Move down">↓</button><button data-move="right" aria-label="Move right">→</button></div></div>` : ""}</section>`;
}

function renderChat(room) {
  const messages = Object.entries(room.messages || {}).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0)).slice(-25);
  return `<section class="chat-section"><div class="section-heading"><span>${room.objectivePhase === 2 ? "NAVIGATOR CHANNEL" : "FIELD NOTES"}</span><span class="live-label">LIVE</span></div><div class="chat-messages" id="chat-messages">${messages.map(([id, message]) => renderMessage(id, message)).join("")}<div id="chat-end"></div></div><form id="chat-form" class="chat-form"><input id="chat-input" maxlength="180" autocomplete="off" placeholder="Send a message…" aria-label="Chat message" /><button type="submit" aria-label="Send message">↗</button></form></section>`;
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
  const explorers = orderedPlayers(room.players).filter((player) => player.id !== room.navigatorId);
  const escapedCount = explorers.filter((player) => player.alive !== false && player.escaped).length;
  const objectivePhase = room.objectivePhase === 2 ? 2 : 1;
  const near = room.phase === "playing" && monsterDistance(room, state.player.id) <= MONSTER_DANGER_RADIUS;
  const territoryKeys = new Set((room.monster?.territory || []).map(positionKey));
  const inTerritory = !isNavigator && territoryKeys.has(positionKey(me.position));
  document.body.classList.toggle("danger-near", near);
  document.body.classList.toggle("in-territory", inTerritory);
  const objectiveLabel = objectivePhase === 1 ? "FIND THE NAVIGATOR" : "FIND THE EXIT";
  const myPosition = me.position || room.maze.start;
  const transitionVisible = room.navigatorFoundAt && Date.now() - room.navigatorFoundAt < 4500;
  appRoot.innerHTML = `<section class="game-screen ${near ? "danger-near" : ""} ${inTerritory ? "in-territory" : ""}">
    <header class="game-topbar"><div><span class="eyebrow"><span class="pulse-dot"></span> ${state.connected ? "SYNCHRONIZED" : "RECONNECTING"} · ROOM ${escapeHtml(state.roomCode)}</span><h1>THE MAZE <span>OF MANY</span></h1></div><div class="game-top-meta"><span>RUN <strong>${escapeHtml(String(room.gameId || "").slice(-5).toUpperCase())}</strong></span><button id="leave-room" class="text-btn">LEAVE</button></div></header>
    <section class="objective-banner phase-${objectivePhase}"><span>PHASE 0${objectivePhase}</span><strong>${objectiveLabel}</strong><p>${isNavigator ? "You see the whole maze. Stay where you are and guide the Explorers in chat." : objectivePhase === 1 ? "Explore on your own. Find the person who can see the whole maze." : "The Navigator has been found. Reach the exit together, one Explorer at a time."}</p></section>
    <div class="game-layout ${isNavigator ? "navigator-layout" : "explorer-layout"}"><main class="map-column"><div class="map-heading"><div><span class="eyebrow">${isNavigator ? "NAVIGATOR · FULL TACTICAL VIEW" : "EXPLORER · FIELD VIEW"}</span><p>${isNavigator ? "You are stationary. Track every Explorer, the patrol, and the exit." : objectivePhase === 1 ? "Find the hidden Navigator. The maze beyond your sight is unknown." : "Follow the Navigator's guidance through the maze."}</p></div><span class="map-coordinates">${String(myPosition.x + 1).padStart(2, "0")} / ${String(myPosition.y + 1).padStart(2, "0")}</span></div>${renderMaze(room, isNavigator)}<div class="map-legend"><span><i class="legend-you" style="--player-color:${safeColor(state.player.color)}"></i> ${isNavigator ? "NAVIGATOR" : "YOU"}</span>${isNavigator ? `<span><i class="legend-monster"></i> MONSTER</span><span><i class="legend-territory"></i> TERRITORY · ${Math.round((room.monster?.territory?.length || 0) / (room.maze.width * room.maze.height) * 100)}%</span><span><i class="legend-exit"></i> EXIT</span><span class="patrol-legend">PATROL · ${room.monster?.route?.length || 0} STEPS</span>` : `<span class="fog-legend">UNEXPLORED</span><span class="party-hint">${inTerritory ? "UNKNOWN TERRITORY" : objectivePhase === 1 ? "NAVIGATOR HIDDEN" : "EXIT REVEALED AS YOU EXPLORE"}</span>`}</div></main><aside class="control-column"><div class="role-card"><span class="eyebrow">Your role</span><strong>${isNavigator ? "THE NAVIGATOR · STATIONARY" : "AN EXPLORER · YOU CONTROL YOURSELF"}</strong><span>${escapeHtml(isNavigator ? "They can see what you cannot. Guide them through chat; you cannot move." : objectivePhase === 1 ? "Move independently with WASD, arrows, or the directional pad." : "You must reach the exit yourself. The Navigator cannot move you.")}</span></div>${renderPlayerPanel(room, isNavigator)}${renderChat(room)}</aside></div>
    ${transitionVisible ? `<div class="phase-transition"><span>NAVIGATOR FOUND</span><strong>PHASE 02 · FIND THE EXIT</strong></div>` : ""}
    ${!alive && room.phase === "playing" && !state.watchingAfterDeath ? `<div class="completion-overlay"><div class="completion-card"><span class="eyebrow">Signal lost</span><h2>YOU WERE<br /><span>LOST.</span></h2><p>You can still watch the survivors find their way.</p><button id="watch-game" class="primary-btn">Watch the group <span>↗</span></button></div></div>` : ""}
    ${room.phase === "gameover" ? `<div class="completion-overlay"><div class="completion-card"><span class="eyebrow">No Explorers remain</span><h2>THE MAZE<br /><span>WON.</span></h2><p>Nobody found the way out.</p><button id="retry-game" class="primary-btn">${isLocalHost() ? "Try again" : "Waiting for the host"} <span>↗</span></button></div></div>` : ""}
    ${room.phase === "escaped" ? `<div class="completion-overlay"><div class="completion-card"><span class="eyebrow">Run ${formatDuration((room.finishedAt || Date.now()) - room.startedAt)}</span><h2>ESCAPE<br /><span>COMPLETE.</span></h2><p>SURVIVORS: ${escapedCount} / ${explorers.filter((player) => player.alive !== false).length}<br />TIME: ${formatDuration((room.finishedAt || Date.now()) - room.startedAt)}</p><button id="retry-game" class="primary-btn" ${isLocalHost() ? "" : "disabled"}>${isLocalHost() ? "Enter a new maze" : "Waiting for the host"} <span>↗</span></button></div></div>` : ""}
    <div id="notice-region" class="notice-region"></div>
  </section>`;
  document.getElementById("leave-room")?.addEventListener("click", leaveRoom);
  document.getElementById("chat-form")?.addEventListener("submit", sendChat);
  document.getElementById("retry-game")?.addEventListener("click", startCountdown);
  document.getElementById("watch-game")?.addEventListener("click", () => {
    state.watchingAfterDeath = true;
    document.querySelector(".completion-overlay")?.remove();
  });
  document.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => movePlayer(button.dataset.move)));
  restoreNotice();
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function samePosition(a, b) {
  return a?.x === b?.x && a?.y === b?.y;
}

function monsterDistance(room, playerId = state.player?.id) {
  const position = room?.players?.[playerId]?.position;
  if (!room?.monster?.position || !validPosition(position, room.maze)) return Infinity;
  return playerDistance(room, room.monster.position, position);
}

function updateDangerState() {
  if (!state.room || state.room.phase !== "playing") {
    document.body.classList.remove("danger-near", "danger-critical", "in-territory");
    state.wasInTerritory = false;
    state.monsterDangerStage = 0;
    return;
  }
  const distance = monsterDistance(state.room);
  const stage = distance <= 1 ? 3 : distance <= 2 ? 2 : distance <= MONSTER_DANGER_RADIUS ? 1 : 0;
  document.body.classList.toggle("danger-near", stage > 0);
  document.body.classList.toggle("danger-critical", stage === 3);
  if (stage > state.monsterDangerStage) {
    const warning = ["", "SOMETHING IS NEAR.", "IT IS GETTING CLOSER.", "RUN."];
    setNotice(warning[stage], "warning");
    if (stage === 3 && navigator.vibrate) navigator.vibrate([90, 70, 90]);
  }
  state.monsterDangerStage = stage;
}

function resolveGameOutcome(room, now = Date.now()) {
  const previousPhase = room.phase;
  const explorers = livingPlayers(room.players).filter((player) => player.id !== room.navigatorId);
  if (!explorers.length) {
    room.phase = "gameover";
    room.finishedAt = now;
    return room.phase !== previousPhase;
  }
  if (room.objectivePhase === 2 && explorers.every((player) => player.escaped === true)) {
    room.phase = "escaped";
    room.finishedAt = now;
    room.winner = explorers.map((player) => player.id);
  }
  return room.phase !== previousPhase;
}

function movePlayer(direction) {
  if (!DIRECTIONS[direction] || state.room?.phase !== "playing") return;
  if (state.room.navigatorId === state.player?.id ||
      state.room.players?.[state.player.id]?.alive === false ||
      state.room.players?.[state.player.id]?.escaped === true) return;
  const now = Date.now();
  if (now - state.lastMoveInputAt < 150) return;
  state.lastMoveInputAt = now;
  if (state.localMode) {
    moveLocalPlayer(direction);
    return true;
  }
  if (!state.roomRef) return;
  return state.roomRef.transaction((room) => {
    const player = room?.players?.[state.player.id];
    if (!room || room.phase !== "playing" || room.navigatorId === state.player.id ||
        !player || player.alive === false || player.escaped === true ||
        !validPosition(player.position, room.maze)) return;
    const nextPosition = getStep(player.position, direction, room.maze);
    if (!nextPosition) return;
    const now = Date.now();
    player.position = nextPosition;
    player.lastMoveAt = now;
    player.separatedAt = null;
    if (room.objectivePhase === 1 &&
        samePosition(nextPosition, room.players?.[room.navigatorId]?.position)) {
      room.objectivePhase = 2;
      room.navigatorFoundAt = now;
      room.navigatorFoundBy = player.id;
    }
    if (room.objectivePhase === 2 && samePosition(nextPosition, room.maze.exit)) player.escaped = true;
    resolveGameOutcome(room, now);
    return room;
  }).then((result) => {
    if (!result.committed && state.room?.phase === "playing") setNotice("PATH BLOCKED", "warning");
  }).catch((error) => {
    console.error("Could not move the Explorer.", error);
    setNotice("Movement did not sync. Check the connection.", "error");
  });
}

function moveLocalPlayer(direction) {
  const room = state.room;
  const player = room?.players?.[state.player.id];
  if (!room || room.phase !== "playing" || !player || player.id === room.navigatorId ||
      player.escaped === true) return;
  const nextPosition = getStep(player.position, direction, room.maze);
  if (!nextPosition) {
    setNotice("PATH BLOCKED", "warning");
    return;
  }
  const now = Date.now();
  player.position = nextPosition;
  player.separatedAt = null;
  if (room.objectivePhase === 1 &&
      samePosition(nextPosition, room.players?.[room.navigatorId]?.position)) {
    room.objectivePhase = 2;
    room.navigatorFoundAt = now;
    room.navigatorFoundBy = player.id;
  }
  if (room.objectivePhase === 2 && samePosition(nextPosition, room.maze.exit)) player.escaped = true;
  resolveGameOutcome(room, now);
  renderGame(room);
  updateDangerState();
}

function applyMonsterThreat(room, now) {
  for (const player of livingPlayers(room.players).filter((record) => record.escaped !== true)) {
    const distance = playerDistance(room, room.monster.position, player.position);
    if (distance > 1) {
      player.monsterDangerSince = null;
      continue;
    }
    if (!player.monsterDangerSince) player.monsterDangerSince = now;
    else if (now - player.monsterDangerSince >= 12000) {
      player.alive = false;
      player.lostAt = now;
      player.monsterDangerSince = null;
    }
  }
  if (!livingPlayers(room.players).some((player) => player.id === room.navigatorId)) {
    const replacement = orderedPlayers(room.players).find((player) => player.connected && player.alive !== false);
    if (replacement) room.navigatorId = replacement.id;
  }
  resolveGameOutcome(room, now);
}

function startMonsterMovement() {
  if (state.monsterTimer) return;
  state.monsterTimer = setInterval(() => {
    if (state.localMode) {
      const room = state.room;
      if (!room || room.phase !== "playing") {
        stopMonsterMovement();
        stopSeparationMonitor();
        return;
      }
      if (Date.now() - (Number(room.monster?.lastMovedAt) || 0) < MONSTER_MOVE_MS) return;
      const now = Date.now();
      advanceMonster(room, now);
      applyMonsterThreat(room, now);
      renderGame(room);
      updateDangerState();
      return;
    }
    if (!state.roomRef || state.room?.phase !== "playing" || state.room.navigatorId !== state.player.id ||
        state.room.players?.[state.player.id]?.alive === false) {
      stopMonsterMovement();
      return;
    }
    if (!Array.isArray(state.room.monster?.territory) || state.room.monster.territory.length < 2 ||
        !Array.isArray(state.room.monster?.route) || state.room.monster.route.length < 3) {
      initializeMonsterPatrol();
      return;
    }
    state.roomRef.transaction((room) => {
      const navigator = room?.players?.[state.player.id];
      if (!room || room.phase !== "playing" || room.navigatorId !== state.player.id ||
          navigator?.alive === false ||
          Date.now() - (Number(room.monster?.lastMovedAt) || 0) < (Number(room.monster?.moveInterval) || MONSTER_MOVE_MS)) return;
      const now = Date.now();
      advanceMonster(room, now);
      applyMonsterThreat(room, now);
      return room;
    }).catch((error) => console.error("Monster patrol could not synchronize.", error));
  }, 1000);
}

function stopMonsterMovement() {
  if (state.monsterTimer) clearInterval(state.monsterTimer);
  state.monsterTimer = null;
}

function updateSeparationState(room, now) {
  const explorers = livingPlayers(room.players)
    .filter((player) => player.id !== room.navigatorId && player.escaped !== true && validPosition(player.position, room.maze));
  let changed = false;
  if (explorers.length < 2) {
    for (const player of explorers) {
      if (player.separatedAt) {
        player.separatedAt = null;
        changed = true;
      }
    }
    return resolveGameOutcome(room, now) || changed;
  }
  const distanceMaps = explorers.map((player) => graphDistances(room.maze, player.position));
  let centerIndex = 0;
  let lowestTotal = Infinity;
  for (let index = 0; index < explorers.length; index += 1) {
    const total = explorers.reduce((sum, other) =>
      sum + (distanceMaps[index].get(`${other.position.x},${other.position.y}`) ?? Infinity), 0);
    if (total < lowestTotal) {
      lowestTotal = total;
      centerIndex = index;
    }
  }
  const center = explorers[centerIndex].position;
  const fromCenter = graphDistances(room.maze, center);
  for (const player of explorers) {
    const distance = fromCenter.get(`${player.position.x},${player.position.y}`) ?? Infinity;
    if (distance <= SAFE_DISTANCE) {
      if (player.separatedAt) {
        player.separatedAt = null;
        changed = true;
      }
      continue;
    }
    if (!player.separatedAt) {
      player.separatedAt = now;
      changed = true;
    }
    else if (now - player.separatedAt >= SEPARATION_GRACE_MS) {
      player.alive = false;
      player.lostAt = now;
      player.separatedAt = null;
      changed = true;
    }
  }
  return resolveGameOutcome(room, now) || changed;
}

function checkSeparation() {
  const room = state.room;
  if (!room || room.phase !== "playing") return;
  if (state.localMode) {
    updateSeparationState(room, Date.now());
    renderGame(room);
    return;
  }
  if (!state.roomRef || room.navigatorId !== state.player.id) return;
  state.roomRef.transaction((current) => {
    if (!current || current.phase !== "playing" || current.navigatorId !== state.player.id) return;
    if (!updateSeparationState(current, Date.now())) return;
    return current;
  }).catch((error) => console.error("Could not update separated player state.", error));
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
  const explorers = livingPlayers(room.players).filter((player) => player.id !== room.navigatorId);
  if (explorers.length && !(room.objectivePhase === 2 && explorers.every((player) => player.escaped === true))) return;
  if (state.localMode) {
    resolveGameOutcome(room);
    renderGame(room);
    return;
  }
  state.roomRef?.transaction((current) => {
    if (!current || current.phase !== "playing") return;
    resolveGameOutcome(current);
    if (current.phase === "playing") return;
    return current;
  }).catch((error) => console.error("Could not resolve the room outcome.", error));
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
  if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
  const keyToDirection = {
    ArrowUp: "up", w: "up", W: "up", ArrowRight: "right", d: "right", D: "right",
    ArrowDown: "down", s: "down", S: "down", ArrowLeft: "left", a: "left", A: "left"
  };
  const direction = keyToDirection[event.key];
  const me = state.room?.players?.[state.player?.id];
  if (!direction || state.room?.navigatorId === state.player?.id ||
      me?.alive === false || me?.escaped === true) return;
  event.preventDefault();
  movePlayer(direction);
}

function startLocalDemo() {
  if (state.presenceRef) {
    state.presenceRef.remove().catch((error) => console.error("Could not release remote presence before local play.", error));
  }
  state.roomRef?.off();
  state.roomRef?.child("messages").off();
  state.roomRef?.child("directions").off();
  state.roomRef = null;
  state.presenceRef = null;
  state.joined = false;
  localStorage.removeItem(ROOM_STORAGE_KEY);
  const maze = makeMaze();
  const setup = createMonsterSetup(maze);
  state.localMode = true;
  state.roomCode = "DEMO";
  state.room = {
    phase: "playing",
    gameId: "local-demo",
    objectivePhase: 1,
    navigatorId: "demo-navigator",
    startedAt: Date.now(),
    navigatorFoundAt: null,
    monster: {
      position: { ...setup.monsterPosition },
      territory: setup.territory,
      route: setup.route,
      routeIndex: setup.routeIndex,
      stepCount: 0,
      moveInterval: MONSTER_MOVE_MS,
      lastMovedAt: Date.now()
    },
    maze,
    players: {
      [state.player.id]: { ...state.player, connected: true, alive: true, escaped: false, joinedAt: 1, position: { ...maze.start } },
      "demo-navigator": { id: "demo-navigator", name: "The Navigator", color: PLAYER_COLORS[1], connected: true, alive: true, escaped: false, joinedAt: 2, position: setup.navigatorPosition }
    },
    messages: {}
  };
  renderGame(state.room);
  startMonsterMovement();
  startSeparationMonitor();
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
