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
  npcSpeed: 170,      // Slightly slower base walk
  sprintSpeed: 300,   // Fast sprint
  hunterAmmo: 3,
  gameDuration: 120,
};

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
      sprinting: false, // NPC sprint state
      color: "#00ffcc",
      mark: 0, 
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
    p.stamina = 100; // Init Stamina
    p.role = "hider";
    p.color = "#00ffcc"; 
    p.mark = 0;
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
    activeSlot: 1,
    stamina: 100
  };

  socket.emit("init", { id: socket.id, width: GAME_WIDTH, height: GAME_HEIGHT });

  socket.on("input", (input) => {
    const p = gameState.players[socket.id];
    if (!p || p.dead || gameState.status !== "PLAYING") return;

    if (input.slot) p.activeSlot = input.slot;

    // STAMINA & SPEED LOGIC
    let currentSpeed = CONFIG.npcSpeed; // Base speed
    
    // Hunter is naturally 10% faster than base
    if (p.role === "hunter") currentSpeed *= 1.1;

    // Sprint Logic
    let isMoving = input.dx !== 0 || input.dy !== 0;
    if (input.sprint && p.stamina > 0 && isMoving) {
        currentSpeed = CONFIG.sprintSpeed; // Sprint override
        p.stamina = Math.max(0, p.stamina - 1.5); // Drain
    } else {
        p.stamina = Math.min(100, p.stamina + 0.5); // Regen
    }

    if (isMoving) {
      const len = Math.hypot(input.dx, input.dy);
      if (len > 0) {
        p.x += (input.dx / len) * currentSpeed * (1 / TICK_RATE);
        p.y += (input.dy / len) * currentSpeed * (1 / TICK_RATE);
        p.idleTime = 0;
      }
    } else {
      p.idleTime += 1 / TICK_RATE;
    }

    p.x = Math.max(20, Math.min(GAME_WIDTH - 20, p.x));
    p.y = Math.max(20, Math.min(GAME_HEIGHT - 20, p.y));

    if (input.shoot && p.role === "hunter") {
        // SLOT 1: GUN
        if (p.activeSlot === 1 && p.ammo > 0) {
            p.ammo--;
            const angle = Math.atan2(input.aimY - p.y, input.aimX - p.x);
            gameState.bullets.push({
                x: p.x, y: p.y,
                vx: Math.cos(angle) * 1000, vy: Math.sin(angle) * 1000,
                life: 1.5, owner: p.id,
            });
            gameState.events.push({ type: "sound", name: "shoot" });
        } 
        // SLOT 2: MARKER (Forgiving Hitbox)
        else if (p.activeSlot === 2) {
            const clickRadius = 60; // INCREASED FROM 30 to 60 for easier clicking
            let hitFound = false;

            // Prioritize NPCs first
            for (let n of gameState.npcs) {
                if (!n.dead && Math.hypot(n.x - input.aimX, n.y - input.aimY) < clickRadius) {
                    n.mark = (n.mark + 1) % 4; 
                    hitFound = true;
                    break; 
                }
            }
            // Check Players
            if (!hitFound) {
                for (let pid in gameState.players) {
                    const target = gameState.players[pid];
                    if (target.role === "hider" && !target.dead && Math.hypot(target.x - input.aimX, target.y - input.aimY) < clickRadius) {
                        target.mark = (target.mark + 1) % 4;
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
    if (Object.keys(gameState.players).length > 0) gameState.players[Object.keys(gameState.players)[0]].host = true;
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

      // Brain: Change direction OR Sprint status
      if (n.moveTimer <= 0) {
        n.moveTimer = Math.random() * 2.0 + 0.5; 
        
        // 20% chance to stop, 80% move
        if (Math.random() < 0.2) { 
            n.moveX = 0; n.moveY = 0; 
            n.sprinting = false;
        } else { 
            n.moveX = Math.floor(Math.random() * 3) - 1; 
            n.moveY = Math.floor(Math.random() * 3) - 1;
            // 30% chance to sprint when moving
            n.sprinting = Math.random() < 0.3;
        }
      }

      n.moveTimer -= dt;

      if (n.moveX !== 0 || n.moveY !== 0) {
        const len = Math.hypot(n.moveX, n.moveY);
        if (len > 0) {
            // Determine NPC Speed
            const speed = n.sprinting ? CONFIG.sprintSpeed : CONFIG.npcSpeed;
            n.x += (n.moveX / len) * speed * dt;
            n.y += (n.moveY / len) * speed * dt;
        }
      }
      
      // Bounds
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
            n.dead = true; b.life = 0; 
            gameState.events.push({ type: "kill", x: n.x, y: n.y, color: n.color });
            gameState.events.push({ type: "msg", text: "CIVILIAN CASUALTY" });
            gameState.events.push({ type: "shake", amount: 10 });
          }
        });
        Object.values(gameState.players).forEach((p) => {
          if (p.role === "hider" && !p.dead && Math.hypot(p.x - b.x, p.y - b.y) < 25) {
            p.dead = true; b.life = 0;
            gameState.events.push({ type: "kill", x: p.x, y: p.y, color: p.color });
            gameState.events.push({ type: "msg", text: "TARGET ELIMINATED" });
            gameState.events.push({ type: "shake", amount: 20 });
          }
        });
      }
    });
    gameState.bullets = gameState.bullets.filter((b) => b.life > 0);

    // Win Logic
    const livingHiders = Object.values(gameState.players).filter(p => p.role === "hider" && !p.dead);
    const hunter = Object.values(gameState.players).find(p => p.role === "hunter");
    let gameOverReason = null;
    let hunterWon = false;

    if (livingHiders.length === 0 && Object.values(gameState.players).some(p => p.role === "hider")) {
        gameOverReason = "ALL TARGETS ELIMINATED"; hunterWon = true;
    } else if (gameState.timer <= 0) {
        gameOverReason = "TIME EXPIRED"; hunterWon = false;
    } else if (hunter && hunter.ammo <= 0 && gameState.bullets.length === 0) {
        gameOverReason = "OUT OF AMMO"; hunterWon = false;
    }

    if (gameOverReason) {
        gameState.status = "ENDED";
        io.emit("gameOver", { reason: gameOverReason, hunterWon });
    }
  }

  io.emit("tick", {
    players: gameState.players,
    npcs: gameState.npcs.map(n => ({x:Math.round(n.x), y:Math.round(n.y), dead:n.dead, color:n.color, mark:n.mark})), 
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