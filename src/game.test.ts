import { describe, expect, it } from 'vitest'
import { cardValue, scoreHand, makeDeck, settleWagers, emptyWagers, type Card } from './game'

const c = (rank: Card['rank'], suit: Card['suit'] = '♠'): Card => ({ rank, suit, id: suit + rank })

describe('baccarat rules and economy', () => {
  it('scores only the final digit', () => {
    expect(scoreHand([c('9'), c('8')])).toBe(7)
    expect(scoreHand([c('A'), c('K')])).toBe(1)
    expect(cardValue('Q')).toBe(0)
  })
  it('creates 52 unique cards', () => {
    const deck = makeDeck(() => 0.5)
    expect(deck).toHaveLength(52)
    expect(new Set(deck.map(card => card.id)).size).toBe(52)
  })
  it('returns player and banker stakes on tie and pays tie 8:1', () => {
    const wagers = { ...emptyWagers(), PLAYER: 100, BANKER: 100, TIE: 50 }
    const result = settleWagers(9750, wagers, 'TIE')
    expect(result.returned).toBe(100 + 100 + 450)
    expect(result.balance).toBe(10400)
    expect(result.net).toBe(400)
  })
  it('pays banker at 95% profit (rounded down)', () => {
    const wagers = { ...emptyWagers(), BANKER: 101 }
    expect(settleWagers(9899, wagers, 'BANKER').returned).toBe(196)
  })
})