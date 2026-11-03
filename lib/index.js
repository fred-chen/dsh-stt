// dsh-stt — DeepSeek Harness 宿主插件
//
// 语音 → 文字：调用 OpenAI 兼容 /v1/audio/transcriptions 端点
// （默认 llama-swap 代理的 Whisper-Large-v3-Turbo，实测中文逐字全对），
// 接受本地音频路径或 http(s) URL，非安全容器自动 ffmpeg 转 16k 单声道 wav。
//
// 工具 stt_transcribe 的描述就是"让大模型知道这个端点"的载体：
// 触发场景（用户给音频文件/录音/语音备忘/TTS 回测）全部写进 description。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  MAX_AUDIO_BYTES,
  RESPONSE_FORMATS,
  TASKS,
  buildTranscriptionForm,
  convertToWav,
  downloadAudio,
  extFromContentType,
  extFromUrl,
  formatApiError,
  mimeForPath,
  needsConversion,
  normalizeEndpoint,
  normalizeTranscriptionResult,
  probeTranscriptionModels,
  requestTranscription,
  safeStem,
} from "./core.js";

const PLUGIN_VERSION = "0.1.0";
const NS = "dsh-stt";
const BRIDGE_PREFIX = "/api/dsh-stt";
const DEFAULT_WORK_DIR = ".dsh-stt";
const RENDER_SEGMENT_CAP = 24;

//#region 配置

function resolveConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  let endpoint;
  try {
    endpoint = normalizeEndpoint(cfg.endpoint);
  } catch {
    endpoint = DEFAULT_ENDPOINT;
  }
  const responseFormat = RESPONSE_FORMATS.includes(String(cfg.responseFormat)) ? String(cfg.responseFormat) : "json";
  return {
    enabled: cfg.enabled !== false,
    endpoint,
    apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : "",
    model: String(cfg.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    language: String(cfg.language ?? "").trim(),
    responseFormat,
    workDir: String(cfg.workDir || DEFAULT_WORK_DIR).trim() || DEFAULT_WORK_DIR,
    autoConvert: cfg.autoConvert !== false,
    timeoutSec: Number(cfg.timeoutSec ?? 300),
  };
}

function publicConfig(cfg) {
  const { apiKey, ...rest } = cfg;
  return rest;
}

const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  endpoint: z.string().default(DEFAULT_ENDPOINT).volatile(),
  apiKey: z.string().role("secret").volatile(),
  model: z.string().default(DEFAULT_MODEL).volatile(),
  language: z.string().default("").volatile(), // 空 = 服务端自动检测
  responseFormat: z.string().default("json").volatile(),
  workDir: z.string().default(DEFAULT_WORK_DIR).volatile(),
  autoConvert: z.boolean().default(true).volatile(),
  timeoutSec: z.number().default(300).volatile(),
});

//#endregion
//#region HTTP helpers（设置桥）

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return undefined;
  }
}

//#endregion
//#region stt_transcribe 工具

function buildMeta(value) {
  return {
    audioPath: value.audioPath,
    transcriptPath: value.transcriptPath ?? "",
    model: value.model,
    language: value.language ?? "",
    durationSeconds: value.durationSeconds ?? null,
    bytes: value.bytes,
    responseFormat: value.responseFormat,
    elapsedSeconds: value.elapsedSeconds,
    converted: value.converted === true,
    segmentCount: value.segments ? value.segments.length : 0,
    preview: String(value.text || "").slice(0, 300),
    models: value.models ?? null,
  };
}

function formatSeconds(sec) {
  return Number.isFinite(sec) ? sec.toFixed(2) : "?";
}

