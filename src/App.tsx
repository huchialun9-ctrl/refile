import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'

import type { DeviceInfo, TransferSession } from './types'
import DeviceCard from './DeviceCard'
import FolderCard from './FolderCard'
import DownloadPage from './DownloadPage'
import QRCodeModal from './QRCodeModal'
import PrivacyModal, { loadPrivacy } from './PrivacyModal'
import ConnectionGuide from './ConnectionGuide'
import WebApp from './WebApp'
import { SignalingClient } from './webrtc/signaling'
import { WebRTCPeer } from './webrtc/peer'
import './App.css'

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function formatSpeed(bytesPerSec: number): string {
  return formatSize(bytesPerSec) + '/s'
}

function formatETA(bytesPerSec: number, remaining: number): string {
  if (bytesPerSec <= 0) return '--'
  const secs = remaining / bytesPerSec
  if (secs < 60) return Math.ceil(secs) + '秒'
  if (secs < 3600) return Math.ceil(secs / 60) + '分鐘'
  return Math.ceil(secs / 3600) + '小時'
}

function statusLabel(s: TransferSession['status']): string {
  if (s === 'Pending') return '等待確認'
  if (s === 'Transferring') return '傳輸中'
  if (s === 'Verifying') return '校驗中'
  if (s === 'Completed') return '已完成'
  if (s === 'Cancelled') return '已取消'
  if (typeof s === 'object' && 'Failed' in s) return '失敗'
  return String(s)
}

function directionIcon(dir: TransferSession['direction']): string {
  return dir === 'Send' ? '↑' : '↓'
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function getOSIcon(): string {
  const ua = navigator.userAgent
  if (/Windows/.test(ua)) return '⊞'
  if (/Mac/.test(ua)) return '⌘'
  if (/Linux|CrOS/.test(ua)) return '🐧'
  if (/Android/.test(ua)) return '📱'
  if (/iPhone|iPad/.test(ua)) return '🍎'
  return '💻'
}

function getOSName(): string {
  const ua = navigator.userAgent
  if (/Windows/.test(ua)) return 'Windows'
  if (/Mac/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  if (/Android/.test(ua)) return 'Android'
  if (/iPhone|iPad/.test(ua)) return 'iOS'
  return 'Unknown'
}

function deriveLocalId(): string {
  try {
    const stored = localStorage.getItem('reflie_local_id')
    if (stored && stored.length === 8) return stored
  } catch {}
  const raw = getOSName() + (navigator.userAgent || '')
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i)
    hash |= 0
  }
  const id = Math.abs(hash).toString(36).toUpperCase().slice(0, 8).padEnd(8, '0')
  try { localStorage.setItem('reflie_local_id', id) } catch {}
  return id
}

function fmtId(id: string): string {
  if (id.length <= 4) return id
  return id.slice(0, 4) + '-' + id.slice(4, 8)
}

const TRANSFERS_KEY = 'reflie_transfers'

