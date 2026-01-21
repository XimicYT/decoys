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
  baseNPCs: 30,
  npcsPerPlayer: 10,
  npcSpeed: 170,
  sprintSpeed: 300,
  spectatorSpeed: 600, // Fast movement for dead players
  fireRate: 0.6,       // Seconds between shots
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

  // 1. Generate Decoys
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

  // 2. Assign Hunter
  let hunterId = null;
  if (playerIds.length > 0) {
    hunterId = playerIds[Math.floor(Math.random() * playerIds.length)];
  }

  // 3. Dynamic Ammo Calculation
  // Base allowed mistakes (2) + 1 per Hider.
  const hiderCount = Math.max(1, playerIds.length - 1);
  const hunterLives = 2 + hiderCount;

  // 4. Setup Players
  playerIds.forEach((id) => {
    const p = gameState.players[id];
    p.dead = false; 
    p.ammo = 0; 
    p.shootTimer = 0; // Cooldown tracker
    p.idleTime = 0; 
    p.stamina = 100;
    p.role = (id === hunterId) ? "hunter" : "hider";
    p.color = "#00ffcc"; 
    p.mark = 0;

    if (p.role === "hunter") {
        p.ammo = hunterLives;
    }

    // Safe Spawning Logic
    let pos = randomPos();
    if (p.role === "hider" && hunterId) {
        const hunterP = gameState.players[hunterId];
        let attempts = 0;
        let dist = 0;
        // Ensure Hider is at least 800px away from Hunter
        do {
            pos = randomPos();
            const dx = pos.x - hunterP.x;
            const dy = pos.y - hunterP.y;
            dist = Math.sqrt(dx*dx + dy*dy);
            attempts++;
        } while (dist < 800 && attempts < 15);
    }
    p.x = pos.x; p.y = pos.y;
  });
}

io.on("connection", (socket) => {
  console.log("Connect:", socket.id);
  
  // Send init immediately so client can render map/menu
  socket.emit("init", { id: socket.id, width: GAME_WIDTH, height: GAME_HEIGHT });

  // Player joins only after clicking button
  socket.on("joinGame", (data) => {
    if (gameState.players[socket.id]) return;

    // Sanitize Name
    let cleanName = (data.name || "AGENT").replace(/[^a-zA-Z0-9 ]/g, "").substring(0, 14);
    if(cleanName.length === 0) cleanName = "AGENT";

    gameState.players[socket.id] = {
      id: socket.id,
      x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2,
      role: "hider", 
      color: "#ffffff", 
      dead: false,
      name: cleanName,
      host: Object.keys(gameState.players).length === 0, 
      activeSlot: 1, 
      stamina: 100,
      shootTimer: 0
    };
  });

  socket.on("input", (input) => {
    const p = gameState.players[socket.id];
    if (!p || gameState.status !== "PLAYING") return;

    if (input.slot) p.activeSlot = input.slot;

    // --- MOVEMENT ---
    let speed = CONFIG.npcSpeed; 
    
    // Spectator Speed Logic
    if (p.dead) {
        speed = CONFIG.spectatorSpeed;
    } else {
        if (p.role === "hunter") speed *= 1.1; 
        
        let isMoving = (input.dx !== 0 || input.dy !== 0);
        let isSprinting = input.sprint && p.stamina > 0 && isMoving;
        
        if (isSprinting) {
            speed = CONFIG.sprintSpeed;
            p.stamina = Math.max(0, p.stamina - 1.5); 
        } else {
            p.stamina = Math.min(100, p.stamina + 0.5); 
        }
        if (!isMoving) p.idleTime += 1 / TICK_RATE;
        else p.idleTime = 0;
    }

    if (input.dx !== 0 || input.dy !== 0) {
      const lenSq = input.dx*input.dx + input.dy*input.dy;
      const len = Math.sqrt(lenSq); 
      p.x += (input.dx / len) * speed * (1 / TICK_RATE);
      p.y += (input.dy / len) * speed * (1 / TICK_RATE);
    }

    // Bounds
    p.x = Math.max(20, Math.min(GAME_WIDTH - 20, p.x));
    p.y = Math.max(20, Math.min(GAME_HEIGHT - 20, p.y));

    // --- SHOOTING (Alive Only) ---
    if (p.dead) return; 

    if (input.shoot && p.role === "hunter") {
        if (p.activeSlot === 1) {
            // Rate Limit Check
            if (p.shootTimer <= 0) {
                // We do NOT decrement ammo here. 
                p.shootTimer = CONFIG.fireRate; // Reset cooldown

                const angle = Math.atan2(input.aimY - p.y, input.aimX - p.x);
                gameState.bullets.push({
                    x: p.x, y: p.y,
                    vx: Math.cos(angle) * 1000, vy: Math.sin(angle) * 1000,
                    life: 1.5, owner: p.id,
                });
                gameState.events.push({ type: "sound", name: "shoot" });
            }
        } 
        else if (p.activeSlot === 2) {
            const clickRadiusSq = 3600; 
            let hitFound = false;
            // Check NPCs
            for (let n of gameState.npcs) {
                const dx = n.x - input.aimX;
                const dy = n.y - input.aimY;
                if (!n.dead && (dx*dx + dy*dy) < clickRadiusSq) {
                    n.mark = (n.mark + 1) % 4; 
                    hitFound = true; break; 
                }
            }
            // Check Players
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
    if (gameState.players[socket.id]) {
        delete gameState.players[socket.id];
        if (Object.keys(gameState.players).length > 0) {
            gameState.players[Object.keys(gameState.players)[0]].host = true;
        }
        if (gameState.status === "PLAYING" && Object.keys(gameState.players).length < 2) {
            gameState.status = "ENDED";
            io.emit("gameOver", { reason: "NOT ENOUGH PLAYERS", hunterWon: false });
        }
    }
  });
});

setInterval(() => {
  if (gameState.status === "PLAYING") {
    const dt = 1 / TICK_RATE;
    gameState.timer -= dt;

    // Cooldown Logic
    for (let pid in gameState.players) {
        if (gameState.players[pid].shootTimer > 0) {
            gameState.players[pid].shootTimer -= dt;
        }
    }

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
                
                // PENALTY: Killing NPC reduces lives
                const hunter = gameState.players[b.owner];
                if (hunter) {
                    hunter.ammo--;
                    gameState.events.push({ type: "msg", text: `CIVILIAN KILLED! (${hunter.ammo} LEFT)` });
                }

                gameState.events.push({ type: "kill", x: n.x, y: n.y, color: n.color });
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
                    // NO PENALTY for killing players
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
    } else if (hunter && hunter.ammo <= 0) {
        gameOverReason = "TOO MANY CIVILIAN CASUALTIES"; hunterWon = false;
    }

    if (gameOverReason) {
        gameState.status = "ENDED";
        io.emit("gameOver", { reason: gameOverReason, hunterWon });
    }
  }

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