import { createSdkMcpServer, tool } from './sdk.mjs'
import { z } from 'zod'
import { probeUrl } from './page.mjs'
import { IDENTITY } from './identity.mjs'
import { supportsNumbers } from './trust.mjs'

/**
 * The `display` tool — AYRA's screen.
 *
 * Rather than filling in a fixed set of card templates, the model authors the
 * panel itself: markup, layout, emphasis. A phone screenshot and a gallery
 * should not look like the same component with different words in it, and
 * only the thing composing the answer knows what the answer wants to look like.
 *
 * What's fixed is the design system below, so everything it builds still looks
 * like one interface. The browser sanitises the markup before it renders.
 *
 * A web answer is the exception, and has its own tool: `show_data` draws the
 * data card — a figure, a name, a date, a score — from fields, not markup, and
 * every number on it is checked against what the search really said. The
 * sources card beside it is the bridge's own (sources.mjs).
 *
 * It runs in-process (an SDK MCP server, not a subprocess), so the handler
 * pushes straight down the open WebSocket — no round trip, no temp file.
 */

const DESIGN_SYSTEM = `
LAYOUT CLASSES — compose these, and use NOTHING else. The renderer strips any
class name that is not on this list, so an invented one silently loses its
styling and the row lands as unformatted text.
  .hud-rows            vertical list container
  .hud-row             one row: put .hud-idx, .hud-main, .hud-tag inside
  .hud-idx             leading index or glyph, dim and monospaced
  .hud-main            the row's text column
  .hud-label           primary line (clamped to 2 lines)
  .hud-sub             secondary line, dimmed
  .hud-tag             small trailing tag, right-aligned
  .hud-metric          huge numeral, for a single headline figure
  .hud-unit            small caption under a metric
  .hud-note            a short passage of prose
  .hud-img             full-width image (use a plain <img> inside)
  .hud-caption         one line under an image
  .hud-grid            two-column grid
  .hud-bar             thin progress bar; set style="--v:0.62" for 62%
  .hud-dim             de-emphasise anything
  .hud-hot             emphasise anything (picks up the accent colour)
  .hud-gallery         grid container for several images at once
  .hud-thumb           one thumbnail, inside a .hud-gallery or beside a .hud-row
  .hud-video           a <video> player, full width of the panel
  .hud-embed           16:9 wrapper for an <iframe>; put the iframe inside it
  .hud-figure          an image or video with its .hud-caption grouped beneath

PICTURES AND VIDEO — these work. Use them.
  - Images from the web render. Image-search results, article thumbnails,
    photographs, product shots, chart images: paste the URL exactly as the tool
    result gave it and it appears. The bridge fetches every remote image
    server-side and hands the bytes to the display, so hosts that refuse to be
    hotlinked still render — nothing is loaded by the page itself.
  - If an image search came back with pictures, SHOW the pictures: a grid of
    results is the whole answer to an image search, not a decoration on it.
  - Video results are for playing, not describing. A YouTube or Vimeo result
    goes in an <iframe> inside .hud-embed; a direct .mp4 or .webm goes in a
    <video class="hud-video" controls>.
  - Never invent a URL. Use only ones that appeared verbatim in a tool result.
    A guessed address is a broken image, and a broken image is worse than none.

WHERE THE CONTENT COMES FROM — read this before showing anything from the web.
  - A web answer is not a panel. After a web search the sources card appears by
    itself, and the answer's figure goes on show_data. Never compose a card of
    search results, headlines or a page's substance for it.
  - Image URLs that came back IN a tool result are real and will render; the
    bridge fetches them server-side. An image URL you inferred or assembled
    yourself will not. Never guess one.

RULES
  - No inline colours. Use the classes; .hud-hot picks up the accent colour.
  - No <style>, <script>, <form>, or event handlers. They are stripped.
  - <iframe> is allowed for exactly three hosts: www.youtube-nocookie.com/embed,
    www.youtube.com/embed and player.vimeo.com/video. Any other src and the
    whole element is removed. A youtube.com/watch?v=ID or youtu.be/ID link is
    fine to paste — it is rewritten into the embed form for you.
  - Every panel must have visible text or a working image. An empty body is
    rejected outright — a blank card reads as a broken interface.
  - Keep it to roughly 6 rows or 40 words. This is a heads-up display glanced at
    while listening, not a document. Four thumbnails in a gallery, six at the
    outside; one video, never two.

EXAMPLES

A list from the laptop:
<div class="hud-rows">
  <div class="hud-row"><span class="hud-idx">01</span><span class="hud-main"><span class="hud-label">Physics notes.pdf</span><span class="hud-sub">Downloads · today</span></span><span class="hud-tag">2 MB</span></div>
  <div class="hud-row"><span class="hud-idx">02</span><span class="hud-main"><span class="hud-label">Exam timetable.xlsx</span></span><span class="hud-tag">48 KB</span></div>
</div>

A single figure from the laptop (a web figure goes on show_data instead):
<div><span class="hud-metric">1,284</span><span class="hud-unit">files in Downloads</span></div>

An image:
<div><img class="hud-img" src="https://images.example.com/sr71.jpg"><span class="hud-caption">SR-71 Blackbird</span></div>

Image search results — the pictures ARE the answer, so lead with them:
<div class="hud-figure">
  <div class="hud-gallery">
    <img class="hud-thumb" src="https://images.example.com/sr71-01.jpg">
    <img class="hud-thumb" src="https://cdn.example.org/blackbird-takeoff.jpg">
    <img class="hud-thumb" src="https://static.example.net/sr71-cockpit.jpg">
    <img class="hud-thumb" src="https://images.example.com/sr71-hangar.jpg">
  </div>
  <span class="hud-caption">SR-71 Blackbird · four of two hundred results</span>
</div>

A video result — embedded and playable:
<div class="hud-figure">
  <div class="hud-embed"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="Flight 11, full replay" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
  <span class="hud-caption">SpaceX · 4:32</span>
</div>

A direct video file:
<video class="hud-video" controls playsinline preload="metadata" poster="https://cdn.example.com/still.jpg"><source src="https://cdn.example.com/clip.mp4" type="video/mp4"></video>

A short readout:
<p class="hud-note">Three of the four services are nominal. <span class="hud-hot">Vercel is degraded</span> in eu-west.</p>
`.trim()

