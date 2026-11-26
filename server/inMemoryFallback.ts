import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { DEFAULT_SYSTEM_ACL_CONFIG } from '../src/services/aclDefaults';
import { buildStandardWorkflowStages } from '../src/services/workflowStages';
import { sanitizeEmailConfig, EmailSettingsRecord, SanitizedEmailSettings, SmtpSecurity } from './services/emailService';

const nowIso = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

interface InMemoryUserRecord {
  id: string;
  name: string;
  email: string;
  password: string;
  role: string;
  phone: string;
  department: string;
  designation: string;
  employeeId?: string;
  customerId?: string;
  isFieldWorker: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_SETTINGS = {
  companyName: 'SOLAR URJA ERP',
  companyAddress: 'PLOT NO- 14, STREET NO- 14B, PRAGATI NAGAR, RISALI BHILAI, Chhattisgarh 490006',
  companyPhone: '+91 98250 12345',
  companyEmail: 'support@solar.klyiatechnology.com',
  companyGst: '22AAOCR0748K1Z5',
  logoUrl: '/assets/aistudio/solar_urja_logo_07b84efe.jpeg',
  currencySymbol: '₹',
  taxRatePercent: 18,
  tallyServerUrl: '',
  tallyCompany: 'Solar Urja 2026-27',
  tallyStatus: 'NOT CONFIGURED',
  whatsAppStatus: 'SANDBOX_READY'
};

const SEED_STAFF: Array<{
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  aliasEmail?: string;
  password: string;
  role: string;
  department: string;
  designation: string;
  phone: string;
  isFieldWorker: boolean;
  salaryMonthly: number;
}> = [
  { id: 'usr-admin-1', employeeCode: 'EMP-001', name: 'Vikram Patel', email: 'admin@solar.klyiatechnology.com', password: 'SolarAdmin@2026', role: 'Admin', department: 'Administration', designation: 'Lead Administrator', phone: '+91 98250 10001', isFieldWorker: false, salaryMonthly: 95000 },
  { id: 'usr-salesmgr-1', employeeCode: 'EMP-002', name: 'Priya Verma', email: 'salesmanager@solar.klyiatechnology.com', password: 'SolarSales@2026', role: 'Sales Manager', department: 'Sales', designation: 'Sales Manager - C&I', phone: '+91 98250 10002', isFieldWorker: false, salaryMonthly: 65000 },
  { id: 'usr-pm-1', employeeCode: 'EMP-003', name: 'Amit Sharma', email: 'projectmanager@solar.klyiatechnology.com', password: 'SolarProject@2026', role: 'Project Manager', department: 'Operations', designation: 'Senior Project Manager', phone: '+91 98250 10003', isFieldWorker: false, salaryMonthly: 72000 },
  { id: 'usr-survey-1', employeeCode: 'EMP-004', name: 'Rajesh Kumar', email: 'surveyor@solar.klyiatechnology.com', aliasEmail: 'survey@solar.klyiatechnology.com', password: 'SolarSurvey@2026', role: 'Site Survey Engineer', department: 'Engineering', designation: 'Lead Site Survey Engineer', phone: '+91 98250 10004', isFieldWorker: true, salaryMonthly: 42000 },
  { id: 'usr-insp-1', employeeCode: 'EMP-005', name: 'Hardik Shah', email: 'inspector@solar.klyiatechnology.com', aliasEmail: 'siteinspector@solar.klyiatechnology.com', password: 'SolarInspect@2026', role: 'Site Inspector', department: 'Engineering', designation: 'Senior Site Inspector & Auditor', phone: '+91 98250 10005', isFieldWorker: true, salaryMonthly: 45000 },
  { id: 'usr-civil-1', employeeCode: 'EMP-006', name: 'Suresh Patel', email: 'civil@solar.klyiatechnology.com', aliasEmail: 'civilteam@solar.klyiatechnology.com', password: 'SolarCivil@2026', role: 'Civil Team', department: 'Civil', designation: 'Civil Foundations Lead', phone: '+91 98250 10006', isFieldWorker: true, salaryMonthly: 35000 },
  { id: 'usr-elec-1', employeeCode: 'EMP-007', name: 'Ankit Joshi', email: 'electrical@solar.klyiatechnology.com', aliasEmail: 'electricalteam@solar.klyiatechnology.com', password: 'SolarElec@2026', role: 'Electrical Team', department: 'Electrical', designation: 'Senior Electrical Engineer', phone: '+91 98250 10007', isFieldWorker: true, salaryMonthly: 44000 },
  { id: 'usr-inst-1', employeeCode: 'EMP-008', name: 'Manoj Tiwari', email: 'installation@solar.klyiatechnology.com', aliasEmail: 'installationteam@solar.klyiatechnology.com', password: 'SolarInstall@2026', role: 'Installation Team', department: 'Installation', designation: 'Module Installation Lead', phone: '+91 98250 10008', isFieldWorker: true, salaryMonthly: 37000 },
  { id: 'usr-hr-1', employeeCode: 'EMP-009', name: 'Neha Gupta', email: 'hr@solar.klyiatechnology.com', aliasEmail: 'hrmanager@solar.klyiatechnology.com', password: 'SolarHr@2026', role: 'HR Manager', department: 'HR', designation: 'HR & Admin Manager', phone: '+91 98250 10009', isFieldWorker: false, salaryMonthly: 52000 },
  { id: 'usr-acc-1', employeeCode: 'EMP-010', name: 'Sneha Kulkarni', email: 'accounts@solar.klyiatechnology.com', aliasEmail: 'accountant@solar.klyiatechnology.com', password: 'SolarAccounts@2026', role: 'Accountant', department: 'Finance', designation: 'Accounts Manager & Tally Specialist', phone: '+91 98250 10010', isFieldWorker: false, salaryMonthly: 55000 },
  { id: 'usr-sales-1', employeeCode: 'EMP-011', name: 'Rahul Mehta', email: 'sales@solar.klyiatechnology.com', password: 'SolarSalesExec@2026', role: 'Sales Executive', department: 'Sales', designation: 'Solar Sales Executive', phone: '+91 98250 10011', isFieldWorker: false, salaryMonthly: 38000 },
  { id: 'usr-struct-1', employeeCode: 'EMP-012', name: 'Dinesh Yadav', email: 'structure@solar.klyiatechnology.com', password: 'SolarStruct@2026', role: 'Structure Team', department: 'Structure', designation: 'Structure Fabrication Lead', phone: '+91 98250 10012', isFieldWorker: true, salaryMonthly: 36000 },
  { id: 'usr-srv-1', employeeCode: 'EMP-013', name: 'Rohit Verma', email: 'service@solar.klyiatechnology.com', password: 'SolarService@2026', role: 'Service Manager', department: 'Service', designation: 'Service Manager', phone: '+91 98250 10013', isFieldWorker: false, salaryMonthly: 48000 },
  { id: 'usr-tech-1', employeeCode: 'EMP-014', name: 'Ketan Solanki', email: 'technician@solar.klyiatechnology.com', password: 'SolarTech@2026', role: 'Technician', department: 'Service', designation: 'Field Service Technician', phone: '+91 98250 10014', isFieldWorker: true, salaryMonthly: 32000 }
];

const DEFAULT_COA = [
  { id: 'acc-1010', code: '1010', name: 'Cash in Hand (Petty Cash)', accountType: 'ASSET', subType: 'Cash', isSystem: true, isActive: true, openingBalance: 50000, currentBalance: 50000, description: 'Physical office & site petty cash register' },
  { id: 'acc-1020', code: '1020', name: 'Primary Current Bank Account', accountType: 'ASSET', subType: 'Bank', isSystem: true, isActive: true, openingBalance: 1250000, currentBalance: 1750000, description: 'Primary operating corporate bank account' },
  { id: 'acc-1100', code: '1100', name: 'Accounts Receivable (Sundry Debtors)', accountType: 'ASSET', subType: 'Current Asset', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 450000, description: 'Customer EPC milestone & sales receivables' },
  { id: 'acc-1150', code: '1150', name: 'Input GST Credit (ITC Receivable)', accountType: 'ASSET', subType: 'Tax Asset', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 45000, description: 'Eligible CGST/SGST/IGST Input Tax Credit on purchases' },
  { id: 'acc-1200', code: '1200', name: 'Solar Inventory & Stock-in-Hand', accountType: 'ASSET', subType: 'Inventory', isSystem: true, isActive: true, openingBalance: 850000, currentBalance: 850000, description: 'Modules, inverters, BOS & warehouse stock valuation' },
  { id: 'acc-1500', code: '1500', name: 'Fixed Assets - Plant, Tools & Vehicles', accountType: 'ASSET', subType: 'Fixed Asset', isSystem: true, isActive: true, openingBalance: 400000, currentBalance: 400000, description: 'Capitalized tools, site vehicles, office equipment' },
  { id: 'acc-1590', code: '1590', name: 'Accumulated Depreciation', accountType: 'ASSET', subType: 'Contra Asset', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Cumulative depreciation on capitalized fixed assets' },
  { id: 'acc-2010', code: '2010', name: 'Accounts Payable (Sundry Creditors)', accountType: 'LIABILITY', subType: 'Current Liability', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 180000, description: 'Vendor bills & supplier payables' },
  { id: 'acc-2100', code: '2100', name: 'Output GST Payable', accountType: 'LIABILITY', subType: 'Tax Liability', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 90000, description: 'CGST/SGST/IGST collected on sales invoices' },
  { id: 'acc-2150', code: '2150', name: 'TDS Payable', accountType: 'LIABILITY', subType: 'Tax Liability', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Tax deducted at source pending government challan deposit' },
  { id: 'acc-2200', code: '2200', name: 'Payroll & Salary Payable', accountType: 'LIABILITY', subType: 'Current Liability', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Accrued monthly employee salaries & reimbursements' },
  { id: 'acc-2300', code: '2300', name: 'Customer Advance & Booking Deposits', accountType: 'LIABILITY', subType: 'Current Liability', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Unbilled milestone advances received from customers' },
  { id: 'acc-3010', code: '3010', name: 'Share Capital / Owner Equity', accountType: 'EQUITY', subType: 'Capital', isSystem: true, isActive: true, openingBalance: 2550000, currentBalance: 2550000, description: 'Paid-up share capital and owner equity' },
  { id: 'acc-3020', code: '3020', name: 'Retained Earnings & Reserves', accountType: 'EQUITY', subType: 'Reserves', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Accumulated prior-period earnings' },
  { id: 'acc-4010', code: '4010', name: 'Solar EPC Installation Revenue', accountType: 'REVENUE', subType: 'Operating Revenue', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 950000, description: 'Revenue from rooftop & ground-mount EPC contracts' },
  { id: 'acc-4020', code: '4020', name: 'AMC & Service Maintenance Revenue', accountType: 'REVENUE', subType: 'Operating Revenue', isSystem: true, openingBalance: 0, currentBalance: 25000, description: 'Annual maintenance contracts & paid service visits' },
  { id: 'acc-4030', code: '4030', name: 'Vendor Sales & Equipment Trading Revenue', accountType: 'REVENUE', subType: 'Operating Revenue', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'B2B solar equipment sales to vendors/partners' },
  { id: 'acc-4090', code: '4090', name: 'Other Income / Asset Disposal Gain-Loss', accountType: 'REVENUE', subType: 'Other Income', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Miscellaneous income and fixed asset disposal variance' },
  { id: 'acc-5010', code: '5010', name: 'Cost of Solar Equipment & Materials (COGS)', accountType: 'EXPENSE', subType: 'Direct Cost', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 250000, description: 'PV panels, inverters, structures, cables & BOS procurement' },
  { id: 'acc-5020', code: '5020', name: 'Site Execution & Subcontractor Costs', accountType: 'EXPENSE', subType: 'Direct Cost', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 45000, description: 'Civil, mounting, electrical labor & net-metering permits' },
  { id: 'acc-5030', code: '5030', name: 'Salaries, Wages & Payroll Expense', accountType: 'EXPENSE', subType: 'Operating Expense', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Employee monthly salaries, overtime & incentives' },
  { id: 'acc-5040', code: '5040', name: 'Travel, Fuel & Field Operations Expense', accountType: 'EXPENSE', subType: 'Operating Expense', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 12000, description: 'Site travel, logistics, fuel & employee reimbursements' },
  { id: 'acc-5050', code: '5050', name: 'Office Rent, Utilities & Admin Overheads', accountType: 'EXPENSE', subType: 'Operating Expense', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 18000, description: 'Rent, electricity, software, marketing & general overheads' },
  { id: 'acc-5060', code: '5060', name: 'Depreciation & Amortization Expense', accountType: 'EXPENSE', subType: 'Non-Cash Expense', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'SLM/WDV periodic fixed asset depreciation' },
  { id: 'acc-5090', code: '5090', name: 'Bank Charges & Loss on Asset Disposal', accountType: 'EXPENSE', subType: 'Other Expense', isSystem: true, isActive: true, openingBalance: 0, currentBalance: 0, description: 'Bank transaction fees & write-off losses' }
];

class InMemoryDatabaseStore {
  private users: InMemoryUserRecord[] = [];
  private employees: any[] = [];
  private employeeDocs: Map<string, any[]> = new Map();
  private customers: any[] = [];
  private leads: any[] = [];
  private projects: any[] = [];
  private payments: any[] = [];
  private expenses: any[] = [];
  private products: any[] = [];
  private vendors: any[] = [];
  private purchaseOrders: any[] = [];
  private boms: any[] = [];
  private salesInvoices: any[] = [];
  private vendorSalesInvoices: any[] = [];
  private salesReturns: any[] = [];
  private purchaseReturns: any[] = [];
  private warehouses: any[] = [];
  private stockMovements: any[] = [];
  private stockAudits: any[] = [];
  private attendance: any[] = [];
  private payslips: any[] = [];
  private holidays: any[] = [];
  private leaveRequests: any[] = [];
  private leaveBalances: any[] = [];
  private quotations: any[] = [];
  private surveys: any[] = [];
  private serviceTickets: any[] = [];
  private serviceTicketHistory: any[] = [];
  private amcContracts: any[] = [];
  private notifications: any[] = [];
  private settings: Record<string, any> = { ...DEFAULT_SETTINGS };
  private emailSettings: EmailSettingsRecord | null = null;
  private aclConfig: Record<string, any> = JSON.parse(JSON.stringify(DEFAULT_SYSTEM_ACL_CONFIG));
  private aclAuditLogs: any[] = [];
  private workforceLocations: Map<string, any> = new Map();

  // Accounting state
  private accAccounts: any[] = [];
  private accJournals: any[] = [];
  private accBankAccounts: any[] = [];
  private accBankTransfers: any[] = [];
  private accBankReconciliations: any[] = [];
  private accVendorBills: any[] = [];
  private accVendorPayments: any[] = [];
  private accTdsEntries: any[] = [];
  private accBudgets: any[] = [];
  private accFixedAssets: any[] = [];
  private accDepreciationLogs: any[] = [];
  private accAuditLogs: any[] = [];
  private accSettings: any = {
    id: 'default',
    fiscalYearStartMonth: 4,
    activeFiscalYear: '2026-27',
    lockDate: null,
    currency: 'INR',
    approvalThreshold: 10000,
    requireExpenseApproval: true,
    autoPostErpVouchers: true,
    journalPrefix: 'JV-',
    billPrefix: 'BILL-',
    voucherPrefix: 'VOU-',
    defaultCashAccountId: 'acc-1010',
    defaultBankAccountId: 'acc-1020',
    defaultArAccountId: 'acc-1100',
    defaultApAccountId: 'acc-2010',
    defaultSalesAccountId: 'acc-4010',
    defaultCogsAccountId: 'acc-5010',
    defaultOutputGstAccountId: 'acc-2100',
    defaultInputGstAccountId: 'acc-1150',
    defaultTdsAccountId: 'acc-2150',
    defaultPayrollAccountId: 'acc-5030',
    defaultDepExpenseAccountId: 'acc-5060',
    defaultDisposalGainLossAccountId: 'acc-4090',
    updatedBy: 'System',
    updatedAt: nowIso()
  };

  constructor() {
    this.seedInitialData();
  }

  private seedInitialData(): void {
    const ts = nowIso();
    const today = todayStr();
    const customerDemoHash = bcrypt.hashSync('SolarCustomer@2026', 10);

    // 1. Seed Users & Employees with Solar Urja ERP demo credentials
    this.users = [];
    this.employees = [];
    for (const s of SEED_STAFF) {
      const staffHash = bcrypt.hashSync(s.password, 10);
      this.users.push({
        id: s.id,
        name: s.name,
        email: s.email,
        password: staffHash,
        role: s.role,
        phone: s.phone,
        department: s.department,
        designation: s.designation,
        employeeId: s.employeeCode,
        isFieldWorker: s.isFieldWorker,
        status: 'ACTIVE',
        createdAt: ts,
        updatedAt: ts
      });

      if (s.aliasEmail) {
        this.users.push({
          id: `${s.id}-alias`,
          name: s.name,
          email: s.aliasEmail,
          password: staffHash,
          role: s.role,
          phone: s.phone,
          department: s.department,
          designation: s.designation,
          employeeId: s.employeeCode,
          isFieldWorker: s.isFieldWorker,
          status: 'ACTIVE',
          createdAt: ts,
          updatedAt: ts
        });
      }

      this.employees.push({
        id: s.id,
        employeeCode: s.employeeCode,
        name: s.name,
        photoUrl: '',
        documents: [],
        department: s.department,
        designation: s.designation,
        phone: s.phone,
        email: s.email,
        joiningDate: '2025-04-01',
        salaryMonthly: s.salaryMonthly,
        salary: s.salaryMonthly,
        status: 'ACTIVE',
        currentSiteLocation: s.isFieldWorker ? 'Bhilai Sector-10 Site' : 'Bhilai Head Office',
        esicNumber: '',
        bankAccountNumber: '',
        bankName: 'HDFC Bank',
        ifscCode: 'HDFC0001234',
        emergencyContactPerson: '',
        emergencyContactNumber: '',
        loginEnabled: true,
        authUid: s.id,
        systemRole: s.role,
        assignedRole: s.role,
        isFieldWorker: s.isFieldWorker,
        accountStatus: 'ACTIVE',
        accountCreatedAt: ts,
        accountCreatedBy: 'System',
        createdAt: ts,
        updatedAt: ts
      });
    }

    // Seed Customer User
    this.users.push({
      id: 'usr-cust-abc-1',
      name: 'ABC Industries Ltd.',
      email: 'customer@solar.klyiatechnology.com',
      password: customerDemoHash,
      role: 'Customer',
      phone: '+91 98261 44556',
      department: 'Customer',
      designation: 'Client Representative',
      customerId: 'cust-abc-1',
      isFieldWorker: false,
      status: 'ACTIVE',
      createdAt: ts,
      updatedAt: ts
    });

    // 2. Seed Customers
    this.customers = [
      {
        id: 'cust-abc-1',
        customerCode: 'CUST-1001',
        name: 'ABC Industries Ltd.',
        companyName: 'ABC Industries Pvt. Ltd.',
        customerType: 'Commercial',
        phone: '+91 98261 44556',
        email: 'customer@solar.klyiatechnology.com',
        password: customerDemoHash,
        siteAddress: 'Plot 42, Heavy Industrial Area, Hathkhoj, Bhilai',
        city: 'Bhilai',
        state: 'Chhattisgarh',
        pincode: '490026',
        gstNumber: '22AABCA1234D1Z5',
        electricityConsumerNo: 'CSPDCL-10045892',
        sanctionedLoadKw: 120,
        status: 'ACTIVE',
        activeProjectId: 'proj-1001',
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'cust-rameshwar-2',
        customerCode: 'CUST-1002',
        name: 'Rameshwar Patel',
        companyName: '',
        customerType: 'Residential',
        phone: '+91 98261 77889',
        email: 'rameshwar.patel@example.com',
        password: customerDemoHash,
        siteAddress: 'House 18, Smriti Nagar, Bhilai',
        city: 'Bhilai',
        state: 'Chhattisgarh',
        pincode: '490020',
        gstNumber: '',
        electricityConsumerNo: 'CSPDCL-10078123',
        sanctionedLoadKw: 8,
        status: 'ACTIVE',
        activeProjectId: 'proj-1002',
        createdAt: ts,
        updatedAt: ts
      }
    ];

    // 3. Seed Projects with 14 Standard Workflow Stages
    this.projects = [
      {
        id: 'proj-1001',
        projectCode: 'PRJ-2026-001',
        customerId: 'cust-abc-1',
        customerName: 'ABC Industries Ltd.',
        title: 'ABC Industries 50 kW On-Grid Industrial Rooftop',
        capacityKw: 50,
        totalValue: 2250000,
        receivedInflow: null,
        status: 'INSTALLATION',
        currentStageKey: 'solar_installation',
        completionPercentage: 54,
        progressPercentage: 54,
        projectManagerId: 'usr-pm-1',
        projectManagerName: 'Amit Sharma',
        siteAddress: 'Plot 42, Heavy Industrial Area, Hathkhoj, Bhilai',
        city: 'Bhilai',
        inverterModel: 'Sungrow SG50CX-P2 (50kW)',
        panelModel: 'Waaree 550Wp Mono PERC Bifacial',
        structureType: 'Elevated HDG Industrial Truss',
        startDate: '2026-10-15',
        expectedCompletionDate: '2026-12-20',
        notes: 'Priority C&I industrial rooftop installation with net-metering.',
        assignments: [
          { role: 'Project Manager', employeeId: 'usr-pm-1', employeeName: 'Amit Sharma', assignedAt: ts },
          { role: 'Site Survey Engineer', employeeId: 'usr-survey-1', employeeName: 'Rajesh Kumar', assignedAt: ts },
          { role: 'Installation Team', employeeId: 'usr-inst-1', employeeName: 'Manoj Tiwari', assignedAt: ts },
          { role: 'Electrical Team', employeeId: 'usr-elec-1', employeeName: 'Ankit Joshi', assignedAt: ts }
        ],
        stages: buildStandardWorkflowStages('proj-1001', 50, '68_PERCENT'),
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'proj-1002',
        projectCode: 'PRJ-2026-002',
        customerId: 'cust-rameshwar-2',
        customerName: 'Rameshwar Patel',
        title: 'Rameshwar Patel 5 kW PM Surya Ghar Residential',
        capacityKw: 5,
        totalValue: 285000,
        receivedInflow: null,
        status: 'SURVEY',
        currentStageKey: 'site_survey',
        completionPercentage: 14,
        progressPercentage: 14,
        projectManagerId: 'usr-pm-1',
        projectManagerName: 'Amit Sharma',
        siteAddress: 'House 18, Smriti Nagar, Bhilai',
        city: 'Bhilai',
        inverterModel: 'Growatt MIN 5000TL-X (5kW)',
        panelModel: 'Adani 540Wp Mono PERC',
        structureType: 'Elevated GI Rooftop Structure',
        startDate: '2026-11-10',
        expectedCompletionDate: '2026-12-30',
        notes: 'Residential subsidy application submitted.',
        assignments: [
          { role: 'Project Manager', employeeId: 'usr-pm-1', employeeName: 'Amit Sharma', assignedAt: ts },
          { role: 'Site Survey Engineer', employeeId: 'usr-survey-1', employeeName: 'Rajesh Kumar', assignedAt: ts }
        ],
        stages: buildStandardWorkflowStages('proj-1002', 5, 'STAGE_2'),
        createdAt: ts,
        updatedAt: ts
      }
    ];

    // 4. Seed Leads
    this.leads = [
      {
        id: 'lead-1001',
        customerName: 'Maheshwari Cold Storage',
        companyName: 'Maheshwari Agro Foods',
        phone: '+91 98271 33445',
        email: 'maheshwari.agro@example.com',
        address: 'Industrial Estate, Urla, Raipur',
        city: 'Raipur',
        solarCapacityKw: 100,
        estimatedValue: 4200000,
        source: 'Referral',
        assignedSalespersonId: 'usr-salesmgr-1',
        assignedSalespersonName: 'Priya Verma',
        status: 'PROPOSAL SENT',
        notes: 'High daytime refrigeration load; ideal for 100kW on-grid.',
        nextFollowUpDate: today,
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'lead-1002',
        customerName: 'Dr. Anjali Deshmukh',
        companyName: 'Deshmukh Diagnostics',
        phone: '+91 94252 66778',
        email: 'anjali.deshmukh@example.com',
        address: 'Civic Centre, Bhilai',
        city: 'Bhilai',
        solarCapacityKw: 15,
        estimatedValue: 750000,
        source: 'Website',
        assignedSalespersonId: 'usr-sales-1',
        assignedSalespersonName: 'Rahul Mehta',
        status: 'SITE SURVEY SCHEDULED',
        notes: 'Needs hybrid backup support for diagnostic lab.',
        nextFollowUpDate: today,
        createdAt: ts,
        updatedAt: ts
      }
    ];

    // 5. Seed Warehouses & Products & Vendors
    this.warehouses = [
      {
        id: 'wh-bhilai-1',
        code: 'WH-BHL-01',
        name: 'Bhilai Central Solar Depot',
        location: 'Hathkhoj Industrial Area, Bhilai',
        city: 'Bhilai',
        state: 'Chhattisgarh',
        managerName: 'Amit Sharma',
        phone: '+91 98250 10004',
        email: 'depot.bhilai@solar.klyiatechnology.com',
        capacitySqFt: 18000,
        status: 'ACTIVE',
        isDefault: true,
        notes: 'Primary EPC equipment & module staging warehouse',
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'wh-raipur-2',
        code: 'WH-RPR-02',
        name: 'Raipur Logistics Hub',
        location: 'Urla Industrial Complex, Raipur',
        city: 'Raipur',
        state: 'Chhattisgarh',
        managerName: 'Manoj Tiwari',
        phone: '+91 98250 10010',
        email: 'depot.raipur@solar.klyiatechnology.com',
        capacitySqFt: 12000,
        status: 'ACTIVE',
        isDefault: false,
        notes: 'Regional hub for C&I projects',
        createdAt: ts,
        updatedAt: ts
      }
    ];

    this.vendors = [
      {
        id: 'ven-waaree-1',
        vendorCode: 'VND-001',
        name: 'Waaree Energies Authorized Dist.',
        contactPerson: 'Sandeep Shah',
        phone: '+91 98201 55667',
        email: 'dispatch@waareedist.example.com',
        address: 'GIDC Sachin, Surat',
        city: 'Surat',
        state: 'Gujarat',
        gstNumber: '24AAACW1234F1Z2',
        panNumber: 'AAACW1234F',
        paymentTerms: '30 Days Net',
        category: 'PV Modules',
        rating: 4.9,
        status: 'ACTIVE',
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'ven-sungrow-2',
        vendorCode: 'VND-002',
        name: 'Sungrow Power India Distributors',
        contactPerson: 'Nikhil Rao',
        phone: '+91 98111 77889',
        email: 'orders@sungrowdist.example.com',
        address: 'Cyber Hub Phase II, Gurugram',
        city: 'Gurugram',
        state: 'Haryana',
        gstNumber: '06AAACS5678G1Z9',
        panNumber: 'AAACS5678G',
        paymentTerms: '15 Days Net',
        category: 'Inverters & BOS',
        rating: 4.8,
        status: 'ACTIVE',
        createdAt: ts,
        updatedAt: ts
      }
    ];

    this.products = [
      {
        id: 'prod-1',
        sku: 'MOD-WAR-550BF',
        name: 'Waaree 550Wp Mono PERC Bifacial PV Module',
        category: 'Solar Panels',
        brand: 'Waaree',
        hsnCode: '85414300',
        unit: 'NOS',
        unitPrice: 13200,
        sellingPrice: 15500,
        gstRate: 12,
        stockQuantity: 180,
        reorderLevel: 40,
        warehouseId: 'wh-bhilai-1',
        warehouseName: 'Bhilai Central Solar Depot',
        warehouseStocks: { 'wh-bhilai-1': 140, 'wh-raipur-2': 40 },
        preferredVendorId: 'ven-waaree-1',
        preferredVendorName: 'Waaree Energies Authorized Dist.',
        status: 'ACTIVE',
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'prod-2',
        sku: 'INV-SUN-50KW',
        name: 'Sungrow SG50CX-P2 50kW On-Grid String Inverter',
        category: 'Inverters',
        brand: 'Sungrow',
        hsnCode: '85044090',
        unit: 'NOS',
        unitPrice: 165000,
        sellingPrice: 195000,
        gstRate: 12,
        stockQuantity: 6,
        reorderLevel: 2,
        warehouseId: 'wh-bhilai-1',
        warehouseName: 'Bhilai Central Solar Depot',
        warehouseStocks: { 'wh-bhilai-1': 4, 'wh-raipur-2': 2 },
        preferredVendorId: 'ven-sungrow-2',
        preferredVendorName: 'Sungrow Power India Distributors',
        status: 'ACTIVE',
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'prod-3',
        sku: 'BOS-ACDB-50KW',
        name: '50kW 3-Phase ACDB & Surge Protection Panel',
        category: 'BOS & Electrical',
        brand: 'L&T / Schneider',
        hsnCode: '85371000',
        unit: 'SET',
        unitPrice: 28000,
        sellingPrice: 35000,
        gstRate: 18,
        stockQuantity: 12,
        reorderLevel: 4,
        warehouseId: 'wh-bhilai-1',
        warehouseName: 'Bhilai Central Solar Depot',
        warehouseStocks: { 'wh-bhilai-1': 10, 'wh-raipur-2': 2 },
        preferredVendorId: 'ven-sungrow-2',
        preferredVendorName: 'Sungrow Power India Distributors',
        status: 'ACTIVE',
        createdAt: ts,
        updatedAt: ts
      }
    ];

    // 6. Seed Payments, Expenses, Quotations, Surveys, Tickets, AMC, Holidays, Notifications
    this.payments = [
      {
        id: 'pay-1001',
        receiptNumber: 'RCPT-2026-001',
        projectId: 'proj-1001',
        projectTitle: 'ABC Industries 50 kW On-Grid Industrial Rooftop',
        customerId: 'cust-abc-1',
        customerName: 'ABC Industries Ltd.',
        milestone: 'Advance Booking & Engineering (40%)',
        amount: 900000,
        status: 'PAID',
        dueDate: '2026-10-18',
        paidDate: '2026-10-18',
        paymentMode: 'Bank NEFT/RTGS',
        referenceNo: 'UTR202610189981',
        notes: 'Initial advance milestone received',
        createdAt: ts
      },
      {
        id: 'pay-1002',
        receiptNumber: 'RCPT-2026-002',
        projectId: 'proj-1001',
        projectTitle: 'ABC Industries 50 kW On-Grid Industrial Rooftop',
        customerId: 'cust-abc-1',
        customerName: 'ABC Industries Ltd.',
        milestone: 'Material Dispatch & Mounting (40%)',
        amount: 900000,
        status: 'PENDING',
        dueDate: '2026-11-30',
        paidDate: null,
        paymentMode: 'Bank NEFT/RTGS',
        referenceNo: '',
        notes: 'Due upon solar panel delivery at site',
        createdAt: ts
      }
    ];

    this.expenses = [
      {
        id: 'exp-1001',
        voucherNumber: 'EXP-2026-001',
        projectId: 'proj-1001',
        projectTitle: 'ABC Industries 50 kW On-Grid Industrial Rooftop',
        category: 'Site Execution & Labor',
        description: 'Crane & hoisting charges for 50kW structure & modules',
        amount: 18500,
        gstAmount: 0,
        itcEligible: false,
        date: '2026-11-05',
        expenseDate: '2026-11-05',
        paymentMode: 'Bank NEFT/RTGS',
        vendorName: 'Bhilai Crane Services',
        status: 'PAID',
        expenseType: 'DIRECT_EXPENSE',
        createdAt: ts
      }
    ];

    this.quotations = [
      {
        id: 'qtn-1001',
        quotationNumber: 'RSP-QTN-2026-27-0010',
        leadId: 'lead-1001',
        customerId: 'cust-abc-1',
        customerName: 'Maheshwari Cold Storage',
        customerEmail: 'maheshwari.agro@example.com',
        customerPhone: '+91 98271 33445',
        siteAddress: 'Industrial Estate, Urla, Raipur',
        city: 'Raipur',
        systemCapacityKw: 100,
        systemType: 'On-Grid Commercial Rooftop',
        panelBrand: 'Waaree 550Wp Mono PERC Bifacial',
        inverterBrand: 'Sungrow 100kW String Inverter',
        structureType: 'HDG Elevated Structure',
        baseAmount: 3750000,
        gstAmount: 450000,
        totalAmount: 4200000,
        subsidyAmount: 0,
        netPayable: 4200000,
        validityDays: 15,
        status: 'SENT',
        quotationDate: today,
        createdAt: ts,
        updatedAt: ts
      }
    ];

    this.surveys = [
      {
        id: 'srv-1001',
        projectId: 'proj-1002',
        customerId: 'cust-rameshwar-2',
        customerName: 'Rameshwar Patel',
        surveyorId: 'usr-survey-1',
        surveyorName: 'Rajesh Kumar',
        surveyDate: '2026-11-12',
        roofType: 'RCC Flat Roof',
        roofAreaSqFt: 650,
        orientation: 'True South (180°)',
        tiltAngle: 21,
        shadingIssues: 'Minimal morning shadow on NE parapet (cleared by elevated structure)',
        sanctionedLoadKw: 8,
        recommendedCapacityKw: 5,
        gpsCoordinates: '21.1938, 81.3509',
        status: 'APPROVED',
        notes: 'Suitable for 5kW elevated GI rooftop plant.',
        createdAt: ts,
        updatedAt: ts
      }
    ];

    this.serviceTickets = [
      {
        id: 'tkt-1001',
        ticketId: 'SRV-2026-001',
        customerId: 'cust-abc-1',
        customerName: 'ABC Industries Ltd.',
        projectId: 'proj-1001',
        projectTitle: 'ABC Industries 50 kW On-Grid Industrial Rooftop',
        issue: 'Pre-commissioning string VOC balance verification & earthing test',
        category: 'Inspection & Testing',
        priority: 'MEDIUM',
        assignedTechnicianId: 'usr-tech-1',
        assignedTechnicianName: 'Ketan Solanki',
        status: 'ASSIGNED',
        scheduledDate: today,
        notes: 'Verify earth pit resistance < 2 Ohms before DISCOM inspection.',
        technicianRemarks: 'Scheduled site visit with digital earth tester.',
        resolutionDetails: '',
        photos: [],
        createdAt: ts,
        updatedAt: ts
      }
    ];

    this.amcContracts = [
      {
        id: 'amc-1001',
        amcCode: 'AMC-2026-001',
        customerId: 'cust-abc-1',
        customerName: 'ABC Industries Ltd.',
        projectId: 'proj-1001',
        projectTitle: 'ABC Industries 50 kW On-Grid Industrial Rooftop',
        planName: 'Comprehensive C&I Annual O&M + Cleaning',
        startDate: '2026-12-01',
        endDate: '2027-11-30',
        renewalDate: '2027-11-15',
        annualAmount: 48000,
        visitsCompleted: 0,
        totalVisits: 4,
        status: 'ACTIVE',
        createdAt: ts
      }
    ];

    this.holidays = [
      { id: 'hol-1', name: 'Republic Day', date: '2026-01-26', holidayDate: '2026-01-26', type: 'NATIONAL', description: 'National Holiday' },
      { id: 'hol-2', name: 'Independence Day', date: '2026-08-15', holidayDate: '2026-08-15', type: 'NATIONAL', description: 'National Holiday' },
      { id: 'hol-3', name: 'Diwali', date: '2026-11-08', holidayDate: '2026-11-08', type: 'FESTIVAL', description: 'Festival Holiday' }
    ];

    this.notifications = [
      {
        id: 'notif-1',
        title: 'Solar Urja ERP Workspace Ready',
        message: 'All ERP, CRM, HRMS, Inventory & Finance modules for solar.klyiatechnology.com are active.',
        type: 'INFO',
        isRead: false,
        createdAt: ts
      }
    ];

    // 7. Seed Accounting Workspace
    this.accAccounts = JSON.parse(JSON.stringify(DEFAULT_COA));
    this.accBankAccounts = [
      {
        id: 'bank-hdfc-primary',
        accountName: 'HDFC Corporate Current A/C',
        accountType: 'BANK',
        bankName: 'HDFC Bank',
        accountNumber: '50200044112233',
        ifscCode: 'HDFC0001234',
        branch: 'Civic Centre, Bhilai',
        coaAccountId: 'acc-1020',
        openingBalance: 1250000,
        currentBalance: 1750000,
        isPrimary: true,
        isActive: true,
        createdAt: ts,
        updatedAt: ts
      },
      {
        id: 'bank-petty-cash',
        accountName: 'Head Office Petty Cash Register',
        accountType: 'CASH',
        bankName: 'Cash',
        accountNumber: 'CASH-HO-01',
        ifscCode: '',
        branch: 'Risali, Bhilai',
        coaAccountId: 'acc-1010',
        openingBalance: 50000,
        currentBalance: 50000,
        isPrimary: false,
        isActive: true,
        createdAt: ts,
        updatedAt: ts
      }
    ];
    this.accJournals = [
      {
        id: 'je-seed-1',
        entryNumber: 'JV-2026-0001',
        entryDate: '2026-10-18',
        referenceType: 'CUSTOMER_RECEIPT',
        referenceId: 'pay-1001',
        referenceNumber: 'RCPT-2026-001',
        narration: 'Advance milestone received from ABC Industries Ltd. (PRJ-2026-001)',
        totalDebit: 900000,
        totalCredit: 900000,
        status: 'POSTED',
        postedBy: 'Sneha Kulkarni',
        postedAt: ts,
        createdBy: 'Sneha Kulkarni',
        lines: [
          { id: 'jel-1', journalId: 'je-seed-1', lineOrder: 1, accountId: 'acc-1020', accountCode: '1020', accountName: 'Primary Current Bank Account', description: 'NEFT Advance', projectId: 'proj-1001', projectTitle: 'ABC Industries 50 kW On-Grid Industrial Rooftop', partyType: 'CUSTOMER', partyId: 'cust-abc-1', partyName: 'ABC Industries Ltd.', debit: 900000, credit: 0 },
          { id: 'jel-2', journalId: 'je-seed-1', lineOrder: 2, accountId: 'acc-1100', accountCode: '1100', accountName: 'Accounts Receivable (Sundry Debtors)', description: 'Advance adjusted', projectId: 'proj-1001', projectTitle: 'ABC Industries 50 kW On-Grid Industrial Rooftop', partyType: 'CUSTOMER', partyId: 'cust-abc-1', partyName: 'ABC Industries Ltd.', debit: 0, credit: 900000 }
        ],
        createdAt: ts,
        updatedAt: ts
      }
    ];
  }

  private verifyPasswordSync(plain: string, storedHashOrPlain: string): boolean {
    const clean = String(plain || '').trim();
    if (!clean || !storedHashOrPlain) return false;
    if (storedHashOrPlain.startsWith('$2a$') || storedHashOrPlain.startsWith('$2b$') || storedHashOrPlain.startsWith('$2y$')) {
      return bcrypt.compareSync(clean, storedHashOrPlain);
    }
    return clean === storedHashOrPlain;
  }

  // ==========================================================
  // AUTH & USERS
  // ==========================================================
  public async getAdminRegistrationStatus(): Promise<{ allowPublicRegistration: boolean; adminCount: number }> {
    const admins = this.users.filter(u => ['Admin', 'Super Admin'].includes(u.role) && u.status === 'ACTIVE');
    return { allowPublicRegistration: admins.length === 0, adminCount: admins.length };
  }

  public async registerAdmin(data: any, isAuthorizedByAdmin: boolean = false): Promise<any> {
    const cleanEmail = String(data?.email || '').trim().toLowerCase();
    const cleanName = String(data?.name || '').trim();
    const cleanPass = String(data?.password || '').trim();
    if (!cleanName || !cleanEmail.includes('@') || cleanPass.length < 6) {
      throw new Error('Valid name, email, and password (min 6 chars) are required.');
    }
    const status = await this.getAdminRegistrationStatus();
    if (!status.allowPublicRegistration && !isAuthorizedByAdmin) {
      throw new Error('Public administrator registration is closed. Additional administrators must be created by an existing authorized Administrator.');
    }
    if (this.users.some(u => u.email.toLowerCase() === cleanEmail)) {
      throw new Error('An account with this email address already exists.');
    }
    const id = `usr-admin-${Date.now()}`;
    const empCode = `EMP-ADM-${Math.floor(100 + Math.random() * 900)}`;
    const hash = await bcrypt.hash(cleanPass, 10);
    const ts = nowIso();
    const u: InMemoryUserRecord = {
      id,
      name: cleanName,
      email: cleanEmail,
      password: hash,
      role: 'Admin',
      phone: data.phone || '',
      department: data.department || 'Administration',
      designation: data.designation || 'Lead Administrator',
      employeeId: empCode,
      isFieldWorker: false,
      status: 'ACTIVE',
      createdAt: ts,
      updatedAt: ts
    };
    this.users.push(u);
    const { password: _p, ...sanitized } = u;
    return sanitized;
  }

  public async verifyCredentials(email: string, pass: string): Promise<any | null> {
    return this.authenticateUser(email, pass);
  }

  public async authenticateUser(email: string, pass: string): Promise<any | null> {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(pass || '').trim();
    if (!cleanEmail || !cleanPass) return null;

    const u = this.users.find(x => x.email.toLowerCase() === cleanEmail);
    if (u && this.verifyPasswordSync(cleanPass, u.password)) {
      const st = String(u.status || 'ACTIVE').toUpperCase();
      if (['DISABLED', 'INACTIVE', 'TERMINATED', 'SUSPENDED'].includes(st)) {
        throw new Error('This account has been disabled. Please contact system administrator.');
      }
      const upperRole = String(u.role || '').trim().toUpperCase();
      const accountType = upperRole === 'CUSTOMER' ? 'CUSTOMER' : (upperRole === 'ADMIN' || upperRole === 'SUPER ADMIN' ? 'ADMIN' : 'EMPLOYEE');
      return {
        id: u.id,
        userId: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        phone: u.phone,
        department: u.department,
        designation: u.designation,
        employeeId: u.employeeId || u.id,
        customerId: u.customerId,
        isFieldWorker: Boolean(u.isFieldWorker),
        accountType,
        status: u.status
      };
    }

    const c = this.customers.find(x => String(x.email || '').toLowerCase() === cleanEmail);
    if (c && this.verifyPasswordSync(cleanPass, c.password || '')) {
      const st = String(c.status || 'ACTIVE').toUpperCase();
      if (['DISABLED', 'INACTIVE'].includes(st)) {
        throw new Error('This account has been disabled. Please contact system administrator.');
      }
      return {
        id: `usr-${c.id}`,
        userId: `usr-${c.id}`,
        customerId: c.id,
        employeeId: `CUST-${c.id}`,
        name: c.name,
        email: c.email,
        role: 'Customer',
        phone: c.phone || '',
        department: 'Customer Portal',
        designation: 'Customer',
        isFieldWorker: false,
        accountType: 'CUSTOMER',
        status: c.status || 'ACTIVE'
      };
    }

    return null;
  }

  public async findUserByIdOrEmail(idOrEmail: string): Promise<any | null> {
    if (!idOrEmail) return null;
    const clean = String(idOrEmail).trim().toLowerCase();
    const u = this.users.find(x => x.id === idOrEmail || x.email.toLowerCase() === clean);
    if (u) {
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        phone: u.phone,
        department: u.department,
        designation: u.designation,
        employeeId: u.employeeId,
        customerId: u.customerId,
        isFieldWorker: Boolean(u.isFieldWorker),
        status: u.status || 'ACTIVE'
      };
    }
    const cleanCustId = idOrEmail.startsWith('usr-') ? idOrEmail.slice(4) : idOrEmail;
    const c = this.customers.find(x => x.id === cleanCustId || String(x.email || '').toLowerCase() === clean);
    if (c) {
      return {
        id: `usr-${c.id}`,
        customerId: c.id,
        name: c.name,
        email: c.email,
        role: 'Customer',
        phone: c.phone || '',
        department: 'Customer',
        designation: 'Customer',
        isFieldWorker: false,
        status: c.status || 'ACTIVE'
      };
    }
    return null;
  }

  public async getUsers(): Promise<any[]> {
    return this.users.map(({ password: _p, ...rest }) => rest);
  }

  public async saveUser(item: any, options?: { updateOnly?: boolean }): Promise<any> {
    const cleanEmail = String(item.email || '').trim().toLowerCase();
    const isUpdateOnly = Boolean(options?.updateOnly);
    const existingIdx = this.users.findIndex(
      u => u.id === item.id || (!isUpdateOnly && cleanEmail && u.email.toLowerCase() === cleanEmail)
    );
    const existing = existingIdx >= 0 ? this.users[existingIdx] : null;

    if (isUpdateOnly && !existing) {
      const emp = this.employees.find(e => e.id === item.id || e.authUid === item.id);
      if (!emp) {
        const err: any = new Error(`User record "${item.id}" not found.`);
        err.statusCode = 404;
        throw err;
      }
    }

    const rawPass = item.password || item.tempPassword;
    let password = existing?.password || bcrypt.hashSync('123456', 10);
    if (rawPass && typeof rawPass === 'string' && rawPass.trim().length >= 6) {
      const p = rawPass.trim();
      password = p.startsWith('$2') ? p : await bcrypt.hash(p, 10);
    }

    const loginDisabledExplicit = item.loginEnabled === false || item.login_enabled === 0 || item.login_enabled === false;
    const status = loginDisabledExplicit ? 'DISABLED' : (item.status ?? existing?.status ?? 'ACTIVE');
    const role = item.role ?? item.systemRole ?? existing?.role ?? 'Technician';
    const rawFw = item.isFieldWorker !== undefined ? item.isFieldWorker : item.is_field_worker;

    const record: InMemoryUserRecord = {
      id: existing?.id || item.id || `usr-${Date.now()}`,
      name: item.name ?? existing?.name ?? 'Solar User',
      email: cleanEmail || existing?.email || `${item.id}@solar.klyiatechnology.com`,
      password,
      role,
      phone: item.phone ?? existing?.phone ?? '',
      department: item.department ?? existing?.department ?? 'Operations',
      designation: item.designation ?? existing?.designation ?? role,
      employeeId: item.employeeId ?? item.employee_id ?? item.employeeCode ?? existing?.employeeId,
      customerId: item.customerId ?? existing?.customerId,
      isFieldWorker: rawFw !== undefined ? Boolean(rawFw) : (existing?.isFieldWorker ?? false),
      status,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso()
    };

    if (existingIdx >= 0) this.users[existingIdx] = record;
    else this.users.push(record);

    // Sync corresponding employee if non-customer
    if (record.role !== 'Customer') {
      const empIdx = this.employees.findIndex(e => e.id === record.id || e.authUid === record.id || (record.employeeId && e.employeeCode === record.employeeId));
      if (empIdx >= 0) {
        this.employees[empIdx] = {
          ...this.employees[empIdx],
          name: record.name,
          email: record.email,
          phone: record.phone,
          department: record.department,
          designation: record.designation,
          systemRole: record.role,
          assignedRole: record.role,
          isFieldWorker: record.isFieldWorker,
          loginEnabled: status !== 'DISABLED',
          status: status === 'DISABLED' ? 'INACTIVE' : 'ACTIVE',
          accountStatus: status
        };
      }
    }

    const { password: _p, ...sanitized } = record;
    return sanitized;
  }

  public async deleteUser(id: string): Promise<boolean> {
    this.users = this.users.filter(u => u.id !== id);
    return this.deleteEmployee(id);
  }

  public async updateUserPassword(id: string, newPass: string): Promise<boolean> {
    const clean = String(newPass || '').trim();
    if (clean.length < 6) throw new Error('Password must be at least 6 characters long.');
    const hashed = await bcrypt.hash(clean, 10);
    const cleanIdLower = String(id || '').trim().toLowerCase();
    const matchedEmp = this.employees.find(e => e.id === id || e.authUid === id || String(e.email || '').toLowerCase() === cleanIdLower);
    const matchEmails = new Set<string>([cleanIdLower]);
    if (matchedEmp?.email) matchEmails.add(String(matchedEmp.email).toLowerCase());

    let updated = false;
    for (const u of this.users) {
      if (
        u.id === id ||
        (matchedEmp && (u.id === matchedEmp.authUid || (matchedEmp.employeeCode && u.employeeId === matchedEmp.employeeCode))) ||
        matchEmails.has(u.email.toLowerCase())
      ) {
        u.password = hashed;
        u.updatedAt = nowIso();
        updated = true;
      }
    }
    return updated;
  }

  public async changeUserPassword(userId: string, oldPass: string, newPass: string): Promise<{ success: boolean; message: string }> {
    const u = this.users.find(x => x.id === userId);
    if (!u) throw new Error('User account not found.');
    if (!this.verifyPasswordSync(oldPass, u.password)) throw new Error('Current password does not match.');
    if (String(newPass || '').trim().length < 6) throw new Error('New password must be at least 6 characters long.');
    u.password = await bcrypt.hash(newPass.trim(), 10);
    u.updatedAt = nowIso();
    return { success: true, message: 'Password changed successfully.' };
  }

  public async resetUserPassword(email: string, newPass: string): Promise<{ success: boolean; message: string }> {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(newPass || '').trim();
    if (cleanPass.length < 6) throw new Error('Explicit new password (minimum 6 characters) is required.');
    const hashed = await bcrypt.hash(cleanPass, 10);
    const u = this.users.find(x => x.email.toLowerCase() === cleanEmail);
    if (u) u.password = hashed;
    const c = this.customers.find(x => String(x.email || '').toLowerCase() === cleanEmail);
    if (c) c.password = hashed;
    return { success: true, message: `Password for ${cleanEmail} reset successfully.` };
  }

  // ==========================================================
  // CUSTOMERS & LEADS
  // ==========================================================
  private upsertInArray(arr: any[], item: any): any {
    const ts = nowIso();
    const record = { ...item, updatedAt: ts, createdAt: item.createdAt || ts };
    const idx = arr.findIndex(x => x.id === record.id);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...record };
    else arr.unshift(record);
    return idx >= 0 ? arr[idx] : record;
  }

  public async getCustomers(): Promise<any[]> { return [...this.customers]; }
  public async saveCustomer(cust: any): Promise<any> {
    const saved = this.upsertInArray(this.customers, {
      ...cust,
      customerCode: cust.customerCode || cust.customer_code || cust.id
    });
    if (saved.email) {
      const uid = `usr-${saved.id}`;
      const existingU = this.users.find(u => u.id === uid || u.email.toLowerCase() === saved.email.toLowerCase());
      if (!existingU) {
        this.users.push({
          id: uid,
          name: saved.name,
          email: saved.email.toLowerCase(),
          password: bcrypt.hashSync(cust.password || '123456', 10),
          role: 'Customer',
          phone: saved.phone || '',
          department: 'Customer',
          designation: 'Customer',
          customerId: saved.id,
          isFieldWorker: false,
          status: saved.status || 'ACTIVE',
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      }
    }
    return saved;
  }
  public async deleteCustomer(id: string): Promise<boolean> {
    this.customers = this.customers.filter(c => c.id !== id);
    this.users = this.users.filter(u => u.id !== `usr-${id}` && u.customerId !== id);
    return true;
  }
  public async updateCustomerPassword(customerId: string, newPass: string): Promise<boolean> {
    const hashed = await bcrypt.hash(String(newPass || '').trim(), 10);
    const c = this.customers.find(x => x.id === customerId);
    if (c) c.password = hashed;
    const u = this.users.find(x => x.id === `usr-${customerId}` || x.customerId === customerId);
    if (u) u.password = hashed;
    return true;
  }
  public async importCustomers(list: any[]) {
    const importedRecords: any[] = [];
    for (const row of list || []) {
      const id = row.id || `cust-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      importedRecords.push(await this.saveCustomer({ ...row, id }));
    }
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async getLeads(): Promise<any[]> { return [...this.leads]; }
  public async getLeadById(id: string): Promise<any | null> { return this.leads.find(l => l.id === id) || null; }
  public async saveLead(lead: any): Promise<any> { return this.upsertInArray(this.leads, lead); }
  public async deleteLead(id: string): Promise<boolean> { this.leads = this.leads.filter(l => l.id !== id); return true; }
  public async importLeads(list: any[]) {
    const importedRecords: any[] = [];
    for (const row of list || []) {
      const id = row.id || `lead-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      importedRecords.push(await this.saveLead({ ...row, id }));
    }
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  // ==========================================================
  // PROJECTS & WORKFLOW STAGES
  // ==========================================================
  public async getProjects(): Promise<any[]> { return [...this.projects]; }
  public async saveProject(proj: any): Promise<any> {
    const existing = this.projects.find(p => p.id === proj.id);
    const stages = Array.isArray(proj.stages) && proj.stages.length > 0
      ? proj.stages
      : (existing?.stages?.length ? existing.stages : buildStandardWorkflowStages(proj.id, proj.startDate || todayStr(), 'NEW'));
    return this.upsertInArray(this.projects, { ...proj, stages });
  }
  public async deleteProject(id: string): Promise<boolean> { this.projects = this.projects.filter(p => p.id !== id); return true; }
  public async importProjects(list: any[]) {
    const importedRecords: any[] = [];
    for (const row of list || []) {
      const id = row.id || `proj-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      importedRecords.push(await this.saveProject({ ...row, id }));
    }
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async updateStageInProject(projectId: string, stageKey: string, updates: any, actorName: string = 'Staff'): Promise<any> {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return null;
    const stages: any[] = project.stages || [];
    const idx = stages.findIndex(s => s.stageKey === stageKey || s.id === stageKey);
    if (idx === -1) return null;
    const updatedStage = { ...stages[idx], ...updates };
    if (updates.status === 'COMPLETED' || updates.status === 'APPROVED') {
      const today = todayStr();
      updatedStage.completedDate = updatedStage.completedDate || today;
      updatedStage.actualEndDate = updatedStage.actualEndDate || today;
      if (updates.status === 'APPROVED') {
        updatedStage.approvedBy = actorName;
        updatedStage.approvedAt = today;
      }
      if (idx + 1 < stages.length && stages[idx + 1].status === 'NOT STARTED') {
        stages[idx + 1].status = 'IN PROGRESS';
        stages[idx + 1].startDate = today;
        project.currentStageKey = stages[idx + 1].stageKey;
      }
    }
    stages[idx] = updatedStage;
    project.stages = stages;
    const completed = stages.filter(s => s.status === 'COMPLETED' || s.status === 'APPROVED').length;
    project.completionPercentage = stages.length > 0 ? Math.round((completed / stages.length) * 100) : 0;
    project.progressPercentage = project.completionPercentage;
    project.updatedAt = nowIso();
    return project;
  }

  public async addStagePhotoToProject(projectId: string, stageKey: string, photo: any) {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return null;
    const stage = (project.stages || []).find((s: any) => s.stageKey === stageKey || s.id === stageKey);
    if (!stage) return null;
    stage.photos = [...(stage.photos || []), photo];
    return { photo, photos: stage.photos };
  }

  public async removeStagePhotoFromProject(projectId: string, stageKey: string, photoId: string) {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return null;
    const stage = (project.stages || []).find((s: any) => s.stageKey === stageKey || s.id === stageKey);
    if (!stage) return null;
    let removedPhoto: any = null;
    stage.photos = (stage.photos || []).filter((p: any) => {
      if (p?.id === photoId) { removedPhoto = p; return false; }
      return true;
    });
    return { removedPhoto, photos: stage.photos };
  }

  public async updateProjectProgress(projectId: string, progressPercentage: number, status?: string) {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) return null;
    project.completionPercentage = Math.max(0, Math.min(100, Number(progressPercentage) || 0));
    project.progressPercentage = project.completionPercentage;
    if (status) project.status = status;
    project.updatedAt = nowIso();
    return project;
  }

  public async updateProjectControlCenter(projectId: string, payload: any) {
    const project = this.projects.find(p => p.id === projectId);
    if (!project) throw Object.assign(new Error(`Project "${projectId}" not found.`), { statusCode: 404 });
    if (payload.capacityKw !== undefined) project.capacityKw = Number(payload.capacityKw);
    if (payload.totalValue !== undefined) project.totalValue = round2(payload.totalValue);
    if (payload.receivedInflow !== undefined) project.receivedInflow = payload.receivedInflow !== null ? round2(payload.receivedInflow) : null;
    if (payload.city !== undefined) project.city = String(payload.city).trim();
    if (payload.location !== undefined && !payload.city) project.city = String(payload.location).trim();
    if (payload.siteAddress !== undefined) project.siteAddress = String(payload.siteAddress).trim();
    project.updatedAt = nowIso();
    const customer = this.customers.find(c => c.id === project.customerId) || null;
    if (customer) {
      if (payload.city || payload.location) customer.city = project.city;
      if (payload.siteAddress) customer.siteAddress = project.siteAddress;
    }
    return { project, customer, payments: [...this.payments] };
  }

  // ==========================================================
  // EMPLOYEES & HRMS & LEAVES
  // ==========================================================
  public async getEmployees(): Promise<any[]> { return [...this.employees]; }
  public async saveEmployee(emp: any): Promise<any> {
    const saved = this.upsertInArray(this.employees, {
      ...emp,
      employeeCode: emp.employeeCode || emp.employee_code || emp.id,
      salaryMonthly: Number(emp.salaryMonthly ?? emp.salary ?? 0)
    });
    if (saved.email && saved.loginEnabled !== false) {
      await this.saveUser({
        id: saved.authUid || saved.id,
        name: saved.name,
        email: saved.email,
        role: saved.systemRole || saved.assignedRole || 'Technician',
        phone: saved.phone || '',
        department: saved.department || 'Operations',
        designation: saved.designation || '',
        employeeId: saved.employeeCode,
        isFieldWorker: Boolean(saved.isFieldWorker),
        status: saved.status === 'INACTIVE' || saved.accountStatus === 'DISABLED' ? 'DISABLED' : 'ACTIVE'
      }).catch(() => {});
    }
    return saved;
  }
  public async deleteEmployee(id: string): Promise<boolean> {
    this.employees = this.employees.filter(e => e.id !== id && e.authUid !== id);
    this.users = this.users.filter(u => u.id !== id);
    return true;
  }
  public async importEmployees(list: any[]) {
    const importedRecords: any[] = [];
    for (const row of list || []) {
      const id = row.id || `emp-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      importedRecords.push(await this.saveEmployee({ ...row, id }));
    }
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async saveEmployeeDocument(doc: any): Promise<any> {
    const list = this.employeeDocs.get(doc.employeeId) || [];
    const saved = { ...doc, uploadedAt: nowIso() };
    list.unshift(saved);
    this.employeeDocs.set(doc.employeeId, list);
    return saved;
  }
  public async deleteEmployeeDocument(employeeId: string, docId: string): Promise<boolean> {
    const list = this.employeeDocs.get(employeeId) || [];
    this.employeeDocs.set(employeeId, list.filter(d => d.id !== docId));
    return true;
  }
  public async getEmployeeDocuments(employeeId: string): Promise<any[]> {
    return [...(this.employeeDocs.get(employeeId) || [])];
  }
  public async updateEmployeePhoto(id: string, photoUrl: string): Promise<boolean> {
    const emp = this.employees.find(e => e.id === id || e.authUid === id);
    if (emp) emp.photoUrl = photoUrl;
    return true;
  }

  public async getAttendance(): Promise<any[]> { return [...this.attendance]; }
  public async saveAttendance(item: any): Promise<any> { return this.upsertInArray(this.attendance, item); }
  public async deleteAttendance(id: string): Promise<boolean> { this.attendance = this.attendance.filter(a => a.id !== id); return true; }
  public async importAttendance(list: any[]) {
    const importedRecords = list.map((r, i) => this.upsertInArray(this.attendance, { ...r, id: r.id || `att-imp-${Date.now()}-${i}` }));
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async getPayslips(): Promise<any[]> { return [...this.payslips]; }
  public async savePayslip(item: any): Promise<any> { return this.upsertInArray(this.payslips, item); }
  public async deletePayslip(id: string): Promise<boolean> { this.payslips = this.payslips.filter(p => p.id !== id); return true; }

  public async getHolidays(): Promise<any[]> { return [...this.holidays]; }
  public async saveHoliday(item: any): Promise<any> { return this.upsertInArray(this.holidays, item); }
  public async deleteHoliday(id: string): Promise<boolean> { this.holidays = this.holidays.filter(h => h.id !== id); return true; }

  public async getLeaveData(actor: any, year?: number) {
    const leaveYear = Number.isFinite(Number(year)) && Number(year) >= 2000 ? Number(year) : new Date().getFullYear();
    const roleUpper = String(actor?.role || '').trim().toUpperCase();
    const isAdminOrHr = roleUpper === 'ADMIN' || roleUpper === 'SUPER ADMIN' || roleUpper === 'HR MANAGER';
    const empMatch = this.employees.find(
      e => e.id === actor?.id || e.authUid === actor?.id || (actor?.email && e.email?.toLowerCase() === actor.email.toLowerCase())
    );
    const myEmployee = {
      employeeId: empMatch?.id || actor?.id || 'usr-admin-1',
      employeeCode: empMatch?.employeeCode || actor?.employeeId || '',
      employeeName: empMatch?.name || actor?.name || 'Employee',
      department: empMatch?.department || actor?.department || 'Operations',
      designation: empMatch?.designation || actor?.role || 'Staff'
    };
    const leaves = this.leaveRequests.filter(l => l.leaveYear === leaveYear && (isAdminOrHr || l.employeeId === myEmployee.employeeId));
    const emps = isAdminOrHr ? this.employees : (empMatch ? [empMatch] : []);
    const balances = emps.map(e => {
      let b = this.leaveBalances.find(x => x.employeeId === e.id && x.leaveYear === leaveYear);
      if (!b) {
        b = {
          id: `lbal-${e.id}-${leaveYear}`,
          employeeId: e.id,
          employeeCode: e.employeeCode || '',
          employeeName: e.name || '',
          department: e.department || '',
          designation: e.designation || '',
          leaveYear,
          casualTotal: 12, casualUsed: 0, casualPending: 0, casualRemaining: 12,
          sickTotal: 8, sickUsed: 0, sickPending: 0, sickRemaining: 8,
          earnedTotal: 15, earnedUsed: 0, earnedPending: 0, earnedRemaining: 15,
          unpaidUsed: 0, totalAllocated: 35, totalUsed: 0, totalRemaining: 35
        };
        this.leaveBalances.push(b);
      }
      return b;
    });
    return { leaveYear, canReview: isAdminOrHr, myEmployee, leaves, balances };
  }

  public async applyLeave(actor: any, payload: any) {
    const startDate = String(payload.startDate || todayStr()).slice(0, 10);
    const endDate = String(payload.endDate || startDate).slice(0, 10);
    const leaveYear = Number(startDate.slice(0, 4)) || new Date().getFullYear();
    const emp = this.employees.find(e => e.id === (payload.employeeId || actor?.id) || e.authUid === actor?.id);
    const record = {
      id: `lv-${Date.now()}`,
      employeeId: emp?.id || actor?.id,
      employeeCode: emp?.employeeCode || actor?.employeeId || '',
      employeeName: emp?.name || actor?.name || 'Employee',
      department: emp?.department || actor?.department || '',
      designation: emp?.designation || actor?.role || '',
      leaveType: String(payload.leaveType || 'CASUAL').toUpperCase(),
      startDate,
      endDate,
      totalDays: Number(payload.totalDays || 1),
      isHalfDay: Boolean(payload.isHalfDay),
      halfDaySession: payload.halfDaySession || '',
      reason: String(payload.reason || 'Personal'),
      status: 'PENDING',
      leaveYear,
      appliedAt: nowIso()
    };
    this.leaveRequests.unshift(record);
    return record;
  }

  public async reviewLeave(actor: any, leaveId: string, action: string, remarks?: string) {
    const lv = this.leaveRequests.find(l => l.id === leaveId);
    if (!lv) throw Object.assign(new Error('Leave request not found.'), { statusCode: 404 });
    lv.status = action.toUpperCase() === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    lv.reviewedBy = actor?.name || 'Admin';
    lv.reviewerId = actor?.id || '';
    lv.reviewedAt = nowIso();
    lv.adminRemarks = remarks || '';
    return lv;
  }

  public async cancelLeave(_actor: any, leaveId: string, remarks?: string) {
    const lv = this.leaveRequests.find(l => l.id === leaveId);
    if (!lv) throw Object.assign(new Error('Leave request not found.'), { statusCode: 404 });
    lv.status = 'CANCELLED';
    lv.adminRemarks = remarks || lv.adminRemarks || '';
    return lv;
  }

  // ==========================================================
  // FINANCE / PAYMENTS / EXPENSES
  // ==========================================================
  public async getPayments(): Promise<any[]> { return [...this.payments]; }
  public async savePayment(item: any): Promise<any> { return this.upsertInArray(this.payments, item); }
  public async deletePayment(id: string): Promise<boolean> { this.payments = this.payments.filter(p => p.id !== id); return true; }
  public async importPayments(list: any[]) {
    const importedRecords = list.map((r, i) => this.upsertInArray(this.payments, { ...r, id: r.id || `pay-imp-${Date.now()}-${i}` }));
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async getExpenses(): Promise<any[]> { return [...this.expenses]; }
  public async saveExpense(item: any): Promise<any> { return this.upsertInArray(this.expenses, item); }
  public async deleteExpense(id: string): Promise<boolean> { this.expenses = this.expenses.filter(e => e.id !== id); return true; }
  public async importExpenses(list: any[]) {
    const importedRecords = list.map((r, i) => this.upsertInArray(this.expenses, { ...r, id: r.id || `exp-imp-${Date.now()}-${i}` }));
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  // ==========================================================
  // INVENTORY / PROCUREMENT / SALES
  // ==========================================================
  public async getProducts(): Promise<any[]> { return [...this.products]; }
  public async saveProduct(item: any): Promise<any> { return this.upsertInArray(this.products, item); }
  public async deleteProduct(id: string): Promise<boolean> { this.products = this.products.filter(p => p.id !== id); return true; }
  public async importProducts(list: any[]) {
    const importedRecords = list.map((r, i) => this.upsertInArray(this.products, { ...r, id: r.id || `prod-imp-${Date.now()}-${i}` }));
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async getVendors(): Promise<any[]> { return [...this.vendors]; }
  public async saveVendor(item: any): Promise<any> { return this.upsertInArray(this.vendors, item); }
  public async deleteVendor(id: string): Promise<boolean> { this.vendors = this.vendors.filter(v => v.id !== id); return true; }
  public async importVendors(list: any[]) {
    const importedRecords = list.map((r, i) => this.upsertInArray(this.vendors, { ...r, id: r.id || `ven-imp-${Date.now()}-${i}` }));
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async getPurchaseOrders(): Promise<any[]> { return [...this.purchaseOrders]; }
  public async savePurchaseOrder(item: any): Promise<any> { return this.upsertInArray(this.purchaseOrders, item); }
  public async attachBillToPurchaseOrder(poId: string, bill: any): Promise<any[]> {
    const po = this.purchaseOrders.find(p => p.id === poId);
    if (!po) throw Object.assign(new Error('Purchase order not found.'), { statusCode: 404 });
    po.vendorBills = [...(po.vendorBills || []), bill];
    return po.vendorBills;
  }
  public async removeBillFromPurchaseOrder(poId: string, billId: string): Promise<{ removedBill: any | null; vendorBills: any[] }> {
    const po = this.purchaseOrders.find(p => p.id === poId);
    if (!po) return { removedBill: null, vendorBills: [] };
    let removedBill: any = null;
    po.vendorBills = (po.vendorBills || []).filter((b: any) => {
      if (b.id === billId) { removedBill = b; return false; }
      return true;
    });
    return { removedBill, vendorBills: po.vendorBills };
  }
  public async deletePurchaseOrder(id: string): Promise<boolean> { this.purchaseOrders = this.purchaseOrders.filter(p => p.id !== id); return true; }

  public async getBOMs(): Promise<any[]> { return [...this.boms]; }
  public async saveBOM(item: any): Promise<any> { return this.upsertInArray(this.boms, item); }
  public async deleteBOM(id: string): Promise<boolean> { this.boms = this.boms.filter(b => b.id !== id); return true; }

  public async getSalesInvoices(): Promise<any[]> { return [...this.salesInvoices]; }
  public async saveSalesInvoice(item: any): Promise<any> { return this.upsertInArray(this.salesInvoices, item); }
  public async deleteSalesInvoice(id: string): Promise<boolean> { this.salesInvoices = this.salesInvoices.filter(s => s.id !== id); return true; }

  public async getNextVendorSalesInvoiceNumber(): Promise<string> {
    return `VSI-2026-${String(this.vendorSalesInvoices.length + 1).padStart(4, '0')}`;
  }
  public async getVendorSalesInvoices(): Promise<any[]> { return [...this.vendorSalesInvoices]; }
  public async getVendorSalesInvoiceById(id: string): Promise<any | null> { return this.vendorSalesInvoices.find(v => v.id === id) || null; }
  public async saveVendorSalesInvoice(item: any): Promise<any> {
    const invoiceNumber = item.invoiceNumber || (await this.getNextVendorSalesInvoiceNumber());
    return this.upsertInArray(this.vendorSalesInvoices, { ...item, invoiceNumber });
  }
  public async recordVendorSalesPayment(invoiceId: string, payload: any): Promise<any> {
    const inv = this.vendorSalesInvoices.find(v => v.id === invoiceId);
    if (!inv) throw Object.assign(new Error('Vendor sales invoice not found.'), { statusCode: 404 });
    const amt = round2(payload.amount || 0);
    inv.paidAmount = round2((inv.paidAmount || 0) + amt);
    inv.balanceAmount = Math.max(0, round2((inv.totalAmount || 0) - inv.paidAmount));
    inv.status = inv.balanceAmount <= 0 ? 'PAID' : 'PARTIAL';
    inv.payments = [...(inv.payments || []), { id: `vsp-${Date.now()}`, ...payload, amount: amt }];
    return inv;
  }
  public async deleteVendorSalesInvoice(id: string): Promise<boolean> { this.vendorSalesInvoices = this.vendorSalesInvoices.filter(v => v.id !== id); return true; }

  public async getWarehouses(): Promise<any[]> { return [...this.warehouses]; }
  public async saveWarehouse(item: any): Promise<any> { return this.upsertInArray(this.warehouses, item); }
  public async deleteWarehouse(id: string): Promise<boolean> { this.warehouses = this.warehouses.filter(w => w.id !== id); return true; }

  public async getStockMovements(): Promise<any[]> { return [...this.stockMovements]; }
  public async saveStockMovement(item: any): Promise<any> { return this.upsertInArray(this.stockMovements, item); }
  public async deleteStockMovement(id: string): Promise<boolean> { this.stockMovements = this.stockMovements.filter(m => m.id !== id); return true; }

  public async getStockAudits(): Promise<any[]> { return [...this.stockAudits]; }
  public async saveStockAudit(item: any): Promise<any> { return this.upsertInArray(this.stockAudits, item); }
  public async deleteStockAudit(id: string): Promise<boolean> { this.stockAudits = this.stockAudits.filter(a => a.id !== id); return true; }

  public async getSalesReturns(): Promise<any[]> { return [...this.salesReturns]; }
  public async getPurchaseReturns(): Promise<any[]> { return [...this.purchaseReturns]; }

  // ==========================================================
  // QUOTATIONS & SURVEYS
  // ==========================================================
  public async getQuotations(): Promise<any[]> { return [...this.quotations]; }
  public async saveQuotation(item: any): Promise<any> { return this.upsertInArray(this.quotations, item); }
  public async deleteQuotation(id: string): Promise<boolean> { this.quotations = this.quotations.filter(q => q.id !== id); return true; }

  public async getSurveys(): Promise<any[]> { return [...this.surveys]; }
  public async saveSurvey(item: any): Promise<any> { return this.upsertInArray(this.surveys, item); }
  public async deleteSurvey(id: string): Promise<boolean> { this.surveys = this.surveys.filter(s => s.id !== id); return true; }

  // ==========================================================
  // SERVICE TICKETS & AMC
  // ==========================================================
  public async recordServiceTicketHistory(entry: any): Promise<void> {
    this.serviceTicketHistory.unshift({ id: `srvh-${Date.now()}`, ...entry, createdAt: nowIso() });
  }
  public async getServiceTicketHistory(ticketRecordId: string): Promise<any[]> {
    return this.serviceTicketHistory.filter(h => h.ticketRecordId === ticketRecordId);
  }
  public async getEligibleServiceTechnicians(): Promise<any[]> {
    return this.employees
      .filter(e => e.isFieldWorker || ['Technician', 'Service Manager', 'Electrical Team'].includes(e.systemRole))
      .map(e => ({
        id: e.id,
        employeeCode: e.employeeCode || e.id,
        name: e.name,
        email: e.email || '',
        phone: e.phone || '',
        department: e.department || 'Service',
        designation: e.designation || 'Technician',
        role: e.systemRole || 'Technician',
        status: e.status || 'ACTIVE'
      }));
  }
  public async getServiceTickets(): Promise<any[]> { return [...this.serviceTickets]; }
  public async getServiceTicketRowByIdOrCode(idOrCode: string): Promise<any | null> {
    return this.serviceTickets.find(t => t.id === idOrCode || t.ticketId === idOrCode) || null;
  }
  public async getServiceTicketDetails(idOrCode: string): Promise<any | null> {
    const ticket = await this.getServiceTicketRowByIdOrCode(idOrCode);
    if (!ticket) return null;
    const customer = this.customers.find(c => c.id === ticket.customerId) || null;
    const project = this.projects.find(p => p.id === ticket.projectId) || null;
    const amc = this.amcContracts.find(a => a.projectId === ticket.projectId || a.customerId === ticket.customerId) || null;
    const history = await this.getServiceTicketHistory(ticket.id);
    return { ...ticket, history, customerDetails: customer, projectDetails: project, amcDetails: amc, assignedTechnicianDetails: null };
  }
  public async saveServiceTicket(item: any): Promise<any> { return this.upsertInArray(this.serviceTickets, item); }
  public async assignServiceTicketTechnician(ticketIdOrRecordId: string, payload: any, actor: any): Promise<any> {
    const t = await this.getServiceTicketRowByIdOrCode(ticketIdOrRecordId);
    if (!t) throw Object.assign(new Error('Service ticket not found.'), { statusCode: 404 });
    const eligible = await this.getEligibleServiceTechnicians();
    const tech = eligible.find(x => x.id === payload.technicianId || x.employeeCode === payload.technicianId);
    t.assignedTechnicianId = tech?.id || '';
    t.assignedTechnicianName = tech?.name || '';
    t.status = t.assignedTechnicianId && t.status === 'OPEN' ? 'ASSIGNED' : t.status;
    if (payload.scheduledDate !== undefined) t.scheduledDate = payload.scheduledDate;
    if (payload.remarks !== undefined) t.technicianRemarks = payload.remarks;
    t.updatedAt = nowIso();
    await this.recordServiceTicketHistory({ ticketRecordId: t.id, ticketCode: t.ticketId, actionType: 'TECHNICIAN_ASSIGNED', newValue: tech?.name || 'Unassigned', actor });
    return this.getServiceTicketDetails(t.id);
  }
  public async adminUpdateServiceTicket(ticketIdOrRecordId: string, payload: any): Promise<any> {
    const t = await this.getServiceTicketRowByIdOrCode(ticketIdOrRecordId);
    if (!t) throw Object.assign(new Error('Service ticket not found.'), { statusCode: 404 });
    Object.assign(t, payload, { updatedAt: nowIso() });
    return this.getServiceTicketDetails(t.id);
  }
  public async deleteServiceTicket(id: string): Promise<boolean> { this.serviceTickets = this.serviceTickets.filter(t => t.id !== id); return true; }
  public async importServiceTickets(list: any[]) {
    const importedRecords = list.map((r, i) => this.upsertInArray(this.serviceTickets, { ...r, id: r.id || `tkt-imp-${Date.now()}-${i}` }));
    return { success: true, total: list.length, imported: importedRecords.length, skipped: 0, failed: 0, importedRecords, skippedRecords: [], failedRecords: [], errors: [] };
  }

  public async getAMCContracts(): Promise<any[]> { return [...this.amcContracts]; }
  public async saveAMCContract(item: any): Promise<any> { return this.upsertInArray(this.amcContracts, item); }
  public async deleteAMCContract(id: string): Promise<boolean> { this.amcContracts = this.amcContracts.filter(a => a.id !== id); return true; }

  // ==========================================================
  // NOTIFICATIONS, SETTINGS, EMAIL, ACL
  // ==========================================================
  public async getNotifications(): Promise<any[]> { return [...this.notifications]; }
  public async saveNotification(item: any): Promise<any> { return this.upsertInArray(this.notifications, item); }
  public async deleteNotification(id: string): Promise<boolean> { this.notifications = this.notifications.filter(n => n.id !== id); return true; }

  public async getSettings(): Promise<Record<string, any>> { return { ...this.settings }; }
  public async saveSettings(settings: any): Promise<any> { this.settings = { ...this.settings, ...settings }; return this.settings; }

  public async getEmailSettingsInternal(): Promise<EmailSettingsRecord | null> { return this.emailSettings; }
  public async getSanitizedEmailSettings(): Promise<SanitizedEmailSettings> { return sanitizeEmailConfig(this.emailSettings); }
  public async saveEmailSettings(input: {
    gmailAddress: string; smtpHost: string; smtpPort: number; smtpSecurity: SmtpSecurity;
    senderName: string; encryptedAppPassword: string; iv: string; authTag: string; enabled: boolean; updatedBy: string;
  }): Promise<SanitizedEmailSettings> {
    this.emailSettings = {
      id: 'default_gmail_smtp',
      gmail_address: input.gmailAddress,
      smtp_host: input.smtpHost,
      smtp_port: input.smtpPort,
      smtp_security: input.smtpSecurity,
      sender_name: input.senderName,
      encrypted_app_password: input.encryptedAppPassword,
      iv: input.iv,
      auth_tag: input.authTag,
      enabled: input.enabled ? 1 : 0,
      last_tested_at: null,
      last_test_status: null,
      last_test_message: null,
      updated_by: input.updatedBy,
      updated_at: nowIso()
    };
    return sanitizeEmailConfig(this.emailSettings);
  }
  public async updateEmailTestStatus(status: 'SUCCESS' | 'FAILED', message: string, testedAt?: string): Promise<SanitizedEmailSettings> {
    if (this.emailSettings) {
      this.emailSettings.last_test_status = status;
      this.emailSettings.last_test_message = message;
      this.emailSettings.last_tested_at = testedAt || nowIso();
    }
    return sanitizeEmailConfig(this.emailSettings);
  }
  public async deleteEmailSettings(): Promise<void> { this.emailSettings = null; }

  public async getAclConfig(): Promise<any> { return this.aclConfig; }
  public async saveAclConfig(config: any): Promise<any> { this.aclConfig = config; return config; }
  public async getAclAuditLogs(): Promise<any[]> { return [...this.aclAuditLogs]; }
  public async addAclAuditLog(log: any): Promise<any> {
    const entry = { id: log.id || `acl-log-${Date.now()}`, ...log, timestamp: log.timestamp || nowIso() };
    this.aclAuditLogs.unshift(entry);
    return entry;
  }
  public async saveACLAuditLog(log: any): Promise<any> { return this.addAclAuditLog(log); }

  // ==========================================================
  // WORKFORCE LIVE TRACKING
  // ==========================================================
  public async resolveVerifiedFieldStaff(userId?: string, email?: string, employeeCode?: string) {
    const cId = String(userId || '').trim().toLowerCase();
    const cEmail = String(email || '').trim().toLowerCase();
    const cCode = String(employeeCode || '').trim().toLowerCase();
    const emp = this.employees.find(e =>
      e.isFieldWorker && (
        (cId && (e.id.toLowerCase() === cId || String(e.authUid || '').toLowerCase() === cId)) ||
        (cEmail && String(e.email || '').toLowerCase() === cEmail) ||
        (cCode && String(e.employeeCode || '').toLowerCase() === cCode)
      )
    );
    if (!emp) return null;
    return {
      id: emp.id,
      employeeCode: emp.employeeCode || emp.id,
      name: emp.name,
      email: emp.email || '',
      role: emp.systemRole || emp.assignedRole || 'Technician',
      department: emp.department || 'Operations',
      phone: emp.phone || '',
      isFieldWorker: true
    };
  }

  public async getWorkforceLocations(): Promise<any[]> {
    return Array.from(this.workforceLocations.values());
  }

  public async saveWorkforceLocation(data: any): Promise<boolean> {
    const staff = await this.resolveVerifiedFieldStaff(data.userId, data.email, data.employeeCode);
    if (!staff) return false;
    const speed = data.speed !== undefined ? Number(data.speed) : 0;
    this.workforceLocations.set(staff.id, {
      userId: staff.id,
      employeeCode: staff.employeeCode,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      department: staff.department,
      phone: staff.phone,
      latitude: Number(data.latitude),
      longitude: Number(data.longitude),
      accuracy: data.accuracy,
      heading: data.heading,
      speed: data.speed,
      batteryLevel: data.batteryLevel,
      activity: data.activity || (speed > 3 ? 'In Transit / Moving' : 'On Site / Active'),
      isOnline: true,
      isSharingLocation: true,
      hasLocation: true,
      status: speed > 3 ? 'moving' : 'idle',
      lastSeenAt: nowIso(),
      updatedAt: nowIso(),
      verified: true
    });
    return true;
  }

  public async saveWorkforceHeartbeat(data: any): Promise<boolean> {
    const staff = await this.resolveVerifiedFieldStaff(data.userId, data.email, data.employeeCode);
    if (!staff) return false;
    const existing = this.workforceLocations.get(staff.id) || {};
    this.workforceLocations.set(staff.id, {
      ...existing,
      userId: staff.id,
      employeeCode: staff.employeeCode,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      department: staff.department,
      phone: staff.phone,
      isOnline: true,
      isSharingLocation: Boolean(data.isSharingLocation ?? existing.isSharingLocation),
      hasLocation: Boolean(existing.latitude !== undefined && existing.longitude !== undefined),
      status: existing.latitude !== undefined ? 'idle' : 'online',
      lastSeenAt: nowIso(),
      updatedAt: nowIso(),
      verified: true
    });
    return true;
  }

  public async setWorkforceOffline(userId: string, email?: string): Promise<boolean> {
    for (const [k, rec] of this.workforceLocations.entries()) {
      if (k === userId || (email && rec.email?.toLowerCase() === email.toLowerCase())) {
        rec.isOnline = false;
        rec.isSharingLocation = false;
        rec.status = 'offline';
        rec.lastSeenAt = nowIso();
      }
    }
    return true;
  }

  // ==========================================================
  // SYNC / BOOTSTRAP / WIPE DISPATCHERS
  // ==========================================================
  public async saveItem(collection: string, item: any): Promise<any> {
    switch (collection) {
      case 'customers': return this.saveCustomer(item);
      case 'leads': return this.saveLead(item);
      case 'projects': return this.saveProject(item);
      case 'employee':
      case 'employees': return this.saveEmployee(item);
      case 'payments': return this.savePayment(item);
      case 'expenses': return this.saveExpense(item);
      case 'products': return this.saveProduct(item);
      case 'vendors': return this.saveVendor(item);
      case 'purchase_orders': return this.savePurchaseOrder(item);
      case 'sales_invoices': return this.saveSalesInvoice(item);
      case 'vendor_sales_invoices': return this.saveVendorSalesInvoice(item);
      case 'attendance': return this.saveAttendance(item);
      case 'payslips': return this.savePayslip(item);
      case 'holidays': return this.saveHoliday(item);
      case 'quotations': return this.saveQuotation(item);
      case 'surveys': return this.saveSurvey(item);
      case 'boms': return this.saveBOM(item);
      case 'warehouses': return this.saveWarehouse(item);
      case 'stock_movements': return this.saveStockMovement(item);
      case 'stock_audits': return this.saveStockAudit(item);
      case 'service_tickets': return this.saveServiceTicket(item);
      case 'amc_contracts': return this.saveAMCContract(item);
      case 'notifications': return this.saveNotification(item);
      case 'users': return this.saveUser(item);
      case 'settings': return this.saveSettings(item);
      case 'acl_config': return this.saveAclConfig(item);
      case 'acl_audit_logs': return this.addAclAuditLog(item);
      default: throw new Error(`Collection "${collection}" is not supported.`);
    }
  }

  public async deleteItem(collection: string, id: string): Promise<boolean> {
    switch (collection.toLowerCase()) {
      case 'customers': return this.deleteCustomer(id);
      case 'leads': return this.deleteLead(id);
      case 'projects': return this.deleteProject(id);
      case 'employee':
      case 'employees':
      case 'solar_employee':
      case 'solar_employees': return this.deleteEmployee(id);
      case 'payments': return this.deletePayment(id);
      case 'expenses': return this.deleteExpense(id);
      case 'products': return this.deleteProduct(id);
      case 'vendors': return this.deleteVendor(id);
      case 'purchase_orders': return this.deletePurchaseOrder(id);
      case 'sales_invoices': return this.deleteSalesInvoice(id);
      case 'vendor_sales_invoices': return this.deleteVendorSalesInvoice(id);
      case 'attendance': return this.deleteAttendance(id);
      case 'payslips': return this.deletePayslip(id);
      case 'holidays': return this.deleteHoliday(id);
      case 'quotations': return this.deleteQuotation(id);
      case 'surveys': return this.deleteSurvey(id);
      case 'boms': return this.deleteBOM(id);
      case 'warehouses': return this.deleteWarehouse(id);
      case 'stock_movements': return this.deleteStockMovement(id);
      case 'stock_audits': return this.deleteStockAudit(id);
      case 'service_tickets': return this.deleteServiceTicket(id);
      case 'amc_contracts': return this.deleteAMCContract(id);
      case 'notifications': return this.deleteNotification(id);
      case 'user':
      case 'users':
      case 'solar_users': return this.deleteUser(id);
      default: return true;
    }
  }

  public async getAllData(): Promise<Record<string, any>> {
    return {
      customers: await this.getCustomers(),
      leads: await this.getLeads(),
      projects: await this.getProjects(),
      employees: await this.getEmployees(),
      payments: await this.getPayments(),
      expenses: await this.getExpenses(),
      products: await this.getProducts(),
      vendors: await this.getVendors(),
      purchase_orders: await this.getPurchaseOrders(),
      sales_invoices: await this.getSalesInvoices(),
      vendor_sales_invoices: await this.getVendorSalesInvoices(),
      sales_returns: await this.getSalesReturns(),
      purchase_returns: await this.getPurchaseReturns(),
      attendance: await this.getAttendance(),
      payslips: await this.getPayslips(),
      holidays: await this.getHolidays(),
      quotations: await this.getQuotations(),
      surveys: await this.getSurveys(),
      boms: await this.getBOMs(),
      warehouses: await this.getWarehouses(),
      stock_movements: await this.getStockMovements(),
      stock_audits: await this.getStockAudits(),
      service_tickets: await this.getServiceTickets(),
      amc_contracts: await this.getAMCContracts(),
      notifications: await this.getNotifications(),
      users: await this.getUsers(),
      settings: await this.getSettings(),
      acl_config: await this.getAclConfig(),
      acl_audit_logs: await this.getAclAuditLogs()
    };
  }

  public async backupAndWipeData(confirmation: string) {
    if (confirmation !== 'CONFIRM_WIPE_ERP_DATA') {
      throw new Error('Explicit confirmation code "CONFIRM_WIPE_ERP_DATA" is required.');
    }
    this.customers = [];
    this.leads = [];
    this.projects = [];
    this.payments = [];
    this.expenses = [];
    this.products = [];
    this.vendors = [];
    this.purchaseOrders = [];
    this.boms = [];
    this.salesInvoices = [];
    this.vendorSalesInvoices = [];
    this.salesReturns = [];
    this.purchaseReturns = [];
    this.attendance = [];
    this.payslips = [];
    this.serviceTickets = [];
    this.amcContracts = [];
    this.notifications = [];
    return {
      success: true,
      backupFile: '',
      affectedTables: [],
      affectedBrowserKeys: [],
      preservedTables: ['solar_users', 'solar_system_settings', 'solar_acl_config'],
      recordsWiped: 0,
      message: 'In-memory ERP business records cleared. Administrative accounts preserved.'
    };
  }

  // ==========================================================
  // IN-MEMORY ACCOUNTING SERVICE DELEGATES (WHEN POOL IS NULL)
  // ==========================================================
  public accounting = {
    getBankAccounts: async () => [...this.accBankAccounts],
    getWorkspace: async () => ({
      accounts: [...this.accAccounts],
      journals: [...this.accJournals],
      bankAccounts: [...this.accBankAccounts],
      bankTransfers: [...this.accBankTransfers],
      bankReconciliations: [...this.accBankReconciliations],
      vendorBills: [...this.accVendorBills],
      vendorPayments: [...this.accVendorPayments],
      tdsEntries: [...this.accTdsEntries],
      budgets: [...this.accBudgets],
      fixedAssets: [...this.accFixedAssets],
      assetDepreciationLogs: [...this.accDepreciationLogs],
      settings: { ...this.accSettings },
      auditLogs: [...this.accAuditLogs]
    }),
    saveAccount: async (_p: any, data: any) => {
      const id = data.id || `acc-${Date.now()}`;
      return this.upsertInArray(this.accAccounts, { ...data, id });
    },
    deleteAccount: async (_p: any, id: string) => {
      this.accAccounts = this.accAccounts.filter(a => a.id !== id || a.isSystem);
    },
    saveJournalEntry: async (_p: any, data: any, actor: any) => {
      const id = data.id || `je-${Date.now()}`;
      const entryNumber = data.entryNumber || `JV-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      return this.upsertInArray(this.accJournals, { ...data, id, entryNumber, createdBy: actor?.name || 'Admin' });
    },
    postJournalEntry: async (_p: any, id: string, actor: any) => {
      const j = this.accJournals.find(x => x.id === id);
      if (!j) throw new Error('Journal entry not found.');
      j.status = 'POSTED';
      j.postedBy = actor?.name || 'Admin';
      j.postedAt = nowIso();
      return j;
    },
    reverseJournalEntry: async (_p: any, id: string, actor: any, reason?: string) => {
      const j = this.accJournals.find(x => x.id === id);
      if (!j) throw new Error('Journal entry not found.');
      j.status = 'REVERSED';
      const rev = {
        ...j,
        id: `je-rev-${Date.now()}`,
        entryNumber: `${j.entryNumber}-REV`,
        narration: `Reversal of ${j.entryNumber}: ${reason || 'Manual reversal'}`,
        reversedEntryId: j.id,
        status: 'POSTED',
        postedBy: actor?.name || 'Admin',
        postedAt: nowIso(),
        lines: (j.lines || []).map((l: any, i: number) => ({ ...l, id: `jel-rev-${Date.now()}-${i}`, debit: l.credit, credit: l.debit }))
      };
      this.accJournals.unshift(rev);
      return rev;
    },
    deleteJournalEntry: async (_p: any, id: string) => {
      this.accJournals = this.accJournals.filter(j => j.id !== id);
    },
    recordCustomerReceipt: async (_p: any, data: any) => {
      const id = data.id || `pay-${Date.now()}`;
      return this.savePayment({ ...data, id, status: data.status || 'PAID' });
    },
    deleteCustomerReceipt: async (_p: any, id: string) => { await this.deletePayment(id); },
    saveVendorBill: async (_p: any, data: any) => {
      const id = data.id || `vbill-${Date.now()}`;
      return this.upsertInArray(this.accVendorBills, { ...data, id, billNumber: data.billNumber || `BILL-${Date.now().toString().slice(-4)}` });
    },
    deleteVendorBill: async (_p: any, id: string) => { this.accVendorBills = this.accVendorBills.filter(b => b.id !== id); },
    recordVendorPayment: async (_p: any, data: any) => {
      const id = data.id || `vpay-${Date.now()}`;
      return this.upsertInArray(this.accVendorPayments, { ...data, id, paymentNumber: data.paymentNumber || `VPAY-${Date.now().toString().slice(-4)}` });
    },
    deleteVendorPayment: async (_p: any, id: string) => { this.accVendorPayments = this.accVendorPayments.filter(p => p.id !== id); },
    saveBankAccount: async (_p: any, data: any) => {
      const id = data.id || `bank-${Date.now()}`;
      return this.upsertInArray(this.accBankAccounts, { ...data, id });
    },
    deleteBankAccount: async (_p: any, id: string) => { this.accBankAccounts = this.accBankAccounts.filter(b => b.id !== id); },
    recordBankTransfer: async (_p: any, data: any) => {
      const id = data.id || `trf-${Date.now()}`;
      return this.upsertInArray(this.accBankTransfers, { ...data, id, transferNumber: `TRF-${Date.now().toString().slice(-4)}` });
    },
    deleteBankTransfer: async (_p: any, id: string) => { this.accBankTransfers = this.accBankTransfers.filter(t => t.id !== id); },
    saveBankReconciliation: async (_p: any, data: any) => {
      const id = data.id || `rec-${Date.now()}`;
      return this.upsertInArray(this.accBankReconciliations, { ...data, id });
    },
    deleteBankReconciliation: async (_p: any, id: string) => { this.accBankReconciliations = this.accBankReconciliations.filter(r => r.id !== id); },
    saveExpenseWithWorkflow: async (_p: any, data: any) => {
      const id = data.id || `exp-${Date.now()}`;
      return this.saveExpense({ ...data, id });
    },
    deleteExpense: async (_p: any, id: string) => { await this.deleteExpense(id); },
    approveOrRejectExpense: async (_p: any, id: string, decision: string, reason: string) => {
      const exp = this.expenses.find(e => e.id === id);
      if (!exp) throw new Error('Expense not found.');
      exp.status = decision;
      exp.rejectionReason = reason;
      return exp;
    },
    payExpense: async (_p: any, id: string, payload: any, actor: any) => {
      const exp = this.expenses.find(e => e.id === id);
      if (!exp) throw new Error('Expense not found.');
      exp.status = 'PAID';
      exp.paidAt = nowIso();
      exp.paidBy = actor?.name || 'Admin';
      exp.bankAccountId = payload?.bankAccountId || exp.bankAccountId;
      return exp;
    },
    depositTdsEntry: async (_p: any, id: string, payload: any) => {
      const t = this.accTdsEntries.find(x => x.id === id);
      if (!t) throw new Error('TDS entry not found.');
      t.status = 'DEPOSITED';
      t.challanNo = payload.challanNo || '';
      t.bsrCode = payload.bsrCode || '';
      t.depositDate = payload.depositDate || todayStr();
      return t;
    },
    generateEinvoiceIrn: async (_p: any, invoiceId: string) => {
      const inv = this.salesInvoices.find(x => x.id === invoiceId);
      if (!inv) throw new Error('Sales invoice not found.');
      inv.einvoiceIrn = crypto.createHash('sha256').update(invoiceId + Date.now()).digest('hex');
      inv.einvoiceAckNo = String(Math.floor(100000000000 + Math.random() * 900000000000));
      inv.einvoiceAckDate = nowIso();
      inv.einvoiceStatus = 'GENERATED';
      return inv;
    },
    saveBudget: async (_p: any, data: any) => {
      const id = data.id || `bdg-${Date.now()}`;
      return this.upsertInArray(this.accBudgets, { ...data, id });
    },
    deleteBudget: async (_p: any, id: string) => { this.accBudgets = this.accBudgets.filter(b => b.id !== id); },
    saveFixedAsset: async (_p: any, data: any) => {
      const id = data.id || `fa-${Date.now()}`;
      return this.upsertInArray(this.accFixedAssets, { ...data, id, bookValue: Number(data.bookValue ?? data.purchaseCost ?? 0) });
    },
    deleteFixedAsset: async (_p: any, id: string) => { this.accFixedAssets = this.accFixedAssets.filter(a => a.id !== id); },
    runAssetDepreciation: async (_p: any, assetId: string, payload: any, actor: any) => {
      const asset = this.accFixedAssets.find(a => a.id === assetId);
      if (!asset) throw new Error('Fixed asset not found.');
      const depAmt = round2(payload?.amount || (asset.bookValue * (asset.depreciationRate || 15) / 100));
      const opening = Number(asset.bookValue || 0);
      const closing = Math.max(Number(asset.salvageValue || 0), round2(opening - depAmt));
      asset.accumulatedDepreciation = round2((asset.accumulatedDepreciation || 0) + (opening - closing));
      asset.bookValue = closing;
      const log = {
        id: `dep-${Date.now()}`,
        assetId,
        assetCode: asset.assetCode,
        assetName: asset.name,
        periodLabel: payload?.periodLabel || 'FY 2026-27',
        runDate: todayStr(),
        openingBookValue: opening,
        depreciationAmount: round2(opening - closing),
        closingBookValue: closing,
        runBy: actor?.name || 'Admin',
        createdAt: nowIso()
      };
      this.accDepreciationLogs.unshift(log);
      return { asset, log };
    },
    disposeAsset: async (_p: any, assetId: string, payload: any) => {
      const asset = this.accFixedAssets.find(a => a.id === assetId);
      if (!asset) throw new Error('Fixed asset not found.');
      asset.status = 'DISPOSED';
      asset.disposalDate = payload?.disposalDate || todayStr();
      asset.disposalProceeds = round2(payload?.proceeds || 0);
      asset.disposalGainLoss = round2(asset.disposalProceeds - (asset.bookValue || 0));
      return asset;
    },
    updateSettings: async (_p: any, data: any, actor: any) => {
      this.accSettings = { ...this.accSettings, ...data, updatedBy: actor?.name || 'Admin', updatedAt: nowIso() };
      return this.accSettings;
    },
    syncErpVouchers: async () => ({ syncedCount: 0, breakdown: {} }),
    recordSalesInvoicePayment: async (_p: any, invoiceId: string, payload: any) => {
      const inv = this.salesInvoices.find(x => x.id === invoiceId);
      if (!inv) throw new Error('Sales invoice not found.');
      const amt = round2(payload?.amount || 0);
      inv.paidAmount = round2((inv.paidAmount || 0) + amt);
      inv.balanceAmount = Math.max(0, round2((inv.totalAmount || 0) - inv.paidAmount));
      inv.status = inv.balanceAmount <= 0 ? 'PAID' : 'PARTIAL';
      return inv;
    },
    recordVendorSalesInvoicePayment: async (_p: any, invoiceId: string, payload: any) => {
      return this.recordVendorSalesPayment(invoiceId, payload);
    },
    recordPurchaseOrderPayment: async (_p: any, poId: string, payload: any) => {
      const po = this.purchaseOrders.find(x => x.id === poId);
      if (!po) throw new Error('Purchase order not found.');
      const amt = round2(payload?.amount || 0);
      po.paidAmount = round2((po.paidAmount || 0) + amt);
      po.balanceAmount = Math.max(0, round2((po.totalAmount || 0) - po.paidAmount));
      return po;
    },
    getSalesReturns: async () => [...this.salesReturns],
    createSalesReturn: async (_p: any, payload: any) => {
      const id = payload.id || `sr-${Date.now()}`;
      return this.upsertInArray(this.salesReturns, { ...payload, id });
    },
    deleteSalesReturn: async (_p: any, id: string) => {
      this.salesReturns = this.salesReturns.filter(r => r.id !== id);
    },
    getPurchaseReturns: async () => [...this.purchaseReturns],
    createPurchaseReturn: async (_p: any, payload: any) => {
      const id = payload.id || `pr-${Date.now()}`;
      return this.upsertInArray(this.purchaseReturns, { ...payload, id });
    },
    deletePurchaseReturn: async (_p: any, id: string) => {
      this.purchaseReturns = this.purchaseReturns.filter(r => r.id !== id);
    }
  };
}

export const inMemoryDbStore = new InMemoryDatabaseStore();
