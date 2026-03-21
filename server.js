#!/usr/bin/env node
"use strict";

const fs      = require("fs");
const path    = require("path");
const http    = require("http");
const { JSDOM } = require("jsdom");
const { MathMLToLaTeX } = require("mathml-to-latex");
const multer  = require("multer");
const express = require("express");

/* ================================================================
   EXPRESS SETUP
================================================================ */

const app    = express();
const PORT   = process.env.PORT || 3000;

// Enable CORS — allows browser clients and external services to call the API
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin",  "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});
const UPLOAD = path.join(__dirname, "uploads");
const OUTPUT = path.join(__dirname, "outputs");

// Create folders if not exist
[UPLOAD, OUTPUT].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

/* ================================================================
   CLOUD STORAGE CLEANUP
   On cloud servers disk space is limited.
   Auto-delete output files older than MAX_FILE_AGE_MS (default 1hr)
   This keeps the outputs folder from filling up.
================================================================ */
const MAX_FILE_AGE_MS = parseInt(process.env.MAX_FILE_AGE_MS || "3600000"); // 1 hour

function cleanOldOutputFiles() {
    try {
        const now = Date.now();
        const files = fs.readdirSync(OUTPUT);
        let deleted = 0;
        files.forEach(f => {
            const fp = path.join(OUTPUT, f);
            try {
                const stat = fs.statSync(fp);
                if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
                    fs.unlinkSync(fp);
                    deleted++;
                }
            } catch (_) {}
        });
        if (deleted > 0) console.log(`[CLEANUP] Deleted ${deleted} old output file(s)`);
    } catch (_) {}
}

// Run cleanup every 30 minutes
setInterval(cleanOldOutputFiles, 30 * 60 * 1000);

// Is running on cloud (not localhost)
const IS_CLOUD = !!(process.env.RAILWAY_ENVIRONMENT ||
                    process.env.RENDER ||
                    process.env.DYNO ||        // Heroku
                    process.env.K_SERVICE ||   // Cloud Run
                    process.env.WEBSITE_INSTANCE_ID); // Azure

// Multer — accept only XML files
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD),
    filename:    (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith(".xml")) cb(null, true);
        else cb(new Error("Only .xml files are accepted"));
    }
});

/* ================================================================
   ALT SYMBOL MAP
================================================================ */

const ALT_SYMBOLS = {
    "α":"alpha","β":"beta","γ":"gamma","δ":"delta","ε":"epsilon",
    "ζ":"zeta","η":"eta","θ":"theta","ι":"iota","κ":"kappa",
    "λ":"lambda","μ":"mu","ν":"nu","ξ":"xi","π":"pi","ρ":"rho",
    "σ":"sigma","τ":"tau","υ":"upsilon","φ":"phi","χ":"chi",
    "ψ":"psi","ω":"omega",
    "Γ":"Gamma","Δ":"Delta","Θ":"Theta","Λ":"Lambda","Ξ":"Xi",
    "Π":"Pi","Σ":"Sigma","Υ":"Upsilon","Φ":"Phi","Ψ":"Psi","Ω":"Omega",
    "+":"plus","-":"minus","−":"minus","±":"plus or minus",
    "∓":"minus or plus","×":"times","÷":"divided by","·":"dot",
    "∘":"composed with","∗":"asterisk","⊕":"direct sum","⊗":"tensor product",
    "⊖":"ominus","⊙":"odot",
    "=":"equals","<":"less than",">":"greater than",
    "≤":"less than or equal to","≥":"greater than or equal to",
    "≠":"not equal to","≈":"approximately equal to","≡":"equivalent to",
    "∼":"similar to","≅":"congruent to","∝":"proportional to",
    "≪":"much less than","≫":"much greater than","≺":"precedes","≻":"succeeds",
    "∈":"element of","∉":"not element of","∋":"contains",
    "⊂":"subset of","⊃":"superset of","⊆":"subset or equal to","⊇":"superset or equal to",
    "∪":"union","∩":"intersection","∅":"empty set",
    "∧":"and","∨":"or","¬":"not","∀":"for all","∃":"there exists",
    "→":"right arrow","←":"left arrow","↔":"left right arrow",
    "⇒":"implies","⇐":"implied by","⇔":"if and only if",
    "↑":"up arrow","↓":"down arrow","↦":"maps to",
    "∂":"partial","∇":"nabla","∫":"integral","∬":"double integral",
    "∭":"triple integral","∮":"contour integral",
    "∑":"sum","∏":"product","∞":"infinity","√":"square root",
    // All angle bracket variants
    "\u27E8":"left angle bracket",  "\u27E9":"right angle bracket",
    "\u2329":"left angle bracket",  "\u232A":"right angle bracket",
    "\u3008":"left angle bracket",  "\u3009":"right angle bracket",
    "\u27EA":"left double angle bracket","\u27EB":"right double angle bracket",
    "\u27E8":"left angle bracket",  "\u27E9":"right angle bracket",
    "\u2329":"left angle bracket",  "\u232A":"right angle bracket",
    "⌈":"ceiling left","⌉":"ceiling right","⌊":"floor left","⌋":"floor right",
    "∣":"vertical bar","‖":"double vertical bar","|":"vertical bar",
    "(":"open parenthesis",")":"close parenthesis",
    "[":"open bracket","]":"close bracket",
    "…":"ellipsis","⋯":"center dots","⋮":"vertical dots","⋱":"diagonal dots",
    "ℝ":"real numbers","ℤ":"integers","ℕ":"natural numbers",
    "ℚ":"rational numbers","ℂ":"complex numbers","ℏ":"h-bar","ℓ":"script l",
    "†":"dagger","‡":"double dagger","′":"prime","″":"double prime",
    ",":"comma",".":"dot",
    "\u200D":"","\u200B":"","\u00A0":" "
};


/* ================================================================
   MATHML COMPLEXITY ANALYZER
   Inspects a MathML node and reports:
   - Nesting depth
   - All unique element types used
   - Total element count
   - Any unsupported / rare elements
   - Detected complexity level (LOW / MEDIUM / HIGH / VERY HIGH)
   This is attached to every failed/warned equation in the log
   so engineers can see exactly WHY conversion failed.
================================================================ */

// Elements mathml-to-latex handles well
const SUPPORTED_ELEMENTS = new Set([
    "math","mrow","mi","mn","mo","mtext","ms","mspace",
    "msup","msub","msubsup","munder","mover","munderover",
    "mfrac","msqrt","mroot","mfenced","mtable","mtr","mtd",
    "mstyle","merror","mpadded","mphantom","semantics",
    "annotation","annotation-xml","mmultiscripts","mprescripts",
    "mlabeledtr","maligngroup","malignmark","none"
]);

// Elements that are rare / complex / may cause failures
const COMPLEX_ELEMENTS = new Set([
    "maction","mglyph","mlongdiv","msgroup","msrow","mscarries",
    "mscarry","msline","mstack","menclose","mfraction",
    "mtd","mlabeledtr"
]);

function analyzeMathMLComplexity(mathNode) {
    const elementCounts = {};
    const unsupported   = new Set();
    const complex       = new Set();
    let   maxDepth      = 0;
    let   totalNodes    = 0;

    function traverse(node, depth) {
        if (!node) return;
        if (node.nodeType === 3) return; // text node

        const tag = node.nodeName.replace(/^mml:/i, "").toLowerCase();
        totalNodes++;
        maxDepth = Math.max(maxDepth, depth);

        elementCounts[tag] = (elementCounts[tag] || 0) + 1;

        if (!SUPPORTED_ELEMENTS.has(tag)) unsupported.add(tag);
        if (COMPLEX_ELEMENTS.has(tag))    complex.add(tag);

        [...(node.children || [])].forEach(child => traverse(child, depth + 1));
    }

    traverse(mathNode, 0);

    // Determine complexity level
    let level = "LOW";
    let reasons = [];

    if (maxDepth >= 8)        { level = "VERY HIGH"; reasons.push(`deep nesting (depth ${maxDepth})`); }
    else if (maxDepth >= 5)   { level = "HIGH";      reasons.push(`moderate nesting (depth ${maxDepth})`); }
    else if (maxDepth >= 3)   { level = "MEDIUM";    reasons.push(`some nesting (depth ${maxDepth})`); }

    if (totalNodes >= 50)     { level = "VERY HIGH"; reasons.push(`large equation (${totalNodes} nodes)`); }
    else if (totalNodes >= 25){ if (level !== "VERY HIGH") level = "HIGH"; reasons.push(`medium equation (${totalNodes} nodes)`); }

    if (unsupported.size > 0) { level = "VERY HIGH"; reasons.push(`unsupported elements: ${[...unsupported].join(", ")}`); }
    if (complex.size > 0)     { if (level === "LOW" || level === "MEDIUM") level = "HIGH"; reasons.push(`complex elements: ${[...complex].join(", ")}`); }

    // Check for nested fractions (common cause of conversion issues)
    const fracCount = elementCounts["mfrac"] || 0;
    if (fracCount >= 3)       { reasons.push(`multiple nested fractions (${fracCount}x mfrac)`); }

    // Check for nested scripts
    const scriptCount = (elementCounts["msup"] || 0) + (elementCounts["msub"] || 0) +
                        (elementCounts["msubsup"] || 0) + (elementCounts["munderover"] || 0);
    if (scriptCount >= 5)     { reasons.push(`many script elements (${scriptCount} total)`); }

    // Check for table/matrix structures
    if (elementCounts["mtable"]) { reasons.push(`contains matrix/table (${elementCounts["mtable"]}x mtable)`); }

    // Check for entity references / special chars in mo
    const allText = mathNode.textContent || "";
    const hasEntities = /[\u0080-\uFFFF]/.test(allText);
    if (hasEntities)           { reasons.push("contains non-ASCII Unicode characters"); }

    return {
        level,
        reasons:        reasons.length > 0 ? reasons : ["simple structure"],
        maxDepth,
        totalNodes,
        elementCounts,
        unsupportedElements: [...unsupported],
        complexElements:     [...complex],
        uniqueElements:      Object.keys(elementCounts).sort()
    };
}