const schema = {
  title: z
    .string()
    .describe('Short heading for the panel, two to four words. e.g. "DOWNLOADS", "INBOX".'),
  html: z
    .string()
    .describe(
      'The panel body as an HTML fragment, composed using the design system in ' +
        'this tool description. Author it for the specific content — a list, an ' +
        'image, a number and a caption, whatever fits.',
    ),
  // `anim` and `accent` were dropped: the face never used either, and every
  // unused argument is read on every turn.
  slot: z
    .enum(['right', 'left', 'wide'])
    .default('right')
    .describe(
      'Where it sits. right = the default stack beside the reactor. ' +
        'left = the opposite side, for a second simultaneous panel. ' +
        'wide = a broader card under the reactor, for images or dense tables.',
    ),
  hold: z
    .enum(['turn', 'sticky'])
    .default('turn')
    .describe(
      'turn = clears when the user next speaks, the default. ' +
        'sticky = stays until replaced; use only when the user will refer back to it.',
    ),
}

const DESCRIPTION = `Put something on the ${IDENTITY.name} heads-up display.

You are designing the panel, not filling in a template — compose the markup for
the content at hand and choose the position that suits it.

Not for a web answer. After a web search the sources card appears by itself and
the answer's figure, name, date or score goes in the <data> tag at the end of
your answer. Never compose a
card of results, headlines or a page's substance — not even when the user asks
to see them; the cards already show it. Answer out loud.

Use it for OTHER things the user asked to see: pictures, a video, a list or a
figure from the laptop, a short readout.

If an image search came back with pictures, show the pictures — thumbnails from
the web render properly here, and describing an image you are holding the URL of
is a worse answer than putting it on the screen. If it came back with a video,
embed it so it plays.

Call it BEFORE or WHILE you speak, so the panel is up as you start talking.
Never read a panel aloud — say what it means, not what it contains. Speaking
stays one or two sentences even when the panel is dense.

${DESIGN_SYSTEM}`

