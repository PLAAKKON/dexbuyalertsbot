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

  if (volumeDelta >= MEGA_WHALE_USD) flags.push('🐋 Mega whale')
  else if (volumeDelta >= WHALE_USD) flags.push('🐳 Whale')

  if (priceChangePct >= PUMP_THRESHOLD_PCT) flags.push('🚀 Pump')
  if (priceChangePct <= DUMP_THRESHOLD_PCT) flags.push('📉 Dump')
  if (marketCapChangePct <= DRAIN_THRESHOLD_PCT) flags.push('🩸 Market cap drain')
  if (marketCapChangePct <= RUG_THRESHOLD_PCT) flags.push('🚨 Rug risk')

  if (side === 'BUY') flags.push('🟢 Buy flow')
  if (side === 'SELL') flags.push('🔴 Sell flow')
  if (side === 'MIXED') flags.push('🟠 Mixed flow')

  return flags
}

async function sendQuantumDoge(caption) {
  const animationPath = join(__dirname, 'qdogesol.mov')
  
  for (const chatId of chatIds) {
    try {
      await bot.telegram.sendAnimation(
        chatId,
        { source: createReadStream(animationPath) },
        {
          caption,
          parse_mode: 'HTML',
        }
      )
      console.log(`Alert sent to ${chatId}`)
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message)
      // Poista ryhmä jos botti on poistettu sieltä
      if (err.message.includes('chat not found') || err.message.includes('bot was kicked')) {
        chatIds.delete(chatId)
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
        '',
        `Token: <b>${baseToken}</b>`,
        `Quantum Doge: 😴🐕 Idle`,
        `📡 Chain: Solana`,
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

      await sendQuantumDoge(caption)
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
