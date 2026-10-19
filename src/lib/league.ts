import { EventEmitter } from 'node:events'
import { config } from '../config.js'
import { db } from '../db.js'
import { slots, type EngineInput, type Mode } from './engine.js'
import { nameKey, STATUSES, uid, type Status } from './text.js'

// ---------- change feed ----------
// Every mutation bumps the version; connected boards refetch on the event.
export const bus = new EventEmitter()
bus.setMaxListeners(0)
let version = Date.now()
export function changed() {
  version++
  bus.emit('change', version)
}
export const currentVersion = () => version

// ---------- rows ----------
export interface Team { id: string; name: string; color: string; fg: string; draft_order: number }
export interface Player {
  id: string; name: string; name_key: string; age: number | null; birthdate: string | null
  kind: 'returning' | 'pool'; team_id: string | null; status: Status; status_locked: number
  status_source: string; rank: number | null; notes: string; se_profile_id: string | null
  se_registration_id: string | null; registered_at: string | null; created_at: string; updated_at: string
}
export interface Pick { slot_key: string; n: number; round: number; team_id: string; player_id: string; at: number; took_ms: number | null; actor: string | null }

export interface Settings {
  season: string; registrationYear: number; rosterSize: number; mode: Mode
  swap: [string, string]; ageCutoff: string; clockStart: number | null; startedAt: number | null
}

export function getSettings(): Settings {
  const o: Record<string, unknown> = {}
  for (const r of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) o[r.key] = JSON.parse(r.value)
  return o as unknown as Settings
}
const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
export function setSettings(patch: Partial<Settings>) {
  db.transaction(() => { for (const [k, v] of Object.entries(patch)) if (v !== undefined) setStmt.run(k, JSON.stringify(v)) })()
}

export const teams = () => db.prepare('SELECT * FROM teams ORDER BY draft_order').all() as Team[]
export const players = () => db.prepare('SELECT * FROM players ORDER BY name').all() as Player[]
export const picks = () => db.prepare('SELECT * FROM picks ORDER BY n').all() as Pick[]
export const getPlayer = (id: string) => db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player | undefined

export function audit(actor: string, action: string, playerId: string | null, detail: string | object = '') {
  db.prepare('INSERT INTO audit (actor, action, player_id, detail) VALUES (?, ?, ?, ?)')
    .run(actor, action, playerId, typeof detail === 'string' ? detail : JSON.stringify(detail))
}

// ---------- board ----------
function engineInput(s = getSettings(), ts = teams(), ps = players()): EngineInput {
  const keepersByTeam: Record<string, number> = {}
  for (const p of ps) if (p.kind === 'returning' && p.team_id && p.status !== 'Not returning') keepersByTeam[p.team_id] = (keepersByTeam[p.team_id] ?? 0) + 1
  return { order: ts.map((t) => t.id), mode: s.mode, swap: s.swap, rosterSize: s.rosterSize, keepersByTeam }
}

export function board() {
  const s = getSettings(), ts = teams(), ps = players(), pk = picks()
  const sl = slots(engineInput(s, ts, ps))
  const byKey = new Map(pk.map((p) => [p.slot_key, p]))
  const valid = new Set(sl.list.map((x) => x.key))
  const current = sl.list.find((x) => !byKey.has(x.key)) ?? null
  // Picks whose slot no longer exists (e.g. a "Not returning" player was flipped
  // back after the draft started, so that team owes one fewer pick).
  const orphans = pk.filter((p) => !valid.has(p.slot_key))
  return { settings: s, teams: ts, players: ps, picks: pk, slots: sl, current, orphans }
}

