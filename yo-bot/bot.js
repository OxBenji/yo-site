import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LEADERBOARD_URL = process.env.LEADERBOARD_URL || "";

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env vars. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TOKEN, { polling: true });

// Match "yo" variants (yo, yooo, yyoo) as a standalone word
const YO_RE = /\by+o+\b/i;

// 60s per-user cooldown
const cooldowns = new Map();
const COOLDOWN_MS = 60_000;

// first yo of the day tracking (resets at UTC midnight)
let firstYoToday = null; // { date: 'YYYY-MM-DD', userId, name, announced: bool }

function utcDateStr() {
  return new Date().toISOString().slice(0, 10);
}

bot.on("message", async (msg) => {
  if (!msg.text || !YO_RE.test(msg.text)) return;

  const userId = msg.from.id;
  const now = Date.now();
  const lastYo = cooldowns.get(userId) || 0;
  if (now - lastYo < COOLDOWN_MS) return; // silently skip
  cooldowns.set(userId, now);

  const username = msg.from.username || null;
  const displayName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
    null;
  const handle = username || displayName || null;

  try {
    // Shared count: call the SAME say_yo RPC the website uses
    // Also log to tg_yo_log for /stats time windows + tg_yos for /leaderboard
    const [{ data: globalCount, error }, _log, _tg] = await Promise.all([
      supabase.rpc("say_yo", { p_handle: handle }),
      supabase.from("tg_yo_log").insert({ user_id: userId, username }),
      supabase.rpc("say_tg_yo", {
        p_user_id: userId,
        p_username: username,
        p_display_name: displayName,
      }),
    ]);

    if (error) {
      console.error("say_yo rpc error:", error.message);
      return;
    }

    const count = typeof globalCount === "number" ? globalCount : null;

    // first yo of the day crown
    const today = utcDateStr();
    if (!firstYoToday || firstYoToday.date !== today) {
      const who = username ? `@${username}` : displayName || "someone";
      firstYoToday = { date: today, userId, name: who, announced: true };
      bot.sendMessage(msg.chat.id, `👑 first yo of the day — ${who}. say it back.`);
    }

    // milestone shoutouts
    if (count && count % 100 === 0) {
      bot.sendMessage(
        msg.chat.id,
        `🔴 ${count.toLocaleString()} yo's. say it back.`,
        { reply_to_message_id: msg.message_id }
      );
    }
  } catch (err) {
    console.error("bot error:", err.message);
  }
});

// /leaderboard — top 10 (still uses tg_yos for per-user ranking)
bot.onText(/\/leaderboard/, async (msg) => {
  try {
    const { data, error } = await supabase
      .from("tg_yos")
      .select("username, display_name, yo_count")
      .order("yo_count", { ascending: false })
      .limit(10);

    if (error || !data?.length) {
      bot.sendMessage(msg.chat.id, "no yo's yet. say yo.");
      return;
    }

    const medals = ["1.", "2.", "3."];
    const lines = data.map((r, i) => {
      const rank = medals[i] || `${i + 1}.`;
      const name = r.username ? `@${r.username}` : r.display_name || "anon";
      return `${rank} ${name} — ${r.yo_count} yo's`;
    });

    let text = "YO LEADERBOARD\n\n" + lines.join("\n");
    if (LEADERBOARD_URL) {
      text += `\n\n${LEADERBOARD_URL}`;
    }

    bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    console.error("leaderboard error:", err.message);
  }
});

// /myyo — personal count (from tg_yos)
bot.onText(/\/myyo/, async (msg) => {
  try {
    const { data } = await supabase
      .from("tg_yos")
      .select("yo_count")
      .eq("user_id", msg.from.id)
      .single();

    const count = data?.yo_count || 0;
    bot.sendMessage(
      msg.chat.id,
      count > 0
        ? `you've said yo ${count} time${count === 1 ? "" : "s"}.`
        : "you haven't said yo yet. say it.",
      { reply_to_message_id: msg.message_id }
    );
  } catch (err) {
    console.error("myyo error:", err.message);
  }
});

// --- time-based stats helpers ---

async function countSince(since) {
  const { count, error } = await supabase
    .from("tg_yo_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);
  if (error) throw error;
  return count || 0;
}

async function allTimeCount() {
  // Read from the shared global counter (same as website)
  const { data, error } = await supabase
    .from("counters")
    .select("value")
    .eq("id", "yo")
    .single();
  if (error) throw error;
  return data?.value || 0;
}

async function loudestSince(since) {
  const { data, error } = await supabase
    .from("tg_yo_log")
    .select("username")
    .gte("created_at", since);
  if (error || !data?.length) return null;
  const counts = {};
  for (const r of data) {
    const key = r.username || "_anon";
    counts[key] = (counts[key] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[0] === "_anon") return null;
  return { username: top[0], count: top[1] };
}

function fmt(n) { return n.toLocaleString(); }

function todayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// /today
bot.onText(/\/today/, async (msg) => {
  try {
    const n = await countSince(todayUTC());
    bot.sendMessage(msg.chat.id, `🔴 today: ${fmt(n)} yo's`);
  } catch (err) {
    console.error("today error:", err.message);
  }
});

// /week
bot.onText(/\/week/, async (msg) => {
  try {
    const n = await countSince(daysAgo(7));
    bot.sendMessage(msg.chat.id, `🔴 this week: ${fmt(n)} yo's`);
  } catch (err) {
    console.error("week error:", err.message);
  }
});

// /month
bot.onText(/\/month/, async (msg) => {
  try {
    const n = await countSince(daysAgo(30));
    bot.sendMessage(msg.chat.id, `🔴 this month: ${fmt(n)} yo's`);
  } catch (err) {
    console.error("month error:", err.message);
  }
});

// /stats — full summary
bot.onText(/\/stats/, async (msg) => {
  try {
    const todaySince = todayUTC();
    const [today, week, month, allTime, loud] = await Promise.all([
      countSince(todaySince),
      countSince(daysAgo(7)),
      countSince(daysAgo(30)),
      allTimeCount(),
      loudestSince(todaySince),
    ]);

    let text = `🔴 YO stats\n\ntoday: ${fmt(today)}\nthis week: ${fmt(week)}\nthis month: ${fmt(month)}\nall-time: ${fmt(allTime)}`;
    if (loud) {
      text += `\n\nloudest today: @${loud.username} (${loud.count})`;
    }
    bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    console.error("stats error:", err.message);
  }
});

// /start and /help
const HELP_TEXT = `🔴 yo.

say yo in the chat. that's it. every yo counts globally — same number on the site and here.

commands:
/stats — full yo summary
/today — yo's said today
/week — this week
/month — this month
/leaderboard — top 10 yo'ers
/myyo — your personal count

one word. infinite meanings. say it back.`;

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, HELP_TEXT));
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, HELP_TEXT));

// auto-greet new members
bot.on("new_chat_members", (msg) => {
  for (const member of msg.new_chat_members) {
    if (member.is_bot) continue;
    const name = member.username
      ? `@${member.username}`
      : member.first_name || "anon";
    bot.sendMessage(msg.chat.id, `yo ${name}. you said it back. you're in. 🔴`);
  }
});

console.log("YO bot is live. listening for yo's...");
