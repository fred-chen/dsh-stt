// dsh-stt core.js 离线单测：node test/core.test.mjs
import assert from "node:assert/strict";

import {
  DEFAULT_ENDPOINT,
  RESPONSE_FORMATS,
  buildTranscriptionForm,
  deriveModelsUrl,
  extFromContentType,
  mimeForPath,
  needsConversion,
  normalizeEndpoint,
  normalizeTranscriptionResult,
  pickTranscriptionModels,
  safeStem,
} from "../lib/core.js";

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("normalizeEndpoint");
await check("完整转写 URL 原样", () => {
  assert.equal(normalizeEndpoint("http://ai4090:8080/v1/audio/transcriptions"), "http://ai4090:8080/v1/audio/transcriptions");
});
await check("尾斜杠去除", () => {
  assert.equal(normalizeEndpoint("http://ai4090:8080/v1/audio/transcriptions/"), "http://ai4090:8080/v1/audio/transcriptions");
});
await check("/v1/audio 补 /transcriptions", () => {
  assert.equal(normalizeEndpoint("http://ai4090:8080/v1/audio"), "http://ai4090:8080/v1/audio/transcriptions");
});
await check("/v1 补全", () => {
  assert.equal(normalizeEndpoint("http://ai4090:8080/v1"), "http://ai4090:8080/v1/audio/transcriptions");
});
await check("origin 补 /v1/audio/transcriptions", () => {
  assert.equal(normalizeEndpoint("http://ai4090:8080"), "http://ai4090:8080/v1/audio/transcriptions");
  assert.equal(normalizeEndpoint("http://ai4090:8080/"), "http://ai4090:8080/v1/audio/transcriptions");
});
await check("自定义网关路由原样保留", () => {
  assert.equal(normalizeEndpoint("http://gw.local:9000/asr"), "http://gw.local:9000/asr");
});
await check("空值回默认端点", () => {
  assert.equal(normalizeEndpoint(""), DEFAULT_ENDPOINT);
  assert.equal(normalizeEndpoint(undefined), DEFAULT_ENDPOINT);
});
await check("非法 URL 抛错", () => {
  assert.throws(() => normalizeEndpoint("not a url"), /http\(s\)/);
  assert.throws(() => normalizeEndpoint("ftp://host/x"), /协议/);
});
await check("丢弃 query/hash", () => {
  assert.equal(normalizeEndpoint("http://h:1/v1?x=1#z"), "http://h:1/v1/audio/transcriptions");
});

console.log("deriveModelsUrl");
await check("完整 URL → /v1/models", () => {
  assert.equal(deriveModelsUrl("http://ai4090:8080/v1/audio/transcriptions"), "http://ai4090:8080/v1/models");
});
await check("/v1 基底 → /v1/models", () => {
  assert.equal(deriveModelsUrl("http://ai4090:8080/v1"), "http://ai4090:8080/v1/models");
});
await check("origin → /v1/models", () => {
  assert.equal(deriveModelsUrl("http://ai4090:8080"), "http://ai4090:8080/v1/models");
});

console.log("容器与 MIME");
await check("安全容器判定", () => {
  assert.equal(needsConversion("a/b/c.WAV"), false);
  assert.equal(needsConversion("x.mp3"), false);
  assert.equal(needsConversion("x.m4a"), true);
  assert.equal(needsConversion("clip.webm"), true);
  assert.equal(needsConversion("noext"), true);
});
await check("MIME 映射", () => {
  assert.equal(mimeForPath("a.wav"), "audio/wav");
  assert.equal(mimeForPath("a.m4a"), "audio/mp4");
  assert.equal(mimeForPath("a.xyz"), "application/octet-stream");
});
await check("content-type 反查扩展名", () => {
  assert.equal(extFromContentType("audio/mpeg; codecs=mp3"), "mp3");
  assert.equal(extFromContentType("text/html"), "");
});
await check("safeStem 中日英与截断", () => {
  assert.equal(safeStem("会议录音-2026"), "会议录音-2026");
  assert.equal(safeStem("a/b\\c d.mp3"), "a-b-c-d.mp3");
  assert.ok(safeStem("x".repeat(100)).length <= 48);
});

console.log("表单与响应");
await check("表单只带非空字段", async () => {
  const form = buildTranscriptionForm({ model: "M", buffer: new Uint8Array([1, 2, 3]), fileName: "a.wav", mime: "audio/wav" });
  assert.equal(form.get("model"), "M");
  assert.equal(form.get("response_format"), "json");
  assert.equal(form.get("language"), null);
  assert.equal(form.get("task"), null);
  const form2 = buildTranscriptionForm({
    model: "M", buffer: new Uint8Array([1]), fileName: "a.wav", language: "zh",
    prompt: "术语", responseFormat: "verbose_json", task: "translate", temperature: 0.2,
  });
  assert.equal(form2.get("language"), "zh");
  assert.equal(form2.get("prompt"), "术语");
  assert.equal(form2.get("response_format"), "verbose_json");
  assert.equal(form2.get("task"), "translate");
  assert.equal(form2.get("temperature"), "0.2");
});
await check("json 响应解析", () => {
  assert.deepEqual(normalizeTranscriptionResult({ text: "你好。" }), { text: "你好。" });
});
await check("verbose_json 响应解析", () => {
  const out = normalizeTranscriptionResult({
    text: "第一段。第二段。",
    language: "chinese",
    duration: 16.24,
    segments: [
      { start: 0, end: 5.1, text: " 第一段。" },
      { start: 5.8, end: 11.5, text: " 第二段。" },
      { start: 11.5, end: 11.5, text: "   " },
    ],
  });
  assert.equal(out.language, "chinese");
  assert.equal(out.durationSeconds, 16.24);
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[0].text, "第一段。");
});
await check("纯文本响应（srt/vtt/text）", () => {
  assert.deepEqual(normalizeTranscriptionResult("1\n00:00:00,000 --> 00:00:05,000\n你好\n"), { text: "1\n00:00:00,000 --> 00:00:05,000\n你好" });
});

console.log("模型探测");
await check("按 capabilities 挑转写模型", () => {
  const models = pickTranscriptionModels({
    data: [
      { id: "DeepSeek-V4.1-Flash", status: { value: "loaded" } },
      { id: "Qwen-Image-2.1-Turbo", architecture: { input_modalities: ["text", "image"] } },
      { id: "Qwen3-TTS-12Hz-1.7B-CustomVoice", capabilities: { audio_speech: true } },
      { id: "Whisper-Large-v3-Turbo", architecture: { input_modalities: ["audio"], modality: "audio->text" }, capabilities: { audio_transcriptions: true }, status: { value: "loaded" } },
    ],
  });
  assert.deepEqual(models, [{ id: "Whisper-Large-v3-Turbo", status: "loaded" }]);
});
await check("按命名兜底", () => {
  const models = pickTranscriptionModels({ data: [{ id: "SenseVoiceSmall" }, { id: "gpt-4" }] });
  assert.deepEqual(models.map((m) => m.id), ["SenseVoiceSmall"]);
});

console.log(`\ndsh-stt core: ${passed} 项断言全部通过 ✅`);
