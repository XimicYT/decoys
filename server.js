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
  // NPCs will now scale dynamically
  baseNPCs: 20,       // Minimum crowd
  npcsPerPlayer: 15,  // Add this many NPCs per human to keep density balanced
  npcSpeed: 180,      // Match player speed exactly for confusion
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
  
  // DYNAMIC DECOY COUNT
  // Ensures it's not "too easy" (too few) or "impossible" (too many)
  const totalNPCs = CONFIG.baseNPCs + (playerCount * CONFIG.npcsPerPlayer);

  // Generate NPCs with "Keyboard" brains
  for (let i = 0; i < totalNPCs; i++) {
    const pos = randomPos();
    gameState.npcs.push({
      id: `npc_${i}`,
      x: pos.x,
      y: pos.y,
      // AI "Input" State
      moveX: 0, // -1, 0, or 1 (Like A/D keys)
      moveY: 0, // -1, 0, or 1 (Like W/S keys)
      moveTimer: 0, // How long to hold this key press
      color: "#00ffcc",
      dead: false,
    });
  }

  // Reset Players
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
  });

  // Assign Hunter
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
  };

  socket.emit("init", { id: socket.id, width: GAME_WIDTH, height: GAME_HEIGHT });

  socket.on("input", (input) => {
    const p = gameState.players[socket.id];
    if (!p || p.dead || gameState.status !== "PLAYING") return;

    // Movement (Standardized to match NPC logic)
    if (input.dx !== 0 || input.dy !== 0) {
      const len = Math.hypot(input.dx, input.dy);
      // Normalize speed so diagonals aren't faster
      if (len > 0) {
        const speed = p.role === "hunter" ? CONFIG.playerSpeed * 1.1 : CONFIG.playerSpeed;
        p.x += (input.dx / len) * speed * (1 / TICK_RATE);
        p.y += (input.dy / len) * speed * (1 / TICK_RATE);
        p.idleTime = 0;
      }
    } else {
      p.idleTime += 1 / TICK_RATE;
    }

    // Boundary Checks
    p.x = Math.max(20, Math.min(GAME_WIDTH - 20, p.x));
    p.y = Math.max(20, Math.min(GAME_HEIGHT - 20, p.y));

    // Shooting
    if (input.shoot && p.role === "hunter" && p.ammo > 0) {
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
  });

  socket.on("startGame", () => {
    const p = gameState.players[socket.id];
    // REQ: Cannot start without 2nd player
    if (p && p.host && gameState.status !== "PLAYING") {
      if (Object.keys(gameState.players).length < 2) {
        return; // Silent fail or handle in UI
      }
      resetGame();
      io.emit("gameStart");
    }
  });

  socket.on("disconnect", () => {
    delete gameState.players[socket.id];
    if (Object.keys(gameState.players).length > 0) {
        gameState.players[Object.keys(gameState.players)[0]].host = true;
    }
    // If less than 2 players remain, end game
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

    // --- NEW NPC AI (WASD SIMULATION) ---
    gameState.npcs.forEach((n) => {
      if (n.dead) return;

      // 1. Brain Decision: Change keys?
      if (n.moveTimer <= 0) {
        // Pick new duration for this "key press"
        n.moveTimer = Math.random() * 2.0 + 0.5; 
        
        // Pick new direction (Discrete 8-way movement)
        // 20% chance to stand still (camp)
        if (Math.random() < 0.2) {
            n.moveX = 0; 
            n.moveY = 0;
        } else {
            // -1, 0, or 1
            n.moveX = Math.floor(Math.random() * 3) - 1; 
            n.moveY = Math.floor(Math.random() * 3) - 1;
        }
      }

      n.moveTimer -= dt;

      // 2. Physics Movement
      if (n.moveX !== 0 || n.moveY !== 0) {
        // Normalize exactly like player code
        const len = Math.hypot(n.moveX, n.moveY);
        if (len > 0) {
            n.x += (n.moveX / len) * CONFIG.npcSpeed * dt;
            n.y += (n.moveY / len) * CONFIG.npcSpeed * dt;
        }
      }

      // 3. Bounce off walls (Simulate player correcting course)
      if (n.x < 20) { n.x = 20; n.moveX = 1; }
      if (n.x > GAME_WIDTH - 20) { n.x = GAME_WIDTH - 20; n.moveX = -1; }
      if (n.y < 20) { n.y = 20; n.moveY = 1; }
      if (n.y > GAME_HEIGHT - 20) { n.y = GAME_HEIGHT - 20; n.moveY = -1; }
    });

    // --- BULLETS & COLLISIONS ---
    gameState.bullets.forEach((b) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      if (b.life > 0) {
        // NPC Hit
        gameState.npcs.forEach((n) => {
          if (!n.dead && Math.hypot(n.x - b.x, n.y - b.y) < 25) {
            n.dead = true;
            b.life = 0; 
            gameState.events.push({ type: "kill", x: n.x, y: n.y, color: n.color });
            gameState.events.push({ type: "msg", text: "CIVILIAN CASUALTY" });
            gameState.events.push({ type: "shake", amount: 10 });
          }
        });

        // Player Hit
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

    // --- WIN CONDITIONS ---
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

  io.emit("tick", {
    players: gameState.players,
    npcs: gameState.npcs.map(n => ({x:Math.round(n.x), y:Math.round(n.y), dead:n.dead, color:n.color})), 
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
