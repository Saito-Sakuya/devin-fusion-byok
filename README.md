# Devin Fusion BYOK — Windows 适配 Fork（Saito）

**这是面向 Windows Devin Local 的适配与维护分支。** 重点修复 Windows 下的运行路径、上下文统计、PowerShell Goal 报告和 VSIX 打包，并持续维护 BYOK 接口兼容性。主要开发与实际 Devin 验收环境是 Windows。

基于 [kuobibulaien/devin-fusion-byok](https://github.com/kuobibulaien/devin-fusion-byok) 的 `v0.3.42`，当前版本 **0.3.45**。本 Fork 独立维护，保留原项目与第三方组件的 MIT 许可证及版权声明；更新检查使用 [本仓库 Releases](https://github.com/Saito-Sakuya/devin-fusion-byok/releases)。

把自己的模型 API 接入 Devin Local 的原生模型列表，支持 OpenAI Responses、Chat Completions 和 Anthropic Messages。可以单独选择第三方模型，也可以保存 Lead + Sidekick 的 Fusion 预设。需要正常登录的 Devin 账号及其已有权限。

本 Fork 的改进包括 OpenAI Fast 服务等级、Anthropic 地址与导入、工具可选参数、Responses 推理状态与缓存标识、后台代理与有限重试，以及 Windows 上下文请求统计和 Goal 报告提交。

## Windows 适配重点

| 适配项 | 本分支的处理 |
| --- | --- |
| 会话数据库路径 | 使用 Windows 的 `%APPDATA%\Devin\cli\sessions.db`，恢复“最近请求”等指标的会话归属 |
| SQLite 读取 | 使用 Devin 内置 Node.js 的 SQLite，Worker 中只读查询，支持新版消息表内的工具标识 |
| Goal 报告命令 | 生成 PowerShell 5/7 可执行命令，支持中文、空格和单引号路径；UTF-8 JSON 编码与退出状态经过实测 |
| Windows VSIX 打包 | 使用 PowerShell Compress-Archive，支持临时目录与仓库位于不同磁盘；CI 验证测试和打包 |
| 独立后台的网络代理 | 读取 Devin 的代理配置，使后台请求使用已配置的代理；保留有界重试与取消行为 |

Linux 保留自动化测试与打包兼容性；macOS 保留已有代码路径，其应用重启、一键更新等平台操作需在 macOS 上验收。Windows 的真实验证范围详见下方表格；后续维护以 Windows 使用问题为重点。

## 安装与升级

1. 在 [Releases](https://github.com/Saito-Sakuya/devin-fusion-byok/releases) 下载 `devin-fusion-byok-<版本>.vsix`。
2. 在 Devin 命令面板运行 **Extensions: Install from VSIX…**，选择文件。
3. 当前任务结束后运行 **Developer: Reload Window**，再新建 Devin Local 对话。

扩展身份仍为 `local.devin-fusion-byok`，升级沿用已有供应商与预设配置。运行中的窗口可能仍加载旧版代码；安装 VSIX 后需要重载才能启用新的 Goal 和上下文界面。

设置页支持检查新版本。一键下载、校验、安装和“重启 Devin”目前仅实现了 **macOS**；Windows/Linux 请使用上面的 VSIX 安装和重载步骤。完整应用重启请等任务结束后进行。

## 接入模型与预设

点击右下角 **Fusion BYOK**，或运行 **Fusion BYOK：控制面板**。

1. **模型** 页添加供应商，填写 API 基础地址、密钥及接口类型。弹窗会显示实际请求地址。
2. 点击 **导入模型** 获取列表，勾选后导入。接口没有模型列表时，可以手动添加准确的模型 ID。
3. **预设** 页新建并命名预设，选择 Lead、Sidekick 和思考档位。
4. 新建 Local 对话，在原生模型选择器的 **我的 Fusion** 分组选择预设；单模型在相应供应商分组选择。

地址规则：

| 接口 | 填写的基础地址示例 | 推理地址 | 模型列表地址 |
| --- | --- | --- | --- |
| Anthropic Messages | `https://api.example.com` | `/messages` | `/models` |
| Anthropic Messages | `https://api.example.com/v1` | `/v1/messages` | `/v1/models` |
| OpenAI Responses | `https://api.example.com` | `/v1/responses` | `/v1/models` |
| Chat Completions | `https://api.example.com` | `/v1/chat/completions` | `/v1/models` |

Anthropic **不自动拼接 `/v1`**。供应商将接口放在 `/v1` 下时，请自己填上；自定义前缀同样保留。OpenAI 类型在路径中没有版本段时默认补 `/v1`。粘贴完整端点时，面板会去掉末尾的 `messages`、`responses`、`chat/completions` 或 `models`，作为基础路径保存。

模型列表返回一个 ID，不代表它支持所选协议、工具、图片或全部思考档位。上下文与输出上限优先使用列表提供的值；缺省分别为 272,000 和 131,072 token，输出上限不超过上下文上限。请按供应商实际限制修改。思考档位按模型 ID 规则生成，也可手动设置或关闭。

保存影响模型列表的变更后，插件会尝试新建对话刷新列表；连续变更可能等待约 65 秒的 CLI 缓存过期。官方候选模型取决于账号、原生目录和角色设置；预设失效时保留定义供修正。插件不会提升账号权限。

## OpenAI Fast 模式

在 **模型 → 点击模型名称／编辑 → 服务等级 / Fast 模式** 中设置。支持 OpenAI Responses 和 Chat Completions；每个供应商下的模型独立保存，作为 Lead、Sidekick 或子代理调用时使用同一配置，思考档位保持独立。

| 选项 | 发给供应商的请求字段 |
| --- | --- |
| 跟随供应商（默认） | 不发送 `service_tier`，保留供应商默认行为 |
| 标准（default） | `"service_tier": "default"` |
| Fast（fast） | `"service_tier": "fast"` |
| Fast（priority 兼容值） | `"service_tier": "priority"` |

[OpenAI 官方文档](https://developers.openai.com/api/docs/guides/fast-mode)确认 `fast` 与 `priority` 可请求 Fast 服务。仅支持旧枚举的中转站可选择 `priority`。Fast 通常比标准服务收费更高，必须由供应商和所选模型支持；模型列表不会自动开启 Fast。此功能使用配置的 BYOK 接口及其计费，不会获取 ChatGPT/Codex 订阅权益。

**上下文 → 最近请求** 或 **用量 → 显示全部指标** 显示请求等级和实际等级。实际等级仅使用供应商完成事件的上报值；例如请求 `fast`、实际 `default` 表示供应商报告使用了标准服务，未上报则显示“未上报”。字段透传已经过本机 HTTP 测试，真实供应商的 Fast 权限、加速幅度与账单需要以该供应商为准。

设置从该模型下一次 BYOK 请求生效；已发出的请求保持原参数，网络重试也保持原服务等级。供应商拒绝字段时直接报告错误，不自动改成其它等级；请改用兼容值或恢复默认。切换 Fast 不改变模型／预设标识、思考档位、工具参数、推理状态或缓存标识。Anthropic Messages 不发送该 OpenAI 字段。

## 功能与验证范围

2026-10-11 的核查使用了 Windows 上当前安装的 Devin、合成测试数据和隔离会话。Linux 的自动化测试与打包由 CI 验证；macOS 应用操作仍需在 macOS 上验收。

| 功能 | 入口与当前验证 |
| --- | --- |
| 供应商与模型 | **模型** 页；导入、手动添加、编辑、启停和删除有回归测试；三种协议有本机 HTTP 测试 |
| OpenAI Fast | **模型 → 编辑 → 服务等级 / Fast 模式**；两种 OpenAI API 的配置保存、HTTP 字段、重试和实际等级显示有本机测试；未宣称供应商实际加速 |
| Fusion 预设 | **预设** 页；分配与配置保存有回归测试，当前 Windows Devin 的实际模型选择器校验通过 |
| 上下文与最近请求 | 状态栏 **上下文**；修复 Windows 路径和 SQLite 读取，已用本机真实会话数据库验证请求字段 |
| 请求用量 | **用量** 页；统计耗时与供应商返回的 token，按可靠身份关联会话，无法归属的请求单独保留 |
| Goal（Beta） | 聊天框 `/goal`，或状态栏 **Goal** 查看管理；Windows PowerShell 5/7 报告实测通过，真实 Devin CLI 已完成两轮自动衔接及完成报告 |
| Fast Context（实验性） | **Fast Context** 页配置 MCP；真实官方接口已成功定位临时合成代码并核对文件内容与行号 |
| 自动重试与待办继续 | **设置** 页，默认关闭；断线、限流、取消和防重复输出经过本机故障测试 |
| 模型筛选与默认预设 | **设置** 页；保存、角色筛选、官方模型隐藏及恢复有回归测试 |
| 停用与恢复 | 命令面板 **停用并恢复连接**；设置恢复、卸载路径及保留用户后续修改有回归测试 |
| 更新 | **设置 → 插件更新**；版本、来源和包身份校验有测试，一键安装/应用重启仅支持 macOS |

这些检查分别验证了协议、接口和真实 CLI 流程。Goal 在编辑器界面中的完整交互仍标为 Beta；测试通过也不能保证每个供应商或未来 Devin 版本都兼容。

## 上下文与请求统计

状态栏 **上下文** 显示所选会话的原生主上下文占用，点击可切换会话并查看本轮耗时、子代理上下文和最近一条可归属的已完成 BYOK 请求。

- 主上下文来自 ACP 的 `usage_update`；子代理单独展示。切换模型后等待新用量事件。
- 最近请求通过回复或工具的唯一标识关联。新版 Devin 的工具记录还会存在消息表内，0.3.44 已支持；数据库由内置 Node.js 以只读方式读取，查询在 Worker 中进行。
- 最近请求可能来自同一会话的 Lead、Sidekick 或子代理，不能把它的输入量当成主上下文占用。
- 正在进行的请求尚未生成完成记录。缺少稳定回复/工具标识的纯文本调用，或共享标识无法唯一归属的请求，会留在未归属统计中，不借用其它会话的数据。
- 请求耗时包含供应商等待与重试；首响应、首输出和正文首字是不同指标。网关 TPS 使用输出 token 除以首响应后的总时间；正文 TPS 仅在无工具调用、可确定正文 token 和生成区间时显示。
- 缓存 token 是输入 token 的子集，推理 token 是输出 token 的子集。`0` 是实际零值，`—` 表示未上报、无法确定或该指标不适用。面板会说明最近请求暂无数据的原因。

请求数据约每 5 秒读取一次，会话匹配最多缓存 15 秒。只保留最近 5,000 条本机 BYOK 请求，统计不等同于供应商账单。

## Goal（Beta）

在**已信任的 Devin Local 会话**中输入 `/goal <目标>`。插件必须已启用且原生 ACP 连接正常；远程会话、其它 Harness 或有歧义的连接不受该控制器管理。

| 命令 | 作用 |
| --- | --- |
| `/goal <目标>` | 启动目标；有现有目标时按新目标替换 |
| `/goal` 或 `/goal status` | 查看状态、运行次数和最近证据 |
| `/goal pause` | 暂停并取消插件拥有的活动运行 |
| `/goal resume` | 从空闲会话恢复；达到上限时增加 10 次额度，总上限 100 |
| `/goal clear` | 归档目标并停止自动推进 |

例如：`/goal 修复登录测试，所有相关测试和 lint 通过后提交实际验证结果`。

模型每轮运行插件给出的报告命令，提交 `progress`、`waiting`、`blocked`、`review` 或 `complete`，以及实际证据。`progress` 在本轮结束且会话空闲后继续；`complete` 自动结束并归档；`review` 等待你验收。Goal 面板可查看证据、暂停、恢复、验收和归档。

0.3.44 修正了 Windows 报告命令：使用 PowerShell 与 UTF-8 JSON 编码，支持带空格、单引号和中文的路径；报告被拒绝时命令返回失败。默认最多 10 轮，总上限 100。权限确认、取消、断线、窗口重载、连续两轮无报告或连续三轮证据不变时会停止。你手动输入后，只在相应普通用户轮正常结束时继续；权限和其它阻塞需处理后恢复。

每次目标推进都可能产生模型与工具用量。空闲会话中的查看/控制命令可能产生短模型回复；已有活动轮时由插件显示状态，保持现有运行。Goal 的权限和账号要求与普通会话相同。

## 缓存、代理与重试

使用 Responses 的可识别 GPT-5/6、o 系列模型时，插件请求加密推理状态、保存完整输出顺序，并使用稳定缓存标识。后续请求在历史和供应商范围一致时回传状态；换供应商、地址、密钥、模型或修改历史后失效。缓存命中由服务端决定，旧会话已丢失的状态无法补回。

独立后台读取 Devin 用户设置的 `http.proxy`；`http.proxySupport: "off"` 关闭后台代理，未配置时继承代理环境变量。本机 ACP 与管理请求直连。修改代理后需让后台重新启动，Devin 内置 Node.js 要求 **24.14+**。后台代理支持涵盖推理及官方转发；模型发现和单独运行的 MCP 使用各自宿主的网络环境。

**服务商出错时自动重试**在后台重发原请求：临时网络错误、HTTP 408/429/500/502/503/504，以及明确的临时流错误，最多追加 3 次，约等待 2、4、8 秒并加随机延迟。尊重 `Retry-After`，只在原请求开始后的 60 秒内发起重试。已输出原生响应或用户停止时结束重试；鉴权、余额、参数、格式错误直接失败。失败请求可能仍计费。

**待办没做完时自动继续**针对原生 Plan/Todo：有未完成待办时发送 `continue`，待办没有变化就停止。Goal 拥有的会话由 Goal 控制器推进。旧版供应商“自动继续”开关兼容为后台重试，升级后需要重载窗口。

## Fast Context MCP（实验性）

提供自然语言代码检索，使用官方 Fast Context 服务，返回文件、行号和可核对的片段。它使用 **Devin/Windsurf 官方登录权限及额度**，供应商 BYOK 密钥不用于此服务。

在 **Fast Context** 页选择项目，复制提示词给目标 Harness，或复制配置 JSON 合并进现有 MCP 配置。也可运行 **Fusion BYOK：Fast Context MCP 接入配置**。生成的命令和路径随安装位置变化，升级后需重新复制。插件只生成配置，目标 Harness 负责加载和停止 MCP。

需要独立 **Node.js 22.16+（推荐 24 LTS）** 和 **ripgrep**。Windows/Linux 请确保 `node`、`rg` 在 PATH 中；macOS 还支持查找 Devin 自带的 ripgrep。可以用 `FUSION_FAST_CONTEXT_RG` 指定 `rg` 的绝对路径。

服务提供 `fast_context_search` 与 `fast_context_status`。启动时通过 `--root <项目绝对路径>` 限定目录，可用 `--exclude <pattern>` 排除目录；搜索只读，每次总时限 120 秒，一个进程同一时间接受一次搜索，支持取消。默认最多 3,000 个文件、8 MiB 文本、每文件 512 KiB、20 万行，达到限制会返回 `partial`。

问题、目录信息和选中的代码片段会发送到官方服务。默认遵守 ignore，排除常见凭证、依赖、构建目录、软链接及硬链接；项目仍需由你选择和排除敏感内容。凭证读取本机登录记录，也可由 `WINDSURF_API_KEY` 环境变量提供，生成配置不包含密钥。账号、网络或内部接口不可用时明确报错。

## 常见故障

| 现象 | 应检查的内容 |
| --- | --- |
| 获取模型列表失败 | 弹窗预览的 `/models` 路径、对应协议的鉴权与宿主联网；不提供列表时手动添加模型 |
| HTTP 200 但响应类型错误 | 地址返回了网站 HTML 或其它非流式数据；核对 API 前缀和协议，尤其是需要手动填写 `/v1` 的 Anthropic 网关 |
| `Could not connect to the provider` | 推理地址、代理、DNS 与供应商连接；开启有限重试后仍失败需检查实际连接 |
| `Provider reported a failed response` | 供应商错误、鉴权、额度、模型及请求参数；自动重试仅处理明确的临时故障 |
| `Provider response could not be completed` | 流未正常结束、格式不兼容或超时；已有输出时不会重发，以免重复工具执行 |
| Remote ACP / 获取团队设置失败 | 先检查官方登录、团队权限和后台到官方服务的网络连接，BYOK 不能替代这些要求 |
| 上下文字段一直为空 | 确认已重载新版本、选中了正确会话，并让新请求正常结束；查看面板给出的可用性说明 |
| `/goal` 未生效 | 确认 Local 会话、工作区信任、插件已启用且升级后已重载；通过 Goal 面板查看状态及阻塞原因 |

命令 **Fusion BYOK：查看状态** 可打开输出日志。依赖 Devin 内部接口，应用更新后可能需要适配。图片支持和自动生成的思考档位是配置声明，实际能力需要供应商支持。

## 本机数据与停用

供应商密钥保存在本机用户配置，面板不回显已保存的密钥。Unix 文件按 0600 创建；Windows 使用所在用户目录的访问控制，配置并非系统凭证保险库。请求统计保留模型、用量、耗时与关联标识；日志不记录提示词、供应商错误原文或 API Key。Goal 目标与证据保存在本机状态目录。

模型发现与推理拒绝 HTTP 重定向。更新检查访问本仓库 GitHub Releases；自动安装前需要确认，并校验大小、SHA-256 和扩展身份。

卸载前运行 **Fusion BYOK：停用并恢复连接**。插件撤回注入并恢复自己修改过的设置，保留你后来改过的值。已开始的会话沿用原设置，停用后请新建对话。单独运行的 Fast Context MCP 请在相应 Harness 中关闭或移除。

## 开发与验收

使用 Node.js **24.14+**，安装 `rg`；无需 npm 依赖或系统 SQLite CLI。Windows 用 PowerShell `Compress-Archive` 打包，macOS/Linux 需要 `zip`。

```sh
npm test
npm run package
npm run mcp:fast-context -- --root /absolute/project
```

测试默认使用合成数据与本机 HTTP/代理服务。GitHub Actions 在 Windows/Linux 上运行测试和打包；平台限定的 macOS 重启测试按条件跳过。

在有 Devin 的机器上设置 `BYOK_TEST_DEVIN_APP_ROOT` 为 **包含 package.json、extensions、out 的 resources/app 绝对目录**，再运行 `npm test`，即可额外校验实际模型选择器和 ACP 解析器。例如 Windows 使用 `$env:BYOK_TEST_DEVIN_APP_ROOT = 'C:/path/to/Devin/resources/app'`；该检查只读应用文件。

Fast Context 真实验收可通过 `FUSION_FAST_CONTEXT_LIVE=1 node scripts/fast-context-smoke.cjs` 启用，Windows 先设置 `$env:FUSION_FAST_CONTEXT_LIVE = '1'`。此检查只发送临时合成代码，可能消耗官方额度。

实现契约见 [docs](https://github.com/Saito-Sakuya/devin-fusion-byok/tree/main/docs)。VSIX 只包含源码、说明与许可证，不打包测试、用户配置、数据库或运行记录。问题请提交到 [本 Fork Issues](https://github.com/Saito-Sakuya/devin-fusion-byok/issues)。

## 许可

[MIT](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
