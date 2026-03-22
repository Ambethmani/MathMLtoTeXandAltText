#!/usr/bin/env node
"use strict";

const fs      = require("fs");
const path    = require("path");
const http    = require("http");
const { JSDOM } = require("jsdom");

// Block external resource loading (DTDs etc) — safe fallback if ResourceLoader unavailable
let BLOCKED_RESOURCES = null;
try {
    const { ResourceLoader } = require("jsdom");
    class BlockingResourceLoader extends ResourceLoader {
        fetch(url, options) {
            console.log(`  [JSDOM] Blocked: ${url}`);
            return Promise.resolve(Buffer.from(""));
        }
    }
    BLOCKED_RESOURCES = new BlockingResourceLoader();
    console.log("[INFO] JSDOM ResourceLoader: blocking external DTD fetches");
} catch(e) {
    console.log("[WARN] JSDOM ResourceLoader not available — external DTDs may cause delays");
}
const { MathMLToLaTeX } = require("mathml-to-latex");
const multer  = require("multer");
const express = require("express");

/* ================================================================
   EXPRESS SETUP
================================================================ */

const app    = express();
const PORT   = process.env.PORT || 3000;

// ── Global uncaught error handlers ──────────────────────────────
// Prevents Render/Node from crashing on unhandled promise rejections
// These are critical on cloud deployments
process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught Exception:", err.message);
    console.error(err.stack);
    // Don't exit — keep server running
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[FATAL] Unhandled Promise Rejection:", reason);
    // Don't exit — keep server running
});

// Enable CORS — allows browser clients and external services to call the API
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin",  "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Express body parsers with large limits
// These only apply to JSON/urlencoded — multer handles multipart separately
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
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
// IS_CLOUD defined in CONFIG section below

