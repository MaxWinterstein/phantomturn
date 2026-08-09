/**
 * Browser front end. Nothing here talks to a network -- the file is read
 * locally, repaired in memory and handed back as a Blob.
 */
import { anonymize } from './lib/anonymize.js';
import { DEFAULTS, repair } from './lib/swim-repair.js';

const el = (id) => document.getElementById(id);

const dropzone = el('dropzone');
const picker = el('picker');
const errorBox = el('error');
const result = el('result');
const filenameEl = el('filename');
const statsEl = el('stats');
const findingsEl = el('findings');
const downloadBtn = el('download');
const resetBtn = el('reset');
const sampleLine = document.querySelector('.sample-line');
const assumption = el('assumption');
const optionsBadge = el('optionsBadge');
const share = el('share');
const removedList = el('removed');
const anonymizeBtn = el('anonymize');
const busy = el('busy');

/** Loaded file, the most recent repair output, and the anonymized copy. */
const state = { name: null, input: null, output: null, anonymized: null };

/**
 * Escapes text destined for innerHTML.
 *
 * Nothing currently interpolated is attacker-controlled -- the values are
 * numbers, or keys from frozen tables -- but only because getField() happens to
 * return a byte rather than text for FIT string fields. That is an accident of
 * another module, undocumented, and one `getStringField()` helper away from
 * turning every template below into a stored-XSS sink fed by an uploaded file.
 * Escaping at the sink costs nothing and does not depend on remembering.
 */
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const FINDINGS = {
  'phantom-turn': {
    icon: '👻',
    name: 'Phantom turn',
    tone: 'warn',
    detail: (f) =>
      `Recorded as ${f.detected} lengths in ${fmtSeconds(f.durS)} with ${f.strokes} strokes — merged back into one`,
  },
  'stroke-mismatch': {
    icon: '🔀',
    name: 'Stroke misread',
    tone: '',
    detail: (f) =>
      `Watch recorded ${f.device}; ${f.strokes} strokes over ${fmtSeconds(f.durS)} looks like ${f.proposed}`,
  },
  'ambiguous-stroke': {
    icon: '❓',
    name: 'Ambiguous stroke',
    tone: '',
    detail: (f) =>
      `${f.strokes} strokes but ${fmtSeconds(f.durS)} — the two criteria disagree, so the watch's own label is kept`,
  },
  'inflated-elapsed': {
    icon: '⏱️',
    name: 'Inflated elapsed time',
    tone: '',
    detail: (f) => `${fmtSeconds(f.extraS)} between stopping the timer and saving, removed`,
  },
  'lap-structure': {
    icon: '🛑',
    name: 'Check this before you use it',
    tone: 'danger',
    detail: (f) =>
      `${f.note} That would take ${f.lengthsBefore} lengths down to ${f.lengthsAfter}.`,
  },
};

/** The lap-structure warning belongs at the top; everything else is detail. */
const findingOrder = (f) => (f.type === 'lap-structure' ? 0 : 1);

/**
 * Every assumption in DEFAULTS, wired to a control. Keys match DEFAULTS so the
 * reset and the "changed" badge stay honest without a second list. The bounds
 * mirror the HTML min/max, and are enforced here too: the browser's are
 * advisory, so a typed 99999 used to be applied while the banner cheerfully
 * reported it.
 */
const CONTROLS = {
  lengthsPerLap: { kind: 'number', min: 1, max: 64, auto: true },
  strokeSplit: { kind: 'number', min: 1, max: 500 },
  durationSplit: { kind: 'number', min: 1, max: 900 },
  reclassifyStroke: { kind: 'checkbox' },
  normalizeElapsed: { kind: 'checkbox' },
};

const controlFor = (key) => el(key);

function applyDefaults() {
  for (const [key, spec] of Object.entries(CONTROLS)) {
    const input = controlFor(key);
    if (spec.kind === 'checkbox') input.checked = DEFAULTS[key];
    else input.value = DEFAULTS[key];
    input.setAttribute('aria-invalid', 'false');
  }
}

/**
 * Current settings, clamped into range. Out-of-range input is corrected in the
 * field as well as in the value, so what is displayed is always what is
 * applied -- silently substituting the default behind a box still showing the
 * rejected number is how you get someone trusting the wrong output.
 */
function readOptions() {
  const opts = {};
  for (const [key, spec] of Object.entries(CONTROLS)) {
    const input = controlFor(key);
    if (spec.kind === 'checkbox') {
      opts[key] = input.checked;
      continue;
    }
    const text = input.value.trim();
    if (spec.auto && text.toLowerCase() === 'auto') {
      opts[key] = 'auto';
      input.setAttribute('aria-invalid', 'false');
      continue;
    }
    const raw = Number(text);
    const ok = Number.isFinite(raw) && raw >= spec.min && raw <= spec.max;
    const value = ok ? Math.floor(raw) : DEFAULTS[key];
    opts[key] = value;
    input.setAttribute('aria-invalid', String(!ok && text !== ''));
    // Only rewrite the field once it has lost focus, so typing "12" does not
    // get clobbered halfway through at "1".
    if (!ok && document.activeElement !== input) input.value = value;
  }
  return opts;
}

