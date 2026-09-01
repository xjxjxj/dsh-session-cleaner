// dsh-session-cleaner —— dsh 会话清理插件（服务端）
// 功能：删除当前会话 / 删除单个会话 / 清空所有会话（保留工作区），删除前可选备份
// 删除核心逻辑复用 dsh-plugin-session-delete（MIT）的完整流程：
//   停运行中的 agent -> flush 会话 -> 内存 detach -> 删磁盘日志 -> 清 projection 缓存 -> 清 workspace 记账
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-session-cleaner'
export const inject = ['tools']

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class CleanerError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// ---------- path helpers ----------
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}
function backupRoot() {
  return path.join(dshHome(), 'backup-archive')
}
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) {
    variants.add(sessionId.slice('session-'.length))
  } else if (SESSION_ID_RE.test(sessionId)) {
    variants.add(`session-${sessionId}`)
  }
  return [...variants]
}
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  const variants = sessionIdVariants(sessionId)
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const found = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, e.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* keep scanning */ }
    }
  }
  return found
}
function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  return dirs.length > 0
}

// ---------- storage domain cleanup ----------
async function stripStorageDomains(ctx, sessionId, { workspace = true } = {}) {
  const sd = ctx.get('storageDomain')
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false
  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projRemoved = true
        }
      }
    } catch { /* unit closed or table absent */ }
  }
  if (workspace) {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const workspaces = ws.table('workspaces')
        for (const [wid, rec] of workspaces.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
            await workspaces.put(wid, {
              ...rec,
              sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)),
            })
            workspaceRemoved = true
          }
        }
      } catch { /* unit closed or table absent */ }
      try {
        const g = ws.global
        if (g && typeof g.get === 'function' && typeof g.set === 'function') {
          const state = g.get()
          if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
            await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
            workspaceRemoved = true
          }
        }
      } catch { /* no global slot or unit closed */ }
    }
  }
  return { projRemoved, workspaceRemoved }
}

// ---------- live session handling ----------
async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  if (typeof agent.cancel === 'function') {
    try { agent.cancel({ kind: 'user' }) } catch { /* already settling */ }
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([agent.whenIdle(), new Promise((resolve) => setTimeout(resolve, 15000))])
    } catch { /* proceed anyway */ }
  }
  return true
}
async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  let flushed = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    if (typeof sessions.flush === 'function') {
      try { await sessions.flush(session); flushed = true } catch { /* ignore */ }
    }
  }
  return flushed
}
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of sessionIdVariants(sessionId)) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        detached = true
      }
    }
  } catch { /* ignore */ }
  return detached
}

// ---------- core delete ----------
async function deleteSessionCore(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new CleanerError(`invalid session id: ${sessionId}`, 400)
  }
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)
  const firstDirRemoved = removeSessionDirs(sessionId)
  const projStorage = await stripStorageDomains(ctx, sessionId, { workspace: false })
  const secondDirRemoved = removeSessionDirs(sessionId)
  await new Promise((resolve) => setImmediate(resolve))
  const thirdDirRemoved = removeSessionDirs(sessionId)
  const remainingDirs = findSessionDirs(sessionId)
  if (remainingDirs.length > 0) {
    throw new CleanerError(`session files could not be fully removed: ${remainingDirs.join(', ')}`, 500)
  }
  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const dirRemoved = firstDirRemoved || secondDirRemoved || thirdDirRemoved
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved
  if (!dirRemoved && !projRemoved && !workspaceRemoved) {
    throw new CleanerError(`session not found: ${sessionId}`, 404)
  }
  return { stopped, detached, dirRemoved, projRemoved, workspaceRemoved }
}

