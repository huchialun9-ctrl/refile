import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DownloadPage from '../DownloadPage'

describe('DownloadPage', () => {
  it('renders download section heading', () => {
    render(<DownloadPage darkMode={false} setDarkMode={() => {}} />)
    expect(screen.getByText('下載桌面應用程式')).toBeInTheDocument()
  })

  it('renders feature items', () => {
    render(<DownloadPage darkMode={false} setDarkMode={() => {}} />)
    expect(screen.getByText('端到端加密')).toBeInTheDocument()
    expect(screen.getByText('區塊串流傳輸')).toBeInTheDocument()
  })
})
