// 실사 렌더링 지시문 구성.
// 입력 이미지 순서: [베이스 렌더, AI 가이드 Render Element..., 스타일 레퍼런스...]
import { ELEMENT_TYPES } from "../public/shared/element-types.js";

export const PRESETS = {
  timeOfDay: {
    keep: null,
    morning: "Soft early-morning daylight, low warm sun, long gentle shadows, slightly cool ambient sky light.",
    noon: "Clear midday daylight, crisp sun with defined shadows, neutral white balance.",
    golden: "Golden hour: low warm sun, long soft shadows, warm rim light on edges, glowing sky.",
    blue: "Blue hour just after sunset: deep blue ambient sky, warm interior and street lights switched on, balanced exposure between sky and lit windows.",
    night: "Night scene: dark sky, artificial lights on, realistic light falloff and pools of light, no blown highlights.",
    overcast: "Overcast sky: soft diffuse daylight, very soft shadows, subtle even contrast.",
  },
  weather: {
    keep: null,
    clear: "Clear weather, clean air.",
    hazy: "Light atmospheric haze adding depth to distant elements.",
    rain: "Just after rain: wet surfaces with realistic puddle reflections, damp darker materials, overcast sky.",
    snow: "Light fresh snow resting on horizontal surfaces, cold soft light.",
  },
  look: {
    architectural: "Professional architectural photography: full-frame camera, tilt-shift corrected verticals, deep depth of field, accurate natural colors, balanced HDR exposure.",
    editorial: "Interior/editorial magazine photography: natural window light, gentle depth of field, refined styling, true-to-life colors.",
    documentary: "Unstaged documentary photo: natural imperfect light, real-world clutter and wear, candid feel.",
    cinematic: "Cinematic still: filmic contrast, subtle color grade, gentle bloom on bright lights, slight film grain.",
  },
  fidelity: {
    strict: "Geometry is LOCKED: do not move, add, remove or reshape any architectural element, opening, edge or object. Only change surface appearance, lighting quality and realism.",
    balanced: "Keep all architecture, objects and composition the same. Small additions (entourage, plants, props) are allowed only where they do not hide the design.",
    creative: "Keep the overall composition and main architecture, but you may enrich context, landscaping, sky and entourage freely.",
  },
};

const REALISM_RULES = [
  "The result must be indistinguishable from a real photograph, not a CG render.",
  "Use physically plausible light: correct sun/sky direction, soft natural global illumination, real contact shadows and ambient occlusion in corners.",
  "Use real-world materials with true scale and imperfections: subtle texture variation, micro-roughness, slightly uneven reflections, fine dust, weathering and edge wear where appropriate. No tiling patterns, no plastic look.",
  "Glass must show correct reflections of the surroundings and believable transparency; metals must have accurate anisotropic/rough reflections.",
  "Vegetation, sky and entourage must look photographed, with natural detail and variation.",
  "Natural camera response: realistic dynamic range, no oversaturated colors, no artificial glow, no painterly or illustrative strokes.",
];

const rangeLabel = (start, count) =>
  count === 1 ? `Image ${start}` : `Images ${start}-${start + count - 1}`;

function describeCamera(cam) {
  if (!cam) return null;
  if (cam.projection === "parallel") return "The view is a parallel (orthographic) projection; keep it flat with no perspective distortion.";
  const parts = [`Camera: ${Math.round(cam.lensLength)}mm (35mm equivalent) lens`];
  if (typeof cam.heightAboveGround === "number") parts.push(`about ${cam.heightAboveGround} model units above the lowest point of the scene`);
  if (typeof cam.pitchDeg === "number") {
    if (Math.abs(cam.pitchDeg) < 3) parts.push("level horizon, vertical lines must stay vertical");
    else parts.push(cam.pitchDeg > 0 ? `tilted up ${cam.pitchDeg}°` : `tilted down ${Math.abs(cam.pitchDeg)}°`);
  }
  return parts.join(", ") + ". Match this lens character and perspective exactly.";
}