function buildSttTool({ current, logger }) {
  return defineTool({
    name: "stt_transcribe",
    description:
      "Transcribe speech to text via the configured OpenAI-compatible /v1/audio/transcriptions endpoint (default http://ai4090:8080/v1/audio/transcriptions, Whisper-Large-v3-Turbo served by llama-swap; endpoint/model customizable in plugin settings). USE THIS TOOL whenever the user shares or references an audio file (recording, voice memo, meeting/podcast clip, .wav/.mp3/.m4a/.ogg/.webm…), asks what a recording says, asks for a transcript/subtitles/字幕, or when you generated speech with tts_generate and want to verify the transcription round-trip. Input is a local audio file path (relative paths resolve against the session working directory; exotic containers like m4a/mp4/webm/opus are auto-converted to 16 kHz mono wav with ffmpeg) or an http(s) audio URL. Chinese transcription is near-perfect; language is auto-detected unless given as an ISO code (zh, en, ja, ko, yue…) or full name. Optional prompt biases proper nouns; task='translate' outputs English. Defaults to responseFormat=json (plain text); use verbose_json for per-segment timestamps, language and duration. Set probe=true to list transcription-capable models loaded on the endpoint without transcribing.",
    parameters: {
      audio: {
        type: "string",
        description:
          "Audio source: local file path (wav/mp3/flac/ogg/mp3; m4a/mp4/webm/opus/aac/amr auto-converted via ffmpeg) or an http(s) URL. Relative paths resolve against the session working directory. Required unless probe=true.",
      },
      probe: {
        type: "boolean",
        description: "true = 只探测端点加载了哪些转写模型（GET /models），不做转录。",
      },
      model: {
        type: "string",
        description: `Transcription model id. Defaults to the plugin setting (${DEFAULT_MODEL}).`,
      },
      language: {
        type: "string",
        description:
          "Spoken language: ISO-639-1 code (zh/en/ja/ko/yue/de/fr…) or full name (chinese/english…). Empty = server-side auto-detect; defaults to the plugin setting.",
      },
      task: {
        type: "string",
        enum: TASKS,
        description: "transcribe (默认，原文转写) or translate (译成英文)。",
      },
      prompt: {
        type: "string",
        description:
          "Optional context/vocabulary hint fed to the model to bias proper nouns and domain terms (≤448 tokens). Empty = none.",
      },
      responseFormat: {
        type: "string",
        enum: RESPONSE_FORMATS,
        description:
          "json = {text} only (default, cheapest); verbose_json = text + language/duration/segment timestamps; text/srt/vtt = raw formats. Defaults to the plugin setting.",
      },
      saveTo: {
        type: "string",
        description:
          "Optional path (relative to the session working directory) to also write the transcript text, e.g. notes/meeting.txt. Parent dirs are created.",
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          audioPath: { type: "string" },
          transcriptPath: { type: "string" },
          model: { type: "string" },
          responseFormat: { type: "string" },
          text: { type: "string" },
          language: { type: "string" },
          durationSeconds: { type: "number" },
          bytes: { type: "number" },
          elapsedSeconds: { type: "number" },
          converted: { type: "boolean" },
          downloaded: { type: "boolean" },
          segments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "number" },
                end: { type: "number" },
                text: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                status: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          notes: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        if (value.models) {
          const lines = [`端点探测：${value.audioPath}`, `发现 ${value.models.length} 个转写模型：`];
          for (const m of value.models) lines.push(`  - ${m.id}${m.status ? ` (${m.status})` : ""}`);
          if (!value.models.length) lines.push("  （无——检查 endpoint 是否正确、服务是否已加载模型）");
          for (const note of value.notes || []) lines.push(`注意：${note}`);
          return [{ type: "text", text: lines.join("\n") }];
        }
        const lines = [
          `语音转文字完成：${value.audioPath}`,
          `模型 ${value.model} · 输入 ${value.bytes} 字节 · 耗时 ${value.elapsedSeconds}s${value.language ? ` · 语言 ${value.language}` : ""}${Number.isFinite(value.durationSeconds) ? ` · 音频时长 ${value.durationSeconds}s` : ""}${value.converted ? " · 已转 16k 单声道 wav" : ""}`,
          `正文：`,
          value.text || "（空——音频可能无人声）",
        ];
        if (value.segments?.length) {
          lines.push("分段：");
          for (const seg of value.segments.slice(0, RENDER_SEGMENT_CAP)) {
            lines.push(`  [${formatSeconds(seg.start)} → ${formatSeconds(seg.end)}] ${seg.text}`);
          }
          if (value.segments.length > RENDER_SEGMENT_CAP) {
            lines.push(`  …共 ${value.segments.length} 段，完整分段见结果 JSON 或 responseFormat=text`);
          }
        }
        if (value.transcriptPath) lines.push(`文本已保存：${value.transcriptPath}`);
        for (const note of value.notes || []) lines.push(`注意：${note}`);
        lines.push(`结果 JSON：${JSON.stringify(buildMeta(value))}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
      presentationMeta(_args, value) {
        return buildMeta(value);
      },
    },
    presentCall(args) {
      const probing = args && args.probe === true;
      return {
        card: "generic",
        kind: "other",
        title: probing ? "探测转写模型" : "语音转文字",
        rawInput: {
          ...(args && args.audio ? { audio: String(args.audio) } : {}),
          ...(args && args.model ? { model: String(args.model) } : {}),
        },
      };
    },
    async execute(args, exec) {
      const cfg = current();
      if (!cfg.enabled) throw new Error("stt_transcribe 已在插件设置中禁用");
      let endpoint;
      try {
        endpoint = normalizeEndpoint(cfg.endpoint);
      } catch (e) {
        throw new Error(`插件设置里的 endpoint 不合法：${e.message}`);
      }

      const notes = [];
      const cwd = exec.agent?.session?.header?.cwd || process.cwd();
      const workDir = path.resolve(cwd, cfg.workDir || DEFAULT_WORK_DIR);
      const model = String(args.model || cfg.model).trim() || DEFAULT_MODEL;

      // —— 探测模式 ——
      if (args.probe === true) {
        const { modelsUrl, models } = await probeTranscriptionModels({
          endpoint,
          apiKey: cfg.apiKey,
          signal: exec.signal,
        });
        notes.push(`models 探测 URL：${modelsUrl}`);
        return {
          audioPath: endpoint,
          model,
          responseFormat: "probe",
          text: "",
          bytes: 0,
          elapsedSeconds: 0,
          models,
          notes,
        };
      }

      // —— 参数规范化 ——
      const source = String(args.audio ?? "").trim();
      if (!source) throw new Error("audio 不能为空：传本地音频路径或 http(s) 音频 URL（或用 probe=true 只探测模型）");
      const responseFormat = args.responseFormat !== undefined && String(args.responseFormat).trim()
        ? String(args.responseFormat).trim()
        : cfg.responseFormat;
      if (!RESPONSE_FORMATS.includes(responseFormat)) {
        throw new Error(`responseFormat 不合法：${responseFormat}（可选：${RESPONSE_FORMATS.join(" / ")}）`);
      }
      const task = args.task !== undefined && String(args.task).trim() ? String(args.task).trim() : "transcribe";
      if (!TASKS.includes(task)) throw new Error(`task 不合法：${task}（可选：${TASKS.join(" / ")}）`);
      const language = args.language !== undefined ? String(args.language).trim() : cfg.language;
      const prompt = args.prompt !== undefined ? String(args.prompt).trim() : "";

      // —— 物化输入：URL 先下载到工作目录 ——
      let audioPath = source;
      let downloaded = false;
      let isUrl = /^https?:\/\//i.test(source);
      if (isUrl) {
        await mkdir(workDir, { recursive: true });
        let ext = extFromUrl(source);
        const stem = safeStem(path.basename(new URL(source).pathname || "audio"));
        const destPath = path.join(workDir, `${stem}.${ext || "audio"}`);
        const dl = await downloadAudio(source, destPath, { signal: exec.signal });
        if (!ext) {
          const ctExt = extFromContentType(dl.contentType);
          if (ctExt) {
            const renamed = `${destPath.replace(/\.audio$/, "")}.${ctExt}`;
            await writeFile(renamed, await readFile(destPath));
            audioPath = renamed;
            notes.push(`URL 无扩展名，按 content-type 记为 .${ctExt}`);
          }
        } else {
          audioPath = destPath;
        }
        downloaded = true;
        notes.push(`URL 音频已下载到 ${audioPath}`);
      } else {
        audioPath = path.resolve(cwd, source);
      }
      if (!existsSync(audioPath)) throw new Error(`音频文件不存在：${audioPath}`);
      const bytes = statSync(audioPath).size;
      if (!bytes) throw new Error(`音频文件为空：${audioPath}`);
      if (bytes > MAX_AUDIO_BYTES) throw new Error(`音频过大：${bytes} 字节 > 上限 ${MAX_AUDIO_BYTES}`);

      // —— 组装上传（必要时 ffmpeg 转码；服务端报解码错误再兜底转一次）——
      const upload = async (wavOnly) => {
        let uploadPath = audioPath;
        let converted = false;
        if (wavOnly || (cfg.autoConvert && needsConversion(audioPath))) {
          await mkdir(workDir, { recursive: true });
          const wavPath = path.join(workDir, `${safeStem(path.basename(audioPath))}-16k.wav`);
          await convertToWav({ inputPath: audioPath, outputWavPath: wavPath, signal: exec.signal });
          uploadPath = wavPath;
          converted = true;
        }
        const buffer = await readFile(uploadPath);
        const form = buildTranscriptionForm({
          model,
          buffer,
          fileName: path.basename(uploadPath),
          mime: mimeForPath(uploadPath),
          language,
          prompt,
          responseFormat,
          task,
        });
        const res = await requestTranscription({
          endpoint,
          apiKey: cfg.apiKey,
          form,
          timeoutMs: Math.max(10, cfg.timeoutSec) * 1000,
          signal: exec.signal,
        });
        return { res, converted, uploadPath };
      };

      const t0 = Date.now();
      let attempt = await upload(false);
      if (!attempt.res.ok && !attempt.converted && cfg.autoConvert) {
        const errText = String(await attempt.res.clone().text().catch(() => "")).toLowerCase();
        if (/decode|format|corrupt|unsupported|invalid|container|sample|stream/.test(errText)) {
          notes.push("服务端无法解码原容器，已用 ffmpeg 转 16k wav 重试");
          attempt = await upload(true);
        }
      }
      const { res, converted } = attempt;
      if (!res.ok) {
        let body;
        const text0 = await res.text().catch(() => "");
        try {
          body = JSON.parse(text0);
        } catch {
          body = text0;
        }
        throw new Error(`转录失败 — ${formatApiError(res.status, body)}（${endpoint}，model=${model}）`);
      }

      // —— 解析响应 ——
      const wantsJson = responseFormat === "json" || responseFormat === "verbose_json";
      const raw = wantsJson ? await res.json().catch(async () => await res.text()) : await res.text();
      const parsed = normalizeTranscriptionResult(raw);

      // —— 可选落盘 ——
      let transcriptPath = "";
      const saveTo = String(args.saveTo ?? "").trim();
      if (saveTo) {
        transcriptPath = path.resolve(cwd, saveTo);
        await mkdir(path.dirname(transcriptPath), { recursive: true });
        await writeFile(transcriptPath, parsed.text.endsWith("\n") ? parsed.text : `${parsed.text}\n`, "utf8");
      }

      if (converted) notes.push(`上传前已转码为 16k 单声道 wav：${attempt.uploadPath}`);

      return {
        audioPath,
        ...(transcriptPath ? { transcriptPath } : {}),
        model,
        responseFormat,
        text: parsed.text,
        ...(parsed.language ? { language: parsed.language } : {}),
        ...(parsed.durationSeconds ? { durationSeconds: parsed.durationSeconds } : {}),
        bytes,
        elapsedSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
        ...(converted ? { converted: true } : {}),
        ...(downloaded ? { downloaded: true } : {}),
        ...(parsed.segments ? { segments: parsed.segments } : {}),
        ...(notes.length ? { notes } : {}),
      };
    },
  });
}

//#endregion
//#region 插件

function apply(ctx, config) {
  const logger = ctx.logger;
  // 注意：这里不吞 endpoint 规范化错误 —— normalizeConfig 会兜底回默认端点，
  // 真正的不合法值在 test/工具执行时显式报错。
  const current = () => normalizeConfig(resolveConfig(config));
  const toolHealth = { error: "" };
  let refreshFn = null;

  const getDescriptor = () => {
    let settings;
    try {
      settings = ctx.get("settings");
    } catch {
      settings = undefined;
    }
    if (!settings || typeof settings.describe !== "function") return undefined;
    try {
      return settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === NS);
    } catch {
      return undefined;
    }
  };

  const describe = async () => {
    const descriptor = getDescriptor();
    let toolNames = [];
    let toolError = "";
    try {
      const toolRuntime = ctx.get("tools");
      toolNames = toolRuntime && typeof toolRuntime.schemas === "function"
        ? toolRuntime.schemas().map((schema) => schema.name)
        : [];
    } catch (error) {
      toolError = error instanceof Error ? error.message : String(error);
    }
    let endpointPreview = "";
    try {
      endpointPreview = normalizeEndpoint(current().endpoint);
    } catch {
      endpointPreview = "(invalid)";
    }
    return {
      ok: true,
      value: {
        ns: NS,
        version: PLUGIN_VERSION,
        revision: descriptor ? descriptor.revision : 0,
        config: descriptor ? descriptor.value : publicConfig(current()),
        secrets: descriptor && Array.isArray(descriptor.secrets) ? descriptor.secrets : [],
        responseFormats: RESPONSE_FORMATS,
        tasks: TASKS,
        defaultEndpoint: DEFAULT_ENDPOINT,
        defaultModel: DEFAULT_MODEL,
        effectiveEndpoint: endpointPreview,
        toolRegistered: toolNames.includes("stt_transcribe"),
        toolNames,
        toolError: [toolError, toolHealth.error].filter(Boolean).join(" | "),
      },
    };
  };

  const save = async (body) => {
    if (body === null || typeof body !== "object") {
      return { ok: false, code: "bad-request", message: "malformed save request" };
    }
    const cfg = current();
    let endpoint;
    try {
      endpoint = normalizeEndpoint(body.endpoint ?? cfg.endpoint);
    } catch (error) {
      return { ok: false, code: "invalid-endpoint", message: error instanceof Error ? error.message : String(error) };
    }
    const responseFormat = String(body.responseFormat ?? cfg.responseFormat);
    if (!RESPONSE_FORMATS.includes(responseFormat)) {
      return { ok: false, code: "invalid-config", message: `responseFormat 必须是 ${RESPONSE_FORMATS.join(" / ")} 之一` };
    }
    const timeoutSec = Number(body.timeoutSec ?? cfg.timeoutSec);
    if (!Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 3600) {
      return { ok: false, code: "invalid-config", message: "timeoutSec 必须是 10–3600 的整数" };
    }
    const workDir = String(body.workDir ?? cfg.workDir).trim();
    if (!workDir) return { ok: false, code: "invalid-config", message: "workDir 不能为空" };
    const model = String(body.model ?? cfg.model).trim();
    const language = body.language !== undefined ? String(body.language).trim() : cfg.language;

    const ops = [
      { op: "set", path: ["enabled"], value: body.enabled !== false },
      { op: "set", path: ["endpoint"], value: endpoint },
      { op: "set", path: ["model"], value: model },
      { op: "set", path: ["language"], value: language },
      { op: "set", path: ["responseFormat"], value: responseFormat },
      { op: "set", path: ["workDir"], value: workDir },
      { op: "set", path: ["autoConvert"], value: body.autoConvert !== false },
      { op: "set", path: ["timeoutSec"], value: timeoutSec },
    ];
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      ops.push({ op: "set", path: ["apiKey"], value: body.apiKey.trim() });
    } else if (body.clearApiKey === true) {
      ops.push({ op: "unset", path: ["apiKey"] });
    }

    const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
    try {
      await ctx.get("settings").mutate(NS, ops, expectedRevision);
    } catch (error) {
      if (error instanceof SettingsConflictError) {
        return { ok: false, code: "settings-conflict", message: error.message };
      }
      return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
    }
    return describe();
  };

  // 连通性测试：探测 /models 里可用的转写模型。
  const test = async (body) => {
    const cfg = current();
    let endpoint;
    try {
      endpoint = normalizeEndpoint((body && body.endpoint) || cfg.endpoint);
    } catch (error) {
      return { ok: false, code: "invalid-endpoint", message: error instanceof Error ? error.message : String(error) };
    }
    const apiKey = body && typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : cfg.apiKey;
    try {
      const { modelsUrl, models } = await probeTranscriptionModels({ endpoint, apiKey });
      return { ok: true, value: { endpoint, modelsUrl, models, modelsError: "" } };
    } catch (error) {
      return {
        ok: true,
        value: {
          endpoint,
          modelsUrl: "",
          models: [],
          modelsError: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  // 设置桥路由（宿主 webServer 路由表按 (kind, path) 键控、不区分 method，
  // 同一路径注册两条会抛 duplicate —— 与 dsh-tts 相同，三条独立路径逐条注册）。
  const bridgeRoutes = [
    {
      kind: "exact",
      method: "GET",
      path: `${BRIDGE_PREFIX}/config`,
      handler: async (req, res) => writeJson(res, 200, await describe()),
    },
    {
      kind: "exact",
      method: "POST",
      path: `${BRIDGE_PREFIX}/save`,
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        const out = await save(body);
        writeJson(res, out.ok ? 200 : 400, out);
      },
    },
    {
      kind: "exact",
      method: "POST",
      path: `${BRIDGE_PREFIX}/test`,
      handler: async (req, res) => {
        const body = (await readJsonBody(req)) || {};
        const out = await test(body);
        writeJson(res, out.ok ? 200 : 400, out);
      },
    },
  ];

  ctx.inject(["webServer", "settings"], (sctx) => {
    // 配置页由本包客户端半 lib/client.js 在插件管理里渲染，关闭宿主自动生成页。
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), "dsh-stt: settings page policy");

    sctx.effect(() => {
      const disposers = [];
      for (const route of bridgeRoutes) {
        try {
          disposers.push(sctx.webServer.register(route));
        } catch (error) {
          logger.error(`dsh-stt: 桥路由注册失败 ${route.method} ${route.path} — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-stt: settings routes");

    logger.info(`dsh-stt: bridge ready at ${BRIDGE_PREFIX} (${PLUGIN_VERSION})`);
  });

  // 工具注册（settings 缺失的头less 组合下也要工作：tools 单独注入，
  // 设置变更监听单独注入）。
  ctx.inject(["tools"], (sctx) => {
    let disposeTool = null;
    const refresh = () => {
      if (disposeTool) {
        disposeTool();
        disposeTool = null;
      }
      if (!current().enabled) return;
      try {
        disposeTool = sctx.tools.register(buildSttTool({ current, logger }));
        toolHealth.error = "";
      } catch (error) {
        toolHealth.error = error instanceof Error ? error.message : String(error);
        logger.error(`dsh-stt: stt_transcribe 注册失败 — ${toolHealth.error}`);
      }
    };
    refreshFn = refresh;

    sctx.effect(() => {
      refresh();
      return () => {
        if (disposeTool) {
          disposeTool();
          disposeTool = null;
        }
        if (refreshFn === refresh) refreshFn = null;
      };
    }, "dsh-stt: stt_transcribe tool");
  });

  ctx.inject(["settings"], (sctx) => {
    sctx.on("settings/document-updated", (ns) => {
      if (String(ns) === NS && refreshFn) refreshFn();
    });
  });

  logger.info(
    `dsh-stt: ready (${PLUGIN_VERSION}) — configure at Plugins → dsh-stt → ${NS}; tool: stt_transcribe`,
  );
}

export { Config, apply, buildSttTool, PLUGIN_VERSION, NS, BRIDGE_PREFIX };
