// 真实端点 E2E（不进 npm test，需服务在线）：
//   node test/live-e2e.mjs [音频路径 ...]
// 走与 stt_transcribe 相同的 core 代码路径：读文件 → 组表单 → POST → 解析。
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  buildTranscriptionForm,
  mimeForPath,
  needsConversion,
  normalizeEndpoint,
  normalizeTranscriptionResult,
  probeTranscriptionModels,
  requestTranscription,
} from "../lib/core.js";

const ENDPOINT = process.env.STT_ENDPOINT || "http://ai4090:8080/v1/audio/transcriptions";
const MODEL = process.env.STT_MODEL || "Whisper-Large-v3-Turbo";

const files = process.argv.slice(2);
if (!files.length) {
  files.push(
    "/Volumes/cache/agent_space/dsh调试/.dsh-tts/stt_test_1_daily.wav",
    "/Volumes/cache/agent_space/dsh调试/.dsh-tts/stt_test_2_tech.wav",
    "/Volumes/cache/agent_space/dsh调试/.dsh-tts/stt_test_3_tongue.wav",
  );
}

const endpoint = normalizeEndpoint(ENDPOINT);
console.log(`endpoint: ${endpoint}`);

const { models } = await probeTranscriptionModels({ endpoint });
console.log(`probe: ${models.map((m) => `${m.id}${m.status ? `(${m.status})` : ""}`).join("、") || "无"}`);

for (const file of files) {
  const buffer = await readFile(file);
  const form = buildTranscriptionForm({
    model: MODEL,
    buffer,
    fileName: path.basename(file),
    mime: mimeForPath(file),
    responseFormat: "verbose_json",
  });
  const t0 = Date.now();
  const res = await requestTranscription({ endpoint, form, timeoutMs: 300_000 });
  if (!res.ok) {
    console.error(`✗ ${file}: HTTP ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    continue;
  }
  const parsed = normalizeTranscriptionResult(await res.json());
  const secs = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n✓ ${path.basename(file)} (${needsConversion(file) ? "需转码" : "直传"}, ${buffer.length}B, ${secs}s)`);
  console.log(`  language=${parsed.language ?? "-"} duration=${parsed.durationSeconds ?? "-"}s segments=${parsed.segments?.length ?? 0}`);
  console.log(`  text: ${parsed.text.replace(/\n/g, " ")}`);
}
