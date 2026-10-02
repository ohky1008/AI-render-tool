import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ELEMENT_TYPES } from "./public/shared/element-types.js";
import { buildPrompt } from "./src/prompt.js";
import {
  prepareBase, prepareElement, prepareReference, extractIdPalette, buildIdMatte, matteToEditMask, finalizeResult, apiSizeFor,
} from "./src/elements.js";
import { rhinoConfigured, getRhinoScene, captureRhinoViewport } from "./src/rhino.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "outputs");
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

// GPT 이미지 모델은 edit 요청당 최대 16장의 입력 이미지를 받는다.
const MAX_INPUT_IMAGES = 16;
const MAX_UPLOAD_FILES = 40;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: MAX_UPLOAD_FILES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype) || /\.tiff?$/i.test(file.originalname)) cb(null, true);
    else cb(new Error(`지원하지 않는 형식입니다: ${file.originalname} (png, jpg, webp, tiff 가능 — EXR은 PNG/TIFF로 저장해 주세요)`));
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

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(OUTPUT_DIR));

app.get("/api/config", (_req, res) => {
  res.json({
    defaultModel: DEFAULT_MODEL,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    rhinoEnabled: rhinoConfigured(),
  });
});

// ── Rhino MCP ─────────────────────────────────────────────
app.post("/api/rhino/scene", async (_req, res) => {
  try {
    res.json({ scene: await getRhinoScene() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/rhino/capture", async (_req, res) => {
  try {
    const { buffer, mimeType } = await captureRhinoViewport();
    res.type(mimeType).send(buffer);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// ── Render Element 분석 ───────────────────────────────────
app.post("/api/analyze-ids", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ID 맵 이미지가 없습니다." });
    res.json({ palette: await extractIdPalette(req.file.buffer) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: `ID 맵을 읽지 못했습니다: ${err.message}` });
  }
});

// ── 렌더링 ────────────────────────────────────────────────
app.post(
  "/api/render",
  upload.fields([
    { name: "base", maxCount: 1 },
    { name: "elements", maxCount: 24 },
    { name: "references", maxCount: MAX_INPUT_IMAGES },
  ]),
  async (req, res) => {
    try {
      const baseFile = req.files?.base?.[0];
      const elementFiles = req.files?.elements ?? [];
      const refs = req.files?.references ?? [];
      const body = req.body;
      if (!baseFile) return res.status(400).json({ error: "베이스 렌더 이미지를 올려주세요 (V-Ray RGB 또는 Rhino 뷰포트 캡처)." });

      const elementMeta = parseJson(body.elementMeta, []); // [{ type, ai }] (elementFiles와 같은 순서)
      const materialMap = parseJson(body.materialMap, []); // [{ color, label, edit }]
      const scene = parseJson(body.scene, null);
      const options = parseJson(body.options, {});
      const idSource = Number.isInteger(+body.idSource) && body.idSource !== "" ? +body.idSource : -1;
      const model = body.model || DEFAULT_MODEL;
      const quality = body.quality || "high";
      const n = Math.min(Math.max(parseInt(body.n, 10) || 1, 1), 4);

      const elements = elementFiles.map((f, i) => ({
        file: f,
        type: ELEMENT_TYPES[elementMeta[i]?.type] ? elementMeta[i].type : "other",
        ai: Boolean(elementMeta[i]?.ai),
      }));
      const aiElements = elements.filter((e) => e.ai);
      if (1 + aiElements.length + refs.length > MAX_INPUT_IMAGES) {
        return res.status(400).json({
          error: `AI에 전달하는 이미지는 최대 ${MAX_INPUT_IMAGES}장입니다 (베이스 1 + Element ${aiElements.length} + 레퍼런스 ${refs.length}).`,
        });
      }

      // 1) 베이스 + Element 정렬
      const base = await prepareBase(baseFile.buffer);
      const dims = { width: base.width, height: base.height };
      const invertDepth = options.invertDepth === true;
      const aiPngs = await Promise.all(aiElements.map((e) => prepareElement(e.file.buffer, e.type, dims, { invertDepth })));
      const refPngs = await Promise.all(refs.map((f) => prepareReference(f.buffer)));

      // 2) Material ID 매핑 / 수정 영역 마스크
      const idElement = elements[idSource];
      let idMapImage = null;
      if (idElement) {
        const aiIndex = aiElements.indexOf(idElement);
        idMapImage = aiIndex >= 0 ? `Image ${aiIndex + 2}` : null;
      }
      const editColors = idElement ? materialMap.filter((m) => m.edit).map((m) => m.color) : [];
      let matte = null;
      let mask = null;
      if (editColors.length) {
        matte = await buildIdMatte(idElement.file.buffer, editColors, dims);
        mask = await matteToEditMask(matte, dims);
      }

      const fullPrompt = buildPrompt({
        aiElements,
        refCount: refs.length,
        scene,
        materialMap,
        idMapImage,
        hasMask: Boolean(mask),
        options,
        userPrompt: (body.prompt ?? "").trim(),
      });

      // 3) 생성
      const images = await Promise.all([
        toFile(base.png, "base.png", { type: "image/png" }),
        ...aiPngs.map((png, i) => toFile(png, `element-${i + 1}-${aiElements[i].type}.png`, { type: "image/png" })),
        ...refPngs.map((png, i) => toFile(png, `reference-${i + 1}.png`, { type: "image/png" })),
      ]);
      const params = {
        model,
        image: images,
        prompt: fullPrompt,
        size: body.size && body.size !== "match" ? body.size : apiSizeFor(dims),
        quality,
        n,
      };
      if (mask) params.mask = await toFile(mask, "mask.png", { type: "image/png" });
      // gpt-image-2 계열은 input_fidelity를 무시하므로 나머지 모델에만 지정한다.
      if (!model.startsWith("gpt-image-2")) params.input_fidelity = "high";

      const result = await getClient().images.edit(params);

      // 4) 원본 해상도 복원 + (마스크 사용 시) 선택 영역 밖 원본 유지
      const lockOutside = mask && options.lockOutside !== false;
      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const saved = await Promise.all(
        result.data.map(async (img, i) => {
          const png = await finalizeResult(
            Buffer.from(img.b64_json, "base64"),
            baseFile.buffer,
            base.original,
            lockOutside ? matte : null,
            dims
          );
          const name = `render-${stamp}-${i + 1}.png`;
          await fs.writeFile(path.join(OUTPUT_DIR, name), png);
          return `/outputs/${name}`;
        })
      );
      await fs.writeFile(
        path.join(OUTPUT_DIR, `render-${stamp}.json`),
        JSON.stringify({ prompt: fullPrompt, model, quality, size: params.size, options, elements: elements.map((e) => ({ name: e.file.originalname, type: e.type, ai: e.ai })), materialMap, images: saved }, null, 2)
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
