// Offline fallback: node scripts/recover-batch.mjs <official-game-root>
import {recoverBatch} from '../src/batch.js'
if (!process.argv[2]) { console.error('请提供官方无名杀游戏根目录'); process.exitCode=2 }
else {
  const result=recoverBatch(process.argv[2]);console.log(JSON.stringify(result,null,2))
  if (['busy','recovery_required'].includes(result.status)) process.exitCode=1
}
