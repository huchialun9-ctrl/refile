import { useEffect } from 'react'

interface Props {
  darkMode: boolean
  setDarkMode: (v: boolean) => void
}

const sections = [
  {
    id: 'intro',
    title: '概覽',
    content: [
      're/file 是一套點對點加密檔案傳輸系統。無需註冊，檔案不經伺服器，兩端裝置直接連線傳輸。',
      '提供桌面用戶端（Tauri）與網頁版（WebRTC）。傳輸全程使用 AES-GCM 加密，作業結束後不留暫存。',
    ],
  },
  {
    id: 'quickstart',
    title: '使用流程',
    steps: [
      '於首頁取得 8 位數裝置 ID，或透過 QR Code 分享',
      '將 ID 提供給遠端裝置，或輸入對方 ID',
      '按下「連線」等待握手完成',
      '連線成功後，拖曳檔案至畫面中央，或點擊「選擇檔案」',
      '亦可使用文字傳送功能傳遞密碼、網址等內容',
    ],
  },
  {
    id: 'security',
    title: '安全性',
    items: [
      { label: '端到端加密', desc: 'AES-GCM 256-bit，金鑰僅於兩端裝置之間交換，第三方無法解密' },
      { label: '直連傳輸', desc: '檔案透過 WebRTC 或 TCP 直接傳送，不經過中介伺服器' },
      { label: '無暫存', desc: '傳輸完成後系統不保留任何檔案副本，僅接收端自行儲存' },
      { label: '開放原始碼', desc: '原始碼公開於 GitHub，MIT 授權，接受社群審查' },
    ],
  },
  {
    id: 'tech',
    title: '技術規格',
    items: [
      { label: '前端框架', desc: 'React 19 / TypeScript / Vite' },
      { label: '桌面執行環境', desc: 'Tauri v2 (Rust)，支援 Windows / macOS / Linux' },
      { label: 'P2P 傳輸協定', desc: 'WebRTC (網頁版) / TCP Socket (桌面版)' },
      { label: '加密層', desc: 'AES-GCM 256-bit，金鑰交換使用 x25519 ECDH' },
      { label: '裝置發現', desc: 'mDNS (區網) / WebSocket Signal Server (網際網路)' },
      { label: '串流機制', desc: '4 MB 區塊化傳輸，200 ms 週期進度回報' },
    ],
  },
  {
    id: 'faq',
    title: '常見問題',
    items: [
      { q: '是否需要註冊帳號？', a: '不需要。re/file 不蒐集任何個人資訊，安裝後即可使用。' },
      { q: '檔案是否會經過第三方伺服器？', a: '不會。檔案直接於兩端裝置間傳輸，無中介節點。' },
      { q: '有無檔案大小限制？', a: '無限制。採用 4 MB 區塊串流，可處理任意大小檔案。' },
      { q: '網頁版與桌面版差異為何？', a: '桌面版使用原生 TCP Socket，傳輸效率較高且支援區網自動發現。網頁版無需安裝，開啟瀏覽器即可使用。' },
      { q: '防火牆環境下能否使用？', a: '桌面版採直接 TCP 連線。網頁版透過 WebRTC ICE/STUN/TURN 協定進行 NAT 穿透。' },
    ],
  },
  {
    id: 'changelog',
    title: '版本歷史',
    items: [
      {
        v: 'v0.2.1', date: '2025-06-18',
        changes: [
          'TypeScript 型別強化：移除 14 處 any，導入 BLE 與 WebRTC 介面定義',
          '修復 Blob URL 記憶體洩漏：cancel / error 路徑補上 revokeObjectURL',
          '修復 stale closure：handleShowQR 改採 useRef 模式',
          'DownloadPage 新增離線提示、重試按鈕、RWD 斷點',
          'GitHub API 回傳空值時自動載入靜態備份版本資料',
          'open_folder 跨平台支援：依序嘗試 explorer / open / xdg-open',
          'mDNS 註冊失敗由 log::warn 輸出，不再無聲忽略',
          'CSS 核心變數後備機制：index.css 載入失敗仍可正常顯示',
          '修復 hoisting bug：useRef 於 const 初始化前呼叫造成 ReferenceError',
        ],
      },
      {
        v: 'v0.2.0', date: '2025-06-10',
        changes: [
          'Web Bluetooth API：支援 BLE 掃描與配對',
          'WebRTC P2P 傳輸：瀏覽器直接對傳，無需安裝',
          '連線體驗改善：縮短握手時間、狀態提示優化',
          'QR Code 連線：手機掃碼即配對',
          'Ctrl+V 貼上傳送：支援圖片、檔案、網址',
          '桌面版原生拖曳傳檔：無 base64 記憶體消耗',
          '連線逾時 15 秒 → 30 秒，STUN 伺服器增至 7 組',
          'aria-label 全面導入，支援無障礙瀏覽',
          '下載頁面加入 WebView2 必要元件說明',
          'PrivacyModal 自動接受 / 信任裝置功能實裝',
          '預設視窗尺寸 800×600 → 1100×720',
        ],
      },
      {
        v: 'v0.1.0', date: '2025-05',
        changes: [
          '初始版本釋出',
          'P2P 加密檔案傳輸',
          'WebRTC 網頁版',
          'mDNS 區網裝置自動發現',
          '雙面板傳輸時間軸',
          '暗色 / 亮色主題',
          '系統通知與隱私設定',
        ],
      },
    ],
  },
  {
    id: 'license',
    title: '授權條款',
    content: [
      're/file 以 MIT 授權條款釋出。使用者得自由使用、修改、散布本軟體，惟須保留原始版權聲明。',
      '本軟體以「現狀」提供，不附帶任何明示或默示之保證，包括但不限於適售性、特定用途適用性及不侵權之保證。',
    ],
  },
]

