import "dotenv/config";
import express from "express";
import cors from "cors";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI, { toFile } from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3456;

// ---- CORS ----
const ORIGIN = process.env.YOIFY_ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ORIGIN, methods: ["POST", "OPTIONS"] }));
app.use(express.json({ limit: "10mb" }));

// ---- OpenAI ----
let _openai = null;
function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ---- Rate limiting (in-memory) ----
const MAX = Number(process.env.YOIFY_RATE_MAX || 3);
const WINDOW_MS = 10 * 60 * 1000;
const HITS = new Map();

function limited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX) return true;
  arr.push(now);
  HITS.set(ip, arr);
  return false;
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of HITS) {
    const fresh = arr.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) HITS.delete(ip);
    else HITS.set(ip, fresh);
  }
}, 5 * 60 * 1000);

// ---- Cache (in-memory) ----
const cache = new Map();

function makeCacheKey(imgBytes, quality, promptVersion) {
  return (
    "yoify:" +
    createHash("sha256")
      .update(imgBytes)
      .update(quality)
      .update(promptVersion)
      .digest("hex")
  );
}

// ---- Config / Prompt ----
const DEFAULT_MODEL = "gpt-image-1";
const DEFAULT_VERSION = "v4.1";

const COLOR_PRESETS = {
  magenta:   { primary: "#FF008C", name: "hot magenta",      accent: "#FFE600", accentName: "cyber yellow" },
  vermilion: { primary: "#FF2400", name: "vermilion red",    accent: "#FFD700", accentName: "gold" },
  emerald:   { primary: "#00FF87", name: "emerald green",    accent: "#FFE600", accentName: "cyber yellow" },
  gold:      { primary: "#FFD700", name: "rich gold",        accent: "#FF008C", accentName: "magenta" },
  ice:       { primary: "#00F0FF", name: "ice cyan",         accent: "#FF008C", accentName: "magenta" },
};

function buildPrompt(color) {
  const c = COLOR_PRESETS[color] || COLOR_PRESETS.magenta;
  return `Transform the uploaded image into YOIFIED V4 — a luxury street-art meme-coin profile picture. PRESERVE the subject's identity, species, character and recognizable traits. Do NOT replace the subject; transform the SAME subject into the YO universe.

OFFICIAL YO COLOR SYSTEM (strict):
- Primary: ${c.primary} ${c.name}
- Background: #000000 pure black
- Text and outlines: #FFFFFF white
- Optional tiny accent: ${c.accent} ${c.accentName}
NEVER use a white background.

STYLE: high contrast, pure black background, dramatic ${c.name} rim lighting, distressed poster texture, halftone dot texture, graffiti energy with ${c.name} paint drips and splatter, fashion-campaign composition, premium internet-culture / luxury meme-coin aesthetic. Ultra detailed.

MANDATORY ELEMENTS (always add):
- bold black sunglasses on the subject
- a thick black chain around the neck
- the official liquid-chrome YO medallion hanging from the chain. The medallion MUST use the official YO logo shape provided in the reference image, and must look molten, glossy, metallic, premium and highly recognizable. The medallion is the visual signature — it is required.

COMPOSITION: the subject dominates the frame, centered, profile-picture optimized, viral and instantly recognizable as part of the YO universe. 1:1 square, 1024x1024.`;
}

const LOGO_PATH = path.join(__dirname, "assets", "yo-logo.png");
const MEDALLION_PATH = path.join(__dirname, "assets", "yo-medallion.png");

// ---- Helpers ----
function extractBytes(src) {
  if (src.startsWith("data:")) {
    const [head, b64] = src.split(",");
    const type = head.slice(5, head.indexOf(";")) || "image/png";
    return { bytes: Buffer.from(b64, "base64"), type };
  }
  return null;
}

async function toImageFile(src, name) {
  let bytes;
  let type = "image/png";

  if (src.startsWith("data:")) {
    const [head, b64] = src.split(",");
    type = head.slice(5, head.indexOf(";")) || type;
    bytes = Buffer.from(b64, "base64");
  } else {
    // Local file path
    bytes = await readFile(src);
    if (src.endsWith(".jpg") || src.endsWith(".jpeg")) type = "image/jpeg";
  }
  return toFile(bytes, name, { type });
}

async function getSrcBytes(src) {
  const local = extractBytes(src);
  if (local) return local.bytes;
  return readFile(src);
}

// ---- Generate ----
async function yoifyImage(src, color = "magenta") {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

  const quality = process.env.YOIFY_QUALITY || "medium";
  const safeColor = COLOR_PRESETS[color] ? color : "magenta";
  const imgBytes = await getSrcBytes(src);
  const key = makeCacheKey(imgBytes, quality, DEFAULT_VERSION + ":" + safeColor);

  const cached = cache.get(key);
  if (cached) {
    console.log("[yoify] cache hit", key.slice(0, 24));
    return cached;
  }

  const [subject, logo, medallion] = await Promise.all([
    toImageFile(src, "subject.png"),
    toImageFile(LOGO_PATH, "yo-logo.png"),
    toImageFile(MEDALLION_PATH, "yo-medallion.png"),
  ]);

  const prompt = buildPrompt(safeColor);
  const result = await openai().images.edit({
    model: DEFAULT_MODEL,
    image: [subject, logo, medallion],
    prompt,
    size: "1024x1024",
    quality,
  });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image returned");
  const dataUrl = `data:image/png;base64,${b64}`;

  cache.set(key, dataUrl);
  console.log("[yoify] generated", safeColor, key.slice(0, 24));

  return dataUrl;
}

// ---- Routes ----
app.post("/api/yoify-public", async (req, res) => {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "anon";

  if (limited(ip)) {
    return res
      .status(429)
      .json({ error: "slow down — try again in a few minutes" });
  }

  try {
    const { image, color } = req.body;
    if (!image || !image.startsWith("data:")) {
      return res.status(400).json({ error: "image (data URL) required" });
    }
    const out = await yoifyImage(image, color);
    return res.json({ image: out });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "generation failed";
    console.error("[yoify-public]", msg);
    return res.status(500).json({ error: msg });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`yoify-server listening on :${PORT}`);
});
