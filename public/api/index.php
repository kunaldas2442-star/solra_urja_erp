<?php
/**
 * Hostinger Apache/LiteSpeed Native PHP API Gateway for Rejoy Solar ERP
 * Handles all production /api/* requests with direct MySQL database persistence,
 * complete CRUD operations across all 26 ERP & CRM modules, bcrypt password hashing,
 * privilege escalation checks, and strict JSON error responses.
 */

// 1. Prevent raw PHP error dumps from corrupting JSON payloads
ini_set('display_errors', '0');
error_reporting(E_ALL);

// PHP < 8.0 compatibility polyfills (prevents HTTP 500 on PHP 7.4 Hostinger environments)
if (!function_exists('str_starts_with')) {
    function str_starts_with($haystack, $needle) {
        $haystack = (string)$haystack;
        $needle = (string)$needle;
        return $needle === '' || strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_contains')) {
    function str_contains($haystack, $needle) {
        $haystack = (string)$haystack;
        $needle = (string)$needle;
        return $needle === '' || strpos($haystack, $needle) !== false;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with($haystack, $needle) {
        $haystack = (string)$haystack;
        $needle = (string)$needle;
        if ($needle === '') return true;
        $len = strlen($needle);
        return strlen($haystack) >= $len && substr($haystack, -$len) === $needle;
    }
}

// Helper: HTTPS detection for Hostinger / LiteSpeed / Cloudflare / Reverse Proxies
function isRequestHttps() {
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') return true;
    $xfProto = strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
    if (strpos($xfProto, 'https') !== false) return true;
    if (strtolower((string)($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '')) === 'on') return true;
    if (strtolower((string)($_SERVER['HTTP_X_FORWARDED_SCHEME'] ?? '')) === 'https') return true;
    $reqScheme = strtolower((string)($_SERVER['HTTP_REQUEST_SCHEME'] ?? $_SERVER['REQUEST_SCHEME'] ?? ''));
    if ($reqScheme === 'https') return true;
    $cfVisitor = strtolower((string)($_SERVER['HTTP_CF_VISITOR'] ?? ''));
    if (strpos($cfVisitor, '"https"') !== false) return true;
    if (isset($_SERVER['SERVER_PORT']) && intval($_SERVER['SERVER_PORT']) === 443) return true;
    $origin = strtolower((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if (strpos($origin, 'https://') === 0) return true;
    $referer = strtolower((string)($_SERVER['HTTP_REFERER'] ?? ''));
    if (strpos($referer, 'https://') === 0) return true;
    return false;
}

// 2. Strict JSON Response & Dynamic CORS Headers (Enables HttpOnly Cookies & Credentialed Sessions)
header('Content-Type: application/json; charset=UTF-8');
header('X-Content-Type-Options: nosniff');

$reqOrigin = str_replace(["\r", "\n"], '', (string)($_SERVER['HTTP_ORIGIN'] ?? ''));
if (!empty($reqOrigin)) {
    header("Access-Control-Allow-Origin: {$reqOrigin}");
    header('Access-Control-Allow-Credentials: true');
} else {
    $serverHost = str_replace(["\r", "\n"], '', (string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $proto = isRequestHttps() ? 'https' : 'http';
    header("Access-Control-Allow-Origin: {$proto}://{$serverHost}");
    header('Access-Control-Allow-Credentials: true');
}

header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, x-auth-token, x-session-token, x-admin-token, x-admin-key');
header('Access-Control-Expose-Headers: Set-Cookie');
header('Vary: Origin, Cookie, Authorization');
header('Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0');
header('Pragma: no-cache');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// 3. Global Exception Handler (Guarantees strict JSON, never HTML 500, never leaks SQL details)
set_exception_handler(function ($e) {
    error_log('Unhandled API Gateway Exception: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'Internal server error while processing API request: ' . $e->getMessage()
    ]);
    exit;
});

// 4. Parse Environment Variables from .env file
function loadEnvConfig() {
    $searchPaths = [
        isset($_SERVER['DOCUMENT_ROOT']) ? $_SERVER['DOCUMENT_ROOT'] . '/.env' : null,
        dirname(__DIR__, 2) . '/.env',
        dirname(__DIR__) . '/.env',
        __DIR__ . '/.env'
    ];

    $env = [];
    foreach ($searchPaths as $path) {
        if ($path && file_exists($path) && is_readable($path)) {
            $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if ($lines !== false) {
                foreach ($lines as $line) {
                    $trimmed = trim($line);
                    if (empty($trimmed) || $trimmed[0] === '#') continue;
                    $pos = strpos($trimmed, '=');
                    if ($pos !== false) {
                        $key = trim(substr($trimmed, 0, $pos));
                        $val = trim(substr($trimmed, $pos + 1));
                        $len = strlen($val);
                        if ($len >= 2) {
                            if (($val[0] === '"' && $val[$len - 1] === '"') ||
                                ($val[0] === "'" && $val[$len - 1] === "'")) {
                                $val = substr($val, 1, -1);
                            }
                        }
                        $env[$key] = $val;
                    }
                }
                break;
            }
        }
    }

    return [
        'host' => getenv('DB_HOST') ?: ($env['DB_HOST'] ?? '127.0.0.1'),
        'port' => (int)(getenv('DB_PORT') ?: ($env['DB_PORT'] ?? 3306)),
        'user' => getenv('DB_USER') ?: ($env['DB_USER'] ?? ''),
        'pass' => getenv('DB_PASS') ?: ($env['DB_PASS'] ?? (getenv('DB_PASSWORD') ?: ($env['DB_PASSWORD'] ?? ''))),
        'name' => getenv('DB_NAME') ?: ($env['DB_NAME'] ?? ''),
        'emailEncryptionKey' => getenv('EMAIL_ENCRYPTION_KEY') ?: ($env['EMAIL_ENCRYPTION_KEY'] ?? ''),
        'sessionSecret' => getenv('SESSION_SECRET') ?: ($env['SESSION_SECRET'] ?? '')
    ];
}

$dbConfig = loadEnvConfig();

// 5. Database Connection with TCP/Socket Fallback and Strict Timeout
function getDbConnection($config) {
    if (empty($config['user']) || empty($config['name'])) {
        error_log("Database configuration missing DB_USER or DB_NAME in environment.");
        http_response_code(503);
        echo json_encode([
            'success' => false,
            'error' => 'Database credentials not configured in server environment (.env).',
            'allowPublicRegistration' => false
        ]);
        exit;
    }

    $hosts = [$config['host']];
    if ($config['host'] === '127.0.0.1') {
        $hosts[] = 'localhost';
    } elseif ($config['host'] === 'localhost') {
        $hosts[] = '127.0.0.1';
    }

    $lastError = '';
    foreach ($hosts as $host) {
        try {
            $dsn = "mysql:host={$host};port={$config['port']};dbname={$config['name']};charset=utf8mb4";
            $options = [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_TIMEOUT => 4
            ];
            if (defined('PDO::MYSQL_ATTR_MULTI_STATEMENTS')) {
                $options[PDO::MYSQL_ATTR_MULTI_STATEMENTS] = true;
            }
            if (defined('PDO::MYSQL_ATTR_INIT_COMMAND')) {
                $options[PDO::MYSQL_ATTR_INIT_COMMAND] = "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci";
            }
            $pdo = new PDO($dsn, $config['user'], $config['pass'], $options);
            try {
                $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
            } catch (Exception $e) {}
            return $pdo;
        } catch (PDOException $e) {
            $lastError = $e->getMessage();
        }
    }

    error_log("Database connection failed on host(s) " . implode(',', $hosts) . ": $lastError");
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'error' => 'Database connection failed. Please verify MySQL service and credentials in .env.',
        'allowPublicRegistration' => false
    ]);
    exit;
}

// 6. Ensure Core Database Tables Exist (Auto-Provisioning / Self-Healing)
function ensureRequiredTables($pdo) {
    static $tablesVerified = false;
    if ($tablesVerified) return;

    $schemaFiles = [
        __DIR__ . '/schema.sql',
        __DIR__ . '/solar_mysql_dump.sql'
    ];
    foreach ($schemaFiles as $file) {
        if (file_exists($file) && is_readable($file)) {
            try {
                $sql = file_get_contents($file);
                if (!empty($sql)) {
                    $pdo->exec($sql);
                    break;
                }
            } catch (Exception $e) {
                error_log('Notice during schema import check: ' . $e->getMessage());
            }
        }
    }

    // Auto-migrate missing columns on solar_attendance
    try {
        $cols = $pdo->query("SHOW COLUMNS FROM `solar_attendance` LIKE 'fuel_expense_json'")->fetchAll();
        if (empty($cols)) {
            $pdo->exec("ALTER TABLE `solar_attendance` ADD COLUMN `fuel_expense_json` LONGTEXT DEFAULT NULL");
        }
    } catch (Exception $e) {}

    // Auto-migrate missing columns on solar_payslips
    try {
        $neededCols = [
            'additional_expenses_json' => 'LONGTEXT DEFAULT NULL',
            'deductions_json' => 'LONGTEXT DEFAULT NULL',
            'overtime_hours' => 'DECIMAL(6,2) DEFAULT 0.00',
            'overtime_rate' => 'DECIMAL(10,2) DEFAULT 0.00',
            'payment_mode' => "VARCHAR(64) DEFAULT 'NEFT/RTGS Bank Transfer'",
            'bank_reference_no' => "VARCHAR(128) DEFAULT ''"
        ];
        foreach ($neededCols as $c => $def) {
            $check = $pdo->query("SHOW COLUMNS FROM `solar_payslips` LIKE '$c'")->fetchAll();
            if (empty($check)) {
                $pdo->exec("ALTER TABLE `solar_payslips` ADD COLUMN `$c` $def");
            }
        }
    } catch (Exception $e) {}

    // Auto-migrate extended columns on Sales & Purchase ERP tables
    $spMigrations = [
        'solar_products' => [
            'gst_rate' => 'DECIMAL(5,2) DEFAULT 18.00',
            'selling_price' => 'DECIMAL(12,2) DEFAULT 0.00',
            'location' => "VARCHAR(255) DEFAULT ''",
            'warehouse_name' => "VARCHAR(255) DEFAULT ''",
            'warehouse_stocks_json' => 'LONGTEXT DEFAULT NULL',
            'preferred_vendor_id' => "VARCHAR(64) DEFAULT ''",
            'preferred_vendor_name' => "VARCHAR(255) DEFAULT ''",
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ],
        'solar_vendors' => [
            'bank_details_json' => 'LONGTEXT DEFAULT NULL',
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ],
        'solar_purchase_orders' => [
            'project_title' => "VARCHAR(255) DEFAULT ''",
            'warehouse_id' => "VARCHAR(64) DEFAULT ''",
            'warehouse_name' => "VARCHAR(255) DEFAULT ''",
            'payment_due_date' => 'DATE DEFAULT NULL',
            'invoice_reference' => "VARCHAR(128) DEFAULT ''",
            'stock_updated' => 'TINYINT(1) DEFAULT 0',
            'received_date' => 'DATE DEFAULT NULL',
            'paid_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'returned_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'refunded_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'balance_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'bank_account_id' => "VARCHAR(64) DEFAULT ''",
            'vendor_bills_json' => 'LONGTEXT DEFAULT NULL',
            'vendor_bill_url' => 'TEXT DEFAULT NULL',
            'vendor_bill_name' => "VARCHAR(255) DEFAULT ''",
            'vendor_bill_mime' => "VARCHAR(128) DEFAULT ''",
            'vendor_bill_size' => 'BIGINT DEFAULT 0',
            'vendor_bill_uploaded_at' => "VARCHAR(64) DEFAULT ''",
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ],
        'solar_boms' => [
            'project_code' => "VARCHAR(64) DEFAULT ''",
            'customer_name' => "VARCHAR(255) DEFAULT ''",
            'warehouse_id' => "VARCHAR(64) DEFAULT ''",
            'warehouse_name' => "VARCHAR(255) DEFAULT ''",
            'stock_allocated' => 'TINYINT(1) DEFAULT 0',
            'eway_bill_number' => "VARCHAR(64) DEFAULT ''",
            'eway_bill_date' => "VARCHAR(32) DEFAULT ''",
            'approved_at' => 'DATETIME DEFAULT NULL',
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ],
        'solar_payments' => [
            'invoice_id' => "VARCHAR(64) DEFAULT ''",
            'invoice_number' => "VARCHAR(64) DEFAULT ''",
            'bank_account_id' => "VARCHAR(64) DEFAULT ''",
            'journal_entry_id' => "VARCHAR(64) DEFAULT ''"
        ],
        'solar_expenses' => [
            'expense_type' => "VARCHAR(32) DEFAULT 'DIRECT_EXPENSE'",
            'status' => "VARCHAR(32) DEFAULT 'PAID'",
            'employee_id' => "VARCHAR(64) DEFAULT ''",
            'employee_name' => "VARCHAR(255) DEFAULT ''",
            'gst_amount' => "DECIMAL(14,2) DEFAULT 0.00",
            'itc_eligible' => "TINYINT(1) DEFAULT 0",
            'bank_account_id' => "VARCHAR(64) DEFAULT ''",
            'expense_account_id' => "VARCHAR(64) DEFAULT ''",
            'journal_entry_id' => "VARCHAR(64) DEFAULT ''",
            'approved_at' => "VARCHAR(64) DEFAULT NULL",
            'rejection_reason' => "TEXT",
            'paid_at' => "VARCHAR(64) DEFAULT NULL",
            'paid_by' => "VARCHAR(255) DEFAULT ''"
        ],
        'solar_sales_invoices' => [
            'invoice_type' => "VARCHAR(64) DEFAULT 'TAX_INVOICE'",
            'customer_gst' => "VARCHAR(64) DEFAULT ''",
            'customer_address' => 'TEXT',
            'project_title' => "VARCHAR(255) DEFAULT ''",
            'payment_terms' => "VARCHAR(128) DEFAULT '15 Days Net'",
            'deduct_stock' => 'TINYINT(1) DEFAULT 1',
            'stock_deducted' => 'TINYINT(1) DEFAULT 0',
            'cgst_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'sgst_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'igst_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'einvoice_irn' => "VARCHAR(128) DEFAULT ''",
            'einvoice_ack_no' => "VARCHAR(64) DEFAULT ''",
            'einvoice_ack_date' => "VARCHAR(64) DEFAULT ''",
            'einvoice_status' => "VARCHAR(32) DEFAULT 'NOT_GENERATED'",
            'returned_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'refunded_amount' => 'DECIMAL(14,2) DEFAULT 0.00',
            'bank_account_id' => "VARCHAR(64) DEFAULT ''",
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ],
        'solar_vendor_sales_invoices' => [
            'returned_amount' => 'DECIMAL(14,2) NOT NULL DEFAULT 0.00',
            'refunded_amount' => 'DECIMAL(14,2) NOT NULL DEFAULT 0.00',
            'bank_account_id' => "VARCHAR(64) DEFAULT ''"
        ],
        'solar_vendor_sales_payments' => [
            'bank_account_id' => "VARCHAR(64) DEFAULT ''",
            'journal_entry_id' => "VARCHAR(64) DEFAULT ''"
        ],
        'solar_acc_vendor_bills' => [
            'returned_amount' => 'DECIMAL(14,2) NOT NULL DEFAULT 0.00',
            'refunded_amount' => 'DECIMAL(14,2) NOT NULL DEFAULT 0.00'
        ],
        'solar_warehouses' => [
            'email' => "VARCHAR(191) DEFAULT ''",
            'capacity_sq_ft' => 'DECIMAL(12,2) DEFAULT 15000.00',
            'status' => "VARCHAR(32) DEFAULT 'ACTIVE'",
            'is_default' => 'TINYINT(1) DEFAULT 0',
            'notes' => 'TEXT',
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ],
        'solar_stock_movements' => [
            'warehouse_name' => "VARCHAR(255) DEFAULT ''",
            'target_warehouse_id' => "VARCHAR(64) DEFAULT ''",
            'target_warehouse_name' => "VARCHAR(255) DEFAULT ''",
            'reference_id' => "VARCHAR(64) DEFAULT ''"
        ],
        'solar_stock_audits' => [
            'items_audited' => 'INT DEFAULT 0',
            'net_adjustment_value' => 'DECIMAL(14,2) DEFAULT 0.00'
        ],
        'solar_projects' => [
            'received_inflow' => 'DECIMAL(18,2) DEFAULT NULL'
        ]
    ];
    foreach ($spMigrations as $tbl => $colsMap) {
        try {
            $colsRes = $pdo->query("SHOW COLUMNS FROM `$tbl`")->fetchAll(PDO::FETCH_ASSOC);
            $existingCols = [];
            foreach ($colsRes as $cr) {
                $existingCols[strtolower($cr['Field'])] = true;
            }
            foreach ($colsMap as $colName => $colDef) {
                if (!isset($existingCols[strtolower($colName)])) {
                    try { $pdo->exec("ALTER TABLE `$tbl` ADD COLUMN `$colName` $colDef"); } catch (Exception $e) {}
                }
            }
        } catch (Exception $e) {}
    }

    // Safely widen currency columns to DECIMAL(18,2) so large contract values / inflows never hit 14,2 caps
    $widenMigrations = [
        ['solar_projects', 'total_value', 'DECIMAL(18,2) NOT NULL DEFAULT 0.00'],
        ['solar_projects', 'received_inflow', 'DECIMAL(18,2) DEFAULT NULL'],
        ['solar_payments', 'amount', 'DECIMAL(18,2) NOT NULL DEFAULT 0.00']
    ];
    foreach ($widenMigrations as $wm) {
        try {
            $colRows = $pdo->query("SHOW COLUMNS FROM `{$wm[0]}` LIKE '{$wm[1]}'")->fetchAll(PDO::FETCH_ASSOC);
            $currentType = strtolower((string)($colRows[0]['Type'] ?? ''));
            if ($currentType !== '' && strpos($currentType, '(18,') === false) {
                $pdo->exec("ALTER TABLE `{$wm[0]}` MODIFY COLUMN `{$wm[1]}` {$wm[2]}");
            }
        } catch (Exception $e) {}
    }

    // Ensure persistent solar_employee_documents table & columns exist
    try {
        $pdo->exec("
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
              INDEX `idx_emp_docs_cat` (`category`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ");
        $docColsRes = $pdo->query("SHOW COLUMNS FROM `solar_employee_documents`")->fetchAll(PDO::FETCH_ASSOC);
        $existingDocCols = [];
        foreach ($docColsRes as $cr) {
            $existingDocCols[strtolower($cr['Field'])] = true;
        }
        $docMigrations = [
            'category' => "VARCHAR(64) NOT NULL DEFAULT 'Other'",
            'name' => "VARCHAR(255) NOT NULL DEFAULT ''",
            'file_name' => "VARCHAR(255) NOT NULL DEFAULT ''",
            'file_path' => "VARCHAR(500) NOT NULL DEFAULT ''",
            'file_url' => "VARCHAR(500) NOT NULL DEFAULT ''",
            'mime_type' => "VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream'",
            'file_size' => 'BIGINT DEFAULT 0',
            'uploaded_at' => 'DATETIME DEFAULT CURRENT_TIMESTAMP',
            'uploaded_by' => "VARCHAR(255) DEFAULT 'HR Administrator'",
            'notes' => 'TEXT'
        ];
        foreach ($docMigrations as $colName => $colDef) {
            if (!isset($existingDocCols[strtolower($colName)])) {
                try { $pdo->exec("ALTER TABLE `solar_employee_documents` ADD COLUMN `$colName` $colDef"); } catch (Exception $e) {}
            }
        }
    } catch (Exception $e) {}

    // Auto-migrate missing columns on solar_employee / solar_employees BEFORE refreshing view
    try {
        $empMigrations = [
            'employee_code' => "VARCHAR(32) NOT NULL DEFAULT ''",
            'name' => "VARCHAR(255) NOT NULL DEFAULT ''",
            'photo_url' => 'TEXT DEFAULT NULL',
            'documents_json' => 'LONGTEXT DEFAULT NULL',
            'department' => "VARCHAR(64) NOT NULL DEFAULT 'Operations'",
            'designation' => "VARCHAR(128) NOT NULL DEFAULT 'Solar Engineer'",
            'phone' => "VARCHAR(32) NOT NULL DEFAULT ''",
            'email' => "VARCHAR(191) NOT NULL DEFAULT ''",
            'joining_date' => 'DATE DEFAULT NULL',
            'salary_monthly' => 'DECIMAL(12,2) NOT NULL DEFAULT 0.00',
            'esic_number' => "VARCHAR(64) DEFAULT ''",
            'bank_account_number' => "VARCHAR(64) DEFAULT ''",
            'bank_name' => "VARCHAR(128) DEFAULT ''",
            'ifsc_code' => "VARCHAR(32) DEFAULT ''",
            'emergency_contact_person' => "VARCHAR(128) DEFAULT ''",
            'emergency_contact_number' => "VARCHAR(32) DEFAULT ''",
            'status' => "VARCHAR(32) DEFAULT 'ACTIVE'",
            'current_site_location' => "VARCHAR(255) DEFAULT ''",
            'login_enabled' => 'TINYINT(1) DEFAULT 1',
            'auth_uid' => 'VARCHAR(64) DEFAULT NULL',
            'system_role' => "VARCHAR(64) DEFAULT 'Site Survey Engineer'",
            'assigned_role' => 'VARCHAR(64) DEFAULT NULL',
            'is_field_worker' => 'TINYINT(1) DEFAULT 0',
            'account_status' => "VARCHAR(32) DEFAULT 'ACTIVE'",
            'account_created_at' => 'VARCHAR(64) DEFAULT NULL',
            'account_created_by' => 'VARCHAR(255) DEFAULT NULL',
            'created_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ];
        $empTablesToMigrate = [];
        $hasEmployeeBase = false;
        $isEmployeesView = false;
        try {
            $t1 = $pdo->query("SHOW FULL TABLES LIKE 'solar_employee'")->fetchAll(PDO::FETCH_NUM);
            if (!empty($t1)) {
                $hasEmployeeBase = true;
                if (strtoupper((string)($t1[0][1] ?? '')) === 'BASE TABLE') {
                    $empTablesToMigrate[] = 'solar_employee';
                }
            }
        } catch (Exception $e) {}
        try {
            $t2 = $pdo->query("SHOW FULL TABLES LIKE 'solar_employees'")->fetchAll(PDO::FETCH_NUM);
            if (!empty($t2)) {
                $t2Type = strtoupper((string)($t2[0][1] ?? ''));
                if ($t2Type === 'VIEW') {
                    $isEmployeesView = true;
                } else {
                    $empTablesToMigrate[] = 'solar_employees';
                }
            }
        } catch (Exception $e) {}

        foreach ($empTablesToMigrate as $empTbl) {
            try {
                $colsRes = $pdo->query("SHOW COLUMNS FROM `$empTbl`")->fetchAll(PDO::FETCH_ASSOC);
                $existingCols = [];
                foreach ($colsRes as $cr) {
                    $existingCols[strtolower($cr['Field'])] = true;
                }
                foreach ($empMigrations as $colName => $colDef) {
                    if (!isset($existingCols[strtolower($colName)])) {
                        $pdo->exec("ALTER TABLE `$empTbl` ADD COLUMN `$colName` $colDef");
                        $existingCols[strtolower($colName)] = true;
                    }
                }
                if (isset($existingCols['salary']) && isset($existingCols['salary_monthly'])) {
                    try {
                        $pdo->exec("UPDATE `$empTbl` SET `salary_monthly` = COALESCE(`salary`, 0.00) WHERE (`salary_monthly` IS NULL OR `salary_monthly` = 0) AND `salary` IS NOT NULL AND `salary` > 0");
                    } catch (Exception $e) {}
                }
                try { $pdo->exec("ALTER TABLE `$empTbl` MODIFY COLUMN `joining_date` DATE DEFAULT NULL"); } catch (Exception $e) {}
            } catch (Exception $e) {
                error_log("Notice migrating employee columns on $empTbl: " . $e->getMessage());
            }
        }

        if ($hasEmployeeBase && $isEmployeesView) {
            try {
                $pdo->exec("CREATE OR REPLACE SQL SECURITY INVOKER VIEW `solar_employees` AS SELECT * FROM `solar_employee`");
            } catch (Exception $e) {
                try { $pdo->exec("CREATE OR REPLACE VIEW `solar_employees` AS SELECT * FROM `solar_employee`"); } catch (Exception $e2) {}
            }
        }
    } catch (Exception $e) {}

    // Auto-migrate missing columns on solar_users (avatar, photo_url, is_field_worker)
    try {
        $uColsRes = $pdo->query("SHOW COLUMNS FROM `solar_users`")->fetchAll(PDO::FETCH_ASSOC);
        $uExistingCols = [];
        foreach ($uColsRes as $cr) {
            $uExistingCols[strtolower($cr['Field'])] = true;
        }
        $userMigrations = [
            'avatar' => 'TEXT DEFAULT NULL',
            'photo_url' => 'TEXT DEFAULT NULL',
            'is_field_worker' => 'TINYINT(1) DEFAULT 0',
            'must_change_password' => 'TINYINT(1) NOT NULL DEFAULT 0'
        ];
        foreach ($userMigrations as $colName => $colDef) {
            if (!isset($uExistingCols[strtolower($colName)])) {
                try { $pdo->exec("ALTER TABLE `solar_users` ADD COLUMN `$colName` $colDef"); } catch (Exception $e) {}
            }
        }
    } catch (Exception $e) {}

    // Auto-create centralized authentication tables (solar_auth_credentials & solar_auth_sessions)
    try {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS `solar_auth_credentials` (
              `id` VARCHAR(64) PRIMARY KEY,
              `user_id` VARCHAR(64) NOT NULL UNIQUE,
              `email` VARCHAR(191) NOT NULL UNIQUE,
              `password_hash` VARCHAR(255) NOT NULL,
              `role` VARCHAR(64) NOT NULL,
              `account_type` ENUM('ADMIN', 'EMPLOYEE', 'CUSTOMER') NOT NULL,
              `linked_entity_id` VARCHAR(64) DEFAULT NULL,
              `status` VARCHAR(32) DEFAULT 'ACTIVE',
              `must_change_password` TINYINT(1) NOT NULL DEFAULT 0,
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
        ");

        try {
            $credColsRes = $pdo->query("SHOW COLUMNS FROM `solar_auth_credentials`")->fetchAll(PDO::FETCH_ASSOC);
            $hasMustChange = false;
            foreach ($credColsRes as $ccr) {
                if (strtolower($ccr['Field']) === 'must_change_password') {
                    $hasMustChange = true;
                    break;
                }
            }
            if (!$hasMustChange) {
                $pdo->exec("ALTER TABLE `solar_auth_credentials` ADD COLUMN `must_change_password` TINYINT(1) NOT NULL DEFAULT 0");
            }
        } catch (Exception $e) {}

        $pdo->exec("
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
        ");

        // Idempotently insert missing canonical 11 Solar Urja ERP demo accounts (never overwrite existing records)
        $defaultDemoAccounts = [
            ['usr-admin-1', 'System Administrator', 'admin@solar.klyiatechnology.com', 'SolarAdmin@2026', 'Admin', 'ADMIN', 'Executive Administration', 'Principal Administrator', 0],
            ['usr-salesmgr-1', 'Rajesh Deshmukh', 'salesmanager@solar.klyiatechnology.com', 'SolarSales@2026', 'Sales Manager', 'EMPLOYEE', 'Sales & BD', 'Regional Sales Manager', 0],
            ['usr-pm-1', 'Vikram Verma', 'projectmanager@solar.klyiatechnology.com', 'SolarProject@2026', 'Project Manager', 'EMPLOYEE', 'Project Operations', 'Lead Solar EPC Manager', 0],
            ['usr-survey-1', 'Suresh Nair', 'surveyor@solar.klyiatechnology.com', 'SolarSurvey@2026', 'Site Survey Engineer', 'EMPLOYEE', 'Engineering & Surveys', 'Site Survey Engineer', 1],
            ['usr-insp-1', 'Karan Mehta', 'inspector@solar.klyiatechnology.com', 'SolarInspect@2026', 'Site Inspector', 'EMPLOYEE', 'QA / QC Compliance', 'Senior Site Inspector', 1],
            ['usr-civil-1', 'Mahesh Patil', 'civil@solar.klyiatechnology.com', 'SolarCivil@2026', 'Civil Team', 'EMPLOYEE', 'Civil & Structural', 'Civil Team Lead', 1],
            ['usr-elec-1', 'Ramesh Kulkarni', 'electrical@solar.klyiatechnology.com', 'SolarElec@2026', 'Electrical Team', 'EMPLOYEE', 'Electrical & Grid Sync', 'Electrical Team Lead', 1],
            ['usr-inst-1', 'Dinesh Yadav', 'installation@solar.klyiatechnology.com', 'SolarInstall@2026', 'Installation Team', 'EMPLOYEE', 'PV Module Installation', 'Installation Team Lead', 1],
            ['usr-hr-1', 'Priya Sharma', 'hr@solar.klyiatechnology.com', 'SolarHr@2026', 'HR Manager', 'EMPLOYEE', 'Human Resources', 'HR & Workforce Manager', 0],
            ['usr-acc-1', 'Anita Iyer', 'accounts@solar.klyiatechnology.com', 'SolarAccounts@2026', 'Accountant', 'EMPLOYEE', 'Finance & Compliance', 'Accounts & GST Manager', 0],
            ['usr-cust-demo-1', 'Solar Urja Demo Customer', 'customer@solar.klyiatechnology.com', 'SolarCustomer@2026', 'Customer', 'CUSTOMER', 'Client Portal', 'Industrial Solar Customer', 0]
        ];
        foreach ($defaultDemoAccounts as $acc) {
            [$defId, $defName, $defEmail, $defPlain, $defRole, $defType, $defDept, $defDesig, $defFw] = $acc;
            $checkUser = $pdo->prepare("SELECT `id`, `password` FROM `solar_users` WHERE `id` = ? OR LOWER(`email`) = ? LIMIT 1");
            $checkUser->execute([$defId, $defEmail]);
            $existingU = $checkUser->fetch(PDO::FETCH_ASSOC);
            if (!$existingU) {
                $hashedDef = password_hash($defPlain, PASSWORD_BCRYPT, ['cost' => 10]);
                $insU = $pdo->prepare("
                    INSERT IGNORE INTO `solar_users` (`id`, `employee_id`, `name`, `email`, `password`, `role`, `department`, `designation`, `is_field_worker`, `status`, `must_change_password`)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)
                ");
                $insU->execute([$defId, $defId, $defName, $defEmail, $hashedDef, $defRole, $defDept, $defDesig, $defFw]);
                $insC = $pdo->prepare("
                    INSERT IGNORE INTO `solar_auth_credentials` (`id`, `user_id`, `email`, `password_hash`, `role`, `account_type`, `linked_entity_id`, `status`, `must_change_password`)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)
                ");
                $insC->execute(['cred-' . $defId, $defId, $defEmail, $hashedDef, $defRole, $defType, $defId]);
            } else {
                $checkCred = $pdo->prepare("SELECT `id` FROM `solar_auth_credentials` WHERE `user_id` = ? OR LOWER(`email`) = ? LIMIT 1");
                $checkCred->execute([$existingU['id'], $defEmail]);
                if (!$checkCred->fetch(PDO::FETCH_ASSOC)) {
                    $uHash = (string)($existingU['password'] ?? '');
                    if (empty($uHash) || (!str_starts_with($uHash, '$2') && !str_starts_with($uHash, '$argon2'))) {
                        $uHash = password_hash(!empty($uHash) ? $uHash : $defPlain, PASSWORD_BCRYPT, ['cost' => 10]);
                    }
                    $insC = $pdo->prepare("
                        INSERT IGNORE INTO `solar_auth_credentials` (`id`, `user_id`, `email`, `password_hash`, `role`, `account_type`, `linked_entity_id`, `status`, `must_change_password`)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0)
                    ");
                    $insC->execute(['cred-' . $existingU['id'], $existingU['id'], $defEmail, $uHash, $defRole, $defType, $existingU['id']]);
                }
            }
        }

        // Backfill any other solar_users missing from solar_auth_credentials without overwriting existing entries
        $uStmt = $pdo->query("SELECT * FROM `solar_users`");
        while ($u = $uStmt->fetch(PDO::FETCH_ASSOC)) {
            if (empty($u['email'])) continue;
            $pHash = $u['password'] ?? '';
            if (empty($pHash)) continue;
            if (!str_starts_with((string)$pHash, '$2') && !str_starts_with((string)$pHash, '$argon2')) {
                $pHash = password_hash($pHash, PASSWORD_BCRYPT, ['cost' => 10]);
            }
            $uRole = $u['role'] ?: 'Admin';
            $acctType = (strcasecmp($uRole, 'Customer') === 0) ? 'CUSTOMER' : (in_array(strtoupper(trim($uRole)), ['ADMIN', 'SUPER ADMIN'], true) ? 'ADMIN' : 'EMPLOYEE');
            $uStatus = in_array(strtoupper((string)($u['status'] ?? 'ACTIVE')), ['DISABLED', 'INACTIVE'], true) ? 'DISABLED' : 'ACTIVE';
            $ins = $pdo->prepare("
                INSERT IGNORE INTO `solar_auth_credentials` (`id`, `user_id`, `email`, `password_hash`, `role`, `account_type`, `linked_entity_id`, `status`, `must_change_password`)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ");
            $ins->execute([
                'cred-' . $u['id'],
                $u['id'],
                strtolower(trim($u['email'])),
                $pHash,
                $uRole,
                $acctType,
                $u['employee_id'] ?? $u['id'],
                $uStatus,
                !empty($u['must_change_password']) ? 1 : 0
            ]);
        }

        // Backfill customers missing from solar_auth_credentials
        try {
            $cStmt = $pdo->query("SELECT * FROM `solar_customers`");
            while ($c = $cStmt->fetch(PDO::FETCH_ASSOC)) {
                $cEmail = strtolower(trim((string)($c['email'] ?? '')));
                $cPass = (string)($c['password'] ?? '');
                if (empty($cEmail) || empty($cPass)) continue;
                if (!str_starts_with($cPass, '$2') && !str_starts_with($cPass, '$argon2')) {
                    $cPass = password_hash($cPass, PASSWORD_BCRYPT, ['cost' => 10]);
                }
                $rawCustId = preg_replace('/^usr-/', '', (string)$c['id']);
                $cStatus = in_array(strtoupper((string)($c['status'] ?? 'ACTIVE')), ['DISABLED', 'INACTIVE'], true) ? 'DISABLED' : 'ACTIVE';
                try {
                    $insC = $pdo->prepare("
                        INSERT IGNORE INTO `solar_auth_credentials` (`id`, `user_id`, `email`, `password_hash`, `role`, `account_type`, `linked_entity_id`, `status`, `must_change_password`)
                        VALUES (?, ?, ?, ?, 'Customer', 'CUSTOMER', ?, ?, 0)
                    ");
                    $insC->execute(['cred-cust-' . $rawCustId, 'usr-' . $rawCustId, $cEmail, $cPass, $rawCustId, $cStatus]);
                } catch (Exception $e) {}
            }
        } catch (Exception $e) {}
    } catch (Exception $e) {
        error_log('Notice ensuring auth tables: ' . $e->getMessage());
    }

    // Ensure encrypted Gmail SMTP configuration table exists on existing live databases
    try {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS `solar_email_settings` (
              `id` VARCHAR(64) PRIMARY KEY,
              `gmail_address` VARCHAR(191) NOT NULL DEFAULT '',
              `smtp_host` VARCHAR(191) NOT NULL DEFAULT 'smtp.gmail.com',
              `smtp_port` INT NOT NULL DEFAULT 587,
              `smtp_security` VARCHAR(16) NOT NULL DEFAULT 'TLS',
              `sender_name` VARCHAR(255) NOT NULL DEFAULT 'Rejoy Solar ERP',
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
        ");
    } catch (Exception $e) {
        error_log('Notice ensuring solar_email_settings table: ' . $e->getMessage());
    }

    // Auto-migrate solar_service_tickets extended columns and create solar_service_ticket_history table
    try {
        $tkColsRes = $pdo->query("SHOW COLUMNS FROM `solar_service_tickets`")->fetchAll(PDO::FETCH_ASSOC);
        $tkExisting = [];
        foreach ($tkColsRes as $cr) {
            $tkExisting[strtolower($cr['Field'])] = true;
        }
        $tkMigrations = [
            'technician_remarks' => 'TEXT DEFAULT NULL',
            'resolution_details' => 'TEXT DEFAULT NULL',
            'assigned_at' => 'DATETIME DEFAULT NULL',
            'assigned_by_user_id' => 'VARCHAR(64) DEFAULT NULL',
            'assigned_by_name' => 'VARCHAR(255) DEFAULT NULL',
            'updated_at' => 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        ];
        foreach ($tkMigrations as $colName => $colDef) {
            if (!isset($tkExisting[strtolower($colName)])) {
                try { $pdo->exec("ALTER TABLE `solar_service_tickets` ADD COLUMN `$colName` $colDef"); } catch (Exception $e) {}
            }
        }

        $pdo->exec("
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
              INDEX `idx_srv_hist_created` (`created_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ");
    } catch (Exception $e) {
        error_log('Notice ensuring solar_service_tickets / history schema: ' . $e->getMessage());
    }

    // Ensure normalized Vendor Sales Invoices tables exist
    try {
        $pdo->exec("
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
              `returned_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
              `refunded_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
              `balance_amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
              `bank_account_id` VARCHAR(64) DEFAULT '',
              `status` VARCHAR(32) NOT NULL DEFAULT 'ISSUED',
              `created_by` VARCHAR(255) DEFAULT '',
              `updated_by` VARCHAR(255) DEFAULT '',
              `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX `idx_vsi_vendor` (`vendor_id`),
              INDEX `idx_vsi_status` (`status`),
              INDEX `idx_vsi_date` (`invoice_date`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ");
        $pdo->exec("
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
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS `solar_vendor_sales_payments` (
              `id` VARCHAR(64) PRIMARY KEY,
              `invoice_id` VARCHAR(64) NOT NULL,
              `vendor_id` VARCHAR(64) NOT NULL,
              `payment_date` DATE NOT NULL,
              `amount` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
              `payment_mode` VARCHAR(64) NOT NULL DEFAULT 'Bank NEFT/RTGS',
              `reference_no` VARCHAR(128) DEFAULT '',
              `notes` TEXT,
              `bank_account_id` VARCHAR(64) DEFAULT '',
              `journal_entry_id` VARCHAR(64) DEFAULT '',
              `recorded_by` VARCHAR(255) DEFAULT '',
              `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              INDEX `idx_vsip_invoice` (`invoice_id`),
              INDEX `idx_vsip_vendor` (`vendor_id`),
              CONSTRAINT `fk_vsip_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `solar_vendor_sales_invoices` (`id`) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ");
    } catch (Exception $e) {
        error_log('Notice ensuring vendor sales invoice schema: ' . $e->getMessage());
    }

    // Ensure Employee Leave Management tables exist
    try {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS `solar_leave_requests` (
              `id` VARCHAR(64) PRIMARY KEY,
              `employee_id` VARCHAR(64) NOT NULL,
              `employee_code` VARCHAR(32) DEFAULT '',
              `employee_name` VARCHAR(255) NOT NULL,
              `department` VARCHAR(64) DEFAULT 'Operations',
              `designation` VARCHAR(128) DEFAULT '',
              `leave_type` ENUM('CASUAL', 'SICK', 'EARNED', 'UNPAID') NOT NULL DEFAULT 'CASUAL',
              `start_date` DATE NOT NULL,
              `end_date` DATE NOT NULL,
              `total_days` DECIMAL(5,2) NOT NULL DEFAULT 1.00,
              `is_half_day` TINYINT(1) NOT NULL DEFAULT 0,
              `half_day_session` VARCHAR(24) DEFAULT '',
              `reason` TEXT NOT NULL,
              `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
              `leave_year` INT NOT NULL DEFAULT 2026,
              `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              `reviewed_by` VARCHAR(255) DEFAULT NULL,
              `reviewer_id` VARCHAR(64) DEFAULT NULL,
              `reviewed_at` DATETIME DEFAULT NULL,
              `admin_remarks` TEXT DEFAULT NULL,
              `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX `idx_leave_emp` (`employee_id`),
              INDEX `idx_leave_status` (`status`),
              INDEX `idx_leave_year` (`leave_year`),
              INDEX `idx_leave_dates` (`start_date`, `end_date`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS `solar_leave_balances` (
              `id` VARCHAR(64) PRIMARY KEY,
              `employee_id` VARCHAR(64) NOT NULL,
              `leave_year` INT NOT NULL,
              `casual_total` DECIMAL(5,2) NOT NULL DEFAULT 12.00,
              `casual_used` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
              `sick_total` DECIMAL(5,2) NOT NULL DEFAULT 8.00,
              `sick_used` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
              `earned_total` DECIMAL(5,2) NOT NULL DEFAULT 15.00,
              `earned_used` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
              `unpaid_used` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
              `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              UNIQUE KEY `uniq_emp_leave_year` (`employee_id`, `leave_year`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        ");
    } catch (Exception $e) {
        error_log('Notice ensuring solar_leave_requests / solar_leave_balances schema: ' . $e->getMessage());
    }

    require_once __DIR__ . '/accounting.php';
    ensureAccountingTablesPhp($pdo);

    $tablesVerified = true;
}

// Helper: Set production-grade HttpOnly session cookie across all environments
function setServerSessionCookie($sessionToken) {
    $isHttps = isRequestHttps();
    $maxAge = 14 * 24 * 3600; // 14 days (1209600 seconds)
    $expires = gmdate('D, d M Y H:i:s T', time() + $maxAge);
    $encToken = urlencode($sessionToken);

    if ($isHttps) {
        // Primary cookie for iframes (SameSite=None, Secure, Partitioned)
        header("Set-Cookie: rejoysolar_session={$encToken}; Expires={$expires}; Max-Age={$maxAge}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned", false);
        // Fallback cookie for top-level browser direct navigation (SameSite=Lax, Secure)
        header("Set-Cookie: rejoysolar_session_lax={$encToken}; Expires={$expires}; Max-Age={$maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax", false);
    } else {
        // Plain HTTP local development
        header("Set-Cookie: rejoysolar_session={$encToken}; Expires={$expires}; Max-Age={$maxAge}; Path=/; HttpOnly; SameSite=Lax", false);
    }
}

// Helper: Invalidate and clear session cookies
function clearServerSessionCookie() {
    $past = gmdate('D, d M Y H:i:s T', time() - 86400);
    header("Set-Cookie: rejoysolar_session=deleted; Expires={$past}; Max-Age=0; Path=/; HttpOnly; SameSite=None; Secure; Partitioned", false);
    header("Set-Cookie: rejoysolar_session_lax=deleted; Expires={$past}; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure", false);
    header("Set-Cookie: rejoysolar_session=deleted; Expires={$past}; Max-Age=0; Path=/; HttpOnly; SameSite=Lax", false);
}

// Helper: Extract session token from cookies, Authorization header, or custom headers
function extractIncomingSessionToken() {
    // 1. Direct parsed $_COOKIE
    if (!empty($_COOKIE['rejoysolar_session'])) {
        $t = trim($_COOKIE['rejoysolar_session']);
        if ($t && $t !== 'null' && $t !== 'undefined') return $t;
    }
    if (!empty($_COOKIE['rejoysolar_session_lax'])) {
        $t = trim($_COOKIE['rejoysolar_session_lax']);
        if ($t && $t !== 'null' && $t !== 'undefined') return $t;
    }

    // 2. Raw Cookie header check (LiteSpeed/Apache CGI proxies can omit $_COOKIE on subrequests)
    $rawCookie = $_SERVER['HTTP_COOKIE'] ?? '';
    if (!empty($rawCookie)) {
        if (preg_match('/(?:^|;\s*)rejoysolar_session=([^;]*)/', $rawCookie, $m)) {
            $dec = trim(urldecode($m[1]));
            if ($dec && $dec !== 'null' && $dec !== 'undefined') return $dec;
        }
        if (preg_match('/(?:^|;\s*)rejoysolar_session_lax=([^;]*)/', $rawCookie, $m)) {
            $dec = trim(urldecode($m[1]));
            if ($dec && $dec !== 'null' && $dec !== 'undefined') return $dec;
        }
    }

    // 3. Authorization Bearer header
    $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/Bearer\s+(\S+)/i', $authHeader, $matches)) {
        $t = trim($matches[1]);
        if ($t && $t !== 'null' && $t !== 'undefined') return $t;
    }

    // 4. Custom token headers
    $xAuth = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? $_SERVER['HTTP_X_SESSION_TOKEN'] ?? '';
    if (!empty($xAuth)) {
        $t = trim($xAuth);
        if ($t && $t !== 'null' && $t !== 'undefined') return $t;
    }

    // 5. Apache / LiteSpeed getallheaders() fallback
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        $auth = $headers['Authorization'] ?? $headers['authorization'] ?? '';
        if (preg_match('/Bearer\s+(\S+)/i', $auth, $matches)) {
            $t = trim($matches[1]);
            if ($t && $t !== 'null' && $t !== 'undefined') return $t;
        }
        $xTok = $headers['x-auth-token'] ?? $headers['X-Auth-Token'] ?? $headers['x-session-token'] ?? '';
        if (!empty($xTok)) {
            $t = trim($xTok);
            if ($t && $t !== 'null' && $t !== 'undefined') return $t;
        }
    }

    return null;
}

// Helper: Create persistent session record in MySQL solar_auth_sessions
function createDbSession($pdo, $userId, $email, $role, $accountType, $linkedEntityId = null) {
    $token = bin2hex(random_bytes(32));
    $ip = $_SERVER['REMOTE_ADDR'] ?? null;
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? null;

    // Use MySQL's authoritative NOW() clock to eliminate PHP <-> MySQL timezone drift
    $stmt = $pdo->prepare("
        INSERT INTO `solar_auth_sessions` (
            `id`, `user_id`, `email`, `role`, `account_type`,
            `linked_entity_id`, `ip_address`, `user_agent`, `expires_at`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 14 DAY))
    ");
    $stmt->execute([
        $token,
        $userId,
        strtolower(trim($email)),
        $role,
        $accountType,
        $linkedEntityId,
        $ip,
        $ua
    ]);

    return $token;
}

// Helper: Authoritatively validate session in MySQL solar_auth_sessions
function validateDbSession($pdo, $sessionToken) {
    if (!$pdo || empty($sessionToken)) return null;

    try {
        $stmt = $pdo->prepare("SELECT *, UNIX_TIMESTAMP(`expires_at`) AS `expires_unix`, UNIX_TIMESTAMP(NOW()) AS `now_unix` FROM `solar_auth_sessions` WHERE `id` = ? LIMIT 1");
        $stmt->execute([trim($sessionToken)]);
        $sess = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        return null;
    }

    if (!$sess) {
        return null;
    }

    $expiresUnix = intval($sess['expires_unix'] ?? 0);
    $nowUnix = intval($sess['now_unix'] ?? 0);
    if ($expiresUnix > 0 && $nowUnix > 0 && $nowUnix > $expiresUnix) {
        try {
            $del = $pdo->prepare("DELETE FROM `solar_auth_sessions` WHERE `id` = ?");
            $del->execute([$sessionToken]);
        } catch (Exception $e) {}
        return null;
    }

    // Touch last_active_at
    try {
        $up = $pdo->prepare("UPDATE `solar_auth_sessions` SET `last_active_at` = NOW() WHERE `id` = ?");
        $up->execute([$sessionToken]);
    } catch (Exception $e) {}

    $userId = $sess['user_id'];
    $email = strtolower(trim($sess['email']));
    $accountType = strtoupper(trim((string)($sess['account_type'] ?? '')));

    $credMustChange = false;
    try {
        $stmtCred = $pdo->prepare("SELECT `must_change_password`, `status` FROM `solar_auth_credentials` WHERE `user_id` = ? OR LOWER(`email`) = ? LIMIT 1");
        $stmtCred->execute([$userId, $email]);
        $credRow = $stmtCred->fetch(PDO::FETCH_ASSOC);
        if (!$credRow) {
            return null;
        }
        if (in_array(strtoupper(trim((string)($credRow['status'] ?? 'ACTIVE'))), ['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'], true)) {
            return null;
        }
        $credMustChange = !empty($credRow['must_change_password']);
    } catch (Exception $e) {
        return null;
    }

    $resolveCustomer = function () use ($pdo, $sess, $userId, $email, $credMustChange) {
        $rawId = preg_replace('/^usr-/', '', (string)($sess['linked_entity_id'] ?: $userId));
        try {
            $stmtCust = $pdo->prepare("SELECT * FROM `solar_customers` WHERE `id` = ? OR `id` = ? OR LOWER(`email`) = ? LIMIT 1");
            $stmtCust->execute([$rawId, $userId, $email]);
            $cust = $stmtCust->fetch(PDO::FETCH_ASSOC);
            if ($cust) {
                $cleanCustId = preg_replace('/^usr-/', '', (string)$cust['id']);
                return [
                    'id' => 'usr-' . $cleanCustId,
                    'userId' => 'usr-' . $cleanCustId,
                    'customerId' => $cust['id'],
                    'employeeId' => 'CUST-' . $cust['id'],
                    'name' => $cust['name'] ?? 'Customer',
                    'email' => $cust['email'],
                    'role' => 'Customer',
                    'phone' => $cust['phone'] ?? '',
                    'department' => 'Customer Portal',
                    'designation' => 'Customer',
                    'isFieldWorker' => false,
                    'accountType' => 'CUSTOMER',
                    'status' => $cust['status'] ?? 'ACTIVE',
                    'mustChangePassword' => $credMustChange
                ];
            }
        } catch (Exception $e) {}
        return null;
    };

    $resolveEmployee = function () use ($pdo, $sess, $userId, $email, $credMustChange) {
        try {
            $emp = null;
            $lookupId = $sess['linked_entity_id'] ?: $userId;
            try {
                $stmtEmp = $pdo->prepare("SELECT * FROM `solar_employees` WHERE `id` = ? OR `id` = ? OR `auth_uid` = ? OR LOWER(`email`) = ? LIMIT 1");
                $stmtEmp->execute([$userId, $lookupId, $userId, $email]);
                $emp = $stmtEmp->fetch(PDO::FETCH_ASSOC);
            } catch (Exception $e) {}

            if (!$emp) {
                try {
                    $stmtEmpOld = $pdo->prepare("SELECT * FROM `solar_employee` WHERE `id` = ? OR `id` = ? OR `auth_uid` = ? OR LOWER(`email`) = ? LIMIT 1");
                    $stmtEmpOld->execute([$userId, $lookupId, $userId, $email]);
                    $emp = $stmtEmpOld->fetch(PDO::FETCH_ASSOC);
                } catch (Exception $e) {}
            }

            if ($emp) {
                $isDisabledEmp = (isset($emp['login_enabled']) && intval($emp['login_enabled']) === 0)
                    || in_array(strtoupper((string)($emp['status'] ?? 'ACTIVE')), ['DISABLED', 'INACTIVE', 'TERMINATED'], true)
                    || strtoupper((string)($emp['account_status'] ?? 'ACTIVE')) === 'DISABLED';
                $isFw = (bool)($emp['is_field_worker'] ?? false) || in_array($emp['system_role'] ?? '', [
                    'Site Survey Engineer', 'Site Inspector', 'Civil Team', 'Structure Team', 'Installation Team', 'Electrical Team', 'Technician'
                ]);
                return [
                    'id' => $emp['id'],
                    'userId' => $emp['auth_uid'] ?? $emp['id'],
                    'employeeId' => $emp['employee_code'] ?? $emp['id'],
                    'name' => $emp['name'] ?? 'Solar Employee',
                    'email' => $emp['email'],
                    'role' => $sess['role'] ?: ($emp['system_role'] ?? $emp['assigned_role'] ?? 'Staff'),
                    'phone' => $emp['phone'] ?? '',
                    'department' => $emp['department'] ?? 'Operations',
                    'designation' => $emp['designation'] ?? $sess['role'],
                    'isFieldWorker' => $isFw,
                    'accountType' => $sess['account_type'],
                    'status' => $isDisabledEmp ? 'DISABLED' : ($emp['status'] ?? 'ACTIVE'),
                    'mustChangePassword' => $credMustChange
                ];
            }
        } catch (Exception $e) {}
        return null;
    };

    $resolveUser = function () use ($pdo, $sess, $userId, $email, $credMustChange) {
        try {
            $stmtUser = $pdo->prepare("SELECT * FROM `solar_users` WHERE `id` = ? OR LOWER(`email`) = ? LIMIT 1");
            $stmtUser->execute([$userId, $email]);
            $u = $stmtUser->fetch(PDO::FETCH_ASSOC);
            if ($u) {
                return [
                    'id' => $u['id'],
                    'userId' => $u['id'],
                    'employeeId' => $u['employee_id'] ?? $u['id'],
                    'name' => $u['name'] ?? 'User',
                    'email' => $u['email'],
                    'role' => $sess['role'] ?: ($u['role'] ?? 'Admin'),
                    'phone' => $u['phone'] ?? '',
                    'department' => $u['department'] ?? 'Administration',
                    'designation' => $u['designation'] ?? 'Staff',
                    'isFieldWorker' => (bool)($u['is_field_worker'] ?? false),
                    'accountType' => $sess['account_type'],
                    'status' => $u['status'] ?? 'ACTIVE',
                    'mustChangePassword' => $credMustChange || !empty($u['must_change_password'])
                ];
            }
        } catch (Exception $e) {}
        return null;
    };

    if ($accountType === 'CUSTOMER') {
        if ($profile = $resolveCustomer()) return $profile;
        if ($profile = $resolveUser()) return $profile;
    } elseif ($accountType === 'ADMIN') {
        if ($profile = $resolveUser()) return $profile;
        if ($profile = $resolveEmployee()) return $profile;
    } else {
        if ($profile = $resolveEmployee()) return $profile;
        if ($profile = $resolveUser()) return $profile;
        if ($profile = $resolveCustomer()) return $profile;
    }

    return null;
}

// Helper: Destroy session in MySQL solar_auth_sessions
function destroyDbSession($pdo, $sessionToken) {
    if (empty($sessionToken)) return true;
    try {
        $stmt = $pdo->prepare("DELETE FROM `solar_auth_sessions` WHERE `id` = ?");
        $stmt->execute([trim($sessionToken)]);
        return true;
    } catch (Exception $e) {
        return false;
    }
}

// Helper: Safe Audit Logger for solar_users mutations (NEVER logs passwords, hashes, tokens, or cookies)
function logSolarUsersAuditPhp($operation, $source, $targetId, $targetEmail = '', $actor = null) {
    $entry = [
        'timestamp' => gmdate('c'),
        'operation' => $operation,
        'source' => $source,
        'targetUserId' => $targetId,
        'email' => strtolower(trim((string)$targetEmail)) ?: null,
        'actorUserId' => is_array($actor) ? ($actor['id'] ?? $actor['userId'] ?? null) : null,
        'actorRole' => is_array($actor) ? ($actor['role'] ?? null) : null
    ];
    error_log('[Audit][solar_users] ' . json_encode($entry));
}

// Helper: Synchronize solar_auth_credentials safely
function syncAuthCredentialPhp($pdo, $userId, $email, $passwordHashOrNull, $role, $accountType, $linkedEntityId, $status = 'ACTIVE') {
    $cleanEmail = strtolower(trim((string)$email));
    if (empty($cleanEmail) || empty($userId)) return;
    try {
        $stmt = $pdo->prepare('SELECT id, password_hash FROM `solar_auth_credentials` WHERE user_id = ? OR LOWER(email) = ? LIMIT 1');
        $stmt->execute([$userId, $cleanEmail]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);
        $finalHash = !empty($passwordHashOrNull) ? $passwordHashOrNull : ($existing['password_hash'] ?? '');
        if ($existing) {
            $upSql = 'UPDATE `solar_auth_credentials` SET `email` = ?, `role` = ?, `account_type` = ?, `linked_entity_id` = ?, `status` = ?'
                . (!empty($passwordHashOrNull) ? ', `password_hash` = ?, `password_changed_at` = NOW()' : '')
                . ' WHERE `id` = ?';
            $params = [$cleanEmail, $role, $accountType, $linkedEntityId ?: $userId, $status];
            if (!empty($passwordHashOrNull)) $params[] = $passwordHashOrNull;
            $params[] = $existing['id'];
            $pdo->prepare($upSql)->execute($params);
        } elseif (!empty($finalHash)) {
            $ins = $pdo->prepare('
                INSERT INTO `solar_auth_credentials` (`id`, `user_id`, `email`, `password_hash`, `role`, `account_type`, `linked_entity_id`, `status`)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ');
            $ins->execute(['cred-' . $userId, $userId, $cleanEmail, $finalHash, $role, $accountType, $linkedEntityId ?: $userId, $status]);
        }
        if (in_array(strtoupper($status), ['DISABLED', 'INACTIVE'], true)) {
            $pdo->prepare('DELETE FROM `solar_auth_sessions` WHERE `user_id` = ? OR `linked_entity_id` = ? OR LOWER(`email`) = ?')
                ->execute([$userId, $linkedEntityId ?: $userId, $cleanEmail]);
        }
    } catch (Exception $e) {
        error_log('Notice syncing solar_auth_credentials: ' . $e->getMessage());
    }
}

// Helper: Resolve authenticated active user from session token
function getAuthenticatedUserPhp($pdo) {
    $token = extractIncomingSessionToken();
    if (empty($token)) return null;
    $user = validateDbSession($pdo, $token);
    if (!$user) return null;
    $status = strtoupper((string)($user['status'] ?? 'ACTIVE'));
    if (in_array($status, ['DISABLED', 'INACTIVE'], true)) {
        return null;
    }
    return $user;
}

function requireAuthUserPhp($pdo) {
    $user = getAuthenticatedUserPhp($pdo);
    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'message' => 'Authentication required. Please log in with an active session.']);
        exit;
    }
    return $user;
}

function requireAdminUserPhp($pdo) {
    $user = requireAuthUserPhp($pdo);
    $roleUpper = strtoupper(trim((string)($user['role'] ?? '')));
    if (!in_array($roleUpper, ['ADMIN', 'SUPER ADMIN'], true)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied: Administrator privileges required.']);
        exit;
    }
    return $user;
}

function requireAdminOrHrUserPhp($pdo) {
    $user = requireAuthUserPhp($pdo);
    if (!in_array($user['role'] ?? '', ['Admin', 'Super Admin', 'HR Manager'], true)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied: Administrator or HR Manager privileges required.']);
        exit;
    }
    return $user;
}

function isCustomerUserPhp($user) {
    if (!$user || !is_array($user)) return false;
    $acct = strtoupper(trim((string)($user['accountType'] ?? ($user['account_type'] ?? ''))));
    $role = strtolower(trim((string)($user['role'] ?? '')));
    return $acct === 'CUSTOMER' || in_array($role, ['customer', 'client'], true);
}

function getUploadRootCandidatesPhp() {
    $candidates = [];
    $webRoot = dirname(__DIR__);
    if (!empty($webRoot)) {
        $candidates[] = rtrim($webRoot, '/\\') . '/uploads';
    }
    $parentRoot = dirname(__DIR__, 2);
    if (!empty($parentRoot) && $parentRoot !== $webRoot) {
        $candidates[] = rtrim($parentRoot, '/\\') . '/rejoy_uploads';
    }
    $tmpRoot = sys_get_temp_dir();
    if (!empty($tmpRoot)) {
        $candidates[] = rtrim($tmpRoot, '/\\') . '/rejoy_solar_uploads';
    }
    return array_values(array_unique($candidates));
}

function resolveUploadsRootPhp() {
    foreach (getUploadRootCandidatesPhp() as $cand) {
        if (!is_dir($cand)) {
            @mkdir($cand, 0755, true);
        }
        if (is_dir($cand) && is_writable($cand)) {
            $htPath = $cand . '/.htaccess';
            if (!file_exists($htPath)) {
                @file_put_contents($htPath, "Options -Indexes\n<FilesMatch \"\\.(php|phtml|php3|php4|php5|php7|php8|phar)$\">\n  <IfModule mod_authz_core.c>\n    Require all denied\n  </IfModule>\n  <IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n  </IfModule>\n</FilesMatch>\n");
            }
            return $cand;
        }
    }
    throw new Exception('No writable upload directory available on server.', 500);
}

function resolveUploadFilePathPhp($relativeSubPath) {
    $cleanSub = ltrim(str_replace('\\', '/', (string)$relativeSubPath), '/');
    if ($cleanSub === '' || strpos($cleanSub, '..') !== false || strpos($cleanSub, "\0") !== false) {
        return null;
    }
    foreach (getUploadRootCandidatesPhp() as $root) {
        $realRoot = @realpath($root);
        if (!$realRoot) continue;
        $candidate = $realRoot . '/' . $cleanSub;
        $realFile = @realpath($candidate);
        if ($realFile && is_file($realFile) && str_starts_with($realFile, rtrim($realRoot, '/\\') . DIRECTORY_SEPARATOR)) {
            return $realFile;
        }
    }
    return null;
}

function validateAndDecodeUploadedPayloadPhp($fileName, $fileData, $mode = 'image') {
    $rawName = trim((string)$fileName);
    $buffer = null;

    if (empty($fileData) && !empty($_FILES['file']['tmp_name']) && is_uploaded_file($_FILES['file']['tmp_name'])) {
        $rawName = $rawName !== '' ? $rawName : trim((string)($_FILES['file']['name'] ?? 'upload'));
        $readBuf = @file_get_contents($_FILES['file']['tmp_name']);
        if ($readBuf !== false) {
            $buffer = $readBuf;
        }
    } elseif (is_string($fileData) && trim($fileData) !== '') {
        $base64Data = strpos($fileData, ',') !== false ? explode(',', $fileData, 2)[1] : $fileData;
        $decoded = base64_decode(preg_replace('/\s+/', '', $base64Data), true);
        if ($decoded !== false) {
            $buffer = $decoded;
        }
    }

    if ($rawName === '' || $buffer === null || strlen($buffer) === 0) {
        throw new Exception('Valid file name and non-empty file payload are required.', 400);
    }

    $maxBytes = 10 * 1024 * 1024; // 10 MB limit
    if (strlen($buffer) > $maxBytes) {
        throw new Exception('Uploaded file exceeds the 10 MB size limit.', 400);
    }

    $safeFileName = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename($rawName));
    if ($safeFileName === '' || $safeFileName === '.' || $safeFileName === '..') {
        $safeFileName = 'attachment';
    }
    $ext = strtolower(pathinfo($safeFileName, PATHINFO_EXTENSION));

    $head = substr($buffer, 0, 16);
    $detectedExt = null;
    $detectedMime = null;

    if (strlen($buffer) >= 3 && substr($buffer, 0, 3) === "\xFF\xD8\xFF") {
        $detectedExt = 'jpg';
        $detectedMime = 'image/jpeg';
    } elseif (strlen($buffer) >= 8 && substr($buffer, 0, 8) === "\x89PNG\r\n\x1a\n") {
        $detectedExt = 'png';
        $detectedMime = 'image/png';
    } elseif (strlen($buffer) >= 12 && substr($buffer, 0, 4) === 'RIFF' && substr($buffer, 8, 4) === 'WEBP') {
        $detectedExt = 'webp';
        $detectedMime = 'image/webp';
    } elseif (preg_match('/^\s*%PDF-/', $head)) {
        $detectedExt = 'pdf';
        $detectedMime = 'application/pdf';
    }

    if ($mode === 'image') {
        $allowedExts = ['jpg', 'jpeg', 'png', 'webp'];
        if (!$detectedExt || !in_array($detectedExt, ['jpg', 'png', 'webp'], true)) {
            throw new Exception('Unsupported or invalid image file. Only JPG, JPEG, PNG, and WebP images are allowed.', 400);
        }
        if ($ext !== '' && !in_array($ext, $allowedExts, true)) {
            throw new Exception('Unsupported file extension. Only JPG, JPEG, PNG, and WebP images are allowed.', 400);
        }
        if (function_exists('getimagesizefromstring') && $detectedExt !== 'webp') {
            $imgInfo = @getimagesizefromstring($buffer);
            if ($imgInfo === false) {
                throw new Exception('Corrupted or invalid image file content.', 400);
            }
        }
    } else {
        $allowedExts = ['pdf', 'jpg', 'jpeg', 'png'];
        if (!$detectedExt || !in_array($detectedExt, ['pdf', 'jpg', 'png'], true)) {
            throw new Exception('Unsupported file format. Only valid PDF, JPG, JPEG, or PNG vendor bills are allowed.', 400);
        }
        if ($ext !== '' && !in_array($ext, $allowedExts, true)) {
            throw new Exception('Unsupported file extension. Only PDF, JPG, JPEG, and PNG files are allowed.', 400);
        }
        if ($detectedExt !== 'pdf' && function_exists('getimagesizefromstring')) {
            $imgInfo = @getimagesizefromstring($buffer);
            if ($imgInfo === false) {
                throw new Exception('Corrupted or invalid vendor bill image.', 400);
            }
        }
    }

    if ($ext === '') {
        $safeFileName .= '.' . $detectedExt;
    }

    return [
        'buffer' => $buffer,
        'ext' => $detectedExt,
        'mimeType' => $detectedMime,
        'safeFileName' => $safeFileName,
        'fileSize' => strlen($buffer)
    ];
}

function mapVendorBillsFromPoRowPhp($r) {
    $bills = [];
    if (!empty($r['vendor_bills_json'])) {
        $decoded = json_decode((string)$r['vendor_bills_json'], true);
        if (is_array($decoded)) {
            foreach ($decoded as $b) {
                if (is_array($b) && !empty($b['fileUrl'])) {
                    $bills[] = [
                        'id' => (string)($b['id'] ?? ('bill-' . md5((string)$b['fileUrl']))),
                        'fileName' => (string)($b['fileName'] ?? 'vendor-bill'),
                        'fileUrl' => (string)$b['fileUrl'],
                        'filePath' => (string)($b['filePath'] ?? ''),
                        'mimeType' => (string)($b['mimeType'] ?? 'application/pdf'),
                        'fileSize' => intval($b['fileSize'] ?? 0),
                        'uploadedAt' => (string)($b['uploadedAt'] ?? date('c')),
                        'uploadedBy' => (string)($b['uploadedBy'] ?? '')
                    ];
                }
            }
        }
    }
    if (empty($bills) && !empty($r['vendor_bill_url'])) {
        $bills[] = [
            'id' => 'bill-primary-' . preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($r['id'] ?? 'po')),
            'fileName' => (string)($r['vendor_bill_name'] ?? 'Vendor Bill'),
            'fileUrl' => (string)$r['vendor_bill_url'],
            'filePath' => '',
            'mimeType' => (string)($r['vendor_bill_mime'] ?? 'application/pdf'),
            'fileSize' => intval($r['vendor_bill_size'] ?? 0),
            'uploadedAt' => (string)($r['vendor_bill_uploaded_at'] ?? ($r['updated_at'] ?? date('c'))),
            'uploadedBy' => ''
        ];
    }
    $primary = $bills[0] ?? null;
    return [
        'vendorBills' => $bills,
        'vendorBillUrl' => $primary ? $primary['fileUrl'] : (string)($r['vendor_bill_url'] ?? ''),
        'vendorBillName' => $primary ? $primary['fileName'] : (string)($r['vendor_bill_name'] ?? ''),
        'vendorBillMimeType' => $primary ? $primary['mimeType'] : (string)($r['vendor_bill_mime'] ?? ''),
        'vendorBillSize' => $primary ? intval($primary['fileSize']) : intval($r['vendor_bill_size'] ?? 0),
        'vendorBillUploadedAt' => $primary ? $primary['uploadedAt'] : (string)($r['vendor_bill_uploaded_at'] ?? '')
    ];
}

function userCanAccessProjectPhp($pdo, $actor, $projectId) {
    if (!isCustomerUserPhp($actor)) return true;
    $pStmt = $pdo->prepare('SELECT `customer_id`, `customer_name` FROM `solar_projects` WHERE `id` = ? LIMIT 1');
    $pStmt->execute([$projectId]);
    $proj = $pStmt->fetch(PDO::FETCH_ASSOC);
    if (!$proj) return false;
    $linkedCustId = trim((string)($actor['linkedEntityId'] ?? ($actor['linked_entity_id'] ?? ($actor['customerId'] ?? ''))));
    if ($linkedCustId !== '' && $linkedCustId === trim((string)($proj['customer_id'] ?? ''))) {
        return true;
    }
    $actorEmail = strtolower(trim((string)($actor['email'] ?? '')));
    if ($actorEmail !== '' && !empty($proj['customer_id'])) {
        $cStmt = $pdo->prepare('SELECT `id`, `email` FROM `solar_customers` WHERE `id` = ? LIMIT 1');
        $cStmt->execute([$proj['customer_id']]);
        $cust = $cStmt->fetch(PDO::FETCH_ASSOC);
        if ($cust && strtolower(trim((string)($cust['email'] ?? ''))) === $actorEmail) {
            return true;
        }
    }
    return false;
}

// 7. Normalize Path & Method (Guard against Apache/LiteSpeed PATH_INFO='/' overwriting REQUEST_URI)
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$requestUri = $_SERVER['REQUEST_URI'] ?? '/';
$parsedPath = parse_url($requestUri, PHP_URL_PATH) ?: '/';
$pathInfo = isset($_SERVER['PATH_INFO']) ? trim((string)$_SERVER['PATH_INFO']) : '';
if ($pathInfo !== '' && $pathInfo !== '/' && strpos($pathInfo, '/index.php') === false) {
    if ($parsedPath === '/' || preg_match('#(?:/api)?/index\.php/?$#i', $parsedPath)) {
        $parsedPath = $pathInfo;
    }
}

$cleanPath = rtrim($parsedPath, '/');
if (empty($cleanPath)) $cleanPath = '/';

// Strip /api and optional /index.php prefix if present
if (substr($cleanPath, 0, 4) === '/api') {
    $cleanPath = substr($cleanPath, 4);
    if (empty($cleanPath)) $cleanPath = '/';
}
if (substr($cleanPath, 0, 10) === '/index.php') {
    $cleanPath = substr($cleanPath, 10);
    if (empty($cleanPath)) $cleanPath = '/';
}
$cleanPath = rtrim($cleanPath, '/');
if (empty($cleanPath)) $cleanPath = '/';

$rawInput = file_get_contents('php://input');
$body = json_decode($rawInput, true) ?: [];

// ==========================================================
// 8. DATABASE CRUD HELPERS FOR ALL 26 COLLECTIONS
// ==========================================================

// Helper: Customers
function saveCustomerToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'cust-' . round(microtime(true) * 1000);
    $ex = fetchExistingRowPhp($pdo, 'solar_customers', $item['id']);
    $customerCode = $item['customerCode'] ?? $item['customer_code'] ?? ($ex['customer_code'] ?? ('CUST-' . rand(100, 999)));
    $name = trim((string)($item['name'] ?? ($ex['name'] ?? '')));
    $companyName = trim((string)($item['companyName'] ?? $item['company_name'] ?? ($ex['company_name'] ?? '')));
    $customerType = $item['customerType'] ?? $item['customer_type'] ?? ($ex['customer_type'] ?? 'Residential');
    $phone = trim((string)($item['phone'] ?? ($ex['phone'] ?? '')));
    $email = trim((string)($item['email'] ?? ($ex['email'] ?? '')));
    $rawCustomerPass = $item['password'] ?? '';
    if (!empty($rawCustomerPass)) {
        $password = str_starts_with((string)$rawCustomerPass, '$2')
            ? $rawCustomerPass
            : password_hash((string)$rawCustomerPass, PASSWORD_BCRYPT, ['cost' => 10]);
    } elseif (!empty($ex['password'])) {
        $password = $ex['password'];
    } else {
        $password = password_hash('Cust@' . substr(bin2hex(random_bytes(3)), 0, 6), PASSWORD_BCRYPT, ['cost' => 10]);
    }
    $siteAddress = $item['siteAddress'] ?? $item['site_address'] ?? ($ex['site_address'] ?? '');
    $city = $item['city'] ?? ($ex['city'] ?? 'Ahmedabad');
    $state = $item['state'] ?? ($ex['state'] ?? 'Gujarat');
    $pincode = $item['pincode'] ?? ($ex['pincode'] ?? '');
    $gstNumber = $item['gstNumber'] ?? $item['gst_number'] ?? ($ex['gst_number'] ?? '');
    $electricityConsumerNo = $item['electricityConsumerNo'] ?? $item['electricity_consumer_no'] ?? ($ex['electricity_consumer_no'] ?? '');
    $sanctionedLoadKw = array_key_exists('sanctionedLoadKw', $item) || array_key_exists('sanctioned_load_kw', $item)
        ? floatval($item['sanctionedLoadKw'] ?? $item['sanctioned_load_kw'] ?? 0)
        : floatval($ex['sanctioned_load_kw'] ?? 0);
    $status = $item['status'] ?? ($ex['status'] ?? 'ACTIVE');
    $activeProjectId = array_key_exists('activeProjectId', $item) || array_key_exists('active_project_id', $item)
        ? ($item['activeProjectId'] ?? $item['active_project_id'])
        : ($ex['active_project_id'] ?? null);

    $hasExplicitCustomerPass = !empty($rawCustomerPass);
    $stmt = $pdo->prepare("
        INSERT INTO `solar_customers` (
            `id`, `customer_code`, `name`, `company_name`, `customer_type`,
            `phone`, `email`, `password`, `site_address`, `city`, `state`,
            `pincode`, `gst_number`, `electricity_consumer_no`, `sanctioned_load_kw`,
            `status`, `active_project_id`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `name` = VALUES(`name`),
            `company_name` = VALUES(`company_name`),
            `customer_type` = VALUES(`customer_type`),
            `phone` = VALUES(`phone`),
            `email` = VALUES(`email`),
            " . ($hasExplicitCustomerPass ? "`password` = VALUES(`password`)," : "") . "
            `site_address` = VALUES(`site_address`),
            `city` = VALUES(`city`),
            `state` = VALUES(`state`),
            `pincode` = VALUES(`pincode`),
            `gst_number` = VALUES(`gst_number`),
            `electricity_consumer_no` = VALUES(`electricity_consumer_no`),
            `sanctioned_load_kw` = VALUES(`sanctioned_load_kw`),
            `status` = VALUES(`status`),
            `active_project_id` = VALUES(`active_project_id`)
    ");
    $stmt->execute([
        $item['id'], $customerCode, $name, $companyName, $customerType,
        $phone, $email, $password, $siteAddress, $city, $state,
        $pincode, $gstNumber, $electricityConsumerNo, $sanctionedLoadKw,
        $status, $activeProjectId
    ]);
    if (!empty($email)) {
        $rawCustId = preg_replace('/^usr-/', '', (string)$item['id']);
        $credStatus = in_array(strtoupper((string)$status), ['DISABLED', 'INACTIVE'], true) ? 'DISABLED' : 'ACTIVE';
        $passToSync = ($hasExplicitCustomerPass || !$ex) ? $password : null;
        syncAuthCredentialPhp($pdo, 'usr-' . $rawCustId, $email, $passToSync, 'Customer', 'CUSTOMER', $rawCustId, $credStatus);
    }
    return array_merge($item, [
        'id' => $item['id'],
        'customerCode' => $customerCode,
        'name' => $name,
        'companyName' => $companyName,
        'customerType' => $customerType,
        'phone' => $phone,
        'email' => $email,
        'siteAddress' => $siteAddress,
        'city' => $city,
        'state' => $state,
        'pincode' => $pincode,
        'gstNumber' => $gstNumber,
        'electricityConsumerNo' => $electricityConsumerNo,
        'sanctionedLoadKw' => $sanctionedLoadKw,
        'status' => $status,
        'activeProjectId' => $activeProjectId
    ]);
}

// Helper: Leads
function saveLeadToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'lead-' . round(microtime(true) * 1000);
    $ex = fetchExistingRowPhp($pdo, 'solar_leads', $item['id']);

    $customerName = array_key_exists('customerName', $item)
        ? trim((string)($item['customerName'] ?? ''))
        : (array_key_exists('customer_name', $item) ? trim((string)($item['customer_name'] ?? '')) : ($ex['customer_name'] ?? ''));
    $companyName = array_key_exists('companyName', $item)
        ? trim((string)($item['companyName'] ?? ''))
        : (array_key_exists('company_name', $item) ? trim((string)($item['company_name'] ?? '')) : ($ex['company_name'] ?? ''));
    $phone = array_key_exists('phone', $item)
        ? trim((string)($item['phone'] ?? ''))
        : ($ex['phone'] ?? '');
    $email = array_key_exists('email', $item)
        ? trim((string)($item['email'] ?? ''))
        : ($ex['email'] ?? '');
    $address = array_key_exists('address', $item)
        ? trim((string)($item['address'] ?? ''))
        : ($ex['address'] ?? '');
    $city = array_key_exists('city', $item)
        ? trim((string)($item['city'] ?? ''))
        : ($ex['city'] ?? '');
    $solarCapacityKw = array_key_exists('solarCapacityKw', $item)
        ? floatval($item['solarCapacityKw'] ?? 0)
        : (array_key_exists('solar_capacity_kw', $item) ? floatval($item['solar_capacity_kw'] ?? 0) : floatval($ex['solar_capacity_kw'] ?? 0));
    $estimatedValue = array_key_exists('estimatedValue', $item)
        ? floatval($item['estimatedValue'] ?? 0)
        : (array_key_exists('estimated_value', $item) ? floatval($item['estimated_value'] ?? 0) : floatval($ex['estimated_value'] ?? 0));
    $source = array_key_exists('source', $item)
        ? (trim((string)($item['source'] ?? '')) ?: 'Website')
        : ($ex['source'] ?? 'Website');

    if (array_key_exists('assignedSalespersonId', $item)) {
        $assignedSalespersonId = trim((string)($item['assignedSalespersonId'] ?? ''));
    } elseif (array_key_exists('assigned_salesperson_id', $item)) {
        $assignedSalespersonId = trim((string)($item['assigned_salesperson_id'] ?? ''));
    } elseif (array_key_exists('assignedToId', $item)) {
        $assignedSalespersonId = trim((string)($item['assignedToId'] ?? ''));
    } else {
        $assignedSalespersonId = $ex['assigned_salesperson_id'] ?? '';
    }

    if (array_key_exists('assignedSalespersonName', $item)) {
        $assignedSalespersonName = trim((string)($item['assignedSalespersonName'] ?? ''));
    } elseif (array_key_exists('assigned_salesperson_name', $item)) {
        $assignedSalespersonName = trim((string)($item['assigned_salesperson_name'] ?? ''));
    } elseif (array_key_exists('assignedToName', $item)) {
        $assignedSalespersonName = trim((string)($item['assignedToName'] ?? ''));
    } else {
        $assignedSalespersonName = $ex['assigned_salesperson_name'] ?? '';
    }

    $status = array_key_exists('status', $item)
        ? (trim((string)($item['status'] ?? '')) ?: 'NEW')
        : ($ex['status'] ?? 'NEW');
    $notes = array_key_exists('notes', $item)
        ? (string)($item['notes'] ?? '')
        : ($ex['notes'] ?? '');

    if (array_key_exists('nextFollowUpDate', $item)) {
        $rawNextFollowUp = trim((string)($item['nextFollowUpDate'] ?? ''));
    } elseif (array_key_exists('next_follow_up_date', $item)) {
        $rawNextFollowUp = trim((string)($item['next_follow_up_date'] ?? ''));
    } else {
        $rawNextFollowUp = trim((string)($ex['next_follow_up_date'] ?? ''));
    }
    $nextFollowUpDate = $rawNextFollowUp !== '' ? substr($rawNextFollowUp, 0, 10) : null;

    $stmt = $pdo->prepare("
        INSERT INTO `solar_leads` (
            `id`, `customer_name`, `company_name`, `phone`, `email`,
            `address`, `city`, `solar_capacity_kw`, `estimated_value`,
            `source`, `assigned_salesperson_id`, `assigned_salesperson_name`,
            `status`, `notes`, `next_follow_up_date`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `customer_name` = VALUES(`customer_name`),
            `company_name` = VALUES(`company_name`),
            `phone` = VALUES(`phone`),
            `email` = VALUES(`email`),
            `address` = VALUES(`address`),
            `city` = VALUES(`city`),
            `solar_capacity_kw` = VALUES(`solar_capacity_kw`),
            `estimated_value` = VALUES(`estimated_value`),
            `source` = VALUES(`source`),
            `assigned_salesperson_id` = VALUES(`assigned_salesperson_id`),
            `assigned_salesperson_name` = VALUES(`assigned_salesperson_name`),
            `status` = VALUES(`status`),
            `notes` = VALUES(`notes`),
            `next_follow_up_date` = VALUES(`next_follow_up_date`)
    ");
    $stmt->execute([
        $item['id'], $customerName, $companyName, $phone, $email,
        $address, $city, $solarCapacityKw, $estimatedValue,
        $source, $assignedSalespersonId, $assignedSalespersonName,
        $status, $notes, $nextFollowUpDate
    ]);

    $savedRow = fetchExistingRowPhp($pdo, 'solar_leads', $item['id']);
    if ($savedRow) {
        return [
            'id' => $savedRow['id'],
            'customerName' => $savedRow['customer_name'],
            'companyName' => $savedRow['company_name'] ?? '',
            'phone' => $savedRow['phone'],
            'email' => $savedRow['email'] ?? '',
            'address' => $savedRow['address'] ?? '',
            'city' => $savedRow['city'] ?? '',
            'solarCapacityKw' => floatval($savedRow['solar_capacity_kw'] ?? 0),
            'estimatedValue' => floatval($savedRow['estimated_value'] ?? 0),
            'source' => $savedRow['source'] ?? 'Website',
            'assignedSalespersonId' => $savedRow['assigned_salesperson_id'] ?? '',
            'assignedSalespersonName' => $savedRow['assigned_salesperson_name'] ?? '',
            'status' => $savedRow['status'] ?? 'NEW',
            'notes' => $savedRow['notes'] ?? '',
            'nextFollowUpDate' => $savedRow['next_follow_up_date'] ?? '',
            'createdAt' => $savedRow['created_at'],
            'updatedAt' => $savedRow['updated_at']
        ];
    }

    return [
        'id' => $item['id'],
        'customerName' => $customerName,
        'companyName' => $companyName,
        'phone' => $phone,
        'email' => $email,
        'address' => $address,
        'city' => $city,
        'solarCapacityKw' => $solarCapacityKw,
        'estimatedValue' => $estimatedValue,
        'source' => $source,
        'assignedSalespersonId' => $assignedSalespersonId,
        'assignedSalespersonName' => $assignedSalespersonName,
        'status' => $status,
        'notes' => $notes,
        'nextFollowUpDate' => $nextFollowUpDate ?? ''
    ];
}

// Helper: Projects
function saveProjectToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'proj-' . round(microtime(true) * 1000);
    $ex = fetchExistingRowPhp($pdo, 'solar_projects', $item['id']);

    $projectCode = $item['projectCode'] ?? $item['project_code'] ?? ($ex['project_code'] ?? ('SOL-' . date('Y') . '-' . rand(100, 999)));
    $customerId = $item['customerId'] ?? $item['customer_id'] ?? ($ex['customer_id'] ?? '');
    $customerName = $item['customerName'] ?? $item['customer_name'] ?? ($ex['customer_name'] ?? '');
    $title = $item['title'] ?? ($ex['title'] ?? 'Solar Project');

    $rawCap = array_key_exists('capacityKw', $item) ? $item['capacityKw'] : ($item['capacity_kw'] ?? null);
    $capacityKw = $rawCap !== null ? floatval($rawCap) : floatval($ex['capacity_kw'] ?? 10);

    $rawVal = array_key_exists('totalValue', $item) ? $item['totalValue'] : ($item['total_value'] ?? null);
    $totalValue = $rawVal !== null ? floatval($rawVal) : floatval($ex['total_value'] ?? 0);

    $hasInflow = array_key_exists('receivedInflow', $item) || array_key_exists('received_inflow', $item);
    if ($hasInflow) {
        $rawInf = array_key_exists('receivedInflow', $item) ? $item['receivedInflow'] : ($item['received_inflow'] ?? null);
        $receivedInflow = ($rawInf === null || $rawInf === '') ? null : floatval($rawInf);
    } else {
        $receivedInflow = (isset($ex['received_inflow']) && $ex['received_inflow'] !== null) ? floatval($ex['received_inflow']) : null;
    }

    $status = $item['status'] ?? ($ex['status'] ?? 'PLANNING');
    $currentStageKey = $item['currentStageKey'] ?? $item['current_stage_key'] ?? ($ex['current_stage_key'] ?? 'site_survey');
    $rawPct = $item['completionPercentage'] ?? $item['completion_percentage'] ?? $item['progressPercentage'] ?? null;
    $completionPercentage = $rawPct !== null ? intval($rawPct) : intval($ex['completion_percentage'] ?? 0);
    $projectManagerId = $item['projectManagerId'] ?? $item['project_manager_id'] ?? ($ex['project_manager_id'] ?? '');
    $projectManagerName = $item['projectManagerName'] ?? $item['project_manager_name'] ?? ($ex['project_manager_name'] ?? '');
    $siteAddress = $item['siteAddress'] ?? $item['site_address'] ?? ($ex['site_address'] ?? 'Not specified');
    $city = $item['city'] ?? $item['location'] ?? ($ex['city'] ?? 'Not specified');
    $inverterModel = $item['inverterModel'] ?? $item['inverter_model'] ?? ($ex['inverter_model'] ?? '');
    $panelModel = $item['panelModel'] ?? $item['panel_model'] ?? ($ex['panel_model'] ?? '');
    $structureType = $item['structureType'] ?? $item['structure_type'] ?? ($ex['structure_type'] ?? 'Elevated GI Structure');

    $rawStart = $item['startDate'] ?? $item['start_date'] ?? ($ex['start_date'] ?? null);
    $startDate = !empty($rawStart) ? substr((string)$rawStart, 0, 10) : null;
    $rawExp = $item['expectedCompletionDate'] ?? $item['expected_completion_date'] ?? ($ex['expected_completion_date'] ?? null);
    $expectedCompletionDate = !empty($rawExp) ? substr((string)$rawExp, 0, 10) : null;

    $notes = $item['notes'] ?? ($ex['notes'] ?? '');
    if (array_key_exists('assignedUsers', $item) || array_key_exists('assignments', $item)) {
        $assignedUsers = $item['assignedUsers'] ?? $item['assignments'] ?? [];
        $assignmentsJson = is_string($assignedUsers) ? $assignedUsers : json_encode($assignedUsers);
    } else {
        $assignmentsJson = $ex['assignments_json'] ?? '[]';
    }

    $stmt = $pdo->prepare("
        INSERT INTO `solar_projects` (
            `id`, `project_code`, `customer_id`, `customer_name`, `title`,
            `capacity_kw`, `total_value`, `received_inflow`, `status`, `current_stage_key`,
            `completion_percentage`, `project_manager_id`, `project_manager_name`,
            `site_address`, `city`, `inverter_model`, `panel_model`,
            `structure_type`, `start_date`, `expected_completion_date`,
            `notes`, `assignments_json`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `customer_name` = VALUES(`customer_name`),
            `title` = VALUES(`title`),
            `capacity_kw` = VALUES(`capacity_kw`),
            `total_value` = VALUES(`total_value`),
            `received_inflow` = VALUES(`received_inflow`),
            `status` = VALUES(`status`),
            `current_stage_key` = VALUES(`current_stage_key`),
            `completion_percentage` = VALUES(`completion_percentage`),
            `project_manager_id` = VALUES(`project_manager_id`),
            `project_manager_name` = VALUES(`project_manager_name`),
            `site_address` = VALUES(`site_address`),
            `city` = VALUES(`city`),
            `inverter_model` = VALUES(`inverter_model`),
            `panel_model` = VALUES(`panel_model`),
            `structure_type` = VALUES(`structure_type`),
            `start_date` = VALUES(`start_date`),
            `expected_completion_date` = VALUES(`expected_completion_date`),
            `notes` = VALUES(`notes`),
            `assignments_json` = VALUES(`assignments_json`)
    ");
    $stmt->execute([
        $item['id'], $projectCode, $customerId, $customerName, $title,
        $capacityKw, $totalValue, $receivedInflow, $status, $currentStageKey,
        $completionPercentage, $projectManagerId, $projectManagerName,
        $siteAddress, $city, $inverterModel, $panelModel,
        $structureType, $startDate, $expectedCompletionDate,
        $notes, $assignmentsJson
    ]);

    // Also persist stages into solar_project_stages if present
    if (!empty($item['stages']) && is_array($item['stages'])) {
        $stageStmt = $pdo->prepare("
            INSERT INTO `solar_project_stages` (
                `id`, `project_id`, `stage_key`, `title`, `stage_order`,
                `department`, `assigned_role`, `assigned_employee_id`, `assigned_employee_name`,
                `status`, `priority`, `start_date`, `due_date`, `completed_date`,
                `checklist_json`, `photos_json`, `documents_json`, `gps_location_json`,
                `notes`, `approved_by`, `rejection_reason`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                `status` = VALUES(`status`),
                `priority` = VALUES(`priority`),
                `assigned_employee_id` = VALUES(`assigned_employee_id`),
                `assigned_employee_name` = VALUES(`assigned_employee_name`),
                `start_date` = VALUES(`start_date`),
                `due_date` = VALUES(`due_date`),
                `completed_date` = VALUES(`completed_date`),
                `checklist_json` = VALUES(`checklist_json`),
                `photos_json` = VALUES(`photos_json`),
                `documents_json` = VALUES(`documents_json`),
                `gps_location_json` = VALUES(`gps_location_json`),
                `notes` = VALUES(`notes`),
                `approved_by` = VALUES(`approved_by`),
                `rejection_reason` = VALUES(`rejection_reason`)
        ");
        $lookupStageStmt = $pdo->prepare('SELECT `id` FROM `solar_project_stages` WHERE `project_id` = ? AND `stage_key` = ? LIMIT 1');
        foreach ($item['stages'] as $s) {
            $stageKey = $s['stageKey'] ?? $s['key'] ?? 'stage';
            $sId = !empty($s['id']) ? $s['id'] : null;
            if (empty($sId)) {
                $lookupStageStmt->execute([$item['id'], $stageKey]);
                $existingStageRowId = $lookupStageStmt->fetchColumn();
                $sId = $existingStageRowId ? (string)$existingStageRowId : ($item['id'] . '-' . $stageKey);
            }
            $sTitle = $s['title'] ?? $s['name'] ?? 'Stage';
            $sOrder = intval($s['order'] ?? $s['stage_order'] ?? 1);
            $sDept = $s['department'] ?? 'Operations';
            $sRole = $s['assignedRole'] ?? 'Technician';
            $sEmpId = $s['assignedEmployeeId'] ?? '';
            $sEmpName = $s['assignedEmployeeName'] ?? $s['assignedToName'] ?? '';
            $sStatus = $s['status'] ?? 'NOT STARTED';
            $sPriority = $s['priority'] ?? 'MEDIUM';
            $sStart = !empty($s['startDate']) ? substr($s['startDate'], 0, 10) : null;
            $sDue = !empty($s['dueDate']) ? substr($s['dueDate'], 0, 10) : null;
            $sCompleted = !empty($s['completedDate']) ? substr($s['completedDate'], 0, 10) : null;
            $chkJson = is_string($s['checklist'] ?? '') ? $s['checklist'] : json_encode($s['checklist'] ?? []);
            $photosJson = is_string($s['photos'] ?? '') ? $s['photos'] : json_encode($s['photos'] ?? []);
            $docsJson = is_string($s['documents'] ?? '') ? $s['documents'] : json_encode($s['documents'] ?? []);
            $gpsJson = !empty($s['gpsLocation']) ? (is_string($s['gpsLocation']) ? $s['gpsLocation'] : json_encode($s['gpsLocation'])) : null;
            $sNotes = $s['notes'] ?? '';
            $sApprovedBy = $s['approvedBy'] ?? '';
            $sRejectionReason = $s['rejectionReason'] ?? '';

            $stageStmt->execute([
                $sId, $item['id'], $stageKey, $sTitle, $sOrder,
                $sDept, $sRole, $sEmpId, $sEmpName,
                $sStatus, $sPriority, $sStart, $sDue, $sCompleted,
                $chkJson, $photosJson, $docsJson, $gpsJson,
                $sNotes, $sApprovedBy, $sRejectionReason
            ]);
        }
    }
    return array_merge($item, [
        'id' => $item['id'],
        'projectCode' => $projectCode,
        'customerId' => $customerId,
        'customerName' => $customerName,
        'title' => $title,
        'capacityKw' => $capacityKw,
        'totalValue' => $totalValue,
        'receivedInflow' => $receivedInflow,
        'status' => $status,
        'currentStageKey' => $currentStageKey,
        'completionPercentage' => $completionPercentage,
        'progressPercentage' => $completionPercentage,
        'projectManagerId' => $projectManagerId,
        'projectManagerName' => $projectManagerName,
        'siteAddress' => $siteAddress,
        'city' => $city,
        'location' => !empty($city) ? $city : $siteAddress,
        'inverterModel' => $inverterModel,
        'panelModel' => $panelModel,
        'structureType' => $structureType,
        'startDate' => $startDate,
        'expectedCompletionDate' => $expectedCompletionDate,
        'notes' => $notes,
        'assignedUsers' => json_decode($assignmentsJson, true) ?: []
    ]);
}

function parseBoolFlagPhp($val, $fallback = false) {
    if (is_bool($val)) return $val;
    if (is_int($val) || is_float($val)) return $val != 0;
    if (is_string($val)) {
        $n = strtolower(trim($val));
        if ($n === 'true' || $n === '1' || $n === 'yes') return true;
        if ($n === 'false' || $n === '0' || $n === 'no' || $n === '') return false;
    }
    return (bool)$fallback;
}

// Helper: Employees
function saveEmployeeToDb($pdo, $item, $actor = null) {
    if (empty($item['id'])) $item['id'] = 'emp-' . round(microtime(true) * 1000);
    $requestedId = (string)$item['id'];

    $existingEmp = null;
    try {
        $stmtEx = $pdo->prepare('SELECT * FROM `solar_employees` WHERE `id` = ? LIMIT 1');
        $stmtEx->execute([$item['id']]);
        $existingEmp = $stmtEx->fetch(PDO::FETCH_ASSOC) ?: null;
        if (!$existingEmp && !empty($item['authUid'] ?? $item['auth_uid'] ?? '')) {
            $stmtEx2 = $pdo->prepare('SELECT * FROM `solar_employees` WHERE `auth_uid` = ? LIMIT 1');
            $stmtEx2->execute([$item['authUid'] ?? $item['auth_uid']]);
            $existingEmp = $stmtEx2->fetch(PDO::FETCH_ASSOC) ?: null;
            if ($existingEmp) $item['id'] = $existingEmp['id'];
        }
    } catch (Exception $e) {}

    $code = trim((string)($item['employeeCode'] ?? $item['employee_code'] ?? ($existingEmp['employee_code'] ?? $item['id'])));
    $name = trim((string)($item['name'] ?? ($existingEmp['name'] ?? '')));
    $photoUrl = $item['photoUrl'] ?? $item['photo_url'] ?? ($existingEmp['photo_url'] ?? '');
    $hasExplicitDocs = isset($item['documents']) && is_array($item['documents']);
    $documents = $hasExplicitDocs
        ? $item['documents']
        : (json_decode($existingEmp['documents_json'] ?? '[]', true) ?: []);
    $documentsJson = json_encode(array_values($documents));
    $dept = $item['department'] ?? ($existingEmp['department'] ?? 'Operations');
    $desig = $item['designation'] ?? ($existingEmp['designation'] ?? 'Solar Engineer');
    $phone = trim((string)($item['phone'] ?? ($existingEmp['phone'] ?? '+91 99999 00000')));
    $email = strtolower(trim((string)($item['email'] ?? ($existingEmp['email'] ?? ''))));
    $joiningDate = !empty($item['joiningDate'] ?? $item['joining_date'])
        ? substr((string)($item['joiningDate'] ?? $item['joining_date']), 0, 10)
        : (!empty($existingEmp['joining_date']) ? substr((string)$existingEmp['joining_date'], 0, 10) : date('Y-m-d'));
    $salary = floatval($item['salaryMonthly'] ?? $item['salary_monthly'] ?? $item['salary'] ?? ($existingEmp['salary_monthly'] ?? ($existingEmp['salary'] ?? 0)));
    $esicNumber = trim((string)($item['esicNumber'] ?? $item['esic_number'] ?? ($existingEmp['esic_number'] ?? '')));
    $bankAccountNumber = trim((string)($item['bankAccountNumber'] ?? $item['bank_account_number'] ?? ($existingEmp['bank_account_number'] ?? '')));
    $bankName = trim((string)($item['bankName'] ?? $item['bank_name'] ?? ($existingEmp['bank_name'] ?? '')));
    $ifscCode = strtoupper(trim((string)($item['ifscCode'] ?? $item['ifsc_code'] ?? ($existingEmp['ifsc_code'] ?? ''))));
    $emergencyContactPerson = trim((string)($item['emergencyContactPerson'] ?? $item['emergency_contact_person'] ?? ($existingEmp['emergency_contact_person'] ?? '')));
    $emergencyContactNumber = trim((string)($item['emergencyContactNumber'] ?? $item['emergency_contact_number'] ?? ($existingEmp['emergency_contact_number'] ?? '')));
    $status = $item['status'] ?? ($existingEmp['status'] ?? 'ACTIVE');
    $siteLoc = $item['currentSiteLocation'] ?? $item['current_site_location'] ?? ($existingEmp['current_site_location'] ?? '');

    $loginRaw = array_key_exists('loginEnabled', $item) ? $item['loginEnabled'] : (array_key_exists('login_enabled', $item) ? $item['login_enabled'] : null);
    $loginEnabled = ($loginRaw !== null ? parseBoolFlagPhp($loginRaw, true) : (!empty($existingEmp) ? parseBoolFlagPhp($existingEmp['login_enabled'] ?? 1, true) : true)) ? 1 : 0;

    $authUid = $item['authUid'] ?? $item['auth_uid'] ?? ($existingEmp['auth_uid'] ?? $item['id']);
    $systemRole = $item['systemRole'] ?? $item['system_role'] ?? ($existingEmp['system_role'] ?? 'Site Survey Engineer');
    $assignedRole = $item['assignedRole'] ?? $item['assigned_role'] ?? ($existingEmp['assigned_role'] ?? $systemRole);

    $fwRaw = array_key_exists('isFieldWorker', $item) ? $item['isFieldWorker'] : (array_key_exists('is_field_worker', $item) ? $item['is_field_worker'] : null);
    $isFieldWorker = ($fwRaw !== null ? parseBoolFlagPhp($fwRaw, false) : (!empty($existingEmp) && parseBoolFlagPhp($existingEmp['is_field_worker'] ?? 0, false))) ? 1 : 0;

    $accountStatus = $item['accountStatus'] ?? $item['account_status'] ?? ($existingEmp['account_status'] ?? ($loginEnabled ? 'ACTIVE' : 'DISABLED'));
    $accountCreatedAt = $item['accountCreatedAt'] ?? $item['account_created_at'] ?? ($existingEmp['account_created_at'] ?? null);
    $accountCreatedBy = $item['accountCreatedBy'] ?? $item['account_created_by'] ?? ($existingEmp['account_created_by'] ?? null);

    // Prevent duplicate employee_code or email conflicts cleanly before inserting
    if (!empty($code)) {
        $stmtDupCode = $pdo->prepare('SELECT id, name FROM `solar_employees` WHERE UPPER(`employee_code`) = UPPER(?) AND `id` != ? LIMIT 1');
        $stmtDupCode->execute([$code, $item['id']]);
        if ($dupCodeRow = $stmtDupCode->fetch(PDO::FETCH_ASSOC)) {
            throw new Exception("Employee code \"$code\" is already assigned to {$dupCodeRow['name']}.", 409);
        }
    }
    if (!empty($email)) {
        $stmtDupEmail = $pdo->prepare('SELECT id, name FROM `solar_employees` WHERE LOWER(`email`) = ? AND `email` != "" AND `id` != ? LIMIT 1');
        $stmtDupEmail->execute([$email, $item['id']]);
        if ($dupEmailRow = $stmtDupEmail->fetch(PDO::FETCH_ASSOC)) {
            throw new Exception("Email \"$email\" is already assigned to employee {$dupEmailRow['name']}.", 409);
        }
    }

    $startedTx = !$pdo->inTransaction();
    if ($startedTx) $pdo->beginTransaction();

    try {
        $stmt = $pdo->prepare("
            INSERT INTO `solar_employees` (
                `id`, `employee_code`, `name`, `photo_url`, `documents_json`, `department`,
                `designation`, `phone`, `email`, `joining_date`, `salary_monthly`,
                `esic_number`, `bank_account_number`, `bank_name`, `ifsc_code`,
                `emergency_contact_person`, `emergency_contact_number`,
                `status`, `current_site_location`, `login_enabled`, `auth_uid`, `system_role`,
                `assigned_role`, `is_field_worker`, `account_status`, `account_created_at`, `account_created_by`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                `employee_code` = VALUES(`employee_code`),
                `name` = VALUES(`name`),
                `photo_url` = VALUES(`photo_url`),
                `documents_json` = VALUES(`documents_json`),
                `department` = VALUES(`department`),
                `designation` = VALUES(`designation`),
                `phone` = VALUES(`phone`),
                `email` = VALUES(`email`),
                `joining_date` = VALUES(`joining_date`),
                `salary_monthly` = VALUES(`salary_monthly`),
                `esic_number` = VALUES(`esic_number`),
                `bank_account_number` = VALUES(`bank_account_number`),
                `bank_name` = VALUES(`bank_name`),
                `ifsc_code` = VALUES(`ifsc_code`),
                `emergency_contact_person` = VALUES(`emergency_contact_person`),
                `emergency_contact_number` = VALUES(`emergency_contact_number`),
                `status` = VALUES(`status`),
                `current_site_location` = VALUES(`current_site_location`),
                `login_enabled` = VALUES(`login_enabled`),
                `auth_uid` = VALUES(`auth_uid`),
                `system_role` = VALUES(`system_role`),
                `assigned_role` = VALUES(`assigned_role`),
                `is_field_worker` = VALUES(`is_field_worker`),
                `account_status` = VALUES(`account_status`),
                `account_created_at` = COALESCE(VALUES(`account_created_at`), `account_created_at`),
                `account_created_by` = COALESCE(VALUES(`account_created_by`), `account_created_by`)
        ");
        $stmt->execute([
            $item['id'], $code, $name, $photoUrl, $documentsJson, $dept,
            $desig, $phone, $email, $joiningDate, $salary,
            $esicNumber, $bankAccountNumber, $bankName, $ifscCode,
            $emergencyContactPerson, $emergencyContactNumber,
            $status, $siteLoc, $loginEnabled, $authUid, $systemRole,
            $assignedRole, $isFieldWorker, $accountStatus, $accountCreatedAt, $accountCreatedBy
        ]);

        // Reconcile any pre-uploaded draft documents if canonical employee ID resolved differently
        if ($requestedId !== (string)$item['id']) {
            $pdo->prepare('UPDATE `solar_employee_documents` SET `employee_id` = ? WHERE `employee_id` = ?')
                ->execute([$item['id'], $requestedId]);
        }

        // Synchronize documents into solar_employee_documents table when explicitly supplied
        if ($hasExplicitDocs) {
            $keepIds = [];
            foreach ($documents as $d) {
                if (!empty($d['id'])) $keepIds[] = $d['id'];
            }
            if (empty($keepIds)) {
                $pdo->prepare('DELETE FROM `solar_employee_documents` WHERE `employee_id` = ?')->execute([$item['id']]);
            } else {
                $placeholders = implode(',', array_fill(0, count($keepIds), '?'));
                $pdo->prepare("DELETE FROM `solar_employee_documents` WHERE `employee_id` = ? AND `id` NOT IN ($placeholders)")
                    ->execute(array_merge([$item['id']], $keepIds));
            }
            foreach ($documents as $doc) {
                if (empty($doc['id']) || empty($doc['fileName'])) continue;
                $pdo->prepare("
                    INSERT INTO `solar_employee_documents` (
                        `id`, `employee_id`, `category`, `name`, `file_name`,
                        `file_path`, `file_url`, `mime_type`, `file_size`,
                        `uploaded_at`, `uploaded_by`, `notes`
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
                    ON DUPLICATE KEY UPDATE
                        `employee_id` = VALUES(`employee_id`),
                        `category` = VALUES(`category`),
                        `name` = VALUES(`name`),
                        `file_name` = VALUES(`file_name`),
                        `file_path` = VALUES(`file_path`),
                        `file_url` = VALUES(`file_url`),
                        `mime_type` = VALUES(`mime_type`),
                        `file_size` = VALUES(`file_size`),
                        `notes` = VALUES(`notes`)
                ")->execute([
                    $doc['id'],
                    $item['id'],
                    $doc['category'] ?? 'Other',
                    $doc['name'] ?? $doc['fileName'],
                    $doc['fileName'],
                    $doc['filePath'] ?? ($doc['fileUrl'] ?? ''),
                    $doc['fileUrl'] ?? '',
                    $doc['mimeType'] ?? 'application/octet-stream',
                    intval($doc['fileSize'] ?? 0),
                    $doc['uploadedBy'] ?? 'HR Administrator',
                    $doc['notes'] ?? null
                ]);
            }
        }

        // Synchronize to solar_users & solar_auth_credentials atomically
        $stmtUserCheck = $pdo->prepare('SELECT id, password FROM `solar_users` WHERE `id` = ? OR `id` = ? OR `employee_id` = ? OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1');
        $stmtUserCheck->execute([$item['id'], $authUid, $code, $email]);
        $existingU = $stmtUserCheck->fetch(PDO::FETCH_ASSOC) ?: null;

        $rawPass = $item['password'] ?? ($item['tempPassword'] ?? null);
        $hasExplicitPass = !empty($rawPass) && is_string($rawPass) && strlen(trim($rawPass)) >= 6;
        $isActiveLogin = ($loginEnabled === 1)
            && !in_array(strtoupper((string)$status), ['INACTIVE', 'TERMINATED', 'DISABLED'], true)
            && strtoupper((string)$accountStatus) !== 'DISABLED';

        $cleanPhotoUrl = trim((string)$photoUrl);
        $hasPhotoUrl = $cleanPhotoUrl !== '';

        if (!$isActiveLogin) {
            if ($existingU) {
                $disSql = "UPDATE `solar_users` SET `name` = ?, `department` = ?, `designation` = ?, `employee_id` = ?, `is_field_worker` = ?"
                    . ($hasPhotoUrl ? ', `photo_url` = ?, `avatar` = ?' : '')
                    . ", `status` = 'DISABLED', `updated_at` = CURRENT_TIMESTAMP WHERE `id` = ?";
                $disParams = [$name, $dept, $desig, $code, $isFieldWorker];
                if ($hasPhotoUrl) {
                    $disParams[] = $cleanPhotoUrl;
                    $disParams[] = $cleanPhotoUrl;
                }
                $disParams[] = $existingU['id'];
                $pdo->prepare($disSql)->execute($disParams);
                syncAuthCredentialPhp($pdo, $existingU['id'], $email, null, $systemRole, in_array($systemRole, ['Admin', 'Super Admin'], true) ? 'ADMIN' : 'EMPLOYEE', $item['id'], 'DISABLED');
                try {
                    $pdo->prepare('DELETE FROM `solar_auth_sessions` WHERE `user_id` = ? OR `linked_entity_id` = ? OR LOWER(`email`) = ?')
                        ->execute([$existingU['id'], $item['id'], $email]);
                } catch (Exception $e) {}
                logSolarUsersAuditPhp('DISABLE', 'saveEmployeeToDb', $existingU['id'], $email, $actor);
            }
        } elseif (!empty($email) && ($existingU || !$existingEmp || $hasExplicitPass)) {
            $userPassHash = $existingU['password'] ?? null;
            if ($hasExplicitPass) {
                $trimmedPass = trim($rawPass);
                if (substr($trimmedPass, 0, 4) !== '$2y$' && substr($trimmedPass, 0, 4) !== '$2b$' && substr($trimmedPass, 0, 4) !== '$2a$' && substr($trimmedPass, 0, 9) !== '$argon2id$') {
                    $userPassHash = password_hash($trimmedPass, PASSWORD_BCRYPT, ['cost' => 10]);
                } else {
                    $userPassHash = $trimmedPass;
                }
            } elseif (empty($userPassHash)) {
                $userPassHash = password_hash('Emp@' . substr(bin2hex(random_bytes(3)), 0, 6), PASSWORD_BCRYPT, ['cost' => 10]);
            }

            $targetUserId = $existingU['id'] ?? $item['id'];
            if ($existingU) {
                $upSql = "UPDATE `solar_users` SET `name` = ?, `email` = ?, `role` = ?, `phone` = ?, `department` = ?, `designation` = ?, `employee_id` = ?"
                    . ($hasPhotoUrl ? ', `avatar` = ?, `photo_url` = ?' : '')
                    . ", `is_field_worker` = ?, `status` = 'ACTIVE', `updated_at` = CURRENT_TIMESTAMP"
                    . ($hasExplicitPass ? ', `password` = ?' : '')
                    . ' WHERE `id` = ?';
                $upParams = [$name, $email, $systemRole, $phone, $dept, $desig, $code];
                if ($hasPhotoUrl) {
                    $upParams[] = $cleanPhotoUrl;
                    $upParams[] = $cleanPhotoUrl;
                }
                $upParams[] = $isFieldWorker;
                if ($hasExplicitPass) $upParams[] = $userPassHash;
                $upParams[] = $targetUserId;
                $pdo->prepare($upSql)->execute($upParams);
                logSolarUsersAuditPhp('UPDATE', 'saveEmployeeToDb', $targetUserId, $email, $actor);
            } else {
                $pdo->prepare("
                    INSERT INTO `solar_users` (
                        `id`, `name`, `email`, `password`, `role`, `phone`,
                        `department`, `designation`, `employee_id`, `avatar`, `photo_url`, `is_field_worker`, `status`
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
                ")->execute([
                    $targetUserId, $name, $email, $userPassHash, $systemRole, $phone,
                    $dept, $desig, $code, ($photoUrl ?: null), ($photoUrl ?: null), $isFieldWorker
                ]);
                logSolarUsersAuditPhp('INSERT', 'saveEmployeeToDb', $targetUserId, $email, $actor);
            }

            $acctType = in_array($systemRole, ['Admin', 'Super Admin'], true) ? 'ADMIN' : 'EMPLOYEE';
            syncAuthCredentialPhp($pdo, $targetUserId, $email, ($hasExplicitPass || !$existingU) ? $userPassHash : null, $systemRole, $acctType, $item['id'], 'ACTIVE');

            // Keep auth_uid synced cleanly if an existing user matched
            if ($targetUserId !== $authUid) {
                $authUid = $targetUserId;
                $pdo->prepare('UPDATE `solar_employees` SET `auth_uid` = ? WHERE `id` = ?')->execute([$authUid, $item['id']]);
            }
        }

        if ($startedTx) $pdo->commit();
    } catch (Exception $e) {
        if ($startedTx && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    unset($item['password'], $item['tempPassword']);
    $item['authUid'] = $authUid;
    $item['salaryMonthly'] = $salary;
    $item['esicNumber'] = $esicNumber;
    $item['bankAccountNumber'] = $bankAccountNumber;
    $item['bankName'] = $bankName;
    $item['ifscCode'] = $ifscCode;
    $item['emergencyContactPerson'] = $emergencyContactPerson;
    $item['emergencyContactNumber'] = $emergencyContactNumber;
    $item['isFieldWorker'] = (bool)$isFieldWorker;
    $item['photoUrl'] = $photoUrl;
    $item['documents'] = array_values($documents);
    return $item;
}

// Helper: Payments
function savePaymentToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('pay-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_payments', $id);
    $receiptNo = $item['receiptNumber'] ?? $item['receipt_number'] ?? ($ex['receipt_number'] ?? ('REC-' . date('Y') . '-' . rand(100, 999)));
    $projectId = $item['projectId'] ?? $item['project_id'] ?? ($ex['project_id'] ?? '');
    $customerId = $item['customerId'] ?? $item['customer_id'] ?? ($ex['customer_id'] ?? '');
    $customerName = $item['customerName'] ?? $item['customer_name'] ?? ($ex['customer_name'] ?? 'Customer');
    $milestone = $item['milestone'] ?? ($ex['milestone'] ?? 'Advance');
    $amount = floatval($item['amount'] ?? ($ex['amount'] ?? 0));
    $status = $item['status'] ?? ($ex['status'] ?? 'PENDING');
    $rawDue = $item['dueDate'] ?? $item['due_date'] ?? ($ex['due_date'] ?? null);
    $dueDate = !empty($rawDue) ? substr((string)$rawDue, 0, 10) : null;
    $rawPaid = $item['paidDate'] ?? $item['paymentDate'] ?? $item['paid_date'] ?? ($ex['paid_date'] ?? null);
    $paidDate = !empty($rawPaid) ? substr((string)$rawPaid, 0, 10) : null;
    $mode = $item['paymentMode'] ?? $item['paymentMethod'] ?? $item['payment_mode'] ?? ($ex['payment_mode'] ?? 'Bank NEFT/RTGS');
    $txRef = $item['transactionReference'] ?? $item['transactionRef'] ?? $item['referenceNumber'] ?? $item['transaction_reference'] ?? ($ex['transaction_reference'] ?? '');
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');
    $invoiceId = $item['invoiceId'] ?? $item['invoice_id'] ?? ($ex['invoice_id'] ?? '');
    $invoiceNumber = $item['invoiceNumber'] ?? $item['invoice_number'] ?? ($ex['invoice_number'] ?? '');
    $bankAccountId = $item['bankAccountId'] ?? $item['bank_account_id'] ?? ($ex['bank_account_id'] ?? '');
    $journalEntryId = $item['journalEntryId'] ?? $item['journal_entry_id'] ?? ($ex['journal_entry_id'] ?? '');
    $tallyStatus = $item['tallySyncStatus'] ?? $item['tally_sync_status'] ?? ($ex['tally_sync_status'] ?? 'NOT SYNCED');
    $tallyRef = $item['tallyReference'] ?? $item['tally_reference'] ?? ($ex['tally_reference'] ?? '');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_payments` (
            `id`, `receipt_number`, `project_id`, `customer_id`, `customer_name`,
            `milestone`, `amount`, `status`, `due_date`, `paid_date`,
            `payment_mode`, `transaction_reference`, `notes`,
            `invoice_id`, `invoice_number`, `bank_account_id`, `journal_entry_id`,
            `tally_sync_status`, `tally_reference`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `customer_id` = VALUES(`customer_id`),
            `customer_name` = VALUES(`customer_name`),
            `project_id` = VALUES(`project_id`),
            `milestone` = VALUES(`milestone`),
            `amount` = VALUES(`amount`),
            `status` = VALUES(`status`),
            `due_date` = VALUES(`due_date`),
            `paid_date` = VALUES(`paid_date`),
            `payment_mode` = VALUES(`payment_mode`),
            `transaction_reference` = VALUES(`transaction_reference`),
            `notes` = VALUES(`notes`),
            `invoice_id` = VALUES(`invoice_id`),
            `invoice_number` = VALUES(`invoice_number`),
            `bank_account_id` = VALUES(`bank_account_id`),
            `journal_entry_id` = VALUES(`journal_entry_id`),
            `tally_sync_status` = VALUES(`tally_sync_status`),
            `tally_reference` = VALUES(`tally_reference`)
    ");
    $stmt->execute([
        $id, $receiptNo, $projectId, $customerId, $customerName,
        $milestone, $amount, $status, $dueDate, $paidDate,
        $mode, $txRef, $notes,
        $invoiceId, $invoiceNumber, $bankAccountId, $journalEntryId,
        $tallyStatus, $tallyRef
    ]);
    return array_merge($item, [
        'id' => $id,
        'receiptNumber' => $receiptNo,
        'projectId' => $projectId,
        'customerId' => $customerId,
        'customerName' => $customerName,
        'milestone' => $milestone,
        'amount' => $amount,
        'status' => $status,
        'dueDate' => $dueDate ?? '',
        'paidDate' => $paidDate ?? '',
        'paymentMode' => $mode,
        'transactionReference' => $txRef,
        'notes' => $notes,
        'invoiceId' => $invoiceId,
        'invoiceNumber' => $invoiceNumber,
        'bankAccountId' => $bankAccountId,
        'journalEntryId' => $journalEntryId,
        'tallySyncStatus' => $tallyStatus,
        'tallyReference' => $tallyRef
    ]);
}

// Helper: Expenses
function saveExpenseToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('exp-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_expenses', $id);
    $expNo = $item['expenseNumber'] ?? $item['expense_number'] ?? ($ex['expense_number'] ?? ('EXP-' . date('Y') . '-' . rand(100, 999)));
    $projectId = $item['projectId'] ?? $item['project_id'] ?? ($ex['project_id'] ?? '');
    $projectCode = $item['projectCode'] ?? $item['project_code'] ?? ($ex['project_code'] ?? '');
    $vendorName = $item['vendorName'] ?? $item['vendor'] ?? $item['vendor_name'] ?? ($ex['vendor_name'] ?? 'Vendor');
    $category = $item['category'] ?? ($ex['category'] ?? 'Miscellaneous');
    $amount = floatval($item['amount'] ?? ($ex['amount'] ?? 0));
    $rawExpDate = $item['expenseDate'] ?? $item['date'] ?? $item['expense_date'] ?? ($ex['expense_date'] ?? '');
    $expDate = !empty($rawExpDate) ? substr((string)$rawExpDate, 0, 10) : date('Y-m-d');
    $mode = $item['paymentMode'] ?? $item['paymentMethod'] ?? $item['payment_mode'] ?? ($ex['payment_mode'] ?? 'Bank Payment');
    $refNo = $item['referenceNo'] ?? $item['referenceNumber'] ?? $item['reference_no'] ?? ($ex['reference_no'] ?? '');
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');
    $receiptUrl = $item['receiptUrl'] ?? $item['receipt_url'] ?? ($ex['receipt_url'] ?? '');
    $approvedBy = $item['approvedBy'] ?? $item['approved_by'] ?? ($ex['approved_by'] ?? '');
    $expenseType = $item['expenseType'] ?? $item['expense_type'] ?? ($ex['expense_type'] ?? 'DIRECT_EXPENSE');
    $status = $item['status'] ?? ($ex['status'] ?? 'PAID');
    $employeeId = $item['employeeId'] ?? $item['employee_id'] ?? ($ex['employee_id'] ?? '');
    $employeeName = $item['employeeName'] ?? $item['employee_name'] ?? ($ex['employee_name'] ?? '');
    $gstAmount = floatval($item['gstAmount'] ?? $item['gst_amount'] ?? ($ex['gst_amount'] ?? 0));
    $itcEligible = (isset($item['itcEligible']) ? (bool)$item['itcEligible'] : !empty($ex['itc_eligible'])) ? 1 : 0;
    $bankAccountId = $item['bankAccountId'] ?? $item['bank_account_id'] ?? ($ex['bank_account_id'] ?? '');
    $expenseAccountId = $item['expenseAccountId'] ?? $item['expense_account_id'] ?? ($ex['expense_account_id'] ?? '');
    $journalEntryId = $item['journalEntryId'] ?? $item['journal_entry_id'] ?? ($ex['journal_entry_id'] ?? '');
    $approvedAt = $item['approvedAt'] ?? $item['approved_at'] ?? ($ex['approved_at'] ?? null);
    $rejectionReason = $item['rejectionReason'] ?? $item['rejection_reason'] ?? ($ex['rejection_reason'] ?? '');
    $paidAt = $item['paidAt'] ?? $item['paid_at'] ?? ($ex['paid_at'] ?? null);
    $paidBy = $item['paidBy'] ?? $item['paid_by'] ?? ($ex['paid_by'] ?? '');
    $tallyStatus = $item['tallySyncStatus'] ?? $item['tally_sync_status'] ?? ($ex['tally_sync_status'] ?? 'NOT SYNCED');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_expenses` (
            `id`, `expense_number`, `project_id`, `project_code`, `vendor_name`,
            `category`, `amount`, `expense_date`, `payment_mode`, `reference_no`,
            `notes`, `receipt_url`, `approved_by`,
            `expense_type`, `status`, `employee_id`, `employee_name`, `gst_amount`, `itc_eligible`,
            `bank_account_id`, `expense_account_id`, `journal_entry_id`, `approved_at`, `rejection_reason`, `paid_at`, `paid_by`,
            `tally_sync_status`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `project_id` = VALUES(`project_id`),
            `project_code` = VALUES(`project_code`),
            `vendor_name` = VALUES(`vendor_name`),
            `category` = VALUES(`category`),
            `amount` = VALUES(`amount`),
            `expense_date` = VALUES(`expense_date`),
            `payment_mode` = VALUES(`payment_mode`),
            `reference_no` = VALUES(`reference_no`),
            `notes` = VALUES(`notes`),
            `receipt_url` = VALUES(`receipt_url`),
            `approved_by` = VALUES(`approved_by`),
            `expense_type` = VALUES(`expense_type`),
            `status` = VALUES(`status`),
            `employee_id` = VALUES(`employee_id`),
            `employee_name` = VALUES(`employee_name`),
            `gst_amount` = VALUES(`gst_amount`),
            `itc_eligible` = VALUES(`itc_eligible`),
            `bank_account_id` = VALUES(`bank_account_id`),
            `expense_account_id` = VALUES(`expense_account_id`),
            `journal_entry_id` = VALUES(`journal_entry_id`),
            `approved_at` = VALUES(`approved_at`),
            `rejection_reason` = VALUES(`rejection_reason`),
            `paid_at` = VALUES(`paid_at`),
            `paid_by` = VALUES(`paid_by`),
            `tally_sync_status` = VALUES(`tally_sync_status`)
    ");
    $stmt->execute([
        $id, $expNo, $projectId, $projectCode, $vendorName,
        $category, $amount, $expDate, $mode, $refNo,
        $notes, $receiptUrl, $approvedBy,
        $expenseType, $status, $employeeId, $employeeName, $gstAmount, $itcEligible,
        $bankAccountId, $expenseAccountId, $journalEntryId, $approvedAt, $rejectionReason, $paidAt, $paidBy,
        $tallyStatus
    ]);
    return array_merge($item, [
        'id' => $id,
        'expenseNumber' => $expNo,
        'projectId' => $projectId,
        'projectCode' => $projectCode,
        'vendorName' => $vendorName,
        'category' => $category,
        'amount' => $amount,
        'expenseDate' => $expDate,
        'date' => $expDate,
        'paymentMode' => $mode,
        'referenceNo' => $refNo,
        'notes' => $notes,
        'receiptUrl' => $receiptUrl,
        'approvedBy' => $approvedBy,
        'expenseType' => $expenseType,
        'status' => $status,
        'employeeId' => $employeeId,
        'employeeName' => $employeeName,
        'gstAmount' => $gstAmount,
        'itcEligible' => (bool)$itcEligible,
        'bankAccountId' => $bankAccountId,
        'expenseAccountId' => $expenseAccountId,
        'journalEntryId' => $journalEntryId,
        'approvedAt' => $approvedAt ?? '',
        'rejectionReason' => $rejectionReason,
        'paidAt' => $paidAt ?? '',
        'paidBy' => $paidBy,
        'tallySyncStatus' => $tallyStatus
    ]);
}

function fetchExistingRowPhp($pdo, $table, $id) {
    if (empty($id)) return null;
    try {
        $s = $pdo->prepare("SELECT * FROM `$table` WHERE `id` = ? LIMIT 1");
        $s->execute([$id]);
        $r = $s->fetch(PDO::FETCH_ASSOC);
        return $r ?: null;
    } catch (Exception $e) {
        return null;
    }
}

// Helper: Products
function saveProductToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('prod-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_products', $id);
    $name = $item['name'] ?? ($ex['name'] ?? 'Solar Product');
    $sku = $item['sku'] ?? $item['itemCode'] ?? ($ex['sku'] ?? $id);
    $category = $item['category'] ?? ($ex['category'] ?? 'Solar Panels');
    $brand = $item['brand'] ?? ($ex['brand'] ?? '');
    $model = $item['model'] ?? ($ex['model'] ?? '');
    $specs = $item['specification'] ?? $item['specifications'] ?? ($ex['specifications'] ?? '');
    $unit = $item['unit'] ?? ($ex['unit'] ?? 'Nos');
    $hsnCode = $item['hsnCode'] ?? $item['hsn_code'] ?? ($ex['hsn_code'] ?? '');
    $providedGst = $item['gstRate'] ?? $item['taxRate'] ?? $item['gst_rate'] ?? $item['tax_rate'] ?? null;
    if ($providedGst !== null && trim((string)$providedGst) !== '') {
        if (!is_numeric($providedGst)) {
            throw new Exception('Invalid GST rate: must be a valid percentage between 0 and 100.');
        }
        $parsedGst = floatval($providedGst);
        if ($parsedGst < 0 || $parsedGst > 100) {
            throw new Exception('Invalid GST rate: must be a non-negative percentage between 0 and 100.');
        }
        $gstRate = round($parsedGst, 2);
    } else {
        $gstRate = isset($ex['gst_rate']) && $ex['gst_rate'] !== null ? floatval($ex['gst_rate']) : 18.0;
    }
    $rawPrice = $item['unitPrice'] ?? $item['unit_price'] ?? ($ex['unit_price'] ?? null);
    $unitPrice = $rawPrice !== null ? floatval($rawPrice) : 0.0;
    $rawSelling = $item['sellingPrice'] ?? $item['selling_price'] ?? ($ex['selling_price'] ?? null);
    $sellingPrice = $rawSelling !== null ? floatval($rawSelling) : $unitPrice;
    $rawStock = $item['currentStock'] ?? $item['current_stock'] ?? ($ex['current_stock'] ?? null);
    $currentStock = $rawStock !== null ? floatval($rawStock) : 0.0;
    $rawReorder = $item['minStockThreshold'] ?? $item['reorderLevel'] ?? $item['minStockLevel'] ?? $item['reorder_level'] ?? ($ex['reorder_level'] ?? null);
    $reorderLevel = $rawReorder !== null ? floatval($rawReorder) : 10.0;
    $warehouseId = $item['warehouseId'] ?? $item['warehouse_id'] ?? ($ex['warehouse_id'] ?? '');
    $warehouseName = $item['warehouseName'] ?? $item['warehouse_name'] ?? ($ex['warehouse_name'] ?? '');
    $location = $item['location'] ?? ($ex['location'] ?? $warehouseName);
    $prefVendorId = $item['preferredVendorId'] ?? $item['preferred_vendor_id'] ?? ($ex['preferred_vendor_id'] ?? '');
    $prefVendorName = $item['preferredVendorName'] ?? $item['preferred_vendor_name'] ?? ($ex['preferred_vendor_name'] ?? '');
    $exStocks = !empty($ex['warehouse_stocks_json']) ? (json_decode($ex['warehouse_stocks_json'], true) ?: []) : [];
    $warehouseStocks = (isset($item['warehouseStocks']) && is_array($item['warehouseStocks'])) ? $item['warehouseStocks'] : $exStocks;
    $warehouseStocksJson = json_encode(empty($warehouseStocks) ? new stdClass() : $warehouseStocks);
    $status = $item['status'] ?? ($ex['status'] ?? 'ACTIVE');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_products` (
            `id`, `name`, `sku`, `category`, `brand`, `model`,
            `specifications`, `unit`, `hsn_code`, `gst_rate`,
            `unit_price`, `selling_price`, `current_stock`, `reorder_level`,
            `location`, `warehouse_id`, `warehouse_name`, `warehouse_stocks_json`,
            `preferred_vendor_id`, `preferred_vendor_name`, `status`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `name` = VALUES(`name`),
            `sku` = VALUES(`sku`),
            `category` = VALUES(`category`),
            `brand` = VALUES(`brand`),
            `model` = VALUES(`model`),
            `specifications` = VALUES(`specifications`),
            `unit` = VALUES(`unit`),
            `hsn_code` = VALUES(`hsn_code`),
            `gst_rate` = VALUES(`gst_rate`),
            `unit_price` = VALUES(`unit_price`),
            `selling_price` = VALUES(`selling_price`),
            `current_stock` = VALUES(`current_stock`),
            `reorder_level` = VALUES(`reorder_level`),
            `location` = VALUES(`location`),
            `warehouse_id` = VALUES(`warehouse_id`),
            `warehouse_name` = VALUES(`warehouse_name`),
            `warehouse_stocks_json` = VALUES(`warehouse_stocks_json`),
            `preferred_vendor_id` = VALUES(`preferred_vendor_id`),
            `preferred_vendor_name` = VALUES(`preferred_vendor_name`),
            `status` = VALUES(`status`)
    ");
    $stmt->execute([
        $id, $name, $sku, $category, $brand, $model,
        $specs, $unit, $hsnCode, $gstRate,
        $unitPrice, $sellingPrice, $currentStock, $reorderLevel,
        $location, $warehouseId, $warehouseName, $warehouseStocksJson,
        $prefVendorId, $prefVendorName, $status
    ]);

    return array_merge($item, [
        'id' => $id,
        'name' => $name,
        'sku' => $sku,
        'itemCode' => $sku,
        'category' => $category,
        'brand' => $brand,
        'model' => $model,
        'specifications' => $specs,
        'specification' => $specs,
        'unit' => $unit,
        'hsnCode' => $hsnCode,
        'gstRate' => $gstRate,
        'taxRate' => $gstRate,
        'unitPrice' => $unitPrice,
        'sellingPrice' => $sellingPrice,
        'currentStock' => $currentStock,
        'reorderLevel' => $reorderLevel,
        'minStockLevel' => $reorderLevel,
        'minStockThreshold' => $reorderLevel,
        'location' => $location,
        'warehouseId' => $warehouseId,
        'warehouseName' => $warehouseName,
        'warehouseStocks' => $warehouseStocks,
        'preferredVendorId' => $prefVendorId,
        'preferredVendorName' => $prefVendorName,
        'status' => $status,
        'createdAt' => $item['createdAt'] ?? ($ex['created_at'] ?? date('c')),
        'updatedAt' => date('c')
    ]);
}

// Helper: Vendors
function saveVendorToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('ven-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_vendors', $id);
    $name = $item['name'] ?? ($ex['name'] ?? 'Vendor');
    $code = $item['vendorCode'] ?? $item['vendor_code'] ?? ($ex['vendor_code'] ?? $id);
    $contact = $item['contactPerson'] ?? $item['contact_person'] ?? ($ex['contact_person'] ?? '');
    $phone = $item['phone'] ?? ($ex['phone'] ?? '');
    $email = $item['email'] ?? ($ex['email'] ?? '');
    $address = $item['address'] ?? ($ex['address'] ?? '');
    $city = $item['city'] ?? ($ex['city'] ?? '');
    $state = $item['state'] ?? ($ex['state'] ?? '');
    $gst = $item['gstNumber'] ?? $item['gst_number'] ?? ($ex['gst_number'] ?? '');
    $pan = $item['panNumber'] ?? $item['pan_number'] ?? ($ex['pan_number'] ?? '');
    $terms = $item['paymentTerms'] ?? $item['payment_terms'] ?? ($ex['payment_terms'] ?? '30 Days');
    $rating = isset($item['rating']) ? floatval($item['rating']) : floatval($ex['rating'] ?? 4.5);

    $exCats = !empty($ex['categories_json']) ? (json_decode($ex['categories_json'], true) ?: []) : [];
    if (!empty($item['categories']) && is_array($item['categories'])) {
        $cats = array_values(array_filter(array_map(function($c) { return trim((string)$c); }, $item['categories'])));
    } elseif (!empty($item['category'])) {
        $cats = [trim((string)$item['category'])];
    } elseif (!empty($item['categoriesJson']) && is_string($item['categoriesJson'])) {
        $cats = json_decode($item['categoriesJson'], true) ?: [];
    } else {
        $cats = $exCats;
    }
    if (empty($cats)) $cats = ['Solar Modules'];
    if (!empty($item['category']) && !in_array(trim((string)$item['category']), $cats, true)) {
        array_unshift($cats, trim((string)$item['category']));
    }
    $category = $item['category'] ?? ($cats[0] ?? 'Solar Modules');
    $catsJson = json_encode($cats);

    $exBank = !empty($ex['bank_details_json']) ? json_decode($ex['bank_details_json'], true) : null;
    $bankDetails = array_key_exists('bankDetails', $item) ? $item['bankDetails'] : $exBank;
    $bankJson = $bankDetails ? (is_string($bankDetails) ? $bankDetails : json_encode($bankDetails)) : null;
    $status = $item['status'] ?? ($ex['status'] ?? 'ACTIVE');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_vendors` (
            `id`, `name`, `vendor_code`, `contact_person`, `phone`, `email`,
            `address`, `city`, `state`, `gst_number`, `pan_number`,
            `payment_terms`, `rating`, `categories_json`, `bank_details_json`, `status`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `name` = VALUES(`name`),
            `vendor_code` = VALUES(`vendor_code`),
            `contact_person` = VALUES(`contact_person`),
            `phone` = VALUES(`phone`),
            `email` = VALUES(`email`),
            `address` = VALUES(`address`),
            `city` = VALUES(`city`),
            `state` = VALUES(`state`),
            `gst_number` = VALUES(`gst_number`),
            `pan_number` = VALUES(`pan_number`),
            `payment_terms` = VALUES(`payment_terms`),
            `rating` = VALUES(`rating`),
            `categories_json` = VALUES(`categories_json`),
            `bank_details_json` = VALUES(`bank_details_json`),
            `status` = VALUES(`status`)
    ");
    $stmt->execute([
        $id, $name, $code, $contact, $phone, $email,
        $address, $city, $state, $gst, $pan,
        $terms, $rating, $catsJson, $bankJson, $status
    ]);

    return array_merge($item, [
        'id' => $id,
        'name' => $name,
        'vendorCode' => $code,
        'contactPerson' => $contact,
        'phone' => $phone,
        'email' => $email,
        'address' => $address,
        'city' => $city,
        'state' => $state,
        'gstNumber' => $gst,
        'panNumber' => $pan,
        'paymentTerms' => $terms,
        'rating' => $rating,
        'category' => $category,
        'categories' => $cats,
        'bankDetails' => $bankDetails,
        'status' => $status,
        'createdAt' => $item['createdAt'] ?? ($ex['created_at'] ?? date('c')),
        'updatedAt' => date('c')
    ]);
}

// Helper: Purchase Orders
function savePurchaseOrderToDb($pdo, $item, $actor = null) {
    $id = !empty($item['id']) ? $item['id'] : ('po-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_purchase_orders', $id);
    $poNumber = $item['purchaseNumber'] ?? $item['poNumber'] ?? $item['po_number'] ?? ($ex['po_number'] ?? $id);
    $vendorId = $item['vendorId'] ?? $item['vendor_id'] ?? ($ex['vendor_id'] ?? '');
    $vendorName = $item['vendorName'] ?? $item['vendor_name'] ?? ($ex['vendor_name'] ?? 'Vendor');
    $rawPoDate = $item['purchaseDate'] ?? $item['poDate'] ?? $item['orderDate'] ?? $item['po_date'] ?? ($ex['po_date'] ?? null);
    $poDate = !empty($rawPoDate) ? substr((string)$rawPoDate, 0, 10) : date('Y-m-d');
    $rawExp = $item['expectedDeliveryDate'] ?? $item['expected_delivery_date'] ?? ($ex['expected_delivery_date'] ?? null);
    $expDate = !empty($rawExp) ? substr((string)$rawExp, 0, 10) : null;
    $projectId = $item['projectId'] ?? $item['project_id'] ?? ($ex['project_id'] ?? '');
    $projectTitle = $item['projectTitle'] ?? $item['project_title'] ?? ($ex['project_title'] ?? '');
    $warehouseId = $item['warehouseId'] ?? $item['warehouse_id'] ?? ($ex['warehouse_id'] ?? '');
    $warehouseName = $item['warehouseName'] ?? $item['warehouse_name'] ?? ($ex['warehouse_name'] ?? '');
    $rawPayDue = $item['paymentDueDate'] ?? $item['payment_due_date'] ?? ($ex['payment_due_date'] ?? null);
    $payDueDate = !empty($rawPayDue) ? substr((string)$rawPayDue, 0, 10) : null;
    $invoiceRef = $item['invoiceReference'] ?? $item['invoice_reference'] ?? ($ex['invoice_reference'] ?? '');
    $stockUpdated = (isset($item['stockUpdated']) ? (bool)$item['stockUpdated'] : (bool)($ex['stock_updated'] ?? 0)) ? 1 : 0;
    $rawRecDate = $item['receivedDate'] ?? $item['received_date'] ?? ($ex['received_date'] ?? null);
    $receivedDate = !empty($rawRecDate) ? substr((string)$rawRecDate, 0, 10) : null;
    $items = $item['items'] ?? (!empty($ex['items_json']) ? json_decode($ex['items_json'], true) : []);
    $itemsArr = is_string($items) ? (json_decode($items, true) ?: []) : $items;
    $itemsJson = is_string($items) ? $items : json_encode($items);
    $subtotal = round(floatval($item['subtotal'] ?? ($ex['subtotal'] ?? 0)), 2);
    $gstAmount = round(floatval($item['taxAmount'] ?? $item['gstAmount'] ?? $item['gst_amount'] ?? ($ex['gst_amount'] ?? 0)), 2);
    $totalAmount = round(floatval($item['totalAmount'] ?? $item['grandTotal'] ?? $item['total_amount'] ?? ($ex['total_amount'] ?? ($subtotal + $gstAmount))), 2);
    $status = $item['status'] ?? ($ex['status'] ?? 'ISSUED');
    $returnedAmount = round(floatval($ex['returned_amount'] ?? ($item['returnedAmount'] ?? 0)), 2);
    $refundedAmount = round(floatval($ex['refunded_amount'] ?? ($item['refundedAmount'] ?? 0)), 2);
    $existingPaid = round(floatval($ex['paid_amount'] ?? 0), 2);
    $requestedPayStatus = strtoupper(trim((string)($item['paymentStatus'] ?? ($item['payment_status'] ?? ($ex['payment_status'] ?? 'PENDING')))));
    $rawReqPaid = floatval($item['paidAmount'] ?? ($requestedPayStatus === 'PAID' ? $totalAmount : 0));
    $initialPayToRecord = (!$ex && strtoupper($status) !== 'CANCELLED' && strtoupper($status) !== 'DRAFT' && $rawReqPaid > 0.01)
        ? round(min($totalAmount, $rawReqPaid), 2)
        : 0.0;
    $storedPaid = $ex ? $existingPaid : 0.0;
    $netPaid = round(max(0.0, $storedPaid - $refundedAmount), 2);
    $balanceAmount = round(max(0.0, $totalAmount - $returnedAmount - $netPaid), 2);
    $paymentStatus = ($totalAmount > 0 && $balanceAmount <= 0.01)
        ? 'PAID'
        : ($netPaid > 0.01 ? 'PARTIALLY_PAID' : 'PENDING');
    $bankAccountId = trim((string)($item['bankAccountId'] ?? ($ex['bank_account_id'] ?? '')));
    $receipts = $item['deliveryReceipts'] ?? $item['receipts'] ?? (!empty($ex['receipts_json']) ? json_decode($ex['receipts_json'], true) : []);
    $receiptsArr = is_string($receipts) ? (json_decode($receipts, true) ?: []) : $receipts;
    $receiptsJson = is_string($receipts) ? $receipts : json_encode($receipts);
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');

    if (array_key_exists('vendorBills', $item) && is_array($item['vendorBills'])) {
        $vendorBills = array_values(array_filter($item['vendorBills'], function($b) {
            return is_array($b) && !empty($b['fileUrl']);
        }));
    } elseif (!empty($ex['vendor_bills_json'])) {
        $vendorBills = json_decode((string)$ex['vendor_bills_json'], true);
        if (!is_array($vendorBills)) $vendorBills = [];
    } else {
        $vendorBills = [];
    }
    if (empty($vendorBills) && !empty($item['vendorBillUrl'])) {
        $vendorBills[] = [
            'id' => 'bill-primary-' . preg_replace('/[^a-zA-Z0-9_-]/', '', $id),
            'fileName' => (string)($item['vendorBillName'] ?? 'Vendor Bill'),
            'fileUrl' => (string)$item['vendorBillUrl'],
            'filePath' => '',
            'mimeType' => (string)($item['vendorBillMimeType'] ?? 'application/pdf'),
            'fileSize' => intval($item['vendorBillSize'] ?? 0),
            'uploadedAt' => (string)($item['vendorBillUploadedAt'] ?? date('c')),
            'uploadedBy' => (string)($actor['name'] ?? '')
        ];
    }
    $primaryBill = $vendorBills[0] ?? null;
    $vendorBillsJson = json_encode($vendorBills);
    $vendorBillUrl = $primaryBill ? (string)$primaryBill['fileUrl'] : (array_key_exists('vendorBills', $item) ? '' : (string)($ex['vendor_bill_url'] ?? ''));
    $vendorBillName = $primaryBill ? (string)$primaryBill['fileName'] : (array_key_exists('vendorBills', $item) ? '' : (string)($ex['vendor_bill_name'] ?? ''));
    $vendorBillMime = $primaryBill ? (string)$primaryBill['mimeType'] : (array_key_exists('vendorBills', $item) ? '' : (string)($ex['vendor_bill_mime'] ?? ''));
    $vendorBillSize = $primaryBill ? intval($primaryBill['fileSize'] ?? 0) : (array_key_exists('vendorBills', $item) ? 0 : intval($ex['vendor_bill_size'] ?? 0));
    $vendorBillUploadedAt = $primaryBill ? (string)($primaryBill['uploadedAt'] ?? '') : (array_key_exists('vendorBills', $item) ? '' : (string)($ex['vendor_bill_uploaded_at'] ?? ''));

    $stmt = $pdo->prepare("
        INSERT INTO `solar_purchase_orders` (
            `id`, `po_number`, `vendor_id`, `vendor_name`, `po_date`,
            `expected_delivery_date`, `project_id`, `project_title`,
            `warehouse_id`, `warehouse_name`, `payment_due_date`,
            `invoice_reference`, `stock_updated`, `received_date`,
            `items_json`, `subtotal`, `gst_amount`, `total_amount`,
            `paid_amount`, `returned_amount`, `refunded_amount`, `balance_amount`, `bank_account_id`,
            `status`, `payment_status`, `receipts_json`,
            `vendor_bills_json`, `vendor_bill_url`, `vendor_bill_name`, `vendor_bill_mime`, `vendor_bill_size`, `vendor_bill_uploaded_at`,
            `notes`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `po_number` = VALUES(`po_number`),
            `vendor_id` = VALUES(`vendor_id`),
            `vendor_name` = VALUES(`vendor_name`),
            `po_date` = VALUES(`po_date`),
            `expected_delivery_date` = VALUES(`expected_delivery_date`),
            `project_id` = VALUES(`project_id`),
            `project_title` = VALUES(`project_title`),
            `warehouse_id` = VALUES(`warehouse_id`),
            `warehouse_name` = VALUES(`warehouse_name`),
            `payment_due_date` = VALUES(`payment_due_date`),
            `invoice_reference` = VALUES(`invoice_reference`),
            `stock_updated` = VALUES(`stock_updated`),
            `received_date` = VALUES(`received_date`),
            `subtotal` = VALUES(`subtotal`),
            `gst_amount` = VALUES(`gst_amount`),
            `total_amount` = VALUES(`total_amount`),
            `paid_amount` = VALUES(`paid_amount`),
            `returned_amount` = VALUES(`returned_amount`),
            `refunded_amount` = VALUES(`refunded_amount`),
            `balance_amount` = VALUES(`balance_amount`),
            `bank_account_id` = VALUES(`bank_account_id`),
            `status` = VALUES(`status`),
            `payment_status` = VALUES(`payment_status`),
            `items_json` = VALUES(`items_json`),
            `receipts_json` = VALUES(`receipts_json`),
            `vendor_bills_json` = VALUES(`vendor_bills_json`),
            `vendor_bill_url` = VALUES(`vendor_bill_url`),
            `vendor_bill_name` = VALUES(`vendor_bill_name`),
            `vendor_bill_mime` = VALUES(`vendor_bill_mime`),
            `vendor_bill_size` = VALUES(`vendor_bill_size`),
            `vendor_bill_uploaded_at` = VALUES(`vendor_bill_uploaded_at`),
            `notes` = VALUES(`notes`)
    ");
    $stmt->execute([
        $id, $poNumber, $vendorId, $vendorName, $poDate,
        $expDate, $projectId, $projectTitle,
        $warehouseId, $warehouseName, $payDueDate,
        $invoiceRef, $stockUpdated, $receivedDate,
        $itemsJson, $subtotal, $gstAmount, $totalAmount,
        $storedPaid, $returnedAmount, $refundedAmount, $balanceAmount, $bankAccountId,
        $status, $paymentStatus, $receiptsJson,
        $vendorBillsJson, $vendorBillUrl, $vendorBillName, $vendorBillMime, $vendorBillSize, $vendorBillUploadedAt,
        $notes
    ]);

    if ($initialPayToRecord > 0.01) {
        require_once __DIR__ . '/accounting.php';
        $effectiveBankId = accResolveBankAccountIdOrPrimaryPhp($pdo, $bankAccountId, $item['paymentMode'] ?? '');
        if ($effectiveBankId === '') {
            throw new Exception('Please configure or select an active Cash/Bank account to record this PO payment.', 400);
        }
        $payRes = accRecordPurchaseOrderPaymentPhp($pdo, $id, [
            'amount' => $initialPayToRecord,
            'tdsDeducted' => floatval($item['tdsDeducted'] ?? 0),
            'tdsSection' => $item['tdsSection'] ?? '194C',
            'paymentDate' => $poDate,
            'paymentMode' => $item['paymentMode'] ?? 'Bank NEFT/RTGS',
            'bankAccountId' => $effectiveBankId,
            'referenceNo' => $item['referenceNo'] ?? '',
            'notes' => 'Initial payment recorded on Purchase Order creation'
        ], $actor);
        $storedPaid = floatval($payRes['paidAmount'] ?? $storedPaid);
        $balanceAmount = floatval($payRes['balanceAmount'] ?? $balanceAmount);
        $paymentStatus = $payRes['paymentStatus'] ?? $paymentStatus;
        $bankAccountId = $payRes['bankAccountId'] ?? $effectiveBankId;
    }

    $bankMap = getBankAccountNameMapPhp($pdo);
    return array_merge($item, [
        'id' => $id,
        'purchaseNumber' => $poNumber,
        'poNumber' => $poNumber,
        'vendorId' => $vendorId,
        'vendorName' => $vendorName,
        'purchaseDate' => $poDate,
        'orderDate' => $poDate,
        'poDate' => $poDate,
        'expectedDeliveryDate' => $expDate ?? '',
        'projectId' => $projectId,
        'projectTitle' => $projectTitle,
        'warehouseId' => $warehouseId,
        'warehouseName' => $warehouseName,
        'paymentDueDate' => $payDueDate,
        'invoiceReference' => $invoiceRef,
        'stockUpdated' => (bool)$stockUpdated,
        'receivedDate' => $receivedDate,
        'items' => $itemsArr,
        'subtotal' => $subtotal,
        'taxAmount' => $gstAmount,
        'gstAmount' => $gstAmount,
        'totalAmount' => $totalAmount,
        'grandTotal' => $totalAmount,
        'paidAmount' => $storedPaid,
        'returnedAmount' => $returnedAmount,
        'refundedAmount' => $refundedAmount,
        'balanceAmount' => $balanceAmount,
        'bankAccountId' => $bankAccountId,
        'bankAccountName' => $bankAccountId !== '' ? ($bankMap[$bankAccountId] ?? '') : '',
        'status' => $status,
        'paymentStatus' => $paymentStatus,
        'deliveryReceipts' => $receiptsArr,
        'receipts' => $receiptsArr,
        'vendorBills' => $vendorBills,
        'vendorBillUrl' => $vendorBillUrl,
        'vendorBillName' => $vendorBillName,
        'vendorBillMimeType' => $vendorBillMime,
        'vendorBillSize' => $vendorBillSize,
        'vendorBillUploadedAt' => $vendorBillUploadedAt,
        'notes' => $notes,
        'createdAt' => $item['createdAt'] ?? ($ex['created_at'] ?? date('c')),
        'updatedAt' => date('c')
    ]);
}

// Helper: BOMs
function saveBOMToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('bom-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_boms', $id);
    $bomNumber = $item['bomNumber'] ?? $item['bom_number'] ?? ($ex['bom_number'] ?? $id);
    $projectId = $item['projectId'] ?? $item['project_id'] ?? ($ex['project_id'] ?? '');
    $projectCode = $item['projectCode'] ?? $item['project_code'] ?? ($ex['project_code'] ?? '');
    $projectTitle = $item['projectTitle'] ?? $item['project_title'] ?? ($ex['project_title'] ?? 'Solar Project Installation');
    $customerName = $item['customerName'] ?? $item['customer_name'] ?? ($ex['customer_name'] ?? '');
    $capacityKw = floatval($item['capacityKw'] ?? $item['systemCapacityKw'] ?? $item['system_capacity_kw'] ?? ($ex['system_capacity_kw'] ?? 0));
    $version = $item['version'] ?? ($ex['version'] ?? '1.0');
    $status = $item['status'] ?? ($ex['status'] ?? 'APPROVED');
    $warehouseId = $item['warehouseId'] ?? $item['warehouse_id'] ?? ($ex['warehouse_id'] ?? '');
    $warehouseName = $item['warehouseName'] ?? $item['warehouse_name'] ?? ($ex['warehouse_name'] ?? '');
    $stockAllocated = (isset($item['stockAllocated']) ? (bool)$item['stockAllocated'] : (bool)($ex['stock_allocated'] ?? 0)) ? 1 : 0;
    $ewayBillNumber = $item['ewayBillNumber'] ?? $item['eway_bill_number'] ?? ($ex['eway_bill_number'] ?? '');
    $ewayBillDate = $item['ewayBillDate'] ?? $item['eway_bill_date'] ?? ($ex['eway_bill_date'] ?? '');
    $items = $item['items'] ?? (!empty($ex['items_json']) ? json_decode($ex['items_json'], true) : []);
    $itemsArr = is_string($items) ? (json_decode($items, true) ?: []) : $items;
    $itemsJson = is_string($items) ? $items : json_encode($items);
    $totalCost = floatval($item['totalCost'] ?? $item['totalEstimatedCost'] ?? $item['total_estimated_cost'] ?? ($ex['total_estimated_cost'] ?? 0));
    $createdBy = $item['createdBy'] ?? $item['created_by'] ?? ($ex['created_by'] ?? '');
    $approvedBy = $item['approvedBy'] ?? $item['approved_by'] ?? ($ex['approved_by'] ?? '');
    $rawApprovedAt = $item['approvedAt'] ?? ($ex['approved_at'] ?? null);
    $approvedAt = !empty($rawApprovedAt) ? date('Y-m-d H:i:s', strtotime($rawApprovedAt)) : null;
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_boms` (
            `id`, `bom_number`, `project_id`, `project_code`, `project_title`, `customer_name`,
            `system_capacity_kw`, `version`, `status`, `warehouse_id`, `warehouse_name`,
            `stock_allocated`, `eway_bill_number`, `eway_bill_date`,
            `items_json`, `total_estimated_cost`, `created_by`, `approved_by`, `approved_at`, `notes`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `bom_number` = VALUES(`bom_number`),
            `project_id` = VALUES(`project_id`),
            `project_code` = VALUES(`project_code`),
            `project_title` = VALUES(`project_title`),
            `customer_name` = VALUES(`customer_name`),
            `system_capacity_kw` = VALUES(`system_capacity_kw`),
            `version` = VALUES(`version`),
            `status` = VALUES(`status`),
            `warehouse_id` = VALUES(`warehouse_id`),
            `warehouse_name` = VALUES(`warehouse_name`),
            `stock_allocated` = VALUES(`stock_allocated`),
            `eway_bill_number` = VALUES(`eway_bill_number`),
            `eway_bill_date` = VALUES(`eway_bill_date`),
            `items_json` = VALUES(`items_json`),
            `total_estimated_cost` = VALUES(`total_estimated_cost`),
            `approved_by` = VALUES(`approved_by`),
            `approved_at` = VALUES(`approved_at`),
            `notes` = VALUES(`notes`)
    ");
    $stmt->execute([
        $id, $bomNumber, $projectId, $projectCode, $projectTitle, $customerName,
        $capacityKw, $version, $status, $warehouseId, $warehouseName,
        $stockAllocated, $ewayBillNumber, $ewayBillDate,
        $itemsJson, $totalCost, $createdBy, $approvedBy, $approvedAt, $notes
    ]);

    return array_merge($item, [
        'id' => $id,
        'bomNumber' => $bomNumber,
        'projectId' => $projectId,
        'projectCode' => $projectCode,
        'projectTitle' => $projectTitle,
        'customerName' => $customerName,
        'capacityKw' => $capacityKw,
        'systemCapacityKw' => $capacityKw,
        'version' => $version,
        'status' => $status,
        'warehouseId' => $warehouseId,
        'warehouseName' => $warehouseName,
        'stockAllocated' => (bool)$stockAllocated,
        'ewayBillNumber' => $ewayBillNumber,
        'ewayBillDate' => $ewayBillDate,
        'items' => $itemsArr,
        'totalCost' => $totalCost,
        'totalEstimatedCost' => $totalCost,
        'createdBy' => $createdBy,
        'approvedBy' => $approvedBy,
        'approvedAt' => $rawApprovedAt,
        'notes' => $notes,
        'createdAt' => $item['createdAt'] ?? ($ex['created_at'] ?? date('c')),
        'updatedAt' => date('c')
    ]);
}

// Helper: Sales Invoices
function saveSalesInvoiceToDb($pdo, $item, $actor = null) {
    $id = !empty($item['id']) ? $item['id'] : ('inv-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_sales_invoices', $id);
    $invNumber = $item['invoiceNumber'] ?? $item['invoice_number'] ?? ($ex['invoice_number'] ?? $id);
    $invType = $item['invoiceType'] ?? $item['invoice_type'] ?? ($ex['invoice_type'] ?? 'TAX_INVOICE');
    $projectId = $item['projectId'] ?? $item['project_id'] ?? ($ex['project_id'] ?? '');
    $projectTitle = $item['projectTitle'] ?? $item['project_title'] ?? ($ex['project_title'] ?? '');
    $customerId = $item['customerId'] ?? $item['customer_id'] ?? ($ex['customer_id'] ?? '');
    $customerName = $item['customerName'] ?? $item['customer_name'] ?? ($ex['customer_name'] ?? 'Customer');
    $customerGst = $item['customerGst'] ?? $item['customer_gst'] ?? ($ex['customer_gst'] ?? '');
    $customerAddr = $item['customerAddress'] ?? $item['customer_address'] ?? ($ex['customer_address'] ?? '');
    $rawInvDate = $item['invoiceDate'] ?? $item['invoice_date'] ?? ($ex['invoice_date'] ?? null);
    $invDate = !empty($rawInvDate) ? substr((string)$rawInvDate, 0, 10) : date('Y-m-d');
    $rawDueDate = $item['dueDate'] ?? $item['due_date'] ?? ($ex['due_date'] ?? null);
    $dueDate = !empty($rawDueDate) ? substr((string)$rawDueDate, 0, 10) : null;
    $paymentTerms = $item['paymentTerms'] ?? $item['payment_terms'] ?? ($ex['payment_terms'] ?? '15 Days Net');
    $items = $item['items'] ?? (!empty($ex['items_json']) ? json_decode($ex['items_json'], true) : []);
    $itemsArr = is_string($items) ? (json_decode($items, true) ?: []) : $items;
    $itemsJson = is_string($items) ? $items : json_encode($items);
    $subtotal = round(floatval($item['subtotal'] ?? ($ex['subtotal'] ?? 0)), 2);
    $gstAmount = round(floatval($item['taxAmount'] ?? $item['gstAmount'] ?? $item['gst_amount'] ?? ($ex['gst_amount'] ?? 0)), 2);
    $hasTotalKey = array_key_exists('totalAmount', $item) || array_key_exists('grandTotal', $item) || array_key_exists('total_amount', $item);
    $hasSubtotalOrTaxKey = array_key_exists('subtotal', $item) || array_key_exists('taxAmount', $item) || array_key_exists('gstAmount', $item);
    $totalAmount = round(
        $hasTotalKey
            ? floatval($item['totalAmount'] ?? $item['grandTotal'] ?? $item['total_amount'] ?? 0)
            : ($hasSubtotalOrTaxKey ? ($subtotal + $gstAmount) : floatval($ex['total_amount'] ?? ($subtotal + $gstAmount))),
        2
    );
    $returnedAmount = round(floatval($ex['returned_amount'] ?? ($item['returnedAmount'] ?? 0)), 2);
    $refundedAmount = round(floatval($ex['refunded_amount'] ?? ($item['refundedAmount'] ?? 0)), 2);
    $bankAccountId = trim((string)($item['bankAccountId'] ?? ($ex['bank_account_id'] ?? '')));
    $requestedStatus = strtoupper(trim((string)($item['status'] ?? ($item['paymentStatus'] ?? ($item['payment_status'] ?? ($ex['payment_status'] ?? 'ISSUED'))))));
    $existingPaid = round(floatval($ex['paid_amount'] ?? 0), 2);
    $rawReqPaid = floatval($item['amountPaid'] ?? ($item['paidAmount'] ?? ($item['paid_amount'] ?? ($requestedStatus === 'PAID' ? $totalAmount : $existingPaid))));
    $requestedPaid = in_array($requestedStatus, ['DRAFT', 'CANCELLED'], true)
        ? $existingPaid
        : round(min($totalAmount, $rawReqPaid), 2);
    $netExistingPaid = round(max(0.0, $existingPaid - $refundedAmount), 2);
    $maxPayableRemaining = round(max(0.0, $totalAmount - $returnedAmount - $netExistingPaid), 2);
    $paymentDelta = (!in_array($requestedStatus, ['DRAFT', 'CANCELLED'], true) && $requestedPaid > $existingPaid + 0.01)
        ? round(min($maxPayableRemaining, $requestedPaid - $existingPaid), 2)
        : 0.0;

    $storedPaid = $existingPaid;
    $storedBalance = round(max(0.0, $totalAmount - $returnedAmount - $netExistingPaid), 2);
    $baseStatus = in_array($requestedStatus, ['DRAFT', 'CANCELLED'], true)
        ? $requestedStatus
        : (($totalAmount > 0 && $storedBalance <= 0.01) ? 'PAID' : ($netExistingPaid > 0.01 ? 'PARTIAL' : 'ISSUED'));
    $status = $baseStatus;
    $ewayBill = $item['ewayBillNumber'] ?? $item['eway_bill_number'] ?? ($ex['eway_bill_number'] ?? '');
    $ewayDetails = array_key_exists('ewayBillDetails', $item) ? $item['ewayBillDetails'] : (!empty($ex['eway_bill_details_json']) ? json_decode($ex['eway_bill_details_json'], true) : null);
    $ewayDetailsJson = $ewayDetails ? (is_string($ewayDetails) ? $ewayDetails : json_encode($ewayDetails)) : null;
    $warehouseId = $item['warehouseId'] ?? $item['warehouse_id'] ?? ($ex['warehouse_id'] ?? '');
    $deductStock = (isset($item['deductStock']) ? (bool)$item['deductStock'] : (bool)($ex['deduct_stock'] ?? 1)) ? 1 : 0;
    $stockDeducted = (isset($item['stockDeducted']) ? (bool)$item['stockDeducted'] : (bool)($ex['stock_deducted'] ?? 0)) ? 1 : 0;
    $hasExplicitTaxSplit = array_key_exists('cgstAmount', $item) || array_key_exists('cgst_amount', $item)
        || array_key_exists('sgstAmount', $item) || array_key_exists('sgst_amount', $item)
        || array_key_exists('igstAmount', $item) || array_key_exists('igst_amount', $item);
    $existingIgst = floatval($ex['igst_amount'] ?? 0);
    $igstAmount = round(floatval($item['igstAmount'] ?? $item['igst_amount'] ?? (!$hasExplicitTaxSplit && $existingIgst > 0 ? $gstAmount : $existingIgst)), 2);
    $defaultHalfCgst = $igstAmount > 0 ? 0.0 : round($gstAmount / 2.0, 2);
    $defaultHalfSgst = $igstAmount > 0 ? 0.0 : round($gstAmount - $defaultHalfCgst, 2);
    $cgstAmount = round(floatval($item['cgstAmount'] ?? $item['cgst_amount'] ?? (!$hasExplicitTaxSplit ? $defaultHalfCgst : ($ex['cgst_amount'] ?? $defaultHalfCgst))), 2);
    $sgstAmount = round(floatval($item['sgstAmount'] ?? $item['sgst_amount'] ?? (!$hasExplicitTaxSplit ? $defaultHalfSgst : ($ex['sgst_amount'] ?? $defaultHalfSgst))), 2);
    $einvoiceIrn = $item['einvoiceIrn'] ?? $item['einvoice_irn'] ?? ($ex['einvoice_irn'] ?? '');
    $einvoiceAckNo = $item['einvoiceAckNo'] ?? $item['einvoice_ack_no'] ?? ($ex['einvoice_ack_no'] ?? '');
    $einvoiceAckDate = $item['einvoiceAckDate'] ?? $item['einvoice_ack_date'] ?? ($ex['einvoice_ack_date'] ?? '');
    $einvoiceStatus = $item['einvoiceStatus'] ?? $item['einvoice_status'] ?? ($ex['einvoice_status'] ?? 'NOT_GENERATED');
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_sales_invoices` (
            `id`, `invoice_number`, `invoice_type`, `project_id`, `project_title`,
            `customer_id`, `customer_name`, `customer_gst`, `customer_address`,
            `invoice_date`, `due_date`, `payment_terms`, `items_json`, `subtotal`, `gst_amount`,
            `cgst_amount`, `sgst_amount`, `igst_amount`,
            `einvoice_irn`, `einvoice_ack_no`, `einvoice_ack_date`, `einvoice_status`,
            `total_amount`, `payment_status`, `paid_amount`, `returned_amount`, `refunded_amount`, `balance_amount`, `bank_account_id`,
            `eway_bill_number`, `eway_bill_details_json`, `warehouse_id`, `deduct_stock`, `stock_deducted`, `notes`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `invoice_type` = VALUES(`invoice_type`),
            `project_id` = VALUES(`project_id`),
            `project_title` = VALUES(`project_title`),
            `customer_id` = VALUES(`customer_id`),
            `customer_name` = VALUES(`customer_name`),
            `customer_gst` = VALUES(`customer_gst`),
            `customer_address` = VALUES(`customer_address`),
            `invoice_date` = VALUES(`invoice_date`),
            `due_date` = VALUES(`due_date`),
            `payment_terms` = VALUES(`payment_terms`),
            `items_json` = VALUES(`items_json`),
            `subtotal` = VALUES(`subtotal`),
            `gst_amount` = VALUES(`gst_amount`),
            `cgst_amount` = VALUES(`cgst_amount`),
            `sgst_amount` = VALUES(`sgst_amount`),
            `igst_amount` = VALUES(`igst_amount`),
            `einvoice_irn` = VALUES(`einvoice_irn`),
            `einvoice_ack_no` = VALUES(`einvoice_ack_no`),
            `einvoice_ack_date` = VALUES(`einvoice_ack_date`),
            `einvoice_status` = VALUES(`einvoice_status`),
            `total_amount` = VALUES(`total_amount`),
            `payment_status` = VALUES(`payment_status`),
            `paid_amount` = VALUES(`paid_amount`),
            `returned_amount` = VALUES(`returned_amount`),
            `refunded_amount` = VALUES(`refunded_amount`),
            `balance_amount` = VALUES(`balance_amount`),
            `bank_account_id` = VALUES(`bank_account_id`),
            `eway_bill_number` = VALUES(`eway_bill_number`),
            `eway_bill_details_json` = VALUES(`eway_bill_details_json`),
            `warehouse_id` = VALUES(`warehouse_id`),
            `deduct_stock` = VALUES(`deduct_stock`),
            `stock_deducted` = VALUES(`stock_deducted`),
            `notes` = VALUES(`notes`)
    ");
    $stmt->execute([
        $id, $invNumber, $invType, $projectId, $projectTitle,
        $customerId, $customerName, $customerGst, $customerAddr,
        $invDate, $dueDate, $paymentTerms, $itemsJson, $subtotal, $gstAmount,
        $cgstAmount, $sgstAmount, $igstAmount,
        $einvoiceIrn, $einvoiceAckNo, $einvoiceAckDate, $einvoiceStatus,
        $totalAmount, $baseStatus, $storedPaid, $returnedAmount, $refundedAmount, $storedBalance, $bankAccountId,
        $ewayBill, $ewayDetailsJson, $warehouseId, $deductStock, $stockDeducted, $notes
    ]);

    require_once __DIR__ . '/accounting.php';

    if ($ex && $existingPaid == 0.0 && $returnedAmount == 0.0) {
        try {
            $pdo->prepare("DELETE FROM `solar_acc_journal_entries` WHERE `reference_type` = 'SALES_INVOICE' AND `reference_id` = ? AND `status` = 'POSTED'")->execute([$id]);
            accRecalcBalancesPhp($pdo);
        } catch (Exception $e) {}
    }

    if ($baseStatus !== 'DRAFT' && $baseStatus !== 'CANCELLED' && $totalAmount > 0) {
        try {
            accEnsureSalesInvoiceJournalPhp($pdo, $id, $actor);
        } catch (Exception $e) {}
    }

    if ($paymentDelta > 0.01) {
        $effectiveBankId = accResolveBankAccountIdOrPrimaryPhp($pdo, $bankAccountId, $item['paymentMode'] ?? '');
        if ($effectiveBankId === '') {
            throw new Exception('Please configure or select an active Cash/Bank account to record this invoice payment.', 400);
        }
        $payRes = accRecordSalesInvoicePaymentPhp($pdo, $id, [
            'amount' => $paymentDelta,
            'paymentDate' => $invDate,
            'paymentMode' => $item['paymentMode'] ?? 'Bank NEFT/RTGS',
            'bankAccountId' => $effectiveBankId,
            'referenceNo' => $item['transactionReference'] ?? ($item['referenceNo'] ?? ''),
            'notes' => $ex ? 'Payment recorded on invoice update' : 'Initial payment recorded on invoice creation'
        ], $actor);
        $storedPaid = floatval($payRes['paidAmount'] ?? $storedPaid);
        $storedBalance = floatval($payRes['balanceAmount'] ?? $storedBalance);
        $status = $payRes['paymentStatus'] ?? $status;
        $bankAccountId = $payRes['bankAccountId'] ?? $effectiveBankId;
    }

    $bankMap = getBankAccountNameMapPhp($pdo);
    return array_merge($item, [
        'id' => $id,
        'invoiceNumber' => $invNumber,
        'invoiceType' => $invType,
        'projectId' => $projectId,
        'projectTitle' => $projectTitle,
        'customerId' => $customerId,
        'customerName' => $customerName,
        'customerGst' => $customerGst,
        'customerAddress' => $customerAddr,
        'invoiceDate' => $invDate,
        'dueDate' => $dueDate ?? '',
        'paymentTerms' => $paymentTerms,
        'items' => $itemsArr,
        'subtotal' => $subtotal,
        'taxAmount' => $gstAmount,
        'gstAmount' => $gstAmount,
        'cgstAmount' => $cgstAmount,
        'sgstAmount' => $sgstAmount,
        'igstAmount' => $igstAmount,
        'einvoiceIrn' => $einvoiceIrn,
        'einvoiceAckNo' => $einvoiceAckNo,
        'einvoiceAckDate' => $einvoiceAckDate,
        'einvoiceStatus' => $einvoiceStatus,
        'totalAmount' => $totalAmount,
        'grandTotal' => $totalAmount,
        'status' => $status,
        'paymentStatus' => $status,
        'paidAmount' => $storedPaid,
        'amountPaid' => $storedPaid,
        'returnedAmount' => $returnedAmount,
        'refundedAmount' => $refundedAmount,
        'balanceAmount' => $storedBalance,
        'balanceDue' => $storedBalance,
        'bankAccountId' => $bankAccountId,
        'bankAccountName' => $bankAccountId !== '' ? ($bankMap[$bankAccountId] ?? '') : '',
        'ewayBillNumber' => $ewayBill,
        'ewayBillDetails' => $ewayDetails,
        'warehouseId' => $warehouseId,
        'deductStock' => (bool)$deductStock,
        'stockDeducted' => (bool)$stockDeducted,
        'notes' => $notes,
        'createdAt' => $item['createdAt'] ?? ($ex['created_at'] ?? date('c')),
        'updatedAt' => date('c')
    ]);
}

// ==========================================================
// Helper: Vendor Sales Invoices (Indian GST + Transactional MySQL)
// ==========================================================
function roundCurrencyPhp($val) {
    $f = floatval($val);
    if (!is_finite($f)) return 0.0;
    return round($f + 1e-9, 2);
}

function toSqlDateVendorPhp($val) {
    if ($val === null || $val === '') return null;
    $str = trim((string)$val);
    if (preg_match('/^\d{4}-\d{2}-\d{2}/', $str, $m)) {
        return $m[0];
    }
    $ts = strtotime($str);
    return $ts !== false ? date('Y-m-d', $ts) : null;
}

function getIndianGstStateCodesPhp() {
    return [
        '01' => 'Jammu & Kashmir',
        '02' => 'Himachal Pradesh',
        '03' => 'Punjab',
        '04' => 'Chandigarh',
        '05' => 'Uttarakhand',
        '06' => 'Haryana',
        '07' => 'Delhi',
        '08' => 'Rajasthan',
        '09' => 'Uttar Pradesh',
        '10' => 'Bihar',
        '11' => 'Sikkim',
        '12' => 'Arunachal Pradesh',
        '13' => 'Nagaland',
        '14' => 'Manipur',
        '15' => 'Mizoram',
        '16' => 'Tripura',
        '17' => 'Meghalaya',
        '18' => 'Assam',
        '19' => 'West Bengal',
        '20' => 'Jharkhand',
        '21' => 'Odisha',
        '22' => 'Chhattisgarh',
        '23' => 'Madhya Pradesh',
        '24' => 'Gujarat',
        '26' => 'Dadra & Nagar Haveli and Daman & Diu',
        '27' => 'Maharashtra',
        '29' => 'Karnataka',
        '30' => 'Goa',
        '31' => 'Lakshadweep',
        '32' => 'Kerala',
        '33' => 'Tamil Nadu',
        '34' => 'Puducherry',
        '35' => 'Andaman & Nicobar Islands',
        '36' => 'Telangana',
        '37' => 'Andhra Pradesh',
        '38' => 'Ladakh'
    ];
}

function extractStateCodeFromGstinPhp($gstin = '') {
    $states = getIndianGstStateCodesPhp();
    $clean = strtoupper(trim((string)$gstin));
    if (preg_match('/^\d{2}[A-Z0-9]{13}$/', $clean) || preg_match('/^\d{2}[A-Z]{5}\d{4}/', $clean)) {
        $code = substr($clean, 0, 2);
        if (isset($states[$code])) return $code;
    }
    return '';
}

function resolveStateNameAndCodePhp($stateName = '', $gstin = '', $addressFallback = '') {
    $states = getIndianGstStateCodesPhp();
    $codeFromGst = extractStateCodeFromGstinPhp($gstin);
    $rawState = trim((string)$stateName);

    if ($rawState !== '') {
        $lower = strtolower($rawState);
        foreach ($states as $code => $canonical) {
            $canonLower = strtolower($canonical);
            if ($lower === $canonLower || str_contains($lower, $canonLower)) {
                return ['stateName' => $canonical, 'stateCode' => $code];
            }
        }
        return ['stateName' => $rawState, 'stateCode' => $codeFromGst];
    }

    if ($codeFromGst !== '' && isset($states[$codeFromGst])) {
        return ['stateName' => $states[$codeFromGst], 'stateCode' => $codeFromGst];
    }

    if (!empty($addressFallback)) {
        $addrLower = strtolower((string)$addressFallback);
        foreach ($states as $code => $canonical) {
            if (str_contains($addrLower, strtolower($canonical))) {
                return ['stateName' => $canonical, 'stateCode' => $code];
            }
        }
    }

    return ['stateName' => '', 'stateCode' => ''];
}

function determineVendorSupplyTypePhp($params) {
    $company = resolveStateNameAndCodePhp(
        $params['companyState'] ?? '',
        $params['companyGst'] ?? '',
        $params['companyAddress'] ?? ''
    );
    $effectiveCompanyState = !empty($company['stateName']) ? $company['stateName'] : 'Chhattisgarh';
    $effectiveCompanyCode = !empty($company['stateCode']) ? $company['stateCode'] : '22';

    $vendor = resolveStateNameAndCodePhp(
        $params['vendorState'] ?? '',
        $params['vendorGst'] ?? '',
        $params['vendorAddress'] ?? ''
    );

    $supplyType = 'INTRA_STATE';
    if (!empty($vendor['stateCode']) && !empty($effectiveCompanyCode)) {
        $supplyType = ($vendor['stateCode'] === $effectiveCompanyCode) ? 'INTRA_STATE' : 'INTER_STATE';
    } elseif (!empty($vendor['stateName']) && !empty($effectiveCompanyState)) {
        $supplyType = (strtolower(trim($vendor['stateName'])) === strtolower(trim($effectiveCompanyState)))
            ? 'INTRA_STATE'
            : 'INTER_STATE';
    }

    return [
        'supplyType' => $supplyType,
        'companyStateName' => $effectiveCompanyState,
        'companyStateCode' => $effectiveCompanyCode,
        'vendorStateName' => !empty($vendor['stateName']) ? $vendor['stateName'] : $effectiveCompanyState,
        'vendorStateCode' => $vendor['stateCode'] ?? ''
    ];
}

function computeVendorSalesLineItemPhp($input, $supplyType) {
    $quantity = max(0.0, floatval($input['quantity'] ?? 0));
    $rate = max(0.0, floatval($input['rate'] ?? 0));
    $gstRate = min(100.0, max(0.0, floatval($input['gstRate'] ?? 0)));
    $discountType = (isset($input['discountType']) && strtoupper((string)$input['discountType']) === 'FLAT') ? 'FLAT' : 'PERCENT';
    $rawDiscountVal = max(0.0, floatval($input['discountValue'] ?? 0));

    $lineGross = roundCurrencyPhp($quantity * $rate);
    $discountValue = ($discountType === 'PERCENT') ? min(100.0, $rawDiscountVal) : min($lineGross, $rawDiscountVal);
    $discountAmount = ($discountType === 'FLAT')
        ? roundCurrencyPhp(min($lineGross, $discountValue))
        : roundCurrencyPhp(($lineGross * $discountValue) / 100.0);

    $taxableAmount = roundCurrencyPhp(max(0.0, $lineGross - $discountAmount));

    $cgstRate = 0.0;
    $sgstRate = 0.0;
    $igstRate = 0.0;
    $cgstAmount = 0.0;
    $sgstAmount = 0.0;
    $igstAmount = 0.0;

    if ($supplyType === 'INTER_STATE') {
        $igstRate = $gstRate;
        $igstAmount = roundCurrencyPhp(($taxableAmount * $igstRate) / 100.0);
    } else {
        $cgstRate = roundCurrencyPhp($gstRate / 2.0);
        $sgstRate = roundCurrencyPhp($gstRate / 2.0);
        $cgstAmount = roundCurrencyPhp(($taxableAmount * $cgstRate) / 100.0);
        $sgstAmount = roundCurrencyPhp(($taxableAmount * $sgstRate) / 100.0);
    }

    $taxAmount = roundCurrencyPhp($cgstAmount + $sgstAmount + $igstAmount);
    $totalAmount = roundCurrencyPhp($taxableAmount + $taxAmount);

    return [
        'id' => !empty($input['id']) ? (string)$input['id'] : ('vsli-' . round(microtime(true) * 1000) . '-' . mt_rand(100, 9999)),
        'productId' => !empty($input['productId']) ? (string)$input['productId'] : null,
        'description' => trim((string)($input['description'] ?? '')),
        'hsnCode' => trim((string)($input['hsnCode'] ?? '')),
        'quantity' => $quantity,
        'unit' => !empty(trim((string)($input['unit'] ?? ''))) ? trim((string)$input['unit']) : 'NOS',
        'rate' => $rate,
        'discountType' => $discountType,
        'discountValue' => $discountValue,
        'discountAmount' => $discountAmount,
        'taxableAmount' => $taxableAmount,
        'gstRate' => $gstRate,
        'cgstRate' => $cgstRate,
        'cgstAmount' => $cgstAmount,
        'sgstRate' => $sgstRate,
        'sgstAmount' => $sgstAmount,
        'igstRate' => $igstRate,
        'igstAmount' => $igstAmount,
        'taxAmount' => $taxAmount,
        'totalAmount' => $totalAmount
    ];
}

function computeVendorSalesInvoiceTotalsPhp($items, $supplyType) {
    $computedItems = [];
    $grossAmount = 0.0;
    $discountAmount = 0.0;
    $subtotal = 0.0;
    $cgstAmount = 0.0;
    $sgstAmount = 0.0;
    $igstAmount = 0.0;

    foreach ($items as $it) {
        $c = computeVendorSalesLineItemPhp($it, $supplyType);
        $computedItems[] = $c;
        $grossAmount += roundCurrencyPhp($c['quantity'] * $c['rate']);
        $discountAmount += $c['discountAmount'];
        $subtotal += $c['taxableAmount'];
        $cgstAmount += $c['cgstAmount'];
        $sgstAmount += $c['sgstAmount'];
        $igstAmount += $c['igstAmount'];
    }

    $grossAmount = roundCurrencyPhp($grossAmount);
    $discountAmount = roundCurrencyPhp($discountAmount);
    $subtotal = roundCurrencyPhp($subtotal);
    $cgstAmount = roundCurrencyPhp($cgstAmount);
    $sgstAmount = roundCurrencyPhp($sgstAmount);
    $igstAmount = roundCurrencyPhp($igstAmount);
    $taxAmount = roundCurrencyPhp($cgstAmount + $sgstAmount + $igstAmount);
    $totalAmount = roundCurrencyPhp($subtotal + $taxAmount);

    return [
        'items' => $computedItems,
        'grossAmount' => $grossAmount,
        'discountAmount' => $discountAmount,
        'subtotal' => $subtotal,
        'cgstAmount' => $cgstAmount,
        'sgstAmount' => $sgstAmount,
        'igstAmount' => $igstAmount,
        'taxAmount' => $taxAmount,
        'totalAmount' => $totalAmount
    ];
}

function resolveEffectiveVendorInvoiceStatusPhp($rawStatus, $dueDate, $totalAmount, $paidAmount, $returnedAmount = 0.0, $refundedAmount = 0.0) {
    $status = strtoupper(trim((string)($rawStatus ?: 'ISSUED')));
    $netPaid = roundCurrencyPhp(max(0.0, floatval($paidAmount) - floatval($refundedAmount)));
    $balance = roundCurrencyPhp(max(0.0, floatval($totalAmount) - floatval($returnedAmount) - $netPaid));
    if ($status === 'DRAFT' && floatval($paidAmount) <= 0 && floatval($returnedAmount) <= 0) {
        return 'DRAFT';
    }
    if (floatval($totalAmount) > 0 && $balance <= 0.01) {
        return 'PAID';
    }
    if ($netPaid > 0.01) {
        return 'PARTIALLY_PAID';
    }
    if (!empty($dueDate)) {
        $today = date('Y-m-d');
        if ($dueDate < $today) {
            return 'OVERDUE';
        }
    }
    return ($status === 'OVERDUE') ? 'OVERDUE' : 'ISSUED';
}

function mapVendorSalesItemRowPhp($r) {
    return [
        'id' => $r['id'],
        'productId' => !empty($r['product_id']) ? $r['product_id'] : null,
        'description' => $r['description'],
        'hsnCode' => $r['hsn_code'] ?? '',
        'quantity' => floatval($r['quantity'] ?? 0),
        'unit' => $r['unit'] ?? 'NOS',
        'rate' => roundCurrencyPhp($r['rate'] ?? 0),
        'discountType' => (($r['discount_type'] ?? 'PERCENT') === 'FLAT') ? 'FLAT' : 'PERCENT',
        'discountValue' => roundCurrencyPhp($r['discount_value'] ?? 0),
        'discountAmount' => roundCurrencyPhp($r['discount_amount'] ?? 0),
        'taxableAmount' => roundCurrencyPhp($r['taxable_amount'] ?? 0),
        'gstRate' => floatval($r['gst_rate'] ?? 0),
        'cgstRate' => floatval($r['cgst_rate'] ?? 0),
        'cgstAmount' => roundCurrencyPhp($r['cgst_amount'] ?? 0),
        'sgstRate' => floatval($r['sgst_rate'] ?? 0),
        'sgstAmount' => roundCurrencyPhp($r['sgst_amount'] ?? 0),
        'igstRate' => floatval($r['igst_rate'] ?? 0),
        'igstAmount' => roundCurrencyPhp($r['igst_amount'] ?? 0),
        'taxAmount' => roundCurrencyPhp($r['tax_amount'] ?? 0),
        'totalAmount' => roundCurrencyPhp($r['total_amount'] ?? 0)
    ];
}

function getBankAccountNameMapPhp($pdo) {
    $map = [];
    try {
        $rows = $pdo->query('SELECT `id`, `account_name` FROM `solar_acc_bank_accounts`')->fetchAll(PDO::FETCH_ASSOC) ?: [];
        foreach ($rows as $r) {
            $map[(string)$r['id']] = (string)($r['account_name'] ?? '');
        }
    } catch (Exception $e) {}
    return $map;
}

function mapVendorSalesPaymentRowPhp($r, $bankMap = []) {
    $bankId = (string)($r['bank_account_id'] ?? '');
    return [
        'id' => $r['id'],
        'invoiceId' => $r['invoice_id'],
        'vendorId' => $r['vendor_id'],
        'paymentDate' => toSqlDateVendorPhp($r['payment_date']) ?: '',
        'amount' => roundCurrencyPhp($r['amount'] ?? 0),
        'paymentMode' => $r['payment_mode'] ?? 'Bank NEFT/RTGS',
        'bankAccountId' => $bankId,
        'bankAccountName' => $bankId !== '' ? ($bankMap[$bankId] ?? '') : '',
        'journalEntryId' => $r['journal_entry_id'] ?? '',
        'referenceNo' => $r['reference_no'] ?? '',
        'notes' => $r['notes'] ?? '',
        'recordedBy' => $r['recorded_by'] ?? '',
        'createdAt' => $r['created_at'] ?? null
    ];
}

function mapVendorSalesInvoiceRowPhp($row, $items = [], $payments = [], $bankMap = []) {
    $invoiceDate = toSqlDateVendorPhp($row['invoice_date'] ?? null) ?: '';
    $dueDate = toSqlDateVendorPhp($row['due_date'] ?? null) ?: '';
    $totalAmount = roundCurrencyPhp($row['total_amount'] ?? 0);
    $paidAmount = roundCurrencyPhp($row['paid_amount'] ?? 0);
    $returnedAmount = roundCurrencyPhp($row['returned_amount'] ?? 0);
    $refundedAmount = roundCurrencyPhp($row['refunded_amount'] ?? 0);
    $netPaid = roundCurrencyPhp(max(0.0, $paidAmount - $refundedAmount));
    $balanceAmount = roundCurrencyPhp(max(0.0, $totalAmount - $returnedAmount - $netPaid));
    $status = resolveEffectiveVendorInvoiceStatusPhp(
        $row['status'] ?? 'ISSUED',
        $dueDate,
        $totalAmount,
        $paidAmount,
        $returnedAmount,
        $refundedAmount
    );
    $bankAccountId = (string)($row['bank_account_id'] ?? '');

    return [
        'id' => $row['id'],
        'invoiceNumber' => $row['invoice_number'],
        'vendorId' => $row['vendor_id'],
        'vendorCode' => $row['vendor_code'] ?? '',
        'vendorName' => $row['vendor_name'],
        'vendorGst' => $row['vendor_gst'] ?? '',
        'vendorAddress' => $row['vendor_address'] ?? '',
        'vendorCity' => $row['vendor_city'] ?? '',
        'vendorState' => $row['vendor_state'] ?? '',
        'vendorContactPerson' => $row['vendor_contact_person'] ?? '',
        'vendorPhone' => $row['vendor_phone'] ?? '',
        'vendorEmail' => $row['vendor_email'] ?? '',
        'companyState' => $row['company_state'] ?? 'Chhattisgarh',
        'supplyType' => (($row['supply_type'] ?? 'INTRA_STATE') === 'INTER_STATE') ? 'INTER_STATE' : 'INTRA_STATE',
        'invoiceDate' => $invoiceDate,
        'dueDate' => $dueDate,
        'paymentTerms' => $row['payment_terms'] ?? '30 Days',
        'notes' => $row['notes'] ?? '',
        'items' => $items,
        'grossAmount' => roundCurrencyPhp($row['gross_amount'] ?? 0),
        'discountAmount' => roundCurrencyPhp($row['discount_amount'] ?? 0),
        'subtotal' => roundCurrencyPhp($row['subtotal'] ?? 0),
        'cgstAmount' => roundCurrencyPhp($row['cgst_amount'] ?? 0),
        'sgstAmount' => roundCurrencyPhp($row['sgst_amount'] ?? 0),
        'igstAmount' => roundCurrencyPhp($row['igst_amount'] ?? 0),
        'taxAmount' => roundCurrencyPhp($row['tax_amount'] ?? 0),
        'totalAmount' => $totalAmount,
        'paidAmount' => $paidAmount,
        'returnedAmount' => $returnedAmount,
        'refundedAmount' => $refundedAmount,
        'balanceAmount' => $balanceAmount,
        'bankAccountId' => $bankAccountId,
        'bankAccountName' => $bankAccountId !== '' ? ($bankMap[$bankAccountId] ?? '') : '',
        'status' => $status,
        'payments' => $payments,
        'createdBy' => $row['created_by'] ?? '',
        'updatedBy' => $row['updated_by'] ?? '',
        'createdAt' => $row['created_at'] ?? null,
        'updatedAt' => $row['updated_at'] ?? ($row['created_at'] ?? null)
    ];
}

function getNextVendorSalesInvoiceNumberPhp($pdo) {
    $year = date('Y');
    $prefix = "VSI-{$year}-";
    $stmt = $pdo->prepare('SELECT `invoice_number` FROM `solar_vendor_sales_invoices` WHERE `invoice_number` LIKE ?');
    $stmt->execute([$prefix . '%']);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $maxSeq = 0;
    foreach ($rows as $r) {
        $numStr = substr((string)($r['invoice_number'] ?? ''), strlen($prefix));
        if (ctype_digit($numStr)) {
            $parsed = intval($numStr);
            if ($parsed > $maxSeq) $maxSeq = $parsed;
        } else {
            $parsed = intval($numStr);
            if ($parsed > $maxSeq) $maxSeq = $parsed;
        }
    }
    return $prefix . str_pad((string)($maxSeq + 1), 3, '0', STR_PAD_LEFT);
}

function getVendorSalesInvoicesPhp($pdo) {
    $invStmt = $pdo->query('SELECT * FROM `solar_vendor_sales_invoices` ORDER BY `invoice_date` DESC, `created_at` DESC');
    $invoiceRows = $invStmt ? ($invStmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
    if (empty($invoiceRows)) return [];

    $itemStmt = $pdo->query('SELECT * FROM `solar_vendor_sales_invoice_items` ORDER BY `line_order` ASC, `created_at` ASC');
    $itemRows = $itemStmt ? ($itemStmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];

    $payStmt = $pdo->query('SELECT * FROM `solar_vendor_sales_payments` ORDER BY `payment_date` DESC, `created_at` DESC');
    $paymentRows = $payStmt ? ($payStmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];

    $bankMap = getBankAccountNameMapPhp($pdo);

    $itemsByInv = [];
    foreach ($itemRows as $r) {
        $k = (string)$r['invoice_id'];
        if (!isset($itemsByInv[$k])) $itemsByInv[$k] = [];
        $itemsByInv[$k][] = mapVendorSalesItemRowPhp($r);
    }

    $paymentsByInv = [];
    foreach ($paymentRows as $r) {
        $k = (string)$r['invoice_id'];
        if (!isset($paymentsByInv[$k])) $paymentsByInv[$k] = [];
        $paymentsByInv[$k][] = mapVendorSalesPaymentRowPhp($r, $bankMap);
    }

    return array_map(function ($row) use ($itemsByInv, $paymentsByInv, $bankMap) {
        $id = (string)$row['id'];
        return mapVendorSalesInvoiceRowPhp(
            $row,
            $itemsByInv[$id] ?? [],
            $paymentsByInv[$id] ?? [],
            $bankMap
        );
    }, $invoiceRows);
}

function getVendorSalesInvoiceByIdPhp($pdo, $id) {
    $stmt = $pdo->prepare('SELECT * FROM `solar_vendor_sales_invoices` WHERE `id` = ? LIMIT 1');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;

    $bankMap = getBankAccountNameMapPhp($pdo);

    $itStmt = $pdo->prepare('SELECT * FROM `solar_vendor_sales_invoice_items` WHERE `invoice_id` = ? ORDER BY `line_order` ASC, `created_at` ASC');
    $itStmt->execute([$id]);
    $items = array_map('mapVendorSalesItemRowPhp', $itStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

    $payStmt = $pdo->prepare('SELECT * FROM `solar_vendor_sales_payments` WHERE `invoice_id` = ? ORDER BY `payment_date` DESC, `created_at` DESC');
    $payStmt->execute([$id]);
    $payments = array_map(function ($r) use ($bankMap) {
        return mapVendorSalesPaymentRowPhp($r, $bankMap);
    }, $payStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

    return mapVendorSalesInvoiceRowPhp($row, $items, $payments, $bankMap);
}

function saveVendorSalesInvoicePhp($pdo, $item, $actor = null) {
    if (!is_array($item)) {
        throw new Exception('Invalid vendor sales invoice payload.', 400);
    }

    require_once __DIR__ . '/accounting.php';
    ensureAccountingTablesPhp($pdo);

    $pdo->beginTransaction();
    try {
        $id = !empty(trim((string)($item['id'] ?? '')))
            ? trim((string)$item['id'])
            : ('vsi-' . round(microtime(true) * 1000));

        $exStmt = $pdo->prepare('SELECT * FROM `solar_vendor_sales_invoices` WHERE `id` = ? LIMIT 1');
        $exStmt->execute([$id]);
        $existing = $exStmt->fetch(PDO::FETCH_ASSOC) ?: null;

        $vendorId = trim((string)($item['vendorId'] ?? ($item['vendor_id'] ?? ($existing['vendor_id'] ?? ''))));
        if ($vendorId === '') {
            throw new Exception('Please select an existing vendor from MySQL records.', 400);
        }

        $vStmt = $pdo->prepare('SELECT * FROM `solar_vendors` WHERE `id` = ? LIMIT 1');
        $vStmt->execute([$vendorId]);
        $vendorRow = $vStmt->fetch(PDO::FETCH_ASSOC);
        if (!$vendorRow) {
            throw new Exception("Selected vendor ({$vendorId}) does not exist in MySQL vendor records.", 400);
        }

        $rawItems = (isset($item['items']) && is_array($item['items'])) ? $item['items'] : [];
        if (empty($rawItems)) {
            throw new Exception('Invoice must include at least one line item.', 400);
        }

        // Validate referenced productIds exist in solar_products
        $productIds = [];
        foreach ($rawItems as $li) {
            $pid = trim((string)($li['productId'] ?? ($li['product_id'] ?? '')));
            if ($pid !== '') $productIds[$pid] = true;
        }
        $uniqueProductIds = array_keys($productIds);
        if (!empty($uniqueProductIds)) {
            $placeholders = implode(',', array_fill(0, count($uniqueProductIds), '?'));
            $pStmt = $pdo->prepare("SELECT `id` FROM `solar_products` WHERE `id` IN ({$placeholders})");
            $pStmt->execute($uniqueProductIds);
            $foundProdIds = [];
            foreach ($pStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $pr) {
                $foundProdIds[(string)$pr['id']] = true;
            }
            foreach ($uniqueProductIds as $pid) {
                if (!isset($foundProdIds[$pid])) {
                    throw new Exception("Referenced product ({$pid}) was not found in MySQL product catalog.", 400);
                }
            }
        }

        foreach ($rawItems as $idx => $li) {
            $lineNo = $idx + 1;
            $desc = trim((string)($li['description'] ?? ''));
            $qty = isset($li['quantity']) && is_numeric($li['quantity']) ? floatval($li['quantity']) : NAN;
            $rate = isset($li['rate']) && is_numeric($li['rate']) ? floatval($li['rate']) : NAN;
            $gstRaw = $li['gstRate'] ?? ($li['taxRatePercent'] ?? 0);
            $gst = is_numeric($gstRaw) ? floatval($gstRaw) : NAN;
            $discRaw = $li['discountValue'] ?? 0;
            $disc = is_numeric($discRaw) ? floatval($discRaw) : NAN;

            if ($desc === '') {
                throw new Exception("Line item #{$lineNo}: description is required.", 400);
            }
            if (!is_finite($qty) || $qty <= 0) {
                throw new Exception("Line item #{$lineNo}: quantity must be greater than 0.", 400);
            }
            if (!is_finite($rate) || $rate < 0) {
                throw new Exception("Line item #{$lineNo}: rate cannot be negative.", 400);
            }
            if (!is_finite($gst) || $gst < 0 || $gst > 100) {
                throw new Exception("Line item #{$lineNo}: GST rate must be between 0% and 100%.", 400);
            }
            if (!is_finite($disc) || $disc < 0) {
                throw new Exception("Line item #{$lineNo}: discount cannot be negative.", 400);
            }
        }

        // Load company global settings from MySQL
        $settings = [];
        try {
            $sStmt = $pdo->query("SELECT `setting_value` FROM `solar_system_settings` WHERE `setting_key` = 'global_settings' LIMIT 1");
            $sRow = $sStmt ? $sStmt->fetch(PDO::FETCH_ASSOC) : null;
            if ($sRow && !empty($sRow['setting_value'])) {
                $settings = json_decode($sRow['setting_value'], true) ?: [];
            }
        } catch (Exception $e) {}

        $vendorCode = $vendorRow['vendor_code'] ?? ($item['vendorCode'] ?? '');
        $vendorName = $vendorRow['name'] ?? ($item['vendorName'] ?? 'Solar Vendor');
        $vendorGst = trim((string)($item['vendorGst'] ?? ($vendorRow['gst_number'] ?? '')));
        $vendorCity = trim((string)($item['vendorCity'] ?? ($vendorRow['city'] ?? '')));
        $vendorState = trim((string)($item['vendorState'] ?? ($vendorRow['state'] ?? '')));
        $addrParts = array_values(array_filter(array_map(function ($s) {
            return trim((string)$s);
        }, [$vendorRow['address'] ?? '', $vendorCity, $vendorState])));
        $formattedVendorAddr = implode(', ', $addrParts);
        $vendorAddress = trim((string)($item['vendorAddress'] ?? $formattedVendorAddr));
        $vendorContactPerson = trim((string)($item['vendorContactPerson'] ?? ($vendorRow['contact_person'] ?? '')));
        $vendorPhone = trim((string)($item['vendorPhone'] ?? ($vendorRow['phone'] ?? '')));
        $vendorEmail = trim((string)($item['vendorEmail'] ?? ($vendorRow['email'] ?? '')));

        $jurisdiction = determineVendorSupplyTypePhp([
            'companyState' => $item['companyState'] ?? ($settings['companyState'] ?? ''),
            'companyGst' => $settings['companyGst'] ?? '',
            'companyAddress' => $settings['companyAddress'] ?? '',
            'vendorState' => $vendorState,
            'vendorGst' => $vendorGst,
            'vendorAddress' => $vendorAddress
        ]);

        $draftItems = array_map(function ($li) {
            return [
                'id' => $li['id'] ?? null,
                'productId' => $li['productId'] ?? ($li['product_id'] ?? null),
                'description' => $li['description'] ?? '',
                'hsnCode' => $li['hsnCode'] ?? ($li['hsn_code'] ?? ''),
                'quantity' => floatval($li['quantity'] ?? 0),
                'unit' => $li['unit'] ?? 'NOS',
                'rate' => floatval($li['rate'] ?? 0),
                'discountType' => (isset($li['discountType']) && strtoupper((string)$li['discountType']) === 'FLAT') ? 'FLAT' : 'PERCENT',
                'discountValue' => floatval($li['discountValue'] ?? 0),
                'gstRate' => floatval($li['gstRate'] ?? ($li['taxRatePercent'] ?? 18))
            ];
        }, $rawItems);

        $computed = computeVendorSalesInvoiceTotalsPhp($draftItems, $jurisdiction['supplyType']);

        $invoiceNumber = trim((string)($item['invoiceNumber'] ?? ($existing['invoice_number'] ?? '')));
        if ($invoiceNumber === '') {
            $invoiceNumber = getNextVendorSalesInvoiceNumberPhp($pdo);
        }

        // Enforce unique invoice number
        $dupStmt = $pdo->prepare('SELECT `id` FROM `solar_vendor_sales_invoices` WHERE `invoice_number` = ? AND `id` <> ? LIMIT 1');
        $dupStmt->execute([$invoiceNumber, $id]);
        if ($dupStmt->fetch(PDO::FETCH_ASSOC)) {
            throw new Exception("Invoice number \"{$invoiceNumber}\" already exists.", 409);
        }

        $invoiceDate = toSqlDateVendorPhp($item['invoiceDate'] ?? ($existing['invoice_date'] ?? null)) ?: date('Y-m-d');
        $dueDate = toSqlDateVendorPhp($item['dueDate'] ?? ($existing['due_date'] ?? null)) ?: $invoiceDate;
        $paymentTerms = trim((string)($item['paymentTerms'] ?? ($existing['payment_terms'] ?? ($vendorRow['payment_terms'] ?? '30 Days'))));
        $notes = trim((string)($item['notes'] ?? ($existing['notes'] ?? '')));

        $paySumStmt = $pdo->prepare('SELECT COALESCE(SUM(`amount`), 0) AS paidSum FROM `solar_vendor_sales_payments` WHERE `invoice_id` = ?');
        $paySumStmt->execute([$id]);
        $paySumRow = $paySumStmt->fetch(PDO::FETCH_ASSOC);
        $recordedPaymentsTotal = roundCurrencyPhp($paySumRow['paidSum'] ?? 0);
        $paidAmount = $existing
            ? $recordedPaymentsTotal
            : min($computed['totalAmount'], roundCurrencyPhp($item['paidAmount'] ?? 0));
        $returnedAmount = roundCurrencyPhp($existing['returned_amount'] ?? 0);
        $refundedAmount = roundCurrencyPhp($existing['refunded_amount'] ?? 0);
        $initialPayToRecord = (!$existing && $paidAmount > 0) ? $paidAmount : 0.0;
        $storedPaid = $existing ? $paidAmount : 0.0;
        $netPaid = roundCurrencyPhp(max(0.0, $storedPaid - $refundedAmount));
        $balanceAmount = roundCurrencyPhp(max(0.0, $computed['totalAmount'] - $returnedAmount - $netPaid));
        $bankAccountId = trim((string)($item['bankAccountId'] ?? ($existing['bank_account_id'] ?? '')));

        $requestedStatus = strtoupper(trim((string)($item['status'] ?? ($existing['status'] ?? 'ISSUED'))));
        $status = resolveEffectiveVendorInvoiceStatusPhp(
            $requestedStatus,
            $dueDate,
            $computed['totalAmount'],
            $storedPaid,
            $returnedAmount,
            $refundedAmount
        );

        $actorName = trim((string)($actor['name'] ?? ($actor['email'] ?? ($item['updatedBy'] ?? ($item['createdBy'] ?? 'Admin')))));
        if ($actorName === '') $actorName = 'Admin';
        $createdBy = !empty($existing['created_by']) ? (string)$existing['created_by'] : trim((string)($item['createdBy'] ?? $actorName));

        $pdo->prepare("
            INSERT INTO `solar_vendor_sales_invoices` (
              `id`, `invoice_number`, `vendor_id`, `vendor_code`, `vendor_name`, `vendor_gst`,
              `vendor_address`, `vendor_city`, `vendor_state`, `vendor_contact_person`, `vendor_phone`, `vendor_email`,
              `company_state`, `supply_type`, `invoice_date`, `due_date`, `payment_terms`, `notes`,
              `gross_amount`, `discount_amount`, `subtotal`, `cgst_amount`, `sgst_amount`, `igst_amount`, `tax_amount`,
              `total_amount`, `paid_amount`, `returned_amount`, `refunded_amount`, `balance_amount`, `bank_account_id`, `status`, `created_by`, `updated_by`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              `invoice_number` = VALUES(`invoice_number`),
              `vendor_id` = VALUES(`vendor_id`),
              `vendor_code` = VALUES(`vendor_code`),
              `vendor_name` = VALUES(`vendor_name`),
              `vendor_gst` = VALUES(`vendor_gst`),
              `vendor_address` = VALUES(`vendor_address`),
              `vendor_city` = VALUES(`vendor_city`),
              `vendor_state` = VALUES(`vendor_state`),
              `vendor_contact_person` = VALUES(`vendor_contact_person`),
              `vendor_phone` = VALUES(`vendor_phone`),
              `vendor_email` = VALUES(`vendor_email`),
              `company_state` = VALUES(`company_state`),
              `supply_type` = VALUES(`supply_type`),
              `invoice_date` = VALUES(`invoice_date`),
              `due_date` = VALUES(`due_date`),
              `payment_terms` = VALUES(`payment_terms`),
              `notes` = VALUES(`notes`),
              `gross_amount` = VALUES(`gross_amount`),
              `discount_amount` = VALUES(`discount_amount`),
              `subtotal` = VALUES(`subtotal`),
              `cgst_amount` = VALUES(`cgst_amount`),
              `sgst_amount` = VALUES(`sgst_amount`),
              `igst_amount` = VALUES(`igst_amount`),
              `tax_amount` = VALUES(`tax_amount`),
              `total_amount` = VALUES(`total_amount`),
              `paid_amount` = VALUES(`paid_amount`),
              `returned_amount` = VALUES(`returned_amount`),
              `refunded_amount` = VALUES(`refunded_amount`),
              `balance_amount` = VALUES(`balance_amount`),
              `bank_account_id` = VALUES(`bank_account_id`),
              `status` = VALUES(`status`),
              `updated_by` = VALUES(`updated_by`)
        ")->execute([
            $id,
            $invoiceNumber,
            $vendorId,
            $vendorCode,
            $vendorName,
            $vendorGst,
            $vendorAddress,
            $vendorCity,
            !empty($jurisdiction['vendorStateName']) ? $jurisdiction['vendorStateName'] : $vendorState,
            $vendorContactPerson,
            $vendorPhone,
            $vendorEmail,
            $jurisdiction['companyStateName'],
            $jurisdiction['supplyType'],
            $invoiceDate,
            $dueDate,
            $paymentTerms,
            $notes,
            $computed['grossAmount'],
            $computed['discountAmount'],
            $computed['subtotal'],
            $computed['cgstAmount'],
            $computed['sgstAmount'],
            $computed['igstAmount'],
            $computed['taxAmount'],
            $computed['totalAmount'],
            $storedPaid,
            $returnedAmount,
            $refundedAmount,
            $balanceAmount,
            $bankAccountId,
            $status,
            $createdBy,
            $actorName
        ]);

        // Replace line items atomically
        $pdo->prepare('DELETE FROM `solar_vendor_sales_invoice_items` WHERE `invoice_id` = ?')->execute([$id]);
        $itemInsert = $pdo->prepare("
            INSERT INTO `solar_vendor_sales_invoice_items` (
              `id`, `invoice_id`, `product_id`, `line_order`, `description`, `hsn_code`,
              `quantity`, `unit`, `rate`, `discount_type`, `discount_value`, `discount_amount`,
              `taxable_amount`, `gst_rate`, `cgst_rate`, `cgst_amount`, `sgst_rate`, `sgst_amount`,
              `igst_rate`, `igst_amount`, `tax_amount`, `total_amount`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        foreach ($computed['items'] as $idx => $li) {
            $lineId = 'vsii-' . $id . '-' . $idx . '-' . base_convert((string)round(microtime(true) * 1000), 10, 36);
            $itemInsert->execute([
                $lineId,
                $id,
                $li['productId'] ?: null,
                $idx,
                $li['description'],
                $li['hsnCode'] ?: '',
                $li['quantity'],
                $li['unit'],
                $li['rate'],
                $li['discountType'],
                $li['discountValue'],
                $li['discountAmount'],
                $li['taxableAmount'],
                $li['gstRate'],
                $li['cgstRate'],
                $li['cgstAmount'],
                $li['sgstRate'],
                $li['sgstAmount'],
                $li['igstRate'],
                $li['igstAmount'],
                $li['taxAmount'],
                $li['totalAmount']
            ]);
        }

        $pdo->commit();

        require_once __DIR__ . '/accounting.php';
        if ($status !== 'DRAFT') {
            try {
                accEnsureVendorSalesInvoiceJournalPhp($pdo, $id, $actor);
            } catch (Exception $e) {}
        }

        if ($initialPayToRecord > 0) {
            $effectiveBankId = accResolveBankAccountIdOrPrimaryPhp($pdo, $bankAccountId, $item['paymentMode'] ?? '');
            accRecordVendorSalesInvoicePaymentPhp($pdo, $id, [
                'amount' => $initialPayToRecord,
                'paymentDate' => $invoiceDate,
                'paymentMode' => $item['paymentMode'] ?? 'Bank NEFT/RTGS',
                'bankAccountId' => $effectiveBankId,
                'notes' => 'Initial payment recorded on invoice creation'
            ], $actor);
        }

        return getVendorSalesInvoiceByIdPhp($pdo, $id);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

function recordVendorSalesPaymentPhp($pdo, $invoiceId, $payment, $actor = null) {
    require_once __DIR__ . '/accounting.php';
    accRecordVendorSalesInvoicePaymentPhp($pdo, $invoiceId, $payment, $actor);
    return getVendorSalesInvoiceByIdPhp($pdo, $invoiceId);
}

function deleteVendorSalesInvoicePhp($pdo, $id) {
    require_once __DIR__ . '/accounting.php';
    $pdo->beginTransaction();
    try {
        $chk = $pdo->prepare('SELECT `id` FROM `solar_vendor_sales_invoices` WHERE `id` = ? LIMIT 1');
        $chk->execute([$id]);
        if (!$chk->fetch(PDO::FETCH_ASSOC)) {
            throw new Exception('Vendor sales invoice not found.', 404);
        }

        try {
            $srChk = $pdo->prepare("SELECT COUNT(*) AS cnt FROM `solar_sales_returns` WHERE `target_type` = 'VENDOR_INVOICE' AND `invoice_id` = ?");
            $srChk->execute([$id]);
            if (intval($srChk->fetchColumn() ?: 0) > 0) {
                throw new Exception('Cannot delete vendor sales invoice with Sales Returns recorded. Delete the Sales Returns first.', 400);
            }
        } catch (Exception $e) {
            if ($e->getCode() === 400) throw $e;
        }

        $payStmt = $pdo->prepare('SELECT * FROM `solar_vendor_sales_payments` WHERE `invoice_id` = ?');
        $payStmt->execute([$id]);
        foreach ($payStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $vp) {
            if (!empty($vp['bank_account_id']) && floatval($vp['amount'] ?? 0) > 0) {
                $pdo->prepare('UPDATE `solar_acc_bank_accounts` SET `current_balance` = ROUND(`current_balance` - ?, 2) WHERE `id` = ?')
                    ->execute([roundCurrencyPhp($vp['amount']), $vp['bank_account_id']]);
            }
            if (!empty($vp['journal_entry_id'])) {
                $pdo->prepare('DELETE FROM `solar_acc_journal_entries` WHERE `id` = ?')->execute([$vp['journal_entry_id']]);
            }
        }

        $pdo->prepare("DELETE FROM `solar_acc_journal_entries` WHERE `reference_type` = 'VENDOR_SALES_INVOICE' AND `reference_id` = ?")->execute([$id]);
        accRecalcBalancesPhp($pdo);

        $pdo->prepare('DELETE FROM `solar_vendor_sales_payments` WHERE `invoice_id` = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM `solar_vendor_sales_invoice_items` WHERE `invoice_id` = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM `solar_vendor_sales_invoices` WHERE `id` = ?')->execute([$id]);
        $pdo->commit();
        return true;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

// Helper: Attendance
function saveAttendanceToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'att-' . round(microtime(true) * 1000);
    $empId = $item['employeeId'] ?? $item['employee_id'] ?? '';
    $empName = $item['employeeName'] ?? $item['employee_name'] ?? 'Employee';
    $rawAttDate = $item['attendanceDate'] ?? ($item['date'] ?? ($item['attendance_date'] ?? ''));
    $attDate = !empty($rawAttDate) ? substr((string)$rawAttDate, 0, 10) : date('Y-m-d');
    $checkInTime = $item['checkInTime'] ?? $item['check_in_time'] ?? '09:00';
    $checkOutTime = $item['checkOutTime'] ?? $item['check_out_time'] ?? null;
    $checkInGps = $item['checkInGPS'] ?? $item['checkInGps'] ?? $item['gpsCheckIn'] ?? $item['check_in_gps_json'] ?? null;
    $checkInGpsParsed = is_string($checkInGps) ? (json_decode($checkInGps, true) ?: $checkInGps) : $checkInGps;
    $checkInGpsJson = $checkInGps ? (is_string($checkInGps) ? $checkInGps : json_encode($checkInGps)) : null;
    $checkOutGps = $item['checkOutGPS'] ?? $item['checkOutGps'] ?? $item['gpsCheckOut'] ?? $item['check_out_gps_json'] ?? null;
    $checkOutGpsParsed = is_string($checkOutGps) ? (json_decode($checkOutGps, true) ?: $checkOutGps) : $checkOutGps;
    $checkOutGpsJson = $checkOutGps ? (is_string($checkOutGps) ? $checkOutGps : json_encode($checkOutGps)) : null;
    $projId = $item['siteProjectId'] ?? $item['site_project_id'] ?? '';
    $projTitle = $item['siteProjectTitle'] ?? $item['site_project_title'] ?? '';
    $status = $item['status'] ?? 'PRESENT';
    $fuelExpenseRaw = $item['fuelExpense'] ?? $item['fuel_expense'] ?? $item['fuel_expense_json'] ?? null;
    $fuelExpense = is_string($fuelExpenseRaw) ? (json_decode($fuelExpenseRaw, true) ?: null) : (is_array($fuelExpenseRaw) ? $fuelExpenseRaw : null);
    if (is_array($fuelExpense)) {
        if (!isset($fuelExpense['totalKmDriven']) && isset($fuelExpense['finalOdometerReading']) && isset($fuelExpense['initialOdometerReading'])) {
            $diff = floatval($fuelExpense['finalOdometerReading']) - floatval($fuelExpense['initialOdometerReading']);
            if ($diff >= 0) {
                $fuelExpense['totalKmDriven'] = round($diff * 10) / 10;
            }
        }
    }
    $fuelExpenseJson = $fuelExpense ? json_encode($fuelExpense) : ($fuelExpenseRaw && is_string($fuelExpenseRaw) ? $fuelExpenseRaw : null);

    $stmt = $pdo->prepare("
        INSERT INTO `solar_attendance` (
            `id`, `employee_id`, `employee_name`, `attendance_date`, `check_in_time`,
            `check_out_time`, `check_in_gps_json`, `check_out_gps_json`, `site_project_id`,
            `site_project_title`, `status`, `fuel_expense_json`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `employee_id` = VALUES(`employee_id`),
            `employee_name` = VALUES(`employee_name`),
            `attendance_date` = VALUES(`attendance_date`),
            `check_in_time` = VALUES(`check_in_time`),
            `check_out_time` = VALUES(`check_out_time`),
            `check_in_gps_json` = VALUES(`check_in_gps_json`),
            `check_out_gps_json` = VALUES(`check_out_gps_json`),
            `site_project_id` = VALUES(`site_project_id`),
            `site_project_title` = VALUES(`site_project_title`),
            `status` = VALUES(`status`),
            `fuel_expense_json` = VALUES(`fuel_expense_json`)
    ");
    $stmt->execute([
        $item['id'], $empId, $empName, $attDate, $checkInTime,
        $checkOutTime, $checkInGpsJson, $checkOutGpsJson, $projId,
        $projTitle, $status, $fuelExpenseJson
    ]);

    $item['employeeId'] = $empId;
    $item['employeeName'] = $empName;
    $item['attendanceDate'] = $attDate;
    $item['date'] = $attDate;
    if ($checkInGpsParsed) {
        $item['checkInGps'] = $checkInGpsParsed;
        $item['checkInGPS'] = $checkInGpsParsed;
    }
    if ($checkOutGpsParsed) {
        $item['checkOutGps'] = $checkOutGpsParsed;
        $item['checkOutGPS'] = $checkOutGpsParsed;
    }
    if ($fuelExpense !== null) {
        $item['fuelExpense'] = $fuelExpense;
    }
    return $item;
}

// Helper: Payslips
function savePayslipToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'slip-' . round(microtime(true) * 1000);
    $empId = $item['employeeId'] ?? $item['employee_id'] ?? '';
    $empName = $item['employeeName'] ?? $item['employee_name'] ?? 'Employee';
    $month = $item['month'] ?? date('F');
    $year = intval($item['year'] ?? date('Y'));
    $basic = floatval($item['baseSalary'] ?? $item['basicSalary'] ?? $item['basic_salary'] ?? 0);
    $allow = floatval($item['overtimeAmount'] ?? $item['allowances'] ?? 0);
    $additionalExpenses = $item['additionalExpenses'] ?? $item['additional_expenses'] ?? [];
    $additionalExpensesJson = is_string($additionalExpenses) ? $additionalExpenses : json_encode($additionalExpenses);
    $totalExpenses = floatval($item['totalAdditionalExpenses'] ?? (is_array($additionalExpenses) ? array_reduce($additionalExpenses, fn($carry, $x) => $carry + floatval($x['amount'] ?? 0), 0) : 0));
    $dedList = $item['deductions'] ?? [];
    $deductionsJson = is_array($dedList) ? json_encode($dedList) : (is_string($dedList) ? $dedList : '[]');
    $ded = floatval($item['totalDeductions'] ?? (is_array($dedList) ? array_reduce($dedList, fn($carry, $x) => $carry + floatval($x['amount'] ?? 0), 0) : floatval($item['deductions'] ?? 0)));
    $net = floatval($item['netPay'] ?? $item['netSalary'] ?? $item['net_salary'] ?? max(0, $basic + $allow + $totalExpenses - $ded));
    $status = $item['status'] ?? $item['paymentStatus'] ?? $item['payment_status'] ?? 'PAID';
    $payDate = !empty($item['paymentDate'] ?? $item['payment_date']) ? substr($item['paymentDate'] ?? $item['payment_date'], 0, 10) : date('Y-m-d');
    $notes = $item['notes'] ?? '';
    $overtimeHours = floatval($item['overtimeHours'] ?? $item['overtime_hours'] ?? 0);
    $overtimeRate = floatval($item['overtimeRatePerHour'] ?? $item['overtime_rate'] ?? 0);
    $paymentMode = $item['paymentMode'] ?? $item['payment_mode'] ?? 'NEFT/RTGS Bank Transfer';
    $bankRefNo = $item['bankReferenceNo'] ?? $item['bank_reference_no'] ?? '';

    $stmt = $pdo->prepare("
        INSERT INTO `solar_payslips` (
            `id`, `employee_id`, `employee_name`, `month`, `year`,
            `basic_salary`, `allowances`, `deductions`, `net_salary`,
            `payment_status`, `payment_date`, `notes`,
            `additional_expenses_json`, `deductions_json`, `overtime_hours`, `overtime_rate`,
            `payment_mode`, `bank_reference_no`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `employee_name` = VALUES(`employee_name`),
            `month` = VALUES(`month`),
            `year` = VALUES(`year`),
            `basic_salary` = VALUES(`basic_salary`),
            `allowances` = VALUES(`allowances`),
            `deductions` = VALUES(`deductions`),
            `net_salary` = VALUES(`net_salary`),
            `payment_status` = VALUES(`payment_status`),
            `payment_date` = VALUES(`payment_date`),
            `notes` = VALUES(`notes`),
            `additional_expenses_json` = VALUES(`additional_expenses_json`),
            `deductions_json` = VALUES(`deductions_json`),
            `overtime_hours` = VALUES(`overtime_hours`),
            `overtime_rate` = VALUES(`overtime_rate`),
            `payment_mode` = VALUES(`payment_mode`),
            `bank_reference_no` = VALUES(`bank_reference_no`)
    ");
    $stmt->execute([
        $item['id'], $empId, $empName, $month, $year,
        $basic, $allow, $ded, $net,
        $status, $payDate, $notes,
        $additionalExpensesJson, $deductionsJson, $overtimeHours, $overtimeRate,
        $paymentMode, $bankRefNo
    ]);
    return $item;
}

// Helper: Holidays
function saveHolidayToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'hol-' . round(microtime(true) * 1000);
    $name = $item['name'] ?? 'Holiday';
    $hDate = !empty($item['holidayDate'] ?? $item['date'] ?? $item['holiday_date']) ? substr($item['holidayDate'] ?? $item['date'] ?? $item['holiday_date'], 0, 10) : date('Y-m-d');
    $type = $item['type'] ?? 'Mandatory';
    $desc = $item['description'] ?? '';

    $stmt = $pdo->prepare("
        INSERT INTO `solar_holidays` (`id`, `name`, `holiday_date`, `type`, `description`)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `name` = VALUES(`name`),
            `holiday_date` = VALUES(`holiday_date`),
            `type` = VALUES(`type`),
            `description` = VALUES(`description`)
    ");
    $stmt->execute([$item['id'], $name, $hDate, $type, $desc]);
    $item['holidayDate'] = $hDate;
    $item['date'] = $hDate;
    return $item;
}

// Helper: Quotations
function saveQuotationToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'qtn-' . round(microtime(true) * 1000);
    $qtnNumber = $item['quotationNumber'] ?? $item['quotation_number'] ?? $item['id'];
    $customerId = $item['customerId'] ?? $item['customer_id'] ?? '';
    $customerName = $item['customerName'] ?? $item['customer_name'] ?? 'Customer';
    $projectId = $item['projectId'] ?? $item['project_id'] ?? '';
    $capacityKw = floatval($item['capacityKw'] ?? $item['capacity_kw'] ?? 5);
    $ratePerWp = floatval($item['ratePerWp'] ?? $item['rate_per_wp'] ?? 0);
    $baseAmount = floatval($item['baseAmount'] ?? $item['base_amount'] ?? 0);
    $taxAmount = floatval($item['taxAmount'] ?? $item['tax_amount'] ?? 0);
    $panelBrand = $item['panelBrand'] ?? $item['panel_brand'] ?? '';
    $inverterBrand = $item['inverterBrand'] ?? $item['inverter_brand'] ?? '';
    $structureType = $item['structureType'] ?? $item['structure_type'] ?? '';
    $items = $item['items'] ?? [];
    $itemsJson = is_string($items) ? $items : json_encode($items);
    $subtotal = floatval($item['subtotal'] ?? 0);
    $discount = floatval($item['discountAmount'] ?? $item['discount_amount'] ?? 0);
    $gstPercent = floatval($item['gstPercent'] ?? $item['gst_percent'] ?? 13.8);
    $gstAmount = floatval($item['gstAmount'] ?? $item['gst_amount'] ?? 0);
    $totalAmount = floatval($item['totalAmount'] ?? $item['total_amount'] ?? ($subtotal + $gstAmount - $discount));
    $paymentTerms = $item['paymentTerms'] ?? $item['payment_terms'] ?? '';
    $warranty = $item['warrantyDetails'] ?? $item['warranty_details'] ?? '';
    $terms = $item['termsAndConditions'] ?? $item['terms_and_conditions'] ?? '';
    $status = $item['status'] ?? 'DRAFT';
    $validUntil = !empty($item['validUntil'] ?? $item['valid_until']) ? substr($item['validUntil'] ?? $item['valid_until'], 0, 10) : null;

    $stmt = $pdo->prepare("
        INSERT INTO `solar_quotations` (
            `id`, `quotation_number`, `customer_id`, `customer_name`, `project_id`,
            `capacity_kw`, `rate_per_wp`, `base_amount`, `tax_amount`, `panel_brand`,
            `inverter_brand`, `structure_type`, `items_json`, `subtotal`, `discount_amount`,
            `gst_percent`, `gst_amount`, `total_amount`, `payment_terms`, `warranty_details`,
            `terms_and_conditions`, `status`, `valid_until`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `customer_name` = VALUES(`customer_name`),
            `capacity_kw` = VALUES(`capacity_kw`),
            `rate_per_wp` = VALUES(`rate_per_wp`),
            `base_amount` = VALUES(`base_amount`),
            `tax_amount` = VALUES(`tax_amount`),
            `panel_brand` = VALUES(`panel_brand`),
            `inverter_brand` = VALUES(`inverter_brand`),
            `structure_type` = VALUES(`structure_type`),
            `items_json` = VALUES(`items_json`),
            `subtotal` = VALUES(`subtotal`),
            `discount_amount` = VALUES(`discount_amount`),
            `gst_percent` = VALUES(`gst_percent`),
            `gst_amount` = VALUES(`gst_amount`),
            `total_amount` = VALUES(`total_amount`),
            `payment_terms` = VALUES(`payment_terms`),
            `warranty_details` = VALUES(`warranty_details`),
            `terms_and_conditions` = VALUES(`terms_and_conditions`),
            `status` = VALUES(`status`),
            `valid_until` = VALUES(`valid_until`)
    ");
    $stmt->execute([
        $item['id'], $qtnNumber, $customerId, $customerName, $projectId,
        $capacityKw, $ratePerWp, $baseAmount, $taxAmount, $panelBrand,
        $inverterBrand, $structureType, $itemsJson, $subtotal, $discount,
        $gstPercent, $gstAmount, $totalAmount, $paymentTerms, $warranty,
        $terms, $status, $validUntil
    ]);
    return $item;
}

// Helper: Site Surveys
function saveSurveyToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'srv-' . round(microtime(true) * 1000);
    $projId = $item['projectId'] ?? $item['leadId'] ?? $item['project_id'] ?? '';
    $custId = $item['customerId'] ?? $item['customer_id'] ?? '';
    $engId = $item['engineerId'] ?? $item['engineer_id'] ?? '';
    $engName = $item['engineerName'] ?? $item['engineer_name'] ?? 'Site Engineer';
    $srvDate = !empty($item['surveyDate'] ?? $item['survey_date']) ? substr($item['surveyDate'] ?? $item['survey_date'], 0, 10) : date('Y-m-d');
    $status = $item['status'] ?? 'APPROVED';
    $siteAddr = $item['siteAddress'] ?? $item['address'] ?? $item['site_address'] ?? 'Site Address';
    $lat = !empty($item['latitude']) ? floatval($item['latitude']) : null;
    $lng = !empty($item['longitude']) ? floatval($item['longitude']) : null;
    $locName = $item['locationName'] ?? $item['city'] ?? $item['location_name'] ?? '';
    $roofType = $item['roofType'] ?? $item['roof_type'] ?? 'RCC Flat';
    $roofArea = floatval($item['roofAreaSqft'] ?? $item['roofAreaSqFt'] ?? $item['roof_area_sqft'] ?? 0);
    $shadowFreeArea = floatval($item['shadowFreeAreaSqft'] ?? $item['shadowFreeAreaSqFt'] ?? $item['shadow_free_area_sqft'] ?? 0);
    $obstacles = $item['shadowObstacles'] ?? $item['shadow_obstacles'] ?? '';
    $billNo = $item['electricityBillNumber'] ?? $item['electricity_bill_number'] ?? '';
    $consumption = floatval($item['monthlyAvgConsumption'] ?? $item['monthly_avg_consumption'] ?? 0);
    $load = floatval($item['sanctionedLoadKw'] ?? $item['sanctioned_load_kw'] ?? 0);
    $tariff = floatval($item['tariffRate'] ?? $item['tariff_rate'] ?? 0);
    $structureCond = $item['existingStructureCondition'] ?? $item['existing_structure_condition'] ?? '';
    $recCap = floatval($item['recommendedCapacityKw'] ?? $item['proposedCapacityKw'] ?? $item['recommended_capacity_kw'] ?? 0);
    $feasibility = $item['feasibilityScore'] ?? $item['feasibility_score'] ?? 'GOOD';
    $photos = $item['photos'] ?? [];
    $photosJson = is_string($photos) ? $photos : json_encode($photos);
    $notes = $item['notes'] ?? '';

    $stmt = $pdo->prepare("
        INSERT INTO `solar_site_surveys` (
            `id`, `project_id`, `customer_id`, `engineer_id`, `engineer_name`,
            `survey_date`, `status`, `site_address`, `latitude`, `longitude`,
            `location_name`, `roof_type`, `roof_area_sqft`, `shadow_free_area_sqft`,
            `shadow_obstacles`, `electricity_bill_number`, `monthly_avg_consumption`,
            `sanctioned_load_kw`, `tariff_rate`, `existing_structure_condition`,
            `recommended_capacity_kw`, `feasibility_score`, `photos_json`, `notes`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `engineer_name` = VALUES(`engineer_name`),
            `survey_date` = VALUES(`survey_date`),
            `status` = VALUES(`status`),
            `site_address` = VALUES(`site_address`),
            `latitude` = VALUES(`latitude`),
            `longitude` = VALUES(`longitude`),
            `location_name` = VALUES(`location_name`),
            `roof_type` = VALUES(`roof_type`),
            `roof_area_sqft` = VALUES(`roof_area_sqft`),
            `shadow_free_area_sqft` = VALUES(`shadow_free_area_sqft`),
            `recommended_capacity_kw` = VALUES(`recommended_capacity_kw`),
            `feasibility_score` = VALUES(`feasibility_score`),
            `photos_json` = VALUES(`photos_json`),
            `notes` = VALUES(`notes`)
    ");
    $stmt->execute([
        $item['id'], $projId, $custId, $engId, $engName,
        $srvDate, $status, $siteAddr, $lat, $lng,
        $locName, $roofType, $roofArea, $shadowFreeArea,
        $obstacles, $billNo, $consumption,
        $load, $tariff, $structureCond,
        $recCap, $feasibility, $photosJson, $notes
    ]);
    return $item;
}

// Helper: Warehouses
function saveWarehouseToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('wh-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_warehouses', $id);
    $name = $item['name'] ?? ($ex['name'] ?? 'Main Warehouse');
    $code = $item['code'] ?? ($ex['code'] ?? $id);
    $address = $item['address'] ?? ($ex['address'] ?? '');
    $city = $item['city'] ?? ($ex['city'] ?? '');
    $state = $item['state'] ?? ($ex['state'] ?? '');
    $pincode = $item['pincode'] ?? ($ex['pincode'] ?? '');
    $contactPerson = $item['contactPerson'] ?? $item['managerName'] ?? $item['manager_name'] ?? ($ex['manager_name'] ?? '');
    $contactPhone = $item['contactPhone'] ?? $item['managerPhone'] ?? $item['manager_phone'] ?? ($ex['manager_phone'] ?? '');
    $email = $item['email'] ?? ($ex['email'] ?? '');
    $gst = $item['gstNumber'] ?? $item['gst_number'] ?? ($ex['gst_number'] ?? '');
    $capacitySqFt = isset($item['capacitySqFt']) ? floatval($item['capacitySqFt']) : floatval($ex['capacity_sq_ft'] ?? 15000);
    $status = $item['status'] ?? (isset($item['isActive']) && !$item['isActive'] ? 'INACTIVE' : ($ex['status'] ?? ((isset($ex['is_active']) && intval($ex['is_active']) === 0) ? 'INACTIVE' : 'ACTIVE')));
    $isActive = ($status === 'ACTIVE') ? 1 : 0;
    $isDefault = (isset($item['isDefault']) ? (bool)$item['isDefault'] : (bool)($ex['is_default'] ?? 0)) ? 1 : 0;
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');

    if ($isDefault) {
        $pdo->prepare("UPDATE `solar_warehouses` SET `is_default` = 0 WHERE `id` != ?")->execute([$id]);
    }

    $stmt = $pdo->prepare("
        INSERT INTO `solar_warehouses` (
            `id`, `name`, `code`, `address`, `city`, `state`,
            `pincode`, `manager_name`, `manager_phone`, `email`, `gst_number`,
            `capacity_sq_ft`, `is_active`, `status`, `is_default`, `notes`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `name` = VALUES(`name`),
            `code` = VALUES(`code`),
            `address` = VALUES(`address`),
            `city` = VALUES(`city`),
            `state` = VALUES(`state`),
            `pincode` = VALUES(`pincode`),
            `manager_name` = VALUES(`manager_name`),
            `manager_phone` = VALUES(`manager_phone`),
            `email` = VALUES(`email`),
            `gst_number` = VALUES(`gst_number`),
            `capacity_sq_ft` = VALUES(`capacity_sq_ft`),
            `is_active` = VALUES(`is_active`),
            `status` = VALUES(`status`),
            `is_default` = VALUES(`is_default`),
            `notes` = VALUES(`notes`)
    ");
    $stmt->execute([
        $id, $name, $code, $address, $city, $state,
        $pincode, $contactPerson, $contactPhone, $email, $gst,
        $capacitySqFt, $isActive, $status, $isDefault, $notes
    ]);

    return array_merge($item, [
        'id' => $id,
        'name' => $name,
        'code' => $code,
        'address' => $address,
        'city' => $city,
        'state' => $state,
        'pincode' => $pincode,
        'contactPerson' => $contactPerson,
        'contactPhone' => $contactPhone,
        'managerName' => $contactPerson,
        'managerPhone' => $contactPhone,
        'email' => $email,
        'gstNumber' => $gst,
        'capacitySqFt' => $capacitySqFt,
        'isActive' => (bool)$isActive,
        'status' => $status,
        'isDefault' => (bool)$isDefault,
        'notes' => $notes,
        'createdAt' => $item['createdAt'] ?? ($ex['created_at'] ?? date('c')),
        'updatedAt' => date('c')
    ]);
}

// Helper: Stock Movements
function saveStockMovementToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('sm-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_stock_movements', $id);
    $prodId = $item['productId'] ?? $item['product_id'] ?? ($ex['product_id'] ?? '');
    $prodName = $item['productName'] ?? $item['product_name'] ?? ($ex['product_name'] ?? 'Product');
    $sku = $item['sku'] ?? ($ex['sku'] ?? '');
    $type = $item['type'] ?? $item['movementType'] ?? $item['movement_type'] ?? ($ex['movement_type'] ?? 'IN');
    $qty = floatval($item['quantity'] ?? ($ex['quantity'] ?? 0));
    $balance = floatval($item['balanceAfter'] ?? $item['balance_after'] ?? ($ex['balance_after'] ?? 0));
    $refNo = $item['referenceNumber'] ?? $item['reference_number'] ?? ($ex['reference_number'] ?? '');
    $refId = $item['referenceId'] ?? $item['reference_id'] ?? ($ex['reference_id'] ?? '');
    $whId = $item['warehouseId'] ?? $item['warehouse_id'] ?? ($ex['warehouse_id'] ?? '');
    $whName = $item['warehouseName'] ?? $item['warehouse_name'] ?? ($ex['warehouse_name'] ?? '');
    $targetWhId = $item['targetWarehouseId'] ?? $item['target_warehouse_id'] ?? ($ex['target_warehouse_id'] ?? '');
    $targetWhName = $item['targetWarehouseName'] ?? $item['target_warehouse_name'] ?? ($ex['target_warehouse_name'] ?? '');
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');
    $rawTs = $item['timestamp'] ?? ($ex['timestamp'] ?? null);
    $ts = !empty($rawTs) ? date('Y-m-d H:i:s', strtotime($rawTs)) : date('Y-m-d H:i:s');
    $by = $item['performedBy'] ?? $item['performed_by'] ?? ($ex['performed_by'] ?? 'System');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_stock_movements` (
            `id`, `product_id`, `product_name`, `sku`, `movement_type`,
            `quantity`, `balance_after`, `reference_number`, `reference_id`,
            `warehouse_id`, `warehouse_name`, `target_warehouse_id`, `target_warehouse_name`,
            `notes`, `timestamp`, `performed_by`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `product_name` = VALUES(`product_name`),
            `movement_type` = VALUES(`movement_type`),
            `quantity` = VALUES(`quantity`),
            `balance_after` = VALUES(`balance_after`),
            `warehouse_id` = VALUES(`warehouse_id`),
            `warehouse_name` = VALUES(`warehouse_name`),
            `target_warehouse_id` = VALUES(`target_warehouse_id`),
            `target_warehouse_name` = VALUES(`target_warehouse_name`),
            `notes` = VALUES(`notes`)
    ");
    $stmt->execute([
        $id, $prodId, $prodName, $sku, $type,
        $qty, $balance, $refNo, $refId,
        $whId, $whName, $targetWhId, $targetWhName,
        $notes, $ts, $by
    ]);

    return array_merge($item, [
        'id' => $id,
        'productId' => $prodId,
        'productName' => $prodName,
        'sku' => $sku,
        'type' => $type,
        'movementType' => $type,
        'quantity' => $qty,
        'balanceAfter' => $balance,
        'referenceNumber' => $refNo,
        'referenceId' => $refId,
        'warehouseId' => $whId,
        'warehouseName' => $whName,
        'targetWarehouseId' => $targetWhId ?: null,
        'targetWarehouseName' => $targetWhName ?: null,
        'notes' => $notes,
        'timestamp' => $item['timestamp'] ?? date('c'),
        'performedBy' => $by
    ]);
}

// Helper: Stock Audits
function saveStockAuditToDb($pdo, $item) {
    $id = !empty($item['id']) ? $item['id'] : ('audit-' . round(microtime(true) * 1000));
    $ex = fetchExistingRowPhp($pdo, 'solar_stock_audits', $id);
    $auditNo = $item['auditNumber'] ?? $item['audit_number'] ?? ($ex['audit_number'] ?? ('AUD-' . date('Y') . '-' . rand(100, 999)));
    $whId = $item['warehouseId'] ?? $item['warehouse_id'] ?? ($ex['warehouse_id'] ?? '');
    $whName = $item['warehouseName'] ?? $item['warehouse_name'] ?? ($ex['warehouse_name'] ?? 'Warehouse');
    $rawDate = $item['auditDate'] ?? $item['audit_date'] ?? ($ex['audit_date'] ?? null);
    $auditDate = !empty($rawDate) ? substr((string)$rawDate, 0, 10) : date('Y-m-d');
    $auditorName = $item['auditedBy'] ?? $item['auditorName'] ?? $item['auditor_name'] ?? ($ex['auditor_name'] ?? 'Auditor');
    $status = $item['status'] ?? ($ex['status'] ?? 'COMPLETED');
    $items = $item['items'] ?? (!empty($ex['items_json']) ? json_decode($ex['items_json'], true) : []);
    $itemsArr = is_string($items) ? (json_decode($items, true) ?: []) : $items;
    $itemsJson = is_string($items) ? $items : json_encode($items);
    $discrepancies = intval($item['discrepanciesFound'] ?? $item['discrepanciesCount'] ?? $item['discrepancies_count'] ?? ($ex['discrepancies_count'] ?? 0));
    $itemsAudited = intval($item['itemsAudited'] ?? $item['items_audited'] ?? ($ex['items_audited'] ?? count($itemsArr)));
    $netAdj = floatval($item['netAdjustmentValue'] ?? $item['net_adjustment_value'] ?? ($ex['net_adjustment_value'] ?? 0));
    $notes = $item['notes'] ?? ($ex['notes'] ?? '');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_stock_audits` (
            `id`, `audit_number`, `warehouse_id`, `warehouse_name`, `audit_date`,
            `auditor_name`, `status`, `items_audited`, `discrepancies_count`, `net_adjustment_value`,
            `items_json`, `notes`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `warehouse_name` = VALUES(`warehouse_name`),
            `status` = VALUES(`status`),
            `items_audited` = VALUES(`items_audited`),
            `discrepancies_count` = VALUES(`discrepancies_count`),
            `net_adjustment_value` = VALUES(`net_adjustment_value`),
            `items_json` = VALUES(`items_json`),
            `notes` = VALUES(`notes`)
    ");
    $stmt->execute([
        $id, $auditNo, $whId, $whName, $auditDate,
        $auditorName, $status, $itemsAudited, $discrepancies, $netAdj, $itemsJson, $notes
    ]);

    return array_merge($item, [
        'id' => $id,
        'auditNumber' => $auditNo,
        'warehouseId' => $whId,
        'warehouseName' => $whName,
        'auditDate' => $auditDate,
        'auditedBy' => $auditorName,
        'auditorName' => $auditorName,
        'status' => $status,
        'itemsAudited' => $itemsAudited,
        'discrepanciesFound' => $discrepancies,
        'discrepanciesCount' => $discrepancies,
        'netAdjustmentValue' => $netAdj,
        'items' => $itemsArr,
        'notes' => $notes,
        'createdAt' => $item['createdAt'] ?? ($ex['created_at'] ?? date('c'))
    ]);
}

// Helper: Service Tickets (with Admin Assignment & Audit History)
function normalizeTicketTechnicianPhp($techIdRaw, $techNameRaw) {
    $cleanId = trim((string)($techIdRaw ?? ''));
    $cleanName = trim((string)($techNameRaw ?? ''));
    $lowerName = strtolower($cleanName);
    $isPlaceholder = ($cleanName === '' || $lowerName === 'unassigned' || $lowerName === 'to be assigned');
    if ($cleanId === '' && $isPlaceholder) {
        return [
            'assignedTechnicianId' => '',
            'assignedTechnicianName' => '',
            'assignmentStatus' => 'UNASSIGNED'
        ];
    }
    return [
        'assignedTechnicianId' => $cleanId,
        'assignedTechnicianName' => $isPlaceholder ? '' : $cleanName,
        'assignmentStatus' => ($cleanId !== '' || !$isPlaceholder) ? 'ASSIGNED' : 'UNASSIGNED'
    ];
}

function mapTicketHistoryRowPhp($h) {
    return [
        'id' => $h['id'],
        'ticketRecordId' => $h['ticket_record_id'],
        'ticketCode' => $h['ticket_code'] ?? '',
        'actionType' => $h['action_type'],
        'previousValue' => $h['previous_value'] ?? null,
        'newValue' => $h['new_value'] ?? null,
        'remarks' => $h['remarks'] ?? null,
        'actorUserId' => $h['actor_user_id'] ?? '',
        'actorName' => $h['actor_name'] ?: 'System',
        'actorRole' => $h['actor_role'] ?? '',
        'createdAt' => !empty($h['created_at']) ? date('c', strtotime($h['created_at'])) : date('c')
    ];
}

function mapServiceTicketRowPhp($r, $historyRows = []) {
    $tech = normalizeTicketTechnicianPhp($r['assigned_technician_id'] ?? '', $r['assigned_technician_name'] ?? '');
    $photos = json_decode($r['photos_json'] ?? '[]', true);
    if (!is_array($photos)) $photos = [];
    return [
        'id' => $r['id'],
        'ticketId' => $r['ticket_id'],
        'ticketNumber' => $r['ticket_id'],
        'customerId' => $r['customer_id'] ?? '',
        'customerName' => $r['customer_name'] ?? '',
        'projectId' => $r['project_id'] ?? '',
        'projectTitle' => $r['project_title'] ?? '',
        'projectCode' => $r['project_title'] ?? '',
        'title' => $r['issue'],
        'issue' => $r['issue'],
        'description' => $r['issue'],
        'category' => $r['category'] ?? 'Inverter Warning',
        'priority' => $r['priority'] ?? 'MEDIUM',
        'status' => $r['status'] ?? 'OPEN',
        'assignedTechnicianId' => $tech['assignedTechnicianId'],
        'assignedTechnicianName' => $tech['assignedTechnicianName'],
        'assignedToName' => $tech['assignedTechnicianName'] !== '' ? $tech['assignedTechnicianName'] : 'Unassigned',
        'assignedEngineerId' => $tech['assignedTechnicianId'],
        'assignedEngineerName' => $tech['assignedTechnicianName'],
        'assignmentStatus' => $tech['assignmentStatus'],
        'scheduledDate' => $r['scheduled_date'] ?? null,
        'visitScheduledDate' => $r['scheduled_date'] ?? null,
        'createdDate' => $r['scheduled_date'] ?? $r['created_at'],
        'resolvedDate' => $r['resolved_date'] ?? null,
        'notes' => $r['notes'] ?? '',
        'technicianRemarks' => $r['technician_remarks'] ?? '',
        'resolutionDetails' => $r['resolution_details'] ?? '',
        'assignedAt' => !empty($r['assigned_at']) ? date('c', strtotime($r['assigned_at'])) : null,
        'assignedByUserId' => $r['assigned_by_user_id'] ?? null,
        'assignedByName' => $r['assigned_by_name'] ?? null,
        'photos' => $photos,
        'createdAt' => $r['created_at'],
        'updatedAt' => $r['updated_at'] ?? $r['created_at'],
        'activityHistory' => $historyRows
    ];
}

function recordServiceTicketHistoryPhp($pdo, $ticketRecordId, $ticketCode, $actionType, $prevVal, $newVal, $remarks, $actor = null) {
    $id = 'srvhist-' . round(microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(3)), 0, 5);
    $actorId = is_array($actor) ? trim((string)($actor['id'] ?? $actor['userId'] ?? '')) : '';
    $actorName = is_array($actor) ? trim((string)($actor['name'] ?? $actor['email'] ?? 'System')) : 'System';
    $actorRole = is_array($actor) ? trim((string)($actor['role'] ?? '')) : '';
    $pdo->prepare("
        INSERT INTO `solar_service_ticket_history`
        (`id`, `ticket_record_id`, `ticket_code`, `action_type`, `previous_value`, `new_value`, `remarks`, `actor_user_id`, `actor_name`, `actor_role`)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ")->execute([$id, $ticketRecordId, $ticketCode ?: '', $actionType, $prevVal, $newVal, $remarks, $actorId, $actorName, $actorRole]);
    return [
        'id' => $id,
        'ticketRecordId' => $ticketRecordId,
        'ticketCode' => $ticketCode ?: '',
        'actionType' => $actionType,
        'previousValue' => $prevVal,
        'newValue' => $newVal,
        'remarks' => $remarks,
        'actorUserId' => $actorId,
        'actorName' => $actorName,
        'actorRole' => $actorRole,
        'createdAt' => date('c')
    ];
}

function getServiceTicketHistoryPhp($pdo, $ticketRecordId) {
    try {
        $stmt = $pdo->prepare('SELECT * FROM `solar_service_ticket_history` WHERE `ticket_record_id` = ? ORDER BY `created_at` DESC, `id` DESC');
        $stmt->execute([$ticketRecordId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        return array_map('mapTicketHistoryRowPhp', $rows);
    } catch (Exception $e) {
        return [];
    }
}

function getServiceTicketRowPhp($pdo, $idOrCode) {
    $clean = trim((string)$idOrCode);
    if ($clean === '') return null;
    $stmt = $pdo->prepare('SELECT * FROM `solar_service_tickets` WHERE `id` = ? OR `ticket_id` = ? LIMIT 1');
    $stmt->execute([$clean, $clean]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function getEligibleServiceTechniciansPhp($pdo) {
    $seenIds = [];
    $seenEmails = [];
    $results = [];

    $addIfEligible = function ($rec) use (&$seenIds, &$seenEmails, &$results) {
        if (empty($rec['active'])) return;
        if (!isEligibleFieldWorkerPhp($rec['role'], $rec['isFieldWorker'], $rec['department'])) return;
        $idKey = strtolower(trim((string)$rec['id']));
        $emailKey = strtolower(trim((string)$rec['email']));
        if ($idKey === '') return;
        if (isset($seenIds[$idKey]) || ($emailKey !== '' && isset($seenEmails[$emailKey]))) return;
        $seenIds[$idKey] = true;
        if ($emailKey !== '') $seenEmails[$emailKey] = true;
        $results[] = [
            'id' => $rec['id'],
            'employeeCode' => $rec['employeeCode'] ?: $rec['id'],
            'name' => $rec['name'],
            'email' => $rec['email'],
            'phone' => $rec['phone'],
            'role' => $rec['role'],
            'department' => $rec['department'],
            'designation' => $rec['designation'] ?: $rec['role'],
            'isFieldWorker' => true,
            'status' => 'ACTIVE'
        ];
    };

    foreach (['solar_employees', 'solar_employee'] as $tbl) {
        try {
            $stmt = $pdo->query("SELECT * FROM `$tbl` ORDER BY `name` ASC");
            $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            foreach ($rows as $e) {
                $status = strtoupper((string)($e['status'] ?? 'ACTIVE'));
                $acctStatus = strtoupper((string)($e['account_status'] ?? 'ACTIVE'));
                $role = (string)($e['system_role'] ?? $e['assigned_role'] ?? $e['designation'] ?? 'Technician');
                $active = ($status !== 'DISABLED' && $status !== 'INACTIVE' && $status !== 'TERMINATED' && $acctStatus !== 'DISABLED' && strtolower($role) !== 'customer');
                $addIfEligible([
                    'id' => (string)($e['id'] ?? ''),
                    'employeeCode' => (string)($e['employee_code'] ?? $e['id'] ?? ''),
                    'name' => (string)($e['name'] ?? 'Technician'),
                    'email' => strtolower(trim((string)($e['email'] ?? ''))),
                    'role' => $role,
                    'department' => (string)($e['department'] ?? 'Service'),
                    'designation' => (string)($e['designation'] ?? $role),
                    'phone' => (string)($e['phone'] ?? ''),
                    'isFieldWorker' => !empty($e['is_field_worker']),
                    'active' => $active
                ]);
            }
            if (!empty($rows)) break;
        } catch (Exception $e) {}
    }

    try {
        $stmtU = $pdo->query('SELECT * FROM `solar_users` ORDER BY `name` ASC');
        $uRows = $stmtU ? $stmtU->fetchAll(PDO::FETCH_ASSOC) : [];
        foreach ($uRows as $u) {
            $status = strtoupper((string)($u['status'] ?? 'ACTIVE'));
            $role = (string)($u['role'] ?? 'Staff');
            $active = ($status !== 'DISABLED' && $status !== 'INACTIVE' && strtolower($role) !== 'customer');
            $addIfEligible([
                'id' => (string)($u['id'] ?? ''),
                'employeeCode' => (string)($u['employee_id'] ?? $u['id'] ?? ''),
                'name' => (string)($u['name'] ?? 'Technician'),
                'email' => strtolower(trim((string)($u['email'] ?? ''))),
                'role' => $role,
                'department' => (string)($u['department'] ?? 'Service'),
                'designation' => (string)($u['designation'] ?? $role),
                'phone' => (string)($u['phone'] ?? ''),
                'isFieldWorker' => !empty($u['is_field_worker']),
                'active' => $active
            ]);
        }
    } catch (Exception $e) {}

    usort($results, function ($a, $b) {
        return strcasecmp($a['name'], $b['name']);
    });
    return $results;
}

function getServiceTicketDetailsPhp($pdo, $idOrCode) {
    $row = getServiceTicketRowPhp($pdo, $idOrCode);
    if (!$row) return null;
    $history = getServiceTicketHistoryPhp($pdo, $row['id']);
    $ticket = mapServiceTicketRowPhp($row, $history);

    $customer = null;
    try {
        if (!empty($row['customer_id'])) {
            $sc = $pdo->prepare('SELECT * FROM `solar_customers` WHERE `id` = ? LIMIT 1');
            $sc->execute([$row['customer_id']]);
            $customer = $sc->fetch(PDO::FETCH_ASSOC) ?: null;
        }
        if (!$customer && !empty($row['customer_name'])) {
            $sc2 = $pdo->prepare('SELECT * FROM `solar_customers` WHERE LOWER(`name`) = LOWER(?) LIMIT 1');
            $sc2->execute([$row['customer_name']]);
            $customer = $sc2->fetch(PDO::FETCH_ASSOC) ?: null;
        }
    } catch (Exception $e) {}

    $project = null;
    try {
        if (!empty($row['project_id'])) {
            $sp = $pdo->prepare('SELECT * FROM `solar_projects` WHERE `id` = ? OR `project_code` = ? LIMIT 1');
            $sp->execute([$row['project_id'], $row['project_id']]);
            $project = $sp->fetch(PDO::FETCH_ASSOC) ?: null;
        }
        if (!$project && ($customer['active_project_id'] ?? $customer['id'] ?? '')) {
            $sp2 = $pdo->prepare('SELECT * FROM `solar_projects` WHERE `id` = ? OR `customer_id` = ? ORDER BY `created_at` DESC LIMIT 1');
            $sp2->execute([$customer['active_project_id'] ?? '', $customer['id'] ?? '']);
            $project = $sp2->fetch(PDO::FETCH_ASSOC) ?: null;
        }
    } catch (Exception $e) {}

    $amc = null;
    try {
        $tpId = $project['id'] ?? ($row['project_id'] ?? '');
        $tcId = $customer['id'] ?? ($row['customer_id'] ?? '');
        if ($tpId !== '' || $tcId !== '') {
            $sa = $pdo->prepare('SELECT * FROM `solar_amc_contracts` WHERE (`project_id` = ? AND ? != "") OR (`customer_id` = ? AND ? != "") ORDER BY `end_date` DESC LIMIT 1');
            $sa->execute([$tpId, $tpId, $tcId, $tcId]);
            $amc = $sa->fetch(PDO::FETCH_ASSOC) ?: null;
        }
    } catch (Exception $e) {}

    $assignedTech = null;
    if (!empty($ticket['assignedTechnicianId'])) {
        try {
            $se = $pdo->prepare('SELECT `id`, `employee_code`, `name`, `email`, `phone`, `department`, `designation`, `system_role`, `status` FROM `solar_employees` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 1');
            $se->execute([$ticket['assignedTechnicianId'], $ticket['assignedTechnicianId'], $ticket['assignedTechnicianId']]);
            $te = $se->fetch(PDO::FETCH_ASSOC);
            if ($te) {
                $assignedTech = [
                    'id' => $te['id'],
                    'employeeCode' => $te['employee_code'] ?? $te['id'],
                    'name' => $te['name'],
                    'email' => $te['email'] ?? '',
                    'phone' => $te['phone'] ?? '',
                    'department' => $te['department'] ?? 'Service',
                    'designation' => $te['designation'] ?? ($te['system_role'] ?? 'Technician'),
                    'role' => $te['system_role'] ?? 'Technician',
                    'status' => $te['status'] ?? 'ACTIVE'
                ];
            }
        } catch (Exception $e) {}
    }

    $ticket['customerDetails'] = $customer ? [
        'id' => $customer['id'],
        'customerCode' => $customer['customer_code'],
        'name' => $customer['name'],
        'companyName' => $customer['company_name'] ?? '',
        'phone' => $customer['phone'] ?? '',
        'email' => $customer['email'] ?? '',
        'siteAddress' => $customer['site_address'] ?? '',
        'city' => $customer['city'] ?? '',
        'state' => $customer['state'] ?? '',
        'pincode' => $customer['pincode'] ?? '',
        'electricityConsumerNo' => $customer['electricity_consumer_no'] ?? '',
        'sanctionedLoadKw' => floatval($customer['sanctioned_load_kw'] ?? 0)
    ] : null;
    $ticket['projectDetails'] = $project ? [
        'id' => $project['id'],
        'projectCode' => $project['project_code'],
        'title' => $project['title'],
        'capacityKw' => floatval($project['capacity_kw'] ?? 0),
        'status' => $project['status'],
        'currentStageKey' => $project['current_stage_key'] ?? '',
        'completionPercentage' => floatval($project['completion_percentage'] ?? 0),
        'startDate' => $project['start_date'] ?? null,
        'targetCompletionDate' => $project['target_completion_date'] ?? null,
        'siteAddress' => $customer['site_address'] ?? ''
    ] : null;
    $ticket['amcDetails'] = $amc ? [
        'id' => $amc['id'],
        'amcCode' => $amc['amc_code'],
        'planName' => $amc['plan_name'],
        'startDate' => $amc['start_date'],
        'endDate' => $amc['end_date'],
        'renewalDate' => $amc['renewal_date'],
        'annualAmount' => floatval($amc['annual_amount'] ?? 0),
        'visitsCompleted' => intval($amc['visits_completed'] ?? 0),
        'totalVisits' => intval($amc['total_visits'] ?? 4),
        'status' => $amc['status']
    ] : null;
    $ticket['assignedTechnicianDetails'] = $assignedTech;
    return $ticket;
}

function saveServiceTicketToDb($pdo, $item, $actor = null) {
    if (empty($item['id'])) $item['id'] = 'srv-' . round(microtime(true) * 1000);
    $existing = getServiceTicketRowPhp($pdo, $item['id']);

    $tktId = $item['ticketId'] ?? $item['ticketNumber'] ?? $item['ticket_id'] ?? ($existing['ticket_id'] ?? $item['id']);
    $custId = $item['customerId'] ?? $item['customer_id'] ?? ($existing['customer_id'] ?? '');
    $custName = $item['customerName'] ?? $item['customer_name'] ?? ($existing['customer_name'] ?? 'Customer');
    $projId = $item['projectId'] ?? $item['project_id'] ?? ($existing['project_id'] ?? '');
    $projTitle = $item['projectTitle'] ?? $item['projectCode'] ?? $item['project_title'] ?? ($existing['project_title'] ?? 'Solar Project Installation');
    $issue = $item['issue'] ?? $item['title'] ?? $item['description'] ?? ($existing['issue'] ?? 'Service Ticket Alert');
    $category = $item['category'] ?? ($existing['category'] ?? 'Inverter Warning');
    $priority = $item['priority'] ?? ($existing['priority'] ?? 'MEDIUM');
    $rawTechId = $item['assignedTechnicianId'] ?? $item['assignedEngineerId'] ?? $item['assigned_technician_id'] ?? ($existing['assigned_technician_id'] ?? '');
    $rawTechName = $item['assignedTechnicianName'] ?? $item['assignedEngineerName'] ?? $item['assigned_technician_name'] ?? ($existing['assigned_technician_name'] ?? '');
    $normTech = normalizeTicketTechnicianPhp($rawTechId, $rawTechName);
    $status = $item['status'] ?? ($existing['status'] ?? 'OPEN');
    $rawSched = $item['scheduledDate'] ?? $item['visitScheduledDate'] ?? $item['scheduled_date'] ?? ($existing['scheduled_date'] ?? null);
    $schedDate = !empty($rawSched) ? substr((string)$rawSched, 0, 10) : null;
    $rawRes = $item['resolvedDate'] ?? $item['resolved_date'] ?? ($existing['resolved_date'] ?? null);
    $resolvedDate = !empty($rawRes) ? substr((string)$rawRes, 0, 10) : null;
    $notes = $item['notes'] ?? ($existing['notes'] ?? '');
    $techRemarks = $item['technicianRemarks'] ?? $item['technician_remarks'] ?? ($existing['technician_remarks'] ?? '');
    $resDetails = $item['resolutionDetails'] ?? $item['resolution_details'] ?? ($existing['resolution_details'] ?? '');
    $photos = $item['photos'] ?? ($existing ? (json_decode($existing['photos_json'] ?? '[]', true) ?: []) : []);
    $photosJson = is_string($photos) ? $photos : json_encode($photos);

    $stmt = $pdo->prepare("
        INSERT INTO `solar_service_tickets` (
            `id`, `ticket_id`, `customer_id`, `customer_name`, `project_id`,
            `project_title`, `issue`, `category`, `priority`,
            `assigned_technician_id`, `assigned_technician_name`, `status`,
            `scheduled_date`, `resolved_date`, `notes`, `technician_remarks`, `resolution_details`, `photos_json`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `customer_id` = VALUES(`customer_id`),
            `customer_name` = VALUES(`customer_name`),
            `project_id` = VALUES(`project_id`),
            `project_title` = VALUES(`project_title`),
            `issue` = VALUES(`issue`),
            `category` = VALUES(`category`),
            `priority` = VALUES(`priority`),
            `status` = VALUES(`status`),
            `assigned_technician_id` = VALUES(`assigned_technician_id`),
            `assigned_technician_name` = VALUES(`assigned_technician_name`),
            `scheduled_date` = VALUES(`scheduled_date`),
            `resolved_date` = VALUES(`resolved_date`),
            `notes` = VALUES(`notes`),
            `technician_remarks` = VALUES(`technician_remarks`),
            `resolution_details` = VALUES(`resolution_details`),
            `photos_json` = VALUES(`photos_json`)
    ");
    $stmt->execute([
        $item['id'], $tktId, $custId, $custName, $projId,
        $projTitle, $issue, $category, $priority,
        $normTech['assignedTechnicianId'], $normTech['assignedTechnicianName'], $status,
        $schedDate, $resolvedDate, $notes, $techRemarks, $resDetails, $photosJson
    ]);

    if (!$existing) {
        try {
            recordServiceTicketHistoryPhp($pdo, $item['id'], $tktId, 'CREATED', null, "Status: $status | Priority: $priority", $issue, $actor);
        } catch (Exception $e) {}
    }

    $row = getServiceTicketRowPhp($pdo, $item['id']);
    return $row ? mapServiceTicketRowPhp($row, getServiceTicketHistoryPhp($pdo, $row['id'])) : $item;
}

function assignServiceTicketTechnicianPhp($pdo, $idOrCode, $payload, $actor) {
    $existing = getServiceTicketRowPhp($pdo, $idOrCode);
    if (!$existing) {
        throw new Exception('Service ticket not found in MySQL.', 404);
    }
    $requestedTechId = trim((string)($payload['technicianId'] ?? ($payload['assignedTechnicianId'] ?? '')));
    $prevTech = normalizeTicketTechnicianPhp($existing['assigned_technician_id'] ?? '', $existing['assigned_technician_name'] ?? '');
    $nextTechId = '';
    $nextTechName = '';

    if ($requestedTechId !== '') {
        $eligible = getEligibleServiceTechniciansPhp($pdo);
        $matched = null;
        foreach ($eligible as $t) {
            if (strcasecmp($t['id'], $requestedTechId) === 0 || strcasecmp($t['employeeCode'], $requestedTechId) === 0) {
                $matched = $t;
                break;
            }
        }
        if (!$matched) {
            throw new Exception('Selected technician is not an active eligible Field Worker / Technician in MySQL.', 400);
        }
        $nextTechId = $matched['id'];
        $nextTechName = $matched['name'];
    }

    $prevStatus = (string)($existing['status'] ?? 'OPEN');
    $nextStatus = $prevStatus;
    if ($nextTechId !== '' && $prevStatus === 'OPEN') {
        $nextStatus = 'ASSIGNED';
    } elseif ($nextTechId === '' && $prevStatus === 'ASSIGNED') {
        $nextStatus = 'OPEN';
    }

    $nextSched = array_key_exists('scheduledDate', $payload)
        ? (!empty($payload['scheduledDate']) ? substr((string)$payload['scheduledDate'], 0, 10) : null)
        : ($existing['scheduled_date'] ?? null);
    $hasRemarks = array_key_exists('remarks', $payload) && trim((string)$payload['remarks']) !== '';
    $nextRemarks = $hasRemarks ? trim((string)$payload['remarks']) : (string)($existing['technician_remarks'] ?? '');

    $actorId = trim((string)($actor['id'] ?? $actor['userId'] ?? ''));
    $actorName = trim((string)($actor['name'] ?? $actor['email'] ?? 'Admin'));
    $nowSql = date('Y-m-d H:i:s');

    $pdo->prepare("
        UPDATE `solar_service_tickets`
        SET `assigned_technician_id` = ?,
            `assigned_technician_name` = ?,
            `status` = ?,
            `scheduled_date` = ?,
            `technician_remarks` = ?,
            `assigned_at` = ?,
            `assigned_by_user_id` = ?,
            `assigned_by_name` = ?
        WHERE `id` = ?
    ")->execute([
        $nextTechId,
        $nextTechName,
        $nextStatus,
        $nextSched,
        $nextRemarks,
        $nextTechId !== '' ? $nowSql : null,
        $nextTechId !== '' ? $actorId : null,
        $nextTechId !== '' ? $actorName : null,
        $existing['id']
    ]);

    if ($nextTechId === '' && ($prevTech['assignedTechnicianId'] !== '' || $prevTech['assignedTechnicianName'] !== '')) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'], 'TECHNICIAN_UNASSIGNED',
            $prevTech['assignedTechnicianName'] ?: $prevTech['assignedTechnicianId'], 'Unassigned',
            $hasRemarks ? $nextRemarks : null, $actor
        );
    } elseif ($nextTechId !== '' && $nextTechId !== $prevTech['assignedTechnicianId']) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'],
            $prevTech['assignedTechnicianId'] !== '' ? 'TECHNICIAN_REASSIGNED' : 'TECHNICIAN_ASSIGNED',
            $prevTech['assignedTechnicianName'] ?: 'Unassigned', $nextTechName,
            $hasRemarks ? $nextRemarks : null, $actor
        );
    } elseif ($hasRemarks && $nextRemarks !== (string)($existing['technician_remarks'] ?? '')) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'], 'REMARKS_UPDATED',
            $existing['technician_remarks'] ?? '', $nextRemarks, null, $actor
        );
    }

    if ($nextStatus !== $prevStatus) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'], 'STATUS_UPDATED',
            $prevStatus, $nextStatus, $nextTechId !== '' ? "Technician: $nextTechName" : 'Technician unassigned', $actor
        );
    }

    return getServiceTicketDetailsPhp($pdo, $existing['id']);
}

function adminUpdateServiceTicketPhp($pdo, $idOrCode, $payload, $actor) {
    $existing = getServiceTicketRowPhp($pdo, $idOrCode);
    if (!$existing) {
        throw new Exception('Service ticket not found in MySQL.', 404);
    }
    $allowedStatuses = ['OPEN', 'ASSIGNED', 'VISIT SCHEDULED', 'IN PROGRESS', 'RESOLVED', 'CLOSED'];
    $allowedPriorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

    $prevStatus = (string)($existing['status'] ?? 'OPEN');
    $prevPriority = (string)($existing['priority'] ?? 'MEDIUM');
    $prevTech = normalizeTicketTechnicianPhp($existing['assigned_technician_id'] ?? '', $existing['assigned_technician_name'] ?? '');
    $prevRemarks = (string)($existing['technician_remarks'] ?? '');
    $prevRes = (string)($existing['resolution_details'] ?? '');
    $prevNotes = (string)($existing['notes'] ?? '');

    $nextTechId = $prevTech['assignedTechnicianId'];
    $nextTechName = $prevTech['assignedTechnicianName'];
    $techChanged = false;

    if (array_key_exists('assignedTechnicianId', $payload) || array_key_exists('technicianId', $payload)) {
        $reqTechId = trim((string)($payload['assignedTechnicianId'] ?? $payload['technicianId'] ?? ''));
        if ($reqTechId === '') {
            if ($prevTech['assignedTechnicianId'] !== '' || $prevTech['assignedTechnicianName'] !== '') $techChanged = true;
            $nextTechId = '';
            $nextTechName = '';
        } else {
            $eligible = getEligibleServiceTechniciansPhp($pdo);
            $matched = null;
            foreach ($eligible as $t) {
                if (strcasecmp($t['id'], $reqTechId) === 0 || strcasecmp($t['employeeCode'], $reqTechId) === 0) {
                    $matched = $t;
                    break;
                }
            }
            if (!$matched) {
                throw new Exception('Selected technician is not an active eligible Field Worker / Technician in MySQL.', 400);
            }
            if ($matched['id'] !== $prevTech['assignedTechnicianId']) $techChanged = true;
            $nextTechId = $matched['id'];
            $nextTechName = $matched['name'];
        }
    }

    $nextStatus = $prevStatus;
    if (!empty($payload['status'])) {
        $cand = strtoupper(trim((string)$payload['status']));
        if (!in_array($cand, $allowedStatuses, true)) {
            throw new Exception("Invalid status \"$cand\".", 400);
        }
        $nextStatus = $cand;
    } elseif ($techChanged) {
        if ($nextTechId !== '' && $prevStatus === 'OPEN') $nextStatus = 'ASSIGNED';
        elseif ($nextTechId === '' && $prevStatus === 'ASSIGNED') $nextStatus = 'OPEN';
    }

    $nextPriority = $prevPriority;
    if (!empty($payload['priority'])) {
        $candP = strtoupper(trim((string)$payload['priority']));
        if (!in_array($candP, $allowedPriorities, true)) {
            throw new Exception("Invalid priority \"$candP\".", 400);
        }
        $nextPriority = $candP;
    }

    $nextSched = (array_key_exists('scheduledDate', $payload) || array_key_exists('visitScheduledDate', $payload))
        ? (!empty($payload['scheduledDate'] ?? $payload['visitScheduledDate']) ? substr((string)($payload['scheduledDate'] ?? $payload['visitScheduledDate']), 0, 10) : null)
        : ($existing['scheduled_date'] ?? null);

    $nextResDate = array_key_exists('resolvedDate', $payload)
        ? (!empty($payload['resolvedDate']) ? substr((string)$payload['resolvedDate'], 0, 10) : null)
        : ($existing['resolved_date'] ?? null);
    if (in_array($nextStatus, ['RESOLVED', 'CLOSED'], true) && empty($nextResDate)) {
        $nextResDate = date('Y-m-d');
    } elseif (!in_array($nextStatus, ['RESOLVED', 'CLOSED'], true) && !empty($payload['status'])) {
        $nextResDate = null;
    }

    $nextRemarks = array_key_exists('technicianRemarks', $payload) ? (string)($payload['technicianRemarks'] ?? '') : $prevRemarks;
    $nextRes = array_key_exists('resolutionDetails', $payload) ? (string)($payload['resolutionDetails'] ?? '') : $prevRes;
    $nextNotes = array_key_exists('notes', $payload) ? (string)($payload['notes'] ?? '') : $prevNotes;

    $actorId = trim((string)($actor['id'] ?? $actor['userId'] ?? ''));
    $actorName = trim((string)($actor['name'] ?? $actor['email'] ?? 'Admin'));
    $nowSql = date('Y-m-d H:i:s');

    $pdo->prepare("
        UPDATE `solar_service_tickets`
        SET `assigned_technician_id` = ?,
            `assigned_technician_name` = ?,
            `status` = ?,
            `priority` = ?,
            `scheduled_date` = ?,
            `resolved_date` = ?,
            `notes` = ?,
            `technician_remarks` = ?,
            `resolution_details` = ?,
            `assigned_at` = ?,
            `assigned_by_user_id` = ?,
            `assigned_by_name` = ?
        WHERE `id` = ?
    ")->execute([
        $nextTechId,
        $nextTechName,
        $nextStatus,
        $nextPriority,
        $nextSched,
        $nextResDate,
        $nextNotes,
        $nextRemarks,
        $nextRes,
        $techChanged ? ($nextTechId !== '' ? $nowSql : null) : ($existing['assigned_at'] ?? null),
        $techChanged ? ($nextTechId !== '' ? $actorId : null) : ($existing['assigned_by_user_id'] ?? null),
        $techChanged ? ($nextTechId !== '' ? $actorName : null) : ($existing['assigned_by_name'] ?? null),
        $existing['id']
    ]);

    if ($techChanged) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'],
            $nextTechId === '' ? 'TECHNICIAN_UNASSIGNED' : ($prevTech['assignedTechnicianId'] !== '' ? 'TECHNICIAN_REASSIGNED' : 'TECHNICIAN_ASSIGNED'),
            $prevTech['assignedTechnicianName'] ?: 'Unassigned', $nextTechName ?: 'Unassigned',
            null, $actor
        );
    }
    if ($nextStatus !== $prevStatus) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'],
            $nextStatus === 'RESOLVED' ? 'RESOLVED' : 'STATUS_UPDATED',
            $prevStatus, $nextStatus, $nextRes ?: ($nextRemarks ?: null), $actor
        );
    }
    if ($nextPriority !== $prevPriority) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'], 'PRIORITY_UPDATED',
            $prevPriority, $nextPriority, null, $actor
        );
    }
    if ($nextRemarks !== $prevRemarks || $nextRes !== $prevRes || $nextNotes !== $prevNotes) {
        recordServiceTicketHistoryPhp(
            $pdo, $existing['id'], $existing['ticket_id'], 'REMARKS_UPDATED',
            $prevRemarks ?: ($prevRes ?: null),
            trim(implode(' | ', array_filter([$nextRemarks, $nextRes]))) ?: $nextNotes,
            null, $actor
        );
    }

    return getServiceTicketDetailsPhp($pdo, $existing['id']);
}

// Helper: AMC Contracts
function saveAMCContractToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'amc-' . round(microtime(true) * 1000);
    $amcCode = $item['amcCode'] ?? $item['amc_code'] ?? $item['id'];
    $custId = $item['customerId'] ?? $item['customer_id'] ?? '';
    $custName = $item['customerName'] ?? $item['customer_name'] ?? 'Customer';
    $projId = $item['projectId'] ?? $item['project_id'] ?? '';
    $projTitle = $item['projectTitle'] ?? $item['project_title'] ?? 'Solar Plant';
    $planName = $item['planName'] ?? $item['plan_name'] ?? 'Comprehensive AMC';
    $startDate = !empty($item['startDate'] ?? $item['start_date']) ? substr($item['startDate'] ?? $item['start_date'], 0, 10) : date('Y-m-d');
    $endDate = !empty($item['endDate'] ?? $item['end_date']) ? substr($item['endDate'] ?? $item['end_date'], 0, 10) : date('Y-m-d', strtotime('+1 year'));
    $renewalDate = !empty($item['renewalDate'] ?? $item['renewal_date']) ? substr($item['renewalDate'] ?? $item['renewal_date'], 0, 10) : null;
    $amount = floatval($item['annualAmount'] ?? $item['annual_amount'] ?? 0);
    $visitsDone = intval($item['visitsCompleted'] ?? $item['visits_completed'] ?? 0);
    $totalVisits = intval($item['totalVisits'] ?? $item['total_visits'] ?? 4);
    $status = $item['status'] ?? 'ACTIVE';

    $stmt = $pdo->prepare("
        INSERT INTO `solar_amc_contracts` (
            `id`, `amc_code`, `customer_id`, `customer_name`, `project_id`,
            `project_title`, `plan_name`, `start_date`, `end_date`, `renewal_date`,
            `annual_amount`, `visits_completed`, `total_visits`, `status`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `customer_name` = VALUES(`customer_name`),
            `project_title` = VALUES(`project_title`),
            `plan_name` = VALUES(`plan_name`),
            `start_date` = VALUES(`start_date`),
            `end_date` = VALUES(`end_date`),
            `renewal_date` = VALUES(`renewal_date`),
            `annual_amount` = VALUES(`annual_amount`),
            `visits_completed` = VALUES(`visits_completed`),
            `total_visits` = VALUES(`total_visits`),
            `status` = VALUES(`status`)
    ");
    $stmt->execute([
        $item['id'], $amcCode, $custId, $custName, $projId,
        $projTitle, $planName, $startDate, $endDate, $renewalDate,
        $amount, $visitsDone, $totalVisits, $status
    ]);
    return $item;
}

// Helper: Notifications
function saveNotificationToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'notif-' . round(microtime(true) * 1000);
    $userId = $item['userId'] ?? $item['user_id'] ?? '';
    $title = $item['title'] ?? 'Notification';
    $message = $item['message'] ?? '';
    $type = $item['type'] ?? 'INFO';
    $isRead = !empty($item['isRead'] ?? $item['is_read']) ? 1 : 0;
    $linkType = $item['linkType'] ?? $item['link_type'] ?? null;
    $linkId = $item['linkId'] ?? $item['link_id'] ?? null;
    $custId = $item['customerId'] ?? $item['customer_id'] ?? null;
    $projId = $item['projectId'] ?? $item['project_id'] ?? null;

    $stmt = $pdo->prepare("
        INSERT INTO `solar_notifications` (
            `id`, `user_id`, `title`, `message`, `type`, `is_read`,
            `link_type`, `link_id`, `customer_id`, `project_id`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `title` = VALUES(`title`),
            `message` = VALUES(`message`),
            `type` = VALUES(`type`),
            `is_read` = VALUES(`is_read`),
            `link_type` = VALUES(`link_type`),
            `link_id` = VALUES(`link_id`)
    ");
    $stmt->execute([
        $item['id'], $userId, $title, $message, $type, $isRead,
        $linkType, $linkId, $custId, $projId
    ]);
    return $item;
}

// Helper: Users (Never resurrects deleted users during updateOnly calls, preserves partial fields)
function saveUserToDb($pdo, $item, $isUpdateOnly = false, $actor = null) {
    if (empty($item['id'])) $item['id'] = 'usr-' . round(microtime(true) * 1000);
    $cleanEmail = strtolower(trim((string)($item['email'] ?? '')));
    $reqEmpCode = trim((string)($item['employeeId'] ?? ($item['employee_id'] ?? ($item['employeeCode'] ?? ''))));

    $existing = null;
    $existingEmp = null;
    if ($isUpdateOnly) {
        $stmtCheck = $pdo->prepare('SELECT * FROM `solar_users` WHERE `id` = ? LIMIT 1');
        $stmtCheck->execute([$item['id']]);
        $existing = $stmtCheck->fetch(PDO::FETCH_ASSOC) ?: null;

        try {
            $stmtEmpCheck = $pdo->prepare('SELECT * FROM `solar_employees` WHERE `id` = ? OR `auth_uid` = ? LIMIT 1');
            $stmtEmpCheck->execute([$item['id'], $item['id']]);
            $existingEmp = $stmtEmpCheck->fetch(PDO::FETCH_ASSOC) ?: null;
            if (!$existing && $existingEmp) {
                $matchCode = !empty($reqEmpCode) ? $reqEmpCode : ($existingEmp['employee_code'] ?? '');
                $matchEmail = !empty($cleanEmail) ? $cleanEmail : strtolower(trim((string)($existingEmp['email'] ?? '')));
                $stmtLinkedU = $pdo->prepare('SELECT * FROM `solar_users` WHERE `id` = ? OR (`employee_id` = ? AND `employee_id` != "") OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1');
                $stmtLinkedU->execute([$existingEmp['auth_uid'] ?? $existingEmp['id'], $matchCode, $matchEmail]);
                $existing = $stmtLinkedU->fetch(PDO::FETCH_ASSOC) ?: null;
            }
        } catch (Exception $e) {}

        if (!$existing && !$existingEmp) {
            throw new Exception('User record "' . $item['id'] . '" not found in MySQL.', 404);
        }
    } else {
        try {
            $stmtCheck = $pdo->prepare('SELECT * FROM `solar_users` WHERE `id` = ? OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1');
            $stmtCheck->execute([$item['id'], $cleanEmail]);
            $existing = $stmtCheck->fetch(PDO::FETCH_ASSOC) ?: null;
        } catch (Exception $e) {}
    }

    $canonicalId = $existing['id'] ?? ($existingEmp['auth_uid'] ?? ($existingEmp['id'] ?? $item['id']));
    $name = isset($item['name']) ? trim((string)$item['name']) : ($existing['name'] ?? ($existingEmp['name'] ?? 'Solar User'));
    $email = !empty($cleanEmail) ? $cleanEmail : ($existing['email'] ?? ($existingEmp['email'] ?? ($canonicalId . '@rejoysolar.com')));

    $rawPass = $item['password'] ?? ($item['tempPassword'] ?? null);
    $password = $existing['password'] ?? null;
    $hasNewPassword = false;
    if (!empty($rawPass) && is_string($rawPass) && strlen(trim($rawPass)) >= 6) {
        $cleanPass = trim($rawPass);
        if (substr($cleanPass, 0, 4) !== '$2y$' && substr($cleanPass, 0, 4) !== '$2b$' && substr($cleanPass, 0, 4) !== '$2a$' && substr($cleanPass, 0, 9) !== '$argon2id$') {
            $password = password_hash($cleanPass, PASSWORD_BCRYPT, ['cost' => 10]);
        } else {
            $password = $cleanPass;
        }
        $hasNewPassword = true;
    } elseif (empty($password)) {
        $password = password_hash('Usr@' . substr(bin2hex(random_bytes(3)), 0, 6), PASSWORD_BCRYPT, ['cost' => 10]);
        $hasNewPassword = true;
    }

    $role = $item['role'] ?? ($item['systemRole'] ?? ($existing['role'] ?? ($existingEmp['system_role'] ?? 'Super Admin')));
    $phone = isset($item['phone']) ? trim((string)$item['phone']) : ($existing['phone'] ?? ($existingEmp['phone'] ?? ''));
    $dept = isset($item['department']) ? trim((string)$item['department']) : ($existing['department'] ?? ($existingEmp['department'] ?? 'Operations'));
    $desig = isset($item['designation']) ? trim((string)$item['designation']) : ($existing['designation'] ?? ($existingEmp['designation'] ?? ''));
    $empId = !empty($reqEmpCode) ? $reqEmpCode : ($existing['employee_id'] ?? ($existingEmp['employee_code'] ?? null));

    $fwRaw = array_key_exists('isFieldWorker', $item) ? $item['isFieldWorker'] : (array_key_exists('is_field_worker', $item) ? $item['is_field_worker'] : null);
    $fallbackFw = $existing ? parseBoolFlagPhp($existing['is_field_worker'] ?? 0, false) : ($existingEmp ? parseBoolFlagPhp($existingEmp['is_field_worker'] ?? 0, false) : false);
    $isField = ($fwRaw !== null ? parseBoolFlagPhp($fwRaw, $fallbackFw) : $fallbackFw) ? 1 : 0;

    $loginDisabledExplicit = (array_key_exists('loginEnabled', $item) && !parseBoolFlagPhp($item['loginEnabled'], true))
        || (array_key_exists('login_enabled', $item) && !parseBoolFlagPhp($item['login_enabled'], true));
    $status = $loginDisabledExplicit
        ? 'DISABLED'
        : ($item['status'] ?? ($existing['status'] ?? ($existingEmp && isset($existingEmp['login_enabled']) && intval($existingEmp['login_enabled']) === 0 ? 'DISABLED' : 'ACTIVE')));

    if ($existing) {
        $upSql = 'UPDATE `solar_users` SET `name` = ?, `email` = ?, `role` = ?, `phone` = ?, `department` = ?, `designation` = ?, `employee_id` = ?, `is_field_worker` = ?, `status` = ?, `updated_at` = CURRENT_TIMESTAMP'
            . ($hasNewPassword ? ', `password` = ?' : '')
            . ' WHERE `id` = ?';
        $upParams = [$name, $email, $role, $phone, $dept, $desig, $empId, $isField, $status];
        if ($hasNewPassword) $upParams[] = $password;
        $upParams[] = $canonicalId;
        $pdo->prepare($upSql)->execute($upParams);
    } elseif (!$isUpdateOnly || (!$loginDisabledExplicit && strtoupper((string)$status) === 'ACTIVE')) {
        $stmt = $pdo->prepare("
            INSERT INTO `solar_users` (
                `id`, `name`, `email`, `password`, `role`, `phone`,
                `department`, `designation`, `employee_id`, `is_field_worker`, `status`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            $canonicalId, $name, $email, $password, $role, $phone,
            $dept, $desig, $empId, $isField, $status
        ]);
    }

    if ($existing || !$isUpdateOnly || (!$loginDisabledExplicit && strtoupper((string)$status) === 'ACTIVE')) {
        logSolarUsersAuditPhp($existing ? 'UPDATE' : 'INSERT', $isUpdateOnly ? 'saveUserToDb(updateOnly)' : 'saveUserToDb', $canonicalId, $email, $actor);
    }

    $credStatus = in_array(strtoupper((string)$status), ['DISABLED', 'INACTIVE'], true) ? 'DISABLED' : 'ACTIVE';
    $acctType = ($role === 'Customer') ? 'CUSTOMER' : (in_array($role, ['Admin', 'Super Admin'], true) ? 'ADMIN' : 'EMPLOYEE');
    if ($existing || !$isUpdateOnly || $credStatus === 'ACTIVE') {
        syncAuthCredentialPhp($pdo, $canonicalId, $email, $hasNewPassword ? $password : null, $role, $acctType, $existingEmp['id'] ?? $canonicalId, $credStatus);
    }

    // Also synchronize to solar_employees without duplicating rows or overwriting photo_url/documents
    if ($role !== 'Customer') {
        try {
            $empCode = $empId ?: ($existingEmp['employee_code'] ?? ('EMP-' . substr(preg_replace('/\D/', '', $canonicalId) ?: '001', -3)));
            $empStatus = ($credStatus === 'DISABLED') ? 'INACTIVE' : 'ACTIVE';
            $loginFlag = ($credStatus === 'DISABLED') ? 0 : 1;

            $targetEmpRowId = $existingEmp['id'] ?? null;
            if (!$targetEmpRowId) {
                $stmtFindEmp = $pdo->prepare('SELECT id FROM `solar_employees` WHERE `id` = ? OR `auth_uid` = ? OR (`employee_code` = ? AND `employee_code` != "") OR (LOWER(`email`) = ? AND `email` != "") LIMIT 1');
                $stmtFindEmp->execute([$canonicalId, $canonicalId, $empCode, $email]);
                $foundEmp = $stmtFindEmp->fetch(PDO::FETCH_ASSOC);
                if ($foundEmp) $targetEmpRowId = $foundEmp['id'];
            }

            if ($targetEmpRowId) {
                $pdo->prepare("
                    UPDATE `solar_employees`
                    SET `employee_code` = ?, `name` = ?, `department` = ?, `designation` = ?,
                        `phone` = ?, `email` = ?, `login_enabled` = ?, `auth_uid` = ?,
                        `system_role` = ?, `assigned_role` = ?, `is_field_worker` = ?,
                        `status` = ?, `account_status` = ?
                    WHERE `id` = ?
                ")->execute([
                    $empCode, $name, $dept, $desig,
                    $phone, $email, $loginFlag, $canonicalId,
                    $role, $role, $isField,
                    $empStatus, $credStatus, $targetEmpRowId
                ]);
            } else {
                $pdo->prepare("
                    INSERT INTO `solar_employees` (
                        `id`, `employee_code`, `name`, `photo_url`, `department`,
                        `designation`, `phone`, `email`, `joining_date`, `salary_monthly`,
                        `status`, `current_site_location`, `login_enabled`, `auth_uid`, `system_role`,
                        `assigned_role`, `is_field_worker`, `account_status`
                    ) VALUES (?, ?, ?, '', ?, ?, ?, ?, CURDATE(), 0.00, ?, '', ?, ?, ?, ?, ?, ?)
                ")->execute([
                    $canonicalId, $empCode, $name, $dept, $desig, $phone, $email,
                    $empStatus, $loginFlag, $canonicalId, $role, $role, $isField, $credStatus
                ]);
            }
        } catch (Exception $e) {
            error_log('Notice syncing employee from user: ' . $e->getMessage());
        }
    }

    return [
        'id' => $canonicalId,
        'name' => $name,
        'email' => $email,
        'role' => $role,
        'phone' => $phone,
        'department' => $dept,
        'designation' => $desig,
        'employeeId' => $empId,
        'isFieldWorker' => (bool)$isField,
        'status' => $status
    ];
}

// Helper: System Settings
function saveSettingsToDb($pdo, $item) {
    $val = is_string($item) ? $item : json_encode($item);
    $stmt = $pdo->prepare("
        INSERT INTO `solar_system_settings` (`setting_key`, `setting_value`)
        VALUES ('global_settings', ?)
        ON DUPLICATE KEY UPDATE `setting_value` = VALUES(`setting_value`)
    ");
    $stmt->execute([$val]);
    return $item;
}

// Helper: ACL Config
function saveAclConfigToDb($pdo, $item) {
    $cfg = is_array($item) && isset($item[0]) ? $item[0] : $item;
    $val = is_string($cfg) ? $cfg : json_encode($cfg);
    $stmt = $pdo->prepare("
        INSERT INTO `solar_acl_config` (`id`, `config_json`)
        VALUES ('master_acl_config', ?)
        ON DUPLICATE KEY UPDATE `config_json` = VALUES(`config_json`)
    ");
    $stmt->execute([$val]);
    return $item;
}

// Helper: ACL Audit Logs
function saveAclAuditLogToDb($pdo, $item) {
    if (empty($item['id'])) $item['id'] = 'acl-log-' . round(microtime(true) * 1000);
    $actorId = $item['actorId'] ?? $item['actor_id'] ?? 'usr-admin';
    $actorName = $item['actorName'] ?? $item['actor_name'] ?? 'Admin';
    $actorRole = $item['actorRole'] ?? $item['actor_role'] ?? 'Admin';
    $action = $item['action'] ?? 'UPDATE';
    $targetRole = $item['targetRole'] ?? $item['target_role'] ?? '';
    $details = is_string($item['details'] ?? '') ? $item['details'] : json_encode($item['details'] ?? []);
    $ts = !empty($item['timestamp']) ? date('Y-m-d H:i:s', strtotime($item['timestamp'])) : date('Y-m-d H:i:s');

    $stmt = $pdo->prepare("
        INSERT INTO `solar_acl_audit_logs` (
            `id`, `actor_id`, `actor_name`, `actor_role`, `action`,
            `target_role`, `details`, `timestamp`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `details` = VALUES(`details`)
    ");
    $stmt->execute([
        $item['id'], $actorId, $actorName, $actorRole, $action,
        $targetRole, $details, $ts
    ]);
    return $item;
}

// Master Save Dispatcher
function saveItemToDb($pdo, $collection, $item, $actor = null) {
    switch ($collection) {
        case 'customers': return saveCustomerToDb($pdo, $item);
        case 'leads': return saveLeadToDb($pdo, $item);
        case 'projects': return saveProjectToDb($pdo, $item);
        case 'employees': return saveEmployeeToDb($pdo, $item, $actor);
        case 'payments': return savePaymentToDb($pdo, $item);
        case 'expenses': return saveExpenseToDb($pdo, $item);
        case 'products': return saveProductToDb($pdo, $item);
        case 'vendors': return saveVendorToDb($pdo, $item);
        case 'purchase_orders': return savePurchaseOrderToDb($pdo, $item, $actor);
        case 'boms': return saveBOMToDb($pdo, $item);
        case 'sales_invoices': return saveSalesInvoiceToDb($pdo, $item, $actor);
        case 'vendor_sales_invoices':
        case 'solar_vendor_sales_invoices':
            return saveVendorSalesInvoicePhp($pdo, $item, $actor);
        case 'attendance': return saveAttendanceToDb($pdo, $item);
        case 'payslips': return savePayslipToDb($pdo, $item);
        case 'holidays': return saveHolidayToDb($pdo, $item);
        case 'quotations': return saveQuotationToDb($pdo, $item);
        case 'surveys': return saveSurveyToDb($pdo, $item);
        case 'warehouses': return saveWarehouseToDb($pdo, $item);
        case 'stock_movements': return saveStockMovementToDb($pdo, $item);
        case 'stock_audits': return saveStockAuditToDb($pdo, $item);
        case 'service_tickets': return saveServiceTicketToDb($pdo, $item, $actor);
        case 'amc_contracts': return saveAMCContractToDb($pdo, $item);
        case 'notifications': return saveNotificationToDb($pdo, $item);
        case 'users': return saveUserToDb($pdo, $item, false, $actor);
        case 'settings': return saveSettingsToDb($pdo, $item);
        case 'acl_config': return saveAclConfigToDb($pdo, $item);
        case 'acl_audit_logs': return saveAclAuditLogToDb($pdo, $item);
        default:
            throw new Exception("Unknown collection: $collection");
    }
}

// Master Delete Dispatcher (Cascades cleanly across coupled auth & personnel tables)
function deleteItemFromDb($pdo, $collection, $id, $actor = null) {
    if (empty($id)) return false;
    if ($collection === 'vendor_sales_invoices' || $collection === 'solar_vendor_sales_invoices') {
        return deleteVendorSalesInvoicePhp($pdo, $id);
    }
    if ($collection === 'purchase_orders') {
        try {
            $prChk = $pdo->prepare('SELECT COUNT(*) AS cnt FROM `solar_purchase_returns` WHERE `purchase_order_id` = ?');
            $prChk->execute([$id]);
            if (intval($prChk->fetchColumn() ?: 0) > 0) {
                throw new Exception('Cannot delete Purchase Order with Purchase Returns recorded. Reverse/delete the Purchase Returns first.', 400);
            }
        } catch (Exception $e) {
            if ($e->getCode() === 400) throw $e;
        }
        try {
            $vbStmt = $pdo->prepare('SELECT * FROM `solar_acc_vendor_bills` WHERE `po_id` = ? LIMIT 1');
            $vbStmt->execute([$id]);
            $vb = $vbStmt->fetch(PDO::FETCH_ASSOC);
            if ($vb) {
                $vpChk = $pdo->prepare('SELECT COUNT(*) FROM `solar_acc_vendor_payments` WHERE `bill_id` = ?');
                $vpChk->execute([$vb['id']]);
                if (floatval($vb['paid_amount'] ?? 0) > 0 || intval($vpChk->fetchColumn() ?: 0) > 0) {
                    throw new Exception('Cannot delete Purchase Order with vendor payments recorded. Reverse vendor payments first.', 400);
                }
                if (!empty($vb['journal_entry_id'])) {
                    $pdo->prepare('DELETE FROM `solar_acc_journal_entries` WHERE `id` = ?')->execute([$vb['journal_entry_id']]);
                    require_once __DIR__ . '/accounting.php';
                    accRecalcBalancesPhp($pdo);
                }
                $pdo->prepare('DELETE FROM `solar_acc_vendor_bills` WHERE `id` = ?')->execute([$vb['id']]);
            }
        } catch (Exception $e) {
            if ($e->getCode() === 400) throw $e;
        }
        try {
            $exPo = fetchExistingRowPhp($pdo, 'solar_purchase_orders', $id);
            if ($exPo) {
                $billInfo = mapVendorBillsFromPoRowPhp($exPo);
                foreach ($billInfo['vendorBills'] as $vbItem) {
                    if (!empty($vbItem['filePath'])) {
                        $fp = resolveUploadFilePathPhp($vbItem['filePath']);
                        if ($fp && file_exists($fp)) @unlink($fp);
                    }
                }
            }
        } catch (Exception $e) {}
        $pdo->prepare('DELETE FROM `solar_purchase_orders` WHERE `id` = ?')->execute([$id]);
        return true;
    }
    if ($collection === 'sales_invoices') {
        try {
            $srChk = $pdo->prepare("SELECT COUNT(*) AS cnt FROM `solar_sales_returns` WHERE `target_type` = 'CUSTOMER_INVOICE' AND `invoice_id` = ?");
            $srChk->execute([$id]);
            if (intval($srChk->fetchColumn() ?: 0) > 0) {
                throw new Exception('Cannot delete invoice with Sales Returns recorded. Delete the Sales Returns first.', 400);
            }
        } catch (Exception $e) {
            if ($e->getCode() === 400) throw $e;
        }
        try {
            $payChk = $pdo->prepare('SELECT COUNT(*) AS cnt FROM `solar_payments` WHERE `invoice_id` = ?');
            $payChk->execute([$id]);
            if (intval($payChk->fetchColumn() ?: 0) > 0) {
                throw new Exception('Cannot delete invoice with Customer Receipts recorded. Delete the receipts first.', 400);
            }
        } catch (Exception $e) {
            if ($e->getCode() === 400) throw $e;
        }
        try {
            $pdo->prepare("DELETE FROM `solar_acc_journal_entries` WHERE `reference_type` = 'SALES_INVOICE' AND `reference_id` = ?")->execute([$id]);
            require_once __DIR__ . '/accounting.php';
            accRecalcBalancesPhp($pdo);
        } catch (Exception $e) {}
        $pdo->prepare('DELETE FROM `solar_sales_invoices` WHERE `id` = ?')->execute([$id]);
        return true;
    }
    $tableMap = [
        'customers' => 'solar_customers',
        'leads' => 'solar_leads',
        'projects' => 'solar_projects',
        'employees' => 'solar_employees',
        'payments' => 'solar_payments',
        'expenses' => 'solar_expenses',
        'products' => 'solar_products',
        'vendors' => 'solar_vendors',
        'purchase_orders' => 'solar_purchase_orders',
        'boms' => 'solar_boms',
        'sales_invoices' => 'solar_sales_invoices',
        'vendor_sales_invoices' => 'solar_vendor_sales_invoices',
        'attendance' => 'solar_attendance',
        'payslips' => 'solar_payslips',
        'holidays' => 'solar_holidays',
        'quotations' => 'solar_quotations',
        'surveys' => 'solar_site_surveys',
        'warehouses' => 'solar_warehouses',
        'stock_movements' => 'solar_stock_movements',
        'stock_audits' => 'solar_stock_audits',
        'service_tickets' => 'solar_service_tickets',
        'amc_contracts' => 'solar_amc_contracts',
        'notifications' => 'solar_notifications',
        'users' => 'solar_users',
        'settings' => 'solar_system_settings',
        'acl_config' => 'solar_acl_config',
        'acl_audit_logs' => 'solar_acl_audit_logs'
    ];
    $table = $tableMap[$collection] ?? ('solar_' . $collection);
    if ($collection === 'projects') {
        $stmtS = $pdo->prepare('DELETE FROM `solar_project_stages` WHERE `project_id` = ?');
        $stmtS->execute([$id]);
    }
    if ($collection === 'service_tickets') {
        try {
            $pdo->prepare('DELETE FROM `solar_service_ticket_history` WHERE `ticket_record_id` = ?')->execute([$id]);
        } catch (Exception $e) {}
    }
    $normCollection = strtolower(trim((string)$collection));
    if (in_array($normCollection, ['employee', 'employees', 'solar_employee', 'solar_employees'], true)) {
        $normCollection = 'employees';
    } elseif (in_array($normCollection, ['user', 'users', 'solar_users'], true)) {
        $normCollection = 'users';
    }
    if ($normCollection === 'employees' || $normCollection === 'users') {
        $matchedIds = [$id];
        $matchedEmails = [];
        $matchedCodes = [];

        $addUnique = static function (&$arr, $val, $lower = false) {
            $clean = trim((string)$val);
            if ($clean === '') return;
            if ($lower) $clean = strtolower($clean);
            if (!in_array($clean, $arr, true)) {
                $arr[] = $clean;
            }
        };

        $tableTypePhp = static function ($tblName) use ($pdo) {
            try {
                $rows = $pdo->query("SHOW FULL TABLES LIKE '$tblName'")->fetchAll(PDO::FETCH_NUM);
                if (empty($rows)) return 'NONE';
                $type = strtoupper((string)($rows[0][1] ?? 'BASE TABLE'));
                return $type === 'VIEW' ? 'VIEW' : 'BASE TABLE';
            } catch (Exception $e) {
                return 'NONE';
            }
        };

        $solarEmployeeType = $tableTypePhp('solar_employee');
        $solarEmployeesType = $tableTypePhp('solar_employees');
        $solarUsersType = $tableTypePhp('solar_users');

        if ($solarUsersType !== 'NONE') {
            try {
                $uStmt = $pdo->prepare('SELECT id, email, employee_id FROM `solar_users` WHERE `id` = ? OR `employee_id` = ? LIMIT 5');
                $uStmt->execute([$id, $id]);
                while ($row = $uStmt->fetch(PDO::FETCH_ASSOC)) {
                    $addUnique($matchedIds, $row['id'] ?? '');
                    $addUnique($matchedEmails, $row['email'] ?? '', true);
                    $addUnique($matchedCodes, $row['employee_id'] ?? '');
                }
            } catch (Exception $e) {}
        }

        if ($solarEmployeeType !== 'NONE') {
            try {
                $eCols = $pdo->query("SHOW COLUMNS FROM `solar_employee`")->fetchAll(PDO::FETCH_COLUMN, 0) ?: [];
                $hasAuthUid = in_array('auth_uid', array_map('strtolower', $eCols), true);
                $sql = $hasAuthUid
                    ? 'SELECT id, auth_uid, email, employee_code FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 5'
                    : 'SELECT id, email, employee_code FROM `solar_employee` WHERE `id` = ? OR `employee_code` = ? LIMIT 5';
                $e2Stmt = $pdo->prepare($sql);
                $e2Stmt->execute($hasAuthUid ? [$id, $id, $id] : [$id, $id]);
                while ($row = $e2Stmt->fetch(PDO::FETCH_ASSOC)) {
                    $addUnique($matchedIds, $row['id'] ?? '');
                    if ($hasAuthUid) $addUnique($matchedIds, $row['auth_uid'] ?? '');
                    $addUnique($matchedEmails, $row['email'] ?? '', true);
                    $addUnique($matchedCodes, $row['employee_code'] ?? '');
                }
            } catch (Exception $e) {}
        }

        if ($solarEmployeesType === 'BASE TABLE') {
            try {
                $eCols = $pdo->query("SHOW COLUMNS FROM `solar_employees`")->fetchAll(PDO::FETCH_COLUMN, 0) ?: [];
                $hasAuthUid = in_array('auth_uid', array_map('strtolower', $eCols), true);
                $sql = $hasAuthUid
                    ? 'SELECT id, auth_uid, email, employee_code FROM `solar_employees` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 5'
                    : 'SELECT id, email, employee_code FROM `solar_employees` WHERE `id` = ? OR `employee_code` = ? LIMIT 5';
                $eStmt = $pdo->prepare($sql);
                $eStmt->execute($hasAuthUid ? [$id, $id, $id] : [$id, $id]);
                while ($row = $eStmt->fetch(PDO::FETCH_ASSOC)) {
                    $addUnique($matchedIds, $row['id'] ?? '');
                    if ($hasAuthUid) $addUnique($matchedIds, $row['auth_uid'] ?? '');
                    $addUnique($matchedEmails, $row['email'] ?? '', true);
                    $addUnique($matchedCodes, $row['employee_code'] ?? '');
                }
            } catch (Exception $e) {}
        }

        // Second pass: expand linked user/employee rows matching discovered email or code
        if ($solarUsersType !== 'NONE' && (!empty($matchedEmails) || !empty($matchedCodes))) {
            try {
                $conds = [];
                $params = [];
                if (!empty($matchedEmails)) {
                    $ph = implode(',', array_fill(0, count($matchedEmails), '?'));
                    $conds[] = "LOWER(`email`) IN ($ph)";
                    $params = array_merge($params, $matchedEmails);
                }
                if (!empty($matchedCodes)) {
                    $ph = implode(',', array_fill(0, count($matchedCodes), '?'));
                    $conds[] = "`employee_id` IN ($ph)";
                    $params = array_merge($params, $matchedCodes);
                }
                if (!empty($conds)) {
                    $u2 = $pdo->prepare('SELECT id, email, employee_id FROM `solar_users` WHERE ' . implode(' OR ', $conds));
                    $u2->execute($params);
                    while ($row = $u2->fetch(PDO::FETCH_ASSOC)) {
                        $addUnique($matchedIds, $row['id'] ?? '');
                        $addUnique($matchedEmails, $row['email'] ?? '', true);
                        $addUnique($matchedCodes, $row['employee_id'] ?? '');
                    }
                }
            } catch (Exception $e) {}
        }

        $idPlaceholders = implode(',', array_fill(0, count($matchedIds), '?'));
        $emailPlaceholders = !empty($matchedEmails) ? implode(',', array_fill(0, count($matchedEmails), '?')) : '';
        $codePlaceholders = !empty($matchedCodes) ? implode(',', array_fill(0, count($matchedCodes), '?')) : '';

        $startedTx = !$pdo->inTransaction();
        if ($startedTx) $pdo->beginTransaction();

        try {
            // 1. Delete dependent child rows cleanly before parent rows (prevents FK errors & orphaned data)
            if ($tableTypePhp('solar_employee_documents') !== 'NONE') {
                $pdo->prepare("DELETE FROM `solar_employee_documents` WHERE `employee_id` IN ($idPlaceholders)")->execute($matchedIds);
            }

            if ($tableTypePhp('solar_auth_sessions') !== 'NONE') {
                $sConds = ["`user_id` IN ($idPlaceholders)", "`linked_entity_id` IN ($idPlaceholders)"];
                $sParams = array_merge($matchedIds, $matchedIds);
                if (!empty($matchedEmails)) {
                    $sConds[] = "LOWER(`email`) IN ($emailPlaceholders)";
                    $sParams = array_merge($sParams, $matchedEmails);
                }
                $pdo->prepare('DELETE FROM `solar_auth_sessions` WHERE ' . implode(' OR ', $sConds))->execute($sParams);
            }

            if ($tableTypePhp('solar_auth_credentials') !== 'NONE') {
                $cConds = ["`user_id` IN ($idPlaceholders)", "`linked_entity_id` IN ($idPlaceholders)"];
                $cParams = array_merge($matchedIds, $matchedIds);
                if (!empty($matchedEmails)) {
                    $cConds[] = "LOWER(`email`) IN ($emailPlaceholders)";
                    $cParams = array_merge($cParams, $matchedEmails);
                }
                $pdo->prepare('DELETE FROM `solar_auth_credentials` WHERE ' . implode(' OR ', $cConds))->execute($cParams);
            }

            if ($tableTypePhp('solar_workforce_locations') !== 'NONE') {
                $wConds = ["`user_id` IN ($idPlaceholders)"];
                $wParams = $matchedIds;
                if (!empty($matchedEmails)) {
                    $wConds[] = "LOWER(`email`) IN ($emailPlaceholders)";
                    $wParams = array_merge($wParams, $matchedEmails);
                }
                $pdo->prepare('DELETE FROM `solar_workforce_locations` WHERE ' . implode(' OR ', $wConds))->execute($wParams);
            }

            // Unassign active open/in-progress service tickets pointing to deleted employee
            if ($tableTypePhp('solar_service_tickets') !== 'NONE') {
                try {
                    $pdo->prepare("UPDATE `solar_service_tickets` SET `assigned_technician_id` = '', `assigned_technician_name` = '', `assigned_to_name` = 'Unassigned' WHERE `assigned_technician_id` IN ($idPlaceholders) AND COALESCE(`status`, 'OPEN') NOT IN ('RESOLVED', 'CLOSED')")
                        ->execute($matchedIds);
                } catch (Exception $e) {}
            }

            // 2. Delete from authoritative employee table(s)
            if ($solarEmployeeType === 'BASE TABLE') {
                $eCols = $pdo->query("SHOW COLUMNS FROM `solar_employee`")->fetchAll(PDO::FETCH_COLUMN, 0) ?: [];
                $hasAuthUid = in_array('auth_uid', array_map('strtolower', $eCols), true);
                $eConds = ["`id` IN ($idPlaceholders)"];
                $eParams = $matchedIds;
                if ($hasAuthUid) {
                    $eConds[] = "`auth_uid` IN ($idPlaceholders)";
                    $eParams = array_merge($eParams, $matchedIds);
                }
                if (!empty($matchedCodes)) {
                    $eConds[] = "`employee_code` IN ($codePlaceholders)";
                    $eParams = array_merge($eParams, $matchedCodes);
                }
                if (!empty($matchedEmails)) {
                    $eConds[] = "LOWER(`email`) IN ($emailPlaceholders)";
                    $eParams = array_merge($eParams, $matchedEmails);
                }
                $pdo->prepare('DELETE FROM `solar_employee` WHERE ' . implode(' OR ', $eConds))->execute($eParams);
            }

            if ($solarEmployeesType === 'BASE TABLE') {
                $eCols = $pdo->query("SHOW COLUMNS FROM `solar_employees`")->fetchAll(PDO::FETCH_COLUMN, 0) ?: [];
                $hasAuthUid = in_array('auth_uid', array_map('strtolower', $eCols), true);
                $eConds = ["`id` IN ($idPlaceholders)"];
                $eParams = $matchedIds;
                if ($hasAuthUid) {
                    $eConds[] = "`auth_uid` IN ($idPlaceholders)";
                    $eParams = array_merge($eParams, $matchedIds);
                }
                if (!empty($matchedCodes)) {
                    $eConds[] = "`employee_code` IN ($codePlaceholders)";
                    $eParams = array_merge($eParams, $matchedCodes);
                }
                if (!empty($matchedEmails)) {
                    $eConds[] = "LOWER(`email`) IN ($emailPlaceholders)";
                    $eParams = array_merge($eParams, $matchedEmails);
                }
                $pdo->prepare('DELETE FROM `solar_employees` WHERE ' . implode(' OR ', $eConds))->execute($eParams);
            }

            // 3. Delete linked ERP user record(s) so deleted employee is never re-synthesized by /bootstrap
            if ($solarUsersType === 'BASE TABLE') {
                $uConds = ["`id` IN ($idPlaceholders)", "`employee_id` IN ($idPlaceholders)"];
                $uParams = array_merge($matchedIds, $matchedIds);
                if (!empty($matchedCodes)) {
                    $uConds[] = "`employee_id` IN ($codePlaceholders)";
                    $uParams = array_merge($uParams, $matchedCodes);
                }
                if (!empty($matchedEmails)) {
                    $uConds[] = "LOWER(`email`) IN ($emailPlaceholders)";
                    $uParams = array_merge($uParams, $matchedEmails);
                }
                $pdo->prepare('DELETE FROM `solar_users` WHERE ' . implode(' OR ', $uConds))->execute($uParams);
            }

            if ($startedTx) $pdo->commit();
        } catch (Exception $e) {
            if ($startedTx && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        logSolarUsersAuditPhp('DELETE', "deleteItemFromDb($normCollection)", $id, $matchedEmails[0] ?? '', $actor);
    } elseif ($collection === 'customers') {
        $custEmail = '';
        try {
            $cStmt = $pdo->prepare('SELECT email FROM `solar_customers` WHERE `id` = ? LIMIT 1');
            $cStmt->execute([$id]);
            if ($row = $cStmt->fetch(PDO::FETCH_ASSOC)) {
                $custEmail = strtolower(trim((string)($row['email'] ?? '')));
            }
        } catch (Exception $e) {}
        $pdo->prepare('DELETE FROM `solar_customers` WHERE `id` = ?')->execute([$id]);
        $cWhere = '`user_id` = ? OR `linked_entity_id` = ?' . (!empty($custEmail) ? ' OR LOWER(`email`) = ?' : '');
        $cParams = [$id, $id];
        if (!empty($custEmail)) $cParams[] = $custEmail;
        try { $pdo->prepare("DELETE FROM `solar_auth_credentials` WHERE $cWhere")->execute($cParams); } catch (Exception $e) {}
        try { $pdo->prepare("DELETE FROM `solar_auth_sessions` WHERE $cWhere")->execute($cParams); } catch (Exception $e) {}
    } elseif ($collection === 'warehouses') {
        $exWh = fetchExistingRowPhp($pdo, 'solar_warehouses', $id);
        if ($exWh && !empty($exWh['is_default'])) {
            throw new Exception('Cannot delete the Primary/Default warehouse. Assign another default warehouse first.');
        }
        $stmt = $pdo->prepare("DELETE FROM `solar_warehouses` WHERE `id` = ?");
        $stmt->execute([$id]);
    } else {
        $stmt = $pdo->prepare("DELETE FROM `$table` WHERE `id` = ?");
        $stmt->execute([$id]);
    }
    return true;
}

// ==========================================================
// 9. ROUTE HANDLERS
// ==========================================================

// Health Check
if ($method === 'GET' && in_array($cleanPath, ['/health', '/status', '/status.php', '/'])) {
    $dbConnected = false;
    $dbVersion = 'Unknown';
    try {
        $pdo = getDbConnection($dbConfig);
        $stmt = $pdo->query('SELECT VERSION() as v');
        $row = $stmt->fetch();
        $dbConnected = true;
        $dbVersion = $row['v'] ?? 'Connected';
    } catch (Exception $e) {}

    http_response_code(200);
    echo json_encode([
        'status' => 'ONLINE',
        'app' => 'Rejoy Solar ERP & CRM',
        'version' => '1.0.0',
        'backend' => 'Hostinger Native PHP/MySQL Gateway',
        'database' => $dbConnected ? 'CONNECTED' : 'DISCONNECTED',
        'db_version' => $dbVersion,
        'server_time' => date('c'),
        'routing' => 'Active Gateway (No Proxy Timeout)'
    ]);
    exit;
}

// DB Health Check (/api/health/db)
if ($method === 'GET' && in_array($cleanPath, ['/health/db', '/health/db/'])) {
    $pdo = getDbConnection($dbConfig);
    $stmt = $pdo->query('SELECT DATABASE() as db, @@hostname as host, @@port as port, VERSION() as version');
    $meta = $stmt->fetch();
    http_response_code(200);
    echo json_encode([
        'status' => 'UP',
        'database' => $meta['db'] ?? $dbConfig['name'],
        'hostname' => $meta['host'] ?? $dbConfig['host'],
        'port' => (int)($meta['port'] ?? $dbConfig['port']),
        'version' => $meta['version'] ?? 'Unknown',
        'timestamp' => date('c')
    ]);
    exit;
}

// Database Connection Test
if (in_array($cleanPath, ['/db/test-connection', '/db/test', '/db.php'])) {
    $pdo = getDbConnection($dbConfig);
    $stmt = $pdo->query('SELECT VERSION() as v');
    $row = $stmt->fetch();
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'Successfully connected to MySQL ' . ($row['v'] ?? '') . ' on ' . $dbConfig['host'],
        'version' => $row['v'] ?? 'Unknown'
    ]);
    exit;
}

// Database Status & Table Inventory
if ($method === 'GET' && in_array($cleanPath, ['/db/status', '/db'])) {
    $pdo = getDbConnection($dbConfig);
    $tables = [];
    try {
        $stmt = $pdo->query('SHOW TABLES');
        while ($r = $stmt->fetch(PDO::FETCH_NUM)) {
            $tables[] = $r[0];
        }
    } catch (Exception $e) {
        error_log('SHOW TABLES failed: ' . $e->getMessage());
    }

    $meta = ['database' => $dbConfig['name'], 'hostname' => $dbConfig['host'], 'port' => $dbConfig['port'], 'version' => 'Unknown'];
    try {
        $stmtMeta = $pdo->query('SELECT DATABASE() as db, @@hostname as host, @@port as port, VERSION() as version');
        if ($stmtMeta) {
            $metaRow = $stmtMeta->fetch(PDO::FETCH_ASSOC);
            if ($metaRow) {
                $meta['database'] = $metaRow['db'] ?? $meta['database'];
                $meta['hostname'] = $metaRow['host'] ?? $meta['hostname'];
                $meta['port'] = (int)($metaRow['port'] ?? $meta['port']);
                $meta['version'] = $metaRow['version'] ?? $meta['version'];
            }
        }
    } catch (Exception $e) {}

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'connected' => true,
        'mode' => 'LIVE_MYSQL_POOL',
        'dumpAvailable' => true,
        'dumpPath' => '/database.sql',
        'message' => 'Connected to live production MySQL pool',
        'tables' => $tables,
        'tablesCount' => count($tables)
    ]);
    exit;
}

// POST /api/db/migrate - Initialize Database Schema (Protected)
if ($method === 'POST' && in_array($cleanPath, ['/db/migrate', '/db/migrate/'])) {
    $pdo = getDbConnection($dbConfig);
    $remoteIp = $_SERVER['REMOTE_ADDR'] ?? '';
    if (!in_array($remoteIp, ['127.0.0.1', '::1'], true)) {
        requireAdminUserPhp($pdo);
    }
    ensureRequiredTables($pdo);

    $tables = [];
    try {
        $stmt = $pdo->query('SHOW TABLES');
        while ($r = $stmt->fetch(PDO::FETCH_NUM)) {
            $tables[] = $r[0];
        }
    } catch (Exception $e) {}

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'Database schema migration executed successfully.',
        'tables' => $tables,
        'tablesCount' => count($tables)
    ]);
    exit;
}

// GET /api/auth/registration-status - Administrator Registration Status
if ($method === 'GET' && in_array($cleanPath, ['/auth/registration-status', '/auth/registration-status/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $admins = [];
    try {
        $stmt = $pdo->query("SELECT id, email FROM `solar_users` WHERE role IN ('Admin', 'Super Admin') AND status = 'ACTIVE'");
        if ($stmt) {
            $admins = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
    } catch (PDOException $e) {
        $admins = [];
    }

    $nonDemoCount = 0;
    foreach ($admins as $a) {
        $email = strtolower($a['email'] ?? '');
        $id = $a['id'] ?? '';
        $isDemo = (strpos($email, 'admin@rejoysolar.com') !== false) || (substr($id, 0, 5) === 'demo-');
        if (!$isDemo) {
            $nonDemoCount++;
        }
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'allowPublicRegistration' => ($nonDemoCount === 0),
        'adminCount' => count($admins)
    ]);
    exit;
}

// POST /api/auth/register - Administrator Registration
if ($method === 'POST' && in_array($cleanPath, ['/auth/register', '/auth/register/'])) {
    $name = trim($body['name'] ?? '');
    $email = strtolower(trim($body['email'] ?? ''));
    $password = trim($body['password'] ?? '');
    $confirmPassword = trim($body['confirmPassword'] ?? '');
    $phone = trim($body['phone'] ?? '+91 98250 11223');
    $department = trim($body['department'] ?? 'Administration');
    $designation = trim($body['designation'] ?? 'Lead Administrator');

    if (empty($name) || empty($email) || empty($password)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Name, email, and password are required.']);
        exit;
    }

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'A valid business email address is required.']);
        exit;
    }

    if (strlen($password) < 6) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Password must be at least 6 characters long.']);
        exit;
    }

    if (!empty($confirmPassword) && $password !== $confirmPassword) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Passwords do not match. Please verify your confirm password field.']);
        exit;
    }

    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $admins = [];
    try {
        $stmt = $pdo->query("SELECT id, email FROM `solar_users` WHERE role IN ('Admin', 'Super Admin') AND status = 'ACTIVE'");
        if ($stmt) {
            $admins = $stmt->fetchAll(PDO::FETCH_ASSOC);
        }
    } catch (PDOException $e) {
        $admins = [];
    }

    $nonDemoCount = 0;
    foreach ($admins as $a) {
        $em = strtolower($a['email'] ?? '');
        $id = $a['id'] ?? '';
        $isDemo = (strpos($em, 'admin@rejoysolar.com') !== false) || (substr($id, 0, 5) === 'demo-');
        if (!$isDemo) {
            $nonDemoCount++;
        }
    }

    $actorUser = getAuthenticatedUserPhp($pdo);
    $isAuthorized = $actorUser && in_array($actorUser['role'] ?? '', ['Admin', 'Super Admin'], true);
    if (!$isAuthorized) {
        $adminToken = trim((string)($_SERVER['HTTP_X_ADMIN_TOKEN'] ?? $_SERVER['HTTP_X_ADMIN_KEY'] ?? ''));
        if (!empty($adminToken)) {
            $keyUser = validateDbSession($pdo, $adminToken);
            if ($keyUser && in_array($keyUser['role'] ?? '', ['Admin', 'Super Admin'], true)
                && !in_array(strtoupper((string)($keyUser['status'] ?? 'ACTIVE')), ['DISABLED', 'INACTIVE'], true)) {
                $isAuthorized = true;
                $actorUser = $keyUser;
            }
        }
    }

    if ($nonDemoCount > 0 && !$isAuthorized) {
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Public administrator registration is closed. Additional administrators must be created by an existing authorized Administrator.'
        ]);
        exit;
    }

    try {
        $stmt = $pdo->prepare('SELECT id FROM `solar_users` WHERE LOWER(email) = ? LIMIT 1');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'An account with this email address already exists in MySQL.']);
            exit;
        }
    } catch (PDOException $e) {}

    try {
        $stmt = $pdo->prepare('SELECT id FROM `solar_customers` WHERE LOWER(email) = ? LIMIT 1');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'This email is already registered as an ERP customer.']);
            exit;
        }
    } catch (PDOException $e) {}

    $hashedPassword = password_hash($password, PASSWORD_BCRYPT);
    $userId = 'usr-admin-' . round(microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(3)), 0, 5);
    $empCode = 'EMP-ADM-' . rand(100, 999);

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("
            INSERT INTO `solar_users` (
                `id`, `name`, `email`, `password`, `role`, `phone`, `department`,
                `designation`, `employee_id`, `is_field_worker`, `status`
            ) VALUES (?, ?, ?, ?, 'Admin', ?, ?, ?, ?, 0, 'ACTIVE')
        ");
        $stmt->execute([
            $userId, $name, $email, $hashedPassword, $phone,
            $department, $designation, $empCode
        ]);

        try {
            $stmtEmp = $pdo->prepare("
                INSERT INTO `solar_employees` (
                    `id`, `employee_code`, `name`, `email`, `phone`, `department`,
                    `designation`, `joining_date`, `salary_monthly`, `system_role`, `assigned_role`, `login_enabled`, `account_status`, `status`
                ) VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), 0.00, 'Admin', 'Admin', 1, 'ACTIVE', 'ACTIVE')
                ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)
            ");
            $stmtEmp->execute([
                $userId, $empCode, $name, $email, $phone, $department, $designation
            ]);
        } catch (Exception $e) {}

        $pdo->commit();
        syncAuthCredentialPhp($pdo, $userId, $email, $hashedPassword, 'Admin', 'ADMIN', $userId, 'ACTIVE');
        logSolarUsersAuditPhp('INSERT', 'POST /auth/register', $userId, $email, $actorUser);
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Database error registering administrator: ' . $e->getMessage()]);
        exit;
    }

    $sessionToken = createDbSession($pdo, $userId, $email, 'Admin', 'ADMIN', $userId);
    setServerSessionCookie($sessionToken);

    http_response_code(201);
    echo json_encode([
        'success' => true,
        'message' => 'Admin account created successfully.',
        'user' => [
            'id' => $userId,
            'name' => $name,
            'email' => $email,
            'role' => 'Admin',
            'phone' => $phone,
            'department' => $department,
            'designation' => $designation,
            'employeeId' => $empCode,
            'isFieldWorker' => false
        ],
        'token' => $sessionToken
    ]);
    exit;
}

// POST /api/auth/login - Production User Authentication & MySQL Session Issuance
if ($method === 'POST' && in_array($cleanPath, ['/auth/login', '/auth/login/'])) {
    $email = strtolower(trim($body['email'] ?? ''));
    $password = trim($body['password'] ?? '');

    if (empty($email) || empty($password)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Email and password are required.']);
        exit;
    }

    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $authenticatedUser = null;
    $accountType = 'ADMIN';
    $linkedEntityId = null;
    $disabledAccountMsg = null;

    // 1. Authoritative check via solar_auth_credentials table
    try {
        $stmtCred = $pdo->prepare('SELECT * FROM `solar_auth_credentials` WHERE LOWER(email) = ? LIMIT 1');
        $stmtCred->execute([$email]);
        $cred = $stmtCred->fetch(PDO::FETCH_ASSOC);

        if ($cred) {
            $credStatusUpper = strtoupper(trim((string)($cred['status'] ?? 'ACTIVE')));
            if (in_array($credStatusUpper, ['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'], true)) {
                http_response_code(403);
                echo json_encode(['success' => false, 'message' => 'Account has been disabled. Please contact system administrator.']);
                exit;
            }

            $storedHash = (string)($cred['password_hash'] ?? '');
            $credMatches = !empty($storedHash) && (password_verify($password, $storedHash) || hash_equals($storedHash, $password));

            if ($credMatches) {
                // If stored password was plaintext, securely upgrade to bcrypt hash (preserve existing bcrypt/argon2 hashes)
                if (!str_starts_with($storedHash, '$2') && !str_starts_with($storedHash, '$argon2')) {
                    $newHash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
                    $up = $pdo->prepare('UPDATE `solar_auth_credentials` SET `password_hash` = ?, `password_changed_at` = NOW() WHERE `id` = ?');
                    $up->execute([$newHash, $cred['id']]);
                }

                // Update login statistics
                try {
                    $upLogin = $pdo->prepare('UPDATE `solar_auth_credentials` SET `last_login_at` = NOW(), `failed_login_attempts` = 0 WHERE `id` = ?');
                    $upLogin->execute([$cred['id']]);
                } catch (Exception $e) {}

                $accountType = strtoupper(trim((string)($cred['account_type'] ?? 'ADMIN')));
                $linkedEntityId = $cred['linked_entity_id'] ?: $cred['user_id'];
                $credMustChange = !empty($cred['must_change_password']);

                $lookupUser = function () use ($pdo, $cred, $email, $accountType, $credMustChange) {
                    $stmtU = $pdo->prepare('SELECT * FROM `solar_users` WHERE `id` = ? OR LOWER(email) = ? LIMIT 1');
                    $stmtU->execute([$cred['user_id'], $email]);
                    $u = $stmtU->fetch(PDO::FETCH_ASSOC);
                    if (!$u) return null;
                    $uStat = strtoupper(trim((string)($u['status'] ?? 'ACTIVE')));
                    if (in_array($uStat, ['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'], true)) {
                        return ['__disabled' => true];
                    }
                    return [
                        'id' => $u['id'],
                        'userId' => $u['id'],
                        'employeeId' => $u['employee_id'] ?? $u['id'],
                        'name' => $u['name'] ?? 'User',
                        'email' => $u['email'],
                        'role' => $cred['role'] ?: ($u['role'] ?? 'Admin'),
                        'phone' => $u['phone'] ?? '',
                        'department' => $u['department'] ?? 'Administration',
                        'designation' => $u['designation'] ?? 'Staff',
                        'isFieldWorker' => (bool)($u['is_field_worker'] ?? false),
                        'accountType' => $accountType,
                        'status' => $u['status'] ?? 'ACTIVE',
                        'mustChangePassword' => $credMustChange || !empty($u['must_change_password'])
                    ];
                };

                if ($accountType === 'CUSTOMER') {
                    $rawCustLookup = preg_replace('/^usr-/', '', (string)$linkedEntityId);
                    $stmtC = $pdo->prepare('SELECT * FROM `solar_customers` WHERE `id` = ? OR `id` = ? OR LOWER(email) = ? LIMIT 1');
                    $stmtC->execute([$rawCustLookup, $linkedEntityId, $email]);
                    $c = $stmtC->fetch(PDO::FETCH_ASSOC);
                    if ($c && in_array(strtoupper(trim((string)($c['status'] ?? 'ACTIVE'))), ['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'], true)) {
                        http_response_code(403);
                        echo json_encode(['success' => false, 'message' => 'Account has been disabled. Please contact system administrator.']);
                        exit;
                    }
                    if ($c) {
                        $resolvedCustId = preg_replace('/^usr-/', '', (string)$c['id']);
                        $authenticatedUser = [
                            'id' => 'usr-' . $resolvedCustId,
                            'userId' => 'usr-' . $resolvedCustId,
                            'customerId' => $c['id'],
                            'employeeId' => 'CUST-' . $c['id'],
                            'name' => $c['name'] ?? 'Customer',
                            'email' => $c['email'] ?? $cred['email'],
                            'role' => 'Customer',
                            'phone' => $c['phone'] ?? '',
                            'department' => 'Customer Portal',
                            'designation' => 'Customer',
                            'isFieldWorker' => false,
                            'accountType' => 'CUSTOMER',
                            'status' => $c['status'] ?? 'ACTIVE',
                            'mustChangePassword' => $credMustChange
                        ];
                        $linkedEntityId = $c['id'];
                    } else {
                        $fallbackCustUser = $lookupUser();
                        if ($fallbackCustUser && empty($fallbackCustUser['__disabled'])) {
                            $authenticatedUser = $fallbackCustUser;
                        }
                    }
                } else {
                    $lookupEmployee = function () use ($pdo, $cred, $linkedEntityId, $email, $accountType, $credMustChange) {
                        $emp = null;
                        try {
                            $stmtE = $pdo->prepare('SELECT * FROM `solar_employees` WHERE `id` = ? OR `id` = ? OR `auth_uid` = ? OR LOWER(email) = ? LIMIT 1');
                            $stmtE->execute([$linkedEntityId, $cred['user_id'], $cred['user_id'], $email]);
                            $emp = $stmtE->fetch(PDO::FETCH_ASSOC);
                        } catch (Exception $e) {}
                        if (!$emp) {
                            try {
                                $stmtEOld = $pdo->prepare('SELECT * FROM `solar_employee` WHERE `id` = ? OR `id` = ? OR `auth_uid` = ? OR LOWER(email) = ? LIMIT 1');
                                $stmtEOld->execute([$linkedEntityId, $cred['user_id'], $cred['user_id'], $email]);
                                $emp = $stmtEOld->fetch(PDO::FETCH_ASSOC);
                            } catch (Exception $e) {}
                        }
                        if (!$emp) return null;
                        $eDisabled = (isset($emp['login_enabled']) && intval($emp['login_enabled']) === 0)
                            || in_array(strtoupper(trim((string)($emp['status'] ?? 'ACTIVE'))), ['DISABLED', 'INACTIVE', 'TERMINATED'], true)
                            || strtoupper(trim((string)($emp['account_status'] ?? 'ACTIVE'))) === 'DISABLED';
                        if ($eDisabled) {
                            return ['__disabled' => true];
                        }
                        $isFw = (bool)($emp['is_field_worker'] ?? false) || in_array($emp['system_role'] ?? '', [
                            'Site Survey Engineer', 'Site Inspector', 'Civil Team', 'Structure Team', 'Installation Team', 'Electrical Team', 'Technician'
                        ]);
                        return [
                            'id' => $emp['id'],
                            'userId' => $emp['auth_uid'] ?? $emp['id'],
                            'employeeId' => $emp['employee_code'] ?? $emp['id'],
                            'name' => $emp['name'] ?? 'Solar Employee',
                            'email' => $emp['email'],
                            'role' => $cred['role'] ?: ($emp['system_role'] ?? $emp['assigned_role'] ?? 'Technician'),
                            'phone' => $emp['phone'] ?? '',
                            'department' => $emp['department'] ?? 'Operations',
                            'designation' => $emp['designation'] ?? $cred['role'],
                            'isFieldWorker' => $isFw,
                            'accountType' => $accountType,
                            'status' => $emp['status'] ?? 'ACTIVE',
                            'mustChangePassword' => $credMustChange
                        ];
                    };

                    $resolvedProfile = ($accountType === 'ADMIN')
                        ? ($lookupUser() ?: $lookupEmployee())
                        : ($lookupEmployee() ?: $lookupUser());

                    if (is_array($resolvedProfile) && !empty($resolvedProfile['__disabled'])) {
                        http_response_code(403);
                        echo json_encode(['success' => false, 'message' => 'Account has been disabled. Please contact system administrator.']);
                        exit;
                    }
                    if ($resolvedProfile) {
                        $authenticatedUser = $resolvedProfile;
                    }
                }
            }
        }
    } catch (Exception $e) {
        error_log('Notice during solar_auth_credentials login check: ' . $e->getMessage());
    }

    // 2. Secondary fallback via solar_users table
    if (!$authenticatedUser) {
        try {
            $stmt = $pdo->prepare('SELECT * FROM `solar_users` WHERE LOWER(email) = ? LIMIT 1');
            $stmt->execute([$email]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);

            if ($user) {
                $storedHash = (string)($user['password'] ?? '');
                $matches = false;

                if (!empty($storedHash) && password_verify($password, $storedHash)) {
                    $matches = true;
                } elseif (!empty($storedHash) && hash_equals($storedHash, $password)) {
                    $matches = true;
                    try {
                        $storedHash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
                        $up = $pdo->prepare('UPDATE `solar_users` SET `password` = ? WHERE `id` = ?');
                        $up->execute([$storedHash, $user['id']]);
                    } catch (Exception $e) {}
                }

                if ($matches) {
                    $uStat = strtoupper(trim((string)($user['status'] ?? 'ACTIVE')));
                    if (in_array($uStat, ['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'], true)) {
                        $disabledAccountMsg = 'Account has been disabled. Please contact system administrator.';
                    } else {
                        $uRole = $user['role'] ?? 'Admin';
                        $accountType = (strcasecmp($uRole, 'Customer') === 0) ? 'CUSTOMER' : (in_array(strtoupper(trim($uRole)), ['ADMIN', 'SUPER ADMIN'], true) ? 'ADMIN' : 'EMPLOYEE');
                        $authenticatedUser = [
                            'id' => $user['id'],
                            'userId' => $user['id'],
                            'employeeId' => $user['employee_id'] ?? $user['id'],
                            'name' => $user['name'] ?? 'User',
                            'email' => $user['email'],
                            'role' => $uRole,
                            'phone' => $user['phone'] ?? '',
                            'department' => $user['department'] ?? 'Administration',
                            'designation' => $user['designation'] ?? 'Staff',
                            'isFieldWorker' => (bool)($user['is_field_worker'] ?? false),
                            'accountType' => $accountType,
                            'status' => $user['status'] ?? 'ACTIVE'
                        ];
                        $linkedEntityId = $user['employee_id'] ?? $user['id'];
                        syncAuthCredentialPhp($pdo, $user['id'], $email, $storedHash, $uRole, $accountType, $linkedEntityId, 'ACTIVE');
                    }
                }
            }
        } catch (PDOException $e) {
            error_log('User query error: ' . $e->getMessage());
        }
    }

    // 3. Tertiary fallback via solar_employees table
    if (!$authenticatedUser && !$disabledAccountMsg) {
        try {
            $emp = null;
            try {
                $stmtEmp = $pdo->prepare('SELECT * FROM `solar_employees` WHERE LOWER(email) = ? LIMIT 1');
                $stmtEmp->execute([$email]);
                $emp = $stmtEmp->fetch(PDO::FETCH_ASSOC);
            } catch (Exception $e) {}

            if (!$emp) {
                try {
                    $stmtEmpOld = $pdo->prepare('SELECT * FROM `solar_employee` WHERE LOWER(email) = ? LIMIT 1');
                    $stmtEmpOld->execute([$email]);
                    $emp = $stmtEmpOld->fetch(PDO::FETCH_ASSOC);
                } catch (Exception $e) {}
            }

            if ($emp) {
                $ePass = (string)($emp['password'] ?? '');
                $eMatches = !empty($ePass) && (password_verify($password, $ePass) || hash_equals($ePass, $password));
                if ($eMatches) {
                    $eDisabled = (isset($emp['login_enabled']) && intval($emp['login_enabled']) === 0)
                        || in_array(strtoupper(trim((string)($emp['status'] ?? 'ACTIVE'))), ['DISABLED', 'INACTIVE', 'TERMINATED'], true)
                        || strtoupper(trim((string)($emp['account_status'] ?? 'ACTIVE'))) === 'DISABLED';
                    if ($eDisabled) {
                        $disabledAccountMsg = 'Account has been disabled. Please contact system administrator.';
                    } else {
                        if (!str_starts_with($ePass, '$2') && !str_starts_with($ePass, '$argon2')) {
                            $ePass = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
                        }
                        $isFw = (bool)($emp['is_field_worker'] ?? false) || in_array($emp['system_role'] ?? '', [
                            'Site Survey Engineer', 'Site Inspector', 'Civil Team', 'Structure Team', 'Installation Team', 'Electrical Team', 'Technician'
                        ]);
                        $eRole = $emp['system_role'] ?? $emp['assigned_role'] ?? 'Technician';
                        $accountType = in_array(strtoupper(trim($eRole)), ['ADMIN', 'SUPER ADMIN'], true) ? 'ADMIN' : 'EMPLOYEE';
                        $authenticatedUser = [
                            'id' => $emp['id'],
                            'userId' => $emp['auth_uid'] ?? $emp['id'],
                            'employeeId' => $emp['employee_code'] ?? $emp['id'],
                            'name' => $emp['name'] ?? 'Solar Employee',
                            'email' => $emp['email'],
                            'role' => $eRole,
                            'phone' => $emp['phone'] ?? '',
                            'department' => $emp['department'] ?? 'Operations',
                            'designation' => $emp['designation'] ?? $eRole,
                            'isFieldWorker' => $isFw,
                            'accountType' => $accountType,
                            'status' => $emp['status'] ?? 'ACTIVE'
                        ];
                        $linkedEntityId = $emp['id'];
                        syncAuthCredentialPhp($pdo, $emp['auth_uid'] ?? $emp['id'], $email, $ePass, $eRole, $accountType, $emp['id'], 'ACTIVE');
                    }
                }
            }
        } catch (Exception $e) {}
    }

    // 4. Quaternary fallback via solar_customers table
    if (!$authenticatedUser && !$disabledAccountMsg) {
        try {
            $stmtCust = $pdo->prepare('SELECT * FROM `solar_customers` WHERE LOWER(email) = ? LIMIT 1');
            $stmtCust->execute([$email]);
            $cust = $stmtCust->fetch(PDO::FETCH_ASSOC);
            if ($cust) {
                $cHash = (string)($cust['password'] ?? '');
                $cMatches = !empty($cHash) && (password_verify($password, $cHash) || hash_equals($cHash, $password));
                if ($cMatches) {
                    $cStat = strtoupper(trim((string)($cust['status'] ?? 'ACTIVE')));
                    if (in_array($cStat, ['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'], true)) {
                        $disabledAccountMsg = 'Account has been disabled. Please contact system administrator.';
                    } else {
                        if (!str_starts_with($cHash, '$2') && !str_starts_with($cHash, '$argon2')) {
                            $cHash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
                            try {
                                $pdo->prepare('UPDATE `solar_customers` SET `password` = ? WHERE `id` = ?')->execute([$cHash, $cust['id']]);
                            } catch (Exception $e) {}
                        }
                        $accountType = 'CUSTOMER';
                        $rawCustId = preg_replace('/^usr-/', '', (string)$cust['id']);
                        $linkedEntityId = $cust['id'];
                        $authenticatedUser = [
                            'id' => 'usr-' . $rawCustId,
                            'userId' => 'usr-' . $rawCustId,
                            'customerId' => $cust['id'],
                            'employeeId' => 'CUST-' . $cust['id'],
                            'name' => $cust['name'] ?? 'Customer',
                            'email' => $cust['email'],
                            'role' => 'Customer',
                            'phone' => $cust['phone'] ?? '',
                            'department' => 'Customer Portal',
                            'designation' => 'Customer',
                            'isFieldWorker' => false,
                            'accountType' => 'CUSTOMER',
                            'status' => $cust['status'] ?? 'ACTIVE'
                        ];
                        syncAuthCredentialPhp($pdo, 'usr-' . $rawCustId, $email, $cHash, 'Customer', 'CUSTOMER', $cust['id'], 'ACTIVE');
                    }
                }
            }
        } catch (Exception $e) {}
    }

    if ($disabledAccountMsg) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => $disabledAccountMsg]);
        exit;
    }

    if ($authenticatedUser) {
        // Persist session into MySQL solar_auth_sessions
        $sessionToken = createDbSession(
            $pdo,
            $authenticatedUser['id'],
            $authenticatedUser['email'],
            $authenticatedUser['role'],
            $accountType,
            $linkedEntityId
        );

        // Issue HttpOnly, Secure, SameSite, and Partitioned session cookies
        setServerSessionCookie($sessionToken);

        http_response_code(200);
        echo json_encode([
            'success' => true,
            'user' => $authenticatedUser,
            'token' => $sessionToken
        ]);
        exit;
    }

    http_response_code(401);
    echo json_encode([
        'success' => false,
        'message' => 'Invalid credentials. Please verify your email and password in MySQL.'
    ]);
    exit;
}

// GET /api/auth/me & /api/auth/verify - Restore & Authorize User Session on Page Refresh
if ($method === 'GET' && in_array($cleanPath, ['/auth/me', '/auth/me/', '/auth/verify', '/auth/verify/'])) {
    $token = extractIncomingSessionToken();
    if (empty($token)) {
        http_response_code(401);
        echo json_encode([
            'success' => false,
            'message' => 'Authentication required. No session token provided in cookie or headers.'
        ]);
        exit;
    }

    $pdo = getDbConnection($dbConfig);
    if (!$pdo) {
        http_response_code(503);
        echo json_encode([
            'success' => false,
            'message' => 'Database connection temporarily unavailable. Session preserved in browser.'
        ]);
        exit;
    }
    ensureRequiredTables($pdo);

    $user = validateDbSession($pdo, $token);
    if (!$user) {
        // Do not clear cookie on query lookup failure; preserve credentials and reject request safely
        http_response_code(401);
        echo json_encode([
            'success' => false,
            'message' => 'Session expired or not found in MySQL authoritative store.'
        ]);
        exit;
    }

    if (!empty($user['status']) && in_array(strtoupper(trim((string)$user['status'])), ['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'], true)) {
        clearServerSessionCookie();
        http_response_code(403);
        echo json_encode([
            'success' => false,
            'message' => 'Account has been disabled. Please contact system administrator.'
        ]);
        exit;
    }

    // Refresh and extend session cookie
    setServerSessionCookie($token);

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'user' => $user,
        'token' => $token
    ]);
    exit;
}

// POST /api/auth/logout - Terminate Session in MySQL & Clear Session Cookies
if ($method === 'POST' && in_array($cleanPath, ['/auth/logout', '/auth/logout/'])) {
    $token = extractIncomingSessionToken();
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if (!empty($token)) {
        destroyDbSession($pdo, $token);
    }
    clearServerSessionCookie();

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'Logged out successfully. Session invalidated in MySQL.'
    ]);
    exit;
}

// POST /api/auth/change-password
if ($method === 'POST' && in_array($cleanPath, ['/auth/change-password', '/auth/change-password/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    $userId = trim($body['userId'] ?? ($actor['id'] ?? ''));
    $oldPass = trim($body['oldPassword'] ?? '');
    $newPass = trim($body['newPassword'] ?? '');
    if (empty($userId) || empty($oldPass) || empty($newPass)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'User ID, current password, and new password are required.']);
        exit;
    }
    $actorRoleUpper = strtoupper(trim((string)($actor['role'] ?? '')));
    $isActorAdmin = in_array($actorRoleUpper, ['ADMIN', 'SUPER ADMIN'], true);
    $isSelf = ($userId === ($actor['id'] ?? '')) || (strtolower($userId) === strtolower((string)($actor['email'] ?? '')));
    if (!$isActorAdmin && !$isSelf) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Forbidden: You can only change your own password.']);
        exit;
    }
    if (strlen($newPass) < 8) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'New password must be at least 8 characters long.']);
        exit;
    }
    if ($newPass === $oldPass) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'New password must differ from current password.']);
        exit;
    }
    $rawCustId = preg_replace('/^usr-/', '', $userId);
    $currentHash = null;
    $resolvedEmail = '';

    $stmt = $pdo->prepare('SELECT id, email, password FROM `solar_users` WHERE id = ? LIMIT 1');
    $stmt->execute([$userId]);
    if ($u = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $currentHash = $u['password'] ?? null;
        $resolvedEmail = strtolower(trim((string)($u['email'] ?? '')));
    }
    if (empty($currentHash)) {
        $stmtC = $pdo->prepare('SELECT id, email, password FROM `solar_customers` WHERE id = ? OR id = ? LIMIT 1');
        $stmtC->execute([$rawCustId, $userId]);
        if ($c = $stmtC->fetch(PDO::FETCH_ASSOC)) {
            $currentHash = $c['password'] ?? null;
            $resolvedEmail = strtolower(trim((string)($c['email'] ?? '')));
        }
    }
    if (empty($currentHash)) {
        $stmtCred = $pdo->prepare('SELECT user_id, email, password_hash FROM `solar_auth_credentials` WHERE user_id = ? OR linked_entity_id = ? LIMIT 1');
        $stmtCred->execute([$userId, $rawCustId]);
        if ($cr = $stmtCred->fetch(PDO::FETCH_ASSOC)) {
            $currentHash = $cr['password_hash'] ?? null;
            $resolvedEmail = strtolower(trim((string)($cr['email'] ?? '')));
        }
    }
    if (empty($currentHash)) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'User account not found.']);
        exit;
    }
    $validOld = password_verify($oldPass, $currentHash) || hash_equals((string)$currentHash, (string)$oldPass);
    if (!$validOld) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Current password does not match.']);
        exit;
    }
    $hashed = password_hash($newPass, PASSWORD_BCRYPT, ['cost' => 10]);
    $pdo->prepare('UPDATE `solar_users` SET `password` = ?, `must_change_password` = 0, `updated_at` = CURRENT_TIMESTAMP WHERE id = ?')->execute([$hashed, $userId]);
    $pdo->prepare('UPDATE `solar_customers` SET `password` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE id = ? OR id = ?')->execute([$hashed, $rawCustId, $userId]);
    try {
        $pdo->prepare('UPDATE `solar_auth_credentials` SET `password_hash` = ?, `must_change_password` = 0, `password_changed_at` = NOW() WHERE `user_id` = ? OR `linked_entity_id` = ?' . (!empty($resolvedEmail) ? ' OR LOWER(`email`) = ?' : ''))
            ->execute(!empty($resolvedEmail) ? [$hashed, $userId, $rawCustId, $resolvedEmail] : [$hashed, $userId, $rawCustId]);
    } catch (Exception $e) {}
    http_response_code(200);
    echo json_encode(['success' => true, 'mustChangePassword' => false, 'message' => 'Password changed and securely hashed with bcrypt in MySQL.']);
    exit;
}

// POST /api/auth/reset-password
if ($method === 'POST' && in_array($cleanPath, ['/auth/reset-password', '/auth/reset-password/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);
    $email = strtolower(trim($body['email'] ?? ''));
    $newPass = trim($body['newPassword'] ?? '');
    if (empty($email) || empty($newPass)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Email address and new password are required.']);
        exit;
    }
    if (strlen($newPass) < 8) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'New password must be at least 8 characters long.']);
        exit;
    }
    $hashed = password_hash($newPass, PASSWORD_BCRYPT, ['cost' => 10]);
    $pdo->prepare('UPDATE `solar_users` SET `password` = ?, `must_change_password` = 0, `updated_at` = CURRENT_TIMESTAMP WHERE LOWER(email) = ?')->execute([$hashed, $email]);
    $pdo->prepare('UPDATE `solar_customers` SET `password` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE LOWER(email) = ?')->execute([$hashed, $email]);
    try {
        $pdo->prepare('UPDATE `solar_auth_credentials` SET `password_hash` = ?, `must_change_password` = 0, `password_changed_at` = NOW() WHERE LOWER(`email`) = ?')
            ->execute([$hashed, $email]);
    } catch (Exception $e) {}
    logSolarUsersAuditPhp('PASSWORD_RESET', 'POST /auth/reset-password', $email, $email, $actor);
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => "Password for $email reset and securely hashed with bcrypt in MySQL."]);
    exit;
}

// PUT /api/customers/{id}/password (Protected: Admin / Super Admin or matching Customer)
if ($method === 'PUT' && preg_match('#^/customers/([^/]+)/password/?$#', $cleanPath, $matches)) {
    $custId = urldecode($matches[1]);
    $rawCustId = preg_replace('/^usr-/', '', $custId);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    $actorRoleUpper = strtoupper(trim((string)($actor['role'] ?? '')));
    $isActorAdmin = in_array($actorRoleUpper, ['ADMIN', 'SUPER ADMIN'], true);
    $actorCustId = preg_replace('/^usr-/', '', (string)($actor['customerId'] ?? $actor['id'] ?? ''));
    if (!$isActorAdmin && $actorCustId !== $rawCustId) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied: Cannot update another customer password.']);
        exit;
    }
    $newPass = trim($body['password'] ?? '');
    if (empty($newPass) || strlen($newPass) < 6) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Password must be at least 6 characters long.']);
        exit;
    }
    $hashed = password_hash($newPass, PASSWORD_BCRYPT, ['cost' => 10]);
    $stmtC = $pdo->prepare('SELECT id, email, status FROM `solar_customers` WHERE id = ? OR id = ? LIMIT 1');
    $stmtC->execute([$rawCustId, $custId]);
    $custRow = $stmtC->fetch(PDO::FETCH_ASSOC);
    if (!$custRow) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Customer record not found in MySQL.']);
        exit;
    }
    $pdo->prepare('UPDATE `solar_customers` SET `password` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE id = ?')
        ->execute([$hashed, $custRow['id']]);
    $custEmail = strtolower(trim((string)($custRow['email'] ?? '')));
    if (!empty($custEmail)) {
        $credStatus = in_array(strtoupper((string)($custRow['status'] ?? 'ACTIVE')), ['DISABLED', 'INACTIVE'], true) ? 'DISABLED' : 'ACTIVE';
        syncAuthCredentialPhp($pdo, 'usr-' . preg_replace('/^usr-/', '', $custRow['id']), $custEmail, $hashed, 'Customer', 'CUSTOMER', $custRow['id'], $credStatus);
    }
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => 'Customer password updated and securely hashed with bcrypt in MySQL.']);
    exit;
}

// GET /api/users (Protected: Admin / Super Admin / HR Manager)
if ($method === 'GET' && in_array($cleanPath, ['/users', '/users/'])) {
    $pdo = getDbConnection($dbConfig);
    requireAdminOrHrUserPhp($pdo);
    $stmt = $pdo->query('SELECT id, name, email, role, phone, department, designation, employee_id, is_field_worker, status, created_at, updated_at FROM `solar_users` ORDER BY created_at ASC');
    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $sanitized = array_map(function($u) {
        return [
            'id' => $u['id'],
            'name' => $u['name'],
            'email' => $u['email'],
            'role' => $u['role'],
            'phone' => $u['phone'] ?? '',
            'department' => $u['department'] ?? 'Operations',
            'designation' => $u['designation'] ?? '',
            'employeeId' => $u['employee_id'] ?? '',
            'isFieldWorker' => (bool)($u['is_field_worker'] ?? 0),
            'status' => $u['status'] ?? 'ACTIVE',
            'createdAt' => $u['created_at'],
            'updatedAt' => $u['updated_at']
        ];
    }, $users ?: []);
    http_response_code(200);
    echo json_encode(['success' => true, 'count' => count($sanitized), 'data' => $sanitized]);
    exit;
}

// POST /api/users (Protected: Admin / Super Admin)
if ($method === 'POST' && in_array($cleanPath, ['/users', '/users/'])) {
    $pdo = getDbConnection($dbConfig);
    $actor = requireAdminUserPhp($pdo);
    if (empty($body['name']) || empty($body['email'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'User name and email are required.']);
        exit;
    }
    $saved = saveUserToDb($pdo, $body, false, $actor);
    http_response_code(201);
    echo json_encode(['success' => true, 'data' => $saved, 'message' => 'User saved to MySQL successfully.']);
    exit;
}

// PUT /api/users/{id}/password (Protected: Admin / Super Admin)
if ($method === 'PUT' && preg_match('#^/users/([^/]+)/password/?$#', $cleanPath, $matches)) {
    $userId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);
    $newPass = trim($body['password'] ?? '');
    if (empty($newPass) || strlen($newPass) < 6) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Password must be at least 6 characters long.']);
        exit;
    }
    $hashed = password_hash($newPass, PASSWORD_BCRYPT, ['cost' => 10]);
    $stmt = $pdo->prepare('UPDATE `solar_users` SET `password` = ?, `must_change_password` = 0, `updated_at` = CURRENT_TIMESTAMP WHERE id = ?');
    $stmt->execute([$hashed, $userId]);
    try {
        $pdo->prepare('UPDATE `solar_auth_credentials` SET `password_hash` = ?, `must_change_password` = 0, `password_changed_at` = NOW() WHERE `user_id` = ? OR `linked_entity_id` = ?')
            ->execute([$hashed, $userId, $userId]);
    } catch (Exception $e) {}
    logSolarUsersAuditPhp('PASSWORD_UPDATE', 'PUT /users/{id}/password', $userId, '', $actor);
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => 'User password updated and securely hashed with bcrypt in MySQL.']);
    exit;
}

// PUT /api/users/{id} (Protected: Admin / Super Admin, strictly update-only)
if ($method === 'PUT' && preg_match('#^/users/([^/]+)/?$#', $cleanPath, $matches)) {
    $userId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);
    $body['id'] = $userId;
    try {
        $saved = saveUserToDb($pdo, $body, true, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved, 'message' => 'User updated in MySQL successfully.']);
    } catch (Exception $e) {
        $code = ($e->getCode() === 404) ? 404 : 500;
        http_response_code($code);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    }
    exit;
}

// DELETE /api/users/{id} (Protected: Admin / Super Admin, cascades cleanly)
if ($method === 'DELETE' && preg_match('#^/users/([^/]+)/?$#', $cleanPath, $matches)) {
    $userId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);
    try {
        deleteItemFromDb($pdo, 'users', $userId, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'deletedId' => $userId, 'message' => 'User deleted from MySQL successfully.']);
    } catch (Exception $e) {
        $exCode = intval($e->getCode());
        $statusCode = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
        http_response_code($statusCode);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
    }
    exit;
}

// Direct /api/employees, photo/document upload endpoints, and /api/admin/create|update-employee-account
if (in_array($cleanPath, ['/employees', '/employee'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    if ($method === 'GET') {
        $actor = requireAuthUserPhp($pdo);
        $stmt = $pdo->query('SELECT * FROM `solar_employees` ORDER BY `created_at` ASC');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $docMap = [];
        try {
            $dStmt = $pdo->query('SELECT * FROM `solar_employee_documents` ORDER BY `uploaded_at` DESC');
            foreach (($dStmt->fetchAll(PDO::FETCH_ASSOC) ?: []) as $d) {
                $docMap[$d['employee_id']][] = [
                    'id' => $d['id'],
                    'category' => $d['category'],
                    'name' => $d['name'],
                    'fileName' => $d['file_name'],
                    'filePath' => $d['file_path'],
                    'fileUrl' => $d['file_url'],
                    'mimeType' => $d['mime_type'],
                    'fileSize' => intval($d['file_size'] ?? 0),
                    'uploadedAt' => !empty($d['uploaded_at']) ? date('c', strtotime($d['uploaded_at'])) : date('c'),
                    'uploadedBy' => $d['uploaded_by'] ?? 'HR Administrator',
                    'notes' => $d['notes'] ?? null
                ];
            }
        } catch (Exception $e) {}

        $mapped = array_map(function($r) use ($docMap) {
            $docs = $docMap[$r['id']] ?? [];
            if (empty($docs) && !empty($r['documents_json'])) {
                $parsed = json_decode($r['documents_json'], true);
                if (is_array($parsed)) $docs = $parsed;
            }
            return [
                'id' => $r['id'],
                'authUid' => $r['auth_uid'] ?? $r['id'],
                'employeeCode' => $r['employee_code'],
                'name' => $r['name'],
                'photoUrl' => $r['photo_url'] ?? '',
                'documents' => $docs,
                'department' => $r['department'] ?? 'Operations',
                'designation' => $r['designation'] ?? '',
                'phone' => $r['phone'] ?? '',
                'email' => $r['email'] ?? '',
                'joiningDate' => !empty($r['joining_date']) ? substr((string)$r['joining_date'], 0, 10) : '',
                'salaryMonthly' => floatval($r['salary_monthly'] ?? 0),
                'esicNumber' => $r['esic_number'] ?? '',
                'bankAccountNumber' => $r['bank_account_number'] ?? '',
                'bankName' => $r['bank_name'] ?? '',
                'ifscCode' => $r['ifsc_code'] ?? '',
                'emergencyContactPerson' => $r['emergency_contact_person'] ?? '',
                'emergencyContactNumber' => $r['emergency_contact_number'] ?? '',
                'status' => $r['status'] ?? 'ACTIVE',
                'currentSiteLocation' => $r['current_site_location'] ?? '',
                'loginEnabled' => (bool)($r['login_enabled'] ?? 1),
                'systemRole' => $r['system_role'] ?? 'Site Survey Engineer',
                'assignedRole' => $r['assigned_role'] ?? ($r['system_role'] ?? 'Site Survey Engineer'),
                'isFieldWorker' => (bool)($r['is_field_worker'] ?? 0),
                'accountStatus' => $r['account_status'] ?? 'ACTIVE',
                'createdAt' => $r['created_at'] ?? null
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($mapped), 'data' => $mapped]);
        exit;
    }
    if ($method === 'POST') {
        $actor = requireAdminOrHrUserPhp($pdo);
        try {
            $saved = saveEmployeeToDb($pdo, $body, $actor);
            http_response_code(201);
            echo json_encode(['success' => true, 'data' => $saved]);
        } catch (Exception $e) {
            $exCode = intval($e->getCode());
            $statusCode = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
            http_response_code($statusCode);
            echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
        }
        exit;
    }
}

// GET /api/employees/{id}/documents
if ($method === 'GET' && preg_match('#^/(?:employees|employee)/([^/]+)/documents/?$#', $cleanPath, $matches)) {
    $empId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    $stmt = $pdo->prepare('SELECT * FROM `solar_employee_documents` WHERE `employee_id` = ? ORDER BY `uploaded_at` DESC');
    $stmt->execute([$empId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $docs = array_map(function($d) {
        return [
            'id' => $d['id'],
            'employeeId' => $d['employee_id'],
            'category' => $d['category'],
            'name' => $d['name'],
            'fileName' => $d['file_name'],
            'filePath' => $d['file_path'],
            'fileUrl' => $d['file_url'],
            'mimeType' => $d['mime_type'],
            'fileSize' => intval($d['file_size'] ?? 0),
            'uploadedAt' => !empty($d['uploaded_at']) ? date('c', strtotime($d['uploaded_at'])) : date('c'),
            'uploadedBy' => $d['uploaded_by'] ?? 'HR Administrator',
            'notes' => $d['notes'] ?? null
        ];
    }, $rows);
    http_response_code(200);
    echo json_encode(['success' => true, 'count' => count($docs), 'data' => $docs]);
    exit;
}

// POST /api/employees/{id}/documents/upload
if ($method === 'POST' && preg_match('#^/(?:employees|employee)/([^/]+)/documents/upload/?$#', $cleanPath, $matches)) {
    $empId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);

    $fileName = trim((string)($body['fileName'] ?? ''));
    $fileData = $body['fileData'] ?? '';
    if (empty($fileName) || empty($fileData) || !is_string($fileData)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'File name and fileData (base64) are required.', 'message' => 'File name and fileData (base64) are required.']);
        exit;
    }

    $safeEmpId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($empId));
    $safeFileName = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename($fileName));
    $ext = strtolower(pathinfo($safeFileName, PATHINFO_EXTENSION));
    $allowedDocExts = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'webp'];
    if (!in_array($ext, $allowedDocExts, true)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Unsupported file format. Only PDF, DOC, DOCX, JPG, PNG, and WebP files are allowed.', 'message' => 'Unsupported file format. Only PDF, DOC, DOCX, JPG, PNG, and WebP files are allowed.']);
        exit;
    }
    $docId = 'doc-' . round(microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(3)), 0, 5);
    $diskFileName = $docId . '_' . $safeFileName;

    $webRoot = dirname(__DIR__);
    $empDocsDir = $webRoot . '/uploads/employees/' . $safeEmpId . '/documents';
    if (!is_dir($empDocsDir)) {
        @mkdir($empDocsDir, 0755, true);
    }
    if (!is_dir($empDocsDir) || !is_writable($empDocsDir)) {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Upload directory is not writable on server.', 'message' => 'Upload directory is not writable on server.']);
        exit;
    }

    $base64Data = strpos($fileData, ',') !== false ? explode(',', $fileData, 2)[1] : $fileData;
    $fileBuffer = base64_decode(preg_replace('/\s+/', '', $base64Data), true);
    if ($fileBuffer === false || strlen($fileBuffer) === 0) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid or empty document payload.', 'message' => 'Invalid or empty document payload.']);
        exit;
    }
    if (strlen($fileBuffer) > 20 * 1024 * 1024) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Document file size exceeds 20 MB limit.', 'message' => 'Document file size exceeds 20 MB limit.']);
        exit;
    }

    $fullPath = $empDocsDir . '/' . $diskFileName;
    if (@file_put_contents($fullPath, $fileBuffer) === false) {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Failed to write document file to disk.', 'message' => 'Failed to write document file to disk.']);
        exit;
    }

    $relativePath = 'uploads/employees/' . $safeEmpId . '/documents/' . $diskFileName;
    $fileUrl = '/uploads/employees/' . $safeEmpId . '/documents/' . $diskFileName;
    $category = trim((string)($body['category'] ?? 'Other')) ?: 'Other';
    $docTitle = trim((string)($body['name'] ?? '')) ?: (preg_replace('/\.[^.]+$/', '', $fileName) ?: $fileName);
    $mimeType = trim((string)($body['mimeType'] ?? '')) ?: 'application/octet-stream';
    $uploadedBy = trim((string)($body['uploadedBy'] ?? ($actor['name'] ?? 'HR Administrator')));
    $notes = isset($body['notes']) && trim((string)$body['notes']) !== '' ? trim((string)$body['notes']) : null;
    $fileSize = strlen($fileBuffer);

    $pdo->prepare("
        INSERT INTO `solar_employee_documents` (
            `id`, `employee_id`, `category`, `name`, `file_name`,
            `file_path`, `file_url`, `mime_type`, `file_size`,
            `uploaded_at`, `uploaded_by`, `notes`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
        ON DUPLICATE KEY UPDATE
            `category` = VALUES(`category`),
            `name` = VALUES(`name`),
            `file_name` = VALUES(`file_name`),
            `file_path` = VALUES(`file_path`),
            `file_url` = VALUES(`file_url`),
            `mime_type` = VALUES(`mime_type`),
            `file_size` = VALUES(`file_size`),
            `notes` = VALUES(`notes`)
    ")->execute([
        $docId, $empId, $category, $docTitle, $safeFileName,
        $relativePath, $fileUrl, $mimeType, $fileSize, $uploadedBy, $notes
    ]);

    try {
        $dStmt = $pdo->prepare('SELECT * FROM `solar_employee_documents` WHERE `employee_id` = ? ORDER BY `uploaded_at` DESC');
        $dStmt->execute([$empId]);
        $allDocs = array_map(function($d) {
            return [
                'id' => $d['id'],
                'category' => $d['category'],
                'name' => $d['name'],
                'fileName' => $d['file_name'],
                'filePath' => $d['file_path'],
                'fileUrl' => $d['file_url'],
                'mimeType' => $d['mime_type'],
                'fileSize' => intval($d['file_size'] ?? 0),
                'uploadedAt' => !empty($d['uploaded_at']) ? date('c', strtotime($d['uploaded_at'])) : date('c'),
                'uploadedBy' => $d['uploaded_by'] ?? 'HR Administrator',
                'notes' => $d['notes'] ?? null
            ];
        }, $dStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
        $pdo->prepare('UPDATE `solar_employees` SET `documents_json` = ? WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ?')
            ->execute([json_encode($allDocs), $empId, $empId, $empId]);
    } catch (Exception $e) {}

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => "Document \"$safeFileName\" uploaded and stored persistently on production server.",
        'document' => [
            'id' => $docId,
            'employeeId' => $empId,
            'category' => $category,
            'name' => $docTitle,
            'fileName' => $safeFileName,
            'filePath' => $relativePath,
            'fileUrl' => $fileUrl,
            'mimeType' => $mimeType,
            'fileSize' => $fileSize,
            'uploadedAt' => date('c'),
            'uploadedBy' => $uploadedBy,
            'notes' => $notes
        ]
    ]);
    exit;
}

// DELETE /api/employees/{id}/documents/{docId}
if ($method === 'DELETE' && preg_match('#^/(?:employees|employee)/([^/]+)/documents/([^/]+)/?$#', $cleanPath, $matches)) {
    $empId = urldecode($matches[1]);
    $docId = urldecode($matches[2]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);

    try {
        $stmtPath = $pdo->prepare('SELECT file_path FROM `solar_employee_documents` WHERE `id` = ? AND `employee_id` = ? LIMIT 1');
        $stmtPath->execute([$docId, $empId]);
        $row = $stmtPath->fetch(PDO::FETCH_ASSOC);
        if ($row && !empty($row['file_path'])) {
            $fullPath = dirname(__DIR__) . '/' . ltrim((string)$row['file_path'], '/');
            if (file_exists($fullPath)) {
                @unlink($fullPath);
            }
        }
    } catch (Exception $e) {}

    $pdo->prepare('DELETE FROM `solar_employee_documents` WHERE `id` = ? AND `employee_id` = ?')->execute([$docId, $empId]);

    try {
        $dStmt = $pdo->prepare('SELECT * FROM `solar_employee_documents` WHERE `employee_id` = ? ORDER BY `uploaded_at` DESC');
        $dStmt->execute([$empId]);
        $allDocs = array_map(function($d) {
            return [
                'id' => $d['id'],
                'category' => $d['category'],
                'name' => $d['name'],
                'fileName' => $d['file_name'],
                'filePath' => $d['file_path'],
                'fileUrl' => $d['file_url'],
                'mimeType' => $d['mime_type'],
                'fileSize' => intval($d['file_size'] ?? 0),
                'uploadedAt' => !empty($d['uploaded_at']) ? date('c', strtotime($d['uploaded_at'])) : date('c'),
                'uploadedBy' => $d['uploaded_by'] ?? 'HR Administrator',
                'notes' => $d['notes'] ?? null
            ];
        }, $dStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
        $pdo->prepare('UPDATE `solar_employees` SET `documents_json` = ? WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ?')
            ->execute([json_encode($allDocs), $empId, $empId, $empId]);
    } catch (Exception $e) {}

    http_response_code(200);
    echo json_encode(['success' => true, 'message' => 'Document removed from server and database.']);
    exit;
}

// POST /api/employees/{id}/photo/upload
if ($method === 'POST' && preg_match('#^/(?:employees|employee)/([^/]+)/photo/upload/?$#', $cleanPath, $matches)) {
    $empId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);

    $photoData = $body['photoData'] ?? '';
    $fileName = trim((string)($body['fileName'] ?? ''));
    if (empty($photoData) || !is_string($photoData)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Photo data (base64) is required.', 'message' => 'Photo data (base64) is required.']);
        exit;
    }

    $safeEmpId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($empId));
    $ext = $fileName ? ('.' . strtolower(pathinfo($fileName, PATHINFO_EXTENSION))) : '.jpg';
    $chosenExt = in_array($ext, ['.jpg', '.jpeg', '.png', '.webp'], true) ? $ext : '.jpg';
    $diskFileName = 'photo-' . round(microtime(true) * 1000) . $chosenExt;

    $webRoot = dirname(__DIR__);
    $empProfileDir = $webRoot . '/uploads/employees/' . $safeEmpId . '/profile';
    if (!is_dir($empProfileDir)) {
        @mkdir($empProfileDir, 0755, true);
    }
    if (!is_dir($empProfileDir) || !is_writable($empProfileDir)) {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Profile upload directory is not writable on server.', 'message' => 'Profile upload directory is not writable on server.']);
        exit;
    }

    $base64Data = strpos($photoData, ',') !== false ? explode(',', $photoData, 2)[1] : $photoData;
    $fileBuffer = base64_decode(preg_replace('/\s+/', '', $base64Data), true);
    if ($fileBuffer === false || strlen($fileBuffer) === 0) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid or empty image payload.', 'message' => 'Invalid or empty image payload.']);
        exit;
    }
    if (strlen($fileBuffer) > 5 * 1024 * 1024) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Profile photo exceeds 5 MB limit.', 'message' => 'Profile photo exceeds 5 MB limit.']);
        exit;
    }

    $fullPath = $empProfileDir . '/' . $diskFileName;
    if (@file_put_contents($fullPath, $fileBuffer) === false) {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Failed to write profile photo to disk.', 'message' => 'Failed to write profile photo to disk.']);
        exit;
    }

    $fileUrl = '/uploads/employees/' . $safeEmpId . '/profile/' . $diskFileName;

    $linkedAuthUid = $empId;
    $linkedEmpCode = $empId;
    $linkedEmpEmail = '';
    try {
        $stmtEmpMeta = $pdo->prepare('SELECT `id`, `auth_uid`, `employee_code`, `email` FROM `solar_employees` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 1');
        $stmtEmpMeta->execute([$empId, $empId, $empId]);
        if ($empMeta = $stmtEmpMeta->fetch(PDO::FETCH_ASSOC)) {
            $linkedAuthUid = !empty($empMeta['auth_uid']) ? $empMeta['auth_uid'] : $empMeta['id'];
            $linkedEmpCode = !empty($empMeta['employee_code']) ? $empMeta['employee_code'] : $empId;
            $linkedEmpEmail = strtolower(trim((string)($empMeta['email'] ?? '')));
        }
        $pdo->prepare('UPDATE `solar_employees` SET `photo_url` = ? WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ?')
            ->execute([$fileUrl, $empId, $empId, $empId]);
    } catch (Exception $e) {}
    try {
        $uWhere = '`id` = ? OR `id` = ? OR `employee_id` = ? OR `employee_id` = ?';
        $uMatchParams = [$empId, $linkedAuthUid, $empId, $linkedEmpCode];
        if (!empty($linkedEmpEmail)) {
            $uWhere .= ' OR LOWER(`email`) = ?';
            $uMatchParams[] = $linkedEmpEmail;
        }
        $pdo->prepare("UPDATE `solar_users` SET `avatar` = ?, `photo_url` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE {$uWhere}")
            ->execute(array_merge([$fileUrl, $fileUrl], $uMatchParams));
    } catch (Exception $e) {
        try {
            $pdo->prepare('UPDATE `solar_users` SET `avatar` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `id` = ? OR `id` = ? OR `employee_id` = ?')
                ->execute([$fileUrl, $empId, $linkedAuthUid, $linkedEmpCode]);
        } catch (Exception $e2) {}
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'Employee profile photo uploaded and saved successfully.',
        'photoUrl' => $fileUrl
    ]);
    exit;
}

// GET /api/uploads/employees/{employeeId}/{category}/{filename} - Streaming fallback for uploaded files
if ($method === 'GET' && preg_match('#^/uploads/employees/([^/]+)/([^/]+)/([^/]+)/?$#', $cleanPath, $matches)) {
    $rawEmp = urldecode($matches[1]);
    $rawCat = urldecode($matches[2]);
    $rawFile = urldecode($matches[3]);
    if (strpos($rawEmp, '..') !== false || strpos($rawCat, '..') !== false || strpos($rawFile, '..') !== false) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid file path access request.']);
        exit;
    }
    $safeEmpId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($rawEmp));
    $safeCat = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($rawCat));
    $safeName = basename($rawFile);
    $fullPath = dirname(__DIR__) . '/uploads/employees/' . $safeEmpId . '/' . $safeCat . '/' . $safeName;
    if (!file_exists($fullPath) || !is_file($fullPath)) {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'File not found on server.']);
        exit;
    }
    $ext = strtolower(pathinfo($safeName, PATHINFO_EXTENSION));
    $mimeMap = [
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png' => 'image/png',
        'webp' => 'image/webp',
        'pdf' => 'application/pdf',
        'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    $mime = $mimeMap[$ext] ?? 'application/octet-stream';
    header_remove('Content-Type');
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($fullPath));
    header('Content-Disposition: inline; filename="' . str_replace('"', '', $safeName) . '"');
    header('Cache-Control: public, max-age=86400');
    readfile($fullPath);
    exit;
}

if (preg_match('#^/(?:employees|employee)/([^/]+)/?$#', $cleanPath, $matches)) {
    $empId = urldecode($matches[1]);
    if (!in_array($empId, ['import', 'documents'], true)) {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        if ($method === 'PUT') {
            $actor = requireAdminOrHrUserPhp($pdo);
            $body['id'] = $empId;
            try {
                $saved = saveEmployeeToDb($pdo, $body, $actor);
                http_response_code(200);
                echo json_encode(['success' => true, 'data' => $saved]);
            } catch (Exception $e) {
                $exCode = intval($e->getCode());
                $statusCode = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
                http_response_code($statusCode);
                echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
            }
            exit;
        }
        if ($method === 'DELETE') {
            $actor = requireAdminOrHrUserPhp($pdo);
            try {
                deleteItemFromDb($pdo, 'employees', $empId, $actor);
                http_response_code(200);
                echo json_encode(['success' => true, 'deletedId' => $empId, 'message' => 'Employee deleted from MySQL.']);
            } catch (Exception $e) {
                $exCode = intval($e->getCode());
                $statusCode = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
                http_response_code($statusCode);
                echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
            }
            exit;
        }
    }
}

if ($method === 'POST' && in_array($cleanPath, ['/admin/create-employee-account', '/admin/create-user'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);
    $email = strtolower(trim((string)($body['email'] ?? '')));
    $password = trim((string)($body['password'] ?? ''));
    if (empty($email) || strpos($email, '@') === false || strlen($password) < 6) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Valid email and password (min 6 chars) are required.']);
        exit;
    }
    $cleanName = trim((string)($body['displayName'] ?? explode('@', $email)[0] ?: 'Solar Employee'));
    $cleanRole = $body['systemRole'] ?? 'Site Survey Engineer';
    $cleanCode = !empty($body['employeeCode']) ? trim((string)$body['employeeCode']) : ('EMP-' . rand(100, 999));
    $explicitId = !empty($body['id']) ? trim((string)$body['id']) : '';
    $uid = !empty($explicitId)
        ? $explicitId
        : ('usr-' . (!empty($body['employeeCode']) ? preg_replace('/[^a-z0-9_-]/', '', strtolower((string)$body['employeeCode'])) : round(microtime(true) * 1000)));
    $fwProvided = array_key_exists('isFieldWorker', $body) || array_key_exists('is_field_worker', $body);
    $fwVal = $fwProvided ? parseBoolFlagPhp($body['isFieldWorker'] ?? $body['is_field_worker'], false) : null;

    $userPayload = [
        'id' => $uid,
        'name' => $cleanName,
        'email' => $email,
        'password' => $password,
        'role' => $cleanRole,
        'employee_id' => $cleanCode,
        'phone' => $body['phone'] ?? '',
        'department' => $body['department'] ?? 'Operations',
        'designation' => $body['designation'] ?? $cleanRole,
        'status' => 'ACTIVE'
    ];
    if ($fwVal !== null) {
        $userPayload['isFieldWorker'] = $fwVal;
    }
    $savedUser = saveUserToDb($pdo, $userPayload, false, $actor);
    http_response_code(201);
    echo json_encode(['success' => true, 'uid' => $savedUser['id'] ?? $uid, 'message' => 'Account provisioned and securely saved to MySQL.']);
    exit;
}

if ($method === 'POST' && in_array($cleanPath, ['/admin/update-employee-account', '/admin/update-user'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);
    $uid = trim((string)($body['uid'] ?? ''));
    if (empty($uid)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Employee Auth UID is required.']);
        exit;
    }
    $updates = ['id' => $uid];
    if (!empty($body['password']) && strlen(trim((string)$body['password'])) >= 6) {
        $updates['password'] = trim((string)$body['password']);
    }
    if (isset($body['disabled']) && is_bool($body['disabled'])) {
        $updates['status'] = $body['disabled'] ? 'DISABLED' : 'ACTIVE';
    }
    if (!empty($body['displayName'] ?? $body['name'])) $updates['name'] = trim((string)($body['displayName'] ?? $body['name']));
    if (!empty($body['systemRole'] ?? $body['role'])) $updates['role'] = $body['systemRole'] ?? $body['role'];
    if (array_key_exists('isFieldWorker', $body) || array_key_exists('is_field_worker', $body)) {
        $updates['isFieldWorker'] = parseBoolFlagPhp($body['isFieldWorker'] ?? $body['is_field_worker'], false);
    }
    try {
        saveUserToDb($pdo, $updates, true, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'uid' => $uid, 'message' => 'Account updated successfully in MySQL.']);
    } catch (Exception $e) {
        http_response_code($e->getCode() === 404 ? 404 : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    }
    exit;
}

// POST /api/customers/import - Batch Customer Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/customers/import', '/customers/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $customers = $body['customers'] ?? ($body['rows'] ?? []);
    if (!is_array($customers) || empty($customers)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No customer records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, customer_code, name, company_name, phone, email, gst_number, city FROM `solar_customers`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $phoneMap = [];
    $emailMap = [];
    $gstMap = [];
    $existingCodes = [];

    foreach ($existing as $ec) {
        if (!empty($ec['customer_code'])) $existingCodes[strtoupper($ec['customer_code'])] = true;
        $p = preg_replace('/\D/', '', $ec['phone'] ?? '');
        if (strlen($p) >= 7) $phoneMap[$p] = $ec['name'];
        $em = strtolower(trim($ec['email'] ?? ''));
        if (!empty($em)) $emailMap[$em] = $ec['name'];
        $g = strtoupper(preg_replace('/[\s-]/', '', $ec['gst_number'] ?? ''));
        if (!empty($g)) $gstMap[$g] = $ec['name'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];

    $insertStmt = $pdo->prepare("
        INSERT INTO `solar_customers` (
            `id`, `customer_code`, `name`, `company_name`, `customer_type`,
            `phone`, `email`, `password`, `site_address`, `city`, `state`,
            `pincode`, `gst_number`, `electricity_consumer_no`, `sanctioned_load_kw`,
            `status`, `active_project_id`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ");

    $codeSeq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        foreach ($customers as $idx => $raw) {
            $rowNum = $idx + 1;
            $name = trim($raw['name'] ?? ($raw['customerName'] ?? ''));
            if (empty($name)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Customer name is mandatory.'];
                $errors[] = "Row $rowNum: Customer name is mandatory.";
                continue;
            }

            $phoneRaw = trim($raw['phone'] ?? '');
            $phoneDigits = preg_replace('/\D/', '', $phoneRaw);
            if (strlen($phoneDigits) < 7) {
                $failed[] = ['row' => $rowNum, 'reason' => "Valid phone number is required (got \"$phoneRaw\")."];
                $errors[] = "Row $rowNum: Valid phone number is required.";
                continue;
            }

            $email = strtolower(trim($raw['email'] ?? ''));
            $gst = strtoupper(preg_replace('/[\s-]/', '', $raw['gstNumber'] ?? ($raw['gst_number'] ?? '')));

            // Check duplicate
            $isDup = false;
            $dupReason = '';
            foreach ($phoneMap as $exPhone => $cName) {
                if ($exPhone === $phoneDigits || (strlen($phoneDigits) >= 10 && str_ends_with($exPhone, substr($phoneDigits, -10))) || (strlen($exPhone) >= 10 && str_ends_with($phoneDigits, substr($exPhone, -10)))) {
                    $isDup = true;
                    $dupReason = "Phone number \"$phoneRaw\" already registered to \"$cName\".";
                    break;
                }
            }
            if (!$isDup && !empty($email) && isset($emailMap[$email])) {
                $isDup = true;
                $dupReason = "Email \"$email\" already registered to \"{$emailMap[$email]}\".";
            }
            if (!$isDup && !empty($gst) && isset($gstMap[$gst])) {
                $isDup = true;
                $dupReason = "GST \"$gst\" already registered to \"{$gstMap[$gst]}\".";
            }

            if ($isDup) {
                $skipped[] = ['row' => $rowNum, 'name' => $name, 'reason' => $dupReason];
                $errors[] = "Row $rowNum Skipped (Duplicate): $dupReason";
                continue;
            }

            $cId = 'cust-' . round(microtime(true) * 1000) . '-' . ($idx + 1) . '-' . rand(100, 999);
            do {
                $codeSeq++;
                $cCode = 'CUST-' . date('Y') . '-' . str_pad($codeSeq, 4, '0', STR_PAD_LEFT);
            } while (isset($existingCodes[strtoupper($cCode)]));
            $existingCodes[strtoupper($cCode)] = true;

            $cType = $raw['customerType'] ?? ($raw['customer_type'] ?? 'Commercial');
            $compName = trim($raw['companyName'] ?? ($raw['company_name'] ?? ''));
            $addr = trim($raw['siteAddress'] ?? ($raw['site_address'] ?? ($raw['address'] ?? 'Site Address')));
            $city = trim($raw['city'] ?? 'Ahmedabad');
            $state = trim($raw['state'] ?? 'Gujarat');
            $pin = trim($raw['pincode'] ?? '380001');
            $load = floatval($raw['sanctionedLoadKw'] ?? ($raw['sanctioned_load_kw'] ?? 0));
            $stat = $raw['status'] ?? 'ACTIVE';
            $elec = trim($raw['electricityConsumerNo'] ?? ($raw['electricity_consumer_no'] ?? ''));
            $pass = trim($raw['password'] ?? '123456');
            $hash = password_hash($pass, PASSWORD_BCRYPT);

            $insertStmt->execute([
                $cId, $cCode, $name, $compName, $cType,
                $phoneRaw, $email, $hash, $addr, $city, $state,
                $pin, $gst, $elec, $load, $stat, null
            ]);

            $phoneMap[$phoneDigits] = $name;
            if (!empty($email)) $emailMap[$email] = $name;
            if (!empty($gst)) $gstMap[$gst] = $name;

            $imported[] = [
                'id' => $cId,
                'customerCode' => $cCode,
                'name' => $name,
                'companyName' => $compName,
                'customerType' => $cType,
                'phone' => $phoneRaw,
                'email' => $email,
                'siteAddress' => $addr,
                'city' => $city,
                'state' => $state,
                'pincode' => $pin,
                'gstNumber' => $gst,
                'sanctionedLoadKw' => $load,
                'status' => $stat,
                'createdAt' => date('c'),
                'updatedAt' => date('c')
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during customer import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($customers),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/projects/import - Batch Project Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/projects/import', '/projects/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $projects = $body['projects'] ?? ($body['rows'] ?? []);
    if (!is_array($projects) || empty($projects)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No project records provided for import.']);
        exit;
    }

    $stmtP = $pdo->query('SELECT id, project_code, customer_name, title, capacity_kw, site_address FROM `solar_projects`');
    $existingProjects = $stmtP->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $stmtC = $pdo->query('SELECT id, name, company_name FROM `solar_customers`');
    $existingCustomers = $stmtC->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $projectCodeMap = [];
    $custTitleMap = [];
    $custCapAddrMap = [];

    foreach ($existingProjects as $ep) {
        $c = strtoupper(trim($ep['project_code'] ?? ''));
        $cn = strtolower(trim($ep['customer_name'] ?? ''));
        $t = strtolower(trim($ep['title'] ?? ''));
        $cap = floatval($ep['capacity_kw'] ?? 0);
        $addr = strtolower(trim($ep['site_address'] ?? ''));

        if (!empty($c)) $projectCodeMap[$c] = $ep['title'] ?? $ep['project_code'];
        if (!empty($cn) && !empty($t)) $custTitleMap[$cn . ':::' . $t] = $c ?: $ep['id'];
        if (!empty($cn) && $cap > 0 && !empty($addr)) $custCapAddrMap[$cn . ':::' . $cap . ':::' . $addr] = $c ?: $ep['id'];
    }

    $customerMap = [];
    foreach ($existingCustomers as $ec) {
        $cn = strtolower(trim($ec['name'] ?? ''));
        $comp = strtolower(trim($ec['company_name'] ?? ''));
        if (!empty($cn)) $customerMap[$cn] = $ec;
        if (!empty($comp)) $customerMap[$comp] = $ec;
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];

    $codeSeq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        foreach ($projects as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Empty or malformed record.'];
                $errors[] = "Row $rowNum: Empty or malformed record.";
                continue;
            }

            $rawCode = trim($raw['projectCode'] ?? ($raw['project_code'] ?? ''));
            $custName = trim($raw['customerName'] ?? ($raw['customer_name'] ?? ($raw['name'] ?? ($raw['client'] ?? ''))));
            $rawTitle = trim($raw['title'] ?? '');
            $rawCap = preg_replace('/[^0-9.]/', '', $raw['capacityKw'] ?? ($raw['capacity_kw'] ?? ($raw['capacity'] ?? '')));
            $capKw = floatval($rawCap);
            $rawVal = preg_replace('/[^0-9.]/', '', $raw['totalValue'] ?? ($raw['total_value'] ?? ''));
            $val = floatval($rawVal);
            $rawStat = strtoupper(trim($raw['status'] ?? 'SURVEY'));
            $rawCity = trim($raw['city'] ?? 'Ahmedabad');
            $rawAddr = trim($raw['siteAddress'] ?? ($raw['site_address'] ?? ''));
            $siteAddr = !empty($rawAddr) ? $rawAddr : ($rawCity . ', Gujarat');
            $city = !empty($rawCity) ? $rawCity : 'Ahmedabad';

            if (empty($custName) && empty($rawTitle)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Customer name or project title is mandatory.'];
                $errors[] = "Row $rowNum: Customer name or project title is mandatory.";
                continue;
            }

            $effCustName = !empty($custName) ? $custName : $rawTitle;

            if ($capKw <= 0) {
                $failed[] = ['row' => $rowNum, 'reason' => "Valid solar capacity in kW (> 0) is required (got \"$rawCap\")."];
                $errors[] = "Row $rowNum: Valid solar capacity in kW (> 0) is required (got \"$rawCap\").";
                continue;
            }

            if ($val <= 0) {
                $val = round($capKw * 48000);
            }

            $title = !empty($rawTitle) ? $rawTitle : "$capKw kW Rooftop Solar - $effCustName";
            $projCode = !empty($rawCode) ? $rawCode : ('SOL-' . date('Y') . '-' . str_pad(++$codeSeq, 4, '0', STR_PAD_LEFT));

            $normC = strtoupper($projCode);
            $normCust = strtolower($effCustName);
            $normT = strtolower($title);
            $normAddr = strtolower($siteAddr);

            if (!empty($rawCode) && isset($projectCodeMap[$normC])) {
                $skipped[] = [
                    'row' => $rowNum,
                    'name' => "$projCode ($effCustName)",
                    'reason' => "Project code \"$projCode\" already exists."
                ];
                $errors[] = "Row $rowNum Skipped (Duplicate): Project code \"$projCode\" already exists.";
                continue;
            }

            $custTitleKey = $normCust . ':::' . $normT;
            if (isset($custTitleMap[$custTitleKey])) {
                $skipped[] = [
                    'row' => $rowNum,
                    'name' => "$projCode ($effCustName)",
                    'reason' => "Project \"$title\" for customer \"$effCustName\" already exists."
                ];
                $errors[] = "Row $rowNum Skipped (Duplicate): Project \"$title\" for \"$effCustName\" already exists.";
                continue;
            }

            $custCapAddrKey = $normCust . ':::' . $capKw . ':::' . $normAddr;
            if (!empty($normAddr) && isset($custCapAddrMap[$custCapAddrKey])) {
                $skipped[] = [
                    'row' => $rowNum,
                    'name' => "$projCode ($effCustName)",
                    'reason' => "A $capKw kW project for \"$effCustName\" at \"$siteAddr\" already exists."
                ];
                $errors[] = "Row $rowNum Skipped (Duplicate): Duplicate project at site address.";
                continue;
            }

            // Customer linking
            $customerId = '';
            if (isset($customerMap[$normCust])) {
                $customerId = $customerMap[$normCust]['id'];
            } else {
                $customerId = 'cust-imp-' . round(microtime(true) * 1000) . '-' . $rowNum;
                $newCustCode = 'CUST-' . date('Y') . '-' . str_pad($codeSeq + 500, 4, '0', STR_PAD_LEFT);
                $stmtNewC = $pdo->prepare("
                    INSERT INTO `solar_customers` (
                        `id`, `customer_code`, `name`, `company_name`, `customer_type`,
                        `phone`, `email`, `password`, `site_address`, `city`, `state`,
                        `pincode`, `sanctioned_load_kw`, `status`
                    ) VALUES (?, ?, ?, ?, 'Commercial', ?, ?, ?, ?, ?, 'Gujarat', '380001', ?, 'ACTIVE')
                    ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)
                ");
                $defaultPass = password_hash('123456', PASSWORD_BCRYPT);
                $cleanPhone = $raw['phone'] ?? '+91 98000 00000';
                $cleanEmail = $raw['email'] ?? (preg_replace('/[^a-z0-9]/', '', $normCust) . '@example.com');
                $stmtNewC->execute([
                    $customerId, $newCustCode, $effCustName, $effCustName,
                    $cleanPhone, $cleanEmail, $defaultPass, $siteAddr, $city, $capKw
                ]);
                $customerMap[$normCust] = ['id' => $customerId, 'name' => $effCustName];
            }

            $projId = $raw['id'] ?? ('proj-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $validStatuses = ['PLANNING', 'SURVEY', 'DESIGN', 'APPROVALS', 'PROCUREMENT', 'CIVIL_WORK', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER', 'COMPLETED', 'ON_HOLD', 'CANCELLED'];
            $status = in_array($rawStat, $validStatuses) ? $rawStat : 'SURVEY';
            $startDate = !empty($raw['startDate']) ? substr($raw['startDate'], 0, 10) : date('Y-m-d');
            $expDate = !empty($raw['expectedCompletionDate']) ? substr($raw['expectedCompletionDate'], 0, 10) : date('Y-m-d', strtotime('+45 days'));

            $saveProj = [
                'id' => $projId,
                'projectCode' => $projCode,
                'customerId' => $customerId,
                'customerName' => $effCustName,
                'title' => $title,
                'capacityKw' => $capKw,
                'totalValue' => $val,
                'status' => $status,
                'currentStageKey' => $status === 'COMPLETED' ? 'handover_documentation' : 'site_survey',
                'completionPercentage' => $status === 'COMPLETED' ? 100 : ($status === 'INSTALLATION' ? 68 : 0),
                'projectManagerId' => $raw['projectManagerId'] ?? '',
                'projectManagerName' => $raw['projectManagerName'] ?? '',
                'siteAddress' => $siteAddr,
                'city' => $city,
                'startDate' => $startDate,
                'expectedCompletionDate' => $expDate,
                'notes' => $raw['notes'] ?? 'Imported via CSV Hub',
                'stages' => $raw['stages'] ?? []
            ];

            saveProjectToDb($pdo, $saveProj);

            $projectCodeMap[$normC] = $title;
            $custTitleMap[$custTitleKey] = $projCode;
            if (!empty($normAddr)) $custCapAddrMap[$custCapAddrKey] = $projCode;

            $imported[] = $saveProj;
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during project import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($projects),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/leads/import - Batch Leads Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/leads/import', '/leads/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $leads = $body['leads'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : []));
    if (!is_array($leads) || empty($leads)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No lead records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, phone, email, customer_name FROM `solar_leads`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $phoneMap = [];
    $emailMap = [];
    foreach ($existing as $ex) {
        $cleanP = preg_replace('/\D/', '', $ex['phone'] ?? '');
        if (!empty($cleanP)) $phoneMap[$cleanP] = $ex['customer_name'] ?? 'Existing Lead';
        $em = strtolower(trim($ex['email'] ?? ''));
        if (!empty($em)) $emailMap[$em] = $ex['customer_name'] ?? 'Existing Lead';
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];

    $pdo->beginTransaction();
    try {
        $insertStmt = $pdo->prepare("
            INSERT INTO `solar_leads` (
                `id`, `customer_name`, `company_name`, `phone`, `email`,
                `address`, `city`, `solar_capacity_kw`, `estimated_value`,
                `source`, `status`, `notes`, `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");

        foreach ($leads as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $name = trim($raw['customerName'] ?? ($raw['name'] ?? ($raw['customer_name'] ?? '')));
            if (empty($name)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Customer name is required.'];
                $errors[] = "Row $rowNum: Customer name is required.";
                continue;
            }

            $phoneRaw = trim($raw['phone'] ?? ($raw['mobile'] ?? ''));
            $phoneDigits = preg_replace('/\D/', '', $phoneRaw);
            if (strlen($phoneDigits) < 7) {
                $failed[] = ['row' => $rowNum, 'name' => $name, 'reason' => "Valid phone number is required (got \"$phoneRaw\")."];
                $errors[] = "Row $rowNum: Valid phone number is required.";
                continue;
            }

            $email = strtolower(trim($raw['email'] ?? ''));

            $isDup = false;
            $dupReason = '';
            foreach ($phoneMap as $exPhone => $leadOwner) {
                if ($exPhone === $phoneDigits || (strlen($phoneDigits) >= 10 && str_ends_with($exPhone, substr($phoneDigits, -10))) || (strlen($exPhone) >= 10 && str_ends_with($phoneDigits, substr($exPhone, -10)))) {
                    $isDup = true;
                    $dupReason = "Phone \"$phoneRaw\" already registered for lead \"$leadOwner\".";
                    break;
                }
            }
            if (!$isDup && !empty($email) && isset($emailMap[$email])) {
                $isDup = true;
                $dupReason = "Email \"$email\" already registered for lead \"{$emailMap[$email]}\".";
            }

            if ($isDup) {
                $skipped[] = ['row' => $rowNum, 'name' => $name, 'reason' => $dupReason];
                $errors[] = "Row $rowNum Skipped (Duplicate): $dupReason";
                continue;
            }

            $leadId = $raw['id'] ?? ('lead-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $company = trim($raw['companyName'] ?? ($raw['company_name'] ?? ''));
            $address = trim($raw['address'] ?? '');
            $city = trim($raw['city'] ?? 'Ahmedabad');
            $capKw = floatval(preg_replace('/[^0-9.]/', '', $raw['capacityKw'] ?? ($raw['solar_capacity_kw'] ?? ($raw['capacity'] ?? 0))));
            $estVal = floatval(preg_replace('/[^0-9.]/', '', $raw['estimatedValue'] ?? ($raw['estimated_value'] ?? ($raw['value'] ?? ($capKw > 0 ? $capKw * 48000 : 0)))));
            $source = trim($raw['source'] ?? 'Website');
            $status = strtoupper(trim($raw['status'] ?? 'NEW'));
            $notes = trim($raw['notes'] ?? 'Imported via CSV Hub');

            $insertStmt->execute([
                $leadId, $name, $company, $phoneRaw, $email,
                $address, $city, $capKw, $estVal, $source, $status, $notes
            ]);

            $phoneMap[$phoneDigits] = $name;
            if (!empty($email)) $emailMap[$email] = $name;

            $imported[] = [
                'id' => $leadId,
                'customerName' => $name,
                'companyName' => $company,
                'phone' => $phoneRaw,
                'email' => $email,
                'address' => $address,
                'city' => $city,
                'solarCapacityKw' => $capKw,
                'estimatedValue' => $estVal,
                'source' => $source,
                'status' => $status,
                'notes' => $notes,
                'createdAt' => date('c')
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during leads import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($leads),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/employees/import - Batch Employee Import to MySQL (Protected)
if ($method === 'POST' && in_array($cleanPath, ['/employees/import', '/employees/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);

    $employees = $body['employees'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : []));
    if (!is_array($employees) || empty($employees)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No employee records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, employee_code, email, phone, name FROM `solar_employees`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $codeMap = [];
    $emailMap = [];
    $phoneMap = [];
    foreach ($existing as $ex) {
        $ec = strtoupper(trim($ex['employee_code'] ?? ''));
        if (!empty($ec)) $codeMap[$ec] = $ex['name'];
        $em = strtolower(trim($ex['email'] ?? ''));
        if (!empty($em)) $emailMap[$em] = $ex['name'];
        $ph = preg_replace('/\D/', '', $ex['phone'] ?? '');
        if (!empty($ph)) $phoneMap[$ph] = $ex['name'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];
    $seq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        $empStmt = $pdo->prepare("
            INSERT INTO `solar_employees` (
                `id`, `employee_code`, `name`, `department`, `designation`,
                `phone`, `email`, `joining_date`, `salary_monthly`, `status`,
                `login_enabled`, `system_role`, `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");
        $userStmt = $pdo->prepare("
            INSERT INTO `solar_users` (
                `id`, `name`, `email`, `password`, `role`, `phone`, `department`,
                `designation`, `employee_id`, `status`, `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(), NOW())
            ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `role` = VALUES(`role`), `department` = VALUES(`department`)
        ");

        foreach ($employees as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $name = trim($raw['name'] ?? '');
            if (empty($name)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Employee name is required.'];
                $errors[] = "Row $rowNum: Employee name is required.";
                continue;
            }

            $rawCode = strtoupper(trim($raw['employeeCode'] ?? ($raw['employee_code'] ?? ($raw['code'] ?? ''))));
            $email = strtolower(trim($raw['email'] ?? ''));
            $phoneRaw = trim($raw['phone'] ?? ($raw['mobile'] ?? ''));
            $phoneDigits = preg_replace('/\D/', '', $phoneRaw);

            $isDup = false;
            $dupReason = '';
            if (!empty($rawCode) && isset($codeMap[$rawCode])) {
                $isDup = true;
                $dupReason = "Employee code \"$rawCode\" already exists.";
            } elseif (!empty($email) && isset($emailMap[$email])) {
                $isDup = true;
                $dupReason = "Email \"$email\" already assigned to employee \"{$emailMap[$email]}\".";
            }

            if ($isDup) {
                $skipped[] = ['row' => $rowNum, 'name' => $name, 'reason' => $dupReason];
                $errors[] = "Row $rowNum Skipped (Duplicate): $dupReason";
                continue;
            }

            $empId = $raw['id'] ?? ('emp-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $empCode = !empty($rawCode) ? $rawCode : ('EMP' . str_pad(++$seq, 4, '0', STR_PAD_LEFT));
            $dept = trim($raw['department'] ?? 'Operations');
            $desig = trim($raw['designation'] ?? 'Field Executive');
            $joinDate = !empty($raw['joiningDate']) ? substr($raw['joiningDate'], 0, 10) : date('Y-m-d');
            $salary = floatval(preg_replace('/[^0-9.]/', '', $raw['salaryMonthly'] ?? ($raw['salary'] ?? 25000)));
            $status = strtoupper(trim($raw['status'] ?? 'ACTIVE'));
            $loginEnabled = !empty($raw['loginEnabled']) ? 1 : 0;
            $role = trim($raw['systemRole'] ?? ($raw['role'] ?? 'Site Survey Engineer'));

            $empStmt->execute([
                $empId, $empCode, $name, $dept, $desig,
                $phoneRaw, $email, $joinDate, $salary, $status,
                $loginEnabled, $role
            ]);

            if ($loginEnabled && !empty($email) && !in_array($status, ['INACTIVE', 'DISABLED', 'TERMINATED'], true)) {
                $userId = 'usr-' . $empId;
                $rawImpPass = trim($raw['password'] ?? '') ?: ('Emp@' . substr(bin2hex(random_bytes(3)), 0, 6));
                $pwdHash = password_hash($rawImpPass, PASSWORD_BCRYPT);
                $userStmt->execute([$userId, $name, $email, $pwdHash, $role, $phoneRaw, $dept, $desig, $empCode]);
                $acctType = in_array($role, ['Admin', 'Super Admin'], true) ? 'ADMIN' : 'EMPLOYEE';
                syncAuthCredentialPhp($pdo, $userId, $email, $pwdHash, $role, $acctType, $empId, 'ACTIVE');
                logSolarUsersAuditPhp('INSERT', 'POST /employees/import', $userId, $email, $actor);
            }

            $codeMap[$empCode] = $name;
            if (!empty($email)) $emailMap[$email] = $name;
            if (!empty($phoneDigits)) $phoneMap[$phoneDigits] = $name;

            $imported[] = [
                'id' => $empId,
                'employeeCode' => $empCode,
                'name' => $name,
                'department' => $dept,
                'designation' => $desig,
                'phone' => $phoneRaw,
                'email' => $email,
                'joiningDate' => $joinDate,
                'salaryMonthly' => $salary,
                'status' => $status,
                'loginEnabled' => $loginEnabled === 1,
                'systemRole' => $role
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during employee import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($employees),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/products/import - Batch Products Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/products/import', '/products/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $products = $body['products'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : []));
    if (!is_array($products) || empty($products)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No product records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, sku, name FROM `solar_products`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $skuMap = [];
    $nameMap = [];
    foreach ($existing as $ex) {
        $s = strtoupper(trim($ex['sku'] ?? ''));
        if (!empty($s)) $skuMap[$s] = $ex['name'];
        $n = strtolower(trim($ex['name'] ?? ''));
        if (!empty($n)) $nameMap[$n] = $ex['sku'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];
    $seq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        $prodStmt = $pdo->prepare("
            INSERT INTO `solar_products` (
                `id`, `sku`, `name`, `category`, `brand`, `model`,
                `specifications`, `unit`, `hsn_code`, `gst_rate`,
                `unit_price`, `selling_price`, `current_stock`, `reorder_level`,
                `location`, `warehouse_id`, `warehouse_name`, `warehouse_stocks_json`,
                `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");

        foreach ($products as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $name = trim($raw['name'] ?? '');
            if (empty($name)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Product name is mandatory.'];
                $errors[] = "Row $rowNum: Product name is mandatory.";
                continue;
            }

            $rawSku = strtoupper(trim($raw['sku'] ?? ($raw['itemCode'] ?? '')));
            $normN = strtolower($name);

            $isDup = false;
            $dupReason = '';
            if (!empty($rawSku) && isset($skuMap[$rawSku])) {
                $isDup = true;
                $dupReason = "Product SKU \"$rawSku\" already exists.";
            } elseif (isset($nameMap[$normN])) {
                $isDup = true;
                $dupReason = "Product named \"$name\" already exists (SKU: {$nameMap[$normN]}).";
            }

            if ($isDup) {
                $skipped[] = ['row' => $rowNum, 'name' => $name, 'reason' => $dupReason];
                $errors[] = "Row $rowNum Skipped (Duplicate): $dupReason";
                continue;
            }

            $prodId = $raw['id'] ?? ('prod-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $sku = !empty($rawSku) ? $rawSku : ('PROD-' . str_pad(++$seq, 4, '0', STR_PAD_LEFT));
            $cat = trim($raw['category'] ?? 'Solar Panels');
            $brand = trim($raw['brand'] ?? '');
            $model = trim($raw['model'] ?? '');
            $specs = trim($raw['specifications'] ?? ($raw['specification'] ?? ''));
            $unit = trim($raw['unit'] ?? 'Nos');
            $hsn = trim($raw['hsnCode'] ?? ($raw['hsn_code'] ?? '85414011'));
            $rawGst = $raw['gstRate'] ?? ($raw['gst_rate'] ?? null);
            $rawGstClean = $rawGst !== null ? preg_replace('/[^0-9.-]/', '', (string)$rawGst) : '';
            if ($rawGstClean !== '' && (!is_numeric($rawGstClean) || floatval($rawGstClean) < 0 || floatval($rawGstClean) > 100)) {
                $failed[] = ['row' => $rowNum, 'reason' => "Invalid GST rate '$rawGst'. Must be between 0 and 100."];
                $errors[] = "Row $rowNum: Invalid GST rate '$rawGst'. Must be between 0 and 100.";
                continue;
            }
            $gstRate = $rawGstClean !== '' ? round(floatval($rawGstClean), 2) : 18.0;
            $price = floatval(preg_replace('/[^0-9.]/', '', (string)($raw['unitPrice'] ?? ($raw['unit_price'] ?? ($raw['price'] ?? 0)))));
            $rawSelling = $raw['sellingPrice'] ?? ($raw['selling_price'] ?? null);
            $sellingPrice = ($rawSelling !== null && $rawSelling !== '') ? floatval(preg_replace('/[^0-9.]/', '', (string)$rawSelling)) : round($price * 1.15);
            $stock = floatval(preg_replace('/[^0-9.]/', '', (string)($raw['currentStock'] ?? ($raw['current_stock'] ?? ($raw['stock'] ?? 0)))));
            $rawReorder = $raw['minStockThreshold'] ?? ($raw['reorderLevel'] ?? ($raw['minStockLevel'] ?? ($raw['reorder_level'] ?? null)));
            $reorder = ($rawReorder !== null && $rawReorder !== '') ? floatval(preg_replace('/[^0-9.]/', '', (string)$rawReorder)) : 10.0;
            $whId = trim($raw['warehouseId'] ?? ($raw['warehouse_id'] ?? ''));
            $whName = trim($raw['warehouseName'] ?? ($raw['warehouse_name'] ?? ''));
            $location = trim($raw['location'] ?? $whName);
            $whStocks = (isset($raw['warehouseStocks']) && is_array($raw['warehouseStocks'])) ? $raw['warehouseStocks'] : (!empty($whId) ? [$whId => $stock] : []);
            $whStocksJson = json_encode(empty($whStocks) ? new stdClass() : $whStocks);

            $prodStmt->execute([
                $prodId, $sku, $name, $cat, $brand, $model,
                $specs, $unit, $hsn, $gstRate, $price, $sellingPrice, $stock, $reorder,
                $location, $whId, $whName, $whStocksJson
            ]);

            $skuMap[$sku] = $name;
            $nameMap[$normN] = $sku;

            $imported[] = [
                'id' => $prodId,
                'sku' => $sku,
                'itemCode' => $sku,
                'name' => $name,
                'category' => $cat,
                'brand' => $brand,
                'model' => $model,
                'specifications' => $specs,
                'specification' => $specs,
                'unit' => $unit,
                'hsnCode' => $hsn,
                'gstRate' => $gstRate,
                'taxRate' => $gstRate,
                'unitPrice' => $price,
                'sellingPrice' => $sellingPrice,
                'currentStock' => $stock,
                'reorderLevel' => $reorder,
                'minStockLevel' => $reorder,
                'minStockThreshold' => $reorder,
                'location' => $location,
                'warehouseId' => $whId,
                'warehouseName' => $whName,
                'warehouseStocks' => $whStocks,
                'status' => 'ACTIVE'
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during products import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($products),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/vendors/import - Batch Vendors Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/vendors/import', '/vendors/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $vendors = $body['vendors'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : []));
    if (!is_array($vendors) || empty($vendors)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No vendor records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, vendor_code, name, phone, gst_number FROM `solar_vendors`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $codeMap = [];
    $nameMap = [];
    $phoneMap = [];
    $gstMap = [];
    foreach ($existing as $ex) {
        $vc = strtoupper(trim($ex['vendor_code'] ?? ''));
        if (!empty($vc)) $codeMap[$vc] = $ex['name'];
        $n = strtolower(trim($ex['name'] ?? ''));
        if (!empty($n)) $nameMap[$n] = $ex['vendor_code'];
        $ph = preg_replace('/\D/', '', $ex['phone'] ?? '');
        if (!empty($ph)) $phoneMap[$ph] = $ex['name'];
        $gst = strtoupper(trim($ex['gst_number'] ?? ''));
        if (!empty($gst)) $gstMap[$gst] = $ex['name'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];
    $seq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        $venStmt = $pdo->prepare("
            INSERT INTO `solar_vendors` (
                `id`, `name`, `vendor_code`, `contact_person`, `phone`, `email`,
                `address`, `city`, `state`, `gst_number`, `pan_number`,
                `payment_terms`, `rating`, `categories_json`, `bank_details_json`, `status`, `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");

        foreach ($vendors as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $name = trim($raw['name'] ?? '');
            if (empty($name)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Vendor name is mandatory.'];
                $errors[] = "Row $rowNum: Vendor name is mandatory.";
                continue;
            }

            $rawCode = strtoupper(trim($raw['vendorCode'] ?? ($raw['vendor_code'] ?? ($raw['code'] ?? ''))));
            $phoneRaw = trim($raw['phone'] ?? '');
            $phoneDigits = preg_replace('/\D/', '', $phoneRaw);
            $gst = strtoupper(preg_replace('/[\s-]/', '', $raw['gstNumber'] ?? ($raw['gst_number'] ?? '')));
            $normN = strtolower($name);

            $isDup = false;
            $dupReason = '';
            if (!empty($rawCode) && isset($codeMap[$rawCode])) {
                $isDup = true;
                $dupReason = "Vendor code \"$rawCode\" already exists.";
            } elseif (!empty($gst) && isset($gstMap[$gst])) {
                $isDup = true;
                $dupReason = "GST number \"$gst\" already registered for vendor \"{$gstMap[$gst]}\".";
            } elseif (isset($nameMap[$normN])) {
                $isDup = true;
                $dupReason = "Vendor named \"$name\" already exists.";
            }

            if ($isDup) {
                $skipped[] = ['row' => $rowNum, 'name' => $name, 'reason' => $dupReason];
                $errors[] = "Row $rowNum Skipped (Duplicate): $dupReason";
                continue;
            }

            $venId = $raw['id'] ?? ('ven-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $venCode = !empty($rawCode) ? $rawCode : ('VEN-' . str_pad(++$seq, 4, '0', STR_PAD_LEFT));
            $contact = trim($raw['contactPerson'] ?? ($raw['contact_person'] ?? $name));
            $email = strtolower(trim($raw['email'] ?? ''));
            $address = trim($raw['address'] ?? '');
            $city = trim($raw['city'] ?? 'Ahmedabad');
            $state = trim($raw['state'] ?? 'Gujarat');
            $pan = strtoupper(trim($raw['panNumber'] ?? ($raw['pan_number'] ?? '')));
            $terms = trim($raw['paymentTerms'] ?? ($raw['payment_terms'] ?? '30 Days Net'));
            $rating = floatval(preg_replace('/[^0-9.]/', '', (string)($raw['rating'] ?? 4.5)));
            $status = strtoupper(trim($raw['status'] ?? 'ACTIVE'));
            $cats = $raw['categories'] ?? (!empty($raw['category']) ? [$raw['category']] : ['Solar Modules']);
            if (is_string($cats)) {
                $decoded = json_decode($cats, true);
                $catsArr = is_array($decoded) ? $decoded : [trim($cats)];
            } else {
                $catsArr = array_values(array_filter(array_map(function($c) { return trim((string)$c); }, (array)$cats)));
            }
            if (empty($catsArr)) $catsArr = ['Solar Modules'];
            $catPrimary = $raw['category'] ?? ($catsArr[0] ?? 'Solar Modules');
            $catsJson = json_encode($catsArr);
            $bankDetails = isset($raw['bankDetails']) && is_array($raw['bankDetails']) ? $raw['bankDetails'] : null;
            $bankJson = $bankDetails ? json_encode($bankDetails) : null;

            $venStmt->execute([
                $venId, $name, $venCode, $contact, $phoneRaw, $email,
                $address, $city, $state, $gst, $pan, $terms, $rating, $catsJson, $bankJson, $status
            ]);

            $codeMap[$venCode] = $name;
            $nameMap[$normN] = $venCode;
            if (!empty($phoneDigits)) $phoneMap[$phoneDigits] = $name;
            if (!empty($gst)) $gstMap[$gst] = $name;

            $imported[] = [
                'id' => $venId,
                'name' => $name,
                'vendorCode' => $venCode,
                'contactPerson' => $contact,
                'phone' => $phoneRaw,
                'email' => $email,
                'address' => $address,
                'city' => $city,
                'state' => $state,
                'gstNumber' => $gst,
                'panNumber' => $pan,
                'paymentTerms' => $terms,
                'rating' => $rating,
                'category' => $catPrimary,
                'categories' => $catsArr,
                'bankDetails' => $bankDetails,
                'status' => $status
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during vendors import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($vendors),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/payments/import - Batch Payments Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/payments/import', '/payments/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $payments = $body['payments'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : []));
    if (!is_array($payments) || empty($payments)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No payment records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, receipt_number, transaction_reference FROM `solar_payments`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $recMap = [];
    $txMap = [];
    foreach ($existing as $ex) {
        $rn = strtoupper(trim($ex['receipt_number'] ?? ''));
        if (!empty($rn)) $recMap[$rn] = $ex['id'];
        $tr = strtoupper(trim($ex['transaction_reference'] ?? ''));
        if (!empty($tr)) $txMap[$tr] = $ex['id'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];
    $seq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        $payStmt = $pdo->prepare("
            INSERT INTO `solar_payments` (
                `id`, `receipt_number`, `project_id`, `customer_id`, `customer_name`,
                `milestone`, `amount`, `status`, `due_date`, `paid_date`,
                `payment_mode`, `transaction_reference`, `notes`, `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");

        foreach ($payments as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $amount = floatval(preg_replace('/[^0-9.]/', '', $raw['amount'] ?? 0));
            if ($amount <= 0) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Valid positive payment amount is required.'];
                $errors[] = "Row $rowNum: Valid positive payment amount is required.";
                continue;
            }

            $rawRec = strtoupper(trim($raw['receiptNumber'] ?? ($raw['receipt_number'] ?? '')));
            $rawTx = strtoupper(trim($raw['transactionReference'] ?? ($raw['transaction_reference'] ?? ($raw['ref'] ?? ''))));

            $isDup = false;
            $dupReason = '';
            if (!empty($rawRec) && isset($recMap[$rawRec])) {
                $isDup = true;
                $dupReason = "Receipt number \"$rawRec\" already exists.";
            } elseif (!empty($rawTx) && isset($txMap[$rawTx])) {
                $isDup = true;
                $dupReason = "Transaction reference \"$rawTx\" already exists.";
            }

            if ($isDup) {
                $skipped[] = ['row' => $rowNum, 'name' => $rawRec ?: "Payment #$rowNum", 'reason' => $dupReason];
                $errors[] = "Row $rowNum Skipped (Duplicate): $dupReason";
                continue;
            }

            $payId = $raw['id'] ?? ('pay-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $recNumber = !empty($rawRec) ? $rawRec : ('REC-' . date('Y') . '-' . str_pad(++$seq, 4, '0', STR_PAD_LEFT));
            $projId = trim($raw['projectId'] ?? ($raw['project_id'] ?? ''));
            $custId = trim($raw['customerId'] ?? ($raw['customer_id'] ?? ''));
            $custName = trim($raw['customerName'] ?? ($raw['customer_name'] ?? 'Client'));
            $milestone = trim($raw['milestone'] ?? 'Advance / Milestone Payment');
            $status = strtoupper(trim($raw['status'] ?? 'PAID'));
            $dueDate = !empty($raw['dueDate']) ? substr($raw['dueDate'], 0, 10) : date('Y-m-d');
            $paidDate = !empty($raw['paidDate']) ? substr($raw['paidDate'], 0, 10) : ($status === 'PAID' ? date('Y-m-d') : null);
            $mode = strtoupper(trim($raw['paymentMode'] ?? ($raw['payment_mode'] ?? 'NEFT/RTGS')));
            $txRef = !empty($rawTx) ? $rawTx : ('TXN-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $notes = trim($raw['notes'] ?? 'Imported via CSV Hub');

            $payStmt->execute([
                $payId, $recNumber, $projId, $custId, $custName,
                $milestone, $amount, $status, $dueDate, $paidDate,
                $mode, $txRef, $notes
            ]);

            $recMap[$recNumber] = $payId;
            $txMap[$txRef] = $payId;

            $imported[] = [
                'id' => $payId,
                'receiptNumber' => $recNumber,
                'projectId' => $projId,
                'customerId' => $custId,
                'customerName' => $custName,
                'milestone' => $milestone,
                'amount' => $amount,
                'status' => $status,
                'dueDate' => $dueDate,
                'paidDate' => $paidDate,
                'paymentMode' => $mode,
                'transactionReference' => $txRef,
                'notes' => $notes
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during payments import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($payments),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/expenses/import - Batch Expenses Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/expenses/import', '/expenses/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $expenses = $body['expenses'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : []));
    if (!is_array($expenses) || empty($expenses)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No expense records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, expense_number, reference_no FROM `solar_expenses`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $expMap = [];
    $refMap = [];
    foreach ($existing as $ex) {
        $en = strtoupper(trim($ex['expense_number'] ?? ''));
        if (!empty($en)) $expMap[$en] = $ex['id'];
        $ref = strtoupper(trim($ex['reference_no'] ?? ''));
        if (!empty($ref)) $refMap[$ref] = $ex['id'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];
    $seq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        $expStmt = $pdo->prepare("
            INSERT INTO `solar_expenses` (
                `id`, `expense_number`, `project_id`, `project_code`, `vendor_name`,
                `category`, `amount`, `expense_date`, `payment_mode`,
                `reference_no`, `notes`, `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");

        foreach ($expenses as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $amount = floatval(preg_replace('/[^0-9.]/', '', $raw['amount'] ?? 0));
            if ($amount <= 0) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Valid positive expense amount is required.'];
                $errors[] = "Row $rowNum: Valid positive expense amount is required.";
                continue;
            }

            $rawExp = strtoupper(trim($raw['expenseNumber'] ?? ($raw['expense_number'] ?? '')));
            $rawRef = strtoupper(trim($raw['referenceNo'] ?? ($raw['reference_no'] ?? ($raw['billNo'] ?? ''))));

            $isDup = false;
            $dupReason = '';
            if (!empty($rawExp) && isset($expMap[$rawExp])) {
                $isDup = true;
                $dupReason = "Expense number \"$rawExp\" already exists.";
            } elseif (!empty($rawRef) && isset($refMap[$rawRef])) {
                $isDup = true;
                $dupReason = "Reference bill/voucher \"$rawRef\" already exists.";
            }

            if ($isDup) {
                $skipped[] = ['row' => $rowNum, 'name' => $rawExp ?: "Expense #$rowNum", 'reason' => $dupReason];
                $errors[] = "Row $rowNum Skipped (Duplicate): $dupReason";
                continue;
            }

            $expId = $raw['id'] ?? ('exp-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $expNumber = !empty($rawExp) ? $rawExp : ('EXP-' . date('Y') . '-' . str_pad(++$seq, 4, '0', STR_PAD_LEFT));
            $projId = trim($raw['projectId'] ?? ($raw['project_id'] ?? ''));
            $projCode = trim($raw['projectCode'] ?? ($raw['project_code'] ?? ''));
            $vendorName = trim($raw['vendorName'] ?? ($raw['vendor_name'] ?? 'Vendor'));
            $category = trim($raw['category'] ?? 'Site Expenses');
            $expDate = !empty($raw['expenseDate']) ? substr($raw['expenseDate'], 0, 10) : date('Y-m-d');
            $mode = strtoupper(trim($raw['paymentMode'] ?? ($raw['payment_mode'] ?? 'CASH')));
            $refNo = !empty($rawRef) ? $rawRef : ('VCH-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $notes = trim($raw['notes'] ?? 'Imported via CSV Hub');

            $expStmt->execute([
                $expId, $expNumber, $projId, $projCode, $vendorName,
                $category, $amount, $expDate, $mode, $refNo, $notes
            ]);

            $expMap[$expNumber] = $expId;
            $refMap[$refNo] = $expId;

            $imported[] = [
                'id' => $expId,
                'expenseNumber' => $expNumber,
                'projectId' => $projId,
                'projectCode' => $projCode,
                'vendorName' => $vendorName,
                'category' => $category,
                'amount' => $amount,
                'expenseDate' => $expDate,
                'paymentMode' => $mode,
                'referenceNo' => $refNo,
                'notes' => $notes
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during expenses import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($expenses),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/attendance/import - Batch Attendance Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/attendance/import', '/attendance/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $attendance = $body['attendance'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : []));
    if (!is_array($attendance) || empty($attendance)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No attendance records provided for import.']);
        exit;
    }

    $stmtA = $pdo->query('SELECT id, employee_id, employee_name, attendance_date FROM `solar_attendance`');
    $existing = $stmtA->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $attKeyMap = [];
    foreach ($existing as $ex) {
        $emp = strtolower(trim($ex['employee_name'] ?? $ex['employee_id']));
        $d = substr($ex['attendance_date'] ?? '', 0, 10);
        if (!empty($emp) && !empty($d)) {
            $attKeyMap[$emp . ':::' . $d] = $ex['id'];
        }
    }

    $stmtE = $pdo->query('SELECT id, name, employee_code FROM `solar_employees`');
    $existingEmp = $stmtE->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $empNameMap = [];
    foreach ($existingEmp as $ee) {
        $empNameMap[strtolower(trim($ee['name']))] = $ee['id'];
        $empNameMap[strtolower(trim($ee['employee_code']))] = $ee['id'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];

    $pdo->beginTransaction();
    try {
        $attStmt = $pdo->prepare("
            INSERT INTO `solar_attendance` (
                `id`, `employee_id`, `employee_name`, `attendance_date`,
                `check_in_time`, `check_out_time`, `status`, `site_project_title`,
                `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");

        foreach ($attendance as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $empName = trim($raw['employeeName'] ?? ($raw['employee_name'] ?? ($raw['name'] ?? '')));
            $empIdRaw = trim($raw['employeeId'] ?? ($raw['employee_id'] ?? ''));
            if (empty($empName) && empty($empIdRaw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Employee name or ID is mandatory.'];
                $errors[] = "Row $rowNum: Employee name or ID is mandatory.";
                continue;
            }

            $dateRaw = trim($raw['date'] ?? ($raw['attendanceDate'] ?? ($raw['attendance_date'] ?? '')));
            $attDate = !empty($dateRaw) ? substr($dateRaw, 0, 10) : date('Y-m-d');

            $effEmpName = !empty($empName) ? $empName : $empIdRaw;
            $effEmpId = !empty($empIdRaw) ? $empIdRaw : ($empNameMap[strtolower($effEmpName)] ?? ('emp-' . md5(strtolower($effEmpName))));

            $lookupKey = strtolower($effEmpName) . ':::' . $attDate;
            if (isset($attKeyMap[$lookupKey])) {
                $skipped[] = [
                    'row' => $rowNum,
                    'name' => "$effEmpName ($attDate)",
                    'reason' => "Attendance for \"$effEmpName\" on date $attDate already logged."
                ];
                $errors[] = "Row $rowNum Skipped (Duplicate): Attendance on $attDate already recorded.";
                continue;
            }

            $attId = $raw['id'] ?? ('att-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $checkIn = trim($raw['checkInTime'] ?? ($raw['check_in_time'] ?? ($raw['checkIn'] ?? '09:00:00')));
            $checkOut = trim($raw['checkOutTime'] ?? ($raw['check_out_time'] ?? ($raw['checkOut'] ?? '18:00:00')));
            $status = strtoupper(trim($raw['status'] ?? 'PRESENT'));
            $site = trim($raw['siteProjectTitle'] ?? ($raw['site_project_title'] ?? ($raw['site'] ?? 'Headquarters')));

            $attStmt->execute([
                $attId, $effEmpId, $effEmpName, $attDate,
                $checkIn, $checkOut, $status, $site
            ]);

            $attKeyMap[$lookupKey] = $attId;

            $imported[] = [
                'id' => $attId,
                'employeeId' => $effEmpId,
                'employeeName' => $effEmpName,
                'attendanceDate' => $attDate,
                'checkInTime' => $checkIn,
                'checkOutTime' => $checkOut,
                'status' => $status,
                'siteProjectTitle' => $site
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during attendance import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($attendance),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/service-tickets/import or /service/import - Batch Service Tickets Import to MySQL
if ($method === 'POST' && in_array($cleanPath, ['/service-tickets/import', '/service-tickets/import/', '/service/import', '/service/import/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $tickets = $body['tickets'] ?? ($body['service'] ?? ($body['rows'] ?? (is_array($body) && isset($body[0]) ? $body : [])));
    if (!is_array($tickets) || empty($tickets)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'No service ticket records provided for import.']);
        exit;
    }

    $stmt = $pdo->query('SELECT id, ticket_id FROM `solar_service_tickets`');
    $existing = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $ticketMap = [];
    foreach ($existing as $ex) {
        $tid = strtoupper(trim($ex['ticket_id'] ?? ''));
        if (!empty($tid)) $ticketMap[$tid] = $ex['id'];
    }

    $imported = [];
    $skipped = [];
    $failed = [];
    $errors = [];
    $seq = round(microtime(true) * 1000) % 10000;

    $pdo->beginTransaction();
    try {
        $tkStmt = $pdo->prepare("
            INSERT INTO `solar_service_tickets` (
                `id`, `ticket_id`, `customer_id`, `customer_name`, `project_id`,
                `project_title`, `issue`, `category`, `priority`, `status`,
                `scheduled_date`, `resolved_date`, `created_at`, `updated_at`
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ");

        foreach ($tickets as $idx => $raw) {
            $rowNum = $idx + 1;
            if (!is_array($raw)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Malformed record'];
                $errors[] = "Row $rowNum: Malformed record";
                continue;
            }

            $issue = trim($raw['issue'] ?? ($raw['description'] ?? ($raw['title'] ?? '')));
            if (empty($issue)) {
                $failed[] = ['row' => $rowNum, 'reason' => 'Ticket issue description is required.'];
                $errors[] = "Row $rowNum: Ticket issue description is required.";
                continue;
            }

            $rawTicketId = strtoupper(trim($raw['ticketId'] ?? ($raw['ticket_id'] ?? '')));
            if (!empty($rawTicketId) && isset($ticketMap[$rawTicketId])) {
                $skipped[] = ['row' => $rowNum, 'name' => $rawTicketId, 'reason' => "Ticket ID \"$rawTicketId\" already exists."];
                $errors[] = "Row $rowNum Skipped (Duplicate): Ticket ID \"$rawTicketId\" already exists.";
                continue;
            }

            $tkDbId = $raw['id'] ?? ('srv-imp-' . round(microtime(true) * 1000) . '-' . $rowNum);
            $ticketCode = !empty($rawTicketId) ? $rawTicketId : ('SRV-' . date('Y') . '-' . str_pad(++$seq, 4, '0', STR_PAD_LEFT));
            $custId = trim($raw['customerId'] ?? ($raw['customer_id'] ?? ''));
            $custName = trim($raw['customerName'] ?? ($raw['customer_name'] ?? 'Client'));
            $projId = trim($raw['projectId'] ?? ($raw['project_id'] ?? ''));
            $projTitle = trim($raw['projectTitle'] ?? ($raw['project_title'] ?? 'Solar System'));
            $cat = trim($raw['category'] ?? 'INVERTER');
            $priority = strtoupper(trim($raw['priority'] ?? 'MEDIUM'));
            $status = strtoupper(trim($raw['status'] ?? 'OPEN'));
            $schedDate = !empty($raw['scheduledDate']) ? substr($raw['scheduledDate'], 0, 10) : date('Y-m-d');
            $resDate = !empty($raw['resolvedDate']) ? substr($raw['resolvedDate'], 0, 10) : ($status === 'RESOLVED' ? date('Y-m-d') : null);

            $tkStmt->execute([
                $tkDbId, $ticketCode, $custId, $custName, $projId,
                $projTitle, $issue, $cat, $priority, $status,
                $schedDate, $resDate
            ]);

            $ticketMap[$ticketCode] = $tkDbId;

            $imported[] = [
                'id' => $tkDbId,
                'ticketId' => $ticketCode,
                'customerId' => $custId,
                'customerName' => $custName,
                'projectId' => $projId,
                'projectTitle' => $projTitle,
                'issue' => $issue,
                'category' => $cat,
                'priority' => $priority,
                'status' => $status,
                'scheduledDate' => $schedDate,
                'resolvedDate' => $resDate
            ];
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Database error during service tickets import: ' . $e->getMessage()]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'total' => count($tickets),
        'imported' => count($imported),
        'skipped' => count($skipped),
        'failed' => count($failed),
        'importedRecords' => $imported,
        'skippedRecords' => $skipped,
        'failedRecords' => $failed,
        'errors' => $errors
    ]);
    exit;
}

// POST /api/sync/push - Real-Time MySQL Synchronization Across All Collections (Protected + RBAC)
if ($method === 'POST' && in_array($cleanPath, ['/sync/push', '/sync/push/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    $collection = $body['collection'] ?? '';
    $item = $body['item'] ?? $body['payload'] ?? null;
    $items = $body['items'] ?? null;
    $action = $body['action'] ?? ($body['isDelete'] ?? false ? 'delete' : 'save');

    if (empty($collection)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Collection name is required.']);
        exit;
    }

    $normCol = strtolower(trim((string)$collection));
    $actorRole = $actor['role'] ?? '';
    $isCustomer = (strtoupper((string)($actor['accountType'] ?? '')) === 'CUSTOMER') || in_array(strtolower($actorRole), ['customer', 'client'], true);

    if ($isCustomer) {
        if (!in_array($normCol, ['service_tickets', 'solar_service_tickets', 'notifications', 'solar_notifications'], true)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to project stages, progress, and system data.']);
            exit;
        }
    } elseif (in_array($normCol, ['users', 'solar_users', 'acl_config', 'solar_acl_config', 'settings', 'solar_system_settings', 'warehouses', 'solar_warehouses', 'vendor_sales_invoices', 'solar_vendor_sales_invoices'], true)) {
        if (!in_array(strtoupper(trim((string)$actorRole)), ['ADMIN', 'SUPER ADMIN'], true)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Only Administrators can modify users, permissions, warehouses, system settings, or vendor sales invoices.']);
            exit;
        }
    } elseif (in_array($normCol, ['employees', 'employee', 'solar_employees', 'solar_employee'], true)) {
        if (!in_array($actorRole, ['Admin', 'Super Admin', 'HR Manager'], true)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Only Administrators or HR Managers can modify employee directory records.']);
            exit;
        }
    }

    // Enforce Admin-only updates on existing service tickets or technician assignments via /sync/push
    if (in_array($normCol, ['service_tickets', 'solar_service_tickets'], true) && is_array($item)) {
        $isActorAdmin = in_array(strtoupper(trim((string)$actorRole)), ['ADMIN', 'SUPER ADMIN'], true);
        if (!$isActorAdmin) {
            if ($action === 'delete') {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => 'Forbidden: Only Administrators can delete service tickets.']);
                exit;
            }
            $existingTk = !empty($item['id']) ? getServiceTicketRowPhp($pdo, $item['id']) : null;
            if ($existingTk) {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => 'Forbidden: Only Administrators can modify service ticket status, priority, or technician assignment.']);
                exit;
            }
            $item['status'] = 'OPEN';
            $item['assignedTechnicianId'] = '';
            $item['assignedTechnicianName'] = '';
            $item['assignedToName'] = 'Unassigned';
        }
    }

    // For singleton stores like settings and acl_config
    if (!$item && ($collection === 'settings' || $collection === 'acl_config')) {
        $item = $items ?? ($body['settings'] ?? ($body['config'] ?? $body));
    }

    try {
        // Handle delete
        $deleteId = $item['id'] ?? ($body['id'] ?? (is_string($item) ? $item : null));
        if ($deleteId && $action === 'delete') {
            deleteItemFromDb($pdo, $normCol, $deleteId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'deletedId' => $deleteId, 'message' => "Deleted record $deleteId from $collection in MySQL"]);
            exit;
        }

        // Handle single item save
        if ($item) {
            $saved = saveItemToDb($pdo, $collection, $item, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $saved, 'message' => "Saved to $collection in MySQL"]);
            exit;
        }

        // Handle array batch save
        if ($items && is_array($items)) {
            $pdo->beginTransaction();
            foreach ($items as $it) {
                if ($it && (!empty($it['id']) || $collection === 'settings' || $collection === 'acl_config')) {
                    saveItemToDb($pdo, $collection, $it, $actor);
                }
            }
            $pdo->commit();
            http_response_code(200);
            echo json_encode(['success' => true, 'count' => count($items), 'message' => "Synced $collection batch to MySQL"]);
            exit;
        }

        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Invalid sync payload. Expected "item" or "items" array.']);
        exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        $msg = $e->getMessage();
        $exCode = intval($e->getCode());
        if ($exCode >= 400 && $exCode < 600) {
            $code = $exCode;
        } elseif (str_contains($msg, 'Primary/Default warehouse') || str_contains($msg, 'Invalid GST rate')) {
            $code = 400;
        } else {
            $code = 500;
        }
        error_log("Error in /sync/push ($collection): " . $msg);
        http_response_code($code);
        echo json_encode([
            'success' => false,
            'error' => $code < 500 ? $msg : ('Database persistence error: ' . $msg),
            'message' => $code < 500 ? $msg : ('Database persistence error: ' . $msg),
            'collection' => $collection
        ]);
        exit;
    }
}

// GET /api/bootstrap - Master State Hydration (Transforms MySQL Snake_Case into Model CamelCase)
if ($method === 'GET' && in_array($cleanPath, ['/bootstrap', '/bootstrap/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $data = [];
    $bootstrapErrors = [];

    // 1. Customers
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_customers` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['customers'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'customerCode' => $r['customer_code'],
                'name' => $r['name'],
                'companyName' => $r['company_name'] ?? '',
                'customerType' => $r['customer_type'] ?? 'Residential',
                'phone' => $r['phone'],
                'email' => $r['email'] ?? '',
                'siteAddress' => $r['site_address'] ?? '',
                'city' => $r['city'] ?? 'Ahmedabad',
                'state' => $r['state'] ?? 'Gujarat',
                'pincode' => $r['pincode'] ?? '',
                'gstNumber' => $r['gst_number'] ?? '',
                'electricityConsumerNo' => $r['electricity_consumer_no'] ?? '',
                'sanctionedLoadKw' => floatval($r['sanctioned_load_kw'] ?? 0),
                'status' => $r['status'] ?? 'ACTIVE',
                'activeProjectId' => $r['active_project_id'] ?? null,
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'customers: ' . $e->getMessage(); }

    // 2. Leads
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_leads` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['leads'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'customerName' => $r['customer_name'],
                'companyName' => $r['company_name'] ?? '',
                'phone' => $r['phone'],
                'email' => $r['email'] ?? '',
                'address' => $r['address'] ?? '',
                'city' => $r['city'] ?? '',
                'solarCapacityKw' => floatval($r['solar_capacity_kw'] ?? 0),
                'estimatedValue' => floatval($r['estimated_value'] ?? 0),
                'source' => $r['source'] ?? 'Website',
                'assignedSalespersonId' => $r['assigned_salesperson_id'] ?? '',
                'assignedSalespersonName' => $r['assigned_salesperson_name'] ?? '',
                'status' => $r['status'] ?? 'NEW',
                'notes' => $r['notes'] ?? '',
                'nextFollowUpDate' => $r['next_follow_up_date'],
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'leads: ' . $e->getMessage(); }

    // 3. Project Stages Map
    $stagesByProject = [];
    try {
        $sStmt = $pdo->query('SELECT * FROM `solar_project_stages` ORDER BY `stage_order` ASC');
        while ($s = $sStmt->fetch()) {
            $pId = $s['project_id'];
            if (!isset($stagesByProject[$pId])) $stagesByProject[$pId] = [];
            $stagesByProject[$pId][] = [
                'id' => $s['id'],
                'stageKey' => $s['stage_key'],
                'title' => $s['title'],
                'order' => intval($s['stage_order']),
                'department' => $s['department'],
                'assignedRole' => $s['assigned_role'],
                'assignedEmployeeId' => $s['assigned_employee_id'] ?? '',
                'assignedEmployeeName' => $s['assigned_employee_name'] ?? '',
                'assignedToName' => $s['assigned_employee_name'] ?? '',
                'status' => $s['status'] ?? 'NOT STARTED',
                'priority' => $s['priority'] ?? 'MEDIUM',
                'startDate' => $s['start_date'],
                'dueDate' => $s['due_date'],
                'completedDate' => $s['completed_date'],
                'checklist' => json_decode($s['checklist_json'] ?? '[]', true) ?: [],
                'photos' => json_decode($s['photos_json'] ?? '[]', true) ?: [],
                'documents' => json_decode($s['documents_json'] ?? '[]', true) ?: [],
                'gpsLocation' => json_decode($s['gps_location_json'] ?? 'null', true),
                'notes' => $s['notes'] ?? '',
                'approvedBy' => $s['approved_by'] ?? '',
                'rejectionReason' => $s['rejection_reason'] ?? '',
                'activities' => []
            ];
        }
    } catch (Exception $e) { $bootstrapErrors[] = 'project_stages: ' . $e->getMessage(); }

    // 4. Projects
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_projects` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['projects'] = array_map(function ($r) use ($stagesByProject) {
            $assignments = json_decode($r['assignments_json'] ?? '[]', true) ?: [];
            return [
                'id' => $r['id'],
                'projectCode' => $r['project_code'],
                'customerId' => $r['customer_id'],
                'customerName' => $r['customer_name'],
                'title' => $r['title'],
                'capacityKw' => floatval($r['capacity_kw'] ?? 0),
                'totalValue' => floatval($r['total_value'] ?? 0),
                'receivedInflow' => (isset($r['received_inflow']) && $r['received_inflow'] !== null) ? floatval($r['received_inflow']) : null,
                'status' => $r['status'] ?? 'PLANNING',
                'currentStageKey' => $r['current_stage_key'] ?? 'site_survey',
                'completionPercentage' => intval($r['completion_percentage'] ?? 0),
                'progressPercentage' => intval($r['completion_percentage'] ?? 0),
                'projectManagerId' => $r['project_manager_id'] ?? '',
                'projectManagerName' => $r['project_manager_name'] ?? '',
                'siteAddress' => $r['site_address'] ?? '',
                'city' => $r['city'] ?? 'Ahmedabad',
                'location' => !empty($r['city']) ? $r['city'] : ($r['site_address'] ?? ''),
                'inverterModel' => $r['inverter_model'] ?? '',
                'panelModel' => $r['panel_model'] ?? '',
                'structureType' => $r['structure_type'] ?? 'Elevated GI Structure',
                'startDate' => $r['start_date'],
                'expectedCompletionDate' => $r['expected_completion_date'],
                'notes' => $r['notes'] ?? '',
                'assignedUsers' => $assignments,
                'stages' => $stagesByProject[$r['id']] ?? [],
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'projects: ' . $e->getMessage(); }

    // 5. Employees
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_employees` ORDER BY `created_at` ASC');
        $rows = $stmt->fetchAll();
        $existingEmpIds = [];
        $existingEmpEmails = [];
        foreach ($rows as $er) {
            $existingEmpIds[$er['id']] = true;
            if (!empty($er['email'])) $existingEmpEmails[strtolower($er['email'])] = true;
        }

        // Merge users who are staff members from solar_users
        try {
            $uStmt = $pdo->query("SELECT * FROM `solar_users` WHERE `role` != 'Customer'");
            while ($u = $uStmt->fetch()) {
                $uEmail = strtolower($u['email'] ?? '');
                if (empty($existingEmpIds[$u['id']]) && (empty($uEmail) || empty($existingEmpEmails[$uEmail]))) {
                    $rows[] = [
                        'id' => $u['id'],
                        'employee_code' => $u['employee_id'] ?: ('EMP-' . substr($u['id'], -4)),
                        'name' => $u['name'],
                        'photo_url' => $u['photo_url'] ?? ($u['avatar'] ?? ''),
                        'department' => $u['department'] ?: 'Operations',
                        'designation' => $u['designation'] ?: ($u['role'] ?: 'Staff Member'),
                        'phone' => $u['phone'] ?: '',
                        'email' => $u['email'],
                        'joining_date' => $u['created_at'],
                        'salary_monthly' => 0.00,
                        'esic_number' => '',
                        'bank_account_number' => '',
                        'bank_name' => '',
                        'ifsc_code' => '',
                        'emergency_contact_person' => '',
                        'emergency_contact_number' => '',
                        'status' => $u['status'] ?: 'ACTIVE',
                        'current_site_location' => '',
                        'login_enabled' => ($u['status'] !== 'DISABLED') ? 1 : 0,
                        'system_role' => $u['role'] ?: 'Admin',
                        'is_field_worker' => $u['is_field_worker'] ?? 0,
                        'account_status' => ($u['status'] === 'DISABLED') ? 'DISABLED' : 'ACTIVE',
                        'created_at' => $u['created_at']
                    ];
                    $existingEmpIds[$u['id']] = true;
                    if (!empty($uEmail)) $existingEmpEmails[$uEmail] = true;
                }
            }
        } catch (Exception $ue) { $bootstrapErrors[] = 'users_merge: ' . $ue->getMessage(); }

        $empDocMap = [];
        try {
            $dStmt = $pdo->query('SELECT * FROM `solar_employee_documents` ORDER BY `uploaded_at` DESC');
            foreach (($dStmt->fetchAll(PDO::FETCH_ASSOC) ?: []) as $d) {
                $empDocMap[$d['employee_id']][] = [
                    'id' => $d['id'],
                    'category' => $d['category'],
                    'name' => $d['name'],
                    'fileName' => $d['file_name'],
                    'filePath' => $d['file_path'],
                    'fileUrl' => $d['file_url'],
                    'mimeType' => $d['mime_type'],
                    'fileSize' => intval($d['file_size'] ?? 0),
                    'uploadedAt' => !empty($d['uploaded_at']) ? date('c', strtotime($d['uploaded_at'])) : date('c'),
                    'uploadedBy' => $d['uploaded_by'] ?? 'HR Administrator',
                    'notes' => $d['notes'] ?? null
                ];
            }
        } catch (Exception $de) {}

        $data['employees'] = array_map(function ($r) use ($empDocMap) {
            $docs = $empDocMap[$r['id']] ?? [];
            if (empty($docs) && !empty($r['documents_json'])) {
                $parsed = json_decode($r['documents_json'], true);
                if (is_array($parsed)) $docs = $parsed;
            }
            return [
                'id' => $r['id'],
                'authUid' => $r['auth_uid'] ?? $r['id'],
                'employeeCode' => $r['employee_code'],
                'name' => $r['name'],
                'photoUrl' => $r['photo_url'] ?? '',
                'department' => $r['department'],
                'designation' => $r['designation'],
                'phone' => $r['phone'],
                'email' => $r['email'],
                'joiningDate' => !empty($r['joining_date']) ? substr((string)$r['joining_date'], 0, 10) : '',
                'salaryMonthly' => floatval($r['salary_monthly'] ?? 0),
                'esicNumber' => $r['esic_number'] ?? '',
                'bankAccountNumber' => $r['bank_account_number'] ?? '',
                'bankName' => $r['bank_name'] ?? '',
                'ifscCode' => $r['ifsc_code'] ?? '',
                'emergencyContactPerson' => $r['emergency_contact_person'] ?? '',
                'emergencyContactNumber' => $r['emergency_contact_number'] ?? '',
                'status' => $r['status'] ?? 'ACTIVE',
                'currentSiteLocation' => $r['current_site_location'] ?? '',
                'loginEnabled' => (bool)($r['login_enabled'] ?? 1),
                'systemRole' => $r['system_role'] ?? 'Project Manager',
                'assignedRole' => $r['assigned_role'] ?? ($r['system_role'] ?? 'Project Manager'),
                'isFieldWorker' => (bool)($r['is_field_worker'] ?? 0),
                'accountStatus' => $r['account_status'] ?? 'ACTIVE',
                'documents' => $docs,
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'employees: ' . $e->getMessage(); }

    // 6. Payments
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_payments` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['payments'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'receiptNumber' => $r['receipt_number'],
                'projectId' => $r['project_id'],
                'customerId' => $r['customer_id'],
                'customerName' => $r['customer_name'],
                'milestone' => $r['milestone'],
                'amount' => floatval($r['amount'] ?? 0),
                'status' => $r['status'],
                'dueDate' => $r['due_date'],
                'paidDate' => $r['paid_date'],
                'paymentMode' => $r['payment_mode'] ?? 'Bank NEFT/RTGS',
                'transactionReference' => $r['transaction_reference'] ?? '',
                'notes' => $r['notes'] ?? '',
                'invoiceId' => $r['invoice_id'] ?? '',
                'invoiceNumber' => $r['invoice_number'] ?? '',
                'bankAccountId' => $r['bank_account_id'] ?? '',
                'journalEntryId' => $r['journal_entry_id'] ?? '',
                'tallySyncStatus' => $r['tally_sync_status'] ?? 'NOT SYNCED',
                'tallyReference' => $r['tally_reference'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'payments: ' . $e->getMessage(); }

    // 7. Expenses
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_expenses` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['expenses'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'expenseNumber' => $r['expense_number'],
                'projectId' => $r['project_id'],
                'projectCode' => $r['project_code'] ?? '',
                'vendorName' => $r['vendor_name'],
                'category' => $r['category'],
                'amount' => floatval($r['amount'] ?? 0),
                'expenseDate' => $r['expense_date'],
                'date' => $r['expense_date'],
                'paymentMode' => $r['payment_mode'] ?? 'Bank Payment',
                'referenceNo' => $r['reference_no'] ?? '',
                'notes' => $r['notes'] ?? '',
                'receiptUrl' => $r['receipt_url'] ?? '',
                'approvedBy' => $r['approved_by'] ?? '',
                'expenseType' => $r['expense_type'] ?? 'DIRECT_EXPENSE',
                'status' => $r['status'] ?? 'PAID',
                'employeeId' => $r['employee_id'] ?? '',
                'employeeName' => $r['employee_name'] ?? '',
                'gstAmount' => floatval($r['gst_amount'] ?? 0),
                'itcEligible' => !empty($r['itc_eligible']),
                'bankAccountId' => $r['bank_account_id'] ?? '',
                'expenseAccountId' => $r['expense_account_id'] ?? '',
                'journalEntryId' => $r['journal_entry_id'] ?? '',
                'approvedAt' => $r['approved_at'] ?? '',
                'rejectionReason' => $r['rejection_reason'] ?? '',
                'paidAt' => $r['paid_at'] ?? '',
                'paidBy' => $r['paid_by'] ?? '',
                'tallySyncStatus' => $r['tally_sync_status'] ?? 'NOT SYNCED',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'expenses: ' . $e->getMessage(); }

    // 8. Products
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_products` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['products'] = array_map(function ($r) {
            $whStocks = !empty($r['warehouse_stocks_json']) ? (json_decode($r['warehouse_stocks_json'], true) ?: []) : [];
            $minStock = isset($r['reorder_level']) ? floatval($r['reorder_level']) : 0.0;
            $gst = isset($r['gst_rate']) ? floatval($r['gst_rate']) : 18.0;
            $unitPrice = floatval($r['unit_price'] ?? 0);
            $sellingPrice = floatval($r['selling_price'] ?? 0);
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'sku' => $r['sku'],
                'itemCode' => $r['sku'],
                'category' => $r['category'],
                'brand' => $r['brand'] ?? '',
                'model' => $r['model'] ?? '',
                'specifications' => $r['specifications'] ?? '',
                'specification' => $r['specifications'] ?? '',
                'unit' => $r['unit'] ?? 'Nos',
                'hsnCode' => $r['hsn_code'] ?? '',
                'gstRate' => $gst,
                'taxRate' => $gst,
                'unitPrice' => $unitPrice,
                'sellingPrice' => $sellingPrice,
                'currentStock' => floatval($r['current_stock'] ?? 0),
                'reorderLevel' => $minStock,
                'minStockLevel' => $minStock,
                'minStockThreshold' => $minStock,
                'location' => $r['location'] ?? ($r['warehouse_name'] ?? ''),
                'warehouseId' => $r['warehouse_id'] ?? '',
                'warehouseName' => $r['warehouse_name'] ?? '',
                'warehouseStocks' => $whStocks,
                'preferredVendorId' => $r['preferred_vendor_id'] ?? '',
                'preferredVendorName' => $r['preferred_vendor_name'] ?? '',
                'status' => $r['status'] ?? 'ACTIVE',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'products: ' . $e->getMessage(); }

    // 9. Vendors
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_vendors` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['vendors'] = array_map(function ($r) {
            $cats = json_decode($r['categories_json'] ?? '[]', true) ?: [];
            $bank = !empty($r['bank_details_json']) ? json_decode($r['bank_details_json'], true) : null;
            $cat = $cats[0] ?? 'Solar Modules';
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'vendorCode' => $r['vendor_code'],
                'contactPerson' => $r['contact_person'] ?? '',
                'phone' => $r['phone'] ?? '',
                'email' => $r['email'] ?? '',
                'address' => $r['address'] ?? '',
                'city' => $r['city'] ?? '',
                'state' => $r['state'] ?? '',
                'gstNumber' => $r['gst_number'] ?? '',
                'panNumber' => $r['pan_number'] ?? '',
                'paymentTerms' => $r['payment_terms'] ?? '30 Days',
                'rating' => floatval($r['rating'] ?? 4.5),
                'category' => $cat,
                'categories' => !empty($cats) ? $cats : [$cat],
                'bankDetails' => $bank,
                'status' => $r['status'] ?? 'ACTIVE',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'vendors: ' . $e->getMessage(); }

    // 10. Purchase Orders
    $bankNameMapBoot = getBankAccountNameMapPhp($pdo);
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_purchase_orders` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['purchase_orders'] = array_map(function ($r) use ($bankNameMapBoot) {
            $receipts = json_decode($r['receipts_json'] ?? '[]', true) ?: [];
            $total = floatval($r['total_amount'] ?? 0);
            $paid = floatval($r['paid_amount'] ?? 0);
            $returned = floatval($r['returned_amount'] ?? 0);
            $refunded = floatval($r['refunded_amount'] ?? 0);
            $netPaid = round(max(0.0, $paid - $refunded), 2);
            $bal = isset($r['balance_amount']) && $r['balance_amount'] !== null && ($paid > 0 || $returned > 0 || floatval($r['balance_amount']) > 0)
                ? round(max(0.0, floatval($r['balance_amount'])), 2)
                : round(max(0.0, $total - $returned - $netPaid), 2);
            $bankId = (string)($r['bank_account_id'] ?? '');
            $billMeta = mapVendorBillsFromPoRowPhp($r);
            return [
                'id' => $r['id'],
                'purchaseNumber' => $r['po_number'],
                'poNumber' => $r['po_number'],
                'vendorId' => $r['vendor_id'],
                'vendorName' => $r['vendor_name'],
                'projectId' => $r['project_id'] ?? '',
                'projectTitle' => $r['project_title'] ?? '',
                'warehouseId' => $r['warehouse_id'] ?? '',
                'warehouseName' => $r['warehouse_name'] ?? '',
                'purchaseDate' => $r['po_date'],
                'orderDate' => $r['po_date'],
                'poDate' => $r['po_date'],
                'expectedDeliveryDate' => $r['expected_delivery_date'] ?? '',
                'paymentDueDate' => $r['payment_due_date'] ?? null,
                'invoiceReference' => $r['invoice_reference'] ?? '',
                'stockUpdated' => (bool)($r['stock_updated'] ?? 0),
                'receivedDate' => $r['received_date'] ?? null,
                'subtotal' => floatval($r['subtotal'] ?? 0),
                'gstAmount' => floatval($r['gst_amount'] ?? 0),
                'taxAmount' => floatval($r['gst_amount'] ?? 0),
                'totalAmount' => $total,
                'grandTotal' => $total,
                'paidAmount' => $paid,
                'returnedAmount' => $returned,
                'refundedAmount' => $refunded,
                'balanceAmount' => $bal,
                'bankAccountId' => $bankId,
                'bankAccountName' => $bankId !== '' ? ($bankNameMapBoot[$bankId] ?? '') : '',
                'status' => $r['status'] ?? 'ISSUED',
                'paymentStatus' => $r['payment_status'] ?? 'PENDING',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'deliveryReceipts' => $receipts,
                'receipts' => $receipts,
                'vendorBills' => $billMeta['vendorBills'],
                'vendorBillUrl' => $billMeta['vendorBillUrl'],
                'vendorBillName' => $billMeta['vendorBillName'],
                'vendorBillMimeType' => $billMeta['vendorBillMimeType'],
                'vendorBillSize' => $billMeta['vendorBillSize'],
                'vendorBillUploadedAt' => $billMeta['vendorBillUploadedAt'],
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'purchase_orders: ' . $e->getMessage(); }

    // 11. BOMs
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_boms` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['boms'] = array_map(function ($r) {
            $cap = floatval($r['system_capacity_kw'] ?? 0);
            $cost = floatval($r['total_estimated_cost'] ?? 0);
            return [
                'id' => $r['id'],
                'bomNumber' => $r['bom_number'],
                'projectId' => $r['project_id'],
                'projectCode' => $r['project_code'] ?? '',
                'projectTitle' => $r['project_title'],
                'customerName' => $r['customer_name'] ?? '',
                'capacityKw' => $cap,
                'systemCapacityKw' => $cap,
                'version' => $r['version'] ?? '1.0',
                'status' => $r['status'] ?? 'APPROVED',
                'warehouseId' => $r['warehouse_id'] ?? '',
                'warehouseName' => $r['warehouse_name'] ?? '',
                'stockAllocated' => (bool)($r['stock_allocated'] ?? 0),
                'ewayBillNumber' => $r['eway_bill_number'] ?? '',
                'ewayBillDate' => $r['eway_bill_date'] ?? '',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'totalCost' => $cost,
                'totalEstimatedCost' => $cost,
                'createdBy' => $r['created_by'] ?? '',
                'approvedBy' => $r['approved_by'] ?? '',
                'approvedAt' => $r['approved_at'] ?? null,
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'boms: ' . $e->getMessage(); }

    // 12. Sales Invoices
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_sales_invoices` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['sales_invoices'] = array_map(function ($r) use ($bankNameMapBoot) {
            $status = $r['payment_status'] ?? 'ISSUED';
            $gst = floatval($r['gst_amount'] ?? 0);
            $total = floatval($r['total_amount'] ?? 0);
            $paid = floatval($r['paid_amount'] ?? 0);
            $returned = floatval($r['returned_amount'] ?? 0);
            $refunded = floatval($r['refunded_amount'] ?? 0);
            $bal = floatval($r['balance_amount'] ?? 0);
            $bankId = (string)($r['bank_account_id'] ?? '');
            return [
                'id' => $r['id'],
                'invoiceNumber' => $r['invoice_number'],
                'invoiceType' => $r['invoice_type'] ?? 'TAX_INVOICE',
                'projectId' => $r['project_id'] ?? '',
                'projectTitle' => $r['project_title'] ?? '',
                'customerId' => $r['customer_id'],
                'customerName' => $r['customer_name'],
                'customerGst' => $r['customer_gst'] ?? '',
                'customerAddress' => $r['customer_address'] ?? '',
                'invoiceDate' => $r['invoice_date'],
                'dueDate' => $r['due_date'] ?? '',
                'paymentTerms' => $r['payment_terms'] ?? '15 Days Net',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'subtotal' => floatval($r['subtotal'] ?? 0),
                'taxAmount' => $gst,
                'gstAmount' => $gst,
                'totalAmount' => $total,
                'grandTotal' => $total,
                'status' => $status,
                'paymentStatus' => $status,
                'paidAmount' => $paid,
                'amountPaid' => $paid,
                'returnedAmount' => $returned,
                'refundedAmount' => $refunded,
                'balanceAmount' => $bal,
                'balanceDue' => $bal,
                'bankAccountId' => $bankId,
                'bankAccountName' => $bankId !== '' ? ($bankNameMapBoot[$bankId] ?? '') : '',
                'ewayBillNumber' => $r['eway_bill_number'] ?? '',
                'ewayBillDetails' => json_decode($r['eway_bill_details_json'] ?? 'null', true),
                'cgstAmount' => floatval($r['cgst_amount'] ?? 0),
                'sgstAmount' => floatval($r['sgst_amount'] ?? 0),
                'igstAmount' => floatval($r['igst_amount'] ?? 0),
                'einvoiceIrn' => $r['einvoice_irn'] ?? '',
                'einvoiceAckNo' => $r['einvoice_ack_no'] ?? '',
                'einvoiceAckDate' => $r['einvoice_ack_date'] ?? '',
                'einvoiceStatus' => $r['einvoice_status'] ?? 'NOT_GENERATED',
                'warehouseId' => $r['warehouse_id'] ?? '',
                'deductStock' => isset($r['deduct_stock']) ? (bool)$r['deduct_stock'] : true,
                'stockDeducted' => (bool)($r['stock_deducted'] ?? 0),
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'sales_invoices: ' . $e->getMessage(); }

    // 13. Attendance
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_attendance` ORDER BY `attendance_date` DESC');
        $rows = $stmt->fetchAll();
        $data['attendance'] = array_map(function ($r) {
            $fuelExpense = null;
            if (!empty($r['fuel_expense_json'])) {
                $fuelExpense = json_decode($r['fuel_expense_json'], true);
                if (is_array($fuelExpense)) {
                    if (!isset($fuelExpense['totalKmDriven']) && isset($fuelExpense['finalOdometerReading']) && isset($fuelExpense['initialOdometerReading'])) {
                        $diff = floatval($fuelExpense['finalOdometerReading']) - floatval($fuelExpense['initialOdometerReading']);
                        if ($diff >= 0) {
                            $fuelExpense['totalKmDriven'] = round($diff * 10) / 10;
                        }
                    }
                }
            }
            $checkInGps = json_decode($r['check_in_gps_json'] ?? 'null', true);
            $checkOutGps = json_decode($r['check_out_gps_json'] ?? 'null', true);
            return [
                'id' => $r['id'],
                'employeeId' => $r['employee_id'],
                'employeeName' => $r['employee_name'],
                'attendanceDate' => $r['attendance_date'],
                'date' => $r['attendance_date'],
                'checkInTime' => $r['check_in_time'],
                'checkOutTime' => $r['check_out_time'],
                'checkInGps' => $checkInGps,
                'checkInGPS' => $checkInGps,
                'checkOutGps' => $checkOutGps,
                'checkOutGPS' => $checkOutGps,
                'siteProjectId' => $r['site_project_id'] ?? '',
                'siteProjectTitle' => $r['site_project_title'] ?? '',
                'status' => $r['status'] ?? 'PRESENT',
                'fuelExpense' => $fuelExpense,
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'attendance: ' . $e->getMessage(); }

    // 14. Payslips
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_payslips` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['payslips'] = array_map(function ($r) {
            $addExpenses = json_decode($r['additional_expenses_json'] ?? '[]', true) ?: [];
            $dedList = json_decode($r['deductions_json'] ?? '[]', true) ?: [];
            $totalExpenses = is_array($addExpenses) ? array_reduce($addExpenses, fn($s, $x) => $s + floatval($x['amount'] ?? 0), 0) : 0;
            $totalDeductions = !empty($dedList) && is_array($dedList)
                ? array_reduce($dedList, fn($s, $x) => $s + floatval($x['amount'] ?? 0), 0)
                : floatval($r['deductions'] ?? 0);
            $basic = floatval($r['basic_salary'] ?? 0);
            $overtimeAmt = floatval($r['allowances'] ?? 0);
            $net = floatval($r['net_salary'] ?? ($basic + $overtimeAmt + $totalExpenses - $totalDeductions));

            return [
                'id' => $r['id'],
                'payslipNumber' => $r['id'],
                'employeeId' => $r['employee_id'],
                'employeeName' => $r['employee_name'],
                'employeeCode' => $r['employee_id'],
                'month' => $r['month'],
                'year' => intval($r['year']),
                'baseSalary' => $basic,
                'basicSalary' => $basic,
                'allowances' => $overtimeAmt,
                'overtimeAmount' => $overtimeAmt,
                'overtimeType' => (!empty($r['overtime_hours']) && floatval($r['overtime_hours']) > 0) ? 'CALCULATED' : 'DIRECT',
                'overtimeHours' => floatval($r['overtime_hours'] ?? 0),
                'overtimeRatePerHour' => floatval($r['overtime_rate'] ?? 0),
                'additionalExpenses' => $addExpenses,
                'totalAdditionalExpenses' => $totalExpenses,
                'deductions' => $dedList,
                'totalDeductions' => $totalDeductions,
                'grossEarnings' => $basic + $overtimeAmt + $totalExpenses,
                'netPay' => $net,
                'netSalary' => $net,
                'paymentStatus' => $r['payment_status'] ?? 'PAID',
                'status' => $r['payment_status'] === 'PAID' ? 'PAID' : ($r['payment_status'] ?? 'GENERATED'),
                'paymentDate' => $r['payment_date'],
                'paymentMode' => $r['payment_mode'] ?? 'NEFT/RTGS Bank Transfer',
                'bankReferenceNo' => $r['bank_reference_no'] ?? '',
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'payslips: ' . $e->getMessage(); }

    // 15. Holidays
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_holidays` ORDER BY `holiday_date` ASC');
        $rows = $stmt->fetchAll();
        $data['holidays'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'holidayDate' => $r['holiday_date'],
                'date' => $r['holiday_date'],
                'type' => $r['type'] ?? 'Mandatory',
                'description' => $r['description'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'holidays: ' . $e->getMessage(); }

    // 16. Quotations
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_quotations` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['quotations'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'quotationNumber' => $r['quotation_number'],
                'customerId' => $r['customer_id'] ?? '',
                'customerName' => $r['customer_name'],
                'projectId' => $r['project_id'] ?? '',
                'capacityKw' => floatval($r['capacity_kw'] ?? 0),
                'ratePerWp' => floatval($r['rate_per_wp'] ?? 0),
                'baseAmount' => floatval($r['base_amount'] ?? 0),
                'taxAmount' => floatval($r['tax_amount'] ?? 0),
                'panelBrand' => $r['panel_brand'] ?? '',
                'inverterBrand' => $r['inverter_brand'] ?? '',
                'structureType' => $r['structure_type'] ?? '',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'subtotal' => floatval($r['subtotal'] ?? 0),
                'discountAmount' => floatval($r['discount_amount'] ?? 0),
                'gstPercent' => floatval($r['gst_percent'] ?? 13.8),
                'gstAmount' => floatval($r['gst_amount'] ?? 0),
                'totalAmount' => floatval($r['total_amount'] ?? 0),
                'paymentTerms' => $r['payment_terms'] ?? '',
                'warrantyDetails' => $r['warranty_details'] ?? '',
                'termsAndConditions' => $r['terms_and_conditions'] ?? '',
                'status' => $r['status'] ?? 'DRAFT',
                'validUntil' => $r['valid_until'],
                'quotationDate' => !empty($r['created_at']) ? substr($r['created_at'], 0, 10) : date('Y-m-d'),
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'quotations: ' . $e->getMessage(); }

    // 17. Surveys
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_site_surveys` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['surveys'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'projectId' => $r['project_id'] ?? '',
                'leadId' => $r['project_id'] ?? '',
                'customerId' => $r['customer_id'] ?? '',
                'engineerId' => $r['engineer_id'] ?? '',
                'engineerName' => $r['engineer_name'],
                'surveyDate' => $r['survey_date'],
                'status' => $r['status'] ?? 'APPROVED',
                'siteAddress' => $r['site_address'],
                'address' => $r['site_address'],
                'latitude' => !empty($r['latitude']) ? floatval($r['latitude']) : null,
                'longitude' => !empty($r['longitude']) ? floatval($r['longitude']) : null,
                'locationName' => $r['location_name'] ?? '',
                'city' => $r['location_name'] ?? '',
                'roofType' => $r['roof_type'] ?? 'RCC Flat',
                'roofAreaSqft' => floatval($r['roof_area_sqft'] ?? 0),
                'roofAreaSqFt' => floatval($r['roof_area_sqft'] ?? 0),
                'shadowFreeAreaSqft' => floatval($r['shadow_free_area_sqft'] ?? 0),
                'shadowFreeAreaSqFt' => floatval($r['shadow_free_area_sqft'] ?? 0),
                'shadowObstacles' => $r['shadow_obstacles'] ?? '',
                'electricityBillNumber' => $r['electricity_bill_number'] ?? '',
                'monthlyAvgConsumption' => floatval($r['monthly_avg_consumption'] ?? 0),
                'sanctionedLoadKw' => floatval($r['sanctioned_load_kw'] ?? 0),
                'tariffRate' => floatval($r['tariff_rate'] ?? 0),
                'existingStructureCondition' => $r['existing_structure_condition'] ?? '',
                'recommendedCapacityKw' => floatval($r['recommended_capacity_kw'] ?? 0),
                'proposedCapacityKw' => floatval($r['recommended_capacity_kw'] ?? 0),
                'feasibilityScore' => $r['feasibility_score'] ?? 'GOOD',
                'photos' => json_decode($r['photos_json'] ?? '[]', true) ?: [],
                'notes' => $r['notes'] ?? '',
                'reviewedBy' => $r['reviewed_by'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'surveys: ' . $e->getMessage(); }

    // 18. Warehouses
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_warehouses` ORDER BY `is_default` DESC, `created_at` ASC');
        $rows = $stmt->fetchAll();
        $data['warehouses'] = array_map(function ($r) {
            $status = $r['status'] ?? (!empty($r['is_active']) ? 'ACTIVE' : 'INACTIVE');
            $contactPerson = $r['manager_name'] ?? '';
            $contactPhone = $r['manager_phone'] ?? '';
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'code' => $r['code'],
                'address' => $r['address'] ?? '',
                'city' => $r['city'] ?? '',
                'state' => $r['state'] ?? '',
                'pincode' => $r['pincode'] ?? '',
                'contactPerson' => $contactPerson,
                'contactPhone' => $contactPhone,
                'managerName' => $contactPerson,
                'managerPhone' => $contactPhone,
                'email' => $r['email'] ?? '',
                'gstNumber' => $r['gst_number'] ?? '',
                'capacitySqFt' => floatval($r['capacity_sq_ft'] ?? 15000),
                'isActive' => ($status === 'ACTIVE') || (bool)($r['is_active'] ?? 1),
                'status' => $status,
                'isDefault' => (bool)($r['is_default'] ?? 0),
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'warehouses: ' . $e->getMessage(); }

    // 19. Stock Movements
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_stock_movements` ORDER BY `timestamp` DESC LIMIT 200');
        $rows = $stmt->fetchAll();
        $data['stock_movements'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'productId' => $r['product_id'],
                'productName' => $r['product_name'],
                'sku' => $r['sku'] ?? '',
                'type' => $r['movement_type'],
                'movementType' => $r['movement_type'],
                'quantity' => floatval($r['quantity'] ?? 0),
                'balanceAfter' => floatval($r['balance_after'] ?? 0),
                'referenceNumber' => $r['reference_number'] ?? '',
                'referenceId' => $r['reference_id'] ?? '',
                'warehouseId' => $r['warehouse_id'] ?? '',
                'warehouseName' => $r['warehouse_name'] ?? '',
                'targetWarehouseId' => $r['target_warehouse_id'] ?? null,
                'targetWarehouseName' => $r['target_warehouse_name'] ?? null,
                'notes' => $r['notes'] ?? '',
                'timestamp' => $r['timestamp'],
                'performedBy' => $r['performed_by'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'stock_movements: ' . $e->getMessage(); }

    // 20. Stock Audits
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_stock_audits` ORDER BY `audit_date` DESC, `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['stock_audits'] = array_map(function ($r) {
            $items = json_decode($r['items_json'] ?? '[]', true) ?: [];
            $disc = intval($r['discrepancies_count'] ?? 0);
            return [
                'id' => $r['id'],
                'auditNumber' => $r['audit_number'],
                'warehouseId' => $r['warehouse_id'],
                'warehouseName' => $r['warehouse_name'],
                'auditDate' => $r['audit_date'],
                'auditedBy' => $r['auditor_name'],
                'auditorName' => $r['auditor_name'],
                'status' => $r['status'] ?? 'COMPLETED',
                'itemsAudited' => intval($r['items_audited'] ?? count($items)),
                'discrepanciesFound' => $disc,
                'discrepanciesCount' => $disc,
                'netAdjustmentValue' => floatval($r['net_adjustment_value'] ?? 0),
                'items' => $items,
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'stock_audits: ' . $e->getMessage(); }

    // 21. Service Tickets
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_service_tickets` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $historyByTicket = [];
        try {
            $hStmt = $pdo->query('SELECT * FROM `solar_service_ticket_history` ORDER BY `created_at` DESC, `id` DESC');
            foreach (($hStmt ? $hStmt->fetchAll(PDO::FETCH_ASSOC) : []) as $h) {
                $k = (string)($h['ticket_record_id'] ?? '');
                if (!isset($historyByTicket[$k])) $historyByTicket[$k] = [];
                $historyByTicket[$k][] = mapTicketHistoryRowPhp($h);
            }
        } catch (Exception $e) {}
        $data['service_tickets'] = array_map(function ($r) use ($historyByTicket) {
            return mapServiceTicketRowPhp($r, $historyByTicket[$r['id']] ?? []);
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'service_tickets: ' . $e->getMessage(); }

    // 22. AMC Contracts
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_amc_contracts` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $data['amc_contracts'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'amcCode' => $r['amc_code'],
                'customerId' => $r['customer_id'],
                'customerName' => $r['customer_name'],
                'projectId' => $r['project_id'],
                'projectTitle' => $r['project_title'],
                'planName' => $r['plan_name'],
                'startDate' => $r['start_date'],
                'endDate' => $r['end_date'],
                'renewalDate' => $r['renewal_date'],
                'annualAmount' => floatval($r['annual_amount'] ?? 0),
                'visitsCompleted' => intval($r['visits_completed'] ?? 0),
                'totalVisits' => intval($r['total_visits'] ?? 4),
                'status' => $r['status'] ?? 'ACTIVE',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'amc_contracts: ' . $e->getMessage(); }

    // 23. Notifications
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_notifications` ORDER BY `created_at` DESC LIMIT 100');
        $rows = $stmt->fetchAll();
        $data['notifications'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'userId' => $r['user_id'] ?? '',
                'title' => $r['title'],
                'message' => $r['message'],
                'type' => $r['type'] ?? 'INFO',
                'isRead' => (bool)($r['is_read'] ?? 0),
                'linkType' => $r['link_type'],
                'linkId' => $r['link_id'],
                'customerId' => $r['customer_id'],
                'projectId' => $r['project_id'],
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'notifications: ' . $e->getMessage(); }

    // 24. Users
    try {
        $stmt = $pdo->query('SELECT id, name, email, role, phone, department, designation, employee_id, is_field_worker, status, created_at FROM `solar_users` ORDER BY `created_at` ASC');
        $rows = $stmt->fetchAll();
        $data['users'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'email' => $r['email'],
                'role' => $r['role'],
                'phone' => $r['phone'] ?? '',
                'department' => $r['department'] ?? 'Administration',
                'designation' => $r['designation'] ?? '',
                'employeeId' => $r['employee_id'] ?? '',
                'isFieldWorker' => (bool)($r['is_field_worker'] ?? 0),
                'status' => $r['status'] ?? 'ACTIVE',
                'createdAt' => $r['created_at']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'users: ' . $e->getMessage(); }

    // 25. Settings
    try {
        $stmt = $pdo->query("SELECT `setting_value` FROM `solar_system_settings` WHERE `setting_key` = 'global_settings' LIMIT 1");
        $row = $stmt->fetch();
        if ($row && !empty($row['setting_value'])) {
            $data['settings'] = json_decode($row['setting_value'], true) ?: [];
        } else {
            $data['settings'] = [
                'companyName' => 'REJOY SOLAR POWER PVT. LTD',
                'companyAddress' => 'PLOT NO- 14, STREET NO- 14B, PRAGATI NAGAR, RISALI BHILAI, Chhattisgarh 490006',
                'companyPhone' => '+91 98250 12345',
                'companyEmail' => 'rejoysolarpower@gmail.com',
                'companyGst' => '22AAOCR0748K1Z5',
                'currencySymbol' => '₹',
                'taxRatePercent' => 18
            ];
        }
    } catch (Exception $e) { $bootstrapErrors[] = 'settings: ' . $e->getMessage(); }

    // 26. ACL Config
    try {
        $stmt = $pdo->query("SELECT `config_json` FROM `solar_acl_config` WHERE `id` = 'master_acl_config' LIMIT 1");
        $row = $stmt->fetch();
        if ($row && !empty($row['config_json'])) {
            $parsed = json_decode($row['config_json'], true) ?: [];
            $data['acl_config'] = [$parsed];
        } else {
            $data['acl_config'] = [];
        }
    } catch (Exception $e) { $bootstrapErrors[] = 'acl_config: ' . $e->getMessage(); }

    // 27. ACL Audit Logs
    try {
        $stmt = $pdo->query('SELECT * FROM `solar_acl_audit_logs` ORDER BY `timestamp` DESC LIMIT 100');
        $rows = $stmt->fetchAll();
        $data['acl_audit_logs'] = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'actorId' => $r['actor_id'],
                'actorName' => $r['actor_name'],
                'actorRole' => $r['actor_role'],
                'action' => $r['action'],
                'targetRole' => $r['target_role'] ?? '',
                'details' => $r['details'],
                'timestamp' => $r['timestamp']
            ];
        }, $rows ?: []);
    } catch (Exception $e) { $bootstrapErrors[] = 'acl_audit_logs: ' . $e->getMessage(); }

    // 28. Vendor Sales Invoices (Admin / Super Admin Only) + Sales/Purchase Returns
    try {
        $bootUser = getAuthenticatedUserPhp($pdo);
        $bootRole = strtoupper(trim((string)($bootUser['role'] ?? '')));
        if ($bootUser && in_array($bootRole, ['ADMIN', 'SUPER ADMIN'], true)) {
            $data['vendor_sales_invoices'] = getVendorSalesInvoicesPhp($pdo);
        } else {
            $data['vendor_sales_invoices'] = [];
        }
        if ($bootUser && !isCustomerUserPhp($bootUser)) {
            require_once __DIR__ . '/accounting.php';
            $data['sales_returns'] = accGetSalesReturnsPhp($pdo);
            $data['purchase_returns'] = accGetPurchaseReturnsPhp($pdo);
        } else {
            $data['sales_returns'] = [];
            $data['purchase_returns'] = [];
        }
    } catch (Exception $e) {
        if (!isset($data['vendor_sales_invoices'])) $data['vendor_sales_invoices'] = [];
        if (!isset($data['sales_returns'])) $data['sales_returns'] = [];
        if (!isset($data['purchase_returns'])) $data['purchase_returns'] = [];
        error_log('Notice hydrating vendor_sales_invoices / returns in bootstrap: ' . $e->getMessage());
    }

    if (!empty($bootstrapErrors)) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'MySQL bootstrap query failed',
            'failedModules' => $bootstrapErrors
        ]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'timestamp' => date('c'),
        'data' => $data
    ]);
    exit;
}

// ==========================================================
// 28. WORKFORCE LIVE TRACKING & FIELD PRESENCE ENDPOINTS
// ==========================================================

// Helper: Check if staff role/flag qualifies for Field Workforce Tracking
function isEligibleFieldWorkerPhp($role, $isFieldFlag = false, $dept = '') {
    if (!empty($isFieldFlag) && strval($isFieldFlag) !== '0' && strtolower(strval($isFieldFlag)) !== 'false') {
        return true;
    }
    $normRole = strtolower(trim((string)$role));
    $normDept = strtolower(trim((string)$dept));
    if (empty($normRole)) return false;

    if (
        $normRole === 'customer' ||
        $normRole === 'admin' ||
        $normRole === 'super admin' ||
        strpos($normRole, 'accountant') !== false ||
        strpos($normRole, 'finance') !== false ||
        $normRole === 'hr manager' ||
        strpos($normRole, 'director') !== false ||
        strpos($normRole, 'executive assistant') !== false
    ) {
        return false;
    }

    $eligible = [
        'site survey engineer',
        'site inspector',
        'civil team',
        'civil engineer',
        'structure team',
        'structure engineer',
        'installation team',
        'installation engineer',
        'electrical team',
        'electrical engineer',
        'project engineer',
        'technician',
        'service engineer',
        'service manager'
    ];
    foreach ($eligible as $r) {
        if (strpos($normRole, $r) !== false) return true;
    }
    foreach (['engineering', 'installation', 'electrical', 'civil', 'structure', 'service'] as $d) {
        if (strpos($normDept, $d) !== false) return true;
    }
    return false;
}

// Helper: Load verified active field staff maps from solar_employees/solar_employee & solar_users
function loadVerifiedActiveFieldStaffPhp($pdo) {
    $byId = [];
    $byEmail = [];
    $byCode = [];
    $allKnownIds = [];
    $allKnownEmails = [];

    $register = function ($rec) use (&$byId, &$byEmail, &$byCode, &$allKnownIds, &$allKnownEmails) {
        $idKey = strtolower(trim((string)($rec['id'] ?? '')));
        $emailKey = strtolower(trim((string)($rec['email'] ?? '')));
        $codeKey = strtolower(trim((string)($rec['employeeCode'] ?? '')));
        if ($idKey !== '') $allKnownIds[$idKey] = true;
        if ($emailKey !== '') $allKnownEmails[$emailKey] = true;
        if (empty($rec['active'])) return;
        if (!isEligibleFieldWorkerPhp($rec['role'], $rec['isFieldWorker'], $rec['department'])) return;

        if ($idKey !== '' && !isset($byId[$idKey])) $byId[$idKey] = $rec;
        if ($emailKey !== '' && !isset($byEmail[$emailKey])) $byEmail[$emailKey] = $rec;
        if ($codeKey !== '' && !isset($byCode[$codeKey])) $byCode[$codeKey] = $rec;
    };

    foreach (['solar_employees', 'solar_employee'] as $tbl) {
        try {
            $eRows = $pdo->query("SELECT * FROM `$tbl`")->fetchAll(PDO::FETCH_ASSOC);
            foreach ($eRows as $e) {
                $status = strtoupper((string)($e['status'] ?? 'ACTIVE'));
                $acctStatus = strtoupper((string)($e['account_status'] ?? 'ACTIVE'));
                $role = (string)($e['system_role'] ?? $e['assigned_role'] ?? $e['designation'] ?? 'Staff');
                $active = !in_array($status, ['DISABLED', 'INACTIVE', 'TERMINATED'], true)
                    && $acctStatus !== 'DISABLED'
                    && strtolower(trim($role)) !== 'customer';
                $register([
                    'id' => (string)($e['id'] ?? ''),
                    'employeeCode' => (string)($e['employee_code'] ?? $e['id'] ?? ''),
                    'name' => (string)($e['name'] ?? 'Employee'),
                    'email' => strtolower(trim((string)($e['email'] ?? ''))),
                    'role' => $role,
                    'department' => (string)($e['department'] ?? 'Operations'),
                    'phone' => (string)($e['phone'] ?? ''),
                    'isFieldWorker' => !empty($e['is_field_worker']),
                    'active' => $active
                ]);
            }
        } catch (Exception $ex) {}
    }

    try {
        $uRows = $pdo->query("SELECT * FROM `solar_users`")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($uRows as $u) {
            $status = strtoupper((string)($u['status'] ?? 'ACTIVE'));
            $role = (string)($u['role'] ?? 'Staff');
            $active = !in_array($status, ['DISABLED', 'INACTIVE'], true)
                && strtolower(trim($role)) !== 'customer';
            $register([
                'id' => (string)($u['id'] ?? ''),
                'employeeCode' => (string)($u['employee_id'] ?? $u['id'] ?? ''),
                'name' => (string)($u['name'] ?? 'Staff Member'),
                'email' => strtolower(trim((string)($u['email'] ?? ''))),
                'role' => $role,
                'department' => (string)($u['department'] ?? 'Operations'),
                'phone' => (string)($u['phone'] ?? ''),
                'isFieldWorker' => !empty($u['is_field_worker']),
                'active' => $active
            ]);
        }
    } catch (Exception $ex) {}

    return [
        'byId' => $byId,
        'byEmail' => $byEmail,
        'byCode' => $byCode,
        'allKnownIds' => $allKnownIds,
        'allKnownEmails' => $allKnownEmails
    ];
}

function resolveVerifiedFieldStaffPhp($pdo, $userId = '', $email = '', $employeeCode = '') {
    $maps = loadVerifiedActiveFieldStaffPhp($pdo);
    $idKey = strtolower(trim((string)$userId));
    $emailKey = strtolower(trim((string)$email));
    $codeKey = strtolower(trim((string)$employeeCode));
    if ($idKey !== '' && isset($maps['byId'][$idKey])) return $maps['byId'][$idKey];
    if ($emailKey !== '' && isset($maps['byEmail'][$emailKey])) return $maps['byEmail'][$emailKey];
    if ($codeKey !== '' && isset($maps['byCode'][$codeKey])) return $maps['byCode'][$codeKey];
    return null;
}

// GET /api/workforce/locations - Verified Active Field Workforce Locations (Authenticated Non-Customer Staff Only)
if ($method === 'GET' && in_array($cleanPath, ['/workforce/locations', '/workforce/status', '/locations', '/workforce/locations/', '/workforce/status/', '/locations/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $authUser = requireAuthUserPhp($pdo);
    if (strtolower(trim($authUser['role'] ?? '')) === 'customer') {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Customer accounts cannot access workforce tracking.']);
        exit;
    }

    $records = [];
    try {
        $maps = loadVerifiedActiveFieldStaffPhp($pdo);

        $sql = "
            SELECT
                user_id, employee_code, name, email, role,
                latitude, longitude, accuracy, heading, speed, battery_level, activity,
                is_online, is_sharing_location, status,
                DATE_FORMAT(last_seen_at, '%Y-%m-%dT%H:%i:%s.000Z') as last_seen_at_iso,
                DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.000Z') as updated_at_iso,
                TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) as seconds_since_seen
            FROM `solar_workforce_locations`
            ORDER BY last_seen_at DESC
        ";
        $stmt = $pdo->query($sql);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $nowIso = gmdate('Y-m-d\TH:i:s.000\Z');
        $seenCanonicalIds = [];
        $orphanedIds = [];

        foreach ($rows as $r) {
            $rawId = strtolower(trim((string)($r['user_id'] ?? '')));
            $rawEmail = strtolower(trim((string)($r['email'] ?? '')));
            $rawCode = strtolower(trim((string)($r['employee_code'] ?? '')));

            $staff = null;
            if ($rawId !== '' && isset($maps['byId'][$rawId])) $staff = $maps['byId'][$rawId];
            elseif ($rawEmail !== '' && isset($maps['byEmail'][$rawEmail])) $staff = $maps['byEmail'][$rawEmail];
            elseif ($rawCode !== '' && isset($maps['byCode'][$rawCode])) $staff = $maps['byCode'][$rawCode];

            if (!$staff) {
                $existsAnywhere = ($rawId !== '' && isset($maps['allKnownIds'][$rawId]))
                    || ($rawEmail !== '' && isset($maps['allKnownEmails'][$rawEmail]));
                if (!$existsAnywhere && !empty($r['user_id'])) {
                    $orphanedIds[] = $r['user_id'];
                }
                continue;
            }

            if (isset($seenCanonicalIds[$staff['id']])) continue;
            $seenCanonicalIds[$staff['id']] = true;

            $sec = ($r['seconds_since_seen'] !== null) ? intval($r['seconds_since_seen']) : 999999;
            $isOnline = (intval($r['is_online']) === 1) && ($sec >= -30 && $sec <= 120);
            $hasCoords = ($r['latitude'] !== null) && ($r['longitude'] !== null) && ($r['latitude'] !== '') && ($r['longitude'] !== '');
            $speed = ($r['speed'] !== null) ? floatval($r['speed']) : 0;

            if (!$isOnline) {
                $status = 'offline';
            } elseif ($hasCoords) {
                $status = ($speed > 3) ? 'moving' : 'idle';
            } else {
                $status = 'online';
            }

            $activity = $r['activity'] ?: ($isOnline ? ($hasCoords ? (($speed > 3) ? 'In Transit / Moving' : 'On Site / Active') : 'Online • Standby') : 'Offline');

            $records[] = [
                'userId' => $staff['id'],
                'employeeCode' => $staff['employeeCode'] ?: $staff['id'],
                'name' => $staff['name'],
                'email' => $staff['email'] ?: '',
                'role' => $staff['role'],
                'department' => $staff['department'] ?: 'Operations',
                'phone' => $staff['phone'] ?: '',
                'latitude' => $hasCoords ? floatval($r['latitude']) : null,
                'longitude' => $hasCoords ? floatval($r['longitude']) : null,
                'accuracy' => ($r['accuracy'] !== null) ? floatval($r['accuracy']) : null,
                'heading' => ($r['heading'] !== null) ? floatval($r['heading']) : null,
                'speed' => ($r['speed'] !== null) ? floatval($r['speed']) : null,
                'batteryLevel' => ($r['battery_level'] !== null) ? intval($r['battery_level']) : null,
                'activity' => $activity,
                'isOnline' => $isOnline,
                'isSharingLocation' => (bool)intval($r['is_sharing_location']),
                'hasLocation' => $hasCoords,
                'status' => $status,
                'lastSeenAt' => $r['last_seen_at_iso'] ?: $nowIso,
                'updatedAt' => $r['updated_at_iso'] ?: $nowIso,
                'verified' => true
            ];
        }

        // Automatically prune orphaned rows whose users no longer exist in solar_users / solar_employees
        if (!empty($orphanedIds)) {
            $delOrphan = $pdo->prepare('DELETE FROM `solar_workforce_locations` WHERE `user_id` = ?');
            foreach ($orphanedIds as $oid) {
                try { $delOrphan->execute([$oid]); } catch (Exception $de) {}
            }
        }
    } catch (Exception $e) {
        error_log('Error querying workforce locations in PHP gateway: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Database error querying workforce locations: ' . $e->getMessage()
        ]);
        exit;
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'count' => count($records),
        'locations' => $records,
        'workforce' => $records,
        'users' => $records
    ]);
    exit;
}

// POST /api/update-location - Live GPS Update Submission (Verified Active Field Staff Only)
if ($method === 'POST' && in_array($cleanPath, ['/update-location', '/location/update', '/location', '/update-location/', '/location/update/', '/location/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $authUser = requireAuthUserPhp($pdo);
    if (strtolower(trim($authUser['role'] ?? '')) === 'customer') {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Customer accounts cannot submit GPS coordinates.']);
        exit;
    }

    $lat = isset($body['latitude']) && is_numeric($body['latitude']) ? floatval($body['latitude']) : null;
    $lng = isset($body['longitude']) && is_numeric($body['longitude']) ? floatval($body['longitude']) : null;

    if ($lat === null || $lng === null) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing required location fields: latitude, longitude.']);
        exit;
    }

    $verified = resolveVerifiedFieldStaffPhp($pdo, $authUser['id'] ?? '', $authUser['email'] ?? '', $authUser['employeeId'] ?? '');
    if (!$verified) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Only active verified field personnel can submit GPS coordinates.']);
        exit;
    }

    $accuracy = isset($body['accuracy']) ? floatval($body['accuracy']) : null;
    $heading = isset($body['heading']) ? floatval($body['heading']) : null;
    $speed = isset($body['speed']) ? floatval($body['speed']) : null;
    $batteryLevel = isset($body['batteryLevel']) ? intval($body['batteryLevel']) : null;
    $isMoving = ($speed !== null && $speed > 3);
    $activity = trim($body['activity'] ?? ($isMoving ? 'In Transit / Moving' : 'On Site / Active'));
    $status = $isMoving ? 'moving' : 'idle';

    $stmt = $pdo->prepare("
        INSERT INTO `solar_workforce_locations` (
            `user_id`, `employee_code`, `name`, `email`, `role`,
            `latitude`, `longitude`, `accuracy`, `heading`, `speed`,
            `battery_level`, `activity`, `is_online`, `is_sharing_location`,
            `status`, `last_seen_at`
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, NOW())
        ON DUPLICATE KEY UPDATE
            `employee_code` = VALUES(`employee_code`),
            `name` = VALUES(`name`),
            `email` = VALUES(`email`),
            `role` = VALUES(`role`),
            `latitude` = VALUES(`latitude`),
            `longitude` = VALUES(`longitude`),
            `accuracy` = VALUES(`accuracy`),
            `heading` = VALUES(`heading`),
            `speed` = VALUES(`speed`),
            `battery_level` = COALESCE(VALUES(`battery_level`), `battery_level`),
            `activity` = VALUES(`activity`),
            `is_online` = 1,
            `is_sharing_location` = 1,
            `status` = VALUES(`status`),
            `last_seen_at` = NOW()
    ");

    $stmt->execute([
        $verified['id'],
        $verified['employeeCode'] ?: null,
        $verified['name'] ?: null,
        $verified['email'] ?: null,
        $verified['role'] ?: null,
        $lat,
        $lng,
        $accuracy,
        $heading,
        $speed,
        $batteryLevel,
        $activity,
        $status
    ]);

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'broadcasted' => true,
        'payload' => [
            'userId' => $verified['id'],
            'employeeCode' => $verified['employeeCode'],
            'name' => $verified['name'],
            'role' => $verified['role'],
            'latitude' => $lat,
            'longitude' => $lng,
            'accuracy' => $accuracy,
            'heading' => $heading,
            'speed' => $speed,
            'batteryLevel' => $batteryLevel,
            'activity' => $activity,
            'status' => $status,
            'timestamp' => gmdate('Y-m-d\TH:i:s.000\Z')
        ]
    ]);
    exit;
}

// POST /api/presence/heartbeat - Field Worker Presence Heartbeat (Authenticated Verified Field Staff Only)
if ($method === 'POST' && in_array($cleanPath, ['/presence/heartbeat', '/presence', '/presence/heartbeat/', '/presence/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $authUser = requireAuthUserPhp($pdo);
    if (strtolower(trim($authUser['role'] ?? '')) === 'customer') {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Customer accounts cannot register field presence.']);
        exit;
    }

    $verified = resolveVerifiedFieldStaffPhp($pdo, $authUser['id'] ?? '', $authUser['email'] ?? '', $authUser['employeeId'] ?? '');
    if (!$verified) {
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'tracked' => false,
            'online' => false,
            'isOnline' => false,
            'message' => 'Non-field staff account; field presence tracking skipped.'
        ]);
        exit;
    }

    $isSharing = isset($body['isSharingLocation']) ? (bool)$body['isSharingLocation'] : false;

    $stmt = $pdo->prepare("
        INSERT INTO `solar_workforce_locations` (
            `user_id`, `employee_code`, `name`, `email`, `role`,
            `is_online`, `is_sharing_location`, `status`, `last_seen_at`
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'online', NOW())
        ON DUPLICATE KEY UPDATE
            `employee_code` = VALUES(`employee_code`),
            `name` = VALUES(`name`),
            `email` = VALUES(`email`),
            `role` = VALUES(`role`),
            `is_online` = 1,
            `is_sharing_location` = VALUES(`is_sharing_location`),
            `status` = CASE
                WHEN `latitude` IS NOT NULL AND `longitude` IS NOT NULL THEN (
                    CASE WHEN `speed` IS NOT NULL AND `speed` > 3 THEN 'moving' ELSE 'idle' END
                )
                ELSE 'online'
            END,
            `last_seen_at` = NOW()
    ");

    $stmt->execute([
        $verified['id'],
        $verified['employeeCode'] ?: null,
        $verified['name'] ?: null,
        $verified['email'] ?: null,
        $verified['role'] ?: null,
        $isSharing ? 1 : 0
    ]);

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'tracked' => true,
        'online' => true,
        'isOnline' => true,
        'userId' => $verified['id'],
        'timestamp' => gmdate('Y-m-d\TH:i:s.000\Z')
    ]);
    exit;
}

// POST /api/presence/offline - Field Worker Logout or Explicit Disconnect
if ($method === 'POST' && in_array($cleanPath, ['/presence/offline', '/presence/offline/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    $authUser = getAuthenticatedUserPhp($pdo);
    if ($authUser) {
        $targetId = $authUser['id'] ?? '';
        $targetEmail = strtolower(trim((string)($authUser['email'] ?? '')));
        try {
            $stmt = $pdo->prepare("
                UPDATE `solar_workforce_locations`
                SET `is_online` = 0, `is_sharing_location` = 0, `status` = 'offline', `last_seen_at` = NOW()
                WHERE `user_id` = ? OR LOWER(`email`) = ?
            ");
            $stmt->execute([$targetId, $targetEmail]);
        } catch (Exception $e) {}
    }

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'online' => false,
        'isOnline' => false,
        'message' => 'User presence set to offline.'
    ]);
    exit;
}

// GET /api/pusher/config & status
if ($method === 'GET' && in_array($cleanPath, ['/pusher/config', '/pusher/config/'])) {
    $key = getenv('PUSHER_APP_KEY') ?: getenv('VITE_PUSHER_APP_KEY') ?: null;
    $cluster = getenv('PUSHER_APP_CLUSTER') ?: getenv('VITE_PUSHER_APP_CLUSTER') ?: 'ap2';
    if ($key) {
        http_response_code(200);
        echo json_encode([
            'configured' => true,
            'key' => $key,
            'cluster' => $cluster,
            'channel' => 'my-channel',
            'event' => 'location.updated'
        ]);
    } else {
        http_response_code(200);
        echo json_encode([
            'configured' => false,
            'key' => null,
            'cluster' => null,
            'channel' => 'my-channel',
            'event' => 'location.updated',
            'error' => 'Pusher public configuration is missing on the server.'
        ]);
    }
    exit;
}

if ($method === 'GET' && in_array($cleanPath, ['/pusher/status', '/pusher/status/'])) {
    $key = getenv('PUSHER_APP_KEY') ?: getenv('VITE_PUSHER_APP_KEY') ?: null;
    $cluster = getenv('PUSHER_APP_CLUSTER') ?: getenv('VITE_PUSHER_APP_CLUSTER') ?: 'ap2';
    http_response_code(200);
    echo json_encode([
        'serverConfigured' => false,
        'publicKeyConfigured' => (bool)$key,
        'clusterConfigured' => (bool)$cluster,
        'cluster' => $cluster ?: null,
        'channel' => 'my-channel',
        'locationEvent' => 'location.updated',
        'presenceEvent' => 'presence.updated'
    ]);
    exit;
}

// ==========================================================
// 29. DIRECT CRM REST ENDPOINTS (LEADS, CUSTOMERS, QUOTATIONS)
// ==========================================================

if (in_array($cleanPath, ['/leads', '/leads/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied: Insufficient privileges.']);
        exit;
    }

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_leads` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $leads = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'customerName' => $r['customer_name'],
                'companyName' => $r['company_name'] ?? '',
                'phone' => $r['phone'],
                'email' => $r['email'] ?? '',
                'address' => $r['address'] ?? '',
                'city' => $r['city'] ?? '',
                'solarCapacityKw' => floatval($r['solar_capacity_kw'] ?? 0),
                'estimatedValue' => floatval($r['estimated_value'] ?? 0),
                'source' => $r['source'] ?? 'Website',
                'assignedSalespersonId' => $r['assigned_salesperson_id'] ?? '',
                'assignedSalespersonName' => $r['assigned_salesperson_name'] ?? '',
                'status' => $r['status'] ?? 'NEW',
                'notes' => $r['notes'] ?? '',
                'nextFollowUpDate' => $r['next_follow_up_date'],
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at']
            ];
        }, $rows ?: []);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($leads), 'data' => $leads]);
        exit;
    }

    if ($method === 'POST') {
        $cName = trim((string)($body['customerName'] ?? $body['customer_name'] ?? ''));
        $cPhone = trim((string)($body['phone'] ?? ''));
        if ($cName === '' || $cPhone === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Lead customerName and phone required.']);
            exit;
        }
        $allowedStatuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE SURVEY', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'];
        if (isset($body['status']) && !in_array((string)$body['status'], $allowedStatuses, true)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid lead status.']);
            exit;
        }
        $saved = saveLeadToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

if (preg_match('#^/leads/([^/]+)/?$#', $cleanPath, $matches)) {
    $leadId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied: Insufficient privileges.']);
        exit;
    }

    if ($method === 'PUT') {
        $existing = fetchExistingRowPhp($pdo, 'solar_leads', $leadId);
        if (!$existing) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Lead not found.']);
            exit;
        }
        $cName = array_key_exists('customerName', $body)
            ? trim((string)($body['customerName'] ?? ''))
            : (array_key_exists('customer_name', $body) ? trim((string)($body['customer_name'] ?? '')) : trim((string)($existing['customer_name'] ?? '')));
        $cPhone = array_key_exists('phone', $body)
            ? trim((string)($body['phone'] ?? ''))
            : trim((string)($existing['phone'] ?? ''));
        if ($cName === '' || $cPhone === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Lead customerName and phone required.']);
            exit;
        }
        $allowedStatuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE SURVEY', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'];
        if (isset($body['status']) && !in_array((string)$body['status'], $allowedStatuses, true)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Invalid lead status.']);
            exit;
        }
        $body['id'] = $leadId;
        $saved = saveLeadToDb($pdo, $body);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }

    if ($method === 'DELETE') {
        deleteItemFromDb($pdo, 'leads', $leadId);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'Lead deleted from MySQL.']);
        exit;
    }
}

if (in_array($cleanPath, ['/customers', '/customers/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_customers` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $customers = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'customerCode' => $r['customer_code'],
                'name' => $r['name'],
                'companyName' => $r['company_name'] ?? '',
                'customerType' => $r['customer_type'] ?? 'Residential',
                'phone' => $r['phone'],
                'email' => $r['email'] ?? '',
                'siteAddress' => $r['site_address'] ?? '',
                'city' => $r['city'] ?? '',
                'state' => $r['state'] ?? 'Gujarat',
                'pincode' => $r['pincode'] ?? '',
                'gstNumber' => $r['gst_number'] ?? '',
                'electricityConsumerNo' => $r['electricity_consumer_no'] ?? '',
                'sanctionedLoadKw' => floatval($r['sanctioned_load_kw'] ?? 0),
                'status' => $r['status'] ?? 'ACTIVE',
                'activeProjectId' => $r['active_project_id'] ?? null,
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at']
            ];
        }, $rows ?: []);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($customers), 'data' => $customers]);
        exit;
    }

    if ($method === 'POST') {
        if (empty($body['name']) || empty($body['phone'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Customer name and phone are required.']);
            exit;
        }
        $saved = saveCustomerToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

if (preg_match('#^/customers/([^/]+)/?$#', $cleanPath, $matches)) {
    $custId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'PUT') {
        $body['id'] = $custId;
        $saved = saveCustomerToDb($pdo, $body);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }

    if ($method === 'DELETE') {
        deleteItemFromDb($pdo, 'customers', $custId);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'Customer deleted from MySQL.']);
        exit;
    }
}

if (in_array($cleanPath, ['/quotations', '/quotations/'])) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_quotations` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll();
        $quotations = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'quotationNumber' => $r['quotation_number'],
                'customerId' => $r['customer_id'],
                'customerName' => $r['customer_name'],
                'projectId' => $r['project_id'],
                'capacityKw' => floatval($r['capacity_kw'] ?? 0),
                'ratePerWp' => floatval($r['rate_per_wp'] ?? 0),
                'baseAmount' => floatval($r['base_amount'] ?? 0),
                'taxAmount' => floatval($r['tax_amount'] ?? 0),
                'panelBrand' => $r['panel_brand'] ?? '',
                'inverterBrand' => $r['inverter_brand'] ?? '',
                'structureType' => $r['structure_type'] ?? '',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'subtotal' => floatval($r['subtotal'] ?? 0),
                'discountAmount' => floatval($r['discount_amount'] ?? 0),
                'gstPercent' => floatval($r['gst_percent'] ?? 13.8),
                'gstAmount' => floatval($r['gst_amount'] ?? 0),
                'totalAmount' => floatval($r['total_amount'] ?? 0),
                'totalProjectCost' => floatval($r['total_amount'] ?? 0),
                'paymentTerms' => $r['payment_terms'] ?? '',
                'warrantyDetails' => $r['warranty_details'] ?? '',
                'termsAndConditions' => $r['terms_and_conditions'] ?? '',
                'status' => $r['status'] ?? 'SENT',
                'validUntil' => $r['valid_until'],
                'validTill' => $r['valid_until'],
                'createdAt' => $r['created_at'],
                'quotationDate' => !empty($r['created_at']) ? substr($r['created_at'], 0, 10) : date('Y-m-d'),
                'acceptedAt' => $r['accepted_at']
            ];
        }, $rows ?: []);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($quotations), 'data' => $quotations]);
        exit;
    }

    if ($method === 'POST') {
        $saved = saveQuotationToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

if (preg_match('#^/quotations/([^/]+)/?$#', $cleanPath, $matches)) {
    $quoteId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'PUT') {
        $body['id'] = $quoteId;
        $saved = saveQuotationToDb($pdo, $body);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }

    if ($method === 'DELETE') {
        deleteItemFromDb($pdo, 'quotations', $quoteId);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'Quotation deleted from MySQL.']);
        exit;
    }
}

// ==========================================================
// SERVICE & AMC TICKETING REST ENDPOINTS (ADMIN AUTHORIZED)
// ==========================================================

// GET /api/service-tickets/technicians (Admin Only - Active Eligible Field Workers/Technicians)
if ($method === 'GET' && in_array($cleanPath, ['/service-tickets/technicians', '/service-tickets/technicians/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    requireAdminUserPhp($pdo);
    $techs = getEligibleServiceTechniciansPhp($pdo);
    http_response_code(200);
    echo json_encode(['success' => true, 'count' => count($techs), 'data' => $techs]);
    exit;
}

// GET|POST /api/service-tickets
if (in_array($cleanPath, ['/service-tickets', '/service-tickets/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    $isCust = (strtoupper((string)($actor['accountType'] ?? '')) === 'CUSTOMER') || in_array(strtolower((string)($actor['role'] ?? '')), ['customer', 'client'], true);
    $isActorAdmin = in_array(strtoupper(trim((string)($actor['role'] ?? ''))), ['ADMIN', 'SUPER ADMIN'], true);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_service_tickets` ORDER BY `created_at` DESC');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $historyByTicket = [];
        try {
            $hStmt = $pdo->query('SELECT * FROM `solar_service_ticket_history` ORDER BY `created_at` DESC, `id` DESC');
            foreach (($hStmt ? $hStmt->fetchAll(PDO::FETCH_ASSOC) : []) as $h) {
                $k = (string)($h['ticket_record_id'] ?? '');
                if (!isset($historyByTicket[$k])) $historyByTicket[$k] = [];
                $historyByTicket[$k][] = mapTicketHistoryRowPhp($h);
            }
        } catch (Exception $e) {}

        $items = array_map(function ($r) use ($historyByTicket) {
            return mapServiceTicketRowPhp($r, $historyByTicket[$r['id']] ?? []);
        }, $rows);

        if ($isCust) {
            $custId = trim((string)($actor['customerId'] ?? $actor['linkedEntityId'] ?? ''));
            $custName = strtolower(trim((string)($actor['name'] ?? '')));
            $items = array_values(array_filter($items, function ($t) use ($custId, $custName) {
                return ($custId !== '' && $t['customerId'] === $custId) || ($custName !== '' && strtolower(trim((string)$t['customerName'])) === $custName);
            }));
        }

        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $tk = $body;
        if (empty($tk['id'])) $tk['id'] = 'srv-' . round(microtime(true) * 1000);
        if (!$isActorAdmin) {
            $tk['status'] = 'OPEN';
            $tk['assignedTechnicianId'] = '';
            $tk['assignedTechnicianName'] = '';
            $tk['assignedToName'] = 'Unassigned';
            if ($isCust && !empty($actor['customerId'] ?? $actor['linkedEntityId'] ?? '')) {
                $tk['customerId'] = $actor['customerId'] ?? $actor['linkedEntityId'];
                $tk['customerName'] = $tk['customerName'] ?? ($actor['name'] ?? 'Customer');
            }
        } elseif (!empty($tk['assignedTechnicianId'])) {
            $eligible = getEligibleServiceTechniciansPhp($pdo);
            $matched = null;
            foreach ($eligible as $t) {
                if (strcasecmp($t['id'], (string)$tk['assignedTechnicianId']) === 0) {
                    $matched = $t;
                    break;
                }
            }
            if (!$matched) {
                http_response_code(400);
                echo json_encode(['success' => false, 'message' => 'Selected technician is not an active eligible Field Worker / Technician.']);
                exit;
            }
            $tk['assignedTechnicianId'] = $matched['id'];
            $tk['assignedTechnicianName'] = $matched['name'];
            if (empty($tk['status']) || $tk['status'] === 'OPEN') {
                $tk['status'] = 'ASSIGNED';
            }
        }
        $saved = saveServiceTicketToDb($pdo, $tk, $actor);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|POST /api/service-tickets/{id}/assign (Admin Only)
if (in_array($method, ['PUT', 'POST'], true) && preg_match('#^/service-tickets/([^/]+)/assign/?$#', $cleanPath, $matches)) {
    $tktId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);
    try {
        $updated = assignServiceTicketTechnicianPhp($pdo, $tktId, $body, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $updated, 'message' => 'Technician assignment updated in MySQL.']);
        exit;
    } catch (Exception $e) {
        $code = $e->getCode();
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        exit;
    }
}

// PUT|PATCH /api/service-tickets/{id}/admin-update (Admin Only)
if (in_array($method, ['PUT', 'PATCH'], true) && preg_match('#^/service-tickets/([^/]+)/admin-update/?$#', $cleanPath, $matches)) {
    $tktId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);
    try {
        $updated = adminUpdateServiceTicketPhp($pdo, $tktId, $body, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $updated, 'message' => 'Service ticket updated in MySQL.']);
        exit;
    } catch (Exception $e) {
        $code = $e->getCode();
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        exit;
    }
}

// GET /api/service-tickets/{id}/details or GET|PUT|DELETE /api/service-tickets/{id}
if (preg_match('#^/service-tickets/([^/]+)(?:/details)?/?$#', $cleanPath, $matches)) {
    $tktId = urldecode($matches[1]);
    if (!in_array($tktId, ['import', 'technicians'], true)) {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);

        if ($method === 'GET') {
            $actor = requireAuthUserPhp($pdo);
            $details = getServiceTicketDetailsPhp($pdo, $tktId);
            if (!$details) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Service ticket not found.']);
                exit;
            }
            $isCust = (strtoupper((string)($actor['accountType'] ?? '')) === 'CUSTOMER') || in_array(strtolower((string)($actor['role'] ?? '')), ['customer', 'client'], true);
            if ($isCust) {
                $custId = trim((string)($actor['customerId'] ?? $actor['linkedEntityId'] ?? ''));
                $custName = strtolower(trim((string)($actor['name'] ?? '')));
                $owns = ($custId !== '' && $details['customerId'] === $custId) || ($custName !== '' && strtolower(trim((string)$details['customerName'])) === $custName);
                if (!$owns) {
                    http_response_code(403);
                    echo json_encode(['success' => false, 'message' => 'Access denied: You can only view your own service tickets.']);
                    exit;
                }
            }
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $details]);
            exit;
        }

        if ($method === 'PUT') {
            $actor = requireAdminUserPhp($pdo);
            try {
                $updated = adminUpdateServiceTicketPhp($pdo, $tktId, $body, $actor);
                http_response_code(200);
                echo json_encode(['success' => true, 'data' => $updated, 'message' => 'Service ticket updated in MySQL.']);
                exit;
            } catch (Exception $e) {
                $code = $e->getCode();
                http_response_code(($code >= 400 && $code < 600) ? $code : 400);
                echo json_encode(['success' => false, 'message' => $e->getMessage()]);
                exit;
            }
        }

        if ($method === 'DELETE') {
            $actor = requireAdminUserPhp($pdo);
            deleteItemFromDb($pdo, 'service_tickets', $tktId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Service ticket deleted from MySQL.']);
            exit;
        }
    }
}

// ==========================================================
// GMAIL SMTP CONFIGURATION (STRICT ADMIN ONLY) & APP EMAIL
// ==========================================================

function deriveEmailEncryptionKeyPhp($config) {
    $secretMaterial = !empty($config['emailEncryptionKey'])
        ? $config['emailEncryptionKey']
        : (!empty($config['sessionSecret']) ? $config['sessionSecret'] : 'rejoy-solar-epc-erp-email-kms-2026');
    return hash('sha256', (string)$secretMaterial, true);
}

function encryptEmailSecretPhp($plaintext, $config) {
    if (!function_exists('openssl_encrypt')) {
        throw new Exception('PHP OpenSSL extension is required for encrypted credential storage.');
    }
    $key = deriveEmailEncryptionKeyPhp($config);
    $ivBytes = random_bytes(12);
    $tag = '';
    $encrypted = openssl_encrypt((string)$plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $ivBytes, $tag, '', 16);
    if ($encrypted === false || strlen($tag) !== 16) {
        throw new Exception('Failed to encrypt Gmail App Password.');
    }
    return [
        'ciphertext' => base64_encode($encrypted),
        'iv' => bin2hex($ivBytes),
        'authTag' => bin2hex($tag)
    ];
}

function decryptEmailSecretPhp($ciphertext, $ivHex, $authTagHex, $config) {
    if (!function_exists('openssl_decrypt')) {
        throw new Exception('PHP OpenSSL extension is required for SMTP credential decryption.');
    }
    $key = deriveEmailEncryptionKeyPhp($config);
    $rawCipher = base64_decode((string)$ciphertext, true);
    $iv = @hex2bin((string)$ivHex);
    $tag = @hex2bin((string)$authTagHex);
    if ($rawCipher === false || $iv === false || $tag === false) {
        throw new Exception('Stored Gmail credentials are malformed and must be re-saved by an Administrator.');
    }
    $decrypted = openssl_decrypt($rawCipher, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    if ($decrypted === false) {
        throw new Exception('Unable to decrypt stored Gmail App Password. Please re-enter and save your App Password.');
    }
    return $decrypted;
}

function normalizeAppPasswordPhp($raw) {
    return trim(preg_replace('/\s+/', '', (string)($raw ?? '')));
}

function isValidEmailAddressPhp($email) {
    $trimmed = trim((string)$email);
    if (empty($trimmed) || preg_match('/[\r\n<>]/', $trimmed)) return false;
    return (bool)preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $trimmed);
}

function sanitizeEmailSettingsPhp($row) {
    if (!$row) {
        return [
            'configured' => false,
            'hasAppPassword' => false,
            'gmailAddress' => '',
            'smtpHost' => 'smtp.gmail.com',
            'smtpPort' => 587,
            'smtpSecurity' => 'TLS',
            'senderName' => 'Rejoy Solar ERP',
            'enabled' => true,
            'lastTestedAt' => null,
            'lastTestStatus' => null,
            'lastTestMessage' => null,
            'updatedBy' => null,
            'updatedAt' => null
        ];
    }

    $security = strtoupper((string)($row['smtp_security'] ?? 'TLS')) === 'SSL' ? 'SSL' : 'TLS';
    $hasPassword = !empty($row['encrypted_app_password']) && !empty($row['iv']) && !empty($row['auth_tag']);
    $updatedAtIso = null;
    if (!empty($row['updated_at'])) {
        $ts = strtotime((string)$row['updated_at']);
        $updatedAtIso = $ts !== false ? gmdate('Y-m-d\TH:i:s.000\Z', $ts) : (string)$row['updated_at'];
    }

    return [
        'configured' => !empty($row['gmail_address']) && $hasPassword,
        'hasAppPassword' => $hasPassword,
        'gmailAddress' => (string)($row['gmail_address'] ?? ''),
        'smtpHost' => !empty($row['smtp_host']) ? (string)$row['smtp_host'] : 'smtp.gmail.com',
        'smtpPort' => !empty($row['smtp_port']) ? (int)$row['smtp_port'] : ($security === 'SSL' ? 465 : 587),
        'smtpSecurity' => $security,
        'senderName' => !empty($row['sender_name']) ? (string)$row['sender_name'] : 'Rejoy Solar ERP',
        'enabled' => ((int)($row['enabled'] ?? 1)) === 1,
        'lastTestedAt' => $row['last_tested_at'] ?? null,
        'lastTestStatus' => $row['last_test_status'] ?? null,
        'lastTestMessage' => $row['last_test_message'] ?? null,
        'updatedBy' => $row['updated_by'] ?? null,
        'updatedAt' => $updatedAtIso
    ];
}

function validateEmailConfigPhp($body, $hasExistingPassword) {
    $gmailAddress = strtolower(trim((string)($body['gmailAddress'] ?? '')));
    if (empty($gmailAddress) || !isValidEmailAddressPhp($gmailAddress)) {
        return ['valid' => false, 'error' => 'Please enter a valid Gmail email address.'];
    }

    $smtpSecurity = strtoupper(trim((string)($body['smtpSecurity'] ?? 'TLS'))) === 'SSL' ? 'SSL' : 'TLS';
    $smtpHost = trim((string)($body['smtpHost'] ?? 'smtp.gmail.com')) ?: 'smtp.gmail.com';
    if (!preg_match('/^[a-zA-Z0-9.-]+$/', $smtpHost)) {
        return ['valid' => false, 'error' => 'Invalid SMTP host format (use e.g. smtp.gmail.com).'];
    }

    $defaultPort = ($smtpSecurity === 'SSL') ? 465 : 587;
    $rawPort = $body['smtpPort'] ?? null;
    $smtpPort = ($rawPort !== null && trim((string)$rawPort) !== '') ? (int)$rawPort : $defaultPort;
    if ($smtpPort < 1 || $smtpPort > 65535 || (is_string($rawPort) && trim($rawPort) !== '' && !is_numeric($rawPort))) {
        return ['valid' => false, 'error' => 'SMTP port must be a valid integer between 1 and 65535.'];
    }

    $senderName = trim((string)($body['senderName'] ?? '')) ?: 'Rejoy Solar ERP';
    if (strlen($senderName) > 150) {
        return ['valid' => false, 'error' => 'Sender name must be 150 characters or fewer.'];
    }

    $normalizedPassword = array_key_exists('appPassword', $body) ? normalizeAppPasswordPhp($body['appPassword']) : '';
    if (empty($normalizedPassword) && !$hasExistingPassword) {
        return [
            'valid' => false,
            'error' => 'Gmail App Password is required. Generate a 16-character App Password in your Google Account Security settings.'
        ];
    }
    if (!empty($normalizedPassword) && strlen($normalizedPassword) < 8) {
        return [
            'valid' => false,
            'error' => 'Gmail App Password appears too short. Please enter a valid Google App Password.'
        ];
    }

    $enabled = array_key_exists('enabled', $body) ? (bool)$body['enabled'] : true;

    $data = [
        'gmailAddress' => $gmailAddress,
        'smtpHost' => $smtpHost,
        'smtpPort' => $smtpPort,
        'smtpSecurity' => $smtpSecurity,
        'senderName' => $senderName,
        'enabled' => $enabled
    ];
    if (!empty($normalizedPassword)) {
        $data['appPassword'] = $normalizedPassword;
    }

    return ['valid' => true, 'data' => $data];
}

function getEmailSettingsInternalPhp($pdo) {
    $stmt = $pdo->prepare("SELECT * FROM `solar_email_settings` WHERE `id` = 'default_gmail_smtp' LIMIT 1");
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function saveEmailSettingsPhp($pdo, $params) {
    $stmt = $pdo->prepare("
        INSERT INTO `solar_email_settings` (
            `id`, `gmail_address`, `smtp_host`, `smtp_port`, `smtp_security`,
            `sender_name`, `encrypted_app_password`, `iv`, `auth_tag`, `enabled`, `updated_by`
        ) VALUES ('default_gmail_smtp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            `gmail_address` = VALUES(`gmail_address`),
            `smtp_host` = VALUES(`smtp_host`),
            `smtp_port` = VALUES(`smtp_port`),
            `smtp_security` = VALUES(`smtp_security`),
            `sender_name` = VALUES(`sender_name`),
            `encrypted_app_password` = VALUES(`encrypted_app_password`),
            `iv` = VALUES(`iv`),
            `auth_tag` = VALUES(`auth_tag`),
            `enabled` = VALUES(`enabled`),
            `updated_by` = VALUES(`updated_by`)
    ");
    $stmt->execute([
        $params['gmailAddress'],
        $params['smtpHost'],
        (int)$params['smtpPort'],
        $params['smtpSecurity'],
        $params['senderName'],
        $params['encryptedAppPassword'],
        $params['iv'],
        $params['authTag'],
        !empty($params['enabled']) ? 1 : 0,
        $params['updatedBy']
    ]);
    return sanitizeEmailSettingsPhp(getEmailSettingsInternalPhp($pdo));
}

function updateEmailTestStatusPhp($pdo, $status, $message, $testedAt = null) {
    $ts = $testedAt ?: gmdate('Y-m-d\TH:i:s.000\Z');
    $stmt = $pdo->prepare("
        UPDATE `solar_email_settings`
        SET `last_tested_at` = ?, `last_test_status` = ?, `last_test_message` = ?
        WHERE `id` = 'default_gmail_smtp'
    ");
    $stmt->execute([$ts, $status, substr((string)$message, 0, 1000)]);
    return sanitizeEmailSettingsPhp(getEmailSettingsInternalPhp($pdo));
}

function deleteEmailSettingsPhp($pdo) {
    $pdo->exec("DELETE FROM `solar_email_settings` WHERE `id` = 'default_gmail_smtp'");
    return true;
}

function formatSmtpErrorPhp($rawMessage) {
    $raw = (string)($rawMessage ?: 'Unknown SMTP error');
    if (
        stripos($raw, '535') !== false ||
        stripos($raw, '534') !== false ||
        stripos($raw, 'username and password not accepted') !== false ||
        stripos($raw, 'invalid login') !== false ||
        stripos($raw, 'application-specific password required') !== false ||
        stripos($raw, 'authentication failed') !== false
    ) {
        return 'Gmail SMTP authentication failed (535). Please verify your Gmail address and use a 16-character Google App Password (regular Gmail passwords are rejected by Google SMTP).';
    }
    if (stripos($raw, 'timed out') !== false || stripos($raw, 'timeout') !== false) {
        return 'SMTP server connection timed out. Check your SMTP host, port, and TLS/SSL security setting.';
    }
    if (stripos($raw, 'could not resolve') !== false || stripos($raw, 'name or service not known') !== false || stripos($raw, 'getaddrinfo') !== false) {
        return 'SMTP hostname could not be resolved. Please verify the SMTP host (default: smtp.gmail.com).';
    }
    if (stripos($raw, 'connection refused') !== false || stripos($raw, 'unable to connect') !== false || stripos($raw, 'failed to open') !== false) {
        return 'Unable to connect to the SMTP server. Verify SMTP host, port (587 for TLS / 465 for SSL), and outbound firewall rules.';
    }
    if (stripos($raw, 'recipient') !== false || stripos($raw, 'rcpt') !== false) {
        return 'Invalid recipient or sender address rejected by SMTP server: ' . substr($raw, 0, 220);
    }
    $clean = preg_replace('/pass(word)?[:=]\s*\S+/i', 'password=[REDACTED]', $raw);
    return substr((string)$clean, 0, 300);
}

function smtpReadResponsePhp($fp) {
    $fullResponse = '';
    $code = 0;
    while (!feof($fp)) {
        $line = fgets($fp, 4096);
        if ($line === false) {
            $meta = stream_get_meta_data($fp);
            if (!empty($meta['timed_out'])) {
                throw new Exception('SMTP read timed out waiting for server response.');
            }
            break;
        }
        $fullResponse .= $line;
        if (preg_match('/^(\d{3})([ -])/', $line, $m)) {
            $code = (int)$m[1];
            if ($m[2] === ' ') {
                break;
            }
        } else {
            break;
        }
    }
    return ['code' => $code, 'message' => trim($fullResponse)];
}

function smtpExpectPhp($fp, $expectedCodes, $command = null) {
    if ($command !== null) {
        $written = fwrite($fp, $command . "\r\n");
        if ($written === false) {
            throw new Exception('Failed to write command to SMTP socket.');
        }
    }
    $res = smtpReadResponsePhp($fp);
    if (!in_array($res['code'], (array)$expectedCodes, true)) {
        throw new Exception($res['message'] ?: ('Unexpected SMTP response code ' . $res['code']));
    }
    return $res;
}

function encodeMimeHeaderPhp($value) {
    $clean = trim(preg_replace('/[\r\n]+/', ' ', (string)$value));
    if (preg_match('/[^\x20-\x7E]/', $clean)) {
        return '=?UTF-8?B?' . base64_encode($clean) . '?=';
    }
    return $clean;
}

function formatFromHeaderPhp($senderName, $gmailAddress) {
    $cleanName = trim(preg_replace('/["\r\n<>]/', '', (string)($senderName ?: 'Rejoy Solar ERP')));
    return $cleanName ? '"' . encodeMimeHeaderPhp($cleanName) . '" <' . $gmailAddress . '>' : $gmailAddress;
}

function sendSmtpEmailPhp($smtpConfig, $decryptedPassword, $mail) {
    $host = trim((string)($smtpConfig['smtpHost'] ?? 'smtp.gmail.com'));
    $port = (int)($smtpConfig['smtpPort'] ?? 587);
    $security = strtoupper((string)($smtpConfig['smtpSecurity'] ?? 'TLS')) === 'SSL' ? 'SSL' : 'TLS';
    $username = trim((string)$smtpConfig['gmailAddress']);
    $senderName = (string)($smtpConfig['senderName'] ?? 'Rejoy Solar ERP');
    $isSsl = ($security === 'SSL' || $port === 465);

    $toList = array_values(array_filter(array_map('trim', (array)($mail['to'] ?? []))));
    $ccList = array_values(array_filter(array_map('trim', (array)($mail['cc'] ?? []))));
    $bccList = array_values(array_filter(array_map('trim', (array)($mail['bcc'] ?? []))));
    $allRecipients = array_values(array_unique(array_merge($toList, $ccList, $bccList)));
    if (empty($toList) || empty($allRecipients)) {
        throw new Exception('At least one valid recipient email address is required.');
    }

    $remote = ($isSsl ? 'ssl://' : 'tcp://') . $host . ':' . $port;
    $ctx = stream_context_create([
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'allow_self_signed' => false,
            'SNI_enabled' => true,
            'peer_name' => $host
        ]
    ]);

    $errno = 0;
    $errstr = '';
    $fp = @stream_socket_client($remote, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) {
        throw new Exception("Unable to connect to SMTP server ({$host}:{$port}): {$errstr} ({$errno})");
    }
    stream_set_timeout($fp, 20);

    try {
        $ehloHost = preg_replace('/[^a-zA-Z0-9.-]/', '', (string)($_SERVER['HTTP_HOST'] ?? gethostname() ?: 'localhost')) ?: 'localhost';

        smtpExpectPhp($fp, [220]);
        $ehloRes = smtpExpectPhp($fp, [250], "EHLO {$ehloHost}");

        if (!$isSsl) {
            smtpExpectPhp($fp, [220], 'STARTTLS');
            $cryptoMethod = STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT;
            if (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT')) {
                $cryptoMethod |= STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT;
            }
            $cryptoOk = @stream_socket_enable_crypto($fp, true, $cryptoMethod);
            if ($cryptoOk !== true) {
                throw new Exception('Failed to negotiate TLS encryption with SMTP server.');
            }
            $ehloRes = smtpExpectPhp($fp, [250], "EHLO {$ehloHost}");
        }

        // Authenticate using AUTH LOGIN (or AUTH PLAIN fallback)
        if (stripos($ehloRes['message'], 'PLAIN') !== false && stripos($ehloRes['message'], 'LOGIN') === false) {
            $authToken = base64_encode("\0" . $username . "\0" . $decryptedPassword);
            smtpExpectPhp($fp, [235], 'AUTH PLAIN ' . $authToken);
        } else {
            smtpExpectPhp($fp, [334], 'AUTH LOGIN');
            smtpExpectPhp($fp, [334], base64_encode($username));
            smtpExpectPhp($fp, [235], base64_encode($decryptedPassword));
        }

        smtpExpectPhp($fp, [250], 'MAIL FROM:<' . $username . '>');
        foreach ($allRecipients as $rcpt) {
            smtpExpectPhp($fp, [250, 251], 'RCPT TO:<' . $rcpt . '>');
        }

        smtpExpectPhp($fp, [354], 'DATA');

        $domainPart = strpos($username, '@') !== false ? substr($username, strpos($username, '@') + 1) : 'rejoysolar.local';
        $messageId = '<' . bin2hex(random_bytes(12)) . '.' . time() . '@' . $domainPart . '>';

        $headers = [
            'Date: ' . gmdate('D, d M Y H:i:s +0000'),
            'From: ' . formatFromHeaderPhp($senderName, $username),
            'To: ' . implode(', ', $toList),
            'Subject: ' . encodeMimeHeaderPhp((string)$mail['subject']),
            'Message-ID: ' . $messageId,
            'MIME-Version: 1.0'
        ];
        if (!empty($ccList)) {
            $headers[] = 'Cc: ' . implode(', ', $ccList);
        }
        if (!empty($mail['replyTo']) && isValidEmailAddressPhp($mail['replyTo'])) {
            $headers[] = 'Reply-To: ' . trim((string)$mail['replyTo']);
        }

        $textBody = (string)($mail['text'] ?? '');
        $htmlBody = (string)($mail['html'] ?? '');
        $attachments = is_array($mail['attachments'] ?? null) ? $mail['attachments'] : [];

        $bodyChunks = [];
        if (!empty($attachments)) {
            $mixedBoundary = '=_Mixed_' . bin2hex(random_bytes(10));
            $altBoundary = '=_Alt_' . bin2hex(random_bytes(10));
            $headers[] = 'Content-Type: multipart/mixed; boundary="' . $mixedBoundary . '"';

            $bodyChunks[] = '--' . $mixedBoundary;
            if (!empty($textBody) && !empty($htmlBody)) {
                $bodyChunks[] = 'Content-Type: multipart/alternative; boundary="' . $altBoundary . '"';
                $bodyChunks[] = '';
                $bodyChunks[] = '--' . $altBoundary;
                $bodyChunks[] = 'Content-Type: text/plain; charset=UTF-8';
                $bodyChunks[] = 'Content-Transfer-Encoding: base64';
                $bodyChunks[] = '';
                $bodyChunks[] = chunk_split(base64_encode($textBody));
                $bodyChunks[] = '--' . $altBoundary;
                $bodyChunks[] = 'Content-Type: text/html; charset=UTF-8';
                $bodyChunks[] = 'Content-Transfer-Encoding: base64';
                $bodyChunks[] = '';
                $bodyChunks[] = chunk_split(base64_encode($htmlBody));
                $bodyChunks[] = '--' . $altBoundary . '--';
            } elseif (!empty($htmlBody)) {
                $bodyChunks[] = 'Content-Type: text/html; charset=UTF-8';
                $bodyChunks[] = 'Content-Transfer-Encoding: base64';
                $bodyChunks[] = '';
                $bodyChunks[] = chunk_split(base64_encode($htmlBody));
            } else {
                $bodyChunks[] = 'Content-Type: text/plain; charset=UTF-8';
                $bodyChunks[] = 'Content-Transfer-Encoding: base64';
                $bodyChunks[] = '';
                $bodyChunks[] = chunk_split(base64_encode($textBody));
            }

            foreach ($attachments as $att) {
                $attName = preg_replace('/["\r\n\\\\\/]/', '_', (string)($att['filename'] ?? 'attachment.bin'));
                $attType = preg_replace('/[\r\n]/', '', (string)($att['contentType'] ?? 'application/octet-stream'));
                $attEnc = strtolower((string)($att['encoding'] ?? 'base64'));
                $attContent = (string)($att['content'] ?? '');
                $attBase64 = ($attEnc === 'base64') ? $attContent : base64_encode($attContent);
                $bodyChunks[] = '--' . $mixedBoundary;
                $bodyChunks[] = 'Content-Type: ' . $attType . '; name="' . $attName . '"';
                $bodyChunks[] = 'Content-Disposition: attachment; filename="' . $attName . '"';
                $bodyChunks[] = 'Content-Transfer-Encoding: base64';
                $bodyChunks[] = '';
                $bodyChunks[] = chunk_split(preg_replace('/\s+/', '', $attBase64));
            }
            $bodyChunks[] = '--' . $mixedBoundary . '--';
        } elseif (!empty($textBody) && !empty($htmlBody)) {
            $altBoundary = '=_Alt_' . bin2hex(random_bytes(10));
            $headers[] = 'Content-Type: multipart/alternative; boundary="' . $altBoundary . '"';
            $bodyChunks[] = '--' . $altBoundary;
            $bodyChunks[] = 'Content-Type: text/plain; charset=UTF-8';
            $bodyChunks[] = 'Content-Transfer-Encoding: base64';
            $bodyChunks[] = '';
            $bodyChunks[] = chunk_split(base64_encode($textBody));
            $bodyChunks[] = '--' . $altBoundary;
            $bodyChunks[] = 'Content-Type: text/html; charset=UTF-8';
            $bodyChunks[] = 'Content-Transfer-Encoding: base64';
            $bodyChunks[] = '';
            $bodyChunks[] = chunk_split(base64_encode($htmlBody));
            $bodyChunks[] = '--' . $altBoundary . '--';
        } elseif (!empty($htmlBody)) {
            $headers[] = 'Content-Type: text/html; charset=UTF-8';
            $headers[] = 'Content-Transfer-Encoding: base64';
            $bodyChunks[] = chunk_split(base64_encode($htmlBody));
        } else {
            $headers[] = 'Content-Type: text/plain; charset=UTF-8';
            $headers[] = 'Content-Transfer-Encoding: base64';
            $bodyChunks[] = chunk_split(base64_encode($textBody));
        }

        $rawMessage = implode("\r\n", $headers) . "\r\n\r\n" . implode("\r\n", $bodyChunks);
        $rawMessage = preg_replace('/\r\n?|\n/', "\r\n", $rawMessage);
        // RFC 5321 dot-stuffing
        $rawMessage = preg_replace('/^\./m', '..', $rawMessage);

        fwrite($fp, $rawMessage . "\r\n.\r\n");
        smtpExpectPhp($fp, [250]);
        @fwrite($fp, "QUIT\r\n");
        @fclose($fp);

        return [
            'messageId' => $messageId,
            'accepted' => $toList,
            'sentAt' => gmdate('Y-m-d\TH:i:s.000\Z')
        ];
    } catch (Exception $e) {
        @fwrite($fp, "QUIT\r\n");
        @fclose($fp);
        throw $e;
    }
}

// GET|POST|PUT|DELETE /api/settings/email
if (in_array($cleanPath, ['/settings/email', '/settings/email/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $admin = requireAdminUserPhp($pdo);

    if ($method === 'GET') {
        $row = getEmailSettingsInternalPhp($pdo);
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'data' => sanitizeEmailSettingsPhp($row)
        ]);
        exit;
    }

    if ($method === 'POST' || $method === 'PUT') {
        $existing = getEmailSettingsInternalPhp($pdo);
        $hasExistingPassword = !empty($existing['encrypted_app_password']) && !empty($existing['iv']) && !empty($existing['auth_tag']);
        $validation = validateEmailConfigPhp($body, $hasExistingPassword);
        if (empty($validation['valid'])) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => $validation['error']]);
            exit;
        }

        $valData = $validation['data'];
        $encryptedAppPassword = $existing['encrypted_app_password'] ?? '';
        $iv = $existing['iv'] ?? '';
        $authTag = $existing['auth_tag'] ?? '';

        if (!empty($valData['appPassword'])) {
            $enc = encryptEmailSecretPhp($valData['appPassword'], $dbConfig);
            $encryptedAppPassword = $enc['ciphertext'];
            $iv = $enc['iv'];
            $authTag = $enc['authTag'];
        }

        $updatedBy = (string)($admin['email'] ?? $admin['name'] ?? $admin['id'] ?? 'Admin');
        $saved = saveEmailSettingsPhp($pdo, [
            'gmailAddress' => $valData['gmailAddress'],
            'smtpHost' => $valData['smtpHost'],
            'smtpPort' => $valData['smtpPort'],
            'smtpSecurity' => $valData['smtpSecurity'],
            'senderName' => $valData['senderName'],
            'encryptedAppPassword' => $encryptedAppPassword,
            'iv' => $iv,
            'authTag' => $authTag,
            'enabled' => $valData['enabled'],
            'updatedBy' => $updatedBy
        ]);

        http_response_code(200);
        echo json_encode([
            'success' => true,
            'message' => 'Gmail SMTP configuration saved securely to MySQL.',
            'data' => $saved
        ]);
        exit;
    }

    if ($method === 'DELETE') {
        deleteEmailSettingsPhp($pdo);
        $data = sanitizeEmailSettingsPhp(getEmailSettingsInternalPhp($pdo));
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'message' => 'Gmail SMTP credentials removed from MySQL.',
            'data' => $data
        ]);
        exit;
    }
}

// POST /api/settings/email/test
if ($method === 'POST' && in_array($cleanPath, ['/settings/email/test', '/settings/email/test/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $admin = requireAdminUserPhp($pdo);

    $stored = getEmailSettingsInternalPhp($pdo);
    $gmailAddress = strtolower(trim((string)($body['gmailAddress'] ?? ($stored['gmail_address'] ?? ''))));
    $smtpSecurity = strtoupper(trim((string)($body['smtpSecurity'] ?? ($stored['smtp_security'] ?? 'TLS')))) === 'SSL' ? 'SSL' : 'TLS';
    $smtpHost = trim((string)($body['smtpHost'] ?? ($stored['smtp_host'] ?? 'smtp.gmail.com'))) ?: 'smtp.gmail.com';
    $smtpPort = (int)($body['smtpPort'] ?? ($stored['smtp_port'] ?? ($smtpSecurity === 'SSL' ? 465 : 587)));
    $senderName = trim((string)($body['senderName'] ?? ($stored['sender_name'] ?? 'Rejoy Solar ERP'))) ?: 'Rejoy Solar ERP';
    $recipientEmail = trim((string)($body['testRecipient'] ?? ($gmailAddress ?: ($admin['email'] ?? ''))));

    if (!isValidEmailAddressPhp($gmailAddress)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Please enter a valid Gmail email address before testing.']);
        exit;
    }
    if (!isValidEmailAddressPhp($recipientEmail)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Please enter a valid test recipient email address.']);
        exit;
    }

    $decryptedPassword = !empty($body['appPassword']) ? normalizeAppPasswordPhp($body['appPassword']) : '';
    if (empty($decryptedPassword) && !empty($stored['encrypted_app_password']) && !empty($stored['iv']) && !empty($stored['auth_tag'])) {
        try {
            $decryptedPassword = decryptEmailSecretPhp($stored['encrypted_app_password'], $stored['iv'], $stored['auth_tag'], $dbConfig);
        } catch (Exception $e) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
            exit;
        }
    }

    if (empty($decryptedPassword)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Gmail App Password is required to send a test email.']);
        exit;
    }

    $requestedBy = (string)($admin['name'] ?? $admin['email'] ?? 'Admin');
    $sentAtPreview = gmdate('Y-m-d\TH:i:s.000\Z');
    $safeSender = htmlspecialchars($senderName, ENT_QUOTES, 'UTF-8');
    $safeGmail = htmlspecialchars($gmailAddress, ENT_QUOTES, 'UTF-8');
    $safeHost = htmlspecialchars($smtpHost, ENT_QUOTES, 'UTF-8');
    $safeReqBy = htmlspecialchars($requestedBy, ENT_QUOTES, 'UTF-8');

    try {
        $result = sendSmtpEmailPhp(
            [
                'gmailAddress' => $gmailAddress,
                'smtpHost' => $smtpHost,
                'smtpPort' => $smtpPort,
                'smtpSecurity' => $smtpSecurity,
                'senderName' => $senderName
            ],
            $decryptedPassword,
            [
                'to' => [$recipientEmail],
                'subject' => 'Rejoy Solar ERP — Gmail SMTP Configuration Test',
                'text' => implode("\n", [
                    'Rejoy Solar EPC ERP — Gmail SMTP Verification',
                    '',
                    'Your Gmail SMTP configuration has been verified and is active.',
                    "Sender Name: {$senderName}",
                    "From Address: {$gmailAddress}",
                    "SMTP Host: {$smtpHost}:{$smtpPort} ({$smtpSecurity})",
                    "Triggered By: {$requestedBy}",
                    "Timestamp (UTC): {$sentAtPreview}"
                ]),
                'html' => "
                    <div style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;\">
                      <div style=\"background: #0f172a; color: #ffffff; padding: 20px 24px;\">
                        <h2 style=\"margin: 0; font-size: 18px; color: #f59e0b;\">Rejoy Solar ERP — Email Verified</h2>
                        <p style=\"margin: 4px 0 0; font-size: 12px; color: #cbd5e1;\">Gmail SMTP Configuration Test Successful</p>
                      </div>
                      <div style=\"padding: 20px 24px; color: #1e293b; font-size: 14px; line-height: 1.6;\">
                        <p style=\"margin-top: 0;\">Your ERP application email gateway is connected and working correctly.</p>
                        <table style=\"width: 100%; border-collapse: collapse; font-size: 13px; background: #f8fafc; border-radius: 8px;\">
                          <tr><td style=\"padding: 8px 12px; color: #64748b;\">Sender Name</td><td style=\"padding: 8px 12px; font-weight: 600;\">{$safeSender}</td></tr>
                          <tr><td style=\"padding: 8px 12px; color: #64748b;\">Gmail Address</td><td style=\"padding: 8px 12px; font-weight: 600;\">{$safeGmail}</td></tr>
                          <tr><td style=\"padding: 8px 12px; color: #64748b;\">SMTP Server</td><td style=\"padding: 8px 12px; font-family: monospace;\">{$safeHost}:{$smtpPort} ({$smtpSecurity})</td></tr>
                          <tr><td style=\"padding: 8px 12px; color: #64748b;\">Tested By</td><td style=\"padding: 8px 12px;\">{$safeReqBy}</td></tr>
                        </table>
                        <p style=\"margin-bottom: 0; margin-top: 16px; font-size: 12px; color: #64748b;\">Sent at {$sentAtPreview}</p>
                      </div>
                    </div>
                "
            ]
        );

        $latestSanitized = null;
        if ($stored) {
            $latestSanitized = updateEmailTestStatusPhp(
                $pdo,
                'SUCCESS',
                "Test email delivered to {$recipientEmail} (Message ID: {$result['messageId']})",
                $result['sentAt']
            );
        }

        http_response_code(200);
        echo json_encode([
            'success' => true,
            'message' => "Test email sent successfully to {$recipientEmail}.",
            'data' => [
                'messageId' => $result['messageId'],
                'sentAt' => $result['sentAt'],
                'recipientEmail' => $recipientEmail,
                'settings' => $latestSanitized
            ]
        ]);
        exit;
    } catch (Exception $smtpErr) {
        $cleanMessage = formatSmtpErrorPhp($smtpErr->getMessage());
        $latestSanitized = null;
        if ($stored) {
            try {
                $latestSanitized = updateEmailTestStatusPhp($pdo, 'FAILED', $cleanMessage);
            } catch (Exception $e) {}
        }
        http_response_code(400);
        $resp = ['success' => false, 'message' => $cleanMessage];
        if ($latestSanitized) {
            $resp['data'] = ['settings' => $latestSanitized];
        }
        echo json_encode($resp);
        exit;
    }
}

// GET /api/email/status (Authenticated non-Customer ERP staff)
if ($method === 'GET' && in_array($cleanPath, ['/email/status', '/email/status/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $user = requireAuthUserPhp($pdo);
    $isCust = (strtoupper((string)($user['accountType'] ?? '')) === 'CUSTOMER') ||
        in_array(strtolower((string)($user['role'] ?? '')), ['customer', 'client'], true);
    if ($isCust) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied for customer accounts.']);
        exit;
    }

    $sanitized = sanitizeEmailSettingsPhp(getEmailSettingsInternalPhp($pdo));
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'data' => [
            'configured' => $sanitized['configured'],
            'enabled' => $sanitized['enabled'],
            'senderName' => $sanitized['senderName'],
            'gmailAddress' => $sanitized['configured'] ? $sanitized['gmailAddress'] : ''
        ]
    ]);
    exit;
}

// POST /api/email/send (Authenticated non-Customer ERP staff)
if ($method === 'POST' && in_array($cleanPath, ['/email/send', '/email/send/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $user = requireAuthUserPhp($pdo);
    $isCust = (strtoupper((string)($user['accountType'] ?? '')) === 'CUSTOMER') ||
        in_array(strtolower((string)($user['role'] ?? '')), ['customer', 'client'], true);
    if ($isCust) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied: Customer portal accounts cannot send ERP emails.']);
        exit;
    }

    $row = getEmailSettingsInternalPhp($pdo);
    if (!$row || empty($row['gmail_address']) || empty($row['encrypted_app_password']) || empty($row['iv']) || empty($row['auth_tag'])) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'message' => 'Gmail email integration is not configured yet. Ask an Administrator to configure Gmail SMTP in System Settings.'
        ]);
        exit;
    }
    if ((int)($row['enabled'] ?? 1) === 0) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'message' => 'Gmail email integration is currently disabled by the Administrator in System Settings.'
        ]);
        exit;
    }

    $normList = function ($val) {
        if (empty($val)) return [];
        $items = is_array($val) ? $val : explode(',', (string)$val);
        return array_values(array_filter(array_map('trim', $items)));
    };

    $toList = $normList($body['to'] ?? null);
    if (empty($toList)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Please enter a valid recipient email address.']);
        exit;
    }
    foreach ($toList as $addr) {
        if (!isValidEmailAddressPhp($addr)) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Please enter a valid recipient email address.']);
            exit;
        }
    }

    $subject = trim((string)($body['subject'] ?? ''));
    if (empty($subject)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Email subject is required.']);
        exit;
    }

    $textBody = trim((string)($body['text'] ?? ''));
    $htmlBody = trim((string)($body['html'] ?? ''));
    if (empty($textBody) && empty($htmlBody)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Email message body is required.']);
        exit;
    }

    $ccList = array_values(array_filter($normList($body['cc'] ?? null), 'isValidEmailAddressPhp'));
    $bccList = array_values(array_filter($normList($body['bcc'] ?? null), 'isValidEmailAddressPhp'));

    try {
        $decryptedPassword = decryptEmailSecretPhp($row['encrypted_app_password'], $row['iv'], $row['auth_tag'], $dbConfig);
        $sanitized = sanitizeEmailSettingsPhp($row);
        $result = sendSmtpEmailPhp(
            $sanitized,
            $decryptedPassword,
            [
                'to' => $toList,
                'cc' => $ccList,
                'bcc' => $bccList,
                'replyTo' => $body['replyTo'] ?? null,
                'subject' => $subject,
                'text' => $textBody,
                'html' => $htmlBody,
                'attachments' => is_array($body['attachments'] ?? null) ? $body['attachments'] : []
            ]
        );
        http_response_code(200);
        echo json_encode([
            'success' => true,
            'message' => 'Email sent successfully to ' . implode(', ', $result['accepted']) . '.',
            'data' => $result
        ]);
        exit;
    } catch (Exception $e) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'message' => formatSmtpErrorPhp($e->getMessage())
        ]);
        exit;
    }
}

// ==========================================================
// SALES & PURCHASE ERP REST ENDPOINTS (PRODUCTS, VENDORS, VENDOR SALES INVOICES)
// ==========================================================

// GET|POST /api/products
if (in_array($cleanPath, ['/products', '/products/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_products` ORDER BY `created_at` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) {
            $whStocks = !empty($r['warehouse_stocks_json']) ? (json_decode($r['warehouse_stocks_json'], true) ?: []) : [];
            $minStock = isset($r['reorder_level']) ? floatval($r['reorder_level']) : 0.0;
            $gst = isset($r['gst_rate']) ? floatval($r['gst_rate']) : 18.0;
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'sku' => $r['sku'],
                'itemCode' => $r['sku'],
                'category' => $r['category'],
                'brand' => $r['brand'] ?? '',
                'model' => $r['model'] ?? '',
                'specifications' => $r['specifications'] ?? '',
                'specification' => $r['specifications'] ?? '',
                'unit' => $r['unit'] ?? 'Nos',
                'hsnCode' => $r['hsn_code'] ?? '',
                'gstRate' => $gst,
                'taxRate' => $gst,
                'unitPrice' => floatval($r['unit_price'] ?? 0),
                'sellingPrice' => floatval($r['selling_price'] ?? 0),
                'currentStock' => floatval($r['current_stock'] ?? 0),
                'reorderLevel' => $minStock,
                'minStockLevel' => $minStock,
                'minStockThreshold' => $minStock,
                'location' => $r['location'] ?? ($r['warehouse_name'] ?? ''),
                'warehouseId' => $r['warehouse_id'] ?? '',
                'warehouseName' => $r['warehouse_name'] ?? '',
                'warehouseStocks' => $whStocks,
                'preferredVendorId' => $r['preferred_vendor_id'] ?? '',
                'preferredVendorName' => $r['preferred_vendor_name'] ?? '',
                'status' => $r['status'] ?? 'ACTIVE',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $actor = requireAuthUserPhp($pdo);
        $saved = saveProductToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|DELETE /api/products/{id}
if (preg_match('#^/products/([^/]+)/?$#', $cleanPath, $matches)) {
    $prodId = urldecode($matches[1]);
    if ($prodId !== 'import') {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        $actor = requireAuthUserPhp($pdo);

        if ($method === 'PUT' || $method === 'POST') {
            $body['id'] = $prodId;
            $saved = saveProductToDb($pdo, $body);
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $saved]);
            exit;
        }
        if ($method === 'DELETE') {
            deleteItemFromDb($pdo, 'products', $prodId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Product deleted from MySQL.']);
            exit;
        }
    }
}

// GET|POST /api/vendors
if (in_array($cleanPath, ['/vendors', '/vendors/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_vendors` ORDER BY `created_at` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) {
            $cats = json_decode($r['categories_json'] ?? '[]', true) ?: [];
            $bank = !empty($r['bank_details_json']) ? json_decode($r['bank_details_json'], true) : null;
            $cat = $cats[0] ?? 'Solar Modules';
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'vendorCode' => $r['vendor_code'],
                'contactPerson' => $r['contact_person'] ?? '',
                'phone' => $r['phone'] ?? '',
                'email' => $r['email'] ?? '',
                'address' => $r['address'] ?? '',
                'city' => $r['city'] ?? '',
                'state' => $r['state'] ?? '',
                'gstNumber' => $r['gst_number'] ?? '',
                'panNumber' => $r['pan_number'] ?? '',
                'paymentTerms' => $r['payment_terms'] ?? '30 Days',
                'rating' => floatval($r['rating'] ?? 4.5),
                'category' => $cat,
                'categories' => !empty($cats) ? $cats : [$cat],
                'bankDetails' => $bank,
                'status' => $r['status'] ?? 'ACTIVE',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $actor = requireAuthUserPhp($pdo);
        $saved = saveVendorToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|DELETE /api/vendors/{id}
if (preg_match('#^/vendors/([^/]+)/?$#', $cleanPath, $matches)) {
    $venId = urldecode($matches[1]);
    if ($venId !== 'import') {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        $actor = requireAuthUserPhp($pdo);

        if ($method === 'PUT' || $method === 'POST') {
            $body['id'] = $venId;
            $saved = saveVendorToDb($pdo, $body);
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $saved]);
            exit;
        }
        if ($method === 'DELETE') {
            deleteItemFromDb($pdo, 'vendors', $venId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Vendor deleted from MySQL.']);
            exit;
        }
    }
}

// GET /api/vendor-sales-invoices/next-number (Strict Admin-Only)
if ($method === 'GET' && in_array($cleanPath, ['/vendor-sales-invoices/next-number', '/vendor-sales-invoices/next-number/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    requireAdminUserPhp($pdo);
    $nextNumber = getNextVendorSalesInvoiceNumberPhp($pdo);
    http_response_code(200);
    echo json_encode(['success' => true, 'data' => ['invoiceNumber' => $nextNumber]]);
    exit;
}

// GET|POST /api/vendor-sales-invoices (Strict Admin-Only)
if (in_array($cleanPath, ['/vendor-sales-invoices', '/vendor-sales-invoices/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);

    if ($method === 'GET') {
        $items = getVendorSalesInvoicesPhp($pdo);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        try {
            $payload = $body;
            if (empty($payload['id'])) {
                $payload['id'] = 'vsi-' . round(microtime(true) * 1000);
            }
            $saved = saveVendorSalesInvoicePhp($pdo, $payload, $actor);
            http_response_code(201);
            echo json_encode(['success' => true, 'data' => $saved]);
            exit;
        } catch (Exception $e) {
            $code = intval($e->getCode());
            http_response_code(($code >= 400 && $code < 600) ? $code : 400);
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
            exit;
        }
    }
}

// POST /api/vendor-sales-invoices/{id}/payments (Strict Admin-Only)
if ($method === 'POST' && preg_match('#^/vendor-sales-invoices/([^/]+)/payments/?$#', $cleanPath, $matches)) {
    $vsiId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminUserPhp($pdo);
    try {
        $updated = recordVendorSalesPaymentPhp($pdo, $vsiId, $body, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $updated]);
        exit;
    } catch (Exception $e) {
        $code = intval($e->getCode());
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        exit;
    }
}

// GET|PUT|POST|DELETE /api/vendor-sales-invoices/{id} (Strict Admin-Only)
if (preg_match('#^/vendor-sales-invoices/([^/]+)/?$#', $cleanPath, $matches)) {
    $vsiId = urldecode($matches[1]);
    if ($vsiId !== 'next-number') {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        $actor = requireAdminUserPhp($pdo);

        if ($method === 'GET') {
            $invoice = getVendorSalesInvoiceByIdPhp($pdo, $vsiId);
            if (!$invoice) {
                http_response_code(404);
                echo json_encode(['success' => false, 'message' => 'Vendor sales invoice not found.']);
                exit;
            }
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $invoice]);
            exit;
        }

        if ($method === 'PUT' || $method === 'POST') {
            try {
                $body['id'] = $vsiId;
                $saved = saveVendorSalesInvoicePhp($pdo, $body, $actor);
                http_response_code(200);
                echo json_encode(['success' => true, 'data' => $saved]);
                exit;
            } catch (Exception $e) {
                $code = intval($e->getCode());
                http_response_code(($code >= 400 && $code < 600) ? $code : 400);
                echo json_encode(['success' => false, 'message' => $e->getMessage()]);
                exit;
            }
        }

        if ($method === 'DELETE') {
            try {
                deleteVendorSalesInvoicePhp($pdo, $vsiId);
                http_response_code(200);
                echo json_encode(['success' => true, 'message' => 'Vendor sales invoice deleted from MySQL.']);
                exit;
            } catch (Exception $e) {
                $code = intval($e->getCode());
                http_response_code(($code >= 400 && $code < 600) ? $code : 400);
                echo json_encode(['success' => false, 'message' => $e->getMessage()]);
                exit;
            }
        }
    }
}

// ==========================================================
// DIRECT HRMS & FINANCE REST ENDPOINTS (Attendance, Fuel Approval, Payslips, Holidays, Expenses)
// ==========================================================

// PUT /api/attendance/{id}/fuel-approval
if (($method === 'PUT' || $method === 'POST') && preg_match('#^/attendance/([^/]+)/fuel-approval/?$#', $cleanPath, $matches)) {
    $attId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);

    $stmt = $pdo->prepare('SELECT * FROM `solar_attendance` WHERE `id` = ? LIMIT 1');
    $stmt->execute([$attId]);
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$existing) {
        http_response_code(404);
        echo json_encode(['success' => false, 'message' => 'Attendance record not found.']);
        exit;
    }

    $currentFuel = !empty($existing['fuel_expense_json']) ? (json_decode($existing['fuel_expense_json'], true) ?: []) : [];
    $nextStatus = $body['approvalStatus'] ?? ($body['status'] ?? 'APPROVED');
    $reviewer = $body['approvedBy'] ?? ($body['reviewedBy'] ?? ($actor['name'] ?? 'Administrator'));
    $nowIso = date('c');

    $updatedFuel = array_merge($currentFuel, [
        'approvalStatus' => $nextStatus,
        'approvedBy' => $reviewer,
        'approvedAt' => $nowIso,
        'updatedAt' => $nowIso,
        'approvalNotes' => $body['notes'] ?? ($currentFuel['approvalNotes'] ?? null)
    ]);

    $checkInGps = json_decode($existing['check_in_gps_json'] ?? 'null', true);
    $checkOutGps = json_decode($existing['check_out_gps_json'] ?? 'null', true);

    $saved = saveAttendanceToDb($pdo, [
        'id' => $existing['id'],
        'employeeId' => $existing['employee_id'],
        'employeeName' => $existing['employee_name'],
        'attendanceDate' => $existing['attendance_date'],
        'date' => $existing['attendance_date'],
        'checkInTime' => $existing['check_in_time'],
        'checkOutTime' => $existing['check_out_time'],
        'checkInGps' => $checkInGps,
        'checkInGPS' => $checkInGps,
        'checkOutGps' => $checkOutGps,
        'checkOutGPS' => $checkOutGps,
        'siteProjectId' => $existing['site_project_id'] ?? '',
        'siteProjectTitle' => $existing['site_project_title'] ?? '',
        'status' => $existing['status'] ?? 'PRESENT',
        'fuelExpense' => $updatedFuel
    ]);

    http_response_code(200);
    echo json_encode([
        'success' => true,
        'data' => $saved,
        'message' => "Fuel log marked as {$nextStatus}."
    ]);
    exit;
}

// GET|POST /api/attendance
if (in_array($cleanPath, ['/attendance', '/attendance/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_attendance` ORDER BY `attendance_date` DESC, `check_in_time` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) {
            $fuelExpense = !empty($r['fuel_expense_json']) ? json_decode($r['fuel_expense_json'], true) : null;
            if (is_array($fuelExpense) && !isset($fuelExpense['totalKmDriven']) && isset($fuelExpense['finalOdometerReading']) && isset($fuelExpense['initialOdometerReading'])) {
                $diff = floatval($fuelExpense['finalOdometerReading']) - floatval($fuelExpense['initialOdometerReading']);
                if ($diff >= 0) $fuelExpense['totalKmDriven'] = round($diff * 10) / 10;
            }
            $checkInGps = json_decode($r['check_in_gps_json'] ?? 'null', true);
            $checkOutGps = json_decode($r['check_out_gps_json'] ?? 'null', true);
            return [
                'id' => $r['id'],
                'employeeId' => $r['employee_id'],
                'employeeName' => $r['employee_name'],
                'attendanceDate' => $r['attendance_date'],
                'date' => $r['attendance_date'],
                'checkInTime' => $r['check_in_time'],
                'checkOutTime' => $r['check_out_time'],
                'checkInGps' => $checkInGps,
                'checkInGPS' => $checkInGps,
                'checkOutGps' => $checkOutGps,
                'checkOutGPS' => $checkOutGps,
                'siteProjectId' => $r['site_project_id'] ?? '',
                'siteProjectTitle' => $r['site_project_title'] ?? '',
                'status' => $r['status'] ?? 'PRESENT',
                'fuelExpense' => $fuelExpense,
                'createdAt' => $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $saved = saveAttendanceToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|POST|DELETE /api/attendance/{id}
if (preg_match('#^/attendance/([^/]+)/?$#', $cleanPath, $matches)) {
    $attId = urldecode($matches[1]);
    if ($attId !== 'import') {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        $actor = requireAuthUserPhp($pdo);

        if ($method === 'PUT' || $method === 'POST') {
            $body['id'] = $attId;
            $saved = saveAttendanceToDb($pdo, $body);
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $saved]);
            exit;
        }
        if ($method === 'DELETE') {
            deleteItemFromDb($pdo, 'attendance', $attId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Attendance record deleted from MySQL.']);
            exit;
        }
    }
}

// GET|POST /api/payslips
if (in_array($cleanPath, ['/payslips', '/payslips/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_payslips` ORDER BY `year` DESC, `month` DESC, `created_at` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) {
            $addExpenses = json_decode($r['additional_expenses_json'] ?? '[]', true) ?: [];
            $dedList = json_decode($r['deductions_json'] ?? '[]', true) ?: [];
            $totalExpenses = is_array($addExpenses) ? array_reduce($addExpenses, fn($s, $x) => $s + floatval($x['amount'] ?? 0), 0) : 0;
            $totalDeductions = (!empty($dedList) && is_array($dedList))
                ? array_reduce($dedList, fn($s, $x) => $s + floatval($x['amount'] ?? 0), 0)
                : floatval($r['deductions'] ?? 0);
            $basic = floatval($r['basic_salary'] ?? 0);
            $overtimeAmt = floatval($r['allowances'] ?? 0);
            $net = floatval($r['net_salary'] ?? ($basic + $overtimeAmt + $totalExpenses - $totalDeductions));
            return [
                'id' => $r['id'],
                'payslipNumber' => $r['id'],
                'employeeId' => $r['employee_id'],
                'employeeName' => $r['employee_name'],
                'employeeCode' => $r['employee_id'],
                'month' => $r['month'],
                'year' => intval($r['year']),
                'baseSalary' => $basic,
                'basicSalary' => $basic,
                'allowances' => $overtimeAmt,
                'overtimeAmount' => $overtimeAmt,
                'overtimeType' => (!empty($r['overtime_hours']) && floatval($r['overtime_hours']) > 0) ? 'CALCULATED' : 'DIRECT',
                'overtimeHours' => floatval($r['overtime_hours'] ?? 0),
                'overtimeRatePerHour' => floatval($r['overtime_rate'] ?? 0),
                'additionalExpenses' => $addExpenses,
                'totalAdditionalExpenses' => $totalExpenses,
                'deductions' => $dedList,
                'totalDeductions' => $totalDeductions,
                'grossEarnings' => $basic + $overtimeAmt + $totalExpenses,
                'netPay' => $net,
                'netSalary' => $net,
                'paymentStatus' => $r['payment_status'] ?? 'PAID',
                'status' => ($r['payment_status'] ?? 'PAID') === 'PAID' ? 'PAID' : ($r['payment_status'] ?? 'GENERATED'),
                'paymentDate' => $r['payment_date'],
                'paymentMode' => $r['payment_mode'] ?? 'NEFT/RTGS Bank Transfer',
                'bankReferenceNo' => $r['bank_reference_no'] ?? '',
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $saved = savePayslipToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|POST|DELETE /api/payslips/{id}
if (preg_match('#^/payslips/([^/]+)/?$#', $cleanPath, $matches)) {
    $psId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'PUT' || $method === 'POST') {
        $body['id'] = $psId;
        $saved = savePayslipToDb($pdo, $body);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
    if ($method === 'DELETE') {
        deleteItemFromDb($pdo, 'payslips', $psId, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'Payslip deleted from MySQL.']);
        exit;
    }
}

// GET|POST /api/holidays
if (in_array($cleanPath, ['/holidays', '/holidays/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_holidays` ORDER BY `holiday_date` ASC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'name' => $r['name'],
                'holidayDate' => $r['holiday_date'],
                'date' => $r['holiday_date'],
                'type' => $r['type'] ?? 'Mandatory',
                'description' => $r['description'] ?? '',
                'createdAt' => $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $saved = saveHolidayToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|POST|DELETE /api/holidays/{id}
if (preg_match('#^/holidays/([^/]+)/?$#', $cleanPath, $matches)) {
    $holId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'PUT' || $method === 'POST') {
        $body['id'] = $holId;
        $saved = saveHolidayToDb($pdo, $body);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
    if ($method === 'DELETE') {
        deleteItemFromDb($pdo, 'holidays', $holId, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'Holiday deleted from MySQL.']);
        exit;
    }
}

// ==========================================================
// EMPLOYEE LEAVE MANAGEMENT HELPERS & ROUTES
// ==========================================================

function mapLeaveRowPhp($r) {
    return [
        'id' => $r['id'],
        'employeeId' => $r['employee_id'],
        'employeeCode' => $r['employee_code'] ?? '',
        'employeeName' => $r['employee_name'] ?? '',
        'department' => $r['department'] ?? 'Operations',
        'designation' => $r['designation'] ?? '',
        'leaveType' => strtoupper((string)($r['leave_type'] ?? 'CASUAL')),
        'startDate' => !empty($r['start_date']) ? substr((string)$r['start_date'], 0, 10) : '',
        'endDate' => !empty($r['end_date']) ? substr((string)$r['end_date'], 0, 10) : '',
        'totalDays' => floatval($r['total_days'] ?? 0),
        'isHalfDay' => (bool)($r['is_half_day'] ?? 0),
        'halfDaySession' => $r['half_day_session'] ?? '',
        'reason' => $r['reason'] ?? '',
        'status' => strtoupper((string)($r['status'] ?? 'PENDING')),
        'leaveYear' => intval($r['leave_year'] ?? date('Y')),
        'appliedAt' => !empty($r['applied_at']) ? date('c', strtotime((string)$r['applied_at'])) : date('c'),
        'reviewedBy' => $r['reviewed_by'] ?? null,
        'reviewerId' => $r['reviewer_id'] ?? null,
        'reviewedAt' => !empty($r['reviewed_at']) ? date('c', strtotime((string)$r['reviewed_at'])) : null,
        'adminRemarks' => $r['admin_remarks'] ?? null,
        'updatedAt' => !empty($r['updated_at']) ? date('c', strtotime((string)$r['updated_at'])) : null
    ];
}

function ensureLeaveBalanceRowPhp($pdo, $employeeId, $leaveYear) {
    $balId = 'lbal-' . $employeeId . '-' . $leaveYear;
    $stmt = $pdo->prepare("
        INSERT IGNORE INTO `solar_leave_balances`
        (`id`, `employee_id`, `leave_year`, `casual_total`, `casual_used`, `sick_total`, `sick_used`, `earned_total`, `earned_used`, `unpaid_used`)
        VALUES (?, ?, ?, 12.00, 0.00, 8.00, 0.00, 15.00, 0.00, 0.00)
    ");
    $stmt->execute([$balId, $employeeId, $leaveYear]);
}

function resolveEmployeeForLeavePhp($pdo, $actor, $requestedEmpId = null) {
    $roleUpper = strtoupper(trim((string)($actor['role'] ?? '')));
    $isAdminOrHr = in_array($roleUpper, ['ADMIN', 'SUPER ADMIN', 'HR MANAGER'], true);

    if ($isAdminOrHr && !empty($requestedEmpId)) {
        $reqId = trim((string)$requestedEmpId);
        $s1 = $pdo->prepare('SELECT * FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR `employee_code` = ? LIMIT 1');
        $s1->execute([$reqId, $reqId, $reqId]);
        if ($e = $s1->fetch(PDO::FETCH_ASSOC)) {
            return [
                'employeeId' => $e['id'],
                'employeeCode' => $e['employee_code'] ?: $e['id'],
                'employeeName' => $e['name'],
                'department' => $e['department'] ?: 'Operations',
                'designation' => $e['designation'] ?: ''
            ];
        }
        $s2 = $pdo->prepare("SELECT * FROM `solar_users` WHERE `id` = ? AND `role` != 'Customer' LIMIT 1");
        $s2->execute([$reqId]);
        if ($u = $s2->fetch(PDO::FETCH_ASSOC)) {
            return [
                'employeeId' => $u['id'],
                'employeeCode' => $u['employee_id'] ?: $u['id'],
                'employeeName' => $u['name'],
                'department' => $u['department'] ?: 'Operations',
                'designation' => $u['designation'] ?: ($u['role'] ?: '')
            ];
        }
        throw new Exception('Selected employee not found in MySQL.', 404);
    }

    $actorId = trim((string)($actor['id'] ?? ''));
    $actorEmpId = trim((string)($actor['employeeId'] ?? ($actor['employee_id'] ?? '')));
    $actorEmail = strtolower(trim((string)($actor['email'] ?? '')));

    $s3 = $pdo->prepare('SELECT * FROM `solar_employee` WHERE `id` = ? OR `auth_uid` = ? OR (`employee_code` != "" AND `employee_code` = ?) OR (`email` != "" AND LOWER(`email`) = ?) LIMIT 1');
    $s3->execute([$actorId, $actorId, $actorEmpId, $actorEmail]);
    if ($e = $s3->fetch(PDO::FETCH_ASSOC)) {
        return [
            'employeeId' => $e['id'],
            'employeeCode' => $e['employee_code'] ?: $e['id'],
            'employeeName' => $e['name'],
            'department' => $e['department'] ?: 'Operations',
            'designation' => $e['designation'] ?: ''
        ];
    }

    return [
        'employeeId' => $actorId,
        'employeeCode' => $actorEmpId ?: ('EMP-' . strtoupper(substr($actorId, -4))),
        'employeeName' => $actor['name'] ?? 'Employee',
        'department' => $actor['department'] ?? 'Operations',
        'designation' => $actor['designation'] ?? ($actor['role'] ?? '')
    ];
}

// GET|POST /api/leaves
if (in_array($cleanPath, ['/leaves', '/leaves/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied: Leave management is only available for staff members.']);
        exit;
    }

    $roleUpper = strtoupper(trim((string)($actor['role'] ?? '')));
    $isAdminOrHr = in_array($roleUpper, ['ADMIN', 'SUPER ADMIN', 'HR MANAGER'], true);

    if ($method === 'GET') {
        $yearParam = isset($_GET['year']) ? intval($_GET['year']) : 0;
        $leaveYear = ($yearParam >= 2000) ? $yearParam : intval(date('Y'));
        $myProfile = resolveEmployeeForLeavePhp($pdo, $actor);

        // Fetch active staff directory (from solar_employees merged with solar_users non-Customer)
        $empRows = $pdo->query('SELECT * FROM `solar_employees` ORDER BY `created_at` ASC')->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $seenEmpIds = [];
        $seenEmails = [];
        foreach ($empRows as $er) {
            $seenEmpIds[$er['id']] = true;
            if (!empty($er['email'])) $seenEmails[strtolower($er['email'])] = true;
        }
        $uStmt = $pdo->query("SELECT * FROM `solar_users` WHERE `role` != 'Customer'");
        while ($u = $uStmt->fetch(PDO::FETCH_ASSOC)) {
            $uEmail = strtolower($u['email'] ?? '');
            if (empty($seenEmpIds[$u['id']]) && (empty($uEmail) || empty($seenEmails[$uEmail]))) {
                $empRows[] = [
                    'id' => $u['id'],
                    'auth_uid' => $u['id'],
                    'employee_code' => $u['employee_id'] ?: ('EMP-' . substr($u['id'], -4)),
                    'name' => $u['name'],
                    'email' => $u['email'] ?? '',
                    'department' => $u['department'] ?: 'Operations',
                    'designation' => $u['designation'] ?: ($u['role'] ?: ''),
                    'status' => $u['status'] ?: 'ACTIVE'
                ];
                $seenEmpIds[$u['id']] = true;
                if (!empty($uEmail)) $seenEmails[$uEmail] = true;
            }
        }

        $targetEmployees = [];
        foreach ($empRows as $er) {
            if ($isAdminOrHr) {
                if (strtoupper((string)($er['status'] ?? '')) !== 'TERMINATED') {
                    $targetEmployees[] = $er;
                }
            } else {
                $erEmail = strtolower((string)($er['email'] ?? ''));
                $actorEmail = strtolower((string)($actor['email'] ?? ''));
                if (
                    $er['id'] === $myProfile['employeeId'] ||
                    ($er['auth_uid'] ?? '') === ($actor['id'] ?? '') ||
                    (!empty($myProfile['employeeCode']) && ($er['employee_code'] ?? '') === $myProfile['employeeCode']) ||
                    (!empty($actorEmail) && $erEmail === $actorEmail)
                ) {
                    $targetEmployees[] = $er;
                }
            }
        }
        if (empty($targetEmployees)) {
            $targetEmployees[] = [
                'id' => $myProfile['employeeId'],
                'employee_code' => $myProfile['employeeCode'],
                'name' => $myProfile['employeeName'],
                'department' => $myProfile['department'],
                'designation' => $myProfile['designation']
            ];
        }

        foreach ($targetEmployees as $emp) {
            ensureLeaveBalanceRowPhp($pdo, $emp['id'], $leaveYear);
        }

        $myIdVariants = array_values(array_unique(array_filter([
            $myProfile['employeeId'],
            trim((string)($actor['id'] ?? '')),
            trim((string)($actor['employeeId'] ?? ($actor['employee_id'] ?? '')))
        ])));

        if ($isAdminOrHr) {
            $lStmt = $pdo->prepare('SELECT * FROM `solar_leave_requests` WHERE `leave_year` = ? ORDER BY FIELD(`status`, "PENDING", "APPROVED", "REJECTED", "CANCELLED"), `applied_at` DESC');
            $lStmt->execute([$leaveYear]);
            $leaveRows = $lStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $bStmt = $pdo->prepare('SELECT * FROM `solar_leave_balances` WHERE `leave_year` = ?');
            $bStmt->execute([$leaveYear]);
            $balRows = $bStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        } else {
            $ph = implode(',', array_fill(0, count($myIdVariants), '?'));
            $lStmt = $pdo->prepare("SELECT * FROM `solar_leave_requests` WHERE `leave_year` = ? AND `employee_id` IN ($ph) ORDER BY `applied_at` DESC");
            $lStmt->execute(array_merge([$leaveYear], $myIdVariants));
            $leaveRows = $lStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

            $bStmt = $pdo->prepare("SELECT * FROM `solar_leave_balances` WHERE `leave_year` = ? AND `employee_id` IN ($ph)");
            $bStmt->execute(array_merge([$leaveYear], $myIdVariants));
            $balRows = $bStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        }

        $leaves = array_map('mapLeaveRowPhp', $leaveRows);
        $balByEmp = [];
        foreach ($balRows as $b) {
            $balByEmp[$b['employee_id']] = $b;
        }

        $pendingMap = [];
        foreach ($leaves as $lv) {
            if ($lv['status'] === 'PENDING') {
                $eid = $lv['employeeId'];
                if (!isset($pendingMap[$eid])) $pendingMap[$eid] = ['CASUAL' => 0.0, 'SICK' => 0.0, 'EARNED' => 0.0];
                if (isset($pendingMap[$eid][$lv['leaveType']])) {
                    $pendingMap[$eid][$lv['leaveType']] += floatval($lv['totalDays']);
                }
            }
        }

        $balances = [];
        foreach ($targetEmployees as $emp) {
            $eid = $emp['id'];
            $b = $balByEmp[$eid] ?? [];
            $pend = $pendingMap[$eid] ?? ['CASUAL' => 0.0, 'SICK' => 0.0, 'EARNED' => 0.0];
            $casualTotal = isset($b['casual_total']) ? floatval($b['casual_total']) : 12.0;
            $casualUsed = floatval($b['casual_used'] ?? 0);
            $sickTotal = isset($b['sick_total']) ? floatval($b['sick_total']) : 8.0;
            $sickUsed = floatval($b['sick_used'] ?? 0);
            $earnedTotal = isset($b['earned_total']) ? floatval($b['earned_total']) : 15.0;
            $earnedUsed = floatval($b['earned_used'] ?? 0);
            $unpaidUsed = floatval($b['unpaid_used'] ?? 0);
            $totalAllocated = $casualTotal + $sickTotal + $earnedTotal;
            $totalUsed = $casualUsed + $sickUsed + $earnedUsed;
            $balances[] = [
                'id' => $b['id'] ?? ('lbal-' . $eid . '-' . $leaveYear),
                'employeeId' => $eid,
                'employeeCode' => $emp['employee_code'] ?? '',
                'employeeName' => $emp['name'] ?? '',
                'department' => $emp['department'] ?? '',
                'designation' => $emp['designation'] ?? '',
                'leaveYear' => $leaveYear,
                'casualTotal' => $casualTotal,
                'casualUsed' => $casualUsed,
                'casualPending' => $pend['CASUAL'],
                'casualRemaining' => max(0, round($casualTotal - $casualUsed, 2)),
                'sickTotal' => $sickTotal,
                'sickUsed' => $sickUsed,
                'sickPending' => $pend['SICK'],
                'sickRemaining' => max(0, round($sickTotal - $sickUsed, 2)),
                'earnedTotal' => $earnedTotal,
                'earnedUsed' => $earnedUsed,
                'earnedPending' => $pend['EARNED'],
                'earnedRemaining' => max(0, round($earnedTotal - $earnedUsed, 2)),
                'unpaidUsed' => $unpaidUsed,
                'totalAllocated' => $totalAllocated,
                'totalUsed' => $totalUsed,
                'totalRemaining' => max(0, round($totalAllocated - $totalUsed, 2)),
                'updatedAt' => !empty($b['updated_at']) ? date('c', strtotime((string)$b['updated_at'])) : null
            ];
        }

        http_response_code(200);
        echo json_encode([
            'success' => true,
            'data' => [
                'leaveYear' => $leaveYear,
                'canReview' => $isAdminOrHr,
                'myEmployee' => $myProfile,
                'leaves' => $leaves,
                'balances' => $balances
            ]
        ]);
        exit;
    }

    if ($method === 'POST') {
        try {
            $targetEmp = resolveEmployeeForLeavePhp($pdo, $actor, $body['employeeId'] ?? null);
            $leaveType = strtoupper(trim((string)($body['leaveType'] ?? 'CASUAL')));
            if (!in_array($leaveType, ['CASUAL', 'SICK', 'EARNED', 'UNPAID'], true)) {
                throw new Exception('Invalid leave type. Choose CASUAL, SICK, EARNED, or UNPAID.', 400);
            }
            $startDate = substr(trim((string)($body['startDate'] ?? '')), 0, 10);
            $endDate = substr(trim((string)($body['endDate'] ?? $startDate)), 0, 10);
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDate)) {
                throw new Exception('Valid start date and end date (YYYY-MM-DD) are required.', 400);
            }
            if ($endDate < $startDate) {
                throw new Exception('End date cannot be earlier than start date.', 400);
            }
            $isHalfDay = parseBoolFlagPhp($body['isHalfDay'] ?? false, false);
            if ($isHalfDay && $startDate !== $endDate) {
                throw new Exception('Half-day leave can only be applied for a single date (start date = end date).', 400);
            }
            $halfDaySession = $isHalfDay ? trim((string)($body['halfDaySession'] ?? 'FIRST_HALF')) : '';
            $sTs = strtotime($startDate . ' 00:00:00 UTC');
            $eTs = strtotime($endDate . ' 00:00:00 UTC');
            $totalDays = $isHalfDay ? 0.5 : (round(($eTs - $sTs) / 86400) + 1);
            if ($totalDays <= 0 || $totalDays > 180) {
                throw new Exception('Leave duration must be between 0.5 and 180 days.', 400);
            }
            $reason = trim((string)($body['reason'] ?? ''));
            if (strlen($reason) < 3) {
                throw new Exception('Please enter a valid reason for leave (minimum 3 characters).', 400);
            }

            $leaveYear = intval(substr($startDate, 0, 4));
            $pdo->beginTransaction();
            try {
                ensureLeaveBalanceRowPhp($pdo, $targetEmp['employeeId'], $leaveYear);

                $ovStmt = $pdo->prepare("
                    SELECT id, start_date, end_date, status FROM `solar_leave_requests`
                    WHERE `employee_id` = ? AND `status` IN ('PENDING', 'APPROVED')
                      AND `start_date` <= ? AND `end_date` >= ?
                    LIMIT 1 FOR UPDATE
                ");
                $ovStmt->execute([$targetEmp['employeeId'], $endDate, $startDate]);
                if ($ov = $ovStmt->fetch(PDO::FETCH_ASSOC)) {
                    throw new Exception("Leave dates overlap with an existing {$ov['status']} application (" . substr((string)$ov['start_date'], 0, 10) . " to " . substr((string)$ov['end_date'], 0, 10) . ").", 409);
                }

                if ($leaveType !== 'UNPAID') {
                    $bStmt = $pdo->prepare('SELECT * FROM `solar_leave_balances` WHERE `employee_id` = ? AND `leave_year` = ? LIMIT 1 FOR UPDATE');
                    $bStmt->execute([$targetEmp['employeeId'], $leaveYear]);
                    $bal = $bStmt->fetch(PDO::FETCH_ASSOC) ?: [];

                    $pStmt = $pdo->prepare("SELECT COALESCE(SUM(`total_days`), 0) AS pend_days FROM `solar_leave_requests` WHERE `employee_id` = ? AND `leave_year` = ? AND `leave_type` = ? AND `status` = 'PENDING'");
                    $pStmt->execute([$targetEmp['employeeId'], $leaveYear, $leaveType]);
                    $pendDays = floatval($pStmt->fetchColumn() ?: 0);

                    $totalQuota = ($leaveType === 'CASUAL') ? floatval($bal['casual_total'] ?? 12) : (($leaveType === 'SICK') ? floatval($bal['sick_total'] ?? 8) : floatval($bal['earned_total'] ?? 15));
                    $usedDays = ($leaveType === 'CASUAL') ? floatval($bal['casual_used'] ?? 0) : (($leaveType === 'SICK') ? floatval($bal['sick_used'] ?? 0) : floatval($bal['earned_used'] ?? 0));
                    $available = $totalQuota - $usedDays - $pendDays;
                    if ($totalDays > $available + 0.001) {
                        throw new Exception("Insufficient {$leaveType} leave balance. Available (after pending): " . max(0, $available) . " day(s). Select UNPAID leave if exhausted.", 400);
                    }
                }

                $id = 'lv-' . round(microtime(true) * 1000) . '-' . bin2hex(random_bytes(2));
                $ins = $pdo->prepare("
                    INSERT INTO `solar_leave_requests` (
                        `id`, `employee_id`, `employee_code`, `employee_name`, `department`, `designation`,
                        `leave_type`, `start_date`, `end_date`, `total_days`, `is_half_day`, `half_day_session`,
                        `reason`, `status`, `leave_year`, `applied_at`
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NOW())
                ");
                $ins->execute([
                    $id,
                    $targetEmp['employeeId'],
                    $targetEmp['employeeCode'],
                    $targetEmp['employeeName'],
                    $targetEmp['department'],
                    $targetEmp['designation'],
                    $leaveType,
                    $startDate,
                    $endDate,
                    $totalDays,
                    $isHalfDay ? 1 : 0,
                    $halfDaySession,
                    $reason,
                    $leaveYear
                ]);

                $getStmt = $pdo->prepare('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1');
                $getStmt->execute([$id]);
                $savedRow = $getStmt->fetch(PDO::FETCH_ASSOC);
                $pdo->commit();

                http_response_code(201);
                echo json_encode(['success' => true, 'data' => mapLeaveRowPhp($savedRow), 'message' => 'Leave application submitted successfully.']);
            } catch (Exception $inner) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $inner;
            }
        } catch (Exception $e) {
            $exCode = intval($e->getCode());
            $statusCode = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
            http_response_code($statusCode);
            echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
        }
        exit;
    }
}

// PUT|POST /api/leaves/{id}/review
if (preg_match('#^/leaves/([^/]+)/review/?$#', $cleanPath, $matches) && in_array($method, ['PUT', 'POST'], true)) {
    $leaveId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAdminOrHrUserPhp($pdo);

    try {
        $rawAction = strtoupper(trim((string)($body['action'] ?? ($body['status'] ?? ''))));
        $targetStatus = in_array($rawAction, ['APPROVE', 'APPROVED'], true)
            ? 'APPROVED'
            : (in_array($rawAction, ['REJECT', 'REJECTED'], true) ? 'REJECTED' : '');
        if (empty($targetStatus)) {
            throw new Exception('Invalid review action. Must be APPROVE or REJECT.', 400);
        }
        $cleanRemarks = trim((string)($body['remarks'] ?? ($body['adminRemarks'] ?? '')));

        $pdo->beginTransaction();
        try {
            $lStmt = $pdo->prepare('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1 FOR UPDATE');
            $lStmt->execute([$leaveId]);
            $lv = $lStmt->fetch(PDO::FETCH_ASSOC);
            if (!$lv) {
                throw new Exception('Leave application not found.', 404);
            }
            $prevStatus = strtoupper((string)($lv['status'] ?? 'PENDING'));
            if ($prevStatus === 'CANCELLED') {
                throw new Exception('Cannot review a cancelled leave application.', 400);
            }

            $empId = $lv['employee_id'];
            $leaveYear = intval($lv['leave_year'] ?? date('Y'));
            $totalDays = floatval($lv['total_days'] ?? 0);
            $lType = strtoupper((string)($lv['leave_type'] ?? 'CASUAL'));
            $usedCol = ($lType === 'CASUAL') ? 'casual_used' : (($lType === 'SICK') ? 'sick_used' : (($lType === 'EARNED') ? 'earned_used' : 'unpaid_used'));

            ensureLeaveBalanceRowPhp($pdo, $empId, $leaveYear);
            $bStmt = $pdo->prepare('SELECT * FROM `solar_leave_balances` WHERE `employee_id` = ? AND `leave_year` = ? LIMIT 1 FOR UPDATE');
            $bStmt->execute([$empId, $leaveYear]);
            $bal = $bStmt->fetch(PDO::FETCH_ASSOC) ?: [];

            if ($targetStatus === 'APPROVED' && $prevStatus !== 'APPROVED') {
                if ($lType !== 'UNPAID') {
                    $totalCol = ($lType === 'CASUAL') ? 'casual_total' : (($lType === 'SICK') ? 'sick_total' : 'earned_total');
                    $defaultQuota = ($lType === 'CASUAL') ? 12.0 : (($lType === 'SICK') ? 8.0 : 15.0);
                    $quota = isset($bal[$totalCol]) ? floatval($bal[$totalCol]) : $defaultQuota;
                    $used = floatval($bal[$usedCol] ?? 0);
                    if ($used + $totalDays > $quota + 0.001) {
                        throw new Exception("Cannot approve: {$lType} balance insufficient (Remaining: " . max(0, $quota - $used) . " day(s), Requested: {$totalDays} day(s)).", 400);
                    }
                }
                $pdo->prepare("UPDATE `solar_leave_balances` SET `$usedCol` = `$usedCol` + ? WHERE `employee_id` = ? AND `leave_year` = ?")
                    ->execute([$totalDays, $empId, $leaveYear]);
            } elseif ($targetStatus === 'REJECTED' && $prevStatus === 'APPROVED') {
                $pdo->prepare("UPDATE `solar_leave_balances` SET `$usedCol` = GREATEST(0, `$usedCol` - ?) WHERE `employee_id` = ? AND `leave_year` = ?")
                    ->execute([$totalDays, $empId, $leaveYear]);
            }

            $pdo->prepare("
                UPDATE `solar_leave_requests`
                SET `status` = ?, `reviewed_by` = ?, `reviewer_id` = ?, `reviewed_at` = NOW(), `admin_remarks` = ?, `updated_at` = CURRENT_TIMESTAMP
                WHERE `id` = ?
            ")->execute([$targetStatus, $actor['name'] ?? 'Administrator', $actor['id'] ?? '', ($cleanRemarks !== '' ? $cleanRemarks : null), $leaveId]);

            $uStmt = $pdo->prepare('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1');
            $uStmt->execute([$leaveId]);
            $updatedRow = $uStmt->fetch(PDO::FETCH_ASSOC);
            $pdo->commit();

            http_response_code(200);
            echo json_encode([
                'success' => true,
                'data' => mapLeaveRowPhp($updatedRow),
                'message' => 'Leave application ' . ($targetStatus === 'APPROVED' ? 'approved' : 'rejected') . ' successfully.'
            ]);
        } catch (Exception $inner) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $inner;
        }
    } catch (Exception $e) {
        $exCode = intval($e->getCode());
        $statusCode = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
        http_response_code($statusCode);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
    }
    exit;
}

// POST /api/leaves/{id}/cancel OR DELETE /api/leaves/{id}
if ((preg_match('#^/leaves/([^/]+)/cancel/?$#', $cleanPath, $matches) && $method === 'POST') ||
    (preg_match('#^/leaves/([^/]+)/?$#', $cleanPath, $matches) && $method === 'DELETE')) {
    $leaveId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Access denied.']);
        exit;
    }

    try {
        $roleUpper = strtoupper(trim((string)($actor['role'] ?? '')));
        $isAdminOrHr = in_array($roleUpper, ['ADMIN', 'SUPER ADMIN', 'HR MANAGER'], true);
        $myProfile = resolveEmployeeForLeavePhp($pdo, $actor);
        $myIdVariants = array_values(array_unique(array_filter([
            $myProfile['employeeId'],
            trim((string)($actor['id'] ?? '')),
            trim((string)($actor['employeeId'] ?? ($actor['employee_id'] ?? '')))
        ])));

        $pdo->beginTransaction();
        try {
            $lStmt = $pdo->prepare('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1 FOR UPDATE');
            $lStmt->execute([$leaveId]);
            $lv = $lStmt->fetch(PDO::FETCH_ASSOC);
            if (!$lv) {
                throw new Exception('Leave application not found.', 404);
            }
            if (!$isAdminOrHr && !in_array((string)$lv['employee_id'], $myIdVariants, true)) {
                throw new Exception('Access denied: You can only cancel your own leave requests.', 403);
            }
            $prevStatus = strtoupper((string)($lv['status'] ?? 'PENDING'));
            if (!$isAdminOrHr && $prevStatus !== 'PENDING') {
                throw new Exception('Only pending leave applications can be cancelled by an employee.', 400);
            }

            if ($prevStatus === 'APPROVED') {
                $lType = strtoupper((string)($lv['leave_type'] ?? 'CASUAL'));
                $usedCol = ($lType === 'CASUAL') ? 'casual_used' : (($lType === 'SICK') ? 'sick_used' : (($lType === 'EARNED') ? 'earned_used' : 'unpaid_used'));
                $pdo->prepare("UPDATE `solar_leave_balances` SET `$usedCol` = GREATEST(0, `$usedCol` - ?) WHERE `employee_id` = ? AND `leave_year` = ?")
                    ->execute([floatval($lv['total_days'] ?? 0), $lv['employee_id'], intval($lv['leave_year'] ?? date('Y'))]);
            }

            $cancelRemarks = trim((string)($body['remarks'] ?? ($body['adminRemarks'] ?? '')));
            $pdo->prepare("UPDATE `solar_leave_requests` SET `status` = 'CANCELLED', `admin_remarks` = COALESCE(?, `admin_remarks`), `updated_at` = CURRENT_TIMESTAMP WHERE `id` = ?")
                ->execute([($cancelRemarks !== '' ? $cancelRemarks : null), $leaveId]);

            $uStmt = $pdo->prepare('SELECT * FROM `solar_leave_requests` WHERE `id` = ? LIMIT 1');
            $uStmt->execute([$leaveId]);
            $updatedRow = $uStmt->fetch(PDO::FETCH_ASSOC);
            $pdo->commit();

            http_response_code(200);
            echo json_encode(['success' => true, 'data' => mapLeaveRowPhp($updatedRow), 'message' => 'Leave application cancelled.']);
        } catch (Exception $inner) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $inner;
        }
    } catch (Exception $e) {
        $exCode = intval($e->getCode());
        $statusCode = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
        http_response_code($statusCode);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
    }
    exit;
}

// GET|POST /api/expenses
if (in_array($cleanPath, ['/expenses', '/expenses/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_expenses` ORDER BY `created_at` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) {
            return [
                'id' => $r['id'],
                'expenseNumber' => $r['expense_number'],
                'projectId' => $r['project_id'],
                'projectCode' => $r['project_code'] ?? '',
                'vendorName' => $r['vendor_name'],
                'category' => $r['category'],
                'amount' => floatval($r['amount'] ?? 0),
                'expenseDate' => $r['expense_date'],
                'date' => $r['expense_date'],
                'paymentMode' => $r['payment_mode'] ?? 'Bank Payment',
                'referenceNo' => $r['reference_no'] ?? '',
                'notes' => $r['notes'] ?? '',
                'receiptUrl' => $r['receipt_url'] ?? '',
                'approvedBy' => $r['approved_by'] ?? '',
                'expenseType' => $r['expense_type'] ?? 'DIRECT_EXPENSE',
                'status' => $r['status'] ?? 'PAID',
                'employeeId' => $r['employee_id'] ?? '',
                'employeeName' => $r['employee_name'] ?? '',
                'gstAmount' => floatval($r['gst_amount'] ?? 0),
                'itcEligible' => !empty($r['itc_eligible']),
                'bankAccountId' => $r['bank_account_id'] ?? '',
                'expenseAccountId' => $r['expense_account_id'] ?? '',
                'journalEntryId' => $r['journal_entry_id'] ?? '',
                'approvedAt' => $r['approved_at'] ?? '',
                'rejectionReason' => $r['rejection_reason'] ?? '',
                'paidAt' => $r['paid_at'] ?? '',
                'paidBy' => $r['paid_by'] ?? '',
                'tallySyncStatus' => $r['tally_sync_status'] ?? 'NOT SYNCED',
                'createdAt' => $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $saved = saveExpenseToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|POST|DELETE /api/expenses/{id}
if (preg_match('#^/expenses/([^/]+)/?$#', $cleanPath, $matches)) {
    $expId = urldecode($matches[1]);
    if ($expId !== 'import') {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        $actor = requireAuthUserPhp($pdo);

        if ($method === 'PUT' || $method === 'POST') {
            $body['id'] = $expId;
            $saved = saveExpenseToDb($pdo, $body);
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $saved]);
            exit;
        }
        if ($method === 'DELETE') {
            deleteItemFromDb($pdo, 'expenses', $expId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Expense deleted from MySQL.']);
            exit;
        }
    }
}

// Helpers: Projects, Control Center & Payments REST mapping

function getProjectsListPhp($pdo, $projectIdFilter = null) {
    $stagesByProject = [];
    if ($projectIdFilter !== null) {
        $sStmt = $pdo->prepare('SELECT * FROM `solar_project_stages` WHERE `project_id` = ? ORDER BY `stage_order` ASC');
        $sStmt->execute([$projectIdFilter]);
    } else {
        $sStmt = $pdo->query('SELECT * FROM `solar_project_stages` ORDER BY `stage_order` ASC');
    }
    while ($s = $sStmt->fetch(PDO::FETCH_ASSOC)) {
        $pId = $s['project_id'];
        if (!isset($stagesByProject[$pId])) $stagesByProject[$pId] = [];
        $stagesByProject[$pId][] = [
            'id' => $s['id'],
            'stageKey' => $s['stage_key'],
            'title' => $s['title'],
            'order' => intval($s['stage_order']),
            'department' => $s['department'],
            'assignedRole' => $s['assigned_role'],
            'assignedEmployeeId' => $s['assigned_employee_id'] ?? '',
            'assignedEmployeeName' => $s['assigned_employee_name'] ?? '',
            'assignedToName' => $s['assigned_employee_name'] ?? '',
            'status' => $s['status'] ?? 'NOT STARTED',
            'priority' => $s['priority'] ?? 'MEDIUM',
            'startDate' => $s['start_date'],
            'dueDate' => $s['due_date'],
            'completedDate' => $s['completed_date'],
            'checklist' => json_decode($s['checklist_json'] ?? '[]', true) ?: [],
            'photos' => json_decode($s['photos_json'] ?? '[]', true) ?: [],
            'documents' => json_decode($s['documents_json'] ?? '[]', true) ?: [],
            'gpsLocation' => json_decode($s['gps_location_json'] ?? 'null', true),
            'notes' => $s['notes'] ?? '',
            'approvedBy' => $s['approved_by'] ?? '',
            'rejectionReason' => $s['rejection_reason'] ?? '',
            'activities' => []
        ];
    }

    if ($projectIdFilter !== null) {
        $pStmt = $pdo->prepare('SELECT * FROM `solar_projects` WHERE `id` = ? LIMIT 1');
        $pStmt->execute([$projectIdFilter]);
    } else {
        $pStmt = $pdo->query('SELECT * FROM `solar_projects` ORDER BY `created_at` DESC');
    }
    $rows = $pStmt ? ($pStmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
    return array_map(function ($r) use ($stagesByProject) {
        $assignments = json_decode($r['assignments_json'] ?? '[]', true) ?: [];
        return [
            'id' => $r['id'],
            'projectCode' => $r['project_code'],
            'customerId' => $r['customer_id'],
            'customerName' => $r['customer_name'],
            'title' => $r['title'],
            'capacityKw' => floatval($r['capacity_kw'] ?? 0),
            'totalValue' => floatval($r['total_value'] ?? 0),
            'receivedInflow' => (isset($r['received_inflow']) && $r['received_inflow'] !== null) ? floatval($r['received_inflow']) : null,
            'status' => $r['status'] ?? 'PLANNING',
            'currentStageKey' => $r['current_stage_key'] ?? 'site_survey',
            'completionPercentage' => intval($r['completion_percentage'] ?? 0),
            'progressPercentage' => intval($r['completion_percentage'] ?? 0),
            'projectManagerId' => $r['project_manager_id'] ?? '',
            'projectManagerName' => $r['project_manager_name'] ?? '',
            'siteAddress' => $r['site_address'] ?? '',
            'city' => $r['city'] ?? 'Ahmedabad',
            'location' => !empty($r['city']) ? $r['city'] : ($r['site_address'] ?? ''),
            'inverterModel' => $r['inverter_model'] ?? '',
            'panelModel' => $r['panel_model'] ?? '',
            'structureType' => $r['structure_type'] ?? 'Elevated GI Structure',
            'startDate' => $r['start_date'],
            'expectedCompletionDate' => $r['expected_completion_date'],
            'notes' => $r['notes'] ?? '',
            'assignedUsers' => $assignments,
            'stages' => $stagesByProject[$r['id']] ?? [],
            'createdAt' => $r['created_at'],
            'updatedAt' => $r['updated_at']
        ];
    }, $rows);
}

function getPaymentsListPhp($pdo) {
    $stmt = $pdo->query('SELECT * FROM `solar_payments` ORDER BY `created_at` DESC');
    $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
    return array_map(function ($r) {
        return [
            'id' => $r['id'],
            'receiptNumber' => $r['receipt_number'],
            'projectId' => $r['project_id'],
            'customerId' => $r['customer_id'],
            'customerName' => $r['customer_name'],
            'milestone' => $r['milestone'],
            'amount' => floatval($r['amount'] ?? 0),
            'status' => $r['status'],
            'dueDate' => $r['due_date'],
            'paidDate' => $r['paid_date'],
            'paymentMode' => $r['payment_mode'] ?? 'Bank NEFT/RTGS',
            'transactionReference' => $r['transaction_reference'] ?? '',
            'notes' => $r['notes'] ?? '',
            'invoiceId' => $r['invoice_id'] ?? '',
            'invoiceNumber' => $r['invoice_number'] ?? '',
            'bankAccountId' => $r['bank_account_id'] ?? '',
            'journalEntryId' => $r['journal_entry_id'] ?? '',
            'tallySyncStatus' => $r['tally_sync_status'] ?? 'NOT SYNCED',
            'tallyReference' => $r['tally_reference'] ?? '',
            'createdAt' => $r['created_at']
        ];
    }, $rows);
}

function updateProjectControlCenterPhp($pdo, $projectId, $payload, $actor) {
    $existing = fetchExistingRowPhp($pdo, 'solar_projects', $projectId);
    if (!$existing) {
        return ['error' => "Project \"$projectId\" not found.", 'status' => 404];
    }

    $parseCleanNumberPhp = static function ($val) {
        if (is_int($val) || is_float($val)) return floatval($val);
        $cleaned = str_replace(',', '', trim((string)$val));
        if ($cleaned === '' || !is_numeric($cleaned)) return NAN;
        return floatval($cleaned);
    };

    $nextCapacity = array_key_exists('capacityKw', $payload)
        ? $parseCleanNumberPhp($payload['capacityKw'])
        : floatval($existing['capacity_kw'] ?? 0);
    if (!is_finite($nextCapacity) || $nextCapacity <= 0) {
        return ['error' => 'Project capacity must be greater than 0 kW.', 'status' => 400];
    }

    $nextTotalValue = array_key_exists('totalValue', $payload)
        ? round($parseCleanNumberPhp($payload['totalValue']), 2)
        : floatval($existing['total_value'] ?? 0);
    if (!is_finite($nextTotalValue) || $nextTotalValue < 0) {
        return ['error' => 'Total project/contract value cannot be negative.', 'status' => 400];
    }

    $hasCityKey = array_key_exists('city', $payload);
    $hasLocKey = array_key_exists('location', $payload);
    $nextCityRaw = $hasCityKey
        ? trim((string)($payload['city'] ?? ''))
        : ($hasLocKey ? trim((string)($payload['location'] ?? '')) : trim((string)($existing['city'] ?? '')));
    if ($hasCityKey && $nextCityRaw === '') {
        return ['error' => 'Site location cannot be empty.', 'status' => 400];
    }
    $nextCity = $nextCityRaw !== '' ? $nextCityRaw : ((string)($existing['city'] ?? '') ?: 'Not specified');

    $hasAddrKey = array_key_exists('siteAddress', $payload);
    $nextSiteAddress = $hasAddrKey
        ? trim((string)($payload['siteAddress'] ?? ''))
        : (string)($existing['site_address'] ?? '');

    $nextReceivedInflowCol = (isset($existing['received_inflow']) && $existing['received_inflow'] !== null)
        ? floatval($existing['received_inflow'])
        : null;

    if (array_key_exists('receivedInflow', $payload) && $payload['receivedInflow'] !== null && trim((string)$payload['receivedInflow']) !== '') {
        $parsedInflow = $parseCleanNumberPhp($payload['receivedInflow']);
        $targetInflow = is_finite($parsedInflow) ? round($parsedInflow, 2) : NAN;
        if (!is_finite($targetInflow) || $targetInflow < 0) {
            return ['error' => 'Received inflow must be a valid amount (0 or greater).', 'status' => 400];
        }

        $safeProjId = substr(preg_replace('/[^a-zA-Z0-9_-]/', '', (string)$projectId), 0, 56);
        $adjId = 'pay-cc-' . $safeProjId;
        $sumStmt = $pdo->prepare("SELECT COALESCE(SUM(`amount`), 0) AS total_paid FROM `solar_payments` WHERE `project_id` = ? AND `status` = 'PAID' AND `id` <> ?");
        $sumStmt->execute([$projectId, $adjId]);
        $sumRow = $sumStmt->fetch(PDO::FETCH_ASSOC);
        $otherPaidSum = round(floatval($sumRow['total_paid'] ?? 0), 2);

        if ($targetInflow >= $otherPaidSum - 0.009) {
            $delta = round(max(0, $targetInflow - $otherPaidSum), 2);
            if ($delta > 0.009) {
                $today = date('Y-m-d');
                $safeRecNo = 'CC-INF-' . substr(preg_replace('/[^a-zA-Z0-9_-]/', '', (string)$projectId), 0, 54);
                savePaymentToDb($pdo, [
                    'id' => $adjId,
                    'receiptNumber' => $safeRecNo,
                    'projectId' => $projectId,
                    'customerId' => $existing['customer_id'] ?? '',
                    'customerName' => $existing['customer_name'] ?? 'Customer',
                    'milestone' => 'Direct Inflow (Control Center)',
                    'amount' => $delta,
                    'status' => 'PAID',
                    'dueDate' => $today,
                    'paidDate' => $today,
                    'paymentMode' => 'Bank NEFT/RTGS',
                    'notes' => 'Updated by ' . ($actor['name'] ?? 'Admin') . ' in Control Center'
                ]);
            } else {
                $pdo->prepare('DELETE FROM `solar_payments` WHERE `id` = ?')->execute([$adjId]);
            }
            $nextReceivedInflowCol = null;
        } else {
            $pdo->prepare('DELETE FROM `solar_payments` WHERE `id` = ?')->execute([$adjId]);
            $nextReceivedInflowCol = $targetInflow;
        }
    }

    $pdo->prepare('UPDATE `solar_projects` SET `capacity_kw` = ?, `total_value` = ?, `received_inflow` = ?, `city` = ?, `site_address` = ? WHERE `id` = ?')
        ->execute([$nextCapacity, $nextTotalValue, $nextReceivedInflowCol, $nextCity, $nextSiteAddress, $projectId]);

    if (!empty($existing['customer_id']) && ($hasCityKey || $hasAddrKey || $hasLocKey)) {
        $custExisting = fetchExistingRowPhp($pdo, 'solar_customers', $existing['customer_id']);
        if ($custExisting) {
            $custCity = $nextCity ?: ($custExisting['city'] ?? '');
            $custAddr = $hasAddrKey ? $nextSiteAddress : ($custExisting['site_address'] ?? '');
            $pdo->prepare('UPDATE `solar_customers` SET `city` = ?, `site_address` = ? WHERE `id` = ?')
                ->execute([$custCity, $custAddr, $existing['customer_id']]);
        }
    }

    $updatedList = getProjectsListPhp($pdo, $projectId);
    $updatedProject = $updatedList[0] ?? null;
    $updatedCustomer = null;
    if (!empty($existing['customer_id'])) {
        $cRow = fetchExistingRowPhp($pdo, 'solar_customers', $existing['customer_id']);
        if ($cRow) {
            $updatedCustomer = [
                'id' => $cRow['id'],
                'customerCode' => $cRow['customer_code'],
                'name' => $cRow['name'],
                'companyName' => $cRow['company_name'] ?? '',
                'customerType' => $cRow['customer_type'] ?? 'Residential',
                'phone' => $cRow['phone'],
                'email' => $cRow['email'] ?? '',
                'siteAddress' => $cRow['site_address'] ?? '',
                'city' => $cRow['city'] ?? 'Ahmedabad',
                'state' => $cRow['state'] ?? 'Gujarat',
                'pincode' => $cRow['pincode'] ?? '',
                'gstNumber' => $cRow['gst_number'] ?? '',
                'electricityConsumerNo' => $cRow['electricity_consumer_no'] ?? '',
                'sanctionedLoadKw' => floatval($cRow['sanctioned_load_kw'] ?? 0),
                'status' => $cRow['status'] ?? 'ACTIVE',
                'activeProjectId' => $cRow['active_project_id'] ?? null,
                'createdAt' => $cRow['created_at'],
                'updatedAt' => $cRow['updated_at']
            ];
        }
    }

    return [
        'status' => 200,
        'data' => [
            'project' => $updatedProject,
            'customer' => $updatedCustomer,
            'payments' => getPaymentsListPhp($pdo)
        ]
    ];
}

// GET|POST /api/projects
if (in_array($cleanPath, ['/projects', '/projects/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'GET') {
        $items = getProjectsListPhp($pdo);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        if (isCustomerUserPhp($actor)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to projects.']);
            exit;
        }
        if (empty($body['id'])) $body['id'] = 'proj-' . round(microtime(true) * 1000);
        if (empty($body['projectCode'])) $body['projectCode'] = 'SOL-' . date('Y') . '-' . rand(100, 999);
        $saved = saveProjectToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|POST /api/projects/{id}/control-center or /api/projects/{id}/overview
if (preg_match('#^/projects/([^/]+)/(?:control-center|overview)/?$#', $cleanPath, $matches)) {
    $projId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to project financials and site details.']);
        exit;
    }
    $allowedRoles = ['ADMIN', 'SUPER ADMIN', 'PROJECT MANAGER', 'ACCOUNTANT', 'SALES MANAGER', 'SALES EXECUTIVE'];
    $roleUpper = strtoupper(trim((string)($actor['role'] ?? '')));
    if (!in_array($roleUpper, $allowedRoles, true)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Insufficient permissions to modify project capacity, contract value, inflow, or site location.']);
        exit;
    }

    if ($method === 'PUT' || $method === 'POST') {
        $res = updateProjectControlCenterPhp($pdo, $projId, $body, $actor);
        if (!empty($res['error'])) {
            http_response_code($res['status'] ?? 400);
            echo json_encode(['success' => false, 'error' => $res['error'], 'message' => $res['error']]);
            exit;
        }
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $res['data']]);
        exit;
    }
}

// POST /api/projects/{id}/stages/{stageKey}/photos - Persistent Stage Workflow Image Upload
if ($method === 'POST' && preg_match('#^/projects/([^/]+)/stages/([^/]+)/photos/?$#', $cleanPath, $matches)) {
    $projId = urldecode($matches[1]);
    $stageKey = urldecode($matches[2]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to project stages and photos.']);
        exit;
    }

    try {
        $decoded = validateAndDecodeUploadedPayloadPhp(
            $body['fileName'] ?? 'stage-photo.jpg',
            $body['fileData'] ?? ($body['photoData'] ?? ''),
            'image'
        );

        $pCheck = $pdo->prepare('SELECT `id`, `title` FROM `solar_projects` WHERE `id` = ? LIMIT 1');
        $pCheck->execute([$projId]);
        $projRow = $pCheck->fetch(PDO::FETCH_ASSOC);
        if (!$projRow) {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'Project not found in MySQL.', 'message' => 'Project not found in MySQL.']);
            exit;
        }

        $safeProjId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($projId));
        $safeStageKey = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($stageKey));
        $photoId = 'photo-' . round(microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(3)), 0, 5);
        $diskFileName = $photoId . '.' . $decoded['ext'];

        $uploadsRoot = resolveUploadsRootPhp();
        $stageDir = $uploadsRoot . '/projects/' . $safeProjId . '/' . $safeStageKey;
        if (!is_dir($stageDir)) {
            @mkdir($stageDir, 0755, true);
        }
        if (!is_dir($stageDir) || !is_writable($stageDir)) {
            throw new Exception('Project stage photo directory is not writable on server.', 500);
        }

        $fullPath = $stageDir . '/' . $diskFileName;
        if (@file_put_contents($fullPath, $decoded['buffer']) === false) {
            throw new Exception('Failed to save stage photo file on disk.', 500);
        }

        $relativePath = 'projects/' . $safeProjId . '/' . $safeStageKey . '/' . $diskFileName;
        $fileUrl = '/api/uploads/projects/' . rawurlencode($safeProjId) . '/' . rawurlencode($safeStageKey) . '/' . rawurlencode($diskFileName);
        $caption = trim((string)($body['caption'] ?? ''));
        if ($caption === '') {
            $caption = preg_replace('/\.[^.]+$/', '', $decoded['safeFileName']) ?: 'Site Photo';
        }
        $gpsCoords = trim((string)($body['gpsCoordinates'] ?? ''));
        $uploadedBy = trim((string)($actor['name'] ?? ($body['uploadedBy'] ?? 'Field Engineer')));

        $newPhoto = [
            'id' => $photoId,
            'url' => $fileUrl,
            'fileName' => $decoded['safeFileName'],
            'filePath' => $relativePath,
            'mimeType' => $decoded['mimeType'],
            'fileSize' => $decoded['fileSize'],
            'caption' => $caption,
            'uploadedBy' => $uploadedBy,
            'uploadedAt' => date('c'),
            'gpsCoordinates' => $gpsCoords
        ];

        $pdo->beginTransaction();
        $sStmt = $pdo->prepare('SELECT `id`, `photos_json`, `title` FROM `solar_project_stages` WHERE `project_id` = ? AND (`stage_key` = ? OR `id` = ?) LIMIT 1 FOR UPDATE');
        $sStmt->execute([$projId, $stageKey, $stageKey]);
        $stageRow = $sStmt->fetch(PDO::FETCH_ASSOC);

        if (!$stageRow) {
            $sId = $projId . '-' . $safeStageKey;
            $photos = [$newPhoto];
            $insStage = $pdo->prepare("
                INSERT INTO `solar_project_stages` (
                    `id`, `project_id`, `stage_key`, `title`, `stage_order`,
                    `department`, `assigned_role`, `status`, `priority`,
                    `checklist_json`, `photos_json`, `documents_json`
                ) VALUES (?, ?, ?, ?, 1, 'Operations', 'Technician', 'IN PROGRESS', 'MEDIUM', '[]', ?, '[]')
            ");
            $insStage->execute([$sId, $projId, $stageKey, ucwords(str_replace('_', ' ', $stageKey)), json_encode($photos)]);
        } else {
            $existingPhotos = json_decode((string)($stageRow['photos_json'] ?? '[]'), true);
            if (!is_array($existingPhotos)) $existingPhotos = [];
            $existingPhotos[] = $newPhoto;
            $photos = $existingPhotos;
            $updStage = $pdo->prepare('UPDATE `solar_project_stages` SET `photos_json` = ? WHERE `id` = ?');
            $updStage->execute([json_encode($photos), $stageRow['id']]);
        }
        $pdo->commit();

        http_response_code(200);
        echo json_encode([
            'success' => true,
            'message' => 'Stage workflow image uploaded and saved to MySQL.',
            'photo' => $newPhoto,
            'photos' => $photos
        ]);
        exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $exCode = intval($e->getCode());
        $code = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
        http_response_code($code);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
        exit;
    }
}

// DELETE /api/projects/{id}/stages/{stageKey}/photos/{photoId}
if ($method === 'DELETE' && preg_match('#^/projects/([^/]+)/stages/([^/]+)/photos/([^/]+)/?$#', $cleanPath, $matches)) {
    $projId = urldecode($matches[1]);
    $stageKey = urldecode($matches[2]);
    $photoId = urldecode($matches[3]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to project stages and photos.']);
        exit;
    }

    try {
        $pdo->beginTransaction();
        $sStmt = $pdo->prepare('SELECT `id`, `photos_json` FROM `solar_project_stages` WHERE `project_id` = ? AND (`stage_key` = ? OR `id` = ?) LIMIT 1 FOR UPDATE');
        $sStmt->execute([$projId, $stageKey, $stageKey]);
        $stageRow = $sStmt->fetch(PDO::FETCH_ASSOC);
        if (!$stageRow) {
            $pdo->rollBack();
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'Stage not found.']);
            exit;
        }
        $existingPhotos = json_decode((string)($stageRow['photos_json'] ?? '[]'), true);
        if (!is_array($existingPhotos)) $existingPhotos = [];
        $nextPhotos = [];
        foreach ($existingPhotos as $p) {
            if (($p['id'] ?? '') === $photoId) {
                if (!empty($p['filePath'])) {
                    $fp = resolveUploadFilePathPhp($p['filePath']);
                    if ($fp && file_exists($fp)) @unlink($fp);
                }
                continue;
            }
            $nextPhotos[] = $p;
        }
        $pdo->prepare('UPDATE `solar_project_stages` SET `photos_json` = ? WHERE `id` = ?')
            ->execute([json_encode($nextPhotos), $stageRow['id']]);
        $pdo->commit();

        http_response_code(200);
        echo json_encode(['success' => true, 'photos' => $nextPhotos, 'message' => 'Stage photo removed from server and MySQL.']);
        exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
        exit;
    }
}

// PUT|PATCH /api/projects/{id}/stages/{stageKey} - Dedicated Project Stage Update API
if (($method === 'PUT' || $method === 'PATCH') && preg_match('#^/projects/([^/]+)/stages/([^/]+)/?$#', $cleanPath, $matches)) {
    $projId = urldecode($matches[1]);
    $stageKey = urldecode($matches[2]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to project stages and progress.']);
        exit;
    }

    try {
        $list = getProjectsListPhp($pdo, $projId);
        if (empty($list)) {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => "Project \"$projId\" not found."]);
            exit;
        }
        $project = $list[0];
        $stages = $project['stages'] ?? [];
        $stageIndex = -1;
        foreach ($stages as $idx => $st) {
            if (($st['stageKey'] ?? '') === $stageKey || ($st['id'] ?? '') === $stageKey) {
                $stageIndex = $idx;
                break;
            }
        }
        if ($stageIndex === -1) {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => "Stage \"$stageKey\" not found in project \"$projId\"."]);
            exit;
        }

        $currentStage = $stages[$stageIndex];
        $updatedStage = array_merge($currentStage, $body);
        $nextStatus = $body['status'] ?? null;
        $today = date('Y-m-d');

        if ($nextStatus === 'COMPLETED' || $nextStatus === 'APPROVED') {
            for ($i = 0; $i < $stageIndex; $i++) {
                $priorStatus = $stages[$i]['status'] ?? 'NOT STARTED';
                if ($priorStatus !== 'COMPLETED' && $priorStatus !== 'APPROVED') {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'error' => 'Cannot complete stage before prior stages are completed.']);
                    exit;
                }
            }
            $updatedStage['completedDate'] = !empty($updatedStage['completedDate']) ? $updatedStage['completedDate'] : $today;
            $updatedStage['actualEndDate'] = !empty($updatedStage['actualEndDate']) ? $updatedStage['actualEndDate'] : $today;
            if ($nextStatus === 'APPROVED') {
                $updatedStage['approvedBy'] = $actor['name'] ?? 'Administrator';
                $updatedStage['approvedAt'] = $today;
            }
            if ($stageIndex + 1 < count($stages) && ($stages[$stageIndex + 1]['status'] ?? 'NOT STARTED') === 'NOT STARTED') {
                $stages[$stageIndex + 1]['status'] = 'IN PROGRESS';
                $stages[$stageIndex + 1]['startDate'] = $today;
                $project['currentStageKey'] = $stages[$stageIndex + 1]['stageKey'];
            }
        } elseif ($nextStatus === 'IN PROGRESS') {
            $project['currentStageKey'] = $currentStage['stageKey'];
            for ($j = $stageIndex + 1; $j < count($stages); $j++) {
                $stJ = $stages[$j]['status'] ?? 'NOT STARTED';
                if (in_array($stJ, ['IN PROGRESS', 'COMPLETED', 'APPROVED'], true)) {
                    $stages[$j]['status'] = 'NOT STARTED';
                    $stages[$j]['actualEndDate'] = null;
                    $stages[$j]['completedDate'] = null;
                    $stages[$j]['approvedBy'] = '';
                }
            }
        }

        $stages[$stageIndex] = $updatedStage;
        $totalStages = count($stages);
        $completedStages = 0;
        $hasDelayed = false;
        foreach ($stages as $s) {
            if (in_array($s['status'] ?? '', ['COMPLETED', 'APPROVED'], true)) $completedStages++;
            if (in_array($s['status'] ?? '', ['OVERDUE', 'BLOCKED'], true)) $hasDelayed = true;
        }
        $pct = $totalStages > 0 ? intval(round(($completedStages / $totalStages) * 100)) : 0;
        $project['completionPercentage'] = $pct;
        $project['progressPercentage'] = $pct;
        if ($totalStages > 0 && $completedStages === $totalStages) {
            $project['status'] = 'COMPLETED';
        } elseif ($hasDelayed) {
            $project['status'] = 'DELAYED';
        } elseif ($completedStages === 0) {
            $project['status'] = 'SURVEY';
        } elseif ($completedStages < 4) {
            $project['status'] = 'DESIGN & APPROVALS';
        } elseif ($completedStages < 10) {
            $project['status'] = 'CIVIL & STRUCTURE';
        } else {
            $project['status'] = 'INSTALLATION';
        }
        $project['stages'] = $stages;

        $pdo->beginTransaction();
        $saved = saveProjectToDb($pdo, $project);
        $pdo->commit();

        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved, 'message' => "Stage \"$stageKey\" updated successfully in MySQL."]);
        exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
        exit;
    }
}

// GET|PUT|POST|DELETE /api/projects/{id}
if (preg_match('#^/projects/([^/]+)/?$#', $cleanPath, $matches)) {
    $projId = urldecode($matches[1]);
    if ($projId !== 'import') {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        $actor = requireAuthUserPhp($pdo);

        if ($method === 'GET') {
            $list = getProjectsListPhp($pdo, $projId);
            if (empty($list)) {
                http_response_code(404);
                echo json_encode(['success' => false, 'error' => 'Project not found']);
                exit;
            }
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $list[0]]);
            exit;
        }
        if ($method === 'PUT' || $method === 'POST') {
            if (isCustomerUserPhp($actor)) {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to project stages and progress.']);
                exit;
            }
            if (array_key_exists('capacityKw', $body) && (!is_numeric($body['capacityKw']) || floatval($body['capacityKw']) <= 0)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => 'Project capacity must be greater than 0 kW.']);
                exit;
            }
            if (array_key_exists('totalValue', $body) && (!is_numeric($body['totalValue']) || floatval($body['totalValue']) < 0)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => 'Total project value cannot be negative.']);
                exit;
            }
            $body['id'] = $projId;
            $saved = saveProjectToDb($pdo, $body);
            http_response_code(200);
            echo json_encode(['success' => true, 'data' => $saved]);
            exit;
        }
        if ($method === 'DELETE') {
            if (isCustomerUserPhp($actor)) {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to projects.']);
                exit;
            }
            deleteItemFromDb($pdo, 'projects', $projId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Project deleted from MySQL.']);
            exit;
        }
    }
}

// GET|POST /api/payments
if (in_array($cleanPath, ['/payments', '/payments/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);

    if ($method === 'GET') {
        $items = getPaymentsListPhp($pdo);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        if (isCustomerUserPhp($actor)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot record payments directly.']);
            exit;
        }
        $saved = savePaymentToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// DELETE /api/payments/{id}
if (preg_match('#^/payments/([^/]+)/?$#', $cleanPath, $matches)) {
    $payId = urldecode($matches[1]);
    if ($payId !== 'import') {
        $pdo = getDbConnection($dbConfig);
        ensureRequiredTables($pdo);
        $actor = requireAuthUserPhp($pdo);
        if ($method === 'DELETE') {
            if (isCustomerUserPhp($actor)) {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot delete payment records.']);
                exit;
            }
            deleteItemFromDb($pdo, 'payments', $payId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Payment deleted from MySQL.']);
            exit;
        }
    }
}

// GET|POST /api/boms
if (in_array($cleanPath, ['/boms', '/boms/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT * FROM `solar_boms` ORDER BY `created_at` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) {
            $cap = floatval($r['system_capacity_kw'] ?? 0);
            $cost = floatval($r['total_estimated_cost'] ?? 0);
            return [
                'id' => $r['id'],
                'bomNumber' => $r['bom_number'],
                'projectId' => $r['project_id'],
                'projectCode' => $r['project_code'] ?? '',
                'projectTitle' => $r['project_title'],
                'customerName' => $r['customer_name'] ?? '',
                'capacityKw' => $cap,
                'systemCapacityKw' => $cap,
                'version' => $r['version'] ?? '1.0',
                'status' => $r['status'] ?? 'APPROVED',
                'warehouseId' => $r['warehouse_id'] ?? '',
                'warehouseName' => $r['warehouse_name'] ?? '',
                'stockAllocated' => (bool)($r['stock_allocated'] ?? 0),
                'ewayBillNumber' => $r['eway_bill_number'] ?? '',
                'ewayBillDate' => $r['eway_bill_date'] ?? '',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'totalCost' => $cost,
                'totalEstimatedCost' => $cost,
                'createdBy' => $r['created_by'] ?? '',
                'approvedBy' => $r['approved_by'] ?? '',
                'approvedAt' => $r['approved_at'] ?? null,
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $actor = requireAuthUserPhp($pdo);
        if (isCustomerUserPhp($actor)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to Bill of Materials.']);
            exit;
        }
        $saved = saveBOMToDb($pdo, $body);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// PUT|POST|DELETE /api/boms/{id}
if (preg_match('#^/boms/([^/]+)/?$#', $cleanPath, $matches)) {
    $bomId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to Bill of Materials.']);
        exit;
    }
    if ($method === 'PUT' || $method === 'POST') {
        $body['id'] = $bomId;
        $saved = saveBOMToDb($pdo, $body);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
    if ($method === 'DELETE') {
        deleteItemFromDb($pdo, 'boms', $bomId, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'BOM deleted from MySQL.']);
        exit;
    }
}

// GET|POST /api/purchase-orders
if (in_array($cleanPath, ['/purchase-orders', '/purchase-orders/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'GET') {
        $bankMap = getBankAccountNameMapPhp($pdo);
        $stmt = $pdo->query('SELECT * FROM `solar_purchase_orders` ORDER BY `created_at` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) use ($bankMap) {
            $receipts = json_decode($r['receipts_json'] ?? '[]', true) ?: [];
            $total = floatval($r['total_amount'] ?? 0);
            $paid = floatval($r['paid_amount'] ?? 0);
            $returned = floatval($r['returned_amount'] ?? 0);
            $refunded = floatval($r['refunded_amount'] ?? 0);
            $netPaid = round(max(0.0, $paid - $refunded), 2);
            $bal = isset($r['balance_amount']) && $r['balance_amount'] !== null && ($paid > 0 || $returned > 0 || floatval($r['balance_amount']) > 0)
                ? round(max(0.0, floatval($r['balance_amount'])), 2)
                : round(max(0.0, $total - $returned - $netPaid), 2);
            $bankId = (string)($r['bank_account_id'] ?? '');
            $billMeta = mapVendorBillsFromPoRowPhp($r);
            return [
                'id' => $r['id'],
                'purchaseNumber' => $r['po_number'],
                'poNumber' => $r['po_number'],
                'vendorId' => $r['vendor_id'],
                'vendorName' => $r['vendor_name'],
                'projectId' => $r['project_id'] ?? '',
                'projectTitle' => $r['project_title'] ?? '',
                'warehouseId' => $r['warehouse_id'] ?? '',
                'warehouseName' => $r['warehouse_name'] ?? '',
                'purchaseDate' => $r['po_date'],
                'orderDate' => $r['po_date'],
                'poDate' => $r['po_date'],
                'expectedDeliveryDate' => $r['expected_delivery_date'] ?? '',
                'paymentDueDate' => $r['payment_due_date'] ?? null,
                'invoiceReference' => $r['invoice_reference'] ?? '',
                'stockUpdated' => (bool)($r['stock_updated'] ?? 0),
                'receivedDate' => $r['received_date'] ?? null,
                'subtotal' => floatval($r['subtotal'] ?? 0),
                'gstAmount' => floatval($r['gst_amount'] ?? 0),
                'taxAmount' => floatval($r['gst_amount'] ?? 0),
                'totalAmount' => $total,
                'grandTotal' => $total,
                'paidAmount' => $paid,
                'returnedAmount' => $returned,
                'refundedAmount' => $refunded,
                'balanceAmount' => $bal,
                'bankAccountId' => $bankId,
                'bankAccountName' => $bankId !== '' ? ($bankMap[$bankId] ?? '') : '',
                'status' => $r['status'] ?? 'ISSUED',
                'paymentStatus' => $r['payment_status'] ?? 'PENDING',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'deliveryReceipts' => $receipts,
                'receipts' => $receipts,
                'vendorBills' => $billMeta['vendorBills'],
                'vendorBillUrl' => $billMeta['vendorBillUrl'],
                'vendorBillName' => $billMeta['vendorBillName'],
                'vendorBillMimeType' => $billMeta['vendorBillMimeType'],
                'vendorBillSize' => $billMeta['vendorBillSize'],
                'vendorBillUploadedAt' => $billMeta['vendorBillUploadedAt'],
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $actor = requireAuthUserPhp($pdo);
        if (isCustomerUserPhp($actor)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot manage purchase orders.']);
            exit;
        }
        $saved = savePurchaseOrderToDb($pdo, $body, $actor);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// POST /api/purchase-orders/{id}/bills - Upload Vendor Bill (PDF/JPG/JPEG/PNG)
if ($method === 'POST' && preg_match('#^/purchase-orders/([^/]+)/bills/?$#', $cleanPath, $matches)) {
    $poId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot upload vendor bills.']);
        exit;
    }

    try {
        $decoded = validateAndDecodeUploadedPayloadPhp(
            $body['fileName'] ?? 'vendor-bill.pdf',
            $body['fileData'] ?? '',
            'bill'
        );

        $safePoId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($poId));
        $billId = 'bill-' . round(microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(3)), 0, 5);
        $diskFileName = $billId . '_' . $decoded['safeFileName'];

        $uploadsRoot = resolveUploadsRootPhp();
        $poBillsDir = $uploadsRoot . '/purchase-bills/' . $safePoId;
        if (!is_dir($poBillsDir)) {
            @mkdir($poBillsDir, 0755, true);
        }
        if (!is_dir($poBillsDir) || !is_writable($poBillsDir)) {
            throw new Exception('Vendor bill upload directory is not writable on server.', 500);
        }

        $fullPath = $poBillsDir . '/' . $diskFileName;
        if (@file_put_contents($fullPath, $decoded['buffer']) === false) {
            throw new Exception('Failed to save vendor bill file to server disk.', 500);
        }

        $relativePath = 'purchase-bills/' . $safePoId . '/' . $diskFileName;
        $fileUrl = '/api/uploads/purchase-bills/' . rawurlencode($safePoId) . '/' . rawurlencode($diskFileName);
        $uploadedAt = date('c');
        $uploadedBy = trim((string)($actor['name'] ?? 'Purchase Manager'));

        $billRecord = [
            'id' => $billId,
            'fileName' => $decoded['safeFileName'],
            'fileUrl' => $fileUrl,
            'filePath' => $relativePath,
            'mimeType' => $decoded['mimeType'],
            'fileSize' => $decoded['fileSize'],
            'uploadedAt' => $uploadedAt,
            'uploadedBy' => $uploadedBy
        ];

        $allBills = [$billRecord];
        $pdo->beginTransaction();
        $chkStmt = $pdo->prepare('SELECT * FROM `solar_purchase_orders` WHERE `id` = ? LIMIT 1 FOR UPDATE');
        $chkStmt->execute([$poId]);
        $exPo = $chkStmt->fetch(PDO::FETCH_ASSOC);
        if ($exPo) {
            $existingInfo = mapVendorBillsFromPoRowPhp($exPo);
            $allBills = array_merge($existingInfo['vendorBills'], [$billRecord]);
            $primary = $allBills[0];
            $upd = $pdo->prepare('
                UPDATE `solar_purchase_orders`
                SET `vendor_bills_json` = ?, `vendor_bill_url` = ?, `vendor_bill_name` = ?, `vendor_bill_mime` = ?, `vendor_bill_size` = ?, `vendor_bill_uploaded_at` = ?
                WHERE `id` = ?
            ');
            $upd->execute([
                json_encode($allBills),
                $primary['fileUrl'],
                $primary['fileName'],
                $primary['mimeType'],
                intval($primary['fileSize']),
                $primary['uploadedAt'],
                $poId
            ]);
        }
        $pdo->commit();

        http_response_code(200);
        echo json_encode([
            'success' => true,
            'message' => 'Vendor bill uploaded and attached successfully.',
            'bill' => $billRecord,
            'vendorBills' => $allBills
        ]);
        exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $exCode = intval($e->getCode());
        $code = ($exCode >= 400 && $exCode < 600) ? $exCode : 500;
        http_response_code($code);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
        exit;
    }
}

// DELETE /api/purchase-orders/{id}/bills/{billId}
if ($method === 'DELETE' && preg_match('#^/purchase-orders/([^/]+)/bills/([^/]+)/?$#', $cleanPath, $matches)) {
    $poId = urldecode($matches[1]);
    $billId = urldecode($matches[2]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot delete vendor bills.']);
        exit;
    }

    try {
        $safePoId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($poId));
        $pdo->beginTransaction();
        $chkStmt = $pdo->prepare('SELECT * FROM `solar_purchase_orders` WHERE `id` = ? LIMIT 1 FOR UPDATE');
        $chkStmt->execute([$poId]);
        $exPo = $chkStmt->fetch(PDO::FETCH_ASSOC);

        $nextBills = [];
        if ($exPo) {
            $existingInfo = mapVendorBillsFromPoRowPhp($exPo);
            foreach ($existingInfo['vendorBills'] as $b) {
                if (($b['id'] ?? '') === $billId) {
                    if (!empty($b['filePath'])) {
                        $fp = resolveUploadFilePathPhp($b['filePath']);
                        if ($fp && file_exists($fp)) @unlink($fp);
                    }
                    continue;
                }
                $nextBills[] = $b;
            }
            $primary = $nextBills[0] ?? null;
            $pdo->prepare('
                UPDATE `solar_purchase_orders`
                SET `vendor_bills_json` = ?, `vendor_bill_url` = ?, `vendor_bill_name` = ?, `vendor_bill_mime` = ?, `vendor_bill_size` = ?, `vendor_bill_uploaded_at` = ?
                WHERE `id` = ?
            ')->execute([
                json_encode($nextBills),
                $primary ? $primary['fileUrl'] : '',
                $primary ? $primary['fileName'] : '',
                $primary ? $primary['mimeType'] : '',
                $primary ? intval($primary['fileSize']) : 0,
                $primary ? $primary['uploadedAt'] : '',
                $poId
            ]);
        } else {
            // Draft PO bill cleanup before PO is saved
            foreach (getUploadRootCandidatesPhp() as $root) {
                $dir = rtrim($root, '/\\') . '/purchase-bills/' . $safePoId;
                if (is_dir($dir)) {
                    $safeBillPrefix = preg_replace('/[^a-zA-Z0-9_-]/', '', $billId);
                    if ($safeBillPrefix !== '') {
                        foreach (glob($dir . '/' . $safeBillPrefix . '_*') ?: [] as $matchFile) {
                            if (is_file($matchFile)) @unlink($matchFile);
                        }
                    }
                }
            }
        }
        $pdo->commit();

        http_response_code(200);
        echo json_encode(['success' => true, 'vendorBills' => $nextBills, 'message' => 'Vendor bill deleted.']);
        exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => $e->getMessage(), 'message' => $e->getMessage()]);
        exit;
    }
}

// GET /api/uploads/projects/{projectId}/{stageKey}/{filename} - Authenticated Stage Image Streamer
if ($method === 'GET' && preg_match('#^/uploads/projects/([^/]+)/([^/]+)/([^/]+)/?$#', $cleanPath, $matches)) {
    $rawProj = urldecode($matches[1]);
    $rawStage = urldecode($matches[2]);
    $rawFile = urldecode($matches[3]);
    if (strpos($rawProj, '..') !== false || strpos($rawStage, '..') !== false || strpos($rawFile, '..') !== false) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid file path access request.']);
        exit;
    }

    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    $safeProjId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($rawProj));
    $safeStageKey = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($rawStage));
    $safeName = basename($rawFile);

    if (!userCanAccessProjectPhp($pdo, $actor, $rawProj) && !userCanAccessProjectPhp($pdo, $actor, $safeProjId)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: You do not have permission to view this project photo.']);
        exit;
    }

    $fullPath = resolveUploadFilePathPhp('projects/' . $safeProjId . '/' . $safeStageKey . '/' . $safeName);
    if (!$fullPath) {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'Stage photo not found on server.']);
        exit;
    }

    $ext = strtolower(pathinfo($safeName, PATHINFO_EXTENSION));
    $mimeMap = ['jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'];
    $mime = $mimeMap[$ext] ?? 'application/octet-stream';
    $disposition = !empty($_GET['download']) ? 'attachment' : 'inline';

    header_remove('Content-Type');
    header('Content-Type: ' . $mime);
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . filesize($fullPath));
    header('Content-Disposition: ' . $disposition . '; filename="' . str_replace('"', '', $safeName) . '"');
    header('Cache-Control: private, max-age=3600');
    readfile($fullPath);
    exit;
}

// GET /api/uploads/purchase-bills/{poId}/{filename} - Authenticated Vendor Bill Streamer
if ($method === 'GET' && preg_match('#^/uploads/purchase-bills/([^/]+)/([^/]+)/?$#', $cleanPath, $matches)) {
    $rawPo = urldecode($matches[1]);
    $rawFile = urldecode($matches[2]);
    if (strpos($rawPo, '..') !== false || strpos($rawFile, '..') !== false) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid file path access request.']);
        exit;
    }

    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot access vendor purchase bills.']);
        exit;
    }

    $safePoId = preg_replace('/[^a-zA-Z0-9_-]/', '_', basename($rawPo));
    $safeName = basename($rawFile);
    $fullPath = resolveUploadFilePathPhp('purchase-bills/' . $safePoId . '/' . $safeName);
    if (!$fullPath) {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'Vendor bill not found on server.']);
        exit;
    }

    $ext = strtolower(pathinfo($safeName, PATHINFO_EXTENSION));
    $mimeMap = ['pdf' => 'application/pdf', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png'];
    $mime = $mimeMap[$ext] ?? 'application/octet-stream';
    $disposition = !empty($_GET['download']) ? 'attachment' : 'inline';

    header_remove('Content-Type');
    header('Content-Type: ' . $mime);
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . filesize($fullPath));
    header('Content-Disposition: ' . $disposition . '; filename="' . str_replace('"', '', $safeName) . '"');
    header('Cache-Control: private, max-age=3600');
    readfile($fullPath);
    exit;
}

// POST /api/purchase-orders/{id}/payments
if ($method === 'POST' && preg_match('#^/purchase-orders/([^/]+)/payments/?$#', $cleanPath, $matches)) {
    $poId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot record vendor payments.']);
        exit;
    }
    require_once __DIR__ . '/accounting.php';
    try {
        $resData = accRecordPurchaseOrderPaymentPhp($pdo, $poId, $body, $actor);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $resData]);
        exit;
    } catch (Exception $e) {
        $code = intval($e->getCode());
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
        exit;
    }
}

// PUT|POST|DELETE /api/purchase-orders/{id}
if (preg_match('#^/purchase-orders/([^/]+)/?$#', $cleanPath, $matches)) {
    $poId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot manage purchase orders.']);
        exit;
    }
    if ($method === 'PUT' || $method === 'POST') {
        $body['id'] = $poId;
        $saved = savePurchaseOrderToDb($pdo, $body, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
    if ($method === 'DELETE') {
        try {
            deleteItemFromDb($pdo, 'purchase_orders', $poId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Purchase order deleted from MySQL.']);
            exit;
        } catch (Exception $e) {
            $code = intval($e->getCode());
            http_response_code(($code >= 400 && $code < 600) ? $code : 400);
            echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
            exit;
        }
    }
}

// GET|POST /api/sales-invoices
if (in_array($cleanPath, ['/sales-invoices', '/sales-invoices/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);

    if ($method === 'GET') {
        $bankMap = getBankAccountNameMapPhp($pdo);
        $stmt = $pdo->query('SELECT * FROM `solar_sales_invoices` ORDER BY `created_at` DESC');
        $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
        $items = array_map(function ($r) use ($bankMap) {
            $status = $r['payment_status'] ?? 'ISSUED';
            $gst = floatval($r['gst_amount'] ?? 0);
            $total = floatval($r['total_amount'] ?? 0);
            $paid = floatval($r['paid_amount'] ?? 0);
            $returned = floatval($r['returned_amount'] ?? 0);
            $refunded = floatval($r['refunded_amount'] ?? 0);
            $bal = floatval($r['balance_amount'] ?? 0);
            $bankId = (string)($r['bank_account_id'] ?? '');
            return [
                'id' => $r['id'],
                'invoiceNumber' => $r['invoice_number'],
                'invoiceType' => $r['invoice_type'] ?? 'TAX_INVOICE',
                'projectId' => $r['project_id'] ?? '',
                'projectTitle' => $r['project_title'] ?? '',
                'customerId' => $r['customer_id'],
                'customerName' => $r['customer_name'],
                'customerGst' => $r['customer_gst'] ?? '',
                'customerAddress' => $r['customer_address'] ?? '',
                'invoiceDate' => $r['invoice_date'],
                'dueDate' => $r['due_date'] ?? '',
                'paymentTerms' => $r['payment_terms'] ?? '15 Days Net',
                'items' => json_decode($r['items_json'] ?? '[]', true) ?: [],
                'subtotal' => floatval($r['subtotal'] ?? 0),
                'taxAmount' => $gst,
                'gstAmount' => $gst,
                'totalAmount' => $total,
                'grandTotal' => $total,
                'status' => $status,
                'paymentStatus' => $status,
                'paidAmount' => $paid,
                'amountPaid' => $paid,
                'returnedAmount' => $returned,
                'refundedAmount' => $refunded,
                'balanceAmount' => $bal,
                'balanceDue' => $bal,
                'bankAccountId' => $bankId,
                'bankAccountName' => $bankId !== '' ? ($bankMap[$bankId] ?? '') : '',
                'ewayBillNumber' => $r['eway_bill_number'] ?? '',
                'ewayBillDetails' => json_decode($r['eway_bill_details_json'] ?? 'null', true),
                'cgstAmount' => floatval($r['cgst_amount'] ?? 0),
                'sgstAmount' => floatval($r['sgst_amount'] ?? 0),
                'igstAmount' => floatval($r['igst_amount'] ?? 0),
                'einvoiceIrn' => $r['einvoice_irn'] ?? '',
                'einvoiceAckNo' => $r['einvoice_ack_no'] ?? '',
                'einvoiceAckDate' => $r['einvoice_ack_date'] ?? '',
                'einvoiceStatus' => $r['einvoice_status'] ?? 'NOT_GENERATED',
                'warehouseId' => $r['warehouse_id'] ?? '',
                'deductStock' => isset($r['deduct_stock']) ? (bool)$r['deduct_stock'] : true,
                'stockDeducted' => (bool)($r['stock_deducted'] ?? 0),
                'notes' => $r['notes'] ?? '',
                'createdAt' => $r['created_at'],
                'updatedAt' => $r['updated_at'] ?? $r['created_at']
            ];
        }, $rows);
        http_response_code(200);
        echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
        exit;
    }

    if ($method === 'POST') {
        $actor = requireAuthUserPhp($pdo);
        if (isCustomerUserPhp($actor)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to sales invoices.']);
            exit;
        }
        $saved = saveSalesInvoiceToDb($pdo, $body, $actor);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
}

// POST /api/sales-invoices/{id}/payments
if ($method === 'POST' && preg_match('#^/sales-invoices/([^/]+)/payments/?$#', $cleanPath, $matches)) {
    $invId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot record payments.']);
        exit;
    }
    require_once __DIR__ . '/accounting.php';
    try {
        $resData = accRecordSalesInvoicePaymentPhp($pdo, $invId, $body, $actor);
        http_response_code(201);
        echo json_encode(['success' => true, 'data' => $resData]);
        exit;
    } catch (Exception $e) {
        $code = intval($e->getCode());
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
        exit;
    }
}

// PUT|POST|DELETE /api/sales-invoices/{id}
if (preg_match('#^/sales-invoices/([^/]+)/?$#', $cleanPath, $matches)) {
    $invId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers have read-only access to sales invoices.']);
        exit;
    }
    if ($method === 'PUT' || $method === 'POST') {
        $body['id'] = $invId;
        $saved = saveSalesInvoiceToDb($pdo, $body, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'data' => $saved]);
        exit;
    }
    if ($method === 'DELETE') {
        try {
            deleteItemFromDb($pdo, 'sales_invoices', $invId, $actor);
            http_response_code(200);
            echo json_encode(['success' => true, 'message' => 'Sales invoice deleted from MySQL.']);
            exit;
        } catch (Exception $e) {
            $code = intval($e->getCode());
            http_response_code(($code >= 400 && $code < 600) ? $code : 400);
            echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
            exit;
        }
    }
}

// GET|POST /api/sales-returns
if (in_array($cleanPath, ['/sales-returns', '/sales-returns/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot manage sales returns.']);
        exit;
    }
    require_once __DIR__ . '/accounting.php';
    try {
        if ($method === 'GET') {
            $items = accGetSalesReturnsPhp($pdo);
            http_response_code(200);
            echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
            exit;
        }
        if ($method === 'POST') {
            $result = accCreateSalesReturnPhp($pdo, $body, $actor);
            http_response_code(201);
            echo json_encode(['success' => true, 'data' => $result]);
            exit;
        }
    } catch (Exception $e) {
        $code = intval($e->getCode());
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
        exit;
    }
}

// DELETE /api/sales-returns/{id}
if ($method === 'DELETE' && preg_match('#^/sales-returns/([^/]+)/?$#', $cleanPath, $matches)) {
    $srId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot delete sales returns.']);
        exit;
    }
    require_once __DIR__ . '/accounting.php';
    try {
        accDeleteSalesReturnPhp($pdo, $srId, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'Sales return reversed and deleted from MySQL.']);
        exit;
    } catch (Exception $e) {
        $code = intval($e->getCode());
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
        exit;
    }
}

// GET|POST /api/purchase-returns
if (in_array($cleanPath, ['/purchase-returns', '/purchase-returns/'], true)) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot manage purchase returns.']);
        exit;
    }
    require_once __DIR__ . '/accounting.php';
    try {
        if ($method === 'GET') {
            $items = accGetPurchaseReturnsPhp($pdo);
            http_response_code(200);
            echo json_encode(['success' => true, 'count' => count($items), 'data' => $items]);
            exit;
        }
        if ($method === 'POST') {
            $result = accCreatePurchaseReturnPhp($pdo, $body, $actor);
            http_response_code(201);
            echo json_encode(['success' => true, 'data' => $result]);
            exit;
        }
    } catch (Exception $e) {
        $code = intval($e->getCode());
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
        exit;
    }
}

// DELETE /api/purchase-returns/{id}
if ($method === 'DELETE' && preg_match('#^/purchase-returns/([^/]+)/?$#', $cleanPath, $matches)) {
    $prId = urldecode($matches[1]);
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    if (isCustomerUserPhp($actor)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Forbidden: Customers cannot delete purchase returns.']);
        exit;
    }
    require_once __DIR__ . '/accounting.php';
    try {
        accDeletePurchaseReturnPhp($pdo, $prId, $actor);
        http_response_code(200);
        echo json_encode(['success' => true, 'message' => 'Purchase return reversed and deleted from MySQL.']);
        exit;
    } catch (Exception $e) {
        $code = intval($e->getCode());
        http_response_code(($code >= 400 && $code < 600) ? $code : 400);
        echo json_encode(['success' => false, 'message' => $e->getMessage(), 'error' => $e->getMessage()]);
        exit;
    }
}

// /api/accounting/* (Accounting & Finance Module)
if (strpos($cleanPath, '/accounting') === 0) {
    $pdo = getDbConnection($dbConfig);
    ensureRequiredTables($pdo);
    $actor = requireAuthUserPhp($pdo);
    require_once __DIR__ . '/accounting.php';
    handleAccountingRoutePhp($pdo, $cleanPath, $method, $body, $actor);
    exit;
}

// Default 404 for unhandled API routes (Always returns JSON, NEVER index.html)
http_response_code(404);
echo json_encode([
    'success' => false,
    'error' => 'API endpoint not found',
    'path' => $parsedPath,
    'method' => $method
]);
exit;
