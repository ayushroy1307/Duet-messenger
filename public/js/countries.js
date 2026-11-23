// [ISO-3166 alpha-2, name, dial code]. Numbers are normalised to E.164 before leaving the device.
export const COUNTRIES = [
  ['IN', 'India', '91'], ['US', 'United States', '1'], ['CA', 'Canada', '1'], ['GB', 'United Kingdom', '44'], ['AU', 'Australia', '61'],
  ['NZ', 'New Zealand', '64'], ['IE', 'Ireland', '353'], ['DE', 'Germany', '49'], ['FR', 'France', '33'], ['ES', 'Spain', '34'],
  ['IT', 'Italy', '39'], ['NL', 'Netherlands', '31'], ['BE', 'Belgium', '32'], ['CH', 'Switzerland', '41'], ['AT', 'Austria', '43'],
  ['SE', 'Sweden', '46'], ['NO', 'Norway', '47'], ['DK', 'Denmark', '45'], ['FI', 'Finland', '358'], ['PL', 'Poland', '48'],
  ['PT', 'Portugal', '351'], ['GR', 'Greece', '30'], ['TR', 'Türkiye', '90'], ['UA', 'Ukraine', '380'], ['RU', 'Russia', '7'],
  ['AE', 'United Arab Emirates', '971'], ['SA', 'Saudi Arabia', '966'], ['IL', 'Israel', '972'], ['EG', 'Egypt', '20'], ['NG', 'Nigeria', '234'],
  ['KE', 'Kenya', '254'], ['ZA', 'South Africa', '27'], ['GH', 'Ghana', '233'], ['PK', 'Pakistan', '92'], ['BD', 'Bangladesh', '880'],
  ['LK', 'Sri Lanka', '94'], ['NP', 'Nepal', '977'], ['BT', 'Bhutan', '975'], ['MV', 'Maldives', '960'], ['CN', 'China', '86'],
  ['HK', 'Hong Kong', '852'], ['TW', 'Taiwan', '886'], ['JP', 'Japan', '81'], ['KR', 'South Korea', '82'], ['SG', 'Singapore', '65'],
  ['MY', 'Malaysia', '60'], ['TH', 'Thailand', '66'], ['VN', 'Vietnam', '84'], ['ID', 'Indonesia', '62'], ['PH', 'Philippines', '63'],
  ['BR', 'Brazil', '55'], ['AR', 'Argentina', '54'], ['MX', 'Mexico', '52'], ['CL', 'Chile', '56'], ['CO', 'Colombia', '57'], ['PE', 'Peru', '51'],
];
export const flag = (iso) => String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

export function defaultCountry() {
  const region = (navigator.language || 'en-IN').split('-')[1]?.toUpperCase();
  return COUNTRIES.find((c) => c[0] === region)?.[0] || 'IN';
}
/** Returns an E.164 string, or throws an Error with a plain-language message. */
export function toE164(iso, national) {
  const raw = String(national || '').trim();
  if (raw.startsWith('+')) { const d = raw.replace(/\D/g, ''); if (d.length < 8 || d.length > 15) throw new Error('That number does not look right.'); return '+' + d; }
  const dial = COUNTRIES.find((c) => c[0] === iso)?.[2];
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  if (!dial || digits.length < 5 || digits.length + dial.length > 15) throw new Error('That number does not look right.');
  return '+' + dial + digits;
}
