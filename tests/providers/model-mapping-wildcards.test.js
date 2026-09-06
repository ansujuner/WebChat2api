const test = require('node:test'), assert = require('node:assert/strict'), ts = require('typescript'), vm = require('node:vm')
const { readFileSync } = require('node:fs')
const helpers = import('../../src/main/proxy/modelMappingResolver.ts')
const plain = value => JSON.parse(JSON.stringify(value))
function load(file, mocks) {
 const module={exports:{}}
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {module,exports:module.exports,console:{log(){},warn(){},error(){}},require:name=>{if(name==='../../shared/accountAvailability') return require('../../src/shared/accountAvailability.ts'); if(name==='../arena/rateLimit') return {getArenaModelAvailability:()=>({available:true,reason:'ready'})}; assert.ok(mocks[name],name);return mocks[name]}})
 return module.exports
}
test('documented prefix, suffix and middle wildcard patterns resolve with exact and specificity priority',async()=>{
 const {resolveModelMapping,matchesModelPattern}=await helpers
 const mappings=Object.freeze({
 '*':{actualModel:'fallback'}, 'gpt-*':{actualModel:'prefix',preferredProviderId:'provider',preferredAccountId:'account'},
 '*-turbo':{actualModel:'suffix'}, 'claude-*-latest':{actualModel:'middle'}, 'gpt-exact':{actualModel:'exact'},
 })
 for(const [requested,actual] of [['gpt-4.1','prefix'],['other-turbo','suffix'],['claude-opus-latest','middle'],['gpt-exact','exact'],['misc','fallback']])
  assert.equal(resolveModelMapping(requested,mappings).actualModel,actual)
 assert.equal(resolveModelMapping('GPT-4.1',mappings).preferredAccountId,'account')
 assert.equal(resolveModelMapping('gpt-4.1',mappings,'other'),undefined)
 assert.equal(matchesModelPattern('gpt-a','gpt-*'),true)
 assert.equal(matchesModelPattern('gpt-aa','gpt-(a+)*'),false)
 assert.equal(matchesModelPattern('gpt-[x]-a','gpt-[x]-*'),true)
 assert.equal(matchesModelPattern('gpt-x-a','gpt-[x]-*'),false)
})
test('wildcard resolver bounds untrusted patterns, ignores malformed entries and never redirects Arena',async()=>{
 const {resolveModelMapping,matchesModelPattern}=await helpers
 for(const pattern of ['x'.repeat(257), 'a*b*c', 'x\n*']) assert.equal(matchesModelPattern('anything',pattern),false)
 assert.equal(matchesModelPattern('x'.repeat(257),'*'),false)
 assert.equal(resolveModelMapping('arena/image/Max',{'*':{actualModel:'wrong'}}),undefined)
 assert.equal(resolveModelMapping('Arena/text/Max',{'*':{actualModel:'wrong'}}),undefined)
 assert.equal(resolveModelMapping('x',{'x':null}),undefined)
 assert.equal(resolveModelMapping('x',{'*':{actualModel:''}}),undefined)
 assert.equal(resolveModelMapping('x',null),undefined)
})
test('actual mapper preferences and load balancer agree on wildcard alias provider/account/native model',async()=>{
 const resolver=await helpers
 const config=Object.freeze({modelMappings:Object.freeze({'claude-*-latest':Object.freeze({actualModel:'Public Model',preferredProviderId:'web',preferredAccountId:'second'})})})
 const provider={id:'web',name:'Website',enabled:true}
 const storeManager={getConfig:()=>config,getProviders:()=>[provider],getAccountsByProviderId:()=>[{id:'first',status:'active'},{id:'second',status:'active'}],getEffectiveModels:()=>[{displayName:'Public Model',actualModelId:'native-uuid'}]}
 const mocks={'../store/store':{storeManager},'./modelMappingResolver':resolver}
 const {ModelMapper}=load('src/main/proxy/modelMapper.ts',mocks)
 const {LoadBalancer}=load('src/main/proxy/loadbalancer.ts',mocks)
 const mapper=new ModelMapper(),balancer=new LoadBalancer(),model='claude-opus-latest'
 const selection=balancer.selectAccount(model,'round-robin',mapper.getPreferredProvider(model),mapper.getPreferredAccount(model))
 assert.equal(selection.account.id,'second')
 assert.equal(selection.provider.id,'web')
 assert.equal(selection.actualModel,'native-uuid')
 assert.equal(mapper.mapModel(model),'Public Model')
 assert.equal(mapper.getActualModel(model),'Public Model')
 assert.deepEqual(plain(config.modelMappings['claude-*-latest']),{actualModel:'Public Model',preferredProviderId:'web',preferredAccountId:'second'})
})

test('fresh usage helper handles account deletion and invalid counters without mutating snapshots',async()=>{
 const {recordAccountSuccess}=await import('../../src/main/proxy/requestAccounting.ts')
 let account=Object.freeze({requestCount:4,todayUsed:2}),writes=0
 const store={getAccountById:()=>account,updateAccount:(_,updates)=>{writes++;account={...account,...updates}}}
 const snapshot=account
 recordAccountSuccess(store,'account');recordAccountSuccess(store,'account')
 assert.equal(account.requestCount,6);assert.equal(account.todayUsed,4);assert.equal(snapshot.requestCount,4)
 account=undefined;recordAccountSuccess(store,'deleted');assert.equal(writes,2)
 account={requestCount:NaN,todayUsed:-4};recordAccountSuccess(store,'account');assert.equal(account.requestCount,1);assert.equal(account.todayUsed,1)
})
