require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ─── Константы клиники ────────────────────────────────────────────────────────

const SLOT_DURATION_MINUTES = 30;

// Рабочие часы: [startHour, endHour] включительно для первого слота.
// endHour — час, в который должен ЗАВЕРШИТЬСЯ последний приём.
const WORKING_HOURS = {
  1: { start: 9, end: 18 }, // Понедельник
  2: { start: 9, end: 18 }, // Вторник
  3: { start: 9, end: 18 }, // Среда
  4: { start: 9, end: 18 }, // Четверг
  5: { start: 9, end: 18 }, // Пятница
  6: { start: 9, end: 14 }, // Суббота
  // 0 — воскресенье: выходной (не указан намеренно)
};

// ─── Google Calendar ──────────────────────────────────────────────────────────

function getCalendarClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY in environment");
  }

  const key = rawKey.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

function logGoogleError(context, err) {
  const status = err?.response?.status;
  const message = err?.response?.data?.error?.message || err.message;
  const errors = err?.response?.data?.error?.errors;
  console.error(`[Google Calendar] ${context} — status: ${status ?? "n/a"}, message: ${message}`);
  if (errors) console.error(`[Google Calendar] details:`, JSON.stringify(errors));
}

// ─── Вспомогательные функции ─────────────────────────────────────────────────

/**
 * Генерирует все теоретически возможные слоты для заданной даты
 * с учётом рабочих часов клиники.
 * @param {string} dateStr — дата в формате YYYY-MM-DD
 * @returns {Date[]} массив начала каждого слота или пустой массив (выходной)
 */
function generateSlots(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  const dayOfWeek = date.getDay(); // 0=вс, 1=пн, ..., 6=сб

  const hours = WORKING_HOURS[dayOfWeek];
  if (!hours) return []; // выходной

  const slots = [];
  let currentHour = hours.start;
  let currentMinute = 0;

  while (true) {
    const slotStart = new Date(`${dateStr}T${pad(currentHour)}:${pad(currentMinute)}:00`);
    const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

    // Слот должен полностью завершиться до конца рабочего дня
    if (slotEnd.getHours() > hours.end || (slotEnd.getHours() === hours.end && slotEnd.getMinutes() > 0)) break;

    slots.push(slotStart);

    currentMinute += SLOT_DURATION_MINUTES;
    if (currentMinute >= 60) {
      currentMinute -= 60;
      currentHour += 1;
    }
  }

  return slots;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Форматирует время слота в читаемый вид, например "09:30"
 */
function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Возвращает true, если слот [slotStart, slotEnd) пересекается с занятым диапазоном.
 */
function isSlotBusy(slotStart, slotDurationMs, busyPeriods) {
  const slotEnd = new Date(slotStart.getTime() + slotDurationMs);
  return busyPeriods.some((busy) => {
    const busyStart = new Date(busy.start);
    const busyEnd = new Date(busy.end);
    return slotStart < busyEnd && slotEnd > busyStart;
  });
}

// ─── Обработчики инструментов VAPI ───────────────────────────────────────────

/**
 * check-availability
 * Ожидаемые аргументы: { date: "YYYY-MM-DD" }
 * Возвращает строку со списком свободных слотов или сообщение об отсутствии.
 */
async function checkAvailability({ date }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "Пожалуйста, укажите дату в формате ГГГГ-ММ-ДД, например 2025-06-15.";
  }

  const slots = generateSlots(date);
  if (slots.length === 0) {
    return `${formatDateRu(date)} — выходной день. Клиника работает с понедельника по субботу.`;
  }

  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  const dayStart = new Date(`${date}T00:00:00`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59`).toISOString();

  let freeBusyResponse;
  try {
    freeBusyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: dayStart,
        timeMax: dayEnd,
        items: [{ id: calendarId }],
      },
    });
  } catch (err) {
    logGoogleError(`checkAvailability freebusy.query date=${date}`, err);
    throw err;
  }

  const busyPeriods = freeBusyResponse.data.calendars[calendarId]?.busy || [];
  const slotDurationMs = SLOT_DURATION_MINUTES * 60 * 1000;

  const freeSlots = slots.filter((slot) => !isSlotBusy(slot, slotDurationMs, busyPeriods));

  if (freeSlots.length === 0) {
    return `На ${formatDateRu(date)} свободных окон нет. Хотите выбрать другой день?`;
  }

  const timeList = freeSlots.map(formatTime).join(", ");
  return `На ${formatDateRu(date)} доступно следующее время: ${timeList}. Какое время вам удобно?`;
}

/**
 * book-appointment
 * Ожидаемые аргументы: { patient_name, service, date, time }
 * time в формате "HH:MM"
 */
async function bookAppointment({ patient_name, service, date, time }) {
  if (!patient_name || !service || !date || !time) {
    return "Для записи нужны: имя пациента, услуга, дата и время приёма.";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "Дата должна быть в формате ГГГГ-ММ-ДД.";
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return "Время должно быть в формате ЧЧ:ММ, например 10:30.";
  }

  const startDateTime = new Date(`${date}T${time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

  // Проверяем, что слот входит в рабочие часы
  const dayOfWeek = startDateTime.getDay();
  const hours = WORKING_HOURS[dayOfWeek];
  if (!hours) {
    return `${formatDateRu(date)} — выходной день. Пожалуйста, выберите рабочий день.`;
  }

  const validSlots = generateSlots(date).map(formatTime);
  if (!validSlots.includes(time)) {
    return `Время ${time} недоступно. Пожалуйста, выберите одно из допустимых окон.`;
  }

  // Проверяем, что слот ещё свободен
  const calendar = getCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  let freeBusyResponse;
  try {
    freeBusyResponse = await calendar.freebusy.query({
      requestBody: {
        timeMin: startDateTime.toISOString(),
        timeMax: endDateTime.toISOString(),
        items: [{ id: calendarId }],
      },
    });
  } catch (err) {
    logGoogleError(`bookAppointment freebusy.query date=${date} time=${time}`, err);
    throw err;
  }

  const busyPeriods = freeBusyResponse.data.calendars[calendarId]?.busy || [];
  if (busyPeriods.length > 0) {
    return `К сожалению, время ${time} на ${formatDateRu(date)} уже занято. Хотите выбрать другое?`;
  }

  // Создаём событие
  try {
    await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: `${service} — ${patient_name}`,
        description: `Пациент: ${patient_name}\nУслуга: ${service}`,
        start: { dateTime: startDateTime.toISOString(), timeZone: "Europe/Moscow" },
        end: { dateTime: endDateTime.toISOString(), timeZone: "Europe/Moscow" },
      },
    });
  } catch (err) {
    logGoogleError(`bookAppointment events.insert date=${date} time=${time} patient=${patient_name}`, err);
    throw err;
  }

  return `Отлично! ${patient_name}, вы записаны на ${service} ${formatDateRu(date)} в ${time}. Ждём вас в клинике «Улыбка»!`;
}

