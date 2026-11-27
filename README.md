# Hex Men

An online duel game for friends. Both players pick a move in secret each round, build up their score with **Load**, unlock stronger attacks, and try to pick the defense that stops their opponent's attack. Each round has a 5-second timer. Play a **1v1**, a **Team vs Team** battle (2v2, 3v3 or 4v4), or a 4 or 8 player **Tournament** with a random bracket.

The game was called "Load & Clash" before. Your GitHub repository and Render service can keep their old names, because nothing in the game depends on them. Note that renaming a Render service in **Settings** only changes its name in the dashboard. Its `.onrender.com` address is fixed when the service is created. To get `hex-men.onrender.com`, see "Getting a new web address" below.

## Run it on your own computer

You need Node.js 20 or newer (free, from nodejs.org). There is nothing else to install.

```bash
cd hex-men          # the folder that contains server.js
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

Render runs the game on the internet and gives you a link such as `https://your-service-name.onrender.com`. Your friends open that link on any device.

1. **GitHub account.** Sign up (free) at github.com.
2. **Repository.** Click **+** at the top right, then **New repository**. Give it any name (for example `hex-men`), choose **Public**, and click **Create repository**.
3. **Upload the files.** Unzip `hex-men.zip` and open the folder that contains `server.js`. On the new repository page, click **uploading an existing file**. Select everything inside that folder (`server.js`, `package.json`, `public`, `src`, `test`, `README.md`). The `public` folder now holds an `img` folder with the logo and the move pictures, so upload it whole and drag it into the browser. Wait for the upload, then click **Commit changes**. The repository's first page should now list `server.js` and `package.json` directly, not inside another folder.
4. **Render account.** Go to render.com and sign up with your GitHub account. Allow it to see your repository.
5. **New web service.** In the Render dashboard click **New**, then **Web Service**, and pick your repository. Fill in:
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
6. Click **Create Web Service** and wait a few minutes until it says **Live**. Your link is shown at the top of the page (it ends in `.onrender.com`).
7. **Test it** by opening the link on your computer, clicking **Create room**, and opening the invite link on your phone using mobile data instead of Wi-Fi. If both screens show the game, your friends can join too.
8. **Share.** Send friends the room invite link (or the 5-letter room code plus the website link). `Hex-Men-friends-guide.pdf` explains how to join and play, and the same guide is on the website at `/guide`.

### Good to know about the free plan

- The server goes to sleep after about 15 minutes with no visitors. The first visit afterwards takes up to a minute to wake it. Open the link a minute before your friends arrive.
- Rooms live in memory, so if the server restarts or sleeps, running games and rooms are lost. Create a new room.
- To update the game later, upload the changed files to the same GitHub repository (open the repository, **Add file**, **Upload files**, drag the changed files in, then **Commit changes**). Keep the same folder layout: `public` files go inside `public`, `src` files inside `src`, and the pictures inside `public/img`. Render notices the new commit and redeploys by itself in a few minutes. Wait until it says **Live** again.
- You can read Render's own documentation at render.com/docs.

### Getting a new web address (for example hex-men.onrender.com)

Render does not let you change the `.onrender.com` address of an existing service. Your two options:

1. **Make a second service with the new name.** In Render click **New**, then **Web Service**, pick the same GitHub repository, and type `hex-men` as the **Name**. Use the same settings as in step 5. If nobody else has taken that name, the address is `https://hex-men.onrender.com`. If it is taken, Render adds random letters to it, and you can try another name. Once the new one is **Live** and works, open the old service, go to **Settings**, scroll to the bottom and choose **Delete Web Service**. The old link stops working, so send friends the new one.
2. **Use your own domain.** Buy a domain name from a registrar, then add it in the service's **Settings** under **Custom Domains** and follow Render's DNS instructions. This gives the cleanest link, but a domain costs money each year.

## How a match starts

1. The host creates a room and sends the invite link (or the 5-letter code).
2. The friend joins and lands in the **waiting room** with the host. They are shown as **Not ready**.
3. The friend presses **Ready** (and can press **Unready** to change their mind).
4. The host's **Start match** button switches on only while the friend is ready and online. Nobody else can start the match.
5. When a match ends, both players can press **Play again** for a rematch. If someone leaves, the host goes back to the waiting room. If the host leaves, the room closes.

## The match screen

- A white score card shows the score as a ratio, you : opponent (for example `2:2`), the last round's moves with their pictures, and what happened. The other player's picture is mirrored so the two hands face each other.
- Under the timer there are three controls: a **Defence** button, the big **Load** tile, and an **Attack** button.
- **Defence** and **Attack** open a **wheel menu**: the four defenses (Mag, N.V, Shield, Rebound) or the eight attacks (Path to Professor), each with its picture, its rim colors showing which defense answers it, and what it needs to unlock. The middle of the wheel explains the move you point at.
- Tap or click a move to pick it, then press **Lock in**. **Double-click** (or double-tap) a move to lock it in straight away.

## Team vs Team

