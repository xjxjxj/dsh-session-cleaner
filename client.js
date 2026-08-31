// dsh-session-cleaner —— 前端：浮动"清理会话"按钮 + 弹窗（删除当前/单个/全部，删除前询问是否备份）
window.__ModuleLoader__.load({
  id: 'dsh-session-cleaner',
  factory: () => {
    const module = { exports: {} }
    module.exports.inject = ['sessions']
    module.exports.apply = ctx => {
      const css = `
.dsh-cleaner-btn{position:fixed;z-index:9998;right:16px;bottom:76px;display:flex;align-items:center;gap:6px;
  padding:8px 14px;border:1px solid rgba(127,127,127,.25);border-radius:999px;background:rgba(255,255,255,.96);
  color:#111;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.08);backdrop-filter:blur(8px)}
.dsh-cleaner-btn:hover{background:#f3f4f6}
.dsh-cleaner-mask{position:fixed;z-index:9999;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}
.dsh-cleaner-modal{width:420px;max-width:92vw;max-height:80vh;overflow:auto;background:#fff;border-radius:14px;
  box-shadow:0 12px 40px rgba(0,0,0,.2);padding:20px;font:13px/1.6 Inter,system-ui,sans-serif;color:#111}
.dsh-cleaner-modal h3{margin:0 0 6px;font-size:16px}
.dsh-cleaner-sub{color:#6b7280;font-size:12px;margin-bottom:14px}
.dsh-cleaner-current{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12px}
.dsh-cleaner-list{max-height:200px;overflow:auto;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:14px}
.dsh-cleaner-list label{display:flex;gap:8px;align-items:center;padding:7px 10px;cursor:pointer}
.dsh-cleaner-list label:hover{background:#f9fafb}
.dsh-cleaner-list label+label{border-top:1px solid #f3f4f6}
.dsh-cleaner-list .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-cleaner-list .i{color:#9ca3af;font-size:11px}
.dsh-cleaner-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-cleaner-actions button{padding:7px 12px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;font:600 12px Inter,system-ui,sans-serif}
.dsh-cleaner-actions button:hover{background:#f9fafb}
.dsh-cleaner-actions button.danger{background:#fee2e2;border-color:#fecaca;color:#b91c1c}
.dsh-cleaner-actions button.danger:hover{background:#fecaca}
.dsh-cleaner-actions button.primary{background:#111;border-color:#111;color:#fff}
.dsh-cleaner-actions button.primary:hover{background:#333}
.dsh-cleaner-actions button:disabled{opacity:.5;cursor:not-allowed}
.dsh-cleaner-status{margin-top:10px;font-size:12px;color:#374151;white-space:pre-wrap;word-break:break-all}
.dsh-cleaner-confirm{position:fixed;z-index:10000;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}
.dsh-cleaner-confirm-box{width:340px;background:#fff;border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.25);font:13px/1.6 Inter,system-ui,sans-serif}
.dsh-cleaner-confirm-box h4{margin:0 0 8px;font-size:14px}
.dsh-cleaner-confirm-box p{margin:0 0 14px;color:#374151}
.dsh-cleaner-confirm-box .row{display:flex;gap:8px;justify-content:flex-end}
.dsh-cleaner-confirm-box button{padding:7px 12px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;font:600 12px Inter,system-ui,sans-serif}
.dsh-cleaner-confirm-box button.primary{background:#111;border-color:#111;color:#fff}
.dsh-cleaner-confirm-box button.primary:hover{background:#333}
.dsh-cleaner-confirm-box button.danger{background:#b91c1c;border-color:#b91c1c;color:#fff}
.dsh-cleaner-confirm-box button.danger:hover{background:#991b1b}
`
      const style = document.createElement('style')
      style.textContent = css
      document.head.append(style)

      // ---- snapshot helpers ----
      const snap = () => ctx.sessions.list.getSnapshot()
      const sessionsOf = () => {
        const s = snap()
        return s.ids.map(id => ({
          id,
          title: s.byId[id]?.displayTitle ?? s.byId[id]?.title ?? id,
          current: s.current === id,
        }))
      }

      // ---- api ----
      async function api(path, body) {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        return data
      }

      // ---- confirm dialog (backup ask) ----
      function askBackup(title, desc) {
        return new Promise(resolve => {
          const mask = document.createElement('div')
          mask.className = 'dsh-cleaner-confirm'
          mask.innerHTML = `<div class="dsh-cleaner-confirm-box">
            <h4>${title}</h4><p>${desc}</p>
            <div class="row">
              <button data-act="cancel">取消</button>
              <button data-act="nobackup">不备份，直接删</button>
              <button data-act="backup" class="primary">先备份再删</button>
            </div></div>`
          mask.addEventListener('click', e => {
            const act = e.target.getAttribute('data-act')
            if (!act) return
            mask.remove()
            if (act === 'cancel') resolve(null)
            else if (act === 'nobackup') resolve(false)
            else resolve(true)
          })
          document.body.append(mask)
        })
      }

      // ---- main modal ----
      function openModal() {
        const sessions = sessionsOf()
        const current = sessions.find(s => s.current)
        const mask = document.createElement('div')
        mask.className = 'dsh-cleaner-mask'
        const listHtml = sessions.map(s =>
          `<label><input type="checkbox" value="${s.id}" ${s.current ? 'checked' : ''}>
             <span class="t" title="${s.title}">${s.title}${s.current ? '（当前）' : ''}</span>
             <span class="i">${s.id.slice(0, 8)}</span></label>`
        ).join('')
        mask.innerHTML = `<div class="dsh-cleaner-modal">
          <h3>🧹 会话清理</h3>
          <div class="dsh-cleaner-sub">删除前会询问是否备份。删除后界面自动刷新。</div>
          ${current ? `<div class="dsh-cleaner-current">当前会话：<b>${current.title}</b>（${current.id.slice(0, 8)}）</div>` : '<div class="dsh-cleaner-current">未检测到当前会话</div>'}
          <div class="dsh-cleaner-list">${listHtml || '<div style="padding:10px;color:#9ca3af">没有会话</div>'}</div>
          <div class="dsh-cleaner-actions">
            <button data-act="delete-current" class="danger" ${current ? '' : 'disabled'}>删除当前会话</button>
            <button data-act="delete-selected" class="danger">删除选中</button>
            <button data-act="clear-all" class="danger">清空所有会话</button>
            <button data-act="backup" class="primary">仅备份（不删）</button>
            <button data-act="close">关闭</button>
          </div>
          <div class="dsh-cleaner-status"></div>
        </div>`

        const status = mask.querySelector('.dsh-cleaner-status')
        const setStatus = t => { status.textContent = t }
        const selected = () => [...mask.querySelectorAll('input:checked')].map(i => i.value)
        const busy = on => {
          for (const b of mask.querySelectorAll('button')) b.disabled = on
        }
        const runDelete = async (ids, all) => {
          const desc = all ? `将永久删除全部 ${ids.length} 个会话（工作区保留）。`
            : `将永久删除 ${ids.length} 个会话。`
          const backup = await askBackup('确认删除', desc)
          if (backup === null) { setStatus('已取消'); return }
          busy(true)
          try {
            const body = all ? { backup } : { sessionId: ids[0], backup }
            const r = await api(all ? '/__session-cleaner/clear-all' : '/__session-cleaner/delete', body)
            setStatus(`✅ 已删除 ${all ? r.total : ids.length} 个会话\n备份：${r.backupPath || '无'}${r.results ? '\n' + r.results.map(x => `  ${x.ok ? '✓' : '✗'} ${x.title}`).join('\n') : ''}`)
            setTimeout(() => location.reload(), 1200)
          } catch (e) {
            setStatus('❌ ' + e.message)
          } finally { busy(false) }
        }

        mask.addEventListener('click', e => {
          const act = e.target.getAttribute('data-act')
          if (!act) return
          if (act === 'close') return mask.remove()
          if (act === 'delete-current') {
            if (current) runDelete([current.id], false)
            return
          }
          if (act === 'delete-selected') {
            const ids = selected()
            if (ids.length === 0) return setStatus('请先勾选要删除的会话')
            if (ids.length === 1) return runDelete(ids, false)
            setStatus('只能勾选 1 个进行单删；要全删请用"清空所有"')
            return
          }
          if (act === 'clear-all') {
            const ids = sessions.map(s => s.id)
            if (ids.length === 0) return setStatus('没有会话可删')
            runDelete(ids, true)
            return
          }
          if (act === 'backup') {
            busy(true)
            api('/__session-cleaner/backup', {}).then(r => {
              setStatus('✅ 已备份到：' + r.backupPath)
            }).catch(e => setStatus('❌ ' + e.message)).finally(() => busy(false))
          }
        })
        document.body.append(mask)
      }

      // ---- floating button ----
      const btn = document.createElement('button')
      btn.className = 'dsh-cleaner-btn'
      btn.textContent = '🗑 清理会话'
      btn.title = '删除当前/单个/全部会话'
      btn.addEventListener('click', openModal)
      document.body.append(btn)

      return () => { btn.remove(); style.remove() }
    }
    return module.exports
  }
})
