#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import TelegramBot from "node-telegram-bot-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;

const envPath = resolve(__dirname, ".env");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=").map((s) => s.trim()))
    .map(([k, ...v]) => [k, v.join("=")])
);

const TOKEN = env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER = env.ALLOWED_USER_ID;
const CLAUDE_PATH = env.CLAUDE_PATH || "claude";
const DEFAULT_CWD = env.DEFAULT_CWD || HOME;
const LOG_FILE = resolve(__dirname, "sraosha.log");

const CLAUDE_ENV = {
  ...process.env,
  HOME,
  PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function isAllowed(msg) {
  return String(msg.from.id) === ALLOWED_USER;
}

function getActiveSessions() {
  try {
    const out = execFileSync(CLAUDE_PATH, ["agents", "--json"], {
      timeout: 10000,
      env: CLAUDE_ENV,
    });
    return JSON.parse(out.toString());
  } catch {
    return [];
  }
}

function spawnRemoteControl(name) {
  const child = spawn(
    CLAUDE_PATH,
    ["--remote-control", name || "sraosha", "--name", `sraosha-${Date.now()}`],
    { cwd: DEFAULT_CWD, detached: true, stdio: "ignore", env: CLAUDE_ENV }
  );
  child.unref();
  log(`Spawned remote-control session (PID: ${child.pid}, name: ${name})`);
  return child.pid;
}

function runTask(prompt, chatId, b) {
  const child = spawn(CLAUDE_PATH, ["-p", prompt, "--output-format", "text"], {
    cwd: DEFAULT_CWD,
    env: CLAUDE_ENV,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    log(`Task timed out (PID: ${child.pid})`);
    b.sendMessage(chatId, `Task timed out after 5 min (PID: ${child.pid}).`).catch(() => {});
  }, 5 * 60 * 1000);

  child.on("close", async (code) => {
    clearTimeout(timer);
    const result = stdout.trim() || stderr.trim() || "(no output)";
    const maxLen = 4000;
    const truncated = result.length > maxLen ? result.slice(0, maxLen) + "\n...(truncated)" : result;
    log(`Task done (PID: ${child.pid}, exit: ${code}, len: ${result.length})`);
    try {
      await b.sendMessage(chatId, `Task complete (exit ${code}):\n\n${truncated}`);
    } catch {}
  });

  log(`Spawned task with callback (PID: ${child.pid})`);
  return child.pid;
}

// --- Silent health check (every 6h, log-only, alert after 3 consecutive failures) ---
const HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HEALTH_JITTER_MS = 10 * 60 * 1000;
let healthFailures = 0;
let lastCommandAt = null;

async function healthCheck(b) {
  const checks = { telegram: false, claude_cli: false };

  try { await b.getMe(); checks.telegram = true; } catch {}

  try {
    execFileSync(CLAUDE_PATH, ["--version"], { timeout: 5000, env: CLAUDE_ENV });
    checks.claude_cli = true;
  } catch {}

  const sessions = getActiveSessions();

  if (checks.telegram && checks.claude_cli) {
    healthFailures = 0;
    log(`HEALTH OK — telegram: ok, claude_cli: ok, sessions: ${sessions.length}, lastCmd: ${lastCommandAt || "none"}`);
  } else {
    healthFailures++;
    log(`HEALTH WARN (#${healthFailures}) — telegram: ${checks.telegram}, claude_cli: ${checks.claude_cli}`);
    if (healthFailures >= 3) {
      try {
        await b.sendMessage(ALLOWED_USER,
          `Sraosha: issue detected (${healthFailures} consecutive failures).\ntelegram: ${checks.telegram ? "ok" : "FAIL"}\nclaude_cli: ${checks.claude_cli ? "ok" : "FAIL"}`);
      } catch {}
    }
  }
}

function scheduleHealthCheck(b) {
  const jitter = Math.floor(Math.random() * HEALTH_JITTER_MS);
  setTimeout(async () => {
    await healthCheck(b);
    scheduleHealthCheck(b);
  }, HEALTH_INTERVAL_MS + jitter);
}

// --- Bot ---
const bot = new TelegramBot(TOKEN, { polling: { params: { timeout: 30 } } });
log("=== Sraosha v1.3.0 starting ===");

healthCheck(bot);
scheduleHealthCheck(bot);

const COMMANDS = {
  "/wake": "Wake Claude Code (Remote Control)",
  "/status": "Show active sessions",
  "/task": "Run a headless task (e.g. /task git status)",
  "/ping": "Check if Sraosha is alive",
  "/help": "Show commands",
};

bot.onText(/\/wake!force/, async (msg) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  await bot.sendMessage(msg.chat.id, "Force launching...");
  const pid = spawnRemoteControl(`force-${Date.now()}`);
  await bot.sendMessage(msg.chat.id, `New session started (PID: ${pid}).`);
});

