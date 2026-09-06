# Qwen / Perplexity 模型审计（2026-09-06）

本次核对网页产品实际目录，而非将厂商付费 API 发布名称填进网页协议。官网读取使用隔离、未登录浏览器，未访问已有个人浏览器凭据、未发送真实生成请求。模拟请求测试只证明代码传递的字段正确，不等于账号权限和生成端到端验证。

## Qwen 国内版

- 来源：[千问官网](https://www.qianwen.com/)、官网调用的 [模型目录](https://chat2-api.qianwen.com/api/v1/model/list)，读取日期 2026-09-06，HTTP 200。
- 最小证据：[qwen-models-2026-09-06.json](evidence/qwen-models-2026-09-06.json)。返回四个 `show: true` 条目：`Qwen3.7-千问 → Qwen`、`Qwen3.8-Max → Qwen3.8-Max`、`Qwen3.7-Max → Qwen3.7-Max`、`Qwen3.6-Flash → Qwen3.6-Flash`。
- 本项目默认项名称沿用简洁风格 `Qwen3.7`，后端使用实际 `modelCode: Qwen`，不使用 `legacyModelCode`。删除已经不在这次目录中的旧 Flash / Max / Preview / Coder 默认项。
- 适配器不再因开启思考而把所选模型替换成旧 `Qwen3-Max-Thinking-Preview`；显式关闭思考/搜索优先于别名推断。
- 尚未验证：登录后的模型权限、真实生成协议、流式/非流式输出以及删除接口。模型目录位于 `chat2-api.qianwen.com` 不足以证明生成接口也迁移，保留既有 `chat2.qianwen.com/api/v2/chat`。

## Qwen AI 国际版 / Qwen Studio

- 来源：[Qwen Studio](https://chat.qwen.ai/)、公开 [网页模型目录](https://chat.qwen.ai/api/models)，读取日期 2026-09-06，HTTP 200。目录同时由网页浏览器和公开页面读取交叉核对。
- 最小证据：[qwen-ai-models-2026-09-06.json](evidence/qwen-ai-models-2026-09-06.json)。只返回 `Qwen3.7-Plus → qwen3.7-plus`、`Qwen3.8-Max → qwen3.8-max`，均 `active / visitorActive: true`，包含 `t2t` 能力。
- 默认项与当前目录保持一致。通用 `qwen / qwen3` 选择当前网页默认 Plus，`qwen3.8` 选择 Max；不把旧精确版本名自动升成新版本。用户显式映射优先，避免泛用别名盖过自定义 ID。
- 清除适配器映射时写入的隐式思考状态；大小写后缀一致处理。原有模型接口硬编码版本请求头不再使用；官网无该请求头即可返回当前目录。
- 尚未验证：登录账号的权限、生成接口版本、流式/非流式真实输出及多模态输入。本次未发送生成请求。当前适配器每次创建新 chat，不宣称真正的服务端会话续接。

## Perplexity

- 来源：[官方当前订阅模型清单](https://www.perplexity.ai/help-center/en/articles/10354919-what-advanced-ai-models-are-included-in-my-subscription)，英文页面更新于 2026-09-04，本次读取于 2026-09-06。
- 帮助中心 Search 标签包括 Sonar 2、GPT-5.6 Terra / Sol、Gemini 3.7 Flash、Claude Sonnet 5 / Opus 5、Kimi K3、GLM 5.3、Grok 4.6、Nemotron 3 Ultra。免费账号使用 Best 自动选择；付费型号与权限有关。产品 API 目录与网页订阅目录互相独立。
- 官方页面的“型号名”并不等于 `/rest/sse/perplexity_ask` 的 `model_preference`。网页模型菜单的实际代码从服务端配置读取 `label / non_reasoning_model / reasoning_model / subscription_tier`，不能根据名称猜后端 ID。
- 已修复旧适配器将任何 GPT / Claude / Gemini 名称强制降级为 GPT-5 / Claude 4 / Gemini 2.5、将未知 ID 静默变成 `turbo` 的行为。显式配置及已经映射的实际 ID 现在原样传递；历史 Auto 线路保持兼容。
- 已从官方页面实际加载的 `SearchModelMenuItems__v2-CziyT6iY.js` 跟进 `spa-shell__v2-Bor3Uwvy.js` 中的配置请求，浏览器读取 [实际模型配置](https://www.perplexity.ai/rest/models/config/v2) HTTP 200。证据：[perplexity-models-2026-09-06.json](evidence/perplexity-models-2026-09-06.json)。`default_models.search = turbo`，对应 Best；当前 Search 十个条目的精确映射与 Pro/Max 权限见 [供应商说明](perplexity.md)。
- **证据冲突处理：** 实时配置是 Gemini **3.8 Flash**，而两日前帮助中心仍写 3.7；以运行时为准。`search_config` 中还混有 `comet_browser_agent_*`，因此继续按对应 `models[id].mode === search` 过滤；同一标签 Claude Sonnet 5 不能错选成 Comet ID。不能把 `models` 字典中仅供兼容的 GPT-4/旧版本枚举全部加入默认列表。
- 网页把 Best 标签指向 `getDefaultModelForMode('search')`；`Kw` 将 Search 转成请求的 `mode: copilot`，与既有适配器一致。保留免费线路，增加 Best 正式名称与 Auto 兼容别名。
- 可选思考通过真实 `reasoning_model` ID 选择，不作为额外虚构型号。仅思考模型保留其默认真实 ID；Pro/Max 权限仍由上游验证。未发送真实生成请求，不宣称账号权限/流式/非流式端到端验证完成。

## 验证

运行 `node --test tests/providers/qwen-perplexity-model-refresh.test.js`：覆盖默认模型目录、大小写/显式映射、两版 Qwen 实际构造的请求体、思考不切换成旧 Preview、Perplexity 不静默降级与请求体中的精确 ID。测试隔离 Electron/网络，仅使用虚构测试凭据。

主仓库 `src/main/store/types.ts` 已从 `providers/builtin/index.ts` 重导出内置清单，实际实现为单一来源；无须重新加入重复的第二份模型配置。README、翻译和跨供应商共享测试由主任务统一同步。