/* ================================================================
   TEX GENERATOR — DUAL ENGINE
   ---------------------------------------------------------------
   Strategy:
     1. PRIMARY   : WIRIS/MathType API  (~99% accuracy, online)
                    https://www.wiris.net/demo/editor/mathml2latex
     2. FALLBACK  : mathml-to-latex     (~90% accuracy, offline)
                    Used when WIRIS is disabled, unavailable, or
                    returns empty result
     3. ERROR     : Both failed — logged with complexity analysis

   Configuration (set in server.js config block below):
     WIRIS_ENABLED = true/false
     WIRIS_TIMEOUT = milliseconds before falling back (default 5000)
================================================================ */

/* ── CONFIGURATION ─────────────────────────────────────────── */
const CONFIG = {
    // Set to true to use WIRIS as primary TeX engine
    // Set to false to use mathml-to-latex only (offline mode)
    WIRIS_ENABLED: true,

    // WIRIS demo endpoint — free, no API key needed
    // For production, replace with your licensed endpoint
    WIRIS_ENDPOINT: "https://www.wiris.net/demo/editor/mathml2latex",

    // Timeout in milliseconds — if WIRIS takes longer, use fallback
    WIRIS_TIMEOUT: 5000,

    // If true, log which engine was used for each equation
    LOG_ENGINE_USED: true
};

/* ── WIRIS API CALL ────────────────────────────────────────── */
async function callWirisAPI(mathmlStr) {
    return new Promise((resolve, reject) => {
        try {
            const url      = new URL(CONFIG.WIRIS_ENDPOINT);
            const postData = "mml=" + encodeURIComponent(mathmlStr);
            const isHttps  = url.protocol === "https:";
            const lib      = isHttps ? require("https") : require("http");

            const options = {
                hostname: url.hostname,
                port:     url.port || (isHttps ? 443 : 80),
                path:     url.pathname,
                method:   "POST",
                headers:  {
                    "Content-Type":   "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(postData)
                },
                timeout: CONFIG.WIRIS_TIMEOUT
            };

            const req = lib.request(options, (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data",  chunk => { data += chunk; });
                res.on("end",   ()    => {
                    const trimmed = data.trim();

                    // ── Detect WIRIS error responses ───────────────
                    // WIRIS returns HTTP 200 even for errors, with
                    // the error message as plain text response body
                    // Known WIRIS error response patterns
                    // WIRIS returns these as plain text with HTTP 200
                    const WIRIS_ERROR_PATTERNS = [
                        "error converting from mathml to latex",
                        "error converting",
                        "error processing",
                        "invalid mathml",
                        "cannot convert",
                        "conversion error",
                        "parse error",
                        "exception",
                        "error:",
                        "null",
                        "undefined"
                    ];

                    // Check both startsWith AND contains — WIRIS
                    // sometimes wraps the error in extra text
                    const lowerTrimmed = trimmed.toLowerCase();
                    const isWirisError = !trimmed ||
                        WIRIS_ERROR_PATTERNS.some(p =>
                            lowerTrimmed.startsWith(p) ||
                            lowerTrimmed.includes(p)
                        ) ||
                        // Extra safety: valid LaTeX must contain
                        // at least one letter or digit
                        !/[a-zA-Z0-9]/.test(trimmed);

                    if (res.statusCode === 200 && trimmed && !isWirisError) {
                        resolve(trimmed);
                    } else if (isWirisError) {
                        reject(new Error(`WIRIS conversion error: ${trimmed.substring(0, 100)}`));
                    } else {
                        reject(new Error(`WIRIS HTTP ${res.statusCode}: ${trimmed.substring(0, 100)}`));
                    }
                });
            });

            req.on("timeout", () => {
                req.destroy();
                reject(new Error(`WIRIS timeout after ${CONFIG.WIRIS_TIMEOUT}ms`));
            });

            req.on("error", (e) => reject(new Error(`WIRIS network error: ${e.message}`)));
            req.write(postData);
            req.end();

        } catch (e) {
            reject(new Error(`WIRIS call failed: ${e.message}`));
        }
    });
}

/* ── UNICODE DELIMITER MAP FOR mfenced ────────────────────── */
// Maps Unicode chars used in open/close attributes to their
// XML entity equivalents that both WIRIS and mathml-to-latex
// understand correctly
const DELIMITER_ENTITY_MAP = {
    // Vertical bars / pipes
    "∣":  "&#x007C;",    // U+2223 → | (vertical bar)
    "|":  "&#x007C;",    // U+007C → | (same)
    "‖":  "&#x2016;",   // double vertical bar
    // Angle brackets — all variants mapped to standard entities
    "⟨":  "&#x27E8;",   // U+27E8 math langle
    "⟩":  "&#x27E9;",   // U+27E9 math rangle
    "〈": "&#x27E8;", // U+2329 → langle
    "〉": "&#x27E9;", // U+232A → rangle
    "〈": "&#x27E8;", // U+3008 CJK → langle
    "〉": "&#x27E9;", // U+3009 CJK → rangle
    // Floor / ceiling
    "⌈":  "&#x2308;",
    "⌉":  "&#x2309;",
    "⌊":  "&#x230A;",
    "⌋":  "&#x230B;",
    // Braces / brackets
    "{":  "&#x007B;",
    "}":  "&#x007D;",
    // Empty — keep as-is
    "":   ""
};

/* ── POST-PROCESS TEX OUTPUT ───────────────────────────────── */
// Fixes known wrong conversions from WIRIS or mathml-to-latex:
//   - Raw Unicode chars left inside \left \right commands
//   - Raw Unicode Greek/operator symbols in output
function postProcessTeX(tex) {
    if (!tex) return tex;
    let t = tex;
    // Fix \left / \right with raw Unicode delimiters
    t = t.replace(/\\left\s*\u2223/g,  "\\\\left|");
    t = t.replace(/\\right\s*\u2223/g, "\\\\right|");
    t = t.replace(/\\left\s*\|/g,      "\\\\left|");
    t = t.replace(/\\right\s*\|/g,     "\\\\right|");
    t = t.replace(/\\left\s*\u27E8/g,  "\\\\left\\\\langle");
    t = t.replace(/\\right\s*\u27E9/g, "\\\\right\\\\rangle");
    t = t.replace(/\\left\s*\u2329/g,  "\\\\left\\\\langle");
    t = t.replace(/\\right\s*\u232A/g, "\\\\right\\\\rangle");
    t = t.replace(/\\left\s*\u3008/g,  "\\\\left\\\\langle");
    t = t.replace(/\\right\s*\u3009/g, "\\\\right\\\\rangle");
    t = t.replace(/\\left\s*\u2308/g,  "\\\\left\\\\lceil");
    t = t.replace(/\\right\s*\u2309/g, "\\\\right\\\\rceil");
    t = t.replace(/\\left\s*\u230A/g,  "\\\\left\\\\lfloor");
    t = t.replace(/\\right\s*\u230B/g, "\\\\right\\\\rfloor");
    // Fix raw Unicode operators
    t = t.replace(/\u2297/g, "\\\\otimes");
    t = t.replace(/\u2295/g, "\\\\oplus");
    t = t.replace(/\u2296/g, "\\\\ominus");
    t = t.replace(/\u2299/g, "\\\\odot");
    t = t.replace(/\u2211/g, "\\\\sum");
    t = t.replace(/\u220F/g, "\\\\prod");
    t = t.replace(/\u222B/g, "\\\\int");
    t = t.replace(/\u2202/g, "\\\\partial");
    t = t.replace(/\u2207/g, "\\\\nabla");
    t = t.replace(/\u221E/g, "\\\\infty");
    t = t.replace(/\u2264/g, "\\\\leq");
    t = t.replace(/\u2265/g, "\\\\geq");
    t = t.replace(/\u2260/g, "\\\\neq");
    t = t.replace(/\u2248/g, "\\\\approx");
    t = t.replace(/\u2192/g, "\\\\to");
    t = t.replace(/\u2190/g, "\\\\leftarrow");
    t = t.replace(/\u2194/g, "\\\\leftrightarrow");
    t = t.replace(/\u21D2/g, "\\\\Rightarrow");
    t = t.replace(/\u21D4/g, "\\\\Leftrightarrow");
    t = t.replace(/\u2208/g, "\\\\in");
    t = t.replace(/\u2209/g, "\\\\notin");
    t = t.replace(/\u222A/g, "\\\\cup");
    t = t.replace(/\u2229/g, "\\\\cap");
    t = t.replace(/\u2205/g, "\\\\emptyset");
    // Fix raw Unicode Greek letters
    t = t.replace(/\u03B1/g, "\\\\alpha");
    t = t.replace(/\u03B2/g, "\\\\beta");
    t = t.replace(/\u03B3/g, "\\\\gamma");
    t = t.replace(/\u03B4/g, "\\\\delta");
    t = t.replace(/\u03B5/g, "\\\\epsilon");
    t = t.replace(/\u03B8/g, "\\\\theta");
    t = t.replace(/\u03BB/g, "\\\\lambda");
    t = t.replace(/\u03BC/g, "\\\\mu");
    t = t.replace(/\u03BE/g, "\\\\xi");
    t = t.replace(/\u03C0/g, "\\\\pi");
    t = t.replace(/\u03C1/g, "\\\\rho");
    t = t.replace(/\u03C3/g, "\\\\sigma");
    t = t.replace(/\u03C4/g, "\\\\tau");
    t = t.replace(/\u03C6/g, "\\\\phi");
    t = t.replace(/\u03C7/g, "\\\\chi");
    t = t.replace(/\u03C8/g, "\\\\psi");
    t = t.replace(/\u03C9/g, "\\\\omega");
    t = t.replace(/\u0393/g, "\\\\Gamma");
    t = t.replace(/\u0394/g, "\\\\Delta");
    t = t.replace(/\u039B/g, "\\\\Lambda");
    t = t.replace(/\u03A3/g, "\\\\Sigma");
    t = t.replace(/\u03A6/g, "\\\\Phi");
    t = t.replace(/\u03A8/g, "\\\\Psi");
    t = t.replace(/\u03A9/g, "\\\\Omega");
    // Strip zero-width chars and clean spaces
    t = t.replace(/\u200D/g, "").replace(/\u200B/g, "");
    t = t.replace(/  +/g, " ").trim();
    return t;
}



