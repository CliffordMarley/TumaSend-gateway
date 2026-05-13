/**
 * Middleware to ensure requests originate from our authorized client application
 * using the SYSTEM_API_KEY.
 */
function systemKeyAuth(req, res, next) {
  const systemKey = req.get('system-key') || req.get('x-system-key');
  const expectedKey = process.env.SYSTEM_API_KEY;

  if (!expectedKey) {
    console.warn('SYSTEM_API_KEY is not defined in environment variables.');
  }

  const safeSystemKey = systemKey ? systemKey.trim() : null;
  const safeExpectedKey = expectedKey ? expectedKey.trim() : null;

  if (!safeSystemKey || safeSystemKey !== safeExpectedKey) {
    console.warn(`Auth failed. Received: "${safeSystemKey}", Expected: "${safeExpectedKey}"`);
    return res.status(401).json({ 
      error: 'Unauthorized: Invalid or missing System API Key',
      hint: "Make sure you pass the header 'x-system-key' with the exact case-sensitive key, without any trailing spaces."
    });
  }

  next();
}

module.exports = { systemKeyAuth };
