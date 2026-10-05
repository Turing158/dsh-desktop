// Resolve against the actual DSH runtime, including custom npm prefixes and the
// app's private installation. Never vendor a second backend or edit its files.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
export const runtimeRequire = createRequire(process.env.DSH_DESKTOP_DSH_BIN || process.argv[1])
export const runtimeImport = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
