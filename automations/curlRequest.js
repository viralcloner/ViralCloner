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

async function executeCurl(curlCommand) {
    const operation = async () => {
        try {
        const cleaned = curlCommand.replace(/\\\s*\n\s*/g, ' ').trim();
        const urlMatch = cleaned.match(/https?:\/\/[^\s"']+/);
        if (!urlMatch) throw new Error("No URL found in cURL command");
        const url = urlMatch[0];
        const methodMatch = cleaned.match(/-X\s+([A-Z]+)/i);
        const method = methodMatch ? methodMatch[1].toLowerCase() : 'get';
        const headers = {};
        const headerRegex = /-H\s+"([^"]+)"/g;
        let match;
        while ((match = headerRegex.exec(cleaned)) !== null) {
            const [key, ...rest] = match[1].split(":");
            headers[key.trim()] = rest.join(":").trim();
        }
        const data = {};
        const dataRegex = /-d\s+"([^"]+)"/g;
        while ((match = dataRegex.exec(cleaned)) !== null) {
            const [key, ...rest] = match[1].split("=");
            data[key.trim()] = rest.join("=").trim();
        }
        const response = await axios({
            url,
            method,
            headers,
            data: Object.keys(data).length ? new URLSearchParams(data).toString() : undefined
        });
        let responseData;
        try {
            responseData = response.data;
        } catch {
            responseData = response.data.toString();
        }

        return { success: responseData.success, value: responseData.value };
    } catch (err) {
        return { success: false, value: err.message };
    }
    };

    return withNodeTimeout(operation(), 600000, 'cURL'); // 10 minute timeout - increased for complex API operations
}

module.exports = { executeCurl };
