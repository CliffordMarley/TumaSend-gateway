// Stub for rate limiting middleware
const rateLimit = (req, res, next) => {
  // In a real implementation, you would check Redis for rate limits
  // specific to req.apiKey.rateLimits
  next();
};

module.exports = { rateLimit };
