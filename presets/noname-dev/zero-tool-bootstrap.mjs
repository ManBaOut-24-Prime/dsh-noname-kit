/** Keep the first top-level request on an empty tool catalog, then expose configured resident tools and names unlocked by dev_tool_search. Promotion is reconstructed from durable session events. After compaction, expose shells and compactionTools until a new promotion signal appears. Filter configured context sources during controlled requests. Subagents start promoted unless includeSubagents is enabled; filter failures retain the full catalog. Adapted from xiaobright/dsh-anchored-standard (MIT). */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'zero-tool-bootstrap'

/** Listeners access services at event time. prepend keeps the pre-step context filter outermost. */

/** Context source kinds suppressed during controlled requests by default. */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Shell tool candidates: custom-bash registers bash; pwsh is available on Windows. */
const SHELLS = ['bash', 'pwsh']

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  // Core work set exposed after a compaction, before re-promotion.
  const compactionTools = stringListOrEmpty(config?.compactionTools, 'compactionTools')
  // noname-kit: extra tools that stay resident after promotion alongside the
  // shells / str_replace_editor / discovery set (the noname dev toolchain).
  const residentTools = stringListOrEmpty(config?.residentTools, 'residentTools')
  const suppressedSources = sourceList(config?.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)

  const promotion = createEpochPromotion(['assistant/message'], { includeSubagents: config?.includeSubagents === true })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced;
   * we parse it defensively and read the `toolNames` array.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of session.events) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
    }
    return unlocked
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // PROMOTED: keep the minimal resident set — the shells +
        // str_replace_editor + the discovery tools + whatever the model
        // explicitly unlocked via dev_tool_search — instead of dumping the
        // whole Standard catalog at once (the post-promotion regression fix).
        const available = new Set(assembled.tools.map((tool) => tool.name))
        const keep = new Set([
          ...SHELLS.filter((name) => available.has(name)),
          'str_replace_editor', ...RESIDENT_DISCOVERY_TOOLS,
          ...residentTools, ...unlockedFor(context.agent?.session),
        ])
        return {
          ...assembled,
          tools: assembled.tools.filter((tool) => keep.has(tool.name)),
        }
      }
      const { boundary } = status
      // First request (no compaction yet): zero tools, the "we" anchor.
      if (boundary < 0) return { ...assembled, tools: [] }
      // Post-compaction: core work set so mid-task work can continue.
      if (compactionTools.length === 0) return { ...assembled, tools: [] }
      const available = new Set(assembled.tools.map((tool) => tool.name))
      const selectedShells = SHELLS.filter((toolName) => available.has(toolName))
      const missing = compactionTools.filter((toolName) => !available.has(toolName))
      if (selectedShells.length === 0 || missing.length > 0) {
        warnOnce(
          `${name}: expected at least one phase shell and every phase tool; `
          + `shells=${JSON.stringify(selectedShells)}, missing=${JSON.stringify(missing)} — `
          + 'bootstrap disabled, full catalog exposed',
        )
        return assembled
      }
      const keep = new Set([...selectedShells, ...compactionTools])
      return {
        ...assembled,
        tools: assembled.tools.filter((tool) => keep.has(tool.name)),
      }
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Register the context filter with prepend so it runs as the outermost pre-step transform.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotion.status(agent).promoted || suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
