// V-Ray Render Element 종류 정의. 서버(src/)와 브라우저(index.html)가 함께 사용한다.
//
// - aiDefault: 업로드 시 "AI 가이드로 전달" 체크 기본값
// - resize:    베이스 해상도에 맞출 때 쓰는 보간. ID 맵은 색이 섞이면 안 되므로 nearest.
// - patterns:  파일명 자동 인식 (예: scene.VRayZDepth.png, scene_MtlID.png)

// "_GI", ".AO" 처럼 앞뒤가 영문자가 아닌 짧은 토큰 ("_"는 \b가 단어 문자로 취급하므로 직접 처리)
const token = (word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i");

export const ELEMENT_TYPES = {
  zdepth: {
    label: "Z-Depth",
    aiDefault: true,
    resize: "lanczos3",
    patterns: [/z[-_ ]?depth/i, token("depth")],
    role: "DEPTH MAP of the same view (brighter = closer to the camera). Use it to keep exact geometry, spatial layering and correct atmospheric perspective.",
  },
  normals: {
    label: "Normals",
    aiDefault: true,
    resize: "lanczos3",
    patterns: [/normal/i],
    role: "SURFACE NORMALS of the same view (RGB-encoded surface orientation). Use it to keep every surface plane, edge and curvature exactly where it is, and to light surfaces consistently.",
  },
  materialId: {
    label: "Material ID",
    aiDefault: true,
    resize: "nearest",
    idMap: true,
    patterns: [/mtl[-_ ]?id/i, /material[-_ ]?id/i, token("matid")],
    role: "MATERIAL ID MAP of the same view. Each flat color marks one material; region boundaries are exact material boundaries.",
  },
  objectId: {
    label: "Object ID / MultiMatte",
    aiDefault: false,
    resize: "nearest",
    idMap: true,
    patterns: [/object[-_ ]?id/i, /multi[-_ ]?matte/i, /render[-_ ]?id/i, /cryptomatte/i, token("matte")],
    role: "OBJECT ID MAP of the same view. Each flat color marks one object; region boundaries are exact object silhouettes.",
  },
  reflection: {
    label: "Reflection",
    aiDefault: true,
    resize: "lanczos3",
    patterns: [/reflect/i],
    role: "REFLECTION PASS. Shows where and how strongly surfaces reflect; keep reflective surfaces (glass, metal, polished floors) reflective in the same places.",
  },
  refraction: {
    label: "Refraction",
    aiDefault: false,
    resize: "lanczos3",
    patterns: [/refract/i],
    role: "REFRACTION PASS. Shows transparent / glass areas; keep them transparent with believable refraction.",
  },
  specular: {
    label: "Specular",
    aiDefault: false,
    resize: "lanczos3",
    patterns: [/specular/i],
    role: "SPECULAR PASS. Shows highlight positions; keep highlights consistent with the light sources.",
  },
  lighting: {
    label: "Lighting",
    aiDefault: false,
    resize: "lanczos3",
    patterns: [/lighting/i, /direct[-_ ]?light/i],
    role: "DIRECT LIGHTING PASS. Shows where direct light falls; keep the light direction and pools of light.",
  },
  gi: {
    label: "GI",
    aiDefault: false,
    resize: "lanczos3",
    patterns: [/global[-_ ]?illum/i, token("gi")],
    role: "GLOBAL ILLUMINATION PASS. Shows indirect bounce light; keep the color bleeding and fill-light distribution.",
  },
  shadow: {
    label: "Shadow",
    aiDefault: false,
    resize: "lanczos3",
    patterns: [/shadow/i],
    role: "SHADOW PASS. Shows cast shadows; keep shadow positions and directions identical.",
  },
  ao: {
    label: "AO / ExtraTex",
    aiDefault: true,
    resize: "lanczos3",
    patterns: [token("ao"), /ambient[-_ ]?occl/i, /extra[-_ ]?tex/i, /dirt/i],
    role: "AMBIENT OCCLUSION PASS. Shows contact shadows in corners and crevices; keep that contact grounding so objects sit firmly in the scene.",
  },
  selfIllum: {
    label: "Self-Illumination",
    aiDefault: false,
    resize: "lanczos3",
    patterns: [/self[-_ ]?illum/i, /emissi/i],
    role: "SELF-ILLUMINATION PASS. Shows emissive surfaces (lamps, screens, signage); keep exactly those surfaces glowing.",
  },
  other: {
    label: "기타",
    aiDefault: false,
    resize: "lanczos3",
    patterns: [],
    role: "Additional render pass of the same view, for reference only.",
  },
};

export function detectElementType(filename) {
  const name = filename.replace(/\.[^.]+$/, "");
  for (const [type, def] of Object.entries(ELEMENT_TYPES)) {
    if (def.patterns.some((re) => re.test(name))) return type;
  }
  return "other";
}
