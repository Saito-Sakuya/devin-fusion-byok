# Devin Fusion BYOK

这是 [kuobibulaien/devin-fusion-byok](https://github.com/kuobibulaien/devin-fusion-byok) 的独立维护 Fork，基于上游 `v0.3.42`，本分支版本为 `0.3.43`。原项目及第三方组件的版权声明和 MIT 许可证均保留。

本 Fork 增加 Anthropic 自定义地址与模型导入修复、OpenAI 可选工具参数兼容、Responses 推理状态与缓存标识、独立后台代理支持、错误分类和有上限的自动重试。更新检查仅使用 [本 Fork 的 Releases](https://github.com/Saito-Sakuya/devin-fusion-byok/releases)，不会用上游包替换这些修改。

一个 Devin 用户扩展：把你自己的模型 API（BYOK）接入 Devin 原生模型列表，并把两个模型组合成 Fusion 预设（Lead + Sidekick）使用。

- 不修改 Devin 应用本体，不需要重新签名，也不安装证书或改系统代理。
- 支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 三种接口。
- 第三方模型可以单独用，也可以和其他第三方模型或官方模型组合成 Fusion 预设。

## 安装

1. 从 [本 Fork 的 Releases](https://github.com/Saito-Sakuya/devin-fusion-byok/releases) 下载 `devin-fusion-byok-<版本>.vsix`，或按下方开发说明自行打包。
2. 在 Devin 命令面板运行 **Extensions: Install from VSIX…** 选择该文件，或在终端执行：

   ```bash
   /Applications/Devin.app/Contents/Resources/app/bin/devin-desktop --install-extension devin-fusion-byok-<版本>.vsix
   ```

3. 重载窗口（**Developer: Reload Window**）或新开一个 Devin 窗口。

之后可以在面板 **设置 → 插件更新** 里检查并一键安装新版本（目前仅 macOS）。

## 快速开始

点击右下角状态栏 **Fusion BYOK**，或在命令面板运行 **Fusion BYOK：控制面板**。

1. **模型** 页：添加供应商，填写名称、API 地址、密钥，选择接口类型。
   Anthropic Messages 按填写的路径使用，不会自动补 `/v1`；需要 `/v1` 时请手动填写。OpenAI 接口在地址中没有版本号时会自动补 `/v1`。弹窗会显示实际请求地址。
2. 点 **导入模型**，勾选需要的模型后点 **导入**。
3. **预设** 页：点 **新建预设**，选择 Lead 和 Sidekick 模型及思考档位，保存。
4. 在 Devin 原生模型列表的 **我的 Fusion** 分组里选择预设。

保存后如果模型列表有变化，插件会自动新开一个对话让新列表生效（Devin 3.10 起只在新对话时刷新模型列表）。列表仍没更新时，可以点面板右上角的 **重启 Devin**。

## 功能

| 标签页 | 内容 |
| --- | --- |
| 预设 | 管理多个 Fusion 预设，设为默认、编辑、删除 |
| 模型 | 管理供应商和模型：启停、改显示名、上下文长度、思考档位 |
| 用量 | 本机请求统计：首字时间、输出速度、token 用量 |
| Goal（Beta） | `/goal` 命令的使用说明 |
| 设置 | 自动重试、待办自动继续、预设可选模型、隐藏官方模型、插件更新 |

一些默认行为：

- 新模型默认上下文 272,000 tokens、最大输出 131,072 tokens，可逐个修改。
- GPT-5/6、o 系列、Claude Opus/Sonnet/Fable 4.6+ 自动提供 Low～Max 思考档位；实际是否生效取决于供应商。
- GPT-5/6 和 o 系列使用 Responses 时，会请求加密推理状态，并通过 Devin 原生签名字段保存完整输出，下一轮按原顺序回传，保留推理、输出标识和消息阶段。使用稳定的缓存标识兼容供应商的缓存路由；缓存命中仍取决于接口实际支持和返回的用量。
- 切换供应商、地址、密钥或模型，或修改历史内容时，过期的推理状态会自动失效。旧会话里已经丢失的推理状态无法补回，更新后建议新建会话。
- 请求失败时会分别提示供应商主动报错、连接中断、响应未完整结束和超时；后台日志保留错误类型、阶段与已接收字节数，不记录上游错误原文、提示词或密钥。
- 设置页的 **服务商出错时自动重试** 控制 BYOK 后台重发原请求。临时连接错误、HTTP 408/429/500/502/503/504 和明确的临时流错误，最多追加 3 次重试，间隔约 2、4、8 秒并加入少量随机延迟；重试只在请求开始后的 60 秒内发起，并尊重供应商的 `Retry-After`。鉴权、余额、参数和格式错误不会重试。已输出文字、思考或其他原生响应后不重发，避免重复内容和工具执行；点击停止会取消等待及请求。重试可能产生额外用量。这个开关不再通过会话发送 `continue`。
- 独立后台启动时会读取 Devin 用户设置中的 `http.proxy`，让模型请求与官方转发按该代理联网；`http.proxySupport: "off"` 关闭后台代理。未设置编辑器代理时继承代理环境变量，本机 ACP 与管理接口始终直连。修改代理设置后需重启后台才能生效；此支持需要 Devin 内置 Node.js 24.14+。
- 选中的预设会被记住：Devin 把选择重置为官方 Fusion 时会自动恢复。
- 状态栏的 **上下文** 入口可以查看所选会话的上下文占用和最近请求的速度。

## Goal（Beta）

在 Devin 聊天框直接输入命令，让模型围绕一个目标一轮轮自动工作，直到它提交带证据的完成报告。

| 命令 | 作用 |
| --- | --- |
| `/goal <目标>` | 在当前对话启动目标，已有目标时替换 |
| `/goal` | 查看目标、状态、已运行轮数和最近进展 |
| `/goal pause` | 暂停 |
| `/goal resume` | 继续；到上限时再追加 10 轮 |
| `/goal clear` | 清除目标 |

- 把“怎样算做完”写进目标，例如：`/goal 让 test/auth 里的测试全部通过，并保持 lint 干净`。
- 模型每轮通过专用报告命令提交进展；报告“完成”并附证据后目标自动结束。只在回复里说“做完了”不算。
- 默认最多 10 轮，总共最多 100 轮。遇到权限确认、取消、连续两轮没有报告、连续三轮没有进展或窗口重载时会停下。
- 你中途插话后，等你这一轮结束，目标会自动继续。
- 每一轮都是正常计费的模型调用；空闲时查看和控制命令也会产生一次很短的回复。运行中查询状态直接由插件显示，不新增模型调用，也不打断原任务。

测试版：已用模拟连接做自动化测试，尚未在真实 Devin 窗口完成端到端验收，欢迎反馈。

## Fast Context MCP（实验性）

把自然语言代码检索提供给其他支持 MCP 的 Harness：输入问题，返回相关文件、行号及代码片段。复用 Devin/Windsurf 的 Fast Context 检索接口，**不是普通关键词搜索，也不是另开一轮通用助手对话**。

打开 **Fusion BYOK 控制面板 → Fast Context** 标签页，选择允许搜索的项目，点 **复制提示词** 发给目标 Harness 里的 Agent，它会按提示词把 `fusion-fast-context` 合并进自己的 MCP 配置并验证；也可以 **复制配置 JSON** 手动合并，或在命令面板运行 **Fusion BYOK：Fast Context MCP 接入配置**。不要覆盖其他服务。插件升级后需重新复制，以更新安装路径。

也可以直接使用源码入口：

```json
{
  "mcpServers": {
    "fusion-fast-context": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/devin-fusion-byok/src/fast-context/server.cjs",
        "--root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

- 需要 **Node.js 22.16+（推荐 24 LTS）** 和 ripgrep；自动查找 PATH 或 macOS Devin 自带的 ripgrep，也可通过 `FUSION_FAST_CONTEXT_RG` 指定其绝对路径。不依赖正在运行的 Devin 窗口。
- 提供 `fast_context_search`（`query`、`max_turns` 1–5、`max_results` 1–20、`include_content`）与 `fast_context_status`。默认最多三轮搜索、另一次最终答案请求；遇到模型格式错误，最多追加一次纠正请求，不猜测执行。每次搜索总时限 120 秒，同一 MCP 进程只接受一次搜索，支持取消。
- 使用本机 Devin 桌面的已有登录记录；也可由环境变量 `WINDSURF_API_KEY` 提供凭证。不把密钥写入生成的配置，不提供提取密钥工具。**使用官方账号权限及额度，不走 BYOK 供应商**；账号或团队禁用时直接报错。
- 问题、目录信息和选中的代码片段会发往官方服务。只搜索启动时指定的项目；可追加 `--exclude pattern`。默认遵守 ignore 规则，并排除常见凭证文件、依赖、构建产物、软链接和硬链接。**这不是秘密识别器**：不要选择包含敏感内容的项目，额外排除私有目录。
- 仅在内存中创建只读快照，不运行模型给出的 shell 命令，不写入项目。默认检查最多 3,000 个候选文件、8 MiB 文本、每文件 512 KiB、20 万行；被限制的结果明确标记 `partial`。读取失败、二进制等跳过数量另列。大仓库应选择更小的项目根目录。
- 检索是尽力而为，不保证找全；返回前核对文件内容与行号，修改代码前仍需自行复查。服务内部接口变化可能导致不兼容，错误不会伪装成“没找到”。

配置命令只打开一份未保存的 JSON，面板只把提示词或配置复制到剪贴板，插件本身不自动注册其他 Harness、不重启应用、不启动后台监听端口。单独运行的 MCP 由目标 Harness 管理，停用 VS Code 插件不会结束它；停用 MCP 请在目标 Harness 中移除或关闭该服务。

## 自动重试与待办继续（默认关闭）

在 **设置** 页可分别开启：

- **服务商出错时自动重试**：临时连接错误、408/429/500/502/503/504 和明确的临时流错误会在后台重发原请求，最多追加 3 次，间隔约 2、4、8 秒并尊重 `Retry-After`；一旦已有输出或用户停止就不再重发。鉴权、余额、参数和格式错误直接报错。
- **待办没做完时自动继续**：会话里还有未完成的 Plan/Todo 时自动发送 `continue`；待办没有变化就停止，避免空转。

重试和继续都可能产生额外用量。重试的次数和发起时间有固定上限，无法修复无效配置或持续的上游故障。旧版“服务商出错时自动继续”设置会兼容为后台重试，升级后重载窗口可显示新的设置说明。

## 隐私与安全

- 密钥只保存在本机用户配置文件（权限 0600），面板不回显已保存的密钥。
- 模型发现和推理请求拒绝 HTTP 重定向，避免密钥和对话被转发到其它地址；请填写供应商的最终 API 地址。
- 日志只记录模型名、工具名和连接状态，不记录对话正文和密钥。
- 插件通过 `WINDSURF_API_SERVER_URL` 让 Devin CLI 连接本机服务；官方请求仍经正常 HTTPS 发往官方接口。
- 不会解锁账号本来没有的官方模型或权限。
- 更新检查只访问本仓库的 GitHub Releases，安装前校验文件大小、SHA-256 和包内身份，并需要你确认。

## 停用与卸载

先在命令面板运行 **Fusion BYOK：停用并恢复连接**，再卸载扩展。这会撤回模型注入，并把插件写过的 Devin 设置恢复原样（你之后自己改过的不动）。已开始的对话沿用原来的设置，停用后请新建对话。

## 已知限制

- OpenAI 工具调用会显式传递 Devin 工具定义的 `strict` 设置（默认 `false`），保留可选参数，避免 Responses 自动将它们改成必填项。
- 依赖 Devin 当前的内部接口，Devin 大版本更新后可能需要插件跟进。
- 图片输入对所有导入模型都声明为支持，实际能否处理取决于模型。
- 思考档位按模型 ID 规则提供，不是对供应商能力的检测。
- 一键更新和“重启 Devin”目前仅支持 macOS。

## 开发

使用 Node.js **24.14+**；代码无需安装 npm 依赖。`npm run package` 支持 Windows（内置 PowerShell `Compress-Archive`）及安装了 `zip` 的 macOS/Linux。生成的包只包含插件源码、说明和许可证，不包含测试、用户配置或运行记录。

```bash
npm test          # 运行测试
npm run package   # 生成 VSIX
npm run mcp:fast-context -- --root /absolute/project
```

Fast Context 真实接口验收（仅发送临时合成代码，可能消耗额度）：`FUSION_FAST_CONTEXT_LIVE=1 node scripts/fast-context-smoke.cjs`。

测试默认使用合成数据及本机 HTTP/代理服务；平台不支持的 macOS 重启、Unix 权限及系统 SQLite CLI 检查按条件处理。需要正在运行的 Devin 或显式启用真实接口的测试会标记为跳过。实现约束见 [docs](docs)。

## 交流

原作者活跃于 [LINUX DO · @koubibulaien](https://linux.do/u/koubibulaien)。本 Fork 的问题请提交到 [Issues](https://github.com/Saito-Sakuya/devin-fusion-byok/issues)。

## 许可

[MIT](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
