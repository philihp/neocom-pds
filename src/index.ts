import 'dotenv/config'
import * as fs from 'node:fs'
import * as https from 'node:https'
import { once } from 'node:events'
import { PDS, envToCfg, envToSecrets, readEnv } from '@atproto/pds'
import { loadConfig } from './config.js'
import { openCharacterStore } from './character-store.js'
import { openTokenStore } from './token-store.js'
import { openUserStore } from './user-store.js'
import { createStateStore } from './state-store.js'
import { buildEveRouter, buildBlockerRouter } from './routes.js'

const main = async (): Promise<void> => {
  const appCfg = loadConfig()
  // Sync resolved port into PDS_PORT so @atproto/pds binds to the same port
  process.env.PDS_PORT = String(appCfg.port)

  const dataDir = process.env.PDS_DATA_DIRECTORY ?? './data'
  fs.mkdirSync(dataDir, { recursive: true })

  const pdsEnv = readEnv()
  const pdsCfg = envToCfg(pdsEnv)
  const pdsSecrets = envToSecrets(pdsEnv)

  const pds = await PDS.create(pdsCfg, pdsSecrets)
  const characters = openCharacterStore(dataDir)
  const tokens = openTokenStore(dataDir, appCfg.tokenEncryptionKey)
  const users = openUserStore(dataDir)
  const stateStore = createStateStore()

  const pdsUrl = `http://127.0.0.1:${appCfg.port}`
  const adminPassword = process.env.PDS_ADMIN_PASSWORD
  if (!adminPassword) throw new Error('PDS_ADMIN_PASSWORD required')

  pds.app.use(buildBlockerRouter())
  pds.app.use(
    buildEveRouter({
      config: appCfg,
      stateStore,
      characters,
      tokens,
      users,
      pdsUrl,
      adminPassword,
    }),
  )

  // Our routers were appended after the PDS's own routes (registered in PDS.create()).
  // Insert them at index 2 — after Express's built-in query (0) and init (1) layers.
  // init is what calls setPrototypeOf(res, app.response), giving res its .status()/.json()
  // methods. Inserting before it leaves res as a raw http.ServerResponse.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (pds.app as any)._router.stack as any[]
  const eveLayer = stack.pop()
  const blockerLayer = stack.pop()
  stack.splice(2, 0, eveLayer, blockerLayer)

  await pds.start()
  console.log(`EVE-gated PDS listening on :${appCfg.port}`)

  const certPath = process.env.PDS_TLS_CERT_PATH
  const keyPath = process.env.PDS_TLS_KEY_PATH
  const httpsPort = Number(process.env.PDS_HTTPS_PORT ?? 2584)
  if (certPath && keyPath) {
    const tlsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    }
    const httpsServer = https.createServer(tlsOptions, pds.app)
    httpsServer.listen(httpsPort)
    await once(httpsServer, 'listening')
    console.log(`  HTTPS server listening on :${httpsPort}`)
    console.log(`  Start SSO flow at: https://${appCfg.hostname}:${httpsPort}/eve/login`)
  } else {
    console.log(`  Start SSO flow at: http://${appCfg.hostname}:${appCfg.port}/eve/login`)
  }
  console.log(`  Demo ESI endpoint: GET /eve/me/ship (with atproto bearer)`)

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...')
    characters.close()
    tokens.close()
    users.close()
    await pds.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
