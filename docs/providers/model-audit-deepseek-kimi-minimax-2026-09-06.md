# DeepSeek / Kimi / MiniMax 模型核验

核对日期：2026-09-06（Asia/Shanghai）。范围：官方资料、jshook 观察到的公开网页与公开配置、本地请求构造和离线测试；不读取真实凭据、不发付费生成。

| 供应商 | 官方当前信息 | 本次落地 | 尚未验证 |
| --- | --- | --- | --- |
| DeepSeek | 当前官网前端包含 default / expert / vision 三个入口 | 映射三个精确型号；视觉请求真实上传图片、等待处理并发送文件引用；保留原生会话游标 | 本文的离线测试不替代真实账号图片识别验证；网页思考强度协议 |
| Kimi | K3、K2.6、K3 Swarm | 新增 K3；K2.6 修正为 K2D5 场景 + k2d6-chat；新增真实 options.model / reasoning_effort 字段；未知型号拒绝 | K3 实聊和工具产物；Swarm 因新旧配置差异未暴露 |
| MiniMax | M3 已发布，官网新版会话可选 M3 | 旧 Matrix 路由更正为 MiniMax-Agent；M2.7 仅适配器兼容，旧客户端需手动映射 | 新版 M3 会话协议；旧 Matrix 当前账户可用性 |

## 官方证据

### DeepSeek

- [更新日志](https://api-docs.deepseek.com/updates/)记录 API 发布情况，但不能据此判断当前网页不支持 Vision；此前的 API-only 推断已由当前网页源码证据修正。
- [V4 初始公告](https://api-docs.deepseek.com/news/news260424/)：网页通过 Expert/Instant 入口体验 V4。开放平台 ID 与网页 `model_type` 是不同协议层。
- [API 入门](https://api-docs.deepseek.com/)：API 继续使用稳定 V4 ID，并非要求客户端改成日期版本名。
- 2026-09-06 从[官网首页](https://chat.deepseek.com/)取得[当前公开主包](https://fe-static.deepseek.com/chat/static/main.2029023598.js)。其上传控制器明确使用 `POST /api/v0/file/upload_file`，multipart 字段 `file`；上传头为 `x-model-type`、`x-thinking-enabled`、`x-file-size`，PoW 的 `target_path` 是文件上传路径而不是对话路径。
- 上传返回 `data.biz_data.id/status`；`GET /api/v0/file/fetch_files` 按 `file_ids` 查询。只有 `SUCCESS` 可用于完成请求，`PENDING/PARSING` 继续轮询。主包枚举中的失败、内容过滤、空内容等状态不伪装成功。审核明确 `reject` 也拒绝使用。
- 对话仍是 `POST /api/v0/chat/completion`，视觉入口发送 `model_type: "vision"` 和真实 `ref_file_ids`，并继续使用同一个 `chat_session_id` 与上一条实际 `parent_message_id`。图片不会转换成提示词里的 URL，也不会在后续仅文本一轮重新上传。
- [当前网络库公开包](https://fe-static.deepseek.com/chat/static/default-vendors.b9e9755780.js)使用重复查询键编码数组；本实现一次轮询一个文件，等价于 `file_ids=<id>`。

#### 图片输入边界

支持 OpenAI `image_url` 和 Anthropic 图片块经兼容层转换后的 PNG / JPEG / WebP / GIF **base64 data URL**。先检查 MIME、文件标识、编码、每张 10 MiB、最多 10 张、合计 20 MiB，再进行认证或上传。这些是本地保守资源限制，不是声称官网每个账号都具有相同配额。

目前不代替客户端抓取远程图片 URL，以免经过系统代理的任意 URL 下载引入内网访问或 DNS 重绑定问题；请先在客户端转换为 data URL。文本模型收到图片时明确提示选择 `deepseek-v4-flash-vision-exp`，不将只提取文字冒充完整视觉能力。图片与网页搜索同时启用时明确报错。

上传和生成均不自动重试；只有有时限的只读处理状态轮询。错误中不包含图片数据、原始文件名、签名地址、凭据或上游任意文本。

### Kimi

- [K3 官方公告，2026-07-17](https://www.kimi.com/news/kimi-k3)：K3 已开放网页等入口。
- [官网模型选择](https://www.kimi.com/en/help/others/model-mode-selection)：K2.6、K3 和集群是不同入口。
- 匿名 `GetAvailableModels` 返回 HTTP 200，见 [原始响应快照](evidence/kimi-models-2026-09-06.json)。K2.6 是 `SCENARIO_K2D5`，K3 是 `SCENARIO_OK_COMPUTER`，插件 ID 为 `ok-computer`。
- 2026-09-05 公开前端 build `0137bac` 的入口常量、protobuf 字段和 `transformChatParamsToChatRequest` 证明选模位于 `options.model`；对应入口为 `k2d6-chat` / `k3-agent`。旧 `SCENARIO_K2D6` 在当前枚举中不存在。见 [URL / SHA-256 / 提取字段](evidence/kimi-web-protocol-2026-09-06.json)。
- 配置仍返回旧式 key / agentMode，新主包却有不同的集群场景；本次只接入两者一致的普通 K3，不猜测 Swarm。

### MiniMax

- [M3 官方公告，2026-06-01](https://www.minimax.io/blog/minimax-m3)：M3 上线 Code、Token Plan 和 API。
- jshook 观察到新版网页 M3；[公开选模组件](https://cdn.hailuoai.com/mavis-chat/prod-web-sh-0.1.165/_next/static/chunks/29749.b28eb61ea98e1e2e.js)使用会话 `providerID/modelID`。
- [公开 BotStream 代码](https://cdn.hailuoai.com/mavis-chat/prod-web-sh-0.1.165/_next/static/chunks/56229.f5afc3d8b45ff97c.js)仍包含旧 Matrix 发消息分支，不能用另一个组件中的 M3 标签证明该分支固定调用 M3。
- 本地 `MiniMaxAdapter.messagesPrepare()` 从未将 `request.model` 发给上游；原始版本只是把型号抄入响应。更正为服务端选模标签，不虚称固定版本。适配器仍识别旧标签，但旧客户端必须手动添加全局 `MiniMax-M2.7` → `MiniMax-Agent`（首选 `minimax`）以明确接受服务端选模；不自动覆盖用户映射。

## 验证与重放

执行 `node --test tests/providers/model-audit-deepseek-kimi-minimax.test.ts tests/providers/deepseek-vision.test.js tests/providers/conversation-deepseek-kimi-glm.test.js`。57 项离线测试覆盖映射与特性分离、真实视觉 multipart/PoW/文件引用、处理失败和超时、图片资源边界、跨轮游标与不重传、官网快照到 Kimi 场景、支持的思考枚举、UTF-8 Connect 封包、未知型号拒绝和 MiniMax 兼容别名。它们验证请求构造及响应处理，不替代真实账号生成验证。

本次不新增独立官方付费 API provider，不把未知的新模型自动落到旧模型，不用 API 发布名伪造网页枚举。
