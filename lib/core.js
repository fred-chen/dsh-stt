// dsh-stt — 纯逻辑层（不依赖宿主，可单测、可被脚本直接复用）
//
// 职责：端点规范化、音频格式白名单判断、multipart 表单组装、响应解析、
// 转录模型探测、ffmpeg 转码与网络 I/O 助手。
// 工具主体只保留参数校验与流程编排，其余全部放在这里。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PLUGIN_VERSION = "0.1.0";
export const DEFAULT_ENDPOINT = "http://ai4090:8080/v1/audio/transcriptions";
export const DEFAULT_MODEL = "Whisper-Large-v3-Turbo";

export const RESPONSE_FORMATS = ["json", "text", "verbose_json", "srt", "vtt"];
export const TASKS = ["transcribe", "translate"];

// llama-swap / whisper.cpp 服务端（miniaudio 解码）实测可直接接受的容器；
// 其余（m4a/mp4/webm/opus/aac/amr…）在 autoConvert 开启时先用 ffmpeg 转 16k 单声道 wav。
export const SERVER_SAFE_EXTS = new Set(["wav", "mp3", "flac", "ogg", "oga"]);

export const MIME_BY_EXT = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  webm: "audio/webm",
  mkv: "video/x-matroska",
  wma: "audio/x-ms-wma",
  amr: "audio/amr",
};

/** 上传体积上限（whisper.cpp 对超长音频没有截断保护，先在本侧挡住误用）。 */
export const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
/** ffmpeg / 下载 / 探测的默认超时。 */
export const FFMPEG_TIMEOUT_MS = 300_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const PROBE_TIMEOUT_MS = 15_000;

//#region 端点规范化

/**
 * 把用户填的 endpoint 规范化为「完整的转写 URL」。
 * 接受四种写法（与 dsh-tts 的宽容策略一致）：
 *   http://host:8080/v1/audio/transcriptions  完整 URL，原样
 *   http://host:8080/v1/audio                 补 /transcriptions
 *   http://host:8080/v1                       补 /audio/transcriptions
 *   http://host:8080                          补 /v1/audio/transcriptions
 * 其它路径（自定义网关如 /gateway/asr）视为完整转写路由原样使用（前提是含 transcriptions，
 * 或以 /asr、/stt 结尾；否则也当作完整 URL——用户显式写了路径，不再画蛇添足）。
 */
