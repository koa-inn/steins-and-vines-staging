/**
 * Admin-only configuration — loaded only on admin/staff pages.
 * (admin.html, brewpad.html, kiosk.html, batch.html)
 *
 * ADMIN_API_URL is a Google Apps Script web app URL protected by Google OAuth
 * ("Execute as: User accessing the web app"). Unauthenticated requests are
 * automatically rejected by Google — no server-side secret needed here.
 *
 * This file is kept separate from sheets-config.js so public-facing pages
 * do not receive it. A future improvement is to inject this value via CI/CD
 * secrets so it is not committed to the repo at all.
 */
SHEETS_CONFIG.ADMIN_API_URL = 'https://script.google.com/macros/s/AKfycbw_t1zzpa3AQxvzPqo2wAg-cBU3IdevmyEz8P-dL205VrO2jx4s3DP30WxYoVUSDI968g/exec';
