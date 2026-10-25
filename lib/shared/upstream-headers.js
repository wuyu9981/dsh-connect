/**
 * 出站请求头统一处理 —— 三家渠道发往上游前的最后一道关卡。
 *
 * ## 为什么要有这个文件
 *
 * 三个渠道各自构造请求头，构造水平参差：WorkBuddy 一路把官方桌面端的
 * `X-Product` / `X-Conversation-*` 都补齐了，Qoder 一路却把自己叫
 * `dsh-qoder-connect` 发给了上游 —— 同一个插件，一条路伪装，一条路自曝。
 * 更危险的是"本地痕迹"：中转进程监听在 `127.0.0.1`，任何一路只要把
 * `Host: 127.0.0.1:3080` 或 `Origin: http://localhost` 原样带出去，
 * 前面所有 UA 伪装立刻作废 —— 上游一眼就知道这是本地代理。
 *
 * 本文件把这三件事合成一层，供三家共用：
 *
 *   1. **剔除逐跳头与本地痕迹**（保命，无论走哪条路都必须过）
 *   2. **白名单透传**（只放行追踪头，其余入站头一律丢弃）
 *   3. **UA 规范化 + 出站自检**（自曝串拦下，缺失则兜底）
 *
 * ## 用法
 *
 * ```js
 * const { headers, notes } = sanitizeUpstreamHeaders(
 *   { ...buildCosyHeaders(null, url, creds), ...pickPassthroughHeaders(req.headers) },
 *   { upstreamOrigin: openapiBase(), userAgent: QODER_UA },
 * );
 * ```
 *
 * `sanitizeUpstreamHeaders` **只修不改语义**：它不新增业务头，只剔除危险的、
 * 修正本地痕迹、补齐身份。渠道自己构造的头原样保留。
 */

/** 逐跳头：由传输层负责，透传会破坏 HTTP 语义或直接报错。 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Host / Content-Length 由 fetch 按目标 URL 与 body 自己算，
  // 带上中转进程的值必然是错的（而且会暴露回环地址）。
  "host",
  "content-length",
]);

/** 会携带"我是谁、我从哪来"的头：值里出现回环地址就必须重写。 */
const ORIGIN_BEARING_HEADERS = new Set(["origin", "referer", "referrer"]);

/** 默认允许从入站请求透传的头 —— 只有分布式追踪用的那几个。 */
const DEFAULT_PASSTHROUGH = new Set(["traceparent", "tracestate", "x-request-id", "x-correlation-id"]);

/**
 * UA 里的"自曝 / 默认"形态。
 *
 * 命中任意一条都说明这个 UA 不是上游期望的客户端形态：
 *   · `dsh-` 前缀或含 `connect` —— 插件自曝
 *   · `undici` / `node` / `axios` / `got` / `fetch` —— HTTP 库默认值，
 *     作者在 WorkBuddy 那路的注释里说过，这比缺头是更强的破绽
 *   · 空串
 */
const UA_TELL_PATTERNS = [
  /^dsh[-_]/iu,
  /\bdsh\b/iu,
  /connect/iu,
  /undici/iu,
  /\bnode\b/iu,
  /^axios/iu,
  /^got\b/iu,
  /^fetch\b/iu,
  /^\s*$/u,
];

/** 回环地址形态（含带端口与 IPv6 两种写法）。 */
const LOOPBACK_PATTERN = /(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d{1,5})?/iu;

/**
 * 从 URL 取源（`https://gateway.qoder.com.cn/algo/x?y=1` → `https://gateway.qoder.com.cn`）。
 *
 * 取不到（畸形 URL）返回 `undefined`，让调用方走"不校验同源"那条路，
 * 而不是凭空猜一个源写进请求头。
 */
export function originOfUrl(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return undefined;
  }
}

/** 值里带回环地址吗。 */
export function valueHasLoopback(value) {
  if (typeof value !== "string") return false;
  return LOOPBACK_PATTERN.test(value);
}

/** UA 是不是"不正经"（自曝、HTTP 库默认、或缺失）。 */
export function userAgentIsTell(ua) {
  if (typeof ua !== "string") return true;
  return UA_TELL_PATTERNS.some((pattern) => pattern.test(ua));
}

/**
 * 从入站请求头里挑出允许透传的那几个，其余**全部丢弃**。
 *
 * 为什么默认只放行追踪头：入站请求来自本机的 DSH，它的头描述的是
 * "DSH 与中转之间这一跳"，对上游毫无意义，却可能夹带内部信息或回环地址。
 * 全量透传不是"更真实"，是把本地代理的形状原样交给上游。
 *
 * @param {Record<string, unknown>} inbound - 入站请求头（Node 的 `req.headers`）。
 * @param {Iterable<string>} [allowlist] - 覆盖默认白名单。传空数组表示完全不透传。
 * @returns {Record<string, string>} 只含白名单头、且值都是字符串的干净集合。
 */
