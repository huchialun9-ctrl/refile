import { useCallback } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import type { TransferSession } from './types'

interface Props {
  transfers: TransferSession[]
  selectedPeer: boolean
}

export default function FolderCard({ transfers, selectedPeer }: Props) {
  const pending = transfers.filter(t => t.status === 'Pending' || t.status === 'Transferring')

  const handlePickFile = useCallback(async () => {
    if (!selectedPeer) return
    try {
      const selected = await open({ multiple: true })
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected]
        for (const fp of paths) {
          await invoke('send_file', { peerId: selectedPeer, filePath: fp }).catch(e => console.error('Send file error:', e))
        }
      }
    } catch (e) {
      console.warn('Tauri dialog not available:', e)
    }
  }, [selectedPeer])

  return (
    <div className={`ncard ${!selectedPeer ? 'ncard-disabled' : ''}`}>
      {selectedPeer ? (
        <>
          {pending.length > 0 && (
            <div className="ncard-counter">
              <span className="ncard-dot" />
              <span>{pending.length}</span>
            </div>
          )}

          <div className="ncard-upload-form">
            <label className="ncard-upload-label" onClick={handlePickFile}>
              <div className="ncard-upload-design">
                <svg viewBox="0 0 640 512" fill="currentColor">
                  <path d="M144 480C64.5 480 0 415.5 0 336c0-62.8 40.2-116.2 96.2-135.9c-.1-2.7-.2-5.4-.2-8.1c0-88.4 71.6-160 160-160c59.3 0 111 32.2 138.7 80.2C409.9 102 428.3 96 448 96c53 0 96 43 96 96c0 12.2-2.3 23.8-6.4 34.6C596 238.4 640 290.1 640 352c0 70.7-57.3 128-128 128H144zm79-217c-9.4 9.4-9.4 24.6 0 33.9s24.6 9.4 33.9 0l39-39V392c0 13.3 10.7 24 24 24s24-10.7 24-24V257.9l39 39c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-80-80c-9.4-9.4-24.6-9.4-33.9 0l-80 80z"/>
                </svg>
                <p>拖曳檔案到這裡</p>
                <span className="ncard-or">—— 或 ——</span>
                <span className="ncard-browse-btn">選擇檔案</span>
              </div>
            </label>
          </div>
        </>
      ) : (
        <div className="ncard-disconnected">
          <svg className="ncard-dis-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <div className="ncard-dis-label">還沒連線</div>
          <div className="ncard-dis-hint">左邊輸入對方的 ID 就能連了</div>
        </div>
      )}
    </div>
  )
}
