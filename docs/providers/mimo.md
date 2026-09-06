# Mimo

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | mimo |
| 官网 | https://aistudio.xiaomimimo.com |
| API Base | https://aistudio.xiaomimimo.com |
| 认证 | Cookie |
| 凭据字段 | `service_token`, `user_id`, `ph_token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| MiMo-V2.5-Pro | mimo-v2.5-pro |
| MiMo-V2.5 | mimo-v2.5 |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、会话保存、标题生成、账号级清理对话记录、托管工具调用。

后续验证：官网 Cookie 字段、会话保存接口、模型 ID 升级。

2026-09-06 已核对官网 [`/open-apis/bot/config`](https://aistudio.xiaomimimo.com/open-apis/bot/config)：上述两款均使用同名小写网页 ID，默认开启思考并自动判断联网。代理遵循这组网页默认值，显式 `web_search: false` 或 `reasoning_effort: false` 可关闭相应选项。

MiMo-V2-Flash 已从默认列表删除：官方 [Studio 更新记录](https://mimo.mi.com/docs/en-US/updates/feature/studio) 于 2026-06-07 退休 V2.0 系列，[模型下线表](https://mimo.mi.com/docs/en-US/updates/deprecate) 列明旧 V2 API ID 于 2026-06-30 到期。配置接口仍残留旧/内部 ID，并不代表可以继续对外承诺支持。UltraSpeed 为申请制独立体验，ASR/TTS 属于不同接口，本聊天适配器不将它们混入模型列表。

本轮已通过本地 HTTP 模拟服务验证两款模型实际请求字段；未使用真实账号发起生成。完整证据见 [2026-09-06 模型审计](model-audit-glm-zai-mimo-2026-09-06.md)。

## 教程

1. 登录 `aistudio.xiaomimimo.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `serviceToken`、`userId`、`xiaomichatbot_ph`。
3. 在供应商管理中添加 Mimo 账号并填写三项凭据。
4. 使用 `MiMo-V2.5-Pro` 作为首选验证模型。
