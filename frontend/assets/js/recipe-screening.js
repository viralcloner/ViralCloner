// Shared optional screening for workflows and Spy Manager, including retained views.
(() => {
  // Page fragments also load this helper when the shell predates its addition.
  // Keep the shared setting and readiness promise across navigation.
  if (window.RecipeScreening) return;

  const key = "recipeDetectionSettings";
  let enabled = false;
  const escape = (value) => String(value).replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const t = (name, fallback) => window.I18n?.t(`workflows.recipe_detection.${name}`) || fallback;

  function badge(post) {
    if (!enabled) return "";
    const findings = window.RecipeDetector.detectPost(post);
    if (!findings.length) return "";
    const details = findings.map(({ category, ingredient }) =>
      `${t(category, category === "pork" ? "Pork ingredient" : "Alcohol ingredient")}: ${ingredient}`).join("; ");
    const explanation = `${t("detected", "Flagged ingredients")}: ${details}. ${t("hint", "Automatic ingredient screening. Review the recipe; no badge does not confirm halal status.")}`;
    return `<span class="recipe-haram-badge" tabindex="0" title="${escape(explanation)}" aria-label="${escape(explanation)}"><i class="material-icons" aria-hidden="true">warning</i><span>${escape(t("badge", "Haram"))}</span></span>`;
  }

  function refresh(root) {
    root?.querySelectorAll(".recipe-screening").forEach(element => {
      try {
        element.innerHTML = badge(JSON.parse(decodeURIComponent(element.dataset.recipeContent)));
      } catch {
        element.textContent = "";
      }
    });
  }

  function setEnabled(value) {
    enabled = value === true;
    refresh(document);
    // Copy-paste output can be detached while the user visits Settings.
    refresh(window.copypasteState?.$element?.[0]);
  }

  function render(post) {
    // Retain only content, allowing existing cards to update when the switch changes.
    const content = {};
    for (const field of ["postMessage", "title", "text", "description", "ingredients", "instructions"]) {
      if (typeof post?.[field] === "string") content[field] = post[field];
    }
    for (const platform of ["facebookOutput", "pinterestOutput"]) {
      if (!post?.[platform]) continue;
      content[platform] = {};
      for (const field of ["title", "text", "description"]) {
        if (typeof post[platform][field] === "string") content[platform][field] = post[platform][field];
      }
    }
    return `<span class="recipe-screening" data-recipe-content="${escape(encodeURIComponent(JSON.stringify(content)))}">${badge(content)}</span>`;
  }

  const ready = Promise.resolve().then(() => window.electronAPI.readKey(key)).then(settings => {
    setEnabled(settings?.enabled);
  }).catch(error => {
    console.warn("[RecipeScreening] Could not load settings:", error);
    setEnabled(false);
  });

  window.RecipeScreening = {
    ready, render, badge, refresh,
    get enabled() { return enabled; },
    async save(value) {
      await ready;
      await window.electronAPI.updateData(key, { enabled: value === true });
      setEnabled(value);
    },
  };
})();
