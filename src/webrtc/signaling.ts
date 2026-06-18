type SignalCallback = (from: string, data: unknown) => void
type RawMessageCallback = (raw: string) => void

export function detectBrowser(): string {
  const ua = navigator.userAgent
  if (/Edg\/|Edge\//.test(ua)) return 'Edge'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari'
  return 'Browser'
}

export function detectOS(): string {
  const ua = navigator.userAgent
  if (/Windows NT 10/.test(ua)) return 'Windows 10'
  if (/Windows NT 11/.test(ua)) return 'Windows 11'
  if (/Windows/.test(ua)) return 'Windows'
  const mac = ua.match(/Mac OS X ([\d._]+)/)
  if (mac) return `macOS ${mac[1].replace(/_/g, '.')}`
  const ios = ua.match(/OS (\d+[._]\d+)/)
  if (/iPhone|iPad|iPod/.test(ua) && ios) return `iOS ${ios[1].replace(/_/g, '.')}`
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS'
  const android = ua.match(/Android (\d+)/)
  if (android) return `Android ${android[1]}`
  if (/Linux/.test(ua)) return 'Linux'
  return 'Unknown'
}

export function getDeviceName(): string {
  try {
    const custom = localStorage.getItem('reflie_device_name')
    if (custom) return custom
  } catch {}
  return `${detectBrowser()} on ${detectOS()}`
}

export function setDeviceName(name: string): void {
  try { localStorage.setItem('reflie_device_name', name) } catch {}
}

export function deriveLocalId(): string {
  // Tab-specific storage: survives page reload, not shared across tabs
  try {
    const tab = sessionStorage.getItem('reflie_peer_id')
    if (tab && tab.length === 8) return tab
  } catch {}
  // Device-wide storage: shared across tabs (last write wins)
  try {
    const stored = localStorage.getItem('reflie_peer_id')
    if (stored && stored.length === 8) {
      try { sessionStorage.setItem('reflie_peer_id', stored) } catch {}
      return stored
    }
    // Migrate from old key
    const old = localStorage.getItem('reflie_local_id')
    if (old && old.length === 8) {
      try { localStorage.setItem('reflie_peer_id', old); sessionStorage.setItem('reflie_peer_id', old) } catch {}
      return old
    }
  } catch {}
  // Generate a truly unique ID per tab from crypto.randomUUID()
  let unique: string
  try { unique = crypto.randomUUID() } catch { unique = Math.random().toString(36).substring(2) + Date.now().toString(36) }
  const id = unique.replace(/-/g, '').toUpperCase().slice(0, 8).padEnd(8, '0')
  try { localStorage.setItem('reflie_peer_id', id); sessionStorage.setItem('reflie_peer_id', id) } catch {}
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
              try { localStorage.setItem('reflie_peer_id', this._peerId) } catch {}
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
