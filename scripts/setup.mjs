#!/usr/bin/env node
// AYRA preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the commands that start AYRA.
// Every check degrades to a single friendly line if something is not there,
// and the script always exits 0 — it is advice, not a gate.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const tick = '  ok  ';
const warn = ' note ';
const info = '  ·   ';
const isWindows = process.platform === 'win32';

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

// --- Identity --------------------------------------------------------------
let identity = { name: 'Gnosis', honorific: '', language: 'en-IN', wake: { names: ['gnosis'] } };
try {
  identity = JSON.parse(readFileSync('config/identity.json', 'utf8'));
} catch (err) {
  console.log(`[${warn}] config/identity.json could not be read (${err.message}) — using defaults.`);
}

console.log('');
console.log(`${identity.name} preflight — checking your machine (nothing is changed)`);
console.log('------------------------------------------------------------');

line(tick, `Identity: ${identity.name} · wake "hey ${identity.name.toLowerCase()}" · ` +
  `honorific ${identity.honorific ? `"${identity.honorific}"` : '(none)'} · language ${identity.language}`);

// --- Node version --------------------------------------------------------
try {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= 20) {
    line(tick, `Node.js ${process.versions.node} (20+ required).`);
  } else {
    line(warn, `Node.js ${process.versions.node} is below 20. Please upgrade — the bridge needs Node 20 or newer.`);
  }
  if (typeof process.loadEnvFile !== 'function') {
    line(warn, 'This Node cannot load .env.local by itself (needs 20.12+). Set AYRA_* variables in the shell instead.');
  }
} catch {
  line(warn, `Could not read the Node.js version. ${identity.name} needs Node 20 or newer.`);
}

// --- Dependencies and the bundled Claude Code binary ------------------------
const sdkPlatform = `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
if (!existsSync('node_modules')) {
  line(warn, 'Dependencies are not installed yet. Run: npm install');
} else if (existsSync(sdkPlatform)) {
  line(tick, `Claude Agent SDK installed, with its bundled Claude Code for ${process.platform}-${process.arch}.`);
} else {
  line(warn, `The Agent SDK's binary for ${process.platform}-${process.arch} is missing. Run: npm install`);
}

// --- Claude login ----------------------------------------------------------
// The bridge reuses Claude Code's own login, so what matters is that one
// exists — not that the `claude` command is on PATH (the SDK brings its own).
const credentials = join(homedir(), '.claude', '.credentials.json');
let loggedIn = existsSync(credentials) || Boolean(process.env.ANTHROPIC_API_KEY);
if (!loggedIn) {
  // macOS keeps the login in the Keychain, so a working CLI is the best signal.
  try {
    const res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000, shell: isWindows });
    loggedIn = res.status === 0;
  } catch {
    // ignore — handled below
  }
}
if (loggedIn) {
  line(tick, 'Claude Code login found — the bridge will use it (no API key needed).');
} else {
  line(warn, 'No Claude Code login found.');
  line(info, 'Install Claude Code (https://docs.claude.com/en/docs/claude-code), run `claude` once and log in,');
  line(info, '  or sign in through the Claude desktop app. The bridge reuses that login.');
}

// --- ~/.claude.json and MCP servers --------------------------------------
const claudeJsonPath = join(homedir(), '.claude.json');
let parsed = null;
try {
  parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
} catch {
  parsed = null;
}
if (parsed) {
  const home = parsed.projects?.[homedir()] ?? parsed.projects?.[homedir().replace(/\\/g, '/')];
  const servers = { ...(parsed.mcpServers ?? {}), ...(home?.mcpServers ?? {}) };
  const count = Object.keys(servers).length;
  // AYRA does not use them yet: the clean interface is web search only.
  line(info, `~/.claude.json lists ${count} MCP server${count === 1 ? '' : 's'}; ${identity.name} does not use them yet (web search only).`);
} else {
  line(info, `~/.claude.json not found yet. It appears once you log in to Claude Code.`);
}

// --- ElevenLabs key (env, .env.local, or the elevenlabs MCP entry) ----------
function findElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim()) {
    return 'environment (ELEVENLABS_API_KEY)';
  }
  try {
    if (/^\s*ELEVENLABS_API_KEY\s*=\s*\S+/m.test(readFileSync('.env.local', 'utf8'))) {
      return '.env.local';
    }
  } catch {
    // no .env.local — fine
  }
  const key = parsed?.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY;
  if (key && String(key).trim()) return 'the elevenlabs MCP server in ~/.claude.json';
  return null;
}

const elSource = findElevenLabsKey();
if (elSource) {
  line(tick, `Premium voice available — ElevenLabs key found via ${elSource}.`);
} else {
  line(info, `No ElevenLabs key — ${identity.name} uses the browser's own speech (that is completely fine).`);
  line(info, '  Optional: add ELEVENLABS_API_KEY to .env.local for a better voice and Scribe transcription.');
}

// --- How to run ----------------------------------------------------------
console.log('');
console.log(`To run ${identity.name}:`);
console.log('  npm start             # brain + face together; open http://localhost:5173 in Chrome or Edge');
console.log('  npm run smoke         # with the bridge running: one end-to-end test turn');
console.log('');
console.log(`Then click INITIALISE and press Space to talk — or W for hands-free, then just say "${identity.name}".`);
console.log(`${identity.name} can search the web and read pages; nothing on the laptop yet.`);
console.log('');

process.exit(0);
