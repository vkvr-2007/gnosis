/**
 * Where Gnosis keeps what he writes: memory, reminders, skills, sessions, logs, research.
 *
 * In this code checkout that is data/ beside the code. An installed Gnosis (scripts/package.mjs)
 * keeps its program files apart and its data in the owner's profile, %LOCALAPPDATA%\Gnosis\data,
 * passed in as GNOSIS_DATA by Gnosis.exe.
 */

import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DATA_DIR = process.env.GNOSIS_DATA
  ? resolve(process.env.GNOSIS_DATA)
  : resolve(fileURLToPath(new URL('../data/', import.meta.url)))

/** A file in the data folder. */
export const dataPath = (...parts) => join(DATA_DIR, ...parts)

/** A folder in the data folder, ending in a separator (callers add file names to it). */
export const dataDir = (...parts) => join(DATA_DIR, ...parts) + sep
