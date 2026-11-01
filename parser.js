// Pure text parsing: takes OCR lines, top to bottom, and guesses the receipt's fields.
// Amounts are integers in öre/cents, dates are "YYYY-MM-DD" strings.

const KEYWORDS_BY_PRIORITY = [
  [3, ['att betala', 'att erlägga', 'amount due', 'balance due', 'total due', 'grand total',
       'amount paid', 'zu zahlen', 'à payer', 'a payer', 'betalat', 'betalt']],
  [2, ['totalt', 'total', 'totalsumma', 'slutsumma', 'gesamt', 'gesamtbetrag', 'totale', 'summe']],
  [1, ['summa', 'sum', 'belopp', 'amount', 'kortbetalning', 'kortköp', 'köp']],
];
const EXCLUDED_WORDS = ['subtotal', 'sub total', 'sub-total', 'delsumma', 'mellansumma', 'netto', 'net', 'exkl',
                        'excl', 'rabatt', 'discount', 'växel', 'change', 'tips', 'dricks', 'antal', 'poäng',
                        'points', 'bonus', 'besparing', 'sparat'];
const TAX_WORDS = ['moms', 'vat', 'tax', 'mwst', 'tva'];
const INCLUDES_TAX_WORDS = ['inkl', 'incl', 'inc'];
const NOISE_WORDS = ['tel', 'telefon', 'org', 'orgnr', 'org.nr', 'kvitto', 'kvittonr', 'receipt', 'kort', 'card',
                     'ref', 'terminal', 'kassa', 'kontant', 'mottaget', 'erhållet', 'cash', 'swish', 'bankgiro'];
const NOT_MERCHANT_WORDS = ['kvitto', 'receipt', 'faktura', 'invoice', 'org', 'orgnr', 'org.nr', 'tel', 'telefon',
                            'phone', 'www', 'datum', 'date', 'välkommen', 'welcome', 'kopia', 'copy', 'moms', 'vat'];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10,
                 nov: 11, dec: 12 };

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function containsWord(text, words) {
  return words.some((word) => new RegExp(`(?<![\\p{L}\\d])${escapeRegex(word)}(?![\\p{L}])`, 'u').test(text));
}

function isExcluded(lower) {
  if (containsWord(lower, EXCLUDED_WORDS)) return true;
  return containsWord(lower, TAX_WORDS) && !containsWord(lower, INCLUDES_TAX_WORDS);
}

function keywordPriority(lower) {
  const found = KEYWORDS_BY_PRIORITY.find(([, words]) => containsWord(lower, words));
  return found ? found[0] : null;
}

function stripDatesAndTimes(line) {
  return line
    .replace(/\b\d{2,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');
}

/** All amounts on a line. Bare integers ("245") only count when allowed or next to a currency. */
export function amounts(line, allowBareIntegers) {
  // OCR often inserts a space around the decimal separator: "245, 00".
  const text = stripDatesAndTimes(line).replace(/(\d)\s?([.,])\s?(\d{2})(?!\d)/g, '$1$2$3');
  const pattern = /(?<![\d.,])(\d{1,3}(?:[ .,]\d{3})+[.,]\d{2}|\d+[.,]\d{2}|\d{1,3}(?:[ .,]\d{3})+|\d+)(?!\d)/g;
  const decimals = [];
  const integers = [];
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const after = text.slice(match.index + token.length).toLowerCase();
    const before = text.slice(0, match.index).toLowerCase();
    const nextToCurrency = /^\s?(kr|sek|nok|dkk|eur|usd|gbp|chf|€|\$|£|:-)/.test(after)
      || /(€|\$|£|sek|eur|usd|gbp|nok|dkk|chf)\s?$/.test(before);
    const digits = token.replace(/\D/g, '');
    if (/[.,]\d{2}$/.test(token)) {
      decimals.push(Number(digits));
    } else if ((allowBareIntegers || nextToCurrency) && digits.length <= 7) {
      integers.push(Number(digits) * 100);
    }
  }
  return decimals.length ? decimals : integers;
}

function findTotal(lines) {
  let best = null;
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    const priority = keywordPriority(lower);
    if (priority === null || isExcluded(lower)) return;

    let amount = amounts(line, true).at(-1);
    let source = line;
    if (amount === undefined) {
      // OCR sometimes puts the amount on the row below its label.
      for (const next of lines.slice(index + 1, index + 3)) {
        if (isExcluded(next.toLowerCase())) continue;
        const found = amounts(next, false).at(-1);
        if (found !== undefined) {
          amount = found;
          source = next;
          break;
        }
      }
    }
    if (!amount) return;
    if (!best || priority > best.priority || (priority === best.priority && amount > best.amount)) {
      best = { priority, amount, line: source };
    }
  });
  if (best) return { amount: best.amount, confident: true, line: best.line };

  // No total line: the largest plausible amount is usually right, but flag it for review.
  let largest = null;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (isExcluded(lower) || containsWord(lower, NOISE_WORDS)) continue;
    const found = amounts(line, false);
    if (!found.length) continue;
    const max = Math.max(...found);
    if (max > (largest?.amount ?? 0)) largest = { amount: max, line };
  }
  return { amount: largest?.amount ?? null, confident: false, line: largest?.line ?? null };
}

