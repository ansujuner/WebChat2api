const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '../..')

function configModule() {
  const defaults = Object.fromEntries(['proxyPort','proxyHost','loadBalanceStrategy','modelMappings','theme','language','autoStart','autoStartProxy','minimizeToTray','logLevel','logRetentionDays','requestLogConfig','requestTimeout','retryCount','apiKeys','enableApiKey','oauthProxyMode','sessionConfig','toolCallingConfig','toolPromptConfig','managementApi','contextManagement','defaultModelMappingsSeeded'].map(key => [key, undefined]))
  const writes = [], logs = [], module = { exports: {} }
  const storeManager = { getConfig: () => defaults, updateConfig: updates => { writes.push(updates); return { ...defaults, ...updates } }, addLog: (...args) => logs.push(args) }
  const imports = { './store': { storeManager }, './types': { DEFAULT_CONFIG: defaults }, '../../shared/toolCalling': {
    normalizeToolCallingConfig: value => ({ ...value, mode: ['off','auto','force'].includes(value.mode) ? value.mode : 'auto' }),
  } }
  const code = ts.transpileModule(readFileSync(join(root, 'src/main/store/config.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { exports: module.exports, module, require: name => { assert.ok(imports[name], name); return imports[name] } })
  return { api: module.exports.ConfigManager, writes, logs }
}

test('configuration rejects invalid shapes and coerced scalar types before persistence', () => {
  const { api, writes } = configModule()
  const invalid = [null, [], 'value', {proxyPort:'8081'}, {proxyPort:8081.5}, {proxyPort:NaN}, {proxyPort:Infinity},
    {enableApiKey:'false'}, {autoStart:1}, {retryCount:0.5}, {sessionConfig:null}, {managementApi:[]},
    {toolCallingConfig:[]}, {apiKeys:{}}, {proxyHost:'http://localhost'}, {language:'unsupported'},
    {sessionConfig:{sessionTimeout:0}}, {managementApi:{enableManagementApi:'true'}}, {unexpected:'private-value'}]
  for (const value of invalid) {
    assert.equal(api.validate(value).valid, false, JSON.stringify(value))
    assert.throws(() => api.update(value))
  }
  assert.equal(writes.length, 0)
})

test('configuration logs field names only, not API keys, secrets or prompt values', () => {
  const { api, writes, logs } = configModule()
  const updates = { apiKeys: [{id:'fixture',name:'test',key:'private-gateway-fixture',enabled:true}],
    managementApi:{enableManagementApi:true,managementApiSecret:'private-management-fixture'},
    toolCallingConfig:{enabled:true,mode:'auto',clientAdapterId:'standard-openai-tools',advanced:{customPrompt:'private-prompt-fixture'}} }
  api.update(updates)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].apiKeys[0].key, updates.apiKeys[0].key)
  const serialized = JSON.stringify(logs)
  assert.match(serialized, /updatedFields/)
  assert.doesNotMatch(serialized, /private-|customPrompt/)
})

test('valid partial updates and fail-closed empty API key lists remain supported', () => {
  const { api } = configModule()
  for (const value of [{proxyPort:8081,proxyHost:'::1'}, {language:'zh-CN'}, {retryCount:0},
    {enableApiKey:true,apiKeys:[]}, {sessionConfig:{sessionTimeout:30}}, {oauthProxyMode:'system'}]) {
    assert.equal(api.validate(value).valid, true, JSON.stringify(value))
  }
})

test('store public entry initializes the imported singleton rather than an undefined identifier', async () => {
  const module = { exports: {} }; let initialized = 0
  const source = readFileSync(join(root, 'src/main/store/index.ts'), 'utf8')
  const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const imports = {'./types':{},'./store':{storeManager:{initialize:async()=>{initialized++}},StoreManager:class{}},'./accounts':{},'./providers':{},'./config':{},'./validator':{}}
  vm.runInNewContext(output,{module,exports:module.exports,require:name=>{assert.ok(imports[name],name);return imports[name]}})
  await module.exports.initializeStore()
  assert.equal(initialized,1)
  assert.equal(typeof module.exports.StoreManager,'function')
})

test('provider adapter public entry exports stream modules and Arena from their actual files', () => {
  const module = { exports: {} }, nativeStream = class {}, arenaAdapter = class {}, arenaStream = class {}
  const output = ts.transpileModule(readFileSync(join(root,'src/main/proxy/adapters/index.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  vm.runInNewContext(output,{module,exports:module.exports,require:name=> name==='./perplexity-stream'?{PerplexityStreamHandler:nativeStream}:name==='./arena'?{ArenaAdapter:arenaAdapter}:name==='./arena-stream'?{ArenaStreamHandler:arenaStream}:{}})
  assert.equal(module.exports.PerplexityStreamHandler,nativeStream)
  assert.equal(module.exports.ArenaAdapter,arenaAdapter)
  assert.equal(module.exports.ArenaStreamHandler,arenaStream)
})

test('legacy default prompt entry loads its actual exported signature constant', () => {
  const module = { exports: {} }, signatures = ['fixture signature']
  const output = ts.transpileModule(readFileSync(join(root,'src/main/proxy/adapters/prompt/DefaultPromptAdapter.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const imports = {'./BasePromptAdapter':{BasePromptAdapter:class { registerVariant() {} }},'../../utils/toolParser':{},'../../constants/signatures':{GENERAL_TOOL_SIGNATURES:signatures},'../../prompt/variants':{DEFAULT_VARIANT:{},XML_VARIANT:{}}}
  vm.runInNewContext(output,{module,exports:module.exports,require:name=>{assert.ok(imports[name],name);return imports[name]}})
  assert.equal(module.exports.defaultPromptAdapter.detectSignatures,signatures)
})

test('shared account factory returns the current identity and usage fields', () => {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(join(root,'src/main/proxy/utils/accountUtils.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  vm.runInNewContext(output,{module,exports:module.exports})
  const value = module.exports.createAccount('fixture',{}, {email:'fixture@example.test',name:'Same name',userId:'public-id'})
  assert.equal(value.name,'fixture@example.test')
  assert.equal(value.nameSource,'auto')
  assert.equal(value.providerUserId,'public-id')
  assert.equal(value.requestCount,0)
  assert.equal(value.todayUsed,0)
  assert.equal(Object.hasOwn(value,'usageCount'),false)
  assert.ok(module.exports.createAccount('fixture',{}).name)
})
