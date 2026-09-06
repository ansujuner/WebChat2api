# Qwen AI

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | qwen-ai |
| 官网 | https://chat.qwen.ai |
| API Base | https://chat.qwen.ai |
| 认证 | JWT Token |
| 凭据字段 | `token`, `cookies` |

## 默认模型

2026-09-06 已在未登录的官网页面及 [网页模型目录](https://chat.qwen.ai/api/models) 核实以下两个可用条目。这里同步的是 Qwen Studio 网页模型，不是阿里云百炼 API 模型目录。

| 显示名称 | 实际模型 ID |
| --- | --- |
| Qwen3.7-Plus | qwen3.7-plus |
| Qwen3.8-Max | qwen3.8-max |

## 历史官网模型（非当前可用清单）

以下条目仅保留旧 `backup/har/chat.qwen.ai2.har` 的历史记录。它们不在本次实时公开模型清单中，不能据此判断目前可用，不建议直接添加。只有账号当前模型目录明确返回该 ID 时，才在供应商管理 -> 模型管理中添加。

| 显示名称 | 实际模型 ID | 备注 |
| --- | --- | --- |
| Qwen3.7-Max-Preview | qwen-latest-series-invite-beta-v24 | Preview |
| Qwen3.7-Plus-Preview | qwen-latest-series-invite-beta-v16 | Preview |
| Qwen3.6-Max-Preview | qwen3.6-max-preview | Preview |
| Qwen3.6-Plus-Preview | qwen3.6-plus-preview | Preview |
| Qwen3.5-Plus | qwen3.5-plus | 低版本 |
| Qwen3.5-Omni-Plus | qwen3.5-omni-plus | 低版本 |
| Qwen3.5-Flash | qwen3.5-flash | 低版本 |
| Qwen3.5-Max-Preview | qwen3.5-max-2026-03-08 | 低版本 Preview |
| Qwen3.5-397B-A17B | qwen3.5-397b-a17b | 低版本 |
| Qwen3.5-122B-A10B | qwen3.5-122b-a10b | 低版本 |
| Qwen3.5-Omni-Flash | qwen3.5-omni-flash | 低版本 |
| Qwen3.5-27B | qwen3.5-27b | 低版本 |
| Qwen3.5-35B-A3B | qwen3.5-35b-a3b | 低版本 |
| Qwen3-Max | qwen3-max-2026-01-23 | 普通 Qwen3 |
| Qwen3-235B-A22B-2507 / Qwen2.5-Plus | qwen-plus-2025-07-28 | HAR 页面标签存在歧义 |
| Qwen3-VL-235B-A22B | qwen3-vl-plus | 多模态 |
| Qwen3-Omni-Flash | qwen3-omni-flash-2025-12-01 | Omni |
| Qwen2.5-Max | qwen-max-latest | 低版本 |

## 适配状态

已实现：国际版网页对话、流式/非流式转换、账号级清理对话记录、思考模式后缀、模型别名，以及[网页端多轮续聊](conversation-continuity.md)。后续轮次复用 `chat_id`，把服务端 `response.created.response_id` 作为下一轮 `parent_id`，仅发送新增用户输入或工具结果，不再每轮创建新会话。不会用本地生成的用户 `fid` 或 `childrenIds` 猜测回复游标。

此次已核对模型目录并通过离线多轮模拟测试，覆盖会话复用、流式/非流式游标、工具结果、截断失败及取消上游请求。未使用真实账号发送生成请求；上述回复游标的续接语义仍基于既有协议实现，需真实账号验证，不能据此声称网页端到端通过。

后续验证：登录账号的模型权限、官网请求头、实际流式/非流式生成、图片/多模态字段。旧精确版本不会被静默替换为新版本；显式自定义模型映射优先。

## 教程

1. 登录 `chat.qwen.ai`。
2. 打开 DevTools -> Application -> Local Storage，复制 `token`；如请求需要 Cookie，同时复制完整 Cookie 字符串。
3. 在供应商管理中添加 Qwen AI 账号，填入 `token`，可选填 `cookies`。
4. 在模型管理中使用默认模型；如需其他模型，先从当前账号的官网目录验证实际 ID，不要复用历史表猜测。
