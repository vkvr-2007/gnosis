/**
 * The platform retrievers behind researcher mode.
 *
 * Researcher mode searches the places people actually answer technical and
 * practical questions. Four of them have official, public, keyless APIs, and
 * those are searched here in code — no model in the loop, so a search costs no
 * Claude usage and comes back in a second:
 *
 *   github         GitHub REST      repositories (+ their READMEs) and issues
 *   stackoverflow  Stack Exchange   questions and their top answers
 *   hackernews     HN Algolia       stories and their top comments
 *   arxiv          arXiv API        papers (title, abstract, authors, date)
 *
 * Reddit, Quora and the open web have no keyless official search API we may
 * use, so they are searched with the WebSearch tool and a site: filter
 * (siteQuery), and whatever comes back is turned into the same Item shape by
 * itemFromPage. No scraping and no unofficial endpoints, anywhere.
 *
 * Every request goes through bridge/net.mjs (SSRF gate, vetted redirects).
 * Every API's free limit is respected by a budget kept here (take, pause):
 * a call that would go over is refused at once with err.code 'RATE_LIMITED',
 * and a "slow down" from a server pauses that API for as long as it asked.
 * Nothing is ever retried in a loop.
 *
 * Everything an API returns is untrusted web content written by strangers.
 * It is reduced to plain text (cleanText), capped, and never followed: no URL
 * found in a body is fetched, and no text is treated as an instruction.
 *
 * @typedef {'repo'|'issue'|'question'|'answer'|'post'|'thread'|'story'|'paper'|'page'} ItemKind
 * @typedef {{ score?: number, comments?: number, stars?: number, forks?: number, answers?: number, accepted?: boolean }} Signals
 * @typedef {{ platform: string, url: string, title: string, author?: string, published?: string, kind: ItemKind,
 *             signals: Signals, signal: string, text: string, via: 'api'|'page'|'search' }} Item
 */

import { fetchJson as netFetchJson, fetchText as netFetchText } from './net.mjs'

export { fetchJson } from './net.mjs'

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const PLATFORM_INFO = Object.freeze({
  reddit: { label: 'Reddit', domains: ['reddit.com'] },
  quora: { label: 'Quora', domains: ['quora.com'] },
  github: { label: 'GitHub', domains: ['github.com'] },
  stackoverflow: {
    label: 'Stack Overflow',
    domains: ['stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com'],
  },
  hackernews: { label: 'Hacker News', domains: ['news.ycombinator.com'] },
  arxiv: { label: 'arXiv', domains: ['arxiv.org'] },
  web: { label: 'Web', domains: [] },
})

/** Searched here through official public APIs. The rest go through WebSearch with siteQuery. */
export const API_PLATFORMS = Object.freeze(['github', 'stackoverflow', 'hackernews', 'arxiv'])

const KINDS = new Set(['repo', 'issue', 'question', 'answer', 'post', 'thread', 'story', 'paper', 'page'])

const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

/** 'https://old.reddit.com/r/x/…' → 'reddit'; anything not on a known platform → 'web'. */
export function platformOf(url) {
  const host = hostOf(url)
  if (!host) return 'web'
  for (const [key, { domains }] of Object.entries(PLATFORM_INFO)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return key
  }
  return 'web'
}

/**
 * A WebSearch query limited to one platform: 'query site:reddit.com'. For
 * the platforms without a keyless API (reddit, quora); 'web' gets no filter.
 */
export function siteQuery(query, platform) {
  const domains = PLATFORM_INFO[platform]?.domains ?? []
  const q = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (!domains.length) return q
  return `${q} ${domains.map((d) => `site:${d}`).join(' OR ')}`
}

// ---------------------------------------------------------------------------
// Text: everything here is untrusted, so it is flattened to plain text
// ---------------------------------------------------------------------------

