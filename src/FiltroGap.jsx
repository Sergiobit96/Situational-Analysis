import { useState, useEffect, useRef, useMemo } from 'react'
import GraficoVelas from './GraficoVelas'
import { capturarVelasPNG } from './graficoVelasCore'

// Tickers que Railway maneja via Dukascopy — el resto va a /api/yf-intraday (Vercel)
const DUKA_TICKERS = new Set(['^GSPC', '^NDX', '^DJI', '^GDAXI', '^FTSE', '^RUT', '^N225', 'XAUUSD', 'XAGUSD', 'USOIL'])

function intradayUrl(tkr, date, timeframe) {
  if (DUKA_TICKERS.has(tkr)) {
    return `/api/velas15m?${new URLSearchParams({ ticker: tkr, date, timeframe })}`
  }
  return `/api/yf-intraday?${new URLSearchParams({ ticker: tkr, date })}`
}

const DIAS = [
  { n: 1, label: 'L', nombre: 'Lunes' },
  { n: 2, label: 'M', nombre: 'Martes' },
  { n: 3, label: 'X', nombre: 'Miércoles' },
  { n: 4, label: 'J', nombre: 'Jueves' },
  { n: 5, label: 'V', nombre: 'Viernes' },
]

const GAP_SIZES = [0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]

// Gaps sugeridos en puntos: varían mucho según la escala de precio del instrumento
// (p.ej. 50 pts es pequeño para el DAX pero enorme para la Plata), así que se eligen
// por ticker en vez de un único set de chips válido para todos.
const GAP_PTS_SUGERIDOS = {
  '^GDAXI': [10, 25, 50, 100, 200, 400],
  '^FTSE':  [10, 20, 40, 75, 150, 300],
  '^GSPC':  [5, 10, 20, 40, 75, 150],
  '^NDX':   [10, 25, 50, 100, 200, 400],
  '^DJI':   [25, 50, 100, 200, 400, 800],
  '^RUT':   [2, 5, 10, 20, 40, 75],
  '^N225':  [50, 100, 200, 400, 800, 1500],
  'XAUUSD': [5, 10, 20, 40, 75, 150],
  'XAGUSD': [0.1, 0.25, 0.5, 1, 2, 4],
  'USOIL':  [0.25, 0.5, 1, 2, 4, 8],
}
const GAP_PTS_DEFAULT = [0.5, 1, 2, 5, 10, 25]

const EVENTOS_DEF = [
  { id: 'FOMC', label: 'FOMC',  title: 'Fed rate decision' },
  { id: 'CPI',  label: 'CPI',   title: 'Consumer Price Index US' },
  { id: 'NFP',  label: 'NFP',   title: 'Non-Farm Payrolls' },
  { id: 'ECB',  label: 'ECB',   title: 'ECB rate decision' },
  { id: 'PPI',  label: 'PPI',   title: 'Producer Price Index US' },
  { id: 'GDP',  label: 'GDP',   title: 'Gross Domestic Product' },
  { id: 'PMI',  label: 'PMI',   title: 'Purchasing Managers Index' },
]

const PERIODOS = [
  { meses: 3,  label: '3m'  },
  { meses: 6,  label: '6m'  },
  { meses: 12, label: '12m' },
  { meses: 24, label: '2a'  },
  { meses: 60, label: '5a'  },
]

const PRESETS = [
  { label: 'DAX',    value: '^GDAXI' },
  { label: 'FTSE',   value: '^FTSE'  },
  { label: 'Nasdaq', value: '^NDX'   },
  { label: 'Dow Jones', value: '^DJI'   },
  { label: 'S&P',    value: '^GSPC'  },
  { label: 'Russell 2000', value: '^RUT' },
  { label: 'Nikkei', value: '^N225' },
  { label: 'Oro',    value: 'XAUUSD' },
  { label: 'Plata',  value: 'XAGUSD' },
  { label: 'Petróleo', value: 'USOIL' },
]

