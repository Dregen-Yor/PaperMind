export interface QComponents {
  answerF1: number
  ttftP50: number
  ttftP95: number
}

export interface QConfig {
  schemaVersion: 1
  formula: 'weighted-geometric-relative-v1'
  baselineMode: 'full-context'
  weights: QComponents
}

const weightKeys: Array<keyof QComponents> = ['answerF1', 'ttftP50', 'ttftP95']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseQConfig(value: unknown): QConfig {
  if (!isRecord(value)) throw new Error('Q config must be an object')
  if (value.schemaVersion !== 1) throw new Error('Unsupported Q config schemaVersion')
  if (value.formula !== 'weighted-geometric-relative-v1') throw new Error('Unsupported Q formula')
  if (value.baselineMode !== 'full-context') throw new Error('Unsupported Q baselineMode')
  if (!isRecord(value.weights)) throw new Error('Q weights must be an object')

  const keys = Object.keys(value.weights)
  if (keys.length !== weightKeys.length || keys.some(key => !weightKeys.includes(key as keyof QComponents))) {
    throw new Error('Q weights must contain exactly answerF1, ttftP50, and ttftP95')
  }

  for (const key of weightKeys) {
    const weight = value.weights[key]
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Q weight ${key} must be a positive finite number`)
    }
  }

  const weights = {
    answerF1: value.weights.answerF1 as number,
    ttftP50: value.weights.ttftP50 as number,
    ttftP95: value.weights.ttftP95 as number,
  }
  const sum = weights.answerF1 + weights.ttftP50 + weights.ttftP95
  if (Math.abs(sum - 1) > 1e-9) throw new Error('Q weights must sum to 1')

  return {
    schemaVersion: 1,
    formula: 'weighted-geometric-relative-v1',
    baselineMode: 'full-context',
    weights,
  }
}

function validateComponents(components: QComponents, label: string): void {
  if (!Number.isFinite(components.answerF1) || components.answerF1 < 0 || components.answerF1 > 1) {
    throw new Error(`${label} answerF1 must be finite and between 0 and 1`)
  }
  if (!Number.isFinite(components.ttftP50) || components.ttftP50 <= 0) {
    throw new Error(`${label} ttftP50 must be a positive finite number`)
  }
  if (!Number.isFinite(components.ttftP95) || components.ttftP95 <= 0) {
    throw new Error(`${label} ttftP95 must be a positive finite number`)
  }
  if (components.ttftP95 < components.ttftP50) {
    throw new Error(`${label} ttftP95 must be at least ttftP50`)
  }
}

export function calculateQ(value: QComponents, reference: QComponents, config: QConfig): number {
  const validatedConfig = parseQConfig(config)
  validateComponents(value, 'Value')
  validateComponents(reference, 'Reference')
  if (reference.answerF1 === 0) throw new Error('Reference answerF1 must be greater than zero')
  if (value.answerF1 === 0) return 0

  const logScore =
    validatedConfig.weights.answerF1 * (Math.log(value.answerF1) - Math.log(reference.answerF1)) +
    validatedConfig.weights.ttftP50 * (Math.log(reference.ttftP50) - Math.log(value.ttftP50)) +
    validatedConfig.weights.ttftP95 * (Math.log(reference.ttftP95) - Math.log(value.ttftP95))
  const score = 100 * Math.exp(logScore)
  if (!Number.isFinite(score)) throw new Error('Q score must be finite')
  return score
}
