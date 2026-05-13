/**
 * Normalizes a Malawian phone number to 265XXXXXXXXX format.
 * @param {string|number} phone 
 * @returns {string}
 */
function normalizePhone(phone) {
  let p = String(phone).replace(/[^0-9]/g, '');
  
  if (p.startsWith('09')) {
    return '265' + p.substring(1);
  } else if (p.startsWith('08')) {
    return '265' + p.substring(1);
  } else if (p.startsWith('9') && p.length === 9) {
    return '265' + p;
  } else if (p.startsWith('8') && p.length === 9) {
    return '265' + p;
  }
  
  return p;
}

/**
 * Validates if the normalized phone number is a valid Malawi number.
 * @param {string} phone 
 * @returns {boolean}
 */
function isValidMalawiPhone(phone) {
  return /^265[89][0-9]{8}$/.test(phone);
}

/**
 * Detects the network based on the normalized phone number.
 * @param {string} phone 
 * @returns {string}
 */
function detectNetwork(phone) {
  if (phone.startsWith('2658')) {
    return 'tnm';
  } else if (phone.startsWith('2659')) {
    return 'airtel';
  }
  return 'unknown';
}

/**
 * Calculates the number of SMS parts needed for the message text.
 * @param {string} messageText 
 * @returns {number}
 */
function calculateSmsParts(messageText) {
  const msgLength = messageText.length;
  // Check if string contains non-GSM characters (simple unicode check)
  const hasUnicode = /[^\x00-\x7F]/.test(messageText);
  
  const singlePartLimit = hasUnicode ? 70 : 160;
  const multiPartLimit = hasUnicode ? 67 : 153;
  
  if (msgLength <= singlePartLimit) {
    return 1;
  } else {
    return Math.ceil(msgLength / multiPartLimit);
  }
}

module.exports = {
  normalizePhone,
  isValidMalawiPhone,
  detectNetwork,
  calculateSmsParts
};
