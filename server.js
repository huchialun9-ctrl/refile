import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev')
const PORT = isDev ? 3001 : parseInt(process.env.PORT || '5000')

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// Serve built frontend in production
if (!isDev) {
  app.use(express.static(join(__dirname, 'dist')))
  app.get('/{*rest}', (_, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
}

// Peer registry: peerId -> { ws, name }
const peers = new Map()
const PING_INTERVAL = 30000

function genId() {
  let id = randomBytes(4).toString('hex').toUpperCase()
  while (peers.has(id)) id = randomBytes(4).toString('hex').toUpperCase()
  return id
}

function broadcastPeerList() {
  const list = []
  peers.forEach((entry, id) => {
    list.push({ id, name: entry.name || '' })
  })
  const msg = JSON.stringify({ type: 'peer-list', peers: list })
  peers.forEach((entry) => {
    if (entry.ws.readyState === WebSocket.OPEN) {
      try { entry.ws.send(msg) } catch {}
    }
  })
}

wss.on('connection', (ws) => {
  const peerId = genId()
  const entry = { ws, name: '' }
  peers.set(peerId, entry)
  ws.isAlive = true

  ws.send(JSON.stringify({ type: 'welcome', peerId }))
  broadcastPeerList()

  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.type === 'pong') {
        ws.isAlive = true
        return
      }

      if (msg.type === 'peer-info' && typeof msg.name === 'string') {
        entry.name = msg.name.slice(0, 32)
        broadcastPeerList()
        return
      }

      // Route WebRTC signaling to target peer
      if (msg.type === 'signal' && typeof msg.to === 'string') {
        const target = peers.get(msg.to)
        if (target && target.ws.readyState === WebSocket.OPEN) {
          try {
            target.ws.send(JSON.stringify({ type: 'signal', from: peerId, data: msg.data }))
          } catch (e) {
            peers.delete(msg.to)
            broadcastPeerList()
          }
        } else if (target) {
          peers.delete(msg.to)
          broadcastPeerList()
        }
      }
    } catch {}
  })

  ws.on('close', () => {
    peers.delete(peerId)
    broadcastPeerList()
  })
  ws.on('error', () => {
    peers.delete(peerId)
    broadcastPeerList()
  })
})

// Heartbeat ping interval - clean up stale connections
const pingTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      peers.forEach((v, k) => { if (v.ws === ws) { peers.delete(k); broadcastPeerList() } })
      return ws.terminate()
    }
    ws.isAlive = false
    ws.ping()
  })
}, PING_INTERVAL)

wss.on('close', () => clearInterval(pingTimer))

server.listen(PORT, '0.0.0.0', () => {
  console.log(`re/file signaling server on port ${PORT} (${isDev ? 'dev' : 'production'})`)
})
