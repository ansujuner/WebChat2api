# 界面截图与数据来源

新版截图由 `scripts/capture-showcase.cjs` 从**本项目构建后的真实 Electron 页面**生成，不是设计稿或重新绘制的界面。`manifest.json` 记录实际生成时间、项目/浏览器版本、页面、语言、主题、像素尺寸、图片摘要及验证范围；它只在完整截图验证通过后生成。

## 隔离演示数据

- 每次新建项目 `.audit-cache/showcase-*` 专用资料目录；不读取现有应用资料、个人浏览器资料或真实账号。
- 使用**空账号、空 API Key、零生成请求、零成功记录**；仅从本程序的真实 `getBuiltin` 接口取出 DeepSeek、GLM、Arena 三个现有内置定义，通过受控本地 `providers:add` 预配置目录，展示品牌图标和模型列表。没有修改定义、添加假账号或注入令牌；这些模型名称不代表已经登录或验证可用。Arena 未登录，不展示伪造的可用模型。
- 不调用登录、测活、模型同步、代理启动或更新下载。所有 HTTP、HTTPS、WebSocket 请求均被隔离脚本阻止，外部浏览器启动也被禁止。
- 普通供应商状态读取本来会访问官网；截图脚本把这两个 IPC 读取限定为明确的 **unknown／未检查**，不将离线演示伪装成官网在线或账号可用。其他页面使用真实生产 IPC 和持久化行为。
- 截图不写入账号邮箱、令牌、个人路径或官网响应。临时资料与调试日志保留在已忽略的 `.audit-cache` / `artifacts`，不纳入截图目录。
- 没有为了截图而加入生产环境的演示后门，也没有把失败结果或空账号伪装为可用。

## 截图清单

`dashboard.png`、`providers.png`、`proxy.png`、`models.png`、`api-keys.png`、`logs.png`、`Session.png`、`settings.png`、`about.png`：中文浅色，各页面的实际初始状态。

`preview.png`：中文深色总览；`preview-en.png`：英文浅色总览；`preview-en-dark.png`：英文深色总览；`tray.png`：真实托盘页面。

桌面截图为 1440×1000 像素，托盘为 400×460。验证同时访问所有桌面页面的中文/英文、浅色/深色组合及 1100×800 较窄窗口，检查横向溢出、图片加载与未翻译的语言键。语言和主题通过真实界面按钮切换，再重新加载页面验证持久化。

截图等待字体、图片和页面布局稳定，并在请求重绘后等待新的合成画面；不会只用 DOM 已加载来推断图片正确。有限的入场动画被推进至自然结束态，避免隐藏窗口停留在几乎透明的第一帧；无限循环的加载指示不被隐藏或伪造完成。发布前仍应逐张目视检查，不能仅凭自动检查通过就认定截图可用。

## 重新生成

先自行完成生产构建，再运行：

```powershell
node scripts/capture-showcase.cjs
```

默认只生成隔离暂存图片与 `artifacts/showcase-capture.json`，不会覆盖这里的截图。查看结果、确认所有验证通过后，可重新运行并显式发布：

```powershell
node scripts/capture-showcase.cjs --publish
```

可通过 `--electron <路径>` 指定兼容的本地 Electron 程序。脚本不执行构建、不安装依赖、不重启或关闭正在使用的 Chat2API，仅退出自己启动的隔离实例。验证失败不会发布不完整的新截图；请以实际存在且通过的 `manifest.json` 为准，不能将待生成的截图说明当成验证结果。

截图采用 Electron 的原生 [capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts) 接口，保持隔离窗口隐藏，不截取桌面上其他程序。