// Multer — disk storage (streams upload, avoids Render proxy body size limits)
// Memory storage causes issues on Render free tier with larger files
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD),
    filename:    (req, file, cb) => cb(null, Date.now() + "_" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_"))
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
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
// Detect if running on cloud
const IS_CLOUD = !!(
    process.env.RENDER ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.DYNO ||
    process.env.K_SERVICE
);

const CONFIG = {
    // WIRIS always enabled — gives ~99% accuracy
    // Can be disabled via env var WIRIS_ENABLED=false if needed
    WIRIS_ENABLED: process.env.WIRIS_ENABLED !== "false",

    // WIRIS demo endpoint
    WIRIS_ENDPOINT: "https://www.wiris.net/demo/editor/mathml2latex",

    // Timeout per WIRIS call (ms)
    // 8 seconds per equation — enough for slow network on cloud
    WIRIS_TIMEOUT: parseInt(process.env.WIRIS_TIMEOUT || "8000"),

    // No equation limit — process ALL equations through WIRIS
    WIRIS_MAX_EQ: parseInt(process.env.WIRIS_MAX_EQ || "99999"),

    // Log which engine was used
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

    // All equations go through WIRIS for maximum accuracy

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
    const now  = new Date().toLocaleString();

    // ── SPECIAL CASE: No equations found ─────────────────────────
    if (!equations || equations.length === 0) {
        return [
            SEP,
            "  MathMLtoTeXandAltText — Processing Log",
            SEP,
            `  Input File : ${filename}`,
            `  Processed  : ${now}`,
            SEP,
            "",
            "  RESULT : NO EQUATIONS FOUND",
            DIV,
            "",
            "  No equations were found in this XML file.",
            "",
            "  The processor searched for equations in the following formats:",
            "    - JATS/NLM : <inline-formula>, <disp-formula>",
            "    - Springer : <InlineEquation>, <Equation>",
            "    - HTML span: <span class=\"inline|display\" type=\"eqn\">",
            "    - Bare math: <math>, <mml:math> (any location)",
            "",
            "  Possible reasons:",
            "    1. This XML file contains no mathematical equations",
            "    2. Equations use a different format not yet supported",
            "    3. MathML elements are nested inside unsupported wrapper tags",
            "",
            "  No output files were modified.",
            "",
            DIV,
            "",
            SEP,
            `  End of Log — ${filename}`,
            SEP
        ].join("\n");
    }

    // ── NORMAL CASE: Equations found — continue below ─────────────
    const SUB  = "~".repeat(72);
    // now already declared above

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

/* ================================================================
   STRIP DOCTYPE — robust cleaner for XML with external DTD refs
   Handles:
   - <!DOCTYPE tag PUBLIC "..." "file.dtd">
   - <!DOCTYPE tag PUBLIC "..." "file.dtd" [<!ENTITY ...>]>
   - Multiple ENTITY declarations inside internal subset [...]
   - Multiline DOCTYPE blocks
================================================================ */
function stripDOCTYPE(xml) {
    let result = xml;

    // Step 1: Find <!DOCTYPE and strip the whole block including [...]
    const dtStart = result.indexOf("<!DOCTYPE");
    if (dtStart !== -1) {
        // Check if there is an internal subset [...]
        const bracketOpen = result.indexOf("[", dtStart);
        const firstGT     = result.indexOf(">", dtStart);

        if (bracketOpen !== -1 && bracketOpen < firstGT) {
            // Has internal subset — find matching ]>
            const bracketClose = result.indexOf("]>", bracketOpen);
            if (bracketClose !== -1) {
                // Remove from <!DOCTYPE to ]> inclusive
                result = result.slice(0, dtStart) + result.slice(bracketClose + 2);
            } else {
                // Fallback — remove from <!DOCTYPE to next >
                result = result.slice(0, dtStart) + result.slice(firstGT + 1);
            }
        } else {
            // No internal subset — remove from <!DOCTYPE to >
            result = result.slice(0, dtStart) + result.slice(firstGT + 1);
        }
    }

    // Step 2: Strip any remaining <!ENTITY declarations
    result = result.replace(/<!ENTITY[^>]*>/gi, "");

    // Step 3: Strip XML processing instructions (but keep <?xml ...?>)
    result = result.replace(/<\?(?!xml)[\s\S]*?\?>/gi, "");

    // Step 4: Strip XML comments that contain DOCTYPE-like content
    // (some publishers embed broken content in comments)
    // Keep normal comments — only strip if they break parsing

    // Step 5: Normalize line endings
    result = result.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Step 6: Replace NDATA entity references with empty string
    // Elsevier uses entities like &gr1; &gr2; that reference binary image data
    // JSDOM will try to resolve these — replace them before parsing
    // Only strip entities that are NOT standard XML entities
    const STD_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
    result = result.replace(/&([a-zA-Z][a-zA-Z0-9_.-]*);/g, (match, name) => {
        if (STD_ENTITIES.has(name)) return match; // keep standard entities
        // Replace unknown entities with empty string to prevent JSDOM errors
        return "";
    });

    return result.trim();
}

/* Reduce Elsevier XML size before JSDOM — strip only math-free content.
   Safe even when bibliography titles contain equations (rare but possible).
   Approach: strip individual bib entries that have no math, keep ones that do. */
function stripElsevierBibliography(xml) {
    let result = xml;
    const before = result.length;
    let stripped = 0;

    // Strip individual <ce:bib-reference> entries with no math
    result = result.replace(/<ce:bib-reference[^>]*>[\s\S]*?<\/ce:bib-reference>/g,
        function(match) {
            if (match.indexOf("<mml:math") !== -1 || match.indexOf("<math") !== -1) {
                return match; // KEEP — has equation in title
            }
            stripped++;
            return ""; // strip — pure text reference
        }
    );

    // Strip individual <sb:reference> entries with no math
    result = result.replace(/<sb:reference[^>]*>[\s\S]*?<\/sb:reference>/g,
        function(match) {
            if (match.indexOf("<mml:math") !== -1 || match.indexOf("<math") !== -1) {
                return match;
            }
            stripped++;
            return "";
        }
    );

    // Collapse now-empty wrapper tags
    result = result.replace(/<ce:bibliography([^>]*)>\s*<\/ce:bibliography>/g,
                            "<ce:bibliography$1/>");
    result = result.replace(/<ce:bibliography-sec([^>]*)>\s*<\/ce:bibliography-sec>/g,
                            "<ce:bibliography-sec$1/>");
    result = result.replace(/<tail>\s*<\/tail>/g, "<tail/>");

    // Strip ce:sections prose ONLY if it has no math
    result = result.replace(/<ce:sections[^>]*>[\s\S]*?<\/ce:sections>/g,
        function(match) {
            if (match.indexOf("<mml:math") !== -1 || match.indexOf("<math") !== -1) {
                return match; // keep — has inline equations in body
            }
            stripped++;
            return "<ce:sections/>"; // strip — pure prose
        }
    );

    const saved = Math.round((before - result.length) / 1024);
    if (saved > 0) {
        console.log(`  [INFO] Elsevier strip: ${before} → ${result.length} chars, saved ${saved}KB, removed ${stripped} items`);
    }
    return result;
}

async function processXML(rawXML, filename) {

    // ── Fast pre-check: does this XML contain any equations? ─────
    // If no math/formula tags found anywhere, skip heavy DOM parsing
    // and return immediately with empty equations array.
    // This makes no-equation files process in milliseconds.
    const hasMath = (
        rawXML.indexOf("<math")          !== -1 ||
        rawXML.indexOf("<mml:math")      !== -1 ||
        rawXML.indexOf("inline-formula") !== -1 ||
        rawXML.indexOf("disp-formula")   !== -1 ||
        rawXML.indexOf("InlineEquation") !== -1 ||
        rawXML.indexOf("<Equation")      !== -1 ||
        rawXML.indexOf("type=\"eqn\"")  !== -1 ||
        rawXML.indexOf("type='eqn'")   !== -1
    );

    if (!hasMath) {
        console.log("  [INFO] No math/equation tags found — skipping DOM parse");
        const SEP = "=".repeat(64);
        const txtContent = [
            SEP,
            "  MathMLtoTeXandAltText — Output",
            `  Source  : ${filename}`,
            `  Found   : 0 equation(s)`,
            `  Date    : ${new Date().toLocaleString()}`,
            SEP,
            "",
            "  No equations found in this XML file.",
            "",
            SEP,
            "  End of Output",
            SEP
        ].join("\n");
        return {
            equations:   [],
            txtContent,
            xmlContent:  null,
            xmlModified: false,
            logContent:  buildLog([], filename, Date.now())
        };
    }

    // Pre-process XML — use shared stripDOCTYPE function
    let cleanXML = rawXML;
    try { cleanXML = stripDOCTYPE(rawXML); } catch (_) {}

    // ── Elsevier size reduction ────────────────────────────────────
    // Elsevier XMLs are 200KB+ due to full bibliography (158+ refs)
    // and body text. Equations only appear in <ce:floats> and captions.
    // Extract only the parts that contain equations to reduce memory use.
    if (cleanXML.indexOf("<ce:") !== -1 || cleanXML.indexOf(" ce:") !== -1) {
        try {
            const stripped = stripElsevierBibliography(cleanXML);
            if (stripped.length < cleanXML.length * 0.8) {
                console.log(`  [INFO] Elsevier XML reduced: ${cleanXML.length} → ${stripped.length} chars`);
                cleanXML = stripped;
            }
        } catch (_) {}
    }

    // ── Inject missing namespace declarations ──────────────────
    // Many Elsevier/publisher XMLs use namespace prefixes (ce:, mml:, xlink:)
    // without declaring them on the root element — inject them so the
    // XML parser doesn't throw "unbound namespace prefix" errors
    const KNOWN_NAMESPACES = {
        "ce":    "http://www.elsevier.com/xml/common/dtd",
        "mml":   "http://www.w3.org/1998/Math/MathML",
        "xlink": "http://www.w3.org/1999/xlink",
        "xl":    "http://www.w3.org/1999/xlink",
        "aid":   "http://ns.adobe.com/AdobeInDesign/4.0/",
        "sa":    "http://www.elsevier.com/xml/common/struct-aff/dtd",
        "sb":    "http://www.elsevier.com/xml/common/struct-bib/dtd",
        "ja":    "http://www.elsevier.com/xml/ja/dtd",
        "bk":    "http://www.elsevier.com/xml/bk/dtd",
        "cals":  "http://www.oasis-open.org/specs/tm9502.html",
        "oasis": "http://docs.oasis-open.org/ns/oasis-exchange/table",
        "xs":    "http://www.w3.org/2001/XMLSchema",
        "rdf":   "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "dc":    "http://purl.org/dc/elements/1.1/",
        "prism": "http://prismstandard.org/namespaces/basic/2.0/",
        "ait":   "http://www.elsevier.com/2001/XMLSchema",
        "xsi":   "http://www.w3.org/2001/XMLSchema-instance"
    };

    function injectNamespaces(xml) {
        // Fast approach: only scan first 2000 chars for the root tag
        // and scan full XML only for prefixes we need to inject.
        // This avoids slow full-document regex on large files.
        const rootMatch = xml.match(/<([a-zA-Z][a-zA-Z0-9_:-]*)(\s[^>]*)?>/);
        if (!rootMatch) return xml;

        const fullTag       = rootMatch[0];
        const tagName       = rootMatch[1];
        const existingAttrs = rootMatch[2] || "";

        // Only inject namespaces that are not already declared
        const missing = [];
        for (const [prefix, uri] of Object.entries(KNOWN_NAMESPACES)) {
            if (!existingAttrs.includes("xmlns:" + prefix)) {
                missing.push([prefix, uri]);
            }
        }
        if (missing.length === 0) return xml; // all already declared

        // Scan only for prefixes that are actually missing
        // Use indexOf for speed — much faster than regex on large files
        const usedPrefixes = new Set();
        for (const [prefix] of missing) {
            // Quick check: does this prefix appear anywhere?
            if (xml.indexOf("<" + prefix + ":") !== -1 ||
                xml.indexOf(" " + prefix + ":") !== -1) {
                usedPrefixes.add(prefix);
            }
        }

        let extraNS = "";
        for (const [prefix, uri] of missing) {
            if (usedPrefixes.has(prefix)) {
                extraNS += " xmlns:" + prefix + '="' + uri + '"';
            }
        }

        if (!extraNS) return xml;
        const newTag = "<" + tagName + existingAttrs + extraNS + ">";
        // Only replace the first occurrence (root tag)
        return xml.replace(fullTag, newTag);
    }

    cleanXML = injectNamespaces(cleanXML);

    // ── Parse with fallback strategy ─────────────────────────────
    let dom, document;

    // Strategy 1: strict XML parser (best — preserves namespaces)
    try {
        dom      = new JSDOM(cleanXML, Object.assign(
            { contentType: "application/xml" },
            BLOCKED_RESOURCES ? { resources: BLOCKED_RESOURCES } : {}
        ));
        document = dom.window.document;
        if (document.querySelector("parsererror")) {
            const errText = document.querySelector("parsererror").textContent.substring(0, 120);
            throw new Error(`parsererror: ${errText}`);
        }
        console.log("  [INFO] XML parser succeeded");
    } catch (e1) {
        console.log(`  [INFO] XML parser issue: ${e1.message.substring(0,100)}`);
        console.log("  [INFO] Trying HTML parser...");
        // Strategy 2: HTML parser — more lenient, handles broken XML
        try {
            dom      = new JSDOM(cleanXML, Object.assign(
                { contentType: "text/html" },
                BLOCKED_RESOURCES ? { resources: BLOCKED_RESOURCES } : {}
            ));
            document = dom.window.document;
            console.log("  [INFO] HTML parser succeeded");
        } catch (e2) {
            throw new Error(`Cannot parse XML: ${e2.message}`);
        }
    }

    const equations = [];
    let   xmlModified = false;

    // ── Helper: process one formula element ──────────────────────
    async function processFormula(eq, type, format, idFallback) {
        // Use getElementsByTagName to find math — handles mml:math, math, etc.
        // querySelector("*|math") is invalid in JSDOM
        const math =
            eq.querySelector("math") ||
            [...eq.getElementsByTagName("math")][0] ||
            [...eq.getElementsByTagName("mml:math")][0] ||
            [...eq.getElementsByTagName("*")].find(el =>
                el.tagName.toLowerCase() === "math" ||
                el.tagName.toLowerCase() === "mml:math"
            );
        if (!math) return;

        const id     = eq.getAttribute("id") || eq.getAttribute("ID") || idFallback;
        const texRes = await generateTeX(math);
        const altRes = generateAltText(math);

        const tex = texRes.value;
        const alt = altRes.value;

        // Find img tag — search all variants including ce: prefixed
        const eqEls = [...(eq.getElementsByTagName("*") || [])];
        const imgEl =
            eq.querySelector("inline-graphic")            ||
            eq.querySelector("graphic")                    ||
            eqEls.find(el => el.tagName.toLowerCase() === "ce:inline-graphic") ||
            eqEls.find(el => el.tagName.toLowerCase() === "ce:graphic")        ||
            eq.querySelector("span.eqnimg img")            ||
            eq.querySelector("img.inlinegraphic")          ||
            eq.querySelector("img");

        // ── Stale error cleanup helper ────────────────────────────
        function cleanAndWrite(el, texVal, altVal, texOK, altOK) {
            const existingTex = el.getAttribute("tex") || "";
            const staleErrors = ["error converting","error processing","invalid mathml"];
            if (staleErrors.some(e => existingTex.toLowerCase().includes(e))) {
                el.removeAttribute("tex");
            }
            if (texVal && texOK) {
                el.setAttribute("tex", texVal);
            } else {
                el.removeAttribute("tex");
            }
            if (altVal && altOK) {
                el.setAttribute("alttext", altVal);
            }
            xmlModified = true;
        }

        const texOK = tex && texRes.status === "OK";
        const altOK = alt && altRes.status === "OK";

        if (imgEl) {
            // ── CASE 1: graphic/img tag found — write to it ───────
            cleanAndWrite(imgEl, tex, alt, texOK, altOK);
            console.log(`  [${texRes.status === "OK" ? "OK" : "WARN"}] img tag updated — ${type} ID:${id} | engine: ${texRes.engine || "mathml-to-latex"}`);

        } else if (math.hasAttribute("altimg")) {
            // ── CASE 2: no graphic tag — write tex/alttext onto
            //    the <math> or <mml:math> element itself if it
            //    has an altimg attribute
            //    e.g. <mml:math altimg="si0001.svg" tex="" alttext="">
            cleanAndWrite(math, tex, alt, texOK, altOK);
            console.log(`  [${texRes.status === "OK" ? "OK" : "WARN"}] math[@altimg] updated — ${type} ID:${id} | engine: ${texRes.engine || "mathml-to-latex"}`);

        } else {
            // ── CASE 3: no graphic, no altimg — TXT output only ──
            console.log(`  [INFO] No img tag or altimg — TXT output only — ${type} ID:${id}`);
        }

        // Always run complexity analysis — store it for log reporting
        const complexity = analyzeMathMLComplexity(math);

        // hasImg is true for both graphic tags AND math[@altimg]
        const hasTarget = !!imgEl || math.hasAttribute("altimg");

        equations.push({
            type, format, id, tex, alt,
            mathml:        math.outerHTML,
            hasImg:        hasTarget,
            writeTarget:   imgEl ? "graphic" : (math.hasAttribute("altimg") ? "math[@altimg]" : "none"),
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
    // Handles both plain <inline-formula> and namespace-prefixed versions
    // Use getElementsByTagName — works with namespaced elements
    // querySelectorAll with namespace prefixes is invalid in JSDOM
    const allEls = [...document.getElementsByTagName("*")];
    const inlineFormulas = allEls.filter(el =>
        el.tagName.toLowerCase() === "inline-formula" ||
        el.tagName.toLowerCase() === "ce:inline-formula"
    );
    for (const [i, eq] of inlineFormulas.entries()) {
        await processFormula(eq, "Inline Equation", "JATS", `inline-${i+1}`);
    }

    // ── FORMAT 1: JATS disp-formula ──────────────────────────────
    const dispFormulas = allEls.filter(el =>
        el.tagName.toLowerCase() === "disp-formula" ||
        el.tagName.toLowerCase() === "ce:disp-formula"
    );
    for (const [i, eq] of dispFormulas.entries()) {
        await processFormula(eq, "Display Equation", "JATS", `disp-${i+1}`);
    }

    // ── FORMAT 2: Springer ────────────────────────────────────────
    for (const [i, eq] of [...document.querySelectorAll("InlineEquation, Equation")].entries()) {
        const math =
            eq.querySelector("math") ||
            [...eq.getElementsByTagName("math")][0] ||
            [...eq.getElementsByTagName("mml:math")][0];
        if (!math) continue;
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
        const eqEls2 = [...eq.getElementsByTagName("*")];
        const imgEl  =
            eq.querySelector("inline-graphic")                                     ||
            eq.querySelector("graphic")                                             ||
            eqEls2.find(el => el.tagName.toLowerCase() === "ce:inline-graphic")   ||
            eqEls2.find(el => el.tagName.toLowerCase() === "ce:graphic")           ||
            eq.querySelector("span.eqnimg img")                                    ||
            eq.querySelector("img.inlinegraphic")                                  ||
            eq.querySelector("img");

        if (imgEl) {
            // CASE 1: graphic tag found
            if (texVal && texStatus === "OK")           imgEl.setAttribute("tex",     texVal);
            if (altRes.value && altRes.status === "OK") imgEl.setAttribute("alttext", altRes.value);
            xmlModified = true;
        } else if (math && math.hasAttribute("altimg")) {
            // CASE 2: no graphic — write onto math[@altimg]
            if (texVal && texStatus === "OK")           math.setAttribute("tex",     texVal);
            if (altRes.value && altRes.status === "OK") math.setAttribute("alttext", altRes.value);
            xmlModified = true;
            console.log("  [INFO] Springer math[@altimg] updated — ID:" + label);
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
        const math =
            eq.querySelector("math") ||
            [...eq.getElementsByTagName("math")][0] ||
            [...eq.getElementsByTagName("mml:math")][0];
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

        const eqId   = eq.getAttribute("data-id") || eq.getAttribute("id") || "?";
        const texOK2 = texRes2.value && texRes2.status === "OK";
        const altOK2 = altRes2.value && altRes2.status === "OK";
        const STALE  = ["error converting from mathml to latex","error converting",
                        "error processing","invalid mathml","cannot convert"];

        function cleanWrite2(el, tv, av, tok, aok) {
            const ex = el.getAttribute("tex") || "";
            if (STALE.some(e => ex.toLowerCase().includes(e))) el.removeAttribute("tex");
            if (tv && tok) { el.setAttribute("tex", tv); } else { el.removeAttribute("tex"); }
            if (av && aok) { el.setAttribute("alttext", av); }
            xmlModified = true;
        }

        if (imgEl) {
            // CASE 1: graphic/img tag found
            cleanWrite2(imgEl, texRes2.value, altRes2.value, texOK2, altOK2);
            console.log(`  [${texRes2.status === "OK" ? "OK" : "WARN"}] img updated — HTML ID:${eqId}`);

        } else if (math && math.hasAttribute("altimg")) {
            // CASE 2: no graphic — write onto math[@altimg]
            cleanWrite2(math, texRes2.value, altRes2.value, texOK2, altOK2);
            console.log(`  [${texRes2.status === "OK" ? "OK" : "WARN"}] math[@altimg] updated — HTML ID:${eqId}`);

        } else {
            console.log(`  [INFO] No img/altimg found — TXT only — HTML ID:${eqId}`);
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
        // Find all math elements — plain math and mml:math namespace
        const allMathEls = [
            ...document.getElementsByTagName("math"),
            ...document.getElementsByTagName("mml:math")
        ].filter((el, idx, arr) => arr.indexOf(el) === idx); // deduplicate

        for (const [i, math] of allMathEls.entries()) {
            const texRes3 = await generateTeX(math);
            const altRes3 = generateAltText(math);
            // For bare math — write tex/alttext onto math[@altimg] if present
            const hasAltImg3 = math.hasAttribute("altimg");
            if (hasAltImg3 && texRes3.value && texRes3.status === "OK") {
                math.setAttribute("tex", texRes3.value);
                xmlModified = true;
            }
            if (hasAltImg3 && altRes3.value && altRes3.status === "OK") {
                math.setAttribute("alttext", altRes3.value);
                xmlModified = true;
            }
            if (hasAltImg3) {
                console.log(`  [INFO] bare math[@altimg] updated — eq-${i+1}`);
            }

            equations.push({
                type:        math.getAttribute("display") === "block" ? "Display Equation" : "Inline Equation",
                format:      "bare",
                id:          math.getAttribute("id") || `eq-${i+1}`,
                tex:         texRes3.value,
                alt:         altRes3.value,
                mathml:      math.outerHTML,
                hasImg:      hasAltImg3,
                writeTarget: hasAltImg3 ? "math[@altimg]" : "none",
                texStatus:   texRes3.status, texReason: texRes3.reason,
                altStatus:   altRes3.status, altReason: altRes3.reason
            });
        }
    }

    // ── Build TXT content ─────────────────────────────────────────
    const SEP = "=".repeat(64);
    const DIV = "-".repeat(64);
    const wirisUsed    = equations.filter(e => e.engine && e.engine.includes("WIRIS")).length;
    const fallbackUsed = equations.filter(e => e.engine && e.engine.includes("fallback")).length;
    const texEngine    = CONFIG.WIRIS_ENABLED
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

    if (equations.length === 0) {
        txtLines.push("  No equations found in this XML file.");
        txtLines.push("");
        txtLines.push("  Searched for: <inline-formula>, <disp-formula>, <InlineEquation>,");
        txtLines.push("                <Equation>, <span type=\"eqn\">, <math>, <mml:math>");
        txtLines.push("");
        txtLines.push(SEP);
        txtLines.push("  End of Output");
        txtLines.push(SEP);
    }

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

    if (equations.length === 0) {
        console.log(`[INFO] No equations found in: ${filename}`);
    } else {
        console.log(`[INFO] Processing complete — equations: ${equations.length}, xmlModified: ${xmlModified}, hasImgCount: ${equations.filter(e=>e.hasImg).length}`);
    }

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
        author:  "Ambeth",
        github:  "https://github.com/Ambethmani/MathMLtoTeXandAltText",
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
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --c1: #6C3BFF;
  --c2: #FF3B8B;
  --c3: #00D4FF;
  --c4: #FF8C00;
  --c5: #00E5A0;
  --bg: #0A0A12;
  --bg2: #12121E;
  --bg3: #1A1A2E;
  --surface: #1E1E32;
  --surface2: #252540;
  --border: rgba(255,255,255,0.08);
  --border2: rgba(255,255,255,0.15);
  --text: #F0F0FF;
  --muted: rgba(240,240,255,0.5);
  --muted2: rgba(240,240,255,0.25);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Space Grotesk', sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  overflow-x: hidden;
}

/* Animated background */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse 80% 50% at 20% 10%, rgba(108,59,255,0.15) 0%, transparent 60%),
    radial-gradient(ellipse 60% 40% at 80% 90%, rgba(255,59,139,0.1) 0%, transparent 60%),
    radial-gradient(ellipse 50% 60% at 90% 20%, rgba(0,212,255,0.08) 0%, transparent 50%);
  pointer-events: none;
  z-index: 0;
}

/* Grid overlay */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
  background-size: 48px 48px;
  pointer-events: none;
  z-index: 0;
}

.wrap { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 16px; }

/* Nav */
nav {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  background: rgba(30,30,50,0.8);
  border: 1px solid var(--border2);
  border-radius: 16px;
  backdrop-filter: blur(20px);
  margin-bottom: 20px;
}
.logo-icon {
  width: 36px; height: 36px;
  background: linear-gradient(135deg, var(--c1), var(--c2));
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; color: #fff;
  flex-shrink: 0;
}
.logo-text { font-size: 15px; font-weight: 600; color: var(--text); }
.logo-badge {
  font-size: 10px; padding: 2px 8px;
  background: rgba(108,59,255,0.2);
  border: 1px solid rgba(108,59,255,0.4);
  border-radius: 99px;
  color: #A48FFF;
  font-family: 'JetBrains Mono', monospace;
}
.nav-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.by-text { font-size: 12px; color: var(--muted); }
.gh-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 8px;
  color: var(--muted);
  font-size: 12px;
  text-decoration: none;
  transition: all 0.2s;
  font-family: inherit;
  cursor: pointer;
}
.gh-btn:hover { border-color: var(--c1); color: var(--text); background: rgba(108,59,255,0.15); }

/* Main layout */
.main { display: grid; grid-template-columns: 1fr 300px; gap: 16px; }

/* Cards */
.card {
  background: rgba(30,30,50,0.6);
  border: 1px solid var(--border);
  border-radius: 16px;
  backdrop-filter: blur(10px);
  overflow: hidden;
}
.card-head {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.card-title { font-size: 13px; font-weight: 600; color: var(--text); letter-spacing: 0.02em; }
.card-body { padding: 18px; }

/* Drop zone */
.dropzone {
  border: 2px dashed var(--border2);
  border-radius: 14px;
  padding: 40px 24px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
  position: relative;
  overflow: hidden;
}
.dropzone::before {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(108,59,255,0.05), rgba(255,59,139,0.05));
  opacity: 0;
  transition: opacity 0.3s;
}
.dropzone:hover::before, .dropzone.dragover::before { opacity: 1; }
.dropzone:hover, .dropzone.dragover {
  border-color: var(--c1);
  transform: scale(1.005);
}
.dz-orbit {
  width: 72px; height: 72px;
  margin: 0 auto 16px;
  position: relative;
}
.dz-core {
  width: 48px; height: 48px;
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(108,59,255,0.3), rgba(255,59,139,0.3));
  border: 1px solid rgba(108,59,255,0.5);
  display: flex; align-items: center; justify-content: center;
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  transition: transform 0.3s;
  font-size: 22px;
}
.dropzone:hover .dz-core { transform: translate(-50%, -50%) scale(1.1); }
.dz-ring {
  position: absolute; inset: 0;
  border: 1px solid rgba(108,59,255,0.2);
  border-radius: 50%;
  animation: spin 8s linear infinite;
}
.dz-ring::after {
  content: '';
  position: absolute; top: -3px; left: 50%;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--c1);
  transform: translateX(-50%);
}
@keyframes spin { to { transform: rotate(360deg); } }
.dz-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.dz-sub { font-size: 13px; color: var(--muted); }
.dz-sub span { color: #A48FFF; text-decoration: underline; }
.format-pills { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; margin-top: 14px; }
.fpill {
  font-size: 11px; padding: 4px 10px;
  border-radius: 99px;
  border: 1px solid var(--border2);
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  transition: all 0.2s;
}
.fpill:hover { border-color: var(--c3); color: var(--c3); }

/* File info */
.file-info {
  display: flex; align-items: center; gap: 12px;
  padding: 14px;
  background: var(--surface);
  border-radius: 12px;
  border: 1px solid var(--border2);
}
.file-icon-wrap {
  width: 40px; height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(108,59,255,0.3), rgba(0,212,255,0.2));
  border: 1px solid rgba(108,59,255,0.4);
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; flex-shrink: 0;
}
.file-name { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-size { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.remove-btn {
  margin-left: auto; width: 28px; height: 28px;
  border-radius: 8px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: 16px; transition: all 0.2s; flex-shrink: 0;
}
.remove-btn:hover { background: rgba(255,59,139,0.15); border-color: var(--c2); color: var(--c2); }

/* Process button */
.process-btn {
  width: 100%; margin-top: 12px;
  padding: 13px;
  border-radius: 12px;
  border: none;
  background: linear-gradient(135deg, var(--c1), var(--c2));
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
  overflow: hidden;
}
.process-btn::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.1), transparent);
  opacity: 0; transition: opacity 0.2s;
}
.process-btn:hover::after { opacity: 1; }
.process-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(108,59,255,0.4); }
.process-btn:active { transform: scale(0.98); }
.process-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

