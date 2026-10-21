import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { watchYourData } from '../lib/bridge'

/**
 * Your data: everything Gnosis keeps about you, to see and clear (bridge/yourdata.mjs). Opened with
 * the Your data button, the Y key, or the tray menu. Private notes show their words only when you
 * ask; every delete is one click on the thing itself, and "clear" buttons ask once more.
 */

type Fact = { id: number; subject: string; predicate: string; value: string; sensitive: boolean }
type Exchange = { at: number | string; request: string; answer: string }
type View = {
  folder: string
  facts: Fact[]
  history: Exchange[]
  privateNotes: { id: number; saved: string; length: number }[]
  reminders: { id: number; kind: string; text: string; next: number; repeat: string }[]
  skills: { name: string; description: string; params: string[]; steps: number }[]
  attachments: { id: string; name: string; kind: string; size: number; at: number }[]
  voice: { enrolled: boolean; seconds?: number; at?: string }
  devices: { id: string; name: string; model: string; online: boolean }[]
  settings: Record<string, unknown>
  coding: { id: number; task: string; folder: string; status: string; started: number | null }[]
  conversations: { bytes: number; files: number }
  research: { bytes: number; files: number }
  logs: { bytes: number; files: number; path: string }
  models: { bytes: number; files: number }
  window: { bytes: number; files: number }
  total: { bytes: number; files: number }
}

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`)
const when = (t: number | string | undefined) => {
  if (t == null || t === '') return ''
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

async function call(body?: Record<string, unknown>) {
  const res = await fetch(`${BRIDGE_HTTP_URL}/data`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `The bridge answered ${res.status}`)
  return data
}

function Section({ title, count, children, empty }: { title: string; count?: string; children?: ReactNode; empty?: string }) {
  return (
    <section className="yd-sec">
      <div className="yd-sec-head"><h3>{title}</h3>{count && <span className="settings-dim">{count}</span>}</div>
      {children ?? <p className="settings-dim yd-empty">{empty}</p>}
    </section>
  )
}

export function YourData() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const [notes, setNotes] = useState<{ id: number; text: string; saved: string }[] | null>(null)
  const [status, setStatus] = useState('')
  const [confirm, setConfirm] = useState('')

  const load = useCallback(async () => {
    try {
      setView((await call()) as View)
    } catch (err) {
      setStatus((err as Error).message)
    }
  }, [])

  const act = async (what: string, extra: Record<string, unknown> = {}, sure = true) => {
    if (!sure) {
      setConfirm(what)
      return
    }
    setConfirm('')
    try {
      const r = await call({ what, ...extra })
      if (r.view) setView(r.view)
      if (what === 'show_private') setNotes(r.notes)
      if (what === 'delete_private') setNotes((n) => n?.filter((x) => x.id !== extra.id) ?? null)
      setStatus(r.ok === false ? 'That was already gone.' : '')
    } catch (err) {
      setStatus((err as Error).message)
    }
  }

  useEffect(() => {
    watchYourData(() => {
      setOpen(true)
      void load()
    })
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'y' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
    if (!open) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setOpen(false)
      setNotes(null)
    }
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [open])

  if (!open) return null
  const close = () => {
    setOpen(false)
    setNotes(null)
    setConfirm('')
  }
  const sure = (what: string) => confirm === what
  const X = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button className="yd-del" onClick={onClick} aria-label={label} title={label}>Delete</button>
  )

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="settings yd" role="dialog" aria-label="Your data">
        <header className="settings-head">
          <h2>Your data</h2>
          <button className="settings-x" onClick={close} aria-label="Close">Esc</button>
        </header>
        {!view ? <p className="settings-dim">{status || 'Loading…'}</p> : (
          <>
            <p className="settings-lead">
              Everything Gnosis keeps about you, {size(view.total.bytes)} in {view.total.files} files, all on this laptop.
              <button className="settings-btn yd-inline" onClick={() => act('open_folder')}>Open the folder</button>
            </p>

            <Section title="What he remembers" count={`${view.facts.length}`} empty="Nothing yet. Say “remember that…” to add something.">
              {view.facts.length ? (
                <ul className="yd-list">
                  {view.facts.map((f) => (
                    <li key={f.id}>
                      <span><b>{f.subject === 'owner' ? 'You' : f.subject}</b> · {f.predicate}: {f.value}{f.sensitive && <span className="settings-dim"> (sensitive)</span>}</span>
                      <X label={`Forget ${f.predicate}`} onClick={() => act('forget_fact', { id: f.id })} />
                    </li>
                  ))}
                  <li className="yd-all"><button className="settings-btn" onClick={() => act('forget_all_facts', {}, sure('forget_all_facts'))}>{sure('forget_all_facts') ? 'Click again to forget them all' : 'Forget all of these'}</button></li>
                </ul>
              ) : undefined}
            </Section>

            <Section title="Past conversations" count={`${view.history.length}`} empty="None kept yet.">
              {view.history.length ? (
                <ul className="yd-list">
                  {view.history.slice(0, 40).map((e) => (
                    <li key={String(e.at)}>
                      <span><span className="settings-dim">{when(e.at)}</span> “{e.request}” → {e.answer.length > 140 ? `${e.answer.slice(0, 140)}…` : e.answer}</span>
                      <X label="Forget this conversation" onClick={() => act('forget_exchange', { at: e.at })} />
                    </li>
                  ))}
                  {view.history.length > 40 && <li className="settings-dim">…and {view.history.length - 40} older ones.</li>}
                  <li className="yd-all"><button className="settings-btn" onClick={() => act('forget_history', {}, sure('forget_history'))}>{sure('forget_history') ? 'Click again to forget them all' : 'Forget all past conversations'}</button></li>
                </ul>
              ) : undefined}
            </Section>

            <Section title="Private notes (never sent to the cloud)" count={`${view.privateNotes.length}`} empty="None. Say a sentence with “private” in it to keep one.">
              {view.privateNotes.length ? (
                <ul className="yd-list">
                  {(notes ?? view.privateNotes.map((n) => ({ ...n, text: '' }))).map((n) => (
                    <li key={n.id}>
                      <span>{notes ? n.text : <span className="settings-dim">Hidden · saved {when(n.saved)}</span>}</span>
                      <X label="Delete this private note" onClick={() => act('delete_private', { id: n.id })} />
                    </li>
                  ))}
                  {!notes && <li className="yd-all"><button className="settings-btn" onClick={() => act('show_private')}>Show what they say</button></li>}
                </ul>
              ) : undefined}
            </Section>

            <Section title="Reminders and routines" count={`${view.reminders.length}`} empty="Nothing scheduled.">
              {view.reminders.length ? (
                <ul className="yd-list">
                  {view.reminders.map((j) => (
                    <li key={j.id}>
                      <span><b>{j.kind}</b> “{j.text}” · {when(j.next)}{j.repeat && j.repeat !== 'once' ? `, ${j.repeat}` : ''}</span>
                      <X label="Cancel it" onClick={() => act('cancel_reminder', { id: j.id })} />
                    </li>
                  ))}
                </ul>
              ) : undefined}
            </Section>

            <Section title="Skills he was taught" count={`${view.skills.length}`} empty="None. Say “watch me” to teach one.">
              {view.skills.length ? (
                <ul className="yd-list">
                  {view.skills.map((s) => (
                    <li key={s.name}>
                      <span><b>{s.name}</b> · {s.description} <span className="settings-dim">({s.steps} steps{s.params.length ? `, needs ${s.params.join(', ')}` : ''})</span></span>
                      <X label={`Delete ${s.name}`} onClick={() => act('delete_skill', { name: s.name })} />
                    </li>
                  ))}
                </ul>
              ) : undefined}
            </Section>

            <Section title="Files and pictures you gave him" count={`${view.attachments.length}`} empty="None. They're deleted a week after you drop them on his window.">
              {view.attachments.length ? (
                <ul className="yd-list">
                  {view.attachments.map((a) => (
                    <li key={a.id}>
                      <span>{a.name} <span className="settings-dim">· {size(a.size)} · {when(a.at)}</span></span>
                      <X label={`Delete ${a.name}`} onClick={() => act('delete_attachment', { id: a.id })} />
                    </li>
                  ))}
                </ul>
              ) : undefined}
            </Section>

            <Section title="Voice print (voice ID)">
              <ul className="yd-list">
                <li>
                  <span>{view.voice.enrolled ? `He knows your voice (learned from ${view.voice.seconds} s of speech, ${when(view.voice.at)}). It's numbers, not a recording.` : 'Not set up. Settings → Voice ID.'}</span>
                  {view.voice.enrolled && <X label="Forget my voice" onClick={() => act('forget_voice', {}, sure('forget_voice'))} />}
                </li>
                {sure('forget_voice') && <li className="yd-all"><button className="settings-btn" onClick={() => act('forget_voice')}>Click to forget your voice (voice ID off)</button></li>}
              </ul>
            </Section>

            {view.devices.length > 0 && (
              <Section title="Paired devices" count={`${view.devices.length}`}>
                <ul className="yd-list">
                  {view.devices.map((d) => (
                    <li key={d.id}>
                      <span>{d.name} <span className="settings-dim">· {d.model} · {d.online ? 'connected' : 'not connected'}</span></span>
                      <X label={`Unpair ${d.name}`} onClick={() => act('forget_device', { id: d.id })} />
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Coding jobs (Claude Code)" count={`${view.coding.length}`} empty="None yet. Ask him to build something.">
              {view.coding.length ? (
                <ul className="yd-list">
                  {view.coding.slice(0, 20).map((j) => (
                    <li key={j.id}><span><b>#{j.id}</b> {j.status} · “{j.task.length > 100 ? `${j.task.slice(0, 100)}…` : j.task}” <span className="settings-dim">· {j.folder}{j.started ? ` · ${when(j.started)}` : ''}</span></span></li>
                  ))}
                  <li className="settings-dim">The projects are your work: they stay in their folders, and nothing here deletes them.</li>
                </ul>
              ) : undefined}
            </Section>

            <Section title="Your settings">
              <ul className="yd-list">
                {Object.keys(view.settings).length
                  ? Object.entries(view.settings).map(([k, v]) => <li key={k}><span>{k}: {String(v)}</span></li>)
                  : <li className="settings-dim">All at their defaults. Change them in Settings. Keys are in Windows Credential Manager, not here.</li>}
              </ul>
            </Section>

            <Section title="Records">
              <ul className="yd-list">
                <li>
                  <span>Running conversation, kept so he can carry on after a restart <span className="settings-dim">· {size(view.conversations.bytes)}</span></span>
                  {view.conversations.files > 0 && <button className="yd-del" onClick={() => act('clear_conversations', {}, sure('clear_conversations'))}>{sure('clear_conversations') ? 'Sure?' : 'Clear'}</button>}
                </li>
                <li>
                  <span>Saved research <span className="settings-dim">· {view.research.files} files, {size(view.research.bytes)}</span></span>
                  {view.research.files > 0 && <button className="yd-del" onClick={() => act('clear_research', {}, sure('clear_research'))}>{sure('clear_research') ? 'Sure?' : 'Clear'}</button>}
                </li>
                <li><span>Logs of what he did, day by day <span className="settings-dim">· {view.logs.files} files, {size(view.logs.bytes)} (in the folder)</span></span></li>
                <li><span>App files, not about you: the voice ID model <span className="settings-dim">· {size(view.models.bytes)}</span>, and his window's own storage <span className="settings-dim">· {size(view.window.bytes)}</span></span></li>
              </ul>
            </Section>
          </>
        )}
        <footer className="settings-foot"><span className="settings-dim">{status}</span><button className="settings-btn" onClick={() => void load()}>Refresh</button></footer>
      </section>
    </div>
  )
}
