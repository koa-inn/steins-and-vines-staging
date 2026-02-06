// ===== Anonymous Event Tracking =====

var _eventQueue = [];
var _EVENT_FLUSH_THRESHOLD = 5;

function trackEvent(type, sku, name) {
  var url = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.TRACK_EVENTS_URL)
    ? SHEETS_CONFIG.TRACK_EVENTS_URL
    : '';
  if (!url) return;
  _eventQueue.push({ type: type, sku: sku, name: name });
  if (_eventQueue.length >= _EVENT_FLUSH_THRESHOLD) {
    flushEvents();
  }
}

function flushEvents() {
  if (_eventQueue.length === 0) return;
  var url = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.TRACK_EVENTS_URL)
    ? SHEETS_CONFIG.TRACK_EVENTS_URL
    : '';
  if (!url) return;
  var payload = JSON.stringify({ events: _eventQueue });
  _eventQueue = [];
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
  }
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') {
    flushEvents();
  }
});

// SV logo inline SVG for beer label cards (fill: currentColor for tinting)
var SV_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" data-name="Layer 2" viewBox="0 0 797.15 942.65"><g data-name="Layer 1"><path d="M67.88 876.85c71.18 35.21 208.97 46.04 324.73 44.8-5.81-11.76-6.6-24.49-2.6-36.02-10.83-1.36-19.04-9.7-23.55-14.29l-.24-.26c-13.72-14.95-15.42-38.83-4.01-55.68.16-.28.36-.55.55-.84-3.89 4.75-8.86 9.15-14.76 13.01-2.12 1.41-4.61 2.12-7.1 2.12-.29 0-.58 0-.88-.02-4.25 3.63-8.63 6.24-12.13 8.16l-.28.15c-5.16 2.79-11.22 5.64-16.96 5.64-4.57 0-8.68-1.77-11.55-4.96-1.51-1.69-2.6-3.67-3.21-5.84-2.32.5-4.74.75-7.23.75-6.36 0-12.11-1.57-17.69-3.08-4.8-1.31-9.36-2.55-13.66-2.55-.52 0-1.05.02-1.57.05-.32.03-.65.05-.96.05-4.27 0-8.27-2.09-10.7-5.63-2.61-3.81-3-8.71-1.04-12.89 1.61-3.39 2.42-7.93 3.28-12.72 1.49-8.24 3.28-18.13 9.99-26.52-.32-.28-.63-.57-.94-.89l-.13-.13c-4.14-4.44-5.14-10.82-2.61-16.62 3.6-8.3 16.57-16.93 27.77-21.52.96-2.29 2.71-4.8 5.87-6.91 7.54-5 16.32-7.61 25.41-7.61 7.04 0 13.82 1.62 19.71 4.61-.52-1.64-1.04-3.24-1.52-4.75-30.02-32.79-53.73-70.34-76.66-106.68-40.01-63.37-74.95-118.7-132.47-135.18-.44 3.54-.79 6.68-.84 8.21-.37 11.6-.16 20.66.67 27.77.11.73.81 3.55 1.22 5.24 1.18 4.88 1.9 7.8 1.48 10.7 14.31-7.74 32.63-8.17 47.03-.57 14.24 7.51 22.12 21.54 21.99 38.84 8.06-.16 15.62 1.48 22.24 4.96 18.52 9.78 31.85 37.24 21.07 64.57-3.58 9.07-10.22 17.66-20.05 22.82 1.77 3.36 2.48 7.01 3.02 9.67.15.7.26 1.36.41 1.95l.1.39.08.41c2.24 13.4-1.22 27.04-9.21 36.49l-.21.28c-4.12 4.88-9.11 8.71-14.58 11.48.36.42.7.88 1.02 1.35l.28.42.24.44c8.3 15.52 6.28 36.75-4.72 49.39l-.19.23c-9.72 11.42-25.35 17.58-40.85 16.2-5.63-.31-11.06-1.82-16.15-4.51-15.78-8.32-24.73-25.48-24-43.04-2.61.58-5.35.55-8.13-.16l-.23-.06c-3.42-.66-7.02-1.99-10.79-3.99a53 53 0 0 1-3.02-1.7 55 55 0 0 1-7.2-4.78c-4.65 7.74-8.13 15.94-5.73 25.95 1.04 4.35 5.89 7.56 6.03 11.34.15 4.88-7.06 12.41-8.17 17.92-1.99 9.81.21 17.97-3.8 28.92-10.72 28.97-52.01 40.35-1.83 65.18ZM597.37 808.86a431 431 0 0 1-27.3 2.16c9.16 8.09 14.99 19.15 15.84 30.41l.03.34c.52 6.58-.37 13.02-2.38 19.02.57.05 1.15.13 1.72.26l.52.1.49.15c16.38 5.09 29.7 20.6 32.05 36.83 27.6-6.16 54.17-13.85 70.13-22.8-3.1-.52-6.28-1.17-9.36-2-2.16 2.08-5.94 4.53-11.82 4.53l-.55-.02c-23.94-.6-46.17-14.56-56.68-35.57-5.53-11.06-7.22-22.85-5.16-34.32-2.48.32-5 .62-7.53.91"/><path d="M730.53 857.31c-.21-1.74-19.62-20.58-17.91-29.01 9.13.88 16.07 4.43 25.92 3.44 25.53-2.61 37.76-29.37 58.61-41.67-29.24-18.15-33-59.51-77.44-44.36 1.87-12.54 11.06-18.54 17.95-26.6s-15.2-10.41-19.61-10.93c-12.76-1.51-25.14-1.22-37.03 4.05l1.72-9.26c-10.1-.31-19.4.84-27.51 3.36-27.17 8.38-41.02 32.08-27.07 68.08l-7.1 1.75c-21.75 2.3-43.66 3.39-65.52 2.6 1.35 6.26 1.48 12.97-.15 19.71 13.53-.13 27.09-1.02 40.55-2.51 2.79-.31 5.56-.63 8.35-1.01 7.17-.92 14.32-2.03 21.42-3.29-23.84 33.52 5.3 72.3 41.34 73.21 7.9.19.37-9.73 4.22-9.31 3.47 4.12 17.32 7.33 30.75 8.34 14.87 1.12 29.24-.49 28.5-6.58ZM362.76 814.56c.88-1.05 1.7-2.12 2.47-3.21-.97 1.15-1.8 2.24-2.47 3.21M500.68 824.29l-.23-.39c-13.19-22.9-43.09-22.07-59.38-2.92-19.37 24.99 2.43 64.19 34.95 58.99 28.4-3.67 38.39-32.49 24.65-55.68ZM608.06 900.34c-1.48-12.73-12.16-25.07-24.86-29.01-3.78-.78-5.21 3.39-7.46 5.71-4.04 5.25-9.73 9.03-16.07 11.68-4.83 2.09-9.76 3.78-15.1 4.46-2.45.39-5.38.73-7.22 2.38-3.96 4.46-3.97 11.08-2.42 17.18.55 2.16 1.3 4.25 2.12 6.16 9.75 23.57 39.78 30.96 56.52 16.02 9.67-7.9 15.54-20.57 14.64-32.73l-.03-.49c-.03-.45-.06-.91-.13-1.36ZM471.03 893.02c-.75-1.1-2.22-1.51-3.57-1.93-9.02-2.56-18.33-3.34-25.36-9.67-4.51-3.68-7.12-7.49-10.72-11.5-1.82-1.96-3.91-3.88-6.68-3.91-6.99.6-13.82 6.55-18.54 11.94-11.03 13.48-9.84 29.83-2.5 42.09.29.49.6.96.91 1.43 15.55 23.37 50 18.89 62.64-2.42 4.12-6.93 5.92-15.63 4.02-25.74l-.19-.29Z"/><path d="M536.91 811.18c3.68-4.05 6.16-8.37 7.61-12.75 2.24-6.76 2.04-13.7.06-20.22-1.44-4.83-3.89-9.42-7.06-13.54-12.71-16.64-37.11-25.51-55.86-10.41-3.39 2.72-6.58 6.24-9.5 10.64-.15.21-.29.44-.44.67l-.24.41c-2.42 4.61-4.93 13.92-5.39 21.34-.21 3.76.08 7.04 1.2 8.97 2.47 2.9 7.15 2.29 10.64 3.13 6.73.96 11.76 4.17 17.32 7.59.02.02.03.02.05.03 2.72 1.74 5.37 3.75 7.64 6.11 7.98 9.05 9.2 15.16 19.95 8.9 5.87-3.29 10.49-6.97 14.01-10.87ZM560.07 816.4c-2.27-1.38-5.4-3.91-8.38-4.93-1.57-.55-3.1-.68-4.46-.03-.62.31-1.22.78-1.75 1.46-4.85 6.47-9.37 12.41-17.5 15.23-3.94 2.24-11.81 2.63-11.11 8.58.5 6.02 1.33 14.3-.28 20.81-3.94 13.22-10.54 12.85 5.04 21.28 26.03 14.87 56.1-8.19 53.86-36.15l-.03-.42c-.75-9.8-6.78-19.59-15.39-25.82ZM464.69 762.36c.21-.66.36-1.35.42-2.06l-.08-.41c-10.62-12.39-23.08-15.33-34.19-12.57-9 2.24-17.14 8.22-22.72 15.96-4.8 6.63-7.72 14.55-7.72 22.51 0 10.75 5.32 21.55 18.52 29.37 12 8.09 14.3-3.6 22.35-9.81 3.62-3.08 9.62-5.11 14.45-7.61.08-.03.15-.06.21-.1 3.28-1.44 2.95-4.91 2.64-8.03-.16-1.56-.29-3.11-.36-4.67-.19-4.17.1-8.3 1.69-12.34 1.02-3.84 3.73-6.84 4.78-10.25ZM423.58 830.22l-.15-.34c-1.18-1.87-3.89-2.24-5.81-3.18-10.19-3.55-14.55-12.62-22.2-19.74-5.63-6.33-21.31 8.82-24.38 14.11-8.94 12.94-7.64 31.43 2.89 42.91 4.77 4.85 11.11 10.88 18.26 11.32 1.39-.21 2.5-1.18 3.44-2.21 3.05-3.49 6.68-7.38 10.44-10.17 4.25-3.44 10.85-5.37 15.91-8.71 2.71-2.21 1.04-7.14.91-11.01-.99-4.56 1.15-8.87.68-12.99ZM493.77 939.21c1.07.37 2.09.71 3.05.94.92.13 2.12.19 3.52.15.13.02.26 0 .37 0 4.07.1 8.39-.57 12.47-1.7 4.2-.99 8.3-2.48 11.29-4.54.02-.02.03-.03.06-.05.15-.1.32-.18.47-.26 1.56-.91 2.61-2.12 3.16-3.52.1-.15.19-.31.28-.47v-.49c.28-1.28.16-2.68-.37-4.15-.02-.08-.05-.15-.06-.23-.65-3.57-1.93-7.28-2.9-10.9-.05-.18-.1-.36-.15-.53-.26-1.18-.5-2.35-.7-3.49-.39-1.93-.5-3.91-.42-5.92.02-.31.03-.63.06-.96.02-.21.05-.42.06-.63.08-.7.18-1.41.28-2.12.06-.41.15-.81.23-1.22.03-.1.05-.19.06-.31.29-1.31.68-2.6.86-3.73.02-.02.02-.05.02-.06.18-.91.26-1.8-.06-2.5l-.15-.29c-.06-.05-.15-.08-.19-.13l-.02-.02-.06-.06c-.84-.99-2.04-1.48-3.26-1.91-.08-.03-.18-.05-.24-.1-.11-.03-.23-.08-.34-.11-1.83-.76-3.8-1.4-5.66-2.19-1.15-.53-2.25-1.14-3.31-1.9-2.85-1.98-5.79-6.18-8.3-6.33-.06.02-.15.02-.19.03-.02 0-.05.02-.08.02-.39-.02-.8.02-1.22.15-.34.16-.73.32-1.15.52-.06.02-.13.03-.19.06-2.4.86-5.21 2.25-7.93 3.68-.08.03-.18.1-.28.15-2.58 1.27-5.16 2.63-7.23 3.93-.03.02-.08.05-.11.06-.05.03-.1.05-.15.08-.29.15-.6.29-.86.44-.21.16-.42.37-.58.55v.02c-.11.08-.24.16-.34.24-.11.18-.16.37-.26.55-.05.08-.11.15-.16.23 0 .03-.02.05-.02.1-.67 1.22-.91 2.69-.94 4.27-.02.32-.02.63-.02.94 0 .15.02.29.02.45 0 1.85.15 3.75.16 5.56-.02.45-.03.91-.1 1.33 0 .24.02.47.03.71-.02.13-.02.29-.03.42.03.83.02 1.61-.02 2.38-.02.15-.02.31-.02.47-.02.06-.02.13-.03.21-.32 3.92-1.41 7.56-2.77 11.22-.1.29-.21.58-.32.88-.39.99-.79 2.01-1.22 3.05-.15.34-.28.68-.42 1.02-.05.13-.1.29-.15.42-.11.28-.21.55-.29.81-.02.05-.03.11-.05.16 0 .02 0 .03-.02.05-.03.08-.06.16-.08.28-.58 1.77-.84 3.57.71 4.88.28.21.55.42.89.67.29.19.62.44.92.65.06.05.11.1.18.13.29.21.55.41.88.63 3.75 2.56 8.77 5.56 13.23 7.27.06.02.11.05.16.06M96.83 644.7c2.34 4.99 6 9.54 11.11 13.19 22.06 16.77 48.54 3.7 54.85-21.62l.11-.44c6.49-24.75-14.69-44.52-38.96-42.38-10.8 1.44-19.24 7.69-24.44 15.96v.02c-6.54 10.36-8 23.94-2.68 35.26v.02ZM151.61 775.68c12.03 1.12 24.68-3.62 32.36-12.6l.31-.36c8.4-9.67 9.72-26.18 3.42-37.94-2.08-3.1-5.89-1.2-9.02-1.14-6.36.88-12.86-.39-19.04-2.89-4.75-1.85-9.29-4.04-13.43-7.19-1.95-1.39-4.22-3.16-6.6-3.28-7.78.52-13.3 8.69-16.07 15.91-9.29 22.87 6.37 48.4 28.07 49.47ZM95.37 664.07c.06-.08.11-.18.18-.26l.08-.32c.08-.49.03-.97-.11-1.46V662c-.21-.76-.65-1.54-1.04-2.27-4.49-7.9-10.36-14.76-10.93-23.91-.58-5.6.19-10.01.44-15.23.08-2.58-.06-5.32-1.96-7.22-5.21-4.35-13.96-4.88-20.87-4.38-16.77 1.78-27.07 13.85-30.34 27.31-8.66 36.12 41.49 61.57 64.57 27.77Z"/><path d="m182.77 576.08-.45.13c-7.22 2.29-21.86 11.82-23.48 18.03-.28 3.68 3.37 6.44 5.19 9.39 4.01 5.25 5.29 10.87 6.8 17.01.7 3.07 1.15 6.28 1.12 9.47-.65 11.66-3.97 16.71 7.7 19.69 66.53 18.18 64.32-87.4 3.13-73.73ZM201.89 699.78l.26-.31c6.15-7.25 8.64-18.12 6.94-28.25-1.1-4.44-1.62-13.12-7.67-12.36-7.75 1.17-14.9 2.19-22.43-1.41-4.23-1.12-9.93-6.2-13.48-1.62-3.76 4.48-8.81 10.75-14.35 14.16-11.69 6.44-16.01 1.67-10.98 18.1 7.82 27.94 44.24 32.49 61.71 11.69M112.62 574.38c2.77 13.74 12.31 7.23 22.07 8.43 4.67.34 10.28 3.08 15.36 4.65 3.24 1.25 5.37-1.38 7.28-3.75 3.52-4.36 7.2-8.48 12.49-10.82 3.96-2.35 8.77-2.21 11.95-4.95l.21-.32c3.78-54.25-83.3-46.04-69.37 6.75ZM102 552.74c.26-5.01-7.54-7.04-14.95-7.51-4.69-.28-9.23.06-11.45.66-7.38 1.41-13.96 5.43-18.78 10.96h-.02c-4.96 5.68-8.11 12.94-8.38 20.58 0 6.58.26 15.05 4.9 20.22 1.1.79 2.53.88 3.86.83 4.49-.34 9.63-.55 14.13.08 5.25.52 11.13 3.68 16.9 4.82 3.36.32 5.55-4.22 8.11-6.97 1.18-1.88 2.84-3.2 4.53-4.41v-.02c1.74-1.28 3.5-2.47 4.77-4.07l.13-.34c.45-2.08-1.17-4.18-1.85-6.13-.88-1.78-1.46-3.55-1.87-5.34v-.02c-1.65-7.57.36-15.16-.02-23.35ZM94.75 679.73c-.18.16-.34.34-.52.5l-.34.31c-.05.05-.11.08-.16.13-3.11 2.68-6.62 4.51-10.36 6.23-.96.42-1.91.84-2.92 1.28-.32.15-.65.28-.97.42-.13.05-.26.13-.39.18-.26.13-.52.24-.76.37-.05.02-.08.05-.13.08-.02 0-.03 0-.05.02-.08.03-.16.06-.26.13-1.59.83-3 1.88-2.82 3.86.05.34.1.66.18 1.05.05.34.13.73.18 1.09.02.06.03.15.05.21.05.34.1.66.18 1.02.83 4.33 2.25 9.81 4.17 14.01.03.05.05.11.08.16.47.97.96 1.91 1.44 2.71.57.73 1.35 1.59 2.34 2.5.08.1.18.18.26.26.91.94 1.88 1.83 2.92 2.69 2.09 1.72 4.43 3.28 6.83 4.61 3.57 2.17 7.43 3.94 10.88 4.54.03.02.05.02.06.02.18.05.34.1.52.15 1.69.42 3.23.31 4.56-.28.18-.03.34-.08.5-.15l.26-.24s.05-.06.08-.08c1.05-.7 1.95-1.74 2.56-3.11.05-.08.08-.15.11-.21 2.08-3.05 3.78-6.67 5.68-9.96.62-.99 1.25-1.96 1.9-2.89 1.04-1.59 2.3-3.02 3.73-4.35l.68-.62c.16-.15.32-.26.49-.39.53-.44 1.07-.86 1.64-1.28.31-.24.65-.47.97-.68.1-.06.18-.11.26-.16 1.1-.71 2.24-1.35 3.13-1.99.02 0 .03-.03.05-.05.75-.49 1.41-1.05 1.66-1.75l.1-.31c-.02-.08-.03-.15-.05-.23v-.11c.1-1.25-.41-2.38-.94-3.52-.03-.08-.08-.16-.11-.24-.05-.1-.1-.19-.15-.31-.75-1.77-1.66-3.54-2.42-5.37-.42-1.14-.78-2.32-.99-3.55-.62-3.29.21-8.19-1.43-10.01-.05-.02-.1-.08-.15-.1-.02-.02-.05-.03-.06-.05-.26-.28-.57-.52-.96-.73-.32-.13-.71-.28-1.14-.42-.05-.03-.11-.06-.16-.1-2.25-1.02-5.14-2-7.98-2.84-.1-.05-.19-.06-.29-.1-2.64-.88-5.35-1.7-7.66-2.21-.03-.02-.08-.03-.13-.05-.05 0-.1-.02-.15-.02-.31-.11-.62-.23-.91-.31-.24-.02-.54-.03-.76 0h-.02c-.13-.02-.28-.05-.41-.06-.18.05-.36.15-.55.21-.08.02-.18.02-.26.03-.03.03-.05.03-.08.06-1.28.39-2.45 1.25-3.55 2.3-.23.21-.44.44-.65.63-.1.11-.19.23-.29.32-1.25 1.28-2.45 2.69-3.67 3.94-.32.32-.65.62-.97.86-.16.18-.32.34-.47.5-.1.1-.19.19-.31.28-.36.39-.73.78-1.1 1.12v.02Z"/><path d="M0 522.05c15.79 3.58 23.59 20.84 41.24 7.84 1.03 5.68-2.2 9.6-4.1 14.09-1.9 4.45 8.35 2.26 10.39 1.84 3.72-.75 7.26-1.78 10.49-3.44.04-.02.06-.04.08-.04 1.17-.59 2.3-1.27 3.4-2.04.69-.4 1.37-.75 2.1-1.07 3.09-1.48 6.37-2.59 9.76-3.28 1.46-.32 3.36-.63 5.54-.81 8.37-7.62 9.54-18.74-.89-30.93l12.66-7.72c-.08 4.77 1.23 9.87 2.16 14.52 1.17 5.84 2.37 11.83 4.39 17.45.3.83.67 2.37 1.39 2.97.36.28.26.26.79.04.83-.34 1.64-1.09 2.41-1.58 1.25-.83 2.53-1.7 3.82-2.49.4-.24.79-.49 1.19-.71.47-.26 3.54-1.39 3.54-2.06.24-.57-2.39-9.93-2.71-12.6-.18-1.74-.36-3.52-.49-5.36-.59-7.99-.51-16.64-.26-24.28.14-4.31 1.68-14.8 2.73-23.51 0-.04.02-.1.02-.14.34.06.69.12 1.01.2.02 0 .06 0 .08.02 108.5 19.53 144.29 157.95 230.57 250.77 4.87 14.98 10.01 30.81 8.9 33.38-1.88 4.27-8.07 10.13-11.46 13.61 1.48-25.13-26.85-33.94-45.29-21.73-3.94 2.63 3.13 4.73 1.09 5.82-6.55-1.54-34.47 14.6-29.82 19.59.71.75 16.68 2.95 18.72 7.52-4.81 2.73-9.44 3.42-13.93 7.28-11.73 10.01-8.63 26.87-14.76 39.83 20.64-1.52 36.57 16.7 53.33-5.74 3.34 6.55.87 12.55.22 18.72-.67 6.17 11.02-.32 13.36-1.58 6.81-3.7 12.82-8.09 16.9-14.68l2.3 4.95c22.1-14.47 27.45-36.65 2.57-52.44l12.59-14.17c1.78 6.29 19.59 39.58 23.41 40.07.87-3.98 11-11.77 11.12-13 .06-.79-6.61-11.24-7.99-14.37-2.93-6.75-5.62-14.41-7.92-21.98 7.7 6.11 15.79 11.85 24.34 17.12 5.09-7.38 12.07-13.5 20.08-17.41-20.03-12.37-38.19-27.64-54.14-45-5.34-5.82-10.53-11.99-15.63-18.52-1.11-1.39-2.18-2.85-3.28-4.31-5.42-6.91-10.57-14.03-15.59-21.27-16.56-23.88-31.23-48.98-46.17-73.91 2.89-4.08 8.98-8.79 12.49-11.73-4.23 26.65 24.2 39.81 44.66 29.19 4.39-2.28-2.75-5.46-.51-6.39 6.63 2.55 37.34-11.04 33.05-16.98-.65-.89-17-5.36-18.62-10.49 5.28-2.28 10.17-2.45 15.26-5.98 13.22-9.14 11.83-27.56 19.55-40.59-21.53-1.11-36.13-22.68-55.92-.91-2.79-7.46.44-13.52 1.78-20.03 1.35-6.51-11.48-1.11-14.05-.06-7.46 3.05-14.17 6.93-19.1 13.44l-1.86-5.62c-24.5 12.57-32.43 35.56-8.33 55.76l-13.32 12.27c-9.4-15.57-19.02-30.99-29.39-45.95-13.32-19.17-28.34-37.72-45.69-53.55-13.36-12.19-28.51-22.44-44.86-30.2-1.23-.59-2.47-1.15-3.7-1.7-8.75-3.9-17.79-6.55-26.87-9.54-12.05-3.98-24.26-4.91-31.19-14.45-3.66-4.59-5.88-10.61-5.88-17.2 0-12.64 5.8-19.12 11.85-22.48l3.82-52.77c-9.78 7.78-20.54 15.28-29.13 24.6-.02.02-.04.02-.04.02a75 75 0 0 0-5.84 7.1c-29.35 40.74-17.08 72.64.55 90.08 4.81 4.79 10.01 8.47 14.88 10.98.22 13.75 1.68 33.66.02 35.62-2.39 2.75-8.35 5.74-11.69 7.54 6.83-18.46-12.35-31.52-28.97-26.56-3.56 1.05 1.27 4.23-.51 4.61-4.57-2.67-29.15 3.05-26.81 7.86.34.73 11.83 6 12.31 9.89-4.23.95-7.86.44-12.11 2.3C9.03 500.4 7.5 513.72-.03 522.05Z"/><path d="M137.15 44.1c-.89 5.72 1.72 9.28 1.42 14.09-5.42 82-22.8 330.16-23.33 337.64-.65 9.02 5.26 17.22 14.03 19.41 31.03 7.72 59.58 23.01 83.76 45.08 16.36 14.94 31.9 33.18 47.61 55.74 1.78 2.61 3.56 5.18 5.3 7.78 2.79-13.59 13.26-25.84 29.17-34 1.86-.95 3.88-1.44 5.92-1.44.87 0 1.72.08 2.57.26 4.81-3.34 9.64-5.56 13.5-7.14l.16-.06c4.53-1.86 10.41-3.98 15.81-3.98 7.04 0 10.98 3.54 12.72 5.68 1.88 2.3 2.97 5.07 3.28 8.03 1.19-.14 2.43-.2 3.68-.2 8.39 0 15.87 3.13 22.46 5.9 5.46 2.28 10.61 4.45 15.65 4.71 6 .32 11.2 4.71 12.19 11.1.46 3.05-.36 6.13-1.88 8.81-1.98 3.5-3.28 8.13-4.67 13.02-2.47 8.77-5.44 19.37-13.79 27.45.63.59 1.23 1.27 1.8 2.06 3.42 4.73 3.8 10.78 1.05 16.17-4.45 8.67-19.47 16.27-31.36 19.71-1.17 2.24-3.23 4.73-6.77 6.57a46.4 46.4 0 0 1-21.23 5.16c-2.18 0-4.35-.16-6.45-.44 6.89 11.14 13.99 22.18 21.37 32.83 5.16 7.48 10.09 14.21 15.14 20.68.04.08.97 1.31.97 1.31.77.99 1.54 2.02 2.3 3.01 4.87 6.23 9.91 12.19 14.96 17.73 18.62 20.26 39.58 36.73 62.45 49.13 12.19-.47 23.94 4.53 33.56 14.45 5.82-5.96 12.57-10.23 19.95-12.47 19.57-5.9 47.17 3.15 60.18 27.7 6.27.32 12.68.49 19.17.49 13.38 0 27.09-.65 41.69-1.98-4.91-22.46.95-37.93 7.48-47.47 7.62-11.1 19.31-19 34-23.17-.08-2.83.16-5.76.79-8.81 5.72-27.56 84.14-75.29 103.83-107.73 23.21-38.23 18.01-102.05 15.65-145.68-3.13-58.37-9.36-118.31-18.03-176.07-3.54-23.61-10.43-77.17-18.56-96.96-3.86-9.3-9.68-14.64-18.9-18.19-28.3-11.14-87.32-1.25-107.86-20.86-29.56-28.22 16.09-74.7-31.84-96.9C524.6-2.5 376.41-1.13 314.69 1.16c-35.2 1.29-142.73 5.64-167.31 26.79-4.89 4.23-9.22 9.44-10.23 16.15m496.03 159.75c14.41-1.58 32.37 4.81 40.7 17.04 9.72 14.41 16.5 78.48 18.66 99.08 4.08 39.18 7.64 84.95 8.81 124.23 1.27 43.16 3.62 77.73-32.77 106.93-44.86 36.09-36.85-26.89-39.3-54.5-5.56-62.47-10.23-125.08-15.28-187.55-2-24.93-8.35-54.16-8.47-78.78-.08-14.19 14.56-25.07 27.66-26.44Zm-459.4 40.63c1.27-2.55-.08-5.8 2.35-9.4 2.45-1.9 4.93-3.8 7.4-5.68 35.8-27.33 72.13-55.62 73.57-58.71 2.71-5.92-1.05-16.86 7.18-25.39 8.23-8.51 19.81-10.71 24.12-17.26 4.27-6.53 12.51-25.74 17.91-26.89 4.83-.97 14.6 13.52 21.65 21.87q1.305 1.515 2.43 2.73c6.73 6.99 13.06-8.65 15.02-19.95.12-.61.22-1.19.3-1.78 1.58-11.3 13.61-30.2 14.17-37.76.53-7.58 2.69-16.56 8.71-15.36 6 1.19 16.42 25.55 22.97 29.84 6.55 4.27 6.19 8.81 15.57 5.7 9.36-3.13 10.49-8.39 12.68-6.71 2.14 1.7 50.97 42.56 57.21 50.62 6.27 8.05 15.67 25.49 20.56 31.19 4.91 5.68 10.17 6.81 11.89 14.58.93 4.21 5.26 8.67 10.53 12.8 4.08 3.28 8.75 6.35 12.88 8.94 8.11 10.96 23.45 20.01 23.45 27.15 0 5.58 7.64 108 11.69 161.25.2 2.79-3.82 3.38-4.43.67-8.05-35.56-21.03-90.06-26.79-97.99-8.69-11.93-70.43-53.11-75.85-58.53-5.42-5.4 2.14 5.42 0 13.04-2.18 7.58-9.74 14.09-5.42 20.58 4.33 6.47 18.42 11.91 11.91 21.65-6.49 9.76-21.65 23.84-28.16 30.37-6.51 6.49-15.16 11.91-20.58 20.56-5.42 8.67-13.02 10.84-23.84 14.09-10.84 3.26-33.6 3.26-43.36 3.26s-65.02 40.09-75.85 50.93c-10.82 10.84-13 15.18-14.07 34.67-1.09 19.51-19.51-10.82-18.42-21.65 1.05-10.86-5.44-20.6 1.05-30.35 6.55-9.74 8.69-17.33 14.11-23.84s-36.85 0-43.36 6.51c-6.47 6.49-28.16 35.76-35.76 35.76-6.09 0-12.94-4.97-15.36-6.87-.55-.46-.87-1.15-.81-1.88.81-13.71 8.69-148.59 10.78-152.74Z"/></g></svg>';

