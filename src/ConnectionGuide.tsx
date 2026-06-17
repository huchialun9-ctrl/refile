import { useState } from 'react'

const GUIDE_KEY = 'reflie_guide_done'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ConnectionGuide({ open, onClose }: Props) {
  const [dontShow, setDontShow] = useState(false)

  if (!open) return null

  const handleClose = () => {
    if (dontShow) {
      try { localStorage.setItem(GUIDE_KEY, '1') } catch {}
    }
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-dialog guide-dialog" onClick={e => e.stopPropagation()}>
        <h3>如何連線？</h3>

        <ol className="guide-steps">
          <li>
            <strong>安裝 re/file</strong>
            <span>兩台裝置都裝好並啟動 re/file</span>
          </li>
          <li>
            <strong>連到同一個網路</strong>
            <span>確認兩台電腦連到同一台路由器或同一個 Wi-Fi</span>
          </li>
          <li>
            <strong>自動發現</strong>
            <span>左側裝置清單會自動顯示區網內的其他裝置</span>
          </li>
          <li>
            <strong>點選裝置 → 傳送檔案</strong>
            <span>選取裝置後拖曳檔案或點「選擇檔案」即可傳輸</span>
          </li>
          <li>
            <strong>QR Code 連線（選用）</strong>
            <span>按頂端 QR 圖示分享連線資訊，對方可直接掃碼連線</span>
          </li>
        </ol>

        <div className="guide-extra">
          <p>傳輸過程走 TLS 加密＋SHA256 校驗，區網內不經任何伺服器。</p>
        </div>

        <div className="guide-actions">
          <label className="guide-dont-show">
            <input type="checkbox" checked={dontShow} onChange={e => setDontShow(e.target.checked)} />
            不要再次顯示
          </label>
          <button className="btn btn-accept modal-btn" onClick={handleClose}>知道了</button>
        </div>
      </div>
    </div>
  )
}
