import os from "node:os";
import path from "node:path";
import { t } from "../core/i18n.js";

/**
 * 与 shell 一致的波浪号展开：`~` / `~/...` → 用户主目录，其余原样。
 * `~user` 形式（其它用户的主目录）跨平台无统一读法，直接报错给明确指引——
 * 不展开则会在当前目录静默建出名为 ~ 的目录（--output ~/x 落到 ./~/x）。
 */
export function expandHome(p: string): string {
  if (!p.startsWith("~")) return p;
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  throw new Error(t("util.tildeUser", { value: p }));
}
