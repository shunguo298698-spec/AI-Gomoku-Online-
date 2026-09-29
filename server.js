const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const BOARD_SIZE = 15;
const ROOM_TTL = 30 * 60 * 1000;

const wss = new WebSocket.Server({ port: PORT });
const rooms = new Map();

function createRoom(hostWs) {
  const roomId = genRoomId();
  const room = {
    id: roomId,
    players: [{ ws: hostWs, id: randomUUID(), color: 'black', online: true }],
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0)),
    turn: 'black',
    started: false,
    gameOver: false,
    moveHistory: [],
    createdAt: Date.now(),
    lastActive: Date.now()
  };
  rooms.set(roomId, room);
  return room;
}

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(id));
  return id;
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastAll(room, payload) {
  room.players.forEach(p => {
    if (p.online) send(p.ws, payload);
  });
}

function getRoom(ws) {
  if (!ws.roomId) return null;
  return rooms.get(ws.roomId) || null;
}

function getOpponent(room, ws) {
  return room.players.find(p => p.ws !== ws);
}

function checkWin(board, row, col, player) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let i = 1; i < 5; i++) {
      const r = row + dr * i, c = col + dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) break;
      if (board[r][c] !== player) break;
      count++;
    }
    for (let i = 1; i < 5; i++) {
      const r = row - dr * i, c = col - dc * i;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) break;
      if (board[r][c] !== player) break;
      count++;
    }
    if (count >= 5) return true;
  }
  return false;
}

