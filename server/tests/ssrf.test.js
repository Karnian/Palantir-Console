const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalizeUrl, maskSensitiveParams, _isBlockedIP, _isBlockedHostname, _inCidrV4 } = require('../services/ssrf');

// ─── canonicalizeUrl ───

test('canonicalizeUrl accepts https URL', () => {
  const { url, display, hostname } = canonicalizeUrl('https://example.com/path?x=1');
  assert.equal(url, 'https://example.com/path?x=1');
  assert.equal(display, 'https://example.com/path');
  assert.equal(hostname, 'example.com');
});

test('canonicalizeUrl rejects http', () => {
  assert.throws(() => canonicalizeUrl('http://example.com'), /https/);
});

test('canonicalizeUrl rejects file://, gopher://, data:', () => {
  for (const url of ['file:///etc/passwd', 'gopher://x', 'data:text/html,<h1>x</h1>']) {
    assert.throws(() => canonicalizeUrl(url));
  }
});

test('canonicalizeUrl rejects userinfo', () => {
  assert.throws(() => canonicalizeUrl('https://user:pass@example.com/'), /userinfo/);
  assert.throws(() => canonicalizeUrl('https://user@example.com/'), /userinfo/);
});

test('canonicalizeUrl strips trailing dot from hostname', () => {
  const { hostname, url } = canonicalizeUrl('https://example.com./path');
  assert.equal(hostname, 'example.com');
  assert.ok(!url.includes('example.com.'));
});

test('canonicalizeUrl elides default port 443', () => {
  const { url } = canonicalizeUrl('https://example.com:443/path');
  assert.equal(url, 'https://example.com/path');
});

test('canonicalizeUrl rejects non-443 ports', () => {
  assert.throws(() => canonicalizeUrl('https://example.com:8080/'), /port/);
  assert.throws(() => canonicalizeUrl('https://example.com:80/'), /port/);
});

test('canonicalizeUrl strips fragment', () => {
  const { url } = canonicalizeUrl('https://example.com/path#section');
  assert.ok(!url.includes('#'));
});

test('canonicalizeUrl preserves query string in full URL', () => {
  const { url, display } = canonicalizeUrl('https://example.com/p?token=secret');
  assert.ok(url.includes('token=secret'));
  assert.ok(!display.includes('token='));
});

test('canonicalizeUrl IDN hostname punycodes', () => {
  const { hostname } = canonicalizeUrl('https://münchen.de/');
  assert.equal(hostname, 'xn--mnchen-3ya.de');
});

test('canonicalizeUrl rejects garbage input', () => {
  assert.throws(() => canonicalizeUrl('not-a-url'));
  assert.throws(() => canonicalizeUrl('https://'));
});

test('canonicalizeUrl rejects empty input', () => {
  assert.throws(() => canonicalizeUrl(''));
  assert.throws(() => canonicalizeUrl(null));
});

// ─── Blocked IPv4 ───

test('blocks loopback 127.0.0.0/8', () => {
  assert.ok(_isBlockedIP('127.0.0.1', 4));
  assert.ok(_isBlockedIP('127.255.255.254', 4));
});

test('blocks RFC1918 ranges', () => {
  assert.ok(_isBlockedIP('10.0.0.1', 4));
  assert.ok(_isBlockedIP('172.16.0.1', 4));
  assert.ok(_isBlockedIP('172.31.255.254', 4));
  assert.ok(_isBlockedIP('192.168.1.1', 4));
});

test('blocks link-local incl. metadata 169.254.169.254', () => {
  assert.ok(_isBlockedIP('169.254.169.254', 4));
  assert.ok(_isBlockedIP('169.254.0.1', 4));
});

test('blocks CGNAT 100.64.0.0/10', () => {
  assert.ok(_isBlockedIP('100.64.0.1', 4));
  assert.ok(_isBlockedIP('100.127.255.254', 4));
});

