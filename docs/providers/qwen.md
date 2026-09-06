# Qwen

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | qwen |
| 官网 | https://www.qianwen.com |
| API Base | https://chat2.qianwen.com |
| 认证 | Tongyi SSO Ticket |
| 凭据字段 | `ticket` |

## 默认模型

2026-09-06 已读取官网当前 [模型目录](https://chat2-api.qianwen.com/api/v1/model/list)。映射使用 `modelCode`，不是 `legacyModelCode`。官网默认项显示为 `Qwen3.7-千问`，本项目沿用简洁名称 `Qwen3.7`。

| 显示名称 | 实际模型 ID |
| --- | --- |
| Qwen3.7 | Qwen |
| Qwen3.8-Max | Qwen3.8-Max |
| Qwen3.7-Max | Qwen3.7-Max |
| Qwen3.6-Flash | Qwen3.6-Flash |

## 适配状态

已实现：国内版网页对话、流式/非流式转换、账号级批量清理对话记录、文件记录清理，以及[网页端多轮续聊](conversation-continuity.md)。后续轮次复用 `session_id`，使用上游返回的 `reqid` 作为 `parent_req_id`，仅发送新增输入；每轮请求仍使用新的 `req_id`。保留中的会话不会在回复后自动删除。

目前已通过模型目录核对和离线多轮模拟测试，覆盖会话复用、流式/非流式游标、失败/截断处理及取消上游请求；未使用真实账号发送生成请求，真实网页续聊仍需登录后验证。

思考选项不再把所选型号改成已退出当前目录的 `Qwen3-Max-Thinking-Preview`。聊天请求仍保留既有 host；不能仅凭模型列表的 host 推断生成接口也已迁移。后续需验证实际生成、批量删除会话、附件/文件记录清理接口。

## 教程

1. 登录 `www.qianwen.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `tongyi_sso_ticket`。
3. 在供应商管理中添加 Qwen 账号，填入 `ticket`。
4. 注意本供应商 ID 是 `qwen`，不是 `qwen-ai`。
