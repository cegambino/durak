const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const DurakEngine = require('./public/durak-engine.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

app.use(express.static(path.join(__dirname, 'public')));

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** @type {Map<string, any>} */
const rooms = new Map();

const TURN_MS = 15000;

function scheduleRoomTurn(room) {
  if (room.turnHandle) clearTimeout(room.turnHandle);
  room.turnHandle = null;
  room.turnEndsAt = null;
  if (!room.state || room.state.winnerIndex !== null) return;
  room.turnEndsAt = Date.now() + TURN_MS;
  room.turnHandle = setTimeout(() => {
    room.turnHandle = null;
    if (!room.state || room.state.winnerIndex !== null) return;
    const ap = DurakEngine.activePlayerIndex(room.state);
    if (ap == null) return;
    const r = DurakEngine.applyTurnTimeout(room.state, ap);
    if (r.ok) sendState(room);
  }, TURN_MS);
}

function sendState(room) {
  scheduleRoomTurn(room);
  for (let i = 0; i < 2; i++) {
    const sid = room.sockets[i];
    if (!sid) continue;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    sock.emit('state', {
      code: room.code,
      names: room.names,
      started: room.started,
      mySlot: i,
      turnEndsAt: room.turnEndsAt,
      snapshot: room.state ? DurakEngine.publicSnapshot(room.state, i) : null,
    });
  }
}

function attachSocketToRoom(socket, room, name, slot) {
  room.sockets[slot] = socket.id;
  room.names[slot] = name || `Spieler ${slot + 1}`;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.slot = slot;
}

io.on('connection', (socket) => {
  socket.on('createRoom', (name, cb) => {
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();
    const room = {
      code,
      sockets: [null, null],
      names: ['', ''],
      started: false,
      state: null,
    };
    rooms.set(code, room);
    attachSocketToRoom(socket, room, name, 0);
    if (typeof cb === 'function') cb({ ok: true, code, slot: 0, names: room.names.slice() });
    sendState(room);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, err: 'Raum nicht gefunden' });
      return;
    }
    let slot = room.sockets.indexOf(null);
    if (slot < 0) {
      if (typeof cb === 'function') cb({ ok: false, err: 'Raum voll' });
      return;
    }
    if (room.sockets.includes(socket.id)) {
      slot = room.sockets.indexOf(socket.id);
    } else {
      attachSocketToRoom(socket, room, name, slot);
    }
    if (typeof cb === 'function') cb({ ok: true, code: room.code, slot, names: room.names.slice() });
    sendState(room);
  });

  socket.on('startGame', (cb) => {
    const code = socket.data.roomCode;
    const room = code ? rooms.get(code) : null;
    if (!room || room.sockets[0] == null || room.sockets[1] == null) {
      if (typeof cb === 'function') cb({ ok: false, err: 'Zwei Spieler nötig' });
      return;
    }
    if (socket.data.slot !== 0) {
      if (typeof cb === 'function') cb({ ok: false, err: 'Nur Gastgeber startet' });
      return;
    }
    room.state = DurakEngine.newGame();
    room.started = true;
    if (typeof cb === 'function') cb({ ok: true });
    sendState(room);
  });

  function act(fn) {
    const code = socket.data.roomCode;
    const room = code ? rooms.get(code) : null;
    const slot = socket.data.slot;
    if (!room || !room.started || !room.state || slot == null) return { ok: false, err: 'Kein Spiel' };
    const r = fn(room.state, slot);
    if (r.ok) sendState(room);
    return r;
  }

  socket.on('attack', (cardIds, cb) => {
    const r = act((state, slot) => DurakEngine.attack(state, cardIds, slot));
    if (typeof cb === 'function') cb(r);
  });

  socket.on('defend', (cardIds, cb) => {
    const r = act((state, slot) => DurakEngine.defend(state, cardIds, slot));
    if (typeof cb === 'function') cb(r);
  });

  socket.on('pass', (cb) => {
    const r = act((state, slot) => DurakEngine.attackerPass(state, slot));
    if (typeof cb === 'function') cb(r);
  });

  socket.on('take', (cb) => {
    const r = act((state, slot) => DurakEngine.defenderTake(state, slot));
    if (typeof cb === 'function') cb(r);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const idx = room.sockets.indexOf(socket.id);
    if (idx >= 0) room.sockets[idx] = null;
    const empty = room.sockets.every((s) => s == null);
    if (empty) {
      if (room.turnHandle) clearTimeout(room.turnHandle);
      rooms.delete(code);
    } else sendState(room);
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`Durak: http://localhost:${PORT}`);
});
