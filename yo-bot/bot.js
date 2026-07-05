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
const YOIFY_API = process.env.YOIFY_API || "https://api.justsayyo.xyz/api/yoify-public";
const YOIFY_COLORS = ["vermilion", "magenta", "emerald", "gold", "ice"];
function shareToXUrl(color) {
  const text = `just got yo'd. (${color})\n\nget yours: ${SITE_URL}\n\n$YO`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}
const SHARE_X_MARKUP = (color) => ({
  reply_markup: { inline_keyboard: [[{ text: "share to X", url: shareToXUrl(color) }]] },
});
const COLOR_ALIASES = { blue: "ice", cyan: "ice", red: "vermilion", green: "emerald", yellow: "gold", pink: "magenta" };
function resolveColor(input) {
  if (!input) return null;
  const lower = input.toLowerCase();
  if (YOIFY_COLORS.includes(lower)) return lower;
  return COLOR_ALIASES[lower] || null;
}

// save yo'd thumbnail to gallery for site background
async function saveToGallery(dataUrl) {
  try {
    // resize to 128x128 thumbnail server-side (just crop center + compress the b64)
    // for simplicity, store a smaller slice of the original
    const thumb = dataUrl.length > 200000
      ? dataUrl.slice(0, 200000) // cap at ~150KB base64
      : dataUrl;
    await fetch(SUPABASE_URL + '/rest/v1/yo_gallery', {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ thumb }),
    });
  } catch (e) { /* silent */ }
}
const TWEET_RE = /https?:\/\/(x|twitter)\.com\/\w+\/status\/(\d+)/i;
const RAID_COOLDOWN_MS = 10 * 60 * 1000; // 10 min per-user raid scoring cooldown
const raidCooldowns = new Map();

if (!TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env vars. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TOKEN, {
  polling: { interval: 1000, params: { timeout: 30 } },
});

// suppress polling errors (transient DNS/network) — bot auto-retries
bot.on("polling_error", (err) => {
  if (err.code === "EFATAL") return; // silent — auto-reconnects
  console.error("[polling]", err.message);
});

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
  const { data: user, error: userErr } = await supabase
    .from("tg_yos")
    .select("yo_count")
    .eq("user_id", userId)
    .single();
  if (userErr || !user) return { rank: 0, total: 0, count: 0 };

  const [{ count: above }, { count: total }] = await Promise.all([
    supabase.from("tg_yos").select("*", { count: "exact", head: true }).gt("yo_count", user.yo_count),
    supabase.from("tg_yos").select("*", { count: "exact", head: true }),
  ]);

  return { rank: (above || 0) + 1, total: total || 0, count: user.yo_count };
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

// ============ RANDOM YO-BACK REPLIES ============