// Mobile nav toggle
document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.querySelector('.nav-toggle');
  var navList = document.querySelector('.nav-list');

  if (toggle && navList) {
    toggle.addEventListener('click', function () {
      navList.classList.toggle('open');
    });

    // Auto-close mobile nav when a link is tapped
    var navLinks = navList.querySelectorAll('a');
    navLinks.forEach(function (link) {
      link.addEventListener('click', function () {
        navList.classList.remove('open');
      });
    });
  }

  // Dismiss open tasting-notes tooltips when tapping outside
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.product-notes-btn')) return;
    var openTips = document.querySelectorAll('.product-notes-tooltip.show');
    openTips.forEach(function (tip) { tip.classList.remove('show'); });
  });

  // Content loader — fetches shared.json + page-specific JSON, merges, and applies
  var page = document.body.getAttribute('data-page');
  if (page) {
    var sharedFetch = fetch('content/shared.json')
      .then(function (res) { return res.ok ? res.json() : {}; })
      .catch(function () { return {}; });
    var pageFetch = fetch('content/' + page + '.json')
      .then(function (res) { return res.ok ? res.json() : {}; })
      .catch(function () { return {}; });

    Promise.all([sharedFetch, pageFetch])
      .then(function (results) {
        var shared = results[0];
        var pageData = results[1];
        // Page-specific values override shared
        var data = {};
        var key;
        for (key in shared) { if (shared.hasOwnProperty(key)) data[key] = shared[key]; }
        for (key in pageData) { if (pageData.hasOwnProperty(key)) data[key] = pageData[key]; }

        var els = document.querySelectorAll('[data-content]');
        els.forEach(function (el) {
          var k = el.getAttribute('data-content');
          if (data[k] !== undefined) {
            el.textContent = data[k];
          }
        });
      })
      .catch(function () {
        // Silently fail — fallback text already in HTML
      });
  }

  // Expose header height as CSS variable for sticky offsets
  var siteHeader = document.querySelector('.site-header');
  if (siteHeader) {
    var setHeaderHeight = function () {
      document.documentElement.style.setProperty('--header-height', siteHeader.offsetHeight + 'px');
    };
    setHeaderHeight();
    window.addEventListener('resize', setHeaderHeight);
  }

  // Product catalog loader
  if (page === 'products') {
    loadProducts();
    initReservationBar();
    initProductTabs();
  }

  // Reservation page
  if (page === 'reservation') {
    initReservationPage();
  }

  // Open hours on about & contact pages
  if (page === 'about' || page === 'contact') {
    loadOpenHours();
  }

  // FAQ on about page
  if (page === 'about') {
    loadFAQ();
  }

  // Featured products on homepage
  if (page === 'home') {
    loadFeaturedProducts();
    initReservationBar();
    setupBeerWaitlistForm();
  }

  // Footer hours on all public pages
  loadFooterHours();

  // Social links on all pages
  loadSocialLinks();
});

function loadOpenHours() {
  var container = document.getElementById('open-hours');
  if (!container) return;

  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var remoteUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL
    : null;
  var localUrl = 'content/timeslots.csv';

  function parseAndRender(csv) {
    var lines = csv.trim().split('\n');
    if (lines.length < 2) return false;

    var headers = lines[0].split(',');
    var slots = [];
    for (var i = 1; i < lines.length; i++) {
      var values = lines[i].split(',');
      if (values.length < 3) continue;
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j].trim()] = values[j].trim();
      }
      slots.push(obj);
    }

    // Consider all slots (regardless of status) to show full default hours
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    slots = slots.filter(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      return d >= today;
    });

    if (slots.length === 0) return false;

    // Group by day-of-week, track earliest start and latest end
    var dayMap = {};
    slots.forEach(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      var dow = d.getDay();
      var timeParts = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!timeParts) return;
      var h = parseInt(timeParts[1], 10);
      var m = parseInt(timeParts[2], 10);
      var ampm = timeParts[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      var mins = h * 60 + m;

      if (!dayMap[dow]) dayMap[dow] = { min: mins, max: mins };
      if (mins < dayMap[dow].min) dayMap[dow].min = mins;
      if (mins > dayMap[dow].max) dayMap[dow].max = mins;
    });

    // Convert minutes back to time string
    function minsToStr(mins) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      var ampm = h >= 12 ? 'PM' : 'AM';
      var hr12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      var mm = m < 10 ? '0' + m : '' + m;
      return hr12 + ':' + mm + ' ' + ampm;
    }

    // Build the hours list for each day Sun–Sat
    var html = '<h2>Open Hours</h2><ul class="open-hours-list">';
    for (var dow = 0; dow < 7; dow++) {
      var info = dayMap[dow];
      html += '<li class="open-hours-row' + (info ? '' : ' closed') + '">';
      html += '<span class="open-hours-day">' + DAY_NAMES[dow] + '</span>';
      if (info) {
        // The last slot starts at max, so end time is +30 min
        html += '<span class="open-hours-time">' + minsToStr(info.min) + ' &ndash; ' + minsToStr(info.max + 30) + '</span>';
      } else {
        html += '<span class="open-hours-time">Closed</span>';
      }
      html += '</li>';
    }
    html += '</ul>';
    container.innerHTML = html;
    return true;
  }

  function fetchAndRender(url) {
    return fetch(url)
      .then(function (res) { return res.text(); })
      .then(function (csv) { return parseAndRender(csv); });
  }

  // Try remote first, fall back to local CSV
  var attempt = remoteUrl ? fetchAndRender(remoteUrl) : Promise.resolve(false);
  attempt
    .then(function (success) {
      if (!success) return fetchAndRender(localUrl);
    })
    .catch(function () {
      return fetchAndRender(localUrl).catch(function () {});
    });
}

function loadFAQ() {
  var container = document.getElementById('faq-list');
  if (!container) return;

  var remoteUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL
    : null;

  if (!remoteUrl) return;

  fetch(remoteUrl)
    .then(function (res) { return res.text(); })
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      if (lines.length < 2) return;

      var faqs = [];
      for (var i = 1; i < lines.length; i++) {
        var row = lines[i].match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        row = row.map(function (cell) {
          return cell.replace(/^"|"$/g, '').replace(/""/g, '"').trim();
        });
        var type = (row[0] || '').toLowerCase();
        if (type === 'faq') {
          faqs.push({
            question: row[2] || '',
            answer: row[3] || ''
          });
        }
      }

      if (faqs.length === 0) return;

      var html = '';
      faqs.forEach(function (faq) {
        html += '<div class="faq-item">';
        html += '<button type="button" class="faq-question">' + escapeHTML(faq.question) + '</button>';
        html += '<div class="faq-answer"><p>' + escapeHTML(faq.answer) + '</p></div>';
        html += '</div>';
      });
      container.innerHTML = html;

      // Toggle FAQ answers
      container.querySelectorAll('.faq-question').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var item = this.parentElement;
          item.classList.toggle('open');
        });
      });
    })
    .catch(function (err) {
      console.error('[FAQ] Error loading:', err);
    });
}

function loadFooterHours() {
  var container = document.getElementById('footer-hours');
  if (!container) return;

  var DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var remoteUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL
    : null;
  var localUrl = 'content/timeslots.csv';

  function parseAndRender(csv) {
    var lines = csv.trim().split('\n');
    if (lines.length < 2) return false;

    var headers = lines[0].split(',');
    var slots = [];
    for (var i = 1; i < lines.length; i++) {
      var values = lines[i].split(',');
      if (values.length < 3) continue;
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j].trim()] = values[j].trim();
      }
      slots.push(obj);
    }

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    slots = slots.filter(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      return d >= today;
    });

    if (slots.length === 0) return false;

    // Group by day-of-week, track earliest start and latest end
    var dayMap = {};
    slots.forEach(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      var dow = d.getDay();
      var timeParts = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!timeParts) return;
      var h = parseInt(timeParts[1], 10);
      var m = parseInt(timeParts[2], 10);
      var ampm = timeParts[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      var mins = h * 60 + m;

      if (!dayMap[dow]) dayMap[dow] = { min: mins, max: mins };
      if (mins < dayMap[dow].min) dayMap[dow].min = mins;
      if (mins > dayMap[dow].max) dayMap[dow].max = mins;
    });

    function minsToStr(mins) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      var ampm = h >= 12 ? 'PM' : 'AM';
      var hr12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      return hr12 + (m > 0 ? ':' + (m < 10 ? '0' + m : m) : '') + ampm;
    }

    // Build compact hours display
    var html = '';
    for (var dow = 0; dow < 7; dow++) {
      var info = dayMap[dow];
      html += '<span class="footer-hours-day' + (info ? '' : ' closed') + '">';
      html += '<span class="footer-hours-abbr">' + DAY_ABBR[dow] + '</span> ';
      if (info) {
        html += minsToStr(info.min) + '–' + minsToStr(info.max + 30);
      } else {
        html += 'Closed';
      }
      html += '</span>';
    }
    container.innerHTML = html;
    return true;
  }

  function fetchAndRender(url) {
    return fetch(url)
      .then(function (res) { return res.text(); })
      .then(function (csv) { return parseAndRender(csv); });
  }

  var attempt = remoteUrl ? fetchAndRender(remoteUrl) : Promise.resolve(false);
  attempt
    .then(function (success) {
      if (!success) return fetchAndRender(localUrl);
    })
    .catch(function () {
      return fetchAndRender(localUrl).catch(function () {});
    });
}

// ===== Social Links =====

function loadSocialLinks() {
  var container = document.querySelector('.footer-social');
  if (!container) return;

  var homepageCsvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL
    : null;

  if (!homepageCsvUrl) return; // Keep hardcoded links if no sheet configured

  fetch(homepageCsvUrl)
    .then(function (res) { return res.ok ? res.text() : ''; })
    .then(function (csv) {
      if (!csv.trim()) return;

      var lines = csv.trim().split('\n');
      var socialLinks = {};

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        var type = (values[0] || '').toLowerCase().trim();
        if (type === 'social') {
          var platform = (values[2] || '').toLowerCase().trim(); // Title column = platform name
          var url = (values[4] || '').trim(); // SKU column = URL
          if (platform && url) {
            socialLinks[platform] = url;
          }
        }
      }

      // Update existing links if we found any
      if (Object.keys(socialLinks).length > 0) {
        var igLink = container.querySelector('a[aria-label*="Instagram"]');
        var fbLink = container.querySelector('a[aria-label*="Facebook"]');

        if (igLink && socialLinks.instagram) {
          igLink.href = socialLinks.instagram;
        }
        if (fbLink && socialLinks.facebook) {
          fbLink.href = socialLinks.facebook;
        }
      }
    })
    .catch(function () {
      // Keep hardcoded links on error
    });

  function parseCSVLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    result.push(current);
    return result;
  }
}

// ===== Homepage Promo Section =====

// ===== Label Card Shared Helpers =====

function getTintClass(product) {
  if (product.tint) return 'tint-' + product.tint.toLowerCase().replace(/\s+/g, '');
  if (!product.subcategory) return '';
  var sub = product.subcategory.toLowerCase().replace(/[^a-z]/g, '');
  var map = { red:'tint-red', white:'tint-white', rose:'tint-rose', ros:'tint-rose',
    fruit:'tint-fruit', specialty:'tint-specialty', pilsner:'tint-pilsner',
    amber:'tint-amber', wheat:'tint-wheat', ipa:'tint-ipa', pale:'tint-pale',
    session:'tint-session', saison:'tint-saison', lager:'tint-lager',
    stout:'tint-stout', porter:'tint-porter', redale:'tint-redale', brown:'tint-brown' };
  return map[sub] || '';
}

