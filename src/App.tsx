import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
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

function statusLabel(s: TransferSession['status']): string {
  if (s === 'Pending') return '等待確認'
  if (s === 'Transferring') return '傳輸中'
  if (s === 'Verifying') return '校驗中'
  if (s === 'Completed') return '已完成'
  if (s === 'Cancelled') return '已取消'
  if (typeof s === 'object' && 'Failed' in s) return '失敗: ' + s.Failed
  return String(s)
}

function directionIcon(dir: TransferSession['direction']): string {
  return dir === 'Send' ? '⬆️' : '⬇️'
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [transfers, setTransfers] = useState<TransferSession[]>([])
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const poll = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([
        invoke<DeviceInfo[]>('get_devices'),
        invoke<TransferSession[]>('get_transfers'),
      ])
      setDevices(d)
      setTransfers(t)
    } catch { /* backend not ready */ }
  }, [])

  useEffect(() => {
    invoke('start_discovery').catch(() => {})
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [poll])

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
  }, [])

  const handleCancel = useCallback(async (id: string) => {
    await invoke('cancel_transfer', { sessionId: id })
  }, [])

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo">re/<span>file</span></div>
          <div className="subtitle">P2P 檔案傳輸</div>
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
          transfers={transfers}
          selectedPeer={selectedPeer !== null}
          onDrop={handleFileDrop}
        />

        <div className="timeline">
          {transfers.length === 0 && <div className="empty">尚無傳輸記錄</div>}
          {transfers.map(t => {
            const isActive = t.status === 'Transferring' || t.status === 'Pending'
            const isExpanded = expanded.has(t.id)
            const truncated = t.file_name.length > 28
            const lineStyle = t.status === 'Completed' ? 'solid' : 'dotted'

            return (
              <div
                key={t.id}
                className={`tl-item ${isActive ? 'tl-active' : ''} ${t.status === 'Completed' ? 'tl-done' : ''}`}
                data-line-active={isActive || t.status === 'Completed' ? 'true' : undefined}
                style={{ '--tli-border-style': lineStyle } as React.CSSProperties}
              >
                <div className={`tl-bullet ${t.status === 'Completed' ? 'tl-bullet-done' : ''}`}>
                  <span className="tl-icon">{directionIcon(t.direction)}</span>
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
                          <div className="tl-progress-fill" style={{ width: `${t.progress * 100}%` }} />
                        </div>
                        <span className="tl-speed">{formatSpeed(t.speed)}</span>
                      </div>
                    )}
                    <div className="tl-status">
                      <span className={`tl-badge ${t.status === 'Completed' ? 'badge-done' : t.status === 'Cancelled' ? 'badge-fail' : typeof t.status === 'object' && 'Failed' in t.status ? 'badge-fail' : ''}`}>
                        {statusLabel(t.status)}
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
                        <button className="btn btn-reject" onClick={() => handleCancel(t.id)}>拒絕</button>
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
      </main>
    </>
  )
}

export default App
