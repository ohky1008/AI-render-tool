// Rhino MCP 클라이언트.
// rhinomcp(https://github.com/jingcheng-chen/rhinomcp) 서버를 stdio로 띄우고,
// Rhino 플러그인(기본 127.0.0.1:1999)에 붙어 씬 정보와 뷰포트 캡처를 가져온다.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENE_SCRIPT = path.join(__dirname, "..", "rhino", "scene_export.py");
const MARK_START = "<<<AI_RENDER_SCENE_JSON>>>";
const MARK_END = "<<<END_AI_RENDER_SCENE_JSON>>>";

const PYTHON_TOOL = "execute_rhinoscript_python_code";
const CAPTURE_TOOL = "capture_viewport";

let connection = null; // Promise<{ client, tools }>

function mcpCommand() {
  const raw = process.env.RHINO_MCP_COMMAND || "uvx rhinomcp@latest";
  // 공백이 있는 경로는 "..."로 감쌀 수 있다 (예: "C:\\Users\\My Name\\.local\\bin\\uvx.exe" rhinomcp@latest)
  const [command, ...args] = (raw.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"(.*)"$/, "$1"));
  return { command, args };
}

async function connect() {
  const { command, args } = mcpCommand();
  const transport = new StdioClientTransport({ command, args, env: process.env, stderr: "pipe" });
  const client = new Client({ name: "ai-render-tool", version: "1.0.0" });
  client.onclose = () => { connection = null; };
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools: new Map(tools.map((t) => [t.name, t])) };
}

async function getConnection() {
  connection ??= connect().catch((err) => {
    connection = null;
    const { command } = mcpCommand();
    throw new Error(
      `Rhino MCP 서버를 시작하지 못했습니다 (${command}). RHINO_MCP_COMMAND 설정과 uv 설치를 확인하세요.\n${err.message}`
    );
  });
  return connection;
}

/** 툴 스키마에서 코드 문자열을 받는 인자 이름을 찾는다 (버전마다 이름이 다를 수 있음). */
function codeArgName(tool) {
  const props = tool.inputSchema?.properties ?? {};
  if ("code" in props) return "code";
  const required = tool.inputSchema?.required ?? [];
  return required.find((k) => props[k]?.type === "string") ?? Object.keys(props)[0] ?? "code";
}

async function callTool(name, args) {
  const { client, tools } = await getConnection();
  const tool = tools.get(name);
  if (!tool) throw new Error(`Rhino MCP 서버에 '${name}' 툴이 없습니다. rhinomcp 버전을 확인하세요.`);
  const result = await client.callTool({ name, arguments: typeof args === "function" ? args(tool) : args });
  if (result.isError) {
    const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    throw new Error(`Rhino 오류: ${text || "알 수 없는 오류"}. Rhino가 켜져 있고 'mcpstart'로 플러그인이 실행 중인지 확인하세요.`);
  }
  return result;
}

/** 출력 텍스트(혹은 JSON으로 한 번 더 감싸진 텍스트)에서 마커 사이의 JSON을 찾는다. */
function extractSceneJson(texts) {
  const candidates = [...texts];
  for (let i = 0; i < candidates.length; i++) {
    const text = candidates[i];
    const start = text.indexOf(MARK_START);
    const end = text.indexOf(MARK_END, start);
    if (start !== -1 && end !== -1) {
      try {
        return JSON.parse(text.slice(start + MARK_START.length, end));
      } catch { /* 이스케이프된 형태일 수 있으니 아래에서 풀어서 다시 시도 */ }
    }
    try {
      const parsed = JSON.parse(text);
      const walk = (v) => {
        if (typeof v === "string") candidates.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(parsed);
    } catch { /* 일반 텍스트 */ }
  }
  throw new Error("Rhino에서 씬 정보를 읽지 못했습니다. 스크립트 출력에 결과가 없습니다.");
}

export function rhinoConfigured() {
  return process.env.RHINO_MCP_DISABLED !== "1";
}

/** 활성 뷰포트의 카메라, 재질, 레이어, 태양 정보를 가져온다. */
export async function getRhinoScene() {
  const script = await fs.readFile(SCENE_SCRIPT, "utf8");
  const code = `__AI_RENDER_MCP__ = True\n${script}`;
  const result = await callTool(PYTHON_TOOL, (tool) => ({ [codeArgName(tool)]: code }));
  const texts = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
  return extractSceneJson(texts);
}

/** 활성 뷰포트를 캡처해 PNG Buffer로 돌려준다. */
export async function captureRhinoViewport() {
  const result = await callTool(CAPTURE_TOOL, {});
  const image = result.content?.find((c) => c.type === "image");
  if (!image) throw new Error("Rhino 뷰포트 캡처 결과에 이미지가 없습니다.");
  return { buffer: Buffer.from(image.data, "base64"), mimeType: image.mimeType || "image/png" };
}
