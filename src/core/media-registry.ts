/**
 * 生图 / 生视频 / 生 3D 的模型族注册表（数据面，Bearer API Key）。
 *
 * 各厂商的路径、请求体、任务 ID 字段、状态枚举、结果字段全都不同（以各厂商
 * 调用指南为准）。这里把差异收敛成声明式的 FamilySpec，命令层
 * 只做"构造 → 提交 → 轮询 → 归一化"四步，新增厂商只需加一条注册项。
 *
 * 纯函数：不发请求、不读写文件（本地图片由命令层读成 data URL 后传进来）。
 */

/** 生成类别 */
export type MediaKind = "image" | "video" | "3d";

/** 归一化后的任务状态 */
export type TaskState = "queued" | "running" | "succeeded" | "failed";

/**
 * 参考图的传法：
 *   dataUrl  data:image/png;base64,...（多数厂商）
 *   raw      裸 Base64，不带 data: 前缀（Kling、混元生视频、混元 3D）
 *   urlOnly  只收公网 URL（WAND 生视频、YT），本地文件直接拦截
 */
export type ImageEncoding = "dataUrl" | "raw" | "urlOnly";

/** 一次生成请求的通用输入（命令行参数归一后） */
export interface GenRequest {
  model: string;
  prompt?: string;
  /** 参考图 / 首帧（URL 或已编码的 data URL） */
  images: string[];
  size?: string;
  ratio?: string;
  duration?: number;
  resolution?: string;
  negativePrompt?: string;
  /** 驱动音频的公网 URL（人像驱动类模型用） */
  audio?: string;
}

/** 提交请求：路径 + 请求体 */
export interface SubmitSpec {
  path: string;
  body: Record<string, unknown>;
}

/** 查询请求：GET 路径，或 POST 路径 + 体 */
export interface QuerySpec {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

/** 归一化后的任务结果 */
export interface TaskResult {
  state: TaskState;
  urls: string[];
  /** 3D 的预览图等附属地址 */
  extraUrls: string[];
  error?: string;
}

/** +gen 的通用选项里，会因模型而异的那几个（对应 --size / --ratio / --resolution / --duration / --negative-prompt / --audio） */
export type GenOption = "size" | "ratio" | "resolution" | "duration" | "negativePrompt" | "audio";

/** 一个模型族 */
export interface FamilySpec {
  /** 族标识，用于 +gen models 展示 */
  id: string;
  kind: MediaKind;
  /** 该族包含的模型 ID（精确匹配） */
  models: string[];
  /** 同步族：提交即返回结果，不轮询 */
  sync: boolean;
  encoding: ImageEncoding;
  /** 最多参考图张数（超出本地拦截） */
  maxImages: number;
  /** 本族会用到的通用选项；不在此列的选项传了也不会进请求体（命令层据此提示） */
  options: GenOption[];
  /** 官方调用指南：全部参数（含 CLI 没有专门选项、需用 --param 传的）以它为准 */
  doc: string;
  submit(req: GenRequest): SubmitSpec;
  /** 从提交响应里取任务 ID（同步族不用） */
  taskIdOf?(resp: Record<string, unknown>): string | undefined;
  query?(model: string, taskId: string): QuerySpec;
  /** 从提交（同步）或查询（异步）响应里归一化结果 */
  parse(resp: Record<string, unknown>): TaskResult;
}

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------- 取值工具

/** 按点路径取值：pick(resp, "data.task_id") */
export function pick(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Obj)[key];
  }
  return cur;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** 依次尝试多个路径，取第一个非空字符串 */
function firstStr(obj: unknown, ...paths: string[]): string | undefined {
  for (const p of paths) {
    const v = str(pick(obj, p));
    if (v) return v;
  }
  return undefined;
}

/** 从数组里收集某字段的 URL */
function urlsOf(list: unknown, field = "url"): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => str((x as Obj)?.[field])).filter((u): u is string => Boolean(u));
}

