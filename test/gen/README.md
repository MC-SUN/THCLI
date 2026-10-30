# +gen 测试

覆盖 `thcli +gen <接口ID>`、`+gen apis`、`+gen status`、`+gen tasks` 全部命令。参数按官方调用指南（`tools/文档参数表.xlsx`、`tools/actions/`）逐字段整理：
每个接口的参数 = 请求体顶层字段，flag 名即字段名（下划线换连字符），如 `--sequential-image-generation`。

## 文件

| 文件 | 内容 | 怎么跑 |
|---|---|---|
| `registry.test.ts` | 接口注册表：字段契约、请求体校验（适用模型 / 必填 / 互斥）、参数解析、本地文件编码、`--param` / `--body` 覆盖层 | `npm test` |
| `parse.test.ts` | 响应归一化：各族 parse 钩子对文档示例 / 真实响应的 state / urls / texts / meta 归一 | `npm test` |
| `cli.test.ts` | 命令层：接口字段 flag 的 `--dry-run` 进程测试、`help` 写法改写 | `npm test` |
| `tasks.test.ts` | 本地任务记录（`gen-tasks.jsonl`）：合并 / 容错 / 压缩 / 刷新策略 | `npm test` |
| `errors.test.ts` | 厂商错误码定位 / 码表 / 展示、按报错原文的修复建议、网关错误在 `+gen` 场景的建议与 doctor 诊断命令 | `npm test` |
| `doctor.test.ts` | `doctor model` 诊断：服务侧可用性（模型 / 接入点 / 计费）、按量 Key 云端状态 | `npm test` |
| `run.sh` | 端到端用例（本地校验 → 请求体断言 → 真实提交 → 等结果），规则见下文 | `bash test/gen/run.sh` |
| `catalog.md` | 用例目录：33 个接口逐字段的用例清单与覆盖矩阵（**生成，勿手改**） | — |
| `generate.ts` | 由注册表生成 `catalog.md`，以及 `skills/*/SKILL.md` 的「接口参数」章节（skill 仓库已独立时用 `SKILLS_DIR=<路径>` 指定） | `npx tsc -p tsconfig.test.json && node dist-test/test/gen/generate.js` |

改了接口注册表（`src/core/gen-registry.ts`）后重跑 `generate.ts`，`catalog.md` 与 skill 参数表一起更新。

## 覆盖率说明

- **每个字段至少 1 个正向用例**：字段进请求体。
- **每个必填字段 1 个缺失用例**：本地报「--<flag> 必填」。
- **每个模型专属字段 1 个适用模型用例**：其它模型传了本地报「--<flag> 仅 … 支持」（如 seedream 的 `--tools` 仅 lite、kling-image 的 `--image-list` 仅 o1/v3-omni）。
- **只收 URL 的字段 1 个本地文件拦截用例**：本地报「只收公网 URL」。
- **互斥 / 条件必填**（二选一、至少一个、块级约束）在 `run.sh` 与 `registry.test.ts` 里专项覆盖。

## 传参约定

| 字段类型 | 写法 | 示例 |
|---|---|---|
| 字符串 / 数字 / 布尔 | 直接给值 | `--size 2K` `--seed 42` `--watermark true` |
| 数组 | JSON 数组；字符串数组也可直接给单个值 | `--images '["a.png","https://x/b.jpg"]'` / `--images a.png` |
| 对象 | JSON 对象 | `--settings '{"aspect_ratio":"16:9"}'` |
| 本地文件 | 可收 Base64 的字段传本地路径自动编码；只收 URL 的字段传本地文件本地拦截 | `--image-base64 ./a.jpg` |
| 覆盖/补充字段 | 任意字段都可用 `--param` 覆盖或补充：`key=value` 传字符串，`key:=json` 传 JSON（`n:=2`、`f:=true`、`cfg:='{"a":1}'`），键支持点路径；原样写入，不做本地文件编码 | `--param new_field:=1` |
| 请求体 | `--body` 传请求体 JSON 或 `@文件`（如回放 `--dry-run` 的输出），优先级最高。覆盖关系：接口参数 < `--param` < `--body` | `--body @body.json` |

## 命令规则（run.sh）

每个用例写成 `run_case <ID> <层级> <断言> <说明> <命令...>`。

