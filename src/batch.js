/** Offline batch recovery uses bundled Node/platform code and no game/bridge. */
import {existsSync} from 'node:fs'
import {join} from 'node:path'
import files from '../online-kernel/lib/batch-files.cjs'
const writers=new Map()

/** Check the durable owner before any ordinary extension mutation. */
export function batchPending(root) { return existsSync(join(root, 'nnk-batches', 'active')) }

/** Pending or corrupt records block ordinary writes until recovery completes. */
export function assertBatchIdle(root) {
  if (batchPending(root)) throw new Error('补传批次尚未恢复；请先在联机页面完成离线恢复。')
}

/** Serialize batch publication against ordinary asynchronous extension writes. */
export async function withBatchWrite(root, fn) {
  assertBatchIdle(root)
  if (process.platform!=='win32' || !existsSync(root)) return fn()
  // Reentrant/nested workshop operations share a lease. Independent async calls
  // retain it until every call settles, so publication cannot overtake an await.
  let writer=writers.get(root)
  if (!writer) { writer={lease:files.acquireWriteLease(root),users:0};writers.set(root,writer) }
  writer.users++
  try { assertBatchIdle(root);return await fn() }
  finally { if (--writer.users===0) { writers.delete(root);writer.lease.release() } }
}

/** Read status without changing files or relying on an online engine. */
export function batchStatus(root) {
  if (!batchPending(root)) return {status:'none'}
  try { return files.inspect(root) }
  catch (error) { return {status:'recovery_required',error:error.message} }
}

/** Recover a dead owner's full old/new generation; never reload or close a game. */
export function recoverBatch(root) {
  try { return files.recover(root) }
  catch (error) { return {status:'recovery_required',error:error.message} }
}
