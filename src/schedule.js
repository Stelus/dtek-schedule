import { chromium } from "playwright"

import {
  checkIsNight,
  createPeriod,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
  deleteLastMessage,
  useSchedule,
} from "./helpers.js"
import {
  GROUP,
  hours,
  PowerState,
  SHUTDOWNS_DATA_MATCHER,
  SHUTDOWNS_PAGE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRIES_TIMEOUT,
  RETRIES_MAX_COUNT,
} from "./constants.js"

let sendNotificationRetries = 0
let getShutdownsDataRetries = 0

const getShutdownsData = async () => {
  console.log("🌀 Getting shutdowns data...")

  const browser = await chromium.launch({ headless: true })

  try {
    const browserPage = await browser.newPage()
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const html = await browserPage.content()
    const match = html.match(SHUTDOWNS_DATA_MATCHER)

    if (!match) {
      throw new Error("not found")
    }

    const data = JSON.parse(match[1])
    // HTML сторінки кешується; сайт сам доганяє свіжі дані цим запитом
    const fresh = await browserPage.evaluate(
      (update) =>
        new Promise((resolve) =>
          $.post(
            document.querySelector('meta[name="ajaxUrl"]').content,
            { method: "checkDisconUpdate", update },
            resolve,
            "json"
          ).fail(() => resolve(null))
        ),
      data.update
    )
    if (fresh?.fact) Object.assign(data, fresh.fact)
    console.log(`📢 DTEK data update: ${data.update}`)
    // popup "Шановні клієнти!" — тут DTEK пише про аварійні відключення
    data.attention = (
      await browserPage.locator("#modal-attention").allInnerTexts()
    )
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
    console.log("✅ Getting shutdowns data finished.")
    return data
  } catch (error) {
    console.error(`❌ Getting shutdowns data failed: ${error.message}.`)
  } finally {
    await browser.close()
  }

  if (getShutdownsDataRetries < RETRIES_MAX_COUNT) {
    console.log("🌀 Try getting shutdowns data again...")
    await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
    getShutdownsDataRetries++
    return await getShutdownsData()
  }

  throw Error(
    `❌ Getting shutdowns data failed after ${RETRIES_MAX_COUNT} retries.`
  )
}

function generateSchedule({ data, today }) {
  console.log("🌀 Generating schedule...")

  try {
    const hoursStates = data[today][GROUP]
    if (!hoursStates) throw Error(`group ${GROUP} not found`)
    const [schedule, setSchedule] = useSchedule([])

    hours.forEach((hour) => {
      const state = hoursStates[hour + 1]

      switch (state) {
        case PowerState.ON:
          setSchedule(createPeriod({ hour, power: true }))
          break

        case PowerState.OFF:
          setSchedule(createPeriod({ hour, power: false }))
          break

        case PowerState.HALF_ON:
          setSchedule(createPeriod({ hour, endMin: 30, power: true }))
          setSchedule(createPeriod({ hour, startMin: 30, power: false }))
          break

        case PowerState.HALF_OFF:
          setSchedule(createPeriod({ hour, endMin: 30, power: false }))
          setSchedule(createPeriod({ hour, startMin: 30, power: true }))
          break
      }
    })

    console.log("✅ Generating schedule finished.")

    return schedule
  } catch (error) {
    throw Error(`❌ Generating schedule failed: ${error.message}.`)
  }
}

function generateMessage(schedule = [], update, alert, details) {
  console.log("🌀 Generating message...")

  const isShutdownsExists = schedule.some(({ power }) => !power)
  isShutdownsExists
    ? console.log("🪫 Power shutdowns detected!")
    : console.log("🔋 No power shutdowns!")

  const scheduleLines = [
    ...(isShutdownsExists
      ? schedule
          .filter(({ power }) => !power)
          .map(({ begin, end }) => `🪫 <code>${begin} — ${end}</code>`)
      : schedule.map(({ begin, end }) => `🔋 <code>${begin} — ${end}</code>`)),
  ].join("\n")
  // alert входить у scheduleText, щоб його поява/зникнення давали нове повідомлення
  const scheduleText = [alert, scheduleLines].filter(Boolean).join("\n\n")

  const text = [
    // details лише в text: зміна формулювання попапу редагує, а не шле нове
    alert && details
      ? `${alert}\n<blockquote expandable>${details}</blockquote>`
      : alert,
    schedule.length &&
      `⚡️ <b>Графік відключень на сьогодні:</b>\n${scheduleLines}`,
    `📢 <i>${update}</i>\n🤖 <i>${getCurrentTime()}</i>`,
  ]
    .filter(Boolean)
    .join("\n\n")

  return { text, scheduleText }
}

async function sendNotification({ text, scheduleText }) {
  if (!TELEGRAM_BOT_TOKEN) throw Error("❌ Missing telegram bot token.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending notification...")

  const lastMessage = loadLastMessage() || {}
  const isScheduleChanged = lastMessage.scheduleText !== scheduleText
  const isEdit = Boolean(lastMessage.message_id) && !isScheduleChanged
  const isReply = Boolean(lastMessage.message_id) && isScheduleChanged

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${
        isEdit ? "editMessageText" : "sendMessage"
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_notification: checkIsNight(),
          message_id: isEdit ? lastMessage.message_id : undefined,
          reply_parameters: isReply
            ? {
                message_id: lastMessage.message_id,
                allow_sending_without_reply: true,
              }
            : undefined,
        }),
      }
    )

    const data = await response.json()

    if (data.description?.includes("not modified")) {
      console.log("🟡 Notification not changed.")
      return
    }
    if (!data.ok) {
      deleteLastMessage()
      throw Error(data.description)
    }

    saveLastMessage({ ...data.result, scheduleText })

    console.log("🟢 Notification sent.")
  } catch (error) {
    console.error(`❌ Sending notification failed: ${error.message}.`)

    if (sendNotificationRetries < RETRIES_MAX_COUNT) {
      console.log("🌀 Try sending notification again...")
      await new Promise((resolve) => setTimeout(resolve, RETRIES_TIMEOUT))
      sendNotificationRetries++
      return await sendNotification({ text, scheduleText })
    }

    throw Error(
      `❌ Sending notification failed after ${RETRIES_MAX_COUNT} retries.`
    )
  }
}

async function run() {
  const data = await getShutdownsData()

  // ponytail: шукаємо обидва слова будь-де в попапі, без розбору речень;
  // ускладнити, якщо DTEK почне згадувати Дніпро не про аварійні відключення
  const isDniproEmergency =
    /екстрен/i.test(data.attention) ||
    /аварійн/i.test(data.attention) &&
    /Дніпр[оаі](?!\p{L})/u.test(data.attention) // не "Дніпровський район"
  if (isDniproEmergency) console.log("🚨 Emergency shutdowns in Dnipro!")
  const alert =
    isDniproEmergency &&
    "🚨 <b>Графіки не діють — аварійні відключення в Дніпрі</b> 😢"

  const groups = data.data?.[data.today] ?? {}
  const hasSchedule = Object.keys(groups).length > 0
  if (!hasSchedule && !alert) {
    console.log("🔋 No schedule for today.")
    return
  }

  const schedule = hasSchedule ? generateSchedule(data) : []
  const details = data.attention
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
  const message = generateMessage(schedule, data.update, alert, details)

  await sendNotification(message)
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
