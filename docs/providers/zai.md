# Z.ai

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | zai |
| 官网 | https://chat.z.ai |
| API Base | https://chat.z.ai/api |
| 认证 | JWT Token |
| 凭据字段 | `token`，可选 `captcha_verify_param` |
| 当前状态 | 受前端验证码风控限制，暂不可用 |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.3-Flash | x-preview-l |
| GLM-5.3 | glm-5.3 |
| GLM-5.2 | glm-5.2 |
| GLM-5-Turbo | GLM-5-Turbo |
| GLM-5V-Turbo | GLM-5v-Turbo |
| GLM-4.7 | glm-4.7 |

## 适配状态

暂不可用：Z.ai 当前对 `/api/v2/chat/completions` 增加了前端验证码风控校验。Web 页面可用是因为浏览器会运行阿里云 CaptchaJS、生成设备令牌并完成 VerifyCaptchaV3，再把短时有效的 `captcha_verify_param` 带入对话请求。代理侧仅携带 JWT token、Cookie、浏览器 headers 或 HAR 中复制出的旧 `captcha_verify_param`，仍可能返回 `FRONTEND_CAPTCHA_REQUIRED`。

已完成的适配尝试：流式对话、非流式对话、多轮会话、账号级清理对话记录、GLM 系列模型映射、`X-FE-Version: prod-fe-1.1.93`、`X-Region: domestic`、带浏览器环境 query 参数和 token 认证头的 `/api/v2/chat/completions` 请求。

2026-09-06 已通过官网浏览器加载的 [`/api/models`](https://chat.z.ai/api/models) 核对上述六款模型。注意 GLM-5.3-Flash 的**网页请求 ID 是 `x-preview-l`**，不是开放平台 API 的 `glm-5.3-flash`。GLM-5.3/Flash 的官网能力不允许关闭思考，适配器会保持思考启用。旧 GLM-5.1、GLM-5 不再作为默认模型展示；自定义旧 ID 不会被静默替换成新模型。

此轮验证包括公开模型目录和离线映射测试，不包含登录账号后的真实生成；模型更新不代表已解除上面的验证码限制。核对证据及边界见 [2026-09-06 模型审计](model-audit-glm-zai-mimo-2026-09-06.md)。

后续方向：需要独立评估真实浏览器辅助模式，让 Z.ai Web 页面自行生成短时验证码参数；在此之前不建议把 Z.ai 作为稳定可用供应商。

## 教程

### 已有账号恢复网页登录（v1.6.3 起）

1. 打开 **供应商 → Z.ai → 账户管理**。
2. 找到该账号，点 **⋯ → 编辑账户 → OAuth 登录 → 打开账号网页登录**。
3. 软件使用此账号**已经保存**的凭据，恢复到该账号独立的官网窗口；不会读取日常浏览器资料或其他账号会话。未保存的手动凭据修改需要先保存。
4. 官网登录已失效时，在此窗口登录**同一个账号**。不要把密码或令牌发给他人。官网身份检查会区分访客和真实账号，不能仅凭打开窗口或获得一个 JWT 就认定成功。
5. 官网确认身份后，主进程自动保存更新到**原账号**，界面明确显示“已更新并保存”或“已恢复，继续使用当前已保存的凭据”。不需要再次保存登录凭据；账号名称、手动开关、封禁时间和用量不变。名称等手动编辑仍需点“保存更改”。
6. 官网窗口会保持打开。关闭编辑页不会取消已经启动的后台恢复；关闭官网窗口可终止尚未完成的验证。账号被删除或同时修改时，旧登录结果不能覆盖或重新创建它。
7. 之后可在账号列表手动 **测活**，确认聊天是否有返回；官网身份有效不代表聊天验证码限制已经解除。

新增账号可使用 **添加账户 → OAuth 登录 → 打开 OAuth 登录**；手动输入仍保留在另一页签。

**版本区别：**v1.6.2 虽然补上了页签，但仍创建空白临时登录会话、要求手动保存；它不能证明原账号网页已恢复。v1.6.3 的上述账号绑定通路才会恢复原凭据并在官网认证后自动保存。新增账号仍走独立的新登录流程。

**验证码边界：**此功能不是验证码绕过，也不保证解除 `captcha_required`。若工具测试仍报告官网验证要求，保持“受阻”状态，不能视为工具调用已通过。恢复不复用旧 `captcha_verify_param` 或批量 Cookie 快照；不要复制分享浏览器会话或验证码数据。

`captcha_verify_param` 仅保留为短时调试字段，不是长期登录凭据。

### English: sign in to an existing account again

From **Providers → Z.ai → Accounts**, choose **⋯ → Edit Account → OAuth Login → Open account sign-in**. The app restores only this account's saved token into an isolated website window. If sign-in has expired, complete normal login with the same identity. Verified credential changes are saved automatically to the original account; the window stays open. Manually edited labels still require Save Changes. Existing disable/cooldown settings remain intact. This flow does not prove chat or CAPTCHA availability.
