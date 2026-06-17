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
      QRCode.toCanvas(canvasRef.current, data, {
        width: 280,
        margin: 2,
        color: {
          dark: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
          light: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        },
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
