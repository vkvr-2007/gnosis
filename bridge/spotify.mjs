/**
 * A song, artist, album or playlist on Spotify, by name: ported from Gnosis v1, where "play X on
 * Spotify" only opened Spotify's search for X. Now the result is played and checked.
 *
 * Through the Spotify app's own controls (spotify.ps1, UI Automation): its search opens for the
 * query, the results it offers to play are read, the best match is chosen here (the plain track
 * over a live, remix, cover or ringtone version unless one was asked for), its play button is
 * pressed, and what Spotify's window then shows as playing is what Gnosis reports.
 * Asked live, 2026-10-18, without this, Nemotron spent three and a half minutes typing and clicking
 * in Spotify and never played anything.
 */

import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createSdkMcpServer, tool } from './sdk.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'spotify.ps1')

/** Words that make a different version of a song: only chosen when the owner said them. */
export const VARIANT = new Set(['remix', 'live', 'instrumental', 'acoustic', 'cover', 'karaoke', 'ringtone', 'slowed',
  'reverb', 'sped', 'analysis', 'backing', 'version', 'lofi', '8d', 'nightcore', 'marimba', 'piano', 'tribute', 'edit', 'mix'])

/** Words that say nothing about which result: "play the song by X on Spotify". */
const FILLER = new Set(['the', 'a', 'an', 'by', 'song', 'track', 'music', 'on', 'spotify', 'play', 'please', 'some', 'from', 'of'])

export const wordsOf = (s) => (String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .match(/[a-z0-9]+/g) ?? []).filter((w) => !FILLER.has(w))

/** Spotify's window title while nothing plays. */
export const IDLE_TITLE = /^Spotify(?: Free| Premium)?$/

/**
 * The result that best answers the query, or null: the share of its words the owner said, less a
 * point for a version they didn't ask for and plus one for a version they did; the earlier result
 * (Spotify's own ranking) wins a tie.
 * @param {{ title: string, index: number }[]} results
 */
export function pickResult(results, query) {
  const asked = new Set(wordsOf(query))
  let best = null
  for (const [pos, r] of results.entries()) {
    const words = wordsOf(r.title)
    if (!words.length) continue
    const said = words.filter((w) => asked.has(w)).length
    if (!said) continue
    const unasked = words.filter((w) => VARIANT.has(w) && !asked.has(w)).length
    const wanted = words.filter((w) => VARIANT.has(w) && asked.has(w)).length
    const score = said / words.length - unasked + wanted - pos * 0.001
    if (!best || score > best.score) best = { ...r, score }
  }
  return best && best.score > 0.3 ? best : null
}

/** Runs spotify.ps1 once and returns its JSON. */
export function runSpotify(args) {
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]
  for (const [k, v] of Object.entries(args)) argv.push(`-${k[0].toUpperCase()}${k.slice(1)}`, String(v))
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', argv, { windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        // Titles can carry control characters PowerShell 5 leaves unescaped.
        const out = JSON.parse(stdout.trim().replace(/[\u0000-\u001f]/g, ' '))
        if (out.error) reject(new Error(out.error))
        else resolve(out)
      } catch {
        reject(new Error('The Spotify helper gave no answer'))
      }
    })
  })
}

/** The music tools: spotify_play. */
export function musicServer({ run = runSpotify, log = console.log } = {}) {
  const say = (query, outcome) => log(`[gnosis] spotify "${query}": ${outcome}`)
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
  return createSdkMcpServer({
    name: 'gnosis_music',
    tools: [
      tool('spotify_play',
        'Play a song, artist, album or playlist in the Spotify app by name, and say what is really playing. ' +
          'Use it for "play X on Spotify" and for music the owner names; never search Spotify by typing and clicking.',
        { query: z.string().describe('What to play, with the artist when known, e.g. "Blinding Lights The Weeknd"') },
        async ({ query }) => {
          let found
          try {
            found = await run({ op: 'search', query })
          } catch (err) {
            say(query, `search failed: ${err?.message ?? err}`)
            return fail(`Spotify's search didn't work: ${err?.message ?? err}`)
          }
          const results = Array.isArray(found.results) ? found.results : []
          if (!results.length) return say(query, 'no results'), fail(`Spotify showed no results for "${query}".`)
          const pick = pickResult(results, query)
          if (!pick) {
            say(query, `no good match among ${results.length}`)
            return fail(`Nothing on Spotify matched "${query}" well. It offered: ${results.slice(0, 5).map((r) => r.title).join('; ')}.`)
          }
          let now
          try {
            now = await run({ op: 'play', name: pick.title, index: pick.index })
          } catch (err) {
            say(query, `play failed on "${pick.title}": ${err?.message ?? err}`)
            return fail(`Couldn't press play on "${pick.title}": ${err?.message ?? err}`)
          }
          const title = String(now.title ?? '')
          // Unchanged from before the press: the song that was already on, unless it is this one.
          const stale = title === String(now.before ?? '') && !wordsOf(pick.title).every((w) => wordsOf(title).includes(w))
          if (!title || IDLE_TITLE.test(title) || stale) {
            say(query, `pressed play on "${pick.title}", nothing new playing (window: "${title}")`)
            return fail(`Pressed play on "${pick.title}", but Spotify doesn't show it playing. Say so; don't claim it's playing.`)
          }
          say(query, `playing "${title}"`)
          // Spotify Free plays an ad now and then: its window says "Advertisement" or the advertiser.
          return text(`Spotify is playing: ${title}. (Chosen result: "${pick.title}".)`)
        }),
    ],
  })
}
