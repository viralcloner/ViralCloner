/* Offline ingredient screening. No match is not a halal certification.
 * Keep exceptions local to an ingredient occurrence, never the whole recipe.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecipeDetector = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function normalize(value) {
    return value.normalize("NFKD").replace(/\p{M}/gu, "")
      .replace(/ـ/g, "").replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي")
      .toLowerCase().replace(/[‐‑–—-]/g, " ").replace(/[^\S\n]+/g, " ");
  }

  const rules = [
    { category: "pork", terms: [
      "pork", "pigs", "pig", "bacon", "ham", "lard", "prosciutto", "pancetta", "guanciale",
      "porc", "cochon", "cochons", "jambon", "lardons", "saindoux",
      // Romanian, Italian and Spanish (accents are normalized before matching).
      "porcul", "porcului", "sunca", "slanina", "slaninuta", "jumari",
      "maiale", "maiali", "suino", "suina", "suini", "suine", "strutto", "lardo",
      "cerdo", "cerdos", "puerco", "puercos", "cochinillo", "jamon", "jamones", "tocino", "panceta",
      "خنزير", "خنازير", "بيكون", "لحم مقدد", "شحم الخنزير",
    ] },
    { category: "alcohol", terms: [
      "wine", "beer", "rum", "vodka", "whisky", "whiskey", "bourbon", "brandy", "cognac",
      "liqueur", "liqueurs", "tequila", "gin", "champagne", "marsala", "sherry", "mirin", "sake", "alcohol",
      "vin", "vins", "biere", "bieres", "rhum", "alcool",
      "bere", "vinul", "vinului", "tuica", "palinca", "visinata", "rom", "coniac", "lichior",
      "vino", "vini", "birra", "birre", "liquore", "liquori", "grappa", "limoncello", "prosecco", "alcol",
      "cerveza", "cervezas", "vinos", "ron", "licor", "licores", "aguardiente", "vermut",
      "خمر", "نبيذ", "بيرة", "كحول", "فودكا", "ويسكي", "شمبانيا",
    ] },
  ];
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = (pattern, flags = "gu") => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, flags);
  const arabic = (term) => /[\u0600-\u06ff]/.test(term) ? `(?:و|ب|ل)?(?:ال)?${escape(term)}` : escape(term);
  const compiled = rules.map((rule) => ({
    category: rule.category,
    regex: boundary(rule.terms.map(arabic).sort((a, b) => b.length - a.length).join("|")),
  }));
  // Only explicit alternatives are exempt. Unspecified gelatin, sausage, etc.
  // are not enough evidence for a Haram badge and are intentionally unclassified.
  const exceptions = [
    "(?:turkey|beef|chicken|duck|vegan|vegetarian|plant based|soy|coconut) (?:bacon|ham|lard)",
    "(?:vegan|vegetarian|plant based|mock) (?:pork|prosciutto|pancetta)",
    "(?:bacon|ham) (?:style |flavou?red )?(?:tofu|tempeh)",
    "(?:jambon|bacon|lardons) (?:de |au |a la )?(?:dinde|poulet|boeuf|vegetal|vegetaux|vegan)",
    "(?:sunca|bacon) (?:de |din )?(?:curcan|pui|vita|vegetal|vegetala|vegan|vegana)",
    "(?:prosciutto|pancetta|guanciale|lardo|strutto) (?:di |vegetale di )?(?:tacchino|pollo|manzo|soia|vegetale|vegano|vegana)",
    "(?:jamon|bacon|tocino|panceta) (?:de )?(?:pavo|pollo|ternera|soja|vegetal|vegano|vegana)",
    "(?:بيكون|لحم مقدد) (?:نباتي|بقري|من الديك الرومي|من الدجاج)",
    "(?:non ?alcoholic|alcohol free|zero alcohol) (?:red |white )?(?:wine|beer|rum|vodka|gin|champagne)",
    "(?:wine|beer|alcohol|pork|bacon|ham) free",
    "(?:red |white |rice )?wine vinegar", "(?:root|ginger) beer", "beer yeast", "brewer'?s yeast",
    "(?:vinaigre de|vinaigre au) (?:vin|biere)",
    "(?:vin|biere|rhum|champagne) sans alcool",
    "(?:vin|bere|rom|lichior) (?:rosu |alb |roze )?fara alcool",
    "(?:vin|bere) (?:nealcoolic|nealcoolica|dezalcoolizat|dezalcoolizata)",
    "(?:vino|birra|liquore) (?:rosso |bianco |rose )?(?:senza (?:alcol|alcool)|analcolico|analcolica|dealcolato|dealcolata)",
    "(?:vino|cerveza|ron|licor) (?:tinto |blanco |rosado )?(?:sin alcohol|desalcoholizado|desalcoholizada)",
    "otet (?:de |din )vin", "aceto di vino", "vinagre de vino",
    "lievito di birra", "levadura de cerveza", "drojdie de bere",
    "(?:خل (?:النبيذ|الخمر)|(?:ال)?(?:بيرة|نبيذ) (?:بدون|دون|خال من|خالية من) (?:ال)?كحول)",
    "(?:for (?:the )?sake of)",
  ].map((pattern) => boundary(pattern));
  const negation = /(?:\b(?:no|without|omit|avoid|sans|sans aucun|sans aucune|fara|senza|sin)|بدون|دون|بلا)\s+(?:(?:any|added|de|du|des|اي|carne de|carne di)\s+)?$/u;

  function detect(value) {
    if (typeof value !== "string" || !value.trim()) return [];
    // Ignore URLs and HTML attributes; only visible text can be evidence.
    let text = normalize(value.replace(/https?:\/\/[^\s<>]+/gi, " ")
      .replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, " "));
    for (const regex of exceptions) text = text.replace(regex, (match) => " ".repeat(match.length));
    const findings = new Map();
    for (const { category, regex } of compiled) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        const before = text.slice(Math.max(0, match.index - 65), match.index);
        if (negation.test(before)) continue;
        findings.set(`${category}:${match[0]}`, { category, ingredient: match[0] });
      }
    }
    return [...findings.values()];
  }

  function detectPost(post) {
    // Explicit content fields only: never scan media paths, IDs, prompts or logs.
    const fields = [];
    for (const content of [post, post?.facebookOutput, post?.pinterestOutput]) {
      if (!content) continue;
      for (const key of ["postMessage", "title", "text", "description", "ingredients", "instructions"]) {
        if (typeof content[key] === "string") fields.push(content[key]);
      }
    }
    return [...new Map(fields.flatMap(detect).map((finding) =>
      [`${finding.category}:${finding.ingredient}`, finding])).values()];
  }

  return { detect, detectPost };
});