/* ── MATHML STRING PREP (shared by both engines) ──────────── */
function prepareMathML(mathNode) {
    let mathmlStr = mathNode.outerHTML || "";
    if (!mathmlStr.trim().startsWith("<math") &&
        !mathmlStr.trim().startsWith("<mml:math")) {
        mathmlStr = `<math>${mathmlStr}</math>`;
    }
    // Strip mml: namespace — both engines expect plain <math>
    mathmlStr = mathmlStr
        .replace(/<mml:/g,  "<")
        .replace(/<\/mml:/g, "</");

    // Strip internal IDs — WIRIS can choke on them
    mathmlStr = mathmlStr.replace(/\s+id="[^"]*"/g, "");

    // Normalize Unicode delimiters in mfenced open/close attributes
    // e.g. open="∣" close="⟩" → open="&#x007C;" close="&#x27E9;"
    mathmlStr = mathmlStr.replace(
        /\b(open|close|separators)="([^"]*)"/g,
        (match, attr, val) => {
            let normalized = val;
            for (const [unicode, entity] of Object.entries(DELIMITER_ENTITY_MAP)) {
                if (unicode && normalized.includes(unicode)) {
                    normalized = normalized.split(unicode).join(entity);
                }
            }
            return `${attr}="${normalized}"`;
        }
    );

    // Also normalize Unicode in mo element content
    // e.g. <mo>∣</mo> should become <mo>|</mo>
    mathmlStr = mathmlStr
        .replace(/<mo([^>]*)>∣<\/mo>/g,  "<mo$1>|</mo>")
        .replace(/<mo([^>]*)>⟨<\/mo>/g,  "<mo$1>&#x27E8;</mo>")
        .replace(/<mo([^>]*)>⟩<\/mo>/g,  "<mo$1>&#x27E9;</mo>");

    // Ensure math tag has xmlns — required by WIRIS
    if (!mathmlStr.includes("xmlns")) {
        mathmlStr = mathmlStr.replace(
            /^<math/,
            '<math xmlns="http://www.w3.org/1998/Math/MathML"'
        );
    }

    return mathmlStr;
}

/* ── FALLBACK: mathml-to-latex ─────────────────────────────── */
function generateTeXFallback(mathmlStr, mathNode) {
    try {
        const tex = MathMLToLaTeX.convert(mathmlStr);
        if (!tex || tex.trim() === "") {
            const complexity = analyzeMathMLComplexity(mathNode);
            return {
                value:      "",
                status:     "WARN",
                engine:     "mathml-to-latex (fallback)",
                reason:     "mathml-to-latex returned empty string",
                complexity
            };
        }
        const cleanTex = postProcessTeX(tex);
        return {
            value:  cleanTex,
            status: "OK",
            engine: "mathml-to-latex (fallback)",
            reason: "",
            complexity: null
        };
    } catch (err) {
        const complexity = analyzeMathMLComplexity(mathNode);
        return {
            value:      "",
            status:     "ERROR",
            engine:     "mathml-to-latex (fallback)",
            reason:     err.message || String(err),
            complexity
        };
    }
}

/* ── MAIN generateTeX — async, tries WIRIS then falls back ── */
async function generateTeX(mathNode) {
    const mathmlStr = prepareMathML(mathNode);

    // ── WIRIS disabled — use mathml-to-latex directly ──────────
    if (!CONFIG.WIRIS_ENABLED) {
        const result = generateTeXFallback(mathmlStr, mathNode);
        if (CONFIG.LOG_ENGINE_USED)
            console.log(`  [TEX] mathml-to-latex (WIRIS disabled)`);
        return result;
    }

    // ── Try WIRIS first ────────────────────────────────────────
    try {
        const tex = await callWirisAPI(mathmlStr);

        if (!tex || tex.trim() === "") {
            // WIRIS returned empty — fall through to fallback
            console.log("  [TEX] WIRIS returned empty — falling back to mathml-to-latex");
            const fallback = generateTeXFallback(mathmlStr, mathNode);
            fallback.wirisAttempted = true;
            fallback.wirisResult    = "empty response";
            if (fallback.value) {
                console.log(`  [TEX] Fallback OK — ${fallback.value.substring(0,60)}${fallback.value.length > 60 ? "..." : ""}`);
            } else {
                console.log(`  [TEX] Fallback also failed — ${fallback.reason}`);
            }
            return fallback;
        }

        const cleanTex2 = postProcessTeX(tex);
        if (CONFIG.LOG_ENGINE_USED)
            console.log(`  [TEX] WIRIS OK — ${cleanTex2.substring(0, 60)}${cleanTex2.length > 60 ? "..." : ""}`);

        return {
            value:          cleanTex2,
            status:         "OK",
            engine:         "WIRIS/MathType API",
            reason:         "",
            complexity:     null,
            wirisAttempted: true,
            wirisResult:    "success"
        };

    } catch (wirisErr) {
        // ── WIRIS failed — automatically use mathml-to-latex ───
        console.log(`  [TEX] WIRIS failed: ${wirisErr.message}`);
        console.log(`  [TEX] Falling back to mathml-to-latex...`);

        const fallback = generateTeXFallback(mathmlStr, mathNode);
        fallback.wirisAttempted = true;
        fallback.wirisResult    = wirisErr.message;

        // Log fallback result clearly
        if (fallback.value) {
            console.log(`  [TEX] Fallback OK — ${fallback.value.substring(0,60)}${fallback.value.length > 60 ? "..." : ""}`);
        } else {
            console.log(`  [TEX] Fallback also failed [${fallback.status}] — ${fallback.reason}`);
        }

        return fallback;
    }
}

/* ================================================================
   ALT TEXT GENERATOR
================================================================ */

function generateAltText(mathNode) {
    function sym(t) { return ALT_SYMBOLS[t] !== undefined ? ALT_SYMBOLS[t] : t; }

    function walk(node) {
        if (!node) return "";
        if (node.nodeType === 3) return sym(node.textContent.trim());

        const tag  = node.nodeName.replace(/^mml:/i, "").toLowerCase();
        const kids = [...node.childNodes];
        const ch   = [...(node.children || [])];

        switch (tag) {
            case "math": case "mrow": case "mstyle":
            case "merror": case "mpadded": case "mphantom":
                return kids.map(walk).filter(Boolean).join(" ");
            case "semantics": return ch.length ? walk(ch[0]) : "";
            case "mi": case "mn": return sym(node.textContent.trim());
            case "mo": {
                const t = node.textContent.trim();
                if (!t || t === "\u200D" || t === "\u200B") return "";
                return sym(t);
            }
            case "mtext": return node.textContent.trim();
            case "ms":    return `"${node.textContent.trim()}"`;
            case "mspace": return "";
            case "msup": {
                if (ch.length < 2) return walk(ch[0] || node);
                const s = ch[1].textContent.trim();
                if (s === "2")  return `${walk(ch[0])} squared`;
                if (s === "3")  return `${walk(ch[0])} cubed`;
                if (s === "-1") return `${walk(ch[0])} inverse`;
                return `${walk(ch[0])} to the power ${walk(ch[1])}`;
            }
            case "msub":
                if (ch.length < 2) return walk(ch[0] || node);
                return `${walk(ch[0])} sub ${walk(ch[1])}`;
            case "msubsup":
                if (ch.length < 3) return walk(ch[0] || node);
                return `${walk(ch[0])} sub ${walk(ch[1])} superscript ${walk(ch[2])}`;
            case "munder": {
                const b = ch[0] ? ch[0].textContent.trim() : "";
                if (["∑","∏","lim","max","min","sup","inf"].includes(b))
                    return `${walk(ch[0])} from ${walk(ch[1])}`;
                return `${walk(ch[0])} under ${walk(ch[1])}`;
            }
            case "mover": {
                const a = ch[1] ? ch[1].textContent.trim() : "";
                const acc = {"→":"vector","⟶":"vector","˙":"dot","¨":"double dot","˜":"tilde","^":"hat","ˆ":"hat","ˉ":"bar","‾":"bar"};
                if (acc[a]) return `${acc[a]} ${walk(ch[0])}`;
                return `${walk(ch[0])} over ${walk(ch[1])}`;
            }
            case "munderover": {
                const op = ch[0] ? ch[0].textContent.trim() : "";
                if (["∑","∏","∫","∬","∭","∮","lim"].includes(op))
                    return `${walk(ch[0])} from ${walk(ch[1])} to ${walk(ch[2])}`;
                return `${walk(ch[0])} from ${walk(ch[1])} to ${walk(ch[2])}`;
            }
            case "mfrac": {
                const lt = node.getAttribute("linethickness") || "";
                if (lt === "0") return `${walk(ch[0])} choose ${walk(ch[1])}`;
                return `the fraction with numerator ${walk(ch[0])} and denominator ${walk(ch[1])}`;
            }
            case "msqrt": return `square root of ${kids.map(walk).join(" ")}`;
            case "mroot": return `${walk(ch[1])}th root of ${walk(ch[0])}`;
            case "mfenced": {
                const open  = node.getAttribute("open")  ?? "(";
                const close = node.getAttribute("close") ?? ")";
                function rd(d) {
                    if (!d) return "";
                    if (ALT_SYMBOLS[d] !== undefined) return ALT_SYMBOLS[d];
                    const c = String.fromCodePoint(d.codePointAt(0));
                    return ALT_SYMBOLS[c] !== undefined ? ALT_SYMBOLS[c] : d;
                }
                return `${rd(open)} ${ch.map(walk).join(", ")} ${rd(close)}`;
            }
            case "mtable": {
                const rows = ch.map((row, ri) => {
                    const cells = [...(row.children || [])].map((td, ci) => `row ${ri+1} column ${ci+1}: ${walk(td)}`);
                    return cells.join("; ");
                }).join(". ");
                return `matrix: ${rows}`;
            }
            case "mtr":  return ch.map(walk).join(", ");
            case "mtd":  return kids.map(walk).join(" ");
            case "mmultiscripts": {
                if (ch.length < 1) return "";
                const parts = [walk(ch[0])];
                for (let i = 1; i < ch.length; i += 2) {
                    if (ch[i] && ch[i].nodeName.toLowerCase() === "mprescripts") continue;
                    if (ch[i])   parts.push(`sub ${walk(ch[i])}`);
                    if (ch[i+1]) parts.push(`superscript ${walk(ch[i+1])}`);
                }
                return parts.join(" ");
            }
            case "annotation": case "annotation-xml": return "";
            default: return kids.map(walk).filter(Boolean).join(" ");
        }
    }
    try {
        const result = walk(mathNode).replace(/\s{2,}/g, " ").trim();
        if (!result) {
            const complexity = analyzeMathMLComplexity(mathNode);
            return { value: "", status: "WARN", reason: "AltText walker returned empty string", complexity };
        }
        return { value: result, status: "OK", reason: "", complexity: null };
    } catch (err) {
        const complexity = analyzeMathMLComplexity(mathNode);
        return { value: "", status: "ERROR", reason: err.message || String(err), complexity };
    }
}


