// ─────────────────────────────────────────────────────────────────────────────
// AI Resume Customizer — Frontend (Full App)
// app.js  |  All 7 stages
// ─────────────────────────────────────────────────────────────────────────────

// ── Application state ─────────────────────────────────────────────────────────
let resumeText        = '';
let jdText            = '';
let jdAnalysis        = null;   // output of /api/analyse-jd
let additionalContext = '';     // open textbox from role-fit card
let roleFit           = null;   // output of /api/role-fit
let bullets           = [];     // [{original, rewritten, rationale, accepted}]
let atsScore          = null;   // number 0–100 or null if JD Analysis was skipped
let missingKeywords   = [];
let candidateInfo     = { name: '', title: '' };

// Gateway phases: 'idle' | 'ready' | 'jd-done' | 'fit-done' | 'tailored' | 'exported'
let gatewayPhase = 'idle';

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkClaudeConnection();
  initFileUpload();
  initJdInput();
  initCandidateForm();
  initGateway();
  initSessionPersistence();
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — Claude connection
// ─────────────────────────────────────────────────────────────────────────────
async function checkClaudeConnection() {
  const pill      = document.getElementById('connectionPill');
  const dot       = document.getElementById('statusDot');
  const statusTxt = document.getElementById('statusText');
  const modelLine = document.getElementById('claudeModel');
  try {
    const data = await apiFetch('/api/health');
    if (data.status === 'connected') {
      dot.className         = 'dot dot--connected';
      statusTxt.textContent = 'Claude connected';
      pill.className        = 'connection-pill pill--connected';
      if (modelLine) modelLine.textContent = `Model: ${data.model}  ·  Tokens: ${data.tokensUsed}`;
    } else throw new Error(data.message);
  } catch (err) {
    dot.className         = 'dot dot--error';
    statusTxt.textContent = 'Connection failed';
    pill.className        = 'connection-pill pill--error';
    if (modelLine) modelLine.textContent = `Error: ${err.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2a — File upload
// ─────────────────────────────────────────────────────────────────────────────
function initFileUpload() {
  const dropZone      = document.getElementById('dropZone');
  const fileInput     = document.getElementById('fileInput');
  const browseBtn     = document.getElementById('browseBtn');
  const dropContent   = document.getElementById('dropContent');
  const uploadResult  = document.getElementById('uploadResult');
  const uploadLoading = document.getElementById('uploadLoading');
  const uploadError   = document.getElementById('uploadError');
  const removeBtn     = document.getElementById('removeFileBtn');

  browseBtn.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', e => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  removeBtn.addEventListener('click', () => {
    resumeText = ''; fileInput.value = '';
    uploadResult.classList.add('hidden');
    dropContent.classList.remove('hidden');
    uploadError.classList.add('hidden');
    updateGatewayPhase();
    saveSession();
  });

  async function handleFile(file) {
    const isPdf  = file.type === 'application/pdf' || file.name.endsWith('.pdf');
    const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.endsWith('.docx');
    if (!isPdf && !isDocx) return showError(uploadError, 'Only PDF and DOCX files are supported.');
    if (file.size > 10 * 1024 * 1024) return showError(uploadError, 'File too large — max 10 MB.');

    uploadError.classList.add('hidden');
    dropContent.classList.add('hidden');
    uploadResult.classList.add('hidden');
    uploadLoading.classList.remove('hidden');

    try {
      const fd = new FormData();
      fd.append('resume', file);
      const res  = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      uploadLoading.classList.add('hidden');
      if (!res.ok || data.error) throw new Error(data.error || 'Upload failed.');

      resumeText = data.text;
      document.getElementById('fileName').textContent  = data.filename;
      document.getElementById('fileMeta').textContent  = `${data.wordCount.toLocaleString()} words · ${data.charCount.toLocaleString()} characters`;
      document.getElementById('textPreview').textContent = data.preview + (data.text.length > 600 ? '…' : '');
      uploadResult.classList.remove('hidden');
      updateGatewayPhase();
      saveSession();
    } catch (err) {
      uploadLoading.classList.add('hidden');
      dropContent.classList.remove('hidden');
      showError(uploadError, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2b — JD input
// ─────────────────────────────────────────────────────────────────────────────
function initJdInput() {
  const textarea  = document.getElementById('jdInput');
  const charCount = document.getElementById('jdCharCount');
  let saveTimer   = null;
  textarea.addEventListener('input', () => {
    jdText = textarea.value.trim();
    const n = textarea.value.length;
    charCount.textContent = n === 1 ? '1 character' : `${n.toLocaleString()} characters`;
    updateGatewayPhase();
    // Debounce session saves — localStorage writes are synchronous and can
    // cause typing jank if fired on every keystroke for large resume text.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 500);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2c — Candidate name + title form
// ─────────────────────────────────────────────────────────────────────────────
function initCandidateForm() {
  const fields = { candName: 'name', candTitle: 'title' };
  Object.entries(fields).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => { candidateInfo[key] = el.value.trim(); saveSession(); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway — dynamic CTA card
// ─────────────────────────────────────────────────────────────────────────────
function initGateway() {
  document.getElementById('primaryBtn').addEventListener('click', onPrimaryBtn);
  document.getElementById('skipBtn').addEventListener('click', onSkipBtn);
  document.getElementById('retailorBtn').addEventListener('click', resetAndRetailor);
  setGatewayContent(); // render initial state
}

function updateGatewayPhase() {
  const hasResume = resumeText.length > 0;
  const hasJd     = jdText.length > 50;
  if (gatewayPhase === 'idle' || gatewayPhase === 'ready') {
    gatewayPhase = (hasResume && hasJd) ? 'ready' : 'idle';
  }
  setGatewayContent();
}

function setGatewayContent() {
  const primaryBtn = document.getElementById('primaryBtn');
  const retailorBtn = document.getElementById('retailorBtn');
  const skipRow    = document.getElementById('skipRow');
  const skipBtn    = document.getElementById('skipBtn');
  const title      = document.getElementById('gatewayTitle');
  const sub        = document.getElementById('gatewaySub');

  const ready = resumeText.length > 0 && jdText.length > 50;

  retailorBtn.classList.add('hidden');
  primaryBtn.classList.remove('hidden');

  switch (gatewayPhase) {
    case 'idle':
      title.textContent = 'Ready to analyse?';
      sub.textContent   = !resumeText.length && jdText.length <= 50
        ? 'Upload your resume and paste a job description above to continue.'
        : !resumeText.length ? 'Upload your resume to continue.'
        : 'Paste a job description (at least 50 characters) to continue.';
      primaryBtn.textContent = '✦ Analyse Job Description';
      primaryBtn.disabled    = true;
      primaryBtn.classList.add('btn--disabled');
      skipRow.classList.add('hidden');
      break;

    case 'ready':
      title.textContent = 'Ready to analyse?';
      sub.textContent   = 'Run a deep JD analysis first, or skip straight to tailoring.';
      primaryBtn.textContent = '✦ Analyse Job Description';
      primaryBtn.disabled    = false;
      primaryBtn.classList.remove('btn--disabled');
      skipRow.classList.remove('hidden');
      skipBtn.textContent = 'Skip analysis — go straight to tailoring →';
      break;

    case 'jd-done':
      title.textContent = 'Generate Role-Fit Matrix?';
      sub.textContent   = 'Compare your profile against the JD requirements, or skip to tailoring.';
      primaryBtn.textContent = '✦ Generate Role-Fit Matrix';
      primaryBtn.disabled    = false;
      primaryBtn.classList.remove('btn--disabled');
      skipRow.classList.remove('hidden');
      skipBtn.textContent = 'Skip role-fit — go straight to tailoring →';
      break;

    case 'fit-done':
      title.textContent = 'Ready to tailor your resume?';
      sub.textContent   = 'Claude will rewrite your bullets using the JD analysis insights.';
      primaryBtn.textContent = '✦ Tailor My Resume';
      primaryBtn.disabled    = false;
      primaryBtn.classList.remove('btn--disabled');
      skipRow.classList.add('hidden');
      break;

    case 'tailored':
    case 'exported':
      title.textContent = 'Want to try again?';
      sub.textContent   = 'Edit the job description above and tailor again — your resume stays loaded.';
      primaryBtn.classList.add('hidden');
      retailorBtn.classList.remove('hidden');
      skipRow.classList.add('hidden');
      break;
  }
}

function onPrimaryBtn() {
  if (gatewayPhase === 'ready')    runJdAnalysis();
  else if (gatewayPhase === 'jd-done') runRoleFit();
  else if (gatewayPhase === 'fit-done') runTailoring();
}

function onSkipBtn() {
  if (gatewayPhase === 'ready') {
    skipJdAnalysis();
  } else if (gatewayPhase === 'jd-done') {
    skipRoleFit();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — JD Analysis
// ─────────────────────────────────────────────────────────────────────────────
async function runJdAnalysis() {
  const card    = document.getElementById('jdAnalysisCard');
  const badge   = document.getElementById('jdAnalysisBadge');
  const loading = document.getElementById('jdAnalysisLoading');
  const errEl   = document.getElementById('jdAnalysisError');
  const output  = document.getElementById('jdAnalysisOutput');

  card.classList.remove('card--locked'); card.classList.add('card--active');
  badge.className = 'card-badge card-badge--blue'; badge.textContent = 'Stage 3 — Analysing…';
  loading.classList.remove('hidden'); errEl.classList.add('hidden'); output.classList.add('hidden');
  setStepActive(3);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Disable primary button during call
  setGatewayBusy(true);

  try {
    const data = await apiFetch('/api/analyse-jd', { jdText });
    loading.classList.add('hidden');
    jdAnalysis = data.analysis;

    output.innerHTML = renderJdAnalysisHTML(jdAnalysis);
    output.classList.remove('hidden');

    badge.className = 'card-badge card-badge--green'; badge.textContent = 'Stage 3 — Complete';
    card.classList.remove('card--active'); card.classList.add('card--done');
    setStepDone(3); setConnectorDone(3);

    gatewayPhase = 'jd-done';
    setGatewayContent();
    setGatewayBusy(false);
    saveSession();

    // Unlock role-fit card
    const roleFitCard = document.getElementById('roleFitCard');
    roleFitCard.classList.remove('card--locked'); roleFitCard.classList.add('card--active');
    document.getElementById('roleFitBadge').className = 'card-badge card-badge--blue';
    document.getElementById('roleFitBadge').textContent = 'Stage 4 — Optional';
    document.getElementById('roleFitInputArea').classList.remove('hidden');
    setStepActive(4);

  } catch (err) {
    loading.classList.add('hidden');
    showError(errEl, err.message);
    badge.className = 'card-badge card-badge--grey'; badge.textContent = 'Stage 3 — Error';
    card.classList.remove('card--active'); card.classList.add('card--locked');
    setGatewayBusy(false);
  }
}

function skipJdAnalysis() {
  const card  = document.getElementById('jdAnalysisCard');
  const badge = document.getElementById('jdAnalysisBadge');
  card.classList.remove('card--locked'); card.classList.add('card--done');
  badge.className = 'card-badge card-badge--grey'; badge.textContent = 'Stage 3 — Skipped';
  setStepDone(3); setConnectorDone(3);
  gatewayPhase = 'jd-done';
  skipRoleFit(); // skip both at once
}

function renderJdAnalysisHTML(a) {
  const chips = (arr, cls) => (arr || []).map(s => `<span class="keyword-chip ${cls}">${escHtml(s)}</span>`).join('');
  const items = (arr) => (arr || []).map(s => `<li>${escHtml(s)}</li>`).join('');

  return `
    <div class="analysis-grid">
      <div class="analysis-section">
        <h4 class="analysis-heading">Core Skills <span class="analysis-count">${(a.coreSkills||[]).length}</span></h4>
        <div class="chip-row">${chips(a.coreSkills, 'chip--navy')}</div>
      </div>
      <div class="analysis-section">
        <h4 class="analysis-heading">Nice-to-Haves <span class="analysis-count">${(a.niceToHaves||[]).length}</span></h4>
        <div class="chip-row">${chips(a.niceToHaves, 'chip--grey')}</div>
      </div>
      <div class="analysis-section analysis-section--wide">
        <h4 class="analysis-heading">Hiring Manager's Top Priorities</h4>
        <ol class="analysis-list analysis-list--ordered">${items(a.hiringManagerPriorities)}</ol>
      </div>
      <div class="analysis-section analysis-section--wide">
        <h4 class="analysis-heading">Critical ATS Keywords</h4>
        <div class="chip-row">${chips(a.atsKeywords, 'chip--blue')}</div>
      </div>
      <div class="analysis-section">
        <h4 class="analysis-heading emphasize-heading">✓ Emphasise</h4>
        <ul class="analysis-list">${items(a.emphasize)}</ul>
      </div>
      <div class="analysis-section">
        <h4 class="analysis-heading downplay-heading">✗ Downplay</h4>
        <ul class="analysis-list">${items(a.downplay)}</ul>
      </div>
      <div class="analysis-section analysis-section--wide">
        <h4 class="analysis-heading standout-heading">★ What Makes a Standout Candidate</h4>
        <ul class="analysis-list">${items(a.standoutCriteria)}</ul>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4 — Role-Fit Matrix
// ─────────────────────────────────────────────────────────────────────────────
async function runRoleFit() {
  const card    = document.getElementById('roleFitCard');
  const badge   = document.getElementById('roleFitBadge');
  const loading = document.getElementById('roleFitLoading');
  const errEl   = document.getElementById('roleFitError');
  const output  = document.getElementById('roleFitOutput');

  additionalContext = document.getElementById('additionalContext')?.value?.trim() || '';

  // Disable the in-card button while running
  const inCardBtn = document.getElementById('generateRoleFitBtn');
  if (inCardBtn) { inCardBtn.disabled = true; inCardBtn.textContent = '⏳ Generating…'; }

  card.classList.remove('card--locked'); card.classList.add('card--active');
  badge.className = 'card-badge card-badge--blue'; badge.textContent = 'Stage 4 — Generating…';
  loading.classList.remove('hidden'); errEl.classList.add('hidden'); output.classList.add('hidden');
  setStepActive(4);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setGatewayBusy(true);

  try {
    const data = await apiFetch('/api/role-fit', { resumeText, jdText, additionalContext, jdAnalysis });
    loading.classList.add('hidden');
    roleFit = data;

    output.innerHTML = renderRoleFitHTML(data);
    output.classList.remove('hidden');

    // Hide the in-card action buttons once results are shown
    const inputArea = document.getElementById('roleFitInputArea');
    const inCardBtn = document.getElementById('generateRoleFitBtn');
    if (inCardBtn) inCardBtn.closest('.rolefit-card-actions').classList.add('hidden');

    badge.className = 'card-badge card-badge--green'; badge.textContent = 'Stage 4 — Complete';
    card.classList.remove('card--active'); card.classList.add('card--done');
    setStepDone(4); setConnectorDone(4);

    gatewayPhase = 'fit-done';
    setGatewayContent();
    setGatewayBusy(false);
    saveSession();

  } catch (err) {
    loading.classList.add('hidden');
    showError(errEl, err.message);
    badge.className = 'card-badge card-badge--grey'; badge.textContent = 'Stage 4 — Error';
    // Re-enable in-card button on error so user can retry
    const inCardBtn = document.getElementById('generateRoleFitBtn');
    if (inCardBtn) { inCardBtn.disabled = false; inCardBtn.textContent = '✦ Generate Role-Fit Matrix'; }
    setGatewayBusy(false);
  }
}

function skipRoleFit() {
  const card  = document.getElementById('roleFitCard');
  const badge = document.getElementById('roleFitBadge');
  card.classList.remove('card--locked', 'card--active'); card.classList.add('card--done');
  badge.className = 'card-badge card-badge--grey'; badge.textContent = 'Stage 4 — Skipped';
  document.getElementById('roleFitInputArea').classList.add('hidden');
  setStepDone(4); setConnectorDone(4);
  gatewayPhase = 'fit-done';
  setGatewayContent();
}

function renderRoleFitHTML(data) {
  const strengthClass = (s) => ({
    'Strong': 'strength--strong', 'Moderate': 'strength--moderate',
    'Weak': 'strength--weak', 'Gap': 'strength--gap',
  }[s] || '');

  const rows = (data.matrix || []).map(r => `
    <tr>
      <td>${escHtml(r.requirement)}</td>
      <td>${escHtml(r.capability)}</td>
      <td><span class="strength-badge ${strengthClass(r.strengthLevel)}">${escHtml(r.strengthLevel)}</span></td>
    </tr>`).join('');

  const v = data.verdict || {};
  const verdictClass = {
    'Apply': 'verdict--apply',
    'Apply with reservations': 'verdict--caution',
    'Address gaps first': 'verdict--gap',
  }[v.recommendation] || '';

  // Support both camelCase and snake_case field names from Claude
  const tailoringText = v.tailoringPotential || v.tailoring_potential || '';

  return `
    <div class="rolefit-table-wrap">
      <table class="rolefit-table">
        <thead><tr><th>JD Requirement</th><th>Candidate Capability</th><th>Strength</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="verdict-card ${verdictClass}">
      <div class="verdict-header">
        <span class="verdict-label">Verdict</span>
        <span class="verdict-recommendation">${escHtml(v.recommendation || '—')}</span>
      </div>
      <div class="verdict-rationale">${formatVerdictText(v.rationale || '')}</div>
      ${tailoringText ? `<div class="verdict-tailoring"><strong>Tailoring potential:</strong> ${formatVerdictText(tailoringText)}</div>` : ''}
      <div class="verdict-continue">
        <button class="btn btn--primary" onclick="runTailoring()">✦ Tailor My Resume Now →</button>
      </div>
    </div>`;
}

// Format verdict text: numbered points (1) (2) (3) go on new lines; newlines preserved
function formatVerdictText(text) {
  if (!text) return '';
  let s = escHtml(text);
  // Put numbered points (1) (2) (3) on their own lines
  s = s.replace(/\s*\((\d+)\)\s*/g, (match, num) =>
    num === '1' ? `<br><br><span class="verdict-point">(${num})</span> ` : `<br><span class="verdict-point">(${num})</span> `
  );
  // Preserve any actual newlines
  s = s.replace(/\n/g, '<br>');
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 — Tailoring
// ─────────────────────────────────────────────────────────────────────────────
async function runTailoring() {
  const card    = document.getElementById('tailoringCard');
  const badge   = document.getElementById('tailoringBadge');
  const loading = document.getElementById('tailorLoading');
  const errEl   = document.getElementById('tailorError');
  const summary = document.getElementById('tailorSummary');
  const list    = document.getElementById('diffList');

  // Snapshot current phase so we can restore it precisely if the call fails.
  // (Hardcoding 'fit-done' was wrong when the user had skipped Role-Fit.)
  const phaseBeforeTailoring = gatewayPhase;

  card.classList.remove('card--locked'); card.classList.add('card--active');
  badge.className = 'card-badge card-badge--blue'; badge.textContent = 'Stage 5 — Tailoring…';
  loading.classList.remove('hidden');
  errEl.classList.add('hidden'); summary.classList.add('hidden');
  list.classList.add('hidden'); list.innerHTML = '';
  setStepActive(5);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setGatewayBusy(true);

  try {
    const data = await apiFetch('/api/tailor', { resumeText, jdText, jdAnalysis, additionalContext });
    loading.classList.add('hidden');

    bullets         = data.bullets.map(b => ({ ...b, accepted: b.original !== b.rewritten }));
    atsScore        = data.atsScore ?? null;
    missingKeywords = data.missingKeywords || [];

    document.getElementById('summaryChanged').textContent = `✦ ${data.changedCount} bullet${data.changedCount !== 1 ? 's' : ''} rewritten`;
    document.getElementById('summaryTotal').textContent   = `${data.totalCount} total bullets`;
    document.getElementById('summaryTokens').textContent  = `${data.tokensUsed.toLocaleString()} tokens used`;
    summary.classList.remove('hidden');

    renderDiffCards();
    list.classList.remove('hidden');

    badge.className = 'card-badge card-badge--green'; badge.textContent = 'Stage 5 — Complete';
    card.classList.remove('card--active'); card.classList.add('card--done');
    setStepDone(5); setConnectorDone(5);

    gatewayPhase = 'tailored';
    setGatewayContent();
    setGatewayBusy(false);
    saveSession();

    renderAts(data.atsScore, missingKeywords);

  } catch (err) {
    loading.classList.add('hidden');
    showError(errEl, err.message);
    badge.className = 'card-badge card-badge--grey'; badge.textContent = 'Stage 5 — Error';
    card.classList.remove('card--active'); card.classList.add('card--locked');
    gatewayPhase = phaseBeforeTailoring;   // restore the exact phase we came from
    setGatewayContent();
    setGatewayBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 — Diff cards with inline editing
// ─────────────────────────────────────────────────────────────────────────────
function renderDiffCards() {
  const list = document.getElementById('diffList');
  list.innerHTML = '';

  bullets.forEach((bullet, idx) => {
    const changed = bullet.original !== bullet.rewritten;
    const card = document.createElement('div');
    card.className = `diff-card ${changed ? '' : 'diff-card--unchanged'}`;
    card.id = `diff-card-${idx}`;

    if (!changed) {
      card.innerHTML = `
        <div class="diff-card-header">
          <span class="diff-status diff-status--same">Unchanged</span>
        </div>
        <p class="diff-unchanged-text">${escHtml(bullet.original)}</p>`;
    } else {
      card.innerHTML = `
        <div class="diff-card-header">
          <span class="diff-status diff-status--changed" id="status-${idx}">${bullet.accepted ? '✓ Accepted' : '✗ Rejected'}</span>
          <div class="diff-card-actions">
            <button class="action-btn action-btn--accept ${bullet.accepted ? 'active' : ''}" onclick="setBulletAccepted(${idx}, true)"  id="accept-${idx}">Accept</button>
            <button class="action-btn action-btn--reject ${!bullet.accepted ? 'active' : ''}" onclick="setBulletAccepted(${idx}, false)" id="reject-${idx}">Reject</button>
            <button class="action-btn action-btn--edit" onclick="toggleEdit(${idx})" id="edit-${idx}" title="Edit rewrite">✎ Edit</button>
          </div>
        </div>
        <div class="diff-row">
          <div class="diff-col diff-col--before">
            <span class="diff-label">Before</span>
            <p class="diff-text">${escHtml(bullet.original)}</p>
          </div>
          <div class="diff-arrow">→</div>
          <div class="diff-col diff-col--after" id="after-col-${idx}">
            <span class="diff-label">After</span>
            <p class="diff-text" id="after-text-${idx}">${escHtml(bullet.rewritten)}</p>
            <textarea class="inline-edit-area hidden" id="after-edit-${idx}" rows="3">${escHtml(bullet.rewritten)}</textarea>
            <div class="inline-edit-actions hidden" id="after-edit-actions-${idx}">
              <button class="action-btn action-btn--accept active" onclick="saveEdit(${idx})">Save</button>
              <button class="action-btn" onclick="cancelEdit(${idx})">Cancel</button>
            </div>
          </div>
        </div>
        <div class="diff-rationale">
          <span class="rationale-label">Why:</span> <span id="rationale-${idx}">${escHtml(bullet.rationale)}</span>
        </div>`;
    }
    list.appendChild(card);
  });
}

function setBulletAccepted(idx, accepted) {
  bullets[idx].accepted = accepted;
  const statusEl  = document.getElementById(`status-${idx}`);
  statusEl.textContent = accepted ? '✓ Accepted' : '✗ Rejected';
  statusEl.className   = `diff-status ${accepted ? 'diff-status--changed' : 'diff-status--rejected'}`;
  document.getElementById(`accept-${idx}`).classList.toggle('active', accepted);
  document.getElementById(`reject-${idx}`).classList.toggle('active', !accepted);
  saveSession();
}

function toggleEdit(idx) {
  const textEl    = document.getElementById(`after-text-${idx}`);
  const editArea  = document.getElementById(`after-edit-${idx}`);
  const actionsEl = document.getElementById(`after-edit-actions-${idx}`);
  const editBtn   = document.getElementById(`edit-${idx}`);
  const isEditing = !editArea.classList.contains('hidden');
  if (isEditing) { cancelEdit(idx); return; }
  editArea.value = bullets[idx].rewritten;
  textEl.classList.add('hidden');
  editArea.classList.remove('hidden');
  actionsEl.classList.remove('hidden');
  editBtn.classList.add('active');
  editArea.focus();
}

function saveEdit(idx) {
  const editArea  = document.getElementById(`after-edit-${idx}`);
  const textEl    = document.getElementById(`after-text-${idx}`);
  const actionsEl = document.getElementById(`after-edit-actions-${idx}`);
  const editBtn   = document.getElementById(`edit-${idx}`);
  const newText   = editArea.value.trim();
  if (newText) {
    bullets[idx].rewritten = newText;
    textEl.textContent = newText;
  }
  textEl.classList.remove('hidden');
  editArea.classList.add('hidden');
  actionsEl.classList.add('hidden');
  editBtn.classList.remove('active');
  saveSession();
}

function cancelEdit(idx) {
  document.getElementById(`after-text-${idx}`).classList.remove('hidden');
  document.getElementById(`after-edit-${idx}`).classList.add('hidden');
  document.getElementById(`after-edit-actions-${idx}`).classList.add('hidden');
  document.getElementById(`edit-${idx}`).classList.remove('active');
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6 — ATS Signal + Missing Keywords
// ─────────────────────────────────────────────────────────────────────────────
function renderAts(score, missing, { suppressExportUnlock = false } = {}) {
  const card    = document.getElementById('atsCard');
  const badge   = document.getElementById('atsBadge');
  const section = document.getElementById('atsSection');
  const fill    = document.getElementById('atsFill');
  const scoreEl = document.getElementById('atsScore');
  const labelEl = document.getElementById('atsLabel');

  card.classList.remove('card--locked'); card.classList.add('card--active');
  badge.className = 'card-badge card-badge--blue'; badge.textContent = 'Stage 6 — ATS Signal';
  section.classList.remove('hidden');
  setStepActive(6);

  if (score === null) {
    // JD Analysis was skipped — we have no curated keywords to score against.
    // Show a neutral "unavailable" state rather than a misleading number.
    fill.style.width = '0%';
    scoreEl.textContent = '—';
    labelEl.textContent = 'Score requires JD Analysis (Stage 3)';
    labelEl.style.color = 'var(--grey-600)';
  } else {
    setTimeout(() => { fill.style.width = `${score}%`; }, 100);
    scoreEl.textContent = `${score}%`;

    if (score >= 70)      { labelEl.textContent = 'Strong match';   labelEl.style.color = 'var(--green)'; }
    else if (score >= 45) { labelEl.textContent = 'Moderate match'; labelEl.style.color = 'var(--blue)'; }
    else                  { labelEl.textContent = 'Weak match';     labelEl.style.color = 'var(--red)'; }

    // Missing keywords — only shown when we have a real score
    const wrap = document.getElementById('missingKeywordsWrap');
    const list = document.getElementById('missingKeywordsList');
    if (missing && missing.length > 0) {
      list.innerHTML = missing.map(k => `<span class="keyword-chip chip--missing">${escHtml(k)}</span>`).join('');
      wrap.classList.remove('hidden');
    }
  }

  badge.className = 'card-badge card-badge--green'; badge.textContent = 'Stage 6 — Complete';
  card.classList.remove('card--active'); card.classList.add('card--done');
  setStepDone(6); setConnectorDone(6);

  if (!suppressExportUnlock) setTimeout(unlockExportCard, 500);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7 — Export
// ─────────────────────────────────────────────────────────────────────────────
function unlockExportCard() {
  const card    = document.getElementById('exportCard');
  const badge   = document.getElementById('exportBadge');
  const section = document.getElementById('exportSection');
  const summary = document.getElementById('exportSummary');
  const btn     = document.getElementById('exportBtn');
  const errEl   = document.getElementById('exportError');

  card.classList.remove('card--locked'); card.classList.add('card--active');
  badge.className = 'card-badge card-badge--blue'; badge.textContent = 'Stage 7 — Export';
  setStepActive(7);

  const acceptedCount = bullets.filter(b => b.accepted && b.original !== b.rewritten).length;
  const rejectedCount = bullets.filter(b => !b.accepted && b.original !== b.rewritten).length;
  summary.innerHTML =
    `<span class="summary-chip">${acceptedCount} rewrite${acceptedCount !== 1 ? 's' : ''} accepted</span>` +
    `<span class="summary-chip summary-chip--grey">${rejectedCount} rejected</span>`;
  section.classList.remove('hidden');

  // Remove old listener by cloning
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener('click', async () => {
    newBtn.textContent = '⏳ Generating…'; newBtn.disabled = true;
    errEl.classList.add('hidden');
    try {
      const res = await fetch('/api/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, bullets, candidateName: candidateInfo.name, candidateTitle: candidateInfo.title }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: 'tailored-resume.docx' });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      newBtn.textContent = '✓ Downloaded!';
      badge.className = 'card-badge card-badge--green'; badge.textContent = 'Stage 7 — Complete';
      card.classList.remove('card--active'); card.classList.add('card--done');
      setStepDone(7);
      gatewayPhase = 'exported';
      setGatewayContent();
      saveSession();
      setTimeout(() => { newBtn.textContent = '⬇ Download DOCX'; newBtn.disabled = false; }, 3000);
    } catch (err) {
      newBtn.textContent = '⬇ Download DOCX'; newBtn.disabled = false;
      showError(errEl, err.message);
    }
  });

  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailor Again — reset stages 3–7
// ─────────────────────────────────────────────────────────────────────────────
function resetAndRetailor() {
  bullets = []; jdAnalysis = null; roleFit = null; additionalContext = '';
  missingKeywords = [];

  const resets = [
    { id: 'jdAnalysisCard',  badge: 'jdAnalysisBadge',  label: 'Stage 3 — Optional',  step: 3, extraHide: ['jdAnalysisLoading','jdAnalysisOutput','jdAnalysisError'] },
    { id: 'roleFitCard',     badge: 'roleFitBadge',      label: 'Stage 4 — Optional',  step: 4, extraHide: ['roleFitLoading','roleFitOutput','roleFitError','roleFitInputArea'] },
    { id: 'tailoringCard',   badge: 'tailoringBadge',    label: 'Stage 5 — Pending',   step: 5, extraHide: ['tailorLoading','tailorError','tailorSummary','diffList'] },
    { id: 'atsCard',         badge: 'atsBadge',          label: 'Stage 6 — Pending',   step: 6, extraHide: ['atsSection'] },
    { id: 'exportCard',      badge: 'exportBadge',       label: 'Stage 7 — Pending',   step: 7, extraHide: ['exportSection'] },
  ];

  resets.forEach(r => {
    const card  = document.getElementById(r.id);
    const badge = document.getElementById(r.badge);
    card.classList.remove('card--active', 'card--done'); card.classList.add('card--locked');
    badge.className = 'card-badge card-badge--grey'; badge.textContent = r.label;
    r.extraHide.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    if (r.id === 'tailoringCard') document.getElementById('diffList').innerHTML = '';
    if (r.id === 'atsCard') document.getElementById('atsFill').style.width = '0%';
    // Reset step
    const stepEl = document.getElementById(`step${r.step}`);
    if (stepEl) { stepEl.className = 'stage-step stage-step--locked'; stepEl.querySelector('.step-circle').textContent = r.step; }
    const connEl = document.getElementById(`conn${r.step}`);
    if (connEl) connEl.className = 'step-connector';
  });

  // Reset additional context textarea
  const ctxEl = document.getElementById('additionalContext');
  if (ctxEl) ctxEl.value = '';

  gatewayPhase = 'ready';
  setGatewayContent();
  document.getElementById('gatewayCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  saveSession();
}

// ─────────────────────────────────────────────────────────────────────────────
// Session persistence
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_KEY = 'resumeCustomizer_v2';

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      resumeText, jdText, jdAnalysis, additionalContext, roleFit, bullets,
      atsScore, missingKeywords, candidateInfo, gatewayPhase, timestamp: Date.now(),
    }));
  } catch (e) { /* storage full or unavailable */ }
}

function initSessionPersistence() {
  document.getElementById('clearSessionBtn').addEventListener('click', clearSession);
  document.getElementById('restoreSessionBtn').addEventListener('click', restoreSession);
  document.getElementById('dismissSessionBtn').addEventListener('click', () => {
    document.getElementById('sessionBanner').classList.add('hidden');
    clearSession();
  });

  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    // Show banner only if there's meaningful saved state
    if (s.resumeText && s.resumeText.length > 0) {
      document.getElementById('sessionBanner').classList.remove('hidden');
      document.getElementById('clearSessionBtn').classList.remove('hidden');
    }
  } catch (e) {}
}

function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!s) return;

    resumeText        = s.resumeText || '';
    jdText            = s.jdText || '';
    jdAnalysis        = s.jdAnalysis || null;
    additionalContext = s.additionalContext || '';
    roleFit           = s.roleFit || null;
    bullets           = s.bullets || [];
    atsScore          = s.atsScore ?? null;
    missingKeywords   = s.missingKeywords || [];
    candidateInfo     = s.candidateInfo || { name: '', title: '' };
    gatewayPhase      = s.gatewayPhase || 'idle';

    // Restore candidate form fields
    const candName  = document.getElementById('candName');
    const candTitle = document.getElementById('candTitle');
    if (candName  && candidateInfo.name)  candName.value  = candidateInfo.name;
    if (candTitle && candidateInfo.title) candTitle.value = candidateInfo.title;

    // Restore UI fields
    if (jdText) {
      const ta = document.getElementById('jdInput');
      ta.value = jdText;
      document.getElementById('jdCharCount').textContent = `${jdText.length.toLocaleString()} characters`;
    }
    if (additionalContext) {
      const ctx = document.getElementById('additionalContext');
      if (ctx) ctx.value = additionalContext;
    }
    if (resumeText) {
      document.getElementById('dropContent').classList.add('hidden');
      document.getElementById('fileName').textContent = 'Restored from session';
      document.getElementById('fileMeta').textContent = `${resumeText.split(/\s+/).filter(Boolean).length.toLocaleString()} words`;
      document.getElementById('textPreview').textContent = resumeText.slice(0, 600) + (resumeText.length > 600 ? '…' : '');
      document.getElementById('uploadResult').classList.remove('hidden');
    }

    // Restore completed stages
    if (jdAnalysis && ['jd-done','fit-done','tailored','exported'].includes(gatewayPhase)) {
      const card = document.getElementById('jdAnalysisCard');
      card.classList.remove('card--locked'); card.classList.add('card--done');
      document.getElementById('jdAnalysisBadge').className = 'card-badge card-badge--green';
      document.getElementById('jdAnalysisBadge').textContent = 'Stage 3 — Complete';
      document.getElementById('jdAnalysisOutput').innerHTML = renderJdAnalysisHTML(jdAnalysis);
      document.getElementById('jdAnalysisOutput').classList.remove('hidden');
      setStepDone(3); setConnectorDone(3);
    }
    if (roleFit && ['fit-done','tailored','exported'].includes(gatewayPhase)) {
      const card = document.getElementById('roleFitCard');
      card.classList.remove('card--locked'); card.classList.add('card--done');
      document.getElementById('roleFitBadge').className = 'card-badge card-badge--green';
      document.getElementById('roleFitBadge').textContent = 'Stage 4 — Complete';
      document.getElementById('roleFitOutput').innerHTML = renderRoleFitHTML(roleFit);
      document.getElementById('roleFitOutput').classList.remove('hidden');
      setStepDone(4); setConnectorDone(4);
    }
    if (bullets.length > 0 && ['tailored','exported'].includes(gatewayPhase)) {
      const changed = bullets.filter(b => b.original !== b.rewritten).length;
      document.getElementById('summaryChanged').textContent = `✦ ${changed} bullets rewritten`;
      document.getElementById('summaryTotal').textContent   = `${bullets.length} total bullets`;
      document.getElementById('summaryTokens').textContent  = 'Session restored';
      document.getElementById('tailorSummary').classList.remove('hidden');
      renderDiffCards();
      document.getElementById('diffList').classList.remove('hidden');
      const card = document.getElementById('tailoringCard');
      card.classList.remove('card--locked'); card.classList.add('card--done');
      document.getElementById('tailoringBadge').className = 'card-badge card-badge--green';
      document.getElementById('tailoringBadge').textContent = 'Stage 5 — Complete';
      setStepDone(5); setConnectorDone(5);

      // Stage 6 — restore ATS card without triggering the auto-unlock setTimeout
      renderAts(atsScore, missingKeywords, { suppressExportUnlock: true });
      // Stage 7 — restore Export card using the existing unlock function, then
      // mark it done immediately if the user had already downloaded in this session
      unlockExportCard();
      if (gatewayPhase === 'exported') {
        const exportCard  = document.getElementById('exportCard');
        const exportBadge = document.getElementById('exportBadge');
        exportBadge.className   = 'card-badge card-badge--green';
        exportBadge.textContent = 'Stage 7 — Complete';
        exportCard.classList.remove('card--active'); exportCard.classList.add('card--done');
        setStepDone(7);
      }
    }

    setGatewayContent();
    document.getElementById('sessionBanner').classList.add('hidden');
    document.getElementById('clearSessionBtn').classList.remove('hidden');
  } catch (e) { console.warn('Session restore failed:', e); }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  document.getElementById('sessionBanner').classList.add('hidden');
  document.getElementById('clearSessionBtn').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress bar helpers
// ─────────────────────────────────────────────────────────────────────────────
function setStepActive(n) {
  const el = document.getElementById(`step${n}`);
  if (!el) return;
  el.className = 'stage-step stage-step--active';
  el.querySelector('.step-circle').textContent = n;
}
function setStepDone(n) {
  const el = document.getElementById(`step${n}`);
  if (!el) return;
  el.className = 'stage-step stage-step--done';
  el.querySelector('.step-circle').textContent = '✓';
}
function setConnectorDone(n) {
  const el = document.getElementById(`conn${n}`);
  if (el) el.className = 'step-connector step-connector--done';
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
async function apiFetch(url, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' };
  const res  = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setGatewayBusy(busy) {
  const btn = document.getElementById('primaryBtn');
  btn.disabled = busy;
  btn.classList.toggle('btn--disabled', busy);
}

function showError(el, msg) {
  el.textContent = `Error: ${msg}`;
  el.classList.remove('hidden');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
