# The Maze of Many

A realtime cooperative survival maze for 2–8 players, built as a static HTML/CSS/JavaScript site for GitHub Pages with Firebase Realtime Database.

## Play

1. Enable **Realtime Database** for the Firebase project configured in `script.js` and set rules that permit the demo's reads, writes, transactions, and disconnect handlers.
2. Publish with GitHub Pages, or run `python3 -m http.server 8000` from the repository root and open <http://localhost:8000>.
3. Enter a name, create a room, and share its four-character code. Other players enter that code to join.
4. The room host starts the run once at least two players are connected. One player is assigned as the stationary Navigator; the other players are Explorers.

## Game rules

- **Phase 01 — Find the Navigator:** Explorers move independently with WASD, arrow keys, or the on-screen directional pad. Their view is limited by fog, and the Navigator's marker only appears nearby. The Navigator cannot move and sees the whole maze.
- **Phase 02 — Find the Exit:** Reaching the Navigator reveals the exit objective. Explorers must physically find the exit; the Navigator guides them through live chat but cannot move anyone.
- A deterministic patrol route is generated and stored in the room for each maze. The Monster follows valid corridors at a steady pace. Staying within one corridor of it for long enough is fatal; use side passages and keep moving.
- Explorer separation is measured by maze paths, not straight-line distance. The most isolated Explorer gets a warning and 25 seconds to regroup before being lost.
- All living Explorers must reach the exit to complete the run. The Navigator is stationary and does not need to reach it.

Rooms are isolated at `rooms/{ROOM_CODE}`. Player identity, name, and last room are saved in localStorage so a refresh can reconnect. The client uses Firebase Realtime Database listeners and transactions to synchronize player positions, roles, objective phase, the shared Monster patrol, chat, and outcomes.

## Firebase notes

The supplied Firebase configuration is used directly by the browser. Realtime Database must be enabled and its rules must permit reads, writes, transactions, and disconnect handlers. This anonymous classroom demo does not authenticate users; open database rules are not appropriate for sensitive or production data.