const STOCKS = {
  '^GDAXI': [
    { name: 'Adidas', ticker: 'ADS.DE' },
    { name: 'Airbus', ticker: 'AIR.PA' },
    { name: 'Allianz', ticker: 'ALV.DE' },
    { name: 'BASF', ticker: 'BAS.DE' },
    { name: 'Bayer', ticker: 'BAYN.DE' },
    { name: 'Beiersdorf', ticker: 'BEI.DE' },
    { name: 'BMW', ticker: 'BMW.DE' },
    { name: 'Brenntag', ticker: 'BNR.DE' },
    { name: 'Commerzbank', ticker: 'CBK.DE' },
    { name: 'Continental', ticker: 'CON.DE' },
    { name: 'Daimler Truck', ticker: 'DTG.DE' },
    { name: 'Deutsche Bank', ticker: 'DBK.DE' },
    { name: 'Deutsche Börse', ticker: 'DB1.DE' },
    { name: 'Deutsche Post', ticker: 'DHL.DE' },
    { name: 'Deutsche Telekom', ticker: 'DTE.DE' },
    { name: 'E.ON', ticker: 'EOAN.DE' },
    { name: 'Fresenius', ticker: 'FRE.DE' },
    { name: 'Fresenius Medical Care', ticker: 'FME.DE' },
    { name: 'GEA Group', ticker: 'G1A.DE' },
    { name: 'Hannover Re', ticker: 'HNR1.DE' },
    { name: 'Heidelberg Materials', ticker: 'HEI.DE' },
    { name: 'Henkel', ticker: 'HEN3.DE' },
    { name: 'Infineon Technologies', ticker: 'IFX.DE' },
    { name: 'Mercedes-Benz Group', ticker: 'MBG.DE' },
    { name: 'Merck', ticker: 'MRK.DE' },
    { name: 'MTU Aero Engines', ticker: 'MTX.DE' },
    { name: 'Munich Re', ticker: 'MUV2.DE' },
    { name: 'Porsche SE', ticker: 'PAH3.DE' },
    { name: 'Qiagen', ticker: 'QIA.DE' },
    { name: 'Rheinmetall', ticker: 'RHM.DE' },
    { name: 'RWE', ticker: 'RWE.DE' },
    { name: 'SAP', ticker: 'SAP.DE' },
    { name: 'Scout24', ticker: 'G24.DE' },
    { name: 'Siemens', ticker: 'SIE.DE' },
    { name: 'Siemens Energy', ticker: 'ENR.DE' },
    { name: 'Siemens Healthineers', ticker: 'SHL.DE' },
    { name: 'Symrise', ticker: 'SY1.DE' },
    { name: 'Volkswagen Group', ticker: 'VOW3.DE' },
    { name: 'Vonovia', ticker: 'VNA.DE' },
    { name: 'Zalando', ticker: 'ZAL.DE' },
  ],
  '^FTSE': [
    { name: '3i', ticker: 'III.L' },
    { name: 'Aberdeen Group', ticker: 'ABDN.L' },
    { name: 'Admiral Group', ticker: 'ADM.L' },
    { name: 'Airtel Africa', ticker: 'AAF.L' },
    { name: 'Alliance Witan', ticker: 'ALW.L' },
    { name: 'Anglo American', ticker: 'AAL.L' },
    { name: 'Antofagasta', ticker: 'ANTO.L' },
    { name: 'Associated British Foods', ticker: 'ABF.L' },
    { name: 'AstraZeneca', ticker: 'AZN.L' },
    { name: 'Autotrader Group', ticker: 'AUTO.L' },
    { name: 'Aviva', ticker: 'AV.L' },
    { name: 'Babcock International', ticker: 'BAB.L' },
    { name: 'BAE Systems', ticker: 'BA.L' },
    { name: 'Barclays', ticker: 'BARC.L' },
    { name: 'Barratt Redrow', ticker: 'BTRW.L' },
    { name: 'Beazley', ticker: 'BEZ.L' },
    { name: 'BP', ticker: 'BP.L' },
    { name: 'British American Tobacco', ticker: 'BATS.L' },
    { name: 'British Land', ticker: 'BLND.L' },
    { name: 'BT Group', ticker: 'BT-A.L' },
    { name: 'Bunzl', ticker: 'BNZL.L' },
    { name: 'Burberry Group', ticker: 'BRBY.L' },
    { name: 'Centrica', ticker: 'CNA.L' },
    { name: 'Coca-Cola Europacific Partners', ticker: 'CCEP.L' },
    { name: 'Coca-Cola HBC', ticker: 'CCH.L' },
    { name: 'Compass Group', ticker: 'CPG.L' },
    { name: 'Computacenter', ticker: 'CCC.L' },
    { name: 'Convatec', ticker: 'CTEC.L' },
    { name: 'Croda International', ticker: 'CRDA.L' },
    { name: 'DCC', ticker: 'DCC.L' },
    { name: 'Diageo', ticker: 'DGE.L' },
    { name: 'Diploma', ticker: 'DPLM.L' },
    { name: 'Endeavour Mining', ticker: 'EDV.L' },
    { name: 'Entain', ticker: 'ENT.L' },
    { name: 'Experian', ticker: 'EXPN.L' },
    { name: 'F & C Investment Trust', ticker: 'FCIT.L' },
    { name: 'Fresnillo', ticker: 'FRES.L' },
    { name: 'Games Workshop', ticker: 'GAW.L' },
    { name: 'Glencore', ticker: 'GLEN.L' },
    { name: 'GSK', ticker: 'GSK.L' },
    { name: 'Haleon', ticker: 'HLN.L' },
    { name: 'Halma', ticker: 'HLMA.L' },
    { name: 'Hiscox', ticker: 'HSX.L' },
    { name: 'Howdens Joinery', ticker: 'HWDN.L' },
    { name: 'HSBC', ticker: 'HSBA.L' },
    { name: 'ICG', ticker: 'ICG.L' },
    { name: 'IG Group', ticker: 'IGG.L' },
    { name: 'IHG Hotels & Resorts', ticker: 'IHG.L' },
    { name: 'IMI', ticker: 'IMI.L' },
    { name: 'Imperial Brands', ticker: 'IMB.L' },
    { name: 'Informa', ticker: 'INF.L' },
    { name: 'International Airlines Group', ticker: 'IAG.L' },
    { name: 'Intertek', ticker: 'ITRK.L' },
    { name: 'Investec', ticker: 'INVP.L' },
    { name: 'JD Sports', ticker: 'JD.L' },
    { name: 'Lion Finance Group', ticker: 'BGEO.L' },
    { name: 'Kingfisher', ticker: 'KGF.L' },
    { name: 'Land Securities', ticker: 'LAND.L' },
    { name: 'Legal & General', ticker: 'LGEN.L' },
    { name: 'Lloyds Banking Group', ticker: 'LLOY.L' },
    { name: 'LondonMetric Property', ticker: 'LMP.L' },
    { name: 'London Stock Exchange Group', ticker: 'LSEG.L' },
    { name: 'M&G', ticker: 'MNG.L' },
    { name: 'Marks & Spencer', ticker: 'MKS.L' },
    { name: 'Melrose Industries', ticker: 'MRO.L' },
    { name: 'Metlen Energy & Metals', ticker: 'MTLN.L' },
    { name: 'National Grid', ticker: 'NG.L' },
    { name: 'NatWest Group', ticker: 'NWG.L' },
    { name: 'Next', ticker: 'NXT.L' },
    { name: 'Pearson', ticker: 'PSON.L' },
    { name: 'Pershing Square Holdings', ticker: 'PSH.L' },
    { name: 'Persimmon', ticker: 'PSN.L' },
    { name: 'Polar Capital Technology Trust', ticker: 'PCT.L' },
    { name: 'Prudential', ticker: 'PRU.L' },
    { name: 'Reckitt', ticker: 'RKT.L' },
    { name: 'RELX', ticker: 'REL.L' },
    { name: 'Rentokil Initial', ticker: 'RTO.L' },
    { name: 'Rio Tinto', ticker: 'RIO.L' },
    { name: 'Rolls-Royce Holdings', ticker: 'RR.L' },
    { name: 'Sage Group', ticker: 'SGE.L' },
    { name: "Sainsbury's", ticker: 'SBRY.L' },
    { name: 'Schroders', ticker: 'SDR.L' },
    { name: 'Scottish Mortgage Investment Trust', ticker: 'SMT.L' },
    { name: 'Segro', ticker: 'SGRO.L' },
    { name: 'Severn Trent', ticker: 'SVT.L' },
    { name: 'Shell', ticker: 'SHEL.L' },
    { name: 'Smiths Group', ticker: 'SMIN.L' },
    { name: 'Smith & Nephew', ticker: 'SN.L' },
    { name: 'Spirax Group', ticker: 'SPX.L' },
    { name: 'SSE', ticker: 'SSE.L' },
    { name: 'Standard Chartered', ticker: 'STAN.L' },
    { name: 'Standard Life', ticker: 'SDLF.L' },
    { name: "St. James's Place", ticker: 'STJ.L' },
    { name: 'Tesco', ticker: 'TSCO.L' },
    { name: 'Tritax Big Box REIT', ticker: 'BBOX.L' },
    { name: 'Unilever', ticker: 'ULVR.L' },
    { name: 'United Utilities', ticker: 'UU.L' },
    { name: 'Vodafone Group', ticker: 'VOD.L' },
    { name: 'Weir Group', ticker: 'WEIR.L' },
    { name: 'Whitbread', ticker: 'WTB.L' },
  ],
  '^GSPC': [
    { name: '3M', ticker: 'MMM' },
    { name: 'A. O. Smith', ticker: 'AOS' },
    { name: 'Abbott Laboratories', ticker: 'ABT' },
    { name: 'AbbVie', ticker: 'ABBV' },
    { name: 'Accenture', ticker: 'ACN' },
    { name: 'Adobe', ticker: 'ADBE' },
    { name: 'Advanced Micro Devices', ticker: 'AMD' },
    { name: 'AES', ticker: 'AES' },
    { name: 'Aflac', ticker: 'AFL' },
    { name: 'Agilent Technologies', ticker: 'A' },
    { name: 'Air Products', ticker: 'APD' },
    { name: 'Airbnb', ticker: 'ABNB' },
    { name: 'Akamai Technologies', ticker: 'AKAM' },
    { name: 'Albemarle', ticker: 'ALB' },
    { name: 'Alexandria Real Estate Equities', ticker: 'ARE' },
    { name: 'Align Technology', ticker: 'ALGN' },
    { name: 'Allegion', ticker: 'ALLE' },
    { name: 'Alliant Energy', ticker: 'LNT' },
    { name: 'Allstate', ticker: 'ALL' },
    { name: 'Alphabet (Class A)', ticker: 'GOOGL' },
    { name: 'Alphabet (Class C)', ticker: 'GOOG' },
    { name: 'Altria', ticker: 'MO' },
    { name: 'Amazon', ticker: 'AMZN' },
    { name: 'Amcor', ticker: 'AMCR' },
    { name: 'Ameren', ticker: 'AEE' },
    { name: 'American Electric Power', ticker: 'AEP' },
    { name: 'American Express', ticker: 'AXP' },
    { name: 'American International Group', ticker: 'AIG' },
    { name: 'American Tower', ticker: 'AMT' },
    { name: 'American Water Works', ticker: 'AWK' },
    { name: 'Ameriprise Financial', ticker: 'AMP' },
    { name: 'Ametek', ticker: 'AME' },
    { name: 'Amgen', ticker: 'AMGN' },
    { name: 'Amphenol', ticker: 'APH' },
    { name: 'Analog Devices', ticker: 'ADI' },
    { name: 'Aon plc', ticker: 'AON' },
    { name: 'APA', ticker: 'APA' },
    { name: 'Apollo Global Management', ticker: 'APO' },
    { name: 'Apple', ticker: 'AAPL' },
    { name: 'Applied Materials', ticker: 'AMAT' },
    { name: 'AppLovin', ticker: 'APP' },
    { name: 'Aptiv', ticker: 'APTV' },
    { name: 'Arch Capital Group', ticker: 'ACGL' },
    { name: 'Archer Daniels Midland', ticker: 'ADM' },
    { name: 'Ares Management', ticker: 'ARES' },
    { name: 'Arista Networks', ticker: 'ANET' },
    { name: 'Arthur J. Gallagher & Co.', ticker: 'AJG' },
    { name: 'Assurant', ticker: 'AIZ' },
    { name: 'AT&T', ticker: 'T' },
    { name: 'Atmos Energy', ticker: 'ATO' },
    { name: 'Autodesk', ticker: 'ADSK' },
    { name: 'Automatic Data Processing', ticker: 'ADP' },
    { name: 'AutoZone', ticker: 'AZO' },
    { name: 'AvalonBay Communities', ticker: 'AVB' },
    { name: 'Avery Dennison', ticker: 'AVY' },
    { name: 'Axon Enterprise', ticker: 'AXON' },
    { name: 'Baker Hughes', ticker: 'BKR' },
    { name: 'Ball', ticker: 'BALL' },
    { name: 'Bank of America', ticker: 'BAC' },
    { name: 'Baxter International', ticker: 'BAX' },
    { name: 'Becton Dickinson', ticker: 'BDX' },
    { name: 'Berkshire Hathaway', ticker: 'BRK-B' },
    { name: 'Best Buy', ticker: 'BBY' },
    { name: 'Bio-Techne', ticker: 'TECH' },
    { name: 'Biogen', ticker: 'BIIB' },
    { name: 'BlackRock', ticker: 'BLK' },
    { name: 'Blackstone', ticker: 'BX' },
    { name: 'Block', ticker: 'XYZ' },
    { name: 'BNY Mellon', ticker: 'BNY' },
    { name: 'Boeing', ticker: 'BA' },
    { name: 'Booking Holdings', ticker: 'BKNG' },
    { name: 'Boston Scientific', ticker: 'BSX' },
    { name: 'Bristol Myers Squibb', ticker: 'BMY' },
    { name: 'Broadcom', ticker: 'AVGO' },
    { name: 'Broadridge Financial Solutions', ticker: 'BR' },
    { name: 'Brown & Brown', ticker: 'BRO' },
    { name: 'Brown-Forman', ticker: 'BF-B' },
    { name: 'Builders FirstSource', ticker: 'BLDR' },
    { name: 'Bunge Global', ticker: 'BG' },
    { name: 'BXP', ticker: 'BXP' },
    { name: 'C.H. Robinson', ticker: 'CHRW' },
    { name: 'Cadence Design Systems', ticker: 'CDNS' },
    { name: 'Camden Property Trust', ticker: 'CPT' },
    { name: 'Capital One', ticker: 'COF' },
    { name: 'Cardinal Health', ticker: 'CAH' },
    { name: 'Carnival', ticker: 'CCL' },
    { name: 'Carrier Global', ticker: 'CARR' },
    { name: 'Carvana', ticker: 'CVNA' },
    { name: "Casey's", ticker: 'CASY' },
    { name: 'Caterpillar', ticker: 'CAT' },
    { name: 'Cboe Global Markets', ticker: 'CBOE' },
    { name: 'CBRE Group', ticker: 'CBRE' },
    { name: 'CDW', ticker: 'CDW' },
    { name: 'Cencora', ticker: 'COR' },
    { name: 'Centene', ticker: 'CNC' },
    { name: 'CenterPoint Energy', ticker: 'CNP' },
    { name: 'CF Industries', ticker: 'CF' },
    { name: 'Charles River Laboratories', ticker: 'CRL' },
    { name: 'Charles Schwab', ticker: 'SCHW' },
    { name: 'Charter Communications', ticker: 'CHTR' },
    { name: 'Chevron', ticker: 'CVX' },
    { name: 'Chipotle Mexican Grill', ticker: 'CMG' },
    { name: 'Chubb Limited', ticker: 'CB' },
    { name: 'Church & Dwight', ticker: 'CHD' },
    { name: 'Ciena', ticker: 'CIEN' },
    { name: 'Cigna', ticker: 'CI' },
    { name: 'Cincinnati Financial', ticker: 'CINF' },
    { name: 'Cintas', ticker: 'CTAS' },
    { name: 'Cisco', ticker: 'CSCO' },
    { name: 'Citigroup', ticker: 'C' },
    { name: 'Citizens Financial Group', ticker: 'CFG' },
    { name: 'Clorox', ticker: 'CLX' },
    { name: 'CME Group', ticker: 'CME' },
    { name: 'CMS Energy', ticker: 'CMS' },
    { name: 'Coca-Cola', ticker: 'KO' },
    { name: 'Cognizant', ticker: 'CTSH' },
    { name: 'Coherent', ticker: 'COHR' },
    { name: 'Coinbase', ticker: 'COIN' },
    { name: 'Colgate-Palmolive', ticker: 'CL' },
    { name: 'Comcast', ticker: 'CMCSA' },
    { name: 'Comfort Systems USA', ticker: 'FIX' },
    { name: 'ConocoPhillips', ticker: 'COP' },
    { name: 'Consolidated Edison', ticker: 'ED' },
    { name: 'Constellation Brands', ticker: 'STZ' },
    { name: 'Constellation Energy', ticker: 'CEG' },
    { name: 'Cooper Companies', ticker: 'COO' },
    { name: 'Copart', ticker: 'CPRT' },
    { name: 'Corning', ticker: 'GLW' },
    { name: 'Corpay', ticker: 'CPAY' },
    { name: 'Corteva', ticker: 'CTVA' },
    { name: 'CoStar Group', ticker: 'CSGP' },
    { name: 'Costco', ticker: 'COST' },
    { name: 'CRH plc', ticker: 'CRH' },
    { name: 'CrowdStrike', ticker: 'CRWD' },
    { name: 'Crown Castle', ticker: 'CCI' },
    { name: 'CSX', ticker: 'CSX' },
    { name: 'Cummins', ticker: 'CMI' },
    { name: 'CVS Health', ticker: 'CVS' },
    { name: 'Danaher', ticker: 'DHR' },
    { name: 'Darden Restaurants', ticker: 'DRI' },
    { name: 'Datadog', ticker: 'DDOG' },
    { name: 'DaVita', ticker: 'DVA' },
    { name: 'Deckers Brands', ticker: 'DECK' },
    { name: 'Deere & Company', ticker: 'DE' },
    { name: 'Dell Technologies', ticker: 'DELL' },
    { name: 'Delta Air Lines', ticker: 'DAL' },
    { name: 'Devon Energy', ticker: 'DVN' },
    { name: 'Dexcom', ticker: 'DXCM' },
    { name: 'Diamondback Energy', ticker: 'FANG' },
    { name: 'Digital Realty', ticker: 'DLR' },
    { name: 'Dollar General', ticker: 'DG' },
    { name: 'Dollar Tree', ticker: 'DLTR' },
    { name: 'Dominion Energy', ticker: 'D' },
    { name: "Domino's", ticker: 'DPZ' },
    { name: 'DoorDash', ticker: 'DASH' },
    { name: 'Dover', ticker: 'DOV' },
    { name: 'Dow', ticker: 'DOW' },
    { name: 'D. R. Horton', ticker: 'DHI' },
    { name: 'DTE Energy', ticker: 'DTE' },
    { name: 'Duke Energy', ticker: 'DUK' },
    { name: 'DuPont', ticker: 'DD' },
    { name: 'Eaton', ticker: 'ETN' },
    { name: 'eBay', ticker: 'EBAY' },
    { name: 'EchoStar', ticker: 'ECHO' },
    { name: 'Ecolab', ticker: 'ECL' },
    { name: 'Edison International', ticker: 'EIX' },
    { name: 'Edwards Lifesciences', ticker: 'EW' },
    { name: 'Electronic Arts', ticker: 'EA' },
    { name: 'Elevance Health', ticker: 'ELV' },
    { name: 'Emcor', ticker: 'EME' },
    { name: 'Emerson Electric', ticker: 'EMR' },
    { name: 'Entergy', ticker: 'ETR' },
    { name: 'EOG Resources', ticker: 'EOG' },
    { name: 'EQT', ticker: 'EQT' },
    { name: 'Equifax', ticker: 'EFX' },
    { name: 'Equinix', ticker: 'EQIX' },
    { name: 'Equity Residential', ticker: 'EQR' },
    { name: 'Erie Indemnity', ticker: 'ERIE' },
    { name: 'Essex Property Trust', ticker: 'ESS' },
    { name: 'Estée Lauder Companies', ticker: 'EL' },
    { name: 'Everest Group', ticker: 'EG' },
    { name: 'Evergy', ticker: 'EVRG' },
    { name: 'Eversource Energy', ticker: 'ES' },
    { name: 'Exelon', ticker: 'EXC' },
    { name: 'Expand Energy', ticker: 'EXE' },
    { name: 'Expedia Group', ticker: 'EXPE' },
    { name: 'Expeditors International', ticker: 'EXPD' },
    { name: 'Extra Space Storage', ticker: 'EXR' },
    { name: 'ExxonMobil', ticker: 'XOM' },
    { name: 'F5', ticker: 'FFIV' },
    { name: 'FactSet', ticker: 'FDS' },
    { name: 'Fair Isaac', ticker: 'FICO' },
    { name: 'Fastenal', ticker: 'FAST' },
    { name: 'Federal Realty Investment Trust', ticker: 'FRT' },
    { name: 'FedEx', ticker: 'FDX' },
    { name: 'FedEx Freight', ticker: 'FDXF' },
    { name: 'Fidelity National Information Services', ticker: 'FIS' },
    { name: 'Fifth Third Bancorp', ticker: 'FITB' },
    { name: 'First Solar', ticker: 'FSLR' },
    { name: 'FirstEnergy', ticker: 'FE' },
    { name: 'Fiserv', ticker: 'FISV' },
    { name: 'Flex Ltd.', ticker: 'FLEX' },
    { name: 'Ford Motor Company', ticker: 'F' },
    { name: 'Fortinet', ticker: 'FTNT' },
    { name: 'Fortive', ticker: 'FTV' },
    { name: 'Fox (Class A)', ticker: 'FOXA' },
    { name: 'Fox (Class B)', ticker: 'FOX' },
    { name: 'Franklin Resources', ticker: 'BEN' },
    { name: 'Freeport-McMoRan', ticker: 'FCX' },
    { name: 'Garmin', ticker: 'GRMN' },
    { name: 'Gartner', ticker: 'IT' },
    { name: 'GE Aerospace', ticker: 'GE' },
    { name: 'GE HealthCare', ticker: 'GEHC' },
    { name: 'GE Vernova', ticker: 'GEV' },
    { name: 'Gen Digital', ticker: 'GEN' },
    { name: 'Generac', ticker: 'GNRC' },
    { name: 'General Dynamics', ticker: 'GD' },
    { name: 'General Mills', ticker: 'GIS' },
    { name: 'General Motors', ticker: 'GM' },
    { name: 'Genuine Parts Company', ticker: 'GPC' },
    { name: 'Gilead Sciences', ticker: 'GILD' },
    { name: 'Global Payments', ticker: 'GPN' },
    { name: 'Globe Life', ticker: 'GL' },
    { name: 'GoDaddy', ticker: 'GDDY' },
    { name: 'Goldman Sachs', ticker: 'GS' },
    { name: 'Halliburton', ticker: 'HAL' },
    { name: 'Hartford', ticker: 'HIG' },
    { name: 'Hasbro', ticker: 'HAS' },
    { name: 'HCA Healthcare', ticker: 'HCA' },
    { name: 'Healthpeak Properties', ticker: 'DOC' },
    { name: 'Henry Schein', ticker: 'HSIC' },
    { name: 'Hershey', ticker: 'HSY' },
    { name: 'Hewlett Packard Enterprise', ticker: 'HPE' },
    { name: 'Hilton Worldwide', ticker: 'HLT' },
    { name: 'Home Depot', ticker: 'HD' },
    { name: 'Honeywell Aerospace', ticker: 'HONA' },
    { name: 'Honeywell Technologies', ticker: 'HON' },
    { name: 'Hormel Foods', ticker: 'HRL' },
    { name: 'Host Hotels & Resorts', ticker: 'HST' },
    { name: 'Howmet Aerospace', ticker: 'HWM' },
    { name: 'HP', ticker: 'HPQ' },
    { name: 'Hubbell', ticker: 'HUBB' },
    { name: 'Humana', ticker: 'HUM' },
    { name: 'Huntington Bancshares', ticker: 'HBAN' },
    { name: 'Huntington Ingalls Industries', ticker: 'HII' },
    { name: 'IBM', ticker: 'IBM' },
    { name: 'IDEX', ticker: 'IEX' },
    { name: 'Idexx Laboratories', ticker: 'IDXX' },
    { name: 'Illinois Tool Works', ticker: 'ITW' },
    { name: 'Incyte', ticker: 'INCY' },
    { name: 'Ingersoll Rand', ticker: 'IR' },
    { name: 'Insulet', ticker: 'PODD' },
    { name: 'Intel', ticker: 'INTC' },
    { name: 'Interactive Brokers', ticker: 'IBKR' },
    { name: 'Intercontinental Exchange', ticker: 'ICE' },
    { name: 'International Flavors & Fragrances', ticker: 'IFF' },
    { name: 'International Paper', ticker: 'IP' },
    { name: 'Intuit', ticker: 'INTU' },
    { name: 'Intuitive Surgical', ticker: 'ISRG' },
    { name: 'Invesco', ticker: 'IVZ' },
    { name: 'Invitation Homes', ticker: 'INVH' },
    { name: 'IQVIA', ticker: 'IQV' },
    { name: 'Iron Mountain', ticker: 'IRM' },
    { name: 'J.B. Hunt', ticker: 'JBHT' },
    { name: 'Jabil', ticker: 'JBL' },
    { name: 'Jack Henry & Associates', ticker: 'JKHY' },
    { name: 'Jacobs Solutions', ticker: 'J' },
    { name: 'Johnson & Johnson', ticker: 'JNJ' },
    { name: 'Johnson Controls', ticker: 'JCI' },
    { name: 'JPMorgan Chase', ticker: 'JPM' },
    { name: 'Kenvue', ticker: 'KVUE' },
    { name: 'Keurig Dr Pepper', ticker: 'KDP' },
    { name: 'KeyCorp', ticker: 'KEY' },
    { name: 'Keysight Technologies', ticker: 'KEYS' },
    { name: 'Kimberly-Clark', ticker: 'KMB' },
    { name: 'Kimco Realty', ticker: 'KIM' },
    { name: 'Kinder Morgan', ticker: 'KMI' },
    { name: 'KKR & Co.', ticker: 'KKR' },
    { name: 'KLA', ticker: 'KLAC' },
    { name: 'Kraft Heinz', ticker: 'KHC' },
    { name: 'Kroger', ticker: 'KR' },
    { name: 'L3Harris', ticker: 'LHX' },
    { name: 'Labcorp', ticker: 'LH' },
    { name: 'Lam Research', ticker: 'LRCX' },
    { name: 'Las Vegas Sands', ticker: 'LVS' },
    { name: 'Leidos', ticker: 'LDOS' },
    { name: 'Lennar', ticker: 'LEN' },
    { name: 'Lennox International', ticker: 'LII' },
    { name: 'Lilly (Eli)', ticker: 'LLY' },
    { name: 'Linde plc', ticker: 'LIN' },
    { name: 'Live Nation Entertainment', ticker: 'LYV' },
    { name: 'Lockheed Martin', ticker: 'LMT' },
    { name: 'Loews', ticker: 'L' },
    { name: "Lowe's", ticker: 'LOW' },
    { name: 'Lululemon Athletica', ticker: 'LULU' },
    { name: 'Lumentum', ticker: 'LITE' },
    { name: 'LyondellBasell', ticker: 'LYB' },
    { name: 'M&T Bank', ticker: 'MTB' },
    { name: 'Marathon Petroleum', ticker: 'MPC' },
    { name: 'Marriott International', ticker: 'MAR' },
    { name: 'Marsh McLennan', ticker: 'MRSH' },
    { name: 'Martin Marietta Materials', ticker: 'MLM' },
    { name: 'Marvell Technology', ticker: 'MRVL' },
    { name: 'Masco', ticker: 'MAS' },
    { name: 'Mastercard', ticker: 'MA' },
    { name: 'McCormick & Company', ticker: 'MKC' },
    { name: "McDonald's", ticker: 'MCD' },
    { name: 'McKesson', ticker: 'MCK' },
    { name: 'Medtronic', ticker: 'MDT' },
    { name: 'Merck & Co.', ticker: 'MRK' },
    { name: 'Meta Platforms', ticker: 'META' },
    { name: 'MetLife', ticker: 'MET' },
    { name: 'Mettler Toledo', ticker: 'MTD' },
    { name: 'MGM Resorts', ticker: 'MGM' },
    { name: 'Microchip Technology', ticker: 'MCHP' },
    { name: 'Micron Technology', ticker: 'MU' },
    { name: 'Microsoft', ticker: 'MSFT' },
    { name: 'Mid-America Apartment Communities', ticker: 'MAA' },
    { name: 'Moderna', ticker: 'MRNA' },
    { name: 'Molson Coors Beverage Company', ticker: 'TAP' },
    { name: 'Mondelez International', ticker: 'MDLZ' },
    { name: 'Monolithic Power Systems', ticker: 'MPWR' },
    { name: 'Monster Beverage', ticker: 'MNST' },
    { name: "Moody's", ticker: 'MCO' },
    { name: 'Morgan Stanley', ticker: 'MS' },
    { name: 'Mosaic', ticker: 'MOS' },
    { name: 'Motorola Solutions', ticker: 'MSI' },
    { name: 'MSCI', ticker: 'MSCI' },
    { name: 'Nasdaq', ticker: 'NDAQ' },
    { name: 'NetApp', ticker: 'NTAP' },
    { name: 'Netflix', ticker: 'NFLX' },
    { name: 'Newmont', ticker: 'NEM' },
    { name: 'News Corp (Class A)', ticker: 'NWSA' },
    { name: 'News Corp (Class B)', ticker: 'NWS' },
    { name: 'NextEra Energy', ticker: 'NEE' },
    { name: 'Nike', ticker: 'NKE' },
    { name: 'NiSource', ticker: 'NI' },
    { name: 'Nordson', ticker: 'NDSN' },
    { name: 'Norfolk Southern', ticker: 'NSC' },
    { name: 'Northern Trust', ticker: 'NTRS' },
    { name: 'Northrop Grumman', ticker: 'NOC' },
    { name: 'Norwegian Cruise Line Holdings', ticker: 'NCLH' },
    { name: 'NRG Energy', ticker: 'NRG' },
    { name: 'Nucor', ticker: 'NUE' },
    { name: 'Nvidia', ticker: 'NVDA' },
    { name: 'NVR', ticker: 'NVR' },
    { name: 'NXP Semiconductors', ticker: 'NXPI' },
    { name: 'O’Reilly Automotive', ticker: 'ORLY' },
    { name: 'Occidental Petroleum', ticker: 'OXY' },
    { name: 'Old Dominion', ticker: 'ODFL' },
    { name: 'Omnicom Group', ticker: 'OMC' },
    { name: 'ON Semiconductor', ticker: 'ON' },
    { name: 'Oneok', ticker: 'OKE' },
    { name: 'Oracle', ticker: 'ORCL' },
    { name: 'Otis Worldwide', ticker: 'OTIS' },
    { name: 'Paccar', ticker: 'PCAR' },
    { name: 'Packaging Corporation of America', ticker: 'PKG' },
    { name: 'Palantir Technologies', ticker: 'PLTR' },
    { name: 'Palo Alto Networks', ticker: 'PANW' },
    { name: 'Paramount Skydance', ticker: 'PSKY' },
    { name: 'Parker Hannifin', ticker: 'PH' },
    { name: 'Paychex', ticker: 'PAYX' },
    { name: 'PayPal', ticker: 'PYPL' },
    { name: 'Pentair', ticker: 'PNR' },
    { name: 'PepsiCo', ticker: 'PEP' },
    { name: 'Pfizer', ticker: 'PFE' },
    { name: 'PG&E', ticker: 'PCG' },
    { name: 'Philip Morris International', ticker: 'PM' },
    { name: 'Phillips 66', ticker: 'PSX' },
    { name: 'Pinnacle West Capital', ticker: 'PNW' },
    { name: 'PNC Financial Services', ticker: 'PNC' },
    { name: 'PPG Industries', ticker: 'PPG' },
    { name: 'PPL', ticker: 'PPL' },
    { name: 'Principal Financial Group', ticker: 'PFG' },
    { name: 'Procter & Gamble', ticker: 'PG' },
    { name: 'Progressive', ticker: 'PGR' },
    { name: 'Prologis', ticker: 'PLD' },
    { name: 'Prudential Financial', ticker: 'PRU' },
    { name: 'Public Service Enterprise Group', ticker: 'PEG' },
    { name: 'PTC', ticker: 'PTC' },
    { name: 'Public Storage', ticker: 'PSA' },
    { name: 'PulteGroup', ticker: 'PHM' },
    { name: 'Quanta Services', ticker: 'PWR' },
    { name: 'Qualcomm', ticker: 'QCOM' },
    { name: 'Quest Diagnostics', ticker: 'DGX' },
    { name: 'Qnity Electronics', ticker: 'Q' },
    { name: 'Ralph Lauren', ticker: 'RL' },
    { name: 'Raymond James Financial', ticker: 'RJF' },
    { name: 'RTX', ticker: 'RTX' },
    { name: 'Realty Income', ticker: 'O' },
    { name: 'Regency Centers', ticker: 'REG' },
    { name: 'Regeneron Pharmaceuticals', ticker: 'REGN' },
    { name: 'Regions Financial', ticker: 'RF' },
    { name: 'Republic Services', ticker: 'RSG' },
    { name: 'ResMed', ticker: 'RMD' },
    { name: 'Revvity', ticker: 'RVTY' },
    { name: 'Robinhood Markets', ticker: 'HOOD' },
    { name: 'Rockwell Automation', ticker: 'ROK' },
    { name: 'Rollins', ticker: 'ROL' },
    { name: 'Roper Technologies', ticker: 'ROP' },
    { name: 'Ross Stores', ticker: 'ROST' },
    { name: 'Royal Caribbean Group', ticker: 'RCL' },
    { name: 'S&P Global', ticker: 'SPGI' },
    { name: 'Salesforce', ticker: 'CRM' },
    { name: 'Sandisk', ticker: 'SNDK' },
    { name: 'SBA Communications', ticker: 'SBAC' },
    { name: 'Schlumberger', ticker: 'SLB' },
    { name: 'Seagate Technology', ticker: 'STX' },
    { name: 'Sempra', ticker: 'SRE' },
    { name: 'ServiceNow', ticker: 'NOW' },
    { name: 'Sherwin-Williams', ticker: 'SHW' },
    { name: 'Simon Property Group', ticker: 'SPG' },
    { name: 'Skyworks Solutions', ticker: 'SWKS' },
    { name: 'J.M. Smucker', ticker: 'SJM' },
    { name: 'Smurfit Westrock', ticker: 'SW' },
    { name: 'Snap-on', ticker: 'SNA' },
    { name: 'Solventum', ticker: 'SOLV' },
    { name: 'Southern Company', ticker: 'SO' },
    { name: 'Southwest Airlines', ticker: 'LUV' },
    { name: 'Stanley Black & Decker', ticker: 'SWK' },
    { name: 'Starbucks', ticker: 'SBUX' },
    { name: 'State Street', ticker: 'STT' },
    { name: 'Steel Dynamics', ticker: 'STLD' },
    { name: 'Steris', ticker: 'STE' },
    { name: 'Stryker', ticker: 'SYK' },
    { name: 'Supermicro', ticker: 'SMCI' },
    { name: 'Synchrony Financial', ticker: 'SYF' },
    { name: 'Synopsys', ticker: 'SNPS' },
    { name: 'Sysco', ticker: 'SYY' },
    { name: 'T-Mobile US', ticker: 'TMUS' },
    { name: 'T. Rowe Price', ticker: 'TROW' },
    { name: 'Take-Two Interactive', ticker: 'TTWO' },
    { name: 'Tapestry', ticker: 'TPR' },
    { name: 'Targa Resources', ticker: 'TRGP' },
    { name: 'Target', ticker: 'TGT' },
    { name: 'TE Connectivity', ticker: 'TEL' },
    { name: 'Teledyne Technologies', ticker: 'TDY' },
    { name: 'Teradyne', ticker: 'TER' },
    { name: 'Tesla', ticker: 'TSLA' },
    { name: 'Texas Instruments', ticker: 'TXN' },
    { name: 'Texas Pacific Land', ticker: 'TPL' },
    { name: 'Textron', ticker: 'TXT' },
    { name: 'Thermo Fisher Scientific', ticker: 'TMO' },
    { name: 'TJX Companies', ticker: 'TJX' },
    { name: 'TKO Group Holdings', ticker: 'TKO' },
    { name: 'Trade Desk', ticker: 'TTD' },
    { name: 'Tractor Supply', ticker: 'TSCO' },
    { name: 'Trane Technologies', ticker: 'TT' },
    { name: 'TransDigm Group', ticker: 'TDG' },
    { name: 'Travelers Companies', ticker: 'TRV' },
    { name: 'Trimble', ticker: 'TRMB' },
    { name: 'Truist Financial', ticker: 'TFC' },
    { name: 'Tyler Technologies', ticker: 'TYL' },
    { name: 'Tyson Foods', ticker: 'TSN' },
    { name: 'U.S. Bancorp', ticker: 'USB' },
    { name: 'Uber', ticker: 'UBER' },
    { name: 'UDR', ticker: 'UDR' },
    { name: 'Ulta Beauty', ticker: 'ULTA' },
    { name: 'Union Pacific', ticker: 'UNP' },
    { name: 'United Airlines Holdings', ticker: 'UAL' },
    { name: 'United Parcel Service', ticker: 'UPS' },
    { name: 'United Rentals', ticker: 'URI' },
    { name: 'UnitedHealth Group', ticker: 'UNH' },
    { name: 'Universal Health Services', ticker: 'UHS' },
    { name: 'Valero Energy', ticker: 'VLO' },
    { name: 'Veeva Systems', ticker: 'VEEV' },
    { name: 'Ventas', ticker: 'VTR' },
    { name: 'Veralto', ticker: 'VLTO' },
    { name: 'Verisign', ticker: 'VRSN' },
    { name: 'Verisk Analytics', ticker: 'VRSK' },
    { name: 'Verizon', ticker: 'VZ' },
    { name: 'Vertex Pharmaceuticals', ticker: 'VRTX' },
    { name: 'Vertiv', ticker: 'VRT' },
    { name: 'Viatris', ticker: 'VTRS' },
    { name: 'Vici Properties', ticker: 'VICI' },
    { name: 'Visa', ticker: 'V' },
    { name: 'Vistra', ticker: 'VST' },
    { name: 'Vulcan Materials Company', ticker: 'VMC' },
    { name: 'W. R. Berkley', ticker: 'WRB' },
    { name: 'W. W. Grainger', ticker: 'GWW' },
    { name: 'Wabtec', ticker: 'WAB' },
    { name: 'Walmart', ticker: 'WMT' },
    { name: 'Walt Disney', ticker: 'DIS' },
    { name: 'Warner Bros. Discovery', ticker: 'WBD' },
    { name: 'Waste Management', ticker: 'WM' },
    { name: 'Waters', ticker: 'WAT' },
    { name: 'WEC Energy Group', ticker: 'WEC' },
    { name: 'Wells Fargo', ticker: 'WFC' },
    { name: 'Welltower', ticker: 'WELL' },
    { name: 'West Pharmaceutical Services', ticker: 'WST' },
    { name: 'Western Digital', ticker: 'WDC' },
    { name: 'Weyerhaeuser', ticker: 'WY' },
    { name: 'Williams-Sonoma', ticker: 'WSM' },
    { name: 'Williams Companies', ticker: 'WMB' },
    { name: 'Willis Towers Watson', ticker: 'WTW' },
    { name: 'Workday', ticker: 'WDAY' },
    { name: 'Wynn Resorts', ticker: 'WYNN' },
    { name: 'Xcel Energy', ticker: 'XEL' },
    { name: 'Xylem', ticker: 'XYL' },
    { name: 'Yum! Brands', ticker: 'YUM' },
    { name: 'Zebra Technologies', ticker: 'ZBRA' },
    { name: 'Zimmer Biomet', ticker: 'ZBH' },
    { name: 'Zoetis', ticker: 'ZTS' },
  ],
  '^NDX': [
    { name: 'Adobe', ticker: 'ADBE' },
    { name: 'Advanced Micro Devices', ticker: 'AMD' },
    { name: 'Airbnb', ticker: 'ABNB' },
    { name: 'Alnylam Pharmaceuticals', ticker: 'ALNY' },
    { name: 'Alphabet (Class A)', ticker: 'GOOGL' },
    { name: 'Alphabet (Class C)', ticker: 'GOOG' },
    { name: 'Amazon', ticker: 'AMZN' },
    { name: 'American Electric Power', ticker: 'AEP' },
    { name: 'Amgen', ticker: 'AMGN' },
    { name: 'Analog Devices', ticker: 'ADI' },
    { name: 'Apple', ticker: 'AAPL' },
    { name: 'Applied Materials', ticker: 'AMAT' },
    { name: 'AppLovin', ticker: 'APP' },
    { name: 'Arm Holdings', ticker: 'ARM' },
    { name: 'ASML Holding', ticker: 'ASML' },
    { name: 'Astera Labs', ticker: 'ALAB' },
    { name: 'Autodesk', ticker: 'ADSK' },
    { name: 'Automatic Data Processing', ticker: 'ADP' },
    { name: 'Axon Enterprise', ticker: 'AXON' },
    { name: 'Baker Hughes', ticker: 'BKR' },
    { name: 'Booking Holdings', ticker: 'BKNG' },
    { name: 'Broadcom', ticker: 'AVGO' },
    { name: 'Cadence Design Systems', ticker: 'CDNS' },
    { name: 'Cintas', ticker: 'CTAS' },
    { name: 'Cisco', ticker: 'CSCO' },
    { name: 'Coca-Cola Europacific Partners', ticker: 'CCEP' },
    { name: 'Comcast', ticker: 'CMCSA' },
    { name: 'Constellation Energy', ticker: 'CEG' },
    { name: 'Copart', ticker: 'CPRT' },
    { name: 'CoreWeave', ticker: 'CRWV' },
    { name: 'Costco', ticker: 'COST' },
    { name: 'CrowdStrike', ticker: 'CRWD' },
    { name: 'CSX', ticker: 'CSX' },
    { name: 'Datadog', ticker: 'DDOG' },
    { name: 'DexCom', ticker: 'DXCM' },
    { name: 'Diamondback Energy', ticker: 'FANG' },
    { name: 'DoorDash', ticker: 'DASH' },
    { name: 'Electronic Arts', ticker: 'EA' },
    { name: 'Exelon', ticker: 'EXC' },
    { name: 'Fastenal', ticker: 'FAST' },
    { name: 'Ferrovial', ticker: 'FER' },
    { name: 'Fortinet', ticker: 'FTNT' },
    { name: 'GE HealthCare', ticker: 'GEHC' },
    { name: 'Gilead Sciences', ticker: 'GILD' },
    { name: 'Honeywell Technologies', ticker: 'HON' },
    { name: 'Idexx Laboratories', ticker: 'IDXX' },
    { name: 'Intel', ticker: 'INTC' },
    { name: 'Intuit', ticker: 'INTU' },
    { name: 'Intuitive Surgical', ticker: 'ISRG' },
    { name: 'Keurig Dr Pepper', ticker: 'KDP' },
    { name: 'KLA', ticker: 'KLAC' },
    { name: 'Kraft Heinz', ticker: 'KHC' },
    { name: 'Lam Research', ticker: 'LRCX' },
    { name: 'Linde plc', ticker: 'LIN' },
    { name: 'Lumentum', ticker: 'LITE' },
    { name: 'Marriott International', ticker: 'MAR' },
    { name: 'Marvell Technology', ticker: 'MRVL' },
    { name: 'Mercado Libre', ticker: 'MELI' },
    { name: 'Meta Platforms', ticker: 'META' },
    { name: 'Microchip Technology', ticker: 'MCHP' },
    { name: 'Micron Technology', ticker: 'MU' },
    { name: 'Microsoft', ticker: 'MSFT' },
    { name: 'MicroStrategy', ticker: 'MSTR' },
    { name: 'Mondelez International', ticker: 'MDLZ' },
    { name: 'Monolithic Power Systems', ticker: 'MPWR' },
    { name: 'Monster Beverage', ticker: 'MNST' },
    { name: 'Nebius Group', ticker: 'NBIS' },
    { name: 'Netflix', ticker: 'NFLX' },
    { name: 'Nvidia', ticker: 'NVDA' },
    { name: 'NXP Semiconductors', ticker: 'NXPI' },
    { name: "O'Reilly Automotive", ticker: 'ORLY' },
    { name: 'Old Dominion Freight Line', ticker: 'ODFL' },
    { name: 'Paccar', ticker: 'PCAR' },
    { name: 'Palantir Technologies', ticker: 'PLTR' },
    { name: 'Palo Alto Networks', ticker: 'PANW' },
    { name: 'Paychex', ticker: 'PAYX' },
    { name: 'PayPal', ticker: 'PYPL' },
    { name: 'PDD Holdings', ticker: 'PDD' },
    { name: 'PepsiCo', ticker: 'PEP' },
    { name: 'Qualcomm', ticker: 'QCOM' },
    { name: 'Regeneron Pharmaceuticals', ticker: 'REGN' },
    { name: 'Rocket Lab', ticker: 'RKLB' },
    { name: 'Roper Technologies', ticker: 'ROP' },
    { name: 'Ross Stores', ticker: 'ROST' },
    { name: 'Sandisk', ticker: 'SNDK' },
    { name: 'Seagate Technology', ticker: 'STX' },
    { name: 'Shopify', ticker: 'SHOP' },
    { name: 'Starbucks', ticker: 'SBUX' },
    { name: 'Synopsys', ticker: 'SNPS' },
    { name: 'T-Mobile US', ticker: 'TMUS' },
    { name: 'Take-Two Interactive', ticker: 'TTWO' },
    { name: 'Teradyne', ticker: 'TER' },
    { name: 'Tesla', ticker: 'TSLA' },
    { name: 'Texas Instruments', ticker: 'TXN' },
    { name: 'Thomson Reuters', ticker: 'TRI' },
    { name: 'Vertex Pharmaceuticals', ticker: 'VRTX' },
    { name: 'Walmart', ticker: 'WMT' },
    { name: 'Warner Bros. Discovery', ticker: 'WBD' },
    { name: 'Western Digital', ticker: 'WDC' },
    { name: 'Workday', ticker: 'WDAY' },
    { name: 'Xcel Energy', ticker: 'XEL' },
  ],
  '^DJI': [
    { name: 'UnitedHealth',   ticker: 'UNH'      },
    { name: 'Goldman Sachs',  ticker: 'GS'       },
    { name: 'Microsoft',      ticker: 'MSFT'     },
    { name: 'Home Depot',     ticker: 'HD'       },
    { name: 'McDonald\'s',    ticker: 'MCD'      },
    { name: 'Visa',           ticker: 'V'        },
    { name: 'Caterpillar',    ticker: 'CAT'      },
    { name: 'Amazon',         ticker: 'AMZN'     },
    { name: 'Salesforce',     ticker: 'CRM'      },
    { name: 'Apple',          ticker: 'AAPL'     },
    { name: 'JPMorgan',       ticker: 'JPM'      },
    { name: 'Amgen',          ticker: 'AMGN'     },
    { name: 'Boeing',         ticker: 'BA'       },
    { name: 'Procter & G.',   ticker: 'PG'       },
    { name: 'Honeywell',      ticker: 'HON'      },
    { name: 'Chevron',        ticker: 'CVX'      },
    { name: 'Johnson & J.',   ticker: 'JNJ'      },
    { name: 'American Exp.',  ticker: 'AXP'      },
    { name: 'Nike',           ticker: 'NKE'      },
    { name: 'IBM',            ticker: 'IBM'      },
    { name: 'Walmart',        ticker: 'WMT'      },
    { name: 'Disney',         ticker: 'DIS'      },
    { name: 'Merck',          ticker: 'MRK'      },
    { name: 'Cisco',          ticker: 'CSCO'     },
    { name: 'Coca-Cola',      ticker: 'KO'       },
    { name: 'Travelers',      ticker: 'TRV'      },
    { name: 'Verizon',        ticker: 'VZ'       },
    { name: '3M',             ticker: 'MMM'      },
    { name: 'Walgreens',      ticker: 'WBA'      },
    { name: 'Intel',          ticker: 'INTC'     },
  ],
}

