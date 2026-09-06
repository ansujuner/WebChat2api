# Kimi

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi |
| 官网 / API Base | [Kimi](https://www.kimi.com/) |
| 认证 / 凭据字段 | 网页 JWT / `token` |
| 官网核对日期 | 2026-09-06 |

## 默认模型与真实网页路由

| 显示名称 | 网页 `options.model` | `scenario` |
| --- | --- | --- |
| Kimi-K3 | k3-agent | SCENARIO_OK_COMPUTER |
| Kimi-K2.6 | k2d6-chat | SCENARIO_K2D5 |

K3 请求同时携带 `kimiplus_id: "ok-computer"`。K2.6 的网页协议仍使用 `K2D5` 枚举；旧实现发送的 `SCENARIO_K2D6` 不在当前官网协议中，已修复。网页入口 ID 不等于官方 API 型号或 Kimi Code 的 `k3` / `k3-256k`。

默认思考强度沿用官网配置：K3 为 `HIGH`，K2.6 为 `LOW`。`reasoning_effort` 的 low / high / max 分别映射到 K3 对应级别，medium 映射 HIGH；K2.6 仅支持网页 NONE / LOW，非 none 请求取 LOW。当前网页请求保持 `thinking: true`，用独立强度枚举表达模式，避免关闭思考后发生模型降级。

## 核验与限制

- 已验证：官网匿名模型配置返回 HTTP 200、模型到请求字段的完整构造、Connect JSON 封包、未知模型拒绝与离线回归测试。
- 仍需账号实测：K3 的流式/非流式最终回复、工具产物、续聊、删除及账户会员权限。本次没有提交付费生成。
- 官网确有 K3 Swarm，但配置中的旧 `agentMode` 与最新前端集群枚举存在差异；不把集群、文件产物或 Code 模型误报为已支持。
- 旧 `kimi-k2.6`、`kimi-k2.5` 仅作为当前 K2.6 入口的兼容别名，不提供旧版本固定选模。

证据：[官网模型选择说明](https://www.kimi.com/en/help/others/model-mode-selection)、[匿名配置快照](evidence/kimi-models-2026-09-06.json)、[公开前端协议证据](evidence/kimi-web-protocol-2026-09-06.json)。

## 使用

使用自己的已登录 Kimi 账号添加网页凭据，重启应用刷新内置模型后选择 `Kimi-K3` 或 `Kimi-K2.6`。不要将凭据粘贴到日志或提交到仓库。官方 API Key 应配置到独立的官方 API 供应商，不能填入本网页适配器。
