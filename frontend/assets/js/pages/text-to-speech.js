(() => {
  const ns = ".textToSpeechTool";
  const t = key => window.I18n.t("tts_tool." + key);
  let voices = [], disposed = false, busy = false, saving = false;
  const $root = $(".tts-tool");
  const el = id => document.getElementById("tts-" + id);
  function status(key) { if (!disposed) $("#tts-status").text(key ? t(key) : ""); }
  function update() {
    if (disposed) return;
    const text = el("text").value;
    $("#tts-count").text(`${text.length.toLocaleString()} / ${(10000).toLocaleString()}`);
    $("#tts-generate").prop("disabled", busy || saving || !text.trim() || !el("voice").value).text(t(busy ? "working" : "generate"));
    $("#tts-preview").prop("disabled", busy || !el("voice").value);
    $("#tts-language, #tts-search, #tts-voice").prop("disabled", busy || !voices.length);
    $("#tts-clear").prop("disabled", busy || !text.length);
    $("#tts-save").prop("disabled", busy || saving);
    $root.attr("aria-busy", String(busy));
  }
  function renderVoices(preferred) {
    el("sample").pause();
    el("sample").hidden = true;
    const previous = preferred || el("voice").value;
    const query = el("search").value.trim().toLowerCase();
    const list = voices.filter(v => v.Locale === el("language").value &&
      `${v.FriendlyName} ${v.ShortName} ${v.Gender}`.toLowerCase().includes(query));
    el("voice").replaceChildren(...list.map(v => new Option(
      `${v.FriendlyName || v.ShortName} - ${t(v.Gender === "Female" ? "female" : "male")}`, v.ShortName)));
    if (list.some(v => v.ShortName === previous)) el("voice").value = previous;
    else if (list.length) el("voice").selectedIndex = 0;
    status(list.length ? "" : "no_voices");
    update();
  }
  async function loadVoices() {
    busy = true; update(); status("loading"); $("#tts-retry").prop("hidden", true);
    try {
      const result = await window.electronAPI.getTTSVoices();
      if (disposed) return;
      voices = Array.isArray(result) ? result.filter(v => v.ShortName && v.Locale) : [];
      if (!voices.length) throw new Error("No voices");
      const locales = [...new Set(voices.map(v => v.Locale))].sort();
      let names;
      try { names = new Intl.DisplayNames([document.documentElement.lang || navigator.language], { type: "language" }); } catch (_) {}
      el("language").replaceChildren(...locales.map(locale => {
        let label = locale;
        try { label = names?.of(locale) || locale; } catch (_) {}
        return new Option(`${label} (${locale})`, locale);
      }));
      const preferred = "en-US";
      el("language").value = locales.find(l => l === preferred) || locales.find(l => l.split("-")[0] === preferred.split("-")[0]) || locales[0];
      renderVoices("en-US-EmmaMultilingualNeural");
    } catch (_) {
      if (!disposed) { status("voices_failed"); $("#tts-retry").prop("hidden", false); }
    } finally { busy = false; update(); }
  }
  async function generate(preview) {
    if (busy || !el("voice").value) return;
    const voice = el("voice").value;
    const label = el("voice").selectedOptions[0].text;
    const text = preview ? (el("text").value.trim().slice(0, 200) || t("sample")) : el("text").value;
    busy = true; update(); status(preview ? "preview_loading" : "generating");
    el("audio").pause(); el("sample").pause();
    try {
      const result = await window.electronAPI.generateTTSAudio({ text, voice, preview });
      if (disposed) return;
      if (!result.success) { status(result.error || "generation_failed"); return; }
      const player = el(preview ? "sample" : "audio");
      player.src = result.audioUrl;
      if (preview) {
        player.hidden = false;
        player.play().catch(() => {});
      } else {
        $("#tts-result").prop("hidden", false);
        $("#tts-result-voice").text(label);
      }
      status(preview ? "" : "ready");
    } catch (_) { status("generation_failed"); }
    finally { busy = false; update(); }
  }
  $(document).on("input" + ns, "#tts-text", update)
    .on("input" + ns, "#tts-search", () => renderVoices())
    .on("change" + ns, "#tts-language", () => { el("search").value = ""; renderVoices(); })
    .on("change" + ns, "#tts-voice", () => { el("sample").pause(); el("sample").hidden = true; update(); })
    .on("click" + ns, "#tts-clear", () => { el("text").value = ""; update(); el("text").focus(); })
    .on("click" + ns, "#tts-preview", () => generate(true))
    .on("click" + ns, "#tts-generate", () => generate(false))
    .on("click" + ns, "#tts-retry", loadVoices)
    .on("click" + ns, "#tts-save", async () => {
      if (saving || busy) return;
      saving = true; update();
      try {
        const result = await window.electronAPI.saveTTSAudio();
        if (!result.canceled) status(result.success ? "saved" : result.error || "save_failed");
      } catch (_) { status("save_failed"); }
      finally { saving = false; update(); }
    });
  window.currentPageCleanup = () => {
    disposed = true;
    [el("audio"), el("sample")].forEach(audio => { if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); } });
    $(document).off(ns);
    window.currentPageCleanup = null;
  };
  loadVoices();
})();
