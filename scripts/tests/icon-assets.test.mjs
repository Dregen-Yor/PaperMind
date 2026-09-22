import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { checkIcons, encodeIcns, encodeIco, generateIcons, renderIcon } from '../lib/icon-assets.mjs'

const svg = await readFile(new URL('../../assets/papermind-icon.svg', import.meta.url))

test('mac icon has transparent padding and a centered opaque body', async () => {
  const png = await renderIcon(svg, 1024, 0.92)
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alpha = (x, y) => data[(y * info.width + x) * 4 + 3]
  assert.equal(info.width, 1024)
  assert.equal(info.height, 1024)
  assert.equal(alpha(512, 0), 0)
  assert.equal(alpha(0, 512), 0)
  assert.equal(alpha(512, 512), 255)
  const body = []
  for (let x = 0; x < 1024; x++) if (alpha(x, 512) > 0) body.push(x)
  assert.ok(body[0] >= 97 && body[0] <= 99)
  assert.ok(Math.abs(body[0] - (1023 - body.at(-1))) <= 1)
})

test('ICO stores every requested resolution with valid PNG offsets', async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = await Promise.all(sizes.map(async size => ({ size, png: await renderIcon(svg, size, 1) })))
  const ico = encodeIco(images)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), sizes.length)
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 16
    const offset = ico.readUInt32LE(entry + 12)
    const length = ico.readUInt32LE(entry + 8)
    const metadata = await sharp(ico.subarray(offset, offset + length)).metadata()
    assert.equal(metadata.width, sizes[i])
    assert.equal(metadata.height, sizes[i])
    assert.equal(ico[entry], sizes[i] === 256 ? 0 : sizes[i])
  }
})

test('ICNS contains full-size PNG representations', async () => {
  const sizes = [16, 32, 64, 128, 256, 512, 1024]
  const images = await Promise.all(sizes.map(async size => ({ size, png: await renderIcon(svg, size, 0.92) })))
  const icns = encodeIcns(images)
  assert.equal(icns.toString('ascii', 0, 4), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  let offset = 8
  const decoded = []
  while (offset < icns.length) {
    const length = icns.readUInt32BE(offset + 4)
    assert.ok(length > 8 && offset + length <= icns.length)
    decoded.push((await sharp(icns.subarray(offset + 8, offset + length)).metadata()).width)
    offset += length
  }
  assert.equal(offset, icns.length)
  assert.deepEqual(decoded, sizes)
})

test('generated icons pass the checker and corrupted artifacts fail it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-icons-'))
  try {
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'assets/papermind-icon.svg'), svg)
    await generateIcons(root)
    await checkIcons(root)
    await writeFile(join(root, 'assets/icons/win.ico'), Buffer.from('invalid'))
    await assert.rejects(checkIcons(root), /win\.ico/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
