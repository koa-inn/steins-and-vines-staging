var gp = require('globalpayments-api');
var log = require('./logger');

var ServicesContainer = gp.ServicesContainer;
var GpApiConfig = gp.GpApiConfig;
var Channel = gp.Channel;
var Environment = gp.Environment;
var ConnectionConfig = require('globalpayments-api/lib/src/Terminals/ConnectionConfig').ConnectionConfig;
var DeviceService = require('globalpayments-api/lib/src/Services/DeviceService').DeviceService;
var DeviceType = gp.DeviceType;
var ConnectionModes = require('globalpayments-api/lib/src/Terminals/Enums').ConnectionModes;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

var gpConfig = null;
var gpTerminalDevice = null;
var gpTerminalInitError = null;
var GP_DEPOSIT_AMOUNT = parseFloat(process.env.GP_DEPOSIT_AMOUNT) || 50.00;
var GP_TERMINAL_ENABLED = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the Global Payments SDK (card-not-present) and optionally
 * the terminal device (card-present via Meet in the Cloud).
 * Call once at startup.
 */
function init() {
  GP_DEPOSIT_AMOUNT = parseFloat(process.env.GP_DEPOSIT_AMOUNT) || 50.00;
  GP_TERMINAL_ENABLED = (process.env.GP_TERMINAL_ENABLED || '').trim().toLowerCase() === 'true';

  if (process.env.GP_APP_KEY) {
    gpConfig = new GpApiConfig();
    gpConfig.appId = process.env.GP_APP_ID || '';
    gpConfig.appKey = process.env.GP_APP_KEY;
    gpConfig.channel = Channel.CardNotPresent;
    gpConfig.country = 'CA';
    gpConfig.deviceCurrency = 'CAD';
    gpConfig.environment = process.env.GP_ENVIRONMENT === 'production'
      ? Environment.Production : Environment.Test;
    if (process.env.GP_MERCHANT_ID) {
      gpConfig.merchantId = process.env.GP_MERCHANT_ID;
    }
    ServicesContainer.configureService(gpConfig);
    log.info('Global Payments SDK configured (deposit: $' + GP_DEPOSIT_AMOUNT.toFixed(2) + ')');
  } else {
    log.info('Global Payments SDK not configured (GP_APP_KEY missing)');
  }

  // ---------------------------------------------------------------------------
  // Global Payments Terminal (card-present via Meet in the Cloud)
  // ---------------------------------------------------------------------------

  if (GP_TERMINAL_ENABLED && process.env.GP_APP_KEY) {
    try {
      var terminalConfig = new ConnectionConfig();
      terminalConfig.deviceType = DeviceType.UPA_DEVICE;
      terminalConfig.connectionMode = ConnectionModes.MEET_IN_THE_CLOUD;

      var terminalGateway = new GpApiConfig();
      terminalGateway.appId = process.env.GP_APP_ID || '';
      terminalGateway.appKey = process.env.GP_APP_KEY;
      terminalGateway.channel = Channel.CardPresent;
      terminalGateway.country = 'CA';
      terminalGateway.deviceCurrency = 'CAD';
      terminalGateway.environment = process.env.GP_ENVIRONMENT === 'production'
        ? Environment.Production : Environment.Test;
      if (process.env.GP_MERCHANT_ID) {
        terminalGateway.merchantId = process.env.GP_MERCHANT_ID;
      }

      terminalConfig.gatewayConfig = terminalGateway;
      gpTerminalDevice = DeviceService.create(terminalConfig, 'terminal');
      gpTerminalInitError = null;
      log.info('GP Terminal configured (Meet in the Cloud)');
    } catch (termErr) {
      log.error('GP Terminal configuration failed: ' + termErr.message);
      gpTerminalDevice = null;
      gpTerminalInitError = termErr.message;
    }
  } else {
    log.info('GP Terminal not enabled (GP_TERMINAL_ENABLED=' + (process.env.GP_TERMINAL_ENABLED || 'false') + ')');
  }
}

function getConfig() {
  return gpConfig;
}

function getTerminal() {
  return gpTerminalDevice;
}

function isTerminalEnabled() {
  return GP_TERMINAL_ENABLED && !!gpTerminalDevice;
}

function getTerminalDiagnostics() {
  return {
    GP_TERMINAL_ENABLED: GP_TERMINAL_ENABLED,
    GP_TERMINAL_ENABLED_RAW: JSON.stringify(process.env.GP_TERMINAL_ENABLED),
    GP_APP_KEY_SET: !!process.env.GP_APP_KEY,
    GP_APP_ID_SET: !!process.env.GP_APP_ID,
    GP_ENVIRONMENT: process.env.GP_ENVIRONMENT || 'sandbox',
    device_initialized: !!gpTerminalDevice,
    init_error: gpTerminalInitError || null
  };
}

function getDepositAmount() {
  return GP_DEPOSIT_AMOUNT;
}

module.exports = {
  init: init,
  getConfig: getConfig,
  getTerminal: getTerminal,
  isTerminalEnabled: isTerminalEnabled,
  getTerminalDiagnostics: getTerminalDiagnostics,
  getDepositAmount: getDepositAmount
};
