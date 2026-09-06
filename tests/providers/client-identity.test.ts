import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeClientIdentity } from '../../src/main/proxy/clientIdentity.ts'
import { conversationScope } from '../../src/main/proxy/conversationContinuity.ts'
test('Claude session stays stable and each subagent has a separate identity', () => {
  const scope = (user, session = 'session-1', agent = '') => conversationScope('key', 'loopback', normalizeClientIdentity(user, {session, agent}))
  assert.equal(scope('nonce-1'), scope('nonce-2'))
  assert.notEqual(scope('nonce-1'), scope('nonce-1', 'session-2'))
  assert.notEqual(scope('nonce-1'), scope('nonce-1', 'session-1', 'agent-1'))
  assert.notEqual(scope('nonce-1','session-1','agent-1'), scope('nonce-1','session-1','agent-2'))
})
test('JSON metadata key order canonicalizes without deleting metadata or authentication scope', () => {
  const id = value => normalizeClientIdentity(value, {})
  assert.equal(conversationScope('key', id('{"a":1,"b":2}')), conversationScope('key',id('{"b":2,"a":1}')))
  assert.notEqual(conversationScope('key',id('{"a":1}')), conversationScope('other-key',id('{"a":1}')))
  assert.notEqual(conversationScope('key',id('{"a":1}')), conversationScope('key',id('{"a":2}')))
  assert.equal(normalizeClientIdentity('opaque', {session:'x'.repeat(257)}), 'opaque')
  assert.equal(normalizeClientIdentity('opaque', {session:'bad\nheader'}), 'opaque')
})
