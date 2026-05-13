const { Router } = require('express');
const axios = require('axios');
const admin = require('../config/firebase');
const { requireAuth } = require('../middlewares/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');

const { normalizePhone, isValidMalawiPhone } = require('../utils/numberResolver');

const router = Router();

// Firebase REST API endpoints
const FIREBASE_REST_API = 'https://identitytoolkit.googleapis.com/v1';

/**
 * @swagger
 * /api/v1/auth/register:
 *   post:
 *     summary: Register a new user
 *     description: |
 *       Creates a user in Firebase Auth, creates a basic Supabase User profile, and returns a JWT token.
 *       Phone numbers are automatically normalized to Malawi format (265XXXXXXXXX).
 *       Accepted formats: `0991234567`, `991234567`, `+265991234567`, `265991234567`
 *     tags:
 *       - Auth
 *     security:
 *       - SystemKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - full_name
 *               - phone
 *             properties:
 *               email:
 *                 type: string
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: securePassword123
 *               full_name:
 *                 type: string
 *                 example: John Doe
 *               phone:
 *                 type: string
 *                 description: Malawi phone number in any format. Will be normalized to 265XXXXXXXXX.
 *                 example: "0991234567"
 *     responses:
 *       201:
 *         description: Registration successful
 *       400:
 *         description: Missing required fields or invalid phone number
 *       409:
 *         description: Email or phone already registered
 *       500:
 *         description: Server error
 */
router.post('/register', async (req, res) => {
  const { email, password, full_name, phone } = req.body;

  // Validate required fields
  if (!email || !password || !full_name || !phone) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['email', 'password', 'full_name', 'phone']
    });
  }

  // Normalize and validate phone number
  const normalizedPhone = normalizePhone(phone);
  if (!isValidMalawiPhone(normalizedPhone)) {
    return res.status(400).json({ 
      error: 'Invalid phone number',
      message: 'Phone must be a valid Malawi number (Airtel: 265991XXXXXX / TNM: 265881XXXXXX)',
      received: phone,
      normalized: normalizedPhone
    });
  }

  // Check for existing phone in our DB
  const { data: existingPhone } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('phone', normalizedPhone)
    .single();
  
  if (existingPhone) {
    return res.status(409).json({ error: 'This phone number is already registered' });
  }

  try {
    // 1. Create User in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: full_name,
      phoneNumber: `+${normalizedPhone}`
    });

    const firebaseUid = userRecord.uid;

    // 2. Create User in Supabase
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({
        firebase_uid: firebaseUid,
        email: email,
        full_name: full_name,
        phone: normalizedPhone,
        status: 'active'
      })
      .select()
      .single();

    if (userError) {
      await admin.auth().deleteUser(firebaseUid);
      throw userError;
    }

    // 3. Auto-login to get JWT token
    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (apiKey) {
      try {
        const loginResponse = await axios.post(
          `${FIREBASE_REST_API}/accounts:signInWithPassword?key=${apiKey}`,
          {
            email,
            password,
            returnSecureToken: true
          }
        );
        return res.status(201).json({
          message: 'Registration successful',
          user,
          token: loginResponse.data.idToken,
          refreshToken: loginResponse.data.refreshToken,
          expiresIn: loginResponse.data.expiresIn
        });
      } catch (loginErr) {
         console.warn('Auto-login after register failed.');
      }
    }

    res.status(201).json({ message: 'Registration successful. Please login.', user });
  } catch (error) {
    console.error('Registration Error:', error.message || error);

    // Handle Firebase duplicate email error
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'This email address is already registered' });
    }
    if (error.code === 'auth/phone-number-already-exists') {
      return res.status(409).json({ error: 'This phone number is already registered' });
    }

    res.status(500).json({ error: 'Failed to complete registration', details: error.message });
  }
});

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login user
 *     description: Authenticates against Firebase REST API. Auto-creates a basic Supabase profile if the user exists in Firebase but not in Supabase.
 *     tags:
 *       - Auth
 *     security:
 *       - SystemKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 example: test@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: securePassword123
 *     responses:
 *       200:
 *         description: Login successful
 *       400:
 *         description: Missing email or password
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: User account is not active
 *       500:
 *         description: Server error
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const apiKey = process.env.FIREBASE_WEB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'FIREBASE_WEB_API_KEY is not configured on the server' });
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Authenticate with Firebase REST API
    const response = await axios.post(
      `${FIREBASE_REST_API}/accounts:signInWithPassword?key=${apiKey}`,
      {
        email,
        password,
        returnSecureToken: true
      }
    );

    const { idToken, refreshToken, expiresIn, localId, displayName } = response.data;

    // Check if user exists in our DB
    let { data: dbUser, error } = await supabaseAdmin
      .from('users')
      .select('id, status')
      .eq('firebase_uid', localId)
      .single();

    // Auto-provisioning if missing
    if (error || !dbUser) {
      console.log(`Auto-provisioning profile for Firebase UID: ${localId}`);
      
      // We'll fetch full Firebase details just in case we need the display name
      let fullName = displayName || email.split('@')[0];
      try {
        const fbRecord = await admin.auth().getUser(localId);
        if (fbRecord.displayName) fullName = fbRecord.displayName;
      } catch(e) {
        // ignore
      }

      const { data: newUser, error: insertError } = await supabaseAdmin
        .from('users')
        .insert({
          firebase_uid: localId,
          email: email,
          full_name: fullName,
          status: 'active'
        })
        .select('id, status')
        .single();
      
      if (insertError) {
         console.error('Failed to auto-provision user:', insertError);
         return res.status(500).json({ error: 'Failed to create internal user profile' });
      }
      dbUser = newUser;
    }

    if (dbUser.status !== 'active') {
      return res.status(403).json({ error: 'User account is not active' });
    }

    res.status(200).json({
      message: 'Login successful',
      token: idToken,
      refreshToken,
      expiresIn
    });
  } catch (error) {
    console.error('Login Error:', error.response?.data?.error?.message || error.message);
    res.status(401).json({ 
      error: 'Invalid credentials', 
      details: error.response?.data?.error?.message 
    });
  }
});

