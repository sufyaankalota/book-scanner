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

// ─── AI Vision: extract ISBN or Title from a captured image ───
// Uses OpenAI gpt-4o vision. Set OPENAI_API_KEY in Cloud Functions secrets.
//   firebase functions:secrets:set OPENAI_API_KEY
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

// gpt-4o pricing as of 2025-2026 (subject to change):
//   input  ~$2.50 / 1M tokens
//   output ~$10.00 / 1M tokens
//   image (1024x1024 high detail) ~765 tokens
const PRICE_INPUT_PER_TOKEN  = 2.50  / 1_000_000;
const PRICE_OUTPUT_PER_TOKEN = 10.00 / 1_000_000;

function extractIsbn13(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[\s-]/g, '');
  const m13 = cleaned.match(/97[89]\d{10}/g) || [];
  for (const c of m13) if (validIsbn13(c)) return c;
  const m10 = cleaned.match(/\d{9}[\dX]/g) || [];
  for (const c of m10) if (validIsbn10(c)) return isbn10To13(c);
  return null;
}
function validIsbn13(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}
function validIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  sum += s[9] === 'X' ? 10 : Number(s[9]);
  return sum % 11 === 0;
}
function isbn10To13(s) {
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

exports.extractFromImage = onCall({
  region: 'us-east1',
  secrets: [OPENAI_API_KEY],
  timeoutSeconds: 30,
  memory: '512MiB',
  maxInstances: 20,
  invoker: 'public',
  cors: true,
}, async (request) => {
  const { imageBase64, mode, podId, jobId } = request.data || {};
  if (!imageBase64 || !mode) throw new HttpsError('invalid-argument', 'imageBase64 and mode are required');
  if (!['isbn', 'title'].includes(mode)) throw new HttpsError('invalid-argument', 'mode must be isbn or title');
  // Reject excessively large images (>4MB base64 ~= 3MB raw)
  if (imageBase64.length > 4_500_000) throw new HttpsError('invalid-argument', 'image too large (max ~3MB)');

  const dataUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

  const prompt = mode === 'isbn'
    ? `You are an expert at reading ISBNs from photographs of book copyright pages, colophons, back covers, and barcode labels.

Look carefully across the ENTIRE image for any 10 or 13 digit number that is an ISBN. ISBNs are commonly:
- Printed near the words "ISBN", "ISBN-10", "ISBN-13", "International Standard Book Number"
- 13 digits starting with 978 or 979 (often hyphenated like 978-0-12-345678-9)
- 10 digits, sometimes ending in X
- Printed under a barcode on the back cover
- May appear multiple times (hardcover/paperback/ebook editions). If multiple appear, prefer the FIRST one printed or the 13-digit version of the printed edition.

Read the digits VERY carefully. Common confusions to avoid: 0/O, 1/I/l, 5/S, 8/B. Strip all hyphens and spaces.

Respond ONLY with strict JSON, no markdown, no commentary:
{"isbn":"<digits-only-or-null>","confidence":<0-1>}

If you genuinely cannot find any ISBN, return {"isbn":null,"confidence":0}.`
    : 'You are looking at a photograph of a book cover. Extract the main title and author. Ignore taglines, series numbers, and publisher names. Respond ONLY with strict JSON: {"title":"<string>","author":"<string-or-null>","confidence":<0-1>}. No markdown, no commentary. If unclear, return {"title":null,"author":null,"confidence":0}.';

  const body = {
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }],
    response_format: { type: 'json_object' },
    max_tokens: 200,
    temperature: 0,
  };

  let result, usage;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY.value()}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new HttpsError('internal', `OpenAI ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json();
    usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const raw = data.choices?.[0]?.message?.content || '{}';
    try { result = JSON.parse(raw); } catch { result = {}; }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', `OpenAI request failed: ${err.message}`);
  }

  const cost = (usage.prompt_tokens || 0) * PRICE_INPUT_PER_TOKEN
             + (usage.completion_tokens || 0) * PRICE_OUTPUT_PER_TOKEN;

  // Post-process by mode
  if (mode === 'isbn') {
    // Validate the model's ISBN against checksum; also try regex on raw output
    const candidate = result.isbn ? String(result.isbn).replace(/[\s-]/g, '') : null;
    let isbn = null;
    if (candidate && (validIsbn13(candidate) || validIsbn10(candidate))) {
      isbn = validIsbn13(candidate) ? candidate : isbn10To13(candidate);
    } else {
      // Fallback: scan raw text for any valid ISBN
      isbn = extractIsbn13(JSON.stringify(result));
    }
    result = { isbn, confidence: Number(result.confidence) || 0 };
  } else {
    result = {
      title: result.title ? String(result.title).trim() : null,
      author: result.author ? String(result.author).trim() : null,
      confidence: Number(result.confidence) || 0,
    };
  }

  // Log usage for cost reporting
  try {
    await db.collection('ai-usage').add({
      mode,
      podId: podId || null,
      jobId: jobId || null,
      model: 'gpt-4o',
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      costUsd: Number(cost.toFixed(6)),
      success: !!(mode === 'isbn' ? result.isbn : result.title),
      timestamp: Timestamp.now(),
    });
  } catch (e) { console.warn('ai-usage log failed:', e.message); }

  return { ...result, costUsd: Number(cost.toFixed(6)), model: 'gpt-4o' };
});
