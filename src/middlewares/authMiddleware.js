const admin = require('../config/firebase');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Verifies Firebase JWT and attaches internal user object.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const firebaseUid = decodedToken.uid;

    // Look up internal user
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, is_platform_admin, status')
      .eq('firebase_uid', firebaseUid)
      .single();

    if (error || !user) {
      // Allow routes to proceed if they handle registration/first-time login specifically
      if (req.path === '/register') {
        req.firebaseUser = decodedToken;
        return next();
      }
      return res.status(401).json({ error: 'User not found in system' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'User account is not active' });
    }

    req.user = user;
    req.firebaseUser = decodedToken;
    next();
  } catch (error) {
    console.error('Auth Error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

module.exports = { requireAuth };
