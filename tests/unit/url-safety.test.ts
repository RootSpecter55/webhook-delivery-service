import { assertSafeUrl, isBlockedAddress } from '../../src/common/url-safety';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.5.4',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '93.184.215.14',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  const resolve = async (host: string) =>
    ({ 'public.test': ['93.184.215.14'], 'mixed.test': ['93.184.215.14', '10.0.0.1'] })[host] ?? [];

  it('accepts a URL whose every address is public', async () => {
    await expect(
      assertSafeUrl('https://public.test/hook', { allowPrivate: false, resolve }),
    ).resolves.toBeUndefined();
  });

  it('rejects when any resolved address is private', async () => {
    await expect(
      assertSafeUrl('https://mixed.test/hook', { allowPrivate: false, resolve }),
    ).rejects.toMatchObject({
      status: 422,
      details: { addresses: ['10.0.0.1'] },
    });
  });

  it('rejects other schemes and embedded credentials even when private URLs are allowed', async () => {
    await expect(assertSafeUrl('file:///etc/passwd', { allowPrivate: true })).rejects.toThrow(
      'http or https',
    );
    await expect(assertSafeUrl('https://u:p@public.test/', { allowPrivate: true })).rejects.toThrow(
      'credentials',
    );
  });

  it('skips the address check only when private URLs are explicitly allowed', async () => {
    await expect(
      assertSafeUrl('http://127.0.0.1/', { allowPrivate: true }),
    ).resolves.toBeUndefined();
    await expect(assertSafeUrl('http://127.0.0.1/', { allowPrivate: false })).rejects.toMatchObject(
      { status: 422 },
    );
  });
});
