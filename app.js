import { DEFAULT_TEMPLATE, fileBaseName, moneyPlain, moneyText, parseAmountInput, parseReceipt } from './parser.js';
import * as db from './store.js';
import { jpegsToPdf, linesFromJpeg, linesFromPdf, pdfPreview, scanImageFile } from './documents.js';
import { adjustCrop } from './crop-editor.js';

const CURRENCIES = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK', 'CHF', 'ISK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY', 'THB'];
const KIND_TITLE = { inrikes: 'Inrikes', utrikes: 'Utrikes' };
const SETTINGS = { template: 'kvitton:template', hintDismissed: 'kvitton:hintDismissed' };

const app = document.getElementById('app');
const scanInput = document.getElementById('scan-input');
const importInput = document.getElementById('import-input');
const pageInput = document.getElementById('page-input');
const tripDialog = document.getElementById('trip-dialog');
const settingsDialog = document.getElementById('settings-dialog');

let trips = [];
let receipts = [];
let previewUrls = [];
let pendingShare = null;
let toastTimer;
let ocrQueue = Promise.resolve();

// MARK: Small helpers

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing: the setting just lasts for this visit.
  }
}

const template = () => setting(SETTINGS.template, DEFAULT_TEMPLATE);
const tripOf = (receipt) => trips.find((trip) => trip.id === receipt.tripId);
const receiptsOf = (tripId) => receipts.filter((receipt) => receipt.tripId === tripId);
const byDate = (a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.addedAt - a.addedAt;

function totals(list) {
  const sums = new Map();
  for (const receipt of list) {
    if (receipt.amountMinor === null) continue;
    sums.set(receipt.currency, (sums.get(receipt.currency) ?? 0) + receipt.amountMinor);
  }
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const totalsText = (list) => totals(list).map(([currency, minor]) => `${moneyText(minor)} ${currency}`).join(' + ');

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 2500);
}

function fileNameFor(receipt, taken = new Set()) {
  const trip = tripOf(receipt);
  const base = fileBaseName(template(), { ...receipt, tripName: trip?.name, tripKind: trip?.kind });
  let name = `${base}.pdf`;
  for (let counter = 2; taken.has(name); counter += 1) name = `${base}-${counter}.pdf`;
  taken.add(name);
  return name;
}

// MARK: Adding receipts

function enqueueRead(receipt) {
  ocrQueue = ocrQueue.then(() => readReceipt(receipt.id)).catch((error) => console.error(error));
}

async function readReceipt(id) {
  const receipt = receipts.find((r) => r.id === id);
  if (!receipt) return;
  const file = await db.getFile(id);
  let lines = [];
  try {
    if (file.pdf) {
      lines = await linesFromPdf(file.pdf);
    } else {
      for (const page of file.pages.slice(receipt.linesFromPages ?? 0)) lines = lines.concat(await linesFromJpeg(page));
      lines = (receipt.lines ?? []).concat(lines);
    }
  } catch (error) {
    console.error(error);
  }
  applyParsed(receipt, lines);
  receipt.linesFromPages = file.pages?.length ?? 0;
  receipt.lines = lines;
  receipt.processing = false;
  await db.put('receipts', receipt);
  refreshAfterRead(id);
}

function applyParsed(receipt, lines) {
  const trip = tripOf(receipt);
  const parsed = parseReceipt(lines, { tripCurrency: trip?.currency ?? 'SEK' });
  receipt.date = parsed.date;
  receipt.merchant = parsed.merchant ?? '';
  receipt.amountMinor = parsed.amountMinor;
  receipt.currency = parsed.currency;
  receipt.needsReview = !parsed.amountIsConfident || !parsed.date || !parsed.merchant;
}

function newReceipt(tripId) {
  const trip = trips.find((t) => t.id === tripId);
  return {
    id: crypto.randomUUID(),
    tripId,
    date: null,
    merchant: '',
    amountMinor: null,
    currency: trip?.currency ?? 'SEK',
    needsReview: true,
    submitted: false,
    processing: true,
    addedAt: Date.now(),
  };
}

