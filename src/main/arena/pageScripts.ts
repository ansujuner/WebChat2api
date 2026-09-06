/** Read only the current Arena React provider stores, projecting public models and verified profile labels. */
export const ARENA_RUNTIME_SNAPSHOT = `(() => {
  if (location.origin !== 'https://arena.ai') return null;
  const safe = { ready: false, authenticated: false, accountInfo: {}, models: [] };
  const seen = new Set(), stores = new Map(), queue = [];
  let userPriority = 0, modelPriority = 0;
  const label = value => typeof value === 'string' && value.length <= 320 ? value : undefined;
  for (const node of Array.from(document.querySelectorAll('*')).slice(0, 400)) {
    const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'));
    if (key) { let fiber = node[key]; for (let n = 0; fiber?.return && n < 100; n++) fiber = fiber.return; queue.push(fiber); break; }
  }
  const inspect = (value, priority = 2) => {
    if (!value || typeof value !== 'object' || (stores.get(value) || 0) >= priority) return;
    stores.set(value, priority);
    if (typeof value.getState === 'function') { try { inspect(value.getState(), 3); } catch {} return; }
    const hasUser = Object.prototype.hasOwnProperty.call(value, 'user');
    const nextUserPriority = hasUser ? priority : 1;
    if ((hasUser || Object.prototype.hasOwnProperty.call(value, 'initialUser')) && nextUserPriority > userPriority) {
      userPriority = nextUserPriority;
      const user = hasUser ? value.user : value.initialUser;
      safe.authenticated = !!(user && typeof user.email === 'string' && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(user.email) && user.email.length <= 320);
      safe.accountInfo = safe.authenticated ? { email: user.email, ...(typeof user.name === 'string' && user.name.length <= 160 ? {name: user.name} : {}) } : {};
    }
    const hasModels = Array.isArray(value.models), models = hasModels ? value.models : value.initialModels;
    const nextModelPriority = hasModels ? priority : 1;
    if (Array.isArray(models) && nextModelPriority > modelPriority) { modelPriority = nextModelPriority; safe.models = models.slice(0, 2000).filter(model => model && typeof model === 'object').map(model => ({
      id: label(model.id), publicName: label(model.publicName), displayName: label(model.displayName),
      organization: label(model.organization), provider: label(model.provider), userSelectable: model.userSelectable !== false,
      ...(typeof model.rateLimitedUntil === 'string' && model.rateLimitedUntil.length <= 40 ? {rateLimitedUntil:model.rateLimitedUntil} : {}),
      capabilities: model.capabilities ? { inputCapabilities: {text: model.capabilities.inputCapabilities?.text === true},
        outputCapabilities: {text: model.capabilities.outputCapabilities?.text === true, image: model.capabilities.outputCapabilities?.image === true || !!(model.capabilities.outputCapabilities?.image && typeof model.capabilities.outputCapabilities.image === 'object' && !Array.isArray(model.capabilities.outputCapabilities.image))} } : null
    })); }
  };
  while (queue.length && seen.size < 10000) {
    const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    inspect(fiber.memoizedProps); inspect(fiber.memoizedProps?.value);
    let dependency = fiber.dependencies?.firstContext;
    for (let n = 0; dependency && n < 30; n++, dependency = dependency.next) inspect(dependency.memoizedValue);
    if (fiber.child) queue.push(fiber.child); if (fiber.sibling) queue.push(fiber.sibling);
  }
  safe.ready = userPriority >= 3 && modelPriority >= 3;
  return safe;
})()`

