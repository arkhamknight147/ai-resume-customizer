// ─────────────────────────────────────────────────────────────────────────────
// AI Resume Customizer — Local App (Full)
// server.js  |  All stages: health, upload, analyse-jd, role-fit, tailor, export
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express   = require('express');
const path      = require('path');
const multer    = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse  = require('pdf-parse/lib/pdf-parse.js');
const mammoth   = require('mammoth');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, ExternalHyperlink,
} = require('docx');

const app  = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Input limits (prevents runaway token costs + gives friendly errors) ───────
const MAX_RESUME_CHARS = 25_000;   // ~5,000–6,000 words — plenty for any resume
const MAX_JD_CHARS     = 15_000;   // ~3,000–3,500 words — plenty for any JD

// ── Health-check cache (one real API call per 5 min; stops token burn on refresh)
let _healthCache   = null;
let _healthCacheAt = 0;
const HEALTH_TTL_MS = 5 * 60 * 1000;

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = file.mimetype === 'application/pdf'
            || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            || file.originalname.endsWith('.pdf')
            || file.originalname.endsWith('.docx');
    cb(ok ? null : new Error('Only PDF and DOCX files are supported.'), ok);
  },
});

// ── Basic Auth (production only) ──────────────────────────────────────────────
// Set AUTH_USER and AUTH_PASS as environment variables on your host to enable.
// Leaving them unset keeps the app open locally — no change to dev workflow.
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';

