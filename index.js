import 'dotenv/config'
import { Telegraf } from 'telegraf'

const bot = new Telegraf(process.env.BOT_TOKEN)

const CHAT_ID = '-1003701840242'

// Seurattava pair
const PAIR_ID = 'E2AQyiZKYftVRvR4g8VMMBpfD86PiGicWWARKuJdpump'
const PAIR_URL = `https://api.dexscreener.com/latest/dex/pairs/solana/${PAIR_ID}`
const DEX_URL = `https://dexscreener.com/solana/${PAIR_ID}`

// Käytetään sinun animaatiota
const DOGE_ANIMATION = '/mnt/data/qdogesol.mov'

// Asetukset
const POLL_MS = 15000
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
  lastLiquidity: null,
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
  return `$${num(v).toFixed(2)}`
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

function buildFlags({ priceChangePct, liquidityChangePct, volumeDelta, side }) {
  const flags = []

  if (volumeDelta >= MEGA_WHALE_USD) flags.push('🐋 Mega whale')
  else if (volumeDelta >= WHALE_USD) flags.push('🐳 Whale')

  if (priceChangePct >= PUMP_THRESHOLD_PCT) flags.push('🚀 Pump')
  if (priceChangePct <= DUMP_THRESHOLD_PCT) flags.push('📉 Dump')
  if (liquidityChangePct <= DRAIN_THRESHOLD_PCT) flags.push('🩸 Liquidity drain')
  if (liquidityChangePct <= RUG_THRESHOLD_PCT) flags.push('🚨 Rug risk')

  if (side === 'BUY') flags.push('🟢 Buy flow')
  if (side === 'SELL') flags.push('🔴 Sell flow')
  if (side === 'MIXED') flags.push('🟠 Mixed flow')

  return flags
}

async function sendQuantumDoge(caption) {
  await bot.telegram.sendAnimation(
    CHAT_ID,
    { source: DOGE_ANIMATION },
    {
      caption,
      parse_mode: 'HTML',
    }
  )
}

async function maybeAutoBuy(snapshot) {
  if (!AUTO_BUY_ENABLED) return

  const { side, liquidity, priceChangePct, volumeDelta } = snapshot

  const looksOkay =
    side === 'BUY' &&
    liquidity >= AUTO_BUY_MIN_LIQUIDITY &&
    priceChangePct <= AUTO_BUY_MAX_PRICE_CHANGE_PCT &&
    volumeDelta >= 50

  if (!looksOkay) return

  console.log('[AUTO-BUY STUB] Trigger would fire here:', snapshot)

  // Tähän kohtaan voi myöhemmin liittää oikean wallet/RPC/DEX-trade-logiikan.
  // Nyt tämä EI osta mitään, vaan toimii turvallisesti vain stubina.
}

async function checkTrades() {
  try {
    const res = await fetch(PAIR_URL)
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
    const liquidity = num(pair.liquidity?.usd)
    const buys24h = num(pair.txns?.h24?.buys)
    const sells24h = num(pair.txns?.h24?.sells)

    if (!state.initialized) {
      state.initialized = true
      state.lastPrice = price
      state.lastLiquidity = liquidity
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
    const liquidityChangePct = pctChange(liquidity, state.lastLiquidity)

    const hasSwapActivity = buyDelta > 0 || sellDelta > 0

    let side = 'MIXED'
    if (buyDelta > 0 && sellDelta === 0) side = 'BUY'
    else if (sellDelta > 0 && buyDelta === 0) side = 'SELL'
    else if (buyDelta > sellDelta) side = 'BUY'
    else if (sellDelta > buyDelta) side = 'SELL'

    if (hasSwapActivity) {
      const meter = quantumDogeMeter(volumeDelta, side)
      const flags = buildFlags({ priceChangePct, liquidityChangePct, volumeDelta, side })

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
        `Liquidity: <b>${money(liquidity)}</b> (${shortPct(liquidityChangePct)})`,
        `Volume 24h: <b>${money(volume24h)}</b>`,
        `Buys Δ: <b>${buyDelta}</b> | Sells Δ: <b>${sellDelta}</b>`,
        flags.length ? `Flags: ${flags.join(' • ')}` : '',
        '',
        DEX_URL,
      ]
        .filter(Boolean)
        .join('\n')

      const signature = `${side}|${buyDelta}|${sellDelta}|${volumeDelta.toFixed(2)}|${price.toFixed(12)}|${liquidity.toFixed(2)}`

      if (signature !== state.lastAlertSignature) {
        await sendQuantumDoge(caption)
        state.lastAlertSignature = signature
        state.lastIdleReportAt = Date.now()
      }

      await maybeAutoBuy({
        side,
        liquidity,
        price,
        priceChangePct,
        volumeDelta,
        baseToken,
      })
    } else if (Date.now() - state.lastIdleReportAt >= IDLE_REPORT_MS) {
      const flags = buildFlags({ priceChangePct, liquidityChangePct, volumeDelta: 0, side: 'MIXED' })

      const caption = [
        '⏸️ NO NEW SWAPS',
        '',
        `Token: <b>${baseToken}</b>`,
        `Quantum Doge: 😴🐕 Idle`,
        `📡 Chain: Solana`,
        '',
        `Price: <b>${money(price)}</b> (${shortPct(priceChangePct)})`,
        `Liquidity: <b>${money(liquidity)}</b> (${shortPct(liquidityChangePct)})`,
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
    state.lastLiquidity = liquidity
    state.lastVolume24h = volume24h
    state.lastBuys24h = buys24h
    state.lastSells24h = sells24h
  } catch (err) {
    console.error('checkTrades error:', err)
  }
}

setInterval(checkTrades, POLL_MS)

bot.start((ctx) => {
  ctx.reply('Quantum Doge bot running ⚛️🐕')
})

bot.launch()
console.log('Bot started')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
