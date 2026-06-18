import { useEffect } from 'react'

interface Props {
  darkMode: boolean
  setDarkMode: (v: boolean) => void
}

const sections = [
  {
    id: 'intro',
    title: '什麼是 re/file？',
    content: [
      're/file 是一款點對點（P2P）加密檔案傳輸工具。不需註冊帳號，不需上傳到任何伺服器，兩個裝置之間直接連線傳輸檔案。',
      '支援桌面版（Tauri）與網頁版（WebRTC），檔案傳輸全程 AES-GCM 加密，傳完即不留暫存。',
    ],
  },
  {
    id: 'quickstart',
    title: '快速開始',
    steps: [
      '在首頁複製你的 8 碼 ID，或透過 QR Code 分享',
      '將你的 ID 提供給對方，或輸入對方的 ID',
      '點擊「連線」按鈕，等待配對完成',
      '連線成功後，直接拖曳檔案到畫面中央，或點擊「選擇檔案」',
      '也可以使用文字傳送功能分享密碼、網址等',
    ],
  },
  {
    id: 'security',
    title: '安全性',
    items: [
      { label: '端到端加密', desc: '所有檔案傳輸使用 AES-GCM 256-bit 加密，金鑰只在兩個裝置之間交換' },
      { label: '直連傳輸', desc: '檔案不經過任何伺服器，透過 WebRTC 或直接 TCP 連線傳輸' },
      { label: '不留暫存', desc: '傳輸完成後，除了接收端儲存的檔案外，系統不留任何暫存檔案' },
      { label: '開放原始碼', desc: '完整原始碼在 GitHub，接受社群審查，MIT 授權自由使用' },
    ],
  },
  {
    id: 'tech',
    title: '技術架構',
    items: [
      { label: '前端', desc: 'React 19 + TypeScript + Vite' },
      { label: '桌面端', desc: 'Tauri v2（Rust 後端），支援 Windows / macOS / Linux' },
      { label: 'P2P 傳輸', desc: 'WebRTC（網頁版）/ 直接 TCP Socket（桌面版）' },
      { label: '加密', desc: 'AES-GCM 256-bit，金鑰透過 x25519 ECDH 交換' },
      { label: '發現協議', desc: 'mDNS（區網）/ WebSocket Signal Server（網際網路）' },
      { label: '傳輸效率', desc: '4MB 區塊串流，200ms 進度同步' },
    ],
  },
  {
    id: 'faq',
    title: '常見問題',
    items: [
      { q: '需要註冊帳號嗎？', a: '不需要。re/file 不要求任何帳號或個人資訊，安裝後即可使用。' },
      { q: '檔案會經過伺服器嗎？', a: '不會。檔案直接從你的裝置傳到對方裝置，不經過任何伺服器。' },
      { q: '有檔案大小限制嗎？', a: '沒有限制。支援任意大小檔案，透過 4MB 區塊串流傳輸。' },
      { q: '網頁版和桌面版有什麼差別？', a: '桌面版使用原生 TCP Socket，傳輸速度更快且支援區網自動發現。網頁版只需瀏覽器即可使用。' },
      { q: '如何在防火牆後使用？', a: '桌面版使用直接 TCP 連線；網頁版透過 WebRTC 使用 ICE/STUN/TURN 協定穿透 NAT。' },
    ],
  },
  {
    id: 'changelog',
    title: '版本歷史',
    items: [
      {
        v: 'v0.2.1', date: '2025-06-18',
        changes: [
          'TypeScript 全面強化：移除 14 處 any 型別，導入完整 BLE、WebRTC 介面',
          '修復 Blob URL 記憶體洩漏 — cancel/error 時正確釋放',
          '修復 stale closure 問題 — handleShowQR 改用 useRef 模式',
          'DownloadPage 加入離線提示 + 重試按鈕 + 手機 RWD 斷點',
          'GitHub API 回傳空值時自動補上靜態備份版本資料',
          'open_folder 跨平台支援：explorer → open → xdg-open 依序嘗試',
          'mDNS 註冊失敗改為 log::warn 輸出，不再靜默忽略',
          'CSS 核心變數後備機制，index.css 載入失敗仍可正常顯示',
          '修復 hoisting bug：useRef 初始化時造成暫時性死區錯誤',
        ],
      },
      {
        v: 'v0.2.0', date: '2025-06-10',
        changes: [
          'Web Bluetooth API 支援 BLE 掃描與配對，手機/桌機互連',
          '網頁版 WebRTC P2P 傳輸，瀏覽器直接傳檔免安裝',
          '改善連線體驗：更快握手、直覺狀態提示',
          '裝置端 QR Code 連線，手機掃碼即配對',
          '支援 Ctrl+V 貼上圖片/檔案/網址直接傳送',
          '桌面版原生拖曳傳檔，無 base64 記憶體問題',
          '連線逾時由 15 秒延長至 30 秒，搭配 7 組 STUN 伺服器',
          '加入 aria-label 支援無障礙瀏覽',
          '下載頁面加入 WebView2 必要元件提示',
          'PrivacyModal 自動接受 / 信任裝置功能實裝',
          '預設視窗尺寸 800×600 → 1100×720',
        ],
      },
      {
        v: 'v0.1.0', date: '2025-05',
        changes: [
          '初始版本發布',
          'P2P 加密檔案傳輸',
          'WebRTC 網頁版支援',
          'mDNS 區網自動發現裝置',
          '雙面板傳輸時間軸',
          '暗色 / 亮色主題切換',
          '系統通知與隱私設定',
        ],
      },
    ],
  },
  {
    id: 'license',
    title: '授權資訊',
    content: [
      're/file 使用 MIT 授權條款發布。你可以自由使用、修改、分發本軟體，但需保留原始版權宣告。',
      '本軟體按「原樣」提供，不提供任何明示或默示的擔保，包括但不限於適售性、特定用途適用性及不侵權的擔保。',
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