function buildLabelNotesToggle(product) {
  var wrap = document.createElement('div');
  wrap.className = 'notes-wrap';

  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'notes-toggle';
  toggle.innerHTML = 'Tasting Notes <span class="chevron">&#9660;</span>';

  var body = document.createElement('div');
  body.className = 'notes-body';

  if (product.sku) {
    var imageCol = document.createElement('div');
    imageCol.className = 'notes-image';
    var img = document.createElement('img');
    img.src = 'images/products/' + product.sku + '.png';
    img.alt = product.name || 'Product image';
    img.loading = 'lazy';
    img.onerror = function() { this.parentElement.remove(); };
    imageCol.appendChild(img);
    body.appendChild(imageCol);
  }

  if (product.tasting_notes) {
    var textCol = document.createElement('div');
    textCol.className = 'notes-text';
    var p = document.createElement('p');
    p.textContent = product.tasting_notes;
    textCol.appendChild(p);
    body.appendChild(textCol);
  }

  toggle.addEventListener('click', function (w, t, prod) {
    return function () {
      var isOpen = w.classList.toggle('open');
      if (isOpen) {
        trackEvent('detail', prod.sku || '', prod.name || '');
      }
    };
  }(wrap, toggle, product));

  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

function buildLabelPriceFooter(product) {
  var discount = parseFloat(product.discount) || 0;
  var pricingFrom = (product.pricing_from || '').trim().toUpperCase() === 'TRUE';
  var plusSign = pricingFrom ? '+' : '';
  var instore = (product.retail_instore || '').trim();
  var kit = (product.retail_kit || '').trim();

  var footer = document.createElement('div');
  footer.className = 'price-footer';

  if (instore) {
    var col1 = document.createElement('div');
    col1.className = 'price-col';
    var lbl1 = document.createElement('div');
    lbl1.className = 'price-label';
    lbl1.textContent = 'Ferment in store';
    col1.appendChild(lbl1);
    var val1 = document.createElement('div');
    val1.className = 'price-value';
    if (discount > 0) {
      var num1 = parseFloat(instore.replace(/[^0-9.]/g, ''));
      var sale1 = (num1 * (1 - discount / 100)).toFixed(2);
      val1.innerHTML = '<s style="color:#999;font-size:0.8rem;">' + instore + '</s> $' + sale1 + plusSign;
    } else {
      val1.textContent = instore + plusSign;
    }
    col1.appendChild(val1);
    footer.appendChild(col1);
  }

  if (kit) {
    var col2 = document.createElement('div');
    col2.className = 'price-col';
    var lbl2 = document.createElement('div');
    lbl2.className = 'price-label';
    lbl2.textContent = 'Kit only';
    col2.appendChild(lbl2);
    var val2 = document.createElement('div');
    val2.className = 'price-value';
    if (discount > 0) {
      var num2 = parseFloat(kit.replace(/[^0-9.]/g, ''));
      var sale2 = (num2 * (1 - discount / 100)).toFixed(2);
      val2.innerHTML = '<s style="color:#999;font-size:0.8rem;">' + kit + '</s> $' + sale2 + plusSign;
    } else {
      val2.textContent = kit + plusSign;
    }
    col2.appendChild(val2);
    footer.appendChild(col2);
  }

  return footer;
}

function loadFeaturedProducts() {
  var promoSection = document.getElementById('promo-section');
  var newsContainer = document.getElementById('promo-news-content');
  var noteContainer = document.getElementById('promo-featured-note');
  var productsContainer = document.getElementById('promo-featured-products');
  if (!promoSection) return;

  // Show loading skeleton immediately (mimics card layout)
  if (productsContainer) {
    var skeletonWrap = document.createElement('div');
    skeletonWrap.className = 'promo-loading-skeleton';
    skeletonWrap.appendChild(createSkeletonCard());
    productsContainer.innerHTML = '';
    productsContainer.appendChild(skeletonWrap);
  }

  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_CSV_URL
    : null;
  var localCsvUrl = 'content/products.csv';

  // Load homepage config from Google Sheets (published CSV)
  var homepageCsvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL
    : null;

  // LocalStorage caching for faster subsequent loads (1 hour TTL)
  var PRODUCTS_CACHE_KEY = 'sv-products-csv';
  var PRODUCTS_CACHE_TS_KEY = 'sv-products-csv-ts';
  var HOMEPAGE_CACHE_KEY = 'sv-homepage-csv';
  var HOMEPAGE_CACHE_TS_KEY = 'sv-homepage-csv-ts';
  var CACHE_TTL = 60 * 60 * 1000; // 1 hour

  function getCache(key, tsKey) {
    try {
      var data = localStorage.getItem(key);
      var ts = parseInt(localStorage.getItem(tsKey), 10) || 0;
      if (data) return { data: data, fresh: (Date.now() - ts) < CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCache(key, tsKey, data) {
    try {
      localStorage.setItem(key, data);
      localStorage.setItem(tsKey, String(Date.now()));
    } catch (e) {}
  }

  // Get cached data or fetch fresh
  var productsCached = getCache(PRODUCTS_CACHE_KEY, PRODUCTS_CACHE_TS_KEY);
  var homepageCached = getCache(HOMEPAGE_CACHE_KEY, HOMEPAGE_CACHE_TS_KEY);

  // Fetch both CSVs in parallel for faster loading, using cache when available
  var configPromise;
  if (homepageCached) {
    configPromise = Promise.resolve(homepageCached.data);
    if (!homepageCached.fresh && homepageCsvUrl) {
      fetch(homepageCsvUrl).then(function (res) { return res.ok ? res.text() : ''; })
        .then(function (csv) { if (csv) setCache(HOMEPAGE_CACHE_KEY, HOMEPAGE_CACHE_TS_KEY, csv); });
    }
  } else {
    configPromise = homepageCsvUrl
      ? fetch(homepageCsvUrl).then(function (res) { return res.ok ? res.text() : ''; })
          .then(function (csv) { if (csv) setCache(HOMEPAGE_CACHE_KEY, HOMEPAGE_CACHE_TS_KEY, csv); return csv; })
      : fetch('content/home.json').then(function (res) { return res.ok ? res.json() : {}; }).then(function (j) { return { isJson: true, data: j }; });
  }

  var productsPromise;
  if (productsCached) {
    productsPromise = Promise.resolve(productsCached.data);
    if (!productsCached.fresh) {
      var refreshUrl = csvUrl || localCsvUrl;
      fetch(refreshUrl).then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (csv) { if (csv) setCache(PRODUCTS_CACHE_KEY, PRODUCTS_CACHE_TS_KEY, csv); });
    }
  } else {
    productsPromise = csvUrl
      ? fetch(csvUrl).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return fetch(localCsvUrl).then(function (r) { return r.text(); }); })
      : fetch(localCsvUrl).then(function (r) { return r.text(); });
    productsPromise.then(function (csv) { if (csv) setCache(PRODUCTS_CACHE_KEY, PRODUCTS_CACHE_TS_KEY, csv); });
  }

  Promise.all([configPromise, productsPromise])
    .then(function (results) {
      var result = results[0];
      var productsCsv = results[1];
      var config = { 'promo-news': [], 'promo-featured-note': '', 'promo-featured-skus': [] };

      if (result && result.isJson) {
        // Fallback JSON format
        config = result.data;
      } else if (typeof result === 'string' && result.trim()) {
        // Parse CSV from Google Sheets
        var lines = result.trim().split('\n');
        if (lines.length > 1) {
          for (var i = 1; i < lines.length; i++) {
            var values = parseHomepageCSVLine(lines[i]);
            var type = (values[0] || '').toLowerCase().trim();
            if (type === 'news') {
              config['promo-news'].push({
                date: (values[1] || '').trim(),
                title: (values[2] || '').trim(),
                text: (values[3] || '').trim()
              });
            } else if (type === 'note') {
              config['promo-featured-note'] = (values[3] || '').trim();
            } else if (type === 'featured') {
              var sku = (values[4] || '').trim();
              if (sku) config['promo-featured-skus'].push(sku);
            }
          }
        }
      }

      // Render news items
      if (newsContainer && config['promo-news'] && config['promo-news'].length > 0) {
        renderNews(config['promo-news']);
      }

      // Render featured note
      if (noteContainer && config['promo-featured-note']) {
        noteContainer.innerHTML = '<p>' + escapeHTMLPromo(config['promo-featured-note']) + '</p>';
      }

      // Parse and render products
      var featuredSkus = config['promo-featured-skus'] || [];
      var products = productsCsv ? parseCSV(productsCsv) : [];
      renderFeaturedProducts(products, featuredSkus);
    })
    .catch(function () {
      // Fallback: hide promo section on error
      promoSection.style.display = 'none';
    });

  function parseHomepageCSVLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    result.push(current);
    return result;
  }

  function escapeHTMLPromo(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderNews(newsItems) {
    var html = '';
    newsItems.forEach(function (item) {
      html += '<div class="promo-news-item">';
      html += '<span class="promo-news-date">' + escapeHTMLPromo(item.date || '') + '</span>';
      html += '<h3>' + escapeHTMLPromo(item.title || '') + '</h3>';
      html += '<p>' + escapeHTMLPromo(item.text || '') + '</p>';
      html += '</div>';
    });
    newsContainer.innerHTML = html;
  }

  function parseCSV(csv) {
    var lines = csv.trim().split('\n');
    if (lines.length < 2) return [];
    var headers = lines[0].split(',').map(function (h) { return h.trim().toLowerCase().replace(/\s+/g, '_'); });
    var products = [];
    for (var i = 1; i < lines.length; i++) {
      var values = parseCSVLine(lines[i]);
      if (values.length < 2) continue;
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = (values[j] || '').trim();
      }
      products.push(obj);
    }
    return products;
  }

  function parseCSVLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    result.push(current);
    return result;
  }

  function renderFeaturedProducts(products, featuredSkus) {
    var featured = [];

    // First priority: products matching SKUs from config
    if (featuredSkus && featuredSkus.length > 0) {
      featuredSkus.forEach(function (sku) {
        var match = products.find(function (p) { return p.sku === sku; });
        if (match) featured.push(match);
      });
    }

    // Fallback: products with featured/favorite = TRUE
    if (featured.length === 0) {
      featured = products.filter(function (p) {
        return (p.featured || '').trim().toUpperCase() === 'TRUE' ||
               (p.favorite || '').trim().toUpperCase() === 'TRUE';
      });
    }

    // Fallback: products with discounts
    if (featured.length === 0) {
      featured = products.filter(function (p) {
        return parseFloat(p.discount) > 0;
      }).slice(0, 3);
    }

    // Final fallback: first 3 products
    if (featured.length === 0) {
      featured = products.slice(0, 3);
    }

    if (featured.length === 0) {
      promoSection.style.display = 'none';
      return;
    }

    productsContainer.innerHTML = '';
    var carouselIndex = 0;
    var isAnimating = false;

    featured.forEach(function (product, idx) {
      var card = createProductCard(product);
      card.dataset.carouselIndex = idx;
      // First card starts active
      if (idx === 0) {
        card.classList.add('promo-slide-active');
      }
      productsContainer.appendChild(card);
    });

    // Set up carousel if multiple products
    if (featured.length > 1) {
      var nav = document.getElementById('promo-carousel-nav');
      var dotsContainer = document.getElementById('promo-carousel-dots');
      if (nav) nav.style.display = 'flex';

      if (dotsContainer) {
        dotsContainer.innerHTML = '';
        for (var i = 0; i < featured.length; i++) {
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'promo-carousel-dot' + (i === 0 ? ' active' : '');
          dot.dataset.index = i;
          dot.setAttribute('aria-label', 'Go to product ' + (i + 1));
          dotsContainer.appendChild(dot);
        }
      }

      function showSlide(newIndex) {
        if (isAnimating || newIndex === carouselIndex) return;
        isAnimating = true;

        var cards = productsContainer.querySelectorAll('.product-card, .label-wine, .label-beer');
        var dots = dotsContainer ? dotsContainer.querySelectorAll('.promo-carousel-dot') : [];
        var currentCard = cards[carouselIndex];
        var nextCard = cards[newIndex];

        // Slide current card out
        currentCard.classList.remove('promo-slide-active');
        currentCard.classList.add('promo-slide-exit');

        // Slide next card in
        nextCard.classList.add('promo-slide-active');

        // Update dots
        dots.forEach(function (d, i) {
          d.classList.toggle('active', i === newIndex);
        });

        // Clean up after animation
        setTimeout(function () {
          currentCard.classList.remove('promo-slide-exit');
          carouselIndex = newIndex;
          isAnimating = false;
        }, 500);
      }

      var prevBtn = document.querySelector('.promo-carousel-prev');
      var nextBtn = document.querySelector('.promo-carousel-next');
      if (prevBtn) {
        prevBtn.addEventListener('click', function () {
          showSlide((carouselIndex - 1 + featured.length) % featured.length);
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', function () {
          showSlide((carouselIndex + 1) % featured.length);
        });
      }

      if (dotsContainer) {
        dotsContainer.addEventListener('click', function (e) {
          if (e.target.classList.contains('promo-carousel-dot')) {
            showSlide(parseInt(e.target.dataset.index, 10));
          }
        });
      }

      // Auto-rotate every 12 seconds, pause if More Information is open
      setInterval(function () {
        var hasOpenNotes = productsContainer.querySelector('.product-notes.open, .notes-wrap.open');
        if (!hasOpenNotes) {
          showSlide((carouselIndex + 1) % featured.length);
        }
      }, 12000);
    }
  }

  function createProductCard(product) {
    var productType = (product.type || '').toLowerCase();
    var card;
    if (productType.indexOf('wine') !== -1) {
      card = buildFeaturedWineCard(product);
    } else if (productType.indexOf('beer') !== -1) {
      card = buildFeaturedBeerCard(product);
    } else {
      card = buildFeaturedDefaultCard(product);
    }
    return card;
  }

  function buildFeaturedWineCard(product) {
    var tint = getTintClass(product);
    var card = document.createElement('div');
    card.className = 'label-wine' + (tint ? ' ' + tint : '');
    if (product.sku) card.setAttribute('data-sku', product.sku);

    var discount = parseFloat(product.discount) || 0;
    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var body = document.createElement('div');
    body.className = 'label-body';

    var brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = product.brand || '';
    body.appendChild(brand);

    var ornament = document.createElement('div');
    ornament.className = 'ornament';
    body.appendChild(ornament);

    var wineName = document.createElement('div');
    wineName.className = 'wine-name';
    wineName.textContent = product.name || '';
    body.appendChild(wineName);

    if (product.subcategory) {
      var sub = document.createElement('div');
      sub.className = 'subcategory';
      sub.textContent = product.subcategory;
      body.appendChild(sub);
    }

    if (product.time) {
      var time = document.createElement('div');
      time.className = 'time';
      time.textContent = product.time;
      body.appendChild(time);
    }

    if (product.abv) {
      var abv = document.createElement('div');
      abv.className = 'abv';
      abv.textContent = product.abv + (product.abv.toLowerCase().indexOf('abv') === -1 ? ' ABV' : '');
      body.appendChild(abv);
    }

    if (product.tasting_notes || product.sku) {
      body.appendChild(buildLabelNotesToggle(product));
    }

    var spacer = document.createElement('div');
    spacer.className = 'notes-spacer';
    body.appendChild(spacer);

    card.appendChild(body);

    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      card.appendChild(buildLabelPriceFooter(product));
    }

    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'reserve-link';
    var productKey = product.name + '|' + product.brand;
    renderFeaturedReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    return card;
  }

  function buildFeaturedBeerCard(product) {
    var tint = getTintClass(product);
    var card = document.createElement('div');
    card.className = 'label-beer' + (tint ? ' ' + tint : '');
    if (product.sku) card.setAttribute('data-sku', product.sku);

    var discount = parseFloat(product.discount) || 0;
    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var body = document.createElement('div');
    body.className = 'label-body';

    var logo = document.createElement('div');
    logo.className = 'sv-logo';
    logo.innerHTML = SV_LOGO_SVG;
    body.appendChild(logo);

    var brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = product.brand || '';
    body.appendChild(brand);

    var goldRule = document.createElement('div');
    goldRule.className = 'gold-rule';
    body.appendChild(goldRule);

    var beerName = document.createElement('div');
    beerName.className = 'beer-name';
    beerName.textContent = product.name || '';
    body.appendChild(beerName);

    if (product.subcategory) {
      var sub = document.createElement('div');
      sub.className = 'subcategory';
      sub.textContent = product.subcategory;
      body.appendChild(sub);
    }

    if (product.time) {
      var time = document.createElement('div');
      time.className = 'time';
      time.textContent = product.time;
      body.appendChild(time);
    }

    if (product.abv) {
      var abv = document.createElement('div');
      abv.className = 'abv';
      abv.textContent = product.abv + (product.abv.toLowerCase().indexOf('abv') === -1 ? ' ABV' : '');
      body.appendChild(abv);
    }

    if (product.tasting_notes || product.sku) {
      body.appendChild(buildLabelNotesToggle(product));
    }

    var spacer = document.createElement('div');
    spacer.className = 'notes-spacer';
    body.appendChild(spacer);

    card.appendChild(body);

    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      card.appendChild(buildLabelPriceFooter(product));
    }

    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'reserve-link';
    var productKey = product.name + '|' + product.brand;
    renderFeaturedReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    return card;
  }

  function buildFeaturedDefaultCard(product) {
    var card = document.createElement('div');
    card.className = 'product-card';
    if (product.sku) {
      card.setAttribute('data-sku', product.sku);
    }

    var header = document.createElement('div');
    header.className = 'product-card-header';

    var cardBrand = document.createElement('p');
    cardBrand.className = 'product-brand';
    cardBrand.textContent = product.brand || '';
    header.appendChild(cardBrand);

    var cardName = document.createElement('h4');
    cardName.textContent = product.name || '';
    header.appendChild(cardName);
    card.appendChild(header);

    var batchSize = (product.batch_size_liters || '').trim();
    if (product.subcategory || product.time || batchSize) {
      var detailRow = document.createElement('div');
      detailRow.className = 'product-detail-row';
      var details = [];
      if (product.subcategory) details.push(product.subcategory);
      if (product.time) details.push(product.time);
      if (batchSize) details.push(batchSize + 'L');
      for (var d = 0; d < details.length; d++) {
        if (d > 0) {
          var sep = document.createElement('span');
          sep.className = 'detail-sep';
          sep.textContent = '\u00b7';
          detailRow.appendChild(sep);
        }
        var detailSpan = document.createElement('span');
        detailSpan.textContent = details[d];
        detailRow.appendChild(detailSpan);
      }
      card.appendChild(detailRow);
    }

    if (product.tasting_notes) {
      var notesWrap = document.createElement('div');
      notesWrap.className = 'product-notes';

      var notesToggle = document.createElement('button');
      notesToggle.type = 'button';
      notesToggle.className = 'product-notes-toggle';
      notesToggle.setAttribute('aria-expanded', 'false');
      notesToggle.innerHTML = 'More Information <span class="product-notes-chevron">&#9660;</span>';

      var notesBody = document.createElement('div');
      notesBody.className = 'product-notes-body';

      if (product.sku) {
        var imageCol = document.createElement('div');
        imageCol.className = 'product-notes-image';
        var img = document.createElement('img');
        img.src = 'images/products/' + product.sku + '.png';
        img.alt = product.name || 'Product image';
        img.loading = 'lazy';
        img.onerror = function() { this.parentElement.remove(); };
        imageCol.appendChild(img);
        notesBody.appendChild(imageCol);
      }

      var textCol = document.createElement('div');
      textCol.className = 'product-notes-text';
      var notesP = document.createElement('p');
      notesP.textContent = product.tasting_notes;
      textCol.appendChild(notesP);
      notesBody.appendChild(textCol);

      notesToggle.addEventListener('click', function (wrap, toggle) {
        return function () {
          var isOpen = wrap.classList.toggle('open');
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        };
      }(notesWrap, notesToggle));

      notesWrap.appendChild(notesToggle);
      notesWrap.appendChild(notesBody);
      card.appendChild(notesWrap);
    }

    var discount = parseFloat(product.discount) || 0;

    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'product-discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var pricingFrom = (product.pricing_from || '').trim().toUpperCase() === 'TRUE';
    var plusSign = pricingFrom ? '+' : '';
    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      var priceRow = document.createElement('div');
      priceRow.className = 'product-prices';
      if (instore) {
        var instoreBox = document.createElement('div');
        instoreBox.className = 'product-price-box';
        if (discount > 0) {
          var instoreNum = parseFloat(instore.replace(/[^0-9.]/g, ''));
          var instoreSale = (instoreNum * (1 - discount / 100)).toFixed(2);
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-original">' + instore + '</span><span class="product-price-value">$' + instoreSale + plusSign + '</span>';
        } else {
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-value">' + instore + plusSign + '</span>';
        }
        priceRow.appendChild(instoreBox);
      }
      if (kit) {
        var kitBox = document.createElement('div');
        kitBox.className = 'product-price-box';
        if (discount > 0) {
          var kitNum = parseFloat(kit.replace(/[^0-9.]/g, ''));
          var kitSale = (kitNum * (1 - discount / 100)).toFixed(2);
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-original">' + kit + '</span><span class="product-price-value">$' + kitSale + plusSign + '</span>';
        } else {
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-value">' + kit + plusSign + '</span>';
        }
        priceRow.appendChild(kitBox);
      }
      card.appendChild(priceRow);
    }

    // Reserve button
    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'product-reserve-wrap';
    var productKey = product.name + '|' + product.brand;
    renderFeaturedReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    return card;
  }

  function renderFeaturedReserveControl(container, product, productKey) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'product-reserve-btn';
    btn.textContent = 'Reserve';

    btn.addEventListener('click', function () {
      // Add to reservation and navigate to products page
      if (!isReserved(productKey)) {
        setReservationQty(product, 1);
      }
      // Navigate to products page with SKU to scroll to product
      window.location.href = 'products.html?sku=' + encodeURIComponent(product.sku);
    });

    container.appendChild(btn);
  }
}

// Shared CSV fetch helper — used by all tab loaders
function fetchCSV(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  });
}