/** The entities that matter in API bodies; anything else numeric is decoded generically. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  times: '×', divide: '÷', deg: '°', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', plusmn: '±', le: '≤', ge: '≥', ne: '≠', rarr: '→', larr: '←', check: '✓',
}

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      const valid = Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      return valid ? String.fromCodePoint(cp) : ' '
    }
    return NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()] ?? whole
  })
}

/** Cut to `max` characters at a word boundary when one is near, with an ellipsis. */
function cap(s, max) {
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, Math.max(0, max))
  const cut = s.slice(0, max - 1)
  const space = cut.search(/\s\S*$/)
  return `${(space > max - 200 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * Text that is already plain, made safe to hand on: invisible format
 * characters gone (zero-width and bidi controls are how text is hidden from a
 * person but not from a model), control characters spaced, whitespace tidied,
 * paragraphs kept, capped.
 */
function tidy(input, max) {
  const s = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\P{Cc}\n]/gu, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cap(s, max)
}

/** One line of plain text: tidied, no newlines, capped. */
const oneLine = (s, max) => cap(tidy(s, Infinity).replace(/\s+/g, ' '), max)

/** Past this nothing would survive the cap, and regexes over megabytes are slow. */
const MAX_CLEAN_INPUT = 400_000

/** Code in Markdown is content, not markup: escaped so the tag pass leaves '<Suspense>' alone. */
const escapeCode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Does this look like HTML rather than plain text that happens to contain a '<'? */
const looksLikeHtml = (s) => /<\/(p|div|span|a|li|ul|td|h[1-6]|code|pre|em|strong|b|i)\s*>|<br\s*\/?>|<p\b[^<>]*>/i.test(s)

/** Elements whose content is never prose. */
const DROP_ELEMENTS = /<(script|style|noscript|template|svg|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi
const BLOCK_CLOSE = /<\/(p|div|li|ul|ol|h[1-6]|pre|blockquote|tr|table|thead|tbody|section|article|header|footer|aside|dd|dt|dl|details|summary|figure|figcaption)\s*>/gi
const BLOCK_OPEN = /<(p|div|h[1-6]|pre|blockquote|tr|table|section|article|header|footer|aside|ul|ol|dl|details|summary|figure|hr)\b[^<>]*>/gi

/**
 * HTML or Markdown (or a README that is both) as plain text a model can read.
 *
 * Tags go before entities are decoded, so a code sample's '&lt;div&gt;'
 * survives as '<div>' text instead of being stripped as a tag; Markdown code
 * spans and fences are escaped first for the same reason. Markdown loses its
 * syntax but keeps its words: links become their text, images (mostly badges)
 * go. Then tidy(): invisible characters out, whitespace in order. Never
 * rendered as HTML anywhere; the result is ≤ `max` characters.
 */
export function cleanText(input, max = 8000) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 8000
  let s = String(input ?? '')
  if (s.length > MAX_CLEAN_INPUT) s = s.slice(0, MAX_CLEAN_INPUT)
  s = s
    .replace(/\r\n?/g, '\n')
    .replace(/^([ \t]*)(```|~~~)([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*$/gm, (_, indent, fence, info, code) => `${indent}${fence}${info}\n${escapeCode(code)}\n${fence}`)
    .replace(/`([^`\n]+)`/g, (_, code) => `\`${escapeCode(code)}\``)
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(DROP_ELEMENTS, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object)\b[^<>]*>/gi, ' ')
    .replace(/<img\b[^<>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(BLOCK_CLOSE, '\n\n')
    .replace(BLOCK_OPEN, '\n\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>/g, '')
    // Markdown
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, '')
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/!\[[^\]\n]*\]\[[^\]\n]*\]/g, '')
    // A badge was an image inside a link: with the image gone, the empty link goes too.
    .replace(/\[\s*\]\([^)\n]*\)/g, '')
    .replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
    .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]+\S+.*$/gm, '')
    .replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    // A table's delimiter row ('|---|:-:|'): GFM allows a single dash per cell, so a pipe is what marks it.
    .replace(/^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*(?::?-+:?[ \t]*)?$/gm, '')
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/`([^`\n]+)`/g, '$1')
  return tidy(decodeEntities(s), limit)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Words that make a question a sentence rather than a search. */
const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both
  but by can could did do does doing done down during each either few for from further had has have having he her here
  hers him his how i if in into is it its itself just let me more most my myself no nor not of off on once only or other
  our ours out over own same she should so some such than that the their theirs them then there these they this those
  through to too under until up very was we were what when where which while who whom whose why will with would you your
  yours yourself best better good great way ways use using used vs versus compare comparison difference differences tell
  explain show find give know need want get make please really actually anyone someone something thing things think
  latest new recent current top lot lots much many like via etc eg ie`.split(/\s+/),
)

/**
 * The searchable words of a question, at most `max`: lower-cased, stopwords
 * gone, tech names kept whole ('c++', 'node.js', '.net', 'owner/repo'). The
 * APIs AND every word, so a whole sentence would usually match nothing. If
 * every word is a stopword the words themselves are returned rather than none.
 */
export function searchTerms(query, max = 6) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#._/-]+/u)
    .map((t) => t.replace(/^[-_/]+|[-_./]+$/g, ''))
    .filter((t) => t && /[\p{L}\p{N}]/u.test(t))
  const unique = [...new Set(words)]
  const kept = unique.filter((t) => !STOPWORDS.has(t))
  return (kept.length ? kept : unique).slice(0, Math.max(1, max))
}

// ---------------------------------------------------------------------------
// Budgets: each API's free limit, respected
// ---------------------------------------------------------------------------

/**
 * Below each API's published unauthenticated limit, with room to spare:
 * GitHub allows 10 searches a minute and 60 other calls an hour per IP;
 * Stack Exchange 300 a day per IP without a key; HN Algolia 10,000 an hour.
 * arXiv asks for one request every 3 seconds, which `spaced` enforces.
 */
const LIMITS = {
  'github-search': { max: 8, windowMs: 60_000, pauseMs: 60_000 },
  'github-core': { max: 50, windowMs: 3_600_000, pauseMs: 10 * 60_000 },
  stackexchange: { max: 250, windowMs: 86_400_000, pauseMs: 10 * 60_000 },
  hackernews: { max: 2000, windowMs: 3_600_000, pauseMs: 10 * 60_000 },
  arxiv: { max: 600, windowMs: 3_600_000, pauseMs: 60_000 },
}

