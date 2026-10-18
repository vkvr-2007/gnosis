import { useStore } from '../store'
import { IDENTITY } from '../identity'

/**
 * The start screen.
 *
 * Browsers refuse to play audio or open the microphone until the page has been clicked, so something
 * has to be pressed before Gnosis can speak. AYRA made it a cold open (an INITIALISE ring); Gnosis
 * asks plainly, with one button.
 *
 * Deliberately NOT wrapped in AnimatePresence (AYRA's finding): an exit animation on a full-screen
 * element that never finished left an invisible layer over everything. A plain conditional cannot
 * strand anything.
 */
export function Ignition({ onStart }: { onStart: () => void }) {
  const phase = useStore((s) => s.phase)
  if (phase !== 'offline') return null

  return (
    <div className="g-start">
      <div className="g-start-card">
        <img className="g-start-mark" src="/favicon.svg" alt="" />
        <h1 className="g-start-title">{IDENTITY.name}</h1>
        <p className="g-start-sub">Your assistant on this laptop. He listens when you press Space.</p>
        <button className="g-start-button" onClick={onStart} autoFocus>
          Start
        </button>
        <p className="g-start-key">
          or press <kbd>Space</kbd>
        </p>
      </div>
    </div>
  )
}
