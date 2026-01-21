const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

// --- CONSTANTS ---
const GAME_WIDTH = 2000;
const GAME_HEIGHT = 2000;
const TICK_RATE = 30; 
const CONFIG = {
  baseNPCs: 30,         // Slightly more decoys
  npcsPerPlayer: 10,
  npcSpeed: 170,
  sprintSpeed: 300,
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

// Integers are faster to send
const randomPos = () => ({
  x: Math.floor(Math.random() * (GAME_WIDTH - 100) + 50),
  y: Math.floor(Math.random() * (GAME_HEIGHT - 100) + 50),
});

function resetGame() {
  gameState.npcs = [];
  gameState.bullets = [];
  gameState.timer = CONFIG.gameDuration;
  gameState.events = [];
  gameState.status = "PLAYING";

  const playerIds = Object.keys(gameState.players);
  const totalNPCs = CONFIG.baseNPCs + (playerIds.length * CONFIG.npcsPerPlayer);

  // Generate Decoys
  for (let i = 0; i < totalNPCs; i++) {
    const pos = randomPos();
    gameState.npcs.push({
      id: `npc_${i}`,
      x: pos.x, y: pos.y,
      moveX: 0, moveY: 0, moveTimer: 0, sprinting: false,
      color: "#00ffcc", // Decoy Color
      mark: 0, dead: false,
    });
  }

  // Reset Players
  playerIds.forEach((id) => {
    const p = gameState.players[id];
    const pos = randomPos();
    p.x = pos.x; p.y = pos.y;
    p.dead = false; p.ammo = 0; p.idleTime = 0; p.stamina = 100;
    p.role = "hider"; 
    p.color = "#00ffcc"; // Everyone defaults to Decoy color (for disguise)
    p.mark = 0;
  });

  // Assign Hunter
  if (playerIds.length > 0) {
    const hunterId = playerIds[Math.floor(Math.random() * playerIds.length)];
    gameState.players[hunterId].role = "hunter";
    gameState.players[hunterId].ammo = CONFIG.hunterAmmo;
    // NOTE: We keep server color #00ffcc so clients don't see who hunter is.
    // The Hunter knows they are hunter via 'role' property.
  }
}

io.on("connection", (socket) => {
  console.log("Connect:", socket.id);

  gameState.players[socket.id] = {
    id: socket.id,
    x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2,
    role: "hider", color: "#ffffff", dead: false,
    name: "Agent " + socket.id.substr(0, 4),
    host: Object.keys(gameState.players).length === 0, 
    activeSlot: 1, stamina: 100
  };

  socket.emit("init", { id: socket.id, width: GAME_WIDTH, height: GAME_HEIGHT });

  socket.on("input", (input) => {
    const p = gameState.players[socket.id];
    if (!p || p.dead || gameState.status !== "PLAYING") return;

    if (input.slot) p.activeSlot = input.slot;

    // --- MOVEMENT ---
    let speed = CONFIG.npcSpeed; 
    if (p.role === "hunter") speed *= 1.1; // Hunter is 10% faster base

    // Sprint Logic
    let isMoving = (input.dx !== 0 || input.dy !== 0);
    let isSprinting = input.sprint && p.stamina > 0 && isMoving;
    
    if (isSprinting) {
        speed = CONFIG.sprintSpeed;
        p.stamina = Math.max(0, p.stamina - 1.5); 
    } else {
        p.stamina = Math.min(100, p.stamina + 0.5); 
    }

    if (isMoving) {
      const lenSq = input.dx*input.dx + input.dy*input.dy;
      const len = Math.sqrt(lenSq); 
      // Normalize and move
      p.x += (input.dx / len) * speed * (1 / TICK_RATE);
      p.y += (input.dy / len) * speed * (1 / TICK_RATE);
      p.idleTime = 0;
    } else {
      p.idleTime += 1 / TICK_RATE;
    }

    // Bounds
    p.x = Math.max(20, Math.min(GAME_WIDTH - 20, p.x));
    p.y = Math.max(20, Math.min(GAME_HEIGHT - 20, p.y));

    // --- SHOOTING / MARKING ---
    if (input.shoot && p.role === "hunter") {
        if (p.activeSlot === 1 && p.ammo > 0) {
            // FIRE BULLET
            p.ammo--;
            const angle = Math.atan2(input.aimY - p.y, input.aimX - p.x);
            gameState.bullets.push({
                x: p.x, y: p.y,
                vx: Math.cos(angle) * 1000, vy: Math.sin(angle) * 1000,
                life: 1.5, owner: p.id,
            });
            gameState.events.push({ type: "sound", name: "shoot" });
        } 
        else if (p.activeSlot === 2) {
            // MARK TARGET (Cheap collision check)
            const clickRadiusSq = 3600; 
            let hitFound = false;

            // Check NPCs first
            for (let n of gameState.npcs) {
                const dx = n.x - input.aimX;
                const dy = n.y - input.aimY;
                if (!n.dead && (dx*dx + dy*dy) < clickRadiusSq) {
                    n.mark = (n.mark + 1) % 4; 
                    hitFound = true; break; 
                }
            }
            // Check Players if no NPC hit
            if (!hitFound) {
                for (let pid in gameState.players) {
                    const target = gameState.players[pid];
                    const dx = target.x - input.aimX;
                    const dy = target.y - input.aimY;
                    if (target.role === "hider" && !target.dead && (dx*dx + dy*dy) < clickRadiusSq) {
                        target.mark = (target.mark + 1) % 4; break;
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
    for(let n of gameState.npcs) {
        if (n.dead) continue;
        if (n.moveTimer <= 0) {
            n.moveTimer = Math.random() * 2.0 + 0.5; 
            if (Math.random() < 0.2) { 
                n.moveX = 0; n.moveY = 0; n.sprinting = false;
            } else { 
                n.moveX = Math.floor(Math.random() * 3) - 1; 
                n.moveY = Math.floor(Math.random() * 3) - 1;
                n.sprinting = Math.random() < 0.3;
            }
        }
        n.moveTimer -= dt;

        if (n.moveX !== 0 || n.moveY !== 0) {
            let dMult = (n.moveX !== 0 && n.moveY !== 0) ? 0.7071 : 1;
            const speed = n.sprinting ? CONFIG.sprintSpeed : CONFIG.npcSpeed;
            n.x += n.moveX * speed * dMult * dt;
            n.y += n.moveY * speed * dMult * dt;
            
            // Wall Bouncing (Simple)
            if (n.x < 20) { n.x = 20; n.moveX *= -1; }
            else if (n.x > GAME_WIDTH - 20) { n.x = GAME_WIDTH - 20; n.moveX *= -1; }
            if (n.y < 20) { n.y = 20; n.moveY *= -1; }
            else if (n.y > GAME_HEIGHT - 20) { n.y = GAME_HEIGHT - 20; n.moveY *= -1; }
        }
    }

    // Bullet Logic
    const hitRadiusSq = 625; 
    for(let i = gameState.bullets.length - 1; i >= 0; i--) {
        const b = gameState.bullets[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;

        if (b.life <= 0) { gameState.bullets.splice(i, 1); continue; }

        let hit = false;
        // Check NPC Hits
        for(let n of gameState.npcs) {
            if (n.dead) continue;
            const dx = n.x - b.x, dy = n.y - b.y;
            if ((dx*dx + dy*dy) < hitRadiusSq) {
                n.dead = true; hit = true;
                gameState.events.push({ type: "kill", x: n.x, y: n.y, color: n.color });
                gameState.events.push({ type: "msg", text: "CIVILIAN CASUALTY" });
                gameState.events.push({ type: "shake", amount: 10 });
                break; 
            }
        }
        if(hit) { b.life = 0; gameState.bullets.splice(i, 1); continue; }

        // Check Player Hits
        for(let pid in gameState.players) {
            const p = gameState.players[pid];
            if (p.role === "hider" && !p.dead) {
                const dx = p.x - b.x, dy = p.y - b.y;
                if ((dx*dx + dy*dy) < hitRadiusSq) {
                    p.dead = true; hit = true;
                    gameState.events.push({ type: "kill", x: p.x, y: p.y, color: p.color });
                    gameState.events.push({ type: "msg", text: "TARGET ELIMINATED" });
                    gameState.events.push({ type: "shake", amount: 20 });
                    break;
                }
            }
        }
        if(hit || b.life <= 0) gameState.bullets.splice(i, 1);
    }

    // Win Conditions
    const allPlayers = Object.values(gameState.players);
    const livingHiders = allPlayers.filter(p => p.role === "hider" && !p.dead);
    const hunter = allPlayers.find(p => p.role === "hunter");
    let gameOverReason = null; let hunterWon = false;

    if (livingHiders.length === 0 && allPlayers.some(p => p.role === "hider")) {
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

  // Optimize Packet Size
  io.emit("tick", {
    players: gameState.players, 
    npcs: gameState.npcs.map(n => ({ x: (n.x|0), y: (n.y|0), dead: n.dead, color: n.color, mark: n.mark })), 
    bullets: gameState.bullets.map(b => ({ x: (b.x|0), y: (b.y|0), vx: b.vx, vy: b.vy })),
    timer: Math.round(gameState.timer),
    events: gameState.events 
  });
  gameState.events = [];
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });