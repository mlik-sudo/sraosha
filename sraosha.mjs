#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import TelegramBot from "node-telegram-bot-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = "2.0.0";

// --- Config (never log secrets) ---
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
const DEFAULT_CWD = env.DEFAULT_CWD || process.env.HOME;
const LOG_FILE = resolve(__dirname, "sraosha.log");
const HOME = env.HOME || process.env.HOME;
const DAEMON_PATH = env.DAEMON_PATH || [
  `${HOME}/.npm-global/bin`,
  `${HOME}/.local/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

const DAEMON_ENV = {
  ...process.env,
  HOME,
  PATH: DAEMON_PATH,
};

// --- Logging ---
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function isAllowed(msg) {
  return String(msg.from.id) === ALLOWED_USER;
}

// --- State tracking ---
let lastWakeAt = null;
let lastCommandAt = null;

// --- Session detection ---
function getActiveSessions() {
  try {
    const out = execFileSync(CLAUDE_PATH, ["sessions", "list", "--json"], {
      timeout: 10000,
      env: DAEMON_ENV,
    });
    return JSON.parse(out.toString());
  } catch {
    return [];
  }
}

function isClaudeTgRunning() {
  try {
    const out = execFileSync("pgrep", ["-f", "channels.*plugin:telegram"], {
      timeout: 5000,
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function getClaudeVersion() {
  try {
    return execFileSync(CLAUDE_PATH, ["--version"], {
      timeout: 5000,
      env: DAEMON_ENV,
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function detectTccErrors() {
  try {
    const logContent = readFileSync(LOG_FILE, "utf8");
    const lines = logContent.split("\n").slice(-100);
    const tccPatterns = [
      "AppleEvent",
      "osascript",
      "permission",
      "TCC",
      "not allowed",
      "NSAppleScript",
      "sandbox",
    ];
    return lines.filter((l) =>
      tccPatterns.some((p) => l.toLowerCase().includes(p.toLowerCase()))
    );
  } catch {
    return [];
  }
}

// --- Wake: spawn Remote Control session ---
function spawnRemoteControl(name) {
  const child = spawn(
    CLAUDE_PATH,
    ["--remote-control", name || "sraosha", "--name", `sraosha-${Date.now()}`],
    {
      cwd: DEFAULT_CWD,
      detached: true,
      stdio: "ignore",
      env: DAEMON_ENV,
    }
  );
  child.unref();
  lastWakeAt = new Date().toISOString();
  log(`WAKE: Remote Control session spawned (PID: ${child.pid}, name: ${name})`);
  return child.pid;
}

// --- Wake Telegram: launch claude-tg via tmux (provides TTY) ---
const TMUX_PATH = env.TMUX_PATH || "/opt/homebrew/bin/tmux";
const TMUX_SESSION = "claude-tg";

function spawnClaudeTg() {
  if (isClaudeTgRunning()) {
    return { alreadyRunning: true };
  }

  try {
    execFileSync(TMUX_PATH, [
      "new-session", "-d",
      "-s", TMUX_SESSION,
      "-x", "120", "-y", "40",
      "-c", HOME,
      `${CLAUDE_PATH} --channels 'plugin:telegram@claude-plugins-official'`,
    ], {
      timeout: 10000,
      env: DAEMON_ENV,
    });
    log(`WAKE-TG: claude-tg launched in tmux session "${TMUX_SESSION}"`);
    return { launched: true };
  } catch (err) {
    log(`WAKE-TG: failed to launch tmux — ${err.message}`);
    return { error: err.message };
  }
}

// --- Bot ---
const bot = new TelegramBot(TOKEN, {
  polling: {
    params: { timeout: 30 },
    interval: 2000,
  },
});
log(`=== Sraosha v${VERSION} starting (wake layer only) ===`);

// --- Commands ---
const COMMANDS = {
  "/ping": "Vérifier que Sraosha est vivant",
  "/status": "État complet : daemon, sessions, claude-tg, TCC",
  "/wake": "Réveiller Claude Code (Remote Control)",
  "/tg": "Lancer claude-tg (canal Telegram officiel)",
  "/help": "Afficher les commandes",
};

// /ping — heartbeat check
bot.onText(/\/ping/, async (msg) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  await bot.sendMessage(
    msg.chat.id,
    `Pong ! Sraosha v${VERSION}\nUptime: ${h}h ${m}m\nNode: ${process.version} | PID: ${process.pid}`
  );
});

// /status — comprehensive status
bot.onText(/\/status/, async (msg) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();

  const sessions = getActiveSessions();
  const tgRunning = isClaudeTgRunning();
  const claudeVer = getClaudeVersion();
  const tccHits = detectTccErrors();

  const recentLogs = (() => {
    try {
      const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
      return lines
        .slice(-5)
        .map((l) => `  ${l.slice(0, 120)}`)
        .join("\n");
    } catch {
      return "  (pas de logs)";
    }
  })();

  const parts = [
    `Sraosha v${VERSION} — État complet`,
    "",
    `Daemon: ✅ actif (PID ${process.pid})`,
    `Node: ${process.version}`,
    `Claude CLI: ${claudeVer}`,
    "",
    `Sessions Claude: ${sessions.length === 0 ? "aucune" : sessions.length}`,
  ];

  if (sessions.length > 0) {
    for (const s of sessions.slice(0, 5)) {
      parts.push(
        `  - PID ${s.pid} | ${s.kind || "?"} | ${s.status || "?"}`
      );
    }
  }

  parts.push("");
  parts.push(`claude-tg: ${tgRunning ? "✅ actif" : "❌ inactif → /tg pour lancer"}`);
  parts.push(`Dernier wake: ${lastWakeAt || "aucun cette session"}`);
  parts.push(`Dernière commande: ${lastCommandAt || "aucune"}`);

  if (tccHits.length > 0) {
    parts.push("");
    parts.push(`⚠️ TCC/permissions (${tccHits.length} hit(s) récents):`);
    for (const hit of tccHits.slice(-3)) {
      parts.push(`  ${hit.slice(0, 120)}`);
    }
  }

  parts.push("");
  parts.push("Logs récents:");
  parts.push(recentLogs);

  await bot.sendMessage(msg.chat.id, parts.join("\n"));
});

// /wake — spawn Remote Control session
bot.onText(/\/wake(?:\s+(.+))?$/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  const chatId = msg.chat.id;
  const sessionName = match[1]?.trim() || "sraosha";

  const sessions = getActiveSessions();
  if (sessions.length > 0) {
    await bot.sendMessage(
      chatId,
      `${sessions.length} session(s) déjà active(s).\n` +
        sessions.map((s) => `  - PID ${s.pid} | ${s.kind || "?"}`).join("\n") +
        `\n\nOuvre l'app Claude pour Remote Control.\nOu /wake force pour en ajouter une.`
    );
    return;
  }

  await bot.sendMessage(chatId, "Réveil de Claude Code...");
  const pid = spawnRemoteControl(sessionName);

  await new Promise((r) => setTimeout(r, 5000));
  const newSessions = getActiveSessions();

  if (newSessions.length > 0) {
    await bot.sendMessage(
      chatId,
      `✅ Claude Code réveillé (PID: ${pid})\n` +
        `Sessions: ${newSessions.length}\n\n` +
        `Ouvre l'app Claude sur iPhone pour Remote Control.`
    );
  } else {
    await bot.sendMessage(
      chatId,
      `Session lancée (PID: ${pid}), initialisation en cours.\n/status dans quelques secondes.`
    );
  }
});

