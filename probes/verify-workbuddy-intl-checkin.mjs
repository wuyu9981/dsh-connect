/**
 * WorkBuddy 国际版「没有签到活动」的验证（2026-10-11 实测确认）。
 *
 * ## 事实
 *
 * 同一个 code 10001，两个产品的文案**含义相反**（本机实测，两条渠道同时打）：
 *
 * | 渠道 | `daily-checkin` 返回 |
 * |---|---|
 * | 国区个人号 | `10001 今天已签到，请明天再来` |
 * | 国际版 AI  | `10001 签到活动未开启或已过期` |
 *
 * ## 两个 bug
 *
 * 1. **`10001` 被一律当成 `already-claimed`** —— 国际版于是显示「今天已签到」，
 *    而它从来没有签到这回事。纯属谎报。
 * 2. **只读路径把国际版的看板默认值当成"今天还没签"**，返回 `claimable`，
 *    界面给出一个**可点的『签到』按钮**；用户点下去才发现什么都没有。
 *    这正是同文件里企业号那条注释明令避免的"假动作入口"。
 *
 * 反向验证：把文案判定改回只认「不支持」，或删掉 region 兜底，本探针必须变红。
 *
 * 用法：node probes/verify-workbuddy-intl-checkin.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

let passed = 0;
let failed = 0;
let chain = Promise.resolve();
const ok = (label, fn) => {
  chain = chain.then(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${label}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${label}\n      ${e && e.message}`);
    }
  });
};
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

// —— 桩宿主依赖，加载真实 panel（schemastery 用宿主真包）——
const stubDir = join(HERE, ".intl-checkin-stubs");
rmSync(stubDir, { recursive: true, force: true });
mkdirSync(stubDir, { recursive: true });
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
  const file = join(stubDir, spec.replace(/[@/]/g, "_") + ".mjs");
  const body =
    spec === "@deepseek-ai/dsh-home-paths"
      ? `export const resolveDshHome = () => process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : ${JSON.stringify(join(homedir(), ".dsh"))};\nexport default { resolveDshHome };\n`
      : `const mk=(n)=>{const f=function(){return f};return f};\n` + names.map((n) => `export const ${n}=mk(${JSON.stringify(n)});`).join("\n") + `\nexport default new Proxy({},{get:()=>mk("d")});\n`;
  writeFileSync(file, body);
  stubMap[spec] = file;
}
{
  const sc = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs");
  if (!existsSync(sc)) {
    console.error("找不到宿主真包 @deepseek-ai/schemastery");
    process.exit(2);
  }
  stubMap["@deepseek-ai/schemastery"] = sc;
}
const loaderFile = join(stubDir, "loader.mjs");
writeFileSync(
  loaderFile,
  `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`,
);
const { register } = await import("node:module");
register(pathToFileURL(loaderFile).href, import.meta.url);

const panel = await import(pathToFileURL(join(REPO, "lib", "panel.js")).href);
const VARIANTS = join(REPO, "lib", "providers", "workbuddy", "variants-CnrmSn0Q.js");

console.log("【1】同一个 10001，两种文案必须分到两种状态");

/**
 * 直接测 provider 的 claim 归一化：给它一个假的 fetch，回 10001 加不同文案。
 * 这是**值级**断言 —— 不钉写法，只钉"这个文案得到这个状态"。
 */