/** Shape sent to browsers. Eval notes and SportsEngine ids are admin-only. */
export function publicState(isAdmin: boolean) {
  const b = board()
  const { clockStart, startedAt, ...settings } = b.settings
  return {
    version,
    canWrite: isAdmin,
    serverNow: Date.now(),
    links: { registration: config.registrationUrl || null },
    settings,
    clock: { clockStart, startedAt },
    teams: b.teams.map(({ id, name, color, fg }) => ({ id, name, color, fg })),
    players: b.players.map((p) => ({
      id: p.id, name: p.name, age: p.age, kind: p.kind, teamId: p.team_id, status: p.status, rank: p.rank,
      ...(isAdmin ? {
        notes: p.notes, locked: !!p.status_locked, statusSource: p.status_source, birthdate: p.birthdate,
        seProfileId: p.se_profile_id, seRegistrationId: p.se_registration_id, registeredAt: p.registered_at,
      } : {}),
    })),
    picks: b.picks.map((p) => ({ key: p.slot_key, n: p.n, round: p.round, team: p.team_id, player: p.player_id, at: p.at, took: p.took_ms })),
    slots: b.slots.list,
    open: b.slots.open,
    maxRound: b.slots.max,
    minRound: b.slots.min,
    current: b.current,
    orphans: b.orphans.map((p) => p.slot_key),
  }
}

// ---------- mutations ----------
export class UserError extends Error {}

export function makePick(playerId: string, actor: string, slotKey?: string) {
  const res = db.transaction(() => {
    const b = board()
    const slot = slotKey ? b.slots.list.find((x) => x.key === slotKey) : b.current
    if (!slot) throw new UserError(slotKey ? 'That pick slot does not exist' : 'The draft is complete')
    if (b.picks.some((p) => p.slot_key === slot.key)) throw new UserError('That pick has already been made')
    const p = b.players.find((x) => x.id === playerId)
    if (!p) throw new UserError('Unknown player')
    if (p.kind !== 'pool') throw new UserError(`${p.name} is a returning player, not in the draft pool`)
    if (p.status === 'Not returning') throw new UserError(`${p.name} is marked Not returning`)
    if (b.picks.some((x) => x.player_id === playerId)) throw new UserError(`${p.name} has already been drafted`)
    const now = Date.now()
    const cs = b.settings.clockStart
    db.prepare('INSERT INTO picks (slot_key, n, round, team_id, player_id, at, took_ms, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(slot.key, slot.n, slot.round, slot.team, p.id, now, cs ? now - cs : null, actor)
    setSettings({ clockStart: now, startedAt: b.settings.startedAt ?? now })
    audit(actor, 'pick', p.id, { slot: slot.key, n: slot.n, team: slot.team })
    return { slot, player: p, team: b.teams.find((t) => t.id === slot.team)! }
  })()
  changed()
  return res
}

export function undoLast(actor: string) {
  const last = db.prepare('SELECT * FROM picks ORDER BY at DESC LIMIT 1').get() as Pick | undefined
  if (!last) throw new UserError('No picks to undo')
  removePick(last.slot_key, actor)
}

export function removePick(slotKey: string, actor: string) {
  const p = db.prepare('SELECT * FROM picks WHERE slot_key = ?').get(slotKey) as Pick | undefined
  if (!p) throw new UserError('No pick in that slot')
  db.prepare('DELETE FROM picks WHERE slot_key = ?').run(slotKey)
  setSettings({ clockStart: Date.now() })
  audit(actor, 'pick_removed', p.player_id, { slot: slotKey, n: p.n })
  changed()
}

export function replacePick(slotKey: string, playerId: string, actor: string) {
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM picks WHERE slot_key = ?').get(slotKey) as Pick | undefined
    if (!p) throw new UserError('No pick in that slot')
    const np = getPlayer(playerId)
    if (!np || np.kind !== 'pool') throw new UserError('Pick a player from the draft pool')
    if (db.prepare('SELECT 1 FROM picks WHERE player_id = ? AND slot_key <> ?').get(playerId, slotKey)) throw new UserError(`${np.name} is already drafted`)
    db.prepare('UPDATE picks SET player_id = ?, actor = ? WHERE slot_key = ?').run(playerId, actor, slotKey)
    audit(actor, 'pick_replaced', playerId, { slot: slotKey, previous: p.player_id })
  })()
  changed()
}

