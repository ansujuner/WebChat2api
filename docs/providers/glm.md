# GLM

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | glm |
| 官网 | https://chatglm.cn |
| API Base | https://chatglm.cn/api |
| 认证 | Refresh Token |
| 凭据字段 | `refresh_token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.3-Flash | glm-5.3-flash |
| GLM-5.3 | glm-5.3 |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号级清理对话记录、刷新 token 校验、思考内容输出。

2026-09-06 已从官网公开模型配置确认上述两款；网页显示名 `GLM-Flash` 对应 GLM-5.3-Flash，且为各角色默认模型。请求现在通过 `meta_data.selected_model` 实际切换模型，不再仅更换显示名称。官网思考档位对应 `chat_mode`: 快速 `''`、深度 `thinking`、极致 `deep_thinking`；代理的 `reasoning_effort` 对应 low、medium/high、max。旧智能体 ID 与 `deep_research` 路由保持独立。

后续验证：真实账号生成、视频/多模态能力、清理对话记录接口字段变化。此轮仅完成公开官网配置和前端请求构造核对及离线测试，没有宣称真实生成成功。证据见 [2026-09-06 模型审计](model-audit-glm-zai-mimo-2026-09-06.md)。

## 教程

1. 登录 `chatglm.cn`。
2. 打开 DevTools -> Application -> Local Storage，复制 `chatglm_refresh_token`。
3. 在供应商管理中添加 GLM 账号，填入 `refresh_token`。
4. 使用默认模型 `GLM-5.3-Flash` 验证流式和非流式请求；切换 `GLM-5.3` 时应保持各自真实的 `selected_model`。
