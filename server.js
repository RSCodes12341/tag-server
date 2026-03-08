/**
 * TAG! Game — Authoritative Server
 * The server runs the full game loop. Clients only send inputs and render state.
 * This means tab-switching, lag, or disconnects on any client never affect the game.
 *
 * Run: node server.js
 */

const { WebSocketServer, WebSocket } = require('ws');
const PORT = process.env.PORT || 8080;
const wss  = new WebSocketServer({ port: PORT });

// ─────────────────────────────────────────────
// SHARED GAME CONSTANTS (must match client)
// ─────────────────────────────────────────────
const PLAYER_SPEED   = 220;
const JUMP_FORCE     = -520;
const GRAVITY        = 1100;
const PLAYER_W       = 28;
const PLAYER_H       = 36;
const TAG_COOLDOWN   = 1.5;
const GAME_W         = 1200;
const GAME_H         = 600;
const TICK_RATE      = 20;          // state broadcasts per second
const TICK_MS        = 1000 / TICK_RATE;
const PHYS_STEP      = 1 / 60;     // physics at 60hz internally
const MAX_POWERUPS   = 3;
const POWERUP_SPAWN  = 8;          // seconds between spawns
const POWERUP_DUR    = 7;
const PLAYER_COLORS  = ['#ff3b3b','#3b8eff','#ffd93b','#3bff8a'];

const POWERUP_POOL = [
  { id:'superjump',  color:'#ffd93b', duration:POWERUP_DUR,  instant:false },
  { id:'superspeed', color:'#3bff8a', duration:POWERUP_DUR,  instant:false },
  { id:'teleport',   color:'#c03bff', duration:0,            instant:true  },
  { id:'chaos',      color:'#ff8c3b', duration:0,            instant:true  },
];

const SPAWN_POSITIONS = [{x:200,y:500},{x:900,y:500},{x:500,y:300},{x:700,y:300}];

const MAPS = {
  0: {
    platforms:[
      {x:0,y:560,w:1200,h:40},
      {x:80,y:430,w:180,h:18},{x:320,y:350,w:140,h:18},
      {x:530,y:460,w:170,h:18},{x:700,y:370,w:150,h:18},
      {x:880,y:450,w:190,h:18},{x:190,y:260,w:130,h:18},
      {x:480,y:215,w:190,h:18},{x:780,y:270,w:145,h:18},
      {x:1040,y:330,w:130,h:18},{x:40,y:130,w:110,h:18},
      {x:630,y:110,w:170,h:18},{x:950,y:170,w:140,h:18},
    ],
    jumpPads:[{x:250,y:559,w:60},{x:850,y:559,w:60},{x:500,y:213,w:50}],
  },
  1: {
    platforms:[
      {x:0,y:560,w:1200,h:40},
      {x:70,y:470,w:110,h:18},{x:260,y:400,w:95,h:18},
      {x:430,y:460,w:150,h:18},{x:630,y:390,w:115,h:18},
      {x:800,y:470,w:130,h:18},{x:1010,y:430,w:155,h:18},
      {x:140,y:310,w:115,h:18},{x:390,y:280,w:95,h:18},
      {x:590,y:255,w:130,h:18},{x:840,y:320,w:115,h:18},
      {x:290,y:175,w:95,h:18},{x:690,y:155,w:150,h:18},
      {x:1050,y:240,w:120,h:18},
    ],
    jumpPads:[{x:180,y:559,w:55},{x:720,y:559,w:55},{x:350,y:278,w:45}],
  },
  2: {
    platforms:[
      {x:40,y:560,w:380,h:18},{x:780,y:560,w:380,h:18},
      {x:240,y:440,w:130,h:18},{x:490,y:400,w:190,h:18},
      {x:790,y:440,w:130,h:18},{x:90,y:310,w:150,h:18},
      {x:370,y:270,w:170,h:18},{x:660,y:290,w:150,h:18},
      {x:960,y:310,w:150,h:18},{x:190,y:170,w:115,h:18},
      {x:545,y:140,w:190,h:18},{x:895,y:180,w:115,h:18},
      {x:380,y:70,w:120,h:18},{x:700,y:70,w:120,h:18},
    ],
    jumpPads:[{x:490,y:398,w:60},{x:200,y:168,w:50},{x:860,y:178,w:50}],
  },
};

