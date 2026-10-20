// Singapore postal code -> URA planning area.
//
// A 6-digit Singapore postal code starts with a 2-digit "postal sector". Each
// sector sits inside one postal district, and almost all of a sector's
// addresses fall inside one planning area. This table maps each sector to its
// dominant planning area. It is an approximation: a handful of sectors straddle
// planning-area boundaries. In production, swap `lookupArea` for a call to the
// OneMap geocoding API (postal code -> lat/lng -> planning area polygon).

const SECTOR_TO_AREA = {
  '01': 'Downtown Core', '02': 'Downtown Core', '03': 'Downtown Core',
  '04': 'Downtown Core', '05': 'Downtown Core', '06': 'Downtown Core',
  '07': 'Outram', '08': 'Outram',
  '09': 'Bukit Merah', '10': 'Bukit Merah',
  '11': 'Queenstown', '12': 'Clementi', '13': 'Queenstown',
  '14': 'Queenstown', '15': 'Bukit Merah', '16': 'Bukit Merah',
  '17': 'Downtown Core', '18': 'Downtown Core', '19': 'Rochor',
  '20': 'Kallang', '21': 'Rochor',
  '22': 'River Valley', '23': 'Orchard',
  '24': 'Tanglin', '25': 'Tanglin', '26': 'Bukit Timah', '27': 'Bukit Timah',
  '28': 'Novena', '29': 'Novena', '30': 'Novena',
  '31': 'Toa Payoh', '32': 'Novena', '33': 'Kallang',
  '34': 'Geylang', '35': 'Toa Payoh', '36': 'Geylang', '37': 'Geylang',
  '38': 'Geylang', '39': 'Geylang', '40': 'Geylang', '41': 'Geylang',
  '42': 'Marine Parade', '43': 'Marine Parade', '44': 'Marine Parade', '45': 'Marine Parade',
  '46': 'Bedok', '47': 'Bedok', '48': 'Bedok',
  '49': 'Changi', '50': 'Pasir Ris', '81': 'Changi',
  '51': 'Pasir Ris', '52': 'Tampines',
  '53': 'Hougang', '54': 'Sengkang', '55': 'Serangoon', '82': 'Punggol',
  '56': 'Ang Mo Kio', '57': 'Bishan',
  '58': 'Bukit Timah', '59': 'Bukit Timah',
  '60': 'Jurong East', '61': 'Jurong West', '62': 'Jurong West',
  '63': 'Jurong West', '64': 'Jurong West',
  '65': 'Bukit Batok', '66': 'Bukit Panjang', '67': 'Bukit Panjang', '68': 'Choa Chu Kang',
  '69': 'Lim Chu Kang', '70': 'Tengah', '71': 'Lim Chu Kang',
  '72': 'Woodlands', '73': 'Woodlands',
  '75': 'Sembawang', '76': 'Yishun',
  '77': 'Bishan', '78': 'Seletar',
  '79': 'Seletar', '80': 'Seletar',
};

const POSTAL_RE = /^\d{6}$/;

/** Returns the planning area for a postal code, or null if it isn't a valid SG code. */
function lookupArea(postalCode) {
  if (typeof postalCode !== 'string' || !POSTAL_RE.test(postalCode)) return null;
  return SECTOR_TO_AREA[postalCode.slice(0, 2)] || null;
}

module.exports = { lookupArea, SECTOR_TO_AREA };
