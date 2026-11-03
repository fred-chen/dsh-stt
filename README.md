# dsh-stt

[中文](README.zh.md) | English

Speech-to-text plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Registers the model-facing tool **`stt_transcribe`**, which transcribes audio through any OpenAI-compatible `/v1/audio/transcriptions` endpoint — out of the box pointed at `http://ai4090:8080/v1/audio/transcriptions` (llama-swap serving `Whisper-Large-v3-Turbo`).

The tool description tells the model when to use it: whenever you share or reference an audio file (recording, voice memo, meeting clip, TTS output you want verified), or ask for a transcript / subtitles, the model calls `stt_transcribe` automatically.

## Features

- **Customizable endpoint & model** — set in the GUI (Plugins → dsh-stt) or via `cordis.patch.yml`. The endpoint field accepts the full transcription URL, or an origin / `/v1` / `/v1/audio` base — it is normalized automatically.
- **Local paths and URLs** — pass a local audio file path (relative to the session working directory) or an `http(s)` audio URL; URL downloads are cached under `workDir`.
- **Auto-transcode** — containers the server may not decode (m4a/mp4/webm/opus/aac/amr…) are converted to 16 kHz mono wav with `ffmpeg` before upload; there is also a fallback retry when the server rejects the original container.
- **Language** — auto-detected by default, or force an ISO-639-1 code (`zh`, `en`, `ja`, `ko`, `yue`…).
- **Response formats** — `json` (plain text, default), `verbose_json` (adds language, duration and per-segment timestamps), `text` / `srt` / `vtt`.
- **Vocabulary hinting** — `prompt` biases proper nouns and domain terms.
- **Translation** — `task="translate"` outputs English.
- **Endpoint probe** — `probe=true` lists transcription-capable models loaded on the endpoint (via `/v1/models`) without transcribing.
- **Save transcripts** — `saveTo` writes the transcript text to a file in the workspace.
- **Settings GUI** — a config card in the plugin manager with connectivity test; changes apply without restart. Secret fields (API key) are stored redacted.
- **Session cards** — transcription results render as a text card with language / duration / latency chips.

## Install

```sh
dsh plugin --profile <your-profile> add /path/to/dsh-stt
```

Then restart the app (or boot `dsh --profile <your-profile>`). The plugin row and defaults come from its `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-stt
      name: dsh-stt
      config:
        enabled: true
        endpoint: http://ai4090:8080/v1/audio/transcriptions
        model: Whisper-Large-v3-Turbo
        language: ""            # empty = auto-detect
        responseFormat: json    # json | verbose_json | text | srt | vtt
        workDir: .dsh-stt       # downloads / transcoded wav land here
        autoConvert: true       # ffmpeg for exotic containers
        timeoutSec: 300
```

Users can override every field in their profile's own `cordis.patch.yml` (later layers win).

## Tool: `stt_transcribe`

| Param | Type | Notes |
| --- | --- | --- |
| `audio` | string | Local path or http(s) URL. Required unless `probe=true`. |
| `probe` | boolean | Only list transcription models on the endpoint. |
| `model` | string | Defaults to the plugin setting. |
| `language` | string | ISO code (`zh`/`chinese`) or empty = auto. |
| `task` | `transcribe` \| `translate` | translate → English output. |
| `prompt` | string | Vocabulary / context hint (≤448 tokens). |
| `responseFormat` | enum | `json` (default) / `verbose_json` / `text` / `srt` / `vtt`. |
| `saveTo` | string | Also write the transcript to this workspace path. |

Returns the canonical value `{ audioPath, text, model, language?, durationSeconds?, segments?, elapsedSeconds, bytes, … }` — usable directly from PTC mode (`await tools.stt_transcribe({...})`).

## Measured (Whisper-Large-v3-Turbo, 24 kHz TTS input)

- Chinese narration, tech dictation with numbers, and the 四/十 tongue-twister: **all character-perfect**.
- 14–20 s clips in **0.3–0.6 s** (≈30–65× real time); first request after idle pays the llama-swap model-load cost (~2 s).

Pairs with [`dsh-tts`](https://github.com/fred-chen/dsh-tts) for generate → transcribe round-trip testing.

## Development

```sh
node test/core.test.mjs     # offline unit tests for lib/core.js
node test/live-e2e.mjs      # end-to-end against a real endpoint (needs the service up)
```

`lib/core.js` is dependency-free (endpoint normalization, form building, response parsing, ffmpeg/download helpers). `lib/index.js` is the host plugin (tool + settings bridge at `/api/dsh-stt/*`), `lib/client.js` the web-GUI cards.

## License

MIT