const YO_REPLIES = [
  "yo.",
  "said it back.",
  "heard.",
  "yo \u{1F534}",
  "the culture.",
  "one of us.",
  "yo yo yo.",
  "this is the way.",
  "say it louder.",
  "never stop.",
];
const YO_REPLY_CHANCE = 0.1; // 10% chance to reply

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
    } else if (Math.random() < YO_REPLY_CHANCE) {
      // random yo-back
      const reply = YO_REPLIES[Math.floor(Math.random() * YO_REPLIES.length)];
      bot.sendMessage(msg.chat.id, reply, { reply_to_message_id: msg.message_id });
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
    const { data, error } = await supabase.rpc("top_raiders", { lim: 10 });
    if (error) {
      // fallback: limited fetch if RPC not yet deployed
      console.error("top_raiders rpc error (run missing-tables.sql?):", error.message);
      bot.sendMessage(msg.chat.id, "no raiders yet. say yo every day.");
      return;
    }
    if (!data?.length) {
      bot.sendMessage(msg.chat.id, "no raiders yet. say yo every day.");
      return;
    }

    const lines = data.map((r, i) => {
      const name = r.username ? `@${r.username}` : "anon";
      return `${i + 1}. ${name} \u2014 ${r.days_active} day${r.days_active === 1 ? "" : "s"}`;
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

// /price — live token price from DexScreener
bot.onText(/\/price/, async (msg) => {
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/ornwNKzfS4FFQ81ibSfZLvTwUXgETnsG3YpUxyoPumP");
    const data = await res.json();
    if (!data.pairs?.length) {
      bot.sendMessage(msg.chat.id, "\u{1F534} no trading data yet.");
      return;
    }
    const p = data.pairs[0];
    const price = parseFloat(p.priceUsd);
    const mc = p.fdv ? `$${Math.floor(p.fdv).toLocaleString()}` : "n/a";
    const vol = p.volume?.h24 ? `$${Math.floor(p.volume.h24).toLocaleString()}` : "n/a";
    const chg = p.priceChange?.h24 != null ? `${p.priceChange.h24 > 0 ? "+" : ""}${p.priceChange.h24}%` : "n/a";

    let text = `\u{1F534} $YO price\n\n`;
    text += `price: $${price < 0.01 ? price.toExponential(2) : price.toFixed(4)}\n`;
    text += `mcap: ${mc}\n`;
    text += `24h vol: ${vol}\n`;
    text += `24h: ${chg}\n\n`;
    text += `https://dexscreener.com/solana/ornwNKzfS4FFQ81ibSfZLvTwUXgETnsG3YpUxyoPumP`;
    bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    console.error("price error:", err.message);
    bot.sendMessage(msg.chat.id, "\u{1F534} couldn't fetch price. try again.");
  }
});

// /holders — live holder count + top 5 from on-chain
bot.onText(/\/holders/, async (msg) => {
  try {
    const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/ornwNKzfS4FFQ81ibSfZLvTwUXgETnsG3YpUxyoPumP");
    const data = await res.json();
    const pair = data.pairs?.[0];

    // Get holder count from Helius DAS API
    const heliusRes = await fetch("https://mainnet.helius-rpc.com/?api-key=5b54563d-d809-4b36-9788-3f838e1dd6a4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTokenLargestAccounts",
        params: ["ornwNKzfS4FFQ81ibSfZLvTwUXgETnsG3YpUxyoPumP"],
      }),
    });
    const heliusData = await heliusRes.json();
    const accounts = (heliusData.result?.value || []).filter(a => parseFloat(a.uiAmountString) > 0);

    let text = `\u{1F534} $YO holders\n\n`;
    text += `holders: ${accounts.length}+\n`;
    if (pair) {
      text += `price: $${parseFloat(pair.priceUsd) < 0.01 ? parseFloat(pair.priceUsd).toExponential(2) : parseFloat(pair.priceUsd).toFixed(4)}\n`;
      text += `mcap: $${pair.fdv ? Math.floor(pair.fdv).toLocaleString() : "n/a"}\n\n`;
    }

    text += `top 5:\n`;
    const top5 = accounts.slice(0, 5);
    for (let i = 0; i < top5.length; i++) {
      const a = top5[i];
      const bal = parseFloat(a.uiAmountString);
      const pct = (bal / 1e9 * 100).toFixed(1);
      const addr = a.address.slice(0, 6) + "..." + a.address.slice(-4);
      text += `${i + 1}. ${addr} \u2014 ${pct}%\n`;
    }

    text += `\nhttps://pump.fun/coin/ornwNKzfS4FFQ81ibSfZLvTwUXgETnsG3YpUxyoPumP`;
    bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    console.error("holders error:", err.message);
    bot.sendMessage(msg.chat.id, "\u{1F534} couldn't fetch holder data. try again.");
  }
});

// /website — link to the site
bot.onText(/\/website/, (msg) => {
  bot.sendMessage(msg.chat.id, `\u{1F534} ${SITE_URL}\n\nsay it back.`);
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
const HELP_TEXT = `\u{1F534} YO

The most versatile word on the internet. A greeting, a question, a celebration, a warning, a joke. Everybody knows it. Everybody uses it. Just Say Yo.

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
/price \u2014 live $YO price + chart
/website \u2014 justsayyo.xyz
/yoify \u2014 send a photo, get yo'd (colors: vermilion, magenta, emerald, gold, ice \u2014 or just say red, pink, green, blue)
/raids \u2014 top raiders (last 3 days)
/raidshout \u2014 shout out top raiders (admin)

say yo. that's the whole religion. \u{1F534}`;

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, HELP_TEXT));
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, HELP_TEXT));

