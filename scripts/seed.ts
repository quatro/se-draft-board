// pnpm seed <config.json> — load teams, draft order, settings and returning
// players from the original draft-room artifact's league/config document.
// Refuses to run over existing data unless --force is given.
import { readFileSync } from 'node:fs'
import { db } from '../src/db.js'
import { setSettings } from '../src/lib/league.js'
import { nameKey } from '../src/lib/text.js'

const file = process.argv[2]
if (!file) { console.error('usage: pnpm seed <config.json> [--force]'); process.exit(1) }
const c = JSON.parse(readFileSync(file, 'utf8'))
const has = (db.prepare('SELECT COUNT(*) n FROM teams').get() as { n: number }).n
if (has && !process.argv.includes('--force')) { console.error('Database already has teams; pass --force to replace everything.'); process.exit(1) }

db.transaction(() => {
  db.exec('DELETE FROM picks; DELETE FROM players; DELETE FROM teams;')
  const order: string[] = c.order ?? c.teams.map((t: { id: string }) => t.id)
  const insT = db.prepare('INSERT INTO teams (id, name, color, fg, draft_order) VALUES (?, ?, ?, ?, ?)')
  for (const t of c.teams) insT.run(t.id, t.name, t.color, t.fg, order.indexOf(t.id) + 1)
  const insP = db.prepare(`INSERT INTO players (id, name, name_key, age, kind, team_id, status) VALUES (?, ?, ?, ?, 'returning', ?, ?)`)
  for (const k of c.keepers ?? []) insP.run(k.id, k.name, nameKey(k.name), k.age ?? null, k.team, k.status ?? 'Not registered')
  setSettings({
    season: String(c.season ?? '2027'), registrationYear: Number(c.season) || 2027, rosterSize: c.rosterSize ?? 12,
    mode: c.mode ?? 'straight', swap: c.swap ?? ['', ''], clockStart: null, startedAt: null,
  })
})()
console.log(`Seeded ${c.teams.length} teams and ${(c.keepers ?? []).length} returning players.`)
