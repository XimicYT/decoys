const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// --- CONSTANTS & CONFIG ---
const GAME_WIDTH = 2000;
const GAME_HEIGHT = 2000;
const TICK_RATE = 30; 
const CONFIG = {
  baseNPCs: 20,
  npcsPerPlayer: 15,
  npcSpeed: 180,
  playerSpeed: 180,
  hunterAmmo: 3,
  gameDuration: 120,
};

// --- GAME STATE ---
let gameState = {
  status: "LOBBY",
  players: {}, 
  npcs: [],
  bullets: [],
  timer: 0,
  events: [], 
};

const randomPos = () => ({
  x: Math.random() * (GAME_WIDTH - 100) + 50,
  y: Math.random() * (GAME_HEIGHT - 100) + 50,
});

function resetGame() {
  gameState.npcs = [];
  gameState.bullets = [];
  gameState.timer = CONFIG.gameDuration;
  gameState.events = [];
  gameState.status = "PLAYING";

  const playerCount = Object.keys(gameState.players).length;
  const totalNPCs = CONFIG.baseNPCs + (playerCount * CONFIG.npcsPerPlayer);

  for (let i = 0; i < totalNPCs; i++) {
    const pos = randomPos();
    gameState.npcs.push({
      id: `npc_${i}`,
      x: pos.x,
      y: pos.y,
      moveX: 0, 
      moveY: 0, 
      moveTimer: 0, 
      color: "#00ffcc",
      mark: 0, // 0: None, 1: ?, 2: Check, 3: !
      dead: false,
    });
  }

  const playerIds = Object.keys(gameState.players);
  playerIds.forEach((id) => {
    const p = gameState.players[id];
    const pos = randomPos();
    p.x = pos.x;
    p.y = pos.y;
    p.dead = false;
    p.ammo = 0;
    p.idleTime = 0;
    p.role = "hider";
    p.color = "#00ffcc"; 
    p.mark = 0; // Reset marks
  });

  if (playerIds.length > 0) {
    const hunterId = playerIds[Math.floor(Math.random() * playerIds.length)];
    gameState.players[hunterId].role = "hunter";
    gameState.players[hunterId].color = "#ff0055"; 
    gameState.players[hunterId].ammo = CONFIG.hunterAmmo;
  }
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  gameState.players[socket.id] = {
    id: socket.id,
    x: GAME_WIDTH / 2,
    y: GAME_HEIGHT / 2,
    role: "hider",
    color: "#ffffff",
    dead: false,
    name: "Agent " + socket.id.substr(0, 4),
    host: Object.keys(gameState.players).length === 0, 
    activeSlot: 1 // Default to gun
  };

  socket.emit("init", { id: socket.id, width: GAME_WIDTH, height: GAME_HEIGHT });

  socket.on("input", (input) => {
    const p = gameState.players[socket.id];
    if (!p || p.dead || gameState.status !== "PLAYING") return;

    // Update Slot Selection
    if (input.slot) p.activeSlot = input.slot;

    // Movement 
    if (input.dx !== 0 || input.dy !== 0) {
      const len = Math.hypot(input.dx, input.dy);
      if (len > 0) {
        const speed = p.role === "hunter" ? CONFIG.playerSpeed * 1.1 : CONFIG.playerSpeed;
        p.x += (input.dx / len) * speed * (1 / TICK_RATE);
        p.y += (input.dy / len) * speed * (1 / TICK_RATE);
        p.idleTime = 0;
      }
    } else {
      p.idleTime += 1 / TICK_RATE;
    }

    p.x = Math.max(20, Math.min(GAME_WIDTH - 20, p.x));
    p.y = Math.max(20, Math.min(GAME_HEIGHT - 20, p.y));

    // ACTION HANDLING (Shoot vs Mark)
    if (input.shoot && p.role === "hunter") {
        
        // SLOT 1: GUN
        if (p.activeSlot === 1) {
            if (p.ammo > 0) {
                p.ammo--;
                const angle = Math.atan2(input.aimY - p.y, input.aimX - p.x);
                gameState.bullets.push({
                    x: p.x,
                    y: p.y,
                    vx: Math.cos(angle) * 1000,
                    vy: Math.sin(angle) * 1000,
                    life: 1.5, 
                    owner: p.id,
                });
                gameState.events.push({ type: "sound", name: "shoot" });
            }
        } 
        
        // SLOT 2: MARKER
        else if (p.activeSlot === 2) {
            // Find entity under mouse cursor (aimX, aimY)
            const clickRadius = 30;
            let hitFound = false;

            // Check NPCs
            for (let n of gameState.npcs) {
                if (!n.dead && Math.hypot(n.x - input.aimX, n.y - input.aimY) < clickRadius) {
                    n.mark = (n.mark + 1) % 4; // Cycle 0 -> 1 -> 2 -> 3 -> 0
                    hitFound = true;
                    break; // Only mark one at a time
                }
            }

            // Check Players (if NPC wasn't hit)
            if (!hitFound) {
                for (let pid in gameState.players) {
                    const target = gameState.players[pid];
                    if (target.role === "hider" && !target.dead && Math.hypot(target.x - input.aimX, target.y - input.aimY) < clickRadius) {
                        target.mark = (target.mark + 1) % 4;
                        // Optional: Send specific alert event if needed, but state sync handles visuals
                        if (target.mark > 0) {
                            // We could push an event, but the visual update is enough
                        }
                        break;
                    }
                }
            }
        }
    }
  });

  socket.on("startGame", () => {
    const p = gameState.players[socket.id];
    if (p && p.host && gameState.status !== "PLAYING") {
      if (Object.keys(gameState.players).length < 2) return;
      resetGame();
      io.emit("gameStart");
    }
  });

  socket.on("disconnect", () => {
    delete gameState.players[socket.id];
    if (Object.keys(gameState.players).length > 0) {
        gameState.players[Object.keys(gameState.players)[0]].host = true;
    }
    if (gameState.status === "PLAYING" && Object.keys(gameState.players).length < 2) {
      gameState.status = "ENDED";
      io.emit("gameOver", { reason: "NOT ENOUGH PLAYERS", hunterWon: false });
    }
  });
});

