import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { DeviceInfo, TransferSession } from './types'
import DeviceCard from './DeviceCard'
import FolderCard from './FolderCard'
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

function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [transfers, setTransfers] = useState<Record<string, TransferSession>>({})
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [incoming, setIncoming] = useState<string[]>([])
  const [pendingSession, setPendingSession] = useState<TransferSession | null>(null)
  const [darkMode, setDarkMode] = useState(true)
  const [connectionStatus, setConnectionStatus] = useState<'green' | 'yellow'>('yellow')
  const [showTextShare, setShowTextShare] = useState(false)
  const [textToSend, setTextToSend] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [recentlyCompleted, setRecentlyCompleted] = useState<Set<string>>(new Set())

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    setDarkMode(prefersDark)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  useEffect(() => {
    invoke('start_discovery').catch(() => {})

    const unsubs: (() => void)[] = []

    listen<DeviceInfo[]>('devices-update', e => {
      setDevices(e.payload)
      if (e.payload.length > 0) setConnectionStatus('green')
    }).then(fn => unsubs.push(fn))

    listen<TransferSession>('transfer-request', e => {
      setTransfers(prev => ({ ...prev, [e.payload.id]: e.payload }))
      setIncoming(prev => [...prev, e.payload.id])
      setPendingSession(e.payload)
    }).then(fn => unsubs.push(fn))

    listen<{id: string; bytes_sent: number; speed: number}>('transfer-progress', e => {
      const { id, bytes_sent, speed } = e.payload
      setTransfers(prev => {
        const s = prev[id]
        if (!s) return prev
        return { ...prev, [id]: { ...s, status: 'Transferring', progress: s.file_size > 0 ? bytes_sent / s.file_size : 0, speed } }
      })
    }).then(fn => unsubs.push(fn))

    listen<string>('transfer-complete', e => {
      setTransfers(prev => {
        const s = prev[e.payload]
        if (!s) return prev
        return { ...prev, [e.payload]: { ...s, status: 'Completed', progress: 1 } }
      })
      setRecentlyCompleted(prev => new Set(prev).add(e.payload))
      setIncoming(prev => prev.filter(id => id !== e.payload))
      setPendingSession(prev => prev?.id === e.payload ? null : prev)
      setTimeout(() => setRecentlyCompleted(prev => {
        const next = new Set(prev)
        next.delete(e.payload)
        return next
      }), 2000)
    }).then(fn => unsubs.push(fn))

    listen<{id: string; message: string}>('transfer-error', e => {
      setTransfers(prev => {
        const s = prev[e.payload.id]
        if (!s) return prev
        return { ...prev, [e.payload.id]: { ...s, status: { Failed: e.payload.message } } }
      })
      setIncoming(prev => prev.filter(id => id !== e.payload.id))
      setPendingSession(prev => prev?.id === e.payload.id ? null : prev)
    }).then(fn => unsubs.push(fn))

    listen<string>('transfer-cancelled', e => {
      setTransfers(prev => {
        const s = prev[e.payload]
        if (!s) return prev
        return { ...prev, [e.payload]: { ...s, status: 'Cancelled' } }
      })
      setIncoming(prev => prev.filter(id => id !== e.payload))
      setPendingSession(prev => prev?.id === e.payload ? null : prev)
    }).then(fn => unsubs.push(fn))

    return () => { unsubs.forEach(fn => fn()) }
  }, [])

  const handleFileDrop = useCallback(async (files: FileList) => {
    if (!selectedPeer) return
    for (const f of files) {
      try {
        await invoke('send_file', { peerId: selectedPeer, filePath: f.name })
      } catch (e) { console.error(e) }
    }
  }, [selectedPeer])

  const handleAccept = useCallback(async (id: string) => {
    await invoke('accept_transfer', { sessionId: id })
    setIncoming(prev => prev.filter(x => x !== id))
    setPendingSession(null)
  }, [])

  const handleReject = useCallback(async (id: string) => {
    await invoke('cancel_transfer', { sessionId: id })
    setIncoming(prev => prev.filter(x => x !== id))
    setPendingSession(null)
  }, [])

  const handleCancel = useCallback(async (id: string) => {
    await invoke('cancel_transfer', { sessionId: id })
  }, [])

  const handleSendText = useCallback(async () => {
    if (!selectedPeer || !textToSend.trim()) return
    const blob = new Blob([textToSend], { type: 'text/plain' })
    const f = new File([blob], 'clipboard.txt')
    const dt = new DataTransfer()
    dt.items.add(f)
    handleFileDrop(dt.files)
    setTextToSend('')
    setShowTextShare(false)
  }, [selectedPeer, textToSend, handleFileDrop])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const transferList = Object.values(transfers)
  const incomingTransfer = pendingSession

  return (
    <>
      <div className="topbar">
        <div className="topbar-left">
          <span className={`status-dot-indicator ${connectionStatus}`} title={connectionStatus === 'green' ? 'P2P 已連線' : '搜尋中…'} />
          <span className="device-id-badge">
            <span className="os-icon">{getOSIcon()}</span>
            {deviceName || '本機裝置'}
            <span className="os-name">{getOSName()}</span>
          </span>
        </div>
        <div className="topbar-right">
          <button className="topbar-btn" onClick={() => setShowTextShare(true)} title="傳送文字">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button className="topbar-btn" title="QR Code 連線">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="4" height="4"/></svg>
          </button>
          <button className="topbar-btn" onClick={() => setDarkMode(!darkMode)} title={darkMode ? '淺色模式' : '深色模式'}>
            {darkMode ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
        </div>
      </div>

      {incomingTransfer && (
        <div className="modal-overlay" onClick={() => setPendingSession(null)}>
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

      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo">re/<span>file</span></div>
          <div className="subtitle">P2P 檔案傳輸 · 點對點加密</div>
          <div className="security-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            端到端加密
          </div>
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

      <main className="main">
        <div className="main-header">
          <h2>傳輸記錄</h2>
          {selectedPeer && <span className="peer-hint">
            傳送至: {devices.find(d => d.id === selectedPeer)?.name || selectedPeer}
          </span>}
        </div>

        <FolderCard
          transfers={transferList}
          selectedPeer={selectedPeer !== null}
          onDrop={handleFileDrop}
        />

        <div className="timeline">
          {transferList.length === 0 && <div className="empty">尚無傳輸記錄</div>}
          {transferList.map(t => {
            const isActive = t.status === 'Transferring' || t.status === 'Pending'
            const isExpanded = expanded.has(t.id)
            const truncated = t.file_name.length > 28
            const lineStyle = t.status === 'Completed' ? 'solid' : 'dotted'
            const justCompleted = recentlyCompleted.has(t.id)
            const isFailed = typeof t.status === 'object' && 'Failed' in t.status

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
                    {(t.status === 'Pending' || t.status === 'Transferring') && t.direction === 'Send' && (
                      <button className="btn btn-reject" onClick={() => handleCancel(t.id)}>取消</button>
                    )}
                  </div>

                  <time className="tl-time">{formatTime(t.created_at)}</time>
                </div>
              </div>
            )
          })}
        </div>

        <footer className="app-footer">
          <span className="footer-legal">檔案經點對點加密後直接傳輸，絕不儲存於任何伺服器</span>
          <span className="footer-links">
            <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">GitHub</a>
            <span className="footer-sep">·</span>
            <a href="https://github.com/huchialun9-ctrl/refile/issues" target="_blank" rel="noopener noreferrer">回報問題</a>
          </span>
          <span className="footer-disclaimer">re/file 不對傳輸中斷、檔案損壞或違法內容負擔法律責任</span>
        </footer>
      </main>
    </>
  )
}

export default App
