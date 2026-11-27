-- ==========================================================
-- Solar Urja ERP & CRM - Complete Production MySQL Schema
-- Domain: solar.klyiatechnology.com
-- Engine: InnoDB | Charset: utf8mb4 | Collation: utf8mb4_unicode_ci
-- ==========================================================

SET FOREIGN_KEY_CHECKS = 0;
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";

-- --------------------------------------------------------
-- Table structure for table `solar_schema_migrations`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_schema_migrations` (
  `version` VARCHAR(128) PRIMARY KEY,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_audit_logs`
-- --------------------------------------------------------
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

-- --------------------------------------------------------
-- Table structure for table `solar_users`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_users` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(191) NOT NULL UNIQUE,
  `password` VARCHAR(255) NOT NULL DEFAULT '',
  `role` VARCHAR(64) NOT NULL DEFAULT 'Super Admin',
  `phone` VARCHAR(32) DEFAULT '',
  `department` VARCHAR(64) DEFAULT 'Operations',
  `designation` VARCHAR(128) DEFAULT '',
  `employee_id` VARCHAR(64) DEFAULT NULL,
  `customer_id` VARCHAR(64) DEFAULT NULL,
  `avatar` TEXT,
  `photo_url` TEXT DEFAULT NULL,
  `is_field_worker` TINYINT(1) DEFAULT 0,
  `must_change_password` TINYINT(1) NOT NULL DEFAULT 0,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_users_role` (`role`),
  INDEX `idx_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_auth_credentials`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_auth_credentials` (
  `id` VARCHAR(64) PRIMARY KEY,
  `user_id` VARCHAR(64) NOT NULL UNIQUE,
  `email` VARCHAR(191) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(64) NOT NULL,
  `account_type` ENUM('ADMIN', 'EMPLOYEE', 'CUSTOMER') NOT NULL,
  `linked_entity_id` VARCHAR(64) DEFAULT NULL,
  `must_change_password` TINYINT(1) NOT NULL DEFAULT 0,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `failed_login_attempts` INT DEFAULT 0,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL,
  `password_changed_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_auth_cred_role` (`role`),
  INDEX `idx_auth_cred_type` (`account_type`),
  INDEX `idx_auth_cred_linked` (`linked_entity_id`),
  INDEX `idx_auth_cred_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_auth_sessions`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_auth_sessions` (
  `id` VARCHAR(128) PRIMARY KEY,
  `user_id` VARCHAR(64) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `role` VARCHAR(64) NOT NULL,
  `account_type` VARCHAR(32) NOT NULL,
  `linked_entity_id` VARCHAR(64) DEFAULT NULL,
  `ip_address` VARCHAR(64) DEFAULT NULL,
  `user_agent` TEXT DEFAULT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `last_active_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_auth_sess_user_id` (`user_id`),
  INDEX `idx_auth_sess_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_customers`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_customers` (
  `id` VARCHAR(64) PRIMARY KEY,
  `customer_code` VARCHAR(32) NOT NULL UNIQUE,
  `name` VARCHAR(255) NOT NULL,
  `company_name` VARCHAR(255) DEFAULT '',
  `customer_type` VARCHAR(32) DEFAULT 'Residential',
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT '',
  `password` VARCHAR(255) NOT NULL DEFAULT '123456',
  `site_address` TEXT NOT NULL,
  `city` VARCHAR(128) NOT NULL,
  `state` VARCHAR(128) DEFAULT 'Gujarat',
  `pincode` VARCHAR(16) DEFAULT '',
  `gst_number` VARCHAR(32) DEFAULT '',
  `electricity_consumer_no` VARCHAR(64) DEFAULT '',
  `sanctioned_load_kw` DECIMAL(10,2) DEFAULT 0.00,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `active_project_id` VARCHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_customers_status` (`status`),
  INDEX `idx_customers_phone` (`phone`),
  INDEX `idx_customers_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_leads`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_leads` (
  `id` VARCHAR(64) PRIMARY KEY,
  `customer_name` VARCHAR(255) NOT NULL,
  `company_name` VARCHAR(255) DEFAULT '',
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) DEFAULT '',
  `address` TEXT,
  `city` VARCHAR(128) DEFAULT '',
  `solar_capacity_kw` DECIMAL(10,2) DEFAULT 0.00,
  `estimated_value` DECIMAL(14,2) DEFAULT 0.00,
  `source` VARCHAR(64) DEFAULT 'Website',
  `assigned_salesperson_id` VARCHAR(64) DEFAULT '',
  `assigned_salesperson_name` VARCHAR(255) DEFAULT '',
  `status` VARCHAR(64) DEFAULT 'NEW',
  `notes` TEXT,
  `next_follow_up_date` DATE DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_leads_status` (`status`),
  INDEX `idx_leads_followup` (`next_follow_up_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_projects`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_projects` (
  `id` VARCHAR(64) PRIMARY KEY,
  `project_code` VARCHAR(32) NOT NULL UNIQUE,
  `customer_id` VARCHAR(64) NOT NULL,
  `customer_name` VARCHAR(255) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `capacity_kw` DECIMAL(10,2) NOT NULL,
  `total_value` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(64) DEFAULT 'PLANNING',
  `current_stage_key` VARCHAR(64) DEFAULT 'site_survey',
  `completion_percentage` INT DEFAULT 0,
  `project_manager_id` VARCHAR(64) DEFAULT '',
  `project_manager_name` VARCHAR(255) DEFAULT '',
  `site_address` TEXT NOT NULL,
  `city` VARCHAR(128) NOT NULL,
  `inverter_model` VARCHAR(128) DEFAULT '',
  `panel_model` VARCHAR(128) DEFAULT '',
  `structure_type` VARCHAR(128) DEFAULT 'Elevated GI Structure',
  `start_date` DATE DEFAULT NULL,
  `expected_completion_date` DATE DEFAULT NULL,
  `actual_completion_date` DATE DEFAULT NULL,
  `notes` TEXT,
  `assignments_json` LONGTEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_projects_customer` (`customer_id`),
  INDEX `idx_projects_status` (`status`),
  CONSTRAINT `fk_proj_customer` FOREIGN KEY (`customer_id`) REFERENCES `solar_customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_project_stages`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_project_stages` (
  `id` VARCHAR(64) PRIMARY KEY,
  `project_id` VARCHAR(64) NOT NULL,
  `stage_key` VARCHAR(64) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `stage_order` INT NOT NULL DEFAULT 1,
  `department` VARCHAR(64) NOT NULL,
  `assigned_role` VARCHAR(64) NOT NULL,
  `assigned_employee_id` VARCHAR(64) DEFAULT '',
  `assigned_employee_name` VARCHAR(255) DEFAULT '',
  `status` VARCHAR(64) DEFAULT 'NOT STARTED',
  `priority` VARCHAR(32) DEFAULT 'MEDIUM',
  `start_date` DATE DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `completed_date` DATE DEFAULT NULL,
  `checklist_json` LONGTEXT,
  `photos_json` LONGTEXT,
  `documents_json` LONGTEXT,
  `gps_location_json` LONGTEXT,
  `notes` TEXT,
  `approved_by` VARCHAR(255) DEFAULT '',
  `approved_at` DATETIME DEFAULT NULL,
  `rejection_reason` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_stages_project` (`project_id`),
  INDEX `idx_stages_status` (`status`),
  CONSTRAINT `fk_stage_project` FOREIGN KEY (`project_id`) REFERENCES `solar_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_site_surveys`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_site_surveys` (
  `id` VARCHAR(64) PRIMARY KEY,
  `project_id` VARCHAR(64) DEFAULT '',
  `customer_id` VARCHAR(64) DEFAULT '',
  `engineer_id` VARCHAR(64) DEFAULT '',
  `engineer_name` VARCHAR(255) NOT NULL,
  `survey_date` DATE NOT NULL,
  `status` VARCHAR(32) DEFAULT 'DRAFT',
  `site_address` TEXT NOT NULL,
  `latitude` DECIMAL(10,7) DEFAULT NULL,
  `longitude` DECIMAL(10,7) DEFAULT NULL,
  `location_name` VARCHAR(255) DEFAULT '',
  `roof_type` VARCHAR(64) DEFAULT 'RCC Flat',
  `roof_area_sqft` DECIMAL(12,2) DEFAULT 0.00,
  `shadow_free_area_sqft` DECIMAL(12,2) DEFAULT 0.00,
  `shadow_obstacles` TEXT,
  `electricity_bill_number` VARCHAR(64) DEFAULT '',
  `monthly_avg_consumption` DECIMAL(10,2) DEFAULT 0.00,
  `sanctioned_load_kw` DECIMAL(10,2) DEFAULT 0.00,
  `tariff_rate` DECIMAL(8,2) DEFAULT 0.00,
  `existing_structure_condition` TEXT,
  `recommended_capacity_kw` DECIMAL(10,2) DEFAULT 0.00,
  `feasibility_score` VARCHAR(32) DEFAULT 'GOOD',
  `photos_json` LONGTEXT,
  `notes` TEXT,
  `reviewed_by` VARCHAR(255) DEFAULT '',
  `reviewed_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_surveys_project` (`project_id`),
  INDEX `idx_surveys_engineer` (`engineer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_quotations`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_quotations` (
  `id` VARCHAR(64) PRIMARY KEY,
  `quotation_number` VARCHAR(64) NOT NULL UNIQUE,
  `customer_id` VARCHAR(64) DEFAULT '',
  `customer_name` VARCHAR(255) NOT NULL,
  `project_id` VARCHAR(64) DEFAULT '',
  `capacity_kw` DECIMAL(10,2) NOT NULL,
  `rate_per_wp` DECIMAL(10,2) DEFAULT 0.00,
  `base_amount` DECIMAL(14,2) DEFAULT 0.00,
  `tax_amount` DECIMAL(14,2) DEFAULT 0.00,
  `panel_brand` VARCHAR(128) DEFAULT '',
  `inverter_brand` VARCHAR(128) DEFAULT '',
  `structure_type` VARCHAR(128) DEFAULT '',
  `items_json` LONGTEXT,
  `subtotal` DECIMAL(14,2) DEFAULT 0.00,
  `discount_amount` DECIMAL(14,2) DEFAULT 0.00,
  `gst_percent` DECIMAL(5,2) DEFAULT 13.80,
  `gst_amount` DECIMAL(14,2) DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL,
  `payment_terms` TEXT,
  `warranty_details` TEXT,
  `terms_and_conditions` TEXT,
  `status` VARCHAR(32) DEFAULT 'DRAFT',
  `valid_until` DATE DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `accepted_at` DATETIME DEFAULT NULL,
  INDEX `idx_quotations_customer` (`customer_id`),
  INDEX `idx_quotations_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_payments`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_payments` (
  `id` VARCHAR(64) PRIMARY KEY,
  `receipt_number` VARCHAR(64) NOT NULL UNIQUE,
  `project_id` VARCHAR(64) NOT NULL,
  `customer_id` VARCHAR(64) NOT NULL,
  `customer_name` VARCHAR(255) NOT NULL,
  `milestone` VARCHAR(128) NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `status` VARCHAR(32) DEFAULT 'PENDING',
  `due_date` DATE DEFAULT NULL,
  `paid_date` DATE DEFAULT NULL,
  `payment_mode` VARCHAR(64) DEFAULT 'Bank NEFT/RTGS',
  `transaction_reference` VARCHAR(128) DEFAULT '',
  `notes` TEXT,
  `invoice_id` VARCHAR(64) DEFAULT '',
  `invoice_number` VARCHAR(64) DEFAULT '',
  `bank_account_id` VARCHAR(64) DEFAULT '',
  `journal_entry_id` VARCHAR(64) DEFAULT '',
  `tally_sync_status` VARCHAR(32) DEFAULT 'NOT SYNCED',
  `tally_reference` VARCHAR(128) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_payments_project` (`project_id`),
  INDEX `idx_payments_status` (`status`),
  CONSTRAINT `fk_payment_project` FOREIGN KEY (`project_id`) REFERENCES `solar_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_expenses`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_expenses` (
  `id` VARCHAR(64) PRIMARY KEY,
  `expense_number` VARCHAR(64) NOT NULL UNIQUE,
  `project_id` VARCHAR(64) DEFAULT '',
  `project_code` VARCHAR(64) DEFAULT '',
  `vendor_name` VARCHAR(255) NOT NULL,
  `category` VARCHAR(128) NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `expense_date` DATE NOT NULL,
  `payment_mode` VARCHAR(64) DEFAULT 'Bank Payment',
  `reference_no` VARCHAR(128) DEFAULT '',
  `notes` TEXT,
  `receipt_url` TEXT,
  `approved_by` VARCHAR(255) DEFAULT '',
  `expense_type` VARCHAR(32) DEFAULT 'DIRECT_EXPENSE',
  `status` VARCHAR(32) DEFAULT 'PAID',
  `employee_id` VARCHAR(64) DEFAULT '',
  `employee_name` VARCHAR(255) DEFAULT '',
  `gst_amount` DECIMAL(14,2) DEFAULT 0.00,
  `itc_eligible` TINYINT(1) DEFAULT 0,
  `bank_account_id` VARCHAR(64) DEFAULT '',
  `expense_account_id` VARCHAR(64) DEFAULT '',
  `journal_entry_id` VARCHAR(64) DEFAULT '',
  `approved_at` VARCHAR(64) DEFAULT NULL,
  `rejection_reason` TEXT,
  `paid_at` VARCHAR(64) DEFAULT NULL,
  `paid_by` VARCHAR(255) DEFAULT '',
  `tally_sync_status` VARCHAR(32) DEFAULT 'NOT SYNCED',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_expenses_project` (`project_id`),
  INDEX `idx_expenses_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_employees`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_employees` (
  `id` VARCHAR(64) PRIMARY KEY,
  `employee_code` VARCHAR(32) NOT NULL UNIQUE,
  `name` VARCHAR(255) NOT NULL,
  `photo_url` TEXT,
  `documents_json` LONGTEXT DEFAULT NULL,
  `department` VARCHAR(64) NOT NULL,
  `designation` VARCHAR(128) NOT NULL,
  `phone` VARCHAR(32) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `joining_date` DATE DEFAULT NULL,
  `salary_monthly` DECIMAL(12,2) DEFAULT 0.00,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `current_site_location` VARCHAR(255) DEFAULT '',
  `login_enabled` TINYINT(1) DEFAULT 1,
  `auth_uid` VARCHAR(64) DEFAULT NULL,
  `system_role` VARCHAR(64) DEFAULT 'Super Admin',
  `assigned_role` VARCHAR(64) DEFAULT NULL,
  `is_field_worker` TINYINT(1) DEFAULT 0,
  `account_status` VARCHAR(32) DEFAULT 'ACTIVE',
  `account_created_at` VARCHAR(64) DEFAULT NULL,
  `account_created_by` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_employees_dept` (`department`),
  INDEX `idx_employees_status` (`status`),
  INDEX `idx_employees_auth_uid` (`auth_uid`),
  INDEX `idx_employees_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_employee_documents`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_employee_documents` (
  `id` VARCHAR(64) PRIMARY KEY,
  `employee_id` VARCHAR(64) NOT NULL,
  `category` VARCHAR(64) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL,
  `file_url` VARCHAR(500) NOT NULL,
  `mime_type` VARCHAR(128) NOT NULL,
  `file_size` BIGINT DEFAULT 0,
  `uploaded_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `uploaded_by` VARCHAR(255) DEFAULT 'HR Administrator',
  `notes` TEXT,
  INDEX `idx_emp_docs_empid` (`employee_id`),
  INDEX `idx_emp_docs_cat` (`category`),
  CONSTRAINT `fk_emp_docs_emps` FOREIGN KEY (`employee_id`) REFERENCES `solar_employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- --------------------------------------------------------
-- Table structure for table `solar_attendance`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_attendance` (
  `id` VARCHAR(64) PRIMARY KEY,
  `employee_id` VARCHAR(64) NOT NULL,
  `employee_name` VARCHAR(255) NOT NULL,
  `attendance_date` DATE NOT NULL,
  `check_in_time` VARCHAR(16) NOT NULL,
  `check_out_time` VARCHAR(16) DEFAULT NULL,
  `check_in_gps_json` LONGTEXT,
  `check_out_gps_json` LONGTEXT,
  `site_project_id` VARCHAR(64) DEFAULT '',
  `site_project_title` VARCHAR(255) DEFAULT '',
  `status` VARCHAR(32) DEFAULT 'PRESENT',
  `fuel_expense_json` LONGTEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_attendance_emp_date` (`employee_id`, `attendance_date`),
  CONSTRAINT `fk_att_emps` FOREIGN KEY (`employee_id`) REFERENCES `solar_employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_payslips`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_payslips` (
  `id` VARCHAR(64) PRIMARY KEY,
  `employee_id` VARCHAR(64) NOT NULL,
  `employee_name` VARCHAR(255) NOT NULL,
  `month` VARCHAR(32) NOT NULL,
  `year` INT NOT NULL,
  `basic_salary` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `allowances` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `deductions` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `net_salary` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `payment_status` VARCHAR(32) DEFAULT 'PAID',
  `payment_date` DATE DEFAULT NULL,
  `notes` TEXT,
  `additional_expenses_json` LONGTEXT DEFAULT NULL,
  `deductions_json` LONGTEXT DEFAULT NULL,
  `overtime_hours` DECIMAL(6,2) DEFAULT 0.00,
  `overtime_rate` DECIMAL(10,2) DEFAULT 0.00,
  `payment_mode` VARCHAR(64) DEFAULT 'NEFT/RTGS Bank Transfer',
  `bank_reference_no` VARCHAR(128) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_payslips_emp` (`employee_id`),
  CONSTRAINT `fk_pay_emps` FOREIGN KEY (`employee_id`) REFERENCES `solar_employees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_holidays`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_holidays` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `holiday_date` DATE NOT NULL,
  `type` VARCHAR(64) DEFAULT 'Mandatory',
  `description` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_service_tickets`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_service_tickets` (
  `id` VARCHAR(64) PRIMARY KEY,
  `ticket_id` VARCHAR(64) NOT NULL UNIQUE,
  `customer_id` VARCHAR(64) NOT NULL,
  `customer_name` VARCHAR(255) NOT NULL,
  `project_id` VARCHAR(64) NOT NULL,
  `project_title` VARCHAR(255) DEFAULT '',
  `issue` TEXT NOT NULL,
  `category` VARCHAR(64) DEFAULT 'Inverter Warning',
  `priority` VARCHAR(32) DEFAULT 'MEDIUM',
  `assigned_technician_id` VARCHAR(64) DEFAULT '',
  `assigned_technician_name` VARCHAR(255) DEFAULT '',
  `status` VARCHAR(32) DEFAULT 'OPEN',
  `scheduled_date` DATE DEFAULT NULL,
  `resolved_date` DATE DEFAULT NULL,
  `notes` TEXT,
  `technician_remarks` TEXT,
  `resolution_details` TEXT,
  `assigned_at` DATETIME DEFAULT NULL,
  `assigned_by_user_id` VARCHAR(64) DEFAULT NULL,
  `assigned_by_name` VARCHAR(255) DEFAULT NULL,
  `photos_json` LONGTEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_tickets_customer` (`customer_id`),
  INDEX `idx_tickets_status` (`status`),
  INDEX `idx_tickets_technician` (`assigned_technician_id`),
  CONSTRAINT `fk_ticket_customer` FOREIGN KEY (`customer_id`) REFERENCES `solar_customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_service_ticket_history`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_service_ticket_history` (
  `id` VARCHAR(64) PRIMARY KEY,
  `ticket_record_id` VARCHAR(64) NOT NULL,
  `ticket_code` VARCHAR(64) DEFAULT '',
  `action_type` VARCHAR(64) NOT NULL,
  `previous_value` TEXT DEFAULT NULL,
  `new_value` TEXT DEFAULT NULL,
  `remarks` TEXT DEFAULT NULL,
  `actor_user_id` VARCHAR(64) DEFAULT '',
  `actor_name` VARCHAR(255) DEFAULT '',
  `actor_role` VARCHAR(64) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_srv_hist_ticket` (`ticket_record_id`),
  INDEX `idx_srv_hist_created` (`created_at`),
  CONSTRAINT `fk_srv_hist_ticket` FOREIGN KEY (`ticket_record_id`) REFERENCES `solar_service_tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_amc_contracts`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_amc_contracts` (
  `id` VARCHAR(64) PRIMARY KEY,
  `amc_code` VARCHAR(64) NOT NULL UNIQUE,
  `customer_id` VARCHAR(64) NOT NULL,
  `customer_name` VARCHAR(255) NOT NULL,
  `project_id` VARCHAR(64) NOT NULL,
  `project_title` VARCHAR(255) NOT NULL,
  `plan_name` VARCHAR(128) NOT NULL,
  `start_date` DATE NOT NULL,
  `end_date` DATE NOT NULL,
  `renewal_date` DATE DEFAULT NULL,
  `annual_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `visits_completed` INT DEFAULT 0,
  `total_visits` INT DEFAULT 4,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_amc_customer` (`customer_id`),
  INDEX `idx_amc_status` (`status`),
  CONSTRAINT `fk_amc_customer` FOREIGN KEY (`customer_id`) REFERENCES `solar_customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_amc_project` FOREIGN KEY (`project_id`) REFERENCES `solar_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_notifications`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_notifications` (
  `id` VARCHAR(64) PRIMARY KEY,
  `user_id` VARCHAR(64) DEFAULT '',
  `title` VARCHAR(255) NOT NULL,
  `message` TEXT NOT NULL,
  `type` VARCHAR(32) DEFAULT 'INFO',
  `is_read` TINYINT(1) DEFAULT 0,
  `link_type` VARCHAR(32) DEFAULT NULL,
  `link_id` VARCHAR(64) DEFAULT NULL,
  `customer_id` VARCHAR(64) DEFAULT NULL,
  `project_id` VARCHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_notif_read` (`is_read`),
  INDEX `idx_notif_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_products`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_products` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `sku` VARCHAR(64) NOT NULL UNIQUE,
  `category` VARCHAR(64) NOT NULL,
  `brand` VARCHAR(128) DEFAULT '',
  `model` VARCHAR(128) DEFAULT '',
  `specifications` TEXT,
  `unit` VARCHAR(32) DEFAULT 'Nos',
  `hsn_code` VARCHAR(32) DEFAULT '',
  `gst_rate` DECIMAL(5,2) DEFAULT 18.00,
  `unit_price` DECIMAL(12,2) DEFAULT 0.00,
  `selling_price` DECIMAL(12,2) DEFAULT 0.00,
  `current_stock` DECIMAL(12,2) DEFAULT 0.00,
  `reorder_level` DECIMAL(12,2) DEFAULT 0.00,
  `location` VARCHAR(255) DEFAULT '',
  `warehouse_id` VARCHAR(64) DEFAULT '',
  `warehouse_name` VARCHAR(255) DEFAULT '',
  `warehouse_stocks_json` LONGTEXT DEFAULT NULL,
  `preferred_vendor_id` VARCHAR(64) DEFAULT '',
  `preferred_vendor_name` VARCHAR(255) DEFAULT '',
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_products_category` (`category`),
  INDEX `idx_products_sku` (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_vendors`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_vendors` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `vendor_code` VARCHAR(32) NOT NULL UNIQUE,
  `contact_person` VARCHAR(128) DEFAULT '',
  `phone` VARCHAR(32) DEFAULT '',
  `email` VARCHAR(191) DEFAULT '',
  `address` TEXT,
  `city` VARCHAR(128) DEFAULT '',
  `state` VARCHAR(128) DEFAULT '',
  `gst_number` VARCHAR(32) DEFAULT '',
  `pan_number` VARCHAR(32) DEFAULT '',
  `payment_terms` VARCHAR(128) DEFAULT '30 Days',
  `rating` DECIMAL(3,1) DEFAULT 4.5,
  `categories_json` LONGTEXT,
  `bank_details_json` LONGTEXT DEFAULT NULL,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_vendors_code` (`vendor_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_purchase_orders`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_purchase_orders` (
  `id` VARCHAR(64) PRIMARY KEY,
  `po_number` VARCHAR(64) NOT NULL UNIQUE,
  `vendor_id` VARCHAR(64) NOT NULL,
  `vendor_name` VARCHAR(255) NOT NULL,
  `po_date` DATE NOT NULL,
  `expected_delivery_date` DATE DEFAULT NULL,
  `project_id` VARCHAR(64) DEFAULT '',
  `project_title` VARCHAR(255) DEFAULT '',
  `warehouse_id` VARCHAR(64) DEFAULT '',
  `warehouse_name` VARCHAR(255) DEFAULT '',
  `payment_due_date` DATE DEFAULT NULL,
  `invoice_reference` VARCHAR(128) DEFAULT '',
  `stock_updated` TINYINT(1) DEFAULT 0,
  `received_date` DATE DEFAULT NULL,
  `items_json` LONGTEXT NOT NULL,
  `subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `gst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(32) DEFAULT 'ISSUED',
  `payment_status` VARCHAR(32) DEFAULT 'PENDING',
  `receipts_json` LONGTEXT,
  `notes` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_po_vendor` (`vendor_id`),
  INDEX `idx_po_status` (`status`),
  CONSTRAINT `fk_po_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `solar_vendors` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_boms`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_boms` (
  `id` VARCHAR(64) PRIMARY KEY,
  `bom_number` VARCHAR(64) NOT NULL UNIQUE,
  `project_id` VARCHAR(64) NOT NULL,
  `project_code` VARCHAR(64) DEFAULT '',
  `project_title` VARCHAR(255) NOT NULL,
  `customer_name` VARCHAR(255) DEFAULT '',
  `system_capacity_kw` DECIMAL(10,2) NOT NULL,
  `version` VARCHAR(16) DEFAULT '1.0',
  `status` VARCHAR(32) DEFAULT 'APPROVED',
  `warehouse_id` VARCHAR(64) DEFAULT '',
  `warehouse_name` VARCHAR(255) DEFAULT '',
  `stock_allocated` TINYINT(1) DEFAULT 0,
  `eway_bill_number` VARCHAR(64) DEFAULT '',
  `eway_bill_date` VARCHAR(32) DEFAULT '',
  `items_json` LONGTEXT NOT NULL,
  `total_estimated_cost` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_by` VARCHAR(128) DEFAULT '',
  `approved_by` VARCHAR(128) DEFAULT '',
  `approved_at` DATETIME DEFAULT NULL,
  `notes` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_boms_project` (`project_id`),
  CONSTRAINT `fk_bom_project` FOREIGN KEY (`project_id`) REFERENCES `solar_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_sales_invoices`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_sales_invoices` (
  `id` VARCHAR(64) PRIMARY KEY,
  `invoice_number` VARCHAR(64) NOT NULL UNIQUE,
  `invoice_type` VARCHAR(64) DEFAULT 'TAX_INVOICE',
  `project_id` VARCHAR(64) DEFAULT '',
  `project_title` VARCHAR(255) DEFAULT '',
  `customer_id` VARCHAR(64) NOT NULL,
  `customer_name` VARCHAR(255) NOT NULL,
  `customer_gst` VARCHAR(64) DEFAULT '',
  `customer_address` TEXT,
  `invoice_date` DATE NOT NULL,
  `due_date` DATE DEFAULT NULL,
  `payment_terms` VARCHAR(128) DEFAULT '15 Days Net',
  `items_json` LONGTEXT NOT NULL,
  `subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `gst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `payment_status` VARCHAR(32) DEFAULT 'UNPAID',
  `paid_amount` DECIMAL(14,2) DEFAULT 0.00,
  `balance_amount` DECIMAL(14,2) DEFAULT 0.00,
  `cgst_amount` DECIMAL(14,2) DEFAULT 0.00,
  `sgst_amount` DECIMAL(14,2) DEFAULT 0.00,
  `igst_amount` DECIMAL(14,2) DEFAULT 0.00,
  `einvoice_irn` VARCHAR(128) DEFAULT '',
  `einvoice_ack_no` VARCHAR(64) DEFAULT '',
  `einvoice_ack_date` VARCHAR(64) DEFAULT '',
  `einvoice_status` VARCHAR(32) DEFAULT 'NOT_GENERATED',
  `eway_bill_number` VARCHAR(64) DEFAULT '',
  `eway_bill_details_json` LONGTEXT,
  `warehouse_id` VARCHAR(64) DEFAULT '',
  `deduct_stock` TINYINT(1) DEFAULT 1,
  `stock_deducted` TINYINT(1) DEFAULT 0,
  `notes` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_invoices_customer` (`customer_id`),
  INDEX `idx_invoices_status` (`payment_status`),
  CONSTRAINT `fk_sinv_customer` FOREIGN KEY (`customer_id`) REFERENCES `solar_customers` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_warehouses`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_warehouses` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `code` VARCHAR(32) NOT NULL UNIQUE,
  `address` TEXT NOT NULL,
  `city` VARCHAR(128) NOT NULL,
  `state` VARCHAR(128) DEFAULT '',
  `pincode` VARCHAR(16) DEFAULT '',
  `manager_name` VARCHAR(128) DEFAULT '',
  `manager_phone` VARCHAR(32) DEFAULT '',
  `email` VARCHAR(191) DEFAULT '',
  `gst_number` VARCHAR(32) DEFAULT '',
  `capacity_sq_ft` DECIMAL(12,2) DEFAULT 15000.00,
  `is_active` TINYINT(1) DEFAULT 1,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `is_default` TINYINT(1) DEFAULT 0,
  `notes` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_stock_movements`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_stock_movements` (
  `id` VARCHAR(64) PRIMARY KEY,
  `product_id` VARCHAR(64) NOT NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `sku` VARCHAR(64) DEFAULT '',
  `movement_type` VARCHAR(64) NOT NULL,
  `quantity` DECIMAL(12,2) NOT NULL,
  `balance_after` DECIMAL(12,2) NOT NULL,
  `reference_number` VARCHAR(64) DEFAULT '',
  `reference_id` VARCHAR(64) DEFAULT '',
  `warehouse_id` VARCHAR(64) DEFAULT '',
  `warehouse_name` VARCHAR(255) DEFAULT '',
  `target_warehouse_id` VARCHAR(64) DEFAULT '',
  `target_warehouse_name` VARCHAR(255) DEFAULT '',
  `notes` TEXT,
  `timestamp` DATETIME NOT NULL,
  `performed_by` VARCHAR(128) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sm_product` (`product_id`),
  CONSTRAINT `fk_sm_product` FOREIGN KEY (`product_id`) REFERENCES `solar_products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_stock_audits`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_stock_audits` (
  `id` VARCHAR(64) PRIMARY KEY,
  `audit_number` VARCHAR(64) NOT NULL UNIQUE,
  `warehouse_id` VARCHAR(64) NOT NULL,
  `warehouse_name` VARCHAR(255) NOT NULL,
  `audit_date` DATE NOT NULL,
  `auditor_name` VARCHAR(128) NOT NULL,
  `status` VARCHAR(32) DEFAULT 'COMPLETED',
  `items_audited` INT DEFAULT 0,
  `discrepancies_count` INT DEFAULT 0,
  `net_adjustment_value` DECIMAL(14,2) DEFAULT 0.00,
  `items_json` LONGTEXT NOT NULL,
  `notes` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_acl_config`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_acl_config` (
  `id` VARCHAR(64) PRIMARY KEY,
  `config_json` LONGTEXT NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_acl_audit_logs`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_acl_audit_logs` (
  `id` VARCHAR(64) PRIMARY KEY,
  `actor_id` VARCHAR(64) NOT NULL,
  `actor_name` VARCHAR(255) NOT NULL,
  `actor_role` VARCHAR(64) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target_role` VARCHAR(64) DEFAULT '',
  `details` TEXT NOT NULL,
  `timestamp` DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_system_settings`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_system_settings` (
  `setting_key` VARCHAR(64) PRIMARY KEY,
  `setting_value` LONGTEXT NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_workforce_locations`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_workforce_locations` (
  `user_id` VARCHAR(64) PRIMARY KEY,
  `employee_code` VARCHAR(64) DEFAULT '',
  `name` VARCHAR(255) DEFAULT '',
  `email` VARCHAR(191) DEFAULT '',
  `role` VARCHAR(64) DEFAULT '',
  `latitude` DECIMAL(10,7) DEFAULT NULL,
  `longitude` DECIMAL(10,7) DEFAULT NULL,
  `accuracy` DECIMAL(8,2) DEFAULT NULL,
  `heading` DECIMAL(8,2) DEFAULT NULL,
  `speed` DECIMAL(8,2) DEFAULT NULL,
  `battery_level` INT DEFAULT NULL,
  `activity` VARCHAR(128) DEFAULT '',
  `is_online` TINYINT(1) DEFAULT 0,
  `is_sharing_location` TINYINT(1) DEFAULT 0,
  `status` VARCHAR(32) DEFAULT 'offline',
  `last_seen_at` DATETIME DEFAULT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_auth_credentials`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_auth_credentials` (
  `id` VARCHAR(64) PRIMARY KEY,
  `user_id` VARCHAR(64) NOT NULL UNIQUE,
  `email` VARCHAR(191) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(64) NOT NULL,
  `account_type` ENUM('ADMIN', 'EMPLOYEE', 'CUSTOMER') NOT NULL,
  `linked_entity_id` VARCHAR(64) DEFAULT NULL,
  `status` VARCHAR(32) DEFAULT 'ACTIVE',
  `failed_login_attempts` INT DEFAULT 0,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL,
  `password_changed_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_auth_cred_role` (`role`),
  INDEX `idx_auth_cred_type` (`account_type`),
  INDEX `idx_auth_cred_linked` (`linked_entity_id`),
  INDEX `idx_auth_cred_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_auth_sessions`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_auth_sessions` (
  `id` VARCHAR(128) PRIMARY KEY,
  `user_id` VARCHAR(64) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `role` VARCHAR(64) NOT NULL,
  `account_type` VARCHAR(32) NOT NULL,
  `linked_entity_id` VARCHAR(64) DEFAULT NULL,
  `ip_address` VARCHAR(64) DEFAULT NULL,
  `user_agent` TEXT DEFAULT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `last_active_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_auth_sess_user_id` (`user_id`),
  INDEX `idx_auth_sess_expires_at` (`expires_at`),
  CONSTRAINT `fk_auth_sess_user` FOREIGN KEY (`user_id`) REFERENCES `solar_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_email_settings`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_email_settings` (
  `id` VARCHAR(64) PRIMARY KEY,
  `gmail_address` VARCHAR(191) NOT NULL DEFAULT '',
  `smtp_host` VARCHAR(191) NOT NULL DEFAULT 'smtp.gmail.com',
  `smtp_port` INT NOT NULL DEFAULT 587,
  `smtp_security` VARCHAR(16) NOT NULL DEFAULT 'TLS',
  `sender_name` VARCHAR(255) NOT NULL DEFAULT 'Solar Urja ERP',
  `encrypted_app_password` TEXT NOT NULL,
  `iv` VARCHAR(64) NOT NULL,
  `auth_tag` VARCHAR(64) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `last_tested_at` VARCHAR(64) DEFAULT NULL,
  `last_test_status` VARCHAR(32) DEFAULT NULL,
  `last_test_message` TEXT DEFAULT NULL,
  `updated_by` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_vendor_sales_invoices`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_vendor_sales_invoices` (
  `id` VARCHAR(64) PRIMARY KEY,
  `invoice_number` VARCHAR(64) NOT NULL UNIQUE,
  `vendor_id` VARCHAR(64) NOT NULL,
  `vendor_code` VARCHAR(64) DEFAULT '',
  `vendor_name` VARCHAR(255) NOT NULL,
  `vendor_gst` VARCHAR(64) DEFAULT '',
  `vendor_address` TEXT,
  `vendor_city` VARCHAR(128) DEFAULT '',
  `vendor_state` VARCHAR(128) DEFAULT '',
  `vendor_contact_person` VARCHAR(128) DEFAULT '',
  `vendor_phone` VARCHAR(64) DEFAULT '',
  `vendor_email` VARCHAR(191) DEFAULT '',
  `company_state` VARCHAR(128) DEFAULT 'Chhattisgarh',
  `supply_type` VARCHAR(32) NOT NULL DEFAULT 'INTRA_STATE',
  `invoice_date` DATE NOT NULL,
  `due_date` DATE DEFAULT NULL,
  `payment_terms` VARCHAR(128) DEFAULT '30 Days',
  `notes` TEXT,
  `gross_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `discount_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `cgst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `sgst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `igst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `paid_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `balance_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(32) NOT NULL DEFAULT 'ISSUED',
  `created_by` VARCHAR(255) DEFAULT '',
  `updated_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_vsi_vendor` (`vendor_id`),
  INDEX `idx_vsi_status` (`status`),
  INDEX `idx_vsi_date` (`invoice_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_vendor_sales_invoice_items`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_vendor_sales_invoice_items` (
  `id` VARCHAR(64) PRIMARY KEY,
  `invoice_id` VARCHAR(64) NOT NULL,
  `product_id` VARCHAR(64) DEFAULT NULL,
  `line_order` INT NOT NULL DEFAULT 0,
  `description` VARCHAR(500) NOT NULL,
  `hsn_code` VARCHAR(32) DEFAULT '',
  `quantity` DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  `unit` VARCHAR(32) NOT NULL DEFAULT 'NOS',
  `rate` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `discount_type` VARCHAR(16) NOT NULL DEFAULT 'PERCENT',
  `discount_value` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `discount_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `taxable_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `gst_rate` DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  `cgst_rate` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `cgst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `sgst_rate` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `sgst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `igst_rate` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `igst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tax_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_vsii_invoice` (`invoice_id`),
  INDEX `idx_vsii_product` (`product_id`),
  CONSTRAINT `fk_vsii_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `solar_vendor_sales_invoices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table structure for table `solar_vendor_sales_payments`
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_vendor_sales_payments` (
  `id` VARCHAR(64) PRIMARY KEY,
  `invoice_id` VARCHAR(64) NOT NULL,
  `vendor_id` VARCHAR(64) NOT NULL,
  `payment_date` DATE NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `payment_mode` VARCHAR(64) NOT NULL DEFAULT 'Bank NEFT/RTGS',
  `reference_no` VARCHAR(128) DEFAULT '',
  `notes` TEXT,
  `recorded_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_vsip_invoice` (`invoice_id`),
  INDEX `idx_vsip_vendor` (`vendor_id`),
  CONSTRAINT `fk_vsip_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `solar_vendor_sales_invoices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- ACCOUNTING & FINANCE MODULE TABLES (solar_acc_*)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `solar_acc_accounts` (
  `id` VARCHAR(64) PRIMARY KEY,
  `code` VARCHAR(32) NOT NULL UNIQUE,
  `name` VARCHAR(255) NOT NULL,
  `account_type` VARCHAR(32) NOT NULL,
  `sub_type` VARCHAR(64) DEFAULT '',
  `parent_id` VARCHAR(64) DEFAULT NULL,
  `description` TEXT,
  `opening_balance` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `current_balance` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `is_system` TINYINT(1) NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_acc_type` (`account_type`),
  INDEX `idx_acc_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_journal_entries` (
  `id` VARCHAR(64) PRIMARY KEY,
  `entry_number` VARCHAR(64) NOT NULL UNIQUE,
  `entry_date` DATE NOT NULL,
  `reference_type` VARCHAR(64) DEFAULT '',
  `reference_id` VARCHAR(64) DEFAULT '',
  `reference_number` VARCHAR(64) DEFAULT '',
  `narration` TEXT NOT NULL,
  `total_debit` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_credit` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  `reversed_entry_id` VARCHAR(64) DEFAULT NULL,
  `posted_by` VARCHAR(255) DEFAULT '',
  `posted_at` VARCHAR(64) DEFAULT NULL,
  `created_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_je_date` (`entry_date`),
  INDEX `idx_je_status` (`status`),
  INDEX `idx_je_ref` (`reference_type`, `reference_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_journal_lines` (
  `id` VARCHAR(64) PRIMARY KEY,
  `journal_id` VARCHAR(64) NOT NULL,
  `line_order` INT NOT NULL DEFAULT 0,
  `account_id` VARCHAR(64) NOT NULL,
  `account_code` VARCHAR(32) DEFAULT '',
  `account_name` VARCHAR(255) DEFAULT '',
  `description` VARCHAR(500) DEFAULT '',
  `project_id` VARCHAR(64) DEFAULT '',
  `project_title` VARCHAR(255) DEFAULT '',
  `party_type` VARCHAR(32) DEFAULT 'NONE',
  `party_id` VARCHAR(64) DEFAULT '',
  `party_name` VARCHAR(255) DEFAULT '',
  `debit` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `credit` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  INDEX `idx_jl_journal` (`journal_id`),
  INDEX `idx_jl_account` (`account_id`),
  INDEX `idx_jl_project` (`project_id`),
  CONSTRAINT `fk_jl_journal` FOREIGN KEY (`journal_id`) REFERENCES `solar_acc_journal_entries` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_bank_accounts` (
  `id` VARCHAR(64) PRIMARY KEY,
  `account_name` VARCHAR(255) NOT NULL,
  `account_type` VARCHAR(16) NOT NULL DEFAULT 'BANK',
  `bank_name` VARCHAR(255) DEFAULT '',
  `account_number` VARCHAR(64) DEFAULT '',
  `ifsc_code` VARCHAR(32) DEFAULT '',
  `branch` VARCHAR(255) DEFAULT '',
  `coa_account_id` VARCHAR(64) DEFAULT '',
  `opening_balance` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `current_balance` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `is_primary` TINYINT(1) NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_bank_transfers` (
  `id` VARCHAR(64) PRIMARY KEY,
  `transfer_number` VARCHAR(64) NOT NULL UNIQUE,
  `transfer_date` DATE NOT NULL,
  `from_account_id` VARCHAR(64) NOT NULL,
  `to_account_id` VARCHAR(64) NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `mode` VARCHAR(64) DEFAULT 'Bank Transfer',
  `reference_no` VARCHAR(128) DEFAULT '',
  `notes` TEXT,
  `journal_entry_id` VARCHAR(64) DEFAULT '',
  `created_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_bt_date` (`transfer_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_bank_reconciliations` (
  `id` VARCHAR(64) PRIMARY KEY,
  `bank_account_id` VARCHAR(64) NOT NULL,
  `statement_date` DATE NOT NULL,
  `book_balance` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `statement_balance` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `cleared_txn_ids_json` LONGTEXT,
  `difference` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  `notes` TEXT,
  `reconciled_by` VARCHAR(255) DEFAULT '',
  `reconciled_at` VARCHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_br_bank` (`bank_account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_vendor_bills` (
  `id` VARCHAR(64) PRIMARY KEY,
  `bill_number` VARCHAR(64) NOT NULL UNIQUE,
  `vendor_id` VARCHAR(64) NOT NULL,
  `vendor_name` VARCHAR(255) NOT NULL,
  `vendor_gst` VARCHAR(64) DEFAULT '',
  `po_id` VARCHAR(64) DEFAULT '',
  `po_number` VARCHAR(64) DEFAULT '',
  `project_id` VARCHAR(64) DEFAULT '',
  `project_title` VARCHAR(255) DEFAULT '',
  `bill_date` DATE NOT NULL,
  `due_date` DATE DEFAULT NULL,
  `category` VARCHAR(128) DEFAULT 'Material Purchase',
  `subtotal` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `cgst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `sgst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `igst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `gst_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tds_section` VARCHAR(32) DEFAULT '',
  `tds_rate` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `tds_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `total_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `paid_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `balance_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `itc_eligible` TINYINT(1) NOT NULL DEFAULT 1,
  `status` VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  `expense_account_id` VARCHAR(64) DEFAULT '',
  `journal_entry_id` VARCHAR(64) DEFAULT '',
  `notes` TEXT,
  `items_json` LONGTEXT,
  `created_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_vb_vendor` (`vendor_id`),
  INDEX `idx_vb_status` (`status`),
  INDEX `idx_vb_due` (`due_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_vendor_payments` (
  `id` VARCHAR(64) PRIMARY KEY,
  `payment_number` VARCHAR(64) NOT NULL UNIQUE,
  `bill_id` VARCHAR(64) NOT NULL,
  `vendor_id` VARCHAR(64) NOT NULL,
  `vendor_name` VARCHAR(255) NOT NULL,
  `payment_date` DATE NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tds_deducted` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `net_paid` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `bank_account_id` VARCHAR(64) DEFAULT '',
  `payment_mode` VARCHAR(64) DEFAULT 'Bank NEFT/RTGS',
  `reference_no` VARCHAR(128) DEFAULT '',
  `notes` TEXT,
  `journal_entry_id` VARCHAR(64) DEFAULT '',
  `recorded_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_vp_bill` (`bill_id`),
  INDEX `idx_vp_vendor` (`vendor_id`),
  CONSTRAINT `fk_vp_bill` FOREIGN KEY (`bill_id`) REFERENCES `solar_acc_vendor_bills` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_tds_entries` (
  `id` VARCHAR(64) PRIMARY KEY,
  `section` VARCHAR(32) NOT NULL,
  `party_type` VARCHAR(32) DEFAULT 'VENDOR',
  `party_id` VARCHAR(64) DEFAULT '',
  `party_name` VARCHAR(255) NOT NULL,
  `pan_number` VARCHAR(32) DEFAULT '',
  `source_type` VARCHAR(32) NOT NULL,
  `source_id` VARCHAR(64) NOT NULL,
  `source_number` VARCHAR(64) DEFAULT '',
  `deduction_date` DATE NOT NULL,
  `gross_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `tds_rate` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `tds_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(32) NOT NULL DEFAULT 'DEDUCTED',
  `challan_no` VARCHAR(64) DEFAULT '',
  `bsr_code` VARCHAR(32) DEFAULT '',
  `deposit_date` DATE DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_tds_status` (`status`),
  INDEX `idx_tds_date` (`deduction_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_budgets` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `fiscal_year` VARCHAR(32) NOT NULL,
  `period_type` VARCHAR(32) NOT NULL DEFAULT 'ANNUAL',
  `period_label` VARCHAR(64) NOT NULL,
  `department` VARCHAR(128) DEFAULT '',
  `category` VARCHAR(128) DEFAULT '',
  `project_id` VARCHAR(64) DEFAULT '',
  `project_title` VARCHAR(255) DEFAULT '',
  `account_id` VARCHAR(64) DEFAULT '',
  `allocated_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `notes` TEXT,
  `status` VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  `created_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_budget_fy` (`fiscal_year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_fixed_assets` (
  `id` VARCHAR(64) PRIMARY KEY,
  `asset_code` VARCHAR(64) NOT NULL UNIQUE,
  `name` VARCHAR(255) NOT NULL,
  `category` VARCHAR(128) NOT NULL,
  `purchase_date` DATE NOT NULL,
  `vendor_name` VARCHAR(255) DEFAULT '',
  `purchase_cost` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `salvage_value` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `useful_life_years` INT NOT NULL DEFAULT 5,
  `depreciation_method` VARCHAR(16) NOT NULL DEFAULT 'SLM',
  `depreciation_rate` DECIMAL(6,2) NOT NULL DEFAULT 20.00,
  `accumulated_depreciation` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `book_value` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `last_depreciation_date` DATE DEFAULT NULL,
  `asset_account_id` VARCHAR(64) DEFAULT '',
  `dep_expense_account_id` VARCHAR(64) DEFAULT '',
  `location` VARCHAR(255) DEFAULT '',
  `custodian` VARCHAR(255) DEFAULT '',
  `status` VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  `disposal_date` DATE DEFAULT NULL,
  `disposal_proceeds` DECIMAL(14,2) DEFAULT 0.00,
  `disposal_gain_loss` DECIMAL(14,2) DEFAULT 0.00,
  `disposal_journal_id` VARCHAR(64) DEFAULT NULL,
  `purchase_journal_id` VARCHAR(64) DEFAULT NULL,
  `notes` TEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_fa_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_asset_depreciation` (
  `id` VARCHAR(64) PRIMARY KEY,
  `asset_id` VARCHAR(64) NOT NULL,
  `period_label` VARCHAR(64) NOT NULL,
  `run_date` DATE NOT NULL,
  `opening_book_value` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `depreciation_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `closing_book_value` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `journal_entry_id` VARCHAR(64) DEFAULT '',
  `run_by` VARCHAR(255) DEFAULT '',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ad_asset` (`asset_id`),
  CONSTRAINT `fk_ad_asset` FOREIGN KEY (`asset_id`) REFERENCES `solar_acc_fixed_assets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_settings` (
  `id` VARCHAR(64) PRIMARY KEY,
  `fiscal_year_start_month` INT NOT NULL DEFAULT 4,
  `active_fiscal_year` VARCHAR(32) NOT NULL DEFAULT '2026-27',
  `lock_date` DATE DEFAULT NULL,
  `currency` VARCHAR(16) NOT NULL DEFAULT 'INR',
  `approval_threshold` DECIMAL(14,2) NOT NULL DEFAULT 10000.00,
  `require_expense_approval` TINYINT(1) NOT NULL DEFAULT 1,
  `auto_post_erp_vouchers` TINYINT(1) NOT NULL DEFAULT 1,
  `journal_prefix` VARCHAR(16) NOT NULL DEFAULT 'JV-',
  `bill_prefix` VARCHAR(16) NOT NULL DEFAULT 'BILL-',
  `voucher_prefix` VARCHAR(16) NOT NULL DEFAULT 'VOU-',
  `default_cash_account_id` VARCHAR(64) DEFAULT 'acc-1010',
  `default_bank_account_id` VARCHAR(64) DEFAULT 'acc-1020',
  `default_ar_account_id` VARCHAR(64) DEFAULT 'acc-1100',
  `default_ap_account_id` VARCHAR(64) DEFAULT 'acc-2010',
  `default_sales_account_id` VARCHAR(64) DEFAULT 'acc-4010',
  `default_cogs_account_id` VARCHAR(64) DEFAULT 'acc-5010',
  `default_output_gst_account_id` VARCHAR(64) DEFAULT 'acc-2100',
  `default_input_gst_account_id` VARCHAR(64) DEFAULT 'acc-1150',
  `default_tds_account_id` VARCHAR(64) DEFAULT 'acc-2150',
  `default_payroll_account_id` VARCHAR(64) DEFAULT 'acc-5030',
  `default_dep_expense_account_id` VARCHAR(64) DEFAULT 'acc-5060',
  `default_disposal_gain_loss_account_id` VARCHAR(64) DEFAULT 'acc-4090',
  `updated_by` VARCHAR(255) DEFAULT '',
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_acc_audit_logs` (
  `id` VARCHAR(64) PRIMARY KEY,
  `actor_id` VARCHAR(64) NOT NULL,
  `actor_name` VARCHAR(255) NOT NULL,
  `actor_role` VARCHAR(64) NOT NULL,
  `module` VARCHAR(64) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `entity_id` VARCHAR(64) DEFAULT '',
  `entity_ref` VARCHAR(128) DEFAULT '',
  `summary` TEXT NOT NULL,
  `details_json` LONGTEXT,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_acc_audit_module` (`module`),
  INDEX `idx_acc_audit_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==========================================================
-- SYSTEM CONFIGURATION BASELINE (NON-DESTRUCTIVE ON EXISTING ROWS)
-- Initial admin accounts must be provisioned explicitly via /api/auth/register
-- or User Management — never auto-seeded into solar_users on schema checks.
-- ==========================================================

-- Initial ACL config (inserted only if missing)
INSERT IGNORE INTO `solar_acl_config` (`id`, `config_json`)
VALUES ('master_acl_config', '{"Admin":{"crm.leads.view":true,"crm.leads.manage":true,"crm.quotations.create":true,"crm.quotations.approve":true,"projects.view":true,"projects.create":true,"projects.edit_specs":true,"projects.assign_team":true,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":true,"survey.view":true,"survey.submit":true,"survey.approve":true,"inventory.view":true,"inventory.manage":true,"inventory.bom_edit":true,"inventory.purchase_orders":true,"inventory.warehouses_manage":true,"finance.view":true,"finance.invoices":true,"finance.receipts":true,"finance.tally_sync":true,"finance.audit":true,"hrms.view":true,"hrms.attendance_punch":true,"hrms.manage":true,"hrms.payroll":true,"service.tickets_view":true,"service.tickets_create":true,"service.tickets_resolve":true,"service.amc_manage":true,"reports.view":true,"reports.export":true,"settings.view":true,"settings.manage":true,"settings.acl_manage":true},"Project Manager":{"crm.leads.view":true,"crm.leads.manage":false,"crm.quotations.create":true,"crm.quotations.approve":false,"projects.view":true,"projects.create":true,"projects.edit_specs":true,"projects.assign_team":true,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":true,"survey.view":true,"survey.submit":false,"survey.approve":true,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":true,"inventory.purchase_orders":true,"inventory.warehouses_manage":false,"finance.view":true,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":true,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":true,"service.tickets_create":true,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":true,"reports.export":true,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Site Survey Engineer":{"crm.leads.view":true,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":false,"survey.view":true,"survey.submit":true,"survey.approve":false,"inventory.view":false,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Site Inspector":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":false,"survey.view":true,"survey.submit":true,"survey.approve":false,"inventory.view":false,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":true,"service.tickets_create":false,"service.tickets_resolve":true,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Sales Manager":{"crm.leads.view":true,"crm.leads.manage":true,"crm.quotations.create":true,"crm.quotations.approve":true,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":false,"projects.stage_photos":false,"projects.stage_approve":false,"survey.view":true,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":true,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":true,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":true,"reports.export":true,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Sales Executive":{"crm.leads.view":true,"crm.leads.manage":true,"crm.quotations.create":true,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":false,"projects.stage_photos":false,"projects.stage_approve":false,"survey.view":true,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Civil Team":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Structure Team":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Installation Team":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Electrical Team":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Technician":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":true,"projects.stage_photos":true,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":true,"service.tickets_create":false,"service.tickets_resolve":true,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Service Manager":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":false,"projects.stage_photos":false,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":true,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":true,"service.tickets_create":true,"service.tickets_resolve":true,"service.amc_manage":true,"reports.view":true,"reports.export":true,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Accountant":{"crm.leads.view":true,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":false,"projects.stage_photos":false,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":true,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":true,"inventory.warehouses_manage":false,"finance.view":true,"finance.invoices":true,"finance.receipts":true,"finance.tally_sync":true,"finance.audit":true,"hrms.view":true,"hrms.attendance_punch":true,"hrms.manage":false,"hrms.payroll":true,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":true,"reports.export":true,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"HR Manager":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":false,"projects.stage_photos":false,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":false,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":false,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":true,"hrms.attendance_punch":true,"hrms.manage":true,"hrms.payroll":true,"service.tickets_view":false,"service.tickets_create":false,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":true,"reports.export":true,"settings.view":true,"settings.manage":false,"settings.acl_manage":false},"Customer":{"crm.leads.view":false,"crm.leads.manage":false,"crm.quotations.create":false,"crm.quotations.approve":false,"projects.view":true,"projects.create":false,"projects.edit_specs":false,"projects.assign_team":false,"projects.stage_checklist":false,"projects.stage_photos":false,"projects.stage_approve":false,"survey.view":false,"survey.submit":false,"survey.approve":false,"inventory.view":false,"inventory.manage":false,"inventory.bom_edit":false,"inventory.purchase_orders":false,"inventory.warehouses_manage":false,"finance.view":true,"finance.invoices":false,"finance.receipts":false,"finance.tally_sync":false,"finance.audit":false,"hrms.view":false,"hrms.attendance_punch":false,"hrms.manage":false,"hrms.payroll":false,"service.tickets_view":true,"service.tickets_create":true,"service.tickets_resolve":false,"service.amc_manage":false,"reports.view":false,"reports.export":false,"settings.view":false,"settings.manage":false,"settings.acl_manage":false}}');

-- Initial system settings (inserted only if missing)
INSERT IGNORE INTO `solar_system_settings` (`setting_key`, `setting_value`)
VALUES ('global_settings', '{"companyName":"SOLAR URJA ERP","companyAddress":"PLOT NO- 14, STREET NO- 14B, PRAGATI NAGAR, RISALI BHILAI, Chhattisgarh 490006","companyPhone":"+91 98250 12345","companyEmail":"support@solar.klyiatechnology.com","companyGst":"22AAOCR0748K1Z5","logoUrl":"/assets/aistudio/solar_urja_logo_07b84efe.jpeg","currencySymbol":"₹","taxRatePercent":18,"tallyServerUrl":"","tallyCompany":"Solar Urja 2026-27","tallyStatus":"NOT CONFIGURED","whatsAppStatus":"SANDBOX_READY"}');

INSERT IGNORE INTO `solar_schema_migrations` (`version`, `description`)
VALUES ('2026_11_26_production_schema_fk_and_audit', 'Production baseline schema with relational foreign keys and audit logging');

SET FOREIGN_KEY_CHECKS = 1;

-- ==========================================================
-- End of Solar Urja ERP Production MySQL Schema
-- ==========================================================