/** Shows how far the current settings have drifted from the defaults. */
function renderOptionState(opts) {
  const changed = Object.keys(CONTROLS).filter((k) => opts[k] !== DEFAULTS[k]).length;
  optionsBadge.hidden = changed === 0;
  optionsBadge.textContent = `${changed} changed`;

  const n = opts.lengthsPerLap;
  const unit = state.output?.info?.lengthUnitS;
  if (n === 'auto') {
    assumption.className = 'assumption assumption-auto';
    assumption.innerHTML =
      '🔎 <strong>Lengths per lap worked out from this file.</strong> ' +
      (unit ? `One length reads as about ${Math.round(unit)} seconds, ` : '') +
      'and each lap is measured against that, so a swim you lapped inconsistently still ' +
      'comes out right. Check the numbers before you trust the file — and set a number ' +
      'under Assumptions if you disagree.';
    return;
  }
  assumption.className = 'assumption';
  assumption.innerHTML =
    n === 1
      ? '⚠️ <strong>This assumes one lap button press per pool length.</strong> Every lap is ' +
        'merged down to a single length. If you lap once per interval instead — or not at all, ' +
        'letting auto-pause do the work — that throws away real distance. Set it back to ' +
        '<strong>auto</strong> under Assumptions, and check the numbers before you trust the file.'
      : `⚠️ <strong>This assumes ${esc(n)} pool lengths per lap button press.</strong> Laps ` +
        `holding more than ${esc(n)} lengths are merged down to ${esc(n)}; laps with fewer are ` +
        'left alone. Check the numbers before you trust the file.';
}

/** Seconds as m:ss, or h:mm:ss once it runs past an hour. */
function fmtSeconds(total) {
  const s = Math.round(total);
  const parts = [Math.floor(s / 60) % 60, s % 60];
  if (s >= 3600) parts.unshift(Math.floor(s / 3600));
  return parts.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join(':');
}

function statCard({ label, value, was, unit }) {
  const changed = was !== undefined && was !== value;
  const suffix = unit ?? '';
  const previous = changed ? `<span class="stat-was">${esc(was)}${esc(suffix)}</span>` : '';
  return `
    <div class="stat${changed ? ' changed' : ''}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}${esc(suffix)}${previous}</div>
    </div>`;
}

function render() {
  const { info, summary } = state.output;

  // What the watch claimed, reconstructed from the pre-merge length counts.
  const lengthsBefore = info.swimLaps.reduce((a, l) => a + l.lengths, 0);
  const distanceBefore = lengthsBefore * info.poolM;

  statsEl.innerHTML = [
    statCard({
      label: 'Distance',
      value: summary.distanceM,
      was: distanceBefore,
      unit: ' m',
    }),
    statCard({ label: 'Lengths', value: summary.lengths, was: lengthsBefore }),
    statCard({ label: 'Swim time', value: fmtSeconds(summary.swimS) }),
  ].join('');

  const findings = info.findings;
  if (!findings.length) {
    findingsEl.innerHTML = '<p class="nothing">✅ Nothing looks wrong in this file.</p>';
    return;
  }

  const rows = [...findings]
    .sort((a, b) => findingOrder(a) - findingOrder(b))
    .map((f) => {
      const meta = FINDINGS[f.type];
      if (!meta) return '';
      const lap =
        f.lap === undefined ? '' : `<span class="finding-lap">lap ${esc(f.lap + 1)}</span>`;
      return `
        <li class="finding ${meta.tone}">
          <span class="finding-icon" aria-hidden="true">${meta.icon}</span>
          <div>
            <div class="finding-head"><span class="finding-name">${esc(meta.name)}</span>${lap}</div>
            <div class="finding-detail">${esc(meta.detail(f))}</div>
          </div>
        </li>`;
    })
    .join('');

  const n = findings.length;
  findingsEl.innerHTML = `
    <p class="findings-title">${n} finding${n === 1 ? '' : 's'}</p>
    <ul>${rows}</ul>`;
}

function runRepair() {
  const opts = readOptions();
  try {
    state.output = repair(state.input, opts);
    // After the repair, not before: the inferred length unit is part of what
    // the banner reports, and it does not exist until the file has been read.
    renderOptionState(opts);
    errorBox.hidden = true;
    result.hidden = false;
    dropzone.hidden = true;
    sampleLine.hidden = true;
    render();
  } catch (err) {
    renderOptionState(opts);
    showError(err.message);
  }
}

function showError(message) {
  state.output = null;
  result.hidden = true;
  dropzone.hidden = false;
  sampleLine.hidden = false;
  errorBox.hidden = false;
  errorBox.textContent = `Could not read this file: ${message}`;
}

