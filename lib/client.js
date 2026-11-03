// dsh-stt 客户端半：在插件管理里渲染配置页，在会话里渲染转录结果卡片。
// 遵循宿主 slot 约定（与 dsh-tts / dsh-video-gen 一致）：
//   plugins.row.config  key = "dsh-stt#dsh-stt"       → 配置卡片
//   tool.call.toolview  key = "stt_transcribe"        → 转录结果卡片
window.__ModuleLoader__.load({
  id: "dsh-stt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const BRIDGE_PREFIX = "/api/dsh-stt";
    const LANGUAGES = [
      { value: "", label: "（自动检测）" },
      { value: "zh", label: "zh · 中文" },
      { value: "yue", label: "yue · 粤语" },
      { value: "en", label: "en · 英文" },
      { value: "ja", label: "ja · 日文" },
      { value: "ko", label: "ko · 韩文" },
      { value: "de", label: "de · 德文" },
      { value: "fr", label: "fr · 法文" },
      { value: "es", label: "es · 西文" },
      { value: "ru", label: "ru · 俄文" },
    ];
    const RESPONSE_FORMATS = ["json", "verbose_json", "text", "srt", "vtt"];

    //#region styles
    (function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById("dss-styles")) return;
      const style = document.createElement("style");
      style.id = "dss-styles";
      style.textContent = [
        ".dss-set-page{display:flex;flex-direction:column;gap:16px;color:inherit;font-size:14px;line-height:1.55}",
        ".dss-set-card{border:1px solid rgba(0,0,0,.08);border-radius:12px;background:rgba(255,255,255,.72);padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
        "@media (prefers-color-scheme: dark){.dss-set-card{background:rgba(30,30,32,.7);border-color:rgba(255,255,255,.08)}}",
        ".dss-set-title{font-weight:600;font-size:14px;margin:0}",
        ".dss-set-hint{color:#6e6e73;font-size:12px;margin:0}",
        "@media (prefers-color-scheme: dark){.dss-set-hint{color:#a1a1a6}}",
        ".dss-set-error{color:#dc2626;font-size:12px;margin:0;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dss-set-error{color:#f87171}}",
        ".dss-set-ok{color:#16a34a;font-size:12px;margin:0;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dss-set-ok{color:#4ade80}}",
        ".dss-set-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}",
        ".dss-set-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
        ".dss-set-label{font-size:12px;font-weight:500;color:#3a3a3c;display:flex;align-items:center;gap:6px}",
        "@media (prefers-color-scheme: dark){.dss-set-label{color:#d1d1d6}}",
        ".dss-set-input,.dss-set-select{width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;color:inherit;background:rgba(0,0,0,.03)}",
        "@media (prefers-color-scheme: dark){.dss-set-input,.dss-set-select{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.05)}}",
        ".dss-set-input:focus-visible,.dss-set-select:focus-visible{outline:none;border-color:#0071e3}",
        ".dss-set-btn{border:1px solid rgba(0,0,0,.14);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;background:transparent;color:inherit}",
        ".dss-set-btn:hover:not(:disabled){background:rgba(0,0,0,.05)}",
        "@media (prefers-color-scheme: dark){.dss-set-btn:hover:not(:disabled){background:rgba(255,255,255,.07)}}",
        ".dss-set-btnPrimary{background:#0071e3;border-color:#0071e3;color:#fff}",
        ".dss-set-btnPrimary:hover:not(:disabled){background:#0a84ff}",
        ".dss-set-btn:disabled{opacity:.5;cursor:default}",
        ".dss-set-toggle{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}",
        ".dss-set-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,113,227,.12);color:#0071e3}",
        "@media (prefers-color-scheme: dark){.dss-set-chip{color:#60a5fa}}",
        ".dss-set-result{border:1px dashed rgba(0,0,0,.15);border-radius:10px;padding:10px 12px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:inherit}",
        "@media (prefers-color-scheme: dark){.dss-set-result{border-color:rgba(255,255,255,.18)}}",
        ".dss-card{display:flex;flex-direction:column;gap:8px;padding:8px 0 4px;max-width:640px}",
        ".dss-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
        ".dss-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.06);color:#3a3a3c}",
        "@media (prefers-color-scheme: dark){.dss-chip{background:rgba(255,255,255,.08);color:#d1d1d6}}",
        ".dss-chipOk{background:rgba(22,163,74,.12);color:#15803d}",
        "@media (prefers-color-scheme: dark){.dss-chipOk{color:#4ade80}}",
        ".dss-chipWarn{background:rgba(245,158,11,.14);color:#b45309}",
        "@media (prefers-color-scheme: dark){.dss-chipWarn{color:#f59e0b}}",
        ".dss-path{font-family:monospace;font-size:11px;color:#6e6e73;overflow-wrap:anywhere}",
        "@media (prefers-color-scheme: dark){.dss-path{color:#a1a1a6}}",
        ".dss-pending{display:flex;flex-direction:column;gap:4px;padding:4px 0}",
        ".dss-pending-title{font-weight:600;font-size:13px}",
        ".dss-hint{color:#6e6e73;font-size:12px;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dss-hint{color:#a1a1a6}}",
        ".dss-error{color:#dc2626;font-size:12px;white-space:pre-wrap}",
        "@media (prefers-color-scheme: dark){.dss-error{color:#f87171}}",
        ".dss-text{border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.02)}",
        "@media (prefers-color-scheme: dark){.dss-text{border-color:rgba(255,255,255,.1);background:rgba(255,255,255,.04)}}",
        ".dss-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
        ".dss-link,.dss-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer;text-decoration:none;border:1px solid rgba(0,113,227,.35);color:#0071e3;background:rgba(0,113,227,.06)}",
      ].join("\n");
      document.head.appendChild(style);
    })();
    //#endregion

    //#region bridge
    async function bridgeCall(path, options) {
      let response;
      try {
        response = await fetch(`${BRIDGE_PREFIX}${path}`, options);
      } catch (error) {
        return { ok: false, code: "network", message: "无法连接宿主接口：" + (error && error.message ? error.message : String(error)) };
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const detail = body && (body.message || body.error);
        return { ok: false, code: "http-" + response.status, message: `接口返回 ${response.status}${detail ? "：" + detail : ""}` };
      }
      if (body === null || typeof body !== "object") {
        return { ok: false, code: "bad-response", message: "接口返回了无法解析的内容（宿主插件版本与页面不一致，请重载后重试）" };
      }
      return body;
    }
    const bridgeDescribe = () => bridgeCall("/config", { method: "GET" });
    const bridgeSave = (payload) => bridgeCall("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
    const bridgeTest = (payload) => bridgeCall("/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
    //#endregion

    function Field(label, control, hint) {
      return h("div", { className: "dss-set-field" },
        h("label", { className: "dss-set-label" }, label, hint ? h("span", { className: "dss-set-chip" }, hint) : null),
        control);
    }

    function SettingsCard() {
      const [config, setConfig] = useState(null);
      const [revision, setRevision] = useState(0);
      const [version, setVersion] = useState("");
      const [toolRegistered, setToolRegistered] = useState(false);
      const [secretSet, setSecretSet] = useState(false);
      const [status, setStatus] = useState({ kind: "", text: "" });
      const [busy, setBusy] = useState(false);
      const [probe, setProbe] = useState(null);

      const load = useCallback(async () => {
        const out = await bridgeDescribe();
        if (!out.ok) { setStatus({ kind: "error", text: out.message }); return; }
        setConfig(out.value.config || {});
        setRevision(out.value.revision ?? 0);
        setVersion(out.value.version ?? "");
        setToolRegistered(out.value.toolRegistered === true);
        const secrets = Array.isArray(out.value.secrets) ? out.value.secrets : [];
        setSecretSet(secrets.some((s) => s && Array.isArray(s.path) && s.path.join(".") === "apiKey" && s.set));
      }, []);
      useEffect(() => { load(); }, [load]);

      if (!config) {
        return h("div", { className: "dss-set-card" },
          h("p", { className: "dss-set-hint" }, status.kind === "error" ? status.text : "正在读取配置…"));
      }

      const patch = (key) => (event) => setConfig({ ...config, [key]: event.target.value });
      const input = (key, props) => h("input", { className: "dss-set-input", value: config[key] ?? "", onInput: patch(key), onChange: patch(key), ...props });
      const select = (key, options, props) => h("select", { className: "dss-set-select", value: config[key] ?? "", onChange: patch(key), ...props },
        options.map((o) => h("option", { key: String(typeof o === "string" ? o : o.value), value: typeof o === "string" ? o : o.value }, typeof o === "string" ? o : o.label)));

      const save = async () => {
        setBusy(true);
        const payload = {
          ...config,
          timeoutSec: Math.round(Number(config.timeoutSec) || 300),
          expectedRevision: revision,
        };
        const out = await bridgeSave(payload);
        setBusy(false);
        if (!out.ok) { setStatus({ kind: "error", text: out.message || "保存失败" }); return; }
        setStatus({ kind: "ok", text: "已保存，立即生效。" });
        await load();
      };

      const test = async () => {
        setBusy(true);
        setStatus({ kind: "", text: "" });
        const out = await bridgeTest({ endpoint: config.endpoint });
        setBusy(false);
        if (!out.ok) { setStatus({ kind: "error", text: out.message || "测试失败" }); return; }
        setProbe(out.value);
      };

      return h("div", { className: "dss-set-page" },
        h("div", { className: "dss-set-card" },
          h("p", { className: "dss-set-title" }, "dsh-stt 设置 ", h("span", { className: "dss-set-chip" }, "v" + version),
            h("span", { className: toolRegistered ? "dss-chip dss-chipOk" : "dss-chip dss-chipWarn" }, toolRegistered ? "stt_transcribe 已注册" : "stt_transcribe 未注册")),
          h("p", { className: "dss-set-hint" }, "OpenAI 兼容 /v1/audio/transcriptions 语音转文字端点。改完点「保存」，无需重启。"),
          h("label", { className: "dss-set-toggle" },
            h("input", { type: "checkbox", checked: config.enabled !== false, onChange: (e) => setConfig({ ...config, enabled: e.target.checked }) }),
            "启用 stt_transcribe 工具"),
          Field("API 端点 URL", input("endpoint", { placeholder: "http://ai4090:8080/v1/audio/transcriptions", spellCheck: false }),
            "接受 origin / /v1 / /v1/audio / 完整 URL 写法"),
          Field("模型", input("model", { placeholder: "Whisper-Large-v3-Turbo", spellCheck: false })),
          h("div", { className: "dss-set-grid" },
            Field("默认语言", select("language", LANGUAGES)),
            Field("默认响应格式", select("responseFormat", RESPONSE_FORMATS)),
            Field("工作目录", input("workDir", { placeholder: ".dsh-stt", spellCheck: false })),
            Field("超时（秒）", input("timeoutSec", { type: "number", min: 10, max: 3600 }))),
          h("label", { className: "dss-set-toggle" },
            h("input", { type: "checkbox", checked: config.autoConvert !== false, onChange: (e) => setConfig({ ...config, autoConvert: e.target.checked }) }),
            "非 wav/mp3/flac/ogg 容器自动用 ffmpeg 转 16k wav"),
          Field("API Key（可选，secret）", input("apiKey", {
            type: "password",
            placeholder: secretSet ? "已保存（留空保持不变，输入新值覆盖）" : "留空 = 不发送鉴权头",
            spellCheck: false, autoComplete: "off",
          })),
          h("div", { className: "dss-actions" },
            h("button", { className: "dss-set-btn dss-set-btnPrimary", type: "button", disabled: busy, onClick: save }, "保存"),
            h("button", { className: "dss-set-btn", type: "button", disabled: busy, onClick: test }, "测试连通性"),
            h("button", { className: "dss-set-btn", type: "button", disabled: busy, onClick: load }, "重新读取")),
          status.kind === "error" ? h("p", { className: "dss-set-error" }, status.text) : null,
          status.kind === "ok" ? h("p", { className: "dss-set-ok" }, status.text) : null,
          probe ? h("div", { className: "dss-set-result" },
            `端点：${probe.endpoint}`, "\n",
            `探测 URL：${probe.modelsUrl}`, "\n",
            probe.modelsError
              ? `模型探测失败：${probe.modelsError}`
              : `转写模型：${(probe.models || []).map((m) => `${m.id}${m.status ? `(${m.status})` : ""}`).join("、") || "未发现（也可能服务端未在 /models 声明转写能力）"}`) : null));
    }

    function summaryText() {
      return "语音转文字 · 端点、模型、语言与响应格式可配置，支持本地路径与 URL";
    }

    //#region 工具卡片
    function flattenText(block) {
      const content = block && block.content;
      if (!Array.isArray(content)) return "";
      return content.filter((part) => part && part.type === "text").map((part) => part.text).join("\n");
    }

    function SttToolView(props) {
      const { phase, block, openFile } = props;
      if (phase !== "result") {
        const args = block && block.args && typeof block.args === "object" ? block.args : {};
        const audio = typeof args.audio === "string" ? args.audio : "";
        return h("div", { className: "dss-pending" },
          h("div", { className: "dss-pending-title" }, args.probe === true ? "探测转写模型" : "语音转文字"),
          audio ? h("div", { className: "dss-hint" }, audio.slice(0, 200)) : null,
          h("div", { className: "dss-hint" }, args.probe === true ? "正在探测端点…" : "正在转录…"));
      }
      if (block && block.isError) {
        return h("div", { className: "dss-pending" },
          h("div", { className: "dss-pending-title" }, "转录失败"),
          h("div", { className: "dss-error" }, flattenText(block) || "unknown error"));
      }
      const meta = block && block.meta && typeof block.meta === "object" ? block.meta : null;
      if (!meta) {
        return h("div", { className: "dss-pending" }, h("div", { className: "dss-hint" }, "转录完成。"));
      }
      if (meta.models) {
        return h("div", { className: "dss-card" },
          h("div", { className: "dss-meta" },
            h("span", { className: "dss-chip dss-chipOk" }, "探测完成"),
            h("span", { className: "dss-chip" }, `${meta.models.length} 个转写模型`)),
          h("div", { className: "dss-text" },
            meta.models.length
              ? meta.models.map((m) => `${m.id}${m.status ? ` (${m.status})` : ""}`).join("\n")
              : "未发现转写模型"));
      }
      return h("div", { className: "dss-card" },
        h("div", { className: "dss-meta" },
          h("span", { className: "dss-chip dss-chipOk" }, "转录完成"),
          meta.language ? h("span", { className: "dss-chip" }, String(meta.language)) : null,
          Number.isFinite(Number(meta.durationSeconds)) ? h("span", { className: "dss-chip" }, `${Number(meta.durationSeconds)}s`) : null,
          meta.model ? h("span", { className: "dss-chip" }, String(meta.model)) : null,
          Number.isFinite(Number(meta.elapsedSeconds)) ? h("span", { className: "dss-chip" }, `耗时 ${Number(meta.elapsedSeconds)}s`) : null,
          meta.converted ? h("span", { className: "dss-chip dss-chipWarn" }, "已转码") : null),
        h("div", { className: "dss-text" }, String(meta.preview || "")),
        meta.audioPath ? h("div", { className: "dss-path" }, String(meta.audioPath)) : null,
        h("div", { className: "dss-actions" },
          typeof openFile === "function" && meta.audioPath
            ? h("button", { className: "dss-btn", type: "button", onClick: () => openFile(meta.audioPath) }, "打开音频")
            : null,
          typeof openFile === "function" && meta.transcriptPath
            ? h("button", { className: "dss-btn", type: "button", onClick: () => openFile(meta.transcriptPath) }, "打开文本")
            : null));
    }
    //#endregion

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          {
            name: "plugins.row.config",
            key: "dsh-stt#dsh-stt",
          },
          (slotProps) =>
            slotProps && slotProps.view === "summary"
              ? summaryText()
              : h(SettingsCard, null)
        )
      );
      ctx.slots.inject("tool.call.toolview", () =>
        ctx.slots.register(
          {
            name: "tool.call.toolview",
            key: "stt_transcribe",
            priority: -10,
          },
          SttToolView
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