bot.onText(/\/wake(?!!force)(.*)/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  const chatId = msg.chat.id;
  const sessionName = match[1]?.trim() || "sraosha";

  const sessions = getActiveSessions();
  if (sessions.length > 0) {
    await bot.sendMessage(chatId,
      `${sessions.length} session(s) already active.\nPIDs: ${sessions.map((s) => s.pid).join(", ")}\n\nUse /wake!force to start another.`);
    return;
  }

  await bot.sendMessage(chatId, "Waking up Claude Code...");
  const pid = spawnRemoteControl(sessionName);
  await new Promise((r) => setTimeout(r, 5000));

  const newSessions = getActiveSessions();
  if (newSessions.length > 0) {
    await bot.sendMessage(chatId,
      `Claude Code is awake! PID: ${pid}\nActive sessions: ${newSessions.length}\n\nOpen the Claude app on your phone for Remote Control.`);
  } else {
    await bot.sendMessage(chatId,
      `Session started (PID: ${pid}), initializing.\nTry /status in a few seconds.`);
  }
});

bot.onText(/\/status/, async (msg) => {
  if (!isAllowed(msg)) return;
  const sessions = getActiveSessions();
  if (sessions.length === 0) {
    await bot.sendMessage(msg.chat.id, "No active Claude Code sessions.\n/wake to start one.");
  } else {
    const lines = sessions.map((s) =>
      `- PID ${s.pid} | ${s.kind} | ${s.status} | ${new Date(s.startedAt).toLocaleTimeString()}`);
    await bot.sendMessage(msg.chat.id, `${sessions.length} session(s):\n${lines.join("\n")}`);
  }
});

bot.onText(/\/task (.+)/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  const prompt = match[1];
  await bot.sendMessage(msg.chat.id, `Task started: "${prompt}"\nResult will be sent when complete (max 5 min).`);
  runTask(prompt, msg.chat.id, bot);
});

bot.onText(/\/ping/, async (msg) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const sessions = getActiveSessions();
  await bot.sendMessage(msg.chat.id,
    `Pong! Sraosha v1.3.0\nUptime: ${h}h ${m}m\nClaude sessions: ${sessions.length}\nHealth: ${healthFailures === 0 ? "OK" : healthFailures + " failures"}\nNode: ${process.version} | PID: ${process.pid}`);
});

bot.onText(/\/help/, async (msg) => {
  if (!isAllowed(msg)) return;
  const lines = Object.entries(COMMANDS).map(([cmd, desc]) => `${cmd} — ${desc}`);
  await bot.sendMessage(msg.chat.id, `Sraosha — Commands:\n\n${lines.join("\n")}`);
});

bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg)) return;
  await bot.sendMessage(msg.chat.id, "Sraosha is active.\n/help for commands\n/wake to start Claude Code");
});

bot.on("message", async (msg) => {
  if (!isAllowed(msg)) return;
  if (msg.text?.startsWith("/")) return;
  await bot.sendMessage(msg.chat.id, "Commands only. /help for the list.");
});

bot.on("polling_error", (err) => {
  log(`POLLING ERROR: ${err.message}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`Received ${sig}, shutting down...`);
    bot.stopPolling();
    process.exit(0);
  });
}

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT: ${err.message}`);
});
