import { useEffect, useRef, useState, type ReactNode } from 'react'
import './avatar.css'
import { useStore, accentFor } from '../store'
import { type Look, poseFor, mouthOpen, nextBlinkMs, poseOverride, LOOKS, OOPS_FOR_MS, type Pose } from '../lib/avatar'

/**
 * AYRA's avatar face — the light alternative to the 3D reactor (F switches).
 *
 * A chibi girl drawn in the style of Orihime Inoue from Bleach, at the owner's
 * request: long orange hair, blue flower hairpins, the beige school blazer with
 * a red bow. Fan art for the owner's personal use — replace it before any public
 * or commercial use, like the upstream audio tracks.
 *
 * Why it is cheap: one static SVG. What she is doing lives in a single
 * `data-pose` attribute and CSS does the rest — showing the right arm, eyes and
 * mouth, and animating them with transforms. The only per-frame work is two CSS
 * variables (voice level for the halo, mouth opening for lip-sync), written
 * straight onto the element from a store subscription, so React doesn't
 * re-render sixty times a second. No WebGL, no canvas.
 */

type P = readonly [number, number]

/** A tapered sleeve from the bottom of the frame to the wrist, bulging a little at the elbow. */
function sleeve(base: P, wrist: P, wb = 50, ww = 27): string {
  const dx = wrist[0] - base[0]
  const dy = wrist[1] - base[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const at = (q: P, s: number) => `${(q[0] + nx * s).toFixed(1)},${(q[1] + ny * s).toFixed(1)}`
  const mid: P = [base[0] + dx * 0.5, base[1] + dy * 0.5]
  const bulge = (wb + ww) / 4 + 4
  return `M${at(base, wb / 2)} Q${at(mid, bulge)} ${at(wrist, ww / 2)} L${at(wrist, -ww / 2)} Q${at(mid, -bulge)} ${at(base, -wb / 2)} Z`
}

/** The white shirt cuff showing at the end of the sleeve. */
function cuff(base: P, wrist: P, ww = 27): string {
  const dx = wrist[0] - base[0]
  const dy = wrist[1] - base[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux
  const h = ww / 2 + 1.5
  const back: P = [wrist[0] - ux * 9, wrist[1] - uy * 9]
  const pt = (q: P, s: number) => `${(q[0] + nx * s).toFixed(1)},${(q[1] + ny * s).toFixed(1)}`
  return `M${pt(back, h)} L${pt(wrist, h - 1)} L${pt(wrist, -h + 1)} L${pt(back, -h)} Z`
}

/** Hands in local coordinates: the wrist at 0,0, fingers pointing up. */
const HANDS: Record<'open' | 'point' | 'fist', ReactNode> = {
  open: (
    <>
      <path className="av-skin" d="M-11.5,2 C-14.5,-10 -15.5,-26 -10.5,-36 C-6,-45 6,-45 10.5,-36 C15.5,-26 14.5,-10 11.5,2 Z" />
      <path className="av-skin" d="M-11,-12 C-19,-14 -24,-23 -20,-27 C-16,-30 -12,-24 -9.5,-19 Z" />
      <path className="av-line" d="M-4,-41 L-4,-29 M3,-42 L3,-29 M9,-37 L8.5,-28" />
    </>
  ),
  point: (
    <>
      <path className="av-skin" d="M2,-20 C0.5,-29 0.5,-40 4,-45 C7,-48 11,-46 11,-41 C11,-33 10,-26 9,-20 Z" />
      <path className="av-skin" d="M-11,2 C-14,-6 -14,-18 -9,-22 C-4,-25 9,-25 12,-20 C15,-12 14,-4 11,2 Z" />
      <path className="av-line" d="M-6,-21 C-7,-15 -7,-10 -5,-6 M0,-22 C-1,-16 -1,-10 0,-6" />
    </>
  ),
  fist: (
    <>
      <path className="av-skin" d="M-11,2 C-14,-6 -14,-18 -9,-22 C-4,-25 9,-25 12,-20 C15,-12 14,-4 11,2 Z" />
      <path className="av-line" d="M-6,-21 C-7,-15 -7,-10 -5,-6 M0,-22 C-1,-16 -1,-10 0,-6 M6,-21 C5,-15 5,-10 6,-6" />
    </>
  ),
}

function Arm({ name, active, base, wrist, angle, hand, children }: {
  name: string; active: boolean; base: P; wrist: P; angle: number; hand: keyof typeof HANDS; children?: ReactNode
}) {
  return (
    <g className={`av-arm av-arm-${name}${active ? ' on' : ''}`}>
      <path className="av-sleeve" d={sleeve(base, wrist)} />
      <path className="av-cuff" d={cuff(base, wrist)} />
      <g transform={`translate(${wrist[0]} ${wrist[1]}) rotate(${angle})`}>
        <g className="av-hand">{HANDS[hand]}</g>
      </g>
      {children}
    </g>
  )
}

/**
 * One open eye. `side` is -1 for the eye on the viewer's left, 1 for the right.
 * His are a little narrower and sharper than AYRA's: a strong upper lid instead of lashes.
 */
function Eye({ cx, cy, side }: { cx: number; cy: number; side: 1 | -1 }) {
  const o = side // the outer corner is on this side
  return (
    <g className="av-eye" style={{ transformOrigin: `${cx}px ${cy + 4}px` }}>
      <path fill="#fff" d={`M${cx - 18 * o},${cy + 2} Q${cx - 2 * o},${cy - 16} ${cx + 19 * o},${cy - 3} Q${cx + 16 * o},${cy + 20} ${cx},${cy + 21} Q${cx - 15 * o},${cy + 19} ${cx - 18 * o},${cy + 2} Z`} />
      <g className="av-iris">
        <ellipse cx={cx + 1 * o} cy={cy + 5} rx={11.5} ry={14} fill="url(#av-iris)" />
        <ellipse cx={cx + 1 * o} cy={cy + 6} rx={5.4} ry={7.6} fill="#0b1420" />
        <circle className="av-shine" cx={cx - 4 * o} cy={cy - 1} r={4.2} fill="#fff" />
        <circle cx={cx + 5 * o} cy={cy + 11} r={1.8} fill="#fff" opacity={0.85} />
      </g>
      <path
        className="av-lash"
        d={`M${cx - 21 * o},${cy + 1} Q${cx - 4 * o},${cy - 20} ${cx + 22 * o},${cy - 5} L${cx + 23 * o},${cy - 1} Q${cx - 3 * o},${cy - 14} ${cx - 19 * o},${cy + 4} Z`}
      />
      <path className="av-lower" d={`M${cx - 9 * o},${cy + 21} Q${cx + 2 * o},${cy + 23} ${cx + 12 * o},${cy + 18}`} />
    </g>
  )
}

/** A four-pointed twinkle. */
const Sparkle = ({ x, y, s = 1, d = 0 }: { x: number; y: number; s?: number; d?: number }) => (
  <path
    className="av-sparkle"
    style={{ animationDelay: `${d}s`, transformOrigin: `${x}px ${y}px` }}
    d={`M${x},${y - 9 * s} Q${x + 1.5 * s},${y - 1.5 * s} ${x + 9 * s},${y} Q${x + 1.5 * s},${y + 1.5 * s} ${x},${y + 9 * s} Q${x - 1.5 * s},${y + 1.5 * s} ${x - 9 * s},${y} Q${x - 1.5 * s},${y - 1.5 * s} ${x},${y - 9 * s} Z`}
  />
)

/**
 * One ear cup of the headphones he wears round his neck. They do what AYRA's
 * hairpins did: glow while a tool runs (the "magic" pose).
 */
function EarCup({ x, y, side }: { x: number; y: number; side: 1 | -1 }) {
  return (
    <g className="av-pin" style={{ transformOrigin: `${x}px ${y}px` }}>
      <circle className="av-pin-glow" cx={x} cy={y} r={30} fill="url(#av-glow)" />
      <rect className="av-hp-cup" x={x - 15} y={y - 21} width={30} height={42} rx={13} transform={`rotate(${-18 * side} ${x} ${y})`} />
      <rect className="av-hp-light" x={x - 4} y={y - 12} width={8} height={24} rx={4} transform={`rotate(${-18 * side} ${x} ${y})`} />
    </g>
  )
}

const LEFT_EYE = { cx: 164, cy: 192 }
const RIGHT_EYE = { cx: 236, cy: 192 }

export function Avatar() {
  const phase = useStore((s) => s.phase)
  const error = useStore((s) => s.error)
  const accent = useStore((s) => accentFor(s.phase))
  const root = useRef<HTMLDivElement>(null)
  const [blink, setBlink] = useState(false)
  const [oops, setOops] = useState(false)
  const [idleMs, setIdleMs] = useState(0)
  const [preview] = useState(() => poseOverride(window.location.search))

  // Voice level → halo and mouth, written straight onto the element: no re-render per frame.
  useEffect(() => {
    const el = root.current
    if (!el) return
    let last = -1
    return useStore.subscribe((s) => {
      const lvl = Math.round(s.level * 20) / 20
      const mouth = s.phase === 'speaking' ? mouthOpen(s.level) : 0
      const key = lvl * 10 + mouth
      if (key === last) return
      last = key
      el.style.setProperty('--lvl', String(lvl))
      el.style.setProperty('--mouth', String(mouth))
    })
  }, [])

  // Blinking, at irregular human intervals.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const loop = () => {
      t = setTimeout(() => {
        setBlink(true)
        t = setTimeout(() => {
          setBlink(false)
          loop()
        }, 140)
      }, nextBlinkMs(Math.random()))
    }
    loop()
    return () => clearTimeout(t)
  }, [])

  // A new error earns a worried look for a few seconds, not for the rest of the session.
  useEffect(() => {
    if (!error) return
    setOops(true)
    const t = setTimeout(() => setOops(false), OOPS_FOR_MS)
    return () => clearTimeout(t)
  }, [error])

  // How long she has been standing by — after a while she gets peckish.
  useEffect(() => {
    if (phase !== 'dormant') {
      setIdleMs(0)
      return
    }
    const since = Date.now()
    const t = setInterval(() => setIdleMs(Date.now() - since), 1000)
    return () => clearInterval(t)
  }, [phase])

  const pose: Pose = preview ?? poseFor(phase, { oops, idleMs })
  const look = LOOKS[pose]
  const on = (yes: boolean) => (yes ? ' on' : '')
  const arm = (name: string) => look.arms.includes(name)
  const fx = (name: string) => `av-fx av-fx-${name}${on(look.fx.includes(name))}`
  const mouth = (name: Look['mouth']) => `av-m av-m-${name}${on(look.mouth === name)}`

  return (
    <div
      ref={root}
      className="avatar"
      data-pose={pose}
      data-blink={blink ? '1' : '0'}
      style={{ ['--av-accent' as string]: accent }}
      aria-hidden="true"
    >
      <div className="avatar-stage">
        <div className="avatar-halo" />
        <div className="avatar-figure">
          <svg className="avatar-svg" viewBox="0 0 400 440">
            <defs>
              <linearGradient id="av-hair" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#2c3140" />
                <stop offset="1" stopColor="#12141b" />
              </linearGradient>
              <linearGradient id="av-hair-back" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#1d2029" />
                <stop offset="1" stopColor="#0d0f14" />
              </linearGradient>
              <linearGradient id="av-iris" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#0f2a3d" />
                <stop offset="0.55" stopColor="#1f5f86" />
                <stop offset="1" stopColor="#5fb6d9" />
              </linearGradient>
              <linearGradient id="av-hoodie" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#2d3b5e" />
                <stop offset="1" stopColor="#1a2440" />
              </linearGradient>
              <radialGradient id="av-glow">
                <stop offset="0" stopColor="#bfeeff" stopOpacity="0.95" />
                <stop offset="1" stopColor="#5fc8f5" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="av-orb">
                <stop offset="0" stopColor="#fffbe8" stopOpacity="1" />
                <stop offset="0.35" stopColor="#ffd36e" stopOpacity="0.85" />
                <stop offset="1" stopColor="#ff9a3c" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Behind everything: the back of his short hair, tilting with the head. */}
            <g className="av-tilt">
              <path fill="url(#av-hair-back)" d="M112,168 C106,104 148,62 200,62 C252,62 294,104 288,168 C286,190 280,206 272,214 L128,214 C120,206 114,190 112,168 Z" />
            </g>

            {/* Neck, the hood behind it, and the hoodie. */}
            <path className="av-hood" d="M128,318 C120,284 150,262 200,262 C250,262 280,284 272,318 C252,302 228,296 200,296 C172,296 148,302 128,318 Z" />
            <path className="av-skin-plain" d="M184,250 L184,312 Q200,320 216,312 L216,250 Z" />
            <path fill="#f0c3ac" d="M184,262 Q200,280 216,262 L216,276 Q200,290 184,276 Z" />
            <path
              className="av-blazer"
              d="M46,440 C52,370 100,330 156,316 C170,312 186,312 200,330 C214,312 230,312 244,316 C300,330 348,370 354,440 Z"
            />
            <path className="av-seam" d="M156,316 C172,326 186,330 200,330 C214,330 228,326 244,316 M120,360 L132,440 M280,360 L268,440" />
            {/* Drawstrings, with their metal tips. */}
            <path className="av-string" d="M188,330 C186,350 184,368 182,384 M212,330 C214,350 216,368 218,384" />
            <rect className="av-aglet" x="179" y="383" width="6" height="12" rx="2.5" />
            <rect className="av-aglet" x="215" y="383" width="6" height="12" rx="2.5" />

            {/* Headphones round his neck: the band behind, a cup on each side. */}
            <path className="av-hp-band" d="M152,302 C150,282 170,270 200,270 C230,270 250,282 248,302" />
            <EarCup x={152} y={306} side={-1} />
            <EarCup x={248} y={306} side={1} />

            {/* The head, tilting as one piece. */}
            <g className="av-tilt av-head">
              <ellipse className="av-face" cx="119" cy="194" rx="10" ry="17" />
              <ellipse className="av-face" cx="281" cy="194" rx="10" ry="17" />
              <path
                className="av-face"
                d="M120,150 C120,100 156,80 200,80 C244,80 280,100 280,150 C280,198 272,224 252,246 C236,262 216,272 200,272 C184,272 164,262 148,246 C128,224 120,198 120,150 Z"
              />
              <ellipse className="av-blush" cx="152" cy="232" rx="15" ry="6" />
              <ellipse className="av-blush" cx="248" cy="232" rx="15" ry="6" />

              <g className={`av-e-open${on(look.eyes === 'open')}`}>
                <Eye {...LEFT_EYE} side={-1} />
                <Eye {...RIGHT_EYE} side={1} />
              </g>
              <g className={`av-e-happy av-stroke-eye${on(look.eyes === 'happy')}`}>
                <path d="M148,200 Q163,180 178,200" />
                <path d="M222,200 Q237,180 252,200" />
              </g>
              <g className={`av-e-closed av-stroke-eye${on(look.eyes === 'closed')}`}>
                <path d="M148,194 Q163,206 178,194" />
                <path d="M222,194 Q237,206 252,194" />
              </g>

              <path className="av-nose" d="M200,219 Q203,224 199,226" />

              <path className={mouth('smile')} d="M188,243 Q200,253 212,243" />
              <g className={mouth('talk')}>
                <path fill="#8a2b2b" d="M187,242 Q200,239 213,242 Q212,261 200,262 Q188,261 187,242 Z" />
                <path fill="#ec7f80" d="M192,255 Q200,250 208,255 Q200,261 192,255 Z" />
              </g>
              <ellipse className={mouth('o')} cx="203" cy="247" rx="5" ry="6" fill="#8a2b2b" />
              <g className={mouth('grin')}>
                <path fill="#8a2b2b" d="M184,240 Q200,267 216,240 Z" />
                <path fill="#ec7f80" d="M191,252 Q200,247 209,252 Q200,260 191,252 Z" />
              </g>
              <path className={mouth('nom')} d="M190,247 q5,-5 10,0 q5,-5 10,0" />
              <path className={mouth('worried')} d="M189,250 Q200,242 211,250" />
              <path className={mouth('sleep')} d="M195,248 Q200,252 205,248" />

              {/* Short, tousled hair: a messy fringe swept to one side and short sideburns. */}
              <path
                fill="url(#av-hair)"
                d="M110,170 C100,100 146,52 202,52 C258,52 304,98 292,170 C288,150 282,138 274,130 C276,146 272,158 266,166 C262,142 252,126 238,116 C240,134 234,146 224,154 C222,132 212,118 198,110 C196,128 186,140 172,146 C176,128 172,118 164,112 C154,128 146,138 134,144 C138,130 136,122 130,118 C122,132 116,148 114,166 Z"
              />
              <path fill="url(#av-hair)" d="M114,150 C110,170 110,192 116,208 C120,196 122,182 126,168 Z" />
              <path fill="url(#av-hair)" d="M286,150 C290,170 290,192 284,208 C280,196 278,182 274,168 Z" />
              <path className="av-shine-hair" d="M150,88 Q196,66 244,82" />
              <path className="av-shine-hair thin" d="M166,104 Q186,92 206,96" />

              <path className="av-brow av-brow-l" d="M144,160 Q162,153 182,157" />
              <path className="av-brow av-brow-r" d="M218,157 Q238,153 256,160" />

              {/* Little extras that come and go with the pose. */}
              <path className={fx('sweat')} d="M281,146 C275,158 275,166 281,168 C287,166 287,158 281,146 Z" />
              <g className={fx('dots')}>
                <circle cx="292" cy="112" r="4" />
                <circle cx="308" cy="94" r="6" />
                <circle cx="330" cy="76" r="9" />
              </g>
              <g className={fx('zzz')}>
                <text x="276" y="112">z</text>
                <text x="296" y="88">z</text>
                <text x="320" y="62">Z</text>
              </g>
              <g className={fx('ear')}>
                <path d="M338,172 Q348,190 338,208" />
                <path d="M350,162 Q364,190 350,218" />
              </g>
            </g>

            <g className={fx('sparkles')}>
              <Sparkle x={70} y={150} s={1.2} />
              <Sparkle x={334} y={128} s={0.9} d={0.5} />
              <Sparkle x={318} y={260} s={0.7} d={1} />
              <Sparkle x={86} y={286} s={0.8} d={1.4} />
            </g>
            <g className={fx('orb')}>
              <circle cx="200" cy="318" r="34" fill="url(#av-orb)" />
              <circle cx="200" cy="318" r="8" fill="#fffdf2" />
            </g>

            {/* Arms, one set per gesture; CSS shows the one that fits the pose. */}
            <Arm name="wave" active={arm('wave')} base={[52, 440]} wrist={[92, 252]} angle={-12} hand="open" />
            <Arm name="listen" active={arm('listen')} base={[350, 440]} wrist={[316, 240]} angle={16} hand="open" />
            <Arm name="think" active={arm('think')} base={[300, 440]} wrist={[232, 312]} angle={-25} hand="point" />
            <Arm name="talk" active={arm('talk')} base={[346, 440]} wrist={[302, 336]} angle={18} hand="open" />
            <Arm name="magic-l" active={arm('magic-l')} base={[70, 440]} wrist={[130, 372]} angle={-30} hand="open" />
            <Arm name="magic-r" active={arm('magic-r')} base={[330, 440]} wrist={[270, 372]} angle={30} hand="open" />
            <Arm name="snack" active={arm('snack')} base={[300, 440]} wrist={[250, 292]} angle={-40} hand="fist">
              <g className="av-bread" transform="translate(205 251) rotate(-8)">
                <path d="M-34,-6 C-36,-18 -20,-24 0,-22 C22,-24 38,-16 34,-4 C32,8 18,11 0,9 C-20,11 -34,8 -34,-6 Z" />
                <circle cx="-14" cy="-8" r="2.6" />
                <circle cx="4" cy="-12" r="2.2" />
                <circle cx="18" cy="-5" r="2.6" />
                <circle cx="-2" cy="2" r="2" />
              </g>
            </Arm>
          </svg>
        </div>
      </div>
    </div>
  )
}