async function addFiles(fileList, tripId) {
  if (fileList.length) toast('Rätar ut kvittot…');
  for (const file of fileList) {
    try {
      const receipt = newReceipt(tripId);
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const pdf = await file.arrayBuffer();
        await db.addReceipt(receipt, { id: receipt.id, pdf, preview: await pdfPreview(pdf) });
      } else {
        const scan = await scanImageFile(file);
        await db.addReceipt(receipt, {
          id: receipt.id,
          pages: [scan.page],
          originals: [scan.original],
          corners: [scan.corners],
          preview: scan.page,
        });
      }
      receipts.push(receipt);
      enqueueRead(receipt);
    } catch (error) {
      console.error(error);
      toast(`Kunde inte läsa ${file.name}`);
    }
  }
  try {
    navigator.storage?.persist?.();
  } catch {
    // Only a request; the app works without it.
  }
  render();
}

async function addPage(receiptId, file) {
  const receipt = receipts.find((r) => r.id === receiptId);
  const stored = await db.getFile(receiptId);
  toast('Rätar ut kvittot…');
  const scan = await scanImageFile(file);
  const index = stored.pages.push(scan.page) - 1;
  // Receipts saved before cropping existed have neither list.
  (stored.originals ??= [])[index] = scan.original;
  (stored.corners ??= [])[index] = scan.corners;
  await db.putFile(stored);
  // The total may be on the new page, unless the user has already corrected the fields.
  if (receipt.needsReview) {
    receipt.processing = true;
    await db.put('receipts', receipt);
    enqueueRead(receipt);
  }
  toast(`Sidan är tillagd. Kvittot har nu ${stored.pages.length} sidor.`);
  render();
}

async function cropPage(receiptId, index) {
  const receipt = receipts.find((r) => r.id === receiptId);
  const stored = await db.getFile(receiptId);
  const original = stored.originals?.[index] ?? stored.pages[index];
  const result = await adjustCrop(original, stored.corners?.[index]);
  if (!result) return;
  stored.pages[index] = result.page;
  if (index === 0) stored.preview = result.page;
  (stored.originals ??= [])[index] = result.original ?? original;
  (stored.corners ??= [])[index] = result.corners;
  await db.putFile(stored);
  // A better crop may read better, unless the user has already corrected the fields.
  if (receipt.needsReview) {
    receipt.processing = true;
    receipt.lines = [];
    receipt.linesFromPages = 0;
    await db.put('receipts', receipt);
    enqueueRead(receipt);
  }
  render();
}

function refreshAfterRead(id) {
  // Never replace the form while someone is typing in another receipt.
  const route = parseRoute();
  if (route.view !== 'receipt' || route.id === id) render();
}

// MARK: Sharing

async function pdfFileFor(receipt, taken) {
  const stored = await db.getFile(receipt.id);
  const bytes = stored.pdf ?? jpegsToPdf(stored.pages);
  return new File([bytes], fileNameFor(receipt, taken), { type: 'application/pdf' });
}

async function share(list, title) {
  const taken = new Set();
  const files = [];
  for (const receipt of list) files.push(await pdfFileFor(receipt, taken));
  try {
    if (navigator.canShare?.({ files })) {
      await navigator.share({ files, title });
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (error.name !== 'NotAllowedError') throw error;
    // Safari only opens the share sheet straight after a tap, and building the files took too long: ask for one more.
    pendingShare = { files, title };
    render();
    return;
  }
  for (const file of files) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }
  toast(files.length === 1 ? 'Filen har laddats ner' : `${files.length} filer har laddats ner`);
}

function summaryText(trip) {
  const list = receiptsOf(trip.id).sort(byDate).reverse();
  const rows = list.map((r) => [r.date ?? 'datum saknas', r.merchant || 'okänd butik',
    r.amountMinor === null ? 'summa saknas' : `${moneyText(r.amountMinor)} ${r.currency}`].join('  '));
  return [`${trip.name} (${trip.kind})`, ...rows, `Summa: ${totalsText(list)}`].join('\n');
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Det gick inte att kopiera');
  }
}

// MARK: Views