const LABELS = {
  'github-search': 'GitHub search',
  'github-core': 'GitHub',
  stackexchange: 'Stack Overflow',
  hackernews: 'Hacker News',
  arxiv: 'arXiv',
}

/** api → recent call times / time until which the api is not called / arXiv's next free slot. */
const used = new Map()
const pausedUntil = new Map()
let arxivNext = 0

/** Forget every budget (tests, or a fresh start). */
export function resetBudgets() {
  used.clear()
  pausedUntil.clear()
  arxivNext = 0
}

/** One call's worth of budget, or false when it would go over (or the API asked us to wait). */
function take(api, now = Date.now()) {
  if ((pausedUntil.get(api) ?? 0) > now) return false
  const { max, windowMs } = LIMITS[api]
  const recent = (used.get(api) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= max) {
    used.set(api, recent)
    return false
  }
  recent.push(now)
  used.set(api, recent)
  return true
}

function pause(api, ms) {
  const until = Date.now() + Math.max(0, Math.min(ms, 86_400_000))
  pausedUntil.set(api, Math.max(pausedUntil.get(api) ?? 0, until))
}

/** The error a refused call throws, so the caller can say which source is resting and for how long. */
function rateLimited(api) {
  const waitMs = Math.max(0, (pausedUntil.get(api) ?? 0) - Date.now())
  const err = new Error(
    waitMs > 0
      ? `${LABELS[api]} asked us to slow down; try again in ${Math.ceil(waitMs / 60_000)} min`
      : `${LABELS[api]}'s free limit is used up for now`,
  )
  err.code = 'RATE_LIMITED'
  err.api = api
  err.retryInMs = waitMs || LIMITS[api].windowMs
  return err
}

/** A failed call that was the server saying "slow down" pauses that API — once, never a retry. */
function noteFailure(api, err) {
  if (!err || err.name === 'AbortError') return
  const status = Number(err.upstream) || Number(/upstream said (\d+)/.exec(String(err.message))?.[1]) || 0
  const body = err.body && typeof err.body === 'object' ? err.body : null
  // Stack Exchange answers a throttle with 400 and error_id 502 (throttle_violation).
  const seThrottle = body && (Number(body.error_id) === 502 || body.error_name === 'throttle_violation')
  if (status === 429 || status === 403 || status === 503 || seThrottle) {
    const said = Number(/available in (\d+) seconds/.exec(String(body?.error_message ?? ''))?.[1]) * 1000
    pause(api, Number(err.retryAfterMs) > 0 ? Number(err.retryAfterMs) : said > 0 ? said : LIMITS[api].pauseMs)
  }
}

