/**
 * 账号身份缓存测试。
 *
 * 身份（uin/appId）由 cam:GetUserAppId 查得后缓存进凭证文件，缓存里连同 secretId
 * 一起存，作为下次命中的校验键（换账号密钥必变，secretId 不符即判缓存失效）。
 * 这里不打真实网络，只钉住 saveCredential 的持久化行为：
 *   - 续期（keepIdentity=true）：同一账号换临时密钥，保留 identity，但 secretId
 *     必须对齐到新密钥——否则下次 resolveIdentity 因 secretId 不符每次都重查 cam。
 *   - 登录（keepIdentity=false）：可能是换账号重登同一 profile，旧 identity 属于
 *     上一个账号，必须丢弃，交给随后的 prefetchIdentity 用新密钥重查。
 *
 * 用子进程跑：core/paths.ts 在模块加载时就读定 HOME，同进程内改环境变量无效
 * （settings.test.ts 同样的隔离方式）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

let home: string;
let credPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "thcli-identity-"));
  fs.mkdirSync(path.join(home, ".thcli"), { recursive: true });
  credPath = path.join(home, ".thcli", "default.cn.credential");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** 在隔离 HOME 的子进程里调 saveCredential，keepIdentity 透传第五个参数 */
function runSave(keepIdentity: boolean): void {
  const oauthModule = path.join(process.cwd(), "dist-test", "src", "core", "oauth.js");
  const script = `
    const { saveCredential } = await import(${JSON.stringify(oauthModule)});
    const token = { openId: "oid", accessToken: "at", refreshToken: "rt",
                    expiresAt: 9999999999, state: "", site: "cn" };
    const cred = { secretId: "AKIDnew", secretKey: "new", token: "tnew", expiresAt: 8888888888 };
    saveCredential(token, cred, "default", "cn", ${keepIdentity});
  `;
  execFileSync("node", ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

describe("凭证里的账号身份缓存", () => {
  it("续期保留 identity，并把 secretId 对齐到新密钥", () => {
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        type: "oauth",
        secretId: "AKIDold",
        secretKey: "old",
        expiresAt: 1,
        identity: { uin: "123", ownerUin: "123", appId: 456, secretId: "AKIDold" },
      }),
    );

    runSave(true);

    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, unknown>;
    // uin/appId 不变；secretId 跟随密钥轮换更新成新值，缓存键才不会在续期后失效
    assert.deepEqual(after["identity"], {
      uin: "123",
      ownerUin: "123",
      appId: 456,
      secretId: "AKIDnew",
    });
    assert.equal(after["secretId"], "AKIDnew");
  });

  it("登录丢弃文件里的旧 identity（换账号重登同 profile 不能留旧 uin）", () => {
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        type: "oauth",
        secretId: "AKIDx",
        secretKey: "k",
        identity: { uin: "old", ownerUin: "old", appId: 1, secretId: "AKIDx" },
      }),
    );

    runSave(false);

    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, unknown>;
    assert.ok(!("identity" in after));
    assert.equal(after["secretId"], "AKIDnew");
  });

  it("没有 identity 时不写出该字段（而不是写个空对象）", () => {
    runSave(true);

    const after = JSON.parse(fs.readFileSync(credPath, "utf8")) as Record<string, unknown>;
    assert.ok(!("identity" in after));
  });
});
