# Z.ai

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | zai |
| 官网 | https://chat.z.ai |
| API Base | https://chat.z.ai/api |
| 认证 | 保存的 Token + 账号独立网页会话 |
| 凭据字段 | `token`；旧验证码字段不用于聊天重放 |
| 当前状态 | v1.6.4 账号网页通道；GLM-5.3-Flash 已通过真实测活和 OpenAI 非流式两轮工具测试，其他能力按实际测试结果判断 |

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

**v1.6.4 修复网页登录正常、测活却失败的问题。** 旧版只保存了有效登录 Token，但聊天仍通过独立请求通道发送，未执行官网发送消息时的前端验证，因此会出现网页登录成功、测活返回 `FRONTEND_CAPTCHA_REQUIRED` 的不一致。官网的验证不一定弹出可见验证码；反复重新登录不是解决这类错误的方法。

现在测活与 API 对话共用账号独立的网页会话，并使用专门的 API 聊天页正常选模型、输入和提交。签名、环境信息及验证由官网自身处理，不伪造浏览器指纹、不复制验证码证明。用户的登录／手动聊天页不会被输入测试消息。每个账号同时只允许一个提交；失败不回退到旧通道、不自动重发。

流式与非流式返回都来自本次网页回复，必须完整结束；续轮使用原官网对话并只输入本轮内容。当前桥接仅支持文字，附件或网页不能满足的选项会明确报错，不静默丢弃。自动／批量删除官网聊天尚未接入，请在官网管理记录；测活可能留下对应的测试对话。

官网回复流不一定包含助手消息编号。新版在回复结束后只读核验本次对话已保存的消息关系，确认当前助手节点与本轮用户输入、上一轮回复相连后才保存续聊位置。不会把任意请求编号当作回复编号，也不会因编号缺失自动重发消息。

2026-09-06 已通过官网浏览器加载的 [`/api/models`](https://chat.z.ai/api/models) 核对上述六款模型。注意 GLM-5.3-Flash 的**网页请求 ID 是 `x-preview-l`**，不是开放平台 API 的 `glm-5.3-flash`。GLM-5.3/Flash 的官网能力不允许关闭思考，适配器会保持思考启用。旧 GLM-5.1、GLM-5 不再作为默认模型展示；自定义旧 ID 不会被静默替换成新模型。

模型目录核对证据见 [2026-09-06 模型审计](model-audit-glm-zai-mimo-2026-09-06.md)。v1.6.4 的抽样真实测活使用已有账号和 GLM-5.3-Flash，获得 HTTP 200 与完整回复；设置中的 OpenAI 非流式工具测试也通过了同一会话的两轮 HTTP 200 请求。不代表所有模型、所有账号或未来请求都不再需要验证。详见 [版本验收记录](../release-validation.md)。

如实际聊天需要人工验证，软件会显示对应聊天页；只有登录过期才应重新登录。验证不可见或网页尚未就绪时会如实报告，不能把打开窗口、HTTP 200 身份响应或登录成功当作测活通过。

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

`captcha_verify_param` 是旧版短时调试字段，不是长期登录凭据；新版网页聊天通道不读取或重放该字段。

### English: sign in to an existing account again

From **Providers → Z.ai → Accounts**, choose **⋯ → Edit Account → OAuth Login → Open account sign-in**. The app restores only this account's saved token into an isolated website window. If sign-in has expired, complete normal login with the same identity. Verified credential changes are saved automatically to the original account; the window stays open. Manually edited labels still require Save Changes. Existing disable/cooldown settings remain intact. This flow does not prove chat or CAPTCHA availability.
