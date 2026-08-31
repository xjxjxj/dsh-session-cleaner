# dsh-session-cleaner

> DeepSeek Harness（dsh）会话清理插件：在 Web 界面右下角添加一个「🗑 清理会话」浮动按钮，支持删除当前会话 / 单个会话 / 清空所有会话，删除前可选备份。

- **适配版本**：dsh 0.1.1-rc.2+（Cordis 插件架构）
- **平台**：Web 客户端（`dsh web` 启动的界面）
- **许可**：MIT
- **依赖**：`@deepseek-ai/dsh-tools`（dsh 自带）

## 功能

| 按钮 | 说明 |
|------|------|
| 🗑 清理会话 | 右下角浮动按钮，点击打开弹窗 |
| 删除当前会话 | 删除你正在操作的这个会话 |
| 删除选中 | 勾选 1 个会话删除（多选用"清空所有"） |
| 清空所有会话 | 一次性删除全部会话（工作区文件夹保留） |
| 仅备份（不删） | 把 `~/.dsh/sessions/` 整目录复制到 `~/.dsh/backup-archive/sessions_backup_<时间戳>/` |

### 删除流程（服务端）

每个会话删除都执行以下 6 步，确保彻底清理：

1. **停运行中的 agent**（`agent.cancel` + 等待 `whenIdle`，超时 15s）
2. **flush 会话**（`sessions.flush` 把内存写盘）
3. **内存 detach**（`sessions.detachEntered` 或 `store.delete`）
4. **删磁盘日志**（`~/.dsh/sessions/*/session-<uuid>`，最多重试 3 次）
5. **清 projection 缓存**（`session_projcache.sessions` 表）
6. **清 workspace 记账**（`workspace.workspaces.sessionIds` + `archivedSessionIds`）

### 备份

备份前会弹出确认框，三选一：

- **先备份再删**（推荐）：整目录复制到 `~/.dsh/backup-archive/sessions_backup_<ISO 时间戳>/`
- **不备份，直接删**
- **取消**

## 安装

### 方式 1：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:xjxjxj/dsh-session-cleaner
```

或指定 commit 版本（锁定，更稳）：

```bash
dsh plugin --profile web add 'github:xjxjxj/dsh-session-cleaner#<commit-sha>'
```

### 方式 2：本地路径安装

```bash
dsh plugin --profile web add /path/to/dsh-session-cleaner
```

### 方式 3：npm 包（如后续发布到 npm）

```bash
dsh plugin --profile web add dsh-session-cleaner
```

### 安装后验证

```bash
# 查看插件是否在配置树里
dsh --profile web --dump-config | grep session-cleaner

# 查看依赖来源
dsh plugin --profile web why dsh-session-cleaner
```

重启 dsh（`Ctrl+C` 后重新 `dsh web`），右下角应出现「🗑 清理会话」按钮。

## 卸载

```bash
dsh plugin --profile web remove dsh-session-cleaner
```

> 注意：插件注册过的 `cordis.patch.yml` 块会保留在 profile 里，如需彻底清理可手动删除 `~/.dsh/profiles/web/cordis.patch.yml` 中 `session-cleaner` 相关行。

## Agent 工具（供模型调用）

插件同时注册了 3 个工具，AI 在对话中可直接调用：

| 工具名 | 参数 | 说明 |
|--------|------|------|
| `session_cleaner_list` | — | 列出所有会话（id、title、running） |
| `session_cleaner_delete` | `sessionId`（必填）、`backup`（默认 true） | 删除单个会话 |
| `session_cleaner_clear_all` | `backup`（默认 true） | 清空所有会话 |

对 AI 说"帮我清理会话"或"删除所有会话"即可触发。

## HTTP 接口

插件向 dsh web server 注册 5 个端点（带连接认证）：

```
GET  /__session-cleaner/list         列出会话
POST /__session-cleaner/delete       { sessionId, backup }
POST /__session-cleaner/delete-current  { sessionId, backup }
POST /__session-cleaner/clear-all    { backup }
POST /__session-cleaner/backup       {}
```

## 文件结构

```
dsh-session-cleaner/
├── package.json          # 包元数据 + dsh 插件声明
├── cordis.patch.yml      # Cordis bundle patch（声明插件 id）
├── index.js              # 服务端：HTTP 端点 + Agent 工具
├── client.js             # 前端：浮动按钮 + 弹窗 UI
├── README.md             # 本文件
└── LICENSE               # MIT
```

## 开发

```bash
# 本地开发（在 dsh checkout 目录）
pnpm link ./dsh-session-cleaner
dsh plugin --profile web link ./dsh-session-cleaner

# 热重载（client 端）
# client.js 改动后需 pnpm run dev:web 重建 bundle
```

## License

MIT © [xjxjxj](https://github.com/xjxjxj)
