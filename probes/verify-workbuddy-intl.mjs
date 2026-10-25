/**
 * WorkBuddy 国际版（WorkBuddy AI）接入验证 —— GitHub issue #1。
 *
 * ## 背景
 *
 * 用户报"希望加入 WorkBuddy 国际版的支持"。勘察后的事实是：**本仓库上游原版
 * 就是「国区 + 国际版」双变体插件**，国际版实现（`GLOBAL_BASE`、`regionOf`、
 * `resolveGlobalIdentity`、`WORKBUDDY_AI_*` 路由）一行没删，只是本地分支把
 * `workbuddyVariantOf` 的属性写死成国区，于是没有任何变体能走到国际版分支。
 *
 * ## 两个产品的事实（全部实测自本机安装，非推测）
 *
 * | | 国区版 | 国际版 |
 * |---|---|---|
 * | 安装路径 | `F:\agent\WorkBuddy\` | `F:\agent\WorkBuddyAI\` |
 * | 产品名 | WorkBuddy 5.7.6 | WorkBuddy AI 5.7.6 |
 * | endpoint | `https://www.workbuddy.cn` | `https://www.workbuddy.ai` |
 * | 凭据 basename | `workbuddy-desktop.info` | `workbuddy-desktop-ai.info` |
 * | 凭据目录 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`（**共享**） | 同左 |
 * | 加密 | `$wbEncrypted` suite 1 | 同左，且**共用同一把 key** |
 * | app 版本 | 5.5.6（编译期兜底） | 5.7.6（`last-launch.json` 实测） |
 *
 * basename 抄自各自 `resources/app.asar.unpacked/cli/product.json` 的
 * `authentication.id`（`workbuddy-desktop` / `workbuddy-desktop-ai`）。
 * 两把 `atRestSecretKey` 实测**逐字节相同**，所以国区密钥助手解析出的 key 同时
 * 能开国际版的信封 —— 这是"共用一个凭据目录"的直接后果。
 *
 * ## 钉住的契约
 *
 * 1. 注册表条目可声明 `region`（`cn` / `global`），变体属性由它派生
 * 2. 认不出的 region 丢弃该字段而不是报错整条（回落 cn）
 * 3. 国际版变体必须派生出正确的 appName / desktopFilename
 * 4. **国际版不能被 `connect-auth/<id>.json` 短路**：那份文件不存在时必须回落到
 *    平台默认探测，否则 App 里能用的凭据永远读不到
 * 5. 国区槽位的两条回落路径（设置字段 / connect-auth）语义不变
 * 6. `regionOf` 对 `www.workbuddy.ai` 判 global、对 `www.codebuddy.cn` 判 cn
 *
 * 反向验证：把 `workbuddyVariantOf` 里的区域派生改回写死，本探针必须变红。
 *
 * 用法：node probes/verify-workbuddy-intl.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const validLike = (v) => typeof v === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(v);
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

// —— 桩宿主依赖，加载真实变体模块（与同类探针同一套写法）——
const stubDir = join(HERE, ".intl-stubs");
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
  // dsh-home-paths / dsh-atomic-write 是会被真实调用的两个：前者给 DSH_HOME，
  // 后者要真的落盘 —— 用"返回假函数"的桩会让 resolveAppVersion 的写回静默失效，
  // 探针就会把"桩没实现"误报成"代码没写回"。桩的保真度直接决定探针可信度。
  //
  // resolveDshHome 必须**每次调用**都读环境变量，不能在生成桩文件时把值烘死：
  // 本探针要多次把 DSH_HOME 指向不同的临时目录来驱动变体表，烘死会导致后几次
  // 仍然读到**真实的** ~/.dsh —— 探针照样"全绿"，但它其实什么都没测到
  // （而且会读用户真实注册表，随时可能因为用户自己的配置变化而变红）。
  const body =
    spec === "@deepseek-ai/dsh-home-paths"
      ? `export const resolveDshHome = () => process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : ${JSON.stringify(join(homedir(), ".dsh"))};\nexport default { resolveDshHome };\n`
      : spec === "@deepseek-ai/dsh-atomic-write"
        ? [
            `import { mkdirSync, writeFileSync, renameSync } from "node:fs";`,
            `import { dirname } from "node:path";`,
            `export async function writeFileAtomic(path, data, options = {}) {`,
            `  const dirMode = options.dirMode ?? 0o700, mode = options.mode ?? 0o600;`,
            `  mkdirSync(dirname(path), { recursive: true, mode: dirMode });`,
            `  const tmp = path + ".tmp";`,
            `  writeFileSync(tmp, data, { mode });`,
            `  renameSync(tmp, path);`,
            `}`,
            `export async function withFileLock(path, fn) { return await fn(); }`,
            `export default { writeFileAtomic, withFileLock };`,
            ``,
          ].join("\n")
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

const VARIANTS = join(REPO, "lib", "providers", "workbuddy", "variants-CnrmSn0Q.js");
const REGISTRY = join(REPO, "lib", "channel-registry.js");

console.log("【1】区域派生：注册表声明什么，变体就是什么");

/**
 * 变体表在模块加载时由注册表生成，所以用**临时 DSH_HOME + 临时注册表**驱动它。
 * 这比读源码文本强：它检验的是真实加载路径上的行为。
 */
