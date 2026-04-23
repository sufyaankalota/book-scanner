/**
 * Firebase Cloud Function: sendDailyReport
 *
 * Runs on a schedule (default every day at 5pm EST) or can be called via HTTP.
 * Queries today's scans and exceptions, builds XLSX, emails it.
 *
 * Setup:
 *   1. cd functions && npm install
 *   2. Set SMTP environment variables (in .env or Cloud Functions secrets):
 *      SMTP_HOST=smtp.gmail.com  SMTP_PORT=587
 *      SMTP_USER=your-email@gmail.com  SMTP_PASS=your-app-password
 *      OR for SendGrid:
 *      SMTP_HOST=smtp.sendgrid.net  SMTP_PORT=587
 *      SMTP_USER=apikey  SMTP_PASS=SG.your-sendgrid-key
 *   3. firebase deploy --only functions
 *
 * The report email address is read from Firestore: config/schedule.reportEmail
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

initializeApp();
const db = getFirestore();

// ─── Build XLSX buffer from scans + exceptions ───
function buildReport(scans, exceptions, jobName) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Standard scans
  const standardScans = scans.filter((s) => s.type === 'standard');
  const scanRows = standardScans.map((s) => ({
    ISBN: s.isbn || '',
    PO: s.poName || '',
    Pod: s.podId || '',
    Scanner: s.scannerId || '',
    Timestamp: s.timestamp?.toDate?.()?.toLocaleString() || '',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(scanRows.length ? scanRows : [{ Note: 'No scans today' }]), 'Scans');

  // Sheet 2: Exception scans + manual exceptions
  const exceptionScans = scans.filter((s) => s.type === 'exception');
  const allExceptions = [
    ...exceptionScans.map((s) => ({
      ISBN: s.isbn || '',
      Reason: 'Not in Manifest',
      Pod: s.podId || '',
      Scanner: s.scannerId || '',
      Timestamp: s.timestamp?.toDate?.()?.toLocaleString() || '',
    })),
    ...exceptions.map((ex) => ({
      ISBN: ex.isbn || '',
      Title: ex.title || '',
      Reason: ex.reason || '',
      Pod: ex.podId || '',
      Scanner: ex.scannerId || '',
      Timestamp: ex.timestamp?.toDate?.()?.toLocaleString() || '',
    })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allExceptions.length ? allExceptions : [{ Note: 'No exceptions today' }]), 'Exceptions');

  // Sheet 3: Summary
  const podIds = [...new Set(scans.map((s) => s.podId))];
  const summaryRows = [
    { Metric: 'Job', Value: jobName },
    { Metric: 'Date', Value: new Date().toLocaleDateString() },
    { Metric: 'Total Standard Scans', Value: standardScans.length },
    { Metric: 'Total Exceptions (auto)', Value: exceptionScans.length },
    { Metric: 'Total Exceptions (manual)', Value: exceptions.length },
    ...podIds.map((pod) => ({
      Metric: `Pod ${pod} Scans`,
      Value: scans.filter((s) => s.podId === pod).length,
    })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');

  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

// ─── Core report logic ───
async function generateAndSendReport() {
  // Read schedule config
  const schedDoc = await db.doc('config/schedule').get();
  if (!schedDoc.exists) {
    console.log('No schedule config found');
    return { sent: false, reason: 'no_config' };
  }
  const { reportEmail, enabled } = schedDoc.data();
  if (!enabled || !reportEmail) {
    console.log('Report email not configured or schedule disabled');
    return { sent: false, reason: 'disabled_or_no_email' };
  }

  // Find active job
  const jobsSnap = await db.collection('jobs').where('meta.active', '==', true).limit(1).get();
  let jobId = null;
  let jobName = 'Unknown';
  if (!jobsSnap.empty) {
    jobId = jobsSnap.docs[0].id;
    jobName = jobsSnap.docs[0].data().meta?.name || 'Unknown';
  } else {
    console.log('No active job found');
    return { sent: false, reason: 'no_active_job' };
  }

  // Query today's data
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTs = Timestamp.fromDate(today);

  const [scansSnap, exceptionsSnap] = await Promise.all([
    db.collection('scans').where('jobId', '==', jobId).where('timestamp', '>=', todayTs).get(),
    db.collection('exceptions').where('jobId', '==', jobId).where('timestamp', '>=', todayTs).get(),
  ]);

  const scans = scansSnap.docs.map((d) => d.data());
  const exceptions = exceptionsSnap.docs.map((d) => d.data());

  // Build XLSX
  const xlsxBuffer = buildReport(scans, exceptions, jobName);
  const dateStr = new Date().toISOString().slice(0, 10);
  const fileName = `${jobName}_daily_report_${dateStr}.xlsx`;

  // Send email via SMTP
  const smtpConfig = process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      }
    : null;

  if (!smtpConfig) {
    console.error('SMTP not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS env vars.');
    return { sent: false, reason: 'smtp_not_configured' };
  }

  const transporter = nodemailer.createTransport(smtpConfig);
  await transporter.sendMail({
    from: `"PrepFort Reports" <${process.env.SMTP_USER}>`,
    to: reportEmail,
    subject: `📊 Daily Report — ${jobName} — ${dateStr}`,
    text: `Daily scan & exception report for ${jobName}.\n\nDate: ${dateStr}\nTotal Scans: ${scans.filter((s) => s.type === 'standard').length}\nTotal Exceptions: ${scans.filter((s) => s.type === 'exception').length + exceptions.length}\n\nSee attached XLSX for details.`,
    html: `
      <h2>📊 Daily Report — ${jobName}</h2>
      <p><strong>Date:</strong> ${dateStr}</p>
      <p><strong>Total Scans:</strong> ${scans.filter((s) => s.type === 'standard').length}</p>
      <p><strong>Total Exceptions:</strong> ${scans.filter((s) => s.type === 'exception').length + exceptions.length}</p>
      <p>See attached XLSX for full details.</p>
      <p style="color:#888;font-size:12px;">Sent by PrepFort Book Scanner</p>
    `,
    attachments: [{
      filename: fileName,
      content: xlsxBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }],
  });

  console.log(`Report sent to ${reportEmail}`);
  return { sent: true, to: reportEmail, scans: scans.length, exceptions: exceptions.length };
}

// ─── Scheduled trigger: every day at 5:00 PM EST ───
exports.sendDailyReport = onSchedule({
  schedule: 'every day 17:00',
  timeZone: 'America/New_York',
  region: 'us-east1',
}, async () => {
  await generateAndSendReport();
});

// ─── HTTP trigger: manual send (for testing or on-demand) ───
exports.sendReportNow = onRequest({
  region: 'us-east1',
  cors: true,
}, async (req, res) => {
  try {
    const result = await generateAndSendReport();
    res.json(result);
  } catch (err) {
    console.error('Report send failed:', err);
    res.status(500).json({ error: err.message });
  }
});
