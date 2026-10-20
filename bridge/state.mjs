/**
 * AYRA's small persistent state — data/state.json.
 *
 * Things that must outlive a page reload or a bridge restart but are not
 * memory about the owner: which Claude session each channel was in, and when.
 * A flat JSON object written whole on every change. Writes go to a temporary
 * file first and are renamed into place, so a crash mid-write can never leave
 * half a file behind.
 *
 * data/ is gitignored — this never leaves the laptop.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataPath } from './paths.mjs'

export const STATE_FILE = dataPath('state.json')

/** A store over one JSON file. Tests point it at a temporary path. */
export function createStore(file = STATE_FILE) {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {} // missing or unreadable: start empty rather than crash the bridge
    }
  }

  const write = (data) => {
    mkdirSync(dirname(file), { recursive: true })
    // Per process: a test copy of the bridge writing at the same moment must
    // not rename the other's half-written file.
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    // Windows briefly locks a file another reader has open (an antivirus scan,
    // the other process reading it): try again for a moment rather than fail.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file)
        return
      } catch (err) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err
        const until = Date.now() + 20 * (attempt + 1)
        while (Date.now() < until) {
          /* a short, synchronous wait: this store is synchronous by design */
        }
      }
    }
  }

  return {
    get: (key) => read()[key],
    set(key, value) {
      const data = read()
      data[key] = value
      write(data)
    },
    delete(key) {
      const data = read()
      if (!(key in data)) return
      delete data[key]
      write(data)
    },
  }
}
