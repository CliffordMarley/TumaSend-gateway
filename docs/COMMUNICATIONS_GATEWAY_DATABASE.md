# Communications Gateway Database Documentation

> **Malawi Communications Gateway** - A comprehensive SMS, WhatsApp, USSD, and SMTP provider platform built with Supabase, Express.js, Firebase Auth, and Kannel SMPP.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Database Schema](#database-schema)
4. [Table Definitions](#table-definitions)
5. [Database Triggers & Functions](#database-triggers--functions)
6. [Row Level Security (RLS)](#row-level-security-rls)
7. [Ubuntu Server Setup](#ubuntu-server-setup)
8. [Express.js Backend Integration](#expressjs-backend-integration)
9. [Kannel SMPP Integration](#kannel-smpp-integration)
10. [PayChangu Payment Integration](#paychangu-payment-integration)
11. [API Reference](#api-reference)
12. [Migration Scripts](#migration-scripts)

---

## Overview

The Communications Gateway is a self-service multi-tenant platform for Malawi that provides:

- **SMS Gateway** - Via Kannel SMPP to TNM (2658xxx) and Airtel (2659xxx)
- **WhatsApp Business API** - Integration with WhatsApp Cloud API
- **USSD Gateway** - Interactive USSD sessions
- **SMTP Provider** - Email delivery services

### Key Features

- Multi-tenant architecture with role-based access control
- Firebase Authentication integration
- Prepaid billing model (MWK 18.00/SMS)
- Sender ID whitelisting and approval workflow
- Real-time balance deduction
- Comprehensive audit logging
- KYC document management

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT APPS                               │
│              (Web Dashboard / Mobile App / API)                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     FIREBASE AUTH                                │
│                  (Authentication Layer)                          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ JWT Token
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   EXPRESS.JS BACKEND                             │
│                    (Ubuntu Server)                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  API Routes  │  │  Middleware  │  │   Workers    │          │
│  │  /api/v1/*   │  │  Auth/Rate   │  │  Queue Proc  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   SUPABASE   │      │    KANNEL    │      │  PAYCHANGU   │
│  (Database)  │      │    (SMPP)    │      │  (Payments)  │
│              │      │              │      │              │
│  PostgreSQL  │      │  TNM/Airtel  │      │  Mobile $$$  │
│  + Storage   │      │   Networks   │      │  Card/Bank   │
└──────────────┘      └──────────────┘      └──────────────┘
```

---

## Database Schema

### Entity Relationship Diagram

```
┌────────────────┐       ┌────────────────┐       ┌────────────────┐
│     users      │       │    tenants     │       │     roles      │
├────────────────┤       ├────────────────┤       ├────────────────┤
│ id (PK)        │       │ id (PK)        │       │ id (PK)        │
│ firebase_uid   │◄──────│ balance_mwk    │       │ name           │
│ email          │       │ kyc_status     │       │ permissions    │
│ full_name      │       │ max_sender_ids │       └────────┬───────┘
│ is_platform_   │       │ subscription_  │                │
│   admin        │       │   tier_id (FK) │                │
└───────┬────────┘       └───────┬────────┘                │
        │                        │                         │
        │    ┌───────────────────┼─────────────────────────┘
        │    │                   │
        ▼    ▼                   ▼
┌────────────────────────────────────┐
│          tenant_members            │
├────────────────────────────────────┤
│ id (PK)                            │
│ tenant_id (FK) ──────────────────► │
│ user_id (FK) ────────────────────► │
│ role_id (FK) ────────────────────► │
│ is_owner                           │
│ status                             │
└────────────────────────────────────┘
        │
        │
        ▼
┌────────────────┐       ┌────────────────┐       ┌────────────────┐
│   sender_ids   │       │    api_keys    │       │   campaigns    │
├────────────────┤       ├────────────────┤       ├────────────────┤
│ id (PK)        │◄──────│ sender_id_id   │       │ id (PK)        │
│ tenant_id (FK) │       │ tenant_id (FK) │       │ tenant_id (FK) │
│ sender_id      │       │ key_hash       │       │ sender_id_id   │
│ is_global      │       │ scopes[]       │       │ contact_list_id│
│ status         │       │ rate_limits    │       │ status         │
└───────┬────────┘       └───────┬────────┘       └───────┬────────┘
        │                        │                        │
        └────────────┬───────────┘                        │
                     │                                    │
                     ▼                                    │
        ┌────────────────────────┐                        │
        │    message_batches     │◄───────────────────────┘
        ├────────────────────────┤
        │ id (PK)                │
        │ tenant_id (FK)         │
        │ api_key_id (FK)        │
        │ sender_id_id (FK)      │
        │ campaign_id (FK)       │
        │ content                │
        │ total_recipients       │
        │ total_cost_mwk         │
        │ status                 │
        └───────────┬────────────┘
                    │
                    │ 1:N
                    ▼
        ┌────────────────────────┐
        │       messages         │
        ├────────────────────────┤
        │ id (PK)                │
        │ batch_id (FK)          │
        │ recipient              │
        │ recipient_network      │
        │ status                 │
        │ provider_message_id    │
        │ dlr_status             │
        │ cost_mwk               │
        └────────────────────────┘
```

---

## Table Definitions

### 1. subscription_tiers

Pricing tiers for the platform.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| name | TEXT | - | Tier name (e.g., 'starter', 'growth') |
| description | TEXT | NULL | Tier description |
| sms_price_mwk | DECIMAL(10,4) | 18.0000 | Price per SMS in MWK |
| whatsapp_price_mwk | DECIMAL(10,4) | NULL | Price per WhatsApp message |
| ussd_price_mwk | DECIMAL(10,4) | NULL | Price per USSD session |
| email_price_mwk | DECIMAL(10,4) | NULL | Price per email |
| min_monthly_volume | INTEGER | 0 | Minimum monthly volume |
| max_monthly_volume | INTEGER | NULL | Maximum monthly volume (NULL = unlimited) |
| features | JSONB | '{}' | Additional features JSON |
| is_active | BOOLEAN | TRUE | Whether tier is active |
| is_default | BOOLEAN | FALSE | Default tier for new tenants |
| sort_order | INTEGER | 0 | Display order |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 2. users

User accounts linked to Firebase Authentication.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key (internal) |
| firebase_uid | TEXT | - | **Firebase Auth UID (unique identifier)** |
| email | TEXT | - | User email (unique) |
| phone | TEXT | NULL | Phone: 2659XXXXXXX or 2658XXXXXXX |
| full_name | TEXT | - | User's full name |
| avatar_url | TEXT | NULL | Profile picture URL |
| email_verified | BOOLEAN | FALSE | Email verification status |
| phone_verified | BOOLEAN | FALSE | Phone verification status |
| is_platform_admin | BOOLEAN | FALSE | Super admin flag |
| status | TEXT | 'pending' | 'pending', 'active', 'suspended', 'deactivated' |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 3. roles

Predefined permission roles.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| name | TEXT | - | Role name (unique) |
| description | TEXT | NULL | Role description |
| permissions | JSONB | '[]' | Array of permission strings |
| is_system_role | BOOLEAN | FALSE | Cannot be deleted if true |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |

**Seeded Roles:**

```sql
-- admin: Full access
['*']

-- developer: API and messaging
['api:*', 'messages:*', 'sender_ids:read', 'templates:*']

-- billing: Payment management
['billing:*', 'invoices:*', 'transactions:read']

-- viewer: Read-only
['read:*']
```

### 4. tenants

Business organizations (multi-tenant).

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| name | TEXT | - | Display name |
| slug | TEXT | - | URL-friendly identifier (unique) |
| business_name | TEXT | NULL | Legal business name |
| business_type | TEXT | NULL | 'sole_proprietor', 'partnership', 'limited_company', 'ngo' |
| registration_number | TEXT | NULL | Business registration number |
| tax_id | TEXT | NULL | Tax identification number |
| email | TEXT | - | Business email |
| phone | TEXT | NULL | Business phone |
| website | TEXT | NULL | Business website |
| address_line1 | TEXT | NULL | Street address |
| address_line2 | TEXT | NULL | Additional address |
| city | TEXT | NULL | City |
| country | TEXT | 'Malawi' | Country |
| subscription_tier_id | UUID | NULL | FK to subscription_tiers |
| **balance_mwk** | DECIMAL(15,2) | **0.00** | **Prepaid balance** |
| kyc_status | TEXT | 'pending' | 'pending', 'submitted', 'under_review', 'approved', 'rejected' |
| kyc_submitted_at | TIMESTAMPTZ | NULL | KYC submission timestamp |
| kyc_reviewed_at | TIMESTAMPTZ | NULL | KYC review timestamp |
| kyc_reviewed_by | UUID | NULL | FK to users (reviewer) |
| kyc_rejection_reason | TEXT | NULL | Rejection reason |
| max_sender_ids | INTEGER | 4 | Maximum allowed sender IDs |
| status | TEXT | 'active' | 'active', 'suspended', 'deactivated' |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 5. tenant_members

Junction table for multi-tenant user membership.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| user_id | UUID | - | FK to users |
| role_id | UUID | - | FK to roles |
| is_owner | BOOLEAN | FALSE | Original creator of tenant |
| invited_by | UUID | NULL | FK to users (inviter) |
| invited_at | TIMESTAMPTZ | NULL | Invitation timestamp |
| joined_at | TIMESTAMPTZ | NOW() | Join timestamp |
| status | TEXT | 'active' | 'pending', 'active', 'suspended', 'removed' |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

**Constraints:** UNIQUE(tenant_id, user_id)

### 6. kyc_documents

Business verification documents stored in Supabase Storage.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| uploaded_by | UUID | - | FK to users |
| document_type | TEXT | - | 'business_registration', 'tax_certificate', 'director_id', 'proof_of_address', 'other' |
| document_name | TEXT | - | Original filename |
| storage_bucket | TEXT | 'kyc-documents' | Supabase Storage bucket |
| storage_path | TEXT | - | Path within bucket |
| file_size | INTEGER | NULL | File size in bytes |
| mime_type | TEXT | NULL | MIME type |
| status | TEXT | 'pending' | 'pending', 'approved', 'rejected' |
| reviewed_by | UUID | NULL | FK to users (reviewer) |
| reviewed_at | TIMESTAMPTZ | NULL | Review timestamp |
| rejection_reason | TEXT | NULL | Rejection reason |
| notes | TEXT | NULL | Additional notes |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 7. sender_ids

Alphanumeric sender IDs for messaging.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | NULL | FK to tenants (NULL for global) |
| sender_id | TEXT | - | The sender ID string (e.g., 'MYSHOP') |
| display_name | TEXT | NULL | Human-readable name |
| description | TEXT | NULL | Description |
| is_global | BOOLEAN | FALSE | Available to all tenants |
| is_system | BOOLEAN | FALSE | System-owned, cannot be modified |
| channels | TEXT[] | ['sms'] | Approved channels |
| status | TEXT | 'pending' | 'pending', 'approved', 'rejected', 'suspended' |
| requested_by | UUID | NULL | FK to users |
| requested_at | TIMESTAMPTZ | NOW() | Request timestamp |
| approved_by | UUID | NULL | FK to users (approver) |
| approved_at | TIMESTAMPTZ | NULL | Approval timestamp |
| rejection_reason | TEXT | NULL | Rejection reason |
| valid_from | TIMESTAMPTZ | NULL | Validity start |
| valid_until | TIMESTAMPTZ | NULL | Validity end (NULL = no expiry) |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

**Constraints:** UNIQUE(tenant_id, sender_id)

**Seeded Global Sender ID:**
```sql
INSERT INTO sender_ids (sender_id, display_name, description, is_global, is_system, status, channels, valid_from)
VALUES ('LETTSCOMM', 'Letts Communications', 'Global shared sender ID for new/unverified users', TRUE, TRUE, 'approved', ARRAY['sms'], NOW());
```

### 8. api_keys

Per-sender API keys with authentication and rate limiting.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| sender_id_id | UUID | - | FK to sender_ids |
| created_by | UUID | - | FK to users |
| name | TEXT | - | Human-readable name |
| key_prefix | TEXT | - | First 8 chars (e.g., 'lc_live_') |
| **key_hash** | TEXT | - | **bcrypt hash of full key** |
| environment | TEXT | 'live' | 'test' or 'live' |
| scopes | TEXT[] | ['sms:send'] | Permission scopes |
| rate_limit_per_second | INTEGER | 10 | Requests/second |
| rate_limit_per_minute | INTEGER | 100 | Requests/minute |
| rate_limit_per_hour | INTEGER | 1000 | Requests/hour |
| rate_limit_per_day | INTEGER | 10000 | Requests/day |
| allowed_ips | TEXT[] | [] | IP whitelist (empty = allow all) |
| last_used_at | TIMESTAMPTZ | NULL | Last usage timestamp |
| last_used_ip | TEXT | NULL | Last used IP address |
| total_requests | BIGINT | 0 | Total request count |
| status | TEXT | 'active' | 'active', 'revoked', 'expired' |
| revoked_at | TIMESTAMPTZ | NULL | Revocation timestamp |
| revoked_by | UUID | NULL | FK to users |
| revoke_reason | TEXT | NULL | Revocation reason |
| expires_at | TIMESTAMPTZ | NULL | Expiration (NULL = no expiry) |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 9. message_templates

Pre-approved message templates with approval workflow.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| created_by | UUID | - | FK to users |
| name | TEXT | - | Template name |
| description | TEXT | NULL | Template description |
| channel | TEXT | - | 'sms', 'whatsapp', 'ussd', 'email' |
| content | TEXT | - | Template with {{variable}} placeholders |
| variables | JSONB | '[]' | Variable definitions |
| sample_content | TEXT | NULL | Example with variables filled |
| whatsapp_template_id | TEXT | NULL | External WhatsApp template ID |
| whatsapp_category | TEXT | NULL | 'MARKETING', 'UTILITY', 'AUTHENTICATION' |
| status | TEXT | 'draft' | 'draft', 'pending', 'approved', 'rejected', 'archived' |
| submitted_at | TIMESTAMPTZ | NULL | Submission timestamp |
| reviewed_by | UUID | NULL | FK to users |
| reviewed_at | TIMESTAMPTZ | NULL | Review timestamp |
| rejection_reason | TEXT | NULL | Rejection reason |
| times_used | BIGINT | 0 | Usage count |
| last_used_at | TIMESTAMPTZ | NULL | Last usage timestamp |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 10. contacts

Contact database per tenant.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| phone | TEXT | NULL | Normalized: 2659XXXXXXX or 2658XXXXXXX |
| email | TEXT | NULL | Email address |
| full_name | TEXT | NULL | Full name |
| first_name | TEXT | NULL | First name |
| last_name | TEXT | NULL | Last name |
| custom_fields | JSONB | '{}' | Custom data |
| tags | TEXT[] | [] | Tags for segmentation |
| sms_opted_out | BOOLEAN | FALSE | SMS opt-out status |
| sms_opted_out_at | TIMESTAMPTZ | NULL | SMS opt-out timestamp |
| whatsapp_opted_out | BOOLEAN | FALSE | WhatsApp opt-out status |
| whatsapp_opted_out_at | TIMESTAMPTZ | NULL | WhatsApp opt-out timestamp |
| email_opted_out | BOOLEAN | FALSE | Email opt-out status |
| email_opted_out_at | TIMESTAMPTZ | NULL | Email opt-out timestamp |
| source | TEXT | NULL | 'manual', 'import', 'api', 'campaign_signup' |
| messages_sent | INTEGER | 0 | Total messages sent |
| messages_delivered | INTEGER | 0 | Total messages delivered |
| last_contacted_at | TIMESTAMPTZ | NULL | Last contact timestamp |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

**Constraints:** UNIQUE(tenant_id, phone)

### 11. contact_lists

Contact groupings for campaigns.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| created_by | UUID | - | FK to users |
| name | TEXT | - | List name |
| description | TEXT | NULL | List description |
| contact_count | INTEGER | 0 | Denormalized count |
| status | TEXT | 'active' | 'active', 'archived' |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 12. contact_list_members

Junction table for contacts in lists.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| contact_list_id | UUID | - | FK to contact_lists |
| contact_id | UUID | - | FK to contacts |
| added_at | TIMESTAMPTZ | NOW() | Add timestamp |
| added_by | UUID | NULL | FK to users |

**Constraints:** UNIQUE(contact_list_id, contact_id)

### 13. campaigns

Bulk messaging campaigns.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| created_by | UUID | - | FK to users |
| name | TEXT | - | Campaign name |
| description | TEXT | NULL | Campaign description |
| channel | TEXT | - | 'sms', 'whatsapp', 'ussd', 'email' |
| sender_id_id | UUID | - | FK to sender_ids |
| content | TEXT | - | Message content |
| template_id | UUID | NULL | FK to message_templates |
| template_variables | JSONB | NULL | Template variables |
| contact_list_id | UUID | NULL | FK to contact_lists |
| scheduled_at | TIMESTAMPTZ | NULL | Schedule time (NULL = immediate) |
| timezone | TEXT | 'Africa/Blantyre' | Timezone |
| status | TEXT | 'draft' | 'draft', 'scheduled', 'processing', 'completed', 'paused', 'cancelled', 'failed' |
| total_recipients | INTEGER | 0 | Total recipient count |
| messages_sent | INTEGER | 0 | Messages sent count |
| messages_delivered | INTEGER | 0 | Messages delivered count |
| messages_failed | INTEGER | 0 | Messages failed count |
| estimated_cost_mwk | DECIMAL(15,2) | NULL | Estimated cost |
| actual_cost_mwk | DECIMAL(15,2) | 0.00 | Actual cost |
| launched_at | TIMESTAMPTZ | NULL | Launch timestamp |
| completed_at | TIMESTAMPTZ | NULL | Completion timestamp |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 14. message_batches

Groups messages from a single API request.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| api_key_id | UUID | NULL | FK to api_keys |
| sender_id_id | UUID | - | FK to sender_ids |
| campaign_id | UUID | NULL | FK to campaigns |
| channel | TEXT | - | 'sms', 'whatsapp', 'ussd', 'email' |
| sender_name | TEXT | - | The sender ID string used |
| content | TEXT | - | Message content |
| template_id | UUID | NULL | FK to message_templates |
| template_variables | JSONB | NULL | Template variables |
| total_recipients | INTEGER | 0 | Total recipients |
| total_sent | INTEGER | 0 | Total sent |
| total_delivered | INTEGER | 0 | Total delivered |
| total_failed | INTEGER | 0 | Total failed |
| total_cost_mwk | DECIMAL(15,2) | 0.00 | Total cost |
| cost_per_message_mwk | DECIMAL(10,4) | - | Snapshot of price at send time |
| balance_deducted | BOOLEAN | FALSE | Balance deducted flag |
| status | TEXT | 'pending' | 'pending', 'processing', 'completed', 'partial', 'failed' |
| request_ip | TEXT | NULL | Request IP address |
| request_user_agent | TEXT | NULL | Request user agent |
| request_id | TEXT | NULL | Correlation ID |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| processing_started_at | TIMESTAMPTZ | NULL | Processing start |
| completed_at | TIMESTAMPTZ | NULL | Completion timestamp |

### 15. messages

Individual message records with full delivery lifecycle.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| batch_id | UUID | - | FK to message_batches |
| recipient | TEXT | - | Normalized: 2659XXXXXXX or 2658XXXXXXX |
| recipient_network | TEXT | NULL | 'tnm' or 'airtel' (auto-detected) |
| message_parts | INTEGER | 1 | SMS parts count |
| status | TEXT | 'queued' | 'queued', 'sending', 'sent', 'delivered', 'failed', 'rejected', 'expired' |
| queued_at | TIMESTAMPTZ | NOW() | Queue timestamp |
| sent_at | TIMESTAMPTZ | NULL | Send timestamp |
| delivered_at | TIMESTAMPTZ | NULL | Delivery timestamp |
| failed_at | TIMESTAMPTZ | NULL | Failure timestamp |
| provider | TEXT | NULL | 'kannel', 'whatsapp_cloud', etc. |
| provider_message_id | TEXT | NULL | External message ID |
| provider_response | JSONB | NULL | Provider response |
| dlr_status | TEXT | NULL | Raw DLR status |
| dlr_received_at | TIMESTAMPTZ | NULL | DLR timestamp |
| dlr_raw | JSONB | NULL | Full DLR payload |
| error_code | TEXT | NULL | Error code |
| error_message | TEXT | NULL | Error message |
| retry_count | INTEGER | 0 | Retry count |
| max_retries | INTEGER | 3 | Max retries |
| next_retry_at | TIMESTAMPTZ | NULL | Next retry timestamp |
| cost_mwk | DECIMAL(10,4) | - | Cost per message |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 16. invoices

Billing invoices for top-ups and subscriptions.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| invoice_number | TEXT | - | Auto-generated: INV-YYYY-00001 |
| invoice_type | TEXT | - | 'topup', 'subscription', 'usage', 'adjustment' |
| subtotal_mwk | DECIMAL(15,2) | - | Subtotal |
| tax_mwk | DECIMAL(15,2) | 0.00 | Tax amount |
| discount_mwk | DECIMAL(15,2) | 0.00 | Discount amount |
| total_mwk | DECIMAL(15,2) | - | Total amount |
| currency | TEXT | 'MWK' | Currency code |
| status | TEXT | 'pending' | 'draft', 'pending', 'paid', 'partially_paid', 'overdue', 'cancelled', 'refunded' |
| issue_date | DATE | CURRENT_DATE | Issue date |
| due_date | DATE | NULL | Due date |
| paid_at | TIMESTAMPTZ | NULL | Payment timestamp |
| line_items | JSONB | '[]' | Line items array |
| notes | TEXT | NULL | Customer notes |
| internal_notes | TEXT | NULL | Admin notes |
| payment_reference | TEXT | NULL | PayChangu reference |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 17. transactions

Payment transactions via PayChangu.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| invoice_id | UUID | NULL | FK to invoices |
| transaction_reference | TEXT | - | Auto-generated: TXN-YYYYMMDD-000001 |
| paychangu_reference | TEXT | NULL | PayChangu transaction ID |
| paychangu_checkout_id | TEXT | NULL | PayChangu checkout session ID |
| transaction_type | TEXT | - | 'payment', 'refund', 'adjustment', 'bonus' |
| payment_method | TEXT | NULL | 'mobile_money', 'card', 'bank_transfer', 'manual' |
| payment_provider | TEXT | NULL | 'airtel_money', 'tnm_mpamba', 'visa', etc. |
| amount_mwk | DECIMAL(15,2) | - | Amount |
| fee_mwk | DECIMAL(15,2) | 0.00 | Gateway fees |
| net_amount_mwk | DECIMAL(15,2) | NULL | Net amount |
| currency | TEXT | 'MWK' | Currency code |
| status | TEXT | 'pending' | 'pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded' |
| payer_phone | TEXT | NULL | Payer phone |
| payer_email | TEXT | NULL | Payer email |
| payer_name | TEXT | NULL | Payer name |
| metadata | JSONB | '{}' | Full PayChangu response |
| failure_reason | TEXT | NULL | Failure reason |
| initiated_at | TIMESTAMPTZ | NOW() | Initiation timestamp |
| completed_at | TIMESTAMPTZ | NULL | Completion timestamp |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### 18. balance_ledger

Immutable audit trail of all balance changes.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| tenant_id | UUID | - | FK to tenants |
| entry_type | TEXT | - | 'credit', 'debit', 'adjustment', 'reversal' |
| amount_mwk | DECIMAL(15,2) | - | Amount (always positive) |
| balance_after_mwk | DECIMAL(15,2) | - | Running balance after entry |
| reference_type | TEXT | NULL | 'transaction', 'message_batch', 'adjustment', 'campaign' |
| reference_id | UUID | NULL | ID of referenced entity |
| description | TEXT | - | Description |
| message_count | INTEGER | NULL | For debits: message count |
| cost_per_message_mwk | DECIMAL(10,4) | NULL | For debits: per-message cost |
| created_by | UUID | NULL | FK to users |
| metadata | JSONB | '{}' | Additional data |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |

**Note:** This table is IMMUTABLE - triggers prevent updates and deletes.

### 19. audit_logs

Comprehensive activity logging.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | UUID | gen_random_uuid() | Primary key |
| user_id | UUID | NULL | FK to users |
| tenant_id | UUID | NULL | FK to tenants |
| api_key_id | UUID | NULL | FK to api_keys |
| action | TEXT | - | 'create', 'update', 'delete', 'login', 'api_call', etc. |
| resource_type | TEXT | - | 'user', 'tenant', 'message', etc. |
| resource_id | UUID | NULL | Affected resource ID |
| description | TEXT | NULL | Description |
| old_values | JSONB | NULL | Previous values |
| new_values | JSONB | NULL | New values |
| ip_address | TEXT | NULL | Request IP |
| user_agent | TEXT | NULL | Request user agent |
| request_id | TEXT | NULL | Correlation ID |
| request_path | TEXT | NULL | Request path |
| request_method | TEXT | NULL | HTTP method |
| api_endpoint | TEXT | NULL | API endpoint |
| response_status | INTEGER | NULL | HTTP response status |
| status | TEXT | 'success' | 'success', 'failure', 'error' |
| error_message | TEXT | NULL | Error message |
| metadata | JSONB | '{}' | Additional data |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |

---

## Database Triggers & Functions

### Phone Number Normalization

Automatically normalizes Malawian phone numbers to international format.

```sql
CREATE OR REPLACE FUNCTION normalize_phone_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.phone IS NOT NULL THEN
    -- Remove non-digits
    NEW.phone := REGEXP_REPLACE(NEW.phone, '[^0-9]', '', 'g');
    
    -- Convert local formats to international
    IF NEW.phone LIKE '09%' THEN
      NEW.phone := '265' || SUBSTRING(NEW.phone FROM 2);
    ELSIF NEW.phone LIKE '08%' THEN
      NEW.phone := '265' || SUBSTRING(NEW.phone FROM 2);
    ELSIF NEW.phone LIKE '9%' AND LENGTH(NEW.phone) = 9 THEN
      NEW.phone := '265' || NEW.phone;
    ELSIF NEW.phone LIKE '8%' AND LENGTH(NEW.phone) = 9 THEN
      NEW.phone := '265' || NEW.phone;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Applied to:** `contacts`, `messages`

### Network Detection

Automatically detects TNM or Airtel network from phone number.

```sql
CREATE OR REPLACE FUNCTION process_message_recipient()
RETURNS TRIGGER AS $$
BEGIN
  -- Normalize phone number first
  -- ... (normalization code)
  
  -- Derive network
  IF NEW.recipient LIKE '2658%' THEN
    NEW.recipient_network := 'tnm';
  ELSIF NEW.recipient LIKE '2659%' THEN
    NEW.recipient_network := 'airtel';
  ELSE
    NEW.recipient_network := 'unknown';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### SMS Parts Calculator

Calculates the number of SMS parts for a message.

```sql
CREATE OR REPLACE FUNCTION calculate_sms_parts(message_text TEXT)
RETURNS INTEGER AS $$
DECLARE
  msg_length INTEGER;
  has_unicode BOOLEAN;
  single_part_limit INTEGER;
  multi_part_limit INTEGER;
BEGIN
  msg_length := LENGTH(message_text);
  has_unicode := message_text ~ '[^\x00-\x7F]';
  
  IF has_unicode THEN
    single_part_limit := 70;
    multi_part_limit := 67;
  ELSE
    single_part_limit := 160;
    multi_part_limit := 153;
  END IF;
  
  IF msg_length <= single_part_limit THEN
    RETURN 1;
  ELSE
    RETURN CEIL(msg_length::DECIMAL / multi_part_limit);
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### Phone Validation

Validates Malawian phone numbers.

```sql
CREATE OR REPLACE FUNCTION is_valid_malawi_phone(phone TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN phone ~ '^265[89][0-9]{8}$';
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### Helper Functions for RLS

```sql
-- Get user ID from Firebase UID
CREATE OR REPLACE FUNCTION get_user_id_by_firebase_uid(firebase_uid TEXT)
RETURNS UUID AS $$
  SELECT id FROM users WHERE users.firebase_uid = $1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check tenant membership
CREATE OR REPLACE FUNCTION is_tenant_member(p_user_id UUID, p_tenant_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_members
    WHERE user_id = p_user_id
    AND tenant_id = p_tenant_id
    AND status = 'active'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check tenant role
CREATE OR REPLACE FUNCTION has_tenant_role(p_user_id UUID, p_tenant_id UUID, p_role_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_members tm
    JOIN roles r ON tm.role_id = r.id
    WHERE tm.user_id = p_user_id
    AND tm.tenant_id = p_tenant_id
    AND tm.status = 'active'
    AND r.name = p_role_name
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check platform admin status
CREATE OR REPLACE FUNCTION is_platform_admin(p_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE(is_platform_admin, FALSE) FROM users WHERE id = p_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```

### Auto-Generated Numbers

```sql
-- Invoice numbers: INV-YYYY-00001
CREATE SEQUENCE invoice_number_seq START 1;

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.invoice_number IS NULL THEN
    NEW.invoice_number := 'INV-' || TO_CHAR(NOW(), 'YYYY') || '-' || 
                          LPAD(NEXTVAL('invoice_number_seq')::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Transaction references: TXN-YYYYMMDD-000001
CREATE SEQUENCE transaction_ref_seq START 1;

CREATE OR REPLACE FUNCTION generate_transaction_reference()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.transaction_reference IS NULL THEN
    NEW.transaction_reference := 'TXN-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || 
                                  LPAD(NEXTVAL('transaction_ref_seq')::TEXT, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Immutable Balance Ledger

```sql
CREATE OR REPLACE FUNCTION prevent_balance_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Balance ledger entries cannot be modified or deleted. Use reversal entries instead.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_balance_ledger_update
  BEFORE UPDATE ON balance_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_balance_ledger_modification();

CREATE TRIGGER trg_prevent_balance_ledger_delete
  BEFORE DELETE ON balance_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_balance_ledger_modification();
```

---

## Row Level Security (RLS)

All tables have RLS enabled. The key patterns are:

### User Policies
- Users can read/update their own profile
- Platform admins can manage all users

### Tenant Policies
- Members can read their tenant
- Admins can update tenant settings
- Any authenticated user can create a tenant (registration)

### Tenant-Scoped Resources
- Members can read their tenant's resources
- Admins/developers can create and update
- Platform admins have full access

### Balance Ledger
- Read-only for tenant members
- Only system (service role) can insert

### Audit Logs
- Tenant admins can read their tenant's logs
- Users can read their own activity
- Only system can insert

---

## Ubuntu Server Setup

### Prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Install Kannel
sudo apt install -y kannel

# Install Redis (for rate limiting and queues)
sudo apt install -y redis-server

# Install Nginx (reverse proxy)
sudo apt install -y nginx certbot python3-certbot-nginx
```

### Directory Structure

```
/opt/comms-gateway/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── database.ts
│   │   │   ├── firebase.ts
│   │   │   └── kannel.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── apiKey.ts
│   │   │   └── rateLimit.ts
│   │   ├── routes/
│   │   │   ├── v1/
│   │   │   │   ├── send/
│   │   │   │   │   ├── sms.ts
│   │   │   │   │   ├── whatsapp.ts
│   │   │   │   │   └── email.ts
│   │   │   │   ├── auth.ts
│   │   │   │   ├── tenants.ts
│   │   │   │   ├── senderIds.ts
│   │   │   │   ├── apiKeys.ts
│   │   │   │   └── billing.ts
│   │   │   └── webhooks/
│   │   │       ├── kannel.ts
│   │   │       └── paychangu.ts
│   │   ├── services/
│   │   │   ├── sms.ts
│   │   │   ├── billing.ts
│   │   │   └── queue.ts
│   │   ├── workers/
│   │   │   ├── messageProcessor.ts
│   │   │   └── dlrHandler.ts
│   │   └── app.ts
│   ├── package.json
│   └── ecosystem.config.js
├── kannel/
│   ├── kannel.conf
│   ├── smsc-tnm.conf
│   └── smsc-airtel.conf
└── logs/
```

### Environment Variables

Create `/opt/comms-gateway/backend/.env`:

```bash
# Server
NODE_ENV=production
PORT=3000
API_BASE_URL=https://api.yourgateway.mw

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Firebase
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Kannel
KANNEL_HOST=127.0.0.1
KANNEL_PORT=13013
KANNEL_USERNAME=admin
KANNEL_PASSWORD=secure-password

# PayChangu
PAYCHANGU_API_KEY=your-api-key
PAYCHANGU_SECRET_KEY=your-secret-key
PAYCHANGU_WEBHOOK_SECRET=your-webhook-secret

# Redis
REDIS_URL=redis://127.0.0.1:6379

# Encryption
API_KEY_ENCRYPTION_SECRET=32-char-secret-key
```

---

## Express.js Backend Integration

### Database Connection

```typescript
// src/config/database.ts
import { createClient } from '@supabase/supabase-js';

// Anon client for user-authenticated requests
export const supabaseAnon = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// Service role client for backend operations (bypasses RLS)
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
```

### API Key Authentication Middleware

```typescript
// src/middleware/apiKey.ts
import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/database';

interface ApiKeyContext {
  apiKeyId: string;
  tenantId: string;
  senderIdId: string;
  senderName: string;
  scopes: string[];
  rateLimits: {
    perSecond: number;
    perMinute: number;
    perHour: number;
    perDay: number;
  };
}

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyContext;
    }
  }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string;
  
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
    const clientIp = req.ip;
    if (!keys.allowed_ips.includes(clientIp)) {
      return res.status(403).json({ error: 'IP not whitelisted' });
    }
  }
  
  // Check tenant status
  if (keys.tenants.status !== 'active') {
    return res.status(403).json({ error: 'Tenant account is not active' });
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
      total_requests: keys.total_requests + 1
    })
    .eq('id', keys.id);
  
  // Attach context to request
  req.apiKey = {
    apiKeyId: keys.id,
    tenantId: keys.tenant_id,
    senderIdId: keys.sender_id_id,
    senderName: keys.sender_ids.sender_id,
    scopes: keys.scopes,
    rateLimits: {
      perSecond: keys.rate_limit_per_second,
      perMinute: keys.rate_limit_per_minute,
      perHour: keys.rate_limit_per_hour,
      perDay: keys.rate_limit_per_day
    }
  };
  
  next();
}
```

### SMS Send Endpoint

```typescript
// src/routes/v1/send/sms.ts
import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../../config/database';
import { apiKeyAuth } from '../../../middleware/apiKey';
import { rateLimit } from '../../../middleware/rateLimit';
import { queueSMS } from '../../../services/sms';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

interface SendSMSRequest {
  from: string;
  recipients: (number | string)[];
  message: string;
  template_id?: string;
  template_variables?: Record<string, string>;
}

router.post('/', apiKeyAuth, rateLimit, async (req: Request, res: Response) => {
  const { from, recipients, message, template_id, template_variables } = req.body as SendSMSRequest;
  const { tenantId, senderIdId, senderName, apiKeyId } = req.apiKey!;
  
  // Validation
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients array is required' });
  }
  
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }
  
  if (from !== senderName) {
    return res.status(403).json({ 
      error: 'Sender ID mismatch', 
      message: `API key is bound to sender ID: ${senderName}` 
    });
  }
  
  // Normalize and validate recipients
  const normalizedRecipients: string[] = [];
  const invalidRecipients: string[] = [];
  
  for (const recipient of recipients) {
    const phone = normalizePhone(String(recipient));
    if (isValidMalawiPhone(phone)) {
      normalizedRecipients.push(phone);
    } else {
      invalidRecipients.push(String(recipient));
    }
  }
  
  if (normalizedRecipients.length === 0) {
    return res.status(400).json({ 
      error: 'No valid recipients', 
      invalid_recipients: invalidRecipients 
    });
  }
  
  // Get pricing
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('balance_mwk, subscription_tier_id, subscription_tiers(sms_price_mwk)')
    .eq('id', tenantId)
    .single();
  
  const pricePerSMS = tenant?.subscription_tiers?.sms_price_mwk || 18.0000;
  const totalCost = normalizedRecipients.length * pricePerSMS;
  
  // Check balance
  if (tenant!.balance_mwk < totalCost) {
    return res.status(402).json({ 
      error: 'Insufficient balance',
      required: totalCost,
      available: tenant!.balance_mwk
    });
  }
  
  // Create batch
  const batchId = uuidv4();
  const requestId = uuidv4();
  
  const { data: batch, error: batchError } = await supabaseAdmin
    .from('message_batches')
    .insert({
      id: batchId,
      tenant_id: tenantId,
      api_key_id: apiKeyId,
      sender_id_id: senderIdId,
      channel: 'sms',
      sender_name: senderName,
      content: message,
      template_id,
      template_variables,
      total_recipients: normalizedRecipients.length,
      total_cost_mwk: totalCost,
      cost_per_message_mwk: pricePerSMS,
      status: 'processing',
      request_ip: req.ip,
      request_user_agent: req.headers['user-agent'],
      request_id: requestId,
      processing_started_at: new Date().toISOString()
    })
    .select()
    .single();
  
  if (batchError) {
    return res.status(500).json({ error: 'Failed to create batch' });
  }
  
  // Deduct balance atomically
  const { error: balanceError } = await supabaseAdmin.rpc('deduct_balance', {
    p_tenant_id: tenantId,
    p_amount: totalCost,
    p_reference_type: 'message_batch',
    p_reference_id: batchId,
    p_description: `SMS batch to ${normalizedRecipients.length} recipients`,
    p_message_count: normalizedRecipients.length,
    p_cost_per_message: pricePerSMS
  });
  
  if (balanceError) {
    // Rollback batch
    await supabaseAdmin
      .from('message_batches')
      .update({ status: 'failed' })
      .eq('id', batchId);
    
    return res.status(402).json({ error: 'Failed to deduct balance' });
  }
  
  // Create individual messages
  const messages = normalizedRecipients.map(recipient => ({
    tenant_id: tenantId,
    batch_id: batchId,
    recipient,
    cost_mwk: pricePerSMS,
    status: 'queued'
  }));
  
  const { error: messagesError } = await supabaseAdmin
    .from('messages')
    .insert(messages);
  
  if (messagesError) {
    return res.status(500).json({ error: 'Failed to create messages' });
  }
  
  // Queue for sending via Kannel
  await queueSMS(batchId);
  
  // Get updated balance
  const { data: updatedTenant } = await supabaseAdmin
    .from('tenants')
    .select('balance_mwk')
    .eq('id', tenantId)
    .single();
  
  return res.status(200).json({
    success: true,
    batch_id: batchId,
    request_id: requestId,
    total_recipients: normalizedRecipients.length,
    valid_recipients: normalizedRecipients.length,
    invalid_recipients: invalidRecipients.length > 0 ? invalidRecipients : undefined,
    total_cost_mwk: totalCost,
    balance_remaining_mwk: updatedTenant!.balance_mwk,
    status: 'processing'
  });
});

// Helper functions
function normalizePhone(phone: string): string {
  phone = phone.replace(/[^0-9]/g, '');
  
  if (phone.startsWith('09')) {
    return '265' + phone.substring(1);
  } else if (phone.startsWith('08')) {
    return '265' + phone.substring(1);
  } else if (phone.startsWith('9') && phone.length === 9) {
    return '265' + phone;
  } else if (phone.startsWith('8') && phone.length === 9) {
    return '265' + phone;
  }
  
  return phone;
}

function isValidMalawiPhone(phone: string): boolean {
  return /^265[89][0-9]{8}$/.test(phone);
}

export default router;
```

### Balance Deduction Function (SQL)

Create this function in Supabase:

```sql
CREATE OR REPLACE FUNCTION deduct_balance(
  p_tenant_id UUID,
  p_amount DECIMAL(15, 2),
  p_reference_type TEXT,
  p_reference_id UUID,
  p_description TEXT,
  p_message_count INTEGER DEFAULT NULL,
  p_cost_per_message DECIMAL(10, 4) DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_current_balance DECIMAL(15, 2);
  v_new_balance DECIMAL(15, 2);
BEGIN
  -- Lock the tenant row
  SELECT balance_mwk INTO v_current_balance
  FROM tenants
  WHERE id = p_tenant_id
  FOR UPDATE;
  
  -- Check sufficient balance
  IF v_current_balance < p_amount THEN
    RETURN FALSE;
  END IF;
  
  -- Calculate new balance
  v_new_balance := v_current_balance - p_amount;
  
  -- Update tenant balance
  UPDATE tenants
  SET balance_mwk = v_new_balance, updated_at = NOW()
  WHERE id = p_tenant_id;
  
  -- Insert ledger entry
  INSERT INTO balance_ledger (
    tenant_id,
    entry_type,
    amount_mwk,
    balance_after_mwk,
    reference_type,
    reference_id,
    description,
    message_count,
    cost_per_message_mwk
  ) VALUES (
    p_tenant_id,
    'debit',
    p_amount,
    v_new_balance,
    p_reference_type,
    p_reference_id,
    p_description,
    p_message_count,
    p_cost_per_message
  );
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
```

---

## Kannel SMPP Integration

### Kannel Configuration

`/etc/kannel/kannel.conf`:

```conf
#---------------------------------------------
# CORE SETTINGS
#---------------------------------------------
group = core
admin-port = 13000
admin-password = secure-admin-password
admin-allow-ip = "127.0.0.1"
smsbox-port = 13001
log-file = "/var/log/kannel/bearerbox.log"
log-level = 0
access-log = "/var/log/kannel/access.log"

#---------------------------------------------
# SMSBOX SETTINGS
#---------------------------------------------
group = smsbox
bearerbox-host = 127.0.0.1
sendsms-port = 13013
sendsms-chars = "0123456789 +-"
log-file = "/var/log/kannel/smsbox.log"
log-level = 0
access-log = "/var/log/kannel/smsbox-access.log"

#---------------------------------------------
# SENDSMS USER
#---------------------------------------------
group = sendsms-user
username = api
password = secure-api-password
concatenation = true
max-messages = 10

#---------------------------------------------
# TNM SMSC CONNECTION
#---------------------------------------------
group = smsc
smsc = smpp
smsc-id = tnm
host = smpp.tnm.co.mw
port = 2775
smsc-username = your-tnm-username
smsc-password = your-tnm-password
system-type = ""
interface-version = 34
address-range = ""
source-addr-ton = 5
source-addr-npi = 0
dest-addr-ton = 1
dest-addr-npi = 1
enquire-link-interval = 30
reconnect-delay = 10
allowed-prefix = "2658"

#---------------------------------------------
# AIRTEL SMSC CONNECTION
#---------------------------------------------
group = smsc
smsc = smpp
smsc-id = airtel
host = smpp.airtel.mw
port = 2775
smsc-username = your-airtel-username
smsc-password = your-airtel-password
system-type = ""
interface-version = 34
address-range = ""
source-addr-ton = 5
source-addr-npi = 0
dest-addr-ton = 1
dest-addr-npi = 1
enquire-link-interval = 30
reconnect-delay = 10
allowed-prefix = "2659"

#---------------------------------------------
# DLR URL
#---------------------------------------------
group = sms-service
keyword = default
get-url = "http://127.0.0.1:3000/webhooks/kannel/dlr?id=%I&status=%d&to=%p&from=%P&time=%t"
```

### Sending SMS via Kannel

```typescript
// src/services/sms.ts
import axios from 'axios';
import { supabaseAdmin } from '../config/database';

const KANNEL_URL = process.env.KANNEL_HOST || '127.0.0.1';
const KANNEL_PORT = process.env.KANNEL_PORT || '13013';
const KANNEL_USER = process.env.KANNEL_USERNAME || 'api';
const KANNEL_PASS = process.env.KANNEL_PASSWORD || 'password';

export async function queueSMS(batchId: string) {
  // Get batch with messages
  const { data: batch } = await supabaseAdmin
    .from('message_batches')
    .select('*, messages(*)')
    .eq('id', batchId)
    .single();
  
  if (!batch) return;
  
  // Process each message
  for (const message of batch.messages) {
    try {
      // Update status to sending
      await supabaseAdmin
        .from('messages')
        .update({ status: 'sending', sent_at: new Date().toISOString() })
        .eq('id', message.id);
      
      // Send via Kannel
      const response = await axios.get(`http://${KANNEL_URL}:${KANNEL_PORT}/cgi-bin/sendsms`, {
        params: {
          username: KANNEL_USER,
          password: KANNEL_PASS,
          to: message.recipient,
          from: batch.sender_name,
          text: batch.content,
          dlr-mask: 31, // All DLR types
          dlr-url: `http://127.0.0.1:3000/webhooks/kannel/dlr?msg_id=${message.id}`
        }
      });
      
      // Extract Kannel message ID from response
      const kannelId = response.data.match(/(\d+)/)?.[1] || null;
      
      // Update message with provider info
      await supabaseAdmin
        .from('messages')
        .update({
          status: 'sent',
          provider: 'kannel',
          provider_message_id: kannelId,
          provider_response: { raw: response.data }
        })
        .eq('id', message.id);
      
      // Update batch counters
      await supabaseAdmin
        .from('message_batches')
        .update({ total_sent: batch.total_sent + 1 })
        .eq('id', batchId);
      
    } catch (error: any) {
      // Mark as failed
      await supabaseAdmin
        .from('messages')
        .update({
          status: 'failed',
          failed_at: new Date().toISOString(),
          error_message: error.message,
          retry_count: message.retry_count + 1,
          next_retry_at: message.retry_count < 3 
            ? new Date(Date.now() + 60000 * Math.pow(2, message.retry_count)).toISOString()
            : null
        })
        .eq('id', message.id);
      
      await supabaseAdmin
        .from('message_batches')
        .update({ total_failed: batch.total_failed + 1 })
        .eq('id', batchId);
    }
  }
  
  // Finalize batch
  const { data: updatedBatch } = await supabaseAdmin
    .from('message_batches')
    .select('total_recipients, total_sent, total_delivered, total_failed')
    .eq('id', batchId)
    .single();
  
  let status = 'completed';
  if (updatedBatch!.total_failed === updatedBatch!.total_recipients) {
    status = 'failed';
  } else if (updatedBatch!.total_failed > 0) {
    status = 'partial';
  }
  
  await supabaseAdmin
    .from('message_batches')
    .update({ 
      status, 
      completed_at: new Date().toISOString() 
    })
    .eq('id', batchId);
}
```

### DLR Webhook Handler

```typescript
// src/routes/webhooks/kannel.ts
import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../config/database';

const router = Router();

// Kannel DLR statuses
const DLR_STATUS_MAP: Record<string, string> = {
  '1': 'delivered',    // Delivered to phone
  '2': 'failed',       // Non-Delivered to Phone
  '4': 'sent',         // Queued on SMSC
  '8': 'sent',         // Delivered to SMSC
  '16': 'failed'       // Non-Delivered to SMSC
};

router.get('/dlr', async (req: Request, res: Response) => {
  const { msg_id, id, status, to, from, time } = req.query;
  
  const messageId = msg_id as string;
  const dlrStatus = status as string;
  
  if (!messageId) {
    return res.status(400).send('Missing msg_id');
  }
  
  const mappedStatus = DLR_STATUS_MAP[dlrStatus] || 'sent';
  
  // Update message
  const updateData: any = {
    dlr_status: dlrStatus,
    dlr_received_at: new Date().toISOString(),
    dlr_raw: { id, status: dlrStatus, to, from, time },
    status: mappedStatus,
    updated_at: new Date().toISOString()
  };
  
  if (mappedStatus === 'delivered') {
    updateData.delivered_at = new Date().toISOString();
  } else if (mappedStatus === 'failed') {
    updateData.failed_at = new Date().toISOString();
  }
  
  const { data: message } = await supabaseAdmin
    .from('messages')
    .update(updateData)
    .eq('id', messageId)
    .select('batch_id')
    .single();
  
  // Update batch counters
  if (message?.batch_id) {
    if (mappedStatus === 'delivered') {
      await supabaseAdmin.rpc('increment_batch_delivered', {
        p_batch_id: message.batch_id
      });
    } else if (mappedStatus === 'failed') {
      await supabaseAdmin.rpc('increment_batch_failed', {
        p_batch_id: message.batch_id
      });
    }
  }
  
  res.status(200).send('OK');
});

export default router;
```

---

## PayChangu Payment Integration

### Creating a Top-Up Invoice

```typescript
// src/routes/v1/billing.ts
import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../config/database';
import axios from 'axios';

const router = Router();

const PAYCHANGU_API = 'https://api.paychangu.com';
const PAYCHANGU_KEY = process.env.PAYCHANGU_API_KEY!;
const PAYCHANGU_SECRET = process.env.PAYCHANGU_SECRET_KEY!;

router.post('/topup', async (req: Request, res: Response) => {
  const { tenant_id, amount_mwk, payment_method } = req.body;
  
  // Create invoice
  const { data: invoice, error: invoiceError } = await supabaseAdmin
    .from('invoices')
    .insert({
      tenant_id,
      invoice_type: 'topup',
      subtotal_mwk: amount_mwk,
      total_mwk: amount_mwk,
      line_items: [
        { description: 'Account Top-Up', amount: amount_mwk }
      ]
    })
    .select()
    .single();
  
  if (invoiceError) {
    return res.status(500).json({ error: 'Failed to create invoice' });
  }
  
  // Create PayChangu checkout
  const checkoutResponse = await axios.post(
    `${PAYCHANGU_API}/payment/checkout`,
    {
      amount: amount_mwk,
      currency: 'MWK',
      email: req.user!.email,
      first_name: req.user!.full_name.split(' ')[0],
      last_name: req.user!.full_name.split(' ').slice(1).join(' '),
      callback_url: `${process.env.API_BASE_URL}/webhooks/paychangu`,
      return_url: `${process.env.FRONTEND_URL}/billing/success`,
      cancel_url: `${process.env.FRONTEND_URL}/billing/cancelled`,
      tx_ref: invoice.invoice_number,
      customization: {
        title: 'Comms Gateway Top-Up',
        description: `Top-up MWK ${amount_mwk.toLocaleString()}`
      }
    },
    {
      headers: {
        'Authorization': `Bearer ${PAYCHANGU_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  // Create pending transaction
  await supabaseAdmin
    .from('transactions')
    .insert({
      tenant_id,
      invoice_id: invoice.id,
      transaction_type: 'payment',
      payment_method,
      amount_mwk,
      status: 'pending',
      paychangu_checkout_id: checkoutResponse.data.data.checkout_url_id,
      metadata: checkoutResponse.data
    });
  
  return res.json({
    invoice_number: invoice.invoice_number,
    checkout_url: checkoutResponse.data.data.checkout_url,
    amount_mwk
  });
});

export default router;
```

### PayChangu Webhook Handler

```typescript
// src/routes/webhooks/paychangu.ts
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../../config/database';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  // Verify webhook signature
  const signature = req.headers['x-paychangu-signature'] as string;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.PAYCHANGU_WEBHOOK_SECRET!)
    .update(JSON.stringify(req.body))
    .digest('hex');
  
  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  const { event, data } = req.body;
  
  if (event === 'charge.success') {
    const txRef = data.tx_ref;  // Our invoice number
    
    // Get transaction
    const { data: transaction } = await supabaseAdmin
      .from('transactions')
      .select('*, invoices(*)')
      .eq('paychangu_checkout_id', data.checkout_url_id)
      .single();
    
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    
    // Update transaction
    await supabaseAdmin
      .from('transactions')
      .update({
        status: 'completed',
        paychangu_reference: data.reference,
        payment_provider: data.payment_method,
        fee_mwk: data.fee || 0,
        net_amount_mwk: transaction.amount_mwk - (data.fee || 0),
        payer_phone: data.customer?.phone,
        payer_email: data.customer?.email,
        payer_name: data.customer?.name,
        completed_at: new Date().toISOString(),
        metadata: data
      })
      .eq('id', transaction.id);
    
    // Update invoice
    await supabaseAdmin
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        payment_reference: data.reference
      })
      .eq('id', transaction.invoice_id);
    
    // Credit balance
    await supabaseAdmin.rpc('credit_balance', {
      p_tenant_id: transaction.tenant_id,
      p_amount: transaction.amount_mwk,
      p_reference_type: 'transaction',
      p_reference_id: transaction.id,
      p_description: `Top-up via ${data.payment_method}`
    });
  }
  
  res.status(200).json({ received: true });
});

export default router;
```

### Credit Balance Function

```sql
CREATE OR REPLACE FUNCTION credit_balance(
  p_tenant_id UUID,
  p_amount DECIMAL(15, 2),
  p_reference_type TEXT,
  p_reference_id UUID,
  p_description TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_current_balance DECIMAL(15, 2);
  v_new_balance DECIMAL(15, 2);
BEGIN
  -- Get current balance with lock
  SELECT balance_mwk INTO v_current_balance
  FROM tenants
  WHERE id = p_tenant_id
  FOR UPDATE;
  
  -- Calculate new balance
  v_new_balance := v_current_balance + p_amount;
  
  -- Update tenant balance
  UPDATE tenants
  SET balance_mwk = v_new_balance, updated_at = NOW()
  WHERE id = p_tenant_id;
  
  -- Insert ledger entry
  INSERT INTO balance_ledger (
    tenant_id,
    entry_type,
    amount_mwk,
    balance_after_mwk,
    reference_type,
    reference_id,
    description
  ) VALUES (
    p_tenant_id,
    'credit',
    p_amount,
    v_new_balance,
    p_reference_type,
    p_reference_id,
    p_description
  );
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
```

---

## API Reference

### Send SMS

```
POST /api/v1/send/sms
Headers:
  X-API-Key: lc_live_xxxxxxxxxxxxxxxx

Body:
{
  "from": "MYSENDER",
  "recipients": [265912345678, 265887654321],
  "message": "Hello World!"
}

Response:
{
  "success": true,
  "batch_id": "uuid",
  "request_id": "uuid",
  "total_recipients": 2,
  "total_cost_mwk": 36.00,
  "balance_remaining_mwk": 964.00,
  "status": "processing"
}
```

### Check Batch Status

```
GET /api/v1/batches/{batch_id}
Headers:
  X-API-Key: lc_live_xxxxxxxxxxxxxxxx

Response:
{
  "id": "uuid",
  "status": "completed",
  "total_recipients": 2,
  "total_sent": 2,
  "total_delivered": 2,
  "total_failed": 0,
  "messages": [
    {
      "id": "uuid",
      "recipient": "265912345678",
      "status": "delivered",
      "delivered_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### Get Balance

```
GET /api/v1/balance
Headers:
  X-API-Key: lc_live_xxxxxxxxxxxxxxxx

Response:
{
  "balance_mwk": 1000.00,
  "currency": "MWK"
}
```

---

## Migration Scripts

All migration scripts are stored in Supabase and can be viewed in the dashboard under Database > Migrations.

### Migration Order

1. `001_create_subscription_tiers`
2. `002_create_users`
3. `003_create_roles`
4. `004_create_tenants`
5. `005_create_tenant_members`
6. `006_create_kyc_documents`
7. `007_create_sender_ids`
8. `008_create_api_keys`
9. `009_create_message_templates`
10. `010_create_contacts`
11. `011_create_contact_lists`
12. `012_create_campaigns`
13. `013_create_message_batches`
14. `014_create_messages`
15. `015_create_invoices`
16. `016_create_transactions`
17. `017_create_balance_ledger`
18. `018_create_audit_logs`
19. `019_create_helper_functions`
20. `020_enable_rls`
21. `021_rls_policies_core`
22. `022_rls_policies_kyc_sender`
23. `023_rls_policies_api_templates`
24. `024_rls_policies_contacts_campaigns`
25. `025_rls_policies_messaging`
26. `026_rls_policies_billing`
27. `027_create_storage_buckets`

---

## Quick Start Checklist

- [ ] Set up Supabase project and run migrations
- [ ] Configure Firebase project for authentication
- [ ] Set up Ubuntu server with Node.js, PM2, Redis
- [ ] Install and configure Kannel with TNM/Airtel SMSC connections
- [ ] Set up PayChangu merchant account
- [ ] Configure environment variables
- [ ] Deploy Express.js backend with PM2
- [ ] Set up Nginx reverse proxy with SSL
- [ ] Create platform admin user
- [ ] Seed global sender ID (LETTSCOMM)
- [ ] Test end-to-end SMS flow

---

## Support

For technical support or questions about this documentation, contact the development team.

**Version:** 1.0.0  
**Last Updated:** 2024