export function pickPassthroughHeaders(inbound, allowlist = DEFAULT_PASSTHROUGH) {
  const allowed = allowlist instanceof Set ? allowlist : new Set([...allowlist].map((k) => String(k).toLowerCase()));
  const picked = {};
  if (inbound === undefined || inbound === null || typeof inbound !== "object") return picked;
  for (const [key, value] of Object.entries(inbound)) {
    const lower = String(key).toLowerCase();
    if (!allowed.has(lower)) continue;
    if (typeof value === "string" && value.trim() !== "") picked[key] = value;
  }
  return picked;
}

/**
 * 自检：这批头能不能见上游。
 *
 * 与 {@link sanitizeUpstreamHeaders} 的区别 —— 这个**只报告不改**，
 * 给探针、日志和"发出去之前最后看一眼"的场合用。
 *
 * @returns {string[]} 问题列表；空数组表示没问题。
 */
export function assertUpstreamHeaders(headers, options = {}) {
  const { upstreamOrigin } = options;
  const problems = [];
  if (headers === undefined || headers === null || typeof headers !== "object") return ["headers 不是对象"];

  for (const [key, value] of Object.entries(headers)) {
    const lower = String(key).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      problems.push(`逐跳头必须剔除: ${key}`);
      continue;
    }
    if (ORIGIN_BEARING_HEADERS.has(lower) && valueHasLoopback(value)) {
      problems.push(`${key} 带本地回环地址: ${String(value)}`);
    }
  }

  const ua = headers["User-Agent"] ?? headers["user-agent"];
  if (userAgentIsTell(ua)) problems.push(`User-Agent 不正经（缺失或自曝）: ${JSON.stringify(ua ?? null)}`);

  if (typeof upstreamOrigin === "string" && upstreamOrigin !== "") {
    for (const key of ORIGIN_BEARING_HEADERS) {
      const found = Object.keys(headers).find((k) => k.toLowerCase() === key);
      if (found === undefined) continue;
      const value = String(headers[found]);
      if (!value.startsWith(upstreamOrigin)) problems.push(`${found} 与上游不同源: ${value}`);
    }
  }
  return problems;
}

/**
 * 修正一批即将发往上游的请求头。
 *
 * 做四件事，按顺序：
 *   1. 剔除逐跳头（含 `host` / `content-length` —— fetch 会自己算）
 *   2. 把 `Origin` / `Referer` 里指向回环的值重写成上游源；上游源未提供则剔除
 *   3. `User-Agent` 缺失或不正经时，用 `options.userAgent` 兜底
 *   4. 跑一遍自检，问题记进 `notes`（不抛错 —— 渠道的可用性优先于卫生）
 *
 * **不新增业务头**：渠道该带什么由渠道自己决定，这里只管"别带错的、别漏身份"。
 *
 * @param {Record<string, unknown>} headers - 渠道构造好的头（可叠加白名单透传结果）。
 * @param {{ upstreamOrigin?: string, userAgent?: string, label?: string }} [options]
 * @returns {{ headers: Record<string, string>, notes: string[] }} 修正后的头与说明。
 */
export function sanitizeUpstreamHeaders(headers, options = {}) {
  const { upstreamOrigin, userAgent, label = "upstream" } = options;
  const notes = [];
  const out = {};

  if (headers !== undefined && headers !== null && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      const lower = String(key).toLowerCase();

      // 1. 逐跳头
      if (HOP_BY_HOP_HEADERS.has(lower)) {
        notes.push(`[${label}] 剔除逐跳头 ${key}`);
        continue;
      }

      // 2. 本地痕迹
      if (ORIGIN_BEARING_HEADERS.has(lower)) {
        if (valueHasLoopback(value)) {
          if (typeof upstreamOrigin === "string" && upstreamOrigin !== "") {
            out[key] = upstreamOrigin;
            notes.push(`[${label}] ${key} 指向回环，改写为上游源`);
          } else {
            notes.push(`[${label}] ${key} 指向回环且未提供上游源，已剔除`);
          }
          continue;
        }
      }

      out[key] = String(value);
    }
  }

  // 3. UA 兜底
  const uaKey = Object.keys(out).find((k) => k.toLowerCase() === "user-agent");
  if (userAgentIsTell(out[uaKey]) && typeof userAgent === "string" && userAgent !== "") {
    notes.push(`[${label}] User-Agent ${JSON.stringify(out[uaKey] ?? null)} 不正经，兜底为 ${JSON.stringify(userAgent)}`);
    if (uaKey !== undefined) delete out[uaKey];
    out["User-Agent"] = userAgent;
  }

  // 4. 自检（记录，不拦）
  const problems = assertUpstreamHeaders(out, { upstreamOrigin });
  for (const problem of problems) notes.push(`[${label}] 残留问题: ${problem}`);

  return { headers: out, notes };
}