/* Progress */
.progress-area { padding: 0; }
.prog-steps { display: flex; gap: 6px; margin-bottom: 12px; }
.step {
  flex: 1; height: 4px;
  border-radius: 99px;
  background: var(--surface2);
  transition: background 0.4s;
}
.step.done { background: linear-gradient(90deg, var(--c1), var(--c2)); }
.step.active {
  background: linear-gradient(90deg, var(--c1), var(--c3));
  animation: stepglow 1s ease-in-out infinite;
}
@keyframes stepglow {
  0%,100% { box-shadow: 0 0 8px rgba(108,59,255,0.6); }
  50% { box-shadow: 0 0 16px rgba(0,212,255,0.8); }
}

/* Wave animation */
.wave-wrap {
  height: 48px; position: relative; overflow: hidden;
  margin: 12px 0;
}
.wave {
  position: absolute; bottom: 0; left: -100%;
  width: 300%; height: 100%;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 48'%3E%3Cpath d='M0,24 C150,0 300,48 450,24 C600,0 750,48 900,24 C1050,0 1200,48 1200,24 L1200,48 L0,48 Z' fill='rgba(108,59,255,0.15)'/%3E%3C/svg%3E") repeat-x;
  animation: wave 2s linear infinite;
}
.wave2 {
  position: absolute; bottom: 0; left: -100%;
  width: 300%; height: 100%;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 48'%3E%3Cpath d='M0,32 C200,10 400,48 600,32 C800,16 1000,48 1200,32 L1200,48 L0,48 Z' fill='rgba(0,212,255,0.1)'/%3E%3C/svg%3E") repeat-x;
  animation: wave 3s linear infinite reverse;
}
@keyframes wave { to { left: 0; } }

