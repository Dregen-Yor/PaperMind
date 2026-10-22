import defaults from '../../config/runtime-security.json' with { type: 'json' }

export function nodeSecurityErrors(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) return ['Node.js 版本无效或属于预发布版本']
  const parts = version.split('.').map(Number)
  const minimum = defaults.minimumNodeByMajor[parts[0]]
  if (!minimum) return [`Node.js ${version} 不在已核验的安全版本分支中`]
  const floor = minimum.split('.').map(Number)
  if (parts[1] < floor[1] || (parts[1] === floor[1] && parts[2] < floor[2])) {
    return [`Node.js ${version} 尚未包含本批安全修复，需要至少 ${minimum}`]
  }
  return []
}

export function electronSecurityErrors(versions, expectedElectron, policy = defaults) {
  const errors = nodeSecurityErrors(versions.node)
  if (!versions.electron || versions.electron !== expectedElectron) errors.push('实际 Electron 运行时与锁定版本不一致')
  const approved = policy.approvedElectron.find(entry => entry.electron === versions.electron && entry.node === versions.node
    && /^https:\/\/(releases\.electronjs\.org|www\.electronjs\.org|github\.com\/electron\/electron)\//.test(entry.evidence))
  if (!approved) errors.push('该 Electron / Node 组合尚无经核验的官方修复记录，禁止打包与发布')
  return errors
}
