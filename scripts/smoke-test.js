const { spawn } = require("child_process");

const PORT = process.env.SMOKE_PORT || "34567";
const SECRET = "smoke-secret";
const BASE_URL = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }
    await wait(200);
  }
  throw new Error("Server did not become ready in time");
}

async function postToolCall() {
  const res = await fetch(`${BASE_URL}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vapi-secret": SECRET,
    },
    body: JSON.stringify({
      message: {
        type: "tool-calls",
        toolCallList: [
          {
            id: "smoke_check_availability",
            type: "function",
            function: {
              name: "check-availability",
              arguments: JSON.stringify({
                service: "женская стрижка",
                staff: "Анна",
                date: "2099-05-18",
                time: "10:00",
              }),
            },
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Webhook returned HTTP ${res.status}`);
  }

  const body = await res.json();
  const result = body.results?.[0]?.result || "";
  if (!result.includes("выглядит доступно")) {
    throw new Error(`Unexpected tool result: ${result}`);
  }
}

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT,
      VAPI_SECRET: SECRET,
      DEFAULT_BUSINESS_ID: "demo-salon",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForServer();
    await postToolCall();
    console.log("Smoke test passed");
  } catch (err) {
    console.error(output.trim());
    console.error(`Smoke test failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
  }
}

main();
