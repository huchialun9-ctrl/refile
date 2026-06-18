import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

interface Props {
  data: string
  label: string
  onClose: () => void
}

export default function QRCodeModal({ data, label, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const isQR = data.startsWith('re-file:') || data.startsWith('http')

  useEffect(() => {
    if (canvasRef.current && isQR) {
      const dark = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1d1d1f'
      const light = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      QRCode.toCanvas(canvasRef.current, data, {
        width: 280,
        margin: 2,
        color: { dark, light },
      }).catch(() => {
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext('2d')
          if (ctx) {
            ctx.fillStyle = '#fee'
            ctx.fillRect(0, 0, 280, 280)
            ctx.fillStyle = '#c00'
            ctx.font = '14px sans-serif'
            ctx.textAlign = 'center'
            ctx.fillText('QR 產生失敗', 140, 140)
          }
        }
      })
    }
  }, [data, isQR])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog modal-narrow" onClick={e => e.stopPropagation()}>
        <h3>QR Code 連線</h3>
        <div className="qrcode-wrapper">
          {isQR ? <canvas ref={canvasRef} /> : <p className="qrcode-error">{data}</p>}
        </div>
        {label && <p className="qrcode-label">{label}</p>}
        <div className="modal-actions">
          <button className="btn btn-accept modal-btn" onClick={onClose}>關閉</button>
        </div>
      </div>
    </div>
  )
}
