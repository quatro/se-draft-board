import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'sedb-')), 't.db')
const { extract, verifySignature, storeRegistration, processRegistration } = await import('../src/lib/sportsengine.js')
const L = await import('../src/lib/league.js')
const { db } = await import('../src/db.js')
const { leagueAge, nameKey } = await import('../src/lib/text.js')

test('extract prefers the participant over the guardian', () => {
  const x = extract({
    id: 'evt_1', type: 'registration.completed',
    data: { guardian: { first_name: 'Pat', last_name: 'Smith' }, participant: { first_name: 'Jamie', last_name: 'Smith', date_of_birth: '3/14/2015', profile_id: 99 }, registration: { name: '2027 Spring Baseball' } },
  })
  assert.equal(x.firstName, 'Jamie')
  assert.equal(x.lastName, 'Smith')
  assert.equal(x.birthdate, '2015-03-14')
  assert.equal(x.regYear, 2027)
  assert.equal(x.seProfileId, '99')
  assert.equal(x.cancelled, false)
})

test('signature accepts hex or base64, with or without sha256= prefix', () => {
  const raw = Buffer.from('{"a":1}')
  const mac = createHmac('sha256', 's3cret').update(raw)
  const hex = mac.digest('hex')
  assert.ok(verifySignature(raw, hex, 's3cret'))
  assert.ok(verifySignature(raw, `sha256=${hex}`, 's3cret'))
  assert.ok(verifySignature(raw, Buffer.from(hex, 'hex').toString('base64'), 's3cret'))
  assert.ok(!verifySignature(raw, hex, 'other'))
})

test('names normalise for matching', () => {
  assert.equal(nameKey("  O'Brien-Smith Jr. "), 'obrien smith')
  assert.equal(leagueAge('2015-04-30', 2027), 12)
  assert.equal(leagueAge('2015-05-01', 2027), 11)
})

test('a registration flips the matched player to Registered, honouring locks and year', () => {
  db.prepare(`INSERT INTO teams (id, name, draft_order) VALUES ('reds','Reds',1)`).run()
  const kid = L.upsertPlayer(null, { name: 'Jamie Smith', kind: 'pool' }, 't')
  const locked = L.upsertPlayer(null, { name: 'Lee Jones', kind: 'returning', teamId: 'reds', status: 'Verbal commit', locked: true }, 't')
  const gone = L.upsertPlayer(null, { name: 'Kai Lane', kind: 'returning', teamId: 'reds', status: 'Not returning' }, 't')

  const run = (p: object) => processRegistration(storeRegistration('webhook', p, true).id)
  assert.equal(run({ participant: { first_name: 'jamie', last_name: 'SMITH' }, season: '2027' }).outcome, 'matched')
  assert.equal(L.getPlayer(kid.id)!.status, 'Registered')
  assert.equal(L.getPlayer(kid.id)!.status_source, 'sportsengine')

  assert.equal(run({ participant: { first_name: 'Lee', last_name: 'Jones' }, season: '2027' }).outcome, 'locked')
  assert.equal(L.getPlayer(locked.id)!.status, 'Verbal commit')

  assert.equal(run({ participant: { first_name: 'Kai', last_name: 'Lane' }, season: '2027' }).outcome, 'locked')
  assert.equal(run({ participant: { first_name: 'Nobody', last_name: 'Here' }, season: '2027' }).outcome, 'unmatched')
  assert.equal(run({ participant: { first_name: 'Jamie', last_name: 'Smith' }, season: '2026' }).outcome, 'wrong_year')

  // Duplicate delivery of the same event id is not stored twice.
  const a = storeRegistration('webhook', { id: 'e1', participant: { first_name: 'A', last_name: 'B' } }, true)
  const b = storeRegistration('webhook', { id: 'e1', participant: { first_name: 'A', last_name: 'B' } }, true)
  assert.equal(b.duplicate, true)
  assert.equal(a.id, b.id)
})

test('picks follow the board and reject bad players', () => {
  L.setSettings({ rosterSize: 2 })
  const p1 = L.upsertPlayer(null, { name: 'Pool One', kind: 'pool' }, 't')
  const r = L.makePick(p1.id, 't')
  assert.equal(r.slot.team, 'reds')
  assert.throws(() => L.makePick(p1.id, 't'), /already been drafted|complete/)
  L.undoLast('t')
  assert.equal(L.picks().length, 0)
})
