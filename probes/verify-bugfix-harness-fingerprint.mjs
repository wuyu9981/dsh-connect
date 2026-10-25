/**
 * Bug D 的回归探针（2026-10-21 用户报告，第二版）。
 *
 * ## 现象
 *
 * WorkBuddy 国区槽位报 400，文案与国际版此前那条同类但不同：
 *
 *   400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 *        "displayTips":{"en":"This call failed channel verification,
 *        possibly because it was not sent from an official client…"}}
 *
 * ## 根因
 *
 * 上游的渠道校验除了看请求头，还看**请求文本里的 vendor 指纹**。DSH 的系统
 * 提示首句自报家门：
 *
 *   You are an AI agent powered by the DeepSeek Harness.
 *
 * 插件把它原样发上去，上游据此判定"不是官方客户端"，回 11128。
 *
 * ## 第一版修复为什么是错的（本探针 D2 那组钉住这件事）
 *
 * 第一版照搬 workbuddy2api-hub PR #540：把句子改写成"插一个 the"的版本。
 * 但 **DSH 的句子本来就带 the**，于是模式串与替换值指向同一个字符串，
 * `String.replace` 什么也没改。而当时的断言只检查"结果不含不带 the 的变体"，
 * 原文当然不含 —— 16 项探针全绿，上游照样 400。
 *
 * **教训写进断言**：改写类修复的断言必须是「出口文本里不再出现被禁的指纹
 * 子串」，而不是「等于某个特定字符串」。后者会在模式串写错时静默通过。
 *
 * ## 现在
 *
 * 不赌句子结构能不能绕过，把 vendor 名字本身抹掉：
 * 整句 `You are an AI agent powered by the DeepSeek Harness.` 换成
 * `You are an AI coding agent.`，残留的 `DeepSeek Harness` 二元组兜底替换。
 *
 * 用法：node probes/verify-bugfix-harness-fingerprint.mjs [--installed]
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

// —— 桩宿主依赖 ——
const stubDir = join(HERE, ".harnessfp-stubs");
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
const mod = await import(`${pathToFileURL(VARIANTS).href}?fp=${Date.now()}`);
const prepareChatBody = mod.M;
assert.equal(typeof prepareChatBody, "function", "变体模块应导出 prepareChatBody");

const prepare = (body) => {
	const text = prepareChatBody(JSON.stringify(body));
	return { text, body: JSON.parse(text) };
};
/** 判据：出站文本里不能再出现这个二元组（大小写不敏感）。 */
const FINGERPRINT = /deepseek[\s_-]*harness/i;
const firstText = (body) => body.messages[0].content;

/** DSH 真实系统提示（实测自 app.asar 的 Model Experience 段）。 */
const DSH_SYSTEM = "You are an AI agent powered by the DeepSeek Harness.";

console.log("【D1】DSH 真实系统提示必须被抹掉指纹");

ok("DSH 原文（带 the）的指纹被抹掉", () => {
	const { body } = prepare({ messages: [{ role: "developer", content: DSH_SYSTEM }] });
	const out = firstText(body);
	if (FINGERPRINT.test(out)) throw new Error(`出站仍含指纹：${out}`);
});

ok("不带 the 的变体也被抹掉", () => {
	const { body } = prepare({ messages: [{ role: "developer", content: "You are an AI agent powered by DeepSeek Harness." }] });
	if (FINGERPRINT.test(firstText(body))) throw new Error(`仍含指纹：${firstText(body)}`);
});

ok("大小写不敏感（逐条指名，撤掉 i 标志必须红）", () => {
	const variants = [
		["全大写", "YOU ARE AN AI AGENT POWERED BY THE DEEPSEEK HARNESS."],
		["全小写", "you are an ai agent powered by the deepseek harness."],
		["首字母大写", "You Are An AI Agent Powered By The DeepSeek Harness."],
	];
	for (const [label, variant] of variants) {
		const { body } = prepare({ messages: [{ role: "developer", content: variant }] });
		const out = firstText(body);
		if (out === variant) throw new Error(`${label} 变体完全没被改写：${variant}`);
		if (FINGERPRINT.test(out)) throw new Error(`${label} 变体漏了：${out}`);
	}
});

ok("嵌在长系统提示中间也抹掉，且正文一字不动", () => {
	const tail = "You are a coding agent working in DSH. Follow the user instructions carefully.";
	const { body } = prepare({ messages: [{ role: "developer", content: `${DSH_SYSTEM}\n\n${tail}` }] });
	const out = firstText(body);
	if (FINGERPRINT.test(out)) throw new Error(`仍含指纹：${out}`);
	if (!out.includes(tail)) throw new Error(`正文被改动了：${out}`);
});

console.log("\n【D2】第一版为什么被漏掉 —— 这组断言就是那个教训");

