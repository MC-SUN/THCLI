/**
 * 当前凭证对应的账号身份（uin / ownerUin / appId）。
 *
 * 来源是 cam:GetUserAppId —— 它只回显"你是谁"，不需要额外权限，比
 * sts:GetCallerIdentity 更可靠：后者不接受第三方联合身份的临时密钥
 * （报 InvalidParameter.AccessKeyNotSupport: only support assumeRole or federation）。
 *
 * 查到后缓存进凭证文件的 identity 字段：身份在凭证有效期内不会变，而 monitor
 * 每次都要用 uin 做查询维度，不缓存等于每条命令多一次网络往返。
 */
import fs from "node:fs";

import { CommonClient } from "tencentcloud-sdk-nodejs-common";

import { cloudApiHostOf } from "./config.js";
import { agentForEnv } from "./http-agent.js";
import {
  type CredentialFile,
  type GlobalArgs,
  parseGlobalArgs,
  readCredentialFile,
  type ResolvedCredential,
  resolveEnv,
} from "./credentials.js";
import { credentialPath } from "./paths.js";
import { t } from "./i18n.js";

/** cam 的产品名与版本，用于拼 host 和 WithApiInfo */
const CAM_PRODUCT = "cam";
const CAM_VERSION = "2019-01-16";

/** 账号身份 */
export interface Identity {
  uin: string;
  ownerUin: string;
  appId: number;
}

/** 把身份并回凭证文件，保留其余字段。secretId 一并写入，作为下次命中的校验键 */
function cacheIdentity(
  profile: string,
  site: string,
  identity: Identity,
  secretId: string,
): void {
  const path = credentialPath(profile, site);
  try {
    const current = readCredentialFile(profile, site);
    // 凭证文件不存在时不要凭空创建：那会写出一份没有密钥的半成品，
    // 让 auth status 之类的命令误判成"已登录"
    if (!current.secretId) {
      return;
    }
    const next: CredentialFile = { ...current, identity: { ...identity, secretId } };
    fs.writeFileSync(path, `${JSON.stringify(next, null, 4)}\n`, { mode: 0o600 });
  } catch {
    // 缓存失败不影响本次调用，下次再查一遍即可
  }
}

/**
 * 用一份已解析的凭证取账号身份——身份解析的唯一实现。
 *
 * 命中缓存的条件不只是「文件里有 identity」，还必须「缓存的 secretId 等于本次实际
 * 生效的主凭证 secretId」：换账号（文件内换人 / 命令行 / 环境变量覆盖）密钥必变，
 * secretId 不符就判缓存失效、拿当前密钥重查，杜绝「密钥是 B、uin 却返回旧的 A」。
 *
 * 只有凭证来自文件（source=file）才把结果写回文件：命令行 / 环境变量是临时覆盖，
 * 把它们查出的身份落盘会污染该 profile 的持久凭证（下次无覆盖时读到的是错的）。
 *
 * 查询失败时抛错——调用方（monitor）没有 uin 就没法查指标，不能静默降级。
 */
export async function resolveIdentityWithCred(cred: ResolvedCredential): Promise<Identity> {
  const cached = cred.raw.identity;
  if (cached?.uin && cached.secretId === cred.secretId) {
    return cached;
  }

  if (!cred.secretId || !cred.secretKey) {
    throw new Error(t("cred.missing"));
  }

  const client = new CommonClient(
    cloudApiHostOf(resolveEnv(), CAM_PRODUCT),
    CAM_VERSION,
    {
      credential: { secretId: cred.secretId, secretKey: cred.secretKey, token: cred.token },
      region: cred.region,
      // agent 必须带上：配了 cloudApiHostIp / insecureTls 的环境靠它强制解析集群、放宽证书。
      // 漏了会被 DNS 解析到普通接口集群，那台 443 不说 TLS，报 wrong version number
      profile: { httpProfile: { reqTimeout: 30, agent: agentForEnv(resolveEnv()) } },
    },
  );

  const resp = (await client.request("GetUserAppId", {})) as {
    Uin?: string;
    OwnerUin?: string;
    AppId?: number;
  };
  if (!resp.Uin) {
    throw new Error(t("identity.noUin"));
  }
  const identity: Identity = {
    uin: resp.Uin,
    ownerUin: resp.OwnerUin ?? resp.Uin,
    appId: resp.AppId ?? 0,
  };
  // 仅文件源落盘：cli/env 临时覆盖不写回，避免污染 profile 的持久凭证
  if (cred.source === "file") {
    cacheIdentity(cred.profile, cred.site, identity, cred.secretId);
  }
  return identity;
}

/**
 * 取当前凭证的账号身份。密钥走整包三选一（命令行 > 环境变量 > 文件），
 * 身份与「本次实际签名用的那把密钥」严格同源。
 */
export async function resolveIdentity(args: GlobalArgs): Promise<Identity> {
  return resolveIdentityWithCred(parseGlobalArgs(args));
}
