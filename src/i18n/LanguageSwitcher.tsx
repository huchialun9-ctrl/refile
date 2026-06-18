import { useTranslation } from 'react-i18next'
import { setLanguage } from './index'

export default function LanguageSwitcher() {
  const { i18n } = useTranslation()
  const current = i18n.language
  const isZh = current.startsWith('zh')

  return (
    <button className="lang-switch" onClick={() => setLanguage(isZh ? 'en' : 'zh-TW')}
      aria-label={isZh ? 'Switch to English' : '切換至中文'}>
      {isZh ? 'EN' : '中文'}
    </button>
  )
}