async function loadVariantsWith(registryChannels) {
  const home = join(tmpdir(), `dsh-intl-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "connect-channels.json"), `${JSON.stringify({ version: 1, channels: registryChannels }, null, 2)}\n`);
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // 每次以查询串绕开 ESM 模块缓存，保证读到新注册表。
    const mod = await import(`${pathToFileURL(VARIANTS).href}?home=${encodeURIComponent(home)}`);
    return mod;
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

const intl = await loadVariantsWith([
  { id: "workbuddy1", kind: "workbuddy", displayName: "CN 1", region: "cn" },
  { id: "workbuddy4", kind: "workbuddy", displayName: "WorkBuddy AI 国际版", region: "global" },
]);

await ok("国区条目派生 region=cn / appName=WorkBuddy", () => {
  const v = intl.i("workbuddy1");
  assert.ok(v, "workbuddy1 变体应存在");
  eq(v.region, "cn", "region");
  eq(v.appName, "WorkBuddy", "appName");
  eq(v.desktopFilename, "workbuddy-desktop.info", "desktopFilename");
});

await ok("国际版条目派生 region=global / appName=WorkBuddy AI", () => {
  const v = intl.i("workbuddy4");
  assert.ok(v, "workbuddy4 变体应存在");
  eq(v.region, "global", "region");
  eq(v.appName, "WorkBuddy AI", "appName");
  // 国际版读的是 App 目录里那份 basename —— 抄自 product.json 的 authentication.id
  eq(v.desktopFilename, "workbuddy-desktop-ai.info", "desktopFilename");
});

await ok("每条变体仍带自己的环境变量名与路由（不因区域改动而串位）", () => {
  const v4 = intl.i("workbuddy4");
  eq(v4.env, "WORKBUDDY4_AUTH_FILE", "env");
  eq(v4.statusPath, "/plugins/dsh-workbuddy-connect/4/status", "statusPath");
  eq(v4.ownFilename, ".workbuddy4-auth.json", "ownFilename");
});

console.log("\n【2】缺省与容错：旧注册表 / 拼错的区域");

const legacy = await loadVariantsWith([
  { id: "workbuddy1", kind: "workbuddy", displayName: "CN 1" },
]);
await ok("没有 region 字段的旧条目按国区处理（行为不变）", () => {
  const v = legacy.i("workbuddy1");
  eq(v.region, "cn", "region");
  eq(v.desktopFilename, "workbuddy-desktop.info", "desktopFilename");
});

const bogus = await loadVariantsWith([
  { id: "workbuddy1", kind: "workbuddy", displayName: "x", region: "martian" },
]);
await ok("认不出的 region 回落到国区，而不是抛错或变成国际版", () => {
  const v = bogus.i("workbuddy1");
  eq(v.region, "cn", "region");
  eq(v.appName, "WorkBuddy", "appName");
});

console.log("\n【3】注册表读取层：region 白名单");

const registryMod = await import(pathToFileURL(REGISTRY).href);
await ok("默认表含国际版槽位且声明 region=global", () => {
  const entry = registryMod.DEFAULT_REGISTRY_CHANNELS.find((c) => c.id === "workbuddy4");
  assert.ok(entry, "默认表应有 workbuddy4");
  eq(entry.region, "global", "region");
});
await ok("默认表里的国区槽位显式声明 region=cn", () => {
  for (const id of ["workbuddy1", "workbuddy2", "workbuddy3"]) {
    const entry = registryMod.DEFAULT_REGISTRY_CHANNELS.find((c) => c.id === id);
    eq(entry.region, "cn", `${id} region`);
  }
});
await ok("region 白名单是 cn / global 两个值", () => {
  eq([...registryMod.CHANNEL_REGIONS].sort(), ["cn", "global"], "CHANNEL_REGIONS");
});

console.log("\n【4】区域判定：两个产品的 domain");

await ok("workbuddy.ai 判为 global（含带 www 与子域）", () => {
  eq(intl.P("www.workbuddy.ai"), "global", "www.workbuddy.ai");
  eq(intl.P("workbuddy.ai"), "global", "workbuddy.ai");
  eq(intl.P("api.workbuddy.ai"), "global", "api.workbuddy.ai");
});
await ok("codebuddy.cn / 空 domain 判为 cn（空是国区的既有约定）", () => {
  eq(intl.P("www.codebuddy.cn"), "cn", "www.codebuddy.cn");
  eq(intl.P(""), "cn", "空串");
});
await ok("两个产品不能互判（大小写无关）", () => {
  eq(intl.P("WWW.WORKBUDDY.AI"), "global", "大写");
  // workbuddy.cn 属于国区系（国际版的 product.json 里 codebuddy.cn 也在 internalDomain）
  eq(intl.P("www.workbuddy.cn"), "cn", "workbuddy.cn");
});

console.log("\n【5】app 版本号：国际版 UA 不能退回编译期常量");

await ok("编译期兜底版本存在且形状合法", () => {
  eq(intl.X("5.5.2"), true, "5.5.2");
  eq(intl.X("5.7.6"), true, "5.7.6");
  eq(intl.X(""), false, "空串");
  eq(intl.X(undefined), false, "undefined");
});
await ok("resolveAppVersion 在无 App 元数据时回落到 compiled-in 兜底而不是抛错", async () => {
  // path 指向一个不存在的缓存文件、installed 明确返回 undefined
  const out = await intl.Y({
    path: join(tmpdir(), "dsh-intl-probe-absent.json"),
    installed: async () => undefined,
  });
  assert.ok(typeof out.version === "string" && out.version !== "", "version 应非空");
  eq(out.source, "fallback", "source");
});
await ok("App 目录读得出真实版本时就采用它（本机国际版 5.7.6）", async () => {
  // 模拟 installed 链返回一个真实读到的版本，验证"读到就用、并回写缓存"
  const cache = join(tmpdir(), `dsh-intl-ver-${Date.now()}.json`);
  const out = await intl.Y({
    path: cache,
    installed: async () => ({ version: "5.7.6", bundle: "F:\\agent\\WorkBuddyAI" }),
  });
  eq(out.version, "5.7.6", "version");
  eq(out.source, "installed", "source");
  const saved = JSON.parse(readFileSync(cache, "utf8"));
  eq(saved.version, "5.7.6", "写回的缓存版本");
  rmSync(cache, { force: true });
});

console.log("\n【6】凭据：国际版桌面文件确实存在且是加密信封");

const authDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CodeBuddyExtension", "Data", "Public", "auth");
const intlFile = join(authDir, "workbuddy-desktop-ai.info");
const cnFile = join(authDir, "workbuddy-desktop.info");
await ok(`国际版凭据文件在共享 auth 目录里（${intlFile}）`, () => {
  // 本机装了国际版才有；没有也不该判失败 —— 这条是环境事实而非代码契约
  if (!existsSync(intlFile)) {
    console.log("      （本机未安装国际版客户端，跳过实文件检查）");
    return;
  }
  const text = readFileSync(intlFile, "utf8");
  eq(text.includes("$wbEncrypted"), true, "应含加密信封标记");
  const doc = JSON.parse(text);
  const auth = doc.auth ?? doc;
  eq(typeof auth.domain, "string", "auth.domain");
  eq(auth.domain, "www.workbuddy.ai", "国际版 domain");
});
await ok("国区与国区的凭据 basename 不同（否则两个产品会读同一份）", () => {
  const cn = intl.variantFor;
  // 直接用变体表断言，不依赖本机文件是否存在
  const v1 = intl.r.find((v) => v.region === "cn");
  const v4 = intl.r.find((v) => v.region === "global");
  assert.ok(v1 && v4, "应同时存在 cn 与 global 变体");
  if (v1.desktopFilename === v4.desktopFilename) throw new Error("两个区域不能共用同一个 desktopFilename");
});

console.log("\n【7】密钥助手：Windows 上必须可用（否则加密凭据打不开）");

await ok("没有已验证默认布局的平台返回 undefined，而不是猜一个路径", () => {
  const provider = new intl.E();
  const helper = provider.helperPath();
  if (process.platform === "darwin" || process.platform === "win32") {
    // 这两个平台有已验证来源（macOS bundle / Windows App 自述），装了就应解析出来。
    // 没装则为 undefined —— 两种情况都合法，关键是**不猜**。
    return;
  }
  eq(helper, undefined, `${process.platform} 的默认助手路径应为 undefined`);
});
await ok("显式 electronPath 会被采用（Windows / 国际版靠这条）", () => {
  const p = new intl.E({ electronPath: "F:\\agent\\WorkBuddyAI\\WorkBuddyAI.exe" });
  eq(p.helperPath(), "F:\\agent\\WorkBuddyAI\\WorkBuddyAI.exe", "helperPath");
});
await ok("密文助手输出必须是 {version:1, atRestSecretKey}，否则明确报错而不是静默失败", async () => {
  const secret = Buffer.alloc(32, 7).toString("base64");
  // 派生规则：key = sha256(secret 的 UTF-8)，keyId = sha256(key) 的前 16 位 hex。
  const key = createHash("sha256").update(secret, "utf8").digest();
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);

  const good = new intl.E({ source: async () => JSON.stringify({ version: 1, atRestSecretKey: secret }) });
  // protectorKeyFor 直接返回**密钥字节**（不是 {key,keyId} 包装对象）。
  const resolvedKey = await good.protectorKeyFor([keyId]);
  eq(resolvedKey.length, 32, "派生 key 长度");
  eq(createHash("sha256").update(resolvedKey).digest("hex").slice(0, 16), keyId, "返回的 key 能推出请求的 keyId");

  // 信封 keyId 不匹配时必须抛错（凭据被另一台安装密封的情形），不能静默用错钥匙。
  const other = new intl.E({ source: async () => JSON.stringify({ version: 1, atRestSecretKey: secret }) });
  let mismatchThrew = false;
  try {
    await other.protectorKeyFor(["0000000000000000"]);
  } catch {
    mismatchThrew = true;
  }
  eq(mismatchThrew, true, "keyId 不匹配必须抛错");

  const bad = new intl.E({ source: async () => "not json" });
  let threw = false;
  try {
    await bad.protectorKeyFor([keyId]);
  } catch {
    threw = true;
  }
  eq(threw, true, "坏载荷必须抛错");
});

console.log("\n【8】端到端：真实国际版凭据必须能被解出来（本机装了国际版时）");

/**
 * 这是 issue #1 的**真凭实据**：拿真实加密凭据 + 真实密钥助手，
 * 走 provider 自己那条读取路径，看能不能解出 `www.workbuddy.ai`。
 *
 * 为什么必须端到端：中间任何一环错都表现为"App 明明登录了、DSH 里却一直未登录"，
 * 而单元级的桩测试恰好会把这类接线错误全部放过（桩永远不抛错）。
 */
const intlExe = "F:\\agent\\WorkBuddyAI\\WorkBuddyAI.exe";
await ok("global 变体的默认候选里含国际版 App 的凭据文件", () => {
  const v4 = intl.r.find((v) => v.region === "global");
  const candidates = intl.C(v4);
  if (!candidates.some((p) => p.endsWith("workbuddy-desktop-ai.info"))) {
    throw new Error(`候选里没有国际版 basename: ${JSON.stringify(candidates)}`);
  }
});
await ok("cn 变体的默认候选里含国区 basename（两个产品不串）", () => {
  const v1 = intl.r.find((v) => v.region === "cn");
  const candidates = intl.C(v1);
  if (!candidates.some((p) => p.endsWith("workbuddy-desktop.info"))) {
    throw new Error(`候选里没有国区 basename: ${JSON.stringify(candidates)}`);
  }
  if (candidates.some((p) => p.endsWith("workbuddy-desktop-ai.info"))) {
    throw new Error("国区变体不该去读国际版的凭据");
  }
});
await ok(`真实国际版凭据能解出 domain=www.workbuddy.ai（用 ${intlExe} 当密钥助手）`, async () => {
  if (!existsSync(intlFile)) {
    console.log("      （本机未安装国际版客户端，跳过）");
    return;
  }
  if (!existsSync(intlExe)) {
    console.log(`      （本机没有 ${intlExe}，跳过实解）`);
    return;
  }
  const v4 = intl.r.find((v) => v.region === "global");
  // desktopPath 不传：正是修复后的行为（让 store 去探测 App 目录）。
  // 修复前这里会被塞进一个不存在的 connect-auth/workbuddy4.json 而读不到任何东西。
  const store = new intl.b({
    variant: v4,
    keyProvider: new intl.E({ electronPath: intlExe, timeoutMs: 30000 }),
    refresh: async () => {
      throw new Error("probe must not refresh");
    },
  });
  const credential = await store.current();
  assert.ok(credential, "应解出一份凭据（而不是 undefined）");
  eq(credential.domain, "www.workbuddy.ai", "解出的 domain");
  assert.ok(typeof credential.accessToken === "string" && credential.accessToken.length > 20, "accessToken 应为非空串");
  console.log(`      uid=${String(credential.uid).slice(0, 8)}… nickname=${credential.nickname ?? "(无)"}`);
});

console.log("\n【9】Windows 支持：默认助手路径与 app 版本号必须能自己找到");

/**
 * 这两条是 Windows 上"代码写了、功能却不通"的两个坑 —— 没有它们，国际版在
 * macOS 之外的机器上根本解不开凭据，UA 也永远停在编译期常量。
 */
await ok("win32 上默认 Electron 路径能自己解析出来（不再必须设环境变量）", () => {
  if (process.platform !== "win32") {
    console.log("      （非 win32，跳过）");
    return;
  }
  if (process.env.WORKBUDDY_ELECTRON_BIN) {
    console.log("      （已设 WORKBUDDY_ELECTRON_BIN，跳过默认解析）");
    return;
  }
  const p = new intl.E();
  const helper = p.helperPath();
  assert.ok(typeof helper === "string" && helper !== "", `预期解析出助手路径，实际 ${JSON.stringify(helper)}`);
  // 必须是真实存在的可执行文件 —— 猜一个 Program Files 下的路径是错的
  assert.ok(existsSync(helper), `解析出的路径必须存在：${helper}`);
  console.log(`      helper=${helper}`);
});
await ok("解析出的默认助手就是已安装 App 自己的 exe（不是别的程序）", () => {
  if (process.platform !== "win32" || process.env.WORKBUDDY_ELECTRON_BIN) return;
  const helper = new intl.E().helperPath();
  if (helper === undefined) return;
  assert.ok(/(?:WorkBuddyAI|WorkBuddy)\.exe$/iu.test(helper), `应指向 WorkBuddy 的 exe，实际 ${helper}`);
});
await ok("win32 上 app 版本从 App 自己的 last-launch.json 读，而不是停在编译期常量", async () => {
  if (process.platform !== "win32") {
    console.log("      （非 win32，跳过）");
    return;
  }
  // 不注入 installed：走真实的平台分支
  const out = await intl.Y({ path: join(tmpdir(), `dsh-intl-win-${Date.now()}.json`) });
  assert.ok(validLike(out.version), `版本形状不合法: ${out.version}`);
  if (out.source === "installed") {
    console.log(`      win32 读到真实版本 ${out.version}（source=installed）`);
    assert.ok(out.version !== "5.5.2", "不该还是编译期兜底 5.5.2");
  } else {
    console.log(`      （本机没有 last-launch.json，回落到 ${out.source}）`);
  }
});
await ok("区域选择器是添加渠道表单的一部分（前端可达）", () => {
  const src = readFileSync(join(REPO, "lib", "client.js"), "utf8");
  if (!src.includes("authFormRegion")) throw new Error("表单里没有区域选择器");
  if (!/act\("create", \{ kind: newKind, id: newId, displayName: newName[^}]*region: newRegion/.test(src)) {
    throw new Error("create 没有把 region 提交给面板");
  }
});
await ok("面板 create 会校验 region 白名单并写进注册表", () => {
  const src = readFileSync(join(REPO, "lib", "panel.js"), "utf8");
  if (!src.includes("CHANNEL_REGIONS")) throw new Error("panel 没有引入 CHANNEL_REGIONS");
  if (!/CHANNEL_REGIONS\.includes\(rawRegion\) \? rawRegion : undefined/.test(src)) {
    throw new Error("panel 没有对 region 做白名单校验");
  }
});

rmSync(stubDir, { recursive: true, force: true });

await chain;
console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
