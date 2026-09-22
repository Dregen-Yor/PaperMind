import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const installer = resolve('scripts/install.sh')
const linuxOnly = { skip: process.platform === 'win32' }

// 假 AppImage：自行实现 --appimage-extract，不依赖网络、FUSE 或真实构建产物
const withIcon = '#!/usr/bin/env bash\nset -eu\ntest "$1" = --appimage-extract\nmkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps\nprintf "\\211PNG\\r\\n\\032\\nfixture" > squashfs-root/usr/share/icons/hicolor/512x512/apps/com.papermind.app.png\n'
const pngFixture = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')])

const desktopOf = data => join(data, 'applications/com.papermind.app.desktop')
const iconOf = data => join(data, 'icons/hicolor/512x512/apps/com.papermind.app.png')

function writeFile(path, content) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function install(image, bin, data) {
  // HOME 指向 fixture 临时目录：即使 guard 失效导致 source 执行了安装流程，也不会写到真实用户目录
  return spawnSync('bash', ['-c', 'source "$1"; install_linux_appimage "$2" "$3" "$4"', 'test', installer, image, bin, data], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dirname(image) },
  })
}

function fixture(prefix, binName, dataName) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const image = join(root, 'input.AppImage')
  const bin = join(root, binName)
  const data = join(root, dataName)
  writeFileSync(image, withIcon, { mode: 0o755 })
  return { root, image, bin, data }
}

