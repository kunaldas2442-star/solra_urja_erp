-- ==========================================================
-- Solar Urja ERP - Idempotent Auth Schema & Password Policy Migration
-- Ensures must_change_password tracking and centralized auth tables exist
-- without modifying or deleting existing user accounts or business records.
-- ==========================================================

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `solar_schema_migrations` (
  `version` VARCHAR(128) PRIMARY KEY,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `solar_users` (
  `id` VARCHAR(64) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(191) NOT NULL UNIQUE,
  `password` VARCHAR(255) NOT NULL DEFAULT '',
  `role` VARCHAR(64) NOT NULL DEFAULT 'Admin',
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

INSERT IGNORE INTO `solar_schema_migrations` (`version`, `description`)
VALUES ('2026_11_27_sync_default_auth_accounts', 'Idempotent auth tables and must_change_password schema migration');

SET FOREIGN_KEY_CHECKS = 1;
