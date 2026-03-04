import 'dotenv/config'
import { Telegraf } from 'telegraf'

const bot = new Telegraf(process.env.BOT_TOKEN)

const CHAT_ID = "-1003701840242"

async function checkTrades() {

const url = "https://api.dexscreener.com/latest/dex/pairs/solana/cpkwpr7dass9krqm7tjiuvwetmzybgadbh6xcp8deuxn
const res = await fetch(url)
const data = await res.json()

const price = data.pair.priceUsd
const volume = data.pair.volume.h24
const liquidity = data.pair.liquidity.usd

const message =
`🔥 BUY ACTIVITY

Token: TOASTER
Price: $${price}

Liquidity: $${liquidity}
Volume 24h: $${volume}

https://dexscreener.com/solana/cpkwpr7dass9krqm7tjiuvwetmzybgadbh6xcp8deuxn

bot.telegram.sendMessage(CHAT_ID, message)

}

setInterval(checkTrades, 60000)

bot.start((ctx) => {
ctx.reply("DexBuyAlerts bot running 🚀")
})

bot.launch()

console.log("Bot started")
