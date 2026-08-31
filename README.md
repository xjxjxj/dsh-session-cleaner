# dsh-session-cleaner 🧹

DeepSeek Harness (dsh) 会话清理插件——删除当前会话 / 删除单个会话 / 清空所有会话，删除前可询问是否备份。

适配 **dsh 0.1.1-rc.2**（桌面端 & 浏览器端 Web profile 通用）。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🗑 删除当前会话 | 一键删掉正在查看的会话 |
| 🗑 删除选中会话 | 在列表勾选后删除 |
| 🗑 清空所有会话 | 全部删除（工作区保留） |
| 💾 删除前备份询问 | 可选「先备份再删 / 不备份直接删 / 取消」 |
| 📦 仅备份 | 只把 sessions 目录备份到 `backup-archive`，不删除 |

删除逻辑完整（开源成熟方案）：停运行中 agent → flush 会话 → 内存 detach → 删磁盘日志 → 清 projection 缓存 → 清 workspace 记账，**删除后不复活**。

## 🚀 安装

### 方式一：dsh 插件命令（推荐）

```bash
dsh plugin --profile web add dsh-session-cleaner
```

### 方式二：手动（当前 profile）

把 `dsh-session-cleaner` 目录放到 profile 的 node_modules 下，并在 `profiles/web/package.json` 中：

```json
{
  "dependencies": {
    "dsh-session-cleaner": "file:node_modules/dsh-session-cleaner"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-session-cleaner"]
    }
  }
}
```

重启桌面端 / 重新加载后生效。

## 📖 使用

1. 打开 dsh 界面，右下角出现 **`🗑 清理会话`** 浮动按钮
2. 点击弹出会话清理面板
3. 选择操作（删除当前 / 删除选中 / 清空所有 / 仅备份）
4. 点删除会弹出**备份询问**，按需选择
5. 完成后界面自动刷新

## ⚙️ 技术实现

- **服务端**（`index.js`）：cordis 插件，注册 HTTP API + agent 工具
  - `GET /__session-cleaner/list` — 会话列表
  - `POST /__session-cleaner/delete` — 删除单个（可选备份）
  - `POST /__session-cleaner/delete-current` — 删除当前
  - `POST /__session-cleaner/clear-all` — 清空所有（保留工作区）
  - `POST /__session-cleaner/backup` — 仅备份
  - Agent 工具：`session_cleaner_list` / `session_cleaner_delete` / `session_cleaner_clear_all`
- **前端**（`client.js`）：纯 DOM 注入浮动按钮 + 弹窗，无框架依赖，稳定不易碎

## 📁 目录结构

```
dsh-session-cleaner/
├── index.js          # 服务端 cordis 插件（删除核心 + API + 工具）
├── client.js         # 前端 UI（浮动按钮 + 弹窗 + 备份询问）
├── cordis.patch.yml  # bundle 注册文件
├── package.json      # 包声明（ESM + dsh.client）
└── README.md
```

## 📄 License

[MIT](LICENSE)