/* ================================================================
   LOG FILE BUILDER
   Produces a detailed processing log per equation:
   - SUCCESS: TeX and AltText both converted OK
   - WARN:    Conversion returned empty but no error thrown
   - ERROR:   Conversion threw an exception
   Summary counts at top and bottom.
================================================================ */

function buildLog(equations, filename, timestamp) {
    const SEP  = "=".repeat(72);
    const DIV  = "-".repeat(72);
    const SUB  = "~".repeat(72);
    const now  = new Date().toLocaleString();

    // ── Count statuses ────────────────────────────────────────────
    const total       = equations.length;
    const texOK       = equations.filter(e => e.texStatus === "OK").length;
    const texWarn     = equations.filter(e => e.texStatus === "WARN").length;
    const texError    = equations.filter(e => e.texStatus === "ERROR").length;
    const altOK       = equations.filter(e => e.altStatus === "OK").length;
    const altWarn     = equations.filter(e => e.altStatus === "WARN").length;
    const altError    = equations.filter(e => e.altStatus === "ERROR").length;
    const withImg     = equations.filter(e => e.hasImg).length;
    const withoutImg  = total - withImg;
    const failedEqs   = equations.filter(e => e.texStatus !== "OK" || e.altStatus !== "OK");
    const allOK       = failedEqs.length === 0;

    // Complexity distribution
    const cxLow      = equations.filter(e => e.complexity && e.complexity.level === "LOW").length;
    const cxMedium   = equations.filter(e => e.complexity && e.complexity.level === "MEDIUM").length;
    const cxHigh     = equations.filter(e => e.complexity && e.complexity.level === "HIGH").length;
    const cxVeryHigh = equations.filter(e => e.complexity && e.complexity.level === "VERY HIGH").length;

    const lines = [];

    // ── HEADER ────────────────────────────────────────────────────
    lines.push(SEP);
    lines.push("  MathMLtoTeXandAltText — Processing Log");
    lines.push(SEP);
    lines.push(`  Input File : ${filename}`);
    lines.push(`  Processed  : ${now}`);
    lines.push(SEP);
    lines.push("");

    // ── SECTION 1: SUMMARY ────────────────────────────────────────
    lines.push("  [SECTION 1]  SUMMARY");
    lines.push(DIV);
    lines.push("");
    lines.push(`  Total Equations Found    : ${total}`);
    lines.push(`  With IMG tag  (XML+TXT)  : ${withImg}`);
    lines.push(`  Without IMG tag (TXT)    : ${withoutImg}`);
    lines.push("");
    lines.push(`  TeX Conversion Results`);
    lines.push(`    [OK]   Success   : ${texOK}`);
    lines.push(`    [WARN] Warning   : ${texWarn}  (converted but may be incomplete)`);
    lines.push(`    [FAIL] Error     : ${texError}  (conversion failed)`);
    lines.push("");
    lines.push(`  AltText Generation Results`);
    lines.push(`    [OK]   Success   : ${altOK}`);
    lines.push(`    [WARN] Warning   : ${altWarn}  (generated but may be incomplete)`);
    lines.push(`    [FAIL] Error     : ${altError}  (generation failed)`);
    lines.push("");
    lines.push(`  MathML Complexity Distribution`);
    lines.push(`    LOW       : ${cxLow}   (simple, 1-2 levels deep)`);
    lines.push(`    MEDIUM    : ${cxMedium}   (moderate, 3-4 levels deep)`);
    lines.push(`    HIGH      : ${cxHigh}   (complex, nested structures)`);
    lines.push(`    VERY HIGH : ${cxVeryHigh}   (very complex, possible conversion issues)`);
    lines.push("");

    if (allOK) {
        lines.push(`  OVERALL STATUS : SUCCESS`);
        lines.push(`  All ${total} equations converted successfully with no errors.`);
    } else {
        lines.push(`  OVERALL STATUS : COMPLETED WITH ISSUES`);
        lines.push(`  ${failedEqs.length} of ${total} equations had conversion problems.`);
        lines.push(`  See Section 3 for details and MathML structure analysis.`);
    }
    lines.push("");
    lines.push(DIV);
    lines.push("");

    // ── SECTION 2: ALL EQUATIONS (full detail) ────────────────────
    lines.push("  [SECTION 2]  ALL EQUATIONS — FULL DETAIL");
    lines.push(DIV);
    lines.push("");

    equations.forEach((eq, i) => {
        const num      = String(i + 1).padStart(3, "0");
        const texIcon  = eq.texStatus === "OK" ? "[OK  ]" : eq.texStatus === "WARN" ? "[WARN]" : "[FAIL]";
        const altIcon  = eq.altStatus === "OK" ? "[OK  ]" : eq.altStatus === "WARN" ? "[WARN]" : "[FAIL]";
        const cx       = eq.complexity || {};
        const cxLabel  = cx.level || "N/A";
        const imgLine  = eq.hasImg ? "YES — tex + alttext written to img tag" : "NO  — TXT output only";

        const engineUsed = eq.engine || "mathml-to-latex";
        const wirisInfo  = eq.wirisAttempted
            ? (eq.wirisResult === "success" ? "WIRIS used" : `WIRIS failed → fallback used (${eq.wirisResult ? eq.wirisResult.substring(0,60) : "unknown"})`)
            : "mathml-to-latex only";

        lines.push(`  [${num}] ${eq.type}  |  Format: ${eq.format}  |  ID: ${eq.id}`);
        lines.push(`         IMG Tag       : ${imgLine}`);
        lines.push(`         Engine        : ${engineUsed}  [${wirisInfo}]`);
        lines.push(`         Complexity    : ${cxLabel}  (depth: ${cx.maxDepth || 0}, nodes: ${cx.totalNodes || 0})`);
        lines.push(`         TeX  ${texIcon} : ${
            eq.texStatus === "OK"
                ? (eq.tex.length > 80 ? eq.tex.substring(0,80) + "..." : eq.tex)
                : `FAILED — ${eq.texReason || "unknown error"}`
        }`);
        lines.push(`         Alt  ${altIcon} : ${
            eq.altStatus === "OK"
                ? (eq.alt.length > 80 ? eq.alt.substring(0,80) + "..." : eq.alt)
                : `FAILED — ${eq.altReason || "unknown error"}`
        }`);
        lines.push("");
    });

    lines.push(DIV);
    lines.push("");

    // ── SECTION 3: FAILED / WARNED EQUATIONS (detailed analysis) ──
    if (failedEqs.length > 0) {
        lines.push("  [SECTION 3]  EQUATIONS WITH ISSUES — COMPLEXITY ANALYSIS");
        lines.push("  Use this section to investigate and fix conversion failures.");
        lines.push(DIV);
        lines.push("");

        failedEqs.forEach((eq, i) => {
            const cx    = eq.complexity || {};
            const issue = String(i + 1).padStart(2, "0");

            lines.push(`  ISSUE [${issue}]`);
            lines.push(SUB);
            lines.push(`  Equation Number : ${equations.indexOf(eq) + 1} of ${total}`);
            lines.push(`  Type            : ${eq.type}`);
            lines.push(`  Format          : ${eq.format}`);
            lines.push(`  ID              : ${eq.id}`);
            lines.push(`  IMG Tag         : ${eq.hasImg ? "YES" : "NO"}`);
            lines.push("");

            // ── TeX failure details ────────────────────────────────
            if (eq.texStatus !== "OK") {
                lines.push(`  TeX Conversion  : ${eq.texStatus}`);
                lines.push(`  TeX Error       : ${eq.texReason || "empty result — no error thrown"}`);
                lines.push("");
            }

            // ── AltText failure details ────────────────────────────
            if (eq.altStatus !== "OK") {
                lines.push(`  Alt Generation  : ${eq.altStatus}`);
                lines.push(`  Alt Error       : ${eq.altReason || "empty result — no error thrown"}`);
                lines.push("");
            }

            // ── MathML Complexity Analysis ─────────────────────────
            lines.push(`  MATHML COMPLEXITY ANALYSIS`);
            lines.push(`  Complexity Level  : ${cx.level || "N/A"}`);
            lines.push(`  Max Nesting Depth : ${cx.maxDepth || 0}`);
            lines.push(`  Total Node Count  : ${cx.totalNodes || 0}`);
            lines.push("");

            if (cx.reasons && cx.reasons.length > 0) {
                lines.push(`  Complexity Reasons:`);
                cx.reasons.forEach(r => lines.push(`    - ${r}`));
                lines.push("");
            }

            if (cx.uniqueElements && cx.uniqueElements.length > 0) {
                lines.push(`  MathML Elements Used (${cx.uniqueElements.length} unique):`);
                // Show with counts
                const elemList = cx.uniqueElements.map(e => `${e}(${cx.elementCounts[e] || 1})`);
                lines.push(`    ${elemList.join(", ")}`);
                lines.push("");
            }

            if (cx.unsupportedElements && cx.unsupportedElements.length > 0) {
                lines.push(`  UNSUPPORTED ELEMENTS (likely caused failure):`);
                cx.unsupportedElements.forEach(e => lines.push(`    ! <${e}> — not handled by mathml-to-latex`));
                lines.push("");
            }

            if (cx.complexElements && cx.complexElements.length > 0) {
                lines.push(`  COMPLEX ELEMENTS (may cause issues):`);
                cx.complexElements.forEach(e => lines.push(`    ~ <${e}> — complex/rare element`));
                lines.push("");
            }

            // ── Full MathML for debugging ──────────────────────────
            lines.push(`  FULL MATHML (for debugging):`);
            // Wrap at 80 chars for readability
            const ml = eq.mathml || "";
            const chunkSize = 80;
            for (let c = 0; c < ml.length; c += chunkSize) {
                lines.push(`  ${ml.substring(c, c + chunkSize)}`);
            }
            lines.push("");
            lines.push(SUB);
            lines.push("");
        });

    } else {
        lines.push("  [SECTION 3]  EQUATIONS WITH ISSUES");
        lines.push(DIV);
        lines.push("");
        lines.push("  No issues found — all equations converted successfully.");
        lines.push("");
        lines.push(DIV);
        lines.push("");
    }

    // ── SECTION 4: COMPLEXITY OVERVIEW ───────────────────────────
    const veryHighEqs = equations.filter(e => e.complexity && e.complexity.level === "VERY HIGH");
    if (veryHighEqs.length > 0) {
        lines.push("  [SECTION 4]  VERY HIGH COMPLEXITY EQUATIONS");
        lines.push("  These converted OK but have complex structure —");
        lines.push("  verify the TeX output renders correctly.");
        lines.push(DIV);
        lines.push("");
        veryHighEqs.forEach((eq, i) => {
            const cx = eq.complexity || {};
            lines.push(`  [${String(i+1).padStart(2,"0")}] ID: ${eq.id}  |  ${eq.type}`);
            lines.push(`       TeX Status   : ${eq.texStatus}`);
            lines.push(`       Depth/Nodes  : ${cx.maxDepth} / ${cx.totalNodes}`);
            lines.push(`       Reasons      : ${(cx.reasons || []).join("; ")}`);
            lines.push(`       Elements     : ${(cx.uniqueElements || []).join(", ")}`);
            if (cx.unsupportedElements && cx.unsupportedElements.length > 0)
                lines.push(`       ! Unsupported : ${cx.unsupportedElements.join(", ")}`);
            lines.push("");
        });
        lines.push(DIV);
        lines.push("");
    }

    // ── FOOTER ────────────────────────────────────────────────────
    lines.push(SEP);
    lines.push(`  End of Log`);
    lines.push(`  File    : ${filename}`);
    lines.push(`  Time    : ${now}`);
    lines.push(`  Total   : ${total} equations  |  Issues: ${failedEqs.length}  |  Status: ${allOK ? "SUCCESS" : "ISSUES FOUND"}`);
    lines.push(SEP);

    return lines.join("\n");
}

