const { supabaseAdmin } = require('../config/supabase');

/**
 * Deduct balance from tenant wallet
 */
async function deductBalance(tenantId, amount, referenceType, referenceId, description, messageCount = null, costPerMessage = null) {
  const { data, error } = await supabaseAdmin.rpc('deduct_balance', {
    p_tenant_id: tenantId,
    p_amount: amount,
    p_reference_type: referenceType,
    p_reference_id: referenceId,
    p_description: description,
    p_message_count: messageCount,
    p_cost_per_message: costPerMessage
  });
  
  if (error) throw error;
  return data; // Returns boolean
}

/**
 * Credit balance to tenant wallet
 */
async function creditBalance(tenantId, amount, referenceType, referenceId, description) {
  const { data, error } = await supabaseAdmin.rpc('credit_balance', {
    p_tenant_id: tenantId,
    p_amount: amount,
    p_reference_type: referenceType,
    p_reference_id: referenceId,
    p_description: description
  });

  if (error) throw error;
  return data; // Returns boolean
}

module.exports = {
  deductBalance,
  creditBalance
};
