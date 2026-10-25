/**
 * Bug A + Bug B 的回归探针（2026-10-11 用户报告）。
 *
 * ## Bug A —— 国际版 1M 上下文在 DSH 里被砍成 300K
 *
 * 上游对同一个模型同时声明多档窗口（实测 `deepseek-v4.1-flash`：
 * `contextWindow 300000` / `supportedContextWindows [300000, 1000000]`），
 * 而适配器只广告一档。用户在国际版客户端里能开 1M，DSH 里却只有 300K。
 *
 * 修复前的三个独立缺陷（缺一不可，本探针逐条钉死）：
 *   1. `catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true)`
 *      是一次性求值，而 `config` 恒为 `{}`（`lib/index.js` 用 `apply(ctx, {})`
 *      调用子模块），于是偏好**永远**是 false；
 *   2. 状态路由只在 `legacySettingsAvailable` 时才下发 `useMaximumContextWindow`，
 *      而那要求宿主有 `settings.installSection` —— 本机 DSH 没有，所以字段从不
 *      出现在状态文档里，复选框根本不渲染；
 *   3. 前端又把复选框钉在 `variant.id === AI_CARD_VARIANT.id`（= workbuddy2），
 *      于是 workbuddy4/5 这些国际版槽位即使拿到字段也永远不显示。
 *
 * ## Bug B —— 未认证的空槽位把模型漏进模型选择器
 *
 * 国际版槽位默认直接读桌面 App 的登录态，所以"刚添加、还没认证"的空槽位会立刻
 * 借 App 里那份凭据看起来已登录（实测：借到的是另一个槽位的账号），
 * `adoptIdentity` 据此 `catalog.setVisible(true)`，一整套模型进入选择器。
 *
 * 修复：注册表新增 `followDesktop`，**缺失按 true**（旧条目行为不变），
 * 面板新增的国际版槽位显式写 false ⇒ 只认 `connect-auth/<id>.json`。
 *
 * ## 反向验证
 *
 * 每条断言都对应一处可撤的修复；撤掉后本探针必须变红（已逐条实测）。
 *
 * 用法：node probes/verify-bugfix-intl-window-and-empty-slot.mjs [--installed]
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedPackageDir } from "./_installed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// `--installed` 走 `_installed.mjs`（按 profile 依赖键解析）：写死包名会在改名后
// 变成 ENOENT，而那看起来像断言失败、实际只是路径没了。
const REPO = process.argv.includes("--installed") ? installedPackageDir() : join(HERE, "..");

let passed = 0;
let failed = 0;
const chain = [];
const ok = (label, fn) => chain.push({ label, fn });
const eq = (a, b, what) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// —— 桩宿主依赖，加载真实变体模块（与 verify-workbuddy-intl.mjs 同一套）——
const stubDir = join(HERE, ".bugfix-stubs");
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
	// resolveDshHome 必须**每次调用**现读环境变量：本探针要把 DSH_HOME 指向临时目录。
	const body =
		spec === "@deepseek-ai/dsh-home-paths"
			? `export const resolveDshHome = () => process.env.DSH_HOME && process.env.DSH_HOME.trim() !== "" ? process.env.DSH_HOME : ${JSON.stringify(join(homedir(), ".dsh"))};\nexport default { resolveDshHome };\n`
			: spec === "@deepseek-ai/dsh-atomic-write"
				? `import { mkdirSync, writeFileSync, renameSync } from "node:fs";\nimport { dirname } from "node:path";\nexport async function writeFileAtomic(path, data, options = {}) { mkdirSync(dirname(path), { recursive: true, mode: options.dirMode ?? 0o700 }); const tmp = path + ".tmp"; writeFileSync(tmp, data, { mode: options.mode ?? 0o600 }); renameSync(tmp, path); }\nexport async function withFileLock(path, fn) { return await fn(); }\nexport default { writeFileAtomic, withFileLock };\n`
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
writeFileSync(loaderFile, `import { pathToFileURL } from "node:url";\nconst map=${JSON.stringify(stubMap)};\nexport async function resolve(s,c,n){ if(map[s]) return {url:pathToFileURL(map[s]).href,shortCircuit:true,format:"module"}; return n(s,c) }\n`);
const { register } = await import("node:module");
register(pathToFileURL(loaderFile).href, import.meta.url);

const VARIANTS = join(REPO, "lib", "providers", "workbuddy", "variants-CnrmSn0Q.js");
const REGISTRY = join(REPO, "lib", "channel-registry.js");

/** 用临时 DSH_HOME + 临时注册表驱动真实变体表（检验加载路径上的行为，不读源码文本）。 */
async function loadVariantsWith(registryChannels) {
	const home = join(tmpdir(), `dsh-bugfix-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "connect-channels.json"), `${JSON.stringify({ version: 1, channels: registryChannels }, null, 2)}\n`);
	const prev = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		return await import(`${pathToFileURL(VARIANTS).href}?home=${encodeURIComponent(home)}`);
	} finally {
		if (prev === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prev;
	}
}

console.log("【A1】最大窗口偏好：catalog 必须**现读**偏好，而不是构造时快照");

const mod = await loadVariantsWith([
	{ id: "workbuddy1", kind: "workbuddy", displayName: "CN", region: "cn" },
	{ id: "workbuddy4", kind: "workbuddy", displayName: "国际版", region: "global" },
]);
const Catalog = mod._;
/** 上游实测形状：一档默认 300K，同时声明 300K / 1M 两档可选。 */
const MODEL = {
	id: "deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash",
	contextWindow: 300000,
	supportedContextWindows: [300000, 1000000],
};

ok("默认不提升（直接构造的 catalog 行为不变，不因新开关而变）", () => {
	const catalog = new Catalog([MODEL]);
	eq(catalog.current()[0].contextWindow, 300000, "默认 contextWindow");
});

ok("偏好为 true 时广告最大窗口 1M", () => {
	const catalog = new Catalog([MODEL]);
	catalog.setMaximumContextWindowSource(() => true);
	eq(catalog.current()[0].contextWindow, 1000000, "contextWindow");
});

ok("偏好**改了立刻生效**（惰性读：这是 Bug A 的核心，快照实现会在这里变红）", () => {
	let flag = false;
	const catalog = new Catalog([MODEL]);
	catalog.setMaximumContextWindowSource(() => flag);
	eq(catalog.current()[0].contextWindow, 300000, "关掉时");
	flag = true;
	eq(catalog.current()[0].contextWindow, 1000000, "打开后（同一次构造、无重建）");
	flag = false;
	eq(catalog.current()[0].contextWindow, 300000, "再关掉");
});

ok("提升时保留原默认档（回退信息不丢）", () => {
	const catalog = new Catalog([MODEL]);
	catalog.setMaximumContextWindowSource(() => true);
	const promoted = catalog.current()[0];
	eq(promoted.defaultContextWindow, 300000, "defaultContextWindow 记录原档");
	eq(promoted.contextWindow, 1000000, "contextWindow 用最大档");
});

ok("模型没声明多档窗口时不受偏好影响", () => {
	const catalog = new Catalog([{ id: "m", name: "M", contextWindow: 128000 }]);
	catalog.setMaximumContextWindowSource(() => true);
	eq(catalog.current()[0].contextWindow, 128000, "contextWindow");
});

ok("非函数来源重置为**不提升**（坏来源不得凭空广告窗口）", () => {
	const catalog = new Catalog([MODEL]);
	catalog.setMaximumContextWindowSource(() => true);
	catalog.setMaximumContextWindowSource(undefined);
	eq(catalog.current()[0].contextWindow, 300000, "重置后 contextWindow");
});

ok("隐藏的 catalog 不因偏好而泄漏模型（可见性门仍然优先）", () => {
	const catalog = new Catalog([MODEL]);
	catalog.setMaximumContextWindowSource(() => true);
	catalog.setVisible(false);
	eq(catalog.current(), [], "current()");
});

console.log("\n【A2】偏好必须挂在面板/插件自己的 Config 上，并由 index.js 注入 provider");

ok("HUB_SECTION 有 useMaximumContextWindow 字段且默认 true", () => {
	const src = read("lib/panel.js");
	if (!/useMaximumContextWindow:\s*z\.boolean\(\)\.default\(true\)/.test(src)) {
		throw new Error("HUB_SECTION 里没有 useMaximumContextWindow（默认 true）");
	}
	if (!/HUB_DEFAULTS\s*=\s*\{[^}]*useMaximumContextWindow:\s*true/.test(src)) {
		throw new Error("HUB_DEFAULTS 缺 useMaximumContextWindow: true");
	}
});

ok("resolvePrefs 默认 true，且只有显式 false 才算关掉", () => {
	const src = read("lib/panel.js");
	if (!/useMaximumContextWindow:\s*source\.useMaximumContextWindow !== false/.test(src)) {
		throw new Error("resolvePrefs 没有「缺省 true、显式 false 才关」的收敛规则");
	}
});

ok("panel 导出 hubPreferences 读写通道，write 由 settings 注入填充", () => {
	const src = read("lib/panel.js");
	if (!/export const hubPreferences = \{/.test(src)) throw new Error("panel 没有导出 hubPreferences");
	if (!/hubPreferences\.write = async/.test(src)) throw new Error("hubPreferences.write 没有在 settings 注入里赋值");
	if (!/settingsApi = svc/.test(src)) throw new Error("settings 注入没有留下 settingsApi");
});

ok("面板 POST /settings 的写入白名单含 useMaximumContextWindow", () => {
	const src = read("lib/panel.js");
	if (!/typeof patch\?\.useMaximumContextWindow === "boolean"/.test(src)) {
		throw new Error("POST /settings 不接受 useMaximumContextWindow（前端勾了也写不进去）");
	}
});

ok("index.js 把 hubPreferences 注入 workbuddy（不是快照，是对象本身）", () => {
	const src = read("lib/index.js");
	if (!/import \{[^}]*hubPreferences[^}]*\} from "\.\/panel\.js"/.test(src)) {
		throw new Error("index.js 没有引入 hubPreferences");
	}
	if (!/workbuddy\.setPreferences\(hubPreferences\)/.test(src)) {
		throw new Error("index.js 没有把 hubPreferences 注入 workbuddy —— 偏好永远读不到（Bug A 的根因）");
	}
});

ok("workbuddy 的 setPreferences 存的是对象本身（write 晚到也能用）", () => {
	const src = read("lib/providers/workbuddy/index.js");
	if (!/export function setPreferences\(preferences\)/.test(src)) throw new Error("workbuddy 没有导出 setPreferences");
	if (!/hubPreferences\s*=\s*preferences/.test(src)) throw new Error("setPreferences 没有保存注入对象");
	if (!/hubPreferences\?\.read\?\.\(\)\?\.useMaximumContextWindow !== false/.test(src)) {
		throw new Error("maximumContextWindowEnabled 没有走 hubPreferences.read()（读配置就又是死路）");
	}
});

ok("workbuddy 的窗口写入走 hubPreferences.write，写不进去就如实报失败", () => {
	const src = read("lib/providers/workbuddy/index.js");
	const at = src.indexOf("async function writeMaximumContextWindow(");
	if (at === -1) throw new Error("找不到 writeMaximumContextWindow");
	const body = src.slice(at, at + 600);
	if (!/typeof write !== "function"|typeof hubPreferences\?\.write !== "function"/.test(body)) {
		throw new Error("writeMaximumContextWindow 没有判断 write 是否可用 —— write 缺席时会静默吞掉用户的勾选");
	}
	if (!/state: "failed"/.test(body)) {
		throw new Error("writeMaximumContextWindow 在不可写时没有返回 failed（前端只认 updated，会把没存下的勾选当成事实）");
	}
	if (!/await write\(\{ useMaximumContextWindow: enabled === true \}\)/.test(body)) {
		throw new Error("writeMaximumContextWindow 没有写 useMaximumContextWindow");
	}
});

ok("国际版变体把 catalog 的窗口来源接到活偏好上（国区不接）", () => {
	const src = read("lib/providers/workbuddy/index.js");
	if (!/if \(variant\.region === "global"\) catalog\.setMaximumContextWindowSource\(maximumContextWindowEnabled\)/.test(src)) {
		throw new Error("国际版 catalog 没有接上 maximumContextWindowEnabled —— 惰性读源没接线，等于偏好永远不生效");
	}
});

ok("状态路由对**任意国际版槽位**下发该字段（不再被 legacySettingsAvailable 门住）", () => {
	const src = read("lib/providers/workbuddy/index.js");
	if (/legacySettingsAvailable/.test(src)) {
		throw new Error("legacySettingsAvailable 还在 —— 它要求 settings.installSection，本机宿主没有，字段会从不出现");
	}
	if (!/runtime\.variant\.region === "cn" \? \{\} : \{ useMaximumContextWindow: maximumContextWindowField \}/.test(src)) {
		throw new Error("状态路由没有按 region 下发 useMaximumContextWindow");
	}
});

ok("窗口写路由只对国际版注册，且成功后才重算目录", () => {
	const src = read("lib/providers/workbuddy/index.js");
	const at = src.indexOf('...runtime.variant.region === "cn" ? {} : { setMaximumContextWindow');
	if (at === -1) throw new Error("探针路由没有注册 setMaximumContextWindow");
	const body = src.slice(at, at + 420);
	if (!/writeMaximumContextWindow\(enabled\)/.test(body)) throw new Error("写路由没有调用 writeMaximumContextWindow");
	if (!/result\.state === "updated"\) runtime\.invalidate\(\)/.test(body)) {
		throw new Error("写路由在写入失败时也会 invalidate —— 界面会把没生效的勾选当成事实");
	}
});

ok("前端复选框不再按卡片 id 门控（只看后端给不给字段）", () => {
	const src = read("lib/client.js");
	if (/variant\.id === AI_CARD_VARIANT\.id && status\.useMaximumContextWindow !== void 0/.test(src)) {
		throw new Error("复选框仍钉在 workbuddy2 上 —— workbuddy4/5 永远看不到（Bug A 的第三个缺陷）");
	}
	if (!/\.\.\.status\.useMaximumContextWindow !== void 0 \? \{\n\t*\s*useMaximumContextWindow: status\.useMaximumContextWindow/.test(src)) {
		throw new Error("ContextTable 没有按 status.useMaximumContextWindow 是否下发给偏好");
	}
});

console.log("\n【B1】followDesktop：注册表缺省跟随、新增槽位不跟随");

const registryMod = await import(pathToFileURL(REGISTRY).href);
ok("内置默认表里只有国际版那一条声明 followDesktop: true", () => {
	const withFlag = registryMod.DEFAULT_REGISTRY_CHANNELS.filter((entry) => entry.followDesktop !== undefined);
	eq(withFlag.map((entry) => entry.id), ["workbuddy4"], "带 followDesktop 的条目");
	eq(withFlag[0].followDesktop, true, "workbuddy4 followDesktop");
});

ok("旧注册表（无 followDesktop）条目仍然跟随桌面 App（行为不变）", async () => {
	const legacy = await loadVariantsWith([{ id: "workbuddy4", kind: "workbuddy", displayName: "国际版", region: "global" }]);
	eq(legacy.i("workbuddy4").followDesktop, true, "followDesktop");
});

ok("显式 false 的条目解析为不跟随", async () => {
	const own = await loadVariantsWith([
		{ id: "workbuddy5", kind: "workbuddy", displayName: "国际版 2", region: "global", followDesktop: false },
	]);
	eq(own.i("workbuddy5").followDesktop, false, "followDesktop");
});

ok("channelOf 不再透出 region/followDesktop（那是策略不是状态，界面已不再显示）", () => {
	/**
	 * 这两个字段原先只喂给认证页那个「跟随桌面 App」chip。那个 chip 讲的是
	 * 「**允许**回落桌面凭据」这条策略，而它显示的现象（空槽位看起来已登录）
	 * 正是本 bug 修掉的东西；实测它在已扫码的槽位上还给出与事实相反的描述
	 * （槽位用的是自己扫码的号，不是桌面 App 的号），所以整个撤掉。
	 *
	 * `followDesktop` 的**判定逻辑**当然还在（见 B2/B3 与 provider 侧），
	 * 只是不再往界面透 —— 这条断言钉的就是"别再透出来"。
	 */
	const intl = registryMod.channelOf({ id: "workbuddy4", kind: "workbuddy", displayName: "国际版", region: "global" });
	eq("followDesktop" in intl, false, "国际版不该透出 followDesktop");
	eq("region" in intl, false, "国际版不该透出 region");
	const cn = registryMod.channelOf({ id: "workbuddy1", kind: "workbuddy", displayName: "国区", region: "cn" });
	eq("followDesktop" in cn, false, "国区槽位不该有 followDesktop 字段");
	eq("region" in cn, false, "国区槽位不该有 region 字段");
});

console.log("\n【B2】空槽位：不跟随 ⇒ 绝不探测桌面 App 的凭据");

/**
 * 这是 Bug B 的**决定性**断言：直接驱动真实 `WorkBuddyCredentialStore`。
 * 桌面 App 的凭据文件在本机真实存在（装了国际版），所以"不跟随"的槽位一旦
 * 落到平台默认探测，就会借到那份凭据 —— 而它属于另一个账号。
 */
const CredentialStore = mod.b;
const tempHome = join(tmpdir(), `dsh-bugfix-home-${Date.now()}`);
mkdirSync(tempHome, { recursive: true });
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = tempHome;
const freshOwn = await loadVariantsWith([
	{ id: "workbuddy9", kind: "workbuddy", displayName: "空槽位", region: "global", followDesktop: false },
]);
process.env.DSH_HOME = prevHome;

const freshVariant = freshOwn.i("workbuddy9");
assert.ok(freshVariant, "workbuddy9 变体应存在");

ok("不跟随的国际版槽位：候选里**没有**桌面 App 的 basename", () => {
	const store = new CredentialStore({ variant: freshVariant, refresh: async () => undefined });
	const candidates = store.resolveDesktopCandidates();
	if (candidates.some((path) => path.endsWith("workbuddy-desktop-ai.info"))) {
		throw new Error(`不跟随的槽位仍在探测桌面 App 的凭据：${JSON.stringify(candidates)}`);
	}
	eq(candidates.length, 1, "候选数");
	assert.ok(candidates[0].endsWith(join("connect-auth", "workbuddy9.json")), `候选应是自己的落点，实际 ${candidates[0]}`);
});

ok("不跟随的空槽位状态是 signed-out（模型不会漏进选择器）", async () => {
	const store = new CredentialStore({ variant: freshVariant, refresh: async () => undefined });
	const status = await store.status();
	eq(status.state, "signed-out", "status.state");
});

ok("跟随的国际版槽位仍然探测桌面 App（老部署不能被这次修复弄丢登录态）", () => {
	const followVariant = { ...freshVariant, id: "workbuddy8", followDesktop: true, env: "WORKBUDDY8_AUTH_FILE" };
	const store = new CredentialStore({ variant: followVariant, refresh: async () => undefined });
	const candidates = store.resolveDesktopCandidates();
	if (!candidates.some((path) => path.endsWith("workbuddy-desktop-ai.info"))) {
		throw new Error(`跟随的槽位读不到桌面 App 的凭据：${JSON.stringify(candidates)}`);
	}
});

ok("显式 desktopPath 仍然只认它一个（不因区域分支而回头探测）", () => {
	const store = new CredentialStore({ variant: freshVariant, desktopPath: "C:\\tmp\\explicit.json", refresh: async () => undefined });
	eq(store.resolveDesktopCandidates(), ["C:\\tmp\\explicit.json"], "候选");
});

ok("provider 侧 configuredAuthFile 对不跟随的槽位给出自己的落点", () => {
	const src = read("lib/providers/workbuddy/index.js");
	if (!/if \(variant\.followDesktop !== true\) return join\(resolveDshHome\(\), "connect-auth", `\$\{variant\.id\}\.json`\)/.test(src)) {
		throw new Error("configuredAuthFile 没有按 followDesktop 分流 —— 不跟随的槽位会回落到桌面 App");
	}
});

console.log("\n【B3】前端：新增槽位默认不跟随，且能显式勾选");

ok("client 表单默认 followDesktop 关，且有对应开关", () => {
	const src = read("lib/client.js");
	if (!/const \[newFollowDesktop, setNewFollowDesktop\] = react\.useState\(false\)/.test(src)) {
		throw new Error("表单没有 newFollowDesktop 状态（默认 false）");
	}
	if (!/newRegion === "global"\s*\n?\s*\?\s*react\.createElement/.test(src) && !src.includes("authFormFollowDesktop")) {
		throw new Error("表单没有渲染「跟随桌面 App」开关");
	}
	if (!/setNewFollowDesktop\(false\)/.test(src)) throw new Error("表单重置没有把开关复位");
});

ok("client create 提交 followDesktop（只在国际版提交）", () => {
	const src = read("lib/client.js");
	if (!/newRegion === "global" \? \{ followDesktop: newFollowDesktop === true \} : \{\}/.test(src)) {
		throw new Error("create 没有把 followDesktop 提交给面板");
	}
});

ok("面板 create 把 followDesktop 写进注册表（只对国际版）", () => {
	const src = read("lib/panel.js");
	if (!/kind === "workbuddy" && region === "global" \? body\?\.followDesktop === true : undefined/.test(src)) {
		throw new Error("面板 create 没有收敛 followDesktop（缺省必须是不跟随）");
	}
	if (!/\.\.\.followDesktop === undefined \? \{\} : \{ followDesktop \}/.test(src)) {
		throw new Error("面板 create 没有把 followDesktop 写进条目");
	}
});

ok("认证页不再渲染「跟随桌面 App」chip（那是策略，不是这个槽位在用什么）", () => {
	const panel = read("lib/panel.js");
	/**
	 * 这个 chip 已被**有意删除**（2026-10-11，用户要求）：
	 *   · 它显示的是「**允许**回落桌面凭据」这条策略，而 tooltip 写成「该槽位的凭据
	 *     直接读桌面客户端的登录态 —— 桌面端登录什么号，这里就是什么号」；
	 *   · 实测在已扫码的槽位上是**错的**：workbuddy4/5 用的是各自扫码登录的号
	 *     （`signedInBy === "scan"` 优先），与桌面 App 那份凭据（另一个账号）无关；
	 *   · 它要解释的现象（空槽位看起来已登录）正是本次修复消掉的东西。
	 * 判定逻辑保留（B2/B3 与 provider 侧都还依赖它），只是不再透到界面。
	 */
	if (/authFollowDesktopOn|authFollowDesktopOff|authFollowDesktopHint|authOwnCredentialHint/.test(panel)) {
		throw new Error("panel 还在透出凭据来源标记的字段");
	}
	const client = read("lib/client.js");
	for (const key of ["authFollowDesktopOn", "authFollowDesktopOff", "authFollowDesktopHint", "authOwnCredentialHint"]) {
		if (client.includes(key)) throw new Error(`client 里还留着已删除的文案键 ${key}`);
	}
	// 添加渠道表单那个复选框**必须留着**：它才是真正决定新槽位行为的开关。
	if (!/authFormFollowDesktop/.test(client)) {
		throw new Error("添加渠道表单的「跟随桌面 App」复选框被误删了（那个是有用的）");
	}
});

/**
 * 【A4】窗口开关搬到面板行上（2026-10-11 用户要求）。
 *
 * 以前它只藏在 workbuddy 设置卡片的 Context 页里，而面板才是用户管渠道的地方 ——
 * 不搜就找不到。现在做成模型数旁边的一个 chip，值来自后端下发的
 * `maximumContextWindow`（见 panel.js 的 normalizeChannel）。
 */
console.log("\n【A4】最大窗口开关：搬到面板渠道行、紧挨模型数");

ok("面板把 provider 的窗口偏好透到行上（只在国际版下发时才带）", () => {
	const src = read("lib/panel.js");
	if (!/\.\.\.typeof raw\.useMaximumContextWindow === "boolean" \? \{ maximumContextWindow: raw\.useMaximumContextWindow \} : \{\}/.test(src)) {
		throw new Error("normalizeChannel 没有把 useMaximumContextWindow 透成行的 maximumContextWindow");
	}
});

/**
 * 这一条走**真实的 `normalizeChannel`**（从 panel.js 里 load 出来），而不是搜源码文本：
 * 它是「provider 的状态文档 → 面板行」那一跳，前面所有断言都没覆盖。
 * 顺手钉住"只有 boolean 才透" —— 缺字段（国区 / 写通道不可用）时不能凭空给一个 false，
 * 那会让界面在国区槽位上也画出一个点不动的开关。
 */
ok("真实 normalizeChannel：有字段才透，且只认 boolean", async () => {
	const panel = await import(`${pathToFileURL(join(REPO, "lib", "panel.js")).href}?a4=${Date.now()}`);
	const channel = { id: "workbuddy4", provider: "workbuddy4", displayName: "国际版", kind: "workbuddy" };
	const signedIn = (extra) => ({
		status: "signed-in",
		nickname: "u",
		...extra,
	});
	eq(
		panel.normalizeChannel(channel, signedIn({ useMaximumContextWindow: true })).maximumContextWindow,
		true,
		"开着时透出 true",
	);
	eq(
		panel.normalizeChannel(channel, signedIn({ useMaximumContextWindow: false })).maximumContextWindow,
		false,
		"关着时透出 false",
	);
	eq(
		"maximumContextWindow" in panel.normalizeChannel(channel, signedIn({})),
		false,
		"provider 没下发时行里不该有这个字段（国区槽位否则会画一个点不动的开关）",
	);
	eq(
		"maximumContextWindow" in panel.normalizeChannel(channel, signedIn({ useMaximumContextWindow: "yes" })),
		false,
		"非 boolean 一律不透（半个值比没有更糟）",
	);
});

ok("渠道行在模型数旁边渲染这个开关，且按值分两态", () => {
	const src = read("lib/client.js");
	if (!/row\.maximumContextWindow === undefined\s*\?\s*null/.test(src)) {
		throw new Error("ChannelRow 没有按 maximumContextWindow 是否存在决定显不显示");
	}
	for (const key of ["maxContextOn", "maxContextOff", "maxContextOnHint", "maxContextOffHint"]) {
		const hits = (src.match(new RegExp(`\\b${key}:`, "g")) ?? []).length;
		if (hits < 2) throw new Error(`文案键 ${key} 只出现 ${hits} 次（中英各需一次）`);
	}
});

ok("开关写的是面板 /settings（不是 provider 探针路由），且写完重拉模型列表", () => {
	const src = read("lib/client.js");
	const at = src.indexOf("const onToggleMaximumContext = async (");
	if (at === -1) throw new Error("找不到 onToggleMaximumContext");
	const body = src.slice(at, at + 900);
	if (!/fetch\(SETTINGS_PATH/.test(body)) {
		throw new Error("开关没有走面板 /settings —— 那是这个偏好唯一的写入白名单所在");
	}
	if (!/useMaximumContextWindow: enabled/.test(body)) throw new Error("开关没有提交 useMaximumContextWindow");
	if (!/reload\(\)/.test(body)) {
		throw new Error("开关写完没有重拉状态 —— 模型窗口变了但界面还是旧的（自相矛盾）");
	}
});

ok("开关是全局偏好，改完要广播模型更新（否则选择器里还是旧窗口）", () => {
	const src = read("lib/panel.js");
	const at = src.indexOf("const resolved = deps.prefs();");
	if (at === -1) throw new Error("找不到 POST /settings 的回读处");
	const body = src.slice(at, at + 500);
	if (!/deps\.onModelsChanged\?\.\(\)/.test(body)) {
		throw new Error("窗口偏好改完没有 onModelsChanged —— 宿主缓存着旧的模型列表，选择器里窗口不会变");
	}
});

ok("中英文案都补齐了新增的键（缺一个就是界面上显示原始 key）", () => {	const src = read("lib/client.js");
	for (const key of ["authFormFollowDesktop"]) {
		const hits = (src.match(new RegExp(`\\b${key}:`, "g")) ?? []).length;
		if (hits < 2) throw new Error(`文案键 ${key} 只出现 ${hits} 次（中英各需一次）`);
	}
});

console.log("\n【A3】端到端：用假宿主挂载真实 apply，直接打它注册的状态路由");

/**
 * 【A2】钉的是源码文本，【A1】钉的是 catalog 行为；这一节把两者接起来 ——
 * 挂载**真实的 `apply()`**，让插件自己注册路由，然后像面板那样发一次 GET，
 * 断言状态文档里的字段与模型窗口。这是唯一能证明"改完真的会在界面上生效"的一层，
 * 也是 Bug A 三个缺陷里第 1、2 个（配置恒空 + 字段被门住）的联合回归点。
 */
const WORKBUDDY_INDEX = join(REPO, "lib", "providers", "workbuddy", "index.js");

/**
 * 只挂载**一次**，注册表里同时放"已登录的国际版槽位 4"和"空槽位 9"。
 *
 * 为什么不能每个断言各挂一次：provider 变体表是在**模块加载时**按注册表生成的，
 * 而 Node 按 URL 缓存模块 —— `index.js` 能靠查询串换 URL，它 `import` 的
 * `variants-*.js` 却是固定 URL，第二次挂载会静默复用第一次的变体表（于是新槽位
 * 根本没有路由）。挂一次、把两个槽位都放进注册表，既绕开这个缓存，也更贴近真实部署。
 *
 * 偏好用**可变闭包**驱动：`setPreferences` 存的是对象本身，所以挂载后翻转 `prefFlag`
 * 就能验证"改完立刻生效"——这正是 Bug A 的核心（一次性快照实现会在这里变红）。
 */
let prefFlag = true;
let mounted;
async function ensureMounted() {
	if (mounted !== undefined) return mounted;
	const home = join(tmpdir(), `dsh-a3-home-${Date.now()}`);
	await seedRealSnapshot(home);
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "connect-channels.json"), `${JSON.stringify({
		version: 1,
		channels: [
			{ id: "workbuddy4", kind: "workbuddy", displayName: "国际版", region: "global", followDesktop: false },
			{ id: "workbuddy9", kind: "workbuddy", displayName: "空槽位", region: "global", followDesktop: false },
		],
	}, null, 2)}\n`);
	process.env.DSH_HOME = home;
	const mod = await import(`${pathToFileURL(WORKBUDDY_INDEX).href}?a3=${Date.now()}`);
	const routes = new Map();
	const written = [];
	mod.setPreferences({
		read: () => ({ useMaximumContextWindow: prefFlag }),
		write: async (patch) => { written.push(patch); return {}; },
	});
	mod.apply({
		logger: { info() {}, warn() {}, error() {} },
		get: () => undefined,
		emit() {},
		effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
		llm: { registerAdapter: () => () => {} },
		inject: (deps, cb) => {
			if (Array.isArray(deps) && deps.includes("webServer")) {
				cb({
					webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path); } },
					effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
					logger: { info() {}, warn() {}, error() {} },
					get: () => undefined,
					emit() {},
				});
			}
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 1200));
	mounted = { mod, routes, written, home };
	return mounted;
}

/**
 * 把本机**真实的** workbuddy4 凭据/目录快照拷进临时 HOME（源文件只读不动）。
 *
 * 用真快照而不是合成数据，是因为 Bug A 的现场就在这份目录里：
 * `deepseek-v4.1-flash` 的 `contextWindow 300000` + `supportedContextWindows [300000, 1000000]`。
 */
async function seedRealSnapshot(home) {
	if (!existsSync(REAL_AUTH) || !existsSync(REAL_CATALOG)) return;
	mkdirSync(home, { recursive: true });
	const { copyFileSync } = await import("node:fs");
	copyFileSync(REAL_AUTH, join(home, ".workbuddy4-auth.json"));
	copyFileSync(REAL_CATALOG, join(home, ".workbuddy4-catalog.json"));
}

/** 真实凭据/目录快照在本机存在才跑（探针在别的机器上不该因此变红）。 */
const REAL_AUTH = join(homedir(), ".dsh", ".workbuddy4-auth.json");
const REAL_CATALOG = join(homedir(), ".dsh", ".workbuddy4-catalog.json");
const haveReal = existsSync(REAL_AUTH) && existsSync(REAL_CATALOG);
const skipNoSnapshot = () => {
	if (haveReal) return false;
	console.log("      （跳过：本机没有 .workbuddy4-auth.json / -catalog.json）");
	return true;
};

/** 像面板那样发一次请求：假 req 必须异步可迭代（`readBody` 用 `for await` 读体）。 */
function request(routes, path, { method = "GET", body, headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const handler = routes.get(path);
		if (handler === undefined) { reject(new Error(`路由未注册：${path}`)); return; }
		const payload = body === undefined ? "" : JSON.stringify(body);
		const req = {
			method,
			headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387", ...headers },
			socket: { remoteAddress: "127.0.0.1" },
			url: path,
			on() { return req; },
			async *[Symbol.asyncIterator]() { if (payload !== "") yield Buffer.from(payload); },
		};
		let text = "";
		const res = {
			statusCode: 0,
			setHeader() {},
			writeHead(code) { res.statusCode = code; },
			end(chunk) { if (chunk) text += chunk; resolve({ status: res.statusCode, body: text }); },
		};
		try {
			const outcome = handler(req, res);
			if (outcome !== undefined && typeof outcome.then === "function") outcome.catch(reject);
		} catch (error) {
			reject(error);
		}
	});
}

ok("端到端：已登录的国际版槽位，状态文档带 useMaximumContextWindow=true 且模型广告 1M 窗口", async () => {
	if (skipNoSnapshot()) return;
	const { routes } = await ensureMounted();
	const doc = JSON.parse((await request(routes, "/plugins/dsh-workbuddy-connect/4/status")).body);
	eq(doc.status, "signed-in", "状态文档的 status");
	eq(doc.useMaximumContextWindow, true, "状态文档的 useMaximumContextWindow（缺失即 Bug A 缺陷 2 复发）");
	const flash = (doc.models ?? []).find((model) => model.id === "deepseek-v4.1-flash");
	assert.ok(flash !== undefined, "状态文档里应列出 deepseek-v4.1-flash");
	eq(flash.contextWindow, 1000000, "deepseek-v4.1-flash 的 contextWindow（300000 即 Bug A 复发）");
	eq(flash.defaultContextWindow, 300000, "回退档必须同时透出（否则用户不知道关掉会变成多少）");
});

ok("端到端反向：同一个已挂载实例上把偏好翻成 false，窗口立刻退回 300K", async () => {
	if (skipNoSnapshot()) return;
	const { routes } = await ensureMounted();
	prefFlag = false;
	try {
		const doc = JSON.parse((await request(routes, "/plugins/dsh-workbuddy-connect/4/status")).body);
		eq(doc.useMaximumContextWindow, false, "状态文档的 useMaximumContextWindow");
		const flash = (doc.models ?? []).find((model) => model.id === "deepseek-v4.1-flash");
		eq(flash.contextWindow, 300000, "关掉后的 contextWindow 应回到上游默认档");
	} finally {
		prefFlag = true;
	}
});

ok("端到端：未认证的槽位没有该字段（前端因此不渲染复选框），也没有任何模型", async () => {
	const { routes } = await ensureMounted();
	const doc = JSON.parse((await request(routes, "/plugins/dsh-workbuddy-connect/9/status")).body);
	eq(doc.status, "signed-out", "状态文档的 status");
	eq("useMaximumContextWindow" in doc, false, "未登录不该下发窗口偏好字段（没有窗口可谈）");
	eq(doc.models, undefined, "未登录不该下发任何模型（Bug B 的界面侧证据）");
});

ok("端到端：探针路由能真的写回偏好（返回 updated，并把 patch 交给面板）", async () => {
	if (skipNoSnapshot()) return;
	const { routes, written } = await ensureMounted();
	const doc = JSON.parse((await request(routes, "/plugins/dsh-workbuddy-connect/4/status")).body);
	const res = await request(routes, "/plugins/dsh-workbuddy-connect/4/probe", {
		method: "POST",
		headers: { "x-workbuddy-probe-key": String(doc.probeKey ?? "") },
		body: { action: "set-maximum-context-window", enabled: false, key: doc.probeKey },
	});
	eq(res.status, 200, "写路由的 HTTP 状态");
	eq(JSON.parse(res.body).state, "updated", "写路由的返回状态");
	eq(written, [{ useMaximumContextWindow: false }], "交给面板的 patch");
});

for (const { label, fn } of chain) {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed++;
		console.log(`  ✗ ${label}\n      ${error && error.message}`);
	}
}

// 桩与临时目录必须等**所有**断言跑完再删：断言里的惰性 import 还要靠它们解析。
rmSync(stubDir, { recursive: true, force: true });
rmSync(tempHome, { recursive: true, force: true });
if (mounted !== undefined) rmSync(mounted.home, { recursive: true, force: true });

console.log(`\nverify-bugfix-intl-window-and-empty-slot: ${passed} 通过 / ${failed} 失败`);
/**
 * 必须显式退出：`ensureMounted` 挂的是真实 `apply`，它启动了心跳与巡检定时器
 * （`setInterval`），事件循环不会自己空掉 —— 不加这一行，探针跑完全绿也永远不返回。
 */
process.exit(failed > 0 ? 1 : 0);