/* ================================================================
   CORE PROCESSOR
   Returns: { equations[], txtContent, xmlContent|null }

   XML modification rules:
   - If <inline-graphic> or <graphic> exists inside the formula:
       → Add tex="" and alttext="" attributes to the img tag
       → Return modified XML
   - If no img tag found anywhere in any formula:
       → Return xmlContent as null (TXT only)
================================================================ */

async function processXML(rawXML, filename) {
    // Parse DOM
    const dom      = new JSDOM(rawXML, { contentType: "application/xml" });
    const document = dom.window.document;

    const equations = [];
    let   xmlModified = false;

    // ── Helper: process one formula element ──────────────────────
    async function processFormula(eq, type, format, idFallback) {
        const math = eq.querySelector("math") || eq.querySelector("*|math");
        if (!math) return;

        const id     = eq.getAttribute("id") || eq.getAttribute("ID") || idFallback;
        const texRes = await generateTeX(math);
        const altRes = generateAltText(math);

        const tex = texRes.value;
        const alt = altRes.value;

        // Find img tag — search all variants
        const imgEl =
            eq.querySelector("inline-graphic")    ||
            eq.querySelector("graphic")            ||
            eq.querySelector("span.eqnimg img")    ||
            eq.querySelector("img.inlinegraphic")  ||
            eq.querySelector("img");

        if (imgEl) {
            // Clean up stale error values from previous runs
            const existingTex2 = imgEl.getAttribute("tex") || "";
            const hasStaleError2 = ["error converting","error processing","invalid mathml"]
                .some(e => existingTex2.toLowerCase().includes(e));
            if (hasStaleError2) imgEl.removeAttribute("tex");

            // Only write if conversion succeeded
            if (tex && texRes.status === "OK") {
                imgEl.setAttribute("tex", tex);
                xmlModified = true;
            } else {
                imgEl.removeAttribute("tex");
                xmlModified = true;
            }
            if (alt && altRes.status === "OK") {
                imgEl.setAttribute("alttext", alt);
            }
            console.log(`  [${texRes.status === "OK" ? "OK" : "WARN"}] img updated — ${type} ID:${id} | engine: ${texRes.engine || "mathml-to-latex"}`);
        }

        // Always run complexity analysis — store it for log reporting
        const complexity = analyzeMathMLComplexity(math);

        equations.push({
            type, format, id, tex, alt,
            mathml:        math.outerHTML,
            hasImg:        !!imgEl,
            texStatus:     texRes.status,
            texReason:     texRes.reason,
            texComplexity: texRes.complexity || complexity,
            altStatus:     altRes.status,
            altReason:     altRes.reason,
            altComplexity: altRes.complexity || null,
            complexity,
            engine:        texRes.engine        || "mathml-to-latex",
            wirisAttempted: texRes.wirisAttempted || false,
            wirisResult:    texRes.wirisResult    || ""
        });
    }

    // ── FORMAT 1: JATS inline-formula ────────────────────────────
    for (const [i, eq] of [...document.querySelectorAll("inline-formula")].entries()) {
        await processFormula(eq, "Inline Equation", "JATS", `inline-${i+1}`);
    }

    // ── FORMAT 1: JATS disp-formula ──────────────────────────────
    for (const [i, eq] of [...document.querySelectorAll("disp-formula")].entries()) {
        await processFormula(eq, "Display Equation", "JATS", `disp-${i+1}`);
    }

    // ── FORMAT 2: Springer ────────────────────────────────────────
    for (const [i, eq] of [...document.querySelectorAll("InlineEquation, Equation")].entries()) {
        const math = eq.querySelector("math") || eq.querySelector("*|math");
        if (!math) return;
        let label = "";
        if (eq.tagName === "InlineEquation") {
            label = eq.getAttribute("ID") || `inline-${i+1}`;
        } else {
            const num = eq.querySelector("EquationNumber");
            label = num ? num.textContent.trim() : (eq.getAttribute("ID") || `eq-${i+1}`);
        }
        let texVal = "";
        let texStatus = "OK", texReason = "";
        const texNode = eq.querySelector('EquationSource[Format="TEX"]');
        if (texNode && texNode.firstChild && texNode.firstChild.nodeValue.trim()) {
            texVal = texNode.firstChild.nodeValue.trim();
            texStatus = "OK"; texReason = "from EquationSource[Format=TEX]";
        }
        if (!texVal) {
            const texRes = await generateTeX(math);
            texVal = texRes.value; texStatus = texRes.status; texReason = texRes.reason;
        }
        const altRes = generateAltText(math);
        const imgEl  =
            eq.querySelector("inline-graphic")   ||
            eq.querySelector("graphic")           ||
            eq.querySelector("span.eqnimg img")   ||
            eq.querySelector("img.inlinegraphic") ||
            eq.querySelector("img");
        if (imgEl) {
            if (texVal && texStatus === "OK")        imgEl.setAttribute("tex",     texVal);
            if (altRes.value && altRes.status === "OK") imgEl.setAttribute("alttext", altRes.value);
            xmlModified = true;
        }
        equations.push({
            type:      eq.tagName === "InlineEquation" ? "Inline Equation" : "Display Equation",
            format:    "Springer", id: label,
            tex:       texVal,
            alt:       altRes.value,
            mathml:    math.outerHTML,
            hasImg:    !!imgEl,
            texStatus, texReason,
            altStatus: altRes.status,
            altReason: altRes.reason
        });
    }

    // ── FORMAT 3: HTML span ───────────────────────────────────────
    // Handles this structure:
    //   <span class="inline" type="eqn" data-id="IEq33">
    //     <span class="mathml"><math>...</math></span>   <- math here
    //     <span class="eqnimg"><img tex="" alttext=""/>  <- img here
    //   </span>
    for (const [i, eq] of [...document.querySelectorAll("span.inline[type='eqn'], span.display[type='eqn']")].entries()) {

        // Find math — may be direct child OR inside span.mathml wrapper
        const math = eq.querySelector("math");
        if (!math) continue;

        const texRes2 = await generateTeX(math);
        const altRes2 = generateAltText(math);

        // Find img tag — search all variants:
        // 1. <inline-graphic>           — JATS style inside HTML
        // 2. <graphic>                  — JATS display style
        // 3. <img> inside span.eqnimg   — MPS/Springer HTML inline
        // 4. <img class="displaygraphic">— MPS/Springer HTML display
        // 5. <img class="inlinegraphic"> — MPS/Springer HTML inline
        // 6. any <img> anywhere inside the span
        const imgEl =
            eq.querySelector("inline-graphic")           ||
            eq.querySelector("graphic")                  ||
            eq.querySelector("span.eqnimg img")          ||
            eq.querySelector("span.eqnimg > img")        ||
            eq.querySelector("img.displaygraphic")       ||
            eq.querySelector("img.inlinegraphic")        ||
            eq.querySelector(".inlinegraphic")            ||
            eq.querySelector(".displaygraphic")           ||
            eq.querySelector("img");

        if (imgEl) {
            // Clean up any stale/error values written by previous runs
            const existingTex = imgEl.getAttribute("tex") || "";
            const WIRIS_ERROR_STRINGS = [
                "error converting from mathml to latex",
                "error converting",
                "error processing",
                "invalid mathml",
                "cannot convert"
            ];
            const hasStaleError = WIRIS_ERROR_STRINGS.some(e =>
                existingTex.toLowerCase().includes(e)
            );
            if (hasStaleError) {
                imgEl.removeAttribute("tex");
                console.log(`  [CLEAN] Removed stale error tex from img ID:${imgEl.getAttribute("id") || "?"}`);
            }

            // Only write if conversion succeeded — never write error strings
            if (texRes2.value && texRes2.status === "OK") {
                imgEl.setAttribute("tex", texRes2.value);
                xmlModified = true;
            } else if (!texRes2.value || texRes2.status !== "OK") {
                // Conversion failed — remove any existing tex attribute
                // so it doesn't contain a stale error value
                imgEl.removeAttribute("tex");
                xmlModified = true;
                console.log(`  [WARN] TeX conversion failed for img ID:${imgEl.getAttribute("id") || "?"} — tex attribute removed`);
            }

            if (altRes2.value && altRes2.status === "OK") {
                imgEl.setAttribute("alttext", altRes2.value);
            }

            const eqId = eq.getAttribute("data-id") || eq.getAttribute("id") || "?";
            if (texRes2.status === "OK") {
                console.log(`  [OK] img updated — HTML ID:${eqId} | tex: ${texRes2.value.substring(0,50)}${texRes2.value.length>50?"...":""}`);
            } else {
                console.log(`  [WARN] img tex failed — HTML ID:${eqId} | engine: ${texRes2.engine} | reason: ${texRes2.reason}`);
            }
        }

        equations.push({
            type:      eq.classList.contains("display") ? "Display Equation" : "Inline Equation",
            format:    "HTML",
            id:        eq.getAttribute("data-id") || eq.getAttribute("id") || `eq-${i+1}`,
            tex:       texRes2.value,
            alt:       altRes2.value,
            mathml:    math.outerHTML,
            hasImg:    !!imgEl,
            texStatus: texRes2.status, texReason: texRes2.reason,
            altStatus: altRes2.status, altReason: altRes2.reason,
            engine:    texRes2.engine   || "mathml-to-latex",
            wirisAttempted: texRes2.wirisAttempted || false,
            wirisResult:    texRes2.wirisResult    || ""
        });
    }

    // ── FORMAT 4: Bare math fallback ──────────────────────────────
    if (equations.length === 0) {
        for (const [i, math] of [...document.querySelectorAll("math")].entries()) {
            const texRes3 = await generateTeX(math);
            const altRes3 = generateAltText(math);
            equations.push({
                type:      math.getAttribute("display") === "block" ? "Display Equation" : "Inline Equation",
                format:    "bare",
                id:        math.getAttribute("id") || `eq-${i+1}`,
                tex:       texRes3.value,
                alt:       altRes3.value,
                mathml:    math.outerHTML,
                hasImg:    false,
                texStatus: texRes3.status, texReason: texRes3.reason,
                altStatus: altRes3.status, altReason: altRes3.reason
            });
        }
    }

    // ── Build TXT content ─────────────────────────────────────────
    const SEP = "=".repeat(64);
    const DIV = "-".repeat(64);
    const wirisUsed  = equations.filter(e => e.engine && e.engine.includes("WIRIS")).length;
    const fallbackUsed = equations.filter(e => e.engine && e.engine.includes("fallback")).length;
    const texEngine  = CONFIG.WIRIS_ENABLED
        ? `WIRIS/MathType API (primary) + mathml-to-latex (fallback) — WIRIS: ${wirisUsed}, Fallback: ${fallbackUsed}`
        : "mathml-to-latex (WIRIS disabled)";

    const txtLines = [
        SEP,
        "  MathMLtoTeXandAltText — Output",
        `  Source  : ${filename}`,
        `  Found   : ${equations.length} equation(s)`,
        `  Date    : ${new Date().toLocaleString()}`,
        `  TeX via : ${texEngine}`,
        `  Alt via : Comprehensive recursive walker`,
        SEP, ""
    ];

    equations.forEach((eq, i) => {
        txtLines.push(DIV);
        txtLines.push(`  [${String(i+1).padStart(3,"0")}]  ${eq.type}   |  Format: ${eq.format}   |  ID: ${eq.id}   |  IMG: ${eq.hasImg ? "YES — tex/alttext added to img tag" : "NO — TXT only"}`);
        txtLines.push(DIV);
        txtLines.push("");
        txtLines.push("TeX:");
        txtLines.push(eq.tex || "(none)");
        txtLines.push("");
        txtLines.push("Alt Text:");
        txtLines.push(eq.alt || "(none)");
        txtLines.push("");
        txtLines.push("MathML:");
        txtLines.push(eq.mathml || "(none)");
        txtLines.push("");
    });

    txtLines.push(SEP);
    txtLines.push("  End of Output");
    txtLines.push(SEP);

    // ── Build modified XML (only if at least one img tag was found) ─
    let xmlContent = null;
    if (xmlModified) {
        try {
            // Serialize DOM back to XML string
            const serializer = new dom.window.XMLSerializer();
            xmlContent = serializer.serializeToString(document);
            console.log(`[OK] XML serialized — length: ${xmlContent.length} chars`);
        } catch(e) {
            console.error(`[ERROR] XML serialization failed: ${e.message}`);
            xmlContent = null;
        }
    }

    console.log(`[INFO] Processing complete — equations: ${equations.length}, xmlModified: ${xmlModified}, hasImgCount: ${equations.filter(e=>e.hasImg).length}`);

    // ── Build log content ────────────────────────────────────────
    const logContent = buildLog(equations, filename, Date.now());

    return {
        equations,
        txtContent:  txtLines.join("\n"),
        xmlContent,
        xmlModified,
        logContent
    };
}

