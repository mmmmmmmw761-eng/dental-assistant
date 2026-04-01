# Голосовой ассистент клиники «Улыбка»

Node.js сервер, который связывает голосовую AI-платформу **VAPI** с **Google Calendar**. Позволяет пациентам уточнять свободные окна и записываться на приём через голосовой звонок.

---

## Как это работает

1. Пациент звонит на номер, подключённый к VAPI.
2. VAPI распознаёт речь и вызывает один из двух инструментов:
   - **check-availability** — проверяет свободные слоты на нужную дату.
   - **book-appointment** — создаёт событие в Google Calendar.
3. Сервер отвечает текстом, который VAPI озвучивает пациенту.

**Рабочие часы клиники:**
- Пн–Пт: 09:00–18:00
- Сб: 09:00–14:00
- Вс: выходной
- Длительность приёма: 30 минут

---

## Шаг 1 — Google Calendar: сервисный аккаунт

### 1.1 Создайте проект в Google Cloud

1. Перейдите на [console.cloud.google.com](https://console.cloud.google.com).
2. Нажмите **Select a project → New Project**, задайте имя (например, `dental-assistant`).
3. Выберите созданный проект.

### 1.2 Включите Google Calendar API

1. В левом меню откройте **APIs & Services → Library**.
2. Найдите **Google Calendar API** и нажмите **Enable**.

### 1.3 Создайте сервисный аккаунт

1. Откройте **APIs & Services → Credentials**.
2. Нажмите **Create Credentials → Service account**.
3. Введите имя (например, `dental-bot`) и нажмите **Done**.
4. Нажмите на созданный аккаунт → вкладка **Keys → Add Key → Create new key → JSON**.
5. Скачается файл вида `dental-assistant-xxxx.json` — сохраните его.

Из этого файла вам понадобятся:
- `client_email` → это `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` → это `GOOGLE_PRIVATE_KEY`

### 1.4 Предоставьте доступ к календарю

1. Откройте [Google Calendar](https://calendar.google.com).
2. Создайте отдельный календарь для клиники (или используйте существующий).
3. Нажмите на три точки рядом с календарём → **Settings and sharing**.
4. Прокрутите до **Share with specific people → Add people**.
5. Введите `client_email` из JSON-файла и выберите роль **Make changes to events**.
6. В разделе **Integrate calendar** скопируйте **Calendar ID** — это `GOOGLE_CALENDAR_ID`.

---

## Шаг 2 — Локальный запуск

```bash
# Клонируйте репозиторий
git clone <url-репозитория>
cd dental-assistant

# Установите зависимости
npm install

# Создайте .env из примера
cp .env.example .env
```

Откройте `.env` и заполните переменные:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=dental-bot@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
GOOGLE_CALENDAR_ID=abcdef1234567890@group.calendar.google.com
PORT=3000
VAPI_SECRET=придумайте-любой-секрет
```

> **Важно:** `GOOGLE_PRIVATE_KEY` должен быть в кавычках. Переносы строк замените на `\n`.

```bash
# Запустите сервер
npm run dev      # с автоперезагрузкой (для разработки)
npm start        # для production
```

Проверьте, что сервер работает:
```
GET http://localhost:3000/health
```

---

## Шаг 3 — Деплой на Railway

### 3.1 Подготовьте репозиторий

```bash
git init
git add .
git commit -m "Initial commit"
```

Создайте репозиторий на GitHub и запушьте код:
```bash
git remote add origin https://github.com/ваш-логин/dental-assistant.git
git push -u origin main
```

### 3.2 Создайте проект на Railway

1. Зайдите на [railway.app](https://railway.app) и войдите через GitHub.
2. Нажмите **New Project → Deploy from GitHub repo**.
3. Выберите репозиторий `dental-assistant`.
4. Railway автоматически определит Node.js и начнёт деплой.

### 3.3 Добавьте переменные окружения

1. В панели проекта откройте **Variables**.
2. Нажмите **Raw Editor** и вставьте содержимое вашего `.env`.

> `PORT` добавлять не нужно — Railway подставляет его автоматически.

### 3.4 Получите URL сервера

1. Откройте вкладку **Settings → Networking → Generate Domain**.
2. Railway выдаст URL вида `https://dental-assistant-production.up.railway.app`.
3. Проверьте: `https://ваш-url.up.railway.app/health` должен вернуть `{"status":"ok"}`.

---

## Шаг 4 — Настройка VAPI

### 4.1 Зарегистрируйтесь на VAPI

Перейдите на [vapi.ai](https://vapi.ai) и создайте аккаунт.

### 4.2 Создайте ассистента

1. В панели VAPI нажмите **Create Assistant**.
2. Заполните:
   - **Name:** Ассистент клиники Улыбка
   - **System Prompt:** опишите роль ассистента (см. пример ниже).
   - **Voice:** выберите голос на русском языке.

**Пример System Prompt:**
```
Ты голосовой ассистент стоматологической клиники «Улыбка».
Твоя задача — помогать пациентам узнавать свободное время для приёма
и записываться на визит к врачу. Общайся вежливо и по-русски.
Клиника работает пн–пт 9:00–18:00, сб 9:00–14:00, вс выходной.
Когда пациент хочет узнать доступное время — вызывай check-availability.
Когда пациент готов записаться — уточни имя, услугу, дату и время,
затем вызывай book-appointment.
```

### 4.3 Добавьте инструменты (Tools)

В настройках ассистента найдите раздел **Tools** и добавьте два инструмента:

#### check-availability
```json
{
  "name": "check-availability",
  "description": "Проверяет свободные окна для записи в стоматологической клинике на указанную дату.",
  "parameters": {
    "type": "object",
    "properties": {
      "date": {
        "type": "string",
        "description": "Дата в формате YYYY-MM-DD, например 2025-06-15"
      }
    },
    "required": ["date"]
  }
}
```

#### book-appointment
```json
{
  "name": "book-appointment",
  "description": "Записывает пациента на приём в стоматологическую клинику.",
  "parameters": {
    "type": "object",
    "properties": {
      "patient_name": {
        "type": "string",
        "description": "Полное имя пациента"
      },
      "service": {
        "type": "string",
        "description": "Название стоматологической услуги, например «Чистка зубов» или «Лечение кариеса»"
      },
      "date": {
        "type": "string",
        "description": "Дата приёма в формате YYYY-MM-DD"
      },
      "time": {
        "type": "string",
        "description": "Время приёма в формате HH:MM, например 10:30"
      }
    },
    "required": ["patient_name", "service", "date", "time"]
  }
}
```

### 4.4 Укажите Webhook URL

В настройках ассистента найдите **Server URL** (или **Webhook URL**) и введите:
```
https://ваш-url.up.railway.app/webhook
```

Если вы задали `VAPI_SECRET`, добавьте его в поле **Server Secret** — VAPI будет передавать его в заголовке `x-vapi-secret`.

---

## Структура проекта

```
dental-assistant/
├── server.js          # Основной сервер
├── package.json
├── .env.example       # Шаблон переменных окружения
├── .gitignore
└── README.md
```

---

## API

### POST /webhook
Основной endpoint для VAPI. Принимает `tool-calls` и возвращает результаты.

**Тело запроса (от VAPI):**
```json
{
  "message": {
    "type": "tool-calls",
    "toolCallList": [
      {
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "check-availability",
          "arguments": "{\"date\":\"2025-06-15\"}"
        }
      }
    ]
  }
}
```

**Ответ:**
```json
{
  "results": [
    {
      "toolCallId": "call_abc123",
      "result": "На 15 июня 2025 доступно следующее время: 09:00, 09:30, 10:00, 11:30, 14:00. Какое время вам удобно?"
    }
  ]
}
```

### GET /health
Проверка работоспособности сервера.

---

## Решение проблем

| Проблема | Причина | Решение |
|---|---|---|
| `Error: invalid_grant` | Неверный сервисный аккаунт | Проверьте `GOOGLE_SERVICE_ACCOUNT_EMAIL` и `GOOGLE_PRIVATE_KEY` |
| Календарь не обновляется | Нет доступа к календарю | Убедитесь, что `client_email` добавлен в общий доступ к календарю |
| 401 Unauthorized | Неверный VAPI_SECRET | Проверьте секрет в переменных окружения и настройках VAPI |
| Слот занят, хотя календарь пустой | Неверный `GOOGLE_CALENDAR_ID` | Скопируйте ID из настроек календаря повторно |
