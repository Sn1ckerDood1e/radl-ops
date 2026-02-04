/**
 * Email Integration - Send briefings and notifications via Resend
 */

import { Resend } from 'resend';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

let resend: Resend | null = null;

/**
 * Initialize Resend client
 */
export function initEmail(): Resend | null {
  if (!config.email.resendApiKey) {
    logger.warn('Resend API key not configured, email disabled');
    return null;
  }

  resend = new Resend(config.email.resendApiKey);
  return resend;
}

/**
 * Send a briefing email
 */
export async function sendBriefingEmail(
  subject: string,
  content: string,
  type: 'daily' | 'weekly'
): Promise<boolean> {
  if (!resend) {
    resend = initEmail();
  }

  if (!resend || !config.email.briefingEmail) {
    logger.warn('Email not configured, skipping briefing email');
    return false;
  }

  try {
    const htmlContent = formatBriefingHtml(content, type);

    await resend.emails.send({
      from: 'Radl Ops <ops@radl.app>',
      to: config.email.briefingEmail,
      subject,
      html: htmlContent,
      text: content,
    });

    logger.info('Briefing email sent', { subject, to: config.email.briefingEmail });
    return true;
  } catch (error) {
    logger.error('Failed to send briefing email', { error });
    return false;
  }
}

/**
 * Send a notification email
 */
export async function sendNotificationEmail(
  subject: string,
  message: string
): Promise<boolean> {
  if (!resend) {
    resend = initEmail();
  }

  if (!resend || !config.email.briefingEmail) {
    logger.warn('Email not configured, skipping notification');
    return false;
  }

  try {
    await resend.emails.send({
      from: 'Radl Ops <ops@radl.app>',
      to: config.email.briefingEmail,
      subject: `[Radl Ops] ${subject}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a1a;">📢 ${subject}</h2>
          <div style="color: #4a4a4a; line-height: 1.6;">
            ${message.replace(/\n/g, '<br>')}
          </div>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #888; font-size: 12px;">
            Sent by Radl Ops at ${new Date().toISOString()}
          </p>
        </div>
      `,
      text: message,
    });

    logger.info('Notification email sent', { subject });
    return true;
  } catch (error) {
    logger.error('Failed to send notification email', { error });
    return false;
  }
}

/**
 * Send an approval request email
 */
export async function sendApprovalRequestEmail(
  action: string,
  details: string,
  approvalId: string
): Promise<boolean> {
  if (!resend) {
    resend = initEmail();
  }

  if (!resend || !config.email.briefingEmail) {
    logger.warn('Email not configured, skipping approval request');
    return false;
  }

  try {
    await resend.emails.send({
      from: 'Radl Ops <ops@radl.app>',
      to: config.email.briefingEmail,
      subject: `[Action Required] Approval needed: ${action}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a1a;">⚠️ Approval Required</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Radl Ops wants to perform the following action:
          </p>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
            <strong>${action}</strong>
            <pre style="white-space: pre-wrap; font-size: 13px; color: #666;">${details}</pre>
          </div>
          <p style="color: #4a4a4a;">
            Approval ID: <code>${approvalId}</code>
          </p>
          <p style="color: #888; font-size: 14px;">
            Reply to this email or respond in Slack with "approve" or "reject".
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #888; font-size: 12px;">
            Sent by Radl Ops at ${new Date().toISOString()}
          </p>
        </div>
      `,
      text: `Approval Required: ${action}\n\n${details}\n\nApproval ID: ${approvalId}\n\nRespond with "approve" or "reject".`,
    });

    logger.info('Approval request email sent', { action, approvalId });
    return true;
  } catch (error) {
    logger.error('Failed to send approval request email', { error });
    return false;
  }
}

/**
 * Format briefing content as HTML
 */
function formatBriefingHtml(content: string, type: 'daily' | 'weekly'): string {
  const title = type === 'daily' ? '📊 Daily Briefing' : '📅 Weekly Briefing';
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Convert markdown-like formatting to HTML
  let htmlContent = content
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Wrap list items
  htmlContent = htmlContent.replace(/(<li>.*<\/li>)+/g, '<ul>$&</ul>');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; background: #f9fafb;">
      <div style="background: white; border-radius: 12px; padding: 30px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <header style="border-bottom: 2px solid #eee; padding-bottom: 15px; margin-bottom: 20px;">
          <h1 style="color: #1a1a1a; margin: 0 0 5px 0; font-size: 24px;">${title}</h1>
          <p style="color: #666; margin: 0; font-size: 14px;">${date}</p>
        </header>

        <main style="color: #4a4a4a; line-height: 1.7;">
          <p>${htmlContent}</p>
        </main>

        <footer style="border-top: 1px solid #eee; padding-top: 15px; margin-top: 25px;">
          <p style="color: #888; font-size: 12px; margin: 0;">
            Generated by Radl Ops • ${new Date().toISOString()}
          </p>
        </footer>
      </div>
    </body>
    </html>
  `;
}

export { resend };