test('blocks 0.0.0.0 and broadcast', () => {
  assert.ok(_isBlockedIP('0.0.0.0', 4));
  assert.ok(_isBlockedIP('255.255.255.255', 4));
});

test('allows public IPv4', () => {
  assert.ok(!_isBlockedIP('8.8.8.8', 4));
  assert.ok(!_isBlockedIP('1.1.1.1', 4));
  assert.ok(!_isBlockedIP('140.82.112.4', 4)); // GitHub
});

// ─── Blocked IPv6 ───

test('blocks IPv6 loopback and unspecified', () => {
  assert.ok(_isBlockedIP('::1', 6));
  assert.ok(_isBlockedIP('::', 6));
});

test('blocks IPv6 ULA fc00::/7', () => {
  assert.ok(_isBlockedIP('fc00::1', 6));
  assert.ok(_isBlockedIP('fd12:3456:789a::1', 6));
});

test('blocks IPv6 link-local fe80::/10', () => {
  assert.ok(_isBlockedIP('fe80::1', 6));
});

test('blocks IPv4-mapped IPv6 that wraps private', () => {
  assert.ok(_isBlockedIP('::ffff:127.0.0.1', 6));
  assert.ok(_isBlockedIP('::ffff:10.0.0.1', 6));
});

test('allows public IPv6', () => {
  assert.ok(!_isBlockedIP('2001:4860:4860::8888', 6));
});

// ─── Blocked hostnames ───

test('blocks localhost', () => {
  assert.ok(_isBlockedHostname('localhost'));
  assert.ok(_isBlockedHostname('LOCALHOST'));
});

test('blocks .local suffix (mDNS)', () => {
  assert.ok(_isBlockedHostname('foo.local'));
  assert.ok(_isBlockedHostname('bar.baz.local'));
});

test('blocks .internal suffix', () => {
  assert.ok(_isBlockedHostname('metadata.google.internal'));
  assert.ok(_isBlockedHostname('x.internal'));
});

test('blocks metadata hostname', () => {
  assert.ok(_isBlockedHostname('metadata'));
  assert.ok(_isBlockedHostname('metadata.google.internal'));
});

test('allows public hostnames', () => {
  assert.ok(!_isBlockedHostname('example.com'));
  assert.ok(!_isBlockedHostname('raw.githubusercontent.com'));
});

test('strips trailing dot in hostname check', () => {
  assert.ok(_isBlockedHostname('localhost.'));
});

// ─── CIDR helper ───

test('inCidrV4 basic', () => {
  assert.ok(_inCidrV4('10.1.2.3', '10.0.0.0/8'));
  assert.ok(!_inCidrV4('11.0.0.1', '10.0.0.0/8'));
  assert.ok(_inCidrV4('127.0.0.1', '127.0.0.0/8'));
  assert.ok(_inCidrV4('172.16.0.1', '172.16.0.0/12'));
  assert.ok(!_inCidrV4('172.32.0.1', '172.16.0.0/12'));
});

// ─── Sensitive param masking ───

test('maskSensitiveParams masks known sensitive names', () => {
  const masked = maskSensitiveParams('https://example.com/p?token=abc&x=1');
  assert.ok(masked.includes('token=***'));
  assert.ok(masked.includes('x=1'));
});

test('maskSensitiveParams masks api_key, secret, sig', () => {
  assert.ok(maskSensitiveParams('https://x.com?api_key=abc').includes('api_key=***'));
  assert.ok(maskSensitiveParams('https://x.com?secret=abc').includes('secret=***'));
  assert.ok(maskSensitiveParams('https://x.com?sig=abc').includes('sig=***'));
});

test('maskSensitiveParams leaves non-sensitive params alone', () => {
  // URL normalization adds trailing slash; just check masking didn't occur
  const result = maskSensitiveParams('https://example.com/?foo=bar');
  assert.equal(result, 'https://example.com/?foo=bar');
  // Ensure no '***' appears for non-sensitive params
  assert.ok(!result.includes('***'));
});
