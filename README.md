# dsh-tool-cordis-local

DeepSeek Harness 的独立创造模式工具集：把「读写自己运行时」的能力做成**宿主层的普通插件**，让创造模式可以被复制。

不 import 任何 `@deepseek-ai/*` 包，运行时零依赖，一切能力都从 Cordis 服务面取。

## 它解决什么问题

DSH 里能读写运行时的能力来自随部署附带的 `cordis` 预设（创造模式）。这个预设没法被复制，原因不是权限，而是**注册表占位**——两层限制叠在一起：

**一、原件只读。** 随部署附带的预设由部署提供，`agent-presets` 拒绝写它（`agent-preset/read-only`：*"it ships with the deployment"*）。官方给的修改路径是"复制一份再编辑"，复制也是 UI 里创建预设的唯一方式。

**二、复制品挂不起来。** 它依赖 `@deepseek-ai/dsh-tool-cordis` 这一行，而这行会把自己的检查 provider 注册进**进程级单例注册表** `cordisInspect`；该注册表对重复 id 直接抛错：

```
Host Cordis inspect provider "..." is already registered
```

原件随部署常驻，复制品再挂同一行必然撞车，结果是**新会话创建时报 `agent-preset/invalid`，整个预设挂载失败**。照抄的预设装不上，创造模式就只剩下原件那一份，不能改、不能扩。

**本插件的解法**：把同一套能力改写成宿主层普通工具——进程里挂一次，对所有预设、所有会话生效，**不向 `cordisInspect` 注册任何 provider**（检查目录自持，活读运行时）。代价是它不出现在官方的 provider 目录里；换来的是任意多个 cordis 能力预设可以共存，原件照常可用，两者不冲突。

## 提供什么

| 工具 | 作用 |
|---|---|
| `cordis_inspect_list` | 列出检查面：四个宿主 provider（Service / Event / Builtin / Tool），加上从浏览器页面镜像来的客户端 provider |
| `cordis_inspect_query` | 只读查询。宿主查询本地执行；客户端查询转发给已连接的页面，页面应答才返回 |
| `cordis_inspect_self` | 看本会话拥有的动态插件、包版本、运行诊断与源码 |
| `cordis_define` | 记录一个不可变的 Package（宿主半边 / 客户端半边）。只记录源码，不执行、不改变运行版本 |
| `cordis_run` | 激活一个 Package：首次运行用 `run`，换版本用 `update`，回滚也用 `run` |
| `cordis_stop` | 停掉当前运行，保留定义、版本与授权，之后可以直接再跑 |
| `cordis_undefine` | 永久删除插件及其全部版本 |

宿主 provider 的检查面是**活读**：`Service.listService` 直接反射运行时的服务存储，`Tool.listTools` 读的是调用方 agent 当前真实可见的工具 schema，`Event.listEvents` 与 `Builtin.listBuiltins` 是自持的声明清单（运行时没有公开的事件名枚举面，所以查询未收录的名字会明确报错，而不是返回空）。

另外注册一段系统提示（`tool:cordis`），说明这套工具的用法。

## 与官方 `@deepseek-ai/dsh-tool-cordis` 的差异

| | 官方 `dsh-tool-cordis` | 本插件 |
|---|---|---|
| 挂载位置 | 预设行，每个预设各挂一份 | 宿主组合，全进程一份 |
| 写 `cordisInspect` 注册表 | 是，注册自己的 provider | **否，一个都不注册** |
| 与常驻 `cordis` 预设共存 | 不能，重复 id 直接抛错 | 能 |
| 检查面来源 | 官方 provider 目录 | 自持目录 + 活读运行时 |
| 动态插件生命周期 | 无（只有两个只读检查工具） | `define` / `run` / `stop` / `undefine` |
| 客户端查询 | 需要已连接页面 | 同左 |

## 安装

在 DSH 的 profile 目录（默认 `~/.dsh/profiles/web`）里：

```sh
pnpm add 'github:leolee9086/dsh-tool-cordis-local#v0.1.0'
```

然后用下面**任意一种**方式挂载（两种别同时用，会挂两遍）。

**方式一：profile 补丁层加一行**

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: tool-cordis-local
      name: dsh-tool-cordis-local
```

**方式二：作为 bundle 挂载**

```jsonc
// ~/.dsh/profiles/web/package.json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-tool-cordis-local"] } }
```

改完重启 Harness；开发模式下把补丁行改一下（比如加个查询串）就能让 HMR 重新加载这一行，不必重启。

## 运行时契约

插件 `inject` 四个服务，缺任何一个都会停在 waiting，工具不出现：

| 服务 | 用途 | 谁提供 |
|---|---|---|
| `tools` | 注册模型可见的工具 | 宿主组合 |
| `systemPrompt` | 注册 `tool:cordis` 提示段 | 宿主组合 |
| `dynamicCordisRunner` | 动态插件的定义 / 运行 / 停止 / 删除 | `@deepseek-ai/dsh-cordis-host-runner` |
| `cordisInspect` | 转发客户端检查查询 | `@deepseek-ai/dsh-cordis-host-runner` |

所以宿主组合里需要有 `@deepseek-ai/dsh-cordis-host-runner`。客户端检查面来自 `@deepseek-ai/dsh-cordis-client-runner`，并且**需要至少一个已连接的 Web 页面**，否则客户端查询会一直挂着，直到页面应答或调用被取消。

## 已知边界

- **不注册 provider 的代价**：官方的 provider 目录里看不到本工具集的检查面，任何靠 `cordisInspect` 注册表发现 provider 的第三方代码也看不到它。这是刻意的取舍，不是遗漏。
- **需要 Agent 型会话**：所有工具都要求 `exec.agent`，脱离会话调用会明确报错。
- **动态插件是进程内的临时产物**：重启进程后定义消失（与官方 runner 的行为一致）。
- **只读与执行是两件事**：`cordis_inspect_query` 不能调用业务服务方法、不能改运行时；真正会执行代码的是 `cordis_define` + `cordis_run`。

## 安全提示

这套工具让模型能定义并运行任意 JavaScript（宿主半边在 Harness 进程内执行），也能读到运行时的服务与事件目录。**把挂着它的会话当作 shell 权限来对待**：不要在不信任的会话里开放它。

## 开发

```sh
pnpm run check   # node --check src/index.js
pnpm run test    # node --test，零依赖冒烟测试（导出契约、工具清单、不注册 provider 这条不变量）
pnpm run build   # 校验后逐字节拷贝 src/index.js → lib/index.js
```

改代码请改 `src/`，再 `pnpm run build`。`lib/` 是构建产物，随仓库提交——安装方直接用，不需要在自己机器上构建。构建脚本在写产物前会做完所有校验（拒绝裸包名 import、拒绝本机绝对路径、真跑一遍 import 确认导出契约），任何一项失败都不会留下半成品。

## 许可

MIT
