# @99percentpeople/pi-deepseek-anchor

[English](README.md) | **简体中文**

面向 [Pi coding agent] 的实验性 DeepSeek V4 Pro 请求锚定扩展。

DeepSeek Anchor 用于在 Pi 中模拟 DeepSeek Harness（DSH）minimal 模式的模型可见首次请求。它的目标是让 V4 Pro 从一开始进入更有效、与训练接口对齐的工具使用轨迹，从而改善 agent 的任务表现，而不只是让模型显示可见 reasoning。

扩展会让新会话先使用精简工具脚手架启动；bootstrap 工具批次结束后，恢复 Pi 的完整工具目录，同时继续将 profile 的完整 system prompt 作为会话级锚点。默认 `pi-native` 是兼容性更好的近似方案；`exact-dsh` 会更严格地复现 DSH bootstrap prompt 和 schema。实际效果仍取决于任务和运行环境，扩展不能保证性能提升或选择服务端路由。

## 原理

Project2 V4.1b 的 harness 分析显示，DeepSeek V4 Pro 对首次请求中的 system prompt 和工具 schema 较为敏感。DeepSeek Harness（DSH）官方 minimal preset 将一句 system prompt、持久化 `bash` 和 `str_replace_editor` schema 称为“exact RL prompt and schemas”。另一组 `anchored-standard` 实验保留 minimal 的完整 system prompt，在首次工具调用后恢复更大的工具目录，并延续了更强的任务轨迹。

DeepSeek Anchor 在 Pi 中应用这一客户端诱导方式：让首次请求对齐 DSH minimal 模式，形成初始工具策略，然后在不丢失完整 prompt anchor 的前提下恢复更丰富的 Pi 工具目录。它只改变请求结构，不会修改模型权重、保证隐藏推理、选择服务端路由或保证任务结果。

参考资料：

- [DeepSeek V4 Pro harness 分析]
- [审计提交中的 DSH minimal preset]
- [DSH minimal 请求快照]

## Profiles

### `pi-native`（默认）

执行时使用 Pi 的原生工具：

- 每个符合条件的请求都使用固定或用户配置的一句完整 system prompt；
- bootstrap 阶段默认使用 `bash` 和 `edit`，并保留 Pi 原有 schema；
- bootstrap 工具批次完成后，恢复启动前的完整活动工具集。

此 profile 不会注册 DSH Bash wrapper，因此 Pi 自身的 `bash` 工具完全不被改动，包括用户配置的 `shellPath` 和 `shellCommandPrefix`。它不使用 DSH 持久化 shell，Windows 上仍由 PowerShell Adapter 管理 Bash。它是可互操作的近似方案，而不是 DSH schema 契约。

### `exact-dsh`

更严格地复现模型可见的 DSH bootstrap 契约：

- 会话中的完整 system prompt 固定为 `You are a helpful software engineer assistant.`；
- bootstrap payload 只包含 `bash` 和 `str_replace_editor`；
- 使用 DSH 兼容的工具名称、描述、JSON schema 和编辑器输出；
- bootstrap 期间使用会话级持久化本地 Bash；
- 恢复 Pi 普通工具目录时移除兼容编辑器。

Bash 兼容 wrapper 只会在启用此 profile 后注册。在 exact bootstrap 之外，它会委托给当前 SSH Bash 后端，或使用宿主的 `shellPath` / `shellCommandPrefix` 配置重建 Pi 的普通本地 Bash，因此普通 Bash 调用仍保持 Pi 原有行为。如果其他扩展占用了 `bash` 或 `str_replace_editor` 工具名，扩展会拒绝激活，而不是对外宣称 DSH schema 却执行其他实现。

`exact-dsh` 仅支持 POSIX。它的 bootstrap 直接操作本地文件系统；如果其他扩展把 Bash 委托给远程或不可用环境，扩展会拒绝激活。离开 exact bootstrap 后，wrapper 会跟随当前 SSH Bash 委托，否则退回 Pi 的普通本地 Bash。Windows 上仍由 PowerShell Adapter 管理 Bash，只能使用 `pi-native`。

该 profile 在 bootstrap prompt/schema 边界上保持精确，并在之后继续保持同一个完整 prompt，但它并不是 DSH runtime 的完整复制。扩展不会复制 DSH 服务端路由、关闭 Pi 自动压缩、强制实现 DSH 的网络或软件包镜像描述，也不会增加文件系统 sandbox。持久化 shell 和绝对路径编辑器拥有与 Pi 进程相同的操作系统权限。