async function claimWith(message, code = 10001) {
  const home = join(tmpdir(), `dsh-intl-ck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "connect-auth"), { recursive: true });
  writeFileSync(join(home, "connect-channels.json"), JSON.stringify({
    version: 1,
    channels: [{ id: "workbuddy1", kind: "workbuddy", displayName: "t", region: "cn" }],
  }));
  const prevHome = process.env.DSH_HOME;
  const prevFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  try {
    // 凭据：直接给明文插件副本，省掉桌面凭据探测
    writeFileSync(join(home, ".workbuddy1-auth.json"), JSON.stringify({
      version: 1,
      credential: {
        accessToken: "t", refreshToken: "r", expiresAtMs: Date.now() + 3.6e6,
        domain: "www.codebuddy.cn", uid: "u1", source: "dsh",
      },
    }));
    globalThis.fetch = async () => new Response(JSON.stringify({ code, msg: message }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const mod = await import(`${pathToFileURL(VARIANTS).href}?ck=${encodeURIComponent(home + message)}`);
    const client = new mod.D();
    const credential = await new mod.b({
      variant: mod.i("workbuddy1"),
      refresh: async () => { throw new Error("no refresh"); },
    }).current();
    if (credential === undefined) throw new Error("探针自己的凭据没被读到");
    return await client.claimDailyCheckin(credential);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

await ok("国区文案「今天已签到，请明天再来」→ already-claimed", async () => {
  const r = await claimWith("今天已签到，请明天再来");
  eq(r.state, "already-claimed", "state");
  eq(r.code, 10001, "code");
});

await ok("国际版文案「签到活动未开启或已过期」→ unsupported（不是 already-claimed）", async () => {
  const r = await claimWith("签到活动未开启或已过期");
  eq(r.state, "unsupported", "state");
});

await ok("企业版文案「企业账号不支持该操作」→ unsupported（原有分支不回归）", async () => {
  const r = await claimWith("企业账号不支持该操作");
  eq(r.state, "unsupported", "state");
});

await ok("英文 unsupported / not available 文案同样判 unsupported", async () => {
  eq((await claimWith("not supported")).state, "unsupported", "not supported");
  eq((await claimWith("check-in campaign is not available")).state, "unsupported", "not available");
});

await ok("认不出的 10001 文案保守判 already-claimed（不谎报 unsupported）", async () => {
  const r = await claimWith("something entirely unexpected");
  eq(r.state, "already-claimed", "state");
});

console.log("\n【2】只读路径：国际版看板默认值不能变成可点按钮");

/** checkinOf 未导出，直接走公共入口 normalizeChannel。 */
const INTL_DOC = {
  status: "signed-in",
  channel: "workbuddy4",
  domain: "www.workbuddy.ai",
  models: 25,
};
const CN_DOC = { status: "signed-in", channel: "workbuddy1", domain: "www.codebuddy.cn", models: 17 };
/** 看板默认值：上游在活动未开放时整份就是这些值。 */
const BOARD_DEFAULT = {
  ok: true,
  data: {
    active: false, today_checked_in: false, streak_days: 0, daily_credit: 0,
    week_progress: [false, false, false, false, false, false, false], total_credits: 0,
  },
};
const channelOfKind = (id) => ({
  id,
  provider: id,
  displayName: id,
  kind: "workbuddy",
  credentialHint: `connect-auth/${id}.json`,
});

await ok("国际版 + 默认看板 → unsupported（不给动作入口）", () => {
  const row = panel.normalizeChannel(channelOfKind("workbuddy4"), INTL_DOC, BOARD_DEFAULT);
  eq(row.checkin.state, "unsupported", "state");
  assert.ok(typeof row.checkin.note === "string" && row.checkin.note.includes("没有签到"), "note 应说明原因");
});

await ok("国区 + 默认看板 → claimable（原有行为不回归）", () => {
  const row = panel.normalizeChannel(channelOfKind("workbuddy1"), CN_DOC, BOARD_DEFAULT);
  eq(row.checkin.state, "claimable", "state");
});

await ok("自动签到那趟已回 10001 未开启 → unsupported（覆盖只读路径）", () => {
  const row = panel.normalizeChannel(channelOfKind("workbuddy4"), INTL_DOC, {
    claim: { state: "unsupported", code: 10001, message: "签到活动未开启或已过期" },
  });
  eq(row.checkin.state, "unsupported", "state");
});

await ok("国际版空 domain 时不误判（缺字段按国区处理，与 regionOf 的约定一致）", () => {
  const row = panel.normalizeChannel(channelOfKind("workbuddy4"), { status: "signed-in", channel: "workbuddy4" }, BOARD_DEFAULT);
  eq(row.checkin.state, "claimable", "state");
});

console.log("\n【3】汇总里国际版计入「不适用」而不是「可签」");

await ok("summary.unsupported 增 1、claimable 不增", () => {
  const intl = panel.normalizeChannel(channelOfKind("workbuddy4"), INTL_DOC, BOARD_DEFAULT);
  const sum = panel.summarize([intl]);
  assert.ok(sum !== undefined, "summarize 应有返回");
  eq(sum.unsupported, 1, "unsupported");
  eq(sum.claimable, 0, "claimable");
});

rmSync(stubDir, { recursive: true, force: true });

await chain;
console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
