const bcrypt = require('bcryptjs');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Authenticates API requests using the x-api-key header.
 */
async function apiKeyAuth(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }
    
    // Extract prefix (first 8 chars)
    const prefix = apiKey.substring(0, 8);
    
    // Find API keys with matching prefix
    const { data: keys, error } = await supabaseAdmin
      .from('api_keys')
      .select(`
        id,
        key_hash,
        tenant_id,
        sender_id_id,
        scopes,
        environment,
        rate_limit_per_second,
        rate_limit_per_minute,
        rate_limit_per_hour,
        rate_limit_per_day,
        allowed_ips,
        status,
        expires_at,
        sender_ids!inner (
          sender_id,
          status
        ),
        tenants!inner (
          status,
          kyc_status,
          balance_mwk
        )
      `)
      .eq('key_prefix', prefix)
      .eq('status', 'active')
      .single();
    
    if (error || !keys) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Verify hash
    const validKey = await bcrypt.compare(apiKey, keys.key_hash);
    if (!validKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Check expiry
    if (keys.expires_at && new Date(keys.expires_at) < new Date()) {
      return res.status(401).json({ error: 'API key expired' });
    }
    
    // Check IP whitelist
    if (keys.allowed_ips && keys.allowed_ips.length > 0) {
      const clientIp = req.ip || req.connection.remoteAddress;
      if (!keys.allowed_ips.includes(clientIp)) {
        return res.status(403).json({ error: 'IP not whitelisted' });
      }
    }
    
    // Check tenant status
    if (keys.tenants.status !== 'active') {
      return res.status(403).json({ error: 'Tenant account is not active' });
    }

    // Check KYC approval
    if (keys.tenants.kyc_status !== 'approved') {
      return res.status(403).json({ error: 'KYC verification is required to use this API key' });
    }

    // Check sender ID status
    if (keys.sender_ids.status !== 'approved') {
      return res.status(403).json({ error: 'Sender ID is not approved' });
    }
    
    // Update last used
    await supabaseAdmin
      .from('api_keys')
      .update({
        last_used_at: new Date().toISOString(),
        last_used_ip: req.ip,
        total_requests: (keys.total_requests || 0) + 1
      })
      .eq('id', keys.id);
    
    // Attach context to request
    req.apiKey = {
      apiKeyId: keys.id,
      tenantId: keys.tenant_id,
      senderIdId: keys.sender_id_id,
      senderName: keys.sender_ids.sender_id,
      environment: keys.environment || 'live',
      scopes: keys.scopes || [],
      rateLimits: {
        perSecond: keys.rate_limit_per_second,
        perMinute: keys.rate_limit_per_minute,
        perHour: keys.rate_limit_per_hour,
        perDay: keys.rate_limit_per_day
      }
    };
    
    next();
  } catch (err) {
    console.error('API Key Auth Error:', err);
    return res.status(500).json({ error: 'Internal server error during authentication' });
  }
}

module.exports = { apiKeyAuth };
