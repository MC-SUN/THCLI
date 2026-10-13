# THCLI

腾讯云大模型服务平台命令行工具。查模型、管密钥、跑推理、看用量、排障，都在一个命令里。

同时提供一套 **Agent Skills**：让 Claude Code 等本地 Agent 用自然语言驱动 thcli。skills 按需从远端拉取，不进 npm 包体，可独立于 CLI 版本迭代。

```shell
npm i -g tencent-tokenhub-cli
```

装完提供两个等价命令：`thcli` 与短别名 `th`。下文示例统一用 `thcli`；把它换成 `th`
效果完全一样，比如 `th models list` = `thcli models list`。

## 通过 AI Agent 安装

复制提示词给 AI Agent（Claude Code、Codex、Trae 等），它会自动完成安装：

```
根据下面命令帮我安装 THCLI：https://gz-thcli-skills-1258344699.cos.ap-guangzhou.myqcloud.com/tokenhub-cli-skills/install.md
```

Agent 会读取这份指引，完成 CLI 安装、登录、Skills 注入。之后即可用自然语言驱动 thcli。

注入的 skills 只做**只读操作**（查询、诊断、对话）；创建/修改/删除类的写命令 Agent 只会给你命令让你自己执行，绝不代跑。

## 快速上手

```shell
# 1. 登录（浏览器 OAuth，自动准备一把对话用的 API Key）
thcli auth login

# 2. 看有哪些模型
thcli models list

# 3. 对话（--model 直接填接入点 ID）
thcli +chat --model hy3 "你好"

# 4. 把 Skills 拉下来并注入本地 Agent
thcli +connect         # 下载 skills 并注入本地 Agent
```

无浏览器环境（远程开发机、CI、容器）用 `--browser no`，按提示把网页上的凭据串粘回终端：

```shell
thcli auth login --browser no
```

## 命令一览

| 命令组 | 用途 |
|---|---|
| `auth` | 登录、登出、手填永久密钥、查看登录态 |
| `models` | 模型广场：列表、详情、比价 |
| `endpoint` | 推理接入点：列表、详情、改配、删除 |
| `deploy` | 为模型创建推理接入点 |
| `+chat` | 与模型对话，支持多图 / 视频理解 |
| `chat-config` | 本地维护对话用的 API Key |
| `key` | API 密钥：增删改查、启停、查明文 |
| `plan` | 企业版套餐（TokenPlan）：购买、续费、专属 Key、用量 |
| `plan personal` | 个人版套餐（通用 / Hy）：持有状态、模型、用量趋势、共享 Key |
| `usage` | 用量观测：排行图表、CSV 导出 |
| `monitor` | 服务健康度：请求量、错误率、延迟、非文本模型产出量 |
| `doctor` | 诊断：全链路体检与分项排查（只读） |
| `profile` | 多账号身份切换 |
| `site` | 站点：国内站 `cn` / 国际站 `intl` |
| `lang` | 界面语言（`zh` / `en`） |
| `+connect` | 把 Agent Skills 注入本地 Agent |
| `agent` / `equip` | 把 TokenHub 模型一键接入 Claude Code、Codex、CodeBuddy 等工具 |

任何一层都可以 `--help`：

```shell
thcli --help
thcli plan --help
thcli plan key create --help
```

## 全局选项

这些选项在所有命令上都可用：

| 选项 | 说明 |
|---|---|
| `--profile <name>` | 账号身份，决定读哪份凭证 |
| `--site <cn\|intl>` | 站点 |
| `--region <region>` | 云 API 地域，如 `ap-guangzhou` |
| `--secret-id` / `--secret-key` | 临时覆盖密钥，成对使用 |
| `--lang <zh\|en>` | 本次执行的语言 |

## 站点与地域

**站点**（`cn` 国内站 / `intl` 国际站）和**地域**（如 `ap-guangzhou`）共同决定你操作的是
哪一份资源。两者都会影响全部命令 —— 密钥、接入点、套餐、用量都是按站点和地域隔离的，
换一个站点或地域看到的就是另一批资源。

