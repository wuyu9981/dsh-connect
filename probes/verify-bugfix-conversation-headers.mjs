/**
 * Bug C 的回归探针（2026-10-17 用户报告）。
 *
 * ## 现象
 *
 * 国际版槽位（workbuddy4/5）昨天更新后，**每一条**消息都被上游拦下：
 *
 *   400 {"code":11128,"msg":"conversation id missing","requestId":"…",
 *        "displayTips":{"en":"This call failed channel verification,
 *        possibly because it was not sent from an official client…"}}
 *
 * ## 根因
 *
 * WorkBuddy AI 5.7 起，国际版 `/v2/chat/completions` 对请求做**抽样渠道校验**，
 * 要求携带官方桌面客户端的那套会话头族（`X-Conversation-ID` /
 * `-Request-ID` / `-Message-ID` / `X-Root-Request-ID`）。插件的
 * `chatHeaders` 一个都没带，所以被抽到的请求直接 400。
 *
 * 这不是插件自己的退化 —— 同期所有第三方反代（workbuddy2api-hub 的
 * #380/#383/#388/#392）都在报同一条。上游侧的对策是把四个头补齐
 * （PR #381，已被仓库合并），我们照做同一件事。
 *
 * ## 修复
 *
 * `chatHeaders` 在国际版（`regionOf(domain) === "global"`）时多带这四个头。
 * 插件没有自己的会话（DSH 每条消息都是新会话），所以每个请求现编一套 id，
 * 不重放旧值 —— 上游关联的正是请求 id，复用才是它要抓的谎。
 *
 * CN 不加：该校验只在国际版网关观测到过，给 CN 也编一个头是用未测过的偏差
 * 换已测过的偏差。
 *
 * ## 反向验证
 *
 * 撤掉 `...international ? conversationHeaders() : {}` 这一行，本探针必须变红。
 *
 * 用法：node probes/verify-bugfix-conversation-headers.mjs [--installed]
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedPackageDir } from "./_installed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.argv.includes("--installed") ? installedPackageDir() : join(HERE, "..");

let passed = 0;
let failed = 0;
const chain = [];
const ok = (label, fn) => chain.push({ label, fn });
const eq = (a, b, what) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// —— 桩宿主依赖，加载真实变体模块（与 verify-bugfix-intl-window-and-empty-slot.mjs 同一套）——
const stubDir = join(HERE, ".convhdr-stubs");
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

/** 用临时 DSH_HOME + 临时注册表驱动真实变体模块。 */
async function loadVariantsWith(registryChannels) {
	const home = join(tmpdir(), `dsh-convhdr-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_KEYS = [
	"X-Conversation-ID",
	"X-Conversation-Request-ID",
	"X-Conversation-Message-ID",
	"X-Root-Request-ID",
];

console.log("【C1】国际版 chatHeaders 必须带上会话头族");

const mod = await loadVariantsWith([
	{ id: "workbuddy1", kind: "workbuddy", displayName: "国区", region: "cn" },
	{ id: "workbuddy4", kind: "workbuddy", displayName: "国际版", region: "global" },
]);

/** 从真实模块里把上游客户端拿出来（`D` = WorkBuddyUpstreamClient）。 */
const UpstreamClient = mod.D;
assert.ok(UpstreamClient, "变体模块应导出上游客户端类");

ok("上游客户端类可从真实模块加载（后面几节要靠它构造实例）", () => {
	assert.equal(typeof UpstreamClient, "function", "导出的应是类");
});

console.log("\n【C2】四个键齐全、只在国际版出现");

const variantsSrc = read("lib/providers/workbuddy/variants-CnrmSn0Q.js");

ok("conversationHeaders 函数存在，且四个键一个不少", () => {
	const at = variantsSrc.indexOf("function conversationHeaders(");
	if (at === -1) throw new Error("找不到 conversationHeaders —— 会话头族没有实现（Bug C 复发）");
	const body = variantsSrc.slice(at, at + 500);
	for (const key of CONVERSATION_KEYS) {
		if (!body.includes(`"${key}"`)) throw new Error(`conversationHeaders 少了 ${key}`);
	}
});

ok("chatHeaders 把会话头族接到国际版分支上，CN 不带", () => {
	const at = variantsSrc.indexOf("function chatHeaders(");
	if (at === -1) throw new Error("找不到 chatHeaders");
	const body = variantsSrc.slice(at, at + 1400);
	if (!/const international = regionOf\(credential\.domain\) === "global"/.test(body)) {
		throw new Error("chatHeaders 没有按 domain 判国际版");
	}
	if (!/\.\.\.international \? conversationHeaders\(\) : \{\}/.test(body)) {
		throw new Error("chatHeaders 没有把 conversationHeaders 接到国际版分支 —— 这就是 Bug C 的修复点");
	}
});

ok("四个 id 都是每次现编（不是模块级常量、不是复用值）", () => {
	const at = variantsSrc.indexOf("function conversationHeaders(");
	const body = variantsSrc.slice(at, at + 500);
	for (const key of CONVERSATION_KEYS) {
		if (!new RegExp(`"${key}": randomUUID\\(\\)`).test(body)) {
			throw new Error(`${key} 不是 randomUUID() —— 复用或固定值会被上游识破`);
		}
	}
});

ok("randomUUID 已从 node:crypto 导入（少这一行就是运行时报错）", () => {
	if (!/import \{[^}]*randomUUID[^}]*\} from "node:crypto"/.test(variantsSrc)) {
		throw new Error("没有从 node:crypto 导入 randomUUID");
	}
});

console.log("\n【C3】行为层：真实客户端发出的请求头里确实有这四个键");

/**
 * 用打桩的 global fetch 抓一次真实的 `chatStream` 出站头。
 *
 * 不联网：fetch 桩直接返回一个 200 的空 SSE 响应，`chatStream` 会把它当作
 * 成功路径返回；我们要的只是它**发出**的那个 headers 对象。
 */
ok("国际版 chatStream 的出站头带齐四个会话 id，且每轮都不同", async () => {
	const home = join(tmpdir(), `dsh-convhdr-fetch-${Date.now()}`);
	mkdirSync(home, { recursive: true });
	const captured = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		captured.push({ url: String(url), headers: init?.headers ?? {} });
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const m = await import(`${pathToFileURL(VARIANTS).href}?fetch=${Date.now()}`);
		const Client = m.D;
		const client = new Client({
			resolveChatIdentity: async () => ({ clientVersion: "5.7.6" }),
		});
		const credential = {
			accessToken: "probe-token",
			refreshToken: "probe-refresh",
			uid: "uid-conv",
			domain: "workbuddy.ai",
			expiresAt: Date.now() + 3_600_000,
		};
		await client.chatStream(credential, JSON.stringify({ model: "deepseek-v4.1-flash", messages: [] }));
		await client.chatStream(credential, JSON.stringify({ model: "deepseek-v4.1-flash", messages: [] }));
	} finally {
		globalThis.fetch = realFetch;
		if (prevHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevHome;
		rmSync(home, { recursive: true, force: true });
	}
	eq(captured.length, 2, "发出两次请求");
	for (const [index, call] of captured.entries()) {
		if (!call.url.includes("/v2/chat/completions")) throw new Error(`第 ${index + 1} 次请求打的不是 chat 端点：${call.url}`);
		for (const key of CONVERSATION_KEYS) {
			const value = call.headers[key];
			if (value === undefined) throw new Error(`第 ${index + 1} 次请求缺 ${key} —— 上游 11128 就是抓这个`);
			if (!UUID.test(String(value))) throw new Error(`${key} 不是 UUID 形态：${String(value)}`);
		}
	}
	const first = captured[0].headers;
	const second = captured[1].headers;
	for (const key of CONVERSATION_KEYS) {
		if (first[key] === second[key]) {
			throw new Error(`${key} 两次请求完全相同 —— 复用会话 id 比不带更可疑`);
		}
	}
});

ok("国区 chatStream 的出站头**不**带会话头族（未测过的偏差不引入）", async () => {
	const home = join(tmpdir(), `dsh-convhdr-cn-${Date.now()}`);
	mkdirSync(home, { recursive: true });
	const captured = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		captured.push({ url: String(url), headers: init?.headers ?? {} });
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const m = await import(`${pathToFileURL(VARIANTS).href}?cn=${Date.now()}`);
		const Client = m.D;
		const client = new Client({
			resolveChatIdentity: async () => ({ clientVersion: "5.7.3" }),
		});
		const credential = {
			accessToken: "probe-token",
			refreshToken: "probe-refresh",
			uid: "uid-conv",
			domain: "www.codebuddy.cn",
			expiresAt: Date.now() + 3_600_000,
		};
		await client.chatStream(credential, JSON.stringify({ model: "deepseek-v4", messages: [] }));
	} finally {
		globalThis.fetch = realFetch;
		if (prevHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevHome;
		rmSync(home, { recursive: true, force: true });
	}
	eq(captured.length, 1, "发出一次请求");
	for (const key of CONVERSATION_KEYS) {
		if (captured[0].headers[key] !== undefined) {
			throw new Error(`国区请求也带了 ${key} —— 那是一条没验证过的偏差`);
		}
	}
});

console.log("\n【C4】原有的头一个都不能少（这次只做加法）");

ok("国际版请求仍带身份/产品块（会话头是增量，不是替换）", async () => {
	const home = join(tmpdir(), `dsh-convhdr-keep-${Date.now()}`);
	mkdirSync(home, { recursive: true });
	const captured = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		captured.push({ url: String(url), headers: init?.headers ?? {} });
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const prevHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const m = await import(`${pathToFileURL(VARIANTS).href}?keep=${Date.now()}`);
		const Client = m.D;
		const client = new Client({
			resolveChatIdentity: async () => ({ clientVersion: "5.7.6" }),
		});
		const credential = {
			accessToken: "probe-token",
			refreshToken: "probe-refresh",
			uid: "uid-conv",
			domain: "workbuddy.ai",
			enterpriseId: "ent-1",
			expiresAt: Date.now() + 3_600_000,
		};
		await client.chatStream(credential, JSON.stringify({ model: "deepseek-v4.1-flash", messages: [] }));
	} finally {
		globalThis.fetch = realFetch;
		if (prevHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevHome;
		rmSync(home, { recursive: true, force: true });
	}
	const headers = captured[0].headers;
	for (const key of [
		"Authorization",
		"Content-Type",
		"X-User-Id",
		"X-Enterprise-Id",
		"X-Domain",
		"X-Product",
		"X-IDE-Type",
		"X-IDE-Name",
		"X-Private-Data",
		"x-codebuddy-request",
		"X-Agent-Intent",
		"X-Agent-Purpose",
	]) {
		if (headers[key] === undefined) throw new Error(`原有的 ${key} 丢了 —— 会话头必须是增量`);
	}
	if (!String(headers["User-Agent"]).startsWith("WorkBuddy/")) {
		throw new Error(`桌面 UA 被覆盖了：${String(headers["User-Agent"])}`);
	}
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

rmSync(stubDir, { recursive: true, force: true });

console.log(`\nverify-bugfix-conversation-headers: ${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);

