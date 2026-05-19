const { supabaseAdmin } = require('../config/supabase');
const { cacheGet, cacheSet, cacheDel } = require('../utils/cache');

const BLOCKLIST_CACHE_KEY = 'moderation:blocklist';
const EXEMPTIONS_CACHE_PREFIX = 'moderation:exemptions:';
const BLOCKLIST_TTL = 60;
const EXEMPTIONS_TTL = 60;

/**
 * Load the active blocklist from Redis cache, falling back to DB.
 * Returns an array of { id, term, term_type, channels, severity, category } objects
 * with regex terms pre-compiled into a `compiled` field.
 */
async function loadBlocklist() {
  const cached = await cacheGet(BLOCKLIST_CACHE_KEY);
  if (cached) return cached;

  const { data, error } = await supabaseAdmin
    .from('content_blocklist')
    .select('id, term, term_type, channels, severity, category')
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[moderation] Failed to load blocklist:', error.message);
    return [];
  }

  const list = (data || []).map(entry => {
    if (entry.term_type === 'regex') {
      try {
        entry.compiled = new RegExp(entry.term, 'i');
      } catch {
        entry.compiled = null;
      }
    }
    return entry;
  });

  await cacheSet(BLOCKLIST_CACHE_KEY, list, BLOCKLIST_TTL);
  return list;
}

/**
 * Load the set of exempt categories for a tenant from Redis cache, falling back to DB.
 * Returns a Set of category strings.
 */
async function loadTenantExemptions(tenantId) {
  const cacheKey = `${EXEMPTIONS_CACHE_PREFIX}${tenantId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return new Set(cached);

  const { data, error } = await supabaseAdmin
    .from('tenant_moderation_exemptions')
    .select('category')
    .eq('tenant_id', tenantId);

  if (error) {
    console.error(`[moderation] Failed to load exemptions for tenant ${tenantId}:`, error.message);
    return new Set();
  }

  const categories = (data || []).map(r => r.category);
  await cacheSet(cacheKey, categories, EXEMPTIONS_TTL);
  return new Set(categories);
}

/**
 * Invalidate the cached blocklist so the next check reloads from DB.
 * Call this after any admin add/update/delete on the blocklist.
 */
async function invalidateBlocklistCache() {
  await cacheDel(BLOCKLIST_CACHE_KEY);
}

/**
 * Invalidate the cached exemptions for a specific tenant.
 * Call this after granting or revoking an exemption.
 */
async function invalidateTenantExemptionsCache(tenantId) {
  await cacheDel(`${EXEMPTIONS_CACHE_PREFIX}${tenantId}`);
}

/**
 * Check message content against the active blocklist.
 *
 * @param {string} text       - The message body to check
 * @param {string} channel    - 'sms' | 'whatsapp'
 * @param {string|null} tenantId - When provided, exempt categories are filtered out before matching
 * @returns {{ blocked: boolean, severity: string|null, matched_term: string|null, matched_type: string|null }}
 */
async function checkContent(text, channel, tenantId = null) {
  if (!text || typeof text !== 'string') {
    return { blocked: false, severity: null, matched_term: null, matched_type: null };
  }

  const [blocklist, exemptions] = await Promise.all([
    loadBlocklist(),
    tenantId ? loadTenantExemptions(tenantId) : Promise.resolve(new Set()),
  ]);

  const lower = text.toLowerCase();

  for (const entry of blocklist) {
    if (!entry.channels.includes(channel)) continue;
    if (exemptions.size > 0 && exemptions.has(entry.category)) continue;

    let matched = false;

    if (entry.term_type === 'word') {
      const pattern = new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'i');
      matched = pattern.test(text);
    } else if (entry.term_type === 'phrase') {
      matched = lower.includes(entry.term.toLowerCase());
    } else if (entry.term_type === 'regex' && entry.compiled) {
      matched = entry.compiled.test(text);
    }

    if (matched) {
      return {
        blocked: entry.severity === 'block',
        severity: entry.severity,
        matched_term: entry.term,
        matched_type: entry.term_type,
      };
    }
  }

  return { blocked: false, severity: null, matched_term: null, matched_type: null };
}

/**
 * Log a blocked or flagged message to the blocked_messages table.
 */
async function logBlockedMessage({ tenantId, channel, apiKeyId, messageContent, recipientCount, matchedTerm, matchedType, severity, requestIp }) {
  await supabaseAdmin.from('blocked_messages').insert({
    tenant_id: tenantId,
    channel,
    api_key_id: apiKeyId || null,
    message_content: messageContent,
    recipient_count: recipientCount || 1,
    matched_term: matchedTerm,
    matched_type: matchedType,
    severity,
    request_ip: requestIp || null,
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  checkContent,
  logBlockedMessage,
  invalidateBlocklistCache,
  invalidateTenantExemptionsCache,
};
