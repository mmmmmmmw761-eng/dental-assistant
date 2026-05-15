require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { createYclientsAdapter } = require("./integrations/yclients");

const REQUIRED_ENV = ["VAPI_SECRET"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`[startup] Missing required env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const DEFAULT_BUSINESS_ID = process.env.DEFAULT_BUSINESS_ID || "demo-salon";
const BUSINESSES_DIR = path.join(__dirname, "businesses");
const DATA_DIR = path.join(__dirname, "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  return next(err);
});
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  })
);

const businessCache = new Map();
const adapters = new Map();

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "8") return "+7" + digits.slice(1);
  if (digits.length === 11 && digits[0] === "7") return "+" + digits;
  if (digits.length === 10) return "+7" + digits;
  return digits ? "+" + digits : "";
}

function formatDateRu(dateStr) {
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ];
  const [year, month, day] = String(dateStr).split("-").map(Number);
  if (!year || !month || !day || !months[month - 1]) return dateStr;
  return `${day} ${months[month - 1]} ${year}`;
}

function validateDate(date) {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function validateTime(time) {
  return typeof time === "string" && /^\d{2}:\d{2}$/.test(time);
}

function isPastDate(dateStr) {
  const candidate = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(candidate.getTime())) return false;

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return candidate < today;
}

function getWeekdayKey(dateStr) {
  const date = new Date(`${dateStr}T12:00:00`);
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getDay()];
}

function timeToMinutes(time) {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function getBusiness(businessId = DEFAULT_BUSINESS_ID) {
  const safeId = String(businessId || DEFAULT_BUSINESS_ID).replace(/[^a-zA-Z0-9_-]/g, "");
  if (businessCache.has(safeId)) return businessCache.get(safeId);

  const filePath = path.join(BUSINESSES_DIR, `${safeId}.json`);
  const business = readJson(filePath);
  business.id = business.id || safeId;
  businessCache.set(safeId, business);
  return business;
}

function getBusinessId(args) {
  return args?.business_id || args?.businessId || DEFAULT_BUSINESS_ID;
}

function getBookingProvider(business) {
  return business.booking?.provider || "manual";
}

function getAdapter(business) {
  const provider = getBookingProvider(business);
  if (provider !== "yclients") return null;

  const key = `${business.id}:yclients`;
  if (!adapters.has(key)) {
    adapters.set(key, createYclientsAdapter(business));
  }
  return adapters.get(key);
}

function findServiceInBusiness(business, query) {
  const services = business.services || [];
  if (!services.length) return null;
  const q = normalizeText(query);
  if (!q) return services[0];

  return (
    services.find((service) => normalizeText(service.name) === q) ||
    services.find((service) => (service.aliases || []).some((alias) => normalizeText(alias) === q)) ||
    services.find((service) => normalizeText(service.name).includes(q)) ||
    services.find((service) => (service.aliases || []).some((alias) => normalizeText(alias).includes(q) || q.includes(normalizeText(alias)))) ||
    services.find((service) => normalizeText(service.description).includes(q)) ||
    null
  );
}

function findStaffInBusiness(business, query) {
  const staff = business.staff || [];
  if (!staff.length || !query) return null;
  const q = normalizeText(query);

  return (
    staff.find((person) => normalizeText(person.name) === q) ||
    staff.find((person) => (person.aliases || []).some((alias) => normalizeText(alias) === q)) ||
    staff.find((person) => normalizeText(person.name).includes(q)) ||
    staff.find((person) => (person.aliases || []).some((alias) => normalizeText(alias).includes(q) || q.includes(normalizeText(alias)))) ||
    null
  );
}

function getWorkingInterval(business, date) {
  const dayKey = getWeekdayKey(date);
  const value = business.workingHours?.[dayKey];
  if (!value || value === "closed") return null;
  if (typeof value === "string") {
    const [start, end] = value.split("-");
    return start && end ? { start, end } : null;
  }
  return value;
}

function buildManualSlots(business, date, service) {
  const interval = getWorkingInterval(business, date);
  if (!interval) return [];

  const duration = Number(service?.durationMinutes || business.defaultDurationMinutes || 60);
  const start = timeToMinutes(interval.start);
  const end = timeToMinutes(interval.end);
  const slots = [];

  for (let current = start; current + duration <= end; current += duration) {
    slots.push(minutesToTime(current));
  }

  return slots.slice(0, 12);
}

function compactBusinessInfo(business) {
  const branches = (business.branches || [])
    .map((branch) => `${branch.name || "Филиал"}: ${branch.address}`)
    .join("; ");
  const services = (business.services || [])
    .slice(0, 12)
    .map((service) => {
      const price = service.price ? `, ${service.price}` : "";
      return `${service.name}${price}`;
    })
    .join("; ");
  const staff = (business.staff || [])
    .slice(0, 12)
    .map((person) => `${person.name}${person.role ? ` (${person.role})` : ""}`)
    .join("; ");

  return [
    `Компания: ${business.name}.`,
    business.industry ? `Сфера: ${business.industry}.` : "",
    business.tone ? `Стиль общения: ${business.tone}.` : "",
    branches ? `Адреса: ${branches}.` : "",
    services ? `Основные услуги: ${services}.` : "",
    staff ? `Сотрудники: ${staff}.` : "",
    business.salesRules?.length ? `Правила: ${business.salesRules.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function getBusinessInfo(args = {}) {
  const business = getBusiness(getBusinessId(args));
  return compactBusinessInfo(business);
}

async function findService(args = {}) {
  const business = getBusiness(getBusinessId(args));
  const service = findServiceInBusiness(business, args.service || args.query);

  if (!service) {
    return "Подходящую услугу не нашла. Уточните, пожалуйста, как называется услуга.";
  }

  const price = service.price ? ` Стоимость: ${service.price}.` : "";
  const duration = service.durationMinutes ? ` Длительность: около ${service.durationMinutes} минут.` : "";
  const description = service.description ? ` ${service.description}` : "";
  return `Подходит услуга: ${service.name}.${price}${duration}${description}`;
}

async function findStaff(args = {}) {
  const business = getBusiness(getBusinessId(args));
  const staff = findStaffInBusiness(business, args.staff || args.query);

  if (!staff) {
    return "Такого сотрудника в профиле не нашла. Можно предложить запись к любому свободному специалисту.";
  }

  const role = staff.role ? `, ${staff.role}` : "";
  const services = staff.services?.length ? ` Работает с услугами: ${staff.services.join(", ")}.` : "";
  return `Сотрудник найден: ${staff.name}${role}.${services}`;
}

async function checkAvailability(args = {}) {
  const business = getBusiness(getBusinessId(args));
  const service = findServiceInBusiness(business, args.service);
  const staff = findStaffInBusiness(business, args.staff);

  if (!validateDate(args.date)) {
    return "Укажите дату в формате ГГГГ-ММ-ДД.";
  }

  if (args.time && !validateTime(args.time)) {
    return "Укажите время в формате ЧЧ:ММ, например 09:00.";
  }

  if (isPastDate(args.date)) {
    logToolEvent("past_date", {
      name: "check-availability",
      businessId: business.id,
      requestedDate: args.date,
    });
    return `Дата ${formatDateRu(args.date)} уже прошла. Проверьте, пожалуйста, текущий или будущий год и повторите запрос.`;
  }

  const adapter = getAdapter(business);
  if (adapter) {
    return adapter.checkAvailability({
      date: args.date,
      time: args.time,
      serviceName: args.service,
      staffName: args.staff,
    });
  }

  const slots = buildManualSlots(business, args.date, service);
  const serviceText = service ? ` на ${service.name}` : "";
  const staffText = staff ? ` к ${staff.name}` : "";

  if (!slots.length) {
    return `${business.name} не работает ${formatDateRu(args.date)}. Предложите клиенту другой день.`;
  }

  if (args.time) {
    if (slots.includes(args.time)) {
      return `${args.time} ${formatDateRu(args.date)}${serviceText}${staffText} выглядит доступно для предварительной заявки. Чтобы закрепить обращение, уточните имя и телефон, затем вызовите create-lead.`;
    }

    return `На ${args.time} ${formatDateRu(args.date)} нет доступного окна в базовом расписании. Можно предложить: ${slots.slice(0, 5).join(", ")}.`;
  }

  return `На ${formatDateRu(args.date)}${serviceText}${staffText} можно предложить: ${slots.slice(0, 8).join(", ")}. После выбора времени уточните имя и телефон.`;
}

async function createLead(args = {}) {
  const business = getBusiness(getBusinessId(args));

  if (!args.patient_name && !args.client_name && !args.name) {
    return "Для заявки нужно имя клиента.";
  }

  if (!args.phone) {
    return "Для заявки нужен номер телефона клиента.";
  }

  const phone = normalizePhone(args.phone);
  if (phone.replace(/\D/g, "").length < 10) {
    return "Укажите корректный номер телефона клиента.";
  }

  const clientName = String(args.patient_name || args.client_name || args.name).trim();
  const lead = {
    id: `lead_${Date.now()}`,
    createdAt: new Date().toISOString(),
    businessId: business.id,
    businessName: business.name,
    clientName,
    phone,
    service: args.service || "",
    staff: args.staff || "",
    date: args.date || "",
    time: args.time || "",
    comment: args.comment || "",
    status: "new",
  };

  const leads = readJson(LEADS_FILE, []);
  leads.push(lead);
  writeJson(LEADS_FILE, leads);

  const when = lead.date && lead.time ? ` на ${formatDateRu(lead.date)} в ${lead.time}` : "";
  const serviceText = lead.service ? `, услуга: ${lead.service}` : "";
  return `${clientName}, я передала заявку${when}${serviceText}. Администратор подтвердит запись по телефону ${phone}.`;
}

async function bookAppointment(args = {}) {
  const business = getBusiness(getBusinessId(args));
  const adapter = getAdapter(business);

  if (!adapter) {
    return createLead(args);
  }

  return adapter.bookAppointment({
    patient_name: args.patient_name || args.client_name || args.name,
    phone: args.phone,
    service: args.service,
    staff: args.staff,
    date: args.date,
    time: args.time,
  });
}

const TOOL_HANDLERS = {
  "get-business-info": getBusinessInfo,
  "find-service": findService,
  "find-staff": findStaff,
  "check-availability": checkAvailability,
  "create-lead": createLead,
  "book-appointment": bookAppointment,
};

function stringifyForLog(value) {
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 497)}...` : text;
  } catch {
    return String(value);
  }
}

function logToolEvent(stage, payload) {
  const parts = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  console.log(`[tool:${stage}] ${parts.join(" ")}`);
}

function parseToolArguments(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === "object") return rawArgs;
  if (typeof rawArgs !== "string") return {};
  try {
    return JSON.parse(rawArgs);
  } catch {
    return { _parseError: true };
  }
}

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
      (message.toolCallList || []).map(async (toolCall) => {
        const name = toolCall.function?.name;
        const args = parseToolArguments(toolCall.function?.arguments);
        const handler = TOOL_HANDLERS[name];
        const startedAt = Date.now();

        logToolEvent("start", {
          toolCallId: toolCall.id,
          name,
          businessId: getBusinessId(args),
          args: stringifyForLog(args),
        });

        let result;
        if (args._parseError) {
          result = "Не удалось разобрать параметры инструмента. Уточните данные и повторите.";
          logToolEvent("parse_error", {
            toolCallId: toolCall.id,
            name,
            rawArgs: stringifyForLog(toolCall.function?.arguments),
          });
        } else if (!handler) {
          result = `Инструмент "${name}" не найден.`;
          logToolEvent("missing_handler", {
            toolCallId: toolCall.id,
            name,
          });
        } else {
          try {
            result = await handler(args);
            logToolEvent("result", {
              toolCallId: toolCall.id,
              name,
              durationMs: Date.now() - startedAt,
              result: stringifyForLog(result),
            });
          } catch (err) {
            logToolEvent("error", {
              toolCallId: toolCall.id,
              name,
              durationMs: Date.now() - startedAt,
              error: err.message,
            });
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
  res.json({
    status: "ok",
    service: "universal-business-assistant",
    defaultBusinessId: DEFAULT_BUSINESS_ID,
  });
});

async function preloadAdapters() {
  const business = getBusiness(DEFAULT_BUSINESS_ID);
  const adapter = getAdapter(business);
  if (adapter?.loadCatalog) {
    await adapter.loadCatalog();
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Universal business assistant running on port ${PORT}`);
  console.log(`[business] default profile: ${DEFAULT_BUSINESS_ID}`);
  await preloadAdapters();
});
