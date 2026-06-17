import { useState, useEffect, useCallback, useRef } from 'react'
import QRCode from 'qrcode'
import { SignalingClient } from './webrtc/signaling'
import { WebRTCPeer, type FileMeta } from './webrtc/peer'
import { FileReceiver } from './webrtc/transfer'

type TxStatus = 'transferring' | 'done' | 'error'
type TxDir = 'send' | 'receive'

interface WebTransfer {
  id: string
  name: string
  size: number
  direction: TxDir
  progress: number
  speed: number
  status: TxStatus
  blobUrl?: string
  error?: string
  createdAt: string
  isText?: boolean
  textContent?: string
}

function fmtSize(b: number) {
  if (b === 0) return '0 B'
  const k = 1024, u = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(k))
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + u[i]
}
function fmtSpeed(b: number) { return fmtSize(b) + '/s' }
function fmtPeer(id: string) { return id.length === 8 ? id.slice(0, 4) + '-' + id.slice(4) : id }

export default function WebApp() {
  const [darkMode, setDarkMode] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const [wsState, setWsState] = useState<'connecting' | 'ok' | 'failed'>('connecting')
  const [peerId, setPeerId] = useState('')
  const [inputId, setInputId] = useState('')
  const [remotePeerId, setRemotePeerId] = useState('')
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [sigOk, setSigOk] = useState(false)
  const [sigError, setSigError] = useState('')
  const [transfers, setTransfers] = useState<WebTransfer[]>(() => {
    try { return JSON.parse(localStorage.getItem('rf_transfers') || '[]') } catch { return [] }
  })
  const [dragging, setDragging] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [showTextShare, setShowTextShare] = useState(false)
  const [textToSend, setTextToSend] = useState('')
  const [showTextPreview, setShowTextPreview] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyLabel, setCopyLabel] = useState('')
  interface BtDevice { id: string; name: string; connected: boolean; peerId?: string; deviceRef?: BluetoothDevice }
  const [btDevices, setBtDevices] = useState<BtDevice[]>([])
  const [btScanning, setBtScanning] = useState(false)
  const [btConnectingId, setBtConnectingId] = useState('')
  const [bleStatus, setBleStatus] = useState<string | null>(null)
  const [qrUrl, setQrUrl] = useState('')
  const [qrError, setQrError] = useState('')
  const [onlinePeers, setOnlinePeers] = useState<Array<{id: string; name: string}>>([])

  const sigRef = useRef<SignalingClient | null>(null)
  const peerRef = useRef<WebRTCPeer | null>(null)
  const receiverRef = useRef(new FileReceiver())
  const connectedRef = useRef(false)
  const connectingRef = useRef(false)
  const speedMap = useRef<Record<string, { bytes: number; ts: number }>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const qrCanvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    try { localStorage.setItem('rf_transfers', JSON.stringify(transfers)) } catch {}
  }, [transfers])

  const setupPeer = useCallback((peer: WebRTCPeer) => {
    const receiver = receiverRef.current

    peer.onOpen = () => {
      setConnected(true)
      setConnecting(false)
      setRemotePeerId(peer.remotePeerId)
      connectedRef.current = true
      connectingRef.current = false
    }
    peer.onClose = () => {
      setConnected(false)
      setConnecting(false)
      setRemotePeerId('')
      connectedRef.current = false
      connectingRef.current = false
      peerRef.current = null
    }
    peer.onError = (msg) => {
      setConnecting(false)
      connectingRef.current = false
      setSigError(msg)
      setTimeout(() => setSigError(''), 4000)
    }

    let currentRxId = ''
    peer.onMeta = (meta: FileMeta) => {
      const id = crypto.randomUUID().slice(0, 8)
      currentRxId = id
      speedMap.current[id] = { bytes: 0, ts: Date.now() }
      receiver.setMeta(meta)
      setTransfers(prev => [...prev, {
        id, name: meta.name, size: meta.size,
        direction: 'receive', progress: 0, speed: 0,
        status: 'transferring', createdAt: new Date().toISOString(),
      }])

      receiver.onProgress = (got, total) => {
        setTransfers(prev => prev.map(t => {
          if (t.id !== currentRxId) return t
          const tr = speedMap.current[t.id]
          let speed = 0
          if (tr) {
            const dt = (Date.now() - tr.ts) / 1000
            if (dt > 0.2) { speed = (got - tr.bytes) / dt; speedMap.current[t.id] = { bytes: got, ts: Date.now() } }
          }
          return { ...t, progress: got / total, speed, status: 'transferring' }
        }))
      }

      receiver.onComplete = (blob, name) => {
        const url = URL.createObjectURL(blob)
        const isText = blob.type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')
        const update = (extra: Partial<WebTransfer>) => {
          setTransfers(prev => prev.map(t =>
            t.id === currentRxId ? { ...t, status: 'done', progress: 1, speed: 0, blobUrl: url, ...extra } : t
          ))
        }
        if (isText) {
          blob.text().then(text => update({ isText: true, textContent: text }))
        } else {
          update({})
        }
      }
    }
    peer.onChunk = (chunk) => receiver.addChunk(chunk)
  }, [])

  const doConnect = useCallback((localId: string, remoteId: string, client: SignalingClient) => {
    if (remoteId === localId) return
    connectingRef.current = true
    setConnecting(true)
    peerRef.current?.close()

    const peer = new WebRTCPeer(client, remoteId, true)
    peerRef.current = peer
    setupPeer(peer)

    peer.initiate().catch(e => {
      setConnecting(false)
      connectingRef.current = false
      setSigError('連線失敗: ' + String(e))
      setTimeout(() => setSigError(''), 4000)
    })
  }, [setupPeer])

  const handleIncoming = useCallback((from: string, offer: RTCSessionDescriptionInit) => {
    if (connectedRef.current || connectingRef.current) return
    connectingRef.current = true
    setConnecting(true)
    peerRef.current?.close()

    const client = sigRef.current!
    const peer = new WebRTCPeer(client, from, false, offer)
    peerRef.current = peer
    setupPeer(peer)
  }, [setupPeer])

  useEffect(() => {
    const client = new SignalingClient()
    sigRef.current = client

    const ua = navigator.userAgent
    let deviceName = 'Web'
    if (/Android/i.test(ua)) deviceName = 'Android'
    else if (/iPhone|iPad|iPod/i.test(ua)) deviceName = 'iOS'
    else if (/Windows/i.test(ua)) deviceName = 'Windows'
    else if (/Mac/i.test(ua)) deviceName = 'macOS'
    else if (/Linux/i.test(ua)) deviceName = 'Linux'

    client.connect().then(id => {
      // Check if this effect was already cleaned up (StrictMode double-mount)
      if (!sigRef.current) return
      setPeerId(id)
      setSigOk(true)
      setWsState('ok')

      // Send our device info
      client.send({ type: 'peer-info', name: deviceName })

      // Listen for raw WebSocket messages (peer-list etc.)
      client.onRawMessage((raw) => {
        try {
          const msg = JSON.parse(raw)
          if (msg.type === 'peer-list' && Array.isArray(msg.peers)) {
            const others = msg.peers.filter((p: any) => p.id !== id)
            setOnlinePeers(others)
            // Update BLE device names from peer-list
            setBtDevices(prev => prev.map(d => {
              const match = others.find((p: any) => p.id === d.peerId)
              if (match && match.name && match.name !== d.name) {
                return { ...d, name: match.name }
              }
              return d
            }))
          }
        } catch {}
      })

      // Register incoming offer handler (runs for the lifetime of the component)
      client.addSignalHandler((from, rawData) => {
        const msg = rawData as Record<string, unknown>
        if (msg.type === 'offer') {
          handleIncoming(from, msg.sdp as RTCSessionDescriptionInit)
        }
      })

      // Auto-connect if URL has ?peer=XXXX
      const params = new URLSearchParams(location.search)
      const targetId = (params.get('peer') || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase().slice(0, 8)
      if (targetId && targetId !== id) {
        setInputId(targetId)
        doConnect(id, targetId, client)
      }
    }).catch(() => {
      if (!sigRef.current) return
      setWsState('failed')
    })

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let retries = 0
    const doReconnect = () => {
      setWsState('connecting')
      setSigOk(false)
      setConnected(false)
      setConnecting(false)
      setRemotePeerId('')
      connectedRef.current = false
      connectingRef.current = false
      peerRef.current?.close()
      peerRef.current = null

      const delay = Math.min(1000 * Math.pow(2, retries), 15000)
      retries++
      reconnectTimer = setTimeout(async () => {
        if (!sigRef.current) return
        try {
          const newId = await client.reconnect()
          if (!sigRef.current) return
          // Re-send peer-info and restore state
          client.send({ type: 'peer-info', name: deviceName })
          setPeerId(newId)
          setSigOk(true)
          setWsState('ok')
          retries = 0
          // Auto-connect from URL if pending
          const params = new URLSearchParams(location.search)
          const targetId = (params.get('peer') || '').replace(/[^A-Fa-f0-9]/g, '').toUpperCase().slice(0, 8)
          if (targetId && targetId !== newId && !connectedRef.current) {
            setInputId(targetId)
            doConnect(newId, targetId, client)
          }
        } catch {
          doReconnect() // keep retrying
        }
      }, delay)
    }

    client.onDisconnect(doReconnect)

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      client.disconnect()
      peerRef.current?.close()
    }
  }, [handleIncoming, doConnect])

  const handleConnect = () => {
    const id = inputId.replace(/[^A-Fa-f0-9]/g, '').toUpperCase().slice(0, 8)
    if (id.length !== 8 || !sigRef.current || !peerId) return
    doConnect(peerId, id, sigRef.current)
  }

  const handleDisconnect = () => { peerRef.current?.close() }

  const sendFiles = useCallback(async (files: File[]) => {
    const peer = peerRef.current
    if (!peer?.isOpen()) {
      setSigError('傳輸通道未開啟，請先連線')
      setTimeout(() => setSigError(''), 3000)
      return
    }
    for (const file of files) {
      const id = crypto.randomUUID().slice(0, 8)
      speedMap.current[id] = { bytes: 0, ts: Date.now() }
      const blobUrl = URL.createObjectURL(file)
      setTransfers(prev => [...prev, {
        id, name: file.name, size: file.size,
        direction: 'send', progress: 0, speed: 0,
        status: 'transferring', createdAt: new Date().toISOString(),
        blobUrl,
      }])
      try {
        await peer.sendFile(file, (sent, total) => {
          setTransfers(prev => prev.map(t => {
            if (t.id !== id) return t
            const tr = speedMap.current[id]
            let speed = 0
            if (tr) {
              const dt = (Date.now() - tr.ts) / 1000
              if (dt > 0.2) { speed = (sent - tr.bytes) / dt; speedMap.current[id] = { bytes: sent, ts: Date.now() } }
            }
            return { ...t, progress: sent / total, speed, status: sent >= total ? 'done' : 'transferring' }
          }))
        })
        setTransfers(prev => prev.map(t => t.id === id ? { ...t, status: 'done', progress: 1, speed: 0 } : t))
      } catch (e) {
        setTransfers(prev => prev.map(t => t.id === id ? { ...t, status: 'error', error: String(e) } : t))
      }
    }
  }, [])

  const handleSendText = useCallback(() => {
    if (!connected || !textToSend.trim()) return
    const blob = new Blob([textToSend], { type: 'text/plain' })
    const file = new File([blob], 'clipboard.txt')
    sendFiles([file])
    setTextToSend('')
    setShowTextShare(false)
  }, [connected, textToSend, sendFiles])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    if (!connected) return
    sendFiles(Array.from(e.dataTransfer.files))
  }, [connected, sendFiles])

  const handleCopyId = () => {
    navigator.clipboard.writeText(fmtPeer(peerId)).then(() => {
      setCopied(true); setCopyLabel('ID 已複製')
      setTimeout(() => { setCopied(false); setCopyLabel('') }, 2000)
    })
  }

  useEffect(() => {
    if (!showQR || !qrUrl || !qrCanvasRef.current) return
    setQrError('')
    const canvas = qrCanvasRef.current
    QRCode.toCanvas(canvas, qrUrl, {
      width: 260, margin: 2,
      color: {
        dark: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000',
        light: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff',
      },
    }).catch(err => {
      setQrError('QR Code 生成失敗: ' + String(err))
    })
  }, [showQR, qrUrl])

  const handleShowQR = () => {
    if (!peerId) {
      setQrError('尚未取得連線 ID，無法產生 QR Code')
      setShowQR(true)
      return
    }
    setQrUrl(`${location.origin}${location.pathname}?peer=${peerId}`)
    setQrError('')
    setShowQR(true)
  }

  const handleShareLink = () => {
    const url = `${location.origin}${location.pathname}?peer=${peerId}`
    if (navigator.share) {
      navigator.share({ title: 're/file 連線', url })
    } else {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true); setCopyLabel('連結已複製')
        setTimeout(() => { setCopied(false); setCopyLabel('') }, 2000)
      })
    }
  }

  const sends = transfers.filter(t => t.direction === 'send')
  const receives = transfers.filter(t => t.direction === 'receive')

  // ── Static-hosting fallback (no WebSocket server, e.g. Cloudflare Pages) ──
  if (wsState === 'failed') {
      return (
        <div className="webapp-root webapp-static-root">
          <div className="topbar">
            <div className="topbar-left">
              <span className="webapp-wordmark">re/<span>file</span></span>
            </div>
            <div className="topbar-right">
            <button className="topbar-btn" onClick={() => setDarkMode(d => !d)}>
              {darkMode
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
            </button>
          </div>
        </div>
        <div className="webapp-static-body">
          <div className="webapp-static-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </div>
          <h2 className="webapp-static-title">這個環境沒辦法即時連線</h2>
          <p className="webapp-static-desc">
            現在是用靜態網頁在跑，少了 WebSocket 伺服器，沒辦法讓兩邊互相找到對方。<br />
            下載桌面版就能直接在區網傳，或去 Replit 版本用網頁傳。
          </p>
          <div className="webapp-static-btns">
            <a href="#download" className="webapp-static-btn-primary"
              onClick={e => { e.preventDefault(); window.location.hash = '#download'; window.location.reload() }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              下載桌面版
            </a>
            <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer"
              className="webapp-static-btn-ghost">
              GitHub →
            </a>
          </div>
        </div>
      </div>
    )
  }

  // ── Loading (connecting to signaling server) ──
  if (wsState === 'connecting') {
    return (
      <div className="webapp-root webapp-static-root">
        <div className="topbar">
          <div className="topbar-left">
            <span className="status-dot-indicator yellow" />
            <span className="webapp-wordmark">re/<span>file</span></span>
          </div>
        </div>
        <div className="webapp-static-body webapp-muted">正在連線…</div>
      </div>
    )
  }

  return (
    <div className="webapp-root">
      {/* ── Topbar ── */}
      <div className="topbar">
        <div className="topbar-left">
          <span className="webapp-wordmark">re/<span>file</span></span>
          <span className="webapp-tag">網頁版</span>
        </div>
        <div className="topbar-center">
          <span className={`webapp-ws-status ${wsState}`}>
            <span className={`status-dot-indicator ${sigOk ? 'green' : 'yellow'}`} />
            {wsState === 'ok' ? '已連線' : wsState === 'connecting' ? '連線中⋯' : '離線'}
          </span>
          {connected && (
            <span className="webapp-topbar-peers">
              <span className="status-dot-indicator green" />
              {fmtPeer(remotePeerId)}
            </span>
          )}
        </div>
        <div className="topbar-right">
          <button className="topbar-btn" title={connected ? '傳送文字' : '需先連線才能傳送文字'}
            onClick={() => { if (connected) setShowTextShare(true) }}
            style={{ opacity: connected ? 1 : 0.35 }}
            disabled={!connected}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
          </button>
          <button className="topbar-btn" title="下載桌面版"
            onClick={() => window.open(location.pathname + '#download', '_blank')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
          <label className="main-toggle">
            <input type="checkbox" className="main-checkbox" checked={darkMode} onChange={() => setDarkMode(d => !d)} />
            <div className="main-track"></div>
            <div className="main-knob"></div>
          </label>
        </div>
      </div>

      <main className="webapp-main">
        <div className="webapp-bg"></div>
        <div className="webapp-main-scroll">
          {/* ── Controls bar ── */}
          <div className="webapp-controls">
            {/* My ID */}
            <div className="wc-group">
              <span className="wc-label">我的 ID</span>
              {sigOk ? (
                <>
                  <span className="wc-id">{fmtPeer(peerId)}</span>
                  <div className="wc-btns">
                    <button className="wc-btn" onClick={handleCopyId} title="複製 ID">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      {copied ? '已複製' : '複製'}
                    </button>
                    <button className="wc-btn" onClick={handleShowQR} title="QR Code">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="4" height="4"/></svg>
                      QR
                    </button>
                    <button className="wc-btn" onClick={handleShareLink} title="分享連結">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                      分享
                    </button>
                  </div>
                </>
              ) : sigError ? (
                <span className="wc-err">{sigError}</span>
              ) : (
                <span className="wc-muted">正在取得 ID…</span>
              )}
            </div>

            {/* Connect */}
            <div className="wc-group">
              <span className="wc-label">連到對方</span>
              {connected ? (
                <div className="wc-connected">
                  <span className="status-dot-indicator green" />
                  <span className="wc-remote-id">{fmtPeer(remotePeerId)}</span>
                  <button className="wc-disc-btn" onClick={handleDisconnect}>斷開</button>
                </div>
              ) : (
                <div className="wc-connect-form">
                  <input className="wc-input"
                    placeholder="貼上對方 8 碼 ID"
                    value={inputId}
                    onChange={e => setInputId(e.target.value.toUpperCase().replace(/[^A-F0-9-]/g, ''))}
                    onKeyDown={e => e.key === 'Enter' && handleConnect()}
                    maxLength={9}
                    disabled={connecting || !sigOk}
                  />
                  <button className="wc-go-btn" onClick={handleConnect}
                    disabled={connecting || !sigOk || inputId.replace('-', '').length < 8}>
                    {connecting ? '…' : '連線'}
                  </button>
                </div>
              )}
              {sigError && <span className="wc-err">{sigError}</span>}
            </div>

            {/* Online peers (compact) */}
            {onlinePeers.length > 0 && (
              <div className="wc-group wc-online">
                <span className="wc-label">在線 ({onlinePeers.length})</span>
                <div className="wc-peer-list">
                  {onlinePeers.slice(0, 5).map(p => (
                    <button key={p.id} className={`wc-peer-chip ${connected && remotePeerId === p.id ? 'wc-peer-active' : ''}`}
                      onClick={() => { if (!connected && !connecting) { setInputId(p.id); doConnect(peerId, p.id, sigRef.current!) } }}
                      disabled={connected || connecting}>
                      {p.name || fmtPeer(p.id)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="webapp-main-center">

            {/* Logo */}
            <div className="webapp-mlogo">
              <div className="webapp-mlogo-main">re/file</div>
              <div className="webapp-mlogo-sub">peer to peer</div>
            </div>

            {/* Connection status */}
            <div className="webapp-mstatus">
              <div className={`status-dot ${connected ? 'green' : sigOk ? 'yellow' : 'red'}`} />
              {connected ? (
                <>已連線 — {remotePeerId ? fmtPeer(remotePeerId) : ''}</>
              ) : sigOk ? (
                <>等待連線中 · 你的 ID：{fmtPeer(peerId)}</>
              ) : (
                <>正在連線⋯</>
              )}
            </div>

            {/* Drop zone */}
            <div
              className={`webapp-dropzone ${dragging ? 'dz-over' : ''} ${connected ? 'dz-enabled' : 'dz-disabled'}`}
              onDragOver={e => { e.preventDefault(); if (connected) setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => connected && fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" multiple hidden
                onChange={e => { if (e.target.files) { sendFiles(Array.from(e.target.files)); e.target.value = '' } }} />
              {connected ? (
                <>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="dz-icon">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                  <div className="dz-label">拖曳檔案到這裡，或點一下選檔案</div>
                  <div className="dz-hint">什麼格式都能傳，大小也沒限制</div>
                  <button className="dz-text-btn" onClick={(e) => { e.stopPropagation(); setShowTextShare(true) }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                    </svg>
                    傳送文字
                  </button>
                </>
              ) : (
                <>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="dz-icon dz-icon-dim">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                  <div className="dz-label dz-label-dim">還沒連線</div>
                  <div className="dz-hint dz-hint-dim">左邊輸入對方的 ID 就能連了</div>
                </>
              )}
            </div>

            {/* Transfer history */}
            {transfers.length > 0 && (
              <div className="webapp-history-section">
                <div className="webapp-history-header">
                  <span>傳過的東西</span>
                  <button className="webapp-history-clear" onClick={() => setTransfers([])}>清空</button>
                </div>
                <div className="webapp-history-inner">
                  <div className="webapp-history-col">
                    <div className="webapp-col-title">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/></svg>
                      傳出去的 <span className="webapp-col-count">{sends.length}</span>
                    </div>
                    {sends.length === 0 && <div className="webapp-col-empty">還沒傳過東西</div>}
                    {[...sends].reverse().map(t => <TxItem key={t.id} t={t} />)}
                  </div>
                  <div className="webapp-history-col">
                    <div className="webapp-col-title">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                      收進來的 <span className="webapp-col-count">{receives.length}</span>
                    </div>
                    {receives.length === 0 && <div className="webapp-col-empty">還沒收過東西</div>}
                    {[...receives].reverse().map(t => <TxItem key={t.id} t={t} onViewText={(text) => setShowTextPreview(text)} />)}
                  </div>
                </div>
              </div>
            )}
          </div>
          </div>
        </main>

      {/* Footer */}
      <footer className="webapp-footer">
        <div className="webapp-footer-inner">
          <span className="webapp-footer-brand">
            re/<span>file</span> <span className="webapp-footer-ver">v2.0.0</span>
          </span>
          <span className="webapp-footer-tag">檔案直接點對點傳，不經過伺服器</span>
          <span className="webapp-footer-links">
            <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">GitHub</a>
            <span className="webapp-footer-sep">·</span>
            <a href="javascript:void(0)" onClick={() => window.open(window.location.origin + window.location.pathname + '#download', '_blank')}>下載桌面版</a>
          </span>
        </div>
      </footer>

      {/* Text Share Modal */}
      {showTextShare && (
        <div className="modal-overlay" onClick={() => setShowTextShare(false)}>
          <div className="modal-dialog modal-narrow" onClick={e => e.stopPropagation()}>
            <h3>傳一段文字過去</h3>
            <textarea
              className="text-share-input"
              placeholder="輸入要傳送的網址、密碼、或任何文字…"
              value={textToSend}
              onChange={e => setTextToSend(e.target.value)}
              rows={4}
            />
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={handleSendText} disabled={!textToSend.trim()}>
                傳送
              </button>
              <button className="btn btn-reject modal-btn" onClick={() => setShowTextShare(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Text Preview Modal */}
      {showTextPreview !== null && (
        <div className="modal-overlay" onClick={() => setShowTextPreview(null)}>
          <div className="modal-dialog modal-wide" onClick={e => e.stopPropagation()}>
            <h3>對方傳來的文字</h3>
            <pre className="text-preview">{showTextPreview}</pre>
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={() => {
                navigator.clipboard.writeText(showTextPreview)
              }}>
                複製文字
              </button>
              <button className="btn btn-reject modal-btn" onClick={() => setShowTextPreview(null)}>
                關閉
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal */}
      {showQR && (
        <div className="modal-overlay" onClick={() => setShowQR(false)}>
          <div className="modal-dialog modal-narrow" onClick={e => e.stopPropagation()}>
            <h3>讓對方掃 QR Code</h3>
            {qrError ? (
              <div className="qrcode-error">{qrError}</div>
            ) : (
              <>
                <div className="qrcode-wrapper"><canvas ref={qrCanvasRef} /></div>
                <p className="qrcode-label">對方掃描後會自動開啟連線頁面</p>
              </>
            )}
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={() => setShowQR(false)}>關閉</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fileIcon(name: string): { icon: string; cls: string } {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, [string, string]> = {
    pdf: ['PDF', 'file-red'], doc: ['DOC', 'file-blue'], docx: ['DOC', 'file-blue'],
    xls: ['XLS', 'file-green'], xlsx: ['XLS', 'file-green'],
    ppt: ['PPT', 'file-orange'], pptx: ['PPT', 'file-orange'],
    txt: ['TXT', 'file-gray'], rtf: ['RTF', 'file-gray'],
    csv: ['CSV', 'file-green'], json: ['{}', 'file-indigo'],
    xml: ['XM', 'file-indigo'], yml: ['YM', 'file-orange'], yaml: ['YM', 'file-orange'],
    js: ['JS', 'file-yellow'], jsx: ['JS', 'file-yellow'],
    ts: ['TS', 'file-blue'], tsx: ['TS', 'file-blue'],
    py: ['PY', 'file-indigo'], rb: ['RB', 'file-red'],
    go: ['GO', 'file-sky'], rs: ['RS', 'file-orange'],
    java: ['JV', 'file-orange'], swift: ['SW', 'file-orange'],
    sh: ['SH', 'file-green'], ps1: ['PS', 'file-blue'],
    html: ['H5', 'file-orange'], css: ['CSS', 'file-blue'],
    png: ['PNG', 'file-purple'], jpg: ['JPG', 'file-purple'], jpeg: ['JPG', 'file-purple'],
    gif: ['GIF', 'file-purple'], webp: ['WBP', 'file-purple'], svg: ['SVG', 'file-purple'],
    ico: ['ICO', 'file-purple'], bmp: ['BMP', 'file-purple'],
    mp4: ['MP4', 'file-indigo'], avi: ['AVI', 'file-indigo'],
    mov: ['MOV', 'file-indigo'], mkv: ['MKV', 'file-indigo'],
    mp3: ['MP3', 'file-orange'], wav: ['WAV', 'file-orange'],
    flac: ['FLA', 'file-orange'], aac: ['AAC', 'file-orange'],
    zip: ['ZIP', 'file-yellow'], rar: ['RAR', 'file-yellow'],
    '7z': ['7Z', 'file-yellow'], tar: ['TAR', 'file-yellow'], gz: ['GZ', 'file-yellow'],
    exe: ['EXE', 'file-red'], msi: ['MSI', 'file-red'],
    dmg: ['DMG', 'file-red'], appimage: ['APP', 'file-red'],
    iso: ['ISO', 'file-sky'], img: ['IMG', 'file-sky'],
  };
  return map[ext] || ['?', 'file-gray'];
}

function TxItem({ t, onViewText }: { t: WebTransfer; onViewText?: (text: string) => void }) {
  const ii = fileIcon(t.name);
  return (
    <div className={`webapp-tx ${t.status}`}>
      <div className="webapp-tx-row">
        <div className={`webapp-tx-icon ${ii.cls}`}>{ii.icon}</div>
        <div className="webapp-tx-body">
          <div className="webapp-tx-name" title={t.name}>{t.name}</div>
          <div className="webapp-tx-meta">
            <span>{fmtSize(t.size)}</span>
            {t.status === 'transferring' && t.speed > 0 && <span>{fmtSpeed(t.speed)}</span>}
            <span className={`webapp-tx-badge ${t.status}`}>
              {t.status === 'transferring' ? '傳輸中' : t.status === 'done' ? '完成' : '錯誤'}
            </span>
          </div>
          {t.status === 'transferring' && (
            <div className="webapp-tx-bar">
              <div className="webapp-tx-fill" style={{ width: `${Math.max(t.progress * 100, 2)}%` }} />
            </div>
          )}
          {t.status === 'done' && t.direction === 'receive' && t.blobUrl && t.isText && t.textContent && (
            <button className="webapp-dl-btn" onClick={() => onViewText?.(t.textContent!)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              檢視文字
            </button>
          )}
          {t.status === 'done' && t.blobUrl && (
            <a href={t.blobUrl} download={t.name} className="webapp-dl-btn">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {t.direction === 'send' ? '下載備份' : '再次下載'}
            </a>
          )}
          {t.status === 'error' && <div className="webapp-tx-err">{t.error}</div>}
        </div>
      </div>
    </div>
  )
}
