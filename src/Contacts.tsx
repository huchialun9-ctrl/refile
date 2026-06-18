import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const STORAGE_KEY = 'reflie_contacts'

interface Contact {
  id: string
  name: string
}

function loadContacts(): Contact[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Contact[]
  } catch {}
  return []
}

function saveContacts(contacts: Contact[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts)) } catch {}
}

export default function Contacts({ onConnect }: { onConnect: (id: string) => void }) {
  const { t } = useTranslation()
  const [contacts, setContacts] = useState<Contact[]>(() => loadContacts())
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newId, setNewId] = useState('')

  useEffect(() => { saveContacts(contacts) }, [contacts])

  const addContact = useCallback(() => {
    const id = newId.replace(/[^A-Fa-f0-9]/g, '').toUpperCase().slice(0, 8)
    if (!id || id.length < 6) return
    setContacts(prev => {
      if (prev.some(c => c.id === id)) return prev
      return [...prev, { id, name: newName.trim() || id.slice(0, 8) }]
    })
    setNewName('')
    setNewId('')
    setAdding(false)
  }, [newId, newName])

  const removeContact = useCallback((id: string) => {
    setContacts(prev => prev.filter(c => c.id !== id))
  }, [])

  return (
    <div className="wc-section wc-contacts">
      <span className="wc-label">
        {t('contacts.title')} ({contacts.length})
      </span>
      {contacts.length === 0 && !adding && (
        <span className="wc-muted" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
          {t('contacts.empty')}
        </span>
      )}
      {contacts.length > 0 && (
        <div className="wc-peer-list" style={{ marginTop: 4 }}>
          {contacts.map(c => (
            <div key={c.id} className="wc-contact-row">
              <div className="wc-contact-info">
                <span className="wc-contact-name">{c.name}</span>
                <span className="wc-contact-id">{fmtContactId(c.id)}</span>
              </div>
              <div className="wc-contact-actions">
                <button className="wc-contact-connect" onClick={() => onConnect(c.id)}
                  title={t('contacts.connect')} aria-label={`${t('contacts.connect')} ${c.name}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M5 12h14"/><path d="M12 5l7 7-7 7"/>
                  </svg>
                </button>
                <button className="wc-contact-remove" onClick={() => removeContact(c.id)}
                  title={t('contacts.remove')} aria-label={`${t('contacts.remove')} ${c.name}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div className="wc-contact-add-form">
          <input className="wc-contact-input" placeholder={t('contacts.namePlaceholder')}
            value={newName} onChange={e => setNewName(e.target.value)}
            maxLength={20} aria-label={t('contacts.namePlaceholder')} />
          <input className="wc-contact-input" placeholder={t('contacts.idPlaceholder')}
            value={newId} onChange={e => setNewId(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 8))}
            maxLength={8} aria-label={t('contacts.idPlaceholder')} />
          <div className="wc-contact-add-actions">
            <button className="bt-scan-btn" onClick={addContact} disabled={newId.replace(/[^A-F0-9]/g, '').length < 6}>
              {t('contacts.save')}
            </button>
            <button className="bt-clear-btn" onClick={() => { setAdding(false); setNewName(''); setNewId('') }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button className="bt-scan-btn" onClick={() => setAdding(true)} style={{ marginTop: 6 }}>
          {t('contacts.add')}
        </button>
      )}
    </div>
  )
}

function fmtContactId(id: string): string {
  if (id.length <= 4) return id
  return id.slice(0, 4) + '-' + id.slice(4, 8)
}