// /wake force — force a new session even if others exist
bot.onText(/\/wake\s+force/, async (msg) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  await bot.sendMessage(msg.chat.id, "Lancement forcé...");
  const pid = spawnRemoteControl(`force-${Date.now()}`);
  await bot.sendMessage(msg.chat.id, `✅ Nouvelle session (PID: ${pid}).`);
});

// /tg — launch or check claude-tg via tmux
bot.onText(/\/tg/, async (msg) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();
  const chatId = msg.chat.id;

  if (isClaudeTgRunning()) {
    await bot.sendMessage(
      chatId,
      "✅ claude-tg est actif.\n\n" +
        "Envoie tes messages à your Claude Telegram bot."
    );
    return;
  }

  await bot.sendMessage(chatId, "Lancement de claude-tg via tmux...");
  const result = spawnClaudeTg();

  if (result.error) {
    await bot.sendMessage(
      chatId,
      `❌ Échec du lancement : ${result.error}\n\n` +
        "Fallback : /wake pour Remote Control via l'app Claude."
    );
    return;
  }

  await new Promise((r) => setTimeout(r, 8000));

  if (isClaudeTgRunning()) {
    lastWakeAt = new Date().toISOString();
    await bot.sendMessage(
      chatId,
      "✅ claude-tg lancé !\n\n" +
        "Parle à Claude via your Claude Telegram bot.\n" +
        "Sraosha reste en veille — /status pour vérifier."
    );
  } else {
    await bot.sendMessage(
      chatId,
      "⚠️ tmux lancé mais claude-tg pas encore détecté.\n" +
        "/status dans quelques secondes.\n\n" +
        "Fallback : /wake pour Remote Control."
    );
  }
});

// /task — EXPERIMENTAL, restricted
bot.onText(/\/task(?:\s+(.+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  lastCommandAt = new Date().toISOString();

  const prompt = match[1]?.trim();
  if (!prompt) {
    await bot.sendMessage(
      msg.chat.id,
      "⚠️ /task est expérimental et limité.\n" +
        "Usage : /task <prompt simple>\n\n" +
        "Restrictions :\n" +
        "- Pas d'osascript / Apple Music / Finder\n" +
        "- Pas de commandes nécessitant TCC\n" +
        "- Pour les tâches complexes → /tg puis parle à Claude directement"
    );
    return;
  }

  const TCC_BLOCKLIST = [
    "osascript",
    "apple music",
    "applescript",
    "finder",
    "system events",
    "terminal",
    "contacts",
    "photos",
    "calendar",
    "reminders",
    "messages",
    "mail.app",
    "safari",
    "keychain",
  ];

  const lowerPrompt = prompt.toLowerCase();
  const blocked = TCC_BLOCKLIST.find((kw) => lowerPrompt.includes(kw));
  if (blocked) {
    await bot.sendMessage(
      msg.chat.id,
      `🚫 Bloqué : "${blocked}" nécessite des permissions macOS (TCC) qui ne peuvent pas être validées à distance.\n\n` +
        `Alternatives :\n` +
        `- /tg puis demande à Claude directement\n` +
        `- Exécute la commande sur le Mac`
    );
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `⚠️ EXPÉRIMENTAL — Tâche lancée : "${prompt}"\nMax 3 min. Résultat renvoyé ici.`
  );

  const child = spawn(
    CLAUDE_PATH,
    ["-p", prompt, "--output-format", "text", "--allowedTools", "Bash(git *),Read"],
    {
      cwd: DEFAULT_CWD,
      stdio: ["ignore", "pipe", "pipe"],
      env: DAEMON_ENV,
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    log(`TASK: timeout (PID: ${child.pid})`);
    bot.sendMessage(msg.chat.id, `Tâche expirée après 3 min (PID: ${child.pid}).`).catch(() => {});
  }, 3 * 60 * 1000);

  child.on("close", async (code) => {
    clearTimeout(timer);
    const result = stdout.trim() || stderr.trim() || "(aucune sortie)";
    const maxLen = 4000;
    const truncated =
      result.length > maxLen
        ? result.slice(0, maxLen) + "\n...(tronqué)"
        : result;
    log(`TASK: done (PID: ${child.pid}, exit: ${code}, len: ${result.length})`);
    try {
      await bot.sendMessage(
        msg.chat.id,
        `Tâche terminée (exit ${code}) :\n\n${truncated}`
      );
    } catch {}
  });

  log(`TASK: spawned (PID: ${child.pid}, prompt: "${prompt.slice(0, 80)}")`);
});

// /help
bot.onText(/\/help/, async (msg) => {
  if (!isAllowed(msg)) return;
  const lines = Object.entries(COMMANDS).map(
    ([cmd, desc]) => `${cmd} — ${desc}`
  );
  await bot.sendMessage(
    msg.chat.id,
    `Sraosha v${VERSION} — Wake Layer\n\n` +
      lines.join("\n") +
      `\n\n/task — ⚠️ expérimental, limité (pas d'osascript/TCC)`
  );
});

// /start
bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg)) return;
  await bot.sendMessage(
    msg.chat.id,
    `Sraosha v${VERSION} — Wake Layer\n` +
      `/help pour les commandes\n` +
      `/wake pour réveiller Claude (Remote Control)\n` +
      `/tg pour lancer le canal Telegram officiel`
  );
});

// Catch-all for non-command messages
bot.on("message", async (msg) => {
  if (!isAllowed(msg)) return;
  if (msg.text?.startsWith("/")) return;
  await bot.sendMessage(
    msg.chat.id,
    "Sraosha = wake layer uniquement.\n" +
      "/tg pour lancer Claude Telegram, puis parle-lui directement.\n" +
      "/help pour les commandes."
  );
});

// --- Error handling ---
bot.on("polling_error", (err) => {
  if (err.message?.includes("ECONNRESET")) {
    log(`POLLING: connection reset (will auto-reconnect)`);
  } else {
    log(`POLLING ERROR: ${err.message}`);
  }
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
