/**
 * Browser front end. Nothing here talks to a network -- the file is read
 * locally, repaired in memory and handed back as a Blob.
 */
import { anonymize } from './lib/anonymize.js';
import { DEFAULTS, repair } from './lib/swim-repair.js';
import { fitEntries, isZip, readEntry } from './lib/unzip.js';

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
const chooser = el('chooser');
const chooserTitle = el('chooserTitle');
const chooserList = el('chooserList');
const working = el('working');
const workingBadge = el('workingBadge');
const workingUnit = el('workingUnit');
const workingRows = el('workingRows');

/** Loaded file, the most recent repair output, and the anonymized copy. */
const state = { name: null, input: null, output: null, anonymized: null };

/**
 * Escapes text destined for innerHTML.
 *
 * The archive chooser interpolates entry names, which come out of an uploaded
 * zip and are therefore fully attacker-controlled: a file named
 * `<img src=x onerror=...>.fit` is a legal zip entry. That is the only such
 * value today. Everything else is a number or a key from a frozen table, and
 * only because getField() happens to return a byte rather than text for FIT
 * string fields -- an accident of another module, undocumented, and one
 * `getStringField()` helper away from turning every template below into a
 * stored-XSS sink fed by an uploaded file. Escaping at the sink costs nothing
 * and does not depend on remembering.
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
  'uncertain-lengths': {
    icon: '🤔',
    name: 'Two readings are possible',
    tone: 'danger',
    detail: (f) => f.note,
  },
};

/** Things that make the whole result untrustworthy sort to the top. */
const TOP = new Set(['lap-structure', 'uncertain-lengths']);
const findingOrder = (f) => (TOP.has(f.type) ? 0 : 1);

/**
 * Every assumption in DEFAULTS, wired to a control. Keys match DEFAULTS so the
 * reset and the "changed" badge stay honest without a second list. The bounds
 * mirror the HTML min/max, and are enforced here too: the browser's are
 * advisory, so a typed 99999 used to be applied while the banner cheerfully
 * reported it.
 */
const CONTROLS = {
  // `blank: null` means an empty field is a real value -- for the pool size,
  // "trust the file". `auto` accepts the literal string.
  poolLength: { kind: 'number', min: 4, max: 100, blank: null },
  lengthsPerLap: { kind: 'number', min: 1, max: 64, auto: true },
  strokeSplit: { kind: 'number', min: 1, max: 500, auto: true },
  durationSplit: { kind: 'number', min: 1, max: 900, auto: true },
  reclassifyStroke: { kind: 'checkbox' },
  normalizeElapsed: { kind: 'checkbox' },
};

const controlFor = (key) => el(key);