/**
 * @swagger
 * /api/v1/auth/business:
 *   post:
 *     summary: Create a business account
 *     description: Creates a business tenant for the authenticated user with basic details and assigns them as the owner.
 *     tags:
 *       - Auth
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - business_name
 *             properties:
 *               business_name:
 *                 type: string
 *                 example: My Super Business
 *               business_type:
 *                 type: string
 *                 example: sole_proprietor
 *               email:
 *                 type: string
 *                 example: contact@superbusiness.com
 *               phone:
 *                 type: string
 *                 example: +265991234567
 *               address_line1:
 *                 type: string
 *                 example: 123 Tech Avenue
 *               city:
 *                 type: string
 *                 example: Lilongwe
 *               country:
 *                 type: string
 *                 example: Malawi
 *     responses:
 *       201:
 *         description: Business created successfully
 *       400:
 *         description: Missing business name
 *       500:
 *         description: Server error
 */
router.post('/business', requireAuth, async (req, res) => {
  const { 
    business_name, 
    business_type, 
    email, 
    phone, 
    address_line1, 
    city, 
    country 
  } = req.body;
  const user = req.user;

  if (!business_name) {
    return res.status(400).json({ error: 'business_name is required' });
  }

  try {
    // 1. Check if user already owns a business
    const { data: existingOwnership } = await supabaseAdmin
      .from('tenant_members')
      .select('id, tenants(name)')
      .eq('user_id', user.id)
      .eq('is_owner', true)
      .eq('status', 'active')
      .single();

    if (existingOwnership) {
      return res.status(409).json({ 
        error: 'You already own a business account',
        business: existingOwnership.tenants?.name,
        message: 'A user can only own one business. Please contact support to manage multiple businesses.'
      });
    }

    // 2. Check if a business with the same name already exists (case-insensitive)
    const { data: duplicateBusiness } = await supabaseAdmin
      .from('tenants')
      .select('id, name')
      .ilike('name', business_name.trim())
      .single();

    if (duplicateBusiness) {
      return res.status(409).json({ 
        error: 'A business with this name already exists',
        message: 'Please choose a different business name.'
      });
    }

    // Generate a unique slug
    const slug = business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.floor(Math.random() * 10000);

    // 3. Create Tenant using creator profile details as fallback
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .insert({
        name: business_name.trim(),
        slug: slug,
        email: email || user.email,
        business_type: business_type || 'sole_proprietor',
        phone: phone || null,
        address_line1: address_line1 || null,
        city: city || null,
        country: country || 'Malawi',
        balance_mwk: 0.00
      })
      .select()
      .single();

    if (tenantError) throw tenantError;

    // 4. Get 'admin' role
    const { data: role } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'admin')
      .single();

    if (!role) {
      throw new Error("Admin role not found in database.");
    }

    // 5. Create Tenant Member - creator as owner
    const { data: membership, error: memberError } = await supabaseAdmin
      .from('tenant_members')
      .insert({
        tenant_id: tenant.id,
        user_id: user.id,
        role_id: role.id,
        is_owner: true,
        invite_accepted: true,
        status: 'active'
      })
      .select()
      .single();
    
    if (memberError) throw memberError;

    res.status(201).json({
      message: 'Business created successfully',
      tenant,
      membership
    });
  } catch (error) {
    console.error('Business Creation Error:', error);
    res.status(500).json({ error: 'Failed to create business', details: error.message });
  }
});

/**
 * @swagger
 * /api/v1/auth/me:
 *   get:
 *     summary: Get current user profile
 *     description: Returns the user profile and their associated tenant memberships. Requires a valid JWT Bearer token.
 *     tags:
 *       - Auth
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User details retrieved successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/me', requireAuth, async (req, res) => {
  const user = req.user;

  try {
    const { data: memberships, error } = await supabaseAdmin
      .from('tenant_members')
      .select('tenant_id, is_owner, role_id, status, invite_accepted, tenants(*), roles(name)')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .or('invite_accepted.eq.true,is_owner.eq.true');

    if (error) throw error;

    res.status(200).json({
      user,
      memberships
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

module.exports = router;