const DIA_NOMBRE = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes' }
const DIA_CORTO  = { 1: 'Lu', 2: 'Ma', 3: 'Mi', 4: 'Ju', 5: 'Vi' }
const PAGE_SIZE  = 50

// Precios y puntos con separador de miles (24731.67 → 24,731.67)
const fmtPrecio = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Nombre amigable de un ticker: el label del índice/materia prima si es un preset,
// si no el nombre de la acción dentro de STOCKS, si no el ticker tal cual.
function nombreInstrumento(tkr) {
  const preset = PRESETS.find(p => p.value === tkr)
  if (preset) return preset.label
  for (const acciones of Object.values(STOCKS)) {
    const accion = acciones.find(s => s.ticker === tkr)
    if (accion) return accion.name
  }
  return tkr
}

// Lee los filtros de búsqueda desde la query string (para que una búsqueda sea
// compartible/recargable), con los mismos valores por defecto que sin URL.
function leerFiltrosDeURL() {
  const p = new URLSearchParams(window.location.search)
  return {
    ticker:         p.get('ticker') || '^GDAXI',
    dias:           p.has('dias')   ? new Set(p.get('dias').split(',').filter(Boolean).map(Number)) : new Set([1, 2, 3, 4, 5]),
    dir:            p.get('dir') || 'both',
    gapMin:         p.has('gapMin') ? parseFloat(p.get('gapMin')) || 0 : 0,
    gapModo:        p.get('gapModo') === 'pts' ? 'pts' : 'pct',
    meses:          p.has('meses')  ? parseInt(p.get('meses'), 10) || 12 : 12,
    eventosActivos: p.has('eventos') ? new Set(p.get('eventos').split(',').filter(Boolean)) : new Set(),
    diasEspeciales: p.has('diasEsp') ? new Set(p.get('diasEsp').split(',').filter(Boolean)) : new Set(),
  }
}