/** Stack Exchange's own pacing fields, obeyed: `backoff` seconds before the next call, and its daily quota. */
function noteStackExchange(reply) {
  const backoff = Number(reply?.backoff)
  if (backoff > 0) pause('stackexchange', backoff * 1000)
  const left = Number(reply?.quota_remaining)
  if (Number.isFinite(left) && left < 5) pause('stackexchange', 60 * 60_000)
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** Settle with `promise`, or reject the moment `signal` aborts — even if the work ignores the signal. */
function guard(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

const isAbort = (err) => err?.name === 'AbortError'

/** One budgeted API call. Refused at once (RATE_LIMITED) rather than queued. */
async function call(api, run, signal) {
  if (signal?.aborted) throw abortError()
  if (!take(api)) throw rateLimited(api)
  try {
    return await guard(Promise.resolve().then(run), signal)
  } catch (err) {
    noteFailure(api, err)
    throw err
  }
}

/** Wait for arXiv's next 3-second slot (reserved first, so parallel callers queue rather than collide). */
async function spaced(spacingMs, signal) {
  const now = Date.now()
  const slot = Math.max(now, arxivNext)
  if (slot - now > 15_000) throw rateLimited('arxiv')
  arxivNext = slot + spacingMs
  const wait = slot - now
  if (wait <= 0) return
  await guard(new Promise((resolve) => setTimeout(resolve, wait)), signal)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Sent to every API: GitHub requires a User-Agent, and an honest one is what each API's terms ask for. */
export const API_UA = 'gnosis-research-assistant/1.0 (+https://github.com/vkvr-2007/gnosis)'

const API_TIMEOUT_MS = 8000
const enc = encodeURIComponent
const list = (x) => (Array.isArray(x) ? x : [])
const int = (x, lo, hi, fallback) => {
  const n = Math.floor(Number(x))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const count = (x) => {
  if (x === null || x === undefined || x === '' || typeof x === 'boolean') return undefined
  const n = Number(x)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

/** Any date the APIs give (ISO, epoch seconds) → ISO, or '' when it is not a date. */
function isoDate(x, epochSeconds = false) {
  if (x === undefined || x === null || x === '') return ''
  const ms = epochSeconds || (typeof x === 'number' && x < 1e11) ? Number(x) * 1000 : Date.parse(String(x))
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

/** 1234 → '1.2k', 2_500_000 → '2.5M'. */
function compact(n) {
  const v = Number(n) || 0
  const abs = Math.abs(v)
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(v))
}

const plural = (n, one, many = `${one}s`) => `${compact(n)} ${Math.abs(Number(n)) === 1 ? one : many}`

/** A URL from an API body is kept only if it is http(s) and on the platform it claims to be. */
function onPlatform(url, platform) {
  const u = String(url ?? '')
  return /^https?:\/\//i.test(u) && platformOf(u) === platform ? u : ''
}

/**
 * The Item, with empty optional fields left out. `title` and `author` arrive
 * as plain text (callers decode an API's HTML-escaped fields first) — they
 * are tidied but never tag-stripped, so an issue titled '<Suspense> breaks'
 * keeps its subject. `text` arrives cleaned and is only capped here.
 */
function makeItem({ platform, url, title, author, published, kind, signals, signal, text, via }) {
  const item = {
    platform,
    url,
    title: oneLine(title, 300) || url,
    kind: KINDS.has(kind) ? kind : 'page',
    signals: signals ?? {},
    signal: oneLine(signal, 200),
    text: cap(String(text ?? ''), 8000),
    via,
  }
  const who = oneLine(author, 120)
  if (who) item.author = who
  const when = isoDate(published)
  if (when) item.published = when
  return item
}

/** Only the counts the Item type knows, and only real numbers. */
function pickSignals(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of ['score', 'comments', 'stars', 'forks', 'answers']) {
    const n = count(raw[key])
    if (n !== undefined) out[key] = n
  }
  if (typeof raw.accepted === 'boolean') out.accepted = raw.accepted
  return out
}

/** The counts in a few words, for the card: '12k stars · 1.1k forks'. */
function describe(signals, kind) {
  const s = signals ?? {}
  const parts = []
  if (s.stars !== undefined) parts.push(plural(s.stars, 'star'))
  if (s.forks !== undefined) parts.push(plural(s.forks, 'fork'))
  if (s.score !== undefined) {
    parts.push(kind === 'story' ? plural(s.score, 'point') : kind === 'issue' ? plural(s.score, 'reaction') : plural(s.score, 'vote'))
  }
  if (s.answers !== undefined) parts.push(plural(s.answers, 'answer'))
  if (s.comments !== undefined) parts.push(plural(s.comments, 'comment'))
  if (s.accepted) parts.push(kind === 'paper' ? 'published in a journal' : kind === 'question' ? 'has an accepted answer' : 'accepted answer')
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com'
const GITHUB_HEADERS = {
  'user-agent': API_UA,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
}
const README_BYTES = 400_000
/** owner/repo as GitHub allows it — checked before it goes into a URL path. */
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

function repoItem(r) {
  if (!r || typeof r !== 'object') return null
  const full = String(r.full_name ?? '')
  if (!REPO_NAME.test(full)) return null
  const url = onPlatform(r.html_url, 'github') || `https://github.com/${full}`
  const signals = pickSignals({ stars: r.stargazers_count, forks: r.forks_count })
  const lang = oneLine(r.language, 40)
  const pushed = isoDate(r.pushed_at ?? r.updated_at)
  const extra = [lang, pushed ? `updated ${pushed.slice(0, 10)}` : '', r.archived ? 'archived' : ''].filter(Boolean)
  // GitHub's descriptions are plain text, not HTML: tidied, not tag-stripped.
  const description = tidy(r.description, 1000)
  const topics = list(r.topics).map((t) => oneLine(t, 50)).filter(Boolean).slice(0, 12)
  return {
    full,
    item: makeItem({
      platform: 'github',
      url,
      title: description ? `${full} — ${description}` : full,
      author: r.owner?.login,
      // A repository's freshness matters more than its birthday.
      published: r.pushed_at ?? r.updated_at ?? r.created_at,
      kind: 'repo',
      signals,
      signal: [describe(signals, 'repo'), ...extra].filter(Boolean).join(' · '),
      text: [description, topics.length ? `Topics: ${topics.join(', ')}` : '', lang ? `Language: ${lang}` : '']
        .filter(Boolean)
        .join('\n'),
      via: 'api',
    }),
  }
}

function issueItem(i) {
  if (!i || typeof i !== 'object') return null
  const url = onPlatform(i.html_url, 'github')
  if (!url) return null
  const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(String(i.repository_url ?? ''))?.[1] ?? ''
  const number = count(i.number)
  const signals = pickSignals({ comments: i.comments, score: i.reactions?.total_count })
  const state = i.state === 'closed' ? 'closed' : i.state === 'open' ? 'open' : ''
  const where = REPO_NAME.test(repo) ? `${repo}${number ? `#${number}` : ''}: ` : ''
  return makeItem({
    platform: 'github',
    url,
    title: `${where}${String(i.title ?? '')}`,
    author: i.user?.login,
    published: i.created_at,
    kind: 'issue',
    signals,
    signal: [describe(signals, 'issue'), state].filter(Boolean).join(' · '),
    text: cleanText(i.body),
    via: 'api',
  })
}

/**
 * GitHub: one repository search, one issue search (both count against the
 * 10-a-minute search limit) and the README of the top `readmes` repositories
 * (60-an-hour core limit). Either search may fail alone; both failing throws.
 * A README that will not come leaves its repository with the description.
 *
 * @returns {Promise<Item[]>} repositories first, then issues
 */
export async function searchGithub(
  query,
  { fetchJson = netFetchJson, fetchText = netFetchText, limit = 5, readmes = 3, signal, timeoutMs = API_TIMEOUT_MS } = {},
) {
  const terms = searchTerms(query, 5)
  if (!terms.length) return []
  const n = int(limit, 1, 20, 5)
  const opts = { timeoutMs, signal, headers: GITHUB_HEADERS }
  // Name, description and topics only. With `in:readme` too, mega-collections
  // whose README mentions everything outrank the project itself (seen live:
  // 'sqlite full text search' → a 57k-star n8n workflow dump first). The issue
  // search below is the wide net.
  const repoQ = `${terms.join(' ')} in:name,description,topics`
  // `is:issue` is required by the issues search now, and keeps pull requests
  // out; `comments:>1` because an issue nobody answered is a question, not
  // evidence (seen live: best-match fills the page with fresh 0-comment issues).
  const issueQ = `${terms.slice(0, 4).join(' ')} is:issue comments:>1`
  const [repos, issues] = await Promise.allSettled([
    call('github-search', () => fetchJson(`${GITHUB_API}/search/repositories?q=${enc(repoQ)}&per_page=${n}`, opts), signal),
    call('github-search', () => fetchJson(`${GITHUB_API}/search/issues?q=${enc(issueQ)}&per_page=${n}`, opts), signal),
  ])
  if (signal?.aborted) throw abortError()
  if (repos.status === 'rejected' && issues.status === 'rejected') throw repos.reason

  const repoRows = repos.status === 'fulfilled' ? list(repos.value?.items).slice(0, n).map(repoItem).filter(Boolean) : []
  const issueItems = issues.status === 'fulfilled' ? list(issues.value?.items).slice(0, n).map(issueItem).filter(Boolean) : []

  await Promise.all(
    repoRows.slice(0, int(readmes, 0, 5, 3)).map(async (row) => {
      if (!take('github-core')) return
      try {
        const page = await guard(
          Promise.resolve().then(() =>
            fetchText(`${GITHUB_API}/repos/${row.full}/readme`, {
              maxBytes: README_BYTES,
              timeoutMs,
              accept: 'application/vnd.github.raw',
              headers: { ...GITHUB_HEADERS, accept: 'application/vnd.github.raw' },
              signal,
            }),
          ),
          signal,
        )
        const readme = cleanText(typeof page === 'string' ? page : page?.text, 8000)
        if (readme) row.item.text = cap([row.item.text, `README:\n${readme}`].filter(Boolean).join('\n\n'), 8000)
      } catch (err) {
        if (isAbort(err)) throw err
        noteFailure('github-core', err)
      }
    }),
  )
  return [...repoRows.map((r) => r.item), ...issueItems]
}

// ---------------------------------------------------------------------------
// Stack Overflow (Stack Exchange API 2.3)
// ---------------------------------------------------------------------------

const SE_API = 'https://api.stackexchange.com/2.3'
const SE_HEADERS = { 'user-agent': API_UA }

function questionItem(q) {
  if (!q || typeof q !== 'object') return null
  const url = onPlatform(q.link, 'stackoverflow')
  if (!url || !Number.isInteger(Number(q.question_id))) return null
  const signals = pickSignals({ score: q.score, answers: q.answer_count, accepted: Boolean(q.accepted_answer_id) })
  const views = count(q.view_count)
  const tags = list(q.tags).map((t) => oneLine(t, 40)).filter(Boolean).slice(0, 8)
  return makeItem({
    platform: 'stackoverflow',
    url,
    // Stack Exchange HTML-escapes titles and names ('&quot;', '&#39;').
    title: decodeEntities(String(q.title ?? '')),
    author: decodeEntities(String(q.owner?.display_name ?? '')),
    published: isoDate(q.creation_date, true),
    kind: 'question',
    signals,
    signal: [describe(signals, 'question'), views ? plural(views, 'view') : ''].filter(Boolean).join(' · '),
    text: [cleanText(q.body, 7000), tags.length ? `Tags: ${tags.join(', ')}` : ''].filter(Boolean).join('\n\n'),
    via: 'api',
  })
}

function answerItem(a, question) {
  if (!a || typeof a !== 'object' || !Number.isInteger(Number(a.answer_id))) return null
  const origin = new URL(question.url).origin
  const signals = pickSignals({ score: a.score, accepted: Boolean(a.is_accepted) })
  return makeItem({
    platform: 'stackoverflow',
    url: `${origin}/a/${Number(a.answer_id)}`,
    title: `Answer: ${question.title}`,
    author: decodeEntities(String(a.owner?.display_name ?? '')),
    published: isoDate(a.creation_date, true),
    kind: 'answer',
    signals,
    signal: describe(signals, 'answer'),
    text: cleanText(a.body),
    via: 'api',
  })
}

/**
 * Stack Overflow: one relevance search with bodies, then one call for the
 * top answers of every answered question in it (sorted by votes, at most
 * `answers` per question). Stack Exchange's `backoff` and quota fields are
 * obeyed. `site` may name another Stack Exchange site ('superuser', …).
 *
 * @returns {Promise<Item[]>} each question followed by its answers
 */
export async function searchStackOverflow(
  query,
  { fetchJson = netFetchJson, limit = 5, answers = 3, signal, site = 'stackoverflow', timeoutMs = API_TIMEOUT_MS } = {},
) {
  const terms = searchTerms(query, 6)
  if (!terms.length) return []
  const n = int(limit, 1, 20, 5)
  const where = /^[a-z][a-z.]{1,40}$/.test(String(site)) ? String(site) : 'stackoverflow'
  const opts = { timeoutMs, signal, headers: SE_HEADERS }
  const found = await call(
    'stackexchange',
    () =>
      fetchJson(
        `${SE_API}/search/advanced?order=desc&sort=relevance&q=${enc(terms.join(' '))}&site=${where}&filter=withbody&pagesize=${n}`,
        opts,
      ),
    signal,
  )
  noteStackExchange(found)
  const rows = list(found?.items)
    .slice(0, n)
    .map((q) => ({ raw: q, item: questionItem(q) }))
    .filter((r) => r.item)

  const per = int(answers, 0, 10, 3)
  const ids = rows.filter((r) => Number(r.raw.answer_count) > 0).map((r) => Number(r.raw.question_id))
  const byQuestion = new Map()
  if (per && ids.length && take('stackexchange')) {
    try {
      const got = await guard(
        Promise.resolve().then(() =>
          fetchJson(
            `${SE_API}/questions/${ids.join(';')}/answers?order=desc&sort=votes&site=${where}&filter=withbody&pagesize=100`,
            opts,
          ),
        ),
        signal,
      )
      noteStackExchange(got)
      for (const a of list(got?.items)) {
        const qid = Number(a?.question_id)
        if (!byQuestion.has(qid)) byQuestion.set(qid, [])
        byQuestion.get(qid).push(a)
      }
    } catch (err) {
      if (isAbort(err)) throw err
      noteFailure('stackexchange', err)
    }
  }

  const out = []
  for (const { raw, item } of rows) {
    out.push(item)
    const mine = (byQuestion.get(Number(raw.question_id)) ?? [])
      // Votes first, the accepted answer breaking ties — the asker's pick is a signal, not the verdict.
      .sort((x, y) => (Number(y.score) || 0) - (Number(x.score) || 0) || Number(Boolean(y.is_accepted)) - Number(Boolean(x.is_accepted)))
      .slice(0, per)
    for (const a of mine) {
      const answer = answerItem(a, item)
      if (answer) out.push(answer)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Hacker News (Algolia)
// ---------------------------------------------------------------------------

const HN_API = 'https://hn.algolia.com/api/v1'
const HN_HEADERS = { 'user-agent': API_UA }
/** A big thread's whole tree can run to megabytes; past this its comments are skipped. */
const HN_ITEM_BYTES = 3_000_000
const COMMENTS_PER_STORY = 5

/**
 * The most-discussed top-level comments of a thread. HN's own ranking is not
 * in the API, so the number of replies a comment drew stands in for it.
 */
function topComments(tree, max = COMMENTS_PER_STORY) {
  const replies = (node) => {
    let total = 0
    const stack = [...list(node?.children)]
    while (stack.length && total < 100_000) {
      const next = stack.pop()
      total++
      stack.push(...list(next?.children))
    }
    return total
  }
  return list(tree?.children)
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .map((c) => ({ c, weight: replies(c) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map(({ c }) => {
      const who = oneLine(c.author, 60)
      return `${who ? `${who}: ` : ''}${cleanText(c.text, 1200)}`
    })
}

function storyItem(h) {
  if (!h || typeof h !== 'object' || !/^\d{1,12}$/.test(String(h.objectID ?? ''))) return null
  const signals = pickSignals({ score: h.points, comments: h.num_comments })
  const link = /^https?:\/\//i.test(String(h.url ?? '')) ? oneLine(h.url, 500) : ''
  return {
    id: String(h.objectID),
    discussed: Number(h.num_comments) > 0,
    item: makeItem({
      platform: 'hackernews',
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title ?? h.story_title,
      author: h.author,
      published: h.created_at ?? isoDate(h.created_at_i, true),
      kind: 'story',
      signals,
      signal: describe(signals, 'story'),
      text: [cleanText(h.story_text, 4000), link ? `Links to: ${link}` : ''].filter(Boolean).join('\n\n'),
      via: 'api',
    }),
  }
}

/**
 * Hacker News: one story search, then the discussion of the first `comments`
 * stories that have one (one call each), folded into the story's text as its
 * most-discussed top-level comments. A thread that will not load leaves the
 * story as it was.
 *
 * @returns {Promise<Item[]>}
 */
export async function searchHackerNews(
  query,
  { fetchJson = netFetchJson, limit = 5, comments = 2, signal, timeoutMs = API_TIMEOUT_MS } = {},
) {
  const terms = searchTerms(query, 6)
  if (!terms.length) return []
  const n = int(limit, 1, 20, 5)
  const opts = { timeoutMs, signal, headers: HN_HEADERS }
  const found = await call(
    'hackernews',
    () => fetchJson(`${HN_API}/search?query=${enc(terms.join(' '))}&tags=story&hitsPerPage=${n}`, opts),
    signal,
  )
  const rows = list(found?.hits).slice(0, n).map(storyItem).filter(Boolean)

  await Promise.all(
    rows
      .filter((r) => r.discussed)
      .slice(0, int(comments, 0, 5, 2))
      .map(async (row) => {
        if (!take('hackernews')) return
        try {
          const tree = await guard(
            Promise.resolve().then(() => fetchJson(`${HN_API}/items/${row.id}`, { ...opts, maxBytes: HN_ITEM_BYTES })),
            signal,
          )
          const top = topComments(tree)
          if (top.length) {
            row.item.text = cap([row.item.text, `Top comments:\n\n${top.join('\n\n')}`].filter(Boolean).join('\n\n'), 8000)
          }
        } catch (err) {
          if (isAbort(err)) throw err
          noteFailure('hackernews', err)
        }
      }),
  )
  return rows.map((r) => r.item)
}

// ---------------------------------------------------------------------------
// arXiv
// ---------------------------------------------------------------------------

const ARXIV_API = 'https://export.arxiv.org/api/query'
const ARXIV_SPACING_MS = 3000
const ARXIV_BYTES = 2_000_000

/** XML character data, CDATA unwrapped but entities still escaped — decoded exactly once, by the caller. */
const cdata = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
/** A plain XML field (title, name) as text. */
const xmlText = (s) => decodeEntities(cdata(s))

const xmlTag = (body, name) => {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`)
  return re.exec(body)?.[1] ?? ''
}

/**
 * arXiv's Atom feed as Items. An error entry (a query arXiv could not parse)
 * throws rather than becoming a "paper" called Error.
 */
export function parseArxiv(xml) {
  const out = []
  for (const [, body] of String(xml ?? '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const id = oneLine(xmlText(xmlTag(body, 'id')), 300)
    if (/arxiv\.org\/api\/errors/i.test(id)) {
      throw new Error(`arXiv refused the query: ${oneLine(xmlText(xmlTag(body, 'summary')), 200)}`)
    }
    const paper = /arxiv\.org\/abs\/([\w./-]+?)(?:v\d+)?$/i.exec(id)?.[1]
    if (!paper) continue
    const authors = [...body.matchAll(/<author\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
      .map((m) => oneLine(xmlText(m[1]), 100))
      .filter(Boolean)
    const category = /<arxiv:primary_category\b[^>]*\bterm="([^"]{1,40})"/.exec(body)?.[1] ?? ''
    const journal = oneLine(xmlText(xmlTag(body, 'arxiv:journal_ref')), 300)
    const note = oneLine(xmlText(xmlTag(body, 'arxiv:comment')), 300)
    const published = xmlText(xmlTag(body, 'published')).trim()
    // No votes on arXiv; a journal reference — published past the preprint — is the one standing signal.
    const signals = pickSignals({ accepted: Boolean(journal) })
    out.push(
      makeItem({
        platform: 'arxiv',
        url: `https://arxiv.org/abs/${paper}`,
        title: xmlText(xmlTag(body, 'title')),
        author: authors.length > 3 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', '),
        published,
        kind: 'paper',
        signals,
        signal: [
          journal ? `published: ${journal}` : 'preprint',
          category,
          authors.length ? plural(authors.length, 'author') : '',
        ]
          .filter(Boolean)
          .join(' · '),
        text: [
          // cleanText decodes the entities itself; decoding first would turn an
          // abstract's escaped 'a &lt; b' into a "tag" and strip it.
          cleanText(cdata(xmlTag(body, 'summary')), 7000),
          journal ? `Journal: ${journal}` : '',
          note ? `Note: ${note}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        via: 'api',
      }),
    )
  }
  return out
}

/**
 * arXiv: one search, relevance-sorted, at most one request every 3 seconds
 * (callers queue for their slot). Every searchable word is required; if that
 * finds nothing, the words are tried once more as alternatives, still ranked
 * by relevance — one fallback, never a loop.
 *
 * @returns {Promise<Item[]>}
 */
export async function searchArxiv(
  query,
  { fetchText = netFetchText, limit = 5, signal, timeoutMs = API_TIMEOUT_MS * 2, spacingMs = ARXIV_SPACING_MS } = {},
) {
  const terms = searchTerms(query, 5)
    .map((t) => t.replace(/[^\p{L}\p{N}.+#-]/gu, ''))
    .filter(Boolean)
  if (!terms.length) return []
  const n = int(limit, 1, 20, 5)
  const ask = async (joiner) => {
    await spaced(spacingMs, signal)
    const q = terms.map((t) => `all:${t}`).join(joiner)
    const page = await call(
      'arxiv',
      () =>
        fetchText(`${ARXIV_API}?search_query=${enc(q)}&start=0&max_results=${n}&sortBy=relevance&sortOrder=descending`, {
          maxBytes: ARXIV_BYTES,
          timeoutMs,
          accept: 'application/atom+xml',
          headers: { 'user-agent': API_UA },
          signal,
        }),
      signal,
    )
    return parseArxiv(typeof page === 'string' ? page : page?.text).slice(0, n)
  }
  const all = await ask(' AND ')
  if (all.length || terms.length < 2) return all
  return ask(' OR ')
}

// ---------------------------------------------------------------------------
// Pages and search results (reddit, quora, web — or any platform read as a page)
// ---------------------------------------------------------------------------

/** What a URL on a platform most likely is, from its path alone. */
function kindOf(platform, url) {
  let path = ''
  try {
    const u = new URL(String(url))
    path = `${u.pathname}${u.search}`
  } catch {
    return 'page'
  }
  switch (platform) {
    case 'reddit':
      return /\/comments\//.test(path) ? 'thread' : 'page'
    case 'quora':
      return /\/answers?\//.test(path) ? 'answer' : /^\/(profile|topic|q|space)\//i.test(path) || path === '/' ? 'page' : 'question'
    case 'github':
      if (/^\/[^/]+\/[^/]+\/(issues|pull|discussions)\/\d+/.test(path)) return 'issue'
      return /^\/[^/]+\/[^/]+\/?$/.test(path) ? 'repo' : 'page'
    case 'stackoverflow':
      return /^\/a\/\d+/.test(path) ? 'answer' : /^\/questions\/\d+/.test(path) ? 'question' : 'page'
    case 'hackernews':
      return /^\/item\?id=\d+/.test(path) ? 'story' : 'page'
    case 'arxiv':
      return /^\/(abs|pdf)\//.test(path) ? 'paper' : 'page'
    default:
      return 'page'
  }
}

/**
 * A page that was read (or a search result's snippet, via 'search') as an
 * Item: { title, text, url, published?, author?, signals? }. `platform` is
 * trusted only if it is a known key; otherwise it comes from the URL.
 *
 * @returns {Item}
 */
export function itemFromPage(page, platform, via = 'page') {
  const url = String(page?.url ?? '')
  const key = Object.hasOwn(PLATFORM_INFO, platform) ? platform : platformOf(url)
  const kind = kindOf(key, url)
  const signals = pickSignals(page?.signals)
  const how = via === 'api' || via === 'search' ? via : 'page'
  const text = String(page?.text ?? '')
  return makeItem({
    platform: key,
    url,
    title: page?.title,
    author: page?.author,
    published: page?.published,
    kind,
    signals,
    signal: describe(signals, kind) || (how === 'search' ? 'search result' : ''),
    // A page from readArticle or a search snippet is already plain text, where a
    // '<div>' in a coding article is a word, not a tag. Only HTML is stripped.
    text: looksLikeHtml(text) ? cleanText(text) : tidy(text, 8000),
    via: how,
  })
}

// ---------------------------------------------------------------------------
// Signal: how much the platform itself vouches for an item
// ---------------------------------------------------------------------------

/** What an item with no counts at all scores: unknown, not bad. */
const NEUTRAL = 0.3

/** 0 at nothing, 1 at `full` and beyond, logarithmic between — the tenth vote matters more than the thousandth. */
const mag = (x, full) => {
  const v = Number(x)
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.min(1, Math.log10(1 + v) / Math.log10(1 + full))
}

/**
 * 0..1: what the platform's own readers think of an item — stars, votes,
 * points, an accepted answer — on a log scale per kind. It is not relevance;
 * the research agent weighs it beside relevance. Deterministic and pure.
 */
export function signalScore(item) {
  const s = item?.signals && typeof item.signals === 'object' ? item.signals : {}
  const has = ['score', 'comments', 'stars', 'forks', 'answers'].some((k) => Number.isFinite(Number(s[k])) && s[k] !== null && s[k] !== '')
  let score
  switch (item?.kind) {
    case 'repo':
      score = has ? 0.75 * mag(s.stars, 20_000) + 0.25 * mag(s.forks, 3_000) : NEUTRAL
      break
    case 'issue':
      score = has ? 0.6 * mag(s.comments, 100) + 0.4 * mag(s.score, 200) : NEUTRAL
      break
    case 'question':
      score = has || s.accepted ? 0.55 * mag(s.score, 500) + 0.2 * mag(s.answers, 15) + (s.accepted ? 0.25 : 0) : NEUTRAL
      break
    case 'answer':
      score = has || s.accepted ? 0.75 * mag(s.score, 500) + (s.accepted ? 0.25 : 0) : NEUTRAL
      break
    case 'story':
      score = has ? 0.65 * mag(s.score, 1_000) + 0.35 * mag(s.comments, 500) : NEUTRAL
      break
    case 'thread':
    case 'post':
      score = has ? 0.6 * mag(s.score, 5_000) + 0.4 * mag(s.comments, 1_000) : NEUTRAL
      break
    case 'paper':
      score = 0.5 + (s.accepted ? 0.2 : 0)
      break
    default:
      score = has ? 0.5 * mag(s.score, 1_000) + 0.5 * mag(s.comments, 500) : NEUTRAL
  }
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100
}
