import { useState, useEffect, useCallback } from 'react'

interface Props {
  darkMode: boolean
  setDarkMode: (v: boolean) => void
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

interface Release {
  tag_name: string
  name: string
  body: string
  published_at: string
  assets: ReleaseAsset[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function parseBody(body: string): string[] {
  return body.split('\n').filter(l => l.trim()).map(l => l.replace(/^[-*]\s*/, '').trim())
}

function assetLabel(name: string): string {
  if (name.endsWith('.exe') && name.includes('setup')) return 'Windows 安裝程式 (NSIS)'
  if (name.endsWith('.msi')) return 'Windows 安裝程式 (MSI)'
  if (name.endsWith('.exe')) return 'Windows 免安裝版 (.exe)'
  if (name.endsWith('.dmg')) return 'macOS 磁碟映像 (.dmg)'
  if (name.endsWith('.AppImage')) return 'Linux AppImage'
  if (name.endsWith('.deb')) return 'Linux Debian 套件'
  if (name.endsWith('.rpm')) return 'Linux RPM 套件'
  if (name.endsWith('.tar.gz') || name.endsWith('.tar.xz')) return 'Linux 壓縮檔'
  return name
}

function AssetIcon({ name }: { name: string }) {
  const isSetup = name.includes('setup') || name.includes('installer')
  if (name.endsWith('.exe') && !isSetup) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    )
  }
  if (isSetup) {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    )
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
  )
}

// FALLBACK_RELEASES — 每次發布新版本時更新
const FALLBACK_RELEASES: Release[] = [
  {
    tag_name: 'v0.2.0',
    name: 'v0.2.0',
    body: 'v0.2.0 — 重大更新\n\n新功能:\n- 藍牙掃描 BLE 裝置，自動配對在線用戶連線\n- 即時文字傳輸欄 (Enter 送出)\n- 圖片/PDF/文字檔內嵌預覽\n- 邀請功能 + QR Code\n- Ctrl+V 貼上圖片/文字傳送\n- 接收完成瀏覽器通知\n\n改進:\n- 連線逾時 30s，7 個 STUN\n- 佈局加寬，aria-label\n\nBug 修復:\n- sendFiles 並行鎖\n- BLE 監聽器洩漏\n- peer.ts onClose 重複\n- AbortSignal 未傳入\n- GitHub API 403 崩潰\n- Blob URL 洩漏',
    published_at: '2026-06-17T00:00:00Z',
    assets: [
      { name: 'reflie.exe', browser_download_url: 'https://github.com/huchialun9-ctrl/refile/releases/download/v0.2.0/reflie.exe', size: 14708736 },
      { name: 'reflie_0.1.0_x64-setup.exe', browser_download_url: 'https://github.com/huchialun9-ctrl/refile/releases/download/v0.2.0/reflie_0.1.0_x64-setup.exe', size: 3515196 },
      { name: 'reflie_0.1.0_x64_en-US.msi', browser_download_url: 'https://github.com/huchialun9-ctrl/refile/releases/download/v0.2.0/reflie_0.1.0_x64_en-US.msi', size: 5201920 },
    ]
  }
]

const COOKIE_KEY = 'reflie_cookie_consent'

