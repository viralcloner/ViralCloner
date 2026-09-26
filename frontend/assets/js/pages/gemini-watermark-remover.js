(function () {
  const NS = '.geminiWatermarkRemover';

  // ── State ──────────────────────────────────────────────────────────────────
  let originalBuffer = null;   // ArrayBuffer of imported image
  let originalFileName = '';
  let cleanedBuffer = null;    // ArrayBuffer of cleaned result (PNG)
  let isBatchMode = false;

  // Batch: array of { name, buffer, status, cleanedBuffer }
  let batchFiles = [];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function t(key, fallback) {
    return (window.I18n && window.I18n.t(key)) || fallback;
  }

  function formatBytes(bytes) {
    if (!bytes) return '\u2014';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function getImageDimensions(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = url;
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(type, msg) {
    const $s = $('#gwr-status');
    $s.removeClass('gwr-status-idle gwr-status-processing gwr-status-done gwr-status-error');
    if (type === 'processing') {
      $s.addClass('gwr-status-processing')
        .html('<div class="gwr-spinner"></div><span>' + escapeHtml(msg || t('gwr.status_processing', 'Removing watermark\u2026')) + '</span>');
    } else if (type === 'done') {
      $s.addClass('gwr-status-done')
        .html('<i class="material-icons">check_circle</i><span>' + escapeHtml(msg || t('gwr.status_done', 'Watermark removed')) + '</span>');
    } else if (type === 'error') {
      $s.addClass('gwr-status-error')
        .html('<i class="material-icons">error</i><span>' + escapeHtml(msg || t('gwr.status_error', 'Failed')) + '</span>');
    } else {
      $s.addClass('gwr-status-idle')
        .html('<i class="material-icons">radio_button_unchecked</i><span>' + escapeHtml(t('gwr.status_idle', 'Ready')) + '</span>');
    }
  }

  // ── Single image load ────────────────────────────────────────────────────

  function loadImage(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      originalBuffer = e.target.result;
      originalFileName = file.name;
      cleanedBuffer = null;

      const blob = new Blob([originalBuffer]);
      const url = URL.createObjectURL(blob);
      $('#gwr-img-before').attr('src', url);

      const dims = await getImageDimensions(url);
      $('#gwr-info-before').text(
        `${dims.w}\u00d7${dims.h} \u2022 ${formatBytes(originalBuffer.byteLength)}`
      );

      // Reset after panel
      $('#gwr-img-after').hide().attr('src', '');
      $('#gwr-img-after-placeholder').show();
      $('#gwr-info-after').text('');

      $('#gwr-dropzone').hide();
      $('#gwr-compare').show();
      $('#gwr-action-row').show();

      $('#gwr-process-btn').prop('disabled', false);
      $('#gwr-export-btn').prop('disabled', true);
      setStatus('idle');
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Process single ─────────────────────────────────────────────────────────

  async function processSingle() {
    if (!originalBuffer) return;
    setStatus('processing');
    $('#gwr-process-btn').prop('disabled', true);

    try {
      const uint8 = new Uint8Array(originalBuffer);
      const result = await window.electronAPI.removeGeminiWatermark(Array.from(uint8));

      if (!result || !result.success) {
        throw new Error((result && result.error) || 'Unknown error');
      }

      cleanedBuffer = new Uint8Array(result.buffer).buffer;
      const blob = new Blob([cleanedBuffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob);

      $('#gwr-img-after-placeholder').hide();
      $('#gwr-img-after').attr('src', url).show();

      const dims = await getImageDimensions(url);
      $('#gwr-info-after').text(
        `${dims.w}\u00d7${dims.h} \u2022 ${formatBytes(cleanedBuffer.byteLength)}`
      );

      $('#gwr-export-btn').prop('disabled', false);
      setStatus('done', result.applied
        ? t('gwr.status_done', 'Watermark removed')
        : t('gwr.status_none', 'No watermark detected'));
    } catch (err) {
      console.error('[GWR] processSingle error:', err);
      setStatus('error', err.message);
      $('#gwr-process-btn').prop('disabled', false);
    }
  }

  // ── Export single ──────────────────────────────────────────────────────────

  async function exportSingle() {
    if (!cleanedBuffer) return;
    const baseName = (originalFileName || 'image').replace(/\.[^.]+$/, '');
    const saveName = `${baseName}_nowatermark.png`;
    const uint8 = new Uint8Array(cleanedBuffer);
    try {
      const result = await window.electronAPI.saveCleanedImage(saveName, Array.from(uint8));
      if (result && result.success) {
        if (window.showAlert) window.showAlert('success', t('gwr.export_success', 'Image saved'));
      }
    } catch (err) {
      console.error('[GWR] exportSingle error:', err);
      if (window.showAlert) window.showAlert('error', err.message);
    }
  }

  // ── Batch ──────────────────────────────────────────────────────────────────

  function addToBatch(files) {
    const imageFiles = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    let pending = imageFiles.length;
    if (!pending) return;

    imageFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        batchFiles.push({
          name: file.name,
          buffer: e.target.result,
          status: 'idle',
          cleanedBuffer: null,
        });
        pending--;
        if (pending === 0) {
          renderBatchList();
          $('#gwr-batch-process-btn').prop('disabled', batchFiles.length === 0);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function renderBatchList() {
    if (!batchFiles.length) {
      $('#gwr-batch-list').html(
        `<div class="gwr-batch-empty">${escapeHtml(t('gwr.batch_empty', 'No images added yet.'))}</div>`
      );
      return;
    }

    const html = batchFiles.map((item, idx) => {
      const blob = new Blob([item.buffer]);
      const url = URL.createObjectURL(blob);
      let statusBadge = '';
      if (item.status === 'done') {
        statusBadge = `<span class="gwr-batch-badge done"><i class="material-icons">check_circle</i></span>`;
      } else if (item.status === 'processing') {
        statusBadge = `<span class="gwr-batch-badge processing"><div class="gwr-spinner-sm"></div></span>`;
      } else if (item.status === 'error') {
        statusBadge = `<span class="gwr-batch-badge error"><i class="material-icons">error</i></span>`;
      } else {
        statusBadge = `<span class="gwr-batch-badge idle"><i class="material-icons">radio_button_unchecked</i></span>`;
      }
      return `
        <div class="gwr-batch-item">
          <img class="gwr-batch-thumb" src="${url}" alt="">
          <div class="gwr-batch-meta">
            <span class="gwr-batch-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="gwr-batch-size">${formatBytes(item.buffer.byteLength)}</span>
          </div>
          ${statusBadge}
          <button class="gwr-batch-remove" data-index="${idx}" title="${escapeHtml(t('gwr.remove', 'Remove'))}">
            <i class="material-icons">close</i>
          </button>
        </div>`;
    }).join('');
    $('#gwr-batch-list').html(html);
  }

  async function processBatch() {
    if (!batchFiles.length) return;
    $('#gwr-batch-process-btn').prop('disabled', true);
    $('#gwr-batch-progress').show();

    let done = 0;
    const total = batchFiles.length;
    $('#gwr-progress-label').text(`0 / ${total}`);
    $('#gwr-progress-fill').css('width', '0%');

    for (let i = 0; i < batchFiles.length; i++) {
      const item = batchFiles[i];
      if (item.status === 'done') {
        done++;
        continue;
      }
      item.status = 'processing';
      renderBatchList();
      try {
        const uint8 = new Uint8Array(item.buffer);
        const result = await window.electronAPI.removeGeminiWatermark(Array.from(uint8));
        if (result && result.success) {
          item.cleanedBuffer = new Uint8Array(result.buffer).buffer;
          item.status = 'done';
        } else {
          item.status = 'error';
        }
      } catch (err) {
        console.error('[GWR] batch item error:', err);
        item.status = 'error';
      }
      done++;
      $('#gwr-progress-label').text(`${done} / ${total}`);
      $('#gwr-progress-fill').css('width', `${(done / total) * 100}%`);
      renderBatchList();
    }

    const anyDone = batchFiles.some((b) => b.status === 'done');
    $('#gwr-batch-export-btn').prop('disabled', !anyDone);
    $('#gwr-batch-process-btn').prop('disabled', false);
  }

  async function exportBatch() {
    const doneItems = batchFiles.filter((b) => b.status === 'done' && b.cleanedBuffer);
    for (const item of doneItems) {
      const baseName = item.name.replace(/\.[^.]+$/, '');
      const saveName = `${baseName}_nowatermark.png`;
      const uint8 = new Uint8Array(item.cleanedBuffer);
      try {
        await window.electronAPI.saveCleanedImage(saveName, Array.from(uint8));
      } catch (err) {
        console.error('[GWR] exportBatch error:', err);
      }
    }
  }

  function showSingle() {
    isBatchMode = false;
    $('#gwr-batch-view').hide();
    $('#gwr-single-view').show();
    $('#gwr-export-btn').toggle(true).prop('disabled', !cleanedBuffer);
  }

  function showBatch() {
    isBatchMode = true;
    $('#gwr-single-view').hide();
    $('#gwr-batch-view').show();
    $('#gwr-export-btn').toggle(false);
    renderBatchList();
  }

  // ── Drag & drop ────────────────────────────────────────────────────────────

  function initDragDrop() {
    const zone = document.getElementById('gwr-dropzone');
    if (!zone) return;

    ['dragenter', 'dragover'].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('gwr-dropzone-active');
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('gwr-dropzone-active');
      });
    });
    zone.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) loadImage(files[0]);
    });
    zone.addEventListener('click', () => {
      $('#gwr-file-input').click();
    });
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  $(document).off(NS);

  $(document).on('click' + NS, '#gwr-import-btn', () => {
    showSingle();
    $('#gwr-file-input').click();
  });
  $(document).on('click' + NS, '#gwr-batch-import-btn', () => {
    showBatch();
    $('#gwr-file-input-batch').click();
  });

  $(document).on('change' + NS, '#gwr-file-input', function () {
    if (this.files && this.files[0]) loadImage(this.files[0]);
    this.value = '';
  });
  $(document).on('change' + NS, '#gwr-file-input-batch', function () {
    if (this.files && this.files.length) addToBatch([...this.files]);
    this.value = '';
  });

  $(document).on('click' + NS, '#gwr-process-btn', processSingle);
  $(document).on('click' + NS, '#gwr-export-btn', () => {
    if (isBatchMode) exportBatch();
    else exportSingle();
  });
  $(document).on('click' + NS, '#gwr-batch-process-btn', processBatch);
  $(document).on('click' + NS, '#gwr-batch-export-btn', exportBatch);

  $(document).on('click' + NS, '.gwr-batch-remove', function (e) {
    e.stopPropagation();
    const idx = parseInt($(this).data('index'), 10);
    batchFiles.splice(idx, 1);
    renderBatchList();
    if (!batchFiles.length) {
      $('#gwr-batch-process-btn').prop('disabled', true);
      $('#gwr-batch-export-btn').prop('disabled', true);
    }
  });

  initDragDrop();
  renderBatchList();
  setStatus('idle');

  // ── Cleanup ────────────────────────────────────────────────────────────────
  $(document).one('page-unload' + NS, function () {
    $(document).off(NS);
  });
})();