// Skeleton loading helper — creates placeholder cards that mimic real layout
function createSkeletonCard() {
  var card = document.createElement('div');
  card.className = 'skeleton-card';
  card.innerHTML =
    '<div class="skeleton-element skeleton-brand"></div>' +
    '<div class="skeleton-element skeleton-title"></div>' +
    '<div class="skeleton-element skeleton-detail"></div>' +
    '<div class="skeleton-badges">' +
      '<div class="skeleton-element skeleton-badge"></div>' +
      '<div class="skeleton-element skeleton-badge"></div>' +
    '</div>' +
    '<div class="skeleton-prices">' +
      '<div class="skeleton-element skeleton-price-box"></div>' +
      '<div class="skeleton-element skeleton-price-box"></div>' +
    '</div>' +
    '<div class="skeleton-element skeleton-notes"></div>';
  return card;
}

function showCatalogSkeletons(container, count) {
  if (!container) return;
  var grid = document.createElement('div');
  grid.className = 'catalog-skeleton-grid';
  for (var i = 0; i < count; i++) {
    grid.appendChild(createSkeletonCard());
  }
  container.appendChild(grid);
}

// Reference to kits applyFilters so tab switcher can re-render
var applyKitsFilters = null;

function loadProducts() {
  var allProducts = [];
  var userHasSorted = false;
  var activeFilters = { type: [], brand: [], subcategory: [], time: [] };
  var saleFilterActive = false;

  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_CSV_URL
    : null;

  var CSV_CACHE_KEY = 'sv-products-csv';
  var CSV_CACHE_TS_KEY = 'sv-products-csv-ts';
  var CSV_CACHE_TTL = 60 * 60 * 1000; // 1 hour - static data rarely changes

  function getCachedCSV() {
    try {
      var csv = localStorage.getItem(CSV_CACHE_KEY);
      var ts = parseInt(localStorage.getItem(CSV_CACHE_TS_KEY), 10) || 0;
      if (csv) return { csv: csv, fresh: (Date.now() - ts) < CSV_CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCachedCSV(csv) {
    try {
      localStorage.setItem(CSV_CACHE_KEY, csv);
      localStorage.setItem(CSV_CACHE_TS_KEY, String(Date.now()));
    } catch (e) {}
  }

  var cached = getCachedCSV();
  var csvPromise;

  // Show skeleton loading if no cached data (first load)
  var catalog = document.getElementById('product-catalog');
  if (!cached && catalog) {
    showCatalogSkeletons(catalog, 6);
  }

  if (cached) {
    // Serve cached data immediately
    csvPromise = Promise.resolve(cached.csv);

    // Refresh in background if stale
    if (!cached.fresh) {
      var refreshUrl = csvUrl || 'content/products.csv';
      fetchCSV(refreshUrl).then(setCachedCSV).catch(function () {});
    }
  } else {
    csvPromise = csvUrl
      ? fetchCSV(csvUrl).catch(function () { return fetchCSV('content/products.csv'); })
      : fetchCSV('content/products.csv');
    csvPromise.then(setCachedCSV);
  }

  csvPromise
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      var headers = lines[0].split(',');

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].trim()] = values[j].trim();
        }
        if (!obj.name && !obj.sku) continue;
        if (obj.hide && obj.hide.toLowerCase() === 'true') continue;
        if ((obj.favorite || '').toLowerCase() === 'true') {
          obj._favRand = Math.random();
        }
        allProducts.push(obj);
      }

      buildFilterRow('filter-type', 'type', 'Type:');
      buildFilterRow('filter-brand', 'brand', 'Brand:');
      buildFilterRow('filter-subcategory', 'subcategory', 'Style:');
      buildFilterRow('filter-time', 'time', 'Brew Time:');
      buildSaleFilter();
      applyFilters();

      // Check for SKU parameter and scroll to product (from homepage featured)
      var urlParams = new URLSearchParams(window.location.search);
      var targetSku = urlParams.get('sku');
      if (targetSku) {
        var scrollAttempts = 0;
        function tryScrollToProduct() {
          var targetCard = document.querySelector('[data-sku="' + targetSku + '"]');
          if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCard.classList.add('highlight');
            setTimeout(function () { targetCard.classList.remove('highlight'); }, 2000);
          } else if (scrollAttempts < 10) {
            scrollAttempts++;
            setTimeout(tryScrollToProduct, 100);
          }
        }
        setTimeout(tryScrollToProduct, 50);
      }

      // Expose so tab switcher can re-trigger kits rendering
      applyKitsFilters = applyFilters;

      var searchInput = document.getElementById('catalog-search');
      if (searchInput) {
        var searchTimer;
        searchInput.addEventListener('input', function () {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(applyFilters, 180);
        });
      }

      var sortSelect = document.getElementById('catalog-sort');
      if (sortSelect) {
        sortSelect.addEventListener('change', function () {
          userHasSorted = true;
          applyFilters();
        });
      }

      var toggleBtn = document.getElementById('catalog-toggle');
      var collapsible = document.getElementById('catalog-collapsible');
      if (toggleBtn && collapsible) {
        toggleBtn.addEventListener('click', function () {
          var expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
          toggleBtn.setAttribute('aria-expanded', String(!expanded));
          collapsible.classList.toggle('open');
        });
      }
    })
    .catch(function () {
      // Silently fail — noscript fallback is in the HTML
    });

  function buildFilterRow(containerId, field, label) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var labelSpan = document.createElement('span');
    labelSpan.className = 'catalog-filter-label';
    labelSpan.textContent = label;
    container.appendChild(labelSpan);

    var uniqueValues = [];
    allProducts.forEach(function (r) {
      var val = r[field] || '';
      if (val && uniqueValues.indexOf(val) === -1) {
        uniqueValues.push(val);
      }
    });

    if (field === 'time') {
      uniqueValues.sort(function (a, b) {
        var numA = parseFloat(a) || 0;
        var numB = parseFloat(b) || 0;
        return numA - numB;
      });
    } else if (field === 'subcategory') {
      var styleOrder = ['red', 'white', 'rosé', 'rose', 'fruit', 'specialty'];
      uniqueValues.sort(function (a, b) {
        var aIdx = styleOrder.indexOf(a.toLowerCase());
        var bIdx = styleOrder.indexOf(b.toLowerCase());
        if (aIdx === -1) aIdx = styleOrder.length;
        if (bIdx === -1) bIdx = styleOrder.length;
        return aIdx - bIdx;
      });
    } else {
      uniqueValues.sort();
    }

    var allBtn = createFilterButton('All', containerId, field);
    allBtn.classList.add('active');
    container.appendChild(allBtn);

    uniqueValues.forEach(function (val) {
      container.appendChild(createFilterButton(val, containerId, field));
    });
  }

  function buildSaleFilter() {
    var hasSaleProducts = allProducts.some(function (p) {
      return parseFloat(p.discount) > 0;
    });
    var container = document.getElementById('filter-sale');
    if (!container || !hasSaleProducts) {
      if (container) container.style.display = 'none';
      return;
    }
    var labelSpan = document.createElement('span');
    labelSpan.className = 'catalog-filter-label';
    labelSpan.textContent = 'Sale:';
    container.appendChild(labelSpan);

    var btn = document.createElement('button');
    btn.className = 'catalog-filter-btn';
    btn.type = 'button';
    btn.textContent = 'On Sale';
    btn.addEventListener('click', function () {
      saleFilterActive = !saleFilterActive;
      btn.classList.toggle('active', saleFilterActive);
      applyFilters();
    });
    container.appendChild(btn);
  }

  function createFilterButton(label, containerId, field) {
    var btn = document.createElement('button');
    btn.className = 'catalog-filter-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.setAttribute('data-field', field);
    btn.setAttribute('data-value', label);
    btn.addEventListener('click', function () {
      if (label === 'All') {
        activeFilters[field] = [];
      } else {
        var idx = activeFilters[field].indexOf(label);
        if (idx !== -1) {
          activeFilters[field].splice(idx, 1);
        } else {
          activeFilters[field].push(label);
        }
      }
      var container = document.getElementById(containerId);
      var buttons = container.querySelectorAll('.catalog-filter-btn');
      buttons.forEach(function (b) { b.classList.remove('active'); });
      if (activeFilters[field].length === 0) {
        container.querySelector('[data-value="All"]').classList.add('active');
      } else {
        buttons.forEach(function (b) {
          if (activeFilters[field].indexOf(b.getAttribute('data-value')) !== -1) {
            b.classList.add('active');
          }
        });
      }
      applyFilters();
      updateFilterAvailability();
    });
    return btn;
  }

  function matchesFilters(product, excludeField) {
    var fields = ['type', 'brand', 'subcategory', 'time'];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f === excludeField) continue;
      if (activeFilters[f].length > 0 && activeFilters[f].indexOf(product[f]) === -1) return false;
    }
    return true;
  }

  function updateFilterAvailability() {
    var fields = ['type', 'brand', 'subcategory', 'time'];
    fields.forEach(function (field) {
      var containerId = 'filter-' + (field === 'subcategory' ? 'subcategory' : field);
      var container = document.getElementById(containerId);
      if (!container) return;
      var buttons = container.querySelectorAll('.catalog-filter-btn');
      buttons.forEach(function (btn) {
        var val = btn.getAttribute('data-value');
        if (val === 'All') return;
        var hasResults = allProducts.some(function (p) {
          return p[field] === val && matchesFilters(p, field);
        });
        if (hasResults) {
          btn.classList.remove('disabled');
          btn.disabled = false;
        } else {
          btn.classList.add('disabled');
          btn.disabled = true;
          btn.classList.remove('active');
          var idx = activeFilters[field].indexOf(val);
          if (idx !== -1) activeFilters[field].splice(idx, 1);
        }
      });
    });
  }

  function parsePrice(product) {
    var val = product.retail_instore || product.retail_kit || '0';
    return parseFloat(val.replace('$', '')) || 0;
  }

  function parseTimeValue(str) {
    var match = (str || '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function applyFilters() {
    var searchInput = document.getElementById('catalog-search');
    var query = searchInput ? searchInput.value.toLowerCase() : '';

    var filtered = allProducts.filter(function (r) {
      if (activeFilters.type.length > 0 && activeFilters.type.indexOf(r.type) === -1) return false;
      if (activeFilters.brand.length > 0 && activeFilters.brand.indexOf(r.brand) === -1) return false;
      if (activeFilters.subcategory.length > 0 && activeFilters.subcategory.indexOf(r.subcategory) === -1) return false;
      if (activeFilters.time.length > 0 && activeFilters.time.indexOf(r.time) === -1) return false;
      if (saleFilterActive && !(parseFloat(r.discount) > 0)) return false;
      if (!query) return true;
      var name = (r.name || '').toLowerCase();
      var sub = (r.subcategory || '').toLowerCase();
      var notes = (r.tasting_notes || '').toLowerCase();
      var brand = (r.brand || '').toLowerCase();
      return name.indexOf(query) !== -1 || sub.indexOf(query) !== -1 || notes.indexOf(query) !== -1 || brand.indexOf(query) !== -1;
    });

    var sortSelect = document.getElementById('catalog-sort');
    var sortVal = sortSelect ? sortSelect.value : 'name-asc';

    filtered.sort(function (a, b) {
      if (!userHasSorted) {
        var favA = (a.favorite || '').toLowerCase() === 'true' ? 0 : 1;
        var favB = (b.favorite || '').toLowerCase() === 'true' ? 0 : 1;
        if (favA !== favB) return favA - favB;
        if (favA === 0 && favB === 0) return (a._favRand || 0) - (b._favRand || 0);
      }

      switch (sortVal) {
        case 'name-asc':
          return (a.name || '').localeCompare(b.name || '');
        case 'name-desc':
          return (b.name || '').localeCompare(a.name || '');
        case 'price-asc':
          return parsePrice(a) - parsePrice(b);
        case 'price-desc':
          return parsePrice(b) - parsePrice(a);
        case 'time-asc':
          return parseTimeValue(a.time) - parseTimeValue(b.time);
        case 'time-desc':
          return parseTimeValue(b.time) - parseTimeValue(a.time);
        default:
          return 0;
      }
    });

    renderCatalog(filtered);
  }

  function renderCatalog(rows) {
    var catalog = document.getElementById('product-catalog');
    if (!catalog) return;

    // Remove existing sections, dividers, skeletons, and no-results message
    var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider, .catalog-skeleton-grid');
    sections.forEach(function (el) { el.parentNode.removeChild(el); });

    if (rows.length === 0) {
      var msg = document.createElement('p');
      msg.className = 'catalog-no-results';
      msg.textContent = 'No products found.';
      catalog.appendChild(msg);
      return;
    }

    function getAvailable(r) {
      if (r.available !== undefined && r.available !== '') return parseInt(r.available, 10) || 0;
      return parseInt(r.stock, 10) || 0;
    }
    var inStock = rows.filter(function (r) { return getAvailable(r) > 0; });
    var orderIn = rows.filter(function (r) { return getAvailable(r) <= 0; });

    renderSection(catalog, 'Currently available', inStock);

    if (inStock.length > 0 && orderIn.length > 0) {
      var divider = document.createElement('div');
      divider.className = 'section-icon catalog-divider';
      var icon = document.createElement('img');
      icon.src = 'images/Icon_green.svg';
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      divider.appendChild(icon);
      catalog.appendChild(divider);
    }

    renderSection(catalog, 'Available to order', orderIn, 'catalog-section--order');
  }

  function buildWineCard(product) {
    var tint = getTintClass(product);
    var card = document.createElement('div');
    card.className = 'label-wine' + (tint ? ' ' + tint : '');
    if (product.sku) card.setAttribute('data-sku', product.sku);

    var discount = parseFloat(product.discount) || 0;
    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var body = document.createElement('div');
    body.className = 'label-body';

    var brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = product.brand || '';
    body.appendChild(brand);

    var ornament = document.createElement('div');
    ornament.className = 'ornament';
    body.appendChild(ornament);

    var wineName = document.createElement('div');
    wineName.className = 'wine-name';
    wineName.textContent = product.name || '';
    body.appendChild(wineName);

    if (product.subcategory) {
      var sub = document.createElement('div');
      sub.className = 'subcategory';
      sub.textContent = product.subcategory;
      body.appendChild(sub);
    }

    if (product.time) {
      var time = document.createElement('div');
      time.className = 'time';
      time.textContent = product.time;
      body.appendChild(time);
    }

    if (product.abv) {
      var abv = document.createElement('div');
      abv.className = 'abv';
      abv.textContent = product.abv + (product.abv.toLowerCase().indexOf('abv') === -1 ? ' ABV' : '');
      body.appendChild(abv);
    }

    if (product.tasting_notes || product.sku) {
      body.appendChild(buildLabelNotesToggle(product));
    }

    var spacer = document.createElement('div');
    spacer.className = 'notes-spacer';
    body.appendChild(spacer);

    card.appendChild(body);

    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      card.appendChild(buildLabelPriceFooter(product));
    }

    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'reserve-link';
    var productKey = product.name + '|' + product.brand;
    renderReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    return card;
  }

  function buildBeerCard(product) {
    var tint = getTintClass(product);
    var card = document.createElement('div');
    card.className = 'label-beer' + (tint ? ' ' + tint : '');
    if (product.sku) card.setAttribute('data-sku', product.sku);

    var discount = parseFloat(product.discount) || 0;
    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var body = document.createElement('div');
    body.className = 'label-body';

    var logo = document.createElement('div');
    logo.className = 'sv-logo';
    logo.innerHTML = SV_LOGO_SVG;
    body.appendChild(logo);

    var brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = product.brand || '';
    body.appendChild(brand);

    var goldRule = document.createElement('div');
    goldRule.className = 'gold-rule';
    body.appendChild(goldRule);

    var beerName = document.createElement('div');
    beerName.className = 'beer-name';
    beerName.textContent = product.name || '';
    body.appendChild(beerName);

    if (product.subcategory) {
      var sub = document.createElement('div');
      sub.className = 'subcategory';
      sub.textContent = product.subcategory;
      body.appendChild(sub);
    }

    if (product.time) {
      var time = document.createElement('div');
      time.className = 'time';
      time.textContent = product.time;
      body.appendChild(time);
    }

    if (product.abv) {
      var abv = document.createElement('div');
      abv.className = 'abv';
      abv.textContent = product.abv + (product.abv.toLowerCase().indexOf('abv') === -1 ? ' ABV' : '');
      body.appendChild(abv);
    }

    if (product.tasting_notes || product.sku) {
      body.appendChild(buildLabelNotesToggle(product));
    }

    var spacer = document.createElement('div');
    spacer.className = 'notes-spacer';
    body.appendChild(spacer);

    card.appendChild(body);

    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      card.appendChild(buildLabelPriceFooter(product));
    }

    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'reserve-link';
    var productKey = product.name + '|' + product.brand;
    renderReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    return card;
  }

  function buildDefaultCard(product) {
    var card = document.createElement('div');
    card.className = 'product-card';
    if (product.sku) {
      card.setAttribute('data-sku', product.sku);
    }

    var header = document.createElement('div');
    header.className = 'product-card-header';

    var cardBrand = document.createElement('p');
    cardBrand.className = 'product-brand';
    cardBrand.textContent = product.brand;
    header.appendChild(cardBrand);

    var cardName = document.createElement('h4');
    cardName.textContent = product.name;
    header.appendChild(cardName);

    card.appendChild(header);

    var batchSize = (product.batch_size_liters || '').trim();
    if (product.subcategory || product.time || batchSize) {
      var detailRow = document.createElement('div');
      detailRow.className = 'product-detail-row';
      var details = [];
      if (product.subcategory) details.push(product.subcategory);
      if (product.time) details.push(product.time);
      if (batchSize) details.push(batchSize + 'L');
      for (var d = 0; d < details.length; d++) {
        if (d > 0) {
          var sep = document.createElement('span');
          sep.className = 'detail-sep';
          sep.textContent = '\u00b7';
          detailRow.appendChild(sep);
        }
        var detailSpan = document.createElement('span');
        detailSpan.textContent = details[d];
        detailRow.appendChild(detailSpan);
      }
      card.appendChild(detailRow);
    }

    if (product.tasting_notes) {
      var notesWrap = document.createElement('div');
      notesWrap.className = 'product-notes';

      var notesToggle = document.createElement('button');
      notesToggle.type = 'button';
      notesToggle.className = 'product-notes-toggle';
      notesToggle.setAttribute('aria-expanded', 'false');
      notesToggle.innerHTML = 'More Information <span class="product-notes-chevron">&#9660;</span>';

      var notesBody = document.createElement('div');
      notesBody.className = 'product-notes-body';

      if (product.sku) {
        var imageCol = document.createElement('div');
        imageCol.className = 'product-notes-image';
        var img = document.createElement('img');
        img.src = 'images/products/' + product.sku + '.png';
        img.alt = product.name || 'Product image';
        img.loading = 'lazy';
        img.onerror = function() { this.parentElement.remove(); };
        imageCol.appendChild(img);
        notesBody.appendChild(imageCol);
      }

      var textCol = document.createElement('div');
      textCol.className = 'product-notes-text';
      var notesP = document.createElement('p');
      notesP.textContent = product.tasting_notes;
      textCol.appendChild(notesP);
      notesBody.appendChild(textCol);

      notesToggle.addEventListener('click', function (wrap, toggle, prod) {
        return function () {
          var isOpen = wrap.classList.toggle('open');
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          if (isOpen) {
            trackEvent('detail', prod.sku || '', prod.name || '');
          }
        };
      }(notesWrap, notesToggle, product));

      notesWrap.appendChild(notesToggle);
      notesWrap.appendChild(notesBody);
      card.appendChild(notesWrap);
    }

    var discount = parseFloat(product.discount) || 0;

    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'product-discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var pricingFrom = (product.pricing_from || '').trim().toUpperCase() === 'TRUE';
    var plusSign = pricingFrom ? '+' : '';
    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      var priceRow = document.createElement('div');
      priceRow.className = 'product-prices';
      if (instore) {
        var instoreBox = document.createElement('div');
        instoreBox.className = 'product-price-box';
        if (discount > 0) {
          var instoreNum = parseFloat(instore.replace(/[^0-9.]/g, ''));
          var instoreSale = (instoreNum * (1 - discount / 100)).toFixed(2);
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-original">' + instore + '</span><span class="product-price-value">$' + instoreSale + plusSign + '</span>';
        } else {
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-value">' + instore + plusSign + '</span>';
        }
        priceRow.appendChild(instoreBox);
      }
      if (kit) {
        var kitBox = document.createElement('div');
        kitBox.className = 'product-price-box';
        if (discount > 0) {
          var kitNum = parseFloat(kit.replace(/[^0-9.]/g, ''));
          var kitSale = (kitNum * (1 - discount / 100)).toFixed(2);
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-original">' + kit + '</span><span class="product-price-value">$' + kitSale + plusSign + '</span>';
        } else {
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-value">' + kit + plusSign + '</span>';
        }
        priceRow.appendChild(kitBox);
      }
      card.appendChild(priceRow);
    }

    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'product-reserve-wrap';
    var productKey = product.name + '|' + product.brand;
    renderReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    return card;
  }

  function renderSection(catalog, title, items, extraClass) {
    if (items.length === 0) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'catalog-section' + (extraClass ? ' ' + extraClass : '');

    var sectionHeader = document.createElement('div');
    sectionHeader.className = 'catalog-section-header';

    var sectionHeading = document.createElement('h2');
    sectionHeading.className = 'catalog-section-title';
    sectionHeading.textContent = title;
    sectionHeader.appendChild(sectionHeading);

    if (extraClass === 'catalog-section--order') {
      var note = document.createElement('p');
      note.className = 'process-note';
      note.textContent = 'Allow up to 2 weeks for items to be ordered in.';
      sectionHeader.appendChild(note);
    }

    wrapper.appendChild(sectionHeader);

    // Group by type, preserving CSV order
    var groups = {};
    var groupOrder = [];
    items.forEach(function (r) {
      if (!groups[r.type]) {
        groups[r.type] = [];
        groupOrder.push(r.type);
      }
      groups[r.type].push(r);
    });

    groupOrder.forEach(function (type) {
      var group = document.createElement('div');
      group.className = 'product-group';

      var heading = document.createElement('h3');
      heading.className = 'product-group-title';
      heading.textContent = type;
      group.appendChild(heading);

      var grid = document.createElement('div');
      grid.className = 'product-grid';

      groups[type].forEach(function (product) {
        var productType = (product.type || '').toLowerCase();
        var card;
        if (productType.indexOf('wine') !== -1) {
          card = buildWineCard(product);
        } else if (productType.indexOf('beer') !== -1) {
          card = buildBeerCard(product);
        } else {
          card = buildDefaultCard(product);
        }
        grid.appendChild(card);
      });

      group.appendChild(grid);
      wrapper.appendChild(group);
    });

    catalog.appendChild(wrapper);
  }
}