export default function DownloadPage({ darkMode, setDarkMode }: Props) {
  const [releases, setReleases] = useState<Release[]>([])
  const [loading, setLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [showCookie, setShowCookie] = useState(false)

  useEffect(() => {
    const goOnline = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    try {
      const val = localStorage.getItem(COOKIE_KEY)
      if (val !== 'accepted') setShowCookie(true)
    } catch { setShowCookie(true) }
  }, [])

  const acceptCookies = () => {
    try { localStorage.setItem(COOKIE_KEY, 'accepted') } catch {}
    setShowCookie(false)
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  async function fetchReleases(signal: AbortSignal) {
    setLoading(true)
    setHasError(false)
    try {
      const r = await fetch('https://api.github.com/repos/huchialun9-ctrl/refile/releases', { signal })
      const data: Release[] = await r.json()
      if (Array.isArray(data) && data.length > 0 && data[0].assets.length > 0) {
        setReleases(data)
      } else {
        setReleases(Array.isArray(data) && data.length > 0 ? [...data, ...FALLBACK_RELEASES] : FALLBACK_RELEASES)
      }
    } catch {
      setReleases(FALLBACK_RELEASES)
      setHasError(true)
    } finally {
      setLoading(false)
    }
  }

  const refetch = useCallback(() => {
    const ac = new AbortController()
    fetchReleases(ac.signal)
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    fetchReleases(ac.signal)
    return () => ac.abort()
  }, [])

  return (
    <div className="download-page">
      <div className="download-topbar">
        <label className="main-toggle">
            <input type="checkbox" className="main-checkbox" checked={darkMode} onChange={() => setDarkMode(d => !d)} />
          <div className="main-track"></div>
          <div className="main-knob"></div>
        </label>
      </div>

      <div className="download-hero">
        <div className="download-logo">re/<span>file</span></div>
        <p className="download-tagline">P2P 檔案傳輸 · 點對點加密 · 區域網路直連</p>
        <div className="feature-bar">
          <div className="feature-item feature-e2e">端到端加密</div>
          <div className="feature-item feature-stream">區塊串流傳輸</div>
          <div className="feature-item feature-auto">零設定自動發現</div>
        </div>
      </div>

      <div className="download-section">
        <h2>下載桌面應用程式</h2>
        <p className="download-sub">在區域網路中與其他裝置直接傳輸檔案，不需經過任何伺服器</p>

        {!isOnline && <div className="dp-offline-banner">連線中斷 — 無法取得最新版本</div>}

        {loading && <div className="download-loading">載入中…</div>}

        {hasError && !loading && (
          <div style={{textAlign:'center',marginBottom:16}}>
            <button className="btn btn-accept" onClick={refetch}>重試</button>
          </div>
        )}

        <div className="download-card download-web-card">
          <div className="download-card-header">
            <span className="download-version">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:'middle',marginRight:6}}>
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              網頁版 — 免安裝
            </span>
            <span className="download-date">即開即用</span>
          </div>
          <div className="download-card-body">
            <p className="download-note">支援 P2P 檔案傳輸、文字傳送、QR Code 連線</p>
          </div>
          <div className="download-assets">
            <a href="/" className="download-btn download-btn-web"
              onClick={e => { e.preventDefault(); window.location.hash = '' }}>
              <span className="download-btn-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
              </span>
              <span className="download-btn-text">
                開啟網頁版
                <span className="download-btn-size">Chrome / Edge / Safari</span>
              </span>
            </a>
          </div>
        </div>

        {releases.map(release => (
          <div key={release.tag_name} className="download-card">
            <div className="download-card-header">
              <span className="download-version">{release.name}</span>
              <span className="download-date">
                {new Date(release.published_at).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })}
              </span>
            </div>
            <div className="download-card-body">
              {parseBody(release.body).map((line, i) => (
                <p key={i} className="download-note">{line}</p>
              ))}
            </div>
            <div className="download-assets">
              {release.assets.filter(a => !a.name.includes('blockmap') && !a.name.endsWith('.yml') && !a.name.endsWith('.yaml')).map(asset => (
                <a key={asset.name} href={asset.browser_download_url} className="download-btn">
                  <span className="download-btn-icon"><AssetIcon name={asset.name} /></span>
                  <span className="download-btn-text">
                    {assetLabel(asset.name)}
                    <span className="download-btn-size">{formatSize(asset.size)}</span>
                  </span>
                </a>
              ))}
              <div className="download-webview2">
                <div className="download-webview2-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                </div>
                <div className="download-webview2-body">
                  <span className="download-webview2-title">Windows 需要 WebView2 Runtime</span>
                  <span className="download-webview2-desc">桌面版依賴 Microsoft Edge WebView2，按下按鈕自動下載正確版本</span>
                  <a className="download-webview2-btn" href="https://go.microsoft.com/fwlink/p/?LinkId=2124703" target="_blank" rel="noopener noreferrer">
                    下載 WebView2 (Evergreen Bootstrapper)
                  </a>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="download-bottom">
        <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer" className="download-gh-link">
          在 GitHub 上檢視原始碼 →
        </a>
      </div>

      {showCookie && (
        <div className="cookie-banner">
          <span>這個網站使用 cookie 儲存您的偏好設定。我們不追蹤您、不蒐集個人資料。</span>
          <button className="btn btn-accept" onClick={acceptCookies}>知道了</button>
        </div>
      )}

      <footer className="download-footer">
        <span>檔案經點對點加密後直接傳輸，絕不儲存於任何伺服器</span>
        <span className="download-footer-links">
          <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">GitHub</a>
          <span className="download-footer-sep">·</span>
          <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT 授權</a>
          <span className="download-footer-sep">·</span>
          <a href="https://github.com/huchialun9-ctrl/refile/issues" target="_blank" rel="noopener noreferrer">回報問題</a>
          <span className="download-footer-sep">·</span>
          <a href="#" onClick={e => { e.preventDefault(); setShowCookie(true) }}>Cookie 設定</a>
        </span>
      </footer>
    </div>
  )
}
