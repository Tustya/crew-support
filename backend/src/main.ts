import { readConfig } from './config.ts'
import { startServer } from './http/server.ts'

const config = readConfig(process.env)
const server = await startServer(config)
console.log(server.url)
