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
    subject: 'Verify your Got One Spare? account',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0B3D2E;">Welcome to Got One Spare?, ${name}!</h2>
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

async function sendPasswordResetEmail(toEmail, name, resetUrl) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: 'Reset your Got One Spare? password',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0B3D2E;">Reset your password</h2>
        <p>Hi ${name},</p>
        <p>We received a request to reset your password. Click the button below to choose a new one.</p>
        <p>
          <a href="${resetUrl}" style="background: #1AAB8A; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
            Reset my password
          </a>
        </p>
        <p style="color: #666; font-size: 13px;">
          If the button doesn't work, copy and paste this link:<br>
          ${resetUrl}
        </p>
        <p style="color: #999; font-size: 12px;">This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendVerificationEmail, sendDisputeNotification, sendPasswordResetEmail, sendSwapProposedEmail, sendSwapAcceptedEmail, sendSwapPostedEmail, sendSwapReceivedEmail, sendSwapReminderEmail, sendFounderWelcomeEmail };

const SITE_URL = process.env.FRONTEND_URL || 'https://www.gotonespare.com';

function emailWrapper(content) {
  return `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e8e8e4; border-radius: 8px; overflow: hidden;">
      <div style="background: #0B1120; padding: 20px 28px; display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 18px; font-weight: 900; color: white; letter-spacing: -0.3px;">Got One Spare?</span>
        <span style="font-size: 12px; color: rgba(255,255,255,0.4);">WC2026 Sticker Swaps</span>
      </div>
      <div style="padding: 28px;">
        ${content}
        <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid #f0f0f0; font-size: 11px; color: #bbb; line-height: 1.6;">
          You're receiving this because you have an account on <a href="${SITE_URL}" style="color: #1AAB8A;">gotonespare.com</a>.<br>
          You can update your email preferences in your <a href="${SITE_URL}" style="color: #1AAB8A;">profile settings</a>.
        </div>
      </div>
    </div>
  `;
}

function ctaButton(text, url) {
  return `<p style="margin: 20px 0;"><a href="${url}" style="background: #1AAB8A; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 700; font-size: 14px;">${text}</a></p>`;
}

async function sendSwapProposedEmail(toEmail, { recipientName, proposerName, swapId, count }) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: `🤝 ${proposerName} wants to swap stickers with you!`,
    html: emailWrapper(`
      <h2 style="color: #0B1120; font-size: 20px; margin: 0 0 16px;">New swap proposal</h2>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;">Hi ${recipientName},</p>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;"><strong>${proposerName}</strong> has proposed a swap with you on Got One Spare?</p>
      <div style="background: #f8f8f6; border: 1px solid #e8e8e4; border-left: 3px solid #1AAB8A; border-radius: 4px; padding: 14px 16px; margin: 16px 0;">
        <div style="font-size: 22px; font-weight: 900; color: #1AAB8A; font-family: monospace;">${count} stickers each way</div>
        <div style="font-size: 12px; color: #999; margin-top: 4px;">Equal swap — you give ${count}, you get ${count}</div>
      </div>
      <p style="color: #444; line-height: 1.6;">Log in to review the full sticker list and accept or decline.</p>
      ${ctaButton('View swap →', `${SITE_URL}`)}
      <p style="color: #999; font-size: 12px;">Swap reference: #${swapId}</p>
    `),
  });
}

async function sendSwapAcceptedEmail(toEmail, { recipientName, acceptorName, swapId, count }) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: `🎉 Your swap has been accepted!`,
    html: emailWrapper(`
      <h2 style="color: #0B1120; font-size: 20px; margin: 0 0 16px;">Swap accepted!</h2>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;">Hi ${recipientName},</p>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;"><strong>${acceptorName}</strong> has accepted your swap. Time to get posting!</p>
      <div style="background: #f0fdf9; border: 1px solid #A7F3D0; border-radius: 4px; padding: 14px 16px; margin: 16px 0;">
        <div style="font-size: 14px; font-weight: 700; color: #065F46;">✓ Both parties have accepted</div>
        <div style="font-size: 12px; color: #065F46; margin-top: 4px;">Open the swap to see the address and send your ${count} stickers.</div>
      </div>
      ${ctaButton('View swap and get posting →', `${SITE_URL}`)}
      <p style="color: #999; font-size: 12px;">Swap reference: #${swapId}</p>
    `),
  });
}

