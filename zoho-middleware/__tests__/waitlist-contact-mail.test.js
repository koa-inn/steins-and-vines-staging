'use strict';

// ---------------------------------------------------------------------------
// axios mock — mailer.sendWaitlistContact sends via the Resend HTTPS API.
// Mirrors the mocking harness used by mailer.test.js.
// ---------------------------------------------------------------------------
jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn()
}));

var axios = require('axios');
var mailer = require('../lib/mailer');

var RESEND_EMAILS = 'https://api.resend.com/emails';

describe('mailer.sendWaitlistContact', () => {
  var origKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEND_API_KEY = 're_test_123';
    axios.post.mockResolvedValue({ data: { id: 'email_abc' } });
  });
  afterEach(() => {
    process.env.RESEND_API_KEY = origKey;
    if (origKey === undefined) delete process.env.RESEND_API_KEY;
  });

  test('rejects with Invalid-email Error when to is empty, never calls axios', async () => {
    await expect(mailer.sendWaitlistContact({
      to: '',
      subject: 'Subject',
      body: 'Body',
      bookingUrl: 'https://cal.com/book'
    })).rejects.toThrow(/[Ii]nvalid|missing/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects the same way for a malformed email', async () => {
    await expect(mailer.sendWaitlistContact({
      to: 'not-an-email',
      subject: 'Subject',
      body: 'Body',
      bookingUrl: 'https://cal.com/book'
    })).rejects.toThrow(/[Ii]nvalid|missing/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects when subject is empty — subject is required', async () => {
    await expect(mailer.sendWaitlistContact({
      to: 'jane@example.com',
      subject: '',
      body: 'x',
      bookingUrl: 'https://cal.com/book'
    })).rejects.toThrow();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects when body is empty — body is required', async () => {
    await expect(mailer.sendWaitlistContact({
      to: 'jane@example.com',
      subject: 'Subject',
      body: '',
      bookingUrl: 'https://cal.com/book'
    })).rejects.toThrow();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects when bookingUrl is empty — the link IS the payload (D-06)', async () => {
    await expect(mailer.sendWaitlistContact({
      to: 'jane@example.com',
      subject: 'Subject',
      body: 'Body',
      bookingUrl: ''
    })).rejects.toThrow();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a valid call posts to Resend exactly once with the given to/subject/body/bookingUrl', async () => {
    await mailer.sendWaitlistContact({
      to: 'jane@example.com',
      subject: 'Your spot is ready',
      body: 'Hi Jane,\n\nBook here.',
      bookingUrl: 'https://cal.com/steins-and-vines-tw8csc/ferment-kit'
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
    var call = axios.post.mock.calls[0];
    expect(call[0]).toBe(RESEND_EMAILS);
    expect(call[1].to).toEqual(['jane@example.com']);
    expect(call[1].subject).toBe('Your spot is ready');
    expect(call[1].reply_to).toBe('hello@steinsandvines.ca');
    expect(call[1].text).toBe('Hi Jane,\n\nBook here.');
    expect(call[1].html).toContain('href="https://cal.com/steins-and-vines-tw8csc/ferment-kit"');
  });

  test('HTML-escapes the staff-supplied body — <script> becomes &lt;script&gt;, never a raw tag', async () => {
    await mailer.sendWaitlistContact({
      to: 'jane@example.com',
      subject: 'Subject',
      body: 'Hello <script>alert(1)</script>',
      bookingUrl: 'https://cal.com/book'
    });
    var call = axios.post.mock.calls[0];
    expect(call[1].html).toContain('&lt;script&gt;');
    expect(call[1].html).not.toContain('<script>alert(1)</script>');
  });

  test('a rejected Resend call propagates as a rejected promise', async () => {
    axios.post.mockRejectedValue({ response: { data: { message: 'Resend down' } } });
    await expect(mailer.sendWaitlistContact({
      to: 'jane@example.com',
      subject: 'Subject',
      body: 'Body',
      bookingUrl: 'https://cal.com/book'
    })).rejects.toThrow(/Resend/);
  });
});
