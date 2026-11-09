# @99percentpeople/pi-codex-api

在 Pi 中使用 ChatGPT 订阅进行多语言文字与视觉委托、图片生成与编辑、搜索、Fast 模式和额度查看，**不需要 OpenAI API key**。

[English](README.md)

> **Pi 1.5 适配要点：**`codex_ask` 支持新版 `openai` ChatGPT OAuth。
> 搜索、图片、额度和重置卡仍需要**独立的 `openai-codex` legacy OAuth 登录**。
> 两种登录面向不同服务，不能直接混用 token。

## 功能概览

| 工具或命令 | 功能 |
| --- | --- |
| `codex_ask` | 显式请求 Codex 第二意见、翻译、改写、分析，或查看工作区/最近对话图片 |
| `codex_image` | 生成或编辑图片，保存为不覆盖已有文件的 PNG |
| `codex_search` | 网页/图片搜索、页面导航、PDF 截图，以及金融、天气、体育和时间查询 |
| `/codex-usage` | 查看 legacy Codex 套餐、脱敏账户、额度与重置卡 |
| `/codex-redeem` | 选择并确认兑换可用的 legacy Codex 额度重置卡 |

`/99settings` 的 **Codex API → Tools** 可分别开关 Search、Image 和 Ask Codex。
关闭的工具立即从当前模型提示中移除；已经排队的调用也会在发出请求前检查开关。

## 安装与登录

```bash
pi install npm:@99percentpeople/pi-codex-api
```

推荐使用 **Pi 1.5.0** 或兼容的更新版本，本次回归基于 1.5.0 SDK。
Pi 从 0.99.0 开始提供新版 `openai` ChatGPT OAuth；旧委托路径仍保留
Pi 0.84.1 的最低要求。peer 范围保留旧路径兼容性，不代表旧 Pi 能使用新版登录。

| 功能 | 需要的登录 | 请求目标 |
| --- | --- | --- |
| 新版文字/视觉委托 | `/login openai` → **Sign in with ChatGPT** | 经 Pi 调用 `api.openai.com/v1` Responses API |
| 旧版文字/视觉委托 | `/login openai-codex` | 经 Pi 调用 ChatGPT Codex 后端 |
| 搜索、图片、额度、重置卡 | `/login openai-codex` | `chatgpt.com/backend-api` |

新版 Pi 将 `openai-codex` 标为 **OpenAI Codex (legacy)**。
`openai` 下填写 API key 不等于 ChatGPT 订阅登录。功能是否开放仍取决于账户与工作区权限。

### 只需要文字/视觉委托

1. `/login openai`，选择 **Sign in with ChatGPT**。
2. `/model` 选择一个 `openai` 模型。
3. 明确要求“请问 Codex”“让 Codex 给第二意见”，或将具体翻译、改写、分析任务委托给 Codex。

如果当前仍使用 DeepSeek、Google、Claude 或 API-key 模型，在 `/99settings` 中开启
**Other providers**。同时将 OpenAI 模型保存为 Pi 默认模型，或在调用中指定
`openai/<model-id>`；不要猜测模型 ID。

### 还需要搜索、图片或额度

另外执行 `/login openai-codex`，登录 legacy provider。只有新版 `openai` OAuth 时：

- `codex_ask` 可使用新版路径；
- legacy 额度状态和命令不显示；
- 搜索和图片工具给出缺少 legacy 登录的明确提示，不会拿新版 token 尝试旧端点；
- 不会自动切换为付费 API-key 请求。

当前模型属于任一种支持的订阅登录时，不需要开启 Other providers。
从其他模型调用时，该设置只放开“当前模型”限制，不会替代各功能自己的 OAuth 要求。

## Ask Codex

`codex_ask` 是显式委托工具，不应因“Codex 可用”就自动调用，也不应递归委托日常工作。
每次请求独立，不自动复制 Pi 的对话或工作区；`prompt` 必须包含必要上下文、目标语言和输出格式。

可选参数：

- **model**：Pi 模型列表中的精确 OAuth 模型 ID。可写为 `openai/<id>` 或
  `openai-codex/<id>`，避免两个 provider 同名模型的歧义。