async function sendSwapPostedEmail(toEmail, { recipientName, senderName, swapId }) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: `📮 ${senderName} has posted their stickers`,
    html: emailWrapper(`
      <h2 style="color: #0B1120; font-size: 20px; margin: 0 0 16px;">Stickers on their way!</h2>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;">Hi ${recipientName},</p>
      <p style="color: #444; line-height: 1.6; margin: 0 0 16px;"><strong>${senderName}</strong> has marked their stickers as posted. Keep an eye out for them in the post!</p>
      <p style="color: #444; line-height: 1.6;">Don't forget to post your stickers back to them if you haven't already, and mark as received once your stickers arrive.</p>
      ${ctaButton('View swap →', `${SITE_URL}`)}
      <p style="color: #999; font-size: 12px;">Swap reference: #${swapId}</p>
    `),
  });
}

async function sendSwapReceivedEmail(toEmail, { recipientName, receiverName, swapId }) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: `📦 ${receiverName} has confirmed they received their stickers`,
    html: emailWrapper(`
      <h2 style="color: #0B1120; font-size: 20px; margin: 0 0 16px;">Stickers received!</h2>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;">Hi ${recipientName},</p>
      <p style="color: #444; line-height: 1.6; margin: 0 0 16px;"><strong>${receiverName}</strong> has confirmed they received their stickers from you. Great swap!</p>
      <p style="color: #444; line-height: 1.6;">Don't forget to mark your stickers as received once they arrive and leave a rating for your swap partner.</p>
      ${ctaButton('View swap →', `${SITE_URL}`)}
      <p style="color: #999; font-size: 12px;">Swap reference: #${swapId}</p>
    `),
  });
}

async function sendSwapReminderEmail(toEmail, { recipientName, proposerName, swapId, count }) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: `👀 Don't miss a potential sticker swap!`,
    html: emailWrapper(`
      <h2 style="color: #0B1120; font-size: 20px; margin: 0 0 16px;">You have a swap waiting</h2>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;">Hi ${recipientName},</p>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;"><strong>${proposerName}</strong> proposed a swap with you over 24 hours ago and is still waiting for your response.</p>
      <div style="background: #FEF3C7; border: 1px solid #FDE68A; border-radius: 4px; padding: 14px 16px; margin: 16px 0;">
        <div style="font-size: 14px; font-weight: 700; color: #92400E;">⏳ ${count} stickers each way — don't let it expire!</div>
      </div>
      ${ctaButton('Review and respond →', `${SITE_URL}`)}
      <p style="color: #999; font-size: 12px;">Swap reference: #${swapId}</p>
    `),
  });
}

async function sendFounderWelcomeEmail(toEmail, name) {
  return resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject: 'Welcome to the Founders Club 🏆',
    html: emailWrapper(`
      <h2 style="color: #92400E; font-size: 20px; margin: 0 0 16px;">🏆 Welcome to the Founders Club!</h2>
      <p style="color: #444; line-height: 1.6; margin: 0 0 12px;">Hi ${name},</p>
      <p style="color: #444; line-height: 1.6; margin: 0 0 16px;">Thank you so much for supporting Got One Spare? Because of your support, we can keep the site running and keep building new features and future sticker collections.</p>
      <div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 4px; padding: 16px 18px; margin: 16px 0;">
        <div style="font-size: 14px; font-weight: 700; color: #92400E; margin-bottom: 10px;">Your Founder benefits:</div>
        <ul style="margin: 0; padding-left: 20px; color: #78350F; font-size: 13px; line-height: 1.8;">
          <li>Founder badge displayed next to your name everywhere</li>
          <li>Gold profile styling</li>
          <li>Early access to vote on new features</li>
          <li>Lifetime recognition as a founding supporter</li>
        </ul>
      </div>
      <p style="color: #444; line-height: 1.6;">Core swapping, matching and messaging will always stay completely free for everyone — your support just helps keep it that way.</p>
      ${ctaButton('View your profile →', `${SITE_URL}`)}
    `),
  });
}
