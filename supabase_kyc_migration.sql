-- ============================================================
-- KYC Documents table — clean schema for 2-document KYC flow
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Drop the old over-broad document_type constraint
ALTER TABLE kyc_documents
  DROP CONSTRAINT IF EXISTS kyc_documents_document_type_check;

-- 2. New constraint: exactly 2 document slots
--    business_registration = certificate of incorporation / business reg doc
--    director_id           = passport, national ID, or driving licence
ALTER TABLE kyc_documents
  ADD CONSTRAINT kyc_documents_document_type_check CHECK (
    document_type = ANY (ARRAY[
      'business_registration'::text,
      'director_id'::text
    ])
  );

-- 3. Add id_type column — required when document_type = 'director_id'
--    Identifies which form of ID the director submitted
ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS id_type TEXT NULL
    CHECK (id_type IS NULL OR id_type = ANY (ARRAY[
      'passport'::text,
      'national_id'::text,
      'driving_licence'::text
    ]));

-- 4. Add file_url column (full public URL — Firebase, Supabase, or any provider)
ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS file_url TEXT NULL;

-- 5. Add storage_provider column
ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'supabase'
    CHECK (storage_provider IN ('firebase', 'supabase', 'other'));

-- 6. Backfill file_url from storage_path for existing rows
UPDATE kyc_documents
  SET file_url = storage_path
  WHERE file_url IS NULL AND storage_path IS NOT NULL;

-- 7. Add a partial unique constraint — one active (non-rejected) document per type per tenant
--    Prevents duplicate submissions for the same slot
CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_documents_one_per_type
  ON kyc_documents (tenant_id, document_type)
  WHERE status != 'rejected';

-- 8. DB-level submission lock trigger
--    Belt-and-suspenders: blocks any INSERT into kyc_documents if the tenant's
--    kyc_status is already 'submitted' (under review) or 'approved'.
--    The application layer enforces this too; this trigger is the final guard.
CREATE OR REPLACE FUNCTION fn_block_kyc_insert_when_locked()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_kyc_status TEXT;
BEGIN
  SELECT kyc_status INTO v_kyc_status
  FROM tenants WHERE id = NEW.tenant_id;

  IF v_kyc_status = 'submitted' THEN
    RAISE EXCEPTION
      'KYC documents are under review for tenant %. No new submissions allowed until the review is complete.',
      NEW.tenant_id;
  END IF;

  IF v_kyc_status = 'approved' THEN
    RAISE EXCEPTION
      'KYC is already approved for tenant %. No new document submissions are permitted.',
      NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_kyc_insert_when_locked ON kyc_documents;

CREATE TRIGGER trg_block_kyc_insert_when_locked
  BEFORE INSERT ON kyc_documents
  FOR EACH ROW EXECUTE FUNCTION fn_block_kyc_insert_when_locked();

-- ============================================================
-- VERIFICATION
-- ============================================================

-- Check constraint definition
-- SELECT pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'kyc_documents'::regclass
--   AND conname = 'kyc_documents_document_type_check';

-- Check new columns
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'kyc_documents'
-- ORDER BY ordinal_position;
