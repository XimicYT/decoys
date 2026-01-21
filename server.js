const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from your HTML file
    methods: ["GET", "POST"],
  },
});

// --- CONSTANTS & CONFIG ---
const GAME_WIDTH = 2000;
const GAME_HEIGHT = 2000;
const TICK_RATE = 30; // Server updates per second
const CONFIG = {
  npcCount: 50,
  npcSpeed: 120,
  playerSpeed: 180,
  hunterAmmo: 3,
  gameDuration: 90, // seconds
  idleLimit: 5, // seconds before "!" appears
};

// --- GAME STATE ---
let gameState = {
  status: "LOBBY", // LOBBY, PLAYING, ENDED
  players: {}, // { socketId: { x, y, role, dead, ... } }
  npcs: [],
  bullets: [],
  timer: 0,
  events: [], // One-shot events (explosions, msgs) to send to client
};

// Helper to generate random position
const randomPos = () => ({
  x: Math.random() * GAME_WIDTH,
  y: Math.random() * GAME_HEIGHT,
});

// Helper to reset game
function resetGame() {
  gameState.npcs = [];
  gameState.bullets = [];
  gameState.timer = CONFIG.gameDuration;
  gameState.events = [];
  gameState.status = "PLAYING";

  // Generate NPCs
  for (let i = 0; i < CONFIG.npcCount; i++) {
    const pos = randomPos();
    gameState.npcs.push({
      id: `npc_${i}`,
      x: pos.x,
      y: pos.y,
      tx: pos.x, // Target X
      ty: pos.y, // Target Y
      wait: Math.random() * 2,
      color: "#00ffcc", // Cyan for everyone (Hiders blend in)
      dead: false,
    });
  }

  // Assign Roles
  const playerIds = Object.keys(gameState.players);
  // Reset player states
  playerIds.forEach((id) => {
    const p = gameState.players[id];
    const pos = randomPos();
    p.x = pos.x;
    p.y = pos.y;
    p.dead = false;
    p.ammo = 0;
    p.idleTime = 0;
    p.lastMoveTime = Date.now();
    p.role = "hider";
    p.color = "#00ffcc"; // Hiders look like NPCs
  });

  // Pick one Hunter
  if (playerIds.length > 0) {
    const hunterId = playerIds[Math.floor(Math.random() * playerIds.length)];
    gameState.players[hunterId].role = "hunter";
    gameState.players[hunterId].color = "#ff0055"; // Hunter is Red
    gameState.players[hunterId].ammo = CONFIG.hunterAmmo;
  }
}

// --- SOCKET HANDLING ---
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // Add new player
  gameState.players[socket.id] = {
    id: socket.id,
    x: GAME_WIDTH / 2,
    y: GAME_HEIGHT / 2,
    role: "hider",
    color: "#ffffff", // White in lobby
    dead: false,
    name: "Agent " + socket.id.substr(0, 4),
    host: Object.keys(gameState.players).length === 0, // First player is host
  };

  socket.emit("init", { id: socket.id, width: GAME_WIDTH, height: GAME_HEIGHT });

  socket.on("input", (input) => {
    const p = gameState.players[socket.id];
    if (!p || p.dead || gameState.status !== "PLAYING") return;

    // Movement Logic
    if (input.dx !== 0 || input.dy !== 0) {
      // Normalize vector
      const len = Math.hypot(input.dx, input.dy);
      const speed = p.role === "hunter" ? CONFIG.playerSpeed * 1.1 : CONFIG.playerSpeed; // Hunter slightly faster
      
      if (len > 0) {
        p.x += (input.dx / len) * speed * (1 / TICK_RATE);
        p.y += (input.dy / len) * speed * (1 / TICK_RATE);
        p.idleTime = 0;
        p.lastMoveTime = Date.now();
      }
    } else {
      // Track Idleness
      p.idleTime += 1 / TICK_RATE;
    }

    // Clamp to bounds
    p.x = Math.max(0, Math.min(GAME_WIDTH, p.x));
    p.y = Math.max(0, Math.min(GAME_HEIGHT, p.y));

    // Shooting Logic
    if (input.shoot && p.role === "hunter" && p.ammo > 0) {
      p.ammo--;
      const angle = Math.atan2(input.aimY - p.y, input.aimX - p.x);
      gameState.bullets.push({
        x: p.x,
        y: p.y,
        vx: Math.cos(angle) * 1000,
        vy: Math.sin(angle) * 1000,
        life: 1.5, // Seconds
        owner: p.id,
      });
      gameState.events.push({ type: "sound", name: "shoot" });
    }
  });

  socket.on("startGame", () => {
    const p = gameState.players[socket.id];
    if (p && p.host && gameState.status !== "PLAYING") {
      resetGame();
      io.emit("gameStart");
    }
  });

  socket.on("disconnect", () => {
    delete gameState.players[socket.id];
    // Reassign host if needed
    if (Object.keys(gameState.players).length > 0) {
        gameState.players[Object.keys(gameState.players)[0]].host = true;
    }
  });
});

