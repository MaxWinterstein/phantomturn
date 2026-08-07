/**
 * Browser front end. Nothing here talks to a network -- the file is read with
 * FileReader, repaired in memory and handed back as a Blob.
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

/** Loaded file, the most recent repair output, and the anonymized copy. */
const state = { name: null, input: null, output: null, anonymized: null };

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
 * Every assumption in DEFAULTS, wired to a control. Keys must match DEFAULTS
 * so the reset and the "changed" badge stay honest without a second list.
 */
const CONTROLS = {
  lengthsPerLap: 'number',
  strokeSplit: 'number',
  durationSplit: 'number',
  reclassifyStroke: 'checkbox',
  normalizeElapsed: 'checkbox',
};

const controlFor = (key) => el(key);

function applyDefaults() {
  for (const [key, kind] of Object.entries(CONTROLS)) {
    const input = controlFor(key);
    if (kind === 'checkbox') input.checked = DEFAULTS[key];
    else input.value = DEFAULTS[key];
  }
}

/** Current settings, falling back to the default for anything unparseable. */
function readOptions() {
  const opts = {};
  for (const [key, kind] of Object.entries(CONTROLS)) {
    const input = controlFor(key);
    if (kind === 'checkbox') {
      opts[key] = input.checked;
    } else {
      const n = Number(input.value);
      opts[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS[key];
    }
  }
  return opts;
}

/** Shows how far the current settings have drifted from the defaults. */
function renderOptionState(opts) {
  const changed = Object.keys(CONTROLS).filter((k) => opts[k] !== DEFAULTS[k]).length;
  optionsBadge.hidden = changed === 0;
  optionsBadge.textContent = `${changed} changed`;

  const n = opts.lengthsPerLap;
  assumption.innerHTML =
    n === 1
      ? '⚠️ <strong>This assumes one lap button press per pool length.</strong> Every lap is ' +
        'merged down to a single length. If you lap once per interval instead — or not at all, ' +
        'letting auto-pause do the work — that throws away real distance. Change it under ' +
        'Assumptions, and check the numbers before you trust the file.'
      : `⚠️ <strong>This assumes ${n} pool lengths per lap button press.</strong> Laps holding ` +
        `more than ${n} lengths are merged down to ${n}; laps with fewer are left alone. ` +
        'Check the numbers before you trust the file.';
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
  const previous = changed ? `<span class="stat-was">${was}${unit ?? ''}</span>` : '';
  return `
    <div class="stat${changed ? ' changed' : ''}">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}${unit ?? ''}${previous}</div>
    </div>`;
}

function render() {
  const { info, summary } = state.output;

  // What the watch claimed, reconstructed from the pre-merge length counts.
  const lengthsBefore = info.swimLaps.reduce((a, l) => a + l.lengths, 0);
  const distanceBefore = lengthsBefore * info.poolM;

  statsEl.innerHTML = [
    statCard({ label: 'Distance', value: summary.distanceM, was: distanceBefore, unit: ' m' }),
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
      const lap = f.lap === undefined ? '' : `<span class="finding-lap">lap ${f.lap + 1}</span>`;
      return `
        <li class="finding ${meta.tone}">
          <span class="finding-icon" aria-hidden="true">${meta.icon}</span>
          <div>
            <div class="finding-head"><span class="finding-name">${meta.name}</span>${lap}</div>
            <div class="finding-detail">${meta.detail(f)}</div>
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
  renderOptionState(opts);
  try {
    state.output = repair(state.input, opts);
    errorBox.hidden = true;
    result.hidden = false;
    dropzone.hidden = true;
    sampleLine.hidden = true;
    render();
  } catch (err) {
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
    removedList.innerHTML = state.anonymized.removed.map((r) => `<li>${r}</li>`).join('');
    share.hidden = false;
  } catch {
    // Too damaged to parse; nothing useful to hand over.
    state.anonymized = null;
    share.hidden = true;
  }
}

function loadBytes(name, label, bytes) {
  state.name = name;
  filenameEl.textContent = label;
  state.input = bytes;
  runRepair();
  prepareShare();
}

async function loadFile(file) {
  if (!file) return;
  try {
    loadBytes(file.name, file.name, new Uint8Array(await file.arrayBuffer()));
  } catch {
    showError('the file could not be opened');
  }
}

/** A scrubbed real session, so the tool can be tried without your own data. */
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
  a.download = `${state.name.replace(/\.fit$/i, '')}${suffix}.fit`;
  a.click();
  URL.revokeObjectURL(url);
}

function reset() {
  state.name = null;
  state.input = null;
  state.output = null;
  state.anonymized = null;
  picker.value = '';
  result.hidden = true;
  errorBox.hidden = true;
  share.hidden = true;
  dropzone.hidden = false;
  sampleLine.hidden = false;
}

// ------------------------------------------------------------------- events
picker.addEventListener('change', () => loadFile(picker.files[0]));

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('dragging'));
}
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

// The whole page is a drop target, so a near miss does not open the file in
// the browser and lose the user's work.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

for (const key of Object.keys(CONTROLS)) {
  // `input` rather than `change` so typing a number re-runs immediately; the
  // repair is a few milliseconds on a 100 kB file.
  controlFor(key).addEventListener('input', () => {
    if (state.input) runRepair();
    else renderOptionState(readOptions());
  });
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
