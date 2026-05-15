const YC_BASE = "https://api.yclients.com/api/v1";

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

function createYclientsAdapter(business) {
  const config = business.booking?.yclients || {};
  const partnerToken = config.partnerTokenEnv ? process.env[config.partnerTokenEnv] : process.env.YCLIENTS_PARTNER_TOKEN;
  const userToken = config.userTokenEnv ? process.env[config.userTokenEnv] : process.env.YCLIENTS_USER_TOKEN;
  const companyId = config.companyId || process.env.YCLIENTS_COMPANY_ID;

  if (!partnerToken || !userToken || !companyId) {
    throw new Error("YClients is selected, but tokens or company id are not configured");
  }

  const headers = {
    Authorization: `Bearer ${partnerToken}, User ${userToken}`,
    Accept: "application/vnd.yclients.v2+json",
    "Content-Type": "application/json",
  };

  let servicesCache = [];
  let staffCache = [];

  async function ycFetch(path, options = {}) {
    const res = await fetch(`${YC_BASE}${path}`, { headers, ...options });
    return res.json();
  }

  function matchService(name) {
    if (!servicesCache.length) return null;
    const q = normalizeText(name);
    if (!q) return servicesCache[0];

    return (
      servicesCache.find((service) => normalizeText(service.title) === q) ||
      servicesCache.find((service) => normalizeText(service.title).includes(q)) ||
      servicesCache[0]
    );
  }

  function matchStaff(name) {
    if (!staffCache.length) return null;
    const q = normalizeText(name);
    if (!q) return staffCache[0];

    return (
      staffCache.find((staff) => normalizeText(staff.name) === q) ||
      staffCache.find((staff) => normalizeText(staff.name).includes(q)) ||
      staffCache[0]
    );
  }

  async function loadCatalog() {
    try {
      const [svcRes, staffRes] = await Promise.all([
        ycFetch(`/book_services/${companyId}`),
        ycFetch(`/book_staff/${companyId}`),
      ]);

      if (svcRes.success) {
        const data = svcRes.data;
        servicesCache = Array.isArray(data) ? data : data?.services || [];
      }

      if (staffRes.success) {
        staffCache = staffRes.data || [];
      }

      console.log(`[yclients] ${servicesCache.length} services, ${staffCache.length} staff loaded`);
    } catch (err) {
      console.error("[yclients] catalog load error:", err.message);
    }
  }

  async function ensureCatalog() {
    if (!servicesCache.length || !staffCache.length) {
      await loadCatalog();
    }
  }

  async function checkAvailability({ date, time, serviceName, staffName }) {
    await ensureCatalog();

    const service = matchService(serviceName);
    const staff = matchStaff(staffName);

    console.log(
      `[yclients:check] companyId=${companyId} requestedDate=${date} requestedTime=${time || "-"} requestedService=${serviceName || "-"} matchedService=${service?.title || "-"} requestedStaff=${staffName || "-"} matchedStaff=${staff?.name || "-"}`
    );

    if (!service) {
      return "Расписание временно недоступно. Позвоните напрямую или оставьте заявку.";
    }

    const staffId = staff?.id || 0;
    const data = await ycFetch(`/book_times/${companyId}/${staffId}/${date}?services[]=${service.id}`);

    if (!data.success) {
      console.error("[yclients] check availability error:", data?.meta?.message);
      return `На ${formatDateRu(date)} запись недоступна. Предложите другой день.`;
    }

    const free = (data.data || []).filter((slot) => slot.available).map((slot) => slot.time.slice(0, 5));
    console.log(`[yclients:slots] date=${date} freeCount=${free.length} sample=${free.slice(0, 8).join(",") || "-"}`);
    if (!free.length) {
      return `На ${formatDateRu(date)} свободных окон нет. Предложите другой день.`;
    }

    if (time) {
      if (free.includes(time)) {
        return `${time} ${formatDateRu(date)} доступно${staff ? ` к ${staff.name}` : ""} на ${service.title}. Уточните имя и телефон для записи.`;
      }

      return `На ${time} свободного окна нет. Можно предложить: ${free.slice(0, 5).join(", ")}.`;
    }

    return `На ${formatDateRu(date)} доступно: ${free.slice(0, 8).join(", ")}. Какое время удобно?`;
  }

  async function bookAppointment({ patient_name, phone, service, staff, date, time }) {
    if (!patient_name || !phone || !date || !time) {
      return "Для записи нужны имя клиента, номер телефона, дата и время.";
    }

    await ensureCatalog();

    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone.replace(/\D/g, "").length < 10) {
      return "Укажите корректный номер телефона.";
    }

    const matchedService = matchService(service);
    const matchedStaff = matchStaff(staff);

    if (!matchedService) {
      return "Услуги временно недоступны. Можно оставить заявку администратору.";
    }

    const data = await ycFetch(`/book_record/${companyId}`, {
      method: "POST",
      body: JSON.stringify({
        phone: normalizedPhone,
        fullname: patient_name,
        email: "",
        appointments: [
          {
            id: 1,
            services: [matchedService.id],
            staff_id: matchedStaff?.id || 0,
            datetime: `${date} ${time}:00`,
          },
        ],
      }),
    });

    if (!data.success) {
      console.error("[yclients] book appointment error:", data?.meta?.message);
      return `К сожалению, не удалось записать на ${time} ${formatDateRu(date)}. Предложите другое время.`;
    }

    return `${patient_name}, вы записаны на ${matchedService.title} ${formatDateRu(date)} в ${time}. До встречи!`;
  }

  return {
    loadCatalog,
    checkAvailability,
    bookAppointment,
  };
}

module.exports = { createYclientsAdapter };
