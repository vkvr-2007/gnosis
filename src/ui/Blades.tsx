import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toolPhrase } from '../lib/toolphrase'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, bladeLife, dockOrder, TURN_MS, type Blade } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { sanitisePanelHtml } from './sanitise'
import { ResearchProgress } from './Research'
import { changeTone, cleanData, cleanLinks, dataFoot, isWebUrl, platformInfo, scoreTone } from '../lib/research'

/**
 * The blades.
 *
 * This file used to be six slivers of light raking across the frame while a
 * tool ran — pure atmosphere, nothing you could read. That effect is still
 * here, at the bottom, because it is still the right answer to "something is
 * happening". But the name now belongs to the surface it was decorating.
 *
 * A blade is the thing you actually look at: an answer's figures and the
 * sources behind them, an article, a picture. Docked they stand in a column
 * beside her, every one readable at once — an answer's data card and its
 * sources card side by side is the point (the owner, 2026-10-08). Any one can
 * be thrown full screen.
 *
 * The hard problem a blade solves is that most of the web refuses to be shown.
 * X-Frame-Options and frame-ancestors stop an article being framed, CORS stops
 * the page fetching it, and hotlink protection stops even its images loading.
 * All three are rules the origin server enforces against the *browser*, so the
 * bridge takes the browser out of it: it fetches server-side and serves the
 * result from localhost, and at that point the document in the iframe is ours.
 *
 * Nothing in this file is a special case for a particular site, and nothing
 * here sniffs a file extension. The model asks `probe_url` what a thing is and
 * says what it wants shown; this only knows how to show it.
 */

/* ------------------------------------------------------------------ sources */

/** Route a source through the bridge, which is the only origin that can
 *  actually fetch it — and the only one the page CSP will load from. */
function viaBridge(raw: string, route: 'img' | 'media'): string {
  const src = String(raw ?? '').trim()
  if (!src) return ''
  if (!/^https?:\/\//i.test(src)) return src
  if (src.startsWith(`${BRIDGE_HTTP_URL}/`)) return src
  return `${BRIDGE_HTTP_URL}/${route}?url=${encodeURIComponent(src)}`
}

/** A whole document, rendered by the bridge so it can be framed at all. */
const pageUrl = (url: string, mode: 'reader' | 'live') =>
  `${BRIDGE_HTTP_URL}/page?mode=${mode}&url=${encodeURIComponent(url)}`

/**
 * The three embed hosts, and only these.
 *
 * Same closed list as the panel sanitiser, for the same reason: YouTube and
 * Vimeo will not hand over the media file, so an iframe is the only way to play
 * a result inline, and the trade for that is that the host list does not grow.
 */
function embedUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '')
  const id = (s: string) => (/^[\w-]{6,20}$/.test(s) ? s : null)

  if (host === 'youtube.com' && url.pathname === '/watch') {
    const v = id(url.searchParams.get('v') ?? '')
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtu.be') {
    const v = id(url.pathname.slice(1))
    return v && `https://www.youtube-nocookie.com/embed/${v}`
  }
  if (host === 'youtube-nocookie.com' && /^\/embed\/[\w-]+/.test(url.pathname)) return url.href
  if (host === 'vimeo.com') {
    const v = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return /^\d+$/.test(v) ? `https://player.vimeo.com/video/${v}` : null
  }
  if (host === 'player.vimeo.com' && /^\/video\/\d+/.test(url.pathname)) return url.href
  return null
}

/* --------------------------------------------------------------------- body */

type BodyProps = {
  blade: Blade
  expanded: boolean
  /** Full screen — what "+3 more" on a data card asks for. */
  onMore: () => void
}

/**
 * What goes inside a blade.
 *
 * Every iframe is sandboxed. `allow-same-origin` is deliberately absent from
 * the proxied-page case: that document is served from the bridge's own origin —
 * the one origin permitted to open the agent socket — so granting it
 * same-origin would let a page JARVIS found on the web reach that socket. It
 * does not need it. It is being read, not run.
 */
