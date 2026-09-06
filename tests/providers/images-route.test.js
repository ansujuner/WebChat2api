const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), ts=require('typescript'), {readFileSync}=require('node:fs'), {EventEmitter}=require('node:events')
function fixture(options={}) {
 let handle, calls=0, starts=0, success=0, failure=0; const stats=[]; let account={requestCount:4,todayUsed:2}
 class ArenaError extends Error {constructor(code){super('safe Arena error');this.code=code;this.status=409}}
 const imports={
 '@koa/router': {default:class{constructor(){}post(path,fn){assert.equal(path,'/generations');handle=fn}}},
 'node:crypto':require('node:crypto'),
 '../loadbalancer':{loadBalancer:{clearAccountFailure(){},getModelRateLimit:()=>options.rateLimit,selectAccount:()=>options.noAccount?null:{provider:{id:'arena'},account:{id:'owned',credentials:{browserProfileId:'owned-profile-only'}},actualModel:'native-model-id'}}},
 '../requestAccounting':{recordAccountSuccess(store,id){const current=store.getAccountById(id);if(current)store.updateAccount(id,{requestCount:current.requestCount+1,todayUsed:current.todayUsed+1})}},
 '../modelMapper':{modelMapper:{getPreferredProvider:()=>undefined,getPreferredAccount:()=>undefined}},
 '../status':{proxyStatusManager:{recordRequestStart(){starts++},recordRequestSuccess(){success++},recordRequestFailure(){failure++}}},
 '../../store/store':{storeManager:{getConfig:()=>({loadBalanceStrategy:'round-robin'}),getAccountById:()=>account,updateAccount:(_,updates)=>{account={...account,...updates}},recordRequestInStats:ok=>stats.push(ok)}},
 '../../arena/browserManager':{arenaBrowserManager:{generateImage:async args=>{calls++;assert.equal(args.profileId,'owned-profile-only');assert.equal(args.model,'native-model-id');assert.equal(args.prompt,'a test square');if(options.run)return options.run(args);if(options.challenge)throw new ArenaError('action_required');return {url:'https://fixture.arena.invalid/generated.png'}}}},
 '../../arena/protocol':{ArenaError},
 }
 const module={exports:{}}
 vm.runInNewContext(ts.transpileModule(readFileSync('src/main/proxy/routes/images.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{assert.ok(imports[name],name);return imports[name]},Date,AbortController})
 const ctx={request:{body:{model:'arena/image/max',prompt:'a test square'}},res:new EventEmitter(),headers:{},set(k,v){this.headers[k]=v}}
 return {ctx,stats,getAccount:()=>account,run:()=>handle(ctx),counts:()=>({calls,starts,success,failure})}
}
test('image route submits once, returns URL contract and accounts only after response finish',async()=>{
 const f=fixture();await f.run();assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.body.data)),[{url:'https://fixture.arena.invalid/generated.png'}]);assert.ok(Number.isInteger(f.ctx.body.created));assert.deepEqual(f.counts(),{calls:1,starts:1,success:0,failure:0});f.ctx.res.writableFinished=true;f.ctx.res.emit('finish');f.ctx.res.emit('close');assert.deepEqual(f.counts(),{calls:1,starts:1,success:1,failure:0});assert.ok(!JSON.stringify(f.ctx.body).includes('owned-profile'))
})
for(const update of [null,[],{model:'arena/text/max',prompt:'a test square'},{model:'arena/image/max',prompt:''},{model:'arena/image/max',prompt:'a test square',n:2},{model:'arena/image/max',prompt:'a test square',response_format:'b64_json'},{model:'arena/image/max',prompt:'a test square',size:'1024x1024'},{model:'arena/image/max',prompt:'a test square',credentials:'injected'}])test('invalid/unsupported images request fails before submission '+JSON.stringify(update),async()=>{const f=fixture();f.ctx.request.body=update;await f.run();assert.equal(f.ctx.status,400);assert.equal(f.counts().calls,0)})
test('no active Arena account never submits',async()=>{const f=fixture({noAccount:true});await f.run();assert.equal(f.ctx.status,503);assert.equal(f.counts().calls,0)})
test('model-only image quota returns 429 and Retry-After without submitting or consuming usage',async()=>{
 const f=fixture({noAccount:true,rateLimit:{availableAt:Date.now()+60000}});await f.run();assert.equal(f.ctx.status,429);assert.equal(f.ctx.body.error.code,'model_rate_limited');assert.ok(Number(f.ctx.headers['Retry-After'])>0);assert.deepEqual(f.counts(),{calls:0,starts:0,success:0,failure:0});assert.deepEqual(f.getAccount(),{requestCount:4,todayUsed:2})
})
test('interactive verification is actionable and never automatically retried',async()=>{const f=fixture({challenge:true});await f.run();assert.equal(f.ctx.status,409);assert.equal(f.ctx.body.error.code,'action_required');assert.deepEqual(f.counts(),{calls:1,starts:1,success:0,failure:1})})
test('disconnect aborts browser work and settles failure exactly once',async()=>{let signal,release;const f=fixture({run:args=>{signal=args.signal;return new Promise(r=>{release=r})}});const pending=f.run();f.ctx.res.emit('close');assert.equal(signal.aborted,true);release({url:'https://fixture.arena.invalid/generated.png'});await pending;f.ctx.res.emit('close');assert.deepEqual(f.counts(),{calls:1,starts:1,success:0,failure:1});assert.equal(f.ctx.body,undefined)})

test('image success contributes exactly once to saved usage, limits and persistent statistics',async()=>{
 const f=fixture();await f.run();assert.deepEqual(f.getAccount(),{requestCount:4,todayUsed:2});assert.deepEqual(f.stats,[]);
 f.ctx.res.writableFinished=true;f.ctx.res.emit('finish');f.ctx.res.emit('finish');f.ctx.res.emit('close');
 assert.deepEqual(f.getAccount(),{requestCount:5,todayUsed:3});assert.deepEqual(f.stats,[true]);
})
test('image failure contributes failure statistics but never consumes a successful account request',async()=>{
 const f=fixture({challenge:true});await f.run();f.ctx.res.emit('close');assert.deepEqual(f.getAccount(),{requestCount:4,todayUsed:2});assert.deepEqual(f.stats,[false]);
})
