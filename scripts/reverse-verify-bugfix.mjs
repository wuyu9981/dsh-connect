#!/usr/bin/env node
/**
 * 反向验证：把 Bug A / Bug B 的每一处修复**逐个撤回**，新探针必须变红，
 * 而且必须红在**对应的那条**断言上。绿着说明那条断言没测到东西。
 *
 * 做法：备份文件 → 字面替换成"修复前"的写法 → 跑探针 → 断言
 *   (a) 退出码非 0，
 *   (b) 输出里出现预期断言标签的 ✗ 行，
 * 然后从备份还原（逐字节）。
 *
 * 用法：node scripts/reverse-verify-bugfix.mjs
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const PROBE_A = join(REPO, "probes", "verify-bugfix-intl-window-and-empty-slot.mjs");
const PROBE_C = join(REPO, "probes", "verify-bugfix-conversation-headers.mjs");
const PROBE_D = join(REPO, "probes", "verify-bugfix-harness-fingerprint.mjs");
const NODE = process.execPath;

/**
 * 每一处撤回：
 *   file    —— 仓库相对路径
 *   from    —— 修复后的字面量（必须**唯一**出现）
 *   to      —— 修复前的写法
 *   expect  —— 预期变红的断言标签（子串匹配）
 *   probe   —— 跑哪个探针（省略即 A/B 那一个；Bug C 的撤回必须显式指名）
 */