/** 错误信息：OpenAI 风格 error.message、厂商的 message / ErrMsg / task_status_msg */
function errorOf(resp: unknown): string | undefined {
  const message = firstStr(resp, "error.message", "task_status_msg", "ErrMsg", "base_resp.status_msg");
  const code = firstStr(resp, "error.code");
  // 码与信息都给：信息是给人看的（如「资源不足。」），码便于对照厂商错误码文档
  return code && message ? `${message} (${code})` : message ?? code;
}

/**
 * 状态值归一化。厂商枚举五花八门（succeed / success / Success / completed / 1 …），
 * 用一张映射表收口；表外值一律按 running 处理——宁可多轮询几次，也不误报成功/失败。
 */
const STATE_MAP: Record<string, TaskState> = {
  queued: "queued",
  queueing: "queued",
  created: "queued",
  submitted: "queued",
  pending: "queued",
  running: "running",
  processing: "running",
  in_progress: "running",
  succeeded: "succeeded",
  succeed: "succeeded",
  success: "succeeded",
  completed: "succeeded",
  failed: "failed",
  fail: "failed",
  cancelled: "failed",
  incomplete: "failed",
};

export function normalizeState(raw: unknown): TaskState {
  return STATE_MAP[String(raw ?? "").trim().toLowerCase()] ?? "running";
}

function result(state: TaskState, urls: string[], resp: unknown, extraUrls: string[] = []): TaskResult {
  return { state, urls, extraUrls, error: state === "failed" ? errorOf(resp) : undefined };
}

/** 同步族：有结果即成功，带 error 即失败 */
function syncResult(urls: string[], resp: unknown): TaskResult {
  if (urls.length) return result("succeeded", urls, resp);
  return { state: "failed", urls: [], extraUrls: [], error: errorOf(resp) ?? "no result url in response" };
}

/** 只放有值的字段，免得把 undefined 序列化成 null 发给严格校验的网关 */
function compact(obj: Obj): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ""));
}

// ---------------------------------------------------------------- 注册表

const HY_IMAGE_V3: FamilySpec = {
  id: "hy-image-v3",
  kind: "image",
  models: ["hy-image-v3"],
  sync: true,
  encoding: "dataUrl",
  maxImages: 3,
  options: ["size"],
  doc: "https://cloud.tencent.com/document/product/1823/135745",
  submit: (r) => ({
    path: "/v1/wand/hunyuan-image/v3-generation",
    body: compact({ model: r.model, prompt: r.prompt, size: r.size, images: r.images.length ? r.images : undefined }),
  }),
  parse: (resp) => syncResult(urlsOf(resp["data"]), resp),
};

