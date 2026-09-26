/**
 * JSON Parser
 * 
 * Parses JSON text and extracts/filters data using field paths and field picking.
 */

/**
 * Parses JSON and extracts data with optional field picking.
 * 
 * @param {string} jsonText - The JSON string to parse
 * @param {string} fieldPath - The field path to navigate to (e.g., "data.items") - optional, empty = use root
 * @param {string} pickFields - Comma-separated field names to keep from each object (e.g., "id,name") - optional
 * @returns {Promise<{success: boolean, value: string}>}
 */
async function parseJson(jsonText, fieldPath, pickFields) {
    if (!jsonText) {
        return { success: false, value: "JSON text is required" };
    }

    try {
        let data = JSON.parse(jsonText);

        // Step 1: Navigate to field path if provided
        const trimmedPath = fieldPath ? fieldPath.trim() : "";
        if (trimmedPath) {
            data = getNestedValue(data, trimmedPath);
            if (data === undefined) {
                return { success: false, value: `Field "${trimmedPath}" not found in JSON` };
            }
        }

        // Step 2: Pick specific fields if provided
        const trimmedPick = pickFields ? pickFields.trim() : "";
        if (trimmedPick) {
            const fields = trimmedPick.split(",").map(f => f.trim()).filter(f => f);
            if (fields.length > 0) {
                if (Array.isArray(data)) {
                    // Pick fields from each object in the array
                    data = data.map(item => {
                        if (typeof item === "object" && item !== null) {
                            return pickFromObject(item, fields);
                        }
                        return item;
                    });
                } else if (typeof data === "object" && data !== null) {
                    // Pick fields from a single object
                    data = pickFromObject(data, fields);
                }
            }
        }

        // Convert result to string
        let resultValue;
        if (typeof data === "object" && data !== null) {
            resultValue = JSON.stringify(data);
        } else if (data === null) {
            resultValue = "null";
        } else {
            resultValue = String(data);
        }

        return { success: true, value: resultValue };

    } catch (error) {
        return { success: false, value: `JSON parse error: ${error.message}` };
    }
}

/**
 * Picks specific fields from an object, supporting nested dot-notation paths.
 * e.g., fields = ["id", "name", "meta.key"] extracts those values into a flat or nested result.
 */
function pickFromObject(obj, fields) {
    const result = {};
    for (const field of fields) {
        if (field.includes(".") || field.includes("[")) {
            // Nested path - use the last segment as the key name
            const val = getNestedValue(obj, field);
            const keyName = field.replace(/\[(\d+)\]/g, ".$1").split(".").pop();
            if (val !== undefined) {
                result[keyName] = val;
            }
        } else {
            if (obj[field] !== undefined) {
                result[field] = obj[field];
            }
        }
    }
    return result;
}

/**
 * Gets a nested value from an object using dot notation path.
 * Supports array indexing with brackets: "items[0].name"
 * 
 * @param {object} obj - The object to navigate
 * @param {string} path - The path (e.g., "user.profile.name" or "items[0].title")
 * @returns {*} The value at the path, or undefined if not found
 */
function getNestedValue(obj, path) {
    if (!path) return obj;

    // Split path by dots, but handle array brackets
    // Convert "items[0].name" to ["items", "0", "name"]
    const parts = path
        .replace(/\[(\d+)\]/g, '.$1') // Convert [0] to .0
        .split('.')
        .filter(part => part !== '');

    let current = obj;

    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }

        // Handle array index
        if (/^\d+$/.test(part)) {
            const index = parseInt(part, 10);
            if (Array.isArray(current) && index < current.length) {
                current = current[index];
            } else {
                return undefined;
            }
        } else {
            current = current[part];
        }
    }

    return current;
}

module.exports = { parseJson };
