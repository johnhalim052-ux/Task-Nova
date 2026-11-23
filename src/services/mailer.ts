import nodemailer from 'nodemailer';

export interface EmailDispatchResult {
  sent: boolean;
  smtpConfigured: boolean;
  reason?: string;
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const port = Number(process.env.SMTP_PORT || '587');
  const secure = process.env.SMTP_SECURE === 'true';
  const from = process.env.SMTP_FROM?.trim() || 'TaskNova <no-reply@tasknova.example>';

  if (!host || !user || !pass) {
    return null;
  }
  return { host, port, secure, user, pass, from };
}

export function isSmtpConfigured(): boolean {
  return getSmtpConfig() !== null;
}

async function sendEmail(to: string, subject: string, text: string): Promise<EmailDispatchResult> {
  const cfg = getSmtpConfig();
  if (!cfg) {
    return {
      sent: false,
      smtpConfigured: false,
      reason: 'SMTP credentials (SMTP_HOST, SMTP_USER, SMTP_PASS) are not configured.',
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: {
        user: cfg.user,
        pass: cfg.pass,
      },
    });
    await transporter.sendMail({
      from: cfg.from,
      to,
      subject,
      text,
    });
    return { sent: true, smtpConfigured: true };
  } catch (err) {
    console.error('SMTP delivery error:', err);
    return {
      sent: false,
      smtpConfigured: true,
      reason: 'SMTP server rejected or failed to deliver the email.',
    };
  }
}

export async function sendVerificationEmail(
  email: string,
  name: string,
  rawToken: string
): Promise<EmailDispatchResult> {
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const verifyLink = `${appUrl}/?verify_token=${encodeURIComponent(rawToken)}`;
  const body = [
    `Hello ${name},`,
    '',
    'Welcome to TaskNova. Verify your email address by opening the link below or entering your verification token in Account Settings:',
    verifyLink,
    '',
    'This link expires in 24 hours.',
  ].join('\n');

  return sendEmail(email, 'Verify your TaskNova email address', body);
}

export async function sendPasswordResetEmail(
  email: string,
  name: string,
  rawToken: string
): Promise<EmailDispatchResult> {
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const resetLink = `${appUrl}/?reset_token=${encodeURIComponent(rawToken)}`;
  const body = [
    `Hello ${name},`,
    '',
    'A password reset was requested for your TaskNova account. Use the link below within 1 hour to set a new password:',
    resetLink,
    '',
    'If you did not request this change, ignore this message.',
  ].join('\n');

  return sendEmail(email, 'TaskNova Password Reset Request', body);
}
