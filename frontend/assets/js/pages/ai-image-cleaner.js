(function () {
  const NS = '.aiImageCleaner';

  // ── State ──────────────────────────────────────────────────────────────────
  let originalBuffer   = null;   // ArrayBuffer of the imported image
  let originalFileName = '';
  let cleanedBuffer    = null;   // ArrayBuffer of the cleaned result
  let cleanedFormat    = '';

  // Batch state
  let batchFiles  = [];   // Array of { name, buffer, status, cleanedBuffer, cleanedFormat }
  let isBatchMode = false;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getOptions() {
    return {
      stripMetadata : $('#opt-strip-metadata').is(':checked'),
      perturbPixels : $('#opt-perturb-pixels').is(':checked'),
      microCrop     : $('#opt-micro-crop').is(':checked'),
      humanize      : $('#opt-humanize').is(':checked'),
      injectMetadata: $('#opt-inject-exif').is(':checked') ? {
        enabled : true,
        preset  : $('#opt-device-preset').val()
      } : null,
      forceFormat   : $('#opt-format').val() || null,
      quality       : parseInt($('#opt-quality').val(), 10)
    };
  }

  function setStatus(type, errorMsg) {
    $('#aic-status-idle, #aic-status-processing, #aic-status-done, #aic-status-error')
      .hide();
    if (type === 'idle')       $('#aic-status-idle').show();
    else if (type === 'processing') $('#aic-status-processing').show();
    else if (type === 'done')  $('#aic-status-done').show();
    else if (type === 'error') {
      $('#aic-status-error-msg').text(errorMsg || '');
      $('#aic-status-error').show();
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function getImageDimensions(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = dataUrl;
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Patterns that suggest AI-generated content
  // Keys: field names that are inherently AI-related
  const AI_KEY_RE  = /c2pa|jumd|synthid|claim.*gen|generator.*info|openai|dalle|midjourney|gemini|gpt|firefly|stability|adobe.*ai|software.*agent|digital.*source.*type/i;
  // Values: strings that reveal AI origin even inside nested/flattened fields
  const AI_VAL_RE  = /openai|dall.e|midjourney|gemini|\bgpt\b|gpt-|sora|stable.diffusion|adobe.firefly|trainedAlgorithmicMedia|trained.*algorithm|algorithmic.*media|c2pa|synthid|media.service.api|content.credential|iptc.*digitalsource|cv\.iptc\.org.*digitalsource/i;

  async function buildMetaHtml(buffer) {
    const uint8 = new Uint8Array(buffer);

    // Show a loading placeholder immediately, fill async
    // (caller sets innerHTML before awaiting)
    let tags = {};
    try {
      const result = await window.electronAPI.readImageMetadata(Array.from(uint8));
      if (result && result.success) tags = result.tags || {};
    } catch (e) {
      console.warn('[AIC] readImageMetadata failed:', e.message);
    }

    const entries = Object.entries(tags);

    if (entries.length === 0) {
      // Fallback from magic bytes
      let fmt = 'Unknown';
      if (uint8[0] === 0xFF && uint8[1] === 0xD8) fmt = 'JPEG';
      else if (uint8[0] === 0x89 && uint8[1] === 0x50) fmt = 'PNG';
      else if (uint8[0] === 0x52 && uint8[1] === 0x49) fmt = 'WebP';
      else if (uint8[0] === 0x47 && uint8[1] === 0x49) fmt = 'GIF';
      return `<div class="aic-meta-row"><span class="aic-meta-key">Format</span><span class="aic-meta-val">${fmt}</span></div>
              <div class="aic-meta-row"><span class="aic-meta-key">Size</span><span class="aic-meta-val">${formatBytes(buffer.byteLength)}</span></div>`;
    }

    const aiEntries = entries.filter(([k, v]) => AI_KEY_RE.test(k) || AI_VAL_RE.test(v));
    const aiCount   = aiEntries.length;

    const foundLabel = window.I18n?.t('ai_cleaner.meta_ai_found') || 'AI-related metadata fields found';
    const cleanLabel = window.I18n?.t('ai_cleaner.meta_ai_clean') || 'No AI-related metadata found';
    const badge = aiCount > 0
      ? `<div class="aic-meta-badge aic-meta-badge-warn"><i class="material-icons">warning</i> ${aiCount} ${foundLabel}</div>`
      : `<div class="aic-meta-badge aic-meta-badge-clean"><i class="material-icons">verified</i> ${cleanLabel}</div>`;

    const countBar = `<div class="aic-meta-count">${entries.length} metadata fields</div>`;

    const rows = entries.map(([k, v]) => {
      const isAi      = AI_KEY_RE.test(k) || AI_VAL_RE.test(v);
      const dispVal   = v.length > 140 ? v.substring(0, 140) + '…' : v;
      return `<div class="aic-meta-row${isAi ? ' aic-meta-ai' : ''}" title="${escapeHtml(k)}: ${escapeHtml(v)}">
        <span class="aic-meta-key">${escapeHtml(k)}</span>
        <span class="aic-meta-val">${escapeHtml(dispVal)}</span>
      </div>`;
    }).join('');

    return badge + countBar + rows;
  }

  function renderTechniquesList(options) {
    const items = [];
    if (options.stripMetadata) items.push({
      icon: 'delete_sweep',
      text: window.I18n?.t('ai_cleaner.tech_strip') || 'Metadata stripped (EXIF, XMP, IPTC, C2PA)'
    });
    if (options.perturbPixels) items.push({
      icon: 'blur_on',
      text: window.I18n?.t('ai_cleaner.tech_perturb') || 'Light pixel resampling applied (blur+sharpen)'
    });
    if (options.microCrop) items.push({
      icon: 'crop',
      text: window.I18n?.t('ai_cleaner.tech_crop') || 'Pixel grid shifted (micro-crop+resize)'
    });
    if (options.humanize) items.push({
      icon: 'camera',
      text: window.I18n?.t('ai_cleaner.tech_humanize') || 'Camera realism applied (FFT scramble, aberration, vignette, sensor noise)'
    });
    if (options.injectMetadata?.enabled) items.push({
      icon: 'phone_iphone',
      text: (window.I18n?.t('ai_cleaner.tech_exif') || 'Simulated device EXIF added') + ' (' + options.injectMetadata.preset + ')'
    });
    items.push({
      icon: 'loop',
      text: window.I18n?.t('ai_cleaner.tech_reencode') || 'Image re-encoded (byte-level changes)'
    });

    const html = items.map(item =>
      `<div class="aic-technique-row"><i class="material-icons">${item.icon}</i><span>${item.text}</span></div>`
    ).join('');
    $('#aic-techniques-list').html(html);
    $('#aic-techniques-section').show();
  }

  // ── Load a single image ───────────────────────────────────────────────────

  async function loadImage(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      originalBuffer   = e.target.result;  // ArrayBuffer
      originalFileName = file.name;
      cleanedBuffer    = null;
      cleanedFormat    = '';

      // Show before preview
      const blob = new Blob([originalBuffer]);
      const url  = URL.createObjectURL(blob);
      $('#aic-img-before').attr('src', url).off('load').on('load', () => URL.revokeObjectURL(url));

      // Reset after panel
      $('#aic-img-after').hide();
      $('#aic-img-after-placeholder').show();
      $('#aic-meta-after-section').hide();
      $('#aic-techniques-section').hide();

      // Show compare, hide dropzone
      $('#aic-dropzone').hide();
      $('#aic-compare').show();

      // Populate before meta (show loading, then fill)
      $('#aic-meta-before').html('<div class="aic-meta-loading"><div class="aic-spinner-sm"></div> Reading metadata…</div>');
      $('#aic-meta-before-section').show();
      buildMetaHtml(originalBuffer).then(metaHtml => {
        $('#aic-meta-before').html(metaHtml);
      });

      // Enable process button
      $('#aic-process-btn').prop('disabled', false);
      $('#aic-export-btn').prop('disabled', true);
      setStatus('idle');
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Process single image ──────────────────────────────────────────────────

  async function processSingle() {
    if (!originalBuffer) return;

    const options = getOptions();
    setStatus('processing');
    $('#aic-process-btn').prop('disabled', true);

    try {
      const uint8 = new Uint8Array(originalBuffer);
      const result = await window.electronAPI.cleanAiImage(Array.from(uint8), options);

      if (!result.success) {
        setStatus('error', result.error || 'Unknown error');
        $('#aic-process-btn').prop('disabled', false);
        return;
      }

      // Store cleaned result
      cleanedBuffer = new Uint8Array(result.buffer).buffer;
      cleanedFormat = result.format || 'jpeg';

      // Show after image
      const mimeMap = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
      const mime = mimeMap[cleanedFormat] || 'image/jpeg';
      const blob = new Blob([cleanedBuffer], { type: mime });
      const url  = URL.createObjectURL(blob);
      $('#aic-img-after').attr('src', url)
        .off('load').on('load', () => URL.revokeObjectURL(url))
        .show();
      $('#aic-img-after-placeholder').hide();

      // After meta
      $('#aic-meta-after').html('<div class="aic-meta-loading"><div class="aic-spinner-sm"></div> Reading metadata…</div>');
      $('#aic-meta-after-section').show();
      buildMetaHtml(cleanedBuffer).then(afterHtml => {
        $('#aic-meta-after').html(afterHtml);
      });

      renderTechniquesList(options);
      setStatus('done');

      // Enable export
      $('#aic-export-btn').prop('disabled', false);
    } catch (err) {
      setStatus('error', err.message || 'Processing failed');
    } finally {
      $('#aic-process-btn').prop('disabled', false);
    }
  }

  // ── Export single image ───────────────────────────────────────────────────

  async function exportSingle() {
    if (!cleanedBuffer) return;

    const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp' };
    const ext = extMap[cleanedFormat] || 'jpg';
    const baseName = originalFileName.replace(/\.[^.]+$/, '') || 'cleaned';
    const saveName = `${baseName}_cleaned.${ext}`;

    const uint8   = new Uint8Array(cleanedBuffer);
    const result  = await window.electronAPI.saveCleanedImage(saveName, Array.from(uint8));
    if (result && result.success) {
      const msg = window.I18n?.t('ai_cleaner.export_success') || 'Image saved successfully';
      showAlert('success', msg);
    } else if (result && result.cancelled) {
      // user cancelled dialog, no-op
    } else {
      showAlert('error', (result && result.error) || 'Failed to save image');
    }
  }

  // ── Batch helpers ─────────────────────────────────────────────────────────

  function renderBatchList() {
    const html = batchFiles.map((f, i) => {
      let statusHtml = '';
      if (f.status === 'pending')    statusHtml = `<span class="aic-batch-badge pending"><i class="material-icons">schedule</i> Pending</span>`;
      else if (f.status === 'processing') statusHtml = `<span class="aic-batch-badge processing"><div class="aic-spinner-sm"></div> Processing</span>`;
      else if (f.status === 'done')  statusHtml = `<span class="aic-batch-badge done"><i class="material-icons">check_circle</i> Done</span>`;
      else if (f.status === 'error') statusHtml = `<span class="aic-batch-badge error"><i class="material-icons">error</i> Error</span>`;

      return `<div class="aic-batch-item" data-index="${i}">
        <i class="material-icons aic-batch-icon">image</i>
        <div class="aic-batch-name">${f.name}</div>
        ${statusHtml}
        <button class="aic-batch-remove" data-index="${i}" title="Remove"><i class="material-icons">close</i></button>
      </div>`;
    }).join('');

    $('#aic-batch-list').html(html || `<div class="aic-batch-empty" data-i18n="ai_cleaner.batch_empty">No images added yet</div>`);
    if (window.I18n) window.I18n.translatePage(document.getElementById('aic-batch-list'));
  }

  async function processBatch() {
    if (!batchFiles.length) return;

    const options = getOptions();
    $('#aic-batch-process-btn').prop('disabled', true);
    $('#aic-batch-export-btn').prop('disabled', true);
    $('#aic-batch-progress-section').show();
    setStatus('processing');

    let done = 0;
    const total = batchFiles.length;

    for (let i = 0; i < batchFiles.length; i++) {
      batchFiles[i].status = 'processing';
      renderBatchList();

      try {
        const uint8 = new Uint8Array(batchFiles[i].buffer);
        const result = await window.electronAPI.cleanAiImage(Array.from(uint8), options);

        if (result.success) {
          batchFiles[i].cleanedBuffer = new Uint8Array(result.buffer).buffer;
          batchFiles[i].cleanedFormat = result.format || 'jpeg';
          batchFiles[i].status = 'done';
        } else {
          batchFiles[i].status = 'error';
        }
      } catch (e) {
        batchFiles[i].status = 'error';
      }

      done++;
      const pct = Math.round((done / total) * 100);
      $('#aic-progress-fill').css('width', pct + '%');
      $('#aic-progress-label').text(`${done} / ${total}`);
      renderBatchList();
    }

    setStatus('done');
    $('#aic-batch-process-btn').prop('disabled', false);

    const anyDone = batchFiles.some(f => f.status === 'done');
    $('#aic-batch-export-btn').prop('disabled', !anyDone);
  }

  async function exportBatch() {
    const done = batchFiles.filter(f => f.status === 'done' && f.cleanedBuffer);
    if (!done.length) return;

    const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp' };

    for (const f of done) {
      const ext      = extMap[f.cleanedFormat] || 'jpg';
      const baseName = f.name.replace(/\.[^.]+$/, '') || 'cleaned';
      const saveName = `${baseName}_cleaned.${ext}`;
      const uint8    = new Uint8Array(f.cleanedBuffer);
      await window.electronAPI.saveCleanedImage(saveName, Array.from(uint8));
    }

    const msg = window.I18n?.t('ai_cleaner.batch_export_success') || `${done.length} images saved`;
    showAlert('success', msg);
  }

  // ── Switch between single / batch tab ────────────────────────────────────

  function showSingle() {
    isBatchMode = false;
    $('#aic-single-view').show();
    $('#aic-batch-view').hide();
    $('#aic-process-btn').show();
    $('#aic-batch-process-btn').hide();
    $('#aic-batch-progress-section').hide();
    $('#tab-single').addClass('active');
    $('#tab-batch').removeClass('active');
    // Batch export only relevant in batch mode
    $('#aic-batch-export-btn').hide();
    $('#aic-export-btn').show();
    $('#aic-batch-import-btn').show();
    $('#aic-import-btn').show();
  }

  function showBatch() {
    isBatchMode = true;
    $('#aic-single-view').hide();
    $('#aic-batch-view').show();
    $('#aic-process-btn').hide();
    $('#aic-batch-process-btn').show().prop('disabled', !batchFiles.length);
    $('#tab-single').removeClass('active');
    $('#tab-batch').addClass('active');
    $('#aic-batch-export-btn').show();
    $('#aic-export-btn').hide();
    renderBatchList();
  }

  // ── Drag & drop on dropzone ───────────────────────────────────────────────

  function initDragDrop() {
    const zone = document.getElementById('aic-dropzone');
    if (!zone) return;

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        if (isBatchMode) {
          addToBatch([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
        } else {
          loadImage(file);
        }
      }
    });
    zone.addEventListener('click', () => {
      if (!isBatchMode) $('#aic-file-input').click();
    });
  }

  function addToBatch(files) {
    let added = 0;
    const readers = files.map(file => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        batchFiles.push({ name: file.name, buffer: e.target.result, status: 'pending' });
        added++;
        resolve();
      };
      reader.readAsArrayBuffer(file);
    }));
    Promise.all(readers).then(() => {
      renderBatchList();
      if (batchFiles.length > 0) {
        $('#aic-batch-process-btn').prop('disabled', false);
      }
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  $(document).on('click' + NS, '#aic-import-btn', () => $('#aic-file-input').click());
  $(document).on('click' + NS, '#aic-batch-import-btn', () => {
    if (isBatchMode) {
      $('#aic-file-input-batch').click();
    } else {
      // Switch to batch mode and open picker
      showBatch();
      $('#aic-file-input-batch').click();
    }
  });

  $(document).on('change' + NS, '#aic-file-input', function () {
    if (this.files && this.files[0]) loadImage(this.files[0]);
    this.value = ''; // reset so same file can be re-imported
  });

  $(document).on('change' + NS, '#aic-file-input-batch', function () {
    if (this.files && this.files.length) addToBatch([...this.files]);
    this.value = '';
  });

  $(document).on('click' + NS, '#aic-process-btn',       processSingle);
  $(document).on('click' + NS, '#aic-export-btn',        exportSingle);
  $(document).on('click' + NS, '#aic-batch-process-btn', processBatch);
  $(document).on('click' + NS, '#aic-batch-export-btn',  exportBatch);

  $(document).on('click' + NS, '#tab-single', showSingle);
  $(document).on('click' + NS, '#tab-batch',  showBatch);

  // Quality slider
  $(document).on('input' + NS, '#opt-quality', function () {
    $('#aic-quality-val').text($(this).val());
  });

  // Toggle device preset sub-option
  $(document).on('change' + NS, '#opt-inject-exif', function () {
    $('#aic-device-options').toggle($(this).is(':checked'));
  });

  // Remove a batch item
  $(document).on('click' + NS, '.aic-batch-remove', function (e) {
    e.stopPropagation();
    const idx = parseInt($(this).data('index'), 10);
    batchFiles.splice(idx, 1);
    renderBatchList();
    if (!batchFiles.length) $('#aic-batch-process-btn').prop('disabled', true);
  });

  initDragDrop();
  setStatus('idle');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  $(document).one('page-unload' + NS, function () {
    $(document).off(NS);
  });
})();
