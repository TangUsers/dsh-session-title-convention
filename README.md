# dsh-session-title-convention

按工作区约定自动整理 DeepSeek Harness 会话标题：

```
【<阶段><状态>】<工作区>｜<模块>｜<创建日期 MMDD>｜<问题简述>
```

插件本身不含任何具体项目信息；工作区名、模块词表、生效目录全部来自配置。未配置 `workspace` 时，工作区名取会话 `cwd` 的目录名。

> **English** — A DeepSeek Harness host plugin that rewrites automatically generated session titles into a configurable `【stage+status】workspace｜module｜MMDD｜brief` form. Human renames are never touched. The convention's stage vocabulary is Chinese; everything else (workspace label, module rules, scope, time zone) is configuration.

## 安装

```bash
# npm（推荐：市场里能一键安装、能检查更新）
install_bundle dsh-session-title-convention

# 或直接从 GitHub
install_bundle github:TangUsers/dsh-session-title-convention

# 或写进 profile 的 package.json
#   "dsh-session-title-convention": "^0.1.0"
```

装完需要重启宿主才生效：Desktop 退出重开，Web 重启服务（Host 插件不热加载）。

安装即生效，**默认作用于所有会话**——见下方「生效范围」。只想在特定仓库里用，先配 `roots`。

## 行为

- 监听 `session/title` 事件：来源为 `fallback` / `provider`（即模型自动生成的标题）且不符合约定时改写；来源为 `user`（人工改名）时永不改动。
- `fallback` 标题延迟 8 秒再处理，等 provider 生成更好的标题；`provider` 标题立即处理。
- 模块按 `moduleRules` 依次匹配当前标题；都不命中时用 `defaultModule`。
- 日期取会话 `header.createdAt` 的月日，四位数（如 `1103`），时区由 `timeZone` 决定，默认本机时区。
- 仅处理 `cwd` 位于 `roots` 之下、非 subagent、非 seeded 的会话；`roots` 为空表示所有工作区。
- `sweepOnStart` 打开时，启动 2 秒后把最近 `sweepMaxAgeMinutes` 分钟内仍是非合规自动标题的会话一并整理。默认关闭。
- 改写走 `sessionTitle.rename()`，结果被标记为 `user` 来源并固定，所以插件不会和人抢标题，也不会反复改写自己的输出。

### 生效范围

`roots` 默认为空，也就是**每个工作区的每个会话**都会被改写成上面的格式。安装前请确认这是你要的；否则先限定目录：

```yaml
- id: session-title-convention
  config:
    roots:
      - /path/to/repo
```

标题只会被改写一次（随后即固化为 `user` 来源），但一旦改写就在会话列表里长期可见。

## 工具

注册 `session_title` 工具，代理可显式调整阶段/状态，不必整名重写：

```json
{ "stage": "实现", "status": "🟢", "module": "会话治理", "brief": "xxx" }
```

只传需要改的字段，其余沿用当前标题。阶段词表固定为 `盘点 / 设计 / 实现 / 验证 / 收口 / 归档`，状态为 `🟢 🟡 🔴 ✅ 🧊`；约定允许阶段为空。

## 配置

在 profile 的 `cordis.patch.yml` 里按插件 id 覆盖配置（这是本机配置，不会随插件分发）：

```yaml
- id: session-title-convention
  config:
    workspace: 某个工作区名
    roots:
      - /path/to/repo
    defaultModule: 通用
    timeZone: Asia/Shanghai
    moduleRules:
      - ['权限|授权|菜单', 权限治理]
      - ['迁移|migration|V\\d+__', 数据库迁移]
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | `''` | 工作区名；空则取会话 cwd 目录名 |
| `roots` | `[]` | 生效目录；空 = 所有会话 |
| `defaultStage` | `''` | 默认阶段；约定允许省略 |
| `defaultStatus` | `🟢` | 默认状态 |
| `defaultModule` | `通用` | 未命中任何规则时的模块 |
| `maxBrief` | `40` | 简述最大长度 |
| `timeZone` | `''` | 日期时区；空 = 本机 |
| `fallbackDelayMs` | `8000` | fallback 标题的延迟 |
| `sweepOnStart` | `false` | 启动时整理存量会话 |
| `sweepMaxAgeMinutes` | `1440` | sweep 只处理该时限内的会话；0 = 不限 |
| `moduleRules` | `[]` | `[正则, 模块]` 或 `{pattern, module}` |

## 本地开发

```bash
# 用目录绝对路径安装；改完代码后要先卸载再装，才会加载新的模块代际
install_bundle /path/to/dsh-session-title-convention
```

直接改文件不会热更新。

## License

[MIT](./LICENSE)