| 层级 | 含义 | `bash run.sh`（默认） | `--server` | `--all` |
|---|---|---|---|---|
| `local` | 不联网：本地校验、help、models、tasks | 原样执行 | 原样执行 | 原样执行 |
| `body` | 只断言请求体（含占位 ID、平台暂无的模型等无法真实受理的字段） | 追加 `--dry-run` | 追加 `--dry-run` | 追加 `--dry-run` |
| `server` | 字段进请求体 + 服务端受理 | 追加 `--dry-run` | 真实提交，要求退出码 0 | 真实提交 |
| `real` | 真实素材端到端，结果落盘 `$R_OUT` | 跳过 | 跳过 | 真实提交 |

| 断言 | 通过条件 |
|---|---|
| `fail:<文案>` | 退出码非 0，且输出含 `<文案>` |
| `field:<文案>` | 输出含 `<文案>`；真实提交时还要求退出码 0（服务端拒绝算失败） |
| `ok` | 退出码 0 |

其它规则：

- 异步接口在真实提交时一律带 `--no-wait`，脚本从输出里提取 `thcli +gen status <接口> <任务ID>` 记下任务。`--verify` 会并发（`VERIFY_JOBS`，默认 8）等待这些任务，单个最长 `VERIFY_TIMEOUT` 秒（默认 1200）。
- 厂商偶发错误（超时、system error 等，匹配 `TRANSIENT_RE`）在 verify 阶段用原命令自动重提 1 次，汇总里记为「重提」。
- 脚本启动时先把自己复制到 `/tmp` 再执行，运行期间改 `run.sh` 不会影响正在跑的这一轮。
- `--only <正则>` 只跑 ID 匹配的用例，如 `--only 'real-|vid-kling'`。
- 汇总按层级分别统计 PASS / FAIL，verify 单独统计完成、失败、重提。

## 执行建议

1. **零费用全量**：`bash run.sh` —— 本地校验加全部请求体断言。
2. **服务端受理**：`bash run.sh --server` —— 真实提交，异步任务只提交不等。
3. **端到端**（扣费）：`bash run.sh --all --verify`。
4. **只看命令与请求体**：`bash run.sh --dry-run`。

## 资源与前置

- **素材统一取自 `test/assets/`**：图片 `images/`、音频 `audio/`、视频 `videos/`。不再使用 `https://x/...`、`example.com` 等占位地址，也不依赖他人桶里的外部素材。
- **可收本地文件的字段**直接传 `../assets/...` 本地路径，CLI 自动编码为 Base64 / data URL。
- **只收 URL 的字段**（kling motion-control / omni 的视频、vidu `--videos`、wand 生视频的 content、world2 的图片、hy-3d `--multi-view-images`、异步 ASR 等）用**同一份素材**在 COS 上的副本：`$ASSET_URL/<相对 test/assets 的路径>`，默认 `https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets`。素材有增改时先 `bash run.sh --sync-assets`（coscli 上传到 `$ASSET_COS`）；server / all 层开跑前会逐个检查这些 URL 可访问。
- **real 层**覆盖每类代表接口（图像 3、视频 11、3D 3、语音 5），**产物落 `$R_OUT/<用例ID>/`**（目录名=用例 ID，一眼对上「哪个用例生成了什么」；同步接口提交即落盘，异步接口由 `--verify` 的 `status --wait --output` 落盘），末尾打印产物映射表。
- **res 段**（`--all` 时顺序执行，扣费）：用 real 段同步产物作输入创建 Kling 主体/音色（`element create` / `voice create`），再把 `element_id` / `voice_id` 用于生成（`--element-list` / `--contents type=element` / TTS `--voice-setting`），最后 `delete` 真实删除收尾——体现「生成的资源用于生成其他内容」的完整链路。
- **doctor 段**：平台码 / 厂商冲突码（1002 双厂商并列）/ vendor 全表 / 未收录码 / 非法厂商，加 `doctor model` 真实体检。
- **act 段**（`--all` 时）：`models activate --yes` 遍历全部 +gen 模型（已开模型幂等重跑，未开模型真实开启）。
- 需已 `thcli auth login` 配好数据面 Key（见 skill「前置」）；`act` 段已含模型开通，无需手动 `models activate`。