// ===== Product Tab Switching =====

function initProductTabs() {
  var tabs = document.getElementById('product-tabs');
  if (!tabs) return;

  var ingredientsLoaded = false;
  var servicesLoaded = false;

  tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.product-tab-btn');
    if (!btn) return;

    var tab = btn.getAttribute('data-product-tab');

    // Swap active button
    var allBtns = tabs.querySelectorAll('.product-tab-btn');
    allBtns.forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');

    // Show/hide controls
    var controlIds = ['catalog-controls-kits', 'catalog-controls-ingredients', 'catalog-controls-services'];
    controlIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    var activeControls = document.getElementById('catalog-controls-' + tab);
    if (activeControls) activeControls.classList.remove('hidden');

    // Show/hide kits process note
    var processNote = document.getElementById('kits-process-note');
    if (processNote) processNote.style.display = (tab === 'kits') ? '' : 'none';

    // Show/hide reservation bar on non-kits tabs
    var bars = document.querySelectorAll('.reservation-bar');
    bars.forEach(function (bar) {
      if (tab === 'kits') {
        updateReservationBar();
      } else {
        bar.classList.add('hidden');
      }
    });

    // Clear rendered catalog sections
    var catalog = document.getElementById('product-catalog');
    if (catalog) {
      var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider, .catalog-skeleton-grid');
      sections.forEach(function (el) { el.parentNode.removeChild(el); });
    }

    // Load the appropriate tab
    if (tab === 'kits') {
      if (applyKitsFilters) applyKitsFilters();
    } else if (tab === 'ingredients') {
      if (!ingredientsLoaded) {
        ingredientsLoaded = true;
        loadIngredients(function () {
          // After first load, subsequent clicks just re-render
        });
      } else {
        renderIngredients();
      }
    } else if (tab === 'services') {
      if (!servicesLoaded) {
        servicesLoaded = true;
        loadServices(function () {});
      } else {
        renderServices();
      }
    }
  });

  // Wire up ingredients filter/sort toggle
  var ingredientToggle = document.getElementById('ingredient-toggle');
  var ingredientCollapsible = document.getElementById('ingredient-collapsible');
  if (ingredientToggle && ingredientCollapsible) {
    ingredientToggle.addEventListener('click', function () {
      var expanded = ingredientToggle.getAttribute('aria-expanded') === 'true';
      ingredientToggle.setAttribute('aria-expanded', String(!expanded));
      ingredientCollapsible.classList.toggle('open');
    });
  }
}

// ===== Ingredients & Supplies =====

var _allIngredients = [];
var _ingredientFilters = { unit: [] };

function loadIngredients(callback) {
  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_INGREDIENTS_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_INGREDIENTS_CSV_URL
    : null;

  var CACHE_KEY = 'sv-ingredients-csv';
  var CACHE_TS_KEY = 'sv-ingredients-csv-ts';
  var CACHE_TTL = 60 * 60 * 1000; // 1 hour - static data rarely changes

  function getCached() {
    try {
      var csv = localStorage.getItem(CACHE_KEY);
      var ts = parseInt(localStorage.getItem(CACHE_TS_KEY), 10) || 0;
      if (csv) return { csv: csv, fresh: (Date.now() - ts) < CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCached(csv) {
    try {
      localStorage.setItem(CACHE_KEY, csv);
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
    } catch (e) {}
  }

  var cached = getCached();
  var csvPromise;

  if (cached) {
    csvPromise = Promise.resolve(cached.csv);
    if (!cached.fresh) {
      var refreshUrl = csvUrl || 'content/ingredients.csv';
      fetchCSV(refreshUrl).then(setCached).catch(function () {});
    }
  } else {
    csvPromise = csvUrl
      ? fetchCSV(csvUrl).catch(function () { return fetchCSV('content/ingredients.csv'); })
      : fetchCSV('content/ingredients.csv');
    csvPromise.then(setCached);
  }

  csvPromise
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      var headers = lines[0].split(',');
      _allIngredients = [];

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].trim()] = values[j].trim();
        }
        if (!obj.name && !obj.sku) continue;
        if (obj.hide && obj.hide.toLowerCase() === 'true') continue;
        _allIngredients.push(obj);
      }

      buildIngredientFilters();
      renderIngredients();
      wireIngredientEvents();
      if (callback) callback();
    })
    .catch(function () {});
}

function buildIngredientFilters() {
  var container = document.getElementById('filter-unit');
  if (!container || container.children.length > 0) return;

  var labelSpan = document.createElement('span');
  labelSpan.className = 'catalog-filter-label';
  labelSpan.textContent = 'Unit:';
  container.appendChild(labelSpan);

  var units = [];
  _allIngredients.forEach(function (r) {
    var val = (r.unit || '').trim();
    if (val && units.indexOf(val) === -1) units.push(val);
  });
  units.sort();

  var allBtn = document.createElement('button');
  allBtn.className = 'catalog-filter-btn active';
  allBtn.type = 'button';
  allBtn.textContent = 'All';
  allBtn.setAttribute('data-value', 'All');
  allBtn.addEventListener('click', function () {
    _ingredientFilters.unit = [];
    var btns = container.querySelectorAll('.catalog-filter-btn');
    btns.forEach(function (b) { b.classList.remove('active'); });
    allBtn.classList.add('active');
    renderIngredients();
  });
  container.appendChild(allBtn);

  units.forEach(function (val) {
    var btn = document.createElement('button');
    btn.className = 'catalog-filter-btn';
    btn.type = 'button';
    btn.textContent = val;
    btn.setAttribute('data-value', val);
    btn.addEventListener('click', function () {
      var idx = _ingredientFilters.unit.indexOf(val);
      if (idx !== -1) {
        _ingredientFilters.unit.splice(idx, 1);
      } else {
        _ingredientFilters.unit.push(val);
      }
      var btns = container.querySelectorAll('.catalog-filter-btn');
      btns.forEach(function (b) { b.classList.remove('active'); });
      if (_ingredientFilters.unit.length === 0) {
        container.querySelector('[data-value="All"]').classList.add('active');
      } else {
        btns.forEach(function (b) {
          if (_ingredientFilters.unit.indexOf(b.getAttribute('data-value')) !== -1) {
            b.classList.add('active');
          }
        });
      }
      renderIngredients();
    });
    container.appendChild(btn);
  });
}

function wireIngredientEvents() {
  var searchInput = document.getElementById('ingredient-search');
  if (searchInput) {
    var timer;
    searchInput.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(renderIngredients, 180);
    });
  }

  var sortSelect = document.getElementById('ingredient-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', function () {
      renderIngredients();
    });
  }
}

function renderIngredients() {
  var catalog = document.getElementById('product-catalog');
  if (!catalog) return;

  // Clear existing rendered sections
  var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider, .catalog-skeleton-grid');
  sections.forEach(function (el) { el.parentNode.removeChild(el); });

  var searchInput = document.getElementById('ingredient-search');
  var query = searchInput ? searchInput.value.toLowerCase() : '';

  var filtered = _allIngredients.filter(function (r) {
    if (_ingredientFilters.unit.length > 0 && _ingredientFilters.unit.indexOf(r.unit) === -1) return false;
    if (!query) return true;
    var name = (r.name || '').toLowerCase();
    var desc = (r.description || '').toLowerCase();
    return name.indexOf(query) !== -1 || desc.indexOf(query) !== -1;
  });

  var sortSelect = document.getElementById('ingredient-sort');
  var sortVal = sortSelect ? sortSelect.value : 'name-asc';

  filtered.sort(function (a, b) {
    switch (sortVal) {
      case 'name-asc': return (a.name || '').localeCompare(b.name || '');
      case 'name-desc': return (b.name || '').localeCompare(a.name || '');
      case 'price-asc': return (parseFloat(a.price_per_unit) || 0) - (parseFloat(b.price_per_unit) || 0);
      case 'price-desc': return (parseFloat(b.price_per_unit) || 0) - (parseFloat(a.price_per_unit) || 0);
      default: return 0;
    }
  });

  if (filtered.length === 0) {
    var msg = document.createElement('p');
    msg.className = 'catalog-no-results';
    msg.textContent = 'No ingredients or supplies found.';
    catalog.appendChild(msg);
    return;
  }

  var inStock = filtered.filter(function (r) { return (parseInt(r.stock, 10) || 0) > 0; });
  var outOfStock = filtered.filter(function (r) { return (parseInt(r.stock, 10) || 0) <= 0; });

  renderIngredientSection(catalog, 'In stock', inStock);

  if (inStock.length > 0 && outOfStock.length > 0) {
    var divider = document.createElement('div');
    divider.className = 'section-icon catalog-divider';
    var icon = document.createElement('img');
    icon.src = 'images/Icon_green.svg';
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    divider.appendChild(icon);
    catalog.appendChild(divider);
  }

  renderIngredientSection(catalog, 'Out of stock', outOfStock, 'catalog-section--order');
}