/**
 * Panel ids are React keys and they arrive in bursts, so `Date.now()` alone
 * collides. A random suffix looked like it solved that but was written
 * unpadded, so `p1700000000001` (from suffix 1) and `p170000000000` + `1`
 * are the same string. A counter is simply unique.
 */
let seq = 0

// ---------------------------------------------------------------------------
// Blades
// ---------------------------------------------------------------------------

const BLADE_DESCRIPTION = `Open something on the blades — the big surface.

A panel is a card you glance at. A blade is a thing you LOOK at: a photograph
worth seeing properly, an article worth reading, a video worth watching. Blades
sit in a column beside you, and the user can pull one forward or throw it to
full screen. Use a blade whenever the content deserves the frame, and a
panel when it deserves a line.

Choosing what to open:
  article — a web page. \`mode: "reader"\` strips it to the words and restyles
            them into this interface: always legible, ignores whether the site
            allows being embedded. \`mode: "live"\` shows the real page, which is
            right when the layout carries meaning — a dashboard, a profile, a
            table, a chart. Both are fetched by the bridge and served locally,
            so sites that block embedding still open.
  image   — one picture, full width of the blade.
  gallery — several pictures at once. This is the answer to an image search.
  video   — a direct .mp4/.webm file.
  embed   — a YouTube or Vimeo watch URL. It is turned into a player.
  markup  — your own composed HTML, in the same .hud-* system the display tool
            uses, when none of the above is the shape of the answer.

Size is about reading, not decoration. \`tall\` is a reading column — use it for
any article the user intends to actually read. \`wide\` suits images, video and
tables. \`full\` takes the screen and should be reserved for the moment the
content IS the answer. \`compact\` is a thumbnail that stays out of the way.

Call \`probe_url\` first when you are not certain what a URL is. Do not guess
from the file extension — image CDNs routinely serve pictures from URLs with no
extension, and a link that looks like a video is usually a page about one.

Never open a blade the user did not ask for and does not need. One blade that
answers the question beats three that surround it.`

const bladeSchema = {
  title: z
    .string()
    .describe('Two to four words naming what this is, e.g. "REUTERS" or "MARK VII".'),
  kind: z
    .enum(['article', 'image', 'gallery', 'video', 'embed', 'markup'])
    .describe('What is being opened. See the tool description.'),
  url: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      'The address, for article / image / video / embed. Use a URL that ' +
        'appeared verbatim in a tool result — never one you assembled yourself.',
    ),
  images: z
    .array(z.string())
    .optional()
    .catch(undefined)
    .describe('Image URLs, for kind "gallery". Four is a good number, eight the most.'),
  html: z
    .string()
    .optional()
    .catch(undefined)
    .describe('Your own markup, for kind "markup", in the .hud-* design system.'),
  mode: z
    .enum(['reader', 'live'])
    .optional()
    .catch(undefined)
    .describe('For kind "article": reader = the words restyled, live = the real page.'),
  size: z
    .enum(['compact', 'tall', 'wide', 'full'])
    .optional()
    .catch(undefined)
    .describe('tall = a reading column. wide = pictures and tables. full = the screen.'),
  hold: z
    .enum(['turn', 'sticky'])
    .optional()
    .catch(undefined)
    .describe('turn = closes when the user next speaks. sticky = stays until replaced.'),
}

const PROBE_DESCRIPTION = `Find out what is actually at a URL before showing it.

Returns what it is, whether it can be reached at all, and — for a web page —
its title, how much readable prose it holds, and a lead image if it has one.

Worth calling whenever you are about to put something on screen and are not
certain of it. The failure this avoids is the visible kind: a blade that opens
onto a blank rectangle because the link was a consent wall, or an image that
turns out to be an HTML page, in front of the user, while you describe it as
though it worked.

It reports a \`suggestion\`. That is advice from something that has only seen
the bytes — it does not know whether the user asked to read this or merely to
see it, what is already on screen, or whether the point was the picture or the
argument. You know those things. Overrule it whenever you have reason to.`

