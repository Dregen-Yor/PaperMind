import { it, expect } from 'vitest'
import { parseArgs } from '../args'
it('requires explicit prepare split and output and rejects old flags', () => {
  expect(() => parseArgs(['--judge'])).toThrow()
  expect(() => parseArgs(['prepare', '--out', 'm.json'])).toThrow()
  expect(parseArgs(['prepare', '--split', 'dev', '--out', 'm.json'])).toMatchObject({ command: 'prepare', split: 'dev', root: 'dataset' })
})
it('defaults to five methods, accepts D, and rejects duplicate or unknown methods', () => {
  expect(parseArgs(['run', '--manifest', 'm.json', '--out', 'run'])).toMatchObject({ command: 'run', methods: ['A', 'B', 'C', 'D', 'R'] })
  expect(parseArgs(['run', '--manifest', 'm', '--out', 'r', '--methods', 'D'])).toMatchObject({ methods: ['D'] })
  expect(() => parseArgs(['run', '--manifest', 'm', '--out', 'r', '--methods', 'A,A'])).toThrow()
  expect(() => parseArgs(['run', '--manifest', 'm', '--out', 'r', '--methods', 'Z'])).toThrow()
  expect(parseArgs(['report', '--run', 'r'])).toEqual({ command: 'report', run: 'r' })
})
it('accepts explicit E configurations and rejects unsupported k values', () => {
  expect(parseArgs(['run', '--manifest', 'm', '--out', 'r', '--methods', 'E-bm25-k3,E-dense-k3,E-hybrid-k1,E-hybrid-k3,E-hybrid-k5']))
    .toMatchObject({ methods: ['E-bm25-k3', 'E-dense-k3', 'E-hybrid-k1', 'E-hybrid-k3', 'E-hybrid-k5'] })
  expect(() => parseArgs(['run', '--manifest', 'm', '--out', 'r', '--methods', 'E-hybrid-k0'])).toThrow(/Unknown method/)
})
