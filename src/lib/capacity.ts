import type { Status } from './text.js'

// Seat math for one division. Pure, so it is easy to test and the overview,
// admin and API all agree on the numbers.
//
//   capacity = teams x roster size
//   held     = returners not yet registered (Expected + Need to contact)
//   open     = capacity - registered - held
//
// "Need to contact" returners still hold a seat; bestCaseOpen shows the room
// you'd have if none of them come back.

export type SeatState = 'unset' | 'open' | 'closing' | 'full' | 'over' | 'closed'

export interface SeatInput {
  teams: number; roster_size: number; coaches: number | null; closed: number
}
export interface SeatPlayer { status: Status; returner: number }

export interface Seats {
  capacity: number
  registered: number          // everyone Registered (returners + new)
  returnersRegistered: number
  newRegistered: number
  expected: number            // returners still Expected
  atRisk: number              // returners marked Need to contact
  held: number                // expected + atRisk
  open: number                // may be negative = over capacity
  bestCaseOpen: number
  waitlist: number
  notReturning: number
  projected: number           // registered + held
  teamsNeeded: number         // teams the projected count fills at this roster size
  coachGap: number | null     // teams still without a head coach
  state: SeatState
}

export function seats(d: SeatInput, players: SeatPlayer[], warnAt: number): Seats {
  const n = (f: (p: SeatPlayer) => boolean) => players.filter(f).length
  const capacity = Math.max(0, d.teams) * Math.max(0, d.roster_size)
  const returnersRegistered = n((p) => p.status === 'Registered' && !!p.returner)
  const newRegistered = n((p) => p.status === 'Registered' && !p.returner)
  const registered = returnersRegistered + newRegistered
  const expected = n((p) => p.status === 'Expected')
  const atRisk = n((p) => p.status === 'Need to contact')
  const held = expected + atRisk
  const open = capacity - registered - held
  const projected = registered + held
  let state: SeatState
  if (d.closed) state = 'closed'
  else if (!capacity) state = 'unset'
  else if (open < 0) state = 'over'
  else if (open === 0) state = 'full'
  else if (open <= warnAt) state = 'closing'
  else state = 'open'
  return {
    capacity, registered, returnersRegistered, newRegistered, expected, atRisk, held, open,
    bestCaseOpen: open + atRisk,
    waitlist: n((p) => p.status === 'Waitlist'),
    notReturning: n((p) => p.status === 'Not returning'),
    projected,
    teamsNeeded: d.roster_size > 0 ? Math.ceil(projected / d.roster_size) : 0,
    coachGap: d.coaches == null ? null : Math.max(0, d.teams - d.coaches),
    state,
  }
}
