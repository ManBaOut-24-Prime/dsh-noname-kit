/** Prepend one anchor message before the first real user message. The durable inbox preserves their order across resume. Subagents skip the anchor unless includeSubagents is enabled; the queued user message runs after tool bootstrap promotion. */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchor-turn'

/** Default anchor text shown to the model in the synthetic first user turn. */
export const ANCHOR_TEXT = 'This round is a test. Tools are not open yet; all tools will open next round.'

/** Fresh sessions (no prior user message) get the anchor turn. */
function isFreshSession(agent, includeSubagents = false) {
  if (!includeSubagents && (agent.session.header.delegationDepth ?? 0) > 0) return false
  return !agent.session.events.some((event) => event.type === 'user/message')
}

/** Register the first-message anchor injection. */
export function apply(ctx, config) {
  const text = typeof config.text === 'string' && config.text.length > 0
    ? config.text
    : ANCHOR_TEXT
  const includeSubagents = config?.includeSubagents === true

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isFreshSession(agent, includeSubagents)) return
    // Never re-anchor on plugin-sourced messages (including our own anchor).
    if (message.source?.kind === 'plugin') return
    agent.inbox.prepend('next-turn', {
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'anchor-turn',
        form: 'notice',
        summary: 'zero-tool anchor turn',
      },
    })
  })
}