// desktop 规范对 Exec 值分两层还原：先通用转义（\\ \s \n \t \r），再引号规则（\" \$ \` \\），最后 %% 还原字面 %
function decodeExec(execValue) {
  const quoted = execValue.match(/^"(.*)" %U$/s)
  assert.ok(quoted, `无法解析的 Exec 值：${execValue}`)
  return quoted[1]
    .replace(/\\([\\snrt])/g, (_, char) => ({ '\\': '\\', s: ' ', n: '\n', t: '\t', r: '\r' }[char]))
    .replace(/\\([\\"`$])/g, (_, char) => char)
    .replace(/%%/g, '%')
}

test('Linux install persists icon and quotes a spaced executable path', linuxOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'Paper Mind install-'))
  const image = join(root, 'input.AppImage')
  const bin = join(root, 'my bin')
  const data = join(root, 'my data')
  writeFileSync(image, withIcon, { mode: 0o755 })
  // 旧安装器留下的未品牌入口，以及一个同名但属于其他程序的入口
  const legacy = join(data, 'applications/papermind.desktop')
  const unrelated = join(data, 'applications/another.desktop')
  writeFile(legacy, `Name=PaperMind\nExec=${join(bin, 'papermind.AppImage')}\n`)
  writeFile(unrelated, 'Name=Another\nExec=/usr/bin/another\n')
  try {
    const result = install(image, bin, data)
    assert.equal(result.status, 0, result.stderr)
    const desktop = readFileSync(desktopOf(data), 'utf8')
    assert.ok(desktop.includes(`Exec="${join(bin, 'papermind.AppImage')}" %U`))
    assert.ok(desktop.includes('Icon=com.papermind.app\n'))
    assert.ok(desktop.includes('StartupWMClass=com.papermind.app\n'))
    assert.ok(existsSync(iconOf(data)))
    assert.ok(readFileSync(iconOf(data)).equals(pngFixture), '图标必须是 AppImage 中提取出的原始字节')
    assert.ok(!desktop.includes('squashfs-root'))
    assert.deepEqual(readdirSync(bin), ['papermind.AppImage'], '提取目录不能残留在安装目录里')
    assert.ok(readFileSync(join(bin, 'papermind.AppImage')).equals(readFileSync(image)), '安装产物是源 AppImage 的副本')
    assert.equal(existsSync(legacy), false)
    assert.equal(readFileSync(unrelated, 'utf8'), 'Name=Another\nExec=/usr/bin/another\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const exitCode of [0, 7]) {
  test(`extraction exit ${exitCode} without an icon preserves existing installation`, linuxOnly, () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-install-fail-'))
    const image = join(root, 'input.AppImage')
    const bin = join(root, 'bin')
    const data = join(root, 'data')
    const oldDesktop = join(data, 'applications/com.papermind.app.desktop')
    const oldIcon = join(data, 'icons/hicolor/512x512/apps/com.papermind.app.png')
    const oldBinary = join(bin, 'papermind.AppImage')
    for (const [file, content] of [[oldDesktop, 'old entry'], [oldIcon, 'old icon'], [oldBinary, 'old binary']]) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, content)
    }
    writeFileSync(image, `#!/usr/bin/env bash\nexit ${exitCode}\n`, { mode: 0o755 })
    try {
      const result = install(image, bin, data)
      assert.notEqual(result.status, 0)
      // exit 0 却没有图标时必须由安装器给出明确错误；exit 7 的静默失败只看状态码
      if (exitCode === 0) assert.match(result.stderr, /缺少 512px 品牌图标/)
      assert.equal(readFileSync(oldDesktop, 'utf8'), 'old entry')
      assert.equal(readFileSync(oldIcon, 'utf8'), 'old icon')
      assert.equal(readFileSync(oldBinary, 'utf8'), 'old binary')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('an unrelated papermind.desktop is left untouched', linuxOnly, () => {
  const { root, image, bin, data } = fixture('pm-install-keep-', 'bin', 'data')
  const unrelated = join(data, 'applications/papermind.desktop')
  writeFile(unrelated, 'Name=Other\nExec=/other/app\n')
  try {
    const result = install(image, bin, data)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(desktopOf(data)))
    assert.equal(readFileSync(unrelated, 'utf8'), 'Name=Other\nExec=/other/app\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the Exec value round-trips a path with %, $, quotes, backtick, backslash and spaces', linuxOnly, () => {
  const { root, image, bin, data } = fixture('pm-install-special-', 'weird %$"`\\ 中文 bin', 'my data')
  try {
    const result = install(image, bin, data)
    assert.equal(result.status, 0, result.stderr)
    const line = readFileSync(desktopOf(data), 'utf8').split('\n').find(entry => entry.startsWith('Exec='))
    assert.ok(line, 'desktop 文件缺少 Exec')
    assert.ok(line.endsWith(' %U'), line)
    assert.equal(decodeExec(line.slice('Exec='.length)), join(bin, 'papermind.AppImage'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const validatorSkip = process.platform === 'win32'
  ? 'Windows 不执行 Bash 安装器'
  : spawnSync('sh', ['-c', 'command -v desktop-file-validate'], { encoding: 'utf8' }).status === 0
    ? false
    : '本机没有 desktop-file-validate'

test('the generated desktop entry passes desktop-file-validate', { skip: validatorSkip }, () => {
  const { root, image, bin, data } = fixture('pm-install-validate-', 'weird %$"`\\ 中文 bin', 'my data')
  try {
    const result = install(image, bin, data)
    assert.equal(result.status, 0, result.stderr)
    const check = spawnSync('desktop-file-validate', [desktopOf(data)], { encoding: 'utf8' })
    const output = `${check.stdout}${check.stderr}`
    // 各版本对“只有警告”时是否非零退出不一致，因此断言没有任何 error，且非零退出必须带校验器说明
    assert.doesNotMatch(output, /error:/, output)
    assert.ok(check.status === 0 || /warning:/.test(output), `desktop-file-validate 以 ${check.status} 退出：${output}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('install directories containing a newline are rejected before any write', linuxOnly, () => {
  for (const broken of ['bin', 'data']) {
    const root = mkdtempSync(join(tmpdir(), 'pm-install-newline-'))
    const image = join(root, 'input.AppImage')
    const bin = join(root, broken === 'bin' ? 'line\nbreak' : 'bin')
    const data = join(root, broken === 'data' ? 'line\nbreak' : 'data')
    writeFileSync(image, withIcon, { mode: 0o755 })
    try {
      const result = install(image, bin, data)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /换行/)
      assert.equal(existsSync(bin), false, '拒绝时不能在安装目录下创建任何东西')
      assert.equal(existsSync(data), false, '拒绝时不能在数据目录下创建任何东西')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('a relative XDG_DATA_HOME is rejected instead of installing into the working directory', linuxOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-install-xdg-'))
  const fakePath = join(root, 'fake path')
  mkdirSync(fakePath)
  // 只提供 uname 的假 PATH：平台检测走 Linux 分支，且任何外链命令（curl）都不存在
  writeFileSync(join(fakePath, 'uname'), '#!/bin/sh\ncase "$1" in\n  -s) printf "Linux\\n" ;;\n  -m) printf "x86_64\\n" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 })
  try {
    // PATH 只能在 shell 内部收窄：Node 用子进程的 PATH 查找 bash 自身
    const result = spawnSync('bash', ['-c', 'PATH="$1"; export PATH; exec "$BASH" "$2"', 'test', fakePath, installer], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: root, XDG_DATA_HOME: 'my data' },
    })
    assert.notEqual(result.status, 0)
    // 脚本里既有的 red() 错误输出走 stdout
    assert.match(result.stdout + result.stderr, /XDG_DATA_HOME/)
    assert.equal(existsSync(join(root, 'my data')), false, '相对数据目录不能落在 cwd 下')
    assert.deepEqual(readdirSync(root), ['fake path'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sourcing the installer defines functions without running it', linuxOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-install-source-'))
  const fakePath = join(root, 'fake path')
  mkdirSync(fakePath)
  try {
    // PATH 里没有任何外部命令：source 时若执行安装流程会立刻失败
    const result = spawnSync('bash', ['-c', 'PATH="$1"; export PATH; source "$2"; type -t install_linux_appimage; type -t main', 'test', fakePath, installer], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'function\nfunction\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a piped invocation still reaches main', linuxOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-install-pipe-'))
  const fakePath = join(root, 'fake path')
  mkdirSync(fakePath)
  try {
    // 模拟 curl | bash：stdin 是管道，且 PATH 里没有任何外部命令。
    // guard 失效（main 从不执行）会静默成功；漏掉 :- 回退则在 set -u 下报 unbound variable。
    const result = spawnSync('bash', ['-c', 'cat "$2" | env PATH="$1" "$BASH"', 'test', fakePath, installer], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /command not found/)
    assert.doesNotMatch(result.stderr, /unbound variable/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
