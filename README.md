# AI Render Tool

**Rhino 모델 데이터 + V-Ray 베이스 렌더 + Render Elements**를 함께 AI에 넘겨, 형태는 그대로 두고 실제 사진처럼 보이는 이미지를 만드는 웹 툴입니다.
OpenAI GPT Image API(`images.edit`)로 동작합니다.

## 파이프라인

```
Rhino ──(Rhino MCP)──► 카메라(렌즈·기울기·높이), 재질/레이어, 태양, User Text 힌트 ─┐
V-Ray RGB (베이스) ─────────────────────────────────────────────────────────────┤
Render Elements ─► 자동 인식 · 베이스 해상도에 정렬 · Z-Depth 레벨 보정 ─────────┼─► 프롬프트 + 가이드 이미지 ─► GPT Image
Material ID ─► 색 팔레트 추출 ─► 색별 재질 매핑 · 보정 영역 마스크 ────────────────┘                                │
                                                                                                                 ▼
                                        원본 해상도로 복원 ◄── (마스크 사용 시) 선택 영역 밖은 원본 픽셀 합성
```

| 입력 | 필수 | 역할 |
|---|---|---|
| Rhino 모델 데이터 | 선택 | 활성 뷰의 카메라(35mm 환산 렌즈, 기울기, 눈높이), 재질 목록과 사용 레이어/객체, 태양 방향 → 프롬프트의 "SCENE DATA" |
| 베이스 렌더 | 필수 | V-Ray RGB/Beauty 또는 Rhino 뷰포트 캡처. 구도·형태·빛 방향의 기준 |
| Render Elements | 선택 | ZDepth, Normals, MtlID, ObjectID/MultiMatte, Reflection, Refraction, Specular, Lighting, GI, Shadow, AO/ExtraTex, SelfIllum |
| 재질 매핑 | 선택 | Material ID(또는 Object ID) 색마다 실제 재질 설명. "보정" 체크 시 그 영역만 AI가 수정 |
| 스타일 레퍼런스 | 선택 | 원하는 톤의 실제 사진. 색감/분위기만 차용 |

### Render Elements 처리

- **파일명으로 종류 자동 인식** — `scene.VRayZDepth.png`, `scene_MtlID.tif`, `VRayReflection.png` 등. 목록에서 직접 바꿀 수도 있습니다.
- 모든 Element는 베이스 해상도에 픽셀 정렬됩니다 (ID 맵은 nearest 보간으로 색이 섞이지 않게).
- **Z-Depth**는 1~99 퍼센타일로 자동 레벨 보정합니다 (16bit PNG/TIFF 지원). 가까운 곳이 검게 나오면 "Z-Depth 반전"을 켜세요.
- "AI 전달"이 켜진 Element만 가이드 이미지로 전송됩니다 (기본: ZDepth, Normals, MtlID, Reflection, AO). 입력 이미지는 최대 16장.
- **Material ID**는 화면 점유율 순으로 색을 뽑아 매핑 표를 만듭니다. Rhino에서 불러온 재질 이름이 자동완성으로 뜹니다.
- **보정 영역**: 체크한 ID 색 영역으로 편집 마스크를 만들고, "원본 픽셀 유지"가 켜져 있으면 결과에서 선택 영역 밖은 원본 렌더 픽셀을 그대로 합성합니다 (경계 페더 처리). 예) 식재·하늘·유리만 실사화하고 건물은 V-Ray 결과 유지.

EXR은 브라우저/서버에서 읽지 않으므로 V-Ray Frame Buffer에서 **PNG(16bit) 또는 TIFF**로 저장해 주세요.

### 실사 설정

시간대(아침/한낮/골든아워/블루아워/야간/흐린 날), 날씨, 사진 스타일(건축/매거진/다큐/시네마틱), 형태 보존 강도(엄격/보통/자유), 사람·생활감 추가 여부를 고를 수 있습니다. 모든 요청에는 실사 규칙(물리적으로 맞는 빛, 재질의 실제 스케일과 미세한 불균일, 유리 반사, CG 느낌 금지 등)이 포함됩니다 — `src/prompt.js`의 `REALISM_RULES`, `PRESETS`.

## Rhino 연동

### 방법 A — Rhino MCP (권장)

[rhinomcp](https://github.com/jingcheng-chen/rhinomcp)를 사용합니다.

1. Rhino 7/8에 rhinomcp 플러그인을 설치하고 Rhino 명령창에서 `mcpstart` 실행 (127.0.0.1:1999)
2. 이 툴을 실행하는 PC에 [uv](https://docs.astral.sh/uv/) 설치 (`uvx rhinomcp@latest`로 MCP 서버를 띄웁니다)
3. 웹 UI에서 **Rhino에서 불러오기** → 씬 정보, **뷰포트 캡처 → 베이스** → 현재 뷰를 베이스로 사용

서버는 MCP 클라이언트로 `execute_rhinoscript_python_code`에 `rhino/scene_export.py`를 실행해 씬 정보를 받고, `capture_viewport`로 뷰포트 이미지를 받습니다.

### 방법 B — 스크립트 수동 실행

Rhino에서 `RunPythonScript` → `rhino/scene_export.py`. `.3dm` 옆에 `<파일명>_scene.json`이 저장되면 UI의 **JSON 불러오기**로 올립니다.

### 재질 힌트 (User Text)

객체 속성의 User Text에 `ai`로 시작하는 키(예: `ai_desc` = `송판 노출콘크리트, 판 폭 150mm`)를 넣으면 해당 재질 설명으로 AI에 전달됩니다.

> V-Ray 렌더와 Rhino 데이터는 **같은 뷰/카메라**에서 뽑아야 정렬이 맞습니다.

## 실행

Node.js 20.9 이상이 필요합니다.

```bash
npm install
cp .env.example .env   # .env 에 OPENAI_API_KEY 입력
npm start
```

브라우저에서 http://localhost:3000 을 엽니다. 결과는 `outputs/`에 원본 해상도 PNG와 요청 정보(JSON: 프롬프트, 설정, Element 목록)로 저장됩니다.

## 설정 (.env)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | — | OpenAI API 키 |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | 기본 모델 |
| `RHINO_MCP_COMMAND` | `uvx rhinomcp@latest` | Rhino MCP 서버 실행 명령 |
| `RHINO_MCP_DISABLED` | `0` | `1`이면 Rhino 버튼 비활성화 |
| `PORT` | `3000` | 서버 포트 |

## 구조

| 파일 | 역할 |
|---|---|
| `server.js` | Express 서버. 업로드 → 정렬/마스크 → `images.edit` → 원본 해상도 복원·합성 |
| `src/rhino.js` | Rhino MCP 클라이언트 (stdio). 씬 정보·뷰포트 캡처 |
| `src/elements.js` | sharp 기반 이미지 처리: 베이스/Element 정렬, Z-Depth 보정, ID 팔레트, 매트·마스크, 최종 합성 |
| `src/prompt.js` | 이미지 역할 + Rhino 씬 데이터 + 재질 매핑 + 실사 규칙으로 프롬프트 구성 |
| `public/shared/element-types.js` | Render Element 종류·파일명 인식 규칙 (서버/브라우저 공용) |
| `rhino/scene_export.py` | Rhino 씬 정보 추출 스크립트 (MCP/수동 공용) |
| `public/index.html` | UI (단계별 입력, 재질 매핑 표, 베이스↔결과 비교 슬라이더) |

결과 화면의 "실제로 보낸 프롬프트"에서 모델에 전달된 전체 지시문을 확인할 수 있습니다.
