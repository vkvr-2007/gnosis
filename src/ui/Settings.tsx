import { useCallback, useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { watchSettings } from '../lib/bridge'

/**
 * Settings: what Gnosis calls you, his voice, the morning briefing, quiet hours, and his keys.
 *
 * Opened with S, from the tray's Settings item, or by itself on first run when there is no NVIDIA
 * key yet. Everything is saved by the bridge (bridge/settings.mjs, secrets.mjs): the keys go to
 * Windows Credential Manager and are never sent back here, only whether each one is set. Saving
 * a name, voice, quiet hours or a key restarts the bridge, and this window reconnects by itself.
 */

type KeyState = { label: string; about: string; url: string; needed: boolean; set: boolean; from: 'environment' | 'saved' | null }
type Loaded = {
  honorific: string
  voiceId: string
  quietHours: string
  briefing: string
  keys: Record<string, KeyState>
}

const call = async (path: string, body?: unknown) => {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `The bridge answered ${res.status}`)
  return data
}

export function Settings() {
  const [open, setOpen] = useState(false)
  const [first, setFirst] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [form, setForm] = useState({ honorific: '', voiceId: '', quiet: true, quietFrom: '23:00', quietTo: '07:00', briefingOn: true, briefing: '08:00' })
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = (await call('/settings')) as Loaded
      setLoaded(s)
      const [qf, qt] = s.quietHours === 'off' ? ['23:00', '07:00'] : s.quietHours.split('-')
      setForm({
        honorific: s.honorific, voiceId: s.voiceId, quiet: s.quietHours !== 'off', quietFrom: qf, quietTo: qt,
        briefingOn: s.briefing !== 'off', briefing: s.briefing === 'off' ? '08:00' : s.briefing,
      })
      setKeys({})
      setTests({})
      return s
    } catch {
      setStatus("Gnosis isn't answering yet.")
      return null
    }
  }, [])

  // First run: no NVIDIA key yet, so he can't think. Ask for it.
  useEffect(() => {
    let tries = 0
    const check = async () => {
      const s = await load().catch(() => null)
      if (!s && tries++ < 10) return void setTimeout(check, 3000)
      if (s && !s.keys.NVIDIA_API_KEY?.set) {
        setFirst(true)
        setOpen(true)
      }
    }
    void check()
  }, [load])

  useEffect(() => {
    watchSettings(() => {
      void load()
      setOpen(true)
    })
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 's' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => {
          if (!o) void load()
          return !o
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [load])

  useEffect(() => {
    if (!open || first) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setOpen(false)
      setStatus('')
    }
    // Capture: Esc closes this first, before it reaches Gnosis's own stop.
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [open, first])

  if (!open) return null

  const close = () => {
    setOpen(false)
    setFirst(false)
    setStatus('')
  }

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: 'Checking…' }))
    try {
      const r = await call('/settings/test', { name, value: keys[name] || undefined })
      setTests((t) => ({ ...t, [name]: r.ok ? 'Works' : r.why }))
    } catch (err) {
      setTests((t) => ({ ...t, [name]: (err as Error).message }))
    }
  }

  const save = async () => {
    if (!loaded) return
    const patch: Record<string, unknown> = {}
    if (form.honorific !== loaded.honorific) patch.honorific = form.honorific
    if (form.voiceId !== loaded.voiceId) patch.voiceId = form.voiceId
    const quiet = form.quiet ? `${form.quietFrom}-${form.quietTo}` : 'off'
    if (quiet !== loaded.quietHours) patch.quietHours = quiet
    const briefing = form.briefingOn ? form.briefing : 'off'
    if (briefing !== loaded.briefing) patch.briefing = briefing
    const typed = Object.fromEntries(Object.entries(keys).filter(([, v]) => v.trim()))
    if (Object.keys(typed).length) patch.keys = typed
    if (!Object.keys(patch).length) return close()
    setSaving(true)
    setStatus('Saving…')
    try {
      const r = await call('/settings', patch)
      if (r.restart) {
        setStatus('Saved. Gnosis is restarting with it…')
        // The bridge goes away for a few seconds and this window reconnects; then show the result.
        setTimeout(async () => {
          for (let i = 0; i < 20; i++) {
            await new Promise((ok) => setTimeout(ok, 1000))
            if (await load()) break
          }
          setSaving(false)
          setFirst(false)
          setStatus('Saved.')
        }, 2500)
      } else {
        await load()
        setSaving(false)
        setStatus('Saved.')
      }
    } catch (err) {
      setSaving(false)
      setStatus((err as Error).message)
    }
  }

  const keyList = loaded ? Object.entries(loaded.keys) : []

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !first && close()}>
      <section className="settings" role="dialog" aria-label="Settings">
        <header className="settings-head">
          <h2>{first ? 'Welcome to Gnosis' : 'Settings'}</h2>
          {!first && <button className="settings-x" onClick={close} aria-label="Close">Esc</button>}
        </header>
        {first && <p className="settings-lead">Paste your NVIDIA key to start. It's kept in Windows Credential Manager on this laptop.</p>}

        {!first && (
          <>
            <div className="settings-sec">You</div>
            <label className="settings-row">
              <span>What he calls you</span>
              <input value={form.honorific} maxLength={40} placeholder="Your name" onChange={(e) => setForm({ ...form, honorific: e.target.value })} />
            </label>

            <div className="settings-sec">His voice</div>
            <label className="settings-row">
              <span>ElevenLabs voice ID</span>
              <input value={form.voiceId} placeholder="uPAdReDjrJ1KtAcuguzK" spellCheck={false} onChange={(e) => setForm({ ...form, voiceId: e.target.value.trim() })} />
            </label>

            <div className="settings-sec">Your day</div>
            <div className="settings-row">
              <label className="settings-check"><input type="checkbox" checked={form.briefingOn} onChange={(e) => setForm({ ...form, briefingOn: e.target.checked })} /> Morning briefing at</label>
              <input type="time" value={form.briefing} disabled={!form.briefingOn} onChange={(e) => setForm({ ...form, briefing: e.target.value })} />
            </div>
            <div className="settings-row">
              <label className="settings-check"><input type="checkbox" checked={form.quiet} onChange={(e) => setForm({ ...form, quiet: e.target.checked })} /> Quiet hours</label>
              <span className="settings-pair">
                <input type="time" value={form.quietFrom} disabled={!form.quiet} onChange={(e) => setForm({ ...form, quietFrom: e.target.value })} />
                <span>to</span>
                <input type="time" value={form.quietTo} disabled={!form.quiet} onChange={(e) => setForm({ ...form, quietTo: e.target.value })} />
              </span>
            </div>
          </>
        )}

        <div className="settings-sec">Keys</div>
        {keyList.filter(([name]) => !first || name === 'NVIDIA_API_KEY').map(([name, k]) => (
          <div className="settings-key" key={name}>
            <div className="settings-key-top">
              <span><b>{k.label}</b> <span className="settings-dim">{k.about}</span></span>
              <span className={k.set ? 'settings-ok' : k.needed ? 'settings-bad' : 'settings-dim'}>
                {k.set ? (k.from === 'environment' ? 'set (Windows environment)' : 'saved') : 'not set'}
              </span>
            </div>
            <div className="settings-key-row">
              <input type="password" autoComplete="off" spellCheck={false} placeholder={k.set ? 'Paste a new key to replace it' : 'Paste the key'}
                value={keys[name] ?? ''} onChange={(e) => setKeys({ ...keys, [name]: e.target.value })} />
              <button className="settings-btn" onClick={() => test(name)} disabled={!k.set && !keys[name]}>Test</button>
            </div>
            <div className="settings-key-foot">
              {tests[name] ? <span className={tests[name] === 'Works' ? 'settings-ok' : 'settings-bad'}>{tests[name]}</span>
                : <a href={k.url} target="_blank" rel="noreferrer">Get a key</a>}
            </div>
          </div>
        ))}

        <footer className="settings-foot">
          <span className="settings-dim">{status}</span>
          <button className="settings-btn settings-primary" onClick={save} disabled={saving || !loaded}>
            {first ? 'Start Gnosis' : 'Save'}
          </button>
        </footer>
      </section>
    </div>
  )
}