function renderIngredientSection(catalog, title, items, extraClass) {
  if (items.length === 0) return;

  var wrapper = document.createElement('div');
  wrapper.className = 'catalog-section' + (extraClass ? ' ' + extraClass : '');

  var sectionHeader = document.createElement('div');
  sectionHeader.className = 'catalog-section-header';
  var heading = document.createElement('h2');
  heading.className = 'catalog-section-title';
  heading.textContent = title;
  sectionHeader.appendChild(heading);
  wrapper.appendChild(sectionHeader);

  var grid = document.createElement('div');
  grid.className = 'product-grid';

  items.forEach(function (item) {
    var card = document.createElement('div');
    card.className = 'product-card';

    var header = document.createElement('div');
    header.className = 'product-card-header';

    var cardName = document.createElement('h4');
    cardName.textContent = item.name;
    header.appendChild(cardName);
    card.appendChild(header);

    // Unit + price detail row
    var unit = (item.unit || '').trim();
    var price = (item.price_per_unit || '').trim();
    if (unit || price) {
      var detailRow = document.createElement('div');
      detailRow.className = 'product-detail-row';
      var details = [];
      if (unit) details.push(unit);
      if (price) details.push(price.charAt(0) === '$' ? price : '$' + price);
      for (var d = 0; d < details.length; d++) {
        if (d > 0) {
          var sep = document.createElement('span');
          sep.className = 'detail-sep';
          sep.textContent = '\u00b7';
          detailRow.appendChild(sep);
        }
        var span = document.createElement('span');
        span.textContent = details[d];
        detailRow.appendChild(span);
      }
      card.appendChild(detailRow);
    }

    // Collapsible description (reusing product-notes pattern)
    if (item.description) {
      var notesWrap = document.createElement('div');
      notesWrap.className = 'product-notes';

      var notesToggle = document.createElement('button');
      notesToggle.type = 'button';
      notesToggle.className = 'product-notes-toggle';
      notesToggle.setAttribute('aria-expanded', 'false');
      notesToggle.innerHTML = 'More Information <span class="product-notes-chevron">&#9660;</span>';

      var notesBody = document.createElement('div');
      notesBody.className = 'product-notes-body';
      var notesP = document.createElement('p');
      notesP.textContent = item.description;
      notesBody.appendChild(notesP);

      notesToggle.addEventListener('click', (function (wrap, toggle) {
        return function () {
          var isOpen = wrap.classList.toggle('open');
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        };
      })(notesWrap, notesToggle));

      notesWrap.appendChild(notesToggle);
      notesWrap.appendChild(notesBody);
      card.appendChild(notesWrap);
    }

    // Stock badge
    var stockVal = parseInt(item.stock, 10) || 0;
    var badge = document.createElement('span');
    badge.className = 'stock-badge';
    if (stockVal > 0) {
      badge.classList.add('stock-badge--in');
      badge.textContent = 'In Stock';
    } else {
      badge.classList.add('stock-badge--out');
      badge.textContent = 'Out of Stock';
    }
    card.appendChild(badge);

    grid.appendChild(card);
  });

  wrapper.appendChild(grid);
  catalog.appendChild(wrapper);
}

// ===== Services =====

var _allServices = [];

function loadServices(callback) {
  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SERVICES_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SERVICES_CSV_URL
    : null;

  var CACHE_KEY = 'sv-services-csv';
  var CACHE_TS_KEY = 'sv-services-csv-ts';
  var CACHE_TTL = 60 * 60 * 1000; // 1 hour - static data rarely changes

  function getCached() {
    try {
      var csv = localStorage.getItem(CACHE_KEY);
      var ts = parseInt(localStorage.getItem(CACHE_TS_KEY), 10) || 0;
      if (csv) return { csv: csv, fresh: (Date.now() - ts) < CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCached(csv) {
    try {
      localStorage.setItem(CACHE_KEY, csv);
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
    } catch (e) {}
  }

  var cached = getCached();
  var csvPromise;

  if (cached) {
    csvPromise = Promise.resolve(cached.csv);
    if (!cached.fresh) {
      var refreshUrl = csvUrl || 'content/services.csv';
      fetchCSV(refreshUrl).then(setCached).catch(function () {});
    }
  } else {
    csvPromise = csvUrl
      ? fetchCSV(csvUrl).catch(function () { return fetchCSV('content/services.csv'); })
      : fetchCSV('content/services.csv');
    csvPromise.then(setCached);
  }

  csvPromise
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      var headers = lines[0].split(',');
      _allServices = [];

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].trim()] = values[j].trim();
        }
        if (!obj.name && !obj.sku) continue;
        if (obj.hide && obj.hide.toLowerCase() === 'true') continue;
        _allServices.push(obj);
      }

      renderServices();
      wireServiceEvents();
      if (callback) callback();
    })
    .catch(function () {});
}

function wireServiceEvents() {
  var searchInput = document.getElementById('service-search');
  if (searchInput) {
    var timer;
    searchInput.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(renderServices, 180);
    });
  }
}

function renderServices() {
  var catalog = document.getElementById('product-catalog');
  if (!catalog) return;

  var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider, .catalog-skeleton-grid');
  sections.forEach(function (el) { el.parentNode.removeChild(el); });

  var searchInput = document.getElementById('service-search');
  var query = searchInput ? searchInput.value.toLowerCase() : '';

  var filtered = _allServices.filter(function (r) {
    if (!query) return true;
    var name = (r.name || '').toLowerCase();
    var desc = (r.desription || r.description || '').toLowerCase();
    return name.indexOf(query) !== -1 || desc.indexOf(query) !== -1;
  });

  if (filtered.length === 0) {
    var msg = document.createElement('p');
    msg.className = 'catalog-no-results';
    msg.textContent = 'No services found.';
    catalog.appendChild(msg);
    return;
  }

  var wrapper = document.createElement('div');
  wrapper.className = 'catalog-section';

  var sectionHeader = document.createElement('div');
  sectionHeader.className = 'catalog-section-header';
  var heading = document.createElement('h2');
  heading.className = 'catalog-section-title';
  heading.textContent = 'Our Services';
  sectionHeader.appendChild(heading);
  wrapper.appendChild(sectionHeader);

  var grid = document.createElement('div');
  grid.className = 'product-grid';

  filtered.forEach(function (svc) {
    var card = document.createElement('div');
    card.className = 'product-card';

    var header = document.createElement('div');
    header.className = 'product-card-header';
    var cardName = document.createElement('h4');
    cardName.textContent = svc.name;
    header.appendChild(cardName);
    card.appendChild(header);

    // Description (handles the typo column name)
    var descText = (svc.desription || svc.description || '').trim();
    if (descText) {
      var descEl = document.createElement('p');
      descEl.className = 'service-description';
      descEl.textContent = descText;
      card.appendChild(descEl);
    }

    // Price with optional discount
    var price = (svc.price || '').trim();
    var discount = parseFloat(svc.discount) || 0;

    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'product-discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    if (price) {
      var priceRow = document.createElement('div');
      priceRow.className = 'product-prices service-price';
      var priceBox = document.createElement('div');
      priceBox.className = 'product-price-box';

      if (discount > 0) {
        var priceNum = parseFloat(price.replace(/[^0-9.]/g, ''));
        var salePrice = (priceNum * (1 - discount / 100)).toFixed(2);
        priceBox.innerHTML = '<span class="product-price-label">Price</span><span class="product-price-original">' + (price.charAt(0) === '$' ? price : '$' + price) + '</span><span class="product-price-value">$' + salePrice + '</span>';
      } else {
        priceBox.innerHTML = '<span class="product-price-label">Price</span><span class="product-price-value">' + (price.charAt(0) === '$' ? price : '$' + price) + '</span>';
      }

      priceRow.appendChild(priceBox);
      card.appendChild(priceRow);
    }

    grid.appendChild(card);
  });

  wrapper.appendChild(grid);
  catalog.appendChild(wrapper);
}

function parseCSVLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ===== Reservation System =====

var RESERVATION_KEY = 'sv-reservation';

function getReservation() {
  try {
    return JSON.parse(localStorage.getItem(RESERVATION_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveReservation(items) {
  localStorage.setItem(RESERVATION_KEY, JSON.stringify(items));
}

function getReservedQty(productKey) {
  var items = getReservation();
  for (var i = 0; i < items.length; i++) {
    if ((items[i].name + '|' + items[i].brand) === productKey) {
      return items[i].qty || 1;
    }
  }
  return 0;
}

function isReserved(productKey) {
  return getReservedQty(productKey) > 0;
}

function setReservationQty(product, qty) {
  var items = getReservation();
  var key = product.name + '|' + product.brand;
  var idx = -1;
  for (var i = 0; i < items.length; i++) {
    if ((items[i].name + '|' + items[i].brand) === key) {
      idx = i;
      break;
    }
  }

  if (qty <= 0) {
    if (idx !== -1) items.splice(idx, 1);
  } else if (idx !== -1) {
    items[idx].qty = qty;
  } else {
    var effectiveStock = (product.available !== undefined && product.available !== '')
      ? parseInt(product.available, 10) || 0
      : parseInt(product.stock, 10) || 0;
    items.push({
      name: product.name,
      brand: product.brand,
      price: product.retail_instore || product.retail_kit || '',
      discount: product.discount || '',
      stock: effectiveStock,
      time: product.time || '',
      qty: qty
    });
  }

  saveReservation(items);
  updateReservationBar();
}

function renderReserveControl(wrap, product, productKey) {
  wrap.innerHTML = '';
  var qty = getReservedQty(productKey);

  if (qty === 0) {
    var reserveBtn = document.createElement('button');
    reserveBtn.type = 'button';
    reserveBtn.className = 'product-reserve-btn';
    reserveBtn.textContent = 'Reserve';
    reserveBtn.addEventListener('click', function () {
      setReservationQty(product, 1);
      trackEvent('reserve', product.sku || '', product.name || '');
      renderReserveControl(wrap, product, productKey);
    });
    wrap.appendChild(reserveBtn);
  } else {
    var controls = document.createElement('div');
    controls.className = 'product-qty-controls';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'qty-btn';
    minusBtn.textContent = '\u2212';
    minusBtn.addEventListener('click', function () {
      setReservationQty(product, qty - 1);
      renderReserveControl(wrap, product, productKey);
    });

    var qtySpan = document.createElement('span');
    qtySpan.className = 'qty-value';
    qtySpan.textContent = qty;

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'qty-btn';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', function () {
      setReservationQty(product, qty + 1);
      renderReserveControl(wrap, product, productKey);
    });

    controls.appendChild(minusBtn);
    controls.appendChild(qtySpan);
    controls.appendChild(plusBtn);
    wrap.appendChild(controls);
  }
}

function initReservationBar() {
  var barHTML = '<div class="container">' +
    '<span class="reservation-bar-count"></span>' +
    '<a href="reservation.html" class="reservation-bar-link">Confirm Reservation &rarr;</a>' +
    '</div>';

  // Fixed bar at bottom of viewport
  var bar = document.createElement('div');
  bar.className = 'reservation-bar hidden';
  bar.id = 'reservation-bar';
  bar.innerHTML = barHTML;
  document.body.appendChild(bar);

  // Inline bar at bottom of catalog
  var catalog = document.getElementById('product-catalog');
  if (catalog) {
    var inlineBar = document.createElement('div');
    inlineBar.className = 'reservation-bar reservation-bar-inline hidden';
    inlineBar.id = 'reservation-bar-inline';
    inlineBar.innerHTML = barHTML;
    catalog.parentNode.insertBefore(inlineBar, catalog);
  }

  updateReservationBar();
}

function updateReservationBar() {
  var bars = document.querySelectorAll('.reservation-bar');
  if (bars.length === 0) return;
  var items = getReservation();
  var total = 0;
  items.forEach(function (item) { total += (item.qty || 1); });
  var label = total + (total === 1 ? ' kit selected' : ' kits selected');
  for (var i = 0; i < bars.length; i++) {
    var countEl = bars[i].querySelector('.reservation-bar-count');
    if (total > 0) {
      bars[i].classList.remove('hidden');
      if (countEl) countEl.textContent = label;
    } else {
      bars[i].classList.add('hidden');
    }
  }
}

// ===== Reservation Page =====

function initReservationPage() {
  renderReservationItems();
  loadTimeslots();
  setupReservationForm();
}

function refreshReservationDependents() {
  loadTimeslots();
  var selected = document.querySelector('input[name="timeslot"]:checked');
  if (selected) {
    updateCompletionEstimate(selected.value);
  } else {
    var estimateEl = document.getElementById('completion-estimate');
    if (estimateEl) estimateEl.style.display = 'none';
  }
}

function renderReservationItems() {
  var container = document.getElementById('reservation-items');
  var emptyMsg = document.getElementById('reservation-empty');
  if (!container) return;

  var items = getReservation();
  container.innerHTML = '';

  if (items.length === 0) {
    if (emptyMsg) emptyMsg.style.display = '';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  items.forEach(function (item) {
    var row = document.createElement('div');
    row.className = 'reservation-item';

    var info = document.createElement('div');
    info.className = 'reservation-item-info';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'reservation-item-name';
    nameSpan.textContent = item.name;
    info.appendChild(nameSpan);

    var brandSpan = document.createElement('span');
    brandSpan.className = 'reservation-item-brand';
    brandSpan.textContent = item.brand;
    info.appendChild(brandSpan);

    if (item.time) {
      var timeSpan = document.createElement('span');
      timeSpan.className = 'reservation-item-time';
      timeSpan.textContent = item.time;
      info.appendChild(timeSpan);
    }

    if (item.price) {
      var priceSpan = document.createElement('span');
      priceSpan.className = 'reservation-item-price';
      var displayPrice = item.price;
      if (item.discount && parseFloat(item.discount) > 0) {
        var origNum = parseFloat((item.price || '0').replace('$', '')) || 0;
        var disc = parseFloat(item.discount);
        var saleNum = (origNum * (1 - disc / 100)).toFixed(2);
        displayPrice = '$' + saleNum;
      }
      priceSpan.textContent = displayPrice;
      info.appendChild(priceSpan);
    }

    if (item.discount && parseFloat(item.discount) > 0) {
      var discBadge = document.createElement('span');
      discBadge.className = 'reservation-item-discount';
      discBadge.textContent = Math.round(parseFloat(item.discount)) + '% OFF';
      info.appendChild(discBadge);
    }

    // Stock status badge
    var stockNum = parseInt(item.stock, 10) || 0;
    var stockBadge = document.createElement('span');
    stockBadge.className = 'reservation-item-stock';
    if (stockNum > 0) {
      stockBadge.classList.add('reservation-item-stock--available');
      stockBadge.textContent = 'In Stock';
    } else {
      stockBadge.classList.add('reservation-item-stock--order');
      stockBadge.textContent = 'Needs Ordering';
    }
    info.appendChild(stockBadge);

    row.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'reservation-item-actions';

    var qtyControls = document.createElement('div');
    qtyControls.className = 'product-qty-controls';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'qty-btn';
    minusBtn.textContent = '\u2212';
    minusBtn.addEventListener('click', (function (itm) {
      return function () {
        var current = getReservation();
        for (var i = 0; i < current.length; i++) {
          if ((current[i].name + '|' + current[i].brand) === (itm.name + '|' + itm.brand)) {
            current[i].qty = (current[i].qty || 1) - 1;
            if (current[i].qty <= 0) current.splice(i, 1);
            break;
          }
        }
        saveReservation(current);
        renderReservationItems();
        refreshReservationDependents();
      };
    })(item));

    var qtySpan = document.createElement('span');
    qtySpan.className = 'qty-value';
    qtySpan.textContent = item.qty || 1;

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'qty-btn';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', (function (itm) {
      return function () {
        var current = getReservation();
        for (var i = 0; i < current.length; i++) {
          if ((current[i].name + '|' + current[i].brand) === (itm.name + '|' + itm.brand)) {
            current[i].qty = (current[i].qty || 1) + 1;
            break;
          }
        }
        saveReservation(current);
        renderReservationItems();
        refreshReservationDependents();
      };
    })(item));

    qtyControls.appendChild(minusBtn);
    qtyControls.appendChild(qtySpan);
    qtyControls.appendChild(plusBtn);
    actions.appendChild(qtyControls);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'reservation-item-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      var current = getReservation();
      var filtered = current.filter(function (r) {
        return (r.name + '|' + r.brand) !== (item.name + '|' + item.brand);
      });
      saveReservation(filtered);
      renderReservationItems();
      refreshReservationDependents();
    });
    actions.appendChild(removeBtn);

    row.appendChild(actions);

    container.appendChild(row);
  });

  // Subtotal (accounts for discount if stored)
  var subtotal = 0;
  items.forEach(function (item) {
    var price = parseFloat((item.price || '0').replace('$', '')) || 0;
    var disc = parseFloat(item.discount) || 0;
    if (disc > 0) price = price * (1 - disc / 100);
    subtotal += price * (item.qty || 1);
  });

  var subtotalRow = document.createElement('div');
  subtotalRow.className = 'reservation-subtotal';
  subtotalRow.innerHTML = '<span>Estimated Subtotal <span class="reservation-disclaimer">— Final pricing may vary.</span></span><span>$' + subtotal.toFixed(2) + '</span>';
  container.appendChild(subtotalRow);

  // Clear All button
  var clearWrap = document.createElement('div');
  clearWrap.className = 'reservation-clear-wrap';
  var clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn-secondary reservation-clear-btn';
  clearBtn.textContent = 'Clear Selected Items';
  clearBtn.addEventListener('click', function () {
    saveReservation([]);
    renderReservationItems();
    refreshReservationDependents();
  });
  clearWrap.appendChild(clearBtn);
  container.appendChild(clearWrap);
}