// ============ GET YO'D (photo handler) ============

const yoifyQueue = new Map(); // userId -> true (prevent double-tap)

bot.onText(/\/yoify(?:\s+(\w+))?/, (msg, match) => {
  const color = match[1] ? resolveColor(match[1]) : null;
  bot.sendMessage(msg.chat.id,
    `send me a photo and I'll yo it.\n\ncolors: ${YOIFY_COLORS.join(", ")}${color ? `\n\nusing: ${color}` : ""}`,
    { reply_to_message_id: msg.message_id }
  );
  // store color preference if provided
  if (color) yoifyQueue.set(msg.from.id, color);
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // check caption for color
  let color = yoifyQueue.get(userId) || null;
  if (msg.caption) {
    const lower = msg.caption.toLowerCase().trim();
    const words = lower.split(/\s+/);
    const found = words.map(resolveColor).find(Boolean);
    if (found) color = found;
  }
  yoifyQueue.delete(userId);

  // if no color chosen, show inline buttons
  if (!color) {
    // store photo file_id for later
    const photo = msg.photo[msg.photo.length - 1];
    yoifyQueue.set(`photo:${userId}`, { fileId: photo.file_id, msgId: msg.message_id, chatId });
    const buttons = YOIFY_COLORS.map(c => ({ text: c, callback_data: `yoify:${c}` }));
    bot.sendMessage(chatId, "pick a color:", {
      reply_to_message_id: msg.message_id,
      reply_markup: { inline_keyboard: [buttons] },
    });
    return;
  }

  // prevent spam
  if (yoifyQueue.get(`lock:${userId}`)) {
    bot.sendMessage(chatId, "hold up — still yo'ing your last one.", { reply_to_message_id: msg.message_id });
    return;
  }
  yoifyQueue.set(`lock:${userId}`, true);

  const status = await bot.sendMessage(chatId, "yo'ing... ~30-60s", { reply_to_message_id: msg.message_id });

  try {
    // get highest res photo
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

    // download and convert to base64
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error("failed to download photo");
    const buf = Buffer.from(await res.arrayBuffer());
    const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;

    // call yoify API
    const apiRes = await fetch(YOIFY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, color }),
    });

    const data = await apiRes.json();
    if (!apiRes.ok) throw new Error(data.error || "generation failed");

    // extract base64 and send as photo
    const b64 = data.image.split(",")[1];
    const imgBuf = Buffer.from(b64, "base64");

    await bot.sendPhoto(chatId, imgBuf, {
      caption: `yo'd. (${color})\n\nget yo'd: ${SITE_URL}`,
      reply_to_message_id: msg.message_id,
      ...SHARE_X_MARKUP(color),
    }, { filename: "yod.png", contentType: "image/png" });

    saveToGallery(data.image);
    // delete the "yo'ing..." message
    try { await bot.deleteMessage(chatId, status.message_id); } catch {}
  } catch (err) {
    console.error("[yoify-bot]", err.message);
    try { await bot.deleteMessage(chatId, status.message_id); } catch {}
    bot.sendMessage(chatId, `couldn't yo that: ${err.message}`, { reply_to_message_id: msg.message_id });
  } finally {
    yoifyQueue.delete(`lock:${userId}`);
  }
});

