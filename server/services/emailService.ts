import crypto from 'crypto';
import nodemailer from 'nodemailer';

export type SmtpSecurity = 'TLS' | 'SSL';

export interface EmailSettingsRecord {
  id: string;
  gmail_address: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: SmtpSecurity;
  sender_name: string;
  encrypted_app_password: string;
  iv: string;
  auth_tag: string;
  enabled: number | boolean;
  last_tested_at: string | null;
  last_test_status: 'SUCCESS' | 'FAILED' | null;
  last_test_message: string | null;
  updated_by: string | null;
  updated_at: string | Date | null;
}

export interface SanitizedEmailSettings {
  configured: boolean;
  hasAppPassword: boolean;
  gmailAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  senderName: string;
  enabled: boolean;
  lastTestedAt: string | null;
  lastTestStatus: 'SUCCESS' | 'FAILED' | null;
  lastTestMessage: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface EmailConfigInput {
  gmailAddress: string;
  appPassword?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  senderName: string;
  enabled: boolean;
}

export interface SendAppEmailParams {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    encoding?: 'base64' | 'utf-8';
    contentType?: string;
  }>;
}

const DEFAULT_SMTP_HOST = 'smtp.gmail.com';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_REGEX = /^[a-zA-Z0-9.-]+$/;

function deriveEncryptionKey(): Buffer {
  const secretMaterial =
    process.env.EMAIL_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    'solar-urja-erp-email-kms-2026';
  return crypto.createHash('sha256').update(secretMaterial, 'utf8').digest();
}

