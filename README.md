# The Maze of Many

A realtime, cooperative survival maze for 2–8 players. It is a static HTML/CSS/JavaScript site for GitHub Pages and uses Firebase Realtime Database. Players enter a name, create or join a four-character room, and then move as one party through a shared generated maze.

## Play

1. Enable **Realtime Database** for the Firebase project in `script.js` and configure rules that permit the demo reads and writes.
2. Publish this repository with GitHub Pages, or run `python3 -m http.server 8000` from the repository root and open <http://localhost:8000>.
3. Enter a name, create a room, then share its code. Other players enter that code to join the same lobby.
4. Once at least two people are present, the host starts the run. A random player becomes Navigator and controls the entire party with arrow keys, WASD, or on-screen controls.
5. The Navigator sees the whole map and the moving Monster. Explorers see only nearby cells. Stay together, avoid the Monster, and reach the exit.

Rooms are stored independently at `rooms/{ROOM_CODE}`. Player ID, name, and last room are saved in localStorage so refreshes can reconnect to the same player and room. A player who is separated by more than two maze steps gets a warning and has 15 seconds to regroup before being lost.

## Firebase notes

The supplied Firebase configuration is used directly by the browser. Realtime Database must be enabled and its rules must permit reads, writes, transactions, and disconnect handlers. This anonymous classroom demo does not authenticate users; open database rules are not appropriate for sensitive or production data.