function currencyIn(line, tripCurrency) {
  const lower = line.toLowerCase();
  if (lower.includes('€') || containsWord(lower, ['eur', 'euro'])) return 'EUR';
  if (lower.includes('£') || containsWord(lower, ['gbp'])) return 'GBP';
  if (containsWord(lower, ['usd'])) return 'USD';
  if (lower.includes('$')) return ['CAD', 'AUD'].includes(tripCurrency) ? tripCurrency : 'USD';
  if (containsWord(lower, ['nok'])) return 'NOK';
  if (containsWord(lower, ['dkk'])) return 'DKK';
  if (containsWord(lower, ['chf'])) return 'CHF';
  if (containsWord(lower, ['sek'])) return 'SEK';
  // "kr" also means Norwegian and Danish kronor, so the trip decides.
  if (containsWord(lower, ['kr']) || lower.includes(':-')) {
    return ['NOK', 'DKK', 'ISK'].includes(tripCurrency) ? tripCurrency : 'SEK';
  }
  return null;
}

function findCurrency(preferredLine, lines, tripCurrency) {
  for (const line of [preferredLine, ...lines]) {
    if (!line) continue;
    const found = currencyIn(line, tripCurrency);
    if (found) return found;
  }
  return tripCurrency;
}

function makeDate(year, month, day, today) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  // Rejects reference numbers that happen to look like dates.
  const earliest = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
  const latest = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (date < earliest || date > latest) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateIn(line, today, monthFirst) {
  const lower = line.toLowerCase();
  let m = lower.match(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (m) {
    const date = makeDate(+m[1], +m[2], +m[3], today);
    if (date) return date;
  }
  m = lower.match(/(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/);
  if (m) {
    const [day, month] = monthFirst ? [+m[2], +m[1]] : [+m[1], +m[2]];
    const date = makeDate(+m[3], month, day, today);
    if (date) return date;
  }
  m = lower.match(/(?<!\d)(\d{2})-(\d{2})-(\d{2})(?!\d)/);
  if (m) {
    const date = makeDate(2000 + +m[1], +m[2], +m[3], today);
    if (date) return date;
  }
  m = lower.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) {
    const date = makeDate(+m[1], +m[2], +m[3], today);
    if (date) return date;
  }
  // "12 okt 2026" and "Oct 12, 2026"
  const names = Object.keys(MONTHS).join('|');
  m = lower.match(new RegExp(`(?<!\\d)(\\d{1,2})\\.?\\s*(${names})[a-zåäö]*\\.?\\s*(\\d{4})`));
  if (m) {
    const date = makeDate(+m[3], MONTHS[m[2]], +m[1], today);
    if (date) return date;
  }
  m = lower.match(new RegExp(`(${names})[a-zåäö]*\\.?\\s*(\\d{1,2}),?\\s*(\\d{4})`));
  if (m) {
    const date = makeDate(+m[3], MONTHS[m[1]], +m[2], today);
    if (date) return date;
  }
  return null;
}

function findDate(lines, today, monthFirst) {
  for (const line of lines) {
    const date = dateIn(line, today, monthFirst);
    if (date) return date;
  }
  return null;
}

function findMerchant(lines) {
  for (const line of lines.slice(0, 8)) {
    const lower = line.toLowerCase();
    if (containsWord(lower, NOT_MERCHANT_WORDS) || lower.includes('http') || lower.includes('@')) continue;
    const letters = (line.match(/\p{L}/gu) ?? []).length;
    const digits = (line.match(/\d/g) ?? []).length;
    if (letters >= 3 && digits <= Math.floor(letters / 2)) return line;
  }
  return null;
}

/** tripCurrency is used when the receipt names no currency of its own. */
export function parseReceipt(rawLines, { today = new Date(), tripCurrency = 'SEK' } = {}) {
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  const total = findTotal(lines);
  const currency = findCurrency(total.line, lines, tripCurrency);
  return {
    date: findDate(lines, today, currency === 'USD'),
    merchant: findMerchant(lines),
    amountMinor: total.amount,
    currency,
    amountIsConfident: total.confident,
  };
}

/** Parses what the user typed in the amount field, e.g. "1 245,50". */
export function parseAmountInput(text) {
  const match = text.replace(/\s/g, '').match(/^(\d+(?:[.,]\d{3})*)(?:[.,](\d{1,2}))?$/);
  if (!match) return null;
  const whole = Number(match[1].replace(/\D/g, ''));
  const decimals = match[2] ? Number(match[2].padEnd(2, '0')) : 0;
  return whole * 100 + decimals;
}

export const DEFAULT_TEMPLATE = '{datum}_{butik}_{belopp}_{valuta}';

/** Plain ASCII, since expense systems often choke on å/ä/ö and spaces in uploads. */
export function sanitizeFileName(text) {
  return text
    .replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/ø/g, 'o').replace(/Ø/g, 'O')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 120);
}

export function fileBaseName(template, { date, merchant, amountMinor, currency, tripName = '', tripKind = '' }) {
  const amount = amountMinor === null || amountMinor === undefined
    ? 'okant-belopp'
    : `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, '0')}`;
  const values = {
    '{datum}': date || 'okant-datum',
    '{butik}': merchant || 'okand-butik',
    '{belopp}': amount,
    '{valuta}': currency,
    '{resa}': tripName,
    '{typ}': tripKind,
  };
  return sanitizeFileName(template.replace(/\{(datum|butik|belopp|valuta|resa|typ)\}/g, (key) => values[key]));
}

/** "1 245,50", the way Swedish expense forms want it. */
export function moneyText(minor) {
  const whole = String(Math.floor(minor / 100)).replace(/\B(?=(\d{3})+$)/g, ' ');
  return `${whole},${String(minor % 100).padStart(2, '0')}`;
}

/** Same without spaces, for pasting into a form field. */
export function moneyPlain(minor) {
  return `${Math.floor(minor / 100)},${String(minor % 100).padStart(2, '0')}`;
}
