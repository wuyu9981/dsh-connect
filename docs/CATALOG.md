# 目录字段核对手册（AI / 维护者用）

> 目的：上游目录（catalog）是三渠道一切能力的"真值来源"。本文说明**哪些字段是核心**、
> 如何核对、探查结果如何写回插件。供 AI 半手动核对流程使用——照着查、照着写，不猜。

## 总原则

1. **目录是唯一权威**。UI 缺档位/缺窗口/缺模型，先查目录，再查插件解析，最后才怀疑请求。
2. **目录是 (模型 × function) 配对下发**（Trae 尤甚）。任何"按模型名去重"的合并都会丢数据。
3. **声明 ≠ 实测**。声明是上游的正式承诺；探查是实测证据；两者取并集（见下）。

## Qoder

来源：`GET {gateway}/algo/api/v2/model/list?Encode=1`（`/algo` 前缀必须，GET、空体、Cosy 头）。
拉取工具：`probes/qoder-raw-catalog.mjs`。

| 字段 | 含义 | 用途 |
|---|---|---|
| `key` | 模型 id | 模型身份 |
| `is_vl` | 是否视觉模型 | `supportsImages` → pi-ai `input:["text","image"]` |
| `is_reasoning` | **是否专用思考模型** | ⚠️ 不是"支持档位"的判据（dfmodel=false 但档位最全） |
| `thinking_config.enabled.efforts` | **档位声明**（核心） | `declaredEfforts`，并集的第一来源 |
| `thinking_config.enabled.is_default` | 默认档 | UI 预选 |
| `thinking_config.disabled` | 存在即可关思考 | 走 `@nothink` 后缀路径 |

核对流程：拉目录 → 对照 `.qoder-probe.json` 缓存 → 有声明但 UI 没显示？查 `normalizeCatalogEntry`
→ 无声明但想用？点探查按钮（或 `node probes/verify-qoder-probe-live.mjs <model>`）。

探查结果写回：`.qoder-probe.json`（per-account），含 `validation` 与 `efforts`。
插件读取逻辑：`supportedEffortsOf(info, observed)` = 声明 ∪ (validating 时的实测)，按
pi-ai 键空间 `off < minimal < low < medium < high < xhigh < max` 排序。
**不要**把 non-validating 当"不支持"——那只是"上游不校验"，声明档位仍然有效。

## Trae

来源：宿主跑 `scripts/export-trae-plain.mjs`（读 state.vscdb 的
`{uid}_AI.agent.model.model_list_map`，即 IDE 自己那份）→ `~/.dsh/trae-cn/models.json`。

| 字段（raw 内） | 含义 | 用途 |
|---|---|---|
| `name` / `display_name` | 模型 id / 显示名 | 模型身份 |
| `multimodal` | 视觉 | `supportsImages` |
| `max_mode` | **该 function 下有无 Max 档** | `maxModeByGroup` |
| `context_window_tokens` | `{dev, max}`（核心） | `contextWindowByGroup`；max 存在即 Max 档窗口 |
| `reasoning_effort_config` | **档位声明**（按 function） | `reasoningByGroup`；`support_thinking` + `options` |

⚠️ 同一模型在 `solo_agent` 有档位有 1M，换一个分组可能全没有——
导出脚本按组保留三张表，插件按**当前 function** 取。改了导出脚本必须重跑并重启 DSH。

⚠️ **核对前先确认快照出自哪个数据目录。** 槽位名是按目录分的，拿旧 SOLO 的槽位名去查
IDE 的快照会得出"这个模型没档位"的错误结论：

| 数据目录 | 槽位名 | 快照路径 |
|---|---|---|
| IDE（`--app cn`，**现役，也是默认**） | `solo_agent` / `chat_v3` / `builder_v3` | `~/.dsh/trae-cn/models.json` |
| 并入前的 SOLO（`--app solo`，历史） | `solo_agent_lite` / `solo_agent_remote` / `solo_work_lite` / `solo_coder` … | `~/.dsh/trae/models.json` |

> TRAE SOLO CN 作为独立客户端已被并进 Trae CN IDE（2026-10-11 实测），所以第二行只是
> 历史兼容：老快照继续能跑，新用户不会再有这个目录。

⚠️ 同一个 `state.vscdb` 里现在**两行并存**（`{uid}_AI…` = IDE，`{uid}:AI…` = 并入前的
SOLO）。导出脚本按**精确等值**查、并按产品定优先顺序；用 `LIKE '{uid}%…'` 会让"取到哪行"
取决于 SQLite 扫描顺序 —— 后果不是报错，而是模型列表静默换一批。

