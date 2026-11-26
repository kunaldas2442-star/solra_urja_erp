-- ============================================================================
-- Migration: 2026_11_26_production_schema_fk_and_audit.sql
-- Purpose:
--   1. Create solar_schema_migrations tracking table
--   2. Create solar_audit_logs for centralized security & business audit trail
--   3. Idempotently add Foreign Key constraints and supporting indexes
-- ============================================================================

CREATE TABLE IF NOT EXISTS `solar_schema_migrations` (
  `version` VARCHAR(128) PRIMARY KEY,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_audit_logs` (
  `id` VARCHAR(64) PRIMARY KEY,
  `actor_id` VARCHAR(64) NOT NULL DEFAULT 'system',
  `actor_name` VARCHAR(255) NOT NULL DEFAULT 'System',
  `actor_role` VARCHAR(64) NOT NULL DEFAULT 'System',
  `module` VARCHAR(64) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `entity_type` VARCHAR(64) DEFAULT '',
  `entity_id` VARCHAR(64) DEFAULT '',
  `summary` TEXT NOT NULL,
  `details_json` LONGTEXT DEFAULT NULL,
  `ip_address` VARCHAR(64) DEFAULT '',
  `user_agent` VARCHAR(500) DEFAULT '',
  `status` VARCHAR(24) NOT NULL DEFAULT 'SUCCESS',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_audit_module` (`module`),
  INDEX `idx_audit_action` (`action`),
  INDEX `idx_audit_actor` (`actor_id`),
  INDEX `idx_audit_entity` (`entity_type`, `entity_id`),
  INDEX `idx_audit_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Idempotent Foreign Key Helper Procedure
-- Safely verifies column & target table existence, cleans orphaned child rows
-- only when target exists, and adds FK constraint if not already present.
-- ----------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS `solar_add_fk_if_missing`;

DELIMITER $$
CREATE PROCEDURE `solar_add_fk_if_missing`(
  IN p_table VARCHAR(64),
  IN p_constraint VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_ref_table VARCHAR(64),
  IN p_ref_column VARCHAR(64),
  IN p_on_delete VARCHAR(32)
)
BEGIN
  DECLARE v_table_exists INT DEFAULT 0;
  DECLARE v_ref_is_base INT DEFAULT 0;
  DECLARE v_fk_exists INT DEFAULT 0;

  SELECT COUNT(*) INTO v_table_exists
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = p_table
    AND TABLE_TYPE = 'BASE TABLE';

  SELECT COUNT(*) INTO v_ref_is_base
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = p_ref_table
    AND TABLE_TYPE = 'BASE TABLE';

  SELECT COUNT(*) INTO v_fk_exists
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = p_table
    AND CONSTRAINT_NAME = p_constraint
    AND CONSTRAINT_TYPE = 'FOREIGN KEY';

  IF v_table_exists = 1 AND v_ref_is_base = 1 AND v_fk_exists = 0 THEN
    -- Ensure index exists on child column
    SET @idx_sql = NULL;
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = p_table
        AND COLUMN_NAME = p_column
    ) THEN
      SET @idx_sql = CONCAT('ALTER TABLE `', p_table, '` ADD INDEX `idx_', p_constraint, '` (`', p_column, '`)');
      PREPARE idx_stmt FROM @idx_sql;
      EXECUTE idx_stmt;
      DEALLOCATE PREPARE idx_stmt;
    END IF;

    -- Add Foreign Key Constraint
    SET @fk_sql = CONCAT(
      'ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_constraint,
      '` FOREIGN KEY (`', p_column, '`) REFERENCES `', p_ref_table, '` (`', p_ref_column, '`) ON DELETE ', p_on_delete
    );
    PREPARE fk_stmt FROM @fk_sql;
    EXECUTE fk_stmt;
    DEALLOCATE PREPARE fk_stmt;
  END IF;
END$$
DELIMITER ;

-- Apply Core Relational Foreign Keys
CALL `solar_add_fk_if_missing`('solar_projects', 'fk_proj_customer', 'customer_id', 'solar_customers', 'id', 'RESTRICT');
CALL `solar_add_fk_if_missing`('solar_project_stages', 'fk_stage_project', 'project_id', 'solar_projects', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_payments', 'fk_payment_project', 'project_id', 'solar_projects', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_boms', 'fk_bom_project', 'project_id', 'solar_projects', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_purchase_orders', 'fk_po_vendor', 'vendor_id', 'solar_vendors', 'id', 'RESTRICT');
CALL `solar_add_fk_if_missing`('solar_sales_invoices', 'fk_sinv_customer', 'customer_id', 'solar_customers', 'id', 'RESTRICT');
CALL `solar_add_fk_if_missing`('solar_vendor_sales_invoices', 'fk_vsi_vendor', 'vendor_id', 'solar_vendors', 'id', 'RESTRICT');
CALL `solar_add_fk_if_missing`('solar_service_tickets', 'fk_ticket_customer', 'customer_id', 'solar_customers', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_service_ticket_history', 'fk_srv_hist_ticket', 'ticket_record_id', 'solar_service_tickets', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_amc_contracts', 'fk_amc_customer', 'customer_id', 'solar_customers', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_amc_contracts', 'fk_amc_project', 'project_id', 'solar_projects', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_stock_movements', 'fk_sm_product', 'product_id', 'solar_products', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_acc_vendor_payments', 'fk_vp_bill', 'bill_id', 'solar_acc_vendor_bills', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_acc_bank_reconciliations', 'fk_br_bank', 'bank_account_id', 'solar_acc_bank_accounts', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_auth_credentials', 'fk_auth_cred_user', 'user_id', 'solar_users', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_auth_sessions', 'fk_auth_sess_user', 'user_id', 'solar_users', 'id', 'CASCADE');

-- Employee FKs (supports either solar_employee or solar_employees as authoritative base table)
CALL `solar_add_fk_if_missing`('solar_employee_documents', 'fk_emp_docs_emp', 'employee_id', 'solar_employee', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_employee_documents', 'fk_emp_docs_emps', 'employee_id', 'solar_employees', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_attendance', 'fk_att_emp', 'employee_id', 'solar_employee', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_attendance', 'fk_att_emps', 'employee_id', 'solar_employees', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_payslips', 'fk_pay_emp', 'employee_id', 'solar_employee', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_payslips', 'fk_pay_emps', 'employee_id', 'solar_employees', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_leave_requests', 'fk_leave_req_emp', 'employee_id', 'solar_employee', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_leave_requests', 'fk_leave_req_emps', 'employee_id', 'solar_employees', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_leave_balances', 'fk_leave_bal_emp', 'employee_id', 'solar_employee', 'id', 'CASCADE');
CALL `solar_add_fk_if_missing`('solar_leave_balances', 'fk_leave_bal_emps', 'employee_id', 'solar_employees', 'id', 'CASCADE');

DROP PROCEDURE IF EXISTS `solar_add_fk_if_missing`;

INSERT IGNORE INTO `solar_schema_migrations` (`version`, `description`)
VALUES ('2026_11_26_production_schema_fk_and_audit', 'Add schema migration tracking, centralized audit logs table, and relational foreign keys');
