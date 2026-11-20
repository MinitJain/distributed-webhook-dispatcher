import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDispatch, isPrivateHost } from '../src/validate.js';

const good = { destinationUrl: 'https://client.example.com/hook', eventId: 'evt_1', payload: { event: 'user.signup' } };

test('accepts a valid request', () => {
  assert.equal(validateDispatch(good).ok, true);
});

test('rejects a body that is not an object', () => {
  assert.equal(validateDispatch(['x']).ok, false);
  assert.equal(validateDispatch(null).ok, false);
});

test('rejects an empty or missing eventId', () => {
  assert.equal(validateDispatch({ ...good, eventId: '   ' }).ok, false);
  assert.equal(validateDispatch({ ...good, eventId: undefined }).ok, false);
});

test('rejects a payload that is an array', () => {
  assert.equal(validateDispatch({ ...good, payload: [1] }).ok, false);
});

test('rejects non-http schemes', () => {
  assert.equal(validateDispatch({ ...good, destinationUrl: 'ftp://x.com/a' }).ok, false);
});

test('blocks private addresses (SSRF guard) unless allowed', () => {
  const metadata = { ...good, destinationUrl: 'http://169.254.169.254/latest/meta-data/' };
  assert.equal(validateDispatch(metadata).ok, false);
  assert.equal(validateDispatch(metadata, { allowPrivate: true }).ok, true);
});

test('isPrivateHost: private ranges are blocked, look-alike names are not', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.9.9', '169.254.1.1', '[::1]'])
    assert.equal(isPrivateHost(h), true, h);
  for (const h of ['8.8.8.8', '172.32.0.1', '10.example.com', 'fdic.gov'])
    assert.equal(isPrivateHost(h), false, h);
});
