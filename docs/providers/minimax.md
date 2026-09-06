# MiniMax

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | minimax |
| 官网 / API Base | [MiniMax Agent](https://agent.minimaxi.com/) |
| 认证 / 凭据字段 | 网页 JWT / `token`, `realUserID` |
| 官网核对日期 | 2026-09-06 |

## 默认模型

| 显示名称 | 本地路由 ID | 真实含义 |
| --- | --- | --- |
| MiniMax-Agent | minimax-agent | 旧 Matrix Agent 接口，由服务端选模，不保证固定版本 |

适配器层仍能识别旧 `MiniMax-M2.7` 标签，但它不在默认可选列表中，也不代表能够指定 M2.7。旧客户端若希望明确接受服务端选模，请手动添加全局映射 `MiniMax-M2.7` → `MiniMax-Agent`，首选供应商设为 `minimax`；应用不会自动覆盖用户映射或把固定版本请求悄悄替换为 Agent。

## 为什么没有直接改成 MiniMax-M3

[MiniMax 官方已于 2026-06-01 发布 M3](https://www.minimax.io/blog/minimax-m3)，当前官网也显示 M3。但源码核验显示：M3 使用新的会话及 `providerID/modelID` 选模服务；本项目调用的是 `/matrix/api/v1/chat/send_msg` 和轮询接口，原始请求根本没有模型选择字段。原来的 M2.7 只是回复标签，替换成 M3 同样不能证明调用了 M3。

本次移除这个虚假固定版本标签；直接请求 M3、高速版或其他未适配型号将返回明确错误，不再悄悄把任意请求名写入回复。需要固定 M3 时，应使用独立官方 API 供应商，或另行完成新版 Code/会话协议适配。

## 核验与限制

已完成公开官网与请求构造核对、本地路由回归测试。旧 Matrix 接口的流式/非流式、续聊和删除逻辑继续保留，但未用账号执行生成；不能据此保证该旧接口当前仍对所有账户开放。

添加自己的网页凭据后重启应用，使用 `MiniMax-Agent`。凭据支持 `realUserID+JWTtoken` 或单独字段；不要在日志或仓库中记录凭据。
