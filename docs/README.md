# 文档导航 · Documentation

[中文首页](../README.md) | [English overview](../README_EN.md)

从运行应用到理解协议边界，按你要完成的事情选择文档。详细指南目前主要为中文；下方提供英文主题说明。

Choose a guide by task. Most detailed guides are currently in Chinese; English topic labels are included below.

## 开始使用 · Getting started

| 文档 / Guide | 内容 / Scope |
| --- | --- |
| [本地部署 · Local deployment](local-deployment.md) | 安装、启动、更新、重启、实际端口与显式诊断 / Install, launch, update, restart, actual ports, and opt-in diagnostics |
| [Claude Code 接入 · Claude Code integration](claude-code.md) | Messages、客户端配置、工具测试与不支持的扩展 / Messages, client setup, tool checks, and unsupported extensions |
| [账号真实测活 · Real account liveness](account-liveness.md) | 精确账号真实请求、批量队列、停止与超时 / Exact-account requests, batch queues, stopping, and timeouts |
| [账号调度 · Account scheduling](account-scheduling.md) | 手动开关、自动冷却、封禁与模型限额 / Manual switches, cooldowns, restrictions, and model limits |
| [网络与登录 · Network and login](network-login-update.md) | 系统代理、隔离登录、浏览器兼容性与限制 / System proxy, isolated login, browser compatibility, and limits |
| [会话续聊 · Conversation continuity](providers/conversation-continuity.md) | 首轮初始化、增量输入、身份绑定和失败处理 / First-turn initialization, deltas, identity binding, and failure handling |

## 供应商 · Providers

此处是适配说明，不是在线状态表。模型目录、账号权限和真实生成结果是不同层次；登录或列表请求成功不代表所有模型可用。

These are adapter guides, not a live status table. Catalogue entries, account permissions, and successful generation are separate facts.

| 供应商 / Provider | 供应商 / Provider |
| --- | --- |
| [DeepSeek](providers/deepseek.md) | [GLM](providers/glm.md) |
| [Kimi](providers/kimi.md) | [MiniMax](providers/minimax.md) |
| [MiMo](providers/mimo.md) | [Perplexity](providers/perplexity.md) |
| [Qwen 国内 / China](providers/qwen.md) | [Qwen AI 国际 / Global](providers/qwen-ai.md) |
| [Z.ai](providers/zai.md) | [Arena](providers/arena.md) |

新增适配器的旧开发入口保留在[供应商开发文档](providers/README.md)。开发步骤需结合当前源码；不应照抄历史示例中的模型和版本。

The older [provider development index](providers/README.md) remains available. Check the current source rather than copying model names or versions from historical examples.

## 当前界面 · Current UI

真实当前界面、隔离演示数据；不含真实账号。截图中的统计、状态和模型示例**不代表真实可用性**。

Actual current UI with isolated demo data, not real accounts. Statistics, statuses, and example models **do not establish real availability**.

[仪表盘 / Dashboard](screenshots/dashboard.png) · [供应商 / Providers](screenshots/providers.png) · [模型 / Models](screenshots/models.png) · [代理 / Proxy](screenshots/proxy.png) · [API Key](screenshots/api-keys.png) · [日志 / Logs](screenshots/logs.png) · [设置 / Settings](screenshots/settings.png) · [会话 / Sessions](screenshots/Session.png) · [关于 / About](screenshots/about.png) · [整体预览 / Preview](screenshots/preview.png)

[英文界面 / English UI](screenshots/preview-en.png) · [英文深色模式 / English dark mode](screenshots/preview-en-dark.png)

## 验证与协议审查 · Verification and protocol audits

以下记录按日期保存，反映特定版本、环境和抽样范围，**不是当前全站/全模型可用性承诺**。模拟测试、构建和真实请求应分开阅读。

These dated records describe particular versions, environments, and samples—not current all-provider or all-model availability. Distinguish fixtures, builds, and live requests.

- [发布验证记录 / Publication checks](release-validation.md)
- [深度代码审查 / Code audit, 2026-09-06](deep-audit-2026-09-06.md)
- [工具调用与 Arena 审查 / Tool calling and Arena audit](tools-arena-audit.md)
- [官网模型核对总览 / Official model audit](providers/model-audit-2026-09-06.md)
- [DeepSeek · Kimi · MiniMax](providers/model-audit-deepseek-kimi-minimax-2026-09-06.md)
- [GLM · Z.ai · MiMo](providers/model-audit-glm-zai-mimo-2026-09-06.md)
- [Qwen · Perplexity](providers/model-audit-qwen-perplexity-2026-09-06.md)

## 发布与署名 · Publication and attribution

- [GPL-3.0-or-later · LICENSE](../LICENSE)
- [原作者及修改版声明 / Original attribution and notices](../NOTICE)
- [修改说明 / Modifications](../MODIFICATIONS.md)
- [官方品牌资源来源 / Third-party asset sources](../THIRD_PARTY_ASSETS.md)
- [问题反馈 / Issues](https://github.com/ansujuner/WebChat2api/issues)

反馈时不要附上账号存储、浏览器资料、Cookie、Token、API Key 或未脱敏的日志/流量记录。

Do not attach account stores, browser profiles, Cookies, Tokens, API keys, or unsanitized logs/traffic captures to reports.
