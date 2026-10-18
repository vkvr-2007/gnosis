import { motion, useReducedMotion } from 'framer-motion'
import { useStore } from '../store'
import { IDENTITY } from '../identity'

/**
 * Waking up, about two seconds: it covers the bridge connecting and the voice engines being probed,
 * and no more (App owns the timing, BOOT_MS in App.tsx).
 *
 * AYRA ran a sci-fi boot (a status bar, a scrolling system log, reticle rings). Gnosis just wakes up:
 * his mark, his name, and one thin line that fills while he gets ready.
 */
export function Boot() {
  const phase = useStore((s) => s.phase)
  const reduced = useReducedMotion()
  if (phase !== 'boot') return null

  return (
    <div className="g-boot" role="status" aria-label={`${IDENTITY.name} is waking up`}>
      <motion.img
        className="g-boot-mark"
        src="/favicon.svg"
        alt=""
        initial={reduced ? false : { opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 180, damping: 22 }}
      />
      <motion.p
        className="g-boot-word"
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.4 }}
      >
        Waking up
      </motion.p>
      <span className="g-boot-line" aria-hidden="true">
        <span />
      </span>
    </div>
  )
}