function describeScene(scene) {
  if (!scene) return [];
  const lines = ["SCENE DATA from the Rhino 3D model (use it to understand what each surface is):"];
  const cam = describeCamera(scene.camera);
  if (cam) lines.push(cam);
  if (scene.units) lines.push(`Model units: ${scene.units}.`);
  if (scene.sun?.enabled && scene.sun.altitude != null) {
    lines.push(`Sun in the model: altitude ${scene.sun.altitude}°, azimuth ${scene.sun.azimuth}°. Keep the sun direction consistent with the base render's shadows.`);
  }
  const mats = (scene.materials ?? []).filter((m) => m.name && m.name !== "(default)").slice(0, 30);
  if (mats.length) {
    lines.push("Materials in the model (name — layers / objects / notes):");
    for (const m of mats) {
      const extra = [m.layers?.slice(0, 3).join(", "), m.objectNames?.slice(0, 3).join(", "), m.hints?.join("; ")]
        .filter(Boolean)
        .join(" / ");
      lines.push(`- ${m.name}${extra ? ` — ${extra}` : ""}`);
    }
  }
  return lines;
}

/**
 * @param {object} p
 * @param {{type:string}[]} p.aiElements    AI에 함께 보내는 Render Element (순서 = 이미지 순서)
 * @param {object|null}     p.scene         Rhino 씬 정보
 * @param {{color:string,label:string}[]} p.materialMap  ID 맵 색 → 재질 설명
 * @param {string|null}     p.idMapImage    materialMap이 가리키는 ID 맵의 이미지 번호 라벨
 * @param {boolean}         p.hasMask       선택 영역만 수정하는지
 */
export function buildPrompt({ aiElements = [], refCount = 0, scene = null, materialMap = [], idMapImage = null, hasMask = false, options = {}, userPrompt = "" }) {
  const { timeOfDay = "keep", weather = "keep", look = "architectural", fidelity = "strict", entourage = false } = options;
  const lines = [
    "TASK: Turn Image 1 into an ultra-photorealistic photograph of the same scene.",
    "Image 1 is the BASE RENDER (V-Ray beauty pass or Rhino viewport). It defines the exact camera, composition, geometry, layout, materials and light direction.",
  ];

  aiElements.forEach((el, i) => {
    const def = ELEMENT_TYPES[el.type] ?? ELEMENT_TYPES.other;
    lines.push(`Image ${i + 2} is the ${def.role} It is pixel-aligned with Image 1. It is guidance data only — never reproduce its colors or look in the output.`);
  });

  if (refCount > 0) {
    lines.push(
      `${rangeLabel(aiElements.length + 2, refCount)} are STYLE REFERENCES (real photos). Borrow only their color grading, light mood and photographic quality; ignore their subject and layout.`
    );
  }

  const mapped = materialMap.filter((m) => m.label?.trim());
  if (mapped.length && idMapImage) {
    lines.push(`Material assignment by color in ${idMapImage}:`);
    for (const m of mapped) lines.push(`- ${m.color} = ${m.label.trim()}`);
    lines.push("Render each region with that real-world material at correct physical scale.");
  }

  lines.push(...describeScene(scene));

  lines.push("REALISM REQUIREMENTS:", ...REALISM_RULES.map((r) => `- ${r}`));
  lines.push(PRESETS.fidelity[fidelity] ?? PRESETS.fidelity.strict);
  if (hasMask) lines.push("Only the masked (transparent) area of Image 1 may change; everything else stays as it is.");
  const tod = PRESETS.timeOfDay[timeOfDay];
  lines.push(tod ?? "Keep the time of day and lighting direction of the base render, but make the light physically realistic.");
  const w = PRESETS.weather[weather];
  if (w) lines.push(w);
  lines.push(PRESETS.look[look] ?? PRESETS.look.architectural);
  if (entourage) lines.push("Exception: you may add a few natural, scale-correct people and lived-in details where they make sense, without hiding the architecture.");
  else lines.push("Do not add people, vehicles or new objects.");
  if (userPrompt) lines.push(`Additional instructions from the user: ${userPrompt}`);
  return lines.join("\n");
}