function applyDefaults() {
  for (const [key, spec] of Object.entries(CONTROLS)) {
    const input = controlFor(key);
    if (spec.kind === 'checkbox') input.checked = DEFAULTS[key];
    // A null default is "unset", which is an empty field, not the text "null".
    else input.value = DEFAULTS[key] === null ? '' : DEFAULTS[key];
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
    if ('blank' in spec && text === '') {
      opts[key] = spec.blank;
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

  // Before the findings, which return early when there are none -- and a swim
  // with nothing wrong in it is still one whose working someone may want to see.
  renderWorking(info);

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

/**
 * The per-lap breakdown under "Show the working": what the watch recorded,
 * what the repair leaves, and every recorded length on its own.
 *
 * Everything here comes from analyze(), and the lap targets are the ones
 * repair() is handed rather than recomputed, so the table cannot promise a
 * distance the file does not get -- working.test.mjs holds the two to the same
 * total. The open/closed state is left alone across re-renders: changing an
 * assumption re-runs the repair, and snapping the panel shut each time would
 * hide the very rows the change was meant to affect.
 */
function renderWorking(info) {
  const laps = info.swimLaps;
  working.hidden = !laps.length;
  if (!laps.length) return;

  const merged = laps.filter((l) => l.lengths > l.target).length;
  workingBadge.textContent = merged
    ? `${merged} lap${merged === 1 ? '' : 's'} merged`
    : `${laps.length} laps, none merged`;

  if (info.lengthUnitS) {
    workingUnit.textContent =
      `One length in this swim reads as about ${Math.round(info.lengthUnitS)} seconds. ` +
      'Two short lengths that add up to about one look like a turn the watch imagined, ' +
      'and are merged; lengths that are each about one look real, and are kept. That is ' +
      'the rule, not proof — check it against what you remember swimming.';
  } else if (info.autoLengths) {
    workingUnit.textContent =
      'This file has no usable length durations to measure a length against, so ' +
      'each lap is treated as a single length. If that is wrong, set a number under ' +
      'Assumptions.';
  } else {
    workingUnit.textContent =
      'Lengths per lap is set to a fixed number under Assumptions, so each lap is ' +
      'cut to that many rather than measured.';
  }

  workingRows.innerHTML = laps
    .map((l) => {
      const isMerged = l.lengths > l.target;
      // Each duration unbreakable, so a narrow screen wraps at the "+" and never
      // strands the unit: "95" on one line and "s" on the next was the result.
      const seen = l.lengthsS
        .map((s) =>
          // A length the watch never timed is "—", not a confident "0 s".
          s === null
            ? '<span class="dur" title="no duration recorded">—</span>'
            : `<span class="dur">${esc(Math.round(s))} s</span>`,
        )
        .join(' + ');
      return `
        <tr class="${isMerged ? 'is-merged' : ''}">
          <td class="num">${esc(l.lap + 1)}</td>
          <td class="num">${esc(l.lengths)}</td>
          <td class="num">${isMerged ? '<span aria-hidden="true">→ </span>' : ''}${esc(l.target)}</td>
          <td class="seen">${seen}${isMerged ? ' <span class="working-tag">merged</span>' : ''}</td>
        </tr>`;
    })
    .join('');
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
  chooser.hidden = true;
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
  // A new swim starts closed. Only re-runs of the same file keep it open.
  working.open = false;
  state.name = name;
  filenameEl.textContent = label;
  state.input = bytes;
  withBusy(() => {
    runRepair();
    prepareShare();
  });
}

/**
 * Refused before the file is read into memory.
 *
 * A pool swim is tens of kilobytes, but "the zip Garmin gave me" is now a
 * thing people will drop here, and a full account export runs to hundreds of
 * megabytes. Reading one in through arrayBuffer() kills the tab with no
 * message at all, which looks exactly like the page being broken.
 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** The last path component, for naming the download after the file inside. */
const stem = (path) => path.split('/').pop();

async function loadFile(files) {
  const list = files ? [...files] : [];
  if (!list.length) {
    showError('no file was dropped — try picking one instead');
    return;
  }
  const [file, ...rest] = list;
  if (file.size > MAX_UPLOAD_BYTES) {
    showError(`${file.name} is ${Math.round(file.size / 1e6)} MB, which is too big to open here`);
    return;
  }
  const extra = rest.length ? ` (${rest.length} more ignored)` : '';
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    showError('the file could not be opened — a folder, perhaps?');
    return;
  }
  if (isZip(bytes)) {
    await loadArchive(file.name, bytes, extra);
    return;
  }
  loadBytes(file.name, `${file.name}${extra}`, bytes);
}

/**
 * Opens the .fit inside a zip -- what "Export Original" on Garmin Connect
 * downloads, and what most people have in hand.
 *
 * One .fit is opened straight away; several are offered as a list, because the
 * one-per-archive case is an activity export and the many-per-archive case is
 * a full account export, where guessing means silently repairing a swim from
 * some other year.
 */
async function loadArchive(zipName, bytes, extra) {
  let entries;
  try {
    entries = fitEntries(bytes);
  } catch (err) {
    showError(err.message);
    return;
  }

  if (!entries.length) {
    showError(`there is no .fit file inside ${zipName}`);
    return;
  }
  if (entries.length === 1) {
    await openEntry(zipName, bytes, entries[0], extra);
    return;
  }

  chooserTitle.textContent = `${zipName} holds ${entries.length} activity files. Which one?`;
  chooserList.innerHTML = entries
    .map(
      (e, i) =>
        `<li><button class="chooser-pick" type="button" data-index="${i}">
           <span class="chooser-name">${esc(e.name)}</span>
           <span class="chooser-size">${Math.max(1, Math.round(e.size / 1024))} kB</span>
         </button></li>`,
    )
    .join('');
  // The bytes have to outlive this function -- the pick happens whenever the
  // reader gets round to it.
  chooserList.onclick = (event) => {
    const button = event.target.closest('.chooser-pick');
    if (button) openEntry(zipName, bytes, entries[Number(button.dataset.index)], extra);
  };

  errorBox.hidden = true;
  result.hidden = true;
  dropzone.hidden = true;
  sampleLine.hidden = true;
  chooser.hidden = false;
}

async function openEntry(zipName, zipBytes, entry, extra = '') {
  chooser.hidden = true;
  let fit;
  try {
    fit = await readEntry(zipBytes, entry);
  } catch (err) {
    showError(err.message);
    return;
  }
  // Named after the file that came out, not the archive it came in: an archive
  // may hold several, and naming all their outputs after it would collide.
  const name = stem(entry.name);
  loadBytes(name, `${name} — from ${zipName}${extra}`, fit);
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
  chooserList.innerHTML = '';
  workingRows.innerHTML = '';
  // Closed again for the next file: its working is a different swim's.
  working.open = false;
  working.hidden = true;
  result.hidden = true;
  errorBox.hidden = true;
  share.hidden = true;
  busy.hidden = true;
  chooser.hidden = true;
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
el('chooserReset').addEventListener('click', reset);
el('sample').addEventListener('click', loadSample);

applyDefaults();
renderOptionState(readOptions());

// ?demo loads the sample straight away -- handy for screenshots and for
// checking a deploy without dragging a file in.
if (new URLSearchParams(location.search).has('demo')) loadSample();
