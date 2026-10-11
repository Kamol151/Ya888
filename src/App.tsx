import { useEffect, useMemo, useRef, useState } from 'react'
import { Volume2, VolumeX, Settings2, RotateCcw, Sparkles, CircleHelp, History, Trophy, Coins, ChevronRight } from 'lucide-react'
import { dealRound, emptyWagers, settleWagers, type Card, type HandResult, type Side, type Wagers } from './game'
import { io, type Socket } from 'socket.io-client'

const CHIPS = [10, 50, 100, 500, 1000]
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const initialBalance = 10000

function useCasinoAudio() {
  const ctx = useRef<AudioContext | null>(null)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(0.55)
  const sound = (kind: 'click'|'chip'|'deal'|'flip'|'win'|'lose'|'tie'|'coin') => {
    if (muted) return
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext
      if (!Ctx) return
      ctx.current ??= new Ctx()
      const ac = ctx.current
      if (ac.state === 'suspended') void ac.resume()
      const now = ac.currentTime
      const notes: Record<string, number[]> = {
        click: [520], chip: [260, 390], deal: [160, 110], flip: [440, 620],
        win: [523, 659, 784, 1047], lose: [260, 196], tie: [392, 440, 392], coin: [880, 1175]
      }
      ;(notes[kind] || [440]).forEach((freq, i) => {
        const osc = ac.createOscillator()
        const gain = ac.createGain()
        osc.type = kind === 'deal' ? 'triangle' : 'sine'
        osc.frequency.setValueAtTime(freq, now + i * 0.085)
        gain.gain.setValueAtTime(0.0001, now + i * 0.085)
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * 0.09), now + i * 0.085 + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.085 + (kind === 'deal' ? 0.075 : 0.16))
        osc.connect(gain); gain.connect(ac.destination)
        osc.start(now + i * 0.085); osc.stop(now + i * 0.085 + 0.19)
      })
    } catch { /* Sound is optional; gameplay must still work. */ }
  }
  return { sound, muted, setMuted, volume, setVolume }
}

function PlayingCard({ card, hidden = false, delay = 0 }: { card?: Card; hidden?: boolean; delay?: number }) {
  if (!card || hidden) return <div className="playing-card card-back" style={{ animationDelay: `${delay}ms` }}><div className="back-pattern"><span>VR</span><i>✦</i></div></div>
  const red = card.suit === '♥' || card.suit === '♦'
  return <div className={`playing-card face ${red ? 'red' : 'black'}`} style={{ animationDelay: `${delay}ms` }}>
    <div className="corner">{card.rank}<span>{card.suit}</span></div>
    <div className="card-center">{card.suit}</div>
    <div className="corner inverted">{card.rank}<span>{card.suit}</span></div>
  </div>
}

function Chips({ value }: { value: number }) {
  if (!value) return null
  const denominations = CHIPS.filter(v => value >= v)
  const chip = denominations[denominations.length - 1] || 10
  return <div className={`table-chip chip-${chip}`}><span>{chip >= 1000 ? '1K' : chip}</span></div>
}