export function clearPicks(actor: string) {
  const n = db.prepare('DELETE FROM picks').run().changes
  setSettings({ clockStart: null, startedAt: null })
  audit(actor, 'picks_cleared', null, { count: n })
  changed()
}

export function startClock(actor: string) {
  const s = getSettings(), now = Date.now()
  setSettings({ clockStart: now, startedAt: s.startedAt ?? now })
  audit(actor, 'clock_started', null)
  changed()
}

export interface PlayerInput {
  name?: string; age?: number | null; birthdate?: string | null; kind?: 'returning' | 'pool'; teamId?: string | null
  status?: Status; locked?: boolean; rank?: number | null; notes?: string; seProfileId?: string | null
}

export function upsertPlayer(id: string | null, inp: PlayerInput, actor: string): Player {
  const out = db.transaction(() => {
    const cur = id ? getPlayer(id) : undefined
    if (id && !cur) throw new UserError('Unknown player')
    const next = {
      name: (inp.name ?? cur?.name ?? '').trim(),
      age: inp.age !== undefined ? inp.age : cur?.age ?? null,
      birthdate: inp.birthdate !== undefined ? inp.birthdate : cur?.birthdate ?? null,
      kind: inp.kind ?? cur?.kind ?? 'pool',
      team_id: inp.teamId !== undefined ? inp.teamId || null : cur?.team_id ?? null,
      status: inp.status ?? cur?.status ?? 'Not registered',
      status_locked: inp.locked !== undefined ? (inp.locked ? 1 : 0) : cur?.status_locked ?? 0,
      rank: inp.rank !== undefined ? inp.rank : cur?.rank ?? null,
      notes: inp.notes ?? cur?.notes ?? '',
      se_profile_id: inp.seProfileId !== undefined ? inp.seProfileId || null : cur?.se_profile_id ?? null,
    }
    if (!next.name) throw new UserError('Name is required')
    if (!STATUSES.includes(next.status)) throw new UserError('Unknown status')
    if (next.kind === 'returning' && !next.team_id) throw new UserError('Returning players need a team')
    if (next.kind === 'pool') next.team_id = null
    if (next.team_id && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(next.team_id)) throw new UserError('Unknown team')
    if (next.se_profile_id) {
      const other = db.prepare('SELECT name FROM players WHERE se_profile_id = ? AND id <> ?').get(next.se_profile_id, id ?? '') as { name: string } | undefined
      if (other) throw new UserError(`SportsEngine id already linked to ${other.name}`)
    }
    if (cur && cur.kind === 'pool' && next.kind === 'returning' && db.prepare('SELECT 1 FROM picks WHERE player_id = ?').get(cur.id))
      throw new UserError(`${cur.name} has been drafted — remove the pick first`)
    const statusChanged = !cur || cur.status !== next.status
    const pid = id ?? uid()
    if (cur) {
      db.prepare(`UPDATE players SET name=@name, name_key=@name_key, age=@age, birthdate=@birthdate, kind=@kind, team_id=@team_id,
        status=@status, status_locked=@status_locked, rank=@rank, notes=@notes, se_profile_id=@se_profile_id,
        status_source = CASE WHEN @statusChanged THEN 'manual' ELSE status_source END, updated_at=datetime('now') WHERE id=@id`)
        .run({ ...next, name_key: nameKey(next.name), id: pid, statusChanged: statusChanged ? 1 : 0 })
      const diff: Record<string, [unknown, unknown]> = {}
      for (const k of Object.keys(next) as (keyof typeof next)[]) if (cur[k] !== next[k]) diff[k] = [cur[k], next[k]]
      if (Object.keys(diff).length) audit(actor, 'player_updated', pid, diff)
    } else {
      db.prepare(`INSERT INTO players (id, name, name_key, age, birthdate, kind, team_id, status, status_locked, rank, notes, se_profile_id)
        VALUES (@id, @name, @name_key, @age, @birthdate, @kind, @team_id, @status, @status_locked, @rank, @notes, @se_profile_id)`)
        .run({ ...next, name_key: nameKey(next.name), id: pid })
      audit(actor, 'player_added', pid, { name: next.name, kind: next.kind, team: next.team_id })
    }
    return getPlayer(pid)!
  })()
  changed()
  return out
}