- **reasoning**：仅在用户要求时指定；支持情况以所选模型为准。
- **verbosity**：`auto`、`low`、`medium`、`high`，可覆盖全局 Answer detail。
- **image_paths**：最多五张工作区 PNG、JPEG、WebP 或 GIF。
- **num_last_images_to_include**：使用最近对话中的图片，不能与 `image_paths` 同时提供。
- **max_output_tokens**：请求的输出上限，默认 8,192。**这不是保证**：Pi 会省略
  ChatGPT sign-in 不支持的字段，后端可能不接受或不执行该上限。

### 默认模型如何选择

- 当前是新版 `openai` ChatGPT OAuth 模型：直接沿用当前模型，不请求旧版模型目录。
- 当前是其他 provider，且 Pi 保存了 `defaultProvider: "openai"`：使用对应的
  `defaultModel`，前提是模型可用且确实配置了 OAuth。
- 只有新版 OAuth、没有保存 OpenAI 默认模型：提示选择或显式指定，不任意挑选模型。
- 选择 legacy 路径且省略 `model`：保留旧行为，从 live Codex 目录解析官方默认模型。
- 显式指定的模型不可用：报错，不悄悄换 provider。未指定模型、没有 OpenAI 默认值
  但有 legacy 登录时，仍可沿用旧版目录默认行为。

文字调用复用 Pi 的认证与模型完成 API，使用新的 routing session，并禁用 prompt-cache retention。
工具结果记录嵌套 LLM token usage，但这不是额度快照，也不意味着使用了 API-key 计费。
SSH Remote 激活时，工作区视觉输入经远端二进制文件适配器读取。

## 搜索与引用

`codex_search` 将网页/图片搜索结果渲染为来源卡片，将页面和结构化查询分别整理显示。

- 先搜索，再打开返回的 reference ID；直接 URL 可能被后端安全检查拒绝。
- 页面导航每批最多三页。`response_length` 和 `open.lineno` 不保证缩短完整页面正文。
- 天气暂时无数据时只重试一次，再转网页搜索。
- 加密货币使用 `BTC`、`ETH`，不要写 `BTC-USD`。
- NHL standings 不由结构化体育接口提供，应搜索 NHL 官网。
- `finance.market` 只是提示，不能保证解析国际交易所代码。
- 普通搜索输出最多 2,000 行或 50 KB；结构化查询会先压缩，缺失的批量结果会有提示。

Pi 提供 `registerMarkdownTransformer` 时，回复中的 Codex 引用可渲染为带域名的链接。
来源只采纳当前会话分支的 `codex_search` 结果；未知或冲突引用保留 reference ID，不编造 URL。
这只是 Markdown 显示转换，不修改历史、模型上下文、用户消息或代码块；不覆盖 Telegram/Feishu
等外部渲染器。旧 Pi 没有相应 hook 时保留原始显示。

## 图片生成与编辑

图片模型在 `/99settings → Codex API → Image model` 中选择：

- `gpt-image-2.5-flare`：默认。
- `gpt-image-2.5-sunburst`。
- `gpt-image-2`：兼容选项。

两个新模型 ID 的请求拼装都有 mock 覆盖。**2026-11-09** 的 legacy OAuth 真实冒烟测试
已成功生成一张 `gpt-image-2.5-sunburst` PNG；Flare 和图片编辑仍未实测。
可用性取决于账户与后端 rollout；新模型被拒绝时可手动选择 `gpt-image-2`。
不会自动换模型重试，避免重复生成或消耗额度。
保留现有尺寸约束、最多五张参考图，以及 `auto` / `low` / `medium` / `high` quality 选项；
不假设公开 Images API 的所有参数都适用于订阅后端。

编辑可使用本地工作区图片或最近对话图片，两种引用方式不能混用。每次保存使用新路径，不覆盖已有资源。
SSH Remote 激活时，`output_path` 和 `referenced_paths` 直接通过远端二进制文件接口读写，
不创建本地暂存图片。随包提供的 `gpt-image-prompts` skill 可通过
`/skill:gpt-image-prompts` 加载。

## 额度与重置卡

这些功能始终是 **legacy Codex** 的额度视图，不能视为新版公开 Responses API 的额度接口。
仅有新版 `openai` OAuth 时，命令和状态栏保持隐藏。

