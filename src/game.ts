export type Suit = '♠' | '♥' | '♦' | '♣'
export type Rank = 'A'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'10'|'J'|'Q'|'K'
export type Card = { suit: Suit; rank: Rank; id: string }
export type Side = 'PLAYER'|'BANKER'|'TIE'
export type HandResult = { player: Card[]; banker: Card[]; playerScore: number; bankerScore: number; winner: Side }

const suits: Suit[] = ['♠','♥','♦','♣']
const ranks: Rank[] = ['A','2','3','4','5','6','7','8','9','10','J','Q','K']
export const cardValue = (rank: Rank): number => {
  if (rank === 'A') return 1
  if (['10','J','Q','K'].includes(rank)) return 0
  return Number(rank)
}
export const scoreHand = (cards: Card[]): number => cards.reduce((sum, card) => sum + cardValue(card.rank), 0) % 10

export function makeDeck(random: () => number = Math.random): Card[] {
  const deck: Card[] = suits.flatMap(suit => ranks.map(rank => ({ suit, rank, id: `${suit}${rank}` })))
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

export function bankerShouldDraw(bankerScore: number, playerThird: Card | undefined): boolean {
  if (!playerThird) return bankerScore <= 5
  const v = cardValue(playerThird.rank)
  if (bankerScore <= 2) return true
  if (bankerScore === 3) return v !== 8
  if (bankerScore === 4) return v >= 2 && v <= 7
  if (bankerScore === 5) return v >= 4 && v <= 7
  if (bankerScore === 6) return v === 6 || v === 7
  return false
}

export function dealRound(deck = makeDeck()): HandResult {
  let cursor = 0
  const player = [deck[cursor++], deck[cursor++]]
  const banker = [deck[cursor++], deck[cursor++]]
  let ps = scoreHand(player)
  let bs = scoreHand(banker)
  if (ps < 8 && bs < 8) {
    let playerThird: Card | undefined
    if (ps <= 5) {
      playerThird = deck[cursor++]
      player.push(playerThird)
      ps = scoreHand(player)
    }
    if (bankerShouldDraw(bs, playerThird)) {
      banker.push(deck[cursor++])
      bs = scoreHand(banker)
    }
  }
  const winner: Side = ps > bs ? 'PLAYER' : bs > ps ? 'BANKER' : 'TIE'
  return { player, banker, playerScore: ps, bankerScore: bs, winner }
}

export type Wagers = Record<Side, number>
export const emptyWagers = (): Wagers => ({ PLAYER: 0, BANKER: 0, TIE: 0 })

export type Settlement = { balance: number; returned: number; net: number; outcome: string }
export function settleWagers(balanceAfterStake: number, wagers: Wagers, winner: Side): Settlement {
  const total = wagers.PLAYER + wagers.BANKER + wagers.TIE
  let returned = 0
  if (winner === 'TIE') {
    returned += wagers.PLAYER + wagers.BANKER
    returned += wagers.TIE * 9 // stake + 8:1 profit
  } else if (winner === 'PLAYER') {
    returned += wagers.PLAYER * 2
  } else {
    returned += wagers.BANKER + Math.floor(wagers.BANKER * 95 / 100) // stake + 95% profit
  }
  const net = returned - total
  return { balance: balanceAfterStake + returned, returned, net, outcome: net > 0 ? 'ชนะ' : net < 0 ? 'แพ้' : 'เสมอตัว' }
}