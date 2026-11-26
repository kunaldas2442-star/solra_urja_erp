/**
 * Solar Urja ERP (solar.klyiatechnology.com) - MySQL Backend API Client
 * Provides unified async communication with /api/* endpoints
 */

export interface DbStatusResponse {
  success: boolean;
  connected: boolean;
  host: string;
  database: string;
  port: number;
  mode: string;
  dumpAvailable: boolean;
  dumpPath: string;
  message: string;
  tables?: string[];
}

export interface BatchImportResult {
  success: boolean;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  importedRecords?: any[];
  skippedRecords?: { row: number; name: string; reason: string }[];
  failedRecords?: { row: number; reason: string }[];
  errors?: string[];
}

class ApiClient {
  private baseUrl: string = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL)
    ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '')
    : '/api';
  private token: string | null = null;

  constructor() {
    this.token = null;
    // Purge any legacy browser storage tokens to guarantee MySQL as sole source of truth
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('rejoysolar_auth_token');
        localStorage.removeItem('rejoysolar_active_session');
        sessionStorage.removeItem('rejoysolar_auth_token');
        sessionStorage.removeItem('rejoysolar_active_session');
      } catch {}
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setToken(token: string | null): void {
    this.token = token;
  }

  public getToken(): string | null {
    return this.token;
  }

  public getAuthHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extraHeaders };
    const t = this.getToken();
    if (t) {
      headers['Authorization'] = t.startsWith('Bearer ') ? t : `Bearer ${t}`;
      headers['x-auth-token'] = t;
    }
    return headers;
  }

  /**
   * Unified fetch wrapper ensuring HttpOnly cookies and credentials are sent across
   * all browser environments, iframes, page reloads, and cross-site requests
   */
  public async request(url: string, init: RequestInit = {}): Promise<Response> {
    const customHeaders = (init.headers as Record<string, string>) || {};
    const headers = this.getAuthHeaders(customHeaders);
    return fetch(url, {
      ...init,
      headers,
      credentials: 'include'
    });
  }

  // --- Database Management & Migration ---

  async getDbStatus(): Promise<DbStatusResponse> {
    try {
      const res = await this.request(`${this.baseUrl}/db/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      return {
        success: false,
        connected: false,
        host: '127.0.0.1',
        database: 'solar_urja_erp',
        port: 3306,
        mode: 'DISCONNECTED',
        dumpAvailable: false,
        dumpPath: '/database.sql',
        message: 'Could not contact backend API: ' + e.message
      };
    }
  }

  async testDbConnection(config: { host: string; port?: number; user: string; password?: string; database: string }): Promise<{ success: boolean; message: string }> {
    try {
      const res = await this.request(`${this.baseUrl}/db/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      return await res.json();
    } catch (e: any) {
      return { success: false, message: e.message || 'Connection test failed.' };
    }
  }

  async runMigration(config?: any): Promise<{ success: boolean; message: string; tablesCount?: number }> {
    try {
      const res = await this.request(`${this.baseUrl}/db/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config || {})
      });
      return await res.json();
    } catch (e: any) {
      return { success: false, message: e.message || 'Migration request failed.' };
    }
  }

  getSqlDumpDownloadUrl(): string {
    return `${this.baseUrl}/db/dump.sql`;
  }

  async getRegistrationStatus(): Promise<{ success: boolean; allowPublicRegistration: boolean; adminCount: number }> {
    try {
      const res = await this.request(`${this.baseUrl}/auth/registration-status`);
      return await res.json();
    } catch {
      return { success: false, allowPublicRegistration: false, adminCount: 0 };
    }
  }

  async registerAdmin(
    data: {
      name: string;
      email: string;
      password: string;
      confirmPassword?: string;
      phone?: string;
      department?: string;
      designation?: string;
    },
    adminAuthToken?: string
  ): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminAuthToken) {
      headers['Authorization'] = adminAuthToken.startsWith('Bearer ') ? adminAuthToken : `Bearer ${adminAuthToken}`;
    }
    const res = await this.request(`${this.baseUrl}/auth/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data)
    });
    let json: any = {};
    try {
      json = await res.json();
    } catch {
      throw new Error(`Server returned HTTP ${res.status} (${res.statusText || 'Non-JSON response'}). Please ensure the API backend is running.`);
    }
    if (!res.ok || !json.success) {
      throw new Error(json.message || json.error || `Registration failed (HTTP ${res.status})`);
    }
    return json;
  }

  async wipeDatabase(confirmation: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/db/wipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation })
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.message || json.error || 'Database wipe failed');
    }
    return json;
  }

  // --- Master Bootstrap Data ---
  async getBootstrapData(): Promise<Record<string, any>> {
    const res = await this.request(`${this.baseUrl}/bootstrap`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(json.error || json.message || `MySQL bootstrap failed (HTTP ${res.status})`);
    }
    return json.data || {};
  }

  private async handleResponse<T = any>(res: Response): Promise<T> {
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Request failed with HTTP ${res.status}`);
    }
    return data.data !== undefined ? data.data : data;
  }

  async syncPush(collection: string, payload: { item?: any; items?: any[]; action?: string }): Promise<any> {
    const res = await this.request(`${this.baseUrl}/sync/push`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ collection, ...payload })
    });
    return this.handleResponse(res);
  }

  // --- Auth & Customer Portal ---

  async login(email: string, pass: string): Promise<{ success: boolean; user?: any; token?: string; message?: string; status?: number }> {
    try {
      let res = await this.request(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password: pass })
      });
      if (res.status === 404 && this.baseUrl === '/api') {
        try {
          res = await this.request('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password: pass })
          });
        } catch {}
      }
      let data: any = {};
      try {
        data = await res.json();
      } catch {
        const msg =
          res.status === 404
            ? `Authentication API endpoint not found (HTTP 404). Please verify backend routing for ${this.baseUrl}/auth/login.`
            : `Authentication server returned HTTP ${res.status} (${res.statusText || 'Non-JSON response'}).`;
        return { success: false, message: msg, status: res.status };
      }
      if (res.ok && data.success && data.token) {
        this.setToken(data.token);
      }
      if (!res.ok || !data.success) {
        return {
          success: false,
          message: data.message || data.error || `Authentication failed (HTTP ${res.status}).`,
          status: res.status
        };
      }
      return data;
    } catch (e: any) {
      return { success: false, message: e?.message || 'Unable to reach authentication server.' };
    }
  }

  async verifySession(customToken?: string): Promise<{ success: boolean; user?: any; token?: string; message?: string }> {
    const t = customToken || this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (t) {
      headers['Authorization'] = t.startsWith('Bearer ') ? t : `Bearer ${t}`;
      headers['x-auth-token'] = t;
    }

    try {
      let res = await this.request(`${this.baseUrl}/auth/me`, {
        method: 'GET',
        headers,
        credentials: 'include'
      });
      if (res.status === 404 && this.baseUrl === '/api') {
        try {
          res = await this.request('/auth/me', {
            method: 'GET',
            headers,
            credentials: 'include'
          });
        } catch {}
      }
      let data: any = {};
      try {
        data = await res.json();
      } catch {
        return { success: false, message: `HTTP ${res.status}: Non-JSON response` };
      }

      if (res.ok && data.success && data.user) {
        if (data.token) {
          this.setToken(data.token);
        }
        return { success: true, user: data.user, token: data.token || t || '' };
      }
      return { success: false, message: data.message || `HTTP ${res.status}` };
    } catch (e: any) {
      return { success: false, message: e.message || 'Session verification network error' };
    }
  }

  async logout(): Promise<{ success: boolean; message?: string }> {
    try {
      const t = this.getToken();
      this.setToken(null);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (t) headers['Authorization'] = t.startsWith('Bearer ') ? t : `Bearer ${t}`;
      const res = await this.request(`${this.baseUrl}/auth/logout`, {
        method: 'POST',
        headers,
        credentials: 'include'
      });
      return await res.json();
    } catch {
      return { success: true };
    }
  }

  async updateCustomerPassword(customerId: string, newPassword: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/customers/${encodeURIComponent(customerId)}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword })
    });
    await this.handleResponse(res);
    return true;
  }

  // --- Customers ---
  async getCustomers(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/customers`);
    return (await this.handleResponse(res)) || [];
  }

  async saveCustomer(cust: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cust)
    });
    return await this.handleResponse(res);
  }

  async importCustomers(customers: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: any[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const res = await this.request(`${this.baseUrl}/customers/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ customers })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Customer import failed with status ${res.status}`);
    }
    return data;
  }

  async deleteCustomer(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/customers/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.handleResponse(res);
    return true;
  }

  // --- Leads ---
  async getLeads(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/leads`);
    return (await this.handleResponse(res)) || [];
  }

  async saveLead(lead: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });
    return await this.handleResponse(res);
  }

  async updateLead(id: string, lead: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/leads/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    });
    return await this.handleResponse(res);
  }

  async deleteLead(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/leads/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.handleResponse(res);
    return true;
  }

  async importLeads(leads: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/leads/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ leads })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Lead import failed with status ${res.status}`);
    }
    return data;
  }

  // --- Projects ---
  async getProjects(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/projects`);
    return (await this.handleResponse(res)) || [];
  }

  async saveProject(proj: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/projects`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(proj)
    });
    return await this.handleResponse(res);
  }

  async updateProject(id: string, proj: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(proj)
    });
    return await this.handleResponse(res);
  }

  async updateProjectControlCenter(
    id: string,
    payload: {
      capacityKw?: number;
      totalValue?: number;
      receivedInflow?: number;
      city?: string;
      siteAddress?: string;
      location?: string;
    }
  ): Promise<{ project: any; customer: any | null; payments: any[] }> {
    const res = await this.request(`${this.baseUrl}/projects/${encodeURIComponent(id)}/control-center`, {
      method: 'PUT',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    return await this.handleResponse(res);
  }

  async deleteProject(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.handleResponse(res);
    return true;
  }

  async importProjects(projects: any[]): Promise<{
    success: boolean;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
    importedRecords?: any[];
    skippedRecords?: { row: number; name: string; reason: string }[];
    failedRecords?: { row: number; reason: string }[];
    errors?: string[];
  }> {
    const res = await this.request(`${this.baseUrl}/projects/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ projects })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Project import failed with status ${res.status}`);
    }
    return data;
  }

  // --- Employees ---
  async getEmployees(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/employees`);
    return (await this.handleResponse(res)) || [];
  }

  async saveEmployee(emp: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emp)
    });
    return await this.handleResponse(res);
  }

  async deleteEmployee(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/employees/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.handleResponse(res);
    return true;
  }

  async importEmployees(employees: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/employees/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ employees })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Employee import failed with status ${res.status}`);
    }
    return data;
  }

  async uploadEmployeeDocument(employeeId: string, docData: {
    name?: string;
    category?: string;
    fileName: string;
    mimeType?: string;
    fileData: string;
    notes?: string;
    uploadedBy?: string;
  }): Promise<any> {
    const res = await this.request(`${this.baseUrl}/employees/${encodeURIComponent(employeeId)}/documents/upload`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(docData)
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || data?.success === false || !data?.document?.fileUrl) {
      throw new Error(data?.error || data?.message || `Document upload failed with status ${res.status}`);
    }
    return data.document;
  }

  async deleteEmployeeDocument(employeeId: string, docId: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/employees/${encodeURIComponent(employeeId)}/documents/${encodeURIComponent(docId)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return Boolean(res.ok && data?.success !== false);
  }

  async getEmployeeDocuments(employeeId: string): Promise<any[]> {
    try {
      const res = await this.request(`${this.baseUrl}/employees/${encodeURIComponent(employeeId)}/documents`, {
        headers: this.getAuthHeaders()
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      return data?.data || [];
    } catch {
      return [];
    }
  }

  async uploadEmployeePhoto(employeeId: string, photoData: string, fileName?: string): Promise<string> {
    const res = await this.request(`${this.baseUrl}/employees/${encodeURIComponent(employeeId)}/photo/upload`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ photoData, fileName })
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || data?.success === false || !data?.photoUrl) {
      throw new Error(data?.error || data?.message || `Photo upload failed with status ${res.status}`);
    }
    return data.photoUrl;
  }

  // --- Attendance ---
  async getAttendance(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/attendance`, {
      headers: this.getAuthHeaders()
    });
    return (await this.handleResponse(res)) || [];
  }

  async saveAttendance(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/attendance`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async updateFuelApproval(
    attendanceId: string,
    approvalStatus: 'APPROVED' | 'REJECTED' | 'PENDING',
    reviewedBy: string,
    notes?: string
  ): Promise<any> {
    const res = await this.request(`${this.baseUrl}/attendance/${encodeURIComponent(attendanceId)}/fuel-approval`, {
      method: 'PUT',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        approvalStatus,
        approvedBy: reviewedBy,
        status: approvalStatus,
        reviewedBy,
        notes
      })
    });
    return await this.handleResponse(res);
  }

  async deleteAttendance(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/attendance/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  async importAttendance(attendance: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/attendance/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ attendance })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Attendance import failed with status ${res.status}`);
    }
    return data;
  }

  // --- Payroll / Payslips ---
  async getPayslips(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/payslips`, {
      headers: this.getAuthHeaders()
    });
    return (await this.handleResponse(res)) || [];
  }

  async savePayslip(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/payslips`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deletePayslip(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/payslips/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  // --- Holidays ---
  async getHolidays(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/holidays`, {
      headers: this.getAuthHeaders()
    });
    return (await this.handleResponse(res)) || [];
  }

  async saveHoliday(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/holidays`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteHoliday(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/holidays/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  // --- Employee Leave Management ---
  async getLeaves(year?: number): Promise<{
    leaveYear: number;
    canReview: boolean;
    myEmployee: {
      employeeId: string;
      employeeCode: string;
      employeeName: string;
      department: string;
      designation: string;
    };
    leaves: any[];
    balances: any[];
  }> {
    const query = year ? `?year=${encodeURIComponent(String(year))}` : '';
    const res = await this.request(`${this.baseUrl}/leaves${query}`, {
      headers: this.getAuthHeaders()
    });
    return await this.handleResponse(res);
  }

  async applyLeave(payload: {
    employeeId?: string;
    leaveType: 'CASUAL' | 'SICK' | 'EARNED' | 'UNPAID';
    startDate: string;
    endDate: string;
    isHalfDay?: boolean;
    halfDaySession?: 'FIRST_HALF' | 'SECOND_HALF';
    reason: string;
  }): Promise<any> {
    const res = await this.request(`${this.baseUrl}/leaves`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    return await this.handleResponse(res);
  }

  async reviewLeave(id: string, action: 'APPROVE' | 'REJECT', remarks?: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/leaves/${encodeURIComponent(id)}/review`, {
      method: 'PUT',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action, remarks })
    });
    return await this.handleResponse(res);
  }

  async cancelLeave(id: string, remarks?: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/leaves/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ remarks })
    });
    return await this.handleResponse(res);
  }

  // --- Products ---
  async getProducts(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/products`);
    return (await this.handleResponse(res)) || [];
  }

  async saveProduct(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteProduct(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  async importProducts(products: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/products/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ products })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Product import failed with status ${res.status}`);
    }
    return data;
  }

  // --- Vendors ---
  async getVendors(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/vendors`);
    return (await this.handleResponse(res)) || [];
  }

  async saveVendor(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/vendors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteVendor(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/vendors/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  async importVendors(vendors: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/vendors/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ vendors })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Vendor import failed with status ${res.status}`);
    }
    return data;
  }

  // --- Purchase Orders ---
  async getPurchaseOrders(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/purchase-orders`);
    return (await this.handleResponse(res)) || [];
  }

  async savePurchaseOrder(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/purchase-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deletePurchaseOrder(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/purchase-orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  // --- Bill of Materials (BOM) ---
  async getBOMs(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/boms`, { headers: this.getAuthHeaders() });
    return (await this.handleResponse(res)) || [];
  }

  async saveBOM(item: any): Promise<any> {
    const isUpdate = Boolean(item?.id);
    const url = isUpdate ? `${this.baseUrl}/boms/${encodeURIComponent(item.id)}` : `${this.baseUrl}/boms`;
    const res = await this.request(url, {
      method: isUpdate ? 'PUT' : 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteBOM(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/boms/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  // --- Sales Invoices ---
  async getSalesInvoices(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/sales-invoices`, { headers: this.getAuthHeaders() });
    return (await this.handleResponse(res)) || [];
  }

  async saveSalesInvoice(item: any): Promise<any> {
    const isUpdate = Boolean(item?.id);
    const url = isUpdate ? `${this.baseUrl}/sales-invoices/${encodeURIComponent(item.id)}` : `${this.baseUrl}/sales-invoices`;
    const res = await this.request(url, {
      method: isUpdate ? 'PUT' : 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteSalesInvoice(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/sales-invoices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  // --- Vendor Sales Invoices (Admin-Only) ---
  async getVendorSalesInvoices(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/vendor-sales-invoices`, {
      headers: this.getAuthHeaders()
    });
    return (await this.handleResponse(res)) || [];
  }

  async getNextVendorSalesInvoiceNumber(): Promise<string> {
    const res = await this.request(`${this.baseUrl}/vendor-sales-invoices/next-number`, {
      headers: this.getAuthHeaders()
    });
    const data = await this.handleResponse<{ invoiceNumber: string }>(res);
    return data?.invoiceNumber || `VSI-${new Date().getFullYear()}-001`;
  }

  async getVendorSalesInvoiceById(id: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/vendor-sales-invoices/${encodeURIComponent(id)}`, {
      headers: this.getAuthHeaders()
    });
    return await this.handleResponse(res);
  }

  async saveVendorSalesInvoice(item: any, isEdit: boolean = false): Promise<any> {
    const url = isEdit && item?.id
      ? `${this.baseUrl}/vendor-sales-invoices/${encodeURIComponent(item.id)}`
      : `${this.baseUrl}/vendor-sales-invoices`;
    const res = await this.request(url, {
      method: isEdit && item?.id ? 'PUT' : 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async recordVendorSalesPayment(
    invoiceId: string,
    payment: { amount: number; paymentDate?: string; paymentMode?: string; bankAccountId?: string; referenceNo?: string; notes?: string }
  ): Promise<any> {
    const res = await this.request(
      `${this.baseUrl}/vendor-sales-invoices/${encodeURIComponent(invoiceId)}/payments`,
      {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payment)
      }
    );
    return await this.handleResponse(res);
  }

  async recordPurchaseOrderPayment(
    poId: string,
    payment: {
      amount: number;
      tdsDeducted?: number;
      tdsSection?: string;
      paymentDate?: string;
      paymentMode?: string;
      bankAccountId: string;
      referenceNo?: string;
      notes?: string;
    }
  ): Promise<any> {
    const res = await this.request(
      `${this.baseUrl}/purchase-orders/${encodeURIComponent(poId)}/payments`,
      {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payment)
      }
    );
    return await this.handleResponse(res);
  }

  async recordSalesInvoicePayment(
    invoiceId: string,
    payment: {
      amount: number;
      paymentDate?: string;
      paymentMode?: string;
      bankAccountId: string;
      referenceNo?: string;
      notes?: string;
    }
  ): Promise<any> {
    const res = await this.request(
      `${this.baseUrl}/sales-invoices/${encodeURIComponent(invoiceId)}/payments`,
      {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payment)
      }
    );
    return await this.handleResponse(res);
  }

  // --- Sales & Purchase Returns ---
  async getSalesReturns(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/sales-returns`, {
      headers: this.getAuthHeaders()
    });
    return (await this.handleResponse(res)) || [];
  }

  async createSalesReturn(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/sales-returns`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    return await this.handleResponse(res);
  }

  async deleteSalesReturn(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/sales-returns/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  async getPurchaseReturns(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/purchase-returns`, {
      headers: this.getAuthHeaders()
    });
    return (await this.handleResponse(res)) || [];
  }

  async createPurchaseReturn(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/purchase-returns`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    return await this.handleResponse(res);
  }

  async deletePurchaseReturn(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/purchase-returns/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  async deleteVendorSalesInvoice(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/vendor-sales-invoices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  // --- Warehouses ---
  async getWarehouses(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/warehouses`);
    return (await this.handleResponse(res)) || [];
  }

  async saveWarehouse(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/warehouses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteWarehouse(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/warehouses/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  // --- Stock Movements ---
  async getStockMovements(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/stock-movements`);
    return (await this.handleResponse(res)) || [];
  }

  async saveStockMovement(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/stock-movements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  // --- Stock Audits ---
  async getStockAudits(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/stock-audits`);
    return (await this.handleResponse(res)) || [];
  }

  async saveStockAudit(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/stock-audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteStockAudit(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/stock-audits/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  // --- Quotations ---
  async getQuotations(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/quotations`);
    return (await this.handleResponse(res)) || [];
  }

  async saveQuotation(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/quotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteQuotation(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/quotations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  // --- Site Surveys ---
  async getSurveys(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/surveys`);
    return (await this.handleResponse(res)) || [];
  }

  async saveSurvey(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/surveys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteSurvey(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/surveys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  // --- Payments ---
  async getPayments(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/payments`);
    return (await this.handleResponse(res)) || [];
  }

  async savePayment(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deletePayment(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/payments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  async importPayments(payments: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/payments/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ payments })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Payment import failed with status ${res.status}`);
    }
    return data;
  }

  // --- Expenses ---
  async getExpenses(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/expenses`);
    return (await this.handleResponse(res)) || [];
  }

  async saveExpense(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/expenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteExpense(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/expenses/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  async importExpenses(expenses: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/expenses/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expenses })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Expense import failed with status ${res.status}`);
    }
    return data;
  }

  // --- Service Tickets ---
  async getServiceTickets(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/service-tickets`);
    return (await this.handleResponse(res)) || [];
  }

  async getEligibleServiceTechnicians(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/service-tickets/technicians`);
    return (await this.handleResponse(res)) || [];
  }

  async getServiceTicketDetails(id: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/service-tickets/${encodeURIComponent(id)}/details`);
    return await this.handleResponse(res);
  }

  async assignServiceTicketTechnician(
    id: string,
    payload: { technicianId: string | null; scheduledDate?: string | null; remarks?: string | null }
  ): Promise<any> {
    const res = await this.request(`${this.baseUrl}/service-tickets/${encodeURIComponent(id)}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await this.handleResponse(res);
  }

  async adminUpdateServiceTicket(
    id: string,
    payload: {
      status?: string;
      priority?: string;
      assignedTechnicianId?: string | null;
      scheduledDate?: string | null;
      technicianRemarks?: string;
      resolutionDetails?: string;
      notes?: string;
      resolvedDate?: string | null;
    }
  ): Promise<any> {
    const res = await this.request(`${this.baseUrl}/service-tickets/${encodeURIComponent(id)}/admin-update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await this.handleResponse(res);
  }

  async saveServiceTicket(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/service-tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteServiceTicket(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/service-tickets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  async importServiceTickets(tickets: any[]): Promise<BatchImportResult> {
    const res = await this.request(`${this.baseUrl}/service-tickets/import`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tickets })
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `Service tickets import failed with status ${res.status}`);
    }
    return data;
  }

  // --- AMC Contracts ---
  async getAMCContracts(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/amc-contracts`);
    return (await this.handleResponse(res)) || [];
  }

  async saveAMCContract(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/amc-contracts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async deleteAMCContract(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/amc-contracts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.handleResponse(res);
    return true;
  }

  // --- Notifications ---
  async getNotifications(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/notifications`);
    return (await this.handleResponse(res)) || [];
  }

  async saveNotification(item: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return await this.handleResponse(res);
  }

  async markNotificationRead(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' });
    await this.handleResponse(res);
    return true;
  }

  async markAllNotificationsRead(): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/notifications/mark-all-read`, { method: 'PUT' });
    await this.handleResponse(res);
    return true;
  }

  // --- Settings ---
  async getSettings(): Promise<any> {
    const res = await this.request(`${this.baseUrl}/settings`);
    return await this.handleResponse(res);
  }

  async saveSettings(settings: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    return await this.handleResponse(res);
  }

  // --- Users & Passwords ---
  async getUsers(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/users`, {
      headers: this.getAuthHeaders()
    });
    return (await this.handleResponse(res)) || [];
  }

  async saveUser(user: any): Promise<any> {
    try {
      const res = await this.request(`${this.baseUrl}/users`, {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(user)
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok || data?.success === false) {
        throw new Error(data?.message || data?.error || `Failed to save user (HTTP ${res.status})`);
      }
      return data?.data || user;
    } catch (e: any) {
      console.error('[apiClient] saveUser error:', e);
      throw e;
    }
  }

  async updateUser(id: string, updates: any): Promise<any> {
    try {
      const res = await this.request(`${this.baseUrl}/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(updates)
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok || data?.success === false) {
        throw new Error(data?.message || data?.error || `Failed to update user (HTTP ${res.status})`);
      }
      return data?.data || updates;
    } catch (e: any) {
      console.error('[apiClient] updateUser error:', e);
      throw e;
    }
  }

  async updateUserPassword(id: string, password: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await this.request(`${this.baseUrl}/users/${encodeURIComponent(id)}/password`, {
        method: 'PUT',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Failed to update password');
      }
      return data;
    } catch (e: any) {
      console.error('[apiClient] updateUserPassword error:', e);
      throw e;
    }
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await this.request(`${this.baseUrl}/auth/change-password`, {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ userId, oldPassword, newPassword })
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Failed to change password');
      }
      return data;
    } catch (e: any) {
      console.error('[apiClient] changePassword error:', e);
      throw e;
    }
  }

  async resetPassword(email: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await this.request(`${this.baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ email, newPassword })
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Failed to reset password');
      }
      return data;
    } catch (e: any) {
      console.error('[apiClient] resetPassword error:', e);
      throw e;
    }
  }

  async deleteUser(id: string): Promise<boolean> {
    const res = await this.request(`${this.baseUrl}/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    await this.handleResponse(res);
    return true;
  }

  private async parseJsonResponse(res: Response, fallbackMessage: string): Promise<any> {
    const rawText = await res.text().catch(() => '');
    let data: any = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
    }
    if (!res.ok || !data || data.success === false) {
      const msg =
        data?.message ||
        data?.error ||
        (res.status === 404
          ? 'API endpoint not found'
          : `${fallbackMessage} (HTTP ${res.status})`);
      throw new Error(msg);
    }
    return data;
  }

  // --- Gmail Email SMTP Configuration (Admin Only) & App Email ---
  async getEmailSettings(): Promise<EmailSettingsInfo> {
    const res = await this.request(`${this.baseUrl}/settings/email`, {
      headers: this.getAuthHeaders()
    });
    const data = await this.parseJsonResponse(res, 'Failed to load Gmail settings');
    return data.data;
  }

  async saveEmailSettings(payload: EmailConfigSavePayload): Promise<{ data: EmailSettingsInfo; message: string }> {
    const res = await this.request(`${this.baseUrl}/settings/email`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save Gmail settings');
    return {
      data: data.data,
      message: data.message || 'Gmail SMTP configuration saved securely.'
    };
  }

  async deleteEmailSettings(): Promise<{ data: EmailSettingsInfo; message: string }> {
    const res = await this.request(`${this.baseUrl}/settings/email`, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    });
    const data = await this.parseJsonResponse(res, 'Failed to remove Gmail settings');
    return {
      data: data.data,
      message: data.message || 'Gmail SMTP credentials removed.'
    };
  }

  async testEmailSettings(payload: {
    testRecipient: string;
    gmailAddress?: string;
    appPassword?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecurity?: 'TLS' | 'SSL';
    senderName?: string;
  }): Promise<{ message: string; data?: any }> {
    const res = await this.request(`${this.baseUrl}/settings/email/test`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'SMTP verification failed');
    return {
      message: data.message || 'Test email sent successfully.',
      data: data.data
    };
  }

  async getEmailStatus(): Promise<{
    configured: boolean;
    enabled: boolean;
    senderName: string;
    gmailAddress: string;
  }> {
    const res = await this.request(`${this.baseUrl}/email/status`, {
      headers: this.getAuthHeaders()
    });
    const data = await this.parseJsonResponse(res, 'Failed to check email gateway status');
    return data.data;
  }

  async sendEmail(payload: {
    to: string | string[];
    cc?: string | string[];
    replyTo?: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ message: string; data: { messageId: string; accepted: string[]; sentAt: string } }> {
    const res = await this.request(`${this.baseUrl}/email/send`, {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to send email');
    return {
      message: data.message || 'Email sent successfully.',
      data: data.data
    };
  }

  // --- Accounting & Finance Module API ---
  async getAccountingBankAccounts(): Promise<any[]> {
    const res = await this.request(`${this.baseUrl}/accounting/bank-accounts`, {
      headers: this.getAuthHeaders()
    });
    const data = await this.parseJsonResponse(res, 'Failed to load active Cash & Bank accounts');
    return Array.isArray(data?.data) ? data.data : [];
  }

  async getAccountingWorkspace(): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/workspace`);
    const data = await this.parseJsonResponse(res, 'Failed to load Accounting & Finance workspace');
    return data.data;
  }

  async saveAccountingAccount(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save ledger account');
    return data.data;
  }

  async deleteAccountingAccount(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete ledger account');
  }

  async saveJournalEntry(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/journals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save journal entry');
    return data.data;
  }

  async postJournalEntry(id: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/journals/${encodeURIComponent(id)}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await this.parseJsonResponse(res, 'Failed to post journal entry');
    return data.data;
  }

  async reverseJournalEntry(id: string, reason?: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/journals/${encodeURIComponent(id)}/reverse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || '' })
    });
    const data = await this.parseJsonResponse(res, 'Failed to reverse journal entry');
    return data.data;
  }

  async deleteJournalEntry(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/journals/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete draft journal entry');
  }

  async recordCustomerReceipt(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/customer-receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to record customer receipt');
    return data.data;
  }

  async updateCustomerReceipt(id: string, payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/customer-receipts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to update customer receipt');
    return data.data;
  }

  async deleteCustomerReceipt(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/customer-receipts/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete customer receipt');
  }

  async saveVendorBill(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/vendor-bills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save vendor bill');
    return data.data;
  }

  async deleteVendorBill(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/vendor-bills/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete vendor bill');
  }

  async recordVendorPayment(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/vendor-payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to record vendor payment');
    return data.data;
  }

  async deleteVendorPayment(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/vendor-payments/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to reverse vendor payment');
  }

  async saveBankAccount(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/bank-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save cash/bank account');
    return data.data;
  }

  async deleteBankAccount(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/bank-accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete bank/cash account');
  }

  async recordBankTransfer(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/bank-transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to record fund transfer');
    return data.data;
  }

  async deleteBankTransfer(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/bank-transfers/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to reverse fund transfer');
  }

  async saveBankReconciliation(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/bank-reconciliations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save bank reconciliation');
    return data.data;
  }

  async deleteBankReconciliation(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/bank-reconciliations/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete bank reconciliation draft');
  }

  async saveAccountingExpense(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/expenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to submit expense');
    return data.data;
  }

  async deleteAccountingExpense(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/expenses/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete expense');
  }

  async approveAccountingExpense(id: string, decision: 'APPROVED' | 'REJECTED', reason?: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/expenses/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, reason: reason || '' })
    });
    const data = await this.parseJsonResponse(res, 'Failed to update expense approval');
    return data.data;
  }

  async payAccountingExpense(id: string, payload: { bankAccountId: string; paidDate?: string }): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/expenses/${encodeURIComponent(id)}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to disburse expense payment');
    return data.data;
  }

  async depositTdsEntry(id: string, payload: { challanNo: string; bsrCode?: string; depositDate: string; bankAccountId: string }): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/tds/${encodeURIComponent(id)}/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to record TDS deposit');
    return data.data;
  }

  async generateEinvoiceIrn(invoiceId: string): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/einvoice/${encodeURIComponent(invoiceId)}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await this.parseJsonResponse(res, 'Failed to generate E-Invoice IRN');
    return data.data;
  }

  async saveBudget(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/budgets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save budget');
    return data.data;
  }

  async deleteBudget(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/budgets/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete budget');
  }

  async saveFixedAsset(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save fixed asset');
    return data.data;
  }

  async deleteFixedAsset(id: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/accounting/assets/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    await this.parseJsonResponse(res, 'Failed to delete fixed asset');
  }

  async runAssetDepreciation(id: string, payload: { runDate: string; months?: number; periodLabel?: string; customAmount?: number }): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/assets/${encodeURIComponent(id)}/depreciate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to post asset depreciation');
    return data.data;
  }

  async disposeAsset(id: string, payload: { disposalDate: string; disposalProceeds: number; bankAccountId?: string }): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/assets/${encodeURIComponent(id)}/dispose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to dispose fixed asset');
    return data.data;
  }

  async updateAccountingSettings(payload: any): Promise<any> {
    const res = await this.request(`${this.baseUrl}/accounting/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await this.parseJsonResponse(res, 'Failed to save finance settings');
    return data.data;
  }

  async syncErpVouchersToLedger(): Promise<{ syncedCount: number; breakdown: Record<string, number> }> {
    const res = await this.request(`${this.baseUrl}/accounting/sync-erp-vouchers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await this.parseJsonResponse(res, 'Failed to sync ERP vouchers into General Ledger');
    return data.data;
  }

  // --- Stage Workflow Photos & Vendor Bill Attachments ---
  resolveMediaUrl(url: string): string {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:') || raw.startsWith('blob:') || /^https?:\/\//i.test(raw)) {
      return raw;
    }
    if (raw.startsWith('/api/') && this.baseUrl !== '/api') {
      return `${this.baseUrl}${raw.slice(4)}`;
    }
    return raw;
  }

  async fetchAuthorizedBlobUrl(url: string): Promise<{ blobUrl: string; mimeType: string }> {
    const resolved = this.resolveMediaUrl(url);
    if (!resolved) {
      throw new Error('Attachment URL is empty.');
    }
    if (resolved.startsWith('data:') || resolved.startsWith('blob:')) {
      const mimeMatch = resolved.match(/^data:([^;]+);/);
      return {
        blobUrl: resolved,
        mimeType: mimeMatch ? mimeMatch[1] : 'application/octet-stream'
      };
    }

    const res = await this.request(resolved, { method: 'GET' });
    if (!res.ok) {
      let msg = `Failed to load attachment (HTTP ${res.status})`;
      try {
        const errData = await res.json();
        msg = errData?.error || errData?.message || msg;
      } catch {}
      throw new Error(msg);
    }

    const blob = await res.blob();
    const mimeType = blob.type || res.headers.get('Content-Type') || 'application/octet-stream';
    const blobUrl = URL.createObjectURL(blob);
    return { blobUrl, mimeType };
  }

  async uploadStagePhoto(
    projectId: string,
    stageKey: string,
    payload: {
      fileName: string;
      fileData: string;
      caption?: string;
      gpsCoordinates?: string;
    }
  ): Promise<{ photo: any; photos: any[] }> {
    const res = await this.request(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/stages/${encodeURIComponent(stageKey)}/photos`,
      {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      }
    );
    const data = await this.parseJsonResponse(res, 'Failed to upload stage workflow photo');
    return {
      photo: data.photo,
      photos: Array.isArray(data.photos) ? data.photos : []
    };
  }

  async deleteStagePhoto(
    projectId: string,
    stageKey: string,
    photoId: string
  ): Promise<{ photos: any[] }> {
    const res = await this.request(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/stages/${encodeURIComponent(stageKey)}/photos/${encodeURIComponent(photoId)}`,
      {
        method: 'DELETE',
        headers: this.getAuthHeaders()
      }
    );
    const data = await this.parseJsonResponse(res, 'Failed to delete stage workflow photo');
    return {
      photos: Array.isArray(data.photos) ? data.photos : []
    };
  }

  async uploadPurchaseOrderBill(
    poId: string,
    payload: {
      fileName: string;
      fileData: string;
    }
  ): Promise<{ bill: any; vendorBills: any[] }> {
    const res = await this.request(
      `${this.baseUrl}/purchase-orders/${encodeURIComponent(poId)}/bills`,
      {
        method: 'POST',
        headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      }
    );
    const data = await this.parseJsonResponse(res, 'Failed to upload vendor bill');
    return {
      bill: data.bill,
      vendorBills: Array.isArray(data.vendorBills) ? data.vendorBills : []
    };
  }

  async deletePurchaseOrderBill(
    poId: string,
    billId: string
  ): Promise<{ vendorBills: any[] }> {
    const res = await this.request(
      `${this.baseUrl}/purchase-orders/${encodeURIComponent(poId)}/bills/${encodeURIComponent(billId)}`,
      {
        method: 'DELETE',
        headers: this.getAuthHeaders()
      }
    );
    const data = await this.parseJsonResponse(res, 'Failed to delete vendor bill');
    return {
      vendorBills: Array.isArray(data.vendorBills) ? data.vendorBills : []
    };
  }
}

export interface EmailSettingsInfo {
  configured: boolean;
  hasAppPassword: boolean;
  gmailAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'TLS' | 'SSL';
  senderName: string;
  enabled: boolean;
  lastTestedAt: string | null;
  lastTestStatus: 'SUCCESS' | 'FAILED' | null;
  lastTestMessage: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface EmailConfigSavePayload {
  gmailAddress: string;
  appPassword?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'TLS' | 'SSL';
  senderName: string;
  enabled: boolean;
}

export const apiClient = new ApiClient();
