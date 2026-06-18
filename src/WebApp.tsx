import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import QRCode from 'qrcode'
import { SignalingClient } from './webrtc/signaling'
import { WebRTCPeer, type FileMeta } from './webrtc/peer'
import { FileReceiver } from './webrtc/transfer'
import PwaInstallPrompt from './PwaInstallPrompt'
import UpdateChecker from './UpdateChecker'
import Contacts from './Contacts'

type TxStatus = 'transferring' | 'done' | 'error' | 'cancelled' | 'paused'
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

interface BluetoothLEScan {
  stop: () => void
  addEventListener: (event: string, handler: (e: Event) => void) => void
  removeEventListener: (event: string, handler: (e: Event) => void) => void
}

interface BluetoothAdvertisingEvent extends Event {
  device?: { id?: string; address?: string; name?: string }
  name?: string
  localName?: string
  manufacturerData?: {
    has: (id: number) => boolean
    get: (id: number) => DataView
  }
}

interface NavigatorBluetoothWithLEScan {
  requestLEScan: (options: { acceptAllAdvertisements: boolean; active: boolean }) => Promise<BluetoothLEScan>
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
  const { t } = useTranslation()
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
    try {
      const raw = JSON.parse(localStorage.getItem('rf_transfers') || '[]')
      if (!Array.isArray(raw)) return []
      return raw.map((t: WebTransfer) => ({ ...t, blobUrl: undefined, textContent: undefined }))
    } catch { return [] }
  })
  const [dragging, setDragging] = useState(false)
  const [uptime, setUptime] = useState(0)
  const [showQR, setShowQR] = useState(false)
  const [showTextShare, setShowTextShare] = useState(false)
  const [textToSend, setTextToSend] = useState('')
  const [inlineText, setInlineText] = useState('')
  const [showTextPreview, setShowTextPreview] = useState<string | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewType, setPreviewType] = useState<'text' | 'image' | 'pdf' | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [incomingOffer, setIncomingOffer] = useState<{ from: string; sdp: RTCSessionDescriptionInit } | null>(null)
  const [incomingPeerName, setIncomingPeerName] = useState('')
  const [roomOpen, setRoomOpen] = useState(false)
  const [dontShow, setDontShow] = useState(
    () => localStorage.getItem('reflie_guide_done') === '1'
  )

  const abortCtrlRef = useRef<Record<string, AbortController>>({})
  const abortRef = useRef<Record<string, boolean>>({})
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notifiedRef = useRef<Set<string>>(new Set())
  const [fileQueue, setFileQueue] = useState<Array<{file: File; id: string}>>([])
  const processingRef = useRef(false)
  const queueRef = useRef<Array<{file: File; id: string}>>([])
  const fileMapRef = useRef<Map<string, File>>(new Map())

  const cancelTransfer = useCallback((id: string) => {
    abortRef.current[id] = true
    abortCtrlRef.current[id]?.abort()
    setTransfers(prev => {
      const found = prev.find(t => t.id === id)
      if (found?.blobUrl) URL.revokeObjectURL(found.blobUrl)
      return prev.map(t =>
        t.id === id && t.status === 'transferring' ? { ...t, status: 'cancelled', blobUrl: undefined } : t
      )
    })
  }, [])

  const handlePreview = useCallback((url: string, name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
    const textExts = ['txt', 'md', 'json', 'xml', 'yml', 'yaml', 'csv', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'sh', 'ps1', 'rtf']
    if (imgExts.includes(ext)) {
      setPreviewUrl(url); setPreviewType('image'); setPreviewName(name)
    } else if (ext === 'pdf') {
      setPreviewUrl(url); setPreviewType('pdf'); setPreviewName(name)
    } else if (textExts.includes(ext) || name.endsWith('.md')) {
      setPreviewUrl(url); setPreviewType('text'); setPreviewName(name)
    } else {
      setPreviewUrl(url); setPreviewType('text'); setPreviewName(name)
    }
  }, [])

  interface BtDevice { id: string; name: string; connected: boolean; peerId?: string; deviceRef?: BluetoothDevice; fromApp?: boolean }
  const [landing, setLanding] = useState(true)
  const [btDevices, setBtDevices] = useState<BtDevice[]>([])
  const [btScanning, setBtScanning] = useState(false)
  const [bleStatus, setBleStatus] = useState<string | null>(null)
  const [btAutoScan, setBtAutoScan] = useState(false)
  const bleScanRef = useRef<BluetoothLEScan | null>(null)
  const btScanningRef = useRef(false)
  const bleListenerRef = useRef<((e: BluetoothAdvertisingEvent) => void) | null>(null)
  const [qrUrl, setQrUrl] = useState('')
  const [qrError, setQrError] = useState('')
  const [onlinePeers, setOnlinePeers] = useState<Array<{id: string; name: string}>>([])
  const [peerSearch, setPeerSearch] = useState('')

  const stopBtScan = useCallback(async () => {
    btScanningRef.current = false
    setBtScanning(false)
    setBtAutoScan(false)
    try {
      if (bleListenerRef.current) {
        const scan = bleScanRef.current
        if (scan && typeof scan.removeEventListener === 'function') {
          scan.removeEventListener('advertisementreceived', bleListenerRef.current)
        }
        bleListenerRef.current = null
      }
      const scan = bleScanRef.current
      if (scan && typeof scan.stop === 'function') { scan.stop(); bleScanRef.current = null }
    } catch {}
  }, [])

  const startBtScan = useCallback(async () => {
    if (btScanningRef.current) return
    if (!navigator.bluetooth) { setBleStatus(i18n.t('bluetooth.notSupported')); setTimeout(() => setBleStatus(null), 4000); return }
    btScanningRef.current = true
    setBtScanning(true)
    setBleStatus(i18n.t('ble.scanning'))
    try {
      // Try LEScan first (auto-scan without dialog)
      if ((navigator.bluetooth as unknown as NavigatorBluetoothWithLEScan).requestLEScan) {
        const scan = await (navigator.bluetooth as unknown as NavigatorBluetoothWithLEScan).requestLEScan({ acceptAllAdvertisements: true, active: true })
        bleScanRef.current = scan
        setBtAutoScan(true)
        setBleStatus(i18n.t('ble.autoScanList'))
        const handler = (e: BluetoothAdvertisingEvent) => {
          const addr = e.device?.id || e.device?.address || Math.random().toString(36).slice(2, 10)
          // Try to extract name from manufacturer data (desktop app protocol)
          let name = e.device?.name || e.name || e.localName || ''
          let fromApp = false
          if (e.manufacturerData?.has ? e.manufacturerData.has(0xFFFF) : false) {
            const dv: DataView = e.manufacturerData.get(0xFFFF)
            if (dv.byteLength >= 8) {
              const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1))
              if (magic === 'RF') {
                fromApp = true
                const nameLen = Math.min(dv.byteLength - 8, 16)
                const nameBytes = new Uint8Array(dv.buffer, dv.byteOffset + 8, nameLen)
                const dec = new TextDecoder()
                const decodedName = dec.decode(nameBytes).replace(/\0/g, '').trim()
                if (decodedName) name = decodedName
              }
            }
          }
          if (!name) name = i18n.t('ble.unknownDevice', { addr: addr.slice(0, 6) })
          setBtDevices(prev => {
            const existing = prev.find(d => d.id === addr)
            if (existing) return prev.map(d => d.id === addr ? { ...d, name, fromApp } : d)
            return [...prev, { id: addr, name, connected: false, fromApp }]
          })
        }
        bleListenerRef.current = handler
        scan.addEventListener('advertisementreceived', handler)
      } else {
        // Fallback: requestDevice (requires dialog)
        btScanningRef.current = false
        setBtScanning(false)
        const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [] })
        if (device) {
          const id = device.id || Math.random().toString(36).slice(2, 10)
          const name = device.name || i18n.t('ble.fallbackDevice', { id: id.slice(0, 6) })
          setBtDevices(prev => prev.some(d => d.id === id) ? prev.map(d => d.id === id ? { ...d, name, deviceRef: device } : d) : [...prev, { id, name, connected: false, deviceRef: device }])
          setBleStatus(i18n.t('ble.foundDevice', { name }))
          setTimeout(() => setBleStatus(null), 3000)
        }
      }
    } catch (e: unknown) {
      btScanningRef.current = false
      setBtScanning(false)
      if ((e as { name?: string }).name !== 'NotFoundError') setBleStatus(i18n.t('bluetooth.scanFailed', { error: String(e) }))
    }
  }, [])

  const sigRef = useRef<SignalingClient | null>(null)
  const peerRef = useRef<WebRTCPeer | null>(null)
  const receiverRef = useRef(new FileReceiver())
  const connectedRef = useRef(false)
  const connectingRef = useRef(false)
  const speedMap = useRef<Record<string, { bytes: number; ts: number }>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const qrCanvasRef = useRef<HTMLCanvasElement>(null)
  const prevBlobUrlsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    try {
      if (!Array.isArray(transfers)) return
      const clean = transfers.map(t => {
        const rest = { ...t }
        delete rest.blobUrl
        delete rest.textContent
        return rest
      })
      localStorage.setItem('rf_transfers', JSON.stringify(clean))
    } catch {}
  }, [transfers])

  const setupPeer = useCallback((peer: WebRTCPeer) => {
    const receiver = receiverRef.current

    peer.onOpen = () => {
      if (connectTimerRef.current) { clearTimeout(connectTimerRef.current); connectTimerRef.current = null }
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
      // Mark in-progress transfers as failed
      setTransfers(prev => prev.map(t =>
        t.status === 'transferring' ? { ...t, status: 'error', error: i18n.t('connectionInterrupted') } : t
      ))
    }
    peer.onError = (msg) => {
      setConnecting(false)
      connectingRef.current = false
      setSigError(msg)
      setTimeout(() => setSigError(''), 4000)
    }

    const rxMetaMap = new Map<string, { name: string }>()
    peer.onMeta = (meta: FileMeta) => {
      const id = crypto.randomUUID().slice(0, 8)
      rxMetaMap.set(id, { name: meta.name })
      speedMap.current[id] = { bytes: 0, ts: Date.now() }
      receiver.setMeta(meta)
      setTransfers(prev => [...prev, {
        id, name: meta.name, size: meta.size,
        direction: 'receive', progress: 0, speed: 0,
        status: 'transferring', createdAt: new Date().toISOString(),
      }])

      const rxId = id
      receiver.onProgress = (got, total) => {
        setTransfers(prev => prev.map(t => {
          if (t.id !== rxId) return t
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
            t.id === rxId ? { ...t, status: 'done', progress: 1, speed: 0, blobUrl: url, ...extra } : t
          ))
        }
        if (isText) {
          blob.text().then(text => update({ isText: true, textContent: text })).catch(() => {})
        } else {
          update({})
        }
      }
    }
    peer.onChunk = (chunk) => receiver.addChunk(chunk)
  }, [])

  const doConnect = useCallback((localId: string, remoteId: string, client: SignalingClient) => {
    if (remoteId === localId) return
    if (connectedRef.current || connectingRef.current) return
    connectingRef.current = true
    setConnecting(true)
    peerRef.current?.close()

    const peer = new WebRTCPeer(client, remoteId, true)
    peerRef.current = peer
    setupPeer(peer)

    if (connectTimerRef.current) { clearTimeout(connectTimerRef.current) }
    connectTimerRef.current = setTimeout(() => {
      if (!connectedRef.current && connectingRef.current) {
        peerRef.current?.close()
        setConnecting(false)
        connectingRef.current = false
        setSigError(i18n.t('connectionTimeoutLong'))
        peerRef.current = null
        setTimeout(() => setSigError(''), 6000)
      }
    }, 30000) // 30s timeout (ICE can be slow on some networks)

    peer.initiate().catch(e => {
      if (connectTimerRef.current) { clearTimeout(connectTimerRef.current); connectTimerRef.current = null }
      setConnecting(false)
      connectingRef.current = false
      setSigError(i18n.t('connectionError', { error: String(e) }))
      setTimeout(() => setSigError(''), 4000)
    })
  }, [setupPeer])

  const acceptIncoming = useCallback(() => {
    if (!incomingOffer || !sigRef.current) return
    const { from, sdp } = incomingOffer
    if (connectedRef.current || connectingRef.current) return
    connectingRef.current = true
    setConnecting(true)
    setIncomingOffer(null)
    peerRef.current?.close()

    const client = sigRef.current
    const peer = new WebRTCPeer(client, from, false, sdp)
    peerRef.current = peer
    setupPeer(peer)

    if (connectTimerRef.current) { clearTimeout(connectTimerRef.current) }
    connectTimerRef.current = setTimeout(() => {
      if (!connectedRef.current && connectingRef.current) {
        peerRef.current?.close()
        setConnecting(false)
        connectingRef.current = false
        setSigError(i18n.t('connectionTimeout'))
        peerRef.current = null
        setTimeout(() => setSigError(''), 6000)
      }
    }, 30000)
  }, [incomingOffer, setupPeer])

  const rejectIncoming = useCallback(() => {
    setIncomingOffer(null)
    setIncomingPeerName('')
  }, [])

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
            const peers = msg.peers as Array<{ id: string; name: string }>
            const others = peers.filter(p => p.id !== id)
            setOnlinePeers(others)
            // Update BLE devices: match by name and set peerId
            setBtDevices(prev => Array.isArray(prev) ? prev.map(d => {
              const byPeer = others.find(p => p.id === d.peerId)
              if (byPeer) return { ...d, name: byPeer.name || d.name }
              const byName = others.find(p => p.name === d.name)
              if (byName) return { ...d, peerId: byName.id }
              return d
            }) : [])
          }
        } catch {}
      })

      // Register incoming offer handler — show accept modal instead of auto-connecting
      client.addSignalHandler((from, rawData) => {
        const msg = rawData as Record<string, unknown>
        if (msg.type === 'offer') {
          if (connectedRef.current || connectingRef.current) return
          const name = (msg.name as string) || from
          setIncomingPeerName(name)
          setIncomingOffer({ from, sdp: msg.sdp as RTCSessionDescriptionInit })
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
      if (connectTimerRef.current) clearTimeout(connectTimerRef.current)
      client.disconnect()
      peerRef.current?.close()
    }
  }, [doConnect])

  const handleConnect = () => {
    const id = inputId.replace(/[^A-Fa-f0-9]/g, '').toUpperCase().slice(0, 8)
    if (id.length !== 8 || !sigRef.current || !peerId) return
    doConnect(peerId, id, sigRef.current)
  }

  const handleDisconnect = () => {
    if (connectTimerRef.current) { clearTimeout(connectTimerRef.current); connectTimerRef.current = null }
    peerRef.current?.close()
  }

  useEffect(() => {
    if (!connected) { setUptime(0); return }
    const iv = setInterval(() => setUptime(u => u + 1), 1000)
    return () => clearInterval(iv)
  }, [connected])

  const processQueue = useCallback(async () => {
    if (processingRef.current) return
    const peer = peerRef.current
    if (!peer?.isOpen()) return
    const q = queueRef.current
    if (q.length === 0) { processingRef.current = false; return }
    processingRef.current = true
    const { file, id } = q.shift()!
    queueRef.current = q
    setFileQueue([...q])
    abortRef.current[id] = false
    const ctrl = new AbortController()
    abortCtrlRef.current[id] = ctrl
    speedMap.current[id] = { bytes: 0, ts: Date.now() }
    let blobUrl: string | undefined
    try {
      blobUrl = URL.createObjectURL(file)
      setTransfers(prev => prev.map(t => t.id === id ? { ...t, status: 'transferring', progress: 0, speed: 0, blobUrl, error: undefined } : t))
      if (abortRef.current[id]) throw new Error(i18n.t('transfer.cancelled'))
      await peer.sendFile(file, (sent, total) => {
        if (abortRef.current[id]) return
        setTransfers(prev => prev.map(t => {
          if (t.id !== id) return t
          const tr = speedMap.current[id]
          let speed = 0
          if (tr) {
            const dt = (Date.now() - tr.ts) / 1000
            if (dt > 0.2) { speed = (sent - tr.bytes) / dt; speedMap.current[id] = { bytes: sent, ts: Date.now() } }
          }
          return { ...t, progress: sent / total, speed }
        }))
      }, ctrl.signal)
      if (!abortRef.current[id]) {
        setTransfers(prev => prev.map(t => t.id === id ? { ...t, status: 'done', progress: 1, speed: 0 } : t))
      }
    } catch (e) {
      const err = String(e)
      if (abortRef.current[id]) {
        setTransfers(prev => {
          const found = prev.find(t => t.id === id)
          if (found?.blobUrl) URL.revokeObjectURL(found.blobUrl)
          return prev.map(t => t.id === id ? { ...t, status: 'cancelled', error: i18n.t('transfer.cancelled'), blobUrl: undefined } : t)
        })
      } else {
        setTransfers(prev => {
          if (blobUrl) URL.revokeObjectURL(blobUrl)
          return prev.map(t => t.id === id ? { ...t, status: 'error', error: err, blobUrl: undefined } : t)
        })
      }
    }
    fileMapRef.current.delete(id)
    processingRef.current = false
    processQueue()
  }, [])

  const sendFiles = useCallback((files: File[]) => {
    const peer = peerRef.current
    if (!peer?.isOpen()) {
      setSigError(i18n.t('transfer.channelNotOpen'))
      setTimeout(() => setSigError(''), 3000)
      return
    }
    const entries = files.map(file => {
      const id = crypto.randomUUID().slice(0, 8)
      fileMapRef.current.set(id, file)
      setTransfers(prev => [...prev, {
        id, name: file.name, size: file.size,
        direction: 'send', progress: 0, speed: 0,
        status: 'paused', createdAt: new Date().toISOString(),
      }])
      return { file, id }
    })
    queueRef.current.push(...entries)
    setFileQueue([...queueRef.current])
    if (!processingRef.current) processQueue()
  }, [processQueue])

  useEffect(() => {
    if (!('Notification' in window)) return
    if (Notification.permission === 'denied') return
    if (Notification.permission === 'default') { Notification.requestPermission().then(p => { if (p !== 'granted') return }).catch(() => {}) }
    const newDone = transfers.filter(t => t.status === 'done' && t.direction === 'receive' && !notifiedRef.current.has(t.id))
    newDone.forEach(t => {
      try {
        new Notification('re/file', { body: i18n.t('notification.received', { name: t.name }) })
        notifiedRef.current.add(t.id)
      } catch {}
    })
  }, [transfers])

  const handleSendText = useCallback(() => {
    if (!connected || !textToSend.trim()) return
    const blob = new Blob([textToSend], { type: 'text/plain' })
    const file = new File([blob], i18n.t('transfer.filename.text'))
    sendFiles([file])
    setTextToSend('')
    setShowTextShare(false)
  }, [connected, textToSend, sendFiles])

  const pauseTransfer = useCallback((id: string) => {
    abortRef.current[id] = true
    abortCtrlRef.current[id]?.abort()
    const q = queueRef.current
    const idx = q.findIndex(e => e.id === id)
    if (idx >= 0) return
    const file = fileMapRef.current.get(id)
    if (file) {
      queueRef.current.push({ file, id })
      setFileQueue([...queueRef.current])
    }
    setTransfers(prev => prev.map(x => x.id === id ? { ...x, status: 'paused', error: undefined, blobUrl: undefined } : x))
  }, [])

  const resumeTransfer = useCallback((id: string) => {
    const existing = queueRef.current.find(e => e.id === id)
    if (existing) return
    const file = fileMapRef.current.get(id)
    if (!file) return
    queueRef.current.push({ file, id })
    setFileQueue([...queueRef.current])
    if (!processingRef.current) processQueue()
  }, [processQueue])

  const moveQueueItem = useCallback((id: string, dir: 'up' | 'down') => {
    const q = [...queueRef.current]
    const idx = q.findIndex(e => e.id === id)
    if (idx < 0) return
    const target = dir === 'up' ? idx - 1 : idx + 1
    if (target < 0 || target >= q.length) return
    ;[q[idx], q[target]] = [q[target], q[idx]]
    queueRef.current = q
    setFileQueue(q)
  }, [])

  // Revoke stale blob URLs to prevent memory leaks
  useEffect(() => {
    const current = new Set<string>()
    transfers.forEach(t => { if (t.blobUrl) current.add(t.blobUrl) })
    prevBlobUrlsRef.current.forEach(url => {
      if (!current.has(url)) URL.revokeObjectURL(url)
    })
    prevBlobUrlsRef.current = current
  }, [transfers])

  const sendText = useCallback((text: string) => {
    if (!connected || !text.trim()) return
    const blob = new Blob([text], { type: 'text/plain' })
    const file = new File([blob], i18n.t('transfer.filename.text'))
    sendFiles([file])
  }, [connected, sendFiles])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    if (!connected) return
    sendFiles(Array.from(e.dataTransfer.files))
  }, [connected, sendFiles])

  const handleCopyId = () => {
    navigator.clipboard.writeText(fmtPeer(peerId)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
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
      setQrError(i18n.t('qr.generateError', { error: String(err) }))
    })
  }, [showQR, qrUrl])

  const handleShowQR = () => {
    if (!peerId) {
      setQrError(i18n.t('qr.error'))
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
      navigator.share({ title: i18n.t('share.title'), url })
    } else {
      navigator.clipboard.writeText(url).then(() => {
        setCopiedLink(true)
        setTimeout(() => setCopiedLink(false), 2000)
      })
    }
  }

  const sends = (Array.isArray(transfers) ? transfers : []).filter(t => t.direction === 'send')
  const receives = (Array.isArray(transfers) ? transfers : []).filter(t => t.direction === 'receive')
  const totalData = [...sends, ...receives].reduce((a, t) => a + t.size, 0)

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!connected || !peerRef.current?.isOpen()) return
    const files: File[] = []
    if (e.clipboardData.files.length > 0) {
      for (let i = 0; i < e.clipboardData.files.length; i++) {
        files.push(e.clipboardData.files[i])
      }
    }
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      const item = e.clipboardData.items[i]
      if (item.type === 'image/png' || item.type === 'image/jpeg' || item.type === 'image/gif' || item.type === 'image/webp') {
        const blob = item.getAsFile()
        if (blob) files.push(blob)
      } else if (item.type === 'text/plain') {
        item.getAsString(text => {
          if (text.trim()) {
            const blob = new Blob([text], { type: 'text/plain' })
            const f = new File([blob], 'pasted-text.txt')
            sendFiles([f])
          }
        })
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      sendFiles(files)
    }
  }, [connected, sendFiles])

  // ── Landing page ──
  if (landing) {
    return (
      <div className="webapp-root">
        <header className="wl-header">
          <div className="wl-header-inner">
            <span className="wl-logo">re/<span>file</span></span>
            <nav className="wl-nav">
               <a href="#" onClick={e => { e.preventDefault(); setLanding(false) }} aria-label={t('landing.start')}>{t('landing.start')}</a>
               <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer" aria-label={t('footer.mit')}>{t('footer.mit')}</a>
              <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer" aria-label={t('footer.github')}>{t('footer.github')}</a>
              <a href="#docs" aria-label={t('panel.docs')}>{t('panel.docs')}</a>
            </nav>
            <label className="main-toggle" style={{ marginLeft: 'auto' }} aria-label={darkMode ? t('topbar.theme.light') : t('topbar.theme.dark')}>
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
                <div className="wl-canvas-inner">
                  <div className="wl-icon-row">
                    <div className="wl-icon-btn wl-icon-btn-sm circle-1">
                      <svg className="wl-icon-svg wl-icon-svg-sm" viewBox="0 0 512 512" clip-rule="evenodd" fill-rule="evenodd" image-rendering="optimizeQuality" text-rendering="geometricPrecision" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg">
                        <rect ry="105.042" rx="104.187" height="512" width="512" fill="#CC9B7A"></rect>
                        <path d="M318.663 149.787h-43.368l78.952 212.423 43.368.004-78.952-212.427zm-125.326 0l-78.952 212.427h44.255l15.932-44.608 82.846-.004 16.107 44.612h44.255l-79.126-212.427h-45.317zm-4.251 128.341l26.91-74.701 27.083 74.701h-53.993z" fill-rule="nonzero" fill="#1F1F1E"></path>
                      </svg>
                    </div>
                    <div className="wl-icon-btn wl-icon-btn-md circle-2">
                      <svg xmlns="http://www.w3.org/2000/svg" className="wl-icon-svg wl-icon-svg-md" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9.75 14a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 .75-.75Zm4.5 0a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 .75-.75Z"></path>
                        <path d="M12 2c2.214 0 4.248.657 5.747 1.756.136.099.268.204.397.312.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086l.633 1.478.043.022A4.75 4.75 0 0 1 24 15.222v1.028c0 .529-.309.987-.565 1.293-.28.336-.636.653-.966.918a13.84 13.84 0 0 1-1.299.911l-.024.015-.006.004-.039.025c-.223.135-.45.264-.68.386-.46.245-1.122.571-1.941.895C16.845 21.344 14.561 22 12 22c-2.561 0-4.845-.656-6.479-1.303a19.046 19.046 0 0 1-1.942-.894 14.081 14.081 0 0 1-.535-.3l-.144-.087-.04-.025-.006-.004-.024-.015a13.16 13.16 0 0 1-1.299-.911 6.913 6.913 0 0 1-.967-.918C.31 17.237 0 16.779 0 16.25v-1.028a4.75 4.75 0 0 1 2.626-4.248l.043-.022.633-1.478a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.498 1.132-3.368.397-.406.89-.717 1.474-.952.129-.108.261-.213.397-.312C7.752 2.657 9.786 2 12 2Zm-8 9.654v6.669a17.59 17.59 0 0 0 2.073.98C7.595 19.906 9.686 20.5 12 20.5c2.314 0 4.405-.594 5.927-1.197a17.59 17.59 0 0 0 2.073-.98v-6.669l-.038-.09c-.046.061-.095.12-.145.177-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.544-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.344a4.323 4.323 0 0 1-.355.508C10.704 12.456 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a3.026 3.026 0 0 1-.145-.177Zm6.309-1.092c.445-.547.708-1.334.851-2.301.057-.357.087-.718.09-1.079v-.031c-.001-.762-.166-1.26-.43-1.568l-.008-.01c-.341-.391-1.046-.689-2.533-.529-1.505.163-2.347.537-2.824 1.024-.462.473-.705 1.18-.705 2.32 0 .605.044 1.087.135 1.472.092.384.231.672.423.89.365.413 1.084.75 2.657.75.91 0 1.527-.223 1.964-.564.14-.11.268-.235.38-.374Zm2.504-2.497c.136 1.057.403 1.913.878 2.497.442.545 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.151.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.318-.862-2.824-1.025-1.487-.161-2.192.139-2.533.529-.268.308-.437.808-.438 1.578v.02c.002.299.023.598.063.894Z"></path>
                      </svg>
                    </div>
                    <div className="wl-icon-btn wl-icon-btn-lg circle-3">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 28 28" className="wl-icon-svg wl-icon-svg-lg">
                        <path fill="currentColor" d="M26.153 11.46a6.888 6.888 0 0 0-.608-5.73 7.117 7.117 0 0 0-3.29-2.93 7.238 7.238 0 0 0-4.41-.454 7.065 7.065 0 0 0-2.41-1.742A7.15 7.15 0 0 0 12.514 0a7.216 7.216 0 0 0-4.217 1.346 7.061 7.061 0 0 0-2.603 3.539 7.12 7.12 0 0 0-2.734 1.188A7.012 7.012 0 0 0 .966 8.268a6.979 6.979 0 0 0 .88 8.273 6.89 6.89 0 0 0 .607 5.729 7.117 7.117 0 0 0 3.29 2.93 7.238 7.238 0 0 0 4.41.454 7.061 7.061 0 0 0 2.409 1.742c.92.404 1.916.61 2.923.604a7.215 7.215 0 0 0 4.22-1.345 7.06 7.06 0 0 0 2.605-3.543 7.116 7.116 0 0 0 2.734-1.187 7.01 7.01 0 0 0 1.993-2.196 6.978 6.978 0 0 0-.884-8.27Zm-10.61 14.71c-1.412 0-2.505-.428-3.46-1.215.043-.023.119-.064.168-.094l5.65-3.22a.911.911 0 0 0 .464-.793v-7.86l2.389 1.36a.087.087 0 0 1 .046.065v6.508c0 2.952-2.491 5.248-5.257 5.248ZM4.062 21.354a5.17 5.17 0 0 1-.635-3.516c.042.025.115.07.168.1l5.65 3.22a.928.928 0 0 0 .928 0l6.898-3.93v2.72a.083.083 0 0 1-.034.072l-5.711 3.255a5.386 5.386 0 0 1-4.035.522 5.315 5.315 0 0 1-3.23-2.443ZM2.573 9.184a5.283 5.283 0 0 1 2.768-2.301V13.515a.895.895 0 0 0 .464.793l6.897 3.93-2.388 1.36a.087.087 0 0 1-.08.008L4.52 16.349a5.262 5.262 0 0 1-2.475-3.185 5.192 5.192 0 0 1 .527-3.98Zm19.623 4.506-6.898-3.93 2.388-1.36a.087.087 0 0 1 .08-.008l5.713 3.255a5.28 5.28 0 0 1 2.054 2.118 5.19 5.19 0 0 1-.488 5.608 5.314 5.314 0 0 1-2.39 1.742v-6.633a.896.896 0 0 0-.459-.792Zm2.377-3.533a7.973 7.973 0 0 0-.168-.099l-5.65-3.22a.93.93 0 0 0-.928 0l-6.898 3.93V8.046a.083.083 0 0 1 .034-.072l5.712-3.251a5.375 5.375 0 0 1 5.698.241 5.262 5.262 0 0 1 1.865 2.28c.39.92.506 1.93.335 2.913ZM9.631 15.009l-2.39-1.36a.083.083 0 0 1-.046-.065V7.075c.001-.997.29-1.973.832-2.814a5.297 5.297 0 0 1 2.231-1.935 5.382 5.382 0 0 1 5.659.72 4.89 4.89 0 0 0-.168.093l-5.65 3.22a.913.913 0 0 0-.465.793l-.003 7.857Zm1.297-2.76L14 10.5l3.072 1.75v3.5L14 17.499l-3.072-1.75v-3.5Z"></path>
                      </svg>
                    </div>
                    <div className="wl-icon-btn wl-icon-btn-md circle-4">
                      <svg className="wl-icon-svg wl-icon-svg-md" viewBox="0 0 287.56 191" xmlns="http://www.w3.org/2000/svg">
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
                    <div className="wl-icon-btn wl-icon-btn-sm circle-5">
                      <svg className="wl-icon-svg wl-icon-svg-sm" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none">
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
                  <div className="wl-glow-line">
                    <div className="wl-eq-wrap">
                      <div className="wl-eq">
                        <span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span><span className="wl-bar"></span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <p className="wl-card-title">{t('landing.title')}</p>
              <p className="wl-card-desc">{t('landing.desc')}</p>
            </div>
            <div className="wl-cta">
              <button className="wl-enter-btn" onClick={() => setLanding(false)} aria-label={t('landing.startApp')}>
                {t('landing.startApp')}
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
            <button className="topbar-btn" onClick={() => setDarkMode(d => !d)} aria-label={darkMode ? t('topbar.theme.light') : t('topbar.theme.dark')}>
              {darkMode
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
            </button>
          </div>
        </div>
        <div className="webapp-static-body">
          <div className="webapp-static-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </div>
          <h2 className="webapp-static-title">{t('static.title')}</h2>
          <p className="webapp-static-desc">{t('static.desc')}</p>
          <div className="webapp-static-btns">
            <a href="#download" className="webapp-static-btn-primary"
              onClick={e => { e.preventDefault(); window.location.hash = '#download'; window.location.reload() }}
              aria-label={t('static.download')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              {t('static.download')}
            </a>
            <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer"
              className="webapp-static-btn-ghost" aria-label={t('footer.github')}>
              {t('static.github')}
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
            <p>{t('loading.title')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="webapp-root" onPaste={handlePaste}>
      {/* ── Topbar ── */}
      <div className="topbar">
        <div className="topbar-left">
          <button className="topbar-blob" onClick={() => setShowGuide(true)} title={t('topbar.guide')} aria-label={t('topbar.guide')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          </button>
          <span className="webapp-wordmark" aria-label={t('app.brandLabel')}>re/<span>file</span></span>
        </div>
        <div className="topbar-right">
          <button className="topbar-btn" title={connected ? t('topbar.sendText') : ''}
            onClick={() => { if (connected) setShowTextShare(true) }}
            style={{ opacity: connected ? 1 : 0.35 }}
            disabled={!connected}
            aria-label={connected ? t('topbar.sendText') : ''}
            aria-disabled={!connected}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
          </button>
          <button className="topbar-btn" title={t('topbar.downloadDesktop')} aria-label={t('topbar.downloadDesktop')}
            onClick={() => window.open(location.pathname + '#download', '_blank')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
          <label className="main-toggle" aria-label={darkMode ? t('topbar.theme.light') : t('topbar.theme.dark')}>
            <input type="checkbox" className="main-checkbox" checked={darkMode} onChange={() => setDarkMode(d => !d)} />
            <div className="main-track"></div>
            <div className="main-knob"></div>
          </label>
        </div>
      </div>

      <main className="webapp-main">
        <div className="webapp-bg"></div>
        <div className="webapp-main-scroll">
          <div className="webapp-layout-inner">
          <div className="webapp-main-center">

            {/* My ID */}
            <div className="wc-section">
              <span className="wc-label">{t('myid.label')}</span>
              {sigOk ? (
                <>
                  <span className="wc-id">{fmtPeer(peerId)}</span>
                  <div className="wc-btns">
                    <button className="wc-btn" onClick={handleCopyId} title={t('myid.copy')} aria-label={t('myid.copy')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      {copied ? t('myid.copied') : t('myid.copy')}
                    </button>
                    <button className="wc-btn" onClick={handleShowQR} title={t('myid.qr')} aria-label={t('myid.qr')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="4" height="4"/></svg>
                      {t('myid.qr')}
                    </button>
                    <button className="wc-btn" onClick={handleShareLink} title={t('myid.shareLink')} aria-label={t('myid.shareLink')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                       {t('myid.shareLink')}
                    </button>
                  </div>
                </>
              ) : sigError ? (
                <span className="wc-err">{sigError}</span>
              ) : (
                <span className="wc-muted">{t('myid.fetching')}</span>
              )}
            </div>

            {/* Room / Invite */}
            {sigOk && (
              <div className="wc-section">
                <button className="room-toggle" onClick={() => setRoomOpen(r => !r)} aria-expanded={roomOpen}>
                  <span>{t('room.title')}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: roomOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {roomOpen && (
                  <div className="room-card">
                    <p className="room-url">{location.origin}{location.pathname}?peer={peerId}</p>
                    <div className="wc-btns">
                      <button className="wc-btn" onClick={() => { navigator.clipboard.writeText(`${location.origin}${location.pathname}?peer=${peerId}`); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000) }} aria-label={t('room.copyLink')}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        {copiedLink ? t('room.copiedLink') : t('room.copyLink')}
                      </button>
                      <button className="wc-btn" onClick={handleShowQR} aria-label={t('room.qrCode')}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="4" height="4"/></svg>
                        {t('room.qrCode')}
                      </button>
                      {navigator.share && (
                        <button className="wc-btn" onClick={handleShareLink} aria-label={t('room.share')}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                           {t('room.share')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Connect */}
            <div className="wc-section">
              <span className="wc-label">{t('connect.label')}</span>
              {connected ? (
                <div className="wc-connected">
                  <span className="status-dot-indicator green" />
                  <span className="wc-remote-id">{fmtPeer(remotePeerId)}</span>
                  <button className="wc-disc-btn" onClick={handleDisconnect} aria-label={t('common.disconnect')}>{t('common.disconnect')}</button>
                </div>
              ) : (
                <div className="wc-connect-form">
                  <input className="wc-input"
                    placeholder={t('connect.placeholder')}
                    value={inputId}
                    onChange={e => setInputId(e.target.value.toUpperCase().replace(/[^A-F0-9-]/g, ''))}
                    onKeyDown={e => e.key === 'Enter' && handleConnect()}
                    maxLength={9}
                    disabled={connecting || !sigOk}
                    aria-label={t('connect.placeholder')}
                    aria-disabled={connecting || !sigOk}
                  />
                  <button className="wc-go-btn" onClick={handleConnect}
                    disabled={connecting || !sigOk || inputId.replace('-', '').length < 8}
                    aria-label={t('common.connect')}
                    aria-disabled={connecting || !sigOk || inputId.replace('-', '').length < 8}>
                    {connecting ? '…' : t('common.connect')}
                  </button>
                </div>
              )}
              {connecting && <span className="wc-connecting"><span className="wc-connecting-spinner"></span>{t('connect.connecting')}</span>}
              {sigError && <span className="wc-err" role="alert">{sigError}</span>}
            </div>

            {/* Online peers */}
            {(Array.isArray(onlinePeers) && onlinePeers.length > 0) && (
              <div className="wc-section wc-online">
                <span className="wc-label">{t('online.title')} ({onlinePeers.length})</span>
                <input className="wc-peer-search" placeholder={t('online.search')} aria-label={t('online.search')}
                  value={peerSearch} onChange={e => setPeerSearch(e.target.value.toUpperCase())}
                  maxLength={20} />
                <div className="wc-peer-list">
                  {(Array.isArray(onlinePeers) ? onlinePeers : [])
                    .filter(p => {
                      if (!peerSearch) return true
                      const q = peerSearch.toUpperCase()
                      return p.id.includes(q) || (p.name || '').toUpperCase().includes(q)
                    })
                    .slice(0, 20).map(p => (
                    <button key={p.id} className={`wc-peer-chip ${connected && remotePeerId === p.id ? 'wc-peer-active' : ''}`}
                      onClick={() => { if (!connected && !connecting && sigRef.current) { setInputId(p.id); doConnect(peerId, p.id, sigRef.current) } }}
                      disabled={connected || connecting}
                      aria-label={t('online.connectTo', { name: p.name || fmtPeer(p.id) })}
                      aria-disabled={connected || connecting}>
                      {p.name || fmtPeer(p.id)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Favorite Contacts */}
            <Contacts onConnect={(id) => {
              if (!connected && !connecting && sigRef.current) {
                setInputId(id);
                doConnect(peerId, id, sigRef.current);
              }
            }} />

            {/* Tech badges */}
            <div className="webapp-tech">
              <span className="webapp-tech-pill">{t('tech.webrtc')}</span>
              <span className="webapp-tech-pill">{t('tech.websocket')}</span>
              <span className="webapp-tech-pill">{t('tech.p2p')}</span>
            </div>

            {/* Bluetooth scan */}
            <div className="wc-section">
              <span className="wc-label">{t('bluetooth.scan')}</span>
              <div className="bt-scan-bar">
                <button className="bt-scan-btn" onClick={btScanning ? stopBtScan : startBtScan}
                  disabled={!sigOk || connected || connecting}
                  aria-label={btScanning ? t('bluetooth.stop') : t('bluetooth.scan')}
                  aria-disabled={!sigOk || connected || connecting}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.71 7.71L12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z"/>
                  </svg>
                  {btScanning ? (btAutoScan ? t('bluetooth.scanning') : t('bluetooth.stop')) : t('bluetooth.scan')}
                </button>
                {btScanning && (
                  <button className="bt-clear-btn" onClick={() => setBtDevices([])} aria-label={t('bluetooth.clear')}>
                    {t('bluetooth.clear')}
                  </button>
                )}
              </div>
              {bleStatus && <span className="wc-muted" style={{fontSize:12,marginTop:4,display:'block'}}>{bleStatus}</span>}
              {btAutoScan && (
                <span className="wc-muted" style={{fontSize:11,marginTop:2,display:'block',color:'var(--text-dim)'}}>
                  {t('bluetooth.autoScan')}
                </span>
              )}
              {Array.isArray(btDevices) && btDevices.length > 0 && (
                <div className="bt-device-list">
                  {btDevices.map(d => {
                    const matchedPeer = Array.isArray(onlinePeers) ? onlinePeers.find(p => p.name === d.name) : null
                    return (
                    <div key={d.id} className={`bt-device-item ${d.connected ? 'bt-connected' : ''}`}>
                      <span className="bt-device-icon">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M17.71 7.71L12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z"/>
                        </svg>
                      </span>
                      <span className="bt-device-name">{d.name}</span>
                      {d.fromApp && <span className="bt-device-badge">{t('bluetooth.badge')}</span>}
                      {matchedPeer && !connected && !connecting && (
                        <button className="bt-connect-btn" onClick={() => { if (sigRef.current) { setInputId(matchedPeer.id); doConnect(peerId, matchedPeer.id, sigRef.current) } }} aria-label={t('online.connectTo', { name: d.name })}>
                          {t('bluetooth.connect')}
                        </button>
                      )}
                    </div>
                    )
                  })}
                </div>
              )}
              {!btScanning && Array.isArray(btDevices) && btDevices.length === 0 && (
                <span className="wc-muted" style={{fontSize:12}}>{t('bluetooth.noDevices')}</span>
              )}
            </div>

            {/* Connection Dashboard */}
            {connected && (
              <div className="webapp-dash">
                <div className="webapp-dash-row">
                  <div className="webapp-dash-card">
                    <span className="webapp-dash-label">{t('dashboard.uptime')}</span>
                    <span className="webapp-dash-value accent">{uptime}s</span>
                  </div>
                  <div className="webapp-dash-card">
                    <span className="webapp-dash-label">{t('dashboard.encryption')}</span>
                    <span className="webapp-dash-value green">{t('dashboard.encryptionValue')}</span>
                  </div>
                  <div className="webapp-dash-card">
                    <span className="webapp-dash-label">{t('dashboard.transferVolume')}</span>
                    <span className="webapp-dash-value">{fmtSize(sends.reduce((a, t) => a + t.size, 0))} ↑ / {fmtSize(receives.reduce((a, t) => a + t.size, 0))} ↓</span>
                  </div>
                </div>
                <div className="webapp-dash-actions">
                  <button className="webapp-dash-btn" onClick={() => setShowTextShare(true)} aria-label={t('topbar.sendText')}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                    {t('topbar.sendText')}
                  </button>
                  <button className="webapp-dash-btn invite" onClick={handleShareLink} aria-label={t('connect.inviteOthers')}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    {t('connect.inviteOthers')}
                  </button>
                </div>
              </div>
            )}

            {/* Drop zone */}
            {connected ? (
              <div className="file-upload-form">
                {/* Inline text send bar */}
                <div className="text-send-bar">
                  <input className="text-send-input"
                    placeholder={t('dropzone.placeholderSend')}
                    value={inlineText}
                    onChange={e => setInlineText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && inlineText.trim()) {
                        e.preventDefault()
                        sendText(inlineText)
                        setInlineText('')
                      }
                    }}
                    aria-label={t('dropzone.placeholderSendLabel')}
                  />
                  <button className="text-send-btn" onClick={() => {
                    if (inlineText.trim()) {
                      sendText(inlineText)
                      setInlineText('')
                    }
                  }} disabled={!inlineText.trim()} aria-label={t('dropzone.sendTooltip')} aria-disabled={!inlineText.trim()}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
                <label className={"file-upload-label" + (dragging ? ' wc-upload-dragging' : '')}
                  onDragOver={e => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  aria-label={t('dropzone.connectedTitle')}
                  tabIndex={0}
                >
                  <input ref={fileInputRef} type="file" multiple hidden
                    onChange={e => { if (e.target.files) { sendFiles(Array.from(e.target.files)); e.target.value = '' } }} />
                  <div className="file-upload-design">
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
                    </svg>
                    <p>{t('dropzone.connectedTitle')}</p>
                    <p>{t('dropzone.or')}</p>
                    <span className="browse-button" onClick={() => fileInputRef.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }} role="button" tabIndex={0} aria-label={t('dropzone.browse')}>{t('dropzone.browse')}</span>
                  </div>
                </label>
                <button className="dz-text-btn" onClick={() => setShowTextShare(true)} aria-label={t('dropzone.textEditor')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                  </svg>
                  {t('dropzone.textEditor')}
                </button>
              </div>
            ) : sigOk ? (
              <div className="webapp-idle">
                <div className="webapp-idle-steps">
                  <div className="webapp-idle-step">
                    <span className="webapp-idle-num">1</span>
                    <span>{t('idle.step1')}</span>
                  </div>
                  <div className="webapp-idle-step">
                    <span className="webapp-idle-num">2</span>
                    <span>{t('idle.step2')}</span>
                  </div>
                  <div className="webapp-idle-step">
                    <span className="webapp-idle-num">3</span>
                    <span>{t('idle.step3')}</span>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Quick tips when connected but idle */}
            {connected && transfers.length === 0 && (
              <div className="webapp-tips">
                <div className="webapp-tips-header">{t('tips.title')}</div>
                <div className="webapp-tips-list">
                  <div className="webapp-tips-item">{t('tips.batchDrop')}</div>
                  <div className="webapp-tips-item">{t('tips.noServer')}</div>
                  <div className="webapp-tips-item">{t('tips.pasteImage')}</div>
                  <div className="webapp-tips-item">{t('tips.bleScan')}</div>
                </div>
              </div>
            )}

            {/* Transfer history */}
            {transfers.length > 0 && (
              <div className="webapp-history-section">
                <div className="webapp-history-header">
                  <span>{t('history.title')}</span>
                  <button className="webapp-history-clear" onClick={() => {
                    setTransfers([])
                    setFileQueue([])
                    queueRef.current = []
                    fileMapRef.current.clear()
                  }} aria-label={t('history.clear')}>{t('history.clear')}</button>
                </div>
                <div className="webapp-history-inner">
                  <div className="webapp-history-col">
                    <div className="webapp-col-title">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/></svg>
                      {t('history.sent')} <span className="webapp-col-count">{sends.length}</span>
                    </div>
                    {sends.length === 0 && <div className="webapp-col-empty">{t('history.emptySent')}</div>}
                    {[...sends].reverse().map(t => {
                      const qIdx = fileQueue.findIndex(e => e.id === t.id)
                      return (
                        <TxItem key={t.id} t={t}
                          onCancel={() => cancelTransfer(t.id)}
                          onPause={t.status === 'transferring' ? () => pauseTransfer(t.id) : undefined}
                          onResume={t.status === 'paused' ? () => resumeTransfer(t.id) : undefined}
                          onMoveUp={qIdx > 0 ? () => moveQueueItem(t.id, 'up') : undefined}
                          onMoveDown={qIdx >= 0 && qIdx < fileQueue.length - 1 ? () => moveQueueItem(t.id, 'down') : undefined}
                        />
                      )
                    })}
                  </div>
                  <div className="webapp-history-col">
                    <div className="webapp-col-title">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                      {t('history.received')} <span className="webapp-col-count">{receives.length}</span>
                    </div>
                    {receives.length === 0 && <div className="webapp-col-empty">{t('history.emptyReceived')}</div>}
                    {[...receives].reverse().map(t => <TxItem key={t.id} t={t} onViewText={(text) => setShowTextPreview(text)} onCancel={() => cancelTransfer(t.id)} onPreview={(url, name) => handlePreview(url, name)} />)}
                  </div>
                </div>
              </div>
            )}
          </div>

          <aside className="webapp-doc-panel">
            {/* Transfer Stats */}
            <div className="dp-card">
              <div className="dp-card-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                {t('panel.stats')}
              </div>
              <div className="dp-stats-row">
                <div className="dp-stat">
                  <span className="dp-stat-value">{sends.filter(t => t.status === 'done').length}</span>
                  <span className="dp-stat-label">{t('panel.sent')}</span>
                </div>
                <div className="dp-stat">
                  <span className="dp-stat-value">{receives.filter(t => t.status === 'done').length}</span>
                  <span className="dp-stat-label">{t('panel.received')}</span>
                </div>
                <div className="dp-stat">
                  <span className="dp-stat-value">{fmtSize(totalData)}</span>
                  <span className="dp-stat-label">{t('panel.total')}</span>
                </div>
              </div>
            </div>

            {/* Network Status */}
            <div className="dp-section">
              <div className="dp-section-header">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                {t('panel.network')}
              </div>
              <div className="dp-item">
                <span className={`status-dot-indicator ${sigOk ? (connected ? 'green' : 'yellow') : 'red'}`} />
                {t('panel.signalServer')}: {sigOk ? (connected ? t('panel.connected') : t('panel.pending')) : t('panel.disconnected')}
              </div>
              <div className="dp-item">
                <span className={`status-dot-indicator ${connected ? 'green' : 'red'}`} />
                {t('panel.p2pChannel')}: {connected ? t('panel.connectedWithTime', { time: uptime }) : t('panel.disconnected')}
              </div>
              <div className="dp-item">
                <span className={`status-dot-indicator ${sigOk ? 'green' : 'red'}`} />
                {t('panel.peerId')}: {sigOk ? fmtPeer(peerId) : '—'}
              </div>
            </div>

            {/* Security */}
            <div className="dp-section">
              <div className="dp-section-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                {t('panel.security')}
              </div>
              <div className="dp-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                {t('panel.security.e2e')}
              </div>
              <div className="dp-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                {t('panel.security.direct')}
              </div>
              <div className="dp-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                {t('panel.security.noCache')}
              </div>
              <div className="dp-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                {t('panel.security.openSource')}
              </div>
            </div>

            {/* Shortcuts */}
            <div className="dp-section">
              <div className="dp-section-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                {t('panel.shortcuts')}
              </div>
              <div className="dp-item"><span className="dp-item-dot" />{t('panel.shortcut.paste')}</div>
              <div className="dp-item"><span className="dp-item-dot" />{t('panel.shortcut.enter')}</div>
              <div className="dp-item"><span className="dp-item-dot" />{t('panel.shortcut.batch')}</div>
              <div className="dp-item"><span className="dp-item-dot" />{t('panel.shortcut.ble')}</div>
            </div>

            {/* Links */}
            <div className="dp-section">
              <div className="dp-section-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                {t('panel.links')}
              </div>
              <div className="dp-community">
                <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer" className="dp-link-btn" aria-label={t('panel.github')}>
                  <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                  {t('panel.github')}
                </a>
                <a href="https://github.com/huchialun9-ctrl/refile/issues" target="_blank" rel="noopener noreferrer" className="dp-link-btn" aria-label={t('panel.issues')}>
                  <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM8 0a8 8 0 110 16A8 8 0 018 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/></svg>
                  {t('panel.issues')}
                </a>
                <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer" className="dp-link-btn" aria-label={t('panel.source')}>
                  <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9 3a1 1 0 11-2 0 1 1 0 012 0zm-.23-5.36l-.26 2.02a.47.47 0 01-.49.42h-.04a.47.47 0 01-.49-.42l-.26-2.02A.87.87 0 017 4.87v-.37c0-.33.28-.5.5-.5h1c.22 0 .5.17.5.5v.37c0 .36-.07.68-.23.77z"/></svg>
                  {t('panel.source')}
                </a>
              </div>
            </div>

            {/* Footer info */}
            <div className="dp-footer">
              {t('panel.footer')} <span className="dp-footer-sep">·</span>
              <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT</a>
              <span className="dp-footer-sep">·</span>
              <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">{t('panel.github')}</a>
              <span className="dp-footer-sep">·</span>
              <a href="#docs" aria-label={t('panel.docs')}>{t('panel.docs')}</a>
            </div>
          </aside>
          </div>
          </div>
        </main>

      {/* Footer */}
      <footer className="webapp-footer">
        <div className="webapp-footer-inner">
          <span className="webapp-footer-brand">
            re/<span>file</span> <span className="webapp-footer-ver">v0.2.0</span>
          </span>
          <span className="webapp-footer-tag">{t('footer.tag')}</span>
          <span className="webapp-footer-links">
            <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer" aria-label={t('footer.github')}>{t('footer.github')}</a>
            <span className="webapp-footer-sep">·</span>
            <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer" aria-label={t('footer.mit')}>{t('footer.mit')}</a>
            <span className="webapp-footer-sep">·</span>
            <a href="javascript:void(0)" onClick={() => window.open(window.location.origin + window.location.pathname + '#download', '_blank')} aria-label={t('footer.download')}>{t('footer.download')}</a>
          </span>
        </div>
      </footer>

      {/* Incoming Connection Modal */}
      {incomingOffer && (
        <div className="modal-overlay" onClick={rejectIncoming}>
          <div className="modal-dialog modal-narrow" onClick={e => e.stopPropagation()}>
            <div className="modal-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
              </svg>
            </div>
            <h3>{t('incomingConnect.title')}</h3>
            <p className="modal-peer">{t('incomingConnect.from', { name: incomingPeerName || incomingOffer.from })}</p>
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={acceptIncoming}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                {t('incomingConnect.accept')}
              </button>
              <button className="btn btn-reject modal-btn" onClick={rejectIncoming}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                {t('incomingConnect.reject')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Text Share Modal */}
      {showTextShare && (
        <div className="modal-overlay" onClick={() => setShowTextShare(false)}>
          <div className="modal-dialog modal-narrow" onClick={e => e.stopPropagation()}>
            <h3>{t('textShare.title')}</h3>
            <textarea
              className="text-share-input"
              placeholder={t('textShare.placeholder')}
              value={textToSend}
              onChange={e => setTextToSend(e.target.value)}
              rows={4}
              aria-label={t('textShare.placeholder')}
            />
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={handleSendText} disabled={!textToSend.trim()} aria-label={t('textShare.send')} aria-disabled={!textToSend.trim()}>
                {t('textShare.send')}
              </button>
              <button className="btn btn-reject modal-btn" onClick={() => setShowTextShare(false)} aria-label={t('common.cancel')}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Text Preview Modal */}
      {showTextPreview !== null && (
        <div className="modal-overlay" onClick={() => setShowTextPreview(null)}>
          <div className="modal-dialog modal-wide" onClick={e => e.stopPropagation()}>
            <h3>{t('textPreview.title')}</h3>
            <pre className="text-preview">{showTextPreview}</pre>
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={() => {
                navigator.clipboard.writeText(showTextPreview)
              }} aria-label={t('textPreview.copy')}>
                {t('textPreview.copy')}
              </button>
              <button className="btn btn-reject modal-btn" onClick={() => setShowTextPreview(null)} aria-label={t('common.close')}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewUrl && previewType && (
        <div className="modal-overlay" onClick={() => { setPreviewUrl(null); setPreviewType(null) }}>
          <div className="modal-dialog modal-wide preview-modal-dialog" onClick={e => e.stopPropagation()}>
            <h3>{previewName}</h3>
            <div className="preview-content">
              {previewType === 'image' && (
                <img src={previewUrl} alt={previewName} className="preview-image" />
              )}
              {previewType === 'pdf' && (
                <embed src={previewUrl} type="application/pdf" className="preview-pdf" />
              )}
              {previewType === 'text' && (
                <iframe src={previewUrl} className="preview-text" title={previewName} />
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={() => { setPreviewUrl(null); setPreviewType(null) }} aria-label={t('preview.close')}>
                {t('preview.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Guide Modal */}
      {showGuide && (
        <div className="modal-overlay" onClick={() => setShowGuide(false)}>
          <div className="modal-dialog guide-dialog" onClick={e => e.stopPropagation()}>
            <h3>{t('guide.title')}</h3>
            <div className="guide-section">
              <h4>{t('guide.connect')}</h4>
              <p>{t('guide.connectDesc')}</p>
            </div>
            <div className="guide-section">
              <h4>{t('guide.transfer')}</h4>
              <p>{t('guide.transferDesc')}</p>
            </div>
            <div className="guide-section">
              <h4>{t('guide.privacy')}</h4>
              <p>{t('guide.privacyDesc')}</p>
            </div>
            <div className="guide-actions">
              <label className="guide-dont-show">
                <input type="checkbox" checked={dontShow} onChange={e => { localStorage.setItem('reflie_guide_done', e.target.checked ? '1' : ''); setDontShow(e.target.checked) }} />
                {t('guide.dontShow')}
              </label>
              <button className="btn btn-accept modal-btn" onClick={() => setShowGuide(false)} aria-label={t('guide.close')}>
                {t('guide.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal */}
      {showQR && (
        <div className="modal-overlay" onClick={() => setShowQR(false)}>
          <div className="modal-dialog modal-narrow" onClick={e => e.stopPropagation()}>
            <h3>{t('qr.title')}</h3>
            {qrError ? (
              <div className="qrcode-error">{qrError}</div>
            ) : (
              <>
                <div className="qrcode-wrapper"><canvas ref={qrCanvasRef} role="img" aria-label={t('room.qrCode')} /></div>
                <p className="qrcode-label">{t('qr.label')}</p>
              </>
            )}
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={() => setShowQR(false)} aria-label={t('common.close')}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      <PwaInstallPrompt />
      <UpdateChecker />
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

function TxItem({ t, onViewText, onCancel, onPreview, onPause, onResume, onMoveUp, onMoveDown }: {
  t: WebTransfer
  onViewText?: (text: string) => void
  onCancel?: () => void
  onPreview?: (url: string, name: string) => void
  onPause?: () => void
  onResume?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const { t: tr } = useTranslation()
  const ii = fileIcon(t.name);
  const handleDownload = () => {
    if (!t.blobUrl) return
    const a = document.createElement('a')
    a.href = t.blobUrl
    a.download = t.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
  const ext = t.name.split('.').pop()?.toLowerCase() || ''
  const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
  const canPreview = t.blobUrl && (imgExts.includes(ext) || ext === 'pdf' || t.isText)
  return (
    <div className={`webapp-tx ${t.status}`} role="listitem" aria-label={`${t.direction === 'send' ? tr('history.sending') : tr('history.receiving')} ${t.name}`}>
      <div className="webapp-tx-row">
        <div className={`webapp-tx-icon ${ii.cls}`} aria-hidden="true">{ii.icon}</div>
        <div className="webapp-tx-body">
          <div className="webapp-tx-name" title={t.name}>{t.name}</div>
          <div className="webapp-tx-meta">
            <span>{fmtSize(t.size)}</span>
            {t.status === 'transferring' && t.speed > 0 && <span>{fmtSpeed(t.speed)}</span>}
            <span className={`webapp-tx-badge ${t.status}`}>
              {t.status === 'transferring' ? tr('transfer.status.transferring') : t.status === 'done' ? tr('transfer.status.done') : t.status === 'cancelled' ? tr('transfer.status.cancelled') : t.status === 'paused' ? tr('queue.paused') : tr('transfer.status.error')}
            </span>
          </div>
          {t.status === 'transferring' && (
            <div className="webapp-tx-bar" role="progressbar" aria-valuenow={Math.round(t.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="webapp-tx-fill" style={{ width: `${Math.max(t.progress * 100, 2)}%` }} />
            </div>
          )}
          {t.status === 'cancelled' && t.error && <div className="webapp-tx-err">{t.error}</div>}
          {t.status === 'error' && <div className="webapp-tx-err">{t.error}</div>}
        </div>
        {t.status === 'transferring' && (
          <div className="webapp-tx-actions">
            {onPause && (
              <button className="webapp-tx-action-btn" onClick={onPause} title={tr('queue.pause')} aria-label={tr('queue.pause')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              </button>
            )}
            <button className="webapp-tx-action-btn webapp-tx-cancel" onClick={onCancel} title={tr('transfer.cancel')} aria-label={tr('transfer.cancel')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}
        {t.status === 'paused' && t.direction === 'send' && (
          <div className="webapp-tx-actions">
            {onMoveUp && (
              <button className="webapp-tx-action-btn" onClick={onMoveUp} title={tr('queue.reorderUp')} aria-label={tr('queue.reorderUp')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
              </button>
            )}
            {onMoveDown && (
              <button className="webapp-tx-action-btn" onClick={onMoveDown} title={tr('queue.reorderDown')} aria-label={tr('queue.reorderDown')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            )}
            {onResume && (
              <button className="webapp-tx-action-btn" onClick={onResume} title={tr('queue.resume')} aria-label={tr('queue.resume')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
            )}
            <button className="webapp-tx-action-btn webapp-tx-cancel" onClick={onCancel} title={tr('transfer.cancel')} aria-label={tr('transfer.cancel')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}
        {t.status === 'done' && (
          <div className="webapp-tx-actions">
            {canPreview && t.blobUrl && onPreview && (
              <button className="webapp-tx-action-btn" onClick={() => onPreview(t.blobUrl!, t.name)} title={tr('common.preview')} aria-label={tr('common.preview')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            )}
            {t.direction === 'receive' && t.blobUrl && t.isText && t.textContent && (
              <button className="webapp-tx-action-btn" onClick={() => onViewText?.(t.textContent!)} title={tr('transfer.viewText')} aria-label={tr('transfer.viewText')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            )}
            {t.blobUrl && (
              <button className="webapp-tx-action-btn webapp-tx-download" onClick={handleDownload} title={t.direction === 'send' ? tr('transfer.downloadBackup') : tr('transfer.downloadFile')} aria-label={t.direction === 'send' ? tr('transfer.downloadBackup') : tr('transfer.downloadFile')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                {tr('common.download')}
              </button>
            )}
          </div>
        )}
        {t.status === 'error' && t.blobUrl && (
          <div className="webapp-tx-actions">
            <button className="webapp-tx-action-btn webapp-tx-download" onClick={handleDownload} title={tr('common.download')} aria-label={tr('common.download')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {tr('common.download')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
