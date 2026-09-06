/** Reproducible application artwork using bundled Electron, with no native canvas dependency. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_RENDERER_URL']) delete env[key]
  const result = spawnSync(require('electron'), [__filename], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.status !== 0) process.stderr.write(result.stderr || result.error?.message || 'Artwork generation failed')
  process.exit(result.status === 0 ? 0 : 1)
} else {
  const { app, BrowserWindow, session } = require('electron')
  fs.mkdirSync(path.join(root, '.audit-cache'), { recursive: true })
  const fixture = fs.mkdtempSync(path.join(root, '.audit-cache/brand-render-'))
  app.setPath('userData', fixture)
  app.setPath('sessionData', fixture)
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !/^(data|blob):/.test(request.url) }))
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await win.loadURL('data:text/html,<html><body></body></html>')
    const source = fs.readFileSync(path.join(root, 'src/renderer/src/assets/brand/webchat2api.svg'))
    const uri = 'data:image/svg+xml;base64,' + source.toString('base64')
    const render = async (size) => Buffer.from(await win.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(uri)}; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png').split(',')[1];
    })()`), 'base64')
    const png = await render(512)
    for (const file of ['build/icon.png', 'build/icons.png', 'src/renderer/src/assets/icons/icons.png']) fs.writeFileSync(path.join(root, file), png)
    fs.writeFileSync(path.join(root, 'src/renderer/favicon.png'), await render(64))
    // PNG-compressed ICO entries for every common Windows UI size.
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const images = []
    for (const size of sizes) images.push(await render(size))
    const header = Buffer.alloc(6 + 16 * sizes.length)
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16
      header[entry] = header[entry + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12)
      offset += images[index].length
    })
    fs.writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...images]))
    win.destroy()
    console.log('Updated application, installer, tray and favicon artwork from the local SVG source.')
    app.quit()
  }).catch(error => { console.error(error.message); app.exit(1) })
}
