/**
 * dsh-session-delete - host half.
 *
 * Two ways to delete one persisted Session:
 *   1. immediately, when it is NOT live  -> POST /dsh-session-delete/delete
 *   2. after the next app start, for a live Session -> POST /dsh-session-delete/queue
 *      writes <DSH_HOME>/.session-delete-queue.json; this plugin drains that
 *      queue during activation, before any browser session is opened, and records
 *      a summary in <DSH_HOME>/.session-delete-last-drain.json.
 *
 * The browser reads that summary once at boot (GET /dsh-session-delete/last-drain,
 * which also reports whether a drain is still running) and acknowledges it with
 * POST, deleting the file so it shows exactly once.
 *
 * Files removed per Session:
 *   <DSH_HOME>/sessions/<project>/session-<id>/              (the append-only log)
 *   <DSH_HOME>/storages/session_projcache/sessions/<id>.json (the replay cache)
 *
 * Windows: the files go to the Recycle Bin (Microsoft.VisualBasic.FileIO); when
 * that helper fails they fall back to <DSH_HOME>/.session-trash/<stamp>/.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE_DELETE = '/dsh-session-delete/delete'
const ROUTE_QUEUE = '/dsh-session-delete/queue'
const ROUTE_LAST_DRAIN = '/dsh-session-delete/last-drain'
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh')
}

function queueFile() {
  return path.join(dshHome(), '.session-delete-queue.json')
}

function drainMarker() {
  return path.join(dshHome(), '.session-delete-drain-in-progress')
}

function lastReport() {
  return path.join(dshHome(), '.session-delete-last-drain.json')
}

function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function sizeOf(target) {
  try {
    const st = await fs.stat(target)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name)
      total += entry.isDirectory() ? await sizeOf(child) : (await fs.stat(child)).size
    }
    return total
  } catch {
    return 0
  }
}

function sendToRecycleBin(target) {
  if (process.platform !== 'win32') return Promise.resolve(false)
  const escaped = target.replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    "$p = '" + escaped + "'",
    'if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin") } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin") }',
  ].join('; ')
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

async function moveToTrash(target, stamp) {
  const dir = path.join(dshHome(), '.session-trash', stamp)
  await fs.mkdir(dir, { recursive: true })
  const dest = path.join(dir, path.basename(target))
  await fs.rename(target, dest)
  return dest
}

async function locateLogDir(sessionId) {
  const root = path.join(dshHome(), 'sessions')
  let projects
  try {
    projects = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = path.join(root, project.name, sessionId)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Remove one Session's files. Never creates anything when both paths are gone. */
async function removeOne(sessionId) {
  const logDir = await locateLogDir(sessionId)
  const cacheFile = path.join(dshHome(), 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  const cacheExists = existsSync(cacheFile)
  const result = { sessionId, bytes: 0, recycled: true, removed: [], errors: [], missing: !logDir && !cacheExists }
  if (result.missing) return result

  result.bytes = (logDir ? await sizeOf(logDir) : 0) + (cacheExists ? (await fs.stat(cacheFile)).size : 0)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const target of [logDir, cacheFile].filter(Boolean)) {
    if (!existsSync(target)) continue
    const viaBin = await sendToRecycleBin(target)
    if (viaBin && !existsSync(target)) {
      result.removed.push(target)
      continue
    }
    result.recycled = false
    try {
      result.removed.push(await moveToTrash(target, stamp))
    } catch (err) {
      result.errors.push(path.basename(target) + ': ' + String((err && err.message) || err))
    }
  }
  return result
}

/** True only when the Session service really reports a live Session for this id. */
function isLive(ctx, sessionId) {
  let sessions = null
  try {
    sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
  } catch {
    return false
  }
  if (!sessions || typeof sessions.get !== 'function') return false
  try {
    const session = sessions.get(sessionId)
    if (!session || typeof session !== 'object') return false
    return session.id === sessionId || session.sessionId === sessionId
  } catch {
    return false
  }
}

async function readQueue() {
  try {
    const raw = await fs.readFile(queueFile(), 'utf8')
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.filter((entry) => entry && typeof entry.id === 'string' && SESSION_ID.test(entry.id))
  } catch {
    return []
  }
}

async function writeQueue(list) {
  await fs.writeFile(queueFile(), JSON.stringify(list, null, 2), 'utf8')
}

/**
 * Activation-time drain: every queued Session is removed before the browser asks
 * the host to open anything, so a queued Session is cold by construction. A
 * summary is left behind for the browser half's boot notice.
 */
async function drainQueue(ctx) {
  const list = await readQueue()
  if (list.length === 0) return
  const deleted = []
  const kept = []
  try {
    await fs.writeFile(drainMarker(), String(Date.now()), 'utf8')
  } catch { /* marker is advisory */ }
  try {
    for (const entry of list) {
      try {
        const result = await removeOne(entry.id)
        if (result.missing) {
          deleted.push({ id: entry.id, title: entry.title || '', bytes: 0, recycled: false, missing: true })
          continue
        }
        if (result.removed.length === 0) {
          kept.push(entry)
          try { ctx.logger.warn('session-delete: queued removal failed, kept for the next start: ' + entry.id + ' ' + result.errors.join('; ')) } catch { /* ignore */ }
          continue
        }
        deleted.push({ id: entry.id, title: entry.title || '', bytes: result.bytes, recycled: result.recycled })
        try { ctx.logger.info('session-delete: queued removal ' + entry.id + ' (' + result.bytes + ' bytes, recycled=' + result.recycled + ')') } catch { /* ignore */ }
      } catch (err) {
        kept.push(entry)
        try { ctx.logger.warn('session-delete: queued removal threw for ' + entry.id + ': ' + String((err && err.message) || err)) } catch { /* ignore */ }
      }
    }
    try {
      await writeQueue(kept)
    } catch (err) {
      try { ctx.logger.warn('session-delete: could not rewrite the queue: ' + String((err && err.message) || err)) } catch { /* ignore */ }
    }
    if (deleted.length > 0 || kept.length > 0) {
      try {
        const report = {
          at: new Date().toISOString(),
          deleted,
          kept: kept.map((entry) => ({ id: entry.id, title: entry.title || '' })),
        }
        await fs.writeFile(lastReport(), JSON.stringify(report, null, 2), 'utf8')
      } catch (err) {
        try { ctx.logger.warn('session-delete: could not write the drain report: ' + String((err && err.message) || err)) } catch { /* ignore */ }
      }
    }
  } finally {
    try { await fs.unlink(drainMarker()) } catch { /* ignore */ }
  }
}