export default function DocsPage({ darkMode, setDarkMode }: Props) {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  const goHome = () => {
    window.location.hash = ''
    window.location.reload()
  }

  return (
    <div className="docs-page">
      <header className="docs-topbar">
        <button className="docs-back-btn" onClick={goHome} aria-label="返回首頁">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          返回
        </button>
        <span className="docs-wordmark">re/<span>file</span></span>
        <label className="main-toggle docs-toggle" aria-label={darkMode ? '切換亮色模式' : '切換暗色模式'}>
          <input type="checkbox" className="main-checkbox" checked={darkMode} onChange={() => setDarkMode(d => !d)} />
          <div className="main-track"></div>
          <div className="main-knob"></div>
        </label>
      </header>

      <div className="docs-layout">
        <nav className="docs-sidebar">
          <div className="docs-sidebar-title">目錄</div>
          {sections.map(s => (
            <a key={s.id} href={`#docs-${s.id}`} className="docs-sidebar-link"
              onClick={e => {
                e.preventDefault()
                document.getElementById(`docs-${s.id}`)?.scrollIntoView({ behavior: 'smooth' })
              }}>
              {s.title}
            </a>
          ))}
        </nav>

        <main className="docs-content">
          <h1 className="docs-h1">文件與資料</h1>

          {sections.map(s => (
            <section key={s.id} id={`docs-${s.id}`} className="docs-section">
              <h2 className="docs-h2">{s.title}</h2>

              {'content' in s && Array.isArray(s.content) && s.content.map((p, i) => (
                <p key={i} className="docs-p">{p}</p>
              ))}

              {'steps' in s && Array.isArray(s.steps) && (
                <ol className="docs-ol">
                  {s.steps.map((step, i) => <li key={i} className="docs-li">{step}</li>)}
                </ol>
              )}

              {'items' in s && Array.isArray(s.items) && 'q' in s.items[0] ? (
                <div className="docs-faq">
                  {s.items.map((item, i) => (
                    <details key={i} className="docs-details">
                      <summary className="docs-summary">{item.q}</summary>
                      <p className="docs-p">{item.a}</p>
                    </details>
                  ))}
                </div>
              ) : 'items' in s && Array.isArray(s.items) && 'v' in s.items[0] ? (
                <div className="docs-changelog">
                  {s.items.map((item, i) => (
                    <div key={i} className="docs-cl-item">
                      <div className="docs-cl-header">
                        <span className="docs-cl-version">{item.v}</span>
                        <span className="docs-cl-date">{item.date}</span>
                      </div>
                      <ul className="docs-cl-list">
                        {item.changes.map((c, j) => <li key={j}>{c}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : 'items' in s && Array.isArray(s.items) && 'label' in s.items[0] ? (
                <div className="docs-items">
                  {s.items.map((item, i) => (
                    <div key={i} className="docs-tech-item">
                      <strong>{item.label}</strong>
                      <span>{item.desc}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}

          <footer className="docs-footer">
            <p>re/file v0.2.0 · MIT 授權</p>
            <p>
              <a href="https://github.com/huchialun9-ctrl/refile" target="_blank" rel="noopener noreferrer">GitHub</a>
              <span className="docs-footer-sep">·</span>
              <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT 授權</a>
            </p>
          </footer>
        </main>
      </div>
    </div>
  )
}
