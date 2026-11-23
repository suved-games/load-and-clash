# Load & Clash

An online 1v1 duel game. Both players pick a move in secret each round, build up their score with **Load**, unlock stronger attacks, and try to pick the defense that stops their opponent's attack. Each round has a 5-second timer.

"Load & Clash" is a placeholder name. Change it in `public/index.html` and `public/guide.html` (the `<title>` and the `<h1>`).

## Run it on your own computer

You need Node.js 20 or newer (free, from nodejs.org). There is nothing else to install.

```bash
cd clash-game        # the folder that contains server.js
node server.js
```

Open http://localhost:3000. To test alone, open the invite link in a second tab (each tab is its own player). In the second tab press **Ready**, then go back to the first tab and press **Start match**.

```bash
npm test                    # rules tests
PORT=8080 node server.js    # use another port
ROUND_MS=15000 node server.js   # change the round timer (milliseconds) while testing
```

This only works for you. To play with friends on their own phones and laptops, put the game online (next section).

## Put it online with Render (free) so friends can join by link

Render runs the game on the internet and gives you a link such as `https://load-and-clash.onrender.com`. Your friends open that link on any device.

1. **GitHub account.** Sign up (free) at github.com.
2. **Repository.** Click **+** at the top right, then **New repository**. Name it `load-and-clash`, choose **Public**, and click **Create repository**.
3. **Upload the files.** Unzip `clash-game.zip` and open the folder that contains `server.js`. On the new repository page, click **uploading an existing file**. Select everything inside that folder (`server.js`, `package.json`, `public`, `src`, `test`, `README.md`) and drag it into the browser. Wait for the upload, then click **Commit changes**. The repository's first page should now list `server.js` and `package.json` directly, not inside another folder.
4. **Render account.** Go to render.com and sign up with your GitHub account. Allow it to see your repository.
5. **New web service.** In the Render dashboard click **New**, then **Web Service**, and pick your `load-and-clash` repository. Fill in:
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
6. Click **Create Web Service** and wait a few minutes until it says **Live**. Your link is shown at the top of the page (it ends in `.onrender.com`).
7. **Test it** by opening the link on your computer, clicking **Create room**, and opening the invite link on your phone using mobile data instead of Wi-Fi. If both screens show the game, your friends can join too.
8. **Share.** Send friends the room invite link (or the 5-letter room code plus the website link). `Load-and-Clash-friends-guide.pdf` explains how to join and play, and the same guide is on the website at `/guide`.

### Good to know about the free plan

- The server goes to sleep after about 15 minutes with no visitors. The first visit afterwards takes up to a minute to wake it. Open the link a minute before your friends arrive.
- Rooms live in memory, so if the server restarts or sleeps, running games and rooms are lost. Create a new room.
- To update the game later, upload the changed files to the same GitHub repository (open the repository, **Add file**, **Upload files**, drag the changed files in, then **Commit changes**). Keep the same folder layout: `public` files go inside `public`, `src` files inside `src`. Render notices the new commit and redeploys by itself in a few minutes. Wait until it says **Live** again.
- You can read Render's own documentation at render.com/docs.

## How a match starts

1. The host creates a room and sends the invite link (or the 5-letter code).
2. The friend joins and lands in the **waiting room** with the host. They are shown as **Not ready**.
3. The friend presses **Ready** (and can press **Unready** to change their mind).
4. The host's **Start match** button switches on only while the friend is ready and online. Nobody else can start the match.
5. When a match ends, both players can press **Play again** for a rematch. If someone leaves, the host goes back to the waiting room. If the host leaves, the room closes.

## The match screen

- A white score card shows the score as a ratio, you : opponent (for example `2:2`), the last round's moves and what happened.
- Under the timer there are three controls: a **Defend** menu (Mag, N.V, Shield, Rebound), the big **Load** tile, and an **Attack** menu (Path to Professor, with the unlock score and the defenses that answer each one).
- Tap or click a move to highlight it, then press **Lock in**. **Double-click** (or double-tap) a move to lock it in straight away.

## Rules as implemented

| Move | Effect |
| --- | --- |
| Load | +1 to your score |
| Mag, N.V, Shield, Rebound | Defenses. Usable at any time. |

| Attack | Unlocks at | Answered by |
| --- | --- | --- |
| Path | 1 | Mag or N.V |
| Boss | 2 | Shield |
| Dam | 3 | Mag |
| ICY | 4 | N.V |
| Touch E | 5 | Rebound |
| Storm | 7 | N.V |
| Beast | 10 | Shield |
| Professor | 12 | Mag |

- An attack is available once your score is at least its number.
- If the defender uses a matching defense, the **attacker** loses points equal to the attack's number.
- If the defender uses anything else (including Load), the **defender loses** and the game ends.
- **Dam** against **Rebound**: the player who used Dam loses.
- **Touch E** against **Rebound**: the two scores are swapped.
- **Touch E** against any other defense, or against Load: the Touch E player takes the other player's whole score (the score they had at the start of the round). The game continues.
- **Touch E** against any other attack: the Touch E player loses.
- Both players attack: the bigger attack wins the game. If both use the same attack (Touch E included), both lose that many points and the game continues.
- Both players defending, or one loading while the other defends, never ends the game.
- After a game ends, either player can ask for a rematch. It starts when both agree.

### Timer

- Each round lasts 5 seconds. A player who has not locked in when time runs out plays **Load**.
- The timer only runs while both players are connected. If someone's connection drops, it pauses, and it restarts with a full 5 seconds when they are back.
- The timer lives on the server, so changing the clock on a phone does not help anyone.

### Keyboard

| Key | Move | Key | Move |
| --- | --- | --- | --- |
| L | Load | A | Path |
| Q | Mag | S | Boss |
| W | N.V | D | Dam |
| E | Shield | F | ICY |
| R | Rebound | G | Touch E |
| Z | Open or close the Defend menu | H | Storm |
| X | Open or close the Attack menu | J | Beast |
| Enter | Lock in | K | Professor |

Inside an open menu the up and down arrow keys choose a move, and Esc closes the menu.

To change any rule, edit `src/engine.js`. It is a set of pure functions, and both the server and the browser take their rules from it (the browser loads them from `/api/rules`). The key binds (`KEYS` and `MENU_KEYS`) are at the top of `public/app.js`, and the timer length is `ROUND_MS` in `server.js` (default 5000).

## Project layout

```
server.js              HTTP server, rooms, round timer, live updates
src/engine.js          the game rules, no I/O
public/                the website (index.html, style.css, app.js, guide.html, guide.css)
test/engine.test.js    rules tests
package.json           start and test commands
```

## How the live connection works

Each player's browser opens a Server-Sent Events stream to receive game state, and sends moves with ordinary requests. Some hosts and phone networks hold such streams back. If no state arrives within 5 seconds, the browser switches to asking for the state once a second (`GET /api/rooms/CODE/state`). Players never see the difference.

## Known limits

- **Rooms are in memory.** Restarting the server ends all games. Rooms nobody has touched for 3 hours are removed.
- **A player's seat lives in their browser tab.** Refreshing keeps it. Closing the tab gives up the seat, because there are no accounts.
- **Two players per room.** No spectators, chat, or match history. The round-by-round log was removed from the match screen; only the latest round is shown.
- Run **one** server instance only, because rooms are not shared between instances.