1. On the home page the host picks **Team vs Team**, the team size (2v2, 3v3 or 4v4) and how many wins a team needs (7 to 25), then creates the room.
2. Everyone who joins starts in **Waiting**. Each person presses **Join** on Team Red or Team Blue. To switch, press the other team's Join button if it has room, or go back to Waiting first.
3. **Player 1** of each team (the first player in the team's order) sets the team's **name** (any text) and **color** (15 to pick from, and the other team's color is not offered).
4. Both teams must be full. Everyone presses **Ready**.
5. **Order screen.** Each team secretly sets the order its players will fight in. Any teammate can move players up or down, and the order becomes final when every teammate confirms. Moving anyone clears the confirmations. The other team's order stays hidden until both teams are final.
6. **Match lobby.** Both orders and the team score (starting at 0 : 0) are shown. Only the two players who are up press **Ready**. Everyone else watches each round once it is revealed.
7. The winner of each 1v1 game stays on and scores 1 point for their team. The loser's team sends its next player, and after its last player it starts again from Player 1.
8. The first team to reach the wins needed takes the game. **Play again** returns everyone to the team lobby with the same teams.

Details worth knowing: a room holds exactly twice the team size in players. Anyone who leaves a game in progress forfeits their match, and a team with nobody left loses. A player who stays away from the waiting room or lobby for about 2 minutes is removed.

## Tournament

1. On the home page the host picks **Tournament**, **4 or 8 players** and the match length, **best of 3** (win 2 duels) or **best of 5** (win 3 duels). A *duel* is one full 1v1 game, played until someone wins; both players start each duel at 0.
2. Everyone joins from the link and presses **Ready** in the tournament lobby. When the room is full and every player is ready, the bracket is drawn at random. The host is a player too, so the room holds exactly 4 or 8 people.
3. **Bracket screen.** The two players in the first match press **Ready**; the others spectate. Before every later duel of the same match both players press **Ready** again, on the **match lobby**, which shows the duel score and the winning round of the last duel.
4. **4 players:** Semi-final 1, Semi-final 2, then the Final.
5. **8 players:** two groups of four (Group A and Group B). Stage 1 is the first match of each group (both start together, once all four players have pressed Ready), stage 2 is the second match of each group, stage 3 the two group finals, and stage 4 the grand final. Both groups move in step: a stage starts when everyone who is up has pressed Ready. A player whose match is over spectates the live match (their own group's first).
6. After every stage the **bracket screen** shows the results so far and the players who are up next press **Ready**.
7. The winner gets the **Congratulations** screen, shown to everyone. **Play again** brings everyone back to the tournament lobby for a new random draw.

Details worth knowing: leaving a tournament forfeits your current or next match (your opponent gets a walkover), and when only one player is left they win. A player who stays away for about 2 minutes is removed. The 5-second timer and every game rule are the same as in 1v1.

## Rules as implemented

| Move | Effect |
| --- | --- |
| Load | +1 to your score (+2 if the other player used Rebound) |
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
- **Load** against **Rebound**: the Load player gains **2** points instead of 1. Load against any other defense still gains 1.
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
| Z | Open or close the Defence wheel | H | Storm |
| X | Open or close the Attack wheel | J | Beast |
| Enter | Lock in | K | Professor |

Inside an open wheel the arrow keys move round it and pick the move, and Esc closes it.

To change any rule, edit `src/engine.js`. It is a set of pure functions, and both the server and the browser take their rules from it (the browser loads them from `/api/rules`). The key binds (`KEYS` and `MENU_KEYS`) are at the top of `public/app.js`, the team rules (order, rotation, scoring) are in `src/team.js`, the tournament rules (bracket, stages, best of) are in `src/tournament.js`, and the timer length is `ROUND_MS` in `server.js` (default 5000).

## Project layout

```
server.js              HTTP server, 1v1, team and tournament rooms, round timer, live updates
src/engine.js          the 1v1 game rules, no I/O
src/team.js            Team vs Team rules (teams, order, rotation, scoring), no I/O
src/tournament.js      Tournament rules (bracket draw, stages, duels, walkovers), no I/O
public/index.html      the game page
public/app.js          the game screen, menus, keys and results
public/wheel.js        the Defence and Attack wheel menus
public/team-ui.js      the Team vs Team screens
public/tournament-ui.js the Tournament screens (lobby, bracket, match lobby, winner)
public/ui-bits.js      small pieces shared by the team and tournament screens
public/dom.js          small helpers and the move pictures list
public/style.css       all the styling (white theme)
public/guide.html      the friends guide (also at /guide), with guide.css
public/img/            logo.png and moves/ (one picture per move)
public/favicon.png     the browser tab icon (and apple-touch-icon.png)
test/                  engine.test.js, team.test.js and tournament.test.js
package.json           start and test commands
```

## How the live connection works

Each player's browser opens a Server-Sent Events stream to receive game state, and sends moves with ordinary requests. Some hosts and phone networks hold such streams back. If no state arrives within 5 seconds, the browser switches to asking for the state once a second (`GET /api/rooms/CODE/state`). Players never see the difference.

## Known limits

- **Rooms are in memory.** Restarting the server ends all games. Rooms nobody has touched for 3 hours are removed.
- **A player's seat lives in their browser tab.** Refreshing keeps it. Closing the tab gives up the seat, because there are no accounts.
- **No chat or match history.** In a 1v1 room it is two players only. In a team or tournament room, players who are not up watch each round once it is revealed. Only the latest round is shown on the card.
- Run **one** server instance only, because rooms are not shared between instances.
