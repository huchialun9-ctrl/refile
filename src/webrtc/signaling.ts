type SignalCallback = (from: string, data: unknown) => void
type RawMessageCallback = (raw: string) => void

export function deriveLocalId(): string {
  try {
    const stored = localStorage.getItem('reflie_peer_id')
    if (stored && stored.length === 8) return stored
    // Migrate from old key
    const old = localStorage.getItem('reflie_local_id')
    if (old && old.length === 8) { localStorage.setItem('reflie_peer_id', old); return old }
  } catch {}
  let unique: string
  try { unique = crypto.randomUUID() } catch { unique = Math.random().toString(36).substring(2) + Date.now().toString(36) }
  const raw = (navigator?.userAgent || '') + unique
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i)
    hash |= 0
  }
  const id = Math.abs(hash).toString(36).toUpperCase().slice(0, 8).padEnd(8, '0')
  try { localStorage.setItem('reflie_local_id', id) } catch {}
  return id
}

export class SignalingClient {
  private ws: WebSocket | null = null
  private _peerId = ''
  private callbacks: SignalCallback[] = []
  private rawCallbacks: RawMessageCallback[] = []
  private disconnectCallbacks: Array<() => void> = []
  private localId = ''

  get peerId() {
    return this._peerId
  }

  connect(timeoutMs = 8000, url?: string): Promise<string> {
    this.localId = deriveLocalId()
    return new Promise((resolve, reject) => {
      try {
        const baseUrl = url ?? (() => {
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
          return `${proto}//${location.host}/ws`
        })()
        const wsUrl = baseUrl + '?peerId=' + encodeURIComponent(this.localId)
        this.ws = new WebSocket(wsUrl)

        const timer = setTimeout(() => {
          this.ws?.close()
          reject(new Error('連線逾時，請確認信令伺服器是否正在執行'))
        }, timeoutMs)

        this.ws.onmessage = (e) => {
          try {
            const raw = e.data as string
            const msg = JSON.parse(raw)
            if (msg.type === 'welcome') {
              clearTimeout(timer)
              this._peerId = msg.peerId as string
              resolve(this._peerId)
            } else if (msg.type === 'signal') {
              for (const cb of this.callbacks) cb(msg.from as string, msg.data)
            }
            // Notify raw message callbacks for all non-signal messages
            if (msg.type !== 'signal') {
              for (const cb of this.rawCallbacks) cb(raw)
            }
          } catch {}
        }

        this.ws.onerror = () => { clearTimeout(timer); reject(new Error('無法連線到信令伺服器')) }
        this.ws.onclose = () => {
          for (const cb of this.disconnectCallbacks) cb()
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  /** Send a raw JSON message to the signaling server. */
  send(raw: object) {
    this.ws?.send(JSON.stringify(raw))
  }

  /** Send a WebRTC signal to a remote peer. */
  signal(to: string, data: unknown) {
    this.ws?.send(JSON.stringify({ type: 'signal', to, data }))
  }

  /** Register a callback for incoming signals. Returns an unsubscribe function. */
  addSignalHandler(cb: SignalCallback): () => void {
    this.callbacks.push(cb)
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== cb)
    }
  }

  /** Register a callback for raw non-signal messages from the server. */
  onRawMessage(cb: RawMessageCallback) {
    this.rawCallbacks.push(cb)
  }

  onDisconnect(cb: () => void) {
    this.disconnectCallbacks.push(cb)
  }

  /** Reconnect with same settings. Returns new peerId (same localId). */
  async reconnect(timeoutMs = 8000): Promise<string> {
    this.ws?.close()
    this.ws = null
    this._peerId = ''
    return this.connect(timeoutMs)
  }

  get localPeerId() {
    return this.localId || deriveLocalId()
  }

  disconnect() {
    this.callbacks = []
    this.rawCallbacks = []
    this.disconnectCallbacks = []
    this.ws?.close()
    this.ws = null
  }
}
