# re/file

**跨平台點對點加密檔案傳輸工具**
不需要伺服器、不需要註冊、打開就能傳。

## 功能

- **P2P 加密傳輸** — 檔案直接點對點傳送，不經過任何伺服器
- **mDNS 自動發現** — 區網內裝置自動出現，不用打 IP
- **Web 版** — 沒裝桌面版也能用瀏覽器收發（WebRTC）
- **TLS 1.3 加密** + SHA256 校驗
- **多檔同時傳送/接收**，每 200ms 進度同步
- **系統匣 + 通知** — 縮到背景，傳完會跳通知
- **深色/淺色主題**
- **跨平台** — Windows / macOS / Linux

## 快速開始

```bash
git clone https://github.com/huchialun9-ctrl/refile.git
cd refile
npm install
npm run dev          # 啟動 Web 版（http://localhost:5173）
```

桌面版需要 Rust 工具鏈：

```bash
# Windows MSVC
rustup override set stable-x86_64-pc-windows-msvc
# 然後在 Visual Studio Developer Command Prompt 下編譯
npm run tauri dev
```

## 開發指令

```bash
npm run dev          # Vite dev server
npm run build        # 生產構建
npm run lint         # ESLint 檢查
npm test             # 跑測試
npm run test:watch   # 監聽模式
npx tsc --noEmit     # TypeScript 型別檢查
cd src-tauri && cargo check  # Rust 編譯檢查
```

## 環境變數

複製 `.env.example` 為 `.env` 可自訂信號伺服器位址：

```env
VITE_SIGNAL_URLS=ws://your-server:3001/ws,ws://fallback:5000/ws
```

## 技術棧

| 層級 | 技術 |
|------|------|
| 前端 | React 19 + TypeScript + Vite |
| 桌面殼層 | Tauri 2 |
| P2P 信號 | WebSocket |
| P2P 傳輸 | WebRTC（Web）/ TCP + TLS（桌面） |
| 加密 | rustls + rcgen（自簽 TLS） |
| 區網發現 | mdns-sd |
| 藍牙發現 | Web Bluetooth API / btleplug |

## 架構

```
Web 瀏覽器                 桌面應用程式
┌────────────┐            ┌─────────────────────┐
│  WebApp    │            │  React + TypeScript  │
│  (WebRTC)  │            │  (Tauri WebView)     │
└─────┬──────┘            └─────────┬───────────┘
      │                            │
      │    WebSocket (信號交換)     │
      ├────────────────────────────┤
      │                            │
      │    WebRTC / TCP+TLS        │
      │    (P2P 檔案傳輸)           │
      └────────────────────────────┘
```

## 授權

MIT