export default function FiltroGap() {
  const [filtrosURL] = useState(leerFiltrosDeURL)
  const [ticker,        setTicker]        = useState(filtrosURL.ticker)
  const [dias,          setDias]          = useState(filtrosURL.dias)
  const [dir,           setDir]           = useState(filtrosURL.dir)
  const [gapMin,        setGapMin]        = useState(filtrosURL.gapMin)
  const [gapModo,       setGapModo]       = useState(filtrosURL.gapModo) // 'pct' | 'pts'
  const [meses,         setMeses]         = useState(filtrosURL.meses)
  const [eventosActivos, setEventosActivos] = useState(filtrosURL.eventosActivos)
  const [cargando,      setCargando]      = useState(false)
  const [resultado,     setResultado]     = useState(null)
  const [error,         setError]         = useState(null)
  const [seleccion,     setSeleccion]     = useState(null)
  const [velas,         setVelas]         = useState([])
  const [fuenteVelas,   setFuenteVelas]   = useState(null)
  const [cargandoVelas, setCargandoVelas] = useState(false)
  const [timeframe,     setTimeframe]     = useState('m15')
  const [fechaManual,   setFechaManual]   = useState('')
  const [cotizacion,        setCotizacion]        = useState(null)
  const [cargandoCotizacion, setCargandoCotizacion] = useState(false)
  const abortVelasRef = useRef(null)

  // ── Modo multi-instrumento (fecha concreta) ──
  const [indiceAcciones, setIndiceAcciones] = useState(null)
  const [busquedaAccion, setBusquedaAccion] = useState('')
  const [instrManual, setInstrManual] = useState(new Set())
  const [velasMulti,  setVelasMulti]  = useState({})   // { ticker: {velas,fuente,loading} }
  const [fechaMulti,  setFechaMulti]  = useState(null)
  const abortMultiRef = useRef({})
  const [pagina,         setPagina]         = useState(0)
  const [diasEspeciales, setDiasEspeciales] = useState(filtrosURL.diasEspeciales)
  const [exportando,     setExportando]     = useState(false)
  const [exportProgreso, setExportProgreso] = useState(null)  // { done, total }

  const toggleDia = n => setDias(prev => {
    const s = new Set(prev); s.has(n) ? s.delete(n) : s.add(n); return s
  })

  const toggleEvento = id => setEventosActivos(prev => {
    const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
  })

  const toggleInstrManual = val => setInstrManual(prev => {
    const s = new Set(prev); s.has(val) ? s.delete(val) : s.add(val); return s
  })

  const toggleDiaEspecial = id => setDiasEspeciales(prev => {
    const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s
  })

  // Calcula qué fechas son primer/último día de negociación del mes y del trimestre
  const fechasEspeciales = useMemo(() => {
    const all = resultado?.sesiones ?? []
    if (all.length === 0) return null
    const byMes = {}
    for (const s of all) {
      const key = s.date.slice(0, 7) // 'YYYY-MM'
      if (!byMes[key]) byMes[key] = []
      byMes[key].push(s.date)
    }
    const primerMes    = new Set()
    const ultimoMes    = new Set()
    const primerTrim   = new Set()
    const ultimoTrim   = new Set()
    const inicioTrim   = new Set(['01','04','07','10'])
    const finTrim      = new Set(['03','06','09','12'])
    for (const [key, fechas] of Object.entries(byMes)) {
      const ord = [...fechas].sort()
      const mes = key.slice(5, 7)
      primerMes.add(ord[0])
      ultimoMes.add(ord[ord.length - 1])
      if (inicioTrim.has(mes)) primerTrim.add(ord[0])
      if (finTrim.has(mes))    ultimoTrim.add(ord[ord.length - 1])
    }
    return { primerMes, ultimoMes, primerTrim, ultimoTrim }
  }, [resultado])

  // Filtrado secundario por evento y día especial (client-side, instantáneo)
  const sesionesVisibles = (() => {
    let all = resultado?.sesiones ?? []
    if (eventosActivos.size > 0)
      all = all.filter(s => s.eventos?.some(e => eventosActivos.has(e)))
    if (diasEspeciales.size > 0 && fechasEspeciales)
      all = all.filter(s =>
        (diasEspeciales.has('primerMes')  && fechasEspeciales.primerMes.has(s.date))  ||
        (diasEspeciales.has('ultimoMes')  && fechasEspeciales.ultimoMes.has(s.date))  ||
        (diasEspeciales.has('primerTrim') && fechasEspeciales.primerTrim.has(s.date)) ||
        (diasEspeciales.has('ultimoTrim') && fechasEspeciales.ultimoTrim.has(s.date))
      )
    return all
  })()

  // Paginación: orden descendente (más reciente primero) para ver datos actuales sin scroll
  const sesionesOrdenadas = [...sesionesVisibles].reverse()
  const totalPaginas      = Math.max(1, Math.ceil(sesionesOrdenadas.length / PAGE_SIZE))
  const sesionsPagina     = sesionesOrdenadas.slice(pagina * PAGE_SIZE, (pagina + 1) * PAGE_SIZE)

  // Resetear página al cambiar resultados o filtros secundarios
  useEffect(() => { setPagina(0) }, [resultado, eventosActivos, diasEspeciales])

  const buscar = async () => {
    if (!ticker.trim() || dias.size === 0) return
    setCargando(true)
    setError(null)
    setResultado(null)
    setSeleccion(null)
    setVelas([])
    setFuenteVelas(null)
    setVelasMulti({})
    setFechaMulti(null)
    try {
      const p = new URLSearchParams({
        ticker: ticker.trim(),
        dias:   [...dias].sort().join(','),
        dir,
        gapMin,
        gapModo,
        meses,
        ...(diasEspeciales.size > 0 ? { diasEsp: [...diasEspeciales].join(',') } : {}),
      })
      const res  = await fetch(`/api/gap-filter?${p}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResultado(data)
      if (data.sesiones.length > 0) setSeleccion(data.sesiones[data.sesiones.length - 1])
    } catch (e) {
      setError(e.message)
    } finally {
      setCargando(false)
    }
  }

  // Si se abre un enlace con una búsqueda ya en la URL, la relanza automáticamente
  useEffect(() => {
    if (window.location.search) buscar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mantiene la URL sincronizada con los filtros actuales, para que la búsqueda
  // sea compartible por enlace y sobreviva a recargar la página
  useEffect(() => {
    const p = new URLSearchParams({
      ticker: ticker.trim(),
      dias:   [...dias].sort().join(','),
      dir,
      gapMin,
      gapModo,
      meses,
      ...(eventosActivos.size > 0 ? { eventos: [...eventosActivos].join(',') } : {}),
      ...(diasEspeciales.size > 0 ? { diasEsp: [...diasEspeciales].join(',') } : {}),
    })
    window.history.replaceState(null, '', `?${p}`)
  }, [ticker, dias, dir, gapMin, gapModo, meses, eventosActivos, diasEspeciales])

  // Genera el PPT con el gráfico intradía de cada coincidencia (una llamada + un render
  // por sesión, igual que al hacer clic en una sesión en la lista de resultados).
  const exportarPPT = async () => {
    const lista = sesionesVisibles
    if (lista.length === 0) return
    const tkr = resultado?.ticker ?? ticker
    setExportando(true)
    setError(null)
    setExportProgreso({ done: 0, total: lista.length })
    try {
      const sesionesConGrafico = []
      for (const s of lista) {
        let imagen = null
        try {
          const r = await fetch(intradayUrl(tkr, s.date, timeframe))
          const d = await r.json()
          if (d.velas?.length) {
            imagen = await capturarVelasPNG({
              velas: d.velas, ticker: tkr, prevClose: s.prevClose, openPrice: s.openPrice,
            })
          }
        } catch { /* sin gráfico para esta sesión, se marcará como "sin datos" en el PPT */ }
        sesionesConGrafico.push({ ...s, imagen })
        setExportProgreso(prev => ({ done: prev.done + 1, total: prev.total }))
      }
      setExportProgreso(null)

      const resp = await fetch('/api/export-ppt', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker:   tkr,
          sesiones: sesionesConGrafico,
          filtros: {
            dias:    [...dias].sort().join(', '),
            dir,
            gapMin,
            gapModo,
            periodo: PERIODOS.find(p => p.meses === meses)?.label,
          },
        }),
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        throw new Error(data.error ?? 'Error generando la presentación')
      }
      const blob = await resp.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `situational-analysis-${tkr}.pptx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e.message)
    } finally {
      setExportando(false)
      setExportProgreso(null)
    }
  }

  const irAFecha = () => {
    if (!fechaManual) return
    if (instrManual.size === 0) {
      // Sin chips seleccionados → comportamiento anterior (un solo ticker)
      setVelasMulti({})
      setFechaMulti(null)
      setSeleccion({ date: fechaManual })
      setVelas([])
    } else {
      // Multi-instrumento
      setSeleccion(null)
      setVelas([])
      Object.values(abortMultiRef.current).forEach(c => c.abort())
      abortMultiRef.current = {}
      const tickers = [...instrManual]
      const init = {}
      tickers.forEach(t => { init[t] = { velas: [], fuente: null, loading: true } })
      setVelasMulti(init)
      setFechaMulti(fechaManual)
      tickers.forEach(tkr => {
        const ctrl = new AbortController()
        abortMultiRef.current[tkr] = ctrl
        fetch(intradayUrl(tkr, fechaManual, timeframe), { signal: ctrl.signal })
          .then(r => r.json())
          .then(d => {
            if (!ctrl.signal.aborted)
              setVelasMulti(prev => ({ ...prev, [tkr]: { velas: d.velas ?? [], fuente: d.fuente ?? null, loading: false } }))
          })
          .catch(e => {
            if (e.name !== 'AbortError')
              setVelasMulti(prev => ({ ...prev, [tkr]: { velas: [], fuente: null, loading: false } }))
          })
      })
    }
  }

  const cancelarVelas = () => {
    abortVelasRef.current?.abort()
    setCargandoVelas(false)
  }

  // Carga velas intraday cuando cambia la sesión seleccionada o el timeframe
  useEffect(() => {
    if (!seleccion) return
    const controller = new AbortController()
    abortVelasRef.current = controller
    const tkr = resultado?.ticker ?? ticker
    setCargandoVelas(true)
    setVelas([])
    fetch(intradayUrl(tkr, seleccion.date, timeframe), { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (controller.signal.aborted) return
        if (d.velas?.length) setVelas(d.velas)
        setFuenteVelas(d.fuente ?? null)
      })
      .catch(e => { if (e.name !== 'AbortError') console.error(e) })
      .finally(() => { if (!controller.signal.aborted) setCargandoVelas(false) })
    return () => controller.abort()
  }, [seleccion, timeframe])

  // Última cotización del ticker escrito/seleccionado, junto al buscador de instrumento
  // (debounced para no disparar una petición por cada letra tecleada)
  useEffect(() => {
    const tkr = ticker.trim()
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (!tkr) { setCotizacion(null); return }
      setCargandoCotizacion(true)
      fetch(`/api/ultima-cotizacion?ticker=${encodeURIComponent(tkr)}`, { signal: controller.signal })
        .then(r => r.json())
        .then(d => { if (!controller.signal.aborted) setCotizacion(d.error ? null : d) })
        .catch(e => { if (e.name !== 'AbortError') setCotizacion(null) })
        .finally(() => { if (!controller.signal.aborted) setCargandoCotizacion(false) })
    }, 500)
    return () => { clearTimeout(timer); controller.abort() }
  }, [ticker])

  return (
    <div className="filtro-page">

      {/* ── Panel de controles ── */}
      <div className="filtro-controls">

        <div className="filtro-group">
          <label className="filtro-label">Instrumento</label>
          <div className="filtro-ticker-row">
            <input
              className="filtro-input"
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && buscar()}
              placeholder="^GDAXI, ^GSPC…"
            />
            {cargandoCotizacion && <span className="spinner" />}
            {!cargandoCotizacion && cotizacion && (
              <div className="ultima-cotizacion" title={`Cierre ${cotizacion.date}`}>
                <span className="ultima-cotizacion-precio">{fmtPrecio(cotizacion.price)}</span>
                {cotizacion.changePct != null && (
                  <span className={`ultima-cotizacion-var ${cotizacion.changePct >= 0 ? 'verde' : 'rojo'}`}>
                    {cotizacion.changePct > 0 ? '+' : ''}{cotizacion.changePct.toFixed(2)}%
                    {cotizacion.changePts != null && (
                      <span className="ultima-cotizacion-pts">
                        {' '}({cotizacion.changePts > 0 ? '+' : ''}{fmtPrecio(cotizacion.changePts)})
                      </span>
                    )}
                  </span>
                )}
                {cotizacion.prevClose != null && (
                  <span className="ultima-cotizacion-prev">Ant. {fmtPrecio(cotizacion.prevClose)}</span>
                )}
              </div>
            )}
          </div>
          <div className="filtro-presets">
            {PRESETS.map(p => (
              <button
                key={p.value}
                className={`chip ${ticker === p.value ? 'activo' : ''}`}
                onClick={() => {
                  setTicker(p.value)
                  setIndiceAcciones(STOCKS[p.value] ? p.value : null)
                  setBusquedaAccion('')
                }}
              >{p.label}</button>
            ))}
          </div>

          {/* ── Acciones del índice seleccionado ── */}
          {indiceAcciones && STOCKS[indiceAcciones] && (() => {
            const q = busquedaAccion.trim().toLowerCase()
            const acciones = STOCKS[indiceAcciones]
            const filtradas = q
              ? acciones.filter(s => s.name.toLowerCase().includes(q) || s.ticker.toLowerCase().includes(q))
              : acciones
            return (
              <div className="acciones-panel">
                <div className="acciones-header">
                  <span>Acciones · {PRESETS.find(p => p.value === indiceAcciones)?.label}</span>
                  <button
                    className="clear-eventos"
                    onClick={() => { setIndiceAcciones(null); setBusquedaAccion('') }}
                  >× cerrar</button>
                </div>
                <input
                  type="text"
                  className="acciones-buscador"
                  placeholder="Buscar empresa o ticker…"
                  value={busquedaAccion}
                  onChange={e => setBusquedaAccion(e.target.value)}
                />
                <select
                  className="acciones-select"
                  value={filtradas.some(s => s.ticker === ticker) ? ticker : ''}
                  onChange={e => setTicker(e.target.value)}
                  disabled={filtradas.length === 0}
                >
                  <option value="" disabled>
                    {filtradas.length === 0 ? 'Sin resultados' : `Elegir acción… (${filtradas.length})`}
                  </option>
                  {filtradas.map(s => (
                    <option key={s.ticker} value={s.ticker}>{s.name} · {s.ticker}</option>
                  ))}
                </select>
              </div>
            )
          })()}
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Día de la semana</label>
          <div className="filtro-dias">
            {DIAS.map(d => (
              <button
                key={d.n}
                className={`dia-chip ${dias.has(d.n) ? 'activo' : ''}`}
                onClick={() => toggleDia(d.n)}
                title={d.nombre}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Dirección del gap</label>
          <div className="filtro-dir">
            {[
              { v: 'both', label: '↕  Ambos'      },
              { v: 'up',   label: '▲  Gap arriba' },
              { v: 'down', label: '▼  Gap abajo'  },
            ].map(d => (
              <button
                key={d.v}
                className={`dir-chip ${dir === d.v ? 'activo' : ''}`}
                onClick={() => setDir(d.v)}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Gap mínimo&nbsp;
            <span className="filtro-valor">
              {gapMin === 0 ? 'cualquiera' : `≥ ${gapMin}${gapModo === 'pct' ? '%' : ' pts'}`}
            </span>
          </label>
          <div className="gap-modo-row">
            <select
              className="gap-modo-select"
              value={gapModo}
              onChange={e => { setGapModo(e.target.value); setGapMin(0) }}
            >
              <option value="pct">%</option>
              <option value="pts">Puntos</option>
            </select>
            {gapModo === 'pct' ? (
              <div className="filtro-gap-sizes">
                {GAP_SIZES.map(g => (
                  <button
                    key={g}
                    className={`gap-chip ${gapMin === g ? 'activo' : ''}`}
                    onClick={() => setGapMin(g)}
                  >{g === 0 ? 'Todos' : `${g}%`}</button>
                ))}
              </div>
            ) : (
              <>
                <div className="filtro-gap-sizes">
                  {[0, ...(GAP_PTS_SUGERIDOS[ticker] ?? GAP_PTS_DEFAULT)].map(g => (
                    <button
                      key={g}
                      className={`gap-chip ${gapMin === g ? 'activo' : ''}`}
                      onClick={() => setGapMin(g)}
                    >{g === 0 ? 'Todos' : g}</button>
                  ))}
                </div>
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  className="filtro-input-puntos"
                  placeholder="Personalizado"
                  value={gapMin === 0 ? '' : gapMin}
                  onChange={e => setGapMin(e.target.value === '' ? 0 : parseFloat(e.target.value) || 0)}
                />
              </>
            )}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">Histórico</label>
          <div className="filtro-periodos">
            {PERIODOS.map(p => (
              <button
                key={p.meses}
                className={`periodo-chip ${meses === p.meses ? 'activo' : ''}`}
                onClick={() => setMeses(p.meses)}
              >{p.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Evento económico
            {eventosActivos.size > 0 && (
              <button className="clear-eventos" onClick={() => setEventosActivos(new Set())}>
                × limpiar
              </button>
            )}
          </label>
          <div className="filtro-eventos">
            {EVENTOS_DEF.map(ev => (
              <button
                key={ev.id}
                className={`evento-chip ev-${ev.id.toLowerCase()} ${eventosActivos.has(ev.id) ? 'activo' : ''}`}
                onClick={() => toggleEvento(ev.id)}
                title={ev.title}
              >{ev.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Día especial
            {diasEspeciales.size > 0 && (
              <button className="clear-eventos" onClick={() => setDiasEspeciales(new Set())}>× limpiar</button>
            )}
          </label>
          <div className="filtro-dias-esp">
            {[
              { id: 'primerMes',  label: '1º mes',       title: 'Primer día de negociación del mes' },
              { id: 'ultimoMes',  label: 'Último mes',   title: 'Último día de negociación del mes' },
              { id: 'primerTrim', label: '1º trim.',      title: 'Primer día de negociación del trimestre (ene/abr/jul/oct)' },
              { id: 'ultimoTrim', label: 'Último trim.', title: 'Último día de negociación del trimestre (mar/jun/sep/dic)' },
            ].map(d => (
              <button
                key={d.id}
                className={`dia-esp-chip ${diasEspeciales.has(d.id) ? 'activo' : ''}`}
                onClick={() => toggleDiaEspecial(d.id)}
                title={d.title}
              >{d.label}</button>
            ))}
          </div>
        </div>

        <div className="filtro-group">
          <label className="filtro-label">
            Ir a fecha concreta
            {instrManual.size > 0 && (
              <button className="clear-eventos" onClick={() => setInstrManual(new Set())}>× limpiar</button>
            )}
          </label>
          <div className="fecha-manual-row">
            <input
              type="date"
              className="filtro-input-fecha"
              value={fechaManual}
              onChange={e => setFechaManual(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && irAFecha()}
            />
            <button
              className="btn-ir-fecha"
              onClick={irAFecha}
              disabled={!fechaManual}
            >Ver</button>
          </div>
          <div className="filtro-presets" style={{ marginTop: '0.4rem' }}>
            {PRESETS.map(p => (
              <button
                key={p.value}
                className={`chip ${instrManual.has(p.value) ? 'activo' : ''}`}
                onClick={() => toggleInstrManual(p.value)}
              >{p.label}</button>
            ))}
          </div>
          {instrManual.size > 0 && (
            <p className="instr-manual-hint">
              {instrManual.size === 1 ? '1 instrumento' : `${instrManual.size} instrumentos`} seleccionados
            </p>
          )}
        </div>

        <button
          className="btn-filtrar"
          onClick={buscar}
          disabled={cargando || dias.size === 0}
        >
          {cargando
            ? <><span className="spinner" /> Cargando…</>
            : '🔍  Filtrar sesiones'}
        </button>

        {resultado && (
          <div className="filtro-resumen">
            <strong>{sesionesVisibles.length}</strong>
            {sesionesVisibles.length !== resultado.total && (
              <span className="resumen-filtrado"> / {resultado.total}</span>
            )}
            {' '}sesión{sesionesVisibles.length !== 1 ? 'es' : ''} · {resultado.ticker}
            {resultado.fuente      && <span className="resumen-fuente"> · {resultado.fuente}</span>}
            {resultado.fechaInicio && <span className="resumen-desde"> · desde {resultado.fechaInicio}</span>}
          </div>
        )}

        {resultado && sesionesVisibles.length > 0 && (
          <button
            className="btn-exportar-ppt"
            onClick={exportarPPT}
            disabled={exportando}
          >
            {exportando
              ? <><span className="spinner" /> {exportProgreso
                    ? `Generando gráficos… ${exportProgreso.done}/${exportProgreso.total}`
                    : 'Generando PPT…'}</>
              : `📊  Exportar ${sesionesVisibles.length} gráficos a PPT`}
          </button>
        )}
      </div>

      {/* ── Resultados ── */}
      <div className="filtro-resultados">
        {error && <p className="error-global">{error}</p>}

        {resultado && sesionesVisibles.length === 0 && (
          <div className="filtro-vacio">
            Sin sesiones con esos filtros.
            {eventosActivos.size > 0 && ' Prueba quitando algún filtro de evento.'}
          </div>
        )}

        <div className={resultado && sesionesVisibles.length > 0 ? 'filtro-split' : ''}>

          {/* Lista de sesiones (solo cuando hay resultados del filtro) */}
          {resultado && sesionesVisibles.length > 0 && (
            <div className="sesiones-lista">
              {sesionsPagina.map(s => (
                <SesionCard
                  key={s.date}
                  sesion={s}
                  activo={seleccion?.date === s.date}
                  onClick={() => { setSeleccion(s); setVelasMulti({}); setFechaMulti(null) }}
                />
              ))}
              {totalPaginas > 1 && (
                <div className="paginacion">
                  <button
                    className="pag-btn"
                    onClick={() => setPagina(p => Math.max(0, p - 1))}
                    disabled={pagina === 0}
                  >← Anterior</button>
                  <span className="pag-info">{pagina + 1} / {totalPaginas}</span>
                  <button
                    className="pag-btn"
                    onClick={() => setPagina(p => Math.min(totalPaginas - 1, p + 1))}
                    disabled={pagina >= totalPaginas - 1}
                  >Siguiente →</button>
                </div>
              )}
            </div>
          )}

          {/* Detalle / gráfico (visible tanto para selecciones de lista como manuales) */}
          {seleccion && (
            <div className="sesion-detalle">
              <div className="sesion-detalle-header">
                <div className="sesion-detalle-titulo">
                  <span className="sesion-detalle-instrumento">{nombreInstrumento(resultado?.ticker ?? ticker)}</span>
                  <span className="sesion-detalle-fecha">{seleccion.date}</span>
                  {seleccion.dayOfWeek && (
                    <span className="sesion-detalle-dia">{DIA_NOMBRE[seleccion.dayOfWeek]}</span>
                  )}
                  {seleccion.gapDir && (
                    <span className={`gap-pill ${seleccion.gapDir}`}>
                      {seleccion.gapDir === 'up' ? '▲' : '▼'}
                      {seleccion.gapPct > 0 ? ' +' : ' '}{seleccion.gapPct.toFixed(3)}%
                      {seleccion.prevClose != null && seleccion.openPrice != null && (
                        <span className="gap-pill-pts">
                          {' '}({seleccion.openPrice - seleccion.prevClose > 0 ? '+' : ''}
                          {fmtPrecio(seleccion.openPrice - seleccion.prevClose)} pts)
                        </span>
                      )}
                    </span>
                  )}
                  {seleccion.eventos?.map(e => (
                    <span key={e} className={`ev-badge ev-${e.toLowerCase()}`}>{e}</span>
                  ))}
                </div>
                {seleccion.prevClose != null && (
                  <div className="sesion-detalle-meta">
                    Cierre anterior&nbsp;
                    <strong>{fmtPrecio(seleccion.prevClose)}</strong>
                    &nbsp;→ Apertura&nbsp;
                    <strong>{fmtPrecio(seleccion.openPrice)}</strong>
                    {velas.length > 0 && (
                      <>&nbsp;·&nbsp;{velas.length} velas
                        {fuenteVelas && (
                          <span className={`fuente-tag ${fuenteVelas.startsWith('Duka') ? 'dukascopy' : fuenteVelas.startsWith('Stooq') ? 'stooq' : 'yahoo'}`}>
                            {fuenteVelas}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}
                {seleccion.prevClose == null && velas.length > 0 && (
                  <div className="sesion-detalle-meta">
                    {velas.length} velas
                    {fuenteVelas && (
                      <span className={`fuente-tag ${fuenteVelas.startsWith('Duka') ? 'dukascopy' : fuenteVelas.startsWith('Stooq') ? 'stooq' : 'yahoo'}`}>
                        {fuenteVelas}
                      </span>
                    )}
                  </div>
                )}
                <div className="tf-selector">
                  {[
                    { label: '1m',  duka: 'm1'  },
                    { label: '5m',  duka: 'm5'  },
                    { label: '15m', duka: 'm15' },
                    { label: '30m', duka: 'm30' },
                    { label: '1h',  duka: 'h1'  },
                  ].map(tf => (
                    <button
                      key={tf.duka}
                      className={`tf-chip ${timeframe === tf.duka ? 'activo' : ''}`}
                      onClick={() => setTimeframe(tf.duka)}
                    >{tf.label}</button>
                  ))}
                </div>
              </div>

              {cargandoVelas && (
                <div className="velas-cargando">
                  <span className="spinner" /> Cargando velas…
                  <button className="btn-cancelar-velas" onClick={cancelarVelas}>✕ Cancelar</button>
                </div>
              )}

              {!cargandoVelas && velas.length > 0 && (
                <>
                  {(fuenteVelas === 'Stooq 1d' || fuenteVelas === 'Dukascopy 1d') && (
                    <div className="filtro-vacio" style={{ marginBottom: '0.5rem', fontSize: '0.78rem' }}>
                      Sin datos intraday disponibles · mostrando barra diaria
                    </div>
                  )}
                  <GraficoVelas
                    velas={velas}
                    patrones={[]}
                    ticker={resultado?.ticker ?? ticker}
                    prevClose={seleccion.prevClose}
                    openPrice={seleccion.openPrice}
                    herramientas
                  />
                  <VelasTabla velas={velas} />
                </>
              )}

              {!cargandoVelas && velas.length === 0 && (() => {
                const tkr = resultado?.ticker ?? ticker
                const esAccion = !DUKA_TICKERS.has(tkr)
                return (
                  <div className="filtro-vacio">
                    {esAccion
                      ? <>Sin datos intraday para <strong>{tkr}</strong> en esta fecha.</>
                      : 'No hay datos intraday disponibles para esta fecha.'}
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        {/* ── Multi-chart (fecha concreta con varios instrumentos) ── */}
        {Object.keys(velasMulti).length > 0 && (
          <div className="multi-charts-section">
            <div className="multi-charts-header">
              <span className="multi-charts-fecha">{fechaMulti}</span>
              <div className="tf-selector">
                {[
                  { label: '1m',  duka: 'm1'  },
                  { label: '5m',  duka: 'm5'  },
                  { label: '15m', duka: 'm15' },
                  { label: '30m', duka: 'm30' },
                  { label: '1h',  duka: 'h1'  },
                ].map(tf => (
                  <button
                    key={tf.duka}
                    className={`tf-chip ${timeframe === tf.duka ? 'activo' : ''}`}
                    onClick={() => setTimeframe(tf.duka)}
                  >{tf.label}</button>
                ))}
              </div>
              <button className="btn-ir-fecha" onClick={irAFecha} disabled={!fechaManual}>↺ Recargar</button>
            </div>
            <div className="multi-charts-grid">
              {Object.entries(velasMulti).map(([tkr, { velas: v, fuente, loading }]) => (
                <div key={tkr} className="multi-chart-item">
                  <div className="multi-chart-nombre">
                    {PRESETS.find(p => p.value === tkr)?.label ?? tkr}
                    {fuente && (
                      <span className={`fuente-tag ${fuente.startsWith('Duka') ? 'dukascopy' : 'yahoo'}`}>
                        {fuente}
                      </span>
                    )}
                  </div>
                  {loading ? (
                    <div className="velas-cargando"><span className="spinner" /> Cargando…</div>
                  ) : v.length > 0 ? (
                    <GraficoVelas velas={v} patrones={[]} ticker={tkr} />
                  ) : (
                    <div className="filtro-vacio">Sin datos para {fechaMulti}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SesionCard({ sesion, activo, onClick }) {
  const up = sesion.gapDir === 'up'
  return (
    <div
      className={`sesion-card ${up ? 'up' : 'down'} ${activo ? 'activo' : ''}`}
      onClick={onClick}
    >
      <div className="sesion-card-izq">
        <span className="sesion-card-dia">{DIA_CORTO[sesion.dayOfWeek]}</span>
        <span className="sesion-card-fecha">{sesion.date}</span>
      </div>
      <div className={`sesion-card-gap ${up ? 'verde' : 'rojo'}`}>
        {up ? '▲' : '▼'} {sesion.gapPct > 0 ? '+' : ''}{sesion.gapPct.toFixed(3)}%
        <span className="sesion-card-gap-pts">
          {' '}({sesion.openPrice - sesion.prevClose > 0 ? '+' : ''}
          {fmtPrecio(sesion.openPrice - sesion.prevClose)})
        </span>
      </div>
      <div className="sesion-card-derecha">
        <div className="sesion-card-precios">
          {fmtPrecio(sesion.prevClose)} → {fmtPrecio(sesion.openPrice)}
        </div>
        {sesion.eventos?.length > 0 && (
          <div className="sesion-card-eventos">
            {sesion.eventos.map(e => (
              <span key={e} className={`ev-badge ev-${e.toLowerCase()}`}>{e}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function VelasTabla({ velas }) {
  const fmtHora = ts => new Date(ts * 1000).toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit',
  })
  return (
    <div className="velas-tabla-wrap">
      <table className="velas-tabla">
        <thead>
          <tr>
            <th>Hora</th><th>Open</th><th>High</th><th>Low</th><th>Close</th>
            <th>Rango</th><th>Dir</th>
          </tr>
        </thead>
        <tbody>
          {velas.map(v => {
            const alcista = v.close >= v.open
            return (
              <tr key={v.time} className={alcista ? 'fila-up' : 'fila-down'}>
                <td>{fmtHora(v.time)}</td>
                <td>{fmtPrecio(v.open)}</td>
                <td>{fmtPrecio(v.high)}</td>
                <td>{fmtPrecio(v.low)}</td>
                <td><strong>{fmtPrecio(v.close)}</strong></td>
                <td>{fmtPrecio(v.high - v.low)}</td>
                <td>{alcista ? '▲' : '▼'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