export function normalizeEndpoint(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return DEFAULT_ENDPOINT;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`endpoint 不是合法的 http(s) URL：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`endpoint 协议必须是 http/https：${value}`);
  }
  url.hash = "";
  url.search = "";
  let p = url.pathname.replace(/\/+$/, "");
  if (p.endsWith("/audio/transcriptions")) {
    // 完整 URL，原样
  } else if (p.endsWith("/audio")) {
    p += "/transcriptions";
  } else if (/\/v\d+$/i.test(p)) {
    p += "/audio/transcriptions";
  } else if (p === "" || p === "/") {
    p = "/v1/audio/transcriptions";
  }
  // 其它情况：视作用户自定义的完整转写路由，保持原样
  url.pathname = p;
  return url.toString().replace(/\/+$/, "");
}

/** 从转写端点推导 GET /models 探测 URL。 */
export function deriveModelsUrl(endpoint) {
  let base = endpoint.replace(/\/audio\/transcriptions\/?$/, "");
  if (base === endpoint) base = endpoint.replace(/\/transcriptions\/?$/, "");
  base = base.replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(base)) base = `${base}/v1`;
  return `${base}/models`;
}

//#endregion
//#region 音频文件 helpers

export function audioExt(filePath) {
  return path.extname(String(filePath || "")).slice(1).toLowerCase();
}

export function mimeForPath(filePath) {
  return MIME_BY_EXT[audioExt(filePath)] || "application/octet-stream";
}

export function needsConversion(filePath) {
  return !SERVER_SAFE_EXTS.has(audioExt(filePath));
}

/** URL → 建议扩展名（先取 pathname 后缀，再用 content-type 兜底）。 */
export function extFromUrl(url) {
  const base = path.basename(new URL(url).pathname || "");
  const ext = path.extname(base).slice(1).toLowerCase();
  return ext || "";
}

export function extFromContentType(contentType) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  const hit = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === ct);
  return hit ? hit[0] : "";
}

/** 从任意文本安全地生成输出文件名（下载、转码产物都用它）。 */
export function safeStem(text) {
  const cleaned = String(text || "")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || `audio-${Date.now()}`;
}

//#endregion
//#region 表单与响应

/** 组装 OpenAI 兼容 multipart 表单。空值一律不发送，交给服务端默认。 */
export function buildTranscriptionForm({
  model,
  buffer,
  fileName,
  mime,
  language = "",
  prompt = "",
  responseFormat = "json",
  task = "transcribe",
  temperature,
}) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime || "application/octet-stream" }), fileName || "audio.wav");
  form.append("model", model);
  if (responseFormat) form.append("response_format", responseFormat);
  if (task && task !== "transcribe") form.append("task", task);
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);
  if (typeof temperature === "number" && Number.isFinite(temperature)) form.append("temperature", String(temperature));
  return form;
}

/** 把不同 response_format 的响应体统一成 { text, language?, durationSeconds?, segments? }。 */
export function normalizeTranscriptionResult(body) {
  if (typeof body === "string") return { text: body.trim() };
  if (!body || typeof body !== "object") return { text: String(body ?? "").trim() };
  const out = { text: String(body.text ?? "").trim() };
  if (typeof body.language === "string" && body.language) out.language = body.language;
  const duration = Number(body.duration);
  if (Number.isFinite(duration) && duration > 0) out.durationSeconds = Math.round(duration * 100) / 100;
  if (Array.isArray(body.segments)) {
    const segments = [];
    for (const seg of body.segments) {
      if (!seg || typeof seg !== "object") continue;
      const start = Number(seg.start);
      const end = Number(seg.end);
      const text = String(seg.text ?? "").trim();
      if (!text) continue;
      segments.push({ start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0, text });
    }
    if (segments.length) out.segments = segments;
  }
  return out;
}

export function formatApiError(status, body) {
  let detail = "";
  if (typeof body === "string") detail = body;
  else if (body && typeof body === "object") {
    detail = body.error?.message || body.message || body.error || JSON.stringify(body);
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  }
  detail = String(detail).replace(/\s+/g, " ").trim().slice(0, 800);
  return `HTTP ${status}${detail ? `：${detail}` : ""}`;
}

/** 从 /models 响应里挑出具备转写能力的模型；挑不出来时按常见命名兜底。 */
export function pickTranscriptionModels(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const rows = [];
  for (const item of data) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    const status = typeof item?.status?.value === "string" ? item.status.value : typeof item?.status === "string" ? item.status : "";
    const caps = item?.capabilities || {};
    const modality = String(item?.architecture?.modality || "");
    const looksTranscription =
      caps.audio_transcriptions === true ||
      (item?.architecture?.input_modalities || []).includes("audio") && modality.includes("text") ||
      /whisper|sensevoice|paraformer|funasr|asr|stt|transcri|speech[-_ ]?to[-_ ]?text/i.test(id);
    if (looksTranscription) rows.push({ id, ...(status ? { status } : {}) });
  }
  return rows;
}

//#endregion
//#region 网络 I/O

async function fetchWithTimeout(url, init = {}, timeoutMs = 30_000, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  const forward = () => ctrl.abort(outerSignal?.reason || new Error("已取消"));
  if (outerSignal) {
    if (outerSignal.aborted) forward();
    else outerSignal.addEventListener("abort", forward, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener?.("abort", forward);
  }
}

async function readMaybeJson(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** POST multipart 到转写端点。content-type 交给 fetch 自动生成（带 boundary）。 */
export async function requestTranscription({ endpoint, apiKey = "", form, timeoutMs = 300_000, signal }) {
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return fetchWithTimeout(endpoint, { method: "POST", headers, body: form }, timeoutMs, signal);
}

/** GET /models 并挑出转写模型。 */
export async function probeTranscriptionModels({ endpoint, apiKey = "", timeoutMs = PROBE_TIMEOUT_MS, signal }) {
  const modelsUrl = deriveModelsUrl(endpoint);
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetchWithTimeout(modelsUrl, { headers }, timeoutMs, signal);
  const payload = await readMaybeJson(res);
  if (!res.ok) throw new Error(`模型探测失败 — ${formatApiError(res.status, payload)}（${modelsUrl}）`);
  return { modelsUrl, models: pickTranscriptionModels(payload) };
}

/** 下载 http(s) 音频到本地路径，返回字节数。 */
export async function downloadAudio(url, destPath, { timeoutMs = DOWNLOAD_TIMEOUT_MS, signal, maxBytes = MAX_AUDIO_BYTES } = {}) {
  const res = await fetchWithTimeout(url, {}, timeoutMs, signal);
  if (!res.ok) throw new Error(`音频下载失败 — ${formatApiError(res.status, await readMaybeJson(res))}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error("下载到的音频为空");
  if (buffer.length > maxBytes) throw new Error(`音频过大：${buffer.length} 字节 > 上限 ${maxBytes}`);
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, buffer);
  return { bytes: buffer.length, contentType: res.headers.get("content-type") || "" };
}

//#endregion
//#region ffmpeg 转码

/** 用 ffmpeg 转 16kHz 单声道 pcm_s16le wav。失败时抛错（调用侧决定降级还是终止）。 */
export function convertToWav({ inputPath, outputWavPath, timeoutMs = FFMPEG_TIMEOUT_MS, signal }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", inputPath,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      outputWavPath,
    ];
    let child;
    try {
      child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], signal });
    } catch (error) {
      reject(new Error(`ffmpeg 启动失败：${error.message}`));
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`ffmpeg 转码超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error?.name === "AbortError" ? error : new Error(`ffmpeg 不可用或执行失败：${error.message}（可安装 ffmpeg 或关闭 autoConvert）`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(outputWavPath)) resolve(outputWavPath);
      else if (code === null) reject(new Error("ffmpeg 进程被终止"));
      else reject(new Error(`ffmpeg 退出码 ${code}${stderr ? `：${stderr.replace(/\s+/g, " ").trim().slice(0, 400)}` : ""}`));
    });
  });
}

//#endregion
