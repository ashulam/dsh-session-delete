#!/usr/bin/env node
/**
 * prune-dangling-sessionids.mjs - remove session ids that no longer have a
 * stored session from <DSH_HOME>/storages/workspace.json.
 *
 * Why offline only: the workspace registry holds this file in memory and
 * rewrites it on its own mutations, and the 2026-10-22 incident showed that
 * editing it while DSH runs (then hard-killing the app) loses state and can
 * leave the controller unavailable. So this tool refuses to run while DSH is
 * running unless --force is given, always backs the file up first, writes
 * UTF-8 without a BOM (PowerShell 5.1's `-Encoding UTF8` writes one), and
 * publishes with an atomic rename.
 *
 * Usage:
 *   node tools/prune-dangling-sessionids.mjs [--home <dir>] [--apply] [--force] [--json]
 *
 *   --home <dir>  DSH home directory (default: $DSH_HOME or ~/.dsh)
 *   --apply       write the change (default: dry run)
 *   --force       skip the "DSH is running" check
 *   --json        machine-readable output
 *
 * Exit codes: 0 success, 1 error, 3 DSH is running (needs --force).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const force = args.includes('--force')
const asJson = args.includes('--json')
const homeArg = (() => {
  const i = args.indexOf('--home')
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
})()

function dshHome() {
  const raw = homeArg || process.env.DSH_HOME
  return raw && raw.trim() ? path.resolve(raw) : path.join(os.homedir(), '.dsh')
}

function out(line) {
  if (!asJson) process.stdout.write(line + '\n')
}

function fail(message, code = 1) {
  if (asJson) process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n')
  else process.stderr.write('ERROR: ' + message + '\n')
  process.exit(code)
}

function dshRunning() {
  if (process.platform !== 'win32') return false
  try {
    const csv = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return /DeepSeek Harness\.exe/i.test(csv)
  } catch {
    return null // detection unavailable
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function writeAtomic(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, 'wx')
  try {
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

function backup(file) {
  const dir = path.join(path.dirname(file), 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `${path.basename(file)}.${stamp}.bak`)
  fs.copyFileSync(file, target)
  return target
}

function aliveSessionIds(home) {
  const alive = new Set()
  const root = path.join(home, 'sessions')
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return alive
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    let entries
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('session-')) alive.add(entry.name)
    }
  }
  return alive
}

function collectDangling(state, alive) {
  const dangling = []
  const workspaces = state?.tables?.workspaces ?? {}
  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    for (const sessionId of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
      if (!alive.has(sessionId)) dangling.push({ sessionId, workspaceId, title: workspace?.title ?? '', ref: 'workspace' })
    }
  }
  for (const sessionId of Array.isArray(state?.global?.pinnedSessionIds) ? state.global.pinnedSessionIds : []) {
    if (!alive.has(sessionId)) dangling.push({ sessionId, ref: 'pinned' })
  }
  for (const sessionId of Array.isArray(state?.global?.archivedSessionIds) ? state.global.archivedSessionIds : []) {
    if (!alive.has(sessionId)) dangling.push({ sessionId, ref: 'archived' })
  }
  return dangling
}

function prune(state, alive) {
  let removed = 0
  const workspaces = state?.tables?.workspaces ?? {}
  for (const workspace of Object.values(workspaces)) {
    if (!Array.isArray(workspace?.sessionIds)) continue
    const keep = workspace.sessionIds.filter((id) => alive.has(id))
    removed += workspace.sessionIds.length - keep.length
    workspace.sessionIds = keep
  }
  for (const key of ['pinnedSessionIds', 'archivedSessionIds']) {
    const list = state?.global?.[key]
    if (!Array.isArray(list)) continue
    const keep = list.filter((id) => alive.has(id))
    removed += list.length - keep.length
    state.global[key] = keep
  }
  return removed
}

const home = dshHome()
const file = path.join(home, 'storages', 'workspace.json')
if (!fs.existsSync(file)) fail('workspace.json not found: ' + file)

const running = dshRunning()
if (running === null) out('WARN: could not detect whether DSH is running.')
// Reading is always safe; only writing needs DSH to be closed.
if (apply && running === true && !force) fail('DSH is running. Close it completely and re-run (or pass --force if you accept the risk).', 3)
if (!apply) out('Dry run (no files written). Pass --apply to write.')

const raw = fs.readFileSync(file)
const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
let state
try {
  state = JSON.parse(stripBom(raw.toString('utf8')))
} catch (error) {
  fail('workspace.json is not valid JSON: ' + String(error && error.message))
}

const alive = aliveSessionIds(home)
const dangling = collectDangling(state, alive)
if (dangling.length === 0) {
  out(`OK: no dangling session ids (${alive.size} stored sessions).`)
  if (asJson) process.stdout.write(JSON.stringify({ ok: true, changed: false, home, alive: alive.size, dangling: [] }) + '\n')
  process.exit(0)
}

out(`Found ${dangling.length} dangling reference(s) in ${file}`)
for (const item of dangling) out(`  - ${item.sessionId}  [${item.ref}${item.title ? ': ' + item.title : ''}]`)

if (!apply) {
  out('Nothing written. Re-run with --apply to prune.')
  if (asJson) process.stdout.write(JSON.stringify({ ok: true, changed: false, home, alive: alive.size, dangling, dryRun: true }) + '\n')
  process.exit(0)
}

const backupPath = backup(file)
const removed = prune(state, alive)
writeAtomic(file, JSON.stringify(state, null, 2))

// Verify what we wrote.
const verifyRaw = fs.readFileSync(file)
const verifyBom = verifyRaw.length >= 3 && verifyRaw[0] === 0xef && verifyRaw[1] === 0xbb && verifyRaw[2] === 0xbf
let verifyState
try {
  verifyState = JSON.parse(stripBom(verifyRaw.toString('utf8')))
} catch (error) {
  fail('wrote a file that does not parse back: ' + String(error && error.message))
}
const left = collectDangling(verifyState, alive)
if (left.length > 0) fail(`still ${left.length} dangling reference(s) after write; restore ${backupPath} and report this.`)

out(`Pruned ${removed} reference(s). Backup: ${backupPath}`)
out(`Written: ${verifyRaw.length} B, BOM: ${verifyBom ? 'YES (bad)' : 'no'}`)
if (asJson) process.stdout.write(JSON.stringify({ ok: true, changed: removed > 0, home, alive: alive.size, removed, backup: backupPath, bytes: verifyRaw.length, bom: verifyBom }) + '\n')
