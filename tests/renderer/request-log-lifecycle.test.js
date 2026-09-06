const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')

const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/src/components/logs/RequestLogList.tsx'), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: 'RequestLogList.tsx',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(api) {
  let cursor = 0
  const slots = [], effects = [], pending = [], toasts = [], timers = new Set()
  const useMemo = (callback, deps) => {
    const index = cursor++, old = slots[index]
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { deps, value: callback() }
    return slots[index].value
  }
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useMemo,
    useCallback: (callback, deps) => useMemo(() => callback, deps),
    useEffect(callback, deps) {
      const index = cursor++, old = effects[index]
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        const effect = { deps }
        effects[index] = effect
        pending.push(() => { old?.cleanup?.(); effect.cleanup = callback() })
      }
    },
  }
  const primitives = Object.fromEntries([
    'Button', 'Badge', 'List', 'Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue',
    'Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle',
    'RequestLogDetail', 'RequestLogStats', 'Trash2',
  ].map(name => [name, function Component() {}]))
  const imports = {
    react: hooks, 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    '@/hooks/use-toast': { useToast: () => ({ toast: data => toasts.push(data) }) },
    ...Object.fromEntries(['react-window', '@/components/ui/badge', '@/components/ui/button', '@/components/ui/select',
      '@/components/ui/dialog', './RequestLogDetail', './RequestLogStats', 'lucide-react'].map(name => [name, primitives])),
  }
  const module = { exports: {} }
  const window = { electronAPI: { requestLogs: api }, addEventListener() {}, removeEventListener() {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, window, console: { error() {} },
    setInterval(callback) { timers.add(callback); return callback }, clearInterval(callback) { timers.delete(callback) },
    require(name) { assert.ok(name in imports, `Unmocked import ${name}`); return imports[name] },
  })
  const render = () => {
    cursor = 0
    let tree = module.exports.RequestLogList()
    pending.splice(0).forEach(callback => callback())
    cursor = 0
    tree = module.exports.RequestLogList()
    const nodes = []
    const visit = node => { if (React.isValidElement(node)) { nodes.push(node); React.Children.forEach(node.props.children, visit) } }
    visit(tree)
    return nodes
  }
  const find = name => render().find(node => node.type === primitives[name])
  return {
    toasts, window,
    render,
    logIds: () => find('List')?.props.rowProps.logs.map(log => log.id) || [],
    filter: status => find('Select').props.onValueChange(status),
    clear() { return render().filter(node => node.type === primitives.Button && node.props.children === 'logs.clearLogs').at(-1).props.onClick() },
    poll() { for (const callback of timers) callback() },
    dispose() { for (const effect of effects) effect?.cleanup?.() },
  }
}

test('a slow previous filter response cannot replace the latest request logs', async () => {
  const first = deferred(), second = deferred()
  const f = fixture({ get: options => options.status ? second.promise : first.promise, getStats: async () => ({ total: 1 }) })
  f.render()
  f.filter('error'); f.render()
  second.resolve([{ id: 'latest-error' }]); await turn()
  assert.deepEqual(Array.from(f.logIds()), ['latest-error'])
  first.resolve([{ id: 'stale-unfiltered' }]); await turn()
  assert.deepEqual(Array.from(f.logIds()), ['latest-error'])
  f.dispose()
})

test('successful clear cannot be undone by an earlier polling response', async () => {
  const poll = deferred()
  let reads = 0
  const f = fixture({ get: () => ++reads === 1 ? Promise.resolve([{ id: 'existing' }]) : poll.promise,
    getStats: async () => ({ total: 1 }), clear: async () => {} })
  f.render(); await turn()
  f.poll()
  await f.clear()
  assert.deepEqual(Array.from(f.logIds()), [])
  poll.resolve([{ id: 'stale-before-clear' }]); await turn()
  assert.deepEqual(Array.from(f.logIds()), [])
  f.dispose()
})

for (const failure of ['missing', 'rejected']) {
  test(`clear ${failure} IPC preserves visible logs and reports a translated error`, async () => {
    const api = { get: async () => [{ id: 'keep-existing' }], getStats: async () => ({ total: 1 }),
      clear: async () => { throw Error('PRIVATE-ERROR-DETAIL') } }
    const f = fixture(api)
    f.render(); await turn()
    if (failure === 'missing') f.window.electronAPI = undefined
    await assert.doesNotReject(f.clear())
    assert.deepEqual(Array.from(f.logIds()), ['keep-existing'])
    assert.equal(f.toasts.at(-1)?.title, 'logs.clearFailed')
    assert.doesNotMatch(JSON.stringify(f.toasts), /PRIVATE-ERROR-DETAIL/)
    f.dispose()
  })
}

test('same-turn duplicate clear clicks issue one request and do not poll while clearing', async () => {
  const clear = deferred()
  let calls = 0, reads = 0
  const f = fixture({ get: async () => { reads++; return [{ id: 'existing' }] }, getStats: async () => ({ total: 1 }),
    clear: () => { calls++; return clear.promise } })
  f.render(); await turn()
  const first = f.clear(), second = f.clear()
  f.poll()
  assert.equal(calls, 1)
  assert.equal(reads, 1)
  clear.resolve(); await Promise.all([first, second])
  f.dispose()
})

test('disposal cancels polling and ignores responses from the previous page lifetime', async () => {
  const read = deferred()
  let reads = 0
  const f = fixture({ get: () => { reads++; return read.promise }, getStats: async () => ({ total: 1 }) })
  f.render()
  f.dispose()
  f.poll()
  read.resolve([{ id: 'from-unmounted-page' }]); await turn()
  assert.equal(reads, 1)
  assert.deepEqual(Array.from(f.logIds()), [])
})
