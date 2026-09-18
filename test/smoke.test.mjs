/**
 * 冒烟测试：导出契约、注册的工具清单，以及本插件最核心的那条不变量 ——
 * 它绝不向进程级的 cordisInspect 注册表注册任何 provider。
 *
 * 测试用的是最小的假 ctx，只实现 apply 真正用到的那几个面；不打桩业务逻辑，
 * 断言的都是真实代码路径产出的结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/index.js'

const TOOL_NAMES = [
  'cordis_define',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
]

/** 一个只实现必要面的假 ctx。 */
function fakeCtx() {
  const tools = new Map()
  const sections = []
  const ctx = {
    systemPrompt: {
      section: (section) => { sections.push(section) },
    },
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      schemas: () => [],
    },
    reflect: { store: {} },
    // 这张注册表是进程级单例：本插件的存在理由就是**不**往里写东西。
    // 一旦写了，第二个挂着官方工具行的预设就再也挂不起来，所以这里直接炸。
    cordisInspect: {
      register: () => { throw new Error('must not register an inspect provider') },
      list: () => [],
    },
  }
  return { ctx, tools, sections }
}

test('导出 name / inject / apply 契约', () => {
  assert.equal(name, 'dsh-tool-cordis-local')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'dynamicCordisRunner', 'cordisInspect'])
  assert.equal(typeof apply, 'function')
})

test('注册七个工具和一个系统提示段，且不注册任何 inspect provider', () => {
  const { ctx, tools, sections } = fakeCtx()
  apply(ctx) // 若插件注册了 inspect provider，上面的桩会在这里抛错

  assert.deepEqual([...tools.keys()].sort(), TOOL_NAMES)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:cordis')
})

test('inspect_list 报四个宿主 provider；没有已连接页面时客户端目录为空', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx)

  const value = await tools.get('cordis_inspect_list').execute({}, {})
  assert.deepEqual(
    value.providers.map((provider) => `${provider.platform}:${provider.id}`),
    ['host:Service', 'host:Event', 'host:Builtin', 'host:Tool'],
  )
})

test('host 查询：Service.listService 活读服务存储', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx)

  const result = await tools.get('cordis_inspect_query').execute(
    { platform: 'host', provider: 'Service', method: 'listService' },
    { agent: { id: 'session-1' } },
  )
  assert.equal(result.platform, 'host')
  assert.deepEqual(result.data.services, [])
})

test('host 查询：未知 provider 与未知 method 都明确报错', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx)
  const query = tools.get('cordis_inspect_query')
  const exec = { agent: { id: 'session-1' } }

  await assert.rejects(
    () => query.execute({ platform: 'host', provider: 'Nope', method: 'x' }, exec),
    /unknown host inspect provider "Nope"/,
  )
  await assert.rejects(
    () => query.execute({ platform: 'host', provider: 'Builtin', method: 'nope' }, exec),
    /unknown Builtin inspect method "nope"/,
  )
})

test('client 查询在没有 cordisInspect 服务时明确报错，而不是静默返回空', async () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx)
  ctx.cordisInspect = undefined

  await assert.rejects(
    () => tools.get('cordis_inspect_query').execute(
      { platform: 'client', provider: 'Slots', method: 'listSubTree' },
      { agent: { id: 'session-1' } },
    ),
    /client inspection is unavailable/,
  )
})
