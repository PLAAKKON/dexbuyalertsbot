import 'dotenv/config'
import { Telegraf } from 'telegraf'

const bot = new Telegraf(process.env.BOT_TOKEN)

bot.start((ctx) => {
  ctx.reply("DexBuyAlerts bot running 🚀")
})

bot.launch()

console.log("Bot started")
