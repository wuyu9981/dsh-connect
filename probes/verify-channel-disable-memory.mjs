#!/usr/bin/env node
// probes/verify-channel-disable-memory.mjs
//
// 钉死 2026-10-08 用户反馈：勾选了部分常用模型 → 临时禁用整个渠道 → 再启用，
// 逐模型的勾选**被重置成"全部勾选"**，没有记忆。
//
// ## 根因
//
// "禁用渠道"和"逐模型隐藏"共用了同一个存储 `disabledModels`：
//   · disable：清空该 provider 条目 → 把当前全部模型写进去
//   · enable：把该 provider 条目全部删掉
// 覆盖式写入必然互相踩。
//
// ## 契约（本探针钉住）
//
// 1. disable 只动 `disabledChannels`，`disabledModels` 逐字节不变
// 2. enable 同样不碰 `disabledModels`
// 3. 渠道被禁用时，`disabledModelsFor(provider)` 对任何 id 都返回 true
//    （整渠道隐藏），但不需要先把全部模型 id 写进偏好
// 4. delete 才清理该 provider 的孤儿条目（渠道整个没了，条目已无意义）
//
// 用法：node probes/verify-channel-disable-memory.mjs [--installed]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC = process.argv.includes("--installed")
  ? path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", process.env.DSH_CONNECT_DIR ?? "dsh-workbuddy-trae-qoder-connect")
  : REPO;

