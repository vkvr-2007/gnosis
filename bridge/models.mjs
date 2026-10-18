/**
 * Which model a conversation thinks with.
 *
 * config/models.json names roles (planner, research, local) and the providers
 * behind them: NVIDIA's API for Nemotron Super, Nebius Token Factory as the
 * switch for the final demo, and the on-device Nemotron Nano (llama.cpp) for
 * private work. The bridge still passes the model names it used under Claude
 * (AYRA_MODEL, AYRA_RESEARCH_MODEL); anything that isn't a role here or a
 * provider's own model id ("vendor/model") gets the default role.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MODELS_FILE = fileURLToPath(new URL('../config/models.json', import.meta.url))

let cached = null
export function loadModels(file = MODELS_FILE) {
  if (file === MODELS_FILE && cached) return cached
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  if (file === MODELS_FILE) cached = cfg
  return cfg
}

/**
 * The route for a model name: { role, provider, baseUrl, apiKey, model, extraBody, temperature, onDevice }.
 * @param {string | undefined} name — a role ("planner"), a model id ("nvidia/…"), or a leftover Claude name
 */
export function modelFor(name, cfg = loadModels(), environ = process.env) {
  const override = environ.GNOSIS_ROLE
  let role = cfg.roles[name] ? name : null
  let spec
  if (role) spec = cfg.roles[role]
  else if (typeof name === 'string' && name.includes('/')) spec = { ...cfg.roles[cfg.default], model: name }
  else {
    role = override && cfg.roles[override] ? override : cfg.default
    spec = cfg.roles[role]
  }
  const provider = cfg.providers[spec.provider]
  if (!provider) throw new Error(`config/models.json: no provider "${spec.provider}"`)
  return {
    role: role ?? cfg.default,
    provider: spec.provider,
    baseUrl: provider.baseUrl,
    apiKey: provider.keyEnv ? environ[provider.keyEnv] : undefined,
    model: spec.model,
    extraBody: spec.extraBody,
    temperature: spec.temperature,
    onDevice: Boolean(provider.onDevice),
  }
}
