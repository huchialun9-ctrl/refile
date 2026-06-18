import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'mock-tauri',
      resolveId(id) {
        if (id.startsWith('@tauri-apps/')) {
          return '\0virtual:tauri'
        }
      },
      load(id) {
        if (id === '\0virtual:tauri') {
          return `
            // 🛠️ 補齊所有可能被 App.tsx 和 FolderCard.tsx 具名引入的 Tauri 函式
            export const open = () => Promise.resolve(null);
            export const invoke = () => Promise.resolve(null);
            export const listen = () => Promise.resolve(() => {});
            export const emit = () => Promise.resolve();
            
            // 補齊通知外掛所需的全部具名導出
            export const sendNotification = () => {};
            export const isPermissionGranted = () => Promise.resolve(true);
            export const requestPermission = () => Promise.resolve('granted');
            
            export const getCurrentWindow = () => ({
              listen: () => Promise.resolve(() => {}),
              once: () => Promise.resolve(() => {})
            });
            
            export default { 
              open, invoke, listen, emit, 
              sendNotification, isPermissionGranted, requestPermission,
              getCurrentWindow 
            };
          `
        }
      }
    }
  ],
  base: './',
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