- `/codex-usage` 刷新套餐、脱敏账户、窗口剩余额度、重置时间及可用重置卡。
- `/codex-redeem` 多卡时先选择，单卡时直接进入确认；默认选项为 **No**。
- 兑换使用幂等标识，网络失败后的重试不会再次消耗另一张卡。
- 没有对话框 UI 时使用两步确认。
- 命令在确认 legacy OAuth 后注册。Pi 暂无命令注销 API；同一会话登出后，使用
  `/reload` 或新会话移除先前注册的命令，旧命令执行时仍会重新检查认证。

## 设置

配置保存在 `~/.pi/agent/99extensions.json` 的 `codex-api` 命名空间。

| 设置 | 行为 |
| --- | --- |
| Tools | Search、Image、Ask Codex 独立开关，默认都开启 |
| Fast mode | 默认关闭；向两种订阅文字路径请求 `service_tier: "priority"`，是否支持由模型/账户决定 |
| Answer detail | 默认跟随 provider；可选 Low、Medium、High，作用于普通订阅回复和委托调用 |
| Usage monitor | 默认开启，只管理 legacy Codex 后台额度状态；关闭不影响已注册的手动命令 |
| Other providers | 默认 **ChatGPT only**；选 Allow 才能从非订阅当前模型调用，仍需相应 OAuth |
| Search mode | Auto、Cached、Indexed、Live；固定模式优先于逐次请求的模式 |
| Search context | 搜索上下文大小，默认 Medium |
| Image model | 默认 `gpt-image-2.5-flare`，下一次调用生效 |
| Image quality | 默认 Auto |
| Usage poll | legacy 额度轮询间隔，默认五分钟，0 关闭轮询 |

Fast/detail hooks 不修改普通 API-key 或第三方 provider 请求。正常新版 OpenAI 回复不会启动
legacy 额度刷新，也不会将其响应头当成旧 Codex 额度。已配置 legacy 登录且开启监控时，
会话生命周期和轮询仍可独立更新 legacy 状态。

## 安全与验证范围

- 新旧凭据按服务隔离，不写入设置或工具结果。
- 委托完成前重新检查 OAuth；新版 HTTP 发送前额外拒绝实际的 `sk-` API key，
  即使模型注册表的 OAuth 快照因认证文件变化而过时，也不会静默走付费 API。
- legacy 后端只向精确的 HTTPS `chatgpt.com` origin 发送认证，不允许 URL 用户名/密码或重定向。
- nullable 可选请求头中的 `null` 按删除处理，不发送字面字符串 `"null"`；必需的认证头始终由所选 legacy 凭据重新构造。
- 回归覆盖新旧 OAuth、仅 API key、跨 provider、默认模型、Fast/detail、额度隔离、
  headers 和视觉输入；还使用真实 Pi 1.5 ModelRegistry 与 Responses 传输层，HTTP 全部 mock。
- **2026-11-09 真实冒烟测试通过：**使用已有 legacy OAuth 完成文字委托、视觉识别、网页搜索与
  打开返回引用、结构化时间查询、WHAM 额度和重置卡只读查询，以及一次 `gpt-image-2.5-sunburst`
  PNG 生成；已检查 PNG 签名和尺寸，视觉调用正确识别了生成图片的内容。
- 已用真实注册表确认普通 OpenAI API-key 认证在订阅委托前被拒绝，没有发出付费 API 测试请求。
- 新版 `openai` ChatGPT OAuth 因缺少该登录，仍只有 mock 覆盖；Flare、图片编辑、其他搜索查询族、
  priority tier 和重置卡兑换没有在本轮实测。未更改登录或设置，也未消耗重置卡。
  实测结果仅代表当次账户能力，不保证所有账户均可用。

## 开发与打包

```bash
bun install
bun run lint
node --import tsx --test tests/codex-api.test.ts tests/codex-api-oauth.test.ts
bun run check:privacy
bun run check
bun run pack:codex-api
pi -e ./extensions/codex-api/index.ts
```

开发 SDK 固定为 Pi 1.5.0；Pi/runtime 包仍作为 external，由宿主提供。
构建产物位于仓库根目录 `dist/codex-api/`，包含 minified 入口、linked source map、
中英文 README、LICENSE 和图片提示 skill。`pack:codex-api` 仅 dry-run，不发布。
