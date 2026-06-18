import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

// 🚨 1. 網頁全域錯誤監聽（肉眼除錯器）：只要網頁自爆，直接把錯誤字串強行寫在螢幕最上層
if (typeof window !== 'undefined') {
  const logErrorToScreen = (msg: string, url: string, line: number) => {
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '0';
    div.style.left = '0';
    div.style.width = '100%';
    div.style.height = '100%';
    div.style.background = 'rgba(255, 0, 0, 0.95)';
    div.style.color = 'white';
    div.style.zIndex = '999999';
    div.style.padding = '20px';
    div.style.fontSize = '16px';
    div.style.fontFamily = 'monospace';
    div.style.overflow = 'auto';
    div.innerHTML = `<h1>💥 網頁卡死報錯</h1><p><strong>錯誤訊息:</strong> ${msg}</p><p><strong>檔案路徑:</strong> ${url}</p><p><strong>行號:</strong> ${line}</p>`;
    document.documentElement.appendChild(div);
  };

  window.onerror = function(message, source, lineno) {
    logErrorToScreen(String(message), String(source), lineno || 0);
  };

  window.addEventListener('unhandledrejection', function(event) {
    logErrorToScreen('Promise 異步崩潰: ' + String(event.reason?.message || event.reason), '', 0);
  });
}

interface TauriWindow {
  __TAURI__?: {
    core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    pluginNotification: {
      requestPermission: () => Promise<string>
      isPermissionGranted: () => Promise<boolean>
      sendNotification: (options: unknown) => void
    }
  }
}

// 🛠️ 2. 網頁環境偽造 Tauri API（避免瀏覽器執行時因 import Tauri 套件報錯）
if (typeof window !== 'undefined' && !(window as unknown as TauriWindow).__TAURI__) {
  const tw = window as unknown as TauriWindow
  tw.__TAURI__ = {
    core: { invoke: () => Promise.resolve(null) },
    pluginNotification: {
      requestPermission: () => Promise.resolve('granted'),
      isPermissionGranted: () => Promise.resolve(true),
      sendNotification: () => {}
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
