/**
 * contentVariation.js
 * ---------------------------------------------------------------------------
 * Light, safe variation for Facebook group post text so the SAME library post
 * is not byte-identical when it lands in many groups. Posting the exact same
 * string to dozens of groups is a strong spam fingerprint Facebook looks for.
 *
 * Design goals:
 *  - Never alter meaning. No emoji injection (app-wide rule: no emojis).
 *  - Never touch URLs, @mentions, #hashtags, or numbers.
 *  - Variation is SUBTLE and NATURAL (trailing whitespace / line-break style),
 *    not a fixed marker that itself becomes a fingerprint.
 *  - Supports inline spintax `{a|b|c}` if the author chooses to write it.
 */

// Expand inline spintax of the form {option a|option b|option c}.
// Picks one option at random per group. Supports a single level (no nesting),
// which is enough for hand-written variations and keeps it predictable.
function _expandSpintax(text) {
  if (!text || text.indexOf("{") === -1) return text;
  return text.replace(/\{([^{}]+)\}/g, (match, body) => {
    if (body.indexOf("|") === -1) return match; // not spintax, leave as-is
    const options = body.split("|");
    return options[Math.floor(Math.random() * options.length)];
  });
}

// Apply a subtle, natural trailing-whitespace variation. This changes the raw
// bytes without changing how the post reads. We only ever touch the END of the
// text so the visible content and any links/mentions stay untouched.
function _applyTrailingVariation(text) {
  if (typeof text !== "string") return text;
  // Strip existing trailing whitespace so we control it deterministically.
  const base = text.replace(/[ \t\r\n]+$/g, "");
  if (!base) return text;
  // Randomly pick one of a few natural trailing styles.
  const styles = [
    "",       // nothing
    "\n",     // single newline
    "\n\n",   // blank line
    " ",      // single trailing space
  ];
  const pick = styles[Math.floor(Math.random() * styles.length)];
  return base + pick;
}

/**
 * varyContent(text)
 * Returns a lightly varied copy of `text`. Safe to call on empty/null.
 * Order: expand spintax first, then apply trailing-whitespace variation.
 */
function varyContent(text) {
  if (!text || typeof text !== "string") return text;
  try {
    let out = _expandSpintax(text);
    out = _applyTrailingVariation(out);
    return out;
  } catch (_) {
    // Variation must never break a post — fall back to the original text.
    return text;
  }
}

module.exports = { varyContent };
