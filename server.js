const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// --- SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- CONSTANTS ---
const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;
const CONFIG = {
    decoysPerPlayer: 8,
    hiderSpeed: 160,
    npcSpeed: 160,
    hunterSpeed: 210,
    bulletSpeed: 1500,
    fireRate: 0.7,
    idleLimit: 8.0,
    colors: {
        hunter: "#ff0055",
        hiders: ["#00ffff", "#ffdd00", "#9900ff", "#00ff66", "#ff00aa", "#0099ff"]
    }
};

// --- STATE MANAGEMENT ---
const rooms = {};

function createRoom(roomId) {
    return {
        id: roomId,
        status: "LOBBY",
        players: [],
        npcs: [],
        bullets: [],
        timer: 0,
        ammo: 0,
        countdown: 0,
        shake: 0,
        events: [],
        lastTick: Date.now()
    };
}

// --- UTILS ---
function generateCode() {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let r = "";
    for (let i = 0; i < 4; i++) r += c.charAt(Math.floor(Math.random() * c.length));
    return r;
}

function roundEntities(entities) {
    return entities.map(e => ({ ...e, x: Math.round(e.x), y: Math.round(e.y) }));
}

// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
    console.log(`[NET] User connected: ${socket.id}`);

    // Create Room
    socket.on('create_room', (data) => {
        const code = generateCode();
        rooms[code] = createRoom(code);
        
        socket.join(code);
        
        // Add Host
        rooms[code].players.push({
            id: socket.id,
            name: data.name || "COMMANDER",
            role: 'spectator',
            host: true,
            x: GAME_WIDTH / 2,
            y: GAME_HEIGHT / 2,
            dead: false,
            idleTime: 0
        });

        socket.emit('room_created', { code: code, playerId: socket.id });
        io.to(code).emit('lobby_update', rooms[code].players);
    });

    // Join Room
    socket.on('join_room', (data) => {
        const code = data.code;
        if (rooms[code] && rooms[code].status === 'LOBBY') {
            socket.join(code);
            rooms[code].players.push({
                id: socket.id,
                name: data.name || "AGENT",
                role: 'spectator',
                host: false,
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                dead: false,
                idleTime: 0
            });
            socket.emit('room_joined', { code: code, playerId: socket.id });
            io.to(code).emit('lobby_update', rooms[code].players);
        } else {
            socket.emit('error_msg', "INVALID CODE OR GAME STARTED");
        }
    });

    // Start Game
    socket.on('start_game', (data) => {
        const code = data.code;
        const room = rooms[code];
        
        if (room && room.players[0].id === socket.id && room.status === "LOBBY") {
            // Init Game State
            const hunterIndex = Math.floor(Math.random() * room.players.length);
            let colorIdx = 0;
            const activeColors = [];

            room.players.forEach((p, i) => {
                p.dead = false;
                p.idleTime = 0;
                p.lastShot = 0;
                p.x = Math.round(Math.random() * (GAME_WIDTH - 200) + 100);
                p.y = Math.round(Math.random() * (GAME_HEIGHT - 200) + 100);
                
                if (i === hunterIndex) {
                    p.role = "hunter";
                    p.color = CONFIG.colors.hunter;
                } else {
                    p.role = "hider";
                    p.color = CONFIG.colors.hiders[colorIdx % CONFIG.colors.hiders.length];
                    if (!activeColors.includes(p.color)) activeColors.push(p.color);
                    colorIdx++;
                }
            });

            // NPCs
            const totalNpcs = room.players.length * CONFIG.decoysPerPlayer;
            room.npcs = [];
            for (let i = 0; i < totalNpcs; i++) {
                const c = activeColors.length > 0 
                    ? activeColors[Math.floor(Math.random() * activeColors.length)] 
                    : CONFIG.colors.hiders[0];
                room.npcs.push({
                    x: Math.random() * GAME_WIDTH,
                    y: Math.random() * GAME_HEIGHT,
                    tx: Math.random() * GAME_WIDTH,
                    ty: Math.random() * GAME_HEIGHT,
                    wait: 0,
                    color: c,
                    dead: false
                });
            }

            const hiderCount = room.players.length - 1;
            room.timer = 180 + Math.max(0, hiderCount - 1) * 60;
            room.ammo = 3 + (hiderCount * 2);
            room.countdown = 3;
            room.status = "PLAYING";

            io.to(code).emit('game_started', {
                players: room.players,
                npcs: room.npcs,
                timer: room.timer,
                ammo: room.ammo
            });
        }
    });

    // Player Input
    socket.on('client_input', (data) => {
        const code = data.code;
        const room = rooms[code];
        if (!room || room.status !== 'PLAYING') return;

        const p = room.players.find(pl => pl.id === socket.id);
        if (p && !p.dead) {
            // Apply movement immediately (Server Authoritative-ish)
            p.x = data.input.x;
            p.y = data.input.y;
            p.aimX = data.input.aimX;
            p.aimY = data.input.aimY;

            // Handle Shooting
            if (data.input.shoot && p.role === 'hunter' && room.ammo > 0) {
                const now = Date.now() / 1000;
                if (!p.lastShot || now - p.lastShot > CONFIG.fireRate) {
                    p.lastShot = now;
                    room.shake = 5;
                    room.lastShotTime = now;
                    const angle = Math.atan2(p.aimY - p.y, p.aimX - p.x);
                    room.bullets.push({
                        x: p.x, y: p.y,
                        vx: Math.cos(angle) * CONFIG.bulletSpeed,
                        vy: Math.sin(angle) * CONFIG.bulletSpeed,
                        life: 1.5
                    });
                }
            }
        }
    });

    // Return to Lobby
    socket.on('return_lobby', (data) => {
        const code = data.code;
        const room = rooms[code];
        if (room && room.players[0].id === socket.id) {
            room.status = "LOBBY";
            room.players.forEach(p => p.role = 'spectator');
            io.to(code).emit('lobby_update', room.players);
            io.to(code).emit('reset_to_lobby');
        }
    });

    socket.on('disconnect', () => {
        // Find room user was in
        for (const code in rooms) {
            const room = rooms[code];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                io.to(code).emit('lobby_update', room.players);
                
                // If host leaves, close room or reassign? 
                // For simplicity: if empty, delete room
                if (room.players.length === 0) {
                    delete rooms[code];
                }
                break;
            }
        }
    });
});