/* ================================================================
   API ROUTES
================================================================ */

// ── GET / — API info and usage ───────────────────────────────────
app.get("/", (req, res) => {
    res.json({
        name:    "MathMLtoTeXandAltText API",
        version: "1.0.0",
        endpoints: {
            "POST /process": {
                description: "Upload an XML file to extract and convert MathML equations",
                input:       "multipart/form-data — field name: 'file' (.xml only)",
                output:      "JSON with download URLs for TXT and optionally XML"
            },
            "GET /download/:filename": {
                description: "Download a processed output file"
            },
            "GET /health": {
                description: "Health check"
            }
        },
        rules: {
            "TXT file":  "Always returned — contains TeX, AltText, MathML for every equation",
            "XML file":  "Returned ONLY if the input XML has <inline-graphic> or <graphic> tags inside equation elements",
            "img tags":  "tex='' and alttext='' attributes are added to existing <inline-graphic>/<graphic> tags"
        }
    });
});

// ── GET /ui — browser upload page ────────────────────────────────
app.get("/ui", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MathMLtoTeXandAltText</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Segoe UI, Arial, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: white; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); padding: 40px; width: 600px; max-width: 95vw; }
  h1 { font-size: 22px; color: #1a1a2e; margin-bottom: 6px; }
  .sub { color: #666; font-size: 14px; margin-bottom: 30px; }
  .drop-zone { border: 2px dashed #4a90d9; border-radius: 8px; padding: 40px 20px; text-align: center; cursor: pointer; transition: all 0.2s; background: #f8fbff; margin-bottom: 20px; }
  .drop-zone:hover, .drop-zone.dragover { border-color: #1a6bbf; background: #e8f3ff; }
  .drop-zone .icon { font-size: 48px; margin-bottom: 10px; }
  .drop-zone p { color: #555; font-size: 15px; }
  .drop-zone span { color: #4a90d9; font-weight: 600; }
  #fileInput { display: none; }
  #fileName { margin: 10px 0 20px; color: #333; font-size: 14px; min-height: 20px; text-align: center; }
  .btn { width: 100%; padding: 14px; background: #4a90d9; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
  .btn:hover { background: #1a6bbf; }
  .btn:disabled { background: #aaa; cursor: not-allowed; }
  .progress { display: none; margin-top: 20px; text-align: center; color: #555; }
  .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid #ddd; border-top-color: #4a90d9; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 8px; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .result { display: none; margin-top: 24px; }
  .result-box { background: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .result-box h3 { font-size: 15px; color: #333; margin-bottom: 12px; }
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .stat { background: white; border-radius: 6px; padding: 12px; border: 1px solid #e0e0e0; text-align: center; }
  .stat .num { font-size: 28px; font-weight: 700; color: #4a90d9; }
  .stat .lbl { font-size: 12px; color: #888; margin-top: 2px; }
  .stat.ok .num { color: #28a745; }
  .stat.warn .num { color: #f0ad4e; }
  .stat.fail .num { color: #dc3545; }
  .dl-btn { display: block; width: 100%; padding: 11px 16px; margin-bottom: 8px; background: white; border: 1.5px solid #4a90d9; color: #4a90d9; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; text-align: center; transition: all 0.2s; }
  .dl-btn:hover { background: #4a90d9; color: white; }
  .dl-btn.xml { border-color: #28a745; color: #28a745; }
  .dl-btn.xml:hover { background: #28a745; color: white; }
  .dl-btn.log { border-color: #f0ad4e; color: #f0ad4e; }
  .dl-btn.log:hover { background: #f0ad4e; color: white; }
  .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  .status-ok { background: #d4edda; color: #155724; }
  .status-issues { background: #fff3cd; color: #856404; }
  .error-box { background: #fde8e8; border: 1px solid #f5c6cb; border-radius: 8px; padding: 16px; color: #721c24; margin-top: 16px; display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>MathMLtoTeXandAltText</h1>
  <p class="sub">Upload an XML file to extract TeX, AltText and update img tags</p>

  <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
    <div class="icon">📄</div>
    <p>Drag & drop your XML file here</p>
    <p>or <span>click to browse</span></p>
  </div>
  <input type="file" id="fileInput" accept=".xml">
  <div id="fileName">No file selected</div>

  <button class="btn" id="processBtn" onclick="processFile()" disabled>Process File</button>

  <div class="progress" id="progress">
    <span class="spinner"></span> Processing equations...
  </div>

  <div class="error-box" id="errorBox"></div>

  <div class="result" id="result">
    <div class="result-box">
      <h3>Processing Complete</h3>
      <div id="statusBadge"></div>
      <div class="stat-grid" id="statGrid"></div>
    </div>
    <div class="result-box">
      <h3>Download Output Files</h3>
      <div id="dlButtons"></div>
    </div>
  </div>
</div>

<script>
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  let selectedFile = null;

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.xml')) setFile(f);
    else showError('Please drop an XML file.');
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });

  function setFile(f) {
    selectedFile = f;
    document.getElementById('fileName').textContent = '\u2713 ' + f.name + '  (' + (f.size / 1024).toFixed(1) + ' KB)';
    document.getElementById('processBtn').disabled = false;
    document.getElementById('result').style.display = 'none';
    document.getElementById('errorBox').style.display = 'none';
  }

  async function processFile() {
    if (!selectedFile) return;
    document.getElementById('processBtn').disabled = true;
    document.getElementById('progress').style.display = 'block';
    document.getElementById('result').style.display = 'none';
    document.getElementById('errorBox').style.display = 'none';

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const resp = await fetch('/process', { method: 'POST', body: formData });
      const data = await resp.json();

      document.getElementById('progress').style.display = 'none';

      if (!data.success) { showError(data.error || 'Processing failed'); return; }

      const stats = data.conversionStats || {};
      const tex   = stats.tex   || {};
      const alt   = stats.altText || {};
      const allOK = (tex.errors || 0) === 0 && (alt.errors || 0) === 0 && (tex.warnings || 0) === 0;

      document.getElementById('statusBadge').innerHTML =
        '<span class="status-badge ' + (allOK ? 'status-ok' : 'status-issues') + '">' +
        (allOK ? '\u2713 All equations converted successfully' : '\u26a0 Completed with issues — check log') +
        '</span>';

      document.getElementById('statGrid').innerHTML =
        stat(stats.total || 0, 'Total Equations', '') +
        stat(stats.withImgTag || 0, 'IMG Tags Updated', 'ok') +
        stat(tex.success || 0, 'TeX Success', 'ok') +
        stat((tex.errors || 0) + (tex.warnings || 0), 'TeX Issues', (tex.errors || 0) > 0 ? 'fail' : 'warn') +
        stat(alt.success || 0, 'AltText Success', 'ok') +
        stat((alt.errors || 0) + (alt.warnings || 0), 'AltText Issues', (alt.errors || 0) > 0 ? 'fail' : 'warn');

      // Use Blob URLs for instant download — no second HTTP request needed
      // This fixes slow downloads on Render/cloud free tier cold starts
      const ct = data.content || {};
      let btns = '';

      function makeBlobBtn(text, filename, cssClass, label) {
        if (!text) return '';
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        return '<a class="dl-btn ' + cssClass + '" href="' + url + '" download="' + filename + '">' + label + '</a>';
      }

      if (ct.txt) btns += makeBlobBtn(ct.txt, ct.txtName || 'equations.txt',    '',    '\u2B07 Download TXT (TeX + AltText output)');
      if (ct.xml) btns += makeBlobBtn(ct.xml, ct.xmlName || 'modified.xml',    'xml', '\u2B07 Download Modified XML (img tags updated)');
      if (ct.log) btns += makeBlobBtn(ct.log, ct.logName || 'log.txt',         'log', '\u2B07 Download Processing Log');

      // Fallback to URL links if content not embedded
      if (!btns) {
        const dl = data.downloads || {};
        if (dl.txt) btns += '<a class="dl-btn" href="' + dl.txt + '" download>\u2B07 Download TXT</a>';
        if (dl.xml) btns += '<a class="dl-btn xml" href="' + dl.xml + '" download>\u2B07 Download Modified XML</a>';
        if (dl.log) btns += '<a class="dl-btn log" href="' + dl.log + '" download>\u2B07 Download Processing Log</a>';
      }

      document.getElementById('dlButtons').innerHTML = btns;

      document.getElementById('result').style.display = 'block';
      document.getElementById('processBtn').disabled = false;

    } catch (e) {
      document.getElementById('progress').style.display = 'none';
      showError('Network error: ' + e.message);
      document.getElementById('processBtn').disabled = false;
    }
  }

  function stat(num, label, cls) {
    return '<div class="stat ' + cls + '"><div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>';
  }

  function showError(msg) {
    const box = document.getElementById('errorBox');
    box.textContent = '\u26a0 ' + msg;
    box.style.display = 'block';
    document.getElementById('processBtn').disabled = false;
  }
</script>
</body>
</html>`);
});

// ── GET /health ──────────────────────────────────────────────────
app.get("/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
});

// ── POST /process — main endpoint ───────────────────────────────
app.post("/process", upload.single("file"), async (req, res) => {

    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded. Send XML file as multipart field named 'file'" });
    }

    const uploadedPath = req.file.path;
    const origName     = req.file.originalname;
    const baseName     = path.basename(origName, ".xml");
    const timestamp    = Date.now();

    let rawXML;
    try {
        rawXML = fs.readFileSync(uploadedPath, "utf8");
    } catch (e) {
        return res.status(500).json({ error: `Cannot read uploaded file: ${e.message}` });
    }

    // Process
    let result;
    try {
        result = await processXML(rawXML, origName);
    } catch (e) {
        return res.status(500).json({ error: `Processing failed: ${e.message}` });
    }

    // Ensure OUTPUT folder exists (re-check at request time)
    if (!fs.existsSync(OUTPUT)) {
        fs.mkdirSync(OUTPUT, { recursive: true });
        console.log(`[INFO] Created outputs folder: ${OUTPUT}`);
    }

    // Save TXT
    const txtFilename = `${baseName}_${timestamp}_equations.txt`;
    const txtPath     = path.resolve(path.join(OUTPUT, txtFilename));
    try {
        fs.writeFileSync(txtPath, result.txtContent, "utf8");
        console.log(`[OK] TXT saved: ${txtPath}`);
    } catch (e) {
        console.error(`[ERROR] Cannot save TXT: ${e.message}`);
        return res.status(500).json({ error: `Cannot save TXT file: ${e.message}` });
    }

    // Save XML if modified
    let xmlFilename = null;
    if (result.xmlContent) {
        xmlFilename = `${baseName}_${timestamp}_modified.xml`;
        const xmlPath = path.resolve(path.join(OUTPUT, xmlFilename));
        try {
            fs.writeFileSync(xmlPath, result.xmlContent, "utf8");
            console.log(`[OK] XML saved: ${xmlPath}`);
        } catch (e) {
            console.error(`[ERROR] Cannot save XML: ${e.message}`);
        }
    } else {
        console.log(`[INFO] No XML output — xmlModified=${result.xmlModified}`);
    }

    // Save LOG file (always)
    const logFilename = `${baseName}_${timestamp}_log.txt`;
    const logPath     = path.resolve(path.join(OUTPUT, logFilename));
    try {
        fs.writeFileSync(logPath, result.logContent, "utf8");
        console.log(`[OK] LOG saved: ${logPath}`);
    } catch (e) {
        console.error(`[ERROR] Cannot save LOG: ${e.message}`);
    }

    // Clean up upload
    try { fs.unlinkSync(uploadedPath); } catch (_) {}

    // Build response
    const baseURL  = `${req.protocol}://${req.get("host")}`;

    // Embed file contents directly in response so browser can download
    // without making a second HTTP request (fixes Render cold start delay)
    const response = {
        success:         true,
        filename:        origName,
        totalEquations:  result.equations.length,
        xmlModified:     result.xmlModified,
        message:         result.xmlModified
                            ? "TeX and AltText added to img tags in XML. Both TXT and XML returned."
                            : "No img tags found in equation elements. TXT file only returned.",
        downloads: {
            txt: `${baseURL}/download/${txtFilename}`,
            log: `${baseURL}/download/${logFilename}`
        },
        // Embed content directly for instant browser download (no second request)
        content: {
            txt:      result.txtContent,
            log:      result.logContent,
            xml:      result.xmlContent || null,
            txtName:  txtFilename,
            logName:  logFilename,
            xmlName:  xmlFilename || null
        },
        equations: result.equations.map((eq, i) => ({
            index:   i + 1,
            type:    eq.type,
            format:  eq.format,
            id:      eq.id,
            hasImg:  eq.hasImg,
            tex:     eq.tex,
            altText: eq.alt
        }))
    };

    if (xmlFilename) {
        response.downloads.xml = `${baseURL}/download/${xmlFilename}`;
    }

    // Add conversion stats to response
    response.conversionStats = {
        total:        result.equations.length,
        withImgTag:   result.equations.filter(e => e.hasImg).length,
        withoutImgTag: result.equations.filter(e => !e.hasImg).length,
        tex: {
            success: result.equations.filter(e => e.texStatus === "OK").length,
            warnings: result.equations.filter(e => e.texStatus === "WARN").length,
            errors:  result.equations.filter(e => e.texStatus === "ERROR").length
        },
        altText: {
            success: result.equations.filter(e => e.altStatus === "OK").length,
            warnings: result.equations.filter(e => e.altStatus === "WARN").length,
            errors:  result.equations.filter(e => e.altStatus === "ERROR").length
        }
    };

    res.json(response);
});

// ── GET /download/:filename — download output files ──────────────
app.get("/download/:filename", (req, res) => {
    const filename = path.basename(req.params.filename); // sanitize
    const filePath = path.join(OUTPUT, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found or expired" });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === ".xml" ? "application/xml" : "text/plain";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // sendFile requires absolute path — use path.resolve to guarantee it
    res.sendFile(path.resolve(filePath));
});

// ── Error handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
    if (err.message && err.message.includes("Only .xml")) {
        return res.status(400).json({ error: "Only .xml files are accepted" });
    }
    res.status(500).json({ error: err.message || "Internal server error" });
});

/* ================================================================
   START SERVER
   Auto-increments port if preferred port is already in use.
   Tries PORT, PORT+1 ... up to PORT+10 before giving up.
================================================================ */

function startServer(port, retriesLeft) {
    if (retriesLeft === undefined) retriesLeft = 10;

    const server = require("http").createServer(app);

    server.on("error", function(err) {
        if (err.code === "EADDRINUSE") {
            if (retriesLeft > 0) {
                console.log("  [WARN] Port " + port + " is already in use — trying port " + (port + 1) + "...");
                server.close();
                startServer(port + 1, retriesLeft - 1);
            } else {
                console.error("\n[ERROR] No free port found after 10 attempts.");
                console.error("  Kill the existing process:");
                console.error("    netstat -ano | findstr :3000");
                console.error("    taskkill /PID <number> /F");
                console.error("  Then run: node server.js\n");
                process.exit(1);
            }
        } else {
            console.error("\n[ERROR]", err.message);
            process.exit(1);
        }
    });

    server.listen(port, function() {
        const actualPort = server.address().port;
        console.log("\n" + "=".repeat(60));
        console.log("  MathMLtoTeXandAltText API");
        console.log("=".repeat(60));
        console.log("  Running  : http://localhost:" + actualPort);
        console.log("  Endpoint : POST http://localhost:" + actualPort + "/process");
        console.log("  Browser  : http://localhost:" + actualPort + "/ui");
        console.log("  Upload   : multipart field name = \'file\'");
        console.log("  Outputs  : " + OUTPUT);
        console.log("=".repeat(60));
        if (actualPort !== 3000) {
            console.log("");
            console.log("  NOTE: Port 3000 was busy.");
            console.log("  Use http://127.0.0.1:" + actualPort + " in your curl commands.");
        }
        console.log("");
        console.log("  Rules:");
        console.log("  - TXT file : Always returned");
        console.log("  - XML file : Only if <inline-graphic>/<graphic> tags found");
        console.log("  - img tags : tex=\'\'  alttext=\'\' attributes added");
        console.log("");
        console.log("  Press Ctrl+C to stop");
        console.log("=".repeat(60) + "\n");
    });
}

startServer(PORT);

/* ================================================================
   FOLDER WATCHER
   Watches the uploads/ folder continuously.
   When an XML file is dropped/copied into uploads/:
     1. Detects it automatically (no curl needed)
     2. Processes it through the same pipeline
     3. Saves TXT, XML, LOG to outputs/ folder
     4. Moves the processed XML to uploads/processed/ subfolder
   Checks every 3 seconds for new files.
================================================================ */

const PROCESSED_DIR = path.join(UPLOAD, "processed");

// Create processed subfolder
if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
}

// Track files currently being processed to avoid double-processing
const processingFiles = new Set();

function watchUploadsFolder() {

    console.log("  [WATCHER] Watching uploads folder for XML files...");
    console.log("  [WATCHER] Drop any XML file into: " + UPLOAD);
    console.log("  [WATCHER] Outputs will appear in:  " + OUTPUT);
    console.log("");

    // Use fs.watch for instant detection + polling as fallback
    fs.watch(UPLOAD, { persistent: true }, (eventType, filename) => {
        if (!filename) return;
        if (!filename.toLowerCase().endsWith(".xml")) return;

        const filePath = path.join(UPLOAD, filename);

        // Small delay to ensure file is fully written before reading
        setTimeout(() => {
            processWatchedFile(filePath, filename);
        }, 500);
    });

    // Also poll every 3 seconds as fallback (handles copy-paste which
    // may not trigger fs.watch reliably on all Windows versions)
    setInterval(() => {
        try {
            const files = fs.readdirSync(UPLOAD).filter(f =>
                f.toLowerCase().endsWith(".xml") &&
                !processingFiles.has(f)
            );
            files.forEach(filename => {
                const filePath = path.join(UPLOAD, filename);
                processWatchedFile(filePath, filename);
            });
        } catch (e) {
            // folder read error — ignore
        }
    }, 3000);
}

async function processWatchedFile(filePath, filename) {

    // Skip if already processing this file
    if (processingFiles.has(filename)) return;

    // Skip if file doesn't exist (may have been moved already)
    if (!fs.existsSync(filePath)) return;

    // Mark as processing
    processingFiles.add(filename);

    console.log("\n  [WATCHER] Detected: " + filename);
    console.log("  [WATCHER] Processing...");

    let rawXML;
    try {
        rawXML = fs.readFileSync(filePath, "utf8");
    } catch (e) {
        console.error("  [WATCHER] ERROR reading file: " + e.message);
        processingFiles.delete(filename);
        return;
    }

    // Process through same pipeline as API
    let result;
    try {
        result = await processXML(rawXML, filename);
    } catch (e) {
        console.error("  [WATCHER] ERROR processing: " + e.message);
        processingFiles.delete(filename);
        return;
    }

    const baseName  = path.basename(filename, ".xml");
    const timestamp = Date.now();

    // Ensure output folder exists
    if (!fs.existsSync(OUTPUT)) {
        fs.mkdirSync(OUTPUT, { recursive: true });
    }

    // Save TXT
    const txtFilename = baseName + "_" + timestamp + "_equations.txt";
    const txtPath     = path.resolve(path.join(OUTPUT, txtFilename));
    try {
        fs.writeFileSync(txtPath, result.txtContent, "utf8");
        console.log("  [WATCHER] TXT saved : " + txtPath);
    } catch (e) {
        console.error("  [WATCHER] ERROR saving TXT: " + e.message);
    }

    // Save XML if modified
    let xmlFilename = null;
    if (result.xmlContent) {
        xmlFilename = baseName + "_" + timestamp + "_modified.xml";
        const xmlPath = path.resolve(path.join(OUTPUT, xmlFilename));
        try {
            fs.writeFileSync(xmlPath, result.xmlContent, "utf8");
            console.log("  [WATCHER] XML saved : " + xmlPath);
        } catch (e) {
            console.error("  [WATCHER] ERROR saving XML: " + e.message);
        }
    } else {
        console.log("  [WATCHER] XML       : No img tags found — TXT only");
    }

    // Save LOG
    const logFilename = baseName + "_" + timestamp + "_log.txt";
    const logPath     = path.resolve(path.join(OUTPUT, logFilename));
    try {
        fs.writeFileSync(logPath, result.logContent, "utf8");
        console.log("  [WATCHER] LOG saved : " + logPath);
    } catch (e) {
        console.error("  [WATCHER] ERROR saving LOG: " + e.message);
    }

    // Move processed XML to uploads/processed/ subfolder
    const processedPath = path.join(PROCESSED_DIR, filename);
    try {
        // If a file with same name exists in processed, add timestamp
        const destPath = fs.existsSync(processedPath)
            ? path.join(PROCESSED_DIR, baseName + "_" + timestamp + ".xml")
            : processedPath;
        fs.renameSync(filePath, destPath);
        console.log("  [WATCHER] Moved to  : " + destPath);
    } catch (e) {
        // If rename fails (cross-device), try copy + delete
        try {
            fs.copyFileSync(filePath, processedPath);
            fs.unlinkSync(filePath);
            console.log("  [WATCHER] Moved to  : " + processedPath);
        } catch (e2) {
            console.error("  [WATCHER] Could not move file: " + e2.message);
        }
    }

    // Summary
    const eq     = result.equations;
    const txOK   = eq.filter(e => e.texStatus === "OK").length;
    const txFail = eq.filter(e => e.texStatus !== "OK").length;
    console.log("  [WATCHER] Done! Equations: " + eq.length +
        "  TeX OK: " + txOK +
        "  TeX Issues: " + txFail);
    console.log("  [WATCHER] Outputs in: " + OUTPUT);
    console.log("");

    // Unmark so same filename can be processed again later
    processingFiles.delete(filename);
}

// Start watching after server is ready (slight delay)
setTimeout(watchUploadsFolder, 1000);