**区分两种"没有档位"**（诊断"为什么这个模型没有档位"必看）：

- `reasoning_effort_config` **整个字段缺失** → 上游没给这个信息，解析后是 `null`（如 `kimi-k2.6`、
  `minimax-m2.7`、`qwen3.6-plus`）；
- `{"support_thinking": false}` → 上游**明确说了不支持**（如 `mimo-v2.6-pro`、`seed-evolving`）。

两种在 UI 上都表现为"无档位"，但含义不同：前者是"不知道"，后者是"确定不行"。
**Trae 不能用探查扩展档位** —— 它静默忽略非法值（见 `TRAE-REASONING-EFFORT.md` F8），
所以目录声明就是唯一权威，刷多少次都不会凭空出现。

## WorkBuddy

官方声明直接可用（无需探查）。档位走 pi-ai 标准 `reasoning_effort`。

## pi-ai 键空间（宿主契约，不可扩展）

`off / minimal / low / medium / high / xhigh / max`（`THINKING_LEVELS`，强度递增）。
`thinkingLevelMap` 的**键**必须落在这 7 个之内；**值**是线上拼写（Qoder 同名透传、
Trae 用 light/high/extra_high 映射）。`off` 在 Qoder/Trae 均不作为线上值
（Qoder 400；关思考走 `@nothink`）。

## 半手动核对 SOP（给 AI 的操作单）

1. 拉目录：Qoder 用 `qoder-raw-catalog.mjs`；Trae 重跑 `export-trae-plain.mjs`（默认 `--app cn`）。
2. 对照插件状态文档：`GET /plugins/dsh-qoder-connect/status` 的 `probe` 段。
3. 发现"声明有但 UI 没有"→ 查解析链（`normalizeCatalogEntry` → `reasoningFieldsFor`）。
4. 发现"无声明想确认"→ 跑 `verify-qoder-probe-live.mjs <model>`（花额度，单发）。
5. 把结论写回本文件的"实测记录"小节（下方），不写死进代码。

## 实测记录（追加式，带日期）

- 2026-10-06 Qoder：dfmodel 声明 3 档实测 5 档（并集采纳）；kmodel_latest 声明 3 档、
  实测 non-validating（保声明）；qmodel 声明空、实测 5 档。`off` 一律 400。
- 2026-10-06 Trae：deepseek-v4.1-flash@solo_agent_lite `{dev:200000,max:1000000}`；
  Max 请求表达 = `persist_meta.smart_selection.strategy:"max"` +
  `prompt_max_tokens=936000`（= 1M×93.6%）。`solo_work_lite` 无 max。
- 2026-10-10 Trae CN（重跑导出后全量核对，24 个模型）：**15 个有档位 / 9 个没有**。
  有档位的默认档逐模型不同 —— GLM-5.3 / GLM-5.3-Flash / GLM-5.3-FlashX / Kimi-K2.8-Preview /
  Kimi-K3 默认 `extra_high`；DeepSeek-V4 系 / Qwen3.8 系 / GLM-5.2 / Seed 系 / Step-5 默认 `high`。
  无档位中，`mimo-v2.6-pro`、`mimo-v2.6-flash`、`minimax-m3`、`qwen3.7-plus`、`seed-evolving`
  是上游明确 `support_thinking:false`；`kimi-k2.6`、`kimi-k2.7-code`、`minimax-m2.7`、
  `qwen3.6-plus` 是**没有 `reasoning_effort_config` 字段**（解析后 `null`）。
  用户已在 Trae 客户端确认 MiMo 确实没有档位入口 —— **不是插件漏解析，刷新链路正常**。
- 2026-10-11 Trae（并入复算）：同一模型在 IDE 的三个分组里**窗口声明可以不同** ——
  `deepseek-v4.1-flash` 在 `solo_agent` 下 `contextWindow 300000` /
  `supportedContextWindows [300000, 1000000]`，`chat_v3` 下更窄。这正是插件默认取
  **上游声明的最大档**（面板可关）的原因；关掉就回到上游给的默认档。
  倍率覆盖复测：只查这三个分组名 = 250 ms / **24/24**；带上旧 SOLO 的四个名字 +
  `assistant` / `builder` = 962 ms / 24/24，**边际新增 0**。
