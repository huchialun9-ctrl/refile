type SignalCallback = (from: string, data: unknown) => void
type RawMessageCallback = (raw: string) => void

export class SignalingClient {
  private ws: WebSocket | null = null
  private _peerId = ''
  private callbacks: SignalCallback[] = []
  private rawCallbacks: RawMessageCallback[] = []
  private disconnectCallbacks: Array<() => void> = []

  get peerId() {
    return this._peerId
  }

  connect(timeoutMs = 8000, url?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = url ?? (() => {
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
          return `${proto}//${location.host}/ws`
        })()
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

  /** Reconnect with same settings. Returns new peerId. */
  async reconnect(timeoutMs = 8000): Promise<string> {
    this.ws?.close()
    this.ws = null
    this._peerId = ''
    return this.connect(timeoutMs)
  }

  disconnect() {
    this.callbacks = []
    this.rawCallbacks = []
    this.disconnectCallbacks = []
    this.ws?.close()
    this.ws = null
  }
}