// ---------------------------------------------------------------------------
// The answer's data card
// ---------------------------------------------------------------------------

/**
 * What show_data says back. Told to speak first, the model still sometimes
 * draws the card first (2026-10-11, the gold price: 17.9 s to the first word);
 * "say nothing more" would then leave her silent, so the result asks for the
 * answer when it hasn't been said yet.
 */
export const SHOWN = "Shown. If you haven't said the answer yet, say it now in one sentence, the figure first; otherwise say nothing more."

const DATA_DESCRIPTION = `Put a web answer's data card on screen — the slow way.

Prefer ending your spoken answer with the card as a <data>{…}</data> tag (same
fields as below): it is drawn the same way and needs no second turn. Use this
tool only if you could not. After a web search, SAY the answer first, the figure
first. Then call this once, in the same message, and say nothing after it. Only when the answer is a figure,
a name, a date, a score or a yes/no ("what's the price of gold", "who won the
match", "when does it launch"); skip it for news, how-to and explanations.

- headline: the answer. For a quantity, \`value\` is the number exactly as the
  results give it ("₹1,23,450", "69,104", "6.2%") and its unit goes in \`unit\`
  ("per 10 g"). Who won the match: { label: "Winner", value: "India" }.
- rows: at most three supporting figures, e.g. { label: "Margin", value: "6 wickets" }.
- sources: the URLs of the results you actually used, as the search gave them —
  at most three. The sources card lists them.
- note: one short line, only when it matters. A figure you calculated or
  converted yourself says so here ("Converted at the RBI rate").

Every number must be one the search or page results give. The sources card
appears by itself; never use \`display\` for the same answer, and never call this
after the research tool, which puts up its own cards.`

const field = z.string()
const dataSchema = {
  title: field.describe('The card heading in a few words, e.g. "GOLD PRICE · HYDERABAD".'),
  headline: z
    .object({
      label: field.describe('What the figure is, e.g. "24K gold" or "Winner".'),
      value: field.describe('The figure as the results give it, e.g. "₹1,23,450", "6.2%", "India", "Yes".'),
      unit: field.optional().describe('Its unit, e.g. "per 10 g".'),
      asOf: field.optional().describe('When it is from, e.g. "8 Oct, 10:30 am".'),
      change: field.optional().describe('Its move, as the results give it, e.g. "+0.8% today".'),
    })
    .nullish()
    .describe('The one answer.'),
  rows: z
    .array(
      z.object({
        label: field,
        value: field,
        unit: field.optional(),
        note: field.optional(),
      }),
    )
    .nullish()
    .describe('At most three supporting figures.'),
  note: field.optional().describe('One short line, only when it matters.'),
  sources: z.array(field).nullish().describe('The URLs you used, as the search gave them; at most three.'),
}

/**
 * What the card holds: a headline, three rows, a short note, three sources (the
 * owner's redesign). A unit sits beside the big figure, so it stays short — the
 * face's own limit (src/lib/research.ts), so nothing is cut twice.
 */
export const DATA_LIMITS = { title: 32, value: 40, label: 48, unit: 20, text: 40, note: 140, rows: 3, sources: 3 }

/** A note that owns up to arithmetic: its figures need not be on the page. */
const WORKED_OUT = /\b(?:calculat|convert|comput)/i

/** One line, clipped at a word where it can be so a figure is never cut in half. */
const clipLine = (value, max) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** One headline or row as the card shows it, or null when it has no value to show. */
function cleanItem(raw, extra) {
  if (!raw || typeof raw !== 'object') return null
  const value = clipLine(raw.value, DATA_LIMITS.value)
  if (!value) return null
  const out = { label: clipLine(raw.label, DATA_LIMITS.label), value }
  for (const key of ['unit', ...extra]) {
    const v = clipLine(raw[key], key === 'unit' ? DATA_LIMITS.unit : DATA_LIMITS.text)
    if (v) out[key] = v
  }
  return out
}