function parseRoute() {
  const [, view, id] = location.hash.match(/^#\/(resa|kvitto)\/([\w-]+)/) ?? [];
  if (view === 'resa') return { view: 'trip', id };
  if (view === 'kvitto') return { view: 'receipt', id };
  return { view: 'home' };
}

function render() {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
  const route = parseRoute();
  if (route.view === 'trip' && trips.some((t) => t.id === route.id)) renderTrip(route.id);
  else if (route.view === 'receipt' && receipts.some((r) => r.id === route.id)) renderReceipt(route.id);
  else renderHome();
  window.scrollTo(0, 0);
}

const topBar = (right) => `
  <div class="e-top">
    <span class="e-mark"><a href="/">ekert</a> / <a href="#/">Kvitton</a></span>
    ${right}
  </div>`;

function renderHome() {
  document.title = 'Kvitton';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const showHint = !standalone && setting(SETTINGS.hintDismissed, '') !== '1';
  const section = (kind) => {
    const list = trips.filter((t) => t.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
    if (!list.length) return '';
    return `<section class="e-section"><h2>${KIND_TITLE[kind]}</h2>
      <ul class="e-list">${list.map(tripRow).join('')}</ul></section>`;
  };
  app.innerHTML = `<div class="e-page">
    ${topBar('<button class="k-link" data-action="settings">Inställningar</button>')}
    <main class="k-content">
      ${showHint ? `<div>
        <p>Välj <strong>Dela → Lägg till på hemskärmen</strong> i Safari. Då öppnas appen som en vanlig app och
        kvittona sparas säkrare.</p>
        <button class="k-link" data-action="dismiss-hint">Okej</button></div>` : ''}
      ${trips.length ? '' : `<div class="k-heading"><h1>Inga resor än</h1>
        <p class="e-muted">Skapa en resa och skanna kvittona allt eftersom. Appen läser av datum, butik och summa.</p></div>`}
      ${section('inrikes')}${section('utrikes')}
    </main>
    <footer class="k-actions"><button class="e-button" data-action="new-trip">Ny resa</button></footer>
  </div>`;
}

function tripRow(trip) {
  const list = receiptsOf(trip.id);
  const open = list.filter((r) => !r.submitted);
  const status = !list.length ? 'Inga kvitton'
    : open.length ? `${open.length} att skicka in` : 'Allt inskickat';
  return `<li><a class="e-row k-row" href="#/resa/${trip.id}">
    <span class="k-row-main">
      <span class="k-row-title">${esc(trip.name)}</span>
      <span class="e-muted">${status}</span>
      ${list.length ? `<span>${esc(totalsText(open.length ? open : list))}</span>` : ''}
    </span></a></li>`;
}

function renderTrip(id) {
  const trip = trips.find((t) => t.id === id);
  document.title = `${trip.name} – Kvitton`;
  const list = receiptsOf(id).sort(byDate);
  const open = list.filter((r) => !r.submitted);
  const done = list.filter((r) => r.submitted);
  const ready = open.filter((r) => !r.processing);
  const group = (title, items) => (items.length
    ? `<section class="e-section"><h2>${title}</h2><ul class="e-list">${items.map(receiptRow).join('')}</ul></section>` : '');
  const kindText = trip.kind === 'utrikes' ? `Utrikes, ${esc(trip.currency)}` : 'Inrikes';
  app.innerHTML = `<div class="e-page">
    ${topBar('<button class="k-link" data-action="edit-trip">Ändra resa</button>')}
    <main class="k-content">
      <div class="k-heading"><h1>${esc(trip.name)}</h1><p class="e-muted">${kindText}</p></div>
      ${list.length ? '' : '<p class="e-muted">Inga kvitton än. Lägg kvittot på ett mörkt underlag när du fotograferar, så hittar appen kanterna lättast. Appen rätar ut och beskär bilden.</p>'}
      ${group('Att skicka in', open)}${group('Inskickade', done)}
      <div class="k-tools">
        ${list.length ? '<button class="k-link" data-action="copy-summary">Kopiera sammanställning</button>' : ''}
        ${open.length ? '<button class="k-link" data-action="mark-all">Markera alla som inskickade</button>' : ''}
        <button class="k-link" data-action="import">Importera PDF eller bild</button>
      </div>
    </main>
    <footer class="k-actions">
      ${open.length ? `<div class="k-sum"><span class="e-muted">Summa</span><strong>${esc(totalsText(open)) || '–'}</strong></div>` : ''}
      ${pendingShare ? '<button class="k-secondary" data-action="finish-share">Öppna delning</button>' : ''}
      <div class="k-button-row">
        <button class="e-button" data-action="scan">Skanna kvitto</button>
        ${ready.length ? `<button class="k-secondary" data-action="share-open">Dela ${ready.length}</button>` : ''}
      </div>
    </footer>
  </div>`;
}

function receiptRow(receipt) {
  if (receipt.processing) return '<li><div class="e-row e-muted" role="status">Läser kvittot…</div></li>';
  return `<li><a class="e-row k-row" href="#/kvitto/${receipt.id}">
    <span class="k-row-main">
      <span class="k-row-title">${esc(receipt.merchant || 'Okänd butik')}</span>
      <span class="e-muted">${esc(receipt.date ?? 'Datum saknas')}</span>
    </span>
    <span class="k-row-end">
      <span>${receipt.amountMinor === null ? 'Summa saknas' : `${moneyText(receipt.amountMinor)} ${esc(receipt.currency)}`}</span>
      ${receipt.needsReview ? '<span class="k-warning">Kontrollera</span>' : ''}
    </span></a></li>`;
}

async function renderReceipt(id) {
  const receipt = receipts.find((r) => r.id === id);
  const trip = tripOf(receipt);
  document.title = `${receipt.merchant || 'Kvitto'} – Kvitton`;
  const currencies = CURRENCIES.includes(receipt.currency) ? CURRENCIES : [receipt.currency, ...CURRENCIES];
  app.innerHTML = `<div class="e-page">
    ${topBar(`<a class="k-link" href="#/resa/${receipt.tripId}">Till resan</a>`)}
    <main class="k-content">
      <div class="k-heading"><h1>${esc(receipt.merchant || 'Kvitto')}</h1></div>
      ${receipt.processing ? '<p class="e-muted">Appen läser fortfarande kvittot. Vänta tills det är klart innan du ändrar.</p>' : ''}
      <div class="k-preview" id="preview"></div>
      <form class="k-form" id="receipt-form" autocomplete="off">
        <div class="e-field"><label for="r-merchant">Butik</label>
          <input id="r-merchant" name="merchant" value="${esc(receipt.merchant)}"></div>
        <div class="e-field"><label for="r-date">Datum</label>
          <input id="r-date" name="date" type="date" value="${esc(receipt.date ?? '')}"></div>
        <div class="e-field"><label for="r-amount">Summa</label>
          <div class="k-amount">
            <input id="r-amount" name="amount" inputmode="decimal" value="${receipt.amountMinor === null ? '' : moneyPlain(receipt.amountMinor)}">
            <button type="button" class="k-link" data-action="copy-amount">Kopiera</button>
          </div></div>
        <div class="e-field"><label for="r-currency">Valuta</label><select id="r-currency" name="currency">
          ${currencies.map((c) => `<option ${c === receipt.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="e-field"><label for="r-trip">Resa</label><select id="r-trip" name="trip">
          ${trips.map((t) => `<option value="${t.id}" ${t.id === trip?.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      </form>
      <section class="e-section">
        <h2>Filnamn</h2>
        <p class="e-muted k-file-name" id="file-name"></p>
      </section>
      <div class="k-tools">
        <button class="k-link" data-action="share-one" data-id="${id}">Dela PDF</button>
        <button class="k-link" data-action="toggle-submitted" data-id="${id}">${receipt.submitted ? 'Ångra inskickad' : 'Markera som inskickad'}</button>
        <button class="k-link" data-action="add-page" data-id="${id}" hidden id="add-page">Lägg till sida</button>
        <button class="k-link k-danger" data-action="delete-receipt" data-id="${id}">Radera kvittot</button>
      </div>
    </main>
    <footer class="k-actions"><button class="e-button" data-action="save-receipt" data-id="${id}">Spara</button></footer>
  </div>`;

  const form = document.getElementById('receipt-form');
  const updateName = () => {
    document.getElementById('file-name').textContent = fileNameFor({ ...receipt, ...readForm(form) });
  };
  form.addEventListener('input', updateName);
  form.addEventListener('submit', (event) => event.preventDefault());
  updateName();

  const stored = await db.getFile(id);
  const preview = document.getElementById('preview');
  if (!stored || !preview) return;
  const images = stored.pages ?? [stored.preview];
  preview.innerHTML = images.map((bytes, index) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    previewUrls.push(url);
    const label = images.length > 1 ? `Justera beskärning av sida ${index + 1}` : 'Justera beskärning';
    return `<div class="k-page">
      <img src="${url}" alt="Kvitto, sida ${index + 1}">
      ${stored.corners?.[index] === null ? '<span class="k-warning">Appen hittade inte kvittots kanter</span>' : ''}
      ${stored.pages ? `<button class="k-link" data-action="crop" data-id="${id}" data-page="${index}">${label}</button>` : ''}
    </div>`;
  }).join('');
  document.getElementById('add-page').hidden = !stored.pages;
}

function readForm(form) {
  const data = new FormData(form);
  return {
    merchant: data.get('merchant').trim(),
    date: data.get('date') || null,
    amountMinor: parseAmountInput(data.get('amount')),
    currency: data.get('currency'),
    tripId: data.get('trip'),
  };
}

// MARK: Dialogs

function openTripDialog(trip) {
  const form = tripDialog.querySelector('form');
  form.reset();
  form.elements.id.value = trip?.id ?? '';
  form.elements.name.value = trip?.name ?? '';
  form.elements.kind.value = trip?.kind ?? 'inrikes';
  form.elements.currency.value = trip?.currency ?? 'SEK';
  tripDialog.querySelector('h2').textContent = trip ? 'Ändra resa' : 'Ny resa';
  tripDialog.querySelector('[data-action="delete-trip"]').hidden = !trip;
  syncCurrencyField();
  tripDialog.showModal();
}

function syncCurrencyField() {
  const form = tripDialog.querySelector('form');
  const foreign = form.elements.kind.value === 'utrikes';
  tripDialog.querySelector('.currency-field').hidden = !foreign;
  if (!foreign) form.elements.currency.value = 'SEK';
}

async function saveTrip(form) {
  const id = form.elements.id.value;
  const name = form.elements.name.value.trim();
  if (!name) return;
  const existing = trips.find((t) => t.id === id);
  const trip = existing ?? { id: crypto.randomUUID(), createdAt: Date.now() };
  Object.assign(trip, { name, kind: form.elements.kind.value, currency: form.elements.currency.value });
  if (!existing) trips.push(trip);
  await db.put('trips', trip);
  tripDialog.close();
  if (existing) render();
  else location.hash = `#/resa/${trip.id}`;
}

// MARK: Actions

const actions = {
  'new-trip': () => openTripDialog(),
  'edit-trip': () => openTripDialog(trips.find((t) => t.id === parseRoute().id)),
  'close-dialog': (element) => element.closest('dialog').close(),
  'delete-trip': async () => {
    const trip = trips.find((t) => t.id === tripDialog.querySelector('form').elements.id.value);
    const list = receiptsOf(trip.id);
    const warning = list.length ? ` och dess ${list.length} kvitton` : '';
    if (!confirm(`Radera ${trip.name}${warning}? Det går inte att ångra.`)) return;
    await db.deleteTrip(trip.id, list.map((r) => r.id));
    trips = trips.filter((t) => t.id !== trip.id);
    receipts = receipts.filter((r) => r.tripId !== trip.id);
    tripDialog.close();
    location.hash = '#/';
  },
  settings: () => {
    settingsDialog.querySelector('input').value = template();
    updateTemplatePreview();
    settingsDialog.showModal();
  },
  'save-settings': () => {
    saveSetting(SETTINGS.template, settingsDialog.querySelector('input').value.trim() || DEFAULT_TEMPLATE);
    settingsDialog.close();
    render();
  },
  'dismiss-hint': () => {
    saveSetting(SETTINGS.hintDismissed, '1');
    render();
  },
  scan: () => scanInput.click(),
  import: () => importInput.click(),
  'add-page': (element) => {
    pageInput.dataset.id = element.dataset.id;
    pageInput.click();
  },
  crop: async (element) => {
    const saved = await saveReceiptForm(element.dataset.id, document.getElementById('receipt-form'));
    if (saved) await cropPage(element.dataset.id, Number(element.dataset.page));
  },
  'share-open': async () => {
    const trip = trips.find((t) => t.id === parseRoute().id);
    await share(receiptsOf(trip.id).filter((r) => !r.submitted && !r.processing).sort(byDate), `Kvitton ${trip.name}`);
  },
  'finish-share': async () => {
    const { files, title } = pendingShare;
    pendingShare = null;
    render();
    try {
      await navigator.share({ files, title });
    } catch (error) {
      if (error.name !== 'AbortError') toast('Delningen misslyckades');
    }
  },
  'share-one': async (element) => {
    const form = document.getElementById('receipt-form');
    await saveReceiptForm(element.dataset.id, form);
    const receipt = receipts.find((r) => r.id === element.dataset.id);
    await share([receipt], 'Kvitto');
  },
  'copy-summary': () => copy(summaryText(trips.find((t) => t.id === parseRoute().id)), 'Sammanställningen är kopierad'),
  'copy-amount': () => {
    const amount = parseAmountInput(document.getElementById('receipt-form').elements.amount.value);
    if (amount === null) toast('Summan går inte att läsa');
    else copy(moneyPlain(amount), 'Summan är kopierad');
  },
  'mark-all': async () => {
    for (const receipt of receiptsOf(parseRoute().id)) {
      if (!receipt.processing && !receipt.submitted) {
        receipt.submitted = true;
        await db.put('receipts', receipt);
      }
    }
    render();
  },
  'toggle-submitted': async (element) => {
    const receipt = receipts.find((r) => r.id === element.dataset.id);
    await saveReceiptForm(receipt.id, document.getElementById('receipt-form'));
    receipt.submitted = !receipt.submitted;
    await db.put('receipts', receipt);
    location.hash = `#/resa/${receipt.tripId}`;
  },
  'save-receipt': async (element) => {
    const receipt = receipts.find((r) => r.id === element.dataset.id);
    const saved = await saveReceiptForm(receipt.id, document.getElementById('receipt-form'));
    if (saved) location.hash = `#/resa/${receipt.tripId}`;
  },
  'delete-receipt': async (element) => {
    const receipt = receipts.find((r) => r.id === element.dataset.id);
    if (!confirm('Radera kvittot? Det går inte att ångra.')) return;
    await db.deleteReceipts([receipt.id]);
    receipts = receipts.filter((r) => r.id !== receipt.id);
    location.hash = `#/resa/${receipt.tripId}`;
  },
};

async function saveReceiptForm(id, form) {
  const receipt = receipts.find((r) => r.id === id);
  const amountText = form.elements.amount.value;
  const values = readForm(form);
  if (amountText.trim() && values.amountMinor === null) {
    toast('Summan går inte att läsa. Skriv till exempel 245,50.');
    form.elements.amount.focus();
    return false;
  }
  Object.assign(receipt, values);
  // Saving means a person has looked at it, unless a field is still empty.
  receipt.needsReview = receipt.amountMinor === null || !receipt.date || !receipt.merchant;
  await db.put('receipts', receipt);
  return true;
}

function updateTemplatePreview() {
  const value = settingsDialog.querySelector('input').value.trim() || DEFAULT_TEMPLATE;
  settingsDialog.querySelector('.k-file-name').textContent = `${fileBaseName(value, {
    date: '2026-10-12', merchant: 'Scandic Malmen', amountMinor: 124550, currency: 'SEK',
    tripName: 'Oslo', tripKind: 'utrikes',
  })}.pdf`;
}

document.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  event.preventDefault();
  Promise.resolve(actions[element.dataset.action]?.(element)).catch((error) => {
    console.error(error);
    toast('Något gick fel. Försök igen.');
  });
});

scanInput.addEventListener('change', () => {
  addFiles([...scanInput.files], parseRoute().id);
  scanInput.value = '';
});
importInput.addEventListener('change', () => {
  addFiles([...importInput.files], parseRoute().id);
  importInput.value = '';
});
pageInput.addEventListener('change', () => {
  if (pageInput.files[0]) addPage(pageInput.dataset.id, pageInput.files[0]);
  pageInput.value = '';
});
tripDialog.querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  saveTrip(event.target);
});
tripDialog.querySelector('form').elements.kind.forEach((radio) => radio.addEventListener('change', syncCurrencyField));
settingsDialog.querySelector('input').addEventListener('input', updateTemplatePreview);
window.addEventListener('hashchange', () => {
  pendingShare = null;
  render();
});

const currencySelect = tripDialog.querySelector('select[name="currency"]');
currencySelect.innerHTML = CURRENCIES.map((c) => `<option>${c}</option>`).join('');

async function start() {
  try {
    [trips, receipts] = await Promise.all([db.getAll('trips'), db.getAll('receipts')]);
  } catch (error) {
    console.error(error);
    app.innerHTML = `<main class="e-page"><div class="k-heading"><h1>Kvittona kan inte sparas här</h1>
      <p class="e-muted">Webbläsaren tillåter inte lagring, till exempel i privat läge. Öppna appen i ett vanligt Safari-fönster.</p></div></main>`;
    return;
  }
  render();
  // Reads that were interrupted when the app was closed start over.
  for (const receipt of receipts) {
    if (receipt.processing) enqueueRead(receipt);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((error) => console.warn(error));
  }
}

start();