/**
 * Форматирует дату YYYY-MM-DD в читаемый вид на русском, например "15 июня 2025"
 */
function formatDateRu(dateStr) {
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// ─── Диспетчер инструментов ───────────────────────────────────────────────────

const TOOL_HANDLERS = {
  "check-availability": checkAvailability,
  "book-appointment": bookAppointment,
};

// ─── Маршруты ─────────────────────────────────────────────────────────────────

// Основной webhook для VAPI
app.post("/webhook", async (req, res) => {
  try {
    // Опциональная верификация секрета VAPI
    if (process.env.VAPI_SECRET) {
      const secret = req.headers["x-vapi-secret"];
      if (secret !== process.env.VAPI_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const message = req.body?.message;
    if (!message || message.type !== "tool-calls") {
      // VAPI отправляет и другие события (start, end и т.д.) — просто подтверждаем
      return res.status(200).json({ received: true });
    }

    const toolCallList = message.toolCallList || [];
    const results = await Promise.all(
      toolCallList.map(async (toolCall) => {
        const name = toolCall.function?.name;
        const args = JSON.parse(toolCall.function?.arguments || "{}");
        const handler = TOOL_HANDLERS[name];

        let result;
        if (!handler) {
          result = `Инструмент «${name}» не найден.`;
        } else {
          try {
            result = await handler(args);
          } catch (err) {
            console.error(`Error in tool "${name}":`, err.message);
            result = "Произошла ошибка при обработке запроса. Пожалуйста, попробуйте ещё раз.";
          }
        }

        return { toolCallId: toolCall.id, result };
      })
    );

    return res.json({ results });
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Health check для Railway / мониторинга
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "dental-assistant-vapi" });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dental assistant server running on port ${PORT}`);
});
