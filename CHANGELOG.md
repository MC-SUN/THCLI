# Changelog

所有值得注意的变更记录于此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **个人版套餐**：`thcli plan personal`（通用 / Hy Token Plan）——持有状态、可用模型、套餐详情、
  用量趋势（`usage tokens` / `usage credits`，`--range today|7day|30day` 默认 7day，或 `--from/--to`；
  粒度随跨度自动：≤3 天出分钟级总量 / 输入 / 输出，更长按日只出总量）、
  逐次调用明细 `records`（含 RequestID），共享 API Key 的查看 / 重置。
  套餐 / 模型 / 共享 Key / 调用明细都在 tokenhub 产品下，按 `product` 参数区分系列；
  用量趋势走云监控的 `TpEPkg*` 指标。调用明细时间为 RFC3339（`--from/--to` 同格式）。
  购买 / 续费 / 升配 / 建删 Key 涉及开通购买，打印控制台链接。
- **Agent 一键接入**：`thcli agent install|list|models|status|restore` 与简写 `thcli equip`，
  支持 Claude Code、Codex、CodeBuddy Code、OpenCode、OpenClaw、Kimi Code、Pi、WorkBuddy、Kilo Code 写配置，
  Cursor、Cline、Roo Code、Trae 打印界面入口与填写项（按官方接入文档）；模型列表按云 API → 官方文档 → 内置快照回退；
  写前备份、台账可还原。Agent 用的 Key 从云端列表选择 / 新建 / 粘贴或 `--api-key` 传入，与 thcli 本地 Key 互不相干；
  模型按所选 Key 的绑定范围列出，交互多选（第一个为默认），Claude Code 的 fable / opus / sonnet / haiku 档位按所选顺序填写；
  所选 Agent 未安装时询问后用 `npm install -g <包名>` 安装最新版（与官方一致，不改 Agent 自己的自动更新）；是否已安装以 `<命令> --version` 的输出判断；
  WorkBuddy 等桌面应用未安装时不写配置，提示先下载安装再接入。
  Codex 的 Key 写在 `config.toml` 的 `experimental_bearer_token`（0600），不设环境变量、不改 shell rc。
  Codex 另写一份只含所选 TokenHub 模型的模型目录（`model_catalog_json`），`/model` 菜单里只出现这些模型；接入后自动重启 Codex 后台服务（app-server daemon），IDE 插件 / 桌面端新会话即用新配置。
  Kilo Code 写 `~/.config/kilo/kilo.jsonc`；Pi 同时写默认模型（`settings.json`）；界面型 Agent（Cursor、Cline、Roo Code、Trae）只打印入口与填写项，不问写入确认。
  某个 Agent 写到一半失败时，本次写过的文件自动恢复原样；界面型 Agent 只显示打码 Key，确认后才显示完整 Key。
  企业专业版的模型取自所在地域的 `DescribeTokenPlanModelList`（只含在线模型），轻享版为 `auto`。
- 配套 skills（thcli-agent）在 tokenhub-cli-skills 仓库发布。

### 变更

- `auth login` 会打印当前站点与云 API 地域，并给出切换命令（`site use` / `profile set --region`），便于登录时核对是否站错了。
- `+chat --anthropic` 不再要求 `--plan`：按量走 `/v1/messages`，与 `--plan` 同用仍走 `/plan/anthropic/v1/messages`。
- 数据面鉴权头统一为 `Authorization: Bearer`（含 Anthropic 协议，另带 `anthropic-version`），不再发 `x-api-key`。
  `+chat`、`agent` 验证共用 `core/data-plane.ts`。
- `+chat` 新增 `--verbose`：把实际请求（URL、请求头、请求体）与原始响应打到 stderr，Key 打码、Base64 截断。
- `+chat --json`（非流式）：输出网关原始响应（思考内容 / 回答 / usage 都在内），便于脚本与 Agent 解析；与 `--stream` 同用会报错（SSE 拼不出完整 JSON）。
- `+chat` 非流式请求超时 120 秒（`AbortSignal.timeout`），超时给出明确提示；流式不设总时限，避免误杀长回答。
- `+chat --input` 可重复（多图 / 多视频），支持视频理解（`video_url`）与公网 URL 透传；
  Responses 通道的图片改为文档规定的 `input_image` 结构。
- `+chat --search` 的联网搜索按协议选写法：Chat 端点（按量 chat 与 `--plan` 套餐通道）用 `web_search_options`，
  Responses 端点用 `tools`。
- 管控面客户端抽出公共骨架，两个产品共用同一套凭证刷新与调用日志。
- 错误码表收录 `AuthFailure.UnauthorizedOperation`。

### 修复

- **`+connect` 漏掉 Codex**：Codex 的 skills 目录改为 `~/.codex/skills`（尊重 `CODEX_HOME`），装了 Codex 即可注入；
  重复执行 `+connect` 会为之后新装的 Agent 补注入，已注入的不重复。
- **`plan models` 取不到模型**：改用 `DescribeTokenPlanModelList`（无参），输出专业版固定模型清单
  （模型 ID / 名称 / 状态 / 能力标签）。**不再要求 `--team-id`**——该清单所有专业版套餐一致，与套餐无关；
  轻享版只有 Auto。单把 Key 的可用范围仍可用 `plan key update --allowed-models` 配置。

## [1.0.0]

### 新增

- 首次开源发布。
- **短命令别名**：提供 `thcli` 与 `th` 两个等价命令，`th auth login` = `thcli auth login`。
- **模型**：列表、搜索、横向对比、价格查询。
- **API 密钥**：创建、查看、调整可访问范围与额度。
- **在线推理服务**：列表、详情、后付费开关。
- **对话**：文本与多模态推理，支持流式输出。
- **用量**：按模型 / 服务 / 密钥维度统计，趋势图，导出 CSV。
- **监控**：文本与非文本模型的服务健康度指标。
- **诊断**：`thcli doctor` 检查凭证、服务、模型、套餐，并解释错误码。
- **Agent Skills**：`thcli +connect` 注入 skills，让本地 AI Agent 用自然语言
  驱动 CLI。
- 中英双语界面（`--lang` 或 `thcli lang` 切换）。
