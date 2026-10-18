/**
 * Web search and page reading for Gnosis's own brain.
 *
 * Under the Claude Agent SDK these were Claude Code's WebSearch and WebFetch,
 * run on Anthropic's side. Nemotron has nothing like them, so the bridge does
 * the work itself: search through DuckDuckGo's plain-HTML page (no key, and
 * measured working from the owner's laptop, 2026-10-18; Bing's page came back
 * without results), and pages fetched and turned into text here.
 *
 * Both answer in the shapes the rest of the bridge already reads
 * (sources.mjs, brain.mjs webResultEvent), so search cards and the number
 * check on show_data keep working unchanged.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
/** What one page may put in front of the model. */
export const PAGE_TEXT_MAX = 15_000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }

export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

const strip = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** DuckDuckGo wraps result links in a redirect: //duckduckgo.com/l/?uddg=<real url>. */
function realUrl(href) {
  const url = decodeEntities(href)
  const m = /[?&]uddg=([^&]+)/.exec(url)
  if (m) return decodeURIComponent(m[1])
  return url.startsWith('//') ? `https:${url}` : url
}

/** The results on a DuckDuckGo HTML results page: { title, url, snippet }[]. */
export function parseDuckDuckGo(html, limit = 8) {
  const out = []
  // Split on each result's opening tag, keeping its class (the capture) so ads can be told apart.
  const parts = String(html).split(/<div[^>]+class="([^"]*\bresult\b[^"]*)"/)
  for (let i = 1; i < parts.length; i += 2) {
    const [cls, block] = [parts[i], parts[i + 1] ?? '']
    if (/result--ad\b/.test(cls)) continue
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!link) continue
    const url = realUrl(link[1])
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    out.push({ title: strip(link[2]), url, snippet: snippet ? strip(snippet[1]) : '' })
    if (out.length >= limit) break
  }
  return out
}

/** The results on a Brave Search page: each web result is a `data-type="web"` block. */
export function parseBrave(html, limit = 8) {
  const out = []
  for (const block of String(html).split('data-type="web"').slice(1)) {
    const url = /<a href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\bl1\b/.exec(block)?.[1]
    const title = /class="title search-snippet-title[^"]*" title="([^"]*)"/.exec(block)?.[1]
    if (!url || !title) continue
    const snippet = /class="content desktop-default-regular[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? ''
    out.push({ title: decodeEntities(title), url: decodeEntities(url), snippet: strip(snippet) })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Each engine: a name and search(query) → results. Tried in order until one gives results.
 *
 * The two search APIs come first when their key is set (TAVILY_API_KEY, BRAVE_API_KEY; both have free
 * tiers). Without a key, search falls back to reading the engines' own result pages, which works but
 * not for long: on the owner's laptop both Brave (HTTP 429) and DuckDuckGo (HTTP 202 bot check) cut it
 * off after a handful of searches (2026-10-18).
 */
export const SEARCH_ENGINES = [
  { name: 'tavily', enabled: () => Boolean(process.env.TAVILY_API_KEY), search: async (query, { fetchImpl, signal }) => {
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: 8 }),
      signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return (data.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? '' }))
  } },
  { name: 'brave-api', enabled: () => Boolean(process.env.BRAVE_API_KEY), search: async (query, { fetchImpl, signal }) => {
    const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY }, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: strip(r.description ?? '') }))
  } },
  // Brave's own page: worked from the owner's laptop where DuckDuckGo started answering with a bot
  // check (HTTP 202 "anomaly") after a handful of searches (2026-10-18).
  { name: 'brave', search: async (query, { fetchImpl, signal }) => {
    const res = await fetchImpl(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
      { headers: { 'User-Agent': UA }, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseBrave(await res.text())
  } },
  { name: 'duckduckgo', search: async (query, { fetchImpl, signal }) => {
    const res = await fetchImpl('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: query }).toString(),
      signal,
    })
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`) // 202 is its bot check
    return parseDuckDuckGo(await res.text())
  } },
]

/**
 * Adds an engine after the search APIs and before the result-page readers. browser.mjs adds a Google
 * search in Gnosis's own Chrome this way (it can't be imported here: browser.mjs imports this file).
 */
export function useSearchEngine(engine) {
  if (SEARCH_ENGINES.some((e) => e.name === engine.name)) return
  const firstScraper = SEARCH_ENGINES.findIndex((e) => !e.enabled)
  SEARCH_ENGINES.splice(firstScraper < 0 ? SEARCH_ENGINES.length : firstScraper, 0, engine)
}

/**
 * A web search, as the model sees it and as the bridge reads it.
 * @returns {Promise<{ text: string, structured: { query: string, results: { content: { title: string, url: string }[] }[] } }>}
 */
export async function webSearch(query, { fetchImpl = fetch, signal, engines = SEARCH_ENGINES } = {}) {
  let results = []
  const problems = []
  for (const engine of engines) {
    if (engine.enabled && !engine.enabled()) continue
    try {
      results = await engine.search(query, { fetchImpl, signal })
      if (results.length) break
      problems.push(`${engine.name}: no results`)
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      problems.push(`${engine.name}: ${err.message}`)
    }
  }
  if (!results.length && problems.length) console.warn(`[gnosis] web search for "${query}" failed — ${problems.join('; ')}`)
  const links = results.map(({ title, url }) => ({ title, url }))
  const text = [
    `Web search results for query: "${query}"`,
    '',
    `Links: ${JSON.stringify(links)}`,
    '',
    ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`),
  ].join('\n')
  return { text: results.length ? text : `No results found for "${query}".`,
           structured: { query, results: [{ content: links }] } }
}

/** A page's readable text: scripts, styles and markup removed, blocks kept as lines. */
export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const body = String(html)
    .replace(/<(script|style|noscript|svg|head|title|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const lines = decodeEntities(body).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return (title ? `${strip(title)}\n\n` : '') + lines.join('\n')
}

/** WebFetch: the page's text, with the HTTP status and final URL. */
export async function webFetch(url, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, redirect: 'follow', signal })
  const type = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  const text = /html/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw
  return { code: res.status, url: res.url || url, text: text.slice(0, PAGE_TEXT_MAX) }
}

// ---- YouTube ------------------------------------------------------------------------------
// Ported from Gnosis v2 (play_youtube). Measured on the owner's laptop, 2026-10-18: asked to play a cat
// video, the model searched YouTube by typing and clicking and opened "Easy tab management" — the
// results page also holds ads and promoted items. Reading the page's own list of videos picks a real one.

const VIDEO = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g

export const youtubeSearchUrl = (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query).replace(/%20/g, '+')}`

/** The videos on a YouTube results page, in order: { id, title, url }. Ads and Shorts aren't videoRenderers. */
export function parseYouTubeResults(html, limit = 3) {
  const out = []
  const seen = new Set()
  for (const [, id, title] of String(html).matchAll(VIDEO)) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, title: JSON.parse(`"${title}"`), url: `https://www.youtube.com/watch?v=${id}` })
    if (out.length >= limit) break
  }
  return out
}

export async function youtubeSearch(query, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(youtubeSearchUrl(query), { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal })
  if (!res.ok) throw new Error(`YouTube search failed: HTTP ${res.status}`)
  return parseYouTubeResults(await res.text())
}
