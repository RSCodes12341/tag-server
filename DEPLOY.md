# Deploying TAG! to Railway (free)

## What this gets you
- Server runs 24/7 in the cloud
- Friends anywhere on the internet can join by code
- Tab-switching never affects gameplay (server owns the game loop)

---

## Step 1 — Push code to GitHub

1. Go to github.com → New repository → name it `tag-server` → Public → Create
2. On your computer, open a terminal in the folder containing `server.js` and `package.json`
3. Run:
```
git init
git add server.js package.json
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tag-server.git
git push -u origin main
```

---

## Step 2 — Deploy on Railway

1. Go to railway.app → Sign up with GitHub (free)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `tag-server` repo
4. Railway auto-detects Node.js and runs `npm start`
5. Click your deployment → **Settings** → **Networking** → **Generate Domain**
6. Copy the domain — it looks like `tag-server-production.up.railway.app`

---

## Step 3 — Connect in the game

In the game's Online Multiplayer screen, change the server URL from:
```
ws://localhost:8080
```
to:
```
wss://tag-server-production.up.railway.app
```
Note the `wss://` (secure WebSocket) — Railway requires this.

---

## Step 4 — Play

1. Host opens the game, pastes the Railway URL, clicks Connect, enters name, clicks **Create Room**
2. A 4-letter code appears (e.g. `BXQT`)
3. Friends open the same `index.html`, paste the Railway URL, click Connect, enter name, click **Join Room**, type the code
4. Host clicks **Start Game**

---

## Cost

Railway's Hobby tier gives $5 free credit/month.
A Node.js WebSocket server at this scale uses roughly $0.50–1.00/month.
**Effectively free for a game you play occasionally.**

## Troubleshooting

- **"Could not connect"** — make sure you're using `wss://` not `ws://` for Railway
- **Server sleeping** — Railway free tier doesn't sleep (unlike Render free tier)
- **Port errors** — the server reads `process.env.PORT` automatically, Railway sets this
