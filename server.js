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
const EventEmitter = require("events");

// Per-request progress emitter
// Key: requestId, Value: EventEmitter
const progressEmitters = new Map();
function emitProgress(reqId, step, label, pct, extra) {
    const emitter = progressEmitters.get(reqId);
    if (emitter) emitter.emit("progress", { step, label, pct, ...( extra || {}) });
}

/* ================================================================
   EXPRESS SETUP
================================================================ */

const app    = express();
const PORT   = process.env.PORT || 3000;

// ── Global uncaught error handlers ──────────────────────────────
process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught Exception:", err.message);
    console.error(err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[FATAL] Unhandled Promise Rejection:", reason);
});

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin",  "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
const UPLOAD = path.join(__dirname, "uploads");
const OUTPUT = path.join(__dirname, "outputs");

[UPLOAD, OUTPUT].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

/* ================================================================
   CLOUD STORAGE CLEANUP
================================================================ */
const MAX_FILE_AGE_MS = parseInt(process.env.MAX_FILE_AGE_MS || "3600000");

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

setInterval(cleanOldOutputFiles, 30 * 60 * 1000);

const IS_CLOUD = !!(
    process.env.RENDER ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.DYNO ||
    process.env.K_SERVICE
);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD),
    filename:    (req, file, cb) => cb(null, Date.now() + "_" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_"))
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
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
    "\u27E8":"left angle bracket",  "\u27E9":"right angle bracket",
    "\u2329":"left angle bracket",  "\u232A":"right angle bracket",
    "\u3008":"left angle bracket",  "\u3009":"right angle bracket",
    "\u27EA":"left double angle bracket","\u27EB":"right double angle bracket",
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
================================================================ */

const SUPPORTED_ELEMENTS = new Set([
    "math","mrow","mi","mn","mo","mtext","ms","mspace",
    "msup","msub","msubsup","munder","mover","munderover",
    "mfrac","msqrt","mroot","mfenced","mtable","mtr","mtd",
    "mstyle","merror","mpadded","mphantom","semantics",
    "annotation","annotation-xml","mmultiscripts","mprescripts",
    "mlabeledtr","maligngroup","malignmark","none"
]);

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
        if (node.nodeType === 3) return;

        const tag = node.nodeName.replace(/^mml:/i, "").toLowerCase();
        totalNodes++;
        maxDepth = Math.max(maxDepth, depth);

        elementCounts[tag] = (elementCounts[tag] || 0) + 1;

        if (!SUPPORTED_ELEMENTS.has(tag)) unsupported.add(tag);
        if (COMPLEX_ELEMENTS.has(tag))    complex.add(tag);

        [...(node.children || [])].forEach(child => traverse(child, depth + 1));
    }

    traverse(mathNode, 0);

    let level = "LOW";
    let reasons = [];

    if (maxDepth >= 8)        { level = "VERY HIGH"; reasons.push(`deep nesting (depth ${maxDepth})`); }
    else if (maxDepth >= 5)   { level = "HIGH";      reasons.push(`moderate nesting (depth ${maxDepth})`); }
    else if (maxDepth >= 3)   { level = "MEDIUM";    reasons.push(`some nesting (depth ${maxDepth})`); }

    if (totalNodes >= 50)     { level = "VERY HIGH"; reasons.push(`large equation (${totalNodes} nodes)`); }
    else if (totalNodes >= 25){ if (level !== "VERY HIGH") level = "HIGH"; reasons.push(`medium equation (${totalNodes} nodes)`); }

    if (unsupported.size > 0) { level = "VERY HIGH"; reasons.push(`unsupported elements: ${[...unsupported].join(", ")}`); }
    if (complex.size > 0)     { if (level === "LOW" || level === "MEDIUM") level = "HIGH"; reasons.push(`complex elements: ${[...complex].join(", ")}`); }

    const fracCount = elementCounts["mfrac"] || 0;
    if (fracCount >= 3)       { reasons.push(`multiple nested fractions (${fracCount}x mfrac)`); }

    const scriptCount = (elementCounts["msup"] || 0) + (elementCounts["msub"] || 0) +
                        (elementCounts["msubsup"] || 0) + (elementCounts["munderover"] || 0);
    if (scriptCount >= 5)     { reasons.push(`many script elements (${scriptCount} total)`); }

    if (elementCounts["mtable"]) { reasons.push(`contains matrix/table (${elementCounts["mtable"]}x mtable)`); }

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
================================================================ */

const CONFIG = {
    WIRIS_ENABLED:  process.env.WIRIS_ENABLED !== "false",
    WIRIS_ENDPOINT: "https://www.wiris.net/demo/editor/mathml2latex",
    WIRIS_TIMEOUT:  parseInt(process.env.WIRIS_TIMEOUT || "4000"),
    WIRIS_MAX_EQ:   parseInt(process.env.WIRIS_MAX_EQ || "99999"),
    LOG_ENGINE_USED: true,
    WIRIS_BATCH_SIZE: parseInt(process.env.WIRIS_BATCH_SIZE || "5")
};

