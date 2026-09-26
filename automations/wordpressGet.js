const fetch = require("node-fetch");
const { readKey } = require("../lib/utils");

async function getTimeoutFromSettings(settingName, defaultSeconds) {
  try {
    const automationSettings = (await readKey("automationSettings")) || {};
    return (automationSettings[settingName] || defaultSeconds) * 1000;
  } catch (error) {
    console.error(`Error reading timeout setting ${settingName}:`, error);
    return defaultSeconds * 1000;
  }
}

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

const RESOURCE_ENDPOINTS = {
  posts: "/wp-json/wp/v2/posts",
  pages: "/wp-json/wp/v2/pages",
  categories: "/wp-json/wp/v2/categories",
  tags: "/wp-json/wp/v2/tags",
  media: "/wp-json/wp/v2/media",
  comments: "/wp-json/wp/v2/comments",
  users: "/wp-json/wp/v2/users",
  products: "/wp-json/wc/v3/products",
  orders: "/wp-json/wc/v3/orders",
  coupons: "/wp-json/wc/v3/coupons",
};

async function wordpressGet(
  wordpressId,
  resourceType,
  perPage,
  searchQuery,
  resourceId,
  sortBy,
) {
  const operation = async () => {
    const wordpressSites = (await readKey("wordpressSites")) || {};
    const wpCredentials = wordpressSites[wordpressId] || null;
    if (!wpCredentials) {
      return { success: false, value: "No WordPress site selected" };
    }

    const endpoint = RESOURCE_ENDPOINTS[resourceType];
    if (!endpoint) {
      return {
        success: false,
        value: `Unknown resource type: ${resourceType}`,
      };
    }

    const baseUrl = wpCredentials.url.replace(/\/$/, "");
    const auth = Buffer.from(
      `${wpCredentials.username}:${wpCredentials.appPassword}`,
    ).toString("base64");

    let url;
    const resourceIdTrimmed = resourceId ? String(resourceId).trim() : "";

    const sort = sortBy || "date_desc";
    let requestedCount = 10;

    if (resourceIdTrimmed) {
      // Fetch a single resource by ID
      url = `${baseUrl}${endpoint}/${encodeURIComponent(resourceIdTrimmed)}`;
    } else {
      // Fetch a list of resources
      const params = new URLSearchParams();
      const count = parseInt(perPage, 10);
      requestedCount = count > 0 && count <= 100 ? count : 10;
      params.set("per_page", requestedCount);

      const searchTrimmed = searchQuery ? searchQuery.trim() : "";
      if (searchTrimmed) {
        params.set("search", searchTrimmed);
      }

      // Sort by handling
      if (sort === "rand") {
        // Fetch max 100 posts then shuffle and pick the requested amount
        params.set("per_page", 100);
        params.set("orderby", "date");
        params.set("order", "desc");
      } else if (sort === "include") {
        params.set("orderby", "include");
      } else if (sort === "relevance") {
        if (searchTrimmed) {
          params.set("orderby", "relevance");
        }
      } else {
        const parts = sort.split("_");
        const dir = parts.pop();
        const field = parts.join("_");
        params.set("orderby", field);
        params.set("order", dir);
      }

      url = `${baseUrl}${endpoint}?${params.toString()}`;
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          success: false,
          value: `WordPress API error ${response.status}: ${errorText}`,
        };
      }

      const data = await response.json();

      // Shuffle and slice for random sort (WP REST API doesn't support orderby=rand)
      if (sort === "rand" && Array.isArray(data)) {
        for (let i = data.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [data[i], data[j]] = [data[j], data[i]];
        }
        return { success: true, value: JSON.stringify(data.slice(0, requestedCount)) };
      }

      return { success: true, value: JSON.stringify(data) };
    } catch (error) {
      return {
        success: false,
        value: `Request failed: ${error.message}`,
      };
    }
  };

  const timeoutMs = await getTimeoutFromSettings("wordpressGetTimeout", 120);
  return withNodeTimeout(operation(), timeoutMs, "WordPress GET");
}

module.exports = { wordpressGet };
