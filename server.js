const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// --- CONSTANTS ---
const GAME_WIDTH = 2000;
const GAME_HEIGHT = 2000;
const PLAYER_RADIUS = 20;

// --- STATE ---
let players = {};
let npcs = [];
let bullets = [];
let walls = [];
let gameTimer = 0;
let gameRunning = false;
let gameInterval;

// --- WALL GENERATION ---
function generateWalls() {
    walls = [];
    const count = 15; // Number of walls to spawn
    
    for (let i = 0; i < count; i++) {
        // Random dimensions (50px to 250px)
        const w = Math.random() * 200 + 50;
        const h = Math.random() * 200 + 50;
        
        // Random position (padded from edge to avoid spawning inside map borders)
        const x = Math.random() * (GAME_WIDTH - w - 200) + 100;
        const y = Math.random() * (GAME_HEIGHT - h - 200) + 100;
        
        walls.push({ x, y, w, h });
    }
}

// Generate walls immediately on server start
generateWalls();

// --- COLLISION LOGIC ---
// Returns true if the point (x, y) with PLAYER_RADIUS hits a wall
function checkWallCollision(x, y) {
    for (let wall of walls) {
        // AABB Collision (Axis-Aligned Bounding Box)
        // We expand the wall box by the player radius to act as a buffer
        if (x + PLAYER_RADIUS > wall.x && 
            x - PLAYER_RADIUS < wall.x + wall.w &&
            y + PLAYER_RADIUS > wall.y && 
            y - PLAYER_RADIUS < wall.y + wall.h) {
            return true;
        }
    }
    return false;
}

// Helper to get a safe spawn point
function getSafeSpawn() {
    let x, y;
    let attempts = 0;
    do {
        x = Math.random() * (GAME_WIDTH - 100) + 50;
        y = Math.random() * (GAME_HEIGHT - 100) + 50;
        attempts++;
    } while (checkWallCollision(x, y) && attempts < 100);
    return { x, y };
}

function spawnNPCs(count) {
    npcs = [];
    for (let i = 0; i < count; i++) {
        const spawn = getSafeSpawn();
        
        npcs.push({
            id: `npc-${i}`,
            x: spawn.x,
            y: spawn.y,
            tx: spawn.x, // Target X (where it wants to go)
            ty: spawn.y, // Target Y
            dead: false,
            color: getRandomColor(),
            role: "hider",
            idleTime: Math.random() * 5,
            mark: 0
        });
    }
}

function getRandomColor() {
    const colors = ["#ff0055", "#00ffcc", "#ffff00", "#00ccff", "#ff9900", "#cc00ff"];
    return colors[Math.floor(Math.random() * colors.length)];
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // 1. Send Init Data (Includes Walls)
    socket.emit('init', { id: socket.id, walls: walls });

    // 2. Spawn Player Safely
    const spawn = getSafeSpawn();

    players[socket.id] = {
        x: spawn.x,
        y: spawn.y,
        dead: false,
        color: "#fff", // White until game starts
        role: "hider",
        name: "Agent " + Math.floor(Math.random() * 1000),
        host: Object.keys(players).length === 0, // First player is host
        ammo: 0,
        stamina: 100,
        lastSprint: 0
    };

    // 3. Handle Input
    socket.on('input', (data) => {
        const p = players[socket.id];
        if (!p || p.dead) return;

        // --- Movement ---
        if (gameRunning && (data.dx !== 0 || data.dy !== 0)) {
            let speed = 170; // Base speed
            if (p.role === "hunter") speed *= 1.1; // Hunter is slightly faster
            
            // Sprint Logic
            if (data.sprint && p.stamina > 0) {
                speed = 300;
                p.stamina = Math.max(0, p.stamina - 2); 
                p.lastSprint = Date.now();
            }

            // Normalization
            const len = Math.hypot(data.dx, data.dy);
            const moveX = (data.dx / len) * speed * (1 / 30);
            const moveY = (data.dy / len) * speed * (1 / 30);

            // X-Axis Move & Check
            if (!checkWallCollision(p.x + moveX, p.y)) {
                p.x += moveX;
            }
            // Y-Axis Move & Check
            if (!checkWallCollision(p.x, p.y + moveY)) {
                p.y += moveY;
            }

            // Boundary Checks
            p.x = Math.max(20, Math.min(GAME_WIDTH - 20, p.x));
            p.y = Math.max(20, Math.min(GAME_HEIGHT - 20, p.y));
        } else {
            // Stamina Regen
            if (Date.now() - p.lastSprint > 1000 && p.stamina < 100) {
                p.stamina = Math.min(100, p.stamina + 1);
            }
        }

        // --- Shooting (Slot 1) ---
        if (data.shoot && p.role === "hunter" && p.ammo > 0 && data.slot === 1) {
            p.ammo--;
            const angle = Math.atan2(data.aimY - p.y, data.aimX - p.x);
            bullets.push({ 
                x: p.x, 
                y: p.y, 
                vx: Math.cos(angle) * 1000, 
                vy: Math.sin(angle) * 1000, 
                owner: socket.id 
            });
            // Send shake effect
            io.emit("events", [{ type: "shake", amount: 5 }]);
        }

        // --- Marking (Slot 2) ---
        if (data.shoot && p.role === "hunter" && data.slot === 2) {
            // Check NPCs
            npcs.forEach(npc => {
                if (!npc.dead && Math.hypot(npc.x - data.aimX, npc.y - data.aimY) < 30) {
                    npc.mark = (npc.mark + 1) % 4;
                }
            });
            // Check Players
            for(let pid in players) {
                const target = players[pid];
                if (pid !== socket.id && !target.dead && Math.hypot(target.x - data.aimX, target.y - data.aimY) < 30) {
                    target.mark = (target.mark || 0) + 1;
                    if(target.mark > 3) target.mark = 0;
                }
            }
        }
    });

    // 4. Start Game Handler
    socket.on('startGame', () => {
        if (players[socket.id] && players[socket.id].host && !gameRunning) {
            startGame();
        }
    });

    // 5. Disconnect Handler
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        
        // If no players left, stop game
        if (Object.keys(players).length === 0) {
            stopGame();
        } 
        // If host left, assign new host
        else if (!Object.values(players).some(p => p.host)) {
             const nextId = Object.keys(players)[0];
             if(nextId) players[nextId].host = true;
        }
    });
});

