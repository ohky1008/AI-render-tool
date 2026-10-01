import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "outputs");
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

// GPT 이미지 모델은 edit 요청당 최대 16장의 입력 이미지를 받는다.
const MAX_INPUT_IMAGES = 16;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: MAX_INPUT_IMAGES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error(`지원하지 않는 형식입니다: ${file.originalname} (png, jpg, webp만 가능)`));
  },
});

let client;
function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.");
  }
  client ??= new OpenAI();
  return client;
}

/**
 * 사용자의 요청을 모델이 이해하기 쉬운 지시문으로 감싼다.
 * 베이스 이미지가 있으면 1번 이미지 = 구도/형태, 나머지 = 스타일 레퍼런스.
 */
function buildPrompt({ userPrompt, hasBase, refCount, strength }) {
  const refRange = hasBase
    ? refCount === 1 ? "Image 2" : `Images 2-${refCount + 1}`
    : refCount === 1 ? "Image 1" : `Images 1-${refCount}`;

  const strengthText = {
    low: "Borrow the references' style loosely; keep it subtle.",
    medium: "Clearly follow the references' style while keeping the result natural.",
    high: "Match the references' style as closely as possible.",
  }[strength] ?? "";

  const lines = [];
  if (hasBase) {
    lines.push(
      "Image 1 is the BASE image (sketch, 3D model capture, photo, or draft).",
      "Render Image 1 into a finished, high-quality image. Keep its composition, camera angle, geometry, proportions and layout exactly the same."
    );
  } else {
    lines.push("Create a new, finished, high-quality image.");
  }
  if (refCount > 0) {
    lines.push(
      `${refRange} are STYLE REFERENCES. Analyze their rendering style, lighting, color palette, materials/textures, mood and level of detail, and apply that look to the result.`,
      "Do not copy the references' subject matter or layout unless asked.",
      strengthText
    );
  }
  if (userPrompt) lines.push(`Additional instructions from the user: ${userPrompt}`);
  return lines.filter(Boolean).join("\n");
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(OUTPUT_DIR));

app.get("/api/config", (_req, res) => {
  res.json({ defaultModel: DEFAULT_MODEL, hasApiKey: Boolean(process.env.OPENAI_API_KEY) });
});

app.post(
  "/api/render",
  upload.fields([
    { name: "base", maxCount: 1 },
    { name: "references", maxCount: MAX_INPUT_IMAGES },
  ]),
  async (req, res) => {
    try {
      const base = req.files?.base?.[0];
      const refs = req.files?.references ?? [];
      const {
        prompt = "",
        model = DEFAULT_MODEL,
        size = "auto",
        quality = "auto",
        strength = "medium",
        n = "1",
      } = req.body;

      if (refs.length === 0) {
        return res.status(400).json({ error: "레퍼런스 이미지를 1장 이상 올려주세요." });
      }
      if (refs.length + (base ? 1 : 0) > MAX_INPUT_IMAGES) {
        return res.status(400).json({ error: `입력 이미지는 최대 ${MAX_INPUT_IMAGES}장까지 가능합니다.` });
      }

      const inputs = [...(base ? [base] : []), ...refs];
      const images = await Promise.all(
        inputs.map((f) => toFile(f.buffer, f.originalname, { type: f.mimetype }))
      );

      const fullPrompt = buildPrompt({
        userPrompt: prompt.trim(),
        hasBase: Boolean(base),
        refCount: refs.length,
        strength,
      });

      const params = {
        model,
        image: images,
        prompt: fullPrompt,
        size,
        quality,
        n: Math.min(Math.max(parseInt(n, 10) || 1, 1), 4),
      };
      // gpt-image-2 계열은 input_fidelity를 무시하므로 나머지 모델에만 지정한다.
      if (!model.startsWith("gpt-image-2")) params.input_fidelity = "high";

      const result = await getClient().images.edit(params);

      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const saved = await Promise.all(
        result.data.map(async (img, i) => {
          const name = `render-${stamp}-${i + 1}.png`;
          await fs.writeFile(path.join(OUTPUT_DIR, name), Buffer.from(img.b64_json, "base64"));
          return `/outputs/${name}`;
        })
      );

      res.json({ images: saved, prompt: fullPrompt, usage: result.usage ?? null });
    } catch (err) {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "렌더링 중 오류가 발생했습니다." });
    }
  }
);

app.get("/api/history", async (_req, res) => {
  try {
    const files = (await fs.readdir(OUTPUT_DIR)).filter((f) => f.endsWith(".png")).sort().reverse();
    res.json({ images: files.slice(0, 40).map((f) => `/outputs/${f}`) });
  } catch {
    res.json({ images: [] });
  }
});

// multer 업로드 오류 등을 JSON으로 반환
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`AI Render Tool 실행 중: http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) console.warn("⚠ OPENAI_API_KEY가 없습니다. .env 파일을 만들어주세요.");
});
