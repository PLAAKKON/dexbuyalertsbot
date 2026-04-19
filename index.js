import 'dotenv/config'
import { Telegraf } from 'telegraf'
import { createServer } from 'http'
import { createReadStream } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Health check server for Railway
const PORT = process.env.PORT || 3000
createServer((req, res) => {
  res.writeHead(200)
  res.end('Bot is running')
}).listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`)
})

const bot = new Telegraf(process.env.BOT_TOKEN)

// Kaikki ryhmät joihin lähetetään alertit
const chatIds = new Set([
  '-1003841288653',  // qdogesol
])

// /start-komento rekisteröi ryhmän
bot.start((ctx) => {
  const chatId = ctx.chat.id.toString()
  if (ctx.chat.type === 'private') {
    const privateMessages = [
      '⚛️🐕 Quantum Doge Bot\n\n🔮 Add me to a group and send /start there to activate alerts!',
      '🐕⚛️ QDOGE Alert System\n\n🚀 Want real-time alerts? Add me to your group and /start!',
      '⚡ Quantum Doge Bot Online\n\n👉 Add me to a group to enable market monitoring!',
    ]
    ctx.reply(privateMessages[Math.floor(Math.random() * privateMessages.length)])
    return
  }
  chatIds.add(chatId)
  console.log(`Registered chat: ${chatId} (${ctx.chat.title})`)
  
  const activationMessages = [
    `✅ Quantum Doge alerts ACTIVATED! 🚀\n\n⚛️ Monitoring started for this group\n📊 Chat ID: <code>${chatId}</code>\n\n💎 You'll receive real-time swap alerts!`,
    `🔥 QDOGE Bot is now LIVE! ⚡\n\n🐕 This group is registered for alerts\n🔗 ID: <code>${chatId}</code>\n\n🚀 Let the gains begin!`,
    `⚛️ Quantum Field: CONNECTED ✅\n\n🎯 Alerts activated for this group\n📡 Tracking ID: <code>${chatId}</code>\n\n💰 Stay tuned for market action!`,
  ]
  ctx.reply(activationMessages[Math.floor(Math.random() * activationMessages.length)], { parse_mode: 'HTML' })
})

// Käynnistä bot polling
bot.launch()
console.log('Bot polling started')

// Seurattava pair
const PAIR_ID = 'GmEitYz2NmbFXLKXWJfm92LENpWHMVVwNPK1EWDcFGVN'
const PAIR_URL = `https://api.dexscreener.com/latest/dex/pairs/solana/${PAIR_ID}`
const DEX_URL = `https://dexscreener.com/solana/e2aqyizkyftvrvr4g8vmmbpfd86pigicwwarkujdpump`

// Pump.fun bonding curve settings
const TOKEN_MINT = 'E2AQyiZKYftVRvR4g8VMMBpfD86PiGicWWARKuJdpump'
const PUMP_FUN_API_URL = `https://frontend-api-v3.pump.fun/coins/${TOKEN_MINT}`
const INITIAL_REAL_TOKEN_RESERVES = 793100000000000  // Initial tokens in bonding curve (793.1M with 6 decimals)

// Asetukset
const POLL_MS = 60000  // 60 sekuntia rate limitin välttämiseksi
const IDLE_REPORT_MS = 10 * 60 * 1000

// Heuristiikat
const WHALE_USD = 1000
const MEGA_WHALE_USD = 5000
const PUMP_THRESHOLD_PCT = 3
const DUMP_THRESHOLD_PCT = -3
const DRAIN_THRESHOLD_PCT = -10
const RUG_THRESHOLD_PCT = -30

// Automaattinen osto: stubi, EI tee oikeaa treidausta
const AUTO_BUY_ENABLED = false
const AUTO_BUY_MIN_LIQUIDITY = 5000
const AUTO_BUY_MAX_PRICE_CHANGE_PCT = 2

