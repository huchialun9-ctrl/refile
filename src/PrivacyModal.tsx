/* eslint-disable react-refresh/only-export-components */
import { useState, useEffect } from 'react'

interface PrivacySettings {
  acceptAll: boolean
  showNotifications: boolean
  saveHistory: boolean
  autoAcceptTrusted: boolean
  analytics: boolean
  cookies: boolean
}

const STORAGE_KEY = 'reflie_privacy'

const defaults: PrivacySettings = {
  acceptAll: false,
  showNotifications: true,
  saveHistory: true,
  autoAcceptTrusted: false,
  analytics: false,
  cookies: true,
}

export function loadPrivacy(): PrivacySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch {}
  return defaults
}

export function savePrivacy(s: PrivacySettings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch {}
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function PrivacyModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<PrivacySettings>(defaults)

  useEffect(() => {
    if (open) setSettings(loadPrivacy())
  }, [open])

  if (!open) return null

  const update = (key: keyof PrivacySettings, val: boolean) => {
    const next = { ...settings, [key]: val }
    setSettings(next)
    savePrivacy(next)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" onClick={e => e.stopPropagation()} style={{ textAlign: 'left', maxWidth: 420 }}>
        <h3 style={{ textAlign: 'center' }}>隱私權設定</h3>

        <div className="privacy-group">
          <label className="privacy-row">
            <span>
              <strong>接受所有傳入請求</strong>
              <small>自動接受任何裝置的傳檔要求</small>
            </span>
            <input type="checkbox" checked={settings.acceptAll} onChange={e => update('acceptAll', e.target.checked)} />
          </label>
          <label className="privacy-row">
            <span>
              <strong>顯示通知</strong>
              <small>傳輸完成時顯示系統通知</small>
            </span>
            <input type="checkbox" checked={settings.showNotifications} onChange={e => update('showNotifications', e.target.checked)} />
          </label>
          <label className="privacy-row">
            <span>
              <strong>儲存傳輸記錄</strong>
              <small>關掉 App 後仍保留歷史記錄</small>
            </span>
            <input type="checkbox" checked={settings.saveHistory} onChange={e => update('saveHistory', e.target.checked)} />
          </label>
          <label className="privacy-row">
            <span>
              <strong>自動接受信任裝置</strong>
              <small>曾經傳過檔案的裝置自動放行</small>
            </span>
            <input type="checkbox" checked={settings.autoAcceptTrusted} onChange={e => update('autoAcceptTrusted', e.target.checked)} />
          </label>
          <label className="privacy-row">
            <span>
              <strong>Cookie 儲存偏好</strong>
              <small>記住你的設定</small>
            </span>
            <input type="checkbox" checked={settings.cookies} onChange={e => update('cookies', e.target.checked)} />
          </label>
          {/* PRIVATE NOTE: Analytics collection is not yet implemented.
              The checkbox below is a placeholder for future use.
              It saves to localStorage but no analytics code reads it. */}
          <label className="privacy-row">
            <span>
              <strong>分析資料蒐集</strong>
              <small>傳送匿名使用統計（尚未實作）</small>
            </span>
            <input type="checkbox" checked={settings.analytics} onChange={e => update('analytics', e.target.checked)} disabled />
          </label>
        </div>

        <p className="privacy-note">
          re/file 不會上傳你的檔案或個人資料。<br />
          所有傳輸都是直接點對點加密進行。
        </p>

        <div className="modal-actions">
          <button className="btn btn-accept modal-btn" onClick={onClose}>關閉</button>
        </div>
      </div>
    </div>
  )
}
