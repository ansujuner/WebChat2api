#!/usr/bin/env node
'use strict'

// Verify the unpacked app against its build inputs before releasing its installers.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const LEGAL_FILES = ['LICENSE', 'NOTICE', 'MODIFICATIONS.md', 'THIRD_PARTY_ASSETS.md']
const WASM_FILE = 'sha3_wasm_bg.7b9ca65ddd.wasm'
const FORBIDDEN_PART = /^(?:node_modules|src|tests?|\.git|\.audit-cache|artifacts|coverage|logs?|profiles?|browser-profiles?|user-?data|\.chat2api|\.env(?:\..*)?|accounts\.json|cookies(?:\.sqlite)?|local storage|session storage)$/i

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function validateTarget(platform, arch) {
  check(['darwin', 'linux'].includes(platform), `Unsupported platform: ${platform}`)
  check(['x64', 'arm64'].includes(arch), `Unsupported architecture: ${arch}`)
}

function safeEntry(name) {
  const parts = name.split('/')
  check(parts.every((part) => part && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes(':')), `Unsafe package path: ${name}`)
  check(!parts.some((part) => FORBIDDEN_PART.test(part)), `Forbidden package artifact: ${name}`)
  check(!/\.(?:map|log|bak|pem|key|p12|pfx)$/i.test(name), `Forbidden package artifact: ${name}`)
  return name
}

function regularFile(file) {
  check(fs.lstatSync(file).isFile(), `Expected regular file (no symlinks): ${file}`)
}

function listFiles(root) {
  check(fs.lstatSync(root).isDirectory(), `Expected directory (no symlinks): ${root}`)
  const files = []
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      safeEntry(relative)
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute, relative)
      else {
        check(entry.isFile(), `Unsupported file or symlink: ${absolute}`)
        files.push(relative)
      }
    }
  }
  visit(root, '')
  return files.sort()
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex')
}

async function fileRecord(file, name = path.basename(file)) {
  regularFile(file)
  const size = fs.statSync(file).size
  check(size > 0, `Empty package file: ${file}`)
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return { name, path: file, size, sha256: hash.digest('hex') }
}