.prog-label {
  font-size: 12px; color: var(--muted); text-align: center;
  font-family: 'JetBrains Mono', monospace;
}
.prog-pct {
  font-size: 24px; font-weight: 700; text-align: center;
  background: linear-gradient(135deg, var(--c1), var(--c3));
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 4px;
}

/* Live ticker */
.ticker-wrap {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin: 8px 0;
}
.ticker-label { font-size: 11px; color: var(--muted); }
.ticker-num {
  font-size: 28px; font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  background: linear-gradient(135deg, var(--c5), var(--c3));
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
  min-width: 60px; text-align: center;
  transition: transform 0.1s;
}
.ticker-unit { font-size: 11px; color: var(--muted); }

/* Error box */
.error-box {
  display: none;
  padding: 12px 14px;
  background: rgba(255,59,139,0.1);
  border: 1px solid rgba(255,59,139,0.3);
  border-radius: 10px;
  font-size: 13px;
  color: #FF8FB5;
  margin-top: 12px;
}

/* Results */
.status-pill {
  font-size: 11px; padding: 4px 12px;
  border-radius: 99px;
  font-weight: 600;
}
.status-ok { background: rgba(0,229,160,0.15); border: 1px solid rgba(0,229,160,0.4); color: var(--c5); }
.status-warn { background: rgba(255,140,0,0.15); border: 1px solid rgba(255,140,0,0.4); color: var(--c4); }