function isBoardFull(board) {
  return board.every(row => row.every(cell => cell !== 0));
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerId = null;
  ws.color = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const room = getRoom(ws);
    if (room) room.lastActive = Date.now();

    switch (msg.type) {

      case 'create': {
        const room = createRoom(ws);
        ws.roomId = room.id;
        ws.playerId = room.players[0].id;
        ws.color = 'black';
        send(ws, {
          type: 'created',
          roomId: room.id,
          color: 'black',
          playerId: room.players[0].id
        });
        console.log(`[房间] 创建 ${room.id}`);
        break;
      }

      case 'join': {
        const targetRoom = rooms.get(msg.roomId);
        if (!targetRoom) {
          return send(ws, { type: 'error', msg: '房间不存在' });
        }
        if (targetRoom.players.length >= 2) {
          const slot = targetRoom.players.find(p => !p.online);
          if (!slot) {
            return send(ws, { type: 'error', msg: '房间已满' });
          }
          slot.ws = ws;
          slot.online = true;
          ws.roomId = targetRoom.id;
          ws.playerId = slot.id;
          ws.color = slot.color;
          send(ws, {
            type: 'start',
            color: slot.color,
            turn: targetRoom.turn,
            board: targetRoom.board,
            moveHistory: targetRoom.moveHistory,
            reconnected: true
          });
          broadcastAll(targetRoom, {
            type: 'opponent-reconnected',
            color: slot.color
          });
          return;
        }

        const player = {
          ws,
          id: randomUUID(),
          color: 'white',
          online: true
        };
        targetRoom.players.push(player);
        targetRoom.started = true;
        ws.roomId = targetRoom.id;
        ws.playerId = player.id;
        ws.color = 'white';

        targetRoom.players.forEach(p => {
          send(p.ws, {
            type: 'start',
            color: p.color,
            turn: targetRoom.turn,
            board: targetRoom.board,
            moveHistory: targetRoom.moveHistory
          });
        });
        console.log(`[房间] ${targetRoom.id} 双方就绪`);
        break;
      }

      case 'move': {
        if (!room || !room.started || room.gameOver) return;
        if (ws.color !== room.turn) {
          return send(ws, { type: 'error', msg: '还没轮到你' });
        }

        const { row, col } = msg;
        if (
          !Number.isInteger(row) || !Number.isInteger(col) ||
          row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE
        ) {
          return send(ws, { type: 'error', msg: '坐标越界' });
        }
        if (room.board[row][col] !== 0) {
          return send(ws, { type: 'error', msg: '该位置已有棋子' });
        }

        const playerNum = ws.color === 'black' ? 1 : 2;
        room.board[row][col] = playerNum;
        room.moveHistory.push({ row, col, color: ws.color });

        const won = checkWin(room.board, row, col, playerNum);
        const full = !won && isBoardFull(room.board);

        room.turn = ws.color === 'black' ? 'white' : 'black';

        broadcastAll(room, {
          type: 'move',
          row,
          col,
          color: ws.color,
          nextTurn: room.turn,
          moveCount: room.moveHistory.length
        });

        if (won) {
          room.gameOver = true;
          broadcastAll(room, {
            type: 'game-over',
            winner: ws.color,
            reason: 'five-in-a-row'
          });
        } else if (full) {
          room.gameOver = true;
          broadcastAll(room, {
            type: 'game-over',
            winner: null,
            reason: 'draw'
          });
        }
        break;
      }

      case 'undo-request': {
        if (!room || !room.started || room.gameOver) return;
        if (room.moveHistory.length === 0) return;
        const opponent = getOpponent(room, ws);
        if (opponent) {
          send(opponent.ws, {
            type: 'undo-request',
            from: ws.color
          });
        }
        break;
      }

      case 'undo-accept': {
        if (!room || !room.started || room.gameOver) return;
        if (room.moveHistory.length === 0) return;

        let undoCount = 0;
        while (room.moveHistory.length > 0 && undoCount < 2) {
          const last = room.moveHistory.pop();
          room.board[last.row][last.col] = 0;
          undoCount++;
          if (last.color === ws.color) break;
        }

        const lastMove = room.moveHistory[room.moveHistory.length - 1];
        if (lastMove) {
          room.turn = lastMove.color === 'black' ? 'white' : 'black';
        } else {
          room.turn = 'black';
        }
        room.gameOver = false;

        broadcastAll(room, {
          type: 'undo-done',
          board: room.board,
          turn: room.turn,
          moveHistory: room.moveHistory
        });
        break;
      }

      case 'undo-reject': {
        if (!room) return;
        const opponent = getOpponent(room, ws);
        if (opponent) {
          send(opponent.ws, { type: 'undo-rejected' });
        }
        break;
      }

      case 'resign': {
        if (!room || room.gameOver) return;
        room.gameOver = true;
        const winner = ws.color === 'black' ? 'white' : 'black';
        broadcastAll(room, {
          type: 'game-over',
          winner,
          reason: 'resign'
        });
        break;
      }

      case 'rematch-request': {
        if (!room) return;
        const opponent = getOpponent(room, ws);
        if (opponent) {
          send(opponent.ws, { type: 'rematch-request' });
        }
        break;
      }

      case 'rematch-accept': {
        if (!room) return;
        room.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
        room.moveHistory = [];
        room.turn = 'black';
        room.gameOver = false;
        room.started = true;
        room.players.forEach((p, i) => {
          p.color = i === 0 ? 'black' : 'white';
        });
        broadcastAll(room, {
          type: 'start',
          turn: room.turn,
          board: room.board,
          moveHistory: [],
          rematch: true
        });
        room.players.forEach(p => {
          send(p.ws, {
            type: 'your-color',
            color: p.color
          });
        });
        break;
      }

      case 'rematch-reject': {
        if (!room) return;
        const opponent = getOpponent(room, ws);
        if (opponent) send(opponent.ws, { type: 'rematch-rejected' });
        break;
      }

      case 'chat': {
        if (!room) return;
        const text = String(msg.text || '').slice(0, 200);
        if (!text.trim()) return;
        broadcastAll(room, {
          type: 'chat',
          text,
          from: ws.color,
          ts: Date.now()
        });
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    const room = getRoom(ws);
    if (!room) return;
    const player = room.players.find(p => p.ws === ws);
    if (player) {
      player.online = false;
      player.ws = null;
    }
    const opponent = room.players.find(p => p.ws !== ws && p.online);
    if (opponent) {
      send(opponent.ws, {
        type: 'opponent-left',
        color: player ? player.color : null
      });
    }
    if (room.players.every(p => !p.online)) {
      rooms.delete(room.id);
    }
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

const cleanup = setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (now - room.lastActive > ROOM_TTL) {
      room.players.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
          send(p.ws, { type: 'error', msg: '房间超时关闭' });
          try { p.ws.close(); } catch(e) {}
        }
      });
      rooms.delete(id);
    }
  });
}, 5 * 60 * 1000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(cleanup);
});

console.log('==============================================');
console.log('  🎮 五子棋联机服务器已启动');
console.log(`  📡 端口: ${PORT}`);
console.log('==============================================');