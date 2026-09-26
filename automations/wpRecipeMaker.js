const fetch = require('node-fetch');
const { readKey } = require('../lib/utils');
const crypto = require('crypto');

async function getTimeoutFromSettings(settingName, defaultSeconds) {
    try {
        const automationSettings = (await readKey('automationSettings')) || {};
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

function slugify(text) {
    return text
        .toString()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50);
}

/**
 * Parse ingredients text into WP Recipe Maker format
 * Input: newline-separated ingredients (e.g., "2 cups flour\n1 tsp salt")
 * Output: Array of ingredient objects for WPRM API using "raw" parsing
 */
function parseIngredients(ingredientsText) {
    if (!ingredientsText || typeof ingredientsText !== 'string') return [];
    
    const lines = ingredientsText.split('\n').filter(line => line.trim());
    
    // WPRM accepts ingredients_flat with "raw" field for auto-parsing
    return lines.map(line => ({
        raw: line.trim()
    }));
}

/**
 * Parse instructions text into WP Recipe Maker format
 * Input: newline-separated steps or numbered steps
 * Output: Array of instruction objects for WPRM API
 */
function parseInstructions(instructionsText) {
    if (!instructionsText || typeof instructionsText !== 'string') return [];
    
    const lines = instructionsText.split('\n').filter(line => line.trim());
    return lines.map(line => {
        // Remove leading numbers/bullets (e.g., "1. ", "• ", "- ")
        const text = line.trim().replace(/^[\d]+[\.\)]\s*/, '').replace(/^[•\-\*]\s*/, '');
        return {
            type: 'instruction',
            text: text
        };
    });
}

/**
 * Parse equipment text into WP Recipe Maker format
 * Input: newline-separated equipment list or comma-separated
 * Output: Array of equipment objects for WPRM API
 */
function parseEquipment(equipmentText) {
    if (!equipmentText || typeof equipmentText !== 'string') return [];
    
    // Support both newline and comma separation
    const items = equipmentText.includes('\n') 
        ? equipmentText.split('\n') 
        : equipmentText.split(',');
    
    return items
        .map(item => item.trim())
        .filter(item => item)
        .map(name => ({ name, notes: '' }));
}

/**
 * Parse time string to minutes
 * Supports: "30", "30 min", "30 minutes", "1 hour", "1h 30m", "1:30"
 */
function parseTimeToMinutes(timeString) {
    if (!timeString) return 0;
    
    const str = String(timeString).toLowerCase().trim();
    
    // Pure number = minutes
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    
    // HH:MM format
    const colonMatch = str.match(/^(\d+):(\d+)$/);
    if (colonMatch) {
        return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);
    }
    
    // "X hours Y minutes" or variations
    let totalMinutes = 0;
    const hourMatch = str.match(/(\d+)\s*(?:hours?|hrs?|h)/);
    const minMatch = str.match(/(\d+)\s*(?:minutes?|mins?|m)/);
    
    if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60;
    if (minMatch) totalMinutes += parseInt(minMatch[1], 10);
    
    // If we found something, return it
    if (totalMinutes > 0) return totalMinutes;
    
    // Try to extract any number as minutes
    const numMatch = str.match(/(\d+)/);
    return numMatch ? parseInt(numMatch[1], 10) : 0;
}

/**
 * Upload image to WordPress media library
 */
async function uploadRecipeImage(apiUrl, auth, imageUrl, recipeName) {
    try {
        const imgResponse = await fetch(imageUrl);
        if (!imgResponse.ok) return null;

        const buffer = await imgResponse.buffer();
        const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
        const ext = contentType.split("/")[1]?.split(";")[0] || "jpg";

        const randomStr = crypto.randomBytes(3).toString("hex");
        const slug = slugify(recipeName) || "recipe";
        const fileName = `${slug}-${randomStr}.${ext}`;

        const uploadResponse = await fetch(`${apiUrl}/media`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'Content-Type': contentType
            },
            body: buffer
        });

        if (!uploadResponse.ok) return null;
        const uploaded = await uploadResponse.json();
        return uploaded.id || null;
    } catch (error) {
        console.error('[WP Recipe Maker] Image upload error:', error);
        return null;
    }
}

/**
 * Create a recipe using WP Recipe Maker plugin REST API
 * 
 * @param {string} wordpressId - The WordPress site ID from settings
 * @param {Object} recipeData - Recipe data object
 * @param {string} recipeData.name - Recipe name/title (required)
 * @param {string} recipeData.summary - Recipe summary/description
 * @param {string} recipeData.ingredients - Newline-separated ingredients
 * @param {string} recipeData.instructions - Newline-separated instructions
 * @param {string} recipeData.prepTime - Prep time (e.g., "30 min", "1 hour")
 * @param {string} recipeData.cookTime - Cook time
 * @param {string} recipeData.totalTime - Total time (auto-calculated if not provided)
 * @param {string} recipeData.servings - Number of servings
 * @param {string} recipeData.servingsUnit - Servings unit (e.g., "people", "portions")
 * @param {string} recipeData.notes - Recipe notes
 * @param {string} recipeData.cuisine - Cuisine type (e.g., "Italian", "Mexican")
 * @param {string} recipeData.course - Course type (e.g., "Main Dish", "Dessert")
 * @param {string} recipeData.equipment - Equipment needed (newline or comma separated)
 * @param {string} recipeData.imageUrl - Recipe image URL
 * @param {string} recipeData.videoUrl - Recipe video URL
 * @param {string} recipeData.author - Recipe author name
 * @returns {Object} { success: boolean, value: string (recipe ID or error) }
 */
