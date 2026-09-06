# GLM、Z.ai、MiMo 官网模型审计（2026-09-06）

## 范围与方法

- 这三家内置供应商使用**网页会话协议**，不是开放平台付费 API。官方发布名仅用于发现升级，网页公开模型配置用于确认实际选模 ID；不根据 API 发布名臆造网页映射。
- 通过独立 jshook 浏览器检查官网实际 DOM 和公开配置响应；MiMo 的公开配置亦以无凭据 GET 复核。未读用户保存账号，未发送真实生成，未绕过验证码或订阅限制。
- 证据 JSON 只保留模型、默认选项、来源和检查日期，不保留 cookies、访问令牌或请求认证头。

## GLM（智谱清言）

### 官方来源与日期

- [官网](https://chatglm.cn/)：2026-09-06 实际 DOM 显示 GLM-Flash，公告显示 5.3-Flash 上线。
- [网页 available_models](https://chatglm.cn/chatglm/agent-api/operation/detail?tag=available_models)：浏览器实际加载响应 HTTP 200；独立无会话 GET 返回 40001，不将其误判为模型不存在。最小证据：[glm-models-2026-09-06.json](evidence/glm-models-2026-09-06.json)。
- [官网当前聊天组件脚本](https://chatglm.cn/7318.4fa1a928.js)：通过已加载前端定位选择状态进入 `meta_data.selected_model`、档位进入 `meta_data.chat_mode`，不是根节点 `model`。
- [官网主脚本](https://chatglm.cn/main.888d80b8.js)：思考状态对应 `''`、`thinking`、`deep_thinking`；与配置接口的 effort 清单一致。

### 修改与确定项

默认模型为 `GLM-5.3-Flash → glm-5.3-flash`、`GLM-5.3 → glm-5.3`。官网把 Flash 展示为 `GLM-Flash` 并说明它是 5.3-Flash；两款 `chat_switch` 均开启，配置中所有用户角色默认 Flash。

旧适配器虽然声明 GLM-5.1，却完全没有发送模型选择字段。现在在原有助手请求体中加入已确认的 `meta_data.selected_model`，并去掉旧 `if_plus_model` 常量；普通模型与自定义智能体 ID 不再混为同一含义。对自定义模型保持实际 ID，不能静默伪装成最新模型。

按官网档位发送 `chat_mode`：`low → ''`、`medium/high → thinking`、`max → deep_thinking`。独立智能体的旧 `zero`、显式 `deep_research` 路由保留，不仅凭 API 发布文档替换这些网页模式。

### 尚未确认

已确认的是模型目录和当期公开前端请求构造，不是登录账号后真实生成。额度、风控、权限、多模态、返回流字段等仍需受控账号验证。该供应商不会因此自动获得开放平台的图像、视频或所有工具能力。

## Z.ai

### 官方来源与日期

- [官网聊天页](https://chat.z.ai/)：2026-09-06 当前标题显示 GLM-5.3-Flash。
- [官网网页模型目录](https://chat.z.ai/api/models)：2026-09-06 浏览器实际请求返回 HTTP 200；最小证据：[zai-models-2026-09-06.json](evidence/zai-models-2026-09-06.json)。
- [官方发布记录](https://docs.z.ai/release-notes/new-released)：GLM-5.3 发布日 2026-08-18，GLM-5.3-Flash 为 2026-08-26。
- [GLM-5.3 官方说明](https://docs.z.ai/guides/llm/glm-5.3) 与 [Flash 官方说明](https://docs.z.ai/guides/vlm/glm-5.3-flash)：仅作为产品及 API 差异参考。
- [当前公开前端脚本](https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.93/assets/index-CbtGwGjt.js)：与浏览器加载版本一致，更新 `X-FE-Version` 到 `prod-fe-1.1.93`。

### 修改与确定项

| 展示名 | 网页 ID |
| --- | --- |
| GLM-5.3-Flash | x-preview-l |
| GLM-5.3 | glm-5.3 |
| GLM-5.2 | glm-5.2 |
| GLM-5-Turbo | GLM-5-Turbo |
| GLM-5V-Turbo | GLM-5v-Turbo |
| GLM-4.7 | glm-4.7 |

仅默认展示当前目录前六项。旧 GLM-5.1、GLM-5 不再展示，不把目录末尾的历史、内部、专用模型一并宣传为当前默认可用。

Flash 的网页 ID 是 `x-preview-l`；直接发送开放平台的 `glm-5.3-flash` 不是这里的映射证据。适配器对展示名和小写名均归一到网页 ID，创建会话默认值同步为 Flash。

当前网页目录对 GLM-5.3/Flash 标注 `skip_think: false`；适配器保持这两款思考开启。未将付费 API 的 `thinking` 或 `reasoning_effort` 结构硬套进网页协议。原有历史 ID 的显式自定义映射仍保留原含义，不静默升级。

### 尚未确认

模型目录成功不等于聊天生成可用。项目原有前端验证码风险仍保留，不宣称已修复。没有进行账号级流式/非流式生成、视觉上传、付费权限或新一代细分思考档位的端到端验证。

## MiMo

### 官方来源与日期

- [Studio 公开模型配置](https://aistudio.xiaomimimo.com/open-apis/bot/config)：2026-09-06 HTTP 200，业务 `code: 0`；最小证据：[mimo-models-2026-09-06.json](evidence/mimo-models-2026-09-06.json)。
- [Studio 更新日志](https://mimo.mi.com/docs/en-US/updates/feature/studio)：2026-04-24 全平台更新 V2.5；2026-06-07 退休 V2.0；页面更新日期 2026-09-03。
- [官方模型下线表](https://mimo.mi.com/docs/en-US/updates/deprecate)：2026-06-30 V2 名称到期，Flash 对应替代模型为 V2.5；页面更新日期 2026-06-24。
- [当前官网](https://mimo.mi.com/)：V2.5-Pro-UltraSpeed 为申请制抢先体验，不能推断普通 Studio 聊天接口已经支持。
- [官方模型列表 API 说明](https://mimo.mi.com/docs/en-US/api/model/list-models)：页面更新时间 2026-07-17，用于区分 ASR/TTS 与当前聊天适配器范围。

### 修改与确定项

默认只保留 `MiMo-V2.5-Pro → mimo-v2.5-pro` 和 `MiMo-V2.5 → mimo-v2.5`，移除 Flash。公开配置仍留有旧模型和内部预览 ID；这与官网下线公告并不矛盾，不能把后端配置残留当作当前对外承诺。

根据 Studio 配置修正两款默认值：`enableThinking: true`、`webSearchStatus: auto`、`temperature: 0.8`、`topP: 0.95`。此前代码固定关闭思考和联网，未匹配当前网页默认状态。显式关闭选项仍优先；API 平台的参数默认值不覆盖 Studio 配置。

### 尚未确认

本轮未执行真实账号生成、上传、多轮保存/删除与标题生成验证。UltraSpeed、Claw、内部预览、ASR/TTS 不进入本次默认聊天模型清单。

## 验证

`node --test tests/providers/model-refresh-glm-zai-mimo.test.ts tests/providers/mimo-query.test.ts`

测试覆盖官网证据到内置映射、Flash 特殊 ID、思考能力、前端版本、MiMo 默认值与不可变输入，以及通过本地 HTTP 模拟服务执行两款 MiMo 模型的会话保存和流式请求。测试数据均为虚构凭据，本地请求不接触供应商生成接口。

默认开启 MiMo 思考后的兼容复核另发现并修复：`<think>` 或 `</think>` 跨 SSE message 时，旧解析器会遗漏结束边界，将最终答案误归为思考内容。现在保留不完整标签前缀；回归覆盖正常与旧 `</thinkgt;` 两种结束标签的每个切分点及逐字符分片，并断言流式/非流式正文与思考一致。上述子集目前 12/12 通过。
