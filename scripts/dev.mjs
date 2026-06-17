import { spawn } from 'child_process'
import { platform } from 'os'

const isWin = platform() === 'win32'
const shell = isWin ? true : undefined

const server = spawn('node', ['server.js', '--dev'], { stdio: 'inherit', shell })
const vite = spawn(isWin ? 'npx.cmd' : './node_modules/.bin/vite', [], { stdio: 'inherit', shell })

function kill() { server.kill(); vite.kill(); process.exit() }
process.on('SIGINT', kill)
process.on('SIGTERM', kill)
server.on('exit', (code) => { if (code !== 0) { vite.kill(); process.exit(code ?? 1) } })
vite.on('exit', (code) => { if (code !== 0) { server.kill(); process.exit(code ?? 1) } })