const HY_IMAGE_V35: FamilySpec = {
  id: "hy-image-v3.5",
  kind: "image",
  models: ["hy-image-v3.5-preview"],
  sync: true,
  encoding: "dataUrl",
  maxImages: 20,
  options: ["size"],
  doc: "https://cloud.tencent.com/document/product/1823/135745",
  // Chat/Messages 协议：最后一条 user 消息即本轮指令
  submit: (r) => ({
    path: "/v1/wand/hunyuan-image/v35-generation",
    body: compact({
      model: r.model,
      size: r.size,
      messages: [
        {
          role: "user",
          content: [
            ...(r.prompt ? [{ type: "text", text: r.prompt }] : []),
            ...r.images.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
    }),
  }),
  parse: (resp) => {
    const url = str(pick(resp, "choices.0.delta.image.url"));
    return syncResult(url ? [url] : [], resp);
  },
};

const SEEDREAM: FamilySpec = {
  id: "seedream",
  kind: "image",
  models: ["seedream-image-v5.0-pro", "seedream-image-v5.0-lite"],
  sync: true,
  encoding: "dataUrl",
  maxImages: 10,
  options: ["size"],
  doc: "https://cloud.tencent.com/document/product/1823/136609",
  submit: (r) => ({
    path: "/v1/wand/si-image/generation",
    body: compact({ model: r.model, prompt: r.prompt, size: r.size, images: r.images.length ? r.images : undefined }),
  }),
  parse: (resp) => syncResult(urlsOf(resp["data"]), resp),
};

const WAND_IMAGE: FamilySpec = {
  id: "wand-image",
  kind: "image",
  models: ["wand-vega-image-lite", "wand-vega-image-flash", "wand-vega-image-pro"],
  sync: false,
  encoding: "dataUrl",
  maxImages: 10,
  options: ["size"],
  doc: "https://cloud.tencent.com/document/product/1823/137203",
  submit: (r) => ({
    path: "/v1/wand/vega-images/generations",
    body: compact({
      model: r.model,
      prompt: r.prompt,
      size: r.size,
      input: r.images.length
        ? [{ content: r.images.map((url) => ({ type: "input_image", image_url: url })) }]
        : undefined,
    }),
  }),
  taskIdOf: (resp) => firstStr(resp, "task_id", "id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vega-images/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => result(normalizeState(resp["status"]), urlsOf(resp["data"]), resp),
};

const VIDU_IMAGE: FamilySpec = {
  id: "vidu-image",
  kind: "image",
  models: ["vidu-image-q2"],
  sync: false,
  encoding: "dataUrl",
  maxImages: 7,
  options: ["ratio", "resolution"],
  doc: "https://cloud.tencent.com/document/product/1823/135746",
  submit: (r) => ({
    path: "/v1/wand/vidu-image/generation",
    body: compact({
      model: r.model,
      prompt: r.prompt,
      aspect_ratio: r.ratio,
      resolution: r.resolution,
      images: r.images.length ? r.images : undefined,
    }),
  }),
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vidu-image/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => result(normalizeState(resp["state"]), urlsOf(resp["creations"]), resp),
};

const KLING_IMAGE: FamilySpec = {
  id: "kling-image",
  kind: "image",
  models: ["kling-image-v3", "kling-image-o1", "kling-image-v3-omni"],
  sync: false,
  // Kling 的 Base64 不带 data: 前缀
  encoding: "raw",
  maxImages: 10,
  options: ["ratio", "resolution"],
  doc: "https://cloud.tencent.com/document/product/1823/138803",
  submit: (r) => {
    const single = r.model === "kling-image-v3";
    return {
      path: "/v1/wand/kling-image/generation",
      body: compact({
        model: r.model,
        prompt: r.prompt,
        aspect_ratio: r.ratio,
        resolution: r.resolution,
        // v3 只收单张 image；o1 / v3-omni 收 image_list
        image: single ? r.images[0] : undefined,
        image_list: !single && r.images.length ? r.images : undefined,
      }),
    };
  },
  taskIdOf: (resp) => firstStr(resp, "data.task_id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/kling-image/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    // 查询响应有时裹在 data 里，有时直接在顶层（文档两种示例都有）
    const body = (resp["data"] && typeof resp["data"] === "object" ? resp["data"] : resp) as Obj;
    return result(normalizeState(body["task_status"]), urlsOf(pick(body, "task_result.images")), body);
  },
};

const HY_VIDEO: FamilySpec = {
  id: "hy-video",
  kind: "video",
  models: ["hy-video-v1.5"],
  sync: false,
  encoding: "raw",
  maxImages: 1,
  options: ["ratio", "resolution", "duration", "negativePrompt"],
  doc: "https://cloud.tencent.com/document/product/1823/137202",
  submit: (r) => {
    const img = r.images[0];
    const isUrl = img !== undefined && /^https?:\/\//i.test(img);
    return {
      path: "/v1/wand/hunyuan-video/generation",
      body: compact({
        model: r.model,
        prompt: r.prompt,
        negative_prompt: r.negativePrompt,
        duration: r.duration,
        resolution: r.resolution,
        // 图生视频的比例由图片决定，文档写明不支持 aspect_ratio
        aspect_ratio: img ? undefined : r.ratio,
        image_url: isUrl ? img : undefined,
        image: img && !isUrl ? img : undefined,
      }),
    };
  },
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/hunyuan-video/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => result(normalizeState(resp["status"]), urlsOf(resp["videos"]), resp),
};

const KLING_VIDEO: FamilySpec = {
  id: "kling-video",
  kind: "video",
  models: ["kling-video-v3", "kling-video-v3-turbo", "kling-video-v2.6", "kling-video-v2.5-turbo"],
  sync: false,
  encoding: "raw",
  maxImages: 2,
  options: ["ratio", "resolution", "duration"],
  doc: "https://cloud.tencent.com/document/product/1823/135742",
  submit: (r) => {
    const settings = compact({ resolution: r.resolution, aspect_ratio: r.ratio, duration: r.duration });
    if (!r.images.length) {
      return { path: "/v1/wand/kling/text-to-video", body: compact({ model: r.model, prompt: r.prompt, settings }) };
    }
    // 图生：首帧 + 可选尾帧，走 contents 数组
    const contents: Obj[] = [];
    if (r.prompt) contents.push({ type: "prompt", text: r.prompt });
    contents.push({ type: "first_frame", url: r.images[0] });
    if (r.images[1]) contents.push({ type: "last_frame", url: r.images[1] });
    return { path: "/v1/wand/kling/image-to-video", body: { model: r.model, contents, settings } };
  },
  taskIdOf: (resp) => firstStr(resp, "data.task_id", "data.id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/kling/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    // 查询响应是 data 数组（每项一个任务），也兼容单对象
    const data = resp["data"];
    const item = (Array.isArray(data) ? data[0] : data ?? resp) as Obj;
    return result(normalizeState(item["status"] ?? item["task_status"]), urlsOf(item["outputs"]), item);
  },
};

const VIDU_VIDEO: FamilySpec = {
  id: "vidu-video",
  kind: "video",
  models: [
    "vidu-video-q3-turbo",
    "vidu-video-q3-pro",
    "vidu-video-q3",
    "vidu-video-q2",
    "vidu-video-q2-pro",
    "vidu-video-q2-turbo",
  ],
  sync: false,
  encoding: "dataUrl",
  maxImages: 7,
  options: ["ratio", "resolution", "duration"],
  doc: "https://cloud.tencent.com/document/product/1823/135756",
  submit: (r) => {
    // 0 张文生、1 张图生、2 张首尾帧；更多参考图走 --body 自定义 reference-to-video
    const route = ["text-to-video", "image-to-video", "start-end-to-video"][Math.min(r.images.length, 2)];
    return {
      path: `/v1/wand/vidu/${route}`,
      body: compact({
        model: r.model,
        prompt: r.prompt,
        duration: r.duration,
        resolution: r.resolution,
        aspect_ratio: r.images.length ? undefined : r.ratio,
        images: r.images.length ? r.images : undefined,
      }),
    };
  },
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vidu/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => result(normalizeState(resp["state"]), urlsOf(resp["creations"]), resp),
};

/** PixVerse 的数字状态：1 成功 / 5 生成中 / 6 已删除 / 7 审核失败 / 8 生成失败 */
function pixverseState(status: unknown): TaskState {
  const n = Number(status);
  if (n === 1) return "succeeded";
  if (n === 6 || n === 7 || n === 8) return "failed";
  return "running";
}

const PIXVERSE: FamilySpec = {
  id: "pixverse",
  kind: "video",
  models: ["pixverse-video-v6.0", "pixverse-video-c1", "pixverse-video-v5.6"],
  sync: false,
  encoding: "dataUrl",
  maxImages: 2,
  options: ["ratio", "resolution", "duration"],
  doc: "https://cloud.tencent.com/document/product/1823/135325",
  submit: (r) => {
    const base = compact({ model: r.model, prompt: r.prompt, duration: r.duration, quality: r.resolution });
    if (r.images.length >= 2) {
      return {
        path: "/v1/wand/pixverse/start-end-to-video",
        body: { ...base, first_frame_img: r.images[0], last_frame_img: r.images[1] },
      };
    }
    if (r.images.length === 1) {
      return { path: "/v1/wand/pixverse/image-to-video", body: { ...base, img_id: r.images[0] } };
    }
    return { path: "/v1/wand/pixverse/text-to-video", body: compact({ ...base, aspect_ratio: r.ratio }) };
  },
  taskIdOf: (resp) => firstStr(resp, "Resp.video_id", "Resp.id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/pixverse/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const r = (resp["Resp"] ?? {}) as Obj;
    const url = str(r["url"]);
    return result(pixverseState(r["status"]), url ? [url] : [], resp);
  },
};

const MINIMAX_V1: FamilySpec = {
  id: "minimax-video",
  kind: "video",
  models: ["minimax-video-v2.3", "minimax-video-v2.3-fast"],
  sync: false,
  encoding: "dataUrl",
  maxImages: 2,
  options: ["resolution", "duration"],
  doc: "https://cloud.tencent.com/document/product/1823/135737",
  submit: (r) => ({
    path: "/v1/wand/minimax-video/generation",
    body: compact({
      model: r.model,
      prompt: r.prompt,
      duration: r.duration,
      resolution: r.resolution,
      first_frame_image: r.images[0],
      last_frame_image: r.images[1],
    }),
  }),
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/minimax-video/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const url = str(pick(resp, "content.url"));
    return result(normalizeState(resp["status"]), url ? [url] : [], resp);
  },
};

/** content 数组形态（MiniMax H3 / WAND 生视频共用）：文本 + 首尾帧图 */
function contentArray(r: GenRequest): Obj[] {
  const content: Obj[] = [];
  if (r.prompt) content.push({ type: "text", text: r.prompt });
  r.images.slice(0, 2).forEach((url, i) => {
    content.push({ type: "image_url", image_url: { url }, role: i === 0 ? "first_frame" : "last_frame" });
  });
  return content;
}

const MINIMAX_V2: FamilySpec = {
  id: "minimax-video-v2",
  kind: "video",
  models: ["minimax-video-h3", "minimax-video-h3-max"],
  sync: false,
  encoding: "dataUrl",
  maxImages: 2,
  options: ["ratio", "resolution", "duration"],
  doc: "https://cloud.tencent.com/document/product/1823/135737",
  submit: (r) => ({
    path: "/v1/wand/minimax-video-v2/generation",
    body: compact({
      model: r.model,
      content: contentArray(r),
      resolution: r.resolution,
      duration: r.duration,
      ratio: r.ratio,
    }),
  }),
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/minimax-video-v2/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const url = str(pick(resp, "task.content.url"));
    return result(normalizeState(pick(resp, "task.status")), url ? [url] : [], resp);
  },
};

const WAND_VIDEO: FamilySpec = {
  id: "wand-video",
  kind: "video",
  models: ["wand-vega-video-1.0-lite"],
  sync: false,
  // 文档：文件 URL 暂不支持 Base64 内联
  encoding: "urlOnly",
  maxImages: 2,
  options: ["ratio", "resolution", "duration"],
  doc: "https://cloud.tencent.com/document/product/1823/138195",
  submit: (r) => ({
    path: "/v1/wand/vega-videos/tasks",
    body: compact({
      model: r.model,
      content: contentArray(r),
      resolution: r.resolution,
      ratio: r.ratio,
      duration: r.duration,
    }),
  }),
  taskIdOf: (resp) => firstStr(resp, "id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vega-videos/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const url = str(pick(resp, "content.video_url"));
    return result(normalizeState(resp["status"]), url ? [url] : [], resp);
  },
};

const YT_VIDEO: FamilySpec = {
  id: "yt-video",
  kind: "video",
  models: ["yt-video-2.0", "yt-video-humanactor"],
  sync: false,
  encoding: "urlOnly",
  maxImages: 1,
  options: ["resolution", "audio"],
  doc: "https://cloud.tencent.com/document/product/1823/135716",
  // 参数与优图原接口一致，只是改成小写下划线（文档 1823/135716）。两个模型的图片字段形状不同：
  //   yt-video-2.0         图生视频：image: {url}
  //   yt-video-humanactor  人像驱动（SubmitHumanActorJob）：image_url 字符串 + 必填 audio_url（2~60s mp3/wav）
  submit: (r) => {
    if (r.model === "yt-video-humanactor") {
      return {
        path: "/v1/api/video/submit",
        body: compact({ model: r.model, prompt: r.prompt, image_url: r.images[0], audio_url: r.audio, resolution: r.resolution }),
      };
    }
    return {
      path: "/v1/api/video/submit",
      body: compact({ model: r.model, prompt: r.prompt, image: r.images[0] ? { url: r.images[0] } : undefined }),
    };
  },
  taskIdOf: (resp) => firstStr(resp, "id"),
  query: (model, id) => ({ method: "POST", path: "/v1/api/video/query", body: { model, id } }),
  parse: (resp) => {
    const url = str(pick(resp, "data.url"));
    return result(normalizeState(resp["status"]), url ? [url] : [], resp);
  },
};

const HY_3D: FamilySpec = {
  id: "hy-3d",
  kind: "3d",
  models: ["hy-3d-3.0", "hy-3d-3.1", "hy-3d-express"],
  sync: false,
  encoding: "raw",
  maxImages: 1,
  options: [],
  doc: "https://cloud.tencent.com/document/product/1823/137181",
  submit: (r) => {
    const img = r.images[0];
    const isUrl = img !== undefined && /^https?:\/\//i.test(img);
    // 文档：prompt 与图片互斥（Sketch 模式除外，那需要 --param generate_type=Sketch 自行组合）
    return {
      path: "/v1/api/3d/submit",
      body: compact({
        model: r.model,
        prompt: img ? undefined : r.prompt,
        image_url: isUrl ? img : undefined,
        image_base64: img && !isUrl ? img : undefined,
      }),
    };
  },
  taskIdOf: (resp) => firstStr(resp, "id"),
  query: (model, id) => ({ method: "POST", path: "/v1/api/3d/query", body: { model, id } }),
  parse: (resp) =>
    result(
      normalizeState(resp["status"]),
      urlsOf(resp["data"]),
      resp,
      urlsOf(resp["data"], "preview_image_url"),
    ),
};

/** 全部模型族。顺序即 +gen models 的展示顺序 */
export const FAMILIES: FamilySpec[] = [
  HY_IMAGE_V3,
  HY_IMAGE_V35,
  SEEDREAM,
  WAND_IMAGE,
  VIDU_IMAGE,
  KLING_IMAGE,
  HY_VIDEO,
  KLING_VIDEO,
  VIDU_VIDEO,
  PIXVERSE,
  MINIMAX_V1,
  MINIMAX_V2,
  WAND_VIDEO,
  YT_VIDEO,
  HY_3D,
];

/** 按模型 ID 找族；kind 给了就只在该类别里找 */
export function familyOf(model: string, kind?: MediaKind): FamilySpec | undefined {
  return FAMILIES.find((f) => (!kind || f.kind === kind) && f.models.includes(model));
}

/**
 * 把 --param k=v 解析成对象。值优先按 JSON 解析（数字、布尔、对象），
 * 失败按字符串——这样 --param n=2 得到数字、--param style=anime 得到字符串。
 * 键支持点路径：--param settings.audio=native。
 */
export function parseParams(pairs: string[]): Obj {
  const out: Obj = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--param expects key=value, got: ${pair}`);
    }
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // 不是 JSON 就当字符串
    }
    setPath(out, key, value);
  }
  return out;
}

function setPath(obj: Obj, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k] as Obj;
  }
  cur[keys[keys.length - 1]!] = value;
}