// --- SERVER GAME LOOP (60Hz) ---
setInterval(() => {
    const dt = 0.016;

    for (const code in rooms) {
        const room = rooms[code];
        if (room.status !== 'PLAYING') continue;

        // Countdown
        if (room.countdown > 0) {
            room.countdown -= dt;
            if (room.countdown < 0) room.countdown = 0;
        } else {
            room.timer -= dt;
        }

        // Bullets
        room.bullets.forEach(b => {
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.life -= dt;

            if (b.life > 0) {
                // Check Collision Players
                room.players.forEach(p => {
                    if (p.role === 'hider' && !p.dead && Math.hypot(p.x - b.x, p.y - b.y) < 25) {
                        p.dead = true;
                        b.life = 0;
                        room.ammo--;
                        room.shake = 30;
                        room.events.push({ type: 'kill', x: p.x, y: p.y, color: p.color });
                        room.events.push({ type: 'msg', text: 'TARGET ELIMINATED' });
                    }
                });
                
                // Check Collision NPCs
                if (b.life > 0) {
                    room.npcs.forEach(n => {
                        if (!n.dead && Math.hypot(n.x - b.x, n.y - b.y) < 25) {
                            n.dead = true;
                            b.life = 0;
                            room.ammo--;
                            room.shake = 15;
                            room.events.push({ type: 'kill', x: n.x, y: n.y, color: n.color });
                            room.events.push({ type: 'msg', text: 'CIVILIAN CASUALTY' });
                        }
                    });
                }
            }
        });
        room.bullets = room.bullets.filter(b => b.life > 0);

        // NPCs
        room.npcs.forEach(n => {
            if (n.dead) return;
            if (n.wait > 0) n.wait -= dt;
            else {
                const dx = n.tx - n.x;
                const dy = n.ty - n.y;
                const dist = Math.hypot(dx, dy);
                if (dist < 5) {
                    n.wait = Math.random() * 3 + 1;
                    n.tx = Math.random() * GAME_WIDTH;
                    n.ty = Math.random() * GAME_HEIGHT;
                } else {
                    n.x += (dx / dist) * CONFIG.npcSpeed * dt;
                    n.y += (dy / dist) * CONFIG.npcSpeed * dt;
                }
            }
        });

        // Hider Idle Check
        room.players.forEach(p => {
            if(p.role === 'hider' && !p.dead) {
                 // In this server version, we assume client updates idleTime locally 
                 // OR we calculate distance from last pos. 
                 // For simplicity, we skip server-side idle check here or add dist logic later.
                 // We will rely on visual indicators for now.
            }
        });

        // Game Over Logic
        const livingHiders = room.players.filter(p => p.role === 'hider' && !p.dead);
        let gameOver = false;
        let hunterWon = false;
        let reason = "";

        if (livingHiders.length === 0) {
            gameOver = true; hunterWon = true; reason = "ALL TARGETS ELIMINATED";
        } else if (room.timer <= 0) {
            gameOver = true; hunterWon = false; reason = "TIME EXPIRED";
        } else if (room.ammo <= 0 && room.bullets.length === 0) {
            gameOver = true; hunterWon = false; reason = "MISSION FAILED - AMMO";
        }

        if (gameOver) {
            room.status = "ENDED";
            io.to(code).emit('game_over', { hunterWon, reason });
        } else {
            // Tick Emit (15Hz throttle logic or just 30Hz)
            if (Date.now() - room.lastTick > 40) { // ~25fps updates
                 room.lastTick = Date.now();
                 io.to(code).emit('tick', {
                     players: roundEntities(room.players),
                     npcs: roundEntities(room.npcs),
                     bullets: roundEntities(room.bullets),
                     timer: Math.round(room.timer),
                     ammo: room.ammo,
                     countdown: room.countdown,
                     shake: Math.round(room.shake),
                     events: room.events
                 });
                 room.events = []; // Clear events after send
                 room.shake *= 0.9;
            }
        }
    }
}, 16);

const PORT = process.env.PORT || 3000;

// CHANGE: Added '0.0.0.0' as the second argument
server.listen(PORT, '0.0.0.0', () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
