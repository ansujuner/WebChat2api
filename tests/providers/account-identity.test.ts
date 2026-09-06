import test from 'node:test'
import assert from 'node:assert/strict'
import { accountEmail, accountUserId, defaultAccountName, normalizeAccountIdentity, shortAccountId, validatedAccountIdentity } from '../../src/shared/accountIdentity.ts'

const account = (extra = {}) => ({ id: '1750000000-random001', providerId: 'deepseek', name: 'DeepSeek 账户', ...extra })

test('automatic labels prefer the verified email over nicknames and provider IDs', () => {
  assert.equal(normalizeAccountIdentity(account({ email: ' alice@example.test ', providerUserId: 'u-12' }), 'DeepSeek').name, 'alice@example.test')
  assert.equal(defaultAccountName(account({ providerUserId: 'u-12' }), 'DeepSeek'), 'DeepSeek · u-12')
  assert.equal(defaultAccountName(account(), 'DeepSeek'), 'DeepSeek · andom001')
})

test('known legacy generated labels migrate, but custom names including explicit generic names survive', () => {
  for (const name of ['DeepSeek 账户', 'DeepSeek 账号', 'DeepSeek Accounts', 'DeepSeek User', '']) {
    const result = normalizeAccountIdentity(account({ name, email: 'a@example.test' }), 'DeepSeek')
    assert.equal(result.name, 'a@example.test')
    assert.equal(result.nameSource, 'auto')
  }
  for (const name of ['My production account', '测试账号', 'Alice']) {
    assert.equal(normalizeAccountIdentity(account({ name, email: 'a@example.test' }), 'DeepSeek').name, name)
  }
  assert.equal(normalizeAccountIdentity(account({ nameSource: 'custom' as const, email: 'a@example.test' }), 'DeepSeek').name, 'DeepSeek 账户')
  assert.equal(normalizeAccountIdentity(account({ name: '', nameSource: 'custom' as const, email: 'a@example.test' }), 'DeepSeek').name, 'a@example.test')
})

test('newly verified identity renames automatic names without erasing earlier identity', () => {
  const old = normalizeAccountIdentity(account(), 'DeepSeek')
  const current = normalizeAccountIdentity({ ...old, ...validatedAccountIdentity({ email: 'b@example.test', userId: 'u-1' }) }, 'DeepSeek')
  assert.equal(current.name, 'b@example.test')
  assert.equal(current.providerUserId, 'u-1')
  assert.deepEqual(validatedAccountIdentity({ email: '', userId: '' }), {})
  assert.equal(normalizeAccountIdentity({ ...current, ...validatedAccountIdentity() }, 'DeepSeek').name, 'b@example.test')
})

test('labels reject malformed remote identity values and never derive names from credentials', () => {
  for (const value of ['not an email', 'x@a', 'x@y.z\nInjected', 'x@y.z\x00', {}, 123, null]) assert.equal(accountEmail(value), undefined)
  assert.equal(accountUserId(' id\nheader '), undefined)
  assert.equal(accountUserId({ token: 'fixture' }), undefined)
  assert.equal(accountUserId(123), '123')
  assert.equal(accountUserId(Number.MAX_SAFE_INTEGER + 1), undefined)
  const result = normalizeAccountIdentity(account({ credentials: { email: 'do-not-use@example.test', token: 'fixture' } }), 'DeepSeek')
  assert.equal(result.name, 'DeepSeek · andom001')
})

test('automatic migration is immutable, idempotent and individual local IDs distinguish duplicate emails', () => {
  const source = Object.freeze(account({ email: 'shared@example.test' }))
  const result = normalizeAccountIdentity(source, 'DeepSeek')
  assert.notEqual(result, source)
  assert.equal(source.name, 'DeepSeek 账户')
  assert.deepEqual(normalizeAccountIdentity(result, 'DeepSeek'), result)
  assert.notEqual(shortAccountId('1750000000-random001'), shortAccountId('1750000000-random002'))
})