/** The site's ordinary Enterprise v3 score runs inside its own page; no token is returned or saved. */
export function arenaStartExpression(key: string, requestPath: string, body: object): string {
  return `(async () => {
    if (location.origin !== 'https://arena.ai') return {error:'action_required'};
    const key = ${JSON.stringify(key)};
    if (globalThis[key]) return {error:'account_busy'};
    const controller = new AbortController(), state = {queue:[], queued:0, done:false, error:null, controller, stage:'score', upstreamStatus:undefined, failureMeta:{}};
    Object.defineProperty(globalThis, key, {value:state, configurable:true});
    const deadline = setTimeout(() => controller.abort(), 180000);
    const fail = (error, retryAt) => {state.error=error;state.done=true;clearTimeout(deadline);return {error,...(Number.isSafeInteger(retryAt)?{retryAt}:{}),diagnostic:{stage:state.stage,...(state.upstreamStatus?{upstreamStatus:state.upstreamStatus}:{}),...state.failureMeta}};};
    const readProblem = async response => {
      if(!response.body)return null;
      const reader=response.body.getReader(), decoder=new TextDecoder();let text='',bytes=0;
      try {while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>65536){await reader.cancel();return null;}text+=decoder.decode(item.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
      catch{return null;}finally{try{reader.releaseLock();}catch{}}
    };
    const problemMetadata = problem => {
      const fields=['id','mode','modelAId','modelBId','modality','userMessageId','modelAMessageId','modelBMessageId','userMessage','content','type','text','experimental_attachments','metadata','recaptchaV3Token','recaptchaV2Token','cloudflareMetadata'];
      const allowedCodes=['invalid_type','invalid_literal','custom','invalid_union','invalid_union_discriminator','invalid_enum_value','unrecognized_keys','invalid_arguments','invalid_return_type','invalid_date','invalid_string','too_small','too_big','invalid_intersection_types','not_multiple_of','not_finite','invalid_format','invalid_value'];
      const messages=[],paths=new Set(),codes=new Set(),queue=[{value:problem,depth:0}];let count=0;
      while(queue.length&&count++<100){const {value,depth}=queue.shift();if(depth>5)continue;if(typeof value==='string'){messages.push(value.slice(0,2048));continue;}if(!value||typeof value!=='object')continue;
        if(Array.isArray(value)){for(const item of value.slice(0,32))queue.push({value:item,depth:depth+1});continue;}
        if(Array.isArray(value.path)&&value.path.length>0&&value.path.length<=8&&value.path.every(part=>typeof part==='string'&&fields.includes(part)))paths.add(value.path.join('.'));
        if(typeof value.code==='string'&&allowedCodes.includes(value.code))codes.add(value.code);
        for(const key of ['error','message','errors','issues','details','cause','code','validation'])if(Object.prototype.hasOwnProperty.call(value,key))queue.push({value:value[key],depth:depth+1});
      }
      const joined=messages.join(' '), rules=[['uuid',/uuid/i],['v7',/(?:uuid.?v?7|v7|version.?7)/i],['model',/model/i],['mode',/(?:^|[^a-z])mode(?:[^a-z]|$)/i],['validation',/invalid|validation|schema|parse|bad.request/i],['required',/required|missing/i],['body',/body|payload/i],['session',/session|evaluation/i],['quota',/quota/i],['credit',/credit|balance/i],['timestamp',/timestamp/i],['time',/time|expired|future|old/i],['version',/version/i],['recaptcha',/recaptcha|captcha/i],['authentication',/authentication|unauthorized|login|sign.in/i],['rate_limit',/rate.?limit/i]];
      const errorHints=rules.filter(([,pattern])=>pattern.test(joined)).map(([name])=>name);
      return {errorHints,...(paths.size?{issuePaths:Array.from(paths).slice(0,16)}:{}),...(codes.size?{issueCodes:Array.from(codes).slice(0,16)}:{})};
    };
    try {
      const script = Array.from(document.scripts).map(s => s.src).find(src => {try {const url=new URL(src);return url.origin==='https://www.google.com' && url.pathname==='/recaptcha/enterprise.js' && !url.username && !url.password;}catch{return false;}});
      const siteKey = script ? new URL(script).searchParams.get('render') : null;
      if (!siteKey || siteKey === 'explicit' || !window.grecaptcha?.enterprise?.ready || !window.grecaptcha?.enterprise?.execute) return fail('action_required');
      let scoreTimer, score;
      try { score = await Promise.race([new Promise((resolve,reject) => window.grecaptcha.enterprise.ready(() => window.grecaptcha.enterprise.execute(siteKey,{action:'chat_submit'}).then(resolve,reject))), new Promise((_,reject) => {scoreTimer=setTimeout(reject,15000);})]); }
      finally {if(scoreTimer)clearTimeout(scoreTimer);}
      if (controller.signal.aborted) return fail('aborted');
      if (typeof score !== 'string' || !score) return fail('action_required');
      state.stage='submission';
      const response = await fetch(${JSON.stringify(requestPath)}, {method:'POST',credentials:'same-origin',signal:controller.signal,
        body:JSON.stringify({...${JSON.stringify(body)},recaptchaV3Token:score})});
      if(Number.isInteger(response.status)&&response.status>=100&&response.status<=599)state.upstreamStatus=response.status;
      if (!response.ok) {
        // The current official client prioritizes RateLimit-Reset, then Retry-After.
        // Do not treat ratelimit-remaining (a request count) as a reset duration.
        if(response.status===429){
          const reset=response.headers?.get('RateLimit-Reset'), retry=response.headers?.get('Retry-After'), now=Date.now();
          let retryAt;
          if(typeof reset==='string' && /^[0-9]+(?:\\.[0-9]{1,3})?$/.test(reset.trim()))retryAt=Math.ceil(Number(reset)*1000);
          if(!(Number.isSafeInteger(retryAt)&&retryAt>now)&&typeof retry==='string'&&retry.trim())retryAt=/^[0-9]+(?:\\.[0-9]{1,3})?$/.test(retry.trim())?now+Math.ceil(Number(retry)*1000):Date.parse(retry);
          if(!(Number.isSafeInteger(retryAt)&&retryAt>now))retryAt=now+60000;
          try{await response.body?.cancel();}catch{}
          return fail('rate_limited',retryAt);
        }
        let required = [401,403].includes(response.status);
        state.failureMeta=problemMetadata(await readProblem(response));
        required=required||state.failureMeta.errorHints.some(hint=>['recaptcha','authentication','rate_limit'].includes(hint));
        return fail(required ? 'action_required' : 'upstream_error');
      }
      if (response.headers?.get('content-type')?.toLowerCase().includes('text/html')) return fail('action_required');
      if (!response.body) return fail('incomplete_stream');
      state.stage='stream';
      void (async () => {
        const reader=response.body.getReader(), decoder=new TextDecoder();
        let received=0;
        const pause=()=>new Promise((resolve,reject)=>{
          if(controller.signal.aborted){reject();return;}
          const cleanup=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);};
          const abort=()=>{cleanup();reject();};
          const timer=setTimeout(()=>{cleanup();resolve();},50);
          controller.signal.addEventListener('abort',abort,{once:true});
        });
        try {
          while (true) {
            const {done,value}=await reader.read(); if(done) break;
            received+=value.length;if(received>48*1024*1024){state.error='upstream_error';controller.abort();throw new Error();}
            for (let offset=0;offset<value.length;offset+=65536) {
              const text=decoder.decode(value.subarray(offset,offset+65536),{stream:true});
              while(state.queued+text.length>2*1024*1024)await pause();
              if(controller.signal.aborted)throw new Error();
              state.queue.push(text);state.queued+=text.length;
            }
          }
          const tail=decoder.decode();if(tail){state.queue.push(tail);state.queued+=tail.length;}
        } catch {state.error=state.error||(controller.signal.aborted?'aborted':'incomplete_stream');}
        finally {state.done=true;clearTimeout(deadline);try{reader.releaseLock();}catch{}}
      })();
      return {started:true};
    } catch {return fail(controller.signal.aborted?'aborted':'action_required');}
  })()`
}

export function arenaDrainExpression(key: string): string {
  return `(() => { if(location.origin!=='https://arena.ai')return {error:'action_required',done:true,chunks:[]};const state=globalThis[${JSON.stringify(key)}];if(!state)return {error:'incomplete_stream',done:true,chunks:[]};const chunks=[];let length=0;while(state.queue.length&&length<262144){const chunk=state.queue.shift();chunks.push(chunk);length+=chunk.length;state.queued-=chunk.length;}return {chunks,done:state.done&&!state.queue.length,error:state.error,...(state.error?{diagnostic:{stage:'stream',upstreamStatus:state.upstreamStatus}}:{})};})()`
}
export function arenaAbortExpression(key: string): string {
  return `(() => {if(location.origin!=='https://arena.ai')return;const key=${JSON.stringify(key)},state=globalThis[key];if(state){state.controller.abort();delete globalThis[key];}})()`
}
