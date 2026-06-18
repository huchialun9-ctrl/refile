import type { DeviceInfo } from './types'

interface Props {
  device: DeviceInfo
  selected: boolean
  onClick: () => void
}

export default function DeviceCard({ device, selected, onClick }: Props) {
  const statusText = device.status === 'Online' ? '在線'
    : device.status === 'Busy' ? '忙碌中' : '離線'
  const isBluetooth = device.transport === 'bluetooth'

  return (
    <div className={`dcard ${selected ? 'dcard-sel' : ''}`} onClick={onClick}>
      <svg className="dcard-filter" aria-hidden="true" />

      <div className="dcard-bg" />
      <div className="dcard-holo" />

      <div className="dcard-name">
        {device.name}
        {isBluetooth && (
          <span className="dcard-bt-badge" title="藍牙裝置">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M17.71 7.71L12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z"/>
            </svg>
          </span>
        )}
      </div>

      <div className="dcard-meta">
        <span className={`dcard-dot ${device.status === 'Online' ? 'on' : ''}`} />
        {statusText}
        {isBluetooth && <span className="dcard-transport-label">藍牙</span>}
      </div>

      <div className="dcard-ip">{isBluetooth ? `🔵 ${device.host}` : device.host}</div>

      <div className="dcard-footer">
        <div className="dcard-number">
          <span className="dcard-bold">#{device.id.slice(0, 6)}</span>
        </div>
        <div className="dcard-barcode" />
      </div>

      <div className="dcard-symbol">re/file</div>
      <div className="dcard-notes">&#8377;&#8377;&#8377;</div>
      <div className="dcard-notes">&#8377;&#8377;&#8377;</div>
      <div className="dcard-notes">&#8377;&#8377;&#8377;</div>
    </div>
  )
}