// --- GAME LOOP ---
setInterval(() => {
  if (gameState.status === "PLAYING") {
    const dt = 1 / TICK_RATE;
    gameState.timer -= dt;

    // 1. Update NPCs (AI)
    gameState.npcs.forEach((n) => {
      if (n.dead) return;
      if (n.wait > 0) {
        n.wait -= dt;
      } else {
        const dx = n.tx - n.x;
        const dy = n.ty - n.y;
        const dist = Math.hypot(dx, dy);
        
        if (dist < 10) {
          // Reached destination, wait a bit then pick new spot
          n.wait = Math.random() * 3 + 1;
          n.tx = Math.random() * GAME_WIDTH;
          n.ty = Math.random() * GAME_HEIGHT;
        } else {
          n.x += (dx / dist) * CONFIG.npcSpeed * dt;
          n.y += (dy / dist) * CONFIG.npcSpeed * dt;
        }
      }
    });

    // 2. Update Bullets & Collisions
    gameState.bullets.forEach((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      if (b.life > 0) {
        // Check NPC Collisions
        gameState.npcs.forEach((n) => {
          if (!n.dead && Math.hypot(n.x - b.x, n.y - b.y) < 25) {
            n.dead = true;
            b.life = 0; // Destroy bullet
            // Penalize Hunter? 
            gameState.events.push({ type: "kill", x: n.x, y: n.y, color: n.color });
            gameState.events.push({ type: "msg", text: "CIVILIAN CASUALTY" });
            gameState.events.push({ type: "shake", amount: 10 });
          }
        });

        // Check Hider Collisions
        Object.values(gameState.players).forEach((p) => {
          if (p.role === "hider" && !p.dead && Math.hypot(p.x - b.x, p.y - b.y) < 25) {
            p.dead = true;
            b.life = 0;
            gameState.events.push({ type: "kill", x: p.x, y: p.y, color: p.color });
            gameState.events.push({ type: "msg", text: "TARGET ELIMINATED" });
            gameState.events.push({ type: "shake", amount: 20 });
          }
        });
      }
    });
    gameState.bullets = gameState.bullets.filter((b) => b.life > 0);

    // 3. Win Conditions
    const livingHiders = Object.values(gameState.players).filter(p => p.role === "hider" && !p.dead);
    const hunter = Object.values(gameState.players).find(p => p.role === "hunter");
    
    let gameOverReason = null;
    let hunterWon = false;

    if (livingHiders.length === 0 && Object.values(gameState.players).some(p => p.role === "hider")) {
        gameOverReason = "ALL TARGETS ELIMINATED";
        hunterWon = true;
    } else if (gameState.timer <= 0) {
        gameOverReason = "TIME EXPIRED - HIDERS SURVIVED";
        hunterWon = false;
    } else if (hunter && hunter.ammo <= 0 && gameState.bullets.length === 0) {
        gameOverReason = "OUT OF AMMO - HIDERS SURVIVED";
        hunterWon = false;
    }

    if (gameOverReason) {
        gameState.status = "ENDED";
        io.emit("gameOver", { reason: gameOverReason, hunterWon });
    }
  }

  // Broadcast State
  io.emit("tick", {
    players: gameState.players,
    npcs: gameState.npcs.map(n => ({x:Math.round(n.x), y:Math.round(n.y), dead:n.dead, color:n.color})), // Compress data slightly
    bullets: gameState.bullets,
    timer: Math.round(gameState.timer),
    events: gameState.events // Send events once
  });
  
  // Clear events after sending
  gameState.events = [];

}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
