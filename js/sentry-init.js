(function () {
  if (typeof Sentry === 'undefined') return;
  Sentry.init({
    dsn: 'https://0f603e95191c1bc3bb3f01ba9069c907@o4511012754358272.ingest.de.sentry.io/4511012769759312',
    environment: window.location.hostname === 'steinsandvines.ca' ? 'production' : 'staging',
    tracesSampleRate: 0.1,
    release: 'steins-vines@1.2.0'
  });
})();
