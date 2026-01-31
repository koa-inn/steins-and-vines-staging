/**
 * Google Sheets configuration for Steins & Vines inventory system.
 *
 * Setup instructions:
 * 1. Create a Google Cloud project and enable the Google Sheets API.
 * 2. Create an OAuth 2.0 Client ID (Web application type).
 *    - Add your site origin to Authorized JavaScript origins.
 * 4. Create a Google Spreadsheet with tabs: Kits, Ingredients, Holds, Reservations, Config.
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

  // OAuth scope for read/write access to spreadsheets
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets',

  // Sheet/tab names within the spreadsheet
  SHEET_NAMES: {
    KITS: 'Kits',
    INGREDIENTS: 'Ingredients',
    HOLDS: 'Holds',
    RESERVATIONS: 'Reservations',
    CONFIG: 'Config'
  }
};
