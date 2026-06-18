import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const REPO = 'huchialun9-ctrl/refile'
const CURRENT_VERSION = '0.2.0'

interface GitHubRelease {
  tag_name: string
  html_url: string
  published_at: string
  body: string | null
}

export default function UpdateChecker() {
  const { t } = useTranslation()
  const [latest, setLatest] = useState<GitHubRelease | null>(null)
  const [checking, setChecking] = useState(true)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('reflie_update_dismissed') === CURRENT_VERSION } catch { return false }
  })

  useEffect(() => {
    let cancelled = false
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    }).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json() as Promise<GitHubRelease>
    }).then(data => {
      if (cancelled) return
      const tag = data.tag_name.replace(/^v/, '')
      if (compareVersions(tag, CURRENT_VERSION) > 0) {
        setLatest(data)
      }
    }).catch(() => {}).finally(() => {
      if (!cancelled) setChecking(false)
    })
    return () => { cancelled = true }
  }, [])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
    try { localStorage.setItem('reflie_update_dismissed', CURRENT_VERSION) } catch {}
  }, [])

  if (checking || dismissed || !latest) return null

  return (
    <div className="update-overlay">
      <div className="update-prompt">
        <div className="update-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div className="update-text">
          <strong>{t('update.available', { version: latest.tag_name.replace(/^v/, '') })}</strong>
          <span>{t('update.current', { version: CURRENT_VERSION })}</span>
        </div>
        <div className="update-actions">
          <a className="update-btn update-primary" href={latest.html_url} target="_blank" rel="noopener noreferrer">
            {t('update.download')}
          </a>
          <button className="update-btn update-skip" onClick={handleDismiss}>
            {t('update.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}