设置修改后立即生效，无需 reload。会话 gate 与 profile 绑定；如果对已有消息的会话切换 profile，请使用 `/new`。

## 生命周期

默认 Anchored 模式的生命周期如下：

1. 要求当前 provider/model 与配置匹配，并且对话是新会话。
2. 在活动 session branch 中记录与 profile/model 绑定的 gate。
3. 首次 agent run 前保存当前活动工具集，只暴露该 profile 的 bootstrap 工具。
4. 将 provider payload 规范化为一条完整 profile system instruction 和选定的 bootstrap 工具目录。
5. 同一工具批次中的并列调用始终看到相同目录。
6. 在 `turn_end` 恢复保存的工具，确保 Pi 准备下一次请求前已经获得完整目录。
7. 后续每次 provider 请求继续使用同一条完整 system instruction，同时保留已恢复的工具目录。
8. 持久化 anchored phase，使 `/reload` 和 resume 能恢复完整目录，而不会丢失 system anchor 或重复 bootstrap 限制。

如果第一次响应没有调用工具，会话会继续停留在 bootstrap，直到之后的 bootstrap 响应产生工具调用。模型不匹配、关闭扩展、更换会话、reload 或 shutdown 时，工具限制都会被安全恢复。

工具 staging 固定为会话作用域：每个会话只在 bootstrap → anchored 时切换一次，
因此完整 system prompt 和展开后的工具目录在后续请求中保持稳定。

## Thinking level

参考运行使用 `max` thinking。DeepSeek Anchor 不会自动修改用户选择的 thinking level。符合条件的会话如果没有使用 `max`，扩展只会警告一次。

## 安装

```bash
pi install npm:@99percentpeople/pi-deepseek-anchor
```

源码开发：

```bash
pi -e ./extensions/deepseek-anchor/index.ts
```

安装后使用目标模型开始新会话：

```text
/model deepseek/deepseek-v4-pro
/new
```

## 设置

DeepSeek Anchor 不注册私有 slash command。请打开共享设置菜单：

```text
/99settings
```

选择 **DeepSeek Anchor**。下表说明每个选项的作用、可选值以及它会影响哪些相关选项：

| 设置 | 作用 | 可选值 | 默认值 | 显示条件 |
| --- | --- | --- | --- | --- |
| Profile | 选择首个请求使用的 bootstrap 契约与整个会话的 system anchor | Pi native、Exact DSH | Pi native | 始终显示 |
| Mode | 控制何时启用 bootstrap 工具目录，以及是否修改 provider 请求 | Anchored、Minimal、Off | Anchored | 始终显示 |
| Bootstrap tools | 决定 `pi-native` 首个请求暴露哪些 Pi 工具 | bash + edit、bash + read | bash + edit | 仅 Pi native |

### Profile

- **Pi native**：兼容性更强的近似方案。bootstrap 请求使用 Pi 自身的 `bash`
  和 `edit`（或自定义工具）schema，并把 `nativeSystemPrompt` 作为整个会话的
  system anchor。它不会注册 DSH Bash wrapper，也不会使用 DSH 持久化 shell。
- **Exact DSH**：更严格地复现 DSH minimal preset。system prompt 固定为
  `You are a helpful software engineer assistant.`，使用 DSH 的
  `bash` + `str_replace_editor` schema 和编辑器输出，bootstrap 期间运行会话级
  持久化本地 Bash。需要 POSIX 主机和本地 Bash 后端；存在 SSH Bash 委托时
  该 profile 会拒绝激活。

相关选项：`Bootstrap tools` 只影响 Pi native；Exact DSH 的 prompt 和
bootstrap 工具不可修改。会话 gate 与 profile 绑定，因此在已有消息的会话中
切换 Profile 需要 `/new` 才能让新 profile 生效。

### Mode

- **Anchored**（默认）：会话开始时使用 profile 的精简 bootstrap 工具目录，
  整个会话保持完整 profile system prompt；首个包含工具调用的 bootstrap 响应
  结束后恢复 Pi 完整工具目录，之后该会话的后续请求一直保持完整目录。
- **Minimal**：每次 provider 请求都使用精简 bootstrap 工具目录，同时保持
  完整 profile system prompt。目录永远不会展开，适合与完整 Pi 工具集做
  对照实验。