const Body = memo(function Body({ blade, expanded, onMore }: BodyProps) {
  if (blade.kind === 'article' && blade.url) {
    return (
      <iframe
        className="bl-frame"
        src={pageUrl(blade.url, blade.mode === 'live' ? 'live' : 'reader')}
        // allow-scripts WITHOUT allow-same-origin. That combination is the
        // point: the page runs in an opaque origin, so the one script the
        // bridge injects can move the document's own scroll position and can
        // reach nothing of ours — not this origin, not the agent socket. Adding
        // allow-same-origin would hand a page found on the web the keys.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={String(blade.title ?? '')}
      />
    )
  }

  if (blade.kind === 'embed' && blade.url) {
    const embed = embedUrl(blade.url)
    if (!embed) return <p className="bl-note">That video link could not be played.</p>
    return (
      <iframe
        className="bl-frame"
        src={embed}
        // A player genuinely needs scripts and its own origin. Nothing that
        // reaches the room the user is sitting in is granted.
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
        referrerPolicy="no-referrer"
        allowFullScreen
        title={String(blade.title ?? '')}
      />
    )
  }

  if (blade.kind === 'video' && blade.url) {
    return (
      <video
        className="bl-video"
        src={viaBridge(blade.url, 'media')}
        controls
        playsInline
        preload="metadata"
      />
    )
  }

  if (blade.kind === 'image' && blade.url) {
    return <img className="bl-image" src={viaBridge(blade.url, 'img')} alt={String(blade.title ?? '')} />
  }

  if (blade.kind === 'gallery') {
    return (
      <div className="bl-gallery">
        {(Array.isArray(blade.images) ? blade.images : []).map((src, i) => (
          <img key={`${src}-${i}`} className="bl-thumb" src={viaBridge(src, 'img')} alt="" />
        ))}
      </div>
    )
  }

  if (blade.kind === 'markup' && blade.html) {
    // Model-authored markup gets exactly the treatment panel markup gets.
    // There is one sanitiser, and this is it.
    return (
      <div
        className="bl-markup p-body"
        dangerouslySetInnerHTML={{ __html: sanitisePanelHtml(blade.html) }}
      />
    )
  }

  // The words on these three came off the open web, so they render as React
  // text — never through the markup path above.
  if (blade.kind === 'research' && blade.research) {
    return <ResearchProgress research={blade.research} expanded={expanded} onMore={onMore} />
  }
  if (blade.kind === 'data') return <DataBody blade={blade} expanded={expanded} onMore={onMore} />
  if (blade.kind === 'sources') return <SourcesBody blade={blade} />

  return <p className="bl-note">Nothing to show.</p>
})

/** Rows a docked data card shows; the rest are a "+N more" away (E). */
const DATA_ROWS = 4

/**
 * The figures that answer the question: the key one big, with its unit, what
 * it is and when it is from, then a few supporting rows. A `[n]` is the source
 * it came from on the sources card beside it.
 */
