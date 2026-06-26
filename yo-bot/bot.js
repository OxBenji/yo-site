import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL = process.env.SITE_URL || "https://justsayyo.xyz";
const LEADERBOARD_URL = process.env.LEADERBOARD_URL || `${SITE_URL}/leaderboard.html`;
let cachedCA = process.env.CONTRACT_ADDRESS || "";
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RAIDS_ENABLED = (process.env.RAIDS_ENABLED || "").toLowerCase() === "true";
const TWEET_RE = /https?:\/\/(x|twitter)\.com\/\w+\/status\/(\d+)/i;
const RAID_COOLDOWN_MS = 10 * 60 * 1000; // 10 min per-user raid scoring cooldown
const raidCooldowns = new Map();

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
let firstYoToday = null;

function utcDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmt(n) { return (n || 0).toLocaleString(); }

function todayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// --- helpers ---

async function countSince(since) {
  const { count, error } = await supabase
    .from("tg_yo_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since);
  if (error) throw error;
  return count || 0;
}

async function allTimeCount() {
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

async function getUserRank(userId) {
  const { data, error } = await supabase
    .from("tg_yos")
    .select("user_id, yo_count")
    .order("yo_count", { ascending: false });
  if (error || !data?.length) return { rank: 0, total: 0, count: 0 };
  const idx = data.findIndex((r) => String(r.user_id) === String(userId));
  const count = idx >= 0 ? data[idx].yo_count : 0;
  return { rank: idx >= 0 ? idx + 1 : data.length + 1, total: data.length, count };
}

function getLevel(count) {
  // levels: 1-9 yo = level 1, 10-24 = level 2, 25-49 = 3, 50-99 = 4, 100-249 = 5,
  // 250-499 = 6, 500-999 = 7, 1000-2499 = 8, 2500-4999 = 9, 5000+ = 10
  const thresholds = [0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  let lvl = 1;
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (count >= thresholds[i]) { lvl = i + 1; break; }
  }
  const next = lvl < thresholds.length ? thresholds[lvl] : null;
  return { lvl, next };
}

function getBadges(count, streak, daysActive) {
  const badges = [];
  if (count >= 1) badges.push("said it back");
  if (count >= 50) badges.push("yoer");
  if (count >= 100) badges.push("centurion");
  if (count >= 500) badges.push("yo lord");
  if (count >= 1000) badges.push("yo god");
  if (streak >= 3) badges.push("on fire");
  if (streak >= 7) badges.push("unstoppable");
  if (streak >= 30) badges.push("legendary");
  if (daysActive >= 7) badges.push("raider");
  if (daysActive >= 30) badges.push("OG");
  return badges;
}

async function getUserStreak(userId) {
  // get distinct days the user yo'd, ordered desc
  const { data, error } = await supabase
    .from("tg_yo_log")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error || !data?.length) return { streak: 0, daysActive: 0 };

  const days = [...new Set(data.map((r) => r.created_at.slice(0, 10)))].sort().reverse();
  const daysActive = days.length;

  // count streak from today/yesterday backwards
  let streak = 0;
  const today = utcDateStr();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  // start counting if they yo'd today or yesterday
  let checkDate = days[0] === today ? today : days[0] === yesterday ? yesterday : null;
  if (!checkDate) return { streak: 0, daysActive };

  for (const day of days) {
    if (day === checkDate) {
      streak++;
      // move checkDate back one day
      const d = new Date(checkDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 1);
      checkDate = d.toISOString().slice(0, 10);
    } else if (day < checkDate) {
      break;
    }
  }
  return { streak, daysActive };
}

function getMilestoneStep(n) {
  if (n < 1000) return 100;
  if (n < 10000) return 1000;
  return 10000;
}

function nextMilestone(n) {
  const step = getMilestoneStep(n + 1);
  return Math.ceil((n + 1) / step) * step;
}

// --- CA config helpers ---

async function loadCA() {
  try {
    const { data } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "yo_ca")
      .single();
    if (data?.value) cachedCA = data.value;
  } catch (e) {
    // table may not exist yet, fall back to env
  }
}

