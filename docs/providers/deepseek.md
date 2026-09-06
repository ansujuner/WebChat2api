# DeepSeek

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | deepseek |
| 官网 | https://chat.deepseek.com |
| API Base | https://chat.deepseek.com/api |
| 认证 | User Token |
| 凭据字段 | `token` |

## 默认模型

| 网页模式 | 模型 ID（客户端请求使用） |
| --- | --- |
| 快速 | deepseek-v4-flash |
| 专家 | deepseek-v4-pro |
| 视觉 | deepseek-v4-flash-vision-exp |

默认目录只包含以上三个官方模型，不再创建 `-think`、`-search`、`-think-search` 型号。思考和搜索是请求选项，不是另外六个模型。界面显示模式说明，但复制模型名称和 API 请求仍使用上表中的完整 ID。

## 2026-09-06 官网核验

以[官方模型列表](https://api-docs.deepseek.com/)和[官方更新日志](https://api-docs.deepseek.com/updates/)为准，保留 Flash / Pro 的稳定 ID，并加入 2026-08-21 发布的 `deepseek-v4-flash-vision-exp`。官方[视觉指南](https://api-docs.deepseek.com/guides/vision/)说明其图文输入能力。

上述资料证明型号和官方 API 能力，不能单独证明网页登录、选模、图片上传已经实测成功。网页端适配需要分别核对协议，不允许把视觉请求静默降级成 Flash 文本模型。

## 旧配置迁移

启动时同步内置模型，并删除能明确识别为旧版自动生成的搜索/思考映射及重复内置覆盖项；不会再次补回这些别名。其他供应商、用户自定义名称、重新指定的模型目标和绑定特定账号的映射保留。用户主动排除的当前模型也保留；要恢复全部三个默认模型，可在 DeepSeek 模型管理中选择恢复默认。

因此，新配置及旧版默认配置都展示三个内置模型；用户自己添加的自定义映射仍会显示，不会被无提示删除。

## 适配状态

当前模块包含流式对话、非流式对话、多轮会话、账号级清理对话记录、Web 搜索/思考参数及托管工具调用提示注入。

2026-09-06 使用已登录账号、通过本机 8081 网关实测：快速和专家模式返回预期验证文本，视觉模式上传测试图片并正确读出其中四位数字，三项均返回 HTTP 200。脱敏报告位于 `artifacts/proxy-deepseek-probe.json`；这是当时该账号的结果，不代表之后的配额或服务可用性保证。

视觉输入支持 OpenAI `image_url` 内容块中的 PNG/JPEG/WebP/GIF base64 data URL；每张最多 10 MiB，每次最多 10 张且总计不超过 20 MiB。当前不主动下载远程图片 URL，调用方需要先转成 data URL。第二轮可以只发当前文本和网关会话 ID，不需要重复上传旧图片。

`reasoning_effort` 当前只开启网页思考，不声称能选择 API 的 low/high/max 计算强度。

## Windows 登录环境

DeepSeek 官方网页会直接识别 Electron/Tauri 并显示使用环境风险警告。因此 DeepSeek 自动登录改为调用已安装且签名验证通过的完整 Chrome/Edge，而不是隐藏提示或伪装内嵌浏览器身份。

登录使用独立的临时浏览器配置，不读取日常浏览器资料；采用私有通信管道，不开放远程调试端口。只在 DeepSeek 官方来源读取本次登录令牌，并经供应商接口校验后导入。支持系统代理或直连；成功、取消或正常退出时关闭独立窗口并清理临时目录。其他供应商登录方式不变。当前自动完整浏览器登录仅支持 Windows，其他平台仍可手动导入。

2026-09-06 实际对照：Electron 内嵌窗口能复现警告；Chrome 152 独立登录页无 Electron/Tauri 标记、无该警告。用户完成登录后供应商账号校验成功，窗口正常关闭。脱敏证据为 `artifacts/deepseek-embedded-environment.json` 和 `artifacts/proxy-login-probe.json`。这不是绕过验证码，也不保证供应商以后不会要求额外校验。

开发回归：`scripts/check-local.ps1 -Live -DeepSeekAllModes` 明确提交三次生成；`scripts/check-local.ps1 -DeepSeekLogin` 启动需要用户交互的登录验证，不重复添加账号、不导出凭据。两者均要求已有本项目应用实例，正常启动不会自动执行测试。

## 教程

1. 在 Chat2API Manager 的供应商管理中添加 DeepSeek 账号，在新打开的 Chrome/Edge 窗口中自行完成登录及验证码。
2. 登录后在模型管理中查看快速、专家、视觉三个默认型号。
3. 客户端使用上表中的完整模型 ID；搜索/思考使用 `web_search`、`reasoning_effort` 选项，不需要额外型号。