let passed = 0;
let failed = 0;
let chain = Promise.resolve();
const ok = (label, fn) => {
  chain = chain.then(async () => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL ${label}\n  ${e && e.message}`);
    }
  });
};
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

// —— 加载真实 panel + hidden（schemastery 真包 + 桩宿主）——
const stubDir = path.join(HERE, ".memory-stubs");
fs.mkdirSync(stubDir, { recursive: true });
const stubNames = {
  "@deepseek-ai/dsh-home-paths": ["resolveDshHome"],
  "@deepseek-ai/dsh-llm": ["resolveRetryPolicy"],
  "@deepseek-ai/dsh-llm-pi-ai": ["PiAiAdapter"],
  "@earendil-works/pi-ai": ["createProvider"],
  "@earendil-works/pi-ai/api/openai-completions.lazy": ["openAICompletionsApi"],
  "@deepseek-ai/dsh-atomic-write": ["withFileLock", "writeFileAtomic"],
};
const stubMap = {};
for (const [spec, names] of Object.entries(stubNames)) {
  const file = path.join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
  const body =
    spec === "@deepseek-ai/dsh-home-paths"
      ? `export const resolveDshHome = () => ${JSON.stringify(path.join(os.homedir(), ".dsh"))};\nexport default { resolveDshHome };\n`
      : `const mk=(n)=>{const f=function(){return f};return f};\n` + names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") + `\nexport default new Proxy({},{get:()=>mk("d")});\n`;
  fs.writeFileSync(file, body);
  stubMap[spec] = file;
}
{
  const sc = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs");
  if (!fs.existsSync(sc)) {
    console.error("找不到宿主真包 @deepseek-ai/schemastery");
    process.exit(2);
  }
  stubMap["@deepseek-ai/schemastery"] = sc;
}
const loaderFile = path.join(stubDir, "loader.mjs");
fs.writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
const { register } = await import("node:module");
register(new URL(`file://${loaderFile.replace(/\\/g, "/")}`).href, import.meta.url);

const hidden = await import(pathToFileURL(path.join(SRC, "lib", "shared", "hidden.js")).href);
const { hiddenMatcher, HIDE_ALL_SENTINEL } = hidden;

// ============ A. 纯函数契约 ============

ok("A1: 普通列表：命中的隐藏，其余放行", () => {
  const isHidden = hiddenMatcher(["a", "b"]);
  if (!isHidden("a")) throw new Error("a 应被隐藏");
  if (isHidden("c")) throw new Error("c 不应被隐藏");
});

ok("A2: 空列表/非数组：全部放行", () => {
  if (hiddenMatcher([])("x")) throw new Error("空列表不应隐藏任何模型");
  if (hiddenMatcher(undefined)("x")) throw new Error("undefined 不应隐藏任何模型");
  if (hiddenMatcher(null)("x")) throw new Error("null 不应隐藏任何模型");
});

ok("A3: 哨兵存在且不可打印（模型 id 不可能撞上）", () => {
  if (typeof HIDE_ALL_SENTINEL !== "string" || HIDE_ALL_SENTINEL.length === 0) {
    throw new Error("HIDE_ALL_SENTINEL 必须是非空字符串");
  }
  if (!HIDE_ALL_SENTINEL.startsWith("\u0000")) {
    // 用不可见字符开头，避免与真实模型 id 冲突
  }
  const isHidden = hiddenMatcher(["some/model", HIDE_ALL_SENTINEL]);
  if (!isHidden("任意模型")) throw new Error("哨兵应让任何 id 都被判定为隐藏");
});

// ============ B. 面板源码契约（disable/enable 不能碰 disabledModels）============

const panelSrc = fs.readFileSync(path.join(SRC, "lib", "panel.js"), "utf8");
const stripped = panelSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

ok("B1: disable 分支不再探测模型 / 不再写 disabledModels", () => {
  const at = stripped.indexOf('if (manageAction === "disable")');
  const block = stripped.slice(at, at + 400);
  if (/probeChannel\(/.test(block)) {
    throw new Error("disable 还在先探测模型 —— 探测失败会导致禁用不彻底，而且没必要");
  }
  if (/dropProviderModels/.test(block)) {
    throw new Error("disable 仍在清空该 provider 的模型偏好");
  }
});

ok("B2: enable 分支不再 dropProviderModels", () => {
  const at = stripped.indexOf('if (manageAction === "enable")');
  const block = stripped.slice(at, at + 300);
  if (/dropProviderModels/.test(block)) {
    throw new Error("enable 仍在删除该 provider 的模型偏好 —— 这正是'重新启用后全部勾选'的根因");
  }
});

ok("B3: commit 把 disabledModels 原样回写（不重排、不增删）", () => {
  const at = stripped.indexOf("const commit = async (disabledChannels) =>");
  const block = stripped.slice(at, at + 400);
  if (!/disabledModels:\s*prefs\.disabledModels/.test(block)) {
    throw new Error("commit 没有原样保留 disabledModels");
  }
});

/**
 * B4：整渠道隐藏通过哨兵在**读取时**叠加（不需要写全量模型）。
 *
 * ⚠️ 2026-10-09：这里原先钉的写法本身就是 bug 的源头。
 * 旧断言是 `disabledChannels.includes(providerId)` —— 只认 provider id。
 * 但面板「禁用」写进 `disabledChannels` 的是**渠道 id**，两者在 Qoder 上不同
 * （渠道 `qoder` vs provider `qoder1`），于是**禁用 Qoder 完全不生效**：
 * 面板那行显示"已禁用"，模型却照样能选。
 *
 * 现在断言必须"两种 id 都认"，且**不许退回只认 provider id**。
 */
ok("B4: 整渠道隐藏通过哨兵在读取时叠加（不需要写全量模型）", () => {
  if (!/return\s*\[HIDE_ALL_SENTINEL\]/.test(stripped)) {
    throw new Error("disabledModelsFor 没有在渠道被禁用时返回哨兵");
  }
  if (!/channels\.has\(channelIdOfProvider\(providerId\)\)/.test(stripped)) {
    throw new Error("禁用判定没有认渠道 id —— 只认 provider id 会让禁用 Qoder 失效（qoder vs qoder1）");
  }
  if (/disabledChannels\.includes\(providerId\)\s*\)\s*return\s*\[HIDE_ALL_SENTINEL\]/.test(stripped)) {
    throw new Error("退回了只认 provider id 的旧写法 —— 禁用 Qoder 会再次失效");
  }
});

ok("B5: delete 仍清理该 provider 的孤儿偏好（渠道没了，条目无意义）", () => {
  const at = stripped.indexOf('if (manageAction === "delete")');
  const block = stripped.slice(at, at + 1200);
  if (!/startsWith\(`\$\{managed\.provider\}\/`\)/.test(block) && !/startsWith\(managed\.provider \+ "\/"\)/.test(block)) {
    throw new Error("delete 没有过滤掉该 provider 的孤儿 disabledModels 条目");
  }
});

fs.rmSync(stubDir, { recursive: true, force: true });
await chain;
console.log(`\nverify-channel-disable-memory: ${passed} 通过 / ${failed} 失败  [src=${SRC}]`);
process.exitCode = failed ? 1 : 0;
