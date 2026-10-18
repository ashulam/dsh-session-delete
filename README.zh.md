# dsh-session-delete

**简体中文** | [English](README.md)

把「删除会话」加到 [DeepSeek Harness](https://github.com/deepseek-ai) 侧栏的会话菜单里，做**真正可恢复**的删除。

![会话菜单里的「删除会话」](assets/01-session-menu.png)

![删除前的确认框](assets/02-confirm-dialog.png)

## 做什么

悬停一个会话行 → 点右侧 **⋯** → **删除会话**。

| 会话状态 | 行为 |
|---|---|
| **冷会话**（本次运行没加载过） | 立即删除；日志与回放缓存进 Windows **回收站**（不可用时移到 `<DSH_HOME>/.session-trash/`）。侧栏列表通过客户端 Session controller 自动刷新，不需要刷新页面。 |
| **活会话**（当前打开的，或本次运行里打开过的） | DSH 没有"关闭会话"的 API，直接删文件不安全。插件会问要不要**排队**：`POST /dsh-session-delete/queue` 写入 `<DSH_HOME>/.session-delete-queue.json`，**下次启动**时在任何会话被打开之前把队列清掉。 |

重启后排空队列时，右下角会浮出一张小卡片，列出删了哪些会话（最多 5 个标题 + 其余计数），并提示没能删除、仍留在队列里的条目。

## 删除哪些文件

针对一个会话 id：

| 路径 | 内容 |
|---|---|
| `<DSH_HOME>/sessions/<project>/session-<id>/` | 只追加的事件日志 |
| `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` | 回放/投影缓存 |

其它一概不动。附件是跨会话共享、按内容寻址的 blob，**故意不碰**。Workspace 登记里的 `sessionIds` 条目会保留——登记表没有"注销会话"的 API，而侧栏本来就会跳过存储已不存在的 id。

## 安全

- **活会话**一律拒绝（`409`），只能走"下次启动排队删除"。
- HTTP 路由位于宿主的浏览器信任栅栏（`connection.requestRejection`）之后，且只接受 `session-<uuid>` 格式的 id。
- 删除可恢复：回收站，或 `<DSH_HOME>/.session-trash/<时间戳>/`。

## 环境要求

- DeepSeek Harness 0.2.x（用到 `sidebar.workspaces.session.menu.item` 与 `shell.overlay` 槽位）。
- Windows 才有回收站；其它平台落到自管的 trash 目录。

## 安装

登记表合并后可在插件市场直接安装。手动安装：

```sh
dsh plugin --profile desktop add github:ashulam/dsh-session-delete
# 或从本地目录：
cd <profile 目录>
pnpm add file:<本仓库路径>
# 然后把 "dsh-session-delete" 加进 package.json 的 dsh.profile.bundles
```

## 结构

- `lib/index.js` — 宿主半边：`POST /dsh-session-delete/delete`、`POST /dsh-session-delete/queue`、`GET /dsh-session-delete/last-drain`，以及启动时排空队列。
- `client/client.js` — 浏览器半边：会话菜单条目与启动摘要卡片。
- `cordis.patch.yml` — 把宿主行插进 profile。

## 许可

MIT