const _httpsAgent = new (require("https").Agent)({ keepAlive: true, maxSockets: 15 });
const _httpAgent  = new (require("http").Agent)({ keepAlive: true, maxSockets: 15 });

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
                timeout: CONFIG.WIRIS_TIMEOUT,
                agent:   isHttps ? _httpsAgent : _httpAgent
            };

            const req = lib.request(options, (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data",  chunk => { data += chunk; });
                res.on("end",   ()    => {
                    const trimmed = data.trim();

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

                    const lowerTrimmed = trimmed.toLowerCase();
                    const isWirisError = !trimmed ||
                        WIRIS_ERROR_PATTERNS.some(p =>
                            lowerTrimmed.startsWith(p) ||
                            lowerTrimmed.includes(p)
                        ) ||
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

const DELIMITER_ENTITY_MAP = {
    "∣":  "&#x007C;",
    "|":  "&#x007C;",
    "‖":  "&#x2016;",
    "⟨":  "&#x27E8;",
    "⟩":  "&#x27E9;",
    "〈": "&#x27E8;",
    "〉": "&#x27E9;",
    "〈": "&#x27E8;",
    "〉": "&#x27E9;",
    "⌈":  "&#x2308;",
    "⌉":  "&#x2309;",
    "⌊":  "&#x230A;",
    "⌋":  "&#x230B;",
    "{":  "&#x007B;",
    "}":  "&#x007D;",
    "":   ""
};

function postProcessTeX(tex) {
    if (!tex) return tex;
    let t = tex;
    t = t.replace(/\\left\s*\u2223/g,  "\\left|");
    t = t.replace(/\\right\s*\u2223/g, "\\right|");
    t = t.replace(/\\left\s*\|/g,      "\\left|");
    t = t.replace(/\\right\s*\|/g,     "\\right|");
    t = t.replace(/\\left\s*\u27E8/g,  "\\left\\langle");
    t = t.replace(/\\right\s*\u27E9/g, "\\right\\rangle");
    t = t.replace(/\\left\s*\u2329/g,  "\\left\\langle");
    t = t.replace(/\\right\s*\u232A/g, "\\right\\rangle");
    t = t.replace(/\\left\s*\u3008/g,  "\\left\\langle");
    t = t.replace(/\\right\s*\u3009/g, "\\right\\rangle");
    t = t.replace(/\\left\s*\u2308/g,  "\\left\\lceil");
    t = t.replace(/\\right\s*\u2309/g, "\\right\\rceil");
    t = t.replace(/\\left\s*\u230A/g,  "\\left\\lfloor");
    t = t.replace(/\\right\s*\u230B/g, "\\right\\rfloor");
    t = t.replace(/\u2297/g, "\\otimes");
    t = t.replace(/\u2295/g, "\\oplus");
    t = t.replace(/\u2296/g, "\\ominus");
    t = t.replace(/\u2299/g, "\\odot");
    t = t.replace(/\u2211/g, "\\sum");
    t = t.replace(/\u220F/g, "\\prod");
    t = t.replace(/\u222B/g, "\\int");
    t = t.replace(/\u2202/g, "\\partial");
    t = t.replace(/\u2207/g, "\\nabla");
    t = t.replace(/\u221E/g, "\\infty");
    t = t.replace(/\u2264/g, "\\leq");
    t = t.replace(/\u2265/g, "\\geq");
    t = t.replace(/\u2260/g, "\\neq");
    t = t.replace(/\u2248/g, "\\approx");
    t = t.replace(/\u2192/g, "\\to");
    t = t.replace(/\u2190/g, "\\leftarrow");
    t = t.replace(/\u2194/g, "\\leftrightarrow");
    t = t.replace(/\u21D2/g, "\\Rightarrow");
    t = t.replace(/\u21D4/g, "\\Leftrightarrow");
    t = t.replace(/\u2208/g, "\\in");
    t = t.replace(/\u2209/g, "\\notin");
    t = t.replace(/\u222A/g, "\\cup");
    t = t.replace(/\u2229/g, "\\cap");
    t = t.replace(/\u2205/g, "\\emptyset");
    t = t.replace(/\u03B1/g, "\\alpha");
    t = t.replace(/\u03B2/g, "\\beta");
    t = t.replace(/\u03B3/g, "\\gamma");
    t = t.replace(/\u03B4/g, "\\delta");
    t = t.replace(/\u03B5/g, "\\epsilon");
    t = t.replace(/\u03B8/g, "\\theta");
    t = t.replace(/\u03BB/g, "\\lambda");
    t = t.replace(/\u03BC/g, "\\mu");
    t = t.replace(/\u03BE/g, "\\xi");
    t = t.replace(/\u03C0/g, "\\pi");
    t = t.replace(/\u03C1/g, "\\rho");
    t = t.replace(/\u03C3/g, "\\sigma");
    t = t.replace(/\u03C4/g, "\\tau");
    t = t.replace(/\u03C6/g, "\\phi");
    t = t.replace(/\u03C7/g, "\\chi");
    t = t.replace(/\u03C8/g, "\\psi");
    t = t.replace(/\u03C9/g, "\\omega");
    t = t.replace(/\u0393/g, "\\Gamma");
    t = t.replace(/\u0394/g, "\\Delta");
    t = t.replace(/\u039B/g, "\\Lambda");
    t = t.replace(/\u03A3/g, "\\Sigma");
    t = t.replace(/\u03A6/g, "\\Phi");
    t = t.replace(/\u03A8/g, "\\Psi");
    t = t.replace(/\u03A9/g, "\\Omega");
    t = t.replace(/\u200D/g, "").replace(/\u200B/g, "");
    t = t.replace(/  +/g, " ").trim();
    return t;
}

function prepareMathML(mathNode) {
    let mathmlStr = mathNode.outerHTML || "";
    if (!mathmlStr.trim().startsWith("<math") &&
        !mathmlStr.trim().startsWith("<mml:math")) {
        mathmlStr = `<math>${mathmlStr}</math>`;
    }
    mathmlStr = mathmlStr
        .replace(/<mml:/g,  "<")
        .replace(/<\/mml:/g, "</");

    mathmlStr = mathmlStr.replace(/\s+id="[^"]*"/g, "");

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

    mathmlStr = mathmlStr
        .replace(/<mo([^>]*)>∣<\/mo>/g,  "<mo$1>|</mo>")
        .replace(/<mo([^>]*)>⟨<\/mo>/g,  "<mo$1>&#x27E8;</mo>")
        .replace(/<mo([^>]*)>⟩<\/mo>/g,  "<mo$1>&#x27E9;</mo>");

    if (!mathmlStr.includes("xmlns")) {
        mathmlStr = mathmlStr.replace(
            /^<math/,
            '<math xmlns="http://www.w3.org/1998/Math/MathML"'
        );
    }

    return mathmlStr;
}

/* ================================================================
   SPRINGER TEX WALKER
================================================================ */
function springerTeXWalker(mathNode) {
    function walk(node) {
        if (!node) return "";
        if (node.nodeType === 3) return node.textContent;

        const name = (node.nodeName || "").toLowerCase().replace(/^mml:/, "");

        switch (name) {
            case "math":
            case "mrow":
            case "mstyle":
            case "mpadded":
            case "mphantom":
            case "merror":
                return [...node.childNodes].map(walk).join("");

            case "mi":
                return `{${node.textContent}}`;

            case "mn":
                return `{${node.textContent}}`;

            case "mo": {
                const op = node.textContent.trim();
                const opMap = {
                    "∑": "\\sum", "∏": "\\prod", "∫": "\\int",
                    "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint",
                    "∞": "\\infty", "±": "\\pm", "∓": "\\mp",
                    "×": "\\times", "÷": "\\div", "·": "\\cdot",
                    "≤": "\\leq", "≥": "\\geq", "≠": "\\neq",
                    "≈": "\\approx", "∼": "\\sim", "≡": "\\equiv",
                    "∈": "\\in", "∉": "\\notin", "⊂": "\\subset",
                    "⊃": "\\supset", "∩": "\\cap", "∪": "\\cup",
                    "→": "\\rightarrow", "←": "\\leftarrow",
                    "↔": "\\leftrightarrow", "⇒": "\\Rightarrow",
                    "⇔": "\\Leftrightarrow", "∂": "\\partial",
                    "∇": "\\nabla", "√": "\\sqrt", "α": "\\alpha",
                    "β": "\\beta", "γ": "\\gamma", "δ": "\\delta",
                    "ε": "\\epsilon", "ζ": "\\zeta", "η": "\\eta",
                    "θ": "\\theta", "λ": "\\lambda", "μ": "\\mu",
                    "ν": "\\nu", "π": "\\pi", "ρ": "\\rho",
                    "σ": "\\sigma", "τ": "\\tau", "φ": "\\phi",
                    "χ": "\\chi", "ψ": "\\psi", "ω": "\\omega",
                    "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta",
                    "Λ": "\\Lambda", "Π": "\\Pi", "Σ": "\\Sigma",
                    "Φ": "\\Phi", "Ψ": "\\Psi", "Ω": "\\Omega",
                    "∀": "\\forall", "∃": "\\exists", "¬": "\\neg",
                    "∧": "\\wedge", "∨": "\\vee", "⊕": "\\oplus",
                    "⊗": "\\otimes", "′": "'", "″": "''",
                    "(": "(", ")": ")", "[": "[", "]": "]",
                    "{": "\\{", "}": "\\}", "|": "|",
                    "‖": "\\|", "⟨": "\\langle", "⟩": "\\rangle",
                };
                return opMap[op] !== undefined ? opMap[op] : op;
            }

            case "msub":
                if (node.children.length >= 2)
                    return `{${walk(node.children[0])}}_{${walk(node.children[1])}}`;
                return [...node.childNodes].map(walk).join("");

            case "msup":
                if (node.children.length >= 2)
                    return `{${walk(node.children[0])}}^{${walk(node.children[1])}}`;
                return [...node.childNodes].map(walk).join("");

            case "msubsup":
                if (node.children.length >= 3)
                    return `{${walk(node.children[0])}}_{${walk(node.children[1])}}^{${walk(node.children[2])}}`;
                return [...node.childNodes].map(walk).join("");

            case "mfrac":
                if (node.children.length >= 2)
                    return `\\frac{${walk(node.children[0])}}{${walk(node.children[1])}}`;
                return [...node.childNodes].map(walk).join("");

            case "msqrt":
                if (node.children.length === 1)
                    return `\\sqrt{${walk(node.children[0])}}`;
                return `\\sqrt{${[...node.children].map(walk).join("")}}`;

            case "mroot":
                if (node.children.length >= 2)
                    return `\\sqrt[${walk(node.children[1])}]{${walk(node.children[0])}}`;
                return [...node.childNodes].map(walk).join("");

            case "munderover":
                if (node.children.length >= 3) {
                    const base = walk(node.children[0]);
                    const under = walk(node.children[1]);
                    const over  = walk(node.children[2]);
                    const baseText = node.children[0].textContent.trim();
                    if (["∑","∏","∫","∮","⋃","⋂"].includes(baseText)) {
                        return `${base}_{${under}}^{${over}}`;
                    }
                    return `\\overset{${over}}{\\underset{${under}}{${base}}}`;
                }
                return [...node.childNodes].map(walk).join("");

            case "munder":
                if (node.children.length >= 2) {
                    const base  = walk(node.children[0]);
                    const under = walk(node.children[1]);
                    const baseText = node.children[0].textContent.trim();
                    if (["∑","∏","∫","∮","lim"].includes(baseText) ||
                        node.children[0].textContent.includes("lim")) {
                        return `${base}_{${under}}`;
                    }
                    return `\\underset{${under}}{${base}}`;
                }
                return [...node.childNodes].map(walk).join("");

            case "mover":
                if (node.children.length >= 2) {
                    const base = walk(node.children[0]);
                    const over = node.children[1].textContent.trim();
                    const accentMap = {
                        "−": `\\bar{${base}}`, "‾": `\\bar{${base}}`,
                        "¯": `\\bar{${base}}`, "˙": `\\dot{${base}}`,
                        "¨": `\\ddot{${base}}`, "˜": `\\tilde{${base}}`,
                        "^": `\\hat{${base}}`, "→": `\\vec{${base}}`,
                        "⃗": `\\vec{${base}}`, "∘": `\\mathring{${base}}`,
                        "⌢": `\\widehat{${base}}`,
                    };
                    if (accentMap[over]) return accentMap[over];
                    if (node.getAttribute && node.getAttribute("accent") === "true") {
                        return `\\overset{${walk(node.children[1])}}{${base}}`;
                    }
                    return `\\overset{${walk(node.children[1])}}{${base}}`;
                }
                return [...node.childNodes].map(walk).join("");

            case "mfenced": {
                const open  = node.getAttribute("open")  !== null ? node.getAttribute("open")  : "(";
                const close = node.getAttribute("close") !== null ? node.getAttribute("close") : ")";
                const sep   = node.getAttribute("separators") || ",";
                const kids  = [...node.children].map(walk);
                const openTex  = open  === "{" ? "\\{" : open  === "⟨" ? "\\langle" : open;
                const closeTex = close === "}" ? "\\}" : close === "⟩" ? "\\rangle" : close;
                return `\\left${openTex}${kids.join(sep)}\\right${closeTex}`;
            }

            case "mtable": {
                const rows = [...node.children].map(row => {
                    const cells = [...row.children].map(cell =>
                        [...cell.childNodes].map(walk).join("")
                    );
                    return cells.join(" & ");
                });
                return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
            }

            case "mtext": {
                const txt = node.textContent;
                if (txt.trim() === "") return "\\,";
                return `\\text{${txt}}`;
            }

            case "mspace": {
                const w = node.getAttribute("width") || "";
                if (w.includes("thin") || w === "0.167em") return "\\,";
                if (w.includes("med")  || w === "0.222em") return "\\:";
                if (w.includes("thick")|| w === "0.278em") return "\\;";
                if (parseFloat(w) <= 0) return "\\!";
                return "\\,";
            }

            case "semantics":
                if (node.children.length > 0) return walk(node.children[0]);
                return "";

            case "annotation":
            case "annotation-xml":
                return "";

            case "menclose": {
                const notation = node.getAttribute("notation") || "box";
                const inner = [...node.childNodes].map(walk).join("");
                if (notation.includes("radical")) return `\\sqrt{${inner}}`;
                return `\\boxed{${inner}}`;
            }

            default:
                return [...node.childNodes].map(walk).join("");
        }
    }

    try {
        const result = walk(mathNode);
        if (!result || !result.trim()) {
            return { value: "", status: "WARN", engine: "springer-walker", reason: "walker returned empty" };
        }
        return {
            value:  postProcessTeX(result),
            status: "OK",
            engine: "springer-walker",
            reason: "structural MathML walk (Springer format)"
        };
    } catch (e) {
        return { value: "", status: "FAIL", engine: "springer-walker", reason: "walker error: " + e.message };
    }
}

function generateTeXFallback(mathmlStr, mathNode) {
    try {
        const tex = MathMLToLaTeX.convert(mathmlStr);
        if (tex && tex.trim()) {
            const cleanTex = postProcessTeX(tex);
            const STALE = ["error converting from mathml to latex","error converting",
                           "error processing","invalid mathml","cannot convert"];
            const lower = cleanTex.toLowerCase();
            if (!STALE.some(s => lower.includes(s))) {
                return {
                    value:  cleanTex,
                    status: "OK",
                    engine: "mathml-to-latex",
                    reason: "mathml-to-latex fallback",
                    wirisAttempted: false
                };
            }
        }
    } catch (_) {}

    if (mathNode) {
        const walkerResult = springerTeXWalker(mathNode);
        if (walkerResult.status === "OK" && walkerResult.value) {
            console.log("  [TEX] springer-walker succeeded as second fallback");
            return { ...walkerResult, wirisAttempted: false };
        }
    }

    const complexity = analyzeMathMLComplexity(mathNode);
    return {
        value:      "",
        status:     "WARN",
        engine:     "fallback-chain",
        reason:     "all fallbacks exhausted (mathml-to-latex + springer-walker)",
        complexity,
        wirisAttempted: false
    };
}

async function generateTeX(mathNode, _texCache) {
    const mathmlStr = prepareMathML(mathNode);

    const cacheKey = mathmlStr.replace(/\s+/g, "");
    if (_texCache && _texCache.has(cacheKey)) {
        return { ..._texCache.get(cacheKey), reason: "cached" };
    }

    if (!CONFIG.WIRIS_ENABLED) {
        const result = generateTeXFallback(mathmlStr, mathNode);
        if (CONFIG.LOG_ENGINE_USED)
            console.log(`  [TEX] mathml-to-latex (WIRIS disabled)`);
        return result;
    }

    {
        const allChildren = mathNode ? [...mathNode.getElementsByTagName("*")] : [];
        const meaningfulTags = allChildren.filter(n => {
            const t = n.tagName.toLowerCase().replace(/^mml:/,"");
            return !["math","mrow","semantics","annotation","annotation-xml"].includes(t);
        });
        if (meaningfulTags.length === 1) {
            const t   = meaningfulTags[0].tagName.toLowerCase().replace(/^mml:/,"");
            const val = meaningfulTags[0].textContent.trim();
            if (["mi","mn","mo"].includes(t) && val && val.length <= 3) {
                const fastResult = { value: val, status: "OK", engine: "fast-path", reason: "single token", wirisAttempted: false };
                _texCache.set(cacheKey, fastResult);
                return fastResult;
            }
        }
    }

    try {
        const tex = await callWirisAPI(mathmlStr);

        if (!tex || tex.trim() === "") {
            console.log("  [TEX] WIRIS returned empty — falling back to mathml-to-latex");
            const fallback = generateTeXFallback(mathmlStr, mathNode);
            fallback.wirisAttempted = true;
            fallback.wirisResult    = "empty response";
            return fallback;
        }

        const cleanTex2 = postProcessTeX(tex);
        const result = {
            value:          cleanTex2,
            status:         "OK",
            engine:         "WIRIS/MathType API",
            reason:         "",
            complexity:     null,
            wirisAttempted: true,
            wirisResult:    "success"
        };
        if (_texCache) _texCache.set(cacheKey, result);
        return result;

    } catch (wirisErr) {
        console.log(`  [TEX] WIRIS failed: ${wirisErr.message}`);
        const fallback = generateTeXFallback(mathmlStr, mathNode);
        fallback.wirisAttempted = true;
        fallback.wirisResult    = wirisErr.message;
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
   BUILD JSON OUTPUT — replaces the old TXT builder
   Produces a structured JSON file: equations.json
================================================================ */
function buildJSONOutput(equations, filename, timestamp) {
    const now = new Date().toISOString();

    if (!equations || equations.length === 0) {
        return JSON.stringify({
            meta: {
                tool:      "MathMLtoTeXandAltText",
                inputFile: filename,
                processedAt: now,
                totalEquations: 0,
                status: "NO_EQUATIONS_FOUND"
            },
            equations: []
        }, null, 2);
    }

    const texOK    = equations.filter(e => e.texStatus === "OK").length;
    const texWarn  = equations.filter(e => e.texStatus === "WARN").length;
    const texError = equations.filter(e => e.texStatus === "ERROR").length;
    const altOK    = equations.filter(e => e.altStatus === "OK").length;
    const altWarn  = equations.filter(e => e.altStatus === "WARN").length;
    const altError = equations.filter(e => e.altStatus === "ERROR").length;

    const output = {
        meta: {
            tool:        "MathMLtoTeXandAltText",
            inputFile:   filename,
            processedAt: now,
            totalEquations: equations.length,
            withImgTag:     equations.filter(e => e.hasImg).length,
            withoutImgTag:  equations.filter(e => !e.hasImg).length,
            status: equations.every(e => e.texStatus === "OK" && e.altStatus === "OK")
                    ? "SUCCESS" : "COMPLETED_WITH_ISSUES",
            conversionSummary: {
                tex: { success: texOK, warnings: texWarn, errors: texError },
                alt: { success: altOK, warnings: altWarn, errors: altError }
            }
        },
        equations: equations.map((eq, i) => {
            const cx = eq.complexity || {};
            const obj = {
                index:      i + 1,
                id:         eq.id,
                type:       eq.type,
                format:     eq.format,
                hasImgTag:  eq.hasImg,
                writeTarget: eq.writeTarget || "none",
                tex: {
                    value:  eq.tex || "",
                    status: eq.texStatus || "UNKNOWN",
                    engine: eq.engine || "unknown",
                    wirisUsed: eq.wirisAttempted ? (eq.wirisResult === "success") : false
                },
                altText: {
                    value:  eq.alt || "",
                    status: eq.altStatus || "UNKNOWN"
                },
                mathml: eq.mathml || "",
                complexity: {
                    level:      cx.level || "N/A",
                    maxDepth:   cx.maxDepth || 0,
                    totalNodes: cx.totalNodes || 0,
                    reasons:    cx.reasons || []
                }
            };

            // Only include error details when there are issues
            if (eq.texStatus !== "OK" && eq.texReason) {
                obj.tex.failReason = eq.texReason;
            }
            if (eq.altStatus !== "OK" && eq.altReason) {
                obj.altText.failReason = eq.altReason;
            }
            if (cx.unsupportedElements && cx.unsupportedElements.length > 0) {
                obj.complexity.unsupportedElements = cx.unsupportedElements;
            }

            return obj;
        })
    };

    return JSON.stringify(output, null, 2);
}

/* ================================================================
   LOG FILE BUILDER
================================================================ */

function buildLog(equations, filename, timestamp) {
    const SEP  = "=".repeat(72);
    const DIV  = "-".repeat(72);
    const now  = new Date().toLocaleString();

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

    const SUB  = "~".repeat(72);
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

    const cxLow      = equations.filter(e => e.complexity && e.complexity.level === "LOW").length;
    const cxMedium   = equations.filter(e => e.complexity && e.complexity.level === "MEDIUM").length;
    const cxHigh     = equations.filter(e => e.complexity && e.complexity.level === "HIGH").length;
    const cxVeryHigh = equations.filter(e => e.complexity && e.complexity.level === "VERY HIGH").length;

    const lines = [];

    lines.push(SEP);
    lines.push("  MathMLtoTeXandAltText — Processing Log");
    lines.push(SEP);
    lines.push(`  Input File : ${filename}`);
    lines.push(`  Processed  : ${now}`);
    lines.push(SEP);
    lines.push("");

    lines.push("  [SECTION 1]  SUMMARY");
    lines.push(DIV);
    lines.push("");
    lines.push(`  Total Equations Found    : ${total}`);
    lines.push(`  With IMG tag  (XML+JSON) : ${withImg}`);
    lines.push(`  Without IMG tag (JSON)   : ${withoutImg}`);
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
    lines.push(`    LOW       : ${cxLow}`);
    lines.push(`    MEDIUM    : ${cxMedium}`);
    lines.push(`    HIGH      : ${cxHigh}`);
    lines.push(`    VERY HIGH : ${cxVeryHigh}`);
    lines.push("");

    if (allOK) {
        lines.push(`  OVERALL STATUS : SUCCESS`);
        lines.push(`  All ${total} equations converted successfully with no errors.`);
    } else {
        lines.push(`  OVERALL STATUS : COMPLETED WITH ISSUES`);
        lines.push(`  ${failedEqs.length} of ${total} equations had conversion problems.`);
    }
    lines.push("");
    lines.push(DIV);
    lines.push("");

    lines.push("  [SECTION 2]  ALL EQUATIONS — FULL DETAIL");
    lines.push(DIV);
    lines.push("");

    equations.forEach((eq, i) => {
        const num      = String(i + 1).padStart(3, "0");
        const texIcon  = eq.texStatus === "OK" ? "[OK  ]" : eq.texStatus === "WARN" ? "[WARN]" : "[FAIL]";
        const altIcon  = eq.altStatus === "OK" ? "[OK  ]" : eq.altStatus === "WARN" ? "[WARN]" : "[FAIL]";
        const cx       = eq.complexity || {};
        const cxLabel  = cx.level || "N/A";
        const imgLine  = eq.hasImg ? "YES — tex + alttext written to img tag" : "NO  — JSON output only";
        const engineUsed = eq.engine || "mathml-to-latex";
        const wirisInfo  = eq.wirisAttempted
            ? (eq.wirisResult === "success" ? "WIRIS used" : `WIRIS failed → fallback (${(eq.wirisResult||"").substring(0,60)})`)
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

    if (failedEqs.length > 0) {
        lines.push("  [SECTION 3]  EQUATIONS WITH ISSUES — COMPLEXITY ANALYSIS");
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

            if (eq.texStatus !== "OK") {
                lines.push(`  TeX Conversion  : ${eq.texStatus}`);
                lines.push(`  TeX Error       : ${eq.texReason || "empty result — no error thrown"}`);
                lines.push("");
            }

            if (eq.altStatus !== "OK") {
                lines.push(`  Alt Generation  : ${eq.altStatus}`);
                lines.push(`  Alt Error       : ${eq.altReason || "empty result — no error thrown"}`);
                lines.push("");
            }

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
                const elemList = cx.uniqueElements.map(e => `${e}(${cx.elementCounts[e] || 1})`);
                lines.push(`    ${elemList.join(", ")}`);
                lines.push("");
            }

            if (cx.unsupportedElements && cx.unsupportedElements.length > 0) {
                lines.push(`  UNSUPPORTED ELEMENTS (likely caused failure):`);
                cx.unsupportedElements.forEach(e => lines.push(`    ! <${e}> — not handled by mathml-to-latex`));
                lines.push("");
            }

            lines.push(`  FULL MATHML (for debugging):`);
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

    const veryHighEqs = equations.filter(e => e.complexity && e.complexity.level === "VERY HIGH");
    if (veryHighEqs.length > 0) {
        lines.push("  [SECTION 4]  VERY HIGH COMPLEXITY EQUATIONS");
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

    lines.push(SEP);
    lines.push(`  End of Log`);
    lines.push(`  File    : ${filename}`);
    lines.push(`  Time    : ${now}`);
    lines.push(`  Total   : ${total} equations  |  Issues: ${failedEqs.length}  |  Status: ${allOK ? "SUCCESS" : "ISSUES FOUND"}`);
    lines.push(SEP);

    return lines.join("\n");
}

/* ================================================================
   STRIP DOCTYPE — extracts and preserves the full DOCTYPE block
   before stripping it for JSDOM parsing.
   Returns { doctype: string|null, cleanXml: string }
================================================================ */
function extractAndStripDOCTYPE(xml) {
    let result = xml;
    let doctype = null;

    // Step 1: Find and extract the complete DOCTYPE block (including internal subset)
    const dtStart = result.indexOf("<!DOCTYPE");
    if (dtStart !== -1) {
        const bracketOpen = result.indexOf("[", dtStart);
        const firstGT     = result.indexOf(">", dtStart);

        if (bracketOpen !== -1 && bracketOpen < firstGT) {
            // Has internal subset [...]
            const bracketClose = result.indexOf("]>", bracketOpen);
            if (bracketClose !== -1) {
                doctype = result.slice(dtStart, bracketClose + 2); // includes ]>
                result  = result.slice(0, dtStart) + result.slice(bracketClose + 2);
            } else {
                doctype = result.slice(dtStart, firstGT + 1);
                result  = result.slice(0, dtStart) + result.slice(firstGT + 1);
            }
        } else if (firstGT !== -1) {
            doctype = result.slice(dtStart, firstGT + 1);
            result  = result.slice(0, dtStart) + result.slice(firstGT + 1);
        }
    }

    // Step 2: Strip remaining ENTITY declarations (shouldn't be any after step 1, but be safe)
    result = result.replace(/<!ENTITY[^>]*>/gi, "");

    // Step 3: Strip non-xml processing instructions
    result = result.replace(/<\?(?!xml)[\s\S]*?\?>/gi, "");

    // Step 4: Normalize line endings
    result = result.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Step 5: Replace unknown entity references with empty string (NDATA etc)
    const STD_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
    result = result.replace(/&([a-zA-Z][a-zA-Z0-9_.-]*);/g, (match, name) => {
        if (STD_ENTITIES.has(name)) return match;
        return ""; // strip NDATA entity refs like &gr1; &gr2; etc
    });

    return { doctype, cleanXml: result.trim() };
}

// Legacy alias kept for backward compatibility with watcher
function stripDOCTYPE(xml) {
    return extractAndStripDOCTYPE(xml).cleanXml;
}

/* ================================================================
   RESTORE DOCTYPE into output XML
   Injects the preserved DOCTYPE right after the <?xml ...?> declaration.
================================================================ */
function restoreDOCTYPE(xml, doctype) {
    if (!doctype || !xml) return xml;

    // Find end of <?xml ... ?> declaration if present
    if (xml.startsWith("<?xml")) {
        const declEnd = xml.indexOf("?>") + 2;
        return xml.slice(0, declEnd) + "\n" + doctype + "\n" + xml.slice(declEnd);
    }

    // No XML declaration — prepend both
    return '<?xml version="1.0" encoding="utf-8"?>\n' + doctype + "\n" + xml;
}

/* ================================================================
   ELSEVIER BIBLIOGRAPHY STRIP (for JSDOM performance only)
================================================================ */
function stripElsevierBibliography(xml) {
    const before = xml.length;
    let stripped = 0;

    function stripTag(src, openTag, closeTag) {
        let out = "", p = 0;
        while (p < src.length) {
            const start = src.indexOf(openTag, p);
            if (start === -1) { out += src.slice(p); break; }
            out += src.slice(p, start);
            const end = src.indexOf(closeTag, start + openTag.length);
            if (end === -1) { out += src.slice(start); break; }
            const block = src.slice(start, end + closeTag.length);
            if (block.indexOf("<mml:math") !== -1 || block.indexOf("<math") !== -1) {
                out += block;
            } else { stripped++; }
            p = end + closeTag.length;
        }
        return out;
    }

    let result = xml;
    result = stripTag(result, "<ce:bib-reference", "</ce:bib-reference>");
    result = stripTag(result, "<sb:reference",     "</sb:reference>");

    const saved = Math.round((before - result.length) / 1024);
    if (saved > 0) console.log(`  [INFO] Elsevier strip: saved ${saved}KB, removed ${stripped} bib items`);
    return result;
}

async function processBatch(items, fn, batchSize, onBatchDone) {
    const sz = batchSize || CONFIG.WIRIS_BATCH_SIZE || 5;
    for (let i = 0; i < items.length; i += sz) {
        await Promise.all(items.slice(i, i + sz).map(fn));
        if (onBatchDone) onBatchDone(Math.min(i + sz, items.length), items.length);
    }
}

/* ================================================================
   FAST XML PATCHER — EQUATION-MATCHED VERSION
   ---------------------------------------------------------------
   FIX: Instead of searching globally for the "next untagged graphic",
   we now match each equation to its graphic element precisely using:

   1. For math[@altimg]:  match by the exact altimg="" value
      e.g. altimg="si0001.svg" is globally unique in the document

   2. For graphic/inline-graphic: match by POSITION in the document,
      not by "first untagged". We record the character offset of the
      formula's opening tag in the original XML string, then scan
      forward from that position to find the graphic tag inside it.

   3. Each equation stores srcOffset (position of its formula container
      opening tag) and srcEnd (closing tag position) so we can do a
      bounded search within the formula's XML span.
================================================================ */
function patchXMLString(xml, equations) {
    let result = xml;

    for (const eq of equations) {
        if (!eq.hasImg || !eq.writeTarget || eq.writeTarget === "none") continue;
        const tex = eq.tex || "";
        const alt = eq.alt || "";
        if (!tex && !alt) continue;

        if (eq.writeTarget === "math[@altimg]" && eq.altimgVal) {
            // ── CASE 1: math[@altimg] — match by exact altimg value ──
            // This is globally unique per equation (e.g. "si0001.svg")
            result = injectAttrsOnAttrValue(
                result,
                ["mml:math", "math"],
                "altimg", eq.altimgVal,
                tex, alt
            );

        } else if (eq.writeTarget === "graphic") {
            // ── CASE 2: graphic/inline-graphic — bounded position search ──
            // Use the stored srcOffset to find the formula container in the
            // output XML, then search for the graphic tag ONLY within that span.
            if (eq.srcOffset !== undefined && eq.srcEnd !== undefined) {
                result = patchGraphicInSpan(result, eq.srcOffset, eq.srcEnd, eq.imgElemId, tex, alt);
            } else if (eq.imgElemId) {
                // Fallback: known unique id/src on the graphic element
                result = injectAttrsOnAttrValue(
                    result,
                    ["inline-graphic","graphic","img","ce:inline-graphic","ce:graphic"],
                    "id", eq.imgElemId,
                    tex, alt
                );
            }
            // If neither srcOffset nor imgElemId is available, skip this equation
            // to avoid mis-patching a wrong graphic element
        }
    }
    return result;
}

/* ----------------------------------------------------------------
   patchGraphicInSpan
   Find the formula container in the XML string using its stored
   source offset, then inject tex/alttext on the graphic tag inside it.
---------------------------------------------------------------- */
function patchGraphicInSpan(xml, storedOffset, storedEnd, imgElemId, tex, alt) {
    // The stored offsets were recorded on the cleanXML before any
    // patchXMLString mutations. Previous patches may have shifted
    // character positions — so we re-anchor by searching from the
    // stored position with a ±2000 char tolerance window.

    const WINDOW = 2000;
    const searchFrom = Math.max(0, storedOffset - WINDOW);
    const searchTo   = Math.min(xml.length, storedEnd + WINDOW);
    const segment    = xml.slice(searchFrom, searchTo);

    // Within this segment, look for the first unpatched graphic tag
    const GRAPHIC_TAGS = ["inline-graphic","graphic","ce:inline-graphic","ce:graphic","img"];

    for (const tagName of GRAPHIC_TAGS) {
        const openStr = "<" + tagName;
        let p = 0;
        while (p < segment.length) {
            const start = segment.indexOf(openStr, p);
            if (start === -1) break;

            // Ensure correct tag boundary
            const afterTag = segment[start + openStr.length];
            if (afterTag !== " " && afterTag !== "\t" && afterTag !== "\n" &&
                afterTag !== ">" && afterTag !== "/") {
                p = start + openStr.length;
                continue;
            }

            // Find end of tag
            let end = -1, inQ = false, qChar = "";
            for (let i = start; i < segment.length; i++) {
                const c = segment[i];
                if (!inQ && (c === "'" || c === '"')) { inQ = true; qChar = c; }
                else if (inQ && c === qChar) { inQ = false; }
                else if (!inQ && c === ">") { end = i; break; }
            }
            if (end === -1) break;

            const tag = segment.slice(start, end + 1);

            // Skip if already patched
            if (tag.indexOf(" tex=") !== -1) { p = end + 1; continue; }

            // If we have a known img element id, verify it matches
            if (imgElemId && tag.indexOf(imgElemId) === -1) {
                p = end + 1;
                continue;
            }

            // Patch this tag
            const isSelfClose = tag.endsWith("/>");
            const insertAt = isSelfClose ? tag.length - 2 : tag.length - 1;
            const newTag = tag.slice(0, insertAt) +
                (tex ? ` tex="${escapeXmlAttr(tex)}"` : "") +
                (alt ? ` alttext="${escapeXmlAttr(alt)}"` : "") +
                tag.slice(insertAt);

            const globalStart = searchFrom + start;
            const globalEnd   = searchFrom + end + 1;
            return xml.slice(0, globalStart) + newTag + xml.slice(globalEnd);
        }
    }

    return xml; // no graphic found in span — unchanged
}

/* ----------------------------------------------------------------
   injectAttrsOnAttrValue — used for math[@altimg] matching
---------------------------------------------------------------- */
function injectAttrsOnAttrValue(xml, tagNames, attrName, attrValue, tex, alt) {
    for (const tagName of tagNames) {
        const openStr = "<" + tagName;
        let p = 0;
        while (p < xml.length) {
            const start = xml.indexOf(openStr, p);
            if (start === -1) break;
            const afterTag = xml[start + openStr.length];
            if (afterTag !== " " && afterTag !== "\t" && afterTag !== "\n" && afterTag !== ">" && afterTag !== "/") {
                p = start + openStr.length; continue;
            }
            let end = -1, inQ = false, qChar = "";
            for (let i = start; i < xml.length; i++) {
                const c = xml[i];
                if (!inQ && (c === "'" || c === '"')) { inQ = true; qChar = c; }
                else if (inQ && c === qChar) { inQ = false; }
                else if (!inQ && c === ">") { end = i; break; }
            }
            if (end === -1) break;
            const tag = xml.slice(start, end + 1);
            if (tag.indexOf(attrName + '="' + attrValue + '"') !== -1 && tag.indexOf(" tex=") === -1) {
                const isSelfClose = tag.endsWith("/>");
                const insertAt = isSelfClose ? tag.length - 2 : tag.length - 1;
                const newTag = tag.slice(0, insertAt) +
                    (tex ? ` tex="${escapeXmlAttr(tex)}"` : "") +
                    (alt ? ` alttext="${escapeXmlAttr(alt)}"` : "") +
                    tag.slice(insertAt);
                return xml.slice(0, start) + newTag + xml.slice(end + 1);
            }
            p = end + 1;
        }
    }
    return xml;
}

function escapeXmlAttr(str) {
    return str.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/* ================================================================
   SOURCE OFFSET RECORDER
   After parsing with JSDOM, we need to know WHERE each formula
   container appears in the original cleanXML string so the patcher
   can do a bounded search.
   Strategy: use the formula's id attribute or a short text snippet
   from its opening tag to find its position in cleanXML.
================================================================ */
function findFormulaOffset(cleanXml, formulaTag, formulaId, formulaIndex, formulaTagVariants) {
    // Try each tag variant in order of specificity
    const tags = formulaTagVariants || [formulaTag];

    for (const tag of tags) {
        const openStr = "<" + tag;

        // Fast path: if we have an id, search for <tag ... id="..." ...>
        if (formulaId) {
            const idAttr = `id="${formulaId}"`;
            let p = 0;
            let occurrence = 0;
            while (p < cleanXml.length) {
                const start = cleanXml.indexOf(openStr, p);
                if (start === -1) break;
                // Find end of this opening tag
                let end = cleanXml.indexOf(">", start);
                if (end === -1) break;
                const tagContent = cleanXml.slice(start, end + 1);
                if (tagContent.indexOf(idAttr) !== -1) {
                    // Find the closing tag
                    const closeTag = "</" + tag + ">";
                    const closePos = cleanXml.indexOf(closeTag, end);
                    return {
                        srcOffset: start,
                        srcEnd:    closePos !== -1 ? closePos + closeTag.length : end + 1
                    };
                }
                p = end + 1;
            }
        }

        // Fallback: find by occurrence index (Nth tag of this type)
        {
            let p = 0;
            let occurrence = 0;
            while (p < cleanXml.length) {
                const start = cleanXml.indexOf(openStr, p);
                if (start === -1) break;
                const afterTag = cleanXml[start + openStr.length];
                if (afterTag === " " || afterTag === "\t" || afterTag === "\n" ||
                    afterTag === ">" || afterTag === "/") {
                    if (occurrence === formulaIndex) {
                        const closeTag = "</" + tag + ">";
                        const closePos = cleanXml.indexOf(closeTag, start);
                        return {
                            srcOffset: start,
                            srcEnd:    closePos !== -1 ? closePos + closeTag.length : start + 200
                        };
                    }
                    occurrence++;
                }
                p = start + openStr.length;
            }
        }
    }

    return { srcOffset: undefined, srcEnd: undefined };
}

/* ================================================================
   CORE PROCESSOR
================================================================ */

async function processXML(rawXML, filename, reqId) {
    const _texCache = new Map();

    const hasMath = (
        rawXML.indexOf("<math")            !== -1 ||
        rawXML.indexOf("<mml:math")        !== -1 ||
        rawXML.indexOf("inline-formula")   !== -1 ||
        rawXML.indexOf("disp-formula")     !== -1 ||
        rawXML.indexOf("InlineEquation")   !== -1 ||
        rawXML.indexOf("<Equation")        !== -1 ||
        rawXML.indexOf("type=\"eqn\"")   !== -1 ||
        rawXML.indexOf("type='eqn'")     !== -1 ||
        rawXML.indexOf("display-formula")  !== -1 ||
        rawXML.indexOf("display-equation") !== -1 ||
        rawXML.indexOf("inline-equation")  !== -1 ||
        rawXML.indexOf("equation-group")   !== -1
    );

    if (!hasMath) {
        console.log("  [INFO] No math/equation tags found — skipping DOM parse");
        const jsonContent = buildJSONOutput([], filename, Date.now());
        return {
            equations:   [],
            jsonContent,
            xmlContent:  null,
            xmlModified: false,
            logContent:  buildLog([], filename, Date.now())
        };
    }

    // ── Extract DOCTYPE BEFORE any stripping ──────────────────────
    // This is the single source of truth for the DOCTYPE.
    // We extract it here so it is available for both:
    //   (a) the folder watcher path
    //   (b) the HTTP route (which also does its own extraction)
    // Whichever runs processXML gets a clean XML without DOCTYPE,
    // but the doctype is returned in the result for the caller to restore.
    const { doctype: extractedDoctype, cleanXml: cleanXML } = extractAndStripDOCTYPE(rawXML);

    if (extractedDoctype) {
        console.log(`  [INFO] DOCTYPE extracted and preserved (${extractedDoctype.length} chars)`);
    }

    // ── Elsevier size reduction for JSDOM ────────────────────────
    let jsdomXML = cleanXML;
    const isElsevier = cleanXML.indexOf("<ce:") !== -1 || cleanXML.indexOf(" ce:") !== -1;
    if (isElsevier) {
        try {
            const stripped = stripElsevierBibliography(cleanXML);
            if (stripped.length < cleanXML.length * 0.8) {
                console.log(`  [INFO] Elsevier jsdom XML reduced: ${cleanXML.length} → ${stripped.length} chars`);
                jsdomXML = stripped;
            }
        } catch (_) {}
    }

    // ── Inject missing namespace declarations ──────────────────
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
        "xsi":   "http://www.w3.org/2001/XMLSchema-instance",
        "wiley":  "http://www.interscience.wiley.com/namespaces/wiley",
        "als":    "http://schema.aip.org/schema/als/1.0",
        "bits":   "http://jats.nlm.nih.gov/ns/archiving/1.0/"
    };

    function injectNamespaces(xml) {
        const rootMatch = xml.match(/<([a-zA-Z][a-zA-Z0-9_:-]*)(\s[^>]*)?>/);
        if (!rootMatch) return xml;

        const fullTag       = rootMatch[0];
        const tagName       = rootMatch[1];
        const existingAttrs = rootMatch[2] || "";

        const missing = [];
        for (const [prefix, uri] of Object.entries(KNOWN_NAMESPACES)) {
            if (!existingAttrs.includes("xmlns:" + prefix)) {
                missing.push([prefix, uri]);
            }
        }
        if (missing.length === 0) return xml;

        const usedPrefixes = new Set();
        for (const [prefix] of missing) {
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
        return xml.replace(fullTag, newTag);
    }

    const cleanXMLWithNS = injectNamespaces(cleanXML);
    const jsdomXMLWithNS = jsdomXML === cleanXML ? cleanXMLWithNS : injectNamespaces(jsdomXML);

    // ── Parse with JSDOM ─────────────────────────────────────────
    let dom, document;

    try {
        dom      = new JSDOM(jsdomXMLWithNS, Object.assign(
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
        try {
            dom      = new JSDOM(jsdomXMLWithNS, Object.assign(
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

    // ── Counters for offset tracking ─────────────────────────────
    // We count occurrences of each formula tag so we can find
    // the Nth occurrence in the original XML string.
    const tagOccurrenceCounter = {};

    // ── Helper: process one formula element ──────────────────────
    async function processFormula(eq, type, format, idFallback, tagName, tagVariants) {
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
        const texRes = await generateTeX(math, _texCache);
        const altRes = generateAltText(math);

        const tex = texRes.value;
        const alt = altRes.value;

        // ── Track source offset for this formula ──────────────────
        // Record which occurrence this is (0-based) for the offset finder
        const tkey = tagName || "unknown";
        if (tagOccurrenceCounter[tkey] === undefined) tagOccurrenceCounter[tkey] = 0;
        const thisOccurrence = tagOccurrenceCounter[tkey]++;

        const { srcOffset, srcEnd } = findFormulaOffset(
            cleanXMLWithNS, tagName, id, thisOccurrence, tagVariants
        );

        const eqEls = [...(eq.getElementsByTagName("*") || [])];
        const imgEl =
            eq.querySelector("inline-graphic")            ||
            eq.querySelector("graphic")                    ||
            eqEls.find(el => el.tagName.toLowerCase() === "ce:inline-graphic") ||
            eqEls.find(el => el.tagName.toLowerCase() === "ce:graphic")        ||
            eq.querySelector("span.eqnimg img")            ||
            eq.querySelector("img.inlinegraphic")          ||
            eq.querySelector("img");

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

        // Extract a unique identifier from the img element for the patcher
        let imgElemId = null;
        if (imgEl) {
            imgElemId = imgEl.getAttribute("id") ||
                        imgEl.getAttribute("xlink:href") ||
                        imgEl.getAttribute("src") ||
                        null;
            cleanAndWrite(imgEl, tex, alt, texOK, altOK);
        } else if (math.hasAttribute("altimg")) {
            cleanAndWrite(math, tex, alt, texOK, altOK);
        }

        const complexity = analyzeMathMLComplexity(math);
        const hasTarget  = !!imgEl || math.hasAttribute("altimg");

        equations.push({
            type, format, id, tex, alt,
            mathml:        math.outerHTML,
            hasImg:        hasTarget,
            writeTarget:   imgEl ? "graphic" : (math.hasAttribute("altimg") ? "math[@altimg]" : "none"),
            altimgVal:     math.hasAttribute("altimg") ? math.getAttribute("altimg") : null,
            imgElemId,
            // ── Position anchors for bounded XML patching ─────────
            srcOffset,
            srcEnd,
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

    // ── FORMAT 1: JATS inline-formula / disp-formula ─────────────
    const allEls = [...document.getElementsByTagName("*")];

    const dispFormulas = allEls.filter(el =>
        el.tagName.toLowerCase() === "disp-formula" ||
        el.tagName.toLowerCase() === "ce:disp-formula"
    );
    const inlineFormulas = allEls.filter(el =>
        el.tagName.toLowerCase() === "inline-formula" ||
        el.tagName.toLowerCase() === "ce:inline-formula"
    );

    const _totalEqs = inlineFormulas.length + dispFormulas.length;
    let _doneEqs = 0;

    await processBatch(
        [...inlineFormulas].map((eq, i) => ({ eq, i })),
        async ({ eq, i }) => {
            await processFormula(
                eq, "Inline Equation", "JATS", `inline-${i+1}`,
                "inline-formula", ["inline-formula","ce:inline-formula"]
            );
        },
        CONFIG.WIRIS_BATCH_SIZE,
        (done) => {
            _doneEqs += Math.min(CONFIG.WIRIS_BATCH_SIZE, done);
            if (reqId !== undefined) emitProgress(reqId, 2,
                `Converting equations... (${Math.min(_doneEqs, _totalEqs)}/${_totalEqs})`,
                20 + Math.round(70 * _doneEqs / Math.max(_totalEqs, 1)));
        }
    );

    await processBatch(
        [...dispFormulas].map((eq, i) => ({ eq, i })),
        async ({ eq, i }) => {
            await processFormula(
                eq, "Display Equation", "JATS", `disp-${i+1}`,
                "disp-formula", ["disp-formula","ce:disp-formula"]
            );
        }
    );

    // ── FORMAT 2: Springer ────────────────────────────────────────
    const springerEls = [...document.querySelectorAll("InlineEquation, Equation")];
    let springerOccurrence = 0;

    await processBatch(
        springerEls.map((eq, i) => ({ eq, i })),
        async ({ eq, i }) => {
            const math =
                eq.querySelector("math") ||
                [...eq.getElementsByTagName("math")][0] ||
                [...eq.getElementsByTagName("mml:math")][0];
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
                texVal    = texNode.firstChild.nodeValue.trim();
                texStatus = "OK";
                texReason = "EquationSource[Format=TEX]";
            }

            if (!texVal && math) {
                const walkerRes = springerTeXWalker(math);
                if (walkerRes.status === "OK" && walkerRes.value) {
                    texVal    = walkerRes.value;
                    texStatus = "OK";
                    texReason = "springer-walker";
                }
            }

            if (!texVal && math) {
                const texRes = await generateTeX(math, _texCache);
                texVal    = texRes.value;
                texStatus = texRes.status;
                texReason = texRes.reason + " (WIRIS fallback)";
            }

            const altRes = generateAltText(math);
            const eqEls2 = [...eq.getElementsByTagName("*")];
            const imgEl  =
                eq.querySelector("inline-graphic")                                     ||
                eq.querySelector("graphic")                                             ||
                eqEls2.find(el => el.tagName.toLowerCase() === "ce:inline-graphic")   ||
                eqEls2.find(el => el.tagName.toLowerCase() === "ce:graphic")           ||
                eq.querySelector("img");

            // Track source offset
            const occ = springerOccurrence++;
            const tagN = eq.tagName === "InlineEquation" ? "InlineEquation" : "Equation";
            const { srcOffset, srcEnd } = findFormulaOffset(
                cleanXMLWithNS, tagN, label, occ, [tagN]
            );

            let imgElemId = null;
            if (imgEl) {
                imgElemId = imgEl.getAttribute("id") || imgEl.getAttribute("xlink:href") || imgEl.getAttribute("src") || null;
                if (texVal && texStatus === "OK")           imgEl.setAttribute("tex",     texVal);
                if (altRes.value && altRes.status === "OK") imgEl.setAttribute("alttext", altRes.value);
                xmlModified = true;
            } else if (math && math.hasAttribute("altimg")) {
                if (texVal && texStatus === "OK")           math.setAttribute("tex",     texVal);
                if (altRes.value && altRes.status === "OK") math.setAttribute("alttext", altRes.value);
                xmlModified = true;
            }

            const complexity = analyzeMathMLComplexity(math);

            equations.push({
                type:       eq.tagName === "InlineEquation" ? "Inline Equation" : "Display Equation",
                format:     "Springer", id: label,
                tex:        texVal,
                alt:        altRes.value,
                mathml:     math.outerHTML,
                hasImg:     !!(imgEl || math.hasAttribute("altimg")),
                writeTarget: imgEl ? "graphic" : (math.hasAttribute("altimg") ? "math[@altimg]" : "none"),
                altimgVal:  math.hasAttribute("altimg") ? math.getAttribute("altimg") : null,
                imgElemId,
                srcOffset, srcEnd,
                texStatus, texReason,
                altStatus: altRes.status,
                altReason: altRes.reason,
                complexity
            });
        }
    );

    // ── FORMAT 2b: Wiley WML3 ─────────────────────────────────────
    if (equations.length === 0) {
        const wileyEls = allEls.filter(el => {
            const t = el.tagName.toLowerCase();
            return t === "display-formula" || t === "display-equation" ||
                   t === "inline-equation" || t === "equation-group";
        });
        if (wileyEls.length > 0) {
            console.log(`  [INFO] Wiley WML3 format — ${wileyEls.length} equations`);
            let wOcc = 0;
            await processBatch(wileyEls.map((eq, i) => ({ eq, i })), async ({ eq, i }) => {
                const math = eq.querySelector("math") ||
                    [...eq.getElementsByTagName("math")][0] ||
                    [...eq.getElementsByTagName("mml:math")][0];
                if (!math) return;
                const texRes = await generateTeX(math, _texCache);
                const altRes = generateAltText(math);
                const type = eq.tagName.toLowerCase().includes("inline") ? "Inline Equation" : "Display Equation";
                const imgEl = eq.querySelector("imageobject") ||
                    eq.querySelector("primary-object") ||
                    eq.querySelector("graphic") ||
                    eq.querySelector("inline-graphic") ||
                    eq.querySelector("img");
                const texOK = texRes.value && texRes.status === "OK";
                const altOK = altRes.value && altRes.status === "OK";
                const occ = wOcc++;
                const { srcOffset, srcEnd } = findFormulaOffset(
                    cleanXMLWithNS, eq.tagName, eq.getAttribute("id"), occ, [eq.tagName]
                );
                let imgElemId = null;
                if (imgEl) {
                    imgElemId = imgEl.getAttribute("id") || imgEl.getAttribute("src") || null;
                    if (texOK) { imgEl.setAttribute("tex", texRes.value); xmlModified = true; }
                    if (altOK) { imgEl.setAttribute("alttext", altRes.value); }
                } else if (math.hasAttribute("altimg")) {
                    if (texOK) { math.setAttribute("tex", texRes.value); xmlModified = true; }
                    if (altOK) { math.setAttribute("alttext", altRes.value); }
                }
                equations.push({
                    type, format: "wiley", id: eq.getAttribute("id") || `eq-${i+1}`,
                    tex: texRes.value, alt: altRes.value, mathml: math.outerHTML,
                    hasImg: !!(imgEl || math.hasAttribute("altimg")),
                    writeTarget: imgEl ? "graphic" : (math.hasAttribute("altimg") ? "math[@altimg]" : "none"),
                    imgElemId, srcOffset, srcEnd,
                    texStatus: texRes.status, texReason: texRes.reason,
                    altStatus: altRes.status, altReason: altRes.reason,
                    complexity: analyzeMathMLComplexity(math),
                    engine: texRes.engine || "mathml-to-latex",
                    wirisAttempted: texRes.wirisAttempted || false
                });
            });
        }
    }

    // ── FORMAT 2c: ACS Books / BITS <alternatives> ───────────────
    if (equations.length === 0) {
        const altEls = allEls.filter(el => {
            const t = el.tagName.toLowerCase();
            return t === "alternatives" && (
                el.querySelector("math") ||
                [...el.getElementsByTagName("mml:math")].length > 0
            );
        });
        if (altEls.length > 0) {
            console.log(`  [INFO] ACS/BITS <alternatives> format — ${altEls.length} equations`);
            let aOcc = 0;
            await processBatch(altEls.map((eq, i) => ({ eq, i })), async ({ eq, i }) => {
                await processFormula(
                    eq, "Inline Equation", "acs-bits", `eq-${i+1}`,
                    "alternatives", ["alternatives"]
                );
            });
        }
    }

    // ── FORMAT 3: HTML span ───────────────────────────────────────
    const spanEls = [...document.querySelectorAll("span.inline[type='eqn'], span.display[type='eqn']")];
    let spanOcc = 0;

    await processBatch(spanEls.map((eq, i) => ({ eq, i })), async ({ eq, i }) => {
        const math =
            eq.querySelector("math") ||
            [...eq.getElementsByTagName("math")][0] ||
            [...eq.getElementsByTagName("mml:math")][0];
        if (!math) return;

        const texRes2 = await generateTeX(math, _texCache);
        const altRes2 = generateAltText(math);

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

        const occ = spanOcc++;
        const { srcOffset, srcEnd } = findFormulaOffset(
            cleanXMLWithNS, "span", eqId, occ, ["span"]
        );

        let imgElemId = null;

        function cleanWrite2(el, tv, av, tok, aok) {
            const ex = el.getAttribute("tex") || "";
            if (STALE.some(e => ex.toLowerCase().includes(e))) el.removeAttribute("tex");
            if (tv && tok) { el.setAttribute("tex", tv); } else { el.removeAttribute("tex"); }
            if (av && aok) { el.setAttribute("alttext", av); }
            xmlModified = true;
        }

        if (imgEl) {
            imgElemId = imgEl.getAttribute("id") || imgEl.getAttribute("src") || null;
            cleanWrite2(imgEl, texRes2.value, altRes2.value, texOK2, altOK2);
        } else if (math && math.hasAttribute("altimg")) {
            cleanWrite2(math, texRes2.value, altRes2.value, texOK2, altOK2);
        }

        equations.push({
            type:       eq.classList.contains("display") ? "Display Equation" : "Inline Equation",
            format:     "HTML",
            id:         eqId,
            tex:        texRes2.value,
            alt:        altRes2.value,
            mathml:     math.outerHTML,
            hasImg:     !!(imgEl || (math && math.hasAttribute("altimg"))),
            writeTarget: imgEl ? "graphic" : (math && math.hasAttribute("altimg") ? "math[@altimg]" : "none"),
            altimgVal:  math && math.hasAttribute("altimg") ? math.getAttribute("altimg") : null,
            imgElemId,
            srcOffset, srcEnd,
            texStatus: texRes2.status, texReason: texRes2.reason,
            altStatus: altRes2.status, altReason: altRes2.reason,
            complexity: analyzeMathMLComplexity(math),
            engine:    texRes2.engine   || "mathml-to-latex",
            wirisAttempted: texRes2.wirisAttempted || false,
            wirisResult:    texRes2.wirisResult    || ""
        });
    });

    // ── FORMAT 4: Bare math fallback ──────────────────────────────
    if (equations.length === 0) {
        const allMathEls = [
            ...document.getElementsByTagName("math"),
            ...document.getElementsByTagName("mml:math")
        ].filter((el, idx, arr) => arr.indexOf(el) === idx);

        const isWiley = allMathEls.length > 0 && allMathEls[0].hasAttribute("wiley:location");
        const bareResults = new Array(allMathEls.length);
        let bOcc = 0;

        await processBatch(allMathEls.map((m, i) => ({ m, i })), async ({ m: math, i }) => {
            const texRes3 = await generateTeX(math, _texCache);
            const altRes3 = generateAltText(math);
            const hasAltImg3 = math.hasAttribute("altimg");
            const occ = bOcc++;
            const altimgVal3 = hasAltImg3 ? math.getAttribute("altimg") : null;

            if (hasAltImg3 && texRes3.value && texRes3.status === "OK") {
                math.setAttribute("tex", texRes3.value);
                xmlModified = true;
            }
            if (hasAltImg3 && altRes3.value && altRes3.status === "OK") {
                math.setAttribute("alttext", altRes3.value);
                xmlModified = true;
            }

            bareResults[i] = {
                type:        math.getAttribute("display") === "block" ? "Display Equation" : "Inline Equation",
                format:      isWiley ? "wiley" : "bare",
                id:          math.getAttribute("id") || `eq-${i+1}`,
                tex:         texRes3.value,
                alt:         altRes3.value,
                mathml:      math.outerHTML,
                hasImg:      hasAltImg3,
                writeTarget: hasAltImg3 ? "math[@altimg]" : "none",
                altimgVal:   altimgVal3,
                imgElemId:   null,
                srcOffset:   undefined,
                srcEnd:      undefined,
                texStatus:   texRes3.status, texReason: texRes3.reason,
                altStatus:   altRes3.status, altReason: altRes3.reason,
                complexity:  analyzeMathMLComplexity(math)
            };
        });

        bareResults.forEach(r => { if (r) equations.push(r); });
    }

    // ── Build JSON output (replaces TXT) ──────────────────────────
    const jsonContent = buildJSONOutput(equations, filename, Date.now());

    // ── Build modified XML using position-anchored patcher ────────
    let xmlContent = null;
    if (xmlModified) {
        try {
            xmlContent = patchXMLString(cleanXMLWithNS, equations);
            console.log(`[OK] XML patched — ${xmlContent.length} chars`);
        } catch(e) {
            console.error(`[ERROR] patchXMLString failed: ${e.message} — falling back to DOM serializer`);
            try {
                const serializer = new dom.window.XMLSerializer();
                xmlContent = serializer.serializeToString(document);
                console.log(`[OK] DOM serializer fallback — ${xmlContent.length} chars`);
            } catch(e2) {
                console.error(`[ERROR] DOM serializer also failed: ${e2.message}`);
                xmlContent = null;
            }
        }
    }

    console.log(`[INFO] Processing complete — equations: ${equations.length}, xmlModified: ${xmlModified}`);

    const logContent = buildLog(equations, filename, Date.now());

    return {
        equations,
        jsonContent,
        xmlContent,
        xmlModified,
        logContent,
        // Return extracted DOCTYPE so callers can restore it
        extractedDoctype
    };
}

/* ================================================================
   API ROUTES
================================================================ */

app.get("/", (req, res) => {
    res.json({
        name:    "MathMLtoTeXandAltText API",
        version: "2.0.0",
        changes: "equations.json output (replaces equations.txt), DOCTYPE fully preserved, per-equation graphic matching fixed",
        endpoints: {
            "POST /process": "Upload XML, get JSON equations + modified XML",
            "GET /download/:filename": "Download output file",
            "GET /health": "Health check",
            "GET /ui": "Browser upload UI"
        }
    });
});

app.get("/ui", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MathMLtoTeXandAltText</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0b0d0f;--bg2:#111318;--bg3:#161a1f;--surface:#1c2128;--surface2:#222831;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.12);--border3:rgba(255,255,255,0.18);
  --text:#e8eaed;--muted:rgba(232,234,237,0.45);--muted2:rgba(232,234,237,0.25);
  --blue:#3b82f6;--blue-dim:rgba(59,130,246,0.12);--blue-bdr:rgba(59,130,246,0.3);
  --green:#22c55e;--green-dim:rgba(34,197,94,0.1);--green-bdr:rgba(34,197,94,0.25);
  --amber:#f59e0b;--red:#ef4444;--red-dim:rgba(239,68,68,0.1);--red-bdr:rgba(239,68,68,0.25);
  --radius:10px;--radius-sm:7px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Geist',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(ellipse 80% 50% at 50% 0%,rgba(59,130,246,0.07) 0%,transparent 60%),
  radial-gradient(ellipse 60% 40% at 100% 100%,rgba(139,92,246,0.06) 0%,transparent 55%)}
nav{height:52px;background:var(--bg2);border-bottom:1px solid var(--border2);display:flex;align-items:center;
  padding:0 20px;gap:10px;position:sticky;top:0;z-index:10}
.logo{width:30px;height:30px;background:var(--blue);border-radius:7px;display:flex;align-items:center;
  justify-content:center;color:#fff;font-weight:700;font-size:14px;flex-shrink:0}
.nav-title{font-size:13px;font-weight:600;color:var(--text)}
.nav-badge{font-size:10px;padding:2px 7px;background:var(--surface);border:1px solid var(--border2);
  border-radius:5px;color:var(--muted);font-family:'Geist Mono',monospace}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.gh-btn{display:flex;align-items:center;gap:5px;padding:5px 10px;background:var(--surface);
  border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-size:11px;
  text-decoration:none;font-family:inherit;cursor:pointer;transition:all 0.15s}
.gh-btn:hover{border-color:var(--border3);color:var(--text);background:var(--surface2)}
.wrap{max-width:1060px;margin:0 auto;padding:20px 16px;position:relative;z-index:1}
.grid{display:grid;grid-template-columns:1fr 272px;gap:14px;align-items:start}
.card{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius);overflow:hidden}
.card+.card{margin-top:12px}
.card-head{padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.card-title{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em}
.card-meta{font-size:11px;color:var(--muted2)}
.card-body{padding:16px}
.dropzone{border:1.5px dashed var(--border2);border-radius:var(--radius-sm);padding:32px 20px;text-align:center;
  cursor:pointer;background:var(--bg3);transition:all 0.2s;position:relative}
.dropzone:hover,.dropzone.dragover{border-color:var(--blue);background:rgba(59,130,246,0.04)}
.dz-icon{width:44px;height:44px;background:var(--surface);border:1px solid var(--border2);
  border-radius:10px;margin:0 auto 13px;display:flex;align-items:center;justify-content:center}
.dz-title{font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px}
.dz-sub{font-size:12px;color:var(--muted)}
.dz-sub span{color:var(--blue);cursor:pointer}
.format-pills{display:flex;gap:5px;justify-content:center;flex-wrap:wrap;margin-top:13px}
.fpill{font-size:10px;padding:3px 9px;border-radius:5px;background:var(--surface);color:var(--muted);
  border:1px solid var(--border2);font-weight:500}
.file-box{display:flex;align-items:center;gap:11px;padding:12px 13px;background:var(--bg3);
  border-radius:var(--radius-sm);border:1px solid var(--border2)}
.file-icon{width:36px;height:36px;border-radius:8px;background:var(--surface);border:1px solid var(--border2);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.file-name{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-size{font-size:11px;color:var(--muted);font-family:'Geist Mono',monospace;margin-top:1px}
.remove-btn{margin-left:auto;width:26px;height:26px;border-radius:6px;background:transparent;
  border:1px solid var(--border);color:var(--muted2);cursor:pointer;display:flex;align-items:center;
  justify-content:center;font-size:15px;transition:all 0.15s;flex-shrink:0}
.remove-btn:hover{background:var(--red-dim);border-color:var(--red-bdr);color:var(--red)}
.process-btn{width:100%;margin-top:11px;padding:10px;border-radius:var(--radius-sm);border:none;
  background:var(--blue);color:#fff;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;
  transition:all 0.15s;display:flex;align-items:center;justify-content:center;gap:7px}
.process-btn:hover{background:#2563eb;box-shadow:0 0 0 3px rgba(59,130,246,0.2)}
.process-btn:disabled{opacity:0.35;cursor:not-allowed;box-shadow:none}
.prog-steps{display:flex;gap:4px;margin-bottom:14px}
.step{flex:1;height:2px;border-radius:99px;background:var(--surface2);transition:background 0.4s}
.step.done{background:var(--blue)}
.step.active{background:var(--blue);animation:stepfade 1s ease-in-out infinite}
@keyframes stepfade{0%,100%{opacity:1}50%{opacity:0.35}}
.wave-wrap{display:flex;align-items:flex-end;gap:3px;height:36px;padding:0 2px;margin:10px 0}
.wbar{flex:1;background:var(--surface2);border-radius:2px;animation:wbounce 1.2s ease-in-out infinite}
.wbar:nth-child(1){animation-delay:0s}.wbar:nth-child(2){animation-delay:0.1s}
.wbar:nth-child(3){animation-delay:0.2s}.wbar:nth-child(4){animation-delay:0.3s}
.wbar:nth-child(5){animation-delay:0.15s}.wbar:nth-child(6){animation-delay:0.25s}
.wbar:nth-child(7){animation-delay:0.05s}.wbar:nth-child(8){animation-delay:0.35s}
.wbar:nth-child(9){animation-delay:0.12s}.wbar:nth-child(10){animation-delay:0.22s}
.wbar:nth-child(11){animation-delay:0.08s}.wbar:nth-child(12){animation-delay:0.18s}
@keyframes wbounce{0%,100%{height:20%;background:var(--surface2)}50%{height:90%;background:var(--blue)}}
.prog-pct{font-size:24px;font-weight:700;color:var(--text);text-align:center;font-family:'Geist Mono',monospace}
.prog-label{font-size:11px;color:var(--muted);text-align:center;margin-top:3px}
.error-box{display:none;padding:10px 13px;background:var(--red-dim);border:1px solid var(--red-bdr);
  border-radius:var(--radius-sm);font-size:12px;color:var(--red);margin-top:11px}
.status-pill{font-size:11px;padding:3px 10px;border-radius:5px;font-weight:600}
.status-ok{background:var(--green-dim);border:1px solid var(--green-bdr);color:var(--green)}
.status-warn{background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:var(--amber)}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:13px}
.stat-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:11px;text-align:center}
.stat-num{font-size:22px;font-weight:700;font-family:'Geist Mono',monospace;color:var(--text)}
.stat-num.ok{color:var(--green)}.stat-num.warn{color:var(--amber)}.stat-num.fail{color:var(--red)}
.stat-lbl{font-size:9px;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:0.06em;font-weight:500}
.dl-cards{display:flex;flex-direction:column;gap:7px}
.dl-card{display:flex;align-items:center;gap:12px;padding:11px 13px;background:var(--bg3);
  border:1px solid var(--border2);border-radius:var(--radius-sm);text-decoration:none;
  transition:all 0.15s;cursor:pointer}
.dl-card:hover{background:var(--surface);border-color:var(--border3);transform:translateX(2px)}
.dl-icon{width:32px;height:32px;border-radius:7px;display:flex;align-items:center;justify-content:center;
  font-size:10px;font-weight:700;flex-shrink:0;font-family:'Geist Mono',monospace}
.dl-icon.json{background:var(--green-dim);color:var(--green);border:1px solid var(--green-bdr)}
.dl-icon.xml{background:var(--blue-dim);color:var(--blue);border:1px solid var(--blue-bdr)}
.dl-icon.log{background:rgba(245,158,11,0.1);color:var(--amber);border:1px solid rgba(245,158,11,0.25)}
.dl-name{font-size:13px;font-weight:600;color:var(--text)}
.dl-desc{font-size:11px;color:var(--muted);margin-top:1px}
.dl-arrow{margin-left:auto;color:var(--muted2);font-size:13px;transition:all 0.15s}
.dl-card:hover .dl-arrow{color:var(--blue)}
.reset-btn{width:100%;margin-top:10px;padding:9px;background:transparent;border:1px solid var(--border2);
  border-radius:var(--radius-sm);color:var(--muted);font-size:12px;font-family:inherit;cursor:pointer;transition:all 0.15s}
.reset-btn:hover{border-color:var(--border3);color:var(--text);background:var(--surface)}
.engine-row{display:flex;align-items:center;gap:9px;padding:9px 11px;background:var(--bg3);
  border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:5px}
.edot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.edot.live{background:var(--green);box-shadow:0 0 0 3px rgba(34,197,94,0.15)}
.edot.fallback{background:var(--amber)}
.engine-name{font-size:12px;color:var(--text);font-weight:500}
.engine-sub{font-size:10px;color:var(--muted);margin-top:1px}
.section-lbl{font-size:10px;font-weight:600;color:var(--muted2);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px}
.info-row{display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-bottom:1px solid var(--border)}
.info-row:last-child{border:none}
.info-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;margin-top:4px}
.info-text{font-size:12px;color:var(--text);font-weight:500}
.info-sub{font-size:11px;color:var(--muted);margin-top:1px}
.built-by{text-align:center;font-size:11px;color:var(--muted2);padding:10px 0 2px}
.built-by a{color:var(--blue);text-decoration:none}
@media(max-width:680px){.grid{grid-template-columns:1fr}.sidebar{order:-1}.stats-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<nav>
  <div class="logo">M</div>
  <span class="nav-title">MathMLtoTeXandAltText</span>
  <span class="nav-badge">v2.0</span>
  <div class="nav-right">
    <a class="gh-btn" href="https://github.com/Ambethmani/MathMLtoTeXandAltText" target="_blank">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
      GitHub
    </a>
  </div>
</nav>

<div class="wrap">
<div class="grid">
<div>
  <div class="card">
    <div class="card-head">
      <span class="card-title">Upload XML File</span>
      <span class="card-meta">.xml only &middot; max 20MB</span>
    </div>
    <div class="card-body">
      <div id="dropZone" class="dropzone">
        <div class="dz-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(232,234,237,0.5)" stroke-width="1.8"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <div class="dz-title">Drop your XML file here</div>
        <div class="dz-sub">or <span>click to browse</span></div>
        <div class="format-pills">
          <span class="fpill">ACS</span><span class="fpill">Elsevier</span>
          <span class="fpill">Springer</span><span class="fpill">Wiley</span>
          <span class="fpill">TandF</span><span class="fpill">IOPP</span>
          <span class="fpill">LWW</span><span class="fpill">Thieme</span>
        </div>
        <input type="file" id="fileInput" accept=".xml" style="display:none">
      </div>

      <div id="fileInfo" style="display:none">
        <div class="file-box">
          <div class="file-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div style="min-width:0;flex:1">
            <div class="file-name" id="fileName">—</div>
            <div class="file-size" id="fileSize">—</div>
          </div>
          <button class="remove-btn" onclick="removeFile()">&#215;</button>
        </div>
        <button class="process-btn" id="processBtn" disabled onclick="processFile()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Process Equations
        </button>
      </div>

      <div id="progressArea" style="display:none">
        <div class="prog-steps">
          <div class="step" id="step1"></div><div class="step" id="step2"></div>
          <div class="step" id="step3"></div><div class="step" id="step4"></div>
          <div class="step" id="step5"></div>
        </div>
        <div class="wave-wrap">
          <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
          <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
          <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
          <div class="wbar"></div><div class="wbar"></div><div class="wbar"></div>
        </div>
        <div class="prog-pct" id="progressPct">0%</div>
        <div class="prog-label" id="progressLabel">Connecting...</div>
      </div>

      <div id="errorBox" class="error-box"></div>
    </div>
  </div>

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

<div class="sidebar">
  <div class="card">
    <div class="card-head"><span class="card-title">TeX Engine</span></div>
    <div class="card-body">
      <div class="engine-row">
        <div class="edot live"></div>
        <div><div class="engine-name">WIRIS / MathType API</div><div class="engine-sub">Primary · highest accuracy</div></div>
      </div>
      <div class="engine-row" style="opacity:0.55">
        <div class="edot fallback"></div>
        <div><div class="engine-name">mathml-to-latex</div><div class="engine-sub">Fallback · offline</div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-body">
      <div style="margin-bottom:16px">
        <div class="section-lbl">Output Files</div>
        <div class="info-row">
          <div class="info-dot" style="background:var(--green)"></div>
          <div><div class="info-text">equations.json</div><div class="info-sub">Structured JSON: TeX + AltText + MathML + metadata per equation</div></div>
        </div>
        <div class="info-row">
          <div class="info-dot" style="background:var(--blue)"></div>
          <div><div class="info-text">modified.xml</div><div class="info-sub">XML with DOCTYPE preserved + tex/alttext on each matching graphic tag</div></div>
        </div>
        <div class="info-row">
          <div class="info-dot" style="background:var(--amber)"></div>
          <div><div class="info-text">log.txt</div><div class="info-sub">Complexity analysis & conversion details</div></div>
        </div>
      </div>
      <div>
        <div class="section-lbl">Publishers</div>
        <div class="info-row">
          <div class="info-dot" style="background:var(--blue)"></div>
          <div><div class="info-text">JATS / NLM</div><div class="info-sub">ACS, IOPP, LWW, CSIRO, Thieme</div></div>
        </div>
        <div class="info-row">
          <div class="info-dot" style="background:#f97316"></div>
          <div><div class="info-text">Elsevier / MRW</div><div class="info-sub">ce: namespace, altimg</div></div>
        </div>
        <div class="info-row">
          <div class="info-dot" style="background:#a78bfa"></div>
          <div><div class="info-text">Springer / Books</div><div class="info-sub">InlineEquation, Equation</div></div>
        </div>
        <div class="info-row">
          <div class="info-dot" style="background:var(--amber)"></div>
          <div><div class="info-text">Wiley</div><div class="info-sub">bare math[@altimg]</div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="built-by">
    Built by <strong style="color:var(--muted)">Ambeth</strong> &nbsp;·&nbsp;
    <a href="https://github.com/Ambethmani/MathMLtoTeXandAltText" target="_blank">GitHub</a>
  </div>
</div>
</div>
</div>

<script>
  var selectedFile = null;
  document.addEventListener('dragover', function(e){ e.preventDefault(); });
  document.addEventListener('drop', function(e){ e.preventDefault(); });

  var dz = document.getElementById('dropZone');
  dz.addEventListener('dragover', function(e){ e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function(){ dz.classList.remove('dragover'); });
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
    var sizeKB = f.size / 1024;
    document.getElementById('fileName').textContent = f.name;
    document.getElementById('fileSize').textContent = sizeKB.toFixed(1) + ' KB';
    document.getElementById('fileInfo').style.display = 'block';
    document.getElementById('dropZone').style.display = 'none';
    document.getElementById('processBtn').disabled = false;
    document.getElementById('errorBox').style.display = 'none';
    document.getElementById('results').style.display = 'none';
  }

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

  var progTimer = null, progPct = 0, progStep = 0;
  var stepIds     = ['step1','step2','step3','step4','step5'];
  var stepLabels  = ['Connecting...','Parsing XML...','Converting via WIRIS...','Generating AltText...','Writing outputs...'];
  var stepTargets = [10, 28, 72, 88, 96];

  function startProgress() {
    progPct = 0; progStep = 0;
    document.getElementById('progressArea').style.display = 'block';
    document.getElementById('fileInfo').style.display = 'none';
    stepIds.forEach(function(s){ document.getElementById(s).className = 'step'; });
    document.getElementById('progressPct').textContent = '0%';
    document.getElementById('progressLabel').textContent = 'Connecting...';
    progTimer = setInterval(function(){
      if (progStep < stepIds.length) {
        document.getElementById(stepIds[progStep]).className = 'step active';
        document.getElementById('progressLabel').textContent = stepLabels[progStep];
        if (progPct < stepTargets[progStep]) {
          progPct = Math.min(progPct + (progStep === 2 ? 0.35 : 1.8), stepTargets[progStep]);
          document.getElementById('progressPct').textContent = Math.round(progPct) + '%';
        } else { progStep++; }
      }
    }, 120);
  }

  function stopProgress(success) {
    if (progTimer) clearInterval(progTimer);
    if (window._sseSource) { window._sseSource.close(); window._sseSource = null; }
    stepIds.forEach(function(s){ document.getElementById(s).className = 'step done'; });
    document.getElementById('progressPct').textContent = '100%';
    document.getElementById('progressLabel').textContent = success ? 'Complete!' : 'Failed';
    setTimeout(function(){ document.getElementById('progressArea').style.display = 'none'; }, 900);
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
    sendFile();
  }

  function sc(num, label, cls) {
    return '<div class="stat-card"><div class="stat-num ' + cls + '">' + num + '</div><div class="stat-lbl">' + label + '</div></div>';
  }

  function dlCard(content, filename, iconClass, icon, name, desc) {
    var mime = filename.endsWith('.json') ? 'application/json' : filename.endsWith('.xml') ? 'application/xml' : 'text/plain';
    var blob = new Blob([content], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    return '<a class="dl-card" href="' + url + '" download="' + filename + '">' +
      '<div class="dl-icon ' + iconClass + '">' + icon + '</div>' +
      '<div><div class="dl-name">' + name + '</div><div class="dl-desc">' + desc + '</div></div>' +
      '<div class="dl-arrow">&#8595;</div></a>';
  }

  function sendFile() {
    var reader = new FileReader();
    reader.onload = function(e) {
      var xmlText = e.target.result;

      // Preserve DOCTYPE before stripping
      var savedDoctype = '';
      var doctypeMatch = xmlText.match(/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\])?\s*>/i);
      if (doctypeMatch) savedDoctype = doctypeMatch[0];
      window._pendingDoctype = savedDoctype;

      // Strip for WAF
      var cleanXml = xmlText.replace(/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\])?\s*>/gi, '');
      cleanXml = cleanXml.replace(/<!ENTITY[^>]*>/gi, '');

      var cleanBlob = new Blob([cleanXml], { type: 'application/xml' });
      var cleanFile = new File([cleanBlob], selectedFile.name, { type: 'application/xml' });
      var formData = new FormData();
      formData.append('file', cleanFile);

      fetch('/process', { method: 'POST', body: formData })
      .then(function(resp) {
        var reqId = resp.headers.get('X-Request-Id');
        if (reqId && typeof EventSource !== 'undefined') {
          if (window._sseSource) window._sseSource.close();
          window._sseSource = new EventSource('/progress/' + reqId);
          window._sseSource.onmessage = function(ev) {
            try {
              var msg = JSON.parse(ev.data);
              document.getElementById('progressLabel').textContent = msg.label;
              if (msg.pct !== undefined) document.getElementById('progressPct').textContent = Math.round(msg.pct) + '%';
            } catch(_) {}
          };
          window._sseSource.onerror = function() {
            if (window._sseSource) { window._sseSource.close(); window._sseSource = null; }
          };
        }
        var status = resp.status;
        return resp.text().then(function(t){ return { status: status, text: t }; });
      })
      .then(function(obj) {
        var data;
        try { data = JSON.parse(obj.text); } catch(e) {
          stopProgress(false);
          showError('[HTTP ' + obj.status + '] ' + obj.text.replace(/<[^>]+>/g,'').substring(0,200));
          return;
        }

        stopProgress(data.success);
        if (!data.success) { showError(data.error || 'Processing failed'); return; }

        var stats = data.conversionStats || {};
        var tex = stats.tex || {}, alt = stats.altText || {};
        var allOK = (tex.errors||0) === 0 && (alt.errors||0) === 0;

        document.getElementById('statusPill').innerHTML =
          '<span class="status-pill ' + (allOK ? 'status-ok' : 'status-warn') + '">' +
          (allOK ? '&#10003; All converted' : '&#9888; Issues found') + '</span>';

        document.getElementById('statsGrid').innerHTML =
          sc(stats.total||0, 'Total equations', '') +
          sc(stats.withImgTag||0, 'IMG tags updated', 'ok') +
          sc(tex.success||0, 'TeX success', 'ok') +
          sc((tex.errors||0)+(tex.warnings||0), 'TeX issues', (tex.errors||0)>0?'fail':'warn') +
          sc(alt.success||0, 'AltText success', 'ok') +
          sc((alt.errors||0)+(alt.warnings||0), 'AltText issues', (alt.errors||0)>0?'fail':'warn');

        var ct = data.content || {};
        var cards = '';

        if (ct.json) {
          cards += dlCard(ct.json, ct.jsonName||'equations.json', 'json', 'JSON',
            'equations.json', 'Structured JSON: TeX + AltText + MathML + metadata');
        }
        if (ct.xml) {
          // Restore DOCTYPE before download
          var xmlOut = ct.xml;
          if (window._pendingDoctype) {
            if (xmlOut.startsWith('<?xml')) {
              var declEnd = xmlOut.indexOf('?>') + 2;
              xmlOut = xmlOut.slice(0, declEnd) + '\n' + window._pendingDoctype + xmlOut.slice(declEnd);
            } else {
              xmlOut = '<?xml version="1.0" encoding="utf-8"?>\n' + window._pendingDoctype + '\n' + xmlOut;
            }
          }
          cards += dlCard(xmlOut, ct.xmlName||'modified.xml', 'xml', 'XML',
            'modified.xml', 'XML with DOCTYPE + per-equation tex/alttext on graphic tags');
        }
        if (ct.log) {
          cards += dlCard(ct.log, ct.logName||'log.txt', 'log', 'LOG',
            'log.txt', 'Processing log with complexity analysis');
        }

        document.getElementById('dlCards').innerHTML = cards || '<p style="color:var(--muted);font-size:13px">No output files generated.</p>';
        document.getElementById('results').style.display = 'block';
        document.getElementById('processBtn').disabled = false;
      })
      .catch(function(e) {
        stopProgress(false);
        showError('Network error: ' + e.message);
        document.getElementById('processBtn').disabled = false;
      });
    };
    reader.onerror = function() {
      stopProgress(false);
      showError('Failed to read file');
      document.getElementById('processBtn').disabled = false;
    };
    reader.readAsText(selectedFile);
  }
</script>
</body>
</html>`);
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/progress/:reqId", (req, res) => {
    const reqId = req.params.reqId;
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const emitter = new EventEmitter();
    progressEmitters.set(reqId, emitter);

    const send = (data) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    emitter.on("progress", send);
    req.on("close", () => {
        emitter.removeAllListeners();
        progressEmitters.delete(reqId);
    });
    setTimeout(() => {
        emitter.removeAllListeners();
        progressEmitters.delete(reqId);
        if (!res.writableEnded) res.end();
    }, 180000);
});

/* ================================================================
   POST /process — main endpoint
================================================================ */
app.post("/process", upload.fields([{name:"file",maxCount:1}]), async (req, res) => {
  try {
    const uploadedFile = req.files && req.files["file"] && req.files["file"][0];
    if (!uploadedFile) {
        return res.status(400).json({ success: false, error: "No file uploaded." });
    }

    const origName  = uploadedFile.originalname;
    const baseName  = path.basename(origName, ".xml");
    const timestamp = Date.now();

    let rawXML;
    try {
        rawXML = fs.readFileSync(uploadedFile.path, "utf8");
    } catch (e) {
        return res.status(500).json({ success: false, error: "Cannot read file: " + e.message });
    }
    if (!rawXML || !rawXML.trim()) {
        return res.status(400).json({ success: false, error: "File is empty." });
    }

    const fileSizeKB = Math.round(rawXML.length / 1024);
    console.log(`[INFO] Received: ${origName} (${fileSizeKB} KB)`);

    const reqId = Date.now() + "_" + Math.random().toString(36).slice(2,8);
    const _reqEmitter = new EventEmitter();
    progressEmitters.set(reqId, _reqEmitter);
    res.setHeader("X-Request-Id", reqId);
    res.setHeader("X-Accel-Buffering", "no");

    let requestTimedOut = false;
    const reqTimeout = setTimeout(() => {
        requestTimedOut = true;
        console.error(`[TIMEOUT] Request exceeded 110s`);
        if (!res.headersSent) {
            res.status(503).json({ success: false, error: "Processing timeout — file may be too large." });
        }
    }, 110000);

    emitProgress(reqId, 1, "Parsing XML structure...", 10);

    let result;
    try {
        // processXML now handles DOCTYPE extraction internally
        result = await processXML(rawXML, origName, reqId);
    } catch (e) {
        clearTimeout(reqTimeout);
        console.error("[ERROR] processXML failed:", e.message);
        if (res.headersSent) return;
        return res.status(500).json({
            success: false,
            error: `Processing failed: ${e.message}`
        });
    }

    const eqCount = result.equations ? result.equations.length : 0;
    emitProgress(reqId, 3, `${eqCount} equations converted — building output...`, 90);

    // ── Restore DOCTYPE in output XML ────────────────────────────
    // Priority 1: DOCTYPE extracted by processXML from rawXML (most reliable)
    // Priority 2: DOCTYPE sent as form field from browser (WAF-safe path)
    let doctypeToRestore = result.extractedDoctype || null;

    if (!doctypeToRestore && req.body && req.body.doctype && req.body.doctype.trim()) {
        try {
            doctypeToRestore = Buffer.from(req.body.doctype.trim(), "base64").toString("utf8");
        } catch(e) {
            doctypeToRestore = req.body.doctype.trim();
        }
    }

    if (doctypeToRestore && result.xmlContent) {
        result.xmlContent = restoreDOCTYPE(result.xmlContent, doctypeToRestore);
        console.log(`[INFO] DOCTYPE restored in output XML (${doctypeToRestore.length} chars)`);
    } else if (doctypeToRestore && !result.xmlContent) {
        console.log(`[INFO] DOCTYPE preserved — no XML output (no img tags found)`);
    }

    if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

    emitProgress(reqId, 4, "Writing output files...", 97);

    // ── Save output files ─────────────────────────────────────────
    // equations.json (replaces equations.txt)
    const jsonFilename = `${baseName}_${timestamp}_equations.json`;
    const logFilename  = `${baseName}_${timestamp}_log.txt`;
    let   xmlFilename  = null;

    const writePromises = [
        fs.promises.writeFile(path.join(OUTPUT, jsonFilename), result.jsonContent, "utf8")
            .then(() => console.log(`[OK] JSON saved`))
            .catch(e => { throw new Error(`Cannot save JSON: ${e.message}`); }),
        fs.promises.writeFile(path.join(OUTPUT, logFilename), result.logContent, "utf8")
            .then(() => console.log(`[OK] LOG saved`))
            .catch(e => console.error(`[WARN] Cannot save LOG: ${e.message}`))
    ];

    if (result.xmlContent) {
        xmlFilename = `${baseName}_${timestamp}_modified.xml`;
        writePromises.push(
            fs.promises.writeFile(path.join(OUTPUT, xmlFilename), result.xmlContent, "utf8")
                .then(() => console.log(`[OK] XML saved`))
                .catch(e => { xmlFilename = null; console.error(`[WARN] Cannot save XML: ${e.message}`); })
        );
    }

    try {
        await Promise.all(writePromises);
        emitProgress(reqId, 5, "Complete! Sending results...", 99);
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }

    clearTimeout(reqTimeout);
    setTimeout(() => { progressEmitters.delete(reqId); }, 5000);

    try { if (uploadedFile && uploadedFile.path) fs.unlinkSync(uploadedFile.path); } catch (_) {}

    const baseURL = `${req.protocol}://${req.get("host")}`;

    const response = {
        success:        true,
        filename:       origName,
        totalEquations: result.equations.length,
        xmlModified:    result.xmlModified,
        message: result.equations.length === 0
            ? "No equations found in this XML file."
            : result.xmlModified
                ? "TeX and AltText added to img tags. JSON, XML and LOG returned."
                : "No img/graphic tags found. JSON and LOG returned.",
        downloads: {
            json: `${baseURL}/download/${jsonFilename}`,
            log:  `${baseURL}/download/${logFilename}`
        },
        content: {
            json:     result.jsonContent,
            log:      result.logContent,
            xml:      result.xmlContent || null,
            jsonName: jsonFilename,
            logName:  logFilename,
            xmlName:  xmlFilename || null
        },
        conversionStats: {
            total:         result.equations.length,
            withImgTag:    result.equations.filter(e => e.hasImg).length,
            withoutImgTag: result.equations.filter(e => !e.hasImg).length,
            tex: {
                success:  result.equations.filter(e => e.texStatus === "OK").length,
                warnings: result.equations.filter(e => e.texStatus === "WARN").length,
                errors:   result.equations.filter(e => e.texStatus === "ERROR").length
            },
            altText: {
                success:  result.equations.filter(e => e.altStatus === "OK").length,
                warnings: result.equations.filter(e => e.altStatus === "WARN").length,
                errors:   result.equations.filter(e => e.altStatus === "ERROR").length
            }
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

    res.json(response);

  } catch (topLevelErr) {
    console.error("[ERROR] Unhandled error in /process route:", topLevelErr.message);
    if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json");
        res.status(500).json({
            success: false,
            error:   "Internal server error: " + (topLevelErr.message || "unknown")
        });
    }
  }
});

app.get("/download/:filename", (req, res) => {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(OUTPUT, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found or expired" });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === ".xml"  ? "application/xml"
                      : ext === ".json" ? "application/json"
                      :                   "text/plain";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.sendFile(path.resolve(filePath));
});

app.use((err, req, res, next) => {
    res.setHeader("Content-Type", "application/json");
    if (err.message && err.message.includes("Only .xml")) {
        return res.status(400).json({ success: false, error: "Only .xml files are accepted" });
    }
    if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ success: false, error: "File too large. Maximum size is 20MB." });
    }
    console.error("[ERROR] Unhandled:", err.message);
    res.status(500).json({ success: false, error: err.message || "Internal server error" });
});

/* ================================================================
   START SERVER
================================================================ */

function startServer(port, retriesLeft) {
    if (retriesLeft === undefined) retriesLeft = 10;

    const server = require("http").createServer(app);

    server.on("error", function(err) {
        if (err.code === "EADDRINUSE") {
            if (retriesLeft > 0) {
                console.log("  [WARN] Port " + port + " in use — trying " + (port + 1) + "...");
                server.close();
                startServer(port + 1, retriesLeft - 1);
            } else {
                console.error("[ERROR] No free port found after 10 attempts.");
                process.exit(1);
            }
        } else {
            console.error("[ERROR]", err.message);
            process.exit(1);
        }
    });

    server.listen(port, function() {
        const actualPort = server.address().port;
        console.log("\n" + "=".repeat(60));
        console.log("  MathMLtoTeXandAltText API  v2.0.0");
        console.log("  Developed by : Ambeth");
        console.log("=".repeat(60));
        console.log("  Running  : http://localhost:" + actualPort);
        console.log("  Browser  : http://localhost:" + actualPort + "/ui");
        console.log("=".repeat(60));
        console.log("  Changes in v2.0.0:");
        console.log("  - Output: equations.json (replaces equations.txt)");
        console.log("  - DOCTYPE: fully preserved with all ENTITY declarations");
        console.log("  - Graphic matching: per-equation position-anchored (no more mis-patching)");
        console.log("=".repeat(60) + "\n");
    });
}

startServer(PORT);

/* ================================================================
   FOLDER WATCHER
================================================================ */

const PROCESSED_DIR = path.join(UPLOAD, "processed");
if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR, { recursive: true });

const processingFiles = new Set();

function watchUploadsFolder() {
    console.log("  [WATCHER] Watching uploads folder: " + UPLOAD);

    fs.watch(UPLOAD, { persistent: true }, (eventType, filename) => {
        if (!filename || !filename.toLowerCase().endsWith(".xml")) return;
        const filePath = path.join(UPLOAD, filename);
        setTimeout(() => { processWatchedFile(filePath, filename); }, 500);
    });

    setInterval(() => {
        try {
            const files = fs.readdirSync(UPLOAD).filter(f =>
                f.toLowerCase().endsWith(".xml") && !processingFiles.has(f)
            );
            files.forEach(filename => {
                processWatchedFile(path.join(UPLOAD, filename), filename);
            });
        } catch (_) {}
    }, 3000);
}

async function processWatchedFile(filePath, filename) {
    if (processingFiles.has(filename)) return;
    if (!fs.existsSync(filePath)) return;

    processingFiles.add(filename);
    console.log("\n  [WATCHER] Processing: " + filename);

    let rawXML;
    try {
        rawXML = fs.readFileSync(filePath, "utf8");
    } catch (e) {
        console.error("  [WATCHER] ERROR reading file: " + e.message);
        processingFiles.delete(filename);
        return;
    }

    let result;
    try {
        result = await processXML(rawXML, filename);
    } catch (e) {
        console.error("  [WATCHER] ERROR processing: " + e.message);
        processingFiles.delete(filename);
        return;
    }

    // Restore DOCTYPE in output XML
    if (result.extractedDoctype && result.xmlContent) {
        result.xmlContent = restoreDOCTYPE(result.xmlContent, result.extractedDoctype);
        console.log("  [WATCHER] DOCTYPE restored in output XML");
    }

    const baseName  = path.basename(filename, ".xml");
    const timestamp = Date.now();

    if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

    // Save JSON (replaces TXT)
    const jsonPath = path.resolve(path.join(OUTPUT, baseName + "_" + timestamp + "_equations.json"));
    try {
        fs.writeFileSync(jsonPath, result.jsonContent, "utf8");
        console.log("  [WATCHER] JSON saved: " + jsonPath);
    } catch (e) {
        console.error("  [WATCHER] ERROR saving JSON: " + e.message);
    }

    // Save XML
    if (result.xmlContent) {
        const xmlPath = path.resolve(path.join(OUTPUT, baseName + "_" + timestamp + "_modified.xml"));
        try {
            fs.writeFileSync(xmlPath, result.xmlContent, "utf8");
            console.log("  [WATCHER] XML saved: " + xmlPath);
        } catch (e) {
            console.error("  [WATCHER] ERROR saving XML: " + e.message);
        }
    }

    // Save LOG
    const logPath = path.resolve(path.join(OUTPUT, baseName + "_" + timestamp + "_log.txt"));
    try {
        fs.writeFileSync(logPath, result.logContent, "utf8");
        console.log("  [WATCHER] LOG saved: " + logPath);
    } catch (e) {
        console.error("  [WATCHER] ERROR saving LOG: " + e.message);
    }

    // Move processed file
    const processedPath = path.join(PROCESSED_DIR, filename);
    try {
        const destPath = fs.existsSync(processedPath)
            ? path.join(PROCESSED_DIR, baseName + "_" + timestamp + ".xml")
            : processedPath;
        fs.renameSync(filePath, destPath);
        console.log("  [WATCHER] Moved to: " + destPath);
    } catch (e) {
        try {
            fs.copyFileSync(filePath, processedPath);
            fs.unlinkSync(filePath);
        } catch (e2) {
            console.error("  [WATCHER] Could not move file: " + e2.message);
        }
    }

    const eq = result.equations;
    console.log(`  [WATCHER] Done! Equations: ${eq.length}  TeX OK: ${eq.filter(e=>e.texStatus==="OK").length}`);
    processingFiles.delete(filename);
}

setTimeout(watchUploadsFolder, 1000);
