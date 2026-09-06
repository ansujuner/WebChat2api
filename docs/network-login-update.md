# 网络代理、账号名称和登录内核更新

## 本次修复

- **系统代理真正作用于出站请求**：登录窗口、账号验证、模型请求和聊天使用 Chromium 网络栈的系统代理/PAC 规则；直连模式显式关闭代理。此前只有登录窗口部分使用此设置，Node/Axios 请求没有跟随系统代理。
- **保存与实际状态一致**：代理应用成功后才保存和更新显示；失败保留旧模式并提示。设置切换不终止进行中的回答，新请求使用新会话。已打开的登录窗口请关闭后重开。
- **账号分别显示**：默认名称优先使用服务商返回的邮箱，没有邮箱时使用用户 ID 或独立本地编号。列表附带短账号 ID，自定义名称保留。旧版已知通用名称自动迁移，不需要清空账号。
- **登录生命周期修复**：先完成代理配置，再加载网站；支持共享本次登录会话的正常 OAuth 弹窗；每次添加账号使用独立、非持久化浏览器会话，避免串号。
- **真实浏览器环境**：固定 Electron 44.2.0 / Chromium 152.0.7977.76；移除旧内核专用降级开关，不伪造设备/浏览器指纹，不关闭 TLS 检查或登录窗口沙箱。设置页显示实际运行的内核版本。
- **身份验证与日志**：保留验证返回的邮箱和用户 ID；Qwen AI 不再把单纯解析 JWT 当作服务器验证成功；登录流程不输出 Cookie、令牌、JWT 或账号资料。

实现依据：[Electron 系统代理与 Session API](https://www.electronjs.org/docs/latest/api/session)、[OAuth 弹窗生命周期](https://www.electronjs.org/docs/latest/api/window-open)。内核版本依据 [Electron 官方发行列表](https://releases.electronjs.org/release/v44.2.0)。

## 让新版生效

运行中的旧版不能直接替换内核。先完成或取消登录，在 **Chat2API 托盘菜单选择“退出”**，然后在项目目录运行：

```powershell
.\scripts\start-local.ps1 -UpdateRuntime -Build
```

启动器检查运行中的项目进程；不会强制关闭应用，也不会改写账号、代理地址或用户系统设置。更新使用项目锁定依赖和官方 Electron 安装器。可在“设置 → 常规 → 登录浏览器内核”确认实际显示 Electron 44.2.0。

构建要求 Node.js 22.18+，推荐 Node.js 24。Electron 44 不再支持 Windows 32 位，macOS 最低为 13；此项目已移除失效的 win32 构建命令。参见 [官方升级说明](https://www.electronjs.org/docs/latest/breaking-changes)。

## 验证与边界

- `npm test`：单元、模拟服务商和协议回归。
- `npm run build`：生产构建。
- `node scripts/smoke-app.cjs`：真实 Electron 44 的隔离应用验证，使用工作区内全新账号目录，仅请求随机本机端口；不会读取你的账号或操作正在运行的正式应用。结果保存于 `artifacts/runtime-app-smoke.json`。
- `artifacts/network-electron-runtime.json`：真实 Chromium 本地代理转发、直连、账号 Cookie 隔离、上传、压缩与流式验证记录。没有修改用户的系统代理。

“系统代理”遵循操作系统配置，不等同于自动开启 VPN；系统没有代理或 PAC 指定 DIRECT 时会直连。单请求 Node agent/proxy 覆盖和跨域重定向会明确报错，避免绕过统一设置或把账号头发往另一网站。

新内核和正确网络配置不能保证网站不触发验证，也不能使明确拒绝内嵌浏览器的身份提供方变成支持。此时使用供应商支持的外部浏览器登录方式，不绕过其验证。Perplexity 的旧适配器仍只检查 Cookie 是否存在，不能把它当作远端登录已验证；没有返回邮箱的账号使用独立编号。真实账号登录结果需要用户在新版内核中复测。