async function saveCA(address) {
  cachedCA = address;
  await supabase.from("app_config").upsert({ key: "yo_ca", value: address });
}

async function clearCA() {
  cachedCA = "";
  await supabase.from("app_config").upsert({ key: "yo_ca", value: "" });
}

async function isAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (e) {
    return false;
  }
}

// load CA from DB on startup
loadCA();

// ============ YO MESSAGE HANDLER ============

bot.on("message", async (msg) => {
  if (!msg.text || !YO_RE.test(msg.text)) return;

  const userId = msg.from.id;
  const now = Date.now();
  const lastYo = cooldowns.get(userId) || 0;
  if (now - lastYo < COOLDOWN_MS) return;
  cooldowns.set(userId, now);

  const username = msg.from.username || null;
  const displayName =
    [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || null;
  const handle = username || displayName || null;

  try {
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
      firstYoToday = { date: today, userId, name: who };
      bot.sendMessage(msg.chat.id, `\u{1F451} first yo of the day \u2014 ${who}. say it back.`);
    }

    // milestone shoutouts
    if (count && count % getMilestoneStep(count) === 0) {
      bot.sendMessage(
        msg.chat.id,
        `\u{1F534} ${count.toLocaleString()} yo's. say it back.`,
        { reply_to_message_id: msg.message_id }
      );
    }
  } catch (err) {
    console.error("bot error:", err.message);
  }
});

// ============ COMMANDS ============

// /yos — live global count
bot.onText(/\/yos/, async (msg) => {
  try {
    const n = await allTimeCount();
    bot.sendMessage(msg.chat.id, `\u{1F534} ${fmt(n)} yo's. say it back.`);
  } catch (err) {
    console.error("yos error:", err.message);
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

    let text = `\u{1F534} YO stats\n\ntoday: ${fmt(today)}\nthis week: ${fmt(week)}\nthis month: ${fmt(month)}\nall-time: ${fmt(allTime)}`;
    if (loud) text += `\n\nloudest today: @${loud.username} (${loud.count})`;
    bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    console.error("stats error:", err.message);
  }
});

// /today
bot.onText(/\/today/, async (msg) => {
  try {
    const n = await countSince(todayUTC());
    bot.sendMessage(msg.chat.id, `\u{1F534} today: ${fmt(n)} yo's`);
  } catch (err) {
    console.error("today error:", err.message);
  }
});

// /week
bot.onText(/\/week/, async (msg) => {
  try {
    const n = await countSince(daysAgo(7));
    bot.sendMessage(msg.chat.id, `\u{1F534} this week: ${fmt(n)} yo's`);
  } catch (err) {
    console.error("week error:", err.message);
  }
});

// /month
bot.onText(/\/month/, async (msg) => {
  try {
    const n = await countSince(daysAgo(30));
    bot.sendMessage(msg.chat.id, `\u{1F534} this month: ${fmt(n)} yo's`);
  } catch (err) {
    console.error("month error:", err.message);
  }
});

// /streak — personal daily streak
bot.onText(/\/streak/, async (msg) => {
  try {
    const { streak, daysActive } = await getUserStreak(msg.from.id);
    const name = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "anon";
    if (streak === 0) {
      bot.sendMessage(msg.chat.id, `${name} — no streak yet. say yo today to start one.`, { reply_to_message_id: msg.message_id });
    } else {
      let text = `${name}\n\n\u{1F525} ${streak} day streak\n${daysActive} total days active`;
      if (streak >= 7) text += "\n\nyou're unstoppable.";
      else if (streak >= 3) text += "\n\non fire. don't break it.";
      bot.sendMessage(msg.chat.id, text, { reply_to_message_id: msg.message_id });
    }
  } catch (err) {
    console.error("streak error:", err.message);
  }
});

