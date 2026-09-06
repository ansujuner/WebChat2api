# Perplexity

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | perplexity |
| 官网 | https://www.perplexity.ai |
| API Base | https://www.perplexity.ai |
| 认证 | Cookie |
| 凭据字段 | `sessionToken` |

## 默认模型

2026-09-06 从官网公开 [网页模型配置](https://www.perplexity.ai/rest/models/config/v2) 核实。只同步模式为 `search` 的当前配置条目，不混入 Comet / Computer 模型或 `models` 字典中的历史型号。

| 显示名称 | 实际模型 ID | 权限 |
| --- | --- | --- |
| Best | turbo | 免费自动选择 |
| Auto | turbo | Best 的旧兼容别名 |
| Sonar 2 | experimental | Pro |
| GPT-5.6 Terra | gpt56_terra | Pro |
| GPT-5.6 Sol | gpt56_sol | Max |
| Gemini 3.8 Flash | gemini38flash | Pro |
| Claude Sonnet 5 | claude50sonnet | Pro |
| Claude Opus 5 | claude50opus | Max |
| Kimi K3 | kimik3thinking | Pro |
| GLM 5.3 | glm_5_3_thinking | Pro |
| Grok 4.6 | grok46low | Pro |
| Nemotron 3 Ultra | nv_nemotron_3_ultra | Pro |

这些是网页订阅模型，不代表免费账户均可调用，也不是付费 Perplexity API 目录。实际权限由账号套餐、区域、组织设置及配额决定。最新 [官方订阅说明](https://www.perplexity.ai/help-center/en/articles/10354919-what-advanced-ai-models-are-included-in-my-subscription) 更新于 2026-09-04，其中 Gemini 标签仍为 3.7 Flash；本次以 2026-09-06 网页实时配置的 **3.8 Flash** 为准。

### 思考模式

传入 `reasoning_effort: "low" / "medium" / "high" / "max"` 会选择当前官网明确提供的思考变体：Terra/Sol 的 `_thinking`、Gemini/Claude 的 `thinking`，以及 Grok 的 `grok46medium`。这只是启用思考，不宣称网页接口可分别调节这些推理档位。Kimi、GLM、Nemotron 是目录中的仅思考模型；Best、Sonar 不伪造思考版本。

## 适配状态

既有实现：搜索增强对话、流式/非流式转换、账号级清理对话记录。本次核实目录及静态官网模型选择路径，并模拟验证请求体。未使用真实账号发送生成，不将目录核验称作端到端验证。

已修复新版 GPT / Gemini / Claude ID 被匹配成旧型号、未知 ID 被静默改成 Auto 的问题。后续仍需按账号验证生成权限、实际流式/非流式输出、搜索来源和引用字段。

## 教程

1. 登录 `www.perplexity.ai`。
2. 打开 DevTools -> Application -> Cookies，复制 `__Secure-next-auth.session-token`。
3. 在供应商管理中添加 Perplexity 账号，填入 `sessionToken`。
4. Free 用户选择 `Best`（或旧别名 `Auto`）；具备相应订阅权限后再选择具名型号。自定义模型需使用当前账号官网返回的真实 ID，不能按名称猜测。