// ---------- backup ----------
function backupSessions() {
  const src = sessionsRoot()
  if (!fs.existsSync(src)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(backupRoot(), `sessions_backup_${stamp}`)
  fs.cpSync(src, dest, { recursive: true })
  return dest
}

// ---------- session list ----------
async function listSessions(ctx) {
  const agents = ctx.get('agents')
  const sd = ctx.get('storageDomain')
  const out = []
  if (!sd) return out
  const proj = sd.get('session_projcache')
  if (!proj || typeof proj.table !== 'function') return out
  try {
    const sessions = proj.table('sessions')
    for (const [id, rec] of sessions.entries()) {
      if (!rec || typeof rec !== 'object') continue
      const rows = rec.rows && typeof rec.rows === 'object' ? rec.rows : {}
      const titleRow = rows.title && rows.title.val
      const identity = rec.identity && typeof rec.identity === 'object' ? rec.identity : {}
      out.push({
        sessionId: id,
        title: typeof titleRow === 'string' ? titleRow : null,
        createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : null,
        running: !!(agents && typeof agents.get === 'function' && agents.get(id)),
      })
    }
  } catch { /* unit closed or table absent */ }
  return out
}

// ---------- clear all (keep workspace records) ----------
async function clearAllSessions(ctx) {
  const list = await listSessions(ctx)
  const results = []
  for (const s of list) {
    try {
      const r = await deleteSessionCore(ctx, s.sessionId)
      results.push({ sessionId: s.sessionId, title: s.title, ok: true, ...r })
    } catch (e) {
      results.push({ sessionId: s.sessionId, title: s.title, ok: false, error: e.message })
    }
  }
  return { total: list.length, results }
}

// ---------- http helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => { data += d; if (data.length > 1e6) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
function withConnectionAuth(connection, handler) {
  if (typeof connection?.requestRejection !== 'function') return handler
  return async (request, response) => {
    const rejection = connection.requestRejection(request)
    if (rejection !== undefined) {
      response.writeHead(rejection)
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    await handler(request, response)
  }
}

// ---------- plugin ----------
function registerHttp(host, targetCtx, appCtx) {
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: '/__session-cleaner/list',
    handler: withConnectionAuth(host.connection, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try { sendJson(res, 200, { ok: true, sessions: await listSessions(appCtx) }) }
      catch (e) { sendJson(res, 500, { error: e.message }) }
    }),
  }))
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: '/__session-cleaner/delete',
    handler: withConnectionAuth(host.connection, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req); if (b) args = JSON.parse(b) } catch { return sendJson(res, 400, { error: 'bad json' }) }
      const sessionId = String(args.sessionId || '').trim()
      if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' })
      let backupPath = null
      if (args.backup) {
        try { backupPath = backupSessions() } catch (e) { return sendJson(res, 500, { error: 'backup failed: ' + e.message }) }
      }
      try {
        const result = await deleteSessionCore(appCtx, sessionId)
        sendJson(res, 200, { ok: true, removed: [sessionId], backupPath, ...result })
      } catch (e) {
        const status = e instanceof CleanerError && e.status ? e.status : 500
        sendJson(res, status, { error: e.message })
      }
    }),
  }))
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: '/__session-cleaner/delete-current',
    handler: withConnectionAuth(host.connection, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req); if (b) args = JSON.parse(b) } catch { return sendJson(res, 400, { error: 'bad json' }) }
      const sessionId = String(args.sessionId || '').trim()
      if (!sessionId) return sendJson(res, 400, { error: 'sessionId required (前端需传当前会话)' })
      let backupPath = null
      if (args.backup) {
        try { backupPath = backupSessions() } catch (e) { return sendJson(res, 500, { error: 'backup failed: ' + e.message }) }
      }
      try {
        const result = await deleteSessionCore(appCtx, sessionId)
        sendJson(res, 200, { ok: true, removed: [sessionId], backupPath, ...result })
      } catch (e) {
        const status = e instanceof CleanerError && e.status ? e.status : 500
        sendJson(res, status, { error: e.message })
      }
    }),
  }))
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: '/__session-cleaner/clear-all',
    handler: withConnectionAuth(host.connection, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req); if (b) args = JSON.parse(b) } catch { return sendJson(res, 400, { error: 'bad json' }) }
      let backupPath = null
      if (args.backup !== false) {
        try { backupPath = backupSessions() } catch (e) { return sendJson(res, 500, { error: 'backup failed: ' + e.message }) }
      }
      try {
        const result = await clearAllSessions(appCtx)
        sendJson(res, 200, { ok: true, backupPath, ...result })
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    }),
  }))
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: '/__session-cleaner/backup',
    handler: withConnectionAuth(host.connection, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const dest = backupSessions()
        sendJson(res, 200, { ok: true, backupPath: dest })
      } catch (e) { sendJson(res, 500, { error: e.message }) }
    }),
  }))
}

export function apply(ctx) {
  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttp(ws, ctx, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => {
      registerHttp(sub.webServer, sub, ctx)
    })
  }

  ctx.tools.register(defineTool({
    name: 'session_cleaner_list',
    description: 'List all sessions of this dsh workbench (sessionId, title, running).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
    async execute() {
      const list = await listSessions(ctx)
      return JSON.stringify({ total: list.length, sessions: list }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_cleaner_delete',
    description: 'Permanently delete one session by sessionId. Optionally backup first (backup=true default true).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'session id (uuid or session-<uuid>)' },
      backup: { type: 'boolean', description: 'backup sessions before delete (default true)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
    async execute(args) {
      const sessionId = String(args.sessionId || '').trim()
      let backupPath = null
      if (args.backup !== false) {
        try { backupPath = backupSessions() } catch (e) { return `backup failed: ${e.message}` }
      }
      try {
        const r = await deleteSessionCore(ctx, sessionId)
        return `deleted: ${sessionId}\nbackup: ${backupPath || 'none'}\n${JSON.stringify(r)}`
      } catch (e) {
        return `delete failed: ${e.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_cleaner_clear_all',
    description: 'Delete ALL sessions of this workbench (workspace folders are kept). Optionally backup first (backup=true default true).',
    parameters: {
      backup: { type: 'boolean', description: 'backup sessions before delete (default true)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
    async execute(args) {
      let backupPath = null
      if (args.backup !== false) {
        try { backupPath = backupSessions() } catch (e) { return `backup failed: ${e.message}` }
      }
      const r = await clearAllSessions(ctx)
      return `backup: ${backupPath || 'none'}\ntotal: ${r.total}\n${JSON.stringify(r.results, null, 2)}`
    },
  }))
}
