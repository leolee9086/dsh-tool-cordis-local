#!/usr/bin/env node
/**
 * 零依赖构建：src/index.js → lib/index.js。
 *
 * 顺序是刻意的：先做完所有校验，全部通过才写产物。任何一项失败就直接抛错退出，
 * lib/ 保持原样 —— 不会留下一个半成品产物给安装方用。
 *
 * 校验三件事：
 * 1. 运行时零依赖：只允许 node: 内置模块和相对路径，出现裸包名 import 就拒绝；
 * 2. 不要把开发机的绝对路径写进仓库；
 * 3. 作为 ESM 真跑一遍，确认 name / inject / apply 契约成立。
 */
import { copyFileSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'src', 'index.js')
const TARGET = join(root, 'lib', 'index.js')

/** 插件对外契约，与 README 的「运行时契约」一节一一对应。 */
const EXPECTED = {
  name: 'dsh-tool-cordis-local',
  inject: ['tools', 'systemPrompt', 'dynamicCordisRunner', 'cordisInspect'],
}

const source = readFileSync(SOURCE, 'utf8')

// 1. 裸包名 import 会让安装方装不上，必须拦住。
const bareImport = /^\s*import\s[^\n]*from\s*['"](?!node:|\.)/m.exec(source)
if (bareImport !== null) {
  throw new Error(`src/index.js imports a bare package: ${bareImport[0].trim()}`)
}

// 2. 绝对路径写进仓库，别人 clone 下来就是坏的。
const absolutePath = /[A-Za-z]:[\\/]{1,2}(?:dev|Users)[\\/]/i.exec(source)
if (absolutePath !== null) {
  throw new Error(`src/index.js contains a local absolute path: ${absolutePath[0]}`)
}

// 3. 真跑一遍：import 成功，且导出的形状符合契约。
const mod = await import(pathToFileURL(SOURCE).href)
if (mod.name !== EXPECTED.name) throw new Error(`expected name "${EXPECTED.name}", got ${String(mod.name)}`)
if (typeof mod.apply !== 'function') throw new Error('the plugin must export apply()')
if (JSON.stringify(mod.inject) !== JSON.stringify(EXPECTED.inject)) {
  throw new Error(`expected inject ${JSON.stringify(EXPECTED.inject)}, got ${JSON.stringify(mod.inject)}`)
}

// 校验全过，这才写产物：逐字节拷贝，不做任何改写。
copyFileSync(SOURCE, TARGET)

const digest = createHash('sha256').update(readFileSync(TARGET)).digest('hex').slice(0, 12)
const bytes = statSync(TARGET).size
console.log(`built lib/index.js from src/index.js — ${bytes} bytes, sha256:${digest}`)
