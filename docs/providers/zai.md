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

### 已有账号重新登录（v1.6.2 起）

1. 打开 **供应商 → Z.ai → 账户管理**。
2. 找到该账号，点 **⋯ → 编辑账户 → OAuth 登录 → 重新登录**。
3. 在弹出的官网登录窗口登录**同一个账号**，不要把密码或令牌发给他人。
4. 回到软件后点 **保存更改**。此操作更新原账号，不重复添加，不修改手动关闭开关或封禁倒计时。关闭编辑窗口或登录失败不会保存新凭据。
5. 如账号原本显示认证错误，保存后返回账号列表，点该账号 **⋯ → 验证凭据**；之后手动 **测活**，确认实际聊天是否有返回。编辑窗口内同名按钮只检查表单，不更新已保存账号的状态。

新增账号可使用 **添加账户 → OAuth 登录 → 打开 OAuth 登录**；手动输入仍保留在另一页签。

**边界：**旧版编辑窗口确实没有 OAuth 页签。新版补上的是重新登录入口，不是验证码绕过。当前登录窗口在获取登录凭据后会自动关闭；它不一定显示聊天验证码，重新登录也不保证解除 `captcha_required`。若工具测试仍报告官网验证要求，应保持“受阻”状态，不能视为工具调用已通过。`captcha_verify_param` 是短时调试字段，不是长期凭据；不要复制分享浏览器会话或验证码数据。

### English: sign in to an existing account again

From **Providers → Z.ai → Accounts**, choose **⋯ → Edit Account → OAuth Login → Sign in again**, then use the same website account. Click **Save Changes** after returning. The original account ID, custom label, manual disable switch and cooldown remain intact. If the old authentication status was an error, return to the account list and use its **⋯ → Validate Credentials**, followed by a manual liveness check. The edit dialog's validation button only validates the draft. Successful sign-in alone does not establish chat availability or resolve a website captcha.
