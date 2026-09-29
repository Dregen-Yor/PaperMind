import { it, expect } from 'vitest'
import { parseArgs } from '../args'
it('requires explicit prepare split and output and rejects old flags', () => {
  expect(() => parseArgs(['--judge'])).toThrow()
  expect(() => parseArgs(['prepare', '--out', 'm.json'])).toThrow()
  expect(parseArgs(['prepare', '--split', 'dev', '--out', 'm.json'])).toMatchObject({ command: 'prepare', split: 'dev', root: 'dataset' })
})
it('defaults to four methods and rejects duplicate or unknown methods', () => {
  expect(parseArgs(['run', '--manifest', 'm.json', '--out', 'run'])).toMatchObject({ command: 'run', methods: ['A', 'B', 'C', 'R'] })
  expect(() => parseArgs(['run', '--manifest', 'm', '--out', 'r', '--methods', 'A,A'])).toThrow()
  expect(() => parseArgs(['run', '--manifest', 'm', '--out', 'r', '--methods', 'Z'])).toThrow()
  expect(parseArgs(['report', '--run', 'r'])).toEqual({ command: 'report', run: 'r' })
})
