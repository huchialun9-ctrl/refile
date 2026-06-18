import type { SignalingClient } from './signaling'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.voipbuster.com:3478' },
  { urls: 'stun:stun.xten.com:3478' },
  { urls: 'stun:stun.sipgate.net:10000' },
]

export interface FileMeta {
  type: 'meta'
  name: string
  size: number
  mime: string
}

export class WebRTCPeer {
  private pc: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private pendingIce: RTCIceCandidateInit[] = []
  private unsub: () => void

  readonly remotePeerId: string

  onOpen?: () => void
  onClose?: () => void
  onError?: (msg: string) => void
  onMeta?: (meta: FileMeta) => void
  onChunk?: (chunk: ArrayBuffer) => void

  constructor(
    private signaling: SignalingClient,
    remotePeerId: string,
    private isInitiator: boolean,
    initialOffer?: RTCSessionDescriptionInit,
  ) {
    this.remotePeerId = remotePeerId

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.signal(remotePeerId, { type: 'ice', candidate: e.candidate.toJSON() })
      }
    }

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState
      // Only use connectionstate for error detection;
      // open/close are handled by data channel events
      if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        this.channel?.close()
        this.onClose?.()
      }
    }

    // Handle signaling messages (answer + ICE for initiator; ICE for responder)
    this.unsub = signaling.addSignalHandler(async (from, rawData) => {
      if (from !== remotePeerId) return
      const msg = rawData as Record<string, unknown>
      try {
        if (msg.type === 'answer' && isInitiator) {
          await this.pc.setRemoteDescription(
            new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit),
          )
          await this.flushPendingIce()
        } else if (msg.type === 'ice') {
          const candidate = msg.candidate as RTCIceCandidateInit
          if (!this.pc.remoteDescription) {
            this.pendingIce.push(candidate)
          } else {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate))
          }
        }
      } catch (e) {
        console.warn('WebRTC signaling error:', e)
      }
    })

    if (isInitiator) {
      this.channel = this.pc.createDataChannel('reflie', { ordered: true })
      this.setupChannel(this.channel)
    } else {
      this.pc.ondatachannel = (e) => {
        this.channel = e.channel
        this.setupChannel(this.channel)
      }
      if (initialOffer) {
        this.processOffer(initialOffer).catch((e) => this.onError?.(String(e)))
      }
    }
  }

  private setupChannel(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer'
    ch.onopen = () => this.onOpen?.()
    ch.onclose = () => {
      // PC onconnectionstatechange will also fire onclose when the whole
      // connection drops. Only fire our callback if PC is still connected
      // (channel-only closure is rare but possible).
      if (this.pc.connectionState !== 'closed') {
        this.pc.close()
        this.onClose?.()
      }
    }
    ch.onerror = (e) => this.onError?.(String(e))
    ch.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const meta = JSON.parse(e.data) as FileMeta
          if (meta.type === 'meta') this.onMeta?.(meta)
        } catch {}
      } else {
        this.onChunk?.(e.data as ArrayBuffer)
      }
    }
  }

  private async processOffer(offer: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer))
    await this.flushPendingIce()
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    this.signaling.signal(this.remotePeerId, { type: 'answer', sdp: answer })
  }

  private async flushPendingIce() {
    for (const c of this.pendingIce) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c))
      } catch {}
    }
    this.pendingIce = []
  }

  /** Call after constructing the initiator peer to send the offer. */
  async initiate() {
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.signaling.signal(this.remotePeerId, { type: 'offer', sdp: offer })
  }

  /** Send a file over the DataChannel. */
  async sendFile(
    file: File,
    onProgress: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('傳輸通道尚未開啟')
    }

    const CHUNK = 64 * 1024 // 64 KB

    // Ensure buffer is ready before sending meta
    await this.waitForBuffer()

    this.channel.send(
      JSON.stringify({
        type: 'meta',
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      } satisfies FileMeta),
    )

    let sent = 0
    while (sent < file.size) {
      if (signal?.aborted) throw new Error('已取消傳輸')
      // Fail fast if channel closed mid-transfer
      if (!this.channel || this.channel.readyState !== 'open') {
        throw new Error('傳輸通道已關閉')
      }
      await this.waitForBuffer()
      if (signal?.aborted) throw new Error('已取消傳輸')
      const buf = await file.slice(sent, sent + CHUNK).arrayBuffer()
      this.channel.send(buf)
      sent += buf.byteLength
      onProgress(sent, file.size)
    }
  }

  private waitForBuffer(): Promise<void> {
    const MAX = 1 * 1024 * 1024 // pause if > 1 MB buffered
    const TIMEOUT = 10000 // 10s safety timeout
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('傳輸緩衝區逾時')), TIMEOUT)
      const check = () => {
        if (!this.channel || this.channel.readyState !== 'open') {
          clearTimeout(timer)
          reject(new Error('傳輸通道已關閉'))
          return
        }
        if (this.channel.bufferedAmount <= MAX) {
          clearTimeout(timer)
          resolve()
        } else {
          setTimeout(check, 30)
        }
      }
      check()
    })
  }

  isOpen() {
    return this.channel?.readyState === 'open'
  }

  close() {
    this.unsub()
    this.channel?.close()
    this.pc.close()
  }
}
