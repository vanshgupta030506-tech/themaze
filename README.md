# The Maze of Many

A realtime cooperative maze for 2–8 people. It is a static HTML/CSS/JavaScript site for GitHub Pages and uses Firebase Realtime Database to share the lobby, generated maze, player positions, directions, markers, and chat.

## Play

1. Enable **Realtime Database** for the Firebase project in `script.js` and configure its classroom-demo database rules to permit the required reads and writes.
2. Publish the repository with GitHub Pages, or run `python3 -m http.server 8000` from the repository root and open <http://localhost:8000>.
3. Open the same URL on each device. The first connected player starts the run once at least two players have joined.
4. The randomly selected Navigator sees the full map and cannot move. Explorers use WASD, arrow keys, or the on-screen controls. The group wins when every connected Explorer reaches the exit.

The app displays a connection error if it cannot reach Firebase. That screen includes a **Play a local demo** option so maze movement can still be tried without a database connection; local demo state is not shared between devices.

## Firebase notes

The supplied Firebase configuration is used directly by the browser. Realtime Database must be enabled and its rules must allow the demo's reads/writes. This anonymous classroom demo does not authenticate users; do not use open database rules for sensitive or production data.

Player presence is tracked separately from player state using Realtime Database disconnect handlers. A maze is generated inside a Firebase transaction so only one shared maze is committed when the host starts a run.