export default function App() {
  const audio = useCasinoAudio()
  const [balance, setBalance] = useState(() => {
    const saved = localStorage.getItem('velvet-baccarat-balance')
    return saved && Number.isFinite(Number(saved)) ? Math.max(0, Number(saved)) : initialBalance
  })
  const [selectedChip, setSelectedChip] = useState(100)
  const [draft, setDraft] = useState<Wagers>(emptyWagers())
  const [lockedWagers, setLockedWagers] = useState<Wagers | null>(null)
  const [round, setRound] = useState<HandResult | null>(null)
  const [phase, setPhase] = useState<'betting'|'dealing'|'result'>('betting')
  const [history, setHistory] = useState<Array<{id:number; winner:Side; ps:number; bs:number; net:number}>>(() => {
    try { return JSON.parse(localStorage.getItem('velvet-baccarat-history') || '[]') } catch { return [] }
  })
  const [showSettings, setShowSettings] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [quality, setQuality] = useState<'high'|'low'>('high')
  const [notice, setNotice] = useState('')
  const [onlineState, setOnlineState] = useState<{ roomId: string; roundNumber: number; phase: 'waiting'|'countdown'|'shuffling'|'dealing'|'revealing'|'result'; seconds: number; round: HandResult | null; revealCount: number; players: number; history: Array<{roundNumber:number;winner:Side;playerScore:number;bankerScore:number}> } | null>(null)
  const [connected, setConnected] = useState(false)
  const [roomCode, setRoomCode] = useState(() => localStorage.getItem('velvet-baccarat-room') || 'PUBLIC-01')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const lastAnnouncedRound = useRef(0)
  const socketRef = useRef<Socket | null>(null)
  const totalDraft = draft.PLAYER + draft.BANKER + draft.TIE
  const totalLocked = lockedWagers ? lockedWagers.PLAYER + lockedWagers.BANKER + lockedWagers.TIE : 0
  const totalRounds = history.length
  const counts = useMemo(() => ({
    PLAYER: history.filter(h => h.winner === 'PLAYER').length,
    BANKER: history.filter(h => h.winner === 'BANKER').length,
    TIE: history.filter(h => h.winner === 'TIE').length
  }), [history])

  useEffect(() => { localStorage.setItem('velvet-baccarat-balance', String(balance)) }, [balance])
  useEffect(() => { localStorage.setItem('velvet-baccarat-history', JSON.stringify(history.slice(0, 30))) }, [history])

  useEffect(() => {
    // Connect directly to the Socket.IO backend in development. This avoids Vite's
    // WebSocket proxy being mistaken for HMR traffic; production uses same-origin.
    const endpoint = import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3001` : window.location.origin
    const socket = io(endpoint, { path: '/socket.io', transports: ['websocket'], reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 })
    socketRef.current = socket
    socket.on('connect', () => { setConnected(true); socket.emit('room:join', { roomId: localStorage.getItem('velvet-baccarat-room') || 'PUBLIC-01' }) })
    socket.on('disconnect', () => setConnected(false))
    socket.on('connect_error', () => setConnected(false))
    socket.on('room:state', (state) => { setOnlineState(state); setRoomCode(state.roomId); localStorage.setItem('velvet-baccarat-room', state.roomId) })
    socket.on('room:error', (message: string) => setNotice(message))
    return () => { socket.disconnect(); socketRef.current = null }
  }, [])

  useEffect(() => {
    if (!voiceEnabled || !onlineState || onlineState.phase !== 'result' || !onlineState.round || lastAnnouncedRound.current === onlineState.roundNumber) return
    lastAnnouncedRound.current = onlineState.roundNumber
    if (!('speechSynthesis' in window)) return
    const words = onlineState.round.winner === 'TIE' ? 'Tie' : `${onlineState.round.winner} win`
    const utterance = new SpeechSynthesisUtterance(words)
    utterance.lang = 'en-US'; utterance.rate = 0.88; utterance.pitch = 1.08
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance)
  }, [onlineState, voiceEnabled])

  const onlineRound = onlineState?.round ? { ...onlineState.round, player: onlineState.round.player.map((card, i) => (onlineState.phase === 'result' || (onlineState.revealCount >= (i === 0 ? 1 : i === 1 ? 3 : 5))) ? card : undefined).filter((card, i) => card !== undefined || i < 3) as Card[], banker: onlineState.round.banker.map((card, i) => (onlineState.phase === 'result' || (onlineState.revealCount >= (i === 0 ? 2 : i === 1 ? 4 : 6))) ? card : undefined).filter((card, i) => card !== undefined || i < 3) as Card[] } : null
  const shownRound = connected && onlineState ? onlineRound : round
  const shownPhase = connected && onlineState ? onlineState.phase : phase
  const joinRoom = () => { const id = roomCode.trim().toUpperCase(); if (!/^[A-Z0-9-]{3,16}$/.test(id)) { setNotice('รหัสห้องต้องมี 3–16 ตัว ใช้ A-Z, 0-9 หรือ -'); return }; socketRef.current?.emit('room:join', { roomId: id }) }
  const createRoom = () => socketRef.current?.emit('room:create')


  const addChip = (side: Side) => {
    if (phase !== 'betting' || lockedWagers) return
    if (totalDraft + selectedChip > balance) { setNotice('เหรียญไม่เพียงพอสำหรับการเดิมพันนี้'); return }
    setDraft(prev => ({ ...prev, [side]: prev[side] + selectedChip }))
    setNotice('')
    audio.sound('chip')
  }
  const clearBets = () => {
    if (phase !== 'betting' || lockedWagers) return
    setDraft(emptyWagers()); setNotice('ล้างเดิมพันแล้ว'); audio.sound('click')
  }
  const confirmBet = () => {
    if (totalDraft <= 0) { setNotice('เลือกชิปแล้ววางเดิมพันอย่างน้อย 1 ตำแหน่งก่อน'); return }
    if (totalDraft > balance) { setNotice('เหรียญไม่เพียงพอ'); return }
    setBalance(b => b - totalDraft)
    setLockedWagers({ ...draft })
    setNotice('ยืนยันเดิมพันแล้ว กด DEAL เพื่อแจกไพ่')
    audio.sound('click')
  }
  const deal = () => {
    if (phase !== 'betting' || !lockedWagers) return
    setPhase('dealing'); setNotice('กำลังแจกไพ่…'); audio.sound('deal')
    const result = dealRound()
    setRound(result)
    // Keep the result deterministic after deal; short cinematic delay is only visual.
    window.setTimeout(() => {
      setPhase('result')
      const settlement = settleWagers(0, lockedWagers, result.winner)
      setBalance(b => b + settlement.returned)
      setHistory(prev => [{ id: Date.now(), winner: result.winner, ps: result.playerScore, bs: result.bankerScore, net: settlement.net }, ...prev].slice(0, 30))
      setNotice(result.winner === 'TIE' ? 'ผลเสมอ' : `${result.winner} ${settlement.net > 0 ? 'ชนะเดิมพัน' : settlement.net < 0 ? 'ชนะในเกม แต่เดิมพันรอบนี้แพ้' : 'เสมอตัว'}`)
      if (result.winner === 'TIE') audio.sound('tie')
      else if ((result.winner === 'PLAYER' && lockedWagers.PLAYER > 0) || (result.winner === 'BANKER' && lockedWagers.BANKER > 0)) {
        audio.sound('win'); window.setTimeout(() => audio.sound('coin'), 220)
      } else audio.sound('lose')
    }, 1350)
  }
  const newRound = () => {
    setRound(null); setDraft(emptyWagers()); setLockedWagers(null); setPhase('betting'); setNotice('วางเดิมพันเพื่อเริ่มรอบใหม่'); audio.sound('click')
  }
  const resetCoins = () => {
    if (!window.confirm('ต้องการรีเซ็ตเหรียญจำลองกลับเป็น 10,000 เหรียญหรือไม่?')) return
    setBalance(initialBalance); setDraft(emptyWagers()); setLockedWagers(null); setRound(null); setPhase('betting')
    setHistory([]); setNotice('รีเซ็ตเหรียญแล้ว'); audio.sound('coin')
  }
  const resultLabel = (winner: Side) => winner === 'PLAYER' ? 'PLAYER WIN' : winner === 'BANKER' ? 'BANKER WIN' : 'TIE GAME'
  const currentWagers = lockedWagers || draft

  return <div className={`app-shell ${quality === 'low' ? 'low-quality' : ''} ${reduceMotion ? 'reduce-motion' : ''}`}>
    <div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><span>V</span><i>✦</i></div>
        <div><div className="brand-name">VELVET <b>ROYALE</b></div><div className="brand-sub">BACCARAT • PUBLIC ONLINE ROOM</div></div>
      </div>
      <div className="top-actions">
        <div className="balance-pill"><Coins size={17}/><div><small>เหรียญของคุณ</small><strong>{fmt(balance)}</strong></div></div>
        <button className="icon-button" title={audio.muted ? 'เปิดเสียง' : 'ปิดเสียง'} onClick={() => { audio.setMuted(!audio.muted); if (audio.muted) audio.sound('click') }}>{audio.muted ? <VolumeX/> : <Volume2/>}</button>
        <button className="icon-button" title="ตั้งค่า" onClick={() => setShowSettings(v => !v)}><Settings2/></button>
      </div>
    </header>

    {showSettings && <section className="settings-pop panel">
      <div className="panel-title">ตั้งค่าเกม <button className="tiny-close" onClick={() => setShowSettings(false)}>×</button></div>
      <label className="setting-line"><span>ระดับเสียง</span><input type="range" min="0" max="1" step=".05" value={audio.volume} onChange={e => audio.setVolume(Number(e.target.value))}/><b>{Math.round(audio.volume*100)}%</b></label>
      <label className="setting-line"><span>คุณภาพกราฟิก</span><select value={quality} onChange={e => setQuality(e.target.value as 'high'|'low')}><option value="high">สูง</option><option value="low">ประหยัดเครื่อง</option></select></label>
      <label className="setting-line"><span>ลดการเคลื่อนไหว</span><input type="checkbox" checked={reduceMotion} onChange={e => setReduceMotion(e.target.checked)}/></label>
      <button className="text-button" onClick={resetCoins}><RotateCcw size={14}/> รีเซ็ตเหรียญและประวัติ</button>
    </section>}

    <main className="main-content">
      <div className="page-heading">
        <div><div className="eyebrow"><span className="live-dot"/> SIMULATION TABLE 01</div><h1>โต๊ะบาคาร่า <em>ระดับพรีเมียม</em></h1><p>สัมผัสประสบการณ์คาสิโน 3D ด้วยเหรียญจำลองเท่านั้น</p></div>
        <button className="rules-button" onClick={() => setShowRules(true)}><CircleHelp size={16}/> กติกาเกม</button>
      </div>

      <section className="online-room panel">
        <div className="online-room-main"><span className={`connection-light ${connected ? 'connected' : ''}`}/><div><strong>ห้อง {onlineState?.roomId || roomCode}</strong><small>{connected ? `เชื่อมต่อแล้ว • ผู้เล่น ${onlineState?.players ?? 0} คน` : 'กำลังเชื่อมต่อเซิร์ฟเวอร์…'}</small></div></div>
        <div className="room-round"><small>{onlineState?.phase === 'countdown' ? 'เริ่มรอบใหม่ใน' : onlineState?.phase === 'shuffling' ? 'SHUFFLING' : onlineState?.phase === 'dealing' ? 'DEALING' : onlineState?.phase === 'revealing' ? 'REVEALING' : onlineState?.phase === 'result' ? 'RESULT' : 'WAITING'}</small><strong>{onlineState?.phase === 'countdown' ? `${onlineState.seconds}s` : onlineState?.phase === 'result' && onlineState.round ? (onlineState.round.winner === 'TIE' ? 'TIE' : `${onlineState.round.winner} WIN`) : onlineState?.phase === 'waiting' ? 'รอผู้เล่น' : 'กำลังเล่น'}</strong></div>
        <div className="room-actions"><input aria-label="รหัสห้อง" value={roomCode} maxLength={16} onChange={e => setRoomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="รหัสห้อง"/><button className="voice-toggle" onClick={joinRoom} disabled={!connected}>เข้าห้อง</button><button className="voice-toggle" onClick={createRoom} disabled={!connected}>สร้างห้อง</button><button className="voice-toggle" onClick={() => socketRef.current?.emit('room:leave')} disabled={!connected || onlineState?.roomId === 'PUBLIC-01'}>กลับ PUBLIC</button><button className="voice-toggle start-round-button" onClick={() => socketRef.current?.emit('room:start')} disabled={!connected || onlineState?.phase !== 'countdown'}>เริ่มรอบ</button></div>
        <button className={`voice-toggle ${voiceEnabled ? 'enabled' : ''}`} onClick={() => { setVoiceEnabled(v => !v); if (!voiceEnabled && 'speechSynthesis' in window) { const u = new SpeechSynthesisUtterance('Voice enabled'); u.lang = 'en-US'; window.speechSynthesis.speak(u) } }}>{voiceEnabled ? '🔊 ปิดเสียงประกาศ' : '🔈 เปิดเสียงประกาศ'}</button>
      </section>

      <section className="casino-stage">
        <div className="stage-glow"/>
        <div className="table-scene">
          <div className="table-shadow"/>
          <div className="casino-table">
            <div className="table-rail"/>
            <div className="table-felt">
              <div className="felt-grain"/>
              <div className="table-emblem"><span>VR</span><small>VELVET ROYALE</small></div>
              <div className="table-label player-label">PLAYER <span>ผู้เล่น</span></div>
              <div className="table-label banker-label">BANKER <span>เจ้ามือ</span></div>
              <div className="hand-zone player-zone">
                <div className="cards-row">{[0,1,2].map((i) => <PlayingCard key={`p${i}`} card={shownRound?.player[i]} hidden={!shownRound?.player[i]} delay={i*110}/>)}</div>
                <div className="score-bubble"><small>แต้ม</small><strong>{shownPhase === 'result' && shownRound ? shownRound.playerScore : '—'}</strong></div>
              </div>
              <div className="hand-zone banker-zone">
                <div className="cards-row">{[0,1,2].map((i) => <PlayingCard key={`b${i}`} card={shownRound?.banker[i]} hidden={!shownRound?.banker[i]} delay={i*110+90}/>)}</div>
                <div className="score-bubble"><small>แต้ม</small><strong>{shownPhase === 'result' && shownRound ? shownRound.bankerScore : '—'}</strong></div>
              </div>
              <div className="table-divider"/>
              <div className="table-bottom-mark">✦  •  BACCARAT  •  ✦</div>
            </div>
          </div>
          {shownPhase === 'result' && shownRound && <div className={`result-banner ${shownRound.winner.toLowerCase()}`}><div className="result-spark"><Sparkles size={18}/></div><span>{shownRound.winner === 'TIE' ? 'TIE' : `${shownRound.winner} WIN`}</span><small>{shownRound.winner === 'TIE' ? 'ไพ่เสมอกัน' : `ชนะด้วย ${shownRound.winner === 'PLAYER' ? shownRound.playerScore : shownRound.bankerScore} แต้ม`}</small></div>}
          {(['shuffling','dealing','revealing'].includes(shownPhase)) && <div className={`dealing-overlay dealer-${shownPhase}`}><div className="dealer-character" aria-label="เจ้ามือกำลังสับและแจกไพ่"><span>♠</span><i>✦</i><b>VR</b></div><div className="spinner"/><span>{shownPhase === 'shuffling' ? 'SHUFFLING THE DECK' : shownPhase === 'revealing' ? 'REVEALING CARDS' : 'DEALING CARDS'}</span></div>}
        </div>
        <div className="stage-caption"><span><i className="green-dot"/> {connected ? 'โต๊ะสาธารณะออนไลน์' : 'โหมดออฟไลน์'}</span><span>รอบสาธารณะ #{onlineState?.roundNumber ?? 0}</span><span>52-CARD DECK</span></div>
      </section>

      <section className="betting-panel panel">
        <div className="local-practice-note">การเดิมพันและเหรียญด้านล่างเป็น <b>โหมดฝึกส่วนตัว</b> ไม่ส่งผลต่อไพ่หรือผลรอบของห้องสาธารณะ</div>
        <div className="section-heading"><div><span className="eyebrow">PLACE YOUR BET</span><h2>เลือกตำแหน่งเดิมพัน</h2></div><div className="bet-total"><small>ยอดเดิมพัน</small><strong>{fmt(lockedWagers ? totalLocked : totalDraft)} <span>เหรียญ</span></strong></div></div>
        <div className="bet-spots">
          {(['PLAYER','TIE','BANKER'] as Side[]).map(side => <button key={side} className={`bet-spot ${side.toLowerCase()} ${currentWagers[side] ? 'has-bet' : ''} ${lockedWagers ? 'disabled-spot' : ''}`} onClick={() => addChip(side)} disabled={phase !== 'betting' || !!lockedWagers}>
            <div className="spot-top"><span className="spot-symbol">{side === 'PLAYER' ? '♠' : side === 'BANKER' ? '♦' : '✦'}</span><span className="spot-odds">{side === 'PLAYER' ? '1 : 1' : side === 'BANKER' ? '0.95 : 1' : '8 : 1'}</span></div>
            <strong>{side}</strong><small>{side === 'PLAYER' ? 'ผู้เล่นชนะ' : side === 'BANKER' ? 'เจ้ามือชนะ' : 'เสมอ'}</small>
            <div className="spot-bet">{currentWagers[side] ? <><Chips value={currentWagers[side]}/><b>{fmt(currentWagers[side])}</b></> : <span className="place-hint">+ วางชิป</span>}</div>
          </button>)}
        </div>
        <div className="bet-controls">
          <div className="chip-picker"><span className="control-label">เลือกชิป</span>{CHIPS.map((chip, i) => <button key={chip} className={`chip-option chip-option-${i} ${selectedChip === chip ? 'selected' : ''}`} onClick={() => {setSelectedChip(chip); audio.sound('click')}} disabled={!!lockedWagers || phase !== 'betting'}><span>{chip >= 1000 ? '1K' : chip}</span></button>)}</div>
          <div className="control-buttons">
            {phase === 'result' ? <button className="primary-button" onClick={newRound}>รอบถัดไป <ChevronRight size={17}/></button> : <>
              <button className="secondary-button" onClick={clearBets} disabled={!!lockedWagers || totalDraft === 0}><RotateCcw size={15}/> ล้าง</button>
              {!lockedWagers ? <button className="primary-button" onClick={confirmBet} disabled={phase !== 'betting' || totalDraft === 0}>ยืนยันเดิมพัน <ChevronRight size={17}/></button> : <button className="primary-button deal-button" onClick={deal} disabled={phase !== 'betting'}>DEAL <span>แจกไพ่</span> <Sparkles size={16}/></button>}
            </>}
          </div>
        </div>
        <div className={`notice ${notice.includes('ไม่เพียงพอ') ? 'warning' : ''}`}>{notice || 'เลือกชิป แล้วคลิกตำแหน่งเดิมพันบนโต๊ะเพื่อเริ่มเล่น'}</div>
        <div className="demo-note"><span>ⓘ</span> เกมจำลองเพื่อความบันเทิงเท่านั้น • ไม่มีเงินจริง ฝากถอน หรือแลกเหรียญ</div>
      </section>

      <section className="lower-grid">
        <div className="panel history-panel">
          <div className="section-heading compact"><div><span className="eyebrow">RECENT RESULTS</span><h2><History size={18}/> ประวัติผลล่าสุด</h2></div><span className="history-count">{totalRounds} รอบ</span></div>
          {connected && onlineState?.history?.length ? <div className="history-list">{onlineState.history.slice(0,8).map((h) => <div className="history-row" key={`${onlineState.roomId}-${h.roundNumber}`}><span className="history-index">{String(h.roundNumber).padStart(2,'0')}</span><span className={`history-badge ${h.winner.toLowerCase()}`}>{h.winner === 'PLAYER' ? 'P' : h.winner === 'BANKER' ? 'B' : 'T'}</span><span className="history-result">{h.winner}</span><span className="history-score">{h.playerScore} <i>:</i> {h.bankerScore}</span><span className="history-net">ONLINE</span></div>)}</div> : history.length === 0 ? <div className="empty-history"><div className="empty-icon"><History size={23}/></div><strong>ยังไม่มีประวัติการเล่น</strong><span>ผลแต่ละรอบจะแสดงที่นี่หลังจบเกม</span></div> : <div className="history-list">{history.slice(0,8).map((h, i) => <div className="history-row" key={h.id}><span className="history-index">{String(history.length-i).padStart(2,'0')}</span><span className={`history-badge ${h.winner.toLowerCase()}`}>{h.winner === 'PLAYER' ? 'P' : h.winner === 'BANKER' ? 'B' : 'T'}</span><span className="history-result">{h.winner}</span><span className="history-score">{h.ps} <i>:</i> {h.bs}</span><span className={`history-net ${h.net > 0 ? 'positive' : h.net < 0 ? 'negative' : ''}`}>{h.net > 0 ? '+' : ''}{fmt(h.net)}</span></div>)}</div>}
        </div>
        <div className="panel stats-panel">
          <div className="section-heading compact"><div><span className="eyebrow">TABLE STATISTICS</span><h2><Trophy size={18}/> สถิติผลเกม</h2></div></div>
          <div className="stats-total"><strong>{totalRounds}</strong><span>รอบที่บันทึก</span></div>
          {(['PLAYER','BANKER','TIE'] as Side[]).map(side => <div className="stat-line" key={side}><div className={`stat-dot ${side.toLowerCase()}`}/><span>{side}</span><strong>{counts[side]}</strong><small>{totalRounds ? Math.round(counts[side]/totalRounds*100) : 0}%</small><div className="stat-track"><i className={side.toLowerCase()} style={{width: `${totalRounds ? counts[side]/totalRounds*100 : 0}%`}}/></div></div>)}
          <p className="stats-foot">สถิติเป็นเพียงผลย้อนหลัง ไม่สามารถใช้ทำนายผลรอบถัดไปได้</p>
        </div>
      </section>
      <footer className="footer"><div className="brand-mini">✦ VELVET ROYALE</div><span>VIRTUAL COINS ONLY · FOR ENTERTAINMENT</span><button onClick={() => setShowRules(true)}>กติกาและข้อมูล</button></footer>
    </main>

    {showRules && <div className="modal-backdrop" onClick={() => setShowRules(false)}><div className="modal panel" onClick={e => e.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">HOW TO PLAY</span><h2>กติกาบาคาร่าสำหรับเกมจำลอง</h2></div><button className="icon-button" onClick={() => setShowRules(false)}>×</button></div><p>เป้าหมายคือเลือกเดิมพันว่าคะแนน PLAYER, BANKER หรือ TIE จะเป็นฝ่ายชนะ คะแนนนับเฉพาะหลักหน่วยของผลรวมไพ่</p><ul><li>A = 1 แต้ม, 2–9 = แต้มตามหน้าไพ่ และ 10/J/Q/K = 0 แต้ม</li><li>หากฝ่ายใดมี 8 หรือ 9 แต้มจากไพ่สองใบแรก จะหยุดจั่วตามกฎ Natural</li><li>PLAYER จั่วไพ่เมื่อมี 0–5 แต้ม ส่วน BANKER ใช้กฎจั่วมาตรฐานที่สัมพันธ์กับไพ่ใบที่สามของ PLAYER</li><li>PLAYER จ่ายกำไร 1:1, BANKER จ่ายกำไร 0.95:1 และ TIE จ่ายกำไร 8:1</li><li>หากเสมอ เดิมพัน PLAYER และ BANKER จะได้รับเงินเดิมพันคืน</li></ul><div className="rules-warning">เหรียญในเกมเป็นเหรียญเสมือนเท่านั้น ไม่มีมูลค่าเป็นเงินจริง</div><button className="primary-button full-button" onClick={() => setShowRules(false)}>เข้าใจแล้ว</button></div></div>}
  </div>
}