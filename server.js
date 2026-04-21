require("dotenv").config();

// ─── Проверка обязательных переменных окружения ───────────────────────────────

const REQUIRED_ENV = [
  "YCLIENTS_PARTNER_TOKEN",
  "YCLIENTS_USER_TOKEN",
  "YCLIENTS_COMPANY_ID",
  "VAPI_SECRET",
];

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`[startup] Missing required env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const express = require("express");
const rateLimit = require("express-rate-limit");

const app = express();
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

// ─── YClients ─────────────────────────────────────────────────────────────────

const PARTNER_TOKEN = process.env.YCLIENTS_PARTNER_TOKEN;
const USER_TOKEN    = process.env.YCLIENTS_USER_TOKEN;
const COMPANY_ID    = process.env.YCLIENTS_COMPANY_ID;
const YC_BASE       = "https://api.yclients.com/api/v1";
const YC_HEADERS    = {
  Authorization:  `Bearer ${PARTNER_TOKEN}, User ${USER_TOKEN}`,
  Accept:         "application/vnd.yclients.v2+json",
  "Content-Type": "application/json",
};

async function ycFetch(path, options = {}) {
  const res = await fetch(`${YC_BASE}${path}`, { headers: YC_HEADERS, ...options });
  return res.json();
}

// ─── Кэш услуг и сотрудников ──────────────────────────────────────────────────

let servicesCache = []; // [{ id, title, duration }]
let staffCache    = []; // [{ id, name }]

async function loadCatalog() {
  try {
    const [svcRes, staffRes] = await Promise.all([
      ycFetch(`/book_services/${COMPANY_ID}`),
      ycFetch(`/book_staff/${COMPANY_ID}`),
    ]);

    if (svcRes.success) {
      const d = svcRes.data;
      servicesCache = Array.isArray(d) ? d : (d?.services ?? []);
    }

    if (staffRes.success) {
      staffCache = staffRes.data ?? [];
    }

    console.log(`[yclients] ${servicesCache.length} services, ${staffCache.length} staff loaded`);
  } catch (err) {
    console.error("[yclients] catalog load error:", err.message);
  }
}

// ─── Вспомогательные функции ─────────────────────────────────────────────────

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Форматирует YYYY-MM-DD → "22 апреля 2026"
 */
function formatDateRu(dateStr) {
  const months = [
    "января","февраля","марта","апреля","мая","июня",
    "июля","августа","сентября","октября","ноября","декабря",
  ];
  const [year, month, day] = dateStr.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

/**
 * Нормализует телефон в формат +7XXXXXXXXXX
 */
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "8") return "+7" + digits.slice(1);
  if (digits.length === 11 && digits[0] === "7") return "+"  + digits;
  if (digits.length === 10)                       return "+7" + digits;
  return "+" + digits;
}

/**
 * Ищет услугу по частичному совпадению названия (регистронезависимо).
 * Если не найдено — возвращает первую из кэша.
 */
function matchService(name) {
  if (!servicesCache.length) return null;
  if (!name) return servicesCache[0];
  const q = name.toLowerCase();
  return (
    servicesCache.find((s) => s.title.toLowerCase() === q) ||
    servicesCache.find((s) => s.title.toLowerCase().includes(q)) ||
    servicesCache[0]
  );
}

// ─── Обработчики инструментов VAPI ───────────────────────────────────────────

/**
 * check-availability
 * Аргументы: { date: "YYYY-MM-DD" }
 */
async function checkAvailability({ date }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "Пожалуйста, укажите дату в формате ГГГГ-ММ-ДД, например 2025-06-15.";
  }

  const staffId   = staffCache[0]?.id ?? 0;
  const serviceId = servicesCache[0]?.id;

  if (!serviceId) {
    return "Расписание временно недоступно. Позвоните нам напрямую.";
  }

  let data;
  try {
    data = await ycFetch(
      `/book_times/${COMPANY_ID}/${staffId}/${date}?services[]=${serviceId}`
    );
  } catch (err) {
    console.error("[check-availability] fetch error:", err.message);
    return "Не удалось получить расписание. Попробуйте ещё раз.";
  }

  if (!data.success) {
    console.error("[check-availability] YClients error:", data?.meta?.message);
    return `На ${formatDateRu(date)} запись недоступна. Хотите выбрать другой день?`;
  }

  const free = (data.data ?? []).filter((s) => s.available);

  if (free.length === 0) {
    return `На ${formatDateRu(date)} свободных окон нет. Хотите выбрать другой день?`;
  }

  const timeList = free.map((s) => s.time.slice(0, 5)).join(", ");
  return `На ${formatDateRu(date)} доступно следующее время: ${timeList}. Какое время вам удобно?`;
}

/**
 * book-appointment
 * Аргументы: { patient_name, phone, service, date, time }
 */
async function bookAppointment({ patient_name, phone, service, date, time }) {
  // Валидация обязательных полей
  if (!patient_name || !phone || !date || !time) {
    return "Для записи нужны: имя пациента, номер телефона, дата и время приёма.";
  }

  if (typeof patient_name !== "string" || patient_name.trim().length === 0 || patient_name.length > 100) {
    return "Пожалуйста, укажите корректное имя (не более 100 символов).";
  }

  if (service && (typeof service !== "string" || service.length > 200)) {
    return "Пожалуйста, укажите корректное название услуги.";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return "Дата должна быть в формате ГГГГ-ММ-ДД.";
  }

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return "Время должно быть в формате ЧЧ:ММ, например 10:30.";
  }

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone.replace(/\D/g, "").length < 10) {
    return "Укажите корректный номер телефона.";
  }

  const svc = matchService(service);
  if (!svc) {
    return "Услуги клиники временно недоступны. Попробуйте позже.";
  }

  const staffId  = staffCache[0]?.id ?? 0;
  const datetime = `${date} ${time}:00`;

  let data;
  try {
    data = await ycFetch(`/book_record/${COMPANY_ID}`, {
      method: "POST",
      body: JSON.stringify({
        phone:     normalizedPhone,
        fullname:  patient_name,
        email:     "",
        appointments: [{
          id:       1,
          services: [svc.id],
          staff_id: staffId,
          datetime,
        }],
      }),
    });
  } catch (err) {
    console.error("[book-appointment] fetch error:", err.message);
    return "Произошла ошибка при записи. Пожалуйста, попробуйте ещё раз.";
  }

  if (!data.success) {
    const msg = data?.meta?.message || "";
    console.error("[book-appointment] YClients error:", msg);
    return `К сожалению, не удалось записать на ${time} ${formatDateRu(date)}. Попробуйте другое время.`;
  }

  const svcTitle = service?.trim() || svc.title;
  return `Отлично! ${patient_name}, вы записаны на ${svcTitle} ${formatDateRu(date)} в ${time}. Ждём вас в клинике!`;
}

// ─── Диспетчер инструментов ───────────────────────────────────────────────────

const TOOL_HANDLERS = {
  "check-availability": checkAvailability,
  "book-appointment":   bookAppointment,
};

// ─── Маршруты ─────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  try {
    if (req.headers["x-vapi-secret"] !== process.env.VAPI_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const message = req.body?.message;
    if (!message || message.type !== "tool-calls") {
      return res.status(200).json({ received: true });
    }

    const results = await Promise.all(
      (message.toolCallList ?? []).map(async (toolCall) => {
        const name    = toolCall.function?.name;
        const rawArgs = toolCall.function?.arguments;
        const args    = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
        const handler = TOOL_HANDLERS[name];

        let result;
        if (!handler) {
          result = `Инструмент «${name}» не найден.`;
        } else {
          try {
            result = await handler(args);
          } catch (err) {
            console.error(`[tool] "${name}" error:`, err.message);
            result = "Произошла ошибка при обработке запроса. Попробуйте ещё раз.";
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "dental-assistant-vapi" });
});

// ─── Запуск ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Dental assistant server running on port ${PORT}`);
  await loadCatalog(); // загружаем услуги и сотрудников при старте
});