const REVERSALS = [
	{
		name: "C/1 chatHeaders 不再带会话头族（国际版每条消息都被上游 11128 拦下）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: '\t\t...international ? conversationHeaders() : {}\n',
		to: "",
		expect: "国际版 chatStream 的出站头带齐四个会话 id",
		probe: PROBE_C,
	},
	{
		name: "C/2 四个会话 id 改成复用同一个值（上游一眼识破）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: 'function conversationHeaders() {\n\treturn {\n\t\t"X-Conversation-ID": randomUUID(),\n\t\t"X-Conversation-Request-ID": randomUUID(),\n\t\t"X-Conversation-Message-ID": randomUUID(),\n\t\t"X-Root-Request-ID": randomUUID()\n\t};\n}',
		to: 'function conversationHeaders() {\n\tconst id = randomUUID();\n\treturn {\n\t\t"X-Conversation-ID": id,\n\t\t"X-Conversation-Request-ID": id,\n\t\t"X-Conversation-Message-ID": id,\n\t\t"X-Root-Request-ID": id\n\t};\n}',
		expect: "四个 id 都是每次现编",
		probe: PROBE_C,
	},
	{
		name: "C/3 国区也被带上会话头族（引入一条没验证过的偏差）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: 'function chatHeaders(credential, userAgent, clientVersion) {\n\tconst international = regionOf(credential.domain) === "global";',
		to: 'function chatHeaders(credential, userAgent, clientVersion) {\n\tconst international = true;',
		expect: "国区 chatStream 的出站头**不**带会话头族",
		probe: PROBE_C,
	},
	{
		name: "C/4 少了 randomUUID 导入（运行时就抛 ReferenceError）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: ', randomUUID } from "node:crypto"',
		to: ' } from "node:crypto"',
		expect: "randomUUID 已从 node:crypto 导入",
		probe: PROBE_C,
	},
	{
		name: "D/1 prepareChatBody 不再调用 normalizeHarnessFingerprint（国区/国际版又回 11128）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: '\tnormalizeToolChoice(obj);\n\tnormalizeHarnessFingerprint(obj);\n',
		to: '\tnormalizeToolChoice(obj);\n',
		expect: "DSH 原文（带 the）的指纹被抹掉",
		probe: PROBE_D,
	},
	{
		name: "D/2 退回第一版写法：替换值与匹配到的句子相同（replace 空转，曾静默全绿）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: 'const HARNESS_IDENTITY_REWRITE = "You are an AI coding agent.";',
		to: 'const HARNESS_IDENTITY_REWRITE = "You are an AI agent powered by the DeepSeek Harness.";',
		expect: "源码里不存在「模式串与替换值相同」的自欺写法",
		probe: PROBE_D,
	},
	{
		name: "D/3 兜底只抹整句、不管别处残留的 vendor 词组（换句式的引用照样命中）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: '\t\t.replace(HARNESS_VENDOR_FINGERPRINT, "the coding assistant");',
		to: '\t\t;',
		expect: "**兜底**：句式被改写的引用也要抹",
		probe: PROBE_D,
	},
	{
		name: "D/4 兜底正则丢掉大小写不敏感（大写 vendor 词组漏出去）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: 'const HARNESS_VENDOR_FINGERPRINT = /deepseek[\\s_-]*harness/gi;',
		to: 'const HARNESS_VENDOR_FINGERPRINT = /deepseek[\\s_-]*harness/g;',
		expect: "**兜底**：句式被改写的引用也要抹",
		probe: PROBE_D,
	},
	{
		name: "D/5 整句正则不再兼容不带 the 的写法（旧客户端/别家 harness 漏掉）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: 'const HARNESS_IDENTITY_SENTENCE = /You are an AI agent powered by (?:the )?DeepSeek[\\s_-]*Harness[.,]?/gi;',
		to: 'const HARNESS_IDENTITY_SENTENCE = /You are an AI agent powered by the DeepSeek[\\s_-]*Harness[.,]?/gi;',
		expect: "**整句正则必须先吃掉冠词**",
		probe: PROBE_D,
	},
	{
		name: "A/1 catalog 惰性读源没接上活偏好",
		file: "lib/providers/workbuddy/index.js",
		from: '\tif (variant.region === "global") catalog.setMaximumContextWindowSource(maximumContextWindowEnabled);\n',
		to: "",
		expect: "国际版变体把 catalog 的窗口来源接到活偏好上",
	},
	{
		name: "A/2 状态路由不再下发该字段（退回 legacySettingsAvailable 时代的形状）",
		file: "lib/providers/workbuddy/index.js",
		from: '\t\t\t\t...runtime.variant.region === "cn" ? {} : { useMaximumContextWindow: maximumContextWindowField }\n',
		to: "",
		expect: "状态路由对**任意国际版槽位**下发该字段",
	},
	{
		name: "A/3 前端复选框又钉回 AI_CARD_VARIANT（= workbuddy2）",
		file: "lib/client.js",
		from: '\t\t\t\t\t\t\t\t\t...status.useMaximumContextWindow !== void 0 ? {',
		to: '\t\t\t\t\t\t\t\t\t...variant.id === AI_CARD_VARIANT.id && status.useMaximumContextWindow !== void 0 ? {',
		expect: "前端复选框不再按卡片 id 门控",
	},
	{
		name: "A/4 index.js 不再注入 hubPreferences（偏好永远读不到）",
		file: "lib/index.js",
		from: "      workbuddy.setPreferences(hubPreferences);\n",
		to: "",
		expect: "index.js 把 hubPreferences 注入 workbuddy",
	},
	{
		name: "A/5 面板 POST /settings 白名单丢掉该键（勾了也写不进去）",
		file: "lib/panel.js",
		from: '        if (typeof patch?.useMaximumContextWindow === "boolean") safe.useMaximumContextWindow = patch.useMaximumContextWindow;\n',
		to: "",
		expect: "面板 POST /settings 的写入白名单含 useMaximumContextWindow",
	},
	{
		name: "B/1 provider 侧 configuredAuthFile 退回「国际版一律跟随桌面 App」",
		file: "lib/providers/workbuddy/index.js",
		from: '\t\tif (variant.followDesktop !== true) return join(resolveDshHome(), "connect-auth", `${variant.id}.json`);\n',
		to: "",
		expect: "provider 侧 configuredAuthFile 对不跟随的槽位给出自己的落点",
	},
	{
		name: "B/2 store 侧不再按 followDesktop 分流（CLI / 其它调用方仍会借桌面凭据）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: `\t\tif (this.variant !== void 0) {
\t\t\tif (this.variant.region === "global" && this.variant.followDesktop !== true) {
\t\t\t\treturn [join(resolveDshHome(), "connect-auth", \`\${this.variant.id}.json\`)];
\t\t\t}
\t\t\treturn desktopAuthCandidatesFor(this.variant);
\t\t}
\t\treturn defaultDesktopAuthCandidates();`,
		to: '\t\treturn this.variant === void 0 ? defaultDesktopAuthCandidates() : desktopAuthCandidatesFor(this.variant);',
		expect: "不跟随的国际版槽位：候选里**没有**桌面 App 的 basename",
	},
	{
		name: "B/3 变体表把 followDesktop 写死成 true（新增槽位又跟随）",
		file: "lib/providers/workbuddy/variants-CnrmSn0Q.js",
		from: "\t\tfollowDesktop: entry.followDesktop !== false,\n",
		to: "\t\tfollowDesktop: true,\n",
		expect: "显式 false 的条目解析为不跟随",
	},
	{
		name: "B/4 注册表归一化丢掉 followDesktop（面板写的 false 被吃掉）",
		file: "lib/channel-registry.js",
		from: '  const followDesktop = kind === "workbuddy" && typeof value.followDesktop === "boolean" ? value.followDesktop : undefined;\n',
		to: "  const followDesktop = undefined;\n",
		expect: "不跟随的空槽位状态是 signed-out",
	},
	{
		name: "B/5 面板 create 不再收敛 followDesktop（缺省变回跟随）",
		file: "lib/panel.js",
		from: '            const followDesktop = kind === "workbuddy" && region === "global" ? body?.followDesktop === true : undefined;\n',
		to: "",
		expect: "面板 create 把 followDesktop 写进注册表",
	},
	{
		name: "A/6 状态文档不再按 region 下发该字段（端到端那一节必须变红）",
		file: "lib/providers/workbuddy/index.js",
		from: '\t\t\t...maximumContextWindow === void 0 ? {} : { useMaximumContextWindow: maximumContextWindow }\n',
		to: "",
		expect: "端到端：已登录的国际版槽位，状态文档带 useMaximumContextWindow=true 且模型广告 1M 窗口",
	},
	{
		name: "B/6 channelOf 又把 region/followDesktop 透出去（界面会显示一条与事实相反的标记）",
		file: "lib/channel-registry.js",
		from: "      credentialHint: `connect-auth/${entry.id}.json`,\n",
		to: "      credentialHint: `connect-auth/${entry.id}.json`,\n      ...entry.region === \"global\" ? { region: \"global\" } : {},\n      ...entry.region === \"global\" ? { followDesktop: entry.followDesktop !== false } : {},\n",
		expect: "channelOf 不再透出 region/followDesktop",
	},
	{
		name: "A/7 面板不再把窗口偏好透到行上（开关又只剩设置卡片里那一个入口）",
		file: "lib/panel.js",
		from: '    ...typeof raw.useMaximumContextWindow === "boolean" ? { maximumContextWindow: raw.useMaximumContextWindow } : {},\n',
		to: "",
		expect: "面板把 provider 的窗口偏好透到行上",
	},
	{
		name: "A/8 开关写回后不广播模型更新（选择器里还是旧窗口）",
		file: "lib/panel.js",
		from: "        if (typeof safe.useMaximumContextWindow === \"boolean\") {\n          try {\n            deps.onModelsChanged?.();\n          } catch {\n            /* 通知失败不影响写入结果 */\n          }\n        }\n",
		to: "",
		expect: "开关是全局偏好，改完要广播模型更新",
	},
];

let allOk = true;
for (const [index, reversal] of REVERSALS.entries()) {
	const path = join(REPO, reversal.file);
	const backup = `${path}.reverse-verify-backup`;
	copyFileSync(path, backup);
	const original = readFileSync(path, "utf8");
	const hits = original.split(reversal.from).length - 1;
	if (hits !== 1) {
		console.log(`✗ [${index + 1}/${REVERSALS.length}] ${reversal.name}\n    from 在 ${reversal.file} 里出现 ${hits} 次（应为 1）—— 撤回脚本本身失效，先修脚本`);
		rmSync(backup, { force: true });
		allOk = false;
		continue;
	}
	writeFileSync(path, original.replace(reversal.from, reversal.to));
	let result;
	try {
		result = spawnSync(NODE, [reversal.probe ?? PROBE_A], { cwd: REPO, encoding: "utf8" });
	} finally {
		copyFileSync(backup, path);
		rmSync(backup, { force: true });
	}
	const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const redLines = out.split("\n").filter((line) => line.trim().startsWith("✗"));
	const hit = redLines.some((line) => line.includes(reversal.expect));
	const restored = readFileSync(path, "utf8") === original;
	if (result.status === 0) {
		console.log(`✗ [${index + 1}/${REVERSALS.length}] ${reversal.name}\n    撤回后探针**仍然全绿** —— 断言「${reversal.expect}」没测到东西`);
		allOk = false;
	} else if (!hit) {
		console.log(`✗ [${index + 1}/${REVERSALS.length}] ${reversal.name}\n    探针变红了，但红的不是预期断言。实际红的：\n${redLines.map((l) => `      ${l.trim()}`).join("\n")}`);
		allOk = false;
	} else if (!restored) {
		console.log(`✗ [${index + 1}/${REVERSALS.length}] ${reversal.name}\n    还原后文件与原文不一致（备份/还原有 bug）`);
		allOk = false;
	} else {
		console.log(`✓ [${index + 1}/${REVERSALS.length}] ${reversal.name} → 「${reversal.expect}」变红，文件已逐字还原`);
	}
}

console.log(`\nreverse-verify-bugfix: ${allOk ? "全部按预期变红" : "有撤回未被测到（见上）"}`);
process.exitCode = allOk ? 0 : 1;
