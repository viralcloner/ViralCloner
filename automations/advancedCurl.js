const axios = require("axios");

function withNodeTimeout(promise, timeoutMs, nodeType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${nodeType} operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function interpolatePlaceholders(template, inputs) {
  if (!template) return template;
  let result = template;
  for (const [key, value] of Object.entries(inputs)) {
    const num = key.replace("input_", "");
    const placeholder = `{INPUT_${num}}`;
    result = result.split(placeholder).join(value || "");
  }
  return result;
}

function parseHeaders(headersText) {
  const headers = {};
  if (!headersText || !headersText.trim()) return headers;
  const lines = headersText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.substring(0, colonIdx).trim();
    const val = trimmed.substring(colonIdx + 1).trim();
    if (key) headers[key] = val;
  }
  return headers;
}

async function advancedCurl(url, method, contentType, headersText, body, authType, authValue, inputs) {
  const operation = async () => {
    if (!url || !url.trim()) {
      return { success: false, value: "URL is required" };
    }

    const finalUrl = interpolatePlaceholders(url.trim(), inputs);
    const finalHeaders = parseHeaders(interpolatePlaceholders(headersText, inputs));
    const finalBody = interpolatePlaceholders(body, inputs);

    // Set content type header
    if (contentType && contentType !== "none" && method !== "get") {
      finalHeaders["Content-Type"] = contentType;
    }

    // Set auth header
    if (authType === "basic" && authValue) {
      const finalAuthValue = interpolatePlaceholders(authValue, inputs);
      finalHeaders["Authorization"] = `Basic ${Buffer.from(finalAuthValue).toString("base64")}`;
    } else if (authType === "bearer" && authValue) {
      const finalAuthValue = interpolatePlaceholders(authValue, inputs);
      finalHeaders["Authorization"] = `Bearer ${finalAuthValue}`;
    }

    // Build request body
    let requestData;
    const lowerMethod = method.toLowerCase();
    if (lowerMethod !== "get" && lowerMethod !== "head" && finalBody && finalBody.trim()) {
      if (contentType === "application/json") {
        try {
          requestData = JSON.parse(finalBody);
        } catch {
          requestData = finalBody;
        }
      } else if (contentType === "application/x-www-form-urlencoded") {
        requestData = finalBody;
      } else {
        requestData = finalBody;
      }
    }

    try {
      const response = await axios({
        url: finalUrl,
        method: lowerMethod,
        headers: finalHeaders,
        data: requestData,
        validateStatus: () => true,
        transformResponse: [(data) => data],
        timeout: 300000,
      });

      const responseText = typeof response.data === "string" ? response.data : JSON.stringify(response.data);

      if (response.status >= 200 && response.status < 400) {
        return { success: true, value: responseText };
      } else {
        return { success: false, value: `HTTP ${response.status}: ${responseText}` };
      }
    } catch (err) {
      return { success: false, value: `Request failed: ${err.message}` };
    }
  };

  return withNodeTimeout(operation(), 600000, "Advanced cURL");
}

module.exports = { advancedCurl };