### 设置站点

```shell
thcli site list                  # 看可用站点
thcli site current               # 看当前生效的站点及其来源
thcli site use --name cn         # 设为默认，持久生效
thcli models list --site intl    # 或单次指定，不改默认
```

### 设置地域

```shell
thcli profile set --region ap-guangzhou     # 设为默认，持久生效
thcli models list --region ap-singapore     # 或单次指定，不改默认
```

也可以用环境变量 `TENCENTCLOUD_REGION`（优先级低于 `--region`）。

优先级：`--region` / `--site` > 环境变量 > 已保存的默认值。

### 对话服务的地址

`+chat` 连的地址随站点和地域变化：

| | 广州 | 新加坡 |
|---|---|---|
| 国内站 `cn` | `tokenhub.tencentmaas.com` | `tokenhub-intl.tencentmaas.com` |
| 国际站 `intl` | `tokenhub.tencentcloudmaas.com` | `tokenhub-intl.tencentcloudmaas.com` |

主域随站点变（`tencentmaas` / `tencentcloudmaas`），`-intl` 后缀随地域变 —— 所以
「国内广州」和「国际广州」是两个不同的地址，对话用 `Bearer <APIKey>` 认证。

## 个人版套餐

个人版（通用 Token Plan / Hy Token Plan）的接口在 tokenhub 产品下，用 `--series common|hy` 区分系列：

```shell
thcli plan personal list                          # 两个系列的持有状态
thcli plan personal models --series hy            # 系列可用模型
thcli plan personal info --series common          # 套餐详情（档位 / 有效期 / 积分 / 共享 Key）
thcli plan personal usage tokens --series common  # Token 用量趋势（默认 7day 按日；--range today 看当日分钟级）
thcli plan personal usage credits --series common # 积分用量趋势
thcli plan personal records --series common       # 逐次调用明细
thcli plan personal key reveal --save             # 取共享 Key 并存入本地
thcli +chat --plan tp --model hy3 "你好"           # 用个人版额度对话
```

购买 / 续费 / 升配暂无开放接口，对应命令会打印控制台链接。

## 多模态理解

图片 / 视频**理解**就是对话：`+chat` 的 `--input` 可重复，本地文件自动 Base64（平台没有上传接口），
公网 URL 原样透传：

```shell
thcli +chat --model hy-vision-2.0-instruct --input a.png --input b.png "比较两张图"
thcli +chat --model kimi-k3 --input https://example.com/clip.mp4 "视频讲了什么"
```

## Agent 工具一键接入

`thcli agent install`（简写 `thcli equip`）把服务地址、API Key、模型列表写进本地 Agent 工具的配置。
**需要先登录**（`thcli auth login`）：Key 与可用模型都按账号获取。

```shell
thcli agent list                                  # 支持的工具与检测结果
thcli agent models --plan tp --series hy          # 当前账号可接入的模型
thcli agent install claude-code codex --dry-run   # 预览要改的文件
thcli agent install claude-code codex             # 按量后付费（--plan th，默认）
thcli equip codex --plan tp                       # 个人版套餐
thcli agent status                                # 已接入的工具与当前指向
thcli agent restore codex                       # 还原到接入前
```

写配置：Claude Code、Codex、CodeBuddy Code、OpenCode、OpenClaw、Kimi Code、Pi、WorkBuddy、Kilo Code；
界面填写（打印入口与填写项）：Cursor、Cline、Roo Code、Trae——它们没有可写的配置文件（扩展配置存在编辑器内部数据库与系统钥匙串，Cursor / Trae 只提供界面配置）。

