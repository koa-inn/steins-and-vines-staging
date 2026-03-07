'use strict';

describe('logger', () => {
  var logger;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    logger = require('../lib/logger');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('development mode (non-production)', () => {
    test('info calls console.log with the message', () => {
      logger.info('hello world');
      expect(console.log).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
    });

    test('warn calls console.error', () => {
      logger.warn('be careful');
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.log).not.toHaveBeenCalled();
    });

    test('error calls console.error', () => {
      logger.error('oh no');
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    test('debug does not log when LOG_LEVEL is unset', () => {
      logger.debug('verbose');
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    test('debug logs when LOG_LEVEL=debug', () => {
      jest.resetModules();
      process.env.LOG_LEVEL = 'debug';
      jest.spyOn(console, 'log').mockImplementation(() => {});
      var debugLogger = require('../lib/logger');
      debugLogger.debug('verbose stuff');
      expect(console.log).toHaveBeenCalledTimes(1);
    });

    test('human-readable format includes timestamp, level, and message', () => {
      logger.info('test message');
      var call = console.log.mock.calls[0][0];
      expect(call).toContain('test message');
      expect(call).toContain('INFO');
    });

    test('extra fields are JSON-stringified inline', () => {
      logger.info('with extra', { requestId: 'abc' });
      var call = console.log.mock.calls[0][0];
      expect(call).toContain('requestId');
    });
  });

  describe('production mode (NODE_ENV=production)', () => {
    beforeEach(() => {
      jest.resetModules();
      process.env.NODE_ENV = 'production';
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
      logger = require('../lib/logger');
    });

    afterEach(() => {
      delete process.env.NODE_ENV;
    });

    test('info outputs valid JSON to console.log', () => {
      logger.info('msg');
      expect(console.log).toHaveBeenCalledTimes(1);
      var call = console.log.mock.calls[0][0];
      var parsed = JSON.parse(call);
      expect(parsed.level).toBe('info');
      expect(parsed.msg).toBe('msg');
      expect(parsed.ts).toBeTruthy();
    });

    test('error outputs valid JSON to console.error', () => {
      logger.error('bad thing');
      expect(console.error).toHaveBeenCalledTimes(1);
      var call = console.error.mock.calls[0][0];
      var parsed = JSON.parse(call);
      expect(parsed.level).toBe('error');
    });

    test('warn outputs valid JSON to console.error', () => {
      logger.warn('careful');
      expect(console.error).toHaveBeenCalledTimes(1);
      var call = console.error.mock.calls[0][0];
      var parsed = JSON.parse(call);
      expect(parsed.level).toBe('warn');
    });

    test('info does not write to console.error', () => {
      logger.info('msg');
      expect(console.error).not.toHaveBeenCalled();
    });

    test('JSON includes extra fields merged at top level', () => {
      logger.info('msg', { requestId: '123', status: 200 });
      var call = console.log.mock.calls[0][0];
      var parsed = JSON.parse(call);
      expect(parsed.requestId).toBe('123');
      expect(parsed.status).toBe(200);
    });

    test('JSON includes host field', () => {
      logger.info('msg');
      var call = console.log.mock.calls[0][0];
      var parsed = JSON.parse(call);
      expect(parsed.host).toBeTruthy();
    });
  });
});