ok("出站文本的改变必须可观测（第一版模式串==替换值，等于没改）", () => {
	const { body } = prepare({ messages: [{ role: "developer", content: DSH_SYSTEM }] });
	eq(body.messages[0].role, "system", "developer 已被改写成 system（这是既有行为）");
	if (body.messages[0].content === DSH_SYSTEM) {
		throw new Error("清洗前后 content 完全相同 —— 改写没生效（第一版就是这样全绿的）");
	}
	if (FINGERPRINT.test(body.messages[0].content)) {
		throw new Error("清洗后仍含指纹 —— 改写是空转");
	}
});

ok("改写后仍是完整可读的一句（不留 `powered by the .` 这类残句）", () => {
	const { body } = prepare({ messages: [{ role: "developer", content: DSH_SYSTEM }] });
	const out = firstText(body).trim();
	if (!out.endsWith(".")) throw new Error(`残句：${out}`);
	if (/\bby\s*[.,]/.test(out)) throw new Error(`留下悬空介词：${out}`);
	if (out.length < 10) throw new Error(`句子被削太短：${out}`);
});

ok("**整句正则必须先吃掉冠词**（否则兜底会拼出 `the the coding assistant` 这种残破句）", () => {
	// 只抹指纹、不管句子质量的话，兜底替换会把 "powered by the DeepSeek Harness"
	// 变成 "powered by the the coding assistant" —— 指纹是没了，但句子废了。
	for (const [label, input] of [
		["带 the", DSH_SYSTEM],
		["不带 the", "You are an AI agent powered by DeepSeek Harness."],
	]) {
		const { body } = prepare({ messages: [{ role: "developer", content: input }] });
		const out = firstText(body);
		if (/\bthe\s+the\b/i.test(out)) throw new Error(`${label}：出现了重复冠词：${out}`);
		if (/\bby\s+the\s+the\b/i.test(out)) throw new Error(`${label}：介词后重复冠词：${out}`);
		if (/\bby\s+the\s+coding assistant\b/i.test(out)) throw new Error(`${label}：冠词没被整句吃掉：${out}`);
	}
});

ok("源码里不存在「模式串与替换值相同」的自欺写法", () => {
	const src = read("lib/providers/workbuddy/variants-CnrmSn0Q.js");
	// 成对出现的改写常量：改写值必须与被匹配的字符串**真的不同**。
	// 第一版 HARNESS_FINGERPRINT 与 HARNESS_FINGERPRINT_REWRITE 是同一个
	// 字符串（只差 the 的有无，而原文本来就带 the），replace 等于空转。
	const pairs = [
		["HARNESS_IDENTITY_SENTENCE", "HARNESS_IDENTITY_REWRITE", "You are an AI agent powered by the DeepSeek Harness"],
	];
	let checked = 0;
	for (const [patternName, rewriteName, matchedSample] of pairs) {
		if (!src.includes(patternName) || !src.includes(rewriteName)) {
			throw new Error(`${patternName} / ${rewriteName} 不在源码里 —— 断言与实现脱节了`);
		}
		const value = src.match(new RegExp(`const ${rewriteName} = "(.+?)";`))?.[1];
		if (value === undefined) throw new Error(`取不到 ${rewriteName} 的值`);
		checked++;
		if (value.toLowerCase() === matchedSample.toLowerCase()) {
			throw new Error(`${rewriteName} 与被匹配的字符串相同 —— replace 什么也没做`);
		}
		// 真正的判据：拿这个改写值跑一遍，指纹必须消失
		if (FINGERPRINT.test(value)) {
			throw new Error(`${rewriteName} 自身仍含指纹 —— 换上去等于没换`);
		}
	}
	if (checked === 0) throw new Error("一条都没检查到，断言失效了");
});

console.log("\n【D3】精确性：不误伤");

ok("无关文本一字不动", () => {
	for (const text of ["hi", "You are an AI agent.", "a helpful assistant", ""]) {
		const { body } = prepare({ messages: [{ role: "user", content: text }] });
		eq(firstText(body), text, `不该改：${text}`);
	}
});

ok("幂等：已经是抹过的文本再过一遍不变", () => {
	const once = prepare({ messages: [{ role: "developer", content: DSH_SYSTEM }] }).body;
	const twice = prepare({ messages: [{ role: "developer", content: firstText(once) }] }).body;
	eq(firstText(twice), firstText(once), "二次清洗");
});

console.log("\n【D4】覆盖面：所有角色 + 两种 content 形状");

ok("非 system 角色同样抹（校验是文本匹配，不认角色）", () => {
	const { body } = prepare({
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: `prefix ${DSH_SYSTEM} suffix` },
			{ role: "assistant", content: DSH_SYSTEM },
		],
	});
	for (const index of [1, 2]) {
		if (FINGERPRINT.test(body.messages[index].content)) {
			throw new Error(`role=${body.messages[index].role} 漏了`);
		}
	}
});