let state = {
  initialized: false,
  lastPrice: null,
  lastMarketCap: null,
  lastVolume24h: null,
  lastBuys24h: null,
  lastSells24h: null,
  lastIdleReportAt: 0,
  lastAlertSignature: null,
}

// Tallenna lähetetyt viestit poistoa varten: { chatId -> [{ messageId, sentAt }] }
const sentMessages = new Map()

// Poista yli 10 minuuttia vanhat botin viestit
async function cleanupOldMessages() {
  const maxAge = 10 * 60 * 1000  // 10 minuuttia
  const now = Date.now()

  for (const [chatId, messages] of sentMessages.entries()) {
    const toDelete = messages.filter(m => now - m.sentAt >= maxAge)
    const toKeep = messages.filter(m => now - m.sentAt < maxAge)

    for (const msg of toDelete) {
      try {
        await bot.telegram.deleteMessage(chatId, msg.messageId)
        console.log(`Deleted old message ${msg.messageId} from ${chatId}`)
      } catch (err) {
        // Viesti on jo poistettu tai ei oikeuksia
        if (!err.message.includes('message to delete not found')) {
          console.error(`Failed to delete message ${msg.messageId}:`, err.message)
        }
      }
    }

    if (toKeep.length > 0) {
      sentMessages.set(chatId, toKeep)
    } else {
      sentMessages.delete(chatId)
    }
  }
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function pctChange(current, previous) {
  if (!previous || previous === 0) return 0
  return ((current - previous) / previous) * 100
}

function money(v) {
  const n = num(v)
  if (n === 0) return '$0.00'
  if (n < 0.0001) return `$${n.toExponential(2)}`  // Erittäin pienet: $8.17e-7
  if (n < 0.01) return `$${n.toFixed(6)}`          // Pienet: $0.000817
  return `$${n.toFixed(2)}`                        // Normaalit: $123.45
}

function shortPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

// Dynamic randomizers
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function volumeBar(value, max, length = 8) {
  const filled = Math.min(length, Math.round((value / max) * length))
  const empty = length - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

function timeAgo() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Fetch fresh data from DexScreener for real-time display
async function fetchLiveData() {
  try {
    const res = await fetch(PAIR_URL)
    if (!res.ok) return null
    const data = await res.json()
    return data?.pair || null
  } catch (err) {
    console.error('fetchLiveData error:', err.message)
    return null
  }
}

// Dynamic headers
const buyHeaders = [
  '🔥 BUY ALERT DETECTED',
  '💚 BUYERS INCOMING',
  '🚀 BULLISH ACTIVITY',
  '⚡ BUY SIGNAL TRIGGERED',
  '💎 DIAMOND HANDS BUYING',
  '🟢 GREEN CANDLE FORMING',
  '📈 UPWARD MOMENTUM',
  '🔫 SHOTS FIRED - BUYING',
]

const sellHeaders = [
  '🔻 SELL PRESSURE DETECTED',
  '🔴 SELLERS ACTIVE',
  '📉 BEARISH ACTIVITY',
  '⚠️ SELL SIGNAL',
  '🌀 PAPER HANDS SELLING',
  '🩸 BLOOD IN THE WATER',
  '❄️ COOLER ACTIVITY',
  '💨 PROFIT TAKING',
]

const mixedHeaders = [
  '🔄 MARKET ACTION',
  '⚡ VOLATILE SWAPS',
  '🎭 MIXED SIGNALS',
  '🌊 WAVE ACTIVITY',
  '⚖️ BATTLE IN PROGRESS',
  '🎲 UNPREDICTABLE MOVES',
]

const idleHeaders = [
  '⏸️ QUANTUM FIELD STABLE',
  '😴 MARKET TAKING A NAP',
  '🧘 ZEN MODE ACTIVE',
  '☕ COFFEE BREAK',
  '🌙 QUIET HOURS',
  '🐕💤 DOGE IS SLEEPING',
  '⏳ WAITING FOR ACTION',
  '🔮 CALM BEFORE THE STORM',
]

const idleSubtitles = [
  '😎 HOLDERS CHILLING 😎',
  '💎 DIAMOND HANDS HODLING 💎',
  '🧊 ICE COLD PATIENCE 🧊',
  '🦍 APES TOGETHER STRONG 🦍',
  '🌈 VIBING ONLY 🌈',
  '🎵 ELEVATOR MUSIC PLAYING 🎵',
  '🛋️ COUCH MODE ACTIVATED 🛋️',
]

const quantumPhrases = [
  '⚛️ Quantum Field: RESONATING',
  '⚛️ Quantum State: SUPERPOSITION',
  '⚛️ Entanglement: STRONG',
  '⚛️ Wavefunction: COLLAPSING',
  '⚛️ Quantum Flux: ELEVATED',
  '⚛️ Quantum Tunneling: ACTIVE',
  '⚛️ Spin State: ALIGNED',
]

const momentumPhrases = {
  bullish: ['🐂 Bulls in control', '🚀 Moon trajectory', '💪 Strong momentum', '📊 Trend is UP'],
  bearish: ['🐻 Bears awakening', '🪂 Parachute mode', '⬇️ Descending', '📊 Trend is DOWN'],
  neutral: ['⚖️ Market deciding', '🤔 Uncertain territory', '➡️ Sideways action', '🎯 Consolidating'],
}

const closingPhrases = [
  '🔗 DYOR - NFA',
  '⚠️ Trade responsibly',
  '👀 Stay vigilant',
  '🎯 Eyes on the chart',
  '💡 Knowledge is power',
  '🔍 Research always',
]

function getExcitementLevel(volumeDelta, priceChangePct) {
  const volScore = volumeDelta >= MEGA_WHALE_USD ? 3 : volumeDelta >= WHALE_USD ? 2 : volumeDelta >= 100 ? 1 : 0
  const priceScore = Math.abs(priceChangePct) >= 10 ? 3 : Math.abs(priceChangePct) >= 5 ? 2 : Math.abs(priceChangePct) >= 2 ? 1 : 0
  const total = volScore + priceScore
  
  if (total >= 5) return { emoji: '🔥🔥🔥', text: 'EXTREME', border: '═══════════════════' }
  if (total >= 4) return { emoji: '🔥🔥', text: 'HIGH', border: '════════════════' }
  if (total >= 2) return { emoji: '🔥', text: 'MODERATE', border: '═══════════════' }
  return { emoji: '📊', text: 'NORMAL', border: '──────────────' }
}

function getMomentum(priceChangePct) {
  if (priceChangePct >= 2) return pick(momentumPhrases.bullish)
  if (priceChangePct <= -2) return pick(momentumPhrases.bearish)
  return pick(momentumPhrases.neutral)
}

// Bonding curve progress bar generator - clean box style
function bondingCurveBar(percentage) {
  const pct = Math.min(100, Math.max(0, percentage))
  const filled = Math.round(pct / 5)  // 20 laatikkoa yhteensä
  const empty = 20 - filled
  
  // Käytä Unicode-laatikoita (selkeä ja kompakti)
  const filledChar = '▓'  // Täytetty
  const emptyChar = '░'   // Tyhjä
  
  const bar = filledChar.repeat(filled) + emptyChar.repeat(empty)
  
  return `[${bar}] ${pct.toFixed(1)}%`
}

// Fetch bonding curve data from pump.fun
async function getBondingCurveProgress() {
  try {
    const res = await fetch(PUMP_FUN_API_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    
    if (!res.ok) {
      console.error('Pump.fun API failed:', res.status)
      return null
    }
    
    const data = await res.json()
    
    // Check if already graduated
    if (data.complete === true) {
      return {
        progress: 100,
        solInCurve: data.real_sol_reserves ? data.real_sol_reserves / 1e9 : 0,
        graduated: true,
        kingOfTheHill: false
      }
    }
    
    // Calculate progress based on tokens sold from bonding curve
    // Progress = 1 - (current_tokens / initial_tokens)
    if (data.real_token_reserves !== undefined) {
      const realSol = data.real_sol_reserves ? data.real_sol_reserves / 1e9 : 0
      const progress = (1 - (data.real_token_reserves / INITIAL_REAL_TOKEN_RESERVES)) * 100
      
      console.log(`Bonding curve: ${realSol.toFixed(2)} SOL, ${progress.toFixed(1)}% tokens sold`)
      
      return {
        progress: Math.min(100, Math.max(0, progress)),
        solInCurve: realSol,
        graduated: false,
        kingOfTheHill: data.king_of_the_hill_timestamp !== null
      }
    }
    
    return null
  } catch (err) {
    console.error('getBondingCurveProgress error:', err.message)
    return null
  }
}

function quantumDogeMeter(usdSize, side = 'BUY') {
  const buyEmojis = ['⚛️', '💚', '🟢', '✅', '💎']
  const sellEmojis = ['🌀', '🔴', '❌', '📉', '💨']
  
  const emojis = side === 'SELL' ? sellEmojis : buyEmojis
  const e1 = pick(emojis)
  const e2 = pick(emojis)
  
  const sizeLabels = {
    mega: ['MEGA WHALE 🐋', 'GIGANTIC 🏔️', 'MASSIVE 💥', 'LEGENDARY 👑', 'NUCLEAR ☢️'],
    whale: ['WHALE 🐳', 'HUGE 🦣', 'MAJOR 🎯', 'SIGNIFICANT 📊', 'POWERFUL 💪'],
    strong: ['STRONG 💪', 'SOLID 🪨', 'NOTABLE 📌', 'HEALTHY 💚', 'RESPECTABLE 👍'],
    medium: ['MEDIUM 📊', 'MODERATE 📈', 'DECENT 👌', 'STANDARD 📋', 'NORMAL 🔄'],
    small: ['SMALL 🐜', 'MINI 🔹', 'TINY 🌱', 'MICRO 🔬', 'HUMBLE 🙏'],
  }

  if (usdSize >= MEGA_WHALE_USD) return `${e1}${e2}${e1}${e2}${e1}🐕 ${pick(sizeLabels.mega)}`
  if (usdSize >= WHALE_USD) return `${e1}${e2}${e1}${e2}🐕 ${pick(sizeLabels.whale)}`
  if (usdSize >= 250) return `${e1}${e2}${e1}🐕 ${pick(sizeLabels.strong)}`
  if (usdSize >= 50) return `${e1}${e2}🐕 ${pick(sizeLabels.medium)}`
  return `${e1}🐕 ${pick(sizeLabels.small)}`
}

function buildFlags({ priceChangePct, marketCapChangePct, volumeDelta, side }) {
  const flags = []

  // Volume-based flags with variety
  const whaleEmojis = ['🐋', '🦣', '🏔️', '👑']
  const smallWhaleEmojis = ['🐳', '🐬', '🦈', '💦']
  
  if (volumeDelta >= MEGA_WHALE_USD) flags.push(`${pick(whaleEmojis)} ${pick(['Mega whale', 'HUGE move', 'Gigantic', 'Monster trade'])}`)
  else if (volumeDelta >= WHALE_USD) flags.push(`${pick(smallWhaleEmojis)} ${pick(['Whale', 'Big fish', 'Major player', 'Significant'])}`)

  // Price movement flags
  const pumpEmojis = ['🚀', '📈', '🔥', '⚡', '💥']
  const dumpEmojis = ['📉', '⬇️', '🔻', '💀', '🪂']
  
  if (priceChangePct >= PUMP_THRESHOLD_PCT) flags.push(`${pick(pumpEmojis)} ${pick(['PUMPING', 'Mooning', 'Blasting off', 'Ripping'])}`)
  if (priceChangePct <= DUMP_THRESHOLD_PCT) flags.push(`${pick(dumpEmojis)} ${pick(['DUMPING', 'Dropping', 'Falling', 'Bleeding'])}`)
  if (marketCapChangePct <= DRAIN_THRESHOLD_PCT) flags.push(`🩸 ${pick(['MC Drain', 'Cap bleeding', 'Liquidity exit', 'Value drop'])}`)
  if (marketCapChangePct <= RUG_THRESHOLD_PCT) flags.push(`🚨 ${pick(['RUG ALERT', 'DANGER', 'EXTREME DROP', 'WARNING'])}`)

  // Flow indicators with variety
  if (side === 'BUY') flags.push(pick(['🟢 Buy flow', '💚 Buying', '📗 Green zone', '✅ Inflow']))
  if (side === 'SELL') flags.push(pick(['🔴 Sell flow', '❤️‍🔥 Selling', '📕 Red zone', '❌ Outflow']))
  if (side === 'MIXED') flags.push(pick(['🟠 Mixed flow', '🎭 Both sides', '⚔️ Battle', '🔀 Chaotic']))

  return flags
}

async function sendQuantumDoge(caption, refreshData = true) {
  const animationPath = join(__dirname, 'qdogesol.mov')
  
  // Siivoa vanhat viestit ennen uuden lähettämistä
  await cleanupOldMessages()
  
  // Hae tuorein data juuri ennen lähettämistä
  let finalCaption = caption
  if (refreshData) {
    const liveData = await fetchLiveData()
    if (liveData) {
      const livePrice = num(liveData.priceUsd)
      const liveMcap = num(liveData.marketCap)
      const liveVol = num(liveData.volume?.h24)
      const liveBuys = num(liveData.txns?.h24?.buys)
      const liveSells = num(liveData.txns?.h24?.sells)
      const bondingCurve = await getBondingCurveProgress()
      
      // Korvaa vanhat arvot tuoreilla - etsi ja korvaa rivit
      const timestamp = new Date().toLocaleTimeString('en-US', { 
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
      })
      
      // Päivitä caption tuoreilla arvoilla
      finalCaption = finalCaption
        .replace(/⏰ Time: <code>[^<]+<\/code>/, `⏰ Time: <code>${timestamp} 🔴LIVE</code>`)
        .replace(/Price: <b>\$[^<]+<\/b>/, `Price: <b>${money(livePrice)}</b>`)
        .replace(/MCap: <b>\$[^<]+<\/b>/, `MCap: <b>${money(liveMcap)}</b>`)
        .replace(/Vol 24h: <b>\$[^<]+<\/b>/, `Vol 24h: <b>${money(liveVol)}</b>`)
        .replace(/🟢 Buys: <b>\d+<\/b>/, `🟢 Buys: <b>${liveBuys}</b>`)
        .replace(/🔴 Sells: <b>\d+<\/b>/, `🔴 Sells: <b>${liveSells}</b>`)
      
      console.log(`Live data refresh: Price=${money(livePrice)}, MCap=${money(liveMcap)}, Buys=${liveBuys}, Sells=${liveSells}`)
    }
  }
  
  for (const chatId of chatIds) {
    try {
      const sentMsg = await bot.telegram.sendAnimation(
        chatId,
        { source: createReadStream(animationPath) },
        {
          caption: finalCaption,
          parse_mode: 'HTML',
        }
      )
      
      // Tallenna viesti-ID poistoa varten
      if (!sentMessages.has(chatId)) {
        sentMessages.set(chatId, [])
      }
      sentMessages.get(chatId).push({
        messageId: sentMsg.message_id,
        sentAt: Date.now()
      })
      
      console.log(`Alert sent to ${chatId} (msg ${sentMsg.message_id})`)
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message)
      // Poista ryhmä jos botti on poistettu sieltä
      if (err.message.includes('chat not found') || err.message.includes('bot was kicked')) {
        chatIds.delete(chatId)
        sentMessages.delete(chatId)
        console.log(`Removed invalid chat: ${chatId}`)
      }
    }
  }
}

async function sendIdleVideo(caption, refreshData = true) {
  const videoPath = join(__dirname, 'No_new_swaps.mp4')
  
  // Siivoa vanhat viestit ennen uuden lähettämistä
  await cleanupOldMessages()
  
  // Hae tuorein data juuri ennen lähettämistä
  let finalCaption = caption
  if (refreshData) {
    const liveData = await fetchLiveData()
    if (liveData) {
      const livePrice = num(liveData.priceUsd)
      const liveMcap = num(liveData.marketCap)
      const liveVol = num(liveData.volume?.h24)
      const liveBuys = num(liveData.txns?.h24?.buys)
      const liveSells = num(liveData.txns?.h24?.sells)
      
      const timestamp = new Date().toLocaleTimeString('en-US', { 
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false 
      })
      
      finalCaption = finalCaption
        .replace(/⏰ Time: <code>[^<]+<\/code>/, `⏰ Time: <code>${timestamp} 🔴LIVE</code>`)
        .replace(/Price: <b>\$[^<]+<\/b>/, `Price: <b>${money(livePrice)}</b>`)
        .replace(/MCap: <b>\$[^<]+<\/b>/, `MCap: <b>${money(liveMcap)}</b>`)
        .replace(/Vol 24h: <b>\$[^<]+<\/b>/, `Vol 24h: <b>${money(liveVol)}</b>`)
        .replace(/🟢 Buys: <b>\d+<\/b>/, `🟢 Buys: <b>${liveBuys}</b>`)
        .replace(/🔴 Sells: <b>\d+<\/b>/, `🔴 Sells: <b>${liveSells}</b>`)
      
      console.log(`Idle live data refresh: Price=${money(livePrice)}, MCap=${money(liveMcap)}`)
    }
  }
  
  for (const chatId of chatIds) {
    try {
      const sentMsg = await bot.telegram.sendAnimation(
        chatId,
        { source: createReadStream(videoPath) },
        {
          caption: finalCaption,
          parse_mode: 'HTML',
        }
      )
      
      // Tallenna viesti-ID poistoa varten
      if (!sentMessages.has(chatId)) {
        sentMessages.set(chatId, [])
      }
      sentMessages.get(chatId).push({
        messageId: sentMsg.message_id,
        sentAt: Date.now()
      })
      
      console.log(`Idle video sent to ${chatId} (msg ${sentMsg.message_id})`)
    } catch (err) {
      console.error(`Failed to send idle video to ${chatId}:`, err.message)
      if (err.message.includes('chat not found') || err.message.includes('bot was kicked')) {
        chatIds.delete(chatId)
        sentMessages.delete(chatId)
        console.log(`Removed invalid chat: ${chatId}`)
      }
    }
  }
}

async function maybeAutoBuy(snapshot) {
  if (!AUTO_BUY_ENABLED) return

  const { side, marketCap, priceChangePct, volumeDelta } = snapshot

  const looksOkay =
    side === 'BUY' &&
    marketCap >= AUTO_BUY_MIN_LIQUIDITY &&
    priceChangePct <= AUTO_BUY_MAX_PRICE_CHANGE_PCT &&
    volumeDelta >= 50

  if (!looksOkay) return

  console.log('[AUTO-BUY STUB] Trigger would fire here:', snapshot)

  // Tähän kohtaan voi myöhemmin liittää oikean wallet/RPC/DEX-trade-logiikan.
  // Nyt tämä EI osta mitään, vaan toimii turvallisesti vain stubina.
}

let rateLimitBackoff = 0  // Lisäviive rate limitin jälkeen

async function checkTrades() {
  try {
    // Jos ollaan rate limitattu, odota extra
    if (rateLimitBackoff > 0) {
      console.log(`Rate limit backoff: waiting ${rateLimitBackoff}ms extra`)
      rateLimitBackoff = Math.max(0, rateLimitBackoff - POLL_MS)
      return
    }

    const res = await fetch(PAIR_URL)
    if (res.status === 429) {
      console.error('DexScreener rate limited - backing off 2 minutes')
      rateLimitBackoff = 120000  // 2 minuuttia
      return
    }
    if (!res.ok) {
      console.error('DexScreener fetch failed:', res.status, res.statusText)
      return
    }

    const data = await res.json()
    const pair = data?.pair

    if (!pair) {
      console.error('No pair in response')
      return
    }

    const baseToken = pair.baseToken?.symbol || 'LAIKA'
    const price = num(pair.priceUsd)
    const volume24h = num(pair.volume?.h24)
    const marketCap = num(pair.marketCap)
    const buys24h = num(pair.txns?.h24?.buys)
    const sells24h = num(pair.txns?.h24?.sells)

    if (!state.initialized) {
      state.initialized = true
      state.lastPrice = price
      state.lastMarketCap = marketCap
      state.lastVolume24h = volume24h
      state.lastBuys24h = buys24h
      state.lastSells24h = sells24h
      state.lastIdleReportAt = Date.now()
      console.log('Initial state loaded')
      return
    }

    const buyDelta = Math.max(0, buys24h - state.lastBuys24h)
    const sellDelta = Math.max(0, sells24h - state.lastSells24h)
    const volumeDelta = Math.max(0, volume24h - state.lastVolume24h)

    const priceChangePct = pctChange(price, state.lastPrice)
    const marketCapChangePct = pctChange(marketCap, state.lastMarketCap)

    const hasSwapActivity = buyDelta > 0 || sellDelta > 0

    let side = 'MIXED'
    if (buyDelta > 0 && sellDelta === 0) side = 'BUY'
    else if (sellDelta > 0 && buyDelta === 0) side = 'SELL'
    else if (buyDelta > sellDelta) side = 'BUY'
    else if (sellDelta > buyDelta) side = 'SELL'

    // Fetch bonding curve progress
    const bondingCurve = await getBondingCurveProgress()
    const bondingCurveText = bondingCurve
      ? bondingCurve.graduated
        ? '🎓 <b>GRADUATED TO RAYDIUM!</b>'
        : `📈 Bonding Curve:\n${bondingCurveBar(bondingCurve.progress)}${bondingCurve.kingOfTheHill ? ' 👑' : ''}`
      : ''

    if (hasSwapActivity) {
      const meter = quantumDogeMeter(volumeDelta, side)
      const flags = buildFlags({ priceChangePct, marketCapChangePct, volumeDelta, side })
      const excitement = getExcitementLevel(volumeDelta, priceChangePct)
      const momentum = getMomentum(priceChangePct)

      const header = side === 'BUY' 
        ? pick(buyHeaders)
        : side === 'SELL' 
          ? pick(sellHeaders)
          : pick(mixedHeaders)

      const priceDirection = priceChangePct >= 0 ? '↗️' : '↘️'
      const mcapDirection = marketCapChangePct >= 0 ? '📈' : '📉'
      const volBar = volumeBar(volumeDelta, MEGA_WHALE_USD, 8)
      
      const caption = [
        `${excitement.border}`,
        `${header} ${excitement.emoji}`,
        `${excitement.border}`,
        '',
        `🪙 Token: <b>${baseToken}</b>`,
        `⏰ Time: <code>${timeAgo()}</code>`,
        `🎯 ${meter}`,
        '',
        `💰 Swap Size: <b>${money(volumeDelta)}</b>`,
        `📊 Volume: [${volBar}]`,
        '',
        bondingCurveText,
        '',
        `${priceDirection} Price: <b>${money(price)}</b> (${shortPct(priceChangePct)})`,
        `${mcapDirection} MCap: <b>${money(marketCap)}</b> (${shortPct(marketCapChangePct)})`,
        `📦 Vol 24h: <b>${money(volume24h)}</b>`,
        '',
        `🟢 Buys: <b>${buys24h}</b> (+${buyDelta}) | 🔴 Sells: <b>${sells24h}</b> (+${sellDelta})`,
        `${momentum}`,
        '',
        `📡 Chain: Solana | ${pick(quantumPhrases)}`,
        '',
        flags.length ? `⚡ ${flags.join(' • ')}` : '',
        '',
        `${pick(closingPhrases)}`,
        `🔗 ${DEX_URL}`,
      ]
        .filter(Boolean)
        .join('\n')

      const signature = `${side}|${buyDelta}|${sellDelta}|${volumeDelta.toFixed(2)}|${price.toFixed(12)}|${marketCap.toFixed(2)}`

      if (signature !== state.lastAlertSignature) {
        await sendQuantumDoge(caption)
        state.lastAlertSignature = signature
        state.lastIdleReportAt = Date.now()
        
        // Päivitä tila heti alertin jälkeen tuoreimmalla datalla
        state.lastPrice = price
        state.lastMarketCap = marketCap
        state.lastVolume24h = volume24h
        state.lastBuys24h = buys24h
        state.lastSells24h = sells24h
      }

      await maybeAutoBuy({
        side,
        marketCap,
        price,
        priceChangePct,
        volumeDelta,
        baseToken,
      })
    } else if (Date.now() - state.lastIdleReportAt >= IDLE_REPORT_MS) {
      const flags = buildFlags({ priceChangePct, marketCapChangePct, volumeDelta: 0, side: 'MIXED' })
      const priceDirection = priceChangePct >= 0 ? '↗️' : '↘️'
      const mcapDirection = marketCapChangePct >= 0 ? '📈' : '📉'

      const idleEmojis = ['🐕💤', '😴🐕', '🧘🐕', '☕🐕', '🌙🐕', '🛋️🐕']
      
      const caption = [
        '──────────────────',
        pick(idleHeaders),
        pick(idleSubtitles),
        '──────────────────',
        '',
        `🪙 Token: <b>${baseToken}</b>`,
        `⏰ Time: <code>${timeAgo()}</code>`,
        `🎯 ${pick(idleEmojis)} Idle mode`,
        '',
        bondingCurveText,
        '',
        `${priceDirection} Price: <b>${money(price)}</b> (${shortPct(priceChangePct)})`,
        `${mcapDirection} MCap: <b>${money(marketCap)}</b> (${shortPct(marketCapChangePct)})`,
        `📦 Vol 24h: <b>${money(volume24h)}</b>`,
        '',
        `🟢 Buys: <b>${buys24h}</b> | 🔴 Sells: <b>${sells24h}</b>`,
        '',
        `📡 Chain: Solana | ⚛️ ${pick(['Field: Stable', 'Quantum: Quiet', 'Energy: Conserved', 'State: Observing'])}`,
        flags.length ? `⚡ ${flags.join(' • ')}` : '',
        '',
        `${pick(['💎 Patience is profit', '🧘 Zen trading', '☕ Grab a coffee', '📖 Time to DYOR', '🎯 Stay ready'])}`,
        `🔗 ${DEX_URL}`,
      ]
        .filter(Boolean)
        .join('\n')

      await sendIdleVideo(caption)
      state.lastIdleReportAt = Date.now()
    }

    state.lastPrice = price
    state.lastMarketCap = marketCap
    state.lastVolume24h = volume24h
    state.lastBuys24h = buys24h
    state.lastSells24h = sells24h
  } catch (err) {
    console.error('checkTrades error:', err)
  }
}

setInterval(checkTrades, POLL_MS)
checkTrades() // Aja heti käynnistyksessä

const startupMessages = [
  '⚛️ Quantum Doge Bot ONLINE - Monitoring DexScreener...',
  '🐕 QDOGE Alert System initialized - Ready for action!',
  '🚀 Bot launched - All systems operational!',
  '🔮 Quantum monitoring activated - Let\'s go!',
]
console.log(startupMessages[Math.floor(Math.random() * startupMessages.length)])

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
