import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhTW from './zh-TW.json'
import en from './en.json'

const saved = typeof window !== 'undefined' ? localStorage.getItem('reflie_lang') : null

i18n.use(initReactI18next).init({
  resources: { 'zh-TW': { translation: zhTW }, en: { translation: en } },
  lng: saved || (typeof navigator !== 'undefined' ? (navigator.language.startsWith('zh') ? 'zh-TW' : 'en') : 'zh-TW'),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function setLanguage(lang: 'zh-TW' | 'en') {
  i18n.changeLanguage(lang)
  try { localStorage.setItem('reflie_lang', lang) } catch {}
}

export default i18n
