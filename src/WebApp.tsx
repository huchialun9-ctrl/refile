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
  const [landing, setLanding] = useState(true)
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

  // ── Landing page ──
  if (landing) {
    return (
      <div className="webapp-root">
        <header className="wl-header">
          <div className="wl-header-inner">
            <span className="wl-logo">re/<span>file</span></span>
            <nav className="wl-nav">
              <a href="#" onClick={e => { e.preventDefault(); setLanding(false) }}>開始使用</a>
              <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT 授權</a>
              <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">GitHub</a>
            </nav>
            <label className="main-toggle" style={{ marginLeft: 'auto' }}>
              <input type="checkbox" className="main-checkbox" checked={darkMode} onChange={() => setDarkMode(d => !d)} />
              <div className="main-track"></div>
              <div className="main-knob"></div>
            </label>
          </div>
        </header>
        <main className="wl-main">
          <div className="wl-hero">
            <div className="wl-card">
              <div className="wl-card-canvas">
                  <div className="flex flex-row flex-shrink-0 justify-center items-center gap-2">
                    <div className="rounded-full flex items-center justify-center bg-[rgba(248,248,248,0.01)] shadow-[0px_0px_8px_0px_rgba(248,248,248,0.25)_inset,0px_32px_24px_-16px_rgba(0,0,0,0.40)] h-8 w-8 circle-1">
                      <svg className="h-4 w-4" viewBox="0 0 512 512" clip-rule="evenodd" fill-rule="evenodd" image-rendering="optimizeQuality" text-rendering="geometricPrecision" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg">
                        <rect ry="105.042" rx="104.187" height="512" width="512" fill="#CC9B7A"></rect>
                        <path d="M318.663 149.787h-43.368l78.952 212.423 43.368.004-78.952-212.427zm-125.326 0l-78.952 212.427h44.255l15.932-44.608 82.846-.004 16.107 44.612h44.255l-79.126-212.427h-45.317zm-4.251 128.341l26.91-74.701 27.083 74.701h-53.993z" fill-rule="nonzero" fill="#1F1F1E"></path>
                      </svg>
                    </div>
                    <div className="rounded-full flex items-center justify-center bg-[rgba(248,248,248,0.01)] shadow-[0px_0px_8px_0px_rgba(248,248,248,0.25)_inset,0px_32px_24px_-16px_rgba(0,0,0,0.40)] h-12 w-12 circle-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" className="h-6 w-6 dark:text-white" viewBox="0 0 24 24" stroke-width="0" fill="currentColor" stroke="currentColor">
                        <path d="M9.75 14a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 .75-.75Zm4.5 0a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 .75-.75Z"></path>
                        <path d="M12 2c2.214 0 4.248.657 5.747 1.756.136.099.268.204.397.312.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086l.633 1.478.043.022A4.75 4.75 0 0 1 24 15.222v1.028c0 .529-.309.987-.565 1.293-.28.336-.636.653-.966.918a13.84 13.84 0 0 1-1.299.911l-.024.015-.006.004-.039.025c-.223.135-.45.264-.68.386-.46.245-1.122.571-1.941.895C16.845 21.344 14.561 22 12 22c-2.561 0-4.845-.656-6.479-1.303a19.046 19.046 0 0 1-1.942-.894 14.081 14.081 0 0 1-.535-.3l-.144-.087-.04-.025-.006-.004-.024-.015a13.16 13.16 0 0 1-1.299-.911 6.913 6.913 0 0 1-.967-.918C.31 17.237 0 16.779 0 16.25v-1.028a4.75 4.75 0 0 1 2.626-4.248l.043-.022.633-1.478a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.498 1.132-3.368.397-.406.89-.717 1.474-.952.129-.108.261-.213.397-.312C7.752 2.657 9.786 2 12 2Zm-8 9.654v6.669a17.59 17.59 0 0 0 2.073.98C7.595 19.906 9.686 20.5 12 20.5c2.314 0 4.405-.594 5.927-1.197a17.59 17.59 0 0 0 2.073-.98v-6.669l-.038-.09c-.046.061-.095.12-.145.177-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.544-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.344a4.323 4.323 0 0 1-.355.508C10.704 12.456 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a3.026 3.026 0 0 1-.145-.177Zm6.309-1.092c.445-.547.708-1.334.851-2.301.057-.357.087-.718.09-1.079v-.031c-.001-.762-.166-1.26-.43-1.568l-.008-.01c-.341-.391-1.046-.689-2.533-.529-1.505.163-2.347.537-2.824 1.024-.462.473-.705 1.18-.705 2.32 0 .605.044 1.087.135 1.472.092.384.231.672.423.89.365.413 1.084.75 2.657.75.91 0 1.527-.223 1.964-.564.14-.11.268-.235.38-.374Zm2.504-2.497c.136 1.057.403 1.913.878 2.497.442.545 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.151.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.318-.862-2.824-1.025-1.487-.161-2.192.139-2.533.529-.268.308-.437.808-.438 1.578v.02c.002.299.023.598.063.894Z"></path>
                      </svg>
                    </div>
                    <div className="h-16 w-16 rounded-full flex items-center justify-center bg-[rgba(248,248,248,0.01)] shadow-[0px_0px_8px_0px_rgba(248,248,248,0.25)_inset,0px_32px_24px_-16px_rgba(0,0,0,0.40)] circle-3">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 28 28" width="28" className="h-8 w-8 dark:text-white">
                        <path fill="currentColor" d="M26.153 11.46a6.888 6.888 0 0 0-.608-5.73 7.117 7.117 0 0 0-3.29-2.93 7.238 7.238 0 0 0-4.41-.454 7.065 7.065 0 0 0-2.41-1.742A7.15 7.15 0 0 0 12.514 0a7.216 7.216 0 0 0-4.217 1.346 7.061 7.061 0 0 0-2.603 3.539 7.12 7.12 0 0 0-2.734 1.188A7.012 7.012 0 0 0 .966 8.268a6.979 6.979 0 0 0 .88 8.273 6.89 6.89 0 0 0 .607 5.729 7.117 7.117 0 0 0 3.29 2.93 7.238 7.238 0 0 0 4.41.454 7.061 7.061 0 0 0 2.409 1.742c.92.404 1.916.61 2.923.604a7.215 7.215 0 0 0 4.22-1.345 7.06 7.06 0 0 0 2.605-3.543 7.116 7.116 0 0 0 2.734-1.187 7.01 7.01 0 0 0 1.993-2.196 6.978 6.978 0 0 0-.884-8.27Zm-10.61 14.71c-1.412 0-2.505-.428-3.46-1.215.043-.023.119-.064.168-.094l5.65-3.22a.911.911 0 0 0 .464-.793v-7.86l2.389 1.36a.087.087 0 0 1 .046.065v6.508c0 2.952-2.491 5.248-5.257 5.248ZM4.062 21.354a5.17 5.17 0 0 1-.635-3.516c.042.025.115.07.168.1l5.65 3.22a.928.928 0 0 0 .928 0l6.898-3.93v2.72a.083.083 0 0 1-.034.072l-5.711 3.255a5.386 5.386 0 0 1-4.035.522 5.315 5.315 0 0 1-3.23-2.443ZM2.573 9.184a5.283 5.283 0 0 1 2.768-2.301V13.515a.895.895 0 0 0 .464.793l6.897 3.93-2.388 1.36a.087.087 0 0 1-.08.008L4.52 16.349a5.262 5.262 0 0 1-2.475-3.185 5.192 5.192 0 0 1 .527-3.98Zm19.623 4.506-6.898-3.93 2.388-1.36a.087.087 0 0 1 .08-.008l5.713 3.255a5.28 5.28 0 0 1 2.054 2.118 5.19 5.19 0 0 1-.488 5.608 5.314 5.314 0 0 1-2.39 1.742v-6.633a.896.896 0 0 0-.459-.792Zm2.377-3.533a7.973 7.973 0 0 0-.168-.099l-5.65-3.22a.93.93 0 0 0-.928 0l-6.898 3.93V8.046a.083.083 0 0 1 .034-.072l5.712-3.251a5.375 5.375 0 0 1 5.698.241 5.262 5.262 0 0 1 1.865 2.28c.39.92.506 1.93.335 2.913ZM9.631 15.009l-2.39-1.36a.083.083 0 0 1-.046-.065V7.075c.001-.997.29-1.973.832-2.814a5.297 5.297 0 0 1 2.231-1.935 5.382 5.382 0 0 1 5.659.72 4.89 4.89 0 0 0-.168.093l-5.65 3.22a.913.913 0 0 0-.465.793l-.003 7.857Zm1.297-2.76L14 10.5l3.072 1.75v3.5L14 17.499l-3.072-1.75v-3.5Z"></path>
                      </svg>
                    </div>
                    <div className="rounded-full flex items-center justify-center bg-[rgba(248,248,248,0.01)] shadow-[0px_0px_8px_0px_rgba(248,248,248,0.25)_inset,0px_32px_24px_-16px_rgba(0,0,0,0.40)] h-12 w-12 circle-4">
                      <svg className="h-6 w-6" viewBox="0 0 287.56 191" xmlns="http://www.w3.org/2000/svg">
                        <defs>
                          <linearGradient gradientUnits="userSpaceOnUse" gradientTransform="matrix(1, 0, 0, -1, 0, 192)" y2="91.45" x2="260.34" y1="101.45" x1="62.34" id="lg1">
                            <stop stop-color="#0064e1" offset="0"></stop>
                            <stop stop-color="#0064e1" offset="0.4"></stop>
                            <stop stop-color="#0073ee" offset="0.83"></stop>
                            <stop stop-color="#0082fb" offset="1"></stop>
                          </linearGradient>
                          <linearGradient gradientUnits="userSpaceOnUse" gradientTransform="matrix(1, 0, 0, -1, 0, 192)" y2="126" x2="41.42" y1="53" x1="41.42" id="lg2">
                            <stop stop-color="#0082fb" offset="0"></stop>
                            <stop stop-color="#0064e0" offset="1"></stop>
                          </linearGradient>
                        </defs>
                        <path d="M31.06,126c0,11,2.41,19.41,5.56,24.51A19,19,0,0,0,53.19,160c8.1,0,15.51-2,29.79-21.76,11.44-15.83,24.92-38,34-52l15.36-23.6c10.67-16.39,23-34.61,37.18-47C181.07,5.6,193.54,0,206.09,0c21.07,0,41.14,12.21,56.5,35.11,16.81,25.08,25,56.67,25,89.27,0,19.38-3.82,33.62-10.32,44.87C271,180.13,258.72,191,238.13,191V160c17.63,0,22-16.2,22-34.74,0-26.42-6.16-55.74-19.73-76.69-9.63-14.86-22.11-23.94-35.84-23.94-14.85,0-26.8,11.2-40.23,31.17-7.14,10.61-14.47,23.54-22.7,38.13l-9.06,16c-18.2,32.27-22.81,39.62-31.91,51.75C84.74,183,71.12,191,53.19,191c-21.27,0-34.72-9.21-43-23.09C3.34,156.6,0,141.76,0,124.85Z" fill="#0081fb"></path>
                        <path d="M24.49,37.3C38.73,15.35,59.28,0,82.85,0c13.65,0,27.22,4,41.39,15.61,15.5,12.65,32,33.48,52.63,67.81l7.39,12.32c17.84,29.72,28,45,33.93,52.22,7.64,9.26,13,12,19.94,12,17.63,0,22-16.2,22-34.74l27.4-.86c0,19.38-3.82,33.62-10.32,44.87C271,180.13,258.72,191,238.13,191c-12.8,0-24.14-2.78-36.68-14.61-9.64-9.08-20.91-25.21-29.58-39.71L146.08,93.6c-12.94-21.62-24.81-37.74-31.68-45C107,40.71,97.51,31.23,82.35,31.23c-12.27,0-22.69,8.61-31.41,21.78Z" fill="url(#lg1)"></path>
                        <path d="M82.35,31.23c-12.27,0-22.69,8.61-31.41,21.78C38.61,71.62,31.06,99.34,31.06,126c0,11,2.41,19.41,5.56,24.51L10.14,167.91C3.34,156.6,0,141.76,0,124.85,0,94.1,8.44,62.05,24.49,37.3,38.73,15.35,59.28,0,82.85,0Z" fill="url(#lg2)"></path>
                      </svg>
                    </div>
                    <div className="rounded-full flex items-center justify-center bg-[rgba(248,248,248,0.01)] shadow-[0px_0px_8px_0px_rgba(248,248,248,0.25)_inset,0px_32px_24px_-16px_rgba(0,0,0,0.40)] h-8 w-8 circle-5">
                      <svg className="h-4 w-4" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none">
                        <path fill="url(#lp0)" d="M16 8.016A8.522 8.522 0 008.016 16h-.032A8.521 8.521 0 000 8.016v-.032A8.521 8.521 0 007.984 0h.032A8.522 8.522 0 0016 7.984v.032z"></path>
                        <defs>
                          <radialGradient gradientTransform="matrix(16.1326 5.4553 -43.70045 129.2322 1.588 6.503)" gradientUnits="userSpaceOnUse" r="1" cy="0" cx="0" id="lp0">
                            <stop stop-color="#9168C0" offset=".067"></stop>
                            <stop stop-color="#5684D1" offset=".343"></stop>
                            <stop stop-color="#1BA1E3" offset=".672"></stop>
                          </radialGradient>
                        </defs>
                      </svg>
                    </div>
                  </div>
                  <div className="h-40 w-px absolute top-20 m-auto z-40 bg-gradient-to-b from-transparent via-cyan-500 to-transparent animate-move">
                    <div className="w-10 h-32 top-1/2 -translate-y-1/2 absolute -left-10">
                      <div className="wl-eq">
                        <span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <p className="wl-card-title">點對點加密傳輸</p>
              <p className="wl-card-desc">檔案經點對點加密後直接傳輸，絕不儲存於任何伺服器</p>
            </div>
            <div className="wl-cta">
              <button className="wl-enter-btn" onClick={() => setLanding(false)}>
                進入應用
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

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
            <span className="webapp-wordmark">re/<span>file</span></span>
          </div>
        </div>
        <div className="webapp-static-body">
          <div className="earth">
            <div className="earth-loader">
              <svg viewBox="0 0 100 100" fill="var(--landcolor)">
                <path d="M30 50 Q35 30 50 25 Q65 28 70 45 Q72 55 65 65 Q55 75 40 70 Q28 65 30 50Z" />
              </svg>
              <svg viewBox="0 0 100 100" fill="var(--landcolor)">
                <path d="M40 20 Q55 10 75 15 Q85 20 88 35 Q90 50 82 60 Q70 70 55 68 Q40 65 35 50 Q30 35 40 20Z" />
              </svg>
              <svg viewBox="0 0 100 100" fill="var(--landcolor)">
                <path d="M20 30 Q30 20 45 18 Q55 22 50 35 Q48 45 40 55 Q30 60 22 50 Q15 40 20 30Z" />
              </svg>
              <svg viewBox="0 0 100 100" fill="var(--landcolor)">
                <path d="M50 45 Q60 35 70 30 Q80 35 78 50 Q75 65 65 70 Q55 72 48 60 Q42 55 50 45Z" />
              </svg>
            </div>
            <p>正在連線…</p>
          </div>
        </div>
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
            {connected ? (
              <div className="file-upload-form">
                <label className="file-upload-label"
                  onDragOver={e => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                >
                  <input ref={fileInputRef} type="file" multiple hidden
                    onChange={e => { if (e.target.files) { sendFiles(Array.from(e.target.files)); e.target.value = '' } }} />
                  <div className="file-upload-design">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
                    </svg>
                    <p>拖曳檔案到這裡</p>
                    <p>或</p>
                    <span className="browse-button" onClick={() => fileInputRef.current?.click()}>選擇檔案</span>
                  </div>
                </label>
                <button className="dz-text-btn" onClick={() => setShowTextShare(true)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                  </svg>
                  傳送文字
                </button>
              </div>
            ) : (
              <div className="file-upload-form">
                <div className="file-upload-label file-upload-label-dim">
                  <div className="file-upload-design">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                    </svg>
                    <p>還沒連線</p>
                    <p>左邊輸入對方的 ID 就能連了</p>
                  </div>
                </div>
              </div>
            )}

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
            re/<span>file</span> <span className="webapp-footer-ver">v0.1.0</span>
          </span>
          <span className="webapp-footer-tag">檔案直接點對點傳，不經過伺服器</span>
          <span className="webapp-footer-links">
            <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">GitHub</a>
            <span className="webapp-footer-sep">·</span>
            <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT 授權</a>
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