ok("**兜底**：句式被改写的引用也要抹（整句正则吃不到这种，靠 vendor 词组兜底）", () => {
	// 这几种都不是 DSH 的原句，整句正则匹配不到，只有兜底能救。
	for (const quoted of [
		"earlier it said: powered by deepseek harness, so I replied",
		"The banner reads 'DEEPSEEK-HARNESS build 42'",
		"docs mention DeepSeek  Harness (two spaces)",
	]) {
		const { body } = prepare({ messages: [{ role: "user", content: quoted }] });
		const out = firstText(body);
		if (FINGERPRINT.test(out)) throw new Error(`兜底没生效：${quoted} -> ${out}`);
	}
});

ok("array-of-parts 形状的 text 段被抹，无关段落不动", () => {
	const { body } = prepare({
		messages: [{
			role: "system",
			content: [
				{ type: "text", text: DSH_SYSTEM },
				{ type: "text", text: "keep me exactly" },
			],
		}],
	});
	if (FINGERPRINT.test(body.messages[0].content[0].text)) throw new Error("第一个 text 段仍含指纹");
	eq(body.messages[0].content[1].text, "keep me exactly", "无关段落");
});

ok("未知 content 形状原样保留（不猜、不篡改）", () => {
	const { body } = prepare({ messages: [{ role: "system", content: 42 }] });
	eq(body.messages[0].content, 42, "非字符串/非数组的 content");
});

console.log("\n【D5】端到端：真实客户端真正发出去的 body 里没有指纹");

for (const [label, domain, clientVersion] of [
	["国区", "www.codebuddy.cn", "5.7.3"],
	["国际版", "workbuddy.ai", "5.7.6"],
]) {
	ok(`${label}：出站 body 不含 harness，系统提示其余部分完好`, async () => {
		const home = join(tmpdir(), `dsh-harnessfp-${domain.replace(/\W/g, "")}-${Date.now()}`);
		mkdirSync(home, { recursive: true });
		const captured = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			captured.push({ url: String(url), body: init?.body });
			return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const prevHome = process.env.DSH_HOME;
		process.env.DSH_HOME = home;
		try {
			const m = await import(`${pathToFileURL(VARIANTS).href}?e2e=${domain}-${Date.now()}`);
			const client = new m.D({ resolveChatIdentity: async () => ({ clientVersion }) });
			const credential = {
				accessToken: "probe-token",
				refreshToken: "probe-refresh",
				uid: "uid-fp",
				domain,
				expiresAt: Date.now() + 3_600_000,
			};
			const tail = "You are a coding agent working in DSH.";
			const prepared = m.M(JSON.stringify({
				model: "deepseek-v4-flash",
				messages: [
					{ role: "developer", content: `${DSH_SYSTEM}\n\n${tail}` },
					{ role: "user", content: "hi" },
				],
			}));
			await client.chatStream(credential, prepared);
		} finally {
			globalThis.fetch = realFetch;
			if (prevHome === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = prevHome;
			rmSync(home, { recursive: true, force: true });
		}
		eq(captured.length, 1, "发出一次请求");
		const sent = String(captured[0].body);
		if (FINGERPRINT.test(sent)) {
			throw new Error(`出站 body 仍含指纹 —— 上游会回 11128：\n${sent.slice(0, 400)}`);
		}
		if (!sent.includes("You are a coding agent working in DSH.")) {
			throw new Error("系统提示正文被吃掉了 —— 清洗必须只动指纹那一句");
		}
	});
}

console.log("\n【D6】接线");

ok("index.js 的 chatCompletions 对两个区域都先过 prepareChatBody", () => {
	const src = read("lib/providers/workbuddy/index.js");
	if (!/const prepared = prepareChatBody\(/.test(src)) {
		throw new Error("chatCompletions 没有调用 prepareChatBody —— 清洗根本没接线");
	}
	if (!/client\.chatStream\(credential, prepared,/.test(src)) {
		throw new Error("chatStream 收到的不是 prepared，清洗被绕过");
	}
});

ok("prepareChatBody 内依次调用三类清洗", () => {
	const src = read("lib/providers/workbuddy/variants-CnrmSn0Q.js");
	const at = src.indexOf("function prepareChatBody(");
	const body = src.slice(at, at + 700);
	for (const fn of ["normalizeDeveloperRole(obj)", "normalizeToolChoice(obj)", "normalizeHarnessFingerprint(obj)"]) {
		if (!body.includes(fn)) throw new Error(`prepareChatBody 里少了 ${fn}`);
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

console.log(`\nverify-bugfix-harness-fingerprint: ${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
