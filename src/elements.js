// 베이스 렌더와 V-Ray Render Element 이미지 처리 (sharp).
import sharp from "sharp";
import { ELEMENT_TYPES } from "../public/shared/element-types.js";

// API로 보내는 이미지의 긴 변 최대 길이. 결과는 원본 해상도로 되돌린다.
const MAX_SEND_SIDE = 2048;
// ID 맵에서 이 비율보다 작은 색은 안티에일리어싱 경계로 보고 무시한다.
const MIN_ID_COVERAGE = 0.003;
const MAX_ID_COLORS = 24;

const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
const parseHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** 베이스 렌더를 API 전송용 PNG(sRGB 8bit)로 만든다. */
export async function prepareBase(buffer) {
  const meta = await sharp(buffer).metadata();
  const scale = Math.min(1, MAX_SEND_SIDE / Math.max(meta.width, meta.height));
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);
  const png = await sharp(buffer)
    .resize(width, height, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .png()
    .toBuffer();
  return { png, width, height, original: { width: meta.width, height: meta.height } };
}

/** 스타일 레퍼런스 사진을 PNG로 변환 (TIFF 등도 API가 받을 수 있게). */
export async function prepareReference(buffer) {
  return sharp(buffer)
    .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("srgb")
    .png()
    .toBuffer();
}

/** Render Element를 베이스와 같은 크기의 PNG로 맞춘다. 깊이 맵은 자동 레벨 보정. */
export async function prepareElement(buffer, type, { width, height }, { invertDepth = false } = {}) {
  const def = ELEMENT_TYPES[type] ?? ELEMENT_TYPES.other;
  let img = sharp(buffer).resize(width, height, { fit: "fill", kernel: def.resize }).removeAlpha();
  if (type === "zdepth") {
    // 16bit 깊이도 1~99 퍼센타일로 늘려 8bit 안에서 단계가 잘 보이게 한다.
    img = img.greyscale().normalise({ lower: 1, upper: 99 });
    if (invertDepth) img = img.negate();
  }
  return img.toColourspace("srgb").png().toBuffer();
}

/** ID 맵(Material ID / MultiMatte 등)에서 주요 색과 화면 점유율을 뽑는다. */
export async function extractIdPalette(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(512, 512, { fit: "inside", kernel: "nearest" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const counts = new Map();
  const total = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, n]) => ({ color: hex(key >> 16, (key >> 8) & 255, key & 255), coverage: n / total }))
    .filter((c) => c.coverage >= MIN_ID_COVERAGE)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, MAX_ID_COLORS);
}

/**
 * 선택한 ID 색 영역의 매트(0~255, 255 = 선택)를 만든다.
 * 경계의 안티에일리어싱 픽셀까지 덮도록 살짝 넓히고 부드럽게 만든다.
 */
export async function buildIdMatte(buffer, colors, { width, height }, { tolerance = 24, feather = 2 } = {}) {
  const targets = colors.map(parseHex);
  const { data } = await sharp(buffer)
    .resize(width, height, { fit: "fill", kernel: "nearest" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const matte = Buffer.alloc(width * height);
  const tol2 = tolerance * tolerance * 3;
  for (let p = 0, i = 0; p < matte.length; p++, i += 3) {
    for (const [r, g, b] of targets) {
      const d = (data[i] - r) ** 2 + (data[i + 1] - g) ** 2 + (data[i + 2] - b) ** 2;
      if (d <= tol2) { matte[p] = 255; break; }
    }
  }
  const raw = { raw: { width, height, channels: 1 } };
  // 넓히기(블러 후 낮은 임계값) → 경계 페더
  // (sharp는 1채널 raw를 3채널로 내보내므로 extractChannel로 1채널을 유지한다)
  const grown = await sharp(matte, raw).blur(feather + 1).threshold(16).extractChannel(0).raw().toBuffer();
  return sharp(grown, raw).blur(Math.max(0.3, feather)).extractChannel(0).raw().toBuffer();
}

/** OpenAI images.edit 마스크: 투명(alpha 0) = 수정할 영역. */
export async function matteToEditMask(matte, { width, height }) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < matte.length; p++) {
    rgba[p * 4 + 3] = matte[p] > 127 ? 0 : 255;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** 결과를 원본 크기로 되돌리고, 매트가 있으면 선택 영역 밖은 원본 픽셀을 그대로 유지한다. */
export async function finalizeResult(resultBuffer, baseBuffer, { width, height }, matte = null, matteSize = null) {
  const ai = sharp(resultBuffer).resize(width, height, { fit: "fill", kernel: "lanczos3" }).removeAlpha().toColourspace("srgb");
  if (!matte) return ai.png().toBuffer();

  const [aiRaw, baseRaw, m] = await Promise.all([
    ai.raw().toBuffer(),
    sharp(baseBuffer).resize(width, height, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer(),
    sharp(matte, { raw: { ...matteSize, channels: 1 } }).resize(width, height, { fit: "fill" }).extractChannel(0).raw().toBuffer(),
  ]);
  const out = Buffer.alloc(aiRaw.length);
  for (let p = 0, i = 0; p < m.length; p++, i += 3) {
    const a = m[p] / 255;
    out[i] = baseRaw[i] + (aiRaw[i] - baseRaw[i]) * a;
    out[i + 1] = baseRaw[i + 1] + (aiRaw[i + 1] - baseRaw[i + 1]) * a;
    out[i + 2] = baseRaw[i + 2] + (aiRaw[i + 2] - baseRaw[i + 2]) * a;
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** 베이스 비율에 가장 가까운 GPT Image 출력 크기. */
export function apiSizeFor({ width, height }) {
  const ratio = width / height;
  if (ratio > 1.2) return "1536x1024";
  if (ratio < 1 / 1.2) return "1024x1536";
  return "1024x1024";
}