// ─────────────────────────────────────────────
// ROOMS
// ─────────────────────────────────────────────
// rooms[code] = { code, config, players, status, gs, physAccum, powerupTimer, tickInterval }
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms[code]);
  return code;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data); });
}

function send(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

function roomInfo(room) {
  return {
    code: room.code,
    config: room.config,
    status: room.status,
    players: room.players.map(p => ({ name:p.name, idx:p.idx, color:p.color })),
  };
}

// ─────────────────────────────────────────────
// PHYSICS (server-authoritative)
// ─────────────────────────────────────────────
function initGameState(room) {
  const map = MAPS[room.config.map] || MAPS[0];
  return {
    players: room.players.map((rp, i) => ({
      x: SPAWN_POSITIONS[i].x,
      y: SPAWN_POSITIONS[i].y,
      vx: 0, vy: 0,
      onGround: false,
      isIt: i === 0,
      tagCooldown: i === 0 ? TAG_COOLDOWN : 0,
      facingRight: i % 2 === 0,
      bobPhase: Math.random() * Math.PI * 2,
      powerup: null,
      powerupTimer: 0,
    })),
    timeLeft: room.config.duration,
    taggerIdx: 0,
    powerups: [],
    powerupSpawnTimer: POWERUP_SPAWN * 0.4,
    map,
    mapIdx: room.config.map,
  };
}

function physStep(gs, room, dt) {
  // Powerup spawning
  gs.powerupSpawnTimer -= dt;
  if (gs.powerupSpawnTimer <= 0 && gs.powerups.length < MAX_POWERUPS) {
    gs.powerupSpawnTimer = POWERUP_SPAWN + (Math.random()*4 - 2);
    spawnPowerup(gs);
  }

  gs.players.forEach((p, i) => {
    const inp = room.players[i]?.input || { left:false, right:false, jump:false };

    // Speed / jump modifiers
    const spd = p.powerup === 'superspeed' ? PLAYER_SPEED * 2.0 : PLAYER_SPEED;
    const jf  = p.powerup === 'superjump'  ? JUMP_FORCE   * 1.7 : JUMP_FORCE;

    if (inp.left)       { p.vx = -spd; p.facingRight = false; }
    else if (inp.right) { p.vx =  spd; p.facingRight = true;  }
    else                  p.vx *= 0.80;

    if (inp.jump && p.onGround) { p.vy = jf; p.onGround = false; }

    p.vy += GRAVITY * dt;
    p.x  += p.vx   * dt;
    p.y  += p.vy   * dt;

    // Platform collisions
    p.onGround = false;
    for (const plat of gs.map.platforms) {
      if (p.x + PLAYER_W > plat.x && p.x < plat.x + plat.w) {
        const bot  = p.y + PLAYER_H;
        const prev = bot - p.vy * dt;
        if (prev <= plat.y + 2 && bot >= plat.y) {
          p.y = plat.y - PLAYER_H; p.vy = 0; p.onGround = true;
        }
      }
    }

    // Jump pads
    if (p.onGround) {
      for (const jp of (gs.map.jumpPads || [])) {
        if (p.x + PLAYER_W > jp.x && p.x < jp.x + jp.w && Math.abs((p.y + PLAYER_H) - jp.y) < 6) {
          p.vy = JUMP_FORCE * 1.6; p.onGround = false;
        }
      }
    }

    // World bounds
    if (p.x < 0)               { p.x = 0;               p.vx =  Math.abs(p.vx); }
    if (p.x + PLAYER_W > GAME_W){ p.x = GAME_W - PLAYER_W; p.vx = -Math.abs(p.vx); }
    if (p.y > GAME_H + 100)    { p.y = 100; p.vy = 0; }

    p.tagCooldown = Math.max(0, p.tagCooldown - dt);
    p.bobPhase   += dt * 5;

    // Powerup timer
    if (p.powerup && p.powerupTimer > 0) {
      p.powerupTimer -= dt;
      if (p.powerupTimer <= 0) { p.powerup = null; p.powerupTimer = 0; }
    }

    // Collect pickups
    for (let pi = gs.powerups.length - 1; pi >= 0; pi--) {
      const pw = gs.powerups[pi];
      if (!pw.alive) continue;
      if (p.x+PLAYER_W > pw.x && p.x < pw.x+pw.w && p.y+PLAYER_H > pw.y && p.y < pw.y+pw.h) {
        pw.alive = false;
        applyPowerup(gs, i, pw.id, room);
      }
    }
    gs.powerups = gs.powerups.filter(pw => pw.alive);

    // Tagging
    if (p.isIt && p.tagCooldown <= 0) {
      for (let j = 0; j < gs.players.length; j++) {
        if (j === i || gs.players[j].tagCooldown > 0) continue;
        const o = gs.players[j];
        const dx = (p.x + PLAYER_W/2) - (o.x + PLAYER_W/2);
        const dy = (p.y + PLAYER_H/2) - (o.y + PLAYER_H/2);
        if (Math.sqrt(dx*dx + dy*dy) < 40) {
          p.isIt = false; p.tagCooldown = TAG_COOLDOWN;
          o.isIt = true;  o.tagCooldown = TAG_COOLDOWN;
          gs.taggerIdx = j;
          broadcast(room, { type:'tagged', taggerIdx:j });
        }
      }
    }
  });
}

function spawnPowerup(gs) {
  const type = POWERUP_POOL[Math.floor(Math.random() * POWERUP_POOL.length)];
  const plats = gs.map.platforms.slice(1); // skip ground
  const plat  = plats[Math.floor(Math.random() * plats.length)];
  gs.powerups.push({
    id: type.id, color: type.color,
    x: plat.x + plat.w/2 - 15, y: plat.y - 34,
    w: 30, h: 30,
    floatPhase: Math.random() * Math.PI * 2,
    alive: true,
  });
}

function applyPowerup(gs, playerIdx, pwrId, room) {
  const p   = gs.players[playerIdx];
  const def = POWERUP_POOL.find(t => t.id === pwrId);
  if (!def) return;

  broadcast(room, { type:'powerupPickup', playerIdx, pwrId });

  if (def.instant) {
    if (pwrId === 'teleport') {
      const others = gs.players.filter((_,i) => i !== playerIdx);
      if (others.length > 0) {
        const target = others[Math.floor(Math.random() * others.length)];
        const tx=target.x, ty=target.y;
        target.x=p.x; target.y=p.y; target.vy=0;
        p.x=tx; p.y=ty; p.vy=0;
      }
    } else if (pwrId === 'chaos') {
      gs.players.forEach(pl => { pl.vy = JUMP_FORCE * (0.8 + Math.random()*0.5); pl.onGround = false; });
    }
  } else {
    p.powerup = pwrId;
    p.powerupTimer = def.duration;
  }
}

// ─────────────────────────────────────────────
// GAME TICK (runs entirely on server)
// ─────────────────────────────────────────────
function startGameLoop(room) {
  const FIXED_DT = PHYS_STEP;
  let lastTick = Date.now();
  let physAccum = 0;

  room.tickInterval = setInterval(() => {
    if (!room.gs) return;
    const now = Date.now();
    const elapsed = Math.min((now - lastTick) / 1000, 0.1); // cap at 100ms
    lastTick = now;

    // Timer
    room.gs.timeLeft -= elapsed;
    if (room.gs.timeLeft <= 0) {
      room.gs.timeLeft = 0;
      broadcast(room, { type:'gameover', loserIdx: room.gs.taggerIdx });
      stopGameLoop(room);
      room.status = 'ended';
      return;
    }

    // Fixed-step physics (multiple steps per tick for accuracy)
    physAccum += elapsed;
    while (physAccum >= FIXED_DT) {
      physStep(room.gs, room, FIXED_DT);
      physAccum -= FIXED_DT;
    }

    // Broadcast authoritative state to all clients
    broadcast(room, {
      type: 'state',
      state: {
        players: room.gs.players.map(p => ({
          x:p.x, y:p.y, vx:p.vx, vy:p.vy,
          onGround:p.onGround, isIt:p.isIt,
          tagCooldown:p.tagCooldown, facingRight:p.facingRight,
          powerup:p.powerup, powerupTimer:p.powerupTimer,
          bobPhase:p.bobPhase,
        })),
        timeLeft: room.gs.timeLeft,
        taggerIdx: room.gs.taggerIdx,
        powerups: room.gs.powerups,
      }
    });

  }, TICK_MS);
}

function stopGameLoop(room) {
  if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
}

// ─────────────────────────────────────────────
// WEBSOCKET HANDLER
// ─────────────────────────────────────────────
wss.on('connection', ws => {
  let playerRoom = null;
  let playerIdx  = -1;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CREATE ──
    if (msg.type === 'create') {
      const code = genCode();
      const room = {
        code,
        config: { duration: msg.duration||60, map: msg.map||0 },
        players: [{ ws, name: msg.name||'HOST', idx:0, color:PLAYER_COLORS[0], input:{left:false,right:false,jump:false} }],
        status: 'waiting',
        gs: null,
        tickInterval: null,
      };
      rooms[code] = room;
      playerRoom  = room;
      playerIdx   = 0;
      send(ws, { type:'created', code, playerIdx:0, room:roomInfo(room) });
      console.log(`[+] Room ${code} created by "${msg.name}"`);
    }

    // ── JOIN ──
    else if (msg.type === 'join') {
      const room = rooms[msg.code?.toUpperCase()];
      if (!room)                    return send(ws, { type:'error', msg:'Room not found. Check the code!' });
      if (room.status !== 'waiting') return send(ws, { type:'error', msg:'Game already started.' });
      if (room.players.length >= 4)  return send(ws, { type:'error', msg:'Room is full (max 4 players).' });

      const idx = room.players.length;
      room.players.push({ ws, name:msg.name||'PLAYER', idx, color:PLAYER_COLORS[idx], input:{left:false,right:false,jump:false} });
      playerRoom = room;
      playerIdx  = idx;

      send(ws, { type:'joined', playerIdx:idx, room:roomInfo(room) });
      broadcast(room, { type:'playerList', players:roomInfo(room).players });
      console.log(`[+] "${msg.name}" joined ${msg.code} as P${idx+1}`);
    }

    // ── START (any player can start once 2+ are in lobby) ──
    else if (msg.type === 'start') {
      if (!playerRoom || playerRoom.status !== 'waiting') return;
      if (playerRoom.players.length < 2) return send(ws, { type:'error', msg:'Need at least 2 players to start.' });
      playerRoom.status = 'playing';
      playerRoom.config.playerCount = playerRoom.players.length;
      if (msg.duration) playerRoom.config.duration = msg.duration;
      if (msg.map !== undefined) playerRoom.config.map = msg.map;
      playerRoom.gs = initGameState(playerRoom);
      broadcast(playerRoom, { type:'start', config:playerRoom.config, room:roomInfo(playerRoom) });
      startGameLoop(playerRoom);
      console.log(`[>] Room ${playerRoom.code} started (${playerRoom.players.length} players, map ${playerRoom.config.map})`);
    }

    // ── INPUT (all players send their inputs each frame) ──
    else if (msg.type === 'input') {
      if (!playerRoom || playerIdx < 0) return;
      const rp = playerRoom.players[playerIdx];
      if (rp) rp.input = msg.input;
    }

    // ── CONFIG UPDATE (lobby only) ──
    else if (msg.type === 'config') {
      if (!playerRoom || playerRoom.status !== 'waiting') return;
      if (msg.duration) playerRoom.config.duration = msg.duration;
      if (msg.map !== undefined) playerRoom.config.map = msg.map;
      broadcast(playerRoom, { type:'configUpdate', config:playerRoom.config });
    }
  });

  ws.on('close', () => {
    if (!playerRoom) return;
    const code = playerRoom.code;
    console.log(`[-] P${playerIdx+1} ("${playerRoom.players[playerIdx]?.name}") left room ${code}`);
    playerRoom.players[playerIdx].ws = null; // mark as disconnected

    // Check if all disconnected
    const alive = playerRoom.players.filter(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (alive.length === 0) {
      stopGameLoop(playerRoom);
      delete rooms[code];
      console.log(`[-] Room ${code} deleted (empty)`);
    } else {
      broadcast(playerRoom, { type:'playerLeft', playerIdx, name:playerRoom.players[playerIdx]?.name });
    }
  });
});

// ─────────────────────────────────────────────
// CLEANUP stale rooms (older than 30min)
// ─────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  Object.entries(rooms).forEach(([code, room]) => {
    if (room._created && now - room._created > 30 * 60 * 1000) {
      stopGameLoop(room);
      delete rooms[code];
      console.log(`[~] Cleaned up stale room ${code}`);
    }
  });
}, 60_000);

// Stamp rooms on creation
const _origWss = wss.on.bind(wss);
Object.values(rooms).forEach(r => r._created = Date.now());

console.log(`\n🏷️  TAG! Authoritative Server — port ${PORT}`);
console.log(`   Game loop runs on server. Tab switching won't affect gameplay.\n`);
