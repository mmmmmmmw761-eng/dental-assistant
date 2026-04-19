require("dotenv").config();

// ─── Проверка обязательных переменных окружения ───────────────────────────────

const REQUIRED_ENV = [
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_CALENDAR_ID",
  "VAPI_SECRET",
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`[startup] Missing required env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const express = require("express");
const { google } = require("googleapis");
const rateLimit = require("express-rate-limit");

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: "32kb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  })
);

// ─── Константы клиники ────────────────────────────────────────────────────────

const SLOT_DURATION_MINUTES = 30;
const TZ_OFFSET = "+03:00"; // Europe/Moscow

// Рабочие часы: last slot must END by hours.end
const WORKING_HOURS = {
  1: { start: 9, end: 18 }, // Понедельник
  2: { start: 9, end: 18 }, // Вторник
  3: { start: 9, end: 18 }, // Среда
  4: { start: 9, end: 18 }, // Четверг
  5: { start: 9, end: 18 }, // Пятница
  6: { start: 9, end: 14 }, // Суббота
  // 0 — воскресенье: выходной
};

// ─── Google Calendar ──────────────────────────────────────────────────────────

function getCalendarClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

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

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Генерирует все теоретически возможные слоты для заданной даты
 * в московском времени (UTC+3).
 * @param {string} dateStr — дата в формате YYYY-MM-DD
 * @returns {{ timeStr: string, startDate: Date }[]}
 */
function generateSlots(dateStr) {
  // Парсим компоненты даты напрямую, чтобы getDay() не зависел от timezone сервера
  const [year, month, day] = dateStr.split("-").map(Number);
  const dayOfWeek = new Date(year, month - 1, day).getDay();

  const hours = WORKING_HOURS[dayOfWeek];
  if (!hours) return [];

  const slots = [];
  let h = hours.start;
  let m = 0;

  while (true) {
    // Слот должен полностью завершиться до конца рабочего дня
    const endM = m + SLOT_DURATION_MINUTES;
    const endH = h + Math.floor(endM / 60);
    const endMin = endM % 60;
    if (endH > hours.end || (endH === hours.end && endMin > 0)) break;

    const timeStr = `${pad(h)}:${pad(m)}`;
    // Явно указываем московский offset, чтобы UTC-сервер не сдвигал время
    const startDate = new Date(`${dateStr}T${timeStr}:00${TZ_OFFSET}`);
    slots.push({ timeStr, startDate });

    m += SLOT_DURATION_MINUTES;
    if (m >= 60) {
      m -= 60;
      h += 1;
    }
  }

  return slots;
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

/**
 * Форматирует дату YYYY-MM-DD на русском, например "15 июня 2025".
 * Не создаёт Date-объект, чтобы не зависеть от timezone сервера.
 */
function formatDateRu(dateStr) {
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

// ─── Обработчики инструментов VAPI ───────────────────────────────────────────

/**
 * check-availability
 * Ожидаемые аргументы: { date: "YYYY-MM-DD" }
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

  // Границы дня в московском времени
  const dayStart = new Date(`${date}T00:00:00${TZ_OFFSET}`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59${TZ_OFFSET}`).toISOString();

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

  const freeSlots = slots.filter((s) => !isSlotBusy(s.startDate, slotDurationMs, busyPeriods));

  if (freeSlots.length === 0) {
    return `На ${formatDateRu(date)} свободных окон нет. Хотите выбрать другой день?`;
  }

  const timeList = freeSlots.map((s) => s.timeStr).join(", ");
  return `На ${formatDateRu(date)} доступно следующее время: ${timeList}. Какое время вам удобно?`;
}

/**
 * book-appointment
 * Ожидаемые аргументы: { patient_name, service, date, time }
 */
async function bookAppointment({ patient_name, service, date, time }) {
  if (!patient_name || !service || !date || !time) {
    return "Для записи нужны: имя пациента, услуга, дата и время приёма.";
  }

  if (typeof patient_name !== "string" || patient_name.trim().length === 0 || patient_name.length > 100) {
    return "Пожалуйста, укажите корректное имя пациента (не более 100 символов).";
  }

  if (typeof service !== "string" || service.trim().length === 0 || service.length > 200) {
    return "Пожалуйста, укажите корректное название услуги (не более 200 символов).";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "Дата должна быть в формате ГГГГ-ММ-ДД.";
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return "Время должно быть в формате ЧЧ:ММ, например 10:30.";
  }

  const validSlots = generateSlots(date);
  if (validSlots.length === 0) {
    return `${formatDateRu(date)} — выходной день. Пожалуйста, выберите рабочий день.`;
  }

  if (!validSlots.some((s) => s.timeStr === time)) {
    return `Время ${time} недоступно. Пожалуйста, выберите одно из допустимых окон.`;
  }

  // Создаём даты с явным московским offset
  const startDateTime = new Date(`${date}T${time}:00${TZ_OFFSET}`);
  const endDateTime = new Date(startDateTime.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

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
    logGoogleError(`bookAppointment events.insert date=${date} time=${time}`, err);
    throw err;
  }

  return `Отлично! ${patient_name}, вы записаны на ${service} ${formatDateRu(date)} в ${time}. Ждём вас в клинике «Улыбка»!`;
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
    // VAPI_SECRET обязателен — проверяем всегда
    const secret = req.headers["x-vapi-secret"];
    if (secret !== process.env.VAPI_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const message = req.body?.message;
    if (!message || message.type !== "tool-calls") {
      return res.status(200).json({ received: true });
    }

    const toolCallList = message.toolCallList || [];
    const results = await Promise.all(
      toolCallList.map(async (toolCall) => {
        const name = toolCall.function?.name;
        const rawArgs = toolCall.function?.arguments;
        const args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
        const handler = TOOL_HANDLERS[name];

        let result;
        if (!handler) {
          result = `Инструмент «${name}» не найден.`;
        } else {
          try {
            result = await handler(args);
          } catch (err) {
            console.error(`[tool] "${name}" error:`, err.message);
            result = "Произошла ошибка при обработке запроса. Пожалуйста, попробуйте ещё раз.";
          }
        }

        return { toolCallId: toolCall.id, result };
      })
    );

    return res.json({ results });
  } catch (err) {
    console.error("[webhook] error:", err.message);
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