async function wpRecipeMaker(wordpressId, recipeData) {
    const operation = async () => {
        // Validate required parameters
        if (!wordpressId) {
            return { success: false, value: "No WordPress site selected" };
        }

        if (!recipeData || !recipeData.name) {
            return { success: false, value: "Recipe name is required" };
        }

        // Get WordPress credentials
        const wordpressSites = (await readKey('wordpressSites')) || {};
        const wpCredentials = wordpressSites[wordpressId];
        
        if (!wpCredentials) {
            return { success: false, value: "WordPress site not found" };
        }

        const baseUrl = wpCredentials.url.replace(/\/$/, '');
        const apiUrl = `${baseUrl}/wp-json/wp/v2`;
        const auth = Buffer.from(`${wpCredentials.username}:${wpCredentials.appPassword}`).toString('base64');

        // Upload image if provided - can use image_url directly with WPRM
        let imageId = null;
        let imageUrl = recipeData.imageUrl || null;
        
        // Optionally upload to media library for better performance
        if (recipeData.imageUrl) {
            const uploadedImageId = await uploadRecipeImage(apiUrl, auth, recipeData.imageUrl, recipeData.name);
            if (uploadedImageId) {
                imageId = uploadedImageId;
                imageUrl = null; // Use uploaded image ID instead
            }
        }

        // Parse time values
        const prepTime = parseTimeToMinutes(recipeData.prepTime);
        const cookTime = parseTimeToMinutes(recipeData.cookTime);
        const totalTime = recipeData.totalTime 
            ? parseTimeToMinutes(recipeData.totalTime) 
            : prepTime + cookTime;

        // Build recipe payload for WP Recipe Maker API
        // Per WPRM docs: POST to /wp-json/wp/v2/wprm_recipe/ with { recipe: { ... } }
        const recipePayload = {
            recipe: {
                // Recipe type
                recipe_type: 'food',
                
                // Basic info
                name: recipeData.name,
                summary: recipeData.summary || '',
                
                // Use ingredients_flat with "raw" for auto-parsing
                ingredients_flat: parseIngredients(recipeData.ingredients),
                
                // Use instructions_flat 
                instructions_flat: parseInstructions(recipeData.instructions),
                
                // Equipment
                equipment: parseEquipment(recipeData.equipment),
                
                // Times (in minutes)
                prep_time: prepTime,
                cook_time: cookTime,
                total_time: totalTime,
                
                // Servings
                servings: recipeData.servings ? parseInt(recipeData.servings, 10) || 4 : 4,
                servings_unit: recipeData.servingsUnit || 'servings',
                
                // Notes
                notes: recipeData.notes || '',
                
                // Author
                author_display: recipeData.author ? 'custom' : 'default',
                author_name: recipeData.author || '',
                
                // Taxonomies
                tags: {
                    cuisine: recipeData.cuisine ? [recipeData.cuisine] : [],
                    course: recipeData.course ? [recipeData.course] : []
                },
                
                // Media - use image_id if uploaded, otherwise image_url
                ...(imageId ? { image_id: imageId } : (imageUrl ? { image_url: imageUrl } : {})),
                ...(recipeData.videoUrl ? { video_embed: recipeData.videoUrl } : {})
            }
        };

        try {
            // Create recipe via WP Recipe Maker REST API
            // Endpoint: /wp-json/wp/v2/wprm_recipe/
            const response = await fetch(`${apiUrl}/wprm_recipe`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(recipePayload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[WP Recipe Maker] API error:', response.status, errorText);
                
                // Check if it's a "plugin not installed" error
                if (response.status === 404) {
                    return { success: false, value: "WP Recipe Maker plugin not installed or REST API not enabled" };
                }
                if (response.status === 401 || response.status === 403) {
                    return { success: false, value: "Authentication failed - check WordPress credentials" };
                }
                
                return { success: false, value: `API error: ${response.status} - ${errorText.substring(0, 200)}` };
            }

            const result = await response.json();
            
            // WPRM API returns the recipe object with an ID
            if (result && result.id) {
                console.log(`[WP Recipe Maker] Recipe created successfully: ID ${result.id}`);
                return { success: true, value: String(result.id) };
            } else {
                return { success: false, value: "Recipe created but no ID returned" };
            }
        } catch (error) {
            console.error('[WP Recipe Maker] Error:', error);
            return { success: false, value: error.message || "Unknown error" };
        }
    };

    const timeoutMs = await getTimeoutFromSettings('wpRecipeMakerTimeout', 120);
    return withNodeTimeout(operation(), timeoutMs, 'WP Recipe Maker');
}

module.exports = { wpRecipeMaker };