export function encryptSecret(plaintext: string): {
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

export function decryptSecret(ciphertext: string, ivHex: string, authTagHex: string): string {
  const key = deriveEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

export function normalizeAppPassword(raw: string): string {
  return String(raw || '').replace(/\s+/g, '').trim();
}

export function isValidEmailAddress(email: string): boolean {
  return EMAIL_REGEX.test(String(email || '').trim());
}

export function sanitizeEmailConfig(row: EmailSettingsRecord | null | undefined): SanitizedEmailSettings {
  if (!row) {
    return {
      configured: false,
      hasAppPassword: false,
      gmailAddress: '',
      smtpHost: DEFAULT_SMTP_HOST,
      smtpPort: 587,
      smtpSecurity: 'TLS',
      senderName: 'Solar Urja ERP',
      enabled: true,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestMessage: null,
      updatedBy: null,
      updatedAt: null
    };
  }

  const security: SmtpSecurity = String(row.smtp_security || 'TLS').toUpperCase() === 'SSL' ? 'SSL' : 'TLS';
  const hasPassword = Boolean(row.encrypted_app_password && row.iv && row.auth_tag);

  return {
    configured: Boolean(row.gmail_address && hasPassword),
    hasAppPassword: hasPassword,
    gmailAddress: row.gmail_address || '',
    smtpHost: row.smtp_host || DEFAULT_SMTP_HOST,
    smtpPort: Number(row.smtp_port) || (security === 'SSL' ? 465 : 587),
    smtpSecurity: security,
    senderName: row.sender_name || 'Solar Urja ERP',
    enabled: row.enabled === 1 || row.enabled === true,
    lastTestedAt: row.last_tested_at || null,
    lastTestStatus: row.last_test_status || null,
    lastTestMessage: row.last_test_message || null,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

export function validateEmailConfigInput(
  body: any,
  hasExistingPassword: boolean
): { valid: true; data: EmailConfigInput } | { valid: false; error: string } {
  const gmailAddress = String(body?.gmailAddress || '').trim().toLowerCase();
  if (!gmailAddress || !isValidEmailAddress(gmailAddress)) {
    return { valid: false, error: 'Please enter a valid Gmail email address.' };
  }

  const smtpSecurity: SmtpSecurity =
    String(body?.smtpSecurity || 'TLS').trim().toUpperCase() === 'SSL' ? 'SSL' : 'TLS';

  const smtpHost = String(body?.smtpHost || DEFAULT_SMTP_HOST).trim() || DEFAULT_SMTP_HOST;
  if (!HOST_REGEX.test(smtpHost)) {
    return { valid: false, error: 'Invalid SMTP host format (use e.g. smtp.gmail.com).' };
  }

  const rawPort = body?.smtpPort;
  const defaultPort = smtpSecurity === 'SSL' ? 465 : 587;
  const smtpPort =
    rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== ''
      ? Number(rawPort)
      : defaultPort;

  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    return { valid: false, error: 'SMTP port must be a valid integer between 1 and 65535.' };
  }

  const senderName = String(body?.senderName || '').trim() || 'Solar Urja ERP';
  if (senderName.length > 150) {
    return { valid: false, error: 'Sender name must be 150 characters or fewer.' };
  }

  const normalizedPassword = body?.appPassword !== undefined ? normalizeAppPassword(body.appPassword) : '';
  if (!normalizedPassword && !hasExistingPassword) {
    return {
      valid: false,
      error: 'Gmail App Password is required. Generate a 16-character App Password in your Google Account Security settings.'
    };
  }
  if (normalizedPassword && normalizedPassword.length < 8) {
    return {
      valid: false,
      error: 'Gmail App Password appears too short. Please enter a valid Google App Password.'
    };
  }

  const enabled = body?.enabled === undefined ? true : Boolean(body.enabled);

  return {
    valid: true,
    data: {
      gmailAddress,
      ...(normalizedPassword ? { appPassword: normalizedPassword } : {}),
      smtpHost,
      smtpPort,
      smtpSecurity,
      senderName,
      enabled
    }
  };
}

export function createGmailTransporter(
  config: {
    gmailAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: SmtpSecurity;
  },
  decryptedPassword: string
) {
  const isSsl = config.smtpSecurity === 'SSL' || config.smtpPort === 465;
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: isSsl,
    requireTLS: !isSsl,
    auth: {
      user: config.gmailAddress,
      pass: decryptedPassword
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
}

export function formatSmtpError(err: any): string {
  const raw = String(err?.response || err?.message || err || 'Unknown SMTP error');
  const code = String(err?.code || '').toUpperCase();
  const responseCode = Number(err?.responseCode || 0);

  if (
    code === 'EAUTH' ||
    responseCode === 535 ||
    responseCode === 534 ||
    /username and password not accepted/i.test(raw) ||
    /invalid login/i.test(raw) ||
    /application-specific password required/i.test(raw)
  ) {
    return 'Gmail SMTP authentication failed (535). Please verify your Gmail address and use a 16-character Google App Password (regular Gmail passwords are rejected by Google SMTP).';
  }

  if (code === 'ECONNECTION' || code === 'ECONNREFUSED') {
    return 'Unable to connect to the SMTP server. Verify SMTP host, port (587 for TLS / 465 for SSL), and outbound firewall rules.';
  }

  if (code === 'ETIMEDOUT' || /timeout/i.test(raw)) {
    return 'SMTP server connection timed out. Check your SMTP host, port, and TLS/SSL security setting.';
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'SMTP hostname could not be resolved. Please verify the SMTP host (default: smtp.gmail.com).';
  }

  if (code === 'EENVELOPE' || /recipient/i.test(raw)) {
    return `Invalid recipient or sender address rejected by SMTP server: ${err?.message || 'Check recipient email.'}`;
  }

  // Strip any accidental credential reflection
  return raw.replace(/pass(word)?[:=]\s*\S+/gi, 'password=[REDACTED]').slice(0, 300);
}

function formatFromHeader(senderName: string, gmailAddress: string): string {
  const cleanName = String(senderName || 'Solar Urja ERP').replace(/["\r\n<>]/g, '').trim();
  return cleanName ? `"${cleanName}" <${gmailAddress}>` : gmailAddress;
}

export async function verifyAndSendTestEmail(params: {
  config: {
    gmailAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: SmtpSecurity;
    senderName: string;
  };
  decryptedPassword: string;
  recipientEmail: string;
  requestedBy?: string;
}): Promise<{ messageId: string; accepted: string[]; sentAt: string }> {
  const recipient = String(params.recipientEmail || '').trim();
  if (!isValidEmailAddress(recipient)) {
    throw new Error('Please provide a valid recipient email address for the test email.');
  }

  const transporter = createGmailTransporter(params.config, params.decryptedPassword);
  await transporter.verify();

  const sentAt = new Date().toISOString();
  const info = await transporter.sendMail({
    from: formatFromHeader(params.config.senderName, params.config.gmailAddress),
    to: recipient,
    subject: 'Solar Urja ERP — Gmail SMTP Configuration Test',
    text: [
      'Solar Urja ERP (solar.klyiatechnology.com) — Gmail SMTP Verification',
      '',
      'Your Gmail SMTP configuration has been verified and is active.',
      `Sender Name: ${params.config.senderName}`,
      `From Address: ${params.config.gmailAddress}`,
      `SMTP Host: ${params.config.smtpHost}:${params.config.smtpPort} (${params.config.smtpSecurity})`,
      `Triggered By: ${params.requestedBy || 'System Administrator'}`,
      `Timestamp (UTC): ${sentAt}`
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
        <div style="background: #0f2954; color: #ffffff; padding: 20px 24px;">
          <h2 style="margin: 0; font-size: 18px; color: #f97316;">Solar Urja ERP — Email Verified</h2>
          <p style="margin: 4px 0 0; font-size: 12px; color: #cbd5e1;">solar.klyiatechnology.com • Gmail SMTP Configuration Test Successful</p>
        </div>
        <div style="padding: 20px 24px; color: #1e293b; font-size: 14px; line-height: 1.6;">
          <p style="margin-top: 0;">Your ERP application email gateway is connected and working correctly.</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; background: #f8fafc; border-radius: 8px;">
            <tr><td style="padding: 8px 12px; color: #64748b;">Sender Name</td><td style="padding: 8px 12px; font-weight: 600;">${params.config.senderName}</td></tr>
            <tr><td style="padding: 8px 12px; color: #64748b;">Gmail Address</td><td style="padding: 8px 12px; font-weight: 600;">${params.config.gmailAddress}</td></tr>
            <tr><td style="padding: 8px 12px; color: #64748b;">SMTP Server</td><td style="padding: 8px 12px; font-family: monospace;">${params.config.smtpHost}:${params.config.smtpPort} (${params.config.smtpSecurity})</td></tr>
            <tr><td style="padding: 8px 12px; color: #64748b;">Tested By</td><td style="padding: 8px 12px;">${params.requestedBy || 'System Administrator'}</td></tr>
          </table>
          <p style="margin-bottom: 0; margin-top: 16px; font-size: 12px; color: #64748b;">Sent at ${sentAt}</p>
        </div>
      </div>
    `
  });

  return {
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [recipient],
    sentAt
  };
}

export async function sendConfiguredEmail(
  row: EmailSettingsRecord | null,
  mail: SendAppEmailParams
): Promise<{ messageId: string; accepted: string[]; sentAt: string }> {
  if (!row || !row.gmail_address || !row.encrypted_app_password || !row.iv || !row.auth_tag) {
    const err: any = new Error(
      'Gmail email integration is not configured yet. Ask an Administrator to configure Gmail SMTP in System Settings.'
    );
    err.statusCode = 400;
    throw err;
  }

  if (row.enabled === 0 || row.enabled === false) {
    const err: any = new Error(
      'Gmail email integration is currently disabled by the Administrator in System Settings.'
    );
    err.statusCode = 400;
    throw err;
  }

  const normalizeRecipients = (val?: string | string[]): string[] => {
    if (!val) return [];
    const list = Array.isArray(val) ? val : String(val).split(',');
    return list.map(s => s.trim()).filter(Boolean);
  };

  const toList = normalizeRecipients(mail.to);
  if (toList.length === 0 || !toList.every(isValidEmailAddress)) {
    const err: any = new Error('Please enter a valid recipient email address.');
    err.statusCode = 400;
    throw err;
  }

  const subject = String(mail.subject || '').trim();
  if (!subject) {
    const err: any = new Error('Email subject is required.');
    err.statusCode = 400;
    throw err;
  }

  const text = String(mail.text || '').trim();
  const html = String(mail.html || '').trim();
  if (!text && !html) {
    const err: any = new Error('Email message body is required.');
    err.statusCode = 400;
    throw err;
  }

  const decryptedPassword = decryptSecret(row.encrypted_app_password, row.iv, row.auth_tag);
  const sanitized = sanitizeEmailConfig(row);
  const transporter = createGmailTransporter(sanitized, decryptedPassword);

  const ccList = normalizeRecipients(mail.cc);
  const bccList = normalizeRecipients(mail.bcc);

  const info = await transporter.sendMail({
    from: formatFromHeader(sanitized.senderName, sanitized.gmailAddress),
    to: toList,
    ...(ccList.length > 0 ? { cc: ccList } : {}),
    ...(bccList.length > 0 ? { bcc: bccList } : {}),
    ...(mail.replyTo && isValidEmailAddress(mail.replyTo) ? { replyTo: mail.replyTo.trim() } : {}),
    subject,
    text: text || undefined,
    html: html || undefined,
    attachments: mail.attachments?.map(a => ({
      filename: a.filename,
      content: a.content,
      encoding: a.encoding || 'base64',
      contentType: a.contentType
    }))
  });

  return {
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : toList,
    sentAt: new Date().toISOString()
  };
}
