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

  const handleClick = () => {
    if (selectedPeer) inputRef.current?.click()
  }

  return (
    <div
      className={`ncard ${!selectedPeer ? 'ncard-disabled' : ''} ${dragging ? 'ncard-dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {pending.length > 0 && (
        <div className="ncard-counter">
          <span className="ncard-dot" />
          <span>{pending.length}</span>
        </div>
      )}

      <div className={`nfolder ${dragging ? 'nfolder-dragging' : ''}`}>
        <div className="nback nback-1" />
        <div className="nback nback-2" />
        <div className="nfront">
          <div className="ntip" />
          <div className="ncover" />
        </div>
      </div>

      <button className="nupload" onClick={handleClick}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        {selectedPeer ? '選擇檔案' : '請選擇裝置'}
      </button>

      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        onChange={e => {
          if (e.target.files && selectedPeer) onDrop(e.target.files)
        }}
      />
    </div>
  )
}
