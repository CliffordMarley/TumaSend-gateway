const { supabaseAdmin } = require('../config/supabase');
const { cacheGet, cacheSet, cacheDel } = require('../utils/cache');

const BLOCKLIST_CACHE_KEY = 'moderation:blocklist';
const BLOCKLIST_TTL = 60; // seconds — low TTL so admin changes apply quickly

/**
 * Load the active blocklist from Redis cache, falling back to DB.
 * Returns an array of { id, term, term_type, channels, severity } objects
 * with regex terms pre-compiled into a `compiled` field.
 */
async function loadBlocklist() {
  const cached = await cacheGet(BLOCKLIST_CACHE_KEY);
  if (cached) return cached;

  const { data, error } = await supabaseAdmin
    .from('content_blocklist')
    .select('id, term, term_type, channels, severity')
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
 * Invalidate the cached blocklist so the next check reloads from DB.
 * Call this after any admin add/update/delete.
 */
async function invalidateBlocklistCache() {
  await cacheDel(BLOCKLIST_CACHE_KEY);
}

/**
 * Check message content against the active blocklist.
 *
 * @param {string} text     - The message body to check
 * @param {string} channel  - 'sms' | 'whatsapp'
 * @returns {{ blocked: boolean, severity: string|null, matched_term: string|null, matched_type: string|null }}
 */
async function checkContent(text, channel) {
  if (!text || typeof text !== 'string') {
    return { blocked: false, severity: null, matched_term: null, matched_type: null };
  }

  const blocklist = await loadBlocklist();
  const lower = text.toLowerCase();

  for (const entry of blocklist) {
    if (!entry.channels.includes(channel)) continue;

    let matched = false;

    if (entry.term_type === 'word') {
      // Whole-word match — won't flag "skill" for "kill"
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

module.exports = { checkContent, logBlockedMessage, invalidateBlocklistCache };
