/**
 * Email sending utility.
 *
 * Uses Resend (https://resend.com) — sign up for a free account,
 * create an API key, and set RESEND_API_KEY as an environment variable.
 *
 * Without a verified custom domain, emails must be sent from
 * 'onboarding@resend.dev' (Resend's shared test sender). This works
 * fine for verification/notification emails at moderate volume.
 * If you later verify your own domain on Resend, change FROM_EMAIL
 * to something like 'noreply@yourdomain.com'.
 */

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

async function sendVerificationEmail(toEmail, name, verifyUrl) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: 'Verify your SwapShelf account',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0B3D2E;">Welcome to SwapShelf, ${name}!</h2>
        <p>Please confirm your email address to start swapping stickers.</p>
        <p>
          <a href="${verifyUrl}" style="background: #0B3D2E; color: #FAF6EC; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
            Verify my email
          </a>
        </p>
        <p style="color: #666; font-size: 13px;">
          If the button doesn't work, copy and paste this link:<br>
          ${verifyUrl}
        </p>
        <p style="color: #999; font-size: 12px;">This link expires in 24 hours.</p>
      </div>
    `,
  });
}

async function sendDisputeNotification(toEmail, name, swapId, reason) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: `A swap you're part of has been flagged (Swap #${swapId})`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #C8102E;">Swap #${swapId} flagged</h2>
        <p>Hi ${name},</p>
        <p>The other person in your swap has reported an issue: "${reason}"</p>
        <p>Please check the app for details and respond if needed.</p>
      </div>
    `,
  });
}

module.exports = { sendVerificationEmail, sendDisputeNotification };