if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers['authorization'] || '';
    const [type, encoded] = header.split(' ');
    if (type === 'Basic' && encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
      if (user === AUTH_USER && pass === AUTH_PASS) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Resume Customizer"');
    res.status(401).send('Authentication required.');
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Shared helper: strip markdown fences ─────────────────────────────────────
function stripFences(text) {
  return text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health — Stage 1
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  // Return cached result if fresh (avoids burning tokens on every page load/refresh)
  const now = Date.now();
  if (_healthCache && (now - _healthCacheAt) < HEALTH_TTL_MS) {
    return res.json(_healthCache);
  }
  try {
    // Minimal call (5 tokens) just to verify the key is valid
    const response = await anthropic.messages.create({
      model    : 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages : [{ role: 'user', content: 'Hi' }],
    });
    _healthCache = {
      status   : 'connected',
      message  : 'Claude is ready to tailor your resume.',
      model    : response.model,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    };
    _healthCacheAt = now;
    res.json(_healthCache);
  } catch (err) {
    console.error('[health]', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload — Stage 2
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/upload', (req, res) => {
  upload.single('resume')(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ error: multerErr.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No file received.' });
      const { buffer, originalname, mimetype } = req.file;
      let text = '';
      if (mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')) {
        text = (await pdfParse(buffer)).text;
      } else {
        text = (await mammoth.extractRawText({ buffer })).value;
      }
      text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) return res.status(422).json({ error: 'Could not extract text from this file.' });
      res.json({
        success: true, filename: originalname,
        charCount: text.length, wordCount: text.split(/\s+/).filter(Boolean).length,
        text, preview: text.slice(0, 600),
      });
    } catch (err) {
      console.error('[upload]', err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/analyse-jd — Stage 3: deep JD analysis
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/analyse-jd', async (req, res) => {
  try {
    const { jdText } = req.body;
    if (!jdText || !jdText.trim()) return res.status(400).json({ error: 'Job description is required.' });
    if (jdText.length > MAX_JD_CHARS) return res.status(400).json({ error: `Job description too long (${jdText.length.toLocaleString()} chars). Please trim to under ${MAX_JD_CHARS.toLocaleString()} characters.` });

    const system = `You are an expert recruiter and career strategist. Analyse the job description deeply.
Return ONLY a raw JSON object — no markdown, no code fences.

{
  "coreSkills": ["up to 8 must-have technical or functional skills"],
  "niceToHaves": ["up to 5 preferred but not essential skills"],
  "coreResponsibilities": ["up to 6 key responsibilities as short action phrases"],
  "hiringManagerPriorities": ["top 4 things the hiring manager actually cares most about, in priority order"],
  "atsKeywords": ["up to 15 exact keywords/phrases from the JD critical for ATS — use the exact phrasing"],
  "emphasize": ["up to 5 things a strong candidate should highlight in their resume for this role"],
  "downplay": ["up to 3 things that are irrelevant to this role or could hurt the candidate"],
  "standoutCriteria": ["up to 4 qualities that would make a candidate truly exceptional, beyond the basics"]
}`;

    const response = await anthropic.messages.create({
      model    : 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages : [{ role: 'user', content: `Analyse this job description:\n\n${jdText}` }],
    });

    let analysis;
    try   { analysis = JSON.parse(stripFences(response.content[0].text)); }
    catch { return res.status(500).json({ error: 'Claude returned malformed JSON. Please try again.' }); }

    res.json({ analysis, tokensUsed: response.usage.input_tokens + response.usage.output_tokens });
  } catch (err) {
    console.error('[analyse-jd]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/role-fit — Stage 4: role-fit matrix + verdict
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/role-fit', async (req, res) => {
  try {
    const { resumeText, jdText, additionalContext, jdAnalysis } = req.body;
    if (!resumeText) return res.status(400).json({ error: 'Resume text is required.' });
    if (!jdText)     return res.status(400).json({ error: 'Job description is required.' });
    if (resumeText.length > MAX_RESUME_CHARS) return res.status(400).json({ error: `Resume too long (${resumeText.length.toLocaleString()} chars). Please trim to under ${MAX_RESUME_CHARS.toLocaleString()} characters.` });
    if (jdText.length > MAX_JD_CHARS)         return res.status(400).json({ error: `Job description too long. Please trim to under ${MAX_JD_CHARS.toLocaleString()} characters.` });

    const contextBlock = additionalContext?.trim()
      ? `\n\nADDITIONAL CANDIDATE CONTEXT (self-reported, not in resume):\n${additionalContext}`
      : '';
    const analysisBlock = jdAnalysis
      ? `\n\nJD ANALYSIS INSIGHTS:\nHiring manager priorities: ${jdAnalysis.hiringManagerPriorities?.join(' | ')}\nCore skills required: ${jdAnalysis.coreSkills?.join(', ')}`
      : '';

    const system = `You are a brutally honest but constructive career coach evaluating candidate-job fit.
Return ONLY a raw JSON object — no markdown, no code fences.

{
  "matrix": [
    {
      "requirement": "specific JD requirement (short phrase)",
      "capability": "what the candidate demonstrates or lacks based on their resume + context",
      "strengthLevel": "Strong" | "Moderate" | "Weak" | "Gap"
    }
  ],
  "verdict": {
    "recommendation": "Apply" | "Apply with reservations" | "Address gaps first",
    "rationale": "2–3 honest sentences on overall fit — name the key strengths and the key gaps clearly",
    "tailoringPotential": "1–2 sentences on how smart resume tailoring can improve their chances regardless of gaps"
  }
}

Rules:
- Include 6–10 matrix rows covering the most important JD requirements
- Be honest — do not sugar-coat gaps, but do not catastrophise them either
- Every verdict must end with a constructive path forward via tailoring
- "Apply" = strong fit, go for it
- "Apply with reservations" = worth applying but be upfront about gaps in cover letter
- "Address gaps first" = significant gaps, but tailoring + framing can still make it viable`;

    const response = await anthropic.messages.create({
      model    : 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system,
      messages : [{ role: 'user', content: `RESUME:\n${resumeText}${contextBlock}\n\nJOB DESCRIPTION:\n${jdText}${analysisBlock}` }],
    });

    let result;
    try   { result = JSON.parse(stripFences(response.content[0].text)); }
    catch { return res.status(500).json({ error: 'Claude returned malformed JSON. Please try again.' }); }

    res.json({ ...result, tokensUsed: response.usage.input_tokens + response.usage.output_tokens });
  } catch (err) {
    console.error('[role-fit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tailor — Stage 5: tailor resume bullets (enhanced with analysis)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/tailor', async (req, res) => {
  try {
    const { resumeText, jdText, jdAnalysis, additionalContext } = req.body;
    if (!resumeText || !resumeText.trim()) return res.status(400).json({ error: 'Resume text is required.' });
    if (!jdText     || !jdText.trim())     return res.status(400).json({ error: 'Job description is required.' });
    if (resumeText.length > MAX_RESUME_CHARS) return res.status(400).json({ error: `Resume too long (${resumeText.length.toLocaleString()} chars). Please trim to under ${MAX_RESUME_CHARS.toLocaleString()} characters.` });
    if (jdText.length > MAX_JD_CHARS)         return res.status(400).json({ error: `Job description too long. Please trim to under ${MAX_JD_CHARS.toLocaleString()} characters.` });

    // Build optional context injections
    let priorityBlock = '';
    if (jdAnalysis?.hiringManagerPriorities?.length) {
      priorityBlock = `
HIRING MANAGER'S TOP PRIORITIES — optimise rewrites around these:
${jdAnalysis.hiringManagerPriorities.map((p, i) => `${i + 1}. ${p}`).join('\n')}

CRITICAL ATS KEYWORDS — weave these in naturally where truthful:
${jdAnalysis.atsKeywords?.join(', ')}

WHAT TO EMPHASISE IN THIS RESUME:
${jdAnalysis.emphasize?.join(', ')}
`;
    }

    let candidateBlock = '';
    if (additionalContext?.trim()) {
      candidateBlock = `
ADDITIONAL CANDIDATE CONTEXT (true about them but not in resume — use where genuinely relevant):
${additionalContext}
`;
    }

    const system = `You are an expert resume writer and ATS specialist.
Rewrite resume bullet points to align with the target job description — without fabricating anything.
${priorityBlock}${candidateBlock}
Rules:
- Keep factual content — only improve clarity, specificity, and keyword alignment
- Quantify impact wherever the original implies it but does not state it
- Use strong action verbs from the JD where natural
- Never invent metrics, titles, tools, or responsibilities not implied by the original or additional context
- Brevity: keep every bullet under 130 characters to fit a one-page resume. Cut filler phrases like "demonstrating expertise in" or "showcasing ability to" — lead with the impact instead.
- Return ONLY a raw JSON array — no markdown, no code fences

Output format:
[
  {
    "original": "exact original bullet text",
    "rewritten": "improved bullet text",
    "rationale": "one sentence: what changed and why it helps"
  }
]

Extract every bullet or achievement sentence. If a bullet is already strong and well-aligned, include it with original === rewritten.`;

    const response = await anthropic.messages.create({
      model    : 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system,
      messages : [{ role: 'user', content: `RESUME:\n${resumeText}\n\nJOB DESCRIPTION:\n${jdText}\n\nReturn the JSON array now.` }],
    });

    let bullets;
    try   { bullets = JSON.parse(stripFences(response.content[0].text)); }
    catch (e) {
      console.error('[tailor] parse fail:', e.message);
      return res.status(500).json({ error: 'Claude returned malformed JSON. Please try again.' });
    }
    if (!Array.isArray(bullets)) return res.status(500).json({ error: 'Unexpected response format.' });

    // ATS score — only computed when curated keywords exist (from Stage 3 JD Analysis).
    // Raw word-frequency fallback is intentionally removed: it matched stop words like
    // "with", "have", "from" and produced a misleading score.
    let atsScore       = null;   // null = "score unavailable" → UI shows a message
    let missingKeywords = [];

    if (jdAnalysis?.atsKeywords?.length) {
      const jdKeywords  = new Set(jdAnalysis.atsKeywords.map(k => k.toLowerCase()));
      const tailoredStr = bullets.map(b => b.rewritten).join(' ').toLowerCase();
      const matched     = [...jdKeywords].filter(k => tailoredStr.includes(k));
      atsScore          = Math.min(100, Math.round((matched.length / Math.max(jdKeywords.size, 1)) * 100));
      missingKeywords   = [...jdKeywords].filter(k => !tailoredStr.includes(k)).slice(0, 12);
    }

    res.json({
      bullets,
      changedCount  : bullets.filter(b => b.original !== b.rewritten).length,
      totalCount    : bullets.length,
      atsScore,
      missingKeywords,
      model         : response.model,
      tokensUsed    : response.usage.input_tokens + response.usage.output_tokens,
    });
  } catch (err) {
    console.error('[tailor]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/export — Stage 7: generate tailored DOCX
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/export', async (req, res) => {
  try {
    const { resumeText, bullets, candidateName = '', candidateTitle = '' } = req.body;
    if (!resumeText)             return res.status(400).json({ error: 'resumeText is required.' });
    if (!Array.isArray(bullets)) return res.status(400).json({ error: 'bullets array is required.' });

    // ── 1. Apply accepted rewrites ────────────────────────────────────────────
    let tailoredText = resumeText;
    for (const b of bullets) {
      if (b.accepted && b.original !== b.rewritten && b.original) {
        tailoredText = tailoredText.replaceAll(b.original.trim(), b.rewritten.trim());
      }
    }

    // ── 2. Auto-extract contact info from original resume text ────────────────
    const autoEmail    = (resumeText.match(/[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/)          || [])[0] || '';
    const autoPhone    = (resumeText.match(/(?:\+\d{1,3}[\s\-]?)?\d[\d\s\-().]{8,}\d/) || [])[0] || '';
    const autoLinkedIn = (resumeText.match(/linkedin\.com\/in\/[\w\-]+/i)               || [])[0] || '';
    const topBlock     = resumeText.split('\n').slice(0, 20).join(' ');
    const autoLocation = (topBlock.match(
      /(?:Bangalore|Bengaluru|Mumbai|Delhi|Pune|Hyderabad|Chennai|Kolkata|Noida|Gurugram|Gurgaon|[A-Z][a-z]+(?: [A-Z][a-z]+)?,\s*(?:India|USA|UK|Canada|Australia|Singapore|UAE|Germany|France|Netherlands))/i
    ) || [])[0] || '';

    // ── 3. Colour palette & text-run helpers ──────────────────────────────────
    const COLOR_NAVY = '1A237E';
    const COLOR_TEXT = '212121';
    const COLOR_GREY = '757575';
    const COLOR_BLUE = '1565C0';

    const NUM_RE = /(\b\d[\d,]*(?:\.\d+)?(?:\s*[-–]\s*\d[\d,]*(?:\.\d+)?)?%?\b)/g;

    // Generic: bold numbers and metrics automatically
    function runsFromText(text, { bold = false, size = 20, color = COLOR_TEXT } = {}) {
      if (bold) return [new TextRun({ text, bold: true, size, color, font: 'Calibri' })];
      const parts = text.split(NUM_RE);
      const runs  = [];
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        runs.push(new TextRun({ text: parts[i], bold: i % 2 === 1, size, color, font: 'Calibri' }));
      }
      return runs.length ? runs : [new TextRun({ text, size, color, font: 'Calibri' })];
    }

    // Skills: bold the category name before the first ":"
    function runsFromSkillText(text, { size = 20, color = COLOR_TEXT } = {}) {
      const ci = text.indexOf(':');
      if (ci > 0 && ci < 45) {
        return [
          new TextRun({ text: text.slice(0, ci),  bold: true, size, color, font: 'Calibri' }),
          new TextRun({ text: text.slice(ci), size, color, font: 'Calibri' }),
        ];
      }
      return runsFromText(text, { size, color });
    }

    // Experience bullets: bold the action title up to the first ":"
    function runsFromBulletText(text, { size = 20, color = COLOR_TEXT } = {}) {
      const ci = text.indexOf(':');
      if (ci > 0 && ci < 60) {
        return [
          new TextRun({ text: text.slice(0, ci + 1), bold: true, size, color, font: 'Calibri' }),
          ...runsFromText(text.slice(ci + 1), { size, color }),
        ];
      }
      return runsFromText(text, { size, color });
    }

    // ── 4. Line classifiers ───────────────────────────────────────────────────
    const SECTION_RE = /^(professional\s+summary|summary|objective|profile|experience|work\s+experience|professional\s+experience|employment|education|academic|qualification|skills|technical\s+skills|core\s+skills|core\s+competencies|projects|certifications|certification|awards|achievements|publications|languages|interests|hobbies|volunteering|extracurricular|training|courses|references)/i;

    function isSectionHeader(t) {
      if (!t || t.length > 80) return false;
      if (t === t.toUpperCase() && t.length >= 3 && /[A-Z]/.test(t)) return true;
      if (t.endsWith(':') && t.length <= 40) return true;
      if (SECTION_RE.test(t.replace(/:$/, '').trim())) return true;
      return false;
    }
    function isBulletLine(t) { return /^[•\-–—*▪◦]\s/.test(t); }
    function isJobLine(t) {
      // Company/employer row: must have a year AND a pipe separator — prevents
      // project titles with version numbers from being mis-classified
      if (!t || t.length > 160 || isSectionHeader(t) || isBulletLine(t)) return false;
      return /\b(19|20)\d{2}\b/.test(t) && /\s[|│]\s/.test(t);
    }

    // ── 5. Parse tailoredText into named sections ─────────────────────────────
    const rawLines      = tailoredText.split('\n');
    const firstSecIdx   = rawLines.findIndex(l => isSectionHeader(l.trim()) && l.trim().length > 0);
    const bodyStartIdx  = firstSecIdx >= 0 ? firstSecIdx : 0;

    const sections = [];   // [{ header, lines[] }]
    let   cur      = null;
    for (let i = bodyStartIdx; i < rawLines.length; i++) {
      const t = rawLines[i].trim();
      if (t && isSectionHeader(t)) {
        if (cur) sections.push(cur);
        cur = { header: t, lines: [] };
      } else if (cur) {
        cur.lines.push(rawLines[i]);
      }
    }
    if (cur) sections.push(cur);

    // ── 6. Classify and reorder sections (ATS-optimal) ───────────────────────
    function sectionRank(header) {
      const h = header.toLowerCase().replace(/:$/, '').trim();
      if (/summary|objective|profile|about/.test(h))                    return 1;
      if (/skill|competenc|expertise|proficienc|technical/.test(h))     return 2;
      if (/experience|employment|work/.test(h))                          return 3;
      if (/education|academic|qualification/.test(h))                    return 4;
      if (/certif|award|achievement|honor|honour/.test(h))               return 5;
      if (/project/.test(h))                                             return 6;
      if (/publication|research|patent/.test(h))                         return 7;
      if (/training|course/.test(h))                                     return 8;
      if (/language/.test(h))                                            return 9;
      if (/volunteer|community|extra/.test(h))                           return 10;
      if (/hobby|interest/.test(h))                                      return 11;
      if (/reference/.test(h))                                           return 99;
      return 6;  // unknown → after certifications
    }

    const orderedSections = sections
      .filter(s => !/^references?(\s|:|$)/i.test(s.header.replace(/:$/, '').trim()))
      .sort((a, b) => sectionRank(a.header) - sectionRank(b.header));

    // ── 7. Build paragraphs ───────────────────────────────────────────────────
    const paragraphs = [];

    // ── Contact block (in body — ATS-readable) ────────────────────────────────
    const name  = candidateName.trim();
    const title = candidateTitle.trim();

    if (name) {
      paragraphs.push(new Paragraph({
        children : [new TextRun({ text: name, bold: true, size: 32, color: COLOR_NAVY, font: 'Calibri' })],
        alignment: AlignmentType.CENTER,
        spacing  : { after: 30 },
      }));
    }
    if (title) {
      paragraphs.push(new Paragraph({
        children : [new TextRun({ text: title, bold: true, size: 24, color: '333333', font: 'Calibri' })],
        alignment: AlignmentType.CENTER,
        spacing  : { after: 30 },
      }));
    }

    // Contact line: location | email | phone | linkedin (as clickable hyperlink)
    const contactRuns = [];
    const addSep = () => { if (contactRuns.length) contactRuns.push(new TextRun({ text: '  |  ', size: 18, color: COLOR_GREY, font: 'Calibri' })); };
    if (autoLocation) { addSep(); contactRuns.push(new TextRun({ text: autoLocation, size: 18, color: COLOR_GREY, font: 'Calibri' })); }
    if (autoEmail)    { addSep(); contactRuns.push(new TextRun({ text: autoEmail,    size: 18, color: COLOR_GREY, font: 'Calibri' })); }
    if (autoPhone)    { addSep(); contactRuns.push(new TextRun({ text: autoPhone,    size: 18, color: COLOR_GREY, font: 'Calibri' })); }
    if (autoLinkedIn) {
      addSep();
      const href = autoLinkedIn.startsWith('http') ? autoLinkedIn : `https://${autoLinkedIn}`;
      contactRuns.push(new ExternalHyperlink({
        link    : href,
        children: [new TextRun({ text: autoLinkedIn, size: 18, color: COLOR_BLUE, underline: {}, font: 'Calibri' })],
      }));
    }

    if (contactRuns.length > 0 || name || title) {
      paragraphs.push(new Paragraph({
        children : contactRuns.length ? contactRuns : [new TextRun({ text: '' })],
        alignment: AlignmentType.CENTER,
        spacing  : { after: 80 },
        border   : { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_GREY } },
      }));
    }

    // ── Section bodies ────────────────────────────────────────────────────────
    for (const section of orderedSections) {
      const rawHeader  = section.header.replace(/:$/, '').trim();
      const headerLow  = rawHeader.toLowerCase();
      const isExp      = /experience|employment|work/.test(headerLow);
      const isSkills   = /skill|competenc|expertise|proficienc|technical/.test(headerLow);

      // Section header — uppercase, navy, bold, underline rule
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: rawHeader.toUpperCase(), bold: true, size: 22, color: COLOR_NAVY, font: 'Calibri' })],
        spacing : { before: 180, after: 50 },
        border  : { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR_NAVY } },
      }));

      for (const line of section.lines) {
        const t = line.trim();
        if (!t) { paragraphs.push(new Paragraph({ spacing: { after: 30 } })); continue; }

        if (isExp && isJobLine(t)) {
          // Company/employer row — bold, slight top spacing
          paragraphs.push(new Paragraph({
            children: runsFromText(t, { bold: true, size: 20, color: COLOR_TEXT }),
            spacing : { before: 80, after: 20 },
          }));

        } else if (isBulletLine(t)) {
          const bt = t.replace(/^[•\-–—*▪◦]\s*/, '');
          paragraphs.push(new Paragraph({
            children: isExp ? runsFromBulletText(bt) : isSkills ? runsFromSkillText(bt) : runsFromText(bt),
            bullet  : { level: 0 },
            spacing : { after: 30 },
          }));

        } else if (isSkills) {
          // Non-bulleted skill line — convert to bullet with bold category
          paragraphs.push(new Paragraph({
            children: runsFromSkillText(t),
            bullet  : { level: 0 },
            spacing : { after: 30 },
          }));

        } else if (isExp) {
          // Non-bullet, non-job line inside experience = project/role title
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: t, bold: true, italics: true, size: 20, color: COLOR_TEXT, font: 'Calibri' })],
            spacing : { before: 40, after: 20 },
          }));

        } else {
          // Everything else: summary text, education details, certifications
          paragraphs.push(new Paragraph({
            children: runsFromText(t),
            spacing : { after: 40 },
          }));
        }
      }
    }

    // Fallback: if no sections were parsed, render the full tailored text plainly
    if (orderedSections.length === 0) {
      for (const line of rawLines) {
        const t = line.trim();
        paragraphs.push(t
          ? new Paragraph({ children: runsFromText(t), spacing: { after: 40 } })
          : new Paragraph({ spacing: { after: 60 } })
        );
      }
    }

    // ── 8. Assemble and stream the document ───────────────────────────────────
    const doc = new Document({
      creator: 'AI Resume Customizer',
      title  : 'Tailored Resume',
      sections: [{
        properties: { page: { margin: { top: 720, right: 900, bottom: 720, left: 900 } } },
        children  : paragraphs,
      }],
    });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="tailored-resume.docx"');
    res.send(buffer);
  } catch (err) {
    console.error('[export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log('  │   AI Resume Customizer — Full App       │');
  console.log('  ├─────────────────────────────────────────┤');
  console.log(`  │   Open → http://localhost:${PORT}             │`);
  console.log('  │   Press Ctrl + C to stop                │');
  console.log('  └─────────────────────────────────────────┘');
  console.log('');
});
