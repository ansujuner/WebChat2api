# 2026-09-06 官网模型更新记录

## 结果

已逐家核对全部 9 个内置供应商，更新默认目录、真实网页选模参数、双语文案和回归测试。当前共 33 个内置可选名称（含 Perplexity 的 Auto 兼容别名及 MiniMax-Agent 本地路由名称）。

| 供应商 | 本次默认模型 | 官网证据 / 处理 |
| --- | --- | --- |
| DeepSeek | deepseek-v4-flash、deepseek-v4-pro、deepseek-v4-flash-vision-exp | [官方模型列表](https://api-docs.deepseek.com/)与[更新日志](https://api-docs.deepseek.com/updates/)确认三个官方 ID；默认目录清理自动搜索/思考别名，保留用户自定义映射。模型目录核对不代表已验证每个网页选模或图片协议 |
| GLM / 智谱清言 | GLM-5.3-Flash、GLM-5.3 | [官网](https://chatglm.cn/)实际配置与公开脚本确认 `meta_data.selected_model`；不是只替换旧 5.1 标签 |
| Kimi | Kimi-K3、Kimi-K2.6 | [官网](https://www.kimi.com/)配置与请求构造确认 `k3-agent` / `k2d6-chat`；修正旧 K2D6 场景枚举，增加推理等级 |
| MiniMax | MiniMax-Agent | [官网](https://agent.minimaxi.com/)已有 M3，但使用另一套新会话协议；旧 Matrix 接口只由服务端选模，移除虚假的固定 M2.7 标签，不冒充已接入 M3 |
| MiMo | MiMo-V2.5-Pro、MiMo-V2.5 | [官方下线表](https://mimo.mi.com/docs/en-US/updates/deprecate)确认删除 V2-Flash；同步 Studio 默认思考和自动搜索，修复流式思考结束标签被分片时吞答案的问题 |
| Qwen 国内 | Qwen3.7、Qwen3.8-Max、Qwen3.7-Max、Qwen3.6-Flash | [官网](https://www.qianwen.com/)当前可见模型目录；`Qwen3.7` 对应界面“Qwen3.7-千问”，真实 ID 仍为 `Qwen` |
| Qwen Studio 国际 | Qwen3.7-Plus、Qwen3.8-Max | [官网模型接口](https://chat.qwen.ai/api/models)当前只返回这两款；移除旧 Coder / 3.6 默认项，不擅自重写用户显式映射 |
| Perplexity | Best、Auto 兼容别名，以及 10 款当前 Search 模型 | [官网模型配置](https://www.perplexity.ai/rest/models/config/v2)核对到 Sonar 2、GPT-5.6 Terra / Sol、Gemini 3.8 Flash、Claude Sonnet 5 / Opus 5、Kimi K3、GLM 5.3、Grok 4.6、Nemotron 3 Ultra；过滤 Computer / Comet-only 和历史枚举 |
| Z.ai | GLM-5.3-Flash、GLM-5.3、GLM-5.2、GLM-5-Turbo、GLM-5V-Turbo、GLM-4.7 | [官网](https://chat.z.ai/)访客模型目录确认 Flash 实际 ID 是 `x-preview-l`；更新前端版本和强制思考规则，保留验证码限制说明 |

## 核验边界

- 已做：官方网页和公开配置的只读核验；网页脚本选模链路分析；离线请求构造、模拟上游、流式/非流式、模型映射与目录一致性测试；生产构建。
- 未做：使用真实登录账号提交对话、消费额度、验证订阅权限、多轮上游会话和删除接口。公开目录可见不等于当前账号有权使用。
- Perplexity：Best / Auto 是默认路由；具名模型受 Pro / Max 订阅限制。Gemini 3.8 是本次实时配置结果，优先于仍写 3.7 的帮助页。没有将只出现在枚举表中的型号当作可选 Search 型号。
- MiniMax：新版 M3 仍待独立协议适配与账号实测；本次是纠正旧适配器的版本误标，不是完成 M3 接入。旧客户端如继续发送 `MiniMax-M2.7`，需要手动全局映射到 `MiniMax-Agent` 并指定供应商 `minimax`。
- Kimi：普通 K3 请求字段已核对；K3 Swarm 的新旧配置存在差异，未作为已支持型号暴露。实际生成中的 Agent 产物仍需实测。
- Z.ai：模型目录已更新，不代表旧验证码问题已解决。

## 配置一致性与使用

当前仓库 `src/main/store/types.ts` 的 `BUILTIN_PROVIDERS` 已经直接转出 `providers/builtin/index.ts`，所以是同一份配置，不另造第二份容易过期的数组。新增测试验证该关系以及中英文模型标签一致性。

更新后重新构建并重启应用，启动流程会同步内置模型。用户自定义模型及映射不会因本次更新被批量删除；原有自定义过时 ID 需要用户检查。模型管理的“重置”会丢弃该供应商的自定义设置，仅在确实想恢复默认时使用。

## 验证命令

本次使用 Node.js 24.13.0；仓库测试直接加载 TypeScript，需要支持类型剥离的 Node.js 版本。

```text
npm test
npm run test:providers
npm run build
```

完整严格 TypeScript 检查另行执行，当前仍存在跨模块的类型错误（如 Electron App 重复声明、OAuth 类型、旧模块导出不匹配等），不能将生产构建成功等同于全项目类型检查通过。本次新增或触及的模型解析类型另行复核；没有扩大范围重构整个项目。

### 最终验证结果

- `npm test`：202/202 通过，无跳过项。
- 路由回归：9 家、33 个内置名称，在三种负载均衡策略下验证精确映射；同名 GLM 在智谱清言与 Z.ai 中不会串用模型 ID。
- `npm run build`：通过，生成 `out/main`、`out/preload`、`out/renderer`。
- `tsc --noEmit --incremental false --composite false --target ES2022 -p tsconfig.node.json`：退出 2，当前全项目 92 条诊断；未宣称全项目类型检查通过。
- 原始本地验证输出：`artifacts/model-audit-all-tests.log`、`artifacts/model-audit-build.log`、`artifacts/model-audit-typecheck.log`。

## 逐家证据

- [DeepSeek / Kimi / MiniMax 核验与协议说明](model-audit-deepseek-kimi-minimax-2026-09-06.md)
- [GLM / Z.ai / MiMo 核验与协议说明](model-audit-glm-zai-mimo-2026-09-06.md)
- [Qwen / Perplexity 核验与协议说明](model-audit-qwen-perplexity-2026-09-06.md)
- `evidence/` 内保存脱敏的公开模型响应、选模字段与必要来源信息，不保存账号凭据。
