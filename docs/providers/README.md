# Provider Adaptation Guides

这些文档记录内置供应商的认证方式、默认模型、适配状态和后续教程入口。更新模型或新增供应商能力时，优先同步对应供应商文档。

最新核对：[2026-09-06 逐家官网模型更新记录](model-audit-2026-09-06.md)。区分“官网已发布”“网页目录可选”“请求字段已核对”和“真实账号生成通过”，不要只依据开放平台型号替换网页协议。

| Provider ID | 文档 |
| --- | --- |
| deepseek | [DeepSeek](deepseek.md) |
| glm | [GLM](glm.md) |
| kimi | [Kimi](kimi.md) |
| minimax | [MiniMax](minimax.md) |
| mimo | [Mimo](mimo.md) |
| perplexity | [Perplexity](perplexity.md) |
| qwen | [Qwen](qwen.md) |
| qwen-ai | [Qwen AI](qwen-ai.md) |
| zai | [Z.ai](zai.md) |

通用适配流程：

1. 在网页登录供应商官网，使用 DevTools 录制登录、发起对话、流式响应、删除会话和模型切换。
2. 更新 `src/main/providers/builtin/<provider>.ts` 的默认模型和模型映射。
3. 更新对应 `src/main/proxy/adapters/<provider>.ts` 的请求体、响应解析、会话创建/删除逻辑。
4. 在供应商管理中添加账号，在模型管理中确认默认模型和自定义模型都能保存。
5. 用 OpenAI-compatible `/v1/chat/completions` 验证流式、非流式、多轮、工具调用、清理对话记录。
