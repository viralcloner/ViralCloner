(function () {
  const NS = ".aiTextHumanizer";
  const MAX_CHARS = 50000;
  const MIN_WORDS = 30;
  let isProcessing = false;
  let isScoring = false;
  let disposed = false;

  const t = (key, fallback) => window.I18n?.t(key) || fallback;

  function wordCount(text) {
    const trimmed = String(text || "").trim();
    return trimmed ? trimmed.split(/\s+/u).length : 0;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString(window.I18n?.getLocale?.() || "en");
  }

  function formatScore(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
      ? numericValue.toLocaleString(window.I18n?.getLocale?.() || "en", {
        useGrouping: false,
        maximumFractionDigits: 2,
      })
      : String(value);
  }

  function updateCounts() {
    const input = $("#ath-input").val() || "";
    const output = $("#ath-output").val() || "";
    $("#ath-input-words").contents().first()[0].textContent = `${formatNumber(wordCount(input))} `;
    $("#ath-input-chars").text(`${formatNumber(input.length)} / ${formatNumber(MAX_CHARS)}`);
    $("#ath-output-words").contents().first()[0].textContent = `${formatNumber(wordCount(output))} `;
    const actionsDisabled = isProcessing || isScoring || wordCount(input) < MIN_WORDS;
    $("#ath-humanize, #ath-check-originality").prop("disabled", actionsDisabled);
  }

  function handleInput() {
    $("#ath-input-originality-score").prop("hidden", true).find("span").text("");
    updateCounts();
  }

  function setStatus(type, label) {
    const $status = $("#ath-status");
    $status.removeClass("is-processing is-success is-error");
    if (type) $status.addClass(`is-${type}`);
    $status.find("span:last").text(label);
  }

  function setProcessing(processing) {
    isProcessing = processing;
    $("#ath-humanize").toggleClass("is-loading", processing);
    $("#ath-input, #ath-clear, #ath-auto-retry, #ath-check-originality").prop("disabled", processing);
    $("#ath-max-attempts").prop("disabled", processing || !$("#ath-auto-retry").prop("checked"));
    updateCounts();
    setStatus(
      processing ? "processing" : "",
      processing
        ? t("text_humanizer.processing", "Humanizing...")
        : t("text_humanizer.ready", "Ready"),
    );
  }

  async function checkOriginality() {
    const text = String($("#ath-input").val() || "").trim();
    if (!text || isProcessing || isScoring) return;
    if (wordCount(text) < MIN_WORDS) {
      showMessage(t("text_humanizer.minimum_words", "Enter at least 30 words."), "error");
      return;
    }

    isScoring = true;
    $("#ath-message").hide();
    $("#ath-input, #ath-clear, #ath-auto-retry, #ath-humanize, #ath-check-originality").prop("disabled", true);
    $("#ath-max-attempts").prop("disabled", true);
    setStatus("processing", t("text_humanizer.checking_originality", "Checking originality..."));

    try {
      const result = await window.electronAPI.scoreAiText(text);
      if (disposed) return;
      if (!result?.success) {
        throw new Error(result?.error || t("text_humanizer.score_error", "The originality score could not be checked."));
      }
      const score = result.originalityScore;
      $("#ath-input-originality-score")
        .prop("hidden", false)
        .find("span")
        .text(`${t("text_humanizer.originality_score", "Originality score")}: ${formatScore(score)}%`);
      setStatus("success", t("text_humanizer.complete", "Complete"));
      showMessage(t("text_humanizer.score_success", "Originality score checked."), "success");
    } catch (error) {
      if (disposed) return;
      setStatus("error", t("text_humanizer.failed", "Failed"));
      showMessage(error.message || t("text_humanizer.score_error", "The originality score could not be checked."), "error");
    } finally {
      if (!disposed) {
        isScoring = false;
        $("#ath-input, #ath-clear, #ath-auto-retry").prop("disabled", false);
        $("#ath-max-attempts").prop("disabled", !$("#ath-auto-retry").prop("checked"));
        updateCounts();
      }
    }
  }

  function showMessage(message, type) {
    const $message = $("#ath-message");
    $message.stop(true, true).removeClass("is-error is-success").addClass(`is-${type}`).text(message).fadeIn(150);
    window.setTimeout(() => $message.fadeOut(200), 4500);
  }

  function renderResult(result) {
    $("#ath-output").val(result.text || "");
    $("#ath-output-empty").toggle(!result.text);
    $("#ath-copy").prop("disabled", !result.text);

    const language = String(result.language || "").replace(/_/g, " ");
    $("#ath-language")
      .text(language ? `${t("text_humanizer.language", "Language")}: ${language}` : "")
      .toggle(Boolean(language));

    const exactScore = result.finalAiScore ?? result.aiScore;
    const hasScore = exactScore !== null && exactScore !== undefined && exactScore !== "";
    $("#ath-score")
      .prop("hidden", !hasScore)
      .find("span")
      .text(hasScore ? `${t("text_humanizer.ai_score", "AI score")}: ${formatScore(exactScore)}%` : "");

    const originalityScore = result.originalityScore;
    const hasOriginalityScore = originalityScore !== null
      && originalityScore !== undefined
      && originalityScore !== "";
    $("#ath-originality-score")
      .prop("hidden", !hasOriginalityScore)
      .find("span")
      .text(hasOriginalityScore
        ? `${t("text_humanizer.originality_score", "Originality score")}: ${formatScore(originalityScore)}%`
        : "");

    const attemptCount = Number(result.attemptCount || 1);
    $("#ath-attempt-count")
      .text(`${t("text_humanizer.attempts_used", "Attempts")}: ${attemptCount}`)
      .toggle(attemptCount > 1);
    updateCounts();
  }

  async function humanize() {
    const text = String($("#ath-input").val() || "").trim();
    if (!text || isProcessing) return;
    if (wordCount(text) < MIN_WORDS) {
      showMessage(t("text_humanizer.minimum_words", "Enter at least 30 words."), "error");
      return;
    }

    $("#ath-message").hide();
    setProcessing(true);
    try {
      const autoRetry = $("#ath-auto-retry").prop("checked");
      const maxAttempts = autoRetry ? Number($("#ath-max-attempts").val() || 6) : 1;
      const result = await window.electronAPI.humanizeAiText(text, { maxAttempts });
      if (disposed) return;
      if (!result?.success) {
        console.error("[AITextHumanizer] Failed result:", JSON.stringify(result || {}));
        throw new Error(result?.error || t("text_humanizer.error", "The text could not be humanized."));
      }
      renderResult(result);
      setStatus("success", t("text_humanizer.complete", "Complete"));
      showMessage(t("text_humanizer.success", "Text humanized successfully."), "success");
    } catch (error) {
      if (disposed) return;
      setStatus("error", t("text_humanizer.failed", "Failed"));
      showMessage(error.message || t("text_humanizer.error", "The text could not be humanized."), "error");
    } finally {
      if (!disposed) {
        isProcessing = false;
        $("#ath-humanize").removeClass("is-loading");
        $("#ath-input, #ath-clear, #ath-auto-retry").prop("disabled", false);
        $("#ath-max-attempts").prop("disabled", !$("#ath-auto-retry").prop("checked"));
        updateCounts();
      }
    }
  }

  async function copyResult() {
    const text = String($("#ath-output").val() || "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showMessage(t("text_humanizer.copied", "Copied to clipboard."), "success");
    } catch {
      const output = document.getElementById("ath-output");
      output.select();
      document.execCommand("copy");
      showMessage(t("text_humanizer.copied", "Copied to clipboard."), "success");
    }
  }

  $(document).off(NS);
  $(document).on("input" + NS, "#ath-input", handleInput);
  $(document).on("click" + NS, "#ath-humanize", humanize);
  $(document).on("click" + NS, "#ath-check-originality", checkOriginality);
  $(document).on("change" + NS, "#ath-auto-retry", function () {
    $("#ath-max-attempts").prop("disabled", isProcessing || !this.checked);
  });
  $(document).on("click" + NS, "#ath-copy", copyResult);
  $(document).on("click" + NS, "#ath-clear", function () {
    $("#ath-input, #ath-output").val("");
    $("#ath-output-empty").show();
    $("#ath-copy").prop("disabled", true);
    $("#ath-score, #ath-originality-score, #ath-input-originality-score").prop("hidden", true).find("span").text("");
    $("#ath-result-meta span").hide().text("");
    $("#ath-message").hide();
    setStatus("", t("text_humanizer.ready", "Ready"));
    updateCounts();
    $("#ath-input").trigger("focus");
  });
  $(document).on("keydown" + NS, "#ath-input", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      humanize();
    }
  });

  window.currentPageCleanup = function () {
    disposed = true;
    $(document).off(NS);
    window.currentPageCleanup = null;
  };

  updateCounts();
  $("#ath-input").trigger("focus");
})();
