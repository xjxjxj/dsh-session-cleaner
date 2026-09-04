// dsh-session-cleaner —— dsh 会话清理插件（服务端）v0.2.0
// 功能：删除当前会话 / 删除单个会话 / 清空所有会话（保留工作区）
// 安全模型（2026-09-05 优化）：
//   1. 默认删除 = 移入回收站（backup-archive/trash/），可随时恢复，7 天后自动清理
//   2. permanent: true 才物理删除（仍可先 backup）
//   3. delete-current 必须显式传 confirm:"yes"（防前端误传 sessionId 误删）
//   4. clear-all 并发删除；全部操作写审计日志
// 删除核心流程复用 dsh-plugin-session-delete（MIT）思路：
//   停运行中的 agent -> flush 会话 -> 内存 detach -> 移动/删除磁盘目录 -> 清 projection/workspace 记账
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-session-cleaner'
export const inject = ['tools']

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 回收站保留 7 天
const CLEAR_ALL_CONCURRENCY = 3

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
function trashRoot() {
  return path.join(backupRoot(), 'trash')
}
function logFile() {
  return path.join(dshHome(), 'logs', 'session-cleaner.log')
}
function audit(action, detail) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    fs.appendFileSync(logFile(), `${new Date().toISOString()} [${action}] ${detail}\n`)
  } catch { /* logging must never break the flow */ }
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

// ---------- trash (recycle bin) ----------
// 目录布局：backup-archive/trash/<sessionId>-<ts>/<workspace>/<sessionId>/ + trash.json 清单
function listTrash() {
  const root = trashRoot()
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  const now = Date.now()
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'trash.json'), 'utf8')) } catch { /* no manifest */ }
    const m = e.name.match(/^(session-)?[0-9a-f-]+-(\d+)$/i)
    const trashedAt = meta?.trashedAt ?? (m ? Number(m[2]) : 0)
    const sessionId = meta?.sessionId ?? (m ? m[0].replace(/-\d+$/, '') : e.name)
    out.push({
      trashId: e.name,
      sessionId,
      workspace: meta?.workspace ?? '',
      trashedAt,
      ageDays: now ? Math.max(0, Math.floor((now - trashedAt) / 86400000)) : 0,
      expired: trashedAt ? (now - trashedAt) > TRASH_TTL_MS : false,
    })
    // 惰性清理过期项
    if (trashedAt && (now - trashedAt) > TRASH_TTL_MS) {
      try { fs.rmSync(dir, { recursive: true, force: true }); audit('trash-expired', e.name) } catch { /* ignore */ }
    }
  }
  return out
}
function trashSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  const moved = []
  for (const dir of dirs) {
    const workspace = path.basename(path.dirname(dir))
    const variant = path.basename(dir)
    const ts = Date.now()
    const trashDir = path.join(trashRoot(), `${variant}-${ts}`)
    const dest = path.join(trashDir, workspace, variant)
    try {
      fs.mkdirSync(path.join(trashDir, workspace), { recursive: true })
      fs.renameSync(dir, dest)
      fs.writeFileSync(path.join(trashDir, 'trash.json'), JSON.stringify({
        sessionId: variant, workspace, trashedAt: ts, originalPath: dir,
      }))
      moved.push({ trashId: path.basename(trashDir), workspace, sessionId: variant })
    } catch { /* file locked: fall back to delete attempt later */ }
  }
  return moved
}
function restoreTrash(trashId) {
  const dir = path.join(trashRoot(), trashId)
  const metaPath = path.join(dir, 'trash.json')
  let meta = null
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch { throw new CleanerError('trash entry not found: ' + trashId, 404) }
  const src = path.join(dir, meta.workspace || '', meta.sessionId || '')
  const dest = path.join(sessionsRoot(), meta.workspace || '', meta.sessionId || '')
  if (!fs.existsSync(src)) throw new CleanerError('trash content missing: ' + trashId, 404)
  if (fs.existsSync(dest)) throw new CleanerError('session already exists at destination: ' + dest, 409)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(src, dest)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* leave manifest */ }
  audit('restore', `${meta.sessionId} (workspace=${meta.workspace}, trash=${trashId})`)
  return { sessionId: meta.sessionId, workspace: meta.workspace, dest }
}
function purgeTrash(trashId) {
  const dir = path.join(trashRoot(), trashId)
  if (!fs.existsSync(dir)) throw new CleanerError('trash entry not found: ' + trashId, 404)
  fs.rmSync(dir, { recursive: true, force: true })
  audit('purge', trashId)
  return { trashId }
}
function purgeAllTrash() {
  const list = listTrash()
  let purged = 0
  for (const t of list) {
    try { fs.rmSync(path.join(trashRoot(), t.trashId), { recursive: true, force: true }); purged++ } catch { /* ignore */ }
  }
  audit('purge-all', `${purged} entries`)
  return { purged }
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
// permanent=false（默认）=> 移入回收站可恢复；permanent=true => 物理删除
async function deleteSessionCore(ctx, sessionId, { permanent = false } = {}) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new CleanerError(`invalid session id: ${sessionId}`, 400)
  }
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  let moved = []
  let dirRemoved = false
  if (permanent) {
    dirRemoved = removeSessionDirs(sessionId)
    // 等一拍再补删，处理刚 flush 的锁
    await new Promise((resolve) => setImmediate(resolve))
    if (removeSessionDirs(sessionId)) dirRemoved = true
    await new Promise((resolve) => setImmediate(resolve))
    if (removeSessionDirs(sessionId)) dirRemoved = true
  } else {
    moved = trashSessionDirs(sessionId)
    await new Promise((resolve) => setImmediate(resolve))
    moved = moved.concat(trashSessionDirs(sessionId))
  }

  const remainingDirs = findSessionDirs(sessionId)
  if (permanent && remainingDirs.length > 0) {
    throw new CleanerError(`session files could not be fully removed: ${remainingDirs.join(', ')}`, 500)
  }

  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const projStorage = await stripStorageDomains(ctx, sessionId, { workspace: false })
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved

  if (permanent) {
    if (!dirRemoved && !projRemoved && !workspaceRemoved) {
      throw new CleanerError(`session not found: ${sessionId}`, 404)
    }
  } else if (moved.length === 0 && !projRemoved && !workspaceRemoved) {
    throw new CleanerError(`session not found: ${sessionId}`, 404)
  }

  audit(permanent ? 'delete-permanent' : 'delete-to-trash',
    `${sessionId} moved=${moved.length} stopped=${stopped} detached=${detached} proj=${projRemoved} ws=${workspaceRemoved}`)
  return { stopped, detached, dirRemoved, moved, projRemoved, workspaceRemoved, permanent }
}

