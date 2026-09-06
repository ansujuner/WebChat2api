# Claude Code 接入 Chat2API

## 已实现的接口

- `POST /v1/messages`：Anthropic Messages 请求和响应，支持流式与非流式。
- `POST /v1/messages/count_tokens`：本地估算输入 token 数，不调用网页生成，也不创建会话。响应头 `X-Chat2API-Token-Count: estimated` 明确标记估算；不能用于精确计费。
- `GET /v1/models`：保留 OpenAI 格式，同时在 Anthropic 请求中提供模型发现字段。
- 同时接受 `Authorization: Bearer ...` 和 `x-api-key` 认证；错误使用 Anthropic 的 `{type:"error",error:{...}}` 格式。

按 [Claude Code 官网网关要求](https://code.claude.com/docs/en/llm-gateway) 实现 Messages 和 count_tokens 两个路径。流式事件遵循 [官方流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming)：message_start、content_block_start/delta/stop、message_delta、message_stop；工具参数使用 input_json_delta。

## 本机启动与账号登录

1. 运行 `scripts/start-local.ps1 -Build`，启动本项目生产构建的桌面应用。
2. 在“供应商”页面添加/登录需要的账号。已经保存的账号和设置不会被启动脚本覆盖。
3. 点击“启动代理”，确认界面显示运行中。端口以界面为准；例如当前机器使用 `8081`，本机访问地址就是 `http://127.0.0.1:8081`。
4. 若已启用代理鉴权，在应用的“API Key”页面取得代理密钥。不要拿网站登录 Token 当 Claude Code 的 API Key。

## 启动 Claude Code

在你要编程的项目目录中运行下面的启动器（可使用它的绝对路径）：

```powershell
$WebChat2api = 'C:\path\to\WebChat2api' # 修改为本机项目路径
& (Join-Path $WebChat2api 'scripts\start-claude-code.ps1') -BaseUrl 'http://127.0.0.1:8081' -Model 'deepseek-v4-flash'
```

脚本会安全提示输入代理 API Key。仅当应用明确关闭鉴权时才添加 `-NoAuth`。脚本只给这次 Claude Code 进程设置环境变量，退出后恢复，不改动全局 Claude 配置，也不会输出或保存密钥。该脚本不安装 Claude Code；若未安装，请先按 [官方安装文档](https://code.claude.com/docs/en/setup) 安装。

如果你自行配置：

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8081'
$env:ANTHROPIC_MODEL = 'deepseek-v4-flash'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-flash'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-flash'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
$env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
$env:ENABLE_TOOL_SEARCH = 'false'
# 另外设置 ANTHROPIC_AUTH_TOKEN 为你的 Chat2API 代理 API Key，然后启动 claude。
```

`ANTHROPIC_BASE_URL` **不加 `/v1`**。模型必须是应用中可用的真实模型 ID；接入协议兼容不代表这些网页模型变成了 Claude。没有把 `claude-*` 名称偷偷映射到其他供应商。模型环境变量依据 [官方模型配置](https://code.claude.com/docs/en/model-config)；关闭工具搜索的方式见 [官方工具搜索文档](https://code.claude.com/docs/en/agent-sdk/tool-search)。

## 工具调用与多轮会话

- 支持客户端定义的工具、`tool_use`、`tool_result`；实际工具由 Claude Code 在自己的权限控制下执行，代理不执行这些工具。
- 继续使用上一轮实现的网页会话复用。即使 Claude Code 发来完整历史，也仅把新增用户输入/工具结果送往原网页会话。
- 系统提示与工具说明只在新网页会话首轮注入，后续不重新生成或发送；工具响应解析器仍然保留。新开会话、应用重启或历史不匹配时不能假装原会话仍有上下文。
- 优先使用 Claude Code 的会话、子代理和父代理请求头区分会话；没有这些头时保留 metadata.user_id 身份。固定账号和模型，避免不同会话/子代理串聊，见[官网网关协议](https://code.claude.com/docs/en/llm-gateway-protocol)。
- 工具参数的 JSON 空白与对象键顺序不影响历史匹配。
- 只有完整、有效的回复才提交续聊状态。流被截断或工具参数无效时输出原生 error 事件，不伪造 message_stop。
- 只发本轮输入时仍可用 `X-Chat2API-Session-ID`；普通 Claude Code 全历史请求无需手动带此头。
- 响应头 `X-Chat2API-Conversation: new|continued` 可确认这一轮是新会话还是续聊。续聊索引保存在应用进程内，重启后不会盲目猜测账号的“最后一个聊天”。

### 设置页工具测试

在“设置 → 工具调用”保存设置后，选择有已登录账号的模型并点击“测试”。测试走应用内部接口，不依赖管理 API 是否启用，也不需要填写管理密钥；它使用正在监听的实际端口。

测试发起两轮真实请求：第一轮要求模型调用唯一的无副作用回显工具并核验参数；第二轮把固定测试结果送回同一会话，核验模型是否正确接收。两轮都通过才显示成功。测试不会执行终端命令、读写文件或替模型调用外部工具；失败时显示具体阶段，不会自动重试。

工具参数中的字符串、代码空白、CDATA 和多段工具返回均被保留；各次调用使用唯一 ID，代码围栏里的示例不会被执行成工具。

## 明确的兼容边界

- 这是 Anthropic **客户端工具协议子集**到网页适配器的转换，不是 Anthropic 原生服务透传。接收 `anthropic-version: 2023-06-01`；版本、beta 和认证头不会被盲目转发给其他网站。未知功能字段明确报 400。
- 不提供 Anthropic 服务端工具、tool_search/defer_loading、签名 thinking 内容、严格结构化输出或 context_management 服务端上下文编辑。启动器禁用实验 beta 和工具搜索，避免 Claude Code 要求这些原生服务能力。
- cache_control 仅作为兼容元数据接收，不声称实现 Anthropic 缓存或缓存计费。
- thinking enabled/adaptive 映射为供应商的思考强度；xhigh 近似映射为 max。不能保证精确思考 token 预算，也不生成假的 Claude 思考签名。
- 图片字段转换为 OpenAI image_url；是否能识图仍由具体网页适配器和模型决定。
- 网页端是否严格遵守 max_tokens、stop_sequences、工具强制选择和采样设置取决于供应商；不承诺 Anthropic 原生模型的完整约束语义。
- 模型、系统提示、工具定义或对话模式发生变化时，沿用现有安全策略，要求显式新开会话；不能通过悄悄重发历史掩盖上下文丢失。
- 官网协议测试使用模拟上游和本机 HTTP，必须在真实账号登录后再验证实际生成效果。
