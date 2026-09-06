# Windows 本地部署与账号登录

本项目是 Electron 桌面应用。下列流程运行当前项目的生产构建，打开可见窗口供你登录，不需要另开开发服务器，也不会改写现有账号或代理设置。

## 启动

在项目目录打开 PowerShell：

```powershell
# 只检查，不启动、不写入设置
.\scripts\start-local.ps1 -Preflight

# 构建后打开桌面应用
.\scripts\start-local.ps1 -Build

# 已完成构建时直接打开
.\scripts\start-local.ps1

# 自动重启本项目应用；先正常退出，超时才结束核验过的本项目进程
.\scripts\restart-local.ps1

# 自动退出后构建，再重新打开（不覆盖账号）
.\scripts\restart-local.ps1 -Build

# 升级到项目锁定的浏览器内核后构建并打开（请先从托盘退出旧版）
.\scripts\start-local.ps1 -UpdateRuntime -Build
```

如果 PowerShell 提示脚本被执行策略禁止，请按你所在设备的管理要求处理；本脚本不会修改系统执行策略。

如果依赖尚未安装，先运行 `npm ci`。如果之前使用了 `--ignore-scripts`，启动器提示 Electron 运行时缺失时，可在项目目录仅安装本项目已锁定版本的运行时：

```powershell
node .\node_modules\electron\install.js
```

启动器只使用本项目中的 Electron，不安装全局工具；仅在创建子进程期间清除继承的 `ELECTRON_RUN_AS_NODE`，然后恢复当前进程环境。它不添加关闭沙箱、关闭网页安全或远程调试参数。

本版锁定 Electron 44.2.0。若安装的内核版本与项目不一致，启动器会要求更新，不会把旧内核误报为新版。账号命名、网络代理与登录兼容性说明见 `docs/network-login-update.md`。

## 登录与启用代理

1. 在应用的账号页面，为需要的供应商添加账号并完成登录。
2. 回到仪表盘，点击 **启动代理**。如果原有配置开启了自动启动，则无需重复操作。
3. 确认应用显示代理运行中，使用界面显示的监听地址、端口及访问密钥。

首次安装的默认地址为 `http://127.0.0.1:8080`，但脚本不会覆盖你原有的地址、端口、访问密钥或自动启动设置。不要为此直接编辑账号凭据文件，也不要把供应商网页登录凭据当作代理访问密钥。

代理启动后可在本机检查：

```powershell
$port = [int](Read-Host '输入应用当前运行中显示的端口')
Invoke-RestMethod "http://127.0.0.1:$port/health"
```

健康检查会返回实际 `port`、`localBaseUrl` 和 `modelsUrl`。不要把监听所有网卡用的 `0.0.0.0` 当作客户端地址；本机连接使用 `127.0.0.1`。健康检查通过只说明代理服务在线，不代表供应商已经登录或真实对话成功。

### 获取不到模型时

- **无法连接**：确认代理已启动，并使用当前运行端口。保存新端口但未重启时，旧监听仍有效；界面显示实际运行地址，不会提前切换。
- **401**：在客户端填写应用“API Key”页的已启用代理密钥。浏览器直接打开模型网址不带密钥也会返回 401；这不表示模型为空。
- **200 但列表为空**：检查供应商启用开关、账号在线状态，以及是否禁用了模型。
- OpenAI 客户端 Base URL 是 `http://127.0.0.1:<运行端口>/v1`；Claude Code 是 `http://127.0.0.1:<运行端口>`，**不加 `/v1`**。

Claude Code 的端点与环境变量配置见对应的 Claude Code 接入说明。

### 一键本机检查

先打开本项目的新版应用，然后在项目目录运行：

```powershell
# 默认只检查健康状态与模型列表，不发起模型对话
.\scripts\check-local.ps1

# 明确发起真实小消息：DeepSeek 与已有账号的 GLM/智谱供应商各一轮
.\scripts\check-local.ps1 -Live

# 明确检查 Claude Code 使用的 Anthropic 流式接口
.\scripts\check-local.ps1 -Live -Stream

# 设置页同款工具测试：实际调用模型两轮，不执行外部工具
.\scripts\check-local.ps1 -Live -Tools

# 打开 Arena 独立登录窗口；登录后保存账号并同步当前可选模型
.\scripts\check-local.ps1 -ArenaLogin

# Arena 实际文本续聊和一张图片；需先登录，不自动重试
.\scripts\check-local.ps1 -Live -Arena
```

检查交给已经运行的应用执行；需要时使用已保存配置启动代理，使用实际监听端口和应用内部密钥，不猜测 8080/8081，不关闭鉴权，也不会另建登录环境。结果保存在 `artifacts/proxy-catalog-probe.json`、`artifacts/proxy-live-probe.json` 或 `artifacts/proxy-stream-probe.json`。

脚本只接受本次启动后生成的完整报告，不会把旧结果或“运行中”报告当作成功。超时不代表请求未发送；**不要立即重复真实对话检查**，应先确认应用中的检查是否已经结束。脚本不会自动重试。

## Z.ai 已有账号网页登录恢复诊断

`scripts/check-local.ps1 -ZaiLogin` 请求已经运行的应用恢复**唯一一个**现有 Z.ai 账号。它不创建账号、不生成聊天；会打开该账号的独立官网窗口，载入其已保存凭据，校验真实官网身份，并自动保存经过确认的更新。无账号或多个账号时不猜测目标，应在界面选择账号。

报告位于 `artifacts/proxy-zai-login-probe.json`，只包含认证结果、保存版本变化、账号是否保留和安全阶段码，不含邮箱、账号 ID、Token、Cookie 或响应正文。`live: false` 表示没有聊天生成，不表示离线；`awaiting_login` 也不是成功。登录窗口保持打开，旧登录失效时需正常登录；不能将认证通过视为聊天验证码解除。

## 只检查 Z.ai 测活及读取最近结果（v1.6.4 起）

- `scripts/check-local.ps1 -Live -ZaiLiveness` 通过账号列表同一测活服务，仅检查 Z.ai，不兜底其他供应商。每个可测账号只发送一条短消息，禁用、冷却等批量规则仍保留。
- `scripts/check-local.ps1 -AccountStatus` 只读取本次应用会话最近的测活摘要，不发送消息、不启动浏览器；没有结果时返回 `no_result`。
- 报告分别保存为 `artifacts/proxy-zai-liveness-probe.json`、`artifacts/proxy-accounts-status-probe.json`。不包含账号名称、ID、凭据或回复正文。超时或受阻不会自动重发。

## 更新、退出与日志

- 新代码构建后，需要先从 Chat2API 系统托盘菜单选择 **退出**，再启动。关闭窗口默认可能只是隐藏到托盘。
- 也可以使用 `restart-local.ps1` 自动完成：等待正常退出 20 秒后，才核验进程路径、启动参数、创建时间和父子关系并结束本项目 Electron 进程；不结束个人 Chrome/Edge 或其他 Electron 应用。正常退出会关闭应用自身管理的登录浏览器，持久登录资料保留。应在登录操作和正在执行的请求结束后重启。
- 启动器检测到此项目已经运行时，不会强制结束进程，不会启动第二个独立实例。
- 启动诊断日志保存在项目的 `logs/local-deployment/`，每次启动使用独立时间戳文件；该目录已被项目忽略规则排除。
- 日志可能包含应用原有的诊断信息，分享前应先确认不包含账号或访问凭据。
- 桌面应用仍使用其正常的用户数据目录，不会创建隔离账号副本，也不会清空已有登录状态。
