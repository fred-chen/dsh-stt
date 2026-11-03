# dsh-stt

[English](README.md) | 中文

DeepSeek Harness 语音转文字插件：把 **OpenAI 兼容 `/v1/audio/transcriptions` 转写服务** 接进 DSH，注册模型侧工具 **`stt_transcribe`**，默认指向 `http://ai4090:8080/v1/audio/transcriptions`（llama-swap 代理的 `Whisper-Large-v3-Turbo`）。

工具描述里写清了触发场景：你丢给模型一个音频文件（录音、语音备忘、会议片段、TTS 产物回测），或提「转写 / 字幕 / 这段录音说了什么」，模型就会自动调用 `stt_transcribe`。

## 特性

- **端点与模型可自定义**：图形界面（插件管理 → dsh-stt）或 `cordis.patch.yml` 皆可改；端点字段接受完整转写 URL，也接受 origin / `/v1` / `/v1/audio` 写法，自动补全。
- **本地路径 + URL**：音频参数支持会话工作目录相对路径与 `http(s)` 音频链接（下载缓存在 `workDir`）。
- **自动转码**：m4a / mp4 / webm / opus / aac / amr 等容器先用 `ffmpeg` 转 16k 单声道 wav 再上传；服务端解码报错时还有一次自动转码重试。
- **语言**：默认服务端自动检测，可指定 ISO 代码（`zh` / `en` / `ja` / `ko` / `yue`…）。
- **响应格式**：`json`（默认纯文本）、`verbose_json`（附语言 / 时长 / 分段时间戳）、`text` / `srt` / `vtt`。
- **术语提示**：`prompt` 偏置专有名词与领域词汇。
- **翻译**：`task="translate"` 直接输出英文。
- **端点探测**：`probe=true` 列出端点上具备转写能力的模型（走 `/v1/models`），不做转录。
- **转录落盘**：`saveTo` 把工作区里的转写文本存成文件。
- **设置页**：插件管理内可视化配置 + 连通性测试，保存即生效无需重启；API Key 按 secret 存储不回显。
- **会话卡片**：转录结果渲染为文本卡片，附语言 / 时长 / 耗时 chip。

## 安装

```sh
dsh plugin --profile <你的profile> add /path/to/dsh-stt
```

然后重启应用（或 `dsh --profile <你的profile>` 启动）。插件行与默认值来自包内 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-stt
      name: dsh-stt
      config:
        enabled: true
        endpoint: http://ai4090:8080/v1/audio/transcriptions
        model: Whisper-Large-v3-Turbo
        language: ""            # 留空 = 自动检测
        responseFormat: json    # json | verbose_json | text | srt | vtt
        workDir: .dsh-stt       # 下载 / 转码产物目录
        autoConvert: true       # 非安全容器 ffmpeg 转 16k wav
        timeoutSec: 300
```

用户 profile 自己的 `cordis.patch.yml` 可整行覆盖以上配置（后层优先），不需要改本包。

## 工具参数 `stt_transcribe`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `audio` | string | 本地路径或 http(s) URL；`probe=true` 时可省略 |
| `probe` | boolean | 只探测端点上的转写模型 |
| `model` | string | 缺省用插件设置 |
| `language` | string | ISO 代码（`zh`/`chinese`），空 = 自动 |
| `task` | `transcribe` \| `translate` | translate 输出英文 |
| `prompt` | string | 术语 / 上下文提示（≤448 token） |
| `responseFormat` | enum | `json`（默认）/ `verbose_json` / `text` / `srt` / `vtt` |
| `saveTo` | string | 同时把转写文本写入工作区该路径 |

返回规范值 `{ audioPath, text, model, language?, durationSeconds?, segments?, elapsedSeconds, bytes, … }`，PTC 模式下可直接 `await tools.stt_transcribe({...})` 消费。

## 实测（Whisper-Large-v3-Turbo，24 kHz TTS 输入）

- 中文日常叙述、含数字的科技术语、四/十平翘舌绕口令：**逐字全对**。
- 14–20 秒音频转录耗时 **0.3–0.6 秒**（约 30–65 倍实时率）；空闲后首个请求含 llama-swap 模型装载开销（约 2 秒）。

与 [`dsh-tts`](https://github.com/fred-chen/dsh-tts) 配对可做「生成 → 转录」回环测试。

## 开发

```sh
node test/core.test.mjs     # lib/core.js 离线单测
node test/live-e2e.mjs      # 真实端点端到端（需服务在线）
```

`lib/core.js` 零依赖（端点规范化 / 表单组装 / 响应解析 / ffmpeg 与下载助手）；`lib/index.js` 宿主插件（工具 + `/api/dsh-stt/*` 设置桥）；`lib/client.js` Web GUI 的设置与结果卡片。

## 许可

MIT
