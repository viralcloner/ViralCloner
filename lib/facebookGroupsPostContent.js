// Line counts refer to explicit line breaks, including blank lines, not visual wrapping.
function normalizeKeepLines(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.min(10000, Math.floor(count))) : 0;
}

function prepareGroupPostContent(content, url, settings = {}) {
  const fullText = String(content || '');
  const count = normalizeKeepLines(settings.postKeepLines);
  const excerpt = count > 0 ? fullText.split(/\r\n|\r|\n/).slice(0, count).join('\n') : fullText;
  const message = [excerpt, String(settings.postSuffix || '').trim()].filter(Boolean).join('\n');
  const urlComment = settings.postUrlAsComment
    ? String(settings.urlCommentPrefix || url || '').replace(/\{\{url\}\}/g, url || '').trim() : '';
  const firstComment = [settings.postContentAsComment ? fullText : '', urlComment].filter(Boolean).join('\n\n');
  return { message, firstComment };
}

module.exports = { normalizeKeepLines, prepareGroupPostContent };