// ---------- backup ----------
function backupSessions() {
  const src = sessionsRoot()
  if (!fs.existsSync(src)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(backupRoot(), `sessions_backup_${stamp}`)
  fs.cpSync(src, dest, { recursive: true })
  audit('backup', dest)
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
async function clearAllSessions(ctx, { permanent = false } = {}) {
  const list = await listSessions(ctx)
  const results = []
  const worker = async (s) => {
    try {
      const r = await deleteSessionCore(ctx, s.sessionId, { permanent })
      results.push({ sessionId: s.sessionId, title: s.title, ok: true, ...r })
    } catch (e) {
      results.push({ sessionId: s.sessionId, title: s.title, ok: false, error: e.message })
    }
  }
  // 并发受限执行
  let idx = 0
  const runners = Array.from({ length: Math.min(CLEAR_ALL_CONCURRENCY, list.length) }, async () => {
    while (idx < list.length) {
      const cur = list[idx++]
      await worker(cur)
    }
  })
  await Promise.all(runners)
  return { total: list.length, results }
}

// ---------- http helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-session-cleaner-version': '0.2.0',
  })
  res.end(body)
}
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => {
      data += d
      if (data.length > 1e6) {
        req.destroy()
        try { sendJson(res, 413, { error: 'payload too large' }) } catch { /* connection gone */ }
        reject(new CleanerError('payload too large', 413))
      }
    })
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
  const routes = {
    '/__session-cleaner/list': async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try { sendJson(res, 200, { ok: true, sessions: await listSessions(appCtx) }) }
      catch (e) { sendJson(res, 500, { error: e.message }) }
    },
    '/__session-cleaner/trash-list': async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try { sendJson(res, 200, { ok: true, trash: listTrash() }) }
      catch (e) { sendJson(res, 500, { error: e.message }) }
    },
    '/__session-cleaner/delete': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req, res); if (b) args = JSON.parse(b) } catch { return }
      const sessionId = String(args.sessionId || '').trim()
      if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' })
      const permanent = args.permanent === true
      let backupPath = null
      if (args.backup) {
        try { backupPath = backupSessions() } catch (e) { return sendJson(res, 500, { error: 'backup failed: ' + e.message }) }
      }
      try {
        const result = await deleteSessionCore(appCtx, sessionId, { permanent })
        sendJson(res, 200, { ok: true, removed: [sessionId], backupPath, ...result })
      } catch (e) {
        const status = e instanceof CleanerError && e.status ? e.status : 500
        sendJson(res, status, { error: e.message })
      }
    },
    '/__session-cleaner/delete-current': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req, res); if (b) args = JSON.parse(b) } catch { return }
      const sessionId = String(args.sessionId || '').trim()
      if (!sessionId) return sendJson(res, 400, { error: 'sessionId required (前端需传当前会话)' })
      // 防误删：必须显式 confirm:"yes"
      if (args.confirm !== 'yes') return sendJson(res, 400, { error: 'confirm required: pass confirm:"yes"' })
      const permanent = args.permanent === true
      let backupPath = null
      if (args.backup) {
        try { backupPath = backupSessions() } catch (e) { return sendJson(res, 500, { error: 'backup failed: ' + e.message }) }
      }
      try {
        const result = await deleteSessionCore(appCtx, sessionId, { permanent })
        sendJson(res, 200, { ok: true, removed: [sessionId], backupPath, ...result })
      } catch (e) {
        const status = e instanceof CleanerError && e.status ? e.status : 500
        sendJson(res, status, { error: e.message })
      }
    },
    '/__session-cleaner/restore': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req, res); if (b) args = JSON.parse(b) } catch { return }
      const trashId = String(args.trashId || '').trim()
      if (!trashId) return sendJson(res, 400, { error: 'trashId required' })
      try {
        const r = restoreTrash(trashId)
        sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        const status = e instanceof CleanerError && e.status ? e.status : 500
        sendJson(res, status, { error: e.message })
      }
    },
    '/__session-cleaner/purge-trash': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req, res); if (b) args = JSON.parse(b) } catch { return }
      try {
        if (args.all === true) return sendJson(res, 200, { ok: true, ...purgeAllTrash() })
        const trashId = String(args.trashId || '').trim()
        if (!trashId) return sendJson(res, 400, { error: 'trashId or all:true required' })
        sendJson(res, 200, { ok: true, ...purgeTrash(trashId) })
      } catch (e) {
        const status = e instanceof CleanerError && e.status ? e.status : 500
        sendJson(res, status, { error: e.message })
      }
    },
    '/__session-cleaner/clear-all': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let args = {}
      try { const b = await readBody(req, res); if (b) args = JSON.parse(b) } catch { return }
      let backupPath = null
      if (args.backup !== false) {
        try { backupPath = backupSessions() } catch (e) { return sendJson(res, 500, { error: 'backup failed: ' + e.message }) }
      }
      try {
        const result = await clearAllSessions(appCtx, { permanent: args.permanent === true })
        sendJson(res, 200, { ok: true, backupPath, ...result })
      } catch (e) {
        sendJson(res, 500, { error: e.message })
      }
    },
    '/__session-cleaner/backup': async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const dest = backupSessions()
        sendJson(res, 200, { ok: true, backupPath: dest })
      } catch (e) { sendJson(res, 500, { error: e.message }) }
    },
  }
  for (const [pathname, handler] of Object.entries(routes)) {
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: pathname,
      handler: withConnectionAuth(host.connection, handler),
    }))
  }
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
    description: 'Delete one session. Default moves it to the trash (recoverable via session_cleaner_trash_list / restore); pass permanent=true for physical deletion. Optionally backup first (backup=true default true).',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'session id (uuid or session-<uuid>)' },
      permanent: { type: 'boolean', description: 'physical delete (default false = to trash, recoverable)' },
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
        const r = await deleteSessionCore(ctx, sessionId, { permanent: args.permanent === true })
        return `${r.permanent ? 'permanently deleted' : 'moved to trash (recoverable)'}: ${sessionId}\nbackup: ${backupPath || 'none'}\n${JSON.stringify(r)}`
      } catch (e) {
        return `delete failed: ${e.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_cleaner_trash_list',
    description: 'List trash (recycle bin) entries: sessions deleted but recoverable, with age and expiry.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
    async execute() {
      return JSON.stringify({ total: listTrash().length, trash: listTrash() }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_cleaner_restore',
    description: 'Restore one trashed session back to the workbench by trashId (see session_cleaner_trash_list).',
    parameters: {
      trashId: { type: 'string', required: true, description: 'trash entry id from session_cleaner_trash_list' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
    async execute(args) {
      try {
        const r = restoreTrash(String(args.trashId || '').trim())
        return `restored: ${JSON.stringify(r)}`
      } catch (e) {
        return `restore failed: ${e.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_cleaner_purge_trash',
    description: 'Permanently purge trash entries (pass trashId for one, or all=true to empty the trash).',
    parameters: {
      trashId: { type: 'string', description: 'trash entry id; omit when all=true' },
      all: { type: 'boolean', description: 'empty entire trash' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
    async execute(args) {
      try {
        if (args.all === true) {
          const r = purgeAllTrash()
          return `purged: ${JSON.stringify(r)}`
        }
        const r = purgeTrash(String(args.trashId || '').trim())
        return `purged: ${JSON.stringify(r)}`
      } catch (e) {
        return `purge failed: ${e.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_cleaner_clear_all',
    description: 'Delete ALL sessions of this workbench (workspace folders are kept). Default moves them to trash (recoverable); pass permanent=true for physical deletion. Optionally backup first (backup=true default true).',
    parameters: {
      permanent: { type: 'boolean', description: 'physical delete (default false = to trash, recoverable)' },
      backup: { type: 'boolean', description: 'backup sessions before delete (default true)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => String(v) },
    async execute(args) {
      let backupPath = null
      if (args.backup !== false) {
        try { backupPath = backupSessions() } catch (e) { return `backup failed: ${e.message}` }
      }
      const r = await clearAllSessions(ctx, { permanent: args.permanent === true })
      return `backup: ${backupPath || 'none'}\ntotal: ${r.total} (${r.permanent ? 'permanent' : 'to trash'})\n${JSON.stringify(r.results, null, 2)}`
    },
  }))
}