// ============ INLINE COLOR CALLBACK ============
bot.on("callback_query", async (query) => {
  if (!query.data.startsWith("yoify:")) return;
  const color = query.data.split(":")[1];
  const userId = query.from.id;
  const stored = yoifyQueue.get(`photo:${userId}`);

  await bot.answerCallbackQuery(query.id, { text: color });
  // remove the color picker message
  try { await bot.deleteMessage(query.message.chat.id, query.message.message_id); } catch {}

  if (!stored) {
    bot.sendMessage(query.message.chat.id, "photo expired — send it again.");
    return;
  }
  yoifyQueue.delete(`photo:${userId}`);

  if (yoifyQueue.get(`lock:${userId}`)) {
    bot.sendMessage(stored.chatId, "hold up — still yo'ing your last one.");
    return;
  }
  yoifyQueue.set(`lock:${userId}`, true);

  const status = await bot.sendMessage(stored.chatId, `yo'ing in ${color}... ~30-60s`);

  try {
    const file = await bot.getFile(stored.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error("failed to download photo");
    const buf = Buffer.from(await res.arrayBuffer());
    const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;

    const apiRes = await fetch(YOIFY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, color }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) throw new Error(data.error || "generation failed");

    const b64 = data.image.split(",")[1];
    const imgBuf = Buffer.from(b64, "base64");

    await bot.sendPhoto(stored.chatId, imgBuf, {
      caption: `yo'd. (${color})\n\nget yo'd: ${SITE_URL}`,
      reply_to_message_id: stored.msgId,
      ...SHARE_X_MARKUP(color),
    }, { filename: "yod.png", contentType: "image/png" });

    saveToGallery(data.image);
    try { await bot.deleteMessage(stored.chatId, status.message_id); } catch {}
  } catch (err) {
    console.error("[yoify-bot]", err.message);
    try { await bot.deleteMessage(stored.chatId, status.message_id); } catch {}
    bot.sendMessage(stored.chatId, `couldn't yo that: ${err.message}`);
  } finally {
    yoifyQueue.delete(`lock:${userId}`);
  }
});

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

// ============ DAILY RECAP (midnight UTC) ============

const RECAP_CHAT_ID = process.env.RECAP_CHAT_ID; // TG group to post recap in

async function postDailyRecap() {
  if (!RECAP_CHAT_ID) return;
  try {
    const todaySince = todayUTC();
    const yesterdaySince = daysAgo(1);

    // get yesterday's stats (recap is for the day that just ended)
    const { count: yesterdayCount } = await supabase
      .from("tg_yo_log")
      .select("*", { count: "exact", head: true })
      .gte("created_at", yesterdaySince)
      .lt("created_at", todaySince);

    const allTime = await allTimeCount();
    const loud = await loudestSince(yesterdaySince);

    // top 3 of the day
    const { data: topData } = await supabase
      .from("tg_yo_log")
      .select("username")
      .gte("created_at", yesterdaySince)
      .lt("created_at", todaySince);

    let top3Text = "";
    if (topData?.length) {
      const counts = {};
      for (const r of topData) {
        const key = r.username || "_anon";
        counts[key] = (counts[key] || 0) + 1;
      }
      const top3 = Object.entries(counts)
        .filter(([k]) => k !== "_anon")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      if (top3.length) {
        top3Text = top3.map(([u, c], i) => `${["🥇","🥈","🥉"][i]} @${u} — ${c}`).join("\n");
      }
    }

    let text = `\u{1F534} DAILY RECAP\n\n`;
    text += `yesterday: ${fmt(yesterdayCount || 0)} yo's\n`;
    text += `all-time: ${fmt(allTime)}\n`;
    if (top3Text) text += `\nloudest:\n${top3Text}\n`;
    text += `\nsay yo today. don't break the streak.`;

    bot.sendMessage(RECAP_CHAT_ID, text);
  } catch (err) {
    console.error("recap error:", err.message);
  }
}

// Schedule recap at midnight UTC
function scheduleRecap() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 5, 0); // 5 seconds past midnight
  const ms = midnight - now;
  setTimeout(() => {
    postDailyRecap();
    // then repeat every 24h
    setInterval(postDailyRecap, 86_400_000);
  }, ms);
  console.log(`  daily recap scheduled in ${Math.floor(ms / 60000)}m (midnight UTC)`);
}

scheduleRecap();

// cleanup stale cooldowns every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cooldowns) if (now - v > COOLDOWN_MS * 2) cooldowns.delete(k);
  for (const [k, v] of raidCooldowns) if (now - v > RAID_COOLDOWN_MS * 2) raidCooldowns.delete(k);
  // clean expired yoify queue entries (photos older than 5 min)
  for (const [k, v] of yoifyQueue) {
    if (typeof v === "object" && v.chatId && now - (v.ts || 0) > 300_000) yoifyQueue.delete(k);
  }
}, 600_000);

console.log("YO bot is live. listening for yo's...");
