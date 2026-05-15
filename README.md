# Универсальный голосовой ассистент для бизнеса

Node.js backend для VAPI-ассистента, который консультирует клиентов, проверяет доступное время и создаёт запись или заявку для сервисных бизнесов: салоны красоты, барбершопы, стоматологии, клиники, автосервисы, студии и другие компании с записью на услуги.

Проект устроен так, чтобы под нового клиента менять не код, а профиль бизнеса в `businesses/*.json`.

---

## Что уже умеет

- Работает с VAPI webhook `/webhook`.
- Хранит данные бизнеса в отдельном JSON-профиле.
- Отвечает на вопросы про компанию, услуги, сотрудников и правила.
- Ищет услугу и сотрудника по словам клиента.
- Проверяет базовую доступность по рабочему расписанию.
- Создаёт ручные заявки без CRM в `data/leads.json`.
- Оставляет YClients как подключаемый booking-adapter.
- Подготовлено место под Sonline и другие сервисы записи.

---

## Быстрый запуск

```bash
npm install
cp .env.example .env
npm run dev
```

Проверьте:

```txt
GET http://localhost:3000/health
```

Ожидаемый ответ:

```json
{
  "status": "ok",
  "service": "universal-business-assistant",
  "defaultBusinessId": "demo-salon"
}
```

---

## Где менять данные клиента

Для каждого клиента создавайте отдельный файл:

```txt
businesses/
  demo-salon.json
  barber-house.json
  dental-plus.json
```

Пример профиля:

```json
{
  "id": "demo-salon",
  "name": "Салон красоты Milana",
  "industry": "beauty_salon",
  "tone": "тепло, уверенно, коротко, без давления",
  "timezone": "Europe/Moscow",
  "defaultDurationMinutes": 60,
  "branches": [
    {
      "name": "Основной филиал",
      "address": "Москва, улица Примерная, 10",
      "phone": "+79990000000"
    }
  ],
  "workingHours": {
    "mon": "10:00-21:00",
    "tue": "10:00-21:00",
    "wed": "10:00-21:00",
    "thu": "10:00-21:00",
    "fri": "10:00-21:00",
    "sat": "10:00-20:00",
    "sun": "10:00-20:00"
  },
  "services": [],
  "staff": [],
  "faq": [],
  "salesRules": [],
  "booking": {
    "provider": "manual"
  }
}
```

В `.env` укажите профиль, который должен использоваться по умолчанию:

```env
DEFAULT_BUSINESS_ID=demo-salon
```

---

## Режимы записи

### Manual

Подходит для первых продаж и клиентов без API-доступов.

```json
{
  "booking": {
    "provider": "manual"
  }
}
```

В этом режиме ассистент консультирует клиента и создаёт заявку в `data/leads.json`. Потом можно подключить отправку в Telegram, Google Sheets, email или CRM.

### YClients

Когда у клиента есть YClients, можно включить:

```json
{
  "booking": {
    "provider": "yclients",
    "yclients": {
      "companyId": "1868124"
    }
  }
}
```

И добавить переменные:

```env
YCLIENTS_PARTNER_TOKEN=...
YCLIENTS_USER_TOKEN=...
YCLIENTS_COMPANY_ID=...
```

Если нужно несколько клиентов с разными токенами, в профиле можно указать имена env-переменных:

```json
{
  "booking": {
    "provider": "yclients",
    "yclients": {
      "companyId": "1868124",
      "partnerTokenEnv": "CLIENT_1_YCLIENTS_PARTNER_TOKEN",
      "userTokenEnv": "CLIENT_1_YCLIENTS_USER_TOKEN"
    }
  }
}
```

### Sonline

Файл `integrations/sonline.js` подготовлен как место для будущего адаптера. Его стоит дописывать, когда появится клиент с Sonline и точная API-документация или доступы.

---

## VAPI

Готовый универсальный prompt и схемы tools лежат в `vapi-prompt.md`.

Server URL:

```txt
https://ваш-домен/webhook
```

Server Secret должен совпадать с:

```env
VAPI_SECRET=your-secret-key-here
```

Основные tools:

- `get-business-info`
- `find-service`
- `find-staff`
- `check-availability`
- `create-lead`
- `book-appointment`

---

## Как подключать нового клиента

1. Соберите анкету клиента: название, адреса, часы работы, услуги, цены, длительность, сотрудники, FAQ, правила общения.
2. Создайте файл `businesses/client-id.json`.
3. Укажите `DEFAULT_BUSINESS_ID=client-id` в `.env` или в Railway Variables.
4. Если CRM ещё нет, оставьте `booking.provider = "manual"`.
5. Если есть YClients, включите `booking.provider = "yclients"` и добавьте API-доступы.
6. В VAPI используйте prompt из `vapi-prompt.md`.

---

## API

### GET /health

Проверка работоспособности сервера.

### POST /webhook

Endpoint для VAPI tool calls.

Пример запроса:

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
          "arguments": "{\"service\":\"женская стрижка\",\"staff\":\"Иванова\",\"date\":\"2026-05-13\",\"time\":\"10:00\"}"
        }
      }
    ]
  }
}
```

Пример ответа:

```json
{
  "results": [
    {
      "toolCallId": "call_abc123",
      "result": "10:00 13 мая 2026 на Женская стрижка к Анна Иванова выглядит доступно для предварительной заявки. Чтобы закрепить обращение, уточните имя и телефон, затем вызовите create-lead."
    }
  ]
}
```

---

## Структура

```txt
dental-assistant/
  businesses/
    demo-salon.json
  integrations/
    yclients.js
    sonline.js
  data/
    leads.json
  server.js
  vapi-prompt.md
  .env.example
  package.json
```
