import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore, type Attachment } from '../store'

/**
 * Files and pictures for Gnosis: drop them on his window, or paste (Ctrl+V) a copied picture or file.
 * Each goes to the bridge at once (bridge/attachments.mjs) and waits here as a chip; the next
 * question (Space, then ask) takes them along. A chip's × leaves one out.
 */

async function upload(file: File): Promise<Attachment> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/attach`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'pasted') },
    body: file,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `The bridge answered ${res.status}`)
  return data as Attachment
}

const icon = (kind: Attachment['kind']) => (kind === 'image' ? 'Picture' : kind === 'text' ? 'File' : 'File (can\'t read yet)')

export function Attachments() {
  const attachments = useStore((s) => s.attachments)
  const add = useStore((s) => s.addAttachment)
  const remove = useStore((s) => s.removeAttachment)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const send = async (files: File[]) => {
      if (!files.length) return
      setError('')
      setBusy((n) => n + files.length)
      for (const f of files.slice(0, 6)) {
        try {
          add(await upload(f))
        } catch (err) {
          setError(`${f.name || 'That file'}: ${(err as Error).message}`)
        } finally {
          setBusy((n) => n - 1)
        }
      }
    }
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setOver(true)
    }
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setOver(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setOver(false)
      void send(Array.from(e.dataTransfer?.files ?? []))
    }
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const files = Array.from(e.clipboardData?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      void send(files.map((f, i) => (f.name ? f : new File([f], `pasted-${i + 1}.png`, { type: f.type }))))
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [add])

  return (
    <>
      {over && (
        <div className="attach-drop" aria-hidden="true">
          <span>Drop to give it to Gnosis</span>
        </div>
      )}
      {(attachments.length > 0 || busy > 0 || error) && (
        <div className="attach-tray" aria-live="polite">
          {attachments.map((a) => (
            <span className="attach-chip" key={a.id} title={`${icon(a.kind)}, ${Math.max(1, Math.round(a.size / 1024))} KB`}>
              <span className="attach-kind">{a.kind === 'image' ? 'IMG' : a.kind === 'text' ? 'TXT' : 'FILE'}</span>
              <span className="attach-name">{a.name}</span>
              <button className="attach-x" onClick={() => remove(a.id)} aria-label={`Leave out ${a.name}`}>×</button>
            </span>
          ))}
          {busy > 0 && <span className="attach-note">Adding…</span>}
          {error && <span className="attach-note attach-bad">{error}</span>}
          {attachments.length > 0 && !busy && <span className="attach-note">Press Space and ask about {attachments.length === 1 ? 'it' : 'them'}</span>}
        </div>
      )}
    </>
  )
}
