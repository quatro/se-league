import { db } from '../db.js'
import { receivables } from './plans.js'

// The Finance tab's numbers: registration revenue (booked vs collected, by program,
// by fee and by month) next to what payment-plan families still owe.
//
//   booked    = what families signed up to pay (paid orders, plans at their full amount)
//   collected = money actually received (full payments + plan installments paid)
//   refunded  = orders refunded in full in Stripe

interface Row { id: string; campaign_id: string; status: string; total_cents: number; plan: number; paid_at: string | null; created_at: string; stripe_mode: string | null }

export function revenue(campaignId?: string | null) {
  const where = campaignId ? 'AND o.campaign_id = ?' : ''
  const args = campaignId ? [campaignId] : []
  const all = db.prepare(`SELECT o.* FROM orders o WHERE o.status IN ('paid','refunded') ${where}`).all(...args) as Row[]
  // Test-mode payments are rehearsals: leave them out once real money is flowing.
  const live = all.some((o) => o.stripe_mode === 'live')
  const os = live ? all.filter((o) => o.stripe_mode !== 'test') : all
  const ids = new Set(os.map((o) => o.id))
  const inst = (db.prepare(`SELECT i.order_id, i.amount_cents, i.status, i.paid_at FROM installments i JOIN orders o ON o.id = i.order_id WHERE o.status IN ('paid','refunded') ${where}`)
    .all(...args) as { order_id: string; amount_cents: number; status: string; paid_at: string | null }[]).filter((i) => ids.has(i.order_id))

  const paidOrders = os.filter((o) => o.status === 'paid')
  const booked = paidOrders.reduce((a, o) => a + o.total_cents, 0)
  const full = paidOrders.filter((o) => !o.plan)
  const planPaid = inst.filter((i) => i.status === 'paid')
  const collected = full.reduce((a, o) => a + o.total_cents, 0) + planPaid.filter((i) => paidOrders.some((o) => o.id === i.order_id)).reduce((a, i) => a + i.amount_cents, 0)
  const refunded = os.filter((o) => o.status === 'refunded').reduce((a, o) => a + o.total_cents, 0)

  // Collected by month (league time zone is close enough at month grain).
  const months = new Map<string, number>()
  const add = (iso: string | null, c: number) => { if (iso) months.set(iso.slice(0, 7), (months.get(iso.slice(0, 7)) ?? 0) + c) }
  for (const o of full) add(o.paid_at ?? o.created_at, o.total_cents)
  for (const i of planPaid) add(i.paid_at, i.amount_cents)

  // Booked by program and by fee, from what each paid player bought.
  const lines = (db.prepare(`SELECT ol.order_id, ol.name, ol.unit_cents, ol.qty, op.offering_id, f.name AS program FROM order_lines ol
      JOIN order_players op ON op.id = ol.order_player_id JOIN offerings f ON f.id = op.offering_id JOIN orders o ON o.id = ol.order_id
      WHERE ol.charged = 1 AND o.status = 'paid' AND op.status = 'registered' ${where}`).all(...args) as { order_id: string; name: string; unit_cents: number; qty: number; program: string }[])
    .filter((l) => ids.has(l.order_id))
  const group = (key: (l: (typeof lines)[number]) => string) => {
    const m = new Map<string, { name: string; cents: number; qty: number }>()
    for (const l of lines) { const k = key(l), r = m.get(k) ?? { name: k, cents: 0, qty: 0 }; r.cents += l.unit_cents * l.qty; r.qty += l.qty; m.set(k, r) }
    return [...m.values()].sort((a, b) => b.cents - a.cents)
  }
  const players = (db.prepare(`SELECT op.order_id, f.name AS program FROM order_players op JOIN offerings f ON f.id = op.offering_id JOIN orders o ON o.id = op.order_id
      WHERE op.status = 'registered' AND o.status = 'paid' ${where}`).all(...args) as { order_id: string; program: string }[]).filter((p) => ids.has(p.order_id))
  const byProgram = group((l) => l.program).map((r) => ({ ...r, players: players.filter((p) => p.program === r.name).length }))

  const ar = receivables(campaignId)
  return {
    testOnly: !live && all.length > 0,
    totals: {
      booked, collected, refunded, outstanding: ar.kpis.outstanding, pastDue: ar.kpis.pastDue, waived: ar.kpis.waived,
      orders: paidOrders.length, players: players.length, planOrders: paidOrders.filter((o) => o.plan).length,
    },
    byMonth: [...months.entries()].sort().map(([month, cents]) => ({ month, cents })),
    byProgram, byItem: group((l) => l.name),
    receivables: ar,
  }
}
