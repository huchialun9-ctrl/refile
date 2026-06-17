# re/file

**跨平台點對點加密檔案傳輸工具**  
不需要伺服器、不需要註冊、打開就能傳。

<!-- 截圖範例 — 實際使用時請放一張 App 主畫面的截圖到 docs/screenshot-main.png -->

---

## 這東西是幹嘛的

區網內兩台電腦要傳檔案，不用隨身碟、不用開雲端硬碟、不用 line 傳。  
打開 re/file，選裝置，拖檔案，就這樣。

- 完全點對點，檔案不經過任何伺服器
- mDNS 自動掃區網，裝好就能找到對方
- 傳輸過程 TLS 加密 + SHA256 校驗
- 支援同時多檔傳送、接收
- 傳到一半關掉重開，進度不會消失（localStorage 有記）

<!-- 截圖範例 — 實際使用時請放一張傳輸過程的截圖到 docs/screenshot-transfer.png -->

## 怎麼裝

### Windows

從 [GitHub Releases](https://github.com/huchialun9-ctrl/refile/releases) 下載：

- `reflie.exe` — 免安裝綠色版
- `reflie_*_x64-setup.exe` — NSIS 安裝程式
- `reflie_*_x64_en-US.msi` — MSI 安裝程式

macOS / Linux 版本待補。

### 自己編

```bash
# 需要 Rust + Node.js
git clone https://github.com/huchialun9-ctrl/refile.git
cd refile
npm install
npm run tauri dev
```

Windows 下需要 MSVC 工具鏈（Visual Studio Build Tools 2022 + Windows SDK）。

```bash
# 設定 MSVC 編譯器
rustup override set stable-x86_64-pc-windows-msvc
# 然後用 vcvars64.bat 初始化環境後編譯
```

## 架構

```
┌─────────────────────┐
│  React + TypeScript │  ← Tauri WebView
│  (Vite)             │
├─────────────────────┤
│  Rust Backend       │  ← Tauri core
│  ├─ mDNS Discovery  │     mdns-sd
│  ├─ Control Channel │     TCP + JSON
│  ├─ Data Channel    │     TLS + 4MB chunks
│  ├─ Transfer Engine │     排程 + session 管理
│  └─ Crypto          │     self-signed TLS + SHA256
├─────────────────────┤
│  System Tray        │     最小化到系統匣
│  Notifications      │     WinRT 原生通知
└─────────────────────┘
```

## 技術選型

| 層級 | 技術 | 原因 |
|------|------|------|
| 前端框架 | React 19 + TypeScript | 生態成熟 |
| 桌面殼層 | Tauri 2 | 比 Electron 小很多 |
| 加密 | rustls + rcgen | 純 Rust TLS |
| 區網發現 | mdns-sd | 零設定自動廣播 |
| 進度同步 | 自訂 TCP JSON 協定 | 每 200ms 雙向同步 |
| 傳輸 | 4MB chunk streaming | 記憶體佔用固定 |

## 隱私

- 不做帳號、不蒐集資料、不發送任何分析
- 所有傳輸走 TLS 加密
- 檔案傳完不留暫存（接收端存到 `downloads/`）
- 原始碼都在這，有意見直接開 issue

## 授權

MIT