/**
 * Offered whether or not the repair succeeded. Someone sharing a file is most
 * likely sharing one that broke -- a multisport or non-pool activity, which
 * analyze() rejects outright -- and that is exactly the file worth sending.
 */
function prepareShare() {
  try {
    state.anonymized = anonymize(state.input);
    const items = state.anonymized.removed;
    removedList.innerHTML = items.length
      ? items.map((r) => `<li>${esc(r)}</li>`).join('')
      : '<li class="removed-none">Nothing personal found in this file.</li>';
    share.hidden = false;
  } catch {
    // Too damaged to parse; nothing useful to hand over.
    state.anonymized = null;
    share.hidden = true;
  }
}

/**
 * Repairing is synchronous and a big file takes real time, so yield a frame
 * first to let the "working" state paint. Without it the tab simply freezes
 * with no indication anything is happening.
 */
function withBusy(work) {
  busy.hidden = false;
  // A timer, not requestAnimationFrame. The double-rAF trick is the usual way
  // to guarantee a paint first, but rAF does not run at all in a background
  // tab -- or in headless Chromium, which is how this was caught -- and the
  // page would then sit on "Working..." forever. A short timeout always fires,
  // and in practice still paints first.
  setTimeout(() => {
    try {
      work();
    } finally {
      busy.hidden = true;
    }
  }, 16);
}

function loadBytes(name, label, bytes) {
  state.name = name;
  filenameEl.textContent = label;
  state.input = bytes;
  withBusy(() => {
    runRepair();
    prepareShare();
  });
}

async function loadFile(files) {
  const list = files ? [...files] : [];
  if (!list.length) {
    showError('no file was dropped — try picking one instead');
    return;
  }
  const [file, ...rest] = list;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadBytes(
      file.name,
      rest.length ? `${file.name} (${rest.length} more ignored)` : file.name,
      bytes,
    );
  } catch {
    showError('the file could not be opened — a folder, perhaps?');
  }
}

/** An anonymized real session, so the tool can be tried without your own data. */
async function loadSample() {
  try {
    const res = await fetch('./sample/pool-swim.fit');
    if (!res.ok) throw new Error(`sample unavailable (${res.status})`);
    loadBytes('pool-swim.fit', 'pool-swim.fit — sample', new Uint8Array(await res.arrayBuffer()));
  } catch (err) {
    showError(err.message);
  }
}

function save(bytes, suffix) {
  // Copy into a fresh buffer: the bytes may be a view on a larger one.
  const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Strip any extension, not just .fit, and keep the name to something a file
  // system will accept.
  const stem = state.name.replace(/\.[^./\\]*$/, '').replace(/[/\\]/g, '_') || 'activity';
  a.download = `${stem.slice(0, 120)}${suffix}.fit`;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately works in Chromium because click() resolves the blob
  // synchronously, but that is an implementation detail -- Safari in
  // particular has historically navigated to the URL instead, by which time it
  // would already be dead.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function reset() {
  state.name = null;
  state.input = null;
  state.output = null;
  state.anonymized = null;
  picker.value = '';
  filenameEl.textContent = '';
  statsEl.innerHTML = '';
  findingsEl.innerHTML = '';
  removedList.innerHTML = '';
  result.hidden = true;
  errorBox.hidden = true;
  share.hidden = true;
  busy.hidden = true;
  dropzone.hidden = false;
  sampleLine.hidden = false;
}

// ------------------------------------------------------------------- events
picker.addEventListener('change', () => {
  loadFile(picker.files);
  // Clear it so re-picking the same path fires `change` again.
  picker.value = '';
});

/*
 * Drag and drop is bound to the window, not the dropzone. The dropzone is
 * hidden once a file loads, so a zone-scoped listener meant dropping a second
 * file anywhere on the page did nothing at all, with no error and no hint.
 */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  loadFile(e.dataTransfer?.files);
});

/** Re-running on every keystroke is wasteful on a large file. */
let pending;
const scheduleRepair = () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    if (state.input) runRepair();
    else renderOptionState(readOptions());
  }, 150);
};

for (const key of Object.keys(CONTROLS)) {
  const input = controlFor(key);
  input.addEventListener('input', scheduleRepair);
  input.addEventListener('change', scheduleRepair);
  input.addEventListener('blur', scheduleRepair);
}

el('resetOptions').addEventListener('click', () => {
  applyDefaults();
  if (state.input) runRepair();
  else renderOptionState(readOptions());
});

downloadBtn.addEventListener('click', () => state.output && save(state.output.bytes, '_fixed'));
anonymizeBtn.addEventListener('click', () => {
  if (state.anonymized) save(state.anonymized.bytes, '_anonymized');
});
resetBtn.addEventListener('click', reset);
el('sample').addEventListener('click', loadSample);

applyDefaults();
renderOptionState(readOptions());

// ?demo loads the sample straight away -- handy for screenshots and for
// checking a deploy without dragging a file in.
if (new URLSearchParams(location.search).has('demo')) loadSample();