// /yome — personal rank, level, badges
bot.onText(/\/yome/, async (msg) => {
  try {
    const userId = msg.from.id;
    const name = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "anon";
    const [rankData, streakData] = await Promise.all([
      getUserRank(userId),
      getUserStreak(userId),
    ]);

    if (rankData.count === 0) {
      bot.sendMessage(msg.chat.id, `${name} — you haven't said yo yet. say it.`, { reply_to_message_id: msg.message_id });
      return;
    }

    const { lvl, next } = getLevel(rankData.count);
    const badges = getBadges(rankData.count, streakData.streak, streakData.daysActive);

    let text = `\u{1F534} ${name}\n\n`;
    text += `rank: #${rankData.rank} of ${rankData.total}\n`;
    text += `level: ${lvl}${next ? ` (${rankData.count}/${next} to next)` : " (max)"}\n`;
    text += `yo's: ${fmt(rankData.count)}\n`;
    text += `streak: ${streakData.streak} day${streakData.streak === 1 ? "" : "s"}\n`;
    text += `days active: ${streakData.daysActive}`;
    if (badges.length) text += `\n\nbadges: ${badges.join(" \u00b7 ")}`;
    bot.sendMessage(msg.chat.id, text, { reply_to_message_id: msg.message_id });
  } catch (err) {
    console.error("yome error:", err.message);
  }
});

// /leaderboard — top 10 + caller's rank
bot.onText(/\/leaderboard/, async (msg) => {
  try {
    const { data, error } = await supabase
      .from("tg_yos")
      .select("user_id, username, display_name, yo_count")
      .order("yo_count", { ascending: false })
      .limit(10);

    if (error || !data?.length) {
      bot.sendMessage(msg.chat.id, "no yo's yet. say yo.");
      return;
    }

    const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
    const lines = data.map((r, i) => {
      const rank = medals[i] || `${i + 1}.`;
      const name = r.username ? `@${r.username}` : r.display_name || "anon";
      return `${rank} ${name} \u2014 ${r.yo_count} yo's`;
    });

    let text = "\u{1F534} YO LEADERBOARD\n\n" + lines.join("\n");

    // add caller's rank if not in top 10
    const callerId = msg.from.id;
    const inTop = data.some((r) => String(r.user_id) === String(callerId));
    if (!inTop) {
      const { rank, count } = await getUserRank(callerId);
      if (count > 0) {
        const callerName = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "you";
        text += `\n\n${callerName}: #${rank} \u2014 ${count} yo's`;
      }
    }

    if (LEADERBOARD_URL) text += `\n\n${LEADERBOARD_URL}`;
    bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    console.error("leaderboard error:", err.message);
  }
});

// /raiders — most consistent (loyalty = days active, not just volume)
bot.onText(/\/raiders/, async (msg) => {
  try {
    const { data, error } = await supabase
      .from("tg_yo_log")
      .select("user_id, username, created_at");
    if (error || !data?.length) {
      bot.sendMessage(msg.chat.id, "no raiders yet. say yo every day.");
      return;
    }

    // count distinct active days per user
    const users = {};
    for (const r of data) {
      const key = r.user_id;
      if (!users[key]) users[key] = { username: r.username, days: new Set() };
      if (r.username) users[key].username = r.username;
      users[key].days.add(r.created_at.slice(0, 10));
    }

    const ranked = Object.entries(users)
      .map(([uid, u]) => ({ uid, username: u.username, daysActive: u.days.size }))
      .sort((a, b) => b.daysActive - a.daysActive)
      .slice(0, 10);

    const lines = ranked.map((r, i) => {
      const name = r.username ? `@${r.username}` : "anon";
      return `${i + 1}. ${name} \u2014 ${r.daysActive} day${r.daysActive === 1 ? "" : "s"}`;
    });

    bot.sendMessage(msg.chat.id, "\u{1F534} RAIDERS (loyalty, not spam)\n\n" + lines.join("\n"));
  } catch (err) {
    console.error("raiders error:", err.message);
  }
});

