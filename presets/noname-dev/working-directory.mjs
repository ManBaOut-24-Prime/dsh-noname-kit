/** Use the host's current directory when available; older hosts keep it in the session header. */
function serviceOf(ctx) {
  const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : ctx?.workingDirectory
  return service ?? undefined
}

function directoryValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('workingDirectory returned no current directory')
  return value
}

function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Working directory lookup aborted')
}

/** Synchronous lookup for tool guards. Service failures must not select an older directory. */
export function readWorkingDirectory(ctx, agent) {
  if (agent?.session === undefined) return undefined
  const service = serviceOf(ctx)
  if (service === undefined) return agent.session.header?.cwd
  if (typeof service.get !== 'function') throw new Error('workingDirectory.get is unavailable')
  return directoryValue(service.get(agent.session))
}

/** Resolve the same validated directory used by native tools, retaining the old-host fallback. */
export async function ensureWorkingDirectory(ctx, agent, signal) {
  checkSignal(signal)
  if (agent?.session === undefined) return undefined
  const service = serviceOf(ctx)
  if (service === undefined) return agent.session.header?.cwd
  if (typeof service.ensure !== 'function') throw new Error('workingDirectory.ensure is unavailable')
  const directory = await service.ensure(agent, signal)
  checkSignal(signal)
  return directoryValue(directory)
}
