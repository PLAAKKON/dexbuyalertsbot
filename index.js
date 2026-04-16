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
    ctx.reply('⚛️🐕 Quantum Doge Bot\n\nLisää minut ryhmään ja lähetä /start siellä!')
    return
  }
  chatIds.add(chatId)
  console.log(`Registered chat: ${chatId} (${ctx.chat.title})`)
  ctx.reply(`✅ Quantum Doge alerts aktivoitu tälle ryhmälle!\n\nChat ID: ${chatId}`)
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

// Bonding curve progress bar generator
function bondingCurveBar(percentage) {
  const pct = Math.min(100, Math.max(0, percentage))
  const filled = Math.round(pct / 10)
  const empty = 10 - filled
  // Use colored balls for animated effect
  const filledBalls = '🟢'.repeat(filled)
  const emptyBalls = '⚫'.repeat(empty)
  return `${filledBalls}${emptyBalls} ${pct.toFixed(1)}%`
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
  const buy = ['⚛️🐕', '⚛️⚛️🐕', '⚛️⚛️⚛️🐕', '⚛️⚛️⚛️⚛️🐕', '⚛️⚛️⚛️⚛️⚛️🐕']
  const sell = ['🌀🐕', '🌀🌀🐕', '🌀🌀🌀🐕', '🌀🌀🌀🌀🐕', '🌀🌀🌀🌀🌀🐕']
  const set = side === 'SELL' ? sell : buy

  if (usdSize >= MEGA_WHALE_USD) return `${set[4]} MEGA WHALE`
  if (usdSize >= WHALE_USD) return `${set[3]} WHALE`
  if (usdSize >= 250) return `${set[2]} STRONG`
  if (usdSize >= 50) return `${set[1]} MEDIUM`
  return `${set[0]} SMALL`
}

function buildFlags({ priceChangePct, marketCapChangePct, volumeDelta, side }) {
  const flags = []
  
  // Animated ball patterns for visual effect
  const ballPatterns = ['⚪🔵🟢', '🔵🟢⚪', '🟢⚪🔵']
  const animBalls = ballPatterns[Math.floor(Date.now() / 1000) % 3]

  if (volumeDelta >= MEGA_WHALE_USD) flags.push(`🐋 Mega whale ${animBalls}`)
  else if (volumeDelta >= WHALE_USD) flags.push(`🐳 Whale ${animBalls}`)

  if (priceChangePct >= PUMP_THRESHOLD_PCT) flags.push(`🚀 Pump ${animBalls}`)
  if (priceChangePct <= DUMP_THRESHOLD_PCT) flags.push('📉 Dump 🔴🔴🔴')
  if (marketCapChangePct <= DRAIN_THRESHOLD_PCT) flags.push('🩸 MC drain 🔴🟠🔴')
  if (marketCapChangePct <= RUG_THRESHOLD_PCT) flags.push('🚨 Rug risk ⚠️⚠️⚠️')

  if (side === 'BUY') flags.push(`🟢 Buy flow ${animBalls}`)
  if (side === 'SELL') flags.push('🔴 Sell flow 🔴🟠🔴')
  if (side === 'MIXED') flags.push('🟠 Mixed flow 🟠⚪🟠')

  return flags
}

async function sendQuantumDoge(caption) {
  const animationPath = join(__dirname, 'qdogesol.mov')
  
  // Siivoa vanhat viestit ennen uuden lähettämistä
  await cleanupOldMessages()
  
  for (const chatId of chatIds) {
    try {
      const sentMsg = await bot.telegram.sendAnimation(
        chatId,
        { source: createReadStream(animationPath) },
        {
          caption,
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

async function sendIdlePhoto(caption) {
  const photoPath = join(__dirname, 'qdogesol2.png')
  
  // Siivoa vanhat viestit ennen uuden lähettämistä
  await cleanupOldMessages()
  
  for (const chatId of chatIds) {
    try {
      const sentMsg = await bot.telegram.sendPhoto(
        chatId,
        { source: createReadStream(photoPath) },
        {
          caption,
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
      
      console.log(`Idle photo sent to ${chatId} (msg ${sentMsg.message_id})`)
    } catch (err) {
      console.error(`Failed to send idle photo to ${chatId}:`, err.message)
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

      const header =
        side === 'BUY'
          ? '🔥 BUY ACTIVITY'
          : side === 'SELL'
            ? '🔻 SELL ACTIVITY'
            : '🔄 SWAP ACTIVITY'

      const caption = [
        header,
        '',
        `Token: <b>${baseToken}</b>`,
        `Quantum Doge: ${meter}`,
        `Estimated swap size: <b>${money(volumeDelta)}</b>`,
        `📡 Chain: Solana`,
        `⚛️ Quantum Field: ACTIVE`,
        '',
        bondingCurveText,
        '',
        `Price: <b>${money(price)}</b> (${shortPct(priceChangePct)})`,
        `Market Cap: <b>${money(marketCap)}</b> (${shortPct(marketCapChangePct)})`,
        `Volume 24h: <b>${money(volume24h)}</b>`,
        `Buys 24h: <b>${buys24h}</b> | Sells 24h: <b>${sells24h}</b>`,
        `New: +${buyDelta} buys, +${sellDelta} sells`,
        flags.length ? `Flags: ${flags.join(' • ')}` : '',
        '',
        DEX_URL,
      ]
        .filter(Boolean)
        .join('\n')

      const signature = `${side}|${buyDelta}|${sellDelta}|${volumeDelta.toFixed(2)}|${price.toFixed(12)}|${marketCap.toFixed(2)}`

      if (signature !== state.lastAlertSignature) {
        await sendQuantumDoge(caption)
        state.lastAlertSignature = signature
        state.lastIdleReportAt = Date.now()
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

      const caption = [
        '⏸️ NO NEW SWAPS',
        '😎 HOLDERS CHILLING 😎',
        '',
        `Token: <b>${baseToken}</b>`,
        `Quantum Doge: 😴🐕 Idle`,
        `📡 Chain: Solana`,
        '',
        bondingCurveText,
        '',
        `Price: <b>${money(price)}</b> (${shortPct(priceChangePct)})`,
        `Market Cap: <b>${money(marketCap)}</b> (${shortPct(marketCapChangePct)})`,
        `Volume 24h: <b>${money(volume24h)}</b>`,
        `Buys 24h: <b>${buys24h}</b> | Sells 24h: <b>${sells24h}</b>`,
        flags.length ? `Flags: ${flags.join(' • ')}` : '',
        '',
        DEX_URL,
      ]
        .filter(Boolean)
        .join('\n')

      await sendIdlePhoto(caption)
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

console.log('Bot started - monitoring DexScreener for all registered groups')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