function App() {
  const [isTauri] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__?.invoke === 'function' } catch { return false }
  })
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [transfers, setTransfers] = useState<Record<string, TransferSession>>({})
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pendingSession, setPendingSession] = useState<TransferSession | null>(null)
  const [darkMode, setDarkMode] = useState(true)
  const [connectionStatus, setConnectionStatus] = useState<'green' | 'yellow'>('yellow')
  const [showTextShare, setShowTextShare] = useState(false)
  const [textToSend, setTextToSend] = useState('')
  const [recentlyCompleted, setRecentlyCompleted] = useState<Set<string>>(new Set())
  const [showQR, setShowQR] = useState(false)
  const [qrData, setQrData] = useState('')
  const [qrLabel, setQrLabel] = useState('')
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [myPeerId] = useState(() => deriveLocalId())
  const handleShowQRRef = useRef<() => void>(() => {})
  const [inputPeerId, setInputPeerId] = useState('')
  const [peerConnecting, setPeerConnecting] = useState(false)
  const [copiedId, setCopiedId] = useState(false)
  const [idSearchResult, setIdSearchResult] = useState<string | null>(null)

  const initialized = useRef(false)
  const [showDownloadPage, setShowDownloadPage] = useState(
    typeof window !== 'undefined' && window.location.hash === '#download'
  )

  // Signaling / WebRTC state
  const sigRef = useRef<SignalingClient | null>(null)
  const [sigPeerId, setSigPeerId] = useState('')
  const [sigOk, setSigOk] = useState(false)
  const [sigError, setSigError] = useState('')
  const [onlinePeers, setOnlinePeers] = useState<Array<{id: string; name: string}>>([])
  const [sigConnecting, setSigConnecting] = useState(false)
  const [sigRemotePeerId, setSigRemotePeerId] = useState('')
  const [webrtcConnected, setWebrtcConnected] = useState(false)
  const webrtcRef = useRef<WebRTCPeer | null>(null)
  const webrtcConnectedRef = useRef(false)
  const webrtcConnectingRef = useRef(false)
  const [shareLabel, setShareLabel] = useState('')
  const handleIncomingRef = useRef<(sig: SignalingClient, data: {sdp: RTCSessionDescriptionInit; from: string; name: string}) => Promise<void>>()

  useEffect(() => {
    const onHash = () => setShowDownloadPage(window.location.hash === '#download')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!isTauri && showDownloadPage) return <DownloadPage darkMode={darkMode} setDarkMode={setDarkMode} />
  if (!isTauri) return <WebApp />

  // Tauri-only hooks below — intentional conditional
  /* eslint-disable react-hooks/rules-of-hooks */

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    setDarkMode(prefersDark)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      const settings = loadPrivacy()
      if (settings.saveHistory) {
        try {
          const saved = localStorage.getItem(TRANSFERS_KEY)
          if (saved) {
            const parsed = JSON.parse(saved) as Record<string, TransferSession>
            setTransfers(parsed)
          }
        } catch (e) { console.error('Failed to load transfer history:', e) }
      }
    }
  }, [])

  useEffect(() => {
    if (!isTauri && !showDownloadPage && devices.length === 0) {
      try {
        if (localStorage.getItem('reflie_guide_done') !== '1') {
          const timer = setTimeout(() => setShowGuide(true), 500)
          return () => clearTimeout(timer)
        }
      } catch (e) { console.error('Guide check failed:', e) }
    }
  }, [isTauri, showDownloadPage, devices.length])

  useEffect(() => {
    const settings = loadPrivacy()
    if (initialized.current && Object.keys(transfers).length > 0 && settings.saveHistory) {
      try {
        localStorage.setItem(TRANSFERS_KEY, JSON.stringify(transfers))
      } catch (e) { console.error('Failed to save transfer history:', e) }
    }
  }, [transfers])

  useEffect(() => {
    const settings = loadPrivacy()
    if (!settings.showNotifications) return
    ;(async () => {
      try {
        let granted = await isPermissionGranted()
        if (!granted) {
          const permission = await requestPermission()
          granted = permission === 'granted'
        }
      } catch (e) { console.error('Notification permission error:', e) }
    })()
  }, [])

  // Signaling init
  useEffect(() => {
    let cancelled = false
    const sig = new SignalingClient()
    sigRef.current = sig

    // Listen for raw server messages (peer-list, error, etc.)
    sig.onRawMessage((raw) => {
      if (cancelled) return
      try {
        const msg = JSON.parse(raw) as Record<string, unknown>
        if (msg.type === 'peer-list') {
          setOnlinePeers(msg.peers as Array<{id: string; name: string}>)
        } else if (msg.type === 'error') {
          setSigError(msg.message as string)
          setSigConnecting(false)
        }
      } catch {}
    })

    // Listen for incoming WebRTC signals (offers from remote peers)
    sig.addSignalHandler((from, rawData) => {
      if (cancelled) return
      const data = rawData as Record<string, unknown>
      // Only handle offer-type signals here; everything else goes to WebRTCPeer instances
      if (data.type === 'offer' && data.sdp) {
        if (webrtcConnectedRef.current || webrtcConnectingRef.current) return
        handleIncomingRef.current?.(sig, {
          from,
          sdp: data.sdp as RTCSessionDescriptionInit,
          name: (data.name as string) || '',
        }).catch(e => console.error('handleIncoming error:', e))
      }
    })

    sig.onDisconnect(() => {
      if (cancelled) return
      setSigConnecting(false)
      setSigOk(false)
    })

    // Try connecting with fallback
    ;(async () => {
      const urls = (import.meta.env.VITE_SIGNAL_URLS as string | undefined)
        ?.split(',').map(u => u.trim()).filter(Boolean)
        ?? ['ws://localhost:3001/ws', 'ws://localhost:5000/ws']
      for (const url of urls) {
        if (cancelled) return
        try {
          const id = await sig.connect(8000, url)
          if (cancelled) return
          setSigPeerId(id)
          setSigOk(true)
          setSigConnecting(false)
          setSigError('')
          return
        } catch {
          // try next
        }
      }
    })()

    return () => {
      cancelled = true
      sig.disconnect()
    }
  }, [])

  useEffect(() => {
    invoke('start_discovery').catch(e => console.error('Failed to start discovery:', e))

    const unsubs: (() => void)[] = []

    const safeListen = <T,>(event: string, handler: (payload: T) => void) => {
      listen<T>(event, e => handler(e.payload))
        .then(fn => unsubs.push(fn))
        .catch(e => console.error(`Failed to listen to ${event}:`, e))
    }

    let firstDiscover = true
    safeListen<DeviceInfo[]>('devices-update', payload => {
      setDevices(payload)
      if (payload.length > 0) {
        setConnectionStatus('green')
        if (firstDiscover) {
          firstDiscover = false
          handleShowQRRef.current()
        }
      }
    })

    safeListen<TransferSession>('transfer-request', payload => {
      setTransfers(prev => ({ ...prev, [payload.id]: payload }))
      const privacy = loadPrivacy()
      if (privacy.acceptAll) {
        invoke('accept_transfer', { sessionId: payload.id }).catch(e => console.error('Auto-accept failed:', e))
      } else if (privacy.autoAcceptTrusted) {
        try {
          const trusted: string[] = JSON.parse(localStorage.getItem('reflie_trusted') || '[]')
          if (trusted.includes(payload.peer_id)) {
            invoke('accept_transfer', { sessionId: payload.id }).catch(e => console.error('Trusted auto-accept failed:', e))
            return
          }
        } catch {}
        setPendingSession(payload)
      } else {
        setPendingSession(payload)
      }
    })

    safeListen<{id: string; bytes_sent: number; speed: number}>('transfer-progress', payload => {
      const { id, bytes_sent, speed } = payload
      setTransfers(prev => {
        const s = prev[id]
        if (!s) return prev
        return { ...prev, [id]: { ...s, status: 'Transferring', progress: s.file_size > 0 ? bytes_sent / s.file_size : 0, speed } }
      })
    })

    safeListen<string>('transfer-complete', payload => {
      setTransfers(prev => {
        const s = prev[payload]
        if (!s) return prev
        if (s.direction === 'Receive') {
          try {
            const trusted: string[] = JSON.parse(localStorage.getItem('reflie_trusted') || '[]')
            if (!trusted.includes(s.peer_id)) {
              trusted.push(s.peer_id)
              localStorage.setItem('reflie_trusted', JSON.stringify(trusted))
            }
          } catch {}
        }
        const settings = loadPrivacy()
        if (settings.showNotifications) {
          try {
            const dir = s.direction === 'Send' ? '上傳' : '下載'
            sendNotification({ title: 're/file', body: `${dir}完成：${s.file_name}` })
          } catch (e) { console.error('Notification error:', e) }
        }
        return { ...prev, [payload]: { ...s, status: 'Completed', progress: 1 } }
      })
      setRecentlyCompleted(prev => new Set(prev).add(payload))
      setPendingSession(prev => prev?.id === payload ? null : prev)
      setTimeout(() => setRecentlyCompleted(prev => {
        const next = new Set(prev)
        next.delete(payload)
        return next
      }), 2000)
    })

    safeListen<{id: string; message: string}>('transfer-error', payload => {
      setTransfers(prev => {
        const s = prev[payload.id]
        if (!s) return prev
        return { ...prev, [payload.id]: { ...s, status: { Failed: payload.message } } }
      })
      setPendingSession(prev => prev?.id === payload.id ? null : prev)
    })

    safeListen<string>('transfer-cancelled', payload => {
      setTransfers(prev => {
        const s = prev[payload]
        if (!s) return prev
        return { ...prev, [payload]: { ...s, status: 'Cancelled' } }
      })
      setPendingSession(prev => prev?.id === payload ? null : prev)
    })

    safeListen<{sessionId: string; savedPath: string}>('transfer-saved', payload => {
      setTransfers(prev => {
        const s = prev[payload.sessionId]
        if (!s) return prev
        return { ...prev, [payload.sessionId]: { ...s, savedPath: payload.savedPath } }
      })
    })

    safeListen<{type: string; paths: string[]; position: {x: number; y: number}}>('tauri://drag-drop', payload => {
      if (payload.type === 'drop' && payload.paths?.length) {
        handleFileDropRef.current(payload.paths)
      }
    })

    return () => { unsubs.forEach(fn => fn()) }
  }, [])

  const handleFileDropRef = useRef<(paths: string[]) => void>(() => {})

  const handleFileDrop = useCallback(async (paths: string[]) => {
    if (!selectedPeer) return
    for (const fp of paths) {
      try {
        await invoke('send_file', { peerId: selectedPeer, filePath: fp })
      } catch (e) { console.error('File drop send error:', e) }
    }
  }, [selectedPeer])
  handleFileDropRef.current = handleFileDrop

  const handleAccept = useCallback(async (id: string) => {
    try {
      await invoke('accept_transfer', { sessionId: id })
      setPendingSession(null)
    } catch (e) { console.error('Accept transfer failed:', e) }
  }, [])

  const handleReject = useCallback(async (id: string) => {
    try {
      await invoke('cancel_transfer', { sessionId: id })
      setPendingSession(null)
    } catch (e) { console.error('Reject transfer failed:', e) }
  }, [])

  const handleCancel = useCallback(async (id: string) => {
    try {
      await invoke('cancel_transfer', { sessionId: id })
    } catch (e) { console.error('Cancel transfer failed:', e) }
  }, [])

  const handleSendText = useCallback(async () => {
    if (!selectedPeer || !textToSend.trim()) return
    const tempPath = `${await invoke('get_temp_dir')}\\clipboard.txt`
    try {
      await invoke('write_text_file', { path: tempPath, content: textToSend })
      await invoke('send_file', { peerId: selectedPeer, filePath: tempPath })
      setTextToSend('')
    } catch (e) { console.error('Send text error:', e) }
  }, [selectedPeer, textToSend])

  const handleShowQR = useCallback(async () => {
    if (!isTauri) {
      const peer = sigOk && sigPeerId ? sigPeerId : myPeerId
      const url = `${window.location.origin}${window.location.pathname}?peer=${peer}`
      setQrData(url)
      setQrLabel(`ID: ${fmtId(peer)}`)
      setShowQR(true)
      return
    }
    try {
      const [host, port] = await invoke<[string, number]>('my_info').catch(() => ['', 0] as [string, number])
      const peer = sigOk && sigPeerId ? sigPeerId : myPeerId
      const label = `${fmtId(peer)}${host ? ` @ ${host}:${port}` : ''}`
      setQrData(`re-file:peer:${peer}`)
      setQrLabel(label)
      setShowQR(true)
    } catch {
      setQrData(`re-file:peer:${myPeerId}`)
      setQrLabel(`ID: ${fmtId(myPeerId)}`)
      setShowQR(true)
    }
  }, [isTauri, myPeerId, sigOk, sigPeerId])

  handleShowQRRef.current = handleShowQR

  const handleCopyId = useCallback(() => {
    const id = sigOk && sigPeerId ? sigPeerId : myPeerId
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(true)
      setTimeout(() => setCopiedId(false), 2000)
    })
  }, [myPeerId, sigOk, sigPeerId])

  const handleShareLink = useCallback(() => {
    if (!sigOk || !sigPeerId) return
    const url = `${window.location.origin}${window.location.pathname}?peer=${sigPeerId}`
    navigator.clipboard.writeText(url).then(() => {
      setShareLabel('✓ 已複製連結')
      setTimeout(() => setShareLabel(''), 2000)
    })
  }, [sigOk, sigPeerId])

  const handleSigDisconnect = useCallback(() => {
    webrtcRef.current?.close()
    webrtcRef.current = null
    webrtcConnectedRef.current = false
    setWebrtcConnected(false)
    webrtcConnectingRef.current = false
    setSigRemotePeerId('')
  }, [])

  const setupPeer = useCallback((wc: WebRTCPeer) => {
    wc.onOpen = () => {
      webrtcConnectedRef.current = true
      setWebrtcConnected(true)
      webrtcConnectingRef.current = false
    }
    wc.onClose = () => {
      webrtcConnectedRef.current = false
      setWebrtcConnected(false)
      webrtcConnectingRef.current = false
      setSigRemotePeerId('')
    }
    wc.onError = (msg) => {
      console.error('WebRTC error:', msg)
      webrtcConnectingRef.current = false
    }
    return wc
  }, [])

  const doConnect = useCallback(async (sig: SignalingClient, targetId: string) => {
    if (webrtcConnectedRef.current || webrtcConnectingRef.current) return
    webrtcConnectingRef.current = true
    setSigRemotePeerId(targetId)
    try {
      const wc = new WebRTCPeer(sig, targetId, true)
      webrtcRef.current = setupPeer(wc)
      await wc.initiate()
    } catch (e) {
      console.error('doConnect error:', e)
      webrtcConnectingRef.current = false
    }
  }, [setupPeer])

  const handleIncoming = useCallback(async (sig: SignalingClient, data: {sdp: RTCSessionDescriptionInit; from: string; name: string}) => {
    if (webrtcConnectedRef.current || webrtcConnectingRef.current) return
    webrtcConnectingRef.current = true
    setSigRemotePeerId(data.from)
    try {
      const offer = new RTCSessionDescription(data.sdp)
      const wc = new WebRTCPeer(sig, data.from, false, offer)
      webrtcRef.current = setupPeer(wc)
    } catch (e) {
      console.error('handleIncoming error:', e)
      webrtcConnectingRef.current = false
    }
  }, [setupPeer])

  handleIncomingRef.current = handleIncoming

  const handleIdConnect = useCallback(() => {
    const raw = inputPeerId.replace(/[^A-Fa-f0-9]/g, '').toUpperCase().slice(0, 8)
    if (raw.length < 6) return
    setPeerConnecting(true)
    setIdSearchResult(null)
    // Try WebRTC via signaling if available
    const sig = sigRef.current
    if (sig && sigOk && onlinePeers.some(p => p.id.toUpperCase().startsWith(raw) || raw.startsWith(p.id.toUpperCase().slice(0, 6)))) {
      const target = onlinePeers.find(p => p.id.toUpperCase().startsWith(raw) || raw.startsWith(p.id.toUpperCase().slice(0, 6)))
      if (target) {
        doConnect(sig, target.id).then(() => {
          setIdSearchResult('found')
        }).catch(() => {
          setIdSearchResult('not-found')
        })
      } else {
        setIdSearchResult('not-found')
      }
    } else {
      // Fallback: search LAN devices
      const match = devices.find(d => d.id.toUpperCase().includes(raw) || raw.includes(d.id.toUpperCase().slice(0, 6)))
      if (match) {
        setSelectedPeer(match.id)
        setIdSearchResult('found')
      } else {
        setIdSearchResult('not-found')
      }
    }
    setTimeout(() => { setPeerConnecting(false); setIdSearchResult(null); setInputPeerId('') }, 2000)
  }, [inputPeerId, devices, sigOk, onlinePeers, doConnect])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const transferList = Object.values(transfers)
  const incomingTransfer = pendingSession

  const renderTimelineItem = (t: TransferSession) => {
    const isActive = t.status === 'Transferring' || t.status === 'Pending' || t.status === 'Verifying'
    const isExpanded = expanded.has(t.id)
    const truncated = t.file_name.length > 28
    const lineStyle = t.status === 'Completed' ? 'solid' : 'dotted'
    const justCompleted = recentlyCompleted.has(t.id)
    const isFailed = typeof t.status === 'object' && 'Failed' in t.status

  /* eslint-enable react-hooks/rules-of-hooks */

  return (
      <div
        key={t.id}
        className={`tl-item ${isActive ? 'tl-active' : ''} ${t.status === 'Completed' ? 'tl-done' : ''} ${justCompleted ? 'tl-just-done' : ''} ${isFailed ? 'tl-failed' : ''}`}
        data-line-active={isActive || t.status === 'Completed' ? 'true' : undefined}
        style={{ '--tli-border-style': lineStyle } as React.CSSProperties}
      >
        <div className={`tl-bullet ${t.status === 'Completed' ? 'tl-bullet-done' : ''} ${isFailed ? 'tl-bullet-fail' : ''}`}>
          {t.status === 'Completed' ? (
            <svg className="tl-icon-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
          ) : isFailed ? (
            <svg className="tl-icon-x" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          ) : (
            <span className="tl-icon">{directionIcon(t.direction)}</span>
          )}
        </div>

        <div className="tl-body">
          <div className="tl-title-row">
            <span className="tl-title">
              {t.direction === 'Send' ? '上傳' : '下載'}
            </span>
            <span className="tl-peer">{t.peer_name || t.peer_id.slice(0, 8)}</span>
          </div>

          <div className="tl-file-row">
            <span className="tl-filename">{t.file_name}</span>
            <span className="tl-size">{formatSize(t.file_size)}</span>
          </div>

          <div className={`tl-content ${isExpanded ? '' : 'tl-clamp'}`}>
            {t.status === 'Transferring' && (
              <div className="tl-progress">
                <div className="tl-progress-bar">
                  <div className="tl-progress-fill" style={{ width: `${Math.max(t.progress * 100, 2)}%` }} />
                </div>
                <div className="tl-progress-info">
                  <span className="tl-speed">{formatSpeed(t.speed)}</span>
                  <span className="tl-eta">{formatETA(t.speed, t.file_size * (1 - t.progress))}</span>
                </div>
              </div>
            )}
            <div className="tl-status">
              <span className={`tl-badge ${t.status === 'Completed' ? 'badge-done' : t.status === 'Cancelled' ? 'badge-fail' : isFailed ? 'badge-fail' : ''}`}>
                {isFailed && typeof t.status === 'object' && 'Failed' in t.status
                  ? '失敗: ' + t.status.Failed
                  : statusLabel(t.status)}
              </span>
            </div>
          </div>

          {truncated && (
            <button className="tl-expand" onClick={() => toggleExpand(t.id)}>
              {isExpanded ? '收起' : '顯示更多'}
            </button>
          )}

          <div className="tl-actions">
            {t.status === 'Pending' && t.direction === 'Receive' && (
              <>
                <button className="btn btn-accept" onClick={() => handleAccept(t.id)}>同意</button>
                <button className="btn btn-reject" onClick={() => handleReject(t.id)}>拒絕</button>
              </>
            )}
            {(t.status === 'Pending' || t.status === 'Transferring') && (
              <button className="btn btn-reject" onClick={() => handleCancel(t.id)}>取消</button>
            )}
          </div>

          <time className="tl-time">{formatTime(t.created_at)}</time>
          {t.savedPath && (
            <button className="btn btn-open-folder" onClick={() => invoke('open_folder', { path: t.savedPath }).catch(e => console.error('Open folder error:', e))}>
              開啟資料夾
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-left">
          <span className={`status-dot-indicator ${connectionStatus}`} title={connectionStatus === 'green' ? 'P2P 已連線' : '搜尋中…'} />
          <span className="device-id-badge">
            <span className="os-icon">{getOSIcon()}</span>
            本機裝置
            <span className="os-name">{getOSName()}</span>
          </span>
        </div>
        <div className="topbar-right">
          <button className="topbar-btn" onClick={() => setShowTextShare(true)} title="傳送文字" aria-label="傳送文字">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button className="topbar-btn" title="下載桌面版" aria-label="下載桌面版" onClick={() => {
            const url = window.location.origin + window.location.pathname + '#download'
            window.open(url, '_blank', 'noopener,noreferrer')
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><polyline points="8 12 12 16 16 12"/></svg>
          </button>
          <button className="topbar-btn" title="連線說明" aria-label="連線說明" onClick={() => setShowGuide(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </button>
          <button className="topbar-btn" title="隱私權設定" aria-label="隱私權設定" onClick={() => setShowPrivacy(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </button>
          <button className="topbar-btn" title="QR Code 連線" aria-label="QR Code 連線" onClick={handleShowQR}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="4" height="4"/></svg>
          </button>
          <label className="main-toggle" title={darkMode ? '淺色模式' : '深色模式'} aria-label={darkMode ? '淺色模式' : '深色模式'}>
            <input type="checkbox" className="main-checkbox" checked={darkMode} onChange={() => setDarkMode(!darkMode)} aria-label={darkMode ? '切換淺色模式' : '切換深色模式'} />
            <div className="main-track"></div>
            <div className="main-knob"></div>
          </label>
        </div>
      </div>

      {!isTauri && (
        <div className="web-banner" onClick={() => window.open(window.location.origin + window.location.pathname + '#download', '_blank')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><polyline points="8 12 12 16 16 12"/></svg>
          下載桌面版使用完整 P2P 傳輸
        </div>
      )}

      {incomingTransfer && (
        <div className="modal-overlay" onClick={() => { handleReject(incomingTransfer.id); setPendingSession(null) }}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </div>
            <h3>接收檔案請求</h3>
            <p className="modal-peer">{incomingTransfer.peer_name || '未知裝置'} 想傳送一個檔案</p>
            <div className="modal-file-info">
              <span className="modal-filename">{incomingTransfer.file_name}</span>
              <span className="modal-filesize">{formatSize(incomingTransfer.file_size)}</span>
            </div>
            <div className="modal-actions">
              <button className="btn btn-accept modal-btn" onClick={() => handleAccept(incomingTransfer.id)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                接受
              </button>
              <button className="btn btn-reject modal-btn" onClick={() => handleReject(incomingTransfer.id)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                拒絕
              </button>
            </div>
          </div>
        </div>
      )}

      {showTextShare && (
        <div className="modal-overlay" onClick={() => setShowTextShare(false)}>
          <div className="modal-dialog modal-narrow" onClick={e => e.stopPropagation()}>
            <h3>傳送文字</h3>
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

      <aside className={`sidebar${!isTauri ? ' web' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">re/<span>file</span></div>
          <div className="subtitle">P2P 檔案傳輸 · 點對點加密</div>
          <div className="security-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            端到端加密
          </div>
        </div>

        <div className="sidebar-id-panel">
          <div className="sid-label">我的 ID</div>
          <div className="sid-id-row">
            <span className="sid-icon">{getOSIcon()}</span>
            <span className="sid-id">{sigOk && sigPeerId ? sigPeerId : fmtId(myPeerId)}</span>
            {sigConnecting && <span className="sid-badge sid-badge-pending">連線中…</span>}
            {sigOk && <span className="sid-badge sid-badge-ok">線上</span>}
            {sigError && <span className="sid-badge sid-badge-err">{sigError}</span>}
          </div>
          <div className="sid-actions">
            <button className="sid-btn" onClick={handleCopyId} title="複製 ID" aria-label="複製裝置 ID">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              {copiedId ? '已複製' : '複製'}
            </button>
            <button className="sid-btn" onClick={handleShowQR} title="QR Code" aria-label="顯示 QR Code">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="4" height="4"/></svg>
              QR
            </button>
            {sigOk && (
              <button className="sid-btn sid-share-btn" onClick={handleShareLink} title="複製分享連結" aria-label="複製分享連結">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                {shareLabel || '分享'}
              </button>
            )}
          </div>

          {/* WebRTC connected state */}
          {webrtcConnected && sigRemotePeerId && (
            <div className="sid-connected-panel">
              <div className="sid-connected-row">
                <span className="status-dot-indicator green" />
                <span className="sid-peer-name">已連線 {sigRemotePeerId}</span>
              </div>
              <button className="sid-btn sid-disconnect-btn" onClick={handleSigDisconnect}>
                中斷連線
              </button>
            </div>
          )}

          {/* Online peers from signaling */}
          {sigOk && onlinePeers.length > 0 && (
            <>
              <div className="sid-divider" />
              <div className="sid-label">線上用戶</div>
              <div className="sid-online-list">
                {onlinePeers.filter(p => p.id !== sigPeerId).map(p => (
                  <div key={p.id} className="sid-online-row">
                    <span className="sid-online-dot" />
                    <span className="sid-online-name">{p.name || p.id.slice(0, 8)}</span>
                    <span className="sid-online-id">{p.id.slice(0, 8)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="sid-divider" />

          <div className="sid-label">連到對方</div>
          <div className="sid-connect-form">
            <input className="sid-input" aria-label="貼上對方 ID"
              placeholder="貼上對方 ID"
              value={inputPeerId}
              onChange={e => setInputPeerId(e.target.value.toUpperCase().replace(/[^A-F0-9-]/g, ''))}
              onKeyDown={e => e.key === 'Enter' && handleIdConnect()}
              maxLength={9}
              disabled={peerConnecting}
            />
            <button className="sid-go-btn" aria-label="連線至對方" onClick={handleIdConnect}
              disabled={peerConnecting || inputPeerId.replace('-', '').length < 6}>
              {peerConnecting ? '…' : '連線'}
            </button>
          </div>
          {idSearchResult === 'found' && <div className="sid-msg sid-msg-ok">已選取相符裝置</div>}
          {idSearchResult === 'not-found' && <div className="sid-msg sid-msg-err">找不到此 ID 的裝置</div>}
          {selectedPeer && !sigRemotePeerId && (
            <div className="sid-connected-row">
              <span className="status-dot-indicator green" />
              <span className="sid-peer-name">
                {devices.find(d => d.id === selectedPeer)?.name || selectedPeer.slice(0, 8)}
              </span>
            </div>
          )}
        </div>

        <div className="device-list">
          <div className="list-title">區域網路裝置</div>
          {devices.length === 0 && <div className="empty">正在搜尋裝置…</div>}
          {devices.map(d => (
            <DeviceCard
              key={d.id}
              device={d}
              selected={selectedPeer === d.id}
              onClick={() => setSelectedPeer(d.id)}
            />
          ))}
        </div>
      </aside>

      <main className={`main${!isTauri ? ' web' : ''}`}>
        <div className="main-upper">
          <div className="main-upper-center">
            <FolderCard
              transfers={transferList}
              selectedPeer={selectedPeer !== null}
              onDrop={handleFileDrop}
            />
          </div>
        </div>

        <div className="dual-timeline">
          <div className="tl-pane tl-pane-send">
            <div className="tl-pane-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              上傳
              <span className="tl-pane-count">{transferList.filter(t => t.direction === 'Send').length}</span>
              <button className="tl-clear-btn" onClick={() => setTransfers(prev => { const n = {...prev}; Object.keys(n).forEach(k => { if (n[k].direction === 'Send') delete n[k] }); return n })} title="清除記錄">✕</button>
            </div>
            <div className="tl-pane-body">
              {transferList.filter(t => t.direction === 'Send').map(t => renderTimelineItem(t))}
              {transferList.filter(t => t.direction === 'Send').length === 0 && <div className="empty">尚無傳送記錄</div>}
            </div>
          </div>
          <div className="tl-divider" />
          <div className="tl-pane tl-pane-recv">
            <div className="tl-pane-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              下載
              <span className="tl-pane-count">{transferList.filter(t => t.direction === 'Receive').length}</span>
              <button className="tl-clear-btn" onClick={() => setTransfers(prev => { const n = {...prev}; Object.keys(n).forEach(k => { if (n[k].direction === 'Receive') delete n[k] }); return n })} title="清除記錄">✕</button>
            </div>
            <div className="tl-pane-body">
              {transferList.filter(t => t.direction === 'Receive').map(t => renderTimelineItem(t))}
              {transferList.filter(t => t.direction === 'Receive').length === 0 && <div className="empty">尚無接收記錄</div>}
            </div>
          </div>
        </div>

        <footer className="app-footer">
          <span className="footer-legal">檔案經點對點加密後直接傳輸，絕不儲存於任何伺服器</span>
          <span className="footer-links">
            <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">GitHub</a>
            <span className="footer-sep">·</span>
            <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT 授權</a>
            <span className="footer-sep">·</span>
            <a href="https://github.com/huchialun9-ctrl/refile/issues" target="_blank" rel="noopener noreferrer">回報問題</a>
          </span>
          <span className="footer-disclaimer">re/file 不對傳輸中斷、檔案損壞或違法內容負擔法律責任</span>
        </footer>
      </main>

      <ConnectionGuide open={showGuide} onClose={() => setShowGuide(false)} />
      <PrivacyModal open={showPrivacy} onClose={() => setShowPrivacy(false)} />

      {showQR && (
        <QRCodeModal
          data={qrData}
          label={qrLabel}
          onClose={() => setShowQR(false)}
        />
      )}
    </>
  )
}

export default App
