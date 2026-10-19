import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundOrder, slots } from '../src/lib/engine.js'

const base = { order: ['a', 'b', 'c'], mode: 'straight' as const, swap: ['', ''], rosterSize: 4, keepersByTeam: { a: 2, b: 1, c: 0 } }

test('teams owing more picks get compensation rounds', () => {
  const s = slots(base)
  assert.deepEqual(s.open, { a: 2, b: 3, c: 4 })
  assert.equal(s.list.length, 9)
  assert.deepEqual(s.list.filter((x) => x.round === 3).map((x) => x.team), ['b', 'c'])
  assert.deepEqual(s.list.filter((x) => x.round === 4).map((x) => x.team), ['c'])
  assert.ok(s.list.filter((x) => x.round > 2).every((x) => x.comp))
  assert.deepEqual(s.list.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('snake reverses even rounds; coin-flip pair swaps even rounds', () => {
  assert.deepEqual(roundOrder({ ...base, mode: 'snake' }, 2), ['c', 'b', 'a'])
  assert.deepEqual(roundOrder({ ...base, swap: ['a', 'b'] }, 2), ['b', 'a', 'c'])
  assert.deepEqual(roundOrder({ ...base, swap: ['a', 'b'] }, 3), ['a', 'b', 'c'])
})