export function deletePlayer(id: string, actor: string) {
  const p = getPlayer(id)
  if (!p) throw new UserError('Unknown player')
  if (db.prepare('SELECT 1 FROM picks WHERE player_id = ?').get(id)) throw new UserError(`${p.name} has been drafted — remove the pick first`)
  db.prepare('DELETE FROM players WHERE id = ?').run(id)
  audit(actor, 'player_deleted', null, { id, name: p.name })
  changed()
}

/** Bulk paste: "3. Name, Age, notes" per line, as in the original artifact. */
export function importPool(text: string, actor: string) {
  const have = new Set((db.prepare('SELECT name_key FROM players').all() as { name_key: string }[]).map((r) => r.name_key))
  const added: string[] = []
  const ins = db.prepare(`INSERT INTO players (id, name, name_key, age, kind, rank, notes) VALUES (?, ?, ?, ?, 'pool', ?, ?)`)
  db.transaction(() => {
    for (let line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      let rank: number | null = null
      const m = /^(\d+)[.)]\s*(.*)$/.exec(line)
      if (m) { rank = +m[1]!; line = m[2]! }
      const parts = line.split(/\t|,/).map((s) => s.trim())
      let name = parts[0] ?? ''
      let age: number | null = parseInt(parts[1] ?? '') || null
      const pm = /^(.*?)\s*\((\d+)\)$/.exec(name)
      if (pm) { name = pm[1]!; age = +pm[2]! }
      const k = nameKey(name)
      if (!k || have.has(k)) continue
      have.add(k)
      ins.run(uid(), name, k, age, rank, parts.slice(2).join(', '))
      added.push(name)
    }
  })()
  if (added.length) { audit(actor, 'pool_imported', null, { count: added.length }); changed() }
  return added.length
}

// ---------- teams ----------
export function saveTeam(id: string | null, t: { name: string; color: string; fg: string }, actor: string) {
  if (!t.name.trim()) throw new UserError('Team name is required')
  if (id) {
    if (!db.prepare('UPDATE teams SET name=?, color=?, fg=? WHERE id=?').run(t.name.trim(), t.color, t.fg, id).changes) throw new UserError('Unknown team')
  } else {
    let nid = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'team'
    while (db.prepare('SELECT 1 FROM teams WHERE id = ?').get(nid)) nid += '2'
    const max = (db.prepare('SELECT COALESCE(MAX(draft_order), 0) m FROM teams').get() as { m: number }).m
    db.prepare('INSERT INTO teams (id, name, color, fg, draft_order) VALUES (?, ?, ?, ?, ?)').run(nid, t.name.trim(), t.color, t.fg, max + 1)
    id = nid
  }
  audit(actor, 'team_saved', null, { id, ...t })
  changed()
}

export function deleteTeam(id: string, actor: string) {
  if (db.prepare('SELECT 1 FROM players WHERE team_id = ?').get(id) || db.prepare('SELECT 1 FROM picks WHERE team_id = ?').get(id))
    throw new UserError('Move this team’s players and picks off it first')
  db.prepare('DELETE FROM teams WHERE id = ?').run(id)
  audit(actor, 'team_deleted', null, { id })
  changed()
}

export function setOrder(order: string[], actor: string) {
  const ids = teams().map((t) => t.id)
  if (order.length !== ids.length || !ids.every((i) => order.includes(i))) throw new UserError('Order must list every team once')
  const up = db.prepare('UPDATE teams SET draft_order = ? WHERE id = ?')
  db.transaction(() => order.forEach((id, i) => up.run(i + 1, id)))()
  audit(actor, 'order_changed', null, { order })
  changed()
}
