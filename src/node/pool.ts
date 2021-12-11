import { MessageChannel } from 'worker_threads'
import { pathToFileURL } from 'url'
import Piscina from 'piscina'
import { Awaitable } from '@antfu/utils'
import { RpcMap } from 'vitest'
import { distDir } from '../constants'
import { WorkerContext, RpcPayload, VitestContext, File } from '../types'
import { transformRequest } from './transform'

export interface WorkerPool {
  runTestFiles: (files: string[], invalidates?: string[]) => Promise<void>
  close: () => Promise<void>
}

// UPSTREAM: Piscina does not expose this type
interface PiscinaOptions {
  filename?: string | null
  name?: string
  minThreads?: number
  maxThreads?: number
  idleTimeout?: number
  maxQueue?: number | 'auto'
  concurrentTasksPerWorker?: number
  useAtomics?: boolean
}

export function createWorkerPool(ctx: VitestContext) {
  const options: PiscinaOptions = {
    filename: new URL('./dist/node/worker.js', pathToFileURL(distDir)).href,
  }

  // UPSTREAM: Piscina set defaults by the key existence
  if (ctx.config.maxThreads != null)
    options.maxThreads = ctx.config.maxThreads
  if (ctx.config.minThreads != null)
    options.minThreads = ctx.config.minThreads

  const piscina = new Piscina(options)

  const runTestFiles: WorkerPool['runTestFiles'] = async(files, invalidates) => {
    await Promise.all(files.map(async(file) => {
      const channel = new MessageChannel()
      const port = channel.port2
      const workerPort = channel.port1

      port.on('message', async({ id, method, args = [] }: RpcPayload) => {
        async function send(fn: () => Awaitable<any>) {
          try {
            port.postMessage({ id, result: await fn() })
          }
          catch (e) {
            port.postMessage({ id, error: e })
          }
        }

        switch (method) {
          case 'snapshotSaved':
            return send(() => ctx.snapshot.add(args[0] as any))
          case 'fetch':
            return send(() => transformRequest(ctx.server, ...args as RpcMap['fetch'][0]))
          case 'onCollected':
            ctx.state.collectFiles(args[0] as any)
            ctx.reporter.onStart?.((args[0] as any as File[]).map(i => i.filepath))
            return
          case 'onTaskUpdate':
            ctx.state.updateTasks([args[0] as any])
            ctx.reporter.onTaskUpdate?.(args[0] as any)
            return
        }

        console.error('Unhandled message', method, args)
      })

      const data: WorkerContext = {
        port: workerPort,
        config: ctx.config,
        files: [file],
        invalidates,
      }

      await piscina.run(data, { transferList: [workerPort] })
      port.close()
      workerPort.close()
    }))
  }

  return {
    runTestFiles,
    close: () => piscina.destroy(),
  }
}