function packageLayout(source, platform, arch, metadata) {
  validateTarget(platform, arch)
  const product = metadata.build.productName
  check(typeof product === 'string' && product.length > 0 && !/[\\/:]/.test(product), 'Invalid productName')
  check(typeof metadata.name === 'string' && /^[a-z0-9._-]+$/.test(metadata.name), 'Invalid package name')
  const dist = path.join(source, metadata.build.directories?.output || 'dist')
  const directory = platform === 'darwin'
    ? path.join(dist, arch === 'arm64' ? 'mac-arm64' : 'mac', `${product}.app`, 'Contents')
    : path.join(dist, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked')
  const resources = path.join(directory, platform === 'darwin' ? 'Resources' : 'resources')
  const executable = platform === 'darwin'
    ? path.join(directory, 'MacOS', product)
    : path.join(directory, metadata.build.linux?.executableName || metadata.name)
  const prefix = `${product}-${metadata.version}-${platform === 'darwin' ? 'mac-' : ''}${arch}`
  const extensions = platform === 'darwin' ? ['dmg', 'zip'] : ['AppImage', 'deb', 'tar.gz']
  return { dist, resources, executable, asar: path.join(resources, 'app.asar'), assets: extensions.map((extension) => `${prefix}.${extension}`) }
}

function verifyExecutableHeader(header, platform, arch) {
  validateTarget(platform, arch)
  if (platform === 'darwin') {
    check(header.length >= 32 && header.readUInt32LE(0) === 0xfeedfacf, 'Expected a 64-bit little-endian Mach-O executable')
    const cpu = header.readUInt32LE(4)
    check(cpu === (arch === 'x64' ? 0x01000007 : 0x0100000c), `Mach-O architecture mismatch for ${arch}`)
    check(header.readUInt32LE(12) === 2, 'Mach-O file is not an executable')
    return { format: 'Mach-O64', arch, cpu }
  }
  check(header.length >= 64 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header[4] === 2 && header[5] === 1 && header[6] === 1, 'Expected a 64-bit little-endian ELF executable')
  const machine = header.readUInt16LE(18)
  check(machine === (arch === 'x64' ? 62 : 183), `ELF architecture mismatch for ${arch}`)
  check([2, 3].includes(header.readUInt16LE(16)), 'ELF file is not an executable or position-independent executable')
  return { format: 'ELF64', arch, machine }
}

function verifyAsar(archive, source, metadata, asar) {
  regularFile(archive)
  const sourceFiles = listFiles(path.join(source, 'out')).map((file) => `out/${file}`)
  check(sourceFiles.length > 0, 'Build output is empty')
  for (const required of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    check(sourceFiles.includes(required), `Missing required build entry: ${required}`)
  }
  const expected = new Set([...sourceFiles, 'package.json', ...LEGAL_FILES])
  const expectedDirectories = new Set()
  for (const name of expected) {
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'))
  }
  const actual = []
  function visit(files, prefix = '') {
    check(files && typeof files === 'object', 'Invalid ASAR directory header')
    for (const [name, entry] of Object.entries(files)) {
      const relative = safeEntry(prefix ? `${prefix}/${name}` : name)
      check(!('link' in entry) && !entry.unpacked, `ASAR links/unpacked files are not allowed: ${relative}`)
      if ('files' in entry) {
        check(expectedDirectories.has(relative), `Unexpected ASAR directory: ${relative}`)
        visit(entry.files, relative)
      } else {
        check(expected.has(relative), `Unexpected ASAR file: ${relative}`)
        actual.push(relative)
      }
    }
  }
  // Read a fresh header and discard the library cache, including during repeated checks.
  asar.uncache?.(archive)
  visit(asar.getRawHeader(archive).header.files)
  check(actual.length === expected.size, `ASAR file count mismatch: expected ${expected.size}, found ${actual.length}`)
  const records = []
  for (const name of [...expected].sort()) {
    check(actual.includes(name), `Missing ASAR file: ${name}`)
    const packaged = asar.extractFile(archive, path.join(...name.split('/')), false)
    if (name === 'package.json') {
      const packagedMetadata = JSON.parse(packaged.toString('utf8'))
      for (const key of ['name', 'version', 'main', 'license']) {
        check(packagedMetadata[key] === metadata[key], `Packaged package.json ${key} mismatch`)
      }
    } else {
      const original = path.join(source, ...name.split('/'))
      regularFile(original)
      check(packaged.equals(fs.readFileSync(original)), `Packaged bytes differ: ${name}`)
    }
    records.push({ name, size: packaged.length, sha256: digest(packaged) })
  }
  return { path: archive, files: records.length, buildFiles: sourceFiles.length, entries: records }
}

async function verifyPlatformPackage({ source, platform, arch }, dependencies = {}) {
  check(typeof source === 'string' && path.isAbsolute(source), '--source must be an absolute checkout directory')
  validateTarget(platform, arch)
  const root = fs.realpathSync(source)
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  check(typeof metadata.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version), 'Invalid package version')
  const layout = packageLayout(root, platform, arch, metadata)
  const asarLibrary = dependencies.asar || require(require.resolve('@electron/asar', { paths: [root] }))
  const archive = verifyAsar(layout.asar, root, metadata, asarLibrary)
  const sourceResources = [...listFiles(path.join(root, 'build')).map((file) => `build/${file}`), WASM_FILE]
  check(sourceResources.includes('build/icon.png') && sourceResources.includes('build/icon.ico'), 'Required build icons are missing')
  const resourceRecords = []
  for (const name of sourceResources) {
    const original = path.join(root, ...name.split('/'))
    const packaged = path.join(layout.resources, ...name.split('/'))
    regularFile(original)
    regularFile(packaged)
    check(fs.readFileSync(original).equals(fs.readFileSync(packaged)), `External resource bytes differ: ${name}`)
    resourceRecords.push(await fileRecord(packaged, name))
  }
  // Walk resources too: private data must not be hidden beside the archive.
  listFiles(layout.resources)
  regularFile(layout.executable)
  const fd = fs.openSync(layout.executable, 'r')
  const header = Buffer.alloc(64)
  let read
  try { read = fs.readSync(fd, header, 0, header.length, 0) } finally { fs.closeSync(fd) }
  const executable = { ...verifyExecutableHeader(header.subarray(0, read), platform, arch), ...await fileRecord(layout.executable) }
  const assets = []
  const actualAssets = fs.readdirSync(layout.dist).filter((name) => /\.(?:dmg|zip|AppImage|deb|tar\.gz)$/.test(name)).sort()
  check(JSON.stringify(actualAssets) === JSON.stringify([...layout.assets].sort()), `Unexpected or missing release assets: expected ${layout.assets.join(', ')}, found ${actualAssets.join(', ')}`)
  for (const name of layout.assets) assets.push(await fileRecord(path.join(layout.dist, name)))
  return { passed: true, platform, arch, version: metadata.version, source: root, asar: archive, resources: resourceRecords, executable, assets }
}

function parseArgs(args) {
  const result = {}
  const allowed = new Set(['source', 'platform', 'arch', 'output'])
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/, '')
    check(args[index].startsWith('--') && allowed.has(key) && !Object.hasOwn(result, key) && args[index + 1] && !args[index + 1].startsWith('--'), `Invalid argument: ${args[index]}`)
    result[key] = args[index + 1]
  }
  for (const key of allowed) check(result[key], `Missing --${key}`)
  check(path.isAbsolute(result.source), '--source must be an absolute checkout directory')
  check(path.isAbsolute(result.output) && result.output.endsWith('.json'), '--output must be an absolute JSON report path')
  validateTarget(result.platform, result.arch)
  return result
}

async function main(args) {
  const options = parseArgs(args)
  const report = await verifyPlatformPackage(options)
  const json = `${JSON.stringify(report, null, 2)}\n`
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  fs.writeFileSync(options.output, json, { flag: 'wx' })
  process.stdout.write(json)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Package verification failed: ${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { LEGAL_FILES, WASM_FILE, packageLayout, parseArgs, verifyExecutableHeader, verifyAsar, verifyPlatformPackage, main }
