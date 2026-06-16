import { useRef, useState } from 'react'
import type { TransferSession } from './types'

interface Props {
  transfers: TransferSession[]
  selectedPeer: boolean
  onDrop: (files: FileList) => void
}

export default function FolderCard({ transfers, selectedPeer, onDrop }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const pending = transfers.filter(t => t.status === 'Pending' || t.status === 'Transferring')

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = () => setDragging(false)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (selectedPeer) onDrop(e.dataTransfer.files)
  }

  const bgColors = ['#ff5f6d', '#ffc371', '#4facfe', '#00f2fe', '#a18cd1']

  return (
    <div
      className={`folder-card ${dragging ? 'folder-dragging' : ''} ${!selectedPeer ? 'folder-disabled' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input ref={inputRef} type="checkbox" id="folder-toggle" className="folder-toggle" />

      <div className="hint-wrapper">
        <svg className="hint-arrow" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2">
          <path d="M7 17L17 7M17 7H7M17 7V17" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="hint-text">{selectedPeer ? '按此展開' : '← 選擇裝置'}</span>
      </div>

      <label htmlFor="folder-toggle" className="folder-container">
        {/* Counter */}
        {pending.length > 0 && (
          <div className="counter">
            <span className="status-dot" />
            <span className="counter-label">待傳</span>
            <span className="counter-number">{pending.length}</span>
          </div>
        )}

        {/* Folder back */}
        <svg className="folder-back" viewBox="0 0 170 100" preserveAspectRatio="none">
          <rect x="5" y="17" width="160" height="78" rx="10" fill="#f59e0b" />
          <rect x="5" y="17" width="160" height="78" rx="10" fill="url(#folderGrad)" />
          <rect x="0" y="0" width="55" height="22" rx="6" fill="#f59e0b" />
          <defs>
            <linearGradient id="folderGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fbbf24" />
              <stop offset="100%" stopColor="#d97706" />
            </linearGradient>
          </defs>
        </svg>

        {/* Front wrapper */}
        <div className="folder-front-wrapper">
          <div className="folder-front">
            <div className="folder-label" />
            <svg width="170" height="60" viewBox="0 0 170 60" preserveAspectRatio="none">
              <rect x="0" y="5" width="170" height="52" rx="8" fill="#f59e0b" />
              <rect x="0" y="5" width="170" height="52" rx="8" fill="url(#frontGrad)" />
              <rect x="0" y="5" width="170" height="8" rx="4" fill="rgba(255,255,255,0.15)" />
              <defs>
                <linearGradient id="frontGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fbbf24" />
                  <stop offset="100%" stopColor="#f59e0b" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        </div>

        {/* Files */}
        {pending.slice(0, 5).map((t, i) => (
          <div key={t.id} className={`file file-${i + 1}`} style={{ background: bgColors[i] }}>
            <div className="shine" />
            <div className="file-text">
              {t.file_name.length > 14 ? t.file_name.slice(0, 14) + '…' : t.file_name}
            </div>
            <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span className="file-tag">{t.direction === 'Send' ? '上傳' : '下載'}</span>
          </div>
        ))}

        {/* Search bar */}
        <div className="folder-search">
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input className="search-input" type="text" placeholder="搜尋檔案..." readOnly />
        </div>
      </label>
    </div>
  )
}
