# 自定义供应商 / Custom providers

自定义供应商接入 **OpenAI 兼容 Chat Completions API**，不是输入任意网页地址就能自动反向适配。仅提供 Anthropic Messages、Responses 或私有网页协议的服务需要额外适配，不能直接使用此入口。

## 添加与管理

1. 打开「供应商」，选择「添加自定义供应商」（或添加窗口中的「自定义」）。
2. 填写名称和 API Base URL。裸域名自动补 `/v1`；已有路径保留。误粘贴完整 `/chat/completions` 或 `/models` 地址时，会还原为 Base URL。仅接受 HTTP/HTTPS 地址，不把密钥放进 URL。
3. 填写模型 ID（可稍后获取），保存供应商后添加账号。API Key 保存在账号凭据中，不是供应商的请求头、描述或导出模板中。
4. 需要鉴权的服务选择必填 API Key；不需要鉴权的本地服务可使用可选 API Key，并添加一个留空密钥的本地账号以参与调度。
5. 保存账号后使用「获取模型」，从该供应商的 `/models` 读取目录。不支持目录接口的服务可手填模型 ID；获取失败不会清空原模型列表。
6. 自定义供应商支持编辑、启停和删除。删除会同时删除其账号；界面先确认。单个账号的开关、冷却和测活规则与内置供应商一致。

上游 API Key 与本软件的网关 API Key 是两回事：上游密钥填在供应商账号，客户端填写本软件的网关密钥。不要提交真实密钥、账号文件或日志到仓库。

## 工具与上下文

- 自定义 API 使用原生 `tools`、`tool_choice` 和 `parallel_tool_calls`，不把工具定义替换为长篇网页提示词。模型本身仍须支持这些字段。
- 客户端工具仍由客户端执行，本软件不会因为模型返回了工具名就执行命令。
- 标准 API 通常是无状态的：第二轮需带上用户请求、assistant 工具调用和匹配 `tool_call_id` 的工具结果。本软件的工具测试按此协议发送完整两轮历史，不要求上游网站会话 ID。
- 已适配的网页供应商继续复用网站会话、只发送新增输入；两种机制不会混用。
- 可通过 OpenAI Chat Completions 或本软件的 Anthropic Messages 兼容入口使用同一自定义模型，包括流式工具事件。

## 工具测试结果怎么看

设置中的测试会发起两轮生成：先返回一个无副作用的本地回显工具调用，再将临时结果回传给模型。只有结构正确且最终答案消费了该结果，才显示通过。

验证码、登录失效、冷却/限流或模型不可用，代表**尚未验证工具能力**，不等于解析器失败。请按显示的原因处理账号或官网验证，再手动测试；应用不自动重试生成请求，也不会将本地模拟测试冒充官网成功。

## English quick guide

Use **Providers → Add custom provider** for an OpenAI-compatible Chat Completions API, not an arbitrary chat website. Enter a name, Base URL, and model IDs; save the provider, then add an account containing its API key. A root URL receives `/v1`; existing base paths are retained and a pasted `/chat/completions` or `/models` suffix is removed. Optional API-key mode supports local unauthenticated services with an empty-key account.

Fetch models after adding the account, or enter model IDs manually if the service has no model-list endpoint. Failed discovery retains existing models. Editing, enable/disable, and confirmed deletion are available; deleting the provider also deletes its accounts.

Native tool definitions remain structured. Stateless API continuations include the original messages, assistant tool call, and matching tool result; supported web adapters still use incremental website conversations. The two-turn tool test reports verification, authentication, rate-limit, and model failures separately from tool parsing. A local fixture pass does not prove live provider availability. Tools execute in the client, not automatically in this app.

See [Claude Code](../claude-code.md), [conversation continuity](conversation-continuity.md), and [account liveness](../account-liveness.md).