- 只需要选通道，各工具要求的路径后缀（如 OpenAI 兼容的 `/v1`）由 CLI 按工具协议处理。
- 写入前汇总确认；只合并我们的配置项，用户原有配置保留；写入前备份原文件，含 Key 的文件 0600。
- 写入后按工具实际协议各发一次 `max_tokens=1` 的请求验证（`--no-verify` 跳过）。
- Key 从云端列表选择、新建或粘贴（`--api-key` 直接传入），与 `+chat` 用的本地 Key 无关。
- 模型按所选 Key 能调的范围列出、多选，第一个为默认；`--models` / `--model` 可直接指定；Claude Code 的 fable / opus / sonnet / haiku 档位按所选顺序自动填。
- 所选 Agent 未安装时询问后用 `npm install -g <包名>` 安装（与官方一致：最新版，不改 Agent 自己的自动更新）；WorkBuddy 是桌面应用，需先从官网下载安装后再接入。
- Codex 的 Key 写在 `~/.codex/config.toml` 的 `experimental_bearer_token`（0600），不需要环境变量、不改 shell 配置；该字段是 Codex 的实验字段，自行升级 Codex 后若鉴权失败，重跑一次接入即可。

## Agent Skills 接入

`+connect` 把 Agent Skills 从远端下载到本地缓存 `~/.thcli/skills-cache/`，再拷进本地 Agent 的 skills 目录，Agent 下次启动即可用自然语言驱动 thcli（"帮我看看哪个模型最便宜"、"这个 Key 为什么调不通"）。

```shell
thcli +connect             # 装机 / 更新：下载到本地缓存 + 注入 Agent（重复执行安全）
thcli +connect status      # 本地版本、远端版本、缓存内容、已注入的 Agent
thcli +connect uninstall   # 移除已注入的 thcli- 前缀 Skills
```

未内置支持的 Agent 用 `--target` 手动指定目录：

```shell
thcli +connect --target ~/.some-agent/skills
```

`npm i -g` 装完**不会自动注入**，也不会改动你的 Agent 配置。要用时自己跑一次 `thcli +connect`。

## 本地文件

都在 `~/.thcli/` 下：

| 文件 | 权限 | 内容 |
|---|---|---|
| `settings.json` | 0644 | 全局设置：`profile` / `site` / `lang` |
| `{profile}.configure` | 0644 | 该 profile 的 `region` |
| `{profile}.{site}.credential` | 0600 | 账号凭证 + 身份缓存（站点在文件名里） |
| `{profile}.tokenhub.json` | 0600 | 对话用的 API Key（站点在文件内容里） |
| `config.json` | 0644 | 可选，按字段局部覆盖内置基础设施配置 |
| `log/` | 0600 | 调用日志，见下 |
| `skills-cache/` | 0644 | `+connect` 下载的 Agent Skills 缓存 |
| `agent-state.json` | 0600 | `agent install` 的台账：改过哪些文件、备份在哪 |
| `agent-backups/` | 0600 | `agent install` 写入前的原文件备份 |

`{profile}.configure` 只在 `profile create` 或 `profile set --region` 时才生成；只用
`auth login` 的 profile 没有这个文件是正常的，`region` 会回退到内置默认。

### 调用日志

`~/.thcli/log/` 下按 profile、站点、通道分文件：

| 文件 | 内容 |
|---|---|
| `{profile}.{site}.tokenhub-plugin-console.log` | 管控面：云 API 调用的 action、request_id、耗时、成败 |
| `{profile}.{site}.tokenhub-plugin-chat.log` | 数据面：`+chat` 的模型、通道、耗时、成败 |

只记录调用元信息，**从不记录请求参数与响应体**，密钥不会落进日志。单文件超 5MB
轮转一份 `.1` 备份，旧备份被下次轮转覆盖。日志写失败不影响命令本身。

## 排障

先跑体检：

```shell
thcli doctor                # 全链路（等同 thcli doctor all）
thcli doctor key --id <ak-xxx>   # 单查某把 Key
thcli doctor error <code>   # 查错误码含义
```

`doctor` 全部只读，不会改任何配置或产生费用。

## 计费提醒

会产生费用的命令默认都有二次确认：`plan buy` / `renew` / `upgrade`、`endpoint postpaid on`、
`deploy`。`+chat` 按量计费。`agent install` 只改本地文件。其余命令为查询类。

## 环境要求

Node.js >= 18。

## License

Apache-2.0