function loadTimeslots() {
  var container = document.getElementById('timeslot-groups');
  if (!container) return;

  var scheduleUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL
    : 'content/timeslots.csv';
  fetch(scheduleUrl)
    .then(function (res) { return res.text(); })
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      if (lines.length < 2) return;

      var headers = lines[0].split(',');
      var slots = [];
      for (var i = 1; i < lines.length; i++) {
        var values = lines[i].split(',');
        if (values.length < 3) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].trim()] = values[j].trim();
        }
        slots.push(obj);
      }

      // Filter to available slots only (schedule sheet includes all statuses)
      slots = slots.filter(function (s) {
        return !s.status || s.status === 'available';
      });

      // Check if any reserved item is out of stock
      var reservedItems = getReservation();
      var hasOutOfStock = reservedItems.some(function (item) {
        return (item.stock || 0) === 0;
      });

      // If out-of-stock items exist, calculate 2-week cutoff
      var twoWeekCutoff = null;
      if (hasOutOfStock) {
        twoWeekCutoff = new Date();
        twoWeekCutoff.setDate(twoWeekCutoff.getDate() + 14);
        twoWeekCutoff.setHours(0, 0, 0, 0);
      }

      // Group by date
      var slotsByDate = {};
      slots.forEach(function (slot) {
        if (!slotsByDate[slot.date]) {
          slotsByDate[slot.date] = [];
        }
        slotsByDate[slot.date].push(slot);
      });

      // Find all months that have data
      var allDates = Object.keys(slotsByDate).sort();
      if (allDates.length === 0) return;

      var firstDate = new Date(allDates[0] + 'T00:00:00');
      var lastDate = new Date(allDates[allDates.length - 1] + 'T00:00:00');

      // Build list of months (year-month) that have slots
      var monthsWithSlots = [];
      allDates.forEach(function (d) {
        var ym = d.substring(0, 7); // "YYYY-MM"
        if (monthsWithSlots.indexOf(ym) === -1) {
          monthsWithSlots.push(ym);
        }
      });
      monthsWithSlots.sort();

      // Start calendar at the current month (or first available if current month has no slots)
      var nowYM = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
      var currentMonthIndex = 0;
      for (var mi = 0; mi < monthsWithSlots.length; mi++) {
        if (monthsWithSlots[mi] >= nowYM) {
          currentMonthIndex = mi;
          break;
        }
        // If all months are before now, stay at the last one
        currentMonthIndex = mi;
      }

      container.innerHTML = '';

      // Notice for out-of-stock cutoff
      if (hasOutOfStock) {
        var notice = document.createElement('p');
        notice.className = 'timeslot-notice';
        notice.textContent = 'Some of your selected items need to be ordered in. Timeslots within the next 2 weeks are not available.';
        container.appendChild(notice);
      }

      // Calendar wrapper
      var cal = document.createElement('div');
      cal.className = 'cal';
      container.appendChild(cal);

      // Slots area below calendar
      var slotsArea = document.createElement('div');
      slotsArea.className = 'cal-slots';
      container.appendChild(slotsArea);

      var selectedDate = null;

      function renderCalendar() {
        cal.innerHTML = '';
        var ym = monthsWithSlots[currentMonthIndex];
        var year = parseInt(ym.substring(0, 4), 10);
        var month = parseInt(ym.substring(5, 7), 10) - 1; // 0-indexed

        // Header with arrows
        var header = document.createElement('div');
        header.className = 'cal-header';

        var prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'cal-nav';
        prevBtn.textContent = '\u2039';
        prevBtn.disabled = currentMonthIndex === 0;
        prevBtn.addEventListener('click', function () {
          if (currentMonthIndex > 0) {
            currentMonthIndex--;
            renderCalendar();
          }
        });

        var title = document.createElement('span');
        title.className = 'cal-title';
        var monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'];
        title.textContent = monthNames[month] + ' ' + year;

        var nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'cal-nav';
        nextBtn.textContent = '\u203A';
        nextBtn.disabled = currentMonthIndex === monthsWithSlots.length - 1;
        nextBtn.addEventListener('click', function () {
          if (currentMonthIndex < monthsWithSlots.length - 1) {
            currentMonthIndex++;
            renderCalendar();
          }
        });

        header.appendChild(prevBtn);
        header.appendChild(title);
        header.appendChild(nextBtn);
        cal.appendChild(header);

        // Day-of-week headers
        var grid = document.createElement('div');
        grid.className = 'cal-grid';
        var dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        dowLabels.forEach(function (d) {
          var dow = document.createElement('div');
          dow.className = 'cal-dow';
          dow.textContent = d;
          grid.appendChild(dow);
        });

        // Calendar days
        var firstOfMonth = new Date(year, month, 1);
        var startDow = firstOfMonth.getDay(); // 0=Sun
        var daysInMonth = new Date(year, month + 1, 0).getDate();

        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var todayStr = today.getFullYear() + '-' +
          String(today.getMonth() + 1).padStart(2, '0') + '-' +
          String(today.getDate()).padStart(2, '0');

        // Leading empty cells
        for (var e = 0; e < startDow; e++) {
          var empty = document.createElement('div');
          empty.className = 'cal-day cal-day--disabled';
          grid.appendChild(empty);
        }

        for (var d = 1; d <= daysInMonth; d++) {
          var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
          var cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'cal-day';
          cell.textContent = d;
          cell.setAttribute('data-date', dateStr);

          var cellDate = new Date(dateStr + 'T00:00:00');
          var isPast = cellDate < today;
          var hasSlots = !!slotsByDate[dateStr];
          var hasAvailable = hasSlots && slotsByDate[dateStr].some(function (s) {
            return s.status === 'available';
          });
          var withinCutoff = twoWeekCutoff && cellDate < twoWeekCutoff;

          if (dateStr === todayStr) {
            cell.classList.add('cal-day--today');
          }

          if (dateStr === selectedDate) {
            cell.classList.add('cal-day--selected');
          }

          if (isPast || !hasSlots || withinCutoff) {
            cell.classList.add('cal-day--disabled');
            cell.disabled = true;
            if (!isPast && !hasSlots && !withinCutoff) {
              cell.classList.add('cal-day--closed');
              var closedLabel = document.createElement('span');
              closedLabel.className = 'cal-day-closed';
              closedLabel.textContent = 'Closed';
              cell.appendChild(closedLabel);
            }
          } else if (hasAvailable) {
            cell.classList.add('cal-day--available');
          } else {
            // Has slots but all booked
            cell.classList.add('cal-day--full');
          }

          (function (ds) {
            cell.addEventListener('click', function () {
              selectedDate = ds;
              renderCalendar();
              renderDaySlots(ds);
            });
          })(dateStr);

          grid.appendChild(cell);
        }

        cal.appendChild(grid);
      }

      var radioIndex = 0;

      function renderDaySlots(dateStr) {
        slotsArea.innerHTML = '';
        var daySlots = slotsByDate[dateStr];
        if (!daySlots) return;

        var dateObj = new Date(dateStr + 'T00:00:00');
        var heading = document.createElement('h3');
        heading.className = 'cal-slots-heading';
        heading.textContent = dateObj.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        });
        slotsArea.appendChild(heading);

        var grid = document.createElement('div');
        grid.className = 'cal-slots-grid';

        daySlots.forEach(function (slot) {
          var option = document.createElement('div');
          option.className = 'timeslot-option';
          var unavailable = slot.status === 'booked';
          if (unavailable) {
            option.classList.add('booked');
          }

          var id = 'timeslot-' + radioIndex;
          radioIndex++;

          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'timeslot';
          radio.id = id;
          radio.value = dateStr + ' ' + slot.time;
          if (unavailable) {
            radio.disabled = true;
          }

          var label = document.createElement('label');
          label.setAttribute('for', id);
          label.textContent = slot.time;

          option.appendChild(radio);
          option.appendChild(label);
          grid.appendChild(option);
        });

        slotsArea.appendChild(grid);
      }

      renderCalendar();

      // Attach listener for completion estimate
      container.addEventListener('change', function (e) {
        if (e.target.name === 'timeslot') {
          updateCompletionEstimate(e.target.value);
        }
      });
    })
    .catch(function () {
      container.innerHTML = '<p>Unable to load timeslots.</p>';
    });
}

function updateCompletionEstimate(timeslotValue) {
  var estimateEl = document.getElementById('completion-estimate');
  var textEl = document.getElementById('completion-estimate-text');
  if (!estimateEl || !textEl) return;

  var items = getReservation();
  if (items.length === 0) {
    estimateEl.style.display = 'none';
    return;
  }

  // Find the longest brew time (in weeks) among reserved items
  var maxWeeks = 0;
  items.forEach(function (item) {
    var weeks = parseInt(item.time, 10);
    if (!isNaN(weeks) && weeks > maxWeeks) {
      maxWeeks = weeks;
    }
  });

  if (maxWeeks === 0) {
    estimateEl.style.display = 'none';
    return;
  }

  // Parse the date portion of the timeslot value (e.g. "2026-02-15 10:00 AM")
  var datePart = timeslotValue.split(' ')[0];
  var startDate = new Date(datePart + 'T00:00:00');
  if (isNaN(startDate.getTime())) {
    estimateEl.style.display = 'none';
    return;
  }

  var weekStart = new Date(startDate);
  weekStart.setDate(weekStart.getDate() + (maxWeeks * 7));
  var weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  var opts = { month: 'long', day: 'numeric' };
  var startStr = weekStart.toLocaleDateString('en-US', opts);
  var endOpts = weekStart.getMonth() === weekEnd.getMonth() ? { day: 'numeric' } : opts;
  var endStr = weekEnd.toLocaleDateString('en-US', endOpts);
  var yearStr = weekEnd.getFullYear();

  textEl.textContent = 'Estimated ready the week of ' + startStr + '–' + endStr + ', ' + yearStr
    + ' (approximately ' + maxWeeks + ' week' + (maxWeeks !== 1 ? 's' : '')
    + ' from your appointment). This is an estimate — actual times may vary.';
  estimateEl.style.display = '';
}

// Google Form placeholder values — replace with your actual form URL and entry IDs
var GOOGLE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc-m7i0zWKTkT11nF1an6PXdR6JejpJNvDJOYPBkxz4wOYO9A/formResponse';
var GOOGLE_FORM_FIELDS = {
  name: 'entry.1466333029',
  email: 'entry.763864451',
  phone: 'entry.304343590',
  products: 'entry.1291378806',
  timeslot: 'entry.286083838'
};

// Beer Waitlist Google Form — replace with your actual form URL and entry ID
var BEER_WAITLIST_FORM_URL = 'https://docs.google.com/forms/d/e/YOUR_BEER_WAITLIST_FORM_ID/formResponse';
var BEER_WAITLIST_FIELDS = {
  email: 'entry.YOUR_EMAIL_ENTRY_ID'
};

function setupBeerWaitlistForm() {
  var form = document.getElementById('beer-waitlist-form');
  if (!form) return;

  form.addEventListener('submit', function(e) {
    e.preventDefault();

    var emailInput = document.getElementById('beer-waitlist-email');
    var email = emailInput.value.trim();
    if (!email) return;

    // Build hidden form for Google Form submission
    var hiddenForm = document.createElement('form');
    hiddenForm.method = 'POST';
    hiddenForm.action = BEER_WAITLIST_FORM_URL;
    hiddenForm.target = 'beer-waitlist-iframe';
    hiddenForm.style.display = 'none';

    var emailField = document.createElement('input');
    emailField.name = BEER_WAITLIST_FIELDS.email;
    emailField.value = email;
    hiddenForm.appendChild(emailField);

    document.body.appendChild(hiddenForm);
    hiddenForm.submit();
    document.body.removeChild(hiddenForm);

    // Show confirmation
    form.style.display = 'none';
    document.getElementById('beer-waitlist-confirm').style.display = '';
  });
}

function setupReservationForm() {
  var form = document.getElementById('reservation-form');
  if (!form) return;

  // Record page load time for bot detection
  var loadedAtField = document.getElementById('res-loaded-at');
  if (loadedAtField) loadedAtField.value = String(Date.now());

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Bot check: honeypot field should be empty
    var honeypot = document.getElementById('res-website');
    if (honeypot && honeypot.value) return;

    // Bot check: form submitted too fast (under 3 seconds)
    var loadedAt = parseInt(document.getElementById('res-loaded-at').value, 10) || 0;
    if (Date.now() - loadedAt < 3000) return;

    var items = getReservation();
    if (items.length === 0) {
      alert('Please add at least one product to your reservation.');
      return;
    }

    var selectedTimeslot = document.querySelector('input[name="timeslot"]:checked');
    if (!selectedTimeslot) {
      alert('Please select a timeslot.');
      return;
    }

    var name = document.getElementById('res-name').value.trim();
    var email = document.getElementById('res-email').value.trim();
    var phone = document.getElementById('res-phone').value.trim();

    var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      alert('Please enter a valid email address.');
      return;
    }

    var phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 10 || phoneDigits.length > 15) {
      alert('Please enter a valid phone number (at least 10 digits).');
      return;
    }

    var productNames = items.map(function (item) {
      var q = item.qty || 1;
      return item.name + (q > 1 ? ' x' + q : '');
    }).join(', ');
    var timeslot = selectedTimeslot.value;

    // Disable submit button and show processing state to prevent double-submissions
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute('data-original-text', submitBtn.textContent);
      submitBtn.textContent = 'Processing...';
      submitBtn.classList.add('btn-loading');
    }

    // Build hidden form for Google Form submission
    var hiddenForm = document.createElement('form');
    hiddenForm.method = 'POST';
    hiddenForm.action = GOOGLE_FORM_URL;
    hiddenForm.target = 'reservation-iframe';
    hiddenForm.style.display = 'none';

    var fields = [
      { name: GOOGLE_FORM_FIELDS.name, value: name },
      { name: GOOGLE_FORM_FIELDS.email, value: email },
      { name: GOOGLE_FORM_FIELDS.phone, value: phone },
      { name: GOOGLE_FORM_FIELDS.products, value: productNames },
      { name: GOOGLE_FORM_FIELDS.timeslot, value: timeslot }
    ];

    fields.forEach(function (f) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = f.name;
      input.value = f.value;
      hiddenForm.appendChild(input);
    });

    document.body.appendChild(hiddenForm);
    hiddenForm.submit();
    document.body.removeChild(hiddenForm);

    // Show confirmation
    localStorage.removeItem(RESERVATION_KEY);
    document.getElementById('reservation-list').style.display = 'none';
    document.getElementById('timeslot-picker').style.display = 'none';
    document.getElementById('reservation-form-section').style.display = 'none';
    document.getElementById('reservation-confirm').style.display = '';
  });
}