function queueEntry(list, sessionId, title) {
  const existing = list.filter((entry) => entry.id !== sessionId)
  existing.push({ id: sessionId, title: typeof title === 'string' ? title.slice(0, 200) : '', at: new Date().toISOString() })
  return existing
}

/** Reject forged Host/Origin or unauthenticated callers. Returns true when handled. */
function rejected(ctx, req, res) {
  let connection = null
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
  } catch { /* service absent */ }
  if (!connection || typeof connection.requestRejection !== 'function') return false
  let reason
  try {
    reason = connection.requestRejection(req)
  } catch (err) {
    reason = 'trust fence failed: ' + String((err && err.message) || err)
  }
  if (!reason) return false
  send(res, 403, { ok: false, code: 'untrusted', error: String(reason) })
  return true
}

async function handleDelete(ctx, req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method', error: 'method not allowed' })
  if (rejected(ctx, req, res)) return

  let body
  try {
    body = await readJson(req)
  } catch (err) {
    return send(res, 400, { ok: false, code: 'bad-body', error: String((err && err.message) || err) })
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!SESSION_ID.test(sessionId)) return send(res, 400, { ok: false, code: 'bad-id', error: 'invalid session id' })

  if (isLive(ctx, sessionId)) {
    return send(res, 409, {
      ok: false,
      code: 'live',
      error: 'session is live in this app instance; queue it for removal on the next start, or restart DSH and delete it without opening it',
    })
  }

  const result = await removeOne(sessionId)
  if (result.missing) return send(res, 404, { ok: false, code: 'missing', error: 'no stored session with that id' })
  if (result.removed.length === 0) {
    return send(res, 500, { ok: false, code: 'failed', error: result.errors.join('; ') || 'nothing could be removed' })
  }
  try { ctx.logger.info('session-delete: removed ' + sessionId + ' (' + result.bytes + ' bytes, recycled=' + result.recycled + ')') } catch { /* ignore */ }
  return send(res, 200, { ok: true, code: 'deleted', sessionId, bytes: result.bytes, recycled: result.recycled, removed: result.removed, errors: result.errors })
}

async function handleQueue(ctx, req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method', error: 'method not allowed' })
  if (rejected(ctx, req, res)) return

  let body
  try {
    body = await readJson(req)
  } catch (err) {
    return send(res, 400, { ok: false, code: 'bad-body', error: String((err && err.message) || err) })
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!SESSION_ID.test(sessionId)) return send(res, 400, { ok: false, code: 'bad-id', error: 'invalid session id' })

  const list = queueEntry(await readQueue(), sessionId, body.title)
  await writeQueue(list)
  try { ctx.logger.info('session-delete: queued ' + sessionId + ' for removal on the next start') } catch { /* ignore */ }
  return send(res, 200, { ok: true, code: 'queued', sessionId, queued: list.length })
}

/** GET returns the last drain summary; POST acknowledges (and clears) it. */
async function handleLastDrain(ctx, req, res) {
  if (req.method === 'POST') {
    try { await fs.unlink(lastReport()) } catch { /* already gone */ }
    return send(res, 200, { ok: true })
  }
  if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'method', error: 'method not allowed' })
  let report = null
  try {
    report = JSON.parse(await fs.readFile(lastReport(), 'utf8'))
  } catch { /* no report */ }
  return send(res, 200, { ok: true, pending: existsSync(drainMarker()), report })
}

export default {
  name: 'dsh-session-delete',
  apply(root) {
    // Drain first: the queue exists for Sessions that were live when queued.
    root.effect(() => {
      let cancelled = false
      drainQueue(root).catch((err) => {
        try { root.logger.warn('session-delete: boot drain failed: ' + String((err && err.message) || err)) } catch { /* ignore */ }
      }).finally(() => { if (cancelled) { /* nothing to undo */ } })
      return () => { cancelled = true }
    }, 'dsh-session-delete: drain queued removals')

    root.inject(['webServer'], (ctx) => {
      const routes = [
        [ROUTE_DELETE, (req, res) => handleDelete(ctx, req, res)],
        [ROUTE_QUEUE, (req, res) => handleQueue(ctx, req, res)],
        [ROUTE_LAST_DRAIN, (req, res) => handleLastDrain(ctx, req, res)],
      ]
      for (const [routePath, handler] of routes) {
        ctx.effect(() => {
          const dispose = ctx.webServer.register({
            kind: 'exact',
            path: routePath,
            handler: (req, res) => {
              handler(req, res).catch((err) => {
                send(res, 500, { ok: false, code: 'failed', error: String((err && err.message) || err) })
              })
            },
          })
          return typeof dispose === 'function' ? dispose : () => { try { dispose && dispose.dispose && dispose.dispose() } catch { /* ignore */ } }
        }, 'dsh-session-delete: route ' + routePath)
      }
    })
  },
}
