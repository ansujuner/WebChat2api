import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { ConversationContinuity, getConversationOptions } from '../../src/main/proxy/conversationContinuity.ts'
import { convertAnthropicRequest } from '../../src/main/proxy/anthropic/messages.ts'
const provider = {id:'deepseek',name:'DeepSeek',type:'builtin',authType:'userToken',apiEndpoint:'https://fixture.invalid',headers:{},enabled:true,createdAt:0,updatedAt:0} as const
const prefix = 'First turn instructions. '.repeat(4000)
const tools = [{name:'fixture_echo',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]
const firstMessage = {role:'user',content:'hello'}
const call = {type:'tool_use',id:'call_fixture_1',name:'fixture_echo',input:{text:'true'}}
test('Claude full-history tool roundtrip forwards its large preamble once and only new tool result later', () => {
  const manager = new ConversationContinuity(), engine = new ToolCallingEngine()
  const payload = {model:'deepseek-v4-flash',max_tokens:128,system:[{type:'text',text:prefix}],tools,messages:[firstMessage]}
  const first = manager.begin(convertAnthropicRequest(payload),'scope')
  first.bind({providerId:'deepseek',accountId:'fixture',actualModel:'deepseek-v4-flash'})
  const sentFirst = engine.transformRequest({request:first.request,provider,actualModel:first.request.model})
  assert.equal(sentFirst.plan.shouldInjectPrompt,true)
  assert.ok(String(sentFirst.messages[0].content).includes(prefix))
  getConversationOptions(first.request).onConversation!({sessionId:'upstream',parentMessageId:'1'})
  first.commit({role:'assistant',content:null,tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]})
  const second = manager.begin(convertAnthropicRequest({...payload,system:[{type:'text',text:prefix,cache_control:{type:'ephemeral'}}],messages:[firstMessage,{role:'assistant',content:[call]},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'local result'}]}]}),'scope')
  assert.equal(second.id,first.id)
  const sentSecond = engine.transformRequest({request:second.request,provider,actualModel:second.request.model,contextAlreadyInitialized:!!getConversationOptions(second.request).conversation})
  assert.equal(sentSecond.plan.shouldInjectPrompt,false)
  assert.equal(sentSecond.plan.diagnostics.injected,false)
  assert.equal(sentSecond.plan.shouldParseResponse,true)
  assert.deepEqual(sentSecond.messages,[{role:'tool',tool_call_id:call.id,content:'local result'}])
  assert.ok(!JSON.stringify(sentSecond.messages).includes('First turn instructions'))
  assert.ok(!JSON.stringify(sentSecond.messages).includes('Available Tools'))
  second.cancel()
  const fresh = manager.begin(convertAnthropicRequest({...payload,new_conversation:true}),'scope')
  const again = engine.transformRequest({request:fresh.request,provider,actualModel:fresh.request.model})
  assert.equal(again.plan.shouldInjectPrompt,true)
  assert.ok(String(again.messages[0].content).includes(prefix))
  fresh.cancel()
})