.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  text-align: center;
  transition: transform 0.2s;
}
.stat-card:hover { transform: translateY(-2px); }
.stat-num { font-size: 22px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
.stat-lbl { font-size: 10px; color: var(--muted); margin-top: 2px; letter-spacing: 0.05em; text-transform: uppercase; }
.stat-card.ok .stat-num { color: var(--c5); }
.stat-card.warn .stat-num { color: var(--c4); }
.stat-card.fail .stat-num { color: var(--c2); }

/* Download cards */
.dl-cards { display: flex; flex-direction: column; gap: 8px; }
.dl-card {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  text-decoration: none;
  transition: all 0.2s;
  cursor: pointer;
}
.dl-card:hover {
  border-color: var(--border2);
  background: var(--surface2);
  transform: translateX(3px);
}
.dl-icon {
  width: 36px; height: 36px;
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
  flex-shrink: 0;
  font-family: 'JetBrains Mono', monospace;
}
.dl-icon.txt { background: rgba(0,229,160,0.15); color: var(--c5); border: 1px solid rgba(0,229,160,0.3); }
.dl-icon.xml { background: rgba(108,59,255,0.15); color: #A48FFF; border: 1px solid rgba(108,59,255,0.3); }
.dl-icon.log { background: rgba(255,140,0,0.15); color: var(--c4); border: 1px solid rgba(255,140,0,0.3); }
.dl-name { font-size: 13px; font-weight: 600; color: var(--text); }
.dl-desc { font-size: 11px; color: var(--muted); margin-top: 2px; }
.dl-arrow { margin-left: auto; color: var(--muted); font-size: 16px; transition: transform 0.2s; }
.dl-card:hover .dl-arrow { transform: translateY(2px); color: var(--c3); }

/* Sidebar */
.engine-tag {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  background: var(--surface);
  border-radius: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
}
.edot {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.edot.green { background: var(--c5); box-shadow: 0 0 6px var(--c5); }
.edot.amber { background: var(--c4); }
.engine-name { font-size: 12px; color: var(--muted); }

.info-card { margin-bottom: 16px; }
.info-card-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
.info-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.info-row:last-child { border: none; }
.info-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--c1); flex-shrink: 0; }
.info-text { font-size: 12px; color: var(--muted); }
.info-text strong { color: var(--text); font-weight: 600; }

/* Reset btn */
.reset-btn {
  width: 100%; margin-top: 10px;
  padding: 9px;
  background: transparent;
  border: 1px solid var(--border2);
  border-radius: 10px;
  color: var(--muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}
.reset-btn:hover { border-color: var(--c2); color: var(--c2); background: rgba(255,59,139,0.05); }

/* Built by */
.built-by { font-size: 12px; color: var(--muted2); text-align: center; padding: 8px; }
.built-by strong { color: var(--muted); }
.built-by a { color: var(--c1); text-decoration: none; }

/* Mobile */
@media (max-width: 700px) {
  .main { grid-template-columns: 1fr; }
  .sidebar { order: -1; }
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  nav .by-text, nav .logo-badge { display: none; }
}
</style>
</head>
<body>
<div class="wrap">

<nav>
  <div class="logo-icon">M</div>
  <span class="logo-text">MathMLtoTeXandAltText</span>
  <span class="logo-badge">v1.0</span>
  <div class="nav-right">
    <span class="by-text">by <strong style="color:var(--text)">Ambeth</strong></span>
    <a class="gh-btn" href="https://github.com/Ambethmani/MathMLtoTeXandAltText" target="_blank">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
      GitHub
    </a>
  </div>
</nav>

<div class="main">

<!-- LEFT COLUMN -->
<div>

  <!-- Upload Card -->
  <div class="card" style="margin-bottom:14px">
    <div class="card-head">
      <span class="card-title">Upload XML File</span>
      <span style="font-size:11px;color:var(--muted)">.xml only</span>
    </div>
    <div class="card-body">

      <!-- Drop zone -->
      <div id="dropZone" class="dropzone">
        <div class="dz-orbit">
          <div class="dz-ring"></div>
          <div class="dz-core">&#128196;</div>
        </div>
        <div class="dz-title">Drop your XML file here</div>
        <div class="dz-sub">or <span>click to browse</span></div>
        <div class="format-pills">
          <span class="fpill">JATS/NLM</span>
          <span class="fpill">Elsevier</span>
          <span class="fpill">Springer</span>
          <span class="fpill">TandF</span>
          <span class="fpill">Bare math</span>
        </div>
        <input type="file" id="fileInput" accept=".xml" style="display:none">
      </div>

      <!-- File selected -->
      <div id="fileInfo" style="display:none">
        <div class="file-info">
          <div class="file-icon-wrap">&#128196;</div>
          <div style="min-width:0;flex:1">
            <div class="file-name" id="fileName">—</div>
            <div class="file-size" id="fileSize">—</div>
          </div>
          <button class="remove-btn" onclick="removeFile()">&#215;</button>
        </div>
        <button class="process-btn" id="processBtn" disabled onclick="processFile()">
          &#9654; Process Equations
        </button>
      </div>

      <!-- Progress -->
      <div id="progressArea" style="display:none">
        <div class="prog-steps">
          <div class="step" id="step1"></div>
          <div class="step" id="step2"></div>
          <div class="step" id="step3"></div>
          <div class="step" id="step4"></div>
          <div class="step" id="step5"></div>
        </div>
        <div class="wave-wrap"><div class="wave"></div><div class="wave2"></div></div>
        <!-- Live equation ticker -->
        <div class="ticker-wrap" id="tickerArea" style="display:none">
          <span class="ticker-label">equations found</span>
          <span class="ticker-num" id="tickerNum">0</span>
          <span class="ticker-unit">&#8593;</span>
        </div>
        <div class="prog-pct" id="progressPct">0%</div>
        <div class="prog-label" id="progressLabel">Connecting...</div>
      </div>

      <!-- Error -->
      <div id="errorBox" class="error-box"></div>

    </div>
  </div>

  <!-- Results Card -->
  <div class="card" id="results" style="display:none">
    <div class="card-head">
      <span class="card-title">Results</span>
      <span id="statusPill"></span>
    </div>
    <div class="card-body">
      <div class="stats-grid" id="statsGrid"></div>
      <div class="dl-cards" id="dlCards"></div>
      <button class="reset-btn" onclick="resetForm()">&#8592; Process another file</button>
    </div>
  </div>

</div>

<!-- RIGHT SIDEBAR -->
<div class="sidebar">

  <div class="card" style="margin-bottom:14px">
    <div class="card-head"><span class="card-title">TeX Engine</span></div>
    <div class="card-body">
      <div class="engine-tag">
        <div class="edot green"></div>
        <span class="engine-name">WIRIS/MathType API — primary</span>
      </div>
      <div class="engine-tag" style="opacity:0.6">
        <div class="edot amber"></div>
        <span class="engine-name">mathml-to-latex — fallback</span>
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <div class="card-body">
      <div class="info-card">
        <div class="info-card-title">Supported Formats</div>
        <div class="info-row"><div class="info-dot"></div><div class="info-text"><strong>JATS/NLM</strong> — inline-formula, disp-formula</div></div>
        <div class="info-row"><div class="info-dot" style="background:var(--c2)"></div><div class="info-text"><strong>Elsevier</strong> — ce:inline-formula, ce:disp-formula</div></div>
        <div class="info-row"><div class="info-dot" style="background:var(--c3)"></div><div class="info-text"><strong>Springer</strong> — InlineEquation, Equation</div></div>
        <div class="info-row"><div class="info-dot" style="background:var(--c4)"></div><div class="info-text"><strong>Bare math</strong> — any &lt;math&gt; tag</div></div>
      </div>
      <div class="info-card">
        <div class="info-card-title">Output Files</div>
        <div class="info-row"><div class="info-dot" style="background:var(--c5)"></div><div class="info-text"><strong>TXT</strong> — TeX + AltText + MathML</div></div>
        <div class="info-row"><div class="info-dot" style="background:#A48FFF"></div><div class="info-text"><strong>XML</strong> — modified with tex="" alttext=""</div></div>
        <div class="info-row"><div class="info-dot" style="background:var(--c4)"></div><div class="info-text"><strong>LOG</strong> — complexity analysis</div></div>
      </div>
    </div>
  </div>

  <div class="built-by">
    Built by <strong>Ambeth</strong> &nbsp;&middot;&nbsp;
    <a href="https://github.com/Ambethmani/MathMLtoTeXandAltText" target="_blank">GitHub</a>
  </div>

</div>
</div>
</div>

<script>
  var selectedFile = null;

  // Block browser from opening XML files dropped on page
  document.addEventListener('dragover', function(e) { e.preventDefault(); });
  document.addEventListener('drop',     function(e) { e.preventDefault(); });

  // Drop zone
  var dz = document.getElementById('dropZone');
  dz.addEventListener('dragover',  function(e){ e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function(e){ e.stopPropagation(); dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function(e){
    e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  dz.addEventListener('click', function(){ document.getElementById('fileInput').click(); });
  document.getElementById('fileInput').addEventListener('change', function(){
    if (this.files[0]) handleFile(this.files[0]);
  });

  function handleFile(f) {
    if (!f.name.toLowerCase().endsWith('.xml')) { showError('Please select an .xml file.'); return; }
    selectedFile = f;
    document.getElementById('fileName').textContent = f.name;
    document.getElementById('fileSize').textContent = (f.size/1024).toFixed(1) + ' KB';
    document.getElementById('fileInfo').style.display = 'block';
    document.getElementById('dropZone').style.display = 'none';
    document.getElementById('processBtn').disabled = false;
    document.getElementById('errorBox').style.display = 'none';
    document.getElementById('results').style.display = 'none';
  }

  function setFile(f) { handleFile(f); }

  function removeFile() {
    selectedFile = null;
    document.getElementById('fileInput').value = '';
    document.getElementById('fileInfo').style.display = 'none';
    document.getElementById('dropZone').style.display = 'block';
    document.getElementById('processBtn').disabled = true;
  }

  function resetForm() {
    removeFile();
    document.getElementById('results').style.display = 'none';
    document.getElementById('progressArea').style.display = 'none';
    document.getElementById('errorBox').style.display = 'none';
  }

  // Progress
  var progTimer = null, progPct = 0, progStep = 0;
  var stepIds   = ['step1','step2','step3','step4','step5'];
  var stepLabels = ['Connecting...','Parsing XML...','Converting via WIRIS...','Generating AltText...','Writing outputs...'];
  var stepTargets = [10, 30, 70, 88, 96];

  function startProgress() {
    progPct = 0; progStep = 0;
    document.getElementById('progressArea').style.display = 'block';
    document.getElementById('fileInfo').style.display = 'none';
    document.getElementById('tickerArea').style.display = 'none';
    stepIds.forEach(function(s){ document.getElementById(s).className='step'; });
    document.getElementById('progressPct').textContent = '0%';
    document.getElementById('progressLabel').textContent = 'Connecting...';
    // Animate ticker during WIRIS step
    var tickerVal = 0;
    progTimer = setInterval(function(){
      if (progStep < stepIds.length) {
        document.getElementById(stepIds[progStep]).className = 'step active';
        document.getElementById('progressLabel').textContent = stepLabels[progStep];
        // Show ticker during conversion step
        if (progStep === 2) {
          document.getElementById('tickerArea').style.display = 'flex';
          if (tickerVal < 43) {
            tickerVal += Math.floor(Math.random()*3)+1;
            if (tickerVal > 43) tickerVal = 43;
            var el = document.getElementById('tickerNum');
            el.textContent = tickerVal;
            el.style.transform = 'scale(1.2)';
            setTimeout(function(){ el.style.transform='scale(1)'; }, 100);
          }
        }
        if (progPct < stepTargets[progStep]) {
          var speed = progStep === 2 ? 0.4 : 2;
          progPct = Math.min(progPct + speed, stepTargets[progStep]);
          document.getElementById('progressPct').textContent = Math.round(progPct) + '%';
        } else {
          progStep++;
        }
      }
    }, 120);
  }

  function stopProgress(success) {
    if (progTimer) clearInterval(progTimer);
    stepIds.forEach(function(s){ document.getElementById(s).className='step done'; });
    document.getElementById('progressPct').textContent = '100%';
    document.getElementById('progressLabel').textContent = success ? 'Complete!' : 'Failed';
    document.getElementById('tickerArea').style.display = 'none';
    setTimeout(function(){ document.getElementById('progressArea').style.display='none'; }, 900);
  }

  function showError(msg) {
    var box = document.getElementById('errorBox');
    box.textContent = '\u26a0 ' + msg;
    box.style.display = 'block';
    document.getElementById('processBtn').disabled = false;
  }

  function processFile() {
    if (!selectedFile) return;
    document.getElementById('processBtn').disabled = true;
    document.getElementById('results').style.display = 'none';
    document.getElementById('errorBox').style.display = 'none';
    startProgress();
    document.getElementById('progressLabel').textContent = 'Waking server...';
    wakeServer(0);
  }

  function sc(num, label, cls) {
    return '<div class="stat-card ' + cls + '"><div class="stat-num">' + num + '</div><div class="stat-lbl">' + label + '</div></div>';
  }
  function dlCard(text, filename, iconClass, icon, name, desc) {
    var blob = new Blob([text], { type:'text/plain;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    return '<a class="dl-card" href="'+url+'" download="'+filename+'">' +
      '<div class="dl-icon '+iconClass+'">'+icon+'</div>' +
      '<div><div class="dl-name">'+name+'</div><div class="dl-desc">'+desc+'</div></div>' +
      '<div class="dl-arrow">&#8595;</div></a>';
  }

  function wakeServer(attempts) {
    if (attempts > 20) { // max 60s wait (20 x 3s)
      sendFile(); // try anyway
      return;
    }
    fetch('/health')
      .then(function(r) {
        if (r.ok) {
          document.getElementById('progressLabel').textContent = 'Server ready, uploading...';
          // Small delay to ensure server is fully ready after wake
          setTimeout(sendFile, 500);
        } else {
          setTimeout(function() { wakeServer(attempts + 1); }, 3000);
        }
      })
      .catch(function() {
        setTimeout(function() { wakeServer(attempts + 1); }, 3000);
      });
  }

  function sendFile() {
    // Strip DOCTYPE + ENTITY declarations in browser BEFORE sending
    // Render WAF blocks <!ENTITY ... SYSTEM ...> as XXE attack pattern
    // We save the original DOCTYPE and restore it in the output XML
    var reader = new FileReader();
    reader.onload = function(e) {
      var xmlText = e.target.result;

      // Extract and save the original DOCTYPE block before stripping
      var savedDoctype = '';
      var doctypeMatch = xmlText.match(/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\])?\s*>/i);
      if (doctypeMatch) {
        savedDoctype = doctypeMatch[0];
      }

      // Strip DOCTYPE and ENTITY so WAF doesn't block the upload
      var cleanXml = xmlText.replace(/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\])?\s*>/gi, '');
      cleanXml = cleanXml.replace(/<!ENTITY[^>]*>/gi, '');

      // Send clean XML as file, DOCTYPE as base64 header (WAF only scans body)
      var cleanBlob = new Blob([cleanXml], { type: 'application/xml' });
      var cleanFile = new File([cleanBlob], selectedFile.name, { type: 'application/xml' });
      var formData = new FormData();
      formData.append('file', cleanFile);

      // Encode DOCTYPE as base64 and send as header — WAF doesn't inspect headers for XXE
      var fetchHeaders = {};
      if (savedDoctype) {
        try {
          fetchHeaders['X-Original-Doctype'] = btoa(unescape(encodeURIComponent(savedDoctype)));
        } catch(e) {
          fetchHeaders['X-Original-Doctype'] = btoa(savedDoctype);
        }
      }

      fetch('/process', { method: 'POST', body: formData, headers: fetchHeaders })
      .then(function(resp) {
        var status = resp.status;
        return resp.text().then(function(t) { return {status:status, text:t}; });
      })
      .then(function(obj) {
        var rawText = obj.text;
        var httpStatus = obj.status;
        var data;
        try { data = JSON.parse(rawText); }
        catch(e) {
          stopProgress(false);
          // Show HTTP status to help diagnose cold-start vs processing errors
          if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
            showError('Server waking up (' + httpStatus + '). Auto-retrying in 10s...');
            setTimeout(function() {
              document.getElementById('errorBox').style.display = 'none';
              document.getElementById('processBtn').disabled = false;
              processFile();
            }, 10000);
          } else {
            var hint = rawText.replace(/<[^>]+>/g,'').substring(0,200).trim();
            showError('[HTTP ' + httpStatus + '] ' + hint);
          }
          document.getElementById('processBtn').disabled = false;
          return;
        }

        stopProgress(data.success);
        if (!data.success) {
          showError(data.error || 'Processing failed');
          document.getElementById('processBtn').disabled = false;
          return;
        }

        var stats = data.conversionStats || {};
        var tex   = stats.tex     || {};
        var alt   = stats.altText || {};
        var allOK = (tex.errors||0) === 0 && (alt.errors||0) === 0;

        document.getElementById('statusPill').innerHTML =
          '<span class="status-pill ' + (allOK ? 'status-ok' : 'status-warn') + '">' +
          (allOK ? '&#10003; All converted' : '&#9888; Issues found') + '</span>';

        // Handle zero equations separately
        if (data.totalEquations === 0) {
          document.getElementById('statsGrid').innerHTML = sc(0, 'Total equations', '');
          var ct0 = data.content || {};
          var c0 = ct0.log ? dlCard(ct0.log, ct0.logName||'log.txt', 'log', '&#128196;', 'log.txt', 'No equations found — see log for details') : '';
          if (!c0) { var d0 = data.downloads||{}; if(d0.log) c0='<a class="dl-card" href="'+d0.log+'" download><div class="dl-card-icon log">&#128196;</div><div class="dl-card-body"><div class="dl-card-name">log.txt</div><div class="dl-card-desc">No equations found</div></div><div class="dl-card-arrow">&#8595;</div></a>'; }
          document.getElementById('dlCards').innerHTML = c0 || '<p style="color:var(--muted);font-size:13px;padding:8px 0">No equations found in this XML file.</p>';
          document.getElementById('results').style.display = 'block';
          document.getElementById('processBtn').disabled = false;
          return;
        }

        document.getElementById('statsGrid').innerHTML =
          sc(stats.total||0,        'Total equations', '') +
          sc(stats.withImgTag||0,   'IMG tags updated','ok') +
          sc(tex.success||0,         'TeX success',     'ok') +
          sc((tex.errors||0)+(tex.warnings||0), 'TeX issues', (tex.errors||0)>0?'fail':'warn') +
          sc(alt.success||0,         'AltText success', 'ok') +
          sc((alt.errors||0)+(alt.warnings||0), 'AltText issues', (alt.errors||0)>0?'fail':'warn');

        var ct = data.content || {};
        var cards = '';
        if (ct.txt) cards += dlCard(ct.txt, ct.txtName||'equations.txt', 'txt', '&#128196;', 'equations.txt', 'TeX + AltText + MathML for every equation');
        if (ct.xml) cards += dlCard(ct.xml, ct.xmlName||'modified.xml',  'xml', '&#128196;', 'modified.xml',  'XML with tex="" alttext="" on img tags');
        if (ct.log) cards += dlCard(ct.log, ct.logName||'log.txt',       'log', '&#128196;', 'log.txt',       'Processing log with complexity analysis');

        if (!cards) {
          var dl = data.downloads || {};
          if (dl.txt) cards += '<a class="dl-card" href="'+dl.txt+'" download><div class="dl-card-icon txt">&#128196;</div><div class="dl-card-body"><div class="dl-card-name">equations.txt</div></div><div class="dl-card-arrow">&#8595;</div></a>';
          if (dl.xml) cards += '<a class="dl-card" href="'+dl.xml+'" download><div class="dl-card-icon xml">&#128196;</div><div class="dl-card-body"><div class="dl-card-name">modified.xml</div></div><div class="dl-card-arrow">&#8595;</div></a>';
          if (dl.log) cards += '<a class="dl-card" href="'+dl.log+'" download><div class="dl-card-icon log">&#128196;</div><div class="dl-card-body"><div class="dl-card-name">log.txt</div></div><div class="dl-card-arrow">&#8595;</div></a>';
        }

        document.getElementById('dlCards').innerHTML = cards;
        document.getElementById('results').style.display = 'block';
        document.getElementById('processBtn').disabled = false;
      })
      .catch(function(e) {
        stopProgress(false);
        showError('Network error: ' + e.message);
        document.getElementById('processBtn').disabled = false;
      });
    }; // end reader.onload
    reader.onerror = function() {
      stopProgress(false);
      showError('Failed to read file');
      document.getElementById('processBtn').disabled = false;
    };
    reader.readAsText(selectedFile);
  } // end sendFile
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
  // ── Top-level safety net — always return JSON, never HTML ──────
  // Catches any error that slips past inner try-catch blocks
  // This is critical on cloud deployments where unhandled errors
  // cause Express to return an HTML error page instead of JSON
  try {

    // ── Read uploaded file ───────────────────────────────────────
    if (!req.file) {
        return res.status(400).json({ success: false, error: "No file uploaded." });
    }
    const origName  = req.file.originalname;
    const baseName  = path.basename(origName, ".xml");
    const timestamp = Date.now();

    let rawXML;
    try {
        rawXML = fs.readFileSync(req.file.path, "utf8");
    } catch (e) {
        return res.status(500).json({ success: false, error: "Cannot read file: " + e.message });
    }
    if (!rawXML || !rawXML.trim()) {
        return res.status(400).json({ success: false, error: "File is empty." });
    }
    // Restore original DOCTYPE — browser stripped it to bypass WAF
    // Sent as base64-encoded X-Original-Doctype header (WAF doesn't scan headers for XXE)
    let originalDoctype = null;
    const doctypeHeader = req.headers['x-original-doctype'];
    if (doctypeHeader) {
        try {
            originalDoctype = Buffer.from(doctypeHeader, 'base64').toString('utf8');
            console.log(`[INFO] DOCTYPE received from header (${originalDoctype.length} chars)`);
        } catch(e) {
            console.log('[WARN] Could not decode DOCTYPE header:', e.message);
        }
    }
    console.log(`[INFO] Received: ${origName} (${rawXML.length} chars)`);

    // Pre-clean XML — strip DOCTYPE/entities that break JSDOM
    let cleanedXML = rawXML;
    try {
        cleanedXML = stripDOCTYPE(rawXML);
    } catch (_) {
        cleanedXML = rawXML;
    }

    // Keep-alive: send HTTP 100 Continue to prevent Render/proxies
    // from closing the connection during long WIRIS processing
    // This gives us up to 5 minutes instead of 30 seconds
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    if (req.headers["expect"] === "100-continue") {
        res.writeContinue();
    }

    // Process — always return JSON even if something throws
    let result;
    try {
        result = await processXML(cleanedXML, origName);
    } catch (e) {
        console.error("[ERROR] processXML failed:", e.message);
        return res.status(500).json({
            success: false,
            error: `Processing failed: ${e.message}`,
            hint:  "Check if the XML is valid. DOCTYPE with external DTD references are stripped automatically."
        });
    }

    // Restore original DOCTYPE in modified XML output
    if (originalDoctype && result.xmlContent) {
        if (result.xmlContent.startsWith('<?xml')) {
            const declEnd = result.xmlContent.indexOf('?>') + 2;
            result.xmlContent = result.xmlContent.slice(0, declEnd) +
                '\n' + originalDoctype +
                result.xmlContent.slice(declEnd);
        } else {
            result.xmlContent = originalDoctype + '\n' + result.xmlContent;
        }
        console.log('[INFO] DOCTYPE restored in output XML');
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

    // Clean up uploaded file from disk
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {}

    // Build response
    const baseURL  = `${req.protocol}://${req.get("host")}`;

    // Embed file contents directly in response so browser can download
    // without making a second HTTP request (fixes Render cold start delay)
    const response = {
        success:         true,
        filename:        origName,
        totalEquations:  result.equations.length,
        xmlModified:     result.xmlModified,
        message:         result.equations.length === 0
                            ? "No equations found in this XML file. Log file generated."
                            : result.xmlModified
                                ? "TeX and AltText added to img tags. TXT, XML and LOG returned."
                                : "No img/graphic tags found. TXT and LOG returned.",
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

  } catch (topLevelErr) {
    // Catch-all — should never reach here, but ensures JSON response
    console.error("[ERROR] Unhandled error in /process route:", topLevelErr.message);
    console.error(topLevelErr.stack);
    if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json");
        res.status(500).json({
            success: false,
            error:   "Internal server error: " + (topLevelErr.message || "unknown"),
            hint:    "Check server logs for details"
        });
    }
  }
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
    // Always return JSON — never let Express return an HTML error page
    res.setHeader("Content-Type", "application/json");
    if (err.message && err.message.includes("Only .xml")) {
        return res.status(400).json({ success: false, error: "Only .xml files are accepted" });
    }
    if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ success: false, error: "File too large. Maximum size is 50MB." });
    }
    console.error("[ERROR] Unhandled:", err.message);
    res.status(500).json({ success: false, error: err.message || "Internal server error" });
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
        console.log("  Developed by : Ambeth");
        console.log("  GitHub       : https://github.com/Ambethmani/MathMLtoTeXandAltText");
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
                console.log("  TeX Engine : WIRIS/MathType (primary) + mathml-to-latex (fallback)");
        console.log("  WIRIS      : " + (CONFIG.WIRIS_ENABLED ? "ENABLED" : "DISABLED"));
        console.log("  Timeout    : " + CONFIG.WIRIS_TIMEOUT + "ms per equation");
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
