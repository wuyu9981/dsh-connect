/**
 * 安装分发契约的验证（2026-10-11 修的真实 bug，GitHub issue #2）。
 *
 * ## 事故
 *
 * 用户从 dsh-plugin.org 装本插件，失败，市场把原因归为 `plugin-side install failure`
 * —— 这次归类**是对的**：问题确实在我们自己的 package.json。
 *
 * ## 根因：11 个宿主 peer 一个都没标 optional
 *
 * profile 的 `pnpm-workspace.yaml` 里 `autoInstallPeers: false`，但 pnpm 仍要满足
 * 声明的 peer。于是装这一个插件会往用户 profile 里拖进 **164 个传递依赖**
 * （`@earendil-works/pi-ai` 全家桶、`@aws-sdk/*` 等），并撞上 pnpm 的构建脚本拦截门：
 *
 *   [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts:
 *     @google/genai@1.52.0, @google/genai@2.21.0, protobufjs@7.6.6
 *   → exit 1
 *
 * 实测（pnpm 11.7.0，DSH 自带的那份）：
 *
 *   | 声明                     | 装进 profile 的包数 | 结果        |
 *   |--------------------------|--------------------|-------------|
 *   | 11 个 peer 全部 auto      | 165                | exit 1      |
 *   | 全部标 optional           | 1                  | exit 0      |
 *
 * 这些包本来就是宿主进程提供的（进不了 profile 的 node_modules），标 optional 不影响
 * 运行，只去掉安装期的连带解析。同生态的干净插件全部这么做：
 * `dsh-free-search` 8/8、`dsh-rewind-plugin` 16/16、`dshmarket` 3 个里标 2 个。
 * 本探针把这个约定钉死，并复刻 Hub 自己的装后校验。
 *
 * 反向验证：删掉任意一个 peer 的 optional 标记，本探针必须变红。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
};

console.log("【1】每个 peer 都必须显式声明 optional（本次事故的直接修复）");

const peers = Object.keys(pkg.peerDependencies ?? {});
const meta = pkg.peerDependenciesMeta ?? {};
check("peerDependenciesMeta 存在", typeof meta === "object" && meta !== null, true);
check("peer 数量与事故时一致（11 个宿主包）", peers.length, 11);
check("没有任何 peer 漏标 optional",
  peers.filter((name) => meta[name]?.optional !== true), []);
check("meta 里没有多余的、非 peer 的键",
  Object.keys(meta).filter((name) => !peers.includes(name)), []);

console.log("\n【2】peer 的解析不能靠 npm/pnpm 连带来完成");

// 全部 optional 之后，pnpm 不再为 peer 装任何东西 —— 引用它们的模块只可能由宿主提供。
// 这里断言我们没有任何 `dependencies`：一旦有人图省事把宿主包挪进 dependencies，
// optional 就失效了，164 包连带解析会原样回来。
check("dependencies 为空（宿主包不得写进 dependencies）",
  Object.keys(pkg.dependencies ?? {}), []);

console.log("\n【3】复刻 Hub 的入口校验（preflight.ts / verifyInstalledEntry）");

/**
 * dsh-plugin-hub 的 `resolvePackageEntry()`：exports["."] 优先（default → import → require），
 * 回退 main，再回退 index.js。它拿这个结果去 tarball 里找文件、装完再 stat 一次；
 * 找不到就判 `[packaging] entry file missing` 并拦下安装。
 * 在本地提前跑同一套判定，就再也不会出现「装到一半才被市场拦」。
 */
function resolvePackageEntry(meta) {
  const dot = meta?.exports?.["."];
  const fromExports = typeof dot === "string"
    ? dot
    : dot !== null && typeof dot === "object"
      ? ["default", "import", "require"].map((key) => dot[key]).find((value) => typeof value === "string" && value !== "")
      : undefined;
  const candidate = typeof fromExports === "string"
    ? fromExports
    : typeof meta.main === "string" ? meta.main : "index.js";
  return candidate.replace(/^\.\//u, "");
}

const entry = resolvePackageEntry(pkg);
check("解析出的入口是 lib/index.js", entry, "lib/index.js");
check("入口文件真实存在（Hub 的 statSync 会成功）", existsSync(join(repo, entry)), true);

console.log("\n【4】发布的 tarball 必须自带入口与补丁");

// git 直装通道：仓库里必须提交构建产物（lib/）—— 市场和 README 都依赖这一点。
check("files 含 lib", pkg.files.includes("lib"), true);
check("files 含 cordis.patch.yml", pkg.files.includes("cordis.patch.yml"), true);
check("cordis.patch.yml 在仓库里", existsSync(join(repo, "cordis.patch.yml")), true);
check("dsh.bundle.patch 指向它", pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
// cordis.patch.yml 里 insert 的 name 必须是 npm 包名本身，否则 loader 加载不到模块。
const patch = readFileSync(join(repo, "cordis.patch.yml"), "utf8");
check("与 package.json name 一致（loader 按它加载）", patch.includes(`name: ${pkg.name}`), true);
check("运行时插件 id 仍是 dsh-connect（路由/设置段的键，不能变）", patch.includes("id: dsh-connect"), true);

console.log("\n【5】版本已越过出问题的 0.3.1");

// 0.3.1 是用户装失败的那个版本；修复必须发新版本，否则市场/git 缓存仍可能拿旧的。
const [major, minor, patchLevel] = pkg.version.split(".").map(Number);
check("版本 ≥ 0.3.2", major > 0 || minor > 3 || (minor === 3 && patchLevel >= 2), true);

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
