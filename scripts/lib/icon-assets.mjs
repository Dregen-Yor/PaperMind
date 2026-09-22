import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const MAC_SIZES = [16, 32, 64, 128, 256, 512, 1024]
const MAC_SCALE = 0.82
const WIN_SIZES = [16, 24, 32, 48, 64, 128, 256]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]
const ICNS_TYPES = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']])

// 直接从矢量母版栅格化到目标尺寸，再居中合成到透明画布上
export async function renderIcon(svg, size, scale) {
  const inner = Math.round(size * scale)
  const png = await sharp(svg, { density: 288 }).resize(inner, inner).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([{ input: png, left: Math.floor((size - inner) / 2), top: Math.floor((size - inner) / 2) }])
    .png().toBuffer()
}

export function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const start = 6 + i * 16
    header[start] = size === 256 ? 0 : size
    header[start + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, start + 4)
    header.writeUInt16LE(32, start + 6)
    header.writeUInt32LE(png.length, start + 8)
    header.writeUInt32LE(offset, start + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(image => image.png)])
}

export function encodeIcns(images) {
  const chunks = images.map(({ size, png }) => {
    const type = ICNS_TYPES.get(size)
    if (!type) throw new Error(`Unsupported ICNS size: ${size}`)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns')
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}

export async function generateIcons(root) {
  const svg = await readFile(join(root, 'assets/papermind-icon.svg'))
  const out = join(root, 'assets/icons')
  await mkdir(join(out, 'linux'), { recursive: true })

  const mac = await Promise.all(MAC_SIZES.map(async size => ({ size, png: await renderIcon(svg, size, MAC_SCALE) })))
  await writeFile(join(out, 'mac.png'), mac.at(-1).png)
  await writeFile(join(out, 'mac.icns'), encodeIcns(mac))

  const win = await Promise.all(WIN_SIZES.map(async size => ({ size, png: await renderIcon(svg, size, 1) })))
  await writeFile(join(out, 'win.ico'), encodeIco(win))

  for (const size of LINUX_SIZES) {
    await writeFile(join(out, 'linux', `${size}x${size}.png`), await renderIcon(svg, size, 1))
  }
}

export async function checkIcons(root) {
  const out = join(root, 'assets/icons')
  const read = name => readFile(join(out, name))

  await withFilename('assets/icons/mac.png', async () => {
    const { data, info } = await decodePng(await read('mac.png'), 1024)
    const edges = [[info.width >> 1, 0], [0, info.height >> 1], [info.width - 1, info.height >> 1], [info.width >> 1, info.height - 1]]
    for (const [x, y] of edges) {
      if (data[(y * info.width + x) * 4 + 3] !== 0) throw new Error(`expected transparent edge pixel at ${x},${y}`)
    }
  })

  await withFilename('assets/icons/mac.icns', async () => {
    const icns = await read('mac.icns')
    if (icns.length < 8 || icns.toString('ascii', 0, 4) !== 'icns') throw new Error('missing icns magic')
    if (icns.readUInt32BE(4) !== icns.length) throw new Error(`declared length ${icns.readUInt32BE(4)} does not match ${icns.length} bytes`)
    let offset = 8
    for (const size of MAC_SIZES) {
      const type = ICNS_TYPES.get(size)
      if (offset + 8 > icns.length) throw new Error(`missing '${type}' chunk for ${size}px`)
      const chunkType = icns.toString('ascii', offset, offset + 4)
      const length = icns.readUInt32BE(offset + 4)
      if (chunkType !== type) throw new Error(`expected '${type}' chunk, got '${chunkType}'`)
      if (length <= 8 || offset + length > icns.length) throw new Error(`'${chunkType}' chunk has invalid length ${length}`)
      await decodePng(icns.subarray(offset + 8, offset + length), size)
      offset += length
    }
    if (offset !== icns.length) throw new Error(`unexpected trailing bytes after last chunk`)
  })

  await withFilename('assets/icons/win.ico', async () => {
    const ico = await read('win.ico')
    if (ico.length < 6 + 16 * WIN_SIZES.length) throw new Error(`truncated header: ${ico.length} bytes`)
    if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('unexpected ICO type')
    if (ico.readUInt16LE(4) !== WIN_SIZES.length) throw new Error(`expected ${WIN_SIZES.length} entries, got ${ico.readUInt16LE(4)}`)
    for (let i = 0; i < WIN_SIZES.length; i++) {
      const entry = 6 + i * 16
      const width = ico[entry] === 0 ? 256 : ico[entry]
      const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1]
      if (width !== WIN_SIZES[i] || height !== WIN_SIZES[i]) throw new Error(`entry ${i} is ${width}x${height}, expected ${WIN_SIZES[i]}px`)
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      if (length === 0 || offset + length > ico.length) throw new Error(`entry ${i} has out-of-bounds payload`)
      await decodePng(ico.subarray(offset, offset + length), WIN_SIZES[i])
    }
  })

  for (const size of LINUX_SIZES) {
    await withFilename(`assets/icons/linux/${size}x${size}.png`, async () => {
      await decodePng(await read(`linux/${size}x${size}.png`), size)
    })
  }
}

// 读取/解析失败统一带上文件名，便于定位损坏的产物
async function withFilename(filename, run) {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith(filename)) throw error
    throw new Error(`${filename}: ${message}`)
  }
}

async function decodePng(png, size) {
  const metadata = await sharp(png).metadata()
  if (metadata.width !== size || metadata.height !== size) {
    throw new Error(`expected ${size}x${size} PNG, got ${metadata.width}x${metadata.height}`)
  }
  if (metadata.hasAlpha !== true) throw new Error('expected PNG with an alpha channel')
  return sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}