/**
 * The data card, checked: what show_data puts on screen, or the reason it
 * refuses — handed back as an error, so the model gets one more go.
 *
 * @param {object} args — show_data's input
 * @param {{ links: object[], pages: string[], text: string, data: boolean, research: boolean } | null} evidence
 *   this turn's search results and pages (createTurnCards in sources.mjs)
 * @returns {{ ok: true, data: object, urls: string[] } | { ok: false, error?: string, already?: boolean }}
 */
export function checkData(args, evidence) {
  const headline = cleanItem(args?.headline, ['asOf', 'change'])
  const rows = (Array.isArray(args?.rows) ? args.rows : [])
    .map((r) => cleanItem(r, ['note']))
    .filter((r) => r && r.label)
    .slice(0, DATA_LIMITS.rows)
  if (!headline && !rows.length) {
    return { ok: false, error: 'Not shown: give a headline or at least one row, each with a value.' }
  }
  if (!evidence || (!evidence.links.length && !evidence.pages.length)) {
    return { ok: false, error: 'No sources this turn: just say the answer.' }
  }
  if (evidence.research) {
    return { ok: false, error: 'Not shown: the research cards are already on screen. Say nothing more.' }
  }
  if (evidence.data) return { ok: false, already: true }
  const note = clipLine(args?.note, DATA_LIMITS.note)
  // A figure the model wrote that the results never gave is the one failure
  // this card exists to prevent — unless it says it did the arithmetic.
  if (!WORKED_OUT.test(note)) {
    const figures = [headline?.value, headline?.change, ...rows.map((r) => r.value)].filter(Boolean)
    for (const value of figures) {
      if (!supportsNumbers(value, evidence.text).ok) {
        return { ok: false, error: `"${value}" is not in the search results — use the figure as the results give it.` }
      }
    }
  }
  const data = {
    title: clipLine(args?.title, DATA_LIMITS.title) || 'ANSWER',
    headline,
    rows,
    ...(note ? { note } : {}),
  }
  const urls = (Array.isArray(args?.sources) ? args.sources : [])
    .filter((u) => typeof u === 'string' && u.trim())
    .slice(0, DATA_LIMITS.sources)
  return { ok: true, data, urls }
}

/**
 * The HUD's tools, for displayServer — and for tests.
 *
 * @param {(blade: object) => void} emitBlade - pushes a blade to the browser
 * @param {{ cards?: ReturnType<import('./sources.mjs').createTurnCards> }} [options]
 *   cards — this connection's per-turn cards (server.mjs): what show_data
 *           checks figures against, and how it draws the data and sources cards
 */