// /milestones — progress toward next milestone
bot.onText(/\/milestones/, async (msg) => {
  try {
    const count = await allTimeCount();
    const next = nextMilestone(count);
    const remaining = next - count;
    const pct = Math.floor((count / next) * 100);
    const bar = "\u2588".repeat(Math.floor(pct / 10)) + "\u2591".repeat(10 - Math.floor(pct / 10));

    let text = `\u{1F534} milestone tracker\n\n`;
    text += `current: ${fmt(count)} yo's\n`;
    text += `next: ${fmt(next)}\n`;
    text += `remaining: ${fmt(remaining)}\n\n`;
    text += `[${bar}] ${pct}%`;
    bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    console.error("milestones error:", err.message);
  }
});

// /ca — contract address (read from config)
bot.onText(/\/ca$/, (msg) => {
  if (cachedCA) {
    bot.sendMessage(msg.chat.id, `\u{1F534} official $YO CA:\n\`${cachedCA}\`\n\nonly this one. verify before you ape.`, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(msg.chat.id, "\u{1F534} not live yet. CA drops at launch \u2014 only trust what's posted here.");
  }
});

// /setca <address> — admins only, saves to Supabase
bot.onText(/\/setca(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!(await isAdmin(chatId, userId))) {
    bot.sendMessage(chatId, "\u{1F534} admins only.");
    return;
  }

  const address = (match[1] || "").trim();
  if (!address) {
    bot.sendMessage(chatId, "\u{1F534} usage: /setca <solana address>");
    return;
  }

  if (!SOL_ADDR_RE.test(address)) {
    bot.sendMessage(chatId, "\u{1F534} that doesn't look like a valid solana address. check and try again.");
    return;
  }

  try {
    await saveCA(address);
    bot.sendMessage(chatId, `\u{1F534} CA set \u2705\n\`${address}\`\n\nthis is now the official /ca. verify before you ape.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("setca error:", err.message);
    bot.sendMessage(chatId, "\u{1F534} error saving CA. try again.");
  }
});

// /clearca — admins only, wipe CA
bot.onText(/\/clearca/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!(await isAdmin(chatId, userId))) {
    bot.sendMessage(chatId, "\u{1F534} admins only.");
    return;
  }

  try {
    await clearCA();
    bot.sendMessage(chatId, "\u{1F534} CA cleared.");
  } catch (err) {
    console.error("clearca error:", err.message);
  }
});

// /myyo — personal count
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

// ============ RAID TRACKER ============

// detect tweet links in chat — log as raid drops
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const match = msg.text.match(TWEET_RE);
  if (!match) return;

  if (!RAIDS_ENABLED) return; // silently ignore when off

  const userId = msg.from.id;
  const username = msg.from.username || null;
  const tweetUrl = match[0].replace(/^https?:\/\/twitter\.com/, "https://x.com"); // normalize

  // 10-min per-user cooldown for scoring
  const now = Date.now();
  const lastRaid = raidCooldowns.get(userId) || 0;
  if (now - lastRaid < RAID_COOLDOWN_MS) return;

  try {
    // insert with unique tweet_url — duplicates silently ignored
    const { error } = await supabase
      .from("raid_drops")
      .insert({ user_id: userId, username, tweet_url: tweetUrl });

    if (error) {
      // unique violation = dupe link, just ignore
      if (error.code === "23505") return;
      console.error("raid insert error:", error.message);
      return;
    }

    raidCooldowns.set(userId, now);
    const who = username ? `@${username}` : msg.from.first_name || "anon";
    bot.sendMessage(msg.chat.id, `\u{1F534} raid drop logged \u2014 ${who} is saying it back on X.`, {
      reply_to_message_id: msg.message_id,
    });
  } catch (err) {
    console.error("raid error:", err.message);
  }
});

// /raids — top 10 raiders last 3 days
bot.onText(/\/raids$/, async (msg) => {
  if (!RAIDS_ENABLED) {
    bot.sendMessage(msg.chat.id, "\u{1F534} raids not live yet.");
    return;
  }

  try {
    const since = daysAgo(3);
    const { data, error } = await supabase
      .from("raid_drops")
      .select("user_id, username")
      .gte("created_at", since);

    if (error || !data?.length) {
      bot.sendMessage(msg.chat.id, "\u{1F534} no raids in the last 3 days. drop a tweet link to start.");
      return;
    }

    // count distinct links per user
    const counts = {};
    for (const r of data) {
      const key = r.user_id;
      if (!counts[key]) counts[key] = { username: r.username, n: 0 };
      if (r.username) counts[key].username = r.username;
      counts[key].n++;
    }

    const ranked = Object.values(counts)
      .sort((a, b) => b.n - a.n)
      .slice(0, 10);

    const medals = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
    const lines = ranked.map((r, i) => {
      const rank = medals[i] || `${i + 1}.`;
      const name = r.username ? `@${r.username}` : "anon";
      return `${rank} ${name} \u2014 ${r.n} raid${r.n === 1 ? "" : "s"}`;
    });

    bot.sendMessage(msg.chat.id, "\u{1F534} RAID LEADERBOARD (last 3 days)\n\n" + lines.join("\n"));
  } catch (err) {
    console.error("raids error:", err.message);
  }
});

// /raidshout — admin-only, shout out top 3 raiders
bot.onText(/\/raidshout/, async (msg) => {
  if (!RAIDS_ENABLED) {
    bot.sendMessage(msg.chat.id, "\u{1F534} raids not live yet.");
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!(await isAdmin(chatId, userId))) {
    bot.sendMessage(chatId, "\u{1F534} admins only.");
    return;
  }

  try {
    const since = daysAgo(3);
    const { data, error } = await supabase
      .from("raid_drops")
      .select("user_id, username")
      .gte("created_at", since);

    if (error || !data?.length) {
      bot.sendMessage(chatId, "\u{1F534} no raids to shout out.");
      return;
    }

    const counts = {};
    for (const r of data) {
      const key = r.user_id;
      if (!counts[key]) counts[key] = { username: r.username, n: 0 };
      if (r.username) counts[key].username = r.username;
      counts[key].n++;
    }

    const top3 = Object.values(counts)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);

    const hype = ["\u{1F525}\u{1F525}\u{1F525}", "\u{1F525}\u{1F525}", "\u{1F525}"];
    const lines = top3.map((r, i) => {
      const name = r.username ? `@${r.username}` : "anon";
      return `${hype[i]} ${name} \u2014 ${r.n} raid${r.n === 1 ? "" : "s"}`;
    });

    bot.sendMessage(chatId, "\u{1F534} RAID SHOUTOUT\n\nthese ones said it back the hardest:\n\n" + lines.join("\n") + "\n\nyo. \u{1F534}");
  } catch (err) {
    console.error("raidshout error:", err.message);
  }
});

// /start and /help
const HELP_TEXT = `\u{1F534} welcome to YO. say it back.

every yo counts \u2014 here + on the site, same number.
${SITE_URL}

what you can do:
/yos \u2014 the live count
/stats \u2014 today / week / month / all-time
/streak \u2014 your daily streak (don't break it)
/yome \u2014 your rank, level + badges
/leaderboard \u2014 top yo'ers + your spot
/raiders \u2014 the real ones (loyalty, not spam)
/milestones \u2014 how close to the next goal
/ca \u2014 official contract (verify before you ape)
/raids \u2014 top raiders (last 3 days)
/raidshout \u2014 shout out top raiders (admin)

say yo. that's the whole religion. \u{1F534}`;

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, HELP_TEXT));
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, HELP_TEXT));

// auto-greet new members
bot.on("new_chat_members", (msg) => {
  for (const member of msg.new_chat_members) {
    if (member.is_bot) continue;
    const name = member.username
      ? `@${member.username}`
      : member.first_name || "anon";
    bot.sendMessage(msg.chat.id, `yo ${name}. you said it back. you're in. \u{1F534}`);
  }
});

console.log("YO bot is live. listening for yo's...");
