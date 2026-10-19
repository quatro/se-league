// Draft order engine, ported from the original draft-room artifact.
//
// Each team owes (rosterSize - returning players still returning) picks. Every
// round runs in the round-1 order (reversed on even rounds in snake mode, with
// the coin-flip pair swapped on even rounds), and a team only appears in a
// round while it still owes picks — so teams that lost more players get the
// extra "compensation" picks in the later rounds.

export type Mode = 'straight' | 'snake'

export interface Slot {
  n: number
  round: number
  team: string
  key: string
  comp: boolean
}

export interface EngineInput {
  order: string[]
  mode: Mode
  swap: [string, string] | string[]
  rosterSize: number
  keepersByTeam: Record<string, number>
}

export function openSpots(i: EngineInput): Record<string, number> {
  const o: Record<string, number> = {}
  for (const t of i.order) o[t] = Math.max(0, i.rosterSize - (i.keepersByTeam[t] ?? 0))
  return o
}

export function roundOrder(i: EngineInput, r: number): string[] {
  const ord = [...i.order]
  if (i.mode === 'snake' && r % 2 === 0) ord.reverse()
  const [a, b] = i.swap
  if (a && b && a !== b && r % 2 === 0) {
    const x = ord.indexOf(a), y = ord.indexOf(b)
    if (x > -1 && y > -1) [ord[x], ord[y]] = [ord[y]!, ord[x]!]
  }
  return ord
}

export function slots(i: EngineInput) {
  const open = openSpots(i)
  const vals = Object.values(open)
  const max = vals.length ? Math.max(...vals) : 0
  const min = vals.length ? Math.min(...vals) : 0
  const list: Slot[] = []
  let n = 0
  for (let r = 1; r <= max; r++)
    for (const t of roundOrder(i, r))
      if ((open[t] ?? 0) >= r) list.push({ n: ++n, round: r, team: t, key: `${r}-${t}`, comp: r > min })
  return { list, open, max, min }
}
