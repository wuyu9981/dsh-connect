#!/usr/bin/env node
/**
 * 把仓库里的插件同步到 DSH profile 里**跑着的那份**。
 *
 * 为什么需要脚本而不是手抄：安装副本用的是硬链接（HardLink），而本仓库的编辑工具
 * 是"写新文件 + rename"，一写就把链接断开了 —— 于是 repo 与 installed 会静默分叉，
 * 表现为"改了但重启后没生效"。这个脚本按文件清单逐份覆盖，并打印实际差异。
 *
 * 用法：
 *   node scripts/sync-to-profile.mjs            # 同步
 *   node scripts/sync-to-profile.mjs --check    # 只报差异，不写
 */
import { copyFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const check = process.argv.includes("--check");

/** 同步清单：插件运行时真正会读的那些文件。 */
const FILES = [
	"package.json",
	"cordis.patch.yml",
	"README.md",
	"LICENSE",
	"lib/index.js",
	"lib/panel.js",
	"lib/client.js",
	"lib/channel-registry.js",
	"lib/providers/trae/index.js",
	"lib/providers/qoder/index.js",
	"lib/providers/workbuddy/index.js",
	"lib/providers/workbuddy/bin.js",
	"lib/providers/workbuddy/variants-CnrmSn0Q.js",
	"lib/shared/catalog-diff.js",
	"lib/shared/hidden.js",
	"lib/shared/http.js",
	"lib/shared/node.js",
	"lib/shared/probe.js",
	"scripts/export-trae-plain.mjs",
	"scripts/trae-vault.mjs",
	"scripts/workbuddy-login.mjs",
];

/** 目标包目录：按 profile 的依赖键找，不写死包名。 */
function installedDir() {
	const profile = join(homedir(), ".dsh", "profiles", "desktop");
	if (process.env.DSH_CONNECT_DIR) return join(profile, "node_modules", process.env.DSH_CONNECT_DIR);
	const root = join(profile, "node_modules");
	try {
		const deps = JSON.parse(readFileSync(join(profile, "package.json"), "utf8")).dependencies ?? {};
		for (const key of Object.keys(deps)) {
			if (key.includes("connect") && existsSync(join(root, key, "lib", "providers", "workbuddy", "index.js"))) return join(root, key);
		}
	} catch {
		/* 读不到就兜底 */
	}
	return join(root, "dsh-workbuddy-trae-qoder-connect");
}

const hashOf = (path) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
const target = installedDir();
if (!existsSync(join(target, "package.json"))) {
	console.error(`找不到安装副本：${target}`);
	process.exit(2);
}

let copied = 0;
let same = 0;
const missing = [];
for (const rel of FILES) {
	const from = join(REPO, rel);
	const to = join(target, rel);
	if (!existsSync(from)) {
		missing.push(rel);
		continue;
	}
	if (existsSync(to) && hashOf(from) === hashOf(to)) {
		same++;
		continue;
	}
	const before = existsSync(to) ? hashOf(to) : "(不存在)";
	if (!check) copyFileSync(from, to);
	copied++;
	console.log(`${check ? "DIFF" : "COPY"}  ${rel}  ${before} -> ${hashOf(from)}  (${statSync(from).size} B)`);
}
if (missing.length > 0) console.log(`清单里有仓库侧不存在的文件（跳过）：${missing.join(", ")}`);
console.log(`\n${check ? "待同步" : "已同步"} ${copied} 个，${same} 个本就一致  [${relative(process.cwd(), target) || target}]`);
