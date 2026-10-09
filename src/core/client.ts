/**
 * 管控面云 API 客户端（TC3 签名走官方 SDK）。
 *
 * 只用 SDK 的通用 request 入口按 action 名分发，不为 33 个 Action 各写一个包装
 * ——参数结构由调用方按 api.json 拼，新增 Action 无需改这里（这也是 `thcli api
 * <action>` 兜底通道的实现基础）。
 *
 * 个人版 TokenPlan 的接口都在 tokenhub 产品下（套餐详情 / 模型清单 / 共享 Key /
 * 调用明细），与企业版共用同一个客户端，没有第二个产品要连。
 */
import * as tokenhubSdk from "tencentcloud-sdk-nodejs-tokenhub";

import { apiEndpointOf, envConfigOf } from "./config.js";
import {
  type GlobalArgs,
  parseGlobalArgs,
  type ResolvedCredential,
  resolveEnv,
} from "./credentials.js";
import { agentForEnv } from "./http-agent.js";
import { resolveIdentity } from "./identity.js";
import { t } from "./i18n.js";
import { maybeRefreshCredential } from "./oauth.js";
import { logControlPlaneCall } from "./telemetry.js";

/** tokenhub 云 API 版本 */
export const TOKENHUB_VERSION = "2026-03-22";

/** 测试网关要求携带的账号头，见 config.ts 的 EnvConfig.requiresUserId */
const USER_ID_HEADER = "X-Qcloud-User-Id";

/** SDK 客户端上真正发请求的方法，官方类型未导出，此处按实际形态声明 */
interface RawClient {
  request(action: string, req: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** 带上下文的客户端，命令层用它发请求 */
export interface Client {
  /** 调一个 Action，返回响应体（已剥掉 SDK 的外层包装） */
  call(action: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 当前生效的 profile，命令层做本地存储时要用 */
  profile: string;
  /** 当前生效的站点 */
  site: string;
  /** 当前生效的云 API 地域 */
  region: string;
}

/** 按最新凭证构造一个 SDK 客户端。每次 call 都重建（本地构造开销可忽略） */
type RawFactory = (cred: ResolvedCredential, userId: string | undefined) => RawClient;

/**
 * 两个产品共用的调用骨架：懒刷新凭证 → 按需注入账号头 → 发请求 → 记日志。
 * 只有 SDK 客户端的构造方式不同，由 factory 注入。
 */
function wrapClient(args: GlobalArgs, factory: RawFactory, logPrefix: string): Client {
  const initial = parseGlobalArgs(args);
  const profile = initial.profile;
  const site = initial.site;
  const routeByUserId = envConfigOf(resolveEnv()).routeByUserId === true;

  return {
    profile,
    site,
    region: initial.region,
    async call(action, params = {}) {
      // 懒刷新：临时密钥快过期才真正换，否则一次文件读的 no-op
      await maybeRefreshCredential(profile, site);
      const cred = parseGlobalArgs(args);
      if (!cred.secretId || !cred.secretKey) {
        throw new Error(t("cred.missing"));
      }

      // 只有声明需要的环境才注入账号头：正式网关从临时密钥反查账号，多带没意义；
      // 测试网关不反查，缺它则非广州地域一律 InternalError。查身份本身要发一次
      // 请求，故只在真要用时才查（首次查完即缓存进凭证文件）
      const userId = routeByUserId ? (await resolveIdentity(args)).uin : undefined;
      const raw = factory(cred, userId);

      const start = Date.now();
      const logged = `${logPrefix}${action}`;
      try {
        const resp = await raw.request(action, params);
        logControlPlaneCall(profile, site, {
          action: logged,
          // 成功响应的 RequestId 在 body 顶层，便于事后向云 API 侧定位问题
          requestId: typeof resp["RequestId"] === "string" ? resp["RequestId"] : undefined,
          durationMs: Date.now() - start,
          status: "ok",
        });
        return resp;
      } catch (err) {
        logControlPlaneCall(profile, site, {
          action: logged,
          // 失败时 RequestId 挂在 SDK 异常对象上（requestId 字段）
          requestId:
            err && typeof err === "object" && typeof (err as { requestId?: unknown }).requestId === "string"
              ? (err as { requestId: string }).requestId
              : undefined,
          durationMs: Date.now() - start,
          status: "error",
          error: (err as Error).message,
        });
        throw err;
      }
    },
  };
}

/** SDK 的 httpProfile：超时、可选 endpoint、测试网关账号头、强制解析/TLS agent */
function httpProfileOf(
  endpoint: string | undefined,
  userId: string | undefined,
): Record<string, unknown> {
  const agent = agentForEnv(resolveEnv());
  return {
    reqTimeout: 60,
    // 未配时不传，让 SDK 用它内置的正式 endpoint
    ...(endpoint ? { endpoint } : {}),
    ...(userId ? { headers: { [USER_ID_HEADER]: userId } } : {}),
    ...(agent ? { agent } : {}),
  };
}

function credentialOf(cred: ResolvedCredential): Record<string, string | undefined> {
  return {
    secretId: cred.secretId,
    secretKey: cred.secretKey,
    // 临时密钥才有 token；永久密钥留空
    token: cred.token,
  };
}

/**
 * 构造 tokenhub 客户端。保持同步签名（命令层 40 处调用点无需改动），凭证刷新推迟到每次
 * call 时懒执行：OAuth 临时密钥快过期就自动续，永久密钥直接跳过（no-op）。
 */
export function buildClient(args: GlobalArgs): Client {
  const endpoint = apiEndpointOf(resolveEnv());
  return wrapClient(
    args,
    (cred, userId) =>
      new tokenhubSdk.tokenhub.v20260322.Client({
        credential: credentialOf(cred),
        region: cred.region,
        profile: { httpProfile: httpProfileOf(endpoint, userId) },
      }) as unknown as RawClient,
    "",
  );
}
