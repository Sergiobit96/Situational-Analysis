import { getHistoricalRates } from 'dukascopy-node';
const data = await getHistoricalRates({
  instrument: 'gbridxgbp',
  dates: { from: new Date('2025-01-06'), to: new Date('2025-01-20') },
  timeframe: 'd1',
});
for (const row of data) {
  const [ts, open, high, low, close] = row;
  console.log(new Date(ts).toISOString().slice(0,10), 'open=' + open.toFixed(1), 'close=' + close.toFixed(1));
}