setInterval(() => {
  if (gameState.status === "PLAYING") {
    const dt = 1 / TICK_RATE;
    gameState.timer -= dt;

    // NPC Logic
    gameState.npcs.forEach((n) => {
      if (n.dead) return;
      if (n.moveTimer <= 0) {
        n.moveTimer = Math.random() * 2.0 + 0.5; 
        if (Math.random() < 0.2) { n.moveX = 0; n.moveY = 0; } 
        else { n.moveX = Math.floor(Math.random() * 3) - 1; n.moveY = Math.floor(Math.random() * 3) - 1; }
      }
      n.moveTimer -= dt;
      if (n.moveX !== 0 || n.moveY !== 0) {
        const len = Math.hypot(n.moveX, n.moveY);
        if (len > 0) {
            n.x += (n.moveX / len) * CONFIG.npcSpeed * dt;
            n.y += (n.moveY / len) * CONFIG.npcSpeed * dt;
        }
      }
      if (n.x < 20) { n.x = 20; n.moveX = 1; }
      if (n.x > GAME_WIDTH - 20) { n.x = GAME_WIDTH - 20; n.moveX = -1; }
      if (n.y < 20) { n.y = 20; n.moveY = 1; }
      if (n.y > GAME_HEIGHT - 20) { n.y = GAME_HEIGHT - 20; n.moveY = -1; }
    });

    // Bullets
    gameState.bullets.forEach((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      if (b.life > 0) {
        gameState.npcs.forEach((n) => {
          if (!n.dead && Math.hypot(n.x - b.x, n.y - b.y) < 25) {
            n.dead = true;
            b.life = 0; 
            gameState.events.push({ type: "kill", x: n.x, y: n.y, color: n.color });
            gameState.events.push({ type: "msg", text: "CIVILIAN CASUALTY" });
            gameState.events.push({ type: "shake", amount: 10 });
          }
        });

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

    // Win Conditions
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

  // Send tick (include Marks)
  io.emit("tick", {
    players: gameState.players,
    // Map NPCs to include 'mark'
    npcs: gameState.npcs.map(n => ({
        x: Math.round(n.x), 
        y: Math.round(n.y), 
        dead: n.dead, 
        color: n.color,
        mark: n.mark 
    })), 
    bullets: gameState.bullets,
    timer: Math.round(gameState.timer),
    events: gameState.events 
  });
  
  gameState.events = [];

}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});