// --- GAME LOGIC ---

function startGame() {
    gameRunning = true;
    gameTimer = 180; // 3 Minutes
    
    // Regenerate walls for a fresh map layout
    generateWalls();
    
    // Assign Roles
    const ids = Object.keys(players);
    const hunterId = ids[Math.floor(Math.random() * ids.length)];
    
    for (let id in players) {
        players[id].role = (id === hunterId) ? "hunter" : "hider";
        players[id].dead = false;
        players[id].color = getRandomColor();
        players[id].ammo = (id === hunterId) ? 6 : 0; // Hunter gets 6 shots
        players[id].stamina = 100;
        players[id].mark = 0;

        // Respawn everyone at safe locations
        const s = getSafeSpawn();
        players[id].x = s.x;
        players[id].y = s.y;
    }
    
    spawnNPCs(40);
    
    // Resend walls (since we regenerated them) and start signal
    io.emit("init", { walls: walls }); 
    io.emit("gameStart");
    
    // Start Loop
    clearInterval(gameInterval);
    gameInterval = setInterval(gameLoop, 1000 / 30);
}

function stopGame() {
    gameRunning = false;
    clearInterval(gameInterval);
}

function gameLoop() {
    const events = [];

    // 1. Timer Logic
    if (gameTimer > 0) {
        gameTimer -= 1/30;
        if (gameTimer <= 0) endGame(false, "TIME EXPIRED");
    }

    // 2. Check Win Condition (All hiders dead)
    if (gameRunning) {
        const hiders = Object.values(players).filter(p => p.role === "hider" && !p.dead);
        if (hiders.length === 0) endGame(true, "ALL TARGETS ELIMINATED");
    }

    // 3. NPC Logic (AI)
    npcs.forEach(npc => {
        if (npc.dead) return;
        
        const dx = npc.tx - npc.x;
        const dy = npc.ty - npc.y;
        const dist = Math.hypot(dx, dy);
        
        // If arrived at target or waiting
        if (dist < 5 || npc.idleTime > 0) {
            if (npc.idleTime > 0) {
                npc.idleTime -= 1/30;
            } else {
                // Pick new target
                if (Math.random() < 0.02) { // Small chance per frame to move
                    const dest = getSafeSpawn(); // Ensures target isn't inside a wall
                    npc.tx = dest.x;
                    npc.ty = dest.y;
                } else {
                    npc.idleTime = Math.random() * 2 + 1; // Wait 1-3 seconds
                }
            }
        } else {
            // Move towards target
            const speed = 170 * (1/30);
            const moveX = (dx / dist) * speed;
            const moveY = (dy / dist) * speed;
            
            // Wall Slide Logic for NPCs
            if (!checkWallCollision(npc.x + moveX, npc.y)) npc.x += moveX;
            if (!checkWallCollision(npc.x, npc.y + moveY)) npc.y += moveY;
        }
    });

    // 4. Bullet Logic
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += b.vx * (1/30);
        b.y += b.vy * (1/30);

        let hit = false;

        // Check Wall Collision
        if (b.x < 0 || b.x > GAME_WIDTH || b.y < 0 || b.y > GAME_HEIGHT || checkWallCollision(b.x, b.y)) {
            hit = true;
        }

        // Check Player Collision
        if (!hit) {
            for (let pid in players) {
                const p = players[pid];
                if (!p.dead && pid !== b.owner && Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_RADIUS) {
                    p.dead = true;
                    hit = true;
                    events.push({ type: "kill", x: p.x, y: p.y, color: p.color });
                    
                    if (p.role === "hunter") endGame(false, "HUNTER DIED"); // Friendly fire or ricochet (unlikely but safe)
                }
            }
        }

        // Check NPC Collision
        if (!hit) {
            for (let n of npcs) {
                if (!n.dead && Math.hypot(n.x - b.x, n.y - b.y) < PLAYER_RADIUS) {
                    n.dead = true;
                    hit = true;
                    events.push({ type: "kill", x: n.x, y: n.y, color: n.color });
                    
                    // Penalty for Hunter killing wrong target? (Optional)
                    // events.push({ type: "msg", text: "WRONG TARGET" });
                }
            }
        }

        if (hit) bullets.splice(i, 1);
    }

    // 5. Send Update to Clients
    io.emit("tick", {
        players: players,
        npcs: npcs,
        bullets: bullets,
        timer: gameTimer,
        events: events
    });
}

function endGame(hunterWon, reason) {
    stopGame();
    io.emit("gameOver", { hunterWon, reason });
}

server.listen(3000, () => {
    console.log('Server running on *:3000');
});