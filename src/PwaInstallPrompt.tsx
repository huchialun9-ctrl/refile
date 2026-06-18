import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null

function usePwaInstall() {
  const [installable, setInstallable] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      deferredPrompt = e as BeforeInstallPromptEvent
      setInstallable(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const install = useCallback(async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    await deferredPrompt.userChoice
    deferredPrompt = null
    setInstallable(false)
  }, [])

  const dismiss = useCallback(() => {
    deferredPrompt = null
    setInstallable(false)
  }, [])

  return { installable, install, dismiss }
}

export default function PwaInstallPrompt() {
  const { t } = useTranslation()
  const { installable, install, dismiss } = usePwaInstall()
  const [dismissed, setDismissed] = useState(false)

  if (!installable || dismissed) return null

  return (
    <div className="pwa-prompt-overlay">
      <div className="pwa-prompt">
        <div className="pwa-prompt-icon">
          <svg width="40" height="40" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="6" fill="#6d5df4"/>
            <path d="M7 12h8l2-3h8v13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V12z" fill="#fff" opacity="0.9"/>
            <path d="M7 12V9a2 2 0 0 1 2-2h5l2 3H7z" fill="#fff" opacity="0.6"/>
            <text x="16" y="22" fontFamily="Arial,sans-serif" fontWeight="700" fontSize="9" fill="#6d5df4" textAnchor="middle">re</text>
          </svg>
        </div>
        <div className="pwa-prompt-text">
          <strong>{t('pwa.installTitle')}</strong>
          <span>{t('pwa.installDesc')}</span>
        </div>
        <div className="pwa-prompt-actions">
          <button className="pwa-prompt-btn pwa-prompt-primary" onClick={() => { install(); setDismissed(true) }}>
            {t('pwa.install')}
          </button>
          <button className="pwa-prompt-btn pwa-prompt-cancel" onClick={() => { dismiss(); setDismissed(true) }}>
            {t('pwa.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