export function displayTools(emitBlade, { cards } = {}) {
  return [
    tool('display', DESCRIPTION, schema, async (args) => {
      // Refuse rather than warn. Emitting anyway put a blank card on screen
      // and told the model nothing, so it had no reason to try again; handed
      // back as an error it gets one more go with actual content in it.
      //
      // The media test counts video and iframe as well as img, because a
      // panel whose whole point is a playable result carries no text at all —
      // rejecting it would refuse the one thing this tool was just taught to
      // do. <source> counts too: a <video> is often written with its src on
      // the child element rather than the parent.
      const text = String(args.html ?? '').replace(/<[^>]*>/g, '').trim()
      if (!text && !/<(img|video|iframe|source)\b/i.test(args.html ?? '')) {
        console.warn('[gnosis] display called with an empty body:', args.title)
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                'Not shown: the panel body was empty. A panel needs visible ' +
                'text or an image — call display again with the content ' +
                'composed into the html argument.',
            },
          ],
        }
      }
      /**
       * Composed markup opens as a blade, not as a card.
       *
       * There is one surface now. A second place for things to appear meant
       * the user had two places to look and the model had a decision to make
       * every time it wanted to show something — and it made that decision
       * on grounds it could not possibly know, since only the person looking
       * at the screen knows whether they are glancing or reading.
       *
       * The tool keeps its name and its design system because the model is
       * fluent in both; only where the result lands has changed.
       */
      emitBlade({
        id: `p${Date.now().toString(36)}-${(seq++).toString(36)}`,
        title: String(args.title ?? '').trim() || 'DISPLAY',
        kind: 'markup',
        html: args.html,
        size: args.slot === 'wide' ? 'wide' : 'compact',
        hold: args.hold ?? 'turn',
      })
      return { content: [{ type: 'text', text: 'On screen.' }] }
    }),

    tool('blade', BLADE_DESCRIPTION, bladeSchema, async (args) => {
      const kind = args.kind
      const url = String(args.url ?? '').trim()
      const images = Array.isArray(args.images) ? args.images.filter(Boolean) : []

      // Refused rather than emitted, for the same reason the display tool
      // refuses an empty body: a blade that opens onto nothing looks like the
      // interface failing, and the model gets no signal to try again.
      if (kind === 'gallery' && !images.length) {
        return refuse('Not opened: a gallery needs at least one image URL in `images`.')
      }
      if (kind === 'markup' && !String(args.html ?? '').trim()) {
        return refuse('Not opened: kind "markup" needs an `html` body.')
      }
      if (['article', 'image', 'video', 'embed'].includes(kind) && !url) {
        return refuse(`Not opened: kind "${kind}" needs a \`url\`.`)
      }

      const blade = {
        id: `b${Date.now().toString(36)}-${(seq++).toString(36)}`,
        title: String(args.title ?? '').trim() || 'DISPLAY',
        kind,
        url: url || undefined,
        images: images.length ? images.slice(0, 8) : undefined,
        html: args.html || undefined,
        mode: args.mode ?? 'reader',
        // A reading column for anything meant to be read, a broad frame for
        // anything meant to be looked at. Getting this wrong is the difference
        // between an article you can follow and one in a letterbox.
        size: args.size ?? (kind === 'article' ? 'tall' : 'wide'),
        hold: args.hold ?? 'turn',
      }
      emitBlade(blade)
      return { content: [{ type: 'text', text: `Open on the blades as "${blade.title}".` }] }
    }),

    tool(
      'probe_url',
      PROBE_DESCRIPTION,
      { url: z.string().describe('The absolute URL to inspect.') },
      async (args) => {
        const report = await probeUrl(String(args.url ?? ''))
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 1) }] }
      },
    ),

    tool('show_data', DATA_DESCRIPTION, dataSchema, async (args) => {
      const verdict = checkData(args, cards?.evidence() ?? null)
      // A second call in one turn would be a second data card: the first stays.
      if (verdict.already) return said('Already on screen. Say nothing more.')
      if (!verdict.ok) return refuse(verdict.error)
      // The data card, then the sources card narrowed to what she used; ids
      // are the turn's own (d-<ask>, src-<ask>), so the face replaces in place.
      cards.showData(verdict.data, verdict.urls)
      return said(SHOWN)
    }),
  ]
}

/**
 * The HUD as an in-process MCP server: `display`, `blade`, `probe_url` and
 * `show_data` (see displayTools).
 *
 * @param {(blade: object) => void} emitBlade - pushes a blade to the browser
 * @param {{ cards?: ReturnType<import('./sources.mjs').createTurnCards> }} [options]
 */
export function displayServer(emitBlade, options = {}) {
  return createSdkMcpServer({
    name: 'ayra',
    version: '1.0.0',
    instructions:
      `The ${IDENTITY.name} heads-up display. A web answer's figure goes in a <data> tag at the end of ` +
      'the answer (show_data is the slow fallback); `display` and `blade` show anything else the owner asks to see.',
    // Never defer this behind tool search — if the model has to go looking for
    // it, it won't occur to it to show anything.
    alwaysLoad: true,
    tools: displayTools(emitBlade, options),
  })
}

const said = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })
