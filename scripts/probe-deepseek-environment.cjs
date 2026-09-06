// Public login-page compatibility probe. No credentials or stored accounts are read.
const path = require('node:path'); const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const parent = path.join(root, '.audit-cache'); fs.mkdirSync(parent, {recursive:true});
  const fixture = fs.mkdtempSync(path.join(parent, 'deepseek-embedded-probe-'));
  fs.writeFileSync(path.join(fixture,'package.json'), JSON.stringify({name:'chat2api-login-probe',version:'1.0.0',main:__filename}));
  const env = {...process.env, CHAT2API_ENV_FIXTURE:fixture, USERPROFILE:fixture,HOME:fixture,APPDATA:fixture,LOCALAPPDATA:fixture};
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_RENDERER_URL']) delete env[key];
  const child = spawnSync(path.join(root,'node_modules/electron/dist/electron.exe'), [fixture], {cwd:root, env,windowsHide:true, timeout:60000,encoding:'utf8'});
  const report = path.join(root,'artifacts/deepseek-embedded-environment.json');
  if (fs.existsSync(report)) console.log(fs.readFileSync(report,'utf8'));
  process.exit(child.status ?? 1);
} else {
  const {app,BrowserWindow,session}=require('electron');
  const fixture=process.env.CHAT2API_ENV_FIXTURE;
  if(!fixture || !path.resolve(fixture).startsWith(path.join(root,'.audit-cache')+path.sep)) throw Error('Unsafe fixture path');
  for(const key of ['userData','sessionData','appData','temp']){const value=path.join(fixture,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}
  app.setAppLogsPath(path.join(fixture,'logs'));
  const timer=setTimeout(()=>app.exit(1),45000);
  app.whenReady().then(async()=>{
    const ses=session.fromPartition('environment-probe');await ses.setProxy({mode:'system'});
    const win=new BrowserWindow({show:false,width:1060,height:780,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false}});
    try {
      await win.loadURL('https://chat.deepseek.com/');
      await new Promise(r=>setTimeout(r,6000));
      const result=await win.webContents.executeJavaScript(`({pageLoaded:location.origin==='https://chat.deepseek.com',electronMarker:navigator.userAgent.toLowerCase().includes('electron'),rendererProcessExposed:('process' in window && window.process?.type==='renderer'),unsafeWarningVisible:/使用环境异常|数据和隐私泄露风险|unsafe environment|privacy.*risk/i.test(document.body?.innerText||''),loginPageVisible:/登录|Log in|Sign in/i.test(document.body?.innerText||''),title:document.title})`);
      fs.writeFileSync(path.join(root,'artifacts/deepseek-embedded-environment.json'),JSON.stringify({...result,profileIsolated:true,credentialsRead:false,checkedAt:new Date().toISOString()},null,2));
    } catch {fs.writeFileSync(path.join(root,'artifacts/deepseek-embedded-environment.json'),JSON.stringify({status:'page_load_failed',credentialsRead:false}))}
    clearTimeout(timer);win.destroy();app.quit();
  });
}
