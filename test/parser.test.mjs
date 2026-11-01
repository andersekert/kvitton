// Run with: node test/parser.test.mjs. All receipts here are made up.
import assert from 'node:assert/strict';
import { amounts, fileBaseName, moneyPlain, moneyText, parseAmountInput, parseReceipt, DEFAULT_TEMPLATE }
  from '../parser.js';

const today = new Date(2026, 10, 1);
const cases = [
  { name: 'Swedish grocery with VAT table',
    lines: ['ICA Supermarket Centrum', 'Org.nr 556000-0000', 'Tel 08-123 45 67', '2026-10-12 14:33',
            'Mjölk 1,5 L   18,90', 'Bröd   32,50', 'Totalt   51,40', 'Moms%  Moms  Netto  Brutto',
            '12,00  5,51  45,89  51,40', 'Kort  51,40'],
    amount: 5140, currency: 'SEK', date: '2026-10-12', merchant: 'ICA Supermarket Centrum' },
  { name: 'Att betala beats cash',
    lines: ['Espresso House', '12 okt 2026', 'Kaffe  45,00', 'Summa exkl moms  100,00', 'Moms  25,00',
            'Att betala  125,00 kr', 'Kontant  200,00', 'Växel  75,00'],
    amount: 12500, currency: 'SEK', date: '2026-10-12', merchant: 'Espresso House' },
  { name: 'Hotel with space thousands',
    lines: ['KVITTO', 'Scandic Malmen', 'Datum: 2026-09-30', '2 nätter   2 490,00',
            'Totalt inkl moms   2 490,00 SEK', 'varav moms 12%  266,79'],
    amount: 249000, currency: 'SEK', date: '2026-09-30', merchant: 'Scandic Malmen' },
  { name: 'Amount on the row below its label',
    lines: ['Taxi Stockholm', '2026-10-01', 'Att betala', '312,00', 'Moms 6%', '17,66'],
    amount: 31200, currency: 'SEK', date: '2026-10-01', merchant: 'Taxi Stockholm' },
  { name: 'OCR space in decimals',
    lines: ['Pressbyrån', '26-10-05 08:12', 'Totalt 89, 00'],
    amount: 8900, currency: 'SEK', date: '2026-10-05', merchant: 'Pressbyrån' },
  { name: 'Whole-krona amount',
    lines: ['Parkering City', '2026-10-06', 'Summa 120:-'],
    amount: 12000, currency: 'SEK', date: '2026-10-06', merchant: 'Parkering City' },
  { name: 'German restaurant in EUR',
    lines: ['Gasthaus Zum Löwen', '15.10.2026 20:14', 'Schnitzel  18,50', 'Bier  4,50', 'Summe  23,00 EUR',
            'MwSt 19%  3,67'],
    amount: 2300, currency: 'EUR', date: '2026-10-15', merchant: 'Gasthaus Zum Löwen' },
  { name: 'US receipt: subtotal, tax, tip, month first',
    lines: ['Blue Bottle Coffee', 'www.example.com', '10/03/2026', 'Subtotal  $12.00', 'Tax  $1.05', 'Tip  $2.00',
            'Total  $15.05'],
    amount: 1505, currency: 'USD', date: '2026-10-03', merchant: 'Blue Bottle Coffee' },
  { name: 'US thousands comma',
    lines: ['Grand Hotel', 'Oct 12, 2026', 'Grand Total $1,234.50'],
    amount: 123450, currency: 'USD', date: '2026-10-12', merchant: 'Grand Hotel' },
  { name: 'No total line falls back and is flagged',
    lines: ['Kiosken', '2026-10-07', 'Korv 45,00', 'Dricka 25,00', 'Org.nr 999,99'],
    amount: 4500, currency: 'SEK', date: '2026-10-07', merchant: 'Kiosken', confident: false },
  { name: 'Reference number is not a date',
    lines: ['Bussbolaget AB', 'Ref 20161301', 'Belopp 55,00 kr'],
    amount: 5500, currency: 'SEK', date: null, merchant: 'Bussbolaget AB' },
  { name: 'Unreadable',
    lines: ['...', '##'],
    amount: null, currency: 'SEK', date: null, merchant: null, confident: false },
  { name: '"kr" on a Norwegian trip is NOK',
    trip: 'NOK', lines: ['Narvesen Oslo S', '2026-10-20', 'Totalt 49,00 kr'],
    amount: 4900, currency: 'NOK', date: '2026-10-20', merchant: 'Narvesen Oslo S' },
  { name: 'Receipt without currency uses the trip currency',
    trip: 'PLN', lines: ['Zabka Warszawa', '2026-10-21', 'Total 18,50'],
    amount: 1850, currency: 'PLN', date: '2026-10-21', merchant: 'Zabka Warszawa' },
  { name: 'Currency on the receipt beats the trip currency',
    trip: 'NOK', lines: ['Airport Shop', '2026-10-22', 'Total 12,00 EUR'],
    amount: 1200, currency: 'EUR', date: '2026-10-22', merchant: 'Airport Shop' },
];

for (const c of cases) {
  const parsed = parseReceipt(c.lines, { today, tripCurrency: c.trip ?? 'SEK' });
  assert.equal(parsed.amountMinor, c.amount, `${c.name}: amount`);
  assert.equal(parsed.currency, c.currency, `${c.name}: currency`);
  assert.equal(parsed.date, c.date, `${c.name}: date`);
  assert.equal(parsed.merchant, c.merchant, `${c.name}: merchant`);
  assert.equal(parsed.amountIsConfident, c.confident ?? true, `${c.name}: confident`);
}

assert.equal(parseAmountInput('1 245,50'), 124550);
assert.equal(parseAmountInput('245'), 24500);
assert.equal(parseAmountInput('70,00'), 7000);
assert.equal(parseAmountInput('1245.5'), 124550);
assert.equal(parseAmountInput('1,234'), 123400);
assert.equal(parseAmountInput('1.234,50'), 123450);
assert.equal(parseAmountInput('abc'), null);
assert.equal(parseAmountInput(''), null);

assert.deepEqual(amounts('Totalt 89, 00', true), [8900]);
assert.equal(moneyText(124550), '1 245,50');
assert.equal(moneyText(5), '0,05');
assert.equal(moneyPlain(124550), '1245,50');

assert.equal(
  fileBaseName(DEFAULT_TEMPLATE, { date: '2026-10-12', merchant: 'Pressbyrån Malmö C', amountMinor: 8905, currency: 'SEK' }),
  '2026-10-12_Pressbyran-Malmo-C_89.05_SEK');
assert.equal(
  fileBaseName(DEFAULT_TEMPLATE, { date: null, merchant: '', amountMinor: null, currency: 'EUR' }),
  'okant-datum_okand-butik_okant-belopp_EUR');
assert.equal(
  fileBaseName('{typ}_{resa}_{datum}', { date: '2026-10-12', merchant: 'x', amountMinor: 1, currency: 'NOK',
                                         tripName: 'Oslo mässa', tripKind: 'utrikes' }),
  'utrikes_Oslo-massa_2026-10-12');

console.log(`OK: ${cases.length} receipts passed`);
