/**
 * Google Sheets configuration for Steins & Vines inventory system.
 *
 * Setup instructions:
 * 1. Create a Google Cloud project and enable the Google Sheets API.
 * 2. Create an OAuth 2.0 Client ID (Web application type).
 *    - Add your site origin to Authorized JavaScript origins.
 * 4. Create a Google Spreadsheet with tabs: Kits, Ingredients, Holds, Reservations, Schedule, Config.
 * 5. Publish the Kits tab: File → Share → Publish to web → Kits tab → CSV.
 * 6. Fill in the values below.
 */
var SHEETS_CONFIG = {
  // Google Spreadsheet ID (from the spreadsheet URL)
  SPREADSHEET_ID: '10BzcANc_-dyS-Is_C4He7mMYHfJ2OSJS9V4p7D-1JrM',

  // OAuth 2.0 Client ID for staff sign-in
  CLIENT_ID: '8605205683-tck2da2tpp03vcbr5etauu9q7kompg3q.apps.googleusercontent.com',

  // Published CSV URL for the Kits tab (public, no auth required)
  PUBLISHED_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=0&single=true&output=csv',

  // Published CSV URL for the Ingredients tab (public, no auth required)
  PUBLISHED_INGREDIENTS_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=608476944&single=true&output=csv',

  // Published CSV URL for the Services tab (public, no auth required)
  PUBLISHED_SERVICES_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=223978911&single=true&output=csv',

  // Published CSV URL for the Schedule tab (public, no auth required)
  // Set this after publishing the Schedule tab: File → Share → Publish to web → Schedule tab → CSV
  PUBLISHED_SCHEDULE_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=1949632749&single=true&output=csv',

  // OAuth scope for read/write access to spreadsheets
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets',

  // Sheet/tab names within the spreadsheet
  // Web App URL for anonymous product event tracking (deploy trackEvent.gs as web app)
  // Leave blank to disable tracking; no events are sent until a URL is set.
  TRACK_EVENTS_URL: 'https://script.google.com/macros/s/AKfycbyWsu3oLF_q99IN_Xt-HdJrfLF9rXWxkGvd5HiG33stsrIDfpyMWzLXe-aeRoypM5C8RQ/exec',

  SHEET_NAMES: {
    KITS: 'Kits',
    INGREDIENTS: 'Ingredients',
    HOLDS: 'Holds',
    RESERVATIONS: 'Reservations',
    SCHEDULE: 'Schedule',
    CONFIG: 'Config',
    SERVICES: 'Services'
  }
};
