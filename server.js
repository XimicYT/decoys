import { WebSocketServer } from "ws";
import http from "http";

const server = http.createServer();
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

/**
 * rooms = {
 *   CODE: {
 *     hostId,
 *     clients: Map(clientId => ws)
 *   }
 * }
 */
const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function broadcast(room, data, exceptId = null) {
  const msg = JSON.stringify(data);
  room.clients.forEach((ws, id) => {
    if (id !== exceptId && ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  });
}

wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.roomCode = null;
  ws.isHost = false;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // CREATE ROOM
    if (data.type === "CREATE") {
      const code = generateCode();
      rooms.set(code, {
        hostId: ws.id,
        clients: new Map([[ws.id, ws]])
      });
      ws.roomCode = code;
      ws.isHost = true;

      ws.send(
        JSON.stringify({
          type: "ROOM_CREATED",
          code,
          id: ws.id
        })
      );
      return;
    }

    // JOIN ROOM
    if (data.type === "JOIN") {
      const room = rooms.get(data.code);
      if (!room) {
        ws.send(JSON.stringify({ type: "ERROR", msg: "ROOM NOT FOUND" }));
        return;
      }
      room.clients.set(ws.id, ws);
      ws.roomCode = data.code;

      ws.send(
        JSON.stringify({
          type: "JOINED",
          id: ws.id
        })
      );

      // Notify host
      const host = room.clients.get(room.hostId);
      if (host) {
        host.send(
          JSON.stringify({
            type: "CLIENT_JOINED",
            id: ws.id,
            name: data.name
          })
        );
      }
      return;
    }

    // RELAY GAME DATA
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (!room) return;

      // Clients → Host
      if (!ws.isHost) {
        const host = room.clients.get(room.hostId);
        if (host) {
          host.send(
            JSON.stringify({
              ...data,
              senderId: ws.id
            })
          );
        }
      } 
      // Host → Clients
      else {
        broadcast(room, data, ws.id);
      }
    }
  });

  ws.on("close", () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    room.clients.delete(ws.id);

    // If host left → kill room
    if (ws.isHost) {
      room.clients.forEach((c) => {
        c.send(JSON.stringify({ type: "ERROR", msg: "HOST LEFT" }));
        c.close();
      });
      rooms.delete(ws.roomCode);
    }
  });
});

server.listen(PORT, () => {
  console.log(`CROWD PROTOCOL server running on :${PORT}`);
});
