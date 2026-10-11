import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomInt } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: true },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5,
})
const PORT = Number(process.env.PORT || 3001)
const rooms = new Map()
const DEFAULT_ROOM = 'PUBLIC-01'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const suits = ['♠', '♥', '♦', '♣']
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
const value = rank => rank === 'A' ? 1 : ['10', 'J', 'Q', 'K'].includes(rank) ? 0 : Number(rank)
const score = hand => hand.reduce((total, card) => total + value(card.rank), 0) % 10

// Punto Banco rules are evaluated only on the server.
function dealRound() {
  const deck = suits.flatMap(suit => ranks.map(rank => ({ suit, rank, id: `${suit}${rank}` })))
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  let cursor = 0
  const player = [deck[cursor++], deck[cursor++]]
  const banker = [deck[cursor++], deck[cursor++]]
  let playerScore = score(player)
  let bankerScore = score(banker)
  let playerThird
  const bankerShouldDraw = (bankerTotal, third) => {
    if (!third) return bankerTotal <= 5
    const thirdValue = value(third.rank)
    if (bankerTotal <= 2) return true
    if (bankerTotal === 3) return thirdValue !== 8
    if (bankerTotal === 4) return thirdValue >= 2 && thirdValue <= 7
    if (bankerTotal === 5) return thirdValue >= 4 && thirdValue <= 7
    if (bankerTotal === 6) return thirdValue === 6 || thirdValue === 7
    return false
  }
  if (playerScore < 8 && bankerScore < 8) {
    if (playerScore <= 5) {
      playerThird = deck[cursor++]
      player.push(playerThird)
      playerScore = score(player)
    }
    if (bankerShouldDraw(bankerScore, playerThird)) {
      banker.push(deck[cursor++])
      bankerScore = score(banker)
    }
  }
  return { player, banker, playerScore, bankerScore, winner: playerScore > bankerScore ? 'PLAYER' : bankerScore > playerScore ? 'BANKER' : 'TIE' }
}

function validRoomId(input) {
  return typeof input === 'string' && /^[A-Z0-9-]{3,16}$/.test(input.trim().toUpperCase())
}
function publicState(room) {
  return {
    roomId: room.id,
    roundNumber: room.roundNumber,
    phase: room.phase,
    seconds: room.seconds,
    round: room.round,
    revealCount: room.revealCount,
    players: io.sockets.adapter.rooms.get(room.id)?.size || 0,
    history: room.history.slice(0, 20),
  }
}
function broadcast(room) { io.to(room.id).emit('room:state', publicState(room)) }
function makeRoom(id) {
  const room = { id, roundNumber: 0, phase: 'waiting', seconds: 0, round: null, revealCount: 0, history: [], loopStarted: false, startRequested: false }
  rooms.set(id, room)
  void gameLoop(room)
  return room
}
function getRoom(id) { return rooms.get(id) || (id === DEFAULT_ROOM ? makeRoom(id) : null) }
async function gameLoop(room) {
  if (room.loopStarted) return
  room.loopStarted = true
  while (rooms.has(room.id)) {
    room.phase = 'countdown'; room.seconds = 10; room.round = null; room.revealCount = 0; room.startRequested = false; broadcast(room)
    for (let second = 10; second > 0; second--) {
      if (!rooms.has(room.id)) return
      room.seconds = second; broadcast(room); await wait(1000)
      if (room.startRequested) break
    }
    room.startRequested = false
    room.phase = 'shuffling'; room.seconds = 1; room.round = null; room.revealCount = 0; broadcast(room)
    await wait(1200)
    room.roundNumber += 1
    room.round = dealRound()
    room.phase = 'dealing'; room.seconds = 0; room.revealCount = 0; broadcast(room)
    // The server reveals in baccarat dealing order: P1, B1, P2, B2, then any third cards.
    const revealOrder = [ ['player', 0], ['banker', 0], ['player', 1], ['banker', 1], ['player', 2], ['banker', 2] ]
    for (let i = 0; i < revealOrder.length; i++) {
      const [side, index] = revealOrder[i]
      if (room.round[side]?.[index]) {
        room.phase = i < 4 ? 'dealing' : 'revealing'
        room.revealCount = i + 1
        broadcast(room)
        await wait(720)
      }
    }
    room.phase = 'result'; room.revealCount = 6; room.seconds = 6
    room.history.unshift({ roundNumber: room.roundNumber, winner: room.round.winner, playerScore: room.round.playerScore, bankerScore: room.round.bankerScore })
    room.history = room.history.slice(0, 20)
    broadcast(room)
    for (let second = 6; second > 0; second--) { room.seconds = second; broadcast(room); await wait(1000) }
  }
}

function leaveCurrentRoom(socket) {
  const previous = socket.data.roomId
  if (previous) {
    socket.leave(previous)
    const room = rooms.get(previous)
    if (room) broadcast(room)
  }
  socket.data.roomId = null
}
function joinRoom(socket, room) {
  leaveCurrentRoom(socket)
  socket.join(room.id)
  socket.data.roomId = room.id
  socket.emit('room:state', publicState(room))
  broadcast(room)
}

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, players: io.engine.clientsCount }))
app.use(express.static(path.join(__dirname, 'dist')))
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')))

io.on('connection', socket => {
  socket.on('room:join', payload => {
    const rawId = payload && typeof payload.roomId === 'string' ? payload.roomId.trim().toUpperCase() : DEFAULT_ROOM
    if (!validRoomId(rawId)) { socket.emit('room:error', 'รหัสห้องใช้ได้เฉพาะ A-Z, 0-9 และ - (3–16 ตัว)'); return }
    const room = getRoom(rawId)
    if (!room) { socket.emit('room:error', 'ไม่พบห้องนี้ กรุณาสร้างห้องก่อน'); return }
    joinRoom(socket, room)
  })
  socket.on('room:start', () => {
    const room = rooms.get(socket.data.roomId)
    if (room && room.phase === 'countdown' && !room.startRequested) { room.startRequested = true; room.seconds = 1; broadcast(room) }
  })
  socket.on('room:create', () => {
    let id
    do { id = `VR-${randomBytes(3).toString('hex').toUpperCase()}` } while (rooms.has(id))
    const room = makeRoom(id)
    joinRoom(socket, room)
  })
  socket.on('room:leave', () => joinRoom(socket, getRoom(DEFAULT_ROOM)))
  socket.on('disconnect', () => {
    const id = socket.data.roomId
    if (id && rooms.has(id)) broadcast(rooms.get(id))
  })
})

getRoom(DEFAULT_ROOM)
httpServer.listen(PORT, '0.0.0.0', () => console.log(`Velvet Royale Socket.IO server listening on ${PORT}`))