- **Off**：完全不修改 provider payload 和 Pi 当前活动工具目录，是 A/B 对比
  的干净基线。切换后完整工具目录会立即恢复。

相关选项：Pi native 下即使 Mode 为 Off，`Bootstrap tools` 仍会显示，
方便先准备好基线再重新开启模式。

### Bootstrap tools

- **bash + edit**（默认）：最接近 DSH minimal 的两工具组合，但继续使用 Pi
  自身 schema。
- **bash + read**：偏只读检查的组合；bootstrap 阶段允许用 read 读取文件，
  并把 Pi 的专用文件编辑工具推迟到完整工具目录恢复之后。

JSON 字段 `nativeBootstrapTools` 可以填写任何已注册的 Pi 工具名，例如
`["bash", "read", "grep"]`。如果配置的工具未注册，或 provider payload 中缺少
该工具，扩展会恢复完整工具目录并拒绝修改请求，而不会发送不完整的
bootstrap。

相关选项：Exact DSH 忽略该设置，始终使用 `bash` + `str_replace_editor`
bootstrap。Pi native 下即使 Mode 为 Off 也会显示该设置，但它只在 Anchored
或 Minimal 模式下影响请求。

### 高级 JSON 字段

配置保存在仓库扩展共享的设置文件中：

```text
~/.pi/agent/99extensions.json
```

使用 `deepseek-anchor` 命名空间，默认配置如下：

```json
{
  "deepseek-anchor": {
    "version": 1,
    "profile": "pi-native",
    "mode": "anchored",
    "targetProvider": "deepseek",
    "targetModelId": "deepseek-v4-pro",
    "nativeBootstrapTools": ["bash", "edit"],
    "nativeSystemPrompt": "You are a helpful software engineer assistant."
  }
}
```

| 字段 | 作用 |
| --- | --- |
| `version` | 命名空间 schema 版本，保持 `1` |
| `profile` / `mode` | 与 `/99settings` 菜单相同的取值 |
| `targetProvider` | 模型 gate 的 provider 部分；只有该 provider 符合条件 |
| `targetModelId` | 模型 gate 的 model id 部分；provider payload 的 model 也必须匹配 |
| `nativeBootstrapTools` | Pi native bootstrap 请求暴露的 Pi 工具名；Exact DSH 会忽略 |
| `nativeSystemPrompt` | 注入到每个符合条件 Pi native 请求的完整 system instruction；Exact DSH 使用固定的 DSH prompt |

缺失或非法字段会在扩展加载时归一化回默认值。通过菜单修改会立即保存并
生效；直接编辑 JSON 文件需要下次扩展 reload 或新会话才会被读取。运行时工具
快照仅存在于当前会话，不会写入该文件。

## 调试

```bash
DEEPSEEK_ANCHOR_DEBUG=1 pi -e ./extensions/deepseek-anchor/index.ts
```

调试日志包含请求 phase、工具名称、规范化后的完整 system prompt，以及第一段可见 reasoning 的最多前 120 个字符。Reasoning 日志可能包含敏感项目数据，只应在明确需要实验时启用。

## 实验性注意事项

- 可见 reasoning 风格只能作为轨迹诊断信号；它不是 anchoring 的目标，也不能证明能力提升或读取隐藏 chain-of-thought。
- 对比 profile 时，应分别使用新会话，并保持相同的模型、thinking level、任务、workspace 和评估流程。
- 后加载的 `before_provider_request` 扩展仍可能修改最终 payload。需要严格请求快照时，请使用最小扩展集合。
- 为保持 schema 一致，扩展复现了 DSH 的 shell 描述，但不会强制实现其中的网络或软件包镜像声明。
- `str_replace_editor` 接受绝对路径，能够读取或修改 workspace 之外的文件。只应在 Pi 已拥有预期文件系统权限的环境中安装。

## 开发

```bash
bun run lint
node --import tsx --test --test-isolation=process tests/deepseek-anchor.test.ts
bun run --cwd extensions/deepseek-anchor build
bun pm pack --dry-run --cwd dist/deepseek-anchor
```

## License

MIT

[Pi coding agent]: https://pi.dev/
[DeepSeek V4 Pro harness 分析]: https://github.com/xiaobright/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_PRO_HARNESS_ANALYSIS_20260814.md
[审计提交中的 DSH minimal preset]: https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/minimal/agent.cordis.yml
[DSH minimal 请求快照]: https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/web/tests/minimal-preset.snapshot.ts
