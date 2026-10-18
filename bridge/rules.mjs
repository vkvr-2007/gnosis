/**
 * The `ayra_rules` tool server — what AYRA may do without asking.
 *
 * She can read the owner's standing allowances (allowances.mjs) and take one
 * back when they say so. There is deliberately no tool to add one: only the
 * owner's own button does that, so nothing she reads can grant her more.
 */

import { createSdkMcpServer, tool } from './sdk.mjs'
import { z } from 'zod'
import { describe } from './allowances.mjs'

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/** The list as the owner reads it. */
export function formatRules(list) {
  const always =
    'Always asks first: spending money, deleting for good, passwords and security settings. ' +
    'Sending or posting asks too, except where allowed below.'
  if (!list.length) return `${always}\n\nNothing is allowed ahead of time yet.`
  return `${always}\n\nAllowed ahead of time:\n${list.map((a, i) => `${i + 1}. ${describe(a)}`).join('\n')}`
}

/** The tools, for rulesServer — and for tests. */
export function rulesTools({ allowances }) {
  return [
    tool('rules_list', 'What you may do without asking the owner first, and what always asks.', {}, async () =>
      text(formatRules(allowances.list())),
    ),
    tool(
      'rules_forget',
      'Take back something the owner allowed ahead of time, when they ask — by its number from rules_list or by its place ("linkedin.com"). You can never add one.',
      { which: z.union([z.number().int(), z.string()]) },
      async ({ which }) => {
        const gone = allowances.remove(which)
        return text(gone ? `Taken back: ${describe(gone)}. That asks first again.` : `Nothing allowed matches "${which}".`)
      },
    ),
  ]
}

export const rulesServer = (options) =>
  createSdkMcpServer({
    name: 'ayra_rules',
    version: '1.0.0',
    instructions: 'What Gnosis may do without asking. List and take back only; adding is the owner’s button.',
    alwaysLoad: true,
    tools: rulesTools(options),
  })
