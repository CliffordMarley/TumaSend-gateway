/**
 * Middleware to ensure the API key has the required scope.
 * @param {string} requiredScope 
 */
function requireScope(requiredScope) {
  return (req, res, next) => {
    if (!req.apiKey || !req.apiKey.scopes) {
      return res.status(403).json({ error: 'API key context missing or no scopes defined' });
    }

    if (!req.apiKey.scopes.includes(requiredScope) && !req.apiKey.scopes.includes('*')) {
      return res.status(403).json({ error: `Insufficient scope. Requires ${requiredScope}` });
    }

    next();
  };
}

module.exports = { requireScope };
