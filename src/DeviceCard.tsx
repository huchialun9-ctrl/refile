import type { DeviceInfo } from './types'

interface Props {
  device: DeviceInfo
  selected: boolean
  onClick: () => void
}

export default function DeviceCard({ device, selected, onClick }: Props) {
  const statusText = device.status === 'Online' ? '在線'
    : device.status === 'Busy' ? '忙碌中' : '離線'

  return (
    <div className={`dcard ${selected ? 'dcard-sel' : ''}`} onClick={onClick}>
      <svg className="dcard-filter" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
        <filter id="bump">
          <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="3" result="noise" />
          <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.12 0" in="noise" result="colored" />
          <feComposite operator="in" in="colored" in2="SourceGraphic" result="composite" />
          <feBlend mode="multiply" in="composite" in2="SourceGraphic" />
        </filter>
      </svg>

      <div className="dcard-bg" />

      <div className="dcard-holo" />

      <div className="dcard-header">
        {device.name.slice(0, 10)}
      </div>

      <div className="dcard-body">
        <div className="dcard-status">
          <span className={`dcard-dot ${device.status === 'Online' ? 'on' : ''}`} />
          {statusText}
        </div>
        <div className="dcard-host">{device.host}</div>
      </div>

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