function DataBody({ blade, expanded, onMore }: BodyProps) {
  const d = useMemo(() => cleanData(blade.data), [blade.data])
  const foot = dataFoot(blade, Date.now())
  if (!d) return <p className="bl-note">No figures to show.</p>
  const h = d.headline
  const rows = expanded ? d.rows : d.rows.slice(0, DATA_ROWS)
  const more = d.rows.length - rows.length
  const tone = changeTone(h?.change)

  return (
    <div className="bl-data">
      {h && (
        <div className="bl-hl">
          {h.label && (
            <span className="bl-hl-label">
              {h.label}
              {h.n !== undefined && <Cite n={h.n} />}
            </span>
          )}
          <span className="bl-hl-fig">
            <b className="hud-metric bl-hl-value">{h.value}</b>
            {h.unit && <span className="hud-unit bl-hl-unit">{h.unit}</span>}
            {!h.label && h.n !== undefined && <Cite n={h.n} />}
          </span>
          {(h.change || h.asOf) && (
            <span className="bl-hl-meta">
              {h.change && <span className={`bl-chg${tone ? ` bl-chg-${tone}` : ''}`}>{h.change}</span>}
              {h.asOf && <span>as of {h.asOf}</span>}
            </span>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <dl className="bl-rows">
          {rows.map((r, i) => (
            <div key={`${i}-${r.label}`} className="bl-row">
              <dt title={r.note ? `${r.label} — ${r.note}` : r.label}>{r.label}</dt>
              <dd>
                {r.value}
                {r.unit && <span className="bl-row-unit"> {r.unit}</span>}
                {r.n !== undefined && <Cite n={r.n} />}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {more > 0 && (
        <button type="button" className="bl-more-rows" onClick={onMore} title="Show them all (E)">
          +{more} more
        </button>
      )}
      {d.note && <p className="bl-data-note">{d.note}</p>}
      {foot && <p className="bl-data-foot">{foot}</p>}
    </div>
  )
}

function Cite({ n }: { n: number }) {
  return (
    <sup className="bl-cite" aria-label={`source ${n}`}>
      [{n}]
    </sup>
  )
}

/**
 * Links a sources card shows. The bridge sends five for an ordinary answer and
 * up to eight in researcher mode; this only stops a runaway list.
 */
const SOURCE_LINKS = 8

/**
 * The sources the answer used, each a real link: one line each — its number,
 * its title, its site. In researcher mode each also says where it was found and
 * its rank score. In a narrow window they fold into a row of site chips. Only
 * http(s) addresses become links; anything else is shown as words.
 */
function SourcesBody({ blade }: { blade: Blade }) {
  const links = useMemo(() => cleanLinks(blade.links, SOURCE_LINKS), [blade.links])
  if (!links.length) return <p className="bl-note">No sources to show.</p>

  return (
    <div className="bl-sources">
      <ol className="bl-src-list">
        {links.map((l, i) => {
          const info = l.platform ? platformInfo(l.platform) : null
          const inner = (
            <>
              <span className="bl-src-n">{l.n ?? '·'}</span>
              <span className="bl-src-t">{l.title || l.domain || l.url}</span>
              {info && (
                <span className="bl-src-pf" style={{ ['--plat' as string]: info.colour }} title={info.label}>
                  {info.short}
                </span>
              )}
              {l.score !== undefined && (
                <span className={`bl-src-sc rs-t-${scoreTone(l.score)}`} title="Relevance score">
                  {l.score}
                </span>
              )}
              <span className="bl-src-d">{l.domain}</span>
            </>
          )
          return (
            <li key={`${i}-${l.url}`}>
              {isWebUrl(l.url) ? (
                <a className="bl-src" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                  {inner}
                </a>
              ) : (
                <span className="bl-src bl-src-off">{inner}</span>
              )}
            </li>
          )
        })}
      </ol>
      <div className="bl-src-chips">
        {links.map((l, i) =>
          isWebUrl(l.url) ? (
            <a
              key={`${i}-${l.url}`}
              className="bl-chip"
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              title={l.title ? `${l.title}\n${l.url}` : l.url}
            >
              {l.n !== undefined && <b>{l.n}</b>}
              {l.platform && l.platform !== 'web' ? platformInfo(l.platform).short : l.domain || l.title}
            </a>
          ) : (
            <span key={`${i}-${l.url}`} className="bl-chip bl-src-off">
              {l.domain || l.title}
            </span>
          ),
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- guard */

/**
 * A card that cannot draw must not take the interface down with it — in front
 * of an audience the face going blank is the worst outcome there is. Every
 * card's body sits inside one. The next update of the card gets a fresh chance.
 */
type GuardProps = { stamp: unknown; children: ReactNode }
type GuardState = { failed: boolean; stamp: unknown }

class Guard extends Component<GuardProps, GuardState> {
  state: GuardState = { failed: false, stamp: this.props.stamp }

  static getDerivedStateFromProps(props: GuardProps, state: GuardState): Partial<GuardState> | null {
    return props.stamp === state.stamp ? null : { failed: false, stamp: props.stamp }
  }

  static getDerivedStateFromError(): Partial<GuardState> {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[blade]', error)
  }

  render() {
    if (this.state.failed) return <p className="bl-note">This card could not draw this update.</p>
    return this.props.children
  }
}

/* -------------------------------------------------------------------- card */

/**
 * A research run that has sent nothing for this long has stopped talking (the
 * engine sends a heartbeat every few seconds): its card stops waiting for it
 * and closes on the normal clock, rather than saying "running" for ever.
 */
const STALL_MS = 30_000

/** Kinds that fill a set height; resizing one sets that height, not just its ceiling. */
const FIXED_HEIGHT: ReadonlySet<Blade['kind']> = new Set(['article', 'embed', 'video', 'image'])

/** What the header says the card is — in words, not the internal kind. */
const KIND_LABEL: Record<Blade['kind'], string> = {
  article: 'read',
  image: 'image',
  gallery: 'images',
  video: 'video',
  embed: 'video',
  markup: '',
  research: 'agents',
  data: 'answer',
  sources: 'web',
}

function Card({
  blade,
  focused,
  expanded,
  onFocus,
  onExpand,
  onClose,
}: {
  blade: Blade
  focused: boolean
  expanded: boolean
  onFocus: () => void
  onExpand: () => void
  onClose: () => void
}) {
  /** The height the owner has dragged this card to, or null for its own. */
  const [maxH, setMaxH] = useState<number | null>(null)
  const shell = useRef<HTMLElement>(null)

  // A running research card waits for its run — unless the run has gone
  // silent. Stamped with the update it went silent on, so the next update
  // clears it without an effect having to.
  const running = blade.kind === 'research' && blade.research?.status === 'running'
  const [silentOn, setSilentOn] = useState<unknown>(null)
  useEffect(() => {
    if (!running) return
    const stamp = blade.research
    const timer = setTimeout(() => setSilentOn(stamp), STALL_MS)
    return () => clearTimeout(timer)
  }, [running, blade.research])
  const stalled = running && silentOn === blade.research

  // Closing by itself: the clock runs only while nobody is looking at it.
  const life = stalled ? TURN_MS : bladeLife(blade)
  const lasting = life === null
  const ms = life ?? 0
  const [hover, setHover] = useState(false)
  const kept = blade.kept === true
  const keepBlade = useStore((s) => s.keepBlade)
  const paused = hover || expanded || kept || lasting
  const left = useRef(ms)
  const lifeWas = useRef(ms)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    // A new lifetime (a research run finishing) starts its clock afresh.
    if (lifeWas.current !== ms) {
      lifeWas.current = ms
      left.current = ms
    }
    if (paused) return
    const from = performance.now()
    const timer = setTimeout(() => close.current(), left.current)
    return () => {
      clearTimeout(timer)
      left.current = Math.max(0, left.current - (performance.now() - from))
    }
  }, [paused, ms])

  // Stable, so the memoised body does not redraw for every hover.
  const expand = useRef(onExpand)
  expand.current = onExpand
  const more = useCallback(() => expand.current(), [])

  /**
   * Resize from the bottom-right grip — the card's height only; docked, its
   * width is the dock's. Listens on `window`, not on the grip: one pixel into
   * a drag the pointer is no longer over the element that started it.
   */
  const onGrip = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const box = shell.current?.getBoundingClientRect()
    if (!box) return
    const from = box.height
    const sy = e.clientY
    const move = (ev: PointerEvent) =>
      setMaxH(Math.round(Math.max(120, Math.min(window.innerHeight * 0.94, from + ev.clientY - sy))))
    const done = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
  }

  const sized = maxH !== null && !expanded
  const title = typeof blade.title === 'string' ? blade.title : ''

  return (
    /**
     * Two elements: the slot is what framer moves (in, out, and up the column
     * when a card above it closes); the card inside it is what is drawn and
     * sized. `layout="position"` only — a card whose content grows (the
     * research card, five times a second) is never stretched by a scale.
     */
    <motion.div
      className="bl-slot"
      layout={expanded ? false : 'position'}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <section
        ref={shell}
        className={
          `bl bl-${blade.size} bl-k-${blade.kind}` +
          (expanded ? ' bl-expanded' : '') +
          (focused ? ' bl-front' : '')
        }
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={sized ? { maxHeight: maxH, ...(FIXED_HEIGHT.has(blade.kind) ? { height: maxH } : null) } : undefined}
        onPointerDown={() => {
          if (!focused) onFocus()
        }}
      >
        <span className="pk pk-tl" />
        <span className="pk pk-tr" />
        <span className="pk pk-bl" />
        <span className="pk pk-br" />

        <header className="bl-head">
          <span className="bl-title">{title}</span>
          <span className="bl-kind">{KIND_LABEL[blade.kind] ?? ''}</span>
          <span className="bl-acts">
            <button
              className={`bl-btn bl-keep${kept ? ' bl-kept' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                keepBlade(blade.id, !kept)
              }}
              title={kept ? 'Let it close by itself again' : 'Keep it open'}
            >
              {kept ? 'kept' : 'keep'}
            </button>
            {sized && (
              <button
                className="bl-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setMaxH(null)
                }}
                title="Back to its own size"
              >
                ⤾
              </button>
            )}
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onExpand()
              }}
              title={expanded ? 'Shrink (E)' : 'Full screen (E)'}
            >
              {expanded ? '⤡' : '⤢'}
            </button>
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              title="Close (X)"
            >
              ✕
            </button>
          </span>
        </header>

        <div className="bl-body">
          <Guard stamp={blade}>
            <Body blade={blade} expanded={expanded} onMore={more} />
          </Guard>
        </div>

        {/* How long until it closes by itself; stops while hovered or kept.
            Remounted with a new lifetime so its run-down starts over too. */}
        {!lasting && (
          <span
            key={ms}
            className="bl-timer"
            style={{
              animationDuration: `${ms}ms`,
              animationPlayState: paused ? 'paused' : 'running',
              visibility: kept || expanded ? 'hidden' : 'visible',
            }}
          />
        )}

        {/* Resize grip. Absent while expanded, where the size is the point. */}
        {!expanded && <span className="bl-grip" onPointerDown={onGrip} title="Drag to resize" />}
      </section>
    </motion.div>
  )
}

/* ------------------------------------------------------------------- stack */

export function Blades() {
  const blades = useStore((s) => s.blades)
  const focusedBlade = useStore((s) => s.focusedBlade)
  const expandedBlade = useStore((s) => s.expandedBlade)
  const focusBlade = useStore((s) => s.focusBlade)
  const expandBlade = useStore((s) => s.expandBlade)
  const closeBlade = useStore((s) => s.closeBlade)

  /**
   * The dock's column, top to bottom (store.ts, dockOrder): research progress,
   * figures, sources, anything else. Ordered here rather than in the store
   * because it is a view concern; the store's array order is the history.
   */
  const { visible, hidden } = useMemo(() => dockOrder(blades), [blades])
  const all = useMemo(() => [...visible, ...hidden], [visible, hidden])
  const expanded = expandedBlade && blades.some((b) => b.id === expandedBlade) ? expandedBlade : null

  /**
   * What E and X act on: the card full screen; docked, the one the owner
   * pulled forward (a click, [ or ]), else the top one. Every new card takes
   * the store's focus as it arrives, so a pick counts only while the focus is
   * still where the owner put it — the next answer's cards hand E and X back
   * to the top of the column, which is the figure she is talking about.
   */
  const [picked, setPicked] = useState<string | null>(null)
  const pick = useCallback(
    (id: string) => {
      setPicked(id)
      focusBlade(id)
    },
    [focusBlade],
  )
  const front = expanded
    ? blades.find((b) => b.id === expanded)
    : (visible.find((b) => b.id === picked && picked === focusedBlade) ?? visible[0])

  // She steps aside while a card is docked beside her (index.css, data-cards).
  useEffect(() => {
    document.documentElement.dataset.cards = blades.length && !expanded ? '1' : '0'
  }, [blades.length, expanded])

  // A click inside a card's page or player hands the keyboard to that frame,
  // and then Space — talk, send, stop — would never reach her. The click still
  // lands; the keyboard comes straight back.
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const el = document.activeElement as HTMLElement | null
        if (el?.tagName === 'IFRAME' && el.closest('.bl')) {
          el.blur()
          window.focus()
        }
      }, 0)
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  /**
   * [ and ]: docked, move the focus through the cards on screen; full screen,
   * put the next card full screen instead.
   */
  const cycle = useCallback(
    (by: number) => {
      const ring = expanded ? all : visible
      if (ring.length < 2) return
      const at = Math.max(0, ring.findIndex((b) => b.id === front?.id))
      const next = ring[(at + by + ring.length) % ring.length]
      if (!next) return
      pick(next.id)
      if (expanded) expandBlade(next.id)
    },
    [expanded, all, visible, front, pick, expandBlade],
  )

  // Bound here rather than in App, and only while something is open, so E and X
  // are free for anything else the moment the last blade closes.
  const live = useRef(false)
  live.current = blades.length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return

      if (e.key === 'e') {
        e.preventDefault()
        expandBlade(expanded ? null : (front?.id ?? null))
      } else if (e.key === 'x') {
        e.preventDefault()
        if (front) closeBlade(front.id)
      } else if (e.key === ']') {
        e.preventDefault()
        cycle(1)
      } else if (e.key === '[') {
        e.preventDefault()
        cycle(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [front, expanded, expandBlade, closeBlade, cycle])

  if (!blades.length) return null

  // While one is full screen it is the only thing on screen; the rest are
  // unmounted rather than hidden so their iframes stop loading.
  const shown = expanded ? blades.filter((b) => b.id === expanded) : visible

  return (
    <div className={`blades-stack${expanded ? ' blades-stack-full' : ''}`}>
      {/* layoutScroll: the column scrolls when its cards overflow the dock,
          and framer has to know to measure the cards inside that scroll. */}
      <motion.div className="bl-col" layoutScroll>
        <AnimatePresence>
          {shown.map((blade) => {
            const isExpanded = expanded === blade.id
            return (
              <Card
                key={blade.id}
                blade={blade}
                focused={blade.id === front?.id}
                expanded={isExpanded}
                onFocus={() => pick(blade.id)}
                onExpand={() => expandBlade(isExpanded ? null : blade.id)}
                onClose={() => closeBlade(blade.id)}
              />
            )
          })}
        </AnimatePresence>
      </motion.div>

      {!expanded && (visible.length > 1 || hidden.length > 0) && (
        <div className="bl-hint">
          {hidden.length > 0 && (
            <span className="bl-more" title="More cards: they show here as these close">
              +{hidden.length}
            </span>
          )}
          <kbd>[</kbd> <kbd>]</kbd> cycle · <kbd>E</kbd> full · <kbd>X</kbd> close
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- the sweep */

/**
 * The original blades: slivers of light raking across the frame while a tool
 * runs. Unchanged, because it is still the right answer to "something is
 * happening" — a tool call is the one moment the interface stops being a face
 * and becomes machinery, and the reactor cannot carry that on its own.
 *
 * Deliberately CSS rather than three.js: the scene is bloomed and tone-mapped,
 * which is exactly wrong for a 1px edge. Kept in the DOM it stays a blade.
 */
const SWEEP = [1, 2, 3, 4, 5, 6]

export function BladeSweep() {
  const phase = useStore((s) => s.phase)
  const activeTool = useStore((s) => s.activeTool)

  return (
    <AnimatePresence>
      {phase === 'tooling' && (
        <motion.div
          className="blades"
          // Only opacity is animated here. The sweeps are CSS keyframes on the
          // children, and framer writes `transform` inline on anything it
          // animates — one transform prop in this list and every blade would be
          // sliding inside an element that is itself sliding.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <div className="blade-field">
            {SWEEP.map((n) => (
              <span key={n} className={`blade blade-${n}`} />
            ))}
          </div>

          {activeTool && (
            // Keyed on the name so a chain of tools re-runs the ride-in for
            // each one rather than silently swapping the text mid-sweep.
            <div className="blade-carrier">
              <span key={activeTool} className="blade-tool">
                {toolPhrase(activeTool)}